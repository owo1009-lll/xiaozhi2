import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTROLLED_PILOT_LIVE_EVIDENCE_CONTRACT,
  buildControlledPilotLiveEvidenceBinding,
  buildProjectStatus,
  controlledPilotLiveEvidenceReady,
} from "./status-western-strings-project.mjs";
import {
  REQUIRED_APPROVED_TRACKS,
  SCOPE_CONTRACT,
} from "./record-western-controlled-pilot-decision.mjs";

const DEFAULT_RELEASE_REVIEW = path.join("data", "experiments", "western-strings-release-review.json");
const DEFAULT_OUT = path.join("data", "experiments", "western-strings-controlled-pilot-decision.json");
const DEFAULT_SUMMARY = path.join("data", "experiments", "western-strings-controlled-pilot-decision.md");
const DEFAULT_APPROVAL = path.join("data", "experiments", "western-strings-controlled-pilot-approval.json");
const DEFAULT_APPROVAL_TEMPLATE = path.join("data", "experiments", "western-strings-controlled-pilot-approval.template.json");

function parseArgs(argv) {
  const args = {
    releaseReview: DEFAULT_RELEASE_REVIEW,
    out: DEFAULT_OUT,
    summary: DEFAULT_SUMMARY,
    approval: DEFAULT_APPROVAL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--release-review") args.releaseReview = argv[++index] || args.releaseReview;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--summary") args.summary = argv[++index] || args.summary;
    else if (arg === "--approval") args.approval = argv[++index] || args.approval;
  }
  return args;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function rel(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function bulletList(items) {
  const values = (items || []).filter(Boolean);
  return values.length ? values.map((item) => `- ${item}`).join("\n") : "- none";
}

// The approval must bind to the CURRENT pilot scope contract. Approvals from
// the superseded first-measure slide/trill era carry no scopeContract (or an
// older value) and must not start a pilot under the rescope contract.
const REQUIRED_SCOPE_CONTRACT = SCOPE_CONTRACT;
const REQUIRED_ORDINARY_AUTHORIZATION_CONTRACT = "western-ordinary-dynamic-shadow-release-v1";
const REQUIRED_M3PLUS_EVALUATION_CONTRACT = "m3plus-rescope-four-zone-v2";
const REQUIRED_M3PLUS_RUNTIME_CONTRACT = "m3plus-gold-free-runtime-v1";

function normalizedApprovedTracks(approval) {
  return [...new Set((Array.isArray(approval?.approvedTracks) ? approval.approvedTracks : [])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean))].sort();
}

function approvalTracksAreValid(approval) {
  return normalizedApprovedTracks(approval).join(",")
    === [...REQUIRED_APPROVED_TRACKS].sort().join(",");
}

function approvalConfirmationsAreValid(approval) {
  return approval?.confirmSeparateMonitoredPilot === true
    && approval?.confirmDefaultRuntimeFailClosed === true;
}

function approvalIsValid(approval) {
  return approval?.pilotApproved === true
    && String(approval?.approvedBy || "").trim() !== ""
    && String(approval?.approvedAt || "").trim() !== ""
    && approval?.scopeContract === REQUIRED_SCOPE_CONTRACT
    && approvalTracksAreValid(approval)
    && approvalConfirmationsAreValid(approval);
}

function approvalIsExplicitNoGo(approval) {
  return approval?.pilotApproved === false
    && String(approval?.approvedBy || "").trim() !== ""
    && String(approval?.approvedAt || "").trim() !== "";
}

