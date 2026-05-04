import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = path.join(REPO_ROOT, "data", "real-tests", "unknown-pdf-omr", "latest-unknown-pdf-omr-baseline.json");
const OUTPUT_ROOT = path.join(REPO_ROOT, "data", "real-tests", "complex-pdf-omr");

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    input: DEFAULT_INPUT,
    outputDir: path.join(OUTPUT_ROOT, new Date().toISOString().replace(/[:.]/g, "-")),
    strict: false,
    minSamples: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") args.input = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--output-dir") args.outputDir = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--min-samples") args.minSamples = Math.max(1, Number(argv[++index]) || args.minSamples);
  }
  return args;
}

function fail(message) {
  throw new Error(message);
}

async function readJson(filePath, fallback = null) {
  if (!filePath || !fsSync.existsSync(filePath)) return fallback;
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ratioValue(value, fallback = 0) {
  const numeric = numberValue(value, fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function getOmrStats(sample = {}) {
  return sample.omrStats && typeof sample.omrStats === "object" ? sample.omrStats : {};
}

function wholePdfRuns(omrStats = {}) {
  if (omrStats.wholePdfAttempted === true) return 1;
  if (omrStats.mode === "whole-pdf") return 1;
  return 0;
}

function wholePdfSkipReason(sample = {}, omrStats = {}) {
  if (omrStats.wholePdfSkipReason) return String(omrStats.wholePdfSkipReason);
  if (omrStats.wholePdfSkippedReason) return String(omrStats.wholePdfSkippedReason);
  if (omrStats.wholePdfAttempted === false) return "whole-pdf-not-attempted";
  const warning = (Array.isArray(sample.warnings) ? sample.warnings : []).find((item) => /fallback|回退|按页|pagewise/i.test(String(item)));
  return warning ? String(warning) : "";
}

function cacheHits(omrStats = {}) {
  return (
    numberValue(omrStats.pageResultCacheHits) +
    numberValue(omrStats.renderCacheHits) +
    numberValue(omrStats.tileRenderCacheHits)
  );
}

function cacheMisses(omrStats = {}) {
  return (
    numberValue(omrStats.pageResultCacheMisses) +
    numberValue(omrStats.renderCacheMisses) +
    numberValue(omrStats.tileRenderCacheMisses)
  );
}

function dedupeRate(sample = {}, omrStats = {}) {
  if (sample.dedupeRate != null) return ratioValue(sample.dedupeRate);
  if (omrStats.dedupeRate != null) return ratioValue(omrStats.dedupeRate);
  const hits = cacheHits(omrStats);
  const total = hits + cacheMisses(omrStats);
  return total > 0 ? Number((hits / total).toFixed(4)) : 0;
}

function summarizeSample(sample = {}, index = 0) {
  const omrStats = getOmrStats(sample);
  const pageOmrRuns = numberValue(omrStats.pageOmrRuns);
  const tileOmrRuns = numberValue(omrStats.tileOmrRuns);
  const wholeRuns = wholePdfRuns(omrStats);
  const pageCount = numberValue(omrStats.pageCount);
  const sectionCount = numberValue(sample.sectionCount ?? omrStats.sectionCount ?? omrStats.sections);
  const noteCount = numberValue(sample.noteCount ?? sample.scoreLineStats?.noteCount ?? omrStats.noteCount ?? omrStats.notes);
  const erhuRatio = ratioValue(sample.scoreLineStats?.erhuRatio ?? sample.erhuRatio, noteCount > 0 ? 0 : 1);
  return {
    sampleIndex: index + 1,
    title: String(sample.title || `sample-${index + 1}`),
    pdfPath: String(sample.pdfPath || ""),
    status: String(sample.status || "unknown"),
    pageCount,
    audiverisRuns: wholeRuns + pageOmrRuns + tileOmrRuns,
    wholePdfRuns: wholeRuns,
    pageOmrRuns,
    tileOmrRuns,
    wholePdfSkipReason: wholePdfSkipReason(sample, omrStats),
    dedupeRate: dedupeRate(sample, omrStats),
    cacheHit: cacheHits(omrStats) > 0 || sample.cacheHit === true,
    cacheHits: cacheHits(omrStats),
    cacheMisses: cacheMisses(omrStats),
    sections: sectionCount,
    notes: noteCount,
    erhuRatio,
    elapsedMs: numberValue(sample.importMs ?? sample.elapsedMs ?? omrStats.elapsedMs),
    omrConfidence: ratioValue(sample.omrConfidence),
    selectedPart: String(sample.selectedPart || ""),
    selectedPartConfidence: ratioValue(sample.selectedPartConfidence),
    structureSource: String(sample.structureSource || ""),
    warningCount: Array.isArray(sample.warnings) ? sample.warnings.length : 0,
  };
}

function average(values) {
  const numeric = values.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  return numeric.length ? Number((numeric.reduce((sum, item) => sum + item, 0) / numeric.length).toFixed(4)) : 0;
}

function validateReport(report, { strict = false, minSamples = 1 } = {}) {
  if (!report.samples.length) fail("complex PDF OMR benchmark has no samples");
  if (report.samples.length < minSamples) fail(`complex PDF OMR benchmark expected at least ${minSamples} samples`);
  for (const sample of report.samples) {
    const required = ["pageCount", "audiverisRuns", "wholePdfSkipReason", "dedupeRate", "cacheHit", "sections", "notes", "erhuRatio", "elapsedMs"];
    for (const key of required) {
      if (!(key in sample)) fail(`sample ${sample.title} is missing ${key}`);
    }
  }
  if (strict && report.completedCount < minSamples) {
    fail(`strict benchmark expected at least ${minSamples} completed samples; got ${report.completedCount}`);
  }
}

async function main() {
  const args = parseArgs();
  const source = await readJson(args.input, null);
  if (!source) fail(`benchmark input not found: ${args.input}`);
  const samples = (Array.isArray(source.samples) ? source.samples : []).map(summarizeSample);
  const completed = samples.filter((sample) => sample.status === "completed");
  const report = {
    createdAt: new Date().toISOString(),
    sourcePath: path.relative(REPO_ROOT, args.input).replace(/\\/g, "/"),
    sourceCreatedAt: source.createdAt || "",
    sourceBaseUrl: source.baseUrl || "",
    sampleCount: samples.length,
    completedCount: completed.length,
    failedCount: samples.length - completed.length,
    averages: {
      pageCount: average(samples.map((sample) => sample.pageCount)),
      audiverisRuns: average(samples.map((sample) => sample.audiverisRuns)),
      sections: average(samples.map((sample) => sample.sections)),
      notes: average(samples.map((sample) => sample.notes)),
      erhuRatio: average(samples.map((sample) => sample.erhuRatio)),
      elapsedMs: average(samples.map((sample) => sample.elapsedMs)),
      omrConfidence: average(samples.map((sample) => sample.omrConfidence)),
      dedupeRate: average(samples.map((sample) => sample.dedupeRate)),
    },
    samples,
  };
  validateReport(report, args);
  await fs.mkdir(args.outputDir, { recursive: true });
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  const outputPath = path.join(args.outputDir, "complex-pdf-omr-benchmark.json");
  const latestPath = path.join(OUTPUT_ROOT, "latest-complex-pdf-omr-benchmark.json");
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: true,
    sampleCount: report.sampleCount,
    completedCount: report.completedCount,
    failedCount: report.failedCount,
    averages: report.averages,
    output: path.relative(REPO_ROOT, outputPath).replace(/\\/g, "/"),
    latest: path.relative(REPO_ROOT, latestPath).replace(/\\/g, "/"),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
