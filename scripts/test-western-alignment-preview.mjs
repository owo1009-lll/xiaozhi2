import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";

import {
  buildAudioSubmissionFromUpload,
  parseIncomingPayload,
  persistPayloadAudio,
  persistUploadedAudioFile,
} from "../src/server/audioPayload.js";
import {
  buildWesternAlignmentPreview,
  buildWesternStudentAnalysis,
  runWesternControlledSubmissionBatch,
} from "../src/server/westernStringsAlignmentService.js";
import { createWesternStringsRouter } from "../src/server/westernStringsRoutes.js";
import { auditControlledBatchRuns } from "./audit-western-controlled-batch-candidates.mjs";
import {
  collectControlledCandidateReviewRows,
  renderControlledCandidateReviewHtml,
} from "./export-western-controlled-candidate-review.mjs";
import { evaluateControlledCandidateGate } from "./eval-western-controlled-candidate-gate.mjs";
import { applyWesternM2fCleanScoreImports } from "./import-western-m2f-clean-scores-to-store.mjs";
import { mergeControlledCandidateReviewLabels } from "./import-western-controlled-candidate-review-labels.mjs";
import { buildControlledCandidateReviewStatus } from "./status-western-controlled-candidate-review.mjs";
import { buildControlledCandidateInputStatus } from "./status-western-controlled-candidate-inputs.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function sineWavBuffer({ frequency = 440, durationSeconds = 1.25, sampleRate = 22050 } = {}) {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 12000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
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
  assert(preview.decisions.every((item) => item.evidence.studentGateReady === false));
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
  assert(supported.decisions.every((item) => item.evidence.studentGateReady === true));
  assert(supported.decisions.every((item) => item.evidence.sequenceBasicPitchSupport === true));

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
  assert(unsupported.decisions.every((item) => item.evidence.sequenceBasicPitchSupport === false));
}

