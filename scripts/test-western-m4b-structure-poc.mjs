import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditM4bStructurePoc } from "./audit-western-m4b-structure-poc.mjs";


const REPO = process.cwd();

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function copyRelative(root, relativePath) {
  const source = path.join(REPO, relativePath);
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function buildFixture(root) {
  const fixed = [
    "config/western-m4b-structure-poc.json",
    "config/western-m4b-fresh-blind-capture.json",
    "config/western-m4b-dataset.json",
    "data/experiments/western-strings-m4b-poc-promotion-threshold-decision.json",
    "data/experiments/western-strings-m4b/dataset/manifest.json",
    "scripts/western_m4b_structure_poc.py",
    "scripts/ingest-western-m4b-fresh-blind.mjs",
    "scripts/experiments/eval_western_m4b_structure_poc.py",
    "scripts/experiments/eval_western_m4b_fresh_blind_promotion.py",
  ];
  await Promise.all(fixed.map((value) => copyRelative(root, value)));
  await copyRelative(root, "docs/m4b-fresh-blind-capture-pack/index.html");
  await fs.cp(
    path.join(REPO, "data", "experiments", "western-strings-m4b", "structure-poc"),
    path.join(root, "data", "experiments", "western-strings-m4b", "structure-poc"),
    { recursive: true },
  );
  const report = JSON.parse(await fs.readFile(
    path.join(root, "data", "experiments", "western-strings-m4b", "structure-poc", "report.json"),
    "utf8",
  ));
  for (const row of report.cases) {
    const result = JSON.parse(await fs.readFile(path.join(root, row.result), "utf8"));
    await copyRelative(root, result.photo);
  }
}

async function main() {
  const live = await auditM4bStructurePoc(REPO);
  assert.equal(live.ready, true, JSON.stringify(live.blockingReasons));
  assert.equal(live.engineeringReady, true);
  assert.equal(live.promotionOperationalReady, true);
  assert.equal(live.promotionReady, false);
  assert.deepEqual(live.promotionBlockingReasons, ["m4b-fresh-blind-intake-missing"]);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "western-m4b-poc-test-"));
  try {
    await buildFixture(temporary);
    const baseline = await auditM4bStructurePoc(temporary);
    assert.equal(baseline.ready, true, JSON.stringify(baseline.blockingReasons));

    const reportPath = "data/experiments/western-strings-m4b/structure-poc/report.json";
    const originalReport = JSON.parse(await fs.readFile(path.join(temporary, reportPath), "utf8"));
    const syntheticPromotionForgery = structuredClone(originalReport);
    syntheticPromotionForgery.promotionReady = true;
    await writeJson(temporary, reportPath, syntheticPromotionForgery);
    const syntheticPromotionResult = await auditM4bStructurePoc(temporary);
    assert.ok(syntheticPromotionResult.blockingReasons.includes("m4b-synthetic-report-must-not-promote"));

    const resultPath = originalReport.cases[0].result;
    const forgedResult = JSON.parse(await fs.readFile(path.join(temporary, resultPath), "utf8"));
    forgedResult.studentFacing = true;
    await writeJson(temporary, resultPath, forgedResult);
    const resultBytes = await fs.readFile(path.join(temporary, resultPath));
    const boundaryForgery = structuredClone(originalReport);
    boundaryForgery.cases[0].resultSha256 = sha256(resultBytes);
    await writeJson(temporary, reportPath, boundaryForgery);
    const boundaryResult = await auditM4bStructurePoc(temporary);
    assert.ok(boundaryResult.blockingReasons.some((value) => value.endsWith("-safety-boundary-invalid")));

    await buildFixture(temporary);
    const promotionPath = "data/experiments/western-strings-m4b/structure-poc/fresh-blind-promotion-report.json";
    const promotion = JSON.parse(await fs.readFile(path.join(temporary, promotionPath), "utf8"));
    promotion.promotionReady = true;
    promotion.blockingReasons = [];
    await writeJson(temporary, promotionPath, promotion);
    const promotionResult = await auditM4bStructurePoc(temporary);
    assert.ok(promotionResult.blockingReasons.includes("m4b-fresh-promotion-summary-invalid"));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log("western m4b structure poc audit tests passed");
}

await main();
