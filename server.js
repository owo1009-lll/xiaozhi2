import "dotenv/config";
import express from "express";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { getErhuPiece, getErhuPieceSummaries, getErhuSection } from "./src/erhuStudyPieces.js";
import {
  clamp,
  createId,
  firstPositiveNumber,
  getArray,
  hashJson,
  medianNumber,
  normalizeStringList,
  nowIso,
  nullableInteger,
  nullableRatio,
  parseTimestampMs,
  repairMojibakeText,
  safeBoolean,
  safeNumber,
  safeString,
  sha1,
} from "./src/server/baseUtils.js";
import {
  atomicWriteJson,
  enqueueStoreOperation,
  readJsonFileUnlocked,
  waitForStoreOperations,
} from "./src/server/jsonStore.js";
import {
  compactScoreStoreForWrite,
  readScoreStoreLimits,
  writeScoreStoreArchive,
} from "./src/server/scoreStoreSupport.js";
import {
  readScoreStoreFromSqlite,
  summarizeScoreStoreSqlite,
  upsertScoreImportJobInSqlite,
  writeScoreStoreToSqlite,
} from "./src/server/scoreStoreSqlite.js";
import {
  buildCachedImportPreviewPages,
  buildReusedOmrStats,
  buildOmrQualityGate,
  calibrateOmrConfidence,
  normalizeOmrStats,
} from "./src/server/omrStats.js";
import {
  annotateImportedSectionsScoreLineRoles,
  buildScoreLineStatsFromNotes,
  buildScoreLineStatsFromSections,
  effectiveSelectedPartConfidence,
  getSelectedPartCandidate,
  hasAccompanimentPartCandidate,
  isCleanSoloSelectedPart,
  isExplicitErhuPartCandidate,
} from "./src/server/scoreLineRoles.js";
import {
  buildAudioSubmissionFromUpload,
  buildPreparedAudioPayload,
  normalizePreparedPayloadForAnalyzer,
  parseIncomingPayload,
  persistPayloadAudio,
  persistUploadedAudioFile,
} from "./src/server/audioPayload.js";
import {
  buildScorePhotoSubmissionFromUpload,
  persistPayloadScorePhoto,
  persistUploadedScorePhotoFile,
} from "./src/server/scorePhotoPayload.js";
import { createAnalyzerClient } from "./src/server/analyzerClient.js";
import { createTaskGate, queueFullPayload } from "./src/server/taskQueue.js";
import { createAnalysisRouter } from "./src/server/analysisRoutes.js";
import { createOpsRouter } from "./src/server/opsRoutes.js";
import { createResearchRouter } from "./src/server/researchRoutes.js";
import { createScoreRouter } from "./src/server/scoreRoutes.js";
import { createTeacherValidationService } from "./src/server/teacherValidationService.js";
import { createTeacherValidationRouter } from "./src/server/teacherValidationRoutes.js";
import { createWesternStringsRouter } from "./src/server/westernStringsRoutes.js";
import { createPublicAccessGuard } from "./src/server/publicAccessGuard.js";
import { createWechatContentSafetyService } from "./src/server/wechatContentSafety.js";
import {
  appendAnalysisToParticipant,
  buildValidationSummary,
  createValidationReview,
  ensureParticipantRecord,
  normalizeAdjudicationRecord,
  normalizeInterviewRecord,
  normalizeParticipantRecord,
  normalizeTaskPlanRecord,
  normalizeValidationReview,
} from "./src/server/researchService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.ERHU_DATA_DIR ? path.resolve(process.env.ERHU_DATA_DIR) : path.join(__dirname, "data");
const STUDY_STORE_FILE = path.join(DATA_DIR, "erhu-study-records.json");
const SCORE_STORE_FILE = path.join(DATA_DIR, "erhu-score-imports.json");
const SCORE_STORE_BACKEND = safeString(process.env.ERHU_SCORE_STORE_BACKEND, "auto").toLowerCase();
const SCORE_STORE_SQLITE_FILE = process.env.ERHU_SCORE_STORE_SQLITE_FILE
  ? path.resolve(process.env.ERHU_SCORE_STORE_SQLITE_FILE)
  : path.join(DATA_DIR, "erhu-score-imports.sqlite");
const ANALYSIS_JOB_STORE_FILE = path.join(DATA_DIR, "erhu-analysis-jobs.json");
const PIECE_PASS_JOB_STORE_FILE = path.join(DATA_DIR, "erhu-piece-pass-jobs.json");
const SCORE_IMPORTS_DIR = path.join(DATA_DIR, "score-imports");
const PIECE_PASS_DIR = path.join(DATA_DIR, "piece-pass");
const TEACHER_VALIDATION_PACKS_DIR = path.join(DATA_DIR, "teacher-validation", "packs");
const AUDIO_CACHE_DIR = path.join(DATA_DIR, "analysis-audio-cache");
const SCORE_PHOTO_CACHE_DIR = path.join(DATA_DIR, "analysis-score-photo-cache");
const wechatContentSafetyService = createWechatContentSafetyService({
  dataDir: DATA_DIR,
  scorePhotoCacheDir: SCORE_PHOTO_CACHE_DIR,
});
const SECTION_DETECTION_CACHE_DIR = path.join(DATA_DIR, "section-detection-cache");
const SECTION_ANALYSIS_CACHE_DIR = path.join(DATA_DIR, "section-analysis-cache");
const PERF_TRACE_FILE = path.join(DATA_DIR, "perf-trace.log");
const ASCII_RUNTIME_ROOT = path.join(path.dirname(__dirname), "ai_erhu_runtime");
const DIST_DIR = path.join(__dirname, "dist");
const STORE_ARCHIVE_DIR = path.join(DATA_DIR, "store-archive");
const SCORE_STORE_LIMITS = readScoreStoreLimits(process.env);
const upload = multer({
  storage: multer.memoryStorage(),
  // A 10 MB image becomes about 13.4 MB when the Mini Program sends it as a
  // base64 field alongside the audio multipart upload.
  limits: { fileSize: 40 * 1024 * 1024, fieldSize: 14 * 1024 * 1024 },
});
const SCORE_IMPORT_TASK_GATE = createTaskGate({
  name: "score-import",
  concurrency: safeNumber(process.env.ERHU_SCORE_IMPORT_CONCURRENCY, 1),
  maxPending: safeNumber(process.env.ERHU_SCORE_IMPORT_MAX_PENDING, 6),
});
const ANALYSIS_TASK_GATE = createTaskGate({
  name: "analysis",
  concurrency: safeNumber(process.env.ERHU_ANALYSIS_JOB_CONCURRENCY, 2),
  maxPending: safeNumber(process.env.ERHU_ANALYSIS_JOB_MAX_PENDING, 12),
});
const PIECE_PASS_TASK_GATE = createTaskGate({
  name: "piece-pass",
  concurrency: safeNumber(process.env.ERHU_PIECE_PASS_JOB_CONCURRENCY, 1),
  maxPending: safeNumber(process.env.ERHU_PIECE_PASS_JOB_MAX_PENDING, 3),
});
const teacherValidationService = createTeacherValidationService({
  packsDir: TEACHER_VALIDATION_PACKS_DIR,
  repoRoot: __dirname,
  dataDir: DATA_DIR,
  asciiRuntimeRoot: ASCII_RUNTIME_ROOT,
  readScoreStore,
  readStudyStore,
  writeStudyStore,
  ensureParticipantRecord,
  createValidationReview,
  buildValidationSummary,
});

app.use(express.json({ limit: "120mb" }));

// When exposed to the internet through the Cloudflare tunnel, only the student
// endpoints may answer public traffic; the full backend stays local-only.
app.use(createPublicAccessGuard({
  publicMode: safeBoolean(process.env.WESTERN_PUBLIC_MODE, false),
  allowOrigins: safeString(process.env.WESTERN_PUBLIC_ORIGIN),
}));

function scoreStoreUsesSqlite() {
  if (SCORE_STORE_BACKEND === "sqlite" || SCORE_STORE_BACKEND === "sqlite3") return true;
  return SCORE_STORE_BACKEND === "auto" && fsSync.existsSync(SCORE_STORE_SQLITE_FILE);
}

let runtimeAliasReady = false;
let runtimeAliasFailed = false;

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

const {
  callExternalAnalyzer,
  callExternalScoreImport,
  callExternalScoreImportLongTimeout,
  callExternalMusicXmlImportLongTimeout,
  callExternalMidiImportLongTimeout,
  callExternalAnalyzerLongTimeout,
  callExternalSectionRankLongTimeout,
  callPatchTempos,
} = createAnalyzerClient({ env: process.env, toAnalyzerPath, appendPerfTrace });

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

function separationQualityFields(source = {}, { confidenceFallback = 0, modeFallback = "" } = {}) {
  const diagnostics = source?.diagnostics && typeof source.diagnostics === "object" ? source.diagnostics : {};
  const pick = (key, fallback = null) => (
    source?.[key] !== undefined
      ? source[key]
      : diagnostics?.[key] !== undefined
        ? diagnostics[key]
        : fallback
  );
  const confidence = safeNumber(pick("separationConfidence"), confidenceFallback);
  return {
    separationApplied: safeBoolean(pick("separationApplied"), false),
    separationMode: safeString(pick("separationMode", pick("appliedPreprocessMode", modeFallback))),
    separationConfidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : null,
    separationEnergyRatio: nullableRatio(pick("separationEnergyRatio")),
    separationScoreBandRatio: nullableRatio(pick("separationScoreBandRatio")),
    separationConfidentPitchCount: nullableInteger(pick("separationConfidentPitchCount")),
    separationScoreBandHitCount: nullableInteger(pick("separationScoreBandHitCount")),
  };
}

function normalizeMarkingItem(item = {}, fallback = {}) {
  const measureIndex = Math.max(1, Math.round(safeNumber(item?.measureIndex, fallback.measureIndex || 1)));
  const pageNumber = Math.max(1, Math.round(safeNumber(item?.pageNumber, fallback.pageNumber || 1)));
  return {
    type: safeString(item?.type, fallback.type),
    text: repairMojibakeText(item?.text || item?.dynamic || item?.wedgeType || fallback.text || ""),
    measureIndex,
    beatStart: Math.max(0, safeNumber(item?.beatStart, 0)),
    pageNumber,
    sectionId: safeString(item?.sectionId, fallback.sectionId),
    placement: safeString(item?.placement),
    tempo: safeNumber(item?.tempo, null),
    dynamic: safeString(item?.dynamic),
    dynamicValue: safeNumber(item?.dynamicValue, null),
    wedgeType: safeString(item?.wedgeType),
    direction: safeString(item?.direction),
    times: safeString(item?.times),
    localMeasureIndex: nullableInteger(item?.localMeasureIndex) || undefined,
    measureNumberSource: safeString(item?.measureNumberSource),
  };
}

function normalizeMarkingList(items = [], fallback = {}) {
  return getArray(items)
    .map((item) => normalizeMarkingItem(item, fallback))
    .filter((item) => item.type || item.text || item.tempo || item.dynamic || item.direction);
}

function buildMarkingStatsFromSections(sections = []) {
  return getArray(sections).reduce(
    (acc, section) => {
      acc.markingCount += getArray(section?.markings).length;
      acc.tempoChangeCount += getArray(section?.tempoChanges).length;
      acc.dynamicChangeCount += getArray(section?.dynamicChanges).length;
      acc.repeatCount += getArray(section?.repeatStructure).length;
      return acc;
    },
    { markingCount: 0, tempoChangeCount: 0, dynamicChangeCount: 0, repeatCount: 0 },
  );
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

function buildJobTiming(job = {}) {
  const startedMs = parseTimestampMs(job.createdAt);
  const updatedMs = parseTimestampMs(job.updatedAt) || startedMs;
  const completedMs = parseTimestampMs(job.completedAt);
  const referenceMs = completedMs || Date.now();
  const elapsedMs = startedMs ? Math.max(0, referenceMs - startedMs) : 0;
  const stalledMs = job.status === "processing" && updatedMs ? Math.max(0, Date.now() - updatedMs) : 0;
  return { elapsedMs, stalledMs };
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
              scoreLineRole: safeString(note?.notePosition?.scoreLineRole),
              scoreLineConfidence: clamp(safeNumber(note?.notePosition?.scoreLineConfidence, 0), 0, 1),
              scoreLineSource: safeString(note?.notePosition?.scoreLineSource),
              scoreLineId: safeString(note?.notePosition?.scoreLineId),
              localMeasureIndex: nullableInteger(note?.notePosition?.localMeasureIndex) || undefined,
              globalMeasureIndex: nullableInteger(note?.notePosition?.globalMeasureIndex) || undefined,
              measureNumberSource: safeString(note?.notePosition?.measureNumberSource),
              localNoteId: safeString(note?.notePosition?.localNoteId),
            }
          : null;
      return {
        noteId,
        measureIndex,
        beatStart,
        beatDuration,
        midiPitch,
        notePosition,
        articulations: normalizeStringList(note?.articulations),
        notations: normalizeStringList(note?.notations),
        techniques: normalizeStringList(note?.techniques),
        activeTempo: clamp(safeNumber(note?.activeTempo, piecePack.tempo || fallback.tempo || 72), 30, 300),
        activeDynamic: safeString(note?.activeDynamic),
        dynamicValue: safeNumber(note?.dynamicValue, null),
      };
    })
    .filter((note) => note.noteId);

  if (!notes.length) return null;

  return {
    pieceId: safeString(piecePack.pieceId, fallback.pieceId || "manual-pdf-piece") || fallback.pieceId || "manual-pdf-piece",
    sectionId: safeString(piecePack.sectionId, fallback.sectionId || "manual-section") || fallback.sectionId || "manual-section",
    title: safeString(piecePack.title, fallback.title || "PDF 手工录入片段") || fallback.title || "PDF 手工录入片段",
    composer: safeString(piecePack.composer, fallback.composer),
    instrument: safeString(piecePack.instrument, fallback.instrument),
    scoreSourceType: safeString(piecePack.scoreSourceType, fallback.scoreSourceType || fallback.scoreSource),
    tempoKnown: safeBoolean(piecePack.tempoKnown, safeBoolean(fallback.tempoKnown, false)),
    tempoSource: safeString(piecePack.tempoSource, fallback.tempoSource),
    targetSkills: getArray(piecePack.targetSkills).map((item) => safeString(item).trim()).filter(Boolean),
    difficulty: safeString(piecePack.difficulty, fallback.difficulty),
    tempo: clamp(safeNumber(piecePack.tempo, fallback.tempo || 72), 30, 220),
    meter: safeString(piecePack.meter, fallback.meter || "4/4") || fallback.meter || "4/4",
    demoAudio: safeString(piecePack.demoAudio, fallback.demoAudio),
    pageImagePath: safeString(piecePack.pageImagePath, fallback.pageImagePath),
    markings: normalizeMarkingList(piecePack.markings, { sectionId: piecePack.sectionId || fallback.sectionId }),
    tempoChanges: normalizeMarkingList(piecePack.tempoChanges, { type: "tempo", sectionId: piecePack.sectionId || fallback.sectionId }),
    dynamicChanges: normalizeMarkingList(piecePack.dynamicChanges, { type: "dynamic", sectionId: piecePack.sectionId || fallback.sectionId }),
    repeatStructure: normalizeMarkingList(piecePack.repeatStructure, { type: "repeat", sectionId: piecePack.sectionId || fallback.sectionId }),
    notes,
    noteCount: notes.length,
    measureCount: Math.max(...notes.map((note) => note.measureIndex)),
    scoreSource: piecePack.scoreSource && typeof piecePack.scoreSource === "object" ? piecePack.scoreSource : null,
  };
}


async function readStudyStore() {
  await waitForStoreOperations(STUDY_STORE_FILE);
  return readStudyStoreUnlocked();
}

