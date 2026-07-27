#!/usr/bin/env node
// Live-artifact verifier for the ordinary-dynamic-shadow r3 acceptance.
//
// The acceptance report may only stay green while every artifact it cites is
// still physically present, hash-identical, identity-bound to the attested
// runtime, and internally consistent: shadow decisions must be recomputable
// from the stored features under the frozen policy. A hand-written or
// tampered report therefore fails closed here even when its schema and
// self-digest look correct. This acceptance is implementation acceptance
// only (preGateOnly); it never authorizes the student runtime.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  ORDINARY_AUDIO_RUNTIME_ANCHORS,
  evaluateOrdinaryAudioRuntime,
} from "./run-western-ordinary-audio-python.mjs";

export const ORDINARY_DYNAMIC_CONTRACT_VERSION = "western-ordinary-dynamic-shadow-candidate-v1";
export const ORDINARY_DYNAMIC_POLICY_VERSION = "western-ordinary-dynamic-shadow-policy-v1";
export const ORDINARY_DYNAMIC_GATE_VERSION = "western-ordinary-dynamic-shadow-gate-v1-review-only";
export const ORDINARY_DYNAMIC_ACCEPTANCE_VERSION = "western-ordinary-dynamic-shadow-r3-acceptance-v2";
export const ORDINARY_DYNAMIC_TIMING_MODE = "basic-pitch-dtw";
export const ORDINARY_DYNAMIC_LIVE_VERIFIER_CONTRACT =
  "western-ordinary-dynamic-shadow-live-artifact-verifier-v2";
export const ORDINARY_DYNAMIC_SCORE_BINDING_MODE =
  "referenced-score-payload-and-note-identity-v1";
export const ORDINARY_DYNAMIC_CANDIDATE_EVIDENCE_CONTRACT =
  "western-ordinary-dynamic-shadow-candidate-evidence-v1";
export const ORDINARY_DYNAMIC_ANALYSIS_MODE = "basic-pitch-dtw-pyin-review-v1";
export const BASIC_PITCH_CACHE_SCHEMA_VERSION = 3;
export const BASIC_PITCH_INFERENCE_VERSION = "default-frequency-range-g3-a7-min-note-80ms-v1";
export const ACCEPTANCE_REPORT_RELATIVE_PATH = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "ordinary-dynamic-shadow-r3-acceptance",
  "report.json",
);

// Frozen shadow policy (mirror of western_strings_dynamic_shadow_policy.py).
export const DYNAMIC_SHADOW_POLICY = Object.freeze({
  deviationLimit: 0.15,
  minEventConfidence: 0.4,
  minRelativeEventConfidence: 0.8,
  minEventDurationSeconds: 0.08,
  minSamePitchScoreDistanceQuarters: 0.5,
  minEventDurationRatio: 0.15,
});

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || "").trim().toLowerCase());
}

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(value).trim() !== "" ? numeric : null;
}

// Exact port of evaluate_dynamic_shadow() so a report's per-row `selected`
// flags can be independently recomputed from the stored features.
export function evaluateDynamicShadowPolicy(features = {}) {
  const blockers = [];
  const pitchDistance = finiteOrNull(features.pitchDistanceSemitones);
  if (pitchDistance === null) blockers.push("pitch-distance-missing");
  else if (pitchDistance !== 0) blockers.push("pitch-distance-not-zero");
  const checks = [
    ["eventConfidence", "minEventConfidence", "event-confidence"],
    ["relativeEventConfidence", "minRelativeEventConfidence", "relative-event-confidence"],
    ["eventDurationSeconds", "minEventDurationSeconds", "event-duration"],
    ["eventDurationRatio", "minEventDurationRatio", "event-duration-ratio"],
  ];
  for (const [field, threshold, reason] of checks) {
    const value = finiteOrNull(features[field]);
    if (value === null) blockers.push(`${reason}-missing`);
    else if (value < DYNAMIC_SHADOW_POLICY[threshold]) blockers.push(`${reason}-below-minimum`);
  }
  const deviation = finiteOrNull(features.relativeIoiDeviationRatio);
  if (deviation === null) blockers.push("relative-ioi-deviation-missing");
  else if (deviation > DYNAMIC_SHADOW_POLICY.deviationLimit) {
    blockers.push("relative-ioi-deviation-above-maximum");
  }
  if (!Object.hasOwn(features, "nearestSamePitchScoreDistanceQuarters")) {
    blockers.push("same-pitch-distance-missing");
  } else if (features.nearestSamePitchScoreDistanceQuarters !== null) {
    const samePitch = finiteOrNull(features.nearestSamePitchScoreDistanceQuarters);
    if (samePitch === null) blockers.push("same-pitch-distance-invalid");
    else if (samePitch < DYNAMIC_SHADOW_POLICY.minSamePitchScoreDistanceQuarters) {
      blockers.push("same-pitch-distance-below-minimum");
    }
  }
  return { selected: blockers.length === 0, blockingReasons: blockers };
}