function releaseReviewMatchesLiveEvidence(releaseReview, liveEvidenceBinding) {
  const ordinary = liveEvidenceBinding?.evidence?.ordinary || {};
  const m3plus = liveEvidenceBinding?.evidence?.m3plus || {};
  return releaseReview?.liveEvidenceBinding?.contract === CONTROLLED_PILOT_LIVE_EVIDENCE_CONTRACT
    && releaseReview?.liveEvidenceBinding?.sha256 === liveEvidenceBinding?.sha256
    && releaseReview?.tracks?.ordinary?.foundationReady === ordinary.foundationReady
    && releaseReview?.tracks?.ordinary?.liveArtifactVerifierReady === ordinary.liveArtifactVerifierReady
    && releaseReview?.tracks?.ordinary?.r3AcceptanceReady === ordinary.r3AcceptanceReady
    && releaseReview?.tracks?.ordinary?.authorizationReady === ordinary.authorizationReady
    && releaseReview?.tracks?.ordinary?.energyVetoIncluded === ordinary.energyVetoIncluded
    && releaseReview?.tracks?.m3plus?.offlineEvidenceReady === m3plus.offlineEvidenceReady
    && releaseReview?.tracks?.m3plus?.reviewOnlyRuntimeWired === m3plus.reviewOnlyRuntimeWired
    && releaseReview?.tracks?.m3plus?.runtimeFoundationReady === m3plus.runtimeFoundationReady
    && releaseReview?.tracks?.m3plus?.runtimeAuditReady === m3plus.runtimeAuditReady
    && releaseReview?.tracks?.m3plus?.physicalEvidenceCurrent === m3plus.physicalEvidenceCurrent
    && releaseReview?.tracks?.m3plus?.authorizationReady === m3plus.authorizationReady
    && releaseReview?.tracks?.m3plus?.pitchSafetyReady === m3plus.pitchSafetyReady
    && releaseReview?.tracks?.m3plus?.contract === m3plus.evaluationContract
    && releaseReview?.tracks?.m3plus?.runtimeContract === m3plus.runtimeContract;
}

function releaseReviewIsReady(releaseReview, liveEvidenceBinding) {
  return releaseReview?.schemaVersion === 2
    && releaseReview?.ok === true
    && releaseReview?.ordinaryAuthorizationContract === REQUIRED_ORDINARY_AUTHORIZATION_CONTRACT
    && releaseReview?.commandChecksPassed === true
    && releaseReview?.requiredEvidenceComplete === true
    && releaseReview?.machineChecksComplete === true
    && releaseReview?.readyForControlledPilot === true
    && releaseReview?.teacherReviewNeeded === false
    && releaseReview?.runtimeFailClosed === true
    && releaseReview?.tracks?.ordinary?.readyForControlledPilot === true
    && releaseReview?.tracks?.m3plus?.readyForControlledPilot === true
    && controlledPilotLiveEvidenceReady(liveEvidenceBinding)
    && releaseReviewMatchesLiveEvidence(releaseReview, liveEvidenceBinding);
}

