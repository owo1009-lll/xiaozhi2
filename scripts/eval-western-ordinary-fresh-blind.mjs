#!/usr/bin/env node
// Ordinary dynamic-shadow full-score fresh-blind evidence (v1).
//
// Consumes a controlled batch of recordings by a performer/voice that has
// never been used to tune any threshold in this project, re-derives every
// claim from the physical candidate artifacts on disk, and reports evidence
// in three explicit tiers so a caller can never accidentally read a weak
// tier as a strong one:
//
//   clean-full        scenario is a plain correct performance (the score IS
//                      the ground truth). Contributes shadow-coverage
//                      evidence with a floor check.
//   technique-safety   the score carries protected/glissando/polyphonic
//                      markings. Contributes a structural safety check: no
//                      marked-zone row may ever produce an M3+ accusation
//                      (issue_detected), regardless of what was played.
//   error-reference    the performer deliberately played wrong/missing/
//                      dragged notes, but the exact positions were not
//                      recorded. groundTruthPrecision is explicitly false;
//                      these numbers are reported for visibility only and
//                      must never be counted toward a precision or "zero
//                      dangerous leak" claim.
//
// This is implementation/evidence-gathering only (preGateOnly): it never
// authorizes the student runtime, and it does not by itself flip the
// separate western-ordinary-dynamic-shadow-release-v1 authorization, which
// remains an explicit owner act.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readWorkspaceArtifactSync, sha256Canonical } from "./audit-western-ordinary-dynamic-shadow-acceptance.mjs";

export const FRESH_BLIND_CONTRACT = "western-ordinary-dynamic-shadow-full-score-fresh-blind-v1";
export const FRESH_BLIND_SCHEMA_VERSION = 1;
export const CLEAN_COVERAGE_FLOOR = 0.2;
export const POLICY_C_CONTRACT = "western-round4-policy-c-review-assist-v1";
export const POLICY_C_THRESHOLDS = Object.freeze({
  minPlantedPositions: 12,
  minNonPlantedPositions: 250,
  minCombinedRecall: 0.5,
  maxSelfCheckHintFalsePositiveRate: 0.02,
  maxStrictFalseAccusations: 0,
  minAutoAccusationPrecision: 0.9,
});
export const RHYTHM_CHANNEL_DIAGNOSTIC_CONTRACT = "western-round4-relative-ioi-diagnostic-v1";
export const RHYTHM_CHANNEL_DIAGNOSTIC_THRESHOLDS = Object.freeze({
  frozenDeviationThreshold: 0.15,
  minPrecision: 0.9,
  minRecall: 0.5,
});
const CLEAN_SCENARIOS = new Set(["correct", "fresh_blind_correct"]);
const ERROR_REFERENCE_SCENARIOS = new Set(["wrong_pitch", "missing_note", "rhythm_shift"]);

const DEFAULT_MANIFEST = path.join("data", "private", "western-strings-round2-fresh-blind", "manifest.csv");
const DEFAULT_MACHINE_ANALYSIS = path.join(
  "data",
  "experiments",
  "western-strings-round2-fresh-blind",
  "machine-analysis.json",
);
const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3", "ordinary-fresh-blind");
export const FRESH_BLIND_REPORT_RELATIVE_PATH = path.join(DEFAULT_OUT_DIR, "report.json");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") value += char;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...data] = rows.filter((cells) => cells.some((cell) => String(cell || "").trim()));
  const cleanHeaders = headers.map((header) => String(header || "").replace(/^﻿/, ""));
  return data.map((cells) => Object.fromEntries(cleanHeaders.map((header, index) => [header, cells[index] || ""])));
}

function rel(value) {
  return String(value || "").replace(/\\/g, "/");
}

