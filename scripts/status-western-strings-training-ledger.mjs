import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  TRAINING_LEDGER_CONTRACT,
  TRAINING_LEDGER_ERROR_LABELS,
  TRAINING_LEDGER_LABELS,
  normalizePerformerKey,
  recordSha256,
  trainingLedgerDir,
} from "../src/server/westernStringsTrainingLedger.js";
import {
  TRAINING_CONSENT_CONTRACT,
  TRAINING_CONSENT_VERSION,
  trainingConsentRecordId,
  trainingConsentPath,
} from "../src/server/westernStringsTrainingConsent.js";

// Milestones from docs/western-strings-training-ledger-spec.md section 4. They
// gate only ONE thing: whether it is worth PROPOSING a preregistered
// from-scratch training experiment. They never open a student switch.
//
// This script is a QUALITY gate, not a counter: a record only counts after its
// analysis artifact is re-hashed from disk, its hash chain re-verified and its
// consent / sweep / label vocabulary re-checked. A ledger full of unverifiable
// rows must never read as "ready".
const MILESTONE_RECORDINGS = 300;
const MILESTONE_PERFORMERS = 30;
const MILESTONE_DRAG_POSITIVES = 200;
const MILESTONE_MIN_PER_ERROR_LABEL = 50;
const MILESTONE_DOUBLE_REVIEW_RATE = 0.1;
const CHAIN_IDENTITY_FIELDS = ["recordingId", "submissionId", "audioSha256", "scorePayloadSha256"];

const repoRoot = process.cwd();
const ledgerDir = trainingLedgerDir(repoRoot);
const dataRoot = path.resolve(repoRoot, "data");
const files = fs.existsSync(ledgerDir)
  ? fs.readdirSync(ledgerDir).filter((name) => name.endsWith(".jsonl")).sort()
  : [];
const latestConsentBySubject = new Map();
const invalidConsentRecords = [];
const consentFile = trainingConsentPath(repoRoot);
if (fs.existsSync(consentFile)) {
  for (const line of fs.readFileSync(consentFile, "utf8").split(/\r?\n/).filter((item) => item.trim())) {
    try {
      const record = JSON.parse(line);
      if (record?.consentContract === TRAINING_CONSENT_CONTRACT && record?.subjectRef) {
        if (trainingConsentRecordId(record) !== record.consentId) {
          invalidConsentRecords.push({ problems: ["consent-record-hash-mismatch"] });
        } else {
          latestConsentBySubject.set(record.subjectRef, record);
        }
      }
    } catch {
      invalidConsentRecords.push({ problems: ["consent-record-unreadable"] });
    }
  }
}

const artifactShaCache = new Map();
function managedArtifact(relativePath) {
  if (artifactShaCache.has(relativePath)) return artifactShaCache.get(relativePath);
  const resolved = path.resolve(repoRoot, relativePath);
  const lexicalRelative = path.relative(dataRoot, resolved);
  if (!lexicalRelative || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    const result = { sha256: "", status: "outside-data" };
    artifactShaCache.set(relativePath, result);
    return result;
  }
  let result = null;
  try {
    const realDataRoot = fs.realpathSync(dataRoot);
    const realTarget = fs.realpathSync(resolved);
    const realRelative = path.relative(realDataRoot, realTarget);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      result = { sha256: "", status: "outside-data" };
    } else {
      result = {
        sha256: crypto.createHash("sha256").update(fs.readFileSync(realTarget)).digest("hex"),
        status: "ok",
      };
    }
  } catch {
    result = { sha256: "", status: "missing" };
  }
  artifactShaCache.set(relativePath, result);
  return result;
}

