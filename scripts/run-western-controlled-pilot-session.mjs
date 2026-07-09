import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { buildControlledPilotStartPreflight } from "./run-western-controlled-pilot-start-preflight.mjs";
import { runOrdinaryMonitoredPilotReviewPack } from "./run-western-ordinary-monitored-pilot-review-pack.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const ENABLE_ENV = "WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE";
const DEFAULT_OUT_ROOT = path.join("data", "experiments", "western-strings-controlled-pilot-sessions");

function parseArgs(argv) {
  const args = {
    execute: false,
    limit: 1,
    outRoot: DEFAULT_OUT_ROOT,
    excludeRecordingIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--limit") args.limit = Number(argv[++index] || args.limit);
    else if (arg === "--out-root") args.outRoot = argv[++index] || args.outRoot;
    else if (arg === "--session-id") args.sessionId = argv[++index] || args.sessionId;
    else if (arg === "--approval") args.approval = argv[++index] || args.approval;
    else if (arg === "--release-review") args.releaseReview = argv[++index] || args.releaseReview;
    else if (arg === "--exclude-recording-id") args.excludeRecordingIds.push(argv[++index] || "");
  }
  return args;
}

function rel(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function envEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function createSessionId(date = new Date()) {
  return `pilot-${date.toISOString().replace(/[:.]/g, "-")}`;
}

function runNpmScript(script) {
  const command = process.env.npm_execpath
    ? process.execPath
    : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, "run", script, "--silent"]
    : ["run", script, "--silent"];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    timeout: 300000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error ? String(result.error.message || result.error) : "",
    stdoutTail: String(result.stdout || "").trim().split(/\r?\n/).slice(-12).join("\n"),
    stderrTail: String(result.stderr || "").trim().split(/\r?\n/).slice(-12).join("\n"),
  };
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadHistoricalRecordingIds(outRoot = DEFAULT_OUT_ROOT) {
  const absoluteRoot = path.resolve(outRoot);
  let entries = [];
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const recordingIds = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const session = await readJsonOrNull(path.join(absoluteRoot, entry.name, "session.json"));
    if (session?.executionPerformed !== true) continue;
    for (const recordingId of Array.isArray(session.additionalExcludedRecordingIds)
      ? session.additionalExcludedRecordingIds
      : []) {
      const normalized = String(recordingId || "").trim();
      if (normalized) recordingIds.add(normalized);
    }
    let selectedSubmissions = Array.isArray(session.selectedSubmissions) ? session.selectedSubmissions : [];
    if (!selectedSubmissions.length && session.artifacts?.precisionSummary) {
      const precisionPath = path.isAbsolute(session.artifacts.precisionSummary)
        ? session.artifacts.precisionSummary
        : path.resolve(process.cwd(), session.artifacts.precisionSummary);
      const precision = await readJsonOrNull(precisionPath);
      selectedSubmissions = Array.isArray(precision?.selectedSubmissions) ? precision.selectedSubmissions : [];
    }
    for (const submission of selectedSubmissions) {
      const recordingId = String(submission?.recordingId || "").trim();
      if (recordingId) recordingIds.add(recordingId);
    }
  }
  return [...recordingIds].sort();
}

