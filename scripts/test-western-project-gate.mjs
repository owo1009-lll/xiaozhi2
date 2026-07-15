import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { evaluateProjectGate } from "./gate-western-strings-project.mjs";
import { renderHandoff } from "./create-western-strings-next-action-handoff.mjs";
import {
  buildProjectStatus,
  summarizePublicModelValidation,
} from "./status-western-strings-project.mjs";

const status = await buildProjectStatus();

assert.equal(status.runtimeStudentGate.policy, "fail-closed", "student runtime gate must remain fail-closed");
assert.equal(status.reviewPolicy?.rule, "machine-self-test-before-human-review", "project status must expose the review policy");
assert.equal(status.reviewPolicy?.source, "docs/western-strings-review-policy.md", "project status must point to the review policy document");
assert.equal(status.runtimeStudentGate.ordinaryUploadAutoFeedbackReady, false, "ordinary upload must not auto-feedback before release gate");
assert.equal(status.runtimeStudentGate.m3plusAutoFeedbackReady, false, "M3+ mode feedback must stay disabled before labels are ready");
assert.equal(status.runtimeStudentGate.m4OmrAutoScoreReady, false, "M4 OMR auto score must stay disabled before independent gold");
assert.ok(status.publicProfessionalBenchmark, "public professional benchmark status must always be present");
assert.equal(
  status.publicProfessionalBenchmark.defaultStudentReleaseEligible,
  false,
  "public professional recordings must never enable the student release gate",
);
assert.ok(status.publicModelValidation, "public model validation status must always be present");
assert.ok(status.measureFeedbackAudit, "project status must expose the measure-feedback safety audit");
assert.equal(status.measureFeedbackAudit.measureAggregationReleaseReady, false, "measure aggregation must stay closed when safe coverage is below 20%");
assert.equal(status.measureFeedbackAudit.studentGateReady, false, "eval-only measure aggregation must never directly open student feedback");
assert.equal(
  status.publicModelValidation.gates.studentReleaseEligible,
  false,
  "public model validation must never enable the student release gate",
);
assert.equal(
  status.publicModelValidation.gates.nearPerfectReady,
  false,
  "public model validation must not claim near-perfect readiness",
);

const syntheticPublicValidation = summarizePublicModelValidation({
  phenicxAlignment: {
    ok: true,
    alignmentGatePassed: true,
    freshExternalConfirmationRequired: true,
    polyphonicSubgroupGate: { passed: false },
  },
  muscCalibration: {
    ok: true,
    calibrationV2Ready: true,
    calibrationV3Ready: false,
  },
  muscFresh: {
    ok: true,
    freshConfirmationPassed: true,
    muscV2CoreGatePassed: true,
    muscV3CoreGatePassed: false,
    doubleStopAutoFeedbackEligible: false,
  },
  violinMidiAudit: {
    ok: true,
    readyAsWeakLabelSource: true,
    readyAsIndependentRecognitionBenchmark: false,
  },
});
assert.equal(
  syntheticPublicValidation.gates.publicProfessionalMonophonicV2CandidateReady,
  true,
  "PHENICX plus fresh MUSC evidence should expose the public monophonic V2 candidate",
);
assert.equal(
  syntheticPublicValidation.gates.publicProfessionalMonophonicV3Ready,
  false,
  "failed strict MUSC evidence must keep public V3 closed",
);
assert.equal(
  syntheticPublicValidation.gates.doubleStopAutoFeedbackReady,
  false,
  "failed polyphonic evidence must keep double-stop feedback closed",
);
assert.equal(
  syntheticPublicValidation.weakLabels.independentRecognitionBenchmarkReady,
  false,
  "weak labels must not be promoted to independent recognition gold",
);

assert(status.tracks?.controlledCandidate, "project status must include ordinary upload candidate track");
assert(status.tracks?.m3plusPitchModes, "project status must include M3+ pitch-mode track");
assert(status.tracks?.m4Omr, "project status must include M4 OMR track");