function verifyRecord(record, previousSha) {
  const problems = [];
  if (record?.ledgerContract !== TRAINING_LEDGER_CONTRACT) problems.push("contract-mismatch");
  if (!record?.performerId || !record?.performerKey) problems.push("performer-id-missing");
  if (!record?.reviewedBy) problems.push("reviewer-missing");
  if (record?.consent !== "yes") problems.push("consent-missing");
  if (record?.completeErrorInventory !== true) problems.push("inventory-not-signed");
  if (record?.fullScoreReviewed !== true) problems.push("full-score-sweep-not-confirmed");
  if (!Number.isInteger(record?.scoreNoteCount) || record.scoreNoteCount <= 0) problems.push("score-note-count-invalid");

  // Hash chain: a rewritten or reordered history is not silently accepted.
  if (recordSha256(record) !== record?.recordSha256) problems.push("record-hash-mismatch");
  if ((record?.previousRecordSha256 || "") !== previousSha) problems.push("chain-broken");

  // The features these labels point at must still be byte-identical.
  const artifactPath = record?.machineSnapshot?.candidateRowsPath || "";
  if (!artifactPath) problems.push("analysis-snapshot-missing");
  else {
    const observed = managedArtifact(artifactPath);
    if (observed.status === "outside-data") problems.push("analysis-artifact-outside-data");
    else if (observed.status === "missing") problems.push("analysis-artifact-missing-on-disk");
    else if (observed.sha256 !== record?.machineSnapshot?.candidateRowsSha256) problems.push("analysis-artifact-changed");
  }

  const audioPath = record?.audioPath || "";
  if (!audioPath) problems.push("audio-path-missing");
  else {
    const observed = managedArtifact(audioPath);
    if (observed.status === "outside-data") problems.push("audio-path-outside-data");
    else if (observed.status === "missing") problems.push("audio-artifact-missing-on-disk");
    else if (observed.sha256 !== record?.audioSha256) problems.push("audio-artifact-changed");
  }
  if (record?.verification?.audioRehashed !== true
    || record?.verification?.submissionAudioHashVerified !== true) {
    problems.push("audio-provenance-unverified");
  }

  // A record written before training consent was collected separately proves a
  // teacher ticked a box, not that the subject agreed to training use. It stays
  // in the ledger as history but must never be counted as trainable.
  if (!record?.trainingConsent?.consentId || record?.trainingEligible !== true) {
    problems.push("legacy-consent-unverified");
  } else {
    const subjectRef = record.trainingConsent.subjectRef;
    const currentConsent = latestConsentBySubject.get(subjectRef);
    if (subjectRef !== record.performerId) problems.push("consent-subject-mismatch");
    if (!currentConsent) problems.push("current-consent-missing");
    else if (currentConsent.decision !== "granted") problems.push(`current-consent-${currentConsent.decision}`);
    else if (currentConsent.consentVersion !== TRAINING_CONSENT_VERSION) problems.push("current-consent-version-superseded");
  }

  const labels = Array.isArray(record?.noteLabels) ? record.noteLabels : [];
  if (labels.some((entry) => !TRAINING_LEDGER_LABELS.includes(entry?.label))) problems.push("label-out-of-vocabulary");
  if (labels.length > record?.scoreNoteCount) problems.push("more-labels-than-score-notes");
  if (new Set(labels.map((entry) => entry?.noteId)).size !== labels.length) problems.push("duplicate-note-labels");
  return problems;
}

const invalid = [];
const consentQuarantined = [];
const validByRecording = new Map();
for (const name of files) {
  const filePath = path.join(ledgerDir, name);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  let previousSha = "";
  let firstRecord = null;
  for (const [index, line] of lines.entries()) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      invalid.push({ file: name, line: index + 1, problems: ["unparsable"] });
      break;
    }
    const problems = verifyRecord(record, previousSha);
    if (!firstRecord) {
      firstRecord = record;
    } else {
      for (const field of CHAIN_IDENTITY_FIELDS) {
        if (String(firstRecord?.[field] || "") !== String(record?.[field] || "")) {
          problems.push(`chain-${field}-changed`);
        }
      }
    }
    previousSha = record?.recordSha256 || "";
    if (problems.length) {
      const consentOnly = problems.every((problem) => (
        problem === "legacy-consent-unverified"
        || problem === "current-consent-missing"
        || problem === "consent-subject-mismatch"
        || problem === "current-consent-version-superseded"
        || problem.startsWith("current-consent-")
      ));
      (consentOnly ? consentQuarantined : invalid).push({ file: name, line: index + 1, problems });
      continue;
    }
    const key = record.recordingId;
    if (!validByRecording.has(key)) validByRecording.set(key, []);
    validByRecording.get(key).push(record);
  }
}

