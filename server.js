import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { getErhuPiece, getErhuPieceSummaries, getErhuSection } from "./src/erhuStudyPieces.js";
import { RESEARCH_TEMPLATE_LIBRARY } from "./src/researchProtocolData.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const STUDY_STORE_FILE = path.join(DATA_DIR, "erhu-study-records.json");
const SCORE_STORE_FILE = path.join(DATA_DIR, "erhu-score-imports.json");
const SCORE_IMPORTS_DIR = path.join(DATA_DIR, "score-imports");
const PIECE_PASS_DIR = path.join(DATA_DIR, "piece-pass");
const AUDIO_CACHE_DIR = path.join(DATA_DIR, "analysis-audio-cache");
const SECTION_DETECTION_CACHE_DIR = path.join(DATA_DIR, "section-detection-cache");
const SECTION_ANALYSIS_CACHE_DIR = path.join(DATA_DIR, "section-analysis-cache");
const PERF_TRACE_FILE = path.join(DATA_DIR, "perf-trace.log");
const ASCII_RUNTIME_ROOT = path.join(path.dirname(__dirname), "ai_erhu_runtime");
const DIST_DIR = path.join(__dirname, "dist");
const REQUIRED_VALIDATION_RATERS = Math.max(1, safeNumber(process.env.ERHU_VALIDATION_RATERS_REQUIRED, 2));
const ADJUDICATION_OVERALL_GAP_THRESHOLD = 2;
const ADJUDICATION_NOTE_F1_THRESHOLD = 0.67;
const ADJUDICATION_MEASURE_F1_THRESHOLD = 0.67;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

app.use(express.json({ limit: "120mb" }));

let runtimeAliasReady = false;
let runtimeAliasFailed = false;

async function fileExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntimeAlias() {
  if (runtimeAliasReady || runtimeAliasFailed) {
    return runtimeAliasReady ? ASCII_RUNTIME_ROOT : "";
  }
  try {
    if (!fsSync.existsSync(ASCII_RUNTIME_ROOT)) {
      fsSync.symlinkSync(__dirname, ASCII_RUNTIME_ROOT, "junction");
    }
    runtimeAliasReady = true;
    return ASCII_RUNTIME_ROOT;
  } catch {
    runtimeAliasFailed = true;
    return "";
  }
}

async function toAnalyzerPath(targetPath) {
  const resolved = safeString(targetPath).trim();
  if (!resolved) return "";
  const aliasRoot = await ensureRuntimeAlias();
  if (!aliasRoot) return resolved;
  const relativePath = path.relative(__dirname, resolved);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return resolved;
  }
  return path.join(aliasRoot, relativePath);
}

function appendPerfTrace(message) {
  try {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
    fsSync.appendFileSync(PERF_TRACE_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // ignore perf tracing failures
  }
}

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function hashJson(value) {
  return sha1(JSON.stringify(value));
}

function parseDataUrlToBuffer(dataUrl) {
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

function inferAudioExtension(audioSubmission = {}, mimeType = "") {
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

async function persistPayloadAudio(payload = {}) {
  const existingPath = safeString(payload.audioPath).trim();
  if (existingPath && await fileExists(existingPath)) {
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
  const targetPath = path.join(AUDIO_CACHE_DIR, `${audioHash}${extension}`);
  if (!await fileExists(targetPath)) {
    await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });
    await fs.writeFile(targetPath, parsed.buffer);
  }
  return { audioPath: targetPath, audioHash };
}

async function persistUploadedAudioFile(file) {
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
  const targetPath = path.join(AUDIO_CACHE_DIR, `${audioHash}${extension}`);
  if (!await fileExists(targetPath)) {
    await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });
    await fs.writeFile(targetPath, file.buffer);
  }
  return { audioPath: targetPath, audioHash };
}

