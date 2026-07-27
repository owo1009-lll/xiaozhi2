import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { nowIso, safeNumber, safeString } from "./baseUtils.js";

// Training data ledger (docs/western-strings-training-ledger-spec.md).
//
// One teacher review with a signed complete error inventory becomes one
// (features, gold) sample for a FUTURE from-scratch training experiment.
//
// Discipline that must never be relaxed (spec section 5):
//   1. This module never imports a gate/switch module, never authorizes
//      anything, and never appears in any project-status ready/gate field.
//   2. The ledger is never used to tune the frozen Policy C / Round 5-6
//      candidates. That would be rolling-data parameter fitting.
//   3. performerId is recorded now so a future split can be cut by performer
//      rather than by recording, otherwise the split leaks.
//   4. Append only. A re-review never rewrites or deletes an earlier signature;
//      it is appended as a new immutable record chained to the previous one.
//   5. A label is only worth storing if it is provably attached to a real score
//      note of the exact analysis artifact the features come from. Every record
//      is therefore bound to the on-disk candidate-rows artifact and refused
//      when that artifact is missing, altered, or only partially reviewed.
export const TRAINING_LEDGER_CONTRACT = "western-strings-training-ledger-v1";

// Score-note anchored labels. `extra` is deliberately NOT here: an extra
// performed event has no corresponding score note, so forcing it onto one would
// record a false identity. Extras go to `extraEvents` with their own schema.
export const TRAINING_LEDGER_LABELS = Object.freeze([
  "correct",
  "wrong_pitch",
  "missing",
  "drag",
  "uncertain",
]);

// Labels that assert an actual performance error (used for corpus balance).
export const TRAINING_LEDGER_ERROR_LABELS = Object.freeze(["wrong_pitch", "missing", "drag"]);

const LABEL_SET = new Set(TRAINING_LEDGER_LABELS);
const NOTE_ID_PATTERN = /^xml-m-?\d+-n\d+$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function trainingLedgerDir(repoRoot = process.cwd()) {
  return path.join(repoRoot, "data", "private", "western-strings-training-ledger");
}

export function trainingLedgerFile(repoRoot, recordingId) {
  const safeId = safeString(recordingId).replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(trainingLedgerDir(repoRoot), `${safeId}.jsonl`);
}

// Stable key so "anon-01", "Anon-01 " and "ANON-01" cannot inflate the
// distinct-performer count that a training split depends on.
export function normalizePerformerKey(performerId) {
  return safeString(performerId).trim().toLowerCase().replace(/\s+/g, "-");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function recordSha256(record) {
  const { recordSha256: _ignored, ...rest } = record || {};
  return sha256Buffer(Buffer.from(canonicalJson(rest), "utf8"));
}

function pathIsInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readJsonlLines(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split(/\r?\n/).filter((line) => line.trim());
  } catch {
    return [];
  }
}

