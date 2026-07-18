import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { writeApprovalTemplate } from "./create-western-controlled-pilot-approval-template.mjs";
import { buildControlledPilotDecision } from "./create-western-controlled-pilot-decision.mjs";
import { renderHandoff } from "./create-western-strings-next-action-handoff.mjs";
import { writeControlledPilotApprovalDecision } from "./record-western-controlled-pilot-decision.mjs";
import { buildControlledPilotStartPreflight } from "./run-western-controlled-pilot-start-preflight.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const TEST_DIR = path.join("data", "experiments", "western-strings-controlled-pilot-test");
const TEMPLATE_PATH = path.join(TEST_DIR, "approval.template.json");
const DEFERRED_APPROVAL_PATH = path.join(TEST_DIR, "approval.deferred.json");
const VALID_APPROVAL_PATH = path.join(TEST_DIR, "approval.valid.json");
const RECORDED_DEFERRED_APPROVAL_PATH = path.join(TEST_DIR, "approval.recorded-deferred.json");
const RECORDED_VALID_APPROVAL_PATH = path.join(TEST_DIR, "approval.recorded-valid.json");
const CURRENT_RELEASE_PATH = path.join(TEST_DIR, "release.current.json");
const LEGACY_RELEASE_PATH = path.join(TEST_DIR, "release.legacy.json");
const DEFAULT_APPROVAL_PATH = path.join("data", "experiments", "western-strings-controlled-pilot-approval.json");
const DEFAULT_DECISION_PATH = path.join("data", "experiments", "western-strings-controlled-pilot-decision.json");

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

const decisionWithoutApproval = await buildControlledPilotDecision({
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

const preflightWithoutApproval = await buildControlledPilotStartPreflight({
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

const decisionDeferred = await buildControlledPilotDecision({
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

const preflightDeferred = await buildControlledPilotStartPreflight({
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
const decisionRecordedDeferred = await buildControlledPilotDecision({
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

const recordedApproval = await writeControlledPilotApprovalDecision({
  out: RECORDED_VALID_APPROVAL_PATH,
  decision: "approve",
  by: "test-owner",
  at: "2026-07-10T00:00:00+08:00",
  confirmSeparateMonitoredPilot: true,
  confirmDefaultRuntimeFailClosed: true,
});
assert.equal(recordedApproval.ok, true, "record-decision should write an approval file when safety confirmations are present");
assert.equal(recordedApproval.pilotApproved, true, "recorded approval should approve the monitored pilot");

await fs.writeFile(VALID_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-17T00:00:00+08:00",
  scope: "ordinary dynamic-shadow authorized release plus M3+ four-zone pitch-safety scope",
  scopeContract: "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v1",
  notes: "Test-only approval file under data/experiments; production/default runtime remains fail-closed.",
}, null, 2)}\n`, "utf8");

const decisionWithApproval = await buildControlledPilotDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
});
assert.equal(decisionWithApproval.approvalPresent, true, "valid approval should be recognized");
assert.equal(decisionWithApproval.runtimeFailClosed, true, "valid approval must not change default runtime state");
assert.equal(decisionWithApproval.readyToStartControlledPilot, true, "valid approval plus green machine evidence should make a monitored pilot startable");
assert.deepEqual(decisionWithApproval.blockingReasons, [], "valid approval path should have no blocking reasons");

const STALE_APPROVAL_PATH = path.join(TEST_DIR, "approval.stale-scope.json");
await fs.writeFile(STALE_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-09T00:00:00+08:00",
  scope: "ordinary candidate-evidence auto_pass only; optional first-measure slide/trill M3+ subset",
  notes: "Superseded-era approval without a scope contract binding.",
}, null, 2)}\n`, "utf8");
const decisionWithStaleApproval = await buildControlledPilotDecision({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: STALE_APPROVAL_PATH,
});
assert.equal(decisionWithStaleApproval.approvalPresent, false, "superseded-era approval must not count as a present approval");
assert.equal(decisionWithStaleApproval.readyToStartControlledPilot, false, "superseded-era approval must not start a pilot under the rescope contract");
assert(
  decisionWithStaleApproval.blockingReasons.includes("controlled-pilot-approval-scope-contract-superseded"),
  "stale approval must be reported as scope-contract superseded, forcing a fresh owner decision",
);

const preflightAuthorizedWithoutExecutor = await buildControlledPilotStartPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
});
assert.equal(preflightAuthorizedWithoutExecutor.okToStartControlledPilot, false);
assert(preflightAuthorizedWithoutExecutor.blockingReasons.includes("ordinary-dynamic-shadow-pilot-executor-not-implemented"));

const preflightWithApproval = await buildControlledPilotStartPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: VALID_APPROVAL_PATH,
  pilotExecutorContract: "western-ordinary-dynamic-shadow-pilot-executor-v1",
  pilotExecutorContractReady: true,
});
assert.equal(preflightWithApproval.okToStartControlledPilot, true, "start preflight should pass with valid owner approval");
assert.deepEqual(preflightWithApproval.blockingReasons, [], "passing start preflight should have no blocking reasons");
assert.equal(preflightWithApproval.decision.runtimeFailClosed, true, "passing start preflight must keep default runtime fail-closed");
const preflightWithRecordedApproval = await buildControlledPilotStartPreflight({
  releaseReview: CURRENT_RELEASE_PATH,
  approval: RECORDED_VALID_APPROVAL_PATH,
  pilotExecutorContract: "western-ordinary-dynamic-shadow-pilot-executor-v1",
  pilotExecutorContractReady: true,
});
assert.equal(preflightWithRecordedApproval.okToStartControlledPilot, true, "recorded approval should pass start preflight");
assert.equal(preflightWithRecordedApproval.decision.runtimeFailClosed, true, "recorded approval must keep default runtime fail-closed");

const legacyReleaseDecision = await buildControlledPilotDecision({
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
    scope: "ordinary dynamic-shadow authorized release",
    scopeContract: "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v1",
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
    "record-decision-approve-passes-preflight-with-runtime-fail-closed",
    "project-status-defers-explicit-no-go-without-review",
    "handoff-defers-explicit-no-go-without-review",
    "decision-passes-with-valid-temp-approval",
    "stale-scope-approval-requires-fresh-owner-decision",
    "preflight-passes-with-valid-temp-approval",
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
