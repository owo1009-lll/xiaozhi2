import express from "express";

import { safeString } from "./baseUtils.js";
import { buildWesternAlignmentPreview, parsePreviewQuery, recordWesternAlignmentPreviewReview } from "./westernStringsAlignmentService.js";

export function createWesternStringsRouter({ repoRoot }) {
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

  return router;
}
