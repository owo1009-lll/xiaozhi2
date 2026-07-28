import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

import {
  buildAudioSubmissionFromUpload,
  parseIncomingPayload,
  persistPayloadAudio,
  persistUploadedAudioFile,
} from "../src/server/audioPayload.js";
import {
  buildScorePhotoSubmissionFromUpload,
  persistPayloadScorePhoto,
  persistUploadedScorePhotoFile,
} from "../src/server/scorePhotoPayload.js";
import { createMemoryUploadProfiles } from "../src/server/uploadProfiles.js";
import {
  buildWesternStudentAnalysis,
  parseStudentAnalysisPayload,
  recordWesternControlledSubmissionReview,
  runWesternControlledSubmissionBatch,
} from "../src/server/westernStringsAlignmentService.js";
import { createWesternStringsRouter } from "../src/server/westernStringsRoutes.js";

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const webStudentRef = `stu-v2-${"a".repeat(32)}`;

const parsed = parseStudentAnalysisPayload({
  scorePhotoPath: "data/private/x.jpg",
  scorePhotoHash: "photo-hash",
  scorePhotoSubmission: { name: "x.jpg" },
  audioPath: "data/private/x.m4a",
});
assert.equal(parsed.scorePhotoPath, "data/private/x.jpg");
assert.equal(parsed.scorePhotoHash, "photo-hash");
assert.equal(parsed.scorePhotoSubmission.name, "x.jpg");

const serviceSource = fs.readFileSync("src/server/westernStringsAlignmentService.js", "utf8");
const photoAnalyzerSource = serviceSource.split("async function runOfflinePhotoScoreAnalyzer", 2)[1]
  ?.split("async function buildControlledBatchPhotoScoreAnalysis", 1)[0] || "";
assert(photoAnalyzerSource.includes("run-western-photo-score-python.ps1"), "server photo-score path must use the exact fail-closed wrapper");
assert(!photoAnalyzerSource.includes("run-python.ps1"), "server photo-score path must not use the fallback analyzer runner");
const cliBatchSource = fs.readFileSync("scripts/run-western-photo-score-batch.mjs", "utf8");
assert(cliBatchSource.includes("preflight-western-photo-score-deployment.mjs"), "CLI batch must preflight before reading accepted work");
assert(cliBatchSource.includes('filter((r) => r.status === "ok")'), "failed rows must remain retryable");
assert(cliBatchSource.includes("res.status === 0 && parsed"), "CLI batch must require a successful child exit code");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-photo-intake-"));
const sourceDir = path.join(tmp, "source");
fs.mkdirSync(sourceDir, { recursive: true });
const sourcePhoto = path.join(sourceDir, "demo.jpg");
const sourceAudio = path.join(sourceDir, "demo.wav");
fs.writeFileSync(sourcePhoto, Buffer.from("test-score-image"));
fs.writeFileSync(sourceAudio, Buffer.from("test-audio"));

const result = await buildWesternStudentAnalysis({
  repoRoot: tmp,
  submissionPayload: {
    scorePhotoPath: sourcePhoto,
    scorePhotoSubmission: { name: "demo.jpg", mimeType: "image/jpeg" },
    audioPath: sourceAudio,
  },
});
assert.equal(result.ok, true);
assert.equal(result.studentReady, false, "photo submission must never be studentReady");
assert.equal(result.submissionAccepted, true);
assert.ok(result.blockingReasons.includes("photo-score-requires-offline-pipeline"));
assert.equal((result.decisions || []).length, 0, "no decisions may be returned at intake");

const submissionsPath = path.join(tmp, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl");
const stored = fs.readFileSync(submissionsPath, "utf8");
const submission = JSON.parse(stored.trim().split(/\r?\n/).pop());
assert.equal(submission.kind, "photo-score");
assert.equal(submission.status, "review_required");

await recordWesternControlledSubmissionReview({
  repoRoot: tmp,
  payload: { submissionId: submission.submissionId, action: "accepted_for_batch" },
});
const secondResult = await buildWesternStudentAnalysis({
  repoRoot: tmp,
  submissionPayload: {
    scorePhotoPath: sourcePhoto,
    scorePhotoSubmission: { name: "demo-2.jpg", mimeType: "image/jpeg" },
    audioPath: sourceAudio,
    recordingId: "second-photo-submission",
  },
});
await recordWesternControlledSubmissionReview({
  repoRoot: tmp,
  payload: { submissionId: secondResult.submission.submissionId, action: "accepted_for_batch" },
});
let photoRunnerCalls = 0;
const batch = await runWesternControlledSubmissionBatch({
  repoRoot: tmp,
  limit: 1,
  submissionIds: [submission.submissionId],
  runPhotoScoreAnalysis: async () => {
    photoRunnerCalls += 1;
    return {
      decision: "degraded-feedback:up2",
      audit: "data/analysis-photo-score/test/audit.json",
      candidates: [{ variant: "up2", status: "ok", confirmed: 8, agreement: 0.7 }],
    };
  },
});
assert.equal(photoRunnerCalls, 1, "accepted photo-score submission must dispatch to the photo pipeline");
assert.equal(batch.batch.itemCount, 1, "an explicit submission filter must not consume another accepted queue item");
assert.equal(batch.batch.items[0].submissionId, submission.submissionId);
assert.equal(batch.batch.status, "photo_score_review_ready");
assert.equal(batch.batch.autoDiagnosisIssued, false);
assert.equal(batch.batch.items[0].analysisStatus, "photo_score_review_ready");
assert.equal(batch.batch.items[0].photoScoreDecision, "degraded-feedback:up2");
assert.equal(batch.batch.items[0].offlineAnalysisProduced, true);
const photoAuditRows = fs.readFileSync(
  path.join(tmp, "data", "experiments", "western-strings-m4", "photo-score-batch-runs.jsonl"),
  "utf8",
).trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(photoAuditRows.length, 1);
assert.equal(photoAuditRows[0].studentFacing, false);
assert.equal(photoAuditRows[0].decision, "degraded-feedback:up2");

const httpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-photo-http-"));
const audioCacheDir = path.join(httpRoot, "data", "analysis-audio-cache");
const scorePhotoCacheDir = path.join(httpRoot, "data", "analysis-score-photo-cache");
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(createWesternStringsRouter({
  repoRoot: httpRoot,
  upload: createMemoryUploadProfiles().westernStudent,
  audioCacheDir,
  scorePhotoCacheDir,
  parseIncomingPayload,
  buildAudioSubmissionFromUpload,
  buildScorePhotoSubmissionFromUpload,
  persistUploadedAudioFile,
  persistPayloadAudio,
  persistUploadedScorePhotoFile,
  persistPayloadScorePhoto,
}));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});