const m3plus = status.tracks.m3plusPitchModes;
assert.equal(m3plus.m3plusModeEvalReady, true, "M3+ review labels should be sufficient for offline mode evaluation");
assert.equal(m3plus.coarseStateEval?.sourceExists, true, "M3+ status must expose the teacher-style coarse-state probe");
assert.equal(m3plus.coarseStateEval?.joinReady, true, "all reviewed M3+ rows must join their frozen window features exactly");
assert.equal(m3plus.coarseStateEval?.eligibleMatchedRows, 74, "coarse-state probe must use the 74 matched, known-behavior rows");
assert.equal(m3plus.coarseStateEval?.coarseStateRuntimeReady, false, "exploratory coarse states must stay out of runtime");
assert.equal(m3plus.m3plusModeReleaseReady, false, "human-confirmed round-two failures must supersede the old first-measure release evidence");
assert(m3plus.modeEval?.controlReadyModes?.includes("stable"), "stable should be reported as a control-ready mode");
assert.deepEqual(m3plus.modeEval?.releaseReadyModes || [], ["slide-like", "trill-like"], "historical first-measure release modes should remain visible as scoped evidence");
assert.equal(m3plus.round2AlignedEval?.sourceExists, true, "M3+ status must read the round-two aligned evaluation");
assert.equal(m3plus.round2AlignedEval?.humanVerifiedPerformanceGold, true, "M3+ status must expose the confirmed r2-06 performance gold");
assert.equal(m3plus.round2AlignedEval?.machineThresholdPassed, false, "round-two mode detection must fail below the 90% floor");
assert.equal(m3plus.round2AlignedEval?.releaseEvidenceReady, false, "missing negatives and failed detection must keep round-two release evidence closed");
assert.deepEqual(
  m3plus.round2AlignedEval?.thresholdChecks || {},
  { slide: false, trill: false, vibrato: false, doubleStop: false },
  "all four round-two mode checks should remain fail-closed",
);
assert.equal(m3plus.localizationDiagnosis?.sourceExists, true, "M3+ localization diagnosis should be generated after round-2 import");
assert.equal(m3plus.localizationDiagnosis?.summary?.nonMatch, 24, "M3+ localization diagnosis should expose the current non-match row count");
assert((m3plus.blockingReasons || []).includes("m3plus-round2-mode-detection-below-90-percent"), "M3+ status must report the confirmed round-two detector failure");
assert((m3plus.blockingReasons || []).includes("m3plus-round2-negative-controls-missing"), "M3+ status must report the missing negative controls");
assert.equal(m3plus.supplementalIntake?.sourceExists, true, "M3+ status must expose the prepared supplemental intake");
assert.equal(m3plus.supplementalIntake?.recordingCount, 4, "M3+ supplemental intake must contain four targeted recordings");
assert.equal(m3plus.supplementalIntake?.readyRecordingCount, 0, "M3+ supplemental intake must not invent recordings before they exist");
assert.equal(m3plus.supplementalIntake?.missingRecordingCount, 4, "M3+ supplemental intake must report all four missing recordings");
assert.equal(m3plus.supplementalIntake?.readyForMachineAnalysis, false, "M3+ supplemental intake must fail closed before audio is recorded");
assert.equal(m3plus.supplementalIntake?.humanTask, "record-m3plus-supplemental-takes", "M3+ status must name the exact remaining human task");
assert(
  String(m3plus.supplementalIntake?.instructions || "").replaceAll("\\", "/").endsWith("音频/m3plus-supplemental/README-录音说明.md"),
  "M3+ status must point to the supplemental recording instructions",
);
assert((m3plus.blockingReasons || []).includes("m3plus-supplemental-recordings-not-ready"), "M3+ must remain blocked while supplemental recordings are missing");
assert.equal(m3plus.supplementalMachineEval?.sourceExists, true, "M3+ status must expose the supplemental machine-eval report");
assert(["crepe", "pyin"].includes(m3plus.supplementalMachineEval?.f0Backend), "M3+ status must expose the actual bounded frame-F0 backend");
assert.equal(m3plus.supplementalMachineEval?.scoreTechniqueIntentReady, true, "M3+ supplemental score markings must match the frozen technique intent before audio review");
assert.equal(m3plus.supplementalMachineEval?.machineAnalysisComplete, false, "M3+ machine eval must fail closed before recordings exist");
assert.equal(m3plus.supplementalMachineEval?.teacherReviewAllowed, false, "M3+ machine eval must not request teacher work before passing");
assert.equal(m3plus.supplementalMachineEval?.studentGateReady, false, "M3+ supplemental evidence must never directly open the student gate");
assert.equal(status.tracks.m4Omr.m4MeasureAudioRhythmRankingGatePassed, false, "M4 measure-level audio rhythm ranking must remain below the eval-only gate");
assert.equal(status.tracks.m4Omr.audioRhythmRanking?.measureLevel?.runtimeReady, false, "M4 measure-level audio rhythm evidence must never directly edit a score");
if (m3plus.monitoredPilotAudit?.sourceExists) {
  assert.equal(m3plus.monitoredPilotAudit.readyForMonitoredPilot, false, "newer round-two failures must close the old monitored-pilot result");
  assert.equal(m3plus.monitoredPilotAudit.teacherReviewNeeded, false, "M3+ monitored pilot audit must not ask for more review when all auto-pass evidence is already known");
  assert.equal(m3plus.monitoredPilotAudit.defaultM3PlusReadyAfter, false, "M3+ monitored pilot audit must keep default runtime disabled");
  assert.deepEqual(Object.keys(m3plus.monitoredPilotAudit.releaseModes || {}), ["slide-like", "trill-like"], "M3+ pilot audit should only expose slide/trill release modes");
  assert((m3plus.monitoredPilotAudit.blockedModes || []).includes("variable-f0"), "unsafe variable-f0 must remain blocked by the M3+ audit");
}

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
const ordinaryPilotAuditPassed = controlled.confidencePilot?.monitoredPilotAudit?.readyForMonitoredPilot === true
  && controlled.confidencePilot?.monitoredPilotAudit?.teacherReviewNeeded === false
  && controlled.confidencePilot?.monitoredPilotAudit?.defaultOrdinaryReadyAfter === false;
