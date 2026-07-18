import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";


export const M4B_STRUCTURE_POC_POLICY_PATH = path.join("config", "western-m4b-structure-poc.json");

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

async function readJson(repoRoot, relativePath, label, blockers) {
  const absolute = resolveInside(repoRoot, relativePath);
  if (!absolute) {
    blockers.push(`${label}-path-invalid`);
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(absolute, "utf8"));
  } catch {
    blockers.push(`${label}-missing-or-invalid`);
    return null;
  }
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

function rounded(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

function aggregate(cases, key) {
  const truePositive = cases.reduce((sum, row) => sum + Number(row?.[key]?.truePositive || 0), 0);
  const falsePositive = cases.reduce((sum, row) => sum + Number(row?.[key]?.falsePositive || 0), 0);
  const falseNegative = cases.reduce((sum, row) => sum + Number(row?.[key]?.falseNegative || 0), 0);
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { truePositive, falsePositive, falseNegative, precision: rounded(precision), recall: rounded(recall), f1: rounded(f1) };
}

function compareSummary(observed, expected) {
  return ["truePositive", "falsePositive", "falseNegative", "precision", "recall", "f1"]
    .every((key) => Number(observed?.[key]) === Number(expected?.[key]));
}

function evaluateReportContracts({ config, report, promotion }) {
  const blockers = [];
  if (config?.contract !== "western-m4b-explicit-structure-poc-policy-v1") {
    blockers.push("m4b-structure-poc-policy-contract-mismatch");
  }
  if (
    config?.graphDecoder?.conflictDisposition !== "structure-review-required"
    || config?.graphDecoder?.silentGuessAllowed !== false
    || config?.contentChallenger?.shadowOnly !== true
    || config?.contentChallenger?.productionCandidatePool !== false
    || config?.contentChallenger?.studentFacing !== false
  ) {
    blockers.push("m4b-structure-poc-safety-policy-drift");
  }
  if (
    config?.evaluation?.split !== "synthetic-test"
    || config?.evaluation?.boxIouThreshold !== 0.5
    || config?.evaluation?.conflictInjectionCount !== 12
  ) {
    blockers.push("m4b-structure-poc-evaluation-policy-drift");
  }
  if (
    report?.contract !== "western-m4b-explicit-structure-poc-evaluation-v1"
    || report?.complete !== true
    || report?.evidenceClass !== "synthetic-engineering-only"
    || report?.split !== "synthetic-test"
    || report?.caseCount !== 12
  ) {
    blockers.push("m4b-structure-poc-report-contract-mismatch");
  }
  if (report?.promotionReady !== false || report?.promotionBoundary?.freshBlindRequired !== true) {
    blockers.push("m4b-synthetic-report-must-not-promote");
  }
  if (
    report?.promotionBoundary?.automaticAdoptionAuthorized !== false
    || report?.promotionBoundary?.studentFacing !== false
  ) {
    blockers.push("m4b-structure-poc-report-boundary-drift");
  }
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const measure = aggregate(cases, "measureBoxes");
  const meter = aggregate(cases, "meterRegions");
  if (!compareSummary(measure, report?.metrics?.measureBoxes)) blockers.push("m4b-measure-metric-summary-mismatch");
  if (!compareSummary(meter, report?.metrics?.meterRegions)) blockers.push("m4b-meter-metric-summary-mismatch");
  const exact = cases.filter((row) => row.exactPageStructure === true).length;
  if (
    report?.metrics?.exactPageStructure?.passed !== exact
    || report?.metrics?.exactPageStructure?.total !== cases.length
    || report?.metrics?.exactPageStructure?.rate !== rounded(cases.length ? exact / cases.length : 0)
  ) {
    blockers.push("m4b-exact-structure-summary-mismatch");
  }
  const injections = Array.isArray(report?.conflictInjections) ? report.conflictInjections : [];
  const caught = injections.filter((row) => row.caught === true).length;
  if (
    injections.length !== 12
    || report?.metrics?.structureConflictReviewRequired?.caught !== caught
    || report?.metrics?.structureConflictReviewRequired?.total !== injections.length
    || report?.metrics?.structureConflictReviewRequired?.rate !== rounded(injections.length ? caught / injections.length : 0)
  ) {
    blockers.push("m4b-conflict-injection-summary-mismatch");
  }
  if (report?.engineeringReady !== true || cases.some((row) => row.structureReviewRequired !== false)) {
    blockers.push("m4b-structure-poc-engineering-summary-mismatch");
  }
  if (
    promotion?.contract !== "western-m4b-fresh-blind-promotion-evaluation-v1"
    || promotion?.complete !== true
    || promotion?.operationalReady !== true
    || promotion?.evidenceClass !== "fresh-blind-test-only"
  ) {
    blockers.push("m4b-fresh-promotion-report-contract-mismatch");
  }
  if (
    promotion?.boundary?.expandedInvestmentOnly !== true
    || promotion?.boundary?.automaticAdoptionAuthorized !== false
    || promotion?.boundary?.studentFacing !== false
    || promotion?.boundary?.freshBlindTrainingEligible !== false
  ) {
    blockers.push("m4b-fresh-promotion-boundary-drift");
  }
  if (promotion?.promotionReady === true) {
    const counts = promotion.counts || {};
    const minimums = promotion.freshBlindMinimums || {};
    const comparison = promotion.thresholdComparison || {};
    if (
      counts.validRows < minimums.pages
      || counts.piecesOrLayouts < minimums.piecesOrLayouts
      || counts.devices < minimums.devices
      || Object.keys(promotion.thresholds || {}).some((key) => comparison?.[key]?.passes !== true)
      || (promotion.blockingReasons || []).length > 0
    ) {
      blockers.push("m4b-fresh-promotion-summary-invalid");
    }
  } else if (!Array.isArray(promotion?.blockingReasons) || promotion.blockingReasons.length === 0) {
    blockers.push("m4b-fresh-promotion-blocker-missing");
  }
  return blockers;
}

export async function auditM4bStructurePoc(repoRoot = process.cwd()) {
  const blockers = [];
  const config = await readJson(repoRoot, M4B_STRUCTURE_POC_POLICY_PATH, "m4b-structure-poc-policy", blockers);
  if (!config) {
    return {
      ready: false,
      engineeringReady: false,
      promotionOperationalReady: false,
      promotionReady: false,
      source: M4B_STRUCTURE_POC_POLICY_PATH.replace(/\\/g, "/"),
      blockingReasons: unique(blockers),
      promotionBlockingReasons: ["m4b-structure-poc-audit-not-ready"],
    };
  }
  const reportPath = path.join(config.outputRoot, "report.json").replace(/\\/g, "/");
  const promotionPath = path.join(config.outputRoot, "fresh-blind-promotion-report.json").replace(/\\/g, "/");
  const report = await readJson(repoRoot, reportPath, "m4b-structure-poc-report", blockers);
  const promotion = await readJson(repoRoot, promotionPath, "m4b-fresh-promotion-report", blockers);
  blockers.push(...evaluateReportContracts({ config, report, promotion }));

  for (const [key, label] of [
    ["policy", "m4b-structure-policy"],
    ["manifest", "m4b-structure-manifest"],
    ["evaluator", "m4b-structure-evaluator"],
  ]) {
    await verifyArtifact(repoRoot, report?.provenance?.[key], report?.provenance?.[`${key}Sha256`], label, blockers);
  }
  await verifyArtifact(
    repoRoot,
    report?.promotionBoundary?.signedDecision,
    report?.promotionBoundary?.signedDecisionSha256,
    "m4b-structure-signed-decision",
    blockers,
  );
  for (const row of report?.cases || []) {
    const label = String(row.caseId || "unknown").replace(/[^a-zA-Z0-9-]/g, "-");
    await verifyArtifact(repoRoot, row.result, row.resultSha256, `m4b-structure-${label}-result`, blockers);
    await verifyArtifact(repoRoot, row.overlay, row.overlaySha256, `m4b-structure-${label}-overlay`, blockers);
    const result = await readJson(repoRoot, row.result, `m4b-structure-${label}-result`, blockers);
    if (
      result?.reviewRequired !== true
      || result?.studentFacing !== false
      || result?.automaticAdoptionAuthorized !== false
      || result?.silentGuess !== false
      || result?.structureGraph?.silentGuess !== false
      || result?.structureGraph?.automaticAdoptionAuthorized !== false
      || result?.contentChallenger?.shadowOnly !== true
      || result?.contentChallenger?.productionCandidatePool !== false
      || result?.contentChallenger?.studentFacing !== false
    ) {
      blockers.push(`m4b-structure-${label}-safety-boundary-invalid`);
    }
    await verifyArtifact(repoRoot, result?.photo, result?.photoSha256, `m4b-structure-${label}-photo`, blockers);
  }

  for (const [key, label] of [
    ["structurePolicy", "m4b-promotion-structure-policy"],
    ["datasetPolicy", "m4b-promotion-dataset-policy"],
    ["signedDecision", "m4b-promotion-signed-decision"],
    ["evaluator", "m4b-promotion-evaluator"],
  ]) {
    await verifyArtifact(repoRoot, promotion?.provenance?.[key], promotion?.provenance?.[`${key}Sha256`], label, blockers);
  }
  if (promotion?.provenance?.datasetManifest) {
    await verifyArtifact(
      repoRoot,
      promotion.provenance.datasetManifest,
      promotion.provenance.datasetManifestSha256,
      "m4b-promotion-dataset-manifest",
      blockers,
    );
  }
  if (promotion?.provenance?.intakePresent === true) {
    await verifyArtifact(repoRoot, promotion.provenance.intake, promotion.provenance.intakeSha256, "m4b-promotion-intake", blockers);
  } else if (promotion?.provenance?.intake) {
    const intake = resolveInside(repoRoot, promotion.provenance.intake);
    if (!intake) {
      blockers.push("m4b-promotion-intake-path-invalid");
    } else {
      try {
        await fs.access(intake);
        blockers.push("m4b-promotion-intake-presence-drift");
      } catch {
        // A missing fresh-blind intake is the expected current blocked state.
      }
    }
  }
  const auditReady = blockers.length === 0;
  const promotionReady = auditReady && promotion?.promotionReady === true;
  return {
    ready: auditReady,
    engineeringReady: auditReady && report?.engineeringReady === true,
    promotionOperationalReady: auditReady && promotion?.operationalReady === true,
    promotionReady,
    source: reportPath,
    promotionSource: promotionPath,
    blockingReasons: unique(blockers),
    promotionBlockingReasons: promotionReady
      ? []
      : unique([...(promotion?.blockingReasons || []), ...(auditReady ? [] : ["m4b-structure-poc-audit-not-ready"])]),
    metrics: report?.metrics || null,
    syntheticThresholdComparison: report?.syntheticThresholdComparison || null,
    freshBlindCounts: promotion?.counts || null,
    freshBlindMetrics: promotion?.metrics || null,
    boundary: promotion?.boundary || null,
  };
}

async function main() {
  const result = await auditM4bStructurePoc();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
