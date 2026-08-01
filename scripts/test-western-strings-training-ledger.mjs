import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TRAINING_LEDGER_CONTRACT,
  TRAINING_LEDGER_LABELS,
  appendTrainingLedgerRecord,
  buildTrainingLedgerRecord,
  normalizePerformerKey,
  recordSha256,
  trainingLedgerFile,
} from "../src/server/westernStringsTrainingLedger.js";

// ---------------------------------------------------------------------------
// Discipline (spec section 5.1): the ledger must never be able to open a gate.
// ---------------------------------------------------------------------------
const ledgerSource = fs.readFileSync("src/server/westernStringsTrainingLedger.js", "utf8");
assert(!ledgerSource.includes("westernStudentGateService"), "training ledger must not import the student gate service");
assert(!ledgerSource.includes("WESTERN_STUDENT_RUNTIME_GATE"), "training ledger must not reference the student runtime gate");
assert(!/ready\s*[:=]\s*true/.test(ledgerSource), "training ledger must not publish a ready flag");
assert(!ledgerSource.includes("automaticAdoption"), "training ledger must not touch automatic adoption");

const statusSource = fs.readFileSync("scripts/status-western-strings-training-ledger.mjs", "utf8");
assert(statusSource.includes("studentFacing: false"), "ledger status must state it is not student facing");
assert(statusSource.includes("automaticAuthorizationGranted: false"), "ledger status must grant no authorization");
assert(statusSource.includes("usableForFrozenCandidateTuning: false"), "ledger status must forbid tuning frozen candidates");

const projectStatusSource = fs.readFileSync("scripts/status-western-strings-project.mjs", "utf8");
assert(
  !projectStatusSource.includes("trainingLedger") && !projectStatusSource.includes("training-ledger"),
  "project status must not consume the training ledger",
);

// `extra` cannot be a score-note label: an extra performed event has no score note.
assert(!TRAINING_LEDGER_LABELS.includes("extra"), "extra must not be a score-note anchored label");
assert(TRAINING_LEDGER_LABELS.includes("correct"), "correct must remain available to reject a machine flag");
assert.equal(normalizePerformerKey("  Anon-01 "), "anon-01", "performer keys must normalize");

// ---------------------------------------------------------------------------
// Fixture: a real on-disk analysis artifact plus audio, like a real submission.
// ---------------------------------------------------------------------------
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "training-ledger-test-"));
const artifactRelative = "data/experiments/western-strings-m3/offline-feature-candidates/batch-test/submit-test.json";
const audioRelative = "data/private/test/r-test-0001.m4a";

