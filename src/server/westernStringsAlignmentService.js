import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { clamp, createId, nowIso, safeBoolean, safeNumber, safeString } from "./baseUtils.js";
import { readScoreStoreFromSqlite } from "./scoreStoreSqlite.js";

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OFFLINE_FEATURE_STUDENT_GATE_VERSION = "western-offline-feature-gate-v0-review-only";
const OFFLINE_FEATURE_CONFIDENCE_RELEASE_PATH = path.join(
  SOURCE_ROOT,
  "models",
  "western-strings",
  "ordinary-upload-confidence-rf-v1",
  "release.json",
);
const ORDINARY_DYNAMIC_SHADOW_CONTRACT_VERSION = "western-ordinary-dynamic-shadow-candidate-v1";
const ORDINARY_DYNAMIC_SHADOW_POLICY_VERSION = "western-ordinary-dynamic-shadow-policy-v1";
const ORDINARY_DYNAMIC_SHADOW_GATE_VERSION = "western-ordinary-dynamic-shadow-gate-v1-review-only";
const ORDINARY_DYNAMIC_SHADOW_TIMING_MODE = "basic-pitch-dtw";
const ORDINARY_DYNAMIC_SHADOW_CAUSAL_ENERGY_STATUS = "excluded-review-only";
const ORDINARY_DYNAMIC_SHADOW_MODEL_VERSION = "basic-pitch-0.4.0-default-model";
const ORDINARY_DYNAMIC_SHADOW_MODEL_ARTIFACT_SHA256 = "c6595f299ff83c52e89555789f7e3e829a6a0f25b6a88f7e99073af5a2470dc4";
const ORDINARY_DYNAMIC_SHADOW_INFERENCE_VERSION = "default-frequency-range-g3-a7-min-note-80ms-v1";
const ORDINARY_AUDIO_RUNTIME_ID = "western-ordinary-dynamic-shadow-audio-py311";
const ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256 = "1f3a47f5cfe2b2d2e427be9a03ab43b4b4aa09a5db0edeed0b55e610a42ac6f9";
const ORDINARY_AUDIO_RUNTIME_LOCK_SHA256 = "4120a811da1ecb1aa93ceabcbb5aa0b45a37c08e5ee3138d2b793e38f2828d04";
const ORDINARY_DYNAMIC_SHADOW_CACHE_ROOT = "data/experiments/western-strings-m3/offline-basic-pitch-cache/";
export const ORDINARY_REVIEW_ASSIST_CONTRACT = "western-round4-policy-c-review-assist-v1";
const STUDENT_SCORE_ISSUE_CATEGORIES = new Set(["pitch", "rhythm", "tone", "missing"]);
const ORDINARY_DYNAMIC_SHADOW_POLICY = Object.freeze({
  deviationLimit: 0.15,
  minEventConfidence: 0.4,
  minRelativeEventConfidence: 0.8,
  minEventDurationSeconds: 0.08,
  minEventDurationRatio: 0.15,
  minSamePitchScoreDistanceQuarters: 0.5,
});
const M3PLUS_EVALUATION_CONTRACT = "m3plus-rescope-four-zone-v2";
const M3PLUS_RUNTIME_CONTRACT = "m3plus-gold-free-runtime-v1";
const M3PLUS_RUNTIME_POLICY_VERSION = "m3plus-gold-free-pitch-safety-policy-v1";
const M3PLUS_F0_BACKEND = "librosa-pyin";
const M3PLUS_RUNTIME_POLICY_SOURCE = "scripts/experiments/western_strings_m3plus_runtime_policy.py";
const M3PLUS_ANALYZER_SOURCE = "scripts/experiments/run_western_strings_offline_feature_analysis.py";
const M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256 = "8279e1e9a69c4bf35e18d55f4daf50522a9bb43ef9f472989e6c8c1b5481a274";
const M3PLUS_RUNTIME_POLICY_ARTIFACT_SHA256 = "226173fbde4fa73804d21daae7ea0179a3d97a5b547aebdfdebda52ac94e6eab";
const M3PLUS_ANALYZER_ARTIFACT_SEMANTIC_SHA256 = "65ea46768bf23e51aac4083c3fd08fecbeb2d81d8af4effc5aaae482bc7a279d";
const M3PLUS_PYIN_RUNTIME_DESCRIPTOR = Object.freeze({
  backend: "librosa-pyin",
  pythonVersion: "3.11.9",
  librosaVersion: "0.11.0",
  numpyVersion: "1.26.4",
  sampleRateHz: 22050,
  hopLength: 512,
  frameLength: 2048,
  fminNote: "C2",
  fmaxNote: "A7",
  voicedMask: "finite-f0-and-librosa-voiced",
});
const M3PLUS_RUNTIME_THRESHOLDS = Object.freeze({
  pitchToleranceCents: 50,
  maxSpreadCentsP95P05: 80,
  maxIqrCents: 80,
  minTotalFrameCount: 12,
  minVoicedFrameCount: 12,
  minVoicedFrameRatio: 0.7,
  glissandoTargetTailFraction: 0.35,
});
const M3PLUS_PROTECTED_EXACT_MARKINGS = new Set([
  "delayed-turn",
  "inverted-delayed-turn",
  "inverted-mordent",
  "inverted-turn",
  "mordent",
  "ornament",
  "ornaments",
  "shake",
  "schleifer",
  "trill",
  "trill-mark",
  "turn",
]);
const M3PLUS_GLISSANDO_MARKINGS = new Set(["gliss", "glissando", "portamento", "slide"]);

export function buildWesternOrdinaryReviewAssistDecision(candidate = {}) {
  const m3plusEvidence = candidate?.m3plusPitchSafetyEvidence || {};
  const strictConfirmedIssue = safeString(m3plusEvidence.decision) === "issue_detected";
  const selfCheckHint = !strictConfirmedIssue
    && candidate?.m3plusTimingAssignmentAvailable !== true;
  const outputSemantic = strictConfirmedIssue
    ? "confirmed_issue"
    : selfCheckHint
      ? "self_check_hint"
      : "no_issue_output";
  return {
    contract: ORDINARY_REVIEW_ASSIST_CONTRACT,
    outputSemantic,
    reviewerOnly: true,
    requiresHumanReview: outputSemantic !== "no_issue_output",
    automaticAccusationAuthorized: false,
    studentFacing: false,
    reason: strictConfirmedIssue
      ? "m3plus-issue-detected"
      : selfCheckHint
        ? "basic-pitch-dtw-assignment-missing"
        : "no-review-assist-output",
  };
}

function projectReviewAssistCandidate(candidate) {
  const decision = candidate.reviewAssistDecision || buildWesternOrdinaryReviewAssistDecision(candidate);
  return {
    noteId: safeString(candidate.noteId),
    noteIndex: Number(candidate.noteIndex),
    measureIndex: Number(candidate.measureIndex),
    beatStart: Number(candidate.beatStart),
    midi: candidate.midi == null ? null : Number(candidate.midi),
    predictedOnsetSeconds: candidate.predictedOnsetSeconds == null
      ? null
      : Number(candidate.predictedOnsetSeconds),
    ...decision,
  };
}

function projectStudentIssueCandidates(candidates, limit = 100) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length <= limit) return rows.map(projectReviewAssistCandidate);
  const selectedIndexes = new Set();
  for (let index = 0; index < rows.length && selectedIndexes.size < limit; index += 1) {
    if (rows[index]?.reviewAssistDecision?.outputSemantic === "confirmed_issue") {
      selectedIndexes.add(index);
    }
  }
  const remainingSlots = Math.max(0, limit - selectedIndexes.size);
  for (let slot = 0; slot < remainingSlots; slot += 1) {
    selectedIndexes.add(Math.round((slot * (rows.length - 1)) / Math.max(1, remainingSlots - 1)));
  }
  for (let index = 0; index < rows.length && selectedIndexes.size < limit; index += 1) {
    selectedIndexes.add(index);
  }
  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .slice(0, limit)
    .map((index) => projectReviewAssistCandidate(rows[index]));
}

export const WESTERN_ALIGNMENT_METHOD_PREFERENCE = [
  "parangonar-basic-pitch",
  "basic-pitch-dtw",
  "crepe-dtw",
  "pyin-dtw",
  "linear-scoretime",
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  return dataRows.map((dataRow) => Object.fromEntries(headers.map((header, index) => [header, dataRow[index] ?? ""])));
}

function methodRank(method) {
  const index = WESTERN_ALIGNMENT_METHOD_PREFERENCE.indexOf(method);
  return index >= 0 ? index : WESTERN_ALIGNMENT_METHOD_PREFERENCE.length;
}

function noteKey(row) {
  return [row.dataset, row.piece, row.noteIndex].map((item) => safeString(item)).join("\u0000");
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = noteKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function chooseCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const leftDistance = numberOrNull(left.candidateToMedianAbsSeconds) ?? 999;
    const rightDistance = numberOrNull(right.candidateToMedianAbsSeconds) ?? 999;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return methodRank(left.method) - methodRank(right.method);
  })[0];
}

function buildCandidateSource(row) {
  return {
    method: safeString(row.method),
    predTime: numberOrNull(row.predTime),
    candidateToMedianAbsSeconds: numberOrNull(row.candidateToMedianAbsSeconds),
  };
}

function confidenceScore(row) {
  const methodCount = Math.max(1, Math.round(safeNumber(row.methodCount, 1)));
  const agreement300 = clamp(Math.round(safeNumber(row.agreementWithin300ms, 0)) / methodCount, 0, 1);
  const distance = Math.max(0, safeNumber(row.candidateToMedianAbsSeconds, 1));
  const distanceScore = clamp(1 - distance / 0.3, 0, 1);
  return Number(((agreement300 * 0.7) + (distanceScore * 0.3)).toFixed(4));
}

function buildDecision(candidates, { includeLabels = false } = {}) {
  const selected = chooseCandidate(candidates);
  const decision = {
    noteId: `${safeString(selected.dataset)}:${safeString(selected.piece)}:${safeString(selected.noteIndex)}`,
    dataset: safeString(selected.dataset),
    piece: safeString(selected.piece),
    noteIndex: Math.round(safeNumber(selected.noteIndex, 0)),
    midi: Math.round(safeNumber(selected.midi, 0)),
    scoreTime: numberOrNull(selected.scoreTime),
    predictedOnsetSeconds: numberOrNull(selected.predTime),
    autoDecision: "auto_pass",
    confidenceScore: confidenceScore(selected),
    confidenceModelVersion: "western-m2-median-consensus-v1",
    reviewRequiredReason: "",
    candidateSources: candidates
      .map(buildCandidateSource)
      .sort((left, right) => methodRank(left.method) - methodRank(right.method)),
    evidence: {
      selectedMethod: safeString(selected.method),
      methodCount: Math.round(safeNumber(selected.methodCount, candidates.length)),
      validPredictionCount: Math.round(safeNumber(selected.validPredictionCount, candidates.length)),
      predictionSpanSeconds: numberOrNull(selected.predictionSpanSeconds),
      agreementWithin100ms: Math.round(safeNumber(selected.agreementWithin100ms, 0)),
      agreementWithin300ms: Math.round(safeNumber(selected.agreementWithin300ms, 0)),
      doubleStop: safeString(selected.doubleStop) === "1",
      legato: safeString(selected.legato, "unknown"),
    },
  };
  if (includeLabels) {
    decision.evaluation = {
      labelCandidateAbsError: numberOrNull(selected.labelCandidateAbsError),
      labelCandidateWithin100ms: safeString(selected.labelCandidateWithin100ms) === "1",
      labelCandidateWithin150ms: safeString(selected.labelCandidateWithin150ms) === "1",
      labelCandidateWithin300ms: safeString(selected.labelCandidateWithin300ms) === "1",
    };
  }
  return decision;
}

function basicPitchCachePath(repoRoot, dataset, piece) {
  if (dataset === "m0a-bach10") {
    return path.join(repoRoot, "data", "experiments", "western-strings-m0", "m0a-bach10", "cache", "basic-pitch", `${piece}-violin.basic-pitch.json`);
  }
  if (dataset === "m0b-urmp") {
    const track = safeString(piece).split(":").at(-1);
    const filename = {
      vn: "AuSep_1_vn_01_Jupiter.basic-pitch.json",
      vc: "AuSep_2_vc_01_Jupiter.basic-pitch.json",
    }[track];
    return filename ? path.join(repoRoot, "data", "experiments", "western-strings-m0", "m0b-urmp", "cache", "basic-pitch", filename) : "";
  }
  if (dataset === "m0c-musicnet") {
    const sampleId = safeString(piece).split(":")[0].replace("MusicNet-", "");
    return path.join(repoRoot, "data", "experiments", "western-strings-m0", "m0c-musicnet", "cache", "basic-pitch", `${sampleId}.basic-pitch.json`);
  }
  return "";
}

async function readBasicPitchEvents(repoRoot, cache, dataset, piece) {
  const key = `${dataset}\u0000${piece}`;
  if (!cache.has(key)) {
    const cacheFile = basicPitchCachePath(repoRoot, dataset, piece);
    if (!cacheFile) {
      cache.set(key, []);
    } else {
      try {
        cache.set(key, JSON.parse(await fs.readFile(cacheFile, "utf8")));
      } catch {
        cache.set(key, []);
      }
    }
  }
  return cache.get(key);
}

function nearestBasicPitchSupportSeconds(events, decision, threshold, pitchTolerance) {
  const predicted = numberOrNull(decision.predictedOnsetSeconds);
  const midi = numberOrNull(decision.midi);
  if (predicted === null || midi === null) return null;
  const targetMidi = Math.round(midi);
  let best = null;
  for (const event of events) {
    const eventStart = numberOrNull(event?.start);
    const eventMidi = numberOrNull(event?.midi);
    if (eventStart === null || eventMidi === null) continue;
    if (Math.abs(Math.round(eventMidi) - targetMidi) > pitchTolerance) continue;
    const distance = Math.abs(eventStart - predicted);
    if (best === null || distance < best) best = distance;
    if (best <= threshold) return best;
  }
  return best;
}

async function hasSequenceBasicPitchSupport(repoRoot, eventCache, pieceDecisions, index, supportFeature) {
  const threshold = Math.max(0, safeNumber(supportFeature?.thresholdSeconds, 0.03));
  const pitchTolerance = Math.max(0, Math.round(safeNumber(supportFeature?.pitchToleranceSemitones, 0)));
  const radius = Math.max(0, Math.round(safeNumber(supportFeature?.neighborRadius, 2)));
  const start = Math.max(0, index - radius);
  const stop = Math.min(pieceDecisions.length, index + radius + 1);
  for (const decision of pieceDecisions.slice(start, stop)) {
    const events = await readBasicPitchEvents(repoRoot, eventCache, decision.dataset, decision.piece);
    const support = nearestBasicPitchSupportSeconds(events, decision, threshold, pitchTolerance);
    if (support === null || support > threshold) return false;
  }
  return true;
}

function summarize(decisions, { includeLabels = false } = {}) {
  const autoPassCount = decisions.filter((item) => item.autoDecision === "auto_pass").length;
  const summary = {
    noteCount: decisions.length,
    autoPassCount,
    reviewRequiredCount: decisions.length - autoPassCount,
    coverage: decisions.length ? Number((autoPassCount / decisions.length).toFixed(4)) : 0,
    confidenceModelVersion: "western-m2-median-consensus-v1",
  };
  if (includeLabels) {
    const evaluated = decisions.filter((item) => item.evaluation);
    const correct = evaluated.filter((item) => item.evaluation.labelCandidateWithin300ms).length;
    const autoPassEvaluated = evaluated.filter((item) => item.autoDecision === "auto_pass");
    const autoPassCorrect = autoPassEvaluated.filter((item) => item.evaluation.labelCandidateWithin300ms).length;
    summary.evaluation = {
      evaluatedCount: evaluated.length,
      correctWithin300ms: correct,
      precisionWithin300ms: evaluated.length ? Number((correct / evaluated.length).toFixed(4)) : 0,
      autoPassEvaluatedCount: autoPassEvaluated.length,
      autoPassCorrectWithin300ms: autoPassCorrect,
      autoPassPrecisionWithin300ms: autoPassEvaluated.length ? Number((autoPassCorrect / autoPassEvaluated.length).toFixed(4)) : 0,
    };
  }
  return summary;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonlRecords(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function controlledSubmissionsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl");
}

export function controlledSubmissionReviewsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl");
}

function controlledSubmissionBatchRunsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl");
}

function photoScoreBatchRunsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m4", "photo-score-batch-runs.jsonl");
}

function controlledSubmissionCandidateRowsDir(repoRoot, batchRunId) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "offline-feature-candidates", safeString(batchRunId, "unknown-batch"));
}

async function writeControlledSubmissionCandidateRows(
  repoRoot,
  { batchRunId, submissionId, candidateRows, candidateGate = null },
) {
  const safeSubmissionId = safeString(submissionId, "unknown-submission").replace(/[^A-Za-z0-9_.-]/g, "_");
  const outPath = path.join(controlledSubmissionCandidateRowsDir(repoRoot, batchRunId), `${safeSubmissionId}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify({
    batchRunId: safeString(batchRunId),
    submissionId: safeString(submissionId),
    rowCount: Array.isArray(candidateRows) ? candidateRows.length : 0,
    candidateGate,
    candidateRows: Array.isArray(candidateRows) ? candidateRows : [],
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(outPath, bytes);
  return {
    path: path.relative(repoRoot, outPath).replace(/\\/g, "/"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function resolveRepoPath(repoRoot, maybeRelativePath) {
  const value = safeString(maybeRelativePath).trim();
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function pathIsInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function verifyBasicPitchCacheArtifact(repoRoot, provenance, expectedAudioSha256) {
  const blockingReasons = [];
  const cachePath = safeString(provenance?.cachePath).trim().replace(/\\/g, "/");
  const cacheRoot = path.resolve(repoRoot, ORDINARY_DYNAMIC_SHADOW_CACHE_ROOT);
  const artifactPath = cachePath ? path.resolve(repoRoot, cachePath) : "";
  let realArtifactPath = "";
  let artifactSha256 = "";
  let cacheIdentity = null;
  try {
    const [realCacheRoot, resolvedArtifact] = await Promise.all([
      fs.realpath(cacheRoot),
      fs.realpath(artifactPath),
    ]);
    realArtifactPath = resolvedArtifact;
    if (!pathIsInside(realCacheRoot, realArtifactPath)) {
      blockingReasons.push("ordinary-upload-basic-pitch-cache-realpath-outside-root");
    } else {
      const bytes = await fs.readFile(realArtifactPath);
      artifactSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      let payload = null;
      try {
        payload = JSON.parse(bytes.toString("utf8"));
      } catch {
        blockingReasons.push("ordinary-upload-basic-pitch-cache-json-invalid");
      }
      cacheIdentity = payload?.cacheIdentity || null;
      if (payload?.schemaVersion !== 3 || !Array.isArray(payload?.events)) {
        blockingReasons.push("ordinary-upload-basic-pitch-cache-schema-invalid");
      }
    }
  } catch {
    blockingReasons.push("ordinary-upload-basic-pitch-cache-artifact-unreadable");
  }

  const expectedIdentity = {
    audioSha256: safeString(expectedAudioSha256).trim().toLowerCase(),
    modelVersion: ORDINARY_DYNAMIC_SHADOW_MODEL_VERSION,
    modelArtifactSha256: ORDINARY_DYNAMIC_SHADOW_MODEL_ARTIFACT_SHA256,
    inferenceVersion: ORDINARY_DYNAMIC_SHADOW_INFERENCE_VERSION,
    policyVersion: ORDINARY_DYNAMIC_SHADOW_POLICY_VERSION,
    runtimeId: ORDINARY_AUDIO_RUNTIME_ID,
    runtimeConfigSemanticSha256: ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256,
    runtimeRequirementsLockSha256: ORDINARY_AUDIO_RUNTIME_LOCK_SHA256,
  };
  if (!cacheIdentity
      || typeof cacheIdentity !== "object"
      || Array.isArray(cacheIdentity)
      || Object.keys(cacheIdentity).length !== Object.keys(expectedIdentity).length
      || Object.entries(expectedIdentity).some(([key, value]) => cacheIdentity[key] !== value)) {
    blockingReasons.push("ordinary-upload-basic-pitch-cache-identity-mismatch");
  }
  if (artifactSha256 !== safeString(provenance?.cacheArtifactSha256).trim().toLowerCase()) {
    blockingReasons.push("ordinary-upload-basic-pitch-cache-artifact-sha-mismatch");
  }
  return {
    verified: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
    cachePath,
    artifactSha256,
    cacheIdentity,
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function buildScoreNoteIdentityRows(score) {
  const rows = [];
  for (const section of score?.sections || []) {
    for (const note of section?.notes || []) {
      const midi = safeNumber(note?.midiPitch, -1);
      if (midi <= 0) continue;
      rows.push({
        noteIndex: rows.length,
        noteId: safeString(note?.noteId).trim(),
        sectionId: safeString(section?.sectionId).trim(),
        measureIndex: Math.round(safeNumber(note?.measureIndex, -1)),
        midi: Math.round(midi),
      });
    }
  }
  return rows;
}

function buildCandidateNoteIdentityRows(candidateRows) {
  return (Array.isArray(candidateRows) ? candidateRows : []).map((candidate) => ({
    noteIndex: typeof candidate?.noteIndex === "number" && Number.isInteger(candidate.noteIndex)
      ? candidate.noteIndex
      : null,
    noteId: safeString(candidate?.noteId).trim(),
    sectionId: safeString(candidate?.sectionId).trim(),
    measureIndex: typeof candidate?.measureIndex === "number" && Number.isInteger(candidate.measureIndex)
      ? candidate.measureIndex
      : null,
    midi: typeof candidate?.midi === "number" && Number.isInteger(candidate.midi)
      ? candidate.midi
      : null,
  }));
}

function normalizeM3PlusMarkings(value) {
  const source = Array.isArray(value) ? value : (value === null || value === undefined ? [] : [value]);
  return [...new Set(source
    .map((item) => safeString(item).trim().toLowerCase())
    .filter(Boolean))].sort();
}

function m3plusProtectedMarkings(techniques, notations) {
  const markings = [...new Set([
    ...normalizeM3PlusMarkings(techniques),
    ...normalizeM3PlusMarkings(notations),
  ])].sort();
  return markings.filter((marking) => (
    M3PLUS_PROTECTED_EXACT_MARKINGS.has(marking)
    || marking.includes("harmonic")
    || marking.includes("ornament")
    || marking.includes("trill")
    || marking.includes("mordent")
    || marking.endsWith("-turn")
  ));
}

function m3plusHasGlissandoMarking(techniques, notations) {
  const markings = [...new Set([
    ...normalizeM3PlusMarkings(techniques),
    ...normalizeM3PlusMarkings(notations),
  ])];
  return markings.some((marking) => M3PLUS_GLISSANDO_MARKINGS.has(marking) || marking.includes("gliss"));
}

function buildScoreM3PlusNoteIdentityRows(score) {
  const notes = [];
  let order = 0;
  for (const section of score?.sections || []) {
    for (const note of section?.notes || []) {
      const midi = safeNumber(note?.midiPitch, -1);
      if (midi <= 0) continue;
      const sourceMeasureIndex = Math.round(safeNumber(note?.measureIndex, 0));
      const position = note?.notePosition && typeof note.notePosition === "object"
        ? note.notePosition
        : {};
      notes.push({
        order,
        pageNumber: Math.round(safeNumber(position.pageNumber, 0)),
        sourceMeasureIndex,
        noteId: safeString(note?.noteId || `note-${order}`).trim(),
        sectionId: safeString(section?.sectionId).trim(),
        measureIndex: Math.round(safeNumber(position.globalMeasureIndex, sourceMeasureIndex)),
        beatStart: safeNumber(note?.beatStart, 0),
        beatDuration: Math.max(0.05, safeNumber(note?.beatDuration, 1)),
        midi: Math.round(midi),
        scoreArticulations: normalizeM3PlusMarkings(note?.articulations),
        scoreTechniques: normalizeM3PlusMarkings(note?.techniques),
        scoreNotations: normalizeM3PlusMarkings(note?.notations),
      });
      order += 1;
    }
  }
  notes.sort((left, right) => (
    left.pageNumber - right.pageNumber
    || left.sourceMeasureIndex - right.sourceMeasureIndex
    || left.beatStart - right.beatStart
    || left.order - right.order
  ));
  const onsetCounts = new Map();
  for (const note of notes) {
    const key = `${note.sectionId}\u0000${note.sourceMeasureIndex}\u0000${note.beatStart.toFixed(6)}`;
    onsetCounts.set(key, (onsetCounts.get(key) || 0) + 1);
  }
  for (const [index, note] of notes.entries()) {
    const key = `${note.sectionId}\u0000${note.sourceMeasureIndex}\u0000${note.beatStart.toFixed(6)}`;
    note.onsetGroupSize = onsetCounts.get(key) || 1;
    note.polyphonicScoreRegion = note.onsetGroupSize > 1;
    note.glissandoTargetMidi = null;
    note.glissandoTargetNoteId = null;
    if (!m3plusHasGlissandoMarking(note.scoreTechniques, note.scoreNotations)) continue;
    const previous = notes[index - 1];
    const previousIsSameGlissando = Boolean(
      previous
      && previous.sectionId === note.sectionId
      && previous.sourceMeasureIndex === note.sourceMeasureIndex
      && m3plusHasGlissandoMarking(previous.scoreTechniques, previous.scoreNotations)
    );
    const target = notes[index + 1];
    if (previousIsSameGlissando || !target) continue;
    const targetIsSameMarkedPhrase = target.sectionId === note.sectionId
      && target.sourceMeasureIndex === note.sourceMeasureIndex
      && target.beatStart > note.beatStart
      && target.midi !== note.midi
      && m3plusHasGlissandoMarking(target.scoreTechniques, target.scoreNotations);
    if (targetIsSameMarkedPhrase) {
      note.glissandoTargetMidi = target.midi;
      note.glissandoTargetNoteId = target.noteId;
    }
  }
  return notes.map((note, noteIndex) => ({
    noteIndex,
    noteId: note.noteId,
    sectionId: note.sectionId,
    measureIndex: note.measureIndex,
    beatStart: note.beatStart,
    beatDuration: note.beatDuration,
    midi: note.midi,
    scoreArticulations: note.scoreArticulations,
    scoreTechniques: note.scoreTechniques,
    scoreNotations: note.scoreNotations,
    onsetGroupSize: note.onsetGroupSize,
    polyphonicScoreRegion: note.polyphonicScoreRegion,
    glissandoTargetMidi: note.glissandoTargetMidi,
    glissandoTargetNoteId: note.glissandoTargetNoteId,
  }));
}

function buildCandidateM3PlusNoteIdentityRows(candidateRows) {
  return (Array.isArray(candidateRows) ? candidateRows : []).map((candidate) => ({
    noteIndex: Number.isInteger(candidate?.noteIndex) ? candidate.noteIndex : null,
    noteId: safeString(candidate?.noteId).trim(),
    sectionId: safeString(candidate?.sectionId).trim(),
    measureIndex: Number.isInteger(candidate?.measureIndex) ? candidate.measureIndex : null,
    beatStart: typeof candidate?.beatStart === "number" && Number.isFinite(candidate.beatStart)
      ? candidate.beatStart
      : null,
    beatDuration: typeof candidate?.beatDuration === "number" && Number.isFinite(candidate.beatDuration)
      ? candidate.beatDuration
      : null,
    midi: Number.isInteger(candidate?.midi) ? candidate.midi : null,
    scoreArticulations: normalizeM3PlusMarkings(candidate?.scoreArticulations),
    scoreTechniques: normalizeM3PlusMarkings(candidate?.scoreTechniques),
    scoreNotations: normalizeM3PlusMarkings(candidate?.scoreNotations),
    onsetGroupSize: Number.isInteger(candidate?.onsetGroupSize) ? candidate.onsetGroupSize : null,
    polyphonicScoreRegion: candidate?.polyphonicScoreRegion === true,
    glissandoTargetMidi: Number.isInteger(candidate?.glissandoTargetMidi)
      ? candidate.glissandoTargetMidi
      : null,
    glissandoTargetNoteId: candidate?.glissandoTargetNoteId === null
      ? null
      : safeString(candidate?.glissandoTargetNoteId).trim() || null,
  }));
}

function noteIdentityRowsSha256(rows) {
  return crypto.createHash("sha256").update(canonicalJson(rows), "utf8").digest("hex");
}

async function verifyScoreProvenance(repoRoot, provenance, expectedScoreId) {
  const blockingReasons = [];
  const sqlitePath = path.join(repoRoot, "data", "erhu-score-imports.sqlite");
  const jsonPath = path.join(repoRoot, "data", "erhu-score-imports.json");
  const sqliteExists = await fileExists(sqlitePath);
  const sourcePath = sqliteExists ? sqlitePath : jsonPath;
  let store = null;
  let scoreStoreArtifactSha256 = "";
  try {
    const sourceBytesBefore = await fs.readFile(sourcePath);
    scoreStoreArtifactSha256 = crypto.createHash("sha256").update(sourceBytesBefore).digest("hex");
    store = sqliteExists
      ? readScoreStoreFromSqlite(sqlitePath)
      : JSON.parse(sourceBytesBefore.toString("utf8"));
    const sourceBytesAfter = await fs.readFile(sourcePath);
    const afterSha256 = crypto.createHash("sha256").update(sourceBytesAfter).digest("hex");
    if (afterSha256 !== scoreStoreArtifactSha256) {
      blockingReasons.push("ordinary-upload-score-provenance-store-changed-during-verification");
    }
  } catch {
    blockingReasons.push("ordinary-upload-score-provenance-store-unreadable");
  }
  const scoreId = safeString(expectedScoreId).trim();
  const score = (Array.isArray(store?.scores) ? store.scores : [])
    .find((item) => safeString(item?.scoreId).trim() === scoreId);
  if (!score) blockingReasons.push("ordinary-upload-score-provenance-score-missing");
  const scorePayloadSha256 = score
    ? crypto.createHash("sha256").update(canonicalJson(score), "utf8").digest("hex")
    : "";
  const expectedNotes = score ? buildScoreNoteIdentityRows(score) : [];
  const expectedM3PlusNotes = score ? buildScoreM3PlusNoteIdentityRows(score) : [];
  const noteCount = expectedNotes.length;
  const noteIdentitySha256 = noteIdentityRowsSha256(expectedNotes);
  const m3plusPitchSafetyNoteIdentitySha256 = noteIdentityRowsSha256(expectedM3PlusNotes);
  const reportedSource = safeString(provenance?.scoreStorePath).trim().replace(/\\/g, "/");
  const expectedSource = path.relative(repoRoot, sourcePath).replace(/\\/g, "/");
  if (provenance?.scoreId !== scoreId) blockingReasons.push("ordinary-upload-score-provenance-id-mismatch");
  if (provenance?.scorePayloadSha256 !== scorePayloadSha256) {
    blockingReasons.push("ordinary-upload-score-provenance-payload-sha-mismatch");
  }
  if (reportedSource !== expectedSource) blockingReasons.push("ordinary-upload-score-provenance-source-mismatch");
  if (safeNumber(provenance?.noteCount, -1) !== noteCount) {
    blockingReasons.push("ordinary-upload-score-provenance-note-count-mismatch");
  }
  const reportedStoreSha256 = safeString(provenance?.scoreStoreArtifactSha256).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(reportedStoreSha256)) {
    blockingReasons.push("ordinary-upload-score-provenance-store-sha-invalid");
  } else if (reportedStoreSha256 !== scoreStoreArtifactSha256) {
    blockingReasons.push("ordinary-upload-score-provenance-store-sha-mismatch");
  }
  return {
    verified: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
    value: {
      scoreId,
      scorePayloadSha256,
      scoreStorePath: expectedSource,
      scoreStoreArtifactSha256,
      noteCount,
      noteIdentitySha256,
      m3plusPitchSafetyNoteIdentitySha256,
    },
    expectedNotes,
    expectedM3PlusNotes,
  };
}

async function verifyM3PlusRuntimeBindings(repoRoot, descriptor) {
  const blockingReasons = [];
  const descriptorValue = descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)
    ? descriptor
    : null;
  const descriptorReady = Boolean(
    descriptorValue
    && descriptorValue.evaluationContract === M3PLUS_EVALUATION_CONTRACT
    && descriptorValue.runtimeContract === M3PLUS_RUNTIME_CONTRACT
    && descriptorValue.policyVersion === M3PLUS_RUNTIME_POLICY_VERSION
    && descriptorValue.f0Backend === M3PLUS_F0_BACKEND
    && descriptorValue.policySemanticSha256 === M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256
    && canonicalJson(descriptorValue.thresholds || {}) === canonicalJson(M3PLUS_RUNTIME_THRESHOLDS)
    && descriptorValue.analyzerArtifactPath === M3PLUS_ANALYZER_SOURCE
    && /^[a-f0-9]{64}$/.test(safeString(descriptorValue.analyzerArtifactSha256).trim().toLowerCase())
    && descriptorValue.analyzerArtifactSemanticSha256 === M3PLUS_ANALYZER_ARTIFACT_SEMANTIC_SHA256
    && canonicalJson(descriptorValue.pyinRuntime || {}) === canonicalJson(M3PLUS_PYIN_RUNTIME_DESCRIPTOR)
    && descriptorValue.reviewOnly === true
    && descriptorValue.feedbackAuthorized === false
    && descriptorValue.studentFacing === false
  );
  if (!descriptorReady) blockingReasons.push("m3plus-runtime-policy-descriptor-invalid");

  const policyPath = path.join(SOURCE_ROOT, M3PLUS_RUNTIME_POLICY_SOURCE);
  let policyArtifactSha256 = "";
  let policyArtifactSemanticSha256 = "";
  try {
    const policyBytes = await fs.readFile(policyPath);
    policyArtifactSha256 = crypto.createHash("sha256").update(policyBytes).digest("hex");
    policyArtifactSemanticSha256 = crypto.createHash("sha256")
      .update(policyBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
      .digest("hex");
    if (policyArtifactSemanticSha256 !== M3PLUS_RUNTIME_POLICY_ARTIFACT_SHA256) {
      blockingReasons.push("m3plus-runtime-policy-artifact-sha-mismatch");
    }
  } catch {
    blockingReasons.push("m3plus-runtime-policy-artifact-unreadable");
  }

  const analyzerPath = path.join(SOURCE_ROOT, M3PLUS_ANALYZER_SOURCE);
  let analyzerArtifactSha256 = "";
  let analyzerArtifactSemanticSha256 = "";
  try {
    const analyzerBytes = await fs.readFile(analyzerPath);
    analyzerArtifactSha256 = crypto.createHash("sha256").update(analyzerBytes).digest("hex");
    analyzerArtifactSemanticSha256 = crypto.createHash("sha256")
      .update(analyzerBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
      .digest("hex");
    if (analyzerArtifactSha256 !== safeString(descriptorValue?.analyzerArtifactSha256).trim().toLowerCase()) {
      blockingReasons.push("m3plus-runtime-analyzer-artifact-raw-sha-mismatch");
    }
    if (analyzerArtifactSemanticSha256 !== M3PLUS_ANALYZER_ARTIFACT_SEMANTIC_SHA256
        || analyzerArtifactSemanticSha256 !== descriptorValue?.analyzerArtifactSemanticSha256) {
      blockingReasons.push("m3plus-runtime-analyzer-artifact-code-anchor-mismatch");
    }
  } catch {
    blockingReasons.push("m3plus-runtime-analyzer-artifact-unreadable");
  }

  const rescopeReportPath = path.join(
    repoRoot,
    "data",
    "experiments",
    "western-strings-m3plus",
    "rescope-gate",
    "report.json",
  );
  let rescopeReportSha256 = "";
  let rescopeReleaseGateReady = false;
  try {
    const bytes = await fs.readFile(rescopeReportPath);
    rescopeReportSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const report = JSON.parse(bytes.toString("utf8"));
    if (report?.schemaVersion !== 2 || report?.contract !== M3PLUS_EVALUATION_CONTRACT) {
      blockingReasons.push("m3plus-runtime-rescope-report-contract-invalid");
    }
    rescopeReleaseGateReady = report?.releaseGateReady === true;
  } catch {
    blockingReasons.push("m3plus-runtime-rescope-report-unreadable");
  }
  return {
    ready: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
    descriptorReady,
    policyArtifactPath: M3PLUS_RUNTIME_POLICY_SOURCE,
    policyArtifactSha256,
    policyArtifactSemanticSha256,
    analyzerArtifactPath: M3PLUS_ANALYZER_SOURCE,
    analyzerArtifactSha256,
    analyzerArtifactSemanticSha256,
    pyinRuntime: { ...M3PLUS_PYIN_RUNTIME_DESCRIPTOR },
    rescopeReportPath: path.relative(repoRoot, rescopeReportPath).replace(/\\/g, "/"),
    rescopeReportSha256,
    rescopeReleaseGateReady,
  };
}

function m3plusEvidenceNumber(evidence, key, errors, { integer = false, min = null, max = null } = {}) {
  if (!Object.hasOwn(evidence, key)) {
    errors.push(`m3plus-runtime-evidence-field-missing:${key}`);
    return null;
  }
  if (evidence[key] === null) return null;
  const value = evidence[key];
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    errors.push(`m3plus-runtime-evidence-field-invalid:${key}`);
    return null;
  }
  if (min !== null && value < min) errors.push(`m3plus-runtime-evidence-field-below-minimum:${key}`);
  if (max !== null && value > max) errors.push(`m3plus-runtime-evidence-field-above-maximum:${key}`);
  return value;
}

function evaluateM3PlusRuntimeEvidence(candidate = {}, expectedScoreNote = null) {
  const evidence = candidate?.m3plusPitchSafetyEvidence;
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      contractValid: false,
      decision: "insufficient_evidence",
      reason: "m3plus-runtime-evidence-missing",
      zone: "unknown",
      accusationIssued: false,
      reviewOnly: true,
      feedbackAuthorized: false,
      studentFacing: false,
      blockingReasons: ["m3plus-runtime-evidence-missing"],
    };
  }
  if (!expectedScoreNote) errors.push("m3plus-runtime-score-note-missing");
  if (evidence.evaluationContract !== M3PLUS_EVALUATION_CONTRACT) {
    errors.push("m3plus-runtime-evaluation-contract-mismatch");
  }
  if (evidence.runtimeContract !== M3PLUS_RUNTIME_CONTRACT) {
    errors.push("m3plus-runtime-contract-mismatch");
  }
  if (evidence.policyVersion !== M3PLUS_RUNTIME_POLICY_VERSION) {
    errors.push("m3plus-runtime-policy-version-mismatch");
  }
  if (evidence.policySemanticSha256 !== M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256) {
    errors.push("m3plus-runtime-policy-semantic-sha-mismatch");
  }
  if (evidence.f0Backend !== M3PLUS_F0_BACKEND) errors.push("m3plus-runtime-f0-backend-mismatch");
  if (canonicalJson(evidence.thresholds || {}) !== canonicalJson(M3PLUS_RUNTIME_THRESHOLDS)) {
    errors.push("m3plus-runtime-thresholds-mismatch");
  }
  if (evidence.reviewOnly !== true
      || evidence.feedbackAuthorized !== false
      || evidence.studentFacing !== false
      || candidate.feedbackAuthorized !== false
      || candidate.studentFacing !== false) {
    errors.push("m3plus-runtime-review-only-state-invalid");
  }
  for (const forbidden of ["expectedBehavior", "evaluationSplit", "humanGold", "goldLabel"]) {
    if (Object.hasOwn(evidence, forbidden)) errors.push(`m3plus-runtime-gold-dependent-field-forbidden:${forbidden}`);
  }

  const expectedTechniques = expectedScoreNote?.scoreTechniques || [];
  const expectedNotations = expectedScoreNote?.scoreNotations || [];
  const expectedArticulations = expectedScoreNote?.scoreArticulations || [];
  if (canonicalJson(normalizeM3PlusMarkings(candidate.scoreTechniques)) !== canonicalJson(expectedTechniques)
      || canonicalJson(normalizeM3PlusMarkings(candidate.scoreNotations)) !== canonicalJson(expectedNotations)
      || canonicalJson(normalizeM3PlusMarkings(candidate.scoreArticulations)) !== canonicalJson(expectedArticulations)
      || canonicalJson(normalizeM3PlusMarkings(evidence.scoreTechniques)) !== canonicalJson(expectedTechniques)
      || canonicalJson(normalizeM3PlusMarkings(evidence.scoreNotations)) !== canonicalJson(expectedNotations)) {
    errors.push("m3plus-runtime-score-marking-mismatch");
  }
  if (candidate.polyphonicScoreRegion !== expectedScoreNote?.polyphonicScoreRegion
      || evidence.polyphonicScoreRegion !== expectedScoreNote?.polyphonicScoreRegion
      || candidate.onsetGroupSize !== expectedScoreNote?.onsetGroupSize
      || candidate.glissandoTargetMidi !== expectedScoreNote?.glissandoTargetMidi
      || candidate.glissandoTargetNoteId !== expectedScoreNote?.glissandoTargetNoteId) {
    errors.push("m3plus-runtime-score-context-mismatch");
  }

  const protectedMarkings = m3plusProtectedMarkings(expectedTechniques, expectedNotations);
  const glissandoMarked = m3plusHasGlissandoMarking(expectedTechniques, expectedNotations);
  if (canonicalJson(normalizeM3PlusMarkings(evidence.protectedMarkings)) !== canonicalJson(protectedMarkings)
      || evidence.glissandoMarked !== glissandoMarked
      || evidence.glissandoTargetMidi !== expectedScoreNote?.glissandoTargetMidi) {
    errors.push("m3plus-runtime-zone-marker-derivation-mismatch");
  }
  if (typeof evidence.timingAssignmentAvailable !== "boolean"
      || evidence.timingAssignmentAvailable !== candidate.m3plusTimingAssignmentAvailable) {
    errors.push("m3plus-runtime-timing-assignment-state-invalid");
  }

  const windowStart = m3plusEvidenceNumber(evidence, "windowStartSeconds", errors);
  const windowEnd = m3plusEvidenceNumber(evidence, "windowEndSeconds", errors);
  const totalFrames = m3plusEvidenceNumber(evidence, "totalFrameCount", errors, { integer: true, min: 0 });
  const voicedFrames = m3plusEvidenceNumber(evidence, "voicedFrameCount", errors, { integer: true, min: 0 });
  const voicedRatio = m3plusEvidenceNumber(evidence, "voicedFrameRatio", errors, { min: 0, max: 1 });
  const medianMidi = m3plusEvidenceNumber(evidence, "medianObservedMidi", errors);
  const centerError = m3plusEvidenceNumber(evidence, "centerErrorCents", errors);
  const spread = m3plusEvidenceNumber(evidence, "spreadCentsP95P05", errors, { min: 0 });
  const iqr = m3plusEvidenceNumber(evidence, "iqrCents", errors, { min: 0 });
  const targetMidi = m3plusEvidenceNumber(evidence, "targetMidi", errors, { integer: true });
  if (totalFrames !== null && voicedFrames !== null && voicedFrames > totalFrames) {
    errors.push("m3plus-runtime-voiced-frame-count-exceeds-total");
  }
  if (totalFrames !== null && voicedFrames !== null && voicedRatio !== null) {
    const expectedRatio = totalFrames > 0 ? voicedFrames / totalFrames : 0;
    if (Math.abs(expectedRatio - voicedRatio) > 0.000001) {
      errors.push("m3plus-runtime-voiced-frame-ratio-inconsistent");
    }
  }
  const windowAvailable = windowStart !== null
    && windowEnd !== null
    && windowEnd > windowStart
    && totalFrames !== null
    && totalFrames > 0;
  if (evidence.windowAvailable !== windowAvailable) errors.push("m3plus-runtime-window-state-inconsistent");

  const expectedTargetMidi = !protectedMarkings.length
    && glissandoMarked
    && expectedScoreNote?.glissandoTargetMidi !== null
    ? expectedScoreNote.glissandoTargetMidi
    : expectedScoreNote?.midi;
  if (targetMidi !== expectedTargetMidi) errors.push("m3plus-runtime-target-midi-mismatch");
  if (medianMidi !== null && targetMidi !== null && centerError !== null) {
    const expectedError = (medianMidi - targetMidi) * 100;
    if (Math.abs(expectedError - centerError) > 0.0001) {
      errors.push("m3plus-runtime-center-error-inconsistent");
    }
  } else if ((medianMidi === null || targetMidi === null) && centerError !== null) {
    errors.push("m3plus-runtime-center-error-without-input");
  }

  const highDispersion = Boolean(
    (spread !== null && spread > M3PLUS_RUNTIME_THRESHOLDS.maxSpreadCentsP95P05)
    || (iqr !== null && iqr > M3PLUS_RUNTIME_THRESHOLDS.maxIqrCents)
  );
  let expectedZone = protectedMarkings.length ? "score_marked_neutral" : "stable_center";
  let expectedWindowKind = "stable-center";
  if (!protectedMarkings.length && glissandoMarked) {
    expectedZone = "glissando_target_tail";
    expectedWindowKind = "glissando-target-tail";
  }
  let expectedDecision = "insufficient_evidence";
  let expectedReason = "pitch-safety-evidence-not-ready";
  if (protectedMarkings.length) {
    expectedReason = "score-marked-region-neutralized";
  } else if (expectedScoreNote?.polyphonicScoreRegion) {
    expectedZone = "multi_f0_review_only";
    expectedReason = "polyphonic-score-region-requires-multi-f0";
  } else if (glissandoMarked && expectedScoreNote?.glissandoTargetMidi === null) {
    expectedReason = "glissando-target-unavailable";
  } else if (evidence.timingAssignmentAvailable !== true) {
    expectedReason = "timing-assignment-missing";
  } else if (!windowAvailable) {
    expectedReason = "pitch-window-missing";
  } else if (totalFrames < M3PLUS_RUNTIME_THRESHOLDS.minTotalFrameCount) {
    expectedReason = "pitch-window-frame-count-below-floor";
  } else if (voicedFrames < M3PLUS_RUNTIME_THRESHOLDS.minVoicedFrameCount) {
    expectedReason = "voiced-frame-count-below-floor";
  } else if (voicedRatio === null || voicedRatio < M3PLUS_RUNTIME_THRESHOLDS.minVoicedFrameRatio) {
    expectedReason = "voiced-frame-ratio-below-floor";
  } else if (medianMidi === null) {
    expectedReason = "center-pitch-missing";
  } else if (spread === null || iqr === null) {
    expectedReason = "pitch-dispersion-missing";
  } else if (highDispersion) {
    expectedReason = "pitch-dispersion-too-high";
  } else if (centerError === null) {
    expectedReason = "center-pitch-error-missing";
  } else if (Math.abs(centerError) > M3PLUS_RUNTIME_THRESHOLDS.pitchToleranceCents) {
    expectedDecision = "issue_detected";
    expectedReason = "center-pitch-outside-tolerance";
  } else {
    expectedDecision = "confirmed_center";
    expectedReason = "center-pitch-within-tolerance";
  }
  if (evidence.zone !== expectedZone
      || evidence.analysisWindowKind !== expectedWindowKind
      || evidence.decision !== expectedDecision
      || evidence.reason !== expectedReason
      || evidence.accusationIssued !== (expectedDecision === "issue_detected")
      || evidence.highDispersion !== highDispersion) {
    errors.push("m3plus-runtime-policy-decision-mismatch");
  }
  const contractValid = errors.length === 0;
  return {
    contractValid,
    evaluationContract: M3PLUS_EVALUATION_CONTRACT,
    runtimeContract: M3PLUS_RUNTIME_CONTRACT,
    policyVersion: M3PLUS_RUNTIME_POLICY_VERSION,
    policySemanticSha256: M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256,
    zone: contractValid ? expectedZone : "unknown",
    decision: contractValid ? expectedDecision : "insufficient_evidence",
    reason: contractValid ? expectedReason : "m3plus-runtime-evidence-invalid",
    accusationIssued: contractValid && expectedDecision === "issue_detected",
    highDispersion: contractValid && highDispersion,
    reviewOnly: true,
    feedbackAuthorized: false,
    studentFacing: false,
    blockingReasons: [...new Set(errors)],
  };
}

export function buildM3PlusPitchSafetyReviewRuntime(candidateRows = [], {
  scoreVerification = null,
  runtimeBindings = null,
} = {}) {
  const inputRows = Array.isArray(candidateRows) ? candidateRows : [];
  const expectedRows = Array.isArray(scoreVerification?.expectedM3PlusNotes)
    ? scoreVerification.expectedM3PlusNotes
    : [];
  const candidateIdentityRows = buildCandidateM3PlusNoteIdentityRows(inputRows);
  const expectedIdentitySha256 = noteIdentityRowsSha256(expectedRows);
  const candidateIdentitySha256 = noteIdentityRowsSha256(candidateIdentityRows);
  const scoreSafetyIdentityReady = scoreVerification?.verified === true
    && inputRows.length > 0
    && inputRows.length === expectedRows.length
    && canonicalJson(candidateIdentityRows) === canonicalJson(expectedRows)
    && expectedIdentitySha256 === candidateIdentitySha256;
  const rows = inputRows.map((candidate, index) => ({
    ...candidate,
    m3plusPitchSafetyDecision: evaluateM3PlusRuntimeEvidence(candidate, expectedRows[index]),
    feedbackAuthorized: false,
    studentFacing: false,
  }));
  const validEvidenceCount = rows.filter((row) => row.m3plusPitchSafetyDecision.contractValid).length;
  const invalidEvidenceCount = rows.length - validEvidenceCount;
  const runtimeEvidenceReady = rows.length > 0
    && invalidEvidenceCount === 0
    && scoreSafetyIdentityReady
    && runtimeBindings?.ready === true;
  const decisionCounts = {};
  const zoneCounts = {};
  for (const row of rows) {
    const evidence = row.m3plusPitchSafetyEvidence || {};
    const decision = safeString(evidence.decision, "unknown");
    const zone = safeString(evidence.zone, "unknown");
    decisionCounts[decision] = (decisionCounts[decision] || 0) + 1;
    zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;
  }
  const blockingReasons = [
    "m3plus-runtime-review-only",
    "m3plus-runtime-authorization-closed",
    !scoreSafetyIdentityReady ? "m3plus-runtime-score-safety-identity-mismatch" : "",
    invalidEvidenceCount > 0 ? "m3plus-runtime-candidate-evidence-invalid" : "",
    ...(runtimeBindings?.blockingReasons || []),
  ].filter(Boolean);
  return {
    rows,
    gate: {
      evaluationContract: M3PLUS_EVALUATION_CONTRACT,
      runtimeContract: M3PLUS_RUNTIME_CONTRACT,
      policyVersion: M3PLUS_RUNTIME_POLICY_VERSION,
      policySemanticSha256: M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256,
      policyArtifactPath: runtimeBindings?.policyArtifactPath || M3PLUS_RUNTIME_POLICY_SOURCE,
      policyArtifactSha256: runtimeBindings?.policyArtifactSha256 || "",
      policyArtifactSemanticSha256: runtimeBindings?.policyArtifactSemanticSha256 || "",
      analyzerArtifactPath: runtimeBindings?.analyzerArtifactPath || M3PLUS_ANALYZER_SOURCE,
      analyzerArtifactSha256: runtimeBindings?.analyzerArtifactSha256 || "",
      analyzerArtifactSemanticSha256: runtimeBindings?.analyzerArtifactSemanticSha256 || "",
      pyinRuntime: runtimeBindings?.pyinRuntime || { ...M3PLUS_PYIN_RUNTIME_DESCRIPTOR },
      f0Backend: M3PLUS_F0_BACKEND,
      thresholds: { ...M3PLUS_RUNTIME_THRESHOLDS },
      reviewOnlyRuntimeWired: runtimeEvidenceReady,
      runtimeFoundationReady: runtimeEvidenceReady,
      runtimeEvidenceReady,
      contractReady: runtimeEvidenceReady,
      reviewOnly: true,
      feedbackAuthorized: false,
      authorizationReady: false,
      studentGateReady: false,
      studentFacing: false,
      automaticAdoptionReady: false,
      rescopeReportPath: runtimeBindings?.rescopeReportPath || "",
      rescopeReportSha256: runtimeBindings?.rescopeReportSha256 || "",
      rescopeReleaseGateReady: runtimeBindings?.rescopeReleaseGateReady === true,
      expectedScoreNoteCount: expectedRows.length,
      evaluatedCandidateCount: rows.length,
      validEvidenceCount,
      invalidEvidenceCount,
      scoreSafetyIdentityReady,
      scoreSafetyIdentitySha256: expectedIdentitySha256,
      candidateScoreSafetyIdentitySha256: candidateIdentitySha256,
      decisionCounts,
      zoneCounts,
      blockingReasons: [...new Set(blockingReasons)],
    },
  };
}

function dynamicShadowNumber(evidence, key, errors, { min = null, max = null } = {}) {
  if (!Object.hasOwn(evidence, key)) {
    errors.push(`dynamic-shadow-field-missing:${key}`);
    return null;
  }
  if (evidence[key] === null) return null;
  const value = evidence[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`dynamic-shadow-field-not-finite:${key}`);
    return null;
  }
  if (min !== null && value < min) errors.push(`dynamic-shadow-field-below-minimum:${key}`);
  if (max !== null && value > max) errors.push(`dynamic-shadow-field-above-maximum:${key}`);
  return value;
}

function evaluateDynamicShadowEvidence(candidate = {}) {
  const evidence = candidate?.dynamicShadowEvidence;
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      contractVersion: ORDINARY_DYNAMIC_SHADOW_CONTRACT_VERSION,
      policyVersion: ORDINARY_DYNAMIC_SHADOW_POLICY_VERSION,
      timingMode: ORDINARY_DYNAMIC_SHADOW_TIMING_MODE,
      decision: "shadow_invalid",
      selected: false,
      authorization: "telemetry_only",
      contractValid: false,
      blockingReasons: ["dynamic-shadow-evidence-missing"],
      features: null,
      energyVetoIncluded: false,
      causalEnergyStatus: ORDINARY_DYNAMIC_SHADOW_CAUSAL_ENERGY_STATUS,
    };
  }

  const contractVersion = safeString(evidence.contractVersion).trim();
  const policyVersion = safeString(evidence.policyVersion).trim();
  const timingMode = safeString(evidence.timingMode).trim();
  if (contractVersion !== ORDINARY_DYNAMIC_SHADOW_CONTRACT_VERSION) {
    errors.push("dynamic-shadow-contract-version-mismatch");
  }
  if (policyVersion !== ORDINARY_DYNAMIC_SHADOW_POLICY_VERSION) {
    errors.push("dynamic-shadow-policy-version-mismatch");
  }
  if (timingMode !== ORDINARY_DYNAMIC_SHADOW_TIMING_MODE) {
    errors.push("dynamic-shadow-timing-mode-mismatch");
  }
  if (typeof evidence.selected !== "boolean") {
    errors.push("dynamic-shadow-selected-not-boolean");
  }

  const sourceBlockingReasons = Array.isArray(evidence.blockingReasons)
    ? evidence.blockingReasons.filter((reason) => typeof reason === "string").map((reason) => reason.trim()).filter(Boolean)
    : [];
  if (!Array.isArray(evidence.blockingReasons)
      || sourceBlockingReasons.length !== evidence.blockingReasons.length) {
    errors.push("dynamic-shadow-blocking-reasons-malformed");
  }

  const features = {
    pitchDistanceSemitones: dynamicShadowNumber(evidence, "pitchDistanceSemitones", errors, { min: 0 }),
    eventConfidence: dynamicShadowNumber(evidence, "eventConfidence", errors, { min: 0, max: 1 }),
    relativeIoiDeviationRatio: dynamicShadowNumber(evidence, "relativeIoiDeviationRatio", errors, { min: 0 }),
    relativeEventConfidence: dynamicShadowNumber(evidence, "relativeEventConfidence", errors, { min: 0 }),
    eventDurationSeconds: dynamicShadowNumber(evidence, "eventDurationSeconds", errors, { min: 0 }),
    nearestSamePitchScoreDistanceQuarters: dynamicShadowNumber(
      evidence,
      "nearestSamePitchScoreDistanceQuarters",
      errors,
      { min: 0 },
    ),
    expectedDurationSeconds: dynamicShadowNumber(evidence, "expectedDurationSeconds", errors, { min: 0 }),
    eventDurationRatio: dynamicShadowNumber(evidence, "eventDurationRatio", errors, { min: 0 }),
  };
  if (features.expectedDurationSeconds === 0) {
    errors.push("dynamic-shadow-expected-duration-not-positive");
  }
  if (evidence.energyVetoIncluded !== false) {
    errors.push("dynamic-shadow-energy-veto-state-invalid");
  }
  if (evidence.causalEnergyStatus !== ORDINARY_DYNAMIC_SHADOW_CAUSAL_ENERGY_STATUS) {
    errors.push("dynamic-shadow-causal-energy-status-invalid");
  }
  if (features.eventDurationRatio !== null
      && (features.eventDurationSeconds === null || features.expectedDurationSeconds === null)) {
    errors.push("dynamic-shadow-duration-ratio-input-missing");
  }
  if (features.eventDurationRatio !== null
      && features.eventDurationSeconds !== null
      && features.expectedDurationSeconds !== null
      && features.expectedDurationSeconds > 0) {
    const expectedRatio = features.eventDurationSeconds / Math.max(0.15, features.expectedDurationSeconds);
    if (Math.abs(features.eventDurationRatio - expectedRatio) > 0.001) {
      errors.push("dynamic-shadow-duration-ratio-inconsistent");
    }
  }

  const policySelected = features.pitchDistanceSemitones === 0
    && features.eventConfidence !== null
    && features.eventConfidence >= ORDINARY_DYNAMIC_SHADOW_POLICY.minEventConfidence
    && features.relativeIoiDeviationRatio !== null
    && features.relativeIoiDeviationRatio <= ORDINARY_DYNAMIC_SHADOW_POLICY.deviationLimit
    && features.relativeEventConfidence !== null
    && features.relativeEventConfidence >= ORDINARY_DYNAMIC_SHADOW_POLICY.minRelativeEventConfidence
    && features.eventDurationSeconds !== null
    && features.eventDurationSeconds >= ORDINARY_DYNAMIC_SHADOW_POLICY.minEventDurationSeconds
    && features.expectedDurationSeconds !== null
    && features.expectedDurationSeconds > 0
    && features.eventDurationRatio !== null
    && features.eventDurationRatio >= ORDINARY_DYNAMIC_SHADOW_POLICY.minEventDurationRatio
    && (
      features.nearestSamePitchScoreDistanceQuarters === null
      || features.nearestSamePitchScoreDistanceQuarters >= ORDINARY_DYNAMIC_SHADOW_POLICY.minSamePitchScoreDistanceQuarters
    );
  if (typeof evidence.selected === "boolean" && evidence.selected !== policySelected) {
    errors.push("dynamic-shadow-selected-policy-mismatch");
  }
  if (evidence.selected === true && sourceBlockingReasons.length > 0) {
    errors.push("dynamic-shadow-selected-has-blocking-reasons");
  }
  if (evidence.selected === false && sourceBlockingReasons.length === 0) {
    errors.push("dynamic-shadow-rejected-without-blocking-reason");
  }

  const contractValid = errors.length === 0;
  const selected = contractValid && evidence.selected === true;
  return {
    contractVersion: contractVersion || ORDINARY_DYNAMIC_SHADOW_CONTRACT_VERSION,
    policyVersion: policyVersion || ORDINARY_DYNAMIC_SHADOW_POLICY_VERSION,
    timingMode: timingMode || ORDINARY_DYNAMIC_SHADOW_TIMING_MODE,
    decision: contractValid ? (selected ? "shadow_selected" : "shadow_rejected") : "shadow_invalid",
    selected,
    authorization: "telemetry_only",
    contractValid,
    blockingReasons: [...new Set(contractValid ? sourceBlockingReasons : [...sourceBlockingReasons, ...errors])],
    features,
    energyVetoIncluded: false,
    causalEnergyStatus: ORDINARY_DYNAMIC_SHADOW_CAUSAL_ENERGY_STATUS,
  };
}

function buildRfTelemetry(candidateGate = {}) {
  return {
    mode: safeString(candidateGate.mode, "review_only"),
    evaluated: candidateGate.mode === "confidence_rf",
    authorizationIgnored: true,
    ready: candidateGate.ready === true,
    gateVersion: safeString(candidateGate.gateVersion),
    modelVersion: safeString(candidateGate.modelVersion),
    threshold: candidateGate.threshold ?? null,
    evaluatedCandidateCount: Math.max(0, Math.round(safeNumber(candidateGate.evaluatedCandidateCount, 0))),
    modelSelectedCandidateCount: Math.max(0, Math.round(safeNumber(candidateGate.modelAutoPassCandidateCount, 0))),
    scopedSelectedCandidateCount: Math.max(0, Math.round(safeNumber(candidateGate.autoPassCandidateCount, 0))),
  };
}

function evaluateBasicPitchCacheProvenance(
  provenance,
  expectedAudioSha256 = "",
  artifactVerification = null,
) {
  const errors = [];
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return {
      ready: false,
      blockingReasons: ["ordinary-upload-basic-pitch-cache-provenance-missing"],
      value: null,
    };
  }
  const audioSha256 = safeString(provenance.audioSha256).trim().toLowerCase();
  const modelVersion = safeString(provenance.modelVersion).trim();
  const modelArtifactSha256 = safeString(provenance.modelArtifactSha256).trim().toLowerCase();
  const inferenceVersion = safeString(provenance.inferenceVersion).trim();
  const policyVersion = safeString(provenance.policyVersion).trim();
  const runtimeId = safeString(provenance.runtimeId).trim();
  const runtimeConfigSemanticSha256 = safeString(provenance.runtimeConfigSemanticSha256).trim().toLowerCase();
  const runtimeRequirementsLockSha256 = safeString(provenance.runtimeRequirementsLockSha256).trim().toLowerCase();
  const cachePath = safeString(provenance.cachePath).trim().replace(/\\/g, "/");
  const cacheArtifactSha256 = safeString(provenance.cacheArtifactSha256).trim().toLowerCase();
  const expectedAudio = safeString(expectedAudioSha256).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(audioSha256)) {
    errors.push("ordinary-upload-basic-pitch-audio-sha-invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedAudio)) {
    errors.push("ordinary-upload-basic-pitch-expected-audio-sha-invalid");
  } else if (audioSha256 !== expectedAudio) {
    errors.push("ordinary-upload-basic-pitch-audio-sha-mismatch");
  }
  if (modelVersion !== ORDINARY_DYNAMIC_SHADOW_MODEL_VERSION) {
    errors.push("ordinary-upload-basic-pitch-model-version-mismatch");
  }
  if (modelArtifactSha256 !== ORDINARY_DYNAMIC_SHADOW_MODEL_ARTIFACT_SHA256) {
    errors.push("ordinary-upload-basic-pitch-model-artifact-mismatch");
  }
  if (inferenceVersion !== ORDINARY_DYNAMIC_SHADOW_INFERENCE_VERSION) {
    errors.push("ordinary-upload-basic-pitch-inference-version-mismatch");
  }
  if (policyVersion !== ORDINARY_DYNAMIC_SHADOW_POLICY_VERSION) {
    errors.push("ordinary-upload-basic-pitch-policy-version-mismatch");
  }
  if (runtimeId !== ORDINARY_AUDIO_RUNTIME_ID
      || runtimeConfigSemanticSha256 !== ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256
      || runtimeRequirementsLockSha256 !== ORDINARY_AUDIO_RUNTIME_LOCK_SHA256) {
    errors.push("ordinary-upload-basic-pitch-runtime-identity-mismatch");
  }
  if (provenance.cacheSource !== "content-addressed-cache") {
    errors.push("ordinary-upload-basic-pitch-cache-source-invalid");
  }
  if (typeof provenance.cacheHit !== "boolean") {
    errors.push("ordinary-upload-basic-pitch-cache-hit-invalid");
  }
  if (provenance.identityBound !== true) {
    errors.push("ordinary-upload-basic-pitch-cache-identity-unbound");
  }
  if (!/^[a-f0-9]{64}$/.test(cacheArtifactSha256)) {
    errors.push("ordinary-upload-basic-pitch-cache-artifact-sha-invalid");
  }
  const expectedCachePrefix = `${ORDINARY_DYNAMIC_SHADOW_CACHE_ROOT}${audioSha256}-`;
  if (!cachePath
      || path.isAbsolute(cachePath)
      || cachePath.includes("../")
      || !cachePath.startsWith(expectedCachePrefix)
      || !cachePath.endsWith(".basic-pitch.json")) {
    errors.push("ordinary-upload-basic-pitch-cache-path-invalid");
  }
  if (artifactVerification?.verified !== true) {
    errors.push("ordinary-upload-basic-pitch-cache-artifact-not-verified");
    errors.push(...(artifactVerification?.blockingReasons || []));
  }
  return {
    ready: errors.length === 0,
    blockingReasons: [...new Set(errors)],
    value: {
      audioSha256,
      modelVersion,
      modelArtifactSha256,
      inferenceVersion,
      policyVersion,
      runtimeId,
      runtimeConfigSemanticSha256,
      runtimeRequirementsLockSha256,
      cachePath,
      cacheArtifactSha256,
      cacheHit: provenance.cacheHit === true,
      cacheSource: safeString(provenance.cacheSource),
      identityBound: provenance.identityBound === true,
    },
  };
}

function evaluateOrdinaryAudioRuntimeAttestation(attestation) {
  const value = attestation && typeof attestation === "object" && !Array.isArray(attestation)
    ? {
        ready: attestation.ready === true,
        runtimeId: safeString(attestation.runtimeId).trim(),
        configSemanticSha256: safeString(attestation.configSemanticSha256).trim().toLowerCase(),
        requirementsLockSha256: safeString(attestation.requirementsLockSha256).trim().toLowerCase(),
        modelArtifactSha256: safeString(attestation.modelArtifactSha256).trim().toLowerCase(),
        studentFacing: attestation.studentFacing,
        automaticAdoptionAuthorized: attestation.automaticAdoptionAuthorized,
      }
    : null;
  const verified = value?.ready === true
    && value.runtimeId === ORDINARY_AUDIO_RUNTIME_ID
    && value.configSemanticSha256 === ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256
    && value.requirementsLockSha256 === ORDINARY_AUDIO_RUNTIME_LOCK_SHA256
    && value.modelArtifactSha256 === ORDINARY_DYNAMIC_SHADOW_MODEL_ARTIFACT_SHA256
    && value.studentFacing === false
    && value.automaticAdoptionAuthorized === false;
  return {
    verified,
    blockingReasons: verified ? [] : ["ordinary-upload-audio-runtime-attestation-invalid"],
    value,
  };
}

export function buildOrdinaryDynamicShadowReviewGate(
  candidateRows = [],
  rfCandidateGate = {},
  {
    basicPitchCacheProvenance = null,
    expectedAudioSha256 = "",
    cacheArtifactVerification = null,
    scoreVerification = null,
    runtimeAttestationVerification = null,
  } = {},
) {
  const cacheProvenance = evaluateBasicPitchCacheProvenance(
    basicPitchCacheProvenance,
    expectedAudioSha256,
    cacheArtifactVerification,
  );
  const inputRows = Array.isArray(candidateRows) ? candidateRows : [];
  const expectedScoreNoteCount = Number(scoreVerification?.value?.noteCount);
  const expectedScoreNotes = Array.isArray(scoreVerification?.expectedNotes)
    ? scoreVerification.expectedNotes
    : [];
  const candidateNoteIdentities = buildCandidateNoteIdentityRows(inputRows);
  const candidateNoteIdentitySha256 = noteIdentityRowsSha256(candidateNoteIdentities);
  const scoreNoteIdentitySha256 = safeString(scoreVerification?.value?.noteIdentitySha256).trim().toLowerCase();
  const scoreNoteIdentityReady = scoreVerification?.verified === true
    && expectedScoreNoteCount > 0
    && /^[a-f0-9]{64}$/.test(scoreNoteIdentitySha256)
    && expectedScoreNotes.length === expectedScoreNoteCount
    && candidateNoteIdentities.length === expectedScoreNotes.length
    && candidateNoteIdentities.every((candidate, index) => (
      candidate.noteIndex === index
      && candidate.noteIndex === expectedScoreNotes[index]?.noteIndex
      && candidate.noteId !== ""
      && candidate.noteId === expectedScoreNotes[index]?.noteId
      && candidate.sectionId !== ""
      && candidate.sectionId === expectedScoreNotes[index]?.sectionId
      && candidate.measureIndex === expectedScoreNotes[index]?.measureIndex
      && candidate.midi === expectedScoreNotes[index]?.midi
    ))
    && candidateNoteIdentitySha256 === scoreNoteIdentitySha256;
  const completeScoreCoverage = Number.isInteger(expectedScoreNoteCount)
    && expectedScoreNoteCount > 0
    && inputRows.length === expectedScoreNoteCount
    && scoreNoteIdentityReady;
  const rows = inputRows.map((candidate) => {
    const dynamicShadowDecision = evaluateDynamicShadowEvidence(candidate);
    const gateReason = dynamicShadowDecision.contractValid
      && cacheProvenance.ready
      && scoreVerification?.verified === true
      && runtimeAttestationVerification?.verified === true
      && completeScoreCoverage
      ? "ordinary-upload-dynamic-shadow-review-only"
      : "ordinary-upload-dynamic-shadow-evidence-invalid";
    return {
      ...candidate,
      dynamicShadowDecision,
      autoDecision: "review_required",
      confidenceScore: 0,
      gateDecision: "review_required",
      gateReason,
      gateVersion: ORDINARY_DYNAMIC_SHADOW_GATE_VERSION,
      reviewRequiredReason: gateReason,
      studentSafeGateReady: false,
      studentFacing: false,
    };
  });
  const validEvidenceCount = rows.filter((candidate) => candidate.dynamicShadowDecision.contractValid).length;
  const shadowSelectedCandidateCount = rows.filter((candidate) => candidate.dynamicShadowDecision.selected).length;
  const invalidEvidenceCount = rows.length - validEvidenceCount;
  const contractReady = rows.length > 0
    && invalidEvidenceCount === 0
    && cacheProvenance.ready
    && scoreVerification?.verified === true
    && runtimeAttestationVerification?.verified === true
    && completeScoreCoverage;
  const blockingReasons = [
    "ordinary-upload-dynamic-shadow-review-only",
    "ordinary-upload-dynamic-shadow-energy-veto-not-included",
    !contractReady ? "ordinary-upload-dynamic-shadow-evidence-invalid" : "",
    ...cacheProvenance.blockingReasons,
    ...(scoreVerification?.verified === true
      ? []
      : [
          "ordinary-upload-score-provenance-not-verified",
          ...(scoreVerification?.blockingReasons || []),
        ]),
    !completeScoreCoverage ? "ordinary-upload-dynamic-shadow-incomplete-score-coverage" : "",
    !scoreNoteIdentityReady ? "ordinary-upload-dynamic-shadow-score-note-identity-mismatch" : "",
    ...(runtimeAttestationVerification?.verified === true
      ? []
      : (runtimeAttestationVerification?.blockingReasons || ["ordinary-upload-audio-runtime-attestation-invalid"])),
  ].filter(Boolean);
  return {
    rows,
    gate: {
      gateVersion: ORDINARY_DYNAMIC_SHADOW_GATE_VERSION,
      ready: false,
      authorizationReady: false,
      automaticAdoptionAuthorized: false,
      studentSafeGateReady: false,
      studentFacing: false,
      mode: "dynamic_shadow_review_only",
      reason: !contractReady
        ? "ordinary-upload-dynamic-shadow-evidence-invalid"
        : "ordinary-upload-dynamic-shadow-review-only",
      blockingReasons,
      evaluatedCandidateCount: rows.length,
      autoPassCandidateCount: 0,
      reviewRequiredCandidateCount: rows.length,
      contractVersion: ORDINARY_DYNAMIC_SHADOW_CONTRACT_VERSION,
      policyVersion: ORDINARY_DYNAMIC_SHADOW_POLICY_VERSION,
      timingMode: ORDINARY_DYNAMIC_SHADOW_TIMING_MODE,
      policy: { ...ORDINARY_DYNAMIC_SHADOW_POLICY },
      contractReady,
      validEvidenceCount,
      invalidEvidenceCount,
      shadowSelectedCandidateCount,
      cacheProvenanceReady: cacheProvenance.ready,
      cacheArtifactVerified: cacheArtifactVerification?.verified === true,
      basicPitchCacheProvenance: cacheProvenance.value,
      scoreProvenanceReady: scoreVerification?.verified === true,
      scoreProvenance: scoreVerification?.value || null,
      expectedScoreNoteCount: Number.isInteger(expectedScoreNoteCount) ? expectedScoreNoteCount : 0,
      completeScoreCoverage,
      scoreNoteIdentityReady,
      scoreNoteIdentitySha256,
      candidateNoteIdentitySha256,
      runtimeAttestationReady: runtimeAttestationVerification?.verified === true,
      runtimeAttestation: runtimeAttestationVerification?.value || null,
      energyVetoIncluded: false,
      causalEnergyStatus: ORDINARY_DYNAMIC_SHADOW_CAUSAL_ENERGY_STATUS,
      rfTelemetry: buildRfTelemetry(rfCandidateGate),
      allowedDiagnosticCategories: [],
      reviewOnlyDiagnosticCategories: ["candidate-evidence", "pitch", "onset", "missing", "duration", "extra"],
    },
  };
}

function ordinaryUploadConfidenceGateEnabled() {
  return ["1", "true", "yes", "on"].includes(safeString(process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE).trim().toLowerCase());
}

function ordinaryUploadConfidenceReleasePath() {
  const override = safeString(process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE).trim();
  return override ? path.resolve(override) : OFFLINE_FEATURE_CONFIDENCE_RELEASE_PATH;
}

export function applyOrdinaryControlledPilotScope(scoredRows = [], release = {}) {
  const configuredScope = release?.runtimePolicy?.controlledPilotScope || {};
  const maxMeasureIndex = safeNumber(configuredScope.maxMeasureIndex, 0);
  const minConfidence = safeNumber(configuredScope.minConfidence, 0);
  const scopeEnabled = maxMeasureIndex > 0 && minConfidence > 0;
  const rows = (Array.isArray(scoredRows) ? scoredRows : []).map((candidate) => {
    const measureIndex = safeNumber(candidate.measureIndex, 0);
    const confidenceProbability = safeNumber(candidate.confidenceProbability, 0);
    const withinMeasureScope = !scopeEnabled || (measureIndex > 0 && measureIndex <= maxMeasureIndex);
    const passesScopeConfidence = !scopeEnabled || confidenceProbability >= minConfidence;
    const controlledPilotScopeSelected = candidate.confidenceSelected === true
      && withinMeasureScope
      && passesScopeConfidence;
    const controlledPilotScopeReason = controlledPilotScopeSelected
      ? ""
      : !withinMeasureScope
        ? "ordinary-upload-outside-controlled-pilot-measure-scope"
        : !passesScopeConfidence
          ? "ordinary-upload-below-controlled-pilot-confidence"
          : "ordinary-upload-confidence-gate-review-required";
    return {
      ...candidate,
      controlledPilotScopeSelected,
      controlledPilotScopeReason,
    };
  });
  const modelAutoPassCandidateCount = rows.filter((candidate) => candidate.confidenceSelected === true).length;
  const autoPassCandidateCount = rows.filter((candidate) => candidate.controlledPilotScopeSelected === true).length;
  const pilotScopeCandidateCount = rows.filter((candidate) => {
    const measureIndex = safeNumber(candidate.measureIndex, 0);
    return !scopeEnabled || (measureIndex > 0 && measureIndex <= maxMeasureIndex);
  }).length;
  return {
    rows,
    modelAutoPassCandidateCount,
    autoPassCandidateCount,
    controlledPilotScope: scopeEnabled ? {
      scopeName: safeString(configuredScope.scopeName, "first-measure-only"),
      maxMeasureIndex,
      minConfidence,
      pilotScopeCandidateCount,
      scopeCoverage: pilotScopeCandidateCount > 0 ? autoPassCandidateCount / pilotScopeCandidateCount : 0,
    } : null,
  };
}

function controlledCandidateRuntimeConfidenceDir(repoRoot, batchRunId) {
  return path.join(
    repoRoot,
    "data",
    "experiments",
    "western-strings-m3",
    "runtime-confidence",
    safeString(batchRunId, "unknown-batch"),
  );
}

async function writeControlledCandidateRuntimeConfidenceInput(repoRoot, {
  batchRunId = "",
  submission = {},
  candidateRows = [],
}) {
  const safeSubmissionId = safeString(submission.submissionId, "unknown-submission").replace(/[^A-Za-z0-9_.-]/g, "_");
  const outPath = path.join(controlledCandidateRuntimeConfidenceDir(repoRoot, batchRunId), `${safeSubmissionId}.input.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify({
    context: {
      batchRunId: safeString(batchRunId),
      submissionId: safeString(submission.submissionId),
      scoreId: safeString(submission.scoreId),
      dataset: safeString(submission.dataset),
      piece: safeString(submission.piece),
      recordingId: safeString(submission.recordingId),
      instrument: safeString(submission.instrument),
    },
    candidateRows: Array.isArray(candidateRows) ? candidateRows : [],
  }, null, 2)}\n`, "utf8");
  return outPath;
}

function buildOfflineFeatureReviewOnlyGate(candidateRows = [], {
  reason = "ordinary-upload-student-safe-gate-not-calibrated",
  blockingReasons = null,
  gateVersion = OFFLINE_FEATURE_STUDENT_GATE_VERSION,
} = {}) {
  const evaluatedCandidateCount = Array.isArray(candidateRows) ? candidateRows.length : 0;
  const reasons = Array.isArray(blockingReasons) && blockingReasons.length ? blockingReasons : [reason];
  return {
    gateVersion,
    ready: false,
    mode: "review_only",
    reason,
    blockingReasons: reasons,
    evaluatedCandidateCount,
    autoPassCandidateCount: 0,
    reviewRequiredCandidateCount: evaluatedCandidateCount,
    allowedDiagnosticCategories: [],
    reviewOnlyDiagnosticCategories: ["pitch", "onset", "missing", "duration", "extra"],
  };
}

async function scoreOfflineFeatureCandidateRows(repoRoot, candidateRows, submission, release, { batchRunId = "" } = {}) {
  const inputPath = await writeControlledCandidateRuntimeConfidenceInput(repoRoot, {
    batchRunId,
    submission,
    candidateRows,
  });
  const scriptPath = path.join(SOURCE_ROOT, "scripts", "experiments", "score_western_controlled_candidate_confidence.py");
  const runnerPath = path.join(SOURCE_ROOT, "scripts", "run-python.ps1");
  const labelsPath = resolveRepoPath(repoRoot, release?.trainingLabels?.source || release?.labels?.source)
    || path.join(repoRoot, "data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv");
  const pilotPath = resolveRepoPath(repoRoot, release?.pilot?.source)
    || path.join(repoRoot, "data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-confidence-pilot.json");
  const validationPath = resolveRepoPath(repoRoot, release?.blindValidation?.source)
    || path.join(repoRoot, "data", "experiments", "western-strings-m3", "confidence-validation-review", "confidence-validation-eval.json");
  const args = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    runnerPath,
    scriptPath,
    "--input",
    inputPath,
    "--labels",
    labelsPath,
    "--pilot-json",
    pilotPath,
    "--validation-json",
    validationPath,
    "--require-validation-pass",
  ];
  const modelName = safeString(release?.modelName).trim();
  if (modelName) args.push("--model", modelName);
  const threshold = Number(release?.threshold);
  if (Number.isFinite(threshold)) args.push("--threshold", String(threshold));
  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    cwd: SOURCE_ROOT,
    timeout: Math.max(10000, Math.round(safeNumber(process.env.WESTERN_STRINGS_CONFIDENCE_SCORER_TIMEOUT_MS, 120000))),
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ERHU_CPU_THREAD_LIMIT: process.env.ERHU_CPU_THREAD_LIMIT || "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  const parsed = parseJsonFromStdout(stdout);
  if (!parsed) {
    throw new Error(`confidence scorer returned no JSON.${stderr ? ` stderr=${safeString(stderr).slice(0, 500)}` : ""}`);
  }
  return parsed;
}

async function readStudentGate(repoRoot) {
  const summaryPath = path.join(repoRoot, "data", "experiments", "western-strings-m2", "m2d-sequence-support-summary.json");
  try {
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    const ready = summary?.studentGateReady === true;
    return {
      ready,
      reason: ready ? "" : "student-gate-not-ready",
      source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
      strategy: "sequence-basic-pitch-support",
      supportFeature: summary?.supportFeature || {},
    };
  } catch {
    return {
      ready: false,
      reason: "student-gate-evidence-missing",
      source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
    };
  }
}

async function readRealStudentGate(repoRoot) {
  const summaryPath = path.join(repoRoot, "data", "experiments", "western-strings-m2", "m2f-real-student-recording-summary.json");
  const summary = await readJsonOrNull(summaryPath);
  const ready = summary?.studentGateReady === true && summary?.ok === true;
  return {
    ready,
    reason: ready ? "" : "real-student-gate-not-ready",
    source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
    summary: summary ? {
      autoPassCount: numberOrNull(summary?.results?.autoPassCount),
      correctWithin300ms: numberOrNull(summary?.results?.correctWithin300ms),
      unsafeTargetAutoPassCount: numberOrNull(summary?.results?.unsafeTargetAutoPassCount),
      precisionWithin300ms: numberOrNull(summary?.results?.precisionWithin300ms),
      recordings: numberOrNull(summary?.manifest?.recordings),
      students: numberOrNull(summary?.manifest?.students),
    } : null,
  };
}

async function readDiagnosisGate(repoRoot) {
  const summaryPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "m3-diagnosis-summary.json");
  const summary = await readJsonOrNull(summaryPath);
  const ready = summary?.diagnosisGateReady === true && summary?.ok === true;
  return {
    ready,
    reason: ready ? "" : "diagnosis-gate-not-ready",
    source: path.relative(repoRoot, summaryPath).replace(/\\/g, "/"),
    requiredCategories: Array.isArray(summary?.gate?.requiredCategories) ? summary.gate.requiredCategories.map((item) => safeString(item)).filter(Boolean) : [],
    reviewOnlyCategories: Array.isArray(summary?.gate?.reviewOnlyCategories) ? summary.gate.reviewOnlyCategories.map((item) => safeString(item)).filter(Boolean) : [],
    categories: summary?.categories || {},
    blockingReasons: Array.isArray(summary?.blockingReasons) ? summary.blockingReasons.map((item) => safeString(item)).filter(Boolean) : [],
  };
}

async function readDiagnosisRows(repoRoot) {
  const resultsPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "real-student-diagnosis-results.csv");
  try {
    return parseCsv(await fs.readFile(resultsPath, "utf8"));
  } catch {
    return [];
  }
}

function hasControlledSubmissionPayload(payload = {}) {
  return Boolean(
    safeString(payload?.scoreId).trim()
    || safeString(payload?.scorePhotoPath).trim()
    || safeString(payload?.audioPath).trim()
    || safeString(payload?.audioHash).trim()
    || safeString(payload?.audioSubmission?.name).trim()
  );
}

async function buildControlledSubmissionAnalysis(repoRoot, payload = {}) {
  const scoreId = safeString(payload.scoreId).trim();
  const scorePhotoPath = safeString(payload.scorePhotoPath).trim();
  const scorePhotoHash = safeString(payload.scorePhotoHash).trim();
  const audioHash = safeString(payload.audioHash).trim();
  const audioPath = safeString(payload.audioPath).trim();
  const hasAudio = Boolean(audioHash || audioPath || safeString(payload.audioSubmission?.name).trim());
  const isPhotoScore = Boolean(scorePhotoPath) && !scoreId;
  const blockingReasons = [
    scoreId || scorePhotoPath ? "" : "controlled-submission-missing-score",
    hasAudio ? "" : "controlled-submission-missing-audio",
    (scoreId || scorePhotoPath) && hasAudio
      ? (isPhotoScore ? "photo-score-requires-offline-pipeline" : "controlled-submission-requires-offline-analysis")
      : "",
  ].filter(Boolean);
  const submission = {
    submissionId: createId("strings-submit"),
    submittedAt: nowIso(),
    scoreId,
    kind: isPhotoScore ? "photo-score" : "clean-score",
    scorePhotoPath,
    scorePhotoHash,
    scorePhotoSubmission: payload.scorePhotoSubmission || null,
    dataset: safeString(payload.dataset).trim(),
    piece: safeString(payload.piece).trim(),
    pieceId: safeString(payload.pieceId).trim(),
    recordingId: safeString(payload.recordingId).trim(),
    instrument: safeString(payload.instrument).trim(),
    studentRef: safeString(payload.studentRef).trim(),
    limit: Math.max(0, Math.round(safeNumber(payload.limit, 20))),
    audioHash,
    audioPath,
    audioSubmission: payload.audioSubmission || null,
    status: "review_required",
    reason: blockingReasons[0]
      || (isPhotoScore ? "photo-score-requires-offline-pipeline" : "controlled-submission-requires-offline-analysis"),
  };
  const outPath = controlledSubmissionsPath(repoRoot);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(submission)}\n`, "utf8");
  return {
    ok: true,
    studentReady: false,
    submissionAccepted: true,
    blockingReasons,
    releaseGates: {},
    summary: {
      noteCount: 0,
      autoPassCount: 0,
      reviewRequiredCount: 0,
      coverage: 0,
      allowedDiagnosticCategories: [],
      reviewOnlyDiagnosticCategories: ["duration", "extra"],
    },
    decisions: [],
    recordingDiagnosis: null,
    submission,
  };
}

