import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";


const CAPTURE_POLICY = path.join("config", "western-m4b-fresh-blind-capture.json");
const DATASET_POLICY = path.join("config", "western-m4b-dataset.json");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "unknown";
}

function unique(values) {
  return [...new Set(values)];
}

async function findPhoto(sourceRoot, caseId, extensions) {
  for (const extension of extensions) {
    const candidate = path.join(sourceRoot, `${caseId}${extension}`);
    try {
      const bytes = await fs.readFile(candidate);
      return { source: candidate, bytes, extension };
    } catch {
      // Try the next accepted extension.
    }
  }
  return null;
}

function evaluateMetadata(metadata, capture) {
  const blockers = [];
  if (metadata?.contract !== "western-m4b-fresh-blind-capture-metadata-v1") {
    blockers.push("m4b-fresh-capture-metadata-contract-mismatch");
  }
  if (metadata?.captureBatchId !== capture.captureBatchId) blockers.push("m4b-fresh-capture-batch-mismatch");
  for (const field of capture.requiredMetadataConfirmations || []) {
    if (metadata?.[field] !== true) blockers.push(`m4b-fresh-capture-confirmation-missing:${field}`);
  }
  const layouts = Array.isArray(metadata?.layouts) ? metadata.layouts : [];
  const devices = Array.isArray(metadata?.devices) ? metadata.devices : [];
  if (unique(layouts.map((row) => row.slot)).length !== layouts.length) blockers.push("m4b-fresh-layout-slot-duplicate");
  if (unique(layouts.map((row) => row.pieceOrLayoutId)).length !== layouts.length) blockers.push("m4b-fresh-layout-id-duplicate");
  if (unique(layouts.map((row) => row.sourceFingerprintSha256)).length !== layouts.length) blockers.push("m4b-fresh-layout-fingerprint-duplicate");
  if (unique(devices.map((row) => row.slot)).length !== devices.length) blockers.push("m4b-fresh-device-slot-duplicate");
  if (unique(devices.map((row) => row.deviceId)).length !== devices.length) blockers.push("m4b-fresh-device-id-duplicate");
  for (const slot of capture.layoutSlots || []) {
    const row = layouts.find((value) => value.slot === slot);
    if (!row || !row.pieceOrLayoutId || !/^[a-f0-9]{64}$/.test(row.sourceFingerprintSha256 || "")) {
      blockers.push(`m4b-fresh-layout-metadata-invalid:${slot}`);
    }
  }
  for (const slot of capture.deviceSlots || []) {
    const row = devices.find((value) => value.slot === slot);
    if (!row || !row.deviceId || !row.makeModel) blockers.push(`m4b-fresh-device-metadata-invalid:${slot}`);
  }
  return { blockers: unique(blockers), layouts, devices };
}

async function copyWithoutReplacement(sourceBytes, destination) {
  let existing = null;
  try {
    existing = await fs.readFile(destination);
  } catch {
    existing = null;
  }
  if (existing && sha256(existing) !== sha256(sourceBytes)) return "different-destination-exists";
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (!existing) await fs.writeFile(destination, sourceBytes);
  return existing ? "already-current" : "ingested";
}

