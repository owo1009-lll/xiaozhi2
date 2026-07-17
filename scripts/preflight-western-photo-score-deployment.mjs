#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "config", "western-photo-score-deployment.json");
const DEFAULT_OUT = path.join(
  REPO_ROOT,
  "data",
  "experiments",
  "western-strings-m4",
  "photo-score-deployment-preflight.json",
);

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizePackageName(value) {
  return String(value || "").trim().toLowerCase().replace(/[_.]+/g, "-");
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  fields.push(value);
  return fields;
}

export function inspectWheelRecord({ recordText = "", recordPath = "", runtimeRoot = "", excludedEntry = "" } = {}) {
  const normalized = String(recordText).replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const entries = lines.filter(Boolean).map((line) => {
    const [entryPath = "", hash = "", size = ""] = parseCsvLine(line);
    return { entryPath: normalizePath(entryPath), hash, size, line };
  });
  const portableLines = lines.filter((line) => {
    if (!line) return true;
    const [entryPath = ""] = parseCsvLine(line);
    return normalizePath(entryPath) !== normalizePath(excludedEntry);
  });
  const portableText = portableLines.join("\n");
  const sitePackagesRoot = recordPath ? path.dirname(path.dirname(recordPath)) : "";
  const mismatches = [];
  let hashedFileCount = 0;
  let verifiedHashedFileCount = 0;
  let launcherRecordEntryPresent = false;
  let launcherRecordEntryVerified = false;

  for (const entry of entries) {
    if (entry.entryPath === normalizePath(excludedEntry)) launcherRecordEntryPresent = true;
    if (!entry.hash) continue;
    hashedFileCount += 1;
    const hashMatch = entry.hash.match(/^sha256=(.+)$/);
    const target = sitePackagesRoot
      ? path.resolve(sitePackagesRoot, entry.entryPath.replace(/\//g, path.sep))
      : "";
    let reason = "";
    if (!hashMatch) reason = "unsupported-record-hash";
    else if (!target || !isInside(runtimeRoot, target)) reason = "record-entry-outside-runtime";
    else if (!fs.existsSync(target)) reason = "record-entry-missing";
    else {
      const bytes = fs.statSync(target).size;
      const expectedBytes = entry.size === "" ? null : Number(entry.size);
      const actualHash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("base64url");
      if (expectedBytes !== null && bytes !== expectedBytes) reason = "record-entry-size-mismatch";
      else if (actualHash !== hashMatch[1]) reason = "record-entry-hash-mismatch";
    }
    if (reason) {
      mismatches.push({ entryPath: entry.entryPath, reason });
    } else {
      verifiedHashedFileCount += 1;
      if (entry.entryPath === normalizePath(excludedEntry)) launcherRecordEntryVerified = true;
    }
  }

  return {
    portableSha256: sha256Buffer(portableText),
    portableLineCount: portableLines.filter(Boolean).length,
    hashedFileCount,
    verifiedHashedFileCount,
    mismatchCount: mismatches.length,
    mismatches,
    launcherRecordEntryPresent,
    launcherRecordEntryVerified,
  };
}

function canonicalModelArtifacts(models = []) {
  return models.map((model) => ({
    package: String(model.package || ""),
    relativePath: normalizePath(model.relativePath),
    name: String(model.name || path.basename(model.relativePath || "")),
    bytes: Number(model.bytes),
    sha256: String(model.sha256 || ""),
  })).sort((left, right) => `${left.package}:${left.relativePath}`.localeCompare(`${right.package}:${right.relativePath}`));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isStableRuntimePath(repoRoot, candidatePath) {
  if (!candidatePath) return false;
  const experimentsRoot = path.join(repoRoot, "data", "experiments");
  return !isInside(experimentsRoot, candidatePath);
}

export function parsePinnedRequirements(text) {
  const packages = {};
  const errors = [];
  for (const [index, rawLine] of String(text || "").split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)==([^\s;]+)$/);
    if (!match) {
      errors.push(`lock-line-${index + 1}-must-be-exact-pin`);
      continue;
    }
    const normalized = normalizePackageName(match[1]);
    if (Object.hasOwn(packages, normalized)) {
      errors.push(`lock-package-duplicated-${normalized}`);
      continue;
    }
    packages[normalized] = { name: match[1], version: match[2] };
  }
  if (Object.keys(packages).length === 0) errors.push("lock-has-no-packages");
  return { packages, errors };
}

export function resolveConfiguredPath({ repoRoot, spec = {}, env = process.env }) {
  const envName = String(spec.pathEnv || "").trim();
  const envValue = envName ? String(env?.[envName] || "").trim() : "";
  const configured = envValue || String(spec.defaultRelativePath || "").trim();
  return {
    envName,
    source: envValue ? "environment" : "manifest-default",
    configured,
    absolutePath: configured
      ? path.resolve(path.isAbsolute(configured) ? configured : path.join(repoRoot, configured))
      : "",
  };
}

function check(id, ok, details = {}, component = "") {
  return { id, ok: ok === true, component, ...details };
}

function summarizeChecks(checks) {
  const blockingReasons = checks.filter((item) => !item.ok).map((item) => item.id);
  return { ready: blockingReasons.length === 0, blockingReasons, checks };
}

function versionChecks(prefix, expected = {}, actual = {}, component = "") {
  return Object.entries(expected).map(([name, expectedVersion]) => {
    const normalized = normalizePackageName(name);
    const actualVersion = actual?.[normalized] ?? actual?.[name] ?? null;
    return check(
      `${prefix}-${normalized}-version-mismatch`,
      actualVersion === expectedVersion,
      { package: name, expected: expectedVersion, actual: actualVersion },
      component,
    );
  });
}

function validTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

export function evaluateDeploymentPreflight({
  manifest = {},
  repository = {},
  host = {},
  generatedAt = "",
} = {}) {
  const governanceChecks = [];
  const hostChecks = [];
  const deploymentChecks = [];
  const policy = manifest.policy || {};
  const homrGovernance = manifest.governance?.homr || {};
  const review = repository.reviewRecord || {};
  const decision = review.decision || {};
  const confirmations = decision.confirmations || {};
  const binding = decision.approvalBinding || {};
  const distribution = review.evidence?.localDistribution || {};
  const executableBinding = distribution.executable || {};
  const portableRecordBinding = distribution.portableRecord || {};
  const wheelArchiveBinding = distribution.wheelArchive || {};
  const reviewModels = canonicalModelArtifacts(review.modelArtifacts || []);
  const manifestModels = canonicalModelArtifacts(manifest.runtime?.homr?.models || []);
  const approvedModels = canonicalModelArtifacts(binding.modelArtifacts || []);

  governanceChecks.push(
    check("deployment-manifest-schema-unsupported", manifest.schemaVersion === 1, { expected: 1, actual: manifest.schemaVersion }),
    check("deployment-pipeline-id-mismatch", manifest.pipelineId === "western-photo-score-v3-homr-pool", { actual: manifest.pipelineId }),
    check("deployment-scope-mismatch", manifest.deploymentScope === "controlled-offline-review-only", { actual: manifest.deploymentScope }),
    check("deployment-student-facing-must-be-false", policy.studentFacing === false, { actual: policy.studentFacing }),
    check("deployment-automatic-adoption-must-be-false", policy.automaticAdoptionAuthorized === false, { actual: policy.automaticAdoptionAuthorized }),
    check("deployment-required-engine-pool-mismatch", ["audiveris", "homr"].every((name) => policy.requiredEnginePool?.includes(name)), { actual: policy.requiredEnginePool }),
    check("deployment-missing-engine-must-fail", policy.allowMissingRequiredEngine === false, { actual: policy.allowMissingRequiredEngine }),
    check("deployment-required-pipeline-flag-mismatch", policy.requiredPipelineFlag === "--require-complete-engine-pool", { actual: policy.requiredPipelineFlag }),
    check("homr-runtime-lock-missing", repository.lockFileExists === true),
    check("homr-runtime-lock-invalid", Array.isArray(repository.lockErrors) && repository.lockErrors.length === 0, { errors: repository.lockErrors || ["lock-not-read"] }),
    check("homr-license-review-record-missing", repository.reviewRecordExists === true),
    check("homr-license-review-document-missing", repository.reviewDocumentExists === true),
  );

  governanceChecks.push(
    check("homr-review-component-mismatch", review.component?.name === "homr" && review.component?.version === homrGovernance.version, {
      expectedVersion: homrGovernance.version,
      actualName: review.component?.name,
      actualVersion: review.component?.version,
    }),
    check("homr-review-license-mismatch", review.component?.declaredLicense === homrGovernance.declaredLicense, {
      expected: homrGovernance.declaredLicense,
      actual: review.component?.declaredLicense,
    }),
    check("homr-review-integration-mode-mismatch", review.integration?.mode === homrGovernance.requiredIntegrationMode, {
      expected: homrGovernance.requiredIntegrationMode,
      actual: review.integration?.mode,
    }),
    check("homr-review-integration-contract-mismatch", review.integration?.contractVersion === homrGovernance.requiredIntegrationContractVersion, {
      expected: homrGovernance.requiredIntegrationContractVersion,
      actual: review.integration?.contractVersion,
    }),
    check("homr-review-source-must-be-unmodified", review.integration?.sourceModified === false, { actual: review.integration?.sourceModified }),
    check("homr-review-must-remain-subprocess", review.integration?.packageImportedInProjectProcess === false, { actual: review.integration?.packageImportedInProjectProcess }),
    check("homr-license-review-not-approved", decision.status === homrGovernance.requiredDecisionStatus, {
      expected: homrGovernance.requiredDecisionStatus,
      actual: decision.status,
    }),
    check("homr-controlled-offline-scope-not-approved", decision.controlledOfflineReviewApproved === true
      && sameJson(decision.approvedScopes, [homrGovernance.requiredApprovedScope]), {
      requiredScope: homrGovernance.requiredApprovedScope,
      actualScopes: decision.approvedScopes || [],
    }),
    check("homr-license-reviewer-missing", typeof decision.reviewedBy === "string" && decision.reviewedBy.trim() !== "", { actual: decision.reviewedBy || "" }),
    check("homr-license-review-timestamp-invalid", validTimestamp(decision.reviewedAt), { actual: decision.reviewedAt || "" }),
    check("homr-license-confirmations-incomplete", confirmations.controlledOfflineOnly === true
      && confirmations.modelLicenseBasisReviewed === true
      && confirmations.noModelRedistribution === true, { actual: confirmations }),
    check("homr-model-license-basis-not-reviewed", review.modelLicenseReview?.status === "reviewer-confirmed-for-controlled-offline-use"
      && review.modelLicenseReview?.controlledOfflineUseConfirmedByReviewer === true
      && String(review.modelLicenseReview?.basis || "").trim() !== "", {
      actualStatus: review.modelLicenseReview?.status,
      basisPresent: String(review.modelLicenseReview?.basis || "").trim() !== "",
    }),
    check("homr-network-use-must-remain-disabled", decision.studentFacingNetworkUseApproved === false, { actual: decision.studentFacingNetworkUseApproved }),
    check("homr-redistribution-must-remain-disabled", decision.redistributionApproved === false && review.modelLicenseReview?.redistributionAllowed === false, {
      decisionRedistribution: decision.redistributionApproved,
      modelRedistribution: review.modelLicenseReview?.redistributionAllowed,
    }),
  );

  governanceChecks.push(
    check("homr-approval-binding-schema-version-mismatch", binding.bindingVersion === 2, { expected: 2, actual: binding.bindingVersion ?? null }),
    check("homr-reviewed-runtime-target-mismatch", distribution.runtimeRoot === review.deployment?.targetRuntimeRoot
      && distribution.runtimeRoot === manifest.runtime?.homr?.runtimeRootDefaultRelativePath, {
      reviewedRuntimeRoot: distribution.runtimeRoot || null,
      deploymentTarget: review.deployment?.targetRuntimeRoot || null,
      manifestTarget: manifest.runtime?.homr?.runtimeRootDefaultRelativePath || null,
    }),
    check("homr-approval-binding-executable-contract-mismatch", sameJson(binding.executable, {
      bindingMode: executableBinding.bindingMode,
      relativePath: executableBinding.relativePath,
      recordEntry: executableBinding.recordEntry,
      consoleEntryPoint: executableBinding.consoleEntryPoint,
    })),
    check("homr-approval-binding-wheel-mismatch", sameJson(binding.wheelArchive, {
      bytes: wheelArchiveBinding.bytes,
      sha256: wheelArchiveBinding.sha256,
    })),
    check("homr-approval-binding-record-mismatch", sameJson(binding.portableRecord, {
      algorithm: portableRecordBinding.algorithm,
      excludedEntry: portableRecordBinding.excludedEntry,
      lineCount: portableRecordBinding.lineCount,
      sha256: portableRecordBinding.sha256,
      hashedFileCount: distribution.wheelRecordHashedFileCount,
    })),
    check("homr-approval-binding-metadata-mismatch", binding.metadataSha256 === distribution.metadataSha256),
    check("homr-approval-binding-license-mismatch", binding.licenseSha256 === distribution.licenseSha256),
    check("homr-approval-binding-target-mismatch", binding.deploymentTargetRuntimeRoot === review.deployment?.targetRuntimeRoot),
    check("homr-approval-binding-model-set-mismatch", reviewModels.length === 6
      && manifestModels.length === 6
      && sameJson(approvedModels, reviewModels)
      && sameJson(reviewModels, manifestModels), {
      approvedCount: approvedModels.length,
      reviewedCount: reviewModels.length,
      manifestCount: manifestModels.length,
    }),
  );

  const audio = host.audioPython || {};
  const audiveris = host.audiveris || {};
  const homr = host.homr || {};
  const audioExpected = manifest.runtime?.audioPython || {};
  const audiverisExpected = manifest.runtime?.audiveris || {};
  const homrExpected = manifest.runtime?.homr || {};

  const audioChecks = [
    check("photo-score-audio-python-not-configured", Boolean(audio.configuredPath), { path: audio.configuredPath || "" }, "audioPython"),
    check("photo-score-audio-python-missing", audio.executableExists === true, { path: audio.configuredPath || "" }, "audioPython"),
    check("photo-score-audio-python-under-experiments", audio.stablePath === true, { path: audio.configuredPath || "" }, "audioPython"),
    check("photo-score-audio-python-probe-failed", audio.probeOk === true, { error: audio.error || "" }, "audioPython"),
    check("photo-score-audio-python-version-mismatch", audio.pythonVersion === audioExpected.pythonVersion, {
      expected: audioExpected.pythonVersion,
      actual: audio.pythonVersion || null,
    }, "audioPython"),
    ...versionChecks("photo-score-audio", audioExpected.requiredPackages || {}, audio.packageVersions || {}, "audioPython"),
  ];

  const audiverisChecks = [
    check("audiveris-executable-not-configured", Boolean(audiveris.configuredPath), { path: audiveris.configuredPath || "" }, "audiveris"),
    check("audiveris-executable-missing", audiveris.executableExists === true, { path: audiveris.configuredPath || "" }, "audiveris"),
    check("audiveris-executable-under-experiments", audiveris.stablePath === true, { path: audiveris.configuredPath || "" }, "audiveris"),
    check("audiveris-version-probe-failed", audiveris.probeOk === true, { error: audiveris.error || "" }, "audiveris"),
    check("audiveris-version-mismatch", audiveris.version === audiverisExpected.version, { expected: audiverisExpected.version, actual: audiveris.version || null }, "audiveris"),
    check("audiveris-commit-mismatch", audiveris.commit === audiverisExpected.commit, { expected: audiverisExpected.commit, actual: audiveris.commit || null }, "audiveris"),
  ];

  const homrChecks = [
    check("homr-executable-not-configured", Boolean(homr.configuredPath), { path: homr.configuredPath || "" }, "homr"),
    check("homr-executable-missing", homr.executableExists === true, { path: homr.configuredPath || "" }, "homr"),
    check("homr-runtime-under-experiments", homr.stablePath === true, { path: homr.configuredPath || "" }, "homr"),
    check("homr-help-probe-failed", homr.helpProbeOk === true, { error: homr.helpError || "" }, "homr"),
    check("homr-python-missing", homr.pythonExists === true, { path: homr.pythonPath || "" }, "homr"),
    check("homr-runtime-probe-failed", homr.probeOk === true, { error: homr.error || "" }, "homr"),
    check("homr-pip-check-failed", homr.pipCheckOk === true, { output: homr.pipCheckOutput || "" }, "homr"),
    check("homr-distribution-metadata-missing", homr.distributionMetadataExists === true, { path: homr.distributionMetadataPath || "" }, "homr"),
    check("homr-distribution-license-missing", homr.distributionLicenseExists === true, { path: homr.distributionLicensePath || "" }, "homr"),
    check("homr-distribution-record-missing", homr.distributionRecordExists === true, { path: homr.distributionRecordPath || "" }, "homr"),
    check("homr-record-hashed-file-count-mismatch", homr.recordHashedFileCount === distribution.wheelRecordHashedFileCount, {
      expected: distribution.wheelRecordHashedFileCount ?? null,
      actual: homr.recordHashedFileCount ?? null,
    }, "homr"),
    check("homr-record-file-integrity-mismatch", homr.recordMismatchCount === 0
      && homr.recordVerifiedHashedFileCount === homr.recordHashedFileCount, {
      hashed: homr.recordHashedFileCount ?? null,
      verified: homr.recordVerifiedHashedFileCount ?? null,
      mismatches: homr.recordMismatches || [],
    }, "homr"),
    check("homr-record-launcher-not-verified", homr.launcherRecordEntryPresent === true
      && homr.launcherRecordEntryVerified === true, {}, "homr"),
    check("homr-portable-record-mismatch", homr.recordPortableSha256 === portableRecordBinding.sha256
      && homr.recordPortableLineCount === portableRecordBinding.lineCount, {
      expectedSha256: portableRecordBinding.sha256 || null,
      actualSha256: homr.recordPortableSha256 || null,
      expectedLineCount: portableRecordBinding.lineCount ?? null,
      actualLineCount: homr.recordPortableLineCount ?? null,
    }, "homr"),
    check("homr-console-entry-point-mismatch", homr.consoleEntryPoint === executableBinding.consoleEntryPoint, {
      expected: executableBinding.consoleEntryPoint || null,
      actual: homr.consoleEntryPoint || null,
    }, "homr"),
    check("homr-executable-relative-path-mismatch", homr.executableRelativePath === executableBinding.relativePath, {
      expected: executableBinding.relativePath || null,
      actual: homr.executableRelativePath || null,
    }, "homr"),
    check("homr-retained-wheel-missing", repository.wheelArchiveExists === true, { path: repository.wheelArchivePath || "" }, "homr"),
    check("homr-retained-wheel-outside-repository", repository.wheelArchiveInsideRepository === true, { path: repository.wheelArchivePath || "" }, "homr"),
    check("homr-retained-wheel-size-mismatch", repository.wheelArchiveBytes === wheelArchiveBinding.bytes, {
      expected: wheelArchiveBinding.bytes ?? null,
      actual: repository.wheelArchiveBytes ?? null,
    }, "homr"),
    check("homr-retained-wheel-hash-mismatch", repository.wheelArchiveSha256 === wheelArchiveBinding.sha256, {
      expected: wheelArchiveBinding.sha256 || null,
      actual: repository.wheelArchiveSha256 || null,
    }, "homr"),
    ...versionChecks("homr-runtime", homrExpected.requiredPackages || {}, homr.packageVersions || {}, "homr"),
  ];

  for (const [normalized, pin] of Object.entries(repository.lockPackages || {})) {
    homrChecks.push(check(
      `homr-lock-package-${normalized}-mismatch`,
      homr.packageVersions?.[normalized] === pin.version,
      { package: pin.name, expected: pin.version, actual: homr.packageVersions?.[normalized] ?? null },
      "homr",
    ));
  }
  for (const provider of homrExpected.requiredOnnxProviders || []) {
    homrChecks.push(check(
      `homr-onnx-provider-${String(provider).toLowerCase()}-missing`,
      homr.onnxProviders?.includes(provider),
      { expected: provider, actual: homr.onnxProviders || [] },
      "homr",
    ));
  }
  const actualModels = new Map((homr.models || []).map((model) => [`${model.package}:${normalizePath(model.relativePath)}`, model]));
  for (const expectedModel of homrExpected.models || []) {
    const key = `${expectedModel.package}:${normalizePath(expectedModel.relativePath)}`;
    const actual = actualModels.get(key) || {};
    homrChecks.push(
      check(`homr-model-${sha256Buffer(key).slice(0, 12)}-missing`, actual.exists === true, { package: expectedModel.package, relativePath: expectedModel.relativePath }, "homr"),
      check(`homr-model-${sha256Buffer(key).slice(0, 12)}-size-mismatch`, actual.bytes === expectedModel.bytes, { expected: expectedModel.bytes, actual: actual.bytes ?? null, relativePath: expectedModel.relativePath }, "homr"),
      check(`homr-model-${sha256Buffer(key).slice(0, 12)}-hash-mismatch`, actual.sha256 === expectedModel.sha256, { expected: expectedModel.sha256, actual: actual.sha256 ?? null, relativePath: expectedModel.relativePath }, "homr"),
    );
  }

  hostChecks.push(...audioChecks, ...audiverisChecks, ...homrChecks);

  const actualHostModels = canonicalModelArtifacts((homr.models || []).filter((model) => model.exists === true));
  deploymentChecks.push(
    check("homr-approval-binding-missing", Boolean(decision.approvalBinding)),
    check("homr-approval-binding-component-version-mismatch", binding.componentVersion === homrGovernance.version, { expected: homrGovernance.version, actual: binding.componentVersion || null }),
    check("homr-approval-binding-contract-mismatch", binding.integrationContractVersion === homrGovernance.requiredIntegrationContractVersion, { expected: homrGovernance.requiredIntegrationContractVersion, actual: binding.integrationContractVersion ?? null }),
    check("homr-approved-executable-contract-not-live", homr.executableRelativePath === binding.executable?.relativePath
      && homr.consoleEntryPoint === binding.executable?.consoleEntryPoint
      && homr.launcherRecordEntryVerified === true),
    check("homr-approved-record-not-live", homr.recordPortableSha256 === binding.portableRecord?.sha256
      && homr.recordPortableLineCount === binding.portableRecord?.lineCount
      && homr.recordHashedFileCount === binding.portableRecord?.hashedFileCount
      && homr.recordMismatchCount === 0),
    check("homr-approved-wheel-not-live", repository.wheelArchiveSha256 === binding.wheelArchive?.sha256
      && repository.wheelArchiveBytes === binding.wheelArchive?.bytes),
    check("homr-reviewed-metadata-hash-mismatch", binding.metadataSha256 === homr.distributionMetadataSha256, {
      expected: binding.metadataSha256 || null,
      actual: homr.distributionMetadataSha256 || null,
    }),
    check("homr-reviewed-license-hash-mismatch", binding.licenseSha256 === homr.distributionLicenseSha256, {
      expected: binding.licenseSha256 || null,
      actual: homr.distributionLicenseSha256 || null,
    }),
    check("homr-approved-model-set-not-live", approvedModels.length === 6
      && actualHostModels.length === 6
      && sameJson(approvedModels, actualHostModels), {
      approvedCount: approvedModels.length,
      actualCount: actualHostModels.length,
    }),
  );

  const governance = summarizeChecks(governanceChecks);
  const hostSummary = summarizeChecks(hostChecks);
  const deploymentBinding = summarizeChecks(deploymentChecks);
  const audioSummary = summarizeChecks(audioChecks);
  const audiverisSummary = summarizeChecks(audiverisChecks);
  const homrSummary = summarizeChecks(homrChecks);
  const deploymentReady = governance.ready && hostSummary.ready && deploymentBinding.ready;
  const deploymentBlockingReasons = [
    ...governance.blockingReasons,
    ...hostSummary.blockingReasons,
    ...deploymentBinding.blockingReasons,
  ];

  return {
    ok: deploymentReady,
    generatedAt,
    pipelineId: manifest.pipelineId || "",
    deploymentScope: manifest.deploymentScope || "",
    manifestSha256: repository.manifestSha256 || "",
    lockSha256: repository.lockSha256 || "",
    governanceReady: governance.ready,
    hostReady: hostSummary.ready,
    deploymentReady,
    governance,
    host: {
      ready: hostSummary.ready,
      blockingReasons: hostSummary.blockingReasons,
      checks: hostSummary.checks,
      components: {
        audioPython: audioSummary,
        audiveris: audiverisSummary,
        homr: homrSummary,
      },
      resolvedPaths: {
        audioPython: audio.configuredPath || "",
        audiveris: audiveris.configuredPath || "",
        homr: homr.configuredPath || "",
      },
    },
    deployment: {
      ready: deploymentReady,
      blockingReasons: deploymentBlockingReasons,
      binding: deploymentBinding,
      studentFacing: false,
      automaticAdoptionAuthorized: false,
    },
    blockingReasons: deploymentBlockingReasons,
  };
}

function parseJsonLine(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Continue to the preceding line.
    }
  }
  return null;
}