function latestReviewBySubmissionId(reviews) {
  const latest = new Map();
  for (const review of reviews) {
    const submissionId = safeString(review.submissionId).trim();
    if (!submissionId) continue;
    latest.set(submissionId, review);
  }
  return latest;
}

function decorateControlledSubmission(submission, latestReview = null, latestAnalysis = null) {
  const submissionId = safeString(submission.submissionId).trim();
  const reviewAction = safeString(latestReview?.action).trim();
  const kind = safeString(submission.kind, submission.scorePhotoPath ? "photo-score" : "clean-score");
  return {
    submissionId,
    submittedAt: safeString(submission.submittedAt),
    kind,
    scoreId: safeString(submission.scoreId),
    scorePhotoHash: safeString(submission.scorePhotoHash),
    scorePhotoSubmission: submission.scorePhotoSubmission || null,
    dataset: safeString(submission.dataset),
    piece: safeString(submission.piece),
    recordingId: safeString(submission.recordingId),
    instrument: safeString(submission.instrument),
    audioHash: safeString(submission.audioHash),
    audioSubmission: submission.audioSubmission || null,
    status: reviewAction || safeString(submission.status, "review_required"),
    reason: safeString(latestReview?.reason || submission.reason),
    latestReview: latestReview || null,
    latestAnalysis: latestAnalysis
      ? {
        batchRunId: safeString(latestAnalysis.batchRunId),
        createdAt: safeString(latestAnalysis.createdAt),
        analysisStatus: safeString(latestAnalysis.item?.analysisStatus),
        reviewAssist: latestAnalysis.item?.candidateGate?.reviewAssist || null,
        reviewAssistPreview: Array.isArray(latestAnalysis.item?.reviewAssistPreview)
          ? latestAnalysis.item.reviewAssistPreview
          : [],
        studentIssueCandidates: Array.isArray(latestAnalysis.item?.studentIssueCandidates)
          ? latestAnalysis.item.studentIssueCandidates
          : [],
      }
      : null,
    audioUrl: submissionId ? `/api/strings/controlled-submissions/${encodeURIComponent(submissionId)}/audio` : "",
    scorePhotoUrl: kind === "photo-score" && submissionId
      ? `/api/strings/controlled-submissions/${encodeURIComponent(submissionId)}/score-photo`
      : "",
  };
}

