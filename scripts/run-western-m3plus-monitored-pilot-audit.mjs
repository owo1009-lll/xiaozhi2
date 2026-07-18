import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { auditControlledBatchRuns } from "./audit-western-controlled-batch-candidates.mjs";

const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3plus", "monitored-pilot");
const DEFAULT_RESCOPE_GATE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "rescope-gate",
  "report.json",
);
const DEFAULT_BATCH_RUNS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "controlled-submission-batch-runs.jsonl",
);

export const RESCOPE_SCHEMA_VERSION = 2;
export const CONTRACT = "m3plus-rescope-four-zone-v2";
export const RUNTIME_CONTRACT = "m3plus-gold-free-runtime-v1";
export const RUNTIME_POLICY_VERSION = "m3plus-gold-free-pitch-safety-policy-v1";
const EXPECTED_STRAIGHT_UNIT_COUNT = 12;
const EXPECTED_TECHNIQUE_CENTER_UNIT_COUNT = 8;
const EXPECTED_PROTECTED_UNIT_COUNT = 14;
const EXPECTED_ROUND2_PROTECTED_UNIT_COUNT = 6;
export const REQUIRED_SOURCE_BINDING_PATHS = Object.freeze({
  machineSource: "data/experiments/western-strings-m3plus/supplemental-machine-eval/supplemental-machine-eval.json",
  humanGold: "docs/western-strings-round2-m3plus-human-gold.json",
  m3CoreGate: "data/experiments/western-strings-m3/m3-diagnosis-summary.json",
  rescopeDecision: "docs/western-strings-m3plus-rescope-decision.md",
  evaluator: "scripts/experiments/eval_western_strings_m3plus_rescope_gate.py",
});
export const REQUIRED_SOURCE_BINDINGS = Object.keys(REQUIRED_SOURCE_BINDING_PATHS);
export const RELEASE_ZONES = [
  "unmarkedStraight",
  "scoreMarkedNeutral",
  "techniqueCenter",
  "unstableFailClosed",
];
export const INHERITED_ZONES = { rhythmOnset: "inherits-m3-core-gate-unchanged" };

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    rescopeGate: DEFAULT_RESCOPE_GATE,
    batchRuns: DEFAULT_BATCH_RUNS,
    minPrecision: 0.9,
    maxPitchToleranceCents: 50,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
    else if (arg === "--rescope-gate") args.rescopeGate = argv[++index] || args.rescopeGate;
    else if (arg === "--batch-runs") args.batchRuns = argv[++index] || args.batchRuns;
    else if (arg === "--min-precision") args.minPrecision = Number(argv[++index] || args.minPrecision);
    else if (arg === "--max-pitch-tolerance-cents") {
      args.maxPitchToleranceCents = Number(argv[++index] || args.maxPitchToleranceCents);
    }
  }
  return args;
}

function rel(filePath, root = process.cwd()) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/.test(safeString(value).toLowerCase());
}

function normalizedPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

async function readJsonWithBytes(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return {
      exists: true,
      bytes,
      sha256: sha256(bytes),
      value: JSON.parse(bytes.toString("utf8")),
      error: "",
    };
  } catch (error) {
    return {
      exists: false,
      bytes: null,
      sha256: "",
      value: null,
      error: String(error?.message || error),
    };
  }
}

async function readStableFile(filePath) {
  const before = await fs.stat(filePath);
  const bytes = await fs.readFile(filePath);
  const after = await fs.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("file-changed-during-audit");
  }
  return bytes;
}

