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
  };
}

export function auditFreshBlindEvidence({
  repoRoot = process.cwd(),
  manifestPath = DEFAULT_MANIFEST,
  machineAnalysisPath = DEFAULT_MACHINE_ANALYSIS,
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
    recordingCount: recordings.length,
    tiers: {
      cleanFull: {
        recordingIds: clean.map((row) => row.recordingId),
        coverageFloor: CLEAN_COVERAGE_FLOOR,
        rows: clean,
      },
      techniqueSafety: {
        recordingIds: technique.map((row) => row.recordingId),
        totalMarkedZoneRows,
        totalMarkedZoneAccusations,
        rows: technique,
      },
      errorReferenceOnly: {
        recordingIds: errorReference.map((row) => row.recordingId),
        groundTruthPrecision: false,
        note: "exact error positions were not recorded; these numbers are informational only and must never be counted toward a precision or zero-dangerous-leak claim",
        rows: errorReference,
      },
    },
    recordings,
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
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const report = auditFreshBlindEvidence({});
  const outDir = path.resolve(DEFAULT_OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report), "utf8");
  const liveAudit = report.evidenceReady
    ? auditFreshBlindEvidenceLiveArtifacts({})
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
    out: rel(path.join(DEFAULT_OUT_DIR, "report.json")),
  }, null, 2));
  if (!(report.evidenceReady && liveAudit.ready)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
