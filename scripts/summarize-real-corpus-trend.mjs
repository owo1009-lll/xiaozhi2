import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = path.join(REPO_ROOT, "data", "real-tests", "corpus-runs");
const OUTPUT_ROOT = path.join(REPO_ROOT, "data", "real-tests", "corpus-trend");
const INFRA_FAILURE_PATTERN = /WinError 10061|ECONNREFUSED|ECONNRESET|connection refused|socket hang up|urlopen error|service check failed|python-analyzer-unreachable|analyzer(?: |-)unreachable/i;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    root: DEFAULT_ROOT,
    limit: 20,
    runOnly: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++index]) || args.limit);
    else if (arg === "--all") args.runOnly = false;
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function relativePath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
}

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sum(values = []) {
  return values.reduce((total, value) => total + numberValue(value, 0), 0);
}

function round(value, digits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function readRunSummary(filePath) {
  const summary = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const results = Array.isArray(summary.results) ? summary.results : [];
  const completed = results.filter((result) => result.status === "completed");
  const checks = results.map((result) => result.checks || {});
  const p0Failures = Array.isArray(summary.p0Failures) ? summary.p0Failures : [];
  const preflightText = JSON.stringify(summary.preflight?.failures || []);
  const preflightInfraFailure = INFRA_FAILURE_PATTERN.test(preflightText);
  const infraFailures = results.filter((result) => {
    const text = JSON.stringify([
      result.status,
      result.error,
      result.checks?.p0Failures,
      result.piecePassJob?.error,
      result.piecePassJob?.warnings,
    ]);
    return result.status === "failed" && INFRA_FAILURE_PATTERN.test(text);
  });
  const infraTitles = new Set(infraFailures.map((result) => result.title || ""));
  const productP0Failures = p0Failures.filter((failure) => !infraTitles.has(failure?.title || ""));
  const analysisTimes = checks.map((check) => numberValue(check.analysisMs, 0)).filter((value) => value > 0);
  const importTimes = checks.map((check) => numberValue(check.importMs, 0)).filter((value) => value > 0);
  const cacheMisses = sum(checks.map((check) => check.sectionCacheMissCount));
  const cacheHits = sum(checks.map((check) => check.sectionCacheHitCount));
  const attemptedSections = sum(checks.map((check) => check.attemptedSectionCount));
  const firstPassItems = checks.filter((check) => (
    numberValue(check.sectionCacheMissCount, 0) > 0
    && numberValue(check.sectionCacheHitRate, 0) < 0.5
  )).length;
  return {
    createdAt: summary.createdAt || path.basename(path.dirname(filePath)),
    sourcePath: relativePath(filePath),
    run: Boolean(summary.run),
    strict: Boolean(summary.strict),
    baseUrl: summary.baseUrl || "",
    pairCount: numberValue(summary.pairCount, (summary.pairs || []).length),
    completedCount: numberValue(summary.completedCount, completed.length),
    failedCount: numberValue(summary.failedCount, 0),
    p0FailureCount: numberValue(summary.p0FailureCount, 0),
    productP0FailureCount: productP0Failures.length,
    infraFailureCount: infraFailures.length + (preflightInfraFailure ? 1 : 0),
    infraFailures: [
      ...(preflightInfraFailure ? [{ title: "preflight", reason: "analyzer preflight failed" }] : []),
      ...infraFailures.map((result) => ({
        title: result.title || "",
        reason: String(result.piecePassJob?.error || result.error || result.piecePassJob?.warnings?.[0] || "infrastructure failure"),
      })),
    ],
    trendIncluded: !preflightInfraFailure && infraFailures.length === 0,
    performanceWarningCount: numberValue(summary.performanceWarningCount, 0),
    scoreIssueSmokeOk: summary.scoreIssueReviewSmoke?.ok ?? null,
    scoreIssueReviewItems: numberValue(summary.scoreIssueReview?.itemCount, 0),
    attemptedSections,
    sectionCacheHitCount: cacheHits,
    sectionCacheMissCount: cacheMisses,
    sectionCacheHitRate: attemptedSections > 0 ? round(cacheHits / Math.max(1, cacheHits + cacheMisses), 3) : null,
    firstPassItems,
    totalImportMs: sum(importTimes),
    totalAnalysisMs: sum(analysisTimes),
    maxAnalysisMs: analysisTimes.length ? Math.max(...analysisTimes) : 0,
    meanAnalysisMs: analysisTimes.length ? round(sum(analysisTimes) / analysisTimes.length, 1) : 0,
    pieces: completed.map((result) => ({
      title: result.title || "",
      status: result.status || "",
      importMs: numberValue(result.checks?.importMs, result.importMs),
      analysisMs: numberValue(result.checks?.analysisMs, result.analysisMs),
      attemptedSectionCount: numberValue(result.checks?.attemptedSectionCount, 0),
      sectionCacheHitCount: numberValue(result.checks?.sectionCacheHitCount, 0),
      sectionCacheMissCount: numberValue(result.checks?.sectionCacheMissCount, 0),
      sectionCacheHitRate: numberValue(result.checks?.sectionCacheHitRate, 0),
      p0Failures: result.checks?.p0Failures || [],
    })),
  };
}

function writeMarkdown(report, filePath) {
  const lines = [
    "# Real Corpus Run Trend",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Trend batches: ${report.batchCount}`,
    `- Observed batches: ${report.observedBatchCount}`,
    `- Excluded infra batches: ${report.infraFailureBatchCount}`,
    `- Completed pairs: ${report.completedPairCount}`,
    `- P0 failures: ${report.p0FailureCount}`,
    `- Raw P0 failures in trend batches: ${report.rawP0FailureCount}`,
    `- First-pass items: ${report.firstPassItemCount}`,
    `- Total analysis time: ${report.totalAnalysisMs} ms`,
    "",
    "## Batches",
    "",
    "| Created | Pairs | Completed | P0 | First-pass | Cache hit | Total analysis ms | Max analysis ms | Source |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...(report.batches.length
      ? report.batches.map((batch) => `| ${batch.createdAt} | ${batch.pairCount} | ${batch.completedCount} | ${batch.p0FailureCount} | ${batch.firstPassItems} | ${batch.sectionCacheHitRate ?? ""} | ${batch.totalAnalysisMs} | ${batch.maxAnalysisMs} | ${batch.sourcePath} |`)
      : ["| None | 0 | 0 | 0 | 0 |  | 0 | 0 |  |"]),
    "",
    "## Pieces",
    "",
    "| Batch | Piece | Analysis ms | Import ms | Sections | Cache hit/miss | P0 failures |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const batch of report.batches) {
    for (const piece of batch.pieces) {
      lines.push(`| ${batch.createdAt} | ${piece.title} | ${piece.analysisMs} | ${piece.importMs} | ${piece.attemptedSectionCount} | ${piece.sectionCacheHitCount}/${piece.sectionCacheMissCount} | ${(piece.p0Failures || []).join(", ")} |`);
    }
  }
  lines.push(
    "",
    "## Excluded Infrastructure Batches",
    "",
    "| Created | Pairs | Completed | Infra failures | Raw P0 | Source |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...(report.excludedBatches.length
      ? report.excludedBatches.map((batch) => `| ${batch.createdAt} | ${batch.pairCount} | ${batch.completedCount} | ${batch.infraFailureCount} | ${batch.p0FailureCount} | ${batch.sourcePath} |`)
      : ["| None | 0 | 0 | 0 | 0 |  |"]),
  );
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

const args = parseArgs();
const files = fs.existsSync(args.root)
  ? fs.readdirSync(args.root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(args.root, entry.name, "run-summary.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .sort()
    .reverse()
  : [];

const observedBatches = [];
for (const filePath of files) {
  try {
    const batch = readRunSummary(filePath);
    if (args.runOnly && !batch.run) continue;
    observedBatches.push(batch);
  } catch {
    // Ignore malformed historical artifacts; run-specific tools still keep the raw file.
  }
}

const batches = observedBatches.filter((batch) => batch.trendIncluded).slice(0, args.limit);
const excludedBatches = observedBatches.filter((batch) => !batch.trendIncluded).slice(0, args.limit);
const report = {
  generatedAt: new Date().toISOString(),
  root: relativePath(args.root),
  observedBatchCount: observedBatches.length,
  batchCount: batches.length,
  excludedBatchCount: excludedBatches.length,
  infraFailureBatchCount: excludedBatches.filter((batch) => batch.infraFailureCount > 0).length,
  completedPairCount: sum(batches.map((batch) => batch.completedCount)),
  p0FailureCount: sum(batches.map((batch) => batch.productP0FailureCount)),
  rawP0FailureCount: sum(batches.map((batch) => batch.p0FailureCount)),
  performanceWarningCount: sum(batches.map((batch) => batch.performanceWarningCount)),
  firstPassItemCount: sum(batches.map((batch) => batch.firstPassItems)),
  totalAnalysisMs: sum(batches.map((batch) => batch.totalAnalysisMs)),
  maxAnalysisMs: batches.length ? Math.max(...batches.map((batch) => batch.maxAnalysisMs)) : 0,
  batches,
  excludedBatches,
};

ensureDir(OUTPUT_ROOT);
const jsonPath = path.join(OUTPUT_ROOT, "latest-real-corpus-trend.json");
const mdPath = path.join(OUTPUT_ROOT, "latest-real-corpus-trend.md");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
writeMarkdown(report, mdPath);

console.log(JSON.stringify({
  batchCount: report.batchCount,
  observedBatchCount: report.observedBatchCount,
  infraFailureBatchCount: report.infraFailureBatchCount,
  completedPairCount: report.completedPairCount,
  p0FailureCount: report.p0FailureCount,
  rawP0FailureCount: report.rawP0FailureCount,
  firstPassItemCount: report.firstPassItemCount,
  totalAnalysisMs: report.totalAnalysisMs,
  maxAnalysisMs: report.maxAnalysisMs,
  output: relativePath(jsonPath),
}, null, 2));
