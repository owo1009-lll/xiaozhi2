import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { summarizeRound5TargetedIntake } from "./status-western-strings-project.mjs";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "western-round5-status-"));
try {
  const contractPath = path.join(root, "contract.json");
  const manifestPath = path.join(root, "manifest.csv");
  const truthPath = path.join(root, "truth.json");
  const reportPath = path.join(root, "report.json");
  const modelReportPath = path.join(root, "model-report.json");
  const contract = {
    contractVersion: "western-round5-targeted-diagnosis-intake-v1",
    minimums: { positivePerGate: 12 },
  };
  const contractBytes = Buffer.from(`${JSON.stringify(contract)}\n`, "utf8");
  await fs.writeFile(contractPath, contractBytes);
  await fs.writeFile(reportPath, `${JSON.stringify({
    contractVersion: contract.contractVersion,
    ready: false,
    studentFacing: false,
    automaticAuthorizationGranted: false,
    hashes: {
      contractSha256: sha256(contractBytes),
      manifestSha256: null,
      truthSha256: null,
    },
    blockingReasons: ["round5-manifest-missing", "round5-position-truth-missing"],
  })}\n`);
  await fs.writeFile(modelReportPath, `${JSON.stringify({
    contract: "western-round5-segment-edit-path-candidate-v1",
    intakeReady: false,
    trainingPerformed: false,
    reviewAssistPromotionReady: false,
    automaticAccusationReady: false,
    studentFacing: false,
    productionAdoptionReady: false,
    sourceHashes: {
      contractSha256: sha256(contractBytes),
      manifestSha256: null,
      truthSha256: null,
    },
    blockingReasons: ["round5-targeted-intake-not-ready"],
  })}\n`);

  const missing = await summarizeRound5TargetedIntake({
    contractPath, manifestPath, truthPath, reportPath, modelReportPath,
  });
  assert.equal(missing.bindingCurrent, true);
  assert.equal(missing.ready, false);
  assert.equal(missing.studentFacing, false);
  assert.equal(missing.automaticAuthorizationGranted, false);
  assert(missing.blockingReasons.includes("round5-manifest-missing"));
  assert(missing.blockingReasons.includes("round5-position-truth-missing"));
  assert.equal(missing.segmentEditPathCandidate.bindingCurrent, true);
  assert.equal(missing.segmentEditPathCandidate.trainingPerformed, false);
  assert.equal(missing.segmentEditPathCandidate.reviewAssistPromotionReady, false);

  const manifestBytes = Buffer.from("recordingId\nr5-test\n", "utf8");
  const truthBytes = Buffer.from('{"recordings":{}}\n', "utf8");
  await fs.writeFile(manifestPath, manifestBytes);
  await fs.writeFile(truthPath, truthBytes);
  await fs.writeFile(reportPath, `${JSON.stringify({
    contractVersion: contract.contractVersion,
    ready: true,
    studentFacing: false,
    automaticAuthorizationGranted: false,
    hashes: {
      contractSha256: sha256(contractBytes),
      manifestSha256: sha256(manifestBytes),
      truthSha256: sha256(truthBytes),
    },
    blockingReasons: [],
  })}\n`);

  const ready = await summarizeRound5TargetedIntake({
    contractPath, manifestPath, truthPath, reportPath, modelReportPath,
  });
  assert.equal(ready.bindingCurrent, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.segmentEditPathCandidate.bindingCurrent, false);
  assert(ready.segmentEditPathCandidate.blockingReasons.includes(
    "round5-segment-edit-path-source-binding-stale",
  ));

  await fs.writeFile(truthPath, '{"recordings":{"changed":{}}}\n', "utf8");
  const stale = await summarizeRound5TargetedIntake({
    contractPath, manifestPath, truthPath, reportPath, modelReportPath,
  });
  assert.equal(stale.bindingCurrent, false);
  assert.equal(stale.ready, false);
  assert(stale.blockingReasons.includes("round5-targeted-truth-binding-stale"));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("western Round-5 project-status binding tests passed");
