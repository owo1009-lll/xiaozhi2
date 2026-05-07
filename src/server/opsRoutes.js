import express from "express";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clamp,
  createId,
  getArray,
  nowIso,
  nullableInteger,
  repairMojibakeText,
  safeBoolean,
  safeNumber,
  safeString,
  sha1,
} from "./baseUtils.js";
import { enqueueStoreOperation } from "./jsonStore.js";
import { summarizeScoreStoreSqlite } from "./scoreStoreSqlite.js";
import { killProcessTree, queueFullPayload } from "./taskQueue.js";

export function createOpsRouter({
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
}) {
  const router = express.Router();

  function dataWebPathToAbsolute(webPath = "") {
    const value = safeString(webPath).trim();
    if (!value) return "";
    if (value.startsWith("/data/")) {
      return path.join(DATA_DIR, value.slice("/data/".length).replace(/\//g, path.sep));
    }
    return value;
  }

  async function fileSummary(filePath) {
    const value = safeString(filePath);
    if (!value) return { path: "", exists: false, sizeBytes: 0, updatedAt: "" };
    try {
      const stat = await fs.stat(value);
      return {
        path: value,
        exists: true,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      return { path: value, exists: false, sizeBytes: 0, updatedAt: "" };
    }
  }

  async function listRecentArchiveFiles(limit = 5) {
    try {
      const entries = await fs.readdir(STORE_ARCHIVE_DIR, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^erhu-score-imports-archive-.*\.json$/i.test(entry.name)) continue;
        const archivePath = path.join(STORE_ARCHIVE_DIR, entry.name);
        const stat = await fs.stat(archivePath);
        files.push({
          path: archivePath,
          name: entry.name,
          sizeBytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      }
      return files
        .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
        .slice(0, Math.max(0, limit));
    } catch {
      return [];
    }
  }

  function publicTaskError(error) {
    const text = repairMojibakeText(error).trim();
    if (!text) return "";
    if (/\b(traceback|exception|stack|enoent|eacces|localhost|127\.0\.0\.1|\/api\/|https?:\/\/|[a-z]:\\|python|uvicorn|json|error:)\b/i.test(text)) {
      return "任务失败，请检查服务状态后重试。";
    }
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }

  function taskStatusForType(type, job = {}) {
    if (type === "score-import") return safeString(job.omrStatus);
    return safeString(job.status);
  }

  function reusableJobAudioPath(job = {}) {
    const candidate = safeString(job.requestPayload?.audioPath || job.audioPath).trim();
    if (!candidate) return "";
    const absolutePath = dataWebPathToAbsolute(candidate);
    return absolutePath && fsSync.existsSync(absolutePath) ? candidate : "";
  }

  function canRetryJob(type, job = {}) {
    const status = taskStatusForType(type, job);
    if (status !== "failed") return false;
    if (type === "score-import") {
      return Boolean(safeString(job.sourcePdfPath) && fsSync.existsSync(dataWebPathToAbsolute(job.sourcePdfPath)));
    }
    if (type === "analysis") {
      return Boolean(reusableJobAudioPath(job) && (safeString(job.scoreId) || safeString(job.pieceId) || job.requestPayload?.piecePackOverride));
    }
    if (type === "piece-pass") {
      return Boolean(reusableJobAudioPath(job) && (safeString(job.scoreId) || safeString(job.pieceId)));
    }
    return false;
  }

  function canCancelJob(type, job = {}) {
    return taskStatusForType(type, job) === "processing";
  }

  function summarizeTaskJob(type, job = {}) {
    const status = taskStatusForType(type, job);
    return {
      type,
      jobId: safeString(job.jobId),
      previousJobId: safeString(job.previousJobId),
      title: repairMojibakeText(job.title || job.pieceTitle || job.sectionTitle || job.scoreId || job.pieceId || job.jobId),
      scoreId: safeString(job.scoreId),
      pieceId: safeString(job.pieceId),
      status,
      stage: safeString(job.stage),
      progress: clamp(safeNumber(job.progress, status === "completed" || status === "failed" ? 1 : 0), 0, 1),
      updatedAt: safeString(job.updatedAt || job.completedAt || job.createdAt),
      createdAt: safeString(job.createdAt),
      retryable: safeBoolean(job.retryable, status === "failed"),
      interruptedByRestart: safeBoolean(job.interruptedByRestart, false),
      recoveryReason: safeString(job.recoveryReason),
      error: publicTaskError(job.error),
      actions: {
        canCancel: canCancelJob(type, job),
        canRetry: canRetryJob(type, job),
        canResume: canRetryJob(type, job),
      },
    };
  }

  async function readOpsJobs() {
    const [scoreStore, analysisStore, piecePassStore] = await Promise.all([
      readScoreStore(),
      readAnalysisJobStore(),
      readPiecePassJobStore(),
    ]);
    const jobs = [
      ...getArray(scoreStore.jobs).map((job) => summarizeTaskJob("score-import", normalizeScoreImportJob(job))),
      ...getArray(analysisStore.jobs).map((job) => summarizeTaskJob("analysis", normalizeAnalysisJob(job))),
      ...getArray(piecePassStore.jobs).map((job) => summarizeTaskJob("piece-pass", normalizePiecePassJob(job))),
    ].filter((job) => job.jobId);
    return jobs.sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0));
  }

  async function buildOpsHealth() {
    const [analyzer, jsonStoreFile, sqliteStoreFile, analysisFile, piecePassFile, archiveFiles, jobs] = await Promise.all([
      fetchAnalyzerStatus(),
      fileSummary(SCORE_STORE_FILE),
      fileSummary(SCORE_STORE_SQLITE_FILE),
      fileSummary(ANALYSIS_JOB_STORE_FILE),
      fileSummary(PIECE_PASS_JOB_STORE_FILE),
      listRecentArchiveFiles(5),
      readOpsJobs(),
    ]);
    const failedJobs = jobs.filter((job) => job.status === "failed").slice(0, 10);
    const processingJobs = jobs.filter((job) => job.status === "processing").slice(0, 10);
    const sqliteSummary = sqliteStoreFile.exists ? summarizeScoreStoreSqlite(SCORE_STORE_SQLITE_FILE) : null;
    const scoreBackend = scoreStoreUsesSqlite() ? "sqlite" : "json";
    return {
      ok: true,
      generatedAt: nowIso(),
      node: {
        pid: process.pid,
        version: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        port,
      },
      analyzer: {
        configured: Boolean(analyzer.configured),
        reachable: Boolean(analyzer.reachable),
        mode: safeString(analyzer.mode),
        serviceUrl: safeString(analyzer.serviceUrl),
        statusCode: nullableInteger(analyzer.statusCode),
        error: publicTaskError(analyzer.error),
      },
      cpuOnly: {
        preferCudaPython: safeString(process.env.ERHU_PREFER_CUDA_PYTHON, "false"),
        torchDevice: safeString(process.env.ERHU_TORCH_DEVICE, "cpu"),
        cudaVisibleDevices: safeString(process.env.CUDA_VISIBLE_DEVICES),
        expectedCpuOnly:
          safeString(process.env.ERHU_PREFER_CUDA_PYTHON, "false") === "false" &&
          safeString(process.env.ERHU_TORCH_DEVICE, "cpu") === "cpu" &&
          safeString(process.env.CUDA_VISIBLE_DEVICES) === "",
      },
      store: {
        backend: scoreBackend,
        configuredBackend: SCORE_STORE_BACKEND,
        dataDir: DATA_DIR,
        scoreJson: jsonStoreFile,
        scoreSqlite: sqliteStoreFile,
        sqliteSummary,
        analysisJobs: analysisFile,
        piecePassJobs: piecePassFile,
        archiveDir: STORE_ARCHIVE_DIR,
        recentArchives: archiveFiles,
      },
      tasks: {
        active: {
          scoreImports: activeScoreImportTasks.size,
          analyses: activeAnalysisTasks.size,
          piecePasses: activePiecePassTasks.size,
        },
        queues: {
          scoreImports: SCORE_IMPORT_TASK_GATE.stats(),
          analyses: ANALYSIS_TASK_GATE.stats(),
          piecePasses: PIECE_PASS_TASK_GATE.stats(),
        },
        counts: {
          total: jobs.length,
          processing: jobs.filter((job) => job.status === "processing").length,
          failed: jobs.filter((job) => job.status === "failed").length,
          completed: jobs.filter((job) => job.status === "completed").length,
        },
        processingJobs,
        recentFailedJobs: failedJobs,
      },
      logs: {
        production: {
          server: path.join(DATA_DIR, "prod-server.log"),
          serverError: path.join(DATA_DIR, "prod-server-error.log"),
          analyzer: path.join(DATA_DIR, "prod-analyzer.log"),
          analyzerError: path.join(DATA_DIR, "prod-analyzer-error.log"),
        },
        preview: {
          server: path.join(DATA_DIR, "preview-server.log"),
          serverError: path.join(DATA_DIR, "preview-server-error.log"),
          analyzer: path.join(DATA_DIR, "preview-analyzer.log"),
          analyzerError: path.join(DATA_DIR, "preview-analyzer-error.log"),
        },
        perfTrace: PERF_TRACE_FILE,
      },
    };
  }

  function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  function normalizeOpsJobType(type) {
    const value = safeString(type).toLowerCase();
    if (value === "score" || value === "score-import" || value === "score-imports") return "score-import";
    if (value === "analysis" || value === "analyze") return "analysis";
    if (value === "piece" || value === "piece-pass" || value === "piecepass") return "piece-pass";
    return "";
  }

  async function cancelOpsJob(type, jobId) {
    const normalizedType = normalizeOpsJobType(type);
    const id = safeString(jobId);
    if (!normalizedType || !id) throw httpError(400, "invalid job type or job id");
    if (normalizedType === "score-import") {
      return enqueueStoreOperation(SCORE_STORE_FILE, async () => {
        const store = await readScoreStoreUnlocked();
        const index = store.jobs.findIndex((job) => job.jobId === id);
        if (index < 0) throw httpError(404, "job not found");
        const current = normalizeScoreImportJob(store.jobs[index]);
        if (current.omrStatus !== "processing") throw httpError(409, "only processing jobs can be cancelled");
        cancelledScoreImportJobIds.add(id);
        const nextJob = normalizeScoreImportJob({
          ...current,
          omrStatus: "failed",
          progress: 1,
          stage: "cancelled",
          error: "user cancelled",
          retryable: true,
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
        store.jobs[index] = nextJob;
        await writeScoreStoreUnlocked(store);
        SCORE_IMPORT_TASK_GATE.cancel(id);
        activeScoreImportTasks.delete(id);
        return summarizeTaskJob("score-import", nextJob);
      });
    }
    if (normalizedType === "analysis") {
      return enqueueStoreOperation(ANALYSIS_JOB_STORE_FILE, async () => {
        const store = await readAnalysisJobStoreUnlocked();
        const index = store.jobs.findIndex((job) => job.jobId === id);
        if (index < 0) throw httpError(404, "job not found");
        const current = normalizeAnalysisJob(store.jobs[index]);
        if (current.status !== "processing") throw httpError(409, "only processing jobs can be cancelled");
        cancelledAnalysisJobIds.add(id);
        const nextJob = normalizeAnalysisJob({
          ...current,
          status: "failed",
          progress: 1,
          stage: "cancelled",
          error: "user cancelled",
          retryable: false,
          completedAt: nowIso(),
          updatedAt: nowIso(),
        });
        store.jobs[index] = nextJob;
        await writeAnalysisJobStoreUnlocked(store);
        ANALYSIS_TASK_GATE.cancel(id);
        activeAnalysisTasks.delete(id);
        return summarizeTaskJob("analysis", nextJob);
      });
    }
    return enqueueStoreOperation(PIECE_PASS_JOB_STORE_FILE, async () => {
      const store = await readPiecePassJobStoreUnlocked();
      const index = store.jobs.findIndex((job) => job.jobId === id);
      if (index < 0) throw httpError(404, "job not found");
      const current = normalizePiecePassJob(store.jobs[index]);
      if (current.status !== "processing") throw httpError(409, "only processing jobs can be cancelled");
      cancelledPiecePassJobIds.add(id);
      const nextJob = normalizePiecePassJob({
        ...current,
        status: "failed",
        progress: 1,
        stage: "cancelled",
        error: "user cancelled",
        retryable: false,
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
      store.jobs[index] = nextJob;
      await writePiecePassJobStoreUnlocked(store);
      const activeTask = activePiecePassTasks.get(id);
      PIECE_PASS_TASK_GATE.cancel(id);
      if (activeTask?.child) {
        killProcessTree(activeTask.child);
      }
      activePiecePassTasks.delete(id);
      return summarizeTaskJob("piece-pass", nextJob);
    });
  }

  async function resumeScoreImportJob(jobId, operation = "resume") {
    if (!SCORE_IMPORT_TASK_GATE.canAccept()) throw httpError(429, "score-import queue is full");
    const previousJobId = safeString(jobId);
    const store = await readScoreStore();
    const previous = store.jobs.find((job) => job.jobId === previousJobId);
    if (!previous) throw httpError(404, "job not found");
    const normalizedPrevious = normalizeScoreImportJob(previous);
    if (normalizedPrevious.omrStatus !== "failed") throw httpError(409, "only failed score-import jobs can be retried");
    const sourcePdfAbs = dataWebPathToAbsolute(normalizedPrevious.sourcePdfPath);
    if (!sourcePdfAbs || !fsSync.existsSync(sourcePdfAbs)) {
      throw httpError(409, "job has no reusable PDF payload");
    }

    const jobIdNew = createId("scorejob");
    const jobDir = path.join(SCORE_IMPORTS_DIR, jobIdNew);
    const pdfPath = path.join(jobDir, "source.pdf");
    const webPdfPath = toWebDataPath("score-imports", jobIdNew, "source.pdf");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.copyFile(sourcePdfAbs, pdfPath);
    const titleHint = safeString(normalizedPrevious.title, path.parse(normalizedPrevious.originalFilename || "score").name);
    const selectedPartHint = safeString(normalizedPrevious.selectedPart, "erhu") || "erhu";
    const originalFilename = safeString(normalizedPrevious.originalFilename, path.basename(sourcePdfAbs));
    const pdfHash = safeString(normalizedPrevious.pdfHash) || sha1(await fs.readFile(pdfPath));
    const previewPages = [{ pageNumber: 1, type: "pdf", url: webPdfPath }];
    const knownPiece = findKnownPieceForPdf(titleHint, originalFilename);
    const fallbackPiece = knownPiece ? cloneLibraryPieceForImport(knownPiece) : null;
    const initialJob = await upsertScoreImportJob({
      jobId: jobIdNew,
      previousJobId,
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
      selectedPartConfirmed: safeBoolean(normalizedPrevious.selectedPartConfirmed, false),
      omrStats: { mode: "pending", pageCount: getArray(previewPages).length },
      warnings: [operation === "retry" ? "任务已重新提交。" : "任务已创建新的续跑任务。"],
      error: "",
      progress: 0.05,
      stage: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    void launchScoreImportTask({
      jobId: jobIdNew,
      previousJobId,
      titleHint,
      selectedPartHint,
      pdfHash,
      pdfPath,
      webPdfPath,
      originalFilename,
      fallbackPiece,
      previewPages,
      selectedPartConfirmed: safeBoolean(normalizedPrevious.selectedPartConfirmed, false),
    });
    return summarizeTaskJob("score-import", initialJob);
  }

  function buildReusableAnalysisPayload(job = {}) {
    const requestPayload = job.requestPayload && typeof job.requestPayload === "object" ? job.requestPayload : {};
    const audioPath = reusableJobAudioPath(job);
    if (!audioPath) return null;
    return {
      ...requestPayload,
      participantId: safeString(requestPayload.participantId, job.participantId),
      groupId: safeString(requestPayload.groupId, job.groupId || "self-practice"),
      sessionStage: safeString(requestPayload.sessionStage, job.sessionStage || "self-practice"),
      scoreId: safeString(requestPayload.scoreId, job.scoreId),
      pieceId: safeString(requestPayload.pieceId, job.pieceId),
      sectionId: safeString(requestPayload.sectionId, job.sectionId),
      preprocessMode: safeString(requestPayload.preprocessMode, job.preprocessMode || "off"),
      separationMode: safeString(requestPayload.separationMode, job.separationMode || requestPayload.preprocessMode || "auto"),
      audioPath,
      audioHash: safeString(requestPayload.audioHash, job.audioHash),
      audioSubmission: requestPayload.audioSubmission || job.audioSubmission || null,
      audioDataUrl: null,
      async: true,
    };
  }

  async function resumeAnalysisJob(jobId, operation = "resume") {
    if (!ANALYSIS_TASK_GATE.canAccept()) throw httpError(429, "analysis queue is full");
    const previousJobId = safeString(jobId);
    const store = await readAnalysisJobStore();
    const previous = store.jobs.find((job) => job.jobId === previousJobId);
    if (!previous) throw httpError(404, "job not found");
    const normalizedPrevious = normalizeAnalysisJob(previous);
    if (normalizedPrevious.status !== "failed") throw httpError(409, "only failed analysis jobs can be retried");
    const reusablePayload = buildReusableAnalysisPayload(normalizedPrevious);
    if (!reusablePayload) throw httpError(409, "job has no reusable audio payload");

    const newJobId = createId("analysisjob");
    const initialJob = await upsertAnalysisJob({
      jobId: newJobId,
      previousJobId,
      participantId: safeString(reusablePayload.participantId),
      groupId: safeString(reusablePayload.groupId, "self-practice"),
      sessionStage: safeString(reusablePayload.sessionStage, "self-practice"),
      scoreId: safeString(reusablePayload.scoreId),
      pieceId: safeString(reusablePayload.pieceId),
      sectionId: safeString(reusablePayload.sectionId),
      audioHash: safeString(reusablePayload.audioHash),
      audioPath: safeString(reusablePayload.audioPath),
      audioSubmission: reusablePayload.audioSubmission || null,
      preprocessMode: safeString(reusablePayload.preprocessMode),
      separationMode: safeString(reusablePayload.separationMode),
      requestPayload: reusablePayload,
      status: "processing",
      progress: 0.04,
      stage: "queued",
      message: operation === "retry" ? "分析任务已重新提交。" : "分析任务已创建新的续跑任务。",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    void launchAnalysisTask({
      jobId: newJobId,
      previousJobId,
      payload: reusablePayload,
    });
    return summarizeTaskJob("analysis", initialJob);
  }

  function buildReusablePiecePassPayload(job = {}) {
    const requestPayload = job.requestPayload && typeof job.requestPayload === "object" ? job.requestPayload : {};
    const audioPath = reusableJobAudioPath(job);
    if (!audioPath) return null;
    const sourceType = safeString(job.sourceType, safeString(job.scoreId) ? "score" : "piece");
    const pieceKey = sourceType === "score"
      ? safeString(job.scoreId || requestPayload.scoreId || job.pieceId)
      : safeString(job.pieceId || requestPayload.pieceId);
    if (!pieceKey) return null;
    return {
      payload: {
        ...requestPayload,
        participantId: safeString(requestPayload.participantId, job.participantId),
        scoreId: sourceType === "score" ? pieceKey : safeString(requestPayload.scoreId, job.scoreId),
        pieceId: sourceType === "piece" ? pieceKey : safeString(requestPayload.pieceId),
        title: safeString(requestPayload.title, job.pieceTitle),
        preprocessMode: safeString(requestPayload.preprocessMode, job.preprocessMode || "auto"),
        audioPath,
        audioHash: safeString(requestPayload.audioHash, job.audioHash),
        audioSubmission: requestPayload.audioSubmission || job.audioSubmission || null,
        audioDataUrl: null,
      },
      pieceKey,
      pieceTitle: safeString(job.pieceTitle, pieceKey),
      sourceType,
    };
  }

  async function resumePiecePassJob(jobId, operation = "resume") {
    if (!PIECE_PASS_TASK_GATE.canAccept()) throw httpError(429, "piece-pass queue is full");
    const previousJobId = safeString(jobId);
    const store = await readPiecePassJobStore();
    const previous = store.jobs.find((job) => job.jobId === previousJobId);
    if (!previous) throw httpError(404, "job not found");
    const normalizedPrevious = normalizePiecePassJob(previous);
    if (normalizedPrevious.status !== "failed") throw httpError(409, "only failed piece-pass jobs can be retried");
    const reusable = buildReusablePiecePassPayload(normalizedPrevious);
    if (!reusable) throw httpError(409, "job has no reusable payload");

    const newJobId = createId("piecepassjob");
    const initialJob = await upsertPiecePassJob({
      jobId: newJobId,
      previousJobId,
      participantId: safeString(reusable.payload.participantId),
      scoreId: safeString(reusable.payload.scoreId),
      pieceId: safeString(reusable.pieceKey),
      pieceTitle: safeString(reusable.pieceTitle),
      sourceType: safeString(reusable.sourceType),
      preprocessMode: safeString(reusable.payload.preprocessMode, "auto"),
      status: "processing",
      progress: 0.04,
      stage: "queued",
      message: operation === "retry" ? "整曲分析任务已重新提交。" : "整曲分析任务已创建新的续跑任务。",
      audioHash: safeString(reusable.payload.audioHash),
      audioPath: safeString(reusable.payload.audioPath),
      audioSubmission: reusable.payload.audioSubmission || null,
      requestPayload: reusable.payload,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    void launchPiecePassTask({
      jobId: newJobId,
      previousJobId,
      payload: reusable.payload,
      pieceKey: reusable.pieceKey,
      pieceTitle: reusable.pieceTitle,
      sourceType: reusable.sourceType,
    });
    return summarizeTaskJob("piece-pass", initialJob);
  }

  async function retryOpsJob(type, jobId, operation = "retry") {
    const normalizedType = normalizeOpsJobType(type);
    if (normalizedType === "score-import") {
      return resumeScoreImportJob(jobId, operation);
    }
    if (normalizedType === "analysis") {
      return resumeAnalysisJob(jobId, operation);
    }
    if (normalizedType === "piece-pass") {
      return resumePiecePassJob(jobId, operation);
    }
    throw httpError(400, "invalid job type");
  }

  router.get("/api/health", (req, res) => {
    res.json({ ok: true, service: "ai-erhu-research-prototype", at: nowIso() });
  });

  router.get("/api/erhu/analyzer-status", async (req, res) => {
    const analyzer = await fetchAnalyzerStatus();
    res.json({ ok: true, analyzer });
  });

  router.get("/api/erhu/ops/health", async (req, res) => {
    try {
      res.json(await buildOpsHealth());
    } catch (error) {
      res.status(500).json({ ok: false, error: publicTaskError(error?.message) || "health check failed" });
    }
  });

  router.get("/api/erhu/ops/jobs", async (req, res) => {
    try {
      const jobs = await readOpsJobs();
      res.json({ ok: true, jobs });
    } catch (error) {
      res.status(500).json({ ok: false, error: publicTaskError(error?.message) || "job list failed" });
    }
  });

  router.post("/api/erhu/ops/jobs/:type/:jobId/cancel", async (req, res) => {
    try {
      const job = await cancelOpsJob(req.params.type, req.params.jobId);
      res.json({ ok: true, job });
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false, error: publicTaskError(error?.message) || "cancel failed" });
    }
  });

  router.post("/api/erhu/ops/jobs/:type/:jobId/retry", async (req, res) => {
    try {
      const job = await retryOpsJob(req.params.type, req.params.jobId, "retry");
      res.status(202).json({ ok: true, job, previousJobId: safeString(req.params.jobId) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false, error: publicTaskError(error?.message) || "retry failed" });
    }
  });

  router.post("/api/erhu/ops/jobs/:type/:jobId/resume", async (req, res) => {
    try {
      const job = await retryOpsJob(req.params.type, req.params.jobId, "resume");
      res.status(202).json({ ok: true, job, previousJobId: safeString(req.params.jobId) });
    } catch (error) {
      res.status(error.statusCode || 500).json({ ok: false, error: publicTaskError(error?.message) || "resume failed" });
    }
  });

  return router;
}
