import assert from "node:assert/strict";

import { evaluateIndependentReleaseEvidence } from "./run-western-m3plus-monitored-pilot-audit.mjs";

const stalePassOverride = evaluateIndependentReleaseEvidence({
  modes: {
    slide: {
      releaseReady: false,
      sampleGatePassed: true,
      physicalThreshold: 0.8,
      physicalThresholdAudit: { holdout: { precision: 1, recall: 0.75 } },
    },
  },
});
assert.equal(stalePassOverride.ready, false);
assert(stalePassOverride.blockingReasons.includes("m3plus-independent-mode-not-ready:slide-like"));
assert(stalePassOverride.blockingReasons.includes("m3plus-independent-mode-evidence-missing:trill-like"));
assert.equal(stalePassOverride.perMode["slide-like"].holdoutRecall, 0.75);

const completeIndependentPass = evaluateIndependentReleaseEvidence({
  modes: {
    slide: { releaseReady: true },
    trill: { releaseReady: true },
  },
});
assert.equal(completeIndependentPass.ready, true);
assert.deepEqual(completeIndependentPass.blockingReasons, []);

console.log("western M3+ monitored-pilot independent-evidence tests passed");
