import assert from "node:assert/strict";

import { auditAppendixC, evaluateAppendixC } from "./audit-western-appendix-c.mjs";


const live = await auditAppendixC();
assert.equal(live.auditComplete, true);
assert.equal(live.engineeringComplete, true, JSON.stringify(live.engineeringBlockingReasons));
assert.equal(live.appendixAcceptanceComplete, false);
assert.equal(live.m4a.realPhotoFlowOperationalReady, true);
assert.equal(live.m4a.realPhotoAcceptanceReady, true);
assert.equal(live.m4b.structurePocEngineeringReady, true);
assert.equal(live.m4b.promotionOperationalReady, true);
assert.equal(live.m4b.promotionReady, false);
assert.equal(live.m4b.realAnnotationTargetBlocksPocPromotion, false);
assert.equal(live.runtimeBoundary.failClosed, true);
assert.ok(!live.externalBlockingReasons.some((reason) => String(reason).startsWith("m4a-")));
assert.ok(live.externalBlockingReasons.includes("m4b-fresh-blind-intake-missing"));

const completed = structuredClone(live);
const syntheticStatus = {
  tracks: { m4Omr: { m4bOpenWorldOmrAutomaticAdoptionReady: false, m4bPocBlockingReasons: [] } },
  runtimeStudentGate: { m4OmrAutoScoreReady: false },
};
const documents = {
  projectPlan: "### C.1 闸门拆分\n### C.2 M4a 详细方案\n#### C.2.6 谱库规模化扩充计划\n#### C.2.7 负责人教材曲目总清单\n### C.3 M4b 详细方案\n#### C.3.3 晋升门槛\n### C.4 决策清单\nsynthetic-engineering\nm4b-fresh-blind-capture-pack\n~600–750 条目/乐章",
  projectStatus: "m4bStructurePocEngineeringReady=true m4bStructurePocPromotionReady=false m4aSupportedEditionRegistrationReady=true m4b-fresh-blind-capture-pack",
};
const baselineInput = {
  status: syntheticStatus,
  decisions: { m4aGateSplit: { ready: true }, m4bThresholds: { ready: true } },
  m4a: {
    registry: { ready: true, validEntries: 3 },
    runtime: { ready: true },
    engineering: { ready: true },
    realPhoto: { operationalReady: true, ready: true, blockingReasons: [] },
  },
  m4b: {
    dataset: { ready: true, realAnnotationTargetReady: false },
    freshBlind: { operationalReady: true, ready: true },
    structurePoc: {
      engineeringReady: true,
      promotionOperationalReady: true,
      promotionReady: true,
      promotionBlockingReasons: [],
      boundary: { automaticAdoptionAuthorized: false, studentFacing: false },
    },
  },
  ...documents,
};
const accepted = evaluateAppendixC(baselineInput);
assert.equal(accepted.engineeringComplete, true);
assert.equal(accepted.appendixAcceptanceComplete, true);

const circular = structuredClone(baselineInput);
circular.status.tracks.m4Omr.m4bPocBlockingReasons = ["m4b-real-structure-labels-below-100"];
const circularResult = evaluateAppendixC(circular);
assert.ok(circularResult.engineeringBlockingReasons.includes("appendix-c-circular-real-label-promotion-blocker-reintroduced"));

const unsafe = structuredClone(baselineInput);
unsafe.status.tracks.m4Omr.m4bOpenWorldOmrAutomaticAdoptionReady = true;
const unsafeResult = evaluateAppendixC(unsafe);
assert.ok(unsafeResult.engineeringBlockingReasons.includes("appendix-c-m4b-safety-boundary-open"));

assert.equal(completed.engineeringComplete, true);
console.log("western appendix c audit tests passed");
