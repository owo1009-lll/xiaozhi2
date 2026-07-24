import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

import {
  buildWesternStudentAnalysis,
  parseStudentAnalysisPayload,
  recordWesternControlledSubmissionReview,
} from "../src/server/westernStringsAlignmentService.js";
import {
  WESTERN_STUDENT_RUNTIME_GATE,
  buildStudentSubmissionView,
  buildWesternStudentGateView,
  listWesternStudentSubmissions,
} from "../src/server/westernStudentGateService.js";
import { createWesternStringsRouter } from "../src/server/westernStringsRoutes.js";

// 1. The runtime gate must be structurally fail-closed and frozen.
assert.equal(WESTERN_STUDENT_RUNTIME_GATE.ordinaryUploadAutoFeedbackReady, false, "ordinary upload auto feedback must stay fail-closed");
assert.equal(WESTERN_STUDENT_RUNTIME_GATE.m3plusAutoFeedbackReady, false, "m3plus auto feedback must stay fail-closed");
assert.equal(WESTERN_STUDENT_RUNTIME_GATE.m4OmrAutoScoreReady, false, "m4 OMR auto score must stay fail-closed");
assert.equal(WESTERN_STUDENT_RUNTIME_GATE.policy, "fail-closed");
assert.ok(Object.isFrozen(WESTERN_STUDENT_RUNTIME_GATE), "runtime gate object must be frozen");

// 2. Every student-facing capability must derive from the switches.
const gateView = buildWesternStudentGateView();
assert.equal(gateView.ok, true);
assert.equal(gateView.capabilities.autoFeedback, false, "auto feedback capability must be off while switches are closed");
assert.equal(gateView.capabilities.autoScoreFromPhoto, false, "photo auto-score capability must be off while m4 switch is closed");
assert.equal(gateView.capabilities.reviewFlow, true);
assert.ok(gateView.studentNotice.includes("复核"), "fail-closed notice must describe the review flow");

// 3. parseStudentAnalysisPayload must carry studentRef and instrument through.
const parsed = parseStudentAnalysisPayload({
  studentRef: " stu-abc ",
  instrument: "violin",
  piece: "Kayser Op.20 No.3",
  pieceId: "bwv1001-mov1",
});
assert.equal(parsed.studentRef, "stu-abc");
assert.equal(parsed.instrument, "violin");
assert.equal(parsed.pieceId, "bwv1001-mov1");

// 4. End-to-end in a temp repo root: submit, triage, release, list.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-student-gate-"));
const sourceAudio = path.join(tmp, "take.wav");
fs.writeFileSync(sourceAudio, Buffer.from("test-audio"));

const intake = await buildWesternStudentAnalysis({
  repoRoot: tmp,
  submissionPayload: {
    studentRef: "stu-abc",
    piece: "Kayser Op.20 No.3",
    pieceId: "bwv1001-mov1",
    instrument: "violin",
    audioPath: sourceAudio,
    audioSubmission: { name: "take.wav", mimeType: "audio/wav" },
  },
});
assert.equal(intake.submissionAccepted, true);
assert.equal(intake.studentReady, false, "intake must never be studentReady");
const submissionId = intake.submission.submissionId;
assert.ok(submissionId);
assert.equal(intake.submission.studentRef, "stu-abc", "stored submission must carry studentRef");

await buildWesternStudentAnalysis({
  repoRoot: tmp,
  submissionPayload: {
    studentRef: "stu-other",
    piece: "someone else's take",
    audioPath: sourceAudio,
    audioSubmission: { name: "other.wav", mimeType: "audio/wav" },
  },
});

// Before any review: queued, and only the caller's own submissions are listed.
let listed = await listWesternStudentSubmissions({ repoRoot: tmp, studentRef: "stu-abc" });
assert.equal(listed.total, 1, "student must only see their own submissions");
assert.equal(listed.submissions[0].status, "queued");
assert.equal(listed.submissions[0].teacherFeedback, "");
assert.equal(listed.submissions[0].pieceId, "bwv1001-mov1");