function renderMarkdown(report) {
  return [
    "# Western Strings Controlled Pilot Session",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- sessionStatus: ${report.sessionStatus}`,
    `- executionRequested: ${report.executionRequested}`,
    `- executionPerformed: ${report.executionPerformed}`,
    `- pilotRunAccepted: ${report.pilotRunAccepted}`,
    `- approvedBy: ${report.approvedBy || ""}`,
    `- historicalRecordingIdsExcluded: ${report.historyExcludedRecordingIds.join(", ") || "none"}`,
    `- additionalRecordingIdsExcluded: ${report.additionalExcludedRecordingIds.join(", ") || "none"}`,
    `- defaultRuntimeFailClosedAfter: ${report.defaultRuntimeFailClosedAfter}`,
    `- processEnvironmentRestored: ${report.processEnvironmentRestored}`,
    "",
    "## Monitoring",
    "",
    `- selectedSubmissionCount: ${report.monitoring.selectedSubmissionCount}`,
    `- totalCandidateCount: ${report.monitoring.totalCandidateCount}`,
    `- autoPassCandidateCount: ${report.monitoring.autoPassCandidateCount}`,
    `- reviewRequiredCandidateCount: ${report.monitoring.reviewRequiredCandidateCount}`,
    `- knownUsableAutoPassCandidateCount: ${report.monitoring.knownUsableAutoPassCandidateCount}`,
    `- knownWrongAutoPassCandidateCount: ${report.monitoring.knownWrongAutoPassCandidateCount}`,
    `- unknownAutoPassCandidateCount: ${report.monitoring.unknownAutoPassCandidateCount}`,
    `- selectedRecordingIds: ${report.selectedSubmissions.map((item) => item.recordingId).filter(Boolean).join(", ") || "none"}`,
    "",
    "## Safety Meaning",
    "",
    "- This is a one-shot offline controlled batch, not a public student server.",
    "- The runtime flag exists only inside this command and is restored before exit.",
    "- Unknown auto-pass rows pause the session for targeted review.",
    "- Known-wrong auto-pass rows abort the session.",
    "- No M4 OMR output enters runtime diagnosis.",
    "",
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "## Artifacts",
    "",
    `- sessionJson: ${report.artifacts.sessionJson}`,
    `- sessionMd: ${report.artifacts.sessionMd}`,
    `- selectionJson: ${report.artifacts.selectionJson || ""}`,
    `- targetedReviewPage: ${report.artifacts.targetedReviewPage || ""}`,
    "",
  ].join("\n");
}

function emptyMonitoring() {
  return {
    selectedSubmissionCount: 0,
    totalCandidateCount: 0,
    autoPassCandidateCount: 0,
    reviewRequiredCandidateCount: 0,
    knownUsableAutoPassCandidateCount: 0,
    knownWrongAutoPassCandidateCount: 0,
    unknownAutoPassCandidateCount: 0,
  };
}

export async function runControlledPilotSession(args = {}, dependencies = {}) {
  const execute = args.execute === true;
  const limit = Math.max(1, Math.min(20, Math.round(Number(args.limit) || 1)));
  const sessionId = args.sessionId || createSessionId(dependencies.now?.() || new Date());
  const sessionDir = path.resolve(args.outRoot || DEFAULT_OUT_ROOT, sessionId);
  const sessionJson = path.join(sessionDir, "session.json");
  const sessionMd = path.join(sessionDir, "session.md");
  const selectionJson = path.join(sessionDir, "candidate-selection.json");
  const precisionSummary = path.join(sessionDir, "precision-summary.json");
  const reviewDir = path.join(sessionDir, "targeted-review");
  const buildPreflight = dependencies.buildPreflight || buildControlledPilotStartPreflight;
  const runPrecisionSession = dependencies.runPrecisionSession || runOrdinaryMonitoredPilotReviewPack;
  const buildStatus = dependencies.buildStatus || buildProjectStatus;
  const refreshReleaseReview = dependencies.refreshReleaseReview || (() => runNpmScript("western:release-review"));
  const loadHistory = dependencies.loadHistoricalRecordingIds || loadHistoricalRecordingIds;
  const additionalExcludedRecordingIds = [...new Set(
    (Array.isArray(args.excludeRecordingIds) ? args.excludeRecordingIds : [])
      .map((recordingId) => String(recordingId || "").trim())
      .filter(Boolean),
  )];
  const oldEnable = process.env[ENABLE_ENV];
  const parentEnvEnabled = envEnabled(oldEnable);
  const blockingReasons = [];
  let executionPerformed = false;
  let precision = null;
  let runtimeStatusAfter = null;
  let caughtError = "";
  const historyExcludedRecordingIds = await loadHistory(args.outRoot || DEFAULT_OUT_ROOT);
  const effectiveExcludedRecordingIds = [...new Set([
    ...historyExcludedRecordingIds,
    ...additionalExcludedRecordingIds,
  ])].sort();

  if (execute && parentEnvEnabled) {
    blockingReasons.push("pilot-run-parent-env-enabled");
  }
  let refresh = { ok: true, skipped: true };
  if (execute && blockingReasons.length === 0) {
    refresh = await refreshReleaseReview();
    if (refresh?.ok !== true) blockingReasons.push("release-review-refresh-failed");
  }
  const preflight = await buildPreflight({
    approval: args.approval,
    releaseReview: args.releaseReview,
  });
  if (preflight.okToStartControlledPilot !== true) {
    blockingReasons.push(...(preflight.blockingReasons || []));
  }

  try {
    if (execute && blockingReasons.length === 0) {
      executionPerformed = true;
      precision = await runPrecisionSession({
        batchLimit: limit,
        outDir: reviewDir,
        selectionJson,
        summary: precisionSummary,
        excludeRecordingIds: effectiveExcludedRecordingIds,
      });
    }
  } catch (error) {
    caughtError = String(error?.message || error);
    blockingReasons.push("controlled-pilot-session-failed");
  } finally {
    if (oldEnable === undefined) delete process.env[ENABLE_ENV];
    else process.env[ENABLE_ENV] = oldEnable;
    runtimeStatusAfter = await buildStatus();
  }

  const summary = precision?.summary || {};
  const selectedSubmissions = Array.isArray(summary.selectedSubmissions) ? summary.selectedSubmissions : [];
  const repeatedRecordingIds = selectedSubmissions
    .map((submission) => String(submission?.recordingId || "").trim())
    .filter((recordingId) => recordingId && effectiveExcludedRecordingIds.includes(recordingId));
  const knownWrong = Number(summary.knownWrongAutoPassCandidateCount || 0);
  const unknown = Number(summary.unknownReviewCandidateCount || 0);
  if (summary.ok === false) blockingReasons.push(...(summary.blockingReasons || []).map((reason) => `pilot:${reason}`));
  if (knownWrong > 0) blockingReasons.push(`pilot-known-wrong-auto-pass:${knownWrong}`);
  if (unknown > 0) blockingReasons.push(`pilot-unknown-auto-pass-needs-targeted-review:${unknown}`);
  if (repeatedRecordingIds.length > 0) {
    blockingReasons.push(`pilot-reused-recording:${[...new Set(repeatedRecordingIds)].join(",")}`);
  }
  const processEnvironmentRestored = process.env[ENABLE_ENV] === oldEnable;
  if (!processEnvironmentRestored) blockingReasons.push("pilot-run-process-environment-not-restored");
  const defaultRuntimeFailClosedAfter = runtimeStatusAfter?.runtimeStudentGate?.policy === "fail-closed"
    && runtimeStatusAfter?.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === false
    && runtimeStatusAfter?.runtimeStudentGate?.m3plusAutoFeedbackReady === false
    && runtimeStatusAfter?.runtimeStudentGate?.m4OmrAutoScoreReady === false;
  if (!defaultRuntimeFailClosedAfter) blockingReasons.push("pilot-run-default-runtime-not-fail-closed-after");
  const uniqueBlockingReasons = [...new Set(blockingReasons.filter(Boolean))];

  let sessionStatus = "ready_not_executed";
  if (execute && !executionPerformed) sessionStatus = "blocked";
  else if (execute && caughtError) sessionStatus = "failed";
  else if (execute && knownWrong > 0) sessionStatus = "aborted_known_wrong";
  else if (execute && unknown > 0) sessionStatus = "paused_targeted_review";
  else if (execute && uniqueBlockingReasons.length > 0) sessionStatus = "aborted";
  else if (execute) sessionStatus = "completed_safe";
  else if (preflight.okToStartControlledPilot !== true) sessionStatus = "blocked";

  const monitoring = executionPerformed ? {
    selectedSubmissionCount: Number(summary.selectedSubmissionCount || 0),
    totalCandidateCount: Number(summary.totalCandidateCount || 0),
    autoPassCandidateCount: Number(summary.autoPassCandidateCount || 0),
    reviewRequiredCandidateCount: Math.max(0, Number(summary.totalCandidateCount || 0) - Number(summary.autoPassCandidateCount || 0)),
    knownUsableAutoPassCandidateCount: Number(summary.knownUsableAutoPassCandidateCount || 0),
    knownWrongAutoPassCandidateCount: knownWrong,
    unknownAutoPassCandidateCount: unknown,
  } : emptyMonitoring();
  const pilotRunAccepted = sessionStatus === "completed_safe";
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sessionId,
    sessionStatus,
    executionRequested: execute,
    executionPerformed,
    pilotRunAccepted,
    approvedBy: preflight.decision?.approval?.approvedBy || "",
    approvalPresent: preflight.decision?.approvalPresent === true,
    historyExcludedRecordingIds,
    additionalExcludedRecordingIds,
    effectiveExcludedRecordingIds,
    selectedSubmissions,
    refreshedReleaseReview: refresh,
    preflight: {
      okToStartControlledPilot: preflight.okToStartControlledPilot === true,
      blockingReasons: preflight.blockingReasons || [],
    },
    monitoring,
    defaultRuntimeFailClosedAfter,
    processEnvironmentRestored,
    runtimeEffect: "none-outside-this-process",
    studentFeedbackPublished: false,
    error: caughtError,
    blockingReasons: uniqueBlockingReasons,
    nextAction: sessionStatus === "paused_targeted_review"
      ? "Review only the generated unknown auto-pass rows, then rerun the session."
      : sessionStatus === "completed_safe"
        ? "Record the monitored result; keep default runtime fail-closed."
        : "Resolve the blocking reasons before any pilot execution.",
    artifacts: {
      sessionJson: rel(sessionJson),
      sessionMd: rel(sessionMd),
      selectionJson: executionPerformed ? rel(selectionJson) : "",
      precisionSummary: executionPerformed ? rel(precisionSummary) : "",
      targetedReviewPage: summary.reviewPack?.htmlPath || "",
    },
  };
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(sessionMd, renderMarkdown(report), "utf8");
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runControlledPilotSession(args);
  console.log(JSON.stringify({
    ok: report.ok,
    sessionStatus: report.sessionStatus,
    executionRequested: report.executionRequested,
    executionPerformed: report.executionPerformed,
    pilotRunAccepted: report.pilotRunAccepted,
    defaultRuntimeFailClosedAfter: report.defaultRuntimeFailClosedAfter,
    blockingReasons: report.blockingReasons,
    monitoring: report.monitoring,
    historyExcludedRecordingIds: report.historyExcludedRecordingIds,
    additionalExcludedRecordingIds: report.additionalExcludedRecordingIds,
    effectiveExcludedRecordingIds: report.effectiveExcludedRecordingIds,
    selectedSubmissions: report.selectedSubmissions,
    out: report.artifacts,
  }, null, 2));
  if (report.executionRequested && !report.pilotRunAccepted) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