export function evaluateRescopeContract(gate, options = {}) {
  const minPrecision = Number.isFinite(options.minPrecision) ? options.minPrecision : 0.9;
  const maxPitchToleranceCents = Number.isFinite(options.maxPitchToleranceCents)
    ? options.maxPitchToleranceCents
    : 50;
  const blockingReasons = [];
  const zones = {};

  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    return { ready: false, zones, blockingReasons: ["m3plus-rescope-gate-missing"] };
  }
  if (gate.schemaVersion !== RESCOPE_SCHEMA_VERSION) {
    blockingReasons.push("m3plus-rescope-schema-version-mismatch");
  }
  if (gate.contract !== CONTRACT) blockingReasons.push("m3plus-rescope-contract-mismatch");
  if (gate.sourceBindingsReady !== true) blockingReasons.push("m3plus-rescope-source-bindings-not-ready");
  if (gate.evalOnly !== true) blockingReasons.push("m3plus-rescope-gate-not-eval-only");
  if (gate.productionPolicyChanged !== false) {
    blockingReasons.push("m3plus-rescope-gate-production-policy-changed");
  }
  if (gate.studentGateReady !== false) blockingReasons.push("m3plus-rescope-student-gate-not-fail-closed");
  if (gate.studentFacing !== false) blockingReasons.push("m3plus-rescope-student-facing-not-false");
  if (gate.releaseGateReady !== true) blockingReasons.push("m3plus-rescope-gate-not-ready");
  for (const reason of gate.blockingReasons || []) {
    blockingReasons.push(`m3plus-rescope-gate-blocking:${reason}`);
  }

  const thresholds = gate.thresholds || {};
  const gateMinPrecision = finiteNumber(thresholds.minimumPrecision);
  const gateTolerance = finiteNumber(thresholds.pitchToleranceCents);
  if (gateMinPrecision === null || gateMinPrecision < minPrecision) {
    blockingReasons.push("m3plus-threshold-precision-below-floor");
  }
  if (gateTolerance === null || gateTolerance > maxPitchToleranceCents) {
    blockingReasons.push("m3plus-threshold-tolerance-above-ceiling");
  }
  if (thresholds.evaluationSplit !== "holdout-only") {
    blockingReasons.push("m3plus-evaluation-split-not-holdout-only");
  }

  const zone = (name) => (gate.zones || {})[name] || null;
  const straight = zone("unmarkedStraight");
  const straightFloor = finiteNumber(thresholds.minimumStraightDecisions) ?? 4;
  const straightPrecision = finiteNumber(straight?.precision);
  const straightGoldExpectedUnits = finiteNumber(straight?.intonationGoldExpectedUnitCount);
  const straightGoldObservedUnits = finiteNumber(straight?.intonationGoldObservedUnitCount);
  const straightGoldJoinedUnits = finiteNumber(straight?.intonationGoldJoinedUnitCount);
  const straightGoldUnjoinedUnits = finiteNumber(straight?.intonationGoldUnjoinedUnitCount);
  const straightGoldAgreementRate = finiteNumber(straight?.intonationGoldAgreementRate);
  const straightReady = Boolean(
    straight?.gatePassed === true
    && straight?.goldJoinReady === true
    && straightPrecision !== null
    && straightPrecision >= minPrecision
    && straight.unsafeAccusationCount === 0
    && finiteNumber(straight.decisionCount) !== null
    && straight.decisionCount >= straightFloor
    && straightGoldExpectedUnits === EXPECTED_STRAIGHT_UNIT_COUNT
    && straightGoldObservedUnits === EXPECTED_STRAIGHT_UNIT_COUNT
    && straightGoldJoinedUnits === EXPECTED_STRAIGHT_UNIT_COUNT
    && straightGoldUnjoinedUnits === 0
    && straightGoldAgreementRate !== null
    && straightGoldAgreementRate >= minPrecision
    && finiteNumber(straight?.intonationGoldFalsePositiveCount) === 0
    && finiteNumber(straight?.intonationGoldDuplicateUnitCount) === 0,
  );
  if (!straightReady) blockingReasons.push("m3plus-zone-not-ready:unmarkedStraight");
  zones.unmarkedStraight = {
    ready: straightReady,
    decisionCount: finiteNumber(straight?.decisionCount),
    precision: straightPrecision,
    unsafeAccusationCount: finiteNumber(straight?.unsafeAccusationCount),
    insufficientEvidenceCount: finiteNumber(straight?.insufficientEvidenceCount),
    decisionCoverage: finiteNumber(straight?.decisionCoverage),
    goldJoinReady: straight?.goldJoinReady === true,
    expectedGoldUnitCount: straightGoldExpectedUnits,
    observedGoldUnitCount: straightGoldObservedUnits,
    joinedGoldUnitCount: straightGoldJoinedUnits,
    unjoinedGoldUnitCount: straightGoldUnjoinedUnits,
    goldAgreementRate: straightGoldAgreementRate,
  };

  const neutral = zone("scoreMarkedNeutral");
  const evaluatedProtectedCount = finiteNumber(neutral?.evaluatedProtectedCount);
  const declaredOnlyProtectedCount = finiteNumber(neutral?.declaredOnlyProtectedCount);
  const neutralReady = Boolean(
    neutral?.gatePassed === true
    && evaluatedProtectedCount === EXPECTED_PROTECTED_UNIT_COUNT
    && declaredOnlyProtectedCount === 0
    && finiteNumber(neutral?.expectedProtectedCount) === EXPECTED_PROTECTED_UNIT_COUNT
    && finiteNumber(neutral?.totalProtectedCount) === EXPECTED_PROTECTED_UNIT_COUNT
    && neutral?.protectedGoldInventoryReady === true
    && finiteNumber(neutral?.protectedGoldExpectedUnitCount) === EXPECTED_ROUND2_PROTECTED_UNIT_COUNT
    && finiteNumber(neutral?.protectedGoldJoinedUnitCount) === EXPECTED_ROUND2_PROTECTED_UNIT_COUNT
    && finiteNumber(neutral?.protectedGoldDuplicateUnitCount) === 0
    && neutral?.accusationCount === 0
    && finiteNumber(neutral?.insufficientEvidenceCount) === evaluatedProtectedCount,
  );
  if (!neutralReady) blockingReasons.push("m3plus-zone-not-ready:scoreMarkedNeutral");
  zones.scoreMarkedNeutral = {
    ready: neutralReady,
    evaluatedProtectedCount,
    declaredOnlyProtectedCount,
    totalDeclaredOrEvaluatedCount: finiteNumber(neutral?.totalDeclaredOrEvaluatedCount),
    expectedProtectedCount: finiteNumber(neutral?.expectedProtectedCount),
    protectedGoldInventoryReady: neutral?.protectedGoldInventoryReady === true,
    protectedGoldExpectedUnitCount: finiteNumber(neutral?.protectedGoldExpectedUnitCount),
    protectedGoldJoinedUnitCount: finiteNumber(neutral?.protectedGoldJoinedUnitCount),
    accusationCount: finiteNumber(neutral?.accusationCount),
    insufficientEvidenceCount: finiteNumber(neutral?.insufficientEvidenceCount),
  };

  const center = zone("techniqueCenter");
  const centerExpected = finiteNumber(center?.intonationGoldExpectedDecisionCount);
  const centerJoined = finiteNumber(center?.intonationGoldJoinedDecisionCount);
  const centerUnjoined = finiteNumber(center?.intonationGoldUnjoinedDecisionCount);
  const centerAgreementRate = finiteNumber(center?.intonationGoldAgreementRate);
  const centerExpectedUnits = finiteNumber(center?.intonationGoldExpectedUnitCount);
  const centerObservedUnits = finiteNumber(center?.intonationGoldObservedUnitCount);
  const centerJoinedUnits = finiteNumber(center?.intonationGoldJoinedUnitCount);
  const centerUnjoinedUnits = finiteNumber(center?.intonationGoldUnjoinedUnitCount);
  const centerReady = Boolean(
    center?.gatePassed === true
    && center?.goldJoinReady === true
    && centerExpected !== null
    && centerExpected > 0
    && centerExpectedUnits === EXPECTED_TECHNIQUE_CENTER_UNIT_COUNT
    && centerObservedUnits === EXPECTED_TECHNIQUE_CENTER_UNIT_COUNT
    && centerJoinedUnits === EXPECTED_TECHNIQUE_CENTER_UNIT_COUNT
    && centerUnjoinedUnits === 0
    && centerJoined === centerExpected
    && centerUnjoined === 0
    && centerAgreementRate !== null
    && centerAgreementRate >= minPrecision
    && finiteNumber(center?.intonationGoldDisagreementCount) === 0,
  );
  if (!centerReady) blockingReasons.push("m3plus-zone-not-ready:techniqueCenter");
  zones.techniqueCenter = {
    ready: centerReady,
    goldJoinReady: center?.goldJoinReady === true,
    expectedDecisionCount: centerExpected,
    joinedDecisionCount: centerJoined,
    unjoinedDecisionCount: centerUnjoined,
    agreementCount: finiteNumber(center?.intonationGoldAgreementCount),
    disagreementCount: finiteNumber(center?.intonationGoldDisagreementCount),
    agreementRate: centerAgreementRate,
    expectedGoldUnitCount: centerExpectedUnits,
    observedGoldUnitCount: centerObservedUnits,
    joinedGoldUnitCount: centerJoinedUnits,
    unjoinedGoldUnitCount: centerUnjoinedUnits,
  };

  const unstable = zone("unstableFailClosed");
  const unstableTested = finiteNumber(unstable?.testedCount);
  const unstableReady = Boolean(
    unstable?.gatePassed === true
    && unstable?.accusationCount === 0
    && unstableTested !== null
    && unstableTested > 0
    && finiteNumber(unstable?.insufficientEvidenceCount) === unstableTested,
  );
  if (!unstableReady) blockingReasons.push("m3plus-zone-not-ready:unstableFailClosed");
  zones.unstableFailClosed = {
    ready: unstableReady,
    testedCount: unstableTested,
    accusationCount: finiteNumber(unstable?.accusationCount),
    insufficientEvidenceCount: finiteNumber(unstable?.insufficientEvidenceCount),
  };

  const rhythm = zone("rhythmOnset");
  const rhythmReady = Boolean(
    rhythm?.gatePassed === true
    && rhythm?.changedByThisGate === false
    && rhythm?.m3CoreGateReady === true
    && rhythm?.onsetReady === true,
  );
  if (!rhythmReady) blockingReasons.push("m3plus-zone-not-ready:rhythmOnset");
  zones.rhythmOnset = {
    ready: rhythmReady,
    inherited: INHERITED_ZONES.rhythmOnset,
    gatePassed: rhythm?.gatePassed === true,
    m3CoreGateReady: rhythm?.m3CoreGateReady === true,
    onsetReady: rhythm?.onsetReady === true,
  };

  const unique = [...new Set(blockingReasons)];
  return { ready: unique.length === 0, zones, blockingReasons: unique };
}

