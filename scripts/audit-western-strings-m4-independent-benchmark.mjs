import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-benchmark-audit.json",
);
const DEFAULT_SUMMARY = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-benchmark-audit.md",
);

const DEFAULT_INPUTS = {
  clean: path.join("data", "experiments", "western-strings-m4", "render-gold-omr", "render-gold-omr-summary.json"),
  scan: path.join("data", "experiments", "western-strings-m4", "render-gold-omr-scan", "render-gold-omr-summary.json"),
  photo: path.join("data", "experiments", "western-strings-m4", "render-gold-omr-photo", "render-gold-omr-summary.json"),
  realPhotoConsistency: path.join("data", "experiments", "western-strings-m4", "real-jpg-omr", "real-jpg-omr-summary.json"),
  confidenceProbe: path.join("data", "experiments", "western-strings-m4", "omr-confidence-probe.json"),
};

export const DEFAULT_THRESHOLDS = Object.freeze({
  clean: Object.freeze({ minRows: 30, minMeanPrecision: 0.95, minMeanRecall: 0.90 }),
  scan: Object.freeze({ minRows: 5, minMeanPrecision: 0.90, minMeanRecall: 0.85 }),
  photo: Object.freeze({ minRows: 5, minMeanPrecision: 0.90, minMeanRecall: 0.85 }),
  strictPerPiece: Object.freeze({ minPrecision: 0.98, minRecall: 0.95, minPassRate: 0.90 }),
  minIndependentRealPhotoRows: 3,
});

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowsFrom(summary) {
  return Array.isArray(summary?.pieces)
    ? summary.pieces.filter((row) => row?.status === "ok")
    : [];
}

function summarizeDomain(summary, thresholds) {
  const rows = rowsFrom(summary)
    .map((row) => ({
      piece: String(row.piece || ""),
      precision: finite(row.pitchPrecision),
      recall: finite(row.pitchRecall),
    }))
    .filter((row) => row.precision !== null && row.recall !== null);
  const meanPrecision = rows.length
    ? rows.reduce((sum, row) => sum + row.precision, 0) / rows.length
    : null;
  const meanRecall = rows.length
    ? rows.reduce((sum, row) => sum + row.recall, 0) / rows.length
    : null;
  const checks = {
    enoughRows: rows.length >= thresholds.minRows,
    meanPrecision: meanPrecision !== null && meanPrecision >= thresholds.minMeanPrecision,
    meanRecall: meanRecall !== null && meanRecall >= thresholds.minMeanRecall,
  };
  return {
    sourceAvailable: Boolean(summary),
    evaluatedRows: rows.length,
    meanPrecision,
    meanRecall,
    thresholds,
    checks,
    passed: Object.values(checks).every(Boolean),
    rows,
  };
}

function summarizeConsistency(summary) {
  const variants = summary?.byVariant && typeof summary.byVariant === "object"
    ? summary.byVariant
    : {};
  return {
    sourceAvailable: Boolean(summary),
    independentAccuracyEvidence: false,
    caveat: String(summary?.caveat || ""),
    variants,
  };
}

