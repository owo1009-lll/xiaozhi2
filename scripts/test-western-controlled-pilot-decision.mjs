import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { writeApprovalTemplate } from "./create-western-controlled-pilot-approval-template.mjs";
import { buildControlledPilotDecision } from "./create-western-controlled-pilot-decision.mjs";
import { renderHandoff } from "./create-western-strings-next-action-handoff.mjs";
import { writeControlledPilotApprovalDecision } from "./record-western-controlled-pilot-decision.mjs";
import { buildControlledPilotStartPreflight } from "./run-western-controlled-pilot-start-preflight.mjs";
import {
  buildControlledPilotLiveEvidenceBinding,
  buildProjectStatus,
  controlledPilotLiveEvidenceReady,
} from "./status-western-strings-project.mjs";

const TEST_DIR = path.join("data", "experiments", "western-strings-controlled-pilot-test");
const TEMPLATE_PATH = path.join(TEST_DIR, "approval.template.json");
const DEFERRED_APPROVAL_PATH = path.join(TEST_DIR, "approval.deferred.json");
const VALID_APPROVAL_PATH = path.join(TEST_DIR, "approval.valid.json");
const RECORDED_DEFERRED_APPROVAL_PATH = path.join(TEST_DIR, "approval.recorded-deferred.json");
const RECORDED_VALID_APPROVAL_PATH = path.join(TEST_DIR, "approval.recorded-valid.json");
const CURRENT_RELEASE_PATH = path.join(TEST_DIR, "release.current.json");
const ORDINARY_TRACK_NOT_READY_RELEASE_PATH = path.join(TEST_DIR, "release.ordinary-track-not-ready.json");
const M3PLUS_TRACK_NOT_READY_RELEASE_PATH = path.join(TEST_DIR, "release.m3plus-track-not-ready.json");
const MISSING_TEACHER_STATUS_RELEASE_PATH = path.join(TEST_DIR, "release.missing-teacher-status.json");
const MISSING_ORDINARY_IDENTITY_RELEASE_PATH = path.join(TEST_DIR, "release.missing-ordinary-identity.json");
const INCOMPLETE_PHYSICAL_RELEASE_PATH = path.join(TEST_DIR, "release.incomplete-physical.json");
const FORGED_RELEASE_PATH = path.join(TEST_DIR, "release.forged-green.json");
const LEGACY_RELEASE_PATH = path.join(TEST_DIR, "release.legacy.json");
const DEFAULT_APPROVAL_PATH = path.join("data", "experiments", "western-strings-controlled-pilot-approval.json");
const DEFAULT_DECISION_PATH = path.join("data", "experiments", "western-strings-controlled-pilot-decision.json");
const SCOPE_CONTRACT = "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v2";
const ORDINARY_EXECUTOR_CONTRACT = "western-ordinary-dynamic-shadow-pilot-executor-v1";
const M3PLUS_EXECUTOR_CONTRACT = "western-m3plus-pitch-safety-pilot-executor-v1";
const APPROVED_TRACKS = ["ordinary", "m3plus"];

const PASSING_PROJECT_STATUS = {
  runtimeStudentGate: {
    policy: "fail-closed",
    ordinaryUploadAutoFeedbackReady: false,
    m3plusAutoFeedbackReady: false,
    m4OmrAutoScoreReady: false,
  },
  tracks: {
    controlledCandidate: {
      ordinaryDynamicShadow: {
        contractVersion: "western-ordinary-dynamic-shadow-candidate-v1",
        policyVersion: "western-ordinary-dynamic-shadow-policy-v1",
        gateVersion: "western-ordinary-dynamic-shadow-gate-v1-review-only",
        timingMode: "basic-pitch-dtw",
        foundationReady: true,
        liveArtifactVerifierReady: true,
        r3AcceptanceReady: true,
        authorizationReady: true,
        energyVetoIncluded: true,
        blockingReasons: [],
        runtime: {
          runtimeId: "western-ordinary-dynamic-shadow-audio-py311",
          configSha256: "6".repeat(64),
          configSemanticSha256: "7".repeat(64),
          requirementsLockSha256: "8".repeat(64),
          modelTreeSha256: "9".repeat(64),
        },
        acceptanceEvidence: {
          artifactSha256: "a".repeat(64),
          evidenceDigestSha256: "b".repeat(64),
        },
      },
    },
    m3plusPitchModes: {
      offlineEvidenceReady: true,
      reviewOnlyRuntimeWired: true,
      runtimeFoundationReady: true,
      runtimeAuditReady: true,
      physicalEvidenceCurrent: true,
      authorizationReady: true,
      m3plusPitchSafetyReady: true,
      studentGateReady: false,
      monitoredPilotAudit: {
        schemaVersion: 2,
        contract: "m3plus-rescope-four-zone-v2",
        runtimeContract: "m3plus-gold-free-runtime-v1",
        runtimePolicyVersion: "m3plus-gold-free-pitch-safety-policy-v1",
        physicalEvidenceCurrent: true,
        readyForMonitoredPilot: true,
        teacherReviewNeeded: false,
        defaultM3PlusReadyAfter: false,
        blockingReasons: [],
        runtimeEvidence: {
          batchRunId: "batch-passing",
          candidateRowsPath: "data/test/candidates.json",
          candidateRowsSha256: "0".repeat(64),
          candidateRowCount: 3,
          runtime: {
            policySemanticSha256: "1".repeat(64),
            policyArtifactSha256: "2".repeat(64),
            analyzerArtifactSha256: "5".repeat(64),
            analyzerArtifactSemanticSha256: "5".repeat(64),
            rescopeReportSha256: "3".repeat(64),
            scoreSafetyIdentitySha256: "4".repeat(64),
          },
        },
      },
    },
  },
};
const PASSING_LIVE_BINDING = buildControlledPilotLiveEvidenceBinding(PASSING_PROJECT_STATUS);
assert.equal(
  controlledPilotLiveEvidenceReady(PASSING_LIVE_BINDING),
  true,
  "passing fixture must include the complete ordinary runtime and acceptance identity",
);
for (const [section, field] of [
  ["runtime", "runtimeId"],
  ["runtime", "configSha256"],
  ["runtime", "configSemanticSha256"],
  ["runtime", "requirementsLockSha256"],
  ["runtime", "modelTreeSha256"],
  ["acceptanceEvidence", "artifactSha256"],
  ["acceptanceEvidence", "evidenceDigestSha256"],
]) {
  const missingIdentityStatus = structuredClone(PASSING_PROJECT_STATUS);
  delete missingIdentityStatus.tracks.controlledCandidate.ordinaryDynamicShadow[section][field];
  const missingIdentityBinding = buildControlledPilotLiveEvidenceBinding(missingIdentityStatus);
  assert.equal(
    controlledPilotLiveEvidenceReady(missingIdentityBinding),
    false,
    `missing ordinary ${section}.${field} must fail closed`,
  );
  assert.notEqual(
    missingIdentityBinding.sha256,
    PASSING_LIVE_BINDING.sha256,
    `missing ordinary ${section}.${field} must change the live binding`,
  );
}
const MISSING_ORDINARY_IDENTITY_PROJECT_STATUS = structuredClone(PASSING_PROJECT_STATUS);
MISSING_ORDINARY_IDENTITY_PROJECT_STATUS.tracks.controlledCandidate
  .ordinaryDynamicShadow.runtime.configSha256 = null;
