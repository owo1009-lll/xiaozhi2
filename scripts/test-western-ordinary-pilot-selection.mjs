import assert from "node:assert/strict";

import { filterAcceptedSubmissions } from "./run-western-ordinary-monitored-pilot-review-pack.mjs";

const submissions = [
  { submissionId: "sub-old", recordingId: "recording-old" },
  { submissionId: "sub-new", recordingId: "recording-new" },
  { submissionId: "sub-unreviewed", recordingId: "recording-unreviewed" },
];
const acceptedReviews = [
  { submissionId: "sub-old", action: "accepted_for_batch" },
  { submissionId: "sub-new", action: "accepted_for_batch" },
  { submissionId: "sub-unreviewed", action: "review_required" },
];

const defaultSelection = filterAcceptedSubmissions({ submissions, acceptedReviews });
assert.deepEqual(
  defaultSelection.map((item) => item.recordingId),
  ["recording-old", "recording-new"],
  "empty include filter must preserve existing behavior",
);

const exactSelection = filterAcceptedSubmissions({
  submissions,
  acceptedReviews,
  includeRecordingIds: ["recording-new"],
});
assert.deepEqual(
  exactSelection.map((item) => item.recordingId),
  ["recording-new"],
  "recording whitelist must select only the requested fresh recording",
);

const excludedWins = filterAcceptedSubmissions({
  submissions,
  acceptedReviews,
  includeRecordingIds: ["recording-new"],
  excludedRecordingIds: ["recording-new"],
});
assert.deepEqual(excludedWins, [], "history exclusion must override an explicit include filter");

const unknownSelection = filterAcceptedSubmissions({
  submissions,
  acceptedReviews,
  includeRecordingIds: ["recording-missing"],
});
assert.deepEqual(unknownSelection, [], "unknown recording whitelist must fail closed");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "default-selection-preserved",
    "exact-recording-whitelist",
    "history-exclusion-wins",
    "unknown-recording-fails-closed",
  ],
}, null, 2));