function buildBlockingReasons({ status, releaseReview, approval, liveEvidenceBinding }) {
  const reasons = [];
  if (!releaseReview) reasons.push("release-review-missing");
  else {
    if (releaseReview.ok !== true) reasons.push("release-review-not-ok");
    if (releaseReview.schemaVersion !== 2
        || releaseReview.ordinaryAuthorizationContract !== REQUIRED_ORDINARY_AUTHORIZATION_CONTRACT) {
      reasons.push("release-review-ordinary-authorization-contract-superseded");
    }
    if (releaseReview.tracks?.ordinary?.readyForControlledPilot !== true) {
      reasons.push("release-review-ordinary-track-not-ready-for-controlled-pilot");
    }
    if (releaseReview.tracks?.ordinary?.authorizationReady !== true) {
      reasons.push("ordinary-dynamic-shadow-authorization-closed");
    }
    if (releaseReview.commandChecksPassed !== true) reasons.push("release-review-command-checks-not-passed");
    if (releaseReview.requiredEvidenceComplete !== true) reasons.push("release-review-required-evidence-incomplete");
    if (releaseReview.machineChecksComplete !== true) reasons.push("release-review-machine-checks-incomplete");
    if (releaseReview.tracks?.m3plus?.authorizationReady !== true) {
      reasons.push("m3plus-authorization-closed");
    }
    if (releaseReview.tracks?.m3plus?.readyForControlledPilot !== true) {
      reasons.push("release-review-m3plus-track-not-ready-for-controlled-pilot");
    }
    if (!releaseReviewMatchesLiveEvidence(releaseReview, liveEvidenceBinding)) {
      reasons.push("release-review-live-evidence-binding-missing-or-stale");
    }
    if (releaseReview.readyForControlledPilot !== true) reasons.push("release-review-not-ready-for-controlled-pilot");
    if (releaseReview.teacherReviewNeeded !== false) reasons.push("release-review-still-needs-teacher-review");
    if (releaseReview.runtimeFailClosed !== true) reasons.push("runtime-not-fail-closed-during-review");
  }
  const live = liveEvidenceBinding?.evidence || {};
  const ordinary = live.ordinary || {};
  const m3plus = live.m3plus || {};
  if (!controlledPilotLiveEvidenceReady(liveEvidenceBinding)) {
    reasons.push("live-controlled-pilot-evidence-incomplete");
  }
  if (ordinary.foundationReady !== true) reasons.push("live-ordinary-foundation-not-ready");
  if (ordinary.liveArtifactVerifierReady !== true) reasons.push("live-ordinary-artifact-verifier-not-ready");
  if (ordinary.r3AcceptanceReady !== true) reasons.push("live-ordinary-r3-acceptance-not-ready");
  if (ordinary.authorizationReady !== true) reasons.push("live-ordinary-authorization-closed");
  if (ordinary.energyVetoIncluded !== true) reasons.push("live-ordinary-energy-veto-not-included");
  if (m3plus.offlineEvidenceReady !== true) reasons.push("live-m3plus-offline-evidence-not-ready");
  if (m3plus.reviewOnlyRuntimeWired !== true
      || m3plus.runtimeFoundationReady !== true
      || m3plus.runtimeAuditReady !== true) {
    reasons.push("live-m3plus-runtime-audit-not-ready");
  }
  if (m3plus.authorizationReady !== true) reasons.push("live-m3plus-authorization-closed");
  if (m3plus.pitchSafetyReady !== true
      || m3plus.auditSchemaVersion !== 2
      || m3plus.evaluationContract !== REQUIRED_M3PLUS_EVALUATION_CONTRACT
      || m3plus.runtimeContract !== REQUIRED_M3PLUS_RUNTIME_CONTRACT
      || m3plus.readyForMonitoredPilot !== true
      || (m3plus.blockingReasons || []).length !== 0) {
    reasons.push("live-m3plus-pitch-safety-not-ready");
  }
  if (status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady !== false) reasons.push("ordinary-default-runtime-enabled");
  if (status.runtimeStudentGate?.m3plusAutoFeedbackReady !== false) reasons.push("m3plus-default-runtime-enabled");
  if (status.runtimeStudentGate?.m4OmrAutoScoreReady !== false) reasons.push("m4-default-runtime-enabled");
  if (approvalIsExplicitNoGo(approval)) reasons.push("controlled-pilot-explicitly-deferred");
  else if (!approvalIsValid(approval)) {
    if (approval?.pilotApproved === true && approval?.scopeContract !== REQUIRED_SCOPE_CONTRACT) {
      reasons.push("controlled-pilot-approval-scope-contract-superseded");
    } else if (approval?.pilotApproved === true && !approvalTracksAreValid(approval)) {
      reasons.push("controlled-pilot-approval-tracks-mismatch");
    } else if (approval?.pilotApproved === true && !approvalConfirmationsAreValid(approval)) {
      reasons.push("controlled-pilot-approval-safety-confirmations-missing");
    } else {
      reasons.push("controlled-pilot-approval-missing");
    }
  }
  return reasons;
}