export function readWorkspaceArtifactSync(repoRoot, relativePath) {
  const value = String(relativePath || "").trim();
  if (!value || path.isAbsolute(value)) return { bytes: null, sha256: "", status: "path-invalid" };
  try {
    const realRoot = fs.realpathSync(path.resolve(repoRoot));
    const realArtifact = fs.realpathSync(path.resolve(realRoot, value));
    const relative = path.relative(realRoot, realArtifact);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return { bytes: null, sha256: "", status: "outside-workspace" };
    }
    const before = fs.readFileSync(realArtifact);
    const after = fs.readFileSync(realArtifact);
    const beforeSha256 = sha256Bytes(before);
    if (beforeSha256 !== sha256Bytes(after)) return { bytes: null, sha256: "", status: "changed-during-read" };
    return { bytes: after, sha256: beforeSha256, status: "ok" };
  } catch {
    return { bytes: null, sha256: "", status: "unreadable" };
  }
}

export function loadScoreStore(repoRoot) {
  const sqliteRelative = path.join("data", "erhu-score-imports.sqlite");
  const jsonRelative = path.join("data", "erhu-score-imports.json");
  const relativePath = fs.existsSync(path.resolve(repoRoot, sqliteRelative))
    ? sqliteRelative
    : jsonRelative;
  const artifact = readWorkspaceArtifactSync(repoRoot, relativePath);
  if (artifact.status !== "ok") {
    return { ok: false, status: artifact.status, path: relativePath.replace(/\\/g, "/") };
  }
  let scores = [];
  try {
    if (relativePath.endsWith(".sqlite")) {
      const db = new DatabaseSync(path.resolve(repoRoot, relativePath), { readOnly: true });
      try {
        scores = db
          .prepare("SELECT payload FROM imported_scores WHERE archived = 0 ORDER BY updated_at DESC")
          .all()
          .map((row) => JSON.parse(String(row.payload || "{}")));
      } finally {
        db.close();
      }
    } else {
      scores = JSON.parse(artifact.bytes.toString("utf8"))?.scores || [];
    }
  } catch {
    return { ok: false, status: "store-parse-failed", path: relativePath.replace(/\\/g, "/") };
  }
  const afterArtifact = readWorkspaceArtifactSync(repoRoot, relativePath);
  if (afterArtifact.status !== "ok" || afterArtifact.sha256 !== artifact.sha256) {
    return {
      ok: false,
      status: "changed-during-audit",
      path: relativePath.replace(/\\/g, "/"),
    };
  }
  return {
    ok: true,
    path: relativePath.replace(/\\/g, "/"),
    sha256: artifact.sha256,
    scores,
  };
}

export function scoreNoteCount(score) {
  let count = 0;
  for (const section of score?.sections || []) {
    for (const note of section?.notes || []) {
      const midi = Math.round(Number(note?.midiPitch) || 0);
      if (midi > 0) count += 1;
    }
  }
  return count;
}