function runLocal(executable, args, timeoutMs) {
  const result = spawnSync(executable, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? String(result.error.message || result.error) : "",
  };
}

function probeAudioPython(repoRoot, spec, env, timeoutMs) {
  const resolved = resolveConfiguredPath({ repoRoot, spec, env });
  const base = {
    configuredPath: normalizePath(resolved.absolutePath),
    configuredSource: resolved.source,
    executableExists: fs.existsSync(resolved.absolutePath),
    stablePath: isStableRuntimePath(repoRoot, resolved.absolutePath),
  };
  if (!base.executableExists) return base;
  const packages = Object.keys(spec.requiredPackages || {});
  const source = [
    "import importlib, json, sys",
    "from importlib.metadata import distribution, version",
    `packages = json.loads(${JSON.stringify(JSON.stringify(packages))})`,
    "modules = {'basic-pitch':'basic_pitch.inference','numpy':'numpy','tensorflow':'tensorflow','Pillow':'PIL','music21':'music21'}",
    "for package in packages:",
    "    importlib.import_module(modules[package])",
    "print(json.dumps({'pythonVersion':'.'.join(map(str, sys.version_info[:3])), 'packageVersions':{package.lower().replace('_','-').replace('.','-'):version(package) for package in packages}}, sort_keys=True))",
  ].join("\n");
  const result = runLocal(resolved.absolutePath, ["-c", source], timeoutMs);
  const parsed = parseJsonLine(result.stdout);
  return {
    ...base,
    probeOk: result.ok && Boolean(parsed),
    pythonVersion: parsed?.pythonVersion || null,
    packageVersions: parsed?.packageVersions || {},
    error: result.ok ? (parsed ? "" : "audio-probe-json-missing") : (result.error || result.stderr.slice(-1000)),
  };
}

