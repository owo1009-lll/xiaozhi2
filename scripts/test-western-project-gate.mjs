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

const controlled = status.tracks.controlledCandidate;
assert.equal(controlled.studentSafeCandidateGateReady, false, "ordinary upload must still require blind validation");
assert.equal(controlled.confidencePilot?.releaseCandidateFound, true, "confidence pilot should report release candidates");
assert.equal(controlled.confidencePilot?.needsBlindValidation, true, "confidence pilot should require blind validation");
assert.equal(controlled.confidencePilot?.readyForStudentGate, false, "eval-only confidence pilot must not mark runtime gate ready");
assert(controlled.confidencePilot?.bestReleaseCandidate, "confidence pilot should report the best release candidate");
assert(controlled.blockingReasons.includes("candidate-confidence-pilot-needs-blind-validation"), "ordinary upload should block on blind validation after pilot success");
assert(status.nextActions[0]?.action.includes("Confidence pilot"), "project next action should route to blind validation of the confidence pilot");

const m4 = status.tracks.m4Omr;
assert.equal(m4.m4OmrBenchmarkDatasetReady, true, "M4 intake dataset should be ready for benchmarking");
assert.equal(m4.m4OmrDraftQualityReady, false, "M4 draft quality must not be ready while gold equals draft");
assert.equal(m4.counts.usableBenchmarkRows, 0, "self-comparison rows must not count as usable independent gold");
assert.equal(m4.counts.selfComparisonRows, 12, "current M4 fixture should expose all self-comparison rows");
assert(m4.blockingReasons.includes("m4-omr-self-comparison-detected"), "M4 must block on self-comparison");
assert(m4.blockingReasons.includes("m4-omr-no-independent-gold"), "M4 must block when independent gold is missing");

const noRequiredGate = evaluateProjectGate(status, new Set());
assert.equal(noRequiredGate.projectReleaseReady, true, "empty required track set should not block");
assert.deepEqual(noRequiredGate.failures, [], "empty required track set should have no failures");

const fullGate = evaluateProjectGate(status, new Set(["ordinary", "m3plus", "m4"]));
assert.equal(fullGate.projectReleaseReady, false, "full project gate must block until all required tracks are ready");
assert(fullGate.failures.some((failure) => failure.track === "M2/M3 ordinary upload candidate gate"), "ordinary track failure should be reported");
assert(fullGate.failures.some((failure) => failure.track === "M3+ pitch behavior modes"), "M3+ track failure should be reported");
assert(fullGate.failures.some((failure) => failure.track === "M4 OMR benchmark"), "M4 track failure should be reported");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "project-status-tracks-present",
    "student-runtime-fail-closed",
    "confidence-pilot-needs-blind-validation",
    "m4-self-comparison-blocks",
    "project-gate-required-tracks-block-release",
  ],
}, null, 2));