export async function listWesternControlledSubmissions({ repoRoot = process.cwd(), limit = 50 } = {}) {
  const [submissions, reviews, batchRuns] = await Promise.all([
    readJsonlRecords(controlledSubmissionsPath(repoRoot)),
    readJsonlRecords(controlledSubmissionReviewsPath(repoRoot)),
    readJsonlRecords(controlledSubmissionBatchRunsPath(repoRoot)),
  ]);
  const latest = latestReviewBySubmissionId(reviews);
  const latestAnalysis = new Map();
  for (const run of batchRuns) {
    for (const item of run?.items || []) {
      const submissionId = safeString(item?.submissionId).trim();
      if (submissionId) latestAnalysis.set(submissionId, {
        batchRunId: run.batchRunId,
        createdAt: run.createdAt,
        item,
      });
    }
  }
  const decorated = submissions
    .map((submission) => {
      const submissionId = safeString(submission.submissionId).trim();
      return decorateControlledSubmission(
        submission,
        latest.get(submissionId) || null,
        latestAnalysis.get(submissionId) || null,
      );
    })
    .filter((submission) => submission.submissionId)
    .sort((left, right) => safeString(right.submittedAt).localeCompare(safeString(left.submittedAt)));
  const capped = limit > 0 ? decorated.slice(0, limit) : decorated;
  const summary = {
    total: decorated.length,
    reviewRequired: decorated.filter((item) => item.status === "review_required").length,
    acceptedForBatch: decorated.filter((item) => item.status === "accepted_for_batch").length,
    rejected: decorated.filter((item) => item.status === "reject_unsupported").length,
    failed: decorated.filter((item) => item.status === "failed").length,
  };
  return {
    ok: true,
    source: path.relative(repoRoot, controlledSubmissionsPath(repoRoot)).replace(/\\/g, "/"),
    reviewSource: path.relative(repoRoot, controlledSubmissionReviewsPath(repoRoot)).replace(/\\/g, "/"),
    batchSource: path.relative(repoRoot, controlledSubmissionBatchRunsPath(repoRoot)).replace(/\\/g, "/"),
    summary,
    submissions: capped,
  };
}

