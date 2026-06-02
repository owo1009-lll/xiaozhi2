#!/usr/bin/env node
// Plan C generator: human-anchored short windows (manifest) -> teacher technique-
// labeling pack. No analyzer, no analysis-core change. For each humanMatched=yes row
// it writes a manual-anchor pass.json (scanMode "manual-anchor" + manualAnchorConfirmed)
// and a job, then reuses buildTeacherValidationPack (sources: manual-anchors) so the
// teacher-ready gate, audio clipping, and review/CSV serialization are all shared.
//
// Run:
//   node scripts/build-manual-anchor-pack.mjs \
//     --manifest data/teacher-manual-anchors/manifest.csv \
//     --output-dir data/teacher-validation/packs/manual-anchor-<date>
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  parseCsv, safeString, numeric, getArray, readJson, buildTeacherValidationPack,
} from "./teacher-validation-support.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANUAL_ROOT = path.join(REPO_ROOT, "data", "teacher-manual-anchors");

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    manifest: path.join(MANUAL_ROOT, "manifest.csv"),
    outputDir: "",
    raterId: "teacher-1",
    min: 1,
    max: 200,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") parsed.manifest = argv[++index];
    else if (arg === "--output-dir") parsed.outputDir = argv[++index];
    else if (arg === "--rater-id") parsed.raterId = argv[++index];
    else if (arg === "--min") parsed.min = Math.max(0, Number(argv[++index]) || parsed.min);
    else if (arg === "--max") parsed.max = Math.max(1, Number(argv[++index]) || parsed.max);
  }
  return parsed;
}

const REQUIRED_COLUMNS = [
  "pieceTitle", "sourceLongPiece", "sourceAudioPath", "scorePdfPath", "scoreId",
  "audioStartSeconds", "audioEndSeconds", "scorePage", "measureRange", "humanMatched",
];

