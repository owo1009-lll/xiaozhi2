import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { clamp, createId, nowIso, safeBoolean, safeNumber, safeString } from "./baseUtils.js";

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OFFLINE_FEATURE_STUDENT_GATE_VERSION = "western-offline-feature-gate-v0-review-only";

export const WESTERN_ALIGNMENT_METHOD_PREFERENCE = [
  "parangonar-basic-pitch",
  "basic-pitch-dtw",
  "crepe-dtw",
  "pyin-dtw",
  "linear-scoretime",
];

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
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  return dataRows.map((dataRow) => Object.fromEntries(headers.map((header, index) => [header, dataRow[index] ?? ""])));
}

function methodRank(method) {
  const index = WESTERN_ALIGNMENT_METHOD_PREFERENCE.indexOf(method);
  return index >= 0 ? index : WESTERN_ALIGNMENT_METHOD_PREFERENCE.length;
}

function noteKey(row) {
  return [row.dataset, row.piece, row.noteIndex].map((item) => safeString(item)).join("\u0000");
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = noteKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function chooseCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const leftDistance = numberOrNull(left.candidateToMedianAbsSeconds) ?? 999;
    const rightDistance = numberOrNull(right.candidateToMedianAbsSeconds) ?? 999;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return methodRank(left.method) - methodRank(right.method);
  })[0];
}

function buildCandidateSource(row) {
  return {
    method: safeString(row.method),
    predTime: numberOrNull(row.predTime),
    candidateToMedianAbsSeconds: numberOrNull(row.candidateToMedianAbsSeconds),
  };
}

function confidenceScore(row) {
  const methodCount = Math.max(1, Math.round(safeNumber(row.methodCount, 1)));
  const agreement300 = clamp(Math.round(safeNumber(row.agreementWithin300ms, 0)) / methodCount, 0, 1);
  const distance = Math.max(0, safeNumber(row.candidateToMedianAbsSeconds, 1));
  const distanceScore = clamp(1 - distance / 0.3, 0, 1);
  return Number(((agreement300 * 0.7) + (distanceScore * 0.3)).toFixed(4));
}

function buildDecision(candidates, { includeLabels = false } = {}) {
  const selected = chooseCandidate(candidates);
  const decision = {
    noteId: `${safeString(selected.dataset)}:${safeString(selected.piece)}:${safeString(selected.noteIndex)}`,
    dataset: safeString(selected.dataset),
    piece: safeString(selected.piece),
    noteIndex: Math.round(safeNumber(selected.noteIndex, 0)),
    midi: Math.round(safeNumber(selected.midi, 0)),
    scoreTime: numberOrNull(selected.scoreTime),
    predictedOnsetSeconds: numberOrNull(selected.predTime),
    autoDecision: "auto_pass",
    confidenceScore: confidenceScore(selected),
    confidenceModelVersion: "western-m2-median-consensus-v1",
    reviewRequiredReason: "",
    candidateSources: candidates
      .map(buildCandidateSource)
      .sort((left, right) => methodRank(left.method) - methodRank(right.method)),
    evidence: {
      selectedMethod: safeString(selected.method),
      methodCount: Math.round(safeNumber(selected.methodCount, candidates.length)),
      validPredictionCount: Math.round(safeNumber(selected.validPredictionCount, candidates.length)),
      predictionSpanSeconds: numberOrNull(selected.predictionSpanSeconds),
      agreementWithin100ms: Math.round(safeNumber(selected.agreementWithin100ms, 0)),
      agreementWithin300ms: Math.round(safeNumber(selected.agreementWithin300ms, 0)),
      doubleStop: safeString(selected.doubleStop) === "1",
      legato: safeString(selected.legato, "unknown"),
    },
  };
  if (includeLabels) {
    decision.evaluation = {
      labelCandidateAbsError: numberOrNull(selected.labelCandidateAbsError),
      labelCandidateWithin100ms: safeString(selected.labelCandidateWithin100ms) === "1",
      labelCandidateWithin150ms: safeString(selected.labelCandidateWithin150ms) === "1",
      labelCandidateWithin300ms: safeString(selected.labelCandidateWithin300ms) === "1",
    };
  }
  return decision;
}

function basicPitchCachePath(repoRoot, dataset, piece) {
  if (dataset === "m0a-bach10") {
    return path.join(repoRoot, "data", "experiments", "western-strings-m0", "m0a-bach10", "cache", "basic-pitch", `${piece}-violin.basic-pitch.json`);
  }
  if (dataset === "m0b-urmp") {
    const track = safeString(piece).split(":").at(-1);
    const filename = {
      vn: "AuSep_1_vn_01_Jupiter.basic-pitch.json",
      vc: "AuSep_2_vc_01_Jupiter.basic-pitch.json",
    }[track];
    return filename ? path.join(repoRoot, "data", "experiments", "western-strings-m0", "m0b-urmp", "cache", "basic-pitch", filename) : "";
  }
  if (dataset === "m0c-musicnet") {
    const sampleId = safeString(piece).split(":")[0].replace("MusicNet-", "");
    return path.join(repoRoot, "data", "experiments", "western-strings-m0", "m0c-musicnet", "cache", "basic-pitch", `${sampleId}.basic-pitch.json`);
  }
  return "";
}

