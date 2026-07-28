import fs from "node:fs/promises";
import path from "node:path";

import { safeNumber, safeString, sha1 } from "./baseUtils.js";

async function fileExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function pathIsInsideOrEqual(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unsafeSourcePathError() {
  const error = new Error("audio source path must be inside the managed audio cache.");
  error.statusCode = 400;
  return error;
}

export function parseDataUrlToBuffer(dataUrl) {
  const raw = safeString(dataUrl);
  if (!raw.includes(",")) {
    return null;
  }
  const [header, body] = raw.split(",", 2);
  try {
    const mimeMatch = header.match(/^data:([^;,]+)/i);
    return {
      buffer: Buffer.from(body, "base64"),
      mimeType: mimeMatch?.[1] || "",
    };
  } catch {
    return null;
  }
}

export function inferAudioExtension(audioSubmission = {}, mimeType = "") {
  const submissionName = safeString(audioSubmission?.name).toLowerCase();
  const explicitExt = path.extname(submissionName);
  if (explicitExt) return explicitExt;
  const mime = safeString(mimeType || audioSubmission?.mimeType).toLowerCase();
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("webm")) return ".webm";
  if (mime.includes("mp4") || mime.includes("m4a")) return ".m4a";
  return ".bin";
}

export async function persistPayloadAudio(payload = {}, { audioCacheDir = "" } = {}) {
  const existingPath = safeString(payload.audioPath).trim();
  if (existingPath && await fileExists(existingPath)) {
    if (!audioCacheDir || !pathIsInsideOrEqual(audioCacheDir, existingPath)) {
      throw unsafeSourcePathError();
    }
    const baseName = path.basename(existingPath);
    const hashedName = baseName.match(/^([a-f0-9]{40})/i)?.[1] || "";
    const audioHash = hashedName || sha1(await fs.readFile(existingPath));
    return { audioPath: existingPath, audioHash };
  }

  const parsed = parseDataUrlToBuffer(payload.audioDataUrl);
  if (!parsed?.buffer?.length) {
    return { audioPath: "", audioHash: "" };
  }

  const audioHash = sha1(parsed.buffer);
  const extension = inferAudioExtension(payload.audioSubmission, parsed.mimeType);
  const targetPath = path.join(audioCacheDir, `${audioHash}${extension}`);
  if (!await fileExists(targetPath)) {
    await fs.mkdir(audioCacheDir, { recursive: true });
    await fs.writeFile(targetPath, parsed.buffer);
  }
  return { audioPath: targetPath, audioHash };
}

export async function persistUploadedAudioFile(file, { audioCacheDir = "" } = {}) {
  if (!file?.buffer?.length) {
    return { audioPath: "", audioHash: "" };
  }
  const audioHash = sha1(file.buffer);
  const extension = inferAudioExtension(
    {
      name: safeString(file.originalname),
      mimeType: safeString(file.mimetype),
      size: safeNumber(file.size, file.buffer.length),
    },
    file.mimetype,
  );
  const targetPath = path.join(audioCacheDir, `${audioHash}${extension}`);
  if (!await fileExists(targetPath)) {
    await fs.mkdir(audioCacheDir, { recursive: true });
    await fs.writeFile(targetPath, file.buffer);
  }
  return { audioPath: targetPath, audioHash };
}

export function buildPreparedAudioPayload(payload = {}, persistedAudio = {}) {
  const resolvedAudioPath = safeString(persistedAudio.audioPath || payload.audioPath);
  return {
    ...payload,
    audioPath: resolvedAudioPath,
    audioHash: safeString(persistedAudio.audioHash || payload.audioHash),
    audioDataUrl: resolvedAudioPath ? null : payload.audioDataUrl,
  };
}

export async function normalizePreparedPayloadForAnalyzer(payload = {}, toAnalyzerPath) {
  const analyzerAudioPath = await toAnalyzerPath(payload.audioPath);
  if (!analyzerAudioPath) {
    return payload;
  }
  return {
    ...payload,
    audioPath: analyzerAudioPath,
    audioDataUrl: null,
  };
}

export function parseIncomingPayload(req) {
  if (safeString(req.body?.payload)) {
    try {
      return JSON.parse(req.body.payload);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

export function buildAudioSubmissionFromUpload(file, fallback = {}) {
  if (!file) return fallback || null;
  return {
    name: safeString(file.originalname, safeString(fallback?.name)),
    mimeType: safeString(file.mimetype, safeString(fallback?.mimeType, "application/octet-stream")),
    size: safeNumber(file.size, file.buffer?.length),
    duration: safeNumber(fallback?.duration, null),
  };
}
