import fs from "node:fs/promises";

import { safeString } from "./baseUtils.js";
import {
  controlledSubmissionReviewsPath,
  controlledSubmissionsPath,
} from "./westernStringsAlignmentService.js";

// Single server-side source of the student-facing runtime switches. Values must
// mirror `runtimeStudentGate` in scripts/status-western-strings-project.mjs and
// stay fail-closed until the release gate passes; flipping any switch is a
// governed code change (release review + owner approval), never a config read.
export const WESTERN_STUDENT_RUNTIME_GATE = Object.freeze({
  ordinaryUploadAutoFeedbackReady: false,
  m3plusAutoFeedbackReady: false,
  m4OmrAutoScoreReady: false,
  policy: "fail-closed",
});

// Everything the student UI may render is derived from the switches here, so
// the page needs no fail-closed knowledge of its own: when a switch flips
// after release, the same wiring unlocks the corresponding capability.
export function buildWesternStudentGateView() {
  const gate = WESTERN_STUDENT_RUNTIME_GATE;
  const autoFeedback = gate.ordinaryUploadAutoFeedbackReady === true
    && gate.m3plusAutoFeedbackReady === true;
  return {
    ok: true,
    gate: { ...gate },
    capabilities: {
      autoFeedback,
      autoScoreFromPhoto: gate.m4OmrAutoScoreReady === true,
      reviewFlow: true,
      submissionAccepted: true,
    },
    studentNotice: autoFeedback
      ? "提交后可查看自动诊断结果。"
      : "当前为受控试点:录音提交后由老师复核,复核完成的反馈会显示在下方列表。系统不提供即时自动判定。",
  };
}

async function readJsonlRecords(targetPath) {
  let raw = "";
  try {
    raw = await fs.readFile(targetPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function studentStatusFrom(reviewAction, released) {
  if (released) return "feedback_released";
  if (reviewAction === "reject_unsupported") return "unsupported";
  if (reviewAction === "accepted_for_batch" || reviewAction === "review_required") return "under_review";
  if (reviewAction === "failed") return "under_review";
  return "queued";
}

// Student-visible projection of a controlled submission. Deliberately narrow:
// no analysis internals, no candidate/batch fields, no reviewer identity —
// review-only machine output must never leak to the student side.
export function buildStudentSubmissionView(submission, latestReview = null) {
  const released = latestReview?.releaseToStudent === true
    && Boolean(safeString(latestReview?.studentMessage).trim());
  const reviewAction = safeString(latestReview?.action).trim();
  return {
    submissionId: safeString(submission.submissionId).trim(),
    submittedAt: safeString(submission.submittedAt),
    piece: safeString(submission.piece),
    pieceId: safeString(submission.pieceId),
    instrument: safeString(submission.instrument),
    kind: safeString(submission.kind, submission.scorePhotoPath ? "photo-score" : "clean-score"),
    status: studentStatusFrom(reviewAction, released),
    teacherFeedback: released ? safeString(latestReview.studentMessage).trim() : "",
    teacherFeedbackAt: released ? safeString(latestReview.submittedAt) : "",
  };
}

export async function listWesternStudentSubmissions({ repoRoot = process.cwd(), studentRef = "", limit = 20 } = {}) {
  const targetRef = safeString(studentRef).trim();
  if (!targetRef) {
    const error = new Error("studentRef is required.");
    error.statusCode = 400;
    throw error;
  }
  const submissions = await readJsonlRecords(controlledSubmissionsPath(repoRoot));
  const reviews = await readJsonlRecords(controlledSubmissionReviewsPath(repoRoot));
  const latestReview = new Map();
  for (const review of reviews) {
    const submissionId = safeString(review.submissionId).trim();
    if (submissionId) latestReview.set(submissionId, review);
  }
  const mine = submissions
    .filter((submission) => safeString(submission.studentRef).trim() === targetRef)
    .map((submission) => buildStudentSubmissionView(
      submission,
      latestReview.get(safeString(submission.submissionId).trim()) || null,
    ))
    .filter((submission) => submission.submissionId)
    .sort((left, right) => safeString(right.submittedAt).localeCompare(safeString(left.submittedAt)));
  const capped = limit > 0 ? mine.slice(0, limit) : mine;
  return {
    ok: true,
    studentRef: targetRef,
    gateView: buildWesternStudentGateView(),
    total: mine.length,
    submissions: capped,
  };
}