// Reads the immutable analysis artifact the labels must attach to, and proves
// it is byte-identical to what the reviewer actually looked at.
async function loadVerifiedCandidateArtifact(repoRoot, machineSnapshot, payload) {
  const relativePath = safeString(machineSnapshot?.candidateRowsPath).trim();
  if (!relativePath) {
    throw new Error("training ledger requires a machine analysis snapshot (candidateRowsPath missing).");
  }
  const artifactPath = path.resolve(repoRoot, relativePath);
  if (!pathIsInside(path.join(repoRoot, "data"), artifactPath)) {
    throw new Error("training ledger candidate artifact resolved outside the data directory.");
  }
  let bytes = null;
  try {
    bytes = await fs.readFile(artifactPath);
  } catch {
    throw new Error(`training ledger candidate artifact is missing on disk: ${relativePath}.`);
  }
  const observedSha256 = sha256Buffer(bytes);

  const recordedSha256 = safeString(machineSnapshot?.candidateRowsSha256).trim().toLowerCase();
  if (!SHA256_PATTERN.test(recordedSha256)) {
    throw new Error("training ledger requires a candidateRowsSha256 from the analysis run.");
  }
  if (observedSha256 !== recordedSha256) {
    throw new Error("training ledger candidate artifact changed on disk since the analysis run.");
  }
  // The reviewer's console must have loaded THIS artifact; otherwise the
  // signature covers a score the reviewer never saw.
  const reviewedSha256 = safeString(payload?.candidateRowsSha256).trim().toLowerCase();
  if (!reviewedSha256) {
    throw new Error("training ledger requires the reviewer to load the full score before signing.");
  }
  if (reviewedSha256 !== observedSha256) {
    throw new Error("training ledger reviewer loaded a different analysis artifact than the current one.");
  }

  const parsed = JSON.parse(bytes.toString("utf8"));
  const rows = Array.isArray(parsed?.candidateRows) ? parsed.candidateRows : [];
  if (!rows.length) {
    throw new Error("training ledger candidate artifact contains no score notes.");
  }
  const byNoteId = new Map();
  for (const row of rows) {
    const noteId = safeString(row?.noteId).trim();
    if (!noteId) continue;
    byNoteId.set(noteId, {
      noteId,
      noteIndex: Number.isInteger(row?.noteIndex) ? row.noteIndex : null,
      measure: Number.isInteger(row?.measureIndex) ? row.measureIndex : null,
      scoreMidi: Number.isInteger(row?.midi) ? row.midi : null,
    });
  }
  if (!byNoteId.size) {
    throw new Error("training ledger candidate artifact has no usable score note identities.");
  }
  return { artifactPath: relativePath.replace(/\\/g, "/"), sha256: observedSha256, byNoteId, noteCount: byNoteId.size };
}

// Every score note must have been swept, otherwise "unlabeled == correct"
// silently manufactures false negatives.
function assertFullScoreSweep(payload, artifact) {
  const claimed = Math.round(safeNumber(payload?.scoreNoteCount, -1));
  if (claimed < 0) {
    throw new Error("training ledger requires scoreNoteCount from the loaded full score.");
  }
  if (claimed !== artifact.noteCount) {
    throw new Error(
      `training ledger scoreNoteCount ${claimed} does not match the analysis artifact (${artifact.noteCount}).`,
    );
  }
  if (payload?.fullScoreReviewed !== true) {
    throw new Error("training ledger requires an explicit full-score sweep confirmation.");
  }
}

function normalizeNoteLabel(entry, artifact) {
  const noteId = safeString(entry?.noteId).trim();
  const label = safeString(entry?.label).trim().toLowerCase();
  if (!NOTE_ID_PATTERN.test(noteId)) {
    throw new Error(`training ledger noteLabels require a score noteId, received "${noteId}".`);
  }
  if (!LABEL_SET.has(label)) {
    throw new Error(`training ledger label must be one of ${TRAINING_LEDGER_LABELS.join(", ")}.`);
  }
  const known = artifact.byNoteId.get(noteId);
  if (!known) {
    throw new Error(`training ledger noteId ${noteId} is not a score note of this recording's analysis.`);
  }
  // Identity comes from the artifact, never from the client. A client value
  // that disagrees means the console and the analysis are out of sync.
  const claimedMeasure = entry?.measure;
  if (claimedMeasure !== null && claimedMeasure !== undefined && Number.isInteger(claimedMeasure)
    && known.measure !== null && claimedMeasure !== known.measure) {
    throw new Error(`training ledger measure for ${noteId} disagrees with the analysis artifact.`);
  }
  const claimedMidi = entry?.scoreMidi;
  if (claimedMidi !== null && claimedMidi !== undefined && Number.isInteger(claimedMidi)
    && known.scoreMidi !== null && claimedMidi !== known.scoreMidi) {
    throw new Error(`training ledger scoreMidi for ${noteId} disagrees with the analysis artifact.`);
  }
  return {
    noteId,
    noteIndex: known.noteIndex,
    measure: known.measure,
    beat: entry?.beat === null || entry?.beat === undefined ? null : safeNumber(entry.beat, 0),
    scoreMidi: known.scoreMidi,
    label,
    asPerformedNote: safeString(entry?.asPerformedNote),
  };
}

