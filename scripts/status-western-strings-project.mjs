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
const REVIEW_POLICY_DOC = path.join("docs", "western-strings-review-policy.md");
const PUBLIC_BACH_V2_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-bach-violin-v2-audit.json",
);
const PHENICX_ALIGNMENT_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-phenicx-alignment",
  "report.json",
);
const MUSC_CALIBRATION_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-bach-violin-musc-calibration",
  "report.json",
);
const MUSC_FRESH_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-bach-violin-musc-fresh-confirmation",
  "report.json",
);
const VIOLIN_MIDI_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-violin-midi-dataset-audit.json",
);
const V2_ALPHA_MIN_PRECISION = 0.9;
const V2_ALPHA_MIN_COVERAGE = 0.2;

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
const CONTROLLED_ORDINARY_MONITORED_PILOT_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "ordinary-monitored-pilot",
  "ordinary-monitored-pilot-audit.json",
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
const CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-failure-diagnosis.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_ROWS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-failure-diagnosis-rows.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_GROUPS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-failure-diagnosis-groups.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "index.html",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "confidence-recalibration-context-validation-eval.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_ROWS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "confidence-recalibration-context-validation-eval-rows.csv",
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
const M3PLUS_ROUND2_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-round2",
  "index.html",
);
const M3PLUS_ROUND2_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-round2",
  "m3plus-pitch-mode-review.csv",
);
const M3PLUS_ROUND2_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-round2",
  "m3plus-pitch-mode-review.completed.csv",
);
const M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "index.html",
);
const M3PLUS_CANDIDATE_QUALITY_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "m3plus-pitch-mode-review.csv",
);
const M3PLUS_CANDIDATE_QUALITY_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "m3plus-pitch-mode-review.completed.csv",
);
const M3PLUS_MODE_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-eval.json",
);
const M3PLUS_MONITORED_PILOT_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "monitored-pilot",
  "m3plus-monitored-pilot-audit.json",
);
const M3PLUS_MODE_EVAL_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-eval.csv",
);
const M3PLUS_LOCALIZATION_DIAGNOSIS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-localization-diagnosis.json",
);
const M3PLUS_LOCALIZATION_GROUPS_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-localization-diagnosis-groups.csv",
);
const M3PLUS_LOCALIZATION_ROWS_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-localization-diagnosis-rows.csv",
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
const M4_INDEPENDENT_GOLD_TODO_HTML = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-todo.html",
);
const M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-workspace-audit.json",
);
const M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-workspace-audit.csv",
);
const M4_GOLD_PROVENANCE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "gold-provenance-audit.json",
);
const M4_GOLD_PROVENANCE_AUDIT_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "gold-provenance-audit.csv",
);
const RELEASE_REVIEW = path.join(
  "data",
  "experiments",
  "western-strings-release-review.json",
);
const RELEASE_REVIEW_MD = path.join(
  "data",
  "experiments",
  "western-strings-release-review.md",
);
const CONTROLLED_PILOT_DECISION = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-decision.json",
);
const CONTROLLED_PILOT_DECISION_MD = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-decision.md",
);
const CONTROLLED_PILOT_SESSIONS_ROOT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-sessions",
);
const CONTROLLED_PILOT_EVIDENCE_AUDIT_MD = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-evidence-audit.md",
);
const CONTROLLED_PILOT_EVIDENCE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-evidence-audit.json",
);
const FRESH_BLIND_INTAKE_STATUS = path.join(
  "data",
  "experiments",
  "western-strings-v2alpha-blind-intake-status.json",
);
const FRESH_BLIND_INTAKE_STATUS_MD = path.join(
  "data",
  "experiments",
  "western-strings-v2alpha-blind-intake-status.md",
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

async function readControlledPilotSessions(root = CONTROLLED_PILOT_SESSIONS_ROOT) {
  const absoluteRoot = path.resolve(process.cwd(), root);
  let entries = [];
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionPath = path.join(absoluteRoot, entry.name, "session.json");
    const session = await readJson(sessionPath);
    if (!session) continue;
    let selectedSubmissions = Array.isArray(session.selectedSubmissions) ? session.selectedSubmissions : [];
    if (!selectedSubmissions.length && session.artifacts?.precisionSummary) {
      const precision = await readJson(session.artifacts.precisionSummary);
      selectedSubmissions = Array.isArray(precision?.selectedSubmissions) ? precision.selectedSubmissions : [];
    }
    sessions.push({
      ...session,
      selectedSubmissions,
      source: path.relative(process.cwd(), sessionPath).replace(/\\/g, "/"),
    });
  }
  sessions.sort((left, right) => (
    Date.parse(right.generatedAt || "") - Date.parse(left.generatedAt || "")
  ));
  return sessions;
}

