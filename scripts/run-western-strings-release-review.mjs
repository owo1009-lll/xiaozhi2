import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { evaluateProjectGate } from "./gate-western-strings-project.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const DEFAULT_OUT = path.join("data", "experiments", "western-strings-release-review.json");
const DEFAULT_SUMMARY = path.join("data", "experiments", "western-strings-release-review.md");

const STEPS = [
  "test:western-offline-feature-audio",
  "test:western-controlled-pilot-run",
  "test:western-controlled-pilot-evidence-audit",
  "test:western-fresh-blind-intake",
  "test:western-ordinary-pilot-selection",
  "western:ordinary-monitored-pilot-audit",
  "western:m3plus-monitored-pilot-audit",
  "western:m4-preflight",
  "western:project-status",
  "western:controlled-pilot-evidence-audit",
];

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    summary: DEFAULT_SUMMARY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--summary") args.summary = argv[++index] || args.summary;
  }
  return args;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpmScript(script) {
  const command = process.env.npm_execpath ? process.execPath : npmCommand();
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, "run", script, "--silent"]
    : ["run", script, "--silent"];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  return {
    script,
    ok: result.status === 0,
    status: result.status,
    error: result.error ? String(result.error.message || result.error) : "",
    stdoutTail: String(result.stdout || "").trim().split(/\r?\n/).slice(-8).join("\n"),
    stderrTail: String(result.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n"),
  };
}

