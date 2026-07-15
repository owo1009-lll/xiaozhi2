import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readScoreStoreFromSqlite } from "../src/server/scoreStoreSqlite.js";

const DEFAULT_INTAKE = path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv");
const DEFAULT_JSON_STORE = path.join("data", "erhu-score-imports.json");
const DEFAULT_SQLITE_STORE = path.join("data", "erhu-score-imports.sqlite");
const DEFAULT_OUT = path.join("data", "experiments", "western-strings-m4", "omr-readiness.json");
const DEFAULT_CSV_OUT = path.join("data", "experiments", "western-strings-m4", "omr-readiness.csv");

function parseArgs(argv) {
  const args = {
    intake: DEFAULT_INTAKE,
    jsonStore: DEFAULT_JSON_STORE,
    sqliteStore: DEFAULT_SQLITE_STORE,
    out: DEFAULT_OUT,
    csvOut: DEFAULT_CSV_OUT,
    minPairs: 10,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--intake") args.intake = argv[++index] || args.intake;
    else if (arg === "--json-store") args.jsonStore = argv[++index] || args.jsonStore;
    else if (arg === "--sqlite-store") args.sqliteStore = argv[++index] || args.sqliteStore;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--csv-out") args.csvOut = argv[++index] || args.csvOut;
    else if (arg === "--min-pairs") args.minPairs = Number(argv[++index] || args.minPairs);
  }
  return args;
}

function splitCsvLine(line) {
  const cols = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cols.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols;
}

async function readCsv(filePath) {
  const text = await fs.readFile(path.resolve(process.cwd(), filePath), "utf8");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const headers = splitCsvLine(lines.shift());
  return lines.map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] || "";
    });
    return row;
  });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8"));
  } catch {
    return fallback;
  }
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(filePath, rows, columns) {
  await fs.mkdir(path.dirname(path.resolve(process.cwd(), filePath)), { recursive: true });
  const text = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ].join("\n") + "\n";
  await fs.writeFile(path.resolve(process.cwd(), filePath), text, "utf8");
}

function normalizeRel(value) {
  return String(value || "").replace(/\\/g, "/").trim();
}

function existsRepoPath(value) {
  const normalized = normalizeRel(value);
  if (!normalized) return false;
  return fsSync.existsSync(path.resolve(process.cwd(), normalized));
}

function isImageOrPdf(value) {
  return /\.(jpg|jpeg|png|webp|pdf)$/i.test(normalizeRel(value));
}

function isCleanScore(value) {
  return /\.(mxl|musicxml|xml|mid|midi)$/i.test(normalizeRel(value));
}

async function loadScoreIds(args) {
  if (args.sqliteStore && fsSync.existsSync(path.resolve(process.cwd(), args.sqliteStore))) {
    try {
      const store = readScoreStoreFromSqlite(path.resolve(process.cwd(), args.sqliteStore));
      return new Set((store.scores || []).map((score) => String(score.scoreId || "")).filter(Boolean));
    } catch {
      // Fall through to JSON store.
    }
  }
  const store = await readJson(args.jsonStore, { scores: [] });
  return new Set((store.scores || []).map((score) => String(score.scoreId || "")).filter(Boolean));
}

