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
await testRoute();

console.log(JSON.stringify({ ok: true, checks: ["western-alignment-preview-service", "western-alignment-preview-route"] }));
