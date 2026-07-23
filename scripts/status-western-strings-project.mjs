import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateControlledCandidateGate } from "./eval-western-controlled-candidate-gate.mjs";
import { auditControlledBatchRuns } from "./audit-western-controlled-batch-candidates.mjs";
import { auditSourceBindings } from "./run-western-m3plus-monitored-pilot-audit.mjs";
import {
  attachConfidencePilotStatus,
  buildControlledCandidateReviewStatus,
  summarizeControlledCandidateConfidencePilot,
} from "./status-western-controlled-candidate-review.mjs";
import { evaluateOrdinaryAudioRuntime } from "./run-western-ordinary-audio-python.mjs";
import { auditOrdinaryDynamicShadowAcceptanceLiveArtifacts } from "./audit-western-ordinary-dynamic-shadow-acceptance.mjs";
import {
  FRESH_BLIND_CONTRACT,
  FRESH_BLIND_REPORT_RELATIVE_PATH,
  POLICY_C_CONTRACT,
  RHYTHM_CHANNEL_DIAGNOSTIC_CONTRACT,
  auditFreshBlindEvidence,
  auditFreshBlindEvidenceLiveArtifacts,
} from "./eval-western-ordinary-fresh-blind.mjs";
import { loadM4aGateSplitDecision } from "./m4a-supported-edition-governance.mjs";
import { loadM4bPocPromotionDecision } from "./m4b-poc-promotion-governance.mjs";
import { auditM4aSupportedEditionRegistry } from "./audit-western-m4a-supported-edition-registry.mjs";
import { auditM4aEngineeringAcceptance } from "./audit-western-m4a-engineering-acceptance.mjs";
import { auditM4aRealPhotoAcceptance } from "./audit-western-m4a-real-photo-acceptance.mjs";
import { auditM4bDataset } from "./audit-western-m4b-dataset.mjs";
import { auditM4bFreshBlindIntake } from "./audit-western-m4b-fresh-blind-intake.mjs";
import { auditM4bStructurePoc } from "./audit-western-m4b-structure-poc.mjs";
import { runM4aRegistrationPreflight } from "./preflight-western-m4a-registration.mjs";

const DEFAULT_OUT = path.join("data", "experiments", "western-strings-project-status.json");
const REVIEW_POLICY_DOC = path.join("docs", "western-strings-review-policy.md");
const PUBLIC_BACH_V2_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-bach-violin-v2-audit.json",
);
const PHENICX_ALIGNMENT_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-phenicx-alignment",
  "report.json",
);
const MUSC_CALIBRATION_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-bach-violin-musc-calibration",
  "report.json",
);
const MUSC_FRESH_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-bach-violin-musc-fresh-confirmation",
  "report.json",
);
const VIOLIN_MIDI_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-violin-midi-dataset-audit.json",
);
const MUSICNET_ACCOMPANIED_VIOLIN_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-musicnet-accompanied-violin",
  "report.json",
);
const MUSICNET_YOURMT3_CHALLENGER = path.join(
  "docs",
  "evidence",
  "western-strings-musicnet-yourmt3-20260720.json",
);
const V2_ALPHA_MIN_PRECISION = 0.9;
const V2_ALPHA_MIN_COVERAGE = 0.2;
const ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "ordinary-dynamic-shadow-r3-acceptance",
  "report.json",
);
const ROUND4_POLICY_C_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-round4",
  "ordinary-fresh-blind",
  "report.json",
);
const ROUND5_TARGETED_CONTRACT = path.join(
  "config",
  "western-strings-round5-targeted-contract.json",
);
const ROUND5_TARGETED_MANIFEST = path.join(
  "data",
  "private",
  "western-strings-round5",
  "manifest.csv",
);
const ROUND5_TARGETED_TRUTH = path.join(
  "data",
  "private",
  "western-strings-round5",
  "position-truth.json",
);
const ROUND5_TARGETED_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-round5-targeted-intake.json",
);
const ROUND5_POLICY_C_WAVEFORM_ROBUSTNESS = path.join(
  "docs",
  "evidence",
  "western-strings-round5-policy-c-waveform-robustness-20260724.json",
);
const ROUND5_SEGMENT_EDIT_PATH_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-round5-segment-edit-path",
  "report.json",
);
const ROUND5_CALIBRATION_FAILURE_AUDIT_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-round5-calibration-failure-audit",
  "report.json",
);
const ROUND5_POSITION_BALANCE_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-round5-position-balance",
  "report.json",
);
const ROUND5_REVIEW_ASSIST_CALIBRATION_PACK = path.join(
  "data",
  "experiments",
  "western-strings-round5-review-assist-calibration-pack",
);
const ROUND5_REVIEW_ASSIST_CALIBRATION_LEDGER = path.join(
  ROUND5_REVIEW_ASSIST_CALIBRATION_PACK,
  "ledger.json",
);
const ROUND5_REVIEW_ASSIST_CALIBRATION_PAGE = path.join(
  ROUND5_REVIEW_ASSIST_CALIBRATION_PACK,
  "index.html",
);
const ROUND5_REVIEW_ASSIST_CALIBRATION_COMPLETED = path.join(
  ROUND5_REVIEW_ASSIST_CALIBRATION_PACK,
  "round5-review-assist-calibration.completed.json",
);
const ROUND6_COUNTERBALANCED_CONTRACT = path.join(
  "config",
  "western-strings-round6-counterbalanced-contract.json",
);
const ROUND6_COUNTERBALANCED_MANIFEST = path.join(
  "data",
  "private",
  "western-strings-round6-counterbalanced",
  "manifest.csv",
);
const ROUND6_COUNTERBALANCED_TRUTH = path.join(
  "data",
  "private",
  "western-strings-round6-counterbalanced",
  "position-truth.json",
);
const ROUND6_COUNTERBALANCED_POSITION_BALANCE = path.join(
  "data",
  "experiments",
  "western-strings-round6-counterbalanced-position-balance",
  "report.json",
);
const ROUND6_COUNTERBALANCED_INTAKE = path.join(
  "data",
  "experiments",
  "western-strings-round6-counterbalanced-intake.json",
);
const ROUND6_EVALUATION_PROTOCOL = path.join(
  "config",
  "western-strings-round6-evaluation-protocol.json",
);
const ROUND6_EVALUATION_REPORT = path.join(
  "data",
  "experiments",
  "western-strings-round6-frozen-evaluation",
  "report.json",
);
const P3_MINIMAL_RECORDING_PROTOCOL = path.join(
  "docs",
  "evidence",
  "western-strings-p3-minimal-recording-preregistration-20260724.json",
);
const ROUND6_STAGE_A_SIGNOFF_LINEAGE = path.join(
  "data",
  "experiments",
  "western-strings-round6-stage-a-signoff",
  "ledger.json",
);
const ROUND6_STAGE_A_SAFETY_ROOT = path.join(
  "data",
  "experiments",
  "western-strings-round6-stage-a-safety",
);
const ROUND6_STAGE_A_SAFETY_REPORT = path.join(
  ROUND6_STAGE_A_SAFETY_ROOT,
  "report.json",
);
const ROUND6_STAGE_A_SAFETY_MODEL = path.join(
  ROUND6_STAGE_A_SAFETY_ROOT,
  "model.joblib",
);
const ROUND6_STAGE_A_SAFETY_CONSUMED = path.join(
  ROUND6_STAGE_A_SAFETY_ROOT,
  "consumed-ledger.json",
);
const ROUND5_SEGMENT_EDIT_PATH_SMOKE = path.join(
  "docs",
  "evidence",
  "western-strings-round5-segment-edit-path-smoke-20260722.json",
);
const ROUND5_TEMPORAL_OPERATION_PATH = path.join(
  "docs",
  "evidence",
  "western-strings-round5-temporal-operation-path-20260722.json",
);
const ROUND5_TARGETED_CONTRACT_VERSION = "western-round5-targeted-diagnosis-intake-v1";
const ROUND5_REVIEW_ASSIST_CALIBRATION_CONTRACT =
  "western-round5-review-assist-calibration-pack-v1";
const ROUND6_COUNTERBALANCED_CONTRACT_VERSION = "western-round6-counterbalanced-diagnosis-v1";
const ROUND6_EVALUATION_PROTOCOL_VERSION = "western-round6-frozen-evaluation-protocol-v1";
const P3_MINIMAL_RECORDING_PROTOCOL_VERSION =
  "western-p3-staged-minimal-recording-protocol-v1";
const ROUND6_STAGE_A_SIGNOFF_LINEAGE_VERSION =
  "western-round6-stage-a-signoff-lineage-v1";
const ROUND6_STAGE_A_SAFETY_VERSION =
  "western-round6-stage-a-clean-safety-v1";
const ROUND6_STAGE_A_SAFETY_CONSUMED_VERSION =
  "western-round6-stage-a-clean-safety-consumed-v1";
const P3_MINIMAL_RECORDING_REQUIRED_SOURCE_PATHS = Object.freeze([
  "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json",
  "docs/evidence/western-strings-p1-clean-domain-safety-20260724.json",
  "docs/evidence/western-strings-p2-public-error-recall-audit-20260724.json",
  "config/western-strings-round6-evaluation-protocol.json",
  "config/western-strings-round6-counterbalanced-contract.json",
  "data/private/western-strings-round6-counterbalanced/manifest.csv",
  "data/private/western-strings-round6-counterbalanced/position-truth.json",
  "scripts/generate-western-round5-truth-signoff-pack.mjs",
  "scripts/apply-western-truth-signoff.mjs",
  "scripts/run_western_round6_stage_a_safety.py",
  "scripts/western-round6-staged-signoff-support.mjs",
  "scripts/experiments/train_western_round6_full_score_candidate.py",
  "package.json",
]);
const ROUND5_SEGMENT_GATES = Object.freeze([
  "merged_substitution",
  "missing",
  "extra",
  "drag",
]);
const ORDINARY_DYNAMIC_CONTRACT_VERSION = "western-ordinary-dynamic-shadow-candidate-v1";
const ORDINARY_DYNAMIC_POLICY_VERSION = "western-ordinary-dynamic-shadow-policy-v1";
const ORDINARY_DYNAMIC_GATE_VERSION = "western-ordinary-dynamic-shadow-gate-v1-review-only";
const ORDINARY_DYNAMIC_ACCEPTANCE_VERSION = "western-ordinary-dynamic-shadow-r3-acceptance-v1";
const ORDINARY_DYNAMIC_TIMING_MODE = "basic-pitch-dtw";
const ORDINARY_DYNAMIC_RUNTIME_ID = "western-ordinary-dynamic-shadow-audio-py311";
const ORDINARY_DYNAMIC_MODEL_SHA256 = "c6595f299ff83c52e89555789f7e3e829a6a0f25b6a88f7e99073af5a2470dc4";
const ORDINARY_DYNAMIC_ACCEPTANCE_RECORDINGS = ["r3-02", "r3-03"];
const ORDINARY_DYNAMIC_ACCEPTANCE_LIVE_VERIFIER_IMPLEMENTED = true;
const ORDINARY_REVIEW_ASSIST_CONTRACT = "western-round4-policy-c-review-assist-v1";
const M3PLUS_RESCOPE_SCHEMA_VERSION = 2;
const M3PLUS_RESCOPE_CONTRACT = "m3plus-rescope-four-zone-v2";
const M3PLUS_RUNTIME_CONTRACT = "m3plus-gold-free-runtime-v1";
export const CONTROLLED_PILOT_LIVE_EVIDENCE_CONTRACT = "western-controlled-pilot-live-evidence-v1";
const CONTROLLED_PILOT_ORDINARY_AUTHORIZATION_CONTRACT = "western-ordinary-dynamic-shadow-release-v1";
const CONTROLLED_PILOT_SCOPE_CONTRACT = "western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v2";
const CONTROLLED_PILOT_REQUIRED_TRACKS = Object.freeze(["m3plus", "ordinary"]);
const CONTROLLED_PILOT_APPROVAL = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-approval.json",
);

// authorizationReady represents the owner's standing consent to release this
// track's review-only mechanism for a monitored pilot. It is intentionally
// coarse-grained (bound to the scope-contract version, not to any specific
// evidence digest): evidence freshness is independently enforced by the
// track's own *Ready flags (r3AcceptanceReady, freshBlindEvidence.ready,
// pitchSafetyReady, ...), so this only has to answer "did the owner say yes
// to this contract version, for this track". A stale scope-contract version
// or a track missing from approvedTracks fails closed.
export function evaluateTrackAuthorizationFromApproval(approval, track) {
  const blockingReasons = [];
  if (!approval) {
    blockingReasons.push("authorization-approval-missing");
    return { ready: false, blockingReasons };
  }
  if (approval.pilotApproved !== true) blockingReasons.push("authorization-approval-not-granted");
  if (approval.scopeContract !== CONTROLLED_PILOT_SCOPE_CONTRACT) {
    blockingReasons.push("authorization-approval-scope-contract-stale");
  }
  const approvedTracks = Array.isArray(approval.approvedTracks) ? approval.approvedTracks : [];
  if (!approvedTracks.includes(track)) blockingReasons.push(`authorization-approval-track-missing:${track}`);
  if (approval.confirmSeparateMonitoredPilot !== true) {
    blockingReasons.push("authorization-approval-confirmation-missing:confirmSeparateMonitoredPilot");
  }
  if (approval.confirmDefaultRuntimeFailClosed !== true) {
    blockingReasons.push("authorization-approval-confirmation-missing:confirmDefaultRuntimeFailClosed");
  }
  if (String(approval.approvedBy || "").trim() === "" || String(approval.approvedAt || "").trim() === "") {
    blockingReasons.push("authorization-approval-identity-missing");
  }
  return { ready: blockingReasons.length === 0, blockingReasons };
}

async function evaluateTrackAuthorization(track) {
  const approval = await readJson(CONTROLLED_PILOT_APPROVAL);
  return evaluateTrackAuthorizationFromApproval(approval, track);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalizedReasonList(reasons) {
  return [...new Set((Array.isArray(reasons) ? reasons : [])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean))].sort();
}

// This projection is deliberately small, deterministic, and limited to the
// live evidence that can authorize the combined ordinary + M3+ monitored
// pilot. Release review and the start decision hash the same projection so a
// stale or hand-written green report cannot override current fail-closed state.
export function buildControlledPilotLiveEvidenceProjection(status = {}) {
  const ordinary = status?.tracks?.controlledCandidate?.ordinaryDynamicShadow || {};
  const ordinaryRuntime = ordinary.runtime || {};
  const ordinaryAcceptance = ordinary.acceptanceEvidence || {};
  const m3plus = status?.tracks?.m3plusPitchModes || {};
  const audit = m3plus.monitoredPilotAudit || {};
  const runtimeEvidence = audit.runtimeEvidence || {};
  const runtime = runtimeEvidence.runtime || {};
  return {
    contract: CONTROLLED_PILOT_LIVE_EVIDENCE_CONTRACT,
    runtimeFailClosed: status?.runtimeStudentGate?.policy === "fail-closed"
      && status?.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === false
      && status?.runtimeStudentGate?.m3plusAutoFeedbackReady === false
      && status?.runtimeStudentGate?.m4OmrAutoScoreReady === false,
    ordinary: {
      contractVersion: ordinary.contractVersion || null,
      policyVersion: ordinary.policyVersion || null,
      gateVersion: ordinary.gateVersion || null,
      timingMode: ordinary.timingMode || null,
      foundationReady: ordinary.foundationReady === true,
      liveArtifactVerifierReady: ordinary.liveArtifactVerifierReady === true,
      r3AcceptanceReady: ordinary.r3AcceptanceReady === true,
      freshBlindEvidenceReady: ordinary.freshBlindEvidence?.ready === true,
      authorizationReady: ordinary.authorizationReady === true,
      energyVetoIncluded: ordinary.energyVetoIncluded === true,
      causalEnergyStatus: ordinary.causalEnergyStatus || null,
      blockingReasons: normalizedReasonList(ordinary.blockingReasons),
      runtimeIdentity: {
        runtimeId: ordinaryRuntime.runtimeId || null,
        configSha256: ordinaryRuntime.configSha256 || null,
        configSemanticSha256: ordinaryRuntime.configSemanticSha256 || null,
        requirementsLockSha256: ordinaryRuntime.requirementsLockSha256 || null,
        modelTreeSha256: ordinaryRuntime.modelTreeSha256 || null,
      },
      acceptanceIdentity: {
        artifactSha256: ordinaryAcceptance.artifactSha256 || null,
        evidenceDigestSha256: ordinaryAcceptance.evidenceDigestSha256 || null,
      },
    },
    m3plus: {
      offlineEvidenceReady: m3plus.offlineEvidenceReady === true,
      reviewOnlyRuntimeWired: m3plus.reviewOnlyRuntimeWired === true,
      runtimeFoundationReady: m3plus.runtimeFoundationReady === true,
      runtimeAuditReady: m3plus.runtimeAuditReady === true,
      authorizationReady: m3plus.authorizationReady === true,
      pitchSafetyReady: m3plus.m3plusPitchSafetyReady === true,
      studentGateReady: m3plus.studentGateReady === true,
      auditSchemaVersion: audit.schemaVersion ?? null,
      evaluationContract: audit.contract || null,
      runtimeContract: audit.runtimeContract || null,
      runtimePolicyVersion: audit.runtimePolicyVersion || null,
      physicalEvidenceCurrent: audit.physicalEvidenceCurrent === true,
      readyForMonitoredPilot: audit.readyForMonitoredPilot === true,
      teacherReviewNeeded: audit.teacherReviewNeeded === true,
      defaultM3PlusReadyAfter: audit.defaultM3PlusReadyAfter === true,
      blockingReasons: normalizedReasonList(audit.blockingReasons),
      physicalEvidence: {
        batchRunId: runtimeEvidence.batchRunId || null,
        candidateRowsPath: runtimeEvidence.candidateRowsPath || null,
        candidateRowsSha256: runtimeEvidence.candidateRowsSha256 || null,
        candidateRowCount: Number.isInteger(runtimeEvidence.candidateRowCount)
          ? runtimeEvidence.candidateRowCount
          : null,
        policySemanticSha256: runtime.policySemanticSha256 || null,
        policyArtifactSha256: runtime.policyArtifactSha256 || null,
        analyzerArtifactSha256: runtime.analyzerArtifactSha256 || null,
        analyzerArtifactSemanticSha256: runtime.analyzerArtifactSemanticSha256 || null,
        rescopeReportSha256: runtime.rescopeReportSha256 || null,
        scoreSafetyIdentitySha256: runtime.scoreSafetyIdentitySha256 || null,
      },
    },
  };
}

export function buildControlledPilotLiveEvidenceBinding(status = {}) {
  const evidence = buildControlledPilotLiveEvidenceProjection(status);
  return {
    contract: CONTROLLED_PILOT_LIVE_EVIDENCE_CONTRACT,
    sha256: sha256Canonical(evidence),
    evidence,
  };
}

export function controlledPilotLiveEvidenceReady(liveEvidenceBinding = {}) {
  const live = liveEvidenceBinding?.evidence || liveEvidenceBinding || {};
  const ordinary = live.ordinary || {};
  const ordinaryRuntime = ordinary.runtimeIdentity || {};
  const ordinaryAcceptance = ordinary.acceptanceIdentity || {};
  const m3plus = live.m3plus || {};
  const physical = m3plus.physicalEvidence || {};
  return live.runtimeFailClosed === true
    && ordinary.foundationReady === true
    && ordinary.liveArtifactVerifierReady === true
    && ordinary.r3AcceptanceReady === true
    && ordinary.freshBlindEvidenceReady === true
    && ordinary.authorizationReady === true
    && ordinary.causalEnergyStatus === "excluded-review-only"
    && (ordinary.blockingReasons || []).length === 0
    && ordinaryRuntime.runtimeId === ORDINARY_DYNAMIC_RUNTIME_ID
    && isSha256(ordinaryRuntime.configSha256)
    && isSha256(ordinaryRuntime.configSemanticSha256)
    && isSha256(ordinaryRuntime.requirementsLockSha256)
    && isSha256(ordinaryRuntime.modelTreeSha256)
    && isSha256(ordinaryAcceptance.artifactSha256)
    && isSha256(ordinaryAcceptance.evidenceDigestSha256)
    && m3plus.offlineEvidenceReady === true
    && m3plus.reviewOnlyRuntimeWired === true
    && m3plus.runtimeFoundationReady === true
    && m3plus.runtimeAuditReady === true
    && m3plus.physicalEvidenceCurrent === true
    && m3plus.authorizationReady === true
    && m3plus.pitchSafetyReady === true
    && m3plus.studentGateReady === false
    && m3plus.auditSchemaVersion === M3PLUS_RESCOPE_SCHEMA_VERSION
    && m3plus.evaluationContract === M3PLUS_RESCOPE_CONTRACT
    && m3plus.runtimeContract === M3PLUS_RUNTIME_CONTRACT
    && m3plus.readyForMonitoredPilot === true
    && m3plus.teacherReviewNeeded === false
    && m3plus.defaultM3PlusReadyAfter === false
    && (m3plus.blockingReasons || []).length === 0
    && String(physical.batchRunId || "").trim() !== ""
    && String(physical.candidateRowsPath || "").trim() !== ""
    && Number.isInteger(physical.candidateRowCount)
    && physical.candidateRowCount > 0
    && isSha256(physical.candidateRowsSha256)
    && isSha256(physical.policySemanticSha256)
    && isSha256(physical.policyArtifactSha256)
    && isSha256(physical.analyzerArtifactSha256)
    && isSha256(physical.analyzerArtifactSemanticSha256)
    && isSha256(physical.rescopeReportSha256)
    && isSha256(physical.scoreSafetyIdentitySha256);
}

function exactControlledPilotTracks(value) {
  if (!Array.isArray(value)) return false;
  const tracks = [...new Set(value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))].sort();
  return tracks.join(",") === CONTROLLED_PILOT_REQUIRED_TRACKS.join(",");
}

function controlledPilotApprovalIsCurrent(approval) {
  return approval?.pilotApproved === true
    && String(approval?.approvedBy || "").trim() !== ""
    && String(approval?.approvedAt || "").trim() !== ""
    && approval?.scopeContract === CONTROLLED_PILOT_SCOPE_CONTRACT
    && exactControlledPilotTracks(approval?.approvedTracks)
    && approval?.confirmSeparateMonitoredPilot === true
    && approval?.confirmDefaultRuntimeFailClosed === true;
}

function controlledPilotApprovalIsExplicitNoGo(approval) {
  return approval?.pilotApproved === false
    && String(approval?.approvedBy || "").trim() !== ""
    && String(approval?.approvedAt || "").trim() !== "";
}

export function summarizeCurrentControlledPilotAuthority({
  releaseReview = null,
  controlledPilotDecision = null,
  currentLiveEvidenceBinding = {},
  currentLiveEvidenceReady = false,
} = {}) {
  const releaseBindingCurrent = releaseReview?.liveEvidenceBinding?.contract
      === CONTROLLED_PILOT_LIVE_EVIDENCE_CONTRACT
    && releaseReview?.liveEvidenceBinding?.sha256 === currentLiveEvidenceBinding.sha256;
  const releaseContractCurrent = releaseReview?.schemaVersion === 2
    && releaseReview?.ordinaryAuthorizationContract
      === CONTROLLED_PILOT_ORDINARY_AUTHORIZATION_CONTRACT;
  const currentOrdinary = currentLiveEvidenceBinding?.evidence?.ordinary || {};
  const currentM3Plus = currentLiveEvidenceBinding?.evidence?.m3plus || {};
  const releaseTracksMatchCurrentLiveEvidence = releaseReview?.tracks?.ordinary?.foundationReady
      === currentOrdinary.foundationReady
    && releaseReview?.tracks?.ordinary?.liveArtifactVerifierReady
      === currentOrdinary.liveArtifactVerifierReady
    && releaseReview?.tracks?.ordinary?.r3AcceptanceReady === currentOrdinary.r3AcceptanceReady
    && releaseReview?.tracks?.ordinary?.freshBlindEvidenceReady === currentOrdinary.freshBlindEvidenceReady
    && releaseReview?.tracks?.ordinary?.authorizationReady === currentOrdinary.authorizationReady
    && releaseReview?.tracks?.ordinary?.energyVetoIncluded === currentOrdinary.energyVetoIncluded
    && releaseReview?.tracks?.ordinary?.causalEnergyStatus === currentOrdinary.causalEnergyStatus
    && releaseReview?.tracks?.m3plus?.offlineEvidenceReady === currentM3Plus.offlineEvidenceReady
    && releaseReview?.tracks?.m3plus?.reviewOnlyRuntimeWired === currentM3Plus.reviewOnlyRuntimeWired
    && releaseReview?.tracks?.m3plus?.runtimeFoundationReady === currentM3Plus.runtimeFoundationReady
    && releaseReview?.tracks?.m3plus?.runtimeAuditReady === currentM3Plus.runtimeAuditReady
    && releaseReview?.tracks?.m3plus?.physicalEvidenceCurrent === currentM3Plus.physicalEvidenceCurrent
    && releaseReview?.tracks?.m3plus?.authorizationReady === currentM3Plus.authorizationReady
    && releaseReview?.tracks?.m3plus?.pitchSafetyReady === currentM3Plus.pitchSafetyReady
    && releaseReview?.tracks?.m3plus?.contract === currentM3Plus.evaluationContract
    && releaseReview?.tracks?.m3plus?.runtimeContract === currentM3Plus.runtimeContract;
  const releaseReady = releaseContractCurrent
    && releaseBindingCurrent
    && releaseTracksMatchCurrentLiveEvidence
    && currentLiveEvidenceReady === true
    && releaseReview?.ok === true
    && releaseReview?.commandChecksPassed === true
    && releaseReview?.requiredEvidenceComplete === true
    && releaseReview?.machineChecksComplete === true
    && releaseReview?.readyForControlledPilot === true
    && releaseReview?.teacherReviewNeeded === false
    && releaseReview?.runtimeFailClosed === true
    && releaseReview?.tracks?.ordinary?.readyForControlledPilot === true
    && releaseReview?.tracks?.m3plus?.readyForControlledPilot === true;
  const releaseBlockingReasons = normalizedReasonList([
    ...(!releaseReview ? ["release-review-missing"] : []),
    ...(releaseReview && !releaseContractCurrent ? ["release-review-contract-superseded"] : []),
    ...(releaseReview && !releaseBindingCurrent ? ["release-review-live-evidence-binding-stale"] : []),
    ...(releaseReview && !releaseTracksMatchCurrentLiveEvidence
      ? ["release-review-track-evidence-does-not-match-current-live-binding"] : []),
    ...(!currentLiveEvidenceReady ? ["live-controlled-pilot-evidence-incomplete"] : []),
    ...(releaseReview?.ok !== true ? ["release-review-not-ok"] : []),
    ...(releaseReview?.commandChecksPassed !== true ? ["release-review-command-checks-not-passed"] : []),
    ...(releaseReview?.requiredEvidenceComplete !== true ? ["release-review-required-evidence-incomplete"] : []),
    ...(releaseReview?.machineChecksComplete !== true ? ["release-review-machine-checks-incomplete"] : []),
    ...(releaseReview?.readyForControlledPilot !== true ? ["release-review-not-ready-for-controlled-pilot"] : []),
    ...(releaseReview?.teacherReviewNeeded !== false ? ["release-review-teacher-review-status-not-explicitly-clear"] : []),
    ...(releaseReview?.runtimeFailClosed !== true ? ["release-review-runtime-not-fail-closed"] : []),
    ...(releaseReview?.tracks?.ordinary?.readyForControlledPilot !== true
      ? ["release-review-ordinary-track-not-ready"] : []),
    ...(releaseReview?.tracks?.m3plus?.readyForControlledPilot !== true
      ? ["release-review-m3plus-track-not-ready"] : []),
  ]);

  const decisionBindingCurrent = controlledPilotDecision?.liveEvidenceBinding?.contract
      === CONTROLLED_PILOT_LIVE_EVIDENCE_CONTRACT
    && controlledPilotDecision?.liveEvidenceBinding?.sha256 === currentLiveEvidenceBinding.sha256;
  const decisionContractCurrent = controlledPilotDecision?.schemaVersion === 2
    && controlledPilotDecision?.ordinaryAuthorizationContract
      === CONTROLLED_PILOT_ORDINARY_AUTHORIZATION_CONTRACT
    && controlledPilotDecision?.scopeContract === CONTROLLED_PILOT_SCOPE_CONTRACT;
  const decisionRuntimeFailClosed = controlledPilotDecision?.runtimeFailClosed === true
    && currentLiveEvidenceBinding?.evidence?.runtimeFailClosed === true;
  const approvalPresent = controlledPilotApprovalIsCurrent(controlledPilotDecision?.approval)
    && controlledPilotDecision?.approvalPresent === true
    && exactControlledPilotTracks(controlledPilotDecision?.approvedTracks);
  const approvalDeferred = controlledPilotApprovalIsExplicitNoGo(controlledPilotDecision?.approval)
    && controlledPilotDecision?.approvalDeferred === true;
  const rawDecisionBlockingReasons = Array.isArray(controlledPilotDecision?.blockingReasons)
    ? controlledPilotDecision.blockingReasons
    : [];
  const decisionPacketReady = decisionContractCurrent
    && decisionBindingCurrent
    && currentLiveEvidenceReady === true
    && releaseReady
    && controlledPilotDecision?.ok === true
    && controlledPilotDecision?.readyForControlledPilotDecision === true
    && controlledPilotDecision?.approvalRequired === true
    && decisionRuntimeFailClosed;
  const readyToStartControlledPilot = decisionPacketReady
    && approvalPresent
    && controlledPilotDecision?.approvalDeferred === false
    && controlledPilotDecision?.readyToStartControlledPilot === true
    && Array.isArray(controlledPilotDecision?.blockingReasons)
    && rawDecisionBlockingReasons.length === 0;
  const decisionBlockingReasons = normalizedReasonList([
    ...rawDecisionBlockingReasons,
    ...(!controlledPilotDecision ? ["controlled-pilot-decision-missing"] : []),
    ...(controlledPilotDecision && !decisionContractCurrent
      ? ["controlled-pilot-decision-authorization-superseded"] : []),
    ...(controlledPilotDecision && !decisionBindingCurrent
      ? ["controlled-pilot-decision-live-evidence-binding-stale"] : []),
    ...(!releaseReady ? ["current-release-review-not-ready"] : []),
    ...(!currentLiveEvidenceReady ? ["live-controlled-pilot-evidence-incomplete"] : []),
    ...(controlledPilotDecision?.ok !== true ? ["controlled-pilot-decision-not-ok"] : []),
    ...(controlledPilotDecision?.readyForControlledPilotDecision !== true
      ? ["controlled-pilot-decision-machine-readiness-not-green"] : []),
    ...(controlledPilotDecision?.approvalRequired !== true
      ? ["controlled-pilot-decision-approval-contract-invalid"] : []),
    ...(!decisionRuntimeFailClosed ? ["controlled-pilot-decision-runtime-not-fail-closed"] : []),
    ...(!Array.isArray(controlledPilotDecision?.blockingReasons)
      ? ["controlled-pilot-decision-blocking-reasons-invalid"] : []),
    ...(controlledPilotDecision?.readyToStartControlledPilot === true && !approvalPresent
      ? ["controlled-pilot-decision-approval-invalid"] : []),
  ]);

  return {
    releaseReview: releaseReview
      ? {
          source: RELEASE_REVIEW.replace(/\\/g, "/"),
          summary: RELEASE_REVIEW_MD.replace(/\\/g, "/"),
          historicalReadyForControlledPilot: releaseReview.readyForControlledPilot === true,
          readyForControlledPilot: releaseReady,
          readyForDefaultStudentRelease: releaseReady
            && releaseReview.readyForDefaultStudentRelease === true,
          superseded: !releaseContractCurrent || !releaseBindingCurrent,
          liveEvidenceBindingCurrent: releaseBindingCurrent,
          liveEvidenceReady: currentLiveEvidenceReady === true,
          teacherReviewNeeded: releaseReview.teacherReviewNeeded !== false,
          runtimeFailClosed: releaseReview.runtimeFailClosed === true
            && currentLiveEvidenceBinding?.evidence?.runtimeFailClosed === true,
          blockingReasons: releaseBlockingReasons,
        }
      : {
          source: RELEASE_REVIEW.replace(/\\/g, "/"),
          summary: RELEASE_REVIEW_MD.replace(/\\/g, "/"),
          missing: true,
          readyForControlledPilot: false,
          readyForDefaultStudentRelease: false,
          liveEvidenceBindingCurrent: false,
          liveEvidenceReady: currentLiveEvidenceReady === true,
          teacherReviewNeeded: true,
          runtimeFailClosed: currentLiveEvidenceBinding?.evidence?.runtimeFailClosed === true,
          blockingReasons: releaseBlockingReasons,
        },
    controlledPilotDecision: controlledPilotDecision
      ? {
          source: CONTROLLED_PILOT_DECISION.replace(/\\/g, "/"),
          summary: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          historicalReadyForControlledPilotDecision:
            controlledPilotDecision.readyForControlledPilotDecision === true,
          readyForControlledPilotDecision: decisionPacketReady,
          readyToStartControlledPilot,
          authorizationSuperseded: !decisionContractCurrent || !decisionBindingCurrent,
          liveEvidenceBindingCurrent: decisionBindingCurrent,
          liveEvidenceReady: currentLiveEvidenceReady === true,
          approvalRequired: controlledPilotDecision.approvalRequired === true,
          historicalApprovalPresent: controlledPilotDecision.approvalPresent === true,
          approvalPresent,
          approvalDeferred,
          approvedTracks: approvalPresent ? [...CONTROLLED_PILOT_REQUIRED_TRACKS] : [],
          runtimeFailClosed: decisionRuntimeFailClosed,
          blockingReasons: decisionBlockingReasons,
        }
      : {
          source: CONTROLLED_PILOT_DECISION.replace(/\\/g, "/"),
          summary: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          missing: true,
          readyForControlledPilotDecision: false,
          readyToStartControlledPilot: false,
          liveEvidenceBindingCurrent: false,
          liveEvidenceReady: currentLiveEvidenceReady === true,
          approvalRequired: true,
          approvalPresent: false,
          approvalDeferred: false,
          runtimeFailClosed: currentLiveEvidenceBinding?.evidence?.runtimeFailClosed === true,
          blockingReasons: decisionBlockingReasons,
        },
  };
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || "").trim().toLowerCase());
}

export function validateOrdinaryDynamicShadowAcceptance(acceptance) {
  const blockingReasons = [];
  const fail = (reason) => blockingReasons.push(reason);
  if (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)) {
    return { ready: false, blockingReasons: ["ordinary-dynamic-shadow-r3-acceptance-missing"] };
  }
  if (acceptance.schemaVersion !== 1) fail("ordinary-dynamic-shadow-r3-acceptance-schema-invalid");
  if (acceptance.contractVersion !== ORDINARY_DYNAMIC_ACCEPTANCE_VERSION) fail("ordinary-dynamic-shadow-r3-acceptance-contract-invalid");
  if (acceptance.candidateContractVersion !== ORDINARY_DYNAMIC_CONTRACT_VERSION) fail("ordinary-dynamic-shadow-r3-candidate-contract-invalid");
  if (acceptance.policyVersion !== ORDINARY_DYNAMIC_POLICY_VERSION) fail("ordinary-dynamic-shadow-r3-policy-invalid");
  if (acceptance.gateVersion !== ORDINARY_DYNAMIC_GATE_VERSION) fail("ordinary-dynamic-shadow-r3-gate-invalid");
  if (acceptance.timingMode !== ORDINARY_DYNAMIC_TIMING_MODE) fail("ordinary-dynamic-shadow-r3-timing-mode-invalid");
  if (acceptance.acceptanceReady !== true) fail("ordinary-dynamic-shadow-r3-acceptance-not-ready");
  if (acceptance.studentFacing !== false
      || acceptance.automaticAdoptionAuthorized !== false
      || acceptance.authorizationReady !== false) {
    fail("ordinary-dynamic-shadow-r3-fail-closed-policy-invalid");
  }
  if (acceptance.energyVetoIncluded !== false
      || acceptance.causalEnergyStatus !== "excluded-review-only") {
    fail("ordinary-dynamic-shadow-r3-energy-state-invalid");
  }
  if (!Array.isArray(acceptance.blockingReasons) || acceptance.blockingReasons.length !== 0) {
    fail("ordinary-dynamic-shadow-r3-blocking-reasons-not-empty");
  }
  const digestPayload = structuredClone(acceptance);
  delete digestPayload.evidenceDigestSha256;
  delete digestPayload.generatedAt;
  if (!isSha256(acceptance.evidenceDigestSha256)
      || sha256Canonical(digestPayload) !== String(acceptance.evidenceDigestSha256).toLowerCase()) {
    fail("ordinary-dynamic-shadow-r3-evidence-digest-invalid");
  }

  const recordings = Array.isArray(acceptance.recordings) ? acceptance.recordings : [];
  const recordingIds = recordings.map((row) => String(row?.recordingId || "").trim()).sort();
  if (recordings.length !== ORDINARY_DYNAMIC_ACCEPTANCE_RECORDINGS.length
      || JSON.stringify(recordingIds) !== JSON.stringify([...ORDINARY_DYNAMIC_ACCEPTANCE_RECORDINGS].sort())) {
    fail("ordinary-dynamic-shadow-r3-recording-set-invalid");
  }
  for (const recording of recordings) {
    const id = String(recording?.recordingId || "").trim();
    const prefix = `ordinary-dynamic-shadow-r3-recording-invalid:${id || "unknown"}`;
    const rowCount = recording?.candidateRowCount;
    const selectedCount = recording?.shadowSelectedCandidateCount;
    const reportedCoverage = recording?.shadowCoverage;
    const scoreNoteCount = recording?.scoreNoteCount;
    const expectedCoverage = Number.isInteger(rowCount) && rowCount > 0
      ? selectedCount / rowCount
      : -1;
    if (!ORDINARY_DYNAMIC_ACCEPTANCE_RECORDINGS.includes(id)
        || !String(recording?.scoreId || "").trim()
        || !isSha256(recording?.audioSha256)
        || !isSha256(recording?.scorePayloadSha256)
        || !isSha256(recording?.scoreStoreArtifactSha256)
        || !Number.isInteger(scoreNoteCount) || scoreNoteCount <= 0
        || !Number.isInteger(rowCount) || rowCount <= 0
        || rowCount !== scoreNoteCount
        || !Number.isInteger(selectedCount) || selectedCount < 0 || selectedCount > rowCount
        || recording?.exactPitchSelectedCount !== selectedCount
        || !Number.isFinite(reportedCoverage)
        || Math.abs(reportedCoverage - expectedCoverage) > 1e-6
        || expectedCoverage < V2_ALPHA_MIN_COVERAGE
        || recording?.allRowsReviewRequired !== true
        || recording?.autoPassCount !== 0
        || recording?.studentFacing !== false
        || recording?.fullArtifactAuditPassed !== true) {
      fail(prefix);
    }
    const cold = recording?.coldRun || {};
    const warm = recording?.warmRun || {};
    const validateRun = (run, expectedCacheHit, label) => {
      if (run.cacheHit !== expectedCacheHit
          || run.cacheIdentityBound !== true
          || run.candidateArtifactAuditPassed !== true
          || run.allRowsReviewRequired !== true
          || run.autoPassCount !== 0
          || run.studentFacing !== false
          || run.automaticAdoptionAuthorized !== false
          || run.authorizationReady !== false
          || run.energyVetoIncluded !== false
          || run.causalEnergyStatus !== "excluded-review-only"
          || run.contractVersion !== ORDINARY_DYNAMIC_CONTRACT_VERSION
          || run.gateVersion !== ORDINARY_DYNAMIC_GATE_VERSION
          || run.timingMode !== ORDINARY_DYNAMIC_TIMING_MODE
          || run.candidateRowCount !== rowCount
          || run.reviewRequiredCount !== rowCount
          || run.scoreNoteCount !== scoreNoteCount
          || String(run.audioSha256 || "").toLowerCase() !== String(recording?.audioSha256 || "").toLowerCase()
          || String(run.scorePayloadSha256 || "").toLowerCase() !== String(recording?.scorePayloadSha256 || "").toLowerCase()
          || String(run.scoreStoreArtifactSha256 || "").toLowerCase() !== String(recording?.scoreStoreArtifactSha256 || "").toLowerCase()
          || String(run.modelArtifactSha256 || "").toLowerCase() !== ORDINARY_DYNAMIC_MODEL_SHA256
          || run.policyVersion !== ORDINARY_DYNAMIC_POLICY_VERSION
          || !isSha256(run.cacheArtifactSha256)
          || !isSha256(run.candidateArtifactSha256)
          || !isSha256(run.candidateEvidenceSha256)) {
        fail(`${prefix}:${label}`);
      }
    };
    validateRun(cold, false, "cold");
    validateRun(warm, true, "warm");
    if (String(cold.cacheArtifactSha256 || "").toLowerCase() !== String(warm.cacheArtifactSha256 || "").toLowerCase()
        || String(cold.candidateEvidenceSha256 || "").toLowerCase() !== String(warm.candidateEvidenceSha256 || "").toLowerCase()) {
      fail(`${prefix}:cold-warm-evidence-mismatch`);
    }
  }
  const aggregate = acceptance.aggregate || {};
  if (aggregate.recordingCount !== 2
      || aggregate.coldCacheMissCount !== 2
      || aggregate.warmCacheHitCount !== 2
      || aggregate.coverageFloor !== V2_ALPHA_MIN_COVERAGE
      || aggregate.allRowsReviewRequired !== true
      || aggregate.allArtifactsBound !== true
      || aggregate.coldWarmEvidenceStable !== true) {
    fail("ordinary-dynamic-shadow-r3-aggregate-invalid");
  }
  if (!ORDINARY_DYNAMIC_ACCEPTANCE_LIVE_VERIFIER_IMPLEMENTED) {
    fail("ordinary-dynamic-shadow-r3-live-artifact-verifier-not-implemented");
  }
  return { ready: blockingReasons.length === 0, blockingReasons: [...new Set(blockingReasons)] };
}

async function sha256FileOrEmpty(filePath) {
  try {
    const bytes = await fs.readFile(path.resolve(process.cwd(), filePath));
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } catch {
    return "";
  }
}

async function readWorkspaceArtifact(filePath) {
  const value = String(filePath || "").trim();
  if (!value || path.isAbsolute(value)) return { bytes: null, sha256: "", status: "path-invalid" };
  try {
    const realRoot = await fs.realpath(path.resolve(process.cwd()));
    const realArtifact = await fs.realpath(path.resolve(realRoot, value));
    const relative = path.relative(realRoot, realArtifact);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return { bytes: null, sha256: "", status: "outside-workspace" };
    }
    const before = await fs.readFile(realArtifact);
    const after = await fs.readFile(realArtifact);
    const beforeSha256 = crypto.createHash("sha256").update(before).digest("hex");
    const afterSha256 = crypto.createHash("sha256").update(after).digest("hex");
    if (beforeSha256 !== afterSha256) {
      return { bytes: null, sha256: "", status: "changed-during-read" };
    }
    return {
      bytes: after,
      sha256: afterSha256,
      status: "ok",
    };
  } catch {
    return { bytes: null, sha256: "", status: "unreadable" };
  }
}

async function hashWorkspaceArtifact(filePath) {
  const result = await readWorkspaceArtifact(filePath);
  return { sha256: result.sha256, status: result.status };
}

export async function auditM3PlusPhysicalEvidenceCurrent(monitoredPilotAudit = null) {
  const runtimeEvidence = monitoredPilotAudit?.runtimeEvidence || {};
  const runtime = runtimeEvidence.runtime || {};
  const definitions = [
    ["candidate-rows", runtimeEvidence.candidateRowsPath, runtimeEvidence.candidateRowsSha256],
    ["policy-artifact", runtime.policyArtifactPath, runtime.policyArtifactSha256],
    ["analyzer-artifact", runtime.analyzerArtifactPath, runtime.analyzerArtifactSha256],
    ["rescope-report", runtime.rescopeReportPath, runtime.rescopeReportSha256],
  ];
  const checks = {};
  const blockingReasons = [];
  for (const [name, artifactPath, expectedSha256] of definitions) {
    const observed = await hashWorkspaceArtifact(artifactPath);
    const expected = String(expectedSha256 || "").trim().toLowerCase();
    const current = observed.status === "ok"
      && isSha256(expected)
      && observed.sha256 === expected;
    checks[name] = {
      path: String(artifactPath || "").replace(/\\/g, "/") || null,
      expectedSha256: expected || null,
      observedSha256: observed.sha256 || null,
      status: observed.status,
      current,
    };
    if (!current) {
      const suffix = observed.status === "ok" && isSha256(expected)
        ? "sha-mismatch"
        : observed.status === "ok"
          ? "expected-sha-invalid"
          : observed.status;
      blockingReasons.push(`m3plus-live-${name}-${suffix}`);
    }
  }
  const rescopeRead = await readWorkspaceArtifact(runtime.rescopeReportPath);
  let sourceBindings = { ready: false, bindings: {}, blockingReasons: [] };
  if (rescopeRead.status === "ok") {
    try {
      const rescopeGate = JSON.parse(rescopeRead.bytes.toString("utf8"));
      sourceBindings = await auditSourceBindings(rescopeGate, { sourceRoot: process.cwd() });
    } catch {
      blockingReasons.push("m3plus-live-rescope-report-json-invalid");
    }
  }
  const cachedSourceBindingsCurrent = sourceBindings.ready === true
    && canonicalJson(monitoredPilotAudit?.sourceBindings || null) === canonicalJson(sourceBindings);
  checks["source-bindings"] = {
    ready: sourceBindings.ready === true,
    cachedBindingCurrent: cachedSourceBindingsCurrent,
    blockingReasons: sourceBindings.blockingReasons || [],
  };
  if (sourceBindings.ready !== true) {
    blockingReasons.push(...(sourceBindings.blockingReasons || ["m3plus-live-source-bindings-not-ready"]));
  }
  if (!cachedSourceBindingsCurrent) {
    blockingReasons.push("m3plus-live-source-bindings-cache-mismatch");
  }

  const expectedBatchRunsPath = "data/experiments/western-strings-m3/controlled-submission-batch-runs.jsonl";
  const batchRunsPath = String(monitoredPilotAudit?.inputs?.batchRuns || "").replace(/\\/g, "/");
  const batchRead = batchRunsPath === expectedBatchRunsPath
    ? await readWorkspaceArtifact(batchRunsPath)
    : { bytes: null, sha256: "", status: "path-invalid" };
  let batchAudit = null;
  let latestRun = null;
  if (batchRead.status === "ok") {
    const lines = batchRead.bytes.toString("utf8").replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      latestRun = lines.length ? JSON.parse(lines.at(-1)) : null;
    } catch {
      blockingReasons.push("m3plus-live-latest-batch-invalid-json");
    }
    if (!latestRun) blockingReasons.push("m3plus-live-latest-batch-missing");
  } else {
    blockingReasons.push(`m3plus-live-batch-runs-${batchRead.status}`);
  }
  if (latestRun) {
    batchAudit = auditControlledBatchRuns([latestRun], {
      requireFeatureReview: true,
      requireM3PlusRuntime: true,
      sourceRoot: process.cwd(),
      latestOnly: true,
    });
    if (batchAudit.ok !== true) {
      blockingReasons.push(...(batchAudit.failures || []).map(
        (failure) => `m3plus-live-latest-batch-audit:${failure.code || "unknown"}`,
      ));
    }
    const ordinaryItems = (Array.isArray(latestRun.items) ? latestRun.items : [])
      .filter((item) => item?.kind !== "photo-score" && item?.analysisStatus === "offline_feature_review_ready");
    const latestItem = ordinaryItems.at(-1) || null;
    const latestRuntime = latestItem?.candidateGate?.m3plusPitchSafetyRuntime || null;
    const latestBindingCurrent = latestRun.batchRunId === runtimeEvidence.batchRunId
      && latestItem?.candidateRowsPath === runtimeEvidence.candidateRowsPath
      && latestItem?.candidateRowsSha256 === runtimeEvidence.candidateRowsSha256
      && latestItem?.candidateRowCount === runtimeEvidence.candidateRowCount
      && canonicalJson(latestRuntime) === canonicalJson(runtime);
    if (!latestBindingCurrent) blockingReasons.push("m3plus-live-latest-batch-binding-mismatch");
    checks["latest-batch"] = {
      path: batchRunsPath,
      observedSha256: batchRead.sha256,
      batchRunId: latestRun.batchRunId || null,
      cachedBindingCurrent: latestBindingCurrent,
      auditReady: batchAudit.ok === true,
      failureCodes: (batchAudit.failures || []).map((failure) => failure.code || "unknown"),
    };
  } else {
    checks["latest-batch"] = {
      path: batchRunsPath || null,
      observedSha256: batchRead.sha256 || null,
      batchRunId: null,
      cachedBindingCurrent: false,
      auditReady: false,
      failureCodes: [],
    };
  }
  return {
    ready: definitions.length > 0 && blockingReasons.length === 0,
    checks,
    blockingReasons,
  };
}

export function evaluateHomrDeploymentSnapshot({
  review = null,
  reviewSha256 = "",
  manifestSha256 = "",
  lockSha256 = "",
  preflight = null,
} = {}) {
  const decision = review?.decision || {};
  const decisionApproved = decision.status === "approved-with-conditions"
    && String(decision.reviewedBy || "").trim() !== ""
    && Array.isArray(decision.approvedScopes)
    && decision.approvedScopes.length === 1
    && decision.approvedScopes[0] === "controlled-offline-review-only"
    && decision.controlledOfflineReviewApproved === true
    && decision.studentFacingNetworkUseApproved === false
    && decision.redistributionApproved === false
    && decision.confirmations?.controlledOfflineOnly === true
    && decision.confirmations?.modelLicenseBasisReviewed === true
    && decision.confirmations?.noModelRedistribution === true
    && decision.approvalBinding?.bindingVersion === 2;
  const preflightPresent = Boolean(preflight);
  const reviewBindingCurrent = Boolean(
    preflightPresent
      && reviewSha256
      && preflight.reviewRecordSha256
      && preflight.reviewRecordSha256 === reviewSha256,
  );
  const manifestBindingCurrent = Boolean(
    preflightPresent
      && manifestSha256
      && preflight.manifestSha256
      && preflight.manifestSha256 === manifestSha256,
  );
  const lockBindingCurrent = Boolean(
    preflightPresent
      && lockSha256
      && preflight.lockSha256
      && preflight.lockSha256 === lockSha256,
  );
  const preflightBindingCurrent = reviewBindingCurrent
    && manifestBindingCurrent
    && lockBindingCurrent;
  const licenseReviewReady = decisionApproved
    && preflightBindingCurrent
    && preflight?.governanceReady === true;
  const artifactIntegrityReady = preflightBindingCurrent
    && preflight?.host?.components?.homr?.ready === true;
  const deploymentPreflightReady = preflightBindingCurrent
    && preflight?.deploymentReady === true;
  const productionPoolReady = Boolean(
    licenseReviewReady && artifactIntegrityReady && deploymentPreflightReady,
  );
  const blockingReasons = [
    ...(!decisionApproved ? ["homr-license-review-not-approved"] : []),
    ...(!preflightPresent ? ["photo-score-deployment-preflight-missing"] : []),
    ...(preflightPresent && !reviewBindingCurrent
      ? ["photo-score-deployment-preflight-stale-review-record"]
      : []),
    ...(preflightPresent && !manifestBindingCurrent
      ? ["photo-score-deployment-preflight-stale-manifest"]
      : []),
    ...(preflightPresent && !lockBindingCurrent
      ? ["photo-score-deployment-preflight-stale-lock"]
      : []),
    ...(preflightBindingCurrent ? (preflight?.blockingReasons || []) : []),
  ];
  return {
    decisionApproved,
    reviewBindingCurrent,
    manifestBindingCurrent,
    lockBindingCurrent,
    preflightBindingCurrent,
    licenseReviewReady,
    artifactIntegrityReady,
    deploymentPreflightReady,
    productionPoolReady,
    blockingReasons: [...new Set(blockingReasons)],
  };
}

const CONTROLLED_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "controlled-candidate-review-labels.csv",
);
const CONTROLLED_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "index.html",
);
const CONTROLLED_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_PILOT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "candidate-confidence-pilot.json",
);
const CONTROLLED_CONFIDENCE_VALIDATION_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-validation-review",
  "confidence-validation-eval.json",
);
const CONTROLLED_CONFIDENCE_RELEASE = path.join(
  "models",
  "western-strings",
  "ordinary-upload-confidence-rf-v1",
  "release.json",
);
const CONTROLLED_CONFIDENCE_RELEASE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-validation-review",
  "ordinary-confidence-release-audit.json",
);
const CONTROLLED_ORDINARY_MONITORED_PILOT_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "ordinary-monitored-pilot",
  "ordinary-monitored-pilot-audit.json",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "index.html",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "confidence-threshold-pool-eval.json",
);
const CONTROLLED_CONFIDENCE_THRESHOLD_POOL_DIAGNOSIS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-threshold-pool-review",
  "confidence-threshold-pool-diagnosis.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration",
  "combined-controlled-candidate-review-labels.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration",
  "candidate-confidence-recalibration-pilot.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "index.html",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-validation-eval.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-failure-diagnosis.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_ROWS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-failure-diagnosis-rows.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_GROUPS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-validation-review",
  "confidence-recalibration-failure-diagnosis-groups.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "index.html",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "controlled-candidate-review.completed.csv",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "confidence-recalibration-context-validation-eval.json",
);
const CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_ROWS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration-context-validation-review",
  "confidence-recalibration-context-validation-eval-rows.csv",
);
const M3PLUS_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review.csv",
);
const M3PLUS_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review-labels.csv",
);
const M3PLUS_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review.completed.csv",
);
const M3PLUS_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "index.html",
);
const M3PLUS_ROUND2_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-round2",
  "index.html",
);
const M3PLUS_ROUND2_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-round2",
  "m3plus-pitch-mode-review.csv",
);
const M3PLUS_ROUND2_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-round2",
  "m3plus-pitch-mode-review.completed.csv",
);
const M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "index.html",
);
const M3PLUS_CANDIDATE_QUALITY_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "m3plus-pitch-mode-review.csv",
);
const M3PLUS_CANDIDATE_QUALITY_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "m3plus-pitch-mode-review.completed.csv",
);
const M3PLUS_MODE_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-eval.json",
);
const M3PLUS_MONITORED_PILOT_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "monitored-pilot",
  "m3plus-monitored-pilot-audit.json",
);
const M3PLUS_MODE_EVAL_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-eval.csv",
);
const M3PLUS_LOCALIZATION_DIAGNOSIS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-localization-diagnosis.json",
);
const M3PLUS_LOCALIZATION_GROUPS_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-localization-diagnosis-groups.csv",
);
const M3PLUS_LOCALIZATION_ROWS_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-localization-diagnosis-rows.csv",
);
const M3PLUS_COARSE_STATE_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "m3plus-coarse-state-eval.json",
);
const M3PLUS_ROUND2_ALIGNED_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-round2",
  "m3plus-aligned-eval.json",
);
const M3PLUS_ROUND2_TRILL_VIBRATO_DIAGNOSTIC = path.join(
  "data",
  "experiments",
  "western-strings-round2",
  "m3plus-trill-vibrato-diagnostic.json",
);
const M3PLUS_SUPPLEMENTAL_STATUS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "supplemental-intake-status.json",
);
const M3PLUS_SUPPLEMENTAL_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "supplemental-machine-eval",
  "supplemental-machine-eval.json",
);
const M3PLUS_PROTOCOL_ORDER_DIAGNOSTIC = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "protocol-order-diagnostic",
  "protocol-order-diagnostic.json",
);
const M3PLUS_FEATURE_SEPARABILITY_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "feature-separability-audit",
  "feature-separability-audit.json",
);
const M3PLUS_BACKEND_CONSENSUS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "backend-consensus",
  "report.json",
);
const M3PLUS_RESCOPE_GATE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "rescope-gate",
  "report.json",
);
const M4_READINESS = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "omr-readiness.json",
);
const M4_BENCHMARK = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "omr-benchmark.json",
);
const M4_INDEPENDENT_BENCHMARK_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-benchmark-audit.json",
);
const M4_OEMER_BENCHMARK = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "oemer-source-benchmark",
  "oemer-source-benchmark.json",
);
const M4_OEMER_DEWARP_ATTRIBUTION = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "oemer-dewarp-attribution",
  "report.json",
);
const M4_HOMR_BENCHMARK = path.join(
  "docs",
  "evidence",
  "western-strings-homr-sourcegold-20260717.json",
);
const M4_ZEUS_CHALLENGER = path.join(
  "docs",
  "evidence",
  "western-strings-m4-zeus-challenger-20260720.json",
);
const HOMR_REVIEW_RECORD = path.join(
  "config", "third-party", "homr-0.7.0-review.json",
);
const PHOTO_SCORE_DEPLOYMENT_CONFIG = path.join(
  "config", "western-photo-score-deployment.json",
);
const PHOTO_SCORE_HOMR_RUNTIME_LOCK = path.join(
  "config", "western-photo-score-homr-runtime.lock.txt",
);
const PHOTO_SCORE_DEPLOYMENT_PREFLIGHT = path.join(
  "data", "experiments", "western-strings-m4", "photo-score-deployment-preflight.json",
);
const M4_SAME_EDITION_BENCHMARK = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "beijing-same-edition-benchmark",
  "same-edition-engine-comparison.json",
);
const M4_SAME_EDITION_MULTIPAGE_BENCHMARK = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "same-edition-multipage-benchmark",
  "same-edition-engine-comparison.json",
);
const M4_OP45_PUBLIC_REFERENCE = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "op45-34-public-reference",
  "op45-34-public-reference-comparison.json",
);
const M4_CLARITY_BENCHMARK = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "clarity-source-benchmark",
  "clarity-source-benchmark.json",
);
const M4_CLARITY_ADAPTATION_BENCHMARK = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "clarity-adaptation-photo-benchmark",
  "clarity-source-benchmark.json",
);
const M4_INDEPENDENT_GOLD_TODO = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-todo.md",
);
const M4_INDEPENDENT_GOLD_TODO_HTML = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-todo.html",
);
const M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-workspace-audit.json",
);
const M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "independent-gold-workspace-audit.csv",
);
const M4_GOLD_PROVENANCE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "gold-provenance-audit.json",
);
const M4_GOLD_PROVENANCE_AUDIT_CSV = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "gold-provenance-audit.csv",
);
const M4_RHYTHM_CANDIDATE_ORACLE = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "rhythm-candidate-oracle",
  "report.json",
);
const M4_P0_STRUCTURE_GATE = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "p0-structure-gate",
  "report.json",
);
const M4_DUAL_EVIDENCE_GOLD_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "dual-evidence-gold-audit",
  "report.json",
);
const M4_P0_FEEDBACK_IMPACT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "p0-feedback-impact",
  "report.json",
);
const M4_GREEN_SAFETY_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "green-safety-audit",
  "report.json",
);
const M4_ADAPTIVE_INTERLINE_PROBE = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "adaptive-interline-probe",
  "report.json",
);
const M4_FOCUSED_SYMBOL_GOLD = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "focused-symbol-gold",
  "report.json",
);
const M4_AUDIO_RHYTHM_RANKING = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "audio-rhythm-ranking",
  "report.json",
);
const M4_ENGINE_CONSENSUS = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "engine-consensus",
  "report.json",
);
const M4_ENGINE_CONSENSUS_TOLERANCE_SWEEP = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "engine-consensus-tolerance-sweep",
  "report.json",
);
const MEASURE_POLICY_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "measure-policy-audit",
  "report.json",
);
const MEASURE_JOINT_EVIDENCE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "measure-joint-evidence-audit",
  "report.json",
);
const DYNAMIC_PERTURBATION_GATE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "dynamic-perturbation-gate",
  "report.json",
);
const DYNAMIC_WEAK_COMBINED_GATE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "dynamic-weak-combined-gate",
  "report.json",
);
const DYNAMIC_WEAK_COMBINED_CONFIRMATION = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "dynamic-weak-combined-gate-confirmation",
  "report.json",
);
const RELEASE_REVIEW = path.join(
  "data",
  "experiments",
  "western-strings-release-review.json",
);
const RELEASE_REVIEW_MD = path.join(
  "data",
  "experiments",
  "western-strings-release-review.md",
);
const CONTROLLED_PILOT_DECISION = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-decision.json",
);
const CONTROLLED_PILOT_DECISION_MD = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-decision.md",
);
const CONTROLLED_PILOT_SESSIONS_ROOT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-sessions",
);
const CONTROLLED_PILOT_EVIDENCE_AUDIT_MD = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-evidence-audit.md",
);
const CONTROLLED_PILOT_EVIDENCE_AUDIT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-evidence-audit.json",
);
const FRESH_BLIND_INTAKE_STATUS = path.join(
  "data",
  "experiments",
  "western-strings-v2alpha-blind-intake-status.json",
);
const FRESH_BLIND_INTAKE_STATUS_MD = path.join(
  "data",
  "experiments",
  "western-strings-v2alpha-blind-intake-status.md",
);

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
  }
  return args;
}

async function exists(filePath) {
  try {
    await fs.access(path.resolve(process.cwd(), filePath));
    return true;
  } catch {
    return false;
  }
}

function splitCsvLine(line) {
  const cols = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cols.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols;
}

async function readCsv(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  let text = "";
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch {
    return [];
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const headers = splitCsvLine(lines.shift());
  return lines.map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] || "";
    });
    return row;
  });
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8"));
  } catch {
    return fallback;
  }
}

async function auditFlatEvidenceSourceBinding(evidence) {
  const rows = Array.isArray(evidence?.sourceBinding?.files) ? evidence.sourceBinding.files : [];
  const blockingReasons = [];
  const observed = [];
  if (!rows.length) blockingReasons.push("flat-evidence-source-binding-missing");
  for (const [index, row] of rows.entries()) {
    const source = await readWorkspaceArtifact(row?.path || "");
    const expectedSha256 = String(row?.sha256 || "").toLowerCase();
    const hashMode = String(row?.hashMode || "");
    if (source.status !== "ok") {
      blockingReasons.push(`flat-evidence-source-unreadable:${index}:${source.status}`);
      continue;
    }
    if (!["raw-sha256", "lf-normalized-sha256"].includes(hashMode)) {
      blockingReasons.push(`flat-evidence-source-hash-mode-invalid:${index}`);
      continue;
    }
    const observedSha256 = hashMode === "lf-normalized-sha256"
      ? crypto.createHash("sha256").update(
          source.bytes.toString("utf8").replace(/\r\n?/g, "\n"),
        ).digest("hex")
      : source.sha256;
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || observedSha256 !== expectedSha256) {
      blockingReasons.push(`flat-evidence-source-sha-mismatch:${index}`);
      continue;
    }
    observed.push({
      path: String(row.path).replace(/\\/g, "/"),
      hashMode,
      sha256: observedSha256,
    });
  }
  const aggregateSha256 = crypto.createHash("sha256").update(canonicalJson(observed)).digest("hex");
  if (Number(evidence?.sourceBinding?.fileCount) !== rows.length) {
    blockingReasons.push("flat-evidence-source-file-count-mismatch");
  }
  if (observed.length !== rows.length
      || aggregateSha256 !== String(evidence?.sourceBinding?.aggregateSha256 || "").toLowerCase()) {
    blockingReasons.push("flat-evidence-source-aggregate-mismatch");
  }
  return { ready: blockingReasons.length === 0, fileCount: rows.length, aggregateSha256, blockingReasons };
}

async function summarizeRound5PolicyCWaveformRobustness({
  reportPath = ROUND5_POLICY_C_WAVEFORM_ROBUSTNESS,
} = {}) {
  const evidence = await readJson(reportPath);
  const sourceAudit = evidence
    ? await auditFlatEvidenceSourceBinding(evidence)
    : {
        ready: false,
        fileCount: 0,
        aggregateSha256: "",
        blockingReasons: ["round5-policy-c-waveform-evidence-missing"],
      };
  const independence = evidence?.independenceAudit || {};
  const sample = evidence?.sample || {};
  const energy = evidence?.energyAbsence || {};
  const targetPitch = evidence?.targetPitchAbsence || {};
  const boundaryValid = Boolean(
    evidence?.scope === "consumed-multi-device-room-diagnostic-only"
      && evidence?.evidenceRole === "diagnostic-only"
      && evidence?.studentFacing === false
      && evidence?.automaticAccusationReady === false
      && evidence?.reviewAssistPromotionReady === false
      && evidence?.promotionEvidenceEligible === false
      && evidence?.freshBlindPromotionEligible === false
      && evidence?.round5Consumed === true
      && evidence?.thresholdRetunedOnRound5 === false
      && energy?.energyRobustnessReady === false
      && targetPitch?.targetPitchRobustnessReady === false
  );
  const independenceLimitationsCurrent = Boolean(
    independence?.thresholdSelectionUsesRound5 === false
      && independence?.round5LabelsPreviouslyInspected === true
      && independence?.round5AudioPreviouslyEvaluated === true
      && independence?.samePerformersAcrossSplits === true
      && independence?.sameDevicesAcrossSplits === true
      && independence?.roomPerfectlyConfoundedWithSplit === true
      && independence?.positionTargetsScoreContextConfounded === true
  );
  const denominatorCurrent = Boolean(
    Number(sample?.recordings) === 12
      && Number(sample?.scorePositions) === 672
      && Number(sample?.missingPositives) === 12
      && Number(sample?.missingConfusionNegatives) === 24
      && Number(sample?.performers) === 2
      && Number(sample?.devices) === 3
      && Number(sample?.rooms) === 2
  );
  const thresholdsCurrent = Boolean(
    Number(energy?.frozenThreshold?.threshold) === -134.825302
      && energy?.frozenThreshold?.selectionDomain
        === "r2-01 waveform-injection-v2 (3 seeds)"
      && Number(targetPitch?.frozenThreshold?.threshold) === 0
      && targetPitch?.frozenThreshold?.selectionDomain
        === "r2-01 waveform-injection-v2 (3 seeds)"
  );
  const requiredEvidenceReasons = [
    "round5-consumed-diagnostic-not-promotion-evidence",
    "round5-position-targets-score-context-confounded",
    "round5-room-perfectly-confounded-with-split",
    "independent-cross-performer-device-fresh-evidence-missing",
  ];
  const evidenceReasons = Array.isArray(evidence?.blockingReasons)
    ? evidence.blockingReasons
    : [];
  const limitationsExplicit = requiredEvidenceReasons.every(
    (reason) => evidenceReasons.includes(reason),
  );
  const blockingReasons = normalizedReasonList([
    ...(!evidence ? ["round5-policy-c-waveform-evidence-missing"] : []),
    ...(evidence && evidence.contract
      !== "western-round5-policy-c-waveform-robustness-diagnostic-v1"
      ? ["round5-policy-c-waveform-contract-invalid"]
      : []),
    ...(!boundaryValid ? ["round5-policy-c-waveform-safety-boundary-invalid"] : []),
    ...(!independenceLimitationsCurrent
      ? ["round5-policy-c-waveform-independence-audit-invalid"]
      : []),
    ...(!denominatorCurrent ? ["round5-policy-c-waveform-denominator-invalid"] : []),
    ...(!thresholdsCurrent ? ["round5-policy-c-waveform-threshold-binding-invalid"] : []),
    ...(!limitationsExplicit
      ? ["round5-policy-c-waveform-limitations-not-explicit"]
      : []),
    ...(sourceAudit.blockingReasons || []),
  ]);
  return {
    contract: evidence?.contract || null,
    source: reportPath.replace(/\\/g, "/"),
    scope: evidence?.scope || null,
    auditReady: blockingReasons.length === 0,
    sourceCurrent: sourceAudit.ready === true,
    sourceFileCount: sourceAudit.fileCount,
    sourceAggregateSha256: sourceAudit.aggregateSha256 || null,
    safetyBoundaryValid: boundaryValid,
    independenceLimitationsCurrent,
    denominatorCurrent,
    thresholdsCurrent,
    sample: evidence?.sample || null,
    thresholdRetunedOnRound5: evidence?.thresholdRetunedOnRound5 === true,
    promotionEvidenceEligible: evidence?.promotionEvidenceEligible === true,
    freshBlindPromotionEligible: evidence?.freshBlindPromotionEligible === true,
    energyRobustnessReady: false,
    targetPitchRobustnessReady: false,
    energyAbsence: {
      threshold: energy?.frozenThreshold?.threshold ?? null,
      pooled: energy?.round5Diagnostic?.pooled || null,
      split: energy?.round5Diagnostic?.split || null,
    },
    targetPitchAbsence: {
      threshold: targetPitch?.frozenThreshold?.threshold ?? null,
      pooled: targetPitch?.round5Diagnostic?.pooled || null,
      split: targetPitch?.round5Diagnostic?.split || null,
    },
    evidenceBlockingReasons: normalizedReasonList(evidenceReasons),
    blockingReasons,
  };
}

export async function summarizeRound6CounterbalancedCapture({
  contractPath = ROUND6_COUNTERBALANCED_CONTRACT,
  manifestPath = ROUND6_COUNTERBALANCED_MANIFEST,
  truthPath = ROUND6_COUNTERBALANCED_TRUTH,
  positionBalancePath = ROUND6_COUNTERBALANCED_POSITION_BALANCE,
  intakePath = ROUND6_COUNTERBALANCED_INTAKE,
  evaluationProtocolPath = ROUND6_EVALUATION_PROTOCOL,
  evaluationReportPath = ROUND6_EVALUATION_REPORT,
  stagedProtocolPath = P3_MINIMAL_RECORDING_PROTOCOL,
  stageASignoffLineagePath = ROUND6_STAGE_A_SIGNOFF_LINEAGE,
  stageASafetyReportPath = ROUND6_STAGE_A_SAFETY_REPORT,
  stageASafetyModelPath = ROUND6_STAGE_A_SAFETY_MODEL,
  stageASafetyConsumedPath = ROUND6_STAGE_A_SAFETY_CONSUMED,
  materialsRoot = path.dirname(manifestPath),
  workspaceRoot = process.cwd(),
} = {}) {
  const [
    contract,
    manifestRows,
    truth,
    positionBalance,
    intake,
    evaluationProtocol,
    evaluationReport,
    stagedProtocol,
    stageASignoffLineage,
    stageASafetyReport,
    stageASafetyConsumed,
    contractSha256,
    manifestSha256,
    truthSha256,
    stagedProtocolSha256,
    stageASignoffLineageSha256,
    stageASafetyReportSha256,
    stageASafetyModelSha256,
    stageASafetyConsumedSha256,
  ] = await Promise.all([
    readJson(contractPath),
    readCsv(manifestPath),
    readJson(truthPath),
    readJson(positionBalancePath),
    readJson(intakePath),
    readJson(evaluationProtocolPath),
    readJson(evaluationReportPath),
    readJson(path.resolve(workspaceRoot, stagedProtocolPath)),
    readJson(path.resolve(workspaceRoot, stageASignoffLineagePath)),
    readJson(path.resolve(workspaceRoot, stageASafetyReportPath)),
    readJson(path.resolve(workspaceRoot, stageASafetyConsumedPath)),
    sha256FileOrEmpty(contractPath),
    sha256FileOrEmpty(manifestPath),
    sha256FileOrEmpty(truthPath),
    sha256FileOrEmpty(path.resolve(workspaceRoot, stagedProtocolPath)),
    sha256FileOrEmpty(path.resolve(workspaceRoot, stageASignoffLineagePath)),
    sha256FileOrEmpty(path.resolve(workspaceRoot, stageASafetyReportPath)),
    sha256FileOrEmpty(path.resolve(workspaceRoot, stageASafetyModelPath)),
    sha256FileOrEmpty(path.resolve(workspaceRoot, stageASafetyConsumedPath)),
  ]);
  const frozenMinimums = {
    performers: 6,
    devices: 3,
    rooms: 4,
    positivePerGate: 12,
    freshBlindPositivePerGate: 6,
    confusionNegativePerGate: 24,
    freshBlindConfusionNegativePerGate: 12,
  };
  const sameStringSet = (left, right) => (
    JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort())
  );
  const frozenMinimumsCurrent = Object.entries(frozenMinimums).every(
    ([key, value]) => Number(contract?.minimums?.[key]) === value,
  );
  const contractValid = Boolean(
    contract?.contractVersion === ROUND6_COUNTERBALANCED_CONTRACT_VERSION
      && contract?.status === "pre-recording-design-only"
      && sameStringSet(contract?.allowedGates, ROUND5_SEGMENT_GATES)
      && sameStringSet(contract?.allowedSplits, ["calibration", "fresh-blind"])
      && sameStringSet(contract?.allowedLabels, ["positive", "confusion_negative"])
      && frozenMinimumsCurrent
      && contract?.promotionThresholds?.minPrecision === 0.9
      && contract?.promotionThresholds?.minRecall === 0.5
      && contract?.promotionThresholds?.maxStrictFalseAccusations === 0
      && contract?.promotion?.minPrecision === 0.9
      && contract?.promotion?.minRecall === 0.5
      && contract?.promotion?.maxStrictFalseAccusations === 0
      && contract?.positionDesign?.recordingsPerScore === 3
      && sameStringSet(
        contract?.positionDesign?.roleRotation,
        ["positive", "confusion_negative_a", "confusion_negative_b"],
      )
      && contract?.positionDesign?.requiredPreflightContract
        === "western-round5-position-balance-preflight-v2"
      && contract?.positionDesign?.requiredPreflightReady === true
      && contract?.splitDiscipline?.calibrationAndFreshScoresDisjoint === true
      && contract?.splitDiscipline?.calibrationAndFreshPerformersDisjoint === true
      && contract?.splitDiscipline?.freshBlindMayBeRunOnce === true
      && contract?.splitDiscipline?.consumedRound4OrRound5AudioAllowed === false
      && contract?.privacy?.requiredConsent === "yes"
      && contract?.privacy?.requiredLicenseStatus === "local-only"
      && contract?.truth?.requiredCompleteErrorInventory === true
      && contract?.studentFacing === false
      && contract?.automaticAuthorizationGranted === false
      && contract?.promotion?.studentFacing === false
      && contract?.promotion?.automaticAuthorizationGranted === false,
  );
  const hashBoundText = async (filePath, mode) => {
    try {
      const bytes = await fs.readFile(path.resolve(workspaceRoot, filePath));
      const input = mode === "lf-normalized-sha256"
        ? bytes.toString("utf8").replace(/\r\n?/g, "\n")
        : mode === "raw-sha256"
          ? bytes
          : null;
      return input === null
        ? ""
        : crypto.createHash("sha256").update(input).digest("hex");
    } catch {
      return "";
    }
  };
  const stagedProtocolBindings = Array.isArray(stagedProtocol?.sourceBindings)
    ? stagedProtocol.sourceBindings : [];
  const observedStagedProtocolBindings = await Promise.all(
    stagedProtocolBindings.map(async (binding) => ({
      path: String(binding?.path || "").replace(/\\/g, "/"),
      expectedSha256: String(binding?.sha256 || "").toLowerCase(),
      observedSha256: await sha256FileOrEmpty(
        path.resolve(workspaceRoot, String(binding?.path || "")),
      ),
    })),
  );
  const stagedProtocolSemanticCore = stagedProtocol
    ? Object.fromEntries(
      Object.entries(stagedProtocol).filter(
        ([key]) => ![
          "schemaVersion",
          "sourceBindings",
          "protocolSemanticSha256",
        ].includes(key),
      ),
    )
    : null;
  const observedStagedProtocolSemanticSha256 = stagedProtocolSemanticCore
    ? crypto.createHash("sha256")
      .update(canonicalJson(stagedProtocolSemanticCore), "utf8")
      .digest("hex")
    : "";
  const stagedProtocolSemanticHashCurrent = Boolean(
    stagedProtocol
      && /^[a-f0-9]{64}$/.test(
        String(stagedProtocol?.protocolSemanticSha256 || ""),
      )
      && observedStagedProtocolSemanticSha256
        === String(stagedProtocol.protocolSemanticSha256),
  );
  const stagedBindingByPath = new Map(
    observedStagedProtocolBindings.map((row) => [row.path, row]),
  );
  const mutableStagedPaths = new Set([
    String(path.relative(
      path.resolve(workspaceRoot),
      path.resolve(workspaceRoot, manifestPath),
    )).replace(/\\/g, "/"),
    String(path.relative(
      path.resolve(workspaceRoot),
      path.resolve(workspaceRoot, truthPath),
    )).replace(/\\/g, "/"),
  ]);
  const lineageMutableKey = (sourcePath) => (
    sourcePath.endsWith("/manifest.csv") || sourcePath === "manifest.csv"
      ? "manifestSha256"
      : "truthSha256"
  );
  const stageASignoffLineageBaseCurrent = Boolean(
    stageASignoffLineage?.contract === ROUND6_STAGE_A_SIGNOFF_LINEAGE_VERSION
      && stageASignoffLineage?.stagedProtocol?.protocolSemanticSha256
        === stagedProtocol?.protocolSemanticSha256
      && stageASignoffLineage?.studentFacing === false
      && stageASignoffLineage?.automaticAuthorizationGranted === false
  );
  const stagedProtocolBindingPathSetCurrent = sameStringSet(
    observedStagedProtocolBindings.map((row) => row.path),
    P3_MINIMAL_RECORDING_REQUIRED_SOURCE_PATHS,
  );
  const stagedProtocolSourceBindingsCurrent = Boolean(
    stagedProtocolBindingPathSetCurrent
      && observedStagedProtocolBindings.every((row) => {
        if (
          !row.path
          || !/^[a-f0-9]{64}$/.test(row.expectedSha256)
          || !/^[a-f0-9]{64}$/.test(row.observedSha256)
        ) {
          return false;
        }
        if (row.observedSha256 === row.expectedSha256) return true;
        if (!mutableStagedPaths.has(row.path) || !stageASignoffLineageBaseCurrent) {
          return false;
        }
        const key = lineageMutableKey(row.path);
        return (
          stageASignoffLineage?.sourceHashes?.[key] === row.expectedSha256
            && stageASignoffLineage?.appliedHashes?.[key] === row.observedSha256
        );
      }),
  );
  const evaluationProtocolSha256 = await hashBoundText(
    evaluationProtocolPath,
    "lf-normalized-sha256",
  );
  const evaluationBindings = Array.isArray(evaluationProtocol?.sourceBindings)
    ? evaluationProtocol.sourceBindings : [];
  const observedEvaluationBindings = await Promise.all(
    evaluationBindings.map(async (binding) => ({
      role: String(binding?.role || ""),
      path: String(binding?.path || "").replace(/\\/g, "/"),
      hashMode: String(binding?.hashMode || ""),
      expectedSha256: String(binding?.sha256 || "").toLowerCase(),
      observedSha256: await hashBoundText(binding?.path, binding?.hashMode),
    })),
  );
  const requiredEvaluationRoles = [
    "execution-guard",
    "candidate-runner",
    "feature-extractor",
    "temporal-operation-policy",
    "intake-validator",
    "audio-feature-analyzer",
    "round6-contract",
  ];
  const observedEvaluationRoles = observedEvaluationBindings.map((row) => row.role);
  const evaluationSourcesCurrent = Boolean(
    observedEvaluationBindings.length === requiredEvaluationRoles.length
      && new Set(observedEvaluationRoles).size === observedEvaluationRoles.length
      && sameStringSet(observedEvaluationRoles, requiredEvaluationRoles)
      && observedEvaluationBindings.every((row) => (
        /^[a-f0-9]{64}$/.test(row.expectedSha256)
          && row.observedSha256 === row.expectedSha256
      )),
  );
  const evaluation = evaluationProtocol?.evaluation || {};
  const evaluationCandidate = evaluationProtocol?.candidate || {};
  const evaluationProtocolValid = Boolean(
    evaluationProtocol?.contractVersion === ROUND6_EVALUATION_PROTOCOL_VERSION
      && evaluationProtocol?.status === "pre-registered-before-audio"
      && evaluation?.calibrationSplit === "calibration"
      && evaluation?.freshBlindSplit === "fresh-blind"
      && evaluation?.freshBlindRunLimit === 1
      && evaluation?.freshUsedForSelection === false
      && evaluation?.decisionThreshold === 0.5
      && sameStringSet(evaluation?.gates, ROUND5_SEGMENT_GATES)
      && evaluation?.promotionThresholds?.minPrecision === 0.9
      && evaluation?.promotionThresholds?.minRecall === 0.5
      && evaluation?.promotionThresholds?.maxStrictFalseAccusations === 0
      && evaluation?.promotionScope === "independent-per-gate"
      && evaluation?.completeInventoryRequired === true
      && evaluation?.scorePositionCounterbalanceRequired === true
      && evaluationCandidate?.sourceContract
        === "western-round6-full-score-candidate-v2"
      && evaluationCandidate?.modelFamily
        === "full-score-performance-only-random-forest-binary-per-gate"
      && evaluationCandidate?.featurePolicy
        === "alignment-performance-only-no-fixed-acoustic-v1"
      && JSON.stringify(evaluationCandidate?.excludedScoreContextFeatures)
        === JSON.stringify([
          "n_0OutOfRange",
          "n_m1OutOfRange",
          "n_m2OutOfRange",
          "n_p1OutOfRange",
          "n_p2OutOfRange",
          "scoreNextInterval",
          "scorePreviousInterval",
        ])
      && JSON.stringify(evaluationCandidate?.excludedFixedAcousticFeatures)
        === JSON.stringify([
          "acousticAvailable",
          "targetInteriorAttackRatio",
          "targetMeanVoicedProbability",
          "targetNearPitchOccupancy",
          "targetOnsetMax",
          "targetOnsetMean",
          "targetOnsetPeakCount",
          "targetPeakDb",
          "targetPitchOccupancy",
          "targetRmsDb",
          "targetVoicedFrameRatio",
        ])
      && JSON.stringify(evaluationCandidate?.requiredTemporalFeatures)
        === JSON.stringify([
          "n_0AssignmentGap",
          "n_0DurationMissing",
          "n_0DurationRatio",
          "n_0IoiDeviation",
          "n_0IoiMissing",
          "segmentMaxIoiDeviation",
          "segmentMeanIoiDeviation",
          "targetWindowEventCount",
        ])
      && evaluationCandidate?.strictFalseAccusationDenominator
        === "every fresh score position not signed positive for the evaluated gate"
      && JSON.stringify(evaluationCandidate?.modelParams) === JSON.stringify({
        n_estimators: 256,
        max_depth: 4,
        min_samples_leaf: 2,
        class_weight: "balanced_subsample",
        random_state: 20260722,
        n_jobs: 1,
      })
      && JSON.stringify(evaluationCandidate?.frozenRuleContracts) === JSON.stringify({
        gapRefinement: "western-round5-frozen-gap-refinement-v1",
        gapStrict: "western-round5-frozen-gap-strict-issue-candidate-v1",
        rhythmRefinement: "western-round5-frozen-rhythm-structural-refinement-v1",
        rhythmStrict: "western-round5-frozen-rhythm-strict-issue-candidate-v1",
      })
      && JSON.stringify(evaluationCandidate?.allowedCandidateFamilies) === JSON.stringify([
        "full-score-performance-only-random-forest-binary-per-gate",
        "frozen-gap-refinement-self-check",
        "frozen-gap-strict-missing",
        "frozen-rhythm-structural-self-check",
        "frozen-rhythm-strict-extra-drag",
      ])
      && evaluationCandidate?.postFreshRetuningAllowed === false
      && evaluationProtocol?.interpretation?.failedOrCrashedFreshRunMayNotBeRepeated === true
      && evaluationProtocol?.interpretation?.newCandidateAfterFreshRequiresNewUntouchedPackage
        === true
      && evaluationProtocol?.interpretation?.numericPassIsEvidenceNotReleaseAuthorization
        === true
      && evaluationProtocol?.interpretation?.partialGatePassDoesNotAuthorizeOtherGates
        === true
      && evaluationProtocol?.studentFacing === false
      && evaluationProtocol?.automaticAuthorizationGranted === false
      && evaluationSourcesCurrent,
  );
  const evaluationRunnerReady = evaluationProtocolValid && Boolean(evaluationProtocolSha256);
  const consumedLedgerPath = String(
    evaluationProtocol?.paths?.consumedLedger || "",
  );
  const consumedLedger = consumedLedgerPath
    ? await readJson(path.resolve(workspaceRoot, consumedLedgerPath))
    : null;
  const consumedLedgerExists = consumedLedgerPath
    ? await exists(path.resolve(workspaceRoot, consumedLedgerPath))
    : false;
  const freshBlindConsumed = Boolean(
    consumedLedgerExists
      || consumedLedger?.freshBlindConsumed === true
      || evaluationReport?.freshBlindConsumed === true,
  );
  const evaluationReportBindingCurrent = Boolean(
    evaluationReport
      && evaluationProtocolSha256
      && evaluationReport?.protocol === ROUND6_EVALUATION_PROTOCOL_VERSION
      && evaluationReport?.protocolSha256 === evaluationProtocolSha256
      && evaluationReport?.sourceHashes?.contractSha256 === contractSha256
      && evaluationReport?.sourceHashes?.manifestSha256 === manifestSha256
      && evaluationReport?.sourceHashes?.truthSha256 === truthSha256,
  );
  const evaluationPerformed = Boolean(
    freshBlindConsumed
      && evaluationReportBindingCurrent
      && evaluationReport?.evaluationPerformed === true
      && evaluationReport?.promotionEvidenceEligible === true,
  );
  const truthRecordings = truth?.recordings && typeof truth.recordings === "object"
    ? Object.entries(truth.recordings)
    : [];
  const manifestByRecording = new Map(
    manifestRows.map((row) => [String(row.recordingId || ""), row]),
  );
  const manifestIds = manifestRows.map((row) => String(row.recordingId || ""));
  const truthIds = truthRecordings.map(([recordingId]) => recordingId);
  const recordingIdsMatch = manifestIds.length > 0
    && new Set(manifestIds).size === manifestIds.length
    && sameStringSet(manifestIds, truthIds);
  const countsForGates = () => Object.fromEntries(
    ROUND5_SEGMENT_GATES.map((gate) => [gate, 0]),
  );
  const positiveByGate = countsForGates();
  const confusionNegativeByGate = countsForGates();
  const freshBlindPositiveByGate = countsForGates();
  const freshBlindConfusionNegativeByGate = countsForGates();
  let truthEventCount = 0;
  let signedEventCount = 0;
  let completeInventoryCount = 0;
  let eventSchemaValid = truth?.contractVersion === ROUND6_COUNTERBALANCED_CONTRACT_VERSION;
  for (const [recordingId, recording] of truthRecordings) {
    const row = manifestByRecording.get(recordingId);
    const split = String(row?.split || "");
    const events = Array.isArray(recording?.events) ? recording.events : [];
    if (recording?.completeErrorInventory === true) completeInventoryCount += 1;
    for (const event of events) {
      truthEventCount += 1;
      if (String(event?.asPerformed || "").trim()) signedEventCount += 1;
      const gate = String(event?.gate || "");
      const label = String(event?.label || "");
      if (!ROUND5_SEGMENT_GATES.includes(gate)
          || !["positive", "confusion_negative"].includes(label)
          || !["calibration", "fresh-blind"].includes(split)) {
        eventSchemaValid = false;
        continue;
      }
      if (label === "positive") {
        positiveByGate[gate] += 1;
        if (split === "fresh-blind") freshBlindPositiveByGate[gate] += 1;
      } else {
        confusionNegativeByGate[gate] += 1;
        if (split === "fresh-blind") freshBlindConfusionNegativeByGate[gate] += 1;
      }
    }
  }
  const uniqueCount = (field) => new Set(
    manifestRows.map((row) => String(row[field] || "")).filter(Boolean),
  ).size;
  const calibrationRows = manifestRows.filter((row) => row.split === "calibration");
  const freshRows = manifestRows.filter((row) => row.split === "fresh-blind");
  const valuesDisjoint = (leftRows, rightRows, field) => {
    const left = new Set(leftRows.map((row) => String(row[field] || "")).filter(Boolean));
    return rightRows.every((row) => !left.has(String(row[field] || "")));
  };
  const stagedDecision = stagedProtocol?.recordingDecision || {};
  const stagedStageA = stagedProtocol?.stageA || {};
  const stagedStageB = stagedProtocol?.stageB || {};
  const stagedStageAIds = Array.isArray(stagedStageA?.recordingIds)
    ? stagedStageA.recordingIds.map(String) : [];
  const stagedStageBIds = Array.isArray(stagedStageB?.recordingIds)
    ? stagedStageB.recordingIds.map(String) : [];
  const calibrationIds = calibrationRows.map(
    (row) => String(row.recordingId || ""),
  );
  const freshIds = freshRows.map((row) => String(row.recordingId || ""));
  const stagedProtocolValid = Boolean(
    stagedProtocol?.contract === P3_MINIMAL_RECORDING_PROTOCOL_VERSION
      && stagedProtocolSemanticHashCurrent
      && stagedProtocolSourceBindingsCurrent
      && Number(stagedDecision.minimumUnavoidableNewRecordingsNow) === 6
      && Number(stagedDecision.conditionalAdditionalFreshRecordings) === 6
      && Number(stagedDecision.maximumTotalIfStageAPasses) === 12
      && stagedDecision.recordAllTwelveNow === false
      && Number(stagedStageA.recordingCount) === 6
      && Number(stagedStageB.recordingCount) === 6
      && sameStringSet(stagedStageAIds, calibrationIds)
      && sameStringSet(stagedStageBIds, freshIds)
      && stagedStageB.authorizedOnlyAfterStageAPass === true
      && stagedStageA.cleanSafetyInputsRemainFrozen === true
      && stagedStageA.cleanSafetyLimits
        ?.authoritativeLocalCleanFalsePositiveMax === 0
      && stagedStageA.cleanSafetyLimits
        ?.consumedRound5KnownNegativeFalsePositiveMax === 0
      && stagedStageA.cleanSafetyLimits
        ?.publicProfessionalBurdenPooledPer1000Max === 5
      && stagedStageA.cleanSafetyLimits
        ?.publicProfessionalBurdenAnyRecordingPer1000Max === 10
      && stagedStageA.candidate?.modelFamily === evaluationCandidate?.modelFamily
      && stagedStageA.candidate?.featurePolicy
        === evaluationCandidate?.featurePolicy
      && stagedStageA.candidate?.decisionThreshold === evaluation?.decisionThreshold
      && JSON.stringify(stagedStageA.candidate?.modelParams)
        === JSON.stringify(evaluationCandidate?.modelParams)
      && stagedProtocol?.discipline?.round4Round5ReusedAsAcceptance === false
      && stagedProtocol?.discipline?.freshReadDuringStageA === false
      && stagedProtocol?.discipline?.retuneAfterCleanSafety === false
      && stagedProtocol?.discipline?.retuneAfterFresh === false
      && stagedProtocol?.discipline?.studentSwitchesRemainFalse === true
      && stagedProtocol?.discipline?.failClosed === true
      && stagedProtocol?.stopLines?.m4Omr === "no-further-investment"
      && stagedProtocol?.stopLines?.waveformEnergyMissingNote
        === "no-further-investment"
      && stagedProtocol?.supersession?.priorAllAtOnceRound6Scheduling
        === "deferred"
      && stagedProtocol?.supersession?.technicalTwelveTakePackRemainsValid
        === true
      && stagedProtocol?.supersession?.currentAuthorizedRecordingScope
        === "stage-a-calibration-six-only"
      && stagedStageA.operations?.truthSignoffPackCommand
        === "npm run western:round6-stage-a-truth-signoff-pack"
      && stagedStageA.operations?.truthSignoffApplyCommand
        === (
          "npm run western:round6-stage-a-truth-signoff-apply -- "
          + "--completed <path> --apply"
        )
      && stagedStageA.operations?.positionBalanceCommand
        === "npm run western:round6-position-balance"
      && stagedStageA.operations?.safetyPreflightCommand
        === "npm run western:round6-stage-a-safety-preflight"
      && stagedStageA.operations?.safetyEvaluationCommand
        === "npm run western:round6-stage-a-safety-eval"
      && stagedStageA.operations?.safetyEvaluatorContract
        === ROUND6_STAGE_A_SAFETY_VERSION
      && stagedStageA.operations?.signoffLineagePath
        === String(ROUND6_STAGE_A_SIGNOFF_LINEAGE).replace(/\\/g, "/")
      && stagedStageA.operations?.safetyConsumedLedgerPath
        === String(ROUND6_STAGE_A_SAFETY_CONSUMED).replace(/\\/g, "/")
      && stagedStageA.operations?.safetyReportPath
        === String(ROUND6_STAGE_A_SAFETY_REPORT).replace(/\\/g, "/")
      && stagedStageA.operations?.modelPath
        === String(ROUND6_STAGE_A_SAFETY_MODEL).replace(/\\/g, "/")
      && stagedStageA.operations?.freshAudioMustBeAbsent === true
      && stagedStageA.operations?.cleanSafetyMayBeConsumedOnce === true
  );
  const stagedManifestBinding = stagedBindingByPath.get(
    [...mutableStagedPaths].find(
      (sourcePath) => lineageMutableKey(sourcePath) === "manifestSha256",
    ),
  );
  const stagedTruthBinding = stagedBindingByPath.get(
    [...mutableStagedPaths].find(
      (sourcePath) => lineageMutableKey(sourcePath) === "truthSha256",
    ),
  );
  const stageALineageAudioHashes = (
    stageASignoffLineage?.audioSha256ByRecording || {}
  );
  const stageASignoffLineageCurrent = Boolean(
    stageASignoffLineageBaseCurrent
      && stageASignoffLineage?.scope?.split === "calibration"
      && sameStringSet(
        stageASignoffLineage?.scope?.recordingIds,
        stagedStageAIds,
      )
      && stageASignoffLineage?.stagedProtocol?.path
        === String(stagedProtocolPath).replace(/\\/g, "/")
      && stageASignoffLineage?.stagedProtocol?.sha256
        === stagedProtocolSha256
      && stageASignoffLineage?.sourceHashes?.contractSha256
        === contractSha256
      && stageASignoffLineage?.sourceHashes?.manifestSha256
        === stagedManifestBinding?.expectedSha256
      && stageASignoffLineage?.sourceHashes?.truthSha256
        === stagedTruthBinding?.expectedSha256
      && stageASignoffLineage?.appliedHashes?.manifestSha256
        === manifestSha256
      && stageASignoffLineage?.appliedHashes?.truthSha256
        === truthSha256
      && /^[a-f0-9]{64}$/.test(
        String(stageASignoffLineage?.sourceHashes?.completedSha256 || ""),
      )
      && sameStringSet(
        Object.keys(stageALineageAudioHashes),
        stagedStageAIds,
      )
      && Object.values(stageALineageAudioHashes).every(
        (value) => /^[a-f0-9]{64}$/.test(String(value || "")),
      )
  );
  const recordingsPerPiece = {};
  for (const row of manifestRows) {
    const pieceId = String(row.pieceId || "");
    recordingsPerPiece[pieceId] = (recordingsPerPiece[pieceId] || 0) + 1;
  }
  const gateCountsReady = ROUND5_SEGMENT_GATES.every((gate) => (
    positiveByGate[gate] >= frozenMinimums.positivePerGate
      && freshBlindPositiveByGate[gate] >= frozenMinimums.freshBlindPositivePerGate
      && confusionNegativeByGate[gate] >= frozenMinimums.confusionNegativePerGate
      && freshBlindConfusionNegativeByGate[gate]
        >= frozenMinimums.freshBlindConfusionNegativePerGate
  ));
  const designCountsReady = Boolean(
    recordingIdsMatch
      && eventSchemaValid
      && uniqueCount("performerId") >= frozenMinimums.performers
      && uniqueCount("deviceId") >= frozenMinimums.devices
      && uniqueCount("roomId") >= frozenMinimums.rooms
      && calibrationRows.length > 0
      && freshRows.length > 0
      && valuesDisjoint(calibrationRows, freshRows, "pieceId")
      && valuesDisjoint(calibrationRows, freshRows, "performerId")
      && Object.keys(recordingsPerPiece).every(Boolean)
      && Object.values(recordingsPerPiece).every(
        (count) => count === contract?.positionDesign?.recordingsPerScore,
      )
      && gateCountsReady
  );
  const present = async (filePath) => Boolean(
    String(filePath || "").trim() && await exists(filePath),
  );
  const materialRows = await Promise.all(manifestRows.map(async (row) => ({
    recordingId: row.recordingId,
    audioPath: row.audioPath,
    score: await present(row.scorePath),
    pdf: await present(path.join(materialsRoot, `${row.recordingId}.pdf`)),
    instructions: await present(
      path.join(materialsRoot, `${row.recordingId}-演奏说明.md`),
    ),
    audio: await present(row.audioPath),
    consent: String(row.consent || "").trim().toLowerCase()
      === String(contract?.privacy?.requiredConsent || "").toLowerCase(),
    license: String(row.licenseStatus || "").trim().toLowerCase()
      === String(contract?.privacy?.requiredLicenseStatus || "").toLowerCase(),
  })));
  const countMaterial = (field) => materialRows.filter((row) => row[field] === true).length;
  const scoreFileCount = countMaterial("score");
  const pdfCount = countMaterial("pdf");
  const instructionCount = countMaterial("instructions");
  const audioFileCount = countMaterial("audio");
  const consentCount = countMaterial("consent");
  const licenseCount = countMaterial("license");
  const materialsReady = manifestRows.length > 0
    && scoreFileCount === manifestRows.length
    && pdfCount === manifestRows.length
    && instructionCount === manifestRows.length;
  const stageAIdSet = new Set(stagedStageAIds);
  const stageAMaterialRows = materialRows.filter(
    (row) => stageAIdSet.has(String(row.recordingId || "")),
  );
  const countStageAMaterial = (field) => (
    stageAMaterialRows.filter((row) => row[field] === true).length
  );
  const stageATruthRecordings = truthRecordings.filter(
    ([recordingId]) => stageAIdSet.has(recordingId),
  );
  const stageATruthEventCount = stageATruthRecordings.reduce(
    (sum, [, recording]) => sum + (
      Array.isArray(recording?.events) ? recording.events.length : 0
    ),
    0,
  );
  const stageASignedEventCount = stageATruthRecordings.reduce(
    (sum, [, recording]) => sum + (
      Array.isArray(recording?.events)
        ? recording.events.filter(
          (event) => String(event?.asPerformed || "").trim(),
        ).length
        : 0
    ),
    0,
  );
  const stageACompleteInventoryCount = stageATruthRecordings.filter(
    ([, recording]) => recording?.completeErrorInventory === true,
  ).length;
  const stageAAudioFileCount = countStageAMaterial("audio");
  const stageAConsentCount = countStageAMaterial("consent");
  const stageALicenseCount = countStageAMaterial("license");
  const stageAAudioBindingsCurrent = Boolean(
    stageASignoffLineageCurrent
      && (
        await Promise.all(stageAMaterialRows.map(async (row) => (
          row.audio === true
            && await sha256FileOrEmpty(row.audioPath)
              === stageALineageAudioHashes[row.recordingId]
        )))
      ).every(Boolean)
  );
  const stageARecordingComplete = Boolean(
    stagedProtocolValid
      && stageASignoffLineageCurrent
      && stageAAudioBindingsCurrent
      && stageAMaterialRows.length === 6
      && stageATruthRecordings.length === 6
      && stageATruthEventCount === 72
      && stageAAudioFileCount === 6
      && stageAConsentCount === 6
      && stageALicenseCount === 6
      && stageASignedEventCount === stageATruthEventCount
      && stageACompleteInventoryCount === stageATruthRecordings.length
  );
  const stageBIdSet = new Set(stagedStageBIds);
  const stageBMaterialRows = materialRows.filter(
    (row) => stageBIdSet.has(String(row.recordingId || "")),
  );
  const countStageBMaterial = (field) => (
    stageBMaterialRows.filter((row) => row[field] === true).length
  );
  const stageBTruthRecordings = truthRecordings.filter(
    ([recordingId]) => stageBIdSet.has(recordingId),
  );
  const stageBTruthEventCount = stageBTruthRecordings.reduce(
    (sum, [, recording]) => sum + (
      Array.isArray(recording?.events) ? recording.events.length : 0
    ),
    0,
  );
  const stageBSignedEventCount = stageBTruthRecordings.reduce(
    (sum, [, recording]) => sum + (
      Array.isArray(recording?.events)
        ? recording.events.filter(
          (event) => String(event?.asPerformed || "").trim(),
        ).length
        : 0
    ),
    0,
  );
  const stageBCompleteInventoryCount = stageBTruthRecordings.filter(
    ([, recording]) => recording?.completeErrorInventory === true,
  ).length;
  const stageBAudioFileCount = countStageBMaterial("audio");
  const stageBConsentCount = countStageBMaterial("consent");
  const stageBLicenseCount = countStageBMaterial("license");
  const positionHashes = positionBalance?.sourceHashes || {};
  const positionBindingCurrent = Boolean(
    positionBalance
      && manifestSha256
      && truthSha256
      && String(positionHashes.manifestSha256 || "").toLowerCase() === manifestSha256
      && String(positionHashes.truthSha256 || "").toLowerCase() === truthSha256,
  );
  const positionValid = Boolean(
    positionBalance?.contract === "western-round5-position-balance-preflight-v2"
      && positionBalance?.evidenceRole === "pre-recording-position-balance-only"
      && positionBindingCurrent
      && positionBalance?.readyForRecording === true
      && positionBalance?.audioRead === false
      && positionBalance?.promotionEvidenceEligible === false
      && positionBalance?.automaticAccusationReady === false
      && positionBalance?.studentFacing === false
      && Array.isArray(positionBalance?.confoundedSplitGates)
      && positionBalance.confoundedSplitGates.length === 0
      && Array.isArray(positionBalance?.rhythmReviewHint?.confoundedSplits)
      && positionBalance.rhythmReviewHint.confoundedSplits.length === 0
      && Array.isArray(positionBalance?.blockingReasons)
      && positionBalance.blockingReasons.length === 0,
  );
  const intakeHashes = intake?.hashes || {};
  const intakeBindingCurrent = Boolean(
    intake
      && contractSha256
      && manifestSha256
      && truthSha256
      && String(intakeHashes.contractSha256 || "").toLowerCase() === contractSha256
      && String(intakeHashes.manifestSha256 || "").toLowerCase() === manifestSha256
      && String(intakeHashes.truthSha256 || "").toLowerCase() === truthSha256,
  );
  const recordingComplete = manifestRows.length > 0
    && audioFileCount === manifestRows.length
    && consentCount === manifestRows.length
    && licenseCount === manifestRows.length
    && signedEventCount === truthEventCount
    && completeInventoryCount === truthRecordings.length;
  const readyForRecording = Boolean(
    contractValid
      && designCountsReady
      && materialsReady
      && positionValid
      && evaluationRunnerReady
  );
  const intakeReady = Boolean(
    readyForRecording
      && recordingComplete
      && intakeBindingCurrent
      && intake?.contractVersion === ROUND6_COUNTERBALANCED_CONTRACT_VERSION
      && intake?.ready === true
      && intake?.studentFacing === false
      && intake?.automaticAuthorizationGranted === false
      && Array.isArray(intake?.blockingReasons)
      && intake.blockingReasons.length === 0
  );
  const positionBalanceSha256 = await sha256FileOrEmpty(positionBalancePath);
  const expectedStageASafetySourceHashes = {
    protocolSha256: stagedProtocolSha256,
    protocolSemanticSha256: String(
      stagedProtocol?.protocolSemanticSha256 || "",
    ),
    contractSha256,
    manifestSha256,
    truthSha256,
    positionBalanceSha256,
    signoffLineageSha256: stageASignoffLineageSha256,
  };
  const stageASafetySourceHashesCurrent = (sourceHashes) => (
    sourceHashes
      && Object.entries(expectedStageASafetySourceHashes).every(
        ([key, expected]) => (
          /^[a-f0-9]{64}$/.test(String(expected || ""))
            && sourceHashes[key] === expected
        ),
      )
  );
  const expectedStageASafetyModelPath = String(path.relative(
    path.resolve(workspaceRoot),
    path.resolve(workspaceRoot, stageASafetyModelPath),
  )).replace(/\\/g, "/");
  const stageASafetyConsumedCurrent = Boolean(
    stageASafetyConsumedSha256
      && stageASafetyConsumed?.contract
        === ROUND6_STAGE_A_SAFETY_CONSUMED_VERSION
      && stageASafetyConsumed?.p3ProtocolSemanticSha256
        === stagedProtocol?.protocolSemanticSha256
      && stageASafetySourceHashesCurrent(stageASafetyConsumed?.sourceHashes)
      && stageASafetyConsumed?.modelSha256 === stageASafetyModelSha256
      && stageASafetyConsumed?.cleanSafetyConsumed === true
      && stageASafetyConsumed?.freshAudioRead === false
      && stageASafetyConsumed?.studentFacing === false
      && stageASafetyConsumed?.automaticAuthorizationGranted === false
  );
  const stageASafetyAttemptCurrent = Boolean(
    stageASafetyReportSha256
      && stageASafetyReport?.contract === ROUND6_STAGE_A_SAFETY_VERSION
      && stageASafetyReport?.p3ProtocolSemanticSha256
        === stagedProtocol?.protocolSemanticSha256
      && stageASafetySourceHashesCurrent(stageASafetyReport?.sourceHashes)
      && stageASafetyConsumedCurrent
      && stageASafetyReport?.executionRequested === true
      && stageASafetyReport?.trainingPerformed === true
      && stageASafetyReport?.modelArtifact?.path
        === expectedStageASafetyModelPath
      && stageASafetyReport?.modelArtifact?.sha256
        === stageASafetyModelSha256
      && stageASafetyReport?.freshAudioRead === false
      && stageASafetyReport?.strictConfirmedRecall === "2/12"
      && stageASafetyReport?.studentFacing === false
      && stageASafetyReport?.automaticAuthorizationGranted === false
  );
  const stageASafetyEvaluationPerformed = Boolean(
    stageASafetyAttemptCurrent
      && stageASafetyReport?.cleanSafetyEvaluationPerformed === true
  );
  const stageASafetyEvaluationPassed = Boolean(
    stageASafetyEvaluationPerformed
      && stageASafetyReport?.stageAPassed === true
      && stageASafetyReport?.stageBFreshRecordingAuthorized === true
      && Array.isArray(stageASafetyReport?.safetyLimitViolations)
      && stageASafetyReport.safetyLimitViolations.length === 0
      && Array.isArray(stageASafetyReport?.blockingReasons)
      && stageASafetyReport.blockingReasons.length === 0
      && canonicalJson(stageASafetyReport?.cleanSafetyLimits)
        === canonicalJson(stagedStageA.cleanSafetyLimits)
  );
  const stageASafetyAttemptFailedClosed = Boolean(
    stageASafetyConsumedSha256 && !stageASafetyEvaluationPassed
  );
  const stageARecordingAuthorizedNow = Boolean(
    stagedProtocolValid
      && readyForRecording
      && !stageARecordingComplete
      && !stageASafetyConsumedSha256
      && !freshBlindConsumed
  );
  const stageBFreshRecordingAuthorizedNow = Boolean(
    stagedProtocolValid
      && stageARecordingComplete
      && stageASafetyEvaluationPassed
      && !freshBlindConsumed
  );
  const emptyExternalInput = {
    audioFiles: 0,
    consentRows: 0,
    licenseRows: 0,
    signedEvents: 0,
    completeInventories: 0,
  };
  const stageAExternalInput = {
    audioFiles: Math.max(0, 6 - stageAAudioFileCount),
    consentRows: Math.max(0, 6 - stageAConsentCount),
    licenseRows: Math.max(0, 6 - stageALicenseCount),
    signedEvents: Math.max(0, stageATruthEventCount - stageASignedEventCount),
    completeInventories: Math.max(
      0,
      stageATruthRecordings.length - stageACompleteInventoryCount,
    ),
  };
  const stageBExternalInput = {
    audioFiles: Math.max(0, 6 - stageBAudioFileCount),
    consentRows: Math.max(0, 6 - stageBConsentCount),
    licenseRows: Math.max(0, 6 - stageBLicenseCount),
    signedEvents: Math.max(0, stageBTruthEventCount - stageBSignedEventCount),
    completeInventories: Math.max(
      0,
      stageBTruthRecordings.length - stageBCompleteInventoryCount,
    ),
  };
  const currentStageExternalInput = stageBFreshRecordingAuthorizedNow
    ? stageBExternalInput
    : stageARecordingAuthorizedNow
      ? stageAExternalInput
      : emptyExternalInput;
  const currentAuthorizedRecordingScope = stageBFreshRecordingAuthorizedNow
    ? "stage-b-fresh-six-only"
    : stageARecordingAuthorizedNow
      ? "stage-a-calibration-six-only"
      : "none";
  const designBlockingReasons = normalizedReasonList([
    ...(!contract ? ["round6-counterbalanced-contract-missing"] : []),
    ...(contract && !contractValid ? ["round6-counterbalanced-contract-invalid"] : []),
    ...(!recordingIdsMatch ? ["round6-counterbalanced-recording-identity-mismatch"] : []),
    ...(!designCountsReady ? ["round6-counterbalanced-design-counts-not-ready"] : []),
    ...(!materialsReady ? ["round6-counterbalanced-materials-not-ready"] : []),
    ...(!evaluationProtocol ? ["round6-evaluation-protocol-missing"] : []),
    ...(evaluationProtocol && !evaluationProtocolValid
      ? ["round6-evaluation-protocol-not-current"]
      : []),
    ...(!positionBalance ? ["round6-counterbalanced-position-report-missing"] : []),
    ...(positionBalance && !positionBindingCurrent
      ? ["round6-counterbalanced-position-binding-stale"]
      : []),
    ...(positionBalance && !positionValid
      ? ["round6-counterbalanced-position-preflight-not-ready"]
      : []),
  ]);
  const recordingBlockingReasons = normalizedReasonList([
    ...(!intake ? ["round6-counterbalanced-intake-report-missing"] : []),
    ...(intake && !intakeBindingCurrent
      ? ["round6-counterbalanced-intake-binding-stale"]
      : []),
    ...(audioFileCount < manifestRows.length
      ? [`round6-counterbalanced-audio-pending:${manifestRows.length - audioFileCount}`]
      : []),
    ...(consentCount < manifestRows.length
      ? [`round6-counterbalanced-consent-pending:${manifestRows.length - consentCount}`]
      : []),
    ...(licenseCount < manifestRows.length
      ? [`round6-counterbalanced-license-pending:${manifestRows.length - licenseCount}`]
      : []),
    ...(signedEventCount < truthEventCount
      ? [`round6-counterbalanced-as-performed-pending:${truthEventCount - signedEventCount}`]
      : []),
    ...(completeInventoryCount < truthRecordings.length
      ? [
          `round6-counterbalanced-complete-inventory-pending:${
            truthRecordings.length - completeInventoryCount
          }`,
        ]
      : []),
  ]);
  const evaluationBlockingReasons = normalizedReasonList([
    ...(!evaluationRunnerReady ? ["round6-evaluation-runner-not-ready"] : []),
    ...(intakeReady && !freshBlindConsumed
      ? ["round6-fresh-blind-evaluation-pending"]
      : []),
    ...(freshBlindConsumed && !evaluationPerformed
      ? ["round6-fresh-blind-consumed-without-current-completed-report"]
      : []),
  ]);
  const schedulingBlockingReasons = normalizedReasonList([
    ...(!stagedProtocol ? ["p3-staged-recording-protocol-missing"] : []),
    ...(stagedProtocol && !stagedProtocolSemanticHashCurrent
      ? ["p3-staged-recording-protocol-semantic-hash-stale"]
      : []),
    ...(stagedProtocol && !stagedProtocolSourceBindingsCurrent
      ? ["p3-staged-recording-protocol-source-binding-stale"]
      : []),
    ...(stagedProtocol && !stagedProtocolValid
      ? ["p3-staged-recording-protocol-invalid"]
      : []),
    ...(!readyForRecording
      ? ["round6-technical-capture-pack-not-ready"]
      : []),
    ...(stageARecordingComplete
      && !stageASafetyConsumedSha256
      && !stageASafetyEvaluationPassed
      ? ["round6-stage-a-clean-safety-evaluation-pending"]
      : []),
    ...(stageASafetyConsumedSha256 && !stageASafetyConsumedCurrent
      ? ["round6-stage-a-clean-safety-consumed-ledger-stale"]
      : []),
    ...(stageASafetyConsumedCurrent && !stageASafetyAttemptCurrent
      ? ["round6-stage-a-clean-safety-report-stale-or-crashed"]
      : []),
    ...(stageASafetyAttemptCurrent && !stageASafetyEvaluationPassed
      ? ["round6-stage-a-clean-safety-failed-stop"]
      : []),
  ]);
  return {
    contract: ROUND6_COUNTERBALANCED_CONTRACT_VERSION,
    source: String(intakePath).replace(/\\/g, "/"),
    paths: {
      contract: String(contractPath).replace(/\\/g, "/"),
      manifest: String(manifestPath).replace(/\\/g, "/"),
      truth: String(truthPath).replace(/\\/g, "/"),
      positionBalance: String(positionBalancePath).replace(/\\/g, "/"),
      evaluationProtocol: String(evaluationProtocolPath).replace(/\\/g, "/"),
      evaluationReport: String(evaluationReportPath).replace(/\\/g, "/"),
      stagedProtocol: String(stagedProtocolPath).replace(/\\/g, "/"),
      stageASignoffLineage:
        String(stageASignoffLineagePath).replace(/\\/g, "/"),
      stageASafetyReport:
        String(stageASafetyReportPath).replace(/\\/g, "/"),
      stageASafetyModel:
        String(stageASafetyModelPath).replace(/\\/g, "/"),
      stageASafetyConsumed:
        String(stageASafetyConsumedPath).replace(/\\/g, "/"),
    },
    contractValid,
    bindingCurrent: positionBindingCurrent && intakeBindingCurrent && evaluationRunnerReady,
    bindings: {
      positionBalance: positionBindingCurrent,
      intake: intakeBindingCurrent,
      evaluationProtocol: evaluationRunnerReady,
      stagedProtocol: stagedProtocolValid,
      stageASignoffLineage: stageASignoffLineageCurrent,
      stageASafetyConsumed: stageASafetyConsumedCurrent,
      stageASafetyReport: stageASafetyAttemptCurrent,
    },
    designCountsReady,
    materialsReady,
    readyForRecording,
    readyForRecordingMeaning:
      "technical-twelve-take-pack-ready-not-all-at-once-scheduling-authority",
    intakeReady,
    recordingComplete,
    recordingSchedule: {
      contract: P3_MINIMAL_RECORDING_PROTOCOL_VERSION,
      source: String(stagedProtocolPath).replace(/\\/g, "/"),
      valid: stagedProtocolValid,
      semanticHashCurrent: stagedProtocolSemanticHashCurrent,
      sourceBindingsCurrent: stagedProtocolSourceBindingsCurrent,
      protocolSemanticSha256: String(
        stagedProtocol?.protocolSemanticSha256 || "",
      ),
      observedProtocolSemanticSha256: observedStagedProtocolSemanticSha256,
      currentAuthorizedRecordingScope,
      minimumUnavoidableRecordingsNow: 6,
      conditionalAdditionalFreshRecordings: 6,
      maximumConditionalTotal: 12,
      recordAllTwelveNow: false,
      allTwelveRecordingAuthorizedNow: false,
      stageARecordingAuthorizedNow,
      stageARecordingIds: stagedStageAIds,
      stageARecordingComplete,
      stageASignoffLineageCurrent,
      stageAAudioBindingsCurrent,
      stageASafetyConsumedCurrent,
      stageASafetyAttemptCurrent,
      stageASafetyEvaluationPerformed,
      stageASafetyEvaluationPassed,
      stageASafetyAttemptFailedClosed,
      stageBFreshRecordingAuthorizedNow,
      stageBFreshRecordingIds: stagedStageBIds,
      stageAExternalInput,
      stageBExternalInput,
      currentStageExternalInput,
      stopLines: stagedProtocolValid
        ? {
          m4Omr: stagedProtocol.stopLines.m4Omr,
          waveformEnergyMissingNote:
            stagedProtocol.stopLines.waveformEnergyMissingNote,
        }
        : {},
      blockingReasons: schedulingBlockingReasons,
    },
    counts: {
      recordings: manifestRows.length,
      truthRecordings: truthRecordings.length,
      truthEvents: truthEventCount,
      performers: uniqueCount("performerId"),
      devices: uniqueCount("deviceId"),
      rooms: uniqueCount("roomId"),
      scoreFiles: scoreFileCount,
      pdfs: pdfCount,
      instructions: instructionCount,
      audioFiles: audioFileCount,
      consentRows: consentCount,
      licenseRows: licenseCount,
      signedEvents: signedEventCount,
      completeInventories: completeInventoryCount,
      positiveByGate,
      confusionNegativeByGate,
      freshBlindPositiveByGate,
      freshBlindConfusionNegativeByGate,
    },
    minimums: frozenMinimums,
    positionBalance: {
      contract: "western-round5-position-balance-preflight-v2",
      bindingCurrent: positionBindingCurrent,
      valid: positionValid,
      readyForRecording: positionBalance?.readyForRecording === true,
      confoundedSplitGates: positionBalance?.confoundedSplitGates || [],
      rhythmConfoundedSplits: positionBalance?.rhythmReviewHint?.confoundedSplits || [],
      audioRead: positionBalance?.audioRead === true,
      promotionEvidenceEligible: false,
      studentFacing: false,
      automaticAccusationReady: false,
    },
    evaluationProtocol: {
      contract: ROUND6_EVALUATION_PROTOCOL_VERSION,
      protocolSha256: evaluationProtocolSha256,
      valid: evaluationProtocolValid,
      sourceBindingsCurrent: evaluationSourcesCurrent,
      runnerReady: evaluationRunnerReady,
      reportBindingCurrent: evaluationReportBindingCurrent,
      evaluationPerformed,
      freshBlindConsumed,
      freshBlindRunLimit: Number(evaluation?.freshBlindRunLimit || 0),
      freshUsedForSelection: evaluation?.freshUsedForSelection === true,
      candidateModelFamily: String(evaluationCandidate?.modelFamily || ""),
      candidateFeaturePolicy: String(evaluationCandidate?.featurePolicy || ""),
      excludedScoreContextFeatures:
        evaluationCandidate?.excludedScoreContextFeatures || [],
      excludedFixedAcousticFeatures:
        evaluationCandidate?.excludedFixedAcousticFeatures || [],
      requiredTemporalFeatures:
        evaluationCandidate?.requiredTemporalFeatures || [],
      strictFalseAccusationDenominator: String(
        evaluationCandidate?.strictFalseAccusationDenominator || "",
      ),
      promotionEvidenceEligible: evaluationPerformed,
      studentFacing: false,
      automaticAccusationReady: false,
      blockingReasons: evaluationBlockingReasons,
    },
    remainingExternalInputScope:
      "maximum-conditional-twelve-take-pack-not-current-scheduling-authority",
    remainingExternalInput: {
      audioFiles: Math.max(0, manifestRows.length - audioFileCount),
      consentRows: Math.max(0, manifestRows.length - consentCount),
      licenseRows: Math.max(0, manifestRows.length - licenseCount),
      signedEvents: Math.max(0, truthEventCount - signedEventCount),
      completeInventories: Math.max(0, truthRecordings.length - completeInventoryCount),
    },
    studentFacing: false,
    automaticAuthorizationGranted: false,
    automaticAccusationReady: false,
    promotionEvidenceEligible: false,
    designBlockingReasons,
    recordingBlockingReasons,
    evaluationBlockingReasons,
    schedulingBlockingReasons,
  };
}

export async function summarizeRound5TargetedIntake({
  contractPath = ROUND5_TARGETED_CONTRACT,
  manifestPath = ROUND5_TARGETED_MANIFEST,
  truthPath = ROUND5_TARGETED_TRUTH,
  reportPath = ROUND5_TARGETED_REPORT,
  modelReportPath = ROUND5_SEGMENT_EDIT_PATH_REPORT,
  calibrationFailureAuditPath = ROUND5_CALIBRATION_FAILURE_AUDIT_REPORT,
  positionBalancePath = ROUND5_POSITION_BALANCE_REPORT,
} = {}) {
  const [
    contract, report, modelReport, calibrationFailureAudit, positionBalance,
    smokeEvidence, temporalEvidence,
    contractSha256, manifestSha256, truthSha256,
  ] = await Promise.all([
    readJson(contractPath),
    readJson(reportPath),
    readJson(modelReportPath),
    readJson(calibrationFailureAuditPath),
    readJson(positionBalancePath),
    readJson(ROUND5_SEGMENT_EDIT_PATH_SMOKE),
    readJson(ROUND5_TEMPORAL_OPERATION_PATH),
    sha256FileOrEmpty(contractPath),
    sha256FileOrEmpty(manifestPath),
    sha256FileOrEmpty(truthPath),
  ]);
  const temporalSourceAudit = temporalEvidence
    ? await auditFlatEvidenceSourceBinding(temporalEvidence)
    : { ready: false, fileCount: 0, aggregateSha256: "", blockingReasons: ["temporal-operation-path-evidence-missing"] };
  const reportReasons = Array.isArray(report?.blockingReasons) ? report.blockingReasons : [];
  const reportHashes = report?.hashes || {};
  const contractBindingCurrent = Boolean(
    contractSha256
      && report
      && String(reportHashes.contractSha256 || "").toLowerCase() === contractSha256,
  );
  const manifestBindingCurrent = manifestSha256
    ? String(reportHashes.manifestSha256 || "").toLowerCase() === manifestSha256
    : Boolean(report
        && !reportHashes.manifestSha256
        && reportReasons.includes("round5-manifest-missing"));
  const truthBindingCurrent = truthSha256
    ? String(reportHashes.truthSha256 || "").toLowerCase() === truthSha256
    : Boolean(report
        && !reportHashes.truthSha256
        && reportReasons.includes("round5-position-truth-missing"));
  const bindingCurrent = Boolean(
    report && contractBindingCurrent && manifestBindingCurrent && truthBindingCurrent,
  );
  const blockingReasons = normalizedReasonList([
    ...reportReasons,
    ...(!contract ? ["round5-targeted-contract-missing"] : []),
    ...(!report ? ["round5-targeted-intake-report-missing"] : []),
    ...(contract && contract.contractVersion !== ROUND5_TARGETED_CONTRACT_VERSION
      ? ["round5-targeted-contract-version-invalid"]
      : []),
    ...(report && report.contractVersion !== contract?.contractVersion
      ? ["round5-targeted-report-contract-version-invalid"]
      : []),
    ...(report && (report.studentFacing !== false || report.automaticAuthorizationGranted !== false)
      ? ["round5-targeted-safety-boundary-invalid"]
      : []),
    ...(report && !contractBindingCurrent ? ["round5-targeted-contract-binding-stale"] : []),
    ...(report && !manifestBindingCurrent ? ["round5-targeted-manifest-binding-stale"] : []),
    ...(report && !truthBindingCurrent ? ["round5-targeted-truth-binding-stale"] : []),
  ]);
  const modelHashes = modelReport?.sourceHashes || {};
  const modelSourceBindingCurrent = Boolean(
    modelReport
      && String(modelHashes.contractSha256 || "").toLowerCase() === contractSha256
      && (manifestSha256
        ? String(modelHashes.manifestSha256 || "").toLowerCase() === manifestSha256
        : !modelHashes.manifestSha256)
      && (truthSha256
        ? String(modelHashes.truthSha256 || "").toLowerCase() === truthSha256
        : !modelHashes.truthSha256),
  );
  const modelArtifact = modelReport?.trainingPerformed === true
    ? await hashWorkspaceArtifact(modelReport?.modelArtifact?.path || "")
    : { sha256: "", status: "not-trained" };
  const modelArtifactCurrent = modelReport?.trainingPerformed === true
    ? Boolean(
        modelArtifact.status === "ok"
          && String(modelReport?.modelArtifact?.sha256 || "").toLowerCase() === modelArtifact.sha256,
      )
    : false;
  const calibrationAuditHashes = calibrationFailureAudit?.sourceHashes || {};
  const calibrationAuditBindingCurrent = Boolean(
    calibrationFailureAudit
      && String(calibrationAuditHashes.manifestSha256 || "").toLowerCase() === manifestSha256
      && String(calibrationAuditHashes.truthSha256 || "").toLowerCase() === truthSha256,
  );
  const calibrationFailureAuditValid = Boolean(
    calibrationFailureAudit?.contract === "western-round5-calibration-failure-audit-v1"
      && calibrationFailureAudit?.evidenceRole
        === "calibration-only-candidate-selection-not-promotion"
      && calibrationAuditBindingCurrent
      && JSON.stringify(calibrationFailureAudit?.splitDiscipline?.allowedSplits)
        === JSON.stringify(["calibration"])
      && calibrationFailureAudit?.splitDiscipline?.freshBlindRowsUsed === 0
      && calibrationFailureAudit?.splitDiscipline?.freshBlindLabelsAccessed === false
      && calibrationFailureAudit?.splitDiscipline?.promotionEvidenceEligible === false
      && calibrationFailureAudit?.automaticAccusationReady === false
      && calibrationFailureAudit?.studentFacing === false
      && calibrationFailureAudit?.productionAdoptionReady === false,
  );
  const calibrationFailureAuditBlockingReasons = normalizedReasonList([
    ...(!calibrationFailureAudit
      ? ["round5-calibration-failure-audit-missing"]
      : []),
    ...(calibrationFailureAudit && !calibrationAuditBindingCurrent
      ? ["round5-calibration-failure-audit-binding-stale"]
      : []),
    ...(calibrationFailureAudit && !calibrationFailureAuditValid
      ? ["round5-calibration-failure-audit-invalid"]
      : []),
  ]);
  const positionBalanceHashes = positionBalance?.sourceHashes || {};
  const positionBalanceBindingCurrent = Boolean(
    positionBalance
      && String(positionBalanceHashes.manifestSha256 || "").toLowerCase() === manifestSha256
      && String(positionBalanceHashes.truthSha256 || "").toLowerCase() === truthSha256,
  );
  const positionBalanceValid = Boolean(
    positionBalance?.contract === "western-round5-position-balance-preflight-v2"
      && positionBalance?.evidenceRole === "pre-recording-position-balance-only"
      && positionBalanceBindingCurrent
      && positionBalance?.audioRead === false
      && positionBalance?.promotionEvidenceEligible === false
      && positionBalance?.automaticAccusationReady === false
      && positionBalance?.studentFacing === false
      && positionBalance?.rhythmReviewHint?.thresholds?.minPrecision === 0.90
      && positionBalance?.rhythmReviewHint?.thresholds?.minRecall === 0.20
      && positionBalance?.rhythmReviewHint?.thresholds?.maxCleanHintRate === 0.02
      && Array.isArray(positionBalance?.rhythmReviewHint?.confoundedSplits),
  );
  const rhythmPositionConfoundedSplits = positionBalanceValid
    ? (positionBalance?.rhythmReviewHint?.confoundedSplits || [])
    : ["calibration", "fresh-blind"];
  const rhythmPositionConfounded = rhythmPositionConfoundedSplits.length > 0;
  const positionBalanceBlockingReasons = normalizedReasonList([
    ...(!positionBalance ? ["round5-position-balance-report-missing"] : []),
    ...(positionBalance && !positionBalanceBindingCurrent
      ? ["round5-position-balance-binding-stale"]
      : []),
    ...(positionBalance && !positionBalanceValid
      ? ["round5-position-balance-report-invalid"]
      : []),
    ...(positionBalance?.blockingReasons || []),
  ]);
  const frozenGapRefinement = modelReport?.frozenGapRefinement || null;
  const frozenGapStrict = frozenGapRefinement?.strictIssueCandidate || null;
  const frozenGapStrictValid = Boolean(
    frozenGapStrict?.contract === "western-round5-frozen-gap-strict-issue-candidate-v1"
      && frozenGapStrict?.runnerWired === true
      && frozenGapStrict?.outputSemantic === "issue_detected_candidate"
      && frozenGapStrict?.strictConfirmedRecallChanged === false
      && frozenGapStrict?.automaticAccusationReady === false
      && frozenGapStrict?.studentFacing === false
      && (frozenGapStrict?.evaluationPerformed === true
        ? frozenGapStrict?.promotionEvidenceEligible === true
          && typeof frozenGapStrict?.automaticAccusationEvidenceReady === "boolean"
        : frozenGapStrict?.promotionEvidenceEligible === false
          && frozenGapStrict?.automaticAccusationEvidenceReady === false),
  );
  const frozenRhythmRefinement = frozenGapRefinement?.rhythmStructuralRefinement || null;
  const frozenRhythmStrict = frozenRhythmRefinement?.strictIssueCandidate || null;
  const frozenRhythmStrictValid = Boolean(
    frozenRhythmStrict?.contract
      === "western-round5-frozen-rhythm-strict-issue-candidate-v1"
      && frozenRhythmStrict?.runnerWired === true
      && frozenRhythmStrict?.outputSemantic === "issue_detected_candidate"
      && frozenRhythmStrict?.strictConfirmedRecallChanged === false
      && frozenRhythmStrict?.automaticAccusationReady === false
      && frozenRhythmStrict?.studentFacing === false
      && (frozenRhythmStrict?.evaluationPerformed === true
        ? frozenRhythmStrict?.promotionEvidenceEligible === true
          && typeof frozenRhythmStrict?.automaticAccusationEvidenceReady === "boolean"
        : frozenRhythmStrict?.promotionEvidenceEligible === false
          && frozenRhythmStrict?.automaticAccusationEvidenceReady === false),
  );
  const frozenRhythmRefinementValid = Boolean(
    frozenRhythmRefinement?.contract
      === "western-round5-frozen-rhythm-structural-refinement-v1"
      && frozenRhythmRefinement?.runnerWired === true
      && frozenRhythmRefinement?.outputSemantic === "self_check_hint"
      && frozenRhythmRefinement?.strictConfirmedRecallChanged === false
      && frozenRhythmRefinement?.automaticAccusationReady === false
      && frozenRhythmRefinement?.studentFacing === false
      && frozenRhythmStrictValid
      && (frozenRhythmRefinement?.evaluationPerformed === true
        ? frozenRhythmRefinement?.promotionEvidenceEligible === true
        : frozenRhythmRefinement?.promotionEvidenceEligible === false
          && frozenRhythmRefinement?.reviewAssistPromotionReady === false),
  );
  const frozenGapRefinementValid = Boolean(
    frozenGapRefinement?.contract === "western-round5-frozen-gap-refinement-v1"
      && frozenGapRefinement?.runnerWired === true
      && frozenGapRefinement?.outputSemantic === "self_check_hint"
      && frozenGapRefinement?.strictConfirmedRecallChanged === false
      && frozenGapRefinement?.automaticAccusationReady === false
      && frozenGapRefinement?.studentFacing === false
      && frozenGapStrictValid
      && frozenRhythmRefinementValid
      && (frozenGapRefinement?.evaluationPerformed === true
        ? frozenGapRefinement?.promotionEvidenceEligible === true
        : frozenGapRefinement?.promotionEvidenceEligible === false
          && frozenGapRefinement?.reviewAssistPromotionReady === false),
  );
  const targetedRunnerEvaluationPerformed = Boolean(
    frozenGapRefinement?.evaluationPerformed === true
      && frozenGapStrict?.evaluationPerformed === true
      && frozenRhythmRefinement?.evaluationPerformed === true
      && frozenRhythmStrict?.evaluationPerformed === true,
  );
  const effectiveFrozenRhythmStrict = frozenRhythmStrict
    ? {
        ...frozenRhythmStrict,
        rawPromotionEvidenceEligible:
          frozenRhythmStrict?.promotionEvidenceEligible === true,
        promotionEvidenceEligible: Boolean(
          frozenRhythmStrict?.promotionEvidenceEligible === true
            && !rhythmPositionConfounded
        ),
        positionBalanceConfounded: rhythmPositionConfounded,
      }
    : null;
  const effectiveFrozenRhythmRefinement = frozenRhythmRefinement
    ? {
        ...frozenRhythmRefinement,
        rawPromotionEvidenceEligible:
          frozenRhythmRefinement?.promotionEvidenceEligible === true,
        promotionEvidenceEligible: Boolean(
          frozenRhythmRefinement?.promotionEvidenceEligible === true
            && !rhythmPositionConfounded
        ),
        reviewAssistPromotionReady: Boolean(
          frozenRhythmRefinement?.reviewAssistPromotionReady === true
            && !rhythmPositionConfounded
        ),
        positionBalanceConfounded: rhythmPositionConfounded,
        positionBalanceConfoundedSplits: rhythmPositionConfoundedSplits,
        strictIssueCandidate: effectiveFrozenRhythmStrict,
      }
    : null;
  const targetedRunnerPromotionBlockingReasons = normalizedReasonList([
    ...(frozenGapRefinement?.blockingReasons || []),
    ...(frozenGapStrict?.blockingReasons || []),
    ...(frozenRhythmRefinement?.blockingReasons || []),
    ...(frozenRhythmStrict?.blockingReasons || []),
    ...rhythmPositionConfoundedSplits.map(
      (split) => `round5-rhythm-position-score-context-confounded:${split}`,
    ),
  ]);
  const computedPromotedGates = ROUND5_SEGMENT_GATES.filter(
    (gate) => modelReport?.evaluation?.gates?.[gate]?.ready === true,
  );
  const computedFailedGates = ROUND5_SEGMENT_GATES.filter(
    (gate) => !computedPromotedGates.includes(gate),
  );
  const declaredPromotedGates = Array.isArray(modelReport?.promotedGates)
    ? modelReport.promotedGates
    : [];
  const declaredFailedGates = Array.isArray(modelReport?.failedGates)
    ? modelReport.failedGates
    : [];
  const freshPositionConfoundedGates = positionBalanceValid
    ? (positionBalance?.confoundedSplitGates || [])
      .filter((item) => String(item).startsWith("fresh-blind:"))
      .map((item) => String(item).slice("fresh-blind:".length))
    : [...ROUND5_SEGMENT_GATES];
  const promotionEligibleGates = declaredPromotedGates.filter(
    (gate) => !freshPositionConfoundedGates.includes(gate),
  );
  const promotionBlockedGates = declaredPromotedGates.filter(
    (gate) => freshPositionConfoundedGates.includes(gate),
  );
  const modelGateSummaryCurrent = modelReport?.trainingPerformed === true
    ? Boolean(
        modelReport?.promotionScope === "independent-per-gate"
          && JSON.stringify(declaredPromotedGates) === JSON.stringify(computedPromotedGates)
          && JSON.stringify(declaredFailedGates) === JSON.stringify(computedFailedGates)
          && modelReport?.reviewAssistPromotionReady === (computedPromotedGates.length > 0)
          && modelReport?.partialGatePromotionReady
            === (computedPromotedGates.length > 0
              && computedPromotedGates.length < ROUND5_SEGMENT_GATES.length)
          && modelReport?.allGatePromotionReady
            === (computedPromotedGates.length === ROUND5_SEGMENT_GATES.length),
      )
    : Boolean(
        modelReport?.promotionScope === "independent-per-gate"
          && declaredPromotedGates.length === 0
          && JSON.stringify(declaredFailedGates) === JSON.stringify(ROUND5_SEGMENT_GATES)
          && modelReport?.reviewAssistPromotionReady === false
          && modelReport?.partialGatePromotionReady === false
          && modelReport?.allGatePromotionReady === false,
      );
  const modelIntegrityBlockingReasons = normalizedReasonList([
    ...(!modelReport ? ["round5-segment-edit-path-report-missing"] : []),
    ...(modelReport && modelReport.contract !== "western-round5-segment-edit-path-candidate-v1"
      ? ["round5-segment-edit-path-contract-invalid"]
      : []),
    ...(modelReport && (
      modelReport.studentFacing !== false
        || modelReport.automaticAccusationReady !== false
        || modelReport.productionAdoptionReady !== false
    ) ? ["round5-segment-edit-path-safety-boundary-invalid"] : []),
    ...(modelReport && !modelSourceBindingCurrent
      ? ["round5-segment-edit-path-source-binding-stale"]
      : []),
    ...(modelReport?.trainingPerformed === true && !modelArtifactCurrent
      ? ["round5-segment-edit-path-model-artifact-stale"]
      : []),
    ...(modelReport && !modelGateSummaryCurrent
      ? ["round5-segment-edit-path-gate-summary-invalid"]
      : []),
    ...(modelReport && !frozenGapRefinementValid
      ? ["round5-frozen-gap-refinement-runner-invalid"]
      : []),
  ]);
  const modelBlockingReasons = normalizedReasonList([
    ...(modelReport?.blockingReasons || []),
    ...modelIntegrityBlockingReasons,
  ]);
  const smokeEvidenceValid = Boolean(
    smokeEvidence?.contract === "western-round5-segment-edit-path-smoke-v1"
      && smokeEvidence?.evidenceRole === "architecture-smoke-preGateOnly"
      && smokeEvidence?.promotionEvidenceEligible === false
      && smokeEvidence?.reviewAssistPromotionReady === false
      && smokeEvidence?.automaticAccusationReady === false
      && smokeEvidence?.studentFacing === false
      && smokeEvidence?.productionAdoptionReady === false,
  );
  const temporalGapRefinement = temporalEvidence?.policyCGapRefinement || null;
  const temporalGapStrict = temporalEvidence?.gapStrictIssueCandidate || null;
  const temporalCombined = temporalGapRefinement?.round4TwoLayerCombined || null;
  const temporalPublicStress = temporalGapRefinement?.publicProfessionalStress || null;
  const temporalRhythmRefinement = temporalEvidence?.rhythmStructuralRefinement || null;
  const temporalRhythmStrict = temporalEvidence?.rhythmStrictIssueCandidate || null;
  const temporalStrictLayers = temporalRhythmStrict?.round4RecallLayers || null;
  const temporalEvidenceValid = Boolean(
    temporalEvidence?.contract === "western-round5-temporal-operation-path-smoke-v1"
      && temporalEvidence?.scope === "architecture-smoke-preGateOnly"
      && temporalEvidence?.promotionEvidenceEligible === false
      && temporalEvidence?.architectureCandidateRetained === false
      && temporalEvidence?.reviewAssistPromotionReady === false
      && temporalEvidence?.automaticAccusationReady === false
      && temporalEvidence?.productionAdoptionReady === false
      && temporalEvidence?.studentFacing === false
      && temporalGapRefinement?.candidateRetainedForFreshBlind === true
      && temporalGapRefinement?.naturalCleanStress?.refined?.falsePositive === 0
      && temporalGapRefinement?.generalPurposeCandidateRetained === false
      && temporalGapStrict?.contract
        === "western-round5-gap-strict-issue-candidate-pre-gate-v1"
      && temporalGapStrict?.candidateRetainedForFreshBlind === true
      && temporalGapStrict?.outputSemantic === "issue_detected_candidate"
      && temporalGapStrict?.syntheticHoldout?.safetyAgainstAllKnownErrors?.truePositive === 10
      && temporalGapStrict?.syntheticHoldout?.safetyAgainstAllKnownErrors?.falsePositive === 0
      && temporalGapStrict?.syntheticHoldout?.targetGate?.recall === 0.666667
      && temporalGapStrict?.round4InspectedReal?.safetyAgainstAllKnownErrors?.truePositive === 4
      && temporalGapStrict?.round4InspectedReal?.safetyAgainstAllKnownErrors?.falsePositive === 0
      && temporalGapStrict?.round4InspectedReal?.targetGate?.detected === 3
      && temporalGapStrict?.naturalCleanStress?.safetyAgainstAllKnownErrors?.falsePositive === 0
      && temporalGapStrict?.publicProfessionalStress?.rawRefinedCandidateCount === 595
      && temporalGapStrict?.publicProfessionalStress?.emittedCandidateCount === 0
      && temporalGapStrict?.publicProfessionalStress?.scopeRejectedRecordingCount === 2
      && temporalGapStrict?.strictConfirmedRecallChanged === false
      && temporalGapStrict?.automaticAccusationEvidenceReady === false
      && temporalGapStrict?.automaticAccusationReady === false
      && temporalGapStrict?.promotionEvidenceEligible === false
      && temporalPublicStress?.evidenceRole
        === "public-professional-unadjudicated-negative-burden-proxy"
      && temporalPublicStress?.scorePositionCount === 2301
      && temporalPublicStress?.refinedFlagCount === 595
      && temporalPublicStress?.humanErrorGoldAvailable === false
      && temporalPublicStress?.falsePositiveCountAuthoritative === false
      && temporalPublicStress?.generalPurposeBurdenReady === false
      && temporalPublicStress?.promotionEvidenceEligible === false
      && temporalRhythmRefinement?.candidateRetainedForFreshBlind === true
      && temporalRhythmRefinement?.round4InspectedReal?.truePositive === 4
      && temporalRhythmRefinement?.round4InspectedReal?.falsePositive === 0
      && temporalRhythmRefinement?.naturalCleanStress?.hintRate <= 0.02
      && temporalRhythmRefinement?.automaticAccusationReady === false
      && temporalRhythmRefinement?.promotionEvidenceEligible === false
      && temporalRhythmStrict?.contract
        === "western-round5-rhythm-strict-issue-candidate-pre-gate-v1"
      && temporalRhythmStrict?.candidateRetainedForFreshBlind === true
      && temporalRhythmStrict?.outputSemantic === "issue_detected_candidate"
      && temporalRhythmStrict?.syntheticHoldout?.truePositive === 14
      && temporalRhythmStrict?.syntheticHoldout?.falsePositive === 0
      && temporalRhythmStrict?.round4InspectedReal?.truePositive === 4
      && temporalRhythmStrict?.round4InspectedReal?.falsePositive === 0
      && temporalRhythmStrict?.naturalCleanStress?.falsePositive === 0
      && temporalRhythmStrict?.publicProfessionalStress?.candidateCount === 13
      && temporalRhythmStrict?.publicProfessionalStress?.falsePositiveCountAuthoritative === false
      && temporalStrictLayers?.strictPlusRhythmCandidate?.truePositive === 6
      && temporalStrictLayers?.strictPlusRhythmCandidate?.falsePositive === 0
      && temporalStrictLayers?.strictPlusRhythmAndGapSelfCheck?.truePositive === 10
      && temporalStrictLayers?.strictPlusRhythmAndGapSelfCheck?.falsePositive === 0
      && temporalRhythmStrict?.strictConfirmedRecallChanged === false
      && temporalRhythmStrict?.automaticAccusationEvidenceReady === false
      && temporalRhythmStrict?.automaticAccusationReady === false
      && temporalRhythmStrict?.promotionEvidenceEligible === false
      && temporalCombined?.strictConfirmed === 2
      && temporalCombined?.refinedSelfCheckHints === 4
      && temporalCombined?.falsePositive === 0
      && temporalCombined?.strictConfirmedRecallUnchanged === true
      && temporalCombined?.automaticAccusationReady === false
      && temporalCombined?.reviewAssistPromotionReady === false
      && temporalSourceAudit.ready === true
  );
  return {
    contract: contract?.contractVersion || ROUND5_TARGETED_CONTRACT_VERSION,
    source: String(reportPath).replace(/\\/g, "/"),
    paths: {
      contract: String(contractPath).replace(/\\/g, "/"),
      manifest: String(manifestPath).replace(/\\/g, "/"),
      truth: String(truthPath).replace(/\\/g, "/"),
    },
    ready: report?.ready === true && bindingCurrent && blockingReasons.length === 0,
    bindingCurrent,
    bindings: {
      contract: contractBindingCurrent,
      manifest: manifestBindingCurrent,
      truth: truthBindingCurrent,
    },
    counts: report?.counts || {},
    minimums: report?.minimums || contract?.minimums || {},
    studentFacing: false,
    automaticAuthorizationGranted: false,
    segmentEditPathCandidate: {
      contract: "western-round5-segment-edit-path-candidate-v1",
      source: String(modelReportPath).replace(/\\/g, "/"),
      bindingCurrent: modelSourceBindingCurrent,
      intakeReady: modelReport?.intakeReady === true,
      trainingPerformed: modelReport?.trainingPerformed === true,
      reviewAssistPromotionReady: Boolean(
        modelReport?.reviewAssistPromotionReady === true
          && modelSourceBindingCurrent
          && modelArtifactCurrent
          && modelGateSummaryCurrent
          && modelIntegrityBlockingReasons.length === 0
          && positionBalanceValid
          && promotionEligibleGates.length > 0
      ),
      promotionScope: modelReport?.promotionScope || null,
      numericallyPromotedGates: declaredPromotedGates,
      promotedGates: promotionEligibleGates,
      promotionBlockedGates,
      failedGates: declaredFailedGates,
      partialGateNumericFloorReady: modelReport?.partialGatePromotionReady === true,
      partialGatePromotionReady: promotionEligibleGates.length > 0
        && promotionEligibleGates.length < ROUND5_SEGMENT_GATES.length,
      allGateNumericFloorReady: modelReport?.allGatePromotionReady === true,
      allGatePromotionReady:
        promotionEligibleGates.length === ROUND5_SEGMENT_GATES.length,
      modelArtifactCurrent,
      evaluation: modelReport?.evaluation || null,
      calibrationFailureAudit: {
        source: String(calibrationFailureAuditPath).replace(/\\/g, "/"),
        valid: calibrationFailureAuditValid,
        bindingCurrent: calibrationAuditBindingCurrent,
        splitDiscipline: calibrationFailureAudit?.splitDiscipline || null,
        retainedCandidateGates: calibrationFailureAudit?.retainedCandidateGates || [],
        positionConfoundingDetectedGates:
          calibrationFailureAudit?.positionConfoundingDetectedGates || [],
        additionalCalibrationRequiredGates:
          calibrationFailureAudit?.additionalCalibrationRequiredGates || [],
        gates: calibrationFailureAudit?.gates || null,
        nextCalibrationRequirements:
          calibrationFailureAudit?.nextCalibrationRequirements || null,
        newUntouchedFreshBlindRequired:
          calibrationFailureAudit?.newUntouchedFreshBlindRequired === true,
        promotionEvidenceEligible: false,
        studentFacing: false,
        automaticAccusationReady: false,
        blockingReasons: calibrationFailureAuditBlockingReasons,
      },
      positionBalanceAudit: {
        source: String(positionBalancePath).replace(/\\/g, "/"),
        valid: positionBalanceValid,
        bindingCurrent: positionBalanceBindingCurrent,
        readyForRecording: positionBalance?.readyForRecording === true,
        confoundedSplitGates: positionBalance?.confoundedSplitGates || [],
        freshBlindConfoundedGates: freshPositionConfoundedGates,
        rhythmReviewHint: positionBalance?.rhythmReviewHint || null,
        rhythmConfoundedSplits: rhythmPositionConfoundedSplits,
        requiredBalanceDimensions:
          positionBalance?.requiredBalanceDimensions || [],
        audioRead: false,
        promotionEvidenceEligible: false,
        studentFacing: false,
        automaticAccusationReady: false,
        blockingReasons: positionBalanceBlockingReasons,
      },
      smokeDiagnostic: {
        source: ROUND5_SEGMENT_EDIT_PATH_SMOKE.replace(/\\/g, "/"),
        evidenceValid: smokeEvidenceValid,
        architectureCandidateRetained: smokeEvidence?.architectureCandidateRetained === true,
        structuralRound4Union: smokeEvidence?.structuralAlignment?.round4Union || null,
        acousticRound4Union: smokeEvidence?.acousticAugmented?.round4Union || null,
        promotionEvidenceEligible: false,
        blockingReasons: normalizedReasonList([
          ...(!smokeEvidence ? ["round5-segment-edit-path-smoke-evidence-missing"] : []),
          ...(smokeEvidence && !smokeEvidenceValid
            ? ["round5-segment-edit-path-smoke-evidence-invalid"]
            : []),
          ...(smokeEvidence?.blockingReasons || []),
        ]),
      },
      temporalOperationPathDiagnostic: {
        source: ROUND5_TEMPORAL_OPERATION_PATH.replace(/\\/g, "/"),
        evidenceValid: temporalEvidenceValid,
        sourceBindingCurrent: temporalSourceAudit.ready,
        sourceFileCount: temporalSourceAudit.fileCount,
        rawArchitectureCandidateRetained: temporalEvidence?.architectureCandidateRetained === true,
        rawRound4Union: temporalEvidence?.round4InspectedReal?.union || null,
        gapRefinementCandidateRetainedForFreshBlind:
          temporalGapRefinement?.candidateRetainedForFreshBlind === true,
        gapStrictIssueCandidateRetainedForFreshBlind:
          temporalGapStrict?.candidateRetainedForFreshBlind === true,
        gapStrictIssueCandidate: temporalGapStrict,
        round4TwoLayerCombined: temporalCombined,
        naturalCleanStress: temporalGapRefinement?.naturalCleanStress?.refined || null,
        publicProfessionalStress: temporalPublicStress,
        rhythmStructuralCandidateRetainedForFreshBlind:
          temporalRhythmRefinement?.candidateRetainedForFreshBlind === true,
        rhythmStructuralRefinement: temporalRhythmRefinement,
        rhythmStrictIssueCandidateRetainedForFreshBlind:
          temporalRhythmStrict?.candidateRetainedForFreshBlind === true,
        rhythmStrictIssueCandidate: temporalRhythmStrict,
        generalPurposeCandidateRetained:
          temporalGapRefinement?.generalPurposeCandidateRetained === true,
        targetedFreshBlindRunner: {
          source: String(modelReportPath).replace(/\\/g, "/"),
          bindingCurrent: modelSourceBindingCurrent,
          valid: frozenGapRefinementValid,
          ...(frozenGapRefinement || {}),
          rhythmStructuralRefinement: effectiveFrozenRhythmRefinement,
          reviewAssistPromotionReady: Boolean(
            frozenGapRefinement?.reviewAssistPromotionReady === true
              && frozenGapRefinement?.evaluationPerformed === true
              && frozenGapRefinementValid
              && modelSourceBindingCurrent
              && !rhythmPositionConfounded
          ),
          promotionBlockingReasons: targetedRunnerPromotionBlockingReasons,
        },
        promotionEvidenceEligible: false,
        studentFacing: false,
        automaticAccusationReady: false,
        blockingReasons: normalizedReasonList([
          ...(!temporalEvidence ? ["temporal-operation-path-evidence-missing"] : []),
          ...(temporalEvidence && !temporalEvidenceValid
            ? ["temporal-operation-path-evidence-invalid"]
            : []),
          ...(temporalSourceAudit.blockingReasons || []),
          ...(targetedRunnerEvaluationPerformed
            ? targetedRunnerPromotionBlockingReasons
            : temporalGapRefinement?.promotionBlockingReasons || []),
        ]),
      },
      studentFacing: false,
      automaticAccusationReady: false,
      productionAdoptionReady: false,
      promotionBlockingReasons: modelReport?.blockingReasons || [],
      promotionEvidenceBlockingReasons: normalizedReasonList([
        ...promotionBlockedGates.map(
          (gate) => `round5-fresh-position-score-context-confounded:${gate}`,
        ),
        ...rhythmPositionConfoundedSplits.map(
          (split) => `round5-rhythm-position-score-context-confounded:${split}`,
        ),
        ...(!positionBalanceValid ? positionBalanceBlockingReasons : []),
      ]),
      integrityBlockingReasons: modelIntegrityBlockingReasons,
      blockingReasons: modelBlockingReasons,
    },
    blockingReasons,
  };
}

function homrEvidenceToBenchmark(evidence) {
  const aggregate = evidence?.aggregate || {};
  const complete = Boolean(
    evidence?.schemaVersion === 1
      && evidence?.authority === "current-frozen-homr-sourcegold-baseline"
      && evidence?.evaluationMode === "independent-source-gold"
      && evidence?.freshRun?.reuseExisting === false
      && aggregate.rows === 5
      && aggregate.usableRows === 5,
  );
  if (!evidence) return null;
  return {
    complete,
    gate: {
      automaticAdoptionReady: aggregate.automaticAdoptionReady === true,
      studentGateReady: aggregate.studentGateReady === true,
    },
    runtime: evidence.runtime || {},
    comparison: {
      homr: {
        rows: aggregate.rows ?? 0,
        usableRows: aggregate.usableRows ?? 0,
        engineFailureRows: aggregate.engineFailureRows ?? 0,
        unusableEvidenceRows: aggregate.unusableEvidenceRows ?? 0,
        pitchOnlyStrictPassRows: aggregate.pitchOnlyStrictPassRows ?? 0,
        strictPassRows: aggregate.strictPassRows ?? 0,
        pitchPrecision: aggregate.pitchPrecision ?? null,
        pitchRecall: aggregate.pitchRecall ?? null,
        pitchMissRate: aggregate.pitchMissRate ?? null,
        pitchRecallIncludingEngineFailures:
          aggregate.pitchRecallIncludingEngineFailures ?? null,
        onsetQuarterAccuracy: aggregate.onsetQuarterAccuracy ?? null,
        measureAccuracy: aggregate.measureAccuracy ?? null,
      },
    },
    evidenceManifest: evidence,
  };
}

async function readControlledPilotSessions(root = CONTROLLED_PILOT_SESSIONS_ROOT) {
  const absoluteRoot = path.resolve(process.cwd(), root);
  let entries = [];
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionPath = path.join(absoluteRoot, entry.name, "session.json");
    const session = await readJson(sessionPath);
    if (!session || session.evidenceInvalidated === true) continue;
    let selectedSubmissions = Array.isArray(session.selectedSubmissions) ? session.selectedSubmissions : [];
    if (!selectedSubmissions.length && session.artifacts?.precisionSummary) {
      const precision = await readJson(session.artifacts.precisionSummary);
      selectedSubmissions = Array.isArray(precision?.selectedSubmissions) ? precision.selectedSubmissions : [];
    }
    sessions.push({
      ...session,
      selectedSubmissions,
      source: path.relative(process.cwd(), sessionPath).replace(/\\/g, "/"),
    });
  }
  sessions.sort((left, right) => (
    Date.parse(right.generatedAt || "") - Date.parse(left.generatedAt || "")
  ));
  return sessions;
}

function summarizeControlledPilotEvidence(sessions = []) {
  const executed = sessions.filter((session) => session.executionPerformed === true);
  const completedSafe = executed.filter((session) => session.sessionStatus === "completed_safe"
    && session.pilotRunAccepted === true
    && session.defaultRuntimeFailClosedAfter === true
    && session.processEnvironmentRestored === true
    && session.studentFeedbackPublished === false
    && (session.blockingReasons || []).length === 0);
  const recordingIds = new Set();
  const safeRecordingIds = new Set();
  const safePieceIds = new Set();
  const precheckRejectedRecordingIds = new Set();
  for (const session of executed) {
    for (const submission of session.selectedSubmissions || []) {
      const recordingId = String(submission?.recordingId || "").trim();
      if (recordingId) recordingIds.add(recordingId);
      if (recordingId && completedSafe.includes(session)) safeRecordingIds.add(recordingId);
      const piece = String(submission?.piece || "").trim();
      if (piece && completedSafe.includes(session)) safePieceIds.add(piece);
    }
    for (const recordingId of session.additionalExcludedRecordingIds || []) {
      const normalized = String(recordingId || "").trim();
      if (normalized) precheckRejectedRecordingIds.add(normalized);
    }
  }
  const sumMonitoring = (field) => executed.reduce(
    (total, session) => total + Number(session.monitoring?.[field] || 0),
    0,
  );
  const normalizedSafeMonitoring = completedSafe.map((session) => {
    const monitoring = session.monitoring || {};
    const knownUsable = Number(monitoring.knownUsableAutoPassCandidateCount || 0);
    const knownWrong = Number(monitoring.knownWrongAutoPassCandidateCount || 0);
    const unknown = Number(monitoring.unknownAutoPassCandidateCount || 0);
    const modelAutoPass = Number(
      monitoring.modelAutoPassCandidateCount
      ?? monitoring.autoPassCandidateCount
      ?? 0,
    );
    const pilotEligible = Number(
      monitoring.pilotEligibleAutoPassCandidateCount
      ?? monitoring.selfCheckedAutoPassCandidateCount
      ?? (knownUsable + knownWrong + unknown),
    );
    return {
      total: Number(monitoring.totalCandidateCount || 0),
      modelAutoPass,
      pilotEligible,
      suppressed: Number(
        monitoring.suppressedModelAutoPassCandidateCount
        ?? Math.max(0, modelAutoPass - pilotEligible),
      ),
      knownUsable,
      knownWrong,
      unknown,
    };
  });
  const safeSum = (field) => normalizedSafeMonitoring.reduce(
    (total, monitoring) => total + monitoring[field],
    0,
  );
  const safeTotalCandidateCount = safeSum("total");
  const pilotEligibleAutoPassCandidateCount = safeSum("pilotEligible");
  const knownUsableAutoPassCandidateCount = safeSum("knownUsable");
  const knownWrongAutoPassCandidateCount = safeSum("knownWrong");
  const unknownAutoPassCandidateCount = safeSum("unknown");
  const scoredAutoPassCandidateCount = knownUsableAutoPassCandidateCount + knownWrongAutoPassCandidateCount;
  const precision = scoredAutoPassCandidateCount > 0
    ? knownUsableAutoPassCandidateCount / scoredAutoPassCandidateCount
    : null;
  const coverage = safeTotalCandidateCount > 0
    ? pilotEligibleAutoPassCandidateCount / safeTotalCandidateCount
    : 0;
  const meetsPrecisionFloor = precision !== null && precision >= V2_ALPHA_MIN_PRECISION;
  const meetsCoverageFloor = coverage >= V2_ALPHA_MIN_COVERAGE;
  const hasCrossPieceEvidence = safePieceIds.size >= 2;
  const historicalReady = completedSafe.length >= 2
    && meetsPrecisionFloor
    && meetsCoverageFloor
    && hasCrossPieceEvidence
    && unknownAutoPassCandidateCount === 0;
  return {
    historicalOnly: true,
    eligibleAsCurrentReleaseEvidence: false,
    sessionCount: sessions.length,
    executedSessionCount: 0,
    completedSafeSessionCount: 0,
    distinctRecordingCount: 0,
    safeDistinctRecordingCount: 0,
    safeDistinctPieceCount: 0,
    recordingIds: [],
    safeRecordingIds: [],
    safePieceIds: [],
    precheckRejectedRecordingIds: [],
    totalCandidateCount: 0,
    autoPassCandidateCount: 0,
    modelAutoPassCandidateCount: 0,
    pilotEligibleAutoPassCandidateCount: 0,
    suppressedModelAutoPassCandidateCount: 0,
    reviewRequiredCandidateCount: 0,
    knownUsableAutoPassCandidateCount: 0,
    knownWrongAutoPassCandidateCount: 0,
    unknownAutoPassCandidateCount: 0,
    v2AlphaGate: {
      minPrecision: V2_ALPHA_MIN_PRECISION,
      minCoverage: V2_ALPHA_MIN_COVERAGE,
      precision: null,
      coverage: 0,
      meetsPrecisionFloor: false,
      meetsCoverageFloor: false,
      hasCrossPieceEvidence: false,
      ready: false,
      blockingReasons: ["controlled-pilot-evidence-superseded-historical-rf-only"],
    },
    historicalEvidence: {
      executedSessionCount: executed.length,
      completedSafeSessionCount: completedSafe.length,
      distinctRecordingCount: recordingIds.size,
      safeDistinctRecordingCount: safeRecordingIds.size,
      safeDistinctPieceCount: safePieceIds.size,
      recordingIds: [...recordingIds].sort(),
      safeRecordingIds: [...safeRecordingIds].sort(),
      safePieceIds: [...safePieceIds].sort(),
      precheckRejectedRecordingIds: [...precheckRejectedRecordingIds].sort(),
      totalCandidateCount: sumMonitoring("totalCandidateCount"),
      autoPassCandidateCount: sumMonitoring("autoPassCandidateCount"),
      modelAutoPassCandidateCount: safeSum("modelAutoPass"),
      pilotEligibleAutoPassCandidateCount,
      suppressedModelAutoPassCandidateCount: safeSum("suppressed"),
      reviewRequiredCandidateCount: Math.max(0, safeTotalCandidateCount - pilotEligibleAutoPassCandidateCount),
      knownUsableAutoPassCandidateCount,
      knownWrongAutoPassCandidateCount,
      unknownAutoPassCandidateCount,
      v2AlphaGate: {
        minPrecision: V2_ALPHA_MIN_PRECISION,
        minCoverage: V2_ALPHA_MIN_COVERAGE,
        precision,
        coverage,
        meetsPrecisionFloor,
        meetsCoverageFloor,
        hasCrossPieceEvidence,
        ready: historicalReady,
      },
    },
  };
}

function bestDeployableReleaseCandidate(pilot) {
  const candidates = [];
  for (const evaluation of pilot?.evaluations || []) {
    if (evaluation.featureSet !== "deployable" || evaluation.groupBy !== "recordingId") continue;
    for (const [modelName, model] of Object.entries(evaluation.models || {})) {
      if (!model?.releaseCandidate) continue;
      candidates.push({
        modelName,
        featureSet: evaluation.featureSet,
        groupBy: evaluation.groupBy,
        ...model.releaseCandidate,
      });
    }
  }
  candidates.sort((a, b) => (
    Number(b.precision || 0) - Number(a.precision || 0)
    || Number(b.coverage || 0) - Number(a.coverage || 0)
    || Number(b.selected || 0) - Number(a.selected || 0)
  ));
  return candidates[0] || null;
}

export function summarizePublicModelValidation({
  phenicxAlignment = null,
  muscCalibration = null,
  muscFresh = null,
  violinMidiAudit = null,
  musicnetAccompaniedViolin = null,
  musicnetYourmt3 = null,
} = {}) {
  const alignmentEngineeringGatePassed = phenicxAlignment?.ok === true
    && phenicxAlignment?.alignmentGatePassed === true;
  const alignmentPolyphonicGatePassed = phenicxAlignment?.polyphonicSubgroupGate?.passed === true;
  const phenicxRecognition = phenicxAlignment?.recognition || null;
  const phenicxRecognitionReportAvailable = phenicxRecognition?.evidenceType
    === "independent-audio-event-recognition-against-manual-note-gold"
    && phenicxRecognition?.scoreUsedDuringInference === false;
  const phenicxPolyphonicRecognitionGatePassed = phenicxRecognitionReportAvailable
    && phenicxRecognition?.polyphonicRecognitionGate?.passed === true;
  const recognitionCalibrationV2Ready = muscCalibration?.ok === true
    && muscCalibration?.calibrationV2Ready === true;
  const recognitionCalibrationV3Ready = muscCalibration?.ok === true
    && muscCalibration?.calibrationV3Ready === true;
  const recognitionFreshV2Ready = muscFresh?.ok === true
    && muscFresh?.freshConfirmationPassed === true
    && muscFresh?.muscV2CoreGatePassed === true;
  const recognitionFreshV3Ready = muscFresh?.ok === true
    && muscFresh?.freshConfirmationPassed === true
    && muscFresh?.muscV3CoreGatePassed === true;
  const doubleStopAutoFeedbackReady = muscFresh?.doubleStopAutoFeedbackEligible === true
    && alignmentPolyphonicGatePassed
    && phenicxPolyphonicRecognitionGatePassed;
  const weakLabelSourceReady = violinMidiAudit?.ok === true
    && violinMidiAudit?.readyAsWeakLabelSource === true;
  const independentRecognitionBenchmarkReady = violinMidiAudit?.ok === true
    && violinMidiAudit?.readyAsIndependentRecognitionBenchmark === true;
  const accompaniedViolinReportAvailable = musicnetAccompaniedViolin?.schemaVersion
    === "western-musicnet-accompanied-violin-v1"
    && musicnetAccompaniedViolin?.evidenceType
      === "independent-full-mix-audio-event-recognition-against-instrument-labelled-note-gold";
  const accompaniedViolinRecognitionReady = accompaniedViolinReportAvailable
    && musicnetAccompaniedViolin?.accompaniedViolinRecognitionReady === true;
  const yourmt3ReportAvailable = musicnetYourmt3?.schemaVersion
    === "western-musicnet-yourmt3-instrument-aware-v1"
    && musicnetYourmt3?.evidenceRole === "public-professional-diagnostic-challenger";
  const yourmt3RecognitionReady = yourmt3ReportAvailable
    && musicnetYourmt3?.accompaniedViolinRecognitionReady === true;
  const publicProfessionalMonophonicV2CandidateReady = alignmentEngineeringGatePassed
    && recognitionCalibrationV2Ready
    && recognitionFreshV2Ready;
  const publicProfessionalMonophonicV3Ready = alignmentEngineeringGatePassed
    && recognitionCalibrationV3Ready
    && recognitionFreshV3Ready;
  const blockingReasons = [];
  if (!phenicxAlignment) blockingReasons.push("phenicx-alignment-report-missing");
  else if (!alignmentEngineeringGatePassed) blockingReasons.push("phenicx-alignment-engineering-gate-failed");
  if (phenicxAlignment?.freshExternalConfirmationRequired === true) {
    blockingReasons.push("phenicx-fresh-external-confirmation-required");
  }
  if (!alignmentPolyphonicGatePassed) blockingReasons.push("phenicx-polyphonic-alignment-gate-failed");
  if (!phenicxRecognitionReportAvailable) {
    blockingReasons.push("phenicx-polyphonic-recognition-report-missing");
  } else if (!phenicxPolyphonicRecognitionGatePassed) {
    blockingReasons.push("phenicx-polyphonic-recognition-gate-failed");
  }
  if (!muscCalibration) blockingReasons.push("musc-calibration-report-missing");
  else if (!recognitionCalibrationV2Ready) blockingReasons.push("musc-v2-calibration-gate-failed");
  if (!muscFresh) blockingReasons.push("musc-fresh-confirmation-report-missing");
  else if (!recognitionFreshV2Ready) blockingReasons.push("musc-v2-fresh-confirmation-failed");
  if (!recognitionFreshV3Ready) blockingReasons.push("musc-v3-strict-gate-failed");
  if (!doubleStopAutoFeedbackReady) blockingReasons.push("double-stop-auto-feedback-not-ready");
  if (!violinMidiAudit) blockingReasons.push("violin-midi-audit-missing");
  else if (!weakLabelSourceReady) blockingReasons.push("violin-midi-weak-label-source-not-ready");
  if (!independentRecognitionBenchmarkReady) {
    blockingReasons.push("violin-midi-not-independent-recognition-gold");
  }
  if (!accompaniedViolinReportAvailable) {
    blockingReasons.push("musicnet-accompanied-violin-report-missing");
  } else if (!accompaniedViolinRecognitionReady) {
    blockingReasons.push("musicnet-accompanied-violin-recognition-gate-failed");
  }
  if (yourmt3ReportAvailable) {
    blockingReasons.push(...(musicnetYourmt3.blockingReasons || []));
  }
  blockingReasons.push("student-domain-evidence-not-covered");
  return {
    scope: "public-professional-violin-eval-only",
    artifacts: {
      phenicxAlignment: PHENICX_ALIGNMENT_REPORT.replace(/\\/g, "/"),
      muscCalibration: MUSC_CALIBRATION_REPORT.replace(/\\/g, "/"),
      muscFreshConfirmation: MUSC_FRESH_REPORT.replace(/\\/g, "/"),
      violinMidiAudit: VIOLIN_MIDI_AUDIT.replace(/\\/g, "/"),
      musicnetAccompaniedViolin: MUSICNET_ACCOMPANIED_VIOLIN_REPORT.replace(/\\/g, "/"),
      musicnetYourmt3Challenger: MUSICNET_YOURMT3_CHALLENGER.replace(/\\/g, "/"),
    },
    alignment: {
      reportAvailable: Boolean(phenicxAlignment),
      engineeringGatePassed: alignmentEngineeringGatePassed,
      polyphonicGatePassed: alignmentPolyphonicGatePassed,
      freshExternalConfirmationRequired: phenicxAlignment?.freshExternalConfirmationRequired === true,
      selectedMethod: phenicxAlignment?.selectedMethod || "",
      gate: phenicxAlignment?.gate || {},
      polyphonicGate: phenicxAlignment?.polyphonicSubgroupGate || {},
    },
    recognition: {
      calibrationReportAvailable: Boolean(muscCalibration),
      freshReportAvailable: Boolean(muscFresh),
      calibrationV2Ready: recognitionCalibrationV2Ready,
      calibrationV3Ready: recognitionCalibrationV3Ready,
      freshConfirmationPassed: muscFresh?.freshConfirmationPassed === true,
      monophonicV2Ready: recognitionFreshV2Ready,
      monophonicV3Ready: recognitionFreshV3Ready,
      doubleStopAutoFeedbackReady,
      phenicxHumanGold: {
        reportAvailable: phenicxRecognitionReportAvailable,
        scoreUsedDuringInference: phenicxRecognition?.scoreUsedDuringInference === true,
        selectedFilter: phenicxRecognition?.selectedFilter || {},
        development: phenicxRecognition?.development || {},
        holdout: phenicxRecognition?.holdout || {},
        gate: phenicxRecognition?.polyphonicRecognitionGate || {},
        protocolCaveat: phenicxRecognition?.protocolCaveat || "",
      },
      accompaniedViolin: {
        reportAvailable: accompaniedViolinReportAvailable,
        selectedFilter: musicnetAccompaniedViolin?.selectedFilter || {},
        development: musicnetAccompaniedViolin?.development || {},
        holdout: musicnetAccompaniedViolin?.holdout || {},
        gateChecks: musicnetAccompaniedViolin?.holdoutGateChecks || {},
        ready: accompaniedViolinRecognitionReady,
        studentReleaseEligible: false,
      },
      accompaniedViolinChallenger: {
        reportAvailable: yourmt3ReportAvailable,
        selectedCandidate: musicnetYourmt3?.selectedCandidate || {},
        holdout: musicnetYourmt3?.holdout || {},
        gateChecks: musicnetYourmt3?.holdoutGateChecks || {},
        timingCalibrationProbe: musicnetYourmt3?.timingCalibrationProbe || {},
        recognitionReady: yourmt3RecognitionReady,
        productionAdoptionReady: musicnetYourmt3?.productionAdoptionReady === true,
        studentReleaseEligible: false,
        blockers: musicnetYourmt3?.blockingReasons || [],
      },
      postprocessing: muscFresh?.postprocessing || muscCalibration?.selectedPostprocessing || {},
      coreMetrics: muscFresh?.aggregate?.monophonicCore?.musc || {},
      doubleStopStressMetrics: muscFresh?.aggregate?.doubleStopStressReviewOnly?.musc || {},
    },
    weakLabels: {
      reportAvailable: Boolean(violinMidiAudit),
      sourceReady: weakLabelSourceReady,
      independentRecognitionBenchmarkReady,
      counts: violinMidiAudit?.counts || {},
      blockers: violinMidiAudit?.benchmarkBlockers || [],
    },
    gates: {
      publicProfessionalMonophonicV2CandidateReady,
      publicProfessionalMonophonicV3Ready,
      doubleStopAutoFeedbackReady,
      accompaniedViolinRecognitionReady,
      studentReleaseEligible: false,
      nearPerfectReady: false,
    },
    blockingReasons: [...new Set(blockingReasons)],
  };
}

function isM3PlusReviewed(row) {
  return [
    "audioScoreMatch",
    "observedPitchBehavior",
    "pitchJudgementMode",
    "pitchJudgeable",
    "pitchAccuracyLabel",
    "reviewConfidence",
    "reviewComments",
  ].some((field) => String(row[field] || "").trim() !== "");
}

function isM3PlusScored(row) {
  return (
    String(row.audioScoreMatch || "").trim() === "match"
    && String(row.pitchJudgeable || "").trim() === "yes"
    && ["in-tune", "sharp", "flat", "wrong-note"].includes(String(row.pitchAccuracyLabel || "").trim())
  );
}

function m3plusLabelKey(row = {}) {
  return [
    "recordingId",
    "scenario",
    "noteIndex",
    "noteId",
    "candidateMode",
    "flags",
    "predictedOnsetSeconds",
  ].map((field) => String(row[field] || "").trim()).join("::");
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const key = String(row[field] || "blank").trim() || "blank";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

async function buildM3PlusStatus() {
  const sourceRows = await readCsv(M3PLUS_SOURCE);
  const labelRows = await readCsv(M3PLUS_LABELS);
  const modeEval = await readJson(M3PLUS_MODE_EVAL);
  const coarseStateEval = await readJson(M3PLUS_COARSE_STATE_EVAL);
  const monitoredPilotAudit = await readJson(M3PLUS_MONITORED_PILOT_AUDIT);
  const localizationDiagnosis = await readJson(M3PLUS_LOCALIZATION_DIAGNOSIS);
  const round2AlignedEval = await readJson(M3PLUS_ROUND2_ALIGNED_EVAL);
  const round2FeatureDiagnostic = await readJson(M3PLUS_ROUND2_TRILL_VIBRATO_DIAGNOSTIC);
  const supplementalStatus = await readJson(M3PLUS_SUPPLEMENTAL_STATUS);
  const supplementalEval = await readJson(M3PLUS_SUPPLEMENTAL_EVAL);
  const supplementalProtocolDiagnostic = await readJson(M3PLUS_PROTOCOL_ORDER_DIAGNOSTIC);
  const supplementalFeatureAudit = await readJson(M3PLUS_FEATURE_SEPARABILITY_AUDIT);
  const supplementalBackendConsensus = await readJson(M3PLUS_BACKEND_CONSENSUS);
  const rescopeGate = await readJson(M3PLUS_RESCOPE_GATE);
  const supplementalRecordings = Array.isArray(supplementalEval?.recordings)
    ? supplementalEval.recordings
    : [];
  const straightControlRecording = supplementalRecordings.find(
    (recording) => recording?.recordingId === "m3p-01",
  );
  const straightControlRows = Array.isArray(straightControlRecording?.rows)
    ? straightControlRecording.rows
    : [];
  const straightNegativeControlReady = Boolean(
    straightControlRecording?.status === "ok"
    && straightControlRecording?.localization?.ready === true
    && straightControlRows.length >= 4
    && straightControlRows.every((row) => (
      row?.expectedBehavior === "stable"
      && row?.localizationUnitReady === true
      && row?.modeDiagnostics?.f0QualityReady === true
      && (row?.predictedModes || []).length === 0
    )),
  );
  const ornamentRealSamplePresent = supplementalRecordings.some((recording) => (
    Array.isArray(recording?.rows)
    && recording.rows.some((row) => (row?.expectedPositiveModes || []).includes("ornament"))
  ));
  const normalizeCurrentM3PlusReasons = (reasons) => [...new Set(
    (reasons || [])
      .filter((reason) => !(
        reason === "m3plus-round2-negative-controls-missing"
        && straightNegativeControlReady
      ))
      .map((reason) => (
        reason === "m3plus-ornament-real-sample-missing" && ornamentRealSamplePresent
          ? "m3plus-ornament-real-sample-not-validated"
          : reason
      )),
  )];
  const supplementalRepairPlans = supplementalRecordings.map((recording) => {
    const rows = Array.isArray(recording?.rows) ? recording.rows : [];
    const unresolvedUnits = rows
      .filter((row) => (
        row?.localizationUnitReady !== true
        || row?.modeDiagnostics?.f0QualityReady !== true
      ))
      .map((row) => ({
        unitNumber: Number(row?.unitIndex ?? -1) + 1,
        measure: Number(row?.measure || 0) || null,
        evaluationSplit: row?.evaluationSplit || "unknown",
        expectedBehavior: row?.expectedBehavior || "unknown",
        localizationReady: row?.localizationUnitReady === true,
        f0QualityReady: row?.modeDiagnostics?.f0QualityReady === true,
      }));
    return {
      recordingId: recording?.recordingId || "unknown",
      retainedUnitCount: Math.max(0, rows.length - unresolvedUnits.length),
      unresolvedUnitCount: unresolvedUnits.length,
      unresolvedUnits,
      fullRerecordRequired: recording?.status === "audio-missing"
        || recording?.status === "analysis-failed",
      targetedRepairOnly: rows.length > 0 && unresolvedUnits.length > 0,
    };
  });
  const candidateQualityReviewPageExists = await exists(M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE);
  const candidateQualityCompletedExists = await exists(M3PLUS_CANDIDATE_QUALITY_COMPLETED);
  const allSourceRows = [...sourceRows];
  const sourceKeys = new Set(sourceRows.map(m3plusLabelKey).filter(Boolean));
  for (const row of labelRows) {
    const key = m3plusLabelKey(row);
    if (key && !sourceKeys.has(key)) {
      allSourceRows.push(row);
      sourceKeys.add(key);
    }
  }
  const labelKeys = new Set(labelRows.map(m3plusLabelKey).filter(Boolean));
  const reviewedRows = labelRows.filter((row) => sourceKeys.has(m3plusLabelKey(row)) && isM3PlusReviewed(row));
  const scoredRows = reviewedRows.filter(isM3PlusScored);
  const sourceModeCounts = countBy(allSourceRows, "candidateMode");
  const reviewedModeCounts = countBy(reviewedRows, "candidateMode");
  const scoredModeCounts = countBy(scoredRows, "candidateMode");
  const minReviewedPerMode = 5;
  const minScoredPerMode = 3;
  const perMode = {};
  for (const mode of Object.keys(sourceModeCounts).sort()) {
    const reviewed = reviewedModeCounts[mode] || 0;
    const scored = scoredModeCounts[mode] || 0;
    perMode[mode] = {
      total: sourceModeCounts[mode],
      reviewed,
      scored,
      reviewedDeficit: Math.max(0, minReviewedPerMode - reviewed),
      scoredDeficit: Math.max(0, minScoredPerMode - scored),
    };
  }
  const labelBlockingReasons = [];
  if (!(await exists(M3PLUS_SOURCE))) labelBlockingReasons.push("m3plus-review-source-missing");
  if (!(await exists(M3PLUS_LABELS))) labelBlockingReasons.push("m3plus-review-labels-missing");
  if (!(await exists(M3PLUS_COMPLETED))) labelBlockingReasons.push("m3plus-review-completed-csv-missing");
  if (Object.values(perMode).some((item) => item.reviewedDeficit > 0)) {
    labelBlockingReasons.push("m3plus-review-reviewed-per-mode-too-low");
  }
  if (Object.values(perMode).some((item) => item.scoredDeficit > 0)) {
    labelBlockingReasons.push("m3plus-review-scored-per-mode-too-low");
  }
  const labelReady = labelBlockingReasons.length === 0;
  const modeEvalExists = Boolean(modeEval);
  const historicalModeReleaseReady = Boolean(modeEval?.m3plusModeReleaseReady);
  const round2AlignedEvalExists = Boolean(round2AlignedEval);
  const round2ReleaseEvidenceReady = round2AlignedEval?.releaseEvidenceReady === true;
  const independentModeEvidenceReady = ["slide", "trill"].every(
    (mode) => supplementalBackendConsensus?.modes?.[mode]?.releaseReady === true,
  );
  const historicalCombinedModeReleaseReady = historicalModeReleaseReady
    && round2ReleaseEvidenceReady
    && independentModeEvidenceReady;
  const rescopeGateExists = Boolean(rescopeGate);
  const rescopeContractReady = rescopeGate?.schemaVersion === M3PLUS_RESCOPE_SCHEMA_VERSION
    && rescopeGate?.contract === M3PLUS_RESCOPE_CONTRACT;
  const monitoredAuditContractReady = monitoredPilotAudit?.schemaVersion === M3PLUS_RESCOPE_SCHEMA_VERSION
    && monitoredPilotAudit?.contract === M3PLUS_RESCOPE_CONTRACT
    && monitoredPilotAudit?.runtimeContract === M3PLUS_RUNTIME_CONTRACT;
  const monitoredAuditPhysicalEvidence = await auditM3PlusPhysicalEvidenceCurrent(monitoredPilotAudit);
  const monitoredAuditBlockingReasons = [...new Set([
    ...(monitoredPilotAudit?.blockingReasons || []),
    ...monitoredAuditPhysicalEvidence.blockingReasons,
    ...(monitoredPilotAudit && !monitoredAuditContractReady
      ? ["m3plus-monitored-pilot-audit-v2-contract-not-ready"]
      : []),
  ])];
  const offlineEvidenceReady = monitoredAuditContractReady
    && monitoredPilotAudit?.offlineEvidenceReady === true
    && rescopeContractReady
    && rescopeGate?.releaseGateReady === true;
  const runtimeFoundationReady = monitoredAuditContractReady
    && monitoredPilotAudit?.runtimeFoundationReady === true
    && monitoredAuditPhysicalEvidence.ready === true;
  const reviewOnlyRuntimeWired = runtimeFoundationReady
    && monitoredPilotAudit?.runtimeEvidence?.runtime?.reviewOnlyRuntimeWired === true;
  const runtimeAuditReady = monitoredAuditContractReady
    && monitoredPilotAudit?.runtimeAuditReady === true;
  const trackAuthorization = await evaluateTrackAuthorization("m3plus");
  const authorizationReady = trackAuthorization.ready;
  const studentGateReady = false;
  const pitchSafetyReady = offlineEvidenceReady
    && reviewOnlyRuntimeWired
    && runtimeFoundationReady
    && runtimeAuditReady
    && monitoredPilotAudit?.readyForMonitoredPilot === true
    && monitoredAuditBlockingReasons.length === 0;
  const modeReleaseReady = pitchSafetyReady;
  const modeEvalBlockingReasons = [];
  if (labelReady && !modeEvalExists) {
    modeEvalBlockingReasons.push("m3plus-mode-eval-missing");
  } else if (labelReady && !historicalModeReleaseReady) {
    modeEvalBlockingReasons.push(...(modeEval?.blockingReasons || ["m3plus-no-mode-specific-release-ready"]));
    if (localizationDiagnosis?.summary?.nonMatch) {
      modeEvalBlockingReasons.push("m3plus-localization-candidate-quality-blocker");
    }
  }
  if (!round2AlignedEvalExists) {
    modeEvalBlockingReasons.push("m3plus-round2-aligned-eval-missing");
  } else if (!round2ReleaseEvidenceReady) {
    modeEvalBlockingReasons.push(...(
      round2AlignedEval?.blockingReasons || ["m3plus-round2-release-evidence-not-ready"]
    ));
  }
  if (!supplementalBackendConsensus) {
    modeEvalBlockingReasons.push("m3plus-independent-backend-consensus-missing");
  } else {
    for (const mode of ["slide", "trill"]) {
      const evidence = supplementalBackendConsensus?.modes?.[mode];
      if (!evidence) {
        modeEvalBlockingReasons.push(`m3plus-independent-mode-evidence-missing:${mode}`);
      } else if (evidence.releaseReady !== true) {
        modeEvalBlockingReasons.push(`m3plus-independent-mode-not-ready:${mode}`);
      }
    }
  }
  if (!supplementalStatus?.readyForMachineAnalysis) {
    modeEvalBlockingReasons.push("m3plus-supplemental-recordings-not-ready");
  } else if (!supplementalEval) {
    modeEvalBlockingReasons.push("m3plus-supplemental-machine-eval-missing");
  } else if (supplementalEval.machineAnalysisComplete !== true) {
    modeEvalBlockingReasons.push(...(
      supplementalEval.blockingReasons || ["m3plus-supplemental-machine-analysis-incomplete"]
    ));
  } else {
    if (supplementalEval.machineModeThresholdPassed !== true) {
      modeEvalBlockingReasons.push("m3plus-supplemental-mode-threshold-failed");
    }
    if (supplementalEval.performanceConfirmedByOwner !== true) {
      modeEvalBlockingReasons.push("m3plus-supplemental-performance-intent-unconfirmed");
    }
  }
  if (supplementalEval && supplementalEval.scoreTechniqueIntentReady !== true) {
    modeEvalBlockingReasons.push("m3plus-supplemental-score-technique-intent-invalid");
  }
  const currentModeEvalBlockingReasons = normalizeCurrentM3PlusReasons(modeEvalBlockingReasons);
  const blockingReasons = [...new Set([
    ...(!rescopeGateExists ? ["m3plus-rescope-gate-missing"] : []),
    ...(rescopeGateExists && !rescopeContractReady
      ? ["m3plus-rescope-v2-contract-not-ready"]
      : []),
    ...(rescopeGate?.blockingReasons || []),
    ...(!monitoredPilotAudit ? ["m3plus-monitored-pilot-audit-missing"] : []),
    ...(monitoredPilotAudit && !monitoredAuditContractReady
      ? ["m3plus-monitored-pilot-audit-v2-contract-not-ready"]
      : []),
    ...monitoredAuditBlockingReasons,
    ...((rescopeGate?.zones?.scoreMarkedNeutral?.declaredOnlyProtectedCount || 0) > 0
      ? ["m3plus-rescope-score-marked-declared-only-not-evaluated"]
      : []),
    ...(rescopeGate?.zones?.techniqueCenter?.goldJoinReady !== true
      ? ["m3plus-rescope-center-intonation-gold-join-missing"]
      : []),
    ...(!reviewOnlyRuntimeWired ? ["m3plus-review-only-runtime-not-wired"] : []),
    ...(!runtimeAuditReady ? ["m3plus-runtime-audit-not-ready"] : []),
    ...(!authorizationReady
      ? ["m3plus-authorization-closed", ...trackAuthorization.blockingReasons]
      : []),
    ...(!studentGateReady ? ["m3plus-student-gate-closed"] : []),
  ])];
  return {
    ok: true,
    m3plusModeEvalReady: rescopeGateExists,
    offlineEvidenceReady,
    reviewOnlyRuntimeWired,
    runtimeFoundationReady,
    runtimeAuditReady,
    physicalEvidenceCurrent: monitoredAuditPhysicalEvidence.ready === true,
    authorizationReady,
    m3plusPitchSafetyReady: pitchSafetyReady,
    m3plusModeReleaseReady: modeReleaseReady,
    studentGateReady,
    reason: pitchSafetyReady
      ? "m3plus-offline-and-review-only-runtime-audits-ready"
      : "m3plus-offline-or-review-only-runtime-audit-fail-closed",
    counts: {
      rowCount: sourceRows.length,
      cumulativeRowCount: allSourceRows.length,
      labelRows: labelRows.length,
      reviewedRows: reviewedRows.length,
      scoredRows: scoredRows.length,
      missingLabelRows: Math.max(0, allSourceRows.length - labelKeys.size),
    },
    perMode,
    rescopeGate: rescopeGate ? {
      source: M3PLUS_RESCOPE_GATE.replace(/\\/g, "/"),
      sourceExists: true,
      schemaVersion: rescopeGate.schemaVersion ?? null,
      contract: rescopeGate.contract || null,
      contractReady: rescopeContractReady,
      evalOnly: rescopeGate.evalOnly === true,
      releaseGateReady: rescopeGate.releaseGateReady === true,
      studentGateReady: false,
      productionPolicyChanged: rescopeGate.productionPolicyChanged === true,
      thresholds: rescopeGate.thresholds || {},
      sourceEvidence: rescopeGate.sourceEvidence || {},
      zones: rescopeGate.zones || {},
      blockingReasons: rescopeGate.blockingReasons || [],
    } : {
      source: M3PLUS_RESCOPE_GATE.replace(/\\/g, "/"),
      sourceExists: false,
      schemaVersion: null,
      contract: null,
      contractReady: false,
      evalOnly: true,
      releaseGateReady: false,
      studentGateReady: false,
      productionPolicyChanged: false,
      thresholds: {},
      sourceEvidence: {},
      zones: {},
      blockingReasons: ["m3plus-rescope-gate-missing"],
    },
    modeEval: {
      source: M3PLUS_MODE_EVAL.replace(/\\/g, "/"),
      sourceExists: modeEvalExists,
      researchOnly: true,
      releaseAuthority: false,
      m3plusModeReleaseReady: historicalCombinedModeReleaseReady,
      releaseReadyModes: modeEval?.releaseReadyModes || [],
      controlReadyModes: modeEval?.controlReadyModes || [],
      counts: modeEval?.counts || {},
      blockingReasons: [...new Set([
        ...(modeEval?.blockingReasons || []),
        ...modeEvalBlockingReasons,
      ])],
    },
    coarseStateEval: coarseStateEval ? {
      source: M3PLUS_COARSE_STATE_EVAL.replace(/\\/g, "/"),
      sourceExists: true,
      joinReady: coarseStateEval?.joinDiagnostics?.joinReady === true,
      eligibleMatchedRows: Number(coarseStateEval?.joinDiagnostics?.eligibleMatchedRows || 0),
      behaviorCounts: coarseStateEval?.behaviorCounts || {},
      tasks: coarseStateEval?.tasks || {},
      coarseStateRuntimeReady: coarseStateEval?.coarseStateRuntimeReady === true,
      studentGateReady: false,
      blockingReasons: coarseStateEval?.blockingReasons || [],
    } : {
      source: M3PLUS_COARSE_STATE_EVAL.replace(/\\/g, "/"),
      sourceExists: false,
      joinReady: false,
      eligibleMatchedRows: 0,
      behaviorCounts: {},
      tasks: {},
      coarseStateRuntimeReady: false,
      studentGateReady: false,
      blockingReasons: ["m3plus-coarse-state-eval-missing"],
    },
    round2AlignedEval: round2AlignedEval ? {
      source: M3PLUS_ROUND2_ALIGNED_EVAL.replace(/\\/g, "/"),
      sourceExists: true,
      humanVerifiedPerformanceGold: round2AlignedEval.humanVerifiedPerformanceGold === true,
      negativeControlAvailable: round2AlignedEval.negativeControlAvailable === true,
      releaseThreshold: round2AlignedEval.releaseThreshold ?? null,
      thresholdChecks: round2AlignedEval.thresholdChecks || {},
      machineThresholdPassed: round2AlignedEval.machineThresholdPassed === true,
      releaseEvidenceReady: round2ReleaseEvidenceReady,
      studentGateReady: round2AlignedEval.studentGateReady === true,
      blockingReasons: round2AlignedEval.blockingReasons || [],
    } : {
      source: M3PLUS_ROUND2_ALIGNED_EVAL.replace(/\\/g, "/"),
      sourceExists: false,
      humanVerifiedPerformanceGold: false,
      negativeControlAvailable: false,
      releaseThreshold: null,
      thresholdChecks: {},
      machineThresholdPassed: false,
      releaseEvidenceReady: false,
      studentGateReady: false,
      blockingReasons: ["m3plus-round2-aligned-eval-missing"],
    },
    round2FeatureDiagnostic: round2FeatureDiagnostic ? {
      source: M3PLUS_ROUND2_TRILL_VIBRATO_DIAGNOSTIC.replace(/\\/g, "/"),
      sourceExists: true,
      evaluationLevel: round2FeatureDiagnostic.evaluationLevel || "unknown",
      releaseEvidence: round2FeatureDiagnostic.releaseEvidence === true,
      studentGateReady: round2FeatureDiagnostic.studentGateReady === true,
      goldCounts: round2FeatureDiagnostic.goldCounts || {},
      goldCountConsistent: round2FeatureDiagnostic.goldCountConsistent === true,
      dtwWindowDiagnostics: {
        matchedNoteCount: round2FeatureDiagnostic.dtwWindowDiagnostics?.matchedNoteCount ?? null,
        unmatchedNoteCount: round2FeatureDiagnostic.dtwWindowDiagnostics?.unmatchedNoteCount ?? null,
        implausibleWindowCount: round2FeatureDiagnostic.dtwWindowDiagnostics?.implausibleWindowCount ?? null,
        implausibleWindowRate: round2FeatureDiagnostic.dtwWindowDiagnostics?.implausibleWindowRate ?? null,
      },
      bestTrainingOnlyFeatures:
        round2FeatureDiagnostic.featureDiagnostics?.trainingOnlySingleFeatureThresholds?.slice(0, 3) || [],
      blockingReasons: round2FeatureDiagnostic.blockingReasons || [],
    } : {
      source: M3PLUS_ROUND2_TRILL_VIBRATO_DIAGNOSTIC.replace(/\\/g, "/"),
      sourceExists: false,
      evaluationLevel: "missing",
      releaseEvidence: false,
      studentGateReady: false,
      goldCounts: {},
      goldCountConsistent: false,
      dtwWindowDiagnostics: {},
      bestTrainingOnlyFeatures: [],
      blockingReasons: ["m3plus-round2-trill-vibrato-diagnostic-missing"],
    },
    supplementalIntake: supplementalStatus ? {
      source: M3PLUS_SUPPLEMENTAL_STATUS.replace(/\\/g, "/"),
      sourceExists: true,
      recordingCount: supplementalStatus.recordingCount ?? 0,
      readyRecordingCount: supplementalStatus.readyRecordingCount ?? 0,
      missingRecordingCount: supplementalStatus.missingRecordingCount ?? 0,
      readyForMachineAnalysis: supplementalStatus.readyForMachineAnalysis === true,
      humanTask: supplementalStatus.humanTask || "record-m3plus-supplemental-takes",
      blockingReasons: supplementalStatus.blockingReasons || [],
      instructions: supplementalStatus.instructions || "",
      scoreIntent: supplementalStatus.scoreIntent || "",
    } : {
      source: M3PLUS_SUPPLEMENTAL_STATUS.replace(/\\/g, "/"),
      sourceExists: false,
      recordingCount: 0,
      readyRecordingCount: 0,
      missingRecordingCount: 4,
      readyForMachineAnalysis: false,
      humanTask: "generate-and-record-m3plus-supplemental-takes",
      blockingReasons: ["m3plus-supplemental-status-missing"],
      instructions: "",
      scoreIntent: "",
    },
    supplementalMachineEval: supplementalEval ? {
      source: M3PLUS_SUPPLEMENTAL_EVAL.replace(/\\/g, "/"),
      sourceExists: true,
      f0Backend: supplementalEval.f0Backend || "unknown",
      scoreTechniqueIntentReady: supplementalEval.scoreTechniqueIntentReady === true,
      machineAnalysisComplete: supplementalEval.machineAnalysisComplete === true,
      machineModeThresholdPassed: supplementalEval.machineModeThresholdPassed === true,
      performanceConfirmedByOwner: supplementalEval.performanceConfirmedByOwner === true,
      teacherReviewAllowed: supplementalEval.teacherReviewAllowed === true,
      studentGateReady: false,
      humanTask: supplementalEval.humanTask || "none",
      counts: supplementalEval.counts || {},
      modeMetrics: supplementalEval.modeMetrics || {},
      recordings: Array.isArray(supplementalEval.recordings)
        ? supplementalEval.recordings.map((recording) => ({
          recordingId: recording?.recordingId || "unknown",
          status: recording?.status || "unknown",
          localizationReady: recording?.localization?.ready === true,
          readyUnitCount: recording?.localization?.readyUnitCount ?? 0,
          unitCount: recording?.localization?.unitCount ?? 0,
          scoreTransposeSemitones: recording?.localization?.scoreTransposeSemitones ?? null,
        }))
        : [],
      straightNegativeControlReady,
      ornamentRealSamplePresent,
      repairPlans: supplementalRepairPlans,
      blockingReasons: supplementalEval.blockingReasons || [],
    } : {
      source: M3PLUS_SUPPLEMENTAL_EVAL.replace(/\\/g, "/"),
      sourceExists: false,
      f0Backend: "unknown",
      scoreTechniqueIntentReady: false,
      machineAnalysisComplete: false,
      machineModeThresholdPassed: false,
      performanceConfirmedByOwner: false,
      teacherReviewAllowed: false,
      studentGateReady: false,
      humanTask: supplementalStatus?.readyForMachineAnalysis
        ? "run-m3plus-supplemental-machine-eval"
        : "record-m3plus-supplemental-takes",
      counts: {},
      modeMetrics: {},
      recordings: [],
      straightNegativeControlReady: false,
      ornamentRealSamplePresent: false,
      repairPlans: [],
      blockingReasons: ["m3plus-supplemental-machine-eval-missing"],
    },
    supplementalProtocolDiagnostic: supplementalProtocolDiagnostic ? {
      source: M3PLUS_PROTOCOL_ORDER_DIAGNOSTIC.replace(/\\/g, "/"),
      sourceExists: true,
      postHocProtocolInference: supplementalProtocolDiagnostic.postHocProtocolInference === true,
      bestLocalizationCandidate: supplementalProtocolDiagnostic.bestLocalizationCandidate || "unknown",
      decision: supplementalProtocolDiagnostic.decision || "unknown",
      candidates: supplementalProtocolDiagnostic.candidates || [],
      featureAudit: supplementalProtocolDiagnostic.featureAudit || {},
      multivariateAudit: supplementalProtocolDiagnostic.multivariateAudit || {},
      boundaryRefinementAudit:
        supplementalProtocolDiagnostic.boundaryRefinementAudit || {},
      sessionPitchBaseline: supplementalProtocolDiagnostic.sessionPitchBaseline || {},
      scoreAdherenceSummary: supplementalProtocolDiagnostic.scoreAdherenceSummary || {},
      scoreAdherenceIssueCandidates:
        supplementalProtocolDiagnostic.scoreAdherenceIssueCandidates || [],
    } : {
      source: M3PLUS_PROTOCOL_ORDER_DIAGNOSTIC.replace(/\\/g, "/"),
      sourceExists: false,
      postHocProtocolInference: false,
      bestLocalizationCandidate: "unknown",
      decision: "protocol-order-diagnostic-missing",
      candidates: [],
      featureAudit: {},
      multivariateAudit: {},
      boundaryRefinementAudit: {},
      sessionPitchBaseline: {},
      scoreAdherenceSummary: {},
      scoreAdherenceIssueCandidates: [],
    },
    supplementalFeatureAudit: supplementalFeatureAudit ? {
      source: M3PLUS_FEATURE_SEPARABILITY_AUDIT.replace(/\\/g, "/"),
      sourceExists: true,
      minimumPerClassPerSplit: supplementalFeatureAudit.minimumPerClassPerSplit ?? 4,
      anyFeaturePassesHeldoutGate: supplementalFeatureAudit.anyFeaturePassesHeldoutGate === true,
      decision: supplementalFeatureAudit.decision || "unknown",
      modes: supplementalFeatureAudit.modes || {},
    } : {
      source: M3PLUS_FEATURE_SEPARABILITY_AUDIT.replace(/\\/g, "/"),
      sourceExists: false,
      minimumPerClassPerSplit: 4,
      anyFeaturePassesHeldoutGate: false,
      decision: "feature-separability-audit-missing",
      modes: {},
    },
    supplementalBackendConsensus: supplementalBackendConsensus ? {
      source: M3PLUS_BACKEND_CONSENSUS.replace(/\\/g, "/"),
      sourceExists: true,
      anyModeReleaseReady: supplementalBackendConsensus.anyModeReleaseReady === true,
      studentFacing: supplementalBackendConsensus.studentFacing === true,
      productionPolicyChanged: supplementalBackendConsensus.productionPolicyChanged === true,
      modes: supplementalBackendConsensus.modes || {},
      independentReleaseModesReady: independentModeEvidenceReady,
    } : {
      source: M3PLUS_BACKEND_CONSENSUS.replace(/\\/g, "/"),
      sourceExists: false,
      anyModeReleaseReady: false,
      studentFacing: false,
      productionPolicyChanged: false,
      modes: {},
      independentReleaseModesReady: false,
    },
    monitoredPilotAudit: monitoredPilotAudit ? {
      source: M3PLUS_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
      sourceExists: true,
      schemaVersion: monitoredPilotAudit.schemaVersion ?? null,
      ok: monitoredPilotAudit.ok === true,
      offlineEvidenceReady,
      reviewOnlyRuntimeWired,
      runtimeFoundationReady,
      runtimeAuditReady,
      authorizationReady,
      studentGateReady,
      readyForMonitoredPilot: monitoredPilotAudit.readyForMonitoredPilot === true
        && pitchSafetyReady,
      teacherReviewNeeded: monitoredPilotAudit.teacherReviewNeeded === true,
      defaultM3PlusReadyAfter: monitoredPilotAudit.defaultM3PlusReadyAfter === true,
      contract: monitoredPilotAudit.contract || null,
      runtimeContract: monitoredPilotAudit.runtimeContract || null,
      runtimePolicyVersion: monitoredPilotAudit.runtimePolicyVersion || null,
      physicalEvidenceCurrent: monitoredAuditPhysicalEvidence.ready === true,
      physicalEvidenceAudit: monitoredAuditPhysicalEvidence,
      runtimeEvidence: monitoredPilotAudit.runtimeEvidence || {},
      zones: monitoredPilotAudit.zones || {},
      releaseModes: monitoredPilotAudit.releaseModes || {},
      blockedModes: monitoredPilotAudit.blockedModes || [],
      blockingReasons: monitoredAuditBlockingReasons,
    } : {
      source: M3PLUS_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
      sourceExists: false,
      schemaVersion: null,
      ok: false,
      offlineEvidenceReady: false,
      reviewOnlyRuntimeWired: false,
      runtimeFoundationReady: false,
      runtimeAuditReady: false,
      authorizationReady: false,
      studentGateReady: false,
      readyForMonitoredPilot: false,
      teacherReviewNeeded: false,
      defaultM3PlusReadyAfter: false,
      contract: null,
      runtimeContract: null,
      runtimePolicyVersion: null,
      physicalEvidenceCurrent: false,
      physicalEvidenceAudit: monitoredAuditPhysicalEvidence,
      runtimeEvidence: {},
      zones: {},
      releaseModes: {},
      blockedModes: [],
      blockingReasons: ["m3plus-monitored-pilot-audit-missing"],
    },
    localizationDiagnosis: {
      source: M3PLUS_LOCALIZATION_DIAGNOSIS.replace(/\\/g, "/"),
      sourceExists: Boolean(localizationDiagnosis),
      summary: localizationDiagnosis?.summary || {},
      highRiskGroups: localizationDiagnosis?.highRiskGroups || [],
    },
    candidateQualityReview: {
      reviewPage: M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE.replace(/\\/g, "/"),
      sourceCsv: M3PLUS_CANDIDATE_QUALITY_SOURCE.replace(/\\/g, "/"),
      completedCsv: M3PLUS_CANDIDATE_QUALITY_COMPLETED.replace(/\\/g, "/"),
      reviewPageExists: candidateQualityReviewPageExists,
      completedCsvExists: candidateQualityCompletedExists,
      needsReview: candidateQualityReviewPageExists && !candidateQualityCompletedExists,
    },
    labelBlockingReasons,
    researchOnlyDetectorBlockingReasons: [
      ...labelBlockingReasons,
      ...currentModeEvalBlockingReasons,
    ],
    blockingReasons,
    reviewArtifacts: {
      reviewPage: M3PLUS_REVIEW_PAGE.replace(/\\/g, "/"),
      completedCsv: M3PLUS_COMPLETED.replace(/\\/g, "/"),
      labelsCsv: M3PLUS_LABELS.replace(/\\/g, "/"),
      modeEvalJson: M3PLUS_MODE_EVAL.replace(/\\/g, "/"),
      coarseStateEvalJson: M3PLUS_COARSE_STATE_EVAL.replace(/\\/g, "/"),
      monitoredPilotAuditJson: M3PLUS_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
      modeEvalCsv: M3PLUS_MODE_EVAL_CSV.replace(/\\/g, "/"),
      localizationDiagnosisJson: M3PLUS_LOCALIZATION_DIAGNOSIS.replace(/\\/g, "/"),
      localizationDiagnosisGroupsCsv: M3PLUS_LOCALIZATION_GROUPS_CSV.replace(/\\/g, "/"),
      localizationDiagnosisRowsCsv: M3PLUS_LOCALIZATION_ROWS_CSV.replace(/\\/g, "/"),
      round2ReviewPage: M3PLUS_ROUND2_REVIEW_PAGE.replace(/\\/g, "/"),
      round2SourceCsv: M3PLUS_ROUND2_SOURCE.replace(/\\/g, "/"),
      round2CompletedCsv: M3PLUS_ROUND2_COMPLETED.replace(/\\/g, "/"),
      round2AlignedEvalJson: M3PLUS_ROUND2_ALIGNED_EVAL.replace(/\\/g, "/"),
      round2TrillVibratoDiagnosticJson: M3PLUS_ROUND2_TRILL_VIBRATO_DIAGNOSTIC.replace(/\\/g, "/"),
      supplementalStatusJson: M3PLUS_SUPPLEMENTAL_STATUS.replace(/\\/g, "/"),
      supplementalMachineEvalJson: M3PLUS_SUPPLEMENTAL_EVAL.replace(/\\/g, "/"),
      supplementalBackendConsensusJson: M3PLUS_BACKEND_CONSENSUS.replace(/\\/g, "/"),
      rescopeGateJson: M3PLUS_RESCOPE_GATE.replace(/\\/g, "/"),
      supplementalInstructions: supplementalStatus?.instructions || "",
      candidateQualityReviewPage: M3PLUS_CANDIDATE_QUALITY_REVIEW_PAGE.replace(/\\/g, "/"),
      candidateQualitySourceCsv: M3PLUS_CANDIDATE_QUALITY_SOURCE.replace(/\\/g, "/"),
      candidateQualityCompletedCsv: M3PLUS_CANDIDATE_QUALITY_COMPLETED.replace(/\\/g, "/"),
    },
  };
}

async function auditOrdinaryReviewAssistRuntime() {
  const batchRunsPath = "data/experiments/western-strings-m3/controlled-submission-batch-runs.jsonl";
  const batchRead = await readWorkspaceArtifact(batchRunsPath);
  const blockingReasons = [];
  let latestRun = null;
  if (batchRead.status === "ok") {
    const lines = batchRead.bytes.toString("utf8").replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      latestRun = lines.length ? JSON.parse(lines.at(-1)) : null;
    } catch {
      blockingReasons.push("ordinary-review-assist-latest-batch-invalid-json");
    }
  } else {
    blockingReasons.push(`ordinary-review-assist-batch-runs-${batchRead.status}`);
  }
  if (!latestRun) blockingReasons.push("ordinary-review-assist-latest-batch-missing");

  const audit = latestRun
    ? auditControlledBatchRuns([latestRun], {
        requireFeatureReview: true,
        requireM3PlusRuntime: true,
        sourceRoot: process.cwd(),
        latestOnly: true,
      })
    : null;
  if (audit?.ok !== true) {
    blockingReasons.push(...(audit?.failures || []).map(
      (failure) => `ordinary-review-assist-latest-batch-audit:${failure.code || "unknown"}`,
    ));
  }
  const latestItem = (Array.isArray(latestRun?.items) ? latestRun.items : [])
    .filter((item) => item?.kind !== "photo-score" && item?.analysisStatus === "offline_feature_review_ready")
    .at(-1) || null;
  const reviewAssist = latestItem?.candidateGate?.reviewAssist || null;
  if (!latestItem) blockingReasons.push("ordinary-review-assist-feature-review-item-missing");
  if (reviewAssist?.contract !== ORDINARY_REVIEW_ASSIST_CONTRACT) {
    blockingReasons.push("ordinary-review-assist-contract-invalid");
  }
  if (reviewAssist?.reviewerOnly !== true
      || reviewAssist?.studentFacing !== false
      || reviewAssist?.automaticAccusationAuthorized !== false) {
    blockingReasons.push("ordinary-review-assist-safety-boundary-invalid");
  }
  const outputCount = Number(reviewAssist?.outputCount ?? 0);
  const candidateAvailable = Number.isFinite(outputCount) && outputCount > 0;
  return {
    contract: ORDINARY_REVIEW_ASSIST_CONTRACT,
    source: batchRunsPath,
    ready: blockingReasons.length === 0,
    mechanismReady: blockingReasons.length === 0,
    candidateAvailable,
    readyForReview: blockingReasons.length === 0 && candidateAvailable,
    reviewerOnly: reviewAssist?.reviewerOnly === true,
    studentFacing: false,
    automaticAccusationAuthorized: false,
    batchRunId: latestRun?.batchRunId || null,
    candidateRowsPath: latestItem?.candidateRowsPath || null,
    candidateRowsSha256: latestItem?.candidateRowsSha256 || null,
    confirmedIssueCandidateCount: reviewAssist?.confirmedIssueCandidateCount ?? null,
    selfCheckHintCount: reviewAssist?.selfCheckHintCount ?? null,
    outputCount: reviewAssist?.outputCount ?? null,
    previewCount: Array.isArray(latestItem?.reviewAssistPreview) ? latestItem.reviewAssistPreview.length : 0,
    candidateAvailabilityReasons: candidateAvailable ? [] : ["ordinary-review-assist-current-batch-has-no-output"],
    blockingReasons: normalizedReasonList(blockingReasons),
  };
}

export async function auditRound5ReviewAssistCalibrationPack({
  ledgerPath = ROUND5_REVIEW_ASSIST_CALIBRATION_LEDGER,
  reviewPagePath = ROUND5_REVIEW_ASSIST_CALIBRATION_PAGE,
  completedPath = ROUND5_REVIEW_ASSIST_CALIBRATION_COMPLETED,
} = {}) {
  const [ledgerRead, pageRead, completedRead] = await Promise.all([
    readWorkspaceArtifact(ledgerPath),
    readWorkspaceArtifact(reviewPagePath),
    readWorkspaceArtifact(completedPath),
  ]);
  const blockingReasons = [];
  let ledger = null;
  if (ledgerRead.status === "ok") {
    try {
      ledger = JSON.parse(ledgerRead.bytes.toString("utf8"));
    } catch {
      blockingReasons.push("round5-review-assist-ledger-invalid-json");
    }
  } else {
    blockingReasons.push(`round5-review-assist-ledger-${ledgerRead.status}`);
  }
  const rows = Array.isArray(ledger?.rows) ? ledger.rows : [];
  const safetyBoundaryValid = Boolean(
    ledger?.schemaVersion === 1
      && ledger?.contract === ROUND5_REVIEW_ASSIST_CALIBRATION_CONTRACT
      && ledger?.scope === "teacher-reviewed-calibration-draft-only"
      && ledger?.calibrationOnly === true
      && ledger?.freshBlindEligible === false
      && rows.length > 0
      && rows.every((row) => (
        row?.calibrationOnly === true
          && row?.freshBlindEligible === false
          && ["confirmed_issue", "self_check_hint"].includes(row?.sourceSemantic)
      )),
  );
  if (ledger && !safetyBoundaryValid) {
    blockingReasons.push("round5-review-assist-safety-boundary-invalid");
  }
  if (ledger?.sourceSummary?.candidateCount !== rows.length) {
    blockingReasons.push("round5-review-assist-candidate-count-mismatch");
  }
  if (ledger?.sourceSummary?.sourceWarningCount !== 0
      || (ledger?.sourceWarnings || []).length !== 0) {
    blockingReasons.push("round5-review-assist-source-warnings-present");
  }
  const identityKeys = rows.map((row) => String(row?.identityKey || ""));
  if (identityKeys.some((key) => !key)
      || new Set(identityKeys).size !== identityKeys.length) {
    blockingReasons.push("round5-review-assist-identity-keys-invalid");
  }
  const frozenSource = ledger?.frozenSource || {};
  const frozenRead = frozenSource.path
    ? await readWorkspaceArtifact(frozenSource.path)
    : { status: "path-invalid", sha256: "" };
  const frozenSourceCurrent = Boolean(
    frozenRead.status === "ok"
      && String(frozenSource.sha256 || "").toLowerCase() === frozenRead.sha256
      && frozenSource.policyCReviewAssistGateReady === true,
  );
  if (ledger && !frozenSourceCurrent) {
    blockingReasons.push("round5-review-assist-frozen-source-stale");
  }
  const packRoot = path.dirname(String(ledgerPath));
  const safePackRelativePath = (value) => {
    const relative = String(value || "").trim();
    if (!relative || path.isAbsolute(relative)) return "";
    const resolved = path.normalize(path.join(packRoot, relative));
    const relation = path.relative(path.normalize(packRoot), resolved);
    return relation && !relation.startsWith(`..${path.sep}`) && relation !== ".."
      ? resolved
      : "";
  };
  const rowAudits = await Promise.all(rows.map(async (row, index) => {
    const localAudioPath = safePackRelativePath(row?.localAudioPath);
    const [candidate, audio, score, localAudio] = await Promise.all([
      readWorkspaceArtifact(row?.candidateRowsPath),
      readWorkspaceArtifact(row?.audioSourcePath),
      readWorkspaceArtifact(row?.scoreSourcePath),
      readWorkspaceArtifact(localAudioPath),
    ]);
    const candidateCurrent = candidate.status === "ok"
      && candidate.sha256 === String(row?.candidateRowsSha256 || "").toLowerCase();
    const audioCurrent = audio.status === "ok"
      && audio.sha256 === String(row?.audioSourceSha256 || "").toLowerCase()
      && audio.sha256 === String(row?.audioHash || "").toLowerCase();
    const scoreCurrent = score.status === "ok"
      && score.sha256 === String(row?.scoreSourceSha256 || "").toLowerCase();
    const localAudioCurrent = localAudio.status === "ok"
      && localAudio.sha256 === String(row?.audioSourceSha256 || "").toLowerCase();
    return {
      index,
      candidateCurrent,
      audioCurrent,
      scoreCurrent,
      localAudioCurrent,
      current: candidateCurrent && audioCurrent && scoreCurrent && localAudioCurrent,
    };
  }));
  for (const audit of rowAudits) {
    if (!audit.current) {
      blockingReasons.push(`round5-review-assist-row-source-stale:${audit.index}`);
    }
  }
  const pageCurrent = Boolean(
    pageRead.status === "ok"
      && ledgerRead.status === "ok"
      && pageRead.bytes.toString("utf8").includes(ledgerRead.sha256)
      && pageRead.bytes.toString("utf8").includes("Round 5 calibration 复核包")
      && pageRead.bytes.toString("utf8").includes("下载已完成 JSON"),
  );
  if (ledger && !pageCurrent) {
    blockingReasons.push("round5-review-assist-page-ledger-binding-stale");
  }
  let completed = null;
  let completedReviewValid = false;
  const reviewCompletionBlockingReasons = [];
  if (completedRead.status === "ok") {
    try {
      completed = JSON.parse(completedRead.bytes.toString("utf8"));
      completedReviewValid = Boolean(
        completed?.contract === ROUND5_REVIEW_ASSIST_CALIBRATION_CONTRACT
          && completed?.ledgerSha256 === ledgerRead.sha256
          && completed?.calibrationOnly === true
          && completed?.freshBlindEligible === false
          && Array.isArray(completed?.reviews)
          && completed.reviews.length === rows.length
      );
      if (!completedReviewValid) {
        reviewCompletionBlockingReasons.push("round5-review-assist-completed-review-invalid");
      }
    } catch {
      reviewCompletionBlockingReasons.push("round5-review-assist-completed-review-invalid-json");
    }
  } else {
    reviewCompletionBlockingReasons.push("round5-review-assist-human-review-pending");
  }
  const sourceCurrent = blockingReasons.length === 0;
  const playableCandidateCount = rowAudits.filter(
    (audit) => audit.audioCurrent && audit.localAudioCurrent,
  ).length;
  const semanticCounts = rows.reduce((counts, row) => {
    const semantic = String(row?.sourceSemantic || "");
    counts[semantic] = (counts[semantic] || 0) + 1;
    return counts;
  }, {});
  return {
    contract: ROUND5_REVIEW_ASSIST_CALIBRATION_CONTRACT,
    source: String(ledgerPath).replace(/\\/g, "/"),
    reviewPage: String(reviewPagePath).replace(/\\/g, "/"),
    completedReview: String(completedPath).replace(/\\/g, "/"),
    ledgerSha256: ledgerRead.sha256,
    sourceCurrent,
    safetyBoundaryValid,
    candidateAvailable: sourceCurrent && rows.length > 0,
    readyForReview: sourceCurrent
      && rows.length > 0
      && playableCandidateCount === rows.length,
    completedReviewPresent: completedRead.status === "ok",
    completedReviewValid,
    readyForStaging: sourceCurrent && completedReviewValid,
    counts: {
      candidates: rows.length,
      playableCandidates: playableCandidateCount,
      recordings: new Set(rows.map((row) => row?.recordingId).filter(Boolean)).size,
      confirmedIssues: semanticCounts.confirmed_issue || 0,
      selfCheckHints: semanticCounts.self_check_hint || 0,
      sourceRejectedArtifacts: Array.isArray(ledger?.rejectedArtifacts)
        ? ledger.rejectedArtifacts.length
        : 0,
    },
    calibrationOnly: true,
    freshBlindEligible: false,
    studentFacing: false,
    automaticAccusationReady: false,
    strictConfirmedRecallChanged: false,
    blockingReasons: normalizedReasonList(blockingReasons),
    reviewCompletionBlockingReasons:
      normalizedReasonList(reviewCompletionBlockingReasons),
  };
}

async function buildOrdinaryDynamicShadowStatus() {
  const runtime = evaluateOrdinaryAudioRuntime();
  const [
    acceptance,
    acceptanceArtifact,
    reviewAssistRuntime,
    reviewAssistCalibrationPack,
    round5PolicyCWaveformRobustness,
    round5TargetedIntake,
    round6CounterbalancedCapture,
  ] = await Promise.all([
    readJson(ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE),
    hashWorkspaceArtifact(ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE),
    auditOrdinaryReviewAssistRuntime(),
    auditRound5ReviewAssistCalibrationPack(),
    summarizeRound5PolicyCWaveformRobustness(),
    summarizeRound5TargetedIntake(),
    summarizeRound6CounterbalancedCapture(),
  ]);
  const acceptanceValidation = validateOrdinaryDynamicShadowAcceptance(acceptance);
  // The schema-valid report only stays green while the live-artifact verifier
  // re-confirms every artifact it cites on disk (hash, identity, and
  // policy-recomputable decisions). A forged or stale report fails closed.
  const liveArtifactAudit = acceptanceValidation.ready === true
    ? auditOrdinaryDynamicShadowAcceptanceLiveArtifacts({ acceptance, runtimeReport: runtime })
    : { ready: false, blockingReasons: ["ordinary-dynamic-shadow-r3-live-audit-skipped-schema-invalid"] };
  const r3AcceptanceReady = acceptanceValidation.ready === true && liveArtifactAudit.ready === true;
  // Fresh-blind evidence (a performer/voice never used to tune any threshold)
  // is a separate prerequisite for the release-v1 authorization; it is
  // re-derived from disk on every status build so a stale or forged report
  // cannot silently keep looking green.
  const freshBlindReport = auditFreshBlindEvidence({});
  const freshBlindLiveAudit = freshBlindReport.evidenceReady === true
    ? auditFreshBlindEvidenceLiveArtifacts({})
    : { ready: false, blockingReasons: ["fresh-blind-live-audit-skipped-evidence-not-ready"] };
  const freshBlindEvidenceReady = freshBlindReport.evidenceReady === true && freshBlindLiveAudit.ready === true;
  // Policy C is a separate round-4, position-labelled review-assist gate. It
  // must stay visible as preGateOnly evidence and must never inherit the
  // ordinary release authorization or become a student-facing accusation.
  const policyCLiveAudit = auditFreshBlindEvidenceLiveArtifacts({
    reportPath: ROUND4_POLICY_C_REPORT,
  });
  const policyC = policyCLiveAudit.recomputed?.policyCReviewAssist || null;
  const rhythmChannel = policyCLiveAudit.recomputed?.rhythmChannelDiagnostic || null;
  const policyCReviewAssistReady = policyCLiveAudit.ready === true
    && policyC?.contract === POLICY_C_CONTRACT
    && policyC?.reviewAssistGateReady === true
    && policyC?.autoAccusationReady === false;
  const trackAuthorization = await evaluateTrackAuthorization("ordinary");
  const authorizationReady = trackAuthorization.ready;
  return {
    contractVersion: ORDINARY_DYNAMIC_CONTRACT_VERSION,
    policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
    gateVersion: ORDINARY_DYNAMIC_GATE_VERSION,
    timingMode: ORDINARY_DYNAMIC_TIMING_MODE,
    mode: "review-only",
    runtimePreflightReady: runtime.runtimeReady === true,
    runtime: {
      runtimeId: runtime.runtimeId || "",
      config: runtime.config || "",
      configSha256: runtime.configSha256 || "",
      configSemanticSha256: runtime.configSemanticSha256 || "",
      isolatedVenv: runtime.python?.isolatedVenv === true,
      packageSetLocked: runtime.packageSetLocked === true,
      requirementsLockSha256: runtime.requirementsLock?.normalizedSha256 || "",
      modelTreeSha256: runtime.modelIdentity?.treeSha256 || "",
      blockingReasons: runtime.blockingReasons || [],
    },
    foundationReady: runtime.runtimeReady === true,
    foundationScope: "implementation-and-live-runtime-preflight-only",
    liveArtifactVerifierReady: ORDINARY_DYNAMIC_ACCEPTANCE_LIVE_VERIFIER_IMPLEMENTED,
    r3AcceptanceReady,
    freshBlindEvidence: {
      contract: FRESH_BLIND_CONTRACT,
      ready: freshBlindEvidenceReady,
      recordingCount: freshBlindReport.recordingCount ?? 0,
      cleanCoverage: (freshBlindReport.tiers?.cleanFull?.rows || []).map((row) => ({
        recordingId: row.recordingId,
        shadowCoverage: row.shadowCoverage,
      })),
      techniqueSafety: {
        totalMarkedZoneRows: freshBlindReport.tiers?.techniqueSafety?.totalMarkedZoneRows ?? 0,
        totalMarkedZoneAccusations: freshBlindReport.tiers?.techniqueSafety?.totalMarkedZoneAccusations ?? 0,
      },
      blockingReasons: normalizedReasonList([
        ...(freshBlindReport.blockingReasons || []),
        ...(freshBlindLiveAudit.blockingReasons || []),
      ]),
    },
    policyCReviewAssistEvidence: {
      contract: POLICY_C_CONTRACT,
      source: ROUND4_POLICY_C_REPORT.replace(/\\/g, "/"),
      scope: "implementation-evidence-preGateOnly",
      ready: policyCReviewAssistReady,
      reviewAssistGateReady: policyC?.reviewAssistGateReady === true,
      autoAccusationReady: false,
      planted: policyC?.planted || null,
      nonPlanted: policyC?.nonPlanted || null,
      combinedPrecisionProxy: policyC?.combinedPrecisionProxy ?? null,
      energyRobustnessReady: policyC?.energyEvidence?.energyRobustnessReady === true,
      waveformRobustnessDiagnostic: round5PolicyCWaveformRobustness,
      outputSemantics: policyC?.outputSemantics || null,
      blockingReasons: normalizedReasonList([
        ...(policyCLiveAudit.blockingReasons || []),
        ...(!policyC ? ["policy-c-review-assist-evidence-missing"] : []),
        ...(policyC && policyC.contract !== POLICY_C_CONTRACT
          ? ["policy-c-review-assist-contract-invalid"]
          : []),
        ...(policyC && policyC.reviewAssistGateReady !== true
          ? ["policy-c-review-assist-gate-not-ready"]
          : []),
        ...(policyC?.autoAccusationReady === true
          ? ["policy-c-auto-accusation-must-remain-closed"]
          : []),
      ]),
    },
    policyCReviewAssistRuntime: reviewAssistRuntime,
    policyCReviewAssistCalibrationPack: reviewAssistCalibrationPack,
    round5TargetedIntake,
    round6CounterbalancedCapture,
    rhythmChannelEvidence: {
      contract: RHYTHM_CHANNEL_DIAGNOSTIC_CONTRACT,
      source: ROUND4_POLICY_C_REPORT.replace(/\\/g, "/"),
      scope: "preGateOnly-diagnostic",
      featureAvailablePositions: rhythmChannel?.sample?.featureAvailablePositions ?? 0,
      totalPositions: rhythmChannel?.sample?.totalPositions ?? 0,
      rhythmTargetTotal: rhythmChannel?.sample?.rhythmTargetTotal ?? 0,
      evaluatedThresholdCount: rhythmChannel?.evaluatedThresholdCount ?? 0,
      frozenOperatingPoint: rhythmChannel?.frozenOperatingPoint || null,
      bestAtRecallFloor: rhythmChannel?.bestAtRecallFloor || null,
      jointFloorReady: rhythmChannel?.jointFloorReady === true,
      reviewAssistReady: false,
      autoAccusationReady: false,
      blockingReasons: normalizedReasonList([
        ...(!rhythmChannel ? ["relative-ioi-diagnostic-evidence-missing"] : []),
        ...(rhythmChannel?.contract !== RHYTHM_CHANNEL_DIAGNOSTIC_CONTRACT
          ? ["relative-ioi-diagnostic-contract-invalid"]
          : []),
        ...(rhythmChannel?.blockingReasons || []),
      ]),
    },
    authorizationReady,
    authorizationEvidence: trackAuthorization,
    studentGateReady: false,
    automaticAdoptionReady: false,
    energyVetoIncluded: false,
    causalEnergyStatus: "excluded-review-only",
    historicalRfAuthorizationSuperseded: true,
    acceptanceEvidence: acceptance
      ? {
          source: ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE.replace(/\\/g, "/"),
          missing: false,
          acceptanceReady: r3AcceptanceReady,
          artifactSha256: acceptanceArtifact.sha256 || "",
          evidenceDigestSha256: acceptance.evidenceDigestSha256 || "",
          recordings: acceptance.recordings || [],
          blockingReasons: acceptanceValidation.blockingReasons,
          liveArtifactAudit: {
            ready: liveArtifactAudit.ready === true,
            blockingReasons: liveArtifactAudit.blockingReasons || [],
          },
        }
      : {
          source: ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE.replace(/\\/g, "/"),
          missing: true,
          acceptanceReady: false,
        },
    blockingReasons: [
      ...(runtime.runtimeReady ? [] : (runtime.blockingReasons || ["ordinary-dynamic-shadow-runtime-preflight-failed"])),
      ...(!ORDINARY_DYNAMIC_ACCEPTANCE_LIVE_VERIFIER_IMPLEMENTED
        ? ["ordinary-dynamic-shadow-r3-live-artifact-verifier-not-implemented"]
        : []),
      ...(!r3AcceptanceReady
        ? [acceptance
            ? (acceptanceValidation.ready === true
                ? "ordinary-dynamic-shadow-r3-live-artifact-audit-failed"
                : "ordinary-dynamic-shadow-r3-acceptance-invalid")
            : "ordinary-dynamic-shadow-r3-acceptance-not-run"]
        : []),
      ...(r3AcceptanceReady && !freshBlindEvidenceReady ? ["ordinary-dynamic-shadow-fresh-blind-evidence-not-ready"] : []),
      ...(!authorizationReady
        ? ["ordinary-dynamic-shadow-authorization-closed", ...trackAuthorization.blockingReasons]
        : []),
    ],
  };
}

async function buildControlledStatus() {
  const report = await evaluateControlledCandidateGate({
    reviewCsvPath: CONTROLLED_LABELS,
    minReviewedRows: 30,
    minScoredRows: 30,
    minPrecision: 0.9,
  });
  const runtimeRelease = await readJson(CONTROLLED_CONFIDENCE_RELEASE);
  const confidencePilot = summarizeControlledCandidateConfidencePilot(
    await readJson(CONTROLLED_CONFIDENCE_PILOT),
    CONTROLLED_CONFIDENCE_PILOT,
    await readJson(CONTROLLED_CONFIDENCE_VALIDATION_EVAL),
    runtimeRelease,
    await readJson(CONTROLLED_CONFIDENCE_RELEASE_AUDIT),
    await readJson(CONTROLLED_ORDINARY_MONITORED_PILOT_AUDIT),
  );
  const historicalRfAudit = confidencePilot.monitoredPilotAudit || {};
  confidencePilot.monitoredPilotAudit = {
    ...historicalRfAudit,
    historicalReadyForMonitoredPilot: historicalRfAudit.historicalReadyForMonitoredPilot === true
      || historicalRfAudit.readyForMonitoredPilot === true,
    readyForMonitoredPilot: false,
    authorizationStatus: "superseded-historical-rf-only",
    supersededBy: "western-ordinary-dynamic-shadow-policy-v1",
    blockingReasons: [
      ...new Set([
        ...(historicalRfAudit.blockingReasons || []),
        "ordinary-rf-monitored-pilot-authorization-superseded",
      ]),
    ],
  };
  const status = attachConfidencePilotStatus(buildControlledCandidateReviewStatus(report), confidencePilot);
  status.ordinaryDynamicShadow = await buildOrdinaryDynamicShadowStatus();
  status.studentSafeCandidateGateReady = false;
  status.blockingReasons = [
    ...new Set([
      ...(status.blockingReasons || []),
      "ordinary-rf-monitored-pilot-authorization-superseded",
      ...status.ordinaryDynamicShadow.blockingReasons,
    ]),
  ];
  const recalibrationPilot = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT);
  const recalibrationEval = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL);
  const recalibrationContextEval = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL);
  const recalibrationFailureDiagnosis = await readJson(CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS);
  const recalibrationReleaseCandidate = bestDeployableReleaseCandidate(recalibrationPilot);
  const recalibrationEvalExists = Boolean(recalibrationEval);
  const recalibrationContextReviewExists = await exists(CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE);
  const recalibrationContextEvalExists = Boolean(recalibrationContextEval);
  const recalibrationNeedsBlindValidation = Boolean(
    recalibrationReleaseCandidate
    && !recalibrationEvalExists
  );
  const recalibrationValidationFailed = Boolean(
    recalibrationReleaseCandidate
    && recalibrationEvalExists
    && !recalibrationEval?.blindValidationPassed
  );
  const recalibrationContextNeedsBlindValidation = Boolean(
    recalibrationValidationFailed
    && recalibrationContextReviewExists
    && !recalibrationContextEvalExists
  );
  const recalibrationContextValidationFailed = Boolean(
    recalibrationContextEvalExists
    && !recalibrationContextEval?.blindValidationPassed
  );
  const recalibrationContextValidationPassed = Boolean(
    recalibrationContextEvalExists
    && recalibrationContextEval?.blindValidationPassed
  );
  const normalizedReleaseValidationSource = String(runtimeRelease?.blindValidation?.source || "").replace(/\\/g, "/");
  const normalizedReleaseLabelsSource = String(runtimeRelease?.trainingLabels?.source || runtimeRelease?.labels?.source || "").replace(/\\/g, "/");
  const recalibrationContextRuntimeWired = Boolean(
    recalibrationContextValidationPassed
    && normalizedReleaseValidationSource === CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL.replace(/\\/g, "/")
    && normalizedReleaseLabelsSource === CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS.replace(/\\/g, "/")
  );
  status.confidenceRecalibration = {
    labelsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS.replace(/\\/g, "/"),
    pilotJson: CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT.replace(/\\/g, "/"),
    validationReviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    validationCompletedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    validationEvalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL.replace(/\\/g, "/"),
    releaseCandidateFound: Boolean(recalibrationReleaseCandidate),
    bestReleaseCandidate: recalibrationReleaseCandidate,
    validationEval: recalibrationEval || {
      sourceExists: false,
      blindValidationPassed: false,
      blockingReasons: ["confidence-recalibration-validation-eval-missing"],
    },
    failureDiagnosis: {
      source: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS.replace(/\\/g, "/"),
      sourceExists: Boolean(recalibrationFailureDiagnosis),
      summary: recalibrationFailureDiagnosis?.summary || {},
    },
    contextValidation: {
      reviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
      completedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_COMPLETED.replace(/\\/g, "/"),
      evalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL.replace(/\\/g, "/"),
      rowsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_ROWS.replace(/\\/g, "/"),
      reviewPageExists: recalibrationContextReviewExists,
      validationEval: recalibrationContextEval || {
        sourceExists: false,
        blindValidationPassed: false,
        blockingReasons: ["confidence-recalibration-context-validation-eval-missing"],
      },
      needsBlindValidation: recalibrationContextNeedsBlindValidation,
      validationFailed: recalibrationContextValidationFailed,
      validationPassed: recalibrationContextValidationPassed,
      runtimeWired: recalibrationContextRuntimeWired,
      runtimeReleaseSource: CONTROLLED_CONFIDENCE_RELEASE.replace(/\\/g, "/"),
    },
    needsBlindValidation: recalibrationNeedsBlindValidation,
    validationFailed: recalibrationValidationFailed,
  };
  if (recalibrationContextNeedsBlindValidation) {
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-context-validation-needed",
      ]),
    ];
    status.nextActions = [
      "Review the 30-row context-feature confidence recalibration pack; if the CSV downloads to Downloads, run `npm run western:ingest-review-downloads -- --apply`, then run western:controlled-candidate-confidence-recalibration-context-validation-eval.",
    ];
  } else if (recalibrationContextValidationFailed) {
    const precision = recalibrationContextEval?.metrics?.precision;
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-context-validation-failed",
      ]),
    ];
    status.nextActions = [
      `The context-feature confidence recalibration blind-validation pack failed${Number.isFinite(precision) ? ` (precision=${precision})` : ""}; keep the ordinary-upload auto gate fail-closed and inspect the context validation rows before another recalibration attempt.`,
    ];
  } else if (recalibrationContextValidationPassed && !recalibrationContextRuntimeWired) {
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-context-runtime-not-wired",
      ]),
    ];
    status.nextActions = [
      "The context-feature confidence recalibration validation passed, but the runtime gate is not wired or enabled. Review the release manifest and add a monitored, disabled-by-default runtime integration before any student-facing use.",
    ];
  } else if (recalibrationContextValidationPassed && recalibrationContextRuntimeWired) {
    // The context-feature recalibration is the current evidence source and supersedes
    // the earlier 10-row recalibration validation failure.
  } else if (recalibrationNeedsBlindValidation) {
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-validation-needed",
      ]),
    ];
    status.nextActions = [
      "Review the confidence recalibration blind-validation pack; if the CSV downloads to Downloads, run `npm run western:ingest-review-downloads -- --apply`, then run western:controlled-candidate-confidence-recalibration-validation-eval.",
    ];
  } else if (recalibrationValidationFailed) {
    const precision = recalibrationEval?.metrics?.precision;
    status.blockingReasons = [
      ...new Set([
        ...(status.blockingReasons || []),
        "ordinary-confidence-recalibration-validation-failed",
      ]),
    ];
    status.nextActions = [
      `The confidence recalibration blind-validation pack failed${Number.isFinite(precision) ? ` (precision=${precision})` : ""}; do not enable the ordinary-upload auto gate. Inspect the failure diagnosis and improve candidate/localization quality features or collect stronger calibration evidence before exporting another blind-validation pack.`,
    ];
  }
  status.nextActions = !status.ordinaryDynamicShadow.foundationReady
    ? ["Provision or repair the pinned ordinary dynamic-shadow runtime; historical RF and first-measure pilot artifacts have no current authorization authority."]
    : !status.ordinaryDynamicShadow.liveArtifactVerifierReady
      ? ["Implement and test the live r3 artifact verifier before consuming reserve takes r3-02/r3-03; historical RF and first-measure pilot artifacts remain superseded."]
      : !status.ordinaryDynamicShadow.r3AcceptanceReady
        ? ["Run the frozen review-only dynamic shadow on reserve takes r3-02/r3-03 with cold/warm cache and live artifact verification; this is implementation acceptance only, not release authorization."]
        : !status.ordinaryDynamicShadow.freshBlindEvidence?.ready
          ? ["Run `npm run western:ordinary-fresh-blind-eval` on a controlled batch from a performer/voice never used to tune any threshold; do not reuse historical RF, first-measure, or r3 acceptance recordings as release evidence."]
          : !status.ordinaryDynamicShadow.authorizationReady
            ? ["The r3 acceptance and fresh-blind evidence are both ready; this now needs the owner's explicit western-ordinary-dynamic-shadow-release-v1 authorization before any monitored pilot or student-facing promotion."]
            : ["Ordinary dynamic-shadow evidence and authorization are both ready for the monitored pilot; the default student runtime remains fail-closed until a further explicit authorization."];
  status.reviewArtifacts = {
    reviewPage: CONTROLLED_REVIEW_PAGE.replace(/\\/g, "/"),
    completedCsv: CONTROLLED_COMPLETED.replace(/\\/g, "/"),
    labelsCsv: CONTROLLED_LABELS.replace(/\\/g, "/"),
    releaseAuditJson: CONTROLLED_CONFIDENCE_RELEASE_AUDIT.replace(/\\/g, "/"),
    ordinaryMonitoredPilotAuditJson: CONTROLLED_ORDINARY_MONITORED_PILOT_AUDIT.replace(/\\/g, "/"),
    thresholdPoolReviewPage: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_REVIEW_PAGE.replace(/\\/g, "/"),
    thresholdPoolCompletedCsv: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_COMPLETED.replace(/\\/g, "/"),
    thresholdPoolEvalJson: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_EVAL.replace(/\\/g, "/"),
    thresholdPoolDiagnosisJson: CONTROLLED_CONFIDENCE_THRESHOLD_POOL_DIAGNOSIS.replace(/\\/g, "/"),
    recalibrationLabelsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_LABELS.replace(/\\/g, "/"),
    recalibrationPilotJson: CONTROLLED_CONFIDENCE_RECALIBRATION_PILOT.replace(/\\/g, "/"),
    recalibrationValidationReviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    recalibrationValidationCompletedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    recalibrationValidationEvalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_VALIDATION_EVAL.replace(/\\/g, "/"),
    recalibrationFailureDiagnosisJson: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_DIAGNOSIS.replace(/\\/g, "/"),
    recalibrationFailureDiagnosisRowsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_ROWS.replace(/\\/g, "/"),
    recalibrationFailureDiagnosisGroupsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_FAILURE_GROUPS.replace(/\\/g, "/"),
    recalibrationContextValidationReviewPage: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_REVIEW_PAGE.replace(/\\/g, "/"),
    recalibrationContextValidationCompletedCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_COMPLETED.replace(/\\/g, "/"),
    recalibrationContextValidationEvalJson: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_EVAL.replace(/\\/g, "/"),
    recalibrationContextValidationRowsCsv: CONTROLLED_CONFIDENCE_RECALIBRATION_CONTEXT_VALIDATION_ROWS.replace(/\\/g, "/"),
  };
  return status;
}

async function buildM4OmrStatus() {
  const m4aGateSplitDecision = await loadM4aGateSplitDecision();
  const m4bPocPromotionDecision = await loadM4bPocPromotionDecision();
  const m4aSupportedEditionRegistry = await auditM4aSupportedEditionRegistry();
  const m4aRegistrationRuntime = await runM4aRegistrationPreflight();
  const m4aEngineeringAcceptance = await auditM4aEngineeringAcceptance();
  const m4aRealPhotoAcceptance = await auditM4aRealPhotoAcceptance();
  const m4bDataset = await auditM4bDataset();
  const m4bFreshBlind = await auditM4bFreshBlindIntake();
  const m4bStructurePoc = await auditM4bStructurePoc();
  const readiness = await readJson(M4_READINESS);
  const benchmark = await readJson(M4_BENCHMARK);
  const independentBenchmark = await readJson(M4_INDEPENDENT_BENCHMARK_AUDIT);
  const oemerBenchmark = await readJson(M4_OEMER_BENCHMARK);
  const oemerDewarpAttribution = await readJson(M4_OEMER_DEWARP_ATTRIBUTION);
  const homrEvidence = await readJson(M4_HOMR_BENCHMARK);
  const zeusChallenger = await readJson(M4_ZEUS_CHALLENGER);
  const homrBenchmark = homrEvidenceToBenchmark(homrEvidence);
  const homrReview = await readJson(HOMR_REVIEW_RECORD);
  const homrReviewSha256 = await sha256FileOrEmpty(HOMR_REVIEW_RECORD);
  const photoScoreDeployment = await readJson(PHOTO_SCORE_DEPLOYMENT_CONFIG);
  const photoScoreDeploymentSha256 = await sha256FileOrEmpty(PHOTO_SCORE_DEPLOYMENT_CONFIG);
  const photoScoreLockSha256 = await sha256FileOrEmpty(PHOTO_SCORE_HOMR_RUNTIME_LOCK);
  const photoScorePreflight = await readJson(PHOTO_SCORE_DEPLOYMENT_PREFLIGHT);
  const sameEditionMultipageBenchmark = await readJson(M4_SAME_EDITION_MULTIPAGE_BENCHMARK);
  const sameEditionBenchmark = sameEditionMultipageBenchmark || await readJson(M4_SAME_EDITION_BENCHMARK);
  const sameEditionBenchmarkSource = sameEditionMultipageBenchmark
    ? M4_SAME_EDITION_MULTIPAGE_BENCHMARK
    : M4_SAME_EDITION_BENCHMARK;
  const op45PublicReference = await readJson(M4_OP45_PUBLIC_REFERENCE);
  const clarityBenchmark = await readJson(M4_CLARITY_BENCHMARK);
  const clarityAdaptationBenchmark = await readJson(M4_CLARITY_ADAPTATION_BENCHMARK);
  const workspaceAudit = await readJson(M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT);
  const provenanceAudit = await readJson(M4_GOLD_PROVENANCE_AUDIT);
  const rhythmCandidateOracle = await readJson(M4_RHYTHM_CANDIDATE_ORACLE);
  const p0StructureGate = await readJson(M4_P0_STRUCTURE_GATE);
  const dualEvidenceGoldAudit = await readJson(M4_DUAL_EVIDENCE_GOLD_AUDIT);
  const p0FeedbackImpact = await readJson(M4_P0_FEEDBACK_IMPACT);
  const greenSafetyAudit = await readJson(M4_GREEN_SAFETY_AUDIT);
  const adaptiveInterlineProbe = await readJson(M4_ADAPTIVE_INTERLINE_PROBE);
  const focusedSymbolGold = await readJson(M4_FOCUSED_SYMBOL_GOLD);
  const audioRhythmRanking = await readJson(M4_AUDIO_RHYTHM_RANKING);
  const engineConsensus = await readJson(M4_ENGINE_CONSENSUS);
  const engineConsensusToleranceSweep = await readJson(M4_ENGINE_CONSENSUS_TOLERANCE_SWEEP);
  const readinessReady = Boolean(readiness?.gate?.m4OmrBenchmarkDatasetReady);
  const benchmarkEvaluated = Boolean(benchmark?.gate?.m4OmrBenchmarkEvaluated);
  const draftQualityReady = Boolean(benchmark?.gate?.m4OmrDraftQualityReady);
  const independentBenchmarkReady = independentBenchmark?.independentBenchmarkReady === true;
  const automaticAdoptionReady = independentBenchmark?.automaticAdoptionReady === true;
  const homrDecision = homrReview?.decision || {};
  // A cached preflight is authoritative only for the exact review record it
  // inspected. This prevents project-status/project-gate from reusing a green
  // deployment verdict after approval is deferred or any binding changes.
  const homrDeploymentSnapshot = evaluateHomrDeploymentSnapshot({
    review: homrReview,
    reviewSha256: homrReviewSha256,
    manifestSha256: photoScoreDeploymentSha256,
    lockSha256: photoScoreLockSha256,
    preflight: photoScorePreflight,
  });
  const homrLicenseReviewReady = homrDeploymentSnapshot.licenseReviewReady;
  const homrArtifactIntegrityReady = homrDeploymentSnapshot.artifactIntegrityReady;
  const homrDeploymentPreflightReady = homrDeploymentSnapshot.deploymentPreflightReady;
  const homrProductionPoolReady = homrDeploymentSnapshot.productionPoolReady;
  const homrGovernanceBlockingReasons = homrDeploymentSnapshot.blockingReasons;
  const automaticAdoptionBlockingReasons = [
    ...(independentBenchmark?.automaticAdoptionBlockingReasons || ["m4-independent-benchmark-audit-missing"]),
    ...(!automaticAdoptionReady && oemerBenchmark?.complete === true && oemerBenchmark?.gate?.automaticAdoptionReady !== true
      ? ["m4-oemer-source-benchmark-below-floor"] : []),
    ...(!automaticAdoptionReady && homrBenchmark?.complete === true && homrBenchmark?.gate?.automaticAdoptionReady !== true
      ? ["m4-homr-source-benchmark-below-complete-score-floor"] : []),
    ...(!automaticAdoptionReady
      && zeusChallenger?.contract === "western-m4-zeus-camera-challenger-eval-v1"
      && zeusChallenger?.summary?.passesFrozenRealPhotoGate !== true
      ? ["m4-zeus-camera-challenger-below-complete-score-floor"] : []),
    ...(!automaticAdoptionReady
      && sameEditionBenchmark?.candidate?.observedStrictPass === true
      && sameEditionBenchmark?.candidate?.automaticAdoptionReady !== true
      ? ["m4-same-edition-homr-independent-page-count-below-floor"] : []),
    ...(!automaticAdoptionReady && clarityBenchmark?.complete === true && clarityBenchmark?.gate?.automaticAdoptionReady !== true
      ? ["m4-clarity-source-benchmark-below-complete-score-floor"] : []),
    ...(!automaticAdoptionReady
      && clarityAdaptationBenchmark?.adaptationDecision?.evaluated === true
      && clarityAdaptationBenchmark?.adaptationDecision?.retainForFurtherEvaluation !== true
      ? ["m4-clarity-supervised-adaptation-rejected"] : []),
  ];
  const provenanceCounts = provenanceAudit?.counts || {};
  const manualGoldRequiredRows = Number(provenanceCounts.manualGoldRequiredRows || 0);
  const independentRealPhotoGoldMissing = automaticAdoptionBlockingReasons.includes(
    "m4-real-photo-independent-gold-missing",
  );
  const humanTask = independentRealPhotoGoldMissing
    ? "score-editor-independent-real-photo-gold"
    : manualGoldRequiredRows > 0
      ? "score-editor-independent-gold-correction"
      : "none";
  const humanTaskScope = independentRealPhotoGoldMissing
    ? "Create at least 3 MusicXML references directly from real score photos without copying or approving the Audiveris draft, then compare blind OMR output against those references."
    : manualGoldRequiredRows > 0
      ? "Correct MusicXML/MXL against source score images only; do not ask for audio diagnosis review."
      : "No score-editor correction is currently required.";
  const blockingReasons = [];
  if (!readiness) blockingReasons.push("m4-omr-readiness-missing");
  else if (!readinessReady) blockingReasons.push("m4-omr-readiness-not-ready");
  if (!benchmark) blockingReasons.push("m4-omr-benchmark-missing");
  else {
    if (!benchmarkEvaluated) blockingReasons.push("m4-omr-benchmark-not-evaluated");
    if ((benchmark.counts?.usableBenchmarkRows || 0) <= 0) blockingReasons.push("m4-omr-no-independent-gold");
    if ((benchmark.counts?.selfComparisonRows || 0) > 0) blockingReasons.push("m4-omr-self-comparison-detected");
    if (!draftQualityReady) blockingReasons.push("m4-omr-draft-quality-not-ready");
  }
  if (!independentBenchmark) {
    blockingReasons.push("m4-independent-benchmark-audit-missing");
  } else if (!independentBenchmarkReady) {
    blockingReasons.push(...(
      independentBenchmark.evidenceBlockingReasons || ["m4-independent-benchmark-not-ready"]
    ));
  }
  return {
    ok: true,
    m4GateSplitDecisionReady: m4aGateSplitDecision.ready,
    m4aSupportedEditionRegistrationReady: m4aRealPhotoAcceptance.ready,
    m4aBlockingReasons: [
      ...m4aGateSplitDecision.blockingReasons,
      ...m4aSupportedEditionRegistry.blockingReasons,
      ...m4aRegistrationRuntime.blockingReasons,
      ...m4aEngineeringAcceptance.blockingReasons,
      ...m4aRealPhotoAcceptance.blockingReasons,
    ],
    m4aSupportedEditionRegistryReady: m4aSupportedEditionRegistry.ready,
    m4aSupportedEditionRegistry: m4aSupportedEditionRegistry,
    m4aRegistrationRuntimeReady: m4aRegistrationRuntime.ready,
    m4aRegistrationRuntime: m4aRegistrationRuntime,
    m4aEngineeringAcceptanceReady: m4aEngineeringAcceptance.ready,
    m4aEngineeringAcceptance: m4aEngineeringAcceptance,
    m4aRealPhotoAcceptanceOperationalReady: m4aRealPhotoAcceptance.operationalReady,
    m4aRealPhotoAcceptanceReady: m4aRealPhotoAcceptance.ready,
    m4aRealPhotoAcceptance: m4aRealPhotoAcceptance,
    m4bOpenWorldOmrAutomaticAdoptionReady: automaticAdoptionReady,
    m4aGateSplitDecision: m4aGateSplitDecision,
    m4bPocPromotionThresholdDecisionReady: m4bPocPromotionDecision.ready,
    m4bPocPromotionThresholdDecision: m4bPocPromotionDecision,
    m4bDataFoundationReady: m4bDataset.ready,
    m4bRealAnnotationTargetReady: m4bDataset.realAnnotationTargetReady,
    m4bFreshBlindDatasetReady: m4bFreshBlind.ready,
    m4bStructurePocEngineeringReady: m4bStructurePoc.engineeringReady,
    m4bStructurePocPromotionOperationalReady: m4bStructurePoc.promotionOperationalReady,
    m4bStructurePocPromotionReady: m4bStructurePoc.promotionReady,
    m4bPocBlockingReasons: normalizedReasonList([
      ...m4bPocPromotionDecision.blockingReasons,
      ...m4bStructurePoc.blockingReasons,
      ...m4bStructurePoc.promotionBlockingReasons,
      ...m4bFreshBlind.blockingReasons,
    ]),
    m4bDataset: m4bDataset,
    m4bFreshBlind: m4bFreshBlind,
    m4bStructurePoc: m4bStructurePoc,
    m4OmrBenchmarkDatasetReady: readinessReady,
    m4OmrDraftQualityReady: draftQualityReady,
    m4OmrIndependentBenchmarkReady: independentBenchmarkReady,
    m4OmrAccuracyClaimReady: independentBenchmarkReady,
    m4OmrAutomaticAdoptionReady: automaticAdoptionReady,
    m4OemerBenchmarkComplete: oemerBenchmark?.complete === true,
    m4OemerAutomaticAdoptionReady: oemerBenchmark?.gate?.automaticAdoptionReady === true,
    m4OemerDewarpAttributionComplete:
      oemerDewarpAttribution?.contract === "western-m4-oemer-dewarp-attribution-v1"
      && oemerDewarpAttribution?.aggregate?.pageCount === 5,
    m4OemerDewarpPrimaryCauseSupported:
      oemerDewarpAttribution?.interpretation?.dewarpMissingIsPrimaryCause === true,
    m4HomrBenchmarkComplete: homrBenchmark?.complete === true,
    m4HomrAutomaticAdoptionReady: homrBenchmark?.gate?.automaticAdoptionReady === true,
    m4HomrLicenseReviewReady: homrLicenseReviewReady,
    m4HomrArtifactIntegrityReady: homrArtifactIntegrityReady,
    m4HomrDeploymentPreflightReady: homrDeploymentPreflightReady,
    m4HomrProductionPoolReady: homrProductionPoolReady,
    m4HomrMainlineExecutable: false,
    m4ZeusChallengerEvaluated:
      zeusChallenger?.contract === "western-m4-zeus-camera-challenger-eval-v1",
    m4ZeusChallengerRetained:
      zeusChallenger?.decision?.keepAsRuntimeCandidate === true,
    m4SameEditionBenchmarkEvaluated: sameEditionBenchmark?.goldIdentity?.sameGoldVerified === true,
    m4SameEditionHomrStrictPositive:
      sameEditionBenchmark?.candidate?.engine === "homr"
      && sameEditionBenchmark?.candidate?.observedStrictPass === true,
    m4SameEditionAutomaticAdoptionReady:
      sameEditionBenchmark?.candidate?.automaticAdoptionReady === true,
    m4Op45ExternalPitchReferenceEvaluated:
      op45PublicReference?.purpose === "independent-public-pitch-order-corroboration",
    m4Op45ExternalPitchExactRunObserved:
      op45PublicReference?.interpretation?.strictExactRunObserved === true,
    m4ClarityBenchmarkComplete: clarityBenchmark?.complete === true,
    m4ClarityAutomaticAdoptionReady: clarityBenchmark?.gate?.automaticAdoptionReady === true,
    m4ClarityAdaptationEvaluated: clarityAdaptationBenchmark?.adaptationDecision?.evaluated === true,
    m4ClarityAdaptationRejected: clarityAdaptationBenchmark?.adaptationDecision?.checkpointDisposition === "reject-and-delete",
    m4RhythmCandidateOracleEvaluated: Boolean(rhythmCandidateOracle?.summary),
    m4RhythmCandidateGenerationGatePassed:
      rhythmCandidateOracle?.summary?.candidateGenerationGatePassed === true,
    m4P0StructureGateEvaluated: Boolean(p0StructureGate?.summary),
    m4P0StructureReady: p0StructureGate?.summary?.p0ReadyCount > 0,
    m4GreenSequenceGatePassed:
      dualEvidenceGoldAudit?.summary?.evalOnlyGatePassed === true,
    m4GreenFeedbackRecommendedForProduction:
      p0FeedbackImpact?.summary?.greenOnlyRecommendedForProduction === true,
    m4GreenFreshValidationCandidateFound:
      greenSafetyAudit?.summary?.freshValidationCandidateFound === true,
    m4GreenReleaseGateCandidateFound:
      greenSafetyAudit?.summary?.releaseGateCandidateFound === true,
    m4GreenProductionPolicyChanged:
      greenSafetyAudit?.summary?.productionPolicyChanged === true,
    m4AdaptiveInterlineProbeEvaluated:
      Array.isArray(adaptiveInterlineProbe?.rows) && adaptiveInterlineProbe.rows.length > 0,
    m4AdaptiveInterlineProductionPolicyChanged:
      adaptiveInterlineProbe?.productionPolicyChanged === true,
    m4FocusedSymbolGoldBuilt: Boolean(focusedSymbolGold?.summary),
    m4CoordinateGoldReady: focusedSymbolGold?.summary?.coordinateGoldReady === true,
    m4RhythmRuntimeReady: rhythmCandidateOracle?.summary?.runtimeReady === true,
    m4AudioRhythmRankingGatePassed: audioRhythmRanking?.summary?.evalOnlyGatePassed === true,
    m4MeasureAudioRhythmRankingGatePassed:
      audioRhythmRanking?.measureLevel?.leaveOnePieceOut?.evalOnlyGatePassed === true,
    m4EngineConsensusPilotSafeSubsetFound:
      engineConsensus?.pilotSafeSubsetFound === true,
    m4EngineConsensusRuntimeReady: engineConsensus?.runtimeReady === true,
    studentGateReady: false,
    teacherReviewNeeded: false,
    scoreEditorReviewNeeded: humanTask !== "none",
    humanTask,
    humanTaskScope,
    reason: "omr-status-only",
    counts: {
      readinessRows: readiness?.counts?.intakeRows || 0,
      pairReadyRows: readiness?.counts?.pairReadyRows || 0,
      benchmarkRows: benchmark?.counts?.rows || 0,
      parseOkRows: benchmark?.counts?.parseOkRows || 0,
      usableBenchmarkRows: benchmark?.counts?.usableBenchmarkRows || 0,
      sameHashRows: benchmark?.counts?.sameHashRows || 0,
      humanApprovedUnchangedRows: benchmark?.counts?.humanApprovedUnchangedRows || 0,
      selfComparisonRows: benchmark?.counts?.selfComparisonRows || 0,
      blockedRows: benchmark?.counts?.blockedRows || 0,
    },
    blockingReasons,
    automaticAdoptionBlockingReasons,
    homrGovernance: {
      licenseReviewReady: homrLicenseReviewReady,
      artifactIntegrityReady: homrArtifactIntegrityReady,
      deploymentPreflightReady: homrDeploymentPreflightReady,
      productionPoolReady: homrProductionPoolReady,
      mainlineExecutable: false,
      decisionStatus: homrDecision.status || "missing",
      reviewedBy: homrDecision.reviewedBy || "",
      reviewedAt: homrDecision.reviewedAt || "",
      deploymentScope: photoScoreDeployment?.deploymentScope || "",
      studentFacing: false,
      automaticAdoptionAuthorized: false,
      reviewRecordSha256: homrReviewSha256,
      reviewRecordBindingCurrent: homrDeploymentSnapshot.reviewBindingCurrent,
      manifestSha256: photoScoreDeploymentSha256,
      manifestBindingCurrent: homrDeploymentSnapshot.manifestBindingCurrent,
      lockSha256: photoScoreLockSha256,
      lockBindingCurrent: homrDeploymentSnapshot.lockBindingCurrent,
      preflightBindingCurrent: homrDeploymentSnapshot.preflightBindingCurrent,
      blockingReasons: homrGovernanceBlockingReasons,
      lastPreflight: photoScorePreflight
        ? {
            generatedAt: photoScorePreflight.generatedAt || "",
            governanceReady: photoScorePreflight.governanceReady === true,
            hostReady: photoScorePreflight.hostReady === true,
            deploymentReady: photoScorePreflight.deploymentReady === true,
            manifestSha256: photoScorePreflight.manifestSha256 || "",
            lockSha256: photoScorePreflight.lockSha256 || "",
            reviewRecordSha256: photoScorePreflight.reviewRecordSha256 || "",
          }
        : null,
    },
    artifacts: {
      m4aGateSplitDecisionJson: m4aGateSplitDecision.source,
      m4aSupportedEditionRegistryJson: m4aSupportedEditionRegistry.source,
      m4aRegistrationRuntimePreflightJson: "data/experiments/western-strings-m4a/registration-runtime-preflight.json",
      m4aEngineeringAcceptanceJson: m4aEngineeringAcceptance.source,
      m4aRealPhotoAcceptanceJson: m4aRealPhotoAcceptance.source,
      m4bDatasetJson: m4bDataset.source,
      m4bFreshBlindIntakeJson: m4bFreshBlind.source,
      m4bPocPromotionThresholdDecisionJson: m4bPocPromotionDecision.source,
      m4bStructurePocEvaluationJson: m4bStructurePoc.source,
      m4bFreshBlindPromotionEvaluationJson: m4bStructurePoc.promotionSource,
      m4aRegistrationAuditJson: "data/experiments/western-strings-m4a/registration-audit.json",
      readinessJson: M4_READINESS.replace(/\\/g, "/"),
      benchmarkJson: M4_BENCHMARK.replace(/\\/g, "/"),
      independentBenchmarkJson: M4_INDEPENDENT_BENCHMARK_AUDIT.replace(/\\/g, "/"),
      oemerBenchmarkJson: M4_OEMER_BENCHMARK.replace(/\\/g, "/"),
      oemerDewarpAttributionJson: M4_OEMER_DEWARP_ATTRIBUTION.replace(/\\/g, "/"),
      homrBenchmarkJson: M4_HOMR_BENCHMARK.replace(/\\/g, "/"),
      zeusChallengerJson: M4_ZEUS_CHALLENGER.replace(/\\/g, "/"),
      homrReviewRecordJson: HOMR_REVIEW_RECORD.replace(/\\/g, "/"),
      photoScoreDeploymentConfigJson: PHOTO_SCORE_DEPLOYMENT_CONFIG.replace(/\\/g, "/"),
      photoScoreDeploymentPreflightJson: PHOTO_SCORE_DEPLOYMENT_PREFLIGHT.replace(/\\/g, "/"),
      sameEditionBenchmarkJson: sameEditionBenchmarkSource.replace(/\\/g, "/"),
      op45PublicReferenceJson: M4_OP45_PUBLIC_REFERENCE.replace(/\\/g, "/"),
      clarityBenchmarkJson: M4_CLARITY_BENCHMARK.replace(/\\/g, "/"),
      clarityAdaptationBenchmarkJson: M4_CLARITY_ADAPTATION_BENCHMARK.replace(/\\/g, "/"),
      independentGoldTodo: M4_INDEPENDENT_GOLD_TODO.replace(/\\/g, "/"),
      independentGoldTodoHtml: M4_INDEPENDENT_GOLD_TODO_HTML.replace(/\\/g, "/"),
      independentGoldWorkspaceAuditJson: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT.replace(/\\/g, "/"),
      independentGoldWorkspaceAuditCsv: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT_CSV.replace(/\\/g, "/"),
      goldProvenanceAuditJson: M4_GOLD_PROVENANCE_AUDIT.replace(/\\/g, "/"),
      goldProvenanceAuditCsv: M4_GOLD_PROVENANCE_AUDIT_CSV.replace(/\\/g, "/"),
      rhythmCandidateOracleJson: M4_RHYTHM_CANDIDATE_ORACLE.replace(/\\/g, "/"),
      dualEvidenceGoldAuditJson: M4_DUAL_EVIDENCE_GOLD_AUDIT.replace(/\\/g, "/"),
      p0FeedbackImpactJson: M4_P0_FEEDBACK_IMPACT.replace(/\\/g, "/"),
      greenSafetyAuditJson: M4_GREEN_SAFETY_AUDIT.replace(/\\/g, "/"),
      adaptiveInterlineProbeJson: M4_ADAPTIVE_INTERLINE_PROBE.replace(/\\/g, "/"),
      audioRhythmRankingJson: M4_AUDIO_RHYTHM_RANKING.replace(/\\/g, "/"),
      engineConsensusJson: M4_ENGINE_CONSENSUS.replace(/\\/g, "/"),
      engineConsensusToleranceSweepJson: M4_ENGINE_CONSENSUS_TOLERANCE_SWEEP.replace(/\\/g, "/"),
      readinessCsv: String(readiness?.artifacts?.csv || "data/experiments/western-strings-m4/omr-readiness.csv").replace(/\\/g, "/"),
      benchmarkCsv: String(benchmark?.artifacts?.csv || "data/experiments/western-strings-m4/omr-benchmark.csv").replace(/\\/g, "/"),
    },
    independentBenchmark: independentBenchmark ? {
      source: M4_INDEPENDENT_BENCHMARK_AUDIT.replace(/\\/g, "/"),
      independentBenchmarkReady,
      automaticAdoptionReady,
      studentGateReady: independentBenchmark.studentGateReady === true,
      domains: independentBenchmark.domains || {},
      strictPerPiece: independentBenchmark.strictPerPiece || {},
      independentRealPhotoRows: independentBenchmark.independentRealPhotoRows || 0,
      minIndependentRealPhotoRows: independentBenchmark.minIndependentRealPhotoRows || 0,
      realPhotoGold: independentBenchmark.realPhotoGold || {},
      confidenceProbe: independentBenchmark.confidenceProbe ? {
        sourceAvailable: independentBenchmark.confidenceProbe.sourceAvailable === true,
        safeSubsetReady: independentBenchmark.confidenceProbe.safeSubsetReady === true,
        validation: independentBenchmark.confidenceProbe.validation || "",
        runtimeFeatureOnly: independentBenchmark.confidenceProbe.runtimeFeatureOnly === true,
        counts: independentBenchmark.confidenceProbe.counts || {},
        blockingReasons: independentBenchmark.confidenceProbe.blockingReasons || [],
        models: Object.fromEntries(Object.entries(independentBenchmark.confidenceProbe.models || {}).map(
          ([name, result]) => [name, {
            leaveOneWorkOutRocAuc: result.leaveOneWorkOutRocAuc ?? null,
            safeSubsetReady: result.safeSubsetReady === true,
            bestSafePoint: result.bestSafePoint || null,
            bestObservedPoint: result.bestObservedPoint || null,
          }],
        )),
      } : {},
      evidenceBlockingReasons: independentBenchmark.evidenceBlockingReasons || [],
      automaticAdoptionBlockingReasons: independentBenchmark.automaticAdoptionBlockingReasons || [],
      claimScope: independentBenchmark.claimScope || "",
    } : {
      source: M4_INDEPENDENT_BENCHMARK_AUDIT.replace(/\\/g, "/"),
      missing: true,
      independentBenchmarkReady: false,
      automaticAdoptionReady: false,
      studentGateReady: false,
    },
    oemerBenchmark: oemerBenchmark ? {
      source: M4_OEMER_BENCHMARK.replace(/\\/g, "/"),
      complete: oemerBenchmark.complete === true,
      automaticAdoptionReady: oemerBenchmark?.gate?.automaticAdoptionReady === true,
      studentGateReady: oemerBenchmark?.gate?.studentGateReady === true,
      runtime: oemerBenchmark.runtime || {},
      comparison: oemerBenchmark.comparison || {},
      coordinateAdapter: oemerBenchmark.coordinateAdapter || {},
    } : {
      source: M4_OEMER_BENCHMARK.replace(/\\/g, "/"),
      missing: true,
      complete: false,
      automaticAdoptionReady: false,
      studentGateReady: false,
    },
    engineConsensus: engineConsensus ? {
      source: M4_ENGINE_CONSENSUS.replace(/\\/g, "/"),
      pilotSafeSubsetFound: engineConsensus.pilotSafeSubsetFound === true,
      runtimeReady: engineConsensus.runtimeReady === true,
      summaries: engineConsensus.summaries || {},
      coordinatePolicy: engineConsensus.coordinatePolicy || {},
      studentGateReady: false,
    } : {
      source: M4_ENGINE_CONSENSUS.replace(/\\/g, "/"),
      missing: true,
      runtimeReady: false,
      studentGateReady: false,
    },
    engineConsensusToleranceSweep: engineConsensusToleranceSweep ? {
      source: M4_ENGINE_CONSENSUS_TOLERANCE_SWEEP.replace(/\\/g, "/"),
      configurationCount: engineConsensusToleranceSweep.configurationCount || 0,
      expansionCandidateFound:
        engineConsensusToleranceSweep.expansionCandidateFound === true,
      runtimeReady: false,
      blockingReasons: engineConsensusToleranceSweep.blockingReasons || [],
      studentGateReady: false,
    } : {
      source: M4_ENGINE_CONSENSUS_TOLERANCE_SWEEP.replace(/\\/g, "/"),
      missing: true,
      expansionCandidateFound: false,
      runtimeReady: false,
      studentGateReady: false,
    },
    homrBenchmark: homrBenchmark ? {
      source: M4_HOMR_BENCHMARK.replace(/\\/g, "/"),
      evidenceId: homrEvidence?.evidenceId || "",
      authority: homrEvidence?.authority || "",
      complete: homrBenchmark.complete === true,
      automaticAdoptionReady: homrBenchmark?.gate?.automaticAdoptionReady === true,
      studentGateReady: homrBenchmark?.gate?.studentGateReady === true,
      runtime: homrBenchmark.runtime || {},
      comparison: homrBenchmark.comparison || {},
      sourceArtifacts: homrEvidence?.sourceArtifacts || {},
    } : {
      source: M4_HOMR_BENCHMARK.replace(/\\/g, "/"),
      missing: true,
      complete: false,
      automaticAdoptionReady: false,
      studentGateReady: false,
    },
    zeusChallenger: zeusChallenger ? {
      source: M4_ZEUS_CHALLENGER.replace(/\\/g, "/"),
      evaluationRole: zeusChallenger.evaluationRole || "",
      runtimeEffect: zeusChallenger.runtimeEffect || "none",
      sourceModel: zeusChallenger.model || {},
      input: zeusChallenger.input || {},
      thresholds: zeusChallenger.thresholds || {},
      summary: zeusChallenger.summary || {},
      interpretation: zeusChallenger.interpretation || {},
      decision: zeusChallenger.decision || {},
      studentGateReady: false,
    } : {
      source: M4_ZEUS_CHALLENGER.replace(/\\/g, "/"),
      missing: true,
      studentGateReady: false,
    },
    sameEditionBenchmark: sameEditionBenchmark ? {
      source: sameEditionBenchmarkSource.replace(/\\/g, "/"),
      evalOnly: sameEditionBenchmark.evalOnly === true,
      studentGateReady: sameEditionBenchmark.studentGateReady === true,
      goldIdentity: sameEditionBenchmark.goldIdentity || {},
      candidate: sameEditionBenchmark.candidate || {},
      engines: sameEditionBenchmark.engines || {},
    } : {
      source: sameEditionBenchmarkSource.replace(/\\/g, "/"),
      missing: true,
      studentGateReady: false,
      candidate: { automaticAdoptionReady: false },
    },
    op45PublicReference: op45PublicReference ? {
      source: M4_OP45_PUBLIC_REFERENCE.replace(/\\/g, "/"),
      evalOnly: op45PublicReference.evalOnly === true,
      studentFacing: op45PublicReference.studentFacing === true,
      counts: op45PublicReference.counts || {},
      pitchOrderAlignment: op45PublicReference.pitchOrderAlignment || {},
      interpretation: op45PublicReference.interpretation || {},
      gate: op45PublicReference.gate || {},
    } : {
      source: M4_OP45_PUBLIC_REFERENCE.replace(/\\/g, "/"),
      missing: true,
      evalOnly: true,
      studentFacing: false,
      gate: { automaticAdoptionReady: false },
    },
    clarityBenchmark: clarityBenchmark ? {
      source: M4_CLARITY_BENCHMARK.replace(/\\/g, "/"),
      complete: clarityBenchmark.complete === true,
      automaticAdoptionReady: clarityBenchmark?.gate?.automaticAdoptionReady === true,
      studentGateReady: clarityBenchmark?.gate?.studentGateReady === true,
      runtime: clarityBenchmark.runtime || {},
      comparison: clarityBenchmark.comparison || {},
      rawNativeSmoke: clarityBenchmark.rawNativeSmoke || {},
    } : {
      source: M4_CLARITY_BENCHMARK.replace(/\\/g, "/"),
      missing: true,
      complete: false,
      automaticAdoptionReady: false,
      studentGateReady: false,
    },
    clarityAdaptationBenchmark: clarityAdaptationBenchmark ? {
      source: M4_CLARITY_ADAPTATION_BENCHMARK.replace(/\\/g, "/"),
      complete: clarityAdaptationBenchmark.complete === true,
      studentGateReady: false,
      comparison: clarityAdaptationBenchmark.comparison || {},
      adaptationDecision: clarityAdaptationBenchmark.adaptationDecision || {},
    } : {
      source: M4_CLARITY_ADAPTATION_BENCHMARK.replace(/\\/g, "/"),
      missing: true,
      complete: false,
      studentGateReady: false,
      adaptationDecision: {},
    },
    rhythmCandidateOracle: rhythmCandidateOracle?.summary || null,
    p0StructureGate: p0StructureGate?.summary || null,
    adaptiveInterlineProbe: adaptiveInterlineProbe ? {
      source: M4_ADAPTIVE_INTERLINE_PROBE.replace(/\\/g, "/"),
      rowCount: Array.isArray(adaptiveInterlineProbe.rows)
        ? adaptiveInterlineProbe.rows.length
        : 0,
      independentGoldRowCount: Array.isArray(adaptiveInterlineProbe.rows)
        ? adaptiveInterlineProbe.rows.filter((row) => row?.independentGoldAvailable === true).length
        : 0,
      independentGoldComparisons: Array.isArray(adaptiveInterlineProbe.rows)
        ? adaptiveInterlineProbe.rows
            .filter((row) => row?.independentGold)
            .map((row) => ({
              piece: row.piece,
              baselineUp2: row.independentGold.baselineUp2 || null,
              adaptiveInterline: row.independentGold.adaptiveInterline || null,
              adaptiveMinusBaseline: row.independentGold.adaptiveMinusBaseline || null,
            }))
        : [],
      productionPolicyChanged: adaptiveInterlineProbe.productionPolicyChanged === true,
    } : null,
    oemerDewarpAttribution: oemerDewarpAttribution ? {
      evidenceRole: oemerDewarpAttribution.evidenceRole || "",
      aggregate: oemerDewarpAttribution.aggregate || {},
      interpretation: oemerDewarpAttribution.interpretation || {},
      limitations: oemerDewarpAttribution.limitations || [],
      studentGateReady: oemerDewarpAttribution.studentGateReady === true,
      automaticAdoptionAuthorized: oemerDewarpAttribution.automaticAdoptionAuthorized === true,
    } : null,
    focusedSymbolGold: focusedSymbolGold?.summary || null,
    audioRhythmRanking: audioRhythmRanking ? {
      summary: audioRhythmRanking.summary || null,
      ensembleSummary: audioRhythmRanking.ensembleSummary || null,
      measureLevel: audioRhythmRanking.measureLevel ? {
        fixedMarginSummary: audioRhythmRanking.measureLevel.fixedMarginSummary || null,
        leaveOnePieceOut: audioRhythmRanking.measureLevel.leaveOnePieceOut || null,
        ensembleFixedMarginSummary:
          audioRhythmRanking.measureLevel.ensembleFixedMarginSummary || null,
        ensembleLeaveOnePieceOut:
          audioRhythmRanking.measureLevel.ensembleLeaveOnePieceOut || null,
        runtimeReady: audioRhythmRanking.measureLevel.runtimeReady === true,
      } : null,
    } : null,
    independentGoldWorkspaceAudit: workspaceAudit
      ? {
          source: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT.replace(/\\/g, "/"),
          readyForApply: Boolean(workspaceAudit.readyForApply),
          counts: workspaceAudit.counts || {},
        }
      : {
          source: M4_INDEPENDENT_GOLD_WORKSPACE_AUDIT.replace(/\\/g, "/"),
          readyForApply: false,
          counts: {},
          missing: true,
        },
    goldProvenanceAudit: provenanceAudit
      ? {
          source: M4_GOLD_PROVENANCE_AUDIT.replace(/\\/g, "/"),
          counts: provenanceAudit.counts || {},
          teacherReviewNeeded: Boolean(provenanceAudit.teacherReviewNeeded),
          humanTask: provenanceAudit.humanTask || "",
          conclusion: provenanceAudit.conclusion || "",
        }
      : {
          source: M4_GOLD_PROVENANCE_AUDIT.replace(/\\/g, "/"),
          counts: {},
          missing: true,
        },
  };
}

export function summarizeNextActions(
  controlled,
  m3plus,
  m4Omr,
  releaseReview,
  controlledPilotDecision,
  controlledPilotSession,
  controlledPilotEvidence,
  controlledPilotMachineAudit,
  freshBlindIntake,
) {
  const actions = [];
  const ordinaryPilotAudit = controlled.confidencePilot?.monitoredPilotAudit || {};
  const ordinaryPilotEvidencePassed = ordinaryPilotAudit.readyForMonitoredPilot === true
    && ordinaryPilotAudit.teacherReviewNeeded !== true
    && ordinaryPilotAudit.defaultOrdinaryReadyAfter !== true
    && (ordinaryPilotAudit.blockingReasons || []).length === 0;
  const shadow = controlled.ordinaryDynamicShadow || {};
  if (!shadow.foundationReady) {
    actions.push({
      priority: 0,
      track: "Ordinary dynamic shadow runtime",
      action: "Provision or repair the pinned ordinary-audio venv, then rerun `npm run western:ordinary-dynamic-shadow-runtime-preflight`. Do not consume r3-02/r3-03 while the live runtime identity is invalid.",
      artifact: shadow.runtime?.config || "config/western-ordinary-audio-runtime.json",
      reason: shadow.runtime?.blockingReasons || ["ordinary-dynamic-shadow-runtime-preflight-failed"],
    });
  } else if (!shadow.liveArtifactVerifierReady) {
    actions.push({
      priority: 1,
      track: "Ordinary dynamic shadow r3 evidence verifier",
      action: "Implement a live verifier that rereads and rehashes every r3 cold/warm source artifact before accepting the aggregate report. Add adversarial tests proving a self-consistent forged report cannot pass. Do not consume reserve takes r3-02/r3-03 until this verifier is live.",
      artifact: shadow.acceptanceEvidence?.source || ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE.replace(/\\/g, "/"),
      reason: ["ordinary-dynamic-shadow-r3-live-artifact-verifier-not-implemented"],
    });
  } else if (!shadow.r3AcceptanceReady) {
    actions.push({
      priority: 1,
      track: "Ordinary dynamic shadow r3 acceptance",
      action: "Run the frozen review-only dynamic shadow on reserve takes r3-02 and r3-03 with cold/warm cache verification. This validates implementation coverage and provenance only; it does not authorize student feedback, and these takes become consumed evidence that cannot be reused for the later fresh-blind release audit.",
      artifact: shadow.acceptanceEvidence?.source || ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE.replace(/\\/g, "/"),
      reason: shadow.blockingReasons || ["ordinary-dynamic-shadow-r3-acceptance-not-run"],
    });
  } else if (!shadow.freshBlindEvidence?.ready) {
    actions.push({
      priority: 1,
      track: "Ordinary dynamic shadow fresh-blind evidence",
      action: "Run `npm run western:ordinary-fresh-blind-eval` on a controlled batch from a performer/voice never used to tune any threshold. Clean-scenario recordings need shadow coverage above the frozen floor; any technique/marked-zone recording must show zero M3+ accusations. Error-scenario recordings without documented positions stay reference-only and must never be counted as precision evidence.",
      artifact: FRESH_BLIND_REPORT_RELATIVE_PATH.replace(/\\/g, "/"),
      reason: shadow.freshBlindEvidence?.blockingReasons || ["fresh-blind-evidence-not-run"],
    });
  } else if (!shadow.authorizationReady) {
    actions.push({
      priority: 1,
      track: "Ordinary dynamic shadow authorization",
      action: "The r3 implementation acceptance and fresh-blind evidence both passed, but the dynamic shadow remains review-only by design. This needs the owner's explicit western-ordinary-dynamic-shadow-release-v1 authorization before any monitored pilot or student-facing promotion.",
      artifact: shadow.acceptanceEvidence?.source || ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE.replace(/\\/g, "/"),
      reason: ["ordinary-dynamic-shadow-authorization-closed"],
    });
  }
  if (
    shadow.policyCReviewAssistEvidence?.ready === true
    && (
      shadow.policyCReviewAssistEvidence.autoAccusationReady !== true
      || shadow.rhythmChannelEvidence?.jointFloorReady !== true
    )
  ) {
    const round5 = shadow.round5TargetedIntake || {};
    const round6 = shadow.round6CounterbalancedCapture || {};
    const segment = round5.segmentEditPathCandidate || {};
    const calibrationAudit = segment.calibrationFailureAudit || {};
    const targetedRunner = segment.temporalOperationPathDiagnostic?.targetedFreshBlindRunner || {};
    const round5Evaluated = Boolean(
      round5.ready === true
        && round5.bindingCurrent === true
        && segment.trainingPerformed === true
        && segment.bindingCurrent === true
        && targetedRunner.evaluationPerformed === true,
    );
    const round5ReadyForEvaluation = Boolean(
      round5.ready === true && round5.bindingCurrent === true && !round5Evaluated,
    );
    const round6Schedule = round6.recordingSchedule || {};
    const round6StagedWorkflowCurrent = Boolean(
      round6.readyForRecording === true
        && round6Schedule.valid === true
        && round6Schedule.semanticHashCurrent === true
        && round6Schedule.sourceBindingsCurrent === true,
    );
    const round6StagedAction = round6Schedule.stageARecordingAuthorizedNow === true
      ? (
        "P0–P2 已全部榨完：7 个冻结可运行候选均在真实干净域安全闸被淘汰，"
        + "公开 Bach10/URMP/MusicNet 也没有可裁定的真实错误正例。"
        + "当前唯一授权范围是 Stage A 的 6 条 calibration："
        + `${(round6Schedule.stageARecordingIds || []).join(", ")}。`
        + "不要录 6 条 fresh，也不要改角色轮换。音频到位后运行 "
        + "`npm run western:round6-stage-a-truth-signoff-pack`；下载完成 JSON，先用 "
        + "`npm run western:round6-stage-a-truth-signoff-apply -- --completed <path>` "
        + "dry-run，只有 `readyToApply=true` 才加 `--apply`。随后依次运行 "
        + "`npm run western:round6-position-balance`、"
        + "`npm run western:round6-stage-a-safety-preflight`，最后只运行一次 "
        + "`npm run western:round6-stage-a-safety-eval`。Stage A 任一真实干净域安全上限"
        + "超限即收线并省掉 fresh 6 条；strict 保持 2/12，学生自动指控保持关闭。"
      )
      : round6Schedule.stageBFreshRecordingAuthorizedNow === true
        ? (
          "Stage A 的 6 条 calibration 已通过冻结的真实干净域安全闸；现在才授权 "
          + `Stage B 的 6 条 untouched fresh：${
            (round6Schedule.stageBFreshRecordingIds || []).join(", ")
          }。`
          + "模型、特征、0.5 决策点和 90% precision / 50% recall / 0 strict-FP "
          + "门槛不得再改。录音后先运行 "
          + "`npm run western:round6-stage-b-truth-signoff-pack`，下载完成 JSON，"
          + "再用 `npm run western:round6-stage-b-truth-signoff-apply -- "
          + "--completed <path>` dry-run，确认 calibration 投影不变后加 `--apply`；"
          + "最后只运行一次 `npm run western:round6-frozen-eval`。该评测只能加载 "
          + "Stage A 模型且不得重新训练；数值通过也不自动授权学生端。"
        )
        : round6Schedule.stageARecordingComplete === true
          && round6Schedule.stageASafetyAttemptFailedClosed !== true
          ? (
            "Stage A 的 6 条 calibration 已完成录音与人工签署；当前不再需要录音。"
            + "依次运行 `npm run western:round6-position-balance`、"
            + "`npm run western:round6-stage-a-safety-preflight`，确认预检通过后只运行一次 "
            + "`npm run western:round6-stage-a-safety-eval`。安全闸通过才允许补 6 条 "
            + "fresh；失败或崩溃均收线且不得重跑。"
          )
          : round6Schedule.stageASafetyAttemptFailedClosed === true
            ? (
              "Stage A 干净域安全闸已失败、崩溃或证据失配，候选按预注册纪律收线。"
              + "不要录 Stage B fresh；strict confirmed recall 保持 2/12，"
              + "教师复核辅助可继续，学生三开关保持 false。"
            )
            : (
              "Round 6 分阶段协议当前 fail-closed；先修复项目状态列出的协议、来源绑定或"
              + "技术包问题。未恢复为 current 前不得录 calibration 或 fresh。"
            );
    actions.push({
      priority: 1,
      track: "Ordinary diagnosis recall",
      action: round5Evaluated
        ? round6StagedWorkflowCurrent
          ? round6StagedAction
          : "The complete-inventory Round 5 frozen first run is complete and the fresh split is now consumed. `extra` numerically reaches 3/6 positives at 0/12 confusion false positives (precision 1.00, recall 0.50), but it is not promotion-eligible: in that fresh split, score context alone separates all 6 extra positives from all 12 negatives, while the evaluated model includes those score-context features. The rhythm self-check likewise has a raw 4/12 at 0/312 false positives, but static score context predicts all 12 extra/drag target positions at 0/324 false positives under leave-one-recording-out in both splits; its apparent precision therefore cannot establish performance generalization. `merged_substitution`, `missing`, and `drag` also fail their numeric gates. A calibration-only audit found position confounding for all three failed gates; once score-only context features are prohibited, no stable performance-evidence candidate meets the joint floor. Therefore no Round 5 gate or rhythm hint is currently promoted. Do not retune on this package. Counterbalance target roles across previous/next interval, written duration, beat strength, normalized position, and segment-edge status in both new calibration and fresh plans; require the position-balance preflight to pass before recording, then select and evaluate a performance-only model. Strict confirmed recall remains 2/12 and all student automatic-accusation paths stay closed."
        : round5ReadyForEvaluation
          ? "Round 5 complete-inventory intake is ready and hash-current. Run `npm run western:round5-segment-edit-path` once with the frozen parameters; do not inspect or retune against the fresh split before that run. Strict confirmed recall remains 2/12 and all student automatic-accusation paths stay closed."
          : "Strict confirmed recall remains 2/12. Raw temporal operation-path use reaches 11/12 but causes 55/253 false positives and is rejected. Three post-inspection candidates are frozen for untouched Round 5 only. Use docs/round5-targeted-diagnosis-capture-pack/index.html to complete the 12-take, complete-inventory matrix, then run the frozen fresh-blind gate without retuning.",
      artifact: round5Evaluated
        ? round6StagedWorkflowCurrent
          ? "docs/western-strings-p3-minimal-recording-plan.md"
          : segment.positionBalanceAudit?.source
            || calibrationAudit.source
            || segment.source
        : round5ReadyForEvaluation
          ? segment.source
        : ROUND5_TEMPORAL_OPERATION_PATH.replace(/\\/g, "/"),
      reason: normalizedReasonList(
        round5Evaluated
          ? round6StagedWorkflowCurrent
            ? [
                "policy-c-auto-accusation-closed",
                ...(round6Schedule.blockingReasons || []),
              ]
            : [
              "policy-c-auto-accusation-closed",
              ...(segment.failedGates || []).map(
                (gate) => `round5-segment-model-gate-failed:${gate}`,
              ),
              ...(targetedRunner.promotionBlockingReasons
                || targetedRunner.blockingReasons
                || []),
              ...(calibrationAudit.positionConfoundingDetectedGates || []).map(
                (gate) => `round5-calibration-score-context-confounded:${gate}`,
              ),
              ...(calibrationAudit.blockingReasons || []),
              ...(segment.promotionEvidenceBlockingReasons || []),
              ...(segment.positionBalanceAudit?.blockingReasons || []),
            ]
          : round5ReadyForEvaluation
            ? ["round5-frozen-first-run-not-performed"]
            : [
                "policy-c-auto-accusation-closed",
                ...(shadow.rhythmChannelEvidence?.blockingReasons
                  || ["relative-ioi-diagnostic-not-ready"]),
                ...(shadow.policyCReviewAssistEvidence.energyRobustnessReady === true
                  ? []
                  : ["policy-c-energy-robustness-not-ready"]),
                "round5-targeted-intake-not-ready",
              ],
      ),
    });
  }
  const reviewAssistPack = shadow.policyCReviewAssistCalibrationPack || {};
  if (reviewAssistPack.readyForReview === true
      && reviewAssistPack.completedReviewPresent !== true) {
    actions.push({
      priority: 2,
      track: "Ordinary review-assist calibration",
      action: "Open the live-bound local review page and independently listen to all 9 candidates (2 confirmed-issue candidates and 7 self-check hints across 4 recordings). Complete the recording metadata and candidate labels, then download `round5-review-assist-calibration.completed.json`. This is calibration-only teacher evidence: it cannot enter fresh-blind denominators, cannot change strict confirmed recall 2/12, and cannot authorize a student accusation. After review, stage it with `npm run western:round5-review-assist-calibration-stage -- --completed <downloaded-json>`.",
      artifact: reviewAssistPack.reviewPage,
      reason: reviewAssistPack.reviewCompletionBlockingReasons,
    });
  } else if (reviewAssistPack.readyForStaging === true) {
    actions.push({
      priority: 2,
      track: "Ordinary review-assist calibration",
      action: `Stage the completed calibration-only review with \`npm run western:round5-review-assist-calibration-stage -- --completed ${reviewAssistPack.completedReview}\`. The staging verifier will recheck the ledger, audio, score, and candidate hashes before writing a private draft; it cannot update fresh-blind evidence or student authorization.`,
      artifact: reviewAssistPack.completedReview,
      reason: ["round5-review-assist-calibration-draft-not-staged"],
    });
  }
  if (!m3plus.m3plusModeEvalReady) {
    actions.push({
      priority: 2,
      track: "M3+ pitch safety rescope",
      action: "Run `npm run western:m3plus-rescope-gate`. It evaluates straight-tone safety, score-marked neutralization, center-pitch evidence, and the fail-closed dispersion guard without requiring technique classification.",
      artifact: m3plus.reviewArtifacts.rescopeGateJson,
      reason: m3plus.blockingReasons,
    });
  } else if (!m3plus.m3plusPitchSafetyReady) {
    actions.push({
      priority: 2,
      track: "M3+ pitch safety rescope",
      action: "Keep M3+ review-only and fail-closed. Execute the same policy on all six declared-only protected units so the frozen inventory reaches 14/14, join independent per-unit intonation gold for all 12 straight-source and all 8 technique-center units, then rerun the gold-free runtime and hardened physical-artifact audit. Do not use the legacy first-measure detector aggregate as release authority.",
      artifact: m3plus.monitoredPilotAudit?.source
        || m3plus.rescopeGate?.source
        || m3plus.reviewArtifacts.rescopeGateJson,
      reason: m3plus.blockingReasons,
    });
  } else if (
    !m3plus.studentGateReady
    && m3plus.authorizationReady === true
    && m3plus.monitoredPilotAudit?.readyForMonitoredPilot === true
  ) {
    actions.push({
      priority: 2,
      track: "M3+ pitch safety rescope",
      action: "The respecified offline pitch-safety gate, review-only gold-free runtime, physical audit, and authorization all pass; the controlled pilot is ready to start. Keep the student runtime disabled by default and use the frozen controlled-pilot start workflow. Legacy technique detectors remain research-only.",
      artifact: m3plus.monitoredPilotAudit?.source
        || m3plus.rescopeGate?.source
        || m3plus.reviewArtifacts.rescopeGateJson,
      reason: ["m3plus-default-student-runtime-fail-closed"],
    });
  } else if (!m3plus.studentGateReady) {
    actions.push({
      priority: 2,
      track: "M3+ pitch safety rescope",
      action: "The respecified offline pitch-safety gate and review-only gold-free runtime pass, but the controlled pilot is not yet authorized. Keep the student runtime disabled and complete the frozen controlled-pilot authorization workflow. Legacy technique detectors remain research-only.",
      artifact: m3plus.monitoredPilotAudit?.source
        || m3plus.rescopeGate?.source
        || m3plus.reviewArtifacts.rescopeGateJson,
      reason: m3plus.blockingReasons,
    });
  }
  const recordingStopLines = (
    shadow.round6CounterbalancedCapture?.recordingSchedule?.stopLines || {}
  );
  const m4FurtherInvestmentStopped = (
    recordingStopLines.m4Omr === "no-further-investment"
  );
  if (!m4FurtherInvestmentStopped && !m4Omr.m4OmrIndependentBenchmarkReady) {
    actions.push({
      priority: 3,
      track: "M4 OMR independent benchmark",
      action: "Run `npm run western:m4-independent-benchmark-audit`. Keep automatic adoption and the student runtime closed unless independent render/scan/photo evidence passes; real-photo consistency must never be promoted to independent accuracy.",
      artifact: m4Omr.artifacts?.independentBenchmarkJson || M4_INDEPENDENT_BENCHMARK_AUDIT.replace(/\\/g, "/"),
      reason: m4Omr.blockingReasons,
    });
  } else if (
    !m4FurtherInvestmentStopped
    && !m4Omr.m4OmrDraftQualityReady
    && m4Omr.humanTask !== "none"
  ) {
    actions.push({
      priority: 3,
      track: "M4 OMR benchmark",
      action: "Machine checks found only self-comparison OMR rows. Do not request teacher audio diagnosis; prepare independent score-editor gold by correcting workspace MXL files against the source score images, then rerun `npm run western:m4-omr-benchmark`.",
      artifact: m4Omr.artifacts.independentGoldTodoHtml || m4Omr.artifacts.independentGoldTodo,
      humanTask: m4Omr.humanTask,
      teacherReviewNeeded: m4Omr.teacherReviewNeeded,
      reason: m4Omr.blockingReasons,
    });
  } else if (!m4FurtherInvestmentStopped && !m4Omr.m4OmrAutomaticAdoptionReady) {
    const realPhotoRows = Number(m4Omr.independentBenchmark?.independentRealPhotoRows || 0);
    actions.push({
      priority: 3,
      track: "M4 OMR automatic adoption",
      action: realPhotoRows >= 3
        ? m4Omr.m4ClarityAdaptationRejected
          ? `Keep OMR draft-only. ${realPhotoRows} independent source-gold photos are available, but 0/${realPhotoRows} pass the complete pitch/onset/measure floor. The bounded Clarity supervised-adaptation pilot has also completed and was rejected because recall, onset, and measure accuracy regressed versus the official baseline. Do not repeat this training or request more human review. A future automatic-adoption attempt requires a materially larger independent photo-to-MusicXML training set or a fundamentally different OMR architecture.`
          : m4Omr.m4ClarityBenchmarkComplete
          ? `Keep OMR draft-only. ${realPhotoRows} independent source-gold photos are available, but 0/${realPhotoRows} pass the complete pitch/onset/measure floor. Audiveris preprocessing, runtime confidence, Oemer, HOMR 0.7.0, and Clarity-OMR all failed to produce a safe production subset. Do not repeat human review or rerun these engines; the next research step must be supervised adaptation or new external blind photos.`
          : m4Omr.m4HomrBenchmarkComplete
            ? `Keep OMR draft-only. ${realPhotoRows} independent source-gold photos are available, but 0/${realPhotoRows} pass the complete pitch/onset/measure floor. Audiveris preprocessing, runtime confidence, Oemer, and HOMR 0.7.0 all failed to produce a safe production subset. Do not repeat human review or rerun these engines; the next research step must be a genuinely different model, supervised adaptation, or new external blind photos.`
          : m4Omr.m4OemerBenchmarkComplete
            ? `Keep OMR draft-only. ${realPhotoRows} independent source-gold photos are available, but 0/${realPhotoRows} pass the strict P>=0.98/R>=0.95 floor. Preprocessing, runtime confidence, and the Oemer stronger-engine comparison all failed to produce a safe production subset. Do not repeat score-editor review or rerun the same engine; only evaluate a genuinely different engine on this frozen benchmark or add external blind photos.`
          : `Keep OMR draft-only. ${realPhotoRows} independent source-gold photos are now available, but 0/${realPhotoRows} pass the strict P>=0.98/R>=0.95 floor; preprocessing and runtime confidence probes also found no safe production subset. The next machine task is a stronger OMR engine on this frozen benchmark, not more score-editor review.`
        : "Keep OMR draft-only. Runtime-visible confidence features cannot select a 90%-precision/20%-coverage safe subset. Create at least 3 independent real-photo MusicXML references, rerun blind OMR, then rerun the confidence probe and independent benchmark audit.",
      artifact: realPhotoRows >= 3
        ? m4Omr.m4ClarityAdaptationRejected
          ? m4Omr.artifacts?.clarityAdaptationBenchmarkJson
          : m4Omr.m4ClarityBenchmarkComplete
          ? m4Omr.artifacts?.clarityBenchmarkJson
          : m4Omr.m4HomrBenchmarkComplete
            ? m4Omr.artifacts?.homrBenchmarkJson
          : m4Omr.m4OemerBenchmarkComplete
            ? m4Omr.artifacts?.oemerBenchmarkJson
          : m4Omr.artifacts?.independentBenchmarkJson
        : m4Omr.artifacts?.independentGoldTodoHtml || m4Omr.artifacts?.independentBenchmarkJson,
      humanTask: m4Omr.humanTask,
      scoreEditorReviewNeeded: m4Omr.scoreEditorReviewNeeded,
      reason: m4Omr.automaticAdoptionBlockingReasons,
    });
  }
  // Once BOTH monitored-pilot audits pass, the release chain (release review ->
  // controlled pilot decision -> owner approval) becomes the top action even
  // while closed research tracks remain project blockers without generating
  // further-investment actions.
  const m3plusPilotAudit = m3plus.monitoredPilotAudit || {};
  const m3plusPilotEvidencePassed = m3plusPilotAudit.readyForMonitoredPilot === true
    && m3plusPilotAudit.teacherReviewNeeded !== true
    && m3plusPilotAudit.defaultM3PlusReadyAfter !== true
    && (m3plusPilotAudit.blockingReasons || []).length === 0;
  if (!actions.length || (ordinaryPilotEvidencePassed && m3plusPilotEvidencePassed)) {
    if (releaseReview?.readyForControlledPilot === true
      && releaseReview?.teacherReviewNeeded !== true
      && releaseReview?.runtimeFailClosed === true) {
      if (!controlledPilotDecision) {
        actions.push({
          priority: 1,
          track: "Controlled pilot decision",
          action: "Release review passed. Run `npm run western:controlled-pilot-decision` to produce the explicit machine-tested decision packet before asking for any more human/teacher review.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: ["decision-packet-missing", "default-runtime-fail-closed"],
        });
      } else if (controlledPilotSession?.sessionStatus === "completed_safe"
        && controlledPilotSession?.executionPerformed === true
        && controlledPilotSession?.pilotRunAccepted === true
        && controlledPilotSession?.defaultRuntimeFailClosedAfter === true
        && controlledPilotSession?.processEnvironmentRestored === true
        && controlledPilotSession?.studentFeedbackPublished === false
        && (controlledPilotSession?.blockingReasons || []).length === 0) {
        const v2AlphaGate = controlledPilotEvidence?.v2AlphaGate || {};
        const scopedCandidate = controlledPilotMachineAudit?.scopedV2AlphaCandidate || {};
        if (scopedCandidate.teacherReviewAllowed === true) {
          const sharedEvidence = `Machine testing passes only for scope=${scopedCandidate.scopeName}: historical precision/coverage=${(Number(scopedCandidate.historical?.precision || 0) * 100).toFixed(2)}%/${(Number(scopedCandidate.historical?.coverage || 0) * 100).toFixed(2)}%, operational precision/coverage=${(Number(scopedCandidate.operational?.knownPrecision || 0) * 100).toFixed(2)}%/${(Number(scopedCandidate.operational?.coverage || 0) * 100).toFixed(2)}% across ${scopedCandidate.operationalRecordingCount || 0} recordings.`;
          actions.push({
            priority: 1,
            track: "Fresh-blind dynamic-shadow release evidence",
            action: `${sharedEvidence} This first-measure RF intake is superseded and cannot be staged or reused. After the live artifact verifier and r3-02/r3-03 acceptance pass, register a wholly new performance and a new piece that are absent from the historical 12 recordings, round-3 acceptance set, and prior review labels. Run the full-score dynamic-shadow precheck, then create the independent blind review package. Default runtime remains fail-closed.`,
            artifact: "data/experiments/western-strings-m3/ordinary-dynamic-shadow-fresh-blind/report.json",
            teacherReviewNeeded: false,
            reason: [
              "historical-first-measure-intake-superseded",
              "fresh-recording-and-new-piece-required",
              "full-score-dynamic-shadow-only",
              "default-runtime-fail-closed",
            ],
          });
        } else if (v2AlphaGate.ready !== true) {
          const precisionPercent = v2AlphaGate.precision === null || v2AlphaGate.precision === undefined
            ? "unavailable"
            : `${(Number(v2AlphaGate.precision) * 100).toFixed(2)}%`;
          const coveragePercent = `${(Number(v2AlphaGate.coverage || 0) * 100).toFixed(2)}%`;
          const reasons = ["default-runtime-fail-closed"];
          if (v2AlphaGate.meetsPrecisionFloor !== true) reasons.push("controlled-pilot-precision-below-v2-alpha");
          if (v2AlphaGate.meetsCoverageFloor !== true) reasons.push("controlled-pilot-coverage-below-v2-alpha");
          if (v2AlphaGate.hasCrossPieceEvidence !== true) reasons.push("controlled-pilot-cross-piece-evidence-missing");
          actions.push({
            priority: 1,
            track: "Controlled pilot coverage audit",
            action: `The machine-only controlled pilot is safe but not V2-alpha: strict self-check precision=${precisionPercent}, effective coverage=${coveragePercent} (${controlledPilotEvidence?.pilotEligibleAutoPassCandidateCount || 0}/${controlledPilotEvidence?.totalCandidateCount || 0}). Keep every non-self-checked model auto-pass suppressed and do not request teacher review yet. The evidence audit rules out threshold tuning alone; improve candidate/localization evidence, then rerun the offline gate.`,
            artifact: CONTROLLED_PILOT_EVIDENCE_AUDIT_MD.replace(/\\/g, "/"),
            teacherReviewNeeded: false,
            reason: reasons,
          });
        } else {
          actions.push({
            priority: 1,
            track: "Controlled pilot completed",
            action: `Controlled pilot evidence now has ${controlledPilotEvidence?.completedSafeSessionCount || 0} safe session(s) across ${controlledPilotEvidence?.safeDistinctRecordingCount || 0} independent recording(s), and it meets the V2-alpha precision/coverage floors. Keep the default student runtime fail-closed; use a fresh blind professional audit before any release decision.`,
            artifact: controlledPilotSession.artifacts?.sessionMd || controlledPilotSession.source,
            reason: ["controlled-pilot-completed-safe", "default-runtime-fail-closed"],
          });
        }
      } else if (controlledPilotDecision.readyToStartControlledPilot === true) {
        actions.push({
          priority: 1,
          track: "Start monitored pilot",
          action: "Controlled-pilot approval is present and machine checks are green. Run `npm run western:controlled-pilot-run -- --execute --limit 1` for one offline monitored batch; keep default student runtime fail-closed.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: ["approved-monitored-pilot-only"],
        });
      } else if (controlledPilotDecision.approvalDeferred === true) {
        actions.push({
          priority: 1,
          track: "Controlled pilot deferred",
          action: "The product owner explicitly deferred the monitored pilot. Keep the system safely review-only/fail-closed and do not ask for more teacher review for this release decision.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: controlledPilotDecision.blockingReasons || ["controlled-pilot-explicitly-deferred"],
        });
      } else {
        actions.push({
          priority: 1,
          track: "Controlled pilot approval",
          action: "Machine self-tests are complete and no teacher review is needed now. The only remaining action is product-owner approval of the separate monitored pilot, or stop safely in review-only mode.",
          artifact: CONTROLLED_PILOT_DECISION_MD.replace(/\\/g, "/"),
          reason: controlledPilotDecision.blockingReasons || ["controlled-pilot-approval-missing"],
        });
      }
    } else {
      actions.push({
        priority: 1,
        track: "Release review",
        action: "Both label gates have enough data for offline evaluation. Run `npm run western:release-review` to aggregate ordinary, M3+, and M4 machine checks before touching any runtime gate.",
        artifact: RELEASE_REVIEW_MD.replace(/\\/g, "/"),
        reason: [],
      });
    }
  }
  // stable sort: the release chain (priority 1) precedes pending-track notes
  return actions.sort((left, right) => (left.priority ?? 99) - (right.priority ?? 99));
}

const PHOTO_SCORE_BATCH_RUNS = path.join(
  "data", "experiments", "western-strings-m4", "photo-score-batch-runs.jsonl",
);

async function readPhotoScoreChainStatus() {
  const preflight = await readJson(PHOTO_SCORE_DEPLOYMENT_PREFLIGHT);
  const review = await readJson(HOMR_REVIEW_RECORD);
  const deploymentSnapshot = evaluateHomrDeploymentSnapshot({
    review,
    reviewSha256: await sha256FileOrEmpty(HOMR_REVIEW_RECORD),
    manifestSha256: await sha256FileOrEmpty(PHOTO_SCORE_DEPLOYMENT_CONFIG),
    lockSha256: await sha256FileOrEmpty(PHOTO_SCORE_HOMR_RUNTIME_LOCK),
    preflight,
  });
  const base = {
    codeWired: true,
    wired: true,
    studentFacing: false,
    automaticAdoptionAuthorized: false,
    governanceConfiguredReady: deploymentSnapshot.licenseReviewReady,
    runtimeReady: deploymentSnapshot.artifactIntegrityReady && preflight?.hostReady === true,
    deploymentReady: deploymentSnapshot.deploymentPreflightReady,
    productionPoolReady: deploymentSnapshot.productionPoolReady,
    homrReviewStatus: review?.decision?.status || "missing",
    preflightBindingCurrent: deploymentSnapshot.preflightBindingCurrent,
    blockingReasons: deploymentSnapshot.blockingReasons,
    deploymentConfig: PHOTO_SCORE_DEPLOYMENT_CONFIG.replace(/\\/g, "/"),
    reviewRecord: HOMR_REVIEW_RECORD.replace(/\\/g, "/"),
    preflightReport: PHOTO_SCORE_DEPLOYMENT_PREFLIGHT.replace(/\\/g, "/"),
    acceptedImageTypes: ["JPG", "PNG", "WebP"],
    intake: "Browser multipart upload or POST /api/strings/analyze (kind=photo-score, review_required)",
    batchCommand: "Controlled queue Run batch audit or npm run western:photo-score-batch",
    source: PHOTO_SCORE_BATCH_RUNS.replace(/\\/g, "/"),
  };
  try {
    const text = await fs.readFile(PHOTO_SCORE_BATCH_RUNS, "utf8");
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const decisions = {};
    let legacyPreP0RunCount = 0;
    for (const row of rows) {
      const legacy = row.status === "ok" && Number(row.p0StructureGateVersion || 0) < 1;
      if (legacy) legacyPreP0RunCount += 1;
      const key = row.status === "ok"
        ? `${legacy ? "legacy-pre-p0:" : ""}${String(row.decision || "").split(":")[0] || "ok"}`
        : `failed:${row.reason || "unknown"}`;
      decisions[key] = (decisions[key] || 0) + 1;
    }
    return { ...base, batchRuns: rows.length, legacyPreP0RunCount, decisions };
  } catch {
    return { ...base, batchRuns: 0, legacyPreP0RunCount: 0, decisions: {} };
  }
}

export async function buildProjectStatus(args = {}) {
  const [
    controlledCandidate,
    m3plusPitchModes,
    m4Omr,
    releaseReview,
    controlledPilotDecision,
    controlledPilotSessions,
    controlledPilotMachineAudit,
    freshBlindIntake,
    publicBachV2Audit,
    phenicxAlignment,
    muscCalibration,
    muscFresh,
    violinMidiAudit,
    musicnetAccompaniedViolin,
    musicnetYourmt3,
    measurePolicyAudit,
    measureJointEvidenceAudit,
    dynamicPerturbationGate,
    dynamicWeakCombinedGate,
    dynamicWeakCombinedConfirmation,
  ] = await Promise.all([
    buildControlledStatus(),
    buildM3PlusStatus(),
    buildM4OmrStatus(),
    readJson(RELEASE_REVIEW),
    readJson(CONTROLLED_PILOT_DECISION),
    readControlledPilotSessions(args.controlledPilotSessionsRoot),
    readJson(CONTROLLED_PILOT_EVIDENCE_AUDIT),
    readJson(FRESH_BLIND_INTAKE_STATUS),
    readJson(PUBLIC_BACH_V2_AUDIT),
    readJson(PHENICX_ALIGNMENT_REPORT),
    readJson(MUSC_CALIBRATION_REPORT),
    readJson(MUSC_FRESH_REPORT),
    readJson(VIOLIN_MIDI_AUDIT),
    readJson(MUSICNET_ACCOMPANIED_VIOLIN_REPORT),
    readJson(MUSICNET_YOURMT3_CHALLENGER),
    readJson(MEASURE_POLICY_AUDIT),
    readJson(MEASURE_JOINT_EVIDENCE_AUDIT),
    readJson(DYNAMIC_PERTURBATION_GATE),
    readJson(DYNAMIC_WEAK_COMBINED_GATE),
    readJson(DYNAMIC_WEAK_COMBINED_CONFIRMATION),
  ]);
  const controlledPilotSession = controlledPilotSessions.find((session) => session.executionPerformed === true)
    || controlledPilotSessions[0]
    || null;
  const controlledPilotEvidence = summarizeControlledPilotEvidence(controlledPilotSessions);
  const publicModelValidation = summarizePublicModelValidation({
    phenicxAlignment,
    muscCalibration,
    muscFresh,
    violinMidiAudit,
    musicnetAccompaniedViolin,
    musicnetYourmt3,
  });
  const runtimeStudentGate = {
    ordinaryUploadAutoFeedbackReady: false,
    m3plusAutoFeedbackReady: false,
    m4OmrAutoScoreReady: false,
    policy: "fail-closed",
  };
  const currentPilotLiveEvidenceBinding = buildControlledPilotLiveEvidenceBinding({
    runtimeStudentGate,
    tracks: {
      controlledCandidate,
      m3plusPitchModes,
    },
  });
  const currentPilotLiveEvidenceReady = controlledPilotLiveEvidenceReady(
    currentPilotLiveEvidenceBinding,
  );
  const currentControlledPilotAuthority = summarizeCurrentControlledPilotAuthority({
    releaseReview,
    controlledPilotDecision,
    currentLiveEvidenceBinding: currentPilotLiveEvidenceBinding,
    currentLiveEvidenceReady: currentPilotLiveEvidenceReady,
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    project: "western-strings-practice-diagnostics",
    branchGoal: "advance handbook batches without changing student runtime gates before evidence is ready",
    reviewPolicy: {
      source: REVIEW_POLICY_DOC.replace(/\\/g, "/"),
      rule: "machine-self-test-before-human-review",
    },
    runtimeStudentGate,
    photoScoreOfflineChain: await readPhotoScoreChainStatus(),
    publicProfessionalBenchmark: publicBachV2Audit
      ? {
          source: PUBLIC_BACH_V2_AUDIT.replace(/\\/g, "/"),
          scope: publicBachV2Audit.scope || "public-professional-violin-recordings",
          publicProfessionalV2AlphaReady: publicBachV2Audit.gates?.publicProfessionalV2AlphaReady === true,
          publicEventV3PrototypeReady: publicBachV2Audit.gates?.publicEventV3PrototypeReady === true,
          publicRawAudioCorePrototypeReady: publicBachV2Audit.gates?.publicRawAudioCorePrototypeReady === true,
          publicWeakNotePrototypeReady: publicBachV2Audit.gates?.publicWeakNotePrototypeReady === true,
          v3Ready: publicBachV2Audit.gates?.v3Ready === true,
          nearPerfectReady: publicBachV2Audit.gates?.nearPerfectReady === true,
          defaultStudentReleaseEligible: publicBachV2Audit.gates?.defaultStudentReleaseEligible === true,
          blockingReasons: publicBachV2Audit.blockingReasons || [],
        }
      : {
          source: PUBLIC_BACH_V2_AUDIT.replace(/\\/g, "/"),
          missing: true,
          defaultStudentReleaseEligible: false,
        },
    publicModelValidation,
    measureFeedbackAudit: measurePolicyAudit ? {
      source: MEASURE_POLICY_AUDIT.replace(/\\/g, "/"),
      evalOnly: measurePolicyAudit.evalOnly === true,
      measureAggregationReleaseReady:
        measurePolicyAudit.measureAggregationReleaseReady === true,
      clean: measurePolicyAudit.clean || {},
      safety: measurePolicyAudit.safety || {},
      eventConfidenceFloorSweep:
        measurePolicyAudit.eventConfidenceFloorSweep || {},
      jointEvidence: measureJointEvidenceAudit ? {
        source: MEASURE_JOINT_EVIDENCE_AUDIT.replace(/\\/g, "/"),
        evalOnly: measureJointEvidenceAudit.evalOnly === true,
        evaluatedCandidateCount: measureJointEvidenceAudit.evaluatedCandidateCount ?? 0,
        safeCandidateCount: measureJointEvidenceAudit.safeCandidateCount ?? 0,
        releaseCandidateCount: measureJointEvidenceAudit.releaseCandidateCount ?? 0,
        bestSafeCandidate: measureJointEvidenceAudit.bestSafeCandidate || null,
        bestCoverageFloorTradeoff:
          measureJointEvidenceAudit.bestCoverageFloorTradeoff || null,
        measureJointEvidenceReleaseReady:
          measureJointEvidenceAudit.measureJointEvidenceReleaseReady === true,
        productionPolicyChanged:
          measureJointEvidenceAudit.productionPolicyChanged === true,
        blockingReasons: measureJointEvidenceAudit.blockingReasons || [],
      } : {
        source: MEASURE_JOINT_EVIDENCE_AUDIT.replace(/\\/g, "/"),
        missing: true,
        measureJointEvidenceReleaseReady: false,
        productionPolicyChanged: false,
      },
      studentGateReady: false,
    } : {
      source: MEASURE_POLICY_AUDIT.replace(/\\/g, "/"),
      missing: true,
      measureAggregationReleaseReady: false,
      jointEvidence: {
        source: MEASURE_JOINT_EVIDENCE_AUDIT.replace(/\\/g, "/"),
        missing: true,
        measureJointEvidenceReleaseReady: false,
        productionPolicyChanged: false,
      },
      studentGateReady: false,
    },
    dynamicEvidenceAudit: dynamicPerturbationGate ? {
      source: DYNAMIC_PERTURBATION_GATE.replace(/\\/g, "/"),
      publicCorePerturbationGateReady:
        dynamicPerturbationGate.publicCorePerturbationGateReady === true,
      weakNoteGateReady: dynamicPerturbationGate.weakNoteGateReady === true,
      publicAllPerturbationGateReady:
        dynamicPerturbationGate.publicAllPerturbationGateReady === true,
      jointSafetyProbe: dynamicPerturbationGate.jointSafetyProbe || {},
      combinedWeakGate: dynamicWeakCombinedGate ? {
        source: DYNAMIC_WEAK_COMBINED_GATE.replace(/\\/g, "/"),
        exploratorySafeFallbackHoldoutPassed:
          dynamicWeakCombinedGate.exploratorySafeFallbackHoldoutPassed === true,
        releaseCoverageReady: dynamicWeakCombinedGate.releaseCoverageReady === true,
        holdout: dynamicWeakCombinedGate.holdout || {},
        blockingReasons: dynamicWeakCombinedGate.blockingReasons || [],
        studentGateReady: false,
      } : {
        source: DYNAMIC_WEAK_COMBINED_GATE.replace(/\\/g, "/"),
        missing: true,
        releaseCoverageReady: false,
        studentGateReady: false,
      },
      combinedWeakConfirmation: dynamicWeakCombinedConfirmation ? {
        source: DYNAMIC_WEAK_COMBINED_CONFIRMATION.replace(/\\/g, "/"),
        freshPublicSyntheticConfirmationReady:
          dynamicWeakCombinedConfirmation.freshPublicSyntheticConfirmationReady === true,
        releaseCoverageReady:
          dynamicWeakCombinedConfirmation.releaseCoverageReady === true,
        selectedPolicy: dynamicWeakCombinedConfirmation.selectedPolicy || null,
        confirmationRank1:
          dynamicWeakCombinedConfirmation.confirmationRank1 || {},
        blockingReasons:
          dynamicWeakCombinedConfirmation.blockingReasons || [],
        studentGateReady: false,
      } : {
        source: DYNAMIC_WEAK_COMBINED_CONFIRMATION.replace(/\\/g, "/"),
        missing: true,
        freshPublicSyntheticConfirmationReady: false,
        releaseCoverageReady: false,
        studentGateReady: false,
      },
      blockingReasons: dynamicPerturbationGate.blockingReasons || [],
      studentGateReady: false,
    } : {
      source: DYNAMIC_PERTURBATION_GATE.replace(/\\/g, "/"),
      missing: true,
      publicAllPerturbationGateReady: false,
      studentGateReady: false,
    },
    releaseReview: currentControlledPilotAuthority.releaseReview,
    controlledPilotDecision: currentControlledPilotAuthority.controlledPilotDecision,
    controlledPilotSession: controlledPilotSession
      ? {
          source: controlledPilotSession.source,
          sessionId: controlledPilotSession.sessionId || "",
          generatedAt: controlledPilotSession.generatedAt || "",
          sessionStatus: controlledPilotSession.sessionStatus || "",
          executionPerformed: controlledPilotSession.executionPerformed === true,
          pilotRunAccepted: controlledPilotSession.pilotRunAccepted === true,
          approvedBy: controlledPilotSession.approvedBy || "",
          selectedSubmissions: controlledPilotSession.selectedSubmissions || [],
          historyExcludedRecordingIds: controlledPilotSession.historyExcludedRecordingIds || [],
          additionalExcludedRecordingIds: controlledPilotSession.additionalExcludedRecordingIds || [],
          effectiveExcludedRecordingIds: controlledPilotSession.effectiveExcludedRecordingIds || [],
          monitoring: controlledPilotSession.monitoring || {},
          defaultRuntimeFailClosedAfter: controlledPilotSession.defaultRuntimeFailClosedAfter === true,
          processEnvironmentRestored: controlledPilotSession.processEnvironmentRestored === true,
          studentFeedbackPublished: controlledPilotSession.studentFeedbackPublished === true,
          eligibleAsCurrentReleaseEvidence: false,
          blockingReasons: controlledPilotSession.blockingReasons || [],
          artifacts: controlledPilotSession.artifacts || {},
        }
      : {
          source: CONTROLLED_PILOT_SESSIONS_ROOT.replace(/\\/g, "/"),
          missing: true,
        },
    controlledPilotEvidence,
    controlledPilotMachineAudit: controlledPilotMachineAudit
      ? {
          source: CONTROLLED_PILOT_EVIDENCE_AUDIT.replace(/\\/g, "/"),
          machinePreflightPassed: controlledPilotMachineAudit.machinePreflightPassed === true,
          teacherReviewAllowed: controlledPilotMachineAudit.teacherReviewAllowed === true,
          thresholdDiagnostic: controlledPilotMachineAudit.thresholdDiagnostic
            ? {
                operationalCandidateRows: controlledPilotMachineAudit.thresholdDiagnostic.operationalCandidateRows || 0,
                operationalKnownLabelRows: controlledPilotMachineAudit.thresholdDiagnostic.operationalKnownLabelRows || 0,
                simpleThresholdCandidateFound: controlledPilotMachineAudit.thresholdDiagnostic.simpleThresholdCandidateFound === true,
                conclusion: controlledPilotMachineAudit.thresholdDiagnostic.conclusion || "",
              }
            : {},
          scopedV2AlphaCandidate: controlledPilotMachineAudit.scopedV2AlphaCandidate || {},
          blockingReasons: controlledPilotMachineAudit.blockingReasons || [],
        }
      : {
          source: CONTROLLED_PILOT_EVIDENCE_AUDIT.replace(/\\/g, "/"),
          missing: true,
        },
    freshBlindIntake: freshBlindIntake
      ? {
          source: FRESH_BLIND_INTAKE_STATUS.replace(/\\/g, "/"),
          summary: FRESH_BLIND_INTAKE_STATUS_MD.replace(/\\/g, "/"),
          readyForMachinePrecheck: false,
          historicalReadyForMachinePrecheck: freshBlindIntake.readyForMachinePrecheck === true,
          eligibleAsCurrentReleaseEvidence: false,
          authorityStatus: "superseded-historical-first-measure-only",
          candidate: freshBlindIntake.candidate || {},
          scope: {
            ...(freshBlindIntake.scope || {}),
            releaseAuthority: false,
            supersededBy: "ordinary-dynamic-shadow-full-score-fresh-blind-v1",
          },
          blockingReasons: [
            "historical-first-measure-intake-superseded",
            ...(freshBlindIntake.blockingReasons || []),
          ],
          warnings: freshBlindIntake.warnings || [],
        }
      : {
          source: FRESH_BLIND_INTAKE_STATUS.replace(/\\/g, "/"),
          summary: FRESH_BLIND_INTAKE_STATUS_MD.replace(/\\/g, "/"),
          readyForMachinePrecheck: false,
          historicalReadyForMachinePrecheck: false,
          eligibleAsCurrentReleaseEvidence: false,
          authorityStatus: "superseded-historical-first-measure-only",
          missing: true,
          blockingReasons: [
            "historical-first-measure-intake-superseded",
            "fresh-blind-intake-status-missing",
        ],
      },
    tracks: {
      controlledCandidate,
      m3plusPitchModes,
      m4Omr,
    },
    nextActions: summarizeNextActions(
      controlledCandidate,
      m3plusPitchModes,
      m4Omr,
      currentControlledPilotAuthority.releaseReview,
      currentControlledPilotAuthority.controlledPilotDecision,
      controlledPilotSession,
      controlledPilotEvidence,
      controlledPilotMachineAudit,
      freshBlindIntake,
    ),
  };
}

export async function writeProjectStatus(status, out) {
  const outPath = path.resolve(process.cwd(), out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return outPath;
}

function printProjectStatus(status, outPath) {
  const controlledCandidate = status.tracks?.controlledCandidate || {};
  const m3plusPitchModes = status.tracks?.m3plusPitchModes || {};
  const m4Omr = status.tracks?.m4Omr || {};
  console.log(JSON.stringify({
    ok: status.ok,
    reviewPolicy: status.reviewPolicy,
    runtimeStudentGate: status.runtimeStudentGate,
    photoScoreOfflineChain: status.photoScoreOfflineChain,
    publicProfessionalBenchmark: status.publicProfessionalBenchmark,
    publicModelValidation: status.publicModelValidation,
    measureFeedbackAudit: status.measureFeedbackAudit,
    dynamicEvidenceAudit: status.dynamicEvidenceAudit,
    releaseReview: status.releaseReview,
    controlledPilotSession: status.controlledPilotSession,
    controlledPilotEvidence: status.controlledPilotEvidence,
    controlledPilotMachineAudit: status.controlledPilotMachineAudit,
    controlledCandidate: {
      ready: controlledCandidate.studentSafeCandidateGateReady,
      counts: controlledCandidate.counts,
      confidencePilot: controlledCandidate.confidencePilot,
      ordinaryDynamicShadow: controlledCandidate.ordinaryDynamicShadow,
      blockingReasons: controlledCandidate.blockingReasons,
    },
    m3plusPitchModes: {
      ready: m3plusPitchModes.m3plusPitchSafetyReady,
      offlineEvidenceReady: m3plusPitchModes.offlineEvidenceReady,
      reviewOnlyRuntimeWired: m3plusPitchModes.reviewOnlyRuntimeWired,
      runtimeFoundationReady: m3plusPitchModes.runtimeFoundationReady,
      runtimeAuditReady: m3plusPitchModes.runtimeAuditReady,
      physicalEvidenceCurrent: m3plusPitchModes.physicalEvidenceCurrent,
      authorizationReady: m3plusPitchModes.authorizationReady,
      studentGateReady: m3plusPitchModes.studentGateReady,
      rescopeGate: m3plusPitchModes.rescopeGate,
      legacyDetectorEvidenceResearchOnly: true,
      round2AlignedEval: m3plusPitchModes.round2AlignedEval,
      round2FeatureDiagnostic: m3plusPitchModes.round2FeatureDiagnostic,
      supplementalIntake: m3plusPitchModes.supplementalIntake,
      supplementalMachineEval: m3plusPitchModes.supplementalMachineEval,
      supplementalProtocolDiagnostic: m3plusPitchModes.supplementalProtocolDiagnostic,
      supplementalFeatureAudit: m3plusPitchModes.supplementalFeatureAudit,
      monitoredPilotAudit: m3plusPitchModes.monitoredPilotAudit,
      counts: m3plusPitchModes.counts,
      blockingReasons: m3plusPitchModes.blockingReasons,
    },
    m4Omr: {
      datasetReady: m4Omr.m4OmrBenchmarkDatasetReady,
      draftQualityReady: m4Omr.m4OmrDraftQualityReady,
      independentBenchmarkReady: m4Omr.m4OmrIndependentBenchmarkReady,
      accuracyClaimReady: m4Omr.m4OmrAccuracyClaimReady,
      automaticAdoptionReady: m4Omr.m4OmrAutomaticAdoptionReady,
      homrLicenseReviewReady: m4Omr.m4HomrLicenseReviewReady,
      homrArtifactIntegrityReady: m4Omr.m4HomrArtifactIntegrityReady,
      homrDeploymentPreflightReady: m4Omr.m4HomrDeploymentPreflightReady,
      homrProductionPoolReady: m4Omr.m4HomrProductionPoolReady,
      homrMainlineExecutable: m4Omr.m4HomrMainlineExecutable,
      homrGovernance: m4Omr.homrGovernance,
      greenSequenceGatePassed: m4Omr.m4GreenSequenceGatePassed,
      greenFeedbackRecommendedForProduction: m4Omr.m4GreenFeedbackRecommendedForProduction,
      greenFreshValidationCandidateFound: m4Omr.m4GreenFreshValidationCandidateFound,
      greenReleaseGateCandidateFound: m4Omr.m4GreenReleaseGateCandidateFound,
      greenProductionPolicyChanged: m4Omr.m4GreenProductionPolicyChanged,
      adaptiveInterlineProbeEvaluated: m4Omr.m4AdaptiveInterlineProbeEvaluated,
      adaptiveInterlineProductionPolicyChanged:
        m4Omr.m4AdaptiveInterlineProductionPolicyChanged,
      adaptiveInterlineProbe: m4Omr.adaptiveInterlineProbe,
      sameEditionBenchmark: m4Omr.sameEditionBenchmark,
      sameEditionBenchmarkEvaluated: m4Omr.m4SameEditionBenchmarkEvaluated,
      sameEditionHomrStrictPositive: m4Omr.m4SameEditionHomrStrictPositive,
      sameEditionAutomaticAdoptionReady: m4Omr.m4SameEditionAutomaticAdoptionReady,
      teacherReviewNeeded: m4Omr.teacherReviewNeeded,
      scoreEditorReviewNeeded: m4Omr.scoreEditorReviewNeeded,
      humanTask: m4Omr.humanTask,
      independentGoldWorkspaceAudit: m4Omr.independentGoldWorkspaceAudit,
      goldProvenanceAudit: m4Omr.goldProvenanceAudit,
      independentBenchmark: m4Omr.independentBenchmark,
      counts: m4Omr.counts,
      automaticAdoptionBlockingReasons: m4Omr.automaticAdoptionBlockingReasons,
      blockingReasons: m4Omr.blockingReasons,
    },
    nextActions: status.nextActions,
    out: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await buildProjectStatus();
  const outPath = await writeProjectStatus(status, args.out);
  printProjectStatus(status, outPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
