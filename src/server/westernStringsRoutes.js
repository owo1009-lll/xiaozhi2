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
  listWesternControlledSubmissionModelSuggestions,
  listWesternControlledSubmissionScoreNotes,
  recordWesternControlledSubmissionReview,
  recordWesternAlignmentPreviewReview,
  recordWesternStudentReview,
  runWesternControlledSubmissionBatch,
} from "./westernStringsAlignmentService.js";
import {
  buildWesternStudentGateView,
  listWesternStudentSubmissions,
} from "./westernStudentGateService.js";
import {
  CONTENT_SAFETY_UNAVAILABLE_MESSAGE,
  ContentSafetyError,
} from "./wechatContentSafety.js";
import {
  buildScoreDiagnosis,
  findEditionCoordinates,
  findEditionRenderPath,
  listSupportedEditions,
} from "./westernScoreEditions.js";
import { isTunnelRequest } from "./publicAccessGuard.js";

const WEB_STUDENT_CAPABILITY_PATTERN = /^stu-v2-[a-f0-9]{32}$/;

function secureStudentCapabilityError() {
  const error = new Error("A secure student access token is required.");
  error.statusCode = 401;
  return error;
}

function defaultParseIncomingPayload(req) {
  return req.body || {};
}

async function defaultPersistAudio() {
  return { audioPath: "", audioHash: "" };
}

async function defaultPersistScorePhoto() {
  return { scorePhotoPath: "", scorePhotoHash: "" };
}

