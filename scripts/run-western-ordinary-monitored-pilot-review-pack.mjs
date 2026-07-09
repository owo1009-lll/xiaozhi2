import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { runWesternControlledSubmissionBatch } from "../src/server/westernStringsAlignmentService.js";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3", "ordinary-auto-pass-precision-review", "review-pack");
const DEFAULT_SELECTION = path.join("data", "experiments", "western-strings-m3", "ordinary-auto-pass-precision-review", "ordinary-auto-pass-precision-selection.json");
const DEFAULT_SUMMARY = path.join("data", "experiments", "western-strings-m3", "ordinary-auto-pass-precision-review", "ordinary-auto-pass-precision-review-summary.json");
const DEFAULT_KNOWN_LABELS = path.join("data", "experiments", "western-strings-m3", "confidence-recalibration", "combined-controlled-candidate-review-labels.csv");
const RELEASE_REL = path.join("models", "western-strings", "ordinary-upload-confidence-rf-v1", "release.json");

function parseArgs(argv) {
  const args = {
    batchLimit: 1,
    analysisLimit: 60,
    reviewLimit: 12,
    minConfidence: 0.95,
    minVoicedFrames: 2,
    requirePitchSupport: false,
    knownLabels: DEFAULT_KNOWN_LABELS,
    outDir: DEFAULT_OUT_DIR,
    selectionJson: DEFAULT_SELECTION,
    summary: DEFAULT_SUMMARY,
    keepTemp: false,
    excludeRecordingIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--batch-limit") args.batchLimit = Number(argv[++index] || args.batchLimit);
    else if (arg === "--analysis-limit") args.analysisLimit = Number(argv[++index] || args.analysisLimit);
    else if (arg === "--review-limit") args.reviewLimit = Number(argv[++index] || args.reviewLimit);
    else if (arg === "--min-confidence") args.minConfidence = Number(argv[++index] || args.minConfidence);
    else if (arg === "--min-voiced-frames") args.minVoicedFrames = Number(argv[++index] || args.minVoicedFrames);
    else if (arg === "--known-labels") args.knownLabels = argv[++index] || args.knownLabels;
    else if (arg === "--require-pitch-support") args.requirePitchSupport = true;
    else if (arg === "--allow-missing-pitch-support") args.requirePitchSupport = false;
    else if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
    else if (arg === "--selection-json") args.selectionJson = argv[++index] || args.selectionJson;
    else if (arg === "--summary") args.summary = argv[++index] || args.summary;
    else if (arg === "--exclude-recording-id") args.excludeRecordingIds.push(argv[++index] || "");
    else if (arg === "--keep-temp") args.keepTemp = true;
  }
  return args;
}

function rel(filePath, root = process.cwd()) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function safeString(value, fallback = "") {
  const text = value === null || value === undefined ? "" : String(value);
  return text || fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value || row.length) row.push(value);
  if (row.length) rows.push(row);
  const [headers = [], ...dataRows] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  return dataRows.map((dataRow) => Object.fromEntries(headers.map((header, index) => [header, dataRow[index] ?? ""])));
}