async function readBasicPitchEvents(repoRoot, cache, dataset, piece) {
  const key = `${dataset}\u0000${piece}`;
  if (!cache.has(key)) {
    const cacheFile = basicPitchCachePath(repoRoot, dataset, piece);
    if (!cacheFile) {
      cache.set(key, []);
    } else {
      try {
        cache.set(key, JSON.parse(await fs.readFile(cacheFile, "utf8")));
      } catch {
        cache.set(key, []);
      }
    }
  }
  return cache.get(key);
}

function nearestBasicPitchSupportSeconds(events, decision, threshold, pitchTolerance) {
  const predicted = numberOrNull(decision.predictedOnsetSeconds);
  const midi = numberOrNull(decision.midi);
  if (predicted === null || midi === null) return null;
  const targetMidi = Math.round(midi);
  let best = null;
  for (const event of events) {
    const eventStart = numberOrNull(event?.start);
    const eventMidi = numberOrNull(event?.midi);
    if (eventStart === null || eventMidi === null) continue;
    if (Math.abs(Math.round(eventMidi) - targetMidi) > pitchTolerance) continue;
    const distance = Math.abs(eventStart - predicted);
    if (best === null || distance < best) best = distance;
    if (best <= threshold) return best;
  }
  return best;
}

async function hasSequenceBasicPitchSupport(repoRoot, eventCache, pieceDecisions, index, supportFeature) {
  const threshold = Math.max(0, safeNumber(supportFeature?.thresholdSeconds, 0.03));
  const pitchTolerance = Math.max(0, Math.round(safeNumber(supportFeature?.pitchToleranceSemitones, 0)));
  const radius = Math.max(0, Math.round(safeNumber(supportFeature?.neighborRadius, 2)));
  const start = Math.max(0, index - radius);
  const stop = Math.min(pieceDecisions.length, index + radius + 1);
  for (const decision of pieceDecisions.slice(start, stop)) {
    const events = await readBasicPitchEvents(repoRoot, eventCache, decision.dataset, decision.piece);
    const support = nearestBasicPitchSupportSeconds(events, decision, threshold, pitchTolerance);
    if (support === null || support > threshold) return false;
  }
  return true;
}

function summarize(decisions, { includeLabels = false } = {}) {
  const autoPassCount = decisions.filter((item) => item.autoDecision === "auto_pass").length;
  const summary = {
    noteCount: decisions.length,
    autoPassCount,
    reviewRequiredCount: decisions.length - autoPassCount,
    coverage: decisions.length ? Number((autoPassCount / decisions.length).toFixed(4)) : 0,
    confidenceModelVersion: "western-m2-median-consensus-v1",
  };
  if (includeLabels) {
    const evaluated = decisions.filter((item) => item.evaluation);
    const correct = evaluated.filter((item) => item.evaluation.labelCandidateWithin300ms).length;
    const autoPassEvaluated = evaluated.filter((item) => item.autoDecision === "auto_pass");
    const autoPassCorrect = autoPassEvaluated.filter((item) => item.evaluation.labelCandidateWithin300ms).length;
    summary.evaluation = {
      evaluatedCount: evaluated.length,
      correctWithin300ms: correct,
      precisionWithin300ms: evaluated.length ? Number((correct / evaluated.length).toFixed(4)) : 0,
      autoPassEvaluatedCount: autoPassEvaluated.length,
      autoPassCorrectWithin300ms: autoPassCorrect,
      autoPassPrecisionWithin300ms: autoPassEvaluated.length ? Number((autoPassCorrect / autoPassEvaluated.length).toFixed(4)) : 0,
    };
  }
  return summary;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonlRecords(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function controlledSubmissionsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl");
}

function controlledSubmissionReviewsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl");
}

function controlledSubmissionBatchRunsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl");
}

function controlledSubmissionCandidateRowsDir(repoRoot, batchRunId) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "offline-feature-candidates", safeString(batchRunId, "unknown-batch"));
}

async function writeControlledSubmissionCandidateRows(repoRoot, { batchRunId, submissionId, candidateRows }) {
  const safeSubmissionId = safeString(submissionId, "unknown-submission").replace(/[^A-Za-z0-9_.-]/g, "_");
  const outPath = path.join(controlledSubmissionCandidateRowsDir(repoRoot, batchRunId), `${safeSubmissionId}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify({
    batchRunId: safeString(batchRunId),
    submissionId: safeString(submissionId),
    rowCount: Array.isArray(candidateRows) ? candidateRows.length : 0,
    candidateRows: Array.isArray(candidateRows) ? candidateRows : [],
  }, null, 2)}\n`, "utf8");
  return path.relative(repoRoot, outPath).replace(/\\/g, "/");
}

async function readStudentGate(repoRoot) {
  const summaryPath = path.join(repoRoot, "data", "experiments", "western-strings-m2", "m2d-sequence-support-summary.json");
  try {
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    const ready = summary?.studentGateReady === true;
    return {
      ready,
      reason: ready ? "" : "student-gate-not-ready",
      source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
      strategy: "sequence-basic-pitch-support",
      supportFeature: summary?.supportFeature || {},
    };
  } catch {
    return {
      ready: false,
      reason: "student-gate-evidence-missing",
      source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
    };
  }
}