async function readJsonCache(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonCache(directory, key, value) {
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${key}.json`);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  return filePath;
}

function buildPreparedAudioPayload(payload = {}, persistedAudio = {}) {
  const resolvedAudioPath = safeString(persistedAudio.audioPath || payload.audioPath);
  return {
    ...payload,
    audioPath: resolvedAudioPath,
    audioHash: safeString(persistedAudio.audioHash || payload.audioHash),
    audioDataUrl: resolvedAudioPath ? null : payload.audioDataUrl,
  };
}

async function normalizePreparedPayloadForAnalyzer(payload = {}) {
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

function parseIncomingPayload(req) {
  if (safeString(req.body?.payload)) {
    try {
      return JSON.parse(req.body.payload);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

function buildAudioSubmissionFromUpload(file, fallback = {}) {
  if (!file) return fallback || null;
  return {
    name: safeString(file.originalname, safeString(fallback?.name)),
    mimeType: safeString(file.mimetype, safeString(fallback?.mimeType, "application/octet-stream")),
    size: safeNumber(file.size, file.buffer?.length),
    duration: safeNumber(fallback?.duration, null),
  };
}

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeWarningList(items = []) {
  const unique = [];
  const seen = new Set();
  for (const item of getArray(items)) {
    const text = safeString(item).trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }

  const hasDirectPagewise = unique.some(
    (item) => item.includes("按页识谱") && (item.includes("缩短导入等待时间") || item.includes("直接按页")),
  );
  if (!hasDirectPagewise) {
    return unique;
  }
  return unique.filter((item) => !item.includes("回退到按页识谱"));
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
}

function normalizePiecePackOverride(piecePack = {}, fallback = {}) {
  if (!piecePack || typeof piecePack !== "object") return null;

  const notes = getArray(piecePack.notes)
    .map((note, index) => {
      const measureIndex = Math.max(1, Math.round(safeNumber(note?.measureIndex, 1)));
      const beatStart = Math.max(0, safeNumber(note?.beatStart, 0));
      const beatDuration = Math.max(0.125, safeNumber(note?.beatDuration, 1));
      const midiPitch = clamp(Math.round(safeNumber(note?.midiPitch, 69)), 21, 108);
      const noteId = safeString(note?.noteId).trim() || `manual-m${measureIndex}-n${index + 1}`;
      const normalizedX = safeNumber(note?.notePosition?.normalizedX, NaN);
      const normalizedY = safeNumber(note?.notePosition?.normalizedY, NaN);
      const notePosition =
        Number.isFinite(normalizedX) && Number.isFinite(normalizedY)
          ? {
              pageNumber: Math.max(1, Math.round(safeNumber(note?.notePosition?.pageNumber, 1))),
              systemIndex: Math.max(1, Math.round(safeNumber(note?.notePosition?.systemIndex, 1))),
              staffIndex: Math.max(1, Math.round(safeNumber(note?.notePosition?.staffIndex, 1))),
              normalizedX: clamp(normalizedX, 0, 1),
              normalizedY: clamp(normalizedY, 0, 1),
              source: safeString(note?.notePosition?.source, "musicxml-layout"),
            }
          : null;
      return {
        noteId,
        measureIndex,
        beatStart,
        beatDuration,
        midiPitch,
        notePosition,
      };
    })
    .filter((note) => note.noteId);

  if (!notes.length) return null;

  return {
    pieceId: safeString(piecePack.pieceId, fallback.pieceId || "manual-pdf-piece") || fallback.pieceId || "manual-pdf-piece",
    sectionId: safeString(piecePack.sectionId, fallback.sectionId || "manual-section") || fallback.sectionId || "manual-section",
    title: safeString(piecePack.title, fallback.title || "PDF 手工录入片段") || fallback.title || "PDF 手工录入片段",
    composer: safeString(piecePack.composer, fallback.composer),
    targetSkills: getArray(piecePack.targetSkills).map((item) => safeString(item).trim()).filter(Boolean),
    difficulty: safeString(piecePack.difficulty, fallback.difficulty),
    tempo: clamp(safeNumber(piecePack.tempo, fallback.tempo || 72), 30, 220),
    meter: safeString(piecePack.meter, fallback.meter || "4/4") || fallback.meter || "4/4",
    demoAudio: safeString(piecePack.demoAudio, fallback.demoAudio),
    pageImagePath: safeString(piecePack.pageImagePath, fallback.pageImagePath),
    notes,
    noteCount: notes.length,
    measureCount: Math.max(...notes.map((note) => note.measureIndex)),
    scoreSource: piecePack.scoreSource && typeof piecePack.scoreSource === "object" ? piecePack.scoreSource : null,
  };
}

async function readStudyStore() {
  try {
    const raw = await fs.readFile(STUDY_STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      participants: Array.isArray(parsed.participants) ? parsed.participants.map((item) => normalizeParticipantRecord(item)) : [],
      analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
      validationReviews: Array.isArray(parsed.validationReviews) ? parsed.validationReviews.map((item) => normalizeValidationReview(item)) : [],
      adjudications: Array.isArray(parsed.adjudications) ? parsed.adjudications.map((item) => normalizeAdjudicationRecord(item)) : [],
    };
  } catch {
    return {
      participants: [],
      analyses: [],
      validationReviews: [],
      adjudications: [],
    };
  }
}

async function writeStudyStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STUDY_STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function readScoreStore() {
  try {
    const raw = await fs.readFile(SCORE_STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((item) => normalizeScoreImportJob(item)) : [],
      scores: Array.isArray(parsed.scores) ? parsed.scores.map((item) => normalizeImportedScoreRecord(item)) : [],
    };
  } catch {
    return { jobs: [], scores: [] };
  }
}

async function writeScoreStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SCORE_STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function collectFilesRecursive(rootDir, matcher) {
  const results = [];

  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!matcher || matcher(entry.name, absolutePath)) {
        results.push(absolutePath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

async function readLatestPiecePassSummary({ pieceId = "", title = "" } = {}) {
  const normalizedPieceId = normalizeSearchText(pieceId);
  const normalizedTitle = normalizeSearchText(title);
  const files = await collectFilesRecursive(
    PIECE_PASS_DIR,
    (name) => name.endsWith("-whole-piece-summary.json") || name.endsWith("-whole-piece-pass.json"),
  );
  if (!files.length) return null;

  const candidates = [];
  for (const filePath of files) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const summary = parsed.summary && typeof parsed.summary === "object" ? parsed.summary : parsed;
      const candidatePieceId = safeString(summary.pieceId, parsed.pieceId);
      const candidateTitle = safeString(summary.pieceTitle, parsed.pieceTitle);
      const normalizedCandidatePieceId = normalizeSearchText(candidatePieceId);
      const normalizedCandidateTitle = normalizeSearchText(candidateTitle);
      const pieceMatch = normalizedPieceId && normalizedCandidatePieceId === normalizedPieceId;
      const titleMatch =
        normalizedTitle &&
        normalizedCandidateTitle &&
        (normalizedTitle.includes(normalizedCandidateTitle) || normalizedCandidateTitle.includes(normalizedTitle));

      if ((normalizedPieceId || normalizedTitle) && !pieceMatch && !titleMatch) {
        continue;
      }

      const stat = await fs.stat(filePath);
      candidates.push({
        filePath,
        stat,
        summary,
      });
    } catch {
      // ignore malformed piece-pass exports
    }
  }

  if (!candidates.length) return null;
  candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const latest = candidates[0];
  return {
    sourcePath: latest.filePath,
    updatedAt: new Date(latest.stat.mtimeMs).toISOString(),
    summary: latest.summary,
  };
}

function normalizeSearchText(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[\s\-_（）()【】\[\]《》"“”'’.,，。:：/\\]+/g, "");
}

function normalizeImportedSections(sections = [], scoreFallback = {}) {
  return getArray(sections)
    .map((section, index) => ({
      raw: section,
      normalized: normalizePiecePackOverride(section, {
        pieceId: safeString(scoreFallback.pieceId),
        title: safeString(scoreFallback.title),
        composer: safeString(scoreFallback.composer),
        tempo: safeNumber(scoreFallback.tempo, 72),
        meter: safeString(scoreFallback.meter, "4/4") || "4/4",
        sectionId: `section-${index + 1}`,
      }),
    }))
    .filter((item) => item.normalized)
    .filter(Boolean)
    .map(({ raw, normalized }, index) => ({
      ...normalized,
      title: safeString(normalized.title, normalized.sectionId || `section-${index + 1}`),
      sequenceIndex: safeNumber(raw?.sequenceIndex, safeNumber(normalized.sequenceIndex, index + 1)) || index + 1,
      researchWindowHints: getArray(raw?.researchWindowHints).map((item) => safeNumber(item)).filter((item) => Number.isFinite(item)),
      sourceSectionId: safeString(raw?.sourceSectionId),
      measureRange: getArray(raw?.measureRange).map((item) => Math.round(safeNumber(item))).filter((item) => Number.isFinite(item)),
      pageImagePath: safeString(raw?.pageImagePath, normalized.pageImagePath),
    }));
}

function normalizeOmrStats(stats = {}) {
  const pageCount = Math.max(0, Math.round(safeNumber(stats.pageCount, 0)));
  const pageResultCacheHits = Math.max(0, Math.round(safeNumber(stats.pageResultCacheHits, 0)));
  const pageResultCacheMisses = Math.max(0, Math.round(safeNumber(stats.pageResultCacheMisses, 0)));
  const renderCacheHits = Math.max(0, Math.round(safeNumber(stats.renderCacheHits, 0)));
  const renderCacheMisses = Math.max(0, Math.round(safeNumber(stats.renderCacheMisses, 0)));
  const tileRenderCacheHits = Math.max(0, Math.round(safeNumber(stats.tileRenderCacheHits, 0)));
  const tileRenderCacheMisses = Math.max(0, Math.round(safeNumber(stats.tileRenderCacheMisses, 0)));
  const pageOmrRuns = Math.max(0, Math.round(safeNumber(stats.pageOmrRuns, 0)));
  const tileOmrRuns = Math.max(0, Math.round(safeNumber(stats.tileOmrRuns, 0)));
  return {
    mode: safeString(stats.mode, "none"),
    pageCount,
    resultCount: Math.max(0, Math.round(safeNumber(stats.resultCount, 0))),
    workers: Math.max(0, Math.round(safeNumber(stats.workers, 0))),
    wholePdfAttempted: safeBoolean(stats.wholePdfAttempted, false),
    pageResultCacheHits,
    pageResultCacheMisses,
    pageResultCacheHitRate: clamp(safeNumber(stats.pageResultCacheHitRate, pageCount ? pageResultCacheHits / Math.max(1, pageCount) : 0), 0, 1),
    renderCacheHits,
    renderCacheMisses,
    renderCacheHitRate: clamp(safeNumber(stats.renderCacheHitRate, (renderCacheHits + renderCacheMisses) ? renderCacheHits / Math.max(1, renderCacheHits + renderCacheMisses) : 0), 0, 1),
    tileRenderCacheHits,
    tileRenderCacheMisses,
    tileRenderCacheHitRate: clamp(safeNumber(stats.tileRenderCacheHitRate, (tileRenderCacheHits + tileRenderCacheMisses) ? tileRenderCacheHits / Math.max(1, tileRenderCacheHits + tileRenderCacheMisses) : 0), 0, 1),
    pageOmrRuns,
    tileOmrRuns,
  };
}

function buildCachedImportPreviewPages(score = {}, fallbackPreviewPages = [], sourcePdfPath = "") {
  const existingPreviewPages = getArray(score.previewPages)
    .map((page) => ({
      ...page,
      pageNumber: Math.max(1, Math.round(safeNumber(page?.pageNumber, 1))),
      type: safeString(page?.type, "pdf"),
      url: sourcePdfPath || safeString(page?.url),
    }))
    .filter((page) => Number.isFinite(page.pageNumber));
  if (existingPreviewPages.length) {
    return existingPreviewPages;
  }
  return getArray(fallbackPreviewPages).length ? fallbackPreviewPages : [{ pageNumber: 1, type: "pdf", url: sourcePdfPath }];
}

function buildReusedOmrStats(stats = {}, previewPages = []) {
  const normalized = normalizeOmrStats(stats);
  const previewCount = Math.max(1, getArray(previewPages).length);
  if (
    normalized.mode !== "none"
    || normalized.pageCount > 0
    || normalized.resultCount > 0
    || normalized.pageResultCacheHits > 0
    || normalized.pageResultCacheMisses > 0
    || normalized.renderCacheHits > 0
    || normalized.renderCacheMisses > 0
    || normalized.pageOmrRuns > 0
    || normalized.tileOmrRuns > 0
  ) {
    return {
      ...normalized,
      pageCount: normalized.pageCount || previewCount,
    };
  }
  return {
    ...normalized,
    mode: "reused-score",
    pageCount: previewCount,
    resultCount: previewCount,
    pageResultCacheHits: previewCount,
    pageResultCacheMisses: 0,
    pageResultCacheHitRate: 1,
  };
}

function normalizeImportedScoreRecord(score = {}) {
  const sections = normalizeImportedSections(score.sections, {
    pieceId: safeString(score.pieceId),
    title: safeString(score.title),
    composer: safeString(score.composer),
  });
  return {
    scoreId: safeString(score.scoreId),
    pieceId: safeString(score.pieceId),
    title: safeString(score.title, "未命名曲谱"),
    composer: safeString(score.composer),
    sourcePdfPath: safeString(score.sourcePdfPath),
    pdfHash: safeString(score.pdfHash),
    musicxmlPath: safeString(score.musicxmlPath),
    omrStatus: safeString(score.omrStatus, "completed"),
    omrConfidence: clamp(safeNumber(score.omrConfidence, 0), 0, 1),
    omrStats: normalizeOmrStats(score.omrStats),
    detectedParts: getArray(score.detectedParts).map((item) => safeString(item)).filter(Boolean),
    selectedPart: safeString(score.selectedPart, "erhu"),
    previewPages: getArray(score.previewPages),
    sections,
    createdAt: safeString(score.createdAt, nowIso()),
    updatedAt: safeString(score.updatedAt, score.createdAt || nowIso()),
  };
}

function importedScoreHasExactNotePositions(score = {}) {
  const sections = getArray(score.sections);
  const hasExactNotePositions = sections.some((section) =>
    getArray(section?.notes).some(
      (note) =>
        Number.isFinite(safeNumber(note?.notePosition?.normalizedX, NaN)) &&
        Number.isFinite(safeNumber(note?.notePosition?.normalizedY, NaN)),
    ),
  );
  const hasPageImages = sections.some((section) => safeString(section?.pageImagePath).length > 0);
  return hasExactNotePositions && hasPageImages;
}

function normalizeScoreImportJob(job = {}) {
  return {
    jobId: safeString(job.jobId),
    scoreId: safeString(job.scoreId),
    title: safeString(job.title),
    sourcePdfPath: safeString(job.sourcePdfPath),
    pdfHash: safeString(job.pdfHash),
    originalFilename: safeString(job.originalFilename),
    omrStatus: safeString(job.omrStatus, "processing"),
    omrConfidence: clamp(safeNumber(job.omrConfidence, 0), 0, 1),
    omrStats: normalizeOmrStats(job.omrStats),
    musicxmlPath: safeString(job.musicxmlPath),
    previewPages: getArray(job.previewPages),
    detectedParts: getArray(job.detectedParts).map((item) => safeString(item)).filter(Boolean),
      selectedPart: safeString(job.selectedPart, "erhu"),
      selectedPartCandidates: getArray(job.selectedPartCandidates).map((item) => safeString(item)).filter(Boolean),
      warnings: normalizeWarningList(job.warnings),
      cacheHit: safeBoolean(job.cacheHit),
      reusedScoreId: safeString(job.reusedScoreId),
      progress: clamp(safeNumber(job.progress, 0), 0, 1),
      stage: safeString(job.stage),
      error: safeString(job.error),
      createdAt: safeString(job.createdAt, nowIso()),
      updatedAt: safeString(job.updatedAt, job.createdAt || nowIso()),
    };
  }

function findReusableImportedScore(store, { pdfHash = "", selectedPart = "erhu" } = {}) {
  const normalizedHash = safeString(pdfHash).trim();
  if (!normalizedHash) return null;
  const desiredPart = safeString(selectedPart, "erhu") || "erhu";
  return (
    getArray(store?.scores).find(
      (score) =>
        safeString(score.pdfHash) === normalizedHash &&
        safeString(score.omrStatus, "completed") === "completed" &&
        (
          safeString(score.selectedPart).toLowerCase() === desiredPart.toLowerCase() ||
          getArray(score.detectedParts).some((item) => safeString(item).toLowerCase() === desiredPart.toLowerCase()) ||
          desiredPart.toLowerCase() === "erhu"
        ) &&
        importedScoreHasExactNotePositions(score) &&
        getArray(score.sections).length > 0,
    ) || null
  );
}

const activeScoreImportTasks = new Map();

async function upsertScoreImportJob(job) {
  const store = await readScoreStore();
  const normalizedJob = normalizeScoreImportJob(job);
  const existingJobIndex = store.jobs.findIndex((item) => item.jobId === normalizedJob.jobId);
  if (existingJobIndex >= 0) {
    store.jobs[existingJobIndex] = normalizedJob;
  } else {
    store.jobs.push(normalizedJob);
  }
  await writeScoreStore(store);
  return normalizedJob;
}

async function finalizeScoreImportArtifacts({ job, scoreRecord }) {
  const store = await readScoreStore();
  if (scoreRecord) {
    const normalizedScore = normalizeImportedScoreRecord(scoreRecord);
    const existingScoreIndex = store.scores.findIndex((item) => item.scoreId === normalizedScore.scoreId);
    if (existingScoreIndex >= 0) {
      store.scores[existingScoreIndex] = normalizedScore;
    } else {
      store.scores.push(normalizedScore);
    }
  }
  const normalizedJob = normalizeScoreImportJob(job);
  const existingJobIndex = store.jobs.findIndex((item) => item.jobId === normalizedJob.jobId);
  if (existingJobIndex >= 0) {
    store.jobs[existingJobIndex] = normalizedJob;
  } else {
    store.jobs.push(normalizedJob);
  }
  await writeScoreStore(store);
  return normalizedJob;
}

function launchScoreImportTask(task) {
  const existingTask = activeScoreImportTasks.get(task.jobId);
  if (existingTask) return existingTask;

  const runner = (async () => {
    const {
      jobId,
      titleHint,
      selectedPartHint,
      pdfHash,
      pdfPath,
      webPdfPath,
      originalFilename,
      fallbackPiece,
      previewPages,
    } = task;

    await upsertScoreImportJob({
      jobId,
      originalFilename,
      title: titleHint,
      sourcePdfPath: webPdfPath,
      pdfHash,
      omrStatus: "processing",
      omrConfidence: 0,
      previewPages,
      detectedParts: [selectedPartHint],
      selectedPart: selectedPartHint,
      selectedPartCandidates: [selectedPartHint],
      omrStats: { mode: "pending", pageCount: getArray(previewPages).length },
      warnings: ["正在后台识谱，请稍候。"],
      error: "",
      progress: 0.12,
      stage: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    let serviceWarning = "";
    let jobResult = null;
    try {
      await upsertScoreImportJob({
        jobId,
        originalFilename,
        title: titleHint,
        sourcePdfPath: webPdfPath,
        pdfHash,
        omrStatus: "processing",
        omrConfidence: 0,
        previewPages,
        detectedParts: [selectedPartHint],
        selectedPart: selectedPartHint,
        selectedPartCandidates: [selectedPartHint],
        omrStats: { mode: "pending", pageCount: getArray(previewPages).length },
        warnings: ["正在后台识谱，请稍候。"],
        error: "",
        progress: 0.3,
        stage: "omr-running",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      jobResult = await callExternalScoreImportLongTimeout({
        jobId,
        pdfPath,
        originalFilename,
        titleHint,
        selectedPartHint,
        fallbackPieceId: safeString(fallbackPiece?.pieceId),
        fallbackPieceTitle: safeString(fallbackPiece?.title),
        fallbackPiecePack: fallbackPiece,
        outputDir: path.dirname(pdfPath),
      });
    } catch (error) {
      serviceWarning = safeString(error?.message, "external score import unavailable");
    }

    if (jobResult?.omrStatus === "completed" && jobResult.piecePack) {
      const upstreamScoreId = safeString(jobResult.scoreId);
      const scoreId = upstreamScoreId.startsWith("score-") ? upstreamScoreId : createId("score");
      const importedSections = getArray(jobResult.piecePack?.sections).length ? jobResult.piecePack.sections : [jobResult.piecePack];
      const scoreRecord = {
        scoreId,
        pieceId: safeString(jobResult.piecePack?.pieceId, fallbackPiece?.pieceId),
        title: safeString(jobResult.title, fallbackPiece?.title || titleHint),
        composer: safeString(jobResult.piecePack?.composer, fallbackPiece?.composer),
        sourcePdfPath: webPdfPath,
        pdfHash,
        musicxmlPath: toWebPathFromAbsolute(jobResult.musicxmlPath),
        omrStatus: jobResult.omrStatus,
        omrConfidence: safeNumber(jobResult.omrConfidence, 0),
        omrStats: jobResult.omrStats,
        detectedParts: getArray(jobResult.detectedParts).length ? jobResult.detectedParts : [selectedPartHint],
        selectedPart: safeString(jobResult.selectedPart, selectedPartHint),
        previewPages: getArray(jobResult.previewPages).length ? jobResult.previewPages : previewPages,
        sections: importedSections,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await finalizeScoreImportArtifacts({
        scoreRecord,
        job: {
          ...jobResult,
          jobId,
          scoreId,
          title: scoreRecord.title,
          sourcePdfPath: webPdfPath,
          pdfHash,
          musicxmlPath: jobResult.musicxmlPath ? toWebPathFromAbsolute(jobResult.musicxmlPath) : "",
          originalFilename,
          previewPages: scoreRecord.previewPages,
          omrStats: scoreRecord.omrStats,
          warnings: [...getArray(jobResult.warnings), ...(serviceWarning ? [serviceWarning] : [])],
          error: jobResult.error,
          progress: 1,
          stage: "completed",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      });
      return;
    }

    if (fallbackPiece) {
      const scoreId = createId("score");
      const scoreRecord = {
        scoreId,
        pieceId: fallbackPiece.pieceId,
        title: fallbackPiece.title,
        composer: fallbackPiece.composer,
        sourcePdfPath: webPdfPath,
        pdfHash,
        musicxmlPath: "",
        omrStatus: "completed",
        omrConfidence: 0.44,
        omrStats: { mode: "fallback-piece", pageCount: getArray(previewPages).length, resultCount: getArray(fallbackPiece.sections).length },
        detectedParts: [selectedPartHint],
        selectedPart: selectedPartHint,
        previewPages,
        sections: fallbackPiece.sections,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await finalizeScoreImportArtifacts({
        scoreRecord,
        job: {
          jobId,
          scoreId,
          originalFilename,
          title: fallbackPiece.title,
          sourcePdfPath: webPdfPath,
          pdfHash,
          omrStatus: "completed",
          omrConfidence: 0.44,
          previewPages,
          detectedParts: [selectedPartHint],
          selectedPart: selectedPartHint,
          selectedPartCandidates: [selectedPartHint],
          omrStats: scoreRecord.omrStats,
          warnings: ["当前 PDF 通过已知曲目自动匹配进入结构化曲库。", ...(serviceWarning ? [serviceWarning] : [])],
          error: "",
          progress: 1,
          stage: "completed",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      });
      return;
    }

    await upsertScoreImportJob({
      jobId,
      originalFilename,
      title: titleHint,
      sourcePdfPath: webPdfPath,
      pdfHash,
      omrStatus: "failed",
      omrConfidence: 0,
      previewPages,
      detectedParts: [selectedPartHint],
      selectedPart: selectedPartHint,
      selectedPartCandidates: [selectedPartHint],
      omrStats: { mode: "failed", pageCount: getArray(previewPages).length },
      warnings: serviceWarning ? [serviceWarning] : [],
      error: "自动识谱失败。",
      progress: 1,
      stage: "failed",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  })()
    .catch(async (error) => {
      await upsertScoreImportJob({
        jobId: task.jobId,
        originalFilename: task.originalFilename,
        title: task.titleHint,
        sourcePdfPath: task.webPdfPath,
        pdfHash: task.pdfHash,
        omrStatus: "failed",
        omrConfidence: 0,
        previewPages: task.previewPages,
        detectedParts: [task.selectedPartHint],
        selectedPart: task.selectedPartHint,
        selectedPartCandidates: [task.selectedPartHint],
        omrStats: { mode: "failed", pageCount: getArray(task.previewPages).length },
        warnings: [safeString(error?.message, "score import failed")],
        error: "自动识谱失败。",
        progress: 1,
        stage: "failed",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    })
    .finally(() => {
      activeScoreImportTasks.delete(task.jobId);
    });

  activeScoreImportTasks.set(task.jobId, runner);
  return runner;
}

function getImportedScore(store, scoreId) {
  return store.scores.find((item) => item.scoreId === scoreId) || null;
}

function getImportedScoreSection(store, scoreId, sectionId) {
  const score = getImportedScore(store, scoreId);
  if (!score) return null;
  return score.sections.find((item) => item.sectionId === sectionId) || null;
}

function cloneLibraryPieceForImport(piece) {
  return {
    pieceId: safeString(piece?.pieceId),
    title: safeString(piece?.title),
    composer: safeString(piece?.composer),
    sections: getArray(piece?.sections).map((section, index) => ({
      pieceId: safeString(piece?.pieceId),
      sectionId: safeString(section?.sectionId, `section-${index + 1}`),
      title: safeString(section?.title, `Section ${index + 1}`),
      tempo: clamp(safeNumber(section?.tempo, 72), 30, 220),
      meter: safeString(section?.meter, "4/4") || "4/4",
      demoAudio: safeString(section?.demoAudio),
      sequenceIndex: safeNumber(section?.sequenceIndex, index + 1) || index + 1,
      researchWindowHints: getArray(section?.researchWindowHints).map((item) => safeNumber(item)).filter((item) => Number.isFinite(item)),
      notes: getArray(section?.notes).map((note, noteIndex) => ({
        noteId: safeString(note?.noteId, `${safeString(section?.sectionId, `section-${index + 1}`)}-n${noteIndex + 1}`),
        measureIndex: Math.max(1, Math.round(safeNumber(note?.measureIndex, 1))),
        beatStart: Math.max(0, safeNumber(note?.beatStart, 0)),
        beatDuration: Math.max(0.125, safeNumber(note?.beatDuration, 1)),
        midiPitch: clamp(Math.round(safeNumber(note?.midiPitch, 69)), 21, 108),
      })),
    })),
  };
}

function findKnownPieceForPdf(titleHint = "", fileName = "") {
  const needle = normalizeSearchText(`${titleHint} ${fileName}`);
  if (!needle) return null;
  const summaries = getErhuPieceSummaries();
  const match = summaries.find((piece) => {
    const title = normalizeSearchText(piece.title);
    const pieceId = normalizeSearchText(piece.pieceId);
    return (title && needle.includes(title)) || (pieceId && needle.includes(pieceId)) || (needle.includes("桃花坞") && piece.pieceId === "taohuawu-test-fragment");
  });
  return match ? getErhuPiece(match.pieceId) : null;
}

function toWebDataPath(...parts) {
  return `/data/${parts.map((part) => String(part).replace(/\\/g, "/")).join("/")}`;
}

function toWebPathFromAbsolute(filePath) {
  const absolute = safeString(filePath);
  if (!absolute) return "";
  const relative = path.relative(DATA_DIR, absolute);
  if (relative && !relative.startsWith("..")) {
    return toWebDataPath(relative);
  }
  return absolute;
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length;
}

function normalizeTaskPlanRecord(taskPlan = {}) {
  const status = safeString(taskPlan.status, "assigned");
  return {
    taskId: safeString(taskPlan.taskId),
    stage: safeString(taskPlan.stage, "week1"),
    pieceId: safeString(taskPlan.pieceId),
    sectionId: safeString(taskPlan.sectionId),
    focus: safeString(taskPlan.focus),
    instructions: safeString(taskPlan.instructions),
    practiceTargetMinutes: clamp(safeNumber(taskPlan.practiceTargetMinutes, 30), 0, 600),
    dueDate: safeString(taskPlan.dueDate),
    status,
    assignedBy: safeString(taskPlan.assignedBy, "researcher"),
    createdAt: safeString(taskPlan.createdAt, nowIso()),
    updatedAt: safeString(taskPlan.updatedAt, taskPlan.createdAt || nowIso()),
    completedAt: status === "completed" ? safeString(taskPlan.completedAt, taskPlan.updatedAt || nowIso()) : safeString(taskPlan.completedAt),
  };
}

function normalizeInterviewRecord(interview = {}) {
  return {
    interviewId: safeString(interview.interviewId),
    stage: safeString(interview.stage, "posttest"),
    interviewerId: safeString(interview.interviewerId, "researcher"),
    summary: safeString(interview.summary),
    barriers: safeString(interview.barriers),
    strategyChanges: safeString(interview.strategyChanges),
    representativeQuote: safeString(interview.representativeQuote),
    nextAction: safeString(interview.nextAction),
    followUpNeeded: safeBoolean(interview.followUpNeeded, false),
    submittedAt: safeString(interview.submittedAt, nowIso()),
  };
}

function normalizeInterviewSamplingRecord(sampling = {}) {
  return {
    selected: safeBoolean(sampling.selected, false),
    priority: safeString(sampling.priority, "candidate"),
    reason: safeString(sampling.reason),
    markedBy: safeString(sampling.markedBy, "researcher"),
    updatedAt: safeString(sampling.updatedAt, nowIso()),
  };
}

function toUniqueStringList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => safeString(item).trim()).filter(Boolean)));
  }
  return Array.from(new Set(String(value || "").split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean)));
}

function toUniqueNumberList(value) {
  return Array.from(
    new Set(
      toUniqueStringList(value)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.round(item)),
    ),
  );
}

function calculateBinaryMetrics(systemValues = [], teacherValues = []) {
  const systemSet = new Set(systemValues);
  const teacherSet = new Set(teacherValues);
  const matched = Array.from(teacherSet).filter((item) => systemSet.has(item));
  const precision = systemSet.size ? matched.length / systemSet.size : null;
  const recall = teacherSet.size ? matched.length / teacherSet.size : null;
  const f1 = precision != null && recall != null && (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return {
    matched,
    matchedCount: matched.length,
    missedTeacherValues: Array.from(teacherSet).filter((item) => !systemSet.has(item)),
    extraSystemValues: Array.from(systemSet).filter((item) => !teacherSet.has(item)),
    precision,
    recall,
    f1,
  };
}

function getAnalysisSystemNoteIds(analysis = {}) {
  return Array.from(new Set(getArray(analysis.noteFindings).map((item) => safeString(item.noteId)).filter(Boolean)));
}

function getAnalysisSystemMeasureIndexes(analysis = {}) {
  return Array.from(
    new Set(
      getArray(analysis.measureFindings)
        .map((item) => safeNumber(item.measureIndex))
        .filter((item) => Number.isFinite(item)),
    ),
  );
}

function getAnalysisRecommendedPracticePath(analysis = {}) {
  return safeString(analysis.recommendedPracticePath) || safeString(getArray(analysis.practiceTargets)[0]?.practicePath) || "review-first";
}

function normalizeValidationReview(review = {}) {
  return {
    reviewId: safeString(review.reviewId),
    analysisId: safeString(review.analysisId),
    participantId: safeString(review.participantId),
    groupId: safeString(review.groupId, "experimental"),
    sessionStage: safeString(review.sessionStage),
    pieceId: safeString(review.pieceId),
    sectionId: safeString(review.sectionId),
    raterId: safeString(review.raterId, "expert"),
    overallAgreement: clamp(safeNumber(review.overallAgreement, 0), 0, 5),
    teacherPrimaryPath: safeString(review.teacherPrimaryPath, "review-first"),
    teacherIssueNoteIds: toUniqueStringList(review.teacherIssueNoteIds),
    teacherIssueMeasureIndexes: toUniqueNumberList(review.teacherIssueMeasureIndexes),
    comments: safeString(review.comments),
    noteMatchedCount: safeNumber(review.noteMatchedCount, 0),
    notePrecision: review.notePrecision == null ? null : safeNumber(review.notePrecision, 0),
    noteRecall: review.noteRecall == null ? null : safeNumber(review.noteRecall, 0),
    noteF1: review.noteF1 == null ? null : safeNumber(review.noteF1, 0),
    measureMatchedCount: safeNumber(review.measureMatchedCount, 0),
    measurePrecision: review.measurePrecision == null ? null : safeNumber(review.measurePrecision, 0),
    measureRecall: review.measureRecall == null ? null : safeNumber(review.measureRecall, 0),
    measureF1: review.measureF1 == null ? null : safeNumber(review.measureF1, 0),
    missedTeacherNoteIds: toUniqueStringList(review.missedTeacherNoteIds),
    extraSystemNoteIds: toUniqueStringList(review.extraSystemNoteIds),
    missedTeacherMeasureIndexes: toUniqueNumberList(review.missedTeacherMeasureIndexes),
    extraSystemMeasureIndexes: toUniqueNumberList(review.extraSystemMeasureIndexes),
    systemRecommendedPath: safeString(review.systemRecommendedPath),
    pathAgreement: safeBoolean(review.pathAgreement, false),
    submittedAt: safeString(review.submittedAt, nowIso()),
  };
}

function normalizeAdjudicationRecord(adjudication = {}) {
  return {
    adjudicationId: safeString(adjudication.adjudicationId),
    analysisId: safeString(adjudication.analysisId),
    participantId: safeString(adjudication.participantId),
    groupId: safeString(adjudication.groupId, "experimental"),
    sessionStage: safeString(adjudication.sessionStage),
    pieceId: safeString(adjudication.pieceId),
    sectionId: safeString(adjudication.sectionId),
    adjudicatorId: safeString(adjudication.adjudicatorId, "researcher"),
    sourceRaterIds: toUniqueStringList(adjudication.sourceRaterIds),
    triggerReasons: toUniqueStringList(adjudication.triggerReasons),
    finalPrimaryPath: safeString(adjudication.finalPrimaryPath, "review-first"),
    finalIssueNoteIds: toUniqueStringList(adjudication.finalIssueNoteIds),
    finalIssueMeasureIndexes: toUniqueNumberList(adjudication.finalIssueMeasureIndexes),
    comments: safeString(adjudication.comments),
    noteMatchedCount: safeNumber(adjudication.noteMatchedCount, 0),
    notePrecision: adjudication.notePrecision == null ? null : safeNumber(adjudication.notePrecision, 0),
    noteRecall: adjudication.noteRecall == null ? null : safeNumber(adjudication.noteRecall, 0),
    noteF1: adjudication.noteF1 == null ? null : safeNumber(adjudication.noteF1, 0),
    measureMatchedCount: safeNumber(adjudication.measureMatchedCount, 0),
    measurePrecision: adjudication.measurePrecision == null ? null : safeNumber(adjudication.measurePrecision, 0),
    measureRecall: adjudication.measureRecall == null ? null : safeNumber(adjudication.measureRecall, 0),
    measureF1: adjudication.measureF1 == null ? null : safeNumber(adjudication.measureF1, 0),
    systemRecommendedPath: safeString(adjudication.systemRecommendedPath),
    pathAgreement: safeBoolean(adjudication.pathAgreement, false),
    resolvedAt: safeString(adjudication.resolvedAt, nowIso()),
  };
}

function normalizeParticipantRecord(participant = {}) {
  const questionnaires = Array.isArray(participant.questionnaires)
    ? participant.questionnaires
    : participant.experienceScales?.submittedAt
      ? [participant.experienceScales]
      : [];

  return {
    participantId: safeString(participant.participantId),
    groupId: safeString(participant.groupId, "experimental"),
    createdAt: safeString(participant.createdAt, nowIso()),
    lastActiveAt: safeString(participant.lastActiveAt, participant.createdAt || nowIso()),
    profile:
      participant.profile && typeof participant.profile === "object"
        ? {
            alias: safeString(participant.profile.alias),
            institution: safeString(participant.profile.institution),
            major: safeString(participant.profile.major),
            grade: safeString(participant.profile.grade),
            yearsOfTraining: safeNumber(participant.profile.yearsOfTraining, 0),
            weeklyPracticeMinutes: safeNumber(participant.profile.weeklyPracticeMinutes, 0),
            deviceLabel: safeString(participant.profile.deviceLabel),
            consentSigned: safeBoolean(participant.profile.consentSigned, false),
            notes: safeString(participant.profile.notes),
            updatedAt: safeString(participant.profile.updatedAt, participant.createdAt || nowIso()),
          }
        : null,
    pretest: participant.pretest || null,
    weeklySessions: getArray(participant.weeklySessions),
    posttest: participant.posttest || null,
    experienceScales: participant.experienceScales || null,
    questionnaires,
    usageLogs: getArray(participant.usageLogs),
    taskPlans: getArray(participant.taskPlans).map((item) => normalizeTaskPlanRecord(item)),
    interviews: getArray(participant.interviews).map((item) => normalizeInterviewRecord(item)),
    interviewSampling: normalizeInterviewSamplingRecord(participant.interviewSampling || {}),
    expertRatings:
      participant.expertRatings && typeof participant.expertRatings === "object"
        ? {
            pretest: participant.expertRatings.pretest || null,
            posttest: participant.expertRatings.posttest || null,
            weekly: getArray(participant.expertRatings.weekly),
          }
        : {
            pretest: null,
            posttest: null,
            weekly: [],
          },
  };
}

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function convertRowsToCsv(headers, rows) {
  const lines = [headers.map((header) => escapeCsvCell(header)).join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCsvCell(row[header])).join(","));
  });
  return lines.join("\n");
}

function getExpectedDurationSeconds(section) {
  const totalBeats = getArray(section?.notes).reduce((sum, note) => sum + safeNumber(note.beatDuration, 0), 0);
  return totalBeats * (60 / Math.max(30, safeNumber(section?.tempo, 72)));
}

function hashString(input) {
  let hash = 0;
  const text = safeString(input);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function pickFromSeed(seed, values = []) {
  if (!values.length) return null;
  return values[Math.abs(seed) % values.length];
}

const RHYTHM_PRIORITY_TYPES = new Set([
  "rhythm-rush",
  "rhythm-drag",
  "rhythm-duration-short",
  "rhythm-duration-long",
  "rhythm-rush-short",
  "rhythm-drag-long",
  "rhythm-measure-rush",
  "rhythm-measure-drag",
  "rhythm-measure-short",
  "rhythm-measure-long",
  "rhythm-unstable",
]);

function buildFallbackExplanation(overallPitchScore, overallRhythmScore, noteFindings, measureFindings) {
  const dominantDimension = overallRhythmScore < overallPitchScore ? "节奏" : "音准";
  const summaryText = `本次录音优先需要处理的是${dominantDimension}问题。系统定位到 ${noteFindings.length} 个问题音和 ${measureFindings.length} 个问题小节。`;
  const topNote = noteFindings[0];
  const topMeasure = measureFindings[0];
  const teacherComment = topNote
    ? `建议先处理 ${topNote.noteId}，确认单音稳定后再回到整段。`
    : topMeasure
      ? `建议先重练第 ${topMeasure.measureIndex} 小节，再回到整段复录。`
      : "当前结果较稳定，可保持当前练习方式。";

  const practiceTargets = [];
  if (topNote) {
    const practicePath =
      topNote.isUncertain || topNote.pitchLabel === "pitch-review"
        ? "review-first"
        : topNote.rhythmType === "rhythm-missing"
          ? "review-first"
          : RHYTHM_PRIORITY_TYPES.has(topNote.rhythmType) && topNote.pitchLabel === "pitch-ok"
          ? "rhythm-first"
          : "pitch-first";
    practiceTargets.push({
      priority: 1,
      targetType: "note",
      targetId: topNote.noteId,
      measureIndex: topNote.measureIndex,
      title: `先处理 ${topNote.noteId} 的落点与起拍`,
      why: topNote.why || "该音是当前偏差最集中的位置。",
      action: topNote.action || "先听示范，再做局部循环练习。",
      severity: topNote.severity || "medium",
      evidenceLabel: topNote.evidenceLabel || null,
      practicePath,
      pathReason:
        practicePath === "rhythm-first"
          ? "教师可先检查拍点是否明显偏前或偏后。"
          : practicePath === "pitch-first"
            ? "教师可先检查左手落点是否偏高或偏低。"
            : "系统建议先复核，再决定调整方向。",
    });
  }
  if (topMeasure) {
    const practicePath = RHYTHM_PRIORITY_TYPES.has(topMeasure.issueType) ? "rhythm-first" : "pitch-first";
    practiceTargets.push({
      priority: practiceTargets.length + 1,
      targetType: "measure",
      targetId: `measure-${topMeasure.measureIndex}`,
      measureIndex: topMeasure.measureIndex,
      title: `重练第 ${topMeasure.measureIndex} 小节`,
      why: topMeasure.detail || "该小节内部偏差较集中。",
      action: topMeasure.coachingTip || "先拆拍，再回到整小节练习。",
      severity: topMeasure.severity || "medium",
      evidenceLabel: topMeasure.issueLabel || null,
      practicePath,
      pathReason: practicePath === "rhythm-first" ? "该小节主要反映拍点稳定性问题。" : "该小节主要反映音高稳定性问题。",
    });
  }

  return { summaryText, teacherComment, recommendedPracticePath: practiceTargets[0]?.practicePath || "review-first", practiceTargets };
}

function buildFallbackAnalysis(payload, section) {
  const notes = getArray(section?.notes);
  const measureCount = Math.max(1, ...notes.map((note) => safeNumber(note.measureIndex, 1)));
  const expectedDuration = getExpectedDurationSeconds(section);
  const actualDuration = safeNumber(payload?.audioSubmission?.duration, expectedDuration || 1);
  const ratio = expectedDuration > 0 ? actualDuration / expectedDuration : 1;
  const seed = hashString([
    payload.participantId,
    payload.groupId,
    payload.sessionStage,
    payload.pieceId,
    payload.sectionId,
    payload.audioSubmission?.name,
    payload.audioSubmission?.size,
    payload.audioSubmission?.duration,
  ].join("|"));

  const stageOffset = safeString(payload.sessionStage).startsWith("post") ? 5 : safeString(payload.sessionStage).startsWith("week") ? 2 : -2;
  const pitchBase = 76 + stageOffset + (seed % 9);
  const rhythmPenalty = Math.round(Math.abs(ratio - 1) * 120);
  const rhythmBase = 88 + stageOffset - rhythmPenalty + (seed % 5);
  const overallPitchScore = clamp(pitchBase, 48, 96);
  const overallRhythmScore = clamp(rhythmBase, 42, 96);

  const pitchDirections = [
    { label: "音高偏低", code: "pitch-flat", cents: -28 },
    { label: "音高略低", code: "pitch-flat", cents: -15 },
    { label: "音高略高", code: "pitch-sharp", cents: 17 },
    { label: "音高偏高", code: "pitch-sharp", cents: 31 },
  ];
  const rhythmDirections = [
    { label: "节奏抢拍", ms: -82, durationMs: -48, type: "rhythm-rush", measureType: "rhythm-measure-rush", measureLabel: "小节整体偏快" },
    { label: "节奏拖拍", ms: 96, durationMs: 52, type: "rhythm-drag", measureType: "rhythm-measure-drag", measureLabel: "小节整体偏慢" },
    { label: "时值偏短", ms: -18, durationMs: -126, type: "rhythm-duration-short", measureType: "rhythm-measure-short", measureLabel: "小节时值普遍偏短" },
    { label: "时值偏长", ms: 22, durationMs: 148, type: "rhythm-duration-long", measureType: "rhythm-measure-long", measureLabel: "小节时值普遍偏长" },
    { label: "节奏不稳", ms: 0, durationMs: 0, type: "rhythm-unstable", measureType: "rhythm-unstable", measureLabel: "节奏不稳" },
  ];

  const measureFindings = Array.from({ length: Math.min(3, measureCount) }, (_, index) => {
    const measureIndex = ((seed + index * 7) % measureCount) + 1;
    const rhythmDirection = pickFromSeed(seed + index * 13, rhythmDirections);
    return {
      measureIndex,
      issueType: rhythmDirection.measureType,
      issueLabel: rhythmDirection.measureLabel,
      rhythmType: rhythmDirection.measureType,
      detail: `该小节与标准演奏相比，起拍约偏差 ${Math.abs(rhythmDirection.ms)} ms，时值约偏差 ${Math.abs(rhythmDirection.durationMs)} ms。`,
    };
  });

  const pickedNotes = notes
    .filter((_, index) => (index + seed) % 4 === 0)
    .slice(0, 4);

  const noteFindings = pickedNotes.map((note, index) => {
    const pitchDirection = pickFromSeed(seed + index * 5, pitchDirections);
    const rhythmDirection = pickFromSeed(seed + index * 11, rhythmDirections);
    const severity = Math.abs(pitchDirection.cents) >= 28 || Math.abs(rhythmDirection.ms) >= 90 ? "high" : "medium";
    return {
      noteId: note.noteId,
      measureIndex: note.measureIndex,
      expectedMidi: note.midiPitch,
      centsError: pitchDirection.cents,
      onsetErrorMs: rhythmDirection.ms,
      durationErrorMs: rhythmDirection.durationMs,
      expectedDurationMs: Math.round(safeNumber(note.beatDuration, 1) * (60 / Math.max(30, safeNumber(section?.tempo, 72))) * 1000),
      observedDurationMs: Math.round(
        safeNumber(note.beatDuration, 1) * (60 / Math.max(30, safeNumber(section?.tempo, 72))) * 1000 + rhythmDirection.durationMs,
      ),
      pitchLabel: pitchDirection.code,
      rhythmLabel: rhythmDirection.label,
      rhythmType: rhythmDirection.type,
      rhythmTypeLabel: rhythmDirection.label,
      pitchToleranceCents: 18,
      confidence: clamp(0.62 + ((seed + index) % 10) / 100, 0.55, 0.8),
      isUncertain: false,
      evidenceLabel: "fallback-simulation",
      severity,
      why: `${pitchDirection.label}，并且${rhythmDirection.label}。`,
      action:
        rhythmDirection.type === "rhythm-drag"
          ? "先跟节拍器重练这一音，再回到整小节。"
          : rhythmDirection.type === "rhythm-duration-short"
            ? "先把该音拉满时值，再回到原速。"
            : rhythmDirection.type === "rhythm-duration-long"
              ? "先收短这一音，再确认下一拍进入位置。"
          : pitchDirection.cents < 0
            ? "先慢速拉长该音，确认落点后再连接前后音。"
            : "先听示范，再做 3 次局部循环练习。",
    };
  });

  const enrichedMeasureFindings = measureFindings.map((item) => ({
    ...item,
    severity: item.issueType === "rhythm-unstable" ? "medium" : "low",
    coachingTip:
      item.issueType === "rhythm-measure-drag"
        ? "先把前一拍收干净，再确认下一拍进入时机。"
        : item.issueType === "rhythm-measure-short"
          ? "先按拍拉满每个音，再恢复原速。"
          : item.issueType === "rhythm-measure-long"
            ? "先缩短占拍过长的音，再检查后续拍点。"
            : "先放慢速度确认每拍位置。",
  }));

  const demoSegments = Array.from(new Set(enrichedMeasureFindings.map((item) => item.measureIndex))).map((measureIndex) => ({
    measureIndex,
    demoAudio: safeString(section?.demoAudio),
    label: `标准示范 · 第 ${measureIndex} 小节`,
  }));

  const explanation = buildFallbackExplanation(overallPitchScore, overallRhythmScore, noteFindings, enrichedMeasureFindings);

  return {
    overallPitchScore,
    overallRhythmScore,
    measureFindings: enrichedMeasureFindings,
    noteFindings,
    demoSegments,
    confidence: clamp(0.62 + ((seed % 12) / 100), 0.52, 0.78),
    summaryText: explanation.summaryText,
    teacherComment: explanation.teacherComment,
    recommendedPracticePath: explanation.recommendedPracticePath,
    practiceTargets: explanation.practiceTargets,
    analysisMode: "fallback",
    diagnostics: {
      requestedPreprocessMode: safeString(payload.preprocessMode, "off"),
      preprocessApplied: false,
      appliedPreprocessMode: "off",
    },
  };
}

function buildSectionFingerprint(section = {}) {
  return hashJson({
    pieceId: safeString(section?.pieceId),
    sectionId: safeString(section?.sectionId),
    sourceSectionId: safeString(section?.sourceSectionId),
    title: safeString(section?.title),
    sequenceIndex: safeNumber(section?.sequenceIndex, 0),
    tempo: safeNumber(section?.tempo, 72),
    meter: safeString(section?.meter, "4/4"),
    measureRange: getArray(section?.measureRange).map((item) => Math.round(safeNumber(item))),
    noteCount: getArray(section?.notes).length,
    notes: getArray(section?.notes).map((note) => ({
      noteId: safeString(note?.noteId),
      measureIndex: Math.round(safeNumber(note?.measureIndex, 0)),
      beatStart: safeNumber(note?.beatStart, 0),
      beatDuration: safeNumber(note?.beatDuration, 0),
      midiPitch: Math.round(safeNumber(note?.midiPitch, 0)),
    })),
    scoreSource: section?.scoreSource && typeof section.scoreSource === "object"
      ? {
          format: safeString(section.scoreSource.format),
          filename: safeString(section.scoreSource.filename),
          dataHash: hashString(safeString(section.scoreSource.data)),
        }
      : null,
  });
}

function buildSectionAnalysisCacheKey(payload = {}, section = {}) {
  return hashJson({
    analysisVersion: "v27-sparse-windowed-deep",
    audioHash: safeString(payload.audioHash),
    scoreId: safeString(payload.scoreId),
    pieceId: safeString(section?.pieceId, payload.pieceId),
    sectionId: safeString(section?.sectionId, payload.sectionId),
    preprocessMode: safeString(payload.preprocessMode, "off"),
    separationMode: safeString(payload.separationMode, safeString(payload.preprocessMode, "auto")),
    windowStartSeconds: Number.isFinite(Number(payload.windowStartSeconds))
      ? Number(Number(payload.windowStartSeconds).toFixed(3))
      : null,
    windowEndSeconds: Number.isFinite(Number(payload.windowEndSeconds))
      ? Number(Number(payload.windowEndSeconds).toFixed(3))
      : null,
    sectionFingerprint: buildSectionFingerprint(section),
  });
}

function buildSectionDetectionCacheKey(payload = {}, piece = {}, sections = [], options = {}) {
  return hashJson({
    detectionVersion: "v27-sparse-windowed-deep",
    audioHash: safeString(payload.audioHash),
    scoreId: safeString(payload.scoreId),
    pieceId: safeString(piece?.pieceId, payload.pieceId),
    preprocessMode: safeString(payload.preprocessMode, "off"),
    separationMode: safeString(payload.separationMode, safeString(payload.preprocessMode, "auto")),
    candidateSectionIds: getArray(options.candidateSectionIds).map((item) => safeString(item)).sort(),
    maxSections: Math.max(0, Math.round(safeNumber(options.maxSections, 0))),
    windowStartSeconds: Number.isFinite(Number(options.windowStartSeconds))
      ? Number(Number(options.windowStartSeconds).toFixed(3))
      : null,
    expectedSequenceIndex: Number.isFinite(Number(options.expectedSequenceIndex))
      ? Math.round(Number(options.expectedSequenceIndex))
      : null,
    sections: getArray(sections).map((section) => ({
      sectionId: safeString(section?.sectionId),
      sourceSectionId: safeString(section?.sourceSectionId),
      sequenceIndex: safeNumber(section?.sequenceIndex, 0),
      noteCount: getArray(section?.notes).length,
      noteFingerprint: hashJson(
        getArray(section?.notes).map((note) => ({
          noteId: safeString(note?.noteId),
          measureIndex: Math.round(safeNumber(note?.measureIndex, 0)),
          beatStart: safeNumber(note?.beatStart, 0),
          beatDuration: safeNumber(note?.beatDuration, 0),
          midiPitch: Math.round(safeNumber(note?.midiPitch, 0)),
        })),
      ),
    })),
  });
}

async function readSectionAnalysisCache(payload, section) {
  const audioHash = safeString(payload.audioHash);
  if (!audioHash) return null;
  const cacheKey = buildSectionAnalysisCacheKey(payload, section);
  const cached = await readJsonCache(path.join(SECTION_ANALYSIS_CACHE_DIR, `${cacheKey}.json`));
  return cached?.analysis || null;
}

async function writeSectionAnalysisCache(payload, section, analysis) {
  const audioHash = safeString(payload.audioHash);
  if (!audioHash || !analysis) return;
  const cacheKey = buildSectionAnalysisCacheKey(payload, section);
  await writeJsonCache(SECTION_ANALYSIS_CACHE_DIR, cacheKey, {
    cachedAt: nowIso(),
    pieceId: safeString(section?.pieceId, payload.pieceId),
    sectionId: safeString(section?.sectionId, payload.sectionId),
    analysis,
  });
}

async function readSectionDetectionCache(payload, piece, sections, options) {
  const audioHash = safeString(payload.audioHash);
  if (!audioHash) return null;
  const cacheKey = buildSectionDetectionCacheKey(payload, piece, sections, options);
  const cached = await readJsonCache(path.join(SECTION_DETECTION_CACHE_DIR, `${cacheKey}.json`));
  if (!cached) return null;
  const availableSections = getArray(piece?.sections);
  const bestSection = availableSections.find((section) => safeString(section.sectionId) === safeString(cached.bestSectionId)) || null;
  return {
    bestSection,
    bestAnalysis: cached.bestAnalysis || null,
    candidates: getArray(cached.candidates),
  };
}

async function writeSectionDetectionCache(payload, piece, sections, options, detection) {
  const audioHash = safeString(payload.audioHash);
  if (!audioHash || !detection?.bestSection) return;
  const cacheKey = buildSectionDetectionCacheKey(payload, piece, sections, options);
  await writeJsonCache(SECTION_DETECTION_CACHE_DIR, cacheKey, {
    cachedAt: nowIso(),
    pieceId: safeString(piece?.pieceId, payload.pieceId),
    bestSectionId: safeString(detection.bestSection?.sectionId),
    bestAnalysis: detection.bestAnalysis || null,
    candidates: getArray(detection.candidates).map((candidate) => compactDetectionCandidate(candidate)),
  });
}

async function callExternalAnalyzer(payload, section) {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl) return null;
  const analyzerAudioPath = await toAnalyzerPath(payload.audioPath);
  const response = await fetch(`${analyzerUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participantId: payload.participantId,
      groupId: payload.groupId,
      sessionStage: payload.sessionStage,
      scoreId: payload.scoreId,
      pieceId: section?.pieceId || payload.pieceId,
      sectionId: section?.sectionId || payload.sectionId,
      preprocessMode: payload.preprocessMode,
      separationMode: payload.separationMode,
      piecePack: section,
      audioSubmission: payload.audioSubmission,
      audioPath: analyzerAudioPath || payload.audioPath,
      audioDataUrl: analyzerAudioPath || payload.audioPath ? null : payload.audioDataUrl,
      windowStartSeconds: Number.isFinite(Number(payload.windowStartSeconds)) ? Number(payload.windowStartSeconds) : null,
      windowEndSeconds: Number.isFinite(Number(payload.windowEndSeconds)) ? Number(payload.windowEndSeconds) : null,
    }),
  });
  if (!response.ok) {
    throw new Error(`外部分析器请求失败：${response.status}`);
  }
  const json = await response.json();
  return json?.analysis || null;
}