async function readStudyStoreUnlocked() {
  const parsed = await readJsonFileUnlocked(STUDY_STORE_FILE, {});
  return {
    participants: Array.isArray(parsed.participants) ? parsed.participants.map((item) => normalizeParticipantRecord(item)) : [],
    analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
    validationReviews: Array.isArray(parsed.validationReviews) ? parsed.validationReviews.map((item) => normalizeValidationReview(item)) : [],
    adjudications: Array.isArray(parsed.adjudications) ? parsed.adjudications.map((item) => normalizeAdjudicationRecord(item)) : [],
  };
}

async function writeStudyStore(store) {
  await enqueueStoreOperation(STUDY_STORE_FILE, async () => {
    const current = await readStudyStoreUnlocked();
    await writeStudyStoreUnlocked(mergeStudyStores(current, store));
  });
}

async function writeStudyStoreUnlocked(store) {
  await atomicWriteJson(STUDY_STORE_FILE, store);
}

function newestTimestamp(...values) {
  return values
    .map((value) => safeString(value))
    .filter(Boolean)
    .sort((left, right) => String(right).localeCompare(String(left)))[0] || "";
}

function pickNewestRecord(current, incoming, timestampFields = []) {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentStamp = newestTimestamp(...timestampFields.map((field) => current?.[field]));
  const incomingStamp = newestTimestamp(...timestampFields.map((field) => incoming?.[field]));
  return !currentStamp || incomingStamp >= currentStamp ? incoming : current;
}

function mergeRecordsByKey(currentList = [], incomingList = [], keyForItem, normalizeItem = (item) => item, timestampFields = []) {
  const records = new Map();
  const append = (item, preferIncoming = true) => {
    const normalized = normalizeItem(item);
    const key = safeString(keyForItem(normalized));
    if (!key) return;
    const existing = records.get(key);
    if (!existing) {
      records.set(key, normalized);
      return;
    }
    records.set(key, preferIncoming ? pickNewestRecord(existing, normalized, timestampFields) : existing);
  };
  getArray(currentList).forEach((item) => append(item, false));
  getArray(incomingList).forEach((item) => append(item, true));
  return Array.from(records.values());
}

function sortRecordsByNewest(records = [], timestampFields = []) {
  return getArray(records).sort((left, right) =>
    newestTimestamp(...timestampFields.map((field) => right?.[field])).localeCompare(
      newestTimestamp(...timestampFields.map((field) => left?.[field])),
    ),
  );
}

function mergeStudyParticipants(currentParticipant, incomingParticipant) {
  const current = currentParticipant ? normalizeParticipantRecord(currentParticipant) : null;
  const incoming = incomingParticipant ? normalizeParticipantRecord(incomingParticipant) : null;
  if (!current) return incoming;
  if (!incoming) return current;

  const questionnaires = sortRecordsByNewest(
    mergeRecordsByKey(
      current.questionnaires,
      incoming.questionnaires,
      (item) => safeString(item.questionnaireId) || safeString(item.sessionStage),
      (item) => item,
      ["submittedAt"],
    ),
    ["submittedAt"],
  ).slice(0, 24);

  const weeklySessions = sortRecordsByNewest(
    mergeRecordsByKey(
      current.weeklySessions,
      incoming.weeklySessions,
      (item) => safeString(item.analysisId) || [safeString(item.stage), safeString(item.audioHash), safeString(item.at)].join("::"),
      (item) => item,
      ["at"],
    ),
    ["at"],
  ).slice(0, 24);

  const usageLogs = sortRecordsByNewest(
    mergeRecordsByKey(
      current.usageLogs,
      incoming.usageLogs,
      (item) => safeString(item.analysisId) || [safeString(item.pieceId), safeString(item.audioHash), safeString(item.at)].join("::"),
      (item) => item,
      ["at"],
    ),
    ["at"],
  ).slice(0, 100);

  const taskPlans = sortRecordsByNewest(
    mergeRecordsByKey(
      current.taskPlans,
      incoming.taskPlans,
      (item) => safeString(item.taskId) || safeString(item.stage),
      normalizeTaskPlanRecord,
      ["updatedAt", "createdAt"],
    ),
    ["updatedAt", "createdAt"],
  ).slice(0, 48);

  const interviews = sortRecordsByNewest(
    mergeRecordsByKey(
      current.interviews,
      incoming.interviews,
      (item) => safeString(item.interviewId) || [safeString(item.stage), safeString(item.interviewerId)].join("::"),
      normalizeInterviewRecord,
      ["submittedAt"],
    ),
    ["submittedAt"],
  ).slice(0, 24);

  const expertWeekly = sortRecordsByNewest(
    mergeRecordsByKey(
      current.expertRatings?.weekly,
      incoming.expertRatings?.weekly,
      (item) => safeString(item.ratingId) || [safeString(item.stage), safeString(item.raterId)].join("::"),
      (item) => item,
      ["submittedAt"],
    ),
    ["submittedAt"],
  ).slice(0, 24);

  const experienceScales = pickNewestRecord(
    pickNewestRecord(current.experienceScales, incoming.experienceScales, ["submittedAt"]),
    questionnaires[0] || null,
    ["submittedAt"],
  );

  return normalizeParticipantRecord({
    ...current,
    ...incoming,
    createdAt: current.createdAt && incoming.createdAt
      ? (String(current.createdAt).localeCompare(String(incoming.createdAt)) <= 0 ? current.createdAt : incoming.createdAt)
      : current.createdAt || incoming.createdAt,
    lastActiveAt: newestTimestamp(current.lastActiveAt, incoming.lastActiveAt),
    profile: pickNewestRecord(current.profile, incoming.profile, ["updatedAt"]),
    pretest: pickNewestRecord(current.pretest, incoming.pretest, ["at"]),
    posttest: pickNewestRecord(current.posttest, incoming.posttest, ["at"]),
    weeklySessions,
    experienceScales,
    questionnaires,
    usageLogs,
    taskPlans,
    interviews,
    interviewSampling: pickNewestRecord(current.interviewSampling, incoming.interviewSampling, ["updatedAt"]),
    expertRatings: {
      pretest: pickNewestRecord(current.expertRatings?.pretest, incoming.expertRatings?.pretest, ["submittedAt"]),
      posttest: pickNewestRecord(current.expertRatings?.posttest, incoming.expertRatings?.posttest, ["submittedAt"]),
      weekly: expertWeekly,
    },
  });
}

function mergeStudyStores(currentStore = {}, incomingStore = {}) {
  const participants = mergeRecordsByKey(
    currentStore.participants,
    incomingStore.participants,
    (item) => safeString(item.participantId),
    (item) => normalizeParticipantRecord(item),
    ["lastActiveAt", "createdAt"],
  );
  const participantById = new Map(participants.map((item) => [item.participantId, item]));
  getArray(currentStore.participants).forEach((participant) => {
    const participantId = safeString(participant.participantId);
    if (participantId) participantById.set(participantId, normalizeParticipantRecord(participant));
  });
  getArray(incomingStore.participants).forEach((participant) => {
    const participantId = safeString(participant.participantId);
    if (!participantId) return;
    participantById.set(participantId, mergeStudyParticipants(participantById.get(participantId), participant));
  });

  return {
    participants: sortRecordsByNewest(Array.from(participantById.values()), ["lastActiveAt", "createdAt"]),
    analyses: sortRecordsByNewest(
      mergeRecordsByKey(
        currentStore.analyses,
        incomingStore.analyses,
        (item) => safeString(item.analysisId),
        (item) => item,
        ["updatedAt", "completedAt", "createdAt"],
      ),
      ["updatedAt", "completedAt", "createdAt"],
    ),
    validationReviews: sortRecordsByNewest(
      mergeRecordsByKey(
        currentStore.validationReviews,
        incomingStore.validationReviews,
        (item) => [safeString(item.analysisId), safeString(item.raterId, "expert")].join("::"),
        normalizeValidationReview,
        ["submittedAt"],
      ),
      ["submittedAt"],
    ),
    adjudications: sortRecordsByNewest(
      mergeRecordsByKey(
        currentStore.adjudications,
        incomingStore.adjudications,
        (item) => safeString(item.analysisId),
        normalizeAdjudicationRecord,
        ["resolvedAt"],
      ),
      ["resolvedAt"],
    ),
  };
}

async function readScoreStore() {
  await waitForStoreOperations(SCORE_STORE_FILE);
  return readScoreStoreUnlocked();
}

async function readScoreStoreUnlocked() {
  if (scoreStoreUsesSqlite()) {
    const parsed = readScoreStoreFromSqlite(SCORE_STORE_SQLITE_FILE);
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((item) => normalizeScoreImportJob(item)) : [],
      scores: Array.isArray(parsed.scores) ? parsed.scores.map((item) => normalizeImportedScoreRecord(item)) : [],
    };
  }
  const parsed = await readJsonFileUnlocked(SCORE_STORE_FILE, {});
  return {
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((item) => normalizeScoreImportJob(item)) : [],
    scores: Array.isArray(parsed.scores) ? parsed.scores.map((item) => normalizeImportedScoreRecord(item)) : [],
  };
}

async function writeScoreStore(store) {
  await enqueueStoreOperation(SCORE_STORE_FILE, () => writeScoreStoreUnlocked(store));
}

async function writeScoreStoreUnlocked(store) {
  const compacted = compactScoreStoreForWrite(store, {
    limits: SCORE_STORE_LIMITS,
    normalizeScoreImportJob,
    normalizeImportedScoreRecord,
    normalizeSearchText,
  });
  await writeScoreStoreArchive(compacted.archive, {
    archiveDir: STORE_ARCHIVE_DIR,
    atomicWriteJson,
  });
  if (scoreStoreUsesSqlite()) {
    writeScoreStoreToSqlite(SCORE_STORE_SQLITE_FILE, compacted.store, {
      archive: compacted.archive,
    });
    return;
  }
  await atomicWriteJson(SCORE_STORE_FILE, compacted.store, { pretty: false });
}

async function readAnalysisJobStore() {
  await waitForStoreOperations(ANALYSIS_JOB_STORE_FILE);
  return readAnalysisJobStoreUnlocked();
}

async function readAnalysisJobStoreUnlocked() {
  const parsed = await readJsonFileUnlocked(ANALYSIS_JOB_STORE_FILE, {});
  return {
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((item) => normalizeAnalysisJob(item)) : [],
  };
}

async function writeAnalysisJobStore(store) {
  await enqueueStoreOperation(ANALYSIS_JOB_STORE_FILE, () => writeAnalysisJobStoreUnlocked(store));
}

async function writeAnalysisJobStoreUnlocked(store) {
  await atomicWriteJson(ANALYSIS_JOB_STORE_FILE, store);
}

async function readPiecePassJobStore() {
  await waitForStoreOperations(PIECE_PASS_JOB_STORE_FILE);
  return readPiecePassJobStoreUnlocked();
}

async function readPiecePassJobStoreUnlocked() {
  const parsed = await readJsonFileUnlocked(PIECE_PASS_JOB_STORE_FILE, {});
  return {
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((item) => normalizePiecePassJob(item)) : [],
  };
}

async function writePiecePassJobStore(store) {
  await enqueueStoreOperation(PIECE_PASS_JOB_STORE_FILE, () => writePiecePassJobStoreUnlocked(store));
}

async function writePiecePassJobStoreUnlocked(store) {
  await atomicWriteJson(PIECE_PASS_JOB_STORE_FILE, store);
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

function getPiecePassSummaryReliability(summary = {}) {
  const attempted = Math.max(0, Math.round(safeNumber(summary?.attemptedSectionCount, 0)));
  const matched = Math.max(0, Math.round(safeNumber(summary?.matchedSectionCount, 0)));
  const failed = Math.max(0, Math.round(safeNumber(summary?.failedSectionCount, 0)));
  const timedOut = Math.max(0, Math.round(safeNumber(summary?.timedOutSectionCount, 0)));
  const completeness = attempted > 0 ? matched / attempted : safeNumber(summary?.analysisCompletenessRatio, 0);
  const complete = matched > 0 && failed === 0 && timedOut === 0 && (!attempted || matched >= attempted);
  const reliable = complete || (
    safeBoolean(summary?.analysisReliable, false)
    && matched > 0
    && failed === 0
    && timedOut === 0
    && completeness >= 0.98
  );
  return { complete, reliable, attempted, matched, failed, timedOut, completeness };
}

async function readLatestPiecePassSummary({ pieceId = "", scoreId = "", title = "", audioHash = "", participantId = "" } = {}) {
  const normalizedPieceId = normalizeSearchText(pieceId);
  const normalizedScoreId = normalizeSearchText(scoreId);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedAudioHash = safeString(audioHash).trim();
  const normalizedParticipantId = safeString(participantId).trim();
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
      const candidateScoreId = safeString(summary.scoreId, parsed.scoreId);
      const candidateTitle = safeString(summary.pieceTitle, parsed.pieceTitle);
      const candidateAudioHash = safeString(summary.audioHash, parsed.audioHash);
      const candidateParticipantId = safeString(summary.participantId, parsed.participantId);
      const normalizedCandidatePieceId = normalizeSearchText(candidatePieceId);
      const normalizedCandidateScoreId = normalizeSearchText(candidateScoreId);
      const normalizedCandidateTitle = normalizeSearchText(candidateTitle);
      const pieceMatch = normalizedPieceId && normalizedCandidatePieceId === normalizedPieceId;
      const scoreMatch = normalizedScoreId && (
        normalizedCandidateScoreId === normalizedScoreId
        || normalizedCandidatePieceId === normalizedScoreId
      );
      const titleMatch =
        normalizedTitle &&
        normalizedCandidateTitle &&
        (normalizedTitle.includes(normalizedCandidateTitle) || normalizedCandidateTitle.includes(normalizedTitle));

      if (normalizedAudioHash && candidateAudioHash !== normalizedAudioHash) {
        continue;
      }
      if (normalizedParticipantId && candidateParticipantId && candidateParticipantId !== normalizedParticipantId) {
        continue;
      }
      if (normalizedScoreId && !scoreMatch) {
        continue;
      }
      if (!normalizedScoreId && normalizedPieceId && !pieceMatch) {
        continue;
      }
      if (!normalizedScoreId && !normalizedPieceId && normalizedTitle && !titleMatch) {
        continue;
      }

      const stat = await fs.stat(filePath);
      const reliability = getPiecePassSummaryReliability(summary);
      candidates.push({
        filePath,
        stat,
        summary,
        reliability,
      });
    } catch {
      // ignore malformed piece-pass exports
    }
  }

  if (!candidates.length) return null;
  const newestMtime = Math.max(...candidates.map((item) => item.stat.mtimeMs));
  candidates.sort((left, right) => {
    if (left.reliability.complete !== right.reliability.complete) {
      return left.reliability.complete ? -1 : 1;
    }
    if (left.reliability.reliable !== right.reliability.reliable) {
      return left.reliability.reliable ? -1 : 1;
    }
    return right.stat.mtimeMs - left.stat.mtimeMs;
  });
  const latest = candidates[0];
  const skippedNewerIncompleteCount = candidates.filter((item) => (
    item.stat.mtimeMs > latest.stat.mtimeMs
    && !item.reliability.complete
  )).length;
  return {
    sourcePath: latest.filePath,
    updatedAt: new Date(latest.stat.mtimeMs).toISOString(),
    selectedComplete: latest.reliability.complete,
    selectedReliable: latest.reliability.reliable,
    ignoredNewerIncompleteCount: skippedNewerIncompleteCount,
    summary: {
      ...latest.summary,
      selectedComplete: latest.reliability.complete,
      selectedReliable: latest.reliability.reliable,
      ignoredNewerIncompleteCount: skippedNewerIncompleteCount,
      hasNewerIncompleteResult: skippedNewerIncompleteCount > 0,
      newestResultAt: new Date(newestMtime).toISOString(),
    },
  };
}