// Corpus counts use the latest verified signature per recording; earlier
// signatures stay in the ledger as history and feed inter-rater instead.
const labelCounts = Object.fromEntries(TRAINING_LEDGER_LABELS.map((label) => [label, 0]));
const performerKeys = new Map();
let extraEventCount = 0;
let implicitCorrect = 0;
let recordings = 0;

for (const [, history] of validByRecording) {
  const latest = history[history.length - 1];
  recordings += 1;
  performerKeys.set(latest.performerKey, (performerKeys.get(latest.performerKey) || 0) + 1);
  for (const entry of latest.noteLabels || []) labelCounts[entry.label] += 1;
  extraEventCount += (latest.extraEvents || []).length;
  // Unlabeled score notes are gold `correct` by the signed sweep; counting them
  // stops a corpus of 3 explicit labels from looking balanced.
  implicitCorrect += Math.max(0, latest.scoreNoteCount - (latest.noteLabels || []).length);
}
labelCounts.correct += implicitCorrect;

// Free-text performer ids: near-identical keys probably mean one person was
// entered twice, which would silently break a by-performer split.
const performerList = [...performerKeys.keys()].sort();
const suspiciousPerformerPairs = [];
for (let i = 0; i < performerList.length; i += 1) {
  for (let j = i + 1; j < performerList.length; j += 1) {
    const a = performerList[i].replace(/[^a-z0-9]/g, "");
    const b = performerList[j].replace(/[^a-z0-9]/g, "");
    if (a && (a === b || a.replace(/0+(\d)/g, "$1") === b.replace(/0+(\d)/g, "$1"))) {
      suspiciousPerformerPairs.push([performerList[i], performerList[j]]);
    }
  }
}

// Inter-rater: a recording is double-reviewed when two DIFFERENT reviewers each
// signed a complete inventory. Reported as raw percent agreement, not kappa.
let doubleReviewed = 0;
let agreementNotes = 0;
let agreementMatches = 0;
const disagreementSamples = [];
for (const [recordingId, history] of validByRecording) {
  const latestByReviewer = new Map();
  for (const record of history) latestByReviewer.set(record.reviewedBy, record);
  if (latestByReviewer.size < 2) continue;
  doubleReviewed += 1;
  const [first, second] = [...latestByReviewer.values()].slice(-2);
  const mapOf = (record) => new Map((record.noteLabels || []).map((entry) => [entry.noteId, entry.label]));
  const a = mapOf(first);
  const b = mapOf(second);
  for (const noteId of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(noteId) || "correct";
    const right = b.get(noteId) || "correct";
    agreementNotes += 1;
    if (left === right) agreementMatches += 1;
    else if (disagreementSamples.length < 10) {
      disagreementSamples.push({ recordingId, noteId, [first.reviewedBy]: left, [second.reviewedBy]: right });
    }
  }
}

const errorCounts = TRAINING_LEDGER_ERROR_LABELS.map((label) => labelCounts[label]);
const maxError = Math.max(0, ...errorCounts);
const minError = Math.min(...errorCounts, maxError);
const rarest = TRAINING_LEDGER_ERROR_LABELS.reduce(
  (lowest, label) => (labelCounts[label] < labelCounts[lowest] ? label : lowest),
  TRAINING_LEDGER_ERROR_LABELS[0],
);
const doubleReviewRate = recordings ? doubleReviewed / recordings : 0;

