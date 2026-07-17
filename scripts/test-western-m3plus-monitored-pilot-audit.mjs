import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTRACT,
  RELEASE_ZONES,
  evaluateRescopeContract,
  runM3PlusMonitoredPilotAudit,
} from "./run-western-m3plus-monitored-pilot-audit.mjs";

function passingGate() {
  return {
    schemaVersion: 1,
    evalOnly: true,
    productionPolicyChanged: false,
    studentGateReady: false,
    studentFacing: false,
    releaseGateReady: true,
    blockingReasons: [],
    thresholds: {
      pitchToleranceCents: 50,
      minimumPrecision: 0.9,
      minimumStraightDecisions: 4,
      minimumTechniqueCenterDecisions: 2,
      evaluationSplit: "holdout-only",
    },
    zones: {
      unmarkedStraight: {
        gatePassed: true,
        decisionCount: 8,
        precision: 1,
        unsafeAccusationCount: 0,
        insufficientEvidenceCount: 4,
        decisionCoverage: 0.666667,
      },
      scoreMarkedNeutral: {
        gatePassed: true,
        totalProtectedCount: 14,
        accusationCount: 0,
        insufficientEvidenceCount: 14,
      },
      techniqueCenter: {
        gatePassed: true,
        decisionCount: 3,
        precision: 1,
        unsafeAccusationCount: 0,
        insufficientEvidenceCount: 5,
        decisionCoverage: 0.375,
      },
      unstableFailClosed: {
        gatePassed: true,
        testedCount: 3,
        accusationCount: 0,
        insufficientEvidenceCount: 3,
      },
      rhythmOnset: {
        gatePassed: null,
      },
    },
  };
}

const checks = [];
function check(name, condition) {
  assert(condition, name);
  checks.push(name);
}

const pass = evaluateRescopeContract(passingGate());
check("passing-gate-is-ready", pass.ready === true);
check("passing-gate-has-no-blockers", pass.blockingReasons.length === 0);
check("all-release-zones-ready", RELEASE_ZONES.every((zone) => pass.zones[zone]?.ready === true));
check("rhythm-onset-is-inherited-not-gated", pass.zones.rhythmOnset.ready === true
  && pass.zones.rhythmOnset.inherited === "inherits-m3-core-gate-unchanged");

const missing = evaluateRescopeContract(null);
check("missing-gate-fails-closed", missing.ready === false
  && missing.blockingReasons.includes("m3plus-rescope-gate-missing"));

const lowPrecision = passingGate();
lowPrecision.zones.unmarkedStraight.precision = 0.85;
const lowPrecisionResult = evaluateRescopeContract(lowPrecision);
check("straight-precision-below-floor-blocks", lowPrecisionResult.ready === false
  && lowPrecisionResult.blockingReasons.includes("m3plus-zone-not-ready:unmarkedStraight"));

const unsafeStraight = passingGate();
unsafeStraight.zones.unmarkedStraight.unsafeAccusationCount = 1;
check("straight-unsafe-accusation-blocks",
  evaluateRescopeContract(unsafeStraight).blockingReasons.includes("m3plus-zone-not-ready:unmarkedStraight"));

const markedAccusation = passingGate();
markedAccusation.zones.scoreMarkedNeutral.accusationCount = 1;
markedAccusation.zones.scoreMarkedNeutral.insufficientEvidenceCount = 13;
const markedResult = evaluateRescopeContract(markedAccusation);
check("score-marked-accusation-blocks", markedResult.ready === false
  && markedResult.blockingReasons.includes("m3plus-zone-not-ready:scoreMarkedNeutral"));

const centerTooFew = passingGate();
centerTooFew.zones.techniqueCenter.decisionCount = 1;
check("technique-center-below-decision-floor-blocks",
  evaluateRescopeContract(centerTooFew).blockingReasons.includes("m3plus-zone-not-ready:techniqueCenter"));