async function callExternalScoreImport(payload) {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl) return null;
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(20 * 60 * 1000)
    : undefined;
  const response = await fetch(`${analyzerUrl}/score/import-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`外部识谱服务请求失败：${response.status}`);
  }
  const json = await response.json();
  return json?.job || null;
}

async function callExternalScoreImportLongTimeout(payload) {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl) return null;
  const target = new URL(`${analyzerUrl}/score/import-pdf`);
  const transport = target.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);

  const json = await new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "POST",
        agent: false,
        headers: {
          "Connection": "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 20 * 60 * 1000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`score import upstream failed: ${response.statusCode || 500}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("score import timed out"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });

  return json?.job || null;
}

async function callExternalAnalyzerLongTimeout(payload, section) {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl) return null;
  const target = new URL(`${analyzerUrl}/analyze`);
  const transport = target.protocol === "https:" ? https : http;
  const analyzerAudioPath = await toAnalyzerPath(payload.audioPath);
  appendPerfTrace(
    `[upstream-analyze] sectionId=${safeString(section?.sectionId)} audioPath=${safeString(analyzerAudioPath || payload.audioPath)}`,
  );
  const body = JSON.stringify({
    participantId: payload.participantId,
    groupId: payload.groupId,
    sessionStage: payload.sessionStage,
    scoreId: payload.scoreId,
    pieceId: section?.pieceId || payload.pieceId,
    sectionId: section?.sectionId || payload.sectionId,
    preprocessMode: payload.preprocessMode,
    separationMode: payload.separationMode,
    piecePack: section,
    audioSubmission: payload.audioSubmission,
    audioPath: analyzerAudioPath || payload.audioPath,
    audioDataUrl: analyzerAudioPath || payload.audioPath ? null : payload.audioDataUrl,
    windowStartSeconds: Number.isFinite(Number(payload.windowStartSeconds)) ? Number(payload.windowStartSeconds) : null,
    windowEndSeconds: Number.isFinite(Number(payload.windowEndSeconds)) ? Number(payload.windowEndSeconds) : null,
  });

  const json = await new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "POST",
        agent: false,
        headers: {
          "Connection": "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30 * 60 * 1000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`analysis upstream failed: ${response.statusCode || 500}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("analysis timed out"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });

  return json?.analysis || null;
}

async function callExternalSectionRankLongTimeout(payload, sections, piece) {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl || !Array.isArray(sections) || !sections.length) return null;
  const target = new URL(`${analyzerUrl}/detect-sections`);
  const transport = target.protocol === "https:" ? https : http;
  const analyzerAudioPath = await toAnalyzerPath(payload.audioPath);
  appendPerfTrace(
    `[upstream-detect] pieceId=${safeString(piece?.pieceId)} sectionCount=${sections.length} audioPath=${safeString(analyzerAudioPath || payload.audioPath)}`,
  );
  const body = JSON.stringify({
    participantId: payload.participantId,
    groupId: payload.groupId,
    sessionStage: payload.sessionStage,
    scoreId: payload.scoreId,
    pieceId: safeString(piece?.pieceId, payload.pieceId),
    preprocessMode: payload.preprocessMode,
    separationMode: payload.separationMode,
    audioSubmission: payload.audioSubmission,
    audioPath: analyzerAudioPath || payload.audioPath,
    audioDataUrl: analyzerAudioPath || payload.audioPath ? null : payload.audioDataUrl,
    piecePacks: sections,
  });

  const json = await new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "POST",
        agent: false,
        headers: {
          "Connection": "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30 * 60 * 1000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`section rank upstream failed: ${response.statusCode || 500}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("section rank timed out"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });

  return Array.isArray(json?.candidates) ? json.candidates : [];
}

async function runSectionAnalysis(payload, section) {
  const cachedAnalysis = await readSectionAnalysisCache(payload, section);
  if (cachedAnalysis) {
    appendPerfTrace(
      `[section-analysis] cache-hit sectionId=${safeString(section?.sectionId)} noteCount=${getArray(section?.notes).length}`,
    );
    return cachedAnalysis;
  }

  let analysis = null;
  appendPerfTrace(
    `[section-analysis] start sectionId=${safeString(section?.sectionId)} noteCount=${getArray(section?.notes).length} preprocess=${safeString(payload.preprocessMode)} separation=${safeString(payload.separationMode)}`,
  );
  try {
    analysis = await callExternalAnalyzerLongTimeout(payload, section);
    appendPerfTrace(
      `[section-analysis] upstream-ok sectionId=${safeString(section?.sectionId)} mode=${safeString(analysis?.analysisMode, "external")}`,
    );
  } catch {
    analysis = null;
    appendPerfTrace(
      `[section-analysis] upstream-failed sectionId=${safeString(section?.sectionId)}`,
    );
  }

  if (!analysis) {
    analysis = buildFallbackAnalysis(payload, section);
  } else {
    analysis.analysisMode = "external";
    await writeSectionAnalysisCache(payload, section, analysis);
  }

  return analysis;
}

function scoreCandidateAnalysis(analysis = {}) {
  const pitchScore = safeNumber(analysis.overallPitchScore, 0);
  const rhythmScore = safeNumber(analysis.overallRhythmScore, 0);
  const confidence = safeNumber(analysis.confidence, 0);
  const measurePenalty = getArray(analysis.measureFindings).length * 0.8;
  const notePenalty = getArray(analysis.noteFindings).length * 0.4;
  return Number((pitchScore * 0.45 + rhythmScore * 0.45 + confidence * 10 - measurePenalty - notePenalty).toFixed(2));
}

function buildSectionCandidate(section, analysis) {
  return {
    sourceSection: section ? { ...section } : null,
    pieceId: safeString(section?.pieceId),
    sectionId: safeString(section?.sectionId),
    sourceSectionId: safeString(section?.sourceSectionId),
    sectionTitle: safeString(section?.title),
    sequenceIndex: safeNumber(section?.sequenceIndex, 0),
    researchWindowHints: getArray(section?.researchWindowHints).map((value) => safeNumber(value)).filter((value) => Number.isFinite(value)),
    score: scoreCandidateAnalysis(analysis),
    overallPitchScore: clamp(safeNumber(analysis?.overallPitchScore, 0), 0, 100),
    overallRhythmScore: clamp(safeNumber(analysis?.overallRhythmScore, 0), 0, 100),
    confidence: clamp(safeNumber(analysis?.confidence, 0), 0, 1),
    recommendedPracticePath: safeString(analysis?.recommendedPracticePath),
    measureFindingCount: getArray(analysis?.measureFindings).length,
    noteFindingCount: getArray(analysis?.noteFindings).length,
    summaryText: safeString(analysis?.summaryText),
    diagnostics: analysis?.diagnostics && typeof analysis.diagnostics === "object" ? analysis.diagnostics : null,
  };
}

function compactSectionForDetection(section = {}) {
  return {
    pieceId: safeString(section?.pieceId),
    sectionId: safeString(section?.sectionId),
    sourceSectionId: safeString(section?.sourceSectionId),
    title: safeString(section?.title),
    tempo: clamp(safeNumber(section?.tempo, 72), 30, 220),
    meter: safeString(section?.meter, "4/4") || "4/4",
    sequenceIndex: safeNumber(section?.sequenceIndex, 0),
    measureRange: getArray(section?.measureRange),
    chunkBeatRange: getArray(section?.chunkBeatRange),
    noteCount: getArray(section?.notes).length,
    chunkedImported: safeBoolean(section?.chunkedImported, false),
  };
}

function compactDetectionCandidate(candidate = {}) {
  const diagnostics = candidate?.diagnostics && typeof candidate.diagnostics === "object" ? candidate.diagnostics : null;
  return {
    pieceId: safeString(candidate?.pieceId),
    sectionId: safeString(candidate?.sectionId),
    sourceSectionId: safeString(candidate?.sourceSectionId),
    sectionTitle: safeString(candidate?.sectionTitle),
    sequenceIndex: safeNumber(candidate?.sequenceIndex, 0),
    score: safeNumber(candidate?.score, 0),
    priorAdjustedScore: safeNumber(candidate?.priorAdjustedScore, safeNumber(candidate?.score, 0)),
    confidence: clamp(safeNumber(candidate?.confidence, 0), 0, 1),
    overallPitchScore: clamp(safeNumber(candidate?.overallPitchScore, 0), 0, 100),
    overallRhythmScore: clamp(safeNumber(candidate?.overallRhythmScore, 0), 0, 100),
    recommendedPracticePath: safeString(candidate?.recommendedPracticePath),
    measureFindingCount: Math.max(0, Math.round(safeNumber(candidate?.measureFindingCount, 0))),
    noteFindingCount: Math.max(0, Math.round(safeNumber(candidate?.noteFindingCount, 0))),
    summaryText: safeString(candidate?.summaryText),
    nearestHintDistance: Number.isFinite(safeNumber(candidate?.nearestHintDistance, NaN)) ? safeNumber(candidate?.nearestHintDistance) : null,
    sequenceDistance: Number.isFinite(safeNumber(candidate?.sequenceDistance, NaN)) ? safeNumber(candidate?.sequenceDistance) : null,
    sourceSection: compactSectionForDetection(candidate?.sourceSection || {}),
    diagnostics: diagnostics
      ? {
          pitchSource: safeString(diagnostics?.pitchSource),
          onsetSource: safeString(diagnostics?.onsetSource),
          beatSource: safeString(diagnostics?.beatSource),
          scoreSource: safeString(diagnostics?.scoreSource),
          scoreNoteCount: Math.max(0, Math.round(safeNumber(diagnostics?.scoreNoteCount, 0))),
          alignedNoteCount: Math.max(0, Math.round(safeNumber(diagnostics?.alignedNoteCount, 0))),
          separationApplied: safeBoolean(diagnostics?.separationApplied, false),
          separationMode: safeString(diagnostics?.separationMode),
          separationConfidence: clamp(safeNumber(diagnostics?.separationConfidence, 0), 0, 1),
          detectedWindowStartSeconds: Number.isFinite(safeNumber(diagnostics?.detectedWindowStartSeconds, NaN))
            ? safeNumber(diagnostics?.detectedWindowStartSeconds)
            : null,
          detectedWindowEndSeconds: Number.isFinite(safeNumber(diagnostics?.detectedWindowEndSeconds, NaN))
            ? safeNumber(diagnostics?.detectedWindowEndSeconds)
            : null,
          detectedWindowDurationSeconds: Number.isFinite(safeNumber(diagnostics?.detectedWindowDurationSeconds, NaN))
            ? safeNumber(diagnostics?.detectedWindowDurationSeconds)
            : null,
          detectedWindowMatchedNoteCount: Math.max(0, Math.round(safeNumber(diagnostics?.detectedWindowMatchedNoteCount, 0))),
          scoreExpectedDurationSeconds: Number.isFinite(safeNumber(diagnostics?.scoreExpectedDurationSeconds, NaN))
            ? safeNumber(diagnostics?.scoreExpectedDurationSeconds)
            : null,
        }
      : null,
  };
}

