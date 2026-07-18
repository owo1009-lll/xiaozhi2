#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateOrdinaryAudioRuntime,
  ORDINARY_AUDIO_RUNTIME_ANCHORS,
} from "./run-western-ordinary-audio-python.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "config", "western-ordinary-audio-runtime.json");
const runtimeConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
const expectedPackages = runtimeConfig.requiredPackages;

const live = evaluateOrdinaryAudioRuntime({ repoRoot, configPath });
assert.equal(live.runtimeReady, true, JSON.stringify(live));
assert.equal(live.python.version, "3.11.9");
assert.deepEqual(live.packages, expectedPackages);
assert.equal(live.python.source, "manifest-default");
assert.equal(live.python.isolatedVenv, true);
assert.equal(live.python.userSiteEnabled, false);
assert.equal(live.packageSetLocked, true);
assert.equal(live.configSemanticSha256, ORDINARY_AUDIO_RUNTIME_ANCHORS.configSemanticSha256);
assert.equal(live.requirementsLock.normalizedSha256, runtimeConfig.requirementsLock.normalizedSha256);
assert.equal(live.modelIdentity.treeSha256, runtimeConfig.modelIdentity.treeSha256);
assert.equal(live.modelIdentity.artifacts.length, 3);
assert.equal(live.studentFacing, false);
assert.equal(live.automaticAdoptionAuthorized, false);
assert.equal(live.fallbackInterpreterUsed, false);
assert.equal(live.homrRuntimeShared, false);

const versionDrift = evaluateOrdinaryAudioRuntime({
  repoRoot,
  configPath,
  probe: () => ({
    ok: true,
    value: {
      pythonVersion: "3.11.9",
      prefix: path.join(repoRoot, "data", "tools", "western-ordinary-dynamic-shadow-py311"),
      basePrefix: path.join(repoRoot, "base-python"),
      enableUserSite: false,
      packages: { ...expectedPackages, "basic-pitch": "9.9.9" },
      packageLocations: Object.fromEntries(Object.keys(expectedPackages).map((name) => [
        name,
        path.join(repoRoot, "data", "tools", "western-ordinary-dynamic-shadow-py311", "Lib", "site-packages"),
      ])),
    },
  }),
});
assert.equal(versionDrift.runtimeReady, false);
assert(versionDrift.blockingReasons.includes("ordinary-audio-runtime-package-version-mismatch:basic-pitch"));

const explicitMissing = evaluateOrdinaryAudioRuntime({
  repoRoot,
  configPath,
  env: { WESTERN_STRINGS_AUDIO_PYTHON: path.join(repoRoot, "missing", "python.exe") },
});
assert.equal(explicitMissing.runtimeReady, false);
assert(explicitMissing.blockingReasons.includes("ordinary-audio-python-explicit-path-missing"));
assert.equal(explicitMissing.python.source, "");

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-ordinary-audio-runtime-"));
try {
  const config = structuredClone(runtimeConfig);
  config.policy.studentFacing = true;
  const unsafeConfig = path.join(tempRoot, "unsafe.json");
  await fs.writeFile(unsafeConfig, `${JSON.stringify(config)}\n`, "utf8");
  const unsafe = evaluateOrdinaryAudioRuntime({ repoRoot, configPath: unsafeConfig });
  assert.equal(unsafe.runtimeReady, false);
  assert(unsafe.blockingReasons.includes("ordinary-audio-runtime-config-identity-mismatch"));
  assert(unsafe.blockingReasons.includes("ordinary-audio-runtime-student-facing-must-be-false"));

  const selfSignedConfig = structuredClone(runtimeConfig);
  selfSignedConfig.requiredPackages["basic-pitch"] = "9.9.9";
  selfSignedConfig.requirementsLock.normalizedSha256 = "f".repeat(64);
  selfSignedConfig.modelIdentity.treeSha256 = "e".repeat(64);
  const selfSignedPath = path.join(tempRoot, "self-signed.json");
  await fs.writeFile(selfSignedPath, `${JSON.stringify(selfSignedConfig)}\n`, "utf8");
  const selfSigned = evaluateOrdinaryAudioRuntime({ repoRoot, configPath: selfSignedPath });
  assert.equal(selfSigned.runtimeReady, false);
  assert(selfSigned.blockingReasons.includes("ordinary-audio-runtime-config-identity-mismatch"));
  assert(selfSigned.blockingReasons.includes("ordinary-audio-runtime-requirements-lock-anchor-mismatch"));
  assert(selfSigned.blockingReasons.includes("ordinary-audio-runtime-model-anchor-mismatch"));

  const downgradedChecks = [
    ["allow-outside", (value) => { value.python.allowOutsideRepository = true; }, "ordinary-audio-runtime-outside-repository-must-be-forbidden"],
    ["skip-isolation", (value) => { value.python.requireIsolatedVenv = false; }, "ordinary-audio-runtime-isolated-venv-check-must-be-required"],
    ["skip-user-site", (value) => { value.python.requireUserSiteDisabled = false; }, "ordinary-audio-runtime-user-site-check-must-be-required"],
    ["skip-package-location", (value) => { value.python.requirePackagesInsideRuntime = false; }, "ordinary-audio-runtime-package-location-check-must-be-required"],
    ["skip-strict-package-set", (value) => { value.strictPackageSet = false; }, "ordinary-audio-runtime-strict-package-set-must-be-required"],
  ];
  for (const [name, mutate, expectedReason] of downgradedChecks) {
    const downgradedConfig = structuredClone(runtimeConfig);
    mutate(downgradedConfig);
    const downgradedPath = path.join(tempRoot, `${name}.json`);
    await fs.writeFile(downgradedPath, `${JSON.stringify(downgradedConfig)}\n`, "utf8");
    const downgraded = evaluateOrdinaryAudioRuntime({ repoRoot, configPath: downgradedPath });
    assert.equal(downgraded.runtimeReady, false, `${name} must fail closed`);
    assert(downgraded.blockingReasons.includes(expectedReason), JSON.stringify(downgraded));
  }

  const leakedConfig = structuredClone(runtimeConfig);
  leakedConfig.python.defaultRelativePath = "data/tools/western-photo-score-audio-py311/Scripts/python.exe";
  const leakedConfigPath = path.join(tempRoot, "system-site.json");
  await fs.writeFile(leakedConfigPath, `${JSON.stringify(leakedConfig)}\n`, "utf8");
  const leaked = evaluateOrdinaryAudioRuntime({ repoRoot, configPath: leakedConfigPath });
  assert.equal(leaked.runtimeReady, false);
  assert(leaked.blockingReasons.includes("ordinary-audio-runtime-system-site-packages-enabled"));
  assert(leaked.blockingReasons.some((reason) => reason.startsWith("ordinary-audio-runtime-package-outside-runtime:")));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "managed-audio-runtime-live",
    "exact-package-versions",
    "strict-transitive-package-lock",
    "code-anchored-config-lock-and-model-identity",
    "isolated-venv-no-system-or-user-site",
    "basic-pitch-model-artifact-hash",
    "explicit-path-never-falls-back",
    "student-facing-policy-fail-closed",
    "manifest-cannot-disable-runtime-safety-checks",
    "homr-numpy-runtime-isolated",
  ],
}));
