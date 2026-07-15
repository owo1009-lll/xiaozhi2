import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadHistoricalRecordingIds,
  runControlledPilotSession,
} from "./run-western-controlled-pilot-session.mjs";

const ENABLE_ENV = "WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE";

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
    blockingReasons: ["controlled-pilot-approval-missing"],
    decision: { approvalPresent: false, approval: null },
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
  const common = {
    outRoot: tempRoot,
    refreshReleaseReview: async () => ({ ok: true }),
    buildStatus: async () => statusFailClosed(),
    loadHistoricalRecordingIds: async () => [],
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

  const noApproval = await runControlledPilotSession({ execute: true, sessionId: "no-approval", outRoot: tempRoot }, {
    ...common,
    buildPreflight: async () => blockedPreflight(),
    runPrecisionSession: async () => { calls += 1; return precisionResult(); },
  });
  assert.equal(noApproval.sessionStatus, "blocked");
  assert.equal(noApproval.executionPerformed, false);
  assert(noApproval.blockingReasons.includes("controlled-pilot-approval-missing"));
  assert.equal(calls, 0, "missing approval must not execute the pilot batch");

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
  assert.equal(safe.monitoring.knownUsableAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.modelAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.pilotEligibleAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.scopedAutoPassCandidateCount, 3);
  assert.equal(safe.monitoring.suppressedModelAutoPassCandidateCount, 0);
  assert.equal(safe.monitoring.reviewRequiredCandidateCount, 5);
  assert.equal(safe.defaultRuntimeFailClosedAfter, true);
  assert.equal(safe.processEnvironmentRestored, true);
  assert.equal(process.env[ENABLE_ENV], undefined);

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
    "parent-enabled-env-blocks",
    "safe-session-completes",
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
