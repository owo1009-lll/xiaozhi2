#!/usr/bin/env node
// Tests for the ordinary dynamic-shadow full-score fresh-blind evidence
// evaluator: sanity checks against the real 2026-07-18 evidence run, then a
// synthetic fixture proving the evaluator refuses a marked-zone accusation
// and the live-artifact re-auditor rejects digest tampering and silent
// artifact drift.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLEAN_COVERAGE_FLOOR,
  FRESH_BLIND_CONTRACT,
  FRESH_BLIND_REPORT_RELATIVE_PATH,
  POLICY_C_CONTRACT,
  RHYTHM_CHANNEL_DIAGNOSTIC_CONTRACT,
  auditFreshBlindEvidence,
  auditFreshBlindEvidenceLiveArtifacts,
  evaluatePolicyCReviewAssist,
  evaluateRhythmChannelDiagnostic,
} from "./eval-western-ordinary-fresh-blind.mjs";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ---- sanity checks against the real 2026-07-18 evidence run ---------------
const realReportPath = path.resolve(FRESH_BLIND_REPORT_RELATIVE_PATH);
assert(fs.existsSync(realReportPath), "the real fresh-blind report must exist before this test runs (run npm run western:ordinary-fresh-blind-eval)");
const realReport = JSON.parse(fs.readFileSync(realReportPath, "utf8"));
assert.equal(realReport.contract, FRESH_BLIND_CONTRACT);
assert.equal(realReport.evidenceReady, true, `real report must be evidence-ready: ${JSON.stringify(realReport.blockingReasons)}`);
assert.equal(realReport.recordingCount, 8);
assert.deepEqual(realReport.tiers.cleanFull.recordingIds.sort(), ["r2fb-01-20260718", "r2fb-08-20260718"]);
assert.deepEqual(
  realReport.tiers.errorReferenceOnly.recordingIds.sort(),
  ["r2fb-02-20260718", "r2fb-03-20260718", "r2fb-04-20260718"],
);
assert.deepEqual(
  realReport.tiers.techniqueSafety.recordingIds.sort(),
  ["r2fb-05-20260718", "r2fb-06-20260718", "r2fb-07-20260718"],
);
assert.equal(realReport.tiers.errorReferenceOnly.groundTruthPrecision, false, "error-reference tier must never claim ground-truth precision");
assert.equal(realReport.tiers.techniqueSafety.totalMarkedZoneAccusations, 0, "no marked-zone row may carry an accusation");
for (const row of realReport.tiers.cleanFull.rows) {
  assert(row.shadowCoverage >= CLEAN_COVERAGE_FLOOR, `${row.recordingId} must clear the clean coverage floor`);
}
const realLiveAudit = auditFreshBlindEvidenceLiveArtifacts({});
assert.equal(realLiveAudit.ready, true, `live audit of the real report must pass: ${JSON.stringify(realLiveAudit.blockingReasons)}`);

// ---- Policy C exact frozen semantics ---------------------------------------
// Lock the approved Round-4 operating point without depending on private
// audio: 12 planted positions + 253 non-planted positions, two strict M3+
// issues, four assignment-gap hints, and three non-planted hints.
const policyRows = Array.from({ length: 265 }, (_, index) => ({
  measureIndex: index + 1,
  beatStart: 0,
  m3plusDecision: "confirmed_center",
  m3plusTimingAssignmentAvailable: true,
  relativeIoiDeviationRatio: 0.05,
}));
policyRows[0].m3plusDecision = "issue_detected";
policyRows[1].m3plusDecision = "issue_detected";
for (const index of [2, 3, 4, 5, 12, 13, 14]) {
  policyRows[index].m3plusDecision = "insufficient_evidence";
  policyRows[index].m3plusTimingAssignmentAvailable = false;
}
const policyTruthErrors = [
  ...[0, 1, 2].map((index) => ({ kind: "wrong", measure: index + 1, beat: 1 })),
  ...[3, 4, 5].map((index) => ({ kind: "missing", measure: index + 1, beat: 1 })),
  ...[6, 7, 8].map((index) => ({ kind: "extra", measure: index + 1, beat: 1 })),
  ...[9, 10, 11].map((index) => ({ kind: "drag", measure: index + 1, beat: 1 })),
];
const policyC = evaluatePolicyCReviewAssist({
  recordings: [{ recordingId: "round4-fixture", positionRows: policyRows }],
  positionTruth: { recordings: { "round4-fixture": { errors: policyTruthErrors } } },
});
assert.equal(policyC.contract, POLICY_C_CONTRACT);
assert.equal(policyC.planted.detected, 6);
assert.equal(policyC.planted.total, 12);
assert.equal(policyC.planted.strictConfirmed, 2);
assert.equal(policyC.planted.selfCheckHints, 4);
assert.equal(policyC.nonPlanted.total, 253);
assert.equal(policyC.nonPlanted.strictFalseAccusations, 0);
assert.equal(policyC.nonPlanted.selfCheckHints, 3);
assert.equal(policyC.reviewAssistGateReady, true);
assert.equal(policyC.autoAccusationPrecisionReady, false);
assert.equal(policyC.autoAccusationReady, false);
assert.equal(policyC.energyEvidence.waveformEnergyMeasured, false);
assert.equal(policyC.energyEvidence.energyRobustnessReady, false);
assert.equal(policyC.outputSemantics.self_check_hint.includes("may not accuse"), true);

