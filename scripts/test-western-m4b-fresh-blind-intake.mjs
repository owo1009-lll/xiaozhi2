import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditM4bFreshBlindIntake } from "./audit-western-m4b-fresh-blind-intake.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "western-m4b-fresh-"));
try {
  const repo = path.join(temporary, "repo");
  await fs.mkdir(path.join(repo, "config"), { recursive: true });
  await fs.mkdir(path.join(repo, "dataset"), { recursive: true });
  await fs.mkdir(path.join(repo, "fresh"), { recursive: true });
  const requiredLabels = ["pageCorners", "systems", "staffs", "barlinesWithType", "measureBoxes", "meterRegions", "sameEdition", "judgeable"];
  const config = {
    outputRoot: "dataset",
    realAnnotation: { requiredLabels },
    freshBlind: {
      intakeManifest: "fresh/intake.json",
      minimumPhotos: 30,
      minimumPiecesOrLayouts: 6,
      minimumDevices: 3,
    },
  };
  await fs.writeFile(path.join(repo, "config", "western-m4b-dataset.json"), JSON.stringify(config));
  await fs.writeFile(path.join(repo, "dataset", "manifest.json"), JSON.stringify({ syntheticRows: [], frozenSourceGoldRows: [], frozenScreenPhotoRows: [] }));
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    const caseId = `fresh-${index + 1}`;
    const photoPath = `fresh/${caseId}.jpg`;
    const labelPath = `fresh/${caseId}.json`;
    const bytes = Buffer.from([0xff, 0xd8, 0xff, index, 1, 2, 3]);
    const photoSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(repo, photoPath), bytes);
    const row = {
      caseId,
      photoPath,
      labelPath,
      pieceOrLayoutId: `layout-${(index % 6) + 1}`,
      deviceId: `device-${(index % 3) + 1}`,
      captureBatchId: `batch-${(index % 2) + 1}`,
    };
    const labels = Object.fromEntries(requiredLabels.map((name) => [name, []]));
    labels.sameEdition = false;
    labels.judgeable = true;
    await fs.writeFile(path.join(repo, labelPath), JSON.stringify({
      contract: "western-m4b-real-structure-label-v1",
      caseId,
      photoSha256,
      pieceOrLayoutId: row.pieceOrLayoutId,
      deviceId: row.deviceId,
      captureBatchId: row.captureBatchId,
      labels,
    }));
    rows.push(row);
  }
  await fs.writeFile(path.join(repo, "fresh", "intake.json"), JSON.stringify({ contract: "western-m4b-fresh-blind-intake-v1", rows }));
  const ready = await auditM4bFreshBlindIntake(repo);
  assert.equal(ready.ready, true, ready.blockingReasons.join(", "));
  assert.deepEqual(ready.counts, { rows: 30, validRows: 30, piecesOrLayouts: 6, devices: 3, captureBatches: 2 });

  await fs.writeFile(path.join(repo, "fresh", "intake.json"), JSON.stringify({ contract: "western-m4b-fresh-blind-intake-v1", rows: rows.slice(0, 29) }));
  const short = await auditM4bFreshBlindIntake(repo);
  assert.equal(short.ready, false);
  assert(short.blockingReasons.includes("m4b-fresh-blind-photo-count-below-30"));

  const firstBytes = await fs.readFile(path.join(repo, rows[0].photoPath));
  const firstHash = crypto.createHash("sha256").update(firstBytes).digest("hex");
  await fs.writeFile(path.join(repo, "fresh", "intake.json"), JSON.stringify({ contract: "western-m4b-fresh-blind-intake-v1", rows }));
  await fs.writeFile(path.join(repo, "dataset", "manifest.json"), JSON.stringify({ syntheticRows: [{ image: { sha256: firstHash } }], frozenSourceGoldRows: [], frozenScreenPhotoRows: [] }));
  const leaked = await auditM4bFreshBlindIntake(repo);
  assert.equal(leaked.ready, false);
  assert(leaked.blockingReasons.includes("m4b-fresh-blind-reuses-protected-photo:fresh-1"));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

const live = await auditM4bFreshBlindIntake();
assert.equal(live.operationalReady, true);
assert.equal(live.ready, false);
assert(live.blockingReasons.includes("m4b-fresh-blind-intake-missing"));

console.log(JSON.stringify({
  ok: true,
  checks: [
    "thirty-photo-six-layout-three-device-floor",
    "photo-label-hash-and-metadata-binding",
    "protected-test-and-synthetic-photo-reuse-rejected",
    "judgeable-structure-label-schema-required",
    "live-missing-intake-remains-explicit",
  ],
}, null, 2));
