import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildProjectStatus } from "./status-western-strings-project.mjs";

const DEFAULT_RELEASE = path.join("models", "western-strings", "ordinary-upload-confidence-rf-v1", "release.json");
const DEFAULT_AUDIT = path.join("data", "experiments", "western-strings-m3", "confidence-validation-review", "ordinary-confidence-release-audit.json");
const DEFAULT_PRECISION_REVIEW = path.join("data", "experiments", "western-strings-m3", "ordinary-auto-pass-precision-review", "ordinary-auto-pass-precision-review-summary.json");
const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3", "ordinary-monitored-pilot");

function parseArgs(argv) {
  const args = {
    release: DEFAULT_RELEASE,
    audit: DEFAULT_AUDIT,
    precisionReview: DEFAULT_PRECISION_REVIEW,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--release") args.release = argv[++index] || args.release;
    else if (arg === "--audit") args.audit = argv[++index] || args.audit;
    else if (arg === "--precision-review") args.precisionReview = argv[++index] || args.precisionReview;
    else if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonOrNull(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function toRel(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function renderMarkdown(plan) {
  return [
    "# Historical Ordinary Upload RF Pilot Plan (Superseded)",
    "",
    `Generated: ${plan.generatedAt}`,
    "",
    "## Decision",
    "",
    `- readyForPilotPlan: ${plan.readyForPilotPlan}`,
    `- authorizationStatus: ${plan.authorizationStatus}`,
    `- supersededBy: ${plan.supersededBy}`,
    `- defaultRuntimeEnabled: ${plan.defaultRuntimeEnabled}`,
    `- enableEnvVar: ${plan.enableEnvVar}`,
    `- releaseManifest: ${plan.releaseManifest}`,
    `- releaseAudit: ${plan.releaseAudit}`,
    "",
    "## Evidence",
    "",
    `- pilotOutOfFoldPrecision: ${plan.evidence.pilotOutOfFoldPrecision}`,
    `- pilotOutOfFoldCoverage: ${plan.evidence.pilotOutOfFoldCoverage}`,
    `- blindValidationPrecision: ${plan.evidence.blindValidationPrecision}`,
    `- thresholdPoolPrecision: ${plan.evidence.thresholdPoolPrecision}`,
    `- thresholdPoolCoverage: ${plan.evidence.thresholdPoolCoverage}`,
    `- precisionPrecheckOk: ${plan.evidence.precisionPrecheckOk}`,
    `- precisionPrecheckSelfChecked: ${plan.evidence.precisionPrecheckSelfChecked}`,
    `- precisionPrecheckKnownUsable: ${plan.evidence.precisionPrecheckKnownUsable}`,
    `- precisionPrecheckKnownWrong: ${plan.evidence.precisionPrecheckKnownWrong}`,
    `- precisionPrecheckUnknownReviewRows: ${plan.evidence.precisionPrecheckUnknownReviewRows}`,
    `- threshold: ${plan.evidence.threshold}`,
    "",
    "## Current Scope",
    "",
    "- This report preserves RF calibration history only.",
    "- It cannot authorize a monitored pilot or any student-facing runtime.",
    "- Do not enable the historical RF environment flag, even temporarily as release evidence.",
    "- Current ordinary-upload work must use the review-only dynamic-shadow contract and later fresh-blind authorization evidence.",
    "",
    "## Safe Commands",
    "",
    "```powershell",
    "npm run test:western-project-gate",
    "npm run western:project-status",
    "```",
    "",
    "## Abort Criteria",
    "",
    "- Any unsafe false positive in monitored review.",
    "- Any score-audio mismatch source entering auto_pass.",
    "- Any failure of `npm run test:western-project-gate`.",
    "- Any change that makes ordinaryUploadAutoFeedbackReady true by default.",
    "",
    "## Blocking Reasons",
    "",
    ...(plan.blockingReasons.length ? plan.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
  ].join("\n");
}

export async function buildOrdinaryMonitoredPilotPlan(args = {}) {
  const releasePath = path.resolve(args.release || DEFAULT_RELEASE);
  const auditPath = path.resolve(args.audit || DEFAULT_AUDIT);
  const precisionReviewPath = path.resolve(args.precisionReview || DEFAULT_PRECISION_REVIEW);
  const outDir = path.resolve(args.outDir || DEFAULT_OUT_DIR);
  const release = await readJson(releasePath);
  const audit = await readJson(auditPath);
  const precisionReview = await readJsonOrNull(precisionReviewPath);
  const status = await buildProjectStatus();
  const controlled = status.tracks?.controlledCandidate || {};

  const blockingReasons = [];
  blockingReasons.push("ordinary-rf-monitored-pilot-authorization-superseded");
  if (release.enabledByDefault !== false) blockingReasons.push("release-manifest-must-be-disabled-by-default");
  if (!release.enableEnvVar) blockingReasons.push("release-manifest-enable-env-missing");
  if (audit.ok !== true) blockingReasons.push("release-audit-not-ok");
  if (audit.thresholdPoolReviewedSample?.blindValidationPassed !== true) blockingReasons.push("threshold-pool-validation-not-passed");
  if (!Array.isArray(audit.releaseReadiness?.blockingReasons) || !audit.releaseReadiness.blockingReasons.includes("ordinary-auto-gate-disabled-by-default")) {
    blockingReasons.push("release-audit-missing-default-disabled-blocker");
  }
  if (status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady !== false) blockingReasons.push("ordinary-runtime-default-not-fail-closed");
  if (!controlled.confidencePilot?.runtimeGateWired) blockingReasons.push("ordinary-runtime-gate-not-wired");
  if (!precisionReview) blockingReasons.push("ordinary-precision-precheck-missing");
  else {
    if (precisionReview.ok !== true) blockingReasons.push("ordinary-precision-precheck-failed");
    if ((precisionReview.selfCheckedAutoPassCandidateCount || 0) <= 0) blockingReasons.push("ordinary-precision-precheck-no-self-checked-auto-pass");
    if ((precisionReview.knownWrongAutoPassCandidateCount || 0) > 0) blockingReasons.push("ordinary-precision-precheck-known-wrong-auto-pass");
    if ((precisionReview.unknownReviewCandidateCount || 0) > 0) blockingReasons.push("ordinary-precision-precheck-has-unknown-review-rows");
  }

  const plan = {
    ok: blockingReasons.length === 0,
    generatedAt: new Date().toISOString(),
    readyForPilotPlan: blockingReasons.length === 0,
    authorizationStatus: "superseded-historical-rf-only",
    supersededBy: "western-ordinary-dynamic-shadow-policy-v1",
    defaultRuntimeEnabled: status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === true,
    enableEnvVar: release.enableEnvVar || "WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE",
    releaseManifest: toRel(releasePath),
    releaseAudit: toRel(auditPath),
    precisionReview: toRel(precisionReviewPath),
    evidence: {
      threshold: audit.threshold ?? release.threshold ?? null,
      pilotOutOfFoldPrecision: audit.pilotOutOfFold?.precision ?? null,
      pilotOutOfFoldCoverage: audit.pilotOutOfFold?.coverageWithinRows ?? null,
      blindValidationPrecision: audit.validationReviewedSample?.precision ?? release.blindValidation?.precision ?? null,
      thresholdPoolPrecision: audit.thresholdPoolReviewedSample?.runtimePolicy?.precision ?? release.thresholdPoolValidation?.precision ?? null,
      thresholdPoolCoverage: audit.thresholdPoolReviewedSample?.runtimePolicy?.coverageWithinReviewedSample ?? release.thresholdPoolValidation?.coverage ?? null,
      precisionPrecheckOk: precisionReview?.ok === true,
      precisionPrecheckSelfChecked: precisionReview?.selfCheckedAutoPassCandidateCount ?? 0,
      precisionPrecheckKnownUsable: precisionReview?.knownUsableAutoPassCandidateCount ?? 0,
      precisionPrecheckKnownWrong: precisionReview?.knownWrongAutoPassCandidateCount ?? 0,
      precisionPrecheckUnknownReviewRows: precisionReview?.unknownReviewCandidateCount ?? 0,
    },
    blockingReasons,
    outDir: toRel(outDir),
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "ordinary-monitored-pilot-plan.json");
  const mdPath = path.join(outDir, "ordinary-monitored-pilot-plan.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(plan), "utf8");
  return { plan, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { plan, jsonPath, mdPath } = await buildOrdinaryMonitoredPilotPlan(args);
  console.log(JSON.stringify({
    ok: plan.ok,
    readyForPilotPlan: plan.readyForPilotPlan,
    blockingReasons: plan.blockingReasons,
    out: {
      json: toRel(jsonPath),
      md: toRel(mdPath),
    },
  }, null, 2));
  if (!plan.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
