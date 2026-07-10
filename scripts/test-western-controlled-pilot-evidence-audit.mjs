import assert from "node:assert/strict";

import { evaluateControlledPilotEvidence } from "./audit-western-controlled-pilot-evidence.mjs";

const predictionRows = [];
for (let index = 0; index < 20; index += 1) {
  predictionRows.push({
    recordingId: `recording-${index % 2}`,
    teacherCandidateStatus: index < 18 ? "usable" : "wrong",
    probabilityUsable: "0.97",
    measureIndex: "1",
  });
}
predictionRows.push({
  recordingId: "known-bad",
  teacherCandidateStatus: "wrong",
  probabilityUsable: "0.99",
});

const release = {
  threshold: 0.8,
  runtimePolicy: {
    controlledPilotScope: {
      scopeName: "first-measure-only",
      maxMeasureIndex: 1,
      minConfidence: 0.95,
    },
  },
  blindValidation: {
    excludedKnownBadSources: [{ recordingId: "known-bad" }],
  },
};

const operationalCandidateRows = predictionRows.slice(0, 20).map((row) => ({
  confidenceProbability: row.probabilityUsable,
  teacherCandidateStatus: row.teacherCandidateStatus,
  measureIndex: row.measureIndex,
}));

function projectStatus({ coverage = 0.25, ready = true, recordings = 5 } = {}) {
  return {
    controlledPilotEvidence: {
      completedSafeSessionCount: 2,
      safeDistinctRecordingCount: recordings,
      safeDistinctPieceCount: 2,
      totalCandidateCount: 20,
      modelAutoPassCandidateCount: 12,
      pilotEligibleAutoPassCandidateCount: Math.round(20 * coverage),
      suppressedModelAutoPassCandidateCount: 12 - Math.round(20 * coverage),
      v2AlphaGate: {
        precision: 1,
        coverage,
        meetsPrecisionFloor: true,
        meetsCoverageFloor: coverage >= 0.2,
        hasCrossPieceEvidence: true,
        ready,
      },
    },
  };
}

const runtimeScopeSmoke = {
  ok: true,
  defaultOrdinaryReadyAfter: false,
  batchItem: {
    candidateGate: {
      controlledPilotScope: { scopeName: "first-measure-only" },
    },
  },
};

const passing = evaluateControlledPilotEvidence({
  predictionRows,
  operationalCandidateRows,
  runtimeScopeSmoke,
  release,
  projectStatus: projectStatus(),
});
assert.equal(passing.historicalLoro.scoredRows, 20, "known-bad recording must be excluded");
assert.equal(passing.historicalLoro.releaseOperatingPoint.precision, 0.9);
assert.equal(passing.historicalLoro.releaseOperatingPoint.coverage, 1);
assert.equal(passing.machinePreflightPassed, true);
assert.equal(passing.teacherReviewAllowed, true);
assert.equal(passing.thresholdDiagnostic.simpleThresholdCandidateFound, true);
assert.equal(passing.scopedV2AlphaCandidate.machineGatePassed, true);
assert.equal(passing.scopedV2AlphaCandidate.teacherReviewAllowed, true);

const coverageBlocked = evaluateControlledPilotEvidence({
  predictionRows,
  operationalCandidateRows,
  release,
  runtimeScopeSmoke,
  projectStatus: projectStatus({ coverage: 0.1, ready: false, recordings: 2 }),
});
assert.equal(coverageBlocked.historicalLoro.machineGatePassed, true);
assert.equal(coverageBlocked.operationalPilot.machineGatePassed, false);
assert.equal(coverageBlocked.teacherReviewAllowed, false);
assert.equal(coverageBlocked.scopedV2AlphaCandidate.runtimeScopeWired, true);
assert.equal(coverageBlocked.scopedV2AlphaCandidate.enoughOperationalRecordingsForProfessionalAudit, false);
assert(coverageBlocked.blockingReasons.includes("controlled-pilot-coverage-below-floor"));
assert(coverageBlocked.nextAction.startsWith("Do not request teacher review"));

console.log(JSON.stringify({
  ok: true,
  checks: [
    "known-bad-recording-excluded",
    "historical-loro-floor-enforced",
    "operational-coverage-floor-enforced",
    "first-measure-scope-is-reported-separately",
    "teacher-review-blocked-until-machine-gate-passes",
  ],
}, null, 2));