export async function auditSourceBindings(gate, { sourceRoot = process.cwd() } = {}) {
  const blockingReasons = [];
  const bindings = {};
  const sourceBindings = gate?.sourceBindings || {};
  if (gate?.sourceBindingsReady !== true) {
    blockingReasons.push("m3plus-rescope-source-bindings-not-ready");
  }
  for (const name of REQUIRED_SOURCE_BINDINGS) {
    const binding = sourceBindings[name];
    const recordedPath = safeString(binding?.path);
    const expectedPath = REQUIRED_SOURCE_BINDING_PATHS[name];
    const recordedSha256 = safeString(binding?.sha256).toLowerCase();
    const result = {
      path: recordedPath,
      expectedPath,
      recordedSha256,
      observedSha256: "",
      ready: false,
    };
    bindings[name] = result;
    if (!recordedPath || !validSha256(recordedSha256)) {
      blockingReasons.push(`m3plus-rescope-source-binding-invalid:${name}`);
      continue;
    }
    if (recordedPath.replace(/\\/g, "/") !== expectedPath) {
      blockingReasons.push(`m3plus-rescope-source-binding-path-mismatch:${name}`);
      continue;
    }
    const candidate = path.resolve(sourceRoot, expectedPath);
    if (!isWithin(sourceRoot, candidate)) {
      blockingReasons.push(`m3plus-rescope-source-binding-outside-root:${name}`);
      continue;
    }
    try {
      const realRoot = await fs.realpath(path.resolve(sourceRoot));
      const realCandidate = await fs.realpath(candidate);
      if (!isWithin(realRoot, realCandidate)) {
        blockingReasons.push(`m3plus-rescope-source-binding-realpath-outside-root:${name}`);
        continue;
      }
      const bytes = await readStableFile(realCandidate);
      result.observedSha256 = sha256(bytes);
      result.ready = result.observedSha256 === recordedSha256;
      if (!result.ready) blockingReasons.push(`m3plus-rescope-source-binding-sha-mismatch:${name}`);
    } catch (error) {
      result.error = String(error?.message || error);
      blockingReasons.push(`m3plus-rescope-source-binding-unreadable:${name}`);
    }
  }
  const unique = [...new Set(blockingReasons)];
  return { ready: unique.length === 0, bindings, blockingReasons: unique };
}