function buildDetectionSummaryAnalysis(candidate = {}) {
  const diagnostics = candidate?.diagnostics && typeof candidate.diagnostics === "object" ? candidate.diagnostics : {};
  return {
    overallPitchScore: clamp(safeNumber(candidate?.overallPitchScore, 0), 0, 100),
    overallRhythmScore: clamp(safeNumber(candidate?.overallRhythmScore, 0), 0, 100),
    studentPitchScore: clamp(safeNumber(candidate?.overallPitchScore, 0), 0, 100),
    studentRhythmScore: clamp(safeNumber(candidate?.overallRhythmScore, 0), 0, 100),
    studentCombinedScore: clamp(
      Math.round((safeNumber(candidate?.overallPitchScore, 0) + safeNumber(candidate?.overallRhythmScore, 0)) / 2),
      0,
      100,
    ),
    confidence: clamp(safeNumber(candidate?.confidence, 0), 0, 1),
    recommendedPracticePath: safeString(candidate?.recommendedPracticePath, "review-first"),
    measureFindings: [],
    noteFindings: [],
    demoSegments: [],
    analysisMode: "detection-summary",
    diagnostics,
    separationApplied: safeBoolean(diagnostics?.separationApplied, false),
    separationMode: safeString(diagnostics?.separationMode),
    separationConfidence: clamp(safeNumber(diagnostics?.separationConfidence, 0), 0, 1),
  };
}

function getCandidateDetectedWindow(candidate = {}) {
  const diagnostics = candidate?.diagnostics && typeof candidate.diagnostics === "object" ? candidate.diagnostics : null;
  if (!diagnostics) return null;
  const windowStartSeconds = safeNumber(diagnostics.detectedWindowStartSeconds, NaN);
  const windowEndSeconds = safeNumber(diagnostics.detectedWindowEndSeconds, NaN);
  if (!Number.isFinite(windowStartSeconds) || !Number.isFinite(windowEndSeconds) || windowEndSeconds <= windowStartSeconds) {
    return null;
  }
  return {
    windowStartSeconds: Number(windowStartSeconds.toFixed(3)),
    windowEndSeconds: Number(windowEndSeconds.toFixed(3)),
    windowDurationSeconds: Number((windowEndSeconds - windowStartSeconds).toFixed(3)),
  };
}

function buildCandidateAnalysisWindow(candidate = null, section = null) {
  const detectedWindow = getCandidateDetectedWindow(candidate);
  if (!detectedWindow) return null;
  const diagnostics = candidate?.diagnostics && typeof candidate.diagnostics === "object" ? candidate.diagnostics : {};
  const noteCount = getArray(section?.notes).length || safeNumber(candidate?.sourceSection?.noteCount, 0);
  const chunkedImported = safeBoolean(section?.chunkedImported, safeBoolean(candidate?.sourceSection?.chunkedImported, false));
  const scoreExpectedDurationSeconds = safeNumber(diagnostics?.scoreExpectedDurationSeconds, 0);

  if (chunkedImported) {
    return detectedWindow;
  }
  if (noteCount < 14) {
    if (scoreExpectedDurationSeconds <= 0) {
      return null;
    }
    const centerSeconds = (detectedWindow.windowStartSeconds + detectedWindow.windowEndSeconds) / 2;
    const targetDurationSeconds = clamp(
      Math.max(scoreExpectedDurationSeconds * 2.5, detectedWindow.windowDurationSeconds + 60),
      80,
      140,
    );
    const windowStartSeconds = Math.max(0, centerSeconds - targetDurationSeconds / 2);
    const windowEndSeconds = windowStartSeconds + targetDurationSeconds;
    return {
      windowStartSeconds: Number(windowStartSeconds.toFixed(3)),
      windowEndSeconds: Number(windowEndSeconds.toFixed(3)),
      windowDurationSeconds: Number(targetDurationSeconds.toFixed(3)),
    };
  }
  if (noteCount >= 96 && scoreExpectedDurationSeconds > 0) {
    const centerSeconds = (detectedWindow.windowStartSeconds + detectedWindow.windowEndSeconds) / 2;
    const targetDurationSeconds = clamp(
      Math.max(scoreExpectedDurationSeconds * 1.15, detectedWindow.windowDurationSeconds + 18),
      70,
      180,
    );
    const windowStartSeconds = Math.max(0, centerSeconds - targetDurationSeconds / 2);
    const windowEndSeconds = windowStartSeconds + targetDurationSeconds;
    return {
      windowStartSeconds: Number(windowStartSeconds.toFixed(3)),
      windowEndSeconds: Number(windowEndSeconds.toFixed(3)),
      windowDurationSeconds: Number(targetDurationSeconds.toFixed(3)),
    };
  }
  if (scoreExpectedDurationSeconds > 0 && detectedWindow.windowDurationSeconds < scoreExpectedDurationSeconds * 0.75) {
    return null;
  }
  return detectedWindow;
}

function applyCandidateDetectedWindow(payload = {}, candidate = null, section = null) {
  const explicitWindowStart = safeNumber(payload.windowStartSeconds, NaN);
  const explicitWindowEnd = safeNumber(payload.windowEndSeconds, NaN);
  if (Number.isFinite(explicitWindowStart) && Number.isFinite(explicitWindowEnd) && explicitWindowEnd > explicitWindowStart) {
    return payload;
  }
  const detectedWindow = buildCandidateAnalysisWindow(candidate, section);
  if (!detectedWindow) return payload;
  return {
    ...payload,
    windowStartSeconds: detectedWindow.windowStartSeconds,
    windowEndSeconds: detectedWindow.windowEndSeconds,
  };
}

function shouldUseDetectedWindowAnalysis(candidate = null, section = null) {
  return !!buildCandidateAnalysisWindow(candidate, section);
}

function getSectionGroupId(section = {}) {
  const explicit = safeString(section?.sourceSectionId).trim();
  if (explicit) return explicit;
  const sectionId = safeString(section?.sectionId).trim();
  const chunkMatch = sectionId.match(/^(.*)-s\d+$/i);
  return chunkMatch ? safeString(chunkMatch[1]) : sectionId;
}

function buildDetectionProbeSection(groupId, sections = [], piece = {}) {
  const orderedSections = getArray(sections)
    .slice()
    .sort((left, right) => safeNumber(left.sequenceIndex, 0) - safeNumber(right.sequenceIndex, 0));
  if (!orderedSections.length) return null;

  const allNotes = orderedSections
    .flatMap((section) => getArray(section.notes))
    .slice()
    .sort((left, right) => {
      if (safeNumber(left.measureIndex, 0) !== safeNumber(right.measureIndex, 0)) {
        return safeNumber(left.measureIndex, 0) - safeNumber(right.measureIndex, 0);
      }
      if (safeNumber(left.beatStart, 0) !== safeNumber(right.beatStart, 0)) {
        return safeNumber(left.beatStart, 0) - safeNumber(right.beatStart, 0);
      }
      return safeNumber(left.midiPitch, 0) - safeNumber(right.midiPitch, 0);
    });
  if (!allNotes.length) return null;

  const targetCount = allNotes.length > 180 ? 28 : allNotes.length > 96 ? 24 : Math.min(18, allNotes.length);
  const sampledNotes = [];
  const usedIndexes = new Set();
  for (let sampleIndex = 0; sampleIndex < targetCount; sampleIndex += 1) {
    const sourceIndex = Math.round((sampleIndex / Math.max(1, targetCount - 1)) * Math.max(0, allNotes.length - 1));
    if (usedIndexes.has(sourceIndex)) continue;
    usedIndexes.add(sourceIndex);
    sampledNotes.push({ ...allNotes[sourceIndex] });
  }

  const firstSection = orderedSections[0];
  const lastSection = orderedSections[orderedSections.length - 1];
  const mergedHints = Array.from(
    new Set(
      orderedSections
        .flatMap((section) => getArray(section.researchWindowHints))
        .map((value) => safeNumber(value))
        .filter((value) => Number.isFinite(value)),
    ),
  );

  return {
    pieceId: safeString(piece?.pieceId, safeString(firstSection?.pieceId)),
    sectionId: `${groupId}--probe`,
    sourceSectionId: groupId,
    title: `${safeString(firstSection?.title, groupId)} 粗筛`,
    tempo: clamp(safeNumber(firstSection?.tempo, 72), 30, 220),
    meter: safeString(firstSection?.meter, "4/4") || "4/4",
    demoAudio: "",
    sequenceIndex: safeNumber(firstSection?.sequenceIndex, 0),
    researchWindowHints: mergedHints,
    notes: sampledNotes,
    measureRange: (() => {
      const firstRange = getArray(firstSection?.measureRange);
      const lastRange = getArray(lastSection?.measureRange);
      if (firstRange.length && lastRange.length) {
        return [Math.min(...firstRange), Math.max(...lastRange)];
      }
      return [];
    })(),
    detectionProbe: true,
    detectionTargetSectionCount: orderedSections.length,
  };
}

function sampleSectionsForDetection(sections = [], targetCount = 6) {
  const orderedSections = getArray(sections)
    .slice()
    .sort((left, right) => safeNumber(left.sequenceIndex, 0) - safeNumber(right.sequenceIndex, 0));
  if (orderedSections.length <= targetCount) {
    return orderedSections;
  }

  const indexes = new Set([0, orderedSections.length - 1]);
  const desired = Math.max(2, targetCount);
  for (let sampleIndex = 0; sampleIndex < desired; sampleIndex += 1) {
    const sourceIndex = Math.round((sampleIndex / Math.max(1, desired - 1)) * Math.max(0, orderedSections.length - 1));
    indexes.add(sourceIndex);
  }

  return Array.from(indexes)
    .sort((left, right) => left - right)
    .map((index) => orderedSections[index])
    .filter(Boolean);
}

function expandSectionsAroundCandidates(candidates = [], allSections = [], radius = 2) {
  const orderedSections = getArray(allSections)
    .slice()
    .sort((left, right) => safeNumber(left.sequenceIndex, 0) - safeNumber(right.sequenceIndex, 0));
  if (!orderedSections.length) return [];

  const indexBySectionId = new Map(
    orderedSections.map((section, index) => [safeString(section.sectionId), index]),
  );
  const selectedIndexes = new Set();
  for (const candidate of getArray(candidates)) {
    const sectionId = safeString(candidate?.sectionId || candidate?.sourceSection?.sectionId);
    if (!sectionId || !indexBySectionId.has(sectionId)) continue;
    const baseIndex = indexBySectionId.get(sectionId);
    for (let offset = -radius; offset <= radius; offset += 1) {
      const targetIndex = baseIndex + offset;
      if (targetIndex >= 0 && targetIndex < orderedSections.length) {
        selectedIndexes.add(targetIndex);
      }
    }
  }

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => orderedSections[index])
    .filter(Boolean);
}

function pickProbeGroupIds(probeCandidates = []) {
  const candidates = getArray(probeCandidates);
  if (!candidates.length) return new Set();
  if (candidates.length === 1) {
    return new Set([getSectionGroupId(candidates[0].sourceSection || candidates[0])]);
  }
  const top = candidates[0];
  const second = candidates[1];
  const gap = safeNumber(top.priorAdjustedScore, 0) - safeNumber(second.priorAdjustedScore, 0);
  const topConfidence = safeNumber(top.confidence, 0);
  const groupCount = gap >= 10 && topConfidence >= 0.8 ? 1 : gap >= 5 && topConfidence >= 0.72 ? 2 : 3;
  return new Set(
    candidates
      .slice(0, Math.max(1, Math.min(groupCount, candidates.length)))
      .map((candidate) => getSectionGroupId(candidate.sourceSection || candidate)),
  );
}

function applySectionPrior(candidate, options = {}) {
  const windowStartSeconds = Number(options.windowStartSeconds);
  const expectedSequenceIndex = Number(options.expectedSequenceIndex);
  const hintPenaltyFactor = safeNumber(options.hintPenaltyFactor, 1.75);
  const sequencePenaltyFactor = safeNumber(options.sequencePenaltyFactor, 2.5);
  const hints = getArray(candidate.researchWindowHints).map((value) => safeNumber(value)).filter((value) => Number.isFinite(value));

  let priorAdjustedScore = safeNumber(candidate.score, 0);
  let nearestHintDistance = null;
  let sequenceDistance = null;

  if (Number.isFinite(windowStartSeconds) && hints.length) {
    nearestHintDistance = Math.min(...hints.map((value) => Math.abs(value - windowStartSeconds)));
    priorAdjustedScore -= nearestHintDistance * hintPenaltyFactor;
  }

  if (Number.isFinite(expectedSequenceIndex) && safeNumber(candidate.sequenceIndex, 0) > 0) {
    sequenceDistance = Math.abs(safeNumber(candidate.sequenceIndex, 0) - expectedSequenceIndex);
    priorAdjustedScore -= sequenceDistance * sequencePenaltyFactor;
  }

  return {
    ...candidate,
    nearestHintDistance,
    sequenceDistance,
    priorAdjustedScore: Number(priorAdjustedScore.toFixed(2)),
  };
}

function getImportedSectionStats(sections = []) {
  const filtered = getArray(sections).filter((section) => getArray(section?.notes).length > 0);
  const noteCounts = filtered.map((section) => getArray(section?.notes).length);
  const averageNoteCount = noteCounts.length
    ? noteCounts.reduce((sum, value) => sum + value, 0) / noteCounts.length
    : 0;
  const richSectionCount = noteCounts.filter((value) => value >= 8).length;
  const sparseSectionCount = noteCounts.filter((value) => value <= 3).length;
  return {
    sectionCount: filtered.length,
    averageNoteCount,
    richSectionCount,
    sparseSectionCount,
  };
}

function applyImportedSparseSectionPenalty(candidate, piece = null, stats = null) {
  if (!candidate || !piece) return candidate;
  const sourcePdfPath = safeString(piece?.sourcePdfPath);
  const scoreId = safeString(piece?.scoreId);
  const isImportedScore = sourcePdfPath.length > 0 || scoreId.startsWith("score-");
  if (!isImportedScore) return candidate;

  const sourceSection = candidate.sourceSection || {};
  const noteCount = Math.max(0, getArray(sourceSection?.notes).length || safeNumber(sourceSection?.noteCount, 0));
  const chunkedImported = safeBoolean(sourceSection?.chunkedImported, false);
  const measureRange = getArray(sourceSection?.measureRange);
  const diagnostics = candidate?.diagnostics && typeof candidate.diagnostics === "object" ? candidate.diagnostics : {};
  const alignedNoteCount = Math.max(0, Math.round(safeNumber(diagnostics?.alignedNoteCount, 0)));
  const scoreNoteCount = Math.max(0, Math.round(safeNumber(diagnostics?.scoreNoteCount, noteCount)));
  const scoreExpectedDurationSeconds = safeNumber(diagnostics?.scoreExpectedDurationSeconds, 0);
  const richSectionCount = safeNumber(stats?.richSectionCount, 0);
  const averageNoteCount = safeNumber(stats?.averageNoteCount, 0);

  if (richSectionCount < 3 || averageNoteCount < 6) {
    return candidate;
  }

  let sparsePenalty = 0;
  if (!chunkedImported) {
    if (noteCount <= 1) sparsePenalty += 20;
    else if (noteCount <= 2) sparsePenalty += 14;
    else if (noteCount <= 4) sparsePenalty += 7;

    if (measureRange.length === 0 && noteCount <= 3) sparsePenalty += 4;
    if (scoreNoteCount <= 3 && alignedNoteCount <= 1) sparsePenalty += 6;
    if (scoreExpectedDurationSeconds > 0 && scoreExpectedDurationSeconds <= 3.5 && noteCount <= 3) sparsePenalty += 4;
  }

  if (sparsePenalty <= 0) {
    return candidate;
  }

  return {
    ...candidate,
    sparseSectionPenalty: sparsePenalty,
    priorAdjustedScore: Number((safeNumber(candidate.priorAdjustedScore, safeNumber(candidate.score, 0)) - sparsePenalty).toFixed(2)),
  };
}

function pickDeepAnalysisSections(rankedCandidates = [], fallbackSections = []) {
  const candidates = getArray(rankedCandidates).filter((item) => item?.sourceSection);
  if (!candidates.length) return getArray(fallbackSections).slice(0, 3);
  if (candidates.length === 1) return [candidates[0].sourceSection];

  const top = candidates[0];
  const second = candidates[1];
  const scoreGap = safeNumber(top.priorAdjustedScore, 0) - safeNumber(second.priorAdjustedScore, 0);
  const topConfidence = safeNumber(top.confidence, 0);
  const topScore = safeNumber(top.score, 0);

  if (scoreGap >= 8 && topConfidence >= 0.78 && topScore >= 86) {
    return [top.sourceSection];
  }
  if (scoreGap >= 4 && topConfidence >= 0.72 && topScore >= 80) {
    return [top.sourceSection, second.sourceSection].filter(Boolean);
  }
  return candidates.slice(0, Math.min(3, candidates.length)).map((item) => item.sourceSection).filter(Boolean);
}

function shouldAcceptRawImportedDetection(rankedCandidates = []) {
  const candidates = getArray(rankedCandidates);
  if (!candidates.length) return false;
  const top = candidates[0];
  const topScore = safeNumber(top?.priorAdjustedScore, safeNumber(top?.score, 0));
  const topConfidence = safeNumber(top?.confidence, 0);
  const topPitch = safeNumber(top?.overallPitchScore, 0);
  const topRhythm = safeNumber(top?.overallRhythmScore, 0);

  return (
    (topScore >= 86 && topConfidence >= 0.72 && topPitch >= 90 && topRhythm >= 82) ||
    (topScore >= 82 && topConfidence >= 0.66 && topPitch >= 94 && topRhythm >= 88)
  );
}

function isDenseImportedScoreSections(sections = []) {
  const orderedSections = getArray(sections);
  if (!orderedSections.length) return false;
  const noteCounts = orderedSections.map((section) => getArray(section?.notes).length).filter((value) => value > 0);
  const averageNoteCount = noteCounts.length
    ? noteCounts.reduce((sum, value) => sum + value, 0) / noteCounts.length
    : 0;
  return orderedSections.length <= 12 && averageNoteCount >= 96;
}

function narrowImportedSectionsFromRawCandidates(rawCandidates = [], sections = []) {
  const candidates = getArray(rawCandidates).filter((candidate) => candidate?.sourceSection);
  const orderedSections = getArray(sections);
  if (!candidates.length || !orderedSections.length) return orderedSections;
  const isDenseImportedScore = isDenseImportedScoreSections(orderedSections);

  const selectedGroupIds = pickProbeGroupIds(candidates);
  const shortlisted = [];
  const seenSectionIds = new Set();
  const pushSection = (section) => {
    const sectionId = safeString(section?.sectionId);
    if (!sectionId || seenSectionIds.has(sectionId)) return;
    seenSectionIds.add(sectionId);
    shortlisted.push(section);
  };

  if (isDenseImportedScore) {
    candidates.slice(0, Math.min(4, candidates.length)).forEach((candidate) => pushSection(candidate.sourceSection));
    expandSectionsAroundCandidates(candidates.slice(0, 1), orderedSections, 1).forEach(pushSection);
  } else {
    if (selectedGroupIds.size) {
      orderedSections
        .filter((section) => selectedGroupIds.has(getSectionGroupId(section)))
        .forEach(pushSection);
    }

    const expandedRadius = orderedSections.length >= 18 ? 2 : orderedSections.length >= 10 ? 1 : 2;
    expandSectionsAroundCandidates(candidates.slice(0, Math.min(3, candidates.length)), orderedSections, expandedRadius).forEach(
      pushSection,
    );
  }

  if (!shortlisted.length) {
    return orderedSections;
  }
  if (shortlisted.length >= orderedSections.length) {
    return orderedSections;
  }
  return shortlisted.sort(
    (left, right) => safeNumber(left.sequenceIndex, Number.MAX_SAFE_INTEGER) - safeNumber(right.sequenceIndex, Number.MAX_SAFE_INTEGER),
  );
}