function auditRecording({ repoRoot, item, manifestRow, fail }) {
  const id = String(item?.recordingId || manifestRow?.recordingId || "unknown");
  const prefix = `fresh-blind-recording-invalid:${id}`;
  if (item?.analysisStatus !== "offline_feature_review_ready" || item?.offlineAnalysisProduced !== true) {
    fail(`${prefix}:analysis-status`);
    return null;
  }
  if (item?.autoDiagnosisIssued === true || item?.studentFacing === true) {
    fail(`${prefix}:auto-diagnosis-or-student-facing`);
  }
  const artifact = readWorkspaceArtifactSync(repoRoot, item?.candidateRowsPath);
  if (artifact.status !== "ok") {
    fail(`${prefix}:candidate-artifact-${artifact.status}`);
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    fail(`${prefix}:candidate-artifact-unparseable`);
    return null;
  }
  const rows = Array.isArray(payload?.candidateRows) ? payload.candidateRows : [];
  const gate = payload?.candidateGate || {};
  if (!rows.length) {
    fail(`${prefix}:rows-missing`);
    return null;
  }
  if (
    gate.studentSafeGateReady !== false
    || gate.studentFacing !== false
    || gate.autoPassCandidateCount !== 0
    || gate.energyVetoIncluded !== false
    || gate.causalEnergyStatus !== "excluded-review-only"
    || gate.scoreProvenanceReady !== true
    || gate.scoreNoteIdentityReady !== true
    || gate.cacheProvenanceReady !== true
  ) {
    fail(`${prefix}:candidate-gate-invalid`);
  }
  const m3plusRuntime = gate.m3plusPitchSafetyRuntime || {};
  if (m3plusRuntime.reviewOnlyRuntimeWired !== true || m3plusRuntime.contractReady !== true) {
    fail(`${prefix}:m3plus-runtime-invalid`);
  }

  let selectedCount = 0;
  let markedZoneRowCount = 0;
  let markedZoneAccusationCount = 0;
  const positionRows = [];
  rows.forEach((row, index) => {
    if (row?.autoDecision !== "review_required" || row?.studentFacing !== false) {
      fail(`${prefix}:row-not-review-only:${index}`);
      return;
    }
    const shadow = row?.dynamicShadowEvidence;
    if (shadow?.selected === true) {
      selectedCount += 1;
      if (Number(shadow.pitchDistanceSemitones) !== 0) {
        fail(`${prefix}:shadow-selected-non-exact-pitch:${index}`);
      }
    }
    const m3plusEvidence = row?.m3plusPitchSafetyEvidence;
    if (m3plusEvidence && m3plusEvidence.zone !== "stable_center") {
      markedZoneRowCount += 1;
      if (m3plusEvidence.decision === "issue_detected") markedZoneAccusationCount += 1;
    }
    positionRows.push({
      noteIndex: Number(row?.noteIndex),
      measureIndex: Number(row?.measureIndex),
      beatStart: Number(row?.beatStart),
      midi: row?.midi == null ? null : Number(row.midi),
      m3plusDecision: String(m3plusEvidence?.decision || ""),
      m3plusTimingAssignmentAvailable: row?.m3plusTimingAssignmentAvailable === true,
      voicedFrameRatio: row?.voicedFrameRatio == null ? null : Number(row.voicedFrameRatio),
      pitchDistanceSemitones:
        row?.basicPitchPitchDistanceSemitones == null ? null : Number(row.basicPitchPitchDistanceSemitones),
      eventDurationRatio:
        shadow?.eventDurationRatio == null ? null : Number(shadow.eventDurationRatio),
      relativeIoiEvidenceAvailable: row?.relativeIoiEvidenceAvailable === true,
      relativeIoiDeviationRatio:
        row?.relativeIoiDeviationRatio == null ? null : Number(row.relativeIoiDeviationRatio),
    });
  });
  if (markedZoneAccusationCount > 0) {
    fail(`${prefix}:marked-zone-accusation:${markedZoneAccusationCount}`);
  }

  return {
    recordingId: id,
    scenario: String(manifestRow?.scenario || ""),
    pieceId: String(manifestRow?.pieceId || item?.pieceId || ""),
    scoreId: String(manifestRow?.scoreId || ""),
    candidateRowsPath: rel(item.candidateRowsPath),
    candidateArtifactSha256: artifact.sha256,
    rowCount: rows.length,
    shadowSelectedCount: selectedCount,
    shadowCoverage: rows.length > 0 ? Number((selectedCount / rows.length).toFixed(6)) : 0,
    markedZoneRowCount,
    markedZoneAccusationCount,
    m3plusDecisionCounts: m3plusRuntime.decisionCounts || {},
    m3plusZoneCounts: m3plusRuntime.zoneCounts || {},
    positionRows,
  };
}

// Duration-ratio band outside which a same-pitch note is treated as a timing
// anomaly (drag/extra). Kept intentionally loose so ordinary rubato does not
// trip it; this is a heuristic reference channel, never a runtime accusation.
const DURATION_RATIO_HIGH = 1.6;
const DURATION_RATIO_LOW = 0.5;

function detectChannels(row) {
  const pitchOrPresenceIssue = row.m3plusDecision !== "" && row.m3plusDecision !== "confirmed_center";
  const durationIssue =
    row.eventDurationRatio != null
    && (row.eventDurationRatio >= DURATION_RATIO_HIGH || row.eventDurationRatio <= DURATION_RATIO_LOW);
  return { pitchOrPresenceIssue, durationIssue, detected: pitchOrPresenceIssue || durationIssue };
}