function rel(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function blockingReasonList(items) {
  const values = (items || []).filter(Boolean);
  return values.length ? values.map((item) => `- ${item}`).join("\n") : "- none";
}

function buildSummary(report) {
  const lines = [
    "# Western Strings Release Review",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- machineChecksComplete: ${report.machineChecksComplete}`,
    `- readyForControlledPilot: ${report.readyForControlledPilot}`,
    `- readyForDefaultStudentRelease: ${report.readyForDefaultStudentRelease}`,
    `- teacherReviewNeeded: ${report.teacherReviewNeeded}`,
    `- runtimeFailClosed: ${report.runtimeFailClosed}`,
    "",
    "## Track Decisions",
    "",
    `- ordinary monitored pilot evidence: ${report.tracks.ordinary.readyForControlledPilot}`,
    `- M3+ monitored pilot evidence: ${report.tracks.m3plus.readyForControlledPilot}`,
    `- M4 OMR benchmark evidence: ${report.tracks.m4.readyForOmrAccuracyClaim}`,
    "",
    "## Default Release Gate",
    "",
    `- projectReleaseReady: ${report.projectGate.projectReleaseReady}`,
    "- failures:",
    blockingReasonList(report.projectGate.failures.map((failure) => `${failure.track}: ${(failure.reason || []).join("|")}`)),
    "",
    "## Meaning",
    "",
    report.readyForControlledPilot
      ? "- Current evidence is sufficient to consider a separate monitored pilot. Keep the default student runtime fail-closed unless that pilot is explicitly started."
      : "- Current evidence is not sufficient for a monitored pilot. Fix the listed blockers before asking for any new review.",
    report.readyForDefaultStudentRelease
      ? "- Default student release gate is open."
      : "- Default student release gate remains closed. This is expected while ordinary auto feedback is disabled by default.",
    report.teacherReviewNeeded
      ? "- Some track still needs targeted human review. Review only the rows reported by that track."
      : "- No track currently asks for more teacher review.",
    "",
    "## Artifacts",
    "",
    `- releaseReviewJson: ${report.artifacts.out}`,
    `- releaseReviewMd: ${report.artifacts.summary}`,
    `- projectStatus: ${report.artifacts.projectStatus}`,
    `- projectGate: ${report.artifacts.projectGate}`,
    "",
    "## Step Results",
    "",
  ];
  for (const step of report.steps) {
    lines.push(`- ${step.ok ? "ok" : "failed"}: npm run ${step.script}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = STEPS.map((script) => runNpmScript(script));
  const commandOk = steps.every((step) => step.ok);
  const status = await buildProjectStatus();
  const projectGate = evaluateProjectGate(status, new Set(["ordinary", "m3plus", "m4"]));
  const controlled = status.tracks?.controlledCandidate || {};
  const ordinaryAudit = controlled.confidencePilot?.monitoredPilotAudit || {};
  const m3plus = status.tracks?.m3plusPitchModes || {};
  const m3plusAudit = m3plus.monitoredPilotAudit || {};
  const m4 = status.tracks?.m4Omr || {};
  const ordinaryReady = ordinaryAudit.readyForMonitoredPilot === true
    && ordinaryAudit.teacherReviewNeeded !== true
    && ordinaryAudit.defaultOrdinaryReadyAfter !== true
    && (ordinaryAudit.blockingReasons || []).length === 0;
  const m3plusReady = m3plusAudit.readyForMonitoredPilot === true
    && m3plusAudit.teacherReviewNeeded !== true
    && m3plusAudit.defaultM3PlusReadyAfter !== true
    && (m3plusAudit.blockingReasons || []).length === 0;
  const m4Ready = m4.m4OmrDraftQualityReady === true
    && m4.teacherReviewNeeded !== true
    && (m4.blockingReasons || []).length === 0;
  const runtimeFailClosed = status.runtimeStudentGate?.policy === "fail-closed"
    && status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === false
    && status.runtimeStudentGate?.m3plusAutoFeedbackReady === false
    && status.runtimeStudentGate?.m4OmrAutoScoreReady === false;
  const teacherReviewNeeded = ordinaryAudit.teacherReviewNeeded === true
    || m3plusAudit.teacherReviewNeeded === true
    || m4.teacherReviewNeeded === true;
  const readyForControlledPilot = commandOk
    && ordinaryReady
    && m3plusReady
    && m4Ready
    && runtimeFailClosed
    && !teacherReviewNeeded;
  const readyForDefaultStudentRelease = projectGate.projectReleaseReady === true
    && status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === true;
  const report = {
    ok: commandOk,
    generatedAt: new Date().toISOString(),
    machineChecksComplete: commandOk,
    readyForControlledPilot,
    readyForDefaultStudentRelease,
    teacherReviewNeeded,
    runtimeFailClosed,
    projectGate,
    tracks: {
      ordinary: {
        readyForControlledPilot: ordinaryReady,
        defaultReadyAfterAudit: ordinaryAudit.defaultOrdinaryReadyAfter === true,
        teacherReviewNeeded: ordinaryAudit.teacherReviewNeeded === true,
        autoPassCandidates: ordinaryAudit.precisionPrecheck || {},
        blockingReasons: ordinaryAudit.blockingReasons || [],
      },
      m3plus: {
        readyForControlledPilot: m3plusReady,
        defaultReadyAfterAudit: m3plusAudit.defaultM3PlusReadyAfter === true,
        teacherReviewNeeded: m3plusAudit.teacherReviewNeeded === true,
        releaseModes: m3plusAudit.releaseModes || {},
        blockedModes: m3plusAudit.blockedModes || [],
        blockingReasons: m3plusAudit.blockingReasons || [],
      },
      m4: {
        readyForOmrAccuracyClaim: m4Ready,
        teacherReviewNeeded: m4.teacherReviewNeeded === true,
        humanTask: m4.humanTask || "",
        counts: m4.counts || {},
        blockingReasons: m4.blockingReasons || [],
      },
    },
    artifacts: {
      out: rel(args.out),
      summary: rel(args.summary),
      projectStatus: "data/experiments/western-strings-project-status.json",
      projectGate: "data/experiments/western-strings-project-gate.json",
    },
    steps,
  };
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(args.summary, buildSummary(report), "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    readyForControlledPilot: report.readyForControlledPilot,
    readyForDefaultStudentRelease: report.readyForDefaultStudentRelease,
    teacherReviewNeeded: report.teacherReviewNeeded,
    runtimeFailClosed: report.runtimeFailClosed,
    summary: rel(args.summary),
  }, null, 2));
  if (!commandOk) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