const unstableLeak = passingGate();
unstableLeak.zones.unstableFailClosed.insufficientEvidenceCount = 2;
check("unstable-case-leak-blocks",
  evaluateRescopeContract(unstableLeak).blockingReasons.includes("m3plus-zone-not-ready:unstableFailClosed"));

const rhythmRegressed = passingGate();
rhythmRegressed.zones.rhythmOnset.gatePassed = false;
check("rhythm-onset-regression-blocks",
  evaluateRescopeContract(rhythmRegressed).blockingReasons.includes("m3plus-zone-regressed:rhythmOnset"));

const notEvalOnly = passingGate();
notEvalOnly.evalOnly = false;
check("non-eval-only-gate-blocks",
  evaluateRescopeContract(notEvalOnly).blockingReasons.includes("m3plus-rescope-gate-not-eval-only"));

const studentOpen = passingGate();
studentOpen.studentGateReady = true;
check("student-gate-open-blocks",
  evaluateRescopeContract(studentOpen).blockingReasons.includes("m3plus-rescope-student-gate-not-fail-closed"));

const gateNotReady = passingGate();
gateNotReady.releaseGateReady = false;
gateNotReady.blockingReasons = ["m3plus-technique-center-decisions-below-floor"];
const gateNotReadyResult = evaluateRescopeContract(gateNotReady);
check("release-gate-not-ready-blocks", gateNotReadyResult.ready === false
  && gateNotReadyResult.blockingReasons.includes("m3plus-rescope-release-gate-not-ready")
  && gateNotReadyResult.blockingReasons.includes(
    "m3plus-rescope-gate-blocking:m3plus-technique-center-decisions-below-floor",
  ));

const looseTolerance = passingGate();
looseTolerance.thresholds.pitchToleranceCents = 80;
check("loose-pitch-tolerance-blocks",
  evaluateRescopeContract(looseTolerance).blockingReasons.includes("m3plus-threshold-tolerance-above-ceiling"));

const nonHoldout = passingGate();
nonHoldout.thresholds.evaluationSplit = "development";
check("non-holdout-split-blocks",
  evaluateRescopeContract(nonHoldout).blockingReasons.includes("m3plus-evaluation-split-not-holdout-only"));

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m3plus-pilot-audit-"));
try {
  const gatePath = path.join(tempRoot, "report.json");
  await fs.writeFile(gatePath, `${JSON.stringify(passingGate(), null, 2)}\n`, "utf8");
  const { report } = await runM3PlusMonitoredPilotAudit({
    outDir: path.join(tempRoot, "out"),
    rescopeGate: gatePath,
  });
  check("runner-passing-report-ok", report.ok === true && report.readyForMonitoredPilot === true);
  check("runner-contract-is-rescope", report.contract === CONTRACT);
  check("runner-never-claims-teacher-review-done", report.teacherReviewNeeded === false);
  check("runner-never-claims-default-ready", report.defaultM3PlusReadyAfter === false);
  check("runner-writes-audit-json",
    JSON.parse(await fs.readFile(path.join(tempRoot, "out", "m3plus-monitored-pilot-audit.json"), "utf8")).ok === true);

  const brokenPath = path.join(tempRoot, "broken.json");
  const broken = passingGate();
  broken.zones.scoreMarkedNeutral.accusationCount = 2;
  broken.zones.scoreMarkedNeutral.insufficientEvidenceCount = 12;
  await fs.writeFile(brokenPath, `${JSON.stringify(broken, null, 2)}\n`, "utf8");
  const failed = await runM3PlusMonitoredPilotAudit({
    outDir: path.join(tempRoot, "out-broken"),
    rescopeGate: brokenPath,
  });
  check("runner-blocked-report-not-ready", failed.report.ok === false
    && failed.report.readyForMonitoredPilot === false
    && failed.report.blockingReasons.includes("m3plus-zone-not-ready:scoreMarkedNeutral"));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, checks }, null, 2));
