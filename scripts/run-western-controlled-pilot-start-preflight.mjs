import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildControlledPilotDecision } from "./create-western-controlled-pilot-decision.mjs";

const DEFAULT_OUT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-start-preflight.json",
);
const DEFAULT_SUMMARY = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-start-preflight.md",
);
export const REQUIRED_PILOT_EXECUTOR_CONTRACT = "western-ordinary-dynamic-shadow-pilot-executor-v1";

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, summary: DEFAULT_SUMMARY };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--summary") args.summary = argv[++index] || args.summary;
    else if (arg === "--release-review") args.releaseReview = argv[++index] || args.releaseReview;
    else if (arg === "--approval") args.approval = argv[++index] || args.approval;
  }
  return args;
}

function rel(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function renderMarkdown(report) {
  return [
    "# Western Strings Controlled Pilot Start Preflight",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- okToStartControlledPilot: ${report.okToStartControlledPilot}`,
    `- approvalPresent: ${report.decision.approvalPresent}`,
    `- runtimeFailClosed: ${report.decision.runtimeFailClosed}`,
    "",
    "## Blocking Reasons",
    "",
    report.blockingReasons.length
      ? report.blockingReasons.map((reason) => `- ${reason}`).join("\n")
      : "- none",
    "",
    "## Safety Contract",
    "",
    "- This preflight does not enable any runtime gate.",
    "- It must pass immediately before starting a separate monitored pilot process.",
    "- Default production/student runtime must remain fail-closed.",
    "- Teacher/professional review is only required if a machine precheck reports unknown or unsafe auto-pass rows.",
    "",
    "## Artifacts",
    "",
    `- preflightJson: ${report.artifacts.out}`,
    `- preflightMd: ${report.artifacts.summary}`,
    `- decisionJson: ${report.decision.artifacts.out}`,
    `- approval: ${report.decision.artifacts.approval}`,
    "",
  ].join("\n");
}

export async function buildControlledPilotStartPreflight(args = {}) {
  const decision = await buildControlledPilotDecision({
    releaseReview: args.releaseReview,
    approval: args.approval,
  });
  const blockingReasons = [...(decision.blockingReasons || [])];
  if (decision.readyForControlledPilotDecision !== true) {
    blockingReasons.push("controlled-pilot-decision-not-ready");
  }
  if (decision.readyToStartControlledPilot !== true) {
    blockingReasons.push("controlled-pilot-decision-not-startable");
  }
  if (decision.runtimeFailClosed !== true) {
    blockingReasons.push("runtime-not-fail-closed");
  }
  if (decision.approvalPresent !== true) {
    blockingReasons.push(decision.approvalDeferred === true ? "approval-explicitly-deferred" : "approval-not-present");
  }
  const pilotExecutorReady = args.pilotExecutorContractReady === true
    && args.pilotExecutorContract === REQUIRED_PILOT_EXECUTOR_CONTRACT;
  if (!pilotExecutorReady) {
    blockingReasons.push("ordinary-dynamic-shadow-pilot-executor-not-implemented");
  }
  const uniqueBlockingReasons = [...new Set(blockingReasons)];
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    okToStartControlledPilot: uniqueBlockingReasons.length === 0,
    pilotExecutorContract: REQUIRED_PILOT_EXECUTOR_CONTRACT,
    pilotExecutorReady,
    blockingReasons: uniqueBlockingReasons,
    decision,
    artifacts: {
      out: rel(args.out || DEFAULT_OUT),
      summary: rel(args.summary || DEFAULT_SUMMARY),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildControlledPilotStartPreflight(args);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(args.summary, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    okToStartControlledPilot: report.okToStartControlledPilot,
    blockingReasons: report.blockingReasons,
    summary: rel(args.summary),
  }, null, 2));
  if (!report.okToStartControlledPilot) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
