import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Blob } from "node:buffer";
import { pathToFileURL } from "node:url";

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
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
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  const normalizedHeaders = headers.map((header) => safeString(header).replace(/^\uFEFF/, ""));
  return dataRows.map((dataRow) => Object.fromEntries(normalizedHeaders.map((header, index) => [header, dataRow[index] ?? ""])));
}

async function readCsv(filePath) {
  return parseCsv(await fs.readFile(filePath, "utf8"));
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

function submissionKey(row) {
  return `${safeString(row.recordingId)}::${safeString(row.scoreId)}`;
}

function existingSubmissionKeys(submissions) {
  return new Set(submissions.map((submission) => submissionKey(submission)));
}

async function postAnalyze({
  serverUrl,
  repoRoot,
  row,
  limit,
}) {
  const audioPath = path.resolve(repoRoot, safeString(row.audioPath));
  const audioBuffer = await fs.readFile(audioPath);
  const formData = new FormData();
  formData.append("audio", new Blob([audioBuffer]), path.basename(audioPath));
  formData.append("payload", JSON.stringify({
    scoreId: safeString(row.scoreId),
    recordingId: safeString(row.recordingId),
    piece: safeString(row.pieceId),
    limit,
  }));
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/strings/analyze`, {
    method: "POST",
    body: formData,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true || body.analysis?.submissionAccepted !== true) {
    throw new Error(`controlled submission failed for ${row.recordingId}: HTTP ${response.status} ${body.error || ""}`);
  }
  return body.analysis.submission;
}

async function postReview({ serverUrl, submissionId, comments }) {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/strings/controlled-submissions/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      submissionId,
      action: "accepted_for_batch",
      comments,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`accept-for-batch failed for ${submissionId}: HTTP ${response.status} ${body.error || ""}`);
  }
  return body;
}

async function postBatch({ serverUrl, limit }) {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/strings/controlled-submissions/run-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`controlled batch failed: HTTP ${response.status} ${body.error || ""}`);
  }
  return body.batch;
}

export async function seedWesternControlledSubmissionsFromM2f({
  repoRoot = process.cwd(),
  manifestPath = path.join("data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv"),
  controlledSubmissionsPath = path.join("data", "experiments", "western-strings-m3", "controlled-submissions.jsonl"),
  serverUrl = "http://127.0.0.1:3000",
  apply = false,
  accept = true,
  runBatch = false,
  candidateLimit = 0,
  batchLimit = 50,
} = {}) {
  const resolvedManifestPath = path.resolve(repoRoot, manifestPath);
  const rows = (await readCsv(resolvedManifestPath)).filter((row) => safeString(row.audioPath) && safeString(row.scoreId));
  const submissions = await readJsonl(path.resolve(repoRoot, controlledSubmissionsPath));
  const existingKeys = existingSubmissionKeys(submissions);
  const plannedRows = rows.map((row) => {
    const key = submissionKey(row);
    const audioExists = fsSync.existsSync(path.resolve(repoRoot, safeString(row.audioPath)));
    const alreadySubmitted = existingKeys.has(key);
    const blockers = [
      safeString(row.scoreId) ? "" : "score-id-missing",
      audioExists ? "" : "audio-missing",
    ].filter(Boolean);
    return {
      recordingId: safeString(row.recordingId),
      pieceId: safeString(row.pieceId),
      scenario: safeString(row.scenario),
      scoreId: safeString(row.scoreId),
      audioPath: safeString(row.audioPath),
      audioExists,
      alreadySubmitted,
      action: blockers.length ? "blocked" : alreadySubmitted ? "skip-existing-submission" : "submit",
      blockers,
      row,
    };
  });
  const blocked = plannedRows.filter((row) => row.action === "blocked");
  if (!apply) {
    return {
      ok: blocked.length === 0,
      applied: false,
      summary: {
        rowCount: plannedRows.length,
        submitCount: plannedRows.filter((row) => row.action === "submit").length,
        existingSubmissionCount: plannedRows.filter((row) => row.action === "skip-existing-submission").length,
        blockedCount: blocked.length,
      },
      rows: plannedRows.map(({ row, ...rest }) => rest),
    };
  }
  if (blocked.length) {
    throw new Error("Cannot seed controlled submissions: at least one row is blocked.");
  }
  const submitted = [];
  const skipped = [];
  for (const planned of plannedRows) {
    if (planned.action === "skip-existing-submission") {
      skipped.push(planned);
      continue;
    }
    const submission = await postAnalyze({
      serverUrl,
      repoRoot,
      row: planned.row,
      limit: candidateLimit,
    });
    submitted.push({
      ...planned,
      submissionId: safeString(submission.submissionId),
    });
    if (accept) {
      await postReview({
        serverUrl,
        submissionId: safeString(submission.submissionId),
        comments: `Seeded from M2f manifest ${planned.recordingId}; review-only candidate calibration.`,
      });
    }
  }
  const batch = runBatch
    ? await postBatch({ serverUrl, limit: batchLimit })
    : null;
  return {
    ok: true,
    applied: true,
    submitted,
    skipped,
    acceptedCount: accept ? submitted.length : 0,
    batch,
  };
}

function parseArgs(argv) {
  const args = {
    apply: false,
    accept: true,
    runBatch: false,
    manifest: path.join("data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv"),
    controlledSubmissions: path.join("data", "experiments", "western-strings-m3", "controlled-submissions.jsonl"),
    serverUrl: "http://127.0.0.1:3000",
    candidateLimit: 0,
    batchLimit: 50,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--no-accept") args.accept = false;
    else if (arg === "--run-batch") args.runBatch = true;
    else if (arg === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (arg === "--controlled-submissions") args.controlledSubmissions = argv[++index] || args.controlledSubmissions;
    else if (arg === "--server-url") args.serverUrl = argv[++index] || args.serverUrl;
    else if (arg === "--candidate-limit") args.candidateLimit = Number(argv[++index] || args.candidateLimit);
    else if (arg === "--batch-limit") args.batchLimit = Number(argv[++index] || args.batchLimit);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await seedWesternControlledSubmissionsFromM2f({
    manifestPath: args.manifest,
    controlledSubmissionsPath: args.controlledSubmissions,
    serverUrl: args.serverUrl,
    apply: args.apply,
    accept: args.accept,
    runBatch: args.runBatch,
    candidateLimit: args.candidateLimit,
    batchLimit: args.batchLimit,
  });
  console.log(JSON.stringify({
    ok: result.ok,
    applied: result.applied,
    summary: result.summary,
    submittedCount: result.submitted?.length || 0,
    skippedCount: result.skipped?.length || 0,
    acceptedCount: result.acceptedCount || 0,
    batch: result.batch ? {
      batchRunId: result.batch.batchRunId,
      itemCount: result.batch.itemCount,
      status: result.batch.status,
      offlineAnalysisProducedCount: result.batch.offlineAnalysisProducedCount,
      autoDiagnosisIssued: result.batch.autoDiagnosisIssued,
    } : null,
    rows: result.applied ? undefined : result.rows,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
