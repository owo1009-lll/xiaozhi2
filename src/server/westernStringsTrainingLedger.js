import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { nowIso, safeNumber, safeString } from "./baseUtils.js";
import { resolveTrainingConsent } from "./westernStringsTrainingConsent.js";

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
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECORDING_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const CHAIN_IDENTITY_FIELDS = ["recordingId", "submissionId", "audioSha256", "scorePayloadSha256"];
const ledgerAppendQueues = new Map();

export function trainingLedgerDir(repoRoot = process.cwd()) {
  return path.join(repoRoot, "data", "private", "western-strings-training-ledger");
}

export function trainingLedgerFile(repoRoot, recordingId) {
  const safeId = safeString(recordingId).trim();
  if (!RECORDING_ID_PATTERN.test(safeId)) {
    throw new Error(
      "training ledger recordingId must start and end with a letter or digit and contain only letters, digits, dot, underscore, or hyphen.",
    );
  }
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

function sha1Buffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
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
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
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
    const [realDataRoot, realArtifactPath] = await Promise.all([
      fs.realpath(path.join(repoRoot, "data")),
      fs.realpath(artifactPath),
    ]);
    if (!pathIsInside(realDataRoot, realArtifactPath)) {
      throw new Error("training ledger candidate artifact resolved outside the data directory.");
    }
    bytes = await fs.readFile(realArtifactPath);
  } catch (error) {
    if (String(error?.message || "").includes("outside the data directory")) throw error;
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
    : Number(entry.startSeconds);
  const endSeconds = entry?.endSeconds === null || entry?.endSeconds === undefined
    ? null
    : Number(entry.endSeconds);
  if ((startSeconds !== null && (!Number.isFinite(startSeconds) || startSeconds < 0))
    || (endSeconds !== null && (!Number.isFinite(endSeconds) || endSeconds < 0))) {
    throw new Error("training ledger extra event times must be finite and non-negative.");
  }
  if (startSeconds !== null && endSeconds !== null && endSeconds < startSeconds) {
    throw new Error("training ledger extra event ends before it starts.");
  }
  if (anchorNoteId === "" && startSeconds === null) {
    throw new Error("training ledger extra event needs either an anchor score note or a start time.");
  }
  const performedMidi = entry?.performedMidi === null || entry?.performedMidi === undefined
    ? null
    : Number(entry.performedMidi);
  if (performedMidi !== null && (!Number.isInteger(performedMidi) || performedMidi < 0 || performedMidi > 127)) {
    throw new Error("training ledger extra event performedMidi must be an integer from 0 to 127.");
  }
  const note = safeString(entry?.note);
  if (note.length > 500) throw new Error("training ledger extra event note exceeds 500 characters.");
  return {
    kind: "extra",
    afterNoteId: anchorNoteId,
    performedMidi,
    startSeconds,
    endSeconds,
    note,
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
  const boundSubjectRef = safeString(submission.studentRef).trim();
  const requestedPerformerId = safeString(payload.performerId).trim();
  if (boundSubjectRef && requestedPerformerId && requestedPerformerId !== boundSubjectRef) {
    throw new Error("training ledger performerId conflicts with the submission student identity.");
  }
  const performerId = boundSubjectRef || requestedPerformerId;
  if (!performerId) throw new Error("training ledger requires a performerId.");

  // Consent is resolved from the subject's own auditable grant, not from a
  // teacher's checkbox. A ticked box proves the teacher ticked a box; it cannot
  // show who agreed, to what wording, when, or whether a guardian was involved,
  // and a corpus that cannot show that is not usable for training later.
  const consent = await resolveTrainingConsent({ repoRoot, subjectRef: performerId });
  if (!consent.eligible) {
    throw new Error(`training ledger requires a granted training consent for ${performerId}: ${consent.reason}.`);
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
  const requestedExtraEvents = Array.isArray(payload.extraEvents) ? payload.extraEvents : [];
  if (requestedExtraEvents.length > 100) {
    throw new Error("training ledger accepts at most 100 extra events per review.");
  }
  const extraEvents = requestedExtraEvents
    .map((entry) => normalizeExtraEvent(entry, artifact));

  // Audio provenance is re-checked against the file on disk right now; the
  // score payload sha is the analysis-time value carried by the artifact's run,
  // because the shared score store legitimately changes after an analysis.
  const submittedAudioHash = safeString(submission.audioHash).trim().toLowerCase();
  if (!SHA1_PATTERN.test(submittedAudioHash) && !SHA256_PATTERN.test(submittedAudioHash)) {
    throw new Error("training ledger requires a submission audio hash (sha1 or sha256).");
  }
  const audioPath = safeString(submission.audioPath || submission.audioSubmission?.storedPath).trim();
  if (!audioPath) {
    throw new Error("training ledger requires an on-disk audio file.");
  }
  const dataRoot = path.join(repoRoot, "data");
  const resolvedAudio = path.resolve(repoRoot, audioPath);
  if (!pathIsInside(dataRoot, resolvedAudio)) {
    throw new Error("training ledger audio file resolved outside the data directory.");
  }
  let audioBytes = null;
  try {
    const [realDataRoot, realAudioPath] = await Promise.all([
      fs.realpath(dataRoot),
      fs.realpath(resolvedAudio),
    ]);
    if (!pathIsInside(realDataRoot, realAudioPath)) {
      throw new Error("training ledger audio file resolved outside the data directory.");
    }
    audioBytes = await fs.readFile(realAudioPath);
  } catch (error) {
    if (String(error?.message || "").includes("outside the data directory")) throw error;
    throw new Error(`training ledger audio file is missing on disk: ${audioPath}.`);
  }
  const audioSha256 = sha256Buffer(audioBytes);
  const submittedAudioHashAlgorithm = SHA256_PATTERN.test(submittedAudioHash) ? "sha256" : "sha1";
  const observedSubmittedHash = submittedAudioHashAlgorithm === "sha256"
    ? audioSha256
    : sha1Buffer(audioBytes);
  if (observedSubmittedHash !== submittedAudioHash) {
    throw new Error("training ledger audio file no longer matches the submitted audio hash.");
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
      audioRehashed: true,
      submissionAudioHashAlgorithm: submittedAudioHashAlgorithm,
      submissionAudioHashVerified: true,
      verifiedAt: nowIso(),
    },
    // The grant itself, not a yes/no: an auditor must be able to see who
    // agreed, to which wording, when, and whether a guardian was involved.
    consent: "yes",
    trainingConsent: {
      consentId: consent.consent.consentId,
      consentVersion: consent.consent.consentVersion,
      purpose: consent.consent.purpose,
      subjectRef: consent.consent.subjectRef,
      subjectType: consent.consent.subjectType,
      guardianStatus: consent.consent.guardianStatus,
      signedAt: consent.consent.signedAt,
      capturedVia: consent.consent.capturedVia,
    },
    trainingEligible: true,
    licenseStatus: safeString(payload.licenseStatus, "local-only"),
  };
}

function verifiedLedgerTail(existing, record) {
  let previousRecordSha256 = "";
  let first = null;
  for (const [index, line] of existing.entries()) {
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`training ledger record ${index + 1} is unreadable; refusing to append onto a broken chain.`);
    }
    if (parsed?.revision !== index + 1
      || safeString(parsed?.previousRecordSha256) !== previousRecordSha256
      || recordSha256(parsed) !== parsed?.recordSha256) {
      throw new Error(`training ledger record ${index + 1} breaks the hash chain; refusing to append.`);
    }
    if (!first) {
      first = parsed;
    } else {
      for (const field of CHAIN_IDENTITY_FIELDS) {
        if (safeString(first[field]) !== safeString(parsed[field])) {
          throw new Error(`training ledger ${field} changed within one recording chain.`);
        }
      }
    }
    previousRecordSha256 = parsed.recordSha256;
  }
  if (first) {
    for (const field of CHAIN_IDENTITY_FIELDS) {
      if (safeString(first[field]) !== safeString(record[field])) {
        throw new Error(`training ledger ${field} changed within one recording chain.`);
      }
    }
  }
  return previousRecordSha256;
}

async function withLedgerAppendQueue(outPath, operation) {
  const queueKey = process.platform === "win32" ? outPath.toLowerCase() : outPath;
  const previous = ledgerAppendQueues.get(queueKey) || Promise.resolve();
  const queued = previous.catch(() => {}).then(operation);
  ledgerAppendQueues.set(queueKey, queued);
  try {
    return await queued;
  } finally {
    if (ledgerAppendQueues.get(queueKey) === queued) ledgerAppendQueues.delete(queueKey);
  }
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

  return withLedgerAppendQueue(outPath, async () => {
    // Append only: a re-review is a NEW immutable record chained to the previous
    // one. Earlier labels, signer and timestamp stay readable forever.
    const existing = await readJsonlLines(outPath);
    const previousRecordSha256 = verifiedLedgerTail(existing, record);
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
  });
}
