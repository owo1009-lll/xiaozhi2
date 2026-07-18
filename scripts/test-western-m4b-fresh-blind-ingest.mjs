import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ingestM4bFreshBlind } from "./ingest-western-m4b-fresh-blind.mjs";


function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function labelFor({ caseId, photoHash, layoutId, deviceId, batchId }) {
  return {
    contract: "western-m4b-real-structure-label-v1",
    caseId,
    photoSha256: photoHash,
    pieceOrLayoutId: layoutId,
    deviceId,
    captureBatchId: batchId,
    labels: {
      pageCorners: [[0, 0], [9, 0], [9, 9], [0, 9]],
      systems: [{ systemIndex: 0, polygon: [[0, 1], [9, 1], [9, 8], [0, 8]] }],
      staffs: [{ staffIndex: 0, systemIndex: 0, polygon: [[0, 2], [9, 2], [9, 7], [0, 7]] }],
      barlinesWithType: [{ systemIndex: 0, line: [[8, 2], [8, 7]], type: "final" }],
      measureBoxes: [{ systemIndex: 0, polygon: [[1, 2], [8, 2], [8, 7], [1, 7]] }],
      meterRegions: [{ systemIndex: 0, polygon: [[1, 2], [2, 2], [2, 7], [1, 7]] }],
      sameEdition: false,
      judgeable: true,
    },
  };
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "western-m4b-fresh-ingest-"));
  const repo = path.join(temporary, "repo");
  const source = path.join(temporary, "source");
  try {
    await fs.mkdir(path.join(repo, "config"), { recursive: true });
    await fs.mkdir(path.join(repo, "data", "experiments"), { recursive: true });
    await fs.mkdir(source, { recursive: true });
    await fs.copyFile(
      path.join(process.cwd(), "config", "western-m4b-fresh-blind-capture.json"),
      path.join(repo, "config", "western-m4b-fresh-blind-capture.json"),
    );
    await fs.copyFile(
      path.join(process.cwd(), "config", "western-m4b-dataset.json"),
      path.join(repo, "config", "western-m4b-dataset.json"),
    );
    await fs.copyFile(
      path.join(process.cwd(), "data", "experiments", "western-strings-m4b-poc-promotion-threshold-decision.json"),
      path.join(repo, "data", "experiments", "western-strings-m4b-poc-promotion-threshold-decision.json"),
    );
    const batchId = "m4b-fresh-blind-batch-01";
    const layouts = Array.from({ length: 6 }, (_, index) => ({
      slot: `layout-${String(index + 1).padStart(2, "0")}`,
      pieceOrLayoutId: `heldout-layout-${index + 1}`,
      sourceFingerprintSha256: sha256(Buffer.from(`layout-${index + 1}`)),
    }));
    const devices = Array.from({ length: 3 }, (_, index) => ({
      slot: `device-${String(index + 1).padStart(2, "0")}`,
      deviceId: `physical-device-${index + 1}`,
      makeModel: `test-camera-${index + 1}`,
    }));
    const metadata = {
      contract: "western-m4b-fresh-blind-capture-metadata-v1",
      captureBatchId: batchId,
      confirmThresholdsFrozenBeforeCapture: true,
      confirmLayoutsExcludedFromPocAndTraining: true,
      confirmPhotosAndLabelsRemainTestOnly: true,
      confirmNoFailedCaptureWasSilentlyReplaced: true,
      layouts,
      devices,
    };
    await writeJson(path.join(source, "m4b-fresh-blind-metadata.json"), metadata);
    for (let layoutIndex = 0; layoutIndex < 6; layoutIndex += 1) {
      for (let poseIndex = 0; poseIndex < 6; poseIndex += 1) {
        const caseId = `m4b-fresh-l${String(layoutIndex + 1).padStart(2, "0")}-p${String(poseIndex + 1).padStart(2, "0")}`;
        const bytes = Buffer.from([0xff, 0xd8, 0xff, layoutIndex + 1, poseIndex + 1]);
        await fs.writeFile(path.join(source, `${caseId}.jpg`), bytes);
        await writeJson(path.join(source, `${caseId}.structure.json`), labelFor({
          caseId,
          photoHash: sha256(bytes),
          layoutId: layouts[layoutIndex].pieceOrLayoutId,
          deviceId: devices[poseIndex % 3].deviceId,
          batchId,
        }));
      }
    }
    const first = await ingestM4bFreshBlind({ repoRoot: repo, sourceRoot: source });
    assert.equal(first.ready, true, JSON.stringify(first.blockingReasons));
    assert.deepEqual(first.counts, { validPhotos: 36, layouts: 6, devices: 3, plannedSlots: 36 });
    const intake = JSON.parse(await fs.readFile(path.join(repo, "data", "private", "western-strings-m4b-fresh-blind", "intake.json"), "utf8"));
    assert.equal(intake.rows.length, 36);
    assert.equal(intake.captureAttestation.noReplacementAllowed, true);
    assert.equal(intake.captureAttestation.trainingEligible, false);

    const second = await ingestM4bFreshBlind({ repoRoot: repo, sourceRoot: source });
    assert.equal(second.ready, true);
    assert.equal(second.statuses.filter((row) => row.status === "already-current").length, 36);

    const caseId = "m4b-fresh-l01-p01";
    const changed = Buffer.from([0xff, 0xd8, 0xff, 99, 99]);
    await fs.writeFile(path.join(source, `${caseId}.jpg`), changed);
    await writeJson(path.join(source, `${caseId}.structure.json`), labelFor({
      caseId,
      photoHash: sha256(changed),
      layoutId: layouts[0].pieceOrLayoutId,
      deviceId: devices[0].deviceId,
      batchId,
    }));
    const collision = await ingestM4bFreshBlind({ repoRoot: repo, sourceRoot: source });
    assert.equal(collision.ready, false);
    assert.ok(collision.blockingReasons.includes(`m4b-fresh-capture-replacement-refused:${caseId}`));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log("western m4b fresh-blind ingest tests passed");
}

await main();
