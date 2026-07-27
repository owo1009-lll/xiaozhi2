#!/usr/bin/env node
// r3 implementation-acceptance runner for the ordinary-dynamic-shadow
// executor: run r3-02 and r3-03 through the attested runtime twice each
// (cold cache miss, then warm cache hit) and write the acceptance report the
// project status validates. This is implementation acceptance only
// (preGateOnly): it never authorizes the student runtime, and every run
// stays review-only with zero auto-pass rows.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  ACCEPTANCE_REPORT_RELATIVE_PATH,
  ORDINARY_DYNAMIC_ACCEPTANCE_VERSION,
  ORDINARY_DYNAMIC_CONTRACT_VERSION,
  ORDINARY_DYNAMIC_GATE_VERSION,
  ORDINARY_DYNAMIC_POLICY_VERSION,
  ORDINARY_DYNAMIC_SCORE_BINDING_MODE,
  ORDINARY_DYNAMIC_TIMING_MODE,
  auditCandidateRunPayload,
  auditOrdinaryDynamicShadowAcceptanceLiveArtifacts,
  loadScoreStore,
  sha256Bytes,
  sha256Canonical,
} from "./audit-western-ordinary-dynamic-shadow-acceptance.mjs";
import {
  ORDINARY_AUDIO_RUNTIME_ANCHORS,
  evaluateOrdinaryAudioRuntime,
} from "./run-western-ordinary-audio-python.mjs";

const COVERAGE_FLOOR = 0.2;
const ACCEPTANCE_DIR = path.dirname(ACCEPTANCE_REPORT_RELATIVE_PATH);
const RUNS_DIR = path.join(ACCEPTANCE_DIR, "runs");
const CACHE_DIR = path.join(ACCEPTANCE_DIR, "basic-pitch-cache");
const ANALYSIS_SCRIPT = path.join("scripts", "experiments", "run_western_strings_offline_feature_analysis.py");
const RECORDINGS = [
  { recordingId: "r3-02", scoreTitle: "r3-02", audioPath: path.join("data", "private", "western-strings-round3", "r3-02.m4a") },
  { recordingId: "r3-03", scoreTitle: "r3-03", audioPath: path.join("data", "private", "western-strings-round3", "r3-03.m4a") },
];

function rel(value) {
  return String(value || "").replace(/\\/g, "/");
}