function probeAudiveris(repoRoot, spec, env, timeoutMs) {
  const resolved = resolveConfiguredPath({ repoRoot, spec, env });
  const base = {
    configuredPath: normalizePath(resolved.absolutePath),
    configuredSource: resolved.source,
    executableExists: fs.existsSync(resolved.absolutePath),
    stablePath: isStableRuntimePath(repoRoot, resolved.absolutePath),
  };
  if (!base.executableExists) return base;
  const result = runLocal(resolved.absolutePath, ["-version"], timeoutMs);
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    ...base,
    probeOk: result.ok,
    version: output.match(/Version:\s*([^\s]+)/i)?.[1] || null,
    commit: output.match(/Commit:\s*([^\s]+)/i)?.[1] || null,
    error: result.ok ? "" : (result.error || output.slice(-1000)),
  };
}

function probeHomr(repoRoot, spec, env, lockPackages, timeoutMs, reviewDistribution = {}) {
  const resolved = resolveConfiguredPath({ repoRoot, spec, env });
  const executablePath = resolved.absolutePath;
  const runtimeRoot = executablePath ? path.resolve(path.dirname(executablePath), "..") : "";
  const pythonPath = executablePath
    ? path.join(path.dirname(executablePath), spec.pythonRelativeToExecutable || "python.exe")
    : "";
  const base = {
    configuredPath: normalizePath(executablePath),
    configuredSource: resolved.source,
    executableExists: fs.existsSync(executablePath),
    executableSha256: fs.existsSync(executablePath) ? sha256File(executablePath) : "",
    runtimeRoot: normalizePath(runtimeRoot),
    executableRelativePath: runtimeRoot && executablePath
      ? normalizePath(path.relative(runtimeRoot, executablePath))
      : "",
    stablePath: isStableRuntimePath(repoRoot, executablePath),
    pythonPath: normalizePath(pythonPath),
    pythonExists: fs.existsSync(pythonPath),
    models: [],
  };
  if (!base.executableExists || !base.pythonExists) return base;

  const help = runLocal(executablePath, ["-h"], timeoutMs);
  const requestedPackages = Object.values(lockPackages || {}).map((pin) => pin.name);
  const coreModules = ["homr", "rapidocr"];
  const source = [
    "import importlib.util, json, sys",
    "from importlib.metadata import distribution, version",
    "import onnxruntime",
    `packages = json.loads(${JSON.stringify(JSON.stringify(requestedPackages))})`,
    `core_modules = json.loads(${JSON.stringify(JSON.stringify(coreModules))})`,
    "roots = {}",
    "for name in core_modules:",
    " spec = importlib.util.find_spec(name)",
    " if spec is None: raise ModuleNotFoundError(name)",
    " roots[name] = list(spec.submodule_search_locations or [])[0]",
    "versions = {package.lower().replace('_','-').replace('.','-'):version(package) for package in packages}",
    "dist_info_root = str(distribution('homr')._path)",
    "print(json.dumps({'pythonVersion':'.'.join(map(str, sys.version_info[:3])), 'packageVersions':versions, 'onnxProviders':onnxruntime.get_available_providers(), 'moduleRoots':roots, 'distInfoRoot':dist_info_root}, sort_keys=True))",
  ].join("\n");
  const probe = runLocal(pythonPath, ["-c", source], timeoutMs);
  const parsed = parseJsonLine(probe.stdout);
  const pipCheck = runLocal(pythonPath, ["-m", "pip", "check"], timeoutMs);
  const distInfoRoot = parsed?.distInfoRoot || "";
  const metadataPath = distInfoRoot ? path.join(distInfoRoot, "METADATA") : "";
  const licensePath = distInfoRoot ? path.join(distInfoRoot, "licenses", "LICENSE") : "";
  const recordPath = distInfoRoot ? path.join(distInfoRoot, "RECORD") : "";
  const entryPointsPath = distInfoRoot ? path.join(distInfoRoot, "entry_points.txt") : "";
  const metadataExists = Boolean(metadataPath && fs.existsSync(metadataPath));
  const licenseExists = Boolean(licensePath && fs.existsSync(licensePath));
  const recordExists = Boolean(recordPath && fs.existsSync(recordPath));
  const entryPointsExists = Boolean(entryPointsPath && fs.existsSync(entryPointsPath));
  const recordInspection = recordExists
    ? inspectWheelRecord({
      recordText: fs.readFileSync(recordPath, "utf8"),
      recordPath,
      runtimeRoot,
      excludedEntry: reviewDistribution.executable?.recordEntry || "../../Scripts/homr.exe",
    })
    : {};
  const entryPointsText = entryPointsExists ? fs.readFileSync(entryPointsPath, "utf8") : "";
  const consoleEntryPointMatch = entryPointsText.match(/^homr\s*=\s*([^\r\n]+)$/m);
  const consoleEntryPoint = consoleEntryPointMatch
    ? `homr=${consoleEntryPointMatch[1].trim()}`
    : "";
  const models = [];
  for (const expected of spec.models || []) {
    const root = parsed?.moduleRoots?.[expected.package] || "";
    const modelPath = root ? path.resolve(root, expected.relativePath) : "";
    const exists = Boolean(modelPath && fs.existsSync(modelPath));
    models.push({
      package: expected.package,
      relativePath: normalizePath(expected.relativePath),
      path: normalizePath(modelPath),
      exists,
      bytes: exists ? fs.statSync(modelPath).size : null,
      sha256: exists ? sha256File(modelPath) : null,
    });
  }
  return {
    ...base,
    helpProbeOk: help.ok,
    helpError: help.ok ? "" : (help.error || `${help.stdout}\n${help.stderr}`.slice(-1000)),
    probeOk: probe.ok && Boolean(parsed),
    pythonVersion: parsed?.pythonVersion || null,
    packageVersions: parsed?.packageVersions || {},
    onnxProviders: parsed?.onnxProviders || [],
    moduleRoots: parsed?.moduleRoots || {},
    distributionMetadataPath: normalizePath(metadataPath),
    distributionMetadataExists: metadataExists,
    distributionMetadataSha256: metadataExists ? sha256File(metadataPath) : null,
    distributionLicensePath: normalizePath(licensePath),
    distributionLicenseExists: licenseExists,
    distributionLicenseSha256: licenseExists ? sha256File(licensePath) : null,
    distributionRecordPath: normalizePath(recordPath),
    distributionRecordExists: recordExists,
    recordPortableSha256: recordInspection.portableSha256 || null,
    recordPortableLineCount: recordInspection.portableLineCount ?? null,
    recordHashedFileCount: recordInspection.hashedFileCount ?? null,
    recordVerifiedHashedFileCount: recordInspection.verifiedHashedFileCount ?? null,
    recordMismatchCount: recordInspection.mismatchCount ?? null,
    recordMismatches: recordInspection.mismatches || [],
    launcherRecordEntryPresent: recordInspection.launcherRecordEntryPresent === true,
    launcherRecordEntryVerified: recordInspection.launcherRecordEntryVerified === true,
    distributionEntryPointsPath: normalizePath(entryPointsPath),
    distributionEntryPointsExists: entryPointsExists,
    consoleEntryPoint,
    pipCheckOk: pipCheck.ok,
    pipCheckOutput: `${pipCheck.stdout}\n${pipCheck.stderr}`.trim(),
    models,
    error: probe.ok ? (parsed ? "" : "homr-probe-json-missing") : (probe.error || probe.stderr.slice(-1000)),
  };
}