async function readPhysicalLatestBatchRun(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return { ready: false, run: null, blockingReasons: ["m3plus-runtime-latest-batch-empty"] };
    try {
      return { ready: true, run: JSON.parse(lines.at(-1)), blockingReasons: [] };
    } catch (error) {
      return {
        ready: false,
        run: null,
        blockingReasons: ["m3plus-runtime-latest-batch-invalid-json"],
        error: String(error?.message || error),
      };
    }
  } catch (error) {
    return {
      ready: false,
      run: null,
      blockingReasons: ["m3plus-runtime-batch-runs-unreadable"],
      error: String(error?.message || error),
    };
  }
}

function isOrdinaryFeatureItem(item) {
  return safeString(item?.kind) !== "photo-score"
    && item?.analysisStatus === "offline_feature_review_ready";
}

function normalizeZone(value) {
  return safeString(value).replace(/[-_\s]/g, "").toLowerCase();
}

function isAccusation(evidence) {
  return evidence?.accusationIssued === true
    || evidence?.pitchIssue === true
    || ["issue_detected", "pitch_issue", "accuse"].includes(safeString(evidence?.decision).toLowerCase());
}

function highDispersionTriggered(evidence) {
  return evidence?.highDispersion === true
    || evidence?.dispersionGuardTriggered === true
    || safeString(evidence?.reason).toLowerCase().includes("dispersion");
}