function readManifestRows(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath} (see docs/teacher-manual-anchor-manifest.md)`);
  }
  // parseCsv returns an array of objects keyed by header.
  const rows = parseCsv(fs.readFileSync(manifestPath, "utf8"));
  if (!rows.length) throw new Error("manifest is empty");
  const headers = Object.keys(rows[0]);
  for (const column of REQUIRED_COLUMNS) {
    if (!headers.includes(column)) throw new Error(`manifest missing required column: ${column}`);
  }
  return rows.map((row) => {
    const trimmed = {};
    for (const [key, value] of Object.entries(row)) trimmed[key] = safeString(value).trim();
    return trimmed;
  });
}

function slug(value) {
  return safeString(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";
}

function resolveInputPath(filePath) {
  const text = safeString(filePath).trim();
  if (!text) return "";
  if (path.isAbsolute(text)) return text;
  if (text.startsWith("/data/")) return path.resolve(REPO_ROOT, text.slice(1));
  return path.resolve(REPO_ROOT, text);
}

function assertExistingInput(filePath, label, index) {
  const absolute = resolveInputPath(filePath);
  if (!absolute || !fs.existsSync(absolute)) {
    throw new Error(`row ${index + 1}: ${label} not found: ${filePath}`);
  }
  return absolute;
}

function loadScoreIds() {
  const store = readJson(path.join(REPO_ROOT, "data", "erhu-score-imports.json"), {});
  return new Set(getArray(store.scores).map((score) => safeString(score.scoreId)).filter(Boolean));
}

function formatPageId(scorePage) {
  const pageNumber = Number(scorePage);
  if (!Number.isFinite(pageNumber) || pageNumber <= 0) return "";
  return String(Math.round(pageNumber)).padStart(2, "0");
}

function validateMatchedRow(row, index, scoreIds) {
  for (const column of REQUIRED_COLUMNS) {
    if (!safeString(row[column]).trim()) throw new Error(`row ${index + 1}: missing required value ${column}`);
  }
  if (!scoreIds.has(row.scoreId)) throw new Error(`row ${index + 1}: scoreId not found in score store: ${row.scoreId}`);
  assertExistingInput(row.sourceAudioPath, "sourceAudioPath", index);
  assertExistingInput(row.scorePdfPath, "scorePdfPath", index);
  const start = numeric(row.audioStartSeconds);
  const end = numeric(row.audioEndSeconds);
  if (start == null || end == null || end <= start) {
    throw new Error(`row ${index + 1}: invalid audio window ${row.audioStartSeconds}..${row.audioEndSeconds}`);
  }
  if (!formatPageId(row.scorePage)) throw new Error(`row ${index + 1}: scorePage must be a positive page number`);
  return { start, end };
}

function buildJobAndPass(row, index) {
  const start = numeric(row.audioStartSeconds);
  const end = numeric(row.audioEndSeconds);
  if (start == null || end == null || end <= start) {
    throw new Error(`row ${index + 1}: invalid audio window ${row.audioStartSeconds}..${row.audioEndSeconds}`);
  }
  const duration = Number((end - start).toFixed(3));
  // Keep the page-XX token so the existing score locator resolves to the intended PDF page.
  const sectionId = `page-${formatPageId(row.scorePage)}-manual-m${slug(row.measureRange)}-${index}`;
  const sectionTitle = `第${safeString(row.scorePage)}页 m${safeString(row.measureRange)}${row.phraseNote ? ` ${row.phraseNote}` : ""}`.trim();
  const audioHash = crypto.createHash("sha1")
    .update(`${row.sourceAudioPath}|${start}|${end}|${row.scoreId}`).digest("hex");
  const jobId = `manual-${slug(row.sourceLongPiece || row.pieceTitle)}-${index}`;
  const audioCoverage = {
    scanMode: "manual-anchor",
    manualAnchorConfirmed: row.humanMatched.toLowerCase() === "yes",
    audioDurationSeconds: duration,
  };
  const passJson = {
    schemaVersion: 1,
    scoreId: row.scoreId,
    summary: { audioCoverage },
    sectionPasses: [{
      sectionId,
      sectionTitle,
      scorePage: Number(row.scorePage),
      measureRange: row.measureRange,
      phraseNote: row.phraseNote || "",
      manualAnchor: true,
      sequenceIndex: 0,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: duration,
      noteFindings: [],
      measureFindings: [],
    }],
  };
  const passDir = path.join(MANUAL_ROOT, "generated", jobId);
  const passJsonPath = path.join(passDir, "pass.json");
  const job = {
    jobId,
    status: "completed",
    scoreId: row.scoreId,
    pieceId: row.scoreId,
    pieceTitle: row.pieceTitle,
    audioHash,
    audioPath: row.sourceAudioPath,
    pdfPath: row.scorePdfPath,
    passJsonPath: path.relative(REPO_ROOT, passJsonPath).split(path.sep).join("/"),
    summary: { audioCoverage },
    sourceLongPiece: row.sourceLongPiece,
    scorePdfPath: row.scorePdfPath,
  };
  return { job, passJson, passDir, passJsonPath };
}

async function main() {
  const args = parseArgs();
  const allRows = readManifestRows(args.manifest);
  const matched = allRows.filter((row) => safeString(row.humanMatched).toLowerCase() === "yes");
  const skipped = allRows.length - matched.length;
  if (!matched.length) {
    throw new Error(`no rows with humanMatched=yes in ${args.manifest} (rows total: ${allRows.length})`);
  }
  const scoreIds = loadScoreIds();
  matched.forEach((row, index) => validateMatchedRow(row, index, scoreIds));

  const jobs = [];
  for (const [index, row] of matched.entries()) {
    const { job, passJson, passDir, passJsonPath } = buildJobAndPass(row, index);
    await fsp.mkdir(passDir, { recursive: true });
    await fsp.writeFile(passJsonPath, JSON.stringify(passJson, null, 2), "utf8");
    jobs.push(job);
  }
  const jobsStorePath = path.join(MANUAL_ROOT, "manual-anchor-jobs.json");
  await fsp.writeFile(jobsStorePath, JSON.stringify({ schemaVersion: 1, jobs }, null, 2), "utf8");

  const outputDir = args.outputDir
    ? path.resolve(REPO_ROOT, args.outputDir)
    : path.join(REPO_ROOT, "data", "teacher-validation", "packs", `manual-anchor-${new Date().toISOString().slice(0, 10)}`);

  const result = await buildTeacherValidationPack({
    repoRoot: REPO_ROOT,
    outputDir,
    unit: "section",
    sources: "manual-anchors",
    reviewMode: "technique-labeling",
    extractAudio: true,
    requireTrustedAlignment: true,
    requireTeacherReadyTrusted: true,
    min: args.min,
    max: args.max,
    raterId: args.raterId,
  });

  console.log(JSON.stringify({
    ok: true,
    manifestRows: allRows.length,
    matchedRows: matched.length,
    skippedRows: skipped,
    generatedJobs: jobs.length,
    selectedCount: result.manifest.selectedCount,
    warnings: result.manifest.warnings,
    outputDir: path.relative(REPO_ROOT, result.outputDir).split(path.sep).join("/"),
  }, null, 2));
  if (result.manifest.selectedCount < matched.length) {
    console.error(`WARNING: ${matched.length - result.manifest.selectedCount} matched row(s) did not become teacher-ready candidates.`);
  }
  const expectedSelected = Math.min(matched.length, args.max);
  const audioSkipped = getArray(result.manifest.warnings).filter((warning) => safeString(warning).includes("audio clip skipped"));
  if (result.manifest.selectedCount !== expectedSelected || audioSkipped.length) {
    throw new Error(`manual-anchor pack failed readiness checks: selected=${result.manifest.selectedCount}/${expectedSelected}; audioSkipped=${audioSkipped.length}`);
  }
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
