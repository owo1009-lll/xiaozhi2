import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const M4B_DATASET_POLICY_PATH = path.join("config", "western-m4b-dataset.json");

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

async function verifyArtifact(repoRoot, relativePath, expectedHash, label, blockers) {
  const absolute = resolveInside(repoRoot, relativePath);
  if (!absolute) {
    blockers.push(`${label}-path-invalid`);
    return;
  }
  try {
    const observed = sha256(await fs.readFile(absolute));
    if (!/^[a-f0-9]{64}$/.test(expectedHash || "") || observed !== expectedHash) {
      blockers.push(`${label}-hash-mismatch`);
    }
  } catch {
    blockers.push(`${label}-missing`);
  }
}

export function evaluateM4bDataset({ config, manifest, report }) {
  const blockingReasons = [];
  if (config?.contract !== "western-m4b-structure-dataset-policy-v1") {
    blockingReasons.push("m4b-dataset-policy-contract-mismatch");
  }
  if (
    config?.synthetic?.variantsPerEdition !== 20
    || config?.synthetic?.splitsByVariant?.train !== 12
    || config?.synthetic?.splitsByVariant?.calibration !== 4
    || config?.synthetic?.splitsByVariant?.["synthetic-test"] !== 4
  ) {
    blockingReasons.push("m4b-synthetic-split-policy-drift");
  }
  if (config?.realAnnotation?.minimumTarget !== 100 || config?.realAnnotation?.maximumTarget !== 300) {
    blockingReasons.push("m4b-real-annotation-target-drift");
  }
  if (
    config?.freshBlind?.minimumPhotos !== 30
    || config?.freshBlind?.minimumPiecesOrLayouts !== 6
    || config?.freshBlind?.minimumDevices !== 3
  ) {
    blockingReasons.push("m4b-fresh-blind-data-floor-drift");
  }
  if (config?.frozenSourceGoldTestOnly?.length !== 5) blockingReasons.push("m4b-source-gold-freeze-count-mismatch");
  if (config?.frozenScreenPhotoTestOnly?.length !== 8) blockingReasons.push("m4b-screen-photo-freeze-count-mismatch");
  if (manifest?.contract !== "western-m4b-structure-dataset-manifest-v1") {
    blockingReasons.push("m4b-dataset-manifest-contract-mismatch");
  }
  if (report?.contract !== "western-m4b-structure-dataset-report-v1" || report?.complete !== true) {
    blockingReasons.push("m4b-dataset-report-contract-mismatch");
  }
  const synthetic = Array.isArray(manifest?.syntheticRows) ? manifest.syntheticRows : [];
  const sourceGold = Array.isArray(manifest?.frozenSourceGoldRows) ? manifest.frozenSourceGoldRows : [];
  const screens = Array.isArray(manifest?.frozenScreenPhotoRows) ? manifest.frozenScreenPhotoRows : [];
  const m4aRows = Array.isArray(manifest?.m4aAutoLabeledRows) ? manifest.m4aAutoLabeledRows : [];
  const activeRows = Array.isArray(manifest?.activeLearningRows) ? manifest.activeLearningRows : [];
  const freshRows = Array.isArray(manifest?.freshBlindRows) ? manifest.freshBlindRows : [];
  if (synthetic.length !== 60 || new Set(synthetic.map((row) => row.caseId)).size !== 60) {
    blockingReasons.push("m4b-synthetic-row-count-mismatch");
  }
  const splitCounts = Object.fromEntries(["train", "calibration", "synthetic-test"].map((split) => [
    split,
    synthetic.filter((row) => row.split === split).length,
  ]));
  if (splitCounts.train !== 36 || splitCounts.calibration !== 12 || splitCounts["synthetic-test"] !== 12) {
    blockingReasons.push("m4b-synthetic-manifest-split-mismatch");
  }
  if (sourceGold.length !== 5 || sourceGold.some((row) => row.trainingEligible !== false || row.role !== "frozen-source-gold-test-only")) {
    blockingReasons.push("m4b-source-gold-training-leak");
  }
  if (screens.length !== 8 || screens.some((row) => row.trainingEligible !== false || row.role !== "frozen-screen-photo-test-only")) {
    blockingReasons.push("m4b-screen-photo-training-leak");
  }
  if (freshRows.some((row) => row.trainingEligible !== false || row.role !== "fresh-blind-test-only")) {
    blockingReasons.push("m4b-fresh-blind-training-leak");
  }
  if (activeRows.some((row) => row.trainingEligible !== false)) {
    blockingReasons.push("m4b-active-learning-unreviewed-training-leak");
  }
  const protectedPaths = new Set([...sourceGold, ...screens, ...freshRows].map((row) => row.photoPath));
  if ([...m4aRows, ...synthetic].some((row) => protectedPaths.has(row.photoPath || row.image?.path))) {
    blockingReasons.push("m4b-protected-test-photo-present-in-training-pool");
  }
  if (
    report?.counts?.synthetic !== synthetic.length
    || report?.counts?.frozenSourceGoldTestOnly !== sourceGold.length
    || report?.counts?.frozenScreenPhotoTestOnly !== screens.length
    || report?.counts?.m4aAutoLabeled !== m4aRows.length
    || report?.counts?.activeLearning !== activeRows.length
    || report?.counts?.freshBlind !== freshRows.length
  ) {
    blockingReasons.push("m4b-dataset-report-count-mismatch");
  }
  const foundation = synthetic.length === 60 && sourceGold.length === 5 && screens.length === 8;
  if (report?.dataFoundationReady !== foundation) blockingReasons.push("m4b-data-foundation-summary-mismatch");
  if (
    report?.discipline?.sourceGoldTrainingEligible !== false
    || report?.discipline?.screenPhotoTrainingEligible !== false
    || report?.discipline?.freshBlindTrainingEligible !== false
    || report?.discipline?.m4aFailuresEnterActiveLearningOnly !== true
  ) {
    blockingReasons.push("m4b-dataset-discipline-missing");
  }
  return {
    ready: blockingReasons.length === 0 && foundation,
    blockingReasons: unique(blockingReasons),
    splitCounts,
  };
}

