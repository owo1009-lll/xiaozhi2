import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateControlledCandidateGate } from "./eval-western-controlled-candidate-gate.mjs";
import {
  attachConfidencePilotStatus,
  buildControlledCandidateReviewStatus,
  summarizeControlledCandidateConfidencePilot,
} from "./status-western-controlled-candidate-review.mjs";

const DEFAULT_OUT = path.join("data", "experiments", "western-strings-project-status.json");

const CONTROLLED_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "controlled-candidate-review-labels.csv",
);
const CONTROLLED_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "index.html",
);
const CONTROLLED_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_PILOT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "candidate-confidence-pilot.json",
);
const CONTROLLED_CONFIDENCE_VALIDATION_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-validation-review",
  "confidence-validation-eval.json",
);
const CONTROLLED_CONFIDENCE_RELEASE = path.join(
  "models",
  "western-strings",
  "ordinary-upload-confidence-rf-v1",
  "release.json",
);
const CONTROLLED_CONFIDENCE_RELEASE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-validation-review",
  "ordinary-confidence-release-audit.json",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "index.html",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "confidence-threshold-pool-eval.json",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_DIAGNOSIS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "confidence-threshold-pool-diagnosis.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration",
  "combined-controlled-candidate-review-labels.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration",
  "candidate-confidence-recalibration-pilot.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "index.html",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-validation-eval.json",
);
const M3PLUS_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review.csv",
);
const M3PLUS_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review-labels.csv",
);
const M3PLUS_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review.completed.csv",
);
const M3PLUS_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "index.html",
);
const M3PLUS_MODE_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-eval.json",
);
const M4_READINESS = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "omr-readiness.json",
);
const M4_BENCHMARK = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "omr-benchmark.json",
);
const M4_INDEPENDENT_GOLD_TODO = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-todo.md",
);

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
  }
  return args;
}

async function exists(filePath) {
  try {
    await fs.access(path.resolve(process.cwd(), filePath));
    return true;
  } catch {
    return false;
  }
}

function splitCsvLine(line) {
  const cols = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cols.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols;
}

async function readCsv(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  let text = "";
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch {
    return [];
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const headers = splitCsvLine(lines.shift());
  return lines.map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] || "";
    });
    return row;
  });
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8"));
  } catch {
    return fallback;
  }
}

function bestDeployableReleaseCandidate(pilot) {
  const candidates = [];
  for (const evaluation of pilot?.evaluations || []) {
    if (evaluation.featureSet !== "deployable" || evaluation.groupBy !== "recordingId") continue;
    for (const [modelName, model] of Object.entries(evaluation.models || {})) {
      if (!model?.releaseCandidate) continue;
      candidates.push({
        modelName,
        featureSet: evaluation.featureSet,
        groupBy: evaluation.groupBy,
        ...model.releaseCandidate,
      });
    }
  }
  candidates.sort((a, b) => (
    Number(b.precision || 0) - Number(a.precision || 0)
    || Number(b.coverage || 0) - Number(a.coverage || 0)
    || Number(b.selected || 0) - Number(a.selected || 0)
  ));
  return candidates[0] || null;
}

function isM3PlusReviewed(row) {
  return [
    "audioScoreMatch",
    "observedPitchBehavior",
    "pitchJudgementMode",
    "pitchJudgeable",
    "pitchAccuracyLabel",
    "reviewConfidence",
    "reviewComments",
  ].some((field) => String(row[field] || "").trim() !== "");
}