export async function ingestM4bFreshBlind({ repoRoot = process.cwd(), sourceRoot } = {}) {
  const capturePath = path.join(repoRoot, CAPTURE_POLICY);
  const datasetPath = path.join(repoRoot, DATASET_POLICY);
  const capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8"));
  const source = path.resolve(sourceRoot || path.join(repoRoot, capture.defaultSourceRoot));
  const metadataPath = path.join(source, capture.metadataFileName);
  let metadata;
  let metadataBytes;
  try {
    metadataBytes = await fs.readFile(metadataPath);
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    metadataBytes = Buffer.alloc(0);
    metadata = null;
  }
  const metadataEvaluation = evaluateMetadata(metadata, capture);
  const blockingReasons = [...metadataEvaluation.blockers];
  if (!metadata) blockingReasons.push("m4b-fresh-capture-metadata-missing-or-invalid");
  const layoutMap = new Map(metadataEvaluation.layouts.map((row) => [row.slot, row]));
  const deviceMap = new Map(metadataEvaluation.devices.map((row) => [row.slot, row]));
  const requiredLabels = dataset.realAnnotation?.requiredLabels || [];
  const destinationRoot = path.resolve(repoRoot, dataset.freshBlind.root);
  const statuses = [];
  const rows = [];

  for (let layoutIndex = 0; layoutIndex < (capture.layoutSlots || []).length; layoutIndex += 1) {
    const layoutSlot = capture.layoutSlots[layoutIndex];
    for (let poseIndex = 0; poseIndex < (capture.poses || []).length; poseIndex += 1) {
      const pose = capture.poses[poseIndex];
      const caseId = `m4b-fresh-l${String(layoutIndex + 1).padStart(2, "0")}-p${String(poseIndex + 1).padStart(2, "0")}`;
      const photo = await findPhoto(source, caseId, capture.acceptedImageExtensions || []);
      const labelSource = path.join(source, `${caseId}.structure.json`);
      if (!photo) {
        statuses.push({ caseId, status: "missing-photo" });
        continue;
      }
      const detected = imageType(photo.bytes);
      if (detected === "unknown") {
        statuses.push({ caseId, status: "invalid-image-signature" });
        blockingReasons.push(`m4b-fresh-capture-invalid-image:${caseId}`);
        continue;
      }
      let labelBytes;
      let label;
      try {
        labelBytes = await fs.readFile(labelSource);
        label = JSON.parse(labelBytes.toString("utf8"));
      } catch {
        statuses.push({ caseId, status: "missing-or-invalid-label" });
        continue;
      }
      const layout = layoutMap.get(layoutSlot);
      const device = deviceMap.get(pose.deviceSlot);
      const photoHash = sha256(photo.bytes);
      const labels = label?.labels || {};
      const structureReady = (
        Array.isArray(labels.pageCorners)
        && labels.pageCorners.length === 4
        && Array.isArray(labels.systems)
        && labels.systems.length > 0
        && Array.isArray(labels.staffs)
        && labels.staffs.length > 0
        && Array.isArray(labels.barlinesWithType)
        && labels.barlinesWithType.length > 0
        && Array.isArray(labels.measureBoxes)
        && labels.measureBoxes.length > 0
        && Array.isArray(labels.meterRegions)
        && labels.meterRegions.length > 0
      );
      const labelReady = (
        layout
        && device
        && label?.contract === "western-m4b-real-structure-label-v1"
        && label.caseId === caseId
        && label.photoSha256 === photoHash
        && label.pieceOrLayoutId === layout.pieceOrLayoutId
        && label.deviceId === device.deviceId
        && label.captureBatchId === capture.captureBatchId
        && labels.judgeable === true
        && structureReady
        && requiredLabels.every((name) => Object.hasOwn(labels, name))
      );
      if (!labelReady) {
        statuses.push({ caseId, status: "label-binding-invalid" });
        blockingReasons.push(`m4b-fresh-capture-label-binding-invalid:${caseId}`);
        continue;
      }
      const photoDestination = path.join(destinationRoot, "photos", `${caseId}${photo.extension}`);
      const labelDestination = path.join(destinationRoot, "labels", `${caseId}.structure.json`);
      const photoStatus = await copyWithoutReplacement(photo.bytes, photoDestination);
      const labelStatus = await copyWithoutReplacement(labelBytes, labelDestination);
      if (photoStatus === "different-destination-exists" || labelStatus === "different-destination-exists") {
        statuses.push({ caseId, status: "different-destination-exists" });
        blockingReasons.push(`m4b-fresh-capture-replacement-refused:${caseId}`);
        continue;
      }
      statuses.push({ caseId, status: photoStatus === "already-current" && labelStatus === "already-current" ? "already-current" : "ingested" });
      rows.push({
        caseId,
        photoPath: path.relative(repoRoot, photoDestination).replace(/\\/g, "/"),
        labelPath: path.relative(repoRoot, labelDestination).replace(/\\/g, "/"),
        pieceOrLayoutId: layout.pieceOrLayoutId,
        deviceId: device.deviceId,
        captureBatchId: capture.captureBatchId,
        trainingEligible: false,
        role: "fresh-blind-test-only",
      });
    }
  }
  const pieces = unique(rows.map((row) => row.pieceOrLayoutId));
  const devices = unique(rows.map((row) => row.deviceId));
  if (rows.length < capture.minimumValidPhotos) blockingReasons.push(`m4b-fresh-blind-photo-count-below-${capture.minimumValidPhotos}`);
  if (pieces.length < capture.minimumLayouts) blockingReasons.push(`m4b-fresh-blind-layout-count-below-${capture.minimumLayouts}`);
  if (devices.length < capture.minimumDevices) blockingReasons.push(`m4b-fresh-blind-device-count-below-${capture.minimumDevices}`);
  const decisionPath = path.resolve(repoRoot, capture.thresholdDecision);
  const captureDestination = path.join(destinationRoot, "capture-metadata.json");
  if (metadataBytes.length) {
    const metadataStatus = await copyWithoutReplacement(metadataBytes, captureDestination);
    if (metadataStatus === "different-destination-exists") blockingReasons.push("m4b-fresh-capture-metadata-replacement-refused");
  }
  const manifest = {
    contract: "western-m4b-fresh-blind-intake-v1",
    captureAttestation: {
      contract: "western-m4b-fresh-blind-capture-attestation-v1",
      capturePolicy: CAPTURE_POLICY.replace(/\\/g, "/"),
      capturePolicySha256: sha256(await fs.readFile(capturePath)),
      captureMetadata: path.relative(repoRoot, captureDestination).replace(/\\/g, "/"),
      captureMetadataSha256: metadataBytes.length ? sha256(metadataBytes) : "",
      thresholdDecision: capture.thresholdDecision,
      thresholdDecisionSha256: sha256(await fs.readFile(decisionPath)),
      captureBatchId: capture.captureBatchId,
      confirmations: Object.fromEntries((capture.requiredMetadataConfirmations || []).map((field) => [field, metadata?.[field] === true])),
      noReplacementAllowed: true,
      trainingEligible: false,
    },
    rows,
  };
  const intakePath = path.resolve(repoRoot, dataset.freshBlind.intakeManifest);
  await fs.mkdir(path.dirname(intakePath), { recursive: true });
  await fs.writeFile(intakePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const blockers = unique(blockingReasons);
  return {
    contract: "western-m4b-fresh-blind-ingest-result-v1",
    ready: blockers.length === 0,
    sourceRoot: source,
    intakeManifest: path.relative(repoRoot, intakePath).replace(/\\/g, "/"),
    counts: { validPhotos: rows.length, layouts: pieces.length, devices: devices.length, plannedSlots: (capture.layoutSlots || []).length * (capture.poses || []).length },
    blockingReasons: blockers,
    statuses,
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const result = await ingestM4bFreshBlind({ sourceRoot: argumentValue("--from") || undefined });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
