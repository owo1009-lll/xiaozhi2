import express from "express";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createId,
  getArray,
  nowIso,
  safeBoolean,
  safeNumber,
  safeString,
  sha1,
} from "./baseUtils.js";
import { enqueueStoreOperation } from "./jsonStore.js";
import { buildCachedImportPreviewPages, buildReusedOmrStats } from "./omrStats.js";
import { queueFullPayload } from "./taskQueue.js";

export function createScoreRouter({
  upload,
  repoRoot,
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
  buildMarkingStatsFromSections,
  getImportedScore,
  activeScoreImportTasks,
}) {
  const router = express.Router();

  router.post("/api/erhu/scores/import-pdf", upload.single("pdf"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "pdf file is required." });
    }
    if (!SCORE_IMPORT_TASK_GATE.canAccept()) {
      return res.status(429).json(queueFullPayload(SCORE_IMPORT_TASK_GATE));
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
    const reusableScore = findReusableImportedScore(store, { pdfHash, selectedPart: selectedPartHint, allowReuse: true });

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
        selectedPartConfirmed: reusableScoreRecord.selectedPartConfirmed,
        selectedPartConfidence: reusableScoreRecord.selectedPartConfidence,
        partCandidates: reusableScoreRecord.partCandidates,
        sectionCount: getArray(reusableScoreRecord.sections).length,
        scoreLineStats: reusableScoreRecord.scoreLineStats,
        markingStats: reusableScoreRecord.markingStats,
        omrStats: buildReusedOmrStats(reusableScoreRecord.omrStats, previewPages),
        warnings: ["已复用相同 PDF 的识谱结果，已跳过重复读谱。"],
        cacheHit: true,
        progress: 1,
        stage: "completed",
        error: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      const persistedCachedJob = await enqueueStoreOperation(SCORE_STORE_FILE, async () => {
        const nextStore = await readScoreStoreUnlocked();
        const existingScoreIndex = nextStore.scores.findIndex((item) => item.scoreId === reusableScoreRecord.scoreId);
        if (existingScoreIndex >= 0) {
          nextStore.scores[existingScoreIndex] = reusableScoreRecord;
        } else {
          nextStore.scores.push(reusableScoreRecord);
        }
        const existingJobIndex = nextStore.jobs.findIndex((item) => item.jobId === cachedJob.jobId);
        if (existingJobIndex >= 0) {
          nextStore.jobs[existingJobIndex] = cachedJob;
        } else {
          nextStore.jobs.push(cachedJob);
        }
        await writeScoreStoreUnlocked(nextStore);
        return cachedJob;
      });
      return res.json({ ok: true, scoreImportJobId: persistedCachedJob.jobId, job: persistedCachedJob });
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
      selectedPartConfirmed: false,
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
      selectedPartConfirmed: false,
    });

    return res.status(202).json({ ok: true, scoreImportJobId: initialJob.jobId, job: initialJob });
  });

  router.post("/api/erhu/scores/import-musicxml", upload.single("musicxml"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "musicxml file is required." });
    }

    const originalName = req.file.originalname || "score.musicxml";
    const originalExt = path.extname(originalName).toLowerCase();
    const fileExt = [".musicxml", ".xml", ".mxl"].includes(originalExt) ? originalExt : ".musicxml";
    const titleHint = safeString(req.body?.titleHint, path.parse(originalName).name);
    const selectedPartHint = safeString(req.body?.selectedPartHint, "erhu") || "erhu";
    const instrument = safeString(req.body?.instrument).trim().toLowerCase();
    const scoreSource = safeString(req.body?.scoreSource, "musicxml").trim().toLowerCase() || "musicxml";
    const tempoKnown = safeBoolean(req.body?.tempoKnown, false);
    const tempoSource = safeString(req.body?.tempoSource, tempoKnown ? "musicxml" : "unknown").trim().toLowerCase() || (tempoKnown ? "musicxml" : "unknown");
    const musicxmlHash = sha1(req.file.buffer);
    const jobId = createId("scorejob");
    const jobDir = path.join(SCORE_IMPORTS_DIR, jobId);
    const musicxmlPath = path.join(jobDir, `source${fileExt}`);
    const webMusicXmlPath = toWebDataPath("score-imports", jobId, `source${fileExt}`);
    await fs.mkdir(jobDir, { recursive: true });
    await fs.writeFile(musicxmlPath, req.file.buffer);

    let jobResult = null;
    let serviceWarning = "";
    try {
      jobResult = await callExternalMusicXmlImportLongTimeout({
        jobId,
        musicxmlPath,
        originalFilename: originalName,
        titleHint,
        selectedPartHint,
        instrument,
        scoreSource,
        tempoKnown,
        tempoSource,
        outputDir: jobDir,
      });
    } catch (error) {
      serviceWarning = safeString(error?.message, "external MusicXML import unavailable");
    }

    let normalizedJob = normalizeScoreImportJob({
      jobId,
      originalFilename: originalName,
      title: titleHint,
      instrument,
      scoreSource,
      tempoKnown,
      tempoSource,
      sourcePdfPath: "",
      pdfHash: `musicxml:${musicxmlHash}`,
      omrStatus: "failed",
      omrConfidence: 0,
      musicxmlPath: webMusicXmlPath,
      previewPages: [],
      detectedParts: [selectedPartHint],
      selectedPart: selectedPartHint,
      selectedPartCandidates: [selectedPartHint],
      warnings: serviceWarning ? [serviceWarning] : [],
      musicxmlFallbackAvailable: false,
      fallbackActions: [],
      retryable: true,
      error: "MusicXML 导入失败。",
      progress: 1,
      stage: "failed",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    let scoreRecord = null;

    if (jobResult?.omrStatus === "completed" && jobResult.piecePack) {
      const upstreamScoreId = safeString(jobResult.scoreId);
      const scoreId = upstreamScoreId.startsWith("score-") ? upstreamScoreId : createId("score");
      const importedSections = getArray(jobResult.piecePack?.sections).length ? jobResult.piecePack.sections : [jobResult.piecePack];
      scoreRecord = normalizeImportedScoreRecord({
        scoreId,
        pieceId: safeString(jobResult.piecePack?.pieceId),
        title: safeString(jobResult.title, titleHint),
        composer: safeString(jobResult.piecePack?.composer, "MusicXML import"),
        instrument: safeString(jobResult.piecePack?.instrument, instrument),
        scoreSource: safeString(jobResult.piecePack?.scoreSourceType, scoreSource),
        tempoKnown: safeBoolean(jobResult.piecePack?.tempoKnown, tempoKnown),
        tempoSource: safeString(jobResult.piecePack?.tempoSource, tempoSource),
        sourcePdfPath: "",
        pdfHash: `musicxml:${musicxmlHash}`,
        musicxmlPath: webMusicXmlPath,
        omrStatus: "completed",
        omrConfidence: safeNumber(jobResult.omrConfidence, 0.88),
        omrStats: jobResult.omrStats,
        detectedParts: getArray(jobResult.detectedParts).length ? jobResult.detectedParts : [selectedPartHint],
        selectedPart: safeString(jobResult.selectedPart, selectedPartHint),
        selectedPartId: safeString(jobResult.piecePack?.selectedPartId),
        selectedPartConfidence: safeNumber(jobResult.selectedPartConfidence, safeNumber(jobResult.piecePack?.selectedPartConfidence, 0)),
        partCandidates: getArray(jobResult.partCandidates || jobResult.piecePack?.partCandidates),
        markingStats: jobResult.markingStats || jobResult.piecePack?.markingStats || buildMarkingStatsFromSections(importedSections),
        previewPages: [],
        sections: importedSections,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      normalizedJob = normalizeScoreImportJob({
        ...jobResult,
        jobId,
        scoreId,
        title: scoreRecord.title,
        instrument: scoreRecord.instrument,
        scoreSource: scoreRecord.scoreSource,
        tempoKnown: scoreRecord.tempoKnown,
        tempoSource: scoreRecord.tempoSource,
        sourcePdfPath: "",
        pdfHash: `musicxml:${musicxmlHash}`,
        musicxmlPath: webMusicXmlPath,
        originalFilename: originalName,
        previewPages: [],
        warnings: [...getArray(jobResult.warnings), ...(serviceWarning ? [serviceWarning] : [])],
        error: jobResult.error,
        progress: 1,
        stage: "completed",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    } else if (serviceWarning) {
      normalizedJob.warnings = [serviceWarning];
      normalizedJob.error = "MusicXML 导入失败，Python 识谱服务不可用或解析失败。";
    }

    normalizedJob = await enqueueStoreOperation(SCORE_STORE_FILE, async () => {
      const store = await readScoreStoreUnlocked();
      if (scoreRecord) {
        const existingScoreIndex = store.scores.findIndex((item) => item.scoreId === scoreRecord.scoreId);
        if (existingScoreIndex >= 0) {
          store.scores[existingScoreIndex] = scoreRecord;
        } else {
          store.scores.push(scoreRecord);
        }
      }
      const existingJobIndex = store.jobs.findIndex((item) => item.jobId === normalizedJob.jobId);
      if (existingJobIndex >= 0) {
        store.jobs[existingJobIndex] = normalizedJob;
      } else {
        store.jobs.push(normalizedJob);
      }
      await writeScoreStoreUnlocked(store);
      return normalizedJob;
    });

    return res.status(normalizedJob.omrStatus === "completed" ? 200 : 502).json({
      ok: normalizedJob.omrStatus === "completed",
      error: normalizedJob.omrStatus === "completed" ? "" : normalizedJob.error,
      scoreImportJobId: normalizedJob.jobId,
      job: normalizedJob,
    });
  });

  router.get("/api/erhu/scores/import-pdf/:jobId", async (req, res) => {
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

  router.get("/api/erhu/scores/:scoreId", async (req, res) => {
    const store = await readScoreStore();
    const score = getImportedScore(store, req.params.scoreId);
    if (!score) {
      return res.status(404).json({ error: "score not found." });
    }
    return res.json({ ok: true, score });
  });

  router.post("/api/erhu/scores/:scoreId/select-part", async (req, res) => {
    const selectedPartHint = safeString(req.body?.selectedPart || req.body?.selectedPartHint).trim();
    if (!selectedPartHint) {
      return res.status(400).json({ error: "selectedPart is required." });
    }
    if (!SCORE_IMPORT_TASK_GATE.canAccept()) {
      return res.status(429).json(queueFullPayload(SCORE_IMPORT_TASK_GATE));
    }
    const store = await readScoreStore();
    const score = getImportedScore(store, req.params.scoreId);
    if (!score) {
      return res.status(404).json({ error: "score not found." });
    }
    const webSourcePdfPath = safeString(score.sourcePdfPath);
    const sourcePdfAbs = webSourcePdfPath.startsWith("/data/")
      ? path.join(repoRoot, webSourcePdfPath.slice(1))
      : webSourcePdfPath;
    if (!sourcePdfAbs || !fsSync.existsSync(sourcePdfAbs)) {
      return res.status(404).json({ error: "source PDF file is not available for part rebuild." });
    }

    const jobId = createId("scorejob");
    const jobDir = path.join(SCORE_IMPORTS_DIR, jobId);
    const pdfPath = path.join(jobDir, "source.pdf");
    const webPdfPath = toWebDataPath("score-imports", jobId, "source.pdf");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.copyFile(sourcePdfAbs, pdfPath);

    const initialJob = await upsertScoreImportJob({
      jobId,
      originalFilename: path.basename(sourcePdfAbs),
      title: score.title,
      sourcePdfPath: webPdfPath,
      pdfHash: safeString(score.pdfHash),
      omrStatus: "processing",
      omrConfidence: 0,
      previewPages: buildCachedImportPreviewPages(score, [], webPdfPath),
      detectedParts: getArray(score.detectedParts),
      selectedPart: selectedPartHint,
      selectedPartCandidates: getArray(score.detectedParts),
      selectedPartConfirmed: true,
      partCandidates: getArray(score.partCandidates),
      omrStats: { mode: "pending", pageCount: getArray(score.previewPages).length },
      warnings: ["正在按新声部重新识谱。"],
      error: "",
      progress: 0.05,
      stage: "queued",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    void launchScoreImportTask({
      jobId,
      titleHint: score.title,
      selectedPartHint,
      selectedPartConfirmed: true,
      pdfHash: safeString(score.pdfHash),
      pdfPath,
      webPdfPath,
      originalFilename: path.basename(sourcePdfAbs),
      fallbackPiece: null,
      previewPages: initialJob.previewPages,
    });

    return res.status(202).json({ ok: true, scoreImportJobId: initialJob.jobId, job: initialJob });
  });

  return router;
}