async function readRealStudentGate(repoRoot) {
  const summaryPath = path.join(repoRoot, "data", "experiments", "western-strings-m2", "m2f-real-student-recording-summary.json");
  const summary = await readJsonOrNull(summaryPath);
  const ready = summary?.studentGateReady === true && summary?.ok === true;
  return {
    ready,
    reason: ready ? "" : "real-student-gate-not-ready",
    source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
    summary: summary ? {
      autoPassCount: numberOrNull(summary?.results?.autoPassCount),
      correctWithin300ms: numberOrNull(summary?.results?.correctWithin300ms),
      unsafeTargetAutoPassCount: numberOrNull(summary?.results?.unsafeTargetAutoPassCount),
      precisionWithin300ms: numberOrNull(summary?.results?.precisionWithin300ms),
      recordings: numberOrNull(summary?.manifest?.recordings),
      students: numberOrNull(summary?.manifest?.students),
    } : null,
  };
}

async function readDiagnosisGate(repoRoot) {
  const summaryPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "m3-diagnosis-summary.json");
  const summary = await readJsonOrNull(summaryPath);
  const ready = summary?.diagnosisGateReady === true && summary?.ok === true;
  return {
    ready,
    reason: ready ? "" : "diagnosis-gate-not-ready",
    source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
    requiredCategories: Array.isArray(summary?.gate?.requiredCategories) ? summary.gate.requiredCategories.map((item) => safeString(item)).filter(Boolean) : [],
    reviewOnlyCategories: Array.isArray(summary?.gate?.reviewOnlyCategories) ? summary.gate.reviewOnlyCategories.map((item) => safeString(item)).filter(Boolean) : [],
    categories: summary?.categories || {},
    blockingReasons: Array.isArray(summary?.blockingReasons) ? summary.blockingReasons.map((item) => safeString(item)).filter(Boolean) : [],
  };
}

async function readDiagnosisRows(repoRoot) {
  const resultsPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "real-student-diagnosis-results.csv");
  try {
    return parseCsv(await fs.readFile(resultsPath, "utf8"));
  } catch {
    return [];
  }
}

function hasControlledSubmissionPayload(payload = {}) {
  return Boolean(
    safeString(payload?.scoreId).trim()
    || safeString(payload?.audioPath).trim()
    || safeString(payload?.audioHash).trim()
    || safeString(payload?.audioSubmission?.name).trim()
  );
}