function renderMarkdown(decision) {
  return [
    "# Western Strings Controlled Pilot Decision",
    "",
    `Generated: ${decision.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- readyForControlledPilotDecision: ${decision.readyForControlledPilotDecision}`,
    `- readyToStartControlledPilot: ${decision.readyToStartControlledPilot}`,
    `- approvalRequired: ${decision.approvalRequired}`,
    `- approvalPresent: ${decision.approvalPresent}`,
    `- runtimeFailClosed: ${decision.runtimeFailClosed}`,
    `- liveEvidenceContract: ${decision.liveEvidenceBinding.contract}`,
    `- liveEvidenceSha256: ${decision.liveEvidenceBinding.sha256}`,
    "",
    "## Allowed Pilot Scope",
    "",
    ...decision.allowedScope.map((item) => `- ${item}`),
    "",
    "## Explicitly Not Allowed",
    "",
    ...decision.notAllowed.map((item) => `- ${item}`),
    "",
    "## Start Conditions",
    "",
    ...decision.startConditions.map((item) => `- ${item}`),
    "",
    "## Approved Start Command",
    "",
    "Run a read-only status check first:",
    "",
    "```bash",
    "npm run western:controlled-pilot-run",
    "```",
    "",
    "Only after owner approval and a green preflight, run one offline controlled batch:",
    "",
    "```bash",
    "npm run western:controlled-pilot-run -- --execute --limit 1",
    "```",
    "",
    "This command exits after the batch, restores its process environment, and never starts a public student server.",
    "",
    "## Abort Criteria",
    "",
    ...decision.abortCriteria.map((item) => `- ${item}`),
    "",
    "## Blocking Reasons",
    "",
    bulletList(decision.blockingReasons),
    "",
    "## Approval File",
    "",
    `- expectedPath: ${decision.artifacts.approval}`,
    `- templatePath: ${decision.artifacts.approvalTemplate}`,
    "",
    "Generate a non-approving template with:",
    "",
    "```bash",
    "npm run western:controlled-pilot-approval-template",
    "```",
    "",
    "To record an explicit safe hold without editing JSON by hand:",
    "",
    "```bash",
    "npm run western:controlled-pilot-record-decision -- --decision defer --by owner-name",
    "```",
    "",
    "Only if the owner explicitly approves the monitored pilot, record approval with both safety confirmations:",
    "",
    "```bash",
    "npm run western:controlled-pilot-record-decision -- --decision approve --by owner-name --tracks ordinary,m3plus --confirm-separate-monitored-pilot --confirm-default-runtime-fail-closed",
    "```",
    "",
    "Equivalent approval file content:",
    "",
    "```json",
    JSON.stringify({
      pilotApproved: true,
      approvedBy: "owner-name",
      approvedAt: "2026-07-17T00:00:00+08:00",
      approvedTracks: REQUIRED_APPROVED_TRACKS,
      confirmSeparateMonitoredPilot: true,
      confirmDefaultRuntimeFailClosed: true,
      scope: "ordinary dynamic-shadow plus M3+ four-zone pitch-safety; both tracks use separately audited executors and remain isolated from the default runtime",
      scopeContract: REQUIRED_SCOPE_CONTRACT,
      notes: "Default runtime remains fail-closed.",
    }, null, 2),
    "```",
    "",
    "## Artifacts",
    "",
    `- decisionJson: ${decision.artifacts.out}`,
    `- decisionMd: ${decision.artifacts.summary}`,
    `- releaseReview: ${decision.artifacts.releaseReview}`,
    `- projectStatus: ${decision.artifacts.projectStatus}`,
    "",
  ].join("\n");
}