// The student view must stay a narrow projection — no analysis internals ever.
const viewKeys = Object.keys(listed.submissions[0]).sort();
assert.deepEqual(viewKeys, [
  "instrument",
  "kind",
  "piece",
  "pieceId",
  "status",
  "submissionId",
  "submittedAt",
  "teacherFeedback",
  "teacherFeedbackAt",
], "student submission view must expose exactly the whitelisted fields");

// Triage moves it to under_review; nothing leaks to the student.
await recordWesternControlledSubmissionReview({
  repoRoot: tmp,
  payload: { submissionId, action: "accepted_for_batch" },
});
listed = await listWesternStudentSubmissions({ repoRoot: tmp, studentRef: "stu-abc" });
assert.equal(listed.submissions[0].status, "under_review");
assert.equal(listed.submissions[0].teacherFeedback, "");

// feedback_released requires a human-authored message.
await assert.rejects(
  recordWesternControlledSubmissionReview({
    repoRoot: tmp,
    payload: { submissionId, action: "feedback_released", releaseToStudent: true },
  }),
  /studentMessage/,
  "releasing without a message must fail",
);

// A stored studentMessage without the explicit release flag stays hidden.
await recordWesternControlledSubmissionReview({
  repoRoot: tmp,
  payload: { submissionId, action: "review_required", studentMessage: "draft, not released" },
});
listed = await listWesternStudentSubmissions({ repoRoot: tmp, studentRef: "stu-abc" });
assert.equal(listed.submissions[0].teacherFeedback, "", "unreleased feedback must stay hidden");
assert.equal(listed.submissions[0].status, "under_review");

// Explicit release makes the human-authored feedback visible.
await recordWesternControlledSubmissionReview({
  repoRoot: tmp,
  payload: {
    submissionId,
    action: "feedback_released",
    studentMessage: "第 3 小节第 2 拍音准偏低,注意二指位置。",
    releaseToStudent: true,
  },
});
listed = await listWesternStudentSubmissions({ repoRoot: tmp, studentRef: "stu-abc" });
assert.equal(listed.submissions[0].status, "feedback_released");
assert.ok(listed.submissions[0].teacherFeedback.includes("第 3 小节"));

// Unsupported rejection maps to the student-facing unsupported status.
await recordWesternControlledSubmissionReview({
  repoRoot: tmp,
  payload: { submissionId, action: "reject_unsupported" },
});
listed = await listWesternStudentSubmissions({ repoRoot: tmp, studentRef: "stu-abc" });
assert.equal(listed.submissions[0].status, "unsupported");

// buildStudentSubmissionView never trusts a message without the release flag.
const guarded = buildStudentSubmissionView(
  { submissionId: "s-1", piece: "x" },
  { action: "accepted_for_batch", studentMessage: "leak?", releaseToStudent: false },
);
assert.equal(guarded.teacherFeedback, "");
assert.equal(guarded.status, "under_review");

// 5. Router wiring: gate endpoint serves the view; the list requires studentRef.
const app = express();
app.use(express.json());
app.use(createWesternStringsRouter({ repoRoot: tmp }));
const server = app.listen(0);
const port = server.address().port;
try {
  const gateResponse = await fetch(`http://127.0.0.1:${port}/api/strings/student-gate`);
  assert.equal(gateResponse.status, 200);
  const gateBody = await gateResponse.json();
  assert.equal(gateBody.capabilities.autoFeedback, false);
  assert.equal(gateBody.gate.policy, "fail-closed");

  const missingRef = await fetch(`http://127.0.0.1:${port}/api/strings/student-submissions`);
  assert.equal(missingRef.status, 400, "listing without studentRef must be rejected");

  const ownList = await fetch(`http://127.0.0.1:${port}/api/strings/student-submissions?studentRef=stu-abc`);
  assert.equal(ownList.status, 200);
  const ownBody = await ownList.json();
  assert.equal(ownBody.total, 1);
  assert.equal(ownBody.submissions[0].status, "unsupported");
} finally {
  server.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("western student gate tests passed");
