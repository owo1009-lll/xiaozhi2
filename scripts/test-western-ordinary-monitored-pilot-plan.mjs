import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildOrdinaryMonitoredPilotPlan } from "./create-western-ordinary-monitored-pilot-plan.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runCase(tempRoot, name, precisionReview, expectedReasons) {
  const precisionReviewPath = path.join(tempRoot, `${name}-precision-review.json`);
  const outDir = path.join(tempRoot, `${name}-out`);
  if (precisionReview !== null) {
    await writeJson(precisionReviewPath, precisionReview);
  }
  const { plan } = await buildOrdinaryMonitoredPilotPlan({
    precisionReview: precisionReviewPath,
    outDir,
  });
  for (const reason of expectedReasons) {
    assert(
      plan.blockingReasons.includes(reason),
      `${name} should include blocking reason ${reason}; got ${plan.blockingReasons.join(",")}`,
    );
  }
  assert(
    plan.blockingReasons.includes("ordinary-rf-monitored-pilot-authorization-superseded"),
    `${name} must retain the global RF supersession blocker`,
  );
  assert.equal(plan.authorizationStatus, "superseded-historical-rf-only");
  assert.equal(plan.readyForPilotPlan, false);
  assert.equal(plan.ok, false, `${name} must fail closed because the RF pilot path is superseded`);
  if (expectedReasons.length === 0) {
    assert.equal(plan.evidence.precisionPrecheckOk, true, `${name} should expose passing precheck evidence`);
    assert.equal(plan.evidence.precisionPrecheckKnownWrong, 0, `${name} should have zero known-wrong rows`);
    assert.equal(plan.evidence.precisionPrecheckUnknownReviewRows, 0, `${name} should have zero unknown review rows`);
  }
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-ordinary-pilot-plan-test-"));
try {
  await runCase(tempRoot, "passing", {
    ok: true,
    selfCheckedAutoPassCandidateCount: 3,
    knownUsableAutoPassCandidateCount: 3,
    knownWrongAutoPassCandidateCount: 0,
    unknownReviewCandidateCount: 0,
  }, []);

  await runCase(tempRoot, "missing", null, [
    "ordinary-precision-precheck-missing",
  ]);

  await runCase(tempRoot, "failed", {
    ok: false,
    selfCheckedAutoPassCandidateCount: 3,
    knownWrongAutoPassCandidateCount: 0,
    unknownReviewCandidateCount: 0,
  }, [
    "ordinary-precision-precheck-failed",
  ]);

  await runCase(tempRoot, "no-self-checked", {
    ok: true,
    selfCheckedAutoPassCandidateCount: 0,
    knownWrongAutoPassCandidateCount: 0,
    unknownReviewCandidateCount: 0,
  }, [
    "ordinary-precision-precheck-no-self-checked-auto-pass",
  ]);

  await runCase(tempRoot, "known-wrong", {
    ok: true,
    selfCheckedAutoPassCandidateCount: 3,
    knownWrongAutoPassCandidateCount: 1,
    unknownReviewCandidateCount: 0,
  }, [
    "ordinary-precision-precheck-known-wrong-auto-pass",
  ]);

  await runCase(tempRoot, "unknown-review", {
    ok: true,
    selfCheckedAutoPassCandidateCount: 3,
    knownWrongAutoPassCandidateCount: 0,
    unknownReviewCandidateCount: 1,
  }, [
    "ordinary-precision-precheck-has-unknown-review-rows",
  ]);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "ordinary-rf-pilot-plan-globally-superseded",
    "ordinary-pilot-plan-missing-precheck-fails",
    "ordinary-pilot-plan-failed-precheck-fails",
    "ordinary-pilot-plan-no-self-checked-fails",
    "ordinary-pilot-plan-known-wrong-fails",
    "ordinary-pilot-plan-unknown-review-fails",
  ],
}, null, 2));
