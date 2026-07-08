import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readScoreStoreFromSqlite } from "../src/server/scoreStoreSqlite.js";

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizePath(value) {
  return safeString(value).replace(/\\/g, "/");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

async function readCsvIfExists(filePath) {
  try {
    return {
      exists: true,
      rows: parseCsv(await fs.readFile(filePath, "utf8")),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, rows: [] };
    throw error;
  }
}

async function readJsonIfExists(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readScoreStore({ jsonPath, sqlitePath }) {
  if (sqlitePath && fsSync.existsSync(sqlitePath)) {
    return {
      store: readScoreStoreFromSqlite(sqlitePath),
      source: "sqlite",
      path: sqlitePath,
    };
  }
  return {
    store: await readJsonIfExists(jsonPath, { scores: [] }),
    source: "json",
    path: jsonPath,
  };
}

async function readJsonlIfExists(filePath) {
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

function existsAt(repoRoot, maybeRelativePath) {
  const normalized = normalizePath(maybeRelativePath).trim();
  if (!normalized) return false;
  return fsSync.existsSync(path.resolve(repoRoot, normalized));
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = safeString(row[key] || "unknown", "unknown") || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function buildRowStatus({ repoRoot, manifestRow, cleanScoreRow, scoreIds }) {
  const recordingId = safeString(manifestRow.recordingId || cleanScoreRow?.recordingId);
  const pieceId = safeString(manifestRow.pieceId || cleanScoreRow?.pieceId);
  const scenario = safeString(manifestRow.scenario);
  const audioPath = normalizePath(manifestRow.audioPath || cleanScoreRow?.audioPath);
  const cleanScorePath = normalizePath(cleanScoreRow?.requiredCleanScorePath || manifestRow.scorePath);
  const manifestScorePath = normalizePath(manifestRow.scorePath);
  const scoreId = safeString(manifestRow.scoreId || cleanScoreRow?.scoreId).trim();
  const cleanScoreReviewStatus = safeString(cleanScoreRow?.cleanScoreReviewStatus).trim().toLowerCase();
  const audioExists = existsAt(repoRoot, audioPath);
  const cleanScoreExists = existsAt(repoRoot, cleanScorePath);
  const cleanScoreApproved = cleanScoreReviewStatus === "approved";
  const scoreIdInStore = Boolean(scoreId && scoreIds.has(scoreId));
  const needsScoreStoreImport = audioExists && cleanScoreApproved && cleanScoreExists && !scoreIdInStore;
  const readyForControlledSubmission = audioExists && cleanScoreApproved && cleanScoreExists && scoreIdInStore;
  const blockers = [
    audioExists ? "" : "audio-missing",
    cleanScoreApproved ? "" : "clean-score-not-approved",
    cleanScoreExists ? "" : "clean-score-file-missing",
    scoreIdInStore ? "" : "score-store-import-missing",
  ].filter(Boolean);
  return {
    recordingId,
    pieceId,
    scenario,
    audioPath,
    audioExists,
    manifestScorePath,
    cleanScorePath,
    cleanScoreReviewStatus,
    cleanScoreApproved,
    cleanScoreExists,
    scoreId,
    scoreIdInStore,
    needsScoreStoreImport,
    readyForControlledSubmission,
    blockers,
  };
}

function summarizeControlledData({ submissions, reviews, batchRuns }) {
  let offlineFeatureReviewItemCount = 0;
  let candidateRowsPathCount = 0;
  for (const run of batchRuns) {
    const items = Array.isArray(run.items) ? run.items : [];
    for (const item of items) {
      if (item?.analysisStatus === "offline_feature_review_ready") offlineFeatureReviewItemCount += 1;
      if (safeString(item?.candidateRowsPath)) candidateRowsPathCount += 1;
    }
  }
  return {
    submissions: submissions.length,
    reviews: reviews.length,
    batchRuns: batchRuns.length,
    offlineFeatureReviewItemCount,
    candidateRowsPathCount,
    candidateRowsReady: candidateRowsPathCount > 0,
  };
}

export async function buildControlledCandidateInputStatus({
  repoRoot = process.cwd(),
  manifestPath = path.join("data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv"),
  cleanScoreIntakePath = path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv"),
  scoreStorePath = path.join("data", "erhu-score-imports.json"),
  scoreStoreSqlitePath = path.join("data", "erhu-score-imports.sqlite"),
  controlledSubmissionsPath = path.join("data", "experiments", "western-strings-m3", "controlled-submissions.jsonl"),
  controlledReviewsPath = path.join("data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl"),
  controlledBatchRunsPath = path.join("data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"),
} = {}) {
  const resolvedManifestPath = path.resolve(repoRoot, manifestPath);
  const resolvedCleanScoreIntakePath = path.resolve(repoRoot, cleanScoreIntakePath);
  const resolvedScoreStorePath = path.resolve(repoRoot, scoreStorePath);
  const resolvedScoreStoreSqlitePath = path.resolve(repoRoot, scoreStoreSqlitePath);
  const manifest = await readCsvIfExists(resolvedManifestPath);
  const cleanScoreIntake = await readCsvIfExists(resolvedCleanScoreIntakePath);
  const scoreStoreRead = await readScoreStore({
    jsonPath: resolvedScoreStorePath,
    sqlitePath: resolvedScoreStoreSqlitePath,
  });
  const scoreStore = scoreStoreRead.store;
  const scoreIds = new Set((Array.isArray(scoreStore.scores) ? scoreStore.scores : []).map((score) => safeString(score.scoreId)).filter(Boolean));
  const cleanRowsByRecordingId = new Map(cleanScoreIntake.rows.map((row) => [safeString(row.recordingId), row]));
  const rows = manifest.rows.map((manifestRow) => buildRowStatus({
    repoRoot,
    manifestRow,
    cleanScoreRow: cleanRowsByRecordingId.get(safeString(manifestRow.recordingId)),
    scoreIds,
  }));

  const submissions = await readJsonlIfExists(path.resolve(repoRoot, controlledSubmissionsPath));
  const reviews = await readJsonlIfExists(path.resolve(repoRoot, controlledReviewsPath));
  const batchRuns = await readJsonlIfExists(path.resolve(repoRoot, controlledBatchRunsPath));
  const controlledData = summarizeControlledData({ submissions, reviews, batchRuns });
  const counts = {
    manifestRows: rows.length,
    audioReadyRows: rows.filter((row) => row.audioExists).length,
    cleanScoreApprovedRows: rows.filter((row) => row.cleanScoreApproved).length,
    cleanScoreFileReadyRows: rows.filter((row) => row.cleanScoreExists).length,
    scoreStoreReadyRows: rows.filter((row) => row.scoreIdInStore).length,
    needsScoreStoreImportRows: rows.filter((row) => row.needsScoreStoreImport).length,
    readyForControlledSubmissionRows: rows.filter((row) => row.readyForControlledSubmission).length,
  };
  const blockingReasons = [
    manifest.exists ? "" : "m2f-manifest-missing",
    cleanScoreIntake.exists ? "" : "clean-score-intake-missing",
    rows.length ? "" : "m2f-manifest-empty",
    counts.audioReadyRows === rows.length ? "" : "audio-missing",
    counts.cleanScoreApprovedRows === rows.length ? "" : "clean-score-not-approved",
    counts.cleanScoreFileReadyRows === rows.length ? "" : "clean-score-file-missing",
    counts.scoreStoreReadyRows === rows.length ? "" : "score-store-import-missing",
    controlledData.submissions > 0 ? "" : "controlled-submissions-empty",
    controlledData.candidateRowsReady ? "" : "controlled-candidate-rows-missing",
  ].filter(Boolean);
  const nextActions = [];
  if (blockingReasons.includes("score-store-import-missing")) {
    nextActions.push("Import approved clean-score MXL/MusicXML/MIDI files into the score store, then write scoreId back to the M2f manifest/intake.");
  }
  if (blockingReasons.includes("controlled-submissions-empty")) {
    nextActions.push("Create or accept controlled clean-score+audio submissions after scoreIds are available.");
  }
  if (blockingReasons.includes("controlled-candidate-rows-missing")) {
    nextActions.push("Run the controlled-submission batch and export candidate rows only after submissions exist.");
  }
  if (!nextActions.length) {
    nextActions.push("Inputs are ready for candidate review export and calibration.");
  }
  return {
    ok: true,
    readyForCandidateReview: blockingReasons.length === 0,
    paths: {
      manifest: path.relative(repoRoot, resolvedManifestPath).replace(/\\/g, "/"),
      cleanScoreIntake: path.relative(repoRoot, resolvedCleanScoreIntakePath).replace(/\\/g, "/"),
      scoreStore: path.relative(repoRoot, resolvedScoreStorePath).replace(/\\/g, "/"),
      scoreStoreSqlite: path.relative(repoRoot, resolvedScoreStoreSqlitePath).replace(/\\/g, "/"),
    },
    exists: {
      manifest: manifest.exists,
      cleanScoreIntake: cleanScoreIntake.exists,
      scoreStore: fsSync.existsSync(resolvedScoreStorePath),
      scoreStoreSqlite: fsSync.existsSync(resolvedScoreStoreSqlitePath),
    },
    scoreStoreSource: scoreStoreRead.source,
    counts,
    scenarioCounts: countBy(rows, "scenario"),
    controlledData,
    blockingReasons,
    nextActions,
    rows,
  };
}

function toCsv(rows) {
  const headers = [
    "recordingId",
    "pieceId",
    "scenario",
    "audioPath",
    "audioExists",
    "cleanScorePath",
    "cleanScoreApproved",
    "cleanScoreExists",
    "scoreId",
    "scoreIdInStore",
    "needsScoreStoreImport",
    "readyForControlledSubmission",
    "blockers",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => {
      if (header === "blockers") return csvEscape(row.blockers.join("|"));
      return csvEscape(row[header]);
    }).join(",")),
  ].join("\n") + "\n";
}

function parseArgs(argv) {
  const args = {
    manifest: path.join("data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv"),
    cleanScoreIntake: path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv"),
    scoreStore: path.join("data", "erhu-score-imports.json"),
    scoreStoreSqlite: path.join("data", "erhu-score-imports.sqlite"),
    out: path.join("data", "experiments", "western-strings-m3", "controlled-candidate-input-status.json"),
    outCsv: "",
    failOnNotReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (arg === "--clean-score-intake") args.cleanScoreIntake = argv[++index] || args.cleanScoreIntake;
    else if (arg === "--score-store") args.scoreStore = argv[++index] || args.scoreStore;
    else if (arg === "--score-store-sqlite") args.scoreStoreSqlite = argv[++index] || args.scoreStoreSqlite;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--out-csv") args.outCsv = argv[++index] || args.outCsv;
    else if (arg === "--fail-on-not-ready") args.failOnNotReady = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await buildControlledCandidateInputStatus({
    manifestPath: args.manifest,
    cleanScoreIntakePath: args.cleanScoreIntake,
    scoreStorePath: args.scoreStore,
    scoreStoreSqlitePath: args.scoreStoreSqlite,
  });
  const outPath = path.resolve(process.cwd(), args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  if (args.outCsv) {
    const outCsvPath = path.resolve(process.cwd(), args.outCsv);
    await fs.mkdir(path.dirname(outCsvPath), { recursive: true });
    await fs.writeFile(outCsvPath, toCsv(status.rows), "utf8");
  }
  console.log(JSON.stringify({
    ok: status.ok,
    readyForCandidateReview: status.readyForCandidateReview,
    counts: status.counts,
    controlledData: status.controlledData,
    blockingReasons: status.blockingReasons,
    nextActions: status.nextActions,
    out: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
  }, null, 2));
  if (args.failOnNotReady && !status.readyForCandidateReview) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