async function readCsvRows(filePath) {
  try {
    return parseCsv(await fs.readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeStatus(value) {
  const status = safeString(value).trim().toLowerCase();
  return ["usable", "wrong", "uncertain"].includes(status) ? status : "";
}

function labelKey(row = {}) {
  return [
    safeString(row.scoreId).trim(),
    safeString(row.recordingId).trim(),
    safeString(row.candidateId).trim(),
  ].join("::");
}

function hasLabelKeyParts(row = {}) {
  return Boolean(
    safeString(row.scoreId).trim()
    && safeString(row.recordingId).trim()
    && safeString(row.candidateId).trim()
  );
}

async function loadKnownLabelMap(labelsPath) {
  const rows = await readCsvRows(labelsPath);
  const labels = new Map();
  for (const row of rows) {
    const status = normalizeStatus(row.teacherCandidateStatus);
    if (!status) continue;
    if (!hasLabelKeyParts(row)) continue;
    const key = labelKey(row);
    labels.set(key, {
      status,
      reviewRowNumber: safeString(row.reviewRowNumber),
      source: rel(path.resolve(labelsPath)),
    });
  }
  return { rows, labels };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function copyIfExists(fromRel, toRoot) {
  const from = path.resolve(fromRel);
  const to = path.join(toRoot, fromRel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  return rel(to, toRoot);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function audioExtensionFromSubmission(submission = {}) {
  const fromName = path.extname(safeString(submission.audioSubmission?.name)).toLowerCase();
  if (fromName) return fromName;
  const fromPath = path.extname(safeString(submission.audioPath)).toLowerCase();
  return fromPath || ".m4a";
}

async function copySubmissionAudioToTemp(tempRoot, submission = {}) {
  const hash = safeString(submission.audioHash).trim();
  const ext = audioExtensionFromSubmission(submission);
  const candidates = [];
  const audioPath = safeString(submission.audioPath).trim();
  if (audioPath) candidates.push(path.resolve(audioPath));
  if (hash) {
    candidates.push(path.resolve("data", "analysis-audio-cache", `${hash}${ext}`));
    for (const fallbackExt of [".m4a", ".mp3", ".wav", ".aac", ".flac"]) {
      candidates.push(path.resolve("data", "analysis-audio-cache", `${hash}${fallbackExt}`));
    }
  }
  let source = "";
  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) {
      source = candidate;
      break;
    }
  }
  if (!source) return { ...submission };
  const safeSubmissionId = safeString(submission.submissionId, "unknown-submission").replace(/[^A-Za-z0-9_.-]/g, "_");
  const target = path.join(tempRoot, "data", "analysis-audio-cache", `${safeSubmissionId}${path.extname(source) || ext}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
  return {
    ...submission,
    audioPath: target,
  };
}

function excludedRecordingIdsFromRelease(release) {
  const ids = new Set();
  for (const section of [release?.blindValidation, release?.thresholdPoolValidation]) {
    for (const item of Array.isArray(section?.excludedKnownBadSources) ? section.excludedKnownBadSources : []) {
      const id = safeString(item.recordingId).trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function selectAcceptedSubmissions({
  batchLimit,
  analysisLimit,
  excludeRecordingIds: requestedExcludedRecordingIds = [],
}) {
  const submissionsPath = path.join(process.cwd(), "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl");
  const reviewsPath = path.join(process.cwd(), "data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl");
  const release = await readJson(path.resolve(RELEASE_REL));
  const excludedRecordingIds = excludedRecordingIdsFromRelease(release);
  for (const recordingId of requestedExcludedRecordingIds) {
    const normalized = safeString(recordingId).trim();
    if (normalized) excludedRecordingIds.add(normalized);
  }
  const submissions = await readJsonl(submissionsPath);
  const acceptedReviews = await readJsonl(reviewsPath);
  const acceptedIds = new Set(
    acceptedReviews
      .filter((review) => safeString(review.action).trim() === "accepted_for_batch")
      .map((review) => safeString(review.submissionId).trim())
      .filter(Boolean),
  );
  const accepted = submissions
    .filter((submission) => acceptedIds.has(safeString(submission.submissionId).trim()))
    .filter((submission) => !excludedRecordingIds.has(safeString(submission.recordingId).trim()));
  const limit = Number.isFinite(batchLimit) && batchLimit > 0 ? Math.floor(batchLimit) : accepted.length;
  return {
    release,
    excludedRecordingIds: [...excludedRecordingIds],
    selected: accepted.slice(0, limit).map((submission) => ({
      ...submission,
      limit: Number.isFinite(analysisLimit) && analysisLimit > 0 ? Math.floor(analysisLimit) : submission.limit,
    })),
  };
}

async function setupTempRepo(tempRoot, selectedSubmissions) {
  for (const file of [
    path.join("data", "erhu-score-imports.json"),
    path.join("data", "erhu-score-imports.sqlite"),
    path.join("data", "experiments", "western-strings-m2", "m2d-sequence-support-summary.json"),
    path.join("data", "experiments", "western-strings-m2", "m2f-real-student-recording-summary.json"),
    path.join("data", "experiments", "western-strings-m3", "m3-diagnosis-summary.json"),
    path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
    path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-confidence-pilot.json"),
    path.join("data", "experiments", "western-strings-m3", "confidence-recalibration", "combined-controlled-candidate-review-labels.csv"),
    path.join("data", "experiments", "western-strings-m3", "confidence-validation-review", "confidence-validation-eval.json"),
    path.join("data", "experiments", "western-strings-m3", "confidence-recalibration-context-validation-review", "confidence-recalibration-context-validation-eval.json"),
    RELEASE_REL,
  ]) {
    await copyIfExists(file, tempRoot);
  }
  const m3Root = path.join(tempRoot, "data", "experiments", "western-strings-m3");
  const tempSubmissions = [];
  for (const submission of selectedSubmissions) {
    tempSubmissions.push(await copySubmissionAudioToTemp(tempRoot, submission));
  }
  await writeJsonl(path.join(m3Root, "controlled-submissions.jsonl"), tempSubmissions);
  await writeJsonl(
    path.join(m3Root, "controlled-submission-reviews.jsonl"),
    tempSubmissions.map((submission) => ({
      submittedAt: new Date().toISOString(),
      submissionId: submission.submissionId,
      action: "accepted_for_batch",
      reason: "ordinary auto-pass precision review-pack generation",
      reviewerId: "system-pilot",
      comments: "Temporary auto-pass precision audit; not a default runtime enable.",
    })),
  );
  return path.join(tempRoot, RELEASE_REL);
}

function isAutoPassCandidate(candidate) {
  return candidate?.autoDecision === "auto_pass"
    || candidate?.gateDecision === "auto_pass"
    || candidate?.studentFacing === true;
}

function selfCheckAutoPassCandidate(candidate, {
  minConfidence = 0.95,
  minVoicedFrames = 2,
  requirePitchSupport = true,
} = {}) {
  const reasons = [];
  const confidence = finiteNumber(candidate?.confidenceProbability);
  const predictedSeconds = finiteNumber(candidate?.predictedOnsetSeconds);
  const voicedFrameCount = finiteNumber(candidate?.voicedFrameCount) ?? 0;
  const pitchSupported = candidate?.pitchSupportWithin80Cents === true;
  if (!isAutoPassCandidate(candidate)) reasons.push("not-auto-pass");
  if (confidence === null) reasons.push("confidence-missing");
  else if (confidence < minConfidence) reasons.push("confidence-below-self-check-threshold");
  if (predictedSeconds === null || predictedSeconds < 0) reasons.push("predicted-onset-missing");
  if (requirePitchSupport && !pitchSupported) {
    reasons.push("pitch-support-missing");
  }
  if (!pitchSupported && voicedFrameCount < minVoicedFrames) {
    reasons.push("voicing-evidence-too-weak");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    confidence,
    predictedSeconds,
    voicedFrameCount,
    pitchSupported,
  };
}

async function materializeCandidateArtifact({
  tempRoot,
  realRepoRoot,
  batchRunId,
  submissionId,
  tempCandidateRowsPath,
}) {
  const tempArtifactPath = path.resolve(tempRoot, tempCandidateRowsPath);
  const artifact = await readJson(tempArtifactPath);
  const safeSubmissionId = safeString(submissionId, "unknown-submission").replace(/[^A-Za-z0-9_.-]/g, "_");
  const outPath = path.join(
    realRepoRoot,
    "data",
    "experiments",
    "western-strings-m3",
    "ordinary-auto-pass-precision-review",
    "candidate-rows",
    safeString(batchRunId, "unknown-batch"),
    `${safeSubmissionId}.json`,
  );
  await writeJson(outPath, artifact);
  return {
    artifact,
    stableCandidateRowsPath: rel(outPath, realRepoRoot),
  };
}

function reviewRowFromCandidate({
  rowNumber,
  run,
  item,
  candidate,
  candidateRowsPath,
}) {
  return {
    reviewRowNumber: rowNumber,
    batchRunId: safeString(run.batchRunId),
    submissionId: safeString(item.submissionId),
    scoreId: safeString(item.scoreId),
    piece: safeString(item.piece),
    recordingId: safeString(item.recordingId),
    audioName: safeString(item.audioSubmission?.name),
    audioHash: safeString(item.audioHash),
    candidateRowsPath,
    candidateId: safeString(candidate.candidateId),
    noteId: safeString(candidate.noteId),
    noteIndex: candidate.noteIndex ?? "",
    sectionId: safeString(candidate.sectionId),
    sectionTitle: safeString(candidate.sectionTitle),
    measureIndex: candidate.measureIndex ?? "",
    pageNumber: candidate.pageNumber ?? "",
    midi: candidate.midi ?? "",
    predictedOnsetSeconds: candidate.predictedOnsetSeconds ?? "",
    method: safeString(candidate.method),
    analysisMode: safeString(candidate.analysisMode),
    voicedFrameCount: candidate.voicedFrameCount ?? "",
    medianObservedMidi: candidate.medianObservedMidi ?? "",
    centsError: candidate.centsError ?? "",
    pitchSupportWithin80Cents: candidate.pitchSupportWithin80Cents === true ? "yes" : "no",
    gateDecision: safeString(candidate.gateDecision || candidate.autoDecision),
    gateReason: safeString(candidate.gateReason),
    gateVersion: safeString(candidate.gateVersion),
    studentFacing: candidate.studentFacing === true ? "yes" : "no",
    confidenceProbability: candidate.confidenceProbability ?? "",
    confidenceModelName: safeString(candidate.confidenceModelName),
    confidenceThreshold: candidate.confidenceThreshold ?? item.candidateGate?.threshold ?? "",
    confidenceFeatureSet: safeString(candidate.confidenceFeatureSet),
    confidenceGroupBy: safeString(candidate.confidenceGroupBy),
    confidenceStratum: safeString(candidate.confidenceStratum),
    teacherCandidateStatus: "",
    teacherCorrectOnsetSeconds: "",
    teacherCorrectMeasureIndex: "",
    teacherComments: "",
  };
}

async function buildSelectionFromRun({ tempRoot, realRepoRoot, run, selfCheck = {}, knownLabels = new Map() }) {
  const rows = [];
  let totalCandidateCount = 0;
  let autoPassCandidateCount = 0;
  let selfCheckedAutoPassCandidateCount = 0;
  let knownUsableAutoPassCandidateCount = 0;
  let knownWrongAutoPassCandidateCount = 0;
  let knownUncertainAutoPassCandidateCount = 0;
  const selfCheckRejectedReasonCounts = {};
  const knownUsableRows = [];
  const knownWrongRows = [];
  for (const item of Array.isArray(run.items) ? run.items : []) {
    if (!item.candidateRowsPath) continue;
    const { artifact, stableCandidateRowsPath } = await materializeCandidateArtifact({
      tempRoot,
      realRepoRoot,
      batchRunId: run.batchRunId,
      submissionId: item.submissionId,
      tempCandidateRowsPath: item.candidateRowsPath,
    });
    for (const candidate of Array.isArray(artifact.candidateRows) ? artifact.candidateRows : []) {
      totalCandidateCount += 1;
      if (!isAutoPassCandidate(candidate)) continue;
      autoPassCandidateCount += 1;
      const check = selfCheckAutoPassCandidate(candidate, selfCheck);
      if (!check.ok) {
        for (const reason of check.reasons) {
          selfCheckRejectedReasonCounts[reason] = (selfCheckRejectedReasonCounts[reason] || 0) + 1;
        }
        continue;
      }
      selfCheckedAutoPassCandidateCount += 1;
      const reviewRow = reviewRowFromCandidate({
        rowNumber: rows.length + 1,
        run,
        item,
        candidate,
        candidateRowsPath: stableCandidateRowsPath,
      });
      const known = knownLabels.get(labelKey(reviewRow));
      if (known?.status === "usable") {
        knownUsableAutoPassCandidateCount += 1;
        knownUsableRows.push({
          ...reviewRow,
          knownLabelStatus: known.status,
          knownLabelReviewRowNumber: known.reviewRowNumber,
        });
        continue;
      }
      if (known?.status === "wrong") {
        knownWrongAutoPassCandidateCount += 1;
        knownWrongRows.push({
          ...reviewRow,
          knownLabelStatus: known.status,
          knownLabelReviewRowNumber: known.reviewRowNumber,
        });
        continue;
      }
      if (known?.status === "uncertain") {
        knownUncertainAutoPassCandidateCount += 1;
      }
      rows.push(reviewRow);
    }
  }
  return {
    rows,
    totalCandidateCount,
    autoPassCandidateCount,
    selfCheckedAutoPassCandidateCount,
    knownUsableAutoPassCandidateCount,
    knownWrongAutoPassCandidateCount,
    knownUncertainAutoPassCandidateCount,
    knownUsableRows,
    knownWrongRows,
    selfCheckRejectedReasonCounts,
  };
}

async function exportReviewPack({ selectionJson, outDir, reviewLimit }) {
  const args = [
    path.join(process.cwd(), "scripts", "export-western-controlled-candidate-review.mjs"),
    "--selection-json",
    selectionJson,
    "--out-dir",
    outDir,
    "--limit",
    String(Math.max(0, Math.floor(reviewLimit))),
  ];
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = parseLastJsonObject(stdout);
  return { stdout, stderr, parsed };
}

function parseLastJsonObject(stdout = "") {
  const text = safeString(stdout).trim();
  if (!text) return null;
  for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Keep scanning for the start of the final JSON object.
    }
  }
  return null;
}

function renderMarkdown(summary) {
  return [
    "# Ordinary Upload Auto-Pass Precision Review Pack",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Result",
    "",
    `- ok: ${summary.ok}`,
    `- selectedSubmissionCount: ${summary.selectedSubmissionCount}`,
    `- excludedRecordingIds: ${summary.excludedRecordingIds.join(", ") || "none"}`,
    `- totalCandidateCount: ${summary.totalCandidateCount}`,
    `- autoPassCandidateCount: ${summary.autoPassCandidateCount}`,
    `- selfCheckedAutoPassCandidateCount: ${summary.selfCheckedAutoPassCandidateCount}`,
    `- knownUsableAutoPassCandidateCount: ${summary.knownUsableAutoPassCandidateCount ?? 0}`,
    `- knownWrongAutoPassCandidateCount: ${summary.knownWrongAutoPassCandidateCount ?? 0}`,
    `- unknownReviewCandidateCount: ${summary.unknownReviewCandidateCount ?? summary.reviewPack?.rowCount ?? 0}`,
    `- reviewPackRows: ${summary.reviewPack?.rowCount ?? 0}`,
    `- defaultOrdinaryReadyAfter: ${summary.defaultOrdinaryReadyAfter}`,
    "",
    "## Artifacts",
    "",
    `- selectionJson: ${summary.selectionJson}`,
    `- reviewPackHtml: ${summary.reviewPack?.htmlPath || ""}`,
    `- reviewPackCsv: ${summary.reviewPack?.csvPath || ""}`,
    `- reviewGuide: ${summary.reviewPack?.guidePath || ""}`,
    "",
    "## Safety Rules",
    "",
    "- This command is an internal precision audit, not a product pilot.",
    "- It runs the frozen RF scorer only inside this explicit review-pack command.",
    "- It reuses existing teacher labels before asking for another review.",
    "- Known usable auto_pass rows are counted as self-checked evidence and are not exported again.",
    "- Known wrong auto_pass rows block the release check.",
    "- It only exports unknown auto_pass rows that pass stricter self-check thresholds.",
    "- It restores the process environment after the run.",
    "- It does not make ordinary-upload auto feedback ready by default.",
    "- Review every generated unknown auto_pass row before treating it as student-safe.",
    "",
    "## Blocking Reasons",
    "",
    ...(summary.blockingReasons.length ? summary.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
  ].join("\n");
}

export async function runOrdinaryMonitoredPilotReviewPack(args = {}) {
  args = {
    batchLimit: 1,
    analysisLimit: 60,
    reviewLimit: 12,
    minConfidence: 0.95,
    minVoicedFrames: 2,
    requirePitchSupport: false,
    knownLabels: DEFAULT_KNOWN_LABELS,
    outDir: DEFAULT_OUT_DIR,
    selectionJson: DEFAULT_SELECTION,
    summary: DEFAULT_SUMMARY,
    keepTemp: false,
    excludeRecordingIds: [],
    ...args,
  };
  args.excludeRecordingIds = [...new Set(
    (Array.isArray(args.excludeRecordingIds) ? args.excludeRecordingIds : [])
      .map((recordingId) => safeString(recordingId).trim())
      .filter(Boolean),
  )];
  const realRepoRoot = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-ordinary-real-pilot-"));
  const statusBefore = await buildProjectStatus();
  const oldEnable = process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE;
  const oldRelease = process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE;
  let tempRootDeleted = false;
  let summary;
  try {
    const { release, excludedRecordingIds, selected } = await selectAcceptedSubmissions({
      batchLimit: args.batchLimit,
      analysisLimit: args.analysisLimit,
      excludeRecordingIds: args.excludeRecordingIds,
    });
    if (!selected.length) {
      throw new Error("No accepted controlled submissions are available after excluding known bad recording IDs.");
    }
    const knownLabelSet = await loadKnownLabelMap(args.knownLabels || DEFAULT_KNOWN_LABELS);
    const tempReleasePath = await setupTempRepo(tempRoot, selected);
    process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE = "1";
    process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE = tempReleasePath;
    const batchResult = await runWesternControlledSubmissionBatch({ repoRoot: tempRoot, limit: selected.length });
    const selfCheck = {
      minConfidence: args.minConfidence,
      minVoicedFrames: args.minVoicedFrames,
      requirePitchSupport: args.requirePitchSupport,
    };
    const selection = await buildSelectionFromRun({
      tempRoot,
      realRepoRoot,
      run: batchResult.batch,
      selfCheck,
      knownLabels: knownLabelSet.labels,
    });
    const selectionPath = path.resolve(realRepoRoot, args.selectionJson || DEFAULT_SELECTION);
    const outDir = path.resolve(realRepoRoot, args.outDir || DEFAULT_OUT_DIR);
    await fs.rm(outDir, { recursive: true, force: true });
    const selectionPayload = {
      generatedAt: new Date().toISOString(),
      source: "ordinary-auto-pass-precision-review-real-controlled-submissions",
      modelName: release.modelName,
      modelVersion: release.modelVersion,
      threshold: release.threshold,
      selectedAboveThresholdCount: selection.autoPassCandidateCount,
      selfCheckedAutoPassCandidateCount: selection.selfCheckedAutoPassCandidateCount,
      knownLabels: rel(path.resolve(args.knownLabels || DEFAULT_KNOWN_LABELS), realRepoRoot),
      knownLabelRows: knownLabelSet.rows.length,
      knownUsableAutoPassCandidateCount: selection.knownUsableAutoPassCandidateCount,
      knownWrongAutoPassCandidateCount: selection.knownWrongAutoPassCandidateCount,
      knownUncertainAutoPassCandidateCount: selection.knownUncertainAutoPassCandidateCount,
      selfCheck,
      selfCheckRejectedReasonCounts: selection.selfCheckRejectedReasonCounts,
      candidateCount: selection.totalCandidateCount,
      selectedSubmissionCount: selected.length,
      excludedRecordingIds,
      requestedExcludedRecordingIds: args.excludeRecordingIds,
      knownUsableRows: selection.knownUsableRows,
      knownWrongRows: selection.knownWrongRows,
      rows: selection.rows,
    };
    await writeJson(selectionPath, selectionPayload);
    let reviewPack = null;
    if (selection.rows.length > 0) {
      const exported = await exportReviewPack({
        selectionJson: rel(selectionPath, realRepoRoot),
        outDir: rel(outDir, realRepoRoot),
        reviewLimit: args.reviewLimit,
      });
      reviewPack = exported.parsed;
    }
    summary = {
      ok: true,
      generatedAt: new Date().toISOString(),
      selectedSubmissionCount: selected.length,
      selectedSubmissions: selected.map((submission) => ({
        submissionId: submission.submissionId,
        piece: submission.piece,
        recordingId: submission.recordingId,
        scoreId: submission.scoreId,
        analysisLimit: submission.limit,
      })),
      excludedRecordingIds,
      requestedExcludedRecordingIds: args.excludeRecordingIds,
      tempRunOnly: true,
      tempRoot: args.keepTemp ? tempRoot : "",
      tempRootDeleted: false,
      defaultOrdinaryReadyBefore: statusBefore.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === true,
      defaultOrdinaryReadyAfter: null,
      batch: {
        status: batchResult.batch.status,
        reason: batchResult.batch.reason,
        itemCount: batchResult.batch.itemCount,
      },
      totalCandidateCount: selection.totalCandidateCount,
      autoPassCandidateCount: selection.autoPassCandidateCount,
      selfCheckedAutoPassCandidateCount: selection.selfCheckedAutoPassCandidateCount,
      knownUsableAutoPassCandidateCount: selection.knownUsableAutoPassCandidateCount,
      knownWrongAutoPassCandidateCount: selection.knownWrongAutoPassCandidateCount,
      knownUncertainAutoPassCandidateCount: selection.knownUncertainAutoPassCandidateCount,
      unknownReviewCandidateCount: selection.rows.length,
      selfCheck,
      selfCheckRejectedReasonCounts: selection.selfCheckRejectedReasonCounts,
      selectionJson: rel(selectionPath, realRepoRoot),
      reviewPack,
      blockingReasons: [],
    };
    if (selection.autoPassCandidateCount === 0) summary.blockingReasons.push("ordinary-precision-no-auto-pass-candidates");
    if (selection.selfCheckedAutoPassCandidateCount === 0) summary.blockingReasons.push("ordinary-precision-no-self-checked-auto-pass-candidates");
    if (selection.knownWrongAutoPassCandidateCount > 0) summary.blockingReasons.push("ordinary-precision-known-wrong-auto-pass-candidates");
    if (selection.rows.length > 0 && (!reviewPack || reviewPack.ok !== true)) {
      summary.blockingReasons.push("ordinary-precision-review-pack-not-generated");
    }
  } finally {
    if (oldEnable === undefined) delete process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE;
    else process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE = oldEnable;
    if (oldRelease === undefined) delete process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE;
    else process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE = oldRelease;
    if (!args.keepTemp) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRootDeleted = true;
    }
  }
  const statusAfter = await buildProjectStatus();
  summary.defaultOrdinaryReadyAfter = statusAfter.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === true;
  summary.tempRootDeleted = tempRootDeleted;
  if (summary.defaultOrdinaryReadyBefore !== false) summary.blockingReasons.push("default-ordinary-runtime-ready-before-pilot");
  if (summary.defaultOrdinaryReadyAfter !== false) summary.blockingReasons.push("default-ordinary-runtime-ready-after-pilot");
  summary.ok = summary.blockingReasons.length === 0;
  const summaryPath = path.resolve(realRepoRoot, args.summary || DEFAULT_SUMMARY);
  await writeJson(summaryPath, summary);
  const mdPath = summaryPath.replace(/\.json$/i, ".md");
  await fs.writeFile(mdPath, renderMarkdown(summary), "utf8");
  return { summary, summaryPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { summary, summaryPath, mdPath } = await runOrdinaryMonitoredPilotReviewPack(args);
  console.log(JSON.stringify({
    ok: summary.ok,
    blockingReasons: summary.blockingReasons,
    defaultOrdinaryReadyAfter: summary.defaultOrdinaryReadyAfter,
    selectedSubmissionCount: summary.selectedSubmissionCount,
    totalCandidateCount: summary.totalCandidateCount,
    autoPassCandidateCount: summary.autoPassCandidateCount,
    selfCheckedAutoPassCandidateCount: summary.selfCheckedAutoPassCandidateCount,
    reviewPackRows: summary.reviewPack?.rowCount ?? 0,
    out: {
      summary: rel(summaryPath),
      markdown: rel(mdPath),
      selectionJson: summary.selectionJson,
      reviewPackHtml: summary.reviewPack?.htmlPath || "",
      reviewPackCsv: summary.reviewPack?.csvPath || "",
    },
  }, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
