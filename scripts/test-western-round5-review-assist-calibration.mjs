import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeReviewAssistCalibrationPack } from "./export-western-round5-review-assist-calibration.mjs";
import { stageReviewAssistCalibration } from "./stage-western-round5-review-assist-calibration.mjs";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "round5-review-assist-"));

try {
  const audioBytes = Buffer.from("fixture-audio");
  const scoreBytes = Buffer.from("<score-partwise/>");
  const audioHash = sha256(audioBytes);
  await fs.mkdir(path.join(root, "private"), { recursive: true });
  await fs.writeFile(path.join(root, "private", "recording.m4a"), audioBytes);
  await fs.writeFile(path.join(root, "private", "score.musicxml"), scoreBytes);
  await fs.writeFile(path.join(root, "private", "manifest.csv"), [
    "recordingId,pieceId,audioPath,scorePath,scoreId,sourceRound",
    "rec-1,piece-1,private/recording.m4a,private/score.musicxml,score-1,fixture",
    "",
  ].join("\n"));

  const artifact = {
    batchRunId: "batch-1",
    submissionId: "submission-1",
    candidateRows: [{
      candidateId: "candidate-1",
      noteId: "note-1",
      noteIndex: 3,
      measureIndex: 2,
      beatStart: 1,
      midi: 69,
      predictedOnsetSeconds: 1.25,
      reviewAssistDecision: {
        contract: "western-round4-policy-c-review-assist-v1",
        outputSemantic: "confirmed_issue",
        reviewerOnly: true,
        requiresHumanReview: true,
        automaticAccusationAuthorized: false,
        studentFacing: false,
        reason: "fixture",
      },
    }],
  };
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  await fs.mkdir(path.join(root, "candidates"));
  await fs.writeFile(path.join(root, "candidates", "candidate.json"), artifactBytes);
  const run = {
    batchRunId: "batch-1",
    items: [{
      submissionId: "submission-1",
      recordingId: "rec-1",
      dataset: "fixture",
      piece: "piece-1",
      scoreId: "score-1",
      audioHash,
      candidateRowsPath: "candidates/candidate.json",
      candidateRowsSha256: sha256(artifactBytes),
    }],
  };
  await fs.writeFile(path.join(root, "runs.jsonl"), `${JSON.stringify(run)}\n`);
  await fs.writeFile(path.join(root, "submissions.jsonl"), `${JSON.stringify({
    submissionId: "submission-1", recordingId: "rec-1", scoreId: "score-1", audioHash,
  })}\n`);

  const packResult = await writeReviewAssistCalibrationPack({
    repoRoot: root,
    outDir: "pack",
    runsPath: "runs.jsonl",
    submissionsPath: "submissions.jsonl",
    manifestPaths: ["private/manifest.csv"],
    frozenReportPath: "",
  });
  assert.equal(packResult.readyForReview, true);
  assert.equal(packResult.candidateCount, 1);
  assert.equal(packResult.playableCandidateCount, 1);
  const reviewPage = await fs.readFile(path.join(root, "pack", "index.html"), "utf8");
  assert(reviewPage.includes("data-mf=\"performerId\""));
  assert(reviewPage.includes("Object.fromEntries(recordingState)"));
  const browserScript = reviewPage.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert(browserScript);
  // Compile only: DOM access stays inside the returned function and is not executed.
  new Function(browserScript); // eslint-disable-line no-new-func
  const ledgerBytes = await fs.readFile(path.join(root, "pack", "ledger.json"));
  const ledger = JSON.parse(ledgerBytes);
  assert.equal(ledger.rows[0].calibrationOnly, true);
  assert.equal(ledger.rows[0].freshBlindEligible, false);
  assert.equal(ledger.rows[0].audioSourceSha256, audioHash);
  assert.equal(ledger.rows[0].scoreSourceSha256, sha256(scoreBytes));

  const completed = {
    contract: ledger.contract,
    ledgerSha256: sha256(ledgerBytes),
    calibrationOnly: true,
    freshBlindEligible: false,
    recordingMetadata: {
      "rec-1": {
        performerId: "performer-a",
        deviceId: "device-a",
        roomId: "room-a",
        consent: "yes",
        licenseStatus: "local-only",
      },
    },
    reviews: [{
      identityKey: ledger.rows[0].identityKey,
      label: "positive",
      gate: "merged_substitution",
      reviewedBy: "teacher-a",
      asPerformed: "played F# instead of A",
    }],
  };
  await fs.writeFile(path.join(root, "pack", "completed.json"), `${JSON.stringify(completed, null, 2)}\n`);
  const staged = await stageReviewAssistCalibration({
    repoRoot: root,
    packDir: "pack",
    completedPath: "pack/completed.json",
    outDir: "draft",
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.calibrationOnly, true);
  assert.equal(staged.freshBlindEligible, false);
  const truth = JSON.parse(await fs.readFile(path.join(root, "draft", "position-truth.json"), "utf8"));
  assert.equal(truth.recordings["rec-1"].events[0].gate, "merged_substitution");
  assert.equal(truth.recordings["rec-1"].events[0].label, "positive");

  completed.ledgerSha256 = "0".repeat(64);
  await fs.writeFile(path.join(root, "pack", "tampered.json"), `${JSON.stringify(completed)}\n`);
  const rejected = await stageReviewAssistCalibration({
    repoRoot: root,
    packDir: "pack",
    completedPath: "pack/tampered.json",
    outDir: "rejected",
  });
  assert.equal(rejected.ok, false);
  assert(rejected.blockingReasons.includes("review-pack-ledger-sha-mismatch"));
  await assert.rejects(fs.access(path.join(root, "rejected", "manifest.csv")));

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "physical-policy-c-row-exported",
      "source-sha-bound",
      "calibration-only-draft-staged",
      "fresh-blind-boundary-closed",
      "stale-ledger-rejected-before-write",
    ],
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
