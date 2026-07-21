import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { evaluateProjectGate } from "./gate-western-strings-project.mjs";
import { renderHandoff } from "./create-western-strings-next-action-handoff.mjs";
import {
  buildProjectStatus,
  auditM3PlusPhysicalEvidenceCurrent,
  summarizeCurrentControlledPilotAuthority,
  summarizeNextActions,
  evaluateHomrDeploymentSnapshot,
  summarizePublicModelValidation,
  validateOrdinaryDynamicShadowAcceptance,
} from "./status-western-strings-project.mjs";

const LIVE_PHYSICAL_TEST_DIR = "data/experiments/western-strings-project-gate-test";
const LIVE_PHYSICAL_TEST_ARTIFACT = `${LIVE_PHYSICAL_TEST_DIR}/m3plus-live-artifact.txt`;
await fs.mkdir(LIVE_PHYSICAL_TEST_DIR, { recursive: true });
try {
  const originalBytes = Buffer.from("m3plus-live-v1\n", "utf8");
  const originalSha256 = crypto.createHash("sha256").update(originalBytes).digest("hex");
  await fs.writeFile(LIVE_PHYSICAL_TEST_ARTIFACT, originalBytes);
  const livePhysicalFixture = {
    runtimeEvidence: {
      candidateRowsPath: LIVE_PHYSICAL_TEST_ARTIFACT,
      candidateRowsSha256: originalSha256,
      runtime: {
        policyArtifactPath: LIVE_PHYSICAL_TEST_ARTIFACT,
        policyArtifactSha256: originalSha256,
        analyzerArtifactPath: LIVE_PHYSICAL_TEST_ARTIFACT,
        analyzerArtifactSha256: originalSha256,
        rescopeReportPath: LIVE_PHYSICAL_TEST_ARTIFACT,
        rescopeReportSha256: originalSha256,
      },
    },
  };
  const currentPhysical = await auditM3PlusPhysicalEvidenceCurrent(livePhysicalFixture);
  assert.equal(currentPhysical.checks["candidate-rows"].current, true);
  assert.equal(currentPhysical.checks["policy-artifact"].current, true);
  assert.equal(currentPhysical.checks["analyzer-artifact"].current, true);
  assert.equal(currentPhysical.checks["rescope-report"].current, true);
  assert.equal(
    currentPhysical.ready,
    false,
    "four matching files alone must not bypass missing source-binding/latest-batch evidence",
  );
  await fs.writeFile(LIVE_PHYSICAL_TEST_ARTIFACT, "m3plus-live-v2\n", "utf8");
  const driftedPhysical = await auditM3PlusPhysicalEvidenceCurrent(livePhysicalFixture);
  assert.equal(driftedPhysical.ready, false, "post-audit file drift must close live physical readiness");
  assert(
    driftedPhysical.blockingReasons.includes("m3plus-live-analyzer-artifact-sha-mismatch"),
    "live analyzer drift must be explicit",
  );
} finally {
  await fs.rm(LIVE_PHYSICAL_TEST_DIR, { recursive: true, force: true });
}

const forgedMinimalAcceptance = validateOrdinaryDynamicShadowAcceptance({
  schemaVersion: 1,
  contractVersion: "western-ordinary-dynamic-shadow-r3-acceptance-v1",
  acceptanceReady: true,
  studentFacing: false,
  automaticAdoptionAuthorized: false,
});
assert.equal(forgedMinimalAcceptance.ready, false, "a minimal self-asserted r3 JSON must not open acceptance");
assert(forgedMinimalAcceptance.blockingReasons.includes("ordinary-dynamic-shadow-r3-recording-set-invalid"));
assert(forgedMinimalAcceptance.blockingReasons.includes("ordinary-dynamic-shadow-r3-evidence-digest-invalid"));

const approvedHomrReviewFixture = {
  decision: {
    status: "approved-with-conditions",
    reviewedBy: "fixture-reviewer",
    approvedScopes: ["controlled-offline-review-only"],
    controlledOfflineReviewApproved: true,
    studentFacingNetworkUseApproved: false,
    redistributionApproved: false,
    confirmations: {
      controlledOfflineOnly: true,
      modelLicenseBasisReviewed: true,
      noModelRedistribution: true,
    },
    approvalBinding: { bindingVersion: 2 },
  },
};
const exactReviewHash = "a".repeat(64);
const exactManifestHash = "b".repeat(64);
const exactLockHash = "c".repeat(64);
const greenPreflightFixture = {
  governanceReady: true,
  deploymentReady: true,
  reviewRecordSha256: exactReviewHash,
  manifestSha256: exactManifestHash,
  lockSha256: exactLockHash,
  blockingReasons: [],
  host: { components: { homr: { ready: true } } },
};
const currentHomrSnapshot = evaluateHomrDeploymentSnapshot({
  review: approvedHomrReviewFixture,
  reviewSha256: exactReviewHash,
  manifestSha256: exactManifestHash,
  lockSha256: exactLockHash,
  preflight: greenPreflightFixture,
});
assert.equal(currentHomrSnapshot.productionPoolReady, true, "exact review hash should retain a green bounded pool");
const staleHomrSnapshot = evaluateHomrDeploymentSnapshot({
  review: approvedHomrReviewFixture,
  reviewSha256: "b".repeat(64),
  manifestSha256: exactManifestHash,
  lockSha256: exactLockHash,
  preflight: greenPreflightFixture,
});
assert.equal(staleHomrSnapshot.productionPoolReady, false, "stale review binding must close the pool");
assert(staleHomrSnapshot.blockingReasons.includes("photo-score-deployment-preflight-stale-review-record"));
const pendingHomrSnapshot = evaluateHomrDeploymentSnapshot({
  review: { decision: { status: "pending" } },
  reviewSha256: exactReviewHash,
  manifestSha256: exactManifestHash,
  lockSha256: exactLockHash,
  preflight: greenPreflightFixture,
});
assert.equal(pendingHomrSnapshot.licenseReviewReady, false, "pending governance must fail closed even with a green cached preflight");
assert(pendingHomrSnapshot.blockingReasons.includes("homr-license-review-not-approved"));
const staleManifestSnapshot = evaluateHomrDeploymentSnapshot({
  review: approvedHomrReviewFixture,
  reviewSha256: exactReviewHash,
  manifestSha256: "d".repeat(64),
  lockSha256: exactLockHash,
  preflight: greenPreflightFixture,
});
assert.equal(staleManifestSnapshot.productionPoolReady, false, "manifest drift must close the pool");
assert(staleManifestSnapshot.blockingReasons.includes("photo-score-deployment-preflight-stale-manifest"));
const staleLockSnapshot = evaluateHomrDeploymentSnapshot({
  review: approvedHomrReviewFixture,
  reviewSha256: exactReviewHash,
  manifestSha256: exactManifestHash,
  lockSha256: "d".repeat(64),
  preflight: greenPreflightFixture,
});
assert.equal(staleLockSnapshot.productionPoolReady, false, "lock drift must close the pool");
assert(staleLockSnapshot.blockingReasons.includes("photo-score-deployment-preflight-stale-lock"));

const status = await buildProjectStatus();