function normalizeSearchText(value) {
  return safeString(value)
    .toLowerCase()
    .replace(/[\s\-_（）()【】\[\]《》"“”'’.,，。:：/\\]+/g, "");
}

function normalizePartCandidates(candidates = []) {
  return getArray(candidates).map((item, index) => ({
    rank: Math.max(1, Math.round(safeNumber(item?.rank, index + 1))),
    id: safeString(item?.id),
    name: repairMojibakeText(item?.name || item?.label || `candidate-${index + 1}`),
    label: repairMojibakeText(item?.label || item?.name || `candidate-${index + 1}`),
    selectionKey: safeString(item?.selectionKey),
    qualifiedLabel: repairMojibakeText(item?.qualifiedLabel || item?.label || item?.name || `candidate-${index + 1}`),
    score: clamp(safeNumber(item?.score, 0), 0, 1),
    selectedPartConfidence: clamp(safeNumber(item?.selectedPartConfidence, item?.score || 0), 0, 1),
    noteCount: Math.max(0, Math.round(safeNumber(item?.noteCount, 0))),
    measureCount: Math.max(0, Math.round(safeNumber(item?.measureCount, 0))),
    staffCount: Math.max(0, Math.round(safeNumber(item?.staffCount, 0))),
    pitchRange: getArray(item?.pitchRange).map((value) => Math.round(safeNumber(value))).filter((value) => Number.isFinite(value)),
    erhuRangeRatio: clamp(safeNumber(item?.erhuRangeRatio, 0), 0, 1),
    chordRatio: clamp(safeNumber(item?.chordRatio, 0), 0, 1),
    isLikelyPiano: safeBoolean(item?.isLikelyPiano, false),
    isGenericVoice: safeBoolean(item?.isGenericVoice, false),
    isAfterExplicitPiano: safeBoolean(item?.isAfterExplicitPiano, false),
    isLikelyAccompanimentSplit: safeBoolean(item?.isLikelyAccompanimentSplit, false),
    safeForErhuProjection: safeBoolean(item?.safeForErhuProjection, false),
  }));
}

function normalizeImportedSections(sections = [], scoreFallback = {}) {
  const normalizedSections = getArray(sections)
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
      title: repairMojibakeText(normalized.title, normalized.sectionId || `section-${index + 1}`),
      displayIndex: index + 1,
      sequenceIndex: safeNumber(raw?.sequenceIndex, safeNumber(normalized.sequenceIndex, index + 1)) || index + 1,
      researchWindowHints: getArray(raw?.researchWindowHints).map((item) => safeNumber(item)).filter((item) => Number.isFinite(item)),
      sourceSectionId: safeString(raw?.sourceSectionId),
      measureRange: getArray(raw?.measureRange).map((item) => Math.round(safeNumber(item))).filter((item) => Number.isFinite(item)),
      measureNumbering: raw?.measureNumbering && typeof raw.measureNumbering === "object"
        ? {
            source: safeString(raw.measureNumbering.source),
            pageIndex: nullableInteger(raw.measureNumbering.pageIndex),
            firstGlobalMeasure: nullableInteger(raw.measureNumbering.firstGlobalMeasure),
            lastGlobalMeasure: nullableInteger(raw.measureNumbering.lastGlobalMeasure),
            localMeasureCount: nullableInteger(raw.measureNumbering.localMeasureCount),
          }
        : undefined,
      pageImagePath: safeString(raw?.pageImagePath, normalized.pageImagePath),
      instrument: safeString(raw?.instrument, scoreFallback?.instrument),
      scoreSourceType: safeString(raw?.scoreSourceType, scoreFallback?.scoreSource),
      tempoKnown: safeBoolean(raw?.tempoKnown, safeBoolean(scoreFallback?.tempoKnown, false)),
      tempoSource: safeString(raw?.tempoSource, scoreFallback?.tempoSource),
      selectedPart: safeString(raw?.selectedPart, scoreFallback?.selectedPart),
      selectedPartId: safeString(raw?.selectedPartId),
      selectedPartConfidence: clamp(safeNumber(raw?.selectedPartConfidence, 0), 0, 1),
      erhuProjectionMode: safeString(raw?.erhuProjectionMode),
      erhuProjectionReason: safeString(raw?.erhuProjectionReason),
      partCandidates: normalizePartCandidates(raw?.partCandidates),
      scoreLineStats: raw?.scoreLineStats && typeof raw.scoreLineStats === "object" ? raw.scoreLineStats : undefined,
    }));
  return annotateImportedSectionsScoreLineRoles(normalizedSections, scoreFallback);
}

function normalizeImportedScoreRecord(score = {}) {
  let sections = normalizeImportedSections(score.sections, {
    pieceId: safeString(score.pieceId),
    title: repairMojibakeText(score.title),
    composer: safeString(score.composer),
    selectedPart: safeString(score.selectedPart, score.piecePack?.selectedPart || "erhu"),
    selectedPartId: safeString(score.selectedPartId),
    partCandidates: getArray(score.partCandidates || score.piecePack?.partCandidates),
  });
  sections = applyLegacyPagewiseMeasureNumbers(sections, score);
  const normalizedOmrStats = normalizeOmrStats(score.omrStats);
  const computedScoreLineStats = buildScoreLineStatsFromSections(sections);
  const scoreLineStats =
    score.scoreLineStats && typeof score.scoreLineStats === "object"
      ? { ...score.scoreLineStats, ...computedScoreLineStats }
      : computedScoreLineStats;
  const omrConfidence = calibrateOmrConfidence(score.omrConfidence, normalizedOmrStats, {
    omrStatus: safeString(score.omrStatus, "completed"),
    sectionCount: sections.length,
  });
  const selectedPartConfidence = effectiveSelectedPartConfidence(
    safeNumber(score.selectedPartConfidence, safeNumber(score.piecePack?.selectedPartConfidence, 0)),
    sections,
  );
  const partCandidates = normalizePartCandidates(score.partCandidates || score.piecePack?.partCandidates);
  const omrQualityGate = buildOmrQualityGate({
    omrStatus: safeString(score.omrStatus, "completed"),
    omrConfidence,
    omrStats: normalizedOmrStats,
    selectedPartConfidence,
    scoreLineStats,
    partCandidates,
    sectionCount: sections.length,
    selectedPartConfirmed: safeBoolean(score.selectedPartConfirmed, false),
  });
  return {
    scoreId: safeString(score.scoreId),
    pieceId: safeString(score.pieceId),
    title: repairMojibakeText(score.title, "未命名曲谱"),
    composer: safeString(score.composer),
    instrument: safeString(score.instrument, score.piecePack?.instrument),
    scoreSource: safeString(score.scoreSource, score.piecePack?.scoreSourceType),
    tempoKnown: safeBoolean(score.tempoKnown, safeBoolean(score.piecePack?.tempoKnown, false)),
    tempoSource: safeString(score.tempoSource, score.piecePack?.tempoSource),
    sourcePdfPath: safeString(score.sourcePdfPath),
    pdfHash: safeString(score.pdfHash),
    musicxmlPath: safeString(score.musicxmlPath),
    omrStatus: safeString(score.omrStatus, "completed"),
    omrConfidence,
    omrStats: { ...normalizedOmrStats, qualityGate: omrQualityGate },
    detectedParts: getArray(score.detectedParts).map((item) => safeString(item)).filter(Boolean),
    selectedPart: safeString(score.selectedPart, "erhu"),
    selectedPartId: safeString(score.selectedPartId),
    selectedPartConfirmed: safeBoolean(score.selectedPartConfirmed, false),
    selectedPartConfidence,
    partCandidates,
    markingStats: {
      ...buildMarkingStatsFromSections(sections),
      ...(score.markingStats && typeof score.markingStats === "object" ? score.markingStats : {}),
    },
    scoreLineStats,
    previewPages: getArray(score.previewPages),
    sections,
    createdAt: safeString(score.createdAt, nowIso()),
    updatedAt: safeString(score.updatedAt, score.createdAt || nowIso()),
  };
}

function parsePagewiseSectionPage(section = {}) {
  const sectionText = `${safeString(section.sectionId)} ${safeString(section.sourceSectionId)}`;
  const sectionMatch = sectionText.match(/\bpage-(\d+)/i);
  if (sectionMatch) return Math.max(1, Math.round(safeNumber(sectionMatch[1], 1)));
  const notePage = getArray(section.notes)
    .map((note) => safeNumber(note?.notePosition?.pageNumber, NaN))
    .find((value) => Number.isFinite(value) && value > 0);
  if (Number.isFinite(notePage)) return Math.max(1, Math.round(notePage));
  const numberingPage = safeNumber(section?.measureNumbering?.pageIndex, NaN);
  return Number.isFinite(numberingPage) && numberingPage > 0 ? Math.max(1, Math.round(numberingPage)) : 0;
}

function collectLocalMeasuresForPage(pageSections = []) {
  const seen = new Set();
  const out = [];
  const add = (value) => {
    const numeric = Math.max(1, Math.round(safeNumber(value, 1)));
    if (seen.has(numeric)) return;
    seen.add(numeric);
    out.push(numeric);
  };
  for (const section of pageSections) {
    for (const note of getArray(section.notes)) add(note?.notePosition?.localMeasureIndex || note?.measureIndex);
    const range = getArray(section.measureRange);
    if (!getArray(section.notes).length && range.length >= 2) {
      const start = Math.max(1, Math.round(safeNumber(range[0], 1)));
      const end = Math.max(start, Math.round(safeNumber(range[1], start)));
      for (let value = start; value <= end; value += 1) add(value);
    }
  }
  return out.sort((left, right) => left - right);
}