async function buildControlledSubmissionAnalysis(repoRoot, payload = {}) {
  const scoreId = safeString(payload.scoreId).trim();
  const audioHash = safeString(payload.audioHash).trim();
  const audioPath = safeString(payload.audioPath).trim();
  const hasAudio = Boolean(audioHash || audioPath || safeString(payload.audioSubmission?.name).trim());
  const blockingReasons = [
    scoreId ? "" : "controlled-submission-missing-score",
    hasAudio ? "" : "controlled-submission-missing-audio",
    scoreId && hasAudio ? "controlled-submission-requires-offline-analysis" : "",
  ].filter(Boolean);
  const submission = {
    submissionId: createId("strings-submit"),
    submittedAt: nowIso(),
    scoreId,
    dataset: safeString(payload.dataset).trim(),
    piece: safeString(payload.piece).trim(),
    recordingId: safeString(payload.recordingId).trim(),
    instrument: safeString(payload.instrument).trim(),
    limit: Math.max(0, Math.round(safeNumber(payload.limit, 20))),
    audioHash,
    audioPath,
    audioSubmission: payload.audioSubmission || null,
    status: "review_required",
    reason: blockingReasons[0] || "controlled-submission-requires-offline-analysis",
  };
  const outPath = controlledSubmissionsPath(repoRoot);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(submission)}\n`, "utf8");
  return {
    ok: true,
    studentReady: false,
    submissionAccepted: true,
    blockingReasons,
    releaseGates: {},
    summary: {
      noteCount: 0,
      autoPassCount: 0,
      reviewRequiredCount: 0,
      coverage: 0,
      allowedDiagnosticCategories: [],
      reviewOnlyDiagnosticCategories: ["duration", "extra"],
    },
    decisions: [],
    recordingDiagnosis: null,
    submission,
  };
}

function latestReviewBySubmissionId(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const submissionId = safeString(review.submissionId).trim();
    if (!submissionId) continue;
    latest.set(submissionId, review);
  }
  return latest;
}

function decorateControlledSubmission(submission, latestReview = null) {
  const submissionId = safeString(submission.submissionId).trim();
  const reviewAction = safeString(latestReview?.action).trim();
  return {
    submissionId,
    submittedAt: safeString(submission.submittedAt),
    scoreId: safeString(submission.scoreId),
    dataset: safeString(submission.dataset),
    piece: safeString(submission.piece),
    recordingId: safeString(submission.recordingId),
    instrument: safeString(submission.instrument),
    audioHash: safeString(submission.audioHash),
    audioSubmission: submission.audioSubmission || null,
    status: reviewAction || safeString(submission.status, "review_required"),
    reason: safeString(latestReview?.reason || submission.reason),
    latestReview: latestReview || null,
    audioUrl: submissionId ? `/api/strings/controlled-submissions/${encodeURIComponent(submissionId)}/audio` : "",
  };
}

export async function listWesternControlledSubmissions({ repoRoot = process.cwd(), limit = 50 } = {}) {
  const submissions = await readJsonlRecords(controlledSubmissionsPath(repoRoot));
  const reviews = await readJsonlRecords(controlledSubmissionReviewsPath(repoRoot));
  const latest = latestReviewBySubmissionId(reviews);
  const decorated = submissions
    .map((submission) => decorateControlledSubmission(submission, latest.get(safeString(submission.submissionId).trim()) || null))
    .filter((submission) => submission.submissionId)
    .sort((left, right) => safeString(right.submittedAt).localeCompare(safeString(left.submittedAt)));
  const capped = limit > 0 ? decorated.slice(0, limit) : decorated;
  const summary = {
    total: decorated.length,
    reviewRequired: decorated.filter((item) => item.status === "review_required").length,
    acceptedForBatch: decorated.filter((item) => item.status === "accepted_for_batch").length,
    rejected: decorated.filter((item) => item.status === "reject_unsupported").length,
    failed: decorated.filter((item) => item.status === "failed").length,
  };
  return {
    ok: true,
    source: path.relative(repoRoot, controlledSubmissionsPath(repoRoot)).replace(/\\/g, "/"),
    reviewSource: path.relative(repoRoot, controlledSubmissionReviewsPath(repoRoot)).replace(/\\/g, "/"),
    summary,
    submissions: capped,
  };
}

export async function findWesternControlledSubmission({ repoRoot = process.cwd(), submissionId = "" } = {}) {
  const targetId = safeString(submissionId).trim();
  if (!targetId) return null;
  const submissions = await readJsonlRecords(controlledSubmissionsPath(repoRoot));
  return submissions.find((submission) => safeString(submission.submissionId).trim() === targetId) || null;
}

export async function recordWesternControlledSubmissionReview({ repoRoot = process.cwd(), payload = {} } = {}) {
  const submissionId = safeString(payload.submissionId).trim();
  const action = safeString(payload.action).trim();
  if (!submissionId) throw new Error("submissionId is required.");
  if (!["review_required", "accepted_for_batch", "reject_unsupported", "failed"].includes(action)) {
    throw new Error("action must be review_required, accepted_for_batch, reject_unsupported, or failed.");
  }
  const submission = await findWesternControlledSubmission({ repoRoot, submissionId });
  if (!submission) throw new Error("controlled submission not found.");
  const record = {
    submittedAt: nowIso(),
    submissionId,
    action,
    reason: safeString(payload.reason),
    reviewerId: safeString(payload.reviewerId, "reviewer-1"),
    comments: safeString(payload.comments),
  };
  const outPath = controlledSubmissionReviewsPath(repoRoot);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
  return { ok: true, review: record };
}

async function fileExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildBatchGateSnapshot(repoRoot) {
  const sequenceGate = await readStudentGate(repoRoot);
  const realStudentGate = await readRealStudentGate(repoRoot);
  const diagnosisGate = await readDiagnosisGate(repoRoot);
  const ready = sequenceGate.ready && realStudentGate.ready && diagnosisGate.ready;
  return {
    ready,
    sequenceGate: {
      ready: sequenceGate.ready,
      reason: sequenceGate.reason,
      source: sequenceGate.source,
    },
    realStudentGate: {
      ready: realStudentGate.ready,
      reason: realStudentGate.reason,
      source: realStudentGate.source,
    },
    diagnosisGate: {
      ready: diagnosisGate.ready,
      reason: diagnosisGate.reason,
      source: diagnosisGate.source,
      requiredCategories: diagnosisGate.requiredCategories,
      reviewOnlyCategories: diagnosisGate.reviewOnlyCategories,
    },
  };
}

async function buildControlledBatchItem(repoRoot, submission, gateSnapshot, { batchRunId = "" } = {}) {
  const audioPath = safeString(submission.audioPath).trim();
  const audioExists = await fileExists(audioPath);
  const scoreId = safeString(submission.scoreId).trim();
  const dataset = safeString(submission.dataset).trim();
  const piece = safeString(submission.piece).trim();
  const recordingId = safeString(submission.recordingId).trim();
  const instrument = safeString(submission.instrument).trim();
  const blockingReasons = [
    scoreId ? "" : "controlled-batch-missing-score",
    audioExists ? "" : "controlled-batch-missing-audio",
    gateSnapshot.ready ? "" : "controlled-batch-release-gates-not-ready",
  ].filter(Boolean);
  const replay = blockingReasons.length
    ? {
      produced: false,
      status: "review_required",
      reasons: blockingReasons,
    }
    : await buildControlledBatchReplayAnalysis(repoRoot, submission, { batchRunId });
  return {
    submissionId: safeString(submission.submissionId),
    scoreId,
    dataset,
    piece,
    recordingId,
    instrument,
    audioHash: safeString(submission.audioHash),
    audioSubmission: submission.audioSubmission || null,
    inputStatus: "accepted_for_batch",
    analysisStatus: replay.status,
    offlineAnalysisProduced: replay.produced,
    autoDiagnosisIssued: false,
    reasons: replay.reasons,
    analysisSummary: replay.summary || null,
    decisionCount: replay.decisionCount || 0,
    candidateRowCount: replay.candidateRowCount || 0,
    candidateRowsPath: replay.candidateRowsPath || "",
    candidateGate: replay.candidateGate || null,
    candidatePreview: Array.isArray(replay.candidatePreview) ? replay.candidatePreview : [],
    recordingDiagnosis: replay.recordingDiagnosis || null,
    error: replay.error || "",
  };
}

async function buildControlledBatchReplayAnalysis(repoRoot, submission, { batchRunId = "" } = {}) {
  const dataset = safeString(submission.dataset).trim();
  const piece = safeString(submission.piece).trim();
  const recordingId = safeString(submission.recordingId).trim();
  if (!dataset || !piece) {
    return buildControlledBatchOfflineFeatureAnalysis(repoRoot, submission, { batchRunId });
  }
  try {
    const analysis = await buildWesternStudentAnalysis({
      repoRoot,
      dataset,
      piece,
      recordingId,
      limit: Math.max(0, Math.round(safeNumber(submission.limit, 20))),
    });
    if (analysis.studentReady !== true) {
      return {
        produced: false,
        status: "review_required",
        reasons: [
          ...(Array.isArray(analysis.blockingReasons) ? analysis.blockingReasons.map((item) => safeString(item)).filter(Boolean) : []),
          "controlled-batch-gated-analysis-not-ready",
        ],
      };
    }
    return {
      produced: true,
      status: "offline_analysis_ready",
      reasons: ["controlled-batch-not-student-facing"],
      summary: analysis.summary || null,
      decisionCount: Array.isArray(analysis.decisions) ? analysis.decisions.length : 0,
      candidateRowCount: Array.isArray(analysis.decisions) ? analysis.decisions.length : 0,
      candidatePreview: [],
      recordingDiagnosis: analysis.recordingDiagnosis || null,
    };
  } catch (error) {
    return {
      produced: false,
      status: "failed",
      reasons: ["controlled-batch-offline-analysis-failed"],
      error: safeString(error?.message || error),
    };
  }
}

function parseJsonFromStdout(stdout) {
  const lines = safeString(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep scanning; helper scripts may print progress before their JSON payload.
    }
  }
  return null;
}

async function runOfflineFeatureAnalyzer(repoRoot, submission) {
  const scoreId = safeString(submission.scoreId).trim();
  const audioPath = safeString(submission.audioPath).trim();
  const scriptPath = path.join(SOURCE_ROOT, "scripts", "experiments", "run_western_strings_offline_feature_analysis.py");
  const runnerPath = path.join(SOURCE_ROOT, "scripts", "run-python.ps1");
  const args = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    runnerPath,
    scriptPath,
    "--repo-root",
    repoRoot,
    "--score-id",
    scoreId,
    "--audio",
    audioPath,
    "--limit",
    String(Math.max(0, Math.round(safeNumber(submission.limit, 20)))),
  ];
  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    cwd: SOURCE_ROOT,
    timeout: Math.max(10000, Math.round(safeNumber(process.env.WESTERN_STRINGS_OFFLINE_ANALYZER_TIMEOUT_MS, 120000))),
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ERHU_CPU_THREAD_LIMIT: process.env.ERHU_CPU_THREAD_LIMIT || "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  const parsed = parseJsonFromStdout(stdout);
  if (!parsed) {
    throw new Error(`offline feature analyzer returned no JSON.${stderr ? ` stderr=${safeString(stderr).slice(0, 500)}` : ""}`);
  }
  return parsed;
}

async function buildControlledBatchOfflineFeatureAnalysis(repoRoot, submission, { batchRunId = "" } = {}) {
  const scoreId = safeString(submission.scoreId).trim();
  const audioPath = safeString(submission.audioPath).trim();
  if (!scoreId || !audioPath) {
    return {
      produced: false,
      status: "review_required",
      reasons: ["controlled-batch-offline-feature-extractor-not-connected"],
    };
  }
  try {
    const analysis = await runOfflineFeatureAnalyzer(repoRoot, submission);
    if (analysis?.ok !== true) {
      return {
        produced: false,
        status: "review_required",
        reasons: Array.isArray(analysis?.blockingReasons) && analysis.blockingReasons.length
          ? analysis.blockingReasons.map((item) => safeString(item)).filter(Boolean)
          : ["controlled-batch-offline-feature-analysis-not-ready"],
        summary: analysis?.summary || null,
      };
    }
    const candidateRows = Array.isArray(analysis.candidateRows) ? analysis.candidateRows : [];
    const candidateGate = evaluateOfflineFeatureStudentSafeGate(candidateRows);
    const gatedCandidateRows = applyOfflineFeatureStudentSafeGate(candidateRows, candidateGate);
    const candidateRowsPath = await writeControlledSubmissionCandidateRows(repoRoot, {
      batchRunId,
      submissionId: submission.submissionId,
      candidateRows: gatedCandidateRows,
    });
    return {
      produced: true,
      status: "offline_feature_review_ready",
      reasons: ["controlled-batch-offline-feature-review-only"],
      summary: {
        ...(analysis.summary || {}),
        studentSafeGateReady: false,
        studentSafeCandidateGateReady: candidateGate.ready,
        studentSafeCandidateGateVersion: candidateGate.gateVersion,
      },
      decisionCount: Array.isArray(analysis.decisions) ? analysis.decisions.length : 0,
      candidateRowCount: candidateRows.length,
      candidateRowsPath,
      candidateGate,
      candidatePreview: gatedCandidateRows.slice(0, 5),
      recordingDiagnosis: {
        mode: "offline_feature_review_only",
        scoreId,
        audioHash: safeString(submission.audioHash),
        autoDiagnosisIssued: false,
      },
    };
  } catch (error) {
    return {
      produced: false,
      status: "failed",
      reasons: ["controlled-batch-offline-feature-analysis-failed"],
      error: safeString(error?.message || error),
    };
  }
}

function evaluateOfflineFeatureStudentSafeGate(candidateRows = []) {
  const evaluatedCandidateCount = Array.isArray(candidateRows) ? candidateRows.length : 0;
  return {
    gateVersion: OFFLINE_FEATURE_STUDENT_GATE_VERSION,
    ready: false,
    mode: "review_only",
    reason: "ordinary-upload-student-safe-gate-not-calibrated",
    blockingReasons: ["ordinary-upload-student-safe-gate-not-calibrated"],
    evaluatedCandidateCount,
    autoPassCandidateCount: 0,
    reviewRequiredCandidateCount: evaluatedCandidateCount,
    allowedDiagnosticCategories: [],
    reviewOnlyDiagnosticCategories: ["pitch", "onset", "missing", "duration", "extra"],
  };
}

function applyOfflineFeatureStudentSafeGate(candidateRows = [], candidateGate = {}) {
  return (Array.isArray(candidateRows) ? candidateRows : []).map((candidate) => ({
    ...candidate,
    autoDecision: "review_required",
    confidenceScore: 0,
    gateDecision: "review_required",
    gateReason: safeString(candidateGate.reason, "ordinary-upload-student-safe-gate-not-calibrated"),
    gateVersion: safeString(candidateGate.gateVersion, OFFLINE_FEATURE_STUDENT_GATE_VERSION),
    reviewRequiredReason: safeString(candidate.reviewRequiredReason, "offline-feature-analysis-review-only"),
    studentSafeGateReady: false,
    studentFacing: false,
  }));
}

export async function runWesternControlledSubmissionBatch({
  repoRoot = process.cwd(),
  limit = 20,
} = {}) {
  const queue = await listWesternControlledSubmissions({ repoRoot, limit: 0 });
  const accepted = queue.submissions.filter((submission) => submission.status === "accepted_for_batch");
  const selected = limit > 0 ? accepted.slice(0, limit) : accepted;
  const rawSubmissions = await readJsonlRecords(controlledSubmissionsPath(repoRoot));
  const rawById = new Map(rawSubmissions.map((submission) => [safeString(submission.submissionId).trim(), submission]));
  const gateSnapshot = await buildBatchGateSnapshot(repoRoot);
  const batchRunId = createId("strings-batch");
  const items = [];
  for (const submission of selected) {
    const raw = rawById.get(submission.submissionId) || submission;
    items.push(await buildControlledBatchItem(repoRoot, raw, gateSnapshot, { batchRunId }));
  }
  const offlineAnalysisProducedCount = items.filter((item) => item.offlineAnalysisProduced === true).length;
  const hasValidatedReplay = items.some((item) => item.analysisStatus === "offline_analysis_ready");
  const hasFeatureReview = items.some((item) => item.analysisStatus === "offline_feature_review_ready");
  const run = {
    batchRunId,
    createdAt: nowIso(),
    source: path.relative(repoRoot, controlledSubmissionsPath(repoRoot)).replace(/\\/g, "/"),
    itemCount: items.length,
    acceptedQueueCount: accepted.length,
    offlineAnalysisProducedCount,
    autoDiagnosisIssued: false,
    status: items.length
      ? (hasValidatedReplay ? "offline_analysis_ready" : hasFeatureReview ? "offline_feature_review_ready" : "review_required")
      : "no_accepted_submissions",
    reason: items.length
      ? (offlineAnalysisProducedCount > 0 ? "controlled-batch-not-student-facing" : "controlled-batch-offline-feature-extractor-not-connected")
      : "controlled-batch-empty",
    gateSnapshot,
    items,
  };
  if (items.length > 0) {
    const outPath = controlledSubmissionBatchRunsPath(repoRoot);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.appendFile(outPath, `${JSON.stringify(run)}\n`, "utf8");
  }
  return { ok: true, batch: run };
}

function buildCategoryDiagnosis(row, category, { required = false } = {}) {
  const autoIssueCount = Math.max(0, Math.round(safeNumber(row?.[`${category}AutoIssueCount`], 0)));
  const correctIssueCount = Math.max(0, Math.round(safeNumber(row?.[`${category}CorrectIssueCount`], 0)));
  const unsafeIssueCount = Math.max(0, Math.round(safeNumber(row?.[`${category}UnsafeIssueCount`], 0)));
  const precision = autoIssueCount ? Number((correctIssueCount / autoIssueCount).toFixed(6)) : null;
  return {
    category,
    requiredForRelease: required,
    status: required ? (autoIssueCount ? "auto_pass" : "no_issue_detected") : "review_only",
    autoIssueCount,
    correctIssueCount,
    unsafeIssueCount,
    precision,
  };
}

function buildRecordingDiagnosis(row, diagnosisGate) {
  if (!row) return null;
  const required = new Set(diagnosisGate.requiredCategories || []);
  const reviewOnly = new Set(diagnosisGate.reviewOnlyCategories || []);
  const categories = [...required, ...reviewOnly].map((category) => buildCategoryDiagnosis(row, category, {
    required: required.has(category),
  }));
  return {
    recordingId: safeString(row.recordingId),
    scenario: safeString(row.scenario),
    autoPassEvaluatedCount: Math.max(0, Math.round(safeNumber(row.autoPassEvaluatedCount, 0))),
    categories,
    notes: safeString(row.notes),
  };
}

function reviewRequiredDecision(decision, reason, evidence = {}) {
  return {
    ...decision,
    autoDecision: "review_required",
    confidenceScore: 0,
    reviewRequiredReason: reason,
    evidence: {
      ...decision.evidence,
      ...evidence,
    },
  };
}

async function applyStudentGate(repoRoot, decisions, gate) {
  if (!gate.ready) {
    return decisions.map((decision) => reviewRequiredDecision(decision, gate.reason, { studentGateReady: false }));
  }
  const eventCache = new Map();
  const grouped = new Map();
  for (const decision of decisions) {
    const key = `${decision.dataset}\u0000${decision.piece}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(decision);
  }
  const nextDecisions = [];
  for (const pieceDecisions of grouped.values()) {
    pieceDecisions.sort((left, right) => left.noteIndex - right.noteIndex);
    for (let index = 0; index < pieceDecisions.length; index += 1) {
      const decision = pieceDecisions[index];
      const supported = await hasSequenceBasicPitchSupport(repoRoot, eventCache, pieceDecisions, index, gate.supportFeature);
      if (!supported) {
        nextDecisions.push(reviewRequiredDecision(decision, "sequence-basic-pitch-support-missing", {
          studentGateReady: true,
          sequenceBasicPitchSupport: false,
        }));
      } else {
        nextDecisions.push({
          ...decision,
          evidence: {
            ...decision.evidence,
            studentGateReady: true,
            sequenceBasicPitchSupport: true,
          },
        });
      }
    }
  }
  return nextDecisions.sort((left, right) => (
    left.dataset.localeCompare(right.dataset) ||
    left.piece.localeCompare(right.piece) ||
    left.noteIndex - right.noteIndex
  ));
}