// preGateOnly localization reference: anchor each planted error to its
// candidate row and report whether the review-only machine evidence diverges
// there, plus a false-positive control over the clean notes of the SAME take.
// Structural mismatches (a planted position with no matching row, or a row
// whose score pitch disagrees with the sidecar) block, because they mean the
// ground truth no longer lines up with the artifacts. The detection RATE
// itself never blocks and never authorizes anything.
function computePositionLocalization({ recordings, positionTruth, positionTruthPath, positionTruthSha256, fail }) {
  const byId = new Map(recordings.map((row) => [row.recordingId, row]));
  const perRecording = [];
  const kindTotals = {};
  const kindDetected = {};
  let plantedTotal = 0;
  let plantedDetected = 0;
  let cleanRowTotal = 0;
  let cleanFalsePositive = 0;

  const truthRecordings = positionTruth?.recordings || {};
  for (const [recordingId, spec] of Object.entries(truthRecordings)) {
    const audited = byId.get(recordingId);
    if (!audited) {
      fail(`fresh-blind-position-truth-recording-missing:${recordingId}`);
      continue;
    }
    const rowByPos = new Map(
      (audited.positionRows || []).map((row) => [`${row.measureIndex}:${row.beatStart}`, row]),
    );
    const plantedKeys = new Set();
    const errorRows = [];
    for (const err of spec.errors || []) {
      const key = `${Number(err.measure)}:${Number(err.beat) - 1}`;
      const row = rowByPos.get(key);
      if (!row) {
        fail(`fresh-blind-position-truth-unmatched:${recordingId}:m${err.measure}b${err.beat}`);
        continue;
      }
      if (err.scoreMidi != null && row.midi != null && Number(err.scoreMidi) !== row.midi) {
        fail(`fresh-blind-position-truth-pitch-mismatch:${recordingId}:m${err.measure}b${err.beat}`);
      }
      plantedKeys.add(key);
      const channels = detectChannels(row);
      kindTotals[err.kind] = (kindTotals[err.kind] || 0) + 1;
      if (channels.detected) kindDetected[err.kind] = (kindDetected[err.kind] || 0) + 1;
      plantedTotal += 1;
      if (channels.detected) plantedDetected += 1;
      errorRows.push({
        kind: err.kind,
        measure: Number(err.measure),
        beat: Number(err.beat),
        scorePitch: err.scorePitch,
        m3plusDecision: row.m3plusDecision,
        eventDurationRatio: row.eventDurationRatio,
        detected: channels.detected,
        pitchOrPresenceIssue: channels.pitchOrPresenceIssue,
        durationIssue: channels.durationIssue,
      });
    }
    let recCleanRows = 0;
    let recCleanFalsePositive = 0;
    for (const row of audited.positionRows || []) {
      const key = `${row.measureIndex}:${row.beatStart}`;
      if (plantedKeys.has(key)) continue;
      recCleanRows += 1;
      if (detectChannels(row).detected) recCleanFalsePositive += 1;
    }
    cleanRowTotal += recCleanRows;
    cleanFalsePositive += recCleanFalsePositive;
    perRecording.push({
      recordingId,
      scoreId: spec.scoreId || audited.scoreId || "",
      plantedCount: (spec.errors || []).length,
      detectedCount: errorRows.filter((row) => row.detected).length,
      cleanRowCount: recCleanRows,
      cleanFalsePositiveCount: recCleanFalsePositive,
      errors: errorRows,
    });
  }

  const detectionByKind = {};
  for (const kind of Object.keys(kindTotals)) {
    detectionByKind[kind] = {
      planted: kindTotals[kind],
      detected: kindDetected[kind] || 0,
      rate: kindTotals[kind] > 0 ? Number(((kindDetected[kind] || 0) / kindTotals[kind]).toFixed(4)) : null,
    };
  }

  return {
    scope: "preGateOnly-localization-reference",
    note:
      "review-only pipeline issues no student accusations; this measures whether the machine evidence diverges "
      + "at ground-truth planted positions (recall) versus clean notes of the same take (false-positive control). "
      + "It never authorizes the student runtime and is not a precision claim.",
    positionTruthPath: rel(positionTruthPath),
    positionTruthSha256,
    channels: { durationRatioHigh: DURATION_RATIO_HIGH, durationRatioLow: DURATION_RATIO_LOW },
    plantedTotal,
    plantedDetected,
    overallDetectionRate: plantedTotal > 0 ? Number((plantedDetected / plantedTotal).toFixed(4)) : null,
    detectionByKind,
    cleanRowTotal,
    cleanFalsePositive,
    falsePositiveRate: cleanRowTotal > 0 ? Number((cleanFalsePositive / cleanRowTotal).toFixed(4)) : null,
    perRecording,
  };
}

function policyCDecision(row) {
  const strictConfirmedIssue = row?.m3plusDecision === "issue_detected";
  const selfCheckHint = !strictConfirmedIssue && row?.m3plusTimingAssignmentAvailable === false;
  return {
    strictConfirmedIssue,
    selfCheckHint,
    detected: strictConfirmedIssue || selfCheckHint,
    outputSemantic: strictConfirmedIssue
      ? "confirmed_issue"
      : selfCheckHint
        ? "self_check_hint"
        : "no_issue_output",
  };
}