function auditRuntimeRows(rows, runtime) {
  const blockingReasons = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row?.autoDecision !== "review_required" || row?.gateDecision !== "review_required") {
      blockingReasons.push(`m3plus-runtime-row-not-review-required:${rowIndex}`);
    }
    if (row?.studentFacing !== false) {
      blockingReasons.push(`m3plus-runtime-row-student-facing-not-false:${rowIndex}`);
    }
    const evidence = row?.m3plusPitchSafetyEvidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      blockingReasons.push(`m3plus-runtime-row-evidence-missing:${rowIndex}`);
      continue;
    }
    if (evidence.evaluationContract !== runtime.evaluationContract) {
      blockingReasons.push(`m3plus-runtime-row-evaluation-contract-mismatch:${rowIndex}`);
    }
    if (evidence.runtimeContract !== runtime.runtimeContract) {
      blockingReasons.push(`m3plus-runtime-row-runtime-contract-mismatch:${rowIndex}`);
    }
    if (evidence.policyVersion !== runtime.policyVersion) {
      blockingReasons.push(`m3plus-runtime-row-policy-version-mismatch:${rowIndex}`);
    }
    if (evidence.policySemanticSha256 !== runtime.policySemanticSha256) {
      blockingReasons.push(`m3plus-runtime-row-policy-sha-mismatch:${rowIndex}`);
    }
    const zone = normalizeZone(evidence.zone);
    if (zone === "scoremarkedneutral" && isAccusation(evidence)) {
      blockingReasons.push(`m3plus-runtime-score-marked-accusation:${rowIndex}`);
    }
    if (highDispersionTriggered(evidence)
        && (safeString(evidence.decision) !== "insufficient_evidence" || isAccusation(evidence))) {
      blockingReasons.push(`m3plus-runtime-high-dispersion-leak:${rowIndex}`);
    }
  }
  const unique = [...new Set(blockingReasons)];
  return { ready: rows.length > 0 && unique.length === 0, rowCount: rows.length, blockingReasons: unique };
}

