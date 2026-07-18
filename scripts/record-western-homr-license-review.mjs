import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUT = path.join("config", "third-party", "homr-0.7.0-review.json");
const APPROVED_SCOPE = "controlled-offline-review-only";

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, notes: "", unknownArguments: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--decision") args.decision = argv[++index];
    else if (arg === "--by") args.by = argv[++index];
    else if (arg === "--at") args.at = argv[++index];
    else if (arg === "--notes") args.notes = argv[++index] || "";
    else if (arg === "--out") args.out = argv[++index] || DEFAULT_OUT;
    else if (arg === "--model-license-basis") args.modelLicenseBasis = argv[++index];
    else if (arg === "--confirm-controlled-offline-only") args.confirmControlledOfflineOnly = true;
    else if (arg === "--confirm-model-license-basis") args.confirmModelLicenseBasis = true;
    else if (arg === "--confirm-no-model-redistribution") args.confirmNoModelRedistribution = true;
    else args.unknownArguments.push(arg);
  }
  return args;
}

function rel(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function validTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

export function validateHomrLicenseDecisionArgs(args = {}) {
  const decision = String(args.decision || "").trim().toLowerCase();
  const reviewedBy = String(args.by || "").trim();
  const modelLicenseBasis = String(args.modelLicenseBasis || "").trim();
  const errors = [];
  if (!["approve", "defer"].includes(decision)) {
    errors.push("decision-must-be-approve-or-defer");
  }
  if (!reviewedBy) errors.push("reviewed-by-required");
  if (args.at && !validTimestamp(String(args.at))) errors.push("reviewed-at-invalid");
  if ((args.unknownArguments || []).length > 0) errors.push("unknown-arguments");
  if (decision === "approve") {
    if (!modelLicenseBasis) errors.push("model-license-basis-required");
    if (args.confirmControlledOfflineOnly !== true) {
      errors.push("approve-requires-confirm-controlled-offline-only");
    }
    if (args.confirmModelLicenseBasis !== true) {
      errors.push("approve-requires-confirm-model-license-basis");
    }
    if (args.confirmNoModelRedistribution !== true) {
      errors.push("approve-requires-confirm-no-model-redistribution");
    }
  }
  return { decision, reviewedBy, modelLicenseBasis, errors };
}

function validateBaseRecord(record) {
  const errors = [];
  const distribution = record?.evidence?.localDistribution || {};
  const executable = distribution.executable || {};
  const wheelArchive = distribution.wheelArchive || {};
  const portableRecord = distribution.portableRecord || {};
  if (record?.schemaVersion !== 1) errors.push("unsupported-review-schema");
  if (record?.component?.name !== "homr") errors.push("component-must-be-homr");
  if (record?.component?.version !== "0.7.0") errors.push("component-version-must-be-0.7.0");
  if (record?.component?.declaredLicense !== "AGPL-3.0") errors.push("declared-license-must-be-agpl-3.0");
  if (record?.integration?.mode !== "unmodified-external-cli-subprocess") {
    errors.push("integration-mode-not-approvable");
  }
  if (record?.integration?.sourceModified !== false) errors.push("modified-source-not-approvable");
  if (record?.integration?.packageImportedInProjectProcess !== false) {
    errors.push("in-process-import-not-approvable");
  }
  if (!Number.isInteger(record?.integration?.contractVersion)) {
    errors.push("integration-contract-version-required");
  }
  if (record?.integration?.controlledProductionRequiresCompleteEnginePool !== true) {
    errors.push("controlled-production-complete-engine-pool-required");
  }
  if (record?.integration?.controlledProductionWrapper !== "scripts/run-western-photo-score-python.ps1") {
    errors.push("controlled-production-wrapper-invalid");
  }
  if (record?.integration?.controlledProductionRequiredFlag !== "--require-complete-engine-pool") {
    errors.push("controlled-production-required-flag-invalid");
  }
  if (record?.integration?.missingExecutableBehavior?.controlledProductionWrapper
      !== "fail-before-analysis-with-required-engine-pool-incomplete") {
    errors.push("controlled-production-missing-engine-behavior-invalid");
  }
  if (record?.deployment?.targetRuntimeRoot !== "data/tools/homr-0.7.0-ort1.27.0") {
    errors.push("deployment-target-runtime-root-invalid");
  }
  if (distribution.runtimeRoot !== record?.deployment?.targetRuntimeRoot) {
    errors.push("reviewed-runtime-root-must-match-deployment-target");
  }
  if (executable.bindingMode !== "record-verified-console-entry-point"
      || executable.relativePath !== "Scripts/homr.exe"
      || executable.recordEntry !== "../../Scripts/homr.exe"
      || executable.consoleEntryPoint !== "homr=homr.main:main"
      || executable.observedHostSha256IsApprovalBinding !== false) {
    errors.push("executable-binding-contract-invalid");
  }
  for (const [field, value] of Object.entries({
    observedExecutableSha256: executable.observedHostSha256,
    wheelArchiveSha256: wheelArchive.sha256,
    portableRecordSha256: portableRecord.sha256,
    metadataSha256: distribution.metadataSha256,
    licenseSha256: distribution.licenseSha256,
  })) {
    if (!/^[a-f0-9]{64}$/i.test(String(value || ""))) errors.push(`${field}-required`);
  }
  if (wheelArchive.path !== "data/tools/wheelhouse/western-photo-score-homr/homr-0.7.0-py3-none-any.whl"
      || !Number.isInteger(wheelArchive.bytes) || wheelArchive.bytes <= 0) {
    errors.push("wheel-archive-binding-invalid");
  }
  if (portableRecord.algorithm !== "sha256-normalized-lf-excluding-path-sensitive-launcher-row-v1"
      || portableRecord.excludedEntry !== executable.recordEntry
      || !Number.isInteger(portableRecord.lineCount) || portableRecord.lineCount <= 0
      || distribution.wheelRecordHashedFileCount !== 49
      || distribution.wheelRecordVerifiedHashedFileCount !== distribution.wheelRecordHashedFileCount
      || distribution.wheelRecordMismatchCount !== 0) {
    errors.push("portable-record-binding-invalid");
  }
  if (!Array.isArray(record?.modelArtifacts) || record.modelArtifacts.length !== 6) {
    errors.push("model-artifact-manifest-required");
  } else if (record.modelArtifacts.some((artifact) => (
    !String(artifact?.package || "").trim()
    || !String(artifact?.relativePath || "").trim()
    || !String(artifact?.name || "").trim()
    || path.posix.basename(String(artifact.relativePath).replace(/\\/g, "/")) !== artifact.name
    || !Number.isInteger(artifact?.bytes) || artifact.bytes <= 0
    || !/^[a-f0-9]{64}$/i.test(String(artifact?.sha256 || ""))
  ))) {
    errors.push("model-artifact-manifest-invalid");
  } else if (new Set(record.modelArtifacts.map((artifact) => `${artifact.package}:${rel(artifact.relativePath)}`)).size
      !== record.modelArtifacts.length) {
    errors.push("model-artifact-manifest-duplicated");
  }
  return errors;
}

function approvalBinding(record) {
  const distribution = record.evidence.localDistribution;
  const executable = distribution.executable;
  return {
    bindingVersion: 2,
    componentVersion: record.component.version,
    integrationContractVersion: record.integration.contractVersion,
    executable: {
      bindingMode: executable.bindingMode,
      relativePath: executable.relativePath,
      recordEntry: executable.recordEntry,
      consoleEntryPoint: executable.consoleEntryPoint,
    },
    wheelArchive: {
      bytes: distribution.wheelArchive.bytes,
      sha256: distribution.wheelArchive.sha256,
    },
    portableRecord: {
      algorithm: distribution.portableRecord.algorithm,
      excludedEntry: distribution.portableRecord.excludedEntry,
      lineCount: distribution.portableRecord.lineCount,
      sha256: distribution.portableRecord.sha256,
      hashedFileCount: distribution.wheelRecordHashedFileCount,
    },
    metadataSha256: distribution.metadataSha256,
    licenseSha256: distribution.licenseSha256,
    deploymentTargetRuntimeRoot: record.deployment.targetRuntimeRoot,
    modelArtifacts: record.modelArtifacts.map(({
      package: packageName,
      relativePath,
      name,
      bytes,
      sha256,
    }) => ({ package: packageName, relativePath, name, bytes, sha256 })),
  };
}

export async function writeHomrLicenseReviewDecision(args = {}) {
  const resolved = {
    out: args.out || DEFAULT_OUT,
    notes: args.notes || "",
    decision: args.decision,
    by: args.by,
    at: args.at,
    modelLicenseBasis: args.modelLicenseBasis,
    confirmControlledOfflineOnly: args.confirmControlledOfflineOnly,
    confirmModelLicenseBasis: args.confirmModelLicenseBasis,
    confirmNoModelRedistribution: args.confirmNoModelRedistribution,
    unknownArguments: args.unknownArguments || [],
  };
  const validation = validateHomrLicenseDecisionArgs(resolved);
  if (validation.errors.length > 0) {
    return {
      ok: false,
      out: rel(resolved.out),
      errors: validation.errors,
      usage: [
        "Defer/no-go:",
        "node scripts/record-western-homr-license-review.mjs --decision defer --by reviewer-name",
        "Approve controlled offline review only:",
        "node scripts/record-western-homr-license-review.mjs --decision approve --by reviewer-name --model-license-basis \"reviewed evidence\" --confirm-controlled-offline-only --confirm-model-license-basis --confirm-no-model-redistribution",
      ],
    };
  }

  let record;
  try {
    record = JSON.parse(await fs.readFile(resolved.out, "utf8"));
  } catch (error) {
    return {
      ok: false,
      out: rel(resolved.out),
      errors: [error?.code === "ENOENT" ? "review-record-missing" : "review-record-invalid-json"],
    };
  }
  const recordErrors = validateBaseRecord(record);
  if (recordErrors.length > 0) {
    return { ok: false, out: rel(resolved.out), errors: recordErrors };
  }

  const reviewedAt = resolved.at || new Date().toISOString();
  const approved = validation.decision === "approve";
  if (approved) {
    record.modelLicenseReview = {
      status: "reviewer-confirmed-for-controlled-offline-use",
      basis: validation.modelLicenseBasis,
      controlledOfflineUseConfirmedByReviewer: true,
      redistributionAllowed: false,
      reviewedBy: validation.reviewedBy,
      reviewedAt,
    };
  }
  record.decision = {
    status: approved ? "approved-with-conditions" : "deferred",
    reviewedBy: validation.reviewedBy,
    reviewedAt,
    approvedScopes: approved ? [APPROVED_SCOPE] : [],
    controlledOfflineReviewApproved: approved,
    studentFacingNetworkUseApproved: false,
    redistributionApproved: false,
    notes: resolved.notes || (
      approved
        ? "Named reviewer approved controlled offline review only. Student-facing network use and redistribution remain prohibited."
        : "Named reviewer explicitly deferred HOMR use. No execution or distribution scope is approved."
    ),
    confirmations: {
      controlledOfflineOnly: approved && resolved.confirmControlledOfflineOnly === true,
      modelLicenseBasisReviewed: approved && resolved.confirmModelLicenseBasis === true,
      noModelRedistribution: approved && resolved.confirmNoModelRedistribution === true,
    },
    approvalBinding: approved ? approvalBinding(record) : null,
  };
  record.deployment = {
    ...(record.deployment || {}),
    status: approved
      ? "controlled-offline-approved-preflight-required"
      : "governance-deferred",
    notes: approved
      ? "The named license/model review and approval binding authorize controlled-offline-review-only. Every start still requires the tracked deployment preflight. Student-facing network use, automatic adoption, and redistribution remain prohibited. Local wheelhouse, models, and runtimes remain gitignored deployment artifacts."
      : "The named reviewer deferred HOMR use. Host artifacts may still be audited, but no execution or distribution scope is approved.",
  };

  await fs.mkdir(path.dirname(resolved.out), { recursive: true });
  await fs.writeFile(resolved.out, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return {
    ok: true,
    out: rel(resolved.out),
    decision: validation.decision,
    status: record.decision.status,
    reviewedBy: record.decision.reviewedBy,
    reviewedAt: record.decision.reviewedAt,
    controlledOfflineReviewApproved: record.decision.controlledOfflineReviewApproved,
    studentFacingNetworkUseApproved: false,
    redistributionApproved: false,
    runtimeChanged: false,
  };
}

async function main() {
  const result = await writeHomrLicenseReviewDecision(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