assert.equal(status.runtimeStudentGate.policy, "fail-closed", "student runtime gate must remain fail-closed");
assert.equal(status.reviewPolicy?.rule, "machine-self-test-before-human-review", "project status must expose the review policy");
assert.equal(status.reviewPolicy?.source, "docs/western-strings-review-policy.md", "project status must point to the review policy document");
assert.equal(status.runtimeStudentGate.ordinaryUploadAutoFeedbackReady, false, "ordinary upload must not auto-feedback before release gate");
assert.equal(status.runtimeStudentGate.m3plusAutoFeedbackReady, false, "M3+ mode feedback must stay disabled before labels are ready");
assert.equal(status.runtimeStudentGate.m4OmrAutoScoreReady, false, "M4 OMR auto score must stay disabled before independent gold");
assert.equal(
  status.photoScoreOfflineChain.productionPoolReady,
  status.tracks.m4Omr.m4HomrProductionPoolReady,
  "top-level photo-score status must share the strict hash-bound deployment verdict",
);
assert.equal(status.photoScoreOfflineChain.studentFacing, false, "bounded offline pool must never open student-facing use");
assert.equal(status.photoScoreOfflineChain.automaticAdoptionAuthorized, false, "bounded offline pool must never open automatic adoption");
assert.ok(status.publicProfessionalBenchmark, "public professional benchmark status must always be present");
assert.equal(
  status.publicProfessionalBenchmark.defaultStudentReleaseEligible,
  false,
  "public professional recordings must never enable the student release gate",
);
assert.ok(status.publicModelValidation, "public model validation status must always be present");
assert.equal(
  status.publicModelValidation.recognition?.phenicxHumanGold?.reportAvailable,
  true,
  "project status must expose the PHENICX independent human-gold recognition benchmark",
);
assert.equal(
  status.publicModelValidation.recognition?.phenicxHumanGold?.scoreUsedDuringInference,
  false,
  "PHENICX recognition must not use the score during audio event inference",
);
assert.equal(
  status.publicModelValidation.recognition?.phenicxHumanGold?.holdout?.["100ms"]?.precision,
  0.9311246730601569,
  "project status must expose the frozen PHENICX holdout recognition precision",
);
assert.equal(
  status.publicModelValidation.recognition?.phenicxHumanGold?.holdout?.["100ms"]?.doubleStopRecall,
  0.548,
  "project status must expose the measured PHENICX polyphonic recall deficit",
);
assert.equal(
  status.publicModelValidation.recognition?.phenicxHumanGold?.gate?.passed,
  false,
  "PHENICX independent recognition must stay closed below the frozen recall floors",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolin?.reportAvailable,
  true,
  "project status must expose the public MusicNet accompanied-violin benchmark",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolin?.holdout?.aggregate?.["100ms"]?.precision,
  0.3447368421052632,
  "project status must expose the frozen accompanied-violin holdout precision",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolin?.holdout?.aggregate?.["100ms"]?.doubleStopRecall,
  0.07368421052631578,
  "project status must expose the accompanied double-stop deficit",
);
assert.equal(
  status.publicModelValidation.gates.accompaniedViolinRecognitionReady,
  false,
  "accompanied violin must remain closed below all frozen recognition floors",
);
assert(
  status.publicModelValidation.blockingReasons.includes("musicnet-accompanied-violin-recognition-gate-failed"),
  "failed accompanied-violin recognition must remain visible as a public-model blocker",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolinChallenger?.reportAvailable,
  true,
  "project status must expose the frozen YourMT3 instrument-aware challenger",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolinChallenger?.holdout?.aggregate?.["50ms"]?.precision,
  0.8641975308641975,
  "project status must expose the frozen YourMT3 50ms holdout precision",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolinChallenger?.holdout?.aggregate?.["100ms"]?.recall,
  0.7839195979899497,
  "project status must expose the unresolved YourMT3 100ms recall deficit",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolinChallenger?.timingCalibrationProbe?.accepted,
  false,
  "a per-recording timing shift that does not generalize must stay rejected",
);
assert.equal(
  status.publicModelValidation.recognition?.accompaniedViolinChallenger?.recognitionReady,
  false,
  "YourMT3 challenger must stay closed below all frozen recognition floors",
);
assert(
  status.publicModelValidation.blockingReasons.includes("yourmt3-accompanied-violin-gate-failed"),
  "YourMT3 gate failure must remain visible in the public-model blockers",
);
assert(
  status.publicModelValidation.blockingReasons.includes("yourmt3-space-and-checkpoint-license-unresolved"),
  "an undeclared checkpoint license must block production adoption",
);
assert.ok(status.measureFeedbackAudit, "project status must expose the measure-feedback safety audit");
assert.equal(status.measureFeedbackAudit.measureAggregationReleaseReady, false, "measure aggregation must stay closed when safe coverage is below 20%");
assert.equal(status.measureFeedbackAudit.studentGateReady, false, "eval-only measure aggregation must never directly open student feedback");
assert.equal(status.measureFeedbackAudit.jointEvidence?.missing, undefined, "joint pitch/IOI/energy measure audit must be present");
assert.equal(status.measureFeedbackAudit.jointEvidence?.measureJointEvidenceReleaseReady, false, "joint measure evidence must remain closed below the safe coverage floor");
assert.equal(status.measureFeedbackAudit.jointEvidence?.bestSafeCandidate?.minimumCleanMeasureCoverage, 0.026071, "status must expose the zero-unsafe oracle coverage ceiling");
assert.equal(status.measureFeedbackAudit.jointEvidence?.bestCoverageFloorTradeoff?.allFoldUnsafeTargetMeasureCount, 24, "status must expose the unsafe cost of crossing 20% coverage");
assert.equal(status.measureFeedbackAudit.jointEvidence?.productionPolicyChanged, false, "eval-only joint measure evidence must not change production policy");
const dynamicConfirmation = status.dynamicEvidenceAudit?.combinedWeakConfirmation;
if (dynamicConfirmation && !dynamicConfirmation.missing) {
  assert.equal(
    dynamicConfirmation.freshPublicSyntheticConfirmationReady,
    true,
    "fresh public performers should confirm the wider research gate",
  );
  assert.equal(
    dynamicConfirmation.releaseCoverageReady,
    true,
    "fresh public confirmation should exceed the research coverage floor",
  );
  assert.equal(
    dynamicConfirmation.confirmationRank1?.freshUnits?.length,
    4,
    "rank-1 confirmation must exclude overlap and retain four fresh performers",
  );
  assert.equal(
    dynamicConfirmation.confirmationRank1?.excludedOverlapUnits?.length,
    2,
    "rank-1 confirmation must report the two excluded rank-0 overlaps",
  );
  assert.equal(
    dynamicConfirmation.confirmationRank1?.allErrorUnsafeTargetAutoPassCount,
    0,
    "fresh public confirmation must not auto-pass synthetic error targets",
  );
  assert.ok(
    dynamicConfirmation.confirmationRank1?.clean?.precisionWithin300ms >= 0.90,
    "fresh public confirmation must retain at least 90% clean precision",
  );
  assert.ok(
    dynamicConfirmation.confirmationRank1?.clean?.coverage >= 0.20,
    "fresh public confirmation must retain at least 20% clean coverage",
  );
  assert.equal(
    dynamicConfirmation.studentGateReady,
    false,
    "public synthetic confirmation must never directly open student feedback",
  );
}
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
    recognition: {
      evidenceType: "independent-audio-event-recognition-against-manual-note-gold",
      scoreUsedDuringInference: false,
      polyphonicRecognitionGate: { passed: false },
    },
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
assert.equal(m3plus.m3plusModeEvalReady, true, "M3+ rescope report should be available for offline pitch-safety evaluation");
const rescopeReleaseReady = m3plus.rescopeGate?.releaseGateReady === true;
assert.equal(m3plus.offlineEvidenceReady, rescopeReleaseReady, "offline evidence must mirror the authoritative rescope release gate");
assert.equal(m3plus.reviewOnlyRuntimeWired, true, "the gold-free M3+ policy should be wired into the review-only batch runtime");
assert.equal(m3plus.runtimeFoundationReady, true, "the physical latest batch should pass the M3+ runtime foundation audit");
assert.equal(m3plus.runtimeAuditReady, true, "the physical candidate rows should pass the fail-closed runtime audit");
assert.equal(m3plus.physicalEvidenceCurrent, true, "cached M3+ audit hashes must still match every live file-backed artifact");
// authorizationReady is driven by the owner's standing approval file, not by
// runtime/evidence wiring alone; assert whichever state currently holds is
// internally consistent (see test-western-status-track-authorization.mjs for
// the isolated proof that evidence readiness alone cannot grant it).
if (m3plus.authorizationReady === true) {
  assert.deepEqual(
    m3plus.blockingReasons?.filter((reason) => reason.startsWith("authorization-approval-")) || [],
    [],
    "a granted M3+ authorization must carry no residual approval-check reasons",
  );
} else {
  assert(
    m3plus.blockingReasons?.includes("m3plus-authorization-closed"),
    "a non-granted M3+ authorization must carry an explicit authorization-closed reason",
  );
}
assert.equal(m3plus.m3plusPitchSafetyReady, m3plus.offlineEvidenceReady && m3plus.runtimeFoundationReady && m3plus.runtimeAuditReady && m3plus.physicalEvidenceCurrent, "pitch safety must follow offline evidence plus runtime audits, never exceed them");
assert.equal(m3plus.m3plusModeReleaseReady, m3plus.m3plusPitchSafetyReady, "the legacy release alias must follow the hardened offline-plus-runtime verdict");
assert.equal(m3plus.studentGateReady, false, "offline M3+ pitch-safety evidence must not open the student runtime");
assert.equal(m3plus.rescopeGate?.sourceExists, true, "M3+ status must expose the authoritative rescope report");
assert.equal(m3plus.rescopeGate?.schemaVersion, 2, "M3+ status must reject the superseded aggregate schema");
assert.equal(m3plus.rescopeGate?.contract, "m3plus-rescope-four-zone-v2", "M3+ status must bind the v2 rescope contract");
assert.equal(typeof m3plus.rescopeGate?.releaseGateReady, "boolean", "rescope release readiness must be an explicit boolean");
if (m3plus.rescopeGate?.releaseGateReady === true) {
  assert.equal(m3plus.rescopeGate?.declaredOnlyProtectedCount ?? 0, 0, "a green rescope gate requires every declared protected unit to be evaluated");
}
assert.equal(m3plus.rescopeGate?.studentGateReady, false, "M3+ rescope evaluation must remain offline-only");
assert.equal(m3plus.rescopeGate?.sourceEvidence?.round2DeclaredOnlyMarkedCount, 6, "M3+ rescope gate must distinguish six declared-only protected units from executed policy decisions");
assert.equal(m3plus.rescopeGate?.sourceEvidence?.round2UnscoredVibratoGoldCount, 17, "M3+ rescope gate must expose the seventeen unscored legacy vibrato units");
assert.equal(m3plus.rescopeGate?.zones?.unmarkedStraight?.decisionCount, 8, "straight-tone zone must retain eight holdout decisions");
assert.equal(m3plus.rescopeGate?.zones?.unmarkedStraight?.precision, 1, "straight-tone center-pitch precision must remain perfect on frozen decisions");
assert.equal(m3plus.rescopeGate?.zones?.unmarkedStraight?.unsafeAccusationCount, 0, "straight-tone zone must have zero unsafe accusations");
const markedZone = m3plus.rescopeGate?.zones?.scoreMarkedNeutral || {};
assert.equal((markedZone.evaluatedProtectedCount ?? 0) + (markedZone.declaredOnlyProtectedCount ?? 0), 14, "declared-or-evaluated protected units must total fourteen");
assert.equal(markedZone.totalDeclaredOrEvaluatedCount, 14, "status must report fourteen declared-or-evaluated units");
if (rescopeReleaseReady) {
  assert.equal(markedZone.evaluatedProtectedCount, 14, "a green rescope gate requires all fourteen protected units executed");
  assert.equal(markedZone.declaredOnlyProtectedCount, 0, "a green rescope gate leaves no declared-only protected units");
}
assert.equal(m3plus.rescopeGate?.zones?.scoreMarkedNeutral?.accusationCount, 0, "score-marked regions must issue zero pitch accusations");
assert.equal(m3plus.rescopeGate?.zones?.techniqueCenter?.decisionCount, 3, "score-intent center probe must retain three decisions");
assert.equal(m3plus.rescopeGate?.zones?.techniqueCenter?.scoreIntentCenterAgreementRate, 1, "the three decisions may retain score-intent center agreement");
const centerZone = m3plus.rescopeGate?.zones?.techniqueCenter || {};
assert.equal((centerZone.intonationGoldJoinedDecisionCount ?? 0) + (centerZone.intonationGoldUnjoinedDecisionCount ?? 0), centerZone.decisionCount, "center decisions must partition into joined plus unjoined gold");
assert.equal(centerZone.goldJoinReady, (centerZone.intonationGoldUnjoinedDecisionCount ?? 1) === 0, "gold join readiness must mean every center decision joins independent gold");
assert.equal(m3plus.rescopeGate?.zones?.unstableFailClosed?.testedCount, 3, "dispersion fallback must retain three frozen stress cases");
assert.equal(m3plus.rescopeGate?.zones?.unstableFailClosed?.insufficientEvidenceCount, 3, "every unstable stress case must become insufficient evidence");
assert.equal(m3plus.rescopeGate?.zones?.unstableFailClosed?.accusationCount, 0, "unstable stress cases must issue zero accusations");
if (!rescopeReleaseReady) {
  assert((m3plus.blockingReasons || []).includes("m3plus-rescope-score-marked-declared-only-not-evaluated")
    || (m3plus.blockingReasons || []).includes("m3plus-rescope-center-intonation-gold-join-missing"),
    "a red rescope gate must surface its evidence blockers");
} else {
  assert(!(m3plus.blockingReasons || []).some((reason) => String(reason).startsWith("m3plus-rescope-")),
    "a green rescope gate must not leave stale rescope blockers");
  // Authorization is driven exclusively by the owner's standing approval
  // file (see evaluateTrackAuthorizationFromApproval), never by evidence
  // readiness alone; assert whichever state currently holds is internally
  // consistent rather than assuming evidence can never be paired with a
  // real approval.
  if (m3plus.authorizationReady === true) {
    assert(!(m3plus.blockingReasons || []).includes("m3plus-authorization-closed"),
      "a granted authorization must clear the authorization-closed reason");
  } else {
    assert((m3plus.blockingReasons || []).includes("m3plus-authorization-closed"),
      "green evidence alone must still leave release authorization closed");
  }
}
assert.equal(m3plus.monitoredPilotAudit?.contract, "m3plus-rescope-four-zone-v2", "monitored audit must consume the v2 rescope contract");
assert.equal(m3plus.monitoredPilotAudit?.runtimeContract, "m3plus-gold-free-runtime-v1", "monitored audit must consume the gold-free runtime contract");
assert.equal(m3plus.monitoredPilotAudit?.readyForMonitoredPilot, m3plus.offlineEvidenceReady === true, "monitored-pilot readiness must mirror offline evidence, never exceed it");
assert.equal(m3plus.coarseStateEval?.sourceExists, true, "M3+ status must expose the teacher-style coarse-state probe");
assert.equal(m3plus.coarseStateEval?.joinReady, true, "all reviewed M3+ rows must join their frozen window features exactly");
assert.equal(m3plus.coarseStateEval?.eligibleMatchedRows, 74, "coarse-state probe must use the 74 matched, known-behavior rows");
assert.equal(m3plus.coarseStateEval?.coarseStateRuntimeReady, false, "exploratory coarse states must stay out of runtime");
assert.equal(m3plus.modeEval?.researchOnly, true, "legacy technique detector evaluation must be marked research-only");
assert.equal(m3plus.modeEval?.releaseAuthority, false, "legacy technique detector evaluation must not decide release");
assert.equal(m3plus.modeEval?.m3plusModeReleaseReady, false, "historical detector release result should remain visible without controlling the new gate");
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
assert(!(m3plus.blockingReasons || []).includes("m3plus-round2-mode-detection-below-90-percent"), "retired round-two detector failure must not remain a top-level blocker");
assert((m3plus.researchOnlyDetectorBlockingReasons || []).includes("m3plus-round2-mode-detection-below-90-percent"), "retired round-two detector failure must remain visible as research evidence");
assert(!(m3plus.blockingReasons || []).includes("m3plus-round2-negative-controls-missing"), "M3+ status must clear the stale negative-control blocker once m3p-01 passes");
assert.equal(m3plus.supplementalIntake?.sourceExists, true, "M3+ status must expose the prepared supplemental intake");
assert.equal(m3plus.supplementalIntake?.recordingCount, 4, "M3+ supplemental intake must contain four targeted recordings");
assert.equal(m3plus.supplementalIntake?.readyRecordingCount, 4, "M3+ supplemental intake must expose all four recorded takes");
assert.equal(m3plus.supplementalIntake?.missingRecordingCount, 0, "M3+ supplemental intake must not keep stale missing-recording counts");
assert.equal(m3plus.supplementalIntake?.readyForMachineAnalysis, true, "M3+ supplemental intake must be ready once all four audio files exist");
assert.equal(m3plus.supplementalIntake?.humanTask, "none", "M3+ intake must not request recordings that already exist");
assert(
  String(m3plus.supplementalIntake?.instructions || "").replaceAll("\\", "/").endsWith("音频/m3plus-supplemental/README-录音说明.md"),
  "M3+ status must point to the supplemental recording instructions",
);
assert(!(m3plus.blockingReasons || []).includes("m3plus-supplemental-recordings-not-ready"), "M3+ must clear the stale missing-recordings blocker");
assert.equal(m3plus.supplementalMachineEval?.sourceExists, true, "M3+ status must expose the supplemental machine-eval report");
assert(["crepe", "pyin"].includes(m3plus.supplementalMachineEval?.f0Backend), "M3+ status must expose the actual bounded frame-F0 backend");
assert.equal(m3plus.supplementalMachineEval?.scoreTechniqueIntentReady, true, "M3+ supplemental score markings must match the frozen technique intent before audio review");
assert.equal(m3plus.supplementalMachineEval?.machineAnalysisComplete, false, "M3+ machine eval must fail closed while three takes do not fully localize");
assert.equal(m3plus.supplementalMachineEval?.teacherReviewAllowed, false, "M3+ machine eval must not request teacher work before passing");
assert.equal(m3plus.supplementalMachineEval?.studentGateReady, false, "M3+ supplemental evidence must never directly open the student gate");
assert.equal(m3plus.supplementalMachineEval?.straightNegativeControlReady, true, "m3p-01 must count as the real straight-tone negative control");
assert.equal(m3plus.supplementalMachineEval?.ornamentRealSamplePresent, true, "m3p-03 must be recognized as a real ornament sample even while validation remains closed");
assert(!(m3plus.blockingReasons || []).includes("m3plus-ornament-real-sample-missing"), "M3+ must not claim that the existing ornament recording is missing");
assert(!(m3plus.blockingReasons || []).includes("m3plus-ornament-real-sample-not-validated"), "retired ornament detector evidence must not block the respecified release gate");
assert((m3plus.researchOnlyDetectorBlockingReasons || []).includes("m3plus-ornament-real-sample-not-validated"), "present-but-unvalidated ornament evidence must remain visible in research-only diagnostics");
{
  const localizationRows = m3plus.supplementalMachineEval?.recordings?.map((recording) => [
    recording.recordingId,
    recording.localizationReady,
    recording.readyUnitCount,
    recording.unitCount,
    recording.scoreTransposeSemitones,
  ]) || [];
  const byId = Object.fromEntries(localizationRows.map((row) => [row[0], row]));
  assert.deepEqual(byId["m3p-01"], ["m3p-01", true, 8, 8, 12], "m3p-01 localization must stay 8/8 at +12");
  assert.deepEqual(byId["m3p-02"], ["m3p-02", false, 10, 16, 12], "m3p-02 frozen localization must stay 10/16");
  assert.deepEqual(byId["m3p-03"], ["m3p-03", false, 14, 16, 12], "m3p-03 frozen localization must stay 14/16");
  // m3p-04 carries a documented borderline unit (measure-7 closing straight
  // tone) that flips across regenerations; both frozen outcomes stay red.
  assert.equal(byId["m3p-04"]?.[0], "m3p-04");
  assert.equal(byId["m3p-04"]?.[1], false, "m3p-04 localization must stay red either side of the borderline unit");
  assert([13, 14].includes(byId["m3p-04"]?.[2]), "m3p-04 ready units must stay at the documented 13/16 or 14/16 boundary");
  assert.deepEqual(byId["m3p-04"]?.slice(3), [16, 12]);
  if (byId["r2-06"]) {
    assert.equal(byId["r2-06"][1], true, "the sparse-label r2-06 evaluation must localize against the full score");
    assert.equal(byId["r2-06"][3], 23, "r2-06 must localize all twenty-three score notes");
    assert.equal(byId["r2-06"][4], 0, "r2-06 plays at written pitch");
  }
}
assert.equal(m3plus.supplementalProtocolDiagnostic?.sourceExists, true, "M3+ status must expose the protocol-order diagnostic");
assert.equal(m3plus.supplementalProtocolDiagnostic?.postHocProtocolInference, true, "M3+ must label the inferred protocol order as post-hoc");
assert.equal(m3plus.supplementalProtocolDiagnostic?.bestLocalizationCandidate, "observed-same-pitch-repeat", "M3+ must expose the 16/16 m3p-02 localization candidate");
assert.deepEqual(
  m3plus.supplementalProtocolDiagnostic?.scoreAdherenceSummary,
  {
    expectedTrillUnitCount: 8,
    trillUnitsWithExecutionEvidence: 7,
    issueCandidateCount: 1,
    formalMetricRelabeled: false,
    ownerConfirmationRequired: true,
  },
  "M3+ must isolate the one likely performance miss without rewriting the formal metric",
);
assert.equal(m3plus.supplementalProtocolDiagnostic?.scoreAdherenceIssueCandidates?.length, 1, "M3+ must expose exactly one score-adherence issue candidate");
assert.equal(m3plus.supplementalProtocolDiagnostic?.scoreAdherenceIssueCandidates?.[0]?.measure, 8, "M3+ issue candidate must remain localized to the last holdout trill");
assert.equal(m3plus.supplementalProtocolDiagnostic?.multivariateAudit?.heldoutGatePassed, false, "M3+ fixed multivariate audit must remain held-out and fail-closed");
assert.equal(m3plus.supplementalProtocolDiagnostic?.boundaryRefinementAudit?.multivariateAudit?.heldoutGatePassed, false, "M3+ boundary-refined multivariate audit must not be promoted when recall remains low");
assert.equal(m3plus.supplementalFeatureAudit?.sourceExists, true, "M3+ status must expose held-out feature separability evidence");
assert.equal(m3plus.supplementalFeatureAudit?.anyFeaturePassesHeldoutGate, false, "M3+ feature audit must remain fail-closed");
assert.equal(m3plus.supplementalBackendConsensus?.sourceExists, true, "M3+ status must expose cross-backend holdout evidence");
assert.equal(m3plus.supplementalBackendConsensus?.independentReleaseModesReady, false, "cross-backend holdout must override stale review-set release claims");
assert.equal(m3plus.supplementalBackendConsensus?.modes?.slide?.physicalThresholdAudit?.holdout?.precision, 1, "slide holdout precision must remain visible");
assert.equal(m3plus.supplementalBackendConsensus?.modes?.slide?.physicalThresholdAudit?.holdout?.recall, 0.75, "slide holdout recall must remain visible");
const m3p03Repair = m3plus.supplementalMachineEval?.repairPlans?.find((item) => item.recordingId === "m3p-03");
assert.equal(m3p03Repair?.retainedUnitCount, 14, "m3p-03 must retain its fourteen reliable units");
assert.equal(m3p03Repair?.fullRerecordRequired, false, "m3p-03 must not request a full rerecord for two local failures");
assert.deepEqual(m3p03Repair?.unresolvedUnits?.map((item) => item.measure), [1, 5], "m3p-03 repair must target the two D5 ornament groups");
const m3p04Repair = m3plus.supplementalMachineEval?.repairPlans?.find((item) => item.recordingId === "m3p-04");
assert.equal(m3p04Repair?.retainedUnitCount, 13, "m3p-04 must retain its thirteen reliable units");
assert.equal(m3p04Repair?.fullRerecordRequired, false, "m3p-04 must not request a full rerecord for local failures");
assert.deepEqual(m3p04Repair?.unresolvedUnits?.map((item) => item.measure), [7, 8, 8], "m3p-04 repair plan must expose the marginal measure-7 control and final failed group");
const m3plusNextAction = status.nextActions.find((action) => action.track === "M3+ pitch safety rescope");
if (m3plus.offlineEvidenceReady === true) {
  assert(m3plusNextAction?.action.includes("Keep the student runtime disabled"), "a green M3+ handoff must still pin the student runtime closed");
  if (
    m3plus.runtimeFoundationReady === true
    && m3plus.runtimeAuditReady === true
    && m3plus.authorizationReady === true
    && m3plus.monitoredPilotAudit?.readyForMonitoredPilot === true
  ) {
    assert(m3plusNextAction?.action.includes("controlled pilot is ready to start"), "a fully green M3+ handoff must expose monitored-pilot readiness");
    assert(!m3plusNextAction?.action.includes("not wired"), "a fully green M3+ handoff must not claim its executor or authorization is unwired");
    assert.deepEqual(m3plusNextAction?.reason, ["m3plus-default-student-runtime-fail-closed"], "a fully green M3+ handoff must name only the intentional default-runtime boundary");
  }
} else {
  assert(m3plusNextAction?.action.includes("six declared-only protected units"), "M3+ handoff must name the unexecuted protected-unit gap");
  assert(m3plusNextAction?.action.includes("independent per-unit intonation gold"), "M3+ handoff must name the missing gold join");
  assert(m3plusNextAction?.action.includes("review-only and fail-closed"), "M3+ handoff must preserve the closed runtime boundary");
  assert(m3plusNextAction?.artifact.endsWith("m3plus-monitored-pilot-audit.json"), "M3+ handoff must point to the hardened physical-evidence audit");
}
assert.equal(status.tracks.m4Omr.m4MeasureAudioRhythmRankingGatePassed, false, "M4 measure-level audio rhythm ranking must remain below the eval-only gate");
assert.equal(status.tracks.m4Omr.audioRhythmRanking?.measureLevel?.runtimeReady, false, "M4 measure-level audio rhythm evidence must never directly edit a score");
if (m3plus.monitoredPilotAudit?.sourceExists) {
  assert.equal(
    m3plus.monitoredPilotAudit.contract,
    "m3plus-rescope-four-zone-v2",
    "M3+ pilot audit must run the rescope four-zone contract, not the superseded slide/trill contract",
  );
  assert.equal(m3plus.monitoredPilotAudit.runtimeContract, "m3plus-gold-free-runtime-v1", "M3+ pilot audit must bind the gold-free runtime contract");
  assert.equal(
    m3plus.monitoredPilotAudit.readyForMonitoredPilot,
    m3plus.offlineEvidenceReady === true,
    "monitored-pilot readiness must mirror the authoritative rescope evidence",
  );
  assert.equal(m3plus.monitoredPilotAudit.teacherReviewNeeded, false, "M3+ monitored pilot audit must not ask for more review when all auto-pass evidence is already known");
  assert.equal(m3plus.monitoredPilotAudit.defaultM3PlusReadyAfter, false, "M3+ monitored pilot audit must keep default runtime disabled");
  for (const zoneName of ["unstableFailClosed", "rhythmOnset"]) {
    assert.equal(
      m3plus.monitoredPilotAudit.zones?.[zoneName]?.ready,
      true,
      `${zoneName} zone should retain its bounded green evidence`,
    );
  }
  const auditZoneExpected = m3plus.offlineEvidenceReady === true;
  assert.equal(m3plus.monitoredPilotAudit.zones?.unmarkedStraight?.ready, auditZoneExpected, "the straight zone must mirror the joined intonation-gold state");
  assert.equal(m3plus.monitoredPilotAudit.zones?.unmarkedStraight?.expectedGoldUnitCount, 12, "the v2 straight-gold denominator must remain frozen at twelve units");
  assert.equal(m3plus.monitoredPilotAudit.zones?.unmarkedStraight?.joinedGoldUnitCount, auditZoneExpected ? 12 : 0, "the straight-gold join count must be explicit");
  assert.equal(m3plus.monitoredPilotAudit.zones?.scoreMarkedNeutral?.ready, auditZoneExpected, "the neutral zone must mirror the executed protected-unit state");
  assert.equal(m3plus.monitoredPilotAudit.zones?.techniqueCenter?.ready, auditZoneExpected, "the center zone must mirror the joined intonation-gold state");
  assert.equal(
    m3plus.monitoredPilotAudit.zones?.rhythmOnset?.inherited,
    "inherits-m3-core-gate-unchanged",
    "rhythm/onset lane must stay inherited from the unchanged M3 core gate",
  );
  if (m3plus.offlineEvidenceReady === true) {
    assert(!(m3plus.monitoredPilotAudit.blockingReasons || []).some((reason) => String(reason).startsWith("m3plus-zone-not-ready")),
      "green offline evidence must clear the zone-not-ready blockers");
  } else {
    assert((m3plus.monitoredPilotAudit.blockingReasons || []).some((reason) => String(reason).startsWith("m3plus-zone-not-ready")),
      "red offline evidence must surface the failing zone");
  }
}

