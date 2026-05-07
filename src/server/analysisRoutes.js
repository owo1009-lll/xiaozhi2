import express from "express";
import { createId, getArray, nowIso, safeBoolean, safeString } from "./baseUtils.js";
import { queueFullPayload } from "./taskQueue.js";

export function createAnalysisRouter({
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
}) {
  const router = express.Router();

  router.get("/api/erhu/piece-pass/latest", async (req, res) => {
    const pieceId = safeString(req.query.pieceId);
    const scoreId = safeString(req.query.scoreId);
    const title = safeString(req.query.title);
    const audioHash = safeString(req.query.audioHash);
    const participantId = safeString(req.query.participantId);
    const piecePass = await readLatestPiecePassSummary({ pieceId, scoreId, title, audioHash, participantId });
    return res.json({ ok: true, piecePass });
  });

  router.post("/api/erhu/piece-pass-jobs", upload.single("audio"), async (req, res) => {
    if (!PIECE_PASS_TASK_GATE.canAccept()) {
      return res.status(429).json(queueFullPayload(PIECE_PASS_TASK_GATE));
    }
    const incomingPayload = parseIncomingPayload(req);
    const payload = {
      ...incomingPayload,
      audioSubmission: buildAudioSubmissionFromUpload(req.file, incomingPayload.audioSubmission),
    };
    const preparedPayload = await prepareAnalysisPayload(payload, req.file || null);
    if (!safeString(preparedPayload.audioPath)) {
      return res.status(400).json({ error: "audio is required." });
    }

    const target = await resolvePiecePassTarget({
      scoreId: safeString(payload.scoreId),
      pieceId: safeString(payload.pieceId),
      title: safeString(payload.title),
    });
    if (!target) {
      return res.status(404).json({ error: "piece for whole-piece analysis not found." });
    }

    const jobId = createId("piecepassjob");
    const initialJob = await upsertPiecePassJob({
      jobId,
      participantId: safeString(payload.participantId),
      scoreId: safeString(payload.scoreId),
      pieceId: safeString(target.pieceKey),
      pieceTitle: safeString(target.pieceTitle),
      sourceType: safeString(target.sourceType),
      preprocessMode: safeString(preparedPayload.preprocessMode, "auto"),
      status: "processing",
      progress: 0.04,
      stage: "queued",
      message: "整曲分析任务已提交，正在排队。",
      audioHash: safeString(preparedPayload.audioHash),
      audioPath: safeString(preparedPayload.audioPath),
      audioSubmission: preparedPayload.audioSubmission || null,
      requestPayload: { ...preparedPayload, audioDataUrl: null },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    void launchPiecePassTask({
      jobId,
      payload: preparedPayload,
      pieceKey: target.pieceKey,
      pieceTitle: target.pieceTitle,
      sourceType: target.sourceType,
    });

    return res.status(202).json({ ok: true, piecePassJobId: jobId, job: stripReusableJobPayload(initialJob) });
  });

  router.get("/api/erhu/piece-pass-jobs/:jobId", async (req, res) => {
    const store = await readPiecePassJobStore();
    const job = store.jobs.find((item) => item.jobId === req.params.jobId);
    if (!job) {
      if (activePiecePassTasks.has(req.params.jobId)) {
        return res.json({
          ok: true,
          job: stripReusableJobPayload(normalizePiecePassJob({
            jobId: req.params.jobId,
            status: "processing",
            progress: 0.1,
            stage: "queued",
            message: "整曲分析任务已提交，正在排队。",
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })),
        });
      }
      return res.status(404).json({ error: "piece-pass job not found." });
    }
    return res.json({ ok: true, job: stripReusableJobPayload(normalizePiecePassJob(job)) });
  });

  router.get("/api/erhu/pieces", (req, res) => {
    res.json({ ok: true, pieces: getErhuPieceSummaries() });
  });

  router.get("/api/erhu/pieces/from-score/:scoreId", async (req, res) => {
    const store = await readScoreStore();
    const score = getImportedScore(store, req.params.scoreId);
    if (!score) {
      return res.status(404).json({ error: "score not found" });
    }
    return res.json({ ok: true, piece: buildDerivedPieceFromScore(score) });
  });

  router.get("/api/erhu/pieces/:pieceId", async (req, res) => {
    const piece = getErhuPiece(req.params.pieceId);
    if (piece) {
      return res.json({ ok: true, piece });
    }
    const store = await readScoreStore();
    const importedScore = getImportedScore(store, req.params.pieceId)
      || store.scores.find((item) => safeString(item.pieceId) === req.params.pieceId)
      || null;
    if (!importedScore) {
      return res.status(404).json({ error: "piece not found" });
    }
    return res.json({ ok: true, piece: buildDerivedPieceFromScore(importedScore) });
  });

  router.post("/api/erhu/auto-detect-section", upload.single("audio"), async (req, res) => {
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

    const persistedAudio = req.file
      ? await persistUploadedAudioFile(req.file, { audioCacheDir: AUDIO_CACHE_DIR })
      : await persistPayloadAudio(payload, { audioCacheDir: AUDIO_CACHE_DIR });
    const preparedPayload = await normalizePreparedPayloadForAnalyzer(buildPreparedAudioPayload(
      payload,
      persistedAudio,
    ), toAnalyzerPath);

    const detectionPiece = importedScore ? buildDerivedPieceFromScore(importedScore) : piece;
    const detection = await autoDetectPieceSection({ ...preparedPayload, scoreId }, detectionPiece, {
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

  router.post("/api/erhu/analyze", upload.single("audio"), async (req, res) => {
    const incomingPayload = parseIncomingPayload(req);
    const payload = {
      ...incomingPayload,
      audioSubmission: buildAudioSubmissionFromUpload(req.file, incomingPayload.audioSubmission),
    };
    const preparedPayload = await prepareAnalysisPayload(payload, req.file || null);
    if (safeBoolean(payload.async, false)) {
      if (!ANALYSIS_TASK_GATE.canAccept()) {
        return res.status(429).json(queueFullPayload(ANALYSIS_TASK_GATE));
      }
      const jobId = createId("analysisjob");
      const initialJob = await upsertAnalysisJob({
        jobId,
        participantId: safeString(payload.participantId),
        groupId: safeString(payload.groupId, "self-practice"),
        sessionStage: safeString(payload.sessionStage, "self-practice"),
        scoreId: safeString(payload.scoreId),
        pieceId: safeString(payload.pieceId),
        sectionId: safeString(payload.sectionId),
        audioHash: safeString(preparedPayload.audioHash),
        audioPath: safeString(preparedPayload.audioPath),
        audioSubmission: preparedPayload.audioSubmission || null,
        preprocessMode: safeString(preparedPayload.preprocessMode),
        separationMode: safeString(preparedPayload.separationMode),
        requestPayload: { ...preparedPayload, audioDataUrl: null },
        status: "processing",
        progress: 0.04,
        stage: "queued",
        message: "分析任务已提交，正在排队。",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      void launchAnalysisTask({
        jobId,
        payload: preparedPayload,
      });
      return res.status(202).json({ ok: true, analysisJobId: jobId, job: stripReusableJobPayload(initialJob) });
    }

    try {
      const result = await executePreparedAnalysisRequest(preparedPayload);
      return res.json({
        ok: true,
        analysis: result.analysisRecord,
      });
    } catch (error) {
      if (String(error?.message || "").includes("piece section not found")) {
        return res.status(404).json({ error: "piece section not found." });
      }
      if (String(error?.message || "").includes("participantId is required")) {
        return res.status(400).json({ error: "participantId is required." });
      }
      return res.status(500).json({ error: safeString(error?.message, "analysis failed") });
    }
  });

  router.get("/api/erhu/analyze-jobs/:jobId", async (req, res) => {
    const store = await readAnalysisJobStore();
    const job = store.jobs.find((item) => item.jobId === req.params.jobId);
    if (!job) {
      if (activeAnalysisTasks.has(req.params.jobId)) {
        return res.json({
          ok: true,
          job: stripReusableJobPayload(normalizeAnalysisJob({
            jobId: req.params.jobId,
            status: "processing",
            progress: 0.1,
            stage: "queued",
            message: "分析任务已提交，正在排队。",
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })),
        });
      }
      return res.status(404).json({ error: "analysis job not found." });
    }
    return res.json({
      ok: true,
      job: await hydrateAnalysisJob(job),
    });
  });

  return router;
}