async function auditRuntimeFoundation({
  sourceRoot,
  batchRunsPath,
  rescopeGatePath,
  rescopeReportSha256,
  dependencies,
}) {
  const blockingReasons = [];
  const latest = await readPhysicalLatestBatchRun(batchRunsPath);
  blockingReasons.push(...latest.blockingReasons);
  if (!latest.ready) {
    return {
      foundationReady: false,
      runtimeAuditReady: false,
      blockingReasons: [...new Set(blockingReasons)],
      batchRunId: "",
      ordinaryFeatureItemCount: 0,
      candidateRowCount: 0,
      ordinaryFoundationAudit: null,
    };
  }

  const items = Array.isArray(latest.run?.items) ? latest.run.items : [];
  const ordinaryItems = items.filter(isOrdinaryFeatureItem);
  if (!items.length) blockingReasons.push("m3plus-runtime-latest-batch-empty");
  else if (items.every((item) => safeString(item?.kind) === "photo-score")) {
    blockingReasons.push("m3plus-runtime-latest-batch-photo-only");
  } else if (!ordinaryItems.length) {
    blockingReasons.push("m3plus-runtime-latest-ordinary-feature-item-missing");
  }
  if (ordinaryItems.length > 1) {
    blockingReasons.push(`m3plus-runtime-latest-ordinary-feature-item-count-invalid:${ordinaryItems.length}`);
  }
  if (!ordinaryItems.length) {
    return {
      foundationReady: false,
      runtimeAuditReady: false,
      blockingReasons: [...new Set(blockingReasons)],
      batchRunId: safeString(latest.run?.batchRunId),
      ordinaryFeatureItemCount: 0,
      candidateRowCount: 0,
      ordinaryFoundationAudit: null,
    };
  }

  const item = ordinaryItems.at(-1);
  const runAudit = dependencies.auditControlledBatchRuns([latest.run], {
    requireFeatureReview: true,
    sourceRoot,
    latestOnly: true,
  });
  if (runAudit?.ok !== true) {
    for (const failure of runAudit?.failures || []) {
      blockingReasons.push(`m3plus-runtime-ordinary-foundation:${safeString(failure?.code) || "unknown"}`);
    }
    if (!(runAudit?.failures || []).length) {
      blockingReasons.push("m3plus-runtime-ordinary-foundation-audit-failed");
    }
  }

  const candidateRowsPath = safeString(item?.candidateRowsPath);
  const recordedCandidateSha = safeString(item?.candidateRowsSha256).toLowerCase();
  let artifact = null;
  let candidateRows = [];
  if (!candidateRowsPath) {
    blockingReasons.push("m3plus-runtime-candidate-artifact-path-missing");
  } else {
    const candidatePath = path.resolve(sourceRoot, candidateRowsPath);
    if (!isWithin(sourceRoot, candidatePath)) {
      blockingReasons.push("m3plus-runtime-candidate-artifact-outside-root");
    } else {
      try {
        const realRoot = await fs.realpath(path.resolve(sourceRoot));
        const realCandidate = await fs.realpath(candidatePath);
        if (!isWithin(realRoot, realCandidate)) {
          blockingReasons.push("m3plus-runtime-candidate-artifact-realpath-outside-root");
        } else {
          const bytes = await readStableFile(realCandidate);
          const observedSha = sha256(bytes);
          if (!validSha256(recordedCandidateSha) || recordedCandidateSha !== observedSha) {
            blockingReasons.push("m3plus-runtime-candidate-artifact-sha-mismatch");
          }
          artifact = JSON.parse(bytes.toString("utf8"));
          candidateRows = Array.isArray(artifact?.candidateRows) ? artifact.candidateRows : [];
          if (!candidateRows.length) blockingReasons.push("m3plus-runtime-candidate-artifact-rows-empty");
          if (JSON.stringify(artifact?.candidateGate || null) !== JSON.stringify(item?.candidateGate || null)) {
            blockingReasons.push("m3plus-runtime-candidate-artifact-gate-mismatch");
          }
        }
      } catch (error) {
        blockingReasons.push("m3plus-runtime-candidate-artifact-unreadable");
      }
    }
  }

  const runtime = item?.candidateGate?.m3plusPitchSafetyRuntime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    blockingReasons.push("m3plus-runtime-contract-missing");
  } else {
    if (runtime.reviewOnlyRuntimeWired !== true || runtime.contractReady !== true) {
      blockingReasons.push("m3plus-runtime-foundation-not-wired");
    }
    if (runtime.reviewOnly !== true
        || runtime.feedbackAuthorized !== false
        || runtime.studentFacing !== false
        || runtime.runtimeEvidenceReady !== true) {
      blockingReasons.push("m3plus-runtime-review-only-state-invalid");
    }
    if (runtime.evaluationContract !== CONTRACT) {
      blockingReasons.push("m3plus-runtime-evaluation-contract-mismatch");
    }
    if (runtime.runtimeContract !== RUNTIME_CONTRACT) {
      blockingReasons.push("m3plus-runtime-contract-mismatch");
    }
    if (runtime.policyVersion !== RUNTIME_POLICY_VERSION || !validSha256(runtime.policySemanticSha256)) {
      blockingReasons.push("m3plus-runtime-policy-binding-invalid");
    }
    const runtimeReportPath = path.resolve(sourceRoot, safeString(runtime.rescopeReportPath));
    if (!safeString(runtime.rescopeReportPath)
        || !samePath(runtimeReportPath, rescopeGatePath)
        || runtime.rescopeReportSha256 !== rescopeReportSha256) {
      blockingReasons.push("m3plus-runtime-rescope-report-binding-mismatch");
    }
  }

  const foundationBlockingReasons = [...new Set(blockingReasons)];
  const foundationReady = foundationBlockingReasons.length === 0;
  const rowAudit = runtime && candidateRows.length
    ? auditRuntimeRows(candidateRows, runtime)
    : { ready: false, rowCount: candidateRows.length, blockingReasons: [] };
  const allBlockingReasons = [...new Set([...foundationBlockingReasons, ...rowAudit.blockingReasons])];
  return {
    foundationReady,
    runtimeAuditReady: foundationReady && rowAudit.ready,
    blockingReasons: allBlockingReasons,
    batchRunId: safeString(latest.run?.batchRunId),
    ordinaryFeatureItemCount: ordinaryItems.length,
    candidateRowCount: rowAudit.rowCount,
    candidateRowsPath,
    candidateRowsSha256: recordedCandidateSha || null,
    runtime: runtime || null,
    ordinaryFoundationAudit: runAudit,
  };
}

