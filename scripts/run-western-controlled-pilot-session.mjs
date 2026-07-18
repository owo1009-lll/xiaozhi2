import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT,
  REQUIRED_PILOT_EXECUTOR_CONTRACT,
  buildControlledPilotStartPreflight,
} from "./run-western-controlled-pilot-start-preflight.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const ENABLE_ENV = "WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE";
const DEFAULT_OUT_ROOT = path.join("data", "experiments", "western-strings-controlled-pilot-sessions");

function parseArgs(argv) {
  const args = {
    execute: false,
    limit: 1,
    outRoot: DEFAULT_OUT_ROOT,
    includeRecordingIds: [],
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
    else if (arg === "--recording-id") args.includeRecordingIds.push(argv[++index] || "");
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

export async function loadHistoricalRecordingIds(outRoot = DEFAULT_OUT_ROOT) {
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
    if (session.evidenceInvalidated === true) continue;
    let selectedSubmissions = Array.isArray(session.selectedSubmissions) ? session.selectedSubmissions : [];
    let precision = null;
    if (session.artifacts?.precisionSummary) {
      const precisionPath = path.isAbsolute(session.artifacts.precisionSummary)
        ? session.artifacts.precisionSummary
        : path.resolve(process.cwd(), session.artifacts.precisionSummary);
      precision = await readJsonOrNull(precisionPath);
      if (!selectedSubmissions.length) {
        selectedSubmissions = Array.isArray(precision?.selectedSubmissions) ? precision.selectedSubmissions : [];
      }
    }
    const evidenceCandidateCount = Number(
      session.monitoring?.totalCandidateCount
      ?? precision?.totalCandidateCount
      ?? 0,
    );
    if (!(evidenceCandidateCount > 0)) continue;
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
    `- ordinaryExecutionPassed: ${report.executors.ordinary.executionPassed}`,
    `- m3plusExecutionPassed: ${report.executors.m3plus.executionPassed}`,
    `- pilotRunAccepted: ${report.pilotRunAccepted}`,
    `- approvedBy: ${report.approvedBy || ""}`,
    `- requestedRecordingIds: ${report.requestedRecordingIds.join(", ") || "any eligible recording"}`,
    `- historicalRecordingIdsExcluded: ${report.historyExcludedRecordingIds.join(", ") || "none"}`,
    `- additionalRecordingIdsExcluded: ${report.additionalExcludedRecordingIds.join(", ") || "none"}`,
    `- defaultRuntimeFailClosedAfter: ${report.defaultRuntimeFailClosedAfter}`,
    `- processEnvironmentRestored: ${report.processEnvironmentRestored}`,
    "",
    "## Monitoring",
    "",
    `- selectedSubmissionCount: ${report.monitoring.selectedSubmissionCount}`,
    `- totalCandidateCount: ${report.monitoring.totalCandidateCount}`,
    `- modelAutoPassCandidateCount: ${report.monitoring.modelAutoPassCandidateCount}`,
    `- scopedAutoPassCandidateCount: ${report.monitoring.scopedAutoPassCandidateCount}`,
    `- pilotEligibleAutoPassCandidateCount: ${report.monitoring.pilotEligibleAutoPassCandidateCount}`,
    `- suppressedModelAutoPassCandidateCount: ${report.monitoring.suppressedModelAutoPassCandidateCount}`,
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
    "- Model auto-pass rows that do not pass the stricter pilot self-check are suppressed as review_required.",
    "- Only pilotEligibleAutoPassCandidateCount is allowed to count toward controlled-pilot coverage.",
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
    modelAutoPassCandidateCount: 0,
    scopedAutoPassCandidateCount: 0,
    selfCheckedAutoPassCandidateCount: 0,
    pilotEligibleAutoPassCandidateCount: 0,
    suppressedModelAutoPassCandidateCount: 0,
    rawModelReviewRequiredCandidateCount: 0,
    reviewRequiredCandidateCount: 0,
    knownUsableAutoPassCandidateCount: 0,
    knownWrongAutoPassCandidateCount: 0,
    unknownAutoPassCandidateCount: 0,
  };
}

function m3plusExecutionResultReady(result) {
  return Boolean(
    result
    && result.contract === REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT
    && result.ok === true
    && result.reviewOnly === true
    && result.feedbackAuthorized === false
    && result.studentFacing === false
    && Array.isArray(result.blockers)
    && result.blockers.length === 0,
  );
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
  const runDynamicShadowPilotSession = dependencies.runDynamicShadowPilotSession
    || dependencies.runPrecisionSession
    || null;
  const runM3PlusPitchSafetyPilotSession = dependencies.runM3PlusPitchSafetyPilotSession || null;
  const buildStatus = dependencies.buildStatus || buildProjectStatus;
  const refreshReleaseReview = dependencies.refreshReleaseReview || (() => runNpmScript("western:release-review"));
  const loadHistory = dependencies.loadHistoricalRecordingIds || loadHistoricalRecordingIds;
  const requestedRecordingIds = [...new Set(
    (Array.isArray(args.includeRecordingIds) ? args.includeRecordingIds : [])
      .map((recordingId) => String(recordingId || "").trim())
      .filter(Boolean),
  )];
  const additionalExcludedRecordingIds = [...new Set(
    (Array.isArray(args.excludeRecordingIds) ? args.excludeRecordingIds : [])
      .map((recordingId) => String(recordingId || "").trim())
      .filter(Boolean),
  )];
  const oldEnable = process.env[ENABLE_ENV];
  const parentEnvEnabled = envEnabled(oldEnable);
  const blockingReasons = [];
  let executionPerformed = false;
  let ordinaryExecutionPerformed = false;
  let ordinaryExecutionPassed = false;
  let m3plusExecutionPerformed = false;
  let m3plusExecutionPassed = false;
  let precision = null;
  let m3plusResult = null;
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
    pilotExecutorContractReady: typeof runDynamicShadowPilotSession === "function"
      && runDynamicShadowPilotSession.contract === REQUIRED_PILOT_EXECUTOR_CONTRACT,
    pilotExecutorContract: typeof runDynamicShadowPilotSession === "function"
      ? String(runDynamicShadowPilotSession.contract || "")
      : "",
    m3plusPilotExecutorContractReady: typeof runM3PlusPitchSafetyPilotSession === "function"
      && runM3PlusPitchSafetyPilotSession.contract === REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT,
    m3plusPilotExecutorContract: typeof runM3PlusPitchSafetyPilotSession === "function"
      ? String(runM3PlusPitchSafetyPilotSession.contract || "")
      : "",
  });
  if (preflight.okToStartControlledPilot !== true) {
    blockingReasons.push(...(preflight.blockingReasons || []));
  }
  const ordinaryExecutorReadinessReady = preflight.ordinaryPilotExecutorReady === true
    && preflight.pilotExecutorContract === REQUIRED_PILOT_EXECUTOR_CONTRACT;
  const m3plusExecutorReadinessReady = preflight.m3plusPilotExecutorReady === true
    && preflight.m3plusPilotExecutorContract === REQUIRED_M3PLUS_PILOT_EXECUTOR_CONTRACT;
  const aggregateExecutorReadinessReady = preflight.pilotExecutorReady === true;
  if (!ordinaryExecutorReadinessReady) {
    blockingReasons.push("ordinary-pilot-executor-readiness-contract-invalid");
  }
  if (!m3plusExecutorReadinessReady) {
    blockingReasons.push("m3plus-pilot-executor-readiness-contract-invalid");
  }
  if (!aggregateExecutorReadinessReady) {
    blockingReasons.push("pilot-executor-aggregate-readiness-invalid");
  }
  if (preflight.pilotExecutorContract === preflight.m3plusPilotExecutorContract) {
    blockingReasons.push("pilot-executor-contracts-not-distinct");
  }
  if (execute && typeof runDynamicShadowPilotSession !== "function") {
    blockingReasons.push("ordinary-dynamic-shadow-pilot-executor-not-implemented");
  }
  if (execute && typeof runM3PlusPitchSafetyPilotSession !== "function") {
    blockingReasons.push("m3plus-pitch-safety-pilot-executor-not-implemented");
  }
  if (execute
      && typeof runDynamicShadowPilotSession === "function"
      && runDynamicShadowPilotSession === runM3PlusPitchSafetyPilotSession) {
    blockingReasons.push("pilot-executors-must-be-distinct-functions");
  }

  try {
    if (execute && blockingReasons.length === 0) {
      ordinaryExecutionPerformed = true;
      executionPerformed = true;
      precision = await runDynamicShadowPilotSession({
        batchLimit: limit,
        outDir: reviewDir,
        selectionJson,
        summary: precisionSummary,
        includeRecordingIds: requestedRecordingIds,
        excludeRecordingIds: effectiveExcludedRecordingIds,
      });
      ordinaryExecutionPassed = precision?.summary?.ok === true;
      if (!ordinaryExecutionPassed) blockingReasons.push("ordinary-pilot-executor-result-invalid");
      m3plusExecutionPerformed = true;
      m3plusResult = await runM3PlusPitchSafetyPilotSession({
        batchLimit: limit,
        outDir: path.join(sessionDir, "m3plus-review"),
        includeRecordingIds: requestedRecordingIds,
        excludeRecordingIds: effectiveExcludedRecordingIds,
      });
      m3plusExecutionPassed = m3plusExecutionResultReady(m3plusResult);
      if (!m3plusExecutionPassed) blockingReasons.push("m3plus-pitch-safety-pilot-result-invalid");
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
  const selectedRecordingIds = selectedSubmissions
    .map((submission) => String(submission?.recordingId || "").trim())
    .filter(Boolean);
  const unrequestedRecordingIds = requestedRecordingIds.length > 0
    ? selectedRecordingIds.filter((recordingId) => !requestedRecordingIds.includes(recordingId))
    : [];
  const missingRequestedRecordingIds = executionPerformed
    ? requestedRecordingIds.filter((recordingId) => !selectedRecordingIds.includes(recordingId))
    : [];
  const totalCandidateCount = Number(summary.totalCandidateCount || 0);
  const modelAutoPassCandidateCount = Number(
    summary.modelAutoPassCandidateCount
    ?? summary.autoPassCandidateCount
    ?? 0,
  );
  const scopedAutoPassCandidateCount = Number(summary.autoPassCandidateCount || 0);
  const selfCheckedAutoPassCandidateCount = Number(summary.selfCheckedAutoPassCandidateCount || 0);
  const knownUsable = Number(summary.knownUsableAutoPassCandidateCount || 0);
  const knownWrong = Number(summary.knownWrongAutoPassCandidateCount || 0);
  const unknown = Number(summary.unknownReviewCandidateCount || 0);
  const selfCheckAccountedCandidateCount = knownUsable + knownWrong + unknown;
  if (summary.ok === false) blockingReasons.push(...(summary.blockingReasons || []).map((reason) => `pilot:${reason}`));
  if (executionPerformed && selfCheckedAutoPassCandidateCount > modelAutoPassCandidateCount) {
    blockingReasons.push(
      `pilot-self-check-exceeds-model-auto-pass:${selfCheckedAutoPassCandidateCount}:${modelAutoPassCandidateCount}`,
    );
  }
  if (executionPerformed && selfCheckAccountedCandidateCount !== selfCheckedAutoPassCandidateCount) {
    blockingReasons.push(
      `pilot-self-check-accounting-mismatch:${selfCheckedAutoPassCandidateCount}:${selfCheckAccountedCandidateCount}`,
    );
  }
  if (knownWrong > 0) blockingReasons.push(`pilot-known-wrong-auto-pass:${knownWrong}`);
  if (unknown > 0) blockingReasons.push(`pilot-unknown-auto-pass-needs-targeted-review:${unknown}`);
  if (repeatedRecordingIds.length > 0) {
    blockingReasons.push(`pilot-reused-recording:${[...new Set(repeatedRecordingIds)].join(",")}`);
  }
  if (unrequestedRecordingIds.length > 0) {
    blockingReasons.push(`pilot-unrequested-recording-selected:${[...new Set(unrequestedRecordingIds)].join(",")}`);
  }
  if (missingRequestedRecordingIds.length > 0) {
    blockingReasons.push(`pilot-requested-recording-not-selected:${missingRequestedRecordingIds.join(",")}`);
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
    totalCandidateCount,
    // Retained for old report readers; this is the raw model decision count.
    autoPassCandidateCount: modelAutoPassCandidateCount,
    modelAutoPassCandidateCount,
    scopedAutoPassCandidateCount,
    selfCheckedAutoPassCandidateCount,
    pilotEligibleAutoPassCandidateCount: selfCheckedAutoPassCandidateCount,
    suppressedModelAutoPassCandidateCount: Math.max(
      0,
      modelAutoPassCandidateCount - selfCheckedAutoPassCandidateCount,
    ),
    rawModelReviewRequiredCandidateCount: Math.max(0, totalCandidateCount - modelAutoPassCandidateCount),
    reviewRequiredCandidateCount: Math.max(0, totalCandidateCount - selfCheckedAutoPassCandidateCount),
    knownUsableAutoPassCandidateCount: knownUsable,
    knownWrongAutoPassCandidateCount: knownWrong,
    unknownAutoPassCandidateCount: unknown,
  } : emptyMonitoring();
  const pilotRunAccepted = sessionStatus === "completed_safe"
    && ordinaryExecutionPassed
    && m3plusExecutionPassed;
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sessionId,
    sessionStatus,
    executionRequested: execute,
    executionPerformed,
    pilotRunAccepted,
    executors: {
      aggregateReadinessReady: aggregateExecutorReadinessReady,
      ordinary: {
        contract: preflight.pilotExecutorContract || "",
        readinessReady: ordinaryExecutorReadinessReady,
        executionPerformed: ordinaryExecutionPerformed,
        executionPassed: ordinaryExecutionPassed,
      },
      m3plus: {
        contract: preflight.m3plusPilotExecutorContract || "",
        readinessReady: m3plusExecutorReadinessReady,
        executionPerformed: m3plusExecutionPerformed,
        executionPassed: m3plusExecutionPassed,
        result: m3plusResult,
      },
    },
    approvedBy: preflight.decision?.approval?.approvedBy || "",
    approvalPresent: preflight.decision?.approvalPresent === true,
    requestedRecordingIds,
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
  const [{ runDynamicShadowPilotSession }, { runM3PlusPitchSafetyPilotSession }] = await Promise.all([
    import("./western-ordinary-dynamic-shadow-pilot-executor.mjs"),
    import("./western-m3plus-pitch-safety-pilot-executor.mjs"),
  ]);
  const report = await runControlledPilotSession(args, {
    runDynamicShadowPilotSession,
    runM3PlusPitchSafetyPilotSession,
  });
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
    requestedRecordingIds: report.requestedRecordingIds,
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
