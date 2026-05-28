import assert from "node:assert/strict";

import { buildOmrQualityGate, normalizeOmrStats } from "../src/server/omrStats.js";
import { needsPartReview } from "../src/student/studentStatus.js";

const safeCandidate = {
  label: "Erhu",
  selectedPartConfidence: 0.86,
  staffCount: 1,
  chordRatio: 0,
  isLikelyPiano: false,
};

const cleanGate = buildOmrQualityGate({
  omrStatus: "completed",
  omrConfidence: 0.9,
  omrStats: { mode: "pagewise", pageCount: 4, resultCount: 4 },
  selectedPartConfidence: 0.96,
  scoreLineStats: { noteCount: 120, erhuRatio: 0.8, erhuPageCoverage: 1, unknownNoteCount: 0 },
  partCandidates: [safeCandidate],
  sectionCount: 8,
});
assert.equal(cleanGate.status, "pass");
assert.deepEqual(cleanGate.reasons, []);

const missingPageGate = buildOmrQualityGate({
  omrStatus: "completed",
  omrConfidence: 0.9,
  omrStats: { mode: "pagewise", pageCount: 10, resultCount: 8 },
  selectedPartConfidence: 0.96,
  scoreLineStats: { noteCount: 120, erhuRatio: 0.8, erhuPageCoverage: 0.9, unknownNoteCount: 0 },
  partCandidates: [safeCandidate],
  sectionCount: 8,
});
assert.equal(missingPageGate.status, "block");
assert.ok(missingPageGate.reasons.includes("page-result-coverage-low"));

const wrongLineGate = buildOmrQualityGate({
  omrStatus: "completed",
  omrConfidence: 0.9,
  omrStats: { mode: "pagewise", pageCount: 8, resultCount: 8 },
  selectedPartConfidence: 0.82,
  scoreLineStats: { noteCount: 120, erhuRatio: 0.25, erhuPageCoverage: 0.5, unknownNoteCount: 0 },
  partCandidates: [safeCandidate],
  sectionCount: 8,
});
assert.equal(wrongLineGate.status, "block");
assert.ok(wrongLineGate.reasons.includes("low-selected-part-confidence"));
assert.ok(wrongLineGate.reasons.includes("low-erhu-line-coverage"));

const badPartGate = buildOmrQualityGate({
  omrStatus: "completed",
  omrConfidence: 0.9,
  omrStats: { mode: "whole-pdf", pageCount: 1, resultCount: 1 },
  selectedPartConfidence: 0.86,
  scoreLineStats: { noteCount: 60, erhuRatio: 0.8, erhuPageCoverage: 1, unknownNoteCount: 0 },
  partCandidates: [{ ...safeCandidate, isLikelyPiano: true }],
  sectionCount: 4,
});
assert.equal(badPartGate.status, "block");
assert.ok(badPartGate.reasons.includes("unsafe-selected-part"));

const preservedStats = normalizeOmrStats({
  mode: "pagewise",
  pageCount: 2,
  resultCount: 2,
  providerCandidates: [{ provider: "homr", role: "secondary-candidate", status: "available" }],
  secondaryProviderRecommended: true,
  secondaryProviderRecommendation: { recommended: true, provider: "homr", reasons: ["low-omr-confidence"] },
  qualityGate: wrongLineGate,
});
assert.equal(preservedStats.providerCandidates[0].provider, "homr");
assert.equal(preservedStats.secondaryProviderRecommendation.recommended, true);
assert.equal(preservedStats.qualityGate.status, "block");

assert.equal(
  needsPartReview(
    { omrStatus: "completed", omrQualityGate: wrongLineGate },
    { omrStatus: "completed" },
  ),
  true,
);

console.log(JSON.stringify({
  ok: true,
  checks: ["clean-pass", "page-coverage-block", "line-quality-block", "part-safety-block", "student-review-guard"],
}, null, 2));
