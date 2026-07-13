import fs from "node:fs/promises";
import path from "node:path";

import { safeNumber, safeString, sha1 } from "./baseUtils.js";
import { parseDataUrlToBuffer } from "./audioPayload.js";

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/jpg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function pathIsInsideOrEqual(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inferScorePhotoContentExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return "";
}

async function fileExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function unsupportedTypeError() {
  const error = new Error("score photo must be a JPG, PNG, or WebP image.");
  error.statusCode = 400;
  return error;
}

function invalidContentError() {
  const error = new Error("score photo content must match its JPG, PNG, or WebP file type.");
  error.statusCode = 400;
  return error;
}

function unsafeSourcePathError() {
  const error = new Error("score photo source path must be inside the managed score-photo cache.");
  error.statusCode = 400;
  return error;
}

export function inferScorePhotoExtension(fileName = "", mimeType = "") {
  const mime = safeString(mimeType).trim().toLowerCase();
  if (MIME_EXTENSIONS.has(mime)) return MIME_EXTENSIONS.get(mime);

  const extension = path.extname(safeString(fileName)).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw unsupportedTypeError();
  return extension === ".jpeg" ? ".jpg" : extension;
}

function validateScorePhotoBuffer(buffer, declaredExtension) {
  const contentExtension = inferScorePhotoContentExtension(buffer);
  if (!contentExtension || contentExtension !== declaredExtension) throw invalidContentError();
  return contentExtension;
}

export async function persistUploadedScorePhotoFile(file, { scorePhotoCacheDir = "" } = {}) {
  if (!file?.buffer?.length) return { scorePhotoPath: "", scorePhotoHash: "" };
  const declaredExtension = inferScorePhotoExtension(file.originalname, file.mimetype);
  const extension = validateScorePhotoBuffer(file.buffer, declaredExtension);
  const scorePhotoHash = sha1(file.buffer);
  const targetPath = path.join(scorePhotoCacheDir, `${scorePhotoHash}${extension}`);
  if (!await fileExists(targetPath)) {
    await fs.mkdir(scorePhotoCacheDir, { recursive: true });
    await fs.writeFile(targetPath, file.buffer);
  }
  return { scorePhotoPath: targetPath, scorePhotoHash };
}

export async function persistPayloadScorePhoto(payload = {}, { scorePhotoCacheDir = "" } = {}) {
  const existingPath = safeString(payload.scorePhotoPath).trim();
  if (existingPath && await fileExists(existingPath)) {
    if (!scorePhotoCacheDir || !pathIsInsideOrEqual(scorePhotoCacheDir, existingPath)) {
      throw unsafeSourcePathError();
    }
    const buffer = await fs.readFile(existingPath);
    const declaredExtension = inferScorePhotoExtension(existingPath);
    const extension = validateScorePhotoBuffer(buffer, declaredExtension);
    const scorePhotoHash = sha1(buffer);
    const targetPath = path.join(scorePhotoCacheDir, `${scorePhotoHash}${extension}`);
    if (!await fileExists(targetPath)) {
      await fs.mkdir(scorePhotoCacheDir, { recursive: true });
      await fs.writeFile(targetPath, buffer);
    }
    return { scorePhotoPath: targetPath, scorePhotoHash };
  }

  const parsed = parseDataUrlToBuffer(payload.scorePhotoDataUrl);
  if (!parsed?.buffer?.length) return { scorePhotoPath: "", scorePhotoHash: "" };

  const declaredExtension = inferScorePhotoExtension(payload.scorePhotoSubmission?.name, parsed.mimeType);
  const extension = validateScorePhotoBuffer(parsed.buffer, declaredExtension);
  const scorePhotoHash = sha1(parsed.buffer);
  const targetPath = path.join(scorePhotoCacheDir, `${scorePhotoHash}${extension}`);
  if (!await fileExists(targetPath)) {
    await fs.mkdir(scorePhotoCacheDir, { recursive: true });
    await fs.writeFile(targetPath, parsed.buffer);
  }
  return { scorePhotoPath: targetPath, scorePhotoHash };
}

export function buildScorePhotoSubmissionFromUpload(file, fallback = {}) {
  if (!file) return fallback || null;
  return {
    name: safeString(file.originalname, safeString(fallback?.name)),
    mimeType: safeString(file.mimetype, safeString(fallback?.mimeType, "application/octet-stream")),
    size: safeNumber(file.size, file.buffer?.length),
  };
}