function applyLegacyPagewiseMeasureNumbers(sections = [], score = {}) {
  const normalizedSections = getArray(sections);
  if (!normalizedSections.length || importedScoreHasCurrentMeasureNumbering({ ...score, sections: normalizedSections })) {
    return normalizedSections;
  }
  const looksPagewise =
    safeString(score?.omrStats?.mode) === "pagewise" ||
    getArray(score?.previewPages).length > 1 ||
    normalizedSections.some((section) => parsePagewiseSectionPage(section) > 0);
  if (!looksPagewise) return normalizedSections;

  const pageMap = new Map();
  for (const section of normalizedSections) {
    const pageNumber = parsePagewiseSectionPage(section);
    if (!pageNumber) return normalizedSections;
    if (!pageMap.has(pageNumber)) pageMap.set(pageNumber, []);
    pageMap.get(pageNumber).push(section);
  }

  let nextGlobalMeasure = 1;
  const pageMappings = new Map();
  for (const pageNumber of [...pageMap.keys()].sort((left, right) => left - right)) {
    const pageSections = pageMap.get(pageNumber).sort((left, right) =>
      safeNumber(left.sequenceIndex, 0) - safeNumber(right.sequenceIndex, 0) ||
      safeString(left.sectionId).localeCompare(safeString(right.sectionId)),
    );
    const localMeasures = collectLocalMeasuresForPage(pageSections);
    if (!localMeasures.length) continue;
    const localToGlobal = new Map();
    localMeasures.forEach((localMeasure, offset) => {
      localToGlobal.set(localMeasure, nextGlobalMeasure + offset);
    });
    pageMappings.set(pageNumber, {
      firstGlobalMeasure: nextGlobalMeasure,
      localMeasureCount: localMeasures.length,
      localToGlobal,
    });
    nextGlobalMeasure += localMeasures.length;
  }
  if (!pageMappings.size) return normalizedSections;

  return normalizedSections.map((section) => {
    const pageNumber = parsePagewiseSectionPage(section);
    const mapping = pageMappings.get(pageNumber);
    if (!mapping) return section;
    const fallbackOrdinals = new Map();
    let nextFallbackOrdinal = mapping.localMeasureCount;
    const mapMeasure = (value) => {
      const localMeasure = Math.max(1, Math.round(safeNumber(value, 1)));
      if (mapping.localToGlobal.has(localMeasure)) return mapping.localToGlobal.get(localMeasure);
      if (!fallbackOrdinals.has(localMeasure)) {
        fallbackOrdinals.set(localMeasure, nextFallbackOrdinal);
        nextFallbackOrdinal += 1;
      }
      return mapping.firstGlobalMeasure + fallbackOrdinals.get(localMeasure);
    };
    const notes = getArray(section.notes).map((note, noteIndex) => {
      const localMeasure = Math.max(1, Math.round(safeNumber(note?.notePosition?.localMeasureIndex || note?.measureIndex, 1)));
      const globalMeasure = mapMeasure(localMeasure);
      const notePosition = {
        ...(note.notePosition || {}),
        localMeasureIndex: localMeasure,
        globalMeasureIndex: globalMeasure,
        measureNumberSource: "pagewise-count",
        localNoteId: safeString(note?.notePosition?.localNoteId || note?.noteId),
      };
      const noteIdMatch = safeString(note?.noteId).match(/-n(\d+)\b/i);
      const noteOrdinal = noteIdMatch ? Math.max(1, Math.round(safeNumber(noteIdMatch[1], noteIndex + 1))) : noteIndex + 1;
      return {
        ...note,
        measureIndex: globalMeasure,
        noteId: `xml-m${globalMeasure}-n${noteOrdinal}`,
        notePosition,
      };
    });
    const patchMarkings = (items = []) => getArray(items).map((item) => {
      if (!item || typeof item !== "object") return item;
      const localMeasure = Math.max(1, Math.round(safeNumber(item.localMeasureIndex || item.measureIndex, 1)));
      return {
        ...item,
        localMeasureIndex: localMeasure,
        measureIndex: mapMeasure(localMeasure),
        measureNumberSource: "pagewise-count",
      };
    });
    const globalMeasures = notes
      .map((note) => Math.max(0, Math.round(safeNumber(note.measureIndex, 0))))
      .filter((value) => value > 0);
    const localCount = Math.max(mapping.localMeasureCount, nextFallbackOrdinal);
    return {
      ...section,
      notes,
      markings: patchMarkings(section.markings),
      tempoChanges: patchMarkings(section.tempoChanges),
      dynamicChanges: patchMarkings(section.dynamicChanges),
      repeatStructure: patchMarkings(section.repeatStructure),
      measureRange: globalMeasures.length ? [Math.min(...globalMeasures), Math.max(...globalMeasures)] : section.measureRange,
      measureNumbering: {
        source: "pagewise-count",
        pageIndex: pageNumber,
        firstGlobalMeasure: mapping.firstGlobalMeasure,
        lastGlobalMeasure: mapping.firstGlobalMeasure + localCount - 1,
        localMeasureCount: localCount,
        inferredFromLegacyScore: true,
      },
    };
  });
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

function importedScoreHasProjectionMetadata(score = {}) {
  return getArray(score.sections).some((section) => {
    const stats = section?.scoreLineStats && typeof section.scoreLineStats === "object" ? section.scoreLineStats : null;
    if (stats && (safeNumber(stats.erhuNoteCount, 0) > 0 || safeNumber(stats.accompanimentNoteCount, 0) > 0)) {
      return true;
    }
    return getArray(section?.notes).some((note) => safeString(note?.notePosition?.scoreLineRole).length > 0);
  });
}

function importedScoreHasCurrentMeasureNumbering(score = {}) {
  const sections = getArray(score.sections);
  const looksPagewise =
    safeString(score?.omrStats?.mode) === "pagewise" ||
    getArray(score?.previewPages).length > 1 ||
    sections.some((section) => /^page-\d+/i.test(safeString(section?.sectionId || section?.sourceSectionId)));
  if (!looksPagewise) return true;
  return sections.some((section) =>
    safeString(section?.measureNumbering?.source) === "pagewise-count" ||
    getArray(section?.notes).some((note) => safeString(note?.notePosition?.measureNumberSource) === "pagewise-count"),
  );
}

function scoreSourceFileExists(score = {}) {
  const sourcePath = safeString(score?.musicxmlPath);
  if (!sourcePath) return true;
  if (/^https?:\/\//i.test(sourcePath)) return true;
  const localPath = path.isAbsolute(sourcePath) && !sourcePath.startsWith("/data/")
    ? sourcePath
    : path.resolve(__dirname, sourcePath.replace(/^\/+/, ""));
  return fsSync.existsSync(localPath);
}

function normalizeScoreImportJob(job = {}) {
  const normalizedOmrStats = normalizeOmrStats(job.omrStats);
  const jobSections = getArray(job.sections || job.piecePack?.sections);
  const computedScoreLineStats = buildScoreLineStatsFromSections(jobSections);
  const hasInlineSections = jobSections.length > 0;
  const scoreLineStats =
    job.scoreLineStats && typeof job.scoreLineStats === "object"
      ? (hasInlineSections ? { ...job.scoreLineStats, ...computedScoreLineStats } : job.scoreLineStats)
      : computedScoreLineStats;
  const effectiveSectionCount =
    jobSections.length ||
    Math.max(0, Math.round(safeNumber(job.sectionCount, 0))) ||
    (safeNumber(scoreLineStats.noteCount, 0) > 0 ? 1 : 0);
  const omrStatus = safeString(job.omrStatus, "processing");
  const isFailedImport = omrStatus === "failed";
  const isMusicXmlSource = safeString(job.pdfHash).startsWith("musicxml:") || Boolean(safeString(job.musicxmlPath) && !safeString(job.sourcePdfPath));
  const musicxmlFallbackAvailable = safeBoolean(job.musicxmlFallbackAvailable, isFailedImport && !isMusicXmlSource);
  const fallbackActions = normalizeStringList(job.fallbackActions);
  const omrConfidence = calibrateOmrConfidence(job.omrConfidence, normalizedOmrStats, {
    omrStatus: safeString(job.omrStatus),
    sectionCount: effectiveSectionCount,
  });
  const selectedPartConfidence = effectiveSelectedPartConfidence(job.selectedPartConfidence, jobSections);
  const partCandidates = normalizePartCandidates(job.partCandidates);
  const omrQualityGate = buildOmrQualityGate({
    omrStatus,
    omrConfidence,
    omrStats: normalizedOmrStats,
    selectedPartConfidence,
    scoreLineStats,
    partCandidates,
    sectionCount: effectiveSectionCount,
    selectedPartConfirmed: safeBoolean(job.selectedPartConfirmed, false),
  });
  return {
    jobId: safeString(job.jobId),
    scoreId: safeString(job.scoreId),
    title: repairMojibakeText(job.title),
    instrument: safeString(job.instrument, job.piecePack?.instrument),
    scoreSource: safeString(job.scoreSource, job.piecePack?.scoreSourceType),
    tempoKnown: safeBoolean(job.tempoKnown, safeBoolean(job.piecePack?.tempoKnown, false)),
    tempoSource: safeString(job.tempoSource, job.piecePack?.tempoSource),
    sourcePdfPath: safeString(job.sourcePdfPath),
    pdfHash: safeString(job.pdfHash),
    originalFilename: repairMojibakeText(job.originalFilename),
    omrStatus,
    omrConfidence,
    omrStats: { ...normalizedOmrStats, qualityGate: omrQualityGate },
    musicxmlPath: safeString(job.musicxmlPath),
    previewPages: getArray(job.previewPages),
    detectedParts: getArray(job.detectedParts).map((item) => safeString(item)).filter(Boolean),
    selectedPart: safeString(job.selectedPart, "erhu"),
    selectedPartCandidates: getArray(job.selectedPartCandidates).map((item) => safeString(item)).filter(Boolean),
    selectedPartConfirmed: safeBoolean(job.selectedPartConfirmed, false),
    selectedPartConfidence,
    partCandidates,
      markingStats: job.markingStats && typeof job.markingStats === "object" ? job.markingStats : {},
      scoreLineStats,
      omrQualityGate,
      warnings: normalizeWarningList(job.warnings),
      cacheHit: safeBoolean(job.cacheHit),
      reusedScoreId: safeString(job.reusedScoreId),
      progress: clamp(safeNumber(job.progress, 0), 0, 1),
      stage: safeString(job.stage),
      error: safeString(job.error),
      musicxmlFallbackAvailable,
      fallbackActions: fallbackActions.length ? fallbackActions : (musicxmlFallbackAvailable ? ["import-musicxml"] : []),
      retryable: safeBoolean(job.retryable, isFailedImport),
      previousJobId: safeString(job.previousJobId),
      interruptedByRestart: safeBoolean(job.interruptedByRestart, false),
      recoveryReason: safeString(job.recoveryReason),
      createdAt: safeString(job.createdAt, nowIso()),
      updatedAt: safeString(job.updatedAt, job.createdAt || nowIso()),
    };
  }

function normalizeAnalysisJob(job = {}) {
  const status = safeString(job.status, safeString(job.analysisId) ? "completed" : "processing");
  const requestPayload = job.requestPayload && typeof job.requestPayload === "object"
    ? { ...job.requestPayload, audioDataUrl: null }
    : null;
  return {
    jobId: safeString(job.jobId),
    participantId: safeString(job.participantId),
    groupId: safeString(job.groupId),
    sessionStage: safeString(job.sessionStage),
    scoreId: safeString(job.scoreId),
    pieceId: safeString(job.pieceId),
    sectionId: safeString(job.sectionId),
    sectionTitle: safeString(job.sectionTitle),
    preprocessMode: safeString(job.preprocessMode),
    separationMode: safeString(job.separationMode),
    status,
    progress: clamp(safeNumber(job.progress, 0), 0, 1),
    stage: safeString(job.stage, "queued"),
    message: safeString(job.message),
    warnings: normalizeWarningList(job.warnings),
    error: safeString(job.error),
    retryable: safeBoolean(job.retryable, status === "failed"),
    previousJobId: safeString(job.previousJobId),
    interruptedByRestart: safeBoolean(job.interruptedByRestart, false),
    recoveryReason: safeString(job.recoveryReason),
    audioHash: safeString(job.audioHash),
    audioPath: safeString(job.audioPath || requestPayload?.audioPath),
    audioSubmission: job.audioSubmission && typeof job.audioSubmission === "object"
      ? job.audioSubmission
      : (requestPayload?.audioSubmission && typeof requestPayload.audioSubmission === "object" ? requestPayload.audioSubmission : null),
    requestPayload,
    analysisId: safeString(job.analysisId),
    candidateCount: Math.max(0, Math.round(safeNumber(job.candidateCount, 0))),
    bestSectionId: safeString(job.bestSectionId),
    createdAt: safeString(job.createdAt, nowIso()),
    updatedAt: safeString(job.updatedAt, job.createdAt || nowIso()),
    completedAt: safeString(job.completedAt),
    durationMs: Math.max(0, Math.round(safeNumber(job.durationMs, 0))),
  };
}

function normalizePiecePassJob(job = {}) {
  const detail = job.progressDetail && typeof job.progressDetail === "object" ? {
    currentSection: Math.max(0, Math.round(safeNumber(job.progressDetail.currentSection, 0))),
    totalSections: Math.max(0, Math.round(safeNumber(job.progressDetail.totalSections, 0))),
    completedSections: Math.max(0, Math.round(safeNumber(job.progressDetail.completedSections, job.progressDetail.currentSection || 0))),
    failedSections: Math.max(0, Math.round(safeNumber(job.progressDetail.failedSections, 0))),
    cacheHits: Math.max(0, Math.round(safeNumber(job.progressDetail.cacheHits, 0))),
    currentSectionTitle: safeString(job.progressDetail.currentSectionTitle),
  } : null;
  const timing = buildJobTiming(job);
  const status = safeString(job.status, safeString(job.summary?.pieceId) ? "completed" : "processing");
  const totalSections = Math.max(0, Math.round(safeNumber(detail?.totalSections, 0)));
  const completedSections = Math.max(0, Math.round(safeNumber(detail?.completedSections || detail?.currentSection, 0)));
  const estimatedRemainingMs =
    status === "processing" && totalSections > 0 && completedSections > 0 && timing.elapsedMs > 0
      ? Math.max(0, Math.round((timing.elapsedMs / completedSections) * Math.max(0, totalSections - completedSections)))
      : 0;
  return {
    jobId: safeString(job.jobId),
    participantId: safeString(job.participantId),
    scoreId: safeString(job.scoreId),
    pieceId: safeString(job.pieceId),
    pieceTitle: safeString(job.pieceTitle),
    sourceType: safeString(job.sourceType),
    preprocessMode: safeString(job.preprocessMode),
    status,
    progress: clamp(safeNumber(job.progress, 0), 0, 1),
    stage: safeString(job.stage, "queued"),
    message: safeString(job.message),
    progressDetail: detail,
    timing: {
      ...timing,
      estimatedRemainingMs,
      slowNoProgress: status === "processing" && timing.stalledMs > 120000,
    },
    warnings: normalizeWarningList(job.warnings),
    error: safeString(job.error),
    retryable: safeBoolean(job.retryable, status === "failed"),
    previousJobId: safeString(job.previousJobId),
    interruptedByRestart: safeBoolean(job.interruptedByRestart, false),
    recoveryReason: safeString(job.recoveryReason),
    audioHash: safeString(job.audioHash),
    audioPath: safeString(job.audioPath || job.requestPayload?.audioPath),
    audioSubmission: job.audioSubmission && typeof job.audioSubmission === "object"
      ? job.audioSubmission
      : (job.requestPayload?.audioSubmission && typeof job.requestPayload.audioSubmission === "object" ? job.requestPayload.audioSubmission : null),
    requestPayload: job.requestPayload && typeof job.requestPayload === "object"
      ? { ...job.requestPayload, audioDataUrl: null }
      : null,
    outputDir: safeString(job.outputDir),
    summaryPath: safeString(job.summaryPath),
    passJsonPath: safeString(job.passJsonPath),
    summary: job.summary && typeof job.summary === "object" ? job.summary : null,
    primaryAnalysis: job.primaryAnalysis && typeof job.primaryAnalysis === "object" ? job.primaryAnalysis : null,
    wholePieceAnalysis: job.wholePieceAnalysis && typeof job.wholePieceAnalysis === "object" ? job.wholePieceAnalysis : null,
    createdAt: safeString(job.createdAt, nowIso()),
    updatedAt: safeString(job.updatedAt, job.createdAt || nowIso()),
    completedAt: safeString(job.completedAt),
    durationMs: Math.max(0, Math.round(safeNumber(job.durationMs, 0))),
  };
}

function piecePassStageMessage(stage = "", fallback = "") {
  const normalizedStage = safeString(stage);
  const explicit = safeString(fallback).trim();
  if (normalizedStage === "checking-services") return "正在检查整曲分析服务。";
  if (normalizedStage === "scanning-sections") return explicit || "正在定位整曲中各段落的最佳窗口。";
  if (normalizedStage === "analyzing-sections") return explicit || "正在分析整曲各段落。";
  if (normalizedStage === "writing-results") return "正在写入整曲分析结果。";
  if (normalizedStage === "completed") return "整曲分析完成。";
  return explicit || "整曲分析进行中。";
}

function buildPiecePassProgressDetail(payload = {}) {
  const message = safeString(payload.message);
  const ratioMatch = message.match(/(\d+)\s*\/\s*(\d+)/);
  const currentSection = Math.max(0, Math.round(safeNumber(payload.currentSection, ratioMatch ? ratioMatch[1] : 0)));
  const totalSections = Math.max(0, Math.round(safeNumber(payload.totalSections, ratioMatch ? ratioMatch[2] : 0)));
  const completedSections = Math.max(0, Math.round(safeNumber(payload.completedSections, currentSection)));
  const failedSections = Math.max(0, Math.round(safeNumber(payload.failedSections, 0)));
  const cacheHits = Math.max(0, Math.round(safeNumber(payload.cacheHits, 0)));
  const currentSectionTitle = safeString(payload.currentSectionTitle || payload.sectionTitle);
  if (!currentSection && !totalSections && !completedSections && !failedSections && !cacheHits && !currentSectionTitle) return null;
  return {
    currentSection,
    totalSections,
    completedSections,
    failedSections,
    cacheHits,
    currentSectionTitle,
  };
}

function findReusableImportedScore(store, { pdfHash = "", selectedPart = "erhu", allowReuse = false } = {}) {
  if (!allowReuse) return null;
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
        importedScoreHasProjectionMetadata(score) &&
        importedScoreHasCurrentMeasureNumbering(score) &&
        scoreSourceFileExists(score) &&
        getArray(score.sections).length > 0,
    ) || null
  );
}

const activeScoreImportTasks = new Map();
const activeAnalysisTasks = new Map();
const activePiecePassTasks = new Map();
const cancelledScoreImportJobIds = new Set();
const cancelledAnalysisJobIds = new Set();
const cancelledPiecePassJobIds = new Set();

function isCancelledScoreImportJob(job = {}) {
  return safeString(job.omrStatus) === "failed" && safeString(job.stage) === "cancelled";
}

function isCancelledStatusJob(job = {}) {
  return safeString(job.status) === "failed" && safeString(job.stage) === "cancelled";
}

function interruptedByRestartWarning() {
  return "上次任务在服务重启时中断，已停止等待；请重新提交。";
}

async function recoverStaleScoreImportJobsOnStartup() {
  const store = await readScoreStore();
  let recovered = 0;
  store.jobs = getArray(store.jobs).map((job) => {
    const normalized = normalizeScoreImportJob(job);
    if (normalized.omrStatus !== "processing" || activeScoreImportTasks.has(normalized.jobId)) {
      return normalized;
    }
    recovered += 1;
    return normalizeScoreImportJob({
      ...normalized,
      omrStatus: "failed",
      progress: 1,
      stage: "failed",
      warnings: [...normalizeWarningList(normalized.warnings), interruptedByRestartWarning()],
      musicxmlFallbackAvailable: true,
      fallbackActions: ["import-musicxml"],
      retryable: true,
      interruptedByRestart: true,
      recoveryReason: "node-service-restart",
      error: "识谱任务因服务重启中断，请重新导入 PDF。",
      updatedAt: nowIso(),
    });
  });
  if (recovered > 0) {
    await writeScoreStore(store);
  }
  return recovered;
}

async function recoverStaleAnalysisJobsOnStartup() {
  const store = await readAnalysisJobStore();
  let recovered = 0;
  store.jobs = getArray(store.jobs).map((job) => {
    const normalized = normalizeAnalysisJob(job);
    if (normalized.status !== "processing" || activeAnalysisTasks.has(normalized.jobId)) {
      return normalized;
    }
    recovered += 1;
    return normalizeAnalysisJob({
      ...normalized,
      status: "failed",
      progress: 1,
      stage: "failed",
      message: "分析任务因服务重启中断，请重新上传音频并开始诊断。",
      warnings: [...normalizeWarningList(normalized.warnings), interruptedByRestartWarning()],
      error: "analysis interrupted by service restart",
      retryable: true,
      interruptedByRestart: true,
      recoveryReason: "node-service-restart",
      completedAt: nowIso(),
      updatedAt: nowIso(),
    });
  });
  if (recovered > 0) {
    await writeAnalysisJobStore(store);
  }
  return recovered;
}

async function recoverStalePiecePassJobsOnStartup() {
  const store = await readPiecePassJobStore();
  let recovered = 0;
  store.jobs = getArray(store.jobs).map((job) => {
    const normalized = normalizePiecePassJob(job);
    if (normalized.status !== "processing" || activePiecePassTasks.has(normalized.jobId)) {
      return normalized;
    }
    recovered += 1;
    return normalizePiecePassJob({
      ...normalized,
      status: "failed",
      progress: 1,
      stage: "failed",
      message: "整曲分析任务因服务重启中断，请重新运行整曲分析。",
      warnings: [...normalizeWarningList(normalized.warnings), interruptedByRestartWarning()],
      error: "piece-pass interrupted by service restart",
      retryable: true,
      interruptedByRestart: true,
      recoveryReason: "node-service-restart",
      completedAt: nowIso(),
      updatedAt: nowIso(),
    });
  });
  if (recovered > 0) {
    await writePiecePassJobStore(store);
  }
  return recovered;
}

