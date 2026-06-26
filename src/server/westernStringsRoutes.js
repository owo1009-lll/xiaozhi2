import express from "express";

import { safeString } from "./baseUtils.js";
import { buildWesternAlignmentPreview, parsePreviewQuery } from "./westernStringsAlignmentService.js";

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

  return router;
}