const m3plusPilotAuditPassed = m3plus.monitoredPilotAudit?.readyForMonitoredPilot === true
  && m3plus.monitoredPilotAudit?.teacherReviewNeeded === false
  && m3plus.monitoredPilotAudit?.defaultM3PlusReadyAfter === false;
if (ordinaryPilotAuditPassed && m3plusPilotAuditPassed) {
  assert(
    status.releaseReview?.readyForControlledPilot
      ? ["Controlled pilot decision", "Controlled pilot approval", "Controlled pilot deferred", "Start monitored pilot", "Controlled pilot coverage audit", "Scoped V2-alpha blind audit preparation", "Fresh blind machine precheck", "Controlled pilot completed"].includes(status.nextActions[0]?.track)
      : status.nextActions[0]?.track === "Release review",
    "after ordinary, M3+, and M4 machine checks pass, handoff should move to release review or controlled pilot decision while runtime stays fail-closed",
  );
} else if (ordinaryPilotAuditPassed) {
  assert.equal(
    status.nextActions[0]?.track,
    "M3+ pitch behavior modes",
    "after ordinary pilot audit passes, handoff should move to the next unfinished track while release stays fail-closed",
  );
} else {
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
}
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
if (ordinaryPilotAuditPassed && m3plusPilotAuditPassed) {
  const nextArtifact = status.nextActions[0]?.artifact || "";
  assert(
    [
      "data/experiments/western-strings-release-review.md",
      "data/experiments/western-strings-controlled-pilot-decision.md",
      "data/experiments/western-strings-controlled-pilot-evidence-audit.md",
      "data/experiments/western-strings-v2alpha-blind-intake-status.md",
    ].includes(nextArtifact)
      || (nextArtifact.startsWith("data/experiments/western-strings-controlled-pilot-sessions/")
        && nextArtifact.endsWith("/session.md")),
    "after machine checks pass, handoff should point to release/decision evidence or the completed pilot session",
  );
} else if (ordinaryPilotAuditPassed) {
  assert.equal(
    status.nextActions[0]?.artifact,
    m3plus.supplementalIntake.instructions,
    "after ordinary pilot audit passes, handoff artifact should point to the next unfinished track",
  );
} else {
  assert.equal(status.nextActions[0]?.artifact, expectedOrdinaryArtifact, "project artifact should point to the current ordinary-gate evidence artifact");
}

