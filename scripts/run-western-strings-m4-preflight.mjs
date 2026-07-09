import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_OUT = path.join("data", "experiments", "western-strings-m4", "m4-preflight.json");
const DEFAULT_SUMMARY = path.join("data", "experiments", "western-strings-m4", "m4-preflight.md");

const STEPS = [
  "western:m4-omr-readiness",
  "western:m4-omr-benchmark",
  "western:m4-independent-gold-todo",
  "western:m4-independent-gold-workspace",
  "western:m4-gold-provenance-audit",
  "western:m4-independent-gold-workspace-audit",
  "western:m4-independent-gold-note-summary",
  "western:project-status",
  "western:next-actions",
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

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function rel(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function buildSummary(report) {
  const lines = [
    "# M4 OMR Preflight",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- machineSelfTestComplete: ${report.machineSelfTestComplete}`,
    `- readyForOmrAccuracyClaim: ${report.readyForOmrAccuracyClaim}`,
    `- teacherReviewNeeded: ${report.teacherReviewNeeded}`,
    `- humanTask: ${report.humanTask}`,
    "",
    "## Current Counts",
    "",
    `- readiness pairReadyRows: ${report.counts.pairReadyRows}`,
    `- benchmark usableBenchmarkRows: ${report.counts.usableBenchmarkRows}`,
    `- benchmark selfComparisonRows: ${report.counts.selfComparisonRows}`,
    `- provenance manualGoldRequiredRows: ${report.counts.manualGoldRequiredRows}`,
    `- provenance independentCandidateRows: ${report.counts.independentCandidateRows}`,
    `- workspace readyToApplyRows: ${report.counts.readyToApplyRows}`,
    `- workspace pendingRows: ${report.counts.pendingRows}`,
    "",
    "## Meaning",
    "",
    report.humanTask === "score-editor-independent-gold-correction"
      ? "- Machine checks already proved this is not a teacher audio-diagnosis review. The remaining task is score-editor correction of independent gold MXL files against source score images."
      : "- No score-editor task is currently required by M4 preflight.",
    "",
    "## Artifacts",
    "",
    `- todoHtml: ${report.artifacts.todoHtml}`,
    `- workspaceCsv: ${report.artifacts.workspaceCsv}`,
    `- noteSummaryMd: ${report.artifacts.noteSummaryMd}`,
    `- noteSummaryCsv: ${report.artifacts.noteSummaryCsv}`,
    `- provenanceCsv: ${report.artifacts.provenanceCsv}`,
    `- workspaceAuditCsv: ${report.artifacts.workspaceAuditCsv}`,
    `- nextActions: ${report.artifacts.nextActions}`,
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

  const readiness = await readJson(path.join("data", "experiments", "western-strings-m4", "omr-readiness.json"));
  const benchmark = await readJson(path.join("data", "experiments", "western-strings-m4", "omr-benchmark.json"));
  const provenance = await readJson(path.join("data", "experiments", "western-strings-m4", "gold-provenance-audit.json"));
  const workspace = await readJson(path.join("data", "experiments", "western-strings-m4", "independent-gold-workspace-audit.json"));
  const status = await readJson(path.join("data", "experiments", "western-strings-project-status.json"));

  const m4Status = status?.tracks?.m4Omr || {};
  const counts = {
    pairReadyRows: readiness?.counts?.pairReadyRows ?? 0,
    usableBenchmarkRows: benchmark?.counts?.usableBenchmarkRows ?? 0,
    selfComparisonRows: benchmark?.counts?.selfComparisonRows ?? 0,
    manualGoldRequiredRows: provenance?.counts?.manualGoldRequiredRows ?? 0,
    independentCandidateRows: provenance?.counts?.independentCandidateRows ?? 0,
    readyToApplyRows: workspace?.counts?.readyToApplyRows ?? 0,
    pendingRows: workspace?.counts?.pendingRows ?? 0,
  };

  const teacherReviewNeeded = Boolean(m4Status.teacherReviewNeeded || provenance?.teacherReviewNeeded || workspace?.teacherReviewNeeded);
  const humanTask = m4Status.humanTask || provenance?.humanTask || workspace?.humanTask || "unknown";
  const readyForOmrAccuracyClaim = Boolean(commandOk && benchmark?.gate?.m4OmrDraftQualityReady && counts.usableBenchmarkRows > 0);

  const report = {
    ok: commandOk,
    generatedAt: new Date().toISOString(),
    machineSelfTestComplete: commandOk && Boolean(readiness && benchmark && provenance && workspace && status),
    readyForOmrAccuracyClaim,
    teacherReviewNeeded,
    humanTask,
    counts,
    blockingReasons: m4Status.blockingReasons || [],
    artifacts: {
      out: rel(args.out),
      summary: rel(args.summary),
      todoHtml: "data/experiments/western-strings-m4/independent-gold-todo.html",
      workspaceCsv: "data/experiments/western-strings-m4/independent-gold-workspace.csv",
      noteSummaryMd: "data/experiments/western-strings-m4/independent-gold-note-summary.md",
      noteSummaryCsv: "data/experiments/western-strings-m4/independent-gold-note-summary.csv",
      provenanceCsv: "data/experiments/western-strings-m4/gold-provenance-audit.csv",
      workspaceAuditCsv: "data/experiments/western-strings-m4/independent-gold-workspace-audit.csv",
      nextActions: "data/experiments/western-strings-next-actions.md",
    },
    steps,
  };

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(args.summary, buildSummary(report), "utf8");

  console.log(JSON.stringify({
    ok: report.ok,
    machineSelfTestComplete: report.machineSelfTestComplete,
    readyForOmrAccuracyClaim: report.readyForOmrAccuracyClaim,
    teacherReviewNeeded: report.teacherReviewNeeded,
    humanTask: report.humanTask,
    counts: report.counts,
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