function buildDenseImportedDeepShortlist(rawCandidates = [], sections = []) {
  const candidates = getArray(rawCandidates).filter((candidate) => candidate?.sourceSection);
  const orderedSections = getArray(sections);
  if (!candidates.length || !orderedSections.length) return [];
  const top = candidates[0];
  const second = candidates[1] || null;
  const topScore = safeNumber(top?.priorAdjustedScore, safeNumber(top?.score, 0));
  const topConfidence = safeNumber(top?.confidence, 0);
  const scoreGap = second
    ? topScore - safeNumber(second?.priorAdjustedScore, safeNumber(second?.score, 0))
    : 999;
  const topSectionId = safeString(top?.sourceSection?.sectionId);
  const topIndex = orderedSections.findIndex((section) => safeString(section?.sectionId) === topSectionId);

  if (topIndex >= 0) {
    const topSection = orderedSections[topIndex];
    const topNoteCount = getArray(topSection?.notes).length;
    const topAtBoundary = topIndex === 0 || topIndex === orderedSections.length - 1;
    const topWithPrevious = [orderedSections[Math.max(0, topIndex - 1)], orderedSections[topIndex]].filter(Boolean);
    const topNeighborhood = [
      orderedSections[Math.max(0, topIndex - 1)],
      orderedSections[topIndex],
      orderedSections[Math.min(orderedSections.length - 1, topIndex + 1)],
    ].filter(Boolean).filter((section, index, self) => self.findIndex((item) => safeString(item?.sectionId) === safeString(section?.sectionId)) === index);

    if (top?.sourceSection && topScore >= 78 && topConfidence >= 0.56 && (topAtBoundary || topNoteCount >= 280 || scoreGap >= 1.5)) {
      return [topSection].filter(Boolean);
    }
    if (top?.sourceSection && topAtBoundary && topScore >= 74 && topConfidence >= 0.5) {
      return [topSection].filter(Boolean);
    }
    if (top?.sourceSection && topConfidence >= 0.62 && topScore >= 72 && scoreGap >= 2) {
      return topWithPrevious;
    }
    if (top?.sourceSection && topConfidence >= 0.54 && topScore >= 68 && scoreGap >= 1) {
      return topNeighborhood.slice(0, 2);
    }
    return topNeighborhood;
  }

  const shortlist = [];
  const seenSectionIds = new Set();
  const pushSection = (section) => {
    const sectionId = safeString(section?.sectionId);
    if (!sectionId || seenSectionIds.has(sectionId)) return;
    seenSectionIds.add(sectionId);
    shortlist.push(section);
  };

  candidates.slice(0, Math.min(3, candidates.length)).forEach((candidate) => pushSection(candidate.sourceSection));
  expandSectionsAroundCandidates(candidates.slice(0, 1), orderedSections, 1).forEach(pushSection);

  return shortlist
    .sort(
      (left, right) =>
        safeNumber(left.sequenceIndex, Number.MAX_SAFE_INTEGER) - safeNumber(right.sequenceIndex, Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 4);
}

function refineDeepAnalysisSectionsForImportedScore(rankedCandidates = [], selectedSections = [], piece = {}) {
  const candidates = getArray(rankedCandidates).filter((item) => item?.sourceSection);
  if (!candidates.length) return getArray(selectedSections);

  const sectionCount = getArray(piece?.sections).length;
  const isImportedScore = safeString(piece?.sourcePdfPath).length > 0 || safeString(piece?.scoreId).startsWith("score-");
  if (!isImportedScore || sectionCount < 8) {
    return getArray(selectedSections);
  }

  const dedupedCandidates = [];
  const seenGroupIds = new Set();
  for (const candidate of candidates) {
    const groupId = getSectionGroupId(candidate?.sourceSection || candidate);
    if (seenGroupIds.has(groupId)) continue;
    seenGroupIds.add(groupId);
    dedupedCandidates.push(candidate);
  }

  const top = dedupedCandidates[0];
  const second = dedupedCandidates[1] || null;
  const topScore = safeNumber(top?.priorAdjustedScore, safeNumber(top?.score, 0));
  const topConfidence = safeNumber(top?.confidence, 0);
  const scoreGap = second
    ? topScore - safeNumber(second?.priorAdjustedScore, safeNumber(second?.score, 0))
    : 999;

  if (sectionCount >= 20 && topConfidence >= 0.82 && topScore >= 72 && scoreGap >= 6) {
    return [top.sourceSection].filter(Boolean);
  }
  if (sectionCount >= 20 && topConfidence >= 0.74 && topScore >= 68 && scoreGap >= 4) {
    return [top.sourceSection].filter(Boolean);
  }
  if (sectionCount >= 20 && topConfidence >= 0.66 && topScore >= 64 && scoreGap >= 2) {
    return [top.sourceSection, second?.sourceSection].filter(Boolean);
  }

  if (topConfidence >= 0.52 && topScore >= 68 && scoreGap >= 2.0) {
    return [top.sourceSection].filter(Boolean);
  }
  if (topConfidence >= 0.64 && topScore >= 78) {
    return [top.sourceSection].filter(Boolean);
  }
  if (sectionCount <= 24 && topConfidence >= 0.48 && topScore >= 66 && scoreGap >= 1.0) {
    return [top.sourceSection].filter(Boolean);
  }
  if (dedupedCandidates.length > 0 && sectionCount <= 18) {
    return [top.sourceSection].filter(Boolean);
  }

  const dedupedSections = dedupedCandidates
    .slice(0, Math.max(1, Math.min(2, dedupedCandidates.length)))
    .map((candidate) => candidate.sourceSection)
    .filter(Boolean);
  return dedupedSections.length ? dedupedSections : getArray(selectedSections);
}

async function autoDetectPieceSection(payload, piece, options = {}) {
  const detectStartedAt = Date.now();
  const requestedSectionIds = new Set(getArray(options.candidateSectionIds).map((item) => safeString(item)).filter(Boolean));
  const maxSections = Math.max(0, Math.round(safeNumber(options.maxSections, 0)));
  let sections = getArray(piece?.sections)
    .filter((section) => getArray(section.notes).length > 0)
    .slice()
    .sort((left, right) => safeNumber(left.sequenceIndex, Number.MAX_SAFE_INTEGER) - safeNumber(right.sequenceIndex, Number.MAX_SAFE_INTEGER));

  if (requestedSectionIds.size) {
    sections = sections.filter((section) => requestedSectionIds.has(safeString(section.sectionId)));
  }
  if (maxSections > 0) {
    sections = sections.slice(0, maxSections);
  }

  const priorOptions = {
    windowStartSeconds: options.windowStartSeconds,
    expectedSequenceIndex: options.expectedSequenceIndex,
  };
  const isImportedScore =
    safeString(piece?.sourcePdfPath).length > 0 || safeString(piece?.scoreId).startsWith("score-");
  const importedSectionStats = isImportedScore ? getImportedSectionStats(sections) : null;
  const denseImportedScore = isImportedScore && isDenseImportedScoreSections(sections);
  appendPerfTrace(
    `[autodetect] start pieceId=${safeString(piece?.pieceId)} scoreId=${safeString(payload.scoreId)} sections=${sections.length} dense=${denseImportedScore}`,
  );
  const cachedDetection = await readSectionDetectionCache(payload, piece, sections, options);
  if (cachedDetection?.bestSection) {
    appendPerfTrace(
      `[autodetect] cache-hit bestSection=${safeString(cachedDetection.bestSection?.sectionId)} candidates=${getArray(cachedDetection.candidates).length} elapsedMs=${Date.now() - detectStartedAt}`,
    );
    return cachedDetection;
  }

  async function rankSections(targetSections, payloadOverride = payload) {
    const ranked = await callExternalSectionRankLongTimeout(payloadOverride, targetSections, piece);
    return getArray(ranked).map((candidate) => {
      const sourceSection =
        targetSections.find((section) => safeString(section.sectionId) === safeString(candidate.sectionId)) || null;
      const adjustedCandidate = applySectionPrior(
        {
          sourceSection,
          pieceId: safeString(candidate.pieceId, safeString(sourceSection?.pieceId, safeString(piece?.pieceId))),
          sectionId: safeString(candidate.sectionId),
          sourceSectionId: safeString(candidate.sourceSectionId, safeString(sourceSection?.sourceSectionId)),
          sectionTitle: safeString(candidate.sectionTitle, safeString(sourceSection?.title)),
          sequenceIndex: safeNumber(candidate.sequenceIndex, safeNumber(sourceSection?.sequenceIndex, 0)),
          researchWindowHints: getArray(sourceSection?.researchWindowHints)
            .map((value) => safeNumber(value))
            .filter((value) => Number.isFinite(value)),
          score: safeNumber(candidate.score, 0),
          overallPitchScore: clamp(safeNumber(candidate.overallPitchScore, 0), 0, 100),
          overallRhythmScore: clamp(safeNumber(candidate.overallRhythmScore, 0), 0, 100),
          confidence: clamp(safeNumber(candidate.confidence, 0), 0, 1),
          recommendedPracticePath: safeString(candidate.recommendedPracticePath),
          measureFindingCount: Math.max(0, Math.round(safeNumber(candidate.measureFindingCount, 0))),
          noteFindingCount: Math.max(0, Math.round(safeNumber(candidate.noteFindingCount, 0))),
          summaryText: safeString(candidate.summaryText),
          diagnostics: candidate?.diagnostics && typeof candidate.diagnostics === "object" ? candidate.diagnostics : null,
        },
        priorOptions,
      );
      return applyImportedSparseSectionPenalty(adjustedCandidate, piece, importedSectionStats);
    });
  }

  let rankedCandidates = [];
  let rawImportedCandidates = [];
  let candidates = [];
  const canUseRawFirstPass =
    isImportedScore &&
    safeString(payload.preprocessMode, "off") !== "off" &&
    sections.length >= 6;

  if (canUseRawFirstPass) {
    try {
      rawImportedCandidates = await rankSections(sections, {
        ...payload,
        preprocessMode: "off",
        separationMode: "off",
      });
      appendPerfTrace(
        `[autodetect] raw-first count=${rawImportedCandidates.length} top=${safeString(rawImportedCandidates[0]?.sectionId)} score=${safeNumber(rawImportedCandidates[0]?.priorAdjustedScore, safeNumber(rawImportedCandidates[0]?.score, 0))} elapsedMs=${Date.now() - detectStartedAt}`,
      );
    } catch {
      rawImportedCandidates = [];
      appendPerfTrace(`[autodetect] raw-first failed elapsedMs=${Date.now() - detectStartedAt}`);
    }
  }

  if (rawImportedCandidates.length && denseImportedScore) {
    const denseShortlist = buildDenseImportedDeepShortlist(rawImportedCandidates, sections);
    appendPerfTrace(
      `[autodetect] dense-shortlist sections=${denseShortlist.map((section) => safeString(section?.sectionId)).join(",")} elapsedMs=${Date.now() - detectStartedAt}`,
    );
    for (const section of denseShortlist) {
      const scopedSection = { ...section, pieceId: safeString(piece?.pieceId), pieceTitle: safeString(piece?.title) };
      const rankingCandidate =
        rawImportedCandidates.find((candidate) => safeString(candidate?.sectionId) === safeString(scopedSection?.sectionId)) || null;
      const scopedPayload = shouldUseDetectedWindowAnalysis(rankingCandidate, scopedSection)
        ? applyCandidateDetectedWindow(payload, rankingCandidate, scopedSection)
        : payload;
      const analysis = await runSectionAnalysis(scopedPayload, scopedSection);
      const candidate = applySectionPrior(buildSectionCandidate(scopedSection, analysis), priorOptions);
      candidate.analysis = analysis;
      candidates.push(candidate);
    }
  } else if (rawImportedCandidates.length && shouldAcceptRawImportedDetection(rawImportedCandidates)) {
    rankedCandidates = rawImportedCandidates;
    appendPerfTrace(
      `[autodetect] raw-accepted top=${safeString(rankedCandidates[0]?.sectionId)} candidates=${rankedCandidates.length} elapsedMs=${Date.now() - detectStartedAt}`,
    );
  } else {
    const secondPassSections =
      rawImportedCandidates.length && isImportedScore
        ? narrowImportedSectionsFromRawCandidates(rawImportedCandidates, sections)
        : sections;
    try {
      rankedCandidates = await rankSections(secondPassSections);
      appendPerfTrace(
        `[autodetect] second-pass sections=${secondPassSections.length} ranked=${rankedCandidates.length} top=${safeString(rankedCandidates[0]?.sectionId)} elapsedMs=${Date.now() - detectStartedAt}`,
      );
    } catch {
      rankedCandidates = [];
      appendPerfTrace(`[autodetect] second-pass failed elapsedMs=${Date.now() - detectStartedAt}`);
    }
  }

  if (candidates.length) {
    candidates.sort((left, right) => {
      if (right.priorAdjustedScore !== left.priorAdjustedScore) return right.priorAdjustedScore - left.priorAdjustedScore;
      if (right.score !== left.score) return right.score - left.score;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return left.sequenceIndex - right.sequenceIndex;
    });
  } else if (!candidates.length) {
    const candidateSectionsForDeepAnalysis =
      rankedCandidates.length > 0
        ? pickDeepAnalysisSections(rankedCandidates, sections)
        : sections;
    const refinedSectionsForDeepAnalysis = refineDeepAnalysisSectionsForImportedScore(
      rankedCandidates,
      candidateSectionsForDeepAnalysis,
      piece,
    );
    appendPerfTrace(
      `[autodetect] deep-sections sections=${refinedSectionsForDeepAnalysis.map((section) => safeString(section?.sectionId)).join(",")} elapsedMs=${Date.now() - detectStartedAt}`,
    );

    for (const section of refinedSectionsForDeepAnalysis) {
      const scopedSection = { ...section, pieceId: safeString(piece?.pieceId), pieceTitle: safeString(piece?.title) };
      const rankingCandidate =
        rankedCandidates.find((candidate) => safeString(candidate?.sectionId) === safeString(scopedSection?.sectionId)) || null;
      const scopedPayload = shouldUseDetectedWindowAnalysis(rankingCandidate, scopedSection)
        ? applyCandidateDetectedWindow(payload, rankingCandidate, scopedSection)
        : payload;
      const analysis = await runSectionAnalysis(scopedPayload, scopedSection);
      const candidate = applySectionPrior(buildSectionCandidate(scopedSection, analysis), priorOptions);
      candidate.analysis = analysis;
      candidates.push(candidate);
    }

    candidates.sort((left, right) => {
      if (right.priorAdjustedScore !== left.priorAdjustedScore) return right.priorAdjustedScore - left.priorAdjustedScore;
      if (right.score !== left.score) return right.score - left.score;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return left.sequenceIndex - right.sequenceIndex;
    });
  }

  const bestCandidate = candidates[0] || null;
  const detection = {
    bestSection: bestCandidate
      ? (bestCandidate.sourceSection
          ? { ...bestCandidate.sourceSection, pieceId: bestCandidate.pieceId || safeString(bestCandidate.sourceSection?.pieceId) }
          : { ...getErhuSection(bestCandidate.pieceId, bestCandidate.sectionId), pieceId: bestCandidate.pieceId })
      : null,
    bestAnalysis: bestCandidate?.analysis || null,
    candidates: candidates.map((candidate) => {
      const { analysis, ...summary } = candidate;
      return summary;
    }),
  };
  await writeSectionDetectionCache(payload, piece, sections, options, detection);
  appendPerfTrace(
    `[autodetect] complete bestSection=${safeString(detection.bestSection?.sectionId)} candidates=${getArray(detection.candidates).length} elapsedMs=${Date.now() - detectStartedAt}`,
  );
  return detection;
}

function ensureParticipantRecord(store, participantId, groupId) {
  let participant = store.participants.find((item) => item.participantId === participantId);
  if (!participant) {
    participant = normalizeParticipantRecord({
      participantId,
      groupId,
      createdAt: nowIso(),
      lastActiveAt: nowIso(),
    });
    store.participants.push(participant);
  } else if (groupId) {
    participant.groupId = groupId;
  }
  participant = Object.assign(participant, normalizeParticipantRecord(participant));
  return participant;
}

function appendAnalysisToParticipant(participant, payload, analysisRecord) {
  const usageLog = {
    analysisId: analysisRecord.analysisId,
    pieceId: analysisRecord.pieceId,
    sectionId: analysisRecord.sectionId,
    sessionStage: analysisRecord.sessionStage,
    overallPitchScore: analysisRecord.overallPitchScore,
    overallRhythmScore: analysisRecord.overallRhythmScore,
    confidence: analysisRecord.confidence,
    at: analysisRecord.createdAt,
  };
  participant.usageLogs = getArray(participant.usageLogs).concat(usageLog).slice(-100);
  participant.lastActiveAt = analysisRecord.createdAt;

  const summary = {
    analysisId: analysisRecord.analysisId,
    pieceId: analysisRecord.pieceId,
    sectionId: analysisRecord.sectionId,
    pitchScore: analysisRecord.overallPitchScore,
    rhythmScore: analysisRecord.overallRhythmScore,
    at: analysisRecord.createdAt,
  };

  if (payload.sessionStage === "pretest") {
    participant.pretest = summary;
    return;
  }
  if (payload.sessionStage === "posttest") {
    participant.posttest = summary;
    return;
  }
  participant.weeklySessions = getArray(participant.weeklySessions).concat({
    stage: payload.sessionStage,
    ...summary,
  }).slice(-24);
}

function applyExperienceScale(participant, payload) {
  const questionnaire = {
    questionnaireId: createId("questionnaire"),
    usefulness: safeNumber(payload.experienceScales?.usefulness, 0),
    easeOfUse: safeNumber(payload.experienceScales?.easeOfUse, 0),
    feedbackClarity: safeNumber(payload.experienceScales?.feedbackClarity, 0),
    confidence: safeNumber(payload.experienceScales?.confidence, 0),
    continuance: safeNumber(payload.experienceScales?.continuance, 0),
    notes: safeString(payload.notes),
    submittedAt: nowIso(),
    sessionStage: safeString(payload.sessionStage),
  };
  const questionnaireIndex = getArray(participant.questionnaires).findIndex(
    (item) => item.sessionStage === questionnaire.sessionStage,
  );
  if (questionnaireIndex >= 0) {
    const current = getArray(participant.questionnaires)[questionnaireIndex];
    participant.questionnaires[questionnaireIndex] = {
      ...current,
      ...questionnaire,
      questionnaireId: current.questionnaireId || questionnaire.questionnaireId,
    };
    participant.experienceScales = participant.questionnaires[questionnaireIndex];
  } else {
    participant.questionnaires = getArray(participant.questionnaires).concat(questionnaire).slice(-24);
    participant.experienceScales = questionnaire;
  }
  participant.lastActiveAt = participant.experienceScales.submittedAt;
}

function applyExpertRating(participant, payload) {
  const rating = {
    ratingId: createId("rating"),
    stage: safeString(payload.stage, "pretest"),
    pitchScore: clamp(safeNumber(payload.pitchScore, 0), 0, 100),
    rhythmScore: clamp(safeNumber(payload.rhythmScore, 0), 0, 100),
    raterId: safeString(payload.raterId, "expert"),
    comments: safeString(payload.comments),
    submittedAt: nowIso(),
  };

  if (rating.stage === "pretest") {
    participant.expertRatings.pretest = rating;
  } else if (rating.stage === "posttest") {
    participant.expertRatings.posttest = rating;
  } else {
    const weekly = getArray(participant.expertRatings.weekly);
    const existingIndex = weekly.findIndex((item) => item.stage === rating.stage && item.raterId === rating.raterId);
    if (existingIndex >= 0) {
      weekly[existingIndex] = {
        ...weekly[existingIndex],
        ...rating,
        ratingId: weekly[existingIndex].ratingId || rating.ratingId,
      };
      participant.expertRatings.weekly = weekly;
    } else {
      participant.expertRatings.weekly = weekly.concat(rating).slice(-24);
    }
  }
  participant.lastActiveAt = rating.submittedAt;
}

function applyParticipantProfile(participant, payload) {
  participant.profile = {
    alias: safeString(payload.profile?.alias),
    institution: safeString(payload.profile?.institution),
    major: safeString(payload.profile?.major),
    grade: safeString(payload.profile?.grade),
    yearsOfTraining: clamp(safeNumber(payload.profile?.yearsOfTraining, 0), 0, 80),
    weeklyPracticeMinutes: clamp(safeNumber(payload.profile?.weeklyPracticeMinutes, 0), 0, 10080),
    deviceLabel: safeString(payload.profile?.deviceLabel),
    consentSigned: safeBoolean(payload.profile?.consentSigned, false),
    notes: safeString(payload.profile?.notes),
    updatedAt: nowIso(),
  };
  participant.lastActiveAt = participant.profile.updatedAt;
}

function applyTaskPlan(participant, payload) {
  const nextTask = normalizeTaskPlanRecord({
    taskId: safeString(payload.taskId) || createId("task"),
    stage: safeString(payload.stage, "week1"),
    pieceId: safeString(payload.pieceId),
    sectionId: safeString(payload.sectionId),
    focus: safeString(payload.focus),
    instructions: safeString(payload.instructions),
    practiceTargetMinutes: safeNumber(payload.practiceTargetMinutes, 30),
    dueDate: safeString(payload.dueDate),
    status: safeString(payload.status, "assigned"),
    assignedBy: safeString(payload.assignedBy, "researcher"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const existingTasks = getArray(participant.taskPlans);
  const taskIndex = existingTasks.findIndex(
    (item) => item.taskId === nextTask.taskId || (!payload.taskId && item.stage === nextTask.stage),
  );

  if (taskIndex >= 0) {
    const current = normalizeTaskPlanRecord(existingTasks[taskIndex]);
    existingTasks[taskIndex] = normalizeTaskPlanRecord({
      ...current,
      ...nextTask,
      taskId: current.taskId || nextTask.taskId,
      createdAt: current.createdAt || nextTask.createdAt,
      completedAt: nextTask.status === "completed" ? nowIso() : current.completedAt,
    });
    participant.taskPlans = existingTasks;
  } else {
    participant.taskPlans = existingTasks.concat(nextTask).slice(-48);
  }

  participant.lastActiveAt = nowIso();
}

function applyInterviewNote(participant, payload) {
  const nextInterview = normalizeInterviewRecord({
    interviewId: safeString(payload.interviewId) || createId("interview"),
    stage: safeString(payload.stage, "posttest"),
    interviewerId: safeString(payload.interviewerId, "researcher"),
    summary: safeString(payload.summary),
    barriers: safeString(payload.barriers),
    strategyChanges: safeString(payload.strategyChanges),
    representativeQuote: safeString(payload.representativeQuote),
    nextAction: safeString(payload.nextAction),
    followUpNeeded: safeBoolean(payload.followUpNeeded, false),
    submittedAt: nowIso(),
  });

  const interviews = getArray(participant.interviews);
  const interviewIndex = interviews.findIndex(
    (item) =>
      item.interviewId === nextInterview.interviewId ||
      (!payload.interviewId && item.stage === nextInterview.stage && item.interviewerId === nextInterview.interviewerId),
  );

  if (interviewIndex >= 0) {
    interviews[interviewIndex] = normalizeInterviewRecord({
      ...interviews[interviewIndex],
      ...nextInterview,
      interviewId: interviews[interviewIndex].interviewId || nextInterview.interviewId,
    });
    participant.interviews = interviews;
  } else {
    participant.interviews = interviews.concat(nextInterview).slice(-24);
  }

  participant.lastActiveAt = nextInterview.submittedAt;
}

function applyInterviewSampling(participant, payload) {
  participant.interviewSampling = normalizeInterviewSamplingRecord({
    selected: payload.selected,
    priority: payload.priority,
    reason: payload.reason,
    markedBy: payload.markedBy,
    updatedAt: nowIso(),
  });
  participant.lastActiveAt = participant.interviewSampling.updatedAt;
}

function buildParticipantView(participant, store) {
  const analyses = store.analyses
    .filter((item) => item.participantId === participant.participantId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const validationReviews = getArray(store.validationReviews)
    .filter((item) => item.participantId === participant.participantId)
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));
  const adjudications = getArray(store.adjudications)
    .filter((item) => item.participantId === participant.participantId)
    .sort((left, right) => String(right.resolvedAt).localeCompare(String(left.resolvedAt)));

  const pitchGain =
    participant.pretest && participant.posttest
      ? safeNumber(participant.posttest.pitchScore) - safeNumber(participant.pretest.pitchScore)
      : null;
  const rhythmGain =
    participant.pretest && participant.posttest
      ? safeNumber(participant.posttest.rhythmScore) - safeNumber(participant.pretest.rhythmScore)
      : null;

  return {
    ...participant,
    analyses,
    validationReviews,
    adjudications,
    pitchGain,
    rhythmGain,
  };
}

function buildParticipantSummary(participant, store) {
  const view = buildParticipantView(participant, store);
  const latestQuestionnaire = getArray(view.questionnaires)
    .slice()
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)))[0] || null;
  const latestInterview = getArray(view.interviews)
    .slice()
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)))[0] || null;
  const latestValidation = getArray(view.validationReviews)[0] || null;
  const latestAdjudication = getArray(view.adjudications)[0] || null;
  const participantAnalysisIds = new Set(getArray(view.analyses).map((item) => item.analysisId).filter(Boolean));
  const pendingAdjudicationCount = buildPendingAdjudications(store).filter((item) => participantAnalysisIds.has(item.analysisId)).length;
  const adjudicationStatuses = getArray(view.analyses).map((item) => getAdjudicationStatusForAnalysis(store, item.analysisId));
  const adjudicationStatus = adjudicationStatuses.includes("pending")
    ? "pending"
    : adjudicationStatuses.includes("resolved")
      ? "resolved"
      : adjudicationStatuses.includes("not-ready")
        ? "not-ready"
        : "not-needed";
  return {
    participantId: view.participantId,
    groupId: view.groupId,
    createdAt: view.createdAt,
    lastActiveAt: view.lastActiveAt || view.createdAt,
    analysisCount: view.analyses.length,
    weeklySessionCount: getArray(view.weeklySessions).length,
    profileCompleted: Boolean(view.profile?.updatedAt),
    consentSigned: Boolean(view.profile?.consentSigned),
    institution: view.profile?.institution || "",
    grade: view.profile?.grade || "",
    pretestPitch: view.pretest?.pitchScore ?? null,
    posttestPitch: view.posttest?.pitchScore ?? null,
    pretestRhythm: view.pretest?.rhythmScore ?? null,
    posttestRhythm: view.posttest?.rhythmScore ?? null,
    pitchGain: view.pitchGain,
    rhythmGain: view.rhythmGain,
    usefulness: view.experienceScales?.usefulness ?? null,
    easeOfUse: view.experienceScales?.easeOfUse ?? null,
    feedbackClarity: view.experienceScales?.feedbackClarity ?? null,
    confidence: view.experienceScales?.confidence ?? null,
    continuance: view.experienceScales?.continuance ?? null,
    questionnaireCount: getArray(view.questionnaires).length,
    latestQuestionnaireStage: latestQuestionnaire?.sessionStage ?? null,
    taskPlanCount: getArray(view.taskPlans).length,
    completedTaskCount: getArray(view.taskPlans).filter((item) => item.status === "completed").length,
    interviewCount: getArray(view.interviews).length,
    latestInterviewStage: latestInterview?.stage ?? null,
    interviewSamplingSelected: Boolean(view.interviewSampling?.selected),
    interviewSamplingPriority: view.interviewSampling?.priority || "",
    interviewSamplingReason: view.interviewSampling?.reason || "",
    expertPretestPitch: view.expertRatings?.pretest?.pitchScore ?? null,
    expertPosttestPitch: view.expertRatings?.posttest?.pitchScore ?? null,
    expertPretestRhythm: view.expertRatings?.pretest?.rhythmScore ?? null,
    expertPosttestRhythm: view.expertRatings?.posttest?.rhythmScore ?? null,
    validationReviewCount: getArray(view.validationReviews).length,
    latestValidationAt: latestValidation?.submittedAt ?? null,
    averageValidationAgreement:
      getArray(view.validationReviews).length
        ? Number(average(getArray(view.validationReviews).map((item) => item.overallAgreement)).toFixed(2))
        : null,
    latestValidationPathAgreement: latestValidation?.pathAgreement ?? null,
    adjudicationCount: getArray(view.adjudications).length,
    latestAdjudicationAt: latestAdjudication?.resolvedAt ?? null,
    latestAdjudicationPathAgreement: latestAdjudication?.pathAgreement ?? null,
    pendingAdjudicationCount,
    adjudicationStatus,
  };
}

