import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadHistoricalRecordingIds,
  runControlledPilotSession,
} from "./run-western-controlled-pilot-session.mjs";

const ENABLE_ENV = "WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE";
const ORDINARY_EXECUTOR_CONTRACT = "western-ordinary-dynamic-shadow-pilot-executor-v1";
const M3PLUS_EXECUTOR_CONTRACT = "western-m3plus-pitch-safety-pilot-executor-v1";

function statusFailClosed() {
  return {
    runtimeStudentGate: {
      policy: "fail-closed",
      ordinaryUploadAutoFeedbackReady: false,
      m3plusAutoFeedbackReady: false,
      m4OmrAutoScoreReady: false,
    },
  };
}

function approvedPreflight() {
  return {
    okToStartControlledPilot: true,
    ordinaryPilotExecutorReady: true,
    pilotExecutorContract: ORDINARY_EXECUTOR_CONTRACT,
    m3plusPilotExecutorReady: true,
    m3plusPilotExecutorContract: M3PLUS_EXECUTOR_CONTRACT,
    pilotExecutorReady: true,
    blockingReasons: [],
    decision: {
      approvalPresent: true,
      approval: { approvedBy: "test-owner" },
    },
  };
}

function blockedPreflight() {
  return {
    okToStartControlledPilot: false,
    ordinaryPilotExecutorReady: true,
    pilotExecutorContract: ORDINARY_EXECUTOR_CONTRACT,
    m3plusPilotExecutorReady: true,
    m3plusPilotExecutorContract: M3PLUS_EXECUTOR_CONTRACT,
    pilotExecutorReady: true,
    blockingReasons: ["controlled-pilot-approval-missing"],
    decision: { approvalPresent: false, approval: null },
  };
}

function ordinaryOnlyExecutorPreflight() {
  return {
    okToStartControlledPilot: false,
    ordinaryPilotExecutorReady: true,
    pilotExecutorContract: ORDINARY_EXECUTOR_CONTRACT,
    m3plusPilotExecutorReady: false,
    m3plusPilotExecutorContract: M3PLUS_EXECUTOR_CONTRACT,
    pilotExecutorReady: false,
    blockingReasons: ["m3plus-pitch-safety-pilot-executor-not-implemented"],
    decision: {
      approvalPresent: true,
      approval: { approvedBy: "test-owner" },
    },
  };
}

function m3plusResult(overrides = {}) {
  return {
    contract: M3PLUS_EXECUTOR_CONTRACT,
    ok: true,
    reviewOnly: true,
    feedbackAuthorized: false,
    studentFacing: false,
    blockers: [],
    ...overrides,
  };
}

