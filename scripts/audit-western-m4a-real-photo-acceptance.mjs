import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const M4A_REAL_PHOTO_POLICY_PATH = path.join("config", "western-m4a-real-photo-acceptance.json");

const FROZEN_THRESHOLDS = Object.freeze({
  minimumPositivePhotos: 10,
  minimumPositivePassRate: 0.9,
  ownerMeasureBoxConfirmationRate: 1.0,
  minimumWrongEditionPhotos: 5,
  maximumWrongEditionLeakCount: 0,
  requiredPoorImageTransforms: ["gaussian-blur", "half-page-crop"],
  maximumPoorImageLeakCount: 0,
});
const FROZEN_SAFETY = Object.freeze({
  reviewRequired: true,
  studentFacing: false,
  automaticAdoptionAuthorized: false,
  omrAllowed: false,
});

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unique(rows) {
  return [...new Set(rows)];
}

export function evaluateM4aRealPhotoAcceptance({ config, report }) {
  const integrityBlockingReasons = [];
  if (config?.contract !== "western-m4a-real-photo-acceptance-policy-v1") {
    integrityBlockingReasons.push("m4a-real-photo-policy-contract-mismatch");
  }
  if (config?.evidenceClass !== "frozen-real-screen-photo-acceptance") {
    integrityBlockingReasons.push("m4a-real-photo-policy-evidence-class-mismatch");
  }
  if (!sameJson(config?.thresholds, FROZEN_THRESHOLDS)) {
    integrityBlockingReasons.push("m4a-real-photo-threshold-drift");
  }
  if (!sameJson(config?.safety, FROZEN_SAFETY)) {
    integrityBlockingReasons.push("m4a-real-photo-safety-policy-drift");
  }
  const positiveTasks = Array.isArray(config?.positiveCaptureTasks) ? config.positiveCaptureTasks : [];
  const wrongTasks = Array.isArray(config?.wrongEditionCases) ? config.wrongEditionCases : [];
  if (positiveTasks.length !== 10 || new Set(positiveTasks.map((row) => row.caseId)).size !== 10) {
    integrityBlockingReasons.push("m4a-real-photo-positive-task-contract-mismatch");
  }
  if (wrongTasks.length < 5 || new Set(wrongTasks.map((row) => row.caseId)).size !== wrongTasks.length) {
    integrityBlockingReasons.push("m4a-real-photo-wrong-edition-task-contract-mismatch");
  }
  if (report?.contract !== "western-m4a-real-photo-acceptance-v1" || report?.complete !== true) {
    integrityBlockingReasons.push("m4a-real-photo-report-contract-mismatch");
  }
  if (report?.evidenceClass !== config?.evidenceClass) {
    integrityBlockingReasons.push("m4a-real-photo-report-evidence-class-mismatch");
  }
  if (!sameJson(report?.thresholds, config?.thresholds) || !sameJson(report?.safety, config?.safety)) {
    integrityBlockingReasons.push("m4a-real-photo-report-policy-binding-mismatch");
  }
  const positives = Array.isArray(report?.positiveCases) ? report.positiveCases : [];
  const wrongRows = Array.isArray(report?.wrongEditionCases) ? report.wrongEditionCases : [];
  const poorRows = Array.isArray(report?.poorImageCases) ? report.poorImageCases : [];
  if (!sameJson(positives.map((row) => row.caseId), positiveTasks.map((row) => row.caseId))) {
    integrityBlockingReasons.push("m4a-real-photo-positive-case-list-mismatch");
  }
  if (!sameJson(wrongRows.map((row) => row.caseId), wrongTasks.map((row) => row.caseId))) {
    integrityBlockingReasons.push("m4a-real-photo-wrong-edition-case-list-mismatch");
  }
  const checks = report?.checks || {};
  const checkNames = [
    "positivePhotoCount",
    "positivePassRate",
    "ownerMeasureBoxConfirmation",
    "wrongEditionCount",
    "wrongEditionLeakCount",
    "poorImageCoverage",
    "poorImageLeakCount",
    "reviewOnlySafety",
  ];
  if (checkNames.some((name) => typeof checks[name] !== "boolean")) {
    integrityBlockingReasons.push("m4a-real-photo-checks-incomplete");
  }
  const recomputedReady = checkNames.every((name) => checks[name] === true);
  if (report?.acceptanceReady !== recomputedReady) {
    integrityBlockingReasons.push("m4a-real-photo-ready-summary-mismatch");
  }
  const availablePositives = positives.filter((row) => row.available === true);
  const passedPositives = availablePositives.filter((row) => row.ready === true);
  const positiveRate = availablePositives.length ? passedPositives.length / availablePositives.length : 0;
  if (
    report?.summary?.positiveAvailable !== availablePositives.length
    || report?.summary?.positivePassed !== passedPositives.length
    || Math.abs(Number(report?.summary?.positivePassRate || 0) - positiveRate) > 1e-6
  ) {
    integrityBlockingReasons.push("m4a-real-photo-positive-summary-mismatch");
  }
  const availableWrong = wrongRows.filter((row) => row.available === true);
  const wrongBlocked = availableWrong.filter((row) => row.blocked === true);
  if (
    report?.summary?.wrongEditionAvailable !== availableWrong.length
    || report?.summary?.wrongEditionBlocked !== wrongBlocked.length
    || report?.summary?.wrongEditionLeakCount !== availableWrong.length - wrongBlocked.length
  ) {
    integrityBlockingReasons.push("m4a-real-photo-wrong-edition-summary-mismatch");
  }
  const poorBlocked = poorRows.filter((row) => row.blocked === true);
  if (
    report?.summary?.poorImageEvaluated !== poorRows.length
    || report?.summary?.poorImageBlocked !== poorBlocked.length
    || report?.summary?.poorImageLeakCount !== poorRows.length - poorBlocked.length
  ) {
    integrityBlockingReasons.push("m4a-real-photo-poor-image-summary-mismatch");
  }
  for (const row of [...availablePositives, ...availableWrong, ...poorRows]) {
    if (
      row.omrUsed !== false
      || row.reviewRequired !== true
      || row.studentFacing !== false
      || row.automaticAdoptionAuthorized !== false
      || row.autoDiagnosisIssued !== false
    ) {
      integrityBlockingReasons.push(`m4a-real-photo-safety-row-violated:${row.caseId || "unknown"}`);
    }
  }
  for (const row of passedPositives) {
    if (
      row.feedbackProjection?.ready !== true
      || row.feedbackProjection?.mappedAnchorCount !== row.projectedCounts?.notes
      || !row.measureReviewOverlay
      || !row.measureReviewOverlaySha256
    ) {
      integrityBlockingReasons.push(`m4a-real-photo-positive-projection-incomplete:${row.caseId || "unknown"}`);
    }
  }
  if (!report?.acceptanceReady && !Array.isArray(report?.blockingReasons)) {
    integrityBlockingReasons.push("m4a-real-photo-blocking-reasons-missing");
  }
  return {
    operationalReady: integrityBlockingReasons.length === 0,
    acceptanceReady: integrityBlockingReasons.length === 0 && report?.acceptanceReady === true,
    integrityBlockingReasons: unique(integrityBlockingReasons),
    acceptanceBlockingReasons: Array.isArray(report?.blockingReasons) ? report.blockingReasons : [],
  };
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

export async function auditM4aRealPhotoAcceptance(repoRoot = process.cwd()) {
  let config;
  let report;
  try {
    config = JSON.parse(await fs.readFile(path.resolve(repoRoot, M4A_REAL_PHOTO_POLICY_PATH), "utf8"));
  } catch (error) {
    return {
      ready: false,
      operationalReady: false,
      source: M4A_REAL_PHOTO_POLICY_PATH.replace(/\\/g, "/"),
      blockingReasons: ["m4a-real-photo-policy-missing-or-invalid"],
      error: String(error?.message || error),
    };
  }
  const reportPath = path.join(config.outputRoot || "", "report.json");
  try {
    report = JSON.parse(await fs.readFile(path.resolve(repoRoot, reportPath), "utf8"));
  } catch (error) {
    return {
      ready: false,
      operationalReady: false,
      source: reportPath.replace(/\\/g, "/"),
      blockingReasons: ["m4a-real-photo-report-missing-or-invalid"],
      error: String(error?.message || error),
    };
  }
  const evaluation = evaluateM4aRealPhotoAcceptance({ config, report });
  const integrityBlockingReasons = [...evaluation.integrityBlockingReasons];
  for (const [key, label] of [
    ["policy", "m4a-real-photo-policy"],
    ["implementation", "m4a-real-photo-implementation"],
    ["registry", "m4a-real-photo-registry"],
  ]) {
    await verifyArtifact(
      repoRoot,
      report?.provenance?.[key],
      report?.provenance?.[`${key}Sha256`],
      label,
      integrityBlockingReasons,
    );
  }
  for (const row of [
    ...(report.positiveCases || []).filter((candidate) => candidate.available === true),
    ...(report.wrongEditionCases || []).filter((candidate) => candidate.available === true),
    ...(report.poorImageCases || []),
  ]) {
    const caseLabel = String(row.caseId || "unknown").replace(/[^a-zA-Z0-9-]/g, "-");
    for (const [field, hashField, suffix] of [
      ["photo", "photoSha256", "photo"],
      ["audio", "audioSha256", "audio"],
      ["audit", "auditSha256", "audit"],
      ["diagnosticOverlay", "diagnosticOverlaySha256", "diagnostic-overlay"],
      ["measureReviewOverlay", "measureReviewOverlaySha256", "measure-overlay"],
    ]) {
      if (row[field]) {
        await verifyArtifact(
          repoRoot,
          row[field],
          row[hashField],
          `m4a-real-photo-${caseLabel}-${suffix}`,
          integrityBlockingReasons,
        );
      }
    }
  }
  if (report.ownerReview?.source) {
    await verifyArtifact(
      repoRoot,
      report.ownerReview.source,
      report.ownerReview.sha256,
      "m4a-real-photo-owner-review",
      integrityBlockingReasons,
    );
  }
  const operationalReady = integrityBlockingReasons.length === 0;
  const acceptanceBlockingReasons = evaluation.acceptanceBlockingReasons;
  return {
    ready: operationalReady && report.acceptanceReady === true,
    operationalReady,
    source: reportPath.replace(/\\/g, "/"),
    blockingReasons: unique([...integrityBlockingReasons, ...acceptanceBlockingReasons]),
    integrityBlockingReasons: unique(integrityBlockingReasons),
    evidenceClass: report.evidenceClass,
    evidenceDigest: report.evidenceDigest,
    checks: report.checks,
    summary: report.summary,
    ownerReview: report.ownerReview,
  };
}

async function main() {
  const result = await auditM4aRealPhotoAcceptance();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