export async function buildWesternAlignmentPreview({
  repoRoot = process.cwd(),
  featuresPath = "data/experiments/western-strings-m2/alignment-candidate-feature-table.csv",
  dataset = "",
  piece = "",
  limit = 0,
  includeLabels = false,
  studentSafe = false,
} = {}) {
  const resolvedPath = path.resolve(repoRoot, featuresPath);
  const text = await fs.readFile(resolvedPath, "utf8");
  const rows = parseCsv(text)
    .filter((row) => !dataset || safeString(row.dataset) === dataset)
    .filter((row) => !piece || safeString(row.piece) === piece);
  const rawDecisions = groupRows(rows)
    .map((group) => buildDecision(group, { includeLabels }))
    .sort((left, right) => (
      left.dataset.localeCompare(right.dataset) ||
      left.piece.localeCompare(right.piece) ||
      left.noteIndex - right.noteIndex
    ));
  const studentGate = studentSafe ? await readStudentGate(repoRoot) : null;
  const decisions = studentGate ? await applyStudentGate(repoRoot, rawDecisions, studentGate) : rawDecisions;
  const cappedDecisions = limit > 0 ? decisions.slice(0, limit) : decisions;
  return {
    ok: true,
    source: path.relative(repoRoot, resolvedPath).replace(/\\/g, "/"),
    filters: { dataset, piece, limit, studentSafe },
    releaseGate: studentGate,
    summary: summarize(decisions, { includeLabels }),
    decisions: cappedDecisions,
  };
}