const milestones = {
  recordings: { required: MILESTONE_RECORDINGS, actual: recordings, met: recordings >= MILESTONE_RECORDINGS },
  performers: { required: MILESTONE_PERFORMERS, actual: performerKeys.size, met: performerKeys.size >= MILESTONE_PERFORMERS },
  dragPositives: { required: MILESTONE_DRAG_POSITIVES, actual: labelCounts.drag, met: labelCounts.drag >= MILESTONE_DRAG_POSITIVES },
  perErrorLabelFloor: {
    required: MILESTONE_MIN_PER_ERROR_LABEL,
    actual: Object.fromEntries(TRAINING_LEDGER_ERROR_LABELS.map((label) => [label, labelCounts[label]])),
    met: TRAINING_LEDGER_ERROR_LABELS.every((label) => labelCounts[label] >= MILESTONE_MIN_PER_ERROR_LABEL),
  },
  doubleReview: {
    required: MILESTONE_DOUBLE_REVIEW_RATE,
    actual: Number(doubleReviewRate.toFixed(4)),
    met: doubleReviewRate >= MILESTONE_DOUBLE_REVIEW_RATE,
  },
  noInvalidRecords: {
    required: 0,
    actual: invalid.length + invalidConsentRecords.length,
    met: invalid.length === 0 && invalidConsentRecords.length === 0,
  },
};

const status = {
  ok: invalid.length === 0 && invalidConsentRecords.length === 0 && suspiciousPerformerPairs.length === 0,
  contract: TRAINING_LEDGER_CONTRACT,
  generatedAt: new Date().toISOString(),
  source: path.relative(repoRoot, ledgerDir).replace(/\\/g, "/"),
  counts: {
    // Two different numbers on purpose. A physical record only shows a file was
    // written; only a record carrying the subject's own consent grant may be
    // counted toward a training corpus, and conflating them is how an
    // unusable corpus looks ready.
    physicalRecordFiles: files.length,
    recordings,
    trainingEligibleRecordings: recordings,
    legacyConsentUnverified: consentQuarantined.filter(
      (row) => (row.problems || []).includes("legacy-consent-unverified"),
    ).length,
    consentQuarantined: consentQuarantined.length,
    signatures: [...validByRecording.values()].reduce((total, history) => total + history.length, 0),
    performers: performerKeys.size,
    extraEvents: extraEventCount,
    implicitCorrect,
    labels: labelCounts,
  },
  balance: {
    errorLabelBalance: maxError > 0 ? Number((minError / maxError).toFixed(4)) : 0,
    rarestErrorLabel: rarest,
    rarestErrorLabelCount: labelCounts[rarest] || 0,
  },
  interRater: {
    metric: "raw-percent-agreement-not-kappa",
    doubleReviewedRecordings: doubleReviewed,
    doubleReviewRate: Number(doubleReviewRate.toFixed(4)),
    comparedNotes: agreementNotes,
    agreement: agreementNotes ? Number((agreementMatches / agreementNotes).toFixed(4)) : null,
    disagreementSamples,
  },
  dataQuality: {
    verifiedAgainstDisk: invalid.length === 0 && invalidConsentRecords.length === 0,
    invalidRecords: invalid,
    invalidConsentRecords,
    consentQuarantinedRecords: consentQuarantined,
    suspiciousPerformerPairs,
  },
  milestones,
  // Hard-coded facts, not derived state: this ledger can never authorize
  // anything by itself (spec section 5.1 / 5.2).
  studentFacing: false,
  automaticAuthorizationGranted: false,
  usableForFrozenCandidateTuning: false,
};

status.readyToProposeFromScratchTrainingExperiment = Object.values(milestones).every((item) => item.met);

console.log(JSON.stringify(status, null, 2));
if (!status.ok) process.exitCode = 1;
