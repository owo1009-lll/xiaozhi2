import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotateImportedSectionsScoreLineRoles,
  buildScoreLineStatsFromSections,
  effectiveSelectedPartConfidence,
} from "../src/server/scoreLineRoles.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const inputPath = path.join(repoRoot, "data", "erhu-score-imports.json");
const outputDir = path.join(repoRoot, "data", "real-tests", "omr-provider-selection");
const outputPath = path.join(outputDir, "latest-provider-candidates.json");

const thresholds = {
  omrConfidence: numberFromEnv("ERHU_OMR_SECONDARY_LOW_CONFIDENCE_THRESHOLD", 0.8),
  selectedPartConfidence: numberFromEnv("ERHU_OMR_SECONDARY_LOW_PART_CONFIDENCE_THRESHOLD", 0.85),
  erhuRatio: numberFromEnv("ERHU_OMR_SECONDARY_LOW_ERHU_RATIO_THRESHOLD", 0.5),
  erhuPageCoverage: numberFromEnv("ERHU_OMR_SECONDARY_LOW_ERHU_PAGE_COVERAGE_THRESHOLD", 0.72),
};

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function scoreKey(score) {
  return String(score.pdfHash || score.sourcePdfPath || score.scoreId || "").trim();
}

function updatedAtMs(score) {
  const ms = Date.parse(String(score.updatedAt || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function selectLatestScores(scores) {
  const selected = new Map();
  for (const score of scores) {
    const key = scoreKey(score);
    if (!key) continue;
    const existing = selected.get(key);
    if (!existing || updatedAtMs(score) >= updatedAtMs(existing)) {
      selected.set(key, score);
    }
  }
  return Array.from(selected.values());
}

function candidateReasons(score) {
  const omrConfidence = numberValue(score.omrConfidence);
  const sections = annotateImportedSectionsScoreLineRoles(score.sections || [], score);
  const selectedPartConfidence = effectiveSelectedPartConfidence(score.selectedPartConfidence, sections);
  const scoreLineStats = buildScoreLineStatsFromSections(sections);
  const noteCount = numberValue(scoreLineStats.noteCount);
  const erhuRatio = numberValue(scoreLineStats.erhuRatio);
  const erhuMeasureCoverage = numberValue(scoreLineStats.erhuMeasureCoverage);
  const erhuPageCoverage = numberValue(scoreLineStats.erhuPageCoverage);
  const reasons = [];

  if (String(score.omrStatus || "") !== "completed") {
    reasons.push("primary-import-not-completed");
  }
  if (omrConfidence < thresholds.omrConfidence) {
    reasons.push("low-omr-confidence");
  }
  if (selectedPartConfidence < thresholds.selectedPartConfidence) {
    reasons.push("low-selected-part-confidence");
  }
  if (noteCount > 0 && erhuRatio < thresholds.erhuRatio && erhuPageCoverage < thresholds.erhuPageCoverage) {
    reasons.push("low-erhu-line-ratio");
  }

  return {
    reasons,
    omrConfidence,
    selectedPartConfidence,
    erhuRatio,
    erhuMeasureCoverage,
    erhuPageCoverage,
    noteCount,
    sectionCount: Array.isArray(score.sections) ? score.sections.length : 0,
    pageCount: numberValue(score.omrStats?.pageCount),
  };
}

function main() {
  const store = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const scores = selectLatestScores(Array.isArray(store.scores) ? store.scores : []);
  const candidates = [];
  const actionableCandidates = [];
  const legacyCandidates = [];
  const clean = [];

  for (const score of scores) {
    const diagnostics = candidateReasons(score);
    const row = {
      scoreId: score.scoreId || "",
      title: score.title || "",
      sourcePdfPath: score.sourcePdfPath || "",
      pdfHash: score.pdfHash || "",
      ...diagnostics,
    };
    if (diagnostics.reasons.length) {
      candidates.push(row);
      if (diagnostics.pageCount > 0 && diagnostics.noteCount > 0) {
        actionableCandidates.push(row);
      } else {
        legacyCandidates.push(row);
      }
    } else {
      clean.push(row);
    }
  }

  const sortCandidates = (rows) => rows.sort((left, right) => {
    const reasonDelta = right.reasons.length - left.reasons.length;
    if (reasonDelta) return reasonDelta;
    return left.title.localeCompare(right.title, "zh-Hans-CN");
  });
  sortCandidates(candidates);
  sortCandidates(actionableCandidates);
  sortCandidates(legacyCandidates);

  const report = {
    createdAt: new Date().toISOString(),
    thresholds,
    scoreCount: scores.length,
    candidateCount: candidates.length,
    actionableCandidateCount: actionableCandidates.length,
    legacyCandidateCount: legacyCandidates.length,
    cleanCount: clean.length,
    reasonCounts: candidates.reduce((counts, candidate) => {
      for (const reason of candidate.reasons) {
        counts[reason] = (counts[reason] || 0) + 1;
      }
      return counts;
    }, {}),
    actionableCandidates,
    legacyCandidates,
    candidates,
    clean,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    outputPath: path.relative(repoRoot, outputPath),
    scoreCount: report.scoreCount,
    candidateCount: report.candidateCount,
    actionableCandidateCount: report.actionableCandidateCount,
    legacyCandidateCount: report.legacyCandidateCount,
    cleanCount: report.cleanCount,
    reasonCounts: report.reasonCounts,
    topCandidates: actionableCandidates.slice(0, 8).map((candidate) => ({
      title: candidate.title,
      reasons: candidate.reasons,
      omrConfidence: candidate.omrConfidence,
      selectedPartConfidence: candidate.selectedPartConfidence,
      erhuRatio: candidate.erhuRatio,
      erhuPageCoverage: candidate.erhuPageCoverage,
    })),
  }, null, 2));
}

main();
