import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { evaluateProjectGate } from "./gate-western-strings-project.mjs";
import { renderHandoff } from "./create-western-strings-next-action-handoff.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const status = await buildProjectStatus();

assert.equal(status.runtimeStudentGate.policy, "fail-closed", "student runtime gate must remain fail-closed");
assert.equal(status.reviewPolicy?.rule, "machine-self-test-before-human-review", "project status must expose the review policy");
assert.equal(status.reviewPolicy?.source, "docs/western-strings-review-policy.md", "project status must point to the review policy document");
assert.equal(status.runtimeStudentGate.ordinaryUploadAutoFeedbackReady, false, "ordinary upload must not auto-feedback before release gate");
assert.equal(status.runtimeStudentGate.m3plusAutoFeedbackReady, false, "M3+ mode feedback must stay disabled before labels are ready");
assert.equal(status.runtimeStudentGate.m4OmrAutoScoreReady, false, "M4 OMR auto score must stay disabled before independent gold");

assert(status.tracks?.controlledCandidate, "project status must include ordinary upload candidate track");
assert(status.tracks?.m3plusPitchModes, "project status must include M3+ pitch-mode track");
assert(status.tracks?.m4Omr, "project status must include M4 OMR track");

const m3plus = status.tracks.m3plusPitchModes;
assert.equal(m3plus.m3plusModeEvalReady, true, "M3+ review labels should be sufficient for offline mode evaluation");
assert.equal(m3plus.m3plusModeReleaseReady, true, "M3+ should report mode-specific release evidence after the first-measure candidate-quality review passes");
assert(m3plus.modeEval?.controlReadyModes?.includes("stable"), "stable should be reported as a control-ready mode");
assert.deepEqual(m3plus.modeEval?.releaseReadyModes || [], ["slide-like", "trill-like"], "slide-like and trill-like should be reported as release-ready offline modes");
assert.equal(m3plus.localizationDiagnosis?.sourceExists, true, "M3+ localization diagnosis should be generated after round-2 import");
assert.equal(m3plus.localizationDiagnosis?.summary?.nonMatch, 24, "M3+ localization diagnosis should expose the current non-match row count");
assert.deepEqual(m3plus.blockingReasons || [], [], "M3+ offline mode evidence should no longer ask for more review after the safe first-measure pack is imported");
if (m3plus.monitoredPilotAudit?.sourceExists) {
  assert.equal(m3plus.monitoredPilotAudit.readyForMonitoredPilot, true, "M3+ monitored pilot audit should pass before the handoff moves on");
  assert.equal(m3plus.monitoredPilotAudit.teacherReviewNeeded, false, "M3+ monitored pilot audit must not ask for more review when all auto-pass evidence is already known");
  assert.equal(m3plus.monitoredPilotAudit.defaultM3PlusReadyAfter, false, "M3+ monitored pilot audit must keep default runtime disabled");
  assert.deepEqual(Object.keys(m3plus.monitoredPilotAudit.releaseModes || {}), ["slide-like", "trill-like"], "M3+ pilot audit should only expose slide/trill release modes");
  assert((m3plus.monitoredPilotAudit.blockedModes || []).includes("variable-f0"), "unsafe variable-f0 must remain blocked by the M3+ audit");
}

