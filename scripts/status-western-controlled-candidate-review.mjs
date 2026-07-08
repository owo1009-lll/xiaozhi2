import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateControlledCandidateGate } from "./eval-western-controlled-candidate-gate.mjs";

function clampMissing(required, actual) {
  return Math.max(0, Number(required || 0) - Number(actual || 0));
}

export function buildControlledCandidateReviewStatus(report) {
  const missingReviewedRows = clampMissing(report.minReviewedRows, report.reviewedRows);
  const missingScoredRows = clampMissing(report.minScoredRows, report.scoredRows);
  const nextActions = [];
  if (!report.sourceExists) {
    nextActions.push("Run western:controlled-candidate-review-import with a completed review CSV.");
  }
  if (missingReviewedRows > 0) {
    nextActions.push(`Review ${missingReviewedRows} more candidate row(s).`);
  }
  if (missingScoredRows > 0) {
    nextActions.push(`Mark ${missingScoredRows} more row(s) as usable or wrong; uncertain does not count as scored evidence.`);
  }
  if (report.scoredRows > 0 && !report.bestRule) {
    nextActions.push("No rule meets the precision gate yet; continue reviewing or keep the runtime gate review-only.");
  }
  if (!nextActions.length) {
    nextActions.push("Calibration evidence is ready for human review before replacing the runtime gate.");
  }
  return {
    ok: true,
    source: report.source,
    sourceExists: report.sourceExists,
    gateVersion: report.gateVersion,
    studentSafeCandidateGateReady: report.studentSafeCandidateGateReady,
    thresholds: {
      minReviewedRows: report.minReviewedRows,
      minScoredRows: report.minScoredRows,
      minPrecision: report.minPrecision,
    },
    counts: {
      rowCount: report.rowCount,
      reviewedRows: report.reviewedRows,
      scoredRows: report.scoredRows,
      usable: report.statusCounts?.usable || 0,
      wrong: report.statusCounts?.wrong || 0,
      uncertain: report.statusCounts?.uncertain || 0,
      blank: report.statusCounts?.blank || 0,
    },
    deficits: {
      reviewedRows: missingReviewedRows,
      scoredRows: missingScoredRows,
    },
    bestRule: report.bestRule,
    blockingReasons: report.blockingReasons,
    nextActions,
  };
}

function parseArgs(argv) {
  const args = {
    reviews: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
    out: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-review-status.json"),
    reviewPage: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "index.html"),
    reviewGuide: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "review-guide.md"),
    completedCsv: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review.completed.csv"),
    minReviewedRows: 30,
    minScoredRows: 30,
    minPrecision: 0.9,
    failOnNotReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reviews") args.reviews = argv[++index] || args.reviews;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--review-page") args.reviewPage = argv[++index] || args.reviewPage;
    else if (arg === "--review-guide") args.reviewGuide = argv[++index] || args.reviewGuide;
    else if (arg === "--completed-csv") args.completedCsv = argv[++index] || args.completedCsv;
    else if (arg === "--min-reviewed-rows") args.minReviewedRows = Number(argv[++index] || args.minReviewedRows);
    else if (arg === "--min-scored-rows") args.minScoredRows = Number(argv[++index] || args.minScoredRows);
    else if (arg === "--min-precision") args.minPrecision = Number(argv[++index] || args.minPrecision);
    else if (arg === "--fail-on-not-ready") args.failOnNotReady = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await evaluateControlledCandidateGate({
    reviewCsvPath: args.reviews,
    minReviewedRows: args.minReviewedRows,
    minScoredRows: args.minScoredRows,
    minPrecision: args.minPrecision,
  });
  const status = buildControlledCandidateReviewStatus(report);
  status.reviewArtifacts = {
    reviewPage: path.relative(process.cwd(), path.resolve(process.cwd(), args.reviewPage)).replace(/\\/g, "/"),
    reviewGuide: path.relative(process.cwd(), path.resolve(process.cwd(), args.reviewGuide)).replace(/\\/g, "/"),
    completedCsv: path.relative(process.cwd(), path.resolve(process.cwd(), args.completedCsv)).replace(/\\/g, "/"),
    labelsCsv: path.relative(process.cwd(), path.resolve(process.cwd(), args.reviews)).replace(/\\/g, "/"),
  };
  const outPath = path.resolve(process.cwd(), args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: status.ok,
    studentSafeCandidateGateReady: status.studentSafeCandidateGateReady,
    counts: status.counts,
    deficits: status.deficits,
    bestRule: status.bestRule,
    blockingReasons: status.blockingReasons,
    nextActions: status.nextActions,
    reviewArtifacts: status.reviewArtifacts,
    out: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
  }, null, 2));
  if (args.failOnNotReady && !status.studentSafeCandidateGateReady) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