export function evaluatePolicyCReviewAssist({ recordings, positionTruth }) {
  const plantedByRecording = new Map();
  for (const [recordingId, spec] of Object.entries(positionTruth?.recordings || {})) {
    plantedByRecording.set(
      recordingId,
      new Map((spec.errors || []).map((error) => [
        `${Number(error.measure)}:${Number(error.beat) - 1}`,
        error,
      ])),
    );
  }

  let plantedTotal = 0;
  let plantedDetected = 0;
  let plantedStrictConfirmed = 0;
  let plantedSelfCheckHints = 0;
  let nonPlantedTotal = 0;
  let nonPlantedStrictFalseAccusations = 0;
  let nonPlantedSelfCheckHints = 0;
  const byKind = {};

  for (const recording of recordings) {
    const planted = plantedByRecording.get(recording.recordingId) || new Map();
    for (const row of recording.positionRows || []) {
      const error = planted.get(`${row.measureIndex}:${row.beatStart}`);
      const output = policyCDecision(row);
      if (error) {
        const kind = String(error.kind || "unknown");
        const summary = byKind[kind] || {
          planted: 0,
          strictConfirmed: 0,
          selfCheckHints: 0,
          detected: 0,
        };
        summary.planted += 1;
        if (output.strictConfirmedIssue) summary.strictConfirmed += 1;
        if (output.selfCheckHint) summary.selfCheckHints += 1;
        if (output.detected) summary.detected += 1;
        byKind[kind] = summary;
        plantedTotal += 1;
        if (output.strictConfirmedIssue) plantedStrictConfirmed += 1;
        if (output.selfCheckHint) plantedSelfCheckHints += 1;
        if (output.detected) plantedDetected += 1;
      } else {
        nonPlantedTotal += 1;
        if (output.strictConfirmedIssue) nonPlantedStrictFalseAccusations += 1;
        if (output.selfCheckHint) nonPlantedSelfCheckHints += 1;
      }
    }
  }

  for (const summary of Object.values(byKind)) {
    summary.recall = summary.planted > 0
      ? Number((summary.detected / summary.planted).toFixed(6))
      : null;
  }
  const combinedRecall = plantedTotal > 0 ? plantedDetected / plantedTotal : 0;
  const selfCheckHintFalsePositiveRate = nonPlantedTotal > 0
    ? nonPlantedSelfCheckHints / nonPlantedTotal
    : 0;
  const combinedPositiveCount = plantedDetected
    + nonPlantedStrictFalseAccusations
    + nonPlantedSelfCheckHints;
  const combinedPrecisionProxy = combinedPositiveCount > 0
    ? plantedDetected / combinedPositiveCount
    : null;
  const checks = {
    plantedSampleReady: plantedTotal >= POLICY_C_THRESHOLDS.minPlantedPositions,
    nonPlantedSampleReady: nonPlantedTotal >= POLICY_C_THRESHOLDS.minNonPlantedPositions,
    combinedRecallReady: combinedRecall >= POLICY_C_THRESHOLDS.minCombinedRecall,
    selfCheckHintFalsePositiveRateReady:
      selfCheckHintFalsePositiveRate <= POLICY_C_THRESHOLDS.maxSelfCheckHintFalsePositiveRate,
    strictSafetyReady:
      nonPlantedStrictFalseAccusations <= POLICY_C_THRESHOLDS.maxStrictFalseAccusations,
  };
  const reviewAssistGateReady = Object.values(checks).every(Boolean);
  const energyRobustnessReady = false;
  const autoAccusationPrecisionReady = combinedPrecisionProxy !== null
    && combinedPrecisionProxy >= POLICY_C_THRESHOLDS.minAutoAccusationPrecision;

  return {
    contract: POLICY_C_CONTRACT,
    scope: "fresh-blind-review-assist-only",
    policyName: "Policy C",
    outputSemantics: {
      confirmed_issue: "Only the existing M3+ issue_detected decision may accuse.",
      self_check_hint: "A missing Basic Pitch/DTW assignment may ask the learner to self-check, but may not accuse.",
      insufficient_evidence: "All other uncertain evidence remains fail-closed.",
    },
    energyEvidence: {
      kind: "event-assignment-absence-proxy",
      waveformEnergyMeasured: false,
      energyRobustnessReady,
      note: "The frozen 6/12 result uses absence of a Basic Pitch/DTW assignment. It is energy-gated event evidence, not a direct waveform-energy measurement.",
    },
    thresholds: POLICY_C_THRESHOLDS,
    planted: {
      total: plantedTotal,
      detected: plantedDetected,
      strictConfirmed: plantedStrictConfirmed,
      selfCheckHints: plantedSelfCheckHints,
      combinedRecall: Number(combinedRecall.toFixed(6)),
      byKind,
    },
    nonPlanted: {
      total: nonPlantedTotal,
      strictFalseAccusations: nonPlantedStrictFalseAccusations,
      selfCheckHints: nonPlantedSelfCheckHints,
      selfCheckHintFalsePositiveRate: Number(selfCheckHintFalsePositiveRate.toFixed(6)),
    },
    combinedPrecisionProxy:
      combinedPrecisionProxy === null ? null : Number(combinedPrecisionProxy.toFixed(6)),
    checks,
    reviewAssistGateReady,
    autoAccusationPrecisionReady,
    autoAccusationReady: false,
    automaticAdoptionBlockingReasons: [
      ...(!autoAccusationPrecisionReady ? ["policy-c-combined-precision-below-floor"] : []),
      "policy-c-waveform-energy-robustness-not-proven",
      "policy-c-extra-drag-diagnosis-out-of-scope",
      "policy-c-student-runtime-authorization-closed",
    ],
  };
}

