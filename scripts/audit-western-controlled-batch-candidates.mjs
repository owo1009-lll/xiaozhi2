import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

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
const BASIC_PITCH_MODEL_ARTIFACT_SHA256 = "c6595f299ff83c52e89555789f7e3e829a6a0f25b6a88f7e99073af5a2470dc4";
const ORDINARY_AUDIO_RUNTIME_ID = "western-ordinary-dynamic-shadow-audio-py311";
const ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256 = "1f3a47f5cfe2b2d2e427be9a03ab43b4b4aa09a5db0edeed0b55e610a42ac6f9";
const ORDINARY_AUDIO_RUNTIME_LOCK_SHA256 = "4120a811da1ecb1aa93ceabcbb5aa0b45a37c08e5ee3138d2b793e38f2828d04";

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
  if (storeSha256 !== safeString(scoreProvenance?.scoreStoreArtifactSha256).trim().toLowerCase()) {
    blockingReasons.push("feature-review-score-store-artifact-sha-mismatch");
  }
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
  const expectedSha256 = noteIdentitySha256(expectedNotes);
  const candidateSha256 = noteIdentitySha256(candidateNotes);
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
    noteCount: expectedNotes.length,
  };
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
}

export function auditFeatureReviewItem(item = {}, {
  runIndex = 0,
  itemIndex = 0,
  sourceRoot = "",
  batchRunId = "",
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
        for (const [candidateIndex, candidate] of rows.entries()) {
          auditDynamicCandidate(candidate, failures, {
            runIndex,
            itemIndex,
            candidateIndex,
            source: "artifact",
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

export function auditControlledBatchRuns(runs = [], { requireFeatureReview = false, sourceRoot = "", latestOnly = false } = {}) {
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
      }));
    }
  }

  if (requireFeatureReview && featureReviewItemCount === 0) {
    pushFailure(failures, "no-feature-review-items-found");
  }

  return {
    ok: failures.length === 0,
    runCount,
    auditedRunMode: latestOnly ? "latest" : "all",
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
