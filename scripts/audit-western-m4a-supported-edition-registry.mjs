import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const M4A_SUPPORTED_EDITION_REGISTRY_CONTRACT = "western-m4a-supported-edition-registry-v1";
export const M4A_COORDINATE_SIDECAR_CONTRACT = "western-m4a-render-coordinate-sidecar-v1";
export const M4A_SUPPORTED_EDITION_REGISTRY_PATH = path.join(
  "data",
  "experiments",
  "western-strings-m4a",
  "supported-editions",
  "registry.json",
);

const APPROVED_LICENSE_STATUSES = new Set(["self-authored", "public-domain", "local-only"]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function unique(values) {
  return [...new Set(values)];
}

function safeArtifactPath(registryRoot, relativePath) {
  if (!String(relativePath || "").trim() || path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(registryRoot, relativePath);
  const relative = path.relative(registryRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function parsePngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return false;
  const [x1, y1, x2, y2] = box;
  return x1 >= 0 && y1 >= 0 && x2 > x1 && y2 > y1 && x2 <= width && y2 <= height;
}

function auditCoordinateSidecar(sidecar, entry, pngDimensions) {
  const blockingReasons = [];
  if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar)) {
    return { ready: false, blockingReasons: ["m4a-registry-coordinate-sidecar-invalid"] };
  }
  if (sidecar.contract !== M4A_COORDINATE_SIDECAR_CONTRACT) {
    blockingReasons.push("m4a-registry-coordinate-sidecar-contract-mismatch");
  }
  if (sidecar.pieceId !== entry.pieceId || sidecar.editionId !== entry.editionId) {
    blockingReasons.push("m4a-registry-coordinate-sidecar-identity-mismatch");
  }
  const width = sidecar.page?.widthPixels;
  const height = sidecar.page?.heightPixels;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    blockingReasons.push("m4a-registry-coordinate-sidecar-page-size-invalid");
  } else if (!pngDimensions || width !== pngDimensions.width || height !== pngDimensions.height) {
    blockingReasons.push("m4a-registry-coordinate-sidecar-render-size-mismatch");
  }

  const collections = {
    systems: sidecar.systems,
    staves: sidecar.staves,
    measures: sidecar.measures,
    notes: sidecar.notes,
  };
  for (const [name, rows] of Object.entries(collections)) {
    if (!Array.isArray(rows) || rows.length === 0) {
      blockingReasons.push(`m4a-registry-coordinate-sidecar-${name}-missing`);
      continue;
    }
    if (sidecar.counts?.[name] !== rows.length) {
      blockingReasons.push(`m4a-registry-coordinate-sidecar-${name}-count-mismatch`);
    }
    if (Number.isInteger(width) && Number.isInteger(height)) {
      if (rows.some((row) => !validBox(row?.bboxPixels, width, height))) {
        blockingReasons.push("m4a-registry-coordinate-box-out-of-bounds");
      }
    }
  }

  if (Array.isArray(sidecar.measures)) {
    const indices = sidecar.measures.map((row) => row.globalMeasureIndex);
    const expected = Array.from({ length: indices.length }, (_, index) => index + 1);
    if (indices.length !== new Set(indices).size || indices.some((value, index) => value !== expected[index])) {
      blockingReasons.push("m4a-registry-coordinate-measure-index-invalid");
    }
  }
  if (Array.isArray(sidecar.notes) && Array.isArray(sidecar.measures)) {
    const measureIndices = new Set(sidecar.measures.map((row) => row.globalMeasureIndex));
    const noteIndices = sidecar.notes.map((row) => row.xmlPitchedNoteIndex);
    if (noteIndices.some((value) => !Number.isInteger(value) || value < 0)
      || noteIndices.length !== new Set(noteIndices).size) {
      blockingReasons.push("m4a-registry-coordinate-note-index-invalid");
    }
    if (sidecar.notes.some((row) => !measureIndices.has(row.globalMeasureIndex))) {
      blockingReasons.push("m4a-registry-coordinate-note-measure-link-invalid");
    }
  }
  return { ready: blockingReasons.length === 0, blockingReasons: unique(blockingReasons) };
}