function isM3PlusScored(row) {
  return (
    String(row.audioScoreMatch || "").trim() === "match"
    && String(row.pitchJudgeable || "").trim() === "yes"
    && ["in-tune", "sharp", "flat", "wrong-note"].includes(String(row.pitchAccuracyLabel || "").trim())
  );
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const key = String(row[field] || "blank").trim() || "blank";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

async function buildM3PlusStatus() {
  const sourceRows = await readCsv(M3PLUS_SOURCE);
  const labelRows = await readCsv(M3PLUS_LABELS);
  const modeEval = await readJson(M3PLUS_MODE_EVAL);
  const sourceIds = new Set(sourceRows.map((row) => row.rowId).filter(Boolean));
  const reviewedRows = labelRows.filter((row) => sourceIds.has(row.rowId) && isM3PlusReviewed(row));
  const scoredRows = reviewedRows.filter(isM3PlusScored);
  const sourceModeCounts = countBy(sourceRows, "candidateMode");
  const reviewedModeCounts = countBy(reviewedRows, "candidateMode");
  const scoredModeCounts = countBy(scoredRows, "candidateMode");
  const minReviewedPerMode = 5;
  const minScoredPerMode = 3;
  const perMode = {};
  for (const mode of Object.keys(sourceModeCounts).sort()) {
    const reviewed = reviewedModeCounts[mode] || 0;
    const scored = scoredModeCounts[mode] || 0;
    perMode[mode] = {
      total: sourceModeCounts[mode],
      reviewed,
      scored,
      reviewedDeficit: Math.max(0, minReviewedPerMode - reviewed),
      scoredDeficit: Math.max(0, minScoredPerMode - scored),
    };
  }
  const labelBlockingReasons = [];
  if (!(await exists(M3PLUS_SOURCE))) labelBlockingReasons.push("m3plus-review-source-missing");
  if (!(await exists(M3PLUS_LABELS))) labelBlockingReasons.push("m3plus-review-labels-missing");
  if (!(await exists(M3PLUS_COMPLETED))) labelBlockingReasons.push("m3plus-review-completed-csv-missing");
  if (Object.values(perMode).some((item) => item.reviewedDeficit > 0)) {
    labelBlockingReasons.push("m3plus-review-reviewed-per-mode-too-low");
  }
  if (Object.values(perMode).some((item) => item.scoredDeficit > 0)) {
    labelBlockingReasons.push("m3plus-review-scored-per-mode-too-low");
  }
  const labelReady = labelBlockingReasons.length === 0;
  const modeEvalExists = Boolean(modeEval);
  const modeReleaseReady = Boolean(modeEval?.m3plusModeReleaseReady);
  const modeEvalBlockingReasons = [];
  if (labelReady && !modeEvalExists) {
    modeEvalBlockingReasons.push("m3plus-mode-eval-missing");
  } else if (labelReady && !modeReleaseReady) {
    modeEvalBlockingReasons.push(...(modeEval?.blockingReasons || ["m3plus-no-mode-specific-release-ready"]));
  }
  const blockingReasons = [...labelBlockingReasons, ...modeEvalBlockingReasons];
  return {
    ok: true,
    m3plusModeEvalReady: labelReady,
    m3plusModeReleaseReady: modeReleaseReady,
    studentGateReady: false,
    reason: modeReleaseReady ? "mode-specific-offline-eval-ready" : "mode-specific-review-only",
    counts: {
      rowCount: sourceRows.length,
      labelRows: labelRows.length,
      reviewedRows: reviewedRows.length,
      scoredRows: scoredRows.length,
      missingLabelRows: Math.max(0, sourceRows.length - labelRows.length),
    },
    perMode,
    modeEval: {
      source: M3PLUS_MODE_EVAL.replace(/\\/g, "/"),
      sourceExists: modeEvalExists,
      m3plusModeReleaseReady: modeReleaseReady,
      releaseReadyModes: modeEval?.releaseReadyModes || [],
      controlReadyModes: modeEval?.controlReadyModes || [],
      counts: modeEval?.counts || {},
      blockingReasons: modeEval?.blockingReasons || modeEvalBlockingReasons,
    },
    labelBlockingReasons,
    blockingReasons,
    reviewArtifacts: {
      reviewPage: M3PLUS_REVIEW_PAGE.replace(/\\/g, "/"),
      completedCsv: M3PLUS_COMPLETED.replace(/\\/g, "/"),
      labelsCsv: M3PLUS_LABELS.replace(/\\/g, "/"),
      modeEvalJson: M3PLUS_MODE_EVAL.replace(/\\/g, "/"),
    },
  };
}

async function buildControlledStatus() {
  const report = await evaluateControlledCandidateGate({
    reviewCsvPath: CONTROLLED_LABELS,
    minReviewedRows: 30,
    minScoredRows: 30,
    minPrecision: 0.9,
  });
  const confidencePilot = summarizeControlledCandidateConfidencePilot(
    await readJson(CONTROLLED_CONFIDENCE_PILOT),
    CONTROLLED_CONFIDENCE_PILOT,
    await readJson(CONTROLLED_CONFIDENCE_VALIDATION_EVAL),
    await readJson(CONTROLLED_CONFIDENCE_RELEASE),
    await readJson(CONTROLLED_CONFIDENCE_RELEASE_AUDIT),
  );
  const status = attachConfidencePilotStatus(buildControlledCandidateReviewStatus(report), confidencePilot);
  const recalibrationPilot = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT);
  const recalibrationEval = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL);
  const recalibrationReleaseCandidate = bestDeployableReleaseCandidate(recalibrationPilot);
  const recalibrationNeedsBlindValidation = Boolean(
    recalibrationReleaseCandidate
    && !recalibrationEval?.blindValidationPassed
  );
  status.confidenceRecalibration = {
    labelsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS.replace(/\\/g, "/"),
    pilotJson: CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT.replace(/\\/g, "/"),
    validationReviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    validationCompletedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    validationEvalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL.replace(/\\/g, "/"),
    releaseCandidateFound: Boolean(recalibrationReleaseCandidate),
    bestReleaseCandidate: recalibrationReleaseCandidate,
    validationEval: recalibrationEval || {
      sourceExists: false,
      blindValidationPassed: false,
      blockingReasons: ["confidence-recalibration-validation-eval-missing"],
    },
    needsBlindValidation: recalibrationNeedsBlindValidation,
  };
  if (recalibrationNeedsBlindValidation) {
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-validation-needed",
      ]),
    ];
    status.nextActions = [
      "Review the confidence recalibration blind-validation pack, save controlled-candidate-review.completed.csv in that folder, then run western:controlled-candidate-confidence-recalibration-validation-eval.",
    ];
  }
  status.reviewArtifacts = {
    reviewPage: CONTROLLED_REVIEW_PAGE.replace(/\\/g, "/"),
    completedCsv: CONTROLLED_COMPLETED.replace(/\\/g, "/"),
    labelsCsv: CONTROLLED_LABELS.replace(/\\/g, "/"),
    releaseAuditJson: CONTROLLED_CONFIDENCE_RELEASE_AUDIT.replace(/\\/g, "/"),
    thresholdPoolReviewPage: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_REVIEW_PAGE.replace(/\\/g, "/"),
    thresholdPoolCompletedCsv: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_COMPLETED.replace(/\\/g, "/"),
    thresholdPoolEvalJson: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_EVAL.replace(/\\/g, "/"),
    thresholdPoolDiagnosisJson: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_DIAGNOSIS.replace(/\\/g, "/"),
    recalibrationLabelsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS.replace(/\\/g, "/"),
    recalibrationPilotJson: CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT.replace(/\\/g, "/"),
    recalibrationValidationReviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    recalibrationValidationCompletedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    recalibrationValidationEvalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL.replace(/\\/g, "/"),
  };
  return status;
}

