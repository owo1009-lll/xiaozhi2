import fs from "node:fs";
import path from "node:path";
import express from "express";

import { safeString } from "./baseUtils.js";
import {
  buildWesternAlignmentPreview,
  buildWesternStudentAnalysis,
  findWesternControlledSubmission,
  listWesternControlledSubmissions,
  parsePreviewQuery,
  parseStudentAnalysisPayload,
  recordWesternControlledSubmissionReview,
  recordWesternAlignmentPreviewReview,
  recordWesternStudentReview,
  runWesternControlledSubmissionBatch,
} from "./westernStringsAlignmentService.js";

function defaultParseIncomingPayload(req) {
  return req.body || {};
}

async function defaultPersistAudio() {
  return { audioPath: "", audioHash: "" };
}

async function defaultPersistScorePhoto() {
  return { scorePhotoPath: "", scorePhotoHash: "" };
}

function defaultAudioSubmissionFromUpload(file, fallback = {}) {
  if (!file) return fallback || null;
  return fallback || null;
}

function defaultScorePhotoSubmissionFromUpload(file, fallback = {}) {
  if (!file) return fallback || null;
  return fallback || null;
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function createWesternStringsRouter({
  repoRoot,
  upload = null,
  audioCacheDir = "",
  scorePhotoCacheDir = "",
  parseIncomingPayload = defaultParseIncomingPayload,
  buildAudioSubmissionFromUpload = defaultAudioSubmissionFromUpload,
  buildScorePhotoSubmissionFromUpload = defaultScorePhotoSubmissionFromUpload,
  persistUploadedAudioFile = defaultPersistAudio,
  persistPayloadAudio = defaultPersistAudio,
  persistUploadedScorePhotoFile = defaultPersistScorePhoto,
  persistPayloadScorePhoto = defaultPersistScorePhoto,
} = {}) {
  const router = express.Router();

  router.get("/api/strings/alignment-preview", async (req, res) => {
    try {
      const preview = await buildWesternAlignmentPreview({
        repoRoot,
        ...parsePreviewQuery(req.query || {}),
      });
      return res.json(preview);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to build western strings alignment preview.") });
    }
  });

  router.post("/api/strings/alignment-preview/reviews", async (req, res) => {
    try {
      const result = await recordWesternAlignmentPreviewReview({
        repoRoot,
        payload: req.body || {},
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: safeString(error?.message, "failed to save western strings preview review.") });
    }
  });

  async function parseStudentSubmission(req) {
    const payload = parseIncomingPayload(req);
    const parsed = parseStudentAnalysisPayload(payload || {});
    const uploadedAudio = req.files?.audio?.[0] || req.file || null;
    const uploadedScorePhoto = req.files?.scorePhoto?.[0] || null;
    const persistedAudio = uploadedAudio
      ? await persistUploadedAudioFile(uploadedAudio, { audioCacheDir })
      : await persistPayloadAudio(payload || {}, { audioCacheDir });
    const persistedScorePhoto = uploadedScorePhoto
      ? await persistUploadedScorePhotoFile(uploadedScorePhoto, { scorePhotoCacheDir })
      : await persistPayloadScorePhoto(payload || {}, { scorePhotoCacheDir });
    const scorePhotoRequested = Boolean(
      uploadedScorePhoto
      || safeString(parsed.scorePhotoPath).trim()
      || safeString(payload?.scorePhotoDataUrl).trim(),
    );
    if (scorePhotoRequested && !safeString(persistedScorePhoto.scorePhotoPath).trim()) {
      const error = new Error("score photo could not be persisted.");
      error.statusCode = 400;
      throw error;
    }
    return {
      ...parsed,
      audioPath: persistedAudio.audioPath || parsed.audioPath,
      audioHash: persistedAudio.audioHash || parsed.audioHash,
      audioSubmission: uploadedAudio
        ? buildAudioSubmissionFromUpload(uploadedAudio, parsed.audioSubmission)
        : parsed.audioSubmission,
      scorePhotoPath: persistedScorePhoto.scorePhotoPath || "",
      scorePhotoHash: persistedScorePhoto.scorePhotoHash || "",
      scorePhotoSubmission: uploadedScorePhoto
        ? buildScorePhotoSubmissionFromUpload(uploadedScorePhoto, parsed.scorePhotoSubmission)
        : parsed.scorePhotoSubmission,
    };
  }

  const analyzeHandlers = [];
  if (upload?.fields) {
    analyzeHandlers.push(upload.fields([
      { name: "audio", maxCount: 1 },
      { name: "scorePhoto", maxCount: 1 },
    ]));
  } else if (upload?.single) {
    analyzeHandlers.push(upload.single("audio"));
  }
  analyzeHandlers.push(async (req, res) => {
    try {
      const parsed = await parseStudentSubmission(req);
      const analysis = await buildWesternStudentAnalysis({
        repoRoot,
        dataset: parsed.dataset,
        piece: parsed.piece,
        limit: parsed.limit,
        recordingId: parsed.recordingId,
        submissionPayload: parsed,
      });
      return res.json({ ok: true, analysis });
    } catch (error) {
      return res.status(Number(error?.statusCode) || 500).json({ ok: false, error: safeString(error?.message, "failed to build western strings student analysis.") });
    }
  });
  router.post("/api/strings/analyze", ...analyzeHandlers);

  router.get("/api/strings/controlled-submissions", async (req, res) => {
    try {
      const limit = Math.max(0, Math.round(Number(req.query?.limit || 50)));
      const result = await listWesternControlledSubmissions({ repoRoot, limit });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to list western strings controlled submissions.") });
    }
  });

  router.get("/api/strings/controlled-submissions/:submissionId/audio", async (req, res) => {
    try {
      const submission = await findWesternControlledSubmission({ repoRoot, submissionId: req.params.submissionId });
      const audioPath = path.resolve(safeString(submission?.audioPath));
      const allowedRoot = path.resolve(repoRoot, "data", "analysis-audio-cache");
      if (!submission || !audioPath || !isPathInside(allowedRoot, audioPath) || !fs.existsSync(audioPath)) {
        return res.status(404).json({ ok: false, error: "controlled submission audio not found." });
      }
      return res.sendFile(audioPath);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to read controlled submission audio.") });
    }
  });

  router.get("/api/strings/controlled-submissions/:submissionId/score-photo", async (req, res) => {
    try {
      const submission = await findWesternControlledSubmission({ repoRoot, submissionId: req.params.submissionId });
      const scorePhotoPath = path.resolve(safeString(submission?.scorePhotoPath));
      const allowedRoot = path.resolve(scorePhotoCacheDir || path.join(repoRoot, "data", "analysis-score-photo-cache"));
      if (!submission || !scorePhotoPath || !isPathInside(allowedRoot, scorePhotoPath) || !fs.existsSync(scorePhotoPath)) {
        return res.status(404).json({ ok: false, error: "controlled submission score photo not found." });
      }
      return res.sendFile(scorePhotoPath);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to read controlled submission score photo.") });
    }
  });

  router.post("/api/strings/controlled-submissions/reviews", async (req, res) => {
    try {
      const result = await recordWesternControlledSubmissionReview({
        repoRoot,
        payload: req.body || {},
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: safeString(error?.message, "failed to save controlled submission review.") });
    }
  });

  router.post("/api/strings/controlled-submissions/run-batch", async (req, res) => {
    try {
      const limit = Math.max(0, Math.round(Number(req.body?.limit || 20)));
      const result = await runWesternControlledSubmissionBatch({ repoRoot, limit });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to run controlled submission batch.") });
    }
  });

  router.post("/api/strings/review", async (req, res) => {
    try {
      const result = await recordWesternStudentReview({
        repoRoot,
        payload: req.body || {},
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: safeString(error?.message, "failed to save western strings student review.") });
    }
  });

  return router;
}