function renderMarkdown(report) {
  const zoneLines = Object.entries(report.zones).flatMap(([name, item]) => [
    `### ${name}`,
    "",
    ...Object.entries(item).map(([key, value]) => `- ${key}: ${value === null ? "n/a" : value}`),
    "",
  ]);
  return [
    "# M3+ Monitored Pilot Audit (hardened physical-evidence contract)",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Decision",
    "",
    `- ok: ${report.ok}`,
    `- offlineEvidenceReady: ${report.offlineEvidenceReady}`,
    `- runtimeFoundationReady: ${report.runtimeFoundationReady}`,
    `- runtimeAuditReady: ${report.runtimeAuditReady}`,
    `- readyForMonitoredPilot: ${report.readyForMonitoredPilot}`,
    `- defaultM3PlusReadyAfter: ${report.defaultM3PlusReadyAfter}`,
    "",
    "## Contract",
    "",
    `- evaluationContract: ${report.contract}`,
    `- runtimeContract: ${report.runtimeContract}`,
    `- runtimePolicyVersion: ${report.runtimePolicyVersion}`,
    `- rescopeReportSha256: ${report.inputs.rescopeReportSha256}`,
    `- physicalLatestBatchRunId: ${report.runtimeEvidence.batchRunId || "n/a"}`,
    `- candidateRowsSha256: ${report.runtimeEvidence.candidateRowsSha256 || "n/a"}`,
    "",
    "## Zones",
    "",
    ...zoneLines,
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "## Safety Notes",
    "",
    "- Offline aggregate evidence alone never makes this audit pilot-ready.",
    "- The audit rehashes every rescope source binding and the physical latest candidate artifact.",
    "- Every runtime row remains review_required and studentFacing=false.",
    "- Score-marked accusations and high-dispersion leaks fail closed.",
    "- This audit never enables the default student runtime.",
    "",
  ].join("\n");
}

