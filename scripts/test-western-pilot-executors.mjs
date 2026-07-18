#!/usr/bin/env node
// Tests for the two real pilot executors (v1): contract identity, a real
// review-only run in a temporary repo, filter fail-closed behavior, artifact
// tampering rejection, and the session-runner/preflight wiring that clears
// the executor-not-implemented blockers without opening anything else.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ORDINARY_PILOT_EXECUTOR_CONTRACT,
  ordinaryPilotExecutorReadiness,
  runDynamicShadowPilotSession,
} from "./western-ordinary-dynamic-shadow-pilot-executor.mjs";
import {
  M3PLUS_PILOT_EXECUTOR_CONTRACT,
  m3plusPilotExecutorReadiness,
  runM3PlusPitchSafetyPilotSession,
} from "./western-m3plus-pitch-safety-pilot-executor.mjs";
import {
  REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT,
  REQUIRED_PILOT_EXECUTOR_CONTRACT,
  buildControlledPilotStartPreflight,
} from "./run-western-controlled-pilot-start-preflight.mjs";

// ---- contract identity ------------------------------------------------------
assert.equal(ORDINARY_PILOT_EXECUTOR_CONTRACT, REQUIRED_PILOT_EXECUTOR_CONTRACT);
assert.equal(M3PLUS_PILOT_EXECUTOR_CONTRACT, REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT);
assert.notEqual(ORDINARY_PILOT_EXECUTOR_CONTRACT, M3PLUS_PILOT_EXECUTOR_CONTRACT);
assert.equal(runDynamicShadowPilotSession.contract, REQUIRED_PILOT_EXECUTOR_CONTRACT);
assert.equal(runM3PlusPitchSafetyPilotSession.contract, REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT);
assert.notEqual(runDynamicShadowPilotSession, runM3PlusPitchSafetyPilotSession);
const ordinaryReadiness = await ordinaryPilotExecutorReadiness({ probeRuntime: false });
assert.equal(ordinaryReadiness.ready, true);
assert.equal(ordinaryReadiness.contract, REQUIRED_PILOT_EXECUTOR_CONTRACT);
const m3plusReadiness = m3plusPilotExecutorReadiness();
assert.equal(m3plusReadiness.ready, true);
assert.equal(m3plusReadiness.contract, REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT);

// executor readiness alone must never make the preflight startable
const readyExecutorsOnlyPreflight = await buildControlledPilotStartPreflight({
  pilotExecutorContractReady: true,
  pilotExecutorContract: REQUIRED_PILOT_EXECUTOR_CONTRACT,
  m3plusPilotExecutorContractReady: true,
  m3plusPilotExecutorContract: REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT,
});
assert.equal(readyExecutorsOnlyPreflight.ordinaryPilotExecutorReady, true);
assert.equal(readyExecutorsOnlyPreflight.m3plusPilotExecutorReady, true);
assert(
  !readyExecutorsOnlyPreflight.blockingReasons.includes("ordinary-dynamic-shadow-pilot-executor-not-implemented")
  && !readyExecutorsOnlyPreflight.blockingReasons.includes("m3plus-pitch-safety-pilot-executor-not-implemented"),
  "implemented executors must clear the executor blockers",
);
assert.equal(
  readyExecutorsOnlyPreflight.okToStartControlledPilot,
  false,
  "executor readiness must not bypass the evidence and authorization chain",
);

// ---- temp-repo fixture ------------------------------------------------------
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