function runManagedAnalysis({ repoRoot, scoreId, audioPath }) {
  const result = spawnSync(
    process.execPath,
    [
      path.join("scripts", "run-western-ordinary-audio-python.mjs"),
      "--script",
      ANALYSIS_SCRIPT,
      "--",
      "--repo-root",
      repoRoot,
      "--score-id",
      scoreId,
      "--audio",
      path.resolve(repoRoot, audioPath),
      "--timing-mode",
      "basic-pitch-dtw",
      "--basic-pitch-cache",
      CACHE_DIR,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) return { ok: false, reason: `analysis-spawn-failed:${result.error.message}` };
  if (result.status !== 0) {
    return { ok: false, reason: `analysis-exit-${result.status}:${String(result.stderr || "").slice(-400)}` };
  }
  // Basic Pitch prints a progress line to stdout on cold runs; the payload is
  // the last JSON line.
  const jsonLine = String(result.stdout || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .pop();
  if (!jsonLine) return { ok: false, reason: "analysis-stdout-json-missing" };
  try {
    return { ok: true, payload: JSON.parse(jsonLine) };
  } catch (error) {
    return { ok: false, reason: `analysis-stdout-json-invalid:${error.message}` };
  }
}

function executeAcceptanceRun({ repoRoot, recording, scoreId, label, fail }) {
  const prefix = `acceptance-run-failed:${recording.recordingId}:${label}`;
  const analysis = runManagedAnalysis({ repoRoot, scoreId, audioPath: recording.audioPath });
  if (!analysis.ok) {
    fail(`${prefix}:${analysis.reason}`);
    return null;
  }
  const payload = analysis.payload;
  if (payload.ok !== true) {
    fail(`${prefix}:${(payload.blockingReasons || ["analysis-not-ok"]).join(",")}`);
    return null;
  }
  const artifactRelative = path.join(RUNS_DIR, `${recording.recordingId}-${label}.json`);
  const artifactAbsolute = path.resolve(repoRoot, artifactRelative);
  fs.mkdirSync(path.dirname(artifactAbsolute), { recursive: true });
  const artifactBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(artifactAbsolute, artifactBytes);

  const audit = auditCandidateRunPayload(payload, { scoreId });
  for (const reason of audit.blockingReasons) fail(`${prefix}:${reason}`);
  const derived = audit.derived || {};
  const expectedCacheHit = label === "warm";
  if (derived.cacheHit !== expectedCacheHit) fail(`${prefix}:cache-hit-expected-${expectedCacheHit}`);
  return {
    label,
    cacheHit: derived.cacheHit === true,
    cacheIdentityBound: derived.cacheIdentityBound === true,
    candidateArtifactAuditPassed: audit.ok,
    allRowsReviewRequired: audit.ok,
    autoPassCount: 0,
    reviewRequiredCount: derived.reviewRequiredCount ?? null,
    candidateRowCount: derived.candidateRowCount ?? null,
    scoreNoteCount: derived.candidateRowCount ?? null,
    studentFacing: false,
    automaticAdoptionAuthorized: false,
    authorizationReady: false,
    energyVetoIncluded: false,
    causalEnergyStatus: "excluded-review-only",
    contractVersion: ORDINARY_DYNAMIC_CONTRACT_VERSION,
    policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
    gateVersion: ORDINARY_DYNAMIC_GATE_VERSION,
    timingMode: ORDINARY_DYNAMIC_TIMING_MODE,
    audioSha256: derived.audioSha256 || "",
    scorePayloadSha256: derived.scorePayloadSha256 || "",
    scoreStoreArtifactSha256: derived.scoreStoreArtifactSha256 || "",
    modelArtifactSha256: derived.modelArtifactSha256 || "",
    cachePath: rel(derived.cachePath || ""),
    cacheArtifactSha256: derived.cacheArtifactSha256 || "",
    candidateArtifactPath: rel(artifactRelative),
    candidateArtifactSha256: sha256Bytes(artifactBytes),
    candidateEvidenceSha256: derived.candidateEvidenceSha256 || "",
    selectedCount: derived.selectedCount ?? null,
    exactPitchSelectedCount: derived.exactPitchSelectedCount ?? null,
  };
}

export async function runOrdinaryDynamicShadowAcceptance({ repoRoot = process.cwd() } = {}) {
  const blockingReasons = [];
  const fail = (reason) => blockingReasons.push(reason);

  const runtime = evaluateOrdinaryAudioRuntime();
  if (runtime.runtimeReady !== true) {
    fail("acceptance-runtime-preflight-failed");
    for (const reason of runtime.blockingReasons || []) fail(reason);
  }

  const store = loadScoreStore(repoRoot);
  if (!store.ok) fail(`acceptance-score-store-${store.status}`);
  const recordingPlans = [];
  for (const recording of RECORDINGS) {
    if (!fs.existsSync(path.resolve(repoRoot, recording.audioPath))) {
      fail(`acceptance-audio-missing:${recording.recordingId}`);
      continue;
    }
    const matches = (store.scores || []).filter(
      (score) => String(score?.title || "").trim() === recording.scoreTitle,
    );
    if (matches.length !== 1) {
      fail(`acceptance-score-title-not-unique:${recording.recordingId}:${matches.length}`);
      continue;
    }
    recordingPlans.push({ recording, scoreId: String(matches[0].scoreId || "") });
  }

  // A fresh dedicated cache directory guarantees genuine cold semantics for
  // the first run of each recording.
  const cacheAbsolute = path.resolve(repoRoot, CACHE_DIR);
  fs.rmSync(cacheAbsolute, { recursive: true, force: true });
  fs.mkdirSync(cacheAbsolute, { recursive: true });

  const recordings = [];
  if (!blockingReasons.length) {
    for (const { recording, scoreId } of recordingPlans) {
      const cold = executeAcceptanceRun({ repoRoot, recording, scoreId, label: "cold", fail });
      const warm = executeAcceptanceRun({ repoRoot, recording, scoreId, label: "warm", fail });
      if (!cold || !warm) continue;
      const prefix = `acceptance-recording-invalid:${recording.recordingId}`;
      if (cold.cacheArtifactSha256 !== warm.cacheArtifactSha256) fail(`${prefix}:cold-warm-cache-mismatch`);
      if (cold.candidateEvidenceSha256 !== warm.candidateEvidenceSha256) fail(`${prefix}:cold-warm-evidence-mismatch`);
      if (
        cold.candidateRowCount !== warm.candidateRowCount
        || cold.selectedCount !== warm.selectedCount
        || cold.audioSha256 !== warm.audioSha256
        || cold.scorePayloadSha256 !== warm.scorePayloadSha256
        || cold.scoreStoreArtifactSha256 !== warm.scoreStoreArtifactSha256
      ) {
        fail(`${prefix}:cold-warm-claims-mismatch`);
      }
      const rowCount = cold.candidateRowCount || 0;
      const selectedCount = cold.selectedCount || 0;
      const coverage = rowCount > 0 ? selectedCount / rowCount : 0;
      if (coverage < COVERAGE_FLOOR) fail(`${prefix}:coverage-below-floor:${coverage.toFixed(6)}`);
      const fullArtifactAuditPassed = cold.candidateArtifactAuditPassed && warm.candidateArtifactAuditPassed;
      const stripRun = ({ selectedCount: _s, exactPitchSelectedCount: _e, ...run }) => run;
      recordings.push({
        recordingId: recording.recordingId,
        scoreId,
        audioPath: rel(recording.audioPath),
        audioSha256: cold.audioSha256,
        scorePayloadSha256: cold.scorePayloadSha256,
        scoreStoreArtifactSha256: cold.scoreStoreArtifactSha256,
        scoreNoteCount: rowCount,
        candidateRowCount: rowCount,
        shadowSelectedCandidateCount: selectedCount,
        exactPitchSelectedCount: cold.exactPitchSelectedCount || 0,
        shadowCoverage: Number(coverage.toFixed(6)),
        allRowsReviewRequired: cold.allRowsReviewRequired && warm.allRowsReviewRequired,
        autoPassCount: 0,
        studentFacing: false,
        fullArtifactAuditPassed,
        coldRun: stripRun(cold),
        warmRun: stripRun(warm),
      });
    }
  }

  const acceptance = {
    schemaVersion: 2,
    contractVersion: ORDINARY_DYNAMIC_ACCEPTANCE_VERSION,
    scoreBindingMode: ORDINARY_DYNAMIC_SCORE_BINDING_MODE,
    candidateContractVersion: ORDINARY_DYNAMIC_CONTRACT_VERSION,
    policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
    gateVersion: ORDINARY_DYNAMIC_GATE_VERSION,
    timingMode: ORDINARY_DYNAMIC_TIMING_MODE,
    scope: "implementation-acceptance-preGateOnly",
    runtimeId: ORDINARY_AUDIO_RUNTIME_ANCHORS.runtimeId,
    studentFacing: false,
    automaticAdoptionAuthorized: false,
    authorizationReady: false,
    energyVetoIncluded: false,
    causalEnergyStatus: "excluded-review-only",
    recordings,
    aggregate: {
      recordingCount: recordings.length,
      coldCacheMissCount: recordings.filter((row) => row.coldRun?.cacheHit === false).length,
      warmCacheHitCount: recordings.filter((row) => row.warmRun?.cacheHit === true).length,
      coverageFloor: COVERAGE_FLOOR,
      allRowsReviewRequired: recordings.length > 0 && recordings.every((row) => row.allRowsReviewRequired === true),
      allArtifactsBound: recordings.length > 0 && recordings.every((row) => row.fullArtifactAuditPassed === true),
      coldWarmEvidenceStable: recordings.length > 0 && recordings.every(
        (row) => row.coldRun?.candidateEvidenceSha256 === row.warmRun?.candidateEvidenceSha256
          && row.coldRun?.cacheArtifactSha256 === row.warmRun?.cacheArtifactSha256,
      ),
    },
    acceptanceReady: blockingReasons.length === 0,
    blockingReasons: [...new Set(blockingReasons)],
  };
  acceptance.generatedAt = new Date().toISOString();
  acceptance.evidenceDigestSha256 = (() => {
    const digestPayload = structuredClone(acceptance);
    delete digestPayload.evidenceDigestSha256;
    delete digestPayload.generatedAt;
    return sha256Canonical(digestPayload);
  })();

  const reportAbsolute = path.resolve(repoRoot, ACCEPTANCE_REPORT_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(reportAbsolute), { recursive: true });
  fs.writeFileSync(reportAbsolute, `${JSON.stringify(acceptance, null, 2)}\n`, "utf8");

  const liveAudit = acceptance.acceptanceReady
    ? auditOrdinaryDynamicShadowAcceptanceLiveArtifacts({ repoRoot, runtimeReport: runtime })
    : { ready: false, blockingReasons: ["acceptance-not-ready"] };

  const markdown = [
    "# Ordinary Dynamic Shadow r3 Implementation Acceptance",
    "",
    `Generated: ${acceptance.generatedAt}`,
    "",
    "Scope: implementation acceptance only (preGateOnly). This report never",
    "authorizes the student runtime; every row stays review-only.",
    "",
    "## Recordings",
    "",
    ...recordings.map((row) => [
      `- ${row.recordingId} (${row.scoreId}): rows ${row.candidateRowCount},`,
      `selected ${row.shadowSelectedCandidateCount} (coverage ${row.shadowCoverage}),`,
      `autoPass ${row.autoPassCount}, cold cacheHit ${row.coldRun?.cacheHit}, warm cacheHit ${row.warmRun?.cacheHit}`,
    ].join(" ")),
    "",
    `- acceptanceReady: ${acceptance.acceptanceReady}`,
    `- liveArtifactAuditReady: ${liveAudit.ready}`,
    "",
    "## Blocking Reasons",
    "",
    ...(acceptance.blockingReasons.length ? acceptance.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
  ].join("\n");
  fs.writeFileSync(path.resolve(repoRoot, ACCEPTANCE_DIR, "report.md"), markdown, "utf8");

  return { acceptance, liveAudit, reportPath: rel(ACCEPTANCE_REPORT_RELATIVE_PATH) };
}

async function main() {
  const { acceptance, liveAudit, reportPath } = await runOrdinaryDynamicShadowAcceptance({});
  console.log(JSON.stringify({
    ok: acceptance.acceptanceReady && liveAudit.ready,
    acceptanceReady: acceptance.acceptanceReady,
    liveArtifactAuditReady: liveAudit.ready,
    blockingReasons: acceptance.blockingReasons,
    liveAuditBlockingReasons: liveAudit.blockingReasons || [],
    recordings: acceptance.recordings.map((row) => ({
      recordingId: row.recordingId,
      rows: row.candidateRowCount,
      selected: row.shadowSelectedCandidateCount,
      coverage: row.shadowCoverage,
      coldCacheHit: row.coldRun?.cacheHit,
      warmCacheHit: row.warmRun?.cacheHit,
    })),
    report: reportPath,
  }, null, 2));
  if (!(acceptance.acceptanceReady && liveAudit.ready)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