const controlled = status.tracks.controlledCandidate;
assert.equal(controlled.studentSafeCandidateGateReady, false, "ordinary upload must still require blind validation");
assert.equal(controlled.confidencePilot?.releaseCandidateFound, true, "confidence pilot should report release candidates");
assert.equal(controlled.confidencePilot?.readyForStudentGate, false, "eval-only confidence pilot must not mark runtime gate ready");
assert.equal(controlled.confidencePilot?.validationEval?.readyForRuntimeGate, false, "validation eval must not enable runtime gate");
if (controlled.confidencePilot?.validationEval?.blindValidationPassed) {
  assert.equal(controlled.confidencePilot?.needsBlindValidation, false, "passed blind validation should clear needsBlindValidation");
  assert.equal(controlled.confidencePilot?.runtimeGateWired, true, "historical evidence should still report that the RF runtime manifest existed");
  assert.equal(
    controlled.confidencePilot?.runtimeGateWiringScope,
    "historical-rf-disabled-by-default-no-current-authority",
  );
  assert(
    controlled.blockingReasons.includes("ordinary-rf-monitored-pilot-authorization-superseded"),
    "historical RF wiring must have no current pilot authority",
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
assert.equal(
  controlled.confidencePilot?.monitoredPilotAudit?.historicalReadyForMonitoredPilot,
  true,
  "the 3/3 RF result must remain visible only as historical evidence",
);
assert.equal(controlled.confidencePilot?.monitoredPilotAudit?.readyForMonitoredPilot, false);
assert.equal(
  controlled.confidencePilot?.monitoredPilotAudit?.authorizationStatus,
  "superseded-historical-rf-only",
);
assert.equal(controlled.ordinaryDynamicShadow?.foundationReady, true);
assert.equal(controlled.ordinaryDynamicShadow?.runtimePreflightReady, true);
assert.equal(controlled.ordinaryDynamicShadow?.liveArtifactVerifierReady, true);
const shadowAcceptanceReady = controlled.ordinaryDynamicShadow?.r3AcceptanceReady === true;
if (shadowAcceptanceReady) {
  assert.equal(
    controlled.ordinaryDynamicShadow?.acceptanceEvidence?.liveArtifactAudit?.ready,
    true,
    "green r3 acceptance requires the live-artifact audit to be current",
  );
  assert(
    !controlled.ordinaryDynamicShadow.blockingReasons.some((reason) => reason.startsWith("ordinary-dynamic-shadow-r3-")),
    "green r3 acceptance must clear every r3 blocking reason",
  );
} else {
  assert(
    controlled.ordinaryDynamicShadow?.blockingReasons?.some((reason) => reason.startsWith("ordinary-dynamic-shadow-r3-")),
    "a non-green r3 acceptance must carry an explicit r3 blocking reason",
  );
}
const shadowAuthorizationReady = controlled.ordinaryDynamicShadow?.authorizationReady === true;
if (shadowAuthorizationReady) {
  assert.deepEqual(
    controlled.ordinaryDynamicShadow?.authorizationEvidence?.blockingReasons,
    [],
    "a granted authorization must carry no residual approval-check reasons",
  );
  assert(
    !controlled.ordinaryDynamicShadow.blockingReasons.includes("ordinary-dynamic-shadow-authorization-closed"),
    "a granted authorization must clear the authorization-closed reason",
  );
} else {
  assert(
    controlled.ordinaryDynamicShadow?.blockingReasons?.includes("ordinary-dynamic-shadow-authorization-closed"),
    "a non-granted authorization must carry an explicit authorization-closed reason",
  );
}
// authorizationReady only ever unlocks the review-only monitored PILOT; the
// student-facing gate is a structurally separate, always-conservative flag
// and must never be derived from it.
assert.equal(controlled.ordinaryDynamicShadow?.studentGateReady, false, "authorization must never imply the student gate");
assert.equal(controlled.ordinaryDynamicShadow?.automaticAdoptionReady, false, "authorization must never imply automatic adoption");
const policyC = controlled.ordinaryDynamicShadow?.policyCReviewAssistEvidence;
assert.equal(policyC?.contract, "western-round4-policy-c-review-assist-v1");
assert.equal(policyC?.scope, "implementation-evidence-preGateOnly");
assert.equal(policyC?.ready, true, "Policy C round-4 evidence must pass its live re-audit");
assert.equal(policyC?.reviewAssistGateReady, true);
assert.equal(policyC?.autoAccusationReady, false, "Policy C must never be promoted into automatic accusation");
assert.equal(policyC?.planted?.detected, 6);
assert.equal(policyC?.planted?.total, 12);
assert.equal(policyC?.nonPlanted?.strictFalseAccusations, 0);
assert.equal(policyC?.nonPlanted?.selfCheckHints, 3);
assert.equal(policyC?.nonPlanted?.total, 253);
assert.equal(policyC?.energyRobustnessReady, false, "assignment-gap evidence is not waveform-energy robustness evidence");
assert.deepEqual(policyC?.blockingReasons, []);
const policyCRuntime = controlled.ordinaryDynamicShadow?.policyCReviewAssistRuntime;
assert.equal(policyCRuntime?.contract, "western-round4-policy-c-review-assist-v1");
assert.equal(policyCRuntime?.ready, true, "Policy C must be present in the latest physical teacher-review batch");
assert.equal(policyCRuntime?.mechanismReady, true);
assert.equal(policyCRuntime?.candidateAvailable, policyCRuntime?.outputCount > 0);
assert.equal(policyCRuntime?.readyForReview, policyCRuntime?.ready && policyCRuntime?.candidateAvailable);
assert.equal(policyCRuntime?.reviewerOnly, true);
assert.equal(policyCRuntime?.studentFacing, false);
assert.equal(policyCRuntime?.automaticAccusationAuthorized, false);
assert.match(policyCRuntime?.candidateRowsSha256 || "", /^[a-f0-9]{64}$/);
assert.equal(
  policyCRuntime?.outputCount,
  policyCRuntime?.confirmedIssueCandidateCount + policyCRuntime?.selfCheckHintCount,
);
assert.deepEqual(policyCRuntime?.blockingReasons, []);
const round5TargetedIntake = controlled.ordinaryDynamicShadow?.round5TargetedIntake;
assert.equal(
  round5TargetedIntake?.contract,
  "western-round5-targeted-diagnosis-intake-v1",
  "project status must expose the current Round-5 diagnosis intake contract",
);
assert.equal(round5TargetedIntake?.studentFacing, false);
assert.equal(round5TargetedIntake?.automaticAuthorizationGranted, false);
assert.equal(round5TargetedIntake?.segmentEditPathCandidate?.studentFacing, false);
assert.equal(round5TargetedIntake?.segmentEditPathCandidate?.automaticAccusationReady, false);
assert.equal(round5TargetedIntake?.segmentEditPathCandidate?.productionAdoptionReady, false);
assert.equal(round5TargetedIntake?.segmentEditPathCandidate?.smokeDiagnostic?.evidenceValid, true);
assert.equal(
  round5TargetedIntake?.segmentEditPathCandidate?.smokeDiagnostic?.architectureCandidateRetained,
  false,
);
assert.equal(
  round5TargetedIntake?.segmentEditPathCandidate?.smokeDiagnostic?.structuralRound4Union?.truePositive,
  5,
);
assert.equal(
  round5TargetedIntake?.segmentEditPathCandidate?.smokeDiagnostic?.structuralRound4Union?.falsePositive,
  6,
);
const temporalPath = round5TargetedIntake?.segmentEditPathCandidate?.temporalOperationPathDiagnostic;
const ordinaryRecallAction = status.nextActions.find(
  (action) => action.track === "Ordinary diagnosis recall",
);
assert(
  ordinaryRecallAction?.action.includes("docs/round5-targeted-diagnosis-capture-pack/index.html"),
  "the recall handoff must point to the executable complete-inventory capture pack",
);
assert.equal(temporalPath?.evidenceValid, true);
assert.equal(temporalPath?.sourceBindingCurrent, true);
assert.equal(temporalPath?.rawArchitectureCandidateRetained, false);
assert.equal(temporalPath?.rawRound4Union?.truePositive, 11);
assert.equal(temporalPath?.rawRound4Union?.falsePositive, 55);
assert.equal(temporalPath?.gapRefinementCandidateRetainedForFreshBlind, true);
assert.equal(temporalPath?.gapStrictIssueCandidateRetainedForFreshBlind, true);
const gapStrict = temporalPath?.gapStrictIssueCandidate;
assert.equal(gapStrict?.contract, "western-round5-gap-strict-issue-candidate-pre-gate-v1");
assert.equal(gapStrict?.outputSemantic, "issue_detected_candidate");
assert.equal(gapStrict?.syntheticHoldout?.safetyAgainstAllKnownErrors?.truePositive, 10);
assert.equal(gapStrict?.syntheticHoldout?.safetyAgainstAllKnownErrors?.falsePositive, 0);
assert.equal(gapStrict?.syntheticHoldout?.targetGate?.recall, 0.666667);
assert.equal(gapStrict?.round4InspectedReal?.safetyAgainstAllKnownErrors?.truePositive, 4);
assert.equal(gapStrict?.round4InspectedReal?.safetyAgainstAllKnownErrors?.falsePositive, 0);
assert.equal(gapStrict?.round4InspectedReal?.targetGate?.detected, 3);
assert.equal(gapStrict?.naturalCleanStress?.safetyAgainstAllKnownErrors?.falsePositive, 0);
assert.equal(gapStrict?.publicProfessionalStress?.rawRefinedCandidateCount, 595);
assert.equal(gapStrict?.publicProfessionalStress?.emittedCandidateCount, 0);
assert.equal(gapStrict?.publicProfessionalStress?.scopeRejectedRecordingCount, 2);
assert.equal(gapStrict?.strictConfirmedRecallChanged, false);
assert.equal(gapStrict?.automaticAccusationEvidenceReady, false);
assert.equal(gapStrict?.automaticAccusationReady, false);
assert.equal(temporalPath?.round4TwoLayerCombined?.truePositive, 6);
assert.equal(temporalPath?.round4TwoLayerCombined?.falsePositive, 0);
assert.equal(temporalPath?.round4TwoLayerCombined?.strictConfirmedRecallUnchanged, true);
assert.equal(temporalPath?.naturalCleanStress?.falsePositive, 0);
assert.equal(temporalPath?.generalPurposeCandidateRetained, false);
assert.equal(temporalPath?.publicProfessionalStress?.scorePositionCount, 2301);
assert.equal(temporalPath?.publicProfessionalStress?.assignmentGapCount, 936);
assert.equal(temporalPath?.publicProfessionalStress?.refinedFlagCount, 595);
assert.equal(temporalPath?.publicProfessionalStress?.falsePositiveCountAuthoritative, false);
assert.equal(temporalPath?.publicProfessionalStress?.generalPurposeBurdenReady, false);
assert.equal(temporalPath?.rhythmStructuralCandidateRetainedForFreshBlind, true);
assert.equal(temporalPath?.rhythmStructuralRefinement?.syntheticHoldout?.truePositive, 15);
assert.equal(temporalPath?.rhythmStructuralRefinement?.syntheticHoldout?.falsePositive, 0);
assert.equal(temporalPath?.rhythmStructuralRefinement?.syntheticHoldout?.recall, 0.555556);
assert.equal(temporalPath?.rhythmStructuralRefinement?.round4InspectedReal?.truePositive, 4);
assert.equal(temporalPath?.rhythmStructuralRefinement?.round4InspectedReal?.falsePositive, 0);
assert.equal(temporalPath?.rhythmStructuralRefinement?.naturalCleanStress?.falsePositive, 5);
assert.equal(temporalPath?.rhythmStructuralRefinement?.naturalCleanStress?.hintRate, 0.017544);
assert.equal(temporalPath?.rhythmStructuralRefinement?.automaticAccusationReady, false);
const rhythmStrict = temporalPath?.rhythmStrictIssueCandidate;
assert.equal(temporalPath?.rhythmStrictIssueCandidateRetainedForFreshBlind, true);
assert.equal(
  rhythmStrict?.contract,
  "western-round5-rhythm-strict-issue-candidate-pre-gate-v1",
);
assert.equal(rhythmStrict?.outputSemantic, "issue_detected_candidate");
assert.equal(rhythmStrict?.syntheticHoldout?.truePositive, 14);
assert.equal(rhythmStrict?.syntheticHoldout?.falsePositive, 0);
assert.equal(rhythmStrict?.syntheticHoldout?.recall, 0.518519);
assert.equal(rhythmStrict?.round4InspectedReal?.truePositive, 4);
assert.equal(rhythmStrict?.round4InspectedReal?.falsePositive, 0);
assert.equal(rhythmStrict?.naturalCleanStress?.falsePositive, 0);
assert.equal(rhythmStrict?.publicProfessionalStress?.candidateCount, 13);
assert.equal(rhythmStrict?.publicProfessionalStress?.falsePositiveCountAuthoritative, false);
assert.equal(rhythmStrict?.round4RecallLayers?.strictPlusRhythmCandidate?.truePositive, 6);
assert.equal(rhythmStrict?.round4RecallLayers?.strictPlusRhythmCandidate?.falsePositive, 0);
assert.equal(
  rhythmStrict?.round4RecallLayers?.strictPlusRhythmAndGapSelfCheck?.truePositive,
  10,
);
assert.equal(
  rhythmStrict?.round4RecallLayers?.strictPlusRhythmAndGapSelfCheck?.falsePositive,
  0,
);
assert.equal(rhythmStrict?.strictConfirmedRecallChanged, false);
assert.equal(rhythmStrict?.automaticAccusationEvidenceReady, false);
assert.equal(rhythmStrict?.automaticAccusationReady, false);
const targetedGapRunner = temporalPath?.targetedFreshBlindRunner;
assert.equal(targetedGapRunner?.contract, "western-round5-frozen-gap-refinement-v1");
assert.equal(targetedGapRunner?.bindingCurrent, true);
assert.equal(targetedGapRunner?.valid, true);
assert.equal(targetedGapRunner?.runnerWired, true);
assert.equal(targetedGapRunner?.evaluationPerformed, false);
assert.equal(targetedGapRunner?.outputSemantic, "self_check_hint");
assert.equal(targetedGapRunner?.strictConfirmedRecallChanged, false);
assert.equal(targetedGapRunner?.promotionEvidenceEligible, false);
assert.equal(targetedGapRunner?.reviewAssistPromotionReady, false);
assert.equal(targetedGapRunner?.automaticAccusationReady, false);
const targetedGapStrict = targetedGapRunner?.strictIssueCandidate;
assert.equal(
  targetedGapStrict?.contract,
  "western-round5-frozen-gap-strict-issue-candidate-v1",
);
assert.equal(targetedGapStrict?.runnerWired, true);
assert.equal(targetedGapStrict?.evaluationPerformed, false);
assert.equal(targetedGapStrict?.outputSemantic, "issue_detected_candidate");
assert.equal(targetedGapStrict?.strictConfirmedRecallChanged, false);
assert.equal(targetedGapStrict?.promotionEvidenceEligible, false);
assert.equal(targetedGapStrict?.automaticAccusationEvidenceReady, false);
assert.equal(targetedGapStrict?.automaticAccusationReady, false);
assert(targetedGapRunner?.blockingReasons?.includes("round5-targeted-intake-not-ready"));
const targetedRhythmRunner = targetedGapRunner?.rhythmStructuralRefinement;
assert.equal(
  targetedRhythmRunner?.contract,
  "western-round5-frozen-rhythm-structural-refinement-v1",
);
assert.equal(targetedRhythmRunner?.runnerWired, true);
assert.equal(targetedRhythmRunner?.evaluationPerformed, false);
assert.equal(targetedRhythmRunner?.outputSemantic, "self_check_hint");
assert.equal(targetedRhythmRunner?.strictConfirmedRecallChanged, false);
assert.equal(targetedRhythmRunner?.promotionEvidenceEligible, false);
assert.equal(targetedRhythmRunner?.reviewAssistPromotionReady, false);
assert.equal(targetedRhythmRunner?.automaticAccusationReady, false);
const targetedRhythmStrict = targetedRhythmRunner?.strictIssueCandidate;
assert.equal(
  targetedRhythmStrict?.contract,
  "western-round5-frozen-rhythm-strict-issue-candidate-v1",
);
assert.equal(targetedRhythmStrict?.runnerWired, true);
assert.equal(targetedRhythmStrict?.evaluationPerformed, false);
assert.equal(targetedRhythmStrict?.outputSemantic, "issue_detected_candidate");
assert.equal(targetedRhythmStrict?.strictConfirmedRecallChanged, false);
assert.equal(targetedRhythmStrict?.promotionEvidenceEligible, false);
assert.equal(targetedRhythmStrict?.automaticAccusationEvidenceReady, false);
assert.equal(targetedRhythmStrict?.automaticAccusationReady, false);
assert.equal(temporalPath?.promotionEvidenceEligible, false);
assert.equal(temporalPath?.studentFacing, false);
assert.equal(temporalPath?.automaticAccusationReady, false);
assert.equal(
  round5TargetedIntake?.segmentEditPathCandidate?.smokeDiagnostic?.acousticRound4Union?.truePositive,
  1,
);
const rhythmChannel = controlled.ordinaryDynamicShadow?.rhythmChannelEvidence;
assert.equal(rhythmChannel?.contract, "western-round4-relative-ioi-diagnostic-v1");
assert.equal(rhythmChannel?.scope, "preGateOnly-diagnostic");
assert.equal(rhythmChannel?.featureAvailablePositions, 246);
assert.equal(rhythmChannel?.totalPositions, 265);
assert.equal(rhythmChannel?.rhythmTargetTotal, 6);
assert.equal(rhythmChannel?.frozenOperatingPoint?.truePositive, 5);
assert.equal(rhythmChannel?.frozenOperatingPoint?.falsePositive, 37);
assert.equal(rhythmChannel?.bestAtRecallFloor?.precision, 0.166667);
assert.equal(rhythmChannel?.bestAtRecallFloor?.recall, 0.666667);
assert.equal(rhythmChannel?.jointFloorReady, false);
assert.equal(rhythmChannel?.reviewAssistReady, false);
assert.equal(rhythmChannel?.autoAccusationReady, false);
assert(rhythmChannel?.blockingReasons?.includes("no-simple-relative-ioi-threshold-meets-joint-floor"));
assert.equal(status.freshBlindIntake?.readyForMachinePrecheck, false, "the historical first-measure intake must not remain actionable");
assert.equal(status.freshBlindIntake?.historicalReadyForMachinePrecheck, true, "the old intake result may remain visible only as history");
assert.equal(status.freshBlindIntake?.eligibleAsCurrentReleaseEvidence, false);
assert.equal(status.freshBlindIntake?.authorityStatus, "superseded-historical-first-measure-only");
assert.equal(status.freshBlindIntake?.scope?.releaseAuthority, false);
assert((status.freshBlindIntake?.blockingReasons || []).includes("historical-first-measure-intake-superseded"));
for (const track of ["Scoped V2-alpha blind audit preparation", "Fresh blind machine precheck"]) {
  const freshBlindHandoff = renderHandoff({
    generatedAt: "2026-07-18T00:00:00.000Z",
    runtimeStudentGate: status.runtimeStudentGate,
    nextActions: [{
      priority: 1,
      track,
      action: "prepare fresh blind evidence",
      reason: ["historical-first-measure-intake-superseded"],
    }],
  });
  assert(
    freshBlindHandoff.includes("ordinary-dynamic-shadow-full-score-fresh-blind-v1")
      && freshBlindHandoff.includes("not implemented"),
    `${track} must stop on the missing current full-score fresh-blind runner`,
  );
  assert(
    !freshBlindHandoff.includes("npm run western:fresh-blind-intake-stage")
      && !freshBlindHandoff.includes("npm run western:fresh-blind-intake-status")
      && !freshBlindHandoff.includes("western-strings-v2alpha-blind-intake-status.md"),
    `${track} must not route through the superseded first-measure intake commands or artifact`,
  );
}
// A cached release review may legitimately read ready once the owner has
// granted a real standing authorization and live evidence genuinely
// supports it; what must never happen is a STALE cache claiming readiness
// the current live projection does not back. liveEvidenceBindingCurrent is
// the actual freshness proof; assert it rather than pinning readiness itself.
assert.equal(status.releaseReview?.runtimeFailClosed, true);
assert.equal(status.releaseReview?.liveEvidenceBindingCurrent, true, "cached release review must bind the current live ordinary/M3+ projection");
assert.equal(typeof status.releaseReview?.superseded, "boolean");
if (shadowAuthorizationReady && m3plus.authorizationReady === true) {
  assert.equal(status.releaseReview?.readyForControlledPilot, true, "with both tracks genuinely authorized, a freshly rebound cached release review must reflect it");
} else {
  assert.equal(status.releaseReview?.readyForControlledPilot, false, "no cached release review may bypass dynamic acceptance and authorization");
}
assert.equal(status.controlledPilotDecision?.readyForControlledPilotDecision, status.releaseReview?.readyForControlledPilot === true);
assert.equal(status.controlledPilotDecision?.readyToStartControlledPilot, status.releaseReview?.readyForControlledPilot === true);
assert.equal(status.controlledPilotDecision?.liveEvidenceBindingCurrent, true, "refreshed red decision must bind current live evidence");
assert.equal(status.controlledPilotDecision?.authorizationSuperseded, false, "current red evidence is blocked, not stale authority");

const currentAuthorityBinding = {
  contract: "western-controlled-pilot-live-evidence-v1",
  sha256: "e".repeat(64),
  evidence: {
    runtimeFailClosed: true,
    ordinary: {
      foundationReady: true,
      liveArtifactVerifierReady: true,
      r3AcceptanceReady: true,
      authorizationReady: true,
      energyVetoIncluded: false,
      causalEnergyStatus: "excluded-review-only",
    },
    m3plus: {
      offlineEvidenceReady: true,
      reviewOnlyRuntimeWired: true,
      runtimeFoundationReady: true,
      runtimeAuditReady: true,
      physicalEvidenceCurrent: true,
      authorizationReady: true,
      pitchSafetyReady: true,
      evaluationContract: "m3plus-rescope-four-zone-v2",
      runtimeContract: "m3plus-gold-free-runtime-v1",
    },
  },
};
const greenCachedRelease = {
  schemaVersion: 2,
  ordinaryAuthorizationContract: "western-ordinary-dynamic-shadow-release-v1",
  ok: true,
  commandChecksPassed: true,
  requiredEvidenceComplete: true,
  machineChecksComplete: true,
  readyForControlledPilot: true,
  readyForDefaultStudentRelease: false,
  teacherReviewNeeded: false,
  runtimeFailClosed: true,
  tracks: {
    ordinary: {
      readyForControlledPilot: true,
      foundationReady: true,
      liveArtifactVerifierReady: true,
      r3AcceptanceReady: true,
      authorizationReady: true,
      energyVetoIncluded: false,
      causalEnergyStatus: "excluded-review-only",
    },
    m3plus: {
      readyForControlledPilot: true,
      offlineEvidenceReady: true,
      reviewOnlyRuntimeWired: true,
      runtimeFoundationReady: true,
      runtimeAuditReady: true,
      physicalEvidenceCurrent: true,
      authorizationReady: true,
      pitchSafetyReady: true,
      contract: "m3plus-rescope-four-zone-v2",
      runtimeContract: "m3plus-gold-free-runtime-v1",
    },
  },
  liveEvidenceBinding: {
    contract: currentAuthorityBinding.contract,
    sha256: currentAuthorityBinding.sha256,
  },
};
const greenCachedDecision = {
  schemaVersion: 2,
  ordinaryAuthorizationContract: "western-ordinary-dynamic-shadow-release-v1",
  scopeContract: "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v2",
  ok: true,
  readyForControlledPilotDecision: true,
  readyToStartControlledPilot: true,
  approvalRequired: true,
  approvalPresent: true,
  approvalDeferred: false,
  approvedTracks: ["ordinary", "m3plus"],
  runtimeFailClosed: true,
  blockingReasons: [],
  liveEvidenceBinding: {
    contract: currentAuthorityBinding.contract,
    sha256: currentAuthorityBinding.sha256,
  },
  approval: {
    pilotApproved: true,
    approvedBy: "fixture-owner",
    approvedAt: "2026-07-18T00:00:00.000Z",
    approvedTracks: ["ordinary", "m3plus"],
    confirmSeparateMonitoredPilot: true,
    confirmDefaultRuntimeFailClosed: true,
    scopeContract: "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v2",
  },
};
function authorityFor(releaseReview, controlledPilotDecision) {
  return summarizeCurrentControlledPilotAuthority({
    releaseReview,
    controlledPilotDecision,
    currentLiveEvidenceBinding: currentAuthorityBinding,
    currentLiveEvidenceReady: true,
  });
}
function authorityNextActions(authority) {
  return summarizeNextActions(
    {
      ordinaryDynamicShadow: {
        foundationReady: true,
        liveArtifactVerifierReady: true,
        r3AcceptanceReady: true,
        authorizationReady: true,
      },
      confidencePilot: {
        monitoredPilotAudit: {
          readyForMonitoredPilot: true,
          teacherReviewNeeded: false,
          defaultOrdinaryReadyAfter: false,
          blockingReasons: [],
        },
      },
    },
    {
      m3plusModeEvalReady: true,
      m3plusPitchSafetyReady: true,
      studentGateReady: true,
      monitoredPilotAudit: {
        readyForMonitoredPilot: true,
        teacherReviewNeeded: false,
        defaultM3PlusReadyAfter: false,
        blockingReasons: [],
      },
    },
    {
      m4OmrIndependentBenchmarkReady: true,
      m4OmrDraftQualityReady: true,
      m4OmrAutomaticAdoptionReady: true,
    },
    authority.releaseReview,
    authority.controlledPilotDecision,
    null,
    null,
    null,
    null,
  );
}
const greenCachedAuthority = authorityFor(greenCachedRelease, greenCachedDecision);
assert.equal(greenCachedAuthority.releaseReview.readyForControlledPilot, true);
assert.equal(greenCachedAuthority.controlledPilotDecision.readyToStartControlledPilot, true);
assert(
  authorityNextActions(greenCachedAuthority).some((action) => action.track === "Start monitored pilot"),
  "the contradictory-cache regression fixture must be capable of reaching the start route",
);
for (const [label, mutate, expectedBlocker] of [
  ["ordinary track red", (release) => { release.tracks.ordinary.readyForControlledPilot = false; }, "release-review-ordinary-track-not-ready"],
  ["m3plus track red", (release) => { release.tracks.m3plus.readyForControlledPilot = false; }, "release-review-m3plus-track-not-ready"],
  ["ordinary track contradicts binding", (release) => { release.tracks.ordinary.authorizationReady = false; }, "release-review-track-evidence-does-not-match-current-live-binding"],
  ["teacher status missing", (release) => { delete release.teacherReviewNeeded; }, "release-review-teacher-review-status-not-explicitly-clear"],
]) {
  const release = structuredClone(greenCachedRelease);
  mutate(release);
  const authority = authorityFor(release, structuredClone(greenCachedDecision));
  assert.equal(authority.releaseReview.readyForControlledPilot, false, `${label} must close cached release authority`);
  assert.equal(authority.controlledPilotDecision.readyToStartControlledPilot, false, `${label} must close cached start authority`);
  assert(authority.releaseReview.blockingReasons.includes(expectedBlocker), `${label} must expose ${expectedBlocker}`);
  assert(!authorityNextActions(authority).some((action) => action.track === "Start monitored pilot"));
}
for (const [label, mutate] of [
  ["superseded scope", (decision) => { decision.scopeContract = "historical-first-measure-v1"; }],
  ["extra approved track", (decision) => {
    decision.approvedTracks.push("m4");
    decision.approval.approvedTracks.push("m4");
  }],
  ["missing safety confirmation", (decision) => { decision.approval.confirmDefaultRuntimeFailClosed = false; }],
  ["nonempty decision blockers", (decision) => { decision.blockingReasons = ["forged-current-cache-blocker"]; }],
]) {
  const decision = structuredClone(greenCachedDecision);
  mutate(decision);
  const authority = authorityFor(structuredClone(greenCachedRelease), decision);
  assert.equal(authority.controlledPilotDecision.readyToStartControlledPilot, false, `${label} must close cached start authority`);
  assert(!authorityNextActions(authority).some((action) => action.track === "Start monitored pilot"));
}
const shadowFreshBlindReady = controlled.ordinaryDynamicShadow?.freshBlindEvidence?.ready === true;
const expectedFirstOrdinaryTrack = !controlled.ordinaryDynamicShadow?.liveArtifactVerifierReady
  ? "Ordinary dynamic shadow r3 evidence verifier"
  : !shadowAcceptanceReady
    ? "Ordinary dynamic shadow r3 acceptance"
    : !shadowFreshBlindReady
      ? "Ordinary dynamic shadow fresh-blind evidence"
      : !shadowAuthorizationReady
        ? "Ordinary dynamic shadow authorization"
        : null;
if (expectedFirstOrdinaryTrack) {
  assert.equal(
    status.nextActions[0]?.track,
    expectedFirstOrdinaryTrack,
    "the first next action must follow the ordinary evidence-then-authorization progression",
  );
} else {
  // The entire ordinary chain (verifier through authorization) is clear;
  // the waterfall must move on to name a real downstream bottleneck rather
  // than staying pinned to an ordinary-track action.
  assert(
    !String(status.nextActions[0]?.track || "").startsWith("Ordinary dynamic shadow"),
    "a fully cleared ordinary chain must not still head the next-action list",
  );
}
if (expectedFirstOrdinaryTrack) {
  assert.equal(
    status.nextActions[0]?.artifact,
    "data/experiments/western-strings-m3/ordinary-dynamic-shadow-r3-acceptance/report.json",
  );
} else {
  assert(String(status.nextActions[0]?.artifact || "").length > 0, "a downstream next action must still name a concrete artifact");
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
assert.equal(m4.m4ZeusChallengerEvaluated, true, "M4 status must expose the frozen Zeus camera-model challenger");
assert.equal(m4.m4ZeusChallengerRetained, false, "Zeus must not enter the runtime pool below the frozen real-photo gate");
assert.equal(m4.zeusChallenger?.summary?.pitchPrecision, 0.080473, "M4 status must expose Zeus frozen pitch precision");
assert.equal(m4.zeusChallenger?.summary?.pitchRecall, 0.091374, "M4 status must expose Zeus frozen pitch recall");
assert.equal(m4.zeusChallenger?.summary?.onsetQuarterAccuracy, 0.001278, "M4 status must expose Zeus frozen onset accuracy");
assert.equal(m4.zeusChallenger?.summary?.measureAccuracy, 0.054313, "M4 status must expose Zeus frozen measure accuracy");
assert.equal(m4.zeusChallenger?.summary?.strictPagePassCount, 0, "Zeus must remain at zero strict real-photo passes");
assert.equal(m4.zeusChallenger?.summary?.segmentationReadyPageCount, 4, "Zeus status must distinguish the four ready page segmentations from the aggregate all-pages flag");
assert.equal(m4.zeusChallenger?.interpretation?.generalCameraOmrCapabilityClaimValid, false, "the mismatched GrandStaff run must not be cited as a general camera-OMR capability ceiling");
assert.equal(m4.zeusChallenger?.interpretation?.segmentationFailureIsPrimaryCause, false, "the Zeus failure must not be misattributed to staff segmentation");
assert.equal(m4.zeusChallenger?.studentGateReady, false, "Zeus research evidence must never open the student gate");
assert(
  m4.automaticAdoptionBlockingReasons.includes("m4-zeus-camera-challenger-below-complete-score-floor"),
  "the rejected Zeus challenger must remain visible as an M4 automatic-adoption blocker",
);
if (m4.m4OemerBenchmarkComplete) {
  assert.equal(m4.m4OemerAutomaticAdoptionReady, false, "Oemer source-gold comparison must not open automatic adoption");
  assert.equal(m4.oemerBenchmark?.studentGateReady, false, "Oemer eval-only comparison must never open the student gate");
  assert.equal(m4.oemerBenchmark?.comparison?.oemer?.rows, 5, "Oemer comparison must expose all five frozen source-gold rows");
  assert.equal(m4.oemerBenchmark?.comparison?.oemer?.usableRows, 5, "Oemer viewer-trim fallback must recover all five frozen rows");
  assert.equal(m4.oemerBenchmark?.comparison?.oemer?.engineFailureRows, 0, "Oemer benchmark must expose no remaining engine failure");
  assert.equal(m4.oemerBenchmark?.coordinateAdapter?.readyRows, 5, "Oemer coordinate sidecars must cover all frozen rows");
  assert.equal(m4.oemerBenchmark?.comparison?.oemer?.strictPassRows, 0, "Oemer must not be promoted above its measured strict result");
}
assert.equal(m4.m4OemerDewarpAttributionComplete, true, "Oemer dewarp attribution must cover all five frozen pages");
assert.equal(m4.m4OemerDewarpPrimaryCauseSupported, false, "Oemer dewarp must not be promoted as the primary cause without evidence");
assert.equal(m4.oemerDewarpAttribution?.studentGateReady, false, "Oemer dewarp diagnostics must remain outside the student gate");
assert.equal(m4.oemerDewarpAttribution?.automaticAdoptionAuthorized, false, "Oemer dewarp diagnostics must not authorize adoption");
if (m4.m4EngineConsensusPilotSafeSubsetFound) {
  const consensus = m4.engineConsensus?.summaries?.allAvailablePitchLocalOnset25;
  const coordinateConsensus = m4.engineConsensus?.summaries?.coordinateReadyAllAvailablePitchLocalOnset25;
  assert.equal(consensus?.selectedNotes, 213, "M4 consensus must expose the frozen strict three-engine subset");
  assert.equal(consensus?.wrongNotes, 0, "M4 consensus subset must retain zero measured wrong notes");
  assert.equal(coordinateConsensus?.selectedNotes, 213, "every frozen consensus note must carry a review locator");
  assert.equal(m4.engineConsensus?.coordinatePolicy?.reviewLocatorCoverage, 1, "M4 review-locator coverage must be complete for the selected subset");
  assert.equal(m4.engineConsensus?.runtimeReady, false, "M4 consensus must remain eval-only below per-piece coverage floors");
}
if (!m4.engineConsensusToleranceSweep?.missing) {
  assert.equal(
    m4.engineConsensusToleranceSweep?.configurationCount,
    18,
    "M4 tolerance audit must cover both engine policies across nine tolerances",
  );
  assert.equal(
    m4.engineConsensusToleranceSweep?.expansionCandidateFound,
    false,
    "no uniform onset-consensus tolerance may be promoted from the five-page audit",
  );
  assert.equal(
    m4.engineConsensusToleranceSweep?.studentGateReady,
    false,
    "M4 tolerance exploration must remain eval-only",
  );
}
if (m4.m4HomrBenchmarkComplete) {
  assert.equal(m4.m4HomrAutomaticAdoptionReady, false, "HOMR comparison must not open automatic adoption");
  assert.equal(m4.homrBenchmark?.studentGateReady, false, "HOMR eval-only comparison must never open the student gate");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.rows, 5, "HOMR comparison must expose all frozen rows");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.usableRows, 5, "HOMR comparison must expose all usable outputs");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.pitchOnlyStrictPassRows, 2, "HOMR must expose pitch-only false positives");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.strictPassRows, 0, "HOMR must reject rhythmically invalid MusicXML");
  assert.equal(m4.homrBenchmark?.source, "docs/evidence/western-strings-homr-sourcegold-20260717.json", "status must use the tracked fresh evidence manifest");
  assert.equal(m4.homrBenchmark?.runtime?.onnxruntime, "1.27.0", "status must expose the fresh ORT runtime");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.pitchPrecision, 0.883324, "status must expose fresh HOMR precision");
  assert.equal(m4.homrBenchmark?.comparison?.homr?.pitchRecall, 0.957827, "status must expose fresh HOMR recall");
}
assert.equal(m4.m4HomrMainlineExecutable, false, "formal analyzer mainline must not execute HOMR");
const homrReviewRecord = JSON.parse(
  await fs.readFile("config/third-party/homr-0.7.0-review.json", "utf8"),
);
const homrReviewApproved = homrReviewRecord?.decision?.status === "approved-with-conditions";
if (homrReviewApproved) {
  assert.notEqual(String(homrReviewRecord.decision?.reviewedBy || "").trim(), "", "approved review must carry a named reviewer");
  assert.deepEqual(homrReviewRecord.decision?.approvedScopes, ["controlled-offline-review-only"], "approval scope must stay controlled offline review only");
  assert.equal(homrReviewRecord.decision?.studentFacingNetworkUseApproved, false, "approval must never open student-facing network use");
  assert.equal(homrReviewRecord.decision?.redistributionApproved, false, "approval must never open redistribution");
}
const homrReviewEvidenceCurrent = m4.homrGovernance?.preflightBindingCurrent === true
  && m4.homrGovernance?.lastPreflight?.governanceReady === true;