export async function findWesternControlledSubmission({ repoRoot = process.cwd(), submissionId = "" } = {}) {
  const targetId = safeString(submissionId).trim();
  if (!targetId) return null;
  const submissions = await readJsonlRecords(controlledSubmissionsPath(repoRoot));
  return submissions.find((submission) => safeString(submission.submissionId).trim() === targetId) || null;
}

export async function recordWesternControlledSubmissionReview({ repoRoot = process.cwd(), payload = {} } = {}) {
  const submissionId = safeString(payload.submissionId).trim();
  const action = safeString(payload.action).trim();
  if (!submissionId) throw new Error("submissionId is required.");
  if (!["review_required", "accepted_for_batch", "reject_unsupported", "failed", "feedback_released"].includes(action)) {
    throw new Error("action must be review_required, accepted_for_batch, reject_unsupported, failed, or feedback_released.");
  }
  if (action === "feedback_released" && !safeString(payload.studentMessage).trim()) {
    throw new Error("feedback_released requires a studentMessage.");
  }
  const requestedStudentIssues = action === "feedback_released" && Array.isArray(payload.studentIssues)
    ? payload.studentIssues
    : [];
  if (requestedStudentIssues.length > 100) {
    throw new Error("feedback_released accepts at most 100 studentIssues.");
  }
  const studentIssues = action === "feedback_released"
    ? requestedStudentIssues
      .map((issue) => ({
        noteId: safeString(issue?.noteId).trim(),
        noteIndex: Math.round(safeNumber(issue?.noteIndex, -1)),
        category: safeString(issue?.category).trim(),
      }))
      .filter((issue) => (
        /^xml-m-?\d+-n\d+$/i.test(issue.noteId)
        && issue.noteIndex >= 0
        && STUDENT_SCORE_ISSUE_CATEGORIES.has(issue.category)
      ))
    : [];
  if (studentIssues.length !== requestedStudentIssues.length) {
    throw new Error("studentIssues must contain a score noteId, noteIndex, and supported category.");
  }
  const submission = await findWesternControlledSubmission({ repoRoot, submissionId });
  if (!submission) throw new Error("controlled submission not found.");
  const record = {
    submittedAt: nowIso(),
    submissionId,
    action,
    reason: safeString(payload.reason),
    reviewerId: safeString(payload.reviewerId, "reviewer-1"),
    comments: safeString(payload.comments),
    // Human-authored feedback for the student page; shown there only when the
    // reviewer explicitly releases it. Machine analysis never flows through.
    studentMessage: safeString(payload.studentMessage),
    releaseToStudent: payload.releaseToStudent === true,
    studentIssues,
  };
  const outPath = controlledSubmissionReviewsPath(repoRoot);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
  return { ok: true, review: record };
}