function summarizeControlledPilotEvidence(sessions = []) {
  const executed = sessions.filter((session) => session.executionPerformed === true);
  const completedSafe = executed.filter((session) => session.sessionStatus === "completed_safe"
    && session.pilotRunAccepted === true
    && session.defaultRuntimeFailClosedAfter === true
    && session.processEnvironmentRestored === true
    && session.studentFeedbackPublished === false
    && (session.blockingReasons || []).length === 0);
  const recordingIds = new Set();
  const safeRecordingIds = new Set();
  const safePieceIds = new Set();
  const precheckRejectedRecordingIds = new Set();
  for (const session of executed) {
    for (const submission of session.selectedSubmissions || []) {
      const recordingId = String(submission?.recordingId || "").trim();
      if (recordingId) recordingIds.add(recordingId);
      if (recordingId && completedSafe.includes(session)) safeRecordingIds.add(recordingId);
      const piece = String(submission?.piece || "").trim();
      if (piece && completedSafe.includes(session)) safePieceIds.add(piece);
    }
    for (const recordingId of session.additionalExcludedRecordingIds || []) {
      const normalized = String(recordingId || "").trim();
      if (normalized) precheckRejectedRecordingIds.add(normalized);
    }
  }
  const sumMonitoring = (field) => executed.reduce(
    (total, session) => total + Number(session.monitoring?.[field] || 0),
    0,
  );
  const normalizedSafeMonitoring = completedSafe.map((session) => {
    const monitoring = session.monitoring || {};
    const knownUsable = Number(monitoring.knownUsableAutoPassCandidateCount || 0);
    const knownWrong = Number(monitoring.knownWrongAutoPassCandidateCount || 0);
    const unknown = Number(monitoring.unknownAutoPassCandidateCount || 0);
    const modelAutoPass = Number(
      monitoring.modelAutoPassCandidateCount
      ?? monitoring.autoPassCandidateCount
      ?? 0,
    );
    const pilotEligible = Number(
      monitoring.pilotEligibleAutoPassCandidateCount
      ?? monitoring.selfCheckedAutoPassCandidateCount
      ?? (knownUsable + knownWrong + unknown),
    );
    return {
      total: Number(monitoring.totalCandidateCount || 0),
      modelAutoPass,
      pilotEligible,
      suppressed: Number(
        monitoring.suppressedModelAutoPassCandidateCount
        ?? Math.max(0, modelAutoPass - pilotEligible),
      ),
      knownUsable,
      knownWrong,
      unknown,
    };
  });
  const safeSum = (field) => normalizedSafeMonitoring.reduce(
    (total, monitoring) => total + monitoring[field],
    0,
  );
  const safeTotalCandidateCount = safeSum("total");
  const pilotEligibleAutoPassCandidateCount = safeSum("pilotEligible");
  const knownUsableAutoPassCandidateCount = safeSum("knownUsable");
  const knownWrongAutoPassCandidateCount = safeSum("knownWrong");
  const unknownAutoPassCandidateCount = safeSum("unknown");
  const scoredAutoPassCandidateCount = knownUsableAutoPassCandidateCount + knownWrongAutoPassCandidateCount;
  const precision = scoredAutoPassCandidateCount > 0
    ? knownUsableAutoPassCandidateCount / scoredAutoPassCandidateCount
    : null;
  const coverage = safeTotalCandidateCount > 0
    ? pilotEligibleAutoPassCandidateCount / safeTotalCandidateCount
    : 0;
  const meetsPrecisionFloor = precision !== null && precision >= V2_ALPHA_MIN_PRECISION;
  const meetsCoverageFloor = coverage >= V2_ALPHA_MIN_COVERAGE;
  const hasCrossPieceEvidence = safePieceIds.size >= 2;
  return {
    sessionCount: sessions.length,
    executedSessionCount: executed.length,
    completedSafeSessionCount: completedSafe.length,
    distinctRecordingCount: recordingIds.size,
    safeDistinctRecordingCount: safeRecordingIds.size,
    safeDistinctPieceCount: safePieceIds.size,
    recordingIds: [...recordingIds].sort(),
    safeRecordingIds: [...safeRecordingIds].sort(),
    safePieceIds: [...safePieceIds].sort(),
    precheckRejectedRecordingIds: [...precheckRejectedRecordingIds].sort(),
    totalCandidateCount: sumMonitoring("totalCandidateCount"),
    autoPassCandidateCount: sumMonitoring("autoPassCandidateCount"),
    modelAutoPassCandidateCount: safeSum("modelAutoPass"),
    pilotEligibleAutoPassCandidateCount,
    suppressedModelAutoPassCandidateCount: safeSum("suppressed"),
    reviewRequiredCandidateCount: Math.max(0, safeTotalCandidateCount - pilotEligibleAutoPassCandidateCount),
    knownUsableAutoPassCandidateCount,
    knownWrongAutoPassCandidateCount,
    unknownAutoPassCandidateCount,
    v2AlphaGate: {
      minPrecision: V2_ALPHA_MIN_PRECISION,
      minCoverage: V2_ALPHA_MIN_COVERAGE,
      precision,
      coverage,
      meetsPrecisionFloor,
      meetsCoverageFloor,
      hasCrossPieceEvidence,
      ready: completedSafe.length >= 2
        && meetsPrecisionFloor
        && meetsCoverageFloor
        && hasCrossPieceEvidence
        && unknownAutoPassCandidateCount === 0,
    },
  };
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

export function summarizePublicModelValidation({
  phenicxAlignment = null,
  muscCalibration = null,
  muscFresh = null,
  violinMidiAudit = null,
} = {}) {
  const alignmentEngineeringGatePassed = phenicxAlignment?.ok === true
    && phenicxAlignment?.alignmentGatePassed === true;
  const alignmentPolyphonicGatePassed = phenicxAlignment?.polyphonicSubgroupGate?.passed === true;
  const recognitionCalibrationV2Ready = muscCalibration?.ok === true
    && muscCalibration?.calibrationV2Ready === true;
  const recognitionCalibrationV3Ready = muscCalibration?.ok === true
    && muscCalibration?.calibrationV3Ready === true;
  const recognitionFreshV2Ready = muscFresh?.ok === true
    && muscFresh?.freshConfirmationPassed === true
    && muscFresh?.muscV2CoreGatePassed === true;
  const recognitionFreshV3Ready = muscFresh?.ok === true
    && muscFresh?.freshConfirmationPassed === true
    && muscFresh?.muscV3CoreGatePassed === true;
  const doubleStopAutoFeedbackReady = muscFresh?.doubleStopAutoFeedbackEligible === true
    && alignmentPolyphonicGatePassed;
  const weakLabelSourceReady = violinMidiAudit?.ok === true
    && violinMidiAudit?.readyAsWeakLabelSource === true;
  const independentRecognitionBenchmarkReady = violinMidiAudit?.ok === true
    && violinMidiAudit?.readyAsIndependentRecognitionBenchmark === true;
  const publicProfessionalMonophonicV2CandidateReady = alignmentEngineeringGatePassed
    && recognitionCalibrationV2Ready
    && recognitionFreshV2Ready;
  const publicProfessionalMonophonicV3Ready = alignmentEngineeringGatePassed
    && recognitionCalibrationV3Ready
    && recognitionFreshV3Ready;
  const blockingReasons = [];
  if (!phenicxAlignment) blockingReasons.push("phenicx-alignment-report-missing");
  else if (!alignmentEngineeringGatePassed) blockingReasons.push("phenicx-alignment-engineering-gate-failed");
  if (phenicxAlignment?.freshExternalConfirmationRequired === true) {
    blockingReasons.push("phenicx-fresh-external-confirmation-required");
  }
  if (!alignmentPolyphonicGatePassed) blockingReasons.push("phenicx-polyphonic-alignment-gate-failed");
  if (!muscCalibration) blockingReasons.push("musc-calibration-report-missing");
  else if (!recognitionCalibrationV2Ready) blockingReasons.push("musc-v2-calibration-gate-failed");
  if (!muscFresh) blockingReasons.push("musc-fresh-confirmation-report-missing");
  else if (!recognitionFreshV2Ready) blockingReasons.push("musc-v2-fresh-confirmation-failed");
  if (!recognitionFreshV3Ready) blockingReasons.push("musc-v3-strict-gate-failed");
  if (!doubleStopAutoFeedbackReady) blockingReasons.push("double-stop-auto-feedback-not-ready");
  if (!violinMidiAudit) blockingReasons.push("violin-midi-audit-missing");
  else if (!weakLabelSourceReady) blockingReasons.push("violin-midi-weak-label-source-not-ready");
  if (!independentRecognitionBenchmarkReady) {
    blockingReasons.push("violin-midi-not-independent-recognition-gold");
  }
  blockingReasons.push("student-domain-evidence-not-covered");
  return {
    scope: "public-professional-violin-eval-only",
    artifacts: {
      phenicxAlignment: PHENICX_ALIGNMENT_REPORT.replace(/\\/g, "/"),
      muscCalibration: MUSC_CALIBRATION_REPORT.replace(/\\/g, "/"),
      muscFreshConfirmation: MUSC_FRESH_REPORT.replace(/\\/g, "/"),
      violinMidiAudit: VIOLIN_MIDI_AUDIT.replace(/\\/g, "/"),
    },
    alignment: {
      reportAvailable: Boolean(phenicxAlignment),
      engineeringGatePassed: alignmentEngineeringGatePassed,
      polyphonicGatePassed: alignmentPolyphonicGatePassed,
      freshExternalConfirmationRequired: phenicxAlignment?.freshExternalConfirmationRequired === true,
      selectedMethod: phenicxAlignment?.selectedMethod || "",
      gate: phenicxAlignment?.gate || {},
      polyphonicGate: phenicxAlignment?.polyphonicSubgroupGate || {},
    },
    recognition: {
      calibrationReportAvailable: Boolean(muscCalibration),
      freshReportAvailable: Boolean(muscFresh),
      calibrationV2Ready: recognitionCalibrationV2Ready,
      calibrationV3Ready: recognitionCalibrationV3Ready,
      freshConfirmationPassed: muscFresh?.freshConfirmationPassed === true,
      monophonicV2Ready: recognitionFreshV2Ready,
      monophonicV3Ready: recognitionFreshV3Ready,
      doubleStopAutoFeedbackReady,
      postprocessing: muscFresh?.postprocessing || muscCalibration?.selectedPostprocessing || {},
      coreMetrics: muscFresh?.aggregate?.monophonicCore?.musc || {},
      doubleStopStressMetrics: muscFresh?.aggregate?.doubleStopStressReviewOnly?.musc || {},
    },
    weakLabels: {
      reportAvailable: Boolean(violinMidiAudit),
      sourceReady: weakLabelSourceReady,
      independentRecognitionBenchmarkReady,
      counts: violinMidiAudit?.counts || {},
      blockers: violinMidiAudit?.benchmarkBlockers || [],
    },
    gates: {
      publicProfessionalMonophonicV2CandidateReady,
      publicProfessionalMonophonicV3Ready,
      doubleStopAutoFeedbackReady,
      studentReleaseEligible: false,
      nearPerfectReady: false,
    },
    blockingReasons: [...new Set(blockingReasons)],
  };
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

function m3plusLabelKey(row = {}) {
  return [
    "recordingId",
    "scenario",
    "noteIndex",
    "noteId",
    "candidateMode",
    "flags",
    "predictedOnsetSeconds",
  ].map((field) => String(row[field] || "").trim()).join("::");
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
  const monitoredPilotAudit = await readJson(M3PLUS_MONITORED_PILOT_AUDIT);
  const localizationDiagnosis = await readJson(M3PLUS_LOCALIZATION_DIAGNOSIS);
  const candidateQualityReviewPageExists = await exists(M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE);
  const candidateQualityCompletedExists = await exists(M3PLUS_CANDIDATE_QUALITY_COMPLETED);
  const allSourceRows = [...sourceRows];
  const sourceKeys = new Set(sourceRows.map(m3plusLabelKey).filter(Boolean));
  for (const row of labelRows) {
    const key = m3plusLabelKey(row);
    if (key && !sourceKeys.has(key)) {
      allSourceRows.push(row);
      sourceKeys.add(key);
    }
  }
  const labelKeys = new Set(labelRows.map(m3plusLabelKey).filter(Boolean));
  const reviewedRows = labelRows.filter((row) => sourceKeys.has(m3plusLabelKey(row)) && isM3PlusReviewed(row));
  const scoredRows = reviewedRows.filter(isM3PlusScored);
  const sourceModeCounts = countBy(allSourceRows, "candidateMode");
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
    if (localizationDiagnosis?.summary?.nonMatch) {
      modeEvalBlockingReasons.push("m3plus-localization-candidate-quality-blocker");
    }
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
      cumulativeRowCount: allSourceRows.length,
      labelRows: labelRows.length,
      reviewedRows: reviewedRows.length,
      scoredRows: scoredRows.length,
      missingLabelRows: Math.max(0, allSourceRows.length - labelKeys.size),
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
    monitoredPilotAudit: monitoredPilotAudit ? {
      source: M3PLUS_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
      sourceExists: true,
      ok: monitoredPilotAudit.ok === true,
      readyForMonitoredPilot: monitoredPilotAudit.readyForMonitoredPilot === true,
      teacherReviewNeeded: monitoredPilotAudit.teacherReviewNeeded === true,
      defaultM3PlusReadyAfter: monitoredPilotAudit.defaultM3PlusReadyAfter === true,
      releaseModes: monitoredPilotAudit.releaseModes || {},
      blockedModes: monitoredPilotAudit.blockedModes || [],
      blockingReasons: monitoredPilotAudit.blockingReasons || [],
    } : {
      source: M3PLUS_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
      sourceExists: false,
      ok: false,
      readyForMonitoredPilot: false,
      teacherReviewNeeded: false,
      defaultM3PlusReadyAfter: false,
      releaseModes: {},
      blockedModes: [],
      blockingReasons: ["m3plus-monitored-pilot-audit-missing"],
    },
    localizationDiagnosis: {
      source: M3PLUS_LOCALIZATION_DIAGNOSIS.replace(/\\/g, "/"),
      sourceExists: Boolean(localizationDiagnosis),
      summary: localizationDiagnosis?.summary || {},
      highRiskGroups: localizationDiagnosis?.highRiskGroups || [],
    },
    candidateQualityReview: {
      reviewPage: M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE.replace(/\\/g, "/"),
      sourceCsv: M3PLUS_CANDIDATE_QUALITY_SOURCE.replace(/\\/g, "/"),
      completedCsv: M3PLUS_CANDIDATE_QUALITY_COMPLETED.replace(/\\/g, "/"),
      reviewPageExists: candidateQualityReviewPageExists,
      completedCsvExists: candidateQualityCompletedExists,
      needsReview: candidateQualityReviewPageExists && !candidateQualityCompletedExists,
    },
    labelBlockingReasons,
    blockingReasons,
    reviewArtifacts: {
      reviewPage: M3PLUS_REVIEW_PAGE.replace(/\\/g, "/"),
      completedCsv: M3PLUS_COMPLETED.replace(/\\/g, "/"),
      labelsCsv: M3PLUS_LABELS.replace(/\\/g, "/"),
      modeEvalJson: M3PLUS_MODE_EVAL.replace(/\\/g, "/"),
      monitoredPilotAuditJson: M3PLUS_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
      modeEvalCsv: M3PLUS_MODE_EVAL_CSV.replace(/\\/g, "/"),
      localizationDiagnosisJson: M3PLUS_LOCALIZATION_DIAGNOSIS.replace(/\\/g, "/"),
      localizationDiagnosisGroupsCsv: M3PLUS_LOCALIZATION_GROUPS_CSV.replace(/\\/g, "/"),
      localizationDiagnosisRowsCsv: M3PLUS_LOCALIZATION_ROWS_CSV.replace(/\\/g, "/"),
      round2ReviewPage: M3PLUS_ROUND2_REVIEW_PAGE.replace(/\\/g, "/"),
      round2SourceCsv: M3PLUS_ROUND2_SOURCE.replace(/\\/g, "/"),
      round2CompletedCsv: M3PLUS_ROUND2_COMPLETED.replace(/\\/g, "/"),
      candidateQualityReviewPage: M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE.replace(/\\/g, "/"),
      candidateQualitySourceCsv: M3PLUS_CANDIDATE_QUALITY_SOURCE.replace(/\\/g, "/"),
      candidateQualityCompletedCsv: M3PLUS_CANDIDATE_QUALITY_COMPLETED.replace(/\\/g, "/"),
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
  const runtimeRelease = await readJson(CONTROLLED_CONFIDENCE_RELEASE);
  const confidencePilot = summarizeControlledCandidateConfidencePilot(
    await readJson(CONTROLLED_CONFIDENCE_PILOT),
    CONTROLLED_CONFIDENCE_PILOT,
    await readJson(CONTROLLED_CONFIDENCE_VALIDATION_EVAL),
    runtimeRelease,
    await readJson(CONTROLLED_CONFIDENCE_RELEASE_AUDIT),
    await readJson(CONTROLLED_ORDINARY_MONITORED_PILOT_AUDIT),
  );
  const status = attachConfidencePilotStatus(buildControlledCandidateReviewStatus(report), confidencePilot);
  const recalibrationPilot = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT);
  const recalibrationEval = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL);
  const recalibrationContextEval = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL);
  const recalibrationFailureDiagnosis = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS);
  const recalibrationReleaseCandidate = bestDeployableReleaseCandidate(recalibrationPilot);
  const recalibrationEvalExists = Boolean(recalibrationEval);
  const recalibrationContextReviewExists = await exists(CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE);
  const recalibrationContextEvalExists = Boolean(recalibrationContextEval);
  const recalibrationNeedsBlindValidation = Boolean(
    recalibrationReleaseCandidate
    && !recalibrationEvalExists
  );
  const recalibrationValidationFailed = Boolean(
    recalibrationReleaseCandidate
    && recalibrationEvalExists
    && !recalibrationEval?.blindValidationPassed
  );
  const recalibrationContextNeedsBlindValidation = Boolean(
    recalibrationValidationFailed
    && recalibrationContextReviewExists
    && !recalibrationContextEvalExists
  );
  const recalibrationContextValidationFailed = Boolean(
    recalibrationContextEvalExists
    && !recalibrationContextEval?.blindValidationPassed
  );
  const recalibrationContextValidationPassed = Boolean(
    recalibrationContextEvalExists
    && recalibrationContextEval?.blindValidationPassed
  );
  const normalizedReleaseValidationSource = String(runtimeRelease?.blindValidation?.source || "").replace(/\\/g, "/");
  const normalizedReleaseLabelsSource = String(runtimeRelease?.trainingLabels?.source || runtimeRelease?.labels?.source || "").replace(/\\/g, "/");
  const recalibrationContextRuntimeWired = Boolean(
    recalibrationContextValidationPassed
    && normalizedReleaseValidationSource === CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL.replace(/\\/g, "/")
    && normalizedReleaseLabelsSource === CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS.replace(/\\/g, "/")
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
    failureDiagnosis: {
      source: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS.replace(/\\/g, "/"),
      sourceExists: Boolean(recalibrationFailureDiagnosis),
      summary: recalibrationFailureDiagnosis?.summary || {},
    },
    contextValidation: {
      reviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
      completedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_COMPLETED.replace(/\\/g, "/"),
      evalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL.replace(/\\/g, "/"),
      rowsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_ROWS.replace(/\\/g, "/"),
      reviewPageExists: recalibrationContextReviewExists,
      validationEval: recalibrationContextEval || {
        sourceExists: false,
        blindValidationPassed: false,
        blockingReasons: ["confidence-recalibration-context-validation-eval-missing"],
      },
      needsBlindValidation: recalibrationContextNeedsBlindValidation,
      validationFailed: recalibrationContextValidationFailed,
      validationPassed: recalibrationContextValidationPassed,
      runtimeWired: recalibrationContextRuntimeWired,
      runtimeReleaseSource: CONTROLLED_CONFIDENCE_RELEASE.replace(/\\/g, "/"),
    },
    needsBlindValidation: recalibrationNeedsBlindValidation,
    validationFailed: recalibrationValidationFailed,
  };
  if (recalibrationContextNeedsBlindValidation) {
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-context-validation-needed",
      ]),
    ];
    status.nextActions = [
      "Review the 30-row context-feature confidence recalibration pack; if the CSV downloads to Downloads, run `npm run western:ingest-review-downloads -- --apply`, then run western:controlled-candidate-confidence-recalibration-context-validation-eval.",
    ];
  } else if (recalibrationContextValidationFailed) {
    const precision = recalibrationContextEval?.metrics?.precision;
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-context-validation-failed",
      ]),
    ];
    status.nextActions = [
      `The context-feature confidence recalibration blind-validation pack failed${Number.isFinite(precision) ? ` (precision=${precision})` : ""}; keep the ordinary-upload auto gate fail-closed and inspect the context validation rows before another recalibration attempt.`,
    ];
  } else if (recalibrationContextValidationPassed && !recalibrationContextRuntimeWired) {
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-context-runtime-not-wired",
      ]),
    ];
    status.nextActions = [
      "The context-feature confidence recalibration validation passed, but the runtime gate is not wired or enabled. Review the release manifest and add a monitored, disabled-by-default runtime integration before any student-facing use.",
    ];
  } else if (recalibrationContextValidationPassed && recalibrationContextRuntimeWired) {
    // The context-feature recalibration is the current evidence source and supersedes
    // the earlier 10-row recalibration validation failure.
  } else if (recalibrationNeedsBlindValidation) {
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-validation-needed",
      ]),
    ];
    status.nextActions = [
      "Review the confidence recalibration blind-validation pack; if the CSV downloads to Downloads, run `npm run western:ingest-review-downloads -- --apply`, then run western:controlled-candidate-confidence-recalibration-validation-eval.",
    ];
  } else if (recalibrationValidationFailed) {
    const precision = recalibrationEval?.metrics?.precision;
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-validation-failed",
      ]),
    ];
    status.nextActions = [
      `The confidence recalibration blind-validation pack failed${Number.isFinite(precision) ? ` (precision=${precision})` : ""}; do not enable the ordinary-upload auto gate. Inspect the failure diagnosis and improve candidate/localization quality features or collect stronger calibration evidence before exporting another blind-validation pack.`,
    ];
  }
  status.reviewArtifacts = {
    reviewPage: CONTROLLED_REVIEW_PAGE.replace(/\\/g, "/"),
    completedCsv: CONTROLLED_COMPLETED.replace(/\\/g, "/"),
    labelsCsv: CONTROLLED_LABELS.replace(/\\/g, "/"),
    releaseAuditJson: CONTROLLED_CONFIDENCE_RELEASE_AUDIT.replace(/\\/g, "/"),
    ordinaryMonitoredPilotAuditJson: CONTROLLED_ORDINARY_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
    thresholdPoolReviewPage: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_REVIEW_PAGE.replace(/\\/g, "/"),
    thresholdPoolCompletedCsv: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_COMPLETED.replace(/\\/g, "/"),
    thresholdPoolEvalJson: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_EVAL.replace(/\\/g, "/"),
    thresholdPoolDiagnosisJson: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_DIAGNOSIS.replace(/\\/g, "/"),
    recalibrationLabelsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS.replace(/\\/g, "/"),
    recalibrationPilotJson: CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT.replace(/\\/g, "/"),
    recalibrationValidationReviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    recalibrationValidationCompletedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    recalibrationValidationEvalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL.replace(/\\/g, "/"),
    recalibrationFailureDiagnosisJson: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS.replace(/\\/g, "/"),
    recalibrationFailureDiagnosisRowsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_ROWS.replace(/\\/g, "/"),
    recalibrationFailureDiagnosisGroupsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_GROUPS.replace(/\\/g, "/"),
    recalibrationContextValidationReviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    recalibrationContextValidationCompletedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    recalibrationContextValidationEvalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL.replace(/\\/g, "/"),
    recalibrationContextValidationRowsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_ROWS.replace(/\\/g, "/"),
  };
  return status;
}

