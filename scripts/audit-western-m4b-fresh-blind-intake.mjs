import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function unique(rows) {
  return [...new Set(rows)];
}

function resolveInside(repoRoot, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const absolute = path.resolve(repoRoot, relativePath);
  const back = path.relative(repoRoot, absolute);
  if (back.startsWith("..") || path.isAbsolute(back)) return null;
  return absolute;
}

export async function auditM4bFreshBlindIntake(repoRoot = process.cwd()) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(path.join(repoRoot, "config", "western-m4b-dataset.json"), "utf8"));
  } catch (error) {
    return { ready: false, operationalReady: false, blockingReasons: ["m4b-fresh-blind-policy-missing"], error: String(error) };
  }
  const policy = config.freshBlind || {};
  const intakePath = resolveInside(repoRoot, policy.intakeManifest);
  let intake;
  try {
    intake = JSON.parse(await fs.readFile(intakePath, "utf8"));
  } catch {
    return {
      ready: false,
      operationalReady: true,
      source: policy.intakeManifest,
      blockingReasons: ["m4b-fresh-blind-intake-missing"],
      counts: { rows: 0, validRows: 0, piecesOrLayouts: 0, devices: 0, captureBatches: 0 },
    };
  }
  const blockingReasons = [];
  if (intake.contract !== "western-m4b-fresh-blind-intake-v1") blockingReasons.push("m4b-fresh-blind-intake-contract-mismatch");
  const rows = Array.isArray(intake.rows) ? intake.rows : [];
  if (new Set(rows.map((row) => row.caseId)).size !== rows.length) blockingReasons.push("m4b-fresh-blind-duplicate-case-id");
  const protectedHashes = new Set();
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, config.outputRoot, "manifest.json"), "utf8"));
    for (const row of [...(manifest.frozenSourceGoldRows || []), ...(manifest.frozenScreenPhotoRows || []), ...(manifest.syntheticRows || [])]) {
      const value = row.photoSha256 || row.image?.sha256;
      if (value) protectedHashes.add(value);
    }
  } catch {
    blockingReasons.push("m4b-fresh-blind-protected-split-ledger-missing");
  }
  const valid = [];
  for (const row of rows) {
    const caseId = String(row.caseId || "unknown");
    const photoPath = resolveInside(repoRoot, row.photoPath);
    const labelPath = resolveInside(repoRoot, row.labelPath);
    if (!photoPath || !labelPath) {
      blockingReasons.push(`m4b-fresh-blind-path-invalid:${caseId}`);
      continue;
    }
    let photoBytes;
    let label;
    try {
      photoBytes = await fs.readFile(photoPath);
      label = JSON.parse(await fs.readFile(labelPath, "utf8"));
    } catch {
      blockingReasons.push(`m4b-fresh-blind-artifact-missing-or-invalid:${caseId}`);
      continue;
    }
    const photoHash = sha256(photoBytes);
    const requiredLabels = config.realAnnotation?.requiredLabels || [];
    const labelsReady = requiredLabels.every((name) => Object.hasOwn(label.labels || {}, name));
    if (
      label.contract !== "western-m4b-real-structure-label-v1"
      || label.caseId !== row.caseId
      || label.photoSha256 !== photoHash
      || label.pieceOrLayoutId !== row.pieceOrLayoutId
      || label.deviceId !== row.deviceId
      || label.captureBatchId !== row.captureBatchId
      || !labelsReady
      || label.labels?.judgeable !== true
    ) {
      blockingReasons.push(`m4b-fresh-blind-label-binding-invalid:${caseId}`);
      continue;
    }
    if (protectedHashes.has(photoHash)) {
      blockingReasons.push(`m4b-fresh-blind-reuses-protected-photo:${caseId}`);
      continue;
    }
    valid.push({ ...row, photoSha256: photoHash, labelSha256: sha256(await fs.readFile(labelPath)) });
  }
  const pieces = new Set(valid.map((row) => row.pieceOrLayoutId).filter(Boolean));
  const devices = new Set(valid.map((row) => row.deviceId).filter(Boolean));
  const batches = new Set(valid.map((row) => row.captureBatchId).filter(Boolean));
  if (valid.length < policy.minimumPhotos) blockingReasons.push(`m4b-fresh-blind-photo-count-below-${policy.minimumPhotos}`);
  if (pieces.size < policy.minimumPiecesOrLayouts) blockingReasons.push(`m4b-fresh-blind-layout-count-below-${policy.minimumPiecesOrLayouts}`);
  if (devices.size < policy.minimumDevices) blockingReasons.push(`m4b-fresh-blind-device-count-below-${policy.minimumDevices}`);
  return {
    ready: blockingReasons.length === 0,
    operationalReady: true,
    source: policy.intakeManifest,
    blockingReasons: unique(blockingReasons),
    counts: {
      rows: rows.length,
      validRows: valid.length,
      piecesOrLayouts: pieces.size,
      devices: devices.size,
      captureBatches: batches.size,
    },
    rows: valid,
  };
}

async function main() {
  const result = await auditM4bFreshBlindIntake();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