async function fileExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(targetPath) {
  const handle = await fs.open(targetPath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function buildBatchGateSnapshot(repoRoot) {
  const sequenceGate = await readStudentGate(repoRoot);
  const realStudentGate = await readRealStudentGate(repoRoot);
  const diagnosisGate = await readDiagnosisGate(repoRoot);
  const ready = sequenceGate.ready && realStudentGate.ready && diagnosisGate.ready;
  return {
    ready,
    sequenceGate: {
      ready: sequenceGate.ready,
      reason: sequenceGate.reason,
      source: sequenceGate.source,
    },
    realStudentGate: {
      ready: realStudentGate.ready,
      reason: realStudentGate.reason,
      source: realStudentGate.source,
    },
    diagnosisGate: {
      ready: diagnosisGate.ready,
      reason: diagnosisGate.reason,
      source: diagnosisGate.source,
      requiredCategories: diagnosisGate.requiredCategories,
      reviewOnlyCategories: diagnosisGate.reviewOnlyCategories,
    },
  };
}

async function buildControlledBatchItem(repoRoot, submission, gateSnapshot, {
  batchRunId = "",
  runPhotoScoreAnalysis = runOfflinePhotoScoreAnalyzer,
} = {}) {
  const audioPath = safeString(submission.audioPath).trim();
  const audioExists = await fileExists(audioPath);
  const scoreId = safeString(submission.scoreId).trim();
  const scorePhotoPath = safeString(submission.scorePhotoPath).trim();
  const scorePhotoExists = await fileExists(scorePhotoPath);
  const kind = safeString(submission.kind, scorePhotoPath && !scoreId ? "photo-score" : "clean-score");
  const dataset = safeString(submission.dataset).trim();
  const piece = safeString(submission.piece).trim();
  const recordingId = safeString(submission.recordingId).trim();
  const instrument = safeString(submission.instrument).trim();
  const isPhotoScore = kind === "photo-score";
  const blockingReasons = isPhotoScore
    ? [
      scorePhotoExists ? "" : "controlled-batch-missing-score-photo",
      audioExists ? "" : "controlled-batch-missing-audio",
    ].filter(Boolean)
    : [
      scoreId ? "" : "controlled-batch-missing-score",
      audioExists ? "" : "controlled-batch-missing-audio",
    ].filter(Boolean);
  const replay = blockingReasons.length
    ? {
      produced: false,
      status: "review_required",
      reasons: blockingReasons,
    }
    : isPhotoScore
      ? await buildControlledBatchPhotoScoreAnalysis(repoRoot, submission, {
        batchRunId,
        runPhotoScoreAnalysis,
      })
      : await buildControlledBatchCleanScoreAnalysis(repoRoot, submission, { batchRunId });
  return {
    submissionId: safeString(submission.submissionId),
    kind,
    scoreId,
    scorePhotoHash: safeString(submission.scorePhotoHash),
    scorePhotoSubmission: submission.scorePhotoSubmission || null,
    dataset,
    piece,
    recordingId,
    instrument,
    audioHash: safeString(submission.audioHash),
    analysisAudioSha256: safeString(replay.analysisAudioSha256),
    audioSubmission: submission.audioSubmission || null,
    inputStatus: "accepted_for_batch",
    analysisStatus: replay.status,
    offlineAnalysisProduced: replay.produced,
    autoDiagnosisIssued: replay.autoDiagnosisIssued === true,
    reasons: replay.reasons,
    analysisSummary: replay.summary || null,
    decisionCount: replay.decisionCount || 0,
    candidateRowCount: replay.candidateRowCount || 0,
    candidateRowsPath: replay.candidateRowsPath || "",
    candidateRowsSha256: safeString(replay.candidateRowsSha256),
    candidateGate: replay.candidateGate || null,
    candidatePreview: Array.isArray(replay.candidatePreview) ? replay.candidatePreview : [],
    reviewAssistPreview: Array.isArray(replay.reviewAssistPreview) ? replay.reviewAssistPreview : [],
    studentIssueCandidates: Array.isArray(replay.studentIssueCandidates)
      ? replay.studentIssueCandidates
      : [],
    recordingDiagnosis: replay.recordingDiagnosis || null,
    photoScoreDecision: safeString(replay.photoScoreDecision),
    photoScoreAuditPath: safeString(replay.photoScoreAuditPath),
    error: replay.error || "",
  };
}

async function buildControlledBatchCleanScoreAnalysis(repoRoot, submission, { batchRunId = "" } = {}) {
  return buildControlledBatchOfflineFeatureAnalysis(repoRoot, submission, { batchRunId });
}

function parseJsonFromStdout(stdout) {
  const lines = safeString(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep scanning; helper scripts may print progress before their JSON payload.
    }
  }
  return null;
}

export function buildOfflineFeatureAnalyzerArgs(repoRoot, submission) {
  const scoreId = safeString(submission.scoreId).trim();
  const audioPath = safeString(submission.audioPath).trim();
  const scriptPath = path.join(SOURCE_ROOT, "scripts", "experiments", "run_western_strings_offline_feature_analysis.py");
  const runnerPath = path.join(SOURCE_ROOT, "scripts", "run-western-ordinary-audio-python.mjs");
  return [
    runnerPath,
    "--script",
    scriptPath,
    "--",
    "--repo-root",
    repoRoot,
    "--score-id",
    scoreId,
    "--audio",
    audioPath,
    "--limit",
    "0",
    "--timing-mode",
    ORDINARY_DYNAMIC_SHADOW_TIMING_MODE,
  ];
}

async function runOfflineFeatureAnalyzer(repoRoot, submission) {
  const args = buildOfflineFeatureAnalyzerArgs(repoRoot, submission);
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: SOURCE_ROOT,
    timeout: Math.max(10000, Math.round(safeNumber(process.env.WESTERN_STRINGS_OFFLINE_ANALYZER_TIMEOUT_MS, 120000))),
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ERHU_CPU_THREAD_LIMIT: process.env.ERHU_CPU_THREAD_LIMIT || "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  const parsed = parseJsonFromStdout(stdout);
  if (!parsed) {
    throw new Error(`offline feature analyzer returned no JSON.${stderr ? ` stderr=${safeString(stderr).slice(0, 500)}` : ""}`);
  }
  return parsed;
}

async function runOfflinePhotoScoreAnalyzer(repoRoot, submission) {
  const scorePhotoPath = safeString(submission.scorePhotoPath).trim();
  const audioPath = safeString(submission.audioPath).trim();
  const submissionId = safeString(submission.submissionId, "photo-score").trim();
  const runnerPath = path.join(SOURCE_ROOT, "scripts", "run-western-photo-score-python.ps1");
  const outputRoot = path.join(repoRoot, "data", "analysis-photo-score", "controlled-submissions", submissionId);
  const args = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    runnerPath,
    "--photo",
    scorePhotoPath,
    "--audio",
    audioPath,
    "--out",
    outputRoot,
  ];
  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    cwd: SOURCE_ROOT,
    timeout: Math.max(60000, Math.round(safeNumber(process.env.WESTERN_STRINGS_PHOTO_SCORE_TIMEOUT_MS, 30 * 60 * 1000))),
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ERHU_CPU_THREAD_LIMIT: process.env.ERHU_CPU_THREAD_LIMIT || "2",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  const parsed = parseJsonFromStdout(stdout);
  if (!parsed) {
    throw new Error(`photo-score analyzer returned no JSON.${stderr ? ` stderr=${safeString(stderr).slice(0, 500)}` : ""}`);
  }
  return parsed;
}

