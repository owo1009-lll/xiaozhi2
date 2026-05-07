import assert from "node:assert/strict";
import {
  buildImportStatusMessage,
  buildPiecePassStatusMessage,
  friendlyErrorMessage,
  getPartCandidateKey,
  getPiecePassCompletionState,
  importProgressHeadline,
  isAccompanimentCandidate,
  needsPartReview,
  percentText,
  scoreImportStatusText,
} from "../src/student/studentStatus.js";

assert.equal(percentText(0.428), "43%");

const queuedScoreJob = { omrStatus: "processing", stage: "queued", progress: 0.25 };
assert.equal(scoreImportStatusText(queuedScoreJob), "排队中");
assert.match(importProgressHeadline(queuedScoreJob), /排队/);
assert.match(buildImportStatusMessage(queuedScoreJob), /25%/);

assert.equal(getPartCandidateKey({ selectionKey: "score-part-2" }, 0), "score-part-2");
assert.equal(isAccompanimentCandidate({ label: "Piano" }), true);
assert.equal(
  needsPartReview(
    {
      omrStatus: "completed",
      selectedPartConfidence: 0.54,
      partCandidates: [{ label: "Erhu" }, { label: "Piano" }],
    },
    null,
  ),
  true,
);

assert.deepEqual(
  getPiecePassCompletionState({ attemptedSectionCount: 3, matchedSectionCount: 2, failedSectionCount: 1 }),
  { attempted: 3, matched: 2, failed: 1, timedOut: 0, complete: false },
);
assert.match(buildPiecePassStatusMessage({ status: "processing", stage: "queued" }), /排队/);
assert.equal(friendlyErrorMessage(new Error("analysis traceback /api/internal")), "操作失败，请稍后重试。");

console.log(JSON.stringify({ ok: true, checks: ["queued-copy", "part-review", "piece-pass-summary", "friendly-errors"] }, null, 2));