function buildParticipantExportRows(store) {
  return store.participants.map((participant) => buildParticipantSummary(participant, store));
}

function buildQuestionnaireExportRows(store) {
  return store.participants.flatMap((participant) =>
    getArray(participant.questionnaires).map((questionnaire) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      sessionStage: questionnaire.sessionStage,
      usefulness: questionnaire.usefulness,
      easeOfUse: questionnaire.easeOfUse,
      feedbackClarity: questionnaire.feedbackClarity,
      confidence: questionnaire.confidence,
      continuance: questionnaire.continuance,
      notes: questionnaire.notes,
      submittedAt: questionnaire.submittedAt,
    })),
  );
}

function buildExpertRatingExportRows(store) {
  return store.participants.flatMap((participant) => {
    const prePost = [participant.expertRatings?.pretest, participant.expertRatings?.posttest].filter(Boolean);
    const weekly = getArray(participant.expertRatings?.weekly);
    return prePost.concat(weekly).map((rating) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      stage: rating.stage,
      pitchScore: rating.pitchScore,
      rhythmScore: rating.rhythmScore,
      raterId: rating.raterId,
      comments: rating.comments,
      submittedAt: rating.submittedAt,
    }));
  });
}

function buildAnalysisExportRows(store) {
  return store.analyses.map((analysis) => ({
    analysisId: analysis.analysisId,
    participantId: analysis.participantId,
    groupId: analysis.groupId,
    sessionStage: analysis.sessionStage,
    pieceId: analysis.pieceId,
    sectionId: analysis.sectionId,
    overallPitchScore: analysis.overallPitchScore,
    overallRhythmScore: analysis.overallRhythmScore,
    confidence: analysis.confidence,
    recommendedPracticePath: analysis.recommendedPracticePath || "",
    analysisMode: analysis.analysisMode,
    createdAt: analysis.createdAt,
  }));
}

function buildValidationReviewRows(store) {
  return getArray(store.validationReviews).map((review) => ({
    reviewId: review.reviewId,
    analysisId: review.analysisId,
    participantId: review.participantId,
    groupId: review.groupId,
    sessionStage: review.sessionStage,
    pieceId: review.pieceId,
    sectionId: review.sectionId,
    raterId: review.raterId,
    overallAgreement: review.overallAgreement,
    teacherPrimaryPath: review.teacherPrimaryPath,
    systemRecommendedPath: review.systemRecommendedPath,
    pathAgreement: review.pathAgreement,
    noteMatchedCount: review.noteMatchedCount,
    notePrecision: review.notePrecision,
    noteRecall: review.noteRecall,
    noteF1: review.noteF1,
    measureMatchedCount: review.measureMatchedCount,
    measurePrecision: review.measurePrecision,
    measureRecall: review.measureRecall,
    measureF1: review.measureF1,
    teacherIssueNoteIds: getArray(review.teacherIssueNoteIds).join("|"),
    teacherIssueMeasureIndexes: getArray(review.teacherIssueMeasureIndexes).join("|"),
    missedTeacherNoteIds: getArray(review.missedTeacherNoteIds).join("|"),
    extraSystemNoteIds: getArray(review.extraSystemNoteIds).join("|"),
    missedTeacherMeasureIndexes: getArray(review.missedTeacherMeasureIndexes).join("|"),
    extraSystemMeasureIndexes: getArray(review.extraSystemMeasureIndexes).join("|"),
    comments: review.comments,
    submittedAt: review.submittedAt,
  }));
}

function buildAdjudicationRows(store) {
  return getArray(store.adjudications).map((adjudication) => ({
    adjudicationId: adjudication.adjudicationId,
    analysisId: adjudication.analysisId,
    participantId: adjudication.participantId,
    groupId: adjudication.groupId,
    sessionStage: adjudication.sessionStage,
    pieceId: adjudication.pieceId,
    sectionId: adjudication.sectionId,
    adjudicatorId: adjudication.adjudicatorId,
    sourceRaterIds: getArray(adjudication.sourceRaterIds).join("|"),
    triggerReasons: getArray(adjudication.triggerReasons).join("|"),
    finalPrimaryPath: adjudication.finalPrimaryPath,
    systemRecommendedPath: adjudication.systemRecommendedPath,
    pathAgreement: adjudication.pathAgreement,
    noteMatchedCount: adjudication.noteMatchedCount,
    notePrecision: adjudication.notePrecision,
    noteRecall: adjudication.noteRecall,
    noteF1: adjudication.noteF1,
    measureMatchedCount: adjudication.measureMatchedCount,
    measurePrecision: adjudication.measurePrecision,
    measureRecall: adjudication.measureRecall,
    measureF1: adjudication.measureF1,
    finalIssueNoteIds: getArray(adjudication.finalIssueNoteIds).join("|"),
    finalIssueMeasureIndexes: getArray(adjudication.finalIssueMeasureIndexes).join("|"),
    comments: adjudication.comments,
    resolvedAt: adjudication.resolvedAt,
  }));
}

function buildTaskExportRows(store) {
  return store.participants.flatMap((participant) =>
    getArray(participant.taskPlans).map((task) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      taskId: task.taskId,
      stage: task.stage,
      pieceId: task.pieceId,
      sectionId: task.sectionId,
      focus: task.focus,
      instructions: task.instructions,
      practiceTargetMinutes: task.practiceTargetMinutes,
      dueDate: task.dueDate,
      status: task.status,
      assignedBy: task.assignedBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
    })),
  );
}

function buildInterviewExportRows(store) {
  return store.participants.flatMap((participant) =>
    getArray(participant.interviews).map((interview) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      interviewId: interview.interviewId,
      stage: interview.stage,
      interviewerId: interview.interviewerId,
      summary: interview.summary,
      barriers: interview.barriers,
      strategyChanges: interview.strategyChanges,
      representativeQuote: interview.representativeQuote,
      nextAction: interview.nextAction,
      followUpNeeded: interview.followUpNeeded,
      submittedAt: interview.submittedAt,
    })),
  );
}

function buildSamplingExportRows(store) {
  return store.participants.map((participant) => ({
    participantId: participant.participantId,
    groupId: participant.groupId,
    selected: Boolean(participant.interviewSampling?.selected),
    priority: participant.interviewSampling?.priority || "",
    reason: participant.interviewSampling?.reason || "",
    markedBy: participant.interviewSampling?.markedBy || "",
    updatedAt: participant.interviewSampling?.updatedAt || "",
    interviewCount: getArray(participant.interviews).length,
  }));
}

function isTaskOverdue(task) {
  if (!task?.dueDate || task.status === "completed") return false;
  const due = new Date(task.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

function buildTaskQualityBoard(store) {
  const rows = [];
  const stageKeys = new Set();
  store.participants.forEach((participant) => {
    getArray(participant.taskPlans).forEach((task) => {
      stageKeys.add(task.stage || "week1");
    });
  });
  const groups = ["experimental", "control"];
  const stages = Array.from(stageKeys).sort((left, right) => String(left).localeCompare(String(right)));

  stages.forEach((stage) => {
    groups.forEach((groupId) => {
      const stageTasks = buildTaskExportRows(store).filter((item) => item.stage === stage && item.groupId === groupId);
      const assigned = stageTasks.length;
      const completed = stageTasks.filter((item) => item.status === "completed").length;
      const inProgress = stageTasks.filter((item) => item.status === "in-progress").length;
      const overdue = stageTasks.filter((item) => isTaskOverdue(item)).length;
      rows.push({
        stage,
        groupId,
        assignedCount: assigned,
        completedCount: completed,
        inProgressCount: inProgress,
        overdueCount: overdue,
        completionRate: assigned ? Number(((completed / assigned) * 100).toFixed(2)) : 0,
      });
    });
  });

  return rows;
}

function buildDataQualityOverview(store) {
  const pendingAdjudications = buildPendingAdjudications(store);
  const pendingAnalysisIds = new Set(pendingAdjudications.map((item) => item.analysisId));
  const reminders = store.participants
    .map((participant) => {
      const missingItems = [];
      const posttestQuestionnaire = getArray(participant.questionnaires).some((item) => item.sessionStage === "posttest");
      const overdueTaskCount = getArray(participant.taskPlans).filter((task) => isTaskOverdue(task)).length;
      const participantAnalysisIds = new Set(
        getArray(store.analyses)
          .filter((analysis) => analysis.participantId === participant.participantId)
          .map((analysis) => analysis.analysisId)
          .filter(Boolean),
      );
      const pendingAdjudicationCount = Array.from(participantAnalysisIds).filter((analysisId) => pendingAnalysisIds.has(analysisId)).length;

      if (!participant.profile?.updatedAt) missingItems.push("profile");
      if (!participant.pretest) missingItems.push("pretest-analysis");
      if (!participant.posttest) missingItems.push("posttest-analysis");
      if (participant.pretest && !participant.expertRatings?.pretest) missingItems.push("pretest-expert-rating");
      if (participant.posttest && !participant.expertRatings?.posttest) missingItems.push("posttest-expert-rating");
      if (participant.posttest && !posttestQuestionnaire) missingItems.push("posttest-questionnaire");
      if (overdueTaskCount > 0) missingItems.push("overdue-task");
      if (participant.interviewSampling?.selected && getArray(participant.interviews).length === 0) missingItems.push("pending-interview");
      if (pendingAdjudicationCount > 0) missingItems.push("pending-adjudication");

      return {
        participantId: participant.participantId,
        groupId: participant.groupId,
        missingItems,
        overdueTaskCount,
        pendingAdjudicationCount,
        interviewSamplingSelected: Boolean(participant.interviewSampling?.selected),
        interviewSamplingPriority: participant.interviewSampling?.priority || "",
        interviewSamplingReason: participant.interviewSampling?.reason || "",
        needsAttention: missingItems.length > 0,
        lastActiveAt: participant.lastActiveAt || participant.createdAt,
      };
    })
    .filter((item) => item.needsAttention)
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));

  const allParticipants = store.participants;
  const samplingRows = buildSamplingExportRows(store);

  return {
    reminderCount: reminders.length,
    missingProfileCount: allParticipants.filter((item) => !item.profile?.updatedAt).length,
    missingPretestCount: allParticipants.filter((item) => !item.pretest).length,
    missingPosttestCount: allParticipants.filter((item) => !item.posttest).length,
    overdueTaskParticipantCount: reminders.filter((item) => item.missingItems.includes("overdue-task")).length,
    pendingInterviewCount: reminders.filter((item) => item.missingItems.includes("pending-interview")).length,
    pendingAdjudicationCount: pendingAdjudications.length,
    samplingCount: samplingRows.filter((item) => item.selected).length,
    samplingCompletedCount: samplingRows.filter((item) => item.selected && item.interviewCount > 0).length,
    reminders,
    taskBoard: buildTaskQualityBoard(store),
    pendingAdjudications,
    samplingRows: samplingRows
      .filter((item) => item.selected)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
  };
}

function buildPendingRatings(store) {
  return store.participants
    .map((participant) => {
      const pendingStages = [];
      if (participant.pretest && !participant.expertRatings?.pretest) {
        pendingStages.push("pretest");
      }
      if (participant.posttest && !participant.expertRatings?.posttest) {
        pendingStages.push("posttest");
      }
      return {
        participantId: participant.participantId,
        groupId: participant.groupId,
        pendingStages,
        lastActiveAt: participant.lastActiveAt || participant.createdAt,
      };
    })
    .filter((item) => item.pendingStages.length)
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));
}

function buildPendingValidationReviews(store) {
  const requiredRaterCount = REQUIRED_VALIDATION_RATERS;
  return store.analyses
    .map((analysis) => {
      const analysisReviews = getArray(store.validationReviews).filter((review) => review.analysisId === analysis.analysisId);
      const uniqueRaters = Array.from(new Set(analysisReviews.map((review) => safeString(review.raterId)).filter(Boolean)));
      return {
        analysis,
        reviewCount: analysisReviews.length,
        uniqueRaterCount: uniqueRaters.length,
        requiredRaterCount,
      };
    })
    .filter((item) => item.uniqueRaterCount < requiredRaterCount)
    .sort((left, right) => String(right.analysis.createdAt).localeCompare(String(left.analysis.createdAt)))
    .map(({ analysis, reviewCount, uniqueRaterCount, requiredRaterCount: requiredCount }) => ({
      analysisId: analysis.analysisId,
      participantId: analysis.participantId,
      groupId: analysis.groupId,
      sessionStage: analysis.sessionStage,
      pieceId: analysis.pieceId,
      sectionId: analysis.sectionId,
      createdAt: analysis.createdAt,
      noteFindingCount: getArray(analysis.noteFindings).length,
      measureFindingCount: getArray(analysis.measureFindings).length,
      recommendedPracticePath: safeString(analysis.recommendedPracticePath),
      reviewCount,
      uniqueRaterCount,
      requiredRaterCount: requiredCount,
    }));
}

function createValidationReview(store, payload) {
  const analysisId = safeString(payload.analysisId).trim();
  const analysis = store.analyses.find((item) => item.analysisId === analysisId);
  if (!analysis) {
    throw new Error("analysis not found.");
  }

  const teacherIssueNoteIds = toUniqueStringList(payload.teacherIssueNoteIds);
  const teacherIssueMeasureIndexes = toUniqueNumberList(payload.teacherIssueMeasureIndexes);
  const systemNoteIds = getAnalysisSystemNoteIds(analysis);
  const systemMeasureIndexes = getAnalysisSystemMeasureIndexes(analysis);
  const noteMetrics = calculateBinaryMetrics(systemNoteIds, teacherIssueNoteIds);
  const measureMetrics = calculateBinaryMetrics(systemMeasureIndexes, teacherIssueMeasureIndexes);
  const systemRecommendedPath = getAnalysisRecommendedPracticePath(analysis);

  return normalizeValidationReview({
    reviewId: safeString(payload.reviewId) || createId("validation"),
    analysisId: analysis.analysisId,
    participantId: analysis.participantId,
    groupId: analysis.groupId,
    sessionStage: analysis.sessionStage,
    pieceId: analysis.pieceId,
    sectionId: analysis.sectionId,
    raterId: safeString(payload.raterId, "expert"),
    overallAgreement: safeNumber(payload.overallAgreement, 0),
    teacherPrimaryPath: safeString(payload.teacherPrimaryPath, "review-first"),
    teacherIssueNoteIds,
    teacherIssueMeasureIndexes,
    comments: safeString(payload.comments),
    noteMatchedCount: noteMetrics.matchedCount,
    notePrecision: noteMetrics.precision,
    noteRecall: noteMetrics.recall,
    noteF1: noteMetrics.f1,
    measureMatchedCount: measureMetrics.matchedCount,
    measurePrecision: measureMetrics.precision,
    measureRecall: measureMetrics.recall,
    measureF1: measureMetrics.f1,
    missedTeacherNoteIds: noteMetrics.missedTeacherValues,
    extraSystemNoteIds: noteMetrics.extraSystemValues,
    missedTeacherMeasureIndexes: measureMetrics.missedTeacherValues,
    extraSystemMeasureIndexes: measureMetrics.extraSystemValues,
    systemRecommendedPath,
    pathAgreement: safeString(payload.teacherPrimaryPath, "review-first") === systemRecommendedPath,
    submittedAt: nowIso(),
  });
}

function computeAdjudicationReasonsFromPair(pair = {}) {
  const reasons = [];
  if (!safeBoolean(pair.pathMatch, false)) {
    reasons.push("practice-path mismatch");
  }
  if (safeNumber(pair.overallAgreementGap, 0) >= ADJUDICATION_OVERALL_GAP_THRESHOLD) {
    reasons.push("overall-agreement gap >= 2");
  }
  if (pair.noteOverlapF1 != null && safeNumber(pair.noteOverlapF1, 1) < ADJUDICATION_NOTE_F1_THRESHOLD) {
    reasons.push("note-overlap F1 < 0.67");
  }
  if (pair.measureOverlapF1 != null && safeNumber(pair.measureOverlapF1, 1) < ADJUDICATION_MEASURE_F1_THRESHOLD) {
    reasons.push("measure-overlap F1 < 0.67");
  }
  return reasons;
}

function buildValidationPairRecords(store) {
  return store.analyses
    .map((analysis) => {
      const latestByRater = new Map();
      getArray(store.validationReviews)
        .filter((review) => review.analysisId === analysis.analysisId)
        .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)))
        .forEach((review) => {
          const raterId = safeString(review.raterId);
          if (raterId && !latestByRater.has(raterId)) {
            latestByRater.set(raterId, review);
          }
        });

      const sourceReviews = Array.from(latestByRater.values())
        .slice(0, REQUIRED_VALIDATION_RATERS)
        .sort((left, right) => safeString(left.raterId).localeCompare(safeString(right.raterId)));

      if (sourceReviews.length < REQUIRED_VALIDATION_RATERS) {
        return null;
      }

      const [first, second] = sourceReviews;
      const noteOverlap = calculateBinaryMetrics(first.teacherIssueNoteIds, second.teacherIssueNoteIds);
      const measureOverlap = calculateBinaryMetrics(first.teacherIssueMeasureIndexes, second.teacherIssueMeasureIndexes);
      const pair = {
        analysisId: analysis.analysisId,
        participantId: analysis.participantId,
        groupId: analysis.groupId,
        sessionStage: analysis.sessionStage,
        pieceId: analysis.pieceId,
        sectionId: analysis.sectionId,
        scoreUnit: `${analysis.pieceId}/${analysis.sectionId}`,
        sourceRaterIds: sourceReviews.map((item) => item.raterId),
        raterAId: first.raterId,
        raterBId: second.raterId,
        overallAgreementA: first.overallAgreement,
        overallAgreementB: second.overallAgreement,
        overallAgreementGap: Math.abs(safeNumber(first.overallAgreement) - safeNumber(second.overallAgreement)),
        teacherPrimaryPathA: first.teacherPrimaryPath,
        teacherPrimaryPathB: second.teacherPrimaryPath,
        pathMatch: safeString(first.teacherPrimaryPath) === safeString(second.teacherPrimaryPath),
        noteOverlapPrecision: noteOverlap.precision,
        noteOverlapRecall: noteOverlap.recall,
        noteOverlapF1: noteOverlap.f1,
        measureOverlapPrecision: measureOverlap.precision,
        measureOverlapRecall: measureOverlap.recall,
        measureOverlapF1: measureOverlap.f1,
      };
      const reasons = computeAdjudicationReasonsFromPair(pair);
      return {
        ...pair,
        adjudicationReason: reasons.join(" | "),
        requiresAdjudication: reasons.length > 0,
      };
    })
    .filter(Boolean);
}

function buildPendingAdjudications(store) {
  const adjudicatedAnalysisIds = new Set(getArray(store.adjudications).map((item) => item.analysisId).filter(Boolean));
  return buildValidationPairRecords(store)
    .filter((item) => item.requiresAdjudication && !adjudicatedAnalysisIds.has(item.analysisId))
    .sort((left, right) => String(right.analysisId).localeCompare(String(left.analysisId)));
}

function buildAdjudicationSummary(store) {
  const pairRecords = buildValidationPairRecords(store);
  const adjudications = getArray(store.adjudications);
  const pendingAdjudications = buildPendingAdjudications(store);

  return {
    pairCount: pairRecords.length,
    adjudicationRequiredCount: pairRecords.filter((item) => item.requiresAdjudication).length,
    pendingAdjudicationCount: pendingAdjudications.length,
    adjudicationResolvedCount: adjudications.length,
    averagePathAgreement: adjudications.length ? Number((adjudications.filter((item) => item.pathAgreement).length / adjudications.length).toFixed(3)) : 0,
    averageNoteF1: adjudications.length ? Number(average(adjudications.map((item) => item.noteF1)).toFixed(3)) : 0,
    averageMeasureF1: adjudications.length ? Number(average(adjudications.map((item) => item.measureF1)).toFixed(3)) : 0,
    pendingAdjudications,
  };
}

function getAdjudicationStatusForAnalysis(store, analysisId) {
  if (getArray(store.adjudications).some((item) => item.analysisId === analysisId)) {
    return "resolved";
  }

  const uniqueRaters = new Set(
    getArray(store.validationReviews)
      .filter((item) => item.analysisId === analysisId)
      .map((item) => safeString(item.raterId))
      .filter(Boolean),
  );

  if (uniqueRaters.size < REQUIRED_VALIDATION_RATERS) {
    return "not-ready";
  }

  const pendingPair = buildPendingAdjudications(store).find((item) => item.analysisId === analysisId);
  return pendingPair ? "pending" : "not-needed";
}

