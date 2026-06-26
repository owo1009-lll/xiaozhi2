import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

import { buildWesternAlignmentPreview } from "../src/server/westernStringsAlignmentService.js";
import { createWesternStringsRouter } from "../src/server/westernStringsRoutes.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function testServiceDefaultNoLeakage() {
  const preview = await buildWesternAlignmentPreview({ repoRoot: process.cwd(), limit: 5 });
  assert.equal(preview.ok, true);
  assert.equal(preview.summary.noteCount, 2088);
  assert.equal(preview.summary.autoPassCount, 2088);
  assert.equal(preview.summary.coverage, 1);
  assert.equal(preview.decisions.length, 5);
  assert.equal(Object.hasOwn(preview.decisions[0], "evaluation"), false, "default preview must not expose gold labels");
  assert.equal(preview.decisions[0].autoDecision, "auto_pass");
  assert.equal(preview.decisions[0].confidenceModelVersion, "western-m2-median-consensus-v1");
  assert(preview.decisions[0].candidateSources.length >= 1);
}

async function testServiceEvaluationSummary() {
  const preview = await buildWesternAlignmentPreview({ repoRoot: process.cwd(), includeLabels: true });
  assert.equal(preview.summary.evaluation.evaluatedCount, 2088);
  assert.equal(preview.summary.evaluation.correctWithin300ms, 2050);
  assert.equal(preview.summary.evaluation.precisionWithin300ms, 0.9818);
}

async function testStudentSafeFailClosed() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-preview-gate-missing-"));
  await fs.mkdir(path.join(tempRoot, "data", "experiments", "western-strings-m2"), { recursive: true });
  await fs.copyFile(
    path.join(process.cwd(), "data", "experiments", "western-strings-m2", "alignment-candidate-feature-table.csv"),
    path.join(tempRoot, "data", "experiments", "western-strings-m2", "alignment-candidate-feature-table.csv"),
  );
  const preview = await buildWesternAlignmentPreview({ repoRoot: tempRoot, studentSafe: true, limit: 5 });
  assert.equal(preview.ok, true);
  assert.equal(preview.releaseGate.ready, false);
  assert.equal(preview.summary.autoPassCount, 0);
  assert.equal(preview.summary.reviewRequiredCount, 2088);
  assert(preview.decisions.every((item) => item.autoDecision === "review_required"));
  assert(preview.decisions.every((item) => item.reviewRequiredReason === preview.releaseGate.reason));
}

