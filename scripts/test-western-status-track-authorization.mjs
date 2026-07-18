#!/usr/bin/env node
// Tests for evaluateTrackAuthorizationFromApproval: proves that
// authorizationReady is driven exclusively by the owner's standing approval
// file (never by evidence/runtime readiness alone), and that every field the
// approval must carry is independently checked.
import assert from "node:assert/strict";

import { evaluateTrackAuthorizationFromApproval } from "./status-western-strings-project.mjs";

const SCOPE_CONTRACT = "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v2";

function validApproval(overrides = {}) {
  return {
    pilotApproved: true,
    approvedBy: "guanxingzhi (project owner)",
    approvedAt: "2026-07-18T14:31:55.062Z",
    approvedTracks: ["ordinary", "m3plus"],
    confirmSeparateMonitoredPilot: true,
    confirmDefaultRuntimeFailClosed: true,
    scopeContract: SCOPE_CONTRACT,
    ...overrides,
  };
}

// 1. A fully valid approval grants both tracks.
for (const track of ["ordinary", "m3plus"]) {
  const result = evaluateTrackAuthorizationFromApproval(validApproval(), track);
  assert.equal(result.ready, true, `a valid approval must grant ${track}: ${JSON.stringify(result.blockingReasons)}`);
  assert.deepEqual(result.blockingReasons, []);
}

// 2. No approval file at all (null/undefined) fails closed.
for (const missing of [null, undefined]) {
  const result = evaluateTrackAuthorizationFromApproval(missing, "ordinary");
  assert.equal(result.ready, false);
  assert(result.blockingReasons.includes("authorization-approval-missing"));
}

// 3. Evidence/runtime readiness alone (i.e. an approval-shaped object that
// was never actually granted) must not authorize anything.
const notGranted = evaluateTrackAuthorizationFromApproval(validApproval({ pilotApproved: false }), "ordinary");
assert.equal(notGranted.ready, false);
assert(notGranted.blockingReasons.includes("authorization-approval-not-granted"));

// 4. A stale scope-contract version (methodology changed since approval) fails closed.
const staleScope = evaluateTrackAuthorizationFromApproval(
  validApproval({ scopeContract: "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v1" }),
  "ordinary",
);
assert.equal(staleScope.ready, false);
assert(staleScope.blockingReasons.includes("authorization-approval-scope-contract-stale"));

// 5. A track missing from approvedTracks fails closed, and the failure names
//    the specific missing track (not a generic message).
const missingTrack = evaluateTrackAuthorizationFromApproval(
  validApproval({ approvedTracks: ["ordinary"] }),
  "m3plus",
);
assert.equal(missingTrack.ready, false);
assert(missingTrack.blockingReasons.includes("authorization-approval-track-missing:m3plus"));
// ...but the track that IS named stays ready under the same approval object.
const namedTrackStillReady = evaluateTrackAuthorizationFromApproval(
  validApproval({ approvedTracks: ["ordinary"] }),
  "ordinary",
);
assert.equal(namedTrackStillReady.ready, true);

// 6. Missing safety confirmations fail closed individually.
for (const field of ["confirmSeparateMonitoredPilot", "confirmDefaultRuntimeFailClosed"]) {
  const result = evaluateTrackAuthorizationFromApproval(validApproval({ [field]: false }), "ordinary");
  assert.equal(result.ready, false);
  assert(result.blockingReasons.includes(`authorization-approval-confirmation-missing:${field}`));
}

// 7. Missing owner identity (approvedBy/approvedAt) fails closed: a forged
// approval that got every field right but never attributed a real owner
// cannot pass.
for (const field of ["approvedBy", "approvedAt"]) {
  const result = evaluateTrackAuthorizationFromApproval(validApproval({ [field]: "" }), "ordinary");
  assert.equal(result.ready, false);
  assert(result.blockingReasons.includes("authorization-approval-identity-missing"));
}

// 8. A completely empty approvedTracks array blocks every track.
const emptyTracks = evaluateTrackAuthorizationFromApproval(validApproval({ approvedTracks: [] }), "ordinary");
assert.equal(emptyTracks.ready, false);
assert(emptyTracks.blockingReasons.includes("authorization-approval-track-missing:ordinary"));

// 9. approvedTracks not even an array fails closed rather than throwing.
const malformedTracks = evaluateTrackAuthorizationFromApproval(validApproval({ approvedTracks: "ordinary" }), "ordinary");
assert.equal(malformedTracks.ready, false);
assert(malformedTracks.blockingReasons.includes("authorization-approval-track-missing:ordinary"));

// 10. Multiple simultaneous defects are all reported, not just the first.
const multiDefect = evaluateTrackAuthorizationFromApproval(
  validApproval({ pilotApproved: false, confirmSeparateMonitoredPilot: false, approvedTracks: [] }),
  "ordinary",
);
assert.equal(multiDefect.ready, false);
assert(multiDefect.blockingReasons.includes("authorization-approval-not-granted"));
assert(multiDefect.blockingReasons.includes("authorization-approval-confirmation-missing:confirmSeparateMonitoredPilot"));
assert(multiDefect.blockingReasons.includes("authorization-approval-track-missing:ordinary"));

console.log("ok - western track authorization (approval-driven, never evidence-driven; every field independently checked)");