async function writeFixture(rows) {
  const artifactPath = path.join(tempRoot, artifactRelative);
  await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify({ candidateRows: rows }, null, 2)}\n`, "utf8");
  await fsp.writeFile(artifactPath, bytes);
  const audioPath = path.join(tempRoot, audioRelative);
  await fsp.mkdir(path.dirname(audioPath), { recursive: true });
  const audioBytes = Buffer.from("fake-audio-bytes");
  await fsp.writeFile(audioPath, audioBytes);
  return {
    artifactSha: crypto.createHash("sha256").update(bytes).digest("hex"),
    audioSha: crypto.createHash("sha256").update(audioBytes).digest("hex"),
    audioLegacySha1: crypto.createHash("sha1").update(audioBytes).digest("hex"),
  };
}

const rows = [
  { noteId: "xml-m5-n1", noteIndex: 0, measureIndex: 5, midi: 66 },
  { noteId: "xml-m7-n2", noteIndex: 1, measureIndex: 7, midi: 69 },
  { noteId: "xml-m9-n3", noteIndex: 2, measureIndex: 9, midi: 71 },
];
const { artifactSha, audioSha, audioLegacySha1 } = await writeFixture(rows);

const submission = {
  submissionId: "strings-submit-test-0001",
  recordingId: "r-test-0001",
  scoreId: "score-test-0001",
  audioPath: audioRelative,
  audioHash: audioSha,
};
const review = { reviewerId: "guanxingzhi", submittedAt: "2026-07-28T01:00:00.000Z" };
const machineSnapshot = {
  batchRunId: "batch-test",
  candidateRowsPath: artifactRelative,
  candidateRowsSha256: artifactSha,
  scorePayloadSha256: "c".repeat(64),
  gateVersion: "western-ordinary-dynamic-shadow-gate-v1-review-only",
  modelVersion: "basic-pitch-0.4.0-default-model",
};
const signedPayload = {
  completeErrorInventory: true,
  fullScoreReviewed: true,
  candidateRowsSha256: artifactSha,
  scoreNoteCount: 3,
  performerId: "anon-01",
  consent: "yes",
  noteLabels: [{ noteId: "xml-m5-n1", label: "wrong_pitch" }],
  extraEvents: [{ afterNoteId: "xml-m7-n2", performedMidi: 70, startSeconds: 12.5, endSeconds: 12.9 }],
};

// Training consent now comes from the subject's own grant, so the fixture has
// to record one. A payload consent string is deliberately no longer enough.
const { appendTrainingConsent } = await import("../src/server/westernStringsTrainingConsent.js");
await appendTrainingConsent({
  repoRoot: tempRoot,
  payload: { subjectRef: "anon-01", subjectType: "adult", decision: "granted", capturedVia: "test-fixture" },
});

const base = { repoRoot: tempRoot, submission, review, machineSnapshot };

try {
  // -------------------------------------------------------------------------
  // Gold is resolved from the artifact, never trusted from the client.
  // -------------------------------------------------------------------------
  const record = await buildTrainingLedgerRecord({ ...base, payload: signedPayload });
  assert.equal(record.ledgerContract, TRAINING_LEDGER_CONTRACT);
  assert.equal(record.scoreNoteCount, 3);
  assert.equal(record.labeledNoteCount, 1);
  assert.equal(record.implicitCorrectCount, 2, "unlabeled score notes must be counted as implicit correct");
  assert.equal(record.noteLabels[0].measure, 5, "measure must come from the artifact");
  assert.equal(record.noteLabels[0].scoreMidi, 66, "midi must come from the artifact");
  assert.equal(record.noteLabels[0].noteIndex, 0, "note index must come from the artifact");
  assert.equal(record.extraEvents[0].kind, "extra");
  assert.equal(record.extraEvents[0].performedMidi, 70);
  assert.equal(record.verification.audioRehashed, true, "audio must be re-hashed from disk");
  assert.equal(record.verification.submissionAudioHashAlgorithm, "sha256");
  assert.equal(record.verification.submissionAudioHashVerified, true);
  assert.equal(record.verification.candidateArtifactRehashed, true);
  assert.equal(record.performerKey, "anon-01");

  // The live upload path still identifies cached audio with SHA-1. The ledger
  // must verify that identity, then derive and store its own SHA-256.
  const uploadedRecord = await buildTrainingLedgerRecord({
    ...base,
    submission: { ...submission, audioHash: audioLegacySha1 },
    payload: signedPayload,
  });
  assert.equal(uploadedRecord.audioSha256, audioSha);
  assert.equal(uploadedRecord.verification.submissionAudioHashAlgorithm, "sha1");
  assert.equal(uploadedRecord.verification.submissionAudioHashVerified, true);

  async function rejects(payload, expected, message, overrides = {}) {
    await assert.rejects(
      () => buildTrainingLedgerRecord({ ...base, ...overrides, payload }),
      (error) => String(error?.message || "").includes(expected),
      message,
    );
  }

  // Identity / consent / signature
  await rejects({ ...signedPayload, performerId: "" }, "performerId", "performerId must be required");
  await rejects(
    { ...signedPayload, performerId: "another-subject" },
    "conflicts with the submission student identity",
    "a teacher-supplied performer must not override the authenticated submission subject",
    { submission: { ...submission, studentRef: "anon-01" } },
  );
  const boundSubjectRecord = await buildTrainingLedgerRecord({
    ...base,
    submission: { ...submission, studentRef: "anon-01" },
    payload: { ...signedPayload, performerId: "" },
  });
  assert.equal(boundSubjectRecord.performerId, "anon-01", "submission identity must supply the performer split key");
  // Consent is no longer something the review payload can assert. A subject
  // with no recorded grant must be refused however the payload is filled in.
  await rejects(
    { ...signedPayload, performerId: "anon-no-consent", consent: "yes" },
    "requires a granted training consent",
    "a subject without a recorded grant must be refused even when the payload claims consent",
  );
  await rejects({ ...signedPayload, completeErrorInventory: false }, "completeErrorInventory", "unsigned inventory refused");
  await rejects(
    signedPayload,
    "identified reviewer",
    "an anonymous reviewer must be refused",
    { review: { reviewerId: "", submittedAt: review.submittedAt } },
  );

  // Premature signing
  await rejects({ ...signedPayload, fullScoreReviewed: false }, "full-score sweep", "sweep confirmation required");
  await rejects({ ...signedPayload, scoreNoteCount: undefined }, "scoreNoteCount", "score note count required");
  await rejects({ ...signedPayload, scoreNoteCount: 2 }, "does not match", "score note count must match the artifact");
  await rejects({ ...signedPayload, candidateRowsSha256: "" }, "load the full score", "reviewer must load the score");
  await rejects({ ...signedPayload, candidateRowsSha256: "d".repeat(64) }, "different analysis artifact", "reviewer sha must match");

  // Gold binding
  await rejects(
    { ...signedPayload, noteLabels: [{ noteId: "xml-m99-n9", label: "wrong_pitch" }] },
    "is not a score note",
    "unknown note ids must be refused",
  );
  await rejects(
    { ...signedPayload, noteLabels: [{ noteId: "not-a-note", label: "wrong_pitch" }] },
    "noteId",
    "malformed note ids must be refused",
  );
  await rejects(
    { ...signedPayload, noteLabels: [{ noteId: "xml-m5-n1", label: "extra" }] },
    "label must be one of",
    "extra must not be usable as a score-note label",
  );
  await rejects(
    { ...signedPayload, noteLabels: [{ noteId: "xml-m5-n1", label: "wrong_pitch", measure: 99 }] },
    "disagrees with the analysis artifact",
    "client measure conflicting with the artifact must be refused",
  );
  await rejects(
    { ...signedPayload, noteLabels: [{ noteId: "xml-m5-n1", label: "wrong_pitch", scoreMidi: 1 }] },
    "disagrees with the analysis artifact",
    "client midi conflicting with the artifact must be refused",
  );
  await rejects(
    {
      ...signedPayload,
      noteLabels: [{ noteId: "xml-m5-n1", label: "wrong_pitch" }, { noteId: "xml-m5-n1", label: "drag" }],
    },
    "repeat",
    "duplicate note ids must be refused",
  );

  // Analysis snapshot must exist and still match
  await rejects(signedPayload, "candidateRowsPath missing", "a missing snapshot must be refused", {
    machineSnapshot: { ...machineSnapshot, candidateRowsPath: "" },
  });
  await rejects(signedPayload, "missing on disk", "a missing artifact must be refused", {
    machineSnapshot: { ...machineSnapshot, candidateRowsPath: "data/experiments/gone.json" },
  });
  await rejects(signedPayload, "changed on disk", "an altered artifact must be refused", {
    machineSnapshot: { ...machineSnapshot, candidateRowsSha256: "e".repeat(64) },
  });
  await rejects(signedPayload, "scorePayloadSha256", "the analysis-time score sha is required", {
    machineSnapshot: { ...machineSnapshot, scorePayloadSha256: "" },
  });
  await rejects(signedPayload, "submission audio hash", "the audio hash is required", {
    submission: { ...submission, audioHash: "" },
  });
  await rejects(signedPayload, "missing on disk", "a missing audio file must be refused", {
    submission: {
      ...submission,
      audioPath: "data/private/test/missing.m4a",
      audioHash: "a".repeat(64),
    },
  });
  const outsideAudio = path.join(tempRoot, "outside-data.m4a");
  const outsideAudioBytes = Buffer.from("outside-audio");
  await fsp.writeFile(outsideAudio, outsideAudioBytes);
  await rejects(signedPayload, "outside the data directory", "an outside audio path must be refused", {
    submission: {
      ...submission,
      audioPath: outsideAudio,
      audioHash: crypto.createHash("sha256").update(outsideAudioBytes).digest("hex"),
    },
  });
  await rejects(signedPayload, "no longer matches", "an altered audio identity must be refused", {
    submission: { ...submission, audioHash: "a".repeat(64) },
  });

  // Extra events carry their own identity
  await rejects(
    { ...signedPayload, extraEvents: [{ afterNoteId: "xml-m99-n9", startSeconds: 1 }] },
    "anchor",
    "extra anchors must be real score notes",
  );
  await rejects(
    { ...signedPayload, extraEvents: [{ afterNoteId: "xml-m5-n1", startSeconds: 5, endSeconds: 1 }] },
    "ends before it starts",
    "reversed extra windows must be refused",
  );
  await rejects(
    { ...signedPayload, extraEvents: [{ performedMidi: 70 }] },
    "needs either an anchor",
    "an unlocatable extra event must be refused",
  );
  await rejects(
    { ...signedPayload, extraEvents: [{ afterNoteId: "xml-m5-n1", startSeconds: -1 }] },
    "finite and non-negative",
    "negative extra-event times must be refused",
  );
  await rejects(
    { ...signedPayload, extraEvents: [{ afterNoteId: "xml-m5-n1", performedMidi: 128 }] },
    "0 to 127",
    "out-of-range extra-event MIDI must be refused",
  );

  // -------------------------------------------------------------------------
  // Append-only history with a hash chain (spec section 0: 只追加)
  // -------------------------------------------------------------------------
  const first = await appendTrainingLedgerRecord({ ...base, payload: signedPayload });
  assert.equal(first.revision, 1);

  const second = await appendTrainingLedgerRecord({
    ...base,
    review: { reviewerId: "reviewer-2", submittedAt: "2026-07-28T02:00:00.000Z" },
    payload: { ...signedPayload, noteLabels: [{ noteId: "xml-m7-n2", label: "drag" }] },
  });
  assert.equal(second.revision, 2);

  const ledgerPath = trainingLedgerFile(tempRoot, "r-test-0001");
  assert(ledgerPath.endsWith(".jsonl"), "the ledger must be append-only JSONL");
  const lines = (await fsp.readFile(ledgerPath, "utf8")).split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 2, "a re-review must append, never overwrite");

  const [older, newer] = lines.map((line) => JSON.parse(line));
  assert.equal(older.reviewedBy, "guanxingzhi", "the earlier signer must survive");
  assert.equal(older.reviewedAt, "2026-07-28T01:00:00.000Z", "the earlier timestamp must survive");
  assert.equal(older.noteLabels[0].label, "wrong_pitch", "the earlier labels must survive");
  assert.equal(newer.reviewedBy, "reviewer-2");
  assert.equal(newer.previousRecordSha256, older.recordSha256, "records must be chained");
  assert.equal(recordSha256(older), older.recordSha256, "each record must carry a verifiable self hash");
  assert.equal(recordSha256(newer), newer.recordSha256);

  newer.submissionId = "strings-submit-spliced";
  newer.recordSha256 = recordSha256(newer);
  await fsp.writeFile(ledgerPath, `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`, "utf8");
  await assert.rejects(
    () => appendTrainingLedgerRecord({ ...base, payload: signedPayload }),
    /submissionId changed/,
    "a self-consistent hash chain must still reject an identity splice",
  );

  const concurrentSubmission = {
    ...submission,
    submissionId: "strings-submit-concurrent",
    recordingId: "r-concurrent",
  };
  const concurrentWrites = await Promise.all(
    Array.from({ length: 8 }, (_, index) => appendTrainingLedgerRecord({
      ...base,
      submission: concurrentSubmission,
      review: { reviewerId: `reviewer-${index}`, submittedAt: `2026-07-28T03:00:0${index}.000Z` },
      payload: signedPayload,
    })),
  );
  assert.deepEqual(
    concurrentWrites.map((entry) => entry.revision).sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "concurrent reviews must serialize into unique revisions",
  );
  const concurrentPath = trainingLedgerFile(tempRoot, "r-concurrent");
  const concurrentRecords = (await fsp.readFile(concurrentPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let previousSha = "";
  for (const [index, entry] of concurrentRecords.entries()) {
    assert.equal(entry.revision, index + 1);
    assert.equal(entry.previousRecordSha256, previousSha);
    assert.equal(recordSha256(entry), entry.recordSha256);
    previousSha = entry.recordSha256;
  }

  concurrentRecords[0].reviewedBy = "tampered";
  await fsp.writeFile(
    concurrentPath,
    `${concurrentRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  await assert.rejects(
    () => appendTrainingLedgerRecord({
      ...base,
      submission: concurrentSubmission,
      review: { reviewerId: "reviewer-9", submittedAt: "2026-07-28T03:00:09.000Z" },
      payload: signedPayload,
    }),
    /breaks the hash chain/,
    "append must refuse a damaged earlier record, not only a damaged tail",
  );

  assert(
    trainingLedgerFile(tempRoot, "x").replace(/\\/g, "/").includes("data/private/western-strings-training-ledger"),
    "ledger must be written under data/private",
  );
  assert.throws(
    () => trainingLedgerFile(tempRoot, "x/y"),
    /recordingId/,
    "recording ids that would collide after filename sanitization must be refused",
  );
  assert.throws(
    () => trainingLedgerFile(tempRoot, "x."),
    /recordingId/,
    "recording ids with Windows-normalized trailing punctuation must be refused",
  );
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Status script must be a quality gate, not a counter.
// ---------------------------------------------------------------------------
for (const needle of [
  "record-hash-mismatch",
  "chain-broken",
  "analysis-artifact-changed",
  "analysis-artifact-missing-on-disk",
  "analysis-artifact-outside-data",
  "audio-artifact-missing-on-disk",
  "audio-artifact-changed",
  "audio-path-outside-data",
  "audio-provenance-unverified",
  "consent-missing",
  "full-score-sweep-not-confirmed",
  "label-out-of-vocabulary",
  "implicitCorrect",
  "suspiciousPerformerPairs",
  "doubleReview",
  "raw-percent-agreement-not-kappa",
]) {
  assert(statusSource.includes(needle), `ledger status must verify/report ${needle}`);
}
assert(
  statusSource.includes("Object.values(milestones).every"),
  "every milestone, including data quality, must gate the readiness flag",
);

// ---------------------------------------------------------------------------
// Wiring: the review flow must stay unblocked when the ledger refuses a sample.
// ---------------------------------------------------------------------------
const serviceSource = fs.readFileSync("src/server/westernStringsAlignmentService.js", "utf8");
assert(serviceSource.includes("appendTrainingLedgerSample"), "the review write path should append a training ledger sample");
assert(
  /catch \(error\) \{\s*return \{ recorded: false, reason: safeString\(error\?\.message \|\| error\) \};/.test(serviceSource),
  "a ledger failure must be reported as data, never thrown into the review flow",
);
assert(
  serviceSource.includes('if (payload?.completeErrorInventory !== true) {'),
  "an unsigned review must skip the ledger entirely",
);
assert(serviceSource.includes("candidateRowsSha256:"), "the score-note endpoint must expose the artifact sha");

const routesSource = fs.readFileSync("src/server/westernStringsRoutes.js", "utf8");
assert(
  routesSource.includes("/api/strings/controlled-submissions/:submissionId/score-notes"),
  "the console needs a reviewer-only full score-note endpoint",
);
const guardSource = fs.readFileSync("src/server/publicAccessGuard.js", "utf8");
assert(!guardSource.includes("score-notes"), "the score-note endpoint must stay off the public allowlist");

const consoleSource = fs.readFileSync("src/WesternStringsApp.jsx", "utf8");
assert(consoleSource.includes("TrainingLabelPanel"), "the review console should expose the training label panel");
assert(consoleSource.includes("fullScoreReviewed: true"), "the console must send the sweep confirmation");
assert(consoleSource.includes("disabled={!canSign}"), "signing must be blocked until the full score is loaded");
assert(consoleSource.includes("scoreNoteCount: meta.noteCount"), "the console must send the loaded score note count");
assert(consoleSource.includes("onAddExtraEvent"), "the console must be able to record extra performed events");
assert(consoleSource.includes("reviewerId"), "the console must identify the reviewer for inter-rater tracking");

console.log(JSON.stringify({
  ok: true,
  contract: TRAINING_LEDGER_CONTRACT,
  checks: "discipline, gold-binding, sweep-enforcement, extra-events, append-only-chain, quality-gate, wiring",
}, null, 2));
