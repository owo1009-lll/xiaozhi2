import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  M4A_SUPPORTED_EDITION_REGISTRY_PATH,
  auditM4aSupportedEditionRegistry,
} from "./audit-western-m4a-supported-edition-registry.mjs";

const live = await auditM4aSupportedEditionRegistry();
assert.equal(live.ready, true, live.blockingReasons.join(", "));
assert.equal(live.counts.validEntries, 3);
assert.equal(live.counts.invalidEntries, 0);
assert(live.entries.every((entry) => entry.tripletIntegrityReady));
assert(live.entries.every((entry) => entry.coordinateSidecarReady));
assert(live.entries.every((entry) => entry.humanConfirmationReady));
assert(live.entries.every((entry) => entry.licenseReady));

const sourceRoot = path.dirname(path.resolve(M4A_SUPPORTED_EDITION_REGISTRY_PATH));

async function withRegistryCopy(mutate, expectedReason) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-m4a-registry-"));
  try {
    await fs.cp(sourceRoot, path.join(tempRoot, "registry-root"), { recursive: true });
    const copyRoot = path.join(tempRoot, "registry-root");
    const registryPath = path.join(copyRoot, "registry.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    await mutate({ copyRoot, registry, registryPath });
    const result = await auditM4aSupportedEditionRegistry(copyRoot, { registryPath: "registry.json" });
    assert.equal(result.ready, false, expectedReason);
    assert(result.blockingReasons.includes(expectedReason), JSON.stringify(result.blockingReasons));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const writeRegistry = ({ registry, registryPath }) => (
  fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
);

await withRegistryCopy(async ({ copyRoot, registry }) => {
  const target = path.join(copyRoot, registry.entries[0].musicxmlPath);
  await fs.appendFile(target, "\n<!-- forged -->\n", "utf8");
}, "m4a-registry-musicxml-hash-mismatch");

await withRegistryCopy(async ({ copyRoot, registry }) => {
  const target = path.join(copyRoot, registry.entries[0].renderPath);
  const bytes = await fs.readFile(target);
  bytes[bytes.length - 1] ^= 0xff;
  await fs.writeFile(target, bytes);
}, "m4a-registry-render-hash-mismatch");

await withRegistryCopy(async ({ copyRoot, registry }) => {
  const target = path.join(copyRoot, registry.entries[0].coordinateSidecarPath);
  await fs.appendFile(target, " ", "utf8");
}, "m4a-registry-coordinate-sidecar-hash-mismatch");

await withRegistryCopy(async (context) => {
  context.registry.entries[0].confirmedBy = "";
  await writeRegistry(context);
}, "m4a-registry-human-confirmation-missing");

await withRegistryCopy(async (context) => {
  context.registry.entries[0].musicxmlPath = "../outside.musicxml";
  await writeRegistry(context);
}, "m4a-registry-artifact-path-escape");

await withRegistryCopy(async (context) => {
  context.registry.entries[0].licenseStatus = "unknown";
  await writeRegistry(context);
}, "m4a-registry-license-not-approved");

await withRegistryCopy(async ({ copyRoot, registry, registryPath }) => {
  const entry = registry.entries[0];
  const target = path.join(copyRoot, entry.coordinateSidecarPath);
  const sidecar = JSON.parse(await fs.readFile(target, "utf8"));
  sidecar.measures[0].bboxPixels[2] = sidecar.page.widthPixels + 1;
  const bytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  await fs.writeFile(target, bytes);
  entry.coordinateSidecarSha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}, "m4a-registry-coordinate-box-out-of-bounds");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "three-supported-editions-live-verified",
    "musicxml-render-sidecar-triplets-hash-bound",
    "human-confirmation-and-license-enforced",
    "artifact-path-escape-rejected",
    "coordinate-sidecar-schema-and-bounds-verified",
    "forged-triplet-artifacts-rejected",
  ],
  counts: live.counts,
}, null, 2));