function evaluateRow(row, scoreIds) {
  const sourcePath = normalizeRel(row.currentScorePath);
  const goldPath = normalizeRel(row.requiredCleanScorePath);
  const scoreId = String(row.scoreId || "").trim();
  const cleanStatus = String(row.cleanScoreReviewStatus || "").trim().toLowerCase();
  const sourceExists = existsRepoPath(sourcePath);
  const goldExists = existsRepoPath(goldPath);
  const scoreIdExists = Boolean(scoreId && scoreIds.has(scoreId));
  const sourceIsImageOrPdf = isImageOrPdf(sourcePath);
  const goldIsCleanScore = isCleanScore(goldPath);
  const approved = cleanStatus === "approved";
  const reasons = [
    sourcePath ? "" : "source-score-path-missing",
    sourceExists ? "" : "source-score-file-missing",
    sourceIsImageOrPdf ? "" : "source-score-not-image-or-pdf",
    goldPath ? "" : "gold-clean-score-path-missing",
    goldExists ? "" : "gold-clean-score-file-missing",
    goldIsCleanScore ? "" : "gold-clean-score-not-musicxml-or-midi",
    approved ? "" : "clean-score-not-approved",
    scoreId ? "" : "score-id-missing",
    scoreIdExists ? "" : "score-id-not-in-store",
  ].filter(Boolean);
  return {
    recordingId: row.recordingId || "",
    pieceId: row.pieceId || "",
    scoreId,
    sourceScorePath: sourcePath,
    sourceScoreType: row.currentScoreType || "",
    goldCleanScorePath: goldPath,
    cleanScoreReviewStatus: row.cleanScoreReviewStatus || "",
    sourceExists,
    goldExists,
    sourceIsImageOrPdf,
    goldIsCleanScore,
    scoreIdExists,
    approved,
    omrBenchmarkPairReady: reasons.length === 0,
    blockingReasons: reasons.join("|"),
  };
}

async function buildReport(args) {
  const rows = await readCsv(args.intake);
  const scoreIds = await loadScoreIds(args);
  const evaluatedRows = rows.map((row) => evaluateRow(row, scoreIds));
  const pairReadyRows = evaluatedRows.filter((row) => row.omrBenchmarkPairReady);
  const reasonCounts = {};
  for (const row of evaluatedRows) {
    for (const reason of String(row.blockingReasons || "").split("|").filter(Boolean)) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  const m4OmrBenchmarkDatasetReady = pairReadyRows.length >= Number(args.minPairs) && pairReadyRows.length === evaluatedRows.length;
  const report = {
    ok: true,
    gate: {
      name: "western-strings-m4-omr-readiness",
      m4OmrBenchmarkDatasetReady,
      studentGateReady: false,
      reason: "omr-benchmark-readiness-only",
      runtimeEffect: "none",
    },
    thresholds: {
      minPairs: Number(args.minPairs),
      requireAllRowsReady: true,
    },
    counts: {
      intakeRows: evaluatedRows.length,
      pairReadyRows: pairReadyRows.length,
      blockedRows: evaluatedRows.length - pairReadyRows.length,
      scoreStoreScoreIdCount: scoreIds.size,
    },
    reasonCounts,
    artifacts: {
      intake: normalizeRel(args.intake),
      csv: normalizeRel(args.csvOut),
      json: normalizeRel(args.out),
    },
    nextActions: m4OmrBenchmarkDatasetReady
      ? [
          "M4 OMR benchmark dataset is ready. Compare pitch, onset, and measure structure against frozen independent gold before changing any runtime OMR policy; pitch-only success is insufficient.",
          "Keep OMR out of runtime diagnosis until note-level OMR accuracy gates are implemented and passed.",
        ]
      : [
          "Fix blocked rows before running OMR benchmark.",
          "Keep OMR out of runtime diagnosis.",
        ],
    rows: evaluatedRows,
  };
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport(args);
  await fs.mkdir(path.dirname(path.resolve(process.cwd(), args.out)), { recursive: true });
  await fs.writeFile(path.resolve(process.cwd(), args.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeCsv(args.csvOut, report.rows, [
    "recordingId",
    "pieceId",
    "scoreId",
    "sourceScorePath",
    "sourceScoreType",
    "goldCleanScorePath",
    "cleanScoreReviewStatus",
    "sourceExists",
    "goldExists",
    "sourceIsImageOrPdf",
    "goldIsCleanScore",
    "scoreIdExists",
    "approved",
    "omrBenchmarkPairReady",
    "blockingReasons",
  ]);
  console.log(JSON.stringify({
    ok: report.ok,
    gate: report.gate,
    counts: report.counts,
    reasonCounts: report.reasonCounts,
    artifacts: report.artifacts,
    nextActions: report.nextActions,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