const m4 = status.tracks.m4Omr;
assert.equal(m4.m4OmrBenchmarkDatasetReady, true, "M4 intake dataset should be ready for benchmarking");
assert.equal(m4.m4OmrDraftQualityReady, false, "independent source gold must expose that current photo OMR draft quality is below the floor");
assert.equal(m4.m4OmrIndependentBenchmarkReady, true, "M4 independent render/scan/photo benchmark should pass its research floor");
assert.equal(m4.m4OmrAccuracyClaimReady, true, "M4 should expose the bounded independent accuracy claim");
assert.equal(m4.m4OmrAutomaticAdoptionReady, false, "M4 automatic adoption must stay closed below the strict per-piece and real-photo floors");
assert.equal(m4.independentBenchmark?.studentGateReady, false, "M4 benchmark evaluation must never open the student runtime gate");
assert.equal(m4.independentBenchmark?.strictPerPiece?.passedRows, 12, "current strict M4 benchmark should expose 12 passing pieces");
assert.equal(m4.independentBenchmark?.strictPerPiece?.evaluatedRows, 32, "current strict M4 benchmark should expose all 32 clean pieces");
assert.equal(m4.independentBenchmark?.independentRealPhotoRows, 5, "M4 must expose all independent source-gold real-photo rows");
assert.equal(m4.independentBenchmark?.realPhotoGold?.passedRows, 0, "none of the current real-photo rows may be promoted above the strict floor");
assert.equal(m4.independentBenchmark?.realPhotoGold?.aggregate?.precision, 0.847086, "M4 must expose the measured real-photo pitch precision");
assert.equal(m4.independentBenchmark?.realPhotoGold?.aggregate?.recall, 0.715016, "M4 must expose the measured real-photo pitch recall");
assert.equal(m4.independentBenchmark?.realPhotoGold?.aggregate?.onsetQuarterAccuracy, 0.021725, "M4 must expose real-photo onset accuracy");
assert.equal(m4.independentBenchmark?.realPhotoGold?.aggregate?.measureAccuracy, 0.438339, "M4 must expose real-photo measure accuracy");
if (m4.m4OemerBenchmarkComplete) {
  assert.equal(m4.m4OemerAutomaticAdoptionReady, false, "Oemer source-gold comparison must not open automatic adoption");
  assert.equal(m4.oemerBenchmark?.studentGateReady, false, "Oemer eval-only comparison must never open the student gate");
  assert.equal(m4.oemerBenchmark?.comparison?.oemer?.rows, 5, "Oemer comparison must expose all five frozen source-gold rows");
  assert.equal(m4.oemerBenchmark?.comparison?.oemer?.usableRows, 4, "Oemer comparison must expose the one engine failure");
  assert.equal(m4.oemerBenchmark?.comparison?.oemer?.strictPassRows, 0, "Oemer must not be promoted above its measured strict result");
}
if (m4.m4HomrBenchmarkComplete) {
  assert.equal(m4.m4HomrAutomaticAdoptionReady, false, "HOMR comparison must not open automatic adoption");
  assert.equal(m4.homrBenchmark?.studentGateReady, false, "HOMR eval-only comparison must never open the student gate");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.rows, 5, "HOMR comparison must expose all frozen rows");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.usableRows, 5, "HOMR comparison must expose all usable outputs");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.pitchOnlyStrictPassRows, 2, "HOMR must expose pitch-only false positives");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.strictPassRows, 0, "HOMR must reject rhythmically invalid MusicXML");
}
if (m4.m4ClarityBenchmarkComplete) {
  assert.equal(m4.m4ClarityAutomaticAdoptionReady, false, "Clarity comparison must not open automatic adoption");
  assert.equal(m4.clarityBenchmark?.studentGateReady, false, "Clarity eval-only comparison must never open the student gate");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.rows, 5, "Clarity comparison must expose all frozen rows");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.usableRows, 5, "Clarity comparison must expose all usable outputs");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.pitchOnlyStrictPassRows, 0, "Clarity must not pass the pitch-only floor");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.strictPassRows, 0, "Clarity must not pass the complete score floor");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.pitchPrecision, 0.727749, "Clarity precision must match the frozen benchmark");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.pitchRecall, 0.355272, "Clarity recall must match the frozen benchmark");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.onsetQuarterAccuracy, 0.028115, "Clarity onset accuracy must match the frozen benchmark");
  assert.equal(m4.clarityBenchmark?.comparison?.clarity?.measureAccuracy, 0.100958, "Clarity measure accuracy must match the frozen benchmark");
  assert.equal(m4.clarityBenchmark?.rawNativeSmoke?.staffCrops, 0, "Clarity must expose the native-photo Stage-A failure");
}
if (m4.m4ClarityAdaptationEvaluated) {
  assert.equal(m4.m4ClarityAdaptationRejected, true, "the measured Clarity adaptation candidate must be rejected");
  assert.equal(m4.clarityAdaptationBenchmark?.studentGateReady, false, "Clarity adaptation must remain eval-only");
  assert.equal(
    m4.clarityAdaptationBenchmark?.adaptationDecision?.checkpointDisposition,
    "reject-and-delete",
    "Clarity adaptation decision must preserve the measured rejection",
  );
  assert.equal(
    m4.clarityAdaptationBenchmark?.comparison?.clarity?.strictPassRows,
    0,
    "Clarity adaptation must not pass the complete score floor",
  );
  assert(
    m4.automaticAdoptionBlockingReasons?.includes("m4-clarity-supervised-adaptation-rejected"),
    "M4 automatic adoption must report the rejected supervised adaptation",
  );
}
assert(
  m4.automaticAdoptionBlockingReasons?.includes("m4-clean-per-piece-strict-pass-rate-too-low"),
  "M4 automatic adoption must report the strict per-piece shortfall",
);
assert(
  m4.automaticAdoptionBlockingReasons?.includes("m4-real-photo-independent-benchmark-below-floor"),
  "M4 automatic adoption must report the independent real-photo accuracy shortfall",
);
assert(!m4.automaticAdoptionBlockingReasons?.includes("m4-real-photo-independent-gold-missing"), "M4 must not request already-completed real-photo gold work");
assert(
  m4.automaticAdoptionBlockingReasons?.includes("m4-runtime-safe-subset-not-found"),
  "M4 automatic adoption must report that runtime-visible confidence signals cannot select a safe subset",
);
if (m4.m4ClarityBenchmarkComplete) {
  assert(
    m4.automaticAdoptionBlockingReasons?.includes("m4-clarity-source-benchmark-below-complete-score-floor"),
    "M4 automatic adoption must report the Clarity complete-score shortfall",
  );
}
assert.equal(m4.teacherReviewNeeded, false, "M4 independent-gold correction must not be reported as teacher audio review");
assert.equal(m4.scoreEditorReviewNeeded, false, "M4 must not request more score editing after independent source gold is available");
assert.equal(
  m4.humanTask,
  "none",
  "M4 should expose that the next accuracy improvement is a machine task, not another human gold task",
);
assert.equal(
  m4.independentGoldWorkspaceAudit?.source,
  "data/experiments/western-strings-m4/independent-gold-workspace-audit.json",
  "M4 should expose the independent-gold workspace audit artifact",
);
assert.equal(
  m4.goldProvenanceAudit?.source,
  "data/experiments/western-strings-m4/gold-provenance-audit.json",
  "M4 should expose the gold provenance audit artifact",
);
if (!m4.goldProvenanceAudit?.missing) {
  assert.equal(m4.goldProvenanceAudit.teacherReviewNeeded, false, "M4 provenance audit must not ask for teacher audio review");
  assert.equal(
    m4.goldProvenanceAudit.humanTask,
    "none",
    "M4 provenance audit should clear the score-editor task when clean-score approval already exists",
  );
  assert.equal(
    m4.goldProvenanceAudit.counts?.manualGoldRequiredRows,
    0,
    "current M4 fixture should not require score-editor gold after clean-score approval is recognized",
  );
  assert.equal(
    m4.goldProvenanceAudit.counts?.humanApprovedUnchangedDraftRows,
    8,
    "current M4 fixture should expose human-approved unchanged draft rows",
  );
  assert.equal(
    m4.goldProvenanceAudit.counts?.independentCandidateRows,
    0,
    "current M4 fixture should not pretend there are independent clean-score candidates",
  );
}
assert.equal(
  m4.independentGoldWorkspaceAudit?.readyForApply,
  false,
  "M4 independent-gold workspace must not be apply-ready before checked score edits",
);
assert.equal(m4.counts.usableBenchmarkRows, 12, "human-approved unchanged gold rows should count as usable OMR benchmark rows");
assert.equal(m4.counts.humanApprovedUnchangedRows, 8, "current M4 fixture should distinguish approved unchanged rows from independent source-gold rows");
assert.equal(m4.counts.selfComparisonRows, 0, "approved unchanged rows must not be reported as unverified self-comparisons");
assert(!m4.blockingReasons.includes("m4-omr-self-comparison-detected"), "M4 must not block human-approved unchanged rows as self-comparison");
assert(!m4.blockingReasons.includes("m4-omr-no-independent-gold"), "M4 must not block when human-approved unchanged gold is usable");
assert.equal(
  m4.artifacts.independentGoldTodoHtml,
  "data/experiments/western-strings-m4/independent-gold-todo.html",
  "M4 handoff should expose the visual independent-gold checklist",
);
if (ordinaryPilotAuditPassed && m3plusPilotAuditPassed) {
  assert(
    status.releaseReview?.readyForControlledPilot
      ? ["Controlled pilot decision", "Controlled pilot approval", "Controlled pilot deferred", "Start monitored pilot", "Controlled pilot coverage audit", "Scoped V2-alpha blind audit preparation", "Fresh blind machine precheck", "Controlled pilot completed"].includes(status.nextActions[0]?.track)
      : status.nextActions[0]?.track === "Release review",
    "M4 should no longer produce a human-task next action after clean-score approval is recognized",
  );
}