export function evaluateRhythmChannelDiagnostic({ recordings, positionTruth }) {
  const plantedByRecording = new Map();
  for (const [recordingId, spec] of Object.entries(positionTruth?.recordings || {})) {
    plantedByRecording.set(
      recordingId,
      new Map((spec.errors || []).map((error) => [
        `${Number(error.measure)}:${Number(error.beat) - 1}`,
        error,
      ])),
    );
  }

  const rows = [];
  for (const recording of recordings) {
    const planted = plantedByRecording.get(recording.recordingId) || new Map();
    for (const row of recording.positionRows || []) {
      const error = planted.get(`${row.measureIndex}:${row.beatStart}`) || null;
      const kind = String(error?.kind || "");
      rows.push({
        isPlanted: Boolean(error),
        isRhythmTarget: kind === "drag" || kind === "extra",
        deviation: Number.isFinite(row.relativeIoiDeviationRatio)
          ? Number(row.relativeIoiDeviationRatio)
          : null,
      });
    }
  }

  const rhythmTargetTotal = rows.filter((row) => row.isRhythmTarget).length;
  const nonRhythmTargetTotal = rows.length - rhythmTargetTotal;
  const nonPlantedTotal = rows.filter((row) => !row.isPlanted).length;
  const metricAt = (threshold) => {
    let truePositive = 0;
    let falsePositive = 0;
    let nonPlantedFalsePositive = 0;
    for (const row of rows) {
      const flagged = row.deviation !== null && row.deviation > threshold;
      if (!flagged) continue;
      if (row.isRhythmTarget) truePositive += 1;
      else falsePositive += 1;
      if (!row.isPlanted) nonPlantedFalsePositive += 1;
    }
    const precision = truePositive + falsePositive > 0
      ? truePositive / (truePositive + falsePositive)
      : 0;
    const recall = rhythmTargetTotal > 0 ? truePositive / rhythmTargetTotal : 0;
    return {
      threshold: Number(threshold.toFixed(6)),
      truePositive,
      falseNegative: rhythmTargetTotal - truePositive,
      falsePositive,
      nonPlantedFalsePositive,
      precision: Number(precision.toFixed(6)),
      recall: Number(recall.toFixed(6)),
    };
  };

  // Every unique observed value defines one possible partition for a simple
  // `relativeIoiDeviationRatio > threshold` rule. Testing all of them proves
  // whether any single threshold can satisfy the joint floor; this is not a
  // hand-picked threshold sweep.
  const candidateThresholds = [
    -1,
    ...new Set(rows.map((row) => row.deviation).filter((value) => value !== null)),
  ].sort((left, right) => left - right);
  const operatingPoints = candidateThresholds.map(metricAt);
  const jointFloorReady = operatingPoints.some(
    (point) => point.precision >= RHYTHM_CHANNEL_DIAGNOSTIC_THRESHOLDS.minPrecision
      && point.recall >= RHYTHM_CHANNEL_DIAGNOSTIC_THRESHOLDS.minRecall,
  );
  const pointsAtRecallFloor = operatingPoints
    .filter((point) => point.recall >= RHYTHM_CHANNEL_DIAGNOSTIC_THRESHOLDS.minRecall)
    .sort((left, right) => (
      right.precision - left.precision
      || right.recall - left.recall
      || left.falsePositive - right.falsePositive
      || right.threshold - left.threshold
    ));
  const frozenOperatingPoint = metricAt(
    RHYTHM_CHANNEL_DIAGNOSTIC_THRESHOLDS.frozenDeviationThreshold,
  );

  return {
    contract: RHYTHM_CHANNEL_DIAGNOSTIC_CONTRACT,
    scope: "preGateOnly-diagnostic",
    feature: "relativeIoiDeviationRatio",
    ruleFamily: "single-threshold-greater-than",
    thresholds: RHYTHM_CHANNEL_DIAGNOSTIC_THRESHOLDS,
    sample: {
      totalPositions: rows.length,
      featureAvailablePositions: rows.filter((row) => row.deviation !== null).length,
      rhythmTargetTotal,
      nonRhythmTargetTotal,
      nonPlantedTotal,
    },
    evaluatedThresholdCount: operatingPoints.length,
    frozenOperatingPoint,
    bestAtRecallFloor: pointsAtRecallFloor[0] || null,
    jointFloorReady,
    reviewAssistReady: false,
    autoAccusationReady: false,
    blockingReasons: jointFloorReady
      ? []
      : ["no-simple-relative-ioi-threshold-meets-joint-floor"],
    note: "The feature is populated, but its current local-tempo residual is not discriminative enough for drag/extra feedback.",
  };
}