const MISSING_ORDINARY_IDENTITY_LIVE_BINDING = buildControlledPilotLiveEvidenceBinding(
  MISSING_ORDINARY_IDENTITY_PROJECT_STATUS,
);
const DRIFTED_ORDINARY_IDENTITY_PROJECT_STATUS = structuredClone(PASSING_PROJECT_STATUS);
DRIFTED_ORDINARY_IDENTITY_PROJECT_STATUS.tracks.controlledCandidate
  .ordinaryDynamicShadow.runtime.configSha256 = "c".repeat(64);
const DRIFTED_ORDINARY_IDENTITY_LIVE_BINDING = buildControlledPilotLiveEvidenceBinding(
  DRIFTED_ORDINARY_IDENTITY_PROJECT_STATUS,
);
assert.equal(controlledPilotLiveEvidenceReady(DRIFTED_ORDINARY_IDENTITY_LIVE_BINDING), true);
assert.notEqual(DRIFTED_ORDINARY_IDENTITY_LIVE_BINDING.sha256, PASSING_LIVE_BINDING.sha256);
const INCOMPLETE_PHYSICAL_PROJECT_STATUS = structuredClone(PASSING_PROJECT_STATUS);
INCOMPLETE_PHYSICAL_PROJECT_STATUS.tracks.m3plusPitchModes.monitoredPilotAudit
  .runtimeEvidence.runtime.analyzerArtifactSha256 = null;
const INCOMPLETE_PHYSICAL_LIVE_BINDING = buildControlledPilotLiveEvidenceBinding(
  INCOMPLETE_PHYSICAL_PROJECT_STATUS,
);

function buildPassingDecision(args = {}) {
  return buildControlledPilotDecision({ ...args, projectStatus: PASSING_PROJECT_STATUS });
}

function buildPassingPreflight(args = {}) {
  return buildControlledPilotStartPreflight({ ...args, projectStatus: PASSING_PROJECT_STATUS });
}