assert.equal(
  m4.m4HomrLicenseReviewReady,
  homrReviewApproved && homrReviewEvidenceCurrent,
  "license readiness must require both the named decision and its current preflight binding",
);
if (!homrReviewApproved) {
  assert.equal(m4.m4HomrProductionPoolReady, false, "pending governance must keep the deployment pool closed");
}
assert(m4.m4HomrProductionPoolReady === false || homrReviewApproved, "deployment pool must never be ready without an approved named review");
assert.equal(m4.homrGovernance?.studentFacing, false, "governance must not open the student runtime");
if (m4.m4SameEditionBenchmarkEvaluated) {
  assert.equal(m4.m4SameEditionHomrStrictPositive, true, "same-edition human gold should expose the observed HOMR strict pass");
  assert.equal(m4.m4SameEditionAutomaticAdoptionReady, false, "one same-edition page must not authorize automatic adoption");
  assert.equal(m4.sameEditionBenchmark?.studentGateReady, false, "same-edition comparison must remain eval-only");
  assert.equal(m4.sameEditionBenchmark?.candidate?.observedIndependentRows, 1, "same-edition comparison must report its actual one-page sample size");
  assert.equal(m4.sameEditionBenchmark?.candidate?.minimumIndependentRows, 5, "same-edition adoption gate must require at least five independent pages");
  assert.equal(m4.sameEditionBenchmark?.engines?.homr?.strictPassRows, 1, "HOMR strict-positive evidence must remain visible without being promoted");
}
if (m4.m4Op45ExternalPitchReferenceEvaluated) {
  assert.equal(m4.m4Op45ExternalPitchExactRunObserved, true, "Op.45 should expose the independent exact pitch-order run");
  assert.equal(m4.op45PublicReference?.pitchOrderAlignment?.exactMatches, 150, "Op.45 exact run length must remain reproducible");
  assert.equal(m4.op45PublicReference?.pitchOrderAlignment?.substitutions, 0, "Op.45 exact run must not hide pitch substitutions");
  assert.equal(m4.op45PublicReference?.gate?.sameEditionHumanGold, false, "public performance MIDI must not be promoted to same-edition human gold");
  assert.equal(m4.op45PublicReference?.gate?.rhythmEvaluated, false, "performance MIDI probe must not claim notated-rhythm accuracy");
  assert.equal(m4.op45PublicReference?.gate?.automaticAdoptionReady, false, "external pitch corroboration must not open automatic OMR adoption");
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
if (expectedFirstOrdinaryTrack) {
  assert.equal(
    status.nextActions[0]?.track,
    expectedFirstOrdinaryTrack,
    "M4 must not displace the prerequisite ordinary dynamic-shadow evidence task",
  );
} else {
  assert(
    !String(status.nextActions[0]?.track || "").toLowerCase().includes("m4"),
    "M4 must not displace whichever real audio-track bottleneck is currently first",
  );
}

const m4ChecklistHtml = await fs.readFile("data/experiments/western-strings-m4/independent-gold-todo.html", "utf8");
const m4ChecklistMd = await fs.readFile("data/experiments/western-strings-m4/independent-gold-todo.md", "utf8");
const reviewPolicy = await fs.readFile("docs/western-strings-review-policy.md", "utf8");
const projectPlan = await fs.readFile("docs/western-strings-project-plan.md", "utf8");
const migrationPlan = await fs.readFile("docs/western-strings-migration-plan.md", "utf8");
const releaseReviewSource = await fs.readFile("scripts/run-western-strings-release-review.mjs", "utf8");
const m4PreflightSource = await fs.readFile("scripts/run-western-strings-m4-preflight.mjs", "utf8");
const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
const handoff = renderHandoff(status);
assert(
  packageJson.scripts?.["western:m4-preflight"],
  "package.json must expose the aggregate M4 machine self-test command",
);
assert(
  packageJson.scripts?.["western:controlled-batch-candidate-audit"]?.includes("--require-feature-review"),
  "the public candidate-audit command must fail closed when the latest run has no ordinary feature-review artifact",
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
assert(packageJson.scripts?.["western:homr-evidence-check"], "package.json must expose the tracked fresh-evidence check");
assert(packageJson.scripts?.["western:photo-score-deployment-preflight"], "package.json must expose the photo-score deployment preflight");
assert(packageJson.scripts?.["test:western-photo-score-deployment-preflight"], "package.json must expose deployment-preflight tests");
assert(
  m4PreflightSource.indexOf('"western:photo-score-deployment-preflight"')
    < m4PreflightSource.indexOf('"western:project-status"'),
  "aggregate M4 preflight must refresh the deployment verdict before project status",
);
assert(packageJson.scripts?.["western:m4-op45-public-reference"], "package.json must expose the Op.45 external pitch-reference probe");
assert(packageJson.scripts?.["test:western-m4-op45-public-reference"], "package.json must expose the Op.45 external pitch-reference regression test");
assert(packageJson.scripts?.["western:m4-op45-promote-gold"], "package.json must expose fail-closed Op.45 gold promotion");
assert(packageJson.scripts?.["test:western-m4-op45-gold-promotion"], "package.json must expose Op.45 gold-promotion regression tests");
assert(packageJson.scripts?.["western:m4-op45-finalize-benchmark"], "package.json must expose one-command Op.45 benchmark finalization");
assert(packageJson.scripts?.["test:western-m4-op45-finalize-benchmark"], "package.json must expose Op.45 benchmark-finalization regression tests");
assert(packageJson.scripts?.["western:m4-clarity-benchmark"], "package.json must expose the eval-only Clarity benchmark");
assert(packageJson.scripts?.["test:western-m4-clarity-benchmark"], "package.json must expose Clarity benchmark regression tests");
assert(packageJson.scripts?.["western:m3plus-supplemental-scores"], "package.json must expose the M3+ supplemental score generator");
assert(packageJson.scripts?.["western:m3plus-supplemental-status"], "package.json must expose the M3+ supplemental intake status command");
assert(packageJson.scripts?.["western:m3plus-supplemental-eval"], "package.json must expose the M3+ supplemental machine evaluation command");
assert(packageJson.scripts?.["test:western-m3plus-supplemental-status"], "package.json must expose M3+ supplemental fail-closed tests");
assert(packageJson.scripts?.["test:western-m3plus-supplemental-eval"], "package.json must expose M3+ supplemental machine-eval tests");
assert(packageJson.scripts?.["western:m3plus-protocol-order-diagnostic"], "package.json must expose the M3+ protocol-order diagnostic");
assert(packageJson.scripts?.["test:western-m3plus-protocol-order-diagnostic"], "package.json must expose protocol-order regression tests");
assert(packageJson.scripts?.["western:m3plus-feature-separability"], "package.json must expose held-out M3+ feature audit");
assert(packageJson.scripts?.["test:western-m3plus-feature-separability"], "package.json must expose M3+ feature-audit regression tests");
assert(packageJson.scripts?.["western:m3plus-rescope-gate"], "package.json must expose the authoritative M3+ pitch-safety rescope gate");
assert(packageJson.scripts?.["test:western-m3plus-rescope-gate"], "package.json must expose M3+ rescope-gate regression tests");
assert(packageJson.scripts?.["test:western-m3plus-runtime-policy"], "package.json must expose the gold-free M3+ runtime-policy tests");
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
for (const requiredDynamicStep of [
  '"western:ordinary-dynamic-shadow-runtime-preflight"',
  '"test:western-ordinary-audio-runtime"',
  '"test:western-dynamic-shadow-policy"',
  '"test:western-offline-feature-audio"',
  '"test:western-alignment-preview"',
]) {
  assert(releaseReviewSource.includes(requiredDynamicStep), `release review missing ${requiredDynamicStep}`);
}
for (const requiredM3PlusStep of [
  '"test:western-m3plus-rescope-gate"',
  '"test:western-m3plus-runtime-policy"',
  '"western:m3plus-monitored-pilot-audit"',
]) {
  assert(releaseReviewSource.includes(requiredM3PlusStep), `release review missing ${requiredM3PlusStep}`);
}
assert(
  releaseReviewSource.indexOf('"test:western-m3plus-rescope-gate"')
    < releaseReviewSource.indexOf('"test:western-m3plus-runtime-policy"')
    && releaseReviewSource.indexOf('"test:western-m3plus-runtime-policy"')
      < releaseReviewSource.indexOf('"western:m3plus-monitored-pilot-audit"'),
  "release review must test the stable v2 report contract before auditing its physical runtime binding",
);
assert(
  !releaseReviewSource.includes('"western:m3plus-rescope-gate"'),
  "release review must not regenerate the rescope report and invalidate the latest batch SHA binding",
);
assert(
  !releaseReviewSource.includes('"western:ordinary-monitored-pilot-audit"'),
  "superseded RF monitored-pilot audit must not remain an authorization step",
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
  if (m3plus.studentGateReady) {
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
  } else if (m3plus.offlineEvidenceReady === true) {
    assert(
      handoff.includes("M3+ pitch safety rescope")
        && handoff.includes("Keep the student runtime disabled"),
      "handoff must keep the runtime boundary explicit while green M3+ evidence awaits authorization",
    );
  } else {
    assert(
      handoff.includes("M3+ pitch safety rescope")
        && handoff.includes("six declared-only protected units")
        && handoff.includes("independent per-unit intonation gold"),
      "handoff must report the executed-evidence and independent-gold gaps while M3+ stays fail-closed",
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
    projectPlan.includes("后续 P1.1 也已被 dynamic-shadow supersede"),
    "project plan must retain the obsolete confidence-only failure while making clear that P1.1 no longer authorizes release",
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
assert(
  fullGate.failures
    .find((failure) => failure.track === "M2/M3 ordinary upload candidate gate")
    ?.reason?.includes("ordinary-dynamic-shadow-student-gate-closed"),
  "a technically green ordinary track must still name the closed student gate",
);
assert.equal(
  fullGate.failures.find((failure) => failure.track === "M2/M3 ordinary upload candidate gate")?.artifact,
  "data/experiments/western-strings-m3/ordinary-dynamic-shadow-r3-acceptance/report.json",
  "ordinary gate failure should point to the current ordinary-gate evidence artifact",
);
const m3plusFailure = fullGate.failures.find((failure) => failure.track === "M3+ pitch safety rescope");
assert(m3plusFailure, "M3+ must fail the default-release gate while offline evidence and authorization remain closed");
assert.equal(
  m3plusFailure.artifact,
  m3plus.monitoredPilotAudit.source,
  "M3+ default-release failure should point to the hardened physical-evidence audit",
);
const expectedM3PlusReasons = [
  ...(m3plus.offlineEvidenceReady === true
    ? []
    : [
      "m3plus-rescope-score-marked-declared-only-not-evaluated",
      "m3plus-rescope-center-intonation-gold-join-missing",
      "m3plus-offline-evidence-not-ready",
    ]),
  // authorizationReady is driven by the owner's standing approval, not by
  // evidence alone; only require the closed reason when it is not granted.
  ...(m3plus.authorizationReady === true ? [] : ["m3plus-authorization-closed"]),
  "m3plus-student-gate-closed",
];
for (const reason of expectedM3PlusReasons) {
  assert(m3plusFailure.reason.includes(reason), `M3+ project gate missing ${reason}`);
}
if (m3plus.authorizationReady === true) {
  assert(
    !m3plusFailure.reason.includes("m3plus-authorization-closed"),
    "a granted M3+ authorization must clear the authorization-closed project-gate reason",
  );
}
if (m3plus.offlineEvidenceReady === true) {
  assert(
    !m3plusFailure.reason.some((reason) => String(reason).startsWith("m3plus-rescope-")),
    "green M3+ evidence must clear the rescope reasons from the project gate",
  );
}
const forgedOfflineOnlyM3PlusGate = evaluateProjectGate({
  tracks: {
    m3plusPitchModes: {
      m3plusPitchSafetyReady: true,
      offlineEvidenceReady: true,
      reviewOnlyRuntimeWired: false,
      runtimeFoundationReady: false,
      runtimeAuditReady: false,
      authorizationReady: false,
      studentGateReady: false,
      blockingReasons: [],
    },
  },
}, new Set(["m3plus"]));
assert.equal(forgedOfflineOnlyM3PlusGate.projectReleaseReady, false, "an old offline aggregate must not bypass runtime and release gates");
assert(forgedOfflineOnlyM3PlusGate.failures[0].reason.includes("m3plus-runtime-audit-not-ready"));
assert(forgedOfflineOnlyM3PlusGate.failures[0].reason.includes("m3plus-authorization-closed"));
assert(forgedOfflineOnlyM3PlusGate.failures[0].reason.includes("m3plus-student-gate-closed"));
const m4Failure = fullGate.failures.find((failure) => failure.track === (
  m4.m4GateSplitDecisionReady === true
    ? "M4a supported-edition registration"
    : "M4 OMR automatic adoption"
));
if (m4.m4GateSplitDecisionReady === true) {
  if (m4.m4aSupportedEditionRegistrationReady === true) {
    assert.equal(m4Failure, undefined, "a completed M4a contract must clear the required M4 track");
    assert.equal(m4.m4aRealPhotoAcceptanceReady, true);
  } else {
    assert(m4Failure, "the required M4a track must remain fail-closed until its active contract is ready");
    if (
      m4.m4aSupportedEditionRegistryReady === true
      && m4.m4aRegistrationRuntimeReady === true
      && m4.m4aEngineeringAcceptanceReady === true
    ) {
      assert(m4.m4aRealPhotoAcceptanceOperationalReady === true);
      assert(m4Failure.reason.some((reason) => String(reason).startsWith("m4a-")));
    } else if (m4.m4aSupportedEditionRegistryReady === true) {
      assert(m4Failure.reason.some((reason) => String(reason).includes("registration")));
    } else {
      assert(
        m4Failure.reason.some((reason) => String(reason).includes("registry")),
        "an invalid M4a supported-edition registry must remain fail-closed",
      );
    }
    assert.equal(m4Failure.artifact, m4.artifacts.m4aRegistrationAuditJson);
  }
  assert.equal(
    fullGate.failures.some((failure) => failure.track === "M4 OMR automatic adoption"),
    false,
    "M4b open-world OMR must remain separate from the signed M4a project binding",
  );
} else {
  assert(m4Failure, "the required M4 track must remain fail-closed until its active contract is ready");
  assert(
    m4Failure.reason.includes("m4-same-edition-homr-independent-page-count-below-floor"),
    "unsigned split must preserve the same-edition page-count blocker",
  );
  assert.equal(m4Failure.artifact, m4.artifacts.sameEditionBenchmarkJson);
}
const m4DeploymentFailure = fullGate.failures.find(
  (failure) => failure.track === "M4 photo-score deployment/governance",
);
if (homrReviewApproved && m4.m4HomrProductionPoolReady === true) {
  assert.equal(
    m4DeploymentFailure,
    undefined,
    "approved governance with a ready deployment must clear the deployment gate failure",
  );
} else {
  assert(m4DeploymentFailure, "pending HOMR governance must be an independent project-gate failure");
  assert.equal(
    m4DeploymentFailure.artifact,
    m4.artifacts.photoScoreDeploymentPreflightJson,
    "deployment failure should point to the machine-readable preflight",
  );
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "project-status-tracks-present",
    "public-model-validation-evidence-covered",
    "student-runtime-fail-closed",
    "confidence-pilot-validation-state-covered",
    "historical-first-measure-intake-is-non-authoritative",
    "release-review-live-evidence-binding-is-current",
    "m3plus-live-physical-drift-closes-readiness",
    "m3plus-v2-offline-runtime-release-gates-covered",
    "m4-research-claim-separated-from-automatic-adoption-gate",
    "m4-checklist-human-readable",
    "handbook-current-status-does-not-reassign-completed-review",
    "project-gate-required-tracks-block-release",
  ],
}, null, 2));