const controlled = status.tracks.controlledCandidate;
assert.equal(controlled.studentSafeCandidateGateReady, false, "ordinary upload must still require blind validation");
assert.equal(controlled.confidencePilot?.releaseCandidateFound, true, "confidence pilot should report release candidates");
assert.equal(controlled.confidencePilot?.readyForStudentGate, false, "eval-only confidence pilot must not mark runtime gate ready");
assert.equal(controlled.confidencePilot?.validationEval?.readyForRuntimeGate, false, "validation eval must not enable runtime gate");
if (controlled.confidencePilot?.validationEval?.blindValidationPassed) {
  assert.equal(controlled.confidencePilot?.needsBlindValidation, false, "passed blind validation should clear needsBlindValidation");
  assert.equal(controlled.confidencePilot?.runtimeGateWired, true, "passed blind validation should expose the wired runtime release manifest");
  assert(
    controlled.blockingReasons.includes("ordinary-auto-gate-disabled-by-default"),
    "wired runtime gate must still block until the explicit release flag is enabled",
  );
} else {
  assert.equal(controlled.confidencePilot?.needsBlindValidation, true, "confidence pilot should still track that the old v1 candidate did not pass the full release process");
  if (controlled.confidenceRecalibration?.validationFailed) {
    assert.equal(controlled.confidenceRecalibration.needsBlindValidation, false, "failed recalibration validation should not ask for the same blind review again");
    assert.equal(
      controlled.confidenceRecalibration.failureDiagnosis?.summary?.selectedWrongRows,
      2,
      "failed recalibration validation should expose the selected false-positive count",
    );
    if (controlled.confidenceRecalibration?.contextValidation?.needsBlindValidation) {
      assert(
        controlled.blockingReasons.includes("ordinary-confidence-recalibration-context-validation-needed"),
        "ordinary upload should route to the fresh context recalibration blind-validation pack when it exists",
      );
    } else {
      assert(
        controlled.blockingReasons.includes("ordinary-confidence-recalibration-validation-failed"),
        "ordinary upload should block on the failed recalibration blind-validation result",
      );
    }
  } else {
    assert(
      controlled.blockingReasons.includes("candidate-confidence-pilot-needs-blind-validation"),
      "ordinary upload should block on blind validation before eval passes",
    );
  }
}
assert(controlled.confidencePilot?.bestReleaseCandidate, "confidence pilot should report the best release candidate");
assert.equal(controlled.confidencePilot.bestReleaseCandidate.featureSet, "deployable", "confidence pilot should report the deployable candidate");
assert.equal(controlled.confidencePilot.bestReleaseCandidate.groupBy, "recordingId", "confidence pilot should report the strict leave-one-recording candidate");
const ordinaryPilotAuditPassed = controlled.confidencePilot?.monitoredPilotAudit?.readyForMonitoredPilot === true
  && controlled.confidencePilot?.monitoredPilotAudit?.teacherReviewNeeded === false
  && controlled.confidencePilot?.monitoredPilotAudit?.defaultOrdinaryReadyAfter === false;
const m3plusPilotAuditPassed = m3plus.monitoredPilotAudit?.readyForMonitoredPilot === true
  && m3plus.monitoredPilotAudit?.teacherReviewNeeded === false
  && m3plus.monitoredPilotAudit?.defaultM3PlusReadyAfter === false;
if (ordinaryPilotAuditPassed && m3plusPilotAuditPassed) {
  assert(
    status.releaseReview?.readyForControlledPilot
      ? ["Controlled pilot decision", "Controlled pilot approval", "Controlled pilot deferred", "Start monitored pilot", "Controlled pilot coverage audit", "Scoped V2-alpha blind audit preparation", "Controlled pilot completed"].includes(status.nextActions[0]?.track)
      : status.nextActions[0]?.track === "Release review",
    "after ordinary, M3+, and M4 machine checks pass, handoff should move to release review or controlled pilot decision while runtime stays fail-closed",
  );
} else if (ordinaryPilotAuditPassed) {
  assert.equal(
    status.nextActions[0]?.track,
    "M3+ pitch behavior modes",
    "after ordinary pilot audit passes, handoff should move to the next unfinished track while release stays fail-closed",
  );
} else {
  assert(
    status.nextActions[0]?.action.includes("confidence-threshold-pool-review/index.html")
    || status.nextActions[0]?.action.includes("threshold-pool review failed")
    || status.nextActions[0]?.action.includes("Threshold-pool precision passed")
    || status.nextActions[0]?.action.includes("separate monitored pilot plan")
    || status.nextActions[0]?.action.includes("recalibration blind-validation pack")
    || status.nextActions[0]?.action.includes("context-feature confidence recalibration pack")
    || status.nextActions[0]?.action.includes("improve candidate/pitch-support evidence")
    || status.nextActions[0]?.action.includes("wire a runtime gate")
    || status.nextActions[0]?.action.includes("runtime gate is wired")
    || status.nextActions[0]?.action.includes("ordinary-monitored-pilot-audit"),
    "project next action should route to threshold-pool review, recalibration, runtime wiring, pitch-support improvement, or explicit release-flag gating",
  );
}
const expectedOrdinaryArtifact = status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-context-validation-needed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/index.html"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-context-validation-failed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/confidence-recalibration-context-validation-eval.json"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-context-runtime-not-wired")
  ? "data/experiments/western-strings-m3/confidence-recalibration-context-validation-review/confidence-recalibration-context-validation-eval.json"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-validation-needed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-validation-review/index.html"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-recalibration-validation-failed")
  ? "data/experiments/western-strings-m3/confidence-recalibration-validation-review/confidence-recalibration-failure-diagnosis.json"
  : status.tracks.controlledCandidate.blockingReasons.includes("ordinary-confidence-threshold-pool-precision-too-low")
  ? "data/experiments/western-strings-m3/confidence-threshold-pool-review/confidence-threshold-pool-diagnosis.json"
  : "data/experiments/western-strings-m3/confidence-validation-review/ordinary-confidence-release-audit.json";