async function auditEntry(entry, registryRoot, registryRendererVersion) {
  const blockingReasons = [];
  const identity = `${String(entry?.pieceId || "").trim()}/${String(entry?.editionId || "").trim()}`;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(entry?.pieceId || ""))
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(String(entry?.editionId || ""))) {
    blockingReasons.push("m4a-registry-entry-identity-invalid");
  }
  const humanConfirmationReady = Boolean(
    String(entry?.confirmedBy || "").trim()
    && String(entry?.confirmedAt || "").trim()
    && String(entry?.confirmationMethod || "").trim(),
  );
  if (!humanConfirmationReady) blockingReasons.push("m4a-registry-human-confirmation-missing");
  const licenseReady = APPROVED_LICENSE_STATUSES.has(entry?.licenseStatus);
  if (!licenseReady) blockingReasons.push("m4a-registry-license-not-approved");
  if (!String(entry?.rendererVersion || "").trim()
    || entry.rendererVersion !== registryRendererVersion) {
    blockingReasons.push("m4a-registry-renderer-version-mismatch");
  }

  const artifacts = [
    ["musicxml", entry?.musicxmlPath, entry?.musicxmlSha256],
    ["render", entry?.renderPath, entry?.renderSha256],
    ["coordinate-sidecar", entry?.coordinateSidecarPath, entry?.coordinateSidecarSha256],
  ];
  const bytesByKind = new Map();
  for (const [kind, relativePath, expectedHash] of artifacts) {
    const absolute = safeArtifactPath(registryRoot, relativePath);
    if (!absolute) {
      blockingReasons.push("m4a-registry-artifact-path-escape");
      continue;
    }
    try {
      const bytes = await fs.readFile(absolute);
      bytesByKind.set(kind, bytes);
      if (!/^[a-f0-9]{64}$/.test(String(expectedHash || "")) || sha256(bytes) !== expectedHash) {
        blockingReasons.push(`m4a-registry-${kind}-hash-mismatch`);
      }
    } catch {
      blockingReasons.push(`m4a-registry-${kind}-artifact-missing`);
    }
  }


  let coordinateAudit = { ready: false, blockingReasons: ["m4a-registry-coordinate-sidecar-invalid"] };
  if (bytesByKind.has("coordinate-sidecar")) {
    try {
      const sidecar = JSON.parse(bytesByKind.get("coordinate-sidecar").toString("utf8"));
      coordinateAudit = auditCoordinateSidecar(
        sidecar,
        entry,
        bytesByKind.has("render") ? parsePngDimensions(bytesByKind.get("render")) : null,
      );
      blockingReasons.push(...coordinateAudit.blockingReasons);
    } catch {
      blockingReasons.push("m4a-registry-coordinate-sidecar-invalid");
    }
  }
  const uniqueReasons = unique(blockingReasons);
  return {
    identity,
    pieceId: entry?.pieceId || "",
    editionId: entry?.editionId || "",
    ready: uniqueReasons.length === 0,
    tripletIntegrityReady: artifacts.every(([kind]) => (
      bytesByKind.has(kind) && !uniqueReasons.includes(`m4a-registry-${kind}-hash-mismatch`)
    )),
    coordinateSidecarReady: coordinateAudit.ready,
    humanConfirmationReady,
    licenseReady,
    blockingReasons: uniqueReasons,
  };
}

export async function auditM4aSupportedEditionRegistry(
  repoRoot = process.cwd(),
  { registryPath = M4A_SUPPORTED_EDITION_REGISTRY_PATH } = {},
) {
  const absoluteRegistryPath = path.resolve(repoRoot, registryPath);
  let registryBytes;
  let registry;
  try {
    registryBytes = await fs.readFile(absoluteRegistryPath);
    registry = JSON.parse(registryBytes.toString("utf8"));
  } catch (error) {
    return {
      ready: false,
      source: path.relative(repoRoot, absoluteRegistryPath).replace(/\\/g, "/"),
      sha256: "",
      counts: { entries: 0, validEntries: 0, invalidEntries: 0 },
      entries: [],
      blockingReasons: [
        String(error?.code || "") === "ENOENT"
          ? "m4a-supported-edition-registry-missing"
          : "m4a-supported-edition-registry-invalid",
      ],
    };
  }

  const blockingReasons = [];
  if (registry?.contract !== M4A_SUPPORTED_EDITION_REGISTRY_CONTRACT) {
    blockingReasons.push("m4a-supported-edition-registry-contract-mismatch");
  }
  const registryRendererVersion = String(registry?.renderer?.version || "").trim();
  if (!registryRendererVersion) blockingReasons.push("m4a-supported-edition-registry-renderer-missing");
  if (!Array.isArray(registry?.entries) || registry.entries.length === 0) {
    blockingReasons.push("m4a-supported-edition-registry-empty");
  }
  const registryRoot = path.dirname(absoluteRegistryPath);
  const entries = Array.isArray(registry?.entries)
    ? await Promise.all(registry.entries.map((entry) => auditEntry(entry, registryRoot, registryRendererVersion)))
    : [];
  const identities = entries.map((entry) => entry.identity);
  if (identities.length !== new Set(identities).size) {
    blockingReasons.push("m4a-supported-edition-registry-duplicate-entry");
  }
  blockingReasons.push(...entries.flatMap((entry) => entry.blockingReasons));
  const uniqueReasons = unique(blockingReasons);
  return {
    ready: uniqueReasons.length === 0 && entries.length > 0,
    source: path.relative(repoRoot, absoluteRegistryPath).replace(/\\/g, "/"),
    sha256: sha256(registryBytes),
    renderer: registry?.renderer || null,
    counts: {
      entries: entries.length,
      validEntries: entries.filter((entry) => entry.ready).length,
      invalidEntries: entries.filter((entry) => !entry.ready).length,
    },
    entries,
    blockingReasons: uniqueReasons,
  };
}

async function main() {
  const result = await auditM4aSupportedEditionRegistry();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