export function auditFreshBlindEvidence({
  repoRoot = process.cwd(),
  manifestPath = DEFAULT_MANIFEST,
  machineAnalysisPath = DEFAULT_MACHINE_ANALYSIS,
  positionTruthPath = null,
} = {}) {
  const blockingReasons = [];
  const fail = (reason) => blockingReasons.push(reason);

  const manifestArtifact = readWorkspaceArtifactSync(repoRoot, manifestPath);
  if (manifestArtifact.status !== "ok") {
    return {
      contract: FRESH_BLIND_CONTRACT,
      ready: false,
      blockingReasons: [`fresh-blind-manifest-${manifestArtifact.status}`],
    };
  }
  const manifestRows = parseCsv(manifestArtifact.bytes.toString("utf8"));
  const manifestById = new Map(manifestRows.map((row) => [String(row.recordingId || "").trim(), row]));

  const machineAnalysisArtifact = readWorkspaceArtifactSync(repoRoot, machineAnalysisPath);
  if (machineAnalysisArtifact.status !== "ok") {
    return {
      contract: FRESH_BLIND_CONTRACT,
      ready: false,
      blockingReasons: [`fresh-blind-machine-analysis-${machineAnalysisArtifact.status}`],
    };
  }
  let machineAnalysis;
  try {
    machineAnalysis = JSON.parse(machineAnalysisArtifact.bytes.toString("utf8"));
  } catch {
    return {
      contract: FRESH_BLIND_CONTRACT,
      ready: false,
      blockingReasons: ["fresh-blind-machine-analysis-unparseable"],
    };
  }
  if (machineAnalysis?.ready !== true || (machineAnalysis?.blockingReasons || []).length !== 0) {
    fail("fresh-blind-machine-analysis-not-ready");
  }
  const items = Array.isArray(machineAnalysis?.items) ? machineAnalysis.items : [];
  const itemIds = new Set(items.map((item) => String(item?.recordingId || "").trim()));
  const manifestIds = new Set(manifestById.keys());
  if (itemIds.size !== manifestIds.size || [...manifestIds].some((id) => !itemIds.has(id))) {
    fail("fresh-blind-recording-set-mismatch");
  }

  const recordings = [];
  for (const item of items) {
    const manifestRow = manifestById.get(String(item?.recordingId || "").trim());
    if (!manifestRow) {
      fail(`fresh-blind-unrequested-recording:${item?.recordingId || "unknown"}`);
      continue;
    }
    const audited = auditRecording({ repoRoot, item, manifestRow, fail });
    if (audited) recordings.push(audited);
  }

  const clean = recordings.filter((row) => CLEAN_SCENARIOS.has(row.scenario));
  const errorReference = recordings.filter((row) => ERROR_REFERENCE_SCENARIOS.has(row.scenario));
  const technique = recordings.filter(
    (row) => !CLEAN_SCENARIOS.has(row.scenario) && !ERROR_REFERENCE_SCENARIOS.has(row.scenario),
  );
  if (clean.length < 2) fail("fresh-blind-clean-scenario-coverage-insufficient");
  for (const row of clean) {
    if (row.shadowCoverage < CLEAN_COVERAGE_FLOOR) {
      fail(`fresh-blind-clean-coverage-below-floor:${row.recordingId}:${row.shadowCoverage}`);
    }
  }
  const totalMarkedZoneRows = recordings.reduce((sum, row) => sum + row.markedZoneRowCount, 0);
  const totalMarkedZoneAccusations = recordings.reduce((sum, row) => sum + row.markedZoneAccusationCount, 0);

  // Optional preGateOnly localization reference (round-4 planted-error truth).
  // positionRows is an internal detail used only here; it is stripped from the
  // persisted report so the report stays lean and prior reports without a
  // position-truth sidecar remain byte-for-byte stable.
  let positionLocalization = null;
  let policyCReviewAssist = null;
  let rhythmChannelDiagnostic = null;
  let positionTruthSha256 = null;
  let positionTruth = null;
  if (positionTruthPath) {
    const sidecar = readWorkspaceArtifactSync(repoRoot, positionTruthPath);
    if (sidecar.status !== "ok") {
      fail(`fresh-blind-position-truth-${sidecar.status}`);
    } else {
      positionTruthSha256 = sidecar.sha256;
      try {
        positionTruth = JSON.parse(sidecar.bytes.toString("utf8"));
      } catch {
        fail("fresh-blind-position-truth-unparseable");
      }
      if (positionTruth) {
        positionLocalization = computePositionLocalization({
          recordings,
          positionTruth,
          positionTruthPath,
          positionTruthSha256,
          fail,
        });
        policyCReviewAssist = evaluatePolicyCReviewAssist({ recordings, positionTruth });
        rhythmChannelDiagnostic = evaluateRhythmChannelDiagnostic({ recordings, positionTruth });
        if (!policyCReviewAssist.reviewAssistGateReady) {
          fail("fresh-blind-policy-c-review-assist-gate-failed");
        }
      }
    }
  }

  const publicRow = ({ positionRows, ...rest }) => rest;
  const errorReferenceOnly = {
    recordingIds: errorReference.map((row) => row.recordingId),
    groundTruthPrecision: false,
    note: positionLocalization
      ? "shadow-coverage numbers here are informational only and must never be counted toward a precision or zero-dangerous-leak claim; see positionLocalization for the preGateOnly planted-error recall reference"
      : "exact error positions were not recorded; these numbers are informational only and must never be counted toward a precision or zero-dangerous-leak claim",
    rows: errorReference.map(publicRow),
  };
  if (positionLocalization) errorReferenceOnly.positionLocalization = positionLocalization;

  const report = {
    schemaVersion: FRESH_BLIND_SCHEMA_VERSION,
    contract: FRESH_BLIND_CONTRACT,
    scope: "implementation-evidence-preGateOnly",
    studentFacing: false,
    automaticAdoptionAuthorized: false,
    authorizationReady: false,
    manifestPath: rel(manifestPath),
    manifestSha256: manifestArtifact.sha256,
    machineAnalysisPath: rel(machineAnalysisPath),
    machineAnalysisSha256: machineAnalysisArtifact.sha256,
    ...(positionTruthPath ? { positionTruthPath: rel(positionTruthPath), positionTruthSha256 } : {}),
    recordingCount: recordings.length,
    tiers: {
      cleanFull: {
        recordingIds: clean.map((row) => row.recordingId),
        coverageFloor: CLEAN_COVERAGE_FLOOR,
        rows: clean.map(publicRow),
      },
      techniqueSafety: {
        recordingIds: technique.map((row) => row.recordingId),
        totalMarkedZoneRows,
        totalMarkedZoneAccusations,
        rows: technique.map(publicRow),
      },
      errorReferenceOnly,
    },
    recordings: recordings.map(publicRow),
    ...(policyCReviewAssist ? { policyCReviewAssist } : {}),
    ...(rhythmChannelDiagnostic ? { rhythmChannelDiagnostic } : {}),
    evidenceReady: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
  };
  report.generatedAt = new Date().toISOString();
  const digestPayload = structuredClone(report);
  delete digestPayload.evidenceDigestSha256;
  delete digestPayload.generatedAt;
  report.evidenceDigestSha256 = sha256Canonical(digestPayload);
  return report;
}