export async function runM3PlusMonitoredPilotAudit(args = {}, dependencies = {}) {
  const options = { ...parseArgs([]), ...args };
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const rescopeGatePath = path.resolve(sourceRoot, options.rescopeGate);
  const batchRunsPath = path.resolve(sourceRoot, options.batchRuns);
  const outDir = path.resolve(sourceRoot, options.outDir);
  const gateRead = await readJsonWithBytes(rescopeGatePath);
  const contract = evaluateRescopeContract(gateRead.value, options);
  const sourceAudit = gateRead.exists
    ? await auditSourceBindings(gateRead.value, { sourceRoot })
    : { ready: false, bindings: {}, blockingReasons: ["m3plus-rescope-gate-report-missing"] };
  const runtimeEvidence = await auditRuntimeFoundation({
    sourceRoot,
    batchRunsPath,
    rescopeGatePath,
    rescopeReportSha256: gateRead.sha256,
    dependencies: {
      auditControlledBatchRuns: dependencies.auditControlledBatchRuns || auditControlledBatchRuns,
    },
  });

  const offlineEvidenceReady = Boolean(
    gateRead.exists
    && gateRead.value?.releaseGateReady === true
    && contract.ready
    && sourceAudit.ready,
  );
  const runtimeFoundationReady = runtimeEvidence.foundationReady === true;
  const runtimeAuditReady = runtimeEvidence.runtimeAuditReady === true;
  const blockingReasons = [...new Set([
    ...(!gateRead.exists ? ["m3plus-rescope-gate-report-missing"] : []),
    ...contract.blockingReasons,
    ...sourceAudit.blockingReasons,
    ...runtimeEvidence.blockingReasons,
  ])];
  const readyForMonitoredPilot = Boolean(
    offlineEvidenceReady
    && runtimeFoundationReady
    && runtimeAuditReady
    && gateRead.value?.releaseGateReady === true
    && blockingReasons.length === 0,
  );
  const report = {
    schemaVersion: 2,
    ok: readyForMonitoredPilot,
    generatedAt: new Date().toISOString(),
    offlineEvidenceReady,
    runtimeFoundationReady,
    runtimeAuditReady,
    readyForMonitoredPilot,
    teacherReviewNeeded: false,
    defaultM3PlusReadyAfter: false,
    contract: CONTRACT,
    runtimeContract: RUNTIME_CONTRACT,
    runtimePolicyVersion: RUNTIME_POLICY_VERSION,
    scope: {
      releaseZones: RELEASE_ZONES,
      inheritedZones: INHERITED_ZONES,
      minPrecision: options.minPrecision,
      maxPitchToleranceCents: options.maxPitchToleranceCents,
      evaluationSplit: "holdout-only",
    },
    inputs: {
      rescopeGate: rel(rescopeGatePath, sourceRoot),
      rescopeGateExists: gateRead.exists,
      rescopeReportSha256: gateRead.sha256,
      batchRuns: rel(batchRunsPath, sourceRoot),
    },
    sourceBindings: sourceAudit,
    runtimeEvidence,
    zones: contract.zones,
    releaseModes: {},
    blockedModes: [],
    blockingReasons,
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "m3plus-monitored-pilot-audit.json");
  const mdPath = path.join(outDir, "m3plus-monitored-pilot-audit.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  return { report, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { report, jsonPath, mdPath } = await runM3PlusMonitoredPilotAudit(args);
  console.log(JSON.stringify({
    ok: report.ok,
    offlineEvidenceReady: report.offlineEvidenceReady,
    runtimeFoundationReady: report.runtimeFoundationReady,
    runtimeAuditReady: report.runtimeAuditReady,
    readyForMonitoredPilot: report.readyForMonitoredPilot,
    defaultM3PlusReadyAfter: report.defaultM3PlusReadyAfter,
    contract: report.contract,
    blockingReasons: report.blockingReasons,
    out: {
      json: rel(jsonPath),
      md: rel(mdPath),
    },
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