function defaultSubmissionFromUpload(file, fallback = {}) {
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
  buildAudioSubmissionFromUpload = defaultSubmissionFromUpload,
  buildScorePhotoSubmissionFromUpload = defaultSubmissionFromUpload,
  persistUploadedAudioFile = defaultPersistAudio,
  persistPayloadAudio = defaultPersistAudio,
  persistUploadedScorePhotoFile = defaultPersistScorePhoto,
  persistPayloadScorePhoto = defaultPersistScorePhoto,
  contentSafety = null,
} = {}) {
  const router = express.Router();

  async function buildStudentAnalysis(parsed) {
    const { isWechatMiniProgram, wechatLoginCode, ...submissionPayload } = parsed || {};
    return buildWesternStudentAnalysis({
      repoRoot,
      dataset: submissionPayload.dataset,
      piece: submissionPayload.piece,
      limit: submissionPayload.limit,
      recordingId: submissionPayload.recordingId,
      submissionPayload,
    });
  }

  function buildPublicAnalysisView(analysis = {}) {
    return {
      studentReady: false,
      submissionAccepted: analysis?.submissionAccepted === true,
      blockingReasons: Array.isArray(analysis?.blockingReasons) ? analysis.blockingReasons : [],
    };
  }

  if (typeof contentSafety?.setReleaseSubmission === "function") {
    contentSafety.setReleaseSubmission(async (submission) => buildStudentAnalysis(submission));
  }

  function sendAnalyzeError(res, error) {
    const isSafetyError = error instanceof ContentSafetyError;
    return res.status(Number(error?.statusCode) || 500).json({
      ok: false,
      error: isSafetyError
        ? error.message
        : safeString(error?.message, "failed to build western strings student analysis."),
      ...(isSafetyError ? { code: error.code } : {}),
    });
  }

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
    const isWechatMiniProgram = safeString(payload?.clientPlatform).trim() === "wechat-mini-program";
    if (isTunnelRequest(req)
      && !isWechatMiniProgram
      && !WEB_STUDENT_CAPABILITY_PATTERN.test(parsed.studentRef)) {
      throw secureStudentCapabilityError();
    }
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
      isWechatMiniProgram,
      wechatLoginCode: safeString(payload?.wechatLoginCode).trim(),
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

  router.get("/api/wechat/content-safety-callback", async (req, res) => {
    if (!contentSafety) return res.sendStatus(404);
    try {
      const echo = await contentSafety.verifyCallbackUrl(req.query || {});
      if (!echo) return res.sendStatus(403);
      return res.type("text/plain").send(echo);
    } catch {
      return res.sendStatus(403);
    }
  });

  router.post("/api/wechat/content-safety-callback", async (req, res) => {
    if (!contentSafety) return res.sendStatus(404);
    const result = await contentSafety.receiveCallback({ query: req.query || {}, body: req.body || {} });
    return result.ok ? res.type("text/plain").send("success") : res.sendStatus(result.statusCode || 403);
  });

  router.get("/api/wechat/content-safety-media/:token", async (req, res) => {
    if (!contentSafety) return res.sendStatus(404);
    return contentSafety.sendPendingMedia({ token: req.params.token, res });
  });

  router.get("/api/strings/content-safety-status", async (req, res) => {
    if (!contentSafety) {
      return res.status(503).json({ ok: false, error: CONTENT_SAFETY_UNAVAILABLE_MESSAGE });
    }
    return res.json({ ok: true, ...(await contentSafety.getPublicStatus(safeString(req.query?.ticket).trim())) });
  });

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
      if (parsed.isWechatMiniProgram) {
        if (!contentSafety) throw new ContentSafetyError(CONTENT_SAFETY_UNAVAILABLE_MESSAGE);
        const moderation = await contentSafety.moderateMiniProgramSubmission({
          loginCode: parsed.wechatLoginCode,
          content: parsed.piece,
          submission: (() => {
            const { isWechatMiniProgram, wechatLoginCode, ...submission } = parsed;
            return submission;
          })(),
        });
        parsed.studentRef = safeString(moderation.studentRef).trim();
        if (!parsed.studentRef) throw new ContentSafetyError(CONTENT_SAFETY_UNAVAILABLE_MESSAGE);
        if (moderation.status === "pending") {
          return res.status(202).json({
            ok: true,
            moderationPending: true,
            moderationTicket: moderation.ticket,
          });
        }
      }
      const analysis = await buildStudentAnalysis(parsed);
      return res.json({
        ok: true,
        analysis: isTunnelRequest(req) ? buildPublicAnalysisView(analysis) : analysis,
      });
    } catch (error) {
      return sendAnalyzeError(res, error);
    }
  });
  router.post("/api/strings/analyze", ...analyzeHandlers);

  router.get("/api/strings/student-gate", (req, res) => {
    try {
      return res.json(buildWesternStudentGateView());
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to build western strings student gate view.") });
    }
  });

  router.get("/api/strings/score-editions", async (req, res) => {
    try {
      const result = await listSupportedEditions({ repoRoot });
      const pieceId = safeString(req.query?.pieceId).trim();
      if (pieceId) {
        result.editions = result.editions.filter((edition) => edition.pieceId === pieceId);
      }
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to list supported score editions.") });
    }
  });

  router.get("/api/strings/score-render", async (req, res) => {
    try {
      const renderPath = await findEditionRenderPath({
        repoRoot,
        pieceId: safeString(req.query?.pieceId),
        editionId: safeString(req.query?.editionId),
        page: req.query?.page,
      });
      if (!renderPath) {
        return res.status(404).json({ ok: false, error: "score render not found for this piece." });
      }
      res.set("Cache-Control", "public, max-age=86400, immutable");
      return res.sendFile(renderPath);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to read score render.") });
    }
  });

  router.get("/api/strings/score-coordinates", async (req, res) => {
    try {
      const coordinates = await findEditionCoordinates({
        repoRoot,
        pieceId: safeString(req.query?.pieceId),
        editionId: safeString(req.query?.editionId),
      });
      if (!coordinates) {
        return res.status(404).json({ ok: false, error: "score coordinates not found for this piece." });
      }
      return res.json({ ok: true, coordinates });
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to read score coordinates.") });
    }
  });

  router.get("/api/strings/score-diagnosis", async (req, res) => {
    try {
      const result = await buildScoreDiagnosis({
        repoRoot,
        pieceId: safeString(req.query?.pieceId),
        editionId: safeString(req.query?.editionId),
        submissionId: safeString(req.query?.submissionId),
        demo: safeString(req.query?.demo) === "1",
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeString(error?.message, "failed to build score diagnosis.") });
    }
  });

  router.get("/api/strings/student-submissions", async (req, res) => {
    try {
      const limit = Math.max(0, Math.round(Number(req.query?.limit || 20)));
      const isWechatMiniProgram = safeString(req.query?.clientPlatform).trim() === "wechat-mini-program";
      let studentRef = safeString(req.query?.studentRef).trim();
      if (isWechatMiniProgram) {
        if (typeof contentSafety?.resolveMiniProgramStudentRef !== "function") {
          throw new ContentSafetyError(CONTENT_SAFETY_UNAVAILABLE_MESSAGE);
        }
        studentRef = await contentSafety.resolveMiniProgramStudentRef(
          safeString(req.query?.wechatLoginCode).trim(),
        );
      } else if (isTunnelRequest(req) && !WEB_STUDENT_CAPABILITY_PATTERN.test(studentRef)) {
        throw secureStudentCapabilityError();
      }
      const result = await listWesternStudentSubmissions({
        repoRoot,
        studentRef,
        limit,
      });
      return res.json(result);
    } catch (error) {
      return res.status(Number(error?.statusCode) || 500).json({ ok: false, error: safeString(error?.message, "failed to list western strings student submissions.") });
    }
  });

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

  router.get("/api/strings/controlled-submissions/:submissionId/score-notes", async (req, res) => {
    try {
      const result = await listWesternControlledSubmissionScoreNotes({
        repoRoot,
        submissionId: req.params.submissionId,
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: safeString(error?.message, "failed to read controlled submission score notes.") });
    }
  });

  router.get("/api/strings/controlled-submissions/:submissionId/model-suggestions", async (req, res) => {
    try {
      const result = await listWesternControlledSubmissionModelSuggestions({
        repoRoot,
        submissionId: req.params.submissionId,
      });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: safeString(error?.message, "failed to read model suggestions.") });
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
      const submissionIds = Array.isArray(req.body?.submissionIds)
        ? req.body.submissionIds.map((submissionId) => safeString(submissionId).trim()).filter(Boolean)
        : [];
      const result = await runWesternControlledSubmissionBatch({ repoRoot, limit, submissionIds });
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
