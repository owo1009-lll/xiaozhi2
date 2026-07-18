import assert from "node:assert/strict";

import { evaluateProjectGate } from "./gate-western-strings-project.mjs";
import {
  M4A_GATE_SPLIT_DECISION,
  evaluateM4aGateSplitDecision,
} from "./m4a-supported-edition-governance.mjs";

const signedDecision = {
  decision: M4A_GATE_SPLIT_DECISION,
  approved: true,
  decidedBy: "guanxingzhi (project owner)",
  decidedAt: "2026-07-19T00:00:00+08:00",
  projectGateBinding: "m4a-supported-edition-registration",
  m4bOpenWorldOmrAutomaticAdoptionReady: false,
  confirmM4aDoesNotAuthorizeOpenWorldOmr: true,
  confirmStudentRuntimeRemainsFailClosed: true,
};

assert.equal(evaluateM4aGateSplitDecision(signedDecision).ready, true);

for (const [label, mutate, expectedReason] of [
  ["missing approval", (row) => { delete row.approved; }, "m4a-gate-split-not-approved"],
  ["wrong contract", (row) => { row.decision = "wrong"; }, "m4a-gate-split-decision-contract-mismatch"],
  ["wrong binding", (row) => { row.projectGateBinding = "open-world-omr"; }, "m4a-gate-split-project-binding-mismatch"],
  ["open-world leak", (row) => { row.m4bOpenWorldOmrAutomaticAdoptionReady = true; }, "m4a-gate-split-open-world-omr-not-closed"],
  ["missing scope confirmation", (row) => { delete row.confirmM4aDoesNotAuthorizeOpenWorldOmr; }, "m4a-gate-split-scope-confirmation-missing"],
  ["missing runtime confirmation", (row) => { delete row.confirmStudentRuntimeRemainsFailClosed; }, "m4a-gate-split-runtime-confirmation-missing"],
  ["missing owner identity", (row) => { row.decidedBy = ""; }, "m4a-gate-split-owner-identity-missing"],
]) {
  const candidate = structuredClone(signedDecision);
  mutate(candidate);
  const result = evaluateM4aGateSplitDecision(candidate);
  assert.equal(result.ready, false, label);
  assert(result.blockingReasons.includes(expectedReason), `${label}: ${expectedReason}`);
}

const status = (overrides = {}) => ({
  tracks: {
    controlledCandidate: {
      ordinaryDynamicShadow: { studentGateReady: true, blockingReasons: [] },
    },
    m3plusPitchModes: {
      m3plusPitchSafetyReady: true,
      offlineEvidenceReady: true,
      reviewOnlyRuntimeWired: true,
      runtimeFoundationReady: true,
      runtimeAuditReady: true,
      authorizationReady: true,
      studentGateReady: true,
      blockingReasons: [],
    },
    m4Omr: {
      m4GateSplitDecisionReady: true,
      m4aSupportedEditionRegistrationReady: false,
      m4aBlockingReasons: ["m4a-supported-edition-registry-not-ready"],
      m4bOpenWorldOmrAutomaticAdoptionReady: false,
      m4OmrAutomaticAdoptionReady: false,
      m4HomrProductionPoolReady: true,
      automaticAdoptionBlockingReasons: ["m4b-open-world-omr-not-ready"],
      artifacts: {
        m4aGateSplitDecisionJson: "data/experiments/western-strings-m4a-gate-split-decision.json",
        m4aRegistrationAuditJson: "data/experiments/western-strings-m4a/registration-audit.json",
        independentBenchmarkJson: "data/experiments/western-strings-m4/independent-benchmark-audit.json",
      },
      ...overrides,
    },
  },
});

const pendingM4a = evaluateProjectGate(status(), new Set(["m4"]));
assert.equal(pendingM4a.projectReleaseReady, false);
assert.equal(pendingM4a.failures.length, 1);
assert.equal(pendingM4a.failures[0].track, "M4a supported-edition registration");
assert(!pendingM4a.failures.some((failure) => failure.track === "M4 OMR automatic adoption"));

const readyM4a = evaluateProjectGate(status({
  m4aSupportedEditionRegistrationReady: true,
  m4aBlockingReasons: [],
}), new Set(["m4"]));
assert.equal(readyM4a.projectReleaseReady, true);
assert.deepEqual(readyM4a.failures, []);

const unsignedSplit = evaluateProjectGate(status({
  m4GateSplitDecisionReady: false,
  m4aSupportedEditionRegistrationReady: true,
  m4aBlockingReasons: [],
}), new Set(["m4"]));
assert.equal(unsignedSplit.projectReleaseReady, false);
assert(unsignedSplit.failures.some((failure) => failure.track === "M4 OMR automatic adoption"));

console.log(JSON.stringify({
  ok: true,
  checks: [
    "signed-m4a-gate-split-contract",
    "decision-tamper-rejected",
    "m4a-not-ready-blocks-project-gate",
    "m4a-ready-can-satisfy-m4-required-track",
    "m4b-remains-independent-and-closed",
    "unsigned-split-retains-legacy-open-world-gate",
  ],
}, null, 2));