async function readTextOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreText(filePath, text) {
  if (text == null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

await fs.mkdir(TEST_DIR, { recursive: true });
await fs.writeFile(CURRENT_RELEASE_PATH, `${JSON.stringify({
  schemaVersion: 2,
  ordinaryAuthorizationContract: "western-ordinary-dynamic-shadow-release-v1",
  ok: true,
  commandChecksPassed: true,
  requiredEvidenceComplete: true,
  machineChecksComplete: true,
  readyForControlledPilot: true,
  teacherReviewNeeded: false,
  runtimeFailClosed: true,
  liveEvidenceBinding: PASSING_LIVE_BINDING,
  tracks: {
    ordinary: {
      readyForControlledPilot: true,
      foundationReady: true,
      liveArtifactVerifierReady: true,
      r3AcceptanceReady: true,
      authorizationReady: true,
      energyVetoIncluded: true,
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
}, null, 2)}\n`, "utf8");
const missingOrdinaryIdentityRelease = JSON.parse(await fs.readFile(CURRENT_RELEASE_PATH, "utf8"));
missingOrdinaryIdentityRelease.liveEvidenceBinding = MISSING_ORDINARY_IDENTITY_LIVE_BINDING;
await fs.writeFile(
  MISSING_ORDINARY_IDENTITY_RELEASE_PATH,
  `${JSON.stringify(missingOrdinaryIdentityRelease, null, 2)}\n`,
  "utf8",
);
const ordinaryTrackNotReadyRelease = JSON.parse(await fs.readFile(CURRENT_RELEASE_PATH, "utf8"));
ordinaryTrackNotReadyRelease.tracks.ordinary.readyForControlledPilot = false;
await fs.writeFile(
  ORDINARY_TRACK_NOT_READY_RELEASE_PATH,
  `${JSON.stringify(ordinaryTrackNotReadyRelease, null, 2)}\n`,
  "utf8",
);
const m3plusTrackNotReadyRelease = JSON.parse(await fs.readFile(CURRENT_RELEASE_PATH, "utf8"));
m3plusTrackNotReadyRelease.tracks.m3plus.readyForControlledPilot = false;
await fs.writeFile(
  M3PLUS_TRACK_NOT_READY_RELEASE_PATH,
  `${JSON.stringify(m3plusTrackNotReadyRelease, null, 2)}\n`,
  "utf8",
);
const missingTeacherStatusRelease = JSON.parse(await fs.readFile(CURRENT_RELEASE_PATH, "utf8"));
delete missingTeacherStatusRelease.teacherReviewNeeded;
await fs.writeFile(
  MISSING_TEACHER_STATUS_RELEASE_PATH,
  `${JSON.stringify(missingTeacherStatusRelease, null, 2)}\n`,
  "utf8",
);
await fs.writeFile(INCOMPLETE_PHYSICAL_RELEASE_PATH, `${JSON.stringify({
  schemaVersion: 2,
  ordinaryAuthorizationContract: "western-ordinary-dynamic-shadow-release-v1",
  ok: true,
  commandChecksPassed: true,
  requiredEvidenceComplete: true,
  machineChecksComplete: true,
  readyForControlledPilot: true,
  teacherReviewNeeded: false,
  runtimeFailClosed: true,
  liveEvidenceBinding: INCOMPLETE_PHYSICAL_LIVE_BINDING,
  tracks: {
    ordinary: {
      readyForControlledPilot: true,
      foundationReady: true,
      liveArtifactVerifierReady: true,
      r3AcceptanceReady: true,
      authorizationReady: true,
      energyVetoIncluded: true,
    },
    m3plus: {
      readyForControlledPilot: true,
      offlineEvidenceReady: true,
      reviewOnlyRuntimeWired: true,
      runtimeFoundationReady: true,
      runtimeAuditReady: true,
      physicalEvidenceCurrent: false,
      authorizationReady: true,
      pitchSafetyReady: true,
      contract: "m3plus-rescope-four-zone-v2",
      runtimeContract: "m3plus-gold-free-runtime-v1",
    },
  },
}, null, 2)}\n`, "utf8");
await fs.writeFile(FORGED_RELEASE_PATH, `${JSON.stringify({
  schemaVersion: 2,
  ordinaryAuthorizationContract: "western-ordinary-dynamic-shadow-release-v1",
  readyForControlledPilot: true,
  teacherReviewNeeded: false,
  runtimeFailClosed: true,
  tracks: { ordinary: { authorizationReady: true } },
}, null, 2)}\n`, "utf8");
await fs.writeFile(LEGACY_RELEASE_PATH, `${JSON.stringify({
  schemaVersion: 1,
  readyForControlledPilot: true,
  teacherReviewNeeded: false,
  runtimeFailClosed: true,
}, null, 2)}\n`, "utf8");

const templateResult = await writeApprovalTemplate({ out: TEMPLATE_PATH });
const template = JSON.parse(await fs.readFile(TEMPLATE_PATH, "utf8"));
assert.equal(templateResult.ok, true, "approval template command should succeed");
assert.equal(template.pilotApproved, false, "approval template must not approve the pilot by default");
assert.equal(template.approvedBy, "", "approval template must require an owner name");
assert.equal(template.approvedAt, "", "approval template must require an approval timestamp");
assert.deepEqual(template.approvedTracks, APPROVED_TRACKS, "approval template must bind both tracks");
assert.equal(template.scopeContract, SCOPE_CONTRACT, "approval template must bind the current v2 scope");
assert.equal(template.confirmSeparateMonitoredPilot, false, "template must not pre-confirm a separate pilot");
assert.equal(template.confirmDefaultRuntimeFailClosed, false, "template must not pre-confirm runtime safety");

const decisionWithoutApproval = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: path.join(TEST_DIR, "missing-approval.json"),
});
assert.equal(decisionWithoutApproval.readyForControlledPilotDecision, true, "machine evidence should be ready for owner decision");
assert.equal(decisionWithoutApproval.approvalPresent, false, "missing approval must not be accepted");
assert.equal(decisionWithoutApproval.readyToStartControlledPilot, false, "missing approval must block pilot start");
assert(
  decisionWithoutApproval.blockingReasons.includes("controlled-pilot-approval-missing"),
  "missing approval must be a blocking reason",
);

const preflightWithoutApproval = await buildPassingPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: path.join(TEST_DIR, "missing-approval.json"),
});
assert.equal(preflightWithoutApproval.okToStartControlledPilot, false, "start preflight must fail without approval");
assert(
  preflightWithoutApproval.blockingReasons.includes("approval-not-present"),
  "start preflight must explicitly report missing approval",
);

