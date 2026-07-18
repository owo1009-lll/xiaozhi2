import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const M4A_ENGINEERING_REPORT_PATH = path.join(
  "data",
  "experiments",
  "western-strings-m4a",
  "engineering-acceptance",
  "report.json",
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function unique(rows) {
  return [...new Set(rows)];
}

export function evaluateM4aEngineeringAcceptance(report) {
  const blockingReasons = [];
  if (report?.contract !== "western-m4a-engineering-acceptance-v1") {
    blockingReasons.push("m4a-engineering-contract-mismatch");
  }
  if (report?.complete !== true || report?.engineeringReady !== true) {
    blockingReasons.push("m4a-engineering-report-not-ready");
  }
  if (report?.evidenceClass !== "engineering-only-synthetic-positive-and-real-wrong-edition-negative") {
    blockingReasons.push("m4a-engineering-evidence-class-mismatch");
  }
  if (report?.doesNotSatisfyFrozenRealPhotoAcceptance !== true) {
    blockingReasons.push("m4a-engineering-real-acceptance-boundary-missing");
  }
  const positives = Array.isArray(report?.positives) ? report.positives : [];
  const negatives = Array.isArray(report?.negatives) ? report.negatives : [];
  if (positives.length !== 3) blockingReasons.push("m4a-engineering-positive-count-mismatch");
  if (negatives.length !== 4) blockingReasons.push("m4a-engineering-negative-count-mismatch");
  for (const row of positives) {
    if (row?.ready !== true) blockingReasons.push(`m4a-engineering-positive-failed:${row?.caseId || "unknown"}`);
    const projectedNotes = Number(row?.projectedCounts?.notes || 0);
    if (
      row?.feedbackProjection?.ready !== true
      || Number(row?.feedbackProjection?.expectedAnchorCount || 0) !== projectedNotes
      || Number(row?.feedbackProjection?.mappedAnchorCount || 0) !== projectedNotes
      || projectedNotes <= 0
    ) {
      blockingReasons.push(`m4a-engineering-feedback-projection-incomplete:${row?.caseId || "unknown"}`);
    }
    if (!row?.audit || !row?.auditSha256 || !row?.annotatedPhoto || !row?.annotatedPhotoSha256) {
      blockingReasons.push(`m4a-engineering-positive-artifact-missing:${row?.caseId || "unknown"}`);
    }
  }
  for (const row of negatives) {
    if (row?.ready !== false) blockingReasons.push(`m4a-engineering-negative-not-blocked:${row?.caseId || "unknown"}`);
  }
  for (const row of [...positives, ...negatives]) {
    if (row?.omrUsed !== false) blockingReasons.push(`m4a-engineering-omr-used:${row?.caseId || "unknown"}`);
    if (row?.reviewRequired !== true) blockingReasons.push(`m4a-engineering-review-boundary-missing:${row?.caseId || "unknown"}`);
    if (row?.studentFacing !== false || row?.automaticAdoptionAuthorized !== false) {
      blockingReasons.push(`m4a-engineering-release-boundary-violated:${row?.caseId || "unknown"}`);
    }
  }
  if (
    report?.summary?.positivePassed !== positives.length
    || report?.summary?.negativeBlocked !== negatives.length
    || report?.summary?.omrUsedCount !== 0
    || report?.summary?.studentFacingCount !== 0
  ) {
    blockingReasons.push("m4a-engineering-summary-mismatch");
  }
  return { ready: blockingReasons.length === 0, blockingReasons: unique(blockingReasons) };
}

function resolveInside(repoRoot, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const absolute = path.resolve(repoRoot, relativePath);
  const back = path.relative(repoRoot, absolute);
  if (back.startsWith("..") || path.isAbsolute(back)) return null;
  return absolute;
}

async function verifyArtifact(repoRoot, relativePath, expectedHash, label, blockingReasons) {
  const absolute = resolveInside(repoRoot, relativePath);
  if (!absolute) {
    blockingReasons.push(`${label}-path-invalid`);
    return;
  }
  try {
    const observed = sha256(await fs.readFile(absolute));
    if (!/^[a-f0-9]{64}$/.test(expectedHash || "") || observed !== expectedHash) {
      blockingReasons.push(`${label}-hash-mismatch`);
    }
  } catch {
    blockingReasons.push(`${label}-missing`);
  }
}

export async function auditM4aEngineeringAcceptance(repoRoot = process.cwd()) {
  const reportAbsolute = path.resolve(repoRoot, M4A_ENGINEERING_REPORT_PATH);
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportAbsolute, "utf8"));
  } catch (error) {
    return {
      ready: false,
      source: M4A_ENGINEERING_REPORT_PATH.replace(/\\/g, "/"),
      blockingReasons: ["m4a-engineering-report-missing-or-invalid"],
      error: String(error?.message || error),
    };
  }
  const evaluated = evaluateM4aEngineeringAcceptance(report);
  const blockingReasons = [...evaluated.blockingReasons];
  for (const [key, label] of [
    ["implementation", "m4a-engineering-implementation"],
    ["policy", "m4a-engineering-policy"],
    ["registry", "m4a-engineering-registry"],
  ]) {
    await verifyArtifact(
      repoRoot,
      report?.provenance?.[key],
      report?.provenance?.[`${key}Sha256`],
      label,
      blockingReasons,
    );
  }
  for (const row of [...(report.positives || []), ...(report.negatives || [])]) {
    const caseLabel = String(row?.caseId || "unknown").replace(/[^a-zA-Z0-9-]/g, "-");
    await verifyArtifact(repoRoot, row?.photo, row?.photoSha256, `m4a-engineering-${caseLabel}-photo`, blockingReasons);
    if (row?.audio) {
      await verifyArtifact(repoRoot, row.audio, row.audioSha256, `m4a-engineering-${caseLabel}-audio`, blockingReasons);
    }
    if (row?.audit) {
      await verifyArtifact(repoRoot, row.audit, row.auditSha256, `m4a-engineering-${caseLabel}-audit`, blockingReasons);
    }
    if (row?.annotatedPhoto) {
      await verifyArtifact(
        repoRoot,
        row.annotatedPhoto,
        row.annotatedPhotoSha256,
        `m4a-engineering-${caseLabel}-annotation`,
        blockingReasons,
      );
    }
  }
  return {
    ready: blockingReasons.length === 0,
    source: M4A_ENGINEERING_REPORT_PATH.replace(/\\/g, "/"),
    blockingReasons: unique(blockingReasons),
    evidenceClass: report.evidenceClass,
    doesNotSatisfyFrozenRealPhotoAcceptance: report.doesNotSatisfyFrozenRealPhotoAcceptance,
    summary: report.summary,
  };
}

async function main() {
  const result = await auditM4aEngineeringAcceptance();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