async function readOptionalJson(filePath) {
  try {
    return { exists: true, value: JSON.parse(await fsp.readFile(filePath, "utf8")), error: "" };
  } catch (error) {
    return { exists: false, value: null, error: String(error?.message || error) };
  }
}

export async function runLiveDeploymentPreflight({
  repoRoot = REPO_ROOT,
  manifestPath = DEFAULT_MANIFEST,
  env = process.env,
  generatedAt = new Date().toISOString(),
} = {}) {
  const manifestRead = await readOptionalJson(manifestPath);
  if (!manifestRead.exists) {
    return {
      ok: false,
      generatedAt,
      governanceReady: false,
      hostReady: false,
      deploymentReady: false,
      governance: { ready: false, blockingReasons: ["deployment-manifest-load-failed"], checks: [] },
      host: { ready: false, blockingReasons: ["deployment-manifest-load-failed"], checks: [], components: {} },
      deployment: { ready: false, blockingReasons: ["deployment-manifest-load-failed"], studentFacing: false, automaticAdoptionAuthorized: false },
      blockingReasons: ["deployment-manifest-load-failed"],
      error: manifestRead.error,
    };
  }
  const manifest = manifestRead.value;
  const lockPath = path.resolve(repoRoot, manifest.runtime?.homr?.lockFile || "");
  let lockText = "";
  let lockFileExists = false;
  try {
    lockText = await fsp.readFile(lockPath, "utf8");
    lockFileExists = true;
  } catch {
    // The pure evaluator reports the missing lock.
  }
  const parsedLock = parsePinnedRequirements(lockText);
  const reviewPath = path.resolve(repoRoot, manifest.governance?.homr?.reviewRecord || "");
  const reviewDocumentPath = path.resolve(repoRoot, manifest.governance?.homr?.reviewDocument || "");
  const reviewRead = await readOptionalJson(reviewPath);
  const wheelArchiveConfigured = reviewRead.value?.evidence?.localDistribution?.wheelArchive?.path || "";
  const wheelArchivePath = wheelArchiveConfigured
    ? path.resolve(repoRoot, wheelArchiveConfigured)
    : "";
  const wheelArchiveInsideRepository = Boolean(wheelArchivePath && isInside(repoRoot, wheelArchivePath));
  const wheelArchiveExists = Boolean(
    wheelArchiveInsideRepository && fs.existsSync(wheelArchivePath),
  );
  const repository = {
    manifestSha256: sha256File(manifestPath),
    lockFileExists,
    lockSha256: lockFileExists ? sha256Buffer(lockText) : "",
    lockPackages: parsedLock.packages,
    lockErrors: parsedLock.errors,
    reviewRecordExists: reviewRead.exists,
    reviewRecord: reviewRead.value || {},
    reviewDocumentExists: fs.existsSync(reviewDocumentPath),
    wheelArchivePath: normalizePath(wheelArchivePath),
    wheelArchiveInsideRepository,
    wheelArchiveExists,
    wheelArchiveBytes: wheelArchiveExists ? fs.statSync(wheelArchivePath).size : null,
    wheelArchiveSha256: wheelArchiveExists ? sha256File(wheelArchivePath) : null,
  };
  const preflight = manifest.preflight || {};
  const host = {
    audioPython: probeAudioPython(
      repoRoot,
      manifest.runtime?.audioPython || {},
      env,
      Number(preflight.audioProbeTimeoutSeconds || 60) * 1000,
    ),
    audiveris: probeAudiveris(
      repoRoot,
      manifest.runtime?.audiveris || {},
      env,
      Number(preflight.audiverisProbeTimeoutSeconds || 30) * 1000,
    ),
    homr: probeHomr(
      repoRoot,
      manifest.runtime?.homr || {},
      env,
      parsedLock.packages,
      Number(preflight.homrProbeTimeoutSeconds || 30) * 1000,
      reviewRead.value?.evidence?.localDistribution || {},
    ),
  };
  return evaluateDeploymentPreflight({ manifest, repository, host, generatedAt });
}