// An extra performed event has no score note of its own. It may optionally name
// the score note it was heard after, but its identity is the performed pitch
// and time window, not a score position.
function normalizeExtraEvent(entry, artifact) {
  const anchorNoteId = safeString(entry?.afterNoteId).trim();
  if (anchorNoteId && !artifact.byNoteId.has(anchorNoteId)) {
    throw new Error(`training ledger extra event anchor ${anchorNoteId} is not a score note of this recording.`);
  }
  const startSeconds = entry?.startSeconds === null || entry?.startSeconds === undefined
    ? null
    : safeNumber(entry.startSeconds, 0);
  const endSeconds = entry?.endSeconds === null || entry?.endSeconds === undefined
    ? null
    : safeNumber(entry.endSeconds, 0);
  if (startSeconds !== null && endSeconds !== null && endSeconds < startSeconds) {
    throw new Error("training ledger extra event ends before it starts.");
  }
  if (anchorNoteId === "" && startSeconds === null) {
    throw new Error("training ledger extra event needs either an anchor score note or a start time.");
  }
  return {
    kind: "extra",
    afterNoteId: anchorNoteId,
    performedMidi: Number.isInteger(entry?.performedMidi) ? entry.performedMidi : null,
    startSeconds,
    endSeconds,
    note: safeString(entry?.note),
  };
}