await fs.writeFile(DEFERRED_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: false,
  approvedBy: "test-owner",
  approvedAt: "2026-07-10T00:00:00+08:00",
  scope: "defer controlled pilot",
  notes: "Test-only explicit no-go file. Runtime remains fail-closed.",
}, null, 2)}\n`, "utf8");

const decisionDeferred = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: DEFERRED_APPROVAL_PATH,
});
assert.equal(decisionDeferred.approvalPresent, false, "explicit no-go must not count as pilot approval");
assert.equal(decisionDeferred.approvalDeferred, true, "explicit no-go should be recognized as a deferral");
assert.equal(decisionDeferred.readyToStartControlledPilot, false, "explicit no-go must not allow pilot start");
assert(
  decisionDeferred.blockingReasons.includes("controlled-pilot-explicitly-deferred"),
  "explicit no-go should report a deferral reason, not look like a missing approval",
);

const preflightDeferred = await buildPassingPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: DEFERRED_APPROVAL_PATH,
});
assert.equal(preflightDeferred.okToStartControlledPilot, false, "start preflight must fail for explicit no-go");
assert(
  preflightDeferred.blockingReasons.includes("approval-explicitly-deferred"),
  "start preflight should report explicit deferral",
);

const invalidRecordedDecision = await writeControlledPilotApprovalDecision({
  out: path.join(TEST_DIR, "approval.invalid.json"),
});
assert.equal(invalidRecordedDecision.ok, false, "record-decision should fail without an explicit decision and owner");
assert(
  invalidRecordedDecision.errors.includes("decision-must-be-approve-or-defer"),
  "record-decision should require approve/defer",
);
assert(
  invalidRecordedDecision.errors.includes("approved-by-required"),
  "record-decision should require an owner name",
);

const recordedDeferred = await writeControlledPilotApprovalDecision({
  out: RECORDED_DEFERRED_APPROVAL_PATH,
  decision: "defer",
  by: "test-owner",
  at: "2026-07-10T00:00:00+08:00",
});
assert.equal(recordedDeferred.ok, true, "record-decision should write an explicit defer file");
assert.equal(recordedDeferred.pilotApproved, false, "defer file must not approve the pilot");
const decisionRecordedDeferred = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: RECORDED_DEFERRED_APPROVAL_PATH,
});
assert.equal(decisionRecordedDeferred.approvalDeferred, true, "recorded defer file should be read as explicit no-go");
assert.equal(decisionRecordedDeferred.readyToStartControlledPilot, false, "recorded defer file must not start the pilot");

const approveWithoutConfirm = await writeControlledPilotApprovalDecision({
  out: path.join(TEST_DIR, "approval.approve-without-confirm.json"),
  decision: "approve",
  by: "test-owner",
  at: "2026-07-10T00:00:00+08:00",
});
assert.equal(approveWithoutConfirm.ok, false, "approve must require explicit safety confirmations");
assert(
  approveWithoutConfirm.errors.includes("approve-requires-confirm-separate-monitored-pilot"),
  "approve should require separate monitored pilot confirmation",
);
assert(
  approveWithoutConfirm.errors.includes("approve-requires-confirm-default-runtime-fail-closed"),
  "approve should require default runtime fail-closed confirmation",
);
assert(
  approveWithoutConfirm.errors.includes("approve-requires-explicit-tracks-ordinary-and-m3plus"),
  "approve should require both tracks explicitly",
);

const approveWithWrongTracks = await writeControlledPilotApprovalDecision({
  out: path.join(TEST_DIR, "approval.approve-wrong-tracks.json"),
  decision: "approve",
  by: "test-owner",
  at: "2026-07-10T00:00:00+08:00",
  tracks: "ordinary",
  confirmSeparateMonitoredPilot: true,
  confirmDefaultRuntimeFailClosed: true,
});
assert.equal(approveWithWrongTracks.ok, false, "ordinary-only approval must be rejected");
assert(
  approveWithWrongTracks.errors.includes("approve-requires-explicit-tracks-ordinary-and-m3plus"),
  "wrong track scope must report the exact-track requirement",
);

const recordedApproval = await writeControlledPilotApprovalDecision({
  out: RECORDED_VALID_APPROVAL_PATH,
  decision: "approve",
  by: "test-owner",
  at: "2026-07-10T00:00:00+08:00",
  tracks: "ordinary,m3plus",
  confirmSeparateMonitoredPilot: true,
  confirmDefaultRuntimeFailClosed: true,
});
assert.equal(recordedApproval.ok, true, "record-decision should write an approval file when safety confirmations are present");
assert.equal(recordedApproval.pilotApproved, true, "recorded approval should approve the monitored pilot");
const recordedApprovalFile = JSON.parse(await fs.readFile(RECORDED_VALID_APPROVAL_PATH, "utf8"));
assert.deepEqual(recordedApprovalFile.approvedTracks, APPROVED_TRACKS, "recorded approval must bind both tracks");
assert.equal(recordedApprovalFile.scopeContract, SCOPE_CONTRACT, "recorded approval must bind the current v2 scope");
assert.equal(recordedApprovalFile.confirmSeparateMonitoredPilot, true, "recorded approval must persist the separate-pilot confirmation");
assert.equal(recordedApprovalFile.confirmDefaultRuntimeFailClosed, true, "recorded approval must persist the fail-closed confirmation");

await fs.writeFile(VALID_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-17T00:00:00+08:00",
  approvedTracks: APPROVED_TRACKS,
  confirmSeparateMonitoredPilot: true,
  confirmDefaultRuntimeFailClosed: true,
  scope: "ordinary dynamic-shadow authorized release plus M3+ four-zone pitch-safety scope",
  scopeContract: SCOPE_CONTRACT,
  notes: "Test-only approval file under data/experiments; production/default runtime remains fail-closed.",
}, null, 2)}\n`, "utf8");

const decisionWithApproval = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
});
assert.equal(decisionWithApproval.approvalPresent, true, "valid approval should be recognized");
assert.equal(decisionWithApproval.runtimeFailClosed, true, "valid approval must not change default runtime state");
assert.equal(decisionWithApproval.readyToStartControlledPilot, true, "valid approval plus green machine evidence should make a monitored pilot startable");
assert.deepEqual(decisionWithApproval.blockingReasons, [], "valid approval path should have no blocking reasons");

