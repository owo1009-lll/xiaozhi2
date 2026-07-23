import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { auditRound5ReviewAssistCalibrationPack } from "./status-western-strings-project.mjs";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const testRoot = path.join(
  "data",
  "experiments",
  `.western-review-assist-status-test-${process.pid}-${crypto.randomUUID()}`,
);
const packDir = path.join(testRoot, "pack");
const ledgerPath = path.join(packDir, "ledger.json");
const reviewPagePath = path.join(packDir, "index.html");
const completedPath = path.join(packDir, "round5-review-assist-calibration.completed.json");
try {
  await fs.mkdir(path.join(packDir, "audio"), { recursive: true });
  const candidatePath = path.join(testRoot, "candidate.json");
  const audioPath = path.join(testRoot, "audio.m4a");
  const scorePath = path.join(testRoot, "score.musicxml");
  const frozenPath = path.join(testRoot, "frozen-report.json");
  const candidateBytes = Buffer.from('{"candidateRows":[]}\n');
  const audioBytes = Buffer.from("test-audio\n");
  const scoreBytes = Buffer.from("<score-partwise/>\n");
  const frozenBytes = Buffer.from('{"policyCReviewAssist":{"reviewAssistGateReady":true}}\n');
  await Promise.all([
    fs.writeFile(candidatePath, candidateBytes),
    fs.writeFile(audioPath, audioBytes),
    fs.writeFile(scorePath, scoreBytes),
    fs.writeFile(frozenPath, frozenBytes),
    fs.writeFile(path.join(packDir, "audio", "test.m4a"), audioBytes),
  ]);
  const ledger = {
    schemaVersion: 1,
    contract: "western-round5-review-assist-calibration-pack-v1",
    scope: "teacher-reviewed-calibration-draft-only",
    calibrationOnly: true,
    freshBlindEligible: false,
    frozenSource: {
      path: frozenPath.replace(/\\/g, "/"),
      sha256: sha256(frozenBytes),
      policyCReviewAssistGateReady: true,
    },
    sourceSummary: {
      candidateCount: 1,
      sourceWarningCount: 0,
    },
    sourceWarnings: [],
    rejectedArtifacts: [],
    rows: [{
      identityKey: "audio::score::0",
      recordingId: "test-recording",
      candidateRowsPath: candidatePath.replace(/\\/g, "/"),
      candidateRowsSha256: sha256(candidateBytes),
      audioSourcePath: audioPath.replace(/\\/g, "/"),
      audioSourceSha256: sha256(audioBytes),
      audioHash: sha256(audioBytes),
      scoreSourcePath: scorePath.replace(/\\/g, "/"),
      scoreSourceSha256: sha256(scoreBytes),
      localAudioPath: "audio/test.m4a",
      sourceSemantic: "confirmed_issue",
      calibrationOnly: true,
      freshBlindEligible: false,
    }],
  };
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  const ledgerSha256 = sha256(ledgerBytes);
  await fs.writeFile(ledgerPath, ledgerBytes);
  await fs.writeFile(
    reviewPagePath,
    `<html><body>Round 5 calibration 复核包 下载已完成 JSON ${ledgerSha256}</body></html>`,
  );

  const ready = await auditRound5ReviewAssistCalibrationPack({
    ledgerPath,
    reviewPagePath,
    completedPath,
  });
  assert.equal(ready.sourceCurrent, true);
  assert.equal(ready.safetyBoundaryValid, true);
  assert.equal(ready.candidateAvailable, true);
  assert.equal(ready.readyForReview, true);
  assert.equal(ready.readyForStaging, false);
  assert.equal(ready.counts.candidates, 1);
  assert.equal(ready.counts.playableCandidates, 1);
  assert.equal(ready.calibrationOnly, true);
  assert.equal(ready.freshBlindEligible, false);
  assert.equal(ready.studentFacing, false);
  assert.equal(ready.strictConfirmedRecallChanged, false);
  assert.deepEqual(ready.blockingReasons, []);
  assert.deepEqual(
    ready.reviewCompletionBlockingReasons,
    ["round5-review-assist-human-review-pending"],
  );

  await fs.writeFile(candidatePath, '{"candidateRows":[{"tampered":true}]}\n');
  const stale = await auditRound5ReviewAssistCalibrationPack({
    ledgerPath,
    reviewPagePath,
    completedPath,
  });
  assert.equal(stale.sourceCurrent, false);
  assert.equal(stale.candidateAvailable, false);
  assert.equal(stale.readyForReview, false);
  assert(stale.blockingReasons.includes("round5-review-assist-row-source-stale:0"));
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}

console.log("western review-assist project-status tests passed");