export async function buildTrainingLedgerRecord({
  repoRoot = process.cwd(),
  submission = {},
  review = {},
  payload = {},
  machineSnapshot = {},
} = {}) {
  const recordingId = safeString(submission.recordingId).trim() || safeString(submission.submissionId).trim();
  if (!recordingId) throw new Error("training ledger requires a recordingId or submissionId.");

  // Spec section 5.3: without a performer id a future split cannot be cut by
  // person, so the sample is refused rather than silently stored unusable.
  const performerId = safeString(payload.performerId).trim();
  if (!performerId) throw new Error("training ledger requires a performerId.");

  // Spec section 5.4: consent gates entry, same as the existing review flow.
  if (safeString(payload.consent).trim().toLowerCase() !== "yes") {
    throw new Error("training ledger requires consent=yes.");
  }
  if (payload.completeErrorInventory !== true) {
    throw new Error("training ledger requires a signed completeErrorInventory.");
  }

  const reviewedBy = safeString(review.reviewerId).trim();
  if (!reviewedBy) throw new Error("training ledger requires an identified reviewer.");

  const artifact = await loadVerifiedCandidateArtifact(repoRoot, machineSnapshot, payload);
  assertFullScoreSweep(payload, artifact);

  const noteLabels = (Array.isArray(payload.noteLabels) ? payload.noteLabels : [])
    .map((entry) => normalizeNoteLabel(entry, artifact));
  const seen = new Set();
  for (const entry of noteLabels) {
    if (seen.has(entry.noteId)) throw new Error(`training ledger noteLabels repeat ${entry.noteId}.`);
    seen.add(entry.noteId);
  }
  const extraEvents = (Array.isArray(payload.extraEvents) ? payload.extraEvents : [])
    .map((entry) => normalizeExtraEvent(entry, artifact));

  // Audio provenance is re-checked against the file on disk right now; the
  // score payload sha is the analysis-time value carried by the artifact's run,
  // because the shared score store legitimately changes after an analysis.
  const audioSha256 = safeString(submission.audioHash).trim().toLowerCase();
  if (!SHA256_PATTERN.test(audioSha256)) {
    throw new Error("training ledger requires the submission audio sha256.");
  }
  const audioPath = safeString(submission.audioPath || submission.audioSubmission?.storedPath);
  let audioVerified = false;
  if (audioPath) {
    const resolvedAudio = path.resolve(repoRoot, audioPath);
    try {
      const audioBytes = await fs.readFile(resolvedAudio);
      if (sha256Buffer(audioBytes) !== audioSha256) {
        throw new Error("training ledger audio file no longer matches the submitted audio sha256.");
      }
      audioVerified = true;
    } catch (error) {
      if (String(error?.message || "").includes("no longer matches")) throw error;
      audioVerified = false;
    }
  }

  const scorePayloadSha256 = safeString(machineSnapshot.scorePayloadSha256).trim().toLowerCase();
  if (!SHA256_PATTERN.test(scorePayloadSha256)) {
    throw new Error("training ledger requires the analysis-time scorePayloadSha256.");
  }

  return {
    ledgerContract: TRAINING_LEDGER_CONTRACT,
    recordingId,
    submissionId: safeString(submission.submissionId).trim(),
    scoreId: safeString(submission.scoreId).trim(),
    scorePayloadSha256,
    audioPath,
    audioSha256,
    performerId,
    performerKey: normalizePerformerKey(performerId),
    deviceHint: safeString(payload.deviceHint),
    levelHint: safeString(payload.levelHint),
    reviewedBy,
    reviewedAt: safeString(review.submittedAt, nowIso()),
    // Signed by the teacher after sweeping every score note, so any score note
    // absent from noteLabels counts as `correct`.
    completeErrorInventory: true,
    fullScoreReviewed: true,
    scoreNoteCount: artifact.noteCount,
    labeledNoteCount: noteLabels.length,
    implicitCorrectCount: artifact.noteCount - noteLabels.length,
    noteLabels,
    extraEvents,
    machineSnapshot: {
      candidateRowsPath: artifact.artifactPath,
      candidateRowsSha256: artifact.sha256,
      modelVersion: safeString(machineSnapshot.modelVersion),
      gateVersion: safeString(machineSnapshot.gateVersion),
      batchRunId: safeString(machineSnapshot.batchRunId),
    },
    verification: {
      candidateArtifactRehashed: true,
      reviewerSawSameArtifact: true,
      noteIdentitiesResolvedFromArtifact: true,
      audioRehashed: audioVerified,
      verifiedAt: nowIso(),
    },
    consent: "yes",
    licenseStatus: safeString(payload.licenseStatus, "local-only"),
  };
}

export async function appendTrainingLedgerRecord({
  repoRoot = process.cwd(),
  submission = {},
  review = {},
  payload = {},
  machineSnapshot = {},
} = {}) {
  const record = await buildTrainingLedgerRecord({ repoRoot, submission, review, payload, machineSnapshot });
  const outPath = trainingLedgerFile(repoRoot, record.recordingId);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // Append only: a re-review is a NEW immutable record chained to the previous
  // one. Earlier labels, signer and timestamp stay readable forever.
  const existing = await readJsonlLines(outPath);
  let previousRecordSha256 = "";
  if (existing.length) {
    try {
      previousRecordSha256 = safeString(JSON.parse(existing[existing.length - 1])?.recordSha256);
    } catch {
      throw new Error("training ledger tail record is unreadable; refusing to append onto a broken chain.");
    }
  }
  const chained = { ...record, revision: existing.length + 1, previousRecordSha256 };
  const stored = { ...chained, recordSha256: recordSha256(chained) };
  await fs.appendFile(outPath, `${JSON.stringify(stored)}\n`, "utf8");
  return {
    path: path.relative(repoRoot, outPath).replace(/\\/g, "/"),
    recordingId: stored.recordingId,
    revision: stored.revision,
    noteLabelCount: stored.noteLabels.length,
    extraEventCount: stored.extraEvents.length,
    scoreNoteCount: stored.scoreNoteCount,
    reviewedBy: stored.reviewedBy,
  };
}