function createAdjudication(store, payload) {
  const analysisId = safeString(payload.analysisId).trim();
  const analysis = store.analyses.find((item) => item.analysisId === analysisId);
  if (!analysis) {
    throw new Error("analysis not found.");
  }

  const sourcePair = buildValidationPairRecords(store).find((item) => item.analysisId === analysisId);
  if (!sourcePair) {
    throw new Error("at least two validation reviews are required before adjudication.");
  }

  const finalIssueNoteIds = toUniqueStringList(payload.finalIssueNoteIds);
  const finalIssueMeasureIndexes = toUniqueNumberList(payload.finalIssueMeasureIndexes);
  const systemNoteIds = getAnalysisSystemNoteIds(analysis);
  const systemMeasureIndexes = getAnalysisSystemMeasureIndexes(analysis);
  const noteMetrics = calculateBinaryMetrics(systemNoteIds, finalIssueNoteIds);
  const measureMetrics = calculateBinaryMetrics(systemMeasureIndexes, finalIssueMeasureIndexes);
  const triggerReasons = toUniqueStringList(payload.triggerReasons).length
    ? toUniqueStringList(payload.triggerReasons)
    : sourcePair.adjudicationReason
      ? sourcePair.adjudicationReason.split(" | ").filter(Boolean)
      : ["manual-review"];
  const systemRecommendedPath = getAnalysisRecommendedPracticePath(analysis);

  return normalizeAdjudicationRecord({
    adjudicationId: safeString(payload.adjudicationId) || createId("adjudication"),
    analysisId: analysis.analysisId,
    participantId: analysis.participantId,
    groupId: analysis.groupId,
    sessionStage: analysis.sessionStage,
    pieceId: analysis.pieceId,
    sectionId: analysis.sectionId,
    adjudicatorId: safeString(payload.adjudicatorId, "researcher"),
    sourceRaterIds: sourcePair.sourceRaterIds,
    triggerReasons,
    finalPrimaryPath: safeString(payload.finalPrimaryPath, "review-first"),
    finalIssueNoteIds,
    finalIssueMeasureIndexes,
    comments: safeString(payload.comments),
    noteMatchedCount: noteMetrics.matchedCount,
    notePrecision: noteMetrics.precision,
    noteRecall: noteMetrics.recall,
    noteF1: noteMetrics.f1,
    measureMatchedCount: measureMetrics.matchedCount,
    measurePrecision: measureMetrics.precision,
    measureRecall: measureMetrics.recall,
    measureF1: measureMetrics.f1,
    systemRecommendedPath,
    pathAgreement: safeString(payload.finalPrimaryPath, "review-first") === systemRecommendedPath,
    resolvedAt: nowIso(),
  });
}

function buildValidationSummary(store) {
  const reviews = getArray(store.validationReviews);
  const analysesWithValidation = Array.from(new Set(reviews.map((item) => item.analysisId).filter(Boolean)));
  const fullyValidatedAnalysisCount = store.analyses.filter((analysis) => {
    const uniqueRaters = new Set(
      reviews.filter((item) => item.analysisId === analysis.analysisId).map((item) => safeString(item.raterId)).filter(Boolean),
    );
    return uniqueRaters.size >= REQUIRED_VALIDATION_RATERS;
  }).length;
  return {
    reviewCount: reviews.length,
    validatedAnalysisCount: analysesWithValidation.length,
    fullyValidatedAnalysisCount,
    requiredRaterCount: REQUIRED_VALIDATION_RATERS,
    averageAgreement: reviews.length ? Number(average(reviews.map((item) => item.overallAgreement)).toFixed(2)) : 0,
    averageNotePrecision: reviews.length ? Number(average(reviews.map((item) => item.notePrecision)).toFixed(3)) : 0,
    averageNoteRecall: reviews.length ? Number(average(reviews.map((item) => item.noteRecall)).toFixed(3)) : 0,
    averageNoteF1: reviews.length ? Number(average(reviews.map((item) => item.noteF1)).toFixed(3)) : 0,
    averageMeasurePrecision: reviews.length ? Number(average(reviews.map((item) => item.measurePrecision)).toFixed(3)) : 0,
    averageMeasureRecall: reviews.length ? Number(average(reviews.map((item) => item.measureRecall)).toFixed(3)) : 0,
    averageMeasureF1: reviews.length ? Number(average(reviews.map((item) => item.measureF1)).toFixed(3)) : 0,
    pathAgreementRate: reviews.length ? Number((reviews.filter((item) => item.pathAgreement).length / reviews.length).toFixed(3)) : 0,
    pendingValidationCount: buildPendingValidationReviews(store).length,
  };
}