async function buildM4OmrStatus() {
  const readiness = await readJson(M4_READINESS);
  const benchmark = await readJson(M4_BENCHMARK);
  const readinessReady = Boolean(readiness?.gate?.m4OmrBenchmarkDatasetReady);
  const benchmarkEvaluated = Boolean(benchmark?.gate?.m4OmrBenchmarkEvaluated);
  const draftQualityReady = Boolean(benchmark?.gate?.m4OmrDraftQualityReady);
  const blockingReasons = [];
  if (!readiness) blockingReasons.push("m4-omr-readiness-missing");
  else if (!readinessReady) blockingReasons.push("m4-omr-readiness-not-ready");
  if (!benchmark) blockingReasons.push("m4-omr-benchmark-missing");
  else {
    if (!benchmarkEvaluated) blockingReasons.push("m4-omr-benchmark-not-evaluated");
    if ((benchmark.counts?.usableBenchmarkRows || 0) <= 0) blockingReasons.push("m4-omr-no-independent-gold");
    if ((benchmark.counts?.selfComparisonRows || 0) > 0) blockingReasons.push("m4-omr-self-comparison-detected");
    if (!draftQualityReady) blockingReasons.push("m4-omr-draft-quality-not-ready");
  }
  return {
    ok: true,
    m4OmrBenchmarkDatasetReady: readinessReady,
    m4OmrDraftQualityReady: draftQualityReady,
    studentGateReady: false,
    reason: "omr-status-only",
    counts: {
      readinessRows: readiness?.counts?.intakeRows || 0,
      pairReadyRows: readiness?.counts?.pairReadyRows || 0,
      benchmarkRows: benchmark?.counts?.rows || 0,
      parseOkRows: benchmark?.counts?.parseOkRows || 0,
      usableBenchmarkRows: benchmark?.counts?.usableBenchmarkRows || 0,
      selfComparisonRows: benchmark?.counts?.selfComparisonRows || 0,
      blockedRows: benchmark?.counts?.blockedRows || 0,
    },
    blockingReasons,
    artifacts: {
      readinessJson: M4_READINESS.replace(/\\/g, "/"),
      benchmarkJson: M4_BENCHMARK.replace(/\\/g, "/"),
      independentGoldTodo: M4_INDEPENDENT_GOLD_TODO.replace(/\\/g, "/"),
      readinessCsv: String(readiness?.artifacts?.csv || "data/experiments/western-strings-m4/omr-readiness.csv").replace(/\\/g, "/"),
      benchmarkCsv: String(benchmark?.artifacts?.csv || "data/experiments/western-strings-m4/omr-benchmark.csv").replace(/\\/g, "/"),
    },
  };
}

