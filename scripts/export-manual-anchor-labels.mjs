#!/usr/bin/env node
// Phase 2c: export the SEGMENT-LEVEL technique labels a teacher has already entered in
// the backend (manual-anchor / technique-labeling packs) into a training dataset.
//
// This is distinct from export-technique-labeling-dataset.mjs (which emits empty
// per-note feature rows FOR a teacher to fill). Here the labels already exist in each
// pack's teacher-review-template.json; we join them with the manifest items and emit
// the captured segment labels.
//
// Enforced training-set rules (mismatched / excluded samples NEVER reach the set):
//   - reviewStatus must be "complete"
//   - includeInBaseline === "no"        -> excluded
//   - teacherMatchStatus === "mismatch" -> excluded
//
// Usage:
//   node scripts/export-manual-anchor-labels.mjs [--pack <packId>] [--output-dir DIR]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, getArray, safeString, numeric, toCsv } from "./teacher-validation-support.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKS_DIR = path.join(REPO_ROOT, "data", "teacher-validation", "packs");
const DEFAULT_OUTPUT_ROOT = path.join("data", "teacher-validation", "technique-labeling-export");

const ROW_KEYS = [
  "packId", "caseId", "pieceTitle", "sectionId", "sectionTitle",
  "sourceAudioPath", "audioStartSeconds", "audioEndSeconds",
  "teacherMatchStatus", "teacherTechniqueTags", "teacherTechniqueConfidence",
  "teacherTechniqueUncertain", "overallAgreement", "teacherPrimaryPath", "comments",
];

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = { pack: "", outputDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pack") parsed.pack = safeString(argv[++index]);
    else if (arg === "--output-dir") parsed.outputDir = path.resolve(REPO_ROOT, argv[++index] || "");
  }
  if (!parsed.outputDir) {
    parsed.outputDir = path.join(REPO_ROOT, DEFAULT_OUTPUT_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  }
  return parsed;
}

function listTechniqueLabelingPacks(packFilter) {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((packId) => !packFilter || packId === packFilter)
    .filter((packId) => {
      const manifest = readJson(path.join(PACKS_DIR, packId, "manifest.json"), null);
      return manifest && safeString(manifest.reviewMode) === "technique-labeling";
    });
}

function exportPack(packId, stats) {
  const packDir = path.join(PACKS_DIR, packId);
  const manifest = readJson(path.join(packDir, "manifest.json"), { items: [] });
  const reviewsPayload = readJson(path.join(packDir, "teacher-review-template.json"), { reviews: [] });
  const reviewByCase = new Map(getArray(reviewsPayload.reviews).map((row) => [safeString(row.caseId), row]));

  const rows = [];
  for (const item of getArray(manifest.items)) {
    const caseId = safeString(item.caseId);
    const review = reviewByCase.get(caseId) || {};
    stats.totalReviewed += safeString(review.reviewStatus).toLowerCase() === "complete" ? 1 : 0;
    // --- enforced exclusion rules (mismatch is authoritative -> checked first) ---
    if (safeString(review.reviewStatus).toLowerCase() !== "complete") { stats.skippedPending += 1; continue; }
    if (safeString(review.teacherMatchStatus).toLowerCase() === "mismatch") { stats.excludedMismatch += 1; continue; }
    if (safeString(review.includeInBaseline).toLowerCase() === "no") { stats.excludedNotIncluded += 1; continue; }

    rows.push({
      packId,
      caseId,
      pieceTitle: safeString(item.title || item.pieceTitle),
      sectionId: safeString(item.sectionId),
      sectionTitle: safeString(item.sectionTitle),
      sourceAudioPath: safeString(item.sourceAudioPath),
      audioStartSeconds: numeric(item.audioSegment?.startSeconds) ?? "",
      audioEndSeconds: numeric(item.audioSegment?.endSeconds) ?? "",
      teacherMatchStatus: safeString(review.teacherMatchStatus),
      teacherTechniqueTags: safeString(review.teacherTechniqueTags),
      teacherTechniqueConfidence: review.teacherTechniqueConfidence ?? "",
      teacherTechniqueUncertain: safeString(review.teacherTechniqueUncertain),
      overallAgreement: review.overallAgreement ?? "",
      teacherPrimaryPath: safeString(review.teacherPrimaryPath),
      comments: safeString(review.comments),
    });
  }
  return rows;
}

function main() {
  const options = parseArgs();
  const packs = listTechniqueLabelingPacks(options.pack);
  const stats = { packCount: packs.length, totalReviewed: 0, skippedPending: 0, excludedNotIncluded: 0, excludedMismatch: 0 };
  const rows = packs.flatMap((packId) => exportPack(packId, stats));
  // stable key order for CSV header even if a row omits a key
  const orderedRows = rows.map((row) => Object.fromEntries(ROW_KEYS.map((key) => [key, row[key] ?? ""])));

  fs.mkdirSync(options.outputDir, { recursive: true });
  const csvPath = path.join(options.outputDir, "manual-anchor-labels.csv");
  const jsonPath = path.join(options.outputDir, "manual-anchor-labels.json");
  fs.writeFileSync(csvPath, toCsv(orderedRows), "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    schemaDoc: "docs/erhu-technique-labeling-schema.md",
    level: "segment",
    exclusionRules: ["reviewStatus!=complete", "includeInBaseline=no", "teacherMatchStatus=mismatch"],
    packs,
    exportedRowCount: orderedRows.length,
    stats,
    rows: orderedRows,
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    outputDir: path.relative(REPO_ROOT, options.outputDir),
    packCount: stats.packCount,
    exportedRowCount: orderedRows.length,
    excludedMismatch: stats.excludedMismatch,
    excludedNotIncluded: stats.excludedNotIncluded,
    skippedPending: stats.skippedPending,
  }, null, 2));
}

main();
