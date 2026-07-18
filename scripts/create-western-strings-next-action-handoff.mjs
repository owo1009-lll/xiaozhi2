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
  if (track === "Ordinary dynamic shadow runtime") {
    return [
      "Run npm run western:ordinary-dynamic-shadow-runtime-setup",
      "Run npm run western:ordinary-dynamic-shadow-runtime-preflight",
      "Run npm run test:western-ordinary-audio-runtime",
      "Keep all ordinary student-facing and automatic-adoption flags false",
    ];
  }
  if (track === "Ordinary dynamic shadow r3 evidence verifier") {
    return [
      "Implement the live source-artifact reread and rehash verifier before using r3-02/r3-03",
      "Add forged-report and artifact-tamper rejection tests",
      "Run npm run test:western-project-gate",
      "Run npm run western:project-status",
    ];
  }
  if (track === "Ordinary dynamic shadow r3 acceptance") {
    return [
      "Confirm liveArtifactVerifierReady=true before using either reserve take",
      "Run r3-02 and r3-03 once each with cold and warm cache verification",
      "Audit the complete candidate rows and bound source hashes",
      "Keep all results review-only; do not treat acceptance as release authorization",
    ];
  }
  if (track === "Ordinary dynamic shadow authorization") {
    return [
      "Prepare a separate fresh-blind authorization contract with new recordings and pieces",
      "Do not reuse RF, first-measure, or r3 acceptance evidence",
      "Keep production/default runtime fail-closed",
    ];
  }
  if (track === "M2/M3 ordinary upload candidate gate") {
    if (hasReason(action, "ordinary-rf-monitored-pilot-authorization-superseded")) {
      return [
        "Do not run or approve the historical RF monitored-pilot path",
        "Use the ordinary dynamic-shadow status and its live r3 verifier as the current entrypoint",
        "Keep production/default runtime fail-closed",
      ];
    }
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
    if (
      hasReason(action, "ordinary-confidence-runtime-selected-too-low")
      || hasReason(action, "ordinary-confidence-runtime-pitch-support-unmeasured")
      || hasReason(action, "ordinary-confidence-runtime-precision-too-low")
    ) {
      return [
        "Keep production/default runtime fail-closed.",
        "Do not ask a teacher to review another ordinary-upload auto-pass pack yet.",
        "Inspect data/experiments/western-strings-m3/confidence-validation-review/ordinary-confidence-release-audit.json.",
        "The confidence-only threshold pool is historical evidence only; current runtime auto_pass also requires pitchSupportWithin80Cents=true.",
        "Current runtime-policy evidence has too few/no safe selected rows, so the next step is candidate/pitch-support feature improvement, not human review.",
        "After changing candidate generation or pitch-support evidence, rerun npm run western:ordinary-auto-pass-precision-review-pack before involving a teacher.",
        "Only if that precheck generates self-checked rows should a teacher review pack be used.",
      ];
    }
    if (hasReason(action, "ordinary-auto-gate-disabled-by-default")) {
      return [
        "Keep production/default runtime fail-closed.",
        "P1.1 context validation and threshold-pool precision have passing evidence for candidate-evidence auto_pass. Pitch/onset/missing/duration/extra diagnosis categories remain review-only.",
        "Use npm run western:controlled-candidate-confidence-release-audit to inspect the frozen evidence before any pilot.",
        "Run npm run western:ordinary-monitored-pilot-audit. It runs the real-submission precision precheck, the temporary release-flag smoke, and the pilot plan in one command.",
        "The audit reuses known labels before asking for any teacher review. If it reports zero unknown review rows and zero known-wrong rows, no teacher review is needed for that check.",
        "If it reports known-wrong rows, stop and improve the candidate/confidence model. If it reports unknown review rows, review only those unknown rows.",
        "Use npm run western:ordinary-monitored-pilot-smoke, npm run western:ordinary-auto-pass-precision-review-pack, and npm run western:ordinary-monitored-pilot-plan only for debugging the individual layers.",
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
  if (track === "M3+ pitch safety rescope") {
    return [
      "Open data/experiments/western-strings-m3plus/rescope-gate/report.json.",
      "Confirm the report contract is m3plus-rescope-four-zone-v2 and inspect sourceBindings before reading any aggregate pass field.",
      "Treat the 8 policy-evaluated protected units separately from the 6 declared-only units; do not report 14 units as executed.",
      "Treat 3/8 only as score-intent center agreement/decision coverage. Join independent per-note intonation gold by recording/unit/note before computing precision; the current join is 0/8 and the 17 round2 vibrato units remain unscored.",
      "Run npm run western:m3plus-monitored-pilot-audit against the latest physical controlled batch. Keep offlineEvidenceReady, runtimeFoundationReady, runtimeAuditReady, authorization, and student readiness separate.",
      "Keep all M3+ output review_required with studentFacing=false and feedbackAuthorized=false; protected, low-voicing, high-dispersion, missing-field, or untrusted-window rows must fail closed.",
      "Do not reuse the superseded first-measure slide/trill pack as authorization evidence; any future release audit needs newly registered recordings and pieces.",
      "After any evidence/runtime change, rerun npm run western:m3plus-rescope-gate, create a fresh controlled queue batch bound to that report SHA, run npm run western:controlled-batch-candidate-audit, then rerun npm run western:m3plus-monitored-pilot-audit, npm run test:western-project-gate, and npm run build.",
    ];
  }
  if (track === "M3+ pitch behavior modes") {
    return [
      "Treat the historical pitch-mode packs and releaseReadyModes fields as research evidence only; the 2026-07-17 supersession removed their pilot authority.",
      "Use data/experiments/western-strings-m3plus/rescope-gate/report.json as the v2 evidence entrypoint and keep it fail-closed until all declared protected units are evaluated and independent per-note intonation gold is joined.",
      "Run npm run western:m3plus-monitored-pilot-audit against the latest physical controlled batch to verify the m3plus-gold-free-runtime-v1 contract.",
      "Keep m3plusAutoFeedbackReady=false, studentFacing=false, and feedbackAuthorized=false.",
      "For any future release evidence, register genuinely new recordings and pieces; do not reuse the first-measure slide/trill pack or the existing 12 recordings.",
    ];
  }
  if (track === "M4 OMR benchmark") {
    return [
      "Open data/experiments/western-strings-m4/independent-gold-todo.html",
      "This is NOT a teacher audio-diagnosis review. It is a score-editor independent-gold correction task.",
      "Run npm run western:m4-preflight first. It reruns all current M4 machine self-tests and writes data/experiments/western-strings-m4/m4-preflight.md.",
      "Inspect data/experiments/western-strings-m4/independent-gold-note-summary.md before manual editing; it summarizes the current editable MXL measures, notes, pitch range, and first notes so obvious machine-read problems are visible up front.",
      "For each row, compare the source score image/PDF with the current goldPath and Audiveris draftPath",
      "Run npm run western:m4-gold-provenance-audit first to prove whether current gold/editable files are still Audiveris self-comparisons and whether any independent clean-score candidate already exists",
      "Run npm run western:m4-independent-gold-workspace to create editable copies under data/private/western-strings-m4-independent-gold/",
      "Run npm run western:m4-independent-gold-workspace-audit to inspect missing files, changed-but-unapproved files, approved-but-unchanged files, and apply-ready rows",
      "Edit those workspace MXL files against the source score until they are independent human-corrected gold, not copies of the Audiveris draft",
      "Set reviewStatus=approved in data/experiments/western-strings-m4/independent-gold-workspace.csv only for rows that were checked against the source score",
      "Rerun npm run western:m4-independent-gold-workspace-audit and confirm readyToApplyRows is the intended set",
      "Run npm run western:m4-apply-independent-gold-workspace -- --dry-run to verify only changed and approved files would apply",
      "Run npm run western:m4-apply-independent-gold-workspace to update clean-score-intake for changed and approved files",
      "Run npm run western:m4-omr-benchmark",
      "Then run npm run western:project-status",
    ];
  }
  if (track === "Release review") {
    return [
      "Run npm run western:release-review.",
      "Open data/experiments/western-strings-release-review.md.",
      "If readyForControlledPilot=true, the evidence supports a separate monitored pilot; keep default production/student runtime fail-closed.",
      "Do not commit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1 or enable it globally.",
      "If readyForDefaultStudentRelease=false, treat that as expected unless an explicit monitored-pilot process has been approved.",
      "After any runtime/pilot wiring change, rerun npm run western:release-review, npm run test:western-project-gate, and npm run build.",
    ];
  }
  if (track === "Controlled pilot decision") {
    return [
      "Run npm run western:controlled-pilot-decision.",
      "Open data/experiments/western-strings-controlled-pilot-decision.md.",
      "Do not ask for more teacher/professional review unless the decision packet reports unknown or unsafe auto-pass rows.",
      "Confirm both approved tracks and the current ordinary dynamic-shadow + M3+ four-zone v2 scope contract in writing before starting any runtime process; no historical first-measure M3+ subset is eligible.",
      "Keep production/default runtime fail-closed.",
      "Do not commit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1 or enable it globally.",
      "If a pilot is approved, start it as a separate monitored process and rerun npm run western:release-review after any code or runtime wiring change.",
      "If no pilot is approved, stop here; the system has completed machine self-tests and remains safely review-only by default.",
    ];
  }
  if (track === "Controlled pilot approval") {
    return [
      "Open data/experiments/western-strings-controlled-pilot-decision.md.",
      "No teacher/professional review is needed at this step; the machine checks are already complete.",
      "Optionally run npm run western:controlled-pilot-approval-template to generate a non-approving template.",
      "To stop safely in review-only mode, run npm run western:controlled-pilot-record-decision -- --decision defer --by <owner-name>.",
      "Only if both current tracks are independently ready and the owner explicitly approves the monitored pilot, run npm run western:controlled-pilot-record-decision -- --decision approve --by <owner-name> --tracks ordinary,m3plus --confirm-separate-monitored-pilot --confirm-default-runtime-fail-closed.",
      "Keep production/default runtime fail-closed.",
      "Do not commit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1 or enable it globally.",
    ];
  }
  if (track === "Controlled pilot deferred") {
    return [
      "Open data/experiments/western-strings-controlled-pilot-decision.md.",
      "No teacher/professional review is needed for this release decision.",
      "Keep production/default runtime fail-closed and review-only.",
      "To revisit later, remove or update data/experiments/western-strings-controlled-pilot-approval.json and rerun npm run western:controlled-pilot-decision.",
    ];
  }
  if (track === "Start monitored pilot") {
    return [
      "Open data/experiments/western-strings-controlled-pilot-decision.md.",
      "Run npm run western:controlled-pilot-start-preflight immediately before starting the pilot.",
      "Run npm run western:controlled-pilot-run -- --execute --limit 1 for one approved offline monitored batch.",
      "The command must exit after the batch, restore its process environment, and write a session report under data/experiments/western-strings-controlled-pilot-sessions/.",
      "Keep production/default runtime fail-closed.",
      "After pilot wiring, rerun npm run western:release-review, npm run western:controlled-pilot-decision, npm run test:western-project-gate, and npm run build.",
    ];
  }
  if (track === "Controlled pilot coverage audit") {
    return [
      "Do not ask a teacher or professional reviewer for another pack yet.",
      "Run npm run western:controlled-pilot-evidence-audit.",
      "Open data/experiments/western-strings-controlled-pilot-evidence-audit.md.",
      "Keep all model auto-pass rows that fail strict self-check suppressed as review_required.",
      "Improve candidate/localization evidence or the machine self-check, then rerun the audit.",
      "Only after machinePreflightPassed=true and teacherReviewAllowed=true should one small fresh blind professional audit pack be generated.",
      "Keep production/default student runtime fail-closed throughout.",
    ];
  }
  if (track === "Scoped V2-alpha blind audit preparation") {
    return [
      "Stop: the current ordinary-dynamic-shadow-full-score-fresh-blind-v1 intake runner and audit contract are not implemented.",
      "Do not run the legacy first-measure V2-alpha intake stage/status commands or treat their ready result as current release evidence.",
      "Do not reuse existing recordings, pieces, r3 acceptance evidence, or historical first-measure intake artifacts.",
      "Implement and test a separate full-score fresh-blind intake runner before staging any new recording or generating a professional-review pack.",
      "Keep production/default student runtime fail-closed.",
    ];
  }
  if (track === "Fresh blind machine precheck") {
    return [
      "Stop: this handoff track belongs to the superseded first-measure intake path and has no current release authority.",
      "Do not use the historical V2-alpha intake report or its ready result to stage a candidate or start a machine precheck.",
      "The ordinary-dynamic-shadow-full-score-fresh-blind-v1 intake runner and audit contract are not implemented; wait for both to be implemented and tested.",
      "Keep production/default student runtime fail-closed.",
    ];
  }
  if (track === "Controlled pilot completed") {
    return [
      "Open the completed controlled-pilot session report listed above.",
      "Do not rerun the same recording as new evidence.",
      "Keep production/default student runtime fail-closed; this one-shot result does not authorize default release.",
      "Before expanding the pilot, add or select a new independently accepted submission and rerun the release review.",
      "Teacher/professional review is needed only if a future session reports unknown or known-wrong auto-pass rows.",
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
      action.humanTask ? `Human task: ${action.humanTask}` : "",
      action.teacherReviewNeeded === false ? "Teacher audio review needed: false" : "",
      action.humanTask || action.teacherReviewNeeded === false ? "" : "",
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
      action: item.action,
      artifact: item.artifact,
      humanTask: item.humanTask,
      teacherReviewNeeded: item.teacherReviewNeeded,
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