if (ordinaryPilotAuditPassed && m3plusPilotAuditPassed) {
  const nextArtifact = status.nextActions[0]?.artifact || "";
  assert(
    [
      "data/experiments/western-strings-release-review.md",
      "data/experiments/western-strings-controlled-pilot-decision.md",
      "data/experiments/western-strings-controlled-pilot-evidence-audit.md",
    ].includes(nextArtifact)
      || (nextArtifact.startsWith("data/experiments/western-strings-controlled-pilot-sessions/")
        && nextArtifact.endsWith("/session.md")),
    "after machine checks pass, handoff should point to release/decision evidence or the completed pilot session",
  );
} else if (ordinaryPilotAuditPassed) {
  assert.equal(
    status.nextActions[0]?.artifact,
    "data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.json",
    "after ordinary pilot audit passes, handoff artifact should point to the next unfinished track",
  );
} else {
  assert.equal(status.nextActions[0]?.artifact, expectedOrdinaryArtifact, "project artifact should point to the current ordinary-gate evidence artifact");
}

const m4 = status.tracks.m4Omr;
assert.equal(m4.m4OmrBenchmarkDatasetReady, true, "M4 intake dataset should be ready for benchmarking");
assert.equal(m4.m4OmrDraftQualityReady, true, "M4 draft quality may be ready when same-hash gold has explicit clean-score approval");
assert.equal(m4.teacherReviewNeeded, false, "M4 independent-gold correction must not be reported as teacher audio review");
assert.equal(
  m4.humanTask,
  "none",
  "M4 should not ask for a score-editor task when all unchanged drafts have clean-score approval",
);
assert.equal(
  m4.independentGoldWorkspaceAudit?.source,
  "data/experiments/western-strings-m4/independent-gold-workspace-audit.json",
  "M4 should expose the independent-gold workspace audit artifact",
);
assert.equal(
  m4.goldProvenanceAudit?.source,
  "data/experiments/western-strings-m4/gold-provenance-audit.json",
  "M4 should expose the gold provenance audit artifact",
);
if (!m4.goldProvenanceAudit?.missing) {
  assert.equal(m4.goldProvenanceAudit.teacherReviewNeeded, false, "M4 provenance audit must not ask for teacher audio review");
  assert.equal(
    m4.goldProvenanceAudit.humanTask,
    "none",
    "M4 provenance audit should clear the score-editor task when clean-score approval already exists",
  );
  assert.equal(
    m4.goldProvenanceAudit.counts?.manualGoldRequiredRows,
    0,
    "current M4 fixture should not require score-editor gold after clean-score approval is recognized",
  );
  assert.equal(
    m4.goldProvenanceAudit.counts?.humanApprovedUnchangedDraftRows,
    12,
    "current M4 fixture should expose human-approved unchanged draft rows",
  );
  assert.equal(
    m4.goldProvenanceAudit.counts?.independentCandidateRows,
    0,
    "current M4 fixture should not pretend there are independent clean-score candidates",
  );
}
assert.equal(
  m4.independentGoldWorkspaceAudit?.readyForApply,
  false,
  "M4 independent-gold workspace must not be apply-ready before checked score edits",
);
assert.equal(m4.counts.usableBenchmarkRows, 12, "human-approved unchanged gold rows should count as usable OMR benchmark rows");
assert.equal(m4.counts.humanApprovedUnchangedRows, 12, "current M4 fixture should expose all human-approved unchanged rows");
assert.equal(m4.counts.selfComparisonRows, 0, "approved unchanged rows must not be reported as unverified self-comparisons");
assert(!m4.blockingReasons.includes("m4-omr-self-comparison-detected"), "M4 must not block human-approved unchanged rows as self-comparison");
assert(!m4.blockingReasons.includes("m4-omr-no-independent-gold"), "M4 must not block when human-approved unchanged gold is usable");
assert.equal(
  m4.artifacts.independentGoldTodoHtml,
  "data/experiments/western-strings-m4/independent-gold-todo.html",
  "M4 handoff should expose the visual independent-gold checklist",
);
if (ordinaryPilotAuditPassed && m3plusPilotAuditPassed) {
  assert(
    status.releaseReview?.readyForControlledPilot
      ? ["Controlled pilot decision", "Controlled pilot approval", "Controlled pilot deferred", "Start monitored pilot", "Controlled pilot coverage audit", "Scoped V2-alpha blind audit preparation", "Controlled pilot completed"].includes(status.nextActions[0]?.track)
      : status.nextActions[0]?.track === "Release review",
    "M4 should no longer produce a human-task next action after clean-score approval is recognized",
  );
}

