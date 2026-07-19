import fs from "node:fs/promises";
import path from "node:path";

import { safeString } from "./baseUtils.js";

// The built-in "supported editions" registry: for each piece, a confirmed
// MusicXML + locked render image + coordinate sidecar. These reference scores
// are what the student score view displays, and what future on-score error
// highlighting maps onto (via the coordinate sidecar). Everything served here
// is reference material, never student data.
function editionsRoot(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m4a", "supported-editions");
}

async function readRegistry(repoRoot) {
  const registryPath = path.join(editionsRoot(repoRoot), "registry.json");
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function findEntry(entries, pieceId, editionId) {
  const piece = safeString(pieceId).trim();
  const edition = safeString(editionId).trim();
  if (!piece) return null;
  return entries.find(
    (entry) => safeString(entry.pieceId).trim() === piece
      && (!edition || safeString(entry.editionId).trim() === edition),
  ) || null;
}

// Only paths listed inside the registry are servable, and only when they resolve
// back inside the supported-editions directory — no caller-supplied path reaches disk.
function resolveInsideEditions(repoRoot, relativePath) {
  const root = editionsRoot(repoRoot);
  const resolved = path.resolve(root, safeString(relativePath));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  return resolved;
}

export async function listSupportedEditions({ repoRoot = process.cwd() } = {}) {
  const entries = await readRegistry(repoRoot);
  return {
    ok: true,
    editions: entries.map((entry) => ({
      pieceId: safeString(entry.pieceId),
      editionId: safeString(entry.editionId),
      title: safeString(entry.title),
      pageCount: Number(entry.pageCount) || 1,
    })),
  };
}

export async function findEditionRenderPath({ repoRoot = process.cwd(), pieceId = "", editionId = "" } = {}) {
  const entries = await readRegistry(repoRoot);
  const entry = findEntry(entries, pieceId, editionId);
  if (!entry) return "";
  const resolved = resolveInsideEditions(repoRoot, entry.renderPath);
  if (!resolved) return "";
  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    return "";
  }
}

export async function findEditionCoordinates({ repoRoot = process.cwd(), pieceId = "", editionId = "" } = {}) {
  const entries = await readRegistry(repoRoot);
  const entry = findEntry(entries, pieceId, editionId);
  if (!entry) return null;
  const resolved = resolveInsideEditions(repoRoot, entry.coordinateSidecarPath);
  if (!resolved) return null;
  try {
    return JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch {
    return null;
  }
}
