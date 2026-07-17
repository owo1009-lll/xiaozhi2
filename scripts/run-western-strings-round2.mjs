import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildWesternStudentAnalysis,
  listWesternControlledSubmissions,
  recordWesternControlledSubmissionReview,
  runWesternControlledSubmissionBatch,
} from "../src/server/westernStringsAlignmentService.js";

const DEFAULT_MANIFEST = path.join("data", "private", "western-strings-round2", "manifest.csv");
const DEFAULT_OUT = path.join("data", "experiments", "western-strings-round2", "machine-analysis.json");
const DEFAULT_MARKDOWN = path.join("data", "experiments", "western-strings-round2", "machine-analysis.md");

function parseArgs(argv) {
  const args = { manifest: DEFAULT_MANIFEST, out: DEFAULT_OUT, markdown: DEFAULT_MARKDOWN, limit: 0,
    expectedRows: 8, dataset: "western-strings-round2" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--markdown") args.markdown = argv[++index] || args.markdown;
    else if (arg === "--limit") args.limit = Math.max(0, Math.round(Number(argv[++index] || 0)));
    else if (arg === "--expected-rows") args.expectedRows = Math.max(1, Math.round(Number(argv[++index] || 8)));
    else if (arg === "--dataset") args.dataset = argv[++index] || args.dataset;
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") value += char;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...data] = rows.filter((cells) => cells.some((cell) => String(cell || "").trim()));
  const cleanHeaders = headers.map((header) => String(header || "").replace(/^\uFEFF/, ""));
  return data.map((cells) => Object.fromEntries(cleanHeaders.map((header, index) => [header, cells[index] || ""])));
}

async function sha256(filePath) {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(filePath));
  return digest.digest("hex");
}

function rel(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

async function readCandidateStructure(repoRoot, candidateRowsPath) {
  if (!candidateRowsPath) return { measureCount: 0, uniqueNoteIdCount: 0, error: "candidate-rows-path-missing" };
  try {
    const artifact = JSON.parse(await fs.readFile(path.resolve(repoRoot, candidateRowsPath), "utf8"));
    const rows = Array.isArray(artifact.candidateRows) ? artifact.candidateRows : [];
    return {
      measureCount: new Set(rows.map((row) => Number(row.measureIndex || 0)).filter((value) => value > 0)).size,
      uniqueNoteIdCount: new Set(rows.map((row) => String(row.noteId || "").trim()).filter(Boolean)).size,
      error: "",
    };
  } catch (error) {
    return { measureCount: 0, uniqueNoteIdCount: 0, error: String(error?.message || error) };
  }
}

function renderMarkdown(report) {
  const lines = [
    "# Western Strings Round 2 Machine Analysis",
    "",
    `- ready: ${report.ready}`,
    `- input rows: ${report.summary.inputRowCount}`,
    `- submissions: ${report.summary.submissionCount}`,
    `- analyzed: ${report.summary.offlineAnalysisProducedCount}`,
    `- candidate rows: ${report.summary.candidateRowCount}`,
    `- auto diagnosis issued: ${report.summary.autoDiagnosisIssued}`,
    `- student facing: ${report.summary.studentFacing}`,
    "",
    "| recording | scenario | analysis status | candidates | auto diagnosis |",
    "|---|---|---|---:|---|",
  ];
  for (const item of report.items) {
    lines.push(`| ${item.recordingId} | ${item.scenario} | ${item.analysisStatus} | ${item.candidateRowCount} | ${item.autoDiagnosisIssued} |`);
  }
  lines.push("", "## Blocking Reasons", "");
  lines.push(...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]));
  lines.push(
    "",
    "This run creates machine evidence only. It does not infer the deliberately changed measure locations and does not publish student feedback.",
    "",
  );
  return lines.join("\n");
}

