import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildProjectStatus, writeProjectStatus } from "./status-western-strings-project.mjs";

export const DEFAULT_OUT = path.join("data", "experiments", "western-strings-next-actions.md");
const DEFAULT_STATUS_OUT = path.join("data", "experiments", "western-strings-project-status.json");

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    statusOut: DEFAULT_STATUS_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--status-out") args.statusOut = argv[++index] || args.statusOut;
  }
  return args;
}

function bulletList(items) {
  const values = (items || []).filter(Boolean);
  return values.length ? values.map((item) => `- ${item}`).join("\n") : "- none";
}

function hasReason(action, reason) {
  return (action?.reason || []).includes(reason);
}

function commandForAction(action) {
  const track = action?.track || "";
  if (track === "M2/M3 ordinary upload candidate gate") {
    if (hasReason(action, "ordinary-confidence-recalibration-validation-needed")) {
      return [
        "Keep production/default runtime fail-closed.",
        "Open data/experiments/western-strings-m3/confidence-recalibration-validation-review/index.html and review the 10-row recalibration blind-validation pack.",
        "Save the downloaded CSV as data/experiments/western-strings-m3/confidence-recalibration-validation-review/controlled-candidate-review.completed.csv.",
        "Run npm run western:controlled-candidate-confidence-recalibration-validation-eval.",
        "Then run npm run western:project-status and npm run test:western-project-gate.",
        "Only if the recalibration blind validation passes should a new monitored pilot be considered; do not enable the student gate by default.",
      ];
    }
    if (hasReason(action, "ordinary-confidence-threshold-pool-precision-too-low")) {
      return [
        "Keep production/default runtime fail-closed.",
        "Inspect data/experiments/western-strings-m3/confidence-threshold-pool-review/confidence-threshold-pool-diagnosis.json and confidence-threshold-pool-eval-rows.csv.",
        "Do not enable WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE for students; the stratified threshold-pool precision is below the release floor.",
        "The current diagnosis found no simple selected>=10 rule meeting 0.90 precision; recalibrate confidence features/model or collect stronger candidate evidence before another monitored pilot attempt.",
        "After any recalibration, rerun npm run western:controlled-candidate-confidence-pilot",
        "Then generate a new blind/stratified review pack and rerun npm run western:project-status",
      ];
    }
    if (hasReason(action, "ordinary-auto-gate-disabled-by-default")) {
      return [
        "Keep production/default runtime fail-closed.",
        "Runtime smoke now verifies that an explicit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1 process calls the frozen RF scorer and writes confidence probabilities.",
        "Use npm run western:controlled-candidate-confidence-release-audit to inspect the coverage semantics: fresh validation was prefiltered above threshold, so full threshold-pool precision is still unmeasured.",
        "Open data/experiments/western-strings-m3/confidence-threshold-pool-review/index.html and review the 60-row stratified threshold-pool sample.",
        "Save the downloaded CSV as data/experiments/western-strings-m3/confidence-threshold-pool-review/controlled-candidate-review.completed.csv.",
        "Run npm run western:controlled-candidate-confidence-stratified-eval.",
        "Only if that full threshold-pool review passes, consider WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1 in a monitored controlled pilot process.",
        "Do not commit an enabled env value or turn the gate on by default.",
        "After any smoke/release check, run npm run test:western-project-gate",
        "Then run npm run western:project-status",
        "Run npm run build if the release check touches UI/server code",
      ];
    }
    return [
      "Open data/experiments/western-strings-m3/confidence-validation-review/index.html",
      "After review, download/save controlled-candidate-review.completed.csv in that folder",
      "Run npm run western:controlled-candidate-confidence-validation-eval",
      "Then run npm run western:project-status",
    ];
  }
  if (track === "M3+ pitch behavior modes") {
    if (hasReason(action, "m3plus-no-mode-specific-release-ready")) {
      return [
        "Keep all M3+ pitch-behavior modes review-only in student/runtime output.",
        "Inspect data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.csv for per-mode evidence.",
        "Open data/experiments/western-strings-m3plus/pitch-mode-review-pack-round2/index.html and review the 36 non-control supplemental samples.",
        "After review, save m3plus-pitch-mode-review.completed.csv in data/experiments/western-strings-m3plus/pitch-mode-review-pack-round2/.",
        "Import with npm run western:m3plus-review-import -- --source data/experiments/western-strings-m3plus/pitch-mode-review-pack-round2/m3plus-pitch-mode-review.csv --reviews data/experiments/western-strings-m3plus/pitch-mode-review-pack-round2/m3plus-pitch-mode-review.completed.csv",
        "After adding labels, rerun npm run western:m3plus-mode-eval",
        "Then run npm run western:project-status",
      ];
    }
    return [
      "Open data/experiments/western-strings-m3plus/pitch-mode-review-pack/index.html",
      "After review, save m3plus-pitch-mode-review.completed.csv in that folder",
      "Run npm run western:m3plus-review-import",
      "Then run npm run western:m3plus-review-status",
    ];
  }
  if (track === "M4 OMR benchmark") {
    return [
      "Prepare independent human-corrected gold MusicXML/MXL files listed in data/experiments/western-strings-m4/independent-gold-todo.md",
      "Run npm run western:m4-omr-benchmark",
      "Then run npm run western:project-status",
    ];
  }
  return ["Run npm run western:project-status after completing this item"];
}

export function renderHandoff(status) {
  const lines = [
    "# Western Strings Next Actions",
    "",
    `Generated: ${status.generatedAt}`,
    "",
    "## Runtime Gate",
    "",
    `- ordinaryUploadAutoFeedbackReady: ${Boolean(status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady)}`,
    `- m3plusAutoFeedbackReady: ${Boolean(status.runtimeStudentGate?.m3plusAutoFeedbackReady)}`,
    `- m4OmrAutoScoreReady: ${Boolean(status.runtimeStudentGate?.m4OmrAutoScoreReady)}`,
    `- policy: ${status.runtimeStudentGate?.policy || "unknown"}`,
    "",
    "## Priority Queue",
    "",
  ];
  for (const action of status.nextActions || []) {
    lines.push(
      `### P${action.priority}: ${action.track}`,
      "",
      `Artifact: ${action.artifact || "none"}`,
      "",
      "Why blocked:",
      bulletList(action.reason),
      "",
      "Do next:",
      `- ${action.action}`,
      "",
      "Commands:",
      bulletList(commandForAction(action)),
      "",
    );
  }
  lines.push(
    "## Notes",
    "",
    "- This file is a handoff checklist only. It does not change any runtime gate.",
    "- Do not treat eval-only pilot results as student-safe until the fresh blind validation path passes.",
    "- `uncertain` review rows are recorded but excluded from scored precision denominators.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await buildProjectStatus();
  await writeProjectStatus(status, args.statusOut);
  const outPath = path.resolve(process.cwd(), args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, renderHandoff(status), "utf8");
  console.log(JSON.stringify({
    ok: true,
    out: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
    nextActions: (status.nextActions || []).map((item) => ({
      priority: item.priority,
      track: item.track,
      artifact: item.artifact,
      reason: item.reason,
    })),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
