import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { auditM4bDataset, evaluateM4bDataset } from "./audit-western-m4b-dataset.mjs";

const config = JSON.parse(await fs.readFile("config/western-m4b-dataset.json", "utf8"));
const report = JSON.parse(await fs.readFile("data/experiments/western-strings-m4b/dataset/report.json", "utf8"));
const manifest = JSON.parse(await fs.readFile(report.manifest, "utf8"));
const baseline = evaluateM4bDataset({ config, manifest, report });
assert.equal(baseline.ready, true, baseline.blockingReasons.join(", "));

for (const [label, mutate, reason] of [
  ["split drift", (row) => { row.config.synthetic.splitsByVariant.train = 11; }, "m4b-synthetic-split-policy-drift"],
  ["source gold leak", (row) => { row.manifest.frozenSourceGoldRows[0].trainingEligible = true; }, "m4b-source-gold-training-leak"],
  ["screen leak", (row) => { row.manifest.frozenScreenPhotoRows[0].trainingEligible = true; }, "m4b-screen-photo-training-leak"],
  ["synthetic row removed", (row) => { row.manifest.syntheticRows.pop(); }, "m4b-synthetic-row-count-mismatch"],
  ["discipline removed", (row) => { row.report.discipline.freshBlindTrainingEligible = true; }, "m4b-dataset-discipline-missing"],
]) {
  const fixture = {
    config: structuredClone(config),
    manifest: structuredClone(manifest),
    report: structuredClone(report),
  };
  mutate(fixture);
  const result = evaluateM4bDataset(fixture);
  assert.equal(result.ready, false, label);
  assert(result.blockingReasons.includes(reason), `${label}: ${reason}`);
}

const live = await auditM4bDataset();
assert.equal(live.ready, true, live.blockingReasons.join(", "));
assert.equal(live.counts.synthetic, 60);
assert.deepEqual(live.counts.syntheticSplits, { train: 36, calibration: 12, "synthetic-test": 12 });
assert.equal(live.counts.frozenSourceGoldTestOnly, 5);
assert.equal(live.counts.frozenScreenPhotoTestOnly, 8);
assert.equal(live.realAnnotationTargetReady, false);
assert.equal(live.freshBlindReady, false);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "sixty-synthetic-structure-pages-live-hash-verified",
    "train-calibration-synthetic-test-split-frozen",
    "five-source-gold-and-eight-screen-photos-test-only",
    "m4a-success-and-active-learning-roles-separated",
    "fresh-blind-never-training-eligible",
    "real-and-fresh-blind-gaps-remain-explicit",
  ],
}, null, 2));
