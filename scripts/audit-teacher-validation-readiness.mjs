import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { buildQualitySnapshot } from "./quality-baseline-support.mjs";
import {
  REPO_ROOT,
  collectTeacherValidationCandidates,
  readJson,
  selectTeacherValidationCandidates,
} from "./teacher-validation-support.mjs";

function getArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function listPackDirs(repoRoot) {
  const packRoot = path.join(repoRoot, "data", "teacher-validation", "packs");
  if (!fs.existsSync(packRoot)) return [];
  return fs.readdirSync(packRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packRoot, entry.name))
    .sort();
}

function summarizePack(packDir) {
  const manifest = readJson(path.join(packDir, "manifest.json"), {});
  const reviewTemplate = readJson(path.join(packDir, "teacher-review-template.json"), {});
  const rows = getArray(reviewTemplate.reviews || reviewTemplate);
  return {
    packDir: path.relative(REPO_ROOT, packDir).replace(/\\/g, "/"),
    selectedCount: Number(manifest.selectedCount) || rows.length || 0,
    pendingReviewCount: rows.filter((row) => String(row?.reviewStatus || "pending").toLowerCase() !== "complete").length,
    completedReviewCount: rows.filter((row) => String(row?.reviewStatus || "").toLowerCase() === "complete").length,
    warnings: getArray(manifest.warnings),
  };
}

const repoRoot = path.resolve(getArg("--repo-root", REPO_ROOT));
const minReviews = Math.max(1, Math.round(Number(getArg("--min-reviews", process.env.ERHU_TEACHER_VALIDATION_MIN_REVIEWS || 30)) || 30));
const snapshot = buildQualitySnapshot({ repoRoot });
const allCandidates = collectTeacherValidationCandidates({ repoRoot, unit: "section", sources: "all" });
const trustedCandidates = selectTeacherValidationCandidates(allCandidates, {
  max: allCandidates.length,
  minSystemFindings: 0,
  requireTrustedAlignment: true,
});
const issueCandidates = selectTeacherValidationCandidates(allCandidates, {
  max: allCandidates.length,
  minSystemFindings: 1,
  requireTrustedAlignment: true,
});
// teacher-ready is the stricter gate that actually decides what a teacher can be
// shown (scanModeTrusted AND duration-scale sane AND no severe window overlap AND
// >=1 finding). trusted* counts above only mean "analyzer-backed scan" and can be
// far higher than teacher-ready -- report both so the audit does not imply there
// are usable samples when there are none.
const teacherReadyCandidates = selectTeacherValidationCandidates(allCandidates, {
  max: allCandidates.length,
  minSystemFindings: 0,
  requireTrustedAlignment: true,
  requireTeacherReadyTrusted: true,
});
const teacherReadyIssueCandidates = selectTeacherValidationCandidates(allCandidates, {
  max: allCandidates.length,
  minSystemFindings: 1,
  requireTrustedAlignment: true,
  requireTeacherReadyTrusted: true,
});
const rejectedNotTeacherReady = trustedCandidates.filter(
  (candidate) => candidate.alignmentEvidence?.teacherReadyTrusted !== true,
);
const teacherReadyReasonCounts = {};
for (const candidate of rejectedNotTeacherReady) {
  for (const reason of getArray(candidate.alignmentEvidence?.teacherReadyReasons)) {
    const key = String(reason).split(":")[0];
    teacherReadyReasonCounts[key] = (teacherReadyReasonCounts[key] || 0) + 1;
  }
}
const packs = listPackDirs(repoRoot).map(summarizePack);
const latestPack = packs[packs.length - 1] || null;
const validation = snapshot.validation;
const ready = validation.reviewCount >= minReviews && validation.validatedAnalysisCount > 0;
const payload = {
  ok: true,
  ready,
  evidenceUsableForPaper: ready,
  thresholds: { minReviews },
  validation,
  candidatePool: {
    allCandidateCount: allCandidates.length,
    trustedCandidateCount: trustedCandidates.length,
    trustedIssueCandidateCount: issueCandidates.length,
    teacherReadyCandidateCount: teacherReadyCandidates.length,
    teacherReadyIssueCandidateCount: teacherReadyIssueCandidates.length,
    rejectedNotTeacherReadyCount: rejectedNotTeacherReady.length,
    teacherReadyReasonCounts,
  },
  packs: {
    packCount: packs.length,
    latestPack,
  },
  nextAction: ready
    ? "teacher validation evidence is ready for quality claims"
    : `collect and import at least ${Math.max(0, minReviews - validation.reviewCount)} more completed teacher review(s) before using validation metrics as paper evidence`,
};

const outputPath = path.join(repoRoot, "data", "real-tests", "teacher-validation-readiness", "latest-teacher-validation-readiness.json");
await fsp.mkdir(path.dirname(outputPath), { recursive: true });
await fsp.writeFile(outputPath, `${JSON.stringify({ ...payload, outputPath: path.relative(repoRoot, outputPath).replace(/\\/g, "/") }, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...payload, outputPath: path.relative(repoRoot, outputPath).replace(/\\/g, "/") }, null, 2));