export function computeCandidateEvidenceSha256(payload) {
  const summary = payload?.summary || {};
  const cache = payload?.basicPitchCacheProvenance || {};
  const scoreProvenance = payload?.scoreProvenance || {};
  return sha256Canonical({
    contract: ORDINARY_DYNAMIC_CANDIDATE_EVIDENCE_CONTRACT,
    contractVersion: summary.dynamicShadowContractVersion || null,
    policyVersion: summary.dynamicShadowPolicyVersion || null,
    timingMode: ORDINARY_DYNAMIC_TIMING_MODE,
    scoreId: scoreProvenance.scoreId || null,
    audioSha256: cache.audioSha256 || null,
    scorePayloadSha256: scoreProvenance.scorePayloadSha256 || null,
    scoreStoreArtifactSha256: scoreProvenance.scoreStoreArtifactSha256 || null,
    modelArtifactSha256: cache.modelArtifactSha256 || null,
    candidateRows: payload?.candidateRows || null,
  });
}

// Audits one offline-analysis payload (a cold or warm run artifact) without
// trusting any of its aggregate claims: counts and selections are re-derived
// from the rows, and every shadow decision is recomputed from its features.
export function auditCandidateRunPayload(payload, expected = {}) {
  const anchors = ORDINARY_AUDIO_RUNTIME_ANCHORS;
  const reasons = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, blockingReasons: ["candidate-payload-invalid"], derived: null };
  }
  if (payload.ok !== true) reasons.push("candidate-payload-not-ok");
  const summary = payload.summary || {};
  const rows = Array.isArray(payload.candidateRows) ? payload.candidateRows : [];
  const cache = payload.basicPitchCacheProvenance || {};
  const scoreProvenance = payload.scoreProvenance || {};
  const attestation = payload.runtimeAttestation || {};
  if (
    attestation.ready !== true
    || attestation.runtimeId !== anchors.runtimeId
    || attestation.configSemanticSha256 !== anchors.configSemanticSha256
    || attestation.requirementsLockSha256 !== anchors.requirementsLockSha256
    || attestation.modelArtifactSha256 !== anchors.modelTreeSha256
    || attestation.studentFacing !== false
    || attestation.automaticAdoptionAuthorized !== false
  ) {
    reasons.push("candidate-runtime-attestation-invalid");
  }
  if (summary.analysisMode !== ORDINARY_DYNAMIC_ANALYSIS_MODE) reasons.push("candidate-analysis-mode-invalid");
  if (
    summary.dynamicShadowContractVersion !== ORDINARY_DYNAMIC_CONTRACT_VERSION
    || summary.dynamicShadowPolicyVersion !== ORDINARY_DYNAMIC_POLICY_VERSION
    || summary.dynamicShadowEnergyVetoIncluded !== false
  ) {
    reasons.push("candidate-shadow-versions-invalid");
  }
  if (summary.studentFacing !== false || summary.studentSafeGateReady !== false || summary.autoPassCount !== 0) {
    reasons.push("candidate-summary-fail-closed-invalid");
  }
  if (!rows.length) reasons.push("candidate-rows-missing");
  if (
    summary.candidateRowCount !== rows.length
    || summary.reviewRequiredCount !== rows.length
    || summary.noteCount !== rows.length
  ) {
    reasons.push("candidate-row-count-mismatch");
  }
  if (expected.scoreId && String(scoreProvenance.scoreId || "") !== String(expected.scoreId)) {
    reasons.push("candidate-score-id-mismatch");
  }
  if (!isSha256(scoreProvenance.scorePayloadSha256) || !isSha256(scoreProvenance.scoreStoreArtifactSha256)) {
    reasons.push("candidate-score-provenance-sha-invalid");
  }
  if (Number(scoreProvenance.noteCount) !== rows.length) reasons.push("candidate-score-note-count-mismatch");
  if (
    cache.cacheSource !== "content-addressed-cache"
    || cache.identityBound !== true
    || typeof cache.cacheHit !== "boolean"
    || !isSha256(cache.cacheArtifactSha256)
    || !isSha256(cache.audioSha256)
    || cache.modelArtifactSha256 !== anchors.modelTreeSha256
    || cache.runtimeId !== anchors.runtimeId
    || cache.runtimeConfigSemanticSha256 !== anchors.configSemanticSha256
    || cache.runtimeRequirementsLockSha256 !== anchors.requirementsLockSha256
    || cache.inferenceVersion !== BASIC_PITCH_INFERENCE_VERSION
    || cache.policyVersion !== ORDINARY_DYNAMIC_POLICY_VERSION
  ) {
    reasons.push("candidate-cache-provenance-invalid");
  }
  let selectedCount = 0;
  let exactPitchSelectedCount = 0;
  rows.forEach((row, index) => {
    const shadow = row?.dynamicShadowEvidence;
    if (
      row?.noteIndex !== index
      || row?.autoDecision !== "review_required"
      || row?.studentFacing !== false
      || row?.feedbackAuthorized !== false
      || row?.studentSafeGateReady !== false
      || !shadow
      || typeof shadow !== "object"
      || Array.isArray(shadow)
    ) {
      reasons.push(`candidate-row-invalid:${index}`);
      return;
    }
    if (
      shadow.contractVersion !== ORDINARY_DYNAMIC_CONTRACT_VERSION
      || shadow.policyVersion !== ORDINARY_DYNAMIC_POLICY_VERSION
      || shadow.timingMode !== ORDINARY_DYNAMIC_TIMING_MODE
      || shadow.energyVetoIncluded !== false
      || shadow.causalEnergyStatus !== "excluded-review-only"
      || typeof shadow.selected !== "boolean"
    ) {
      reasons.push(`candidate-row-shadow-contract-invalid:${index}`);
      return;
    }
    const recomputed = evaluateDynamicShadowPolicy(shadow);
    if (recomputed.selected !== shadow.selected) {
      reasons.push(`candidate-row-policy-recompute-mismatch:${index}`);
      return;
    }
    if (shadow.selected) {
      selectedCount += 1;
      if (finiteOrNull(shadow.pitchDistanceSemitones) === 0) exactPitchSelectedCount += 1;
      else reasons.push(`candidate-row-selected-pitch-not-exact:${index}`);
    }
  });
  if (summary.dynamicShadowSelectedCount !== selectedCount) reasons.push("candidate-selected-count-mismatch");
  return {
    ok: reasons.length === 0,
    blockingReasons: [...new Set(reasons)],
    derived: {
      scoreId: String(scoreProvenance.scoreId || ""),
      scorePayloadSha256: String(scoreProvenance.scorePayloadSha256 || "").toLowerCase(),
      scoreStoreArtifactSha256: String(scoreProvenance.scoreStoreArtifactSha256 || "").toLowerCase(),
      audioSha256: String(cache.audioSha256 || "").toLowerCase(),
      modelArtifactSha256: String(cache.modelArtifactSha256 || "").toLowerCase(),
      cacheHit: cache.cacheHit === true,
      cacheIdentityBound: cache.identityBound === true,
      cacheArtifactSha256: String(cache.cacheArtifactSha256 || "").toLowerCase(),
      cachePath: String(cache.cachePath || "").replace(/\\/g, "/"),
      candidateRowCount: rows.length,
      reviewRequiredCount: rows.length,
      autoPassCount: 0,
      selectedCount,
      exactPitchSelectedCount,
      candidateEvidenceSha256: computeCandidateEvidenceSha256(payload),
    },
  };
}