const noisyPolicyRows = structuredClone(policyRows);
for (const index of [15, 16, 17]) {
  noisyPolicyRows[index].m3plusDecision = "insufficient_evidence";
  noisyPolicyRows[index].m3plusTimingAssignmentAvailable = false;
}
const noisyPolicyC = evaluatePolicyCReviewAssist({
  recordings: [{ recordingId: "round4-fixture", positionRows: noisyPolicyRows }],
  positionTruth: { recordings: { "round4-fixture": { errors: policyTruthErrors } } },
});
assert.equal(noisyPolicyC.reviewAssistGateReady, false, "Policy C must fail when hint false positives exceed 2%");

// The relative-IOI field is populated but a simple threshold cannot meet the
// joint precision/recall floor: five of six rhythm targets and 37 negatives
// cross the frozen 0.15 point.
for (const index of [6, 7, 8, 9, 10, ...Array.from({ length: 37 }, (_, offset) => offset + 12)]) {
  policyRows[index].relativeIoiDeviationRatio = 0.2;
}
policyRows[11].relativeIoiDeviationRatio = 0.1;
const rhythmDiagnostic = evaluateRhythmChannelDiagnostic({
  recordings: [{ recordingId: "round4-fixture", positionRows: policyRows }],
  positionTruth: { recordings: { "round4-fixture": { errors: policyTruthErrors } } },
});
assert.equal(rhythmDiagnostic.contract, RHYTHM_CHANNEL_DIAGNOSTIC_CONTRACT);
assert.equal(rhythmDiagnostic.sample.totalPositions, 265);
assert.equal(rhythmDiagnostic.sample.featureAvailablePositions, 265);
assert.equal(rhythmDiagnostic.sample.rhythmTargetTotal, 6);
assert.equal(rhythmDiagnostic.frozenOperatingPoint.truePositive, 5);
assert.equal(rhythmDiagnostic.frozenOperatingPoint.falsePositive, 37);
assert.equal(rhythmDiagnostic.jointFloorReady, false);
assert.equal(rhythmDiagnostic.reviewAssistReady, false);
assert.equal(rhythmDiagnostic.autoAccusationReady, false);
assert(rhythmDiagnostic.blockingReasons.includes("no-simple-relative-ioi-threshold-meets-joint-floor"));