export async function buildWesternStudentAnalysis({
  repoRoot = process.cwd(),
  dataset = "",
  piece = "",
  limit = 0,
  recordingId = "",
  submissionPayload = null,
} = {}) {
  if (hasControlledSubmissionPayload(submissionPayload)) {
    return buildControlledSubmissionAnalysis(repoRoot, submissionPayload);
  }

  const sequenceGate = await readStudentGate(repoRoot);
  const realStudentGate = await readRealStudentGate(repoRoot);
  const diagnosisGate = await readDiagnosisGate(repoRoot);
  const blockingReasons = [
    sequenceGate.ready ? "" : sequenceGate.reason,
    realStudentGate.ready ? "" : realStudentGate.reason,
    diagnosisGate.ready ? "" : diagnosisGate.reason,
    ...diagnosisGate.blockingReasons,
  ].filter(Boolean);
  const studentReady = blockingReasons.length === 0;

  if (!studentReady) {
    return {
      ok: true,
      studentReady: false,
      blockingReasons: [...new Set(blockingReasons)],
      releaseGates: {
        sequenceGate,
        realStudentGate,
        diagnosisGate,
      },
      summary: {
        noteCount: 0,
        autoPassCount: 0,
        reviewRequiredCount: 0,
        coverage: 0,
      },
      decisions: [],
      recordingDiagnosis: null,
    };
  }

  const preview = await buildWesternAlignmentPreview({
    repoRoot,
    dataset,
    piece,
    limit,
    studentSafe: true,
    includeLabels: false,
  });
  const diagnosisRows = await readDiagnosisRows(repoRoot);
  const recordingRow = recordingId
    ? diagnosisRows.find((row) => safeString(row.recordingId) === safeString(recordingId))
    : null;
  const allowedDiagnosticCategories = diagnosisGate.requiredCategories.filter((category) => (
    diagnosisGate.categories?.[category]?.ready === true
  ));
  const decisions = preview.decisions.map((decision) => ({
    ...decision,
    allowedDiagnosticCategories,
    reviewOnlyDiagnosticCategories: diagnosisGate.reviewOnlyCategories,
    diagnosisMode: "core-categories-only",
  }));

  return {
    ok: true,
    studentReady: true,
    blockingReasons: [],
    releaseGates: {
      sequenceGate,
      realStudentGate,
      diagnosisGate,
    },
    summary: {
      ...preview.summary,
      allowedDiagnosticCategories,
      reviewOnlyDiagnosticCategories: diagnosisGate.reviewOnlyCategories,
    },
    decisions,
    recordingDiagnosis: buildRecordingDiagnosis(recordingRow, diagnosisGate),
  };
}

