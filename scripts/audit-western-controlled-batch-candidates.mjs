import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ORDINARY_DYNAMIC_SCORE_BINDING_MODE } from "./audit-western-ordinary-dynamic-shadow-acceptance.mjs";

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return {
            _invalidJsonLine: index + 1,
            _error: String(error?.message || error),
          };
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function pushFailure(failures, code, details = {}) {
  failures.push({ code, ...details });
}

const DYNAMIC_GATE_VERSION = "western-ordinary-dynamic-shadow-gate-v1-review-only";
const DYNAMIC_CONTRACT_VERSION = "western-ordinary-dynamic-shadow-candidate-v1";
const DYNAMIC_POLICY_VERSION = "western-ordinary-dynamic-shadow-policy-v1";
const DYNAMIC_TIMING_MODE = "basic-pitch-dtw";
const REVIEW_ASSIST_CONTRACT = "western-round4-policy-c-review-assist-v1";
const BASIC_PITCH_MODEL_ARTIFACT_SHA256 = "c6595f299ff83c52e89555789f7e3e829a6a0f25b6a88f7e99073af5a2470dc4";
const ORDINARY_AUDIO_RUNTIME_ID = "western-ordinary-dynamic-shadow-audio-py311";
const ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256 = "1f3a47f5cfe2b2d2e427be9a03ab43b4b4aa09a5db0edeed0b55e610a42ac6f9";
const ORDINARY_AUDIO_RUNTIME_LOCK_SHA256 = "4120a811da1ecb1aa93ceabcbb5aa0b45a37c08e5ee3138d2b793e38f2828d04";
const M3PLUS_EVALUATION_CONTRACT = "m3plus-rescope-four-zone-v2";
const M3PLUS_RUNTIME_CONTRACT = "m3plus-gold-free-runtime-v1";
const M3PLUS_RUNTIME_POLICY_VERSION = "m3plus-gold-free-pitch-safety-policy-v1";
const M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256 = "8279e1e9a69c4bf35e18d55f4daf50522a9bb43ef9f472989e6c8c1b5481a274";
const M3PLUS_F0_BACKEND = "librosa-pyin";
const M3PLUS_POLICY_ARTIFACT_PATH = "scripts/experiments/western_strings_m3plus_runtime_policy.py";
const M3PLUS_POLICY_ARTIFACT_SEMANTIC_SHA256 = "226173fbde4fa73804d21daae7ea0179a3d97a5b547aebdfdebda52ac94e6eab";
const M3PLUS_ANALYZER_ARTIFACT_PATH = "scripts/experiments/run_western_strings_offline_feature_analysis.py";
const M3PLUS_ANALYZER_ARTIFACT_SEMANTIC_SHA256 = "65ea46768bf23e51aac4083c3fd08fecbeb2d81d8af4effc5aaae482bc7a279d";
const M3PLUS_RESCOPE_REPORT_PATH = "data/experiments/western-strings-m3plus/rescope-gate/report.json";
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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function noteIdentitySha256(rows) {
  return crypto.createHash("sha256").update(canonicalJson(rows), "utf8").digest("hex");
}

function buildScoreNoteIdentityRows(score) {
  const rows = [];
  for (const section of score?.sections || []) {
    for (const note of section?.notes || []) {
      const midi = Number(note?.midiPitch);
      if (!Number.isFinite(midi) || midi <= 0) continue;
      rows.push({
        noteIndex: rows.length,
        noteId: safeString(note?.noteId).trim(),
        sectionId: safeString(section?.sectionId).trim(),
        measureIndex: Number.isFinite(Number(note?.measureIndex)) ? Math.round(Number(note.measureIndex)) : null,
        midi: Math.round(midi),
      });
    }
  }
  return rows;
}

function buildCandidateNoteIdentityRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((candidate) => ({
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
      const midi = asNumber(note?.midiPitch, -1);
      if (midi <= 0) continue;
      const sourceMeasureIndex = Math.round(asNumber(note?.measureIndex, 0));
      const position = note?.notePosition && typeof note.notePosition === "object"
        ? note.notePosition
        : {};
      notes.push({
        order,
        pageNumber: Math.round(asNumber(position.pageNumber, 0)),
        sourceMeasureIndex,
        noteId: safeString(note?.noteId || `note-${order}`).trim(),
        sectionId: safeString(section?.sectionId).trim(),
        measureIndex: Math.round(asNumber(position.globalMeasureIndex, sourceMeasureIndex)),
        beatStart: asNumber(note?.beatStart, 0),
        beatDuration: Math.max(0.05, asNumber(note?.beatDuration, 1)),
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

function buildCandidateM3PlusNoteIdentityRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((candidate) => ({
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

function auditPhysicalScoreBinding(sourceRoot, scoreProvenance, candidateRows) {
  const blockingReasons = [];
  const normalizedStorePath = safeString(scoreProvenance?.scoreStorePath).trim().replace(/\\/g, "/");
  const allowedStorePaths = new Set([
    "data/erhu-score-imports.json",
    "data/erhu-score-imports.sqlite",
  ]);
  if (!sourceRoot || !allowedStorePaths.has(normalizedStorePath)) {
    return { ready: false, blockingReasons: ["feature-review-score-store-path-invalid"] };
  }
  const root = path.resolve(sourceRoot);
  const storePath = path.resolve(root, normalizedStorePath);
  let store = null;
  let storeSha256 = "";
  try {
    const realRoot = fsSync.realpathSync(root);
    const realStorePath = fsSync.realpathSync(storePath);
    const relative = path.relative(realRoot, realStorePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ready: false, blockingReasons: ["feature-review-score-store-realpath-outside-root"] };
    }
    const beforeBytes = fsSync.readFileSync(realStorePath);
    storeSha256 = crypto.createHash("sha256").update(beforeBytes).digest("hex");
    if (normalizedStorePath.endsWith(".sqlite")) {
      const db = new DatabaseSync(realStorePath, { readOnly: true });
      try {
        store = {
          scores: db.prepare(`
            SELECT payload FROM imported_scores
            WHERE archived = 0
            ORDER BY updated_at DESC
          `).all().map((row) => JSON.parse(String(row.payload || "{}"))),
        };
      } finally {
        db.close();
      }
    } else {
      store = JSON.parse(beforeBytes.toString("utf8"));
    }
    const afterBytes = fsSync.readFileSync(realStorePath);
    if (crypto.createHash("sha256").update(afterBytes).digest("hex") !== storeSha256) {
      blockingReasons.push("feature-review-score-store-changed-during-audit");
    }
  } catch {
    return { ready: false, blockingReasons: ["feature-review-score-store-unreadable"] };
  }
  const recordedStoreSha256 = safeString(scoreProvenance?.scoreStoreArtifactSha256).trim().toLowerCase();
  // The container hash remains provenance only. Unrelated score imports may
  // change it; freshness is decided by the cited score payload and note
  // identities below.
  const scoreId = safeString(scoreProvenance?.scoreId).trim();
  const score = (Array.isArray(store?.scores) ? store.scores : [])
    .find((item) => safeString(item?.scoreId).trim() === scoreId);
  if (!score) {
    return {
      ready: false,
      blockingReasons: [...new Set([...blockingReasons, "feature-review-score-missing-from-store"])],
    };
  }
  const scorePayloadSha256 = crypto.createHash("sha256").update(canonicalJson(score), "utf8").digest("hex");
  if (scorePayloadSha256 !== safeString(scoreProvenance?.scorePayloadSha256).trim().toLowerCase()) {
    blockingReasons.push("feature-review-score-payload-sha-mismatch");
  }
  const expectedNotes = buildScoreNoteIdentityRows(score);
  const candidateNotes = buildCandidateNoteIdentityRows(candidateRows);
  const expectedM3PlusNotes = buildScoreM3PlusNoteIdentityRows(score);
  const candidateM3PlusNotes = buildCandidateM3PlusNoteIdentityRows(candidateRows);
  const expectedSha256 = noteIdentitySha256(expectedNotes);
  const candidateSha256 = noteIdentitySha256(candidateNotes);
  const expectedM3PlusSha256 = noteIdentitySha256(expectedM3PlusNotes);
  const candidateM3PlusSha256 = noteIdentitySha256(candidateM3PlusNotes);
  const identitiesMatch = candidateNotes.length === expectedNotes.length
    && expectedNotes.length > 0
    && candidateNotes.every((candidate, index) => (
      candidate.noteIndex === index
      && candidate.noteIndex === expectedNotes[index]?.noteIndex
      && candidate.noteId !== ""
      && candidate.noteId === expectedNotes[index]?.noteId
      && candidate.sectionId !== ""
      && candidate.sectionId === expectedNotes[index]?.sectionId
      && candidate.measureIndex === expectedNotes[index]?.measureIndex
      && candidate.midi === expectedNotes[index]?.midi
    ));
  if (!identitiesMatch) blockingReasons.push("feature-review-score-note-identity-mismatch");
  if (Number(scoreProvenance?.noteCount) !== expectedNotes.length) {
    blockingReasons.push("feature-review-score-note-count-physical-mismatch");
  }
  if (safeString(scoreProvenance?.noteIdentitySha256).trim().toLowerCase() !== expectedSha256) {
    blockingReasons.push("feature-review-score-note-identity-sha-mismatch");
  }
  return {
    ready: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
    expectedSha256,
    candidateSha256,
    expectedM3PlusSha256,
    candidateM3PlusSha256,
    expectedM3PlusNotes,
    candidateM3PlusNotes,
    noteCount: expectedNotes.length,
    scoreBindingMode: ORDINARY_DYNAMIC_SCORE_BINDING_MODE,
    storeArtifactChanged: storeSha256 !== recordedStoreSha256,
    observedStoreSha256: storeSha256,
    recordedStoreSha256,
  };
}

function auditPhysicalBoundArtifact(sourceRoot, recordedPath, recordedSha256, expectedPath, prefix) {
  const blockingReasons = [];
  const normalizedPath = safeString(recordedPath).trim().replace(/\\/g, "/");
  const normalizedSha256 = safeString(recordedSha256).trim().toLowerCase();
  if (normalizedPath !== expectedPath) blockingReasons.push(`${prefix}-path-mismatch`);
  if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) blockingReasons.push(`${prefix}-sha-invalid`);
  const root = path.resolve(sourceRoot || ".");
  const artifactPath = path.resolve(root, normalizedPath || expectedPath);
  const relative = path.relative(root, artifactPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ready: false, blockingReasons: [...new Set([...blockingReasons, `${prefix}-outside-root`])] };
  }
  try {
    const realRoot = fsSync.realpathSync(root);
    const realArtifactPath = fsSync.realpathSync(artifactPath);
    const realRelative = path.relative(realRoot, realArtifactPath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return {
        ready: false,
        blockingReasons: [...new Set([...blockingReasons, `${prefix}-realpath-outside-root`])],
      };
    }
    const bytes = fsSync.readFileSync(realArtifactPath);
    const observedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (observedSha256 !== normalizedSha256) blockingReasons.push(`${prefix}-sha-mismatch`);
    const afterSha256 = crypto.createHash("sha256").update(fsSync.readFileSync(realArtifactPath)).digest("hex");
    if (afterSha256 !== observedSha256) blockingReasons.push(`${prefix}-changed-during-audit`);
    return {
      ready: blockingReasons.length === 0,
      blockingReasons: [...new Set(blockingReasons)],
      bytes,
      observedSha256,
    };
  } catch {
    return {
      ready: false,
      blockingReasons: [...new Set([...blockingReasons, `${prefix}-unreadable`])],
    };
  }
}

function readM3PlusEvidenceNumber(evidence, key, errors, { integer = false, min = null, max = null } = {}) {
  if (!Object.hasOwn(evidence, key)) {
    errors.push(`field-missing:${key}`);
    return null;
  }
  if (evidence[key] === null) return null;
  const value = evidence[key];
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    errors.push(`field-invalid:${key}`);
    return null;
  }
  if (min !== null && value < min) errors.push(`field-below-minimum:${key}`);
  if (max !== null && value > max) errors.push(`field-above-maximum:${key}`);
  return value;
}

function auditM3PlusCandidate(candidate, expectedScoreNote, runtime, failures, detail) {
  const evidence = candidate?.m3plusPitchSafetyEvidence;
  const decision = candidate?.m3plusPitchSafetyDecision;
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    pushFailure(failures, "feature-review-m3plus-candidate-evidence-missing", detail);
    return;
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    pushFailure(failures, "feature-review-m3plus-candidate-decision-missing", detail);
    return;
  }
  if (!expectedScoreNote) errors.push("score-note-missing");
  if (candidate.feedbackAuthorized !== false
      || candidate.studentFacing !== false
      || candidate.autoDecision !== "review_required"
      || candidate.gateDecision !== "review_required") {
    errors.push("candidate-review-only-state-invalid");
  }
  if (evidence.evaluationContract !== M3PLUS_EVALUATION_CONTRACT
      || evidence.runtimeContract !== M3PLUS_RUNTIME_CONTRACT
      || evidence.policyVersion !== M3PLUS_RUNTIME_POLICY_VERSION
      || evidence.policySemanticSha256 !== M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256
      || evidence.f0Backend !== M3PLUS_F0_BACKEND
      || canonicalJson(evidence.thresholds || {}) !== canonicalJson(M3PLUS_RUNTIME_THRESHOLDS)) {
    errors.push("evidence-contract-invalid");
  }
  if (evidence.evaluationContract !== runtime.evaluationContract
      || evidence.runtimeContract !== runtime.runtimeContract
      || evidence.policyVersion !== runtime.policyVersion
      || evidence.policySemanticSha256 !== runtime.policySemanticSha256) {
    errors.push("evidence-runtime-binding-mismatch");
  }
  if (evidence.reviewOnly !== true
      || evidence.feedbackAuthorized !== false
      || evidence.studentFacing !== false) {
    errors.push("evidence-review-only-state-invalid");
  }
  for (const forbidden of ["expectedBehavior", "evaluationSplit", "humanGold", "goldLabel"]) {
    if (Object.hasOwn(evidence, forbidden)) errors.push(`gold-dependent-field-forbidden:${forbidden}`);
  }

  const expectedTechniques = expectedScoreNote?.scoreTechniques || [];
  const expectedNotations = expectedScoreNote?.scoreNotations || [];
  const expectedArticulations = expectedScoreNote?.scoreArticulations || [];
  const protectedMarkings = m3plusProtectedMarkings(expectedTechniques, expectedNotations);
  const glissandoMarked = m3plusHasGlissandoMarking(expectedTechniques, expectedNotations);
  const markerMismatch = canonicalJson(normalizeM3PlusMarkings(candidate.scoreTechniques)) !== canonicalJson(expectedTechniques)
    || canonicalJson(normalizeM3PlusMarkings(candidate.scoreNotations)) !== canonicalJson(expectedNotations)
    || canonicalJson(normalizeM3PlusMarkings(candidate.scoreArticulations)) !== canonicalJson(expectedArticulations)
    || canonicalJson(normalizeM3PlusMarkings(evidence.scoreTechniques)) !== canonicalJson(expectedTechniques)
    || canonicalJson(normalizeM3PlusMarkings(evidence.scoreNotations)) !== canonicalJson(expectedNotations)
    || canonicalJson(normalizeM3PlusMarkings(evidence.protectedMarkings)) !== canonicalJson(protectedMarkings)
    || evidence.glissandoMarked !== glissandoMarked;
  if (markerMismatch) {
    errors.push("score-marker-mismatch");
    pushFailure(failures, "feature-review-m3plus-score-marker-mismatch", detail);
  }
  const contextMismatch = candidate.polyphonicScoreRegion !== expectedScoreNote?.polyphonicScoreRegion
    || evidence.polyphonicScoreRegion !== expectedScoreNote?.polyphonicScoreRegion
    || candidate.onsetGroupSize !== expectedScoreNote?.onsetGroupSize
    || candidate.glissandoTargetMidi !== expectedScoreNote?.glissandoTargetMidi
    || candidate.glissandoTargetNoteId !== expectedScoreNote?.glissandoTargetNoteId
    || evidence.glissandoTargetMidi !== expectedScoreNote?.glissandoTargetMidi;
  if (contextMismatch) {
    errors.push("score-context-mismatch");
    pushFailure(failures, "feature-review-m3plus-score-context-mismatch", detail);
  }
  if (typeof evidence.timingAssignmentAvailable !== "boolean"
      || evidence.timingAssignmentAvailable !== candidate.m3plusTimingAssignmentAvailable) {
    errors.push("timing-assignment-state-invalid");
  }

  const windowStart = readM3PlusEvidenceNumber(evidence, "windowStartSeconds", errors);
  const windowEnd = readM3PlusEvidenceNumber(evidence, "windowEndSeconds", errors);
  const totalFrames = readM3PlusEvidenceNumber(evidence, "totalFrameCount", errors, { integer: true, min: 0 });
  const voicedFrames = readM3PlusEvidenceNumber(evidence, "voicedFrameCount", errors, { integer: true, min: 0 });
  const voicedRatio = readM3PlusEvidenceNumber(evidence, "voicedFrameRatio", errors, { min: 0, max: 1 });
  const medianMidi = readM3PlusEvidenceNumber(evidence, "medianObservedMidi", errors);
  const centerError = readM3PlusEvidenceNumber(evidence, "centerErrorCents", errors);
  const spread = readM3PlusEvidenceNumber(evidence, "spreadCentsP95P05", errors, { min: 0 });
  const iqr = readM3PlusEvidenceNumber(evidence, "iqrCents", errors, { min: 0 });
  const targetMidi = readM3PlusEvidenceNumber(evidence, "targetMidi", errors, { integer: true });
  if (totalFrames !== null && voicedFrames !== null && voicedFrames > totalFrames) {
    errors.push("voiced-frame-count-exceeds-total");
  }
  if (totalFrames !== null && voicedFrames !== null && voicedRatio !== null) {
    const expectedRatio = totalFrames > 0 ? voicedFrames / totalFrames : 0;
    if (Math.abs(expectedRatio - voicedRatio) > 0.000001) errors.push("voiced-frame-ratio-inconsistent");
  }
  const windowAvailable = windowStart !== null
    && windowEnd !== null
    && windowEnd > windowStart
    && totalFrames !== null
    && totalFrames > 0;
  if (evidence.windowAvailable !== windowAvailable) errors.push("window-state-inconsistent");
  const expectedTargetMidi = !protectedMarkings.length
    && glissandoMarked
    && expectedScoreNote?.glissandoTargetMidi !== null
    ? expectedScoreNote.glissandoTargetMidi
    : expectedScoreNote?.midi;
  if (targetMidi !== expectedTargetMidi) errors.push("target-midi-mismatch");
  if (medianMidi !== null && targetMidi !== null && centerError !== null) {
    if (Math.abs(((medianMidi - targetMidi) * 100) - centerError) > 0.0001) {
      errors.push("center-error-inconsistent");
    }
  } else if ((medianMidi === null || targetMidi === null) && centerError !== null) {
    errors.push("center-error-without-input");
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
    errors.push("policy-decision-mismatch");
  }
  if (highDispersion && (evidence.decision !== "insufficient_evidence" || evidence.accusationIssued !== false)) {
    pushFailure(failures, "feature-review-m3plus-high-dispersion-leak", detail);
  }
  if (protectedMarkings.length
      && (evidence.zone !== "score_marked_neutral"
        || evidence.decision !== "insufficient_evidence"
        || evidence.accusationIssued !== false)) {
    pushFailure(failures, "feature-review-m3plus-score-marked-accusation", detail);
  }
  if (decision.contractValid !== true
      || decision.evaluationContract !== M3PLUS_EVALUATION_CONTRACT
      || decision.runtimeContract !== M3PLUS_RUNTIME_CONTRACT
      || decision.policyVersion !== M3PLUS_RUNTIME_POLICY_VERSION
      || decision.policySemanticSha256 !== M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256
      || decision.zone !== expectedZone
      || decision.decision !== expectedDecision
      || decision.reason !== expectedReason
      || decision.accusationIssued !== (expectedDecision === "issue_detected")
      || decision.highDispersion !== highDispersion
      || decision.reviewOnly !== true
      || decision.feedbackAuthorized !== false
      || decision.studentFacing !== false
      || !Array.isArray(decision.blockingReasons)
      || decision.blockingReasons.length > 0) {
    errors.push("runtime-decision-mismatch");
  }
  if (errors.length) {
    pushFailure(failures, "feature-review-m3plus-candidate-runtime-invalid", {
      ...detail,
      reasons: [...new Set(errors)],
    });
  }
}

function auditM3PlusRuntime(
  candidateGate,
  rows,
  scoreProvenance,
  scoreBinding,
  sourceRoot,
  failures,
  detail,
  { required = false } = {},
) {
  const runtime = candidateGate?.m3plusPitchSafetyRuntime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    if (required) pushFailure(failures, "feature-review-m3plus-runtime-missing", detail);
    return;
  }
  const safetyStateReady = runtime.reviewOnly === true
    && runtime.feedbackAuthorized === false
    && runtime.authorizationReady === false
    && runtime.studentGateReady === false
    && runtime.studentFacing === false
    && runtime.automaticAdoptionReady === false;
  if (!safetyStateReady) {
    pushFailure(failures, "feature-review-m3plus-runtime-safety-state-invalid", detail);
  }
  if (runtime.contractReady !== true) {
    if (required) {
      pushFailure(failures, "feature-review-m3plus-runtime-not-ready", detail);
    }
    if (runtime.runtimeEvidenceReady === true
        || runtime.reviewOnlyRuntimeWired === true
        || runtime.runtimeFoundationReady === true) {
      pushFailure(failures, "feature-review-m3plus-runtime-false-state-inconsistent", detail);
    }
    for (const [candidateIndex, candidate] of rows.entries()) {
      if (candidate?.feedbackAuthorized === true
          || candidate?.studentFacing === true
          || candidate?.m3plusPitchSafetyEvidence?.feedbackAuthorized === true
          || candidate?.m3plusPitchSafetyEvidence?.studentFacing === true
          || candidate?.m3plusPitchSafetyDecision?.feedbackAuthorized === true
          || candidate?.m3plusPitchSafetyDecision?.studentFacing === true) {
        pushFailure(failures, "feature-review-m3plus-fail-closed-row-leak", { ...detail, candidateIndex });
      }
    }
    return;
  }

  if (!safetyStateReady
      || runtime.evaluationContract !== M3PLUS_EVALUATION_CONTRACT
      || runtime.runtimeContract !== M3PLUS_RUNTIME_CONTRACT
      || runtime.policyVersion !== M3PLUS_RUNTIME_POLICY_VERSION
      || runtime.policySemanticSha256 !== M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256
      || runtime.f0Backend !== M3PLUS_F0_BACKEND
      || canonicalJson(runtime.thresholds || {}) !== canonicalJson(M3PLUS_RUNTIME_THRESHOLDS)
      || canonicalJson(runtime.pyinRuntime || {}) !== canonicalJson(M3PLUS_PYIN_RUNTIME_DESCRIPTOR)
      || runtime.runtimeEvidenceReady !== true
      || runtime.reviewOnlyRuntimeWired !== true
      || runtime.runtimeFoundationReady !== true) {
    pushFailure(failures, "feature-review-m3plus-runtime-contract-invalid", detail);
  }

  const policyBinding = auditPhysicalBoundArtifact(
    sourceRoot,
    runtime.policyArtifactPath,
    runtime.policyArtifactSha256,
    M3PLUS_POLICY_ARTIFACT_PATH,
    "feature-review-m3plus-policy-artifact",
  );
  for (const code of policyBinding.blockingReasons || []) pushFailure(failures, code, detail);
  const observedPolicySemanticSha256 = policyBinding.bytes
    ? crypto.createHash("sha256")
      .update(policyBinding.bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
      .digest("hex")
    : "";
  if (safeString(runtime.policyArtifactSemanticSha256).trim().toLowerCase()
      !== M3PLUS_POLICY_ARTIFACT_SEMANTIC_SHA256
      || observedPolicySemanticSha256 !== M3PLUS_POLICY_ARTIFACT_SEMANTIC_SHA256) {
    pushFailure(failures, "feature-review-m3plus-policy-artifact-code-anchor-mismatch", detail);
  }
  const analyzerBinding = auditPhysicalBoundArtifact(
    sourceRoot,
    runtime.analyzerArtifactPath,
    runtime.analyzerArtifactSha256,
    M3PLUS_ANALYZER_ARTIFACT_PATH,
    "feature-review-m3plus-analyzer-artifact",
  );
  for (const code of analyzerBinding.blockingReasons || []) pushFailure(failures, code, detail);
  const observedAnalyzerSemanticSha256 = analyzerBinding.bytes
    ? crypto.createHash("sha256")
      .update(analyzerBinding.bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
      .digest("hex")
    : "";
  if (safeString(runtime.analyzerArtifactSemanticSha256).trim().toLowerCase()
      !== M3PLUS_ANALYZER_ARTIFACT_SEMANTIC_SHA256
      || observedAnalyzerSemanticSha256 !== M3PLUS_ANALYZER_ARTIFACT_SEMANTIC_SHA256) {
    pushFailure(failures, "feature-review-m3plus-analyzer-artifact-code-anchor-mismatch", detail);
  }
  const rescopeBinding = auditPhysicalBoundArtifact(
    sourceRoot,
    runtime.rescopeReportPath,
    runtime.rescopeReportSha256,
    M3PLUS_RESCOPE_REPORT_PATH,
    "feature-review-m3plus-rescope-report",
  );
  for (const code of rescopeBinding.blockingReasons || []) pushFailure(failures, code, detail);
  if (rescopeBinding.bytes) {
    try {
      const report = JSON.parse(rescopeBinding.bytes.toString("utf8"));
      if (report?.schemaVersion !== 2 || report?.contract !== M3PLUS_EVALUATION_CONTRACT) {
        pushFailure(failures, "feature-review-m3plus-rescope-report-contract-invalid", detail);
      }
      if (runtime.rescopeReleaseGateReady !== (report?.releaseGateReady === true)) {
        pushFailure(failures, "feature-review-m3plus-rescope-release-state-mismatch", detail);
      }
    } catch {
      pushFailure(failures, "feature-review-m3plus-rescope-report-json-invalid", detail);
    }
  }

  const expectedSha256 = scoreBinding?.expectedM3PlusSha256;
  const candidateSha256 = scoreBinding?.candidateM3PlusSha256;
  const identityReady = Boolean(
    scoreBinding?.ready === true
    && expectedSha256
    && expectedSha256 === candidateSha256
    && scoreBinding?.expectedM3PlusNotes?.length === rows.length
  );
  if (!identityReady) pushFailure(failures, "feature-review-m3plus-score-safety-identity-mismatch", detail);
  if (safeString(scoreProvenance?.m3plusPitchSafetyNoteIdentitySha256).trim().toLowerCase() !== expectedSha256) {
    pushFailure(failures, "feature-review-m3plus-score-safety-provenance-sha-mismatch", detail);
  }
  if (runtime.scoreSafetyIdentityReady !== true
      || runtime.scoreSafetyIdentitySha256 !== expectedSha256
      || runtime.candidateScoreSafetyIdentitySha256 !== candidateSha256) {
    pushFailure(failures, "feature-review-m3plus-score-safety-gate-sha-mismatch", detail);
  }

  const decisionCounts = {};
  const zoneCounts = {};
  for (const candidate of rows) {
    const evidence = candidate?.m3plusPitchSafetyEvidence || {};
    const decisionName = safeString(evidence.decision, "unknown");
    const zoneName = safeString(evidence.zone, "unknown");
    decisionCounts[decisionName] = (decisionCounts[decisionName] || 0) + 1;
    zoneCounts[zoneName] = (zoneCounts[zoneName] || 0) + 1;
  }
  if (runtime.expectedScoreNoteCount !== rows.length
      || runtime.evaluatedCandidateCount !== rows.length
      || runtime.validEvidenceCount !== rows.length
      || runtime.invalidEvidenceCount !== 0
      || canonicalJson(runtime.decisionCounts || {}) !== canonicalJson(decisionCounts)
      || canonicalJson(runtime.zoneCounts || {}) !== canonicalJson(zoneCounts)) {
    pushFailure(failures, "feature-review-m3plus-runtime-counts-mismatch", detail);
  }
  for (const [candidateIndex, candidate] of rows.entries()) {
    auditM3PlusCandidate(
      candidate,
      scoreBinding?.expectedM3PlusNotes?.[candidateIndex],
      runtime,
      failures,
      { ...detail, candidateIndex },
    );
  }
}

function auditDynamicCandidate(candidate, failures, {
  runIndex,
  itemIndex,
  candidateIndex,
  source,
}) {
  const detail = { runIndex, itemIndex, candidateIndex, source };
  if (safeString(candidate?.autoDecision) !== "review_required") {
    pushFailure(failures, "feature-review-candidate-not-review-required", {
      ...detail,
      autoDecision: candidate?.autoDecision,
    });
  }
  if (candidate?.studentSafeGateReady !== false) {
    pushFailure(failures, "feature-review-candidate-student-gate-not-false", detail);
  }
  if (candidate?.studentFacing !== false) {
    pushFailure(failures, "feature-review-candidate-student-facing-not-false", detail);
  }
  if (safeString(candidate?.gateDecision) !== "review_required") {
    pushFailure(failures, "feature-review-candidate-gate-decision-not-review", detail);
  }
  if (safeString(candidate?.gateVersion) !== DYNAMIC_GATE_VERSION) {
    pushFailure(failures, "feature-review-candidate-gate-version-mismatch", detail);
  }
  if (safeString(candidate?.gateReason) !== "ordinary-upload-dynamic-shadow-review-only") {
    pushFailure(failures, "feature-review-candidate-gate-reason-mismatch", detail);
  }
  const decision = candidate?.dynamicShadowDecision || {};
  if (decision.contractVersion !== DYNAMIC_CONTRACT_VERSION
      || decision.policyVersion !== DYNAMIC_POLICY_VERSION
      || decision.timingMode !== DYNAMIC_TIMING_MODE
      || decision.contractValid !== true
      || decision.authorization !== "telemetry_only"
      || decision.energyVetoIncluded !== false
      || decision.causalEnergyStatus !== "excluded-review-only") {
    pushFailure(failures, "feature-review-candidate-dynamic-contract-invalid", detail);
  }
  const m3plusDecision = safeString(candidate?.m3plusPitchSafetyEvidence?.decision);
  const strictConfirmedIssue = m3plusDecision === "issue_detected";
  const selfCheckHint = !strictConfirmedIssue
    && candidate?.m3plusTimingAssignmentAvailable !== true;
  const expectedSemantic = strictConfirmedIssue
    ? "confirmed_issue"
    : selfCheckHint
      ? "self_check_hint"
      : "no_issue_output";
  const reviewAssist = candidate?.reviewAssistDecision || {};
  if (reviewAssist.contract !== REVIEW_ASSIST_CONTRACT
      || reviewAssist.outputSemantic !== expectedSemantic
      || reviewAssist.reviewerOnly !== true
      || reviewAssist.requiresHumanReview !== (expectedSemantic !== "no_issue_output")
      || reviewAssist.automaticAccusationAuthorized !== false
      || reviewAssist.studentFacing !== false) {
    pushFailure(failures, "feature-review-candidate-review-assist-invalid", detail);
  }
}

export function auditFeatureReviewItem(item = {}, {
  runIndex = 0,
  itemIndex = 0,
  sourceRoot = "",
  batchRunId = "",
  requireM3PlusRuntime = false,
} = {}) {
  const failures = [];
  const summary = item.analysisSummary || {};
  const candidates = Array.isArray(item.candidatePreview) ? item.candidatePreview : [];
  const candidateRowCount = asNumber(item.candidateRowCount, 0);
  const candidateGate = item.candidateGate || {};
  const scoreProvenance = candidateGate.scoreProvenance || {};
  const candidateRowsPath = safeString(item.candidateRowsPath);
  const candidateRowsSha256 = safeString(item.candidateRowsSha256).trim().toLowerCase();

  if (item.autoDiagnosisIssued !== false) {
    pushFailure(failures, "feature-review-issued-auto-diagnosis", { runIndex, itemIndex });
  }
  if (!candidateGate || typeof candidateGate !== "object" || Array.isArray(candidateGate)) {
    pushFailure(failures, "feature-review-candidate-gate-missing", { runIndex, itemIndex });
  } else {
    if (candidateGate.ready !== false) {
      pushFailure(failures, "feature-review-candidate-gate-ready-not-false", {
        runIndex,
        itemIndex,
        ready: candidateGate.ready,
      });
    }
    if (candidateGate.authorizationReady !== false
        || candidateGate.automaticAdoptionAuthorized !== false
        || candidateGate.studentSafeGateReady !== false
        || candidateGate.studentFacing !== false
        || candidateGate.mode !== "dynamic_shadow_review_only"
        || candidateGate.gateVersion !== DYNAMIC_GATE_VERSION
        || candidateGate.contractVersion !== DYNAMIC_CONTRACT_VERSION
        || candidateGate.policyVersion !== DYNAMIC_POLICY_VERSION
        || candidateGate.timingMode !== DYNAMIC_TIMING_MODE
        || candidateGate.contractReady !== true) {
      pushFailure(failures, "feature-review-dynamic-gate-contract-invalid", { runIndex, itemIndex });
    }
    if (candidateGate.energyVetoIncluded !== false
        || candidateGate.causalEnergyStatus !== "excluded-review-only") {
      pushFailure(failures, "feature-review-dynamic-energy-state-invalid", { runIndex, itemIndex });
    }
    const reviewAssist = candidateGate.reviewAssist || {};
    if (reviewAssist.contract !== REVIEW_ASSIST_CONTRACT
        || reviewAssist.reviewerOnly !== true
        || reviewAssist.studentFacing !== false
        || reviewAssist.automaticAccusationAuthorized !== false) {
      pushFailure(failures, "feature-review-gate-review-assist-invalid", { runIndex, itemIndex });
    }
    if (candidateGate.cacheProvenanceReady !== true
        || candidateGate.cacheArtifactVerified !== true
        || candidateGate.scoreProvenanceReady !== true
        || candidateGate.runtimeAttestationReady !== true) {
      pushFailure(failures, "feature-review-provenance-not-ready", { runIndex, itemIndex });
    }
    const cache = candidateGate.basicPitchCacheProvenance || {};
    if (cache.identityBound !== true
        || !/^[a-f0-9]{64}$/.test(safeString(cache.audioSha256))
        || !/^[a-f0-9]{64}$/.test(safeString(cache.cacheArtifactSha256))
        || cache.modelArtifactSha256 !== BASIC_PITCH_MODEL_ARTIFACT_SHA256
        || cache.runtimeId !== ORDINARY_AUDIO_RUNTIME_ID
        || cache.runtimeConfigSemanticSha256 !== ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256
        || cache.runtimeRequirementsLockSha256 !== ORDINARY_AUDIO_RUNTIME_LOCK_SHA256) {
      pushFailure(failures, "feature-review-cache-provenance-invalid", { runIndex, itemIndex });
    }
    if (safeString(cache.audioSha256).trim().toLowerCase()
        !== safeString(item.analysisAudioSha256).trim().toLowerCase()) {
      pushFailure(failures, "feature-review-cache-audio-sha-item-mismatch", { runIndex, itemIndex });
    }
    const score = scoreProvenance;
    if (!/^[a-f0-9]{64}$/.test(safeString(score.scorePayloadSha256))
        || !/^[a-f0-9]{64}$/.test(safeString(score.scoreStoreArtifactSha256))
        || !/^[a-f0-9]{64}$/.test(safeString(score.noteIdentitySha256))
        || !safeString(score.scoreId)) {
      pushFailure(failures, "feature-review-score-provenance-invalid", { runIndex, itemIndex });
    }
    if (safeString(score.scoreId).trim() !== safeString(item.scoreId).trim()) {
      pushFailure(failures, "feature-review-score-id-item-mismatch", { runIndex, itemIndex });
    }
    if (!Number.isInteger(score.noteCount)
        || score.noteCount <= 0
        || candidateGate.expectedScoreNoteCount !== score.noteCount
        || candidateGate.completeScoreCoverage !== true
        || candidateGate.scoreNoteIdentityReady !== true
        || candidateGate.scoreNoteIdentitySha256 !== score.noteIdentitySha256
        || !/^[a-f0-9]{64}$/.test(safeString(candidateGate.candidateNoteIdentitySha256))
        || candidateGate.candidateNoteIdentitySha256 !== score.noteIdentitySha256
        || candidateRowCount !== score.noteCount) {
      pushFailure(failures, "feature-review-incomplete-score-coverage", {
        runIndex,
        itemIndex,
        candidateRowCount,
        scoreNoteCount: score.noteCount,
        expectedScoreNoteCount: candidateGate.expectedScoreNoteCount,
      });
    }
    if (candidateGate.rfTelemetry?.authorizationIgnored !== true) {
      pushFailure(failures, "feature-review-rf-telemetry-authorization-not-ignored", { runIndex, itemIndex });
    }
    const runtimeAttestation = candidateGate.runtimeAttestation || {};
    if (runtimeAttestation.ready !== true
        || runtimeAttestation.runtimeId !== ORDINARY_AUDIO_RUNTIME_ID
        || runtimeAttestation.configSemanticSha256 !== ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256
        || runtimeAttestation.requirementsLockSha256 !== ORDINARY_AUDIO_RUNTIME_LOCK_SHA256
        || runtimeAttestation.modelArtifactSha256 !== BASIC_PITCH_MODEL_ARTIFACT_SHA256
        || runtimeAttestation.studentFacing !== false
        || runtimeAttestation.automaticAdoptionAuthorized !== false) {
      pushFailure(failures, "feature-review-runtime-attestation-invalid", { runIndex, itemIndex });
    }
    if (asNumber(candidateGate.autoPassCandidateCount, 0) !== 0) {
      pushFailure(failures, "feature-review-candidate-gate-auto-pass-nonzero", {
        runIndex,
        itemIndex,
        autoPassCandidateCount: candidateGate.autoPassCandidateCount,
      });
    }
    if (asNumber(candidateGate.evaluatedCandidateCount, 0) !== candidateRowCount) {
      pushFailure(failures, "feature-review-candidate-gate-count-mismatch", {
        runIndex,
        itemIndex,
        evaluatedCandidateCount: candidateGate.evaluatedCandidateCount,
        candidateRowCount,
      });
    }
    if (safeString(candidateGate.reason) !== "ordinary-upload-dynamic-shadow-review-only") {
      pushFailure(failures, "feature-review-candidate-gate-reason-mismatch", { runIndex, itemIndex });
    }
  }
  if (asNumber(summary.autoPassCount, 0) !== 0) {
    pushFailure(failures, "feature-review-summary-auto-pass-nonzero", {
      runIndex,
      itemIndex,
      autoPassCount: summary.autoPassCount,
    });
  }
  if (summary.studentFacing !== false) {
    pushFailure(failures, "feature-review-summary-student-facing", { runIndex, itemIndex });
  }
  if (summary.studentSafeGateReady !== false
      || summary.studentSafeCandidateGateReady !== false
      || summary.autoDiagnosisIssued !== false
      || summary.automaticAdoptionAuthorized !== false
      || asNumber(summary.coverage, -1) !== 0) {
    pushFailure(failures, "feature-review-summary-student-gate-ready", { runIndex, itemIndex });
  }
  if (candidateRowCount <= 0) {
    pushFailure(failures, "feature-review-candidate-rows-missing", { runIndex, itemIndex });
  }
  if (!candidateRowsPath) {
    pushFailure(failures, "feature-review-candidate-rows-path-missing", { runIndex, itemIndex });
  } else if (sourceRoot) {
    const artifactPath = path.resolve(sourceRoot, candidateRowsPath);
    const relativeArtifactPath = path.relative(path.resolve(sourceRoot), artifactPath);
    if (relativeArtifactPath.startsWith("..") || path.isAbsolute(relativeArtifactPath)) {
      pushFailure(failures, "feature-review-candidate-rows-artifact-outside-root", {
        runIndex,
        itemIndex,
        candidateRowsPath,
      });
    } else if (!fsSync.existsSync(artifactPath)) {
      pushFailure(failures, "feature-review-candidate-rows-artifact-missing", {
        runIndex,
        itemIndex,
        candidateRowsPath,
      });
    } else {
      try {
        const realSourceRoot = fsSync.realpathSync(path.resolve(sourceRoot));
        const realArtifactPath = fsSync.realpathSync(artifactPath);
        const normalizedBatchRunId = safeString(batchRunId).trim();
        const normalizedSubmissionId = safeString(item.submissionId).trim();
        const safeSubmissionId = normalizedSubmissionId.replace(/[^A-Za-z0-9_.-]/g, "_");
        if (!/^[A-Za-z0-9_.-]+$/.test(normalizedBatchRunId) || !normalizedSubmissionId) {
          pushFailure(failures, "feature-review-candidate-artifact-identity-invalid", { runIndex, itemIndex });
        }
        const expectedArtifactPath = path.join(
          realSourceRoot,
          "data",
          "experiments",
          "western-strings-m3",
          "offline-feature-candidates",
          normalizedBatchRunId,
          `${safeSubmissionId}.json`,
        );
        if (!samePath(realArtifactPath, expectedArtifactPath)) {
          pushFailure(failures, "feature-review-candidate-rows-artifact-path-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
        const artifactBytes = fsSync.readFileSync(realArtifactPath);
        const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
        const artifact = JSON.parse(artifactBytes.toString("utf8"));
        const rows = Array.isArray(artifact.candidateRows) ? artifact.candidateRows : [];
        if (safeString(artifact.batchRunId).trim() !== normalizedBatchRunId
            || safeString(artifact.submissionId).trim() !== normalizedSubmissionId) {
          pushFailure(failures, "feature-review-candidate-rows-artifact-identity-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
        if (!/^[a-f0-9]{64}$/.test(candidateRowsSha256) || artifactSha256 !== candidateRowsSha256) {
          pushFailure(failures, "feature-review-candidate-rows-artifact-sha-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
        if (asNumber(artifact.rowCount, -1) !== candidateRowCount || rows.length !== candidateRowCount) {
          pushFailure(failures, "feature-review-candidate-rows-artifact-count-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
            artifactRowCount: artifact.rowCount,
            artifactRowsLength: rows.length,
            candidateRowCount,
          });
        }
        if (JSON.stringify(artifact.candidateGate || null) !== JSON.stringify(candidateGate)) {
          pushFailure(failures, "feature-review-candidate-rows-artifact-gate-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
        const scoreBinding = auditPhysicalScoreBinding(realSourceRoot, scoreProvenance, rows);
        for (const reason of scoreBinding.blockingReasons || []) {
          pushFailure(failures, reason, {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
        if (scoreBinding.ready === true
            && (scoreBinding.expectedSha256 !== candidateGate.scoreNoteIdentitySha256
              || scoreBinding.candidateSha256 !== candidateGate.candidateNoteIdentitySha256)) {
          pushFailure(failures, "feature-review-score-note-identity-gate-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
        auditM3PlusRuntime(
          candidateGate,
          rows,
          scoreProvenance,
          scoreBinding,
          realSourceRoot,
          failures,
          { runIndex, itemIndex, candidateRowsPath },
          { required: requireM3PlusRuntime },
        );
        for (const [candidateIndex, candidate] of rows.entries()) {
          auditDynamicCandidate(candidate, failures, {
            runIndex,
            itemIndex,
            candidateIndex,
            source: "artifact",
          });
        }
        const confirmedIssueCandidateCount = rows.filter(
          (candidate) => candidate?.reviewAssistDecision?.outputSemantic === "confirmed_issue",
        ).length;
        const selfCheckHintCount = rows.filter(
          (candidate) => candidate?.reviewAssistDecision?.outputSemantic === "self_check_hint",
        ).length;
        const outputCount = confirmedIssueCandidateCount + selfCheckHintCount;
        const reviewAssist = candidateGate.reviewAssist || {};
        if (reviewAssist.confirmedIssueCandidateCount !== confirmedIssueCandidateCount
            || reviewAssist.selfCheckHintCount !== selfCheckHintCount
            || reviewAssist.outputCount !== outputCount
            || summary.reviewAssist?.confirmedIssueCandidateCount !== confirmedIssueCandidateCount
            || summary.reviewAssist?.selfCheckHintCount !== selfCheckHintCount
            || summary.reviewAssist?.outputCount !== outputCount) {
          pushFailure(failures, "feature-review-review-assist-counts-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
        const expectedPreview = rows
          .filter((candidate) => candidate?.reviewAssistDecision?.requiresHumanReview === true)
          .slice(0, 20)
          .map((candidate) => ({
            noteId: safeString(candidate.noteId),
            noteIndex: Number(candidate.noteIndex),
            measureIndex: Number(candidate.measureIndex),
            beatStart: Number(candidate.beatStart),
            midi: candidate.midi == null ? null : Number(candidate.midi),
            predictedOnsetSeconds: candidate.predictedOnsetSeconds == null
              ? null
              : Number(candidate.predictedOnsetSeconds),
            ...candidate.reviewAssistDecision,
          }));
        if (JSON.stringify(item.reviewAssistPreview || []) !== JSON.stringify(expectedPreview)) {
          pushFailure(failures, "feature-review-review-assist-preview-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
          });
        }
      } catch (error) {
        pushFailure(failures, "feature-review-candidate-rows-artifact-invalid", {
          runIndex,
          itemIndex,
          candidateRowsPath,
          error: String(error?.message || error),
        });
      }
    }
  }
  if (!candidates.length) {
    pushFailure(failures, "feature-review-candidate-preview-missing", { runIndex, itemIndex });
  }
  for (const [candidateIndex, candidate] of candidates.entries()) {
    auditDynamicCandidate(candidate, failures, {
      runIndex,
      itemIndex,
      candidateIndex,
      source: "preview",
    });
  }

  return failures;
}

function selectBatchRunsForAudit(runs = [], { latestOnly = false } = {}) {
  if (!latestOnly) return runs;
  return runs.length ? [runs[runs.length - 1]] : [];
}

export function auditControlledBatchRuns(runs = [], options = {}) {
  const {
    requireFeatureReview = false,
    sourceRoot = "",
    latestOnly = false,
  } = options;
  const requireM3PlusRuntime = options.requireM3PlusRuntime ?? latestOnly;
  const failures = [];
  let runCount = 0;
  let featureReviewItemCount = 0;
  let candidateRowCount = 0;

  const selectedRuns = selectBatchRunsForAudit(runs, { latestOnly });
  const selectedRunIds = [];
  for (const [runIndex, run] of selectedRuns.entries()) {
    if (run?._invalidJsonLine) {
      pushFailure(failures, "invalid-jsonl-line", { runIndex, line: run._invalidJsonLine, error: run._error });
      continue;
    }
    runCount += 1;
    const batchRunId = safeString(run.batchRunId).trim();
    if (batchRunId) selectedRunIds.push(batchRunId);
    if (run.autoDiagnosisIssued !== false && Array.isArray(run.items) && run.items.length) {
      pushFailure(failures, "batch-run-issued-auto-diagnosis", { runIndex });
    }
    for (const [itemIndex, item] of (Array.isArray(run.items) ? run.items : []).entries()) {
      if (item.autoDiagnosisIssued !== false) {
        pushFailure(failures, "batch-item-issued-auto-diagnosis", { runIndex, itemIndex });
      }
      if (item.studentFacing === true || item.analysisSummary?.studentFacing === true) {
        pushFailure(failures, "batch-item-student-facing", { runIndex, itemIndex });
      }
      const ordinaryItem = safeString(item.kind).trim() !== "photo-score";
      if (ordinaryItem && (item.analysisStatus === "offline_analysis_ready"
          || (item.offlineAnalysisProduced === true
            && item.analysisStatus !== "offline_feature_review_ready"))) {
        pushFailure(failures, "batch-item-legacy-ordinary-analysis-status", {
          runIndex,
          itemIndex,
          analysisStatus: item.analysisStatus,
        });
      }
      if (item.analysisStatus !== "offline_feature_review_ready") continue;
      featureReviewItemCount += 1;
      candidateRowCount += asNumber(item.candidateRowCount, 0);
      failures.push(...auditFeatureReviewItem(item, {
        runIndex,
        itemIndex,
        sourceRoot,
        batchRunId,
        requireM3PlusRuntime,
      }));
    }
  }

  if (requireFeatureReview && featureReviewItemCount === 0) {
    pushFailure(failures, "no-feature-review-items-found");
  }

  return {
    ok: failures.length === 0,
    scoreBindingMode: ORDINARY_DYNAMIC_SCORE_BINDING_MODE,
    runCount,
    auditedRunMode: latestOnly ? "latest" : "all",
    m3plusRuntimeRequired: requireM3PlusRuntime,
    auditedBatchRunIds: selectedRunIds,
    featureReviewItemCount,
    candidateRowCount,
    failures,
  };
}

function parseArgs(argv) {
  const args = {
    source: path.join("data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"),
    out: "",
    requireFeatureReview: true,
    allRuns: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") args.source = argv[++index] || args.source;
    else if (arg === "--out") args.out = argv[++index] || "";
    else if (arg === "--require-feature-review") args.requireFeatureReview = true;
    else if (arg === "--allow-no-feature-review") args.requireFeatureReview = false;
    else if (arg === "--all-runs") args.allRuns = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(process.cwd(), args.source);
  const report = auditControlledBatchRuns(await readJsonl(source), {
    requireFeatureReview: args.requireFeatureReview,
    sourceRoot: process.cwd(),
    latestOnly: !args.allRuns,
  });
  report.source = path.relative(process.cwd(), source).replace(/\\/g, "/");
  if (args.out) {
    const out = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