const missingOrdinaryIdentityDecision = await buildControlledPilotDecision({
  releaseReview: MISSING_ORDINARY_IDENTITY_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
  projectStatus: MISSING_ORDINARY_IDENTITY_PROJECT_STATUS,
});
assert.equal(
  missingOrdinaryIdentityDecision.readyForControlledPilotDecision,
  false,
  "a matching binding must not make missing ordinary identity ready",
);
assert.equal(missingOrdinaryIdentityDecision.readyToStartControlledPilot, false);
assert(
  missingOrdinaryIdentityDecision.blockingReasons.includes("live-controlled-pilot-evidence-incomplete"),
  "missing ordinary identity must have the aggregate live-evidence blocker",
);
assert(
  !missingOrdinaryIdentityDecision.blockingReasons.includes("release-review-live-evidence-binding-missing-or-stale"),
  "missing-identity fixture must prove readiness fails even when its release binding is current",
);

const driftedOrdinaryIdentityDecision = await buildControlledPilotDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
  projectStatus: DRIFTED_ORDINARY_IDENTITY_PROJECT_STATUS,
});
assert.equal(
  driftedOrdinaryIdentityDecision.readyForControlledPilotDecision,
  false,
  "a valid but changed ordinary identity must invalidate the cached release binding",
);
assert.equal(driftedOrdinaryIdentityDecision.readyToStartControlledPilot, false);
assert(
  driftedOrdinaryIdentityDecision.blockingReasons.includes("release-review-live-evidence-binding-missing-or-stale"),
  "ordinary identity drift must have an explicit stale-binding blocker",
);
assert(
  !driftedOrdinaryIdentityDecision.blockingReasons.includes("live-controlled-pilot-evidence-incomplete"),
  "a valid replacement identity should remain intrinsically ready while invalidating the old binding",
);

for (const [releaseReview, blocker, track] of [
  [
    ORDINARY_TRACK_NOT_READY_RELEASE_PATH,
    "release-review-ordinary-track-not-ready-for-controlled-pilot",
    "ordinary",
  ],
  [
    M3PLUS_TRACK_NOT_READY_RELEASE_PATH,
    "release-review-m3plus-track-not-ready-for-controlled-pilot",
    "m3plus",
  ],
]) {
  const contradictoryTrackDecision = await buildPassingDecision({
    releaseReview,
    approval: VALID_APPROVAL_PATH,
  });
  assert.equal(
    contradictoryTrackDecision.readyForControlledPilotDecision,
    false,
    `top-level readiness and a current live binding must not hide ${track} track readiness=false`,
  );
  assert.equal(contradictoryTrackDecision.readyToStartControlledPilot, false);
  assert(contradictoryTrackDecision.blockingReasons.includes(blocker));
  assert(
    !contradictoryTrackDecision.blockingReasons.includes("release-review-live-evidence-binding-missing-or-stale"),
    `${track} contradiction fixture must retain a current live evidence binding`,
  );
}

const missingTeacherStatusDecision = await buildPassingDecision({
  releaseReview: MISSING_TEACHER_STATUS_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
});
assert.equal(
  missingTeacherStatusDecision.readyForControlledPilotDecision,
  false,
  "missing teacherReviewNeeded must fail closed instead of being treated as false",
);
assert.equal(missingTeacherStatusDecision.readyToStartControlledPilot, false);
assert(
  missingTeacherStatusDecision.blockingReasons.includes("release-review-still-needs-teacher-review"),
  "missing teacher review status must have an explicit blocker",
);

const forgedReleaseDecision = await buildPassingDecision({
  releaseReview: FORGED_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
});
assert.equal(forgedReleaseDecision.readyForControlledPilotDecision, false, "a hand-written green report without live evidence binding must fail");
assert.equal(forgedReleaseDecision.readyToStartControlledPilot, false);
assert(
  forgedReleaseDecision.blockingReasons.includes("release-review-not-ok"),
  "release review must explicitly attest ok=true",
);
assert(
  forgedReleaseDecision.blockingReasons.includes("release-review-live-evidence-binding-missing-or-stale"),
  "a synthetic green release report must not bypass the live status binding",
);

const incompletePhysicalDecision = await buildControlledPilotDecision({
  releaseReview: INCOMPLETE_PHYSICAL_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
  projectStatus: INCOMPLETE_PHYSICAL_PROJECT_STATUS,
});
assert.equal(
  incompletePhysicalDecision.readyForControlledPilotDecision,
  false,
  "a matching green report must fail when a required physical evidence digest is absent",
);
assert.equal(
  incompletePhysicalDecision.readyToStartControlledPilot,
  false,
  "missing physical evidence must never leave the start decision green",
);
assert(
  incompletePhysicalDecision.blockingReasons.includes("live-controlled-pilot-evidence-incomplete"),
  "missing physical evidence must have an explicit aggregate blocker",
);

const staleLiveProjectStatus = structuredClone(PASSING_PROJECT_STATUS);
staleLiveProjectStatus.tracks.m3plusPitchModes.offlineEvidenceReady = false;
staleLiveProjectStatus.tracks.m3plusPitchModes.m3plusPitchSafetyReady = false;
staleLiveProjectStatus.tracks.m3plusPitchModes.monitoredPilotAudit.readyForMonitoredPilot = false;
staleLiveProjectStatus.tracks.m3plusPitchModes.monitoredPilotAudit.blockingReasons = ["gold-join-missing"];
const staleLiveDecision = await buildControlledPilotDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
  projectStatus: staleLiveProjectStatus,
});
assert.equal(staleLiveDecision.readyForControlledPilotDecision, false, "a previously green report must fail when live M3+ evidence regresses");
assert.equal(staleLiveDecision.readyToStartControlledPilot, false);
assert(staleLiveDecision.blockingReasons.includes("live-m3plus-offline-evidence-not-ready"));
assert(staleLiveDecision.blockingReasons.includes("live-m3plus-pitch-safety-not-ready"));
assert(staleLiveDecision.blockingReasons.includes("release-review-live-evidence-binding-missing-or-stale"));

