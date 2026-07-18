import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  evaluateM4aRegistrationPreflight,
  runM4aRegistrationPreflight,
} from "./preflight-western-m4a-registration.mjs";

const config = JSON.parse(await fs.readFile("config/western-m4a-registration.json", "utf8"));
const fixture = {
  config,
  registryAudit: { ready: true, blockingReasons: [] },
  host: {
    configuredPath: "data/tools/runtime/python.exe",
    executableExists: true,
    stablePath: true,
    probeOk: true,
    pythonVersion: config.runtime.pythonVersion,
    packageVersions: structuredClone(config.runtime.requiredPackages),
  },
  implementation: { exists: true, omrEngineReferences: false },
};
assert.equal(evaluateM4aRegistrationPreflight(fixture).ready, true);

for (const [label, mutate, reason] of [
  ["policy drift", (row) => { row.config.policy.studentFacing = true; }, "m4a-registration-safety-policy-mismatch"],
  ["audio threshold drift", (row) => { row.config.audioSentinel.minimumAgreement = 0.59; }, "m4a-registration-audio-threshold-mismatch"],
  ["registry invalid", (row) => { row.registryAudit = { ready: false, blockingReasons: ["registry-forged"] }; }, "registry-forged"],
  ["runtime unstable", (row) => { row.host.stablePath = false; }, "m4a-registration-python-path-unstable"],
  ["package drift", (row) => { row.host.packageVersions.numpy = "2.0.0"; }, "m4a-registration-package-numpy-version-mismatch"],
  ["implementation missing", (row) => { row.implementation.exists = false; }, "m4a-registration-implementation-missing"],
  ["engine reference", (row) => { row.implementation.omrEngineReferences = true; }, "m4a-registration-main-chain-omr-reference-detected"],
]) {
  const candidate = structuredClone(fixture);
  mutate(candidate);
  const result = evaluateM4aRegistrationPreflight(candidate);
  assert.equal(result.ready, false, label);
  assert(result.blockingReasons.includes(reason), `${label}: ${reason}`);
}

const live = await runM4aRegistrationPreflight(process.cwd(), { writeReport: true });
assert.equal(live.ready, true, live.blockingReasons.join(", "));
assert.equal(live.registryAudit.counts.validEntries, 3);
assert.equal(live.policy.studentFacing, false);
assert.equal(live.policy.automaticAdoptionAuthorized, false);
assert.equal(live.implementation.omrEngineReferences, false);
assert.match(live.implementation.sha256, /^[a-f0-9]{64}$/);

const wrapper = await fs.readFile(path.join("scripts", "run-western-m4a-registration.ps1"), "utf8");
assert(wrapper.includes("preflight-western-m4a-registration.mjs"));
assert(wrapper.includes("western_m4a_registration.py"));

console.log(JSON.stringify({
  ok: true,
  checks: [
    "live-python-opencv-runtime-preflight",
    "registry-live-audit-bound-to-runtime",
    "policy-and-audio-threshold-drift-rejected",
    "package-and-runtime-path-drift-rejected",
    "main-chain-engine-reference-rejected",
    "review-only-policy-preserved",
  ],
  host: live.host,
}, null, 2));
