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

function defaultAudioSubmissionFromUpload(file, fallback = {}) {
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
  parseIncomingPayload = defaultParseIncomingPayload,
  buildAudioSubmissionFromUpload = defaultAudioSubmissionFromUpload,
  persistUploadedAudioFile = defaultPersistAudio,
  persistPayloadAudio = defaultPersistAudio,
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
    const persistedAudio = req.file
      ? await persistUploadedAudioFile(req.file, { audioCacheDir })
      : await persistPayloadAudio(payload || {}, { audioCacheDir });
    return {
      ...parsed,
      audioPath: persistedAudio.audioPath || parsed.audioPath,
      audioHash: persistedAudio.audioHash || parsed.audioHash,
      audioSubmission: req.file
        ? buildAudioSubmissionFromUpload(req.file, parsed.audioSubmission)
        : parsed.audioSubmission,
    };
  }

  const analyzeHandlers = [];
  if (upload?.single) {
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
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to build western strings student analysis.") });
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
