import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  controlledSubmissionReviewsPath,
  controlledSubmissionsPath,
  listWesternControlledSubmissionModelSuggestions,
} from "../src/server/westernStringsAlignmentService.js";
import { writeScoreStoreToSqlite } from "../src/server/scoreStoreSqlite.js";
import {
  enqueueWesternStageAModelSuggestionJob,
  readWesternStageAModelSuggestionJob,
  waitForWesternStageAModelSuggestionJob,
} from "../src/server/westernStringsStageAModelSuggestions.js";

const service = fs.readFileSync("src/server/westernStringsAlignmentService.js", "utf8");
const routes = fs.readFileSync("src/server/westernStringsRoutes.js", "utf8");
const guard = fs.readFileSync("src/server/publicAccessGuard.js", "utf8");
const scorer = fs.readFileSync("scripts/experiments/score_submission_with_stage_a_model.py", "utf8");
const projectStatus = fs.readFileSync("scripts/status-western-strings-project.mjs", "utf8");

assert(service.includes("teacherInventorySignoff"), "unlock must use a submission-bound teacher inventory signature");
assert(service.includes('withheldReason: "teacher-signoff-pending"'));
assert(service.includes("studentFacing: false"));
assert(service.includes("automaticAccusationAuthorized: false"));
assert(!projectStatus.includes("modelSuggestions") && !projectStatus.includes("model-suggestions"));
assert(scorer.includes("stage-a model artifact sha mismatch"));
assert(scorer.includes('"scoreSha256": sha256(score_path)'));
assert(scorer.includes('"isEvidence": False'));
assert(routes.includes("/api/strings/controlled-submissions/:submissionId/model-suggestions"));
assert(!guard.includes('path: "/api/strings/controlled-submissions/:submissionId/model-suggestions"'));

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "stage-a-suggestions-"));
const scoreRelative = "data/score-imports/test/source.musicxml";
const audioRelative = "data/analysis-audio-cache/test.m4a";
const scorePath = path.join(root, scoreRelative);
const audioPath = path.join(root, audioRelative);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

try {
  await fsp.mkdir(path.dirname(scorePath), { recursive: true });
  await fsp.mkdir(path.dirname(audioPath), { recursive: true });
  await fsp.writeFile(scorePath, "<score-partwise version=\"4.0\"></score-partwise>");
  await fsp.writeFile(audioPath, "test-audio");
  writeScoreStoreToSqlite(path.join(root, "data", "erhu-score-imports.sqlite"), {
    jobs: [],
    scores: [{ scoreId: "score-test", musicxmlPath: `/${scoreRelative.replace(/\\/g, "/")}` }],
  });
  const submission = {
    submissionId: "strings-submit-test",
    scoreId: "score-test",
    kind: "clean-score",
    audioPath: audioRelative,
    audioHash: crypto.createHash("sha1").update("test-audio").digest("hex"),
  };
  await fsp.mkdir(path.dirname(controlledSubmissionsPath(root)), { recursive: true });
  await fsp.writeFile(controlledSubmissionsPath(root), `${JSON.stringify(submission)}\n`);

  const runner = async ({ scorePath: resolvedScore, audioPath: resolvedAudio, outPath }) => {
    await fsp.writeFile(outPath, JSON.stringify({
      contract: "western-round6-stage-a-model-teacher-suggestions-v1",
      scoreSha256: hash(await fsp.readFile(resolvedScore)),
      audioSha256: hash(await fsp.readFile(resolvedAudio)),
      provenance: { stageAPassed: false, modelSha256: "a".repeat(64) },
      suggestionCount: 1,
      suggestions: [{ noteIndex: 0, measure: 1, beat: 1, scoreMidi: 69, gate: "drag", probability: 0.8 }],
      studentFacing: false,
      automaticAccusationAuthorized: false,
      isEvidence: false,
    }));
  };

  const queued = await enqueueWesternStageAModelSuggestionJob({ repoRoot: root, submission, runner });
  assert.equal(queued.status, "queued", "batch-side enqueue must return before inference completes");
  const completed = await waitForWesternStageAModelSuggestionJob({ repoRoot: root, submissionId: submission.submissionId });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.report.submissionId, submission.submissionId);

  const withheld = await listWesternControlledSubmissionModelSuggestions({ repoRoot: root, submissionId: submission.submissionId });
  assert.equal(withheld.withheld, true, "a generated report must still be hidden before this submission is signed");

  await fsp.writeFile(controlledSubmissionReviewsPath(root), `${JSON.stringify({
    submissionId: submission.submissionId,
    teacherInventorySignoff: {
      contract: "western-teacher-complete-inventory-signoff-v1",
      submissionId: submission.submissionId,
    },
  })}\n`);
  const visible = await listWesternControlledSubmissionModelSuggestions({ repoRoot: root, submissionId: submission.submissionId });
  assert.equal(visible.withheld, false);
  assert.equal(visible.status, "succeeded");
  assert.equal(visible.suggestions.length, 1);
  assert.equal(visible.studentFacing, false);

  const failedAudioRelative = "data/analysis-audio-cache/failure.m4a";
  await fsp.writeFile(path.join(root, failedAudioRelative), "failed-audio");
  const failedSubmission = {
    ...submission,
    submissionId: "strings-submit-failure",
    audioPath: failedAudioRelative,
  };
  await enqueueWesternStageAModelSuggestionJob({
    repoRoot: root,
    submission: failedSubmission,
    runner: async () => { throw new Error("inference fixture failed"); },
  });
  await assert.rejects(
    () => waitForWesternStageAModelSuggestionJob({ repoRoot: root, submissionId: failedSubmission.submissionId }),
    /inference fixture failed/,
  );
  const failed = await readWesternStageAModelSuggestionJob({ repoRoot: root, submissionId: failedSubmission.submissionId });
  assert.equal(failed.status, "failed", "inference failure must remain visible after the worker promise is gone");
  assert.match(failed.job.error, /inference fixture failed/);

  await fsp.writeFile(audioPath, "changed-audio");
  const stale = await readWesternStageAModelSuggestionJob({ repoRoot: root, submission });
  assert.equal(stale.status, "stale", "changed score/audio identity must invalidate a cached suggestion report");
  assert.equal(stale.report, null);
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: "background-producer, persisted-success-and-failure, score-audio-binding, submission-signoff, reviewer-only, stale-fail-closed",
}, null, 2));