try {
  const port = server.address().port;
  const form = new FormData();
  form.append("payload", JSON.stringify({ instrument: "violin", studentRef: webStudentRef }));
  form.append("audio", new Blob([Buffer.from("browser-audio")], { type: "audio/wav" }), "browser.wav");
  form.append("scorePhoto", new Blob([validPng], { type: "image/png" }), "browser.png");
  const response = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7", "cf-ray": "test-ray" },
    body: form,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.analysis.submissionAccepted, true);
  assert.equal(body.analysis.submission, undefined, "public analysis response must not expose internal submission paths");
  assert.equal(JSON.stringify(body.analysis).includes("audioPath"), false);

  const weakIdentityForm = new FormData();
  weakIdentityForm.append("payload", JSON.stringify({ instrument: "violin", studentRef: "stu-guessable" }));
  weakIdentityForm.append("audio", new Blob([Buffer.from("weak-id-audio")], { type: "audio/wav" }), "weak.wav");
  const weakIdentityResponse = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7", "cf-ray": "weak-id-ray" },
    body: weakIdentityForm,
  });
  assert.equal(weakIdentityResponse.status, 401, "public web submissions must use an unguessable capability");

  const queueResponse = await fetch(`http://127.0.0.1:${port}/api/strings/controlled-submissions`);
  const queue = await queueResponse.json();
  assert.equal(queue.submissions.length, 1);
  const queued = queue.submissions[0];
  assert.equal(queued.kind, "photo-score");
  assert.equal(queued.scorePhotoSubmission.name, "browser.png");
  assert.ok(queued.scorePhotoUrl);
  assert.ok(queued.audioUrl);

  const photoResponse = await fetch(`http://127.0.0.1:${port}${queued.scorePhotoUrl}`);
  assert.equal(photoResponse.status, 200);
  assert.deepEqual(Buffer.from(await photoResponse.arrayBuffer()), validPng);
  const audioResponse = await fetch(`http://127.0.0.1:${port}${queued.audioUrl}`);
  assert.equal(audioResponse.status, 200);
  assert.equal(Buffer.from(await audioResponse.arrayBuffer()).toString(), "browser-audio");

  const badForm = new FormData();
  badForm.append("payload", JSON.stringify({ instrument: "violin" }));
  badForm.append("audio", new Blob([Buffer.from("audio")], { type: "audio/wav" }), "bad.wav");
  badForm.append("scorePhoto", new Blob([Buffer.from("pdf")], { type: "application/pdf" }), "unsupported.pdf");
  const badResponse = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, { method: "POST", body: badForm });
  assert.equal(badResponse.status, 400, "unsupported PDF must fail before entering the review queue");

  const spoofedForm = new FormData();
  spoofedForm.append("payload", JSON.stringify({ instrument: "violin" }));
  spoofedForm.append("audio", new Blob([Buffer.from("audio")], { type: "audio/wav" }), "spoofed.wav");
  spoofedForm.append("scorePhoto", new Blob([Buffer.from("not-a-png")], { type: "image/png" }), "spoofed.png");
  const spoofedResponse = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, { method: "POST", body: spoofedForm });
  assert.equal(spoofedResponse.status, 400, "a spoofed image MIME type must fail content validation");

  const localAudioPathResponse = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instrument: "violin",
      scoreId: "score-test-clean",
      audioPath: sourceAudio,
      audioSubmission: { name: "outside-cache.wav", mimeType: "audio/wav" },
    }),
  });
  assert.equal(localAudioPathResponse.status, 400, "HTTP payloads must not read audio outside the managed cache");

  const outsideCachePhoto = path.join(httpRoot, "outside-cache.png");
  fs.writeFileSync(outsideCachePhoto, validPng);
  const localPathResponse = await fetch(`http://127.0.0.1:${port}/api/strings/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instrument: "violin",
      audioPath: sourceAudio,
      scorePhotoPath: outsideCachePhoto,
      scorePhotoSubmission: { name: "outside-cache.png", mimeType: "image/png" },
    }),
  });
  assert.equal(localPathResponse.status, 400, "HTTP payloads must not read score images outside the managed cache");
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(httpRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "photo-payload-parsed",
    "photo-intake-fail-closed",
    "photo-batch-dispatch-review-only",
    "photo-batch-audit-written",
    "multipart-upload-persisted",
    "queue-photo-and-audio-readable",
    "unsupported-pdf-rejected",
    "spoofed-image-content-rejected",
    "outside-cache-path-rejected",
  ],
}));
