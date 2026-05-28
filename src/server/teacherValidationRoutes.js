import express from "express";
import path from "node:path";
import { safeString } from "./baseUtils.js";

export function createTeacherValidationRouter(service) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
  });

  router.get("/packs", async (req, res) => {
    try {
      const packs = await service.listTeacherValidationPacks();
      return res.json({ ok: true, packs });
    } catch (error) {
      return res.status(500).json({ error: safeString(error?.message, "failed to list teacher validation packs.") });
    }
  });

  router.get("/packs/:packId/items/:caseId/:assetType", async (req, res) => {
    const assetType = safeString(req.params.assetType).toLowerCase();
    if (assetType !== "audio" && assetType !== "pdf") {
      return res.status(404).json({ error: "asset not found." });
    }
    try {
      const assetPath = await service.resolveTeacherValidationAssetPath(req.params.packId, req.params.caseId, assetType);
      res.setHeader("Cache-Control", "no-store");
      if (assetType === "pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="score.pdf"; filename*=UTF-8''${encodeURIComponent(path.basename(assetPath))}`);
      }
      return res.sendFile(assetPath);
    } catch (error) {
      return res.status(404).json({ error: safeString(error?.message, "asset not found.") });
    }
  });

  router.get("/packs/:packId", async (req, res) => {
    try {
      const pack = await service.readTeacherValidationPack(req.params.packId);
      const { packDir, ...payload } = pack;
      return res.json({ ok: true, pack: payload });
    } catch (error) {
      return res.status(404).json({ error: safeString(error?.message, "teacher validation pack not found.") });
    }
  });

  router.post("/packs/:packId/reviews/:caseId", async (req, res) => {
    try {
      const pack = await service.updateTeacherValidationReview(req.params.packId, req.params.caseId, req.body || {});
      const item = pack.items.find((candidate) => candidate.caseId === req.params.caseId) || null;
      const { packDir, ...payload } = pack;
      return res.json({ ok: true, pack: payload, item });
    } catch (error) {
      return res.status(400).json({ error: safeString(error?.message, "teacher validation review save failed.") });
    }
  });

  router.post("/packs/:packId/apply", async (req, res) => {
    try {
      const summary = await service.applyTeacherValidationPack(req.params.packId);
      return res.json({ ok: true, summary });
    } catch (error) {
      return res.status(400).json({ error: safeString(error?.message, "teacher validation import failed.") });
    }
  });

  return router;
}