const MISSING_CONFIRMATIONS_APPROVAL_PATH = path.join(TEST_DIR, "approval.missing-confirmations.json");
await fs.writeFile(MISSING_CONFIRMATIONS_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-17T00:00:00+08:00",
  approvedTracks: APPROVED_TRACKS,
  scope: "current combined monitored-pilot scope",
  scopeContract: SCOPE_CONTRACT,
}, null, 2)}\n`, "utf8");
const decisionWithMissingConfirmations = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: MISSING_CONFIRMATIONS_APPROVAL_PATH,
});
assert.equal(decisionWithMissingConfirmations.approvalPresent, false, "approval without persisted safety confirmations must be rejected");
assert.equal(decisionWithMissingConfirmations.readyToStartControlledPilot, false);
assert(
  decisionWithMissingConfirmations.blockingReasons.includes("controlled-pilot-approval-safety-confirmations-missing"),
  "missing persisted safety confirmations must be an explicit blocker",
);

const STALE_APPROVAL_PATH = path.join(TEST_DIR, "approval.stale-scope.json");
await fs.writeFile(STALE_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-09T00:00:00+08:00",
  scope: "ordinary candidate-evidence auto_pass only; optional first-measure slide/trill M3+ subset",
  notes: "Superseded-era approval without a scope contract binding.",
}, null, 2)}\n`, "utf8");
const decisionWithStaleApproval = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: STALE_APPROVAL_PATH,
});
assert.equal(decisionWithStaleApproval.approvalPresent, false, "superseded-era approval must not count as a present approval");
assert.equal(decisionWithStaleApproval.readyToStartControlledPilot, false, "superseded-era approval must not start a pilot under the rescope contract");
assert(
  decisionWithStaleApproval.blockingReasons.includes("controlled-pilot-approval-scope-contract-superseded"),
  "stale approval must be reported as scope-contract superseded, forcing a fresh owner decision",
);

const MISSING_TRACKS_APPROVAL_PATH = path.join(TEST_DIR, "approval.missing-tracks.json");
await fs.writeFile(MISSING_TRACKS_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-17T00:00:00+08:00",
  scope: "current scope text but no structured track binding",
  scopeContract: SCOPE_CONTRACT,
  confirmSeparateMonitoredPilot: true,
  confirmDefaultRuntimeFailClosed: true,
}, null, 2)}\n`, "utf8");
const decisionWithMissingTracks = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: MISSING_TRACKS_APPROVAL_PATH,
});
assert.equal(decisionWithMissingTracks.approvalPresent, false, "approval without approvedTracks must be rejected");
assert(
  decisionWithMissingTracks.blockingReasons.includes("controlled-pilot-approval-tracks-mismatch"),
  "missing approvedTracks must be reported as a track mismatch",
);

const WRONG_TRACKS_APPROVAL_PATH = path.join(TEST_DIR, "approval.wrong-tracks.json");
await fs.writeFile(WRONG_TRACKS_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-17T00:00:00+08:00",
  approvedTracks: ["ordinary"],
  confirmSeparateMonitoredPilot: true,
  confirmDefaultRuntimeFailClosed: true,
  scope: "ordinary-only approval must not authorize the combined pilot",
  scopeContract: SCOPE_CONTRACT,
}, null, 2)}\n`, "utf8");
const decisionWithWrongTracks = await buildPassingDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: WRONG_TRACKS_APPROVAL_PATH,
});
assert.equal(decisionWithWrongTracks.approvalPresent, false, "ordinary-only approvedTracks must be rejected");
assert(
  decisionWithWrongTracks.blockingReasons.includes("controlled-pilot-approval-tracks-mismatch"),
  "wrong approvedTracks must be reported as a track mismatch",
);

const preflightAuthorizedWithoutExecutor = await buildPassingPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
});
assert.equal(preflightAuthorizedWithoutExecutor.okToStartControlledPilot, false);
assert.equal(preflightAuthorizedWithoutExecutor.ordinaryPilotExecutorReady, false);
assert.equal(preflightAuthorizedWithoutExecutor.m3plusPilotExecutorReady, false);
assert.equal(preflightAuthorizedWithoutExecutor.pilotExecutorReady, false);
assert(preflightAuthorizedWithoutExecutor.blockingReasons.includes("ordinary-dynamic-shadow-pilot-executor-not-implemented"));
assert(preflightAuthorizedWithoutExecutor.blockingReasons.includes("m3plus-pitch-safety-pilot-executor-not-implemented"));

const preflightWithOrdinaryExecutorOnly = await buildPassingPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
  pilotExecutorContract: ORDINARY_EXECUTOR_CONTRACT,
  pilotExecutorContractReady: true,
});
assert.equal(preflightWithOrdinaryExecutorOnly.okToStartControlledPilot, false, "ordinary-only executor must not start a combined pilot");
assert.equal(preflightWithOrdinaryExecutorOnly.ordinaryPilotExecutorReady, true);
assert.equal(preflightWithOrdinaryExecutorOnly.m3plusPilotExecutorReady, false);
assert(
  preflightWithOrdinaryExecutorOnly.blockingReasons.includes("m3plus-pitch-safety-pilot-executor-not-implemented"),
  "ordinary-only executor must leave the M3+ blocker closed",
);

