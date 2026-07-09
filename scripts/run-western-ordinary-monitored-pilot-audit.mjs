import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildOrdinaryMonitoredPilotPlan } from "./create-western-ordinary-monitored-pilot-plan.mjs";
import { runOrdinaryMonitoredPilotReviewPack } from "./run-western-ordinary-monitored-pilot-review-pack.mjs";
import { runOrdinaryMonitoredPilotSmoke } from "./run-western-ordinary-monitored-pilot-smoke.mjs";

const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3", "ordinary-monitored-pilot");

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
  }
  return args;
}

function rel(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function reasonList(items) {
  return Array.isArray(items) && items.length ? items : [];
}

function renderMarkdown(report) {
  return [
    "# Ordinary Upload Monitored Pilot Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Decision",
    "",
    `- ok: ${report.ok}`,
    `- readyForMonitoredPilot: ${report.readyForMonitoredPilot}`,
    `- teacherReviewNeeded: ${report.teacherReviewNeeded}`,
    `- defaultOrdinaryReadyAfter: ${report.defaultOrdinaryReadyAfter}`,
    "",
    "## Precision Precheck",
    "",
    `- ok: ${report.precisionPrecheck.ok}`,
    `- selectedSubmissionCount: ${report.precisionPrecheck.selectedSubmissionCount}`,
    `- totalCandidateCount: ${report.precisionPrecheck.totalCandidateCount}`,
    `- autoPassCandidateCount: ${report.precisionPrecheck.autoPassCandidateCount}`,
    `- selfCheckedAutoPassCandidateCount: ${report.precisionPrecheck.selfCheckedAutoPassCandidateCount}`,
    `- knownUsableAutoPassCandidateCount: ${report.precisionPrecheck.knownUsableAutoPassCandidateCount}`,
    `- knownWrongAutoPassCandidateCount: ${report.precisionPrecheck.knownWrongAutoPassCandidateCount}`,
    `- unknownReviewCandidateCount: ${report.precisionPrecheck.unknownReviewCandidateCount}`,
    "",
    "## Smoke",
    "",
    `- ok: ${report.smoke.ok}`,
    `- tempRunOnly: ${report.smoke.tempRunOnly}`,
    `- defaultOrdinaryReadyAfter: ${report.smoke.defaultOrdinaryReadyAfter}`,
    `- autoPassCandidateCount: ${report.smoke.autoPassCandidateCount}`,
    `- reviewRequiredCandidateCount: ${report.smoke.reviewRequiredCandidateCount}`,
    "",
    "## Pilot Plan",
    "",
    `- ok: ${report.plan.ok}`,
    `- readyForPilotPlan: ${report.plan.readyForPilotPlan}`,
    `- precisionPrecheckOk: ${report.plan.precisionPrecheckOk}`,
    "",
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "## Safety Notes",
    "",
    "- This audit does not enable the default student runtime.",
    "- The precision precheck reuses known labels before asking for teacher review.",
    "- If unknown auto-pass rows appear, only those unknown rows should be reviewed.",
    "- If known-wrong auto-pass rows appear, stop and improve the candidate/confidence model.",
    "",
  ].join("\n");
}

export async function runOrdinaryMonitoredPilotAudit(args = {}) {
  const outDir = path.resolve(args.outDir || DEFAULT_OUT_DIR);
  const precision = await runOrdinaryMonitoredPilotReviewPack({ outDir: path.join(outDir, "precision-review-pack") });
  const smoke = await runOrdinaryMonitoredPilotSmoke({ outDir });
  const plan = await buildOrdinaryMonitoredPilotPlan({ outDir });

  const precisionSummary = precision.summary;
  const smokeReport = smoke.report;
  const pilotPlan = plan.plan;

  const blockingReasons = [
    ...reasonList(precisionSummary.blockingReasons).map((reason) => `precision:${reason}`),
    ...reasonList(smokeReport.blockingReasons).map((reason) => `smoke:${reason}`),
    ...reasonList(pilotPlan.blockingReasons).map((reason) => `plan:${reason}`),
  ];
  const teacherReviewNeeded = Number(precisionSummary.unknownReviewCandidateCount || 0) > 0;
  const knownWrongCount = Number(precisionSummary.knownWrongAutoPassCandidateCount || 0);
  if (teacherReviewNeeded) blockingReasons.push("precision:unknown-auto-pass-rows-need-review");
  if (knownWrongCount > 0) blockingReasons.push("precision:known-wrong-auto-pass-rows");

  const report = {
    ok: blockingReasons.length === 0,
    generatedAt: new Date().toISOString(),
    readyForMonitoredPilot: blockingReasons.length === 0,
    teacherReviewNeeded,
    defaultOrdinaryReadyAfter: smokeReport.defaultOrdinaryReadyAfter === true || pilotPlan.defaultRuntimeEnabled === true,
    precisionPrecheck: {
      ok: precisionSummary.ok === true,
      summary: rel(precision.summaryPath),
      markdown: rel(precision.mdPath),
      selectedSubmissionCount: precisionSummary.selectedSubmissionCount,
      totalCandidateCount: precisionSummary.totalCandidateCount,
      autoPassCandidateCount: precisionSummary.autoPassCandidateCount,
      selfCheckedAutoPassCandidateCount: precisionSummary.selfCheckedAutoPassCandidateCount,
      knownUsableAutoPassCandidateCount: precisionSummary.knownUsableAutoPassCandidateCount,
      knownWrongAutoPassCandidateCount: precisionSummary.knownWrongAutoPassCandidateCount,
      unknownReviewCandidateCount: precisionSummary.unknownReviewCandidateCount,
      reviewPackRows: precisionSummary.reviewPack?.rowCount ?? 0,
    },
    smoke: {
      ok: smokeReport.ok === true,
      json: rel(smoke.jsonPath),
      markdown: rel(smoke.mdPath),
      tempRunOnly: smokeReport.tempRunOnly === true,
      defaultOrdinaryReadyAfter: smokeReport.defaultOrdinaryReadyAfter === true,
      autoPassCandidateCount: smokeReport.batchItem?.candidateGate?.autoPassCandidateCount ?? null,
      reviewRequiredCandidateCount: smokeReport.batchItem?.candidateGate?.reviewRequiredCandidateCount ?? null,
    },
    plan: {
      ok: pilotPlan.ok === true,
      json: rel(plan.jsonPath),
      markdown: rel(plan.mdPath),
      readyForPilotPlan: pilotPlan.readyForPilotPlan === true,
      precisionPrecheckOk: pilotPlan.evidence?.precisionPrecheckOk === true,
    },
    blockingReasons,
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "ordinary-monitored-pilot-audit.json");
  const mdPath = path.join(outDir, "ordinary-monitored-pilot-audit.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  return { report, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { report, jsonPath, mdPath } = await runOrdinaryMonitoredPilotAudit(args);
  console.log(JSON.stringify({
    ok: report.ok,
    readyForMonitoredPilot: report.readyForMonitoredPilot,
    teacherReviewNeeded: report.teacherReviewNeeded,
    blockingReasons: report.blockingReasons,
    precisionPrecheck: report.precisionPrecheck,
    smoke: report.smoke,
    plan: report.plan,
    out: {
      json: rel(jsonPath),
      md: rel(mdPath),
    },
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
