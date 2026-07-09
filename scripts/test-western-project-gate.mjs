import assert from "node:assert/strict";

import { evaluateProjectGate } from "./gate-western-strings-project.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const status = await buildProjectStatus();

assert.equal(status.runtimeStudentGate.policy, "fail-closed", "student runtime gate must remain fail-closed");
assert.equal(status.runtimeStudentGate.ordinaryUploadAutoFeedbackReady, false, "ordinary upload must not auto-feedback before release gate");
assert.equal(status.runtimeStudentGate.m3plusAutoFeedbackReady, false, "M3+ mode feedback must stay disabled before labels are ready");
assert.equal(status.runtimeStudentGate.m4OmrAutoScoreReady, false, "M4 OMR auto score must stay disabled before independent gold");

assert(status.tracks?.controlledCandidate, "project status must include ordinary upload candidate track");
assert(status.tracks?.m3plusPitchModes, "project status must include M3+ pitch-mode track");
assert(status.tracks?.m4Omr, "project status must include M4 OMR track");

const m3plus = status.tracks.m3plusPitchModes;
assert.equal(m3plus.m3plusModeEvalReady, true, "M3+ review labels should be sufficient for offline mode evaluation");
assert.equal(m3plus.m3plusModeReleaseReady, true, "M3+ should report mode-specific release evidence after the first-measure candidate-quality review passes");
assert(m3plus.modeEval?.controlReadyModes?.includes("stable"), "stable should be reported as a control-ready mode");
assert.deepEqual(m3plus.modeEval?.releaseReadyModes || [], ["slide-like", "trill-like"], "slide-like and trill-like should be reported as release-ready offline modes");
assert.equal(m3plus.localizationDiagnosis?.sourceExists, true, "M3+ localization diagnosis should be generated after round-2 import");
assert.equal(m3plus.localizationDiagnosis?.summary?.nonMatch, 24, "M3+ localization diagnosis should expose the current non-match row count");
assert.deepEqual(m3plus.blockingReasons || [], [], "M3+ offline mode evidence should no longer ask for more review after the safe first-measure pack is imported");

const controlled = status.tracks.controlledCandidate;
assert.equal(controlled.studentSafeCandidateGateReady, false, "ordinary upload must still require blind validation");
assert.equal(controlled.confidencePilot?.releaseCandidateFound, true, "confidence pilot should report release candidates");
assert.equal(controlled.confidencePilot?.readyForStudentGate, false, "eval-only confidence pilot must not mark runtime gate ready");
assert.equal(controlled.confidencePilot?.validationEval?.readyForRuntimeGate, false, "validation eval must not enable runtime gate");
if (controlled.confidencePilot?.validationEval?.blindValidationPassed) {
  assert.equal(controlled.confidencePilot?.needsBlindValidation, false, "passed blind validation should clear needsBlindValidation");
  assert.equal(controlled.confidencePilot?.runtimeGateWired, true, "passed blind validation should expose the wired runtime release manifest");
  assert(
    controlled.blockingReasons.includes("ordinary-auto-gate-disabled-by-default"),
    "wired runtime gate must still block until the explicit release flag is enabled",
  );
} else {
  assert.equal(controlled.confidencePilot?.needsBlindValidation, true, "confidence pilot should still track that the old v1 candidate did not pass the full release process");
  if (controlled.confidenceRecalibration?.validationFailed) {
    assert.equal(controlled.confidenceRecalibration.needsBlindValidation, false, "failed recalibration validation should not ask for the same blind review again");
    assert.equal(
      controlled.confidenceRecalibration.failureDiagnosis?.summary?.selectedWrongRows,
      2,
      "failed recalibration validation should expose the selected false-positive count",
    );
    if (controlled.confidenceRecalibration?.contextValidation?.needsBlindValidation) {
      assert(
        controlled.blockingReasons.includes("ordinary-confidence-recalibration-context-validation-needed"),
        "ordinary upload should route to the fresh context recalibration blind-validation pack when it exists",
      );
    } else {
      assert(
        controlled.blockingReasons.includes("ordinary-confidence-recalibration-validation-failed"),
        "ordinary upload should block on the failed recalibration blind-validation result",
      );
    }
  } else {
    assert(
      controlled.blockingReasons.includes("candidate-confidence-pilot-needs-blind-validation"),
      "ordinary upload should block on blind validation before eval passes",
    );
  }
}
assert(controlled.confidencePilot?.bestReleaseCandidate, "confidence pilot should report the best release candidate");
assert.equal(controlled.confidencePilot.bestReleaseCandidate.featureSet, "deployable", "confidence pilot should report the deployable candidate");
assert.equal(controlled.confidencePilot.bestReleaseCandidate.groupBy, "recordingId", "confidence pilot should report the strict leave-one-recording candidate");
assert(
  status.nextActions[0]?.action.includes("confidence-threshold-pool-review/index.html")
  || status.nextActions[0]?.action.includes("threshold-pool review failed")
  || status.nextActions[0]?.action.includes("Threshold-pool precision passed")
  || status.nextActions[0]?.action.includes("separate monitored pilot plan")
  || status.nextActions[0]?.action.includes("recalibration blind-validation pack")
  || status.nextActions[0]?.action.includes("context-feature confidence recalibration pack")
  || status.nextActions[0]?.action.includes("improve candidate/pitch-support evidence")
  || status.nextActions[0]?.action.includes("wire a runtime gate")
  || status.nextActions[0]?.action.includes("runtime gate is wired")
  || status.nextActions[0]?.action.includes("ordinary-monitored-pilot-audit"),
  "project next action should route to threshold-pool review, recalibration, runtime wiring, pitch-support improvement, or explicit release-flag gating",
);
const expectedOrdinaryArtifact = status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-context-validation-needed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/index.html"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-context-validation-failed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/confidence-recalibration-context-validation-eval.json"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-context-runtime-not-wired")
  ? "data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/confidence-recalibration-context-validation-eval.json"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-validation-needed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-validation-review/index.html"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-validation-failed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-validation-review/confidence-recalibration-failure-diagnosis.json"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-threshold-pool-precision-too-low")
  ? "data/experiments/western-strings-m3/confidence-threshold-pool-review/confidence-threshold-pool-diagnosis.json"
  : "data/experiments/western-strings-m3/confidence-validation-review/ordinary-confidence-release-audit.json";