function precisionResult({
  knownWrong = 0,
  unknown = 0,
  ok = true,
  recordingId = "recording-new",
  modelAutoPass = 3,
  selfChecked = 3,
  scopedAutoPass = selfChecked,
  knownUsable = Math.max(0, selfChecked - knownWrong - unknown),
} = {}) {
  return {
    summary: {
      ok,
      selectedSubmissionCount: 1,
      selectedSubmissions: [{ submissionId: `submission-${recordingId}`, recordingId }],
      totalCandidateCount: 8,
      modelAutoPassCandidateCount: modelAutoPass,
      autoPassCandidateCount: scopedAutoPass,
      selfCheckedAutoPassCandidateCount: selfChecked,
      knownUsableAutoPassCandidateCount: knownUsable,
      knownWrongAutoPassCandidateCount: knownWrong,
      unknownReviewCandidateCount: unknown,
      defaultOrdinaryReadyAfter: false,
      blockingReasons: ok ? [] : ["precision-check-failed"],
      reviewPack: unknown ? { htmlPath: "targeted-review/index.html" } : null,
    },
  };
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-controlled-pilot-session-test-"));
const oldEnable = process.env[ENABLE_ENV];
try {
  let calls = 0;
  let m3plusCalls = 0;
  let postExecutionRefreshCalls = 0;
  const common = {
    outRoot: tempRoot,
    refreshReleaseReview: async () => ({ ok: true }),
    refreshPostExecutionEvidence: async () => {
      postExecutionRefreshCalls += 1;
      return { ok: true };
    },
    buildStatus: async () => statusFailClosed(),
    loadHistoricalRecordingIds: async () => [],
    runM3PlusPitchSafetyPilotSession: async () => {
      m3plusCalls += 1;
      return m3plusResult();
    },
  };

  await fs.mkdir(path.join(tempRoot, "history-zero"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "history-zero", "session.json"), JSON.stringify({
    executionPerformed: true,
    additionalExcludedRecordingIds: ["recording-rejected-before-run"],
    selectedSubmissions: [{ recordingId: "recording-infrastructure-failure" }],
    monitoring: { totalCandidateCount: 0 },
  }), "utf8");
  await fs.mkdir(path.join(tempRoot, "history-evidence"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "history-evidence", "session.json"), JSON.stringify({
    executionPerformed: true,
    selectedSubmissions: [{ recordingId: "recording-with-evidence" }],
    monitoring: { totalCandidateCount: 8 },
  }), "utf8");
  await fs.mkdir(path.join(tempRoot, "history-invalidated"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "history-invalidated", "session.json"), JSON.stringify({
    executionPerformed: true,
    evidenceInvalidated: true,
    selectedSubmissions: [{ recordingId: "recording-invalidated-evidence" }],
    monitoring: { totalCandidateCount: 8 },
  }), "utf8");
  assert.deepEqual(
    await loadHistoricalRecordingIds(tempRoot),
    ["recording-rejected-before-run", "recording-with-evidence"],
  );

  const dryRun = await runControlledPilotSession({ sessionId: "dry-run", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(dryRun.sessionStatus, "ready_not_executed");
  assert.equal(dryRun.executionPerformed, false);
  assert.equal(calls, 0, "dry-run must not execute the pilot batch");
  assert.equal(postExecutionRefreshCalls, 0, "dry-run must not refresh post-execution evidence");

  const noApproval = await runControlledPilotSession({ execute: true, sessionId: "no-approval", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => blockedPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(noApproval.sessionStatus, "blocked");
  assert.equal(noApproval.executionPerformed, false);
  assert(noApproval.blockingReasons.includes("controlled-pilot-approval-missing"));
  assert.equal(calls, 0, "missing approval must not execute the pilot batch");

  const ordinaryOnlyExecutor = await runControlledPilotSession({
    execute: true,
    sessionId: "ordinary-only-executor",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => ordinaryOnlyExecutorPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(ordinaryOnlyExecutor.sessionStatus, "blocked");
  assert.equal(ordinaryOnlyExecutor.executionPerformed, false);
  assert(
    ordinaryOnlyExecutor.blockingReasons.includes("m3plus-pitch-safety-pilot-executor-not-implemented"),
    "an ordinary-only executor must leave the combined session fail-closed",
  );
  assert.equal(calls, 0, "ordinary execution must not start while the M3+ executor is absent");

  const missingM3Executor = await runControlledPilotSession({
    execute: true,
    sessionId: "missing-m3-executor",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
    runM3PlusPitchSafetyPilotSession: null,
  });
  assert.equal(missingM3Executor.sessionStatus, "blocked");
  assert.equal(missingM3Executor.executionPerformed, false);
  assert(
    missingM3Executor.blockingReasons.includes("m3plus-pitch-safety-pilot-executor-not-implemented"),
  );

  const contradictoryAggregatePreflight = approvedPreflight();
  contradictoryAggregatePreflight.pilotExecutorReady = false;
  const aggregateNotReady = await runControlledPilotSession({
    execute: true,
    sessionId: "aggregate-executor-not-ready",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => contradictoryAggregatePreflight,
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(aggregateNotReady.sessionStatus, "blocked");
  assert.equal(aggregateNotReady.executionPerformed, false);
  assert(aggregateNotReady.blockingReasons.includes("pilot-executor-aggregate-readiness-invalid"));

  let sharedExecutorCalls = 0;
  const sharedExecutor = async () => {
    sharedExecutorCalls += 1;
    return precisionResult();
  };
  const sameFunctionExecutors = await runControlledPilotSession({
    execute: true,
    sessionId: "same-function-executors",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: sharedExecutor,
    runM3PlusPitchSafetyPilotSession: sharedExecutor,
  });
  assert.equal(sameFunctionExecutors.sessionStatus, "blocked");
  assert.equal(sameFunctionExecutors.executionPerformed, false);
  assert(
    sameFunctionExecutors.blockingReasons.includes("pilot-executors-must-be-distinct-functions"),
  );
  assert.equal(sharedExecutorCalls, 0, "same-function executors must be rejected before execution");

  const sameContractPreflight = approvedPreflight();
  sameContractPreflight.m3plusPilotExecutorContract = ORDINARY_EXECUTOR_CONTRACT;
  const sameContract = await runControlledPilotSession({
    execute: true,
    sessionId: "same-contract",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => sameContractPreflight,
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(sameContract.sessionStatus, "blocked");
  assert(sameContract.blockingReasons.includes("m3plus-pilot-executor-readiness-contract-invalid"));
  assert(sameContract.blockingReasons.includes("pilot-executor-contracts-not-distinct"));

  process.env[ENABLE_ENV] = "1";
  const parentEnabled = await runControlledPilotSession({ execute: true, sessionId: "parent-enabled", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(parentEnabled.sessionStatus, "blocked");
  assert(parentEnabled.blockingReasons.includes("pilot-run-parent-env-enabled"));
  assert.equal(process.env[ENABLE_ENV], "1", "runner must preserve the caller environment exactly");
  delete process.env[ENABLE_ENV];

  const safe = await runControlledPilotSession({ execute: true, sessionId: "safe", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(safe.sessionStatus, "completed_safe");
  assert.equal(safe.pilotRunAccepted, true);
  assert.equal(safe.executors.ordinary.contract, ORDINARY_EXECUTOR_CONTRACT);
  assert.equal(safe.executors.ordinary.executionPerformed, true);
  assert.equal(safe.executors.ordinary.executionPassed, true);
  assert.equal(safe.executors.m3plus.contract, M3PLUS_EXECUTOR_CONTRACT);
  assert.equal(safe.executors.m3plus.executionPerformed, true);
  assert.equal(safe.executors.m3plus.executionPassed, true);
  assert.equal(safe.executors.m3plus.result.reviewOnly, true);
  assert.equal(safe.monitoring.knownUsableAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.modelAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.pilotEligibleAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.scopedAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.suppressedModelAutoPassCandidateCount, 0);
  assert.equal(safe.monitoring.reviewRequiredCandidateCount, 5);
  assert.equal(safe.defaultRuntimeFailClosedAfter, true);
  assert.equal(safe.processEnvironmentRestored, true);
  assert.equal(safe.postExecutionEvidenceRefresh.ok, true);
  assert.equal(postExecutionRefreshCalls, 1);
  assert.equal(process.env[ENABLE_ENV], undefined);

  const staleAfterExecution = await runControlledPilotSession({
    execute: true,
    sessionId: "post-execution-refresh-failed",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => precisionResult(),
    refreshPostExecutionEvidence: async () => ({ ok: false }),
  });
  assert.equal(staleAfterExecution.sessionStatus, "aborted");
  assert.equal(staleAfterExecution.pilotRunAccepted, false);
  assert(
    staleAfterExecution.blockingReasons.includes(
      "pilot-run-post-execution-evidence-refresh-failed",
    ),
  );

  const invalidM3Results = [
    ["wrong-contract", { contract: ORDINARY_EXECUTOR_CONTRACT }],
    ["not-ok", { ok: false }],
    ["not-review-only", { reviewOnly: false }],
    ["feedback-authorized", { feedbackAuthorized: true }],
    ["student-facing", { studentFacing: true }],
    ["has-blockers", { blockers: ["unsafe"] }],
  ];
  for (const [name, override] of invalidM3Results) {
    const invalidM3 = await runControlledPilotSession({
      execute: true,
      sessionId: `invalid-m3-${name}`,
      outRoot: tempRoot,
    }, {
      ...common,
      buildPreflight: async () => approvedPreflight(),
      runPrecisionSession: async () => { calls += 1; return precisionResult(); },
      runM3PlusPitchSafetyPilotSession: async () => {
        m3plusCalls += 1;
        return m3plusResult(override);
      },
    });
    assert.equal(invalidM3.sessionStatus, "aborted");
    assert.equal(invalidM3.executionPerformed, true);
    assert.equal(invalidM3.pilotRunAccepted, false);
    assert.equal(invalidM3.executors.ordinary.executionPassed, true);
    assert.equal(invalidM3.executors.m3plus.executionPerformed, true);
    assert.equal(invalidM3.executors.m3plus.executionPassed, false);
    assert(invalidM3.blockingReasons.includes("m3plus-pitch-safety-pilot-result-invalid"));
  }
  const invalidOrdinary = await runControlledPilotSession({
    execute: true,
    sessionId: "invalid-ordinary-result",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult({ ok: false }); },
  });
  assert.equal(invalidOrdinary.sessionStatus, "aborted");
  assert.equal(invalidOrdinary.pilotRunAccepted, false);
  assert.equal(invalidOrdinary.executors.ordinary.executionPassed, false);
  assert.equal(invalidOrdinary.executors.m3plus.executionPassed, true);
  assert(invalidOrdinary.blockingReasons.includes("ordinary-pilot-executor-result-invalid"));
  assert(invalidOrdinary.blockingReasons.includes("pilot:precision-check-failed"));

  const suppressed = await runControlledPilotSession({ execute: true, sessionId: "suppressed", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => precisionResult({ modelAutoPass: 8, selfChecked: 3 }),
  });
  assert.equal(suppressed.sessionStatus, "completed_safe");
  assert.equal(suppressed.monitoring.modelAutoPassCandidateCount, 8);
  assert.equal(suppressed.monitoring.pilotEligibleAutoPassCandidateCount, 3);
  assert.equal(suppressed.monitoring.suppressedModelAutoPassCandidateCount, 5);
  assert.equal(suppressed.monitoring.reviewRequiredCandidateCount, 5);

  const accountingMismatch = await runControlledPilotSession({
    execute: true,
    sessionId: "accounting-mismatch",
    outRoot: tempRoot,
  }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => precisionResult({ selfChecked: 3, knownUsable: 2 }),
  });
  assert.equal(accountingMismatch.sessionStatus, "aborted");
  assert(
    accountingMismatch.blockingReasons.includes("pilot-self-check-accounting-mismatch:3:2"),
  );

  let historyAwareArgs = null;
  const historyAware = await runControlledPilotSession({ execute: true, sessionId: "history-aware", outRoot: tempRoot }, {
    ...common,
    loadHistoricalRecordingIds: async () => ["recording-old"],
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async (args) => {
      historyAwareArgs = args;
      return precisionResult({ recordingId: "recording-new" });
    },
  });
  assert.deepEqual(historyAwareArgs.excludeRecordingIds, ["recording-old"]);
  assert.deepEqual(historyAware.historyExcludedRecordingIds, ["recording-old"]);
  assert.equal(historyAware.selectedSubmissions[0].recordingId, "recording-new");

  let additionalExclusionArgs = null;
  const additionalExclusion = await runControlledPilotSession({
    execute: true,
    sessionId: "additional-exclusion",
    outRoot: tempRoot,
    excludeRecordingIds: ["recording-precheck-rejected"],
  }, {
    ...common,
    loadHistoricalRecordingIds: async () => ["recording-old"],
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async (args) => {
      additionalExclusionArgs = args;
      return precisionResult({ recordingId: "recording-new" });
    },
  });
  assert.deepEqual(
    additionalExclusionArgs.excludeRecordingIds,
    ["recording-old", "recording-precheck-rejected"],
  );
  assert.deepEqual(additionalExclusion.additionalExcludedRecordingIds, ["recording-precheck-rejected"]);

  let targetedArgs = null;
  const targeted = await runControlledPilotSession({
    execute: true,
    sessionId: "targeted-recording",
    outRoot: tempRoot,
    includeRecordingIds: ["recording-target", "recording-target", ""],
  }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async (args) => {
      targetedArgs = args;
      return precisionResult({ recordingId: "recording-target" });
    },
  });
  assert.deepEqual(targetedArgs.includeRecordingIds, ["recording-target"]);
  assert.deepEqual(targeted.requestedRecordingIds, ["recording-target"]);
  assert.equal(targeted.sessionStatus, "completed_safe");

  const wrongTarget = await runControlledPilotSession({
    execute: true,
    sessionId: "wrong-target",
    outRoot: tempRoot,
    includeRecordingIds: ["recording-target"],
  }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => precisionResult({ recordingId: "recording-other" }),
  });
  assert.equal(wrongTarget.sessionStatus, "aborted");
  assert(wrongTarget.blockingReasons.includes("pilot-unrequested-recording-selected:recording-other"));
  assert(wrongTarget.blockingReasons.includes("pilot-requested-recording-not-selected:recording-target"));

  const repeated = await runControlledPilotSession({ execute: true, sessionId: "repeated", outRoot: tempRoot }, {
    ...common,
    loadHistoricalRecordingIds: async () => ["recording-old"],
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => precisionResult({ recordingId: "recording-old" }),
  });
  assert.equal(repeated.sessionStatus, "aborted");
  assert.equal(repeated.pilotRunAccepted, false);
  assert(repeated.blockingReasons.includes("pilot-reused-recording:recording-old"));

  const unknown = await runControlledPilotSession({ execute: true, sessionId: "unknown", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => precisionResult({ unknown: 2 }),
  });
  assert.equal(unknown.sessionStatus, "paused_targeted_review");
  assert.equal(unknown.pilotRunAccepted, false);
  assert(unknown.blockingReasons.includes("pilot-unknown-auto-pass-needs-targeted-review:2"));

  const knownWrong = await runControlledPilotSession({ execute: true, sessionId: "known-wrong", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => precisionResult({ knownWrong: 1 }),
  });
  assert.equal(knownWrong.sessionStatus, "aborted_known_wrong");
  assert.equal(knownWrong.pilotRunAccepted, false);
  assert(knownWrong.blockingReasons.includes("pilot-known-wrong-auto-pass:1"));

  const failed = await runControlledPilotSession({ execute: true, sessionId: "failed", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => approvedPreflight(),
    runPrecisionSession: async () => {
      process.env[ENABLE_ENV] = "1";
      throw new Error("simulated failure");
    },
  });
  assert.equal(failed.sessionStatus, "failed");
  assert.equal(failed.pilotRunAccepted, false);
  assert.equal(process.env[ENABLE_ENV], undefined, "runner must restore the environment after failures");
  assert.equal(failed.defaultRuntimeFailClosedAfter, true);

  const safeJson = JSON.parse(await fs.readFile(path.join(tempRoot, "safe", "session.json"), "utf8"));
  assert.equal(safeJson.sessionStatus, "completed_safe");
  assert.equal(safeJson.postExecutionEvidenceRefresh.ok, true);
  const safeMarkdown = await fs.readFile(path.join(tempRoot, "safe", "session.md"), "utf8");
  assert(safeMarkdown.includes("- postExecutionEvidenceRefreshReady: true"));
} finally {
  if (oldEnable === undefined) delete process.env[ENABLE_ENV];
  else process.env[ENABLE_ENV] = oldEnable;
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "dry-run-never-executes",
    "missing-approval-blocks",
    "ordinary-only-executor-keeps-combined-session-closed",
    "missing-m3plus-executor-blocks-before-execution",
    "aggregate-executor-readiness-must-be-explicitly-green",
    "same-function-executors-block-before-execution",
    "executor-contracts-must-be-exact-and-distinct",
    "parent-enabled-env-blocks",
    "safe-session-runs-and-passes-both-executors",
    "post-execution-evidence-refresh-is-required",
    "invalid-m3plus-result-contracts-abort",
    "invalid-ordinary-result-aborts",
    "raw-model-auto-pass-is-suppressed-unless-self-checked",
    "self-check-accounting-mismatch-aborts",
    "historical-recordings-are-excluded",
    "precheck-rejections-are-persisted-as-exclusions",
    "zero-candidate-infrastructure-failure-does-not-consume-recording",
    "explicitly-invalidated-evidence-does-not-consume-recording",
    "requested-recording-is-forwarded-and-enforced",
    "repeated-recording-aborts",
    "unknown-auto-pass-pauses-for-targeted-review",
    "known-wrong-auto-pass-aborts",
    "failure-restores-environment",
    "session-artifact-written",
  ],
}, null, 2));