export function parsePreviewQuery(query = {}) {
  return {
    dataset: safeString(query.dataset).trim(),
    piece: safeString(query.piece).trim(),
    limit: Math.max(0, Math.round(safeNumber(query.limit, 0))),
    includeLabels: safeBoolean(query.includeLabels, false),
    studentSafe: safeBoolean(query.studentSafe, false),
  };
}

export function parseStudentAnalysisPayload(payload = {}) {
  return {
    dataset: safeString(payload.dataset).trim(),
    piece: safeString(payload.piece).trim(),
    limit: Math.max(0, Math.round(safeNumber(payload.limit, 0))),
    recordingId: safeString(payload.recordingId).trim(),
    scoreId: safeString(payload.scoreId).trim(),
    audioPath: safeString(payload.audioPath).trim(),
    audioHash: safeString(payload.audioHash).trim(),
    audioSubmission: payload.audioSubmission || null,
  };
}

export async function recordWesternAlignmentPreviewReview({ repoRoot, payload = {} }) {
  const noteKey = safeString(payload.noteKey || payload.noteId).trim();
  const action = safeString(payload.action).trim();
  if (!noteKey) throw new Error("noteKey is required.");
  if (!["confirm", "correct", "review_required"].includes(action)) {
    throw new Error("action must be confirm, correct, or review_required.");
  }
  const record = {
    submittedAt: new Date().toISOString(),
    noteKey,
    action,
    raterId: safeString(payload.raterId, "teacher-1"),
    predictedOnsetSeconds: numberOrNull(payload.predictedOnsetSeconds),
    correctedOnsetSeconds: numberOrNull(payload.correctedOnsetSeconds),
    comments: safeString(payload.comments),
  };
  const outPath = path.join(repoRoot, "data", "experiments", "western-strings-m2", "alignment-preview-reviews.jsonl");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
  return { ok: true, review: record };
}

export async function recordWesternStudentReview({ repoRoot, payload = {} }) {
  const noteKey = safeString(payload.noteKey || payload.noteId).trim();
  const action = safeString(payload.action).trim();
  const category = safeString(payload.category).trim();
  if (!noteKey && !safeString(payload.recordingId).trim()) throw new Error("noteKey or recordingId is required.");
  if (!["confirm", "correct", "review_required"].includes(action)) {
    throw new Error("action must be confirm, correct, or review_required.");
  }
  const record = {
    submittedAt: new Date().toISOString(),
    noteKey,
    recordingId: safeString(payload.recordingId),
    action,
    category,
    raterId: safeString(payload.raterId, "teacher-1"),
    predictedOnsetSeconds: numberOrNull(payload.predictedOnsetSeconds),
    correctedOnsetSeconds: numberOrNull(payload.correctedOnsetSeconds),
    comments: safeString(payload.comments),
  };
  const outPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "student-analysis-reviews.jsonl");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
  return { ok: true, review: record };
}