function parseArgs(argv) {
  const args = { manifestPath: DEFAULT_MANIFEST, out: DEFAULT_OUT, quiet: false, errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifestPath = path.resolve(argv[++index] || "");
    else if (arg === "--out") args.out = path.resolve(argv[++index] || "");
    else if (arg === "--no-write") args.out = "";
    else if (arg === "--quiet") args.quiet = true;
    else args.errors.push(`unknown-argument:${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let report;
  if (args.errors.length > 0) {
    report = {
      ok: false,
      governanceReady: false,
      hostReady: false,
      deploymentReady: false,
      blockingReasons: args.errors,
      deployment: { ready: false, blockingReasons: args.errors, studentFacing: false, automaticAdoptionAuthorized: false },
    };
  } else {
    report = await runLiveDeploymentPreflight({ manifestPath: args.manifestPath });
  }
  if (args.out) {
    await fsp.mkdir(path.dirname(args.out), { recursive: true });
    await fsp.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (!args.quiet) console.log(JSON.stringify(report, null, 2));
  else if (!report.deploymentReady) console.error(JSON.stringify(report));
  if (!report.deploymentReady) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      governanceReady: false,
      hostReady: false,
      deploymentReady: false,
      blockingReasons: ["deployment-preflight-unhandled-error"],
      error: String(error?.stack || error),
    }));
    process.exitCode = 1;
  });
}
