import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runControlledPilotSession } from "./run-western-controlled-pilot-session.mjs";

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

function precisionResult({ knownWrong = 0, unknown = 0, ok = true } = {}) {
  return {
    summary: {
      ok,
      selectedSubmissionCount: 1,
      totalCandidateCount: 8,
      autoPassCandidateCount: 3,
      selfCheckedAutoPassCandidateCount: 3,
      knownUsableAutoPassCandidateCount: Math.max(0, 3 - knownWrong),
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
  };

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
  assert.equal(safe.defaultRuntimeFailClosedAfter, true);
  assert.equal(safe.processEnvironmentRestored, true);
  assert.equal(process.env[ENABLE_ENV], undefined);

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
    "unknown-auto-pass-pauses-for-targeted-review",
    "known-wrong-auto-pass-aborts",
    "failure-restores-environment",
    "session-artifact-written",
  ],
}, null, 2));
