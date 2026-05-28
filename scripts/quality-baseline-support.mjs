import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const clean = values.map(numeric).filter((value) => value != null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function ratio(values) {
  const clean = values.filter((value) => value === true || value === false);
  return clean.length ? clean.filter(Boolean).length / clean.length : null;
}

function percentile(values, percent) {
  const clean = values.map(numeric).filter((value) => value != null).sort((left, right) => left - right);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((percent / 100) * clean.length) - 1));
  return clean[index];
}

function round(value, digits = 3) {
  const number = numeric(value);
  if (number == null) return null;
  return Number(number.toFixed(digits));
}

function complement(value) {
  const number = numeric(value);
  return number == null ? null : 1 - number;
}

function sectionCountForResult(result) {
  return numeric(result?.checks?.structuredSectionCount ?? result?.piecePassJob?.summary?.structuredSectionCount) || 0;
}

function cacheMissCountForResult(result) {
  return numeric(result?.checks?.sectionCacheMissCount ?? result?.piecePassJob?.summary?.sectionCacheMissCount) || 0;
}

function collectRunSummaryFiles(rootDir) {
  const files = [];
  function visit(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile() && entry.name === "run-summary.json") files.push(next);
    }
  }
  visit(rootDir);
  return files.sort();
}

function summarizeValidation(store = {}) {
  const reviews = getArray(store.validationReviews);
  const adjudications = getArray(store.adjudications);
  const validationAnalyses = new Set(reviews.map((item) => String(item?.analysisId || "")).filter(Boolean));
  return {
    ready: reviews.length > 0,
    reviewCount: reviews.length,
    adjudicationCount: adjudications.length,
    validatedAnalysisCount: validationAnalyses.size,
    averageOverallAgreement: round(average(reviews.map((item) => item.overallAgreement))),
    averageNotePrecision: round(average(reviews.map((item) => item.notePrecision))),
    averageNoteRecall: round(average(reviews.map((item) => item.noteRecall))),
    averageNoteF1: round(average(reviews.map((item) => item.noteF1))),
    noteFalsePositiveRate: round(complement(average(reviews.map((item) => item.notePrecision)))),
    averageMeasurePrecision: round(average(reviews.map((item) => item.measurePrecision))),
    averageMeasureRecall: round(average(reviews.map((item) => item.measureRecall))),
    averageMeasureF1: round(average(reviews.map((item) => item.measureF1))),
    measureFalsePositiveRate: round(complement(average(reviews.map((item) => item.measurePrecision)))),
    pathAgreementRate: round(ratio(reviews.map((item) => item.pathAgreement))),
  };
}

function summarizePerformance(corpusRoot) {
  const latencyBaselineMaxSections = Math.max(1, Math.round(Number(process.env.ERHU_QUALITY_MAX_BASELINE_SECTIONS || 12)));
  const summaries = collectRunSummaryFiles(corpusRoot).map((filePath) => readJson(filePath, null)).filter(Boolean);
  const completedResults = summaries.flatMap((summary) =>
    getArray(summary.results).filter((result) => String(result?.status || "") === "completed"),
  );
  const analysisMs = completedResults
    .map((result) => numeric(result?.checks?.analysisMs ?? result?.analysisMs ?? result?.piecePassJob?.durationMs))
    .filter((value) => value != null);
  const firstRunResults = completedResults.filter((result) => {
    const cacheMisses = cacheMissCountForResult(result);
    return cacheMisses > 0 || result?.piecePassJob?.summary?.cacheHits === 0;
  });
  const comparableFirstRunResults = firstRunResults.filter((result) =>
    sectionCountForResult(result) <= latencyBaselineMaxSections
  );
  const largeFirstRunResults = firstRunResults.filter((result) =>
    sectionCountForResult(result) > latencyBaselineMaxSections
  );
  const analysisTime = (result) => numeric(result?.checks?.analysisMs ?? result?.analysisMs ?? result?.piecePassJob?.durationMs);
  const firstRunAnalysisMs = comparableFirstRunResults.map(analysisTime).filter((value) => value != null);
  const largeFirstRunAnalysisMs = largeFirstRunResults.map(analysisTime).filter((value) => value != null);
  return {
    corpusRunCount: summaries.length,
    completedResultCount: completedResults.length,
    analysisMsP95: round(percentile(analysisMs, 95), 0),
    firstRunSampleCount: firstRunAnalysisMs.length,
    firstRunAnalysisMsP95: round(percentile(firstRunAnalysisMs, 95), 0),
    latencyBaselineMaxSections,
    largeFirstRunSampleCount: largeFirstRunAnalysisMs.length,
    largeFirstRunAnalysisMsP95: round(percentile(largeFirstRunAnalysisMs, 95), 0),
    p0FailureCount: summaries.reduce((sum, summary) => sum + Math.max(0, Math.round(Number(summary.p0FailureCount) || 0)), 0),
  };
}