async function buildM4OmrStatus() {
  const readiness = await readJson(M4_READINESS);
  const benchmark = await readJson(M4_BENCHMARK);
  const workspaceAudit = await readJson(M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT);
  const provenanceAudit = await readJson(M4_GOLD_PROVENANCE_AUDIT);
  const readinessReady = Boolean(readiness?.gate?.m4OmrBenchmarkDatasetReady);
  const benchmarkEvaluated = Boolean(benchmark?.gate?.m4OmrBenchmarkEvaluated);
  const draftQualityReady = Boolean(benchmark?.gate?.m4OmrDraftQualityReady);
  const provenanceCounts = provenanceAudit?.counts || {};
  const manualGoldRequiredRows = Number(provenanceCounts.manualGoldRequiredRows || 0);
  const humanTask = manualGoldRequiredRows > 0 ? "score-editor-independent-gold-correction" : "none";
  const humanTaskScope = manualGoldRequiredRows > 0
    ? "Correct MusicXML/MXL against source score images only; do not ask for audio diagnosis review."
    : "No score-editor correction is currently required; unchanged drafts are usable only because prior clean-score review approved them.";
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
    teacherReviewNeeded: false,
    humanTask,
    humanTaskScope,
    reason: "omr-status-only",
    counts: {
      readinessRows: readiness?.counts?.intakeRows || 0,
      pairReadyRows: readiness?.counts?.pairReadyRows || 0,
      benchmarkRows: benchmark?.counts?.rows || 0,
      parseOkRows: benchmark?.counts?.parseOkRows || 0,
      usableBenchmarkRows: benchmark?.counts?.usableBenchmarkRows || 0,
      sameHashRows: benchmark?.counts?.sameHashRows || 0,
      humanApprovedUnchangedRows: benchmark?.counts?.humanApprovedUnchangedRows || 0,
      selfComparisonRows: benchmark?.counts?.selfComparisonRows || 0,
      blockedRows: benchmark?.counts?.blockedRows || 0,
    },
    blockingReasons,
    artifacts: {
      readinessJson: M4_READINESS.replace(/\\/g, "/"),
      benchmarkJson: M4_BENCHMARK.replace(/\\/g, "/"),
      independentGoldTodo: M4_INDEPENDENT_GOLD_TODO.replace(/\\/g, "/"),
      independentGoldTodoHtml: M4_INDEPENDENT_GOLD_TODO_HTML.replace(/\\/g, "/"),
      independentGoldWorkspaceAuditJson: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT.replace(/\\/g, "/"),
      independentGoldWorkspaceAuditCsv: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT_CSV.replace(/\\/g, "/"),
      goldProvenanceAuditJson: M4_GOLD_PROVENANCE_AUDIT.replace(/\\/g, "/"),
      goldProvenanceAuditCsv: M4_GOLD_PROVENANCE_AUDIT_CSV.replace(/\\/g, "/"),
      readinessCsv: String(readiness?.artifacts?.csv || "data/experiments/western-strings-m4/omr-readiness.csv").replace(/\\/g, "/"),
      benchmarkCsv: String(benchmark?.artifacts?.csv || "data/experiments/western-strings-m4/omr-benchmark.csv").replace(/\\/g, "/"),
    },
    independentGoldWorkspaceAudit: workspaceAudit
      ? {
          source: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT.replace(/\\/g, "/"),
          readyForApply: Boolean(workspaceAudit.readyForApply),
          counts: workspaceAudit.counts || {},
        }
      : {
          source: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT.replace(/\\/g, "/"),
          readyForApply: false,
          counts: {},
          missing: true,
        },
    goldProvenanceAudit: provenanceAudit
      ? {
          source: M4_GOLD_PROVENANCE_AUDIT.replace(/\\/g, "/"),
          counts: provenanceAudit.counts || {},
          teacherReviewNeeded: Boolean(provenanceAudit.teacherReviewNeeded),
          humanTask: provenanceAudit.humanTask || "",
          conclusion: provenanceAudit.conclusion || "",
        }
      : {
          source: M4_GOLD_PROVENANCE_AUDIT.replace(/\\/g, "/"),
          counts: {},
          missing: true,
        },
  };
}

