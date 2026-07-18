import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  auditM4aEngineeringAcceptance,
  evaluateM4aEngineeringAcceptance,
} from "./audit-western-m4a-engineering-acceptance.mjs";

const report = JSON.parse(await fs.readFile(
  "data/experiments/western-strings-m4a/engineering-acceptance/report.json",
  "utf8",
));
assert.equal(evaluateM4aEngineeringAcceptance(report).ready, true);

for (const [label, mutate, reason] of [
  ["boundary removed", (row) => { row.doesNotSatisfyFrozenRealPhotoAcceptance = false; }, "m4a-engineering-real-acceptance-boundary-missing"],
  ["projection empty", (row) => { row.positives[0].feedbackProjection.mappedAnchorCount = 0; }, "m4a-engineering-feedback-projection-incomplete:positive-r2-01"],
  ["negative passed", (row) => { row.negatives[0].ready = true; }, "m4a-engineering-negative-not-blocked:negative-blurred"],
  ["OMR entered", (row) => { row.positives[0].omrUsed = true; }, "m4a-engineering-omr-used:positive-r2-01"],
  ["student release opened", (row) => { row.positives[0].studentFacing = true; }, "m4a-engineering-release-boundary-violated:positive-r2-01"],
]) {
  const candidate = structuredClone(report);
  mutate(candidate);
  const result = evaluateM4aEngineeringAcceptance(candidate);
  assert.equal(result.ready, false, label);
  assert(result.blockingReasons.includes(reason), `${label}: ${reason}`);
}

const live = await auditM4aEngineeringAcceptance();
assert.equal(live.ready, true, live.blockingReasons.join(", "));
assert.equal(live.doesNotSatisfyFrozenRealPhotoAcceptance, true);
assert.equal(live.summary.positivePassed, 3);
assert.equal(live.summary.negativeBlocked, 4);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "live-engineering-artifact-hashes-verified",
    "all-diagnostic-events-back-project-to-note-anchors",
    "synthetic-positive-and-negative-exits-verified",
    "omr-and-student-release-boundaries-enforced",
    "engineering-evidence-cannot-impersonate-real-photo-acceptance",
  ],
}, null, 2));