async function createTinyStudentReadyRoot() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-student-api-ready-"));
  const m2Root = path.join(tempRoot, "data", "experiments", "western-strings-m2");
  const m3Root = path.join(tempRoot, "data", "experiments", "western-strings-m3");
  const cacheRoot = path.join(tempRoot, "data", "experiments", "western-strings-m0", "m0a-bach10", "cache", "basic-pitch");
  await fs.mkdir(m2Root, { recursive: true });
  await fs.mkdir(m3Root, { recursive: true });
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
  await fs.writeFile(
    path.join(m2Root, "m2f-real-student-recording-summary.json"),
    JSON.stringify({
      ok: true,
      studentGateReady: true,
      manifest: { recordings: 12, students: 3 },
      results: {
        autoPassCount: 431,
        correctWithin300ms: 431,
        unsafeTargetAutoPassCount: 0,
        precisionWithin300ms: 1,
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(m3Root, "m3-diagnosis-summary.json"),
    JSON.stringify({
      ok: true,
      diagnosisGateReady: true,
      gate: {
        requiredCategories: ["pitch", "onset", "missing"],
        reviewOnlyCategories: ["duration", "extra"],
      },
      blockingReasons: [],
      categories: {
        pitch: { ready: true },
        onset: { ready: true },
        missing: { ready: true },
        duration: { ready: false, status: "review_only" },
        extra: { ready: false, status: "review_only" },
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(m3Root, "real-student-diagnosis-results.csv"),
    [
      "recordingId,scenario,autoPassEvaluatedCount,pitchAutoIssueCount,pitchCorrectIssueCount,pitchUnsafeIssueCount,onsetAutoIssueCount,onsetCorrectIssueCount,onsetUnsafeIssueCount,durationAutoIssueCount,durationCorrectIssueCount,durationUnsafeIssueCount,missingAutoIssueCount,missingCorrectIssueCount,missingUnsafeIssueCount,extraAutoIssueCount,extraCorrectIssueCount,extraUnsafeIssueCount,notes",
      "r1,wrong_pitch,3,1,1,0,1,1,0,0,0,0,1,1,0,0,0,0,reviewed",
    ].join("\n"),
    "utf8",
  );
  return tempRoot;
}

async function testStudentAnalysisServiceReady() {
  const tempRoot = await createTinyStudentReadyRoot();
  const analysis = await buildWesternStudentAnalysis({
    repoRoot: tempRoot,
    dataset: "m0a-bach10",
    piece: "tiny",
    recordingId: "r1",
  });
  assert.equal(analysis.ok, true);
  assert.equal(analysis.studentReady, true);
  assert.equal(analysis.summary.autoPassCount, 3);
  assert.deepEqual(analysis.summary.allowedDiagnosticCategories, ["pitch", "onset", "missing"]);
  assert.deepEqual(analysis.summary.reviewOnlyDiagnosticCategories, ["duration", "extra"]);
  assert.equal(analysis.decisions.length, 3);
  assert(analysis.decisions.every((item) => item.autoDecision === "auto_pass"));
  assert.equal(analysis.recordingDiagnosis.recordingId, "r1");
  assert.equal(analysis.recordingDiagnosis.categories.find((item) => item.category === "extra").status, "review_only");
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
    const analyzeFailClosedResponse = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "m0b-urmp", limit: 3 }),
    });
    const analyzeFailClosedBody = await analyzeFailClosedResponse.json();
    assert.equal(analyzeFailClosedResponse.status, 200);
    assert.equal(analyzeFailClosedBody.ok, true);
    assert.equal(analyzeFailClosedBody.analysis.studentReady, false);
    assert.equal(analyzeFailClosedBody.analysis.summary.autoPassCount, 0);
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

async function testStudentAnalyzeAndReviewRoutes() {
  const tempRoot = await createTinyStudentReadyRoot();
  const app = express();
  app.use(express.json());
  app.use(createWesternStringsRouter({ repoRoot: tempRoot }));
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: "m0a-bach10", piece: "tiny", recordingId: "r1" }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.analysis.studentReady, true);
    assert.equal(body.analysis.summary.autoPassCount, 3);
    assert.deepEqual(body.analysis.summary.allowedDiagnosticCategories, ["pitch", "onset", "missing"]);
    assert.deepEqual(body.analysis.summary.reviewOnlyDiagnosticCategories, ["duration", "extra"]);

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/strings/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        noteId: body.analysis.decisions[0].noteId,
        action: "confirm",
        category: "pitch",
        predictedOnsetSeconds: body.analysis.decisions[0].predictedOnsetSeconds,
      }),
    });
    const reviewBody = await reviewResponse.json();
    assert.equal(reviewResponse.status, 200);
    assert.equal(reviewBody.ok, true);
    const saved = await fs.readFile(path.join(tempRoot, "data", "experiments", "western-strings-m3", "student-analysis-reviews.jsonl"), "utf8");
    assert(saved.includes(body.analysis.decisions[0].noteId), "student review route should append a jsonl record");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testControlledSubmissionRoute() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-student-controlled-submission-"));
  const audioCacheDir = path.join(tempRoot, "data", "analysis-audio-cache");
  const app = express();
  app.use(express.json());
  app.use(createWesternStringsRouter({
    repoRoot: tempRoot,
    upload: multer({ storage: multer.memoryStorage() }),
    audioCacheDir,
    parseIncomingPayload,
    buildAudioSubmissionFromUpload,
    persistUploadedAudioFile,
    persistPayloadAudio,
  }));
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const formData = new FormData();
    formData.append("payload", JSON.stringify({
      scoreId: "score-test-clean",
      audioSubmission: {
        duration: 8.5,
      },
    }));
    formData.append("audio", new Blob([Buffer.from("fake-wave-data")], { type: "audio/wav" }), "student.wav");
    const response = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
      method: "POST",
      body: formData,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.analysis.submissionAccepted, true);
    assert.equal(body.analysis.studentReady, false);
    assert.deepEqual(body.analysis.blockingReasons, ["controlled-submission-requires-offline-analysis"]);
    assert.equal(body.analysis.submission.scoreId, "score-test-clean");
    assert.equal(body.analysis.submission.audioSubmission.name, "student.wav");
    assert(body.analysis.submission.audioPath.includes("analysis-audio-cache"));
    const cached = await fs.readdir(audioCacheDir);
    assert.equal(cached.length, 1, "controlled submission should persist the uploaded audio");
    const saved = await fs.readFile(path.join(tempRoot, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl"), "utf8");
    assert(saved.includes("score-test-clean"), "controlled submission route should append a jsonl record");

    const queueResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions`);
    const queueBody = await queueResponse.json();
    assert.equal(queueResponse.status, 200);
    assert.equal(queueBody.ok, true);
    assert.equal(queueBody.summary.total, 1);
    assert.equal(queueBody.summary.reviewRequired, 1);
    assert.equal(queueBody.submissions[0].scoreId, "score-test-clean");
    assert.equal(queueBody.submissions[0].status, "review_required");
    assert(queueBody.submissions[0].audioUrl.includes(encodeURIComponent(body.analysis.submission.submissionId)));

    const audioResponse = await fetch(`http://127.0.0.1:${port}${queueBody.submissions[0].audioUrl}`);
    assert.equal(audioResponse.status, 200);
    assert.equal(await audioResponse.text(), "fake-wave-data");

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submissionId: body.analysis.submission.submissionId,
        action: "accepted_for_batch",
        comments: "ready for offline analysis",
      }),
    });
    const reviewBody = await reviewResponse.json();
    assert.equal(reviewResponse.status, 200);
    assert.equal(reviewBody.ok, true);
    const reviewedQueueResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions`);
    const reviewedQueueBody = await reviewedQueueResponse.json();
    assert.equal(reviewedQueueBody.summary.acceptedForBatch, 1);
    assert.equal(reviewedQueueBody.submissions[0].status, "accepted_for_batch");
    const savedReview = await fs.readFile(path.join(tempRoot, "data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl"), "utf8");
    assert(savedReview.includes("accepted_for_batch"), "controlled submission review route should append a jsonl record");

    const batchResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions/run-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    const batchBody = await batchResponse.json();
    assert.equal(batchResponse.status, 200);
    assert.equal(batchBody.ok, true);
    assert.equal(batchBody.batch.itemCount, 1);
    assert.equal(batchBody.batch.acceptedQueueCount, 1);
    assert.equal(batchBody.batch.autoDiagnosisIssued, false);
    assert.equal(batchBody.batch.items[0].submissionId, body.analysis.submission.submissionId);
    assert.equal(batchBody.batch.items[0].autoDiagnosisIssued, false);
    assert.equal(batchBody.batch.items[0].offlineAnalysisProduced, false);
    assert(batchBody.batch.items[0].reasons.includes("controlled-batch-release-gates-not-ready"));
    const savedBatchRun = await fs.readFile(path.join(tempRoot, "data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"), "utf8");
    assert(savedBatchRun.includes(body.analysis.submission.submissionId), "controlled batch route should append a jsonl run record");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testControlledSubmissionValidatedReplayBatch() {
  const tempRoot = await createTinyStudentReadyRoot();
  const audioCacheDir = path.join(tempRoot, "data", "analysis-audio-cache");
  const app = express();
  app.use(express.json());
  app.use(createWesternStringsRouter({
    repoRoot: tempRoot,
    upload: multer({ storage: multer.memoryStorage() }),
    audioCacheDir,
    parseIncomingPayload,
    buildAudioSubmissionFromUpload,
    persistUploadedAudioFile,
    persistPayloadAudio,
  }));
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const formData = new FormData();
    formData.append("payload", JSON.stringify({
      scoreId: "score-test-clean",
      dataset: "m0a-bach10",
      piece: "tiny",
      recordingId: "r1",
      limit: 3,
      instrument: "violin",
      audioSubmission: {
        duration: 8.5,
      },
    }));
    formData.append("audio", new Blob([Buffer.from("fake-wave-data")], { type: "audio/wav" }), "student.wav");
    const response = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
      method: "POST",
      body: formData,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.analysis.submissionAccepted, true);
    assert.equal(body.analysis.studentReady, false);
    assert.equal(body.analysis.submission.dataset, "m0a-bach10");
    assert.equal(body.analysis.submission.piece, "tiny");
    assert.equal(body.analysis.submission.recordingId, "r1");

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submissionId: body.analysis.submission.submissionId,
        action: "accepted_for_batch",
        comments: "validated replay smoke",
      }),
    });
    assert.equal(reviewResponse.status, 200);

    const batchResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions/run-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    const batchBody = await batchResponse.json();
    assert.equal(batchResponse.status, 200);
    assert.equal(batchBody.ok, true);
    assert.equal(batchBody.batch.itemCount, 1);
    assert.equal(batchBody.batch.offlineAnalysisProducedCount, 1);
    assert.equal(batchBody.batch.autoDiagnosisIssued, false);
    assert.equal(batchBody.batch.status, "offline_analysis_ready");
    assert.equal(batchBody.batch.reason, "controlled-batch-not-student-facing");
    const item = batchBody.batch.items[0];
    assert.equal(item.submissionId, body.analysis.submission.submissionId);
    assert.equal(item.dataset, "m0a-bach10");
    assert.equal(item.piece, "tiny");
    assert.equal(item.recordingId, "r1");
    assert.equal(item.analysisStatus, "offline_analysis_ready");
    assert.equal(item.offlineAnalysisProduced, true);
    assert.equal(item.autoDiagnosisIssued, false);
    assert.deepEqual(item.reasons, ["controlled-batch-not-student-facing"]);
    assert.equal(item.analysisSummary.autoPassCount, 3);
    assert.equal(item.decisionCount, 3);
    assert.equal(item.recordingDiagnosis.recordingId, "r1");
    const savedBatchRun = await fs.readFile(path.join(tempRoot, "data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"), "utf8");
    assert(savedBatchRun.includes("offline_analysis_ready"), "validated replay batch should append an offline analysis run");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testControlledSubmissionOfflineFeatureReviewBatch() {
  const tempRoot = await createTinyStudentReadyRoot();
  await fs.writeFile(
    path.join(tempRoot, "data", "erhu-score-imports.json"),
    JSON.stringify({
      jobs: [],
      scores: [
        {
          scoreId: "score-test-clean",
          title: "Tiny clean violin score",
          scoreSource: "musicxml",
          sections: [
            {
              sectionId: "section-1",
              title: "Section 1",
              tempo: 72,
              notes: [
                { noteId: "n1", measureIndex: 1, beatStart: 0, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
                { noteId: "n2", measureIndex: 1, beatStart: 1, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
                { noteId: "n3", measureIndex: 1, beatStart: 2, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
              ],
            },
          ],
        },
      ],
    }),
    "utf8",
  );
  const audioCacheDir = path.join(tempRoot, "data", "analysis-audio-cache");
  const app = express();
  app.use(express.json());
  app.use(createWesternStringsRouter({
    repoRoot: tempRoot,
    upload: multer({ storage: multer.memoryStorage() }),
    audioCacheDir,
    parseIncomingPayload,
    buildAudioSubmissionFromUpload,
    persistUploadedAudioFile,
    persistPayloadAudio,
  }));
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const formData = new FormData();
    formData.append("payload", JSON.stringify({
      scoreId: "score-test-clean",
      limit: 3,
      instrument: "violin",
      audioSubmission: {
        duration: 1.25,
      },
    }));
    formData.append("audio", new Blob([sineWavBuffer()], { type: "audio/wav" }), "student.wav");
    const response = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
      method: "POST",
      body: formData,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.analysis.submissionAccepted, true);
    assert.equal(body.analysis.studentReady, false);

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submissionId: body.analysis.submission.submissionId,
        action: "accepted_for_batch",
        comments: "offline feature review smoke",
      }),
    });
    assert.equal(reviewResponse.status, 200);

    const batchResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions/run-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });
    const batchBody = await batchResponse.json();
    assert.equal(batchResponse.status, 200);
    assert.equal(batchBody.ok, true);
    assert.equal(batchBody.batch.itemCount, 1);
    assert.equal(batchBody.batch.offlineAnalysisProducedCount, 1);
    assert.equal(batchBody.batch.status, "offline_feature_review_ready");
    assert.equal(batchBody.batch.autoDiagnosisIssued, false);
    const item = batchBody.batch.items[0];
    assert.equal(item.analysisStatus, "offline_feature_review_ready");
    assert.equal(item.offlineAnalysisProduced, true);
    assert.equal(item.autoDiagnosisIssued, false);
    assert.deepEqual(item.reasons, ["controlled-batch-offline-feature-review-only"]);
    assert.equal(item.analysisSummary.analysisMode, "linear-score-pyin-review-v1");
    assert.equal(item.analysisSummary.noteCount, 3);
    assert.equal(item.analysisSummary.candidateRowCount, 3);
    assert.equal(item.analysisSummary.autoPassCount, 0);
    assert.equal(item.analysisSummary.reviewOnlyCandidateCount, 3);
    assert.equal(item.analysisSummary.studentSafeGateReady, false);
    assert.equal(item.analysisSummary.studentSafeCandidateGateReady, false);
    assert.equal(item.analysisSummary.studentSafeCandidateGateVersion, "western-offline-feature-gate-v0-review-only");
    assert.equal(item.decisionCount, 3);
    assert.equal(item.candidateRowCount, 3);
    assert.match(item.candidateRowsPath, /^data\/experiments\/western-strings-m3\/offline-feature-candidates\/strings-batch-/);
    assert.equal(item.candidateGate.ready, false);
    assert.equal(item.candidateGate.gateVersion, "western-offline-feature-gate-v0-review-only");
    assert.equal(item.candidateGate.reason, "ordinary-upload-student-safe-gate-not-calibrated");
    assert.equal(item.candidateGate.evaluatedCandidateCount, 3);
    assert.equal(item.candidateGate.autoPassCandidateCount, 0);
    assert.equal(item.candidateGate.reviewRequiredCandidateCount, 3);
    assert.equal(item.candidatePreview.length, 3);
    assert.equal(item.candidatePreview[0].method, "pyin-linear-score-window");
    assert.equal(item.candidatePreview[0].autoDecision, "review_required");
    assert.equal(item.candidatePreview[0].gateDecision, "review_required");
    assert.equal(item.candidatePreview[0].gateReason, "ordinary-upload-student-safe-gate-not-calibrated");
    assert.equal(item.candidatePreview[0].gateVersion, "western-offline-feature-gate-v0-review-only");
    assert.equal(item.candidatePreview[0].studentSafeGateReady, false);
    assert.equal(item.recordingDiagnosis.mode, "offline_feature_review_only");
    const candidateRowsArtifact = JSON.parse(await fs.readFile(path.join(tempRoot, item.candidateRowsPath), "utf8"));
    assert.equal(candidateRowsArtifact.batchRunId, batchBody.batch.batchRunId);
    assert.equal(candidateRowsArtifact.submissionId, body.analysis.submission.submissionId);
    assert.equal(candidateRowsArtifact.rowCount, 3);
    assert.equal(candidateRowsArtifact.candidateRows.length, 3);
    assert(candidateRowsArtifact.candidateRows.every((candidate) => candidate.autoDecision === "review_required"));
    assert(candidateRowsArtifact.candidateRows.every((candidate) => candidate.gateVersion === "western-offline-feature-gate-v0-review-only"));
    const savedBatchRun = await fs.readFile(path.join(tempRoot, "data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"), "utf8");
    const audit = auditControlledBatchRuns(savedBatchRun.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)), {
      requireFeatureReview: true,
      sourceRoot: tempRoot,
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.featureReviewItemCount, 1);
    assert.equal(audit.candidateRowCount, 3);
    const staleRun = {
      batchRunId: "stale-run-without-artifact",
      autoDiagnosisIssued: false,
      items: [{
        analysisStatus: "offline_feature_review_ready",
        autoDiagnosisIssued: false,
        analysisSummary: {
          autoPassCount: 0,
          studentFacing: false,
          studentSafeGateReady: false,
        },
        candidateRowCount: 1,
        candidateGate: {
          ready: false,
          autoPassCandidateCount: 0,
          evaluatedCandidateCount: 1,
          gateVersion: "western-offline-feature-gate-v0-review-only",
          reason: "ordinary-upload-student-safe-gate-not-calibrated",
        },
        candidatePreview: [{
          autoDecision: "review_required",
          studentSafeGateReady: false,
          studentFacing: false,
          gateDecision: "review_required",
          gateVersion: "western-offline-feature-gate-v0-review-only",
          gateReason: "ordinary-upload-student-safe-gate-not-calibrated",
        }],
      }],
    };
    const latestOnlyAudit = auditControlledBatchRuns([staleRun, ...savedBatchRun.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))], {
      requireFeatureReview: true,
      sourceRoot: tempRoot,
      latestOnly: true,
    });
    assert.equal(latestOnlyAudit.ok, true);
    assert.equal(latestOnlyAudit.auditedRunMode, "latest");
    const allRunsAudit = auditControlledBatchRuns([staleRun, ...savedBatchRun.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))], {
      requireFeatureReview: true,
      sourceRoot: tempRoot,
    });
    assert.equal(allRunsAudit.ok, false);
    assert(allRunsAudit.failures.some((failure) => failure.code === "feature-review-candidate-rows-path-missing"));
    const reviewRows = await collectControlledCandidateReviewRows({
      repoRoot: tempRoot,
      source: path.join("data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"),
    });
    assert.equal(reviewRows.rows.length, 3);
    assert.equal(reviewRows.skipped.length, 0);
    assert.equal(reviewRows.rows[0].teacherCandidateStatus, "");
    assert.equal(reviewRows.rows[0].gateDecision, "review_required");
    assert.equal(reviewRows.rows[0].studentFacing, "no");
    const reviewHtml = renderControlledCandidateReviewHtml(reviewRows.rows, { serverOrigin: "http://127.0.0.1:3000" });
    assert(reviewHtml.includes("普通上传候选复核"));
    assert(reviewHtml.includes("/api/strings/controlled-submissions/"));
    assert(reviewHtml.includes("controlled-candidate-review.completed.csv"));
    const reviewCsv = [
      "candidateId,teacherCandidateStatus,centsError,voicedFrameCount,pitchSupportWithin80Cents",
      "c1,usable,12,4,yes",
      "c2,wrong,70,4,yes",
      "",
    ].join("\n");
    const reviewCsvPath = path.join(tempRoot, "candidate-review.csv");
    await fs.writeFile(reviewCsvPath, reviewCsv, "utf8");
    const notReadyGate = await evaluateControlledCandidateGate({
      reviewCsvPath,
      minReviewedRows: 30,
      minPrecision: 0.9,
    });
    assert.equal(notReadyGate.studentSafeCandidateGateReady, false);
    assert(notReadyGate.blockingReasons.includes("candidate-review-sample-count-too-low"));
    const enoughRows = ["candidateId,teacherCandidateStatus,centsError,voicedFrameCount,pitchSupportWithin80Cents"];
    for (let index = 0; index < 30; index += 1) {
      enoughRows.push(`ok${index},usable,12,4,yes`);
    }
    const enoughCsvPath = path.join(tempRoot, "candidate-review-enough.csv");
    await fs.writeFile(enoughCsvPath, `${enoughRows.join("\n")}\n`, "utf8");
    const readyGate = await evaluateControlledCandidateGate({
      reviewCsvPath: enoughCsvPath,
      minReviewedRows: 30,
      minPrecision: 0.9,
    });
    assert.equal(readyGate.studentSafeCandidateGateReady, true);
    assert.equal(readyGate.bestRule.ruleId, "pitch-support-within-80cents");
    assert.equal(readyGate.bestRule.precision, 1);
    const completedReviewCsv = [
      "batchRunId,submissionId,candidateId,teacherCandidateStatus,centsError,voicedFrameCount,pitchSupportWithin80Cents",
      "run-1,sub-1,c1,usable,12,4,yes",
      "run-1,sub-1,c2,wrong,70,4,no",
      "run-1,sub-1,c3,,20,4,yes",
      "",
    ].join("\n");
    const completedReviewPath = path.join(tempRoot, "controlled-candidate-review.completed.csv");
    const labelsPath = path.join(tempRoot, "controlled-candidate-review-labels.csv");
    await fs.writeFile(completedReviewPath, completedReviewCsv, "utf8");
    const importedLabels = await mergeControlledCandidateReviewLabels({
      reviewsPath: completedReviewPath,
      labelsPath,
    });
    assert.equal(importedLabels.incomingReviewedRows, 2);
    assert.equal(importedLabels.inserted, 2);
    assert.equal(importedLabels.updated, 0);
    assert.equal(importedLabels.totalRows, 2);
    const updatedReviewCsv = completedReviewCsv.replace("run-1,sub-1,c2,wrong,70,4,no", "run-1,sub-1,c2,uncertain,70,4,no");
    await fs.writeFile(completedReviewPath, updatedReviewCsv, "utf8");
    const updatedLabels = await mergeControlledCandidateReviewLabels({
      reviewsPath: completedReviewPath,
      labelsPath,
    });
    assert.equal(updatedLabels.inserted, 0);
    assert.equal(updatedLabels.updated, 2);
    assert.equal(updatedLabels.totalRows, 2);
    const labelsGate = await evaluateControlledCandidateGate({
      reviewCsvPath: labelsPath,
      minReviewedRows: 2,
      minScoredRows: 2,
      minPrecision: 0.9,
    });
    assert.equal(labelsGate.studentSafeCandidateGateReady, false);
    assert(labelsGate.blockingReasons.includes("candidate-review-scored-sample-count-too-low"));
    assert.equal(labelsGate.statusCounts.usable, 1);
    assert.equal(labelsGate.statusCounts.uncertain, 1);
    const labelsStatus = buildControlledCandidateReviewStatus(labelsGate);
    assert.equal(labelsStatus.deficits.reviewedRows, 0);
    assert.equal(labelsStatus.deficits.scoredRows, 1);
    assert(labelsStatus.nextActions.some((item) => item.includes("usable or wrong")));
    const relaxedLabelsGate = await evaluateControlledCandidateGate({
      reviewCsvPath: labelsPath,
      minReviewedRows: 2,
      minScoredRows: 1,
      minPrecision: 0.9,
    });
    assert.equal(relaxedLabelsGate.studentSafeCandidateGateReady, true);
    assert.equal(relaxedLabelsGate.bestRule.ruleId, "pitch-support-within-80cents");
    const relaxedStatus = buildControlledCandidateReviewStatus(relaxedLabelsGate);
    assert.equal(relaxedStatus.deficits.reviewedRows, 0);
    assert.equal(relaxedStatus.deficits.scoredRows, 0);
    assert(relaxedStatus.nextActions.some((item) => item.includes("ready for human review")));
    const preflightRoot = path.join(tempRoot, "controlled-input-preflight");
    await fs.mkdir(path.join(preflightRoot, "data", "experiments", "western-strings-m2"), { recursive: true });
    await fs.mkdir(path.join(preflightRoot, "data", "experiments", "western-strings-m3"), { recursive: true });
    await fs.mkdir(path.join(preflightRoot, "data", "private", "western-strings-m2"), { recursive: true });
    await fs.writeFile(path.join(preflightRoot, "data", "private", "western-strings-m2", "violin-ex01.m4a"), "audio", "utf8");
    await fs.writeFile(path.join(preflightRoot, "data", "private", "western-strings-m2", "violin-ex01.mxl"), "score", "utf8");
    const manifestPath = path.join(preflightRoot, "data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv");
    const cleanScorePath = path.join(preflightRoot, "data", "experiments", "western-strings-m2", "clean-score-intake.csv");
    const scoreStorePath = path.join(preflightRoot, "data", "erhu-score-imports.json");
    await fs.writeFile(manifestPath, [
      "recordingId,pieceId,audioPath,scorePath,scoreId,scenario",
      "r1,violin-ex01,data/private/western-strings-m2/violin-ex01.m4a,data/private/western-strings-m2/violin-ex01.mxl,,correct",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(cleanScorePath, [
      "\uFEFFrecordingId,pieceId,requiredCleanScorePath,scoreId,cleanScoreReviewStatus",
      "r1,violin-ex01,data/private/western-strings-m2/violin-ex01.mxl,,approved",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(scoreStorePath, JSON.stringify({ scores: [] }), "utf8");
    const missingImportStatus = await buildControlledCandidateInputStatus({
      repoRoot: preflightRoot,
      manifestPath: "data/experiments/western-strings-m2/real-student-recordings-manifest.csv",
      cleanScoreIntakePath: "data/experiments/western-strings-m2/clean-score-intake.csv",
      scoreStorePath: "data/erhu-score-imports.json",
      controlledSubmissionsPath: "data/experiments/western-strings-m3/controlled-submissions.jsonl",
      controlledReviewsPath: "data/experiments/western-strings-m3/controlled-submission-reviews.jsonl",
      controlledBatchRunsPath: "data/experiments/western-strings-m3/controlled-submission-batch-runs.jsonl",
    });
    assert.equal(missingImportStatus.readyForCandidateReview, false);
    assert.equal(missingImportStatus.counts.audioReadyRows, 1);
    assert.equal(missingImportStatus.counts.cleanScoreApprovedRows, 1);
    assert.equal(missingImportStatus.counts.needsScoreStoreImportRows, 1);
    assert(missingImportStatus.blockingReasons.includes("score-store-import-missing"));
    assert(missingImportStatus.nextActions.some((item) => item.includes("Import approved clean-score")));
    await fs.writeFile(manifestPath, [
      "recordingId,pieceId,audioPath,scorePath,scoreId,scenario",
      "r1,violin-ex01,data/private/western-strings-m2/violin-ex01.m4a,data/private/western-strings-m2/violin-ex01.mxl,score-violin-ex01,correct",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(cleanScorePath, [
      "\uFEFFrecordingId,pieceId,requiredCleanScorePath,scoreId,cleanScoreReviewStatus",
      "r1,violin-ex01,data/private/western-strings-m2/violin-ex01.mxl,score-violin-ex01,approved",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(scoreStorePath, JSON.stringify({ scores: [{ scoreId: "score-violin-ex01" }] }), "utf8");
    await fs.writeFile(path.join(preflightRoot, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl"), `${JSON.stringify({ submissionId: "sub-1" })}\n`, "utf8");
    await fs.writeFile(path.join(preflightRoot, "data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl"), `${JSON.stringify({ submissionId: "sub-1", action: "accepted_for_batch" })}\n`, "utf8");
    await fs.writeFile(path.join(preflightRoot, "data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"), `${JSON.stringify({
      batchRunId: "batch-1",
      items: [{ submissionId: "sub-1", analysisStatus: "offline_feature_review_ready", candidateRowsPath: "data/experiments/western-strings-m3/candidates.json" }],
    })}\n`, "utf8");
    const readyInputStatus = await buildControlledCandidateInputStatus({
      repoRoot: preflightRoot,
      manifestPath: "data/experiments/western-strings-m2/real-student-recordings-manifest.csv",
      cleanScoreIntakePath: "data/experiments/western-strings-m2/clean-score-intake.csv",
      scoreStorePath: "data/erhu-score-imports.json",
      controlledSubmissionsPath: "data/experiments/western-strings-m3/controlled-submissions.jsonl",
      controlledReviewsPath: "data/experiments/western-strings-m3/controlled-submission-reviews.jsonl",
      controlledBatchRunsPath: "data/experiments/western-strings-m3/controlled-submission-batch-runs.jsonl",
    });
    assert.equal(readyInputStatus.readyForCandidateReview, true);
    assert.equal(readyInputStatus.counts.readyForControlledSubmissionRows, 1);
    assert.equal(readyInputStatus.controlledData.candidateRowsReady, true);
    assert.deepEqual(readyInputStatus.blockingReasons, []);
    const dryRunImportPlan = await applyWesternM2fCleanScoreImports({
      repoRoot: preflightRoot,
      manifestPath: "data/experiments/western-strings-m2/real-student-recordings-manifest.csv",
      cleanScoreIntakePath: "data/experiments/western-strings-m2/clean-score-intake.csv",
      scoreStorePath: "data/erhu-score-imports.json",
      apply: false,
    });
    assert.equal(dryRunImportPlan.applied, false);
    assert.equal(dryRunImportPlan.summary.existingScoreIdCount, 1);

    await fs.writeFile(manifestPath, [
      "recordingId,pieceId,audioPath,scorePath,scoreId,scenario",
      "r1,violin-ex01,data/private/western-strings-m2/violin-ex01.m4a,data/private/western-strings-m2/violin-ex01.mxl,,correct",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(cleanScorePath, [
      "\uFEFFrecordingId,pieceId,requiredCleanScorePath,scoreId,cleanScoreReviewStatus",
      "r1,violin-ex01,data/private/western-strings-m2/violin-ex01.mxl,,approved",
      "",
    ].join("\n"), "utf8");
    const cleanScoreBuffer = await fs.readFile(path.join(preflightRoot, "data", "private", "western-strings-m2", "violin-ex01.mxl"));
    const hash = (await import("node:crypto")).createHash("sha1").update(cleanScoreBuffer).digest("hex");
    await fs.writeFile(scoreStorePath, JSON.stringify({ scores: [{ scoreId: "score-violin-ex01", pdfHash: `musicxml:${hash}` }] }), "utf8");
    const reuseImportResult = await applyWesternM2fCleanScoreImports({
      repoRoot: preflightRoot,
      manifestPath: "data/experiments/western-strings-m2/real-student-recordings-manifest.csv",
      cleanScoreIntakePath: "data/experiments/western-strings-m2/clean-score-intake.csv",
      scoreStorePath: "data/erhu-score-imports.json",
      apply: true,
    });
    assert.equal(reuseImportResult.ok, true);
    assert.equal(reuseImportResult.updatedRows, 1);
    assert.equal(reuseImportResult.imported[0].source, "hash-reuse");
    assert.equal(reuseImportResult.imported[0].finalScoreId, "score-violin-ex01");
    const manifestAfterReuse = await fs.readFile(manifestPath, "utf8");
    const cleanScoreAfterReuse = await fs.readFile(cleanScorePath, "utf8");
    assert(manifestAfterReuse.includes("score-violin-ex01"));
    assert(cleanScoreAfterReuse.includes("score-violin-ex01"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testControlledSubmissionOfflineFeatureConfidenceGateEnabled() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-controlled-confidence-gate-"));
  const m2Root = path.join(tempRoot, "data", "experiments", "western-strings-m2");
  const m3Root = path.join(tempRoot, "data", "experiments", "western-strings-m3");
  await fs.mkdir(m2Root, { recursive: true });
  await fs.mkdir(m3Root, { recursive: true });
  await fs.writeFile(
    path.join(m2Root, "m2d-sequence-support-summary.json"),
    JSON.stringify({ ok: true, studentGateReady: true }),
    "utf8",
  );
  await fs.writeFile(
    path.join(m2Root, "m2f-real-student-recording-summary.json"),
    JSON.stringify({ ok: true, studentGateReady: true }),
    "utf8",
  );
  await fs.writeFile(
    path.join(m3Root, "m3-diagnosis-summary.json"),
    JSON.stringify({
      ok: true,
      diagnosisGateReady: true,
      gate: { requiredCategories: ["pitch", "onset", "missing"], reviewOnlyCategories: ["duration", "extra"] },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "data", "erhu-score-imports.json"),
    JSON.stringify({
      jobs: [],
      scores: [
        {
          scoreId: "score-test-clean",
          title: "Tiny clean violin score",
          scoreSource: "musicxml",
          sections: [
            {
              sectionId: "section-1",
              title: "Section 1",
              tempo: 72,
              notes: [
                { noteId: "n1", measureIndex: 1, beatStart: 0, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
                { noteId: "n2", measureIndex: 1, beatStart: 1, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
                { noteId: "n3", measureIndex: 1, beatStart: 2, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
              ],
            },
          ],
        },
      ],
    }),
    "utf8",
  );
  const audioPath = path.join(tempRoot, "student.wav");
  await fs.writeFile(audioPath, sineWavBuffer());
  await fs.writeFile(
    path.join(m3Root, "controlled-submissions.jsonl"),
    `${JSON.stringify({
      submissionId: "sub-confidence-1",
      submittedAt: new Date().toISOString(),
      scoreId: "score-test-clean",
      audioPath,
      instrument: "violin",
      limit: 3,
      status: "review_required",
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(m3Root, "controlled-submission-reviews.jsonl"),
    `${JSON.stringify({ submissionId: "sub-confidence-1", action: "accepted_for_batch" })}\n`,
    "utf8",
  );

  const fixtureCopies = [
    [
      path.join(process.cwd(), "data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
      path.join(m3Root, "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
    ],
    [
      path.join(process.cwd(), "data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-confidence-pilot.json"),
      path.join(m3Root, "offline-feature-candidate-review", "candidate-confidence-pilot.json"),
    ],
    [
      path.join(process.cwd(), "data", "experiments", "western-strings-m3", "confidence-validation-review", "confidence-validation-eval.json"),
      path.join(m3Root, "confidence-validation-review", "confidence-validation-eval.json"),
    ],
  ];
  for (const [from, to] of fixtureCopies) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
  const releasePath = path.join(tempRoot, "models", "western-strings", "ordinary-upload-confidence-rf-v1", "release.json");
  await fs.mkdir(path.dirname(releasePath), { recursive: true });
  await fs.copyFile(
    path.join(process.cwd(), "models", "western-strings", "ordinary-upload-confidence-rf-v1", "release.json"),
    releasePath,
  );

  const oldEnable = process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE;
  const oldRelease = process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE;
  process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE = "1";
  process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE = releasePath;
  try {
    const result = await runWesternControlledSubmissionBatch({ repoRoot: tempRoot, limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.batch.itemCount, 1);
    assert.equal(result.batch.status, "offline_feature_confidence_ready");
    const item = result.batch.items[0];
    assert.equal(item.analysisStatus, "offline_feature_confidence_ready");
    assert.equal(item.candidateGate.ready, true);
    assert.equal(item.candidateGate.mode, "confidence_rf");
    assert.equal(item.candidateGate.gateVersion, "western-offline-feature-gate-v1-confidence-rf");
    assert.equal(item.candidateGate.modelVersion, "ordinary-upload-confidence-rf-v1");
    assert.equal(item.candidateGate.threshold, 0.7);
    assert.equal(item.candidateGate.evaluatedCandidateCount, 3);
    assert.equal(item.candidateGate.autoPassCandidateCount + item.candidateGate.reviewRequiredCandidateCount, 3);
    assert.equal(item.candidatePreview.length, 3);
    assert(item.candidatePreview.every((candidate) => typeof candidate.confidenceProbability === "number"));
    assert(item.candidatePreview.every((candidate) => candidate.gateVersion === "western-offline-feature-gate-v1-confidence-rf"));
    assert(item.candidatePreview.every((candidate) => candidate.studentSafeGateReady === true));
    const artifact = JSON.parse(await fs.readFile(path.join(tempRoot, item.candidateRowsPath), "utf8"));
    assert.equal(artifact.rowCount, 3);
    assert(artifact.candidateRows.every((candidate) => typeof candidate.confidenceProbability === "number"));
  } finally {
    if (oldEnable === undefined) {
      delete process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE;
    } else {
      process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE = oldEnable;
    }
    if (oldRelease === undefined) {
      delete process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE;
    } else {
      process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE = oldRelease;
    }
  }
}

await testServiceDefaultNoLeakage();
await testServiceEvaluationSummary();
await testStudentSafeFailClosed();
await testStudentSafeSequenceSupportGate();
await testStudentAnalysisServiceReady();
await testRoute();
await testStudentAnalyzeAndReviewRoutes();
await testControlledSubmissionRoute();
await testControlledSubmissionValidatedReplayBatch();
await testControlledSubmissionOfflineFeatureReviewBatch();
await testControlledSubmissionOfflineFeatureConfidenceGateEnabled();

console.log(JSON.stringify({ ok: true, checks: ["western-alignment-preview-service", "western-alignment-preview-route", "western-student-analysis-route", "western-controlled-submission-route"] }));
