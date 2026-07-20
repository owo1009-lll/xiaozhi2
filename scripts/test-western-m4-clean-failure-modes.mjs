#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  buildCleanFailureModeAudit,
} from "./audit-western-m4-clean-failure-modes.mjs";

const summary = {
  pieces: [
    { piece: "full-pass", pitchPrecision: 0.99, pitchRecall: 0.96 },
    { piece: "pitch-pass-structure-fail", pitchPrecision: 0.99, pitchRecall: 0.96 },
    { piece: "both-pitch-fail", pitchPrecision: 0.97, pitchRecall: 0.94 },
  ],
};
const rows = [
  {
    piece: "full-pass", status: "ok", onsetQuarterAccuracy: 0.99,
    measureAccuracy: 0.99, missingRate: 0.01, extraRate: 0.01,
  },
  {
    piece: "pitch-pass-structure-fail", status: "ok", onsetQuarterAccuracy: 0.2,
    measureAccuracy: 0.3, missingRate: 0.01, extraRate: 0.01,
  },
  {
    piece: "both-pitch-fail", status: "ok", onsetQuarterAccuracy: 0.99,
    measureAccuracy: 0.99, missingRate: 0.03, extraRate: 0.03,
  },
];

const report = buildCleanFailureModeAudit({ ...summary }, { rows, aggregate: { metrics: {} } });
assert.equal(report.aggregate.pieceCount, 3);
assert.equal(report.aggregate.pitchStrictPassed, 2);
assert.equal(report.aggregate.pitchStrictStructureFailed, 1);
assert.equal(report.aggregate.completeFourMetricPassed, 1);
assert.equal(report.aggregate.completeSixMetricPassed, 1);
assert.deepEqual(report.aggregate.pitchFailureModes, {
  passed: 2,
  "precision-only": 0,
  "recall-only": 0,
  "precision-and-recall": 1,
});
assert.equal(report.interpretation.structureReconstructionDeficitPresentInCleanDomain, true);
assert.equal(report.interpretation.geometryOnlyHypothesisSupported, false);
assert.equal(report.studentGateReady, false);

assert.throws(
  () => buildCleanFailureModeAudit(summary, { rows: rows.slice(0, 2) }),
  /clean-note-audit-row-missing:both-pitch-fail/,
);

console.log(JSON.stringify({ ok: true, checks: [
  "failure-mode-counts",
  "clean-structure-deficit",
  "student-boundary",
  "missing-row-rejected",
] }));