const m4ChecklistHtml = await fs.readFile("data/experiments/western-strings-m4/independent-gold-todo.html", "utf8");
const m4ChecklistMd = await fs.readFile("data/experiments/western-strings-m4/independent-gold-todo.md", "utf8");
const reviewPolicy = await fs.readFile("docs/western-strings-review-policy.md", "utf8");
const projectPlan = await fs.readFile("docs/western-strings-project-plan.md", "utf8");
const migrationPlan = await fs.readFile("docs/western-strings-migration-plan.md", "utf8");
const releaseReviewSource = await fs.readFile("scripts/run-western-strings-release-review.mjs", "utf8");
const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
const handoff = renderHandoff(status);
assert(
  packageJson.scripts?.["western:m4-preflight"],
  "package.json must expose the aggregate M4 machine self-test command",
);
assert(
  packageJson.scripts?.["western:m4-independent-gold-note-summary"],
  "package.json must expose the M4 editable-gold note summary command",
);
assert(
  packageJson.scripts?.["western:release-review"],
  "package.json must expose the aggregate release-review command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-decision"],
  "package.json must expose the controlled-pilot decision command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-approval-template"],
  "package.json must expose a non-approving controlled-pilot approval template command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-record-decision"],
  "package.json must expose a controlled-pilot owner decision recorder command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-start-preflight"],
  "package.json must expose the controlled-pilot start preflight command",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-run"],
  "package.json must expose the one-shot controlled-pilot runner",
);
assert(
  packageJson.scripts?.["test:western-controlled-pilot-run"],
  "package.json must expose controlled-pilot runner tests",
);
assert(
  packageJson.scripts?.["western:controlled-pilot-evidence-audit"],
  "package.json must expose the machine-only controlled-pilot evidence audit",
);
assert(
  packageJson.scripts?.["test:western-controlled-pilot-evidence-audit"],
  "package.json must expose controlled-pilot evidence audit tests",
);
assert(
  releaseReviewSource.includes('"test:western-controlled-pilot-run"'),
  "release review must rerun the controlled-pilot runner safety tests before approval",
);
assert(
  releaseReviewSource.includes('"test:western-controlled-pilot-evidence-audit"')
    && releaseReviewSource.includes('"western:controlled-pilot-evidence-audit"'),
  "release review must refresh the machine-only evidence audit before any human handoff",
);
assert(
  packageJson.scripts?.["test:western-controlled-pilot-decision"],
  "package.json must expose controlled-pilot decision/preflight tests",
);
for (const [label, text] of [["review policy", reviewPolicy]]) {
  assert(
    text.includes("npm run western:m4-preflight"),
    `M4 ${label} must route through the aggregate machine self-test before manual score editing`,
  );
  assert(
    text.includes("note summary") || text.includes("note-summary"),
    `M4 ${label} must mention the machine note summary before manual score editing`,
  );
  assert(
    text.includes("npm run western:m4-gold-provenance-audit"),
    `M4 ${label} must require provenance self-test before manual score editing`,
  );
  assert(
    text.includes("npm run western:m4-independent-gold-workspace-audit"),
    `M4 ${label} must require workspace audit before apply`,
  );
}
if (m4.m4OmrDraftQualityReady) {
  assert(
    !handoff.includes("score-editor independent-gold correction task"),
    "current handoff must not keep stale M4 score-editor instructions after M4 clears",
  );
  assert(
    handoff.includes("npm run western:release-review")
      || handoff.includes("npm run western:controlled-pilot-decision")
      || handoff.includes("npm run western:controlled-pilot-approval-template")
      || handoff.includes("npm run western:controlled-pilot-start-preflight")
      || handoff.includes("Controlled pilot approval")
      || handoff.includes("Controlled pilot deferred")
      || handoff.includes("Start monitored pilot")
      || handoff.includes("Controlled pilot coverage audit")
      || handoff.includes("Scoped V2-alpha blind audit preparation")
      || handoff.includes("Controlled pilot completed"),
    "handoff must route through release-review or the controlled-pilot decision after M4 clears",
  );
  for (const [label, text] of [["project plan", projectPlan], ["migration plan", migrationPlan]]) {
    assert(
      !text.includes("`usableBenchmarkRows=0`,`selfComparisonRows=12`,`m4OmrDraftQualityReady=false`"),
      `${label} must not keep the obsolete unreviewed M4 self-comparison status after provenance clears`,
    );
    assert(
      !text.includes("下一步必须准备**独立人工校正的 gold score**"),
      `${label} must not send the user back to obsolete M4 manual-gold work after provenance clears`,
    );
  }
  assert(
    !projectPlan.includes("人工复核完成后将下载 CSV 保存为 `controlled-candidate-review.completed.csv`"),
    "project plan must not reassign the completed historical threshold-pool review",
  );
  assert(
    projectPlan.includes("历史失败,已被 P1.1 context-feature 重校准取代"),
    "project plan must distinguish the obsolete confidence-only failure from the current P1.1 release candidate",
  );
} else {
  assert(
    handoff.includes("npm run western:m4-preflight"),
    "M4 next-action handoff must route through preflight while M4 is blocked",
  );
}
for (const [label, text] of [["html", m4ChecklistHtml], ["markdown", m4ChecklistMd]]) {
  assert(
    text.includes("不是教师音频诊断复核"),
    `M4 ${label} checklist must make clear this is not teacher audio review in readable Chinese`,
  );
  assert(
    text.includes("机器") && text.includes("音符"),
    `M4 ${label} checklist must include the machine note-summary context`,
  );
  assert(
    text.includes("npm run western:m4-independent-gold-workspace-audit"),
    `M4 ${label} checklist must require the independent-gold workspace audit`,
  );
  assert(
    text.includes("npm run western:m4-gold-provenance-audit"),
    `M4 ${label} checklist must require provenance self-test before score editing`,
  );
  assert(
    text.includes("editableGoldPath"),
    `M4 ${label} checklist must point score editors at the editable gold path`,
  );
  assert(
    text.includes("reviewStatus"),
    `M4 ${label} checklist must explain the approved reviewStatus gate`,
  );
  assert(
    text.includes("--dry-run"),
    `M4 ${label} checklist must require dry-run before apply`,
  );
  assert(
    !text.includes("涓嶆槸") && !text.includes("鏈哄櫒") && !text.includes("闊崇"),
    `M4 ${label} checklist should not contain common mojibake characters`,
  );
}