const m4ChecklistHtml = await fs.readFile("data/experiments/western-strings-m4/independent-gold-todo.html", "utf8");
const m4ChecklistMd = await fs.readFile("data/experiments/western-strings-m4/independent-gold-todo.md", "utf8");
const reviewPolicy = await fs.readFile("docs/western-strings-review-policy.md", "utf8");
const projectPlan = await fs.readFile("docs/western-strings-project-plan.md", "utf8");
const migrationPlan = await fs.readFile("docs/western-strings-migration-plan.md", "utf8");
const releaseReviewSource = await fs.readFile("scripts/run-western-strings-release-review.mjs", "utf8");
const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
const handoff = renderHandoff(status);
assert(
  packageJson.scripts?.["western:m4-preflight"],
  "package.json must expose the aggregate M4 machine self-test command",
);
assert(
  packageJson.scripts?.["western:m4-independent-benchmark-audit"],
  "package.json must expose the independent M4 benchmark audit",
);
assert(
  packageJson.scripts?.["test:western-m4-independent-benchmark"],
  "package.json must expose the independent M4 benchmark regression test",
);
assert(packageJson.scripts?.["test:western-m4-source-gold"], "package.json must expose independent source-gold provenance tests");
assert(packageJson.scripts?.["western:m4-oemer-benchmark"], "package.json must expose the eval-only Oemer source-gold benchmark");
assert(packageJson.scripts?.["test:western-m4-oemer-benchmark"], "package.json must expose Oemer benchmark regression tests");
assert(packageJson.scripts?.["western:m4-homr-benchmark"], "package.json must expose the eval-only HOMR benchmark");
assert(packageJson.scripts?.["test:western-m4-homr-benchmark"], "package.json must expose HOMR benchmark regression tests");
assert(packageJson.scripts?.["western:m4-clarity-benchmark"], "package.json must expose the eval-only Clarity benchmark");
assert(packageJson.scripts?.["test:western-m4-clarity-benchmark"], "package.json must expose Clarity benchmark regression tests");
assert(packageJson.scripts?.["western:m3plus-supplemental-scores"], "package.json must expose the M3+ supplemental score generator");
assert(packageJson.scripts?.["western:m3plus-supplemental-status"], "package.json must expose the M3+ supplemental intake status command");
assert(packageJson.scripts?.["western:m3plus-supplemental-eval"], "package.json must expose the M3+ supplemental machine evaluation command");
assert(packageJson.scripts?.["test:western-m3plus-supplemental-status"], "package.json must expose M3+ supplemental fail-closed tests");
assert(packageJson.scripts?.["test:western-m3plus-supplemental-eval"], "package.json must expose M3+ supplemental machine-eval tests");
assert(
  packageJson.scripts?.["western:m4-independent-gold-note-summary"],
  "package.json must expose the M4 editable-gold note summary command",
);
assert(
  packageJson.scripts?.["western:release-review"],
  "package.json must expose the aggregate release-review command",
);
assert(
  packageJson.scripts?.["western:public-model-gate"],
  "package.json must expose the public professional model evidence gate",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-decision"],
  "package.json must expose the controlled-pilot decision command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-approval-template"],
  "package.json must expose a non-approving controlled-pilot approval template command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-record-decision"],
  "package.json must expose a controlled-pilot owner decision recorder command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-start-preflight"],
  "package.json must expose the controlled-pilot start preflight command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-run"],
  "package.json must expose the one-shot controlled-pilot runner",
);
assert(
  packageJson.scripts?.["test:western-controlled-pilot-run"],
  "package.json must expose controlled-pilot runner tests",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-evidence-audit"],
  "package.json must expose the machine-only controlled-pilot evidence audit",
);
assert(
  packageJson.scripts?.["test:western-controlled-pilot-evidence-audit"],
  "package.json must expose controlled-pilot evidence audit tests",
);
assert(
  packageJson.scripts?.["western:fresh-blind-intake-status"],
  "package.json must expose the fresh blind intake status command",
);
assert(
  packageJson.scripts?.["western:fresh-blind-intake-stage"],
  "package.json must expose the atomic fresh blind intake staging command",
);
assert(
  packageJson.scripts?.["test:western-fresh-blind-intake"],
  "package.json must expose fresh blind intake tests",
);
assert(
  packageJson.scripts?.["test:western-ordinary-pilot-selection"],
  "package.json must expose exact-recording pilot selection tests",
);
assert(
  releaseReviewSource.includes('"test:western-controlled-pilot-run"'),
  "release review must rerun the controlled-pilot runner safety tests before approval",
);
assert(
  releaseReviewSource.includes('"test:western-fresh-blind-intake"'),
  "release review must rerun fresh blind intake leakage tests before approval",
);
assert(
  releaseReviewSource.includes('"test:western-ordinary-pilot-selection"'),
  "release review must rerun exact-recording selection tests before approval",
);
assert(
  releaseReviewSource.includes('"test:western-controlled-pilot-evidence-audit"')
    && releaseReviewSource.includes('"western:controlled-pilot-evidence-audit"'),
  "release review must refresh the machine-only evidence audit before any human handoff",
);
assert(
  packageJson.scripts?.["test:western-controlled-pilot-decision"],
  "package.json must expose controlled-pilot decision/preflight tests",
);
for (const [label, text] of [["review policy", reviewPolicy]]) {
  assert(
    text.includes("npm run western:m4-preflight"),
    `M4 ${label} must route through the aggregate machine self-test before manual score editing`,
  );
  assert(
    text.includes("note summary") || text.includes("note-summary"),
    `M4 ${label} must mention the machine note summary before manual score editing`,
  );
  assert(
    text.includes("npm run western:m4-gold-provenance-audit"),
    `M4 ${label} must require provenance self-test before manual score editing`,
  );
  assert(
    text.includes("npm run western:m4-independent-gold-workspace-audit"),
    `M4 ${label} must require workspace audit before apply`,
  );
}
if (m4.m4OmrIndependentBenchmarkReady) {
  assert(
    !handoff.includes("score-editor independent-gold correction task"),
    "current handoff must not keep stale M4 score-editor instructions after M4 clears",
  );
  if (m3plus.m3plusModeReleaseReady) {
    assert(
      handoff.includes("npm run western:release-review")
        || handoff.includes("npm run western:controlled-pilot-decision")
        || handoff.includes("npm run western:controlled-pilot-approval-template")
        || handoff.includes("npm run western:controlled-pilot-start-preflight")
        || handoff.includes("Controlled pilot approval")
        || handoff.includes("Controlled pilot deferred")
        || handoff.includes("Start monitored pilot")
        || handoff.includes("Controlled pilot coverage audit")
        || handoff.includes("Scoped V2-alpha blind audit preparation")
        || handoff.includes("Controlled pilot completed"),
      "handoff must route through release-review or the controlled-pilot decision after M3+ and M4 clear",
    );
  } else {
    assert(
      handoff.includes("m3plus-supplemental") && handoff.includes("README-"),
      "handoff must point to the exact M3+ supplemental recording task while that track is blocked",
    );
  }
  for (const [label, text] of [["project plan", projectPlan], ["migration plan", migrationPlan]]) {
    assert(
      !text.includes("`usableBenchmarkRows=0`,`selfComparisonRows=12`,`m4OmrDraftQualityReady=false`"),
      `${label} must not keep the obsolete unreviewed M4 self-comparison status after provenance clears`,
    );
    assert(
      !text.includes("下一步必须准备**独立人工校正的 gold score**"),
      `${label} must not send the user back to obsolete M4 manual-gold work after provenance clears`,
    );
  }
  assert(
    !projectPlan.includes("人工复核完成后将下载 CSV 保存为 `controlled-candidate-review.completed.csv`"),
    "project plan must not reassign the completed historical threshold-pool review",
  );
  assert(
    projectPlan.includes("历史失败,已被 P1.1 context-feature 重校准取代"),
    "project plan must distinguish the obsolete confidence-only failure from the current P1.1 release candidate",
  );
} else {
  assert(
    handoff.includes("npm run western:m4-preflight"),
    "M4 next-action handoff must route through preflight while M4 is blocked",
  );
}
for (const [label, text] of [["html", m4ChecklistHtml], ["markdown", m4ChecklistMd]]) {
  assert(
    text.includes("不是教师音频诊断复核"),
    `M4 ${label} checklist must make clear this is not teacher audio review in readable Chinese`,
  );
  assert(
    text.includes("机器") && text.includes("音符"),
    `M4 ${label} checklist must include the machine note-summary context`,
  );
  assert(
    text.includes("npm run western:m4-independent-gold-workspace-audit"),
    `M4 ${label} checklist must require the independent-gold workspace audit`,
  );
  assert(
    text.includes("npm run western:m4-gold-provenance-audit"),
    `M4 ${label} checklist must require provenance self-test before score editing`,
  );
  assert(
    text.includes("editableGoldPath"),
    `M4 ${label} checklist must point score editors at the editable gold path`,
  );
  assert(
    text.includes("reviewStatus"),
    `M4 ${label} checklist must explain the approved reviewStatus gate`,
  );
  assert(
    text.includes("--dry-run"),
    `M4 ${label} checklist must require dry-run before apply`,
  );
  assert(
    !text.includes("涓嶆槸") && !text.includes("鏈哄櫒") && !text.includes("闊崇"),
    `M4 ${label} checklist should not contain common mojibake characters`,
  );
}

