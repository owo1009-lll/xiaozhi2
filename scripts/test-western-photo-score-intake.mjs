import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWesternStudentAnalysis, parseStudentAnalysisPayload } from "../src/server/westernStringsAlignmentService.js";

// 1) payload parser carries scorePhotoPath
const parsed = parseStudentAnalysisPayload({ scorePhotoPath: "data/private/x.jpg", audioPath: "data/private/x.m4a" });
assert.equal(parsed.scorePhotoPath, "data/private/x.jpg");

// 2) photo-score submission is accepted into the offline queue, fail-closed
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-photo-intake-"));
const result = await buildWesternStudentAnalysis({
  repoRoot: tmp,
  submissionPayload: { scorePhotoPath: "data/private/demo.jpg", audioPath: "data/private/demo.m4a" },
});
assert.equal(result.ok, true);
assert.equal(result.studentReady, false, "photo submission must never be studentReady");
assert.equal(result.submissionAccepted, true);
assert.ok(result.blockingReasons.includes("photo-score-requires-offline-pipeline"));
assert.equal((result.decisions || []).length, 0, "no decisions may be returned at intake");
const stored = fs.readFileSync(
  path.join(tmp, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl"), "utf8");
const sub = JSON.parse(stored.trim().split(/\r?\n/).pop());
assert.equal(sub.kind, "photo-score");
assert.equal(sub.status, "review_required");

// 3) batch runner source contract: review-only, never student-facing
const batchSrc = fs.readFileSync("scripts/run-western-photo-score-batch.mjs", "utf8");
for (const token of ["autoDiagnosisIssued: false", "studentFacing: false", "accepted_for_batch"]) {
  assert.ok(batchSrc.includes(token), `batch runner must contain: ${token}`);
}
assert.ok(!batchSrc.includes("/api/strings/analyze"), "batch runner must not call student routes");

console.log(JSON.stringify({ ok: true, checks: ["photo-payload-parsed", "photo-intake-fail-closed", "photo-intake-queued", "batch-review-only"] }));
