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
  auditFreshBlindEvidence,
  auditFreshBlindEvidenceLiveArtifacts,
} from "./eval-western-ordinary-fresh-blind.mjs";
import { loadM4aGateSplitDecision } from "./m4a-supported-edition-governance.mjs";
import { loadM4bPocPromotionDecision } from "./m4b-poc-promotion-governance.mjs";
import { auditM4aSupportedEditionRegistry } from "./audit-western-m4a-supported-edition-registry.mjs";
import { auditM4aEngineeringAcceptance } from "./audit-western-m4a-engineering-acceptance.mjs";
import { auditM4aRealPhotoAcceptance } from "./audit-western-m4a-real-photo-acceptance.mjs";
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
const V2_ALPHA_MIN_PRECISION = 0.9;
const V2_ALPHA_MIN_COVERAGE = 0.2;
const ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "ordinary-dynamic-shadow-r3-acceptance",
  "report.json",
);
const ORDINARY_DYNAMIC_CONTRACT_VERSION = "western-ordinary-dynamic-shadow-candidate-v1";
const ORDINARY_DYNAMIC_POLICY_VERSION = "western-ordinary-dynamic-shadow-policy-v1";
const ORDINARY_DYNAMIC_GATE_VERSION = "western-ordinary-dynamic-shadow-gate-v1-review-only";
const ORDINARY_DYNAMIC_ACCEPTANCE_VERSION = "western-ordinary-dynamic-shadow-r3-acceptance-v1";
const ORDINARY_DYNAMIC_TIMING_MODE = "basic-pitch-dtw";
const ORDINARY_DYNAMIC_RUNTIME_ID = "western-ordinary-dynamic-shadow-audio-py311";
const ORDINARY_DYNAMIC_MODEL_SHA256 = "c6595f299ff83c52e89555789f7e3e829a6a0f25b6a88f7e99073af5a2470dc4";
const ORDINARY_DYNAMIC_ACCEPTANCE_RECORDINGS = ["r3-02", "r3-03"];
const ORDINARY_DYNAMIC_ACCEPTANCE_LIVE_VERIFIER_IMPLEMENTED = true;
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
const M4_HOMR_BENCHMARK = path.join(
  "docs",
  "evidence",
  "western-strings-homr-sourcegold-20260717.json",
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
} = {}) {
  const alignmentEngineeringGatePassed = phenicxAlignment?.ok === true
    && phenicxAlignment?.alignmentGatePassed === true;
  const alignmentPolyphonicGatePassed = phenicxAlignment?.polyphonicSubgroupGate?.passed === true;
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
    && alignmentPolyphonicGatePassed;
  const weakLabelSourceReady = violinMidiAudit?.ok === true
    && violinMidiAudit?.readyAsWeakLabelSource === true;
  const independentRecognitionBenchmarkReady = violinMidiAudit?.ok === true
    && violinMidiAudit?.readyAsIndependentRecognitionBenchmark === true;
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
  blockingReasons.push("student-domain-evidence-not-covered");
  return {
    scope: "public-professional-violin-eval-only",
    artifacts: {
      phenicxAlignment: PHENICX_ALIGNMENT_REPORT.replace(/\\/g, "/"),
      muscCalibration: MUSC_CALIBRATION_REPORT.replace(/\\/g, "/"),
      muscFreshConfirmation: MUSC_FRESH_REPORT.replace(/\\/g, "/"),
      violinMidiAudit: VIOLIN_MIDI_AUDIT.replace(/\\/g, "/"),
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

async function buildOrdinaryDynamicShadowStatus() {
  const runtime = evaluateOrdinaryAudioRuntime();
  const [acceptance, acceptanceArtifact] = await Promise.all([
    readJson(ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE),
    hashWorkspaceArtifact(ORDINARY_DYNAMIC_SHADOW_ACCEPTANCE),
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
  const readiness = await readJson(M4_READINESS);
  const benchmark = await readJson(M4_BENCHMARK);
  const independentBenchmark = await readJson(M4_INDEPENDENT_BENCHMARK_AUDIT);
  const oemerBenchmark = await readJson(M4_OEMER_BENCHMARK);
  const homrEvidence = await readJson(M4_HOMR_BENCHMARK);
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
    m4OmrBenchmarkDatasetReady: readinessReady,
    m4OmrDraftQualityReady: draftQualityReady,
    m4OmrIndependentBenchmarkReady: independentBenchmarkReady,
    m4OmrAccuracyClaimReady: independentBenchmarkReady,
    m4OmrAutomaticAdoptionReady: automaticAdoptionReady,
    m4OemerBenchmarkComplete: oemerBenchmark?.complete === true,
    m4OemerAutomaticAdoptionReady: oemerBenchmark?.gate?.automaticAdoptionReady === true,
    m4HomrBenchmarkComplete: homrBenchmark?.complete === true,
    m4HomrAutomaticAdoptionReady: homrBenchmark?.gate?.automaticAdoptionReady === true,
    m4HomrLicenseReviewReady: homrLicenseReviewReady,
    m4HomrArtifactIntegrityReady: homrArtifactIntegrityReady,
    m4HomrDeploymentPreflightReady: homrDeploymentPreflightReady,
    m4HomrProductionPoolReady: homrProductionPoolReady,
    m4HomrMainlineExecutable: false,
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
      m4bPocPromotionThresholdDecisionJson: m4bPocPromotionDecision.source,
      m4aRegistrationAuditJson: "data/experiments/western-strings-m4a/registration-audit.json",
      readinessJson: M4_READINESS.replace(/\\/g, "/"),
      benchmarkJson: M4_BENCHMARK.replace(/\\/g, "/"),
      independentBenchmarkJson: M4_INDEPENDENT_BENCHMARK_AUDIT.replace(/\\/g, "/"),
      oemerBenchmarkJson: M4_OEMER_BENCHMARK.replace(/\\/g, "/"),
      homrBenchmarkJson: M4_HOMR_BENCHMARK.replace(/\\/g, "/"),
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
  } else if (!m3plus.studentGateReady) {
    actions.push({
      priority: 2,
      track: "M3+ pitch safety rescope",
      action: "The respecified offline pitch-safety gate passes and the review-only gold-free runtime is wired and physically audited. Keep the student runtime disabled: the student/pilot executor and the release authorization are the parts that are not wired. Legacy technique detectors remain research-only.",
      artifact: m3plus.rescopeGate?.source || m3plus.reviewArtifacts.rescopeGateJson,
      reason: ["m3plus-runtime-disabled-by-default", "m3plus-student-executor-and-authorization-not-wired"],
    });
  }
  if (!m4Omr.m4OmrIndependentBenchmarkReady) {
    actions.push({
      priority: 3,
      track: "M4 OMR independent benchmark",
      action: "Run `npm run western:m4-independent-benchmark-audit`. Keep automatic adoption and the student runtime closed unless independent render/scan/photo evidence passes; real-photo consistency must never be promoted to independent accuracy.",
      artifact: m4Omr.artifacts?.independentBenchmarkJson || M4_INDEPENDENT_BENCHMARK_AUDIT.replace(/\\/g, "/"),
      reason: m4Omr.blockingReasons,
    });
  } else if (!m4Omr.m4OmrDraftQualityReady && m4Omr.humanTask !== "none") {
    actions.push({
      priority: 3,
      track: "M4 OMR benchmark",
      action: "Machine checks found only self-comparison OMR rows. Do not request teacher audio diagnosis; prepare independent score-editor gold by correcting workspace MXL files against the source score images, then rerun `npm run western:m4-omr-benchmark`.",
      artifact: m4Omr.artifacts.independentGoldTodoHtml || m4Omr.artifacts.independentGoldTodo,
      humanTask: m4Omr.humanTask,
      teacherReviewNeeded: m4Omr.teacherReviewNeeded,
      reason: m4Omr.blockingReasons,
    });
  } else if (!m4Omr.m4OmrAutomaticAdoptionReady) {
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
  // while research-only tracks (e.g. M4 automatic adoption) stay blocked.
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
