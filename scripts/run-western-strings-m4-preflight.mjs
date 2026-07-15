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
  "western:m4-independent-gold-note-summary",
  "western:m4-independent-gold-todo",
  "western:m4-gold-provenance-audit",
  "western:m4-independent-gold-workspace-audit",
  "western:m4-omr-confidence-probe",
  "western:m4-independent-benchmark-audit",
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
    `- automaticAdoptionReady: ${report.automaticAdoptionReady}`,
    `- studentGateReady: ${report.studentGateReady}`,
    `- teacherReviewNeeded: ${report.teacherReviewNeeded}`,
    `- scoreEditorReviewNeeded: ${report.scoreEditorReviewNeeded}`,
    `- humanTask: ${report.humanTask}`,
    "",
    "## Current Counts",
    "",
    `- readiness pairReadyRows: ${report.counts.pairReadyRows}`,
    `- benchmark usableBenchmarkRows: ${report.counts.usableBenchmarkRows}`,
    `- benchmark humanApprovedUnchangedRows: ${report.counts.humanApprovedUnchangedRows}`,
    `- benchmark selfComparisonRows: ${report.counts.selfComparisonRows}`,
    `- provenance manualGoldRequiredRows: ${report.counts.manualGoldRequiredRows}`,
    `- provenance humanApprovedUnchangedDraftRows: ${report.counts.humanApprovedUnchangedDraftRows}`,
    `- provenance independentCandidateRows: ${report.counts.independentCandidateRows}`,
    `- workspace readyToApplyRows: ${report.counts.readyToApplyRows}`,
    `- workspace pendingRows: ${report.counts.pendingRows}`,
    `- independent clean rows: ${report.counts.independentCleanRows}`,
    `- independent synthetic scan rows: ${report.counts.independentScanRows}`,
    `- independent synthetic photo rows: ${report.counts.independentPhotoRows}`,
    `- strict per-piece pass: ${report.counts.strictPerPiecePassedRows}/${report.counts.strictPerPieceEvaluatedRows}`,
    `- independent real-photo gold rows: ${report.counts.independentRealPhotoRows}`,
    `- independent real-photo strict pass: ${report.counts.realPhotoStrictPassedRows}/${report.counts.realPhotoStrictEvaluatedRows}`,
    `- independent real-photo aggregate P/R/onset/measure: ${report.counts.realPhotoPitchPrecision ?? "n/a"}/${report.counts.realPhotoPitchRecall ?? "n/a"}/${report.counts.realPhotoOnsetQuarterAccuracy ?? "n/a"}/${report.counts.realPhotoMeasureAccuracy ?? "n/a"}`,
    `- Oemer source-gold usable/failure rows: ${report.counts.oemerUsableRows}/${report.counts.oemerEngineFailureRows}`,
    `- Oemer source-gold strict pass: ${report.counts.oemerStrictPassedRows}/${report.counts.oemerBenchmarkRows}`,
    `- Oemer source-gold P/effective-R: ${report.counts.oemerPitchPrecision ?? "n/a"}/${report.counts.oemerPitchRecallIncludingEngineFailures ?? "n/a"}`,
    `- HOMR source-gold usable/failure rows: ${report.counts.homrUsableRows}/${report.counts.homrEngineFailureRows}`,
    `- HOMR pitch-only/complete strict pass: ${report.counts.homrPitchOnlyStrictPassedRows}/${report.counts.homrStrictPassedRows}`,
    `- HOMR P/R/onset/measure: ${report.counts.homrPitchPrecision ?? "n/a"}/${report.counts.homrPitchRecall ?? "n/a"}/${report.counts.homrOnsetQuarterAccuracy ?? "n/a"}/${report.counts.homrMeasureAccuracy ?? "n/a"}`,
    `- Clarity source-gold usable/failure rows: ${report.counts.clarityUsableRows}/${report.counts.clarityEngineFailureRows}`,
    `- Clarity pitch-only/complete strict pass: ${report.counts.clarityPitchOnlyStrictPassedRows}/${report.counts.clarityStrictPassedRows}`,
    `- Clarity P/R/onset/measure: ${report.counts.clarityPitchPrecision ?? "n/a"}/${report.counts.clarityPitchRecall ?? "n/a"}/${report.counts.clarityOnsetQuarterAccuracy ?? "n/a"}/${report.counts.clarityMeasureAccuracy ?? "n/a"}`,
    `- Clarity adaptation evaluated/rejected: ${report.counts.clarityAdaptationEvaluated}/${report.counts.clarityAdaptationRejected}`,
    `- Clarity adaptation P/R/onset/measure: ${report.counts.clarityAdaptationPitchPrecision ?? "n/a"}/${report.counts.clarityAdaptationPitchRecall ?? "n/a"}/${report.counts.clarityAdaptationOnsetQuarterAccuracy ?? "n/a"}/${report.counts.clarityAdaptationMeasureAccuracy ?? "n/a"}`,
    "",
    "## Meaning",
    "",
    report.humanTask === "score-editor-independent-gold-correction"
      ? "- Machine checks already proved this is not a teacher audio-diagnosis review. The remaining task is score-editor correction of independent gold MXL files against source score images."
      : "- No score-editor task is currently required. Independent render/scan/photo gold supports an eval-only accuracy claim; independently sourced real-photo gold is measured separately and remains below the automatic-adoption floor.",
    `- automatic-adoption blockers: ${report.automaticAdoptionBlockingReasons.join(", ") || "none"}`,
    "",
    "## Artifacts",
    "",
    `- todoHtml: ${report.artifacts.todoHtml}`,
    `- workspaceCsv: ${report.artifacts.workspaceCsv}`,
    `- noteSummaryMd: ${report.artifacts.noteSummaryMd}`,
    `- noteSummaryCsv: ${report.artifacts.noteSummaryCsv}`,
    `- provenanceCsv: ${report.artifacts.provenanceCsv}`,
    `- workspaceAuditCsv: ${report.artifacts.workspaceAuditCsv}`,
    `- independentBenchmarkJson: ${report.artifacts.independentBenchmarkJson}`,
    `- independentBenchmarkMd: ${report.artifacts.independentBenchmarkMd}`,
    `- oemerBenchmark: ${report.artifacts.oemerBenchmark}`,
    `- homrBenchmark: ${report.artifacts.homrBenchmark}`,
    `- clarityBenchmark: ${report.artifacts.clarityBenchmark}`,
    `- clarityAdaptationBenchmark: ${report.artifacts.clarityAdaptationBenchmark}`,
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
  const independentBenchmark = await readJson(path.join("data", "experiments", "western-strings-m4", "independent-benchmark-audit.json"));
  const oemerBenchmark = await readJson(path.join("data", "experiments", "western-strings-m4", "oemer-source-benchmark", "oemer-source-benchmark.json"));
  const homrBenchmark = await readJson(path.join("data", "experiments", "western-strings-m4", "homr-source-benchmark", "homr-source-benchmark.json"));
  const clarityBenchmark = await readJson(path.join("data", "experiments", "western-strings-m4", "clarity-source-benchmark", "clarity-source-benchmark.json"));
  const clarityAdaptationBenchmark = await readJson(path.join("data", "experiments", "western-strings-m4", "clarity-adaptation-photo-benchmark", "clarity-source-benchmark.json"));
  const status = await readJson(path.join("data", "experiments", "western-strings-project-status.json"));

  const m4Status = status?.tracks?.m4Omr || {};
  const counts = {
    pairReadyRows: readiness?.counts?.pairReadyRows ?? 0,
    usableBenchmarkRows: benchmark?.counts?.usableBenchmarkRows ?? 0,
    humanApprovedUnchangedRows: benchmark?.counts?.humanApprovedUnchangedRows ?? 0,
    selfComparisonRows: benchmark?.counts?.selfComparisonRows ?? 0,
    manualGoldRequiredRows: provenance?.counts?.manualGoldRequiredRows ?? 0,
    humanApprovedUnchangedDraftRows: provenance?.counts?.humanApprovedUnchangedDraftRows ?? 0,
    independentCandidateRows: provenance?.counts?.independentCandidateRows ?? 0,
    readyToApplyRows: workspace?.counts?.readyToApplyRows ?? 0,
    pendingRows: workspace?.counts?.pendingRows ?? 0,
    independentCleanRows: independentBenchmark?.domains?.clean?.evaluatedRows ?? 0,
    independentScanRows: independentBenchmark?.domains?.scan?.evaluatedRows ?? 0,
    independentPhotoRows: independentBenchmark?.domains?.photo?.evaluatedRows ?? 0,
    strictPerPiecePassedRows: independentBenchmark?.strictPerPiece?.passedRows ?? 0,
    strictPerPieceEvaluatedRows: independentBenchmark?.strictPerPiece?.evaluatedRows ?? 0,
    independentRealPhotoRows: independentBenchmark?.independentRealPhotoRows ?? 0,
    realPhotoStrictPassedRows: independentBenchmark?.realPhotoGold?.passedRows ?? 0,
    realPhotoStrictEvaluatedRows: independentBenchmark?.realPhotoGold?.evaluatedRows ?? 0,
    realPhotoPitchPrecision: independentBenchmark?.realPhotoGold?.aggregate?.precision ?? null,
    realPhotoPitchRecall: independentBenchmark?.realPhotoGold?.aggregate?.recall ?? null,
    realPhotoOnsetQuarterAccuracy: independentBenchmark?.realPhotoGold?.aggregate?.onsetQuarterAccuracy ?? null,
    realPhotoMeasureAccuracy: independentBenchmark?.realPhotoGold?.aggregate?.measureAccuracy ?? null,
    oemerBenchmarkRows: oemerBenchmark?.comparison?.oemer?.rows ?? 0,
    oemerUsableRows: oemerBenchmark?.comparison?.oemer?.usableRows ?? 0,
    oemerEngineFailureRows: oemerBenchmark?.comparison?.oemer?.engineFailureRows ?? 0,
    oemerStrictPassedRows: oemerBenchmark?.comparison?.oemer?.strictPassRows ?? 0,
    oemerPitchPrecision: oemerBenchmark?.comparison?.oemer?.pitchPrecision ?? null,
    oemerPitchRecallIncludingEngineFailures:
      oemerBenchmark?.comparison?.oemer?.pitchRecallIncludingEngineFailures ?? null,
    homrBenchmarkRows: homrBenchmark?.comparison?.homr?.rows ?? 0,
    homrUsableRows: homrBenchmark?.comparison?.homr?.usableRows ?? 0,
    homrEngineFailureRows: homrBenchmark?.comparison?.homr?.engineFailureRows ?? 0,
    homrPitchOnlyStrictPassedRows: homrBenchmark?.comparison?.homr?.pitchOnlyStrictPassRows ?? 0,
    homrStrictPassedRows: homrBenchmark?.comparison?.homr?.strictPassRows ?? 0,
    homrPitchPrecision: homrBenchmark?.comparison?.homr?.pitchPrecision ?? null,
    homrPitchRecall: homrBenchmark?.comparison?.homr?.pitchRecall ?? null,
    homrOnsetQuarterAccuracy: homrBenchmark?.comparison?.homr?.onsetQuarterAccuracy ?? null,
    homrMeasureAccuracy: homrBenchmark?.comparison?.homr?.measureAccuracy ?? null,
    clarityBenchmarkRows: clarityBenchmark?.comparison?.clarity?.rows ?? 0,
    clarityUsableRows: clarityBenchmark?.comparison?.clarity?.usableRows ?? 0,
    clarityEngineFailureRows: clarityBenchmark?.comparison?.clarity?.engineFailureRows ?? 0,
    clarityPitchOnlyStrictPassedRows: clarityBenchmark?.comparison?.clarity?.pitchOnlyStrictPassRows ?? 0,
    clarityStrictPassedRows: clarityBenchmark?.comparison?.clarity?.strictPassRows ?? 0,
    clarityPitchPrecision: clarityBenchmark?.comparison?.clarity?.pitchPrecision ?? null,
    clarityPitchRecall: clarityBenchmark?.comparison?.clarity?.pitchRecall ?? null,
    clarityOnsetQuarterAccuracy: clarityBenchmark?.comparison?.clarity?.onsetQuarterAccuracy ?? null,
    clarityMeasureAccuracy: clarityBenchmark?.comparison?.clarity?.measureAccuracy ?? null,
    clarityAdaptationEvaluated: clarityAdaptationBenchmark?.adaptationDecision?.evaluated === true,
    clarityAdaptationRejected:
      clarityAdaptationBenchmark?.adaptationDecision?.checkpointDisposition === "reject-and-delete",
    clarityAdaptationPitchPrecision:
      clarityAdaptationBenchmark?.comparison?.clarity?.pitchPrecision ?? null,
    clarityAdaptationPitchRecall:
      clarityAdaptationBenchmark?.comparison?.clarity?.pitchRecall ?? null,
    clarityAdaptationOnsetQuarterAccuracy:
      clarityAdaptationBenchmark?.comparison?.clarity?.onsetQuarterAccuracy ?? null,
    clarityAdaptationMeasureAccuracy:
      clarityAdaptationBenchmark?.comparison?.clarity?.measureAccuracy ?? null,
  };

  const teacherReviewNeeded = Boolean(m4Status.teacherReviewNeeded || provenance?.teacherReviewNeeded || workspace?.teacherReviewNeeded);
  const scoreEditorReviewNeeded = Boolean(m4Status.scoreEditorReviewNeeded);
  const readyForOmrAccuracyClaim = Boolean(
    commandOk
      && independentBenchmark?.independentBenchmarkReady === true
      && counts.independentCleanRows > 0,
  );
  const humanTask = m4Status.humanTask && m4Status.humanTask !== "none"
    ? m4Status.humanTask
    : counts.manualGoldRequiredRows > 0
      ? provenance?.humanTask || workspace?.humanTask || "score-editor-independent-gold-correction"
      : "none";

  const report = {
    ok: commandOk,
    generatedAt: new Date().toISOString(),
    machineSelfTestComplete: commandOk && Boolean(readiness && benchmark && provenance && workspace && independentBenchmark && status),
    readyForOmrAccuracyClaim,
    automaticAdoptionReady: independentBenchmark?.automaticAdoptionReady === true,
    studentGateReady: false,
    teacherReviewNeeded,
    scoreEditorReviewNeeded,
    humanTask,
    counts,
    blockingReasons: m4Status.blockingReasons || [],
    automaticAdoptionBlockingReasons:
      m4Status.automaticAdoptionBlockingReasons
      || independentBenchmark?.automaticAdoptionBlockingReasons
      || ["m4-independent-benchmark-audit-missing"],
    artifacts: {
      out: rel(args.out),
      summary: rel(args.summary),
      todoHtml: "data/experiments/western-strings-m4/independent-gold-todo.html",
      workspaceCsv: "data/experiments/western-strings-m4/independent-gold-workspace.csv",
      noteSummaryMd: "data/experiments/western-strings-m4/independent-gold-note-summary.md",
      noteSummaryCsv: "data/experiments/western-strings-m4/independent-gold-note-summary.csv",
      provenanceCsv: "data/experiments/western-strings-m4/gold-provenance-audit.csv",
      workspaceAuditCsv: "data/experiments/western-strings-m4/independent-gold-workspace-audit.csv",
      independentBenchmarkJson: "data/experiments/western-strings-m4/independent-benchmark-audit.json",
      independentBenchmarkMd: "data/experiments/western-strings-m4/independent-benchmark-audit.md",
      independentRealPhotoManifest: "data/experiments/western-strings-m4/independent-real-photo-gold/independent-gold-manifest.json",
      independentRealPhotoBenchmark: "data/experiments/western-strings-m4/independent-source-benchmark/omr-benchmark.json",
      oemerBenchmark: "data/experiments/western-strings-m4/oemer-source-benchmark/oemer-source-benchmark.json",
      homrBenchmark: "data/experiments/western-strings-m4/homr-source-benchmark/homr-source-benchmark.json",
      clarityBenchmark: "data/experiments/western-strings-m4/clarity-source-benchmark/clarity-source-benchmark.json",
      clarityAdaptationBenchmark: "data/experiments/western-strings-m4/clarity-adaptation-photo-benchmark/clarity-source-benchmark.json",
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
    automaticAdoptionReady: report.automaticAdoptionReady,
    studentGateReady: report.studentGateReady,
    teacherReviewNeeded: report.teacherReviewNeeded,
    scoreEditorReviewNeeded: report.scoreEditorReviewNeeded,
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