const preflightWithApproval = await buildPassingPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
  pilotExecutorContract: ORDINARY_EXECUTOR_CONTRACT,
  pilotExecutorContractReady: true,
  m3plusPilotExecutorContract: M3PLUS_EXECUTOR_CONTRACT,
  m3plusPilotExecutorContractReady: true,
});
assert.equal(preflightWithApproval.okToStartControlledPilot, true, "start preflight should pass with valid owner approval");
assert.equal(preflightWithApproval.pilotExecutorReady, true, "aggregate executor readiness requires both tracks");
assert.deepEqual(preflightWithApproval.blockingReasons, [], "passing start preflight should have no blocking reasons");
assert.equal(preflightWithApproval.decision.runtimeFailClosed, true, "passing start preflight must keep default runtime fail-closed");
const preflightWithRecordedApproval = await buildPassingPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: RECORDED_VALID_APPROVAL_PATH,
  pilotExecutorContract: ORDINARY_EXECUTOR_CONTRACT,
  pilotExecutorContractReady: true,
  m3plusPilotExecutorContract: M3PLUS_EXECUTOR_CONTRACT,
  m3plusPilotExecutorContractReady: true,
});
assert.equal(preflightWithRecordedApproval.okToStartControlledPilot, true, "recorded approval should pass start preflight");
assert.equal(preflightWithRecordedApproval.decision.runtimeFailClosed, true, "recorded approval must keep default runtime fail-closed");

const legacyReleaseDecision = await buildPassingDecision({
  releaseReview: LEGACY_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
});
assert.equal(legacyReleaseDecision.readyForControlledPilotDecision, false);
assert.equal(legacyReleaseDecision.readyToStartControlledPilot, false);
assert(
  legacyReleaseDecision.blockingReasons.includes("release-review-ordinary-authorization-contract-superseded"),
  "the cached pre-dynamic release review must carry no current authority",
);
assert(
  legacyReleaseDecision.blockingReasons.includes("ordinary-dynamic-shadow-authorization-closed"),
  "pilot start must require an explicit dynamic-shadow authorization",
);
const cachedReleaseDecision = await buildControlledPilotDecision();
assert.equal(cachedReleaseDecision.readyForControlledPilotDecision, false);
assert.equal(cachedReleaseDecision.readyToStartControlledPilot, false);
assert(
  cachedReleaseDecision.blockingReasons.includes("ordinary-dynamic-shadow-authorization-closed"),
  "the live cached release review must remain blocked until dynamic authorization exists",
);