function summarizeNextActions(controlled, m3plus, m4Omr) {
  const actions = [];
  if (!controlled.studentSafeCandidateGateReady) {
    const ordinaryArtifact = (controlled.blockingReasons || []).includes("ordinary-confidence-recalibration-validation-needed")
      ? (controlled.reviewArtifacts.recalibrationValidationReviewPage || controlled.confidenceRecalibration?.validationReviewPage)
      : (controlled.blockingReasons || []).includes("ordinary-confidence-threshold-pool-precision-too-low")
      ? (controlled.reviewArtifacts.thresholdPoolDiagnosisJson || controlled.confidencePilot?.thresholdPoolEvalJson)
      : (controlled.confidencePilot?.thresholdPoolReviewPage || controlled.reviewArtifacts.thresholdPoolReviewPage || controlled.confidencePilot?.validationReviewPage || controlled.reviewArtifacts.reviewPage);
    actions.push({
      priority: 1,
      track: "M2/M3 ordinary upload candidate gate",
      action: controlled.nextActions?.[0] || "Finish the current blind review batch, import it, then rerun gate/status.",
      artifact: ordinaryArtifact,
      reason: controlled.blockingReasons,
    });
  }
  if (!m3plus.m3plusModeEvalReady) {
    actions.push({
      priority: 2,
      track: "M3+ pitch behavior modes",
      action: "Finish M3+ pitch behavior labels, import them, then evaluate per-mode precision separately.",
      artifact: m3plus.reviewArtifacts.reviewPage,
      reason: m3plus.blockingReasons,
    });
  } else if (!m3plus.m3plusModeReleaseReady) {
    actions.push({
      priority: 2,
      track: "M3+ pitch behavior modes",
      action: "M3+ labels are sufficient, but no non-control pitch-behavior mode is release-ready. Keep M3+ review-only or collect more true mode-specific samples, then rerun western:m3plus-mode-eval.",
      artifact: m3plus.reviewArtifacts.modeEvalJson,
      reason: m3plus.blockingReasons,
    });
  }
  if (!m4Omr.m4OmrDraftQualityReady) {
    actions.push({
      priority: 3,
      track: "M4 OMR benchmark",
      action: "Prepare independent human-corrected gold MusicXML/MXL or external gold, then rerun `npm run western:m4-omr-benchmark`.",
      artifact: m4Omr.artifacts.independentGoldTodo,
      reason: m4Omr.blockingReasons,
    });
  }
  if (!actions.length) {
    actions.push({
      priority: 1,
      track: "Release review",
      action: "Both label gates have enough data for offline evaluation; run the relevant precision/unsafe checks before touching runtime gates.",
      artifact: "",
      reason: [],
    });
  }
  return actions;
}

export async function buildProjectStatus() {
  const [controlledCandidate, m3plusPitchModes, m4Omr] = await Promise.all([
    buildControlledStatus(),
    buildM3PlusStatus(),
    buildM4OmrStatus(),
  ]);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    project: "western-strings-practice-diagnostics",
    branchGoal: "advance handbook batches without changing student runtime gates before evidence is ready",
    runtimeStudentGate: {
      ordinaryUploadAutoFeedbackReady: controlledCandidate.studentSafeCandidateGateReady,
      m3plusAutoFeedbackReady: false,
      m4OmrAutoScoreReady: false,
      policy: "fail-closed",
    },
    tracks: {
      controlledCandidate,
      m3plusPitchModes,
      m4Omr,
    },
    nextActions: summarizeNextActions(controlledCandidate, m3plusPitchModes, m4Omr),
  };
}

export async function writeProjectStatus(status, out) {
  const outPath = path.resolve(process.cwd(), out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return outPath;
}

function printProjectStatus(status, outPath) {
  const controlledCandidate = status.tracks?.controlledCandidate || {};
  const m3plusPitchModes = status.tracks?.m3plusPitchModes || {};
  const m4Omr = status.tracks?.m4Omr || {};
  console.log(JSON.stringify({
    ok: status.ok,
    runtimeStudentGate: status.runtimeStudentGate,
    controlledCandidate: {
      ready: controlledCandidate.studentSafeCandidateGateReady,
      counts: controlledCandidate.counts,
      confidencePilot: controlledCandidate.confidencePilot,
      blockingReasons: controlledCandidate.blockingReasons,
    },
    m3plusPitchModes: {
      ready: m3plusPitchModes.m3plusModeReleaseReady,
      labelReady: m3plusPitchModes.m3plusModeEvalReady,
      releaseReadyModes: m3plusPitchModes.modeEval?.releaseReadyModes || [],
      controlReadyModes: m3plusPitchModes.modeEval?.controlReadyModes || [],
      counts: m3plusPitchModes.counts,
      blockingReasons: m3plusPitchModes.blockingReasons,
    },
    m4Omr: {
      datasetReady: m4Omr.m4OmrBenchmarkDatasetReady,
      draftQualityReady: m4Omr.m4OmrDraftQualityReady,
      counts: m4Omr.counts,
      blockingReasons: m4Omr.blockingReasons,
    },
    nextActions: status.nextActions,
    out: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await buildProjectStatus();
  const outPath = await writeProjectStatus(status, args.out);
  printProjectStatus(status, outPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