async function testStudentSafeSequenceSupportGate() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-preview-sequence-gate-"));
  const m2Root = path.join(tempRoot, "data", "experiments", "western-strings-m2");
  const cacheRoot = path.join(tempRoot, "data", "experiments", "western-strings-m0", "m0a-bach10", "cache", "basic-pitch");
  await fs.mkdir(m2Root, { recursive: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  const headers = [
    "dataset", "piece", "noteIndex", "method", "midi", "scoreTime", "goldTime", "predTime",
    "doubleStop", "legato", "methodCount", "validPredictionCount", "predictionSpanSeconds",
    "candidateToMedianAbsSeconds", "agreementWithin100ms", "agreementWithin300ms",
    "labelCandidateAbsError", "labelCandidateWithin100ms", "labelCandidateWithin150ms", "labelCandidateWithin300ms",
  ];
  const rows = [
    ["m0a-bach10", "tiny", "0", "parangonar-basic-pitch", "60", "1", "1", "1", "0", "unknown", "1", "1", "0", "0", "1", "1", "0", "1", "1", "1"],
    ["m0a-bach10", "tiny", "1", "parangonar-basic-pitch", "62", "2", "2", "2", "0", "unknown", "1", "1", "0", "0", "1", "1", "0", "1", "1", "1"],
    ["m0a-bach10", "tiny", "2", "parangonar-basic-pitch", "64", "3", "3", "3", "0", "unknown", "1", "1", "0", "0", "1", "1", "0", "1", "1", "1"],
  ];
  await fs.writeFile(
    path.join(m2Root, "alignment-candidate-feature-table.csv"),
    `${headers.join(",")}\n${rows.map((row) => row.join(",")).join("\n")}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(m2Root, "m2d-sequence-support-summary.json"),
    JSON.stringify({
      ok: true,
      studentGateReady: true,
      supportFeature: {
        thresholdSeconds: 0.05,
        pitchToleranceSemitones: 0,
        neighborRadius: 1,
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(cacheRoot, "tiny-violin.basic-pitch.json"),
    JSON.stringify([
      { start: 1, midi: 60 },
      { start: 2, midi: 62 },
      { start: 3, midi: 64 },
    ]),
    "utf8",
  );
  const supported = await buildWesternAlignmentPreview({ repoRoot: tempRoot, studentSafe: true, includeLabels: true });
  assert.equal(supported.releaseGate.ready, true);
  assert.equal(supported.summary.autoPassCount, 3);
  assert.equal(supported.summary.evaluation.autoPassEvaluatedCount, 3);
  assert.equal(supported.summary.evaluation.autoPassCorrectWithin300ms, 3);
  assert(supported.decisions.every((item) => item.autoDecision === "auto_pass"));

  await fs.writeFile(
    path.join(cacheRoot, "tiny-violin.basic-pitch.json"),
    JSON.stringify([
      { start: 1, midi: 60 },
      { start: 3, midi: 64 },
    ]),
    "utf8",
  );
  const unsupported = await buildWesternAlignmentPreview({ repoRoot: tempRoot, studentSafe: true, includeLabels: true });
  assert.equal(unsupported.summary.autoPassCount, 0);
  assert.equal(unsupported.summary.evaluation.autoPassEvaluatedCount, 0);
  assert.equal(unsupported.summary.evaluation.autoPassPrecisionWithin300ms, 0);
  assert(unsupported.decisions.every((item) => item.autoDecision === "review_required"));
  assert(unsupported.decisions.every((item) => item.reviewRequiredReason === "sequence-basic-pitch-support-missing"));
}

async function testRoute() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-preview-route-"));
  await fs.mkdir(path.join(tempRoot, "data", "experiments", "western-strings-m2"), { recursive: true });
  await fs.copyFile(
    path.join(process.cwd(), "data", "experiments", "western-strings-m2", "alignment-candidate-feature-table.csv"),
    path.join(tempRoot, "data", "experiments", "western-strings-m2", "alignment-candidate-feature-table.csv"),
  );
  const app = express();
  app.use(express.json());
  app.use(createWesternStringsRouter({ repoRoot: tempRoot }));
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/strings/alignment-preview?dataset=m0b-urmp&limit=3`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.summary.noteCount, 146);
    assert.equal(body.decisions.length, 3);
    assert(body.decisions.every((item) => item.dataset === "m0b-urmp"));
    const safeResponse = await fetch(`http://127.0.0.1:${port}/api/strings/alignment-preview?dataset=m0b-urmp&limit=3&studentSafe=1`);
    const safeBody = await safeResponse.json();
    assert.equal(safeResponse.status, 200);
    assert.equal(safeBody.releaseGate.ready, false);
    assert.equal(safeBody.summary.autoPassCount, 0);
    assert(safeBody.decisions.every((item) => item.autoDecision === "review_required"));
    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/strings/alignment-preview/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        noteId: body.decisions[0].noteId,
        action: "confirm",
        predictedOnsetSeconds: body.decisions[0].predictedOnsetSeconds,
      }),
    });
    const reviewBody = await reviewResponse.json();
    assert.equal(reviewResponse.status, 200);
    assert.equal(reviewBody.ok, true);
    const saved = await fs.readFile(path.join(tempRoot, "data", "experiments", "western-strings-m2", "alignment-preview-reviews.jsonl"), "utf8");
    assert(saved.includes(body.decisions[0].noteId), "preview review route should append a jsonl record");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

await testServiceDefaultNoLeakage();
await testServiceEvaluationSummary();
await testStudentSafeFailClosed();
await testStudentSafeSequenceSupportGate();
await testRoute();

console.log(JSON.stringify({ ok: true, checks: ["western-alignment-preview-service", "western-alignment-preview-route"] }));