function auditRunAgainstDisk({ repoRoot, recording, run, label, prefix, fail }) {
  const anchors = ORDINARY_AUDIO_RUNTIME_ANCHORS;
  const cacheArtifact = readWorkspaceArtifactSync(repoRoot, run?.cachePath);
  if (cacheArtifact.status !== "ok") {
    fail(`${prefix}:${label}-cache-artifact-${cacheArtifact.status}`);
  } else {
    if (cacheArtifact.sha256 !== String(run?.cacheArtifactSha256 || "").toLowerCase()) {
      fail(`${prefix}:${label}-cache-artifact-stale`);
    }
    try {
      const cachePayload = JSON.parse(cacheArtifact.bytes.toString("utf8"));
      const identity = cachePayload?.cacheIdentity || {};
      if (
        cachePayload?.schemaVersion !== BASIC_PITCH_CACHE_SCHEMA_VERSION
        || String(identity.audioSha256 || "").toLowerCase() !== String(recording?.audioSha256 || "").toLowerCase()
        || identity.modelArtifactSha256 !== anchors.modelTreeSha256
        || identity.runtimeId !== anchors.runtimeId
        || identity.runtimeConfigSemanticSha256 !== anchors.configSemanticSha256
        || identity.runtimeRequirementsLockSha256 !== anchors.requirementsLockSha256
        || identity.inferenceVersion !== BASIC_PITCH_INFERENCE_VERSION
        || identity.policyVersion !== ORDINARY_DYNAMIC_POLICY_VERSION
      ) {
        fail(`${prefix}:${label}-cache-identity-invalid`);
      }
    } catch {
      fail(`${prefix}:${label}-cache-artifact-unparseable`);
    }
  }

  const candidateArtifact = readWorkspaceArtifactSync(repoRoot, run?.candidateArtifactPath);
  if (candidateArtifact.status !== "ok") {
    fail(`${prefix}:${label}-candidate-artifact-${candidateArtifact.status}`);
    return;
  }
  if (candidateArtifact.sha256 !== String(run?.candidateArtifactSha256 || "").toLowerCase()) {
    fail(`${prefix}:${label}-candidate-artifact-stale`);
  }
  let payload;
  try {
    payload = JSON.parse(candidateArtifact.bytes.toString("utf8"));
  } catch {
    fail(`${prefix}:${label}-candidate-artifact-unparseable`);
    return;
  }
  const audit = auditCandidateRunPayload(payload, { scoreId: recording?.scoreId });
  for (const reason of audit.blockingReasons) fail(`${prefix}:${label}-${reason}`);
  const derived = audit.derived;
  if (!derived) return;
  if (derived.candidateEvidenceSha256 !== String(run?.candidateEvidenceSha256 || "").toLowerCase()) {
    fail(`${prefix}:${label}-candidate-evidence-digest-mismatch`);
  }
  if (
    derived.audioSha256 !== String(recording?.audioSha256 || "").toLowerCase()
    || derived.scorePayloadSha256 !== String(recording?.scorePayloadSha256 || "").toLowerCase()
    || derived.scoreStoreArtifactSha256 !== String(recording?.scoreStoreArtifactSha256 || "").toLowerCase()
    || derived.cacheHit !== (run?.cacheHit === true)
    || derived.cacheArtifactSha256 !== String(run?.cacheArtifactSha256 || "").toLowerCase()
    || derived.candidateRowCount !== recording?.candidateRowCount
    || derived.selectedCount !== recording?.shadowSelectedCandidateCount
    || derived.exactPitchSelectedCount !== recording?.exactPitchSelectedCount
  ) {
    fail(`${prefix}:${label}-candidate-claims-mismatch`);
  }
}