async function recoverStaleJobsOnStartup() {
  try {
    const [scoreImports, analyses, piecePasses] = await Promise.all([
      recoverStaleScoreImportJobsOnStartup(),
      recoverStaleAnalysisJobsOnStartup(),
      recoverStalePiecePassJobsOnStartup(),
    ]);
    const total = scoreImports + analyses + piecePasses;
    if (total > 0) {
      console.log(
        `[startup-recovery] marked interrupted jobs failed: scoreImports=${scoreImports}, analyses=${analyses}, piecePasses=${piecePasses}`,
      );
    }
  } catch (error) {
    console.error("[startup-recovery] error:", safeString(error?.message));
  }
}

async function upsertScoreImportJob(job) {
  return enqueueStoreOperation(SCORE_STORE_FILE, async () => {
    const normalizedJob = normalizeScoreImportJob(job);
    const shouldPreserveCancelled = cancelledScoreImportJobIds.has(normalizedJob.jobId) && normalizedJob.stage !== "cancelled";
    if (scoreStoreUsesSqlite()) {
      if (shouldPreserveCancelled) {
        const existingJob = (await readScoreStoreUnlocked()).jobs.find((item) => item.jobId === normalizedJob.jobId);
        if (isCancelledScoreImportJob(existingJob)) return existingJob;
      }
      upsertScoreImportJobInSqlite(SCORE_STORE_SQLITE_FILE, normalizedJob);
      return normalizedJob;
    }
    const store = await readScoreStoreUnlocked();
    const existingJobIndex = store.jobs.findIndex((item) => item.jobId === normalizedJob.jobId);
    if (shouldPreserveCancelled && isCancelledScoreImportJob(store.jobs[existingJobIndex])) {
      return store.jobs[existingJobIndex];
    }
    if (existingJobIndex >= 0) {
      store.jobs[existingJobIndex] = normalizedJob;
    } else {
      store.jobs.push(normalizedJob);
    }
    await writeScoreStoreUnlocked(store);
    return normalizedJob;
  });
}

async function upsertAnalysisJob(job) {
  return enqueueStoreOperation(ANALYSIS_JOB_STORE_FILE, async () => {
    const store = await readAnalysisJobStoreUnlocked();
    const normalizedJob = normalizeAnalysisJob(job);
    const existingJobIndex = store.jobs.findIndex((item) => item.jobId === normalizedJob.jobId);
    if (
      cancelledAnalysisJobIds.has(normalizedJob.jobId) &&
      normalizedJob.stage !== "cancelled" &&
      isCancelledStatusJob(store.jobs[existingJobIndex])
    ) {
      return store.jobs[existingJobIndex];
    }
    if (existingJobIndex >= 0) {
      store.jobs[existingJobIndex] = normalizedJob;
    } else {
      store.jobs.push(normalizedJob);
    }
    await writeAnalysisJobStoreUnlocked(store);
    return normalizedJob;
  });
}

async function hydrateAnalysisJob(job) {
  const normalizedJob = normalizeAnalysisJob(job);
  const publicJob = stripReusableJobPayload(normalizedJob);
  if (!normalizedJob.analysisId) {
    return publicJob;
  }
  const store = await readStudyStore();
  const analysis = store.analyses.find((item) => item.analysisId === normalizedJob.analysisId) || null;
  return {
    ...publicJob,
    analysis,
  };
}

function stripReusableJobPayload(job = {}) {
  const { requestPayload, audioPath, ...publicJob } = job;
  return {
    ...publicJob,
    reusablePayloadAvailable: Boolean(safeString(requestPayload?.audioPath || audioPath)),
  };
}

async function upsertPiecePassJob(job) {
  return enqueueStoreOperation(PIECE_PASS_JOB_STORE_FILE, async () => {
    const store = await readPiecePassJobStoreUnlocked();
    const normalizedJob = normalizePiecePassJob(job);
    const existingIndex = store.jobs.findIndex((item) => item.jobId === normalizedJob.jobId);
    if (
      cancelledPiecePassJobIds.has(normalizedJob.jobId) &&
      normalizedJob.stage !== "cancelled" &&
      isCancelledStatusJob(store.jobs[existingIndex])
    ) {
      return store.jobs[existingIndex];
    }
    if (existingIndex >= 0) {
      store.jobs[existingIndex] = normalizedJob;
    } else {
      store.jobs.push(normalizedJob);
    }
    await writePiecePassJobStoreUnlocked(store);
    return normalizedJob;
  });
}

async function resolvePiecePassTarget({ scoreId = "", pieceId = "", title = "" } = {}) {
  const scoreStore = await readScoreStore();
  if (scoreId) {
    const importedScore = getImportedScore(scoreStore, scoreId);
    if (importedScore) {
      return {
        pieceKey: importedScore.scoreId,
        pieceTitle: safeString(importedScore.title, importedScore.scoreId),
        sourceType: "score",
      };
    }
  }

  if (pieceId) {
    const libraryPiece = getErhuPiece(pieceId);
    if (libraryPiece) {
      return {
        pieceKey: libraryPiece.pieceId,
        pieceTitle: safeString(libraryPiece.title, libraryPiece.pieceId),
        sourceType: "piece",
      };
    }
    const importedScore = getImportedScore(scoreStore, pieceId)
      || scoreStore.scores.find((item) => safeString(item.pieceId) === pieceId)
      || null;
    if (importedScore) {
      return {
        pieceKey: importedScore.scoreId,
        pieceTitle: safeString(importedScore.title, importedScore.scoreId),
        sourceType: "score",
      };
    }
  }

  if (title) {
    const importedScore = scoreStore.scores.find((item) => safeString(item.title) === title) || null;
    if (importedScore) {
      return {
        pieceKey: importedScore.scoreId,
        pieceTitle: safeString(importedScore.title, importedScore.scoreId),
        sourceType: "score",
      };
    }
  }

  return null;
}

function buildPiecePassPrimaryAnalysis({ task = {}, passPayload = {}, summary = null } = {}) {
  const rows = getArray(passPayload.sectionPasses);
  if (!rows.length) return null;
  const successfulRows = rows.filter(
    (row) => !(safeBoolean(row.failed, false) || safeBoolean(row.analysisFailed, false) || safeString(row.error) || safeString(row.failureReason)),
  );
  if (!successfulRows.length) return null;
  const issueRows = successfulRows.filter((row) => getArray(row.noteFindings).length || getArray(row.measureFindings).length);
  const sourceRow = (issueRows.length ? issueRows : successfulRows)
    .slice()
    .sort((left, right) => {
      const leftScore = safeNumber(left.studentCombinedScore, safeNumber(left.combinedScore, 999));
      const rightScore = safeNumber(right.studentCombinedScore, safeNumber(right.combinedScore, 999));
      if (leftScore !== rightScore) return leftScore - rightScore;
      return safeNumber(left.sequenceIndex, 0) - safeNumber(right.sequenceIndex, 0);
    })[0] || null;
  if (!sourceRow) return null;

  const analysisId = `${safeString(task.jobId, "piecepass")}-${safeString(sourceRow.sectionId, "section")}`;
  const originalAudioUrl = toWebPathFromAbsolute(task.payload?.audioPath);
  const originalAudioDuration = firstPositiveNumber(
    task.payload?.audioSubmission?.duration,
    summary?.audioCoverage?.audioDurationSeconds,
    passPayload?.audioCoverage?.audioDurationSeconds,
  );
  const originalAudio = originalAudioUrl ? {
    url: originalAudioUrl,
    durationSeconds: Number.isFinite(originalAudioDuration) && originalAudioDuration > 0 ? originalAudioDuration : null,
    filename: repairMojibakeText(task.payload?.audioSubmission?.name),
    audioHash: safeString(task.payload?.audioHash, safeString(summary?.audioHash, passPayload.audioHash)),
  } : null;
  const separationQuality = separationQualityFields(sourceRow, {
    confidenceFallback: 0,
    modeFallback: safeString(task.payload?.separationMode, safeString(task.payload?.preprocessMode, "auto")),
  });
  return {
    analysisId,
    participantId: safeString(task.payload?.participantId),
    groupId: safeString(task.payload?.groupId, "self-practice"),
    sessionStage: "whole-piece",
    scoreId: safeString(task.payload?.scoreId),
    pieceId: safeString(task.pieceKey, sourceRow.pieceId),
    sectionId: safeString(sourceRow.sectionId),
    pieceTitle: safeString(task.pieceTitle, sourceRow.pieceTitle),
    sectionTitle: safeString(sourceRow.sectionTitle),
    audioHash: safeString(task.payload?.audioHash, safeString(summary?.audioHash, passPayload.audioHash)),
    audioSubmission: task.payload?.audioSubmission || null,
    originalAudio,
    audioUrl: safeString(originalAudio?.url),
    originalAudioUrl: safeString(originalAudio?.url),
    audioDurationSeconds: originalAudio?.durationSeconds ?? null,
    overallPitchScore: clamp(safeNumber(sourceRow.overallPitchScore, 0), 0, 100),
    overallRhythmScore: clamp(safeNumber(sourceRow.overallRhythmScore, 0), 0, 100),
    studentPitchScore: clamp(safeNumber(sourceRow.studentPitchScore, safeNumber(sourceRow.overallPitchScore, 0)), 0, 100),
    studentRhythmScore: clamp(safeNumber(sourceRow.studentRhythmScore, safeNumber(sourceRow.overallRhythmScore, 0)), 0, 100),
    studentCombinedScore: clamp(safeNumber(sourceRow.studentCombinedScore, safeNumber(sourceRow.combinedScore, 0)), 0, 100),
    ...separationQuality,
    measureFindings: getArray(sourceRow.measureFindings),
    noteFindings: getArray(sourceRow.noteFindings),
    demoSegments: getArray(sourceRow.demoSegments),
    confidence: clamp(safeNumber(sourceRow.confidence, 0), 0, 1),
    summaryText: safeString(sourceRow.summaryText, safeString(summary?.summaryText)),
    teacherComment: safeString(sourceRow.teacherComment),
    recommendedPracticePath: safeString(sourceRow.recommendedPracticePath, safeString(summary?.dominantPracticePath, "review-first")),
    practiceTargets: getArray(sourceRow.practiceTargets),
    analysisMode: "whole-piece-section",
    diagnostics: {
      ...(sourceRow.diagnostics && typeof sourceRow.diagnostics === "object" ? sourceRow.diagnostics : {}),
      wholePieceJobId: safeString(task.jobId),
      wholePieceSource: "piece-pass",
      startSeconds: safeNumber(sourceRow.startSeconds, null),
      endSeconds: safeNumber(sourceRow.endSeconds, null),
    },
    createdAt: nowIso(),
  };
}

function extractPageNumberFromSectionLike(sectionLike = {}) {
  const candidates = [
    safeString(sectionLike?.sourceSectionId),
    safeString(sectionLike?.sectionId),
    safeString(sectionLike?.sectionTitle),
    safeString(sectionLike?.title),
  ];
  for (const candidate of candidates) {
    const match = candidate.match(/page[-\s]?0*(\d+)/i);
    if (match) return Math.max(1, Math.round(safeNumber(match[1], 1)));
  }
  return Math.max(1, Math.round(safeNumber(sectionLike?.pageNumber, 1)));
}

function buildWholePieceAnalysis({ task = {}, passPayload = {}, summary = null } = {}) {
  const rows = getArray(passPayload.sectionPasses)
    .slice()
    .sort((left, right) => safeNumber(left.sequenceIndex, 0) - safeNumber(right.sequenceIndex, 0));
  if (!rows.length) return null;
  const successfulRows = rows.filter(
    (row) => !(safeBoolean(row.failed, false) || safeBoolean(row.analysisFailed, false) || safeString(row.error) || safeString(row.failureReason)),
  );

  const noteFindings = [];
  const measureFindings = [];
  const practiceTargets = [];
  const demoSegments = [];
  const sectionSummaries = [];
  let noteIssueIndex = 0;
  let measureIssueIndex = 0;

  for (const row of rows) {
    const sectionId = safeString(row.sectionId);
    const sectionTitle = repairMojibakeText(row.sectionTitle || sectionId);
    const pageNumber = extractPageNumberFromSectionLike(row);
    const rowStartSeconds = safeNumber(row.startSeconds, null);
    const rowEndSeconds = safeNumber(row.endSeconds, null);
    const rowFailed = safeBoolean(row.failed, false)
      || safeBoolean(row.analysisFailed, false)
      || Boolean(safeString(row.error))
      || Boolean(safeString(row.failureReason));
    sectionSummaries.push({
      sectionId,
      sectionTitle,
      pageNumber,
      sequenceIndex: safeNumber(row.sequenceIndex, 0),
      startSeconds: rowStartSeconds,
      endSeconds: rowEndSeconds,
      overallPitchScore: safeNumber(row.overallPitchScore, 0),
      overallRhythmScore: safeNumber(row.overallRhythmScore, 0),
      studentCombinedScore: safeNumber(row.studentCombinedScore, row.combinedScore || 0),
      noteFindingCount: getArray(row.noteFindings).length,
      measureFindingCount: getArray(row.measureFindings).length,
      confidence: safeNumber(row.confidence, 0),
      failed: rowFailed,
      error: safeString(row.error, safeString(row.failureReason)),
    });
    for (const item of getArray(row.noteFindings)) {
      noteIssueIndex += 1;
      noteFindings.push({
        ...item,
        issueNumber: noteIssueIndex,
        sectionId,
        sectionTitle,
        pageNumber,
        startSeconds: rowStartSeconds,
        endSeconds: rowEndSeconds,
      });
    }
    for (const item of getArray(row.measureFindings)) {
      measureIssueIndex += 1;
      measureFindings.push({
        ...item,
        issueNumber: measureIssueIndex,
        sectionId,
        sectionTitle,
        pageNumber,
        startSeconds: rowStartSeconds,
        endSeconds: rowEndSeconds,
      });
    }
    for (const item of getArray(row.practiceTargets)) {
      practiceTargets.push({
        ...item,
        sectionId,
        sectionTitle,
        pageNumber,
      });
    }
    for (const item of getArray(row.demoSegments)) {
      demoSegments.push({
        ...item,
        sectionId,
        sectionTitle,
        pageNumber,
      });
    }
  }

  const firstDiagnostics = rows.find((row) => row?.diagnostics)?.diagnostics || {};
  const separationQuality = separationQualityFields(firstDiagnostics, {
    confidenceFallback: null,
    modeFallback: safeString(task.payload?.separationMode, safeString(task.payload?.preprocessMode, "auto")),
  });
  const overallPitchScore = clamp(
    safeNumber(summary?.weightedPitchScore, safeNumber(summary?.overallPitchScore, medianNumber(successfulRows.map((row) => row.overallPitchScore)))),
    0,
    100,
  );
  const overallRhythmScore = clamp(
    safeNumber(summary?.weightedRhythmScore, safeNumber(summary?.overallRhythmScore, medianNumber(successfulRows.map((row) => row.overallRhythmScore)))),
    0,
    100,
  );
  const studentPitchScore = clamp(safeNumber(summary?.weightedStudentPitchScore, overallPitchScore), 0, 100);
  const studentRhythmScore = clamp(safeNumber(summary?.weightedStudentRhythmScore, overallRhythmScore), 0, 100);
  const studentCombinedScore = clamp(
    safeNumber(summary?.weightedStudentCombinedScore, safeNumber(summary?.weightedCombinedScore, (studentPitchScore + studentRhythmScore) / 2)),
    0,
    100,
  );
  const originalAudioUrl = toWebPathFromAbsolute(task.payload?.audioPath);
  const originalAudioDuration = firstPositiveNumber(
    task.payload?.audioSubmission?.duration,
    summary?.audioCoverage?.audioDurationSeconds,
    passPayload?.audioCoverage?.audioDurationSeconds,
  );
  const originalAudio = originalAudioUrl ? {
    url: originalAudioUrl,
    durationSeconds: Number.isFinite(originalAudioDuration) && originalAudioDuration > 0 ? originalAudioDuration : null,
    filename: repairMojibakeText(task.payload?.audioSubmission?.name),
    audioHash: safeString(task.payload?.audioHash, safeString(summary?.audioHash, passPayload.audioHash)),
  } : null;

  return {
    analysisId: `${safeString(task.jobId, "piecepass")}-whole-piece`,
    participantId: safeString(task.payload?.participantId),
    groupId: safeString(task.payload?.groupId, "self-practice"),
    sessionStage: "whole-piece",
    scoreId: safeString(task.payload?.scoreId),
    pieceId: safeString(task.pieceKey, passPayload.pieceId),
    pieceTitle: safeString(task.pieceTitle, summary?.pieceTitle),
    sectionId: "",
    sectionTitle: "整曲",
    audioHash: safeString(task.payload?.audioHash, safeString(summary?.audioHash, passPayload.audioHash)),
    audioSubmission: task.payload?.audioSubmission || null,
    originalAudio,
    audioUrl: safeString(originalAudio?.url),
    originalAudioUrl: safeString(originalAudio?.url),
    audioDurationSeconds: originalAudio?.durationSeconds ?? null,
    overallPitchScore,
    overallRhythmScore,
    studentPitchScore,
    studentRhythmScore,
    studentCombinedScore,
    ...separationQuality,
    rawAudioPath: safeString(firstDiagnostics?.rawAudioPath),
    erhuEnhancedAudioPath: safeString(firstDiagnostics?.erhuEnhancedAudioPath),
    accompanimentResidualPath: safeString(firstDiagnostics?.accompanimentResidualPath),
    measureFindings,
    noteFindings,
    demoSegments,
    confidence: clamp(
      safeNumber(summary?.weightedConfidence, safeNumber(summary?.confidence, medianNumber(successfulRows.map((row) => row.confidence)))),
      0,
      1,
    ),
    summaryText: safeString(summary?.summaryText),
    teacherComment: "",
    recommendedPracticePath: safeString(summary?.dominantPracticePath, "review-first"),
    practiceTargets,
    analysisMode: "whole-piece",
    diagnostics: {
      wholePieceJobId: safeString(task.jobId),
      wholePieceSource: "piece-pass",
      sectionCount: rows.length,
      successfulSectionCount: successfulRows.length,
      failedSectionCount: sectionSummaries.filter((item) => item.failed || item.error).length,
      analysisCompletenessRatio: safeNumber(summary?.analysisCompletenessRatio, rows.length ? successfulRows.length / rows.length : 0),
      analysisReliable: safeBoolean(summary?.analysisReliable, false),
      timedOutSectionCount: safeNumber(summary?.timedOutSectionCount, 0),
      sectionSummaries,
      audioCoverage: summary?.audioCoverage || passPayload.audioCoverage || null,
    },
    createdAt: nowIso(),
  };
}