const originalApproval = await readTextOrNull(DEFAULT_APPROVAL_PATH);
const originalDecision = await readTextOrNull(DEFAULT_DECISION_PATH);
try {
  await fs.mkdir(path.dirname(DEFAULT_APPROVAL_PATH), { recursive: true });
  await fs.writeFile(DEFAULT_APPROVAL_PATH, `${JSON.stringify({
    pilotApproved: false,
    approvedBy: "test-owner",
    approvedAt: "2026-07-10T00:00:00+08:00",
    scope: "defer controlled pilot",
    notes: "Test-only default-path explicit no-go. Runtime remains fail-closed.",
  }, null, 2)}\n`, "utf8");
  const defaultDeferredDecision = await buildControlledPilotDecision();
  await fs.writeFile(DEFAULT_DECISION_PATH, `${JSON.stringify(defaultDeferredDecision, null, 2)}\n`, "utf8");

  const statusWithDeferredPilot = await buildProjectStatus({
    controlledPilotSessionsRoot: path.join(TEST_DIR, "no-sessions"),
  });
  assert.equal(
    statusWithDeferredPilot.controlledPilotDecision?.approvalDeferred,
    true,
    "project status should expose explicit controlled-pilot deferral from the default approval path",
  );
  assert.equal(
    statusWithDeferredPilot.nextActions?.[0]?.track,
    "Ordinary dynamic shadow r3 evidence verifier",
    "the live dynamic-evidence verifier must outrank the historical pilot decision",
  );
  const handoff = renderHandoff(statusWithDeferredPilot);
  assert(
    handoff.includes("Ordinary dynamic shadow r3 evidence verifier"),
    "handoff should route to the current dynamic verifier prerequisite",
  );

  await fs.writeFile(DEFAULT_APPROVAL_PATH, `${JSON.stringify({
    pilotApproved: true,
    approvedBy: "test-owner",
    approvedAt: "2026-07-17T00:00:00+08:00",
    approvedTracks: APPROVED_TRACKS,
    confirmSeparateMonitoredPilot: true,
    confirmDefaultRuntimeFailClosed: true,
    scope: "ordinary dynamic-shadow authorized release",
    scopeContract: SCOPE_CONTRACT,
    notes: "Test-only approval. Default runtime remains fail-closed.",
  }, null, 2)}\n`, "utf8");
  const defaultApprovedDecision = await buildControlledPilotDecision();
  await fs.writeFile(DEFAULT_DECISION_PATH, `${JSON.stringify(defaultApprovedDecision, null, 2)}\n`, "utf8");
  const statusWithApprovedPilot = await buildProjectStatus({
    controlledPilotSessionsRoot: path.join(TEST_DIR, "no-sessions"),
  });
  assert.equal(statusWithApprovedPilot.nextActions?.[0]?.track, "Ordinary dynamic shadow r3 evidence verifier");
  const approvedHandoff = renderHandoff(statusWithApprovedPilot);
  assert(
    !approvedHandoff.includes("npm run western:controlled-pilot-run -- --execute --limit 1"),
    "legacy release evidence must never point to the pilot runner",
  );

  const completedSessionRoot = path.join(TEST_DIR, "completed-sessions");
  await fs.rm(completedSessionRoot, { recursive: true, force: true });
  const completedSessionDir = path.join(completedSessionRoot, "pilot-completed");
  await fs.mkdir(completedSessionDir, { recursive: true });
  await fs.writeFile(path.join(completedSessionDir, "session.json"), `${JSON.stringify({
    ok: true,
    generatedAt: "2026-07-10T01:00:00+08:00",
    sessionId: "pilot-completed",
    sessionStatus: "completed_safe",
    executionPerformed: true,
    pilotRunAccepted: true,
    approvedBy: "test-owner",
    selectedSubmissions: [{ submissionId: "submission-completed", recordingId: "recording-completed" }],
    monitoring: {
      selectedSubmissionCount: 1,
      totalCandidateCount: 60,
      autoPassCandidateCount: 8,
      knownUsableAutoPassCandidateCount: 3,
      knownWrongAutoPassCandidateCount: 0,
      unknownAutoPassCandidateCount: 0,
    },
    defaultRuntimeFailClosedAfter: true,
    processEnvironmentRestored: true,
    studentFeedbackPublished: false,
    blockingReasons: [],
    artifacts: { sessionMd: "data/experiments/test/session.md" },
  }, null, 2)}\n`, "utf8");
  const laterStatusOnlyDir = path.join(completedSessionRoot, "pilot-status-only");
  await fs.mkdir(laterStatusOnlyDir, { recursive: true });
  await fs.writeFile(path.join(laterStatusOnlyDir, "session.json"), `${JSON.stringify({
    ok: true,
    generatedAt: "2026-07-10T02:00:00+08:00",
    sessionId: "pilot-status-only",
    sessionStatus: "ready_not_executed",
    executionPerformed: false,
    pilotRunAccepted: false,
    blockingReasons: [],
  }, null, 2)}\n`, "utf8");
  const statusWithCompletedPilot = await buildProjectStatus({
    controlledPilotSessionsRoot: completedSessionRoot,
  });
  const completedTrack = statusWithCompletedPilot.nextActions?.[0]?.track;
  assert.equal(completedTrack, "Ordinary dynamic shadow r3 evidence verifier");
  assert.equal(statusWithCompletedPilot.controlledPilotSession?.sessionId, "pilot-completed");
  assert.equal(statusWithCompletedPilot.controlledPilotSession?.eligibleAsCurrentReleaseEvidence, false);
  assert.equal(statusWithCompletedPilot.controlledPilotEvidence?.completedSafeSessionCount, 0);
  assert.equal(statusWithCompletedPilot.controlledPilotEvidence?.safeDistinctRecordingCount, 0);
  assert.equal(statusWithCompletedPilot.controlledPilotEvidence?.eligibleAsCurrentReleaseEvidence, false);
  assert.equal(statusWithCompletedPilot.controlledPilotEvidence?.v2AlphaGate?.ready, false);
  assert.equal(statusWithCompletedPilot.controlledPilotEvidence?.historicalEvidence?.completedSafeSessionCount, 1);
  assert.equal(statusWithCompletedPilot.controlledPilotEvidence?.historicalEvidence?.safeDistinctRecordingCount, 1);
  const completedHandoff = renderHandoff(statusWithCompletedPilot);
  assert(!completedHandoff.includes("western:controlled-pilot-run -- --execute"));
} finally {
  await restoreText(DEFAULT_APPROVAL_PATH, originalApproval);
  await restoreText(DEFAULT_DECISION_PATH, originalDecision);
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "template-does-not-approve",
    "decision-blocks-without-approval",
    "preflight-blocks-without-approval",
    "decision-recognizes-explicit-no-go",
    "preflight-blocks-explicit-no-go",
    "record-decision-requires-decision-and-owner",
    "record-decision-defer-does-not-start",
    "record-decision-approve-requires-safety-confirmations",
    "record-decision-approve-requires-exact-tracks",
    "record-decision-approve-passes-preflight-with-runtime-fail-closed",
    "project-status-defers-explicit-no-go-without-review",
    "handoff-defers-explicit-no-go-without-review",
    "decision-passes-with-valid-temp-approval",
    "ordinary-runtime-and-acceptance-identity-required",
    "ordinary-identity-binding-drift-blocks",
    "single-track-readiness-contradictions-block",
    "missing-teacher-review-status-blocks",
    "forged-or-stale-release-review-cannot-bypass-live-evidence",
    "approval-confirmations-are-persisted-and-required",
    "stale-scope-approval-requires-fresh-owner-decision",
    "missing-or-wrong-approved-tracks-block",
    "ordinary-only-executor-remains-blocked",
    "dual-executor-preflight-passes-with-valid-temp-approval",
    "default-runtime-remains-fail-closed",
    "approved-handoff-points-to-one-shot-pilot-runner",
    "completed-session-prevents-duplicate-pilot-run",
    "status-only-session-does-not-hide-executed-pilot",
  ],
  artifacts: {
    template: TEMPLATE_PATH.replace(/\\/g, "/"),
    deferredApproval: DEFERRED_APPROVAL_PATH.replace(/\\/g, "/"),
    validApproval: VALID_APPROVAL_PATH.replace(/\\/g, "/"),
  },
}, null, 2));