// Live re-audit of an already-written report: rereads every cited artifact
// from disk again so a stale or hand-edited report cannot pass silently.
export function auditFreshBlindEvidenceLiveArtifacts({
  repoRoot = process.cwd(),
  reportPath = FRESH_BLIND_REPORT_RELATIVE_PATH,
} = {}) {
  const artifact = readWorkspaceArtifactSync(repoRoot, reportPath);
  if (artifact.status !== "ok") {
    return { contract: FRESH_BLIND_CONTRACT, ready: false, blockingReasons: [`fresh-blind-report-${artifact.status}`] };
  }
  let stored;
  try {
    stored = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    return { contract: FRESH_BLIND_CONTRACT, ready: false, blockingReasons: ["fresh-blind-report-unparseable"] };
  }
  const digestPayload = structuredClone(stored);
  delete digestPayload.evidenceDigestSha256;
  delete digestPayload.generatedAt;
  if (
    !/^[a-f0-9]{64}$/.test(String(stored.evidenceDigestSha256 || ""))
    || sha256Canonical(digestPayload) !== String(stored.evidenceDigestSha256).toLowerCase()
  ) {
    return {
      contract: FRESH_BLIND_CONTRACT,
      ready: false,
      blockingReasons: ["fresh-blind-report-evidence-digest-invalid"],
    };
  }
  const recomputed = auditFreshBlindEvidence({
    repoRoot,
    manifestPath: stored.manifestPath,
    machineAnalysisPath: stored.machineAnalysisPath,
    positionTruthPath: stored.positionTruthPath || null,
  });
  const recomputedDigestPayload = structuredClone(recomputed);
  delete recomputedDigestPayload.evidenceDigestSha256;
  delete recomputedDigestPayload.generatedAt;
  const recomputedDigest = sha256Canonical(recomputedDigestPayload);
  const blockingReasons = [];
  if (recomputed.evidenceReady !== stored.evidenceReady) blockingReasons.push("fresh-blind-report-readiness-stale");
  if (recomputedDigest !== sha256Canonical(digestPayload)) blockingReasons.push("fresh-blind-report-content-stale");
  for (const reason of recomputed.blockingReasons || []) blockingReasons.push(reason);
  return {
    contract: FRESH_BLIND_CONTRACT,
    ready: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
    recomputed,
  };
}

function renderLocalizationSection(loc) {
  if (!loc) return [];
  const kindLines = Object.entries(loc.detectionByKind).map(
    ([kind, stat]) => `- ${kind}: ${stat.detected}/${stat.planted} (rate ${stat.rate})`,
  );
  const recLines = loc.perRecording.map(
    (rec) =>
      `- ${rec.recordingId}: detected ${rec.detectedCount}/${rec.plantedCount}; false-positive ${rec.cleanFalsePositiveCount}/${rec.cleanRowCount} clean notes`,
  );
  return [
    "## Planted-error localization reference (preGateOnly, review-only — NOT a runtime accusation)",
    "",
    `- overall detection recall: ${loc.plantedDetected}/${loc.plantedTotal} (${loc.overallDetectionRate})`,
    `- false-positive rate on clean notes of the same takes: ${loc.cleanFalsePositive}/${loc.cleanRowTotal} (${loc.falsePositiveRate})`,
    "",
    "By error kind:",
    "",
    ...kindLines,
    "",
    "Per recording:",
    "",
    ...recLines,
    "",
  ];
}

function renderPolicyCSection(policy) {
  if (!policy) return [];
  return [
    "## Policy C review-assist gate (two-layer semantics)",
    "",
    `- reviewAssistGateReady: ${policy.reviewAssistGateReady}`,
    `- autoAccusationReady: ${policy.autoAccusationReady}`,
    `- planted detected: ${policy.planted.detected}/${policy.planted.total} (${policy.planted.combinedRecall})`,
    `- planted strict confirmed / self-check hints: ${policy.planted.strictConfirmed}/${policy.planted.selfCheckHints}`,
    `- non-planted strict false accusations: ${policy.nonPlanted.strictFalseAccusations}/${policy.nonPlanted.total}`,
    `- non-planted self-check hints: ${policy.nonPlanted.selfCheckHints}/${policy.nonPlanted.total} (${policy.nonPlanted.selfCheckHintFalsePositiveRate})`,
    `- combined precision proxy: ${policy.combinedPrecisionProxy}`,
    `- waveform energy measured: ${policy.energyEvidence.waveformEnergyMeasured}`,
    `- energyRobustnessReady: ${policy.energyEvidence.energyRobustnessReady}`,
    "- assignment gaps are self-check hints, never automatic accusations",
    "",
  ];
}

function renderRhythmChannelSection(diagnostic) {
  if (!diagnostic) return [];
  const frozen = diagnostic.frozenOperatingPoint;
  const best = diagnostic.bestAtRecallFloor;
  return [
    "## Relative-IOI rhythm-channel diagnostic (preGateOnly)",
    "",
    `- feature coverage: ${diagnostic.sample.featureAvailablePositions}/${diagnostic.sample.totalPositions}`,
    `- rhythm targets: ${diagnostic.sample.rhythmTargetTotal}`,
    `- frozen threshold ${frozen.threshold}: TP ${frozen.truePositive}, FP ${frozen.falsePositive}, precision ${frozen.precision}, recall ${frozen.recall}`,
    `- best point at recall floor: threshold ${best?.threshold}, TP ${best?.truePositive}, FP ${best?.falsePositive}, precision ${best?.precision}, recall ${best?.recall}`,
    `- evaluatedThresholdCount: ${diagnostic.evaluatedThresholdCount}`,
    `- jointFloorReady: ${diagnostic.jointFloorReady}`,
    "- this channel remains diagnostic-only; no review hint or accusation is authorized",
    "",
  ];
}