async function buildControlledBatchPhotoScoreAnalysis(repoRoot, submission, {
  batchRunId = "",
  runPhotoScoreAnalysis = runOfflinePhotoScoreAnalyzer,
} = {}) {
  try {
    const analysis = await runPhotoScoreAnalysis(repoRoot, submission);
    const decision = safeString(analysis?.decision, "retake-photo");
    const candidateCount = Array.isArray(analysis?.candidates) ? analysis.candidates.length : 0;
    const record = {
      submissionId: safeString(submission.submissionId),
      batchRunId: safeString(batchRunId),
      ranAt: nowIso(),
      status: "ok",
      decision,
      audit: safeString(analysis?.audit),
      autoDiagnosisIssued: false,
      studentFacing: false,
    };
    const outPath = photoScoreBatchRunsPath(repoRoot);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
    return {
      produced: true,
      status: "photo_score_review_ready",
      reasons: ["photo-score-offline-review-only", `photo-score-decision-${decision.split(":", 1)[0]}`],
      autoDiagnosisIssued: false,
      summary: {
        decision,
        candidateCount,
        studentFacing: false,
      },
      decisionCount: decision ? 1 : 0,
      candidateRowCount: candidateCount,
      candidatePreview: [],
      recordingDiagnosis: {
        mode: "photo_score_review_only",
        autoDiagnosisIssued: false,
      },
      photoScoreDecision: decision,
      photoScoreAuditPath: safeString(analysis?.audit),
    };
  } catch (error) {
    const record = {
      submissionId: safeString(submission.submissionId),
      batchRunId: safeString(batchRunId),
      ranAt: nowIso(),
      status: "failed",
      reason: "photo-score-offline-analysis-failed",
      autoDiagnosisIssued: false,
      studentFacing: false,
    };
    const outPath = photoScoreBatchRunsPath(repoRoot);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
    return {
      produced: false,
      status: "failed",
      reasons: ["photo-score-offline-analysis-failed"],
      autoDiagnosisIssued: false,
      error: safeString(error?.message || error),
    };
  }
}

async function buildControlledBatchOfflineFeatureAnalysis(repoRoot, submission, { batchRunId = "" } = {}) {
  const scoreId = safeString(submission.scoreId).trim();
  const audioPath = safeString(submission.audioPath).trim();
  if (!scoreId || !audioPath) {
    return {
      produced: false,
      status: "review_required",
      reasons: ["controlled-batch-offline-feature-extractor-not-connected"],
    };
  }
  try {
    const expectedAudioSha256 = await sha256File(audioPath);
    const analysis = await runOfflineFeatureAnalyzer(repoRoot, submission);
    if (analysis?.ok !== true) {
      return {
        produced: false,
        status: "review_required",
        reasons: Array.isArray(analysis?.blockingReasons) && analysis.blockingReasons.length
          ? analysis.blockingReasons.map((item) => safeString(item)).filter(Boolean)
          : ["controlled-batch-offline-feature-analysis-not-ready"],
        summary: analysis?.summary || null,
      };
    }
    const candidateRows = Array.isArray(analysis.candidateRows) ? analysis.candidateRows : [];
    const basicPitchCacheProvenance = analysis?.basicPitchCacheProvenance
      && typeof analysis.basicPitchCacheProvenance === "object"
      ? analysis.basicPitchCacheProvenance
      : null;
    const [cacheArtifactVerification, scoreVerification, m3plusRuntimeBindings] = await Promise.all([
      verifyBasicPitchCacheArtifact(repoRoot, basicPitchCacheProvenance, expectedAudioSha256),
      verifyScoreProvenance(repoRoot, analysis?.scoreProvenance, scoreId),
      verifyM3PlusRuntimeBindings(repoRoot, analysis?.m3plusPitchSafetyRuntime),
    ]);
    const runtimeAttestationVerification = evaluateOrdinaryAudioRuntimeAttestation(
      analysis?.runtimeAttestation,
    );
    const rfCandidateGate = await evaluateOfflineFeatureStudentSafeGate(repoRoot, candidateRows, submission, { batchRunId });
    const gateInputRows = Array.isArray(rfCandidateGate.scoredCandidateRows) ? rfCandidateGate.scoredCandidateRows : candidateRows;
    const dynamicShadow = buildOrdinaryDynamicShadowReviewGate(gateInputRows, rfCandidateGate, {
      basicPitchCacheProvenance,
      expectedAudioSha256,
      cacheArtifactVerification,
      scoreVerification,
      runtimeAttestationVerification,
    });
    const m3plusRuntime = buildM3PlusPitchSafetyReviewRuntime(dynamicShadow.rows, {
      scoreVerification,
      runtimeBindings: m3plusRuntimeBindings,
    });
    const gatedCandidateRows = m3plusRuntime.rows.map((candidate) => ({
      ...candidate,
      reviewAssistDecision: buildWesternOrdinaryReviewAssistDecision(candidate),
    }));
    const reviewAssistRows = gatedCandidateRows.filter(
      (candidate) => candidate.reviewAssistDecision.requiresHumanReview === true,
    );
    const reviewAssist = {
      contract: ORDINARY_REVIEW_ASSIST_CONTRACT,
      reviewerOnly: true,
      studentFacing: false,
      automaticAccusationAuthorized: false,
      confirmedIssueCandidateCount: reviewAssistRows.filter(
        (candidate) => candidate.reviewAssistDecision.outputSemantic === "confirmed_issue",
      ).length,
      selfCheckHintCount: reviewAssistRows.filter(
        (candidate) => candidate.reviewAssistDecision.outputSemantic === "self_check_hint",
      ).length,
      outputCount: reviewAssistRows.length,
    };
    const candidateGate = {
      ...dynamicShadow.gate,
      m3plusPitchSafetyRuntime: m3plusRuntime.gate,
      reviewAssist,
    };
    const candidateRowsArtifact = await writeControlledSubmissionCandidateRows(repoRoot, {
      batchRunId,
      submissionId: submission.submissionId,
      candidateRows: gatedCandidateRows,
      candidateGate,
    });
    return {
      produced: true,
      status: "offline_feature_review_ready",
      reasons: [candidateGate.reason],
      autoDiagnosisIssued: false,
      summary: {
        ...(analysis.summary || {}),
        shadowTelemetryCoverage: candidateGate.evaluatedCandidateCount > 0
          ? Number((candidateGate.shadowSelectedCandidateCount / candidateGate.evaluatedCandidateCount).toFixed(6))
          : 0,
        coverage: 0,
        autoPassCount: 0,
        reviewOnlyCandidateCount: gatedCandidateRows.length,
        studentSafeGateReady: false,
        studentSafeCandidateGateReady: false,
        studentFacing: false,
        autoDiagnosisIssued: false,
        automaticAdoptionAuthorized: false,
        basicPitchCacheProvenance: candidateGate.basicPitchCacheProvenance,
        scoreProvenance: candidateGate.scoreProvenance,
        studentSafeCandidateGateVersion: candidateGate.gateVersion,
        dynamicShadowContractReady: candidateGate.contractReady,
        dynamicShadowCacheProvenanceReady: candidateGate.cacheProvenanceReady,
        dynamicShadowScoreProvenanceReady: candidateGate.scoreProvenanceReady,
        dynamicShadowSelectedCandidateCount: candidateGate.shadowSelectedCandidateCount,
        dynamicShadowInvalidEvidenceCount: candidateGate.invalidEvidenceCount,
        m3plusPitchSafetyRuntime: candidateGate.m3plusPitchSafetyRuntime,
        m3plusReviewOnlyRuntimeWired:
          candidateGate.m3plusPitchSafetyRuntime.reviewOnlyRuntimeWired === true,
        m3plusRuntimeEvidenceReady:
          candidateGate.m3plusPitchSafetyRuntime.runtimeEvidenceReady === true,
        m3plusFeedbackAuthorized: false,
        reviewAssist,
        confidenceModelVersion: safeString(candidateGate.rfTelemetry?.modelVersion),
        confidenceThreshold: candidateGate.rfTelemetry?.threshold ?? null,
      },
      decisionCount: Array.isArray(analysis.decisions) ? analysis.decisions.length : 0,
      candidateRowCount: candidateRows.length,
      candidateRowsPath: candidateRowsArtifact.path,
      candidateRowsSha256: candidateRowsArtifact.sha256,
      analysisAudioSha256: expectedAudioSha256,
      candidateGate,
      candidatePreview: gatedCandidateRows.slice(0, 5),
      reviewAssistPreview: reviewAssistRows.slice(0, 20).map(projectReviewAssistCandidate),
      studentIssueCandidates: projectStudentIssueCandidates(reviewAssistRows),
      recordingDiagnosis: {
        mode: "offline_feature_dynamic_shadow_review_only",
        scoreId,
        audioSha256: expectedAudioSha256,
        audioHashAlgorithm: "sha256",
        autoDiagnosisIssued: false,
        autoPassCandidateCount: 0,
        shadowSelectedCandidateCount: candidateGate.shadowSelectedCandidateCount,
        reviewAssistOutputCount: reviewAssist.outputCount,
        basicPitchCacheProvenance: candidateGate.basicPitchCacheProvenance,
      },
    };
  } catch (error) {
    return {
      produced: false,
      status: "failed",
      reasons: ["controlled-batch-offline-feature-analysis-failed"],
      error: safeString(error?.message || error),
    };
  }
}

