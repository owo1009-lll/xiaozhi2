import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateControlledCandidateGate } from "./eval-western-controlled-candidate-gate.mjs";

const DEFAULT_CONFIDENCE_PILOT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "candidate-confidence-pilot.json",
);
const DEFAULT_CONFIDENCE_VALIDATION_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-validation-review",
  "index.html",
);
const DEFAULT_CONFIDENCE_VALIDATION_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-validation-review",
  "controlled-candidate-review.completed.csv",
);
const DEFAULT_CONFIDENCE_VALIDATION_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-validation-review",
  "confidence-validation-eval.json",
);
const DEFAULT_CONFIDENCE_RELEASE = path.join(
  "models",
  "western-strings",
  "ordinary-upload-confidence-rf-v1",
  "release.json",
);

function clampMissing(required, actual) {
  return Math.max(0, Number(required || 0) - Number(actual || 0));
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8"));
  } catch {
    return null;
  }
}

export function summarizeControlledCandidateConfidencePilot(
  pilot,
  source = DEFAULT_CONFIDENCE_PILOT,
  validationEval = null,
  runtimeRelease = null,
) {
  const releaseCandidates = [];
  for (const evaluation of pilot?.evaluations || []) {
    for (const [modelName, model] of Object.entries(evaluation.models || {})) {
      if (!model?.releaseCandidate) continue;
      releaseCandidates.push({
        featureSet: evaluation.featureSet || "",
        groupBy: evaluation.groupBy || "",
        modelName,
        ...model.releaseCandidate,
      });
    }
  }
  releaseCandidates.sort((left, right) => (
    Number(right.precision || 0) - Number(left.precision || 0)
    || Number(right.selected || 0) - Number(left.selected || 0)
    || String(left.modelName).localeCompare(String(right.modelName))
  ));
  const releaseCandidateFound = Boolean(pilot?.recommendation?.readyForStudentGate && releaseCandidates.length);
  const releaseFloor = pilot?.recommendation?.releaseFloor || {};
  const recommendedCandidates = releaseCandidates.filter((candidate) => (
    (!releaseFloor.featureSet || candidate.featureSet === releaseFloor.featureSet)
    && (!releaseFloor.groupBy || candidate.groupBy === releaseFloor.groupBy)
  ));
  return {
    source: source.replace(/\\/g, "/"),
    sourceExists: Boolean(pilot),
    readyForStudentGate: false,
    releaseCandidateFound,
    needsBlindValidation: releaseCandidateFound && !validationEval?.blindValidationPassed,
    runtimeRelease: runtimeRelease ? {
      source: DEFAULT_CONFIDENCE_RELEASE.replace(/\\/g, "/"),
      modelVersion: runtimeRelease.modelVersion || "",
      gateVersion: runtimeRelease.gateVersion || "",
      enabledByDefault: runtimeRelease.enabledByDefault === true,
      enableEnvVar: runtimeRelease.enableEnvVar || "WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE",
      threshold: runtimeRelease.threshold ?? null,
      modelName: runtimeRelease.modelName || "",
    } : {
      source: DEFAULT_CONFIDENCE_RELEASE.replace(/\\/g, "/"),
      sourceExists: false,
    },
    runtimeGateWired: Boolean(runtimeRelease?.modelVersion && runtimeRelease?.gateVersion),
    reason: !pilot
      ? "confidence-pilot-missing"
      : validationEval?.blindValidationPassed
        ? (runtimeRelease?.modelVersion ? "confidence-runtime-gate-wired-disabled-by-default" : "confidence-validation-passed-runtime-gate-still-disabled")
        : "eval-only-confidence-pilot-needs-blind-validation",
    reviewedRowsUsed: Number(pilot?.reviewedRowsUsed || 0),
    usableRows: Number(pilot?.usableRows || 0),
    wrongRows: Number(pilot?.wrongRows || 0),
    recommendation: pilot?.recommendation || null,
    recommendedReleaseCandidate: recommendedCandidates[0] || null,
    bestReleaseCandidate: recommendedCandidates[0] || releaseCandidates[0] || null,
    releaseCandidateCount: releaseCandidates.length,
    validationReviewPage: DEFAULT_CONFIDENCE_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    validationCompletedCsv: DEFAULT_CONFIDENCE_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    validationEval: validationEval || {
      source: DEFAULT_CONFIDENCE_VALIDATION_COMPLETED.replace(/\\/g, "/"),
      sourceExists: false,
      blindValidationPassed: false,
      readyForRuntimeGate: false,
      reason: "confidence-validation-eval-missing",
      blockingReasons: ["confidence-validation-eval-missing"],
    },
  };
}

export function attachConfidencePilotStatus(status, confidencePilot) {
  if (!confidencePilot?.releaseCandidateFound) {
    return { ...status, confidencePilot };
  }
  const validationPassed = Boolean(confidencePilot.validationEval?.blindValidationPassed);
  const runtimeGateWired = Boolean(confidencePilot.runtimeGateWired);
  const nextActions = [
    validationPassed
      ? (runtimeGateWired
        ? "Confidence runtime gate is wired but disabled by default. Keep default fail-closed, and enable only with WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1 after an explicit release decision."
        : "Confidence blind validation passed. Review metrics and wire a runtime gate in a separate release phase; current runtime remains fail-closed.")
      : `Confidence pilot found release candidates; review ${DEFAULT_CONFIDENCE_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/")} and run western:controlled-candidate-confidence-validation-eval before changing the runtime gate.`,
  ];
  const baseBlockingReasons = validationPassed
    ? (status.blockingReasons || []).filter((reason) => reason !== "candidate-review-no-rule-meets-precision")
    : (status.blockingReasons || []);
  const blockingReasons = [...new Set([
    ...baseBlockingReasons,
    validationPassed
      ? (runtimeGateWired ? "ordinary-auto-gate-disabled-by-default" : "candidate-confidence-validation-not-wired")
      : "candidate-confidence-pilot-needs-blind-validation",
  ])];
  return {
    ...status,
    confidencePilot,
    blockingReasons,
    nextActions,
  };
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
    confidencePilot: DEFAULT_CONFIDENCE_PILOT,
    confidenceValidationEval: DEFAULT_CONFIDENCE_VALIDATION_EVAL,
    confidenceRelease: DEFAULT_CONFIDENCE_RELEASE,
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
    else if (arg === "--confidence-pilot") args.confidencePilot = argv[++index] || args.confidencePilot;
    else if (arg === "--confidence-validation-eval") args.confidenceValidationEval = argv[++index] || args.confidenceValidationEval;
    else if (arg === "--confidence-release") args.confidenceRelease = argv[++index] || args.confidenceRelease;
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
  let status = buildControlledCandidateReviewStatus(report);
  status = attachConfidencePilotStatus(
    status,
    summarizeControlledCandidateConfidencePilot(
      await readJson(args.confidencePilot),
      args.confidencePilot,
      await readJson(args.confidenceValidationEval),
      await readJson(args.confidenceRelease),
    ),
  );
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
    confidencePilot: status.confidencePilot,
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