export async function buildControlledPilotDecision(args = {}) {
  const status = args.projectStatus || await buildProjectStatus();
  const liveEvidenceBinding = buildControlledPilotLiveEvidenceBinding(status);
  const releaseReviewPath = args.releaseReview || DEFAULT_RELEASE_REVIEW;
  const approvalPath = args.approval || DEFAULT_APPROVAL;
  const releaseReview = await readJsonOrNull(releaseReviewPath);
  const approval = await readJsonOrNull(approvalPath);
  const blockingReasons = buildBlockingReasons({ status, releaseReview, approval, liveEvidenceBinding });
  const approvalPresent = approvalIsValid(approval);
  const approvalDeferred = approvalIsExplicitNoGo(approval);
  const releaseReady = releaseReviewIsReady(releaseReview, liveEvidenceBinding);
  const runtimeFailClosed = liveEvidenceBinding.evidence.runtimeFailClosed === true;
  const decision = {
    schemaVersion: 2,
    ordinaryAuthorizationContract: REQUIRED_ORDINARY_AUTHORIZATION_CONTRACT,
    ok: true,
    generatedAt: new Date().toISOString(),
    readyForControlledPilotDecision: releaseReady && runtimeFailClosed,
    readyToStartControlledPilot: releaseReady
      && runtimeFailClosed
      && approvalPresent
      && blockingReasons.length === 0,
    approvalRequired: true,
    approvalPresent,
    approvalDeferred,
    approvedTracks: approvalPresent ? normalizedApprovedTracks(approval) : [],
    runtimeFailClosed,
    liveEvidenceBinding,
    allowedScope: [
      "ordinary dynamic-shadow candidates only when the versioned release report explicitly records authorizationReady=true; otherwise review-only",
      "M3+ four-zone pitch-safety scope (rescope contract: straight-tone/center-pitch decisions with score-marked and unstable regions neutralized) only if explicitly included in the pilot",
      "M4 OMR remains eval-only and may be reported as benchmark evidence, not runtime score ingestion",
      "all rejected, unsupported, or low-confidence rows remain review_required",
    ],
    scopeContract: REQUIRED_SCOPE_CONTRACT,
    notAllowed: [
      "do not enable default production/student runtime",
      "do not commit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1",
      "do not revive audio technique-mode detection (slide/trill/ornament/variable-f0 classifiers stay research-only) and do not accuse inside score-marked or unstable zones",
      "do not display technique names as a product feature",
      "do not let OMR output enter runtime diagnosis",
      "do not request teacher review unless a machine precheck reports unknown auto-pass rows",
    ],
    startConditions: [
      "release review schemaVersion=2 and ordinaryAuthorizationContract remains current",
      "ordinary dynamic-shadow authorizationReady remains true",
      "default runtime remains fail-closed",
      "approval file exists and records owner approval",
      "approval explicitly binds both ordinary and m3plus tracks",
      "pilot process sets any release flag only in that process",
      "monitoring captures auto_pass, review_required, rejected, and unsafe false-positive counts",
    ],
    abortCriteria: [
      "any known-wrong auto_pass candidate",
      "any unknown auto-pass row without targeted review",
      "any score-audio mismatch entering auto_pass",
      "any default runtime flag enabled outside the pilot process",
      "any failure of npm run test:western-project-gate or npm run build after pilot wiring changes",
    ],
    blockingReasons,
    releaseReview: {
      source: rel(releaseReviewPath),
      readyForControlledPilot: releaseReview?.readyForControlledPilot === true,
      readyForDefaultStudentRelease: releaseReview?.readyForDefaultStudentRelease === true,
      teacherReviewNeeded: releaseReview?.teacherReviewNeeded === true,
      runtimeFailClosed: releaseReview?.runtimeFailClosed === true,
    },
    approval: approvalPresent || approvalDeferred ? approval : null,
    artifacts: {
      out: rel(args.out || DEFAULT_OUT),
      summary: rel(args.summary || DEFAULT_SUMMARY),
      approval: rel(approvalPath),
      approvalTemplate: rel(DEFAULT_APPROVAL_TEMPLATE),
      releaseReview: rel(releaseReviewPath),
      projectStatus: "data/experiments/western-strings-project-status.json",
    },
  };
  return decision;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const decision = await buildControlledPilotDecision(args);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  await fs.writeFile(args.summary, renderMarkdown(decision), "utf8");
  console.log(JSON.stringify({
    ok: decision.ok,
    readyForControlledPilotDecision: decision.readyForControlledPilotDecision,
    readyToStartControlledPilot: decision.readyToStartControlledPilot,
    approvalRequired: decision.approvalRequired,
    approvalPresent: decision.approvalPresent,
    blockingReasons: decision.blockingReasons,
    summary: rel(args.summary),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