export function evaluateIndependentBenchmark(inputs, thresholds = DEFAULT_THRESHOLDS) {
  const clean = summarizeDomain(inputs?.clean, thresholds.clean);
  const scan = summarizeDomain(inputs?.scan, thresholds.scan);
  const photo = summarizeDomain(inputs?.photo, thresholds.photo);
  const strictRows = clean.rows.filter(
    (row) => row.precision >= thresholds.strictPerPiece.minPrecision
      && row.recall >= thresholds.strictPerPiece.minRecall,
  );
  const strictPassRate = clean.evaluatedRows > 0 ? strictRows.length / clean.evaluatedRows : 0;
  const independentBenchmarkReady = clean.passed && scan.passed && photo.passed;
  const evidenceBlockingReasons = [];
  if (!clean.sourceAvailable) evidenceBlockingReasons.push("m4-independent-clean-summary-missing");
  else if (!clean.passed) evidenceBlockingReasons.push("m4-independent-clean-benchmark-below-floor");
  if (!scan.sourceAvailable) evidenceBlockingReasons.push("m4-independent-scan-summary-missing");
  else if (!scan.passed) evidenceBlockingReasons.push("m4-independent-scan-benchmark-below-floor");
  if (!photo.sourceAvailable) evidenceBlockingReasons.push("m4-independent-photo-summary-missing");
  else if (!photo.passed) evidenceBlockingReasons.push("m4-independent-photo-benchmark-below-floor");

  // The current real-photo set uses human-approved unchanged Audiveris drafts.
  // It is consistency evidence, not independent photo-domain accuracy gold.
  const independentRealPhotoRows = 0;
  const confidenceProbeReady = inputs?.confidenceProbe?.safeSubsetReady === true;
  const automaticAdoptionBlockingReasons = [];
  if (!independentBenchmarkReady) {
    automaticAdoptionBlockingReasons.push("m4-independent-benchmark-not-ready");
  }
  if (strictPassRate < thresholds.strictPerPiece.minPassRate) {
    automaticAdoptionBlockingReasons.push("m4-clean-per-piece-strict-pass-rate-too-low");
  }
  if (independentRealPhotoRows < thresholds.minIndependentRealPhotoRows) {
    automaticAdoptionBlockingReasons.push("m4-real-photo-independent-gold-missing");
  }
  if (!confidenceProbeReady) {
    automaticAdoptionBlockingReasons.push(
      inputs?.confidenceProbe ? "m4-runtime-safe-subset-not-found" : "m4-runtime-confidence-probe-missing",
    );
  }
  const automaticAdoptionReady = automaticAdoptionBlockingReasons.length === 0;

  return {
    ok: true,
    claimScope: "independent render-gold OMR benchmark only; not real-photo accuracy or student runtime approval",
    goldProvenance: "public clean MusicXML rendered independently, then recognized blind by Audiveris",
    independentBenchmarkReady,
    automaticAdoptionReady,
    studentGateReady: false,
    domains: { clean, scan, photo },
    strictPerPiece: {
      ...thresholds.strictPerPiece,
      passedRows: strictRows.length,
      evaluatedRows: clean.evaluatedRows,
      passRate: strictPassRate,
      passedPieces: strictRows.map((row) => row.piece),
    },
    minIndependentRealPhotoRows: thresholds.minIndependentRealPhotoRows,
    realPhotoConsistency: summarizeConsistency(inputs?.realPhotoConsistency),
    confidenceProbe: inputs?.confidenceProbe ? {
      sourceAvailable: true,
      safeSubsetReady: confidenceProbeReady,
      validation: String(inputs.confidenceProbe.validation || ""),
      runtimeFeatureOnly: inputs.confidenceProbe.runtimeFeatureOnly === true,
      counts: inputs.confidenceProbe.counts || {},
      blockingReasons: inputs.confidenceProbe.blockingReasons || [],
      models: inputs.confidenceProbe.models || {},
    } : {
      sourceAvailable: false,
      safeSubsetReady: false,
    },
    independentRealPhotoRows,
    evidenceBlockingReasons,
    automaticAdoptionBlockingReasons,
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, summary: DEFAULT_SUMMARY, inputs: { ...DEFAULT_INPUTS } };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--summary") args.summary = argv[++index] || args.summary;
    else if (arg === "--clean") args.inputs.clean = argv[++index] || args.inputs.clean;
    else if (arg === "--scan") args.inputs.scan = argv[++index] || args.inputs.scan;
    else if (arg === "--photo") args.inputs.photo = argv[++index] || args.inputs.photo;
    else if (arg === "--real-photo-consistency") {
      args.inputs.realPhotoConsistency = argv[++index] || args.inputs.realPhotoConsistency;
    }
  }
  return args;
}

function renderSummary(report, sources) {
  const lines = [
    "# M4 Independent OMR Benchmark Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- independentBenchmarkReady: ${report.independentBenchmarkReady}`,
    `- automaticAdoptionReady: ${report.automaticAdoptionReady}`,
    `- studentGateReady: ${report.studentGateReady}`,
    "",
    "## Independent Domains",
    "",
    "| Domain | N | Mean precision | Mean recall | Passed |",
    "|---|---:|---:|---:|---|",
    ...Object.entries(report.domains).map(([name, domain]) => (
      `| ${name} | ${domain.evaluatedRows} | ${domain.meanPrecision?.toFixed(4) ?? "n/a"} | ${domain.meanRecall?.toFixed(4) ?? "n/a"} | ${domain.passed} |`
    )),
    "",
    "## Automatic Adoption Boundary",
    "",
    `- strict per-piece pass: ${report.strictPerPiece.passedRows}/${report.strictPerPiece.evaluatedRows} (${(report.strictPerPiece.passRate * 100).toFixed(1)}%)`,
    `- independent real-photo gold rows: ${report.independentRealPhotoRows}`,
    `- runtime confidence safe subset: ${report.confidenceProbe.safeSubsetReady}`,
    `- blockers: ${report.automaticAdoptionBlockingReasons.join(", ") || "none"}`,
    "",
    "The real-photo JPG result is re-recognition consistency against human-approved unchanged Audiveris drafts. It is not independent photo-domain accuracy and cannot open the runtime gate.",
    "",
    "## Sources",
    "",
    ...Object.entries(sources).map(([name, source]) => `- ${name}: ${String(source).replace(/\\/g, "/")}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = Object.fromEntries(
    await Promise.all(Object.entries(args.inputs).map(async ([name, source]) => [name, await readJson(source)])),
  );
  const report = {
    ...evaluateIndependentBenchmark(inputs),
    generatedAt: new Date().toISOString(),
    sources: Object.fromEntries(
      Object.entries(args.inputs).map(([name, source]) => [name, String(source).replace(/\\/g, "/")]),
    ),
  };
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(args.summary, renderSummary(report, args.inputs), "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    independentBenchmarkReady: report.independentBenchmarkReady,
    automaticAdoptionReady: report.automaticAdoptionReady,
    studentGateReady: report.studentGateReady,
    strictPerPiece: report.strictPerPiece,
    evidenceBlockingReasons: report.evidenceBlockingReasons,
    automaticAdoptionBlockingReasons: report.automaticAdoptionBlockingReasons,
    out: String(args.out).replace(/\\/g, "/"),
  }, null, 2));
  if (!report.independentBenchmarkReady) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
