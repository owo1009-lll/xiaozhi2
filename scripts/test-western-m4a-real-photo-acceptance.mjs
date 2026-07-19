import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  auditM4aRealPhotoAcceptance,
  evaluateM4aRealPhotoAcceptance,
} from "./audit-western-m4a-real-photo-acceptance.mjs";

const config = JSON.parse(await fs.readFile("config/western-m4a-real-photo-acceptance.json", "utf8"));
const safe = {
  omrUsed: false,
  reviewRequired: true,
  studentFacing: false,
  automaticAdoptionAuthorized: false,
  autoDiagnosisIssued: false,
};
const positives = config.positiveCaptureTasks.map((task) => ({
  caseId: task.caseId,
  available: true,
  ready: true,
  projectedCounts: { notes: 1, measures: 1 },
  feedbackProjection: { ready: true, expectedAnchorCount: 1, mappedAnchorCount: 1 },
  measureReviewOverlay: `overlay/${task.caseId}.jpg`,
  measureReviewOverlaySha256: "a".repeat(64),
  ...safe,
}));
const wrongRows = config.wrongEditionCases.map((task) => ({
  caseId: task.caseId,
  available: true,
  ready: false,
  blocked: true,
  ...safe,
}));
const poorRows = config.positiveCaptureTasks.flatMap((task) => (
  config.thresholds.requiredPoorImageTransforms.map((transform) => ({
    caseId: `${task.caseId}:${transform}`,
    transform,
    ready: false,
    blocked: true,
    ...safe,
  }))
));
const ideal = {
  contract: "western-m4a-real-photo-acceptance-v1",
  complete: true,
  acceptanceReady: true,
  evidenceClass: config.evidenceClass,
  thresholds: structuredClone(config.thresholds),
  safety: structuredClone(config.safety),
  checks: {
    positivePhotoCount: true,
    positivePassRate: true,
    ownerMeasureBoxConfirmation: true,
    wrongEditionCount: true,
    wrongEditionLeakCount: true,
    poorImageCoverage: true,
    poorImageLeakCount: true,
    reviewOnlySafety: true,
  },
  blockingReasons: [],
  positiveCases: positives,
  wrongEditionCases: wrongRows,
  poorImageCases: poorRows,
  summary: {
    positiveAvailable: 10,
    positivePassed: 10,
    positivePassRate: 1,
    wrongEditionAvailable: 8,
    wrongEditionBlocked: 8,
    wrongEditionLeakCount: 0,
    poorImageEvaluated: 20,
    poorImageBlocked: 20,
    poorImageLeakCount: 0,
  },
};
const idealEvaluation = evaluateM4aRealPhotoAcceptance({ config, report: ideal });
assert.equal(idealEvaluation.operationalReady, true, idealEvaluation.integrityBlockingReasons.join(", "));
assert.equal(idealEvaluation.acceptanceReady, true);

for (const [label, mutate, reason] of [
  ["threshold drift", (fixture) => { fixture.config.thresholds.minimumPositivePhotos = 9; }, "m4a-real-photo-threshold-drift"],
  ["wrong edition leak", (fixture) => { fixture.report.wrongEditionCases[0].blocked = false; }, "m4a-real-photo-wrong-edition-summary-mismatch"],
  ["projection missing", (fixture) => { fixture.report.positiveCases[0].feedbackProjection.mappedAnchorCount = 0; }, "m4a-real-photo-positive-projection-incomplete:m4a-positive-01"],
  ["student release opened", (fixture) => { fixture.report.positiveCases[0].studentFacing = true; }, "m4a-real-photo-safety-row-violated:m4a-positive-01"],
  ["ready forged", (fixture) => { fixture.report.checks.ownerMeasureBoxConfirmation = false; }, "m4a-real-photo-ready-summary-mismatch"],
]) {
  const fixture = { config: structuredClone(config), report: structuredClone(ideal) };
  mutate(fixture);
  const result = evaluateM4aRealPhotoAcceptance(fixture);
  assert.equal(result.operationalReady, false, label);
  assert(result.integrityBlockingReasons.includes(reason), `${label}: ${reason}`);
}

const live = await auditM4aRealPhotoAcceptance();
assert.equal(live.operationalReady, true, live.integrityBlockingReasons.join(", "));
assert.equal(live.summary.wrongEditionAvailable, 8);
assert.equal(live.summary.wrongEditionBlocked, 8);
if (live.summary.positiveAvailable === 0) {
  assert.equal(live.ready, false, "real-photo gate must remain closed before owner capture");
  assert(live.blockingReasons.includes("m4a-real-photo-positive-missing:10"));
} else {
  assert.equal(live.summary.positiveAvailable, 10);
  assert.equal(live.summary.positivePassed, 10);
  assert.equal(live.summary.poorImageEvaluated, 20);
  assert.equal(live.summary.poorImageBlocked, 20);
  assert.equal(live.summary.poorImageLeakCount, 0);
  assert(!live.blockingReasons.includes("m4a-real-photo-poor-image-leak-detected"));
}

const capturePack = await fs.readFile("docs/m4a-real-photo-capture-pack/index.html", "utf8");
for (const task of config.positiveCaptureTasks) assert(capturePack.includes(task.caseId));

console.log(JSON.stringify({
  ok: true,
  checks: [
    "frozen-ten-photo-and-0.90-thresholds-enforced",
    "owner-measure-confirmation-required-at-one",
    "eight-real-wrong-edition-screen-photos-blocked",
    "poor-image-and-safety-gates-fail-closed",
    "capture-pack-covers-all-ten-positive-tasks",
    "live-gate-supports-absent-or-complete-private-photo-evidence",
  ],
}, null, 2));
