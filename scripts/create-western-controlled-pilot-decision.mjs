import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildProjectStatus } from "./status-western-strings-project.mjs";

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

function approvalIsValid(approval) {
  return approval?.pilotApproved === true
    && String(approval?.approvedBy || "").trim() !== ""
    && String(approval?.approvedAt || "").trim() !== "";
}

function buildBlockingReasons({ status, releaseReview, approval }) {
  const reasons = [];
  if (!releaseReview) reasons.push("release-review-missing");
  else {
    if (releaseReview.readyForControlledPilot !== true) reasons.push("release-review-not-ready-for-controlled-pilot");
    if (releaseReview.teacherReviewNeeded === true) reasons.push("release-review-still-needs-teacher-review");
    if (releaseReview.runtimeFailClosed !== true) reasons.push("runtime-not-fail-closed-during-review");
  }
  if (status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady !== false) reasons.push("ordinary-default-runtime-enabled");
  if (status.runtimeStudentGate?.m3plusAutoFeedbackReady !== false) reasons.push("m3plus-default-runtime-enabled");
  if (status.runtimeStudentGate?.m4OmrAutoScoreReady !== false) reasons.push("m4-default-runtime-enabled");
  if (!approvalIsValid(approval)) reasons.push("controlled-pilot-approval-missing");
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
    "Only if the owner explicitly approves the monitored pilot, copy/fill the template as the expected approval file. Example approval file:",
    "",
    "```json",
    JSON.stringify({
      pilotApproved: true,
      approvedBy: "owner-name",
      approvedAt: "2026-07-10T00:00:00+08:00",
      scope: "ordinary candidate-evidence auto_pass only; optional first-measure slide/trill M3+ subset",
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
  const status = await buildProjectStatus();
  const releaseReviewPath = args.releaseReview || DEFAULT_RELEASE_REVIEW;
  const approvalPath = args.approval || DEFAULT_APPROVAL;
  const releaseReview = await readJsonOrNull(releaseReviewPath);
  const approval = await readJsonOrNull(approvalPath);
  const blockingReasons = buildBlockingReasons({ status, releaseReview, approval });
  const approvalPresent = approvalIsValid(approval);
  const releaseReady = releaseReview?.readyForControlledPilot === true
    && releaseReview.teacherReviewNeeded !== true
    && releaseReview.runtimeFailClosed === true;
  const runtimeFailClosed = status.runtimeStudentGate?.policy === "fail-closed"
    && status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === false
    && status.runtimeStudentGate?.m3plusAutoFeedbackReady === false
    && status.runtimeStudentGate?.m4OmrAutoScoreReady === false;
  const decision = {
    ok: true,
    generatedAt: new Date().toISOString(),
    readyForControlledPilotDecision: releaseReady && runtimeFailClosed,
    readyToStartControlledPilot: blockingReasons.length === 0,
    approvalRequired: true,
    approvalPresent,
    runtimeFailClosed,
    allowedScope: [
      "ordinary upload candidate-evidence auto_pass only inside a separate monitored pilot process",
      "M3+ first-measure, trusted-recording, slide-like/trill-like pitch-judgement subset only if explicitly included in the pilot",
      "M4 OMR remains eval-only and may be reported as benchmark evidence, not runtime score ingestion",
      "all rejected, unsupported, or low-confidence rows remain review_required",
    ],
    notAllowed: [
      "do not enable default production/student runtime",
      "do not commit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1",
      "do not broaden M3+ to later measures, non-trusted recordings, variable-f0, double-stop, or ornament modes",
      "do not display technique names as a product feature",
      "do not let OMR output enter runtime diagnosis",
      "do not request teacher review unless a machine precheck reports unknown auto-pass rows",
    ],
    startConditions: [
      "release review remains readyForControlledPilot=true",
      "default runtime remains fail-closed",
      "approval file exists and records owner approval",
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
    approval: approvalPresent ? approval : null,
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