function buildExportPayload(store, dataset) {
  const normalizedDataset = safeString(dataset, "participants").toLowerCase();
  if (normalizedDataset === "questionnaires") {
    const rows = buildQuestionnaireExportRows(store);
    const headers = [
      "participantId",
      "groupId",
      "sessionStage",
      "usefulness",
      "easeOfUse",
      "feedbackClarity",
      "confidence",
      "continuance",
      "notes",
      "submittedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "expert-ratings") {
    const rows = buildExpertRatingExportRows(store);
    const headers = ["participantId", "groupId", "stage", "pitchScore", "rhythmScore", "raterId", "comments", "submittedAt"];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "analyses") {
    const rows = buildAnalysisExportRows(store);
    const headers = [
      "analysisId",
      "participantId",
      "groupId",
      "sessionStage",
      "pieceId",
      "sectionId",
      "overallPitchScore",
      "overallRhythmScore",
      "confidence",
      "recommendedPracticePath",
      "analysisMode",
      "createdAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "validation-reviews") {
    const rows = buildValidationReviewRows(store);
    const headers = [
      "reviewId",
      "analysisId",
      "participantId",
      "groupId",
      "sessionStage",
      "pieceId",
      "sectionId",
      "raterId",
      "overallAgreement",
      "teacherPrimaryPath",
      "systemRecommendedPath",
      "pathAgreement",
      "noteMatchedCount",
      "notePrecision",
      "noteRecall",
      "noteF1",
      "measureMatchedCount",
      "measurePrecision",
      "measureRecall",
      "measureF1",
      "teacherIssueNoteIds",
      "teacherIssueMeasureIndexes",
      "missedTeacherNoteIds",
      "extraSystemNoteIds",
      "missedTeacherMeasureIndexes",
      "extraSystemMeasureIndexes",
      "comments",
      "submittedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "adjudications") {
    const rows = buildAdjudicationRows(store);
    const headers = [
      "adjudicationId",
      "analysisId",
      "participantId",
      "groupId",
      "sessionStage",
      "pieceId",
      "sectionId",
      "adjudicatorId",
      "sourceRaterIds",
      "triggerReasons",
      "finalPrimaryPath",
      "systemRecommendedPath",
      "pathAgreement",
      "noteMatchedCount",
      "notePrecision",
      "noteRecall",
      "noteF1",
      "measureMatchedCount",
      "measurePrecision",
      "measureRecall",
      "measureF1",
      "finalIssueNoteIds",
      "finalIssueMeasureIndexes",
      "comments",
      "resolvedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "tasks") {
    const rows = buildTaskExportRows(store);
    const headers = [
      "participantId",
      "groupId",
      "taskId",
      "stage",
      "pieceId",
      "sectionId",
      "focus",
      "instructions",
      "practiceTargetMinutes",
      "dueDate",
      "status",
      "assignedBy",
      "createdAt",
      "updatedAt",
      "completedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "interviews") {
    const rows = buildInterviewExportRows(store);
    const headers = [
      "participantId",
      "groupId",
      "interviewId",
      "stage",
      "interviewerId",
      "summary",
      "barriers",
      "strategyChanges",
      "representativeQuote",
      "nextAction",
      "followUpNeeded",
      "submittedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "sampling") {
    const rows = buildSamplingExportRows(store);
    const headers = ["participantId", "groupId", "selected", "priority", "reason", "markedBy", "updatedAt", "interviewCount"];
    return { dataset: normalizedDataset, rows, headers };
  }
  const rows = buildParticipantExportRows(store);
  const headers = [
    "participantId",
    "groupId",
    "createdAt",
    "lastActiveAt",
    "analysisCount",
    "weeklySessionCount",
    "profileCompleted",
    "consentSigned",
    "institution",
    "grade",
    "pretestPitch",
    "posttestPitch",
    "pretestRhythm",
    "posttestRhythm",
    "pitchGain",
    "rhythmGain",
    "usefulness",
    "easeOfUse",
    "feedbackClarity",
    "confidence",
    "continuance",
    "questionnaireCount",
    "latestQuestionnaireStage",
    "taskPlanCount",
    "completedTaskCount",
    "interviewCount",
    "latestInterviewStage",
    "interviewSamplingSelected",
    "interviewSamplingPriority",
    "interviewSamplingReason",
    "expertPretestPitch",
    "expertPosttestPitch",
    "expertPretestRhythm",
    "expertPosttestRhythm",
    "validationReviewCount",
    "averageValidationAgreement",
    "adjudicationCount",
    "pendingAdjudicationCount",
    "adjudicationStatus",
    "latestAdjudicationAt",
    "latestAdjudicationPathAgreement",
  ];
  return { dataset: "participants", rows, headers };
}

function buildGroupOverview(participants = []) {
  const groups = ["experimental", "control"];
  return groups.map((groupId) => {
    const groupParticipants = participants.filter((participant) => participant.groupId === groupId);
    const completed = groupParticipants.filter((participant) => participant.pitchGain != null);
    return {
      groupId,
      participantCount: groupParticipants.length,
      completedPairCount: completed.length,
      averagePitchGain: Number(average(completed.map((participant) => participant.pitchGain)).toFixed(2)),
      averageRhythmGain: Number(average(completed.map((participant) => participant.rhythmGain)).toFixed(2)),
      averageUsefulness: Number(
        average(groupParticipants.map((participant) => participant.experienceScales?.usefulness)).toFixed(2),
      ),
      averageContinuance: Number(
        average(groupParticipants.map((participant) => participant.experienceScales?.continuance)).toFixed(2),
      ),
    };
  });
}

async function fetchAnalyzerStatus() {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl) {
    return {
      configured: false,
      reachable: false,
      mode: "fallback-only",
      serviceUrl: "",
    };
  }

  try {
    const response = await fetch(`${analyzerUrl}/health`);
    if (!response.ok) {
      return {
        configured: true,
        reachable: false,
        mode: "external-unreachable",
        serviceUrl: analyzerUrl,
        statusCode: response.status,
      };
    }
    const json = await response.json();
    return {
      configured: true,
      reachable: true,
      mode: safeString(json.mode, "external"),
      serviceUrl: analyzerUrl,
      details: json,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      mode: "external-error",
      serviceUrl: analyzerUrl,
      error: safeString(error?.message, "unknown"),
    };
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ai-erhu-research-prototype", at: nowIso() });
});

app.get("/api/erhu/analyzer-status", async (req, res) => {
  const analyzer = await fetchAnalyzerStatus();
  res.json({ ok: true, analyzer });
});

app.post("/api/erhu/scores/import-pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "pdf file is required." });
  }

  const titleHint = safeString(req.body?.titleHint, path.parse(req.file.originalname || "score").name);
  const selectedPartHint = safeString(req.body?.selectedPartHint, "erhu") || "erhu";
  const pdfHash = sha1(req.file.buffer);
  const jobId = createId("scorejob");
  const jobDir = path.join(SCORE_IMPORTS_DIR, jobId);
  const pdfPath = path.join(jobDir, "source.pdf");
  const webPdfPath = toWebDataPath("score-imports", jobId, "source.pdf");
  const knownPiece = findKnownPieceForPdf(titleHint, req.file.originalname || "");
  const fallbackPiece = knownPiece ? cloneLibraryPieceForImport(knownPiece) : null;
  const store = await readScoreStore();
  const reusableScore = findReusableImportedScore(store, { pdfHash, selectedPart: selectedPartHint });

  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(pdfPath, req.file.buffer);

  if (reusableScore) {
    const previewPages = buildCachedImportPreviewPages(
      reusableScore,
      [{ pageNumber: 1, type: "pdf", url: webPdfPath }],
      webPdfPath,
    );
    const reusableScoreRecord = normalizeImportedScoreRecord({
      ...reusableScore,
      sourcePdfPath: webPdfPath,
      previewPages,
      omrStats: buildReusedOmrStats(reusableScore.omrStats, previewPages),
      updatedAt: nowIso(),
    });
    const existingScoreIndex = store.scores.findIndex((item) => item.scoreId === reusableScoreRecord.scoreId);
    if (existingScoreIndex >= 0) {
      store.scores[existingScoreIndex] = reusableScoreRecord;
    } else {
      store.scores.push(reusableScoreRecord);
    }
    const cachedJob = normalizeScoreImportJob({
      jobId,
      scoreId: reusableScoreRecord.scoreId,
      reusedScoreId: reusableScoreRecord.scoreId,
      title: reusableScoreRecord.title || titleHint,
      sourcePdfPath: webPdfPath,
      pdfHash,
      originalFilename: req.file.originalname,
      omrStatus: "completed",
      omrConfidence: reusableScoreRecord.omrConfidence,
      musicxmlPath: reusableScoreRecord.musicxmlPath,
      previewPages,
      detectedParts: reusableScoreRecord.detectedParts,
      selectedPart: reusableScoreRecord.selectedPart,
      selectedPartCandidates: reusableScoreRecord.detectedParts,
      omrStats: buildReusedOmrStats(reusableScoreRecord.omrStats, previewPages),
      warnings: ["已复用相同 PDF 的识谱结果，已跳过重复读谱。"],
      cacheHit: true,
      progress: 1,
      stage: "completed",
      error: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    store.jobs.push(cachedJob);
    await writeScoreStore(store);
    return res.json({ ok: true, scoreImportJobId: cachedJob.jobId, job: cachedJob });
  }

  const previewPages = [{ pageNumber: 1, type: "pdf", url: webPdfPath }];
  const initialJob = await upsertScoreImportJob({
    jobId,
    originalFilename: req.file.originalname,
    title: titleHint,
    sourcePdfPath: webPdfPath,
    pdfHash,
    omrStatus: "processing",
    omrConfidence: 0,
    previewPages,
    detectedParts: [selectedPartHint],
    selectedPart: selectedPartHint,
    selectedPartCandidates: [selectedPartHint],
    omrStats: { mode: "pending", pageCount: getArray(previewPages).length },
    warnings: ["正在后台识谱，请稍候。"],
    error: "",
    progress: 0.05,
    stage: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  void launchScoreImportTask({
    jobId,
    titleHint,
    selectedPartHint,
    pdfHash,
    pdfPath,
    webPdfPath,
    originalFilename: req.file.originalname,
    fallbackPiece,
    previewPages,
  });

  return res.status(202).json({ ok: true, scoreImportJobId: initialJob.jobId, job: initialJob });
});

app.post("/api/erhu/scores/import-pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "pdf file is required." });
  }

  const titleHint = safeString(req.body?.titleHint, path.parse(req.file.originalname || "score").name);
  const selectedPartHint = safeString(req.body?.selectedPartHint, "erhu") || "erhu";
  const pdfHash = sha1(req.file.buffer);
  const jobId = createId("scorejob");
  const jobDir = path.join(SCORE_IMPORTS_DIR, jobId);
  const pdfPath = path.join(jobDir, "source.pdf");
  const webPdfPath = toWebDataPath("score-imports", jobId, "source.pdf");
  const knownPiece = findKnownPieceForPdf(titleHint, req.file.originalname || "");
  const fallbackPiece = knownPiece ? cloneLibraryPieceForImport(knownPiece) : null;
  const store = await readScoreStore();
  const reusableScore = findReusableImportedScore(store, { pdfHash, selectedPart: selectedPartHint });

  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(pdfPath, req.file.buffer);

  if (reusableScore) {
    const previewPages = [{ pageNumber: 1, type: "pdf", url: webPdfPath }];
    const reusableScoreRecord = normalizeImportedScoreRecord({
      ...reusableScore,
      sourcePdfPath: webPdfPath,
      previewPages,
      updatedAt: nowIso(),
    });
    const existingScoreIndex = store.scores.findIndex((item) => item.scoreId === reusableScoreRecord.scoreId);
    if (existingScoreIndex >= 0) {
      store.scores[existingScoreIndex] = reusableScoreRecord;
    } else {
      store.scores.push(reusableScoreRecord);
    }
    const cachedJob = normalizeScoreImportJob({
      jobId,
      scoreId: reusableScoreRecord.scoreId,
      reusedScoreId: reusableScoreRecord.scoreId,
      title: reusableScoreRecord.title || titleHint,
      sourcePdfPath: webPdfPath,
      pdfHash,
      originalFilename: req.file.originalname,
      omrStatus: "completed",
      omrConfidence: reusableScoreRecord.omrConfidence,
      musicxmlPath: reusableScoreRecord.musicxmlPath,
      previewPages,
      detectedParts: reusableScoreRecord.detectedParts,
      selectedPart: reusableScoreRecord.selectedPart,
      selectedPartCandidates: reusableScoreRecord.detectedParts,
      warnings: ["已复用相同 PDF 的识谱结果，已跳过重复读谱。"],
      cacheHit: true,
      error: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    store.jobs.push(cachedJob);
    await writeScoreStore(store);
    return res.json({ ok: true, scoreImportJobId: cachedJob.jobId, job: cachedJob });
  }

  let jobResult = null;
  let serviceWarning = "";
  try {
    jobResult = await callExternalScoreImportLongTimeout({
      jobId,
      pdfPath,
      originalFilename: req.file.originalname,
      titleHint,
      selectedPartHint,
      fallbackPieceId: safeString(fallbackPiece?.pieceId),
      fallbackPieceTitle: safeString(fallbackPiece?.title),
      fallbackPiecePack: fallbackPiece,
      outputDir: jobDir,
    });
  } catch (error) {
    serviceWarning = safeString(error?.message, "external score import unavailable");
  }

  const previewPages = [{ pageNumber: 1, type: "pdf", url: webPdfPath }];

  let normalizedJob = normalizeScoreImportJob({
    jobId,
    originalFilename: req.file.originalname,
    title: titleHint,
    sourcePdfPath: webPdfPath,
    pdfHash,
    omrStatus: "failed",
    omrConfidence: 0,
    previewPages,
    detectedParts: [selectedPartHint],
    selectedPart: selectedPartHint,
    selectedPartCandidates: [selectedPartHint],
    warnings: serviceWarning ? [serviceWarning] : [],
    error: "自动识谱失败。",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  if (jobResult?.omrStatus === "completed" && jobResult.piecePack) {
    const upstreamScoreId = safeString(jobResult.scoreId);
    const scoreId = upstreamScoreId.startsWith("score-") ? upstreamScoreId : createId("score");
    const importedSections = getArray(jobResult.piecePack?.sections).length ? jobResult.piecePack.sections : [jobResult.piecePack];
    const scoreRecord = normalizeImportedScoreRecord({
      scoreId,
      pieceId: safeString(jobResult.piecePack?.pieceId, fallbackPiece?.pieceId),
      title: safeString(jobResult.title, fallbackPiece?.title || titleHint),
      composer: safeString(jobResult.piecePack?.composer, fallbackPiece?.composer),
      sourcePdfPath: webPdfPath,
      pdfHash,
      musicxmlPath: toWebPathFromAbsolute(jobResult.musicxmlPath),
      omrStatus: jobResult.omrStatus,
      omrConfidence: safeNumber(jobResult.omrConfidence, 0),
      detectedParts: getArray(jobResult.detectedParts).length ? jobResult.detectedParts : ["erhu"],
      selectedPart: safeString(jobResult.selectedPart, "erhu"),
      previewPages: getArray(jobResult.previewPages).length ? jobResult.previewPages : previewPages,
      sections: importedSections,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const existingScoreIndex = store.scores.findIndex((item) => item.scoreId === scoreId);
    if (existingScoreIndex >= 0) {
      store.scores[existingScoreIndex] = scoreRecord;
    } else {
      store.scores.push(scoreRecord);
    }
    normalizedJob = normalizeScoreImportJob({
      ...jobResult,
      scoreId,
      title: scoreRecord.title,
      sourcePdfPath: webPdfPath,
      pdfHash,
      musicxmlPath: jobResult.musicxmlPath ? toWebPathFromAbsolute(jobResult.musicxmlPath) : "",
      originalFilename: req.file.originalname,
      previewPages: scoreRecord.previewPages,
      warnings: [...getArray(jobResult.warnings), ...(serviceWarning ? [serviceWarning] : [])],
      error: jobResult.error,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  } else if (fallbackPiece) {
    const scoreId = createId("score");
    const scoreRecord = normalizeImportedScoreRecord({
      scoreId,
      pieceId: fallbackPiece.pieceId,
      title: fallbackPiece.title,
      composer: fallbackPiece.composer,
      sourcePdfPath: webPdfPath,
      pdfHash,
      musicxmlPath: "",
      omrStatus: "completed",
      omrConfidence: 0.44,
      detectedParts: ["erhu"],
      selectedPart: "erhu",
      previewPages,
      sections: fallbackPiece.sections,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    store.scores.push(scoreRecord);
    normalizedJob = normalizeScoreImportJob({
      jobId,
      scoreId,
      originalFilename: req.file.originalname,
      title: fallbackPiece.title,
      sourcePdfPath: webPdfPath,
      pdfHash,
      omrStatus: "completed",
      omrConfidence: 0.44,
      previewPages,
      detectedParts: ["erhu"],
      selectedPart: "erhu",
      selectedPartCandidates: ["erhu"],
      warnings: [
        "当前 PDF 通过已知曲目自动匹配进入结构化曲库。",
        ...(serviceWarning ? [serviceWarning] : []),
      ],
      error: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  } else if (serviceWarning) {
    normalizedJob.warnings = [serviceWarning];
    normalizedJob.error = "未完成自动识谱，且当前 PDF 未匹配到内置曲目。";
  }

  const existingJobIndex = store.jobs.findIndex((item) => item.jobId === normalizedJob.jobId);
  if (existingJobIndex >= 0) {
    store.jobs[existingJobIndex] = normalizedJob;
  } else {
    store.jobs.push(normalizedJob);
  }
  await writeScoreStore(store);

  return res.json({ ok: true, scoreImportJobId: normalizedJob.jobId, job: normalizedJob });
});

app.get("/api/erhu/scores/import-pdf/:jobId", async (req, res) => {
  const store = await readScoreStore();
  const job = store.jobs.find((item) => item.jobId === req.params.jobId);
  if (!job) {
    if (activeScoreImportTasks.has(req.params.jobId)) {
      return res.json({
        ok: true,
        job: normalizeScoreImportJob({
          jobId: req.params.jobId,
          omrStatus: "processing",
          warnings: ["正在后台识谱，请稍候。"],
          progress: 0.2,
          stage: "queued",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }),
      });
    }
    return res.status(404).json({ error: "score import job not found." });
  }
  return res.json({ ok: true, job });
});

app.get("/api/erhu/scores/:scoreId", async (req, res) => {
  const store = await readScoreStore();
  const score = getImportedScore(store, req.params.scoreId);
  if (!score) {
    return res.status(404).json({ error: "score not found." });
  }
  return res.json({ ok: true, score });
});

app.get("/api/erhu/piece-pass/latest", async (req, res) => {
  const pieceId = safeString(req.query.pieceId);
  const title = safeString(req.query.title);
  const piecePass = await readLatestPiecePassSummary({ pieceId, title });
  return res.json({ ok: true, piecePass });
});

app.get("/api/erhu/pieces", (req, res) => {
  res.json({ ok: true, pieces: getErhuPieceSummaries() });
});

app.get("/api/erhu/pieces/:pieceId", (req, res) => {
  const piece = getErhuPiece(req.params.pieceId);
  if (!piece) {
    return res.status(404).json({ error: "piece not found" });
  }
  return res.json({ ok: true, piece });
});

app.post("/api/erhu/auto-detect-section", upload.single("audio"), async (req, res) => {
  const incomingPayload = parseIncomingPayload(req);
  const payload = {
    ...incomingPayload,
    audioSubmission: buildAudioSubmissionFromUpload(req.file, incomingPayload.audioSubmission),
  };
  const participantId = safeString(payload.participantId).trim();
  const scoreId = safeString(payload.scoreId);
  const pieceId = safeString(payload.pieceId);

  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }
  if (!pieceId && !scoreId) {
    return res.status(400).json({ error: "pieceId or scoreId is required." });
  }

  const scoreStore = await readScoreStore();
  const importedScore = scoreId ? getImportedScore(scoreStore, scoreId) : null;
  const piece = getErhuPiece(pieceId);
  if (!piece && !importedScore) {
    return res.status(404).json({ error: "piece not found." });
  }

  const preparedPayload = await normalizePreparedPayloadForAnalyzer(buildPreparedAudioPayload(
    payload,
    req.file ? await persistUploadedAudioFile(req.file) : await persistPayloadAudio(payload),
  ));

  const detection = await autoDetectPieceSection({ ...preparedPayload, scoreId }, importedScore || piece, {
    candidateSectionIds: payload.candidateSectionIds,
    maxSections: payload.maxSections,
    windowStartSeconds: payload.windowStartSeconds,
    expectedSequenceIndex: payload.expectedSequenceIndex,
  });

  if (!detection.bestSection) {
    return res.status(404).json({ error: "no detectable section candidates found." });
  }

  return res.json({
    ok: true,
    pieceId: pieceId || importedScore?.pieceId || "",
    scoreId,
    section: detection.bestSection,
    analysis: detection.bestAnalysis || buildDetectionSummaryAnalysis(getArray(detection.candidates)[0] || {}),
    candidates: getArray(detection.candidates).slice(0, 8).map((candidate) => compactDetectionCandidate(candidate)),
  });
});

app.post("/api/erhu/analyze", upload.single("audio"), async (req, res) => {
  const requestStartedAt = Date.now();
  const incomingPayload = parseIncomingPayload(req);
  const payload = {
    ...incomingPayload,
    audioSubmission: buildAudioSubmissionFromUpload(req.file, incomingPayload.audioSubmission),
  };
  const participantId = safeString(payload.participantId).trim();
  const groupId = safeString(payload.groupId, "experimental");
  const scoreId = safeString(payload.scoreId);
  const pieceId = safeString(payload.pieceId);
  const sectionId = safeString(payload.sectionId);
  const autoDetectSection = safeBoolean(payload.autoDetectSection, false);

  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const scoreStore = await readScoreStore();
  const importedScore = scoreId ? getImportedScore(scoreStore, scoreId) : null;
  const piece = pieceId ? getErhuPiece(pieceId) : null;
  if (scoreId || pieceId) {
    appendPerfTrace(
      `[analyze] start participant=${participantId || "unknown"} scoreId=${scoreId || "-"} pieceId=${pieceId || "-"} autoDetect=${autoDetectSection} at=${new Date().toISOString()}`,
    );
  }
  const preparedPayload = await normalizePreparedPayloadForAnalyzer(buildPreparedAudioPayload(
    payload,
    req.file ? await persistUploadedAudioFile(req.file) : await persistPayloadAudio(payload),
  ));
  if (scoreId || pieceId) {
    appendPerfTrace(
      `[analyze] payload-ready elapsedMs=${Date.now() - requestStartedAt} audioHash=${safeString(preparedPayload.audioHash).slice(0, 12)}`,
    );
  }
  const librarySection = getErhuSection(pieceId, sectionId);
  const importedSection = importedScore ? getImportedScoreSection(scoreStore, scoreId, sectionId) : null;
  let section = normalizePiecePackOverride(payload.piecePackOverride, importedSection || librarySection || { pieceId, sectionId }) || importedSection || librarySection;
  let analysis = null;
  let autoDetection = null;

  if (!section && autoDetectSection && (importedScore || piece)) {
    const detectStartedAt = Date.now();
    autoDetection = await autoDetectPieceSection(
      { ...preparedPayload, scoreId },
      importedScore || piece,
      {
        candidateSectionIds: payload.candidateSectionIds,
        maxSections: payload.maxSections,
        windowStartSeconds: payload.windowStartSeconds,
        expectedSequenceIndex: payload.expectedSequenceIndex,
      },
    );
    if (scoreId || pieceId) {
      appendPerfTrace(
        `[analyze] autodetect-finished elapsedMs=${Date.now() - detectStartedAt} bestSection=${safeString(autoDetection?.bestSection?.sectionId)} candidates=${getArray(autoDetection?.candidates).length}`,
      );
    }
    section = autoDetection.bestSection;
    analysis = autoDetection.bestAnalysis;
    if (analysis && safeString(analysis.analysisMode) === "detection-summary") {
      analysis = null;
    }
  }

  if (!section) {
    return res.status(404).json({ error: "piece section not found." });
  }

  if (!analysis) {
    const sectionAnalyzeStartedAt = Date.now();
    const autoDetectedCandidate = getArray(autoDetection?.candidates).find(
      (candidate) => safeString(candidate?.sectionId) === safeString(section?.sectionId),
    ) || getArray(autoDetection?.candidates)[0] || null;
    const scopedPayload = shouldUseDetectedWindowAnalysis(autoDetectedCandidate, section)
      ? applyCandidateDetectedWindow(preparedPayload, autoDetectedCandidate, section)
      : preparedPayload;
    analysis = await runSectionAnalysis(scopedPayload, section);
    if (scoreId || pieceId) {
      appendPerfTrace(
        `[analyze] section-analysis-finished elapsedMs=${Date.now() - sectionAnalyzeStartedAt} sectionId=${safeString(section?.sectionId)} mode=${safeString(analysis?.analysisMode, "unknown")}`,
      );
    }
  }

  const analysisRecord = {
    analysisId: createId("analysis"),
    participantId,
    groupId,
    sessionStage: safeString(payload.sessionStage, "pretest"),
    preprocessMode: safeString(payload.preprocessMode, "off"),
    separationMode: safeString(payload.separationMode, safeString(payload.preprocessMode, "auto")),
    scoreId,
    pieceId: safeString(section.pieceId, importedScore?.pieceId || pieceId),
    sectionId: safeString(section.sectionId, sectionId),
    piecePackSource: payload.piecePackOverride ? "manual-helper" : importedScore ? "score-import" : "library",
    autoDetectedSection: autoDetectSection,
    audioSubmission: payload.audioSubmission || null,
    overallPitchScore: clamp(safeNumber(analysis.overallPitchScore, 0), 0, 100),
    overallRhythmScore: clamp(safeNumber(analysis.overallRhythmScore, 0), 0, 100),
    studentPitchScore: clamp(safeNumber(analysis.studentPitchScore, safeNumber(analysis.overallPitchScore, 0)), 0, 100),
    studentRhythmScore: clamp(safeNumber(analysis.studentRhythmScore, safeNumber(analysis.overallRhythmScore, 0)), 0, 100),
    studentCombinedScore: clamp(
      safeNumber(
        analysis.studentCombinedScore,
        (safeNumber(analysis.studentPitchScore, safeNumber(analysis.overallPitchScore, 0))
          + safeNumber(analysis.studentRhythmScore, safeNumber(analysis.overallRhythmScore, 0))) / 2,
      ),
      0,
      100,
    ),
    separationApplied: safeBoolean(
      analysis.separationApplied,
      safeBoolean(analysis.diagnostics?.separationApplied, false),
    ),
    separationMode: safeString(
      analysis.separationMode,
      safeString(
        analysis.diagnostics?.separationMode,
        safeString(analysis.diagnostics?.appliedPreprocessMode, safeString(payload.separationMode, "off")),
      ),
    ),
    separationConfidence: clamp(
      safeNumber(
        analysis.separationConfidence,
        safeNumber(analysis.diagnostics?.separationConfidence, 0),
      ),
      0,
      1,
    ),
    rawAudioPath: safeString(analysis.rawAudioPath, safeString(analysis.diagnostics?.rawAudioPath)),
    erhuEnhancedAudioPath: safeString(
      analysis.erhuEnhancedAudioPath,
      safeString(analysis.diagnostics?.erhuEnhancedAudioPath),
    ),
    accompanimentResidualPath: safeString(
      analysis.accompanimentResidualPath,
      safeString(analysis.diagnostics?.accompanimentResidualPath),
    ),
    measureFindings: getArray(analysis.measureFindings),
    noteFindings: getArray(analysis.noteFindings),
    demoSegments: getArray(analysis.demoSegments),
    confidence: clamp(safeNumber(analysis.confidence, 0), 0, 1),
    summaryText: safeString(analysis.summaryText),
    teacherComment: safeString(analysis.teacherComment),
    recommendedPracticePath: safeString(analysis.recommendedPracticePath),
    practiceTargets: getArray(analysis.practiceTargets),
    analysisMode: safeString(analysis.analysisMode, "fallback"),
    diagnostics: {
      ...(analysis.diagnostics && typeof analysis.diagnostics === "object" ? analysis.diagnostics : {}),
      autoDetection: autoDetection ? {
        bestSectionId: safeString(autoDetection.bestSection?.sectionId),
        bestScore: safeNumber(autoDetection.candidates?.[0]?.score, 0),
        candidateCount: getArray(autoDetection.candidates).length,
        topCandidates: getArray(autoDetection.candidates).slice(0, 5).map((candidate) => compactDetectionCandidate(candidate)),
      } : null,
    },
    createdAt: nowIso(),
  };

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, groupId);
  store.analyses.push(analysisRecord);
  appendAnalysisToParticipant(participant, payload, analysisRecord);
  await writeStudyStore(store);
  if (scoreId || pieceId) {
    appendPerfTrace(
      `[analyze] complete totalElapsedMs=${Date.now() - requestStartedAt} analysisId=${safeString(analysisRecord.analysisId)} sectionId=${safeString(analysisRecord.sectionId)}`,
    );
  }

  return res.json({
    ok: true,
    analysis: analysisRecord,
  });
});

app.get("/api/erhu/analysis/:analysisId", async (req, res) => {
  const store = await readStudyStore();
  const analysis = store.analyses.find((item) => item.analysisId === req.params.analysisId);
  if (!analysis) {
    return res.status(404).json({ error: "analysis not found." });
  }
  return res.json({ ok: true, analysis });
});

app.post("/api/erhu/study-record", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyExperienceScale(participant, payload);
  await writeStudyStore(store);

  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/participant-profile", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyParticipantProfile(participant, payload);
  await writeStudyStore(store);

  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/expert-rating", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, ""));
  applyExpertRating(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.get("/api/erhu/study-records/:participantId", async (req, res) => {
  const store = await readStudyStore();
  const participant = store.participants.find((item) => item.participantId === req.params.participantId);
  if (!participant) {
    return res.json({ ok: true, participant: null });
  }
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.get("/api/erhu/research/overview", async (req, res) => {
  const store = await readStudyStore();
  const participants = store.participants.map((participant) => buildParticipantView(participant, store));
  const dataQuality = buildDataQualityOverview(store);
  const validationSummary = buildValidationSummary(store);
  const adjudicationSummary = buildAdjudicationSummary(store);
  const withGain = participants.filter((item) => item.pitchGain != null);
  const withQuestionnaire = participants.filter((item) => getArray(item.questionnaires).length > 0);
  const withExpertPost = participants.filter((item) => item.expertRatings?.posttest);
  const withProfile = participants.filter((item) => item.profile?.updatedAt);
  const analyzer = await fetchAnalyzerStatus();
  const averagePitchGain = withGain.length
    ? withGain.reduce((sum, item) => sum + safeNumber(item.pitchGain), 0) / withGain.length
    : 0;
  const averageRhythmGain = withGain.length
    ? withGain.reduce((sum, item) => sum + safeNumber(item.rhythmGain), 0) / withGain.length
    : 0;

  return res.json({
    ok: true,
    overview: {
      participantCount: participants.length,
      analysisCount: store.analyses.length,
      completedPairCount: withGain.length,
      profileCompletedCount: withProfile.length,
      questionnaireCount: withQuestionnaire.length,
      questionnaireEntryCount: buildQuestionnaireExportRows(store).length,
      taskPlanCount: buildTaskExportRows(store).length,
      completedTaskCount: buildTaskExportRows(store).filter((item) => item.status === "completed").length,
      interviewCount: buildInterviewExportRows(store).length,
      expertRatedCount: withExpertPost.length,
      averagePitchGain: Number(averagePitchGain.toFixed(2)),
      averageRhythmGain: Number(averageRhythmGain.toFixed(2)),
      averageUsefulness: Number(average(withQuestionnaire.map((item) => item.experienceScales?.usefulness)).toFixed(2)),
      averageContinuance: Number(average(withQuestionnaire.map((item) => item.experienceScales?.continuance)).toFixed(2)),
      validationReviewCount: validationSummary.reviewCount,
      averageValidationAgreement: validationSummary.averageAgreement,
      averageValidationNoteF1: validationSummary.averageNoteF1,
      averageValidationMeasureF1: validationSummary.averageMeasureF1,
      validationPathAgreementRate: validationSummary.pathAgreementRate,
      validatedAnalysisCount: validationSummary.validatedAnalysisCount,
      fullyValidatedAnalysisCount: validationSummary.fullyValidatedAnalysisCount,
      requiredValidationRaters: validationSummary.requiredRaterCount,
      pendingValidationCount: validationSummary.pendingValidationCount,
      adjudicationResolvedCount: adjudicationSummary.adjudicationResolvedCount,
      adjudicationPendingCount: adjudicationSummary.pendingAdjudicationCount,
      averageAdjudicationNoteF1: adjudicationSummary.averageNoteF1,
      averageAdjudicationMeasureF1: adjudicationSummary.averageMeasureF1,
      adjudicationPathAgreementRate: adjudicationSummary.averagePathAgreement,
      groups: buildGroupOverview(participants),
      pendingRatings: buildPendingRatings(store),
      pendingValidationReviews: buildPendingValidationReviews(store),
      pendingAdjudications: adjudicationSummary.pendingAdjudications,
      validationSummary,
      adjudicationSummary,
      dataQuality,
      analyzer,
    },
  });
});

app.get("/api/erhu/research/participants", async (req, res) => {
  const store = await readStudyStore();
  const participants = store.participants
    .map((participant) => buildParticipantSummary(participant, store))
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));
  return res.json({ ok: true, participants });
});

app.get("/api/erhu/research/data-quality", async (req, res) => {
  const store = await readStudyStore();
  return res.json({ ok: true, dataQuality: buildDataQualityOverview(store) });
});

app.get("/api/erhu/research/tasks", async (req, res) => {
  const store = await readStudyStore();
  const tasks = buildTaskExportRows(store).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return res.json({ ok: true, tasks });
});

app.get("/api/erhu/research/interviews", async (req, res) => {
  const store = await readStudyStore();
  const interviews = buildInterviewExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, interviews });
});

app.get("/api/erhu/research/questionnaires", async (req, res) => {
  const store = await readStudyStore();
  const questionnaires = buildQuestionnaireExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, questionnaires });
});

app.get("/api/erhu/research/expert-ratings", async (req, res) => {
  const store = await readStudyStore();
  const ratings = buildExpertRatingExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, ratings });
});

app.get("/api/erhu/research/validation-reviews", async (req, res) => {
  const store = await readStudyStore();
  const reviews = buildValidationReviewRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, reviews });
});

app.get("/api/erhu/research/validation-summary", async (req, res) => {
  const store = await readStudyStore();
  return res.json({
    ok: true,
    validationSummary: buildValidationSummary(store),
    pendingValidationReviews: buildPendingValidationReviews(store),
  });
});

app.get("/api/erhu/research/adjudications", async (req, res) => {
  const store = await readStudyStore();
  const adjudications = buildAdjudicationRows(store).sort((left, right) =>
    String(right.resolvedAt).localeCompare(String(left.resolvedAt)),
  );
  return res.json({ ok: true, adjudications });
});

app.get("/api/erhu/research/adjudication-summary", async (req, res) => {
  const store = await readStudyStore();
  return res.json({
    ok: true,
    adjudicationSummary: buildAdjudicationSummary(store),
  });
});

app.get("/api/erhu/research/pending-ratings", async (req, res) => {
  const store = await readStudyStore();
  return res.json({ ok: true, pendingRatings: buildPendingRatings(store) });
});

app.get("/api/erhu/research/templates", async (req, res) => {
  const templates = RESEARCH_TEMPLATE_LIBRARY.map((item) => ({
    templateId: item.templateId,
    title: item.title,
    filename: item.filename,
    description: item.description,
  }));
  return res.json({ ok: true, templates });
});

app.get("/api/erhu/research/templates/:templateId", async (req, res) => {
  const template = RESEARCH_TEMPLATE_LIBRARY.find((item) => item.templateId === req.params.templateId);
  if (!template) {
    return res.status(404).json({ error: "template not found." });
  }

  const format = safeString(req.query.format, "md").toLowerCase();
  const fileExt = format === "txt" ? "txt" : "md";
  res.setHeader("Content-Type", `text/${fileExt}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename=${template.filename.replace(/\.md$/i, `.${fileExt}`)}`);
  if (fileExt === "txt") {
    return res.send(template.content.replace(/^#+\s?/gm, ""));
  }
  return res.send(template.content);
});

app.post("/api/erhu/task-plan", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyTaskPlan(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/interview-note", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyInterviewNote(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/interview-sampling", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyInterviewSampling(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/validation-review", async (req, res) => {
  const payload = req.body || {};
  const analysisId = safeString(payload.analysisId).trim();
  const raterId = safeString(payload.raterId, "expert").trim();
  if (!analysisId) {
    return res.status(400).json({ error: "analysisId is required." });
  }
  if (!raterId) {
    return res.status(400).json({ error: "raterId is required." });
  }

  const store = await readStudyStore();
  let review = null;
  try {
    review = createValidationReview(store, { ...payload, raterId });
  } catch (error) {
    return res.status(404).json({ error: safeString(error?.message, "validation review failed.") });
  }

  const reviewIndex = getArray(store.validationReviews).findIndex(
    (item) => item.analysisId === review.analysisId && safeString(item.raterId) === safeString(review.raterId),
  );
  if (reviewIndex >= 0) {
    store.validationReviews[reviewIndex] = {
      ...store.validationReviews[reviewIndex],
      ...review,
      reviewId: store.validationReviews[reviewIndex].reviewId || review.reviewId,
    };
  } else {
    store.validationReviews.push(review);
  }

  await writeStudyStore(store);
  const participant = store.participants.find((item) => item.participantId === review.participantId) || null;
  return res.json({
    ok: true,
    review,
    participant: participant ? buildParticipantView(participant, store) : null,
    validationSummary: buildValidationSummary(store),
  });
});

app.post("/api/erhu/adjudication", async (req, res) => {
  const payload = req.body || {};
  const analysisId = safeString(payload.analysisId).trim();
  if (!analysisId) {
    return res.status(400).json({ error: "analysisId is required." });
  }

  const store = await readStudyStore();
  let adjudication = null;
  try {
    adjudication = createAdjudication(store, payload);
  } catch (error) {
    return res.status(400).json({ error: safeString(error?.message, "adjudication failed.") });
  }

  const adjudicationIndex = getArray(store.adjudications).findIndex((item) => item.analysisId === adjudication.analysisId);
  if (adjudicationIndex >= 0) {
    store.adjudications[adjudicationIndex] = {
      ...store.adjudications[adjudicationIndex],
      ...adjudication,
      adjudicationId: store.adjudications[adjudicationIndex].adjudicationId || adjudication.adjudicationId,
    };
  } else {
    store.adjudications.push(adjudication);
  }

  await writeStudyStore(store);
  const participant = store.participants.find((item) => item.participantId === adjudication.participantId) || null;
  return res.json({
    ok: true,
    adjudication,
    participant: participant ? buildParticipantView(participant, store) : null,
    adjudicationSummary: buildAdjudicationSummary(store),
  });
});

app.post("/api/erhu/research/batch-participants", async (req, res) => {
  const entries = getArray(req.body?.participants);
  if (!entries.length) {
    return res.status(400).json({ error: "participants array is required." });
  }

  const store = await readStudyStore();
  const imported = [];

  entries.forEach((entry) => {
    const participantId = safeString(entry.participantId).trim();
    if (!participantId) return;
    const participant = ensureParticipantRecord(store, participantId, safeString(entry.groupId, "experimental"));
    if (entry.profile && typeof entry.profile === "object") {
      participant.profile = {
        alias: safeString(entry.profile.alias, participant.profile?.alias || ""),
        institution: safeString(entry.profile.institution, participant.profile?.institution || ""),
        major: safeString(entry.profile.major, participant.profile?.major || ""),
        grade: safeString(entry.profile.grade, participant.profile?.grade || ""),
        yearsOfTraining: clamp(safeNumber(entry.profile.yearsOfTraining, participant.profile?.yearsOfTraining || 0), 0, 80),
        weeklyPracticeMinutes: clamp(
          safeNumber(entry.profile.weeklyPracticeMinutes, participant.profile?.weeklyPracticeMinutes || 0),
          0,
          10080,
        ),
        deviceLabel: safeString(entry.profile.deviceLabel, participant.profile?.deviceLabel || ""),
        consentSigned: safeBoolean(entry.profile.consentSigned, participant.profile?.consentSigned || false),
        notes: safeString(entry.profile.notes, participant.profile?.notes || ""),
        updatedAt: nowIso(),
      };
      participant.lastActiveAt = participant.profile.updatedAt;
    }
    imported.push(buildParticipantSummary(participant, store));
  });

  await writeStudyStore(store);
  return res.json({ ok: true, importedCount: imported.length, participants: imported });
});

app.get("/api/erhu/research/export", async (req, res) => {
  const format = safeString(req.query.format, "json").toLowerCase();
  const dataset = safeString(req.query.dataset, "participants");
  const store = await readStudyStore();
  const payload = buildExportPayload(store, dataset);
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=erhu-study-${payload.dataset}.csv`);
    return res.send(convertRowsToCsv(payload.headers, payload.rows));
  }
  return res.json({ ok: true, dataset: payload.dataset, rows: payload.rows, store });
});

app.use("/data", express.static(DATA_DIR));
app.use(express.static(DIST_DIR));

app.get(/.*/, async (req, res) => {
  try {
    await fs.access(path.join(DIST_DIR, "index.html"));
    res.sendFile(path.join(DIST_DIR, "index.html"));
  } catch {
    res.status(404).send("dist/index.html not found. Run `npm run build` first.");
  }
});

app.listen(port, () => {
  console.log(`AI Erhu prototype listening on http://localhost:${port}`);
});
