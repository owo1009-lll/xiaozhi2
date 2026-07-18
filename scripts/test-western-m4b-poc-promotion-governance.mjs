import assert from "node:assert/strict";

import {
  M4B_POC_PROMOTION_DECISION,
  evaluateM4bPocPromotionDecision,
  loadM4bPocPromotionDecision,
} from "./m4b-poc-promotion-governance.mjs";

const signedDecision = {
  decision: M4B_POC_PROMOTION_DECISION,
  approved: true,
  decidedBy: "guanxingzhi (project owner)",
  decidedAt: "2026-07-19T01:28:31+08:00",
  promotionScope: "m4b-poc-to-expanded-investment-only",
  freshBlindMinimums: { pages: 30, piecesOrLayouts: 6, devices: 3 },
  thresholds: {
    measureBoxF1: 0.95,
    exactPageStructureRate: 0.8,
    structureConflictReviewRequiredRate: 1,
    meterRegionF1: 0.95,
  },
  confirmNoRetroactiveThresholdTuning: true,
  confirmThresholdFailureKeepsM4bResearchOnly: true,
  confirmDoesNotAuthorizeAutomaticAdoption: true,
  m4bOpenWorldOmrAutomaticAdoptionReady: false,
};

assert.equal(evaluateM4bPocPromotionDecision(signedDecision).ready, true);

for (const [label, mutate, expectedReason] of [
  ["wrong contract", (row) => { row.decision = "wrong"; }, "m4b-poc-promotion-decision-contract-mismatch"],
  ["missing approval", (row) => { delete row.approved; }, "m4b-poc-promotion-not-approved"],
  ["wrong scope", (row) => { row.promotionScope = "production"; }, "m4b-poc-promotion-scope-mismatch"],
  ["pages changed", (row) => { row.freshBlindMinimums.pages = 29; }, "m4b-poc-fresh-blind-pages-minimum-mismatch"],
  ["pieces changed", (row) => { row.freshBlindMinimums.piecesOrLayouts = 5; }, "m4b-poc-fresh-blind-piecesOrLayouts-minimum-mismatch"],
  ["devices changed", (row) => { row.freshBlindMinimums.devices = 2; }, "m4b-poc-fresh-blind-devices-minimum-mismatch"],
  ["measure threshold changed", (row) => { row.thresholds.measureBoxF1 = 0.94; }, "m4b-poc-measureBoxF1-threshold-mismatch"],
  ["page threshold changed", (row) => { row.thresholds.exactPageStructureRate = 0.79; }, "m4b-poc-exactPageStructureRate-threshold-mismatch"],
  ["conflict threshold changed", (row) => { row.thresholds.structureConflictReviewRequiredRate = 0.99; }, "m4b-poc-structureConflictReviewRequiredRate-threshold-mismatch"],
  ["meter threshold changed", (row) => { row.thresholds.meterRegionF1 = 0.94; }, "m4b-poc-meterRegionF1-threshold-mismatch"],
  ["retroactive tuning allowed", (row) => { row.confirmNoRetroactiveThresholdTuning = false; }, "m4b-poc-no-retroactive-tuning-confirmation-missing"],
  ["failure disposition absent", (row) => { delete row.confirmThresholdFailureKeepsM4bResearchOnly; }, "m4b-poc-failure-disposition-confirmation-missing"],
  ["automatic boundary absent", (row) => { delete row.confirmDoesNotAuthorizeAutomaticAdoption; }, "m4b-poc-automatic-adoption-boundary-missing"],
  ["automatic adoption opened", (row) => { row.m4bOpenWorldOmrAutomaticAdoptionReady = true; }, "m4b-poc-open-world-automatic-adoption-not-closed"],
  ["owner absent", (row) => { row.decidedBy = ""; }, "m4b-poc-owner-identity-missing"],
]) {
  const candidate = structuredClone(signedDecision);
  mutate(candidate);
  const result = evaluateM4bPocPromotionDecision(candidate);
  assert.equal(result.ready, false, label);
  assert(result.blockingReasons.includes(expectedReason), `${label}: ${expectedReason}`);
}

const live = await loadM4bPocPromotionDecision();
assert.equal(live.ready, true, live.blockingReasons.join(", "));
assert.match(live.sha256, /^[a-f0-9]{64}$/);
assert.equal(live.decision.m4bOpenWorldOmrAutomaticAdoptionReady, false);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "m4b-poc-thresholds-signed",
    "all-frozen-numbers-tamper-rejected",
    "thresholds-authorize-research-promotion-only",
    "open-world-automatic-adoption-remains-closed",
    "live-artifact-hash-recomputed",
  ],
  decisionSha256: live.sha256,
}, null, 2));