function launchPiecePassTask(task) {
  const existingTask = activePiecePassTasks.get(task.jobId);
  if (existingTask) return existingTask;

  const taskRecord = { promise: null, ticket: null, child: null };
  const runner = (async () => {
    const ticket = await PIECE_PASS_TASK_GATE.enter(task.jobId);
    taskRecord.ticket = ticket;
    const startedAt = Date.now();
    const outputDir = path.join(PIECE_PASS_DIR, "jobs", task.jobId);
    const baseJob = {
      jobId: task.jobId,
      previousJobId: safeString(task.previousJobId),
      participantId: safeString(task.payload?.participantId),
      scoreId: safeString(task.payload?.scoreId),
      pieceId: safeString(task.pieceKey),
      pieceTitle: safeString(task.pieceTitle),
      sourceType: safeString(task.sourceType),
      preprocessMode: safeString(task.payload?.preprocessMode, "auto"),
      status: "processing",
      progress: 0.04,
      stage: "queued",
      message: "整曲分析任务已提交，正在排队。",
      audioHash: safeString(task.payload?.audioHash),
      audioPath: safeString(task.payload?.audioPath),
      audioSubmission: task.payload?.audioSubmission || null,
      requestPayload: { ...(task.payload || {}), audioDataUrl: null },
      outputDir,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await upsertPiecePassJob(baseJob);

    const scriptPath = process.env.ERHU_PIECE_PASS_RUNNER_SCRIPT
      ? path.resolve(process.env.ERHU_PIECE_PASS_RUNNER_SCRIPT)
      : path.join(__dirname, "scripts", "run-piece-pass.py");
    const runnerScript = path.join(__dirname, "scripts", "run-python.ps1");
    const scanConcurrency = clamp(Math.round(safeNumber(process.env.ERHU_PIECE_PASS_SCAN_CONCURRENCY, 3)), 1, 6);
    const analysisConcurrency = clamp(Math.round(safeNumber(process.env.ERHU_PIECE_PASS_ANALYSIS_CONCURRENCY, 3)), 1, 6);
    const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL, "http://127.0.0.1:8000").replace(/\/+$/, "");
    const args = [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runnerScript,
      scriptPath,
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--analyzer-url",
      analyzerUrl || "http://127.0.0.1:8000",
      ...(task.sourceType === "score"
        ? ["--score-id", task.pieceKey]
        : ["--piece-id", task.pieceKey]),
      "--audio",
      safeString(task.payload?.audioPath),
      "--output-dir",
      outputDir,
      "--preprocess-mode",
      safeString(task.payload?.preprocessMode, "auto"),
      "--audio-hash",
      safeString(task.payload?.audioHash),
      ...(task.sourceType === "score"
        ? [
            "--max-candidates-per-section",
            "1",
            "--fast-sequence-scan",
            "--hint-radius",
            "0",
            "--window-padding",
            "0.5",
            "--fast-window-min-duration",
            "2.5",
            "--fast-window-max-duration",
            "8",
            "--fast-window-scale",
            "1.05",
            "--scan-preprocess-mode",
            "off",
            "--cache-dir",
            "data/piece-pass/section-cache",
            "--scan-concurrency",
            String(scanConcurrency),
            "--analysis-concurrency",
            String(analysisConcurrency),
            "--analysis-retry",
            "1",
            "--analysis-timeout-seconds",
            "180",
          ]
        : []),
    ];

    const warnings = [];
    const child = spawn("powershell", args, {
      cwd: __dirname,
      windowsHide: true,
    });
    taskRecord.child = child;

    let stdoutBuffer = "";
    let stderrBuffer = "";

    const handleProgressLine = async (line) => {
      if (!line.startsWith("__PROGRESS__")) return;
      try {
        const payload = JSON.parse(line.slice("__PROGRESS__".length));
        await upsertPiecePassJob({
          ...baseJob,
          status: "processing",
          progress: clamp(safeNumber(payload.progress, 0), 0, 1),
          stage: safeString(payload.stage, "running"),
          message: piecePassStageMessage(payload.stage, payload.message),
          progressDetail: buildPiecePassProgressDetail(payload),
          warnings,
          outputDir,
          updatedAt: nowIso(),
        });
      } catch {
        // ignore malformed progress payloads
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        void handleProgressLine(line.trim());
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        const nextLine = line.trim();
        if (nextLine) warnings.push(nextLine);
      }
    });

    await new Promise((resolve) => {
      child.on("close", resolve);
      child.on("error", resolve);
    });

    const summaryPath = path.join(outputDir, `${task.pieceKey}-whole-piece-summary.json`);
    const passJsonPath = path.join(outputDir, `${task.pieceKey}-whole-piece-pass.json`);
    try {
      const summaryPayload = JSON.parse(await fs.readFile(summaryPath, "utf8"));
      const passPayload = JSON.parse(await fs.readFile(passJsonPath, "utf8"));
      const passSummary = summaryPayload?.summary || null;
      const analysisReliable = safeBoolean(passSummary?.analysisReliable, true);
      const primaryAnalysis = buildPiecePassPrimaryAnalysis({
        task,
        passPayload,
        summary: passSummary,
      });
      const wholePieceAnalysis = buildWholePieceAnalysis({
        task,
        passPayload,
        summary: passSummary,
      });
      const structuredSectionCount = Math.max(0, Math.round(safeNumber(passSummary?.structuredSectionCount, 0)));
      const attemptedSectionCount = Math.max(0, Math.round(safeNumber(passSummary?.attemptedSectionCount, 0)));
      const matchedSectionCount = Math.max(0, Math.round(safeNumber(passSummary?.matchedSectionCount, 0)));
      if (!wholePieceAnalysis || structuredSectionCount <= 0 || attemptedSectionCount <= 0 || matchedSectionCount <= 0) {
        await upsertPiecePassJob({
          ...baseJob,
          status: "failed",
          progress: 1,
          stage: "failed",
          message: "整曲分析失败：没有得到可用的二胡旋律段落，请重新确认 PDF 声部识别结果。",
          warnings: [
            ...warnings,
            `no analyzable erhu sections: structured=${structuredSectionCount}, attempted=${attemptedSectionCount}, matched=${matchedSectionCount}`,
          ],
          error: "no analyzable erhu sections",
          outputDir,
          summaryPath,
          passJsonPath,
          summary: passSummary,
          primaryAnalysis: null,
          wholePieceAnalysis: null,
          durationMs: Date.now() - startedAt,
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
        return;
      }
      const nextWarnings = analysisReliable
        ? warnings
        : [
            ...warnings,
            `整曲分析完整度偏低：完成 ${safeNumber(passSummary?.matchedSectionCount, 0)} / ${safeNumber(passSummary?.attemptedSectionCount, 0)} 段，失败或超时 ${safeNumber(passSummary?.failedSectionCount, 0)} 段。`,
          ];
      await upsertPiecePassJob({
        ...baseJob,
        status: "completed",
        progress: 1,
        stage: "completed",
        message: analysisReliable ? "整曲分析完成。" : "整曲分析完成，但部分段落失败或超时，结果需复核。",
        warnings: nextWarnings,
        outputDir,
        summaryPath,
        passJsonPath,
        summary: passSummary,
        primaryAnalysis,
        wholePieceAnalysis,
        durationMs: Date.now() - startedAt,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    } catch (error) {
      await upsertPiecePassJob({
        ...baseJob,
        status: "failed",
        progress: 1,
        stage: "failed",
        message: "整曲分析失败。",
        warnings,
        error: safeString(error?.message, "piece-pass failed"),
        outputDir,
        durationMs: Date.now() - startedAt,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  })()
    .catch(async (error) => {
      await upsertPiecePassJob({
        jobId: task.jobId,
        previousJobId: safeString(task.previousJobId),
        participantId: safeString(task.payload?.participantId),
        scoreId: safeString(task.payload?.scoreId),
        pieceId: safeString(task.pieceKey),
        pieceTitle: safeString(task.pieceTitle),
        sourceType: safeString(task.sourceType),
        preprocessMode: safeString(task.payload?.preprocessMode, "auto"),
        status: "failed",
        progress: 1,
        stage: "failed",
        message: "整曲分析任务未能启动，请稍后重试。",
        error: safeString(error?.message, "piece-pass queue failed"),
        retryable: true,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    })
    .finally(() => {
    PIECE_PASS_TASK_GATE.release(taskRecord.ticket);
    activePiecePassTasks.delete(task.jobId);
  });

  taskRecord.promise = runner;
  activePiecePassTasks.set(task.jobId, taskRecord);
  return runner;
}

async function finalizeScoreImportArtifacts({ job, scoreRecord }) {
  const normalizedJob = await enqueueStoreOperation(SCORE_STORE_FILE, async () => {
    const store = await readScoreStoreUnlocked();
    const nextJob = normalizeScoreImportJob(job);
    const existingJobIndex = store.jobs.findIndex((item) => item.jobId === nextJob.jobId);
    if (
      cancelledScoreImportJobIds.has(nextJob.jobId) &&
      nextJob.stage !== "cancelled" &&
      isCancelledScoreImportJob(store.jobs[existingJobIndex])
    ) {
      return store.jobs[existingJobIndex];
    }
    if (scoreRecord) {
      const normalizedScore = normalizeImportedScoreRecord(scoreRecord);
      const normalizedPdfHash = safeString(normalizedScore.pdfHash);
      const normalizedSelectedPart = safeString(normalizedScore.selectedPart).toLowerCase();
      if (normalizedPdfHash) {
        store.scores = getArray(store.scores).filter((item) => {
          if (safeString(item.scoreId) === normalizedScore.scoreId) return true;
          if (safeString(item.pdfHash) !== normalizedPdfHash) return true;
          const sameSelectedPart = safeString(item.selectedPart).toLowerCase() === normalizedSelectedPart;
          return !sameSelectedPart;
        });
      }
      const existingScoreIndex = store.scores.findIndex((item) => item.scoreId === normalizedScore.scoreId);
      if (existingScoreIndex >= 0) {
        store.scores[existingScoreIndex] = normalizedScore;
      } else {
        store.scores.push(normalizedScore);
      }
    }
    if (existingJobIndex >= 0) {
      store.jobs[existingJobIndex] = nextJob;
    } else {
      store.jobs.push(nextJob);
    }
    await writeScoreStoreUnlocked(store);
    return nextJob;
  });
  setTimeout(() => void backfillMissingTempos(), 3000);
  return normalizedJob;
}

function launchScoreImportTask(task) {
  const existingTask = activeScoreImportTasks.get(task.jobId);
  if (existingTask) return existingTask;

  const taskRecord = { promise: null, ticket: null, child: null };
  const runner = (async () => {
    const ticket = await SCORE_IMPORT_TASK_GATE.enter(task.jobId);
    taskRecord.ticket = ticket;
    const {
      jobId,
      titleHint,
      selectedPartHint,
      pdfHash,
      pdfPath,
      webPdfPath,
      originalFilename,
      previousJobId = "",
      fallbackPiece,
      previewPages,
      selectedPartConfirmed = false,
    } = task;

    await upsertScoreImportJob({
      jobId,
      originalFilename,
      previousJobId,
      title: titleHint,
      sourcePdfPath: webPdfPath,
      pdfHash,
      omrStatus: "processing",
      omrConfidence: 0,
      previewPages,
      detectedParts: [selectedPartHint],
      selectedPart: selectedPartHint,
      selectedPartCandidates: [selectedPartHint],
      selectedPartConfirmed,
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
        previousJobId,
        title: titleHint,
        sourcePdfPath: webPdfPath,
        pdfHash,
        omrStatus: "processing",
        omrConfidence: 0,
        previewPages,
        detectedParts: [selectedPartHint],
        selectedPart: selectedPartHint,
        selectedPartCandidates: [selectedPartHint],
        selectedPartConfirmed,
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
        selectedPartId: safeString(jobResult.piecePack?.selectedPartId),
        selectedPartConfirmed,
        selectedPartConfidence: safeNumber(jobResult.selectedPartConfidence, safeNumber(jobResult.piecePack?.selectedPartConfidence, 0)),
        partCandidates: getArray(jobResult.partCandidates || jobResult.piecePack?.partCandidates),
        markingStats: jobResult.markingStats || jobResult.piecePack?.markingStats || buildMarkingStatsFromSections(importedSections),
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
          previousJobId,
          title: scoreRecord.title,
          sourcePdfPath: webPdfPath,
          pdfHash,
          musicxmlPath: jobResult.musicxmlPath ? toWebPathFromAbsolute(jobResult.musicxmlPath) : "",
          originalFilename,
          previewPages: scoreRecord.previewPages,
          omrStats: scoreRecord.omrStats,
          selectedPartConfirmed,
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
        selectedPartConfirmed,
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
          previousJobId,
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
          selectedPartConfirmed,
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
      previousJobId,
      title: titleHint,
      sourcePdfPath: webPdfPath,
      pdfHash,
      omrStatus: "failed",
      omrConfidence: 0,
      previewPages,
      detectedParts: [selectedPartHint],
      selectedPart: selectedPartHint,
      selectedPartCandidates: [selectedPartHint],
      selectedPartConfirmed,
      omrStats: { mode: "failed", pageCount: getArray(previewPages).length },
      warnings: serviceWarning ? [serviceWarning] : [],
      musicxmlFallbackAvailable: true,
      fallbackActions: ["import-musicxml"],
      retryable: true,
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
        previousJobId: safeString(task.previousJobId),
        title: task.titleHint,
        sourcePdfPath: task.webPdfPath,
        pdfHash: task.pdfHash,
        omrStatus: "failed",
        omrConfidence: 0,
        previewPages: task.previewPages,
        detectedParts: [task.selectedPartHint],
        selectedPart: task.selectedPartHint,
        selectedPartCandidates: [task.selectedPartHint],
        selectedPartConfirmed: safeBoolean(task.selectedPartConfirmed, false),
        omrStats: { mode: "failed", pageCount: getArray(task.previewPages).length },
        warnings: [safeString(error?.message, "score import failed")],
        musicxmlFallbackAvailable: true,
        fallbackActions: ["import-musicxml"],
        retryable: true,
        error: "自动识谱失败。",
        progress: 1,
        stage: "failed",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    })
    .finally(() => {
      SCORE_IMPORT_TASK_GATE.release(taskRecord.ticket);
      activeScoreImportTasks.delete(task.jobId);
    });

  taskRecord.promise = runner;
  activeScoreImportTasks.set(task.jobId, taskRecord);
  return runner;
}

function getImportedScore(store, scoreId) {
  return store.scores.find((item) => item.scoreId === scoreId) || null;
}

function getImportedScoreSection(store, scoreId, sectionId) {
  const score = getImportedScore(store, scoreId);
  if (!score) return null;
  const section = score.sections.find((item) => item.sectionId === sectionId) || null;
  return section ? buildErhuOnlyImportedSection(section, score) : null;
}

function meterBeatsValue(meter = "4/4") {
  const beats = safeString(meter, "4/4").split("/")[0];
  const numeric = Number(beats);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 4;
}

function estimateSectionDurationSeconds(section = {}) {
  const notes = getArray(section.notes);
  const tempo = Math.max(30, safeNumber(section.tempo, 72));
  const beatsPerMeasure = meterBeatsValue(section.meter);
  const measureIndices = notes.map((note) => Math.max(1, safeNumber(note?.measureIndex, 1)));
  const minMeasureIndex = measureIndices.length ? Math.max(1, Math.min(...measureIndices)) : 1;
  let maxBeatOffset = beatsPerMeasure;
  for (const note of notes) {
    const measureIndex = Math.max(1, safeNumber(note?.measureIndex, 1));
    const beatStart = safeNumber(note?.beatStart, 0);
    const beatDuration = Math.max(0.25, safeNumber(note?.beatDuration, 1));
    const endBeat = (measureIndex - minMeasureIndex) * beatsPerMeasure + beatStart + beatDuration;
    maxBeatOffset = Math.max(maxBeatOffset, endBeat);
  }
  return (maxBeatOffset * 60) / tempo;
}

function isLikelyNonScoreLeadPageSection(section = {}, score = {}) {
  const pageNumber = extractPageNumberFromSectionLike(section);
  const pageCount = Math.max(0, Math.round(safeNumber(score?.omrStats?.pageCount, getArray(score?.previewPages).length)));
  if (pageCount < 4 || pageNumber !== 1) return false;
  const noteCount = getArray(section?.notes).length || Math.round(safeNumber(section?.noteCount, 0));
  const descriptor = `${safeString(section?.sectionId)} ${safeString(section?.sourceSectionId)} ${safeString(section?.title)}`;
  const isAutoLeadPage = /自动识谱第\s*[12]\s*页|page[-\s]?0?[12]\b/i.test(descriptor);
  return isAutoLeadPage && noteCount > 0 && noteCount < 12;
}

function isImportedFullScoreSection(section = {}) {
  const descriptor = `${safeString(section?.sectionId)} ${safeString(section?.sourceSectionId)} ${safeString(section?.title)}`;
  return /page[-\s]?0*\d+/i.test(descriptor) || /自动识谱第\s*\d+\s*页/i.test(descriptor);
}


function getImportedProjectionSource(section = {}, score = {}) {
  return getArray(section?.partCandidates).length ? section : score;
}

function sectionHasConfidentErhuLine(section = {}) {
  const stats = section?.scoreLineStats && typeof section.scoreLineStats === "object" ? section.scoreLineStats : null;
  if (safeNumber(stats?.erhuNoteCount, 0) > 0) return true;
  return getArray(section?.notes).some((note) => {
    const role = safeString(note?.notePosition?.scoreLineRole).toLowerCase();
    const confidence = safeNumber(note?.notePosition?.scoreLineConfidence, 0);
    return role === "erhu" && confidence >= 0.66;
  });
}

function isBlockedImportedProjection(section = {}, score = {}) {
  if (sectionHasConfidentErhuLine(section)) return false;
  const mode = safeString(section?.erhuProjectionMode).trim().toLowerCase();
  if (mode === "blocked") return true;
  const source = getImportedProjectionSource(section, score);
  const candidate = getSelectedPartCandidate(source);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return false;
  if (!hasAccompanimentPartCandidate(source)) return false;
  const sectionConfidence = safeNumber(section?.selectedPartConfidence, Number.NaN);
  const sourceConfidence = safeNumber(source?.selectedPartConfidence, 0);
  const confidence = Number.isFinite(sectionConfidence) && sectionConfidence > 0
    ? sectionConfidence
    : sourceConfidence;
  return confidence < 0.62
    && (
      safeBoolean(candidate?.isLikelyAccompanimentSplit, false)
      || safeBoolean(candidate?.isAfterExplicitPiano, false)
      || safeBoolean(candidate?.isLikelyPiano, false)
      || !safeBoolean(candidate?.safeForErhuProjection, false)
    );
}

function isErhuMelodySystemIndex(systemIndex, score = {}) {
  const numeric = Math.round(safeNumber(systemIndex, 0));
  if (!numeric) return true;
  if (isCleanSoloSelectedPart(score)) return true;
  return (numeric - 1) % 3 === 0;
}

function isErhuMelodyNote(note = {}, section = {}, score = {}) {
  if (!isImportedFullScoreSection(section)) return true;
  if (isBlockedImportedProjection(section, score)) return false;
  const source = getImportedProjectionSource(section, score);
  const accompanimentPresent = hasAccompanimentPartCandidate(source) || hasAccompanimentPartCandidate(score);
  const lineRole = safeString(note?.notePosition?.scoreLineRole).toLowerCase();
  const lineConfidence = safeNumber(note?.notePosition?.scoreLineConfidence, 0);
  if (lineRole === "erhu" && lineConfidence >= 0.66) {
    return true;
  }
  if (lineRole) return false;
  if (accompanimentPresent) return false;
  return isErhuMelodySystemIndex(note?.notePosition?.systemIndex, score);
}

function buildErhuOnlyImportedSection(section = {}, score = {}) {
  if (!isImportedFullScoreSection(section)) return section;
  if (isBlockedImportedProjection(section, score)) return null;
  const notes = getArray(section?.notes);
  const notesWithSystem = notes.filter((note) => Number.isFinite(safeNumber(note?.notePosition?.systemIndex, Number.NaN)));
  if (!notesWithSystem.length) return section;
  const erhuNotes = notes.filter((note) => isErhuMelodyNote(note, section, score));
  if (!erhuNotes.length) return null;
  const measureCount = Math.max(1, ...erhuNotes.map((note) => Math.round(safeNumber(note?.measureIndex, 1))));
  return {
    ...section,
    notes: erhuNotes,
    noteCount: erhuNotes.length,
    measureCount,
  };
}

function getImportedSectionSequenceIndex(section = {}, fallbackIndex = 0) {
  const descriptor = `${safeString(section?.sectionId)} ${safeString(section?.sourceSectionId)} ${safeString(section?.title)}`;
  const pageMatch = descriptor.match(/page[-\s]?0*(\d+)(?:[-_\s]?s0*(\d+))?/i);
  if (pageMatch) {
    const pageNumber = Math.max(1, Math.round(safeNumber(pageMatch[1], 1)));
    const fragmentNumber = Math.max(0, Math.round(safeNumber(pageMatch[2], 0)));
    return pageNumber * 100 + fragmentNumber;
  }
  return Math.max(1, Math.round(safeNumber(section?.sequenceIndex, fallbackIndex + 1)));
}

function buildDerivedPieceFromScore(score = {}) {
  let cumulativeSeconds = 0;
  const sourceSections = getArray(score.sections)
    .filter((section) => !isLikelyNonScoreLeadPageSection(section, score))
    .map((section) => buildErhuOnlyImportedSection(section, score))
    .filter(Boolean);
  const orderedSections = sourceSections
    .map((section, index) => ({
      section,
      normalizedSequenceIndex: getImportedSectionSequenceIndex(section, index),
    }))
    .sort((left, right) => left.normalizedSequenceIndex - right.normalizedSequenceIndex);
  const sections = orderedSections.map(({ section, normalizedSequenceIndex }, index) => {
    const durationSeconds = estimateSectionDurationSeconds(section);
    const existingHints = getArray(section?.researchWindowHints)
      .map((value) => safeNumber(value, Number.NaN))
      .filter((value) => Number.isFinite(value));
    const derivedHint = Number(cumulativeSeconds.toFixed(2));
    const nextSection = {
      ...section,
      pieceId: safeString(score.scoreId || score.pieceId),
      title: safeString(section.title, `第 ${index + 1} 段`),
      sequenceIndex: normalizedSequenceIndex,
      noteCount: Math.max(getArray(section.notes).length, Math.round(safeNumber(section.noteCount, 0))),
      measureCount: Math.max(1, Math.round(safeNumber(section.measureCount, 0))),
      researchWindowHints: existingHints.length ? existingHints : [derivedHint],
    };
    cumulativeSeconds += Math.max(2, durationSeconds);
    return nextSection;
  });
  return {
    pieceId: safeString(score.scoreId || score.pieceId),
    title: repairMojibakeText(score.title, "导入曲谱"),
    composer: safeString(score.composer),
    sections,
  };
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
  const aliasDataDir = path.join(ASCII_RUNTIME_ROOT, "data");
  const aliasRelative = path.relative(aliasDataDir, absolute);
  if (aliasRelative && !aliasRelative.startsWith("..") && !path.isAbsolute(aliasRelative)) {
    return toWebDataPath(aliasRelative);
  }
  return absolute;
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
          ? "先检查拍点是否明显偏前或偏后。"
          : practicePath === "pitch-first"
            ? "先检查左手落点是否偏高或偏低。"
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
    selectedPart: safeString(section?.selectedPart),
    instrument: safeString(section?.instrument),
    scoreSourceType: safeString(section?.scoreSourceType),
    tempoKnown: safeBoolean(section?.tempoKnown, false),
    tempoSource: safeString(section?.tempoSource),
    markings: normalizeMarkingList(section?.markings),
    tempoChanges: normalizeMarkingList(section?.tempoChanges),
    dynamicChanges: normalizeMarkingList(section?.dynamicChanges),
    repeatStructure: normalizeMarkingList(section?.repeatStructure),
    noteCount: getArray(section?.notes).length,
    notes: getArray(section?.notes).map((note) => ({
      noteId: safeString(note?.noteId),
      measureIndex: Math.round(safeNumber(note?.measureIndex, 0)),
      beatStart: safeNumber(note?.beatStart, 0),
      beatDuration: safeNumber(note?.beatDuration, 0),
      midiPitch: Math.round(safeNumber(note?.midiPitch, 0)),
      articulations: normalizeStringList(note?.articulations),
      notations: normalizeStringList(note?.notations),
      techniques: normalizeStringList(note?.techniques),
      activeTempo: safeNumber(note?.activeTempo, section?.tempo || 72),
      activeDynamic: safeString(note?.activeDynamic),
      dynamicValue: safeNumber(note?.dynamicValue, null),
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
    analysisVersion: "v36-recomputed-separation-quality",
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
    detectionVersion: "v36-recomputed-separation-quality",
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
          articulations: normalizeStringList(note?.articulations),
          notations: normalizeStringList(note?.notations),
          techniques: normalizeStringList(note?.techniques),
          activeTempo: safeNumber(note?.activeTempo, section?.tempo || 72),
          activeDynamic: safeString(note?.activeDynamic),
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

async function backfillMissingTempos() {
  try {
    const store = await readScoreStore();
    let changed = false;

    for (const score of store.scores) {
      const sections = getArray(score.sections);
      if (!sections.some((s) => safeNumber(s?.tempo, 72) === 72)) continue;

      const pdfParts = safeString(score.sourcePdfPath).replace(/\\/g, "/").split("/").filter(Boolean);
      if (pdfParts.length < 3) continue;
      const jobDir = pdfParts[2];
      const pagwiseDir = path.join(SCORE_IMPORTS_DIR, jobDir, "pagewise");
      const sourcePdfAbs =
        safeString(score.sourcePdfPath).startsWith("/data/")
          ? path.join(__dirname, safeString(score.sourcePdfPath).slice(1))
          : "";

      const pageToIndices = new Map();
      for (let i = 0; i < sections.length; i++) {
        if (safeNumber(sections[i]?.tempo, 72) !== 72) continue;
        const sectionId = safeString(sections[i]?.sectionId);
        const m = sectionId.match(/^page-(\d+)/);
        const pageNum = m ? parseInt(m[1], 10) : 0;
        if (!pageToIndices.has(pageNum)) pageToIndices.set(pageNum, []);
        pageToIndices.get(pageNum).push(i);
      }

      const requestPages = [];
      const pageNumToMeta = new Map();
      for (const [pageNum, indices] of pageToIndices) {
        let pdfPath;
        if (pageNum === 0) {
          pdfPath = sourcePdfAbs;
        } else {
          const base = path.join(pagwiseDir, `page-${String(pageNum).padStart(3, "0")}`);
          // Prefer PDF; fall back to PNG (some imports generate PNG previews only)
          pdfPath = base + ".pdf";
          if (!fsSync.existsSync(pdfPath)) {
            const pngPath = base + ".png";
            if (fsSync.existsSync(pngPath)) pdfPath = pngPath;
          }
        }
        const pageKey =
          pageNum === 0 ? "section-a" : `page-${String(pageNum).padStart(2, "0")}`;
        requestPages.push({ sectionId: pageKey, pagePdfPath: pdfPath });
        pageNumToMeta.set(pageNum, { pageKey, indices });
      }

      if (!requestPages.length) continue;
      const patches = await callPatchTempos(requestPages);

      for (const [, { pageKey, indices }] of pageNumToMeta) {
        const tempo = patches[pageKey];
        if (tempo && tempo !== 72) {
          for (const idx of indices) {
            score.sections[idx] = { ...score.sections[idx], tempo };
          }
          changed = true;
        }
      }
    }

    if (changed) {
      await writeScoreStore(store);
      console.log("[backfillMissingTempos] tempo patches written to store.");
    }
  } catch (err) {
    console.error("[backfillMissingTempos] error:", safeString(err?.message));
  }
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
          ...separationQualityFields(diagnostics),
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
    ...separationQualityFields(diagnostics),
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

function buildSelectedSectionHintWindow(payload = {}, section = {}) {
  const explicitWindowStart = safeNumber(payload.windowStartSeconds, NaN);
  const explicitWindowEnd = safeNumber(payload.windowEndSeconds, NaN);
  if (Number.isFinite(explicitWindowStart) && Number.isFinite(explicitWindowEnd) && explicitWindowEnd > explicitWindowStart) {
    return null;
  }

  const audioDurationSeconds = safeNumber(payload.audioSubmission?.duration, 0);
  if (audioDurationSeconds <= 0) return null;

  const hints = getArray(section?.researchWindowHints)
    .map((value) => safeNumber(value, NaN))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!hints.length) return null;

  const primaryHint = hints[0];
  if (primaryHint > audioDurationSeconds * 1.05) return null;

  const expectedDurationSeconds = estimateSectionDurationSeconds(section);
  const noteCount = getArray(section?.notes).length;
  const baseDuration = expectedDurationSeconds > 0
    ? expectedDurationSeconds
    : clamp(noteCount * 0.55, 8, 60);
  const targetDurationSeconds = clamp(Math.max(baseDuration + 6, baseDuration * 1.45), 8, 90);

  if (audioDurationSeconds <= targetDurationSeconds * 1.8) {
    return null;
  }

  const start = clamp(primaryHint - 2, 0, Math.max(0, audioDurationSeconds - 1));
  const end = clamp(start + targetDurationSeconds, start + 4, audioDurationSeconds);
  if (end - start < 4) return null;

  return {
    windowStartSeconds: Number(start.toFixed(3)),
    windowEndSeconds: Number(end.toFixed(3)),
  };
}

function applySelectedSectionHintWindow(payload = {}, section = {}) {
  const hintWindow = buildSelectedSectionHintWindow(payload, section);
  if (!hintWindow) return payload;
  return {
    ...payload,
    ...hintWindow,
  };
}

function shouldUseDetectedWindowAnalysis(candidate = null, section = null) {
  return !!buildCandidateAnalysisWindow(candidate, section);
}

async function prepareAnalysisPayload(payload = {}, file = null) {
  const persistedAudio = file
    ? await persistUploadedAudioFile(file, { audioCacheDir: AUDIO_CACHE_DIR })
    : await persistPayloadAudio(payload, { audioCacheDir: AUDIO_CACHE_DIR });
  return normalizePreparedPayloadForAnalyzer(buildPreparedAudioPayload(
    payload,
    persistedAudio,
  ), toAnalyzerPath);
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

app.use(createOpsRouter({
  DATA_DIR,
  STORE_ARCHIVE_DIR,
  PERF_TRACE_FILE,
  SCORE_STORE_FILE,
  SCORE_STORE_SQLITE_FILE,
  ANALYSIS_JOB_STORE_FILE,
  PIECE_PASS_JOB_STORE_FILE,
  SCORE_STORE_BACKEND,
  SCORE_IMPORTS_DIR,
  port,
  scoreStoreUsesSqlite,
  fetchAnalyzerStatus,
  readScoreStore,
  readScoreStoreUnlocked,
  writeScoreStoreUnlocked,
  readAnalysisJobStore,
  readAnalysisJobStoreUnlocked,
  writeAnalysisJobStoreUnlocked,
  readPiecePassJobStore,
  readPiecePassJobStoreUnlocked,
  writePiecePassJobStoreUnlocked,
  normalizeScoreImportJob,
  normalizeAnalysisJob,
  normalizePiecePassJob,
  SCORE_IMPORT_TASK_GATE,
  ANALYSIS_TASK_GATE,
  PIECE_PASS_TASK_GATE,
  activeScoreImportTasks,
  activeAnalysisTasks,
  activePiecePassTasks,
  cancelledScoreImportJobIds,
  cancelledAnalysisJobIds,
  cancelledPiecePassJobIds,
  toWebDataPath,
  findKnownPieceForPdf,
  cloneLibraryPieceForImport,
  upsertScoreImportJob,
  upsertAnalysisJob,
  upsertPiecePassJob,
  launchScoreImportTask,
  launchAnalysisTask,
  launchPiecePassTask,
}));

app.use(createScoreRouter({
  upload,
  repoRoot: __dirname,
  SCORE_IMPORT_TASK_GATE,
  SCORE_STORE_FILE,
  SCORE_IMPORTS_DIR,
  readScoreStore,
  readScoreStoreUnlocked,
  writeScoreStoreUnlocked,
  normalizeScoreImportJob,
  normalizeImportedScoreRecord,
  findReusableImportedScore,
  findKnownPieceForPdf,
  cloneLibraryPieceForImport,
  toWebDataPath,
  upsertScoreImportJob,
  launchScoreImportTask,
  callExternalMusicXmlImportLongTimeout,
  callExternalMidiImportLongTimeout,
  buildMarkingStatsFromSections,
  getImportedScore,
  activeScoreImportTasks,
}));

app.use(createAnalysisRouter({
  upload,
  AUDIO_CACHE_DIR,
  ANALYSIS_TASK_GATE,
  PIECE_PASS_TASK_GATE,
  readLatestPiecePassSummary,
  parseIncomingPayload,
  buildAudioSubmissionFromUpload,
  prepareAnalysisPayload,
  resolvePiecePassTarget,
  upsertPiecePassJob,
  launchPiecePassTask,
  stripReusableJobPayload,
  readPiecePassJobStore,
  activePiecePassTasks,
  normalizePiecePassJob,
  getErhuPieceSummaries,
  getErhuPiece,
  readScoreStore,
  getImportedScore,
  buildDerivedPieceFromScore,
  persistUploadedAudioFile,
  persistPayloadAudio,
  normalizePreparedPayloadForAnalyzer,
  buildPreparedAudioPayload,
  toAnalyzerPath,
  autoDetectPieceSection,
  buildDetectionSummaryAnalysis,
  compactDetectionCandidate,
  upsertAnalysisJob,
  launchAnalysisTask,
  executePreparedAnalysisRequest,
  readAnalysisJobStore,
  activeAnalysisTasks,
  normalizeAnalysisJob,
  hydrateAnalysisJob,
}));

async function executePreparedAnalysisRequest(payload, { onProgress } = {}) {
  const requestStartedAt = Date.now();
  const participantId = safeString(payload.participantId).trim();
  const groupId = safeString(payload.groupId, "experimental");
  const scoreId = safeString(payload.scoreId);
  const pieceId = safeString(payload.pieceId);
  const sectionId = safeString(payload.sectionId);
  const autoDetectSection = safeBoolean(payload.autoDetectSection, false);

  if (!participantId) {
    throw new Error("participantId is required.");
  }

  await onProgress?.({
    progress: 0.08,
    stage: "loading-score",
    message: "正在读取曲谱与分析配置。",
  });

  const scoreStore = await readScoreStore();
  const importedScore = scoreId ? getImportedScore(scoreStore, scoreId) : null;
  const piece = pieceId ? getErhuPiece(pieceId) : null;
  if (scoreId || pieceId) {
    appendPerfTrace(
      `[analyze] start participant=${participantId || "unknown"} scoreId=${scoreId || "-"} pieceId=${pieceId || "-"} autoDetect=${autoDetectSection} at=${new Date().toISOString()}`,
    );
    appendPerfTrace(
      `[analyze] payload-ready elapsedMs=${Date.now() - requestStartedAt} audioHash=${safeString(payload.audioHash).slice(0, 12)}`,
    );
  }
  const librarySection = getErhuSection(pieceId, sectionId);
  const importedSection = importedScore ? getImportedScoreSection(scoreStore, scoreId, sectionId) : null;
  let section = normalizePiecePackOverride(payload.piecePackOverride, importedSection || librarySection || { pieceId, sectionId }) || importedSection || librarySection;
  let analysis = null;
  let autoDetection = null;

  if (!section && autoDetectSection && (importedScore || piece)) {
    const detectStartedAt = Date.now();
    await onProgress?.({
      progress: 0.32,
      stage: "detecting-section",
      message: "正在定位最匹配的段落。",
    });
    autoDetection = await autoDetectPieceSection(
      { ...payload, scoreId },
      importedScore ? buildDerivedPieceFromScore(importedScore) : piece,
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
    await onProgress?.({
      progress: 0.52,
      stage: "detecting-section",
      message: `已定位段落：${safeString(section?.title || section?.sectionId || "未命名段落")}。`,
      candidateCount: getArray(autoDetection?.candidates).length,
      bestSectionId: safeString(section?.sectionId),
    });
    if (analysis && safeString(analysis.analysisMode) === "detection-summary") {
      analysis = null;
    }
  }

  if (!section) {
    throw new Error("piece section not found.");
  }

  await onProgress?.({
    progress: 0.68,
    stage: "analyzing",
    message: "正在执行音高、节奏和二胡技法分析。",
    bestSectionId: safeString(section?.sectionId),
  });

  if (!analysis) {
    const sectionAnalyzeStartedAt = Date.now();
    const autoDetectedCandidate = getArray(autoDetection?.candidates).find(
      (candidate) => safeString(candidate?.sectionId) === safeString(section?.sectionId),
    ) || getArray(autoDetection?.candidates)[0] || null;
    const scopedPayload = shouldUseDetectedWindowAnalysis(autoDetectedCandidate, section)
      ? applyCandidateDetectedWindow(payload, autoDetectedCandidate, section)
      : applySelectedSectionHintWindow(payload, section);
    analysis = await runSectionAnalysis(scopedPayload, section);
    if (scoreId || pieceId) {
      appendPerfTrace(
        `[analyze] section-analysis-finished elapsedMs=${Date.now() - sectionAnalyzeStartedAt} sectionId=${safeString(section?.sectionId)} mode=${safeString(analysis?.analysisMode, "unknown")}`,
      );
    }
  }

  await onProgress?.({
    progress: 0.9,
    stage: "saving",
    message: "正在保存分析结果。",
    bestSectionId: safeString(section?.sectionId),
  });

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
    pieceTitle: safeString(importedScore?.title, safeString(section.pieceTitle, safeString(piece?.title))),
    sectionTitle: safeString(section.title, safeString(section.sectionTitle)),
    piecePackSource: payload.piecePackOverride ? "manual-helper" : importedScore ? "score-import" : "library",
    autoDetectedSection: autoDetectSection,
    audioHash: safeString(payload.audioHash),
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
    separationEnergyRatio: nullableRatio(analysis.separationEnergyRatio ?? analysis.diagnostics?.separationEnergyRatio),
    separationScoreBandRatio: nullableRatio(analysis.separationScoreBandRatio ?? analysis.diagnostics?.separationScoreBandRatio),
    separationConfidentPitchCount: nullableInteger(
      analysis.separationConfidentPitchCount ?? analysis.diagnostics?.separationConfidentPitchCount,
    ),
    separationScoreBandHitCount: nullableInteger(
      analysis.separationScoreBandHitCount ?? analysis.diagnostics?.separationScoreBandHitCount,
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

  await onProgress?.({
    progress: 1,
    stage: "completed",
    message: "分析完成，可以查看问题谱面页。",
    bestSectionId: safeString(section?.sectionId),
  });

  return {
    analysisRecord,
    autoDetection,
    elapsedMs: Date.now() - requestStartedAt,
    participant,
    store,
    section,
  };
}

function launchAnalysisTask(task) {
  const existingTask = activeAnalysisTasks.get(task.jobId);
  if (existingTask) return existingTask;

  const taskRecord = { promise: null, ticket: null, child: null };
  const runner = (async () => {
    const ticket = await ANALYSIS_TASK_GATE.enter(task.jobId);
    taskRecord.ticket = ticket;
    const startedAt = Date.now();
    const baseJob = {
      jobId: task.jobId,
      previousJobId: safeString(task.previousJobId),
      participantId: safeString(task.payload?.participantId),
      groupId: safeString(task.payload?.groupId),
      sessionStage: safeString(task.payload?.sessionStage),
      scoreId: safeString(task.payload?.scoreId),
      pieceId: safeString(task.payload?.pieceId),
      sectionId: safeString(task.payload?.sectionId),
      audioHash: safeString(task.payload?.audioHash),
      audioPath: safeString(task.payload?.audioPath),
      audioSubmission: task.payload?.audioSubmission || null,
      preprocessMode: safeString(task.payload?.preprocessMode),
      separationMode: safeString(task.payload?.separationMode),
      requestPayload: { ...(task.payload || {}), audioDataUrl: null },
      status: "processing",
      progress: 0.04,
      stage: "queued",
      message: "分析任务已提交，正在排队。",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await upsertAnalysisJob(baseJob);
    try {
      const result = await executePreparedAnalysisRequest(task.payload, {
        onProgress: async (next) => {
          await upsertAnalysisJob({
            ...baseJob,
            ...next,
            status: next?.stage === "completed" ? "completed" : "processing",
            updatedAt: nowIso(),
          });
        },
      });
      await upsertAnalysisJob({
        ...baseJob,
        status: "completed",
        progress: 1,
        stage: "completed",
        message: "分析完成，可以查看问题谱面页。",
        analysisId: safeString(result?.analysisRecord?.analysisId),
        bestSectionId: safeString(result?.section?.sectionId),
        candidateCount: getArray(result?.autoDetection?.candidates).length,
        durationMs: Date.now() - startedAt,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    } catch (error) {
      await upsertAnalysisJob({
        ...baseJob,
        status: "failed",
        progress: 1,
        stage: "failed",
        message: "分析失败，请稍后重试。",
        error: safeString(error?.message, "analysis failed"),
        durationMs: Date.now() - startedAt,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  })()
    .catch(async (error) => {
      await upsertAnalysisJob({
        jobId: task.jobId,
        previousJobId: safeString(task.previousJobId),
        participantId: safeString(task.payload?.participantId),
        groupId: safeString(task.payload?.groupId),
        sessionStage: safeString(task.payload?.sessionStage),
        scoreId: safeString(task.payload?.scoreId),
        pieceId: safeString(task.payload?.pieceId),
        sectionId: safeString(task.payload?.sectionId),
        audioHash: safeString(task.payload?.audioHash),
        audioPath: safeString(task.payload?.audioPath),
        audioSubmission: task.payload?.audioSubmission || null,
        preprocessMode: safeString(task.payload?.preprocessMode),
        separationMode: safeString(task.payload?.separationMode),
        requestPayload: { ...(task.payload || {}), audioDataUrl: null },
        status: "failed",
        progress: 1,
        stage: "failed",
        message: "分析任务未能启动，请稍后重试。",
        error: safeString(error?.message, "analysis queue failed"),
        retryable: true,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
    })
    .finally(() => {
    ANALYSIS_TASK_GATE.release(taskRecord.ticket);
    activeAnalysisTasks.delete(task.jobId);
  });

  taskRecord.promise = runner;
  activeAnalysisTasks.set(task.jobId, taskRecord);
  return runner;
}

app.use("/api/erhu", createResearchRouter({ readStudyStore, writeStudyStore, fetchAnalyzerStatus }));
app.use("/api/erhu/teacher-validation", createTeacherValidationRouter(teacherValidationService));
app.use(createWesternStringsRouter({
  repoRoot: __dirname,
  upload,
  audioCacheDir: AUDIO_CACHE_DIR,
  scorePhotoCacheDir: SCORE_PHOTO_CACHE_DIR,
  parseIncomingPayload,
  buildAudioSubmissionFromUpload,
  buildScorePhotoSubmissionFromUpload,
  persistUploadedAudioFile,
  persistPayloadAudio,
  persistUploadedScorePhotoFile,
  persistPayloadScorePhoto,
  contentSafety: wechatContentSafetyService,
}));

const noStoreStaticOptions = {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store");
  },
};

app.use("/data", express.static(DATA_DIR, noStoreStaticOptions));
app.use(express.static(DIST_DIR, noStoreStaticOptions));

app.get(/.*/, async (req, res) => {
  try {
    await fs.access(path.join(DIST_DIR, "index.html"));
    res.sendFile(path.join(DIST_DIR, "index.html"));
  } catch {
    res.status(404).send("dist/index.html not found. Run `npm run build` first.");
  }
});

// In public mode the tunnel is the only intended way in, so bind loopback to
// keep the port off other interfaces; that binding is what lets the guard trust
// header-less (local) requests. Default (unset) keeps the prior all-interfaces
// behaviour for local/LAN development.
const bindHost = safeString(process.env.ERHU_BIND_HOST).trim();
const listenArgs = bindHost ? [port, bindHost] : [port];
app.listen(...listenArgs, () => {
  console.log(`AI Erhu prototype listening on http://${bindHost || "localhost"}:${port}`);
  void recoverStaleJobsOnStartup();
  setTimeout(() => void backfillMissingTempos(), 30000);
});