function summarizeNextActions(
  controlled,
  m3plus,
  m4Omr,
  releaseReview,
  controlledPilotDecision,
  controlledPilotSession,
  controlledPilotEvidence,
  controlledPilotMachineAudit,
  freshBlindIntake,
) {
  const actions = [];
  const ordinaryBlockers = controlled.blockingReasons || [];
  const ordinaryPilotAudit = controlled.confidencePilot?.monitoredPilotAudit || {};
  const ordinaryPilotEvidencePassed = ordinaryPilotAudit.readyForMonitoredPilot === true
    && ordinaryPilotAudit.teacherReviewNeeded !== true
    && ordinaryPilotAudit.defaultOrdinaryReadyAfter !== true
    && (ordinaryPilotAudit.blockingReasons || []).length === 0;
  const ordinaryOnlyDefaultDisabled = ordinaryBlockers.length > 0
    && ordinaryBlockers.every((reason) => reason === "ordinary-auto-gate-disabled-by-default");
  const m3plusAudit = m3plus.monitoredPilotAudit || {};
  const m3plusPilotEvidencePassed = m3plusAudit.readyForMonitoredPilot === true
    && m3plusAudit.teacherReviewNeeded !== true
    && m3plusAudit.defaultM3PlusReadyAfter !== true
    && (m3plusAudit.blockingReasons || []).length === 0;
  if (!controlled.studentSafeCandidateGateReady && !(ordinaryPilotEvidencePassed && ordinaryOnlyDefaultDisabled)) {
    const ordinaryArtifact = (controlled.blockingReasons || []).includes("ordinary-confidence-recalibration-context-validation-needed")
      ? (controlled.reviewArtifacts.recalibrationContextValidationReviewPage || controlled.confidenceRecalibration?.contextValidation?.reviewPage)
      : (controlled.blockingReasons || []).includes("ordinary-confidence-recalibration-context-validation-failed")
      ? (controlled.reviewArtifacts.recalibrationContextValidationEvalJson || controlled.confidenceRecalibration?.contextValidation?.evalJson)
      : (controlled.blockingReasons || []).includes("ordinary-confidence-recalibration-context-runtime-not-wired")
      ? (controlled.reviewArtifacts.recalibrationContextValidationEvalJson || controlled.confidenceRecalibration?.contextValidation?.evalJson)
      : (controlled.blockingReasons || []).includes("ordinary-confidence-recalibration-validation-needed")
      ? (controlled.reviewArtifacts.recalibrationValidationReviewPage || controlled.confidenceRecalibration?.validationReviewPage)
      : (controlled.blockingReasons || []).includes("ordinary-confidence-recalibration-validation-failed")
      ? (controlled.reviewArtifacts.recalibrationFailureDiagnosisJson || controlled.reviewArtifacts.recalibrationValidationEvalJson || controlled.confidenceRecalibration?.validationEvalJson)
      : (controlled.blockingReasons || []).includes("ordinary-confidence-threshold-pool-precision-too-low")
      ? (controlled.reviewArtifacts.thresholdPoolDiagnosisJson || controlled.confidencePilot?.thresholdPoolEvalJson)
      : (controlled.reviewArtifacts.releaseAuditJson || controlled.confidencePilot?.thresholdPoolEvalJson || controlled.confidencePilot?.thresholdPoolReviewPage || controlled.reviewArtifacts.thresholdPoolReviewPage || controlled.confidencePilot?.validationReviewPage || controlled.reviewArtifacts.reviewPage);
    actions.push({
      priority: 1,
      track: "M2/M3 ordinary upload candidate gate",
      action: controlled.nextActions?.[0] || "Finish the current blind review batch, run `npm run western:ingest-review-downloads -- --apply` if the CSV is in Downloads, then rerun gate/status.",
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
    const counts = m3plus.modeEval?.counts || {};
    const localizationSummary = m3plus.localizationDiagnosis?.summary || {};
    const candidateQualityReview = m3plus.candidateQualityReview || {};
    const mismatchText = counts.rows
      ? ` Current eval has ${counts.match || 0} match, ${counts.mismatch || 0} mismatch, and ${Math.max(0, (counts.rows || 0) - (counts.match || 0) - (counts.mismatch || 0))} uncertain/other rows out of ${counts.rows}; fix score-audio localization/candidate quality before another release attempt.`
      : "";
    const localizationText = localizationSummary.total
      ? ` Localization diagnosis reports ${localizationSummary.nonMatch || 0}/${localizationSummary.total} non-match rows (${Math.round((localizationSummary.nonMatchRate || 0) * 100)}%).`
      : "";
    actions.push({
      priority: 2,
      track: "M3+ pitch behavior modes",
      action: candidateQualityReview.needsReview
        ? `M3+ labels are sufficient and round-2 is imported, but no non-control pitch-behavior mode is release-ready.${mismatchText}${localizationText} The candidate-quality review pack is now restricted to first-measure rows from recordings whose prior review rows were all audio-score matches; later measures are treated as localization-drift risk and excluded.`
        : `M3+ labels are sufficient and round-2 is imported, but no non-control pitch-behavior mode is release-ready.${mismatchText}${localizationText} Keep M3+ review-only and inspect localization groups before changing candidate generation.`,
      artifact: candidateQualityReview.needsReview
        ? candidateQualityReview.reviewPage
        : (m3plus.reviewArtifacts.localizationDiagnosisGroupsCsv || m3plus.reviewArtifacts.modeEvalCsv || m3plus.reviewArtifacts.modeEvalJson),
      reason: m3plus.blockingReasons,
    });
  } else if (!m3plus.studentGateReady && !m3plusPilotEvidencePassed) {
    actions.push({
      priority: 2,
      track: "M3+ pitch behavior modes",
      action: `M3+ first-measure offline evidence now passes for ${(m3plus.modeEval?.releaseReadyModes || []).join(", ") || "mode-specific"} pitch-judgement modes. Run npm run western:m3plus-monitored-pilot-audit before any product pilot; keep default runtime fail-closed and do not request more M3+ review for the current pack unless the audit reports unknown or unsafe rows.`,
      artifact: m3plus.reviewArtifacts.monitoredPilotAuditJson || m3plus.reviewArtifacts.modeEvalJson || m3plus.reviewArtifacts.modeEvalCsv,
      reason: ["m3plus-runtime-disabled-by-default", "m3plus-first-measure-scope-only"],
    });
  }
  if (!m4Omr.m4OmrDraftQualityReady) {
    actions.push({
      priority: 3,
      track: "M4 OMR benchmark",
      action: "Machine checks found only self-comparison OMR rows. Do not request teacher audio diagnosis; prepare independent score-editor gold by correcting workspace MXL files against the source score images, then rerun `npm run western:m4-omr-benchmark`.",
      artifact: m4Omr.artifacts.independentGoldTodoHtml || m4Omr.artifacts.independentGoldTodo,
      humanTask: m4Omr.humanTask,
      teacherReviewNeeded: m4Omr.teacherReviewNeeded,
      reason: m4Omr.blockingReasons,
    });
  }
  if (!actions.length) {
    if (releaseReview?.readyForControlledPilot === true
      && releaseReview?.teacherReviewNeeded !== true
      && releaseReview?.runtimeFailClosed === true) {
      if (!controlledPilotDecision) {
        actions.push({
          priority: 1,
          track: "Controlled pilot decision",
          action: "Release review passed. Run `npm run western:controlled-pilot-decision` to produce the explicit machine-tested decision packet before asking for any more human/teacher review.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: ["decision-packet-missing", "default-runtime-fail-closed"],
        });
      } else if (controlledPilotSession?.sessionStatus === "completed_safe"
        && controlledPilotSession?.executionPerformed === true
        && controlledPilotSession?.pilotRunAccepted === true
        && controlledPilotSession?.defaultRuntimeFailClosedAfter === true
        && controlledPilotSession?.processEnvironmentRestored === true
        && controlledPilotSession?.studentFeedbackPublished === false
        && (controlledPilotSession?.blockingReasons || []).length === 0) {
        const v2AlphaGate = controlledPilotEvidence?.v2AlphaGate || {};
        const scopedCandidate = controlledPilotMachineAudit?.scopedV2AlphaCandidate || {};
        if (scopedCandidate.teacherReviewAllowed === true) {
          const sharedEvidence = `Machine testing passes only for scope=${scopedCandidate.scopeName}: historical precision/coverage=${(Number(scopedCandidate.historical?.precision || 0) * 100).toFixed(2)}%/${(Number(scopedCandidate.historical?.coverage || 0) * 100).toFixed(2)}%, operational precision/coverage=${(Number(scopedCandidate.operational?.knownPrecision || 0) * 100).toFixed(2)}%/${(Number(scopedCandidate.operational?.coverage || 0) * 100).toFixed(2)}% across ${scopedCandidate.operationalRecordingCount || 0} recordings.`;
          if (freshBlindIntake?.readyForMachinePrecheck === true) {
            actions.push({
              priority: 1,
              track: "Fresh blind machine precheck",
              action: `${sharedEvidence} Fresh intake ${freshBlindIntake.candidate?.recordingId || ""} passed novelty, audio, score, approval, and first-measure checks. Stage only this candidate into the controlled intake and run the ordinary machine precheck. Do not generate a professional pack until that precheck passes; later measures remain review_required and default runtime stays fail-closed.`,
              artifact: FRESH_BLIND_INTAKE_STATUS_MD.replace(/\\/g, "/"),
              teacherReviewNeeded: false,
              reason: ["fresh-blind-machine-precheck-not-run", "first-measure-only", "default-runtime-fail-closed"],
            });
          } else {
            actions.push({
              priority: 1,
              track: "Scoped V2-alpha blind audit preparation",
              action: `${sharedEvidence} Do not reuse the current labels. Put one new independent recording, clean reviewed MusicXML/MXL, and score image/PDF in the private intake directory, then use npm run western:fresh-blind-intake-stage with explicit recording/piece/reviewer metadata. The command audits a temporary manifest and replaces intake.json only after every check passes. Confirm with npm run western:fresh-blind-intake-status. Generate a professional pack only after that intake and the ordinary machine precheck pass; all later measures remain review_required and default runtime stays fail-closed.`,
              artifact: FRESH_BLIND_INTAKE_STATUS_MD.replace(/\\/g, "/"),
              teacherReviewNeeded: false,
              reason: [
                ...(freshBlindIntake?.blockingReasons || ["fresh-blind-intake-status-missing"]),
                "fresh-blind-pack-not-prepared",
                "first-measure-only",
                "default-runtime-fail-closed",
              ],
            });
          }
        } else if (v2AlphaGate.ready !== true) {
          const precisionPercent = v2AlphaGate.precision === null || v2AlphaGate.precision === undefined
            ? "unavailable"
            : `${(Number(v2AlphaGate.precision) * 100).toFixed(2)}%`;
          const coveragePercent = `${(Number(v2AlphaGate.coverage || 0) * 100).toFixed(2)}%`;
          const reasons = ["default-runtime-fail-closed"];
          if (v2AlphaGate.meetsPrecisionFloor !== true) reasons.push("controlled-pilot-precision-below-v2-alpha");
          if (v2AlphaGate.meetsCoverageFloor !== true) reasons.push("controlled-pilot-coverage-below-v2-alpha");
          if (v2AlphaGate.hasCrossPieceEvidence !== true) reasons.push("controlled-pilot-cross-piece-evidence-missing");
          actions.push({
            priority: 1,
            track: "Controlled pilot coverage audit",
            action: `The machine-only controlled pilot is safe but not V2-alpha: strict self-check precision=${precisionPercent}, effective coverage=${coveragePercent} (${controlledPilotEvidence?.pilotEligibleAutoPassCandidateCount || 0}/${controlledPilotEvidence?.totalCandidateCount || 0}). Keep every non-self-checked model auto-pass suppressed and do not request teacher review yet. The evidence audit rules out threshold tuning alone; improve candidate/localization evidence, then rerun the offline gate.`,
            artifact: CONTROLLED_PILOT_EVIDENCE_AUDIT_MD.replace(/\\/g, "/"),
            teacherReviewNeeded: false,
            reason: reasons,
          });
        } else {
          actions.push({
            priority: 1,
            track: "Controlled pilot completed",
            action: `Controlled pilot evidence now has ${controlledPilotEvidence?.completedSafeSessionCount || 0} safe session(s) across ${controlledPilotEvidence?.safeDistinctRecordingCount || 0} independent recording(s), and it meets the V2-alpha precision/coverage floors. Keep the default student runtime fail-closed; use a fresh blind professional audit before any release decision.`,
            artifact: controlledPilotSession.artifacts?.sessionMd || controlledPilotSession.source,
            reason: ["controlled-pilot-completed-safe", "default-runtime-fail-closed"],
          });
        }
      } else if (controlledPilotDecision.readyToStartControlledPilot === true) {
        actions.push({
          priority: 1,
          track: "Start monitored pilot",
          action: "Controlled-pilot approval is present and machine checks are green. Run `npm run western:controlled-pilot-run -- --execute --limit 1` for one offline monitored batch; keep default student runtime fail-closed.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: ["approved-monitored-pilot-only"],
        });
      } else if (controlledPilotDecision.approvalDeferred === true) {
        actions.push({
          priority: 1,
          track: "Controlled pilot deferred",
          action: "The product owner explicitly deferred the monitored pilot. Keep the system safely review-only/fail-closed and do not ask for more teacher review for this release decision.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: controlledPilotDecision.blockingReasons || ["controlled-pilot-explicitly-deferred"],
        });
      } else {
        actions.push({
          priority: 1,
          track: "Controlled pilot approval",
          action: "Machine self-tests are complete and no teacher review is needed now. The only remaining action is product-owner approval of the separate monitored pilot, or stop safely in review-only mode.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: controlledPilotDecision.blockingReasons || ["controlled-pilot-approval-missing"],
        });
      }
    } else {
      actions.push({
        priority: 1,
        track: "Release review",
        action: "Both label gates have enough data for offline evaluation. Run `npm run western:release-review` to aggregate ordinary, M3+, and M4 machine checks before touching any runtime gate.",
        artifact: RELEASE_REVIEW_MD.replace(/\\/g, "/"),
        reason: [],
      });
    }
  }
  return actions;
}

const PHOTO_SCORE_BATCH_RUNS = path.join(
  "data", "experiments", "western-strings-m4", "photo-score-batch-runs.jsonl",
);

async function readPhotoScoreChainStatus() {
  // Display-only visibility for the offline photo-score chain (intake ->
  // accepted_for_batch -> western:photo-score-batch). Never feeds any gate.
  const base = {
    wired: true,
    studentFacing: false,
    intake: "POST /api/strings/analyze with scorePhotoPath (kind=photo-score, review_required)",
    batchCommand: "npm run western:photo-score-batch",
    source: PHOTO_SCORE_BATCH_RUNS.replace(/\\/g, "/"),
  };
  try {
    const text = await fs.readFile(PHOTO_SCORE_BATCH_RUNS, "utf8");
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const decisions = {};
    for (const row of rows) {
      const key = row.status === "ok" ? String(row.decision || "").split(":")[0] || "ok" : `failed:${row.reason || "unknown"}`;
      decisions[key] = (decisions[key] || 0) + 1;
    }
    return { ...base, batchRuns: rows.length, decisions };
  } catch {
    return { ...base, batchRuns: 0, decisions: {} };
  }
}

export async function buildProjectStatus(args = {}) {
  const [
    controlledCandidate,
    m3plusPitchModes,
    m4Omr,
    releaseReview,
    controlledPilotDecision,
    controlledPilotSessions,
    controlledPilotMachineAudit,
    freshBlindIntake,
    publicBachV2Audit,
    phenicxAlignment,
    muscCalibration,
    muscFresh,
    violinMidiAudit,
  ] = await Promise.all([
    buildControlledStatus(),
    buildM3PlusStatus(),
    buildM4OmrStatus(),
    readJson(RELEASE_REVIEW),
    readJson(CONTROLLED_PILOT_DECISION),
    readControlledPilotSessions(args.controlledPilotSessionsRoot),
    readJson(CONTROLLED_PILOT_EVIDENCE_AUDIT),
    readJson(FRESH_BLIND_INTAKE_STATUS),
    readJson(PUBLIC_BACH_V2_AUDIT),
    readJson(PHENICX_ALIGNMENT_REPORT),
    readJson(MUSC_CALIBRATION_REPORT),
    readJson(MUSC_FRESH_REPORT),
    readJson(VIOLIN_MIDI_AUDIT),
  ]);
  const controlledPilotSession = controlledPilotSessions.find((session) => session.executionPerformed === true)
    || controlledPilotSessions[0]
    || null;
  const controlledPilotEvidence = summarizeControlledPilotEvidence(controlledPilotSessions);
  const publicModelValidation = summarizePublicModelValidation({
    phenicxAlignment,
    muscCalibration,
    muscFresh,
    violinMidiAudit,
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    project: "western-strings-practice-diagnostics",
    branchGoal: "advance handbook batches without changing student runtime gates before evidence is ready",
    reviewPolicy: {
      source: REVIEW_POLICY_DOC.replace(/\\/g, "/"),
      rule: "machine-self-test-before-human-review",
    },
    runtimeStudentGate: {
      ordinaryUploadAutoFeedbackReady: controlledCandidate.studentSafeCandidateGateReady,
      m3plusAutoFeedbackReady: false,
      m4OmrAutoScoreReady: false,
      policy: "fail-closed",
    },
    photoScoreOfflineChain: await readPhotoScoreChainStatus(),
    publicProfessionalBenchmark: publicBachV2Audit
      ? {
          source: PUBLIC_BACH_V2_AUDIT.replace(/\\/g, "/"),
          scope: publicBachV2Audit.scope || "public-professional-violin-recordings",
          publicProfessionalV2AlphaReady: publicBachV2Audit.gates?.publicProfessionalV2AlphaReady === true,
          publicEventV3PrototypeReady: publicBachV2Audit.gates?.publicEventV3PrototypeReady === true,
          publicRawAudioCorePrototypeReady: publicBachV2Audit.gates?.publicRawAudioCorePrototypeReady === true,
          publicWeakNotePrototypeReady: publicBachV2Audit.gates?.publicWeakNotePrototypeReady === true,
          v3Ready: publicBachV2Audit.gates?.v3Ready === true,
          nearPerfectReady: publicBachV2Audit.gates?.nearPerfectReady === true,
          defaultStudentReleaseEligible: publicBachV2Audit.gates?.defaultStudentReleaseEligible === true,
          blockingReasons: publicBachV2Audit.blockingReasons || [],
        }
      : {
          source: PUBLIC_BACH_V2_AUDIT.replace(/\\/g, "/"),
          missing: true,
          defaultStudentReleaseEligible: false,
        },
    publicModelValidation,
    releaseReview: releaseReview
      ? {
          source: RELEASE_REVIEW.replace(/\\/g, "/"),
          summary: RELEASE_REVIEW_MD.replace(/\\/g, "/"),
          readyForControlledPilot: releaseReview.readyForControlledPilot === true,
          readyForDefaultStudentRelease: releaseReview.readyForDefaultStudentRelease === true,
          teacherReviewNeeded: releaseReview.teacherReviewNeeded === true,
          runtimeFailClosed: releaseReview.runtimeFailClosed === true,
        }
      : {
          source: RELEASE_REVIEW.replace(/\\/g, "/"),
          summary: RELEASE_REVIEW_MD.replace(/\\/g, "/"),
          missing: true,
        },
    controlledPilotDecision: controlledPilotDecision
      ? {
          source: CONTROLLED_PILOT_DECISION.replace(/\\/g, "/"),
          summary: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          readyForControlledPilotDecision: controlledPilotDecision.readyForControlledPilotDecision === true,
          readyToStartControlledPilot: controlledPilotDecision.readyToStartControlledPilot === true,
          approvalRequired: controlledPilotDecision.approvalRequired === true,
          approvalPresent: controlledPilotDecision.approvalPresent === true,
          approvalDeferred: controlledPilotDecision.approvalDeferred === true,
          runtimeFailClosed: controlledPilotDecision.runtimeFailClosed === true,
          blockingReasons: controlledPilotDecision.blockingReasons || [],
        }
      : {
          source: CONTROLLED_PILOT_DECISION.replace(/\\/g, "/"),
          summary: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          missing: true,
        },
    controlledPilotSession: controlledPilotSession
      ? {
          source: controlledPilotSession.source,
          sessionId: controlledPilotSession.sessionId || "",
          generatedAt: controlledPilotSession.generatedAt || "",
          sessionStatus: controlledPilotSession.sessionStatus || "",
          executionPerformed: controlledPilotSession.executionPerformed === true,
          pilotRunAccepted: controlledPilotSession.pilotRunAccepted === true,
          approvedBy: controlledPilotSession.approvedBy || "",
          selectedSubmissions: controlledPilotSession.selectedSubmissions || [],
          historyExcludedRecordingIds: controlledPilotSession.historyExcludedRecordingIds || [],
          additionalExcludedRecordingIds: controlledPilotSession.additionalExcludedRecordingIds || [],
          effectiveExcludedRecordingIds: controlledPilotSession.effectiveExcludedRecordingIds || [],
          monitoring: controlledPilotSession.monitoring || {},
          defaultRuntimeFailClosedAfter: controlledPilotSession.defaultRuntimeFailClosedAfter === true,
          processEnvironmentRestored: controlledPilotSession.processEnvironmentRestored === true,
          studentFeedbackPublished: controlledPilotSession.studentFeedbackPublished === true,
          blockingReasons: controlledPilotSession.blockingReasons || [],
          artifacts: controlledPilotSession.artifacts || {},
        }
      : {
          source: CONTROLLED_PILOT_SESSIONS_ROOT.replace(/\\/g, "/"),
          missing: true,
        },
    controlledPilotEvidence,
    controlledPilotMachineAudit: controlledPilotMachineAudit
      ? {
          source: CONTROLLED_PILOT_EVIDENCE_AUDIT.replace(/\\/g, "/"),
          machinePreflightPassed: controlledPilotMachineAudit.machinePreflightPassed === true,
          teacherReviewAllowed: controlledPilotMachineAudit.teacherReviewAllowed === true,
          thresholdDiagnostic: controlledPilotMachineAudit.thresholdDiagnostic
            ? {
                operationalCandidateRows: controlledPilotMachineAudit.thresholdDiagnostic.operationalCandidateRows || 0,
                operationalKnownLabelRows: controlledPilotMachineAudit.thresholdDiagnostic.operationalKnownLabelRows || 0,
                simpleThresholdCandidateFound: controlledPilotMachineAudit.thresholdDiagnostic.simpleThresholdCandidateFound === true,
                conclusion: controlledPilotMachineAudit.thresholdDiagnostic.conclusion || "",
              }
            : {},
          scopedV2AlphaCandidate: controlledPilotMachineAudit.scopedV2AlphaCandidate || {},
          blockingReasons: controlledPilotMachineAudit.blockingReasons || [],
        }
      : {
          source: CONTROLLED_PILOT_EVIDENCE_AUDIT.replace(/\\/g, "/"),
          missing: true,
        },
    freshBlindIntake: freshBlindIntake
      ? {
          source: FRESH_BLIND_INTAKE_STATUS.replace(/\\/g, "/"),
          summary: FRESH_BLIND_INTAKE_STATUS_MD.replace(/\\/g, "/"),
          readyForMachinePrecheck: freshBlindIntake.readyForMachinePrecheck === true,
          candidate: freshBlindIntake.candidate || {},
          scope: freshBlindIntake.scope || {},
          blockingReasons: freshBlindIntake.blockingReasons || [],
          warnings: freshBlindIntake.warnings || [],
        }
      : {
          source: FRESH_BLIND_INTAKE_STATUS.replace(/\\/g, "/"),
          summary: FRESH_BLIND_INTAKE_STATUS_MD.replace(/\\/g, "/"),
          readyForMachinePrecheck: false,
          missing: true,
          blockingReasons: ["fresh-blind-intake-status-missing"],
        },
    tracks: {
      controlledCandidate,
      m3plusPitchModes,
      m4Omr,
    },
    nextActions: summarizeNextActions(
      controlledCandidate,
      m3plusPitchModes,
      m4Omr,
      releaseReview,
      controlledPilotDecision,
      controlledPilotSession,
      controlledPilotEvidence,
      controlledPilotMachineAudit,
      freshBlindIntake,
    ),
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
    reviewPolicy: status.reviewPolicy,
    runtimeStudentGate: status.runtimeStudentGate,
    photoScoreOfflineChain: status.photoScoreOfflineChain,
    publicProfessionalBenchmark: status.publicProfessionalBenchmark,
    publicModelValidation: status.publicModelValidation,
    releaseReview: status.releaseReview,
    controlledPilotSession: status.controlledPilotSession,
    controlledPilotEvidence: status.controlledPilotEvidence,
    controlledPilotMachineAudit: status.controlledPilotMachineAudit,
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
      monitoredPilotAudit: m3plusPitchModes.monitoredPilotAudit,
      counts: m3plusPitchModes.counts,
      blockingReasons: m3plusPitchModes.blockingReasons,
    },
    m4Omr: {
      datasetReady: m4Omr.m4OmrBenchmarkDatasetReady,
      draftQualityReady: m4Omr.m4OmrDraftQualityReady,
      teacherReviewNeeded: m4Omr.teacherReviewNeeded,
      humanTask: m4Omr.humanTask,
      independentGoldWorkspaceAudit: m4Omr.independentGoldWorkspaceAudit,
      goldProvenanceAudit: m4Omr.goldProvenanceAudit,
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