export async function auditM4bDataset(repoRoot = process.cwd()) {
  let config;
  let report;
  let manifest;
  try {
    config = JSON.parse(await fs.readFile(path.resolve(repoRoot, M4B_DATASET_POLICY_PATH), "utf8"));
    report = JSON.parse(await fs.readFile(path.resolve(repoRoot, config.outputRoot, "report.json"), "utf8"));
    manifest = JSON.parse(await fs.readFile(path.resolve(repoRoot, report.manifest), "utf8"));
  } catch (error) {
    return {
      ready: false,
      source: M4B_DATASET_POLICY_PATH.replace(/\\/g, "/"),
      blockingReasons: ["m4b-dataset-artifact-missing-or-invalid"],
      error: String(error?.message || error),
    };
  }
  const evaluation = evaluateM4bDataset({ config, manifest, report });
  const blockingReasons = [...evaluation.blockingReasons];
  await verifyArtifact(repoRoot, report.manifest, report.manifestSha256, "m4b-dataset-manifest", blockingReasons);
  for (const [key, label] of [["policy", "m4b-dataset-policy"], ["builder", "m4b-dataset-builder"]]) {
    await verifyArtifact(
      repoRoot,
      report?.provenance?.[key],
      report?.provenance?.[`${key}Sha256`],
      label,
      blockingReasons,
    );
  }
  for (const [key, label] of [["labelSchema", "m4b-label-schema"], ["freshBlindTemplate", "m4b-fresh-template"]]) {
    await verifyArtifact(
      repoRoot,
      report?.artifacts?.[key]?.path,
      report?.artifacts?.[key]?.sha256,
      label,
      blockingReasons,
    );
  }
  for (const row of manifest.syntheticRows || []) {
    const label = String(row.caseId).replace(/[^a-zA-Z0-9-]/g, "-");
    await verifyArtifact(repoRoot, row.image?.path, row.image?.sha256, `m4b-synthetic-${label}-image`, blockingReasons);
    await verifyArtifact(repoRoot, row.label?.path, row.label?.sha256, `m4b-synthetic-${label}-label`, blockingReasons);
  }
  for (const row of [...(manifest.frozenSourceGoldRows || []), ...(manifest.frozenScreenPhotoRows || [])]) {
    const label = String(row.pieceId).replace(/[^a-zA-Z0-9-]/g, "-");
    await verifyArtifact(repoRoot, row.photoPath, row.photoSha256, `m4b-frozen-${label}-photo`, blockingReasons);
    if (row.goldPath) await verifyArtifact(repoRoot, row.goldPath, row.goldSha256, `m4b-frozen-${label}-gold`, blockingReasons);
  }
  const ready = blockingReasons.length === 0 && report.dataFoundationReady === true;
  return {
    ready,
    source: path.join(config.outputRoot, "report.json").replace(/\\/g, "/"),
    blockingReasons: unique(blockingReasons),
    realAnnotationTargetReady: report.realAnnotationTargetReady === true,
    freshBlindReady: report.freshBlindReady === true,
    counts: report.counts,
    discipline: report.discipline,
  };
}

async function main() {
  const result = await auditM4bDataset();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