// ---- synthetic fixture ------------------------------------------------------
function writeCandidateArtifact(root, relPath, { rows, gateOverrides = {} }) {
  const decisionCounts = {};
  const zoneCounts = {};
  for (const row of rows) {
    const evidence = row.m3plusPitchSafetyEvidence;
    decisionCounts[evidence.decision] = (decisionCounts[evidence.decision] || 0) + 1;
    zoneCounts[evidence.zone] = (zoneCounts[evidence.zone] || 0) + 1;
  }
  const payload = {
    candidateRows: rows,
    candidateGate: {
      studentSafeGateReady: false,
      studentFacing: false,
      autoPassCandidateCount: 0,
      energyVetoIncluded: false,
      causalEnergyStatus: "excluded-review-only",
      scoreProvenanceReady: true,
      scoreNoteIdentityReady: true,
      cacheProvenanceReady: true,
      m3plusPitchSafetyRuntime: {
        reviewOnlyRuntimeWired: true,
        contractReady: true,
        decisionCounts,
        zoneCounts,
      },
      ...gateOverrides,
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const absolute = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  return { relPath, sha256: sha256(bytes) };
}

function buildRow(index, { selected, zone = "stable_center", decision = "confirmed_center" }) {
  return {
    noteIndex: index,
    autoDecision: "review_required",
    studentFacing: false,
    dynamicShadowEvidence: { selected, pitchDistanceSemitones: selected ? 0 : null },
    m3plusPitchSafetyEvidence: { zone, decision },
  };
}

function cleanRows(count, selectedCount) {
  return Array.from({ length: count }, (_, index) => buildRow(index, { selected: index < selectedCount }));
}

function techniqueRows() {
  return [
    buildRow(0, { selected: true }),
    buildRow(1, { selected: false, zone: "score_marked_neutral", decision: "insufficient_evidence" }),
    buildRow(2, { selected: false, zone: "score_marked_neutral", decision: "insufficient_evidence" }),
  ];
}

function buildFixture(root) {
  const manifestRelative = path.join("data", "private", "test-fresh-blind", "manifest.csv");
  const analysisRelative = path.join("data", "experiments", "test-fresh-blind", "machine-analysis.json");
  const manifestCsv = [
    "recordingId,scenario,pieceId,scoreId",
    "fx-01,correct,piece-1,score-1",
    "fx-02,trill_vibrato,piece-2,score-2",
    "fx-03,fresh_blind_correct,piece-3,score-3",
  ].join("\n");
  fs.mkdirSync(path.join(root, path.dirname(manifestRelative)), { recursive: true });
  fs.writeFileSync(path.join(root, manifestRelative), `${manifestCsv}\n`, "utf8");

  const clean = writeCandidateArtifact(root, path.join("data", "candidates", "fx-01.json"), {
    rows: cleanRows(10, 5),
  });
  const technique = writeCandidateArtifact(root, path.join("data", "candidates", "fx-02.json"), {
    rows: techniqueRows(),
  });
  const clean2 = writeCandidateArtifact(root, path.join("data", "candidates", "fx-03.json"), {
    rows: cleanRows(10, 6),
  });

  const machineAnalysis = {
    ready: true,
    blockingReasons: [],
    items: [
      {
        recordingId: "fx-01",
        analysisStatus: "offline_feature_review_ready",
        offlineAnalysisProduced: true,
        autoDiagnosisIssued: false,
        studentFacing: false,
        candidateRowsPath: clean.relPath.replace(/\\/g, "/"),
      },
      {
        recordingId: "fx-02",
        analysisStatus: "offline_feature_review_ready",
        offlineAnalysisProduced: true,
        autoDiagnosisIssued: false,
        studentFacing: false,
        candidateRowsPath: technique.relPath.replace(/\\/g, "/"),
      },
      {
        recordingId: "fx-03",
        analysisStatus: "offline_feature_review_ready",
        offlineAnalysisProduced: true,
        autoDiagnosisIssued: false,
        studentFacing: false,
        candidateRowsPath: clean2.relPath.replace(/\\/g, "/"),
      },
    ],
  };
  fs.mkdirSync(path.join(root, path.dirname(analysisRelative)), { recursive: true });
  fs.writeFileSync(path.join(root, analysisRelative), `${JSON.stringify(machineAnalysis, null, 2)}\n`, "utf8");
  return { manifestRelative, analysisRelative, technique };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "western-fresh-blind-test-"));
try {
  const { manifestRelative, analysisRelative, technique } = buildFixture(root);

  // 1. A consistent green fixture passes and is honest about zero accusations.
  const green = auditFreshBlindEvidence({ repoRoot: root, manifestPath: manifestRelative, machineAnalysisPath: analysisRelative });
  assert.equal(green.evidenceReady, true, `green fixture must pass: ${JSON.stringify(green.blockingReasons)}`);
  assert.equal(green.tiers.techniqueSafety.totalMarkedZoneAccusations, 0);

  // 2. Write the report to disk, verify live-audit passes, then tamper the
  //    digest without recomputing content: must fail closed.
  const outAbsolute = path.join(root, FRESH_BLIND_REPORT_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(outAbsolute), { recursive: true });
  fs.writeFileSync(outAbsolute, `${JSON.stringify(green, null, 2)}\n`, "utf8");
  const liveGreen = auditFreshBlindEvidenceLiveArtifacts({ repoRoot: root });
  assert.equal(liveGreen.ready, true, `live audit of a fresh green report must pass: ${JSON.stringify(liveGreen.blockingReasons)}`);

  const digestTampered = structuredClone(green);
  digestTampered.recordingCount = 999;
  fs.writeFileSync(outAbsolute, `${JSON.stringify(digestTampered, null, 2)}\n`, "utf8");
  const digestTamperedAudit = auditFreshBlindEvidenceLiveArtifacts({ repoRoot: root });
  assert.equal(digestTamperedAudit.ready, false);
  assert(digestTamperedAudit.blockingReasons.includes("fresh-blind-report-evidence-digest-invalid"));

  // 3. A sophisticated forger recomputes the digest after tampering the
  //    stored claim: the live audit must still fail because recomputing
  //    from the physical artifacts no longer matches the stored content.
  const forgedDigestPayload = structuredClone(digestTampered);
  delete forgedDigestPayload.evidenceDigestSha256;
  delete forgedDigestPayload.generatedAt;
  const { sha256Canonical } = await import("./audit-western-ordinary-dynamic-shadow-acceptance.mjs");
  digestTampered.evidenceDigestSha256 = sha256Canonical(forgedDigestPayload);
  fs.writeFileSync(outAbsolute, `${JSON.stringify(digestTampered, null, 2)}\n`, "utf8");
  const recountForged = auditFreshBlindEvidenceLiveArtifacts({ repoRoot: root });
  assert.equal(recountForged.ready, false);
  assert(
    recountForged.blockingReasons.includes("fresh-blind-report-content-stale"),
    `forged recount must fail on content mismatch: ${recountForged.blockingReasons}`,
  );

  // 4. Restore the honest report, then tamper the underlying candidate
  //    artifact on disk to inject a marked-zone accusation: live audit must
  //    recompute this from the physical file and fail closed.
  fs.writeFileSync(outAbsolute, `${JSON.stringify(green, null, 2)}\n`, "utf8");
  const techniqueAbsolute = path.join(root, technique.relPath);
  const techniquePayload = JSON.parse(fs.readFileSync(techniqueAbsolute, "utf8"));
  techniquePayload.candidateRows[1].m3plusPitchSafetyEvidence.decision = "issue_detected";
  fs.writeFileSync(techniqueAbsolute, `${JSON.stringify(techniquePayload, null, 2)}\n`, "utf8");
  const accusationInjected = auditFreshBlindEvidenceLiveArtifacts({ repoRoot: root });
  assert.equal(accusationInjected.ready, false);
  assert(
    accusationInjected.blockingReasons.some((reason) => reason.includes("marked-zone-accusation")),
    `an injected marked-zone accusation must fail closed: ${accusationInjected.blockingReasons}`,
  );

  // 5. The base evaluator itself (not just the live re-auditor) must refuse
  //    to call evidenceReady=true when a marked-zone accusation exists,
  //    proving the guard is not only in the re-audit layer.
  const rejectedFresh = auditFreshBlindEvidence({ repoRoot: root, manifestPath: manifestRelative, machineAnalysisPath: analysisRelative });
  assert.equal(rejectedFresh.evidenceReady, false);
  assert(rejectedFresh.blockingReasons.some((reason) => reason.includes("marked-zone-accusation")));

  // 6. A clean-tier recording below the coverage floor fails closed.
  fs.writeFileSync(techniqueAbsolute, `${JSON.stringify(technique, null, 2)}\n`, "utf8");
  writeCandidateArtifact(root, path.join("data", "candidates", "fx-01.json"), { rows: cleanRows(10, 1) });
  const lowCoverage = auditFreshBlindEvidence({ repoRoot: root, manifestPath: manifestRelative, machineAnalysisPath: analysisRelative });
  assert.equal(lowCoverage.evidenceReady, false);
  assert(lowCoverage.blockingReasons.some((reason) => reason.startsWith("fresh-blind-clean-coverage-below-floor")));

  // 7. A missing recording from the manifest fails closed.
  writeCandidateArtifact(root, path.join("data", "candidates", "fx-01.json"), { rows: cleanRows(10, 5) });
  const truncatedAnalysis = JSON.parse(fs.readFileSync(path.join(root, analysisRelative), "utf8"));
  truncatedAnalysis.items = truncatedAnalysis.items.slice(0, 1);
  fs.writeFileSync(path.join(root, analysisRelative), `${JSON.stringify(truncatedAnalysis, null, 2)}\n`, "utf8");
  const truncated = auditFreshBlindEvidence({ repoRoot: root, manifestPath: manifestRelative, machineAnalysisPath: analysisRelative });
  assert.equal(truncated.evidenceReady, false);
  assert(truncated.blockingReasons.includes("fresh-blind-recording-set-mismatch"));

  console.log("ok - western ordinary fresh-blind evidence evaluator (real-report sanity, forgery rejection)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