const RECORDING_ID = "pilot-exec-test-rec";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "western-pilot-executors-test-"));
try {
  const m2Root = path.join(tempRoot, "data", "experiments", "western-strings-m2");
  const m3Root = path.join(tempRoot, "data", "experiments", "western-strings-m3");
  fs.mkdirSync(m2Root, { recursive: true });
  fs.mkdirSync(m3Root, { recursive: true });
  const writeJson = (filePath, value) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  writeJson(path.join(m2Root, "m2d-sequence-support-summary.json"), { ok: true, studentGateReady: true });
  writeJson(path.join(m2Root, "m2f-real-student-recording-summary.json"), { ok: true, studentGateReady: true });
  writeJson(path.join(m3Root, "m3-diagnosis-summary.json"), {
    ok: true,
    diagnosisGateReady: true,
    gate: { requiredCategories: ["pitch", "onset", "missing"], reviewOnlyCategories: ["duration", "extra"] },
  });
  writeJson(path.join(tempRoot, "data", "erhu-score-imports.json"), {
    jobs: [],
    scores: [{
      scoreId: "score-pilot-exec-test",
      title: "Pilot executor test score",
      scoreSource: "musicxml",
      sections: [{
        sectionId: "section-1",
        title: "Section 1",
        tempo: 72,
        notes: [
          { noteId: "n1", measureIndex: 1, beatStart: 0, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
          { noteId: "n2", measureIndex: 1, beatStart: 1, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
          { noteId: "n3", measureIndex: 1, beatStart: 2, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
        ],
      }],
    }],
  });
  // the M3+ runtime bindings resolve the rescope report against repoRoot;
  // mirror the real frozen report into the fixture
  const rescopeRelative = path.join("data", "experiments", "western-strings-m3plus", "rescope-gate", "report.json");
  fs.mkdirSync(path.join(tempRoot, path.dirname(rescopeRelative)), { recursive: true });
  fs.copyFileSync(path.resolve(rescopeRelative), path.join(tempRoot, rescopeRelative));
  const audioPath = path.join(tempRoot, "student.wav");
  fs.writeFileSync(audioPath, sineWavBuffer());
  fs.writeFileSync(
    path.join(m3Root, "controlled-submissions.jsonl"),
    `${JSON.stringify({
      submissionId: "pilot-exec-test-1",
      submittedAt: new Date().toISOString(),
      scoreId: "score-pilot-exec-test",
      recordingId: RECORDING_ID,
      audioPath,
      instrument: "violin",
      limit: 3,
      status: "review_required",
    })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(m3Root, "controlled-submission-reviews.jsonl"),
    `${JSON.stringify({ submissionId: "pilot-exec-test-1", action: "accepted_for_batch" })}\n`,
    "utf8",
  );

  // exclusion and unmatched-include fail closed before any execution
  const excluded = await runDynamicShadowPilotSession({
    repoRoot: tempRoot,
    batchLimit: 1,
    excludeRecordingIds: [RECORDING_ID],
  });
  assert.equal(excluded.summary.ok, false);
  assert(excluded.summary.blockingReasons.includes("ordinary-pilot-no-eligible-submission"));
  const unmatchedInclude = await runDynamicShadowPilotSession({
    repoRoot: tempRoot,
    batchLimit: 1,
    includeRecordingIds: ["some-other-recording"],
  });
  assert.equal(unmatchedInclude.summary.ok, false);

  // real review-only run
  const run = await runDynamicShadowPilotSession({
    repoRoot: tempRoot,
    batchLimit: 1,
    outDir: path.join(tempRoot, "session", "targeted-review"),
    selectionJson: path.join(tempRoot, "session", "candidate-selection.json"),
    summary: path.join(tempRoot, "session", "precision-summary.json"),
    includeRecordingIds: [RECORDING_ID],
  });
  assert.deepEqual(run.summary.blockingReasons, [], `ordinary executor must pass: ${run.summary.blockingReasons}`);
  assert.equal(run.summary.ok, true);
  assert.equal(run.summary.selectedSubmissionCount, 1);
  assert.equal(run.summary.selectedSubmissions[0].recordingId, RECORDING_ID);
  assert.equal(run.summary.totalCandidateCount, 3);
  assert.equal(run.summary.modelAutoPassCandidateCount, 0, "the v1 shadow must never report model auto-pass");
  assert.equal(run.summary.autoPassCandidateCount, 0);
  assert.equal(run.summary.selfCheckedAutoPassCandidateCount, 0);
  assert.equal(run.summary.knownWrongAutoPassCandidateCount, 0);
  assert.equal(run.summary.unknownReviewCandidateCount, 0);
  assert.equal(run.summary.studentFacing, false);
  assert.equal(run.summary.feedbackAuthorized, false);
  assert(Number.isInteger(run.summary.shadowSelectedCandidateCount));
  assert(fs.existsSync(path.join(tempRoot, "session", "candidate-selection.json")));
  assert(fs.existsSync(path.join(tempRoot, "session", "precision-summary.json")));

  // M3+ executor audits the same latest batch
  const m3plusRun = await runM3PlusPitchSafetyPilotSession({
    repoRoot: tempRoot,
    batchLimit: 1,
    outDir: path.join(tempRoot, "session", "m3plus-review"),
    includeRecordingIds: [RECORDING_ID],
  });
  assert.deepEqual(m3plusRun.blockers, [], `m3plus executor must pass: ${m3plusRun.blockers}`);
  assert.equal(m3plusRun.ok, true);
  assert.equal(m3plusRun.contract, REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT);
  assert.equal(m3plusRun.reviewOnly, true);
  assert.equal(m3plusRun.feedbackAuthorized, false);
  assert.equal(m3plusRun.studentFacing, false);
  assert.equal(m3plusRun.rowCount, 3);
  const decisionSum = Object.values(m3plusRun.decisionCounts).reduce((left, right) => left + right, 0);
  assert.equal(decisionSum, 3, "every row must carry exactly one valid decision");
  assert(fs.existsSync(path.join(tempRoot, "session", "m3plus-review", "m3plus-pilot-review.json")));

  // excluded recording inside the latest batch fails the M3+ audit
  const m3plusExcluded = await runM3PlusPitchSafetyPilotSession({
    repoRoot: tempRoot,
    batchLimit: 1,
    excludeRecordingIds: [RECORDING_ID],
  });
  assert.equal(m3plusExcluded.ok, false);

  // artifact tampering fails closed: flip a row to auto_pass in the latest
  // batch candidate artifact and re-audit
  const batchRuns = fs.readFileSync(path.join(m3Root, "controlled-submission-batch-runs.jsonl"), "utf8")
    .split(/\r?\n/).filter((line) => line.trim());
  const latest = JSON.parse(batchRuns[batchRuns.length - 1]);
  const artifactPath = path.resolve(tempRoot, latest.items[0].candidateRowsPath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  artifact.candidateRows[0].autoDecision = "auto_pass";
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`, "utf8");
  const tampered = await runM3PlusPitchSafetyPilotSession({ repoRoot: tempRoot, batchLimit: 1 });
  assert.equal(tampered.ok, false);
  assert(
    tampered.blockers.some((reason) => reason.startsWith("m3plus-pilot-row-not-review-only")),
    `tampered auto-pass row must fail closed: ${tampered.blockers}`,
  );

  console.log("ok - western pilot executors (contracts, review-only run, fail-closed filters, tamper rejection)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