async function evaluateOfflineFeatureStudentSafeGate(repoRoot, candidateRows = [], submission = {}, { batchRunId = "" } = {}) {
  if (!ordinaryUploadConfidenceGateEnabled()) {
    return buildOfflineFeatureReviewOnlyGate(candidateRows);
  }
  const releasePath = ordinaryUploadConfidenceReleasePath();
  const release = await readJsonOrNull(releasePath);
  if (!release) {
    return buildOfflineFeatureReviewOnlyGate(candidateRows, {
      reason: "ordinary-upload-confidence-release-missing",
      blockingReasons: ["ordinary-upload-confidence-release-missing"],
    });
  }
  const validationPath = resolveRepoPath(repoRoot, release?.blindValidation?.source);
  const validation = validationPath ? await readJsonOrNull(validationPath) : null;
  if (validation?.blindValidationPassed !== true) {
    return buildOfflineFeatureReviewOnlyGate(candidateRows, {
      reason: "ordinary-upload-confidence-validation-not-passed",
      blockingReasons: ["ordinary-upload-confidence-validation-not-passed"],
      gateVersion: safeString(release.gateVersion, OFFLINE_FEATURE_STUDENT_GATE_VERSION),
    });
  }
  let scored = null;
  try {
    scored = await scoreOfflineFeatureCandidateRows(repoRoot, candidateRows, submission, release, { batchRunId });
  } catch (error) {
    return buildOfflineFeatureReviewOnlyGate(candidateRows, {
      reason: "ordinary-upload-confidence-scorer-failed",
      blockingReasons: ["ordinary-upload-confidence-scorer-failed", safeString(error?.message || error).slice(0, 300)].filter(Boolean),
      gateVersion: safeString(release.gateVersion, OFFLINE_FEATURE_STUDENT_GATE_VERSION),
    });
  }
  if (scored?.ok !== true) {
    return buildOfflineFeatureReviewOnlyGate(candidateRows, {
      reason: safeString(scored?.reason, "ordinary-upload-confidence-scorer-not-ready"),
      blockingReasons: [safeString(scored?.reason, "ordinary-upload-confidence-scorer-not-ready")],
      gateVersion: safeString(release.gateVersion, OFFLINE_FEATURE_STUDENT_GATE_VERSION),
    });
  }
  const scoped = applyOrdinaryControlledPilotScope(scored.rows, release);
  const scoredRows = scoped.rows;
  const pitchSupportedCount = scoredRows.filter((candidate) => candidate.pitchSupportWithin80Cents === true).length;
  const modelAutoPassCandidateCount = scoped.modelAutoPassCandidateCount;
  const autoPassCandidateCount = scoped.autoPassCandidateCount;
  const evaluatedCandidateCount = scoredRows.length;
  return {
    gateVersion: safeString(release.gateVersion, "western-offline-feature-gate-v1-confidence-rf"),
    modelVersion: safeString(release.modelVersion, "ordinary-upload-confidence-rf-v1"),
    ready: true,
    mode: "confidence_rf",
    reason: "ordinary-upload-confidence-gate-enabled",
    blockingReasons: [],
    evaluatedCandidateCount,
    pitchSupportRequired: false,
    pitchSupportedCandidateCount: pitchSupportedCount,
    modelAutoPassCandidateCount,
    autoPassCandidateCount,
    reviewRequiredCandidateCount: Math.max(0, evaluatedCandidateCount - autoPassCandidateCount),
    controlledPilotScope: scoped.controlledPilotScope,
    threshold: scored.threshold ?? release.threshold ?? null,
    modelName: safeString(scored.modelName, safeString(release.modelName, "rf")),
    featureSet: safeString(scored.featureSet, safeString(release.featureSet, "deployable")),
    groupBy: safeString(scored.groupBy, safeString(release.groupBy, "recordingId")),
    allowedDiagnosticCategories: ["candidate-evidence"],
    reviewOnlyDiagnosticCategories: ["pitch", "onset", "missing", "duration", "extra"],
    releaseManifest: path.relative(repoRoot, releasePath).replace(/\\/g, "/"),
    validationEvidence: validationPath ? path.relative(repoRoot, validationPath).replace(/\\/g, "/") : "",
    scoredCandidateRows: scoredRows,
  };
}

export async function runWesternControlledSubmissionBatch({
  repoRoot = process.cwd(),
  limit = 20,
  runPhotoScoreAnalysis = runOfflinePhotoScoreAnalyzer,
  submissionIds = [],
} = {}) {
  const queue = await listWesternControlledSubmissions({ repoRoot, limit: 0 });
  const requestedSubmissionIds = new Set(
    (Array.isArray(submissionIds) ? submissionIds : [])
      .map((submissionId) => safeString(submissionId).trim())
      .filter(Boolean),
  );
  const accepted = queue.submissions
    .filter((submission) => submission.status === "accepted_for_batch")
    .filter((submission) => (
      requestedSubmissionIds.size === 0 || requestedSubmissionIds.has(submission.submissionId)
    ));
  const selected = limit > 0 ? accepted.slice(0, limit) : accepted;
  const rawSubmissions = await readJsonlRecords(controlledSubmissionsPath(repoRoot));
  const rawById = new Map(rawSubmissions.map((submission) => [safeString(submission.submissionId).trim(), submission]));
  const gateSnapshot = await buildBatchGateSnapshot(repoRoot);
  const batchRunId = createId("strings-batch");
  const items = [];
  for (const submission of selected) {
    const raw = rawById.get(submission.submissionId) || submission;
    items.push(await buildControlledBatchItem(repoRoot, raw, gateSnapshot, {
      batchRunId,
      runPhotoScoreAnalysis,
    }));
  }
  const offlineAnalysisProducedCount = items.filter((item) => item.offlineAnalysisProduced === true).length;
  const autoDiagnosisIssued = items.some((item) => item.autoDiagnosisIssued === true);
  const hasValidatedReplay = items.some((item) => item.analysisStatus === "offline_analysis_ready");
  const hasFeatureReview = items.some((item) => item.analysisStatus === "offline_feature_review_ready");
  const hasPhotoScoreReview = items.some((item) => item.analysisStatus === "photo_score_review_ready");
  const run = {
    batchRunId,
    createdAt: nowIso(),
    source: path.relative(repoRoot, controlledSubmissionsPath(repoRoot)).replace(/\\/g, "/"),
    itemCount: items.length,
    acceptedQueueCount: accepted.length,
    offlineAnalysisProducedCount,
    autoDiagnosisIssued,
    status: items.length
      ? (hasValidatedReplay
        ? "offline_analysis_ready"
        : hasFeatureReview
            ? "offline_feature_review_ready"
            : hasPhotoScoreReview
              ? "photo_score_review_ready"
              : "review_required")
      : "no_accepted_submissions",
    reason: items.length
      ? (autoDiagnosisIssued
        ? "controlled-batch-confidence-gate-issued-candidate-feedback"
        : offlineAnalysisProducedCount > 0
          ? "controlled-batch-not-student-facing"
          : "controlled-batch-offline-feature-extractor-not-connected")
      : "controlled-batch-empty",
    gateSnapshot,
    items,
  };
  if (items.length > 0) {
    const outPath = controlledSubmissionBatchRunsPath(repoRoot);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.appendFile(outPath, `${JSON.stringify(run)}\n`, "utf8");
  }
  return { ok: true, batch: run };
}

function buildCategoryDiagnosis(row, category, { required = false } = {}) {
  const autoIssueCount = Math.max(0, Math.round(safeNumber(row?.[`${category}AutoIssueCount`], 0)));
  const correctIssueCount = Math.max(0, Math.round(safeNumber(row?.[`${category}CorrectIssueCount`], 0)));
  const unsafeIssueCount = Math.max(0, Math.round(safeNumber(row?.[`${category}UnsafeIssueCount`], 0)));
  const precision = autoIssueCount ? Number((correctIssueCount / autoIssueCount).toFixed(6)) : null;
  return {
    category,
    requiredForRelease: required,
    status: required ? (autoIssueCount ? "auto_pass" : "no_issue_detected") : "review_only",
    autoIssueCount,
    correctIssueCount,
    unsafeIssueCount,
    precision,
  };
}

function buildRecordingDiagnosis(row, diagnosisGate) {
  if (!row) return null;
  const required = new Set(diagnosisGate.requiredCategories || []);
  const reviewOnly = new Set(diagnosisGate.reviewOnlyCategories || []);
  const categories = [...required, ...reviewOnly].map((category) => buildCategoryDiagnosis(row, category, {
    required: required.has(category),
  }));
  return {
    recordingId: safeString(row.recordingId),
    scenario: safeString(row.scenario),
    autoPassEvaluatedCount: Math.max(0, Math.round(safeNumber(row.autoPassEvaluatedCount, 0))),
    categories,
    notes: safeString(row.notes),
  };
}

function reviewRequiredDecision(decision, reason, evidence = {}) {
  return {
    ...decision,
    autoDecision: "review_required",
    confidenceScore: 0,
    reviewRequiredReason: reason,
    evidence: {
      ...decision.evidence,
      ...evidence,
    },
  };
}

async function applyStudentGate(repoRoot, decisions, gate) {
  if (!gate.ready) {
    return decisions.map((decision) => reviewRequiredDecision(decision, gate.reason, { studentGateReady: false }));
  }
  const eventCache = new Map();
  const grouped = new Map();
  for (const decision of decisions) {
    const key = `${decision.dataset}\u0000${decision.piece}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(decision);
  }
  const nextDecisions = [];
  for (const pieceDecisions of grouped.values()) {
    pieceDecisions.sort((left, right) => left.noteIndex - right.noteIndex);
    for (let index = 0; index < pieceDecisions.length; index += 1) {
      const decision = pieceDecisions[index];
      const supported = await hasSequenceBasicPitchSupport(repoRoot, eventCache, pieceDecisions, index, gate.supportFeature);
      if (!supported) {
        nextDecisions.push(reviewRequiredDecision(decision, "sequence-basic-pitch-support-missing", {
          studentGateReady: true,
          sequenceBasicPitchSupport: false,
        }));
      } else {
        nextDecisions.push({
          ...decision,
          evidence: {
            ...decision.evidence,
            studentGateReady: true,
            sequenceBasicPitchSupport: true,
          },
        });
      }
    }
  }
  return nextDecisions.sort((left, right) => (
    left.dataset.localeCompare(right.dataset) ||
    left.piece.localeCompare(right.piece) ||
    left.noteIndex - right.noteIndex
  ));
}

export async function buildWesternAlignmentPreview({
  repoRoot = process.cwd(),
  featuresPath = "data/experiments/western-strings-m2/alignment-candidate-feature-table.csv",
  dataset = "",
  piece = "",
  limit = 0,
  includeLabels = false,
  studentSafe = false,
} = {}) {
  const resolvedPath = path.resolve(repoRoot, featuresPath);
  const text = await fs.readFile(resolvedPath, "utf8");
  const rows = parseCsv(text)
    .filter((row) => !dataset || safeString(row.dataset) === dataset)
    .filter((row) => !piece || safeString(row.piece) === piece);
  const rawDecisions = groupRows(rows)
    .map((group) => buildDecision(group, { includeLabels }))
    .sort((left, right) => (
      left.dataset.localeCompare(right.dataset) ||
      left.piece.localeCompare(right.piece) ||
      left.noteIndex - right.noteIndex
    ));
  const studentGate = studentSafe ? await readStudentGate(repoRoot) : null;
  const decisions = studentGate ? await applyStudentGate(repoRoot, rawDecisions, studentGate) : rawDecisions;
  const cappedDecisions = limit > 0 ? decisions.slice(0, limit) : decisions;
  return {
    ok: true,
    source: path.relative(repoRoot, resolvedPath).replace(/\\/g, "/"),
    filters: { dataset, piece, limit, studentSafe },
    releaseGate: studentGate,
    summary: summarize(decisions, { includeLabels }),
    decisions: cappedDecisions,
  };
}

export async function buildWesternStudentAnalysis({
  repoRoot = process.cwd(),
  dataset = "",
  piece = "",
  limit = 0,
  recordingId = "",
  submissionPayload = null,
} = {}) {
  if (hasControlledSubmissionPayload(submissionPayload)) {
    return buildControlledSubmissionAnalysis(repoRoot, submissionPayload);
  }

  const sequenceGate = await readStudentGate(repoRoot);
  const realStudentGate = await readRealStudentGate(repoRoot);
  const diagnosisGate = await readDiagnosisGate(repoRoot);
  const blockingReasons = [
    sequenceGate.ready ? "" : sequenceGate.reason,
    realStudentGate.ready ? "" : realStudentGate.reason,
    diagnosisGate.ready ? "" : diagnosisGate.reason,
    ...diagnosisGate.blockingReasons,
  ].filter(Boolean);
  const studentReady = blockingReasons.length === 0;

  if (!studentReady) {
    return {
      ok: true,
      studentReady: false,
      blockingReasons: [...new Set(blockingReasons)],
      releaseGates: {
        sequenceGate,
        realStudentGate,
        diagnosisGate,
      },
      summary: {
        noteCount: 0,
        autoPassCount: 0,
        reviewRequiredCount: 0,
        coverage: 0,
      },
      decisions: [],
      recordingDiagnosis: null,
    };
  }

  const preview = await buildWesternAlignmentPreview({
    repoRoot,
    dataset,
    piece,
    limit,
    studentSafe: true,
    includeLabels: false,
  });
  const diagnosisRows = await readDiagnosisRows(repoRoot);
  const recordingRow = recordingId
    ? diagnosisRows.find((row) => safeString(row.recordingId) === safeString(recordingId))
    : null;
  const allowedDiagnosticCategories = diagnosisGate.requiredCategories.filter((category) => (
    diagnosisGate.categories?.[category]?.ready === true
  ));
  const decisions = preview.decisions.map((decision) => ({
    ...decision,
    allowedDiagnosticCategories,
    reviewOnlyDiagnosticCategories: diagnosisGate.reviewOnlyCategories,
    diagnosisMode: "core-categories-only",
  }));

  return {
    ok: true,
    studentReady: true,
    blockingReasons: [],
    releaseGates: {
      sequenceGate,
      realStudentGate,
      diagnosisGate,
    },
    summary: {
      ...preview.summary,
      allowedDiagnosticCategories,
      reviewOnlyDiagnosticCategories: diagnosisGate.reviewOnlyCategories,
    },
    decisions,
    recordingDiagnosis: buildRecordingDiagnosis(recordingRow, diagnosisGate),
  };
}

export function parsePreviewQuery(query = {}) {
  return {
    dataset: safeString(query.dataset).trim(),
    piece: safeString(query.piece).trim(),
    limit: Math.max(0, Math.round(safeNumber(query.limit, 0))),
    includeLabels: safeBoolean(query.includeLabels, false),
    studentSafe: safeBoolean(query.studentSafe, false),
  };
}

export function parseStudentAnalysisPayload(payload = {}) {
  return {
    dataset: safeString(payload.dataset).trim(),
    piece: safeString(payload.piece).trim(),
    pieceId: safeString(payload.pieceId).trim(),
    limit: Math.max(0, Math.round(safeNumber(payload.limit, 0))),
    recordingId: safeString(payload.recordingId).trim(),
    instrument: safeString(payload.instrument).trim(),
    studentRef: safeString(payload.studentRef).trim(),
    scoreId: safeString(payload.scoreId).trim(),
    scorePhotoPath: safeString(payload.scorePhotoPath).trim(),
    scorePhotoHash: safeString(payload.scorePhotoHash).trim(),
    scorePhotoSubmission: payload.scorePhotoSubmission || null,
    audioPath: safeString(payload.audioPath).trim(),
    audioHash: safeString(payload.audioHash).trim(),
    audioSubmission: payload.audioSubmission || null,
  };
}

export async function recordWesternAlignmentPreviewReview({ repoRoot, payload = {} }) {
  const noteKey = safeString(payload.noteKey || payload.noteId).trim();
  const action = safeString(payload.action).trim();
  if (!noteKey) throw new Error("noteKey is required.");
  if (!["confirm", "correct", "review_required"].includes(action)) {
    throw new Error("action must be confirm, correct, or review_required.");
  }
  const record = {
    submittedAt: new Date().toISOString(),
    noteKey,
    action,
    raterId: safeString(payload.raterId, "teacher-1"),
    predictedOnsetSeconds: numberOrNull(payload.predictedOnsetSeconds),
    correctedOnsetSeconds: numberOrNull(payload.correctedOnsetSeconds),
    comments: safeString(payload.comments),
  };
  const outPath = path.join(repoRoot, "data", "experiments", "western-strings-m2", "alignment-preview-reviews.jsonl");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
  return { ok: true, review: record };
}

export async function recordWesternStudentReview({ repoRoot, payload = {} }) {
  const noteKey = safeString(payload.noteKey || payload.noteId).trim();
  const action = safeString(payload.action).trim();
  const category = safeString(payload.category).trim();
  if (!noteKey && !safeString(payload.recordingId).trim()) throw new Error("noteKey or recordingId is required.");
  if (!["confirm", "correct", "review_required"].includes(action)) {
    throw new Error("action must be confirm, correct, or review_required.");
  }
  const record = {
    submittedAt: new Date().toISOString(),
    noteKey,
    recordingId: safeString(payload.recordingId),
    action,
    category,
    raterId: safeString(payload.raterId, "teacher-1"),
    predictedOnsetSeconds: numberOrNull(payload.predictedOnsetSeconds),
    correctedOnsetSeconds: numberOrNull(payload.correctedOnsetSeconds),
    comments: safeString(payload.comments),
  };
  const outPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "student-analysis-reviews.jsonl");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");
  return { ok: true, review: record };
}