export async function runRound2MachineAnalysis({
  repoRoot = process.cwd(),
  manifestPath = DEFAULT_MANIFEST,
  outPath = DEFAULT_OUT,
  markdownPath = DEFAULT_MARKDOWN,
  noteLimit = 0,
  expectedRows = 8,
  dataset = "western-strings-round2",
} = {}, dependencies = {}) {
  const buildAnalysis = dependencies.buildAnalysis || buildWesternStudentAnalysis;
  const listSubmissions = dependencies.listSubmissions || listWesternControlledSubmissions;
  const recordReview = dependencies.recordReview || recordWesternControlledSubmissionReview;
  const runBatch = dependencies.runBatch || runWesternControlledSubmissionBatch;
  const resolvedManifest = path.resolve(repoRoot, manifestPath);
  const rows = parseCsv(await fs.readFile(resolvedManifest, "utf8"));
  const blockers = [];
  if (rows.length !== expectedRows) blockers.push(`round2-manifest-row-count:${rows.length}:${expectedRows}`);
  for (const row of rows) {
    if (!String(row.recordingId || "").trim()) blockers.push("round2-recording-id-missing");
    if (!String(row.scoreId || "").trim()) blockers.push(`round2-score-id-missing:${row.recordingId || "unknown"}`);
    const audioPath = path.resolve(repoRoot, String(row.audioPath || ""));
    try {
      await fs.access(audioPath);
    } catch {
      blockers.push(`round2-audio-missing:${row.recordingId || "unknown"}`);
    }
  }
  if (blockers.length) {
    throw new Error([...new Set(blockers)].join(";"));
  }

  const before = await listSubmissions({ repoRoot, limit: 0 });
  const existingByRecording = new Map();
  for (const submission of before.submissions) {
    if (!existingByRecording.has(submission.recordingId)) {
      existingByRecording.set(submission.recordingId, submission);
    }
  }
  const submissions = [];
  for (const row of rows) {
    const audioPath = path.resolve(repoRoot, row.audioPath);
    const audioHash = await sha256(audioPath);
    let submission = existingByRecording.get(row.recordingId);
    if (submission && submission.audioHash && submission.audioHash !== audioHash) {
      throw new Error(`round2-existing-submission-audio-hash-mismatch:${row.recordingId}`);
    }
    if (submission && submission.scoreId !== row.scoreId) {
      await recordReview({
        repoRoot,
        payload: {
          submissionId: submission.submissionId,
          action: "reject_unsupported",
          reason: "round2-score-superseded",
          reviewerId: "round2-automated-input-audit",
          comments: `Superseded by corrected score ${row.scoreId}; historical submission retained for audit.`,
        },
      });
      submission = null;
    }
    if (!submission) {
      const analysis = await buildAnalysis({
        repoRoot,
        submissionPayload: {
          scoreId: row.scoreId,
          audioPath,
          audioHash,
          audioSubmission: { name: path.basename(audioPath), source: "round2-private-intake" },
          dataset,
          piece: row.pieceId,
          recordingId: row.recordingId,
          instrument: "violin",
          limit: noteLimit,
        },
      });
      submission = analysis.submission;
    }
    if (!submission?.submissionId) throw new Error(`round2-submission-not-created:${row.recordingId}`);
    if (submission.status !== "accepted_for_batch") {
      await recordReview({
        repoRoot,
        payload: {
          submissionId: submission.submissionId,
          action: "accepted_for_batch",
          reason: "round2-input-audit-passed",
          reviewerId: "round2-automated-input-audit",
          comments: "Input identity, decode, score structure, image signature, and history uniqueness passed; offline review-only analysis authorized.",
        },
      });
    }
    submissions.push({ ...submission, recordingId: row.recordingId });
  }

  const submissionIds = submissions.map((submission) => submission.submissionId);
  const batchResult = await runBatch({
    repoRoot,
    limit: submissionIds.length,
    submissionIds,
  });
  const batch = batchResult.batch || {};
  const batchItems = Array.isArray(batch.items) ? batch.items : [];
  const batchByRecording = new Map(batchItems.map((item) => [item.recordingId, item]));
  const items = await Promise.all(rows.map(async (row) => {
    const item = batchByRecording.get(row.recordingId) || {};
    const candidateRowsPath = String(item.candidateRowsPath || "");
    const structure = await readCandidateStructure(repoRoot, candidateRowsPath);
    return {
      recordingId: row.recordingId,
      pieceId: row.pieceId,
      scenario: row.scenario,
      submissionId: String(item.submissionId || ""),
      analysisStatus: String(item.analysisStatus || "missing"),
      offlineAnalysisProduced: item.offlineAnalysisProduced === true,
      candidateRowCount: Number(item.candidateRowCount || 0),
      expectedPitchedNoteCount: Number(row.expectedPitchedNoteCount || 0),
      expectedMeasureCount: Number(row.expectedMeasureCount || 0),
      candidateMeasureCount: structure.measureCount,
      candidateUniqueNoteIdCount: structure.uniqueNoteIdCount,
      candidateStructureError: structure.error,
      candidateRowsPath,
      autoDiagnosisIssued: item.autoDiagnosisIssued === true,
      studentFacing: item.autoDiagnosisIssued === true,
      reasons: Array.isArray(item.reasons) ? item.reasons : [],
      error: String(item.error || ""),
    };
  }));
  if (batchItems.length !== rows.length) blockers.push(`round2-batch-item-count:${batchItems.length}:${rows.length}`);
  for (const item of items) {
    if (!item.offlineAnalysisProduced) blockers.push(`round2-analysis-not-produced:${item.recordingId}:${item.analysisStatus}`);
    if (item.expectedPitchedNoteCount > 0 && item.candidateRowCount !== item.expectedPitchedNoteCount) {
      blockers.push(`round2-candidate-count-mismatch:${item.recordingId}:${item.candidateRowCount}:${item.expectedPitchedNoteCount}`);
    }
    if (item.expectedMeasureCount > 0 && item.candidateMeasureCount !== item.expectedMeasureCount) {
      blockers.push(`round2-candidate-measure-count-mismatch:${item.recordingId}:${item.candidateMeasureCount}:${item.expectedMeasureCount}`);
    }
    if (item.expectedPitchedNoteCount > 0 && item.candidateUniqueNoteIdCount !== item.expectedPitchedNoteCount) {
      blockers.push(`round2-candidate-note-id-count-mismatch:${item.recordingId}:${item.candidateUniqueNoteIdCount}:${item.expectedPitchedNoteCount}`);
    }
    if (item.candidateStructureError) blockers.push(`round2-candidate-structure-unreadable:${item.recordingId}`);
    if (item.autoDiagnosisIssued) blockers.push(`round2-default-runtime-issued-auto-diagnosis:${item.recordingId}`);
  }
  const uniqueBlockers = [...new Set(blockers)];
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    ready: uniqueBlockers.length === 0,
    runtimePolicy: "review-only",
    manifest: rel(repoRoot, resolvedManifest),
    batchRunId: String(batch.batchRunId || ""),
    summary: {
      inputRowCount: rows.length,
      submissionCount: submissions.length,
      offlineAnalysisProducedCount: items.filter((item) => item.offlineAnalysisProduced).length,
      candidateRowCount: items.reduce((sum, item) => sum + item.candidateRowCount, 0),
      autoDiagnosisIssued: items.some((item) => item.autoDiagnosisIssued),
      studentFacing: false,
    },
    blockingReasons: uniqueBlockers,
    items,
  };
  const resolvedOut = path.resolve(repoRoot, outPath);
  const resolvedMarkdown = path.resolve(repoRoot, markdownPath);
  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });
  await fs.mkdir(path.dirname(resolvedMarkdown), { recursive: true });
  await fs.writeFile(resolvedOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(resolvedMarkdown, renderMarkdown(report), "utf8");
  report.artifacts = { json: rel(repoRoot, resolvedOut), markdown: rel(repoRoot, resolvedMarkdown) };
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runRound2MachineAnalysis({
    manifestPath: args.manifest,
    outPath: args.out,
    markdownPath: args.markdown,
    noteLimit: args.limit,
    expectedRows: args.expectedRows,
    dataset: args.dataset,
  });
  console.log(JSON.stringify({
    ok: report.ok,
    ready: report.ready,
    summary: report.summary,
    blockingReasons: report.blockingReasons,
    items: report.items,
    artifacts: report.artifacts,
  }, null, 2));
  if (!report.ready) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
