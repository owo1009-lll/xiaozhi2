#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateDeploymentPreflight,
  parsePinnedRequirements,
  resolveConfiguredPath,
} from "./preflight-western-photo-score-deployment.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "western-photo-score-deployment.json"), "utf8"));
const lockText = fs.readFileSync(path.join(repoRoot, manifest.runtime.homr.lockFile), "utf8");
const lock = parsePinnedRequirements(lockText);
const authoritativeReview = JSON.parse(fs.readFileSync(path.join(repoRoot, manifest.governance.homr.reviewRecord), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const normalized = (value) => String(value).toLowerCase().replace(/[_.]+/g, "-");

function approvedReview() {
  const review = clone(authoritativeReview);
  const distribution = review.evidence.localDistribution;
  review.modelLicenseReview = {
    status: "reviewer-confirmed-for-controlled-offline-use",
    basis: "fixture-only reviewed basis",
    controlledOfflineUseConfirmedByReviewer: true,
    redistributionAllowed: false,
    reviewedBy: "fixture-reviewer",
    reviewedAt: "2026-07-17T00:00:00.000Z",
  };
  review.decision = {
    status: "approved-with-conditions",
    reviewedBy: "fixture-reviewer",
    reviewedAt: "2026-07-17T00:00:00.000Z",
    approvedScopes: ["controlled-offline-review-only"],
    controlledOfflineReviewApproved: true,
    studentFacingNetworkUseApproved: false,
    redistributionApproved: false,
    confirmations: {
      controlledOfflineOnly: true,
      modelLicenseBasisReviewed: true,
      noModelRedistribution: true,
    },
    approvalBinding: {
      bindingVersion: 2,
      componentVersion: manifest.governance.homr.version,
      integrationContractVersion: manifest.governance.homr.requiredIntegrationContractVersion,
      executable: {
        bindingMode: distribution.executable.bindingMode,
        relativePath: distribution.executable.relativePath,
        recordEntry: distribution.executable.recordEntry,
        consoleEntryPoint: distribution.executable.consoleEntryPoint,
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
      deploymentTargetRuntimeRoot: review.deployment.targetRuntimeRoot,
      modelArtifacts: review.modelArtifacts.map((model) => ({
        package: model.package,
        relativePath: model.relativePath,
        name: model.name,
        bytes: model.bytes,
        sha256: model.sha256,
      })),
    },
  };
  return review;
}

function readyRepository(review = approvedReview()) {
  return {
    manifestSha256: "b".repeat(64),
    lockFileExists: true,
    lockSha256: "c".repeat(64),
    lockPackages: clone(lock.packages),
    lockErrors: [],
    reviewRecordExists: true,
    reviewRecord: review,
    reviewDocumentExists: true,
    wheelArchivePath: "C:/repo/data/tools/wheelhouse/western-photo-score-homr/homr-0.7.0-py3-none-any.whl",
    wheelArchiveInsideRepository: true,
    wheelArchiveExists: true,
    wheelArchiveBytes: review.evidence.localDistribution.wheelArchive.bytes,
    wheelArchiveSha256: review.evidence.localDistribution.wheelArchive.sha256,
  };
}

function readyHost() {
  const audioPackages = Object.fromEntries(
    Object.entries(manifest.runtime.audioPython.requiredPackages).map(([name, version]) => [normalized(name), version]),
  );
  const homrPackages = Object.fromEntries(
    Object.entries(lock.packages).map(([name, pin]) => [name, pin.version]),
  );
  return {
    audioPython: {
      configuredPath: "C:/stable/audio/Scripts/python.exe",
      executableExists: true,
      stablePath: true,
      probeOk: true,
      pythonVersion: manifest.runtime.audioPython.pythonVersion,
      packageVersions: audioPackages,
    },
    audiveris: {
      configuredPath: "C:/stable/audiveris/Audiveris.exe",
      executableExists: true,
      stablePath: true,
      probeOk: true,
      version: manifest.runtime.audiveris.version,
      commit: manifest.runtime.audiveris.commit,
    },
    homr: {
      configuredPath: "C:/stable/homr/Scripts/homr.exe",
      executableExists: true,
      executableSha256: "path-sensitive-host-observation-is-not-an-approval-binding",
      runtimeRoot: "C:/stable/homr",
      executableRelativePath: "Scripts/homr.exe",
      distributionMetadataExists: true,
      distributionMetadataSha256: authoritativeReview.evidence.localDistribution.metadataSha256,
      distributionLicenseExists: true,
      distributionLicenseSha256: authoritativeReview.evidence.localDistribution.licenseSha256,
      distributionRecordExists: true,
      distributionRecordPath: "C:/stable/homr/Lib/site-packages/homr-0.7.0.dist-info/RECORD",
      recordPortableSha256: authoritativeReview.evidence.localDistribution.portableRecord.sha256,
      recordPortableLineCount: authoritativeReview.evidence.localDistribution.portableRecord.lineCount,
      recordHashedFileCount: authoritativeReview.evidence.localDistribution.wheelRecordHashedFileCount,
      recordVerifiedHashedFileCount: authoritativeReview.evidence.localDistribution.wheelRecordHashedFileCount,
      recordMismatchCount: 0,
      recordMismatches: [],
      launcherRecordEntryPresent: true,
      launcherRecordEntryVerified: true,
      consoleEntryPoint: authoritativeReview.evidence.localDistribution.executable.consoleEntryPoint,
      stablePath: true,
      helpProbeOk: true,
      pythonPath: "C:/stable/homr/Scripts/python.exe",
      pythonExists: true,
      probeOk: true,
      pipCheckOk: true,
      packageVersions: homrPackages,
      onnxProviders: ["CPUExecutionProvider"],
      models: manifest.runtime.homr.models.map((model) => ({
        package: model.package,
        relativePath: model.relativePath,
        exists: true,
        bytes: model.bytes,
        sha256: model.sha256,
      })),
    },
  };
}

function evaluate({ review = approvedReview(), host = readyHost(), repository = null } = {}) {
  return evaluateDeploymentPreflight({
    manifest,
    repository: repository || readyRepository(review),
    host,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });
}

assert.equal(lock.errors.length, 0, "HOMR lock must contain only exact pins");
assert.equal(Object.keys(lock.packages).length, 27, "validated HOMR lock must retain all 27 packages");
assert.equal(manifest.runtime.homr.defaultRelativePath.includes("data/experiments"), false, "stable HOMR default must not live under experiments");
assert.equal(manifest.runtime.homr.defaultRelativePath, "data/tools/homr-0.7.0-ort1.27.0/Scripts/homr.exe");
assert.equal(manifest.governance.homr.reviewRecord, "config/third-party/homr-0.7.0-review.json");

const ready = evaluate();
assert.equal(ready.governanceReady, true, JSON.stringify(ready.governance.blockingReasons));
assert.equal(ready.hostReady, true, JSON.stringify(ready.host.blockingReasons));
assert.equal(ready.deploymentReady, true, JSON.stringify(ready.blockingReasons));
assert.equal(ready.deployment.studentFacing, false);
assert.equal(ready.deployment.automaticAdoptionAuthorized, false);
assert.equal(approvedReview().decision.approvalBinding.modelArtifacts.length, 6, "approval must bind the complete runtime model set");

const pathSensitiveLauncherHost = readyHost();
pathSensitiveLauncherHost.homr.executableSha256 = "different-host-launcher-hash";
const portableLauncherBinding = evaluate({ host: pathSensitiveLauncherHost });
assert.equal(portableLauncherBinding.deploymentReady, true, "path-sensitive launcher bytes must be covered by live RECORD verification, not a cross-host hash");

const extraScopeReview = approvedReview();
extraScopeReview.decision.approvedScopes.push("unreviewed-extra-scope");
const extraScope = evaluate({ review: extraScopeReview });
assert.equal(extraScope.governanceReady, false);
assert(extraScope.governance.blockingReasons.includes("homr-controlled-offline-scope-not-approved"));

const incompleteBindingReview = approvedReview();
incompleteBindingReview.decision.approvalBinding.modelArtifacts = [];
const incompleteBinding = evaluate({ review: incompleteBindingReview });
assert.equal(incompleteBinding.governanceReady, false);
assert.equal(incompleteBinding.deploymentReady, false);
assert(incompleteBinding.governance.blockingReasons.includes("homr-approval-binding-model-set-mismatch"));

const missingArtifactBindingReview = approvedReview();
delete missingArtifactBindingReview.decision.approvalBinding.metadataSha256;
const missingArtifactBinding = evaluate({ review: missingArtifactBindingReview });
assert.equal(missingArtifactBinding.governanceReady, false);
assert.equal(missingArtifactBinding.deploymentReady, false);
assert(missingArtifactBinding.governance.blockingReasons.includes("homr-approval-binding-metadata-mismatch"));

const changedTargetReview = approvedReview();
changedTargetReview.decision.approvalBinding.deploymentTargetRuntimeRoot = "data/tools/other-runtime";
const changedTarget = evaluate({ review: changedTargetReview });
assert.equal(changedTarget.governanceReady, false);
assert(changedTarget.governance.blockingReasons.includes("homr-approval-binding-target-mismatch"));

const pending = evaluate({ review: authoritativeReview });
assert.equal(authoritativeReview.decision.status, "pending", "authoritative license record should remain pending until named approval");
assert.equal(pending.governanceReady, false);
assert.equal(pending.hostReady, true, "pending governance must not erase independently valid host evidence");
assert.equal(pending.deploymentReady, false);
assert(pending.governance.blockingReasons.includes("homr-license-review-not-approved"));

const missingAudioHost = readyHost();
missingAudioHost.audioPython.executableExists = false;
missingAudioHost.audioPython.probeOk = false;
const missingAudio = evaluate({ host: missingAudioHost });
assert.equal(missingAudio.governanceReady, true);
assert.equal(missingAudio.hostReady, false);
assert.equal(missingAudio.deploymentReady, false);
assert(missingAudio.host.blockingReasons.includes("photo-score-audio-python-missing"));

const experimentHost = readyHost();
experimentHost.homr.configuredPath = "C:/repo/data/experiments/western-strings-m4/homr-compat-venv/Scripts/homr.exe";
experimentHost.homr.stablePath = false;
const experimentRuntime = evaluate({ host: experimentHost });
assert.equal(experimentRuntime.host.components.homr.ready, false);
assert(experimentRuntime.host.components.homr.blockingReasons.includes("homr-runtime-under-experiments"));

const wrongDependencyHost = readyHost();
wrongDependencyHost.homr.packageVersions.onnxruntime = "1.24.1";
const wrongDependency = evaluate({ host: wrongDependencyHost });
assert.equal(wrongDependency.host.components.homr.ready, false);
assert(wrongDependency.host.components.homr.blockingReasons.includes("homr-runtime-onnxruntime-version-mismatch"));
assert(wrongDependency.host.components.homr.blockingReasons.includes("homr-lock-package-onnxruntime-mismatch"));

const missingProviderHost = readyHost();
missingProviderHost.homr.onnxProviders = ["AzureExecutionProvider"];
const missingProvider = evaluate({ host: missingProviderHost });
assert.equal(missingProvider.host.components.homr.ready, false);
assert(missingProvider.host.components.homr.blockingReasons.includes("homr-onnx-provider-cpuexecutionprovider-missing"));

const badModelHost = readyHost();
badModelHost.homr.models[0].sha256 = "d".repeat(64);
const badModel = evaluate({ host: badModelHost });
assert.equal(badModel.host.components.homr.ready, false);
assert(badModel.host.components.homr.blockingReasons.some((reason) => reason.endsWith("-hash-mismatch")));

const recordMismatchHost = readyHost();
recordMismatchHost.homr.recordVerifiedHashedFileCount -= 1;
recordMismatchHost.homr.recordMismatchCount = 1;
recordMismatchHost.homr.recordMismatches = [{ entryPath: "homr/main.py", reason: "record-entry-hash-mismatch" }];
const recordMismatch = evaluate({ host: recordMismatchHost });
assert.equal(recordMismatch.host.components.homr.ready, false);
assert(recordMismatch.host.components.homr.blockingReasons.includes("homr-record-file-integrity-mismatch"));

const launcherRecordMismatchHost = readyHost();
launcherRecordMismatchHost.homr.launcherRecordEntryVerified = false;
const launcherRecordMismatch = evaluate({ host: launcherRecordMismatchHost });
assert.equal(launcherRecordMismatch.host.components.homr.ready, false);
assert(launcherRecordMismatch.host.components.homr.blockingReasons.includes("homr-record-launcher-not-verified"));

const portableRecordDriftHost = readyHost();
portableRecordDriftHost.homr.recordPortableSha256 = "f".repeat(64);
const portableRecordDrift = evaluate({ host: portableRecordDriftHost });
assert.equal(portableRecordDrift.host.components.homr.ready, false);
assert(portableRecordDrift.host.components.homr.blockingReasons.includes("homr-portable-record-mismatch"));

const wheelDriftRepository = readyRepository();
wheelDriftRepository.wheelArchiveSha256 = "e".repeat(64);
const wheelDrift = evaluate({ repository: wheelDriftRepository });
assert.equal(wheelDrift.host.components.homr.ready, false);
assert(wheelDrift.host.components.homr.blockingReasons.includes("homr-retained-wheel-hash-mismatch"));

const mismatchedDistributionHost = readyHost();
mismatchedDistributionHost.homr.distributionMetadataSha256 = "e".repeat(64);
const mismatchedDistribution = evaluate({ host: mismatchedDistributionHost });
assert.equal(mismatchedDistribution.governanceReady, true);
assert.equal(mismatchedDistribution.hostReady, true);
assert.equal(mismatchedDistribution.deploymentReady, false);
assert(mismatchedDistribution.deployment.binding.blockingReasons.includes("homr-reviewed-metadata-hash-mismatch"));

const resolved = resolveConfiguredPath({
  repoRoot,
  spec: {
    pathEnv: "FIXTURE_EXACT_PYTHON",
    defaultRelativePath: "data/tools/default/Scripts/python.exe",
  },
  env: { FIXTURE_EXACT_PYTHON: "C:/configured-but-missing/python.exe" },
});
assert.equal(resolved.source, "environment");
assert.match(resolved.absolutePath.replace(/\\/g, "/"), /configured-but-missing\/python\.exe$/);
assert.equal(resolved.absolutePath.includes("data/tools/default"), false, "an explicit path must never silently fall back");

const wrapperSource = fs.readFileSync(path.join(repoRoot, "scripts", "run-western-photo-score-python.ps1"), "utf8");
assert(wrapperSource.includes("preflight-western-photo-score-deployment.mjs"));
assert(wrapperSource.includes("--require-complete-engine-pool"));
assert(wrapperSource.includes("Resolve-ExactRuntimePath"));
assert(wrapperSource.includes('$ErrorActionPreference = "Continue"'), "wrapper must preserve native preflight exit semantics on Windows PowerShell");
assert(wrapperSource.includes("*> $null"), "wrapper must not echo the full failed preflight report through stderr");
assert.equal(wrapperSource.includes("run-python.ps1"), false, "production wrapper must not use the fallback-capable generic runner");

const setupSource = fs.readFileSync(path.join(repoRoot, "scripts", "setup-western-photo-score-runtime.ps1"), "utf8");
assert(setupSource.includes("--no-index"), "runtime setup must prohibit network package resolution");
assert(setupSource.includes("offlineModelBundleDefaultRelativePath"), "runtime setup must source models from a local bundle");
assert(setupSource.includes("--system-site-packages"), "runtime setup must create a distinct exact audio interpreter");
assert(setupSource.includes("audioRuntimeReady"), "runtime setup must report the audio component result separately");
assert(
  setupSource.includes("if ($preflight.host.components.audioPython.ready -ne $true)"),
  "runtime setup must fail when its managed audio runtime does not pass preflight",
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "exact-lock-parsed",
    "stable-path-frozen",
    "ready-fixture-passes",
    "path-sensitive-launcher-uses-portable-binding",
    "extra-scope-rejected",
    "incomplete-approval-binding-rejected",
    "missing-artifact-binding-rejected",
    "deployment-target-binding-enforced",
    "pending-license-fails-governance-only",
    "missing-audio-runtime-fails-host",
    "experiment-runtime-rejected",
    "dependency-version-drift-rejected",
    "cpu-provider-required",
    "model-hash-drift-rejected",
    "wheel-record-file-drift-rejected",
    "launcher-record-drift-rejected",
    "portable-record-drift-rejected",
    "retained-wheel-drift-rejected",
    "reviewed-distribution-hashes-enforced",
    "explicit-interpreter-never-falls-back",
    "wrapper-enforces-preflight-and-engine-pool",
    "wrapper-preserves-preflight-failure-semantics",
    "setup-is-offline-only",
    "setup-creates-separated-audio-runtime",
  ],
}));
