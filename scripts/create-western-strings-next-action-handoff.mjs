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
    if (hasReason(action, "ordinary-confidence-recalibration-context-validation-needed")) {
      return [
        "Keep production/default runtime fail-closed.",
        "Open data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/index.html and review the 30-row context-feature recalibration blind-validation pack.",
        "Either save the downloaded CSV as data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/controlled-candidate-review.completed.csv, or leave it in Downloads and run npm run western:ingest-review-downloads -- --apply.",
        "Run npm run western:controlled-candidate-confidence-recalibration-context-validation-eval.",
        "Then run npm run western:project-status and npm run test:western-project-gate.",
        "Only if the context validation passes should runtime wiring be considered; do not enable the student gate by default.",
      ];
    }
    if (hasReason(action, "ordinary-confidence-recalibration-context-validation-failed")) {
      return [
        "Keep production/default runtime fail-closed.",
        "Inspect data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/confidence-recalibration-context-validation-eval-rows.csv.",
        "The context-feature recalibration blind-validation pack failed; do not ask for the same review again.",
        "Improve candidate/localization quality or collect stronger calibration evidence before exporting another blind-validation pack.",
      ];
    }
    if (hasReason(action, "ordinary-confidence-recalibration-context-runtime-not-wired")) {
      return [
        "Keep production/default runtime fail-closed until a monitored release integration exists.",
        "Inspect data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/confidence-recalibration-context-validation-eval.json.",
        "Create a disabled-by-default runtime release manifest and smoke test before considering any student-facing flag.",
      ];
    }
    if (hasReason(action, "ordinary-confidence-recalibration-validation-needed")) {
      return [
        "Keep production/default runtime fail-closed.",
        "Open data/experiments/western-strings-m3/confidence-recalibration-validation-review/index.html and review the 10-row recalibration blind-validation pack.",
        "Either save the downloaded CSV as data/experiments/western-strings-m3/confidence-recalibration-validation-review/controlled-candidate-review.completed.csv, or leave it in Downloads and run npm run western:ingest-review-downloads -- --apply.",
        "Run npm run western:controlled-candidate-confidence-recalibration-validation-eval.",
        "Then run npm run western:project-status and npm run test:western-project-gate.",
        "Only if the recalibration blind validation passes should a new monitored pilot be considered; do not enable the student gate by default.",
      ];
    }
    if (hasReason(action, "ordinary-confidence-recalibration-validation-failed")) {
      return [
        "Keep production/default runtime fail-closed.",
        "Inspect data/experiments/western-strings-m3/confidence-recalibration-validation-review/confidence-recalibration-failure-diagnosis.json first, then the rows/groups CSV next to it.",
        "The current 10 selected rows all lack pitch support, and the false positives cluster in stu02-ex05-weak_onset.",
        "The 10-row recalibration blind-validation pack is already reviewed and failed the release floor; do not ask for the same review again.",
        "Do not only raise the threshold; improve deployable candidate/localization quality features or collect stronger calibration evidence before exporting another blind-validation pack.",
        "After any recalibration, rerun npm run western:controlled-candidate-confidence-recalibration-pilot, export a fresh blind-validation pack, and rerun npm run western:project-status.",
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
        "P1.1 context validation and threshold-pool precision have passed for the frozen RF scorer at threshold 0.8, after excluding the documented score-audio mismatch source.",
        "Use npm run western:controlled-candidate-confidence-release-audit to inspect the frozen evidence before any pilot.",
        "Run npm run western:ordinary-monitored-pilot-plan to generate the disabled-by-default pilot plan artifact.",
        "Run npm run western:ordinary-monitored-pilot-smoke to verify the frozen RF scorer under the release flag inside a temporary repo root.",
        "Run npm run western:ordinary-auto-pass-precision-review-pack before asking for any teacher review. Runtime auto_pass now requires RF confidence plus pitchSupportWithin80Cents=true; if it reports zero self-checked rows, do not ask a teacher to review and instead improve candidate features/pitch-support evidence.",
        "Only consider WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1 inside a separate monitored controlled-pilot process.",
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
    if (hasReason(action, "m3plus-runtime-disabled-by-default")) {
      return [
        "Do not request more M3+ review for the current pack; the first-measure safe subset has already been imported and evaluated.",
        "Keep production/default runtime fail-closed: m3plusAutoFeedbackReady must remain false unless a separate monitored pilot is explicitly started.",
        "Inspect data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.json and confirm releaseReadyModes are slide-like and trill-like.",
        "If productizing, design a scoped pilot that only allows first-measure, trusted-recording, slide-like/trill-like rows; later measures and other modes must remain review_required.",
        "After any runtime pilot code change, run npm run test:western-project-gate, npm run western:project-status, and npm run build.",
      ];
    }
    if (hasReason(action, "m3plus-no-mode-specific-release-ready")) {
      if (String(action.action || "").includes("candidate-quality review pack")) {
        return [
          "Keep all M3+ pitch-behavior modes review-only in student/runtime output.",
          "Open data/experiments/western-strings-m3plus/pitch-mode-review-pack-candidate-quality/index.html and review the 24 candidate-quality rows.",
          "This pack is restricted to first-measure rows from recordings whose prior M3+ review rows were all audio-score matches. Later measures are excluded because their linear score-time windows drift.",
          "After review, save the downloaded CSV as data/experiments/western-strings-m3plus/pitch-mode-review-pack-candidate-quality/m3plus-pitch-mode-review.completed.csv, or leave it in Downloads and run npm run western:ingest-review-downloads -- --target m3plus-candidate-quality --apply.",
          "Import with npm run western:m3plus-review-import -- --source data/experiments/western-strings-m3plus/pitch-mode-review-pack-candidate-quality/m3plus-pitch-mode-review.csv --reviews data/experiments/western-strings-m3plus/pitch-mode-review-pack-candidate-quality/m3plus-pitch-mode-review.completed.csv",
          "Then rerun npm run western:m3plus-mode-eval, npm run western:m3plus-localization-diagnosis, and npm run western:project-status.",
        ];
      }
      if (String(action.action || "").includes("round-2 is imported")) {
        return [
          "Keep all M3+ pitch-behavior modes review-only in student/runtime output.",
          "Inspect data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-localization-diagnosis-groups.csv first; it identifies the recording/scenario/candidate-mode groups with the highest non-match rate.",
          "Use data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-localization-diagnosis-rows.csv to inspect the concrete mismatch/uncertain rows.",
          "Treat the current high mismatch/uncertain rate as a score-audio localization/candidate-quality blocker before any M3+ release attempt.",
          "Use data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.csv only after localization is improved; it explains per-mode precision but does not fix wrong score/audio windows.",
          "Improve score-audio localization or candidate generation, then create a fresh targeted eval pack instead of reusing the current round-2 pack.",
          "After any candidate-generation change, rerun npm run western:m3plus-pitch-modes, create a new review pack, import labels, then rerun npm run western:m3plus-mode-eval and npm run western:m3plus-localization-diagnosis.",
        ];
      }
      return [
        "Keep all M3+ pitch-behavior modes review-only in student/runtime output.",
        "Inspect data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.csv for per-mode evidence.",
        "Open data/experiments/western-strings-m3plus/pitch-mode-review-pack-round2/index.html and review the 36 non-control supplemental samples.",
        "After review, either save m3plus-pitch-mode-review.completed.csv in data/experiments/western-strings-m3plus/pitch-mode-review-pack-round2/, or leave it in Downloads and run npm run western:ingest-review-downloads -- --target m3plus-round2 --apply.",
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
      "Open data/experiments/western-strings-m4/independent-gold-todo.html",
      "For each row, compare the source score image/PDF with the current goldPath and Audiveris draftPath",
      "Run npm run western:m4-independent-gold-workspace to create editable copies under data/private/western-strings-m4-independent-gold/",
      "Edit those workspace MXL files against the source score until they are independent human-corrected gold, not copies of the Audiveris draft",
      "Run npm run western:m4-apply-independent-gold-workspace to update clean-score-intake for changed files",
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