const noRequiredGate = evaluateProjectGate(status, new Set());
assert.equal(noRequiredGate.projectReleaseReady, true, "empty required track set should not block");
assert.deepEqual(noRequiredGate.failures, [], "empty required track set should have no failures");

const fullGate = evaluateProjectGate(status, new Set(["ordinary", "m3plus", "m4"]));
assert.equal(fullGate.projectReleaseReady, false, "full project gate must block until all required tracks are ready");
assert(fullGate.failures.some((failure) => failure.track === "M2/M3 ordinary upload candidate gate"), "ordinary track failure should be reported");
assert.equal(
  fullGate.failures.find((failure) => failure.track === "M2/M3 ordinary upload candidate gate")?.artifact,
  expectedOrdinaryArtifact,
  "ordinary gate failure should point to the current ordinary-gate evidence artifact",
);
const m3plusFailure = fullGate.failures.find((failure) => failure.track === "M3+ pitch behavior modes");
assert.equal(m3plusFailure, undefined, "M3+ should not be a project-gate failure after mode-specific offline evidence passes");
const m4Failure = fullGate.failures.find((failure) => failure.track === "M4 OMR benchmark");
assert.equal(m4Failure, undefined, "M4 should not be a project-gate failure after clean-score approval is recognized");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "project-status-tracks-present",
    "student-runtime-fail-closed",
    "confidence-pilot-validation-state-covered",
    "m3plus-first-measure-mode-evidence-covered",
    "m4-human-approved-unchanged-gold-clears",
    "m4-checklist-human-readable",
    "handbook-current-status-does-not-reassign-completed-review",
    "project-gate-required-tracks-block-release",
  ],
}, null, 2));