function renderMarkdown(report) {
  const lines = [
    "# Ordinary Dynamic Shadow Full-Score Fresh-Blind Evidence",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "Scope: implementation evidence only (preGateOnly). This report never",
    "authorizes the student runtime and does not by itself grant the",
    "separate western-ordinary-dynamic-shadow-release-v1 authorization.",
    "",
    `- evidenceReady: ${report.evidenceReady}`,
    `- recordingCount: ${report.recordingCount}`,
    "",
    "## Clean-full tier (score is ground truth)",
    "",
    ...report.tiers.cleanFull.rows.map((row) => `- ${row.recordingId}: coverage ${row.shadowCoverage} (floor ${report.tiers.cleanFull.coverageFloor})`),
    "",
    "## Technique-safety tier (marked-zone accusation must be zero)",
    "",
    `- totalMarkedZoneRows: ${report.tiers.techniqueSafety.totalMarkedZoneRows}`,
    `- totalMarkedZoneAccusations: ${report.tiers.techniqueSafety.totalMarkedZoneAccusations}`,
    ...report.tiers.techniqueSafety.rows.map((row) => `- ${row.recordingId}: markedZoneRows ${row.markedZoneRowCount}, accusations ${row.markedZoneAccusationCount}, coverage ${row.shadowCoverage}`),
    "",
    "## Error-reference tier (informational only, NOT ground-truth precision)",
    "",
    ...report.tiers.errorReferenceOnly.rows.map((row) => `- ${row.recordingId}: coverage ${row.shadowCoverage} (reference only, no confirmed error positions)`),
    "",
    ...renderLocalizationSection(report.tiers.errorReferenceOnly.positionLocalization),
    ...renderPolicyCSection(report.policyCReviewAssist),
    ...renderRhythmChannelSection(report.rhythmChannelDiagnostic),
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") args.manifestPath = argv[++index];
    else if (argv[index] === "--machine-analysis") args.machineAnalysisPath = argv[++index];
    else if (argv[index] === "--out-dir") args.outDir = argv[++index];
    else if (argv[index] === "--position-truth") args.positionTruthPath = argv[++index];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const auditOpts = {};
  if (args.manifestPath) auditOpts.manifestPath = args.manifestPath;
  if (args.machineAnalysisPath) auditOpts.machineAnalysisPath = args.machineAnalysisPath;
  if (args.positionTruthPath) auditOpts.positionTruthPath = args.positionTruthPath;
  const outDirRel = args.outDir || DEFAULT_OUT_DIR;
  const report = auditFreshBlindEvidence(auditOpts);
  const outDir = path.resolve(outDirRel);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report), "utf8");
  const liveAudit = report.evidenceReady
    ? auditFreshBlindEvidenceLiveArtifacts({ reportPath: path.join(outDirRel, "report.json") })
    : { ready: false, blockingReasons: ["fresh-blind-evidence-not-ready"] };
  console.log(JSON.stringify({
    ok: report.evidenceReady && liveAudit.ready,
    evidenceReady: report.evidenceReady,
    liveAuditReady: liveAudit.ready,
    blockingReasons: report.blockingReasons,
    liveAuditBlockingReasons: liveAudit.blockingReasons,
    cleanCoverage: report.tiers.cleanFull.rows.map((row) => [row.recordingId, row.shadowCoverage]),
    techniqueSafety: {
      totalMarkedZoneRows: report.tiers.techniqueSafety.totalMarkedZoneRows,
      totalMarkedZoneAccusations: report.tiers.techniqueSafety.totalMarkedZoneAccusations,
    },
    positionLocalization: report.tiers.errorReferenceOnly.positionLocalization
      ? {
        overallDetectionRate: report.tiers.errorReferenceOnly.positionLocalization.overallDetectionRate,
        plantedDetected: report.tiers.errorReferenceOnly.positionLocalization.plantedDetected,
        plantedTotal: report.tiers.errorReferenceOnly.positionLocalization.plantedTotal,
        detectionByKind: report.tiers.errorReferenceOnly.positionLocalization.detectionByKind,
        falsePositiveRate: report.tiers.errorReferenceOnly.positionLocalization.falsePositiveRate,
      }
      : null,
    policyCReviewAssist: report.policyCReviewAssist
      ? {
        reviewAssistGateReady: report.policyCReviewAssist.reviewAssistGateReady,
        autoAccusationReady: report.policyCReviewAssist.autoAccusationReady,
        planted: report.policyCReviewAssist.planted,
        nonPlanted: report.policyCReviewAssist.nonPlanted,
        combinedPrecisionProxy: report.policyCReviewAssist.combinedPrecisionProxy,
        energyRobustnessReady: report.policyCReviewAssist.energyEvidence.energyRobustnessReady,
      }
      : null,
    rhythmChannelDiagnostic: report.rhythmChannelDiagnostic
      ? {
        sample: report.rhythmChannelDiagnostic.sample,
        frozenOperatingPoint: report.rhythmChannelDiagnostic.frozenOperatingPoint,
        bestAtRecallFloor: report.rhythmChannelDiagnostic.bestAtRecallFloor,
        jointFloorReady: report.rhythmChannelDiagnostic.jointFloorReady,
        blockingReasons: report.rhythmChannelDiagnostic.blockingReasons,
      }
      : null,
    out: rel(path.join(outDirRel, "report.json")),
  }, null, 2));
  if (!(report.evidenceReady && liveAudit.ready)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