const noRequiredGate = evaluateProjectGate(status, new Set());
assert.equal(noRequiredGate.projectReleaseReady, true, "empty required track set should not block");
assert.deepEqual(noRequiredGate.failures, [], "empty required track set should have no failures");

const publicGate = evaluateProjectGate(status, new Set(["public"]));
assert.equal(
  publicGate.gateScope,
  "public-professional-research-candidate",
  "public-only gate must identify itself as research evidence rather than student release",
);
assert.equal(
  publicGate.projectReleaseReady,
  status.publicModelValidation.gates.publicProfessionalMonophonicV2CandidateReady,
  "optional public gate must follow the unified monophonic V2 evidence",
);

const fullGate = evaluateProjectGate(status, new Set(["ordinary", "m3plus", "m4"]));
assert.equal(fullGate.projectReleaseReady, false, "full project gate must block until all required tracks are ready");
assert(fullGate.failures.some((failure) => failure.track === "M2/M3 ordinary upload candidate gate"), "ordinary track failure should be reported");
assert.equal(
  fullGate.failures.find((failure) => failure.track === "M2/M3 ordinary upload candidate gate")?.artifact,
  expectedOrdinaryArtifact,
  "ordinary gate failure should point to the current ordinary-gate evidence artifact",
);
const m3plusFailure = fullGate.failures.find((failure) => failure.track === "M3+ pitch behavior modes");
assert(m3plusFailure, "M3+ should be a project-gate failure after human-confirmed round-two evidence fails");
assert.equal(
  m3plusFailure.artifact,
  m3plus.supplementalIntake.instructions,
  "M3+ project-gate failure should point to the exact current supplemental recording task",
);
const m4Failure = fullGate.failures.find((failure) => failure.track === "M4 OMR benchmark");
assert.equal(m4Failure, undefined, "M4 research benchmark should clear independently while automatic runtime adoption remains closed");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "project-status-tracks-present",
    "public-model-validation-evidence-covered",
    "student-runtime-fail-closed",
    "confidence-pilot-validation-state-covered",
    "m3plus-round2-human-gold-fail-closed-covered",
    "m4-independent-research-benchmark-clears-runtime-stays-closed",
    "m4-checklist-human-readable",
    "handbook-current-status-does-not-reassign-completed-review",
    "project-gate-required-tracks-block-release",
  ],
}, null, 2));