export function buildQualitySnapshot({ repoRoot = REPO_ROOT } = {}) {
  const studyStorePath = path.join(repoRoot, "data", "erhu-study-records.json");
  const corpusRoot = path.join(repoRoot, "data", "real-tests", "corpus-runs");
  const store = readJson(studyStorePath, {});
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: {
      studyStore: path.relative(repoRoot, studyStorePath).replace(/\\/g, "/"),
      corpusRuns: path.relative(repoRoot, corpusRoot).replace(/\\/g, "/"),
    },
    validation: summarizeValidation(store),
    performance: summarizePerformance(corpusRoot),
  };
}

export function compareQualitySnapshot(current, baseline, { latencyTolerance = 1.1 } = {}) {
  const failures = [];
  const skipped = [];
  if (Number(baseline?.validation?.reviewCount || 0) > 0) {
    const metrics = [
      ["averageNoteF1", "decrease"],
      ["averageMeasureF1", "decrease"],
      ["pathAgreementRate", "decrease"],
      ["noteFalsePositiveRate", "increase"],
      ["measureFalsePositiveRate", "increase"],
    ];
    if (Number(current?.validation?.reviewCount || 0) < Number(baseline.validation.reviewCount || 0)) {
      failures.push(`validation review count regressed: current=${current.validation.reviewCount}, baseline=${baseline.validation.reviewCount}`);
    }
    for (const [metric, direction] of metrics) {
      const currentValue = numeric(current?.validation?.[metric]);
      const baselineValue = numeric(baseline?.validation?.[metric]);
      if (currentValue == null || baselineValue == null) continue;
      if (direction === "decrease" && currentValue + 0.001 < baselineValue) {
        failures.push(`${metric} regressed: current=${currentValue}, baseline=${baselineValue}`);
      }
      if (direction === "increase" && currentValue > baselineValue + 0.001) {
        failures.push(`${metric} regressed: current=${currentValue}, baseline=${baselineValue}`);
      }
    }
  } else {
    skipped.push("validation baseline has no teacher-reviewed samples yet");
  }

  const baselineP95 = numeric(baseline?.performance?.firstRunAnalysisMsP95);
  const currentP95 = numeric(current?.performance?.firstRunAnalysisMsP95);
  if (baselineP95 != null && Number(baseline?.performance?.firstRunSampleCount || 0) > 0) {
    if (currentP95 == null || Number(current?.performance?.firstRunSampleCount || 0) <= 0) {
      skipped.push("current run data has no first-run latency samples");
    } else if (currentP95 > baselineP95 * latencyTolerance) {
      failures.push(`first-run analysis p95 regressed: current=${currentP95}, baseline=${baselineP95}, tolerance=${latencyTolerance}`);
    }
  } else {
    skipped.push("performance baseline has no first-run latency samples yet");
  }

  return { ok: failures.length === 0, failures, skipped };
}
