import assert from "node:assert/strict";

import {
  DEFAULT_THRESHOLDS,
  evaluateIndependentBenchmark,
} from "./audit-western-strings-m4-independent-benchmark.mjs";

function summary(count, precision, recall) {
  return {
    pieces: Array.from({ length: count }, (_, index) => ({
      piece: `piece-${index + 1}`,
      status: "ok",
      pitchPrecision: precision,
      pitchRecall: recall,
    })),
  };
}

function realPhotoSummary(count, precision, recall) {
  return {
    counts: { pitchPrecision: precision, pitchRecall: recall },
    rows: Array.from({ length: count }, (_, index) => ({
      pieceId: `photo-${index + 1}`,
      parseOk: true,
      benchmarkUsable: true,
      goldProvenance: "independent-source-derived-gold",
      goldSourceVerified: "yes",
      pitchPrecision: precision,
      pitchRecall: recall,
    })),
  };
}

const good = evaluateIndependentBenchmark({
  clean: summary(32, 0.97, 0.94),
  scan: summary(6, 0.94, 0.89),
  photo: summary(6, 0.95, 0.89),
  realPhotoConsistency: { caveat: "not independent", byVariant: { up2: { n: 12 } } },
  confidenceProbe: { safeSubsetReady: false, validation: "leave-one-work-out" },
});
assert.equal(good.independentBenchmarkReady, true, "independent render/scan/photo evidence should pass its research floor");
assert.equal(good.automaticAdoptionReady, false, "missing independent real-photo gold must keep automatic adoption closed");
assert.equal(good.studentGateReady, false, "an eval-only benchmark must never open the student runtime gate");
assert(good.automaticAdoptionBlockingReasons.includes("m4-real-photo-independent-gold-missing"));
assert(good.automaticAdoptionBlockingReasons.includes("m4-runtime-safe-subset-not-found"));
assert.equal(good.realPhotoConsistency.independentAccuracyEvidence, false);

const realPhotoPoor = evaluateIndependentBenchmark({
  clean: summary(32, 0.97, 0.94),
  scan: summary(6, 0.94, 0.89),
  photo: summary(6, 0.95, 0.89),
  realPhotoGold: realPhotoSummary(5, 0.86, 0.63),
  confidenceProbe: { safeSubsetReady: true },
});
assert.equal(realPhotoPoor.independentRealPhotoRows, 5);
assert.equal(realPhotoPoor.realPhotoGold.passed, false);
assert(!realPhotoPoor.automaticAdoptionBlockingReasons.includes("m4-real-photo-independent-gold-missing"));
assert(realPhotoPoor.automaticAdoptionBlockingReasons.includes("m4-real-photo-independent-benchmark-below-floor"));

const missing = evaluateIndependentBenchmark({
  clean: summary(32, 0.97, 0.94),
  scan: null,
  photo: summary(6, 0.95, 0.89),
});
assert.equal(missing.independentBenchmarkReady, false, "missing scan evidence must fail closed");
assert(missing.evidenceBlockingReasons.includes("m4-independent-scan-summary-missing"));

const poor = evaluateIndependentBenchmark({
  clean: summary(32, 0.91, 0.82),
  scan: summary(6, 0.94, 0.89),
  photo: summary(6, 0.95, 0.89),
});
assert.equal(poor.independentBenchmarkReady, false, "poor clean-render accuracy must fail the independent benchmark");
assert(poor.evidenceBlockingReasons.includes("m4-independent-clean-benchmark-below-floor"));

const malformed = evaluateIndependentBenchmark({
  clean: { pieces: [{ piece: "bad-null", status: "ok", pitchPrecision: null, pitchRecall: null }] },
  scan: summary(6, 0.94, 0.89),
  photo: summary(6, 0.95, 0.89),
});
assert.equal(malformed.domains.clean.evaluatedRows, 0, "null metrics must not be coerced to numeric zero");
assert.equal(malformed.independentBenchmarkReady, false, "malformed gold metrics must fail closed");

const strictRows = summary(32, 0.99, 0.97);
const strict = evaluateIndependentBenchmark(
  {
    clean: strictRows,
    scan: summary(6, 0.94, 0.89),
    photo: summary(6, 0.95, 0.89),
    realPhotoGold: realPhotoSummary(3, 0.99, 0.97),
    confidenceProbe: { safeSubsetReady: true, validation: "leave-one-work-out", runtimeFeatureOnly: true },
  },
  DEFAULT_THRESHOLDS,
);
assert.equal(strict.strictPerPiece.passRate, 1);
assert.equal(strict.automaticAdoptionReady, true, "the evaluator should expose the adoption condition when all configured evidence is present");
assert.equal(strict.studentGateReady, false, "even a passing evaluator cannot mutate the runtime gate");

console.log(JSON.stringify({ ok: true, checks: [
  "independent-research-benchmark-pass",
  "missing-evidence-fail-closed",
  "poor-metric-fail-closed",
  "null-metric-fail-closed",
  "real-photo-consistency-not-promoted",
  "independent-real-photo-below-floor-reported",
  "runtime-confidence-probe-fail-closed",
  "student-runtime-never-opened",
] }, null, 2));