export function auditOrdinaryDynamicShadowAcceptanceLiveArtifacts({
  repoRoot = process.cwd(),
  acceptance = null,
  acceptancePath = ACCEPTANCE_REPORT_RELATIVE_PATH,
  runtimeReport = null,
} = {}) {
  const blockingReasons = [];
  const fail = (reason) => blockingReasons.push(reason);
  let report = acceptance;
  if (!report) {
    const artifact = readWorkspaceArtifactSync(repoRoot, acceptancePath);
    if (artifact.status !== "ok") {
      return {
        contract: ORDINARY_DYNAMIC_LIVE_VERIFIER_CONTRACT,
        ready: false,
        blockingReasons: [`ordinary-dynamic-shadow-r3-live-acceptance-${artifact.status}`],
      };
    }
    try {
      report = JSON.parse(artifact.bytes.toString("utf8"));
    } catch {
      return {
        contract: ORDINARY_DYNAMIC_LIVE_VERIFIER_CONTRACT,
        ready: false,
        blockingReasons: ["ordinary-dynamic-shadow-r3-live-acceptance-unparseable"],
      };
    }
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      contract: ORDINARY_DYNAMIC_LIVE_VERIFIER_CONTRACT,
      ready: false,
      blockingReasons: ["ordinary-dynamic-shadow-r3-live-acceptance-invalid"],
    };
  }
  if (report.scoreBindingMode !== ORDINARY_DYNAMIC_SCORE_BINDING_MODE) {
    fail("ordinary-dynamic-shadow-r3-live-score-binding-mode-invalid");
  }

  const digestPayload = structuredClone(report);
  delete digestPayload.evidenceDigestSha256;
  delete digestPayload.generatedAt;
  if (
    !isSha256(report.evidenceDigestSha256)
    || sha256Canonical(digestPayload) !== String(report.evidenceDigestSha256).toLowerCase()
  ) {
    fail("ordinary-dynamic-shadow-r3-live-evidence-digest-invalid");
  }

  const anchors = ORDINARY_AUDIO_RUNTIME_ANCHORS;
  const runtime = runtimeReport || evaluateOrdinaryAudioRuntime();
  if (
    runtime?.runtimeReady !== true
    || runtime?.runtimeId !== anchors.runtimeId
    || runtime?.configSemanticSha256 !== anchors.configSemanticSha256
    || runtime?.requirementsLock?.normalizedSha256 !== anchors.requirementsLockSha256
    || runtime?.modelIdentity?.treeSha256 !== anchors.modelTreeSha256
  ) {
    fail("ordinary-dynamic-shadow-r3-live-runtime-preflight-failed");
  }

  const store = loadScoreStore(repoRoot);
  const recordings = Array.isArray(report.recordings) ? report.recordings : [];
  if (!recordings.length) fail("ordinary-dynamic-shadow-r3-live-recordings-missing");
  for (const recording of recordings) {
    const id = String(recording?.recordingId || "unknown");
    const prefix = `ordinary-dynamic-shadow-r3-live:${id}`;

    const audioArtifact = readWorkspaceArtifactSync(repoRoot, recording?.audioPath);
    if (audioArtifact.status !== "ok") fail(`${prefix}:audio-artifact-${audioArtifact.status}`);
    else if (audioArtifact.sha256 !== String(recording?.audioSha256 || "").toLowerCase()) {
      fail(`${prefix}:audio-artifact-stale`);
    }

    if (!store.ok) {
      fail(`${prefix}:score-store-${store.status}`);
    } else {
      // Do not bind freshness to the whole mutable library container. The
      // cited score payload and note count remain the fail-closed boundary.
      const score = store.scores.find(
        (item) => String(item?.scoreId || "").trim() === String(recording?.scoreId || "").trim(),
      );
      if (!score) fail(`${prefix}:score-missing-from-store`);
      else {
        if (sha256Canonical(score) !== String(recording?.scorePayloadSha256 || "").toLowerCase()) {
          fail(`${prefix}:score-payload-stale`);
        }
        if (scoreNoteCount(score) !== recording?.scoreNoteCount) {
          fail(`${prefix}:score-note-count-stale`);
        }
      }
    }

    auditRunAgainstDisk({ repoRoot, recording, run: recording?.coldRun, label: "cold", prefix, fail });
    auditRunAgainstDisk({ repoRoot, recording, run: recording?.warmRun, label: "warm", prefix, fail });
  }

  return {
    contract: ORDINARY_DYNAMIC_LIVE_VERIFIER_CONTRACT,
    scoreBindingMode: ORDINARY_DYNAMIC_SCORE_BINDING_MODE,
    ready: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)].sort(),
    recordingCount: recordings.length,
  };
}

async function main() {
  const result = auditOrdinaryDynamicShadowAcceptanceLiveArtifacts({});
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