assert.equal(status.nextActions[0]?.artifact, expectedOrdinaryArtifact, "project artifact should point to the current ordinary-gate evidence artifact");

const m4 = status.tracks.m4Omr;
assert.equal(m4.m4OmrBenchmarkDatasetReady, true, "M4 intake dataset should be ready for benchmarking");
assert.equal(m4.m4OmrDraftQualityReady, false, "M4 draft quality must not be ready while gold equals draft");
assert.equal(m4.counts.usableBenchmarkRows, 0, "self-comparison rows must not count as usable independent gold");
assert.equal(m4.counts.selfComparisonRows, 12, "current M4 fixture should expose all self-comparison rows");
assert(m4.blockingReasons.includes("m4-omr-self-comparison-detected"), "M4 must block on self-comparison");
assert(m4.blockingReasons.includes("m4-omr-no-independent-gold"), "M4 must block when independent gold is missing");
assert.equal(
  m4.artifacts.independentGoldTodoHtml,
  "data/experiments/western-strings-m4/independent-gold-todo.html",
  "M4 handoff should expose the visual independent-gold checklist",
);

const noRequiredGate = evaluateProjectGate(status, new Set());
assert.equal(noRequiredGate.projectReleaseReady, true, "empty required track set should not block");
assert.deepEqual(noRequiredGate.failures, [], "empty required track set should have no failures");

const fullGate = evaluateProjectGate(status, new Set(["ordinary", "m3plus", "m4"]));
assert.equal(fullGate.projectReleaseReady, false, "full project gate must block until all required tracks are ready");
assert(fullGate.failures.some((failure) => failure.track === "M2/M3 ordinary upload candidate gate"), "ordinary track failure should be reported");
assert.equal(
  fullGate.failures.find((failure) => failure.track === "M2/M3 ordinary upload candidate gate")?.artifact,
  expectedOrdinaryArtifact,
  "ordinary gate failure should point to the current ordinary-gate evidence artifact",
);
const m3plusFailure = fullGate.failures.find((failure) => failure.track === "M3+ pitch behavior modes");
assert.equal(m3plusFailure, undefined, "M3+ should not be a project-gate failure after mode-specific offline evidence passes");
assert(fullGate.failures.some((failure) => failure.track === "M4 OMR benchmark"), "M4 track failure should be reported");
assert.equal(
  fullGate.failures.find((failure) => failure.track === "M4 OMR benchmark")?.artifact,
  "data/experiments/western-strings-m4/independent-gold-todo.html",
  "M4 gate failure should point to the visual independent-gold checklist",
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "project-status-tracks-present",
    "student-runtime-fail-closed",
    "confidence-pilot-validation-state-covered",
    "m3plus-first-measure-mode-evidence-covered",
    "m4-self-comparison-blocks",
    "project-gate-required-tracks-block-release",
  ],
}, null, 2));
