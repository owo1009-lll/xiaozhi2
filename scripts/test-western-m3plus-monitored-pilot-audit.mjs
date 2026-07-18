import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTRACT,
  RELEASE_ZONES,
  RESCOPE_SCHEMA_VERSION,
  RUNTIME_CONTRACT,
  RUNTIME_POLICY_VERSION,
  REQUIRED_SOURCE_BINDING_PATHS,
  auditSourceBindings,
  evaluateRescopeContract,
  runM3PlusMonitoredPilotAudit,
} from "./run-western-m3plus-monitored-pilot-audit.mjs";

const POLICY_SHA = "a".repeat(64);
const checks = [];
const roots = [];

function check(name, condition) {
  assert(condition, name);
  checks.push(name);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function passingGate(sourceBindings = {}) {
  return {
    schemaVersion: RESCOPE_SCHEMA_VERSION,
    contract: CONTRACT,
    generatedAt: "2026-07-18T00:00:00.000Z",
    sourceBindingsReady: true,
    sourceBindings,
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
      expectedStraightUnitCount: 12,
      expectedTechniqueCenterUnitCount: 8,
      expectedProtectedUnitCount: 14,
      expectedRound2ProtectedUnitCount: 6,
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
        intonationGoldExpectedUnitCount: 12,
        intonationGoldObservedUnitCount: 12,
        intonationGoldJoinedUnitCount: 12,
        intonationGoldUnjoinedUnitCount: 0,
        intonationGoldExpectedDecisionCount: 8,
        intonationGoldJoinedDecisionCount: 8,
        intonationGoldUnjoinedDecisionCount: 0,
        intonationGoldAgreementCount: 8,
        intonationGoldDisagreementCount: 0,
        intonationGoldAgreementRate: 1,
        intonationGoldFalsePositiveCount: 0,
        intonationGoldDuplicateUnitCount: 0,
        goldJoinReady: true,
      },
      scoreMarkedNeutral: {
        gatePassed: true,
        evaluatedProtectedCount: 14,
        declaredOnlyProtectedCount: 0,
        expectedProtectedCount: 14,
        totalProtectedCount: 14,
        totalDeclaredOrEvaluatedCount: 14,
        protectedGoldExpectedUnitCount: 6,
        protectedGoldJoinedUnitCount: 6,
        protectedGoldDuplicateUnitCount: 0,
        protectedGoldInventoryReady: true,
        accusationCount: 0,
        insufficientEvidenceCount: 14,
      },
      techniqueCenter: {
        gatePassed: true,
        scoreIntentCenterAgreementCount: 3,
        scoreIntentIssueCount: 0,
        scoreIntentCenterAgreementRate: 1,
        intonationGoldExpectedUnitCount: 8,
        intonationGoldObservedUnitCount: 8,
        intonationGoldJoinedUnitCount: 8,
        intonationGoldUnjoinedUnitCount: 0,
        intonationGoldExpectedDecisionCount: 3,
        intonationGoldJoinedDecisionCount: 3,
        intonationGoldUnjoinedDecisionCount: 0,
        intonationGoldAgreementCount: 3,
        intonationGoldDisagreementCount: 0,
        intonationGoldAgreementRate: 1,
        goldJoinReady: true,
      },
      unstableFailClosed: {
        gatePassed: true,
        testedCount: 3,
        accusationCount: 0,
        insufficientEvidenceCount: 3,
      },
      rhythmOnset: {
        policy: "delegated-to-m3-core",
        changedByThisGate: false,
        m3CoreGateReady: true,
        onsetReady: true,
        gatePassed: true,
      },
    },
  };
}

function runtimeDescriptor(rescopeReportPath, rescopeReportSha256) {
  return {
    evaluationContract: CONTRACT,
    runtimeContract: RUNTIME_CONTRACT,
    policyVersion: RUNTIME_POLICY_VERSION,
    policySemanticSha256: POLICY_SHA,
    rescopeReportPath,
    rescopeReportSha256,
    reviewOnlyRuntimeWired: true,
    contractReady: true,
    reviewOnly: true,
    feedbackAuthorized: false,
    studentFacing: false,
    runtimeEvidenceReady: true,
  };
}

function evidence(zone, overrides = {}) {
  return {
    evaluationContract: CONTRACT,
    runtimeContract: RUNTIME_CONTRACT,
    policyVersion: RUNTIME_POLICY_VERSION,
    policySemanticSha256: POLICY_SHA,
    zone,
    decision: zone === "score_marked_neutral" ? "insufficient_evidence" : "confirmed_center",
    accusationIssued: false,
    ...overrides,
  };
}

function candidateRows() {
  return [
    {
      autoDecision: "review_required",
      gateDecision: "review_required",
      studentFacing: false,
      m3plusPitchSafetyEvidence: evidence("unmarked_straight"),
    },
    {
      autoDecision: "review_required",
      gateDecision: "review_required",
      studentFacing: false,
      m3plusPitchSafetyEvidence: evidence("score_marked_neutral"),
    },
    {
      autoDecision: "review_required",
      gateDecision: "review_required",
      studentFacing: false,
      m3plusPitchSafetyEvidence: evidence("unstable_fail_closed", {
        decision: "insufficient_evidence",
        dispersionGuardTriggered: true,
      }),
    },
  ];
}

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "m3plus-hardened-audit-"));
  roots.push(root);
  const sourceBindings = {};
  for (const [name, relativePath] of Object.entries(REQUIRED_SOURCE_BINDING_PATHS)) {
    const bytes = Buffer.from(`${JSON.stringify({ name, frozen: true })}\n`, "utf8");
    await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await fs.writeFile(path.join(root, relativePath), bytes);
    sourceBindings[name] = { path: relativePath, sha256: sha256(bytes) };
  }

  const rescopeReportPath = "data/rescope/report.json";
  const rescopeAbsolute = path.join(root, rescopeReportPath);
  await fs.mkdir(path.dirname(rescopeAbsolute), { recursive: true });
  const gate = passingGate(sourceBindings);
  const gateBytes = Buffer.from(`${JSON.stringify(gate, null, 2)}\n`, "utf8");
  await fs.writeFile(rescopeAbsolute, gateBytes);

  const runtime = runtimeDescriptor(rescopeReportPath, sha256(gateBytes));
  const gateObject = { m3plusPitchSafetyRuntime: runtime };
  const rows = candidateRows();
  const batchRunId = "batch-current";
  const submissionId = "submission-current";
  const candidateRowsPath = `data/experiments/western-strings-m3/offline-feature-candidates/${batchRunId}/${submissionId}.json`;
  const candidateAbsolute = path.join(root, candidateRowsPath);
  await fs.mkdir(path.dirname(candidateAbsolute), { recursive: true });
  const item = {
    kind: "clean-score",
    submissionId,
    analysisStatus: "offline_feature_review_ready",
    autoDiagnosisIssued: false,
    studentFacing: false,
    candidateRowCount: rows.length,
    candidateRowsPath,
    candidateRowsSha256: "",
    candidateGate: gateObject,
  };
  const run = { batchRunId, autoDiagnosisIssued: false, items: [item] };
  const batchRunsPath = "data/batch-runs.jsonl";
  const batchRunsAbsolute = path.join(root, batchRunsPath);
  await fs.mkdir(path.dirname(batchRunsAbsolute), { recursive: true });

  async function writeCandidateAndRuns(prefixRuns = []) {
    const artifact = {
      batchRunId,
      submissionId,
      rowCount: rows.length,
      candidateGate: item.candidateGate,
      candidateRows: rows,
    };
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await fs.writeFile(candidateAbsolute, bytes);
    item.candidateRowsSha256 = sha256(bytes);
    await fs.writeFile(
      batchRunsAbsolute,
      `${[...prefixRuns, run].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }

  async function writeGateAndRebind() {
    const bytes = Buffer.from(`${JSON.stringify(gate, null, 2)}\n`, "utf8");
    await fs.writeFile(rescopeAbsolute, bytes);
    runtime.rescopeReportSha256 = sha256(bytes);
    await writeCandidateAndRuns();
  }

  await writeCandidateAndRuns();
  return {
    root,
    sourceBindings,
    gate,
    runtime,
    rows,
    item,
    run,
    rescopeReportPath,
    rescopeAbsolute,
    batchRunsPath,
    batchRunsAbsolute,
    candidateAbsolute,
    writeCandidateAndRuns,
    writeGateAndRebind,
  };
}

const foundationCalls = [];
function passingOrdinaryAudit(runs, options) {
  foundationCalls.push({ runs, options });
  return {
    ok: true,
    runCount: 1,
    auditedRunMode: "latest",
    auditedBatchRunIds: [runs[0]?.batchRunId],
    featureReviewItemCount: 1,
    candidateRowCount: runs[0]?.items?.[0]?.candidateRowCount || 0,
    failures: [],
  };
}

async function runWorkspace(workspace, suffix, dependency = passingOrdinaryAudit) {
  return runM3PlusMonitoredPilotAudit({
    sourceRoot: workspace.root,
    outDir: `out-${suffix}`,
    rescopeGate: workspace.rescopeReportPath,
    batchRuns: workspace.batchRunsPath,
  }, { auditControlledBatchRuns: dependency });
}

try {
  const direct = evaluateRescopeContract(passingGate({}));
  check("schema2-four-zone-contract-ready", direct.ready === true);
  check("all-release-zones-ready", RELEASE_ZONES.every((zone) => direct.zones[zone]?.ready === true));
  const schemaOne = passingGate({});
  schemaOne.schemaVersion = 1;
  check("schema1-is-rejected", evaluateRescopeContract(schemaOne).blockingReasons.includes(
    "m3plus-rescope-schema-version-mismatch",
  ));
  const oldContract = passingGate({});
  oldContract.contract = "m3plus-rescope-four-zone-v1";
  check("v1-contract-is-rejected", evaluateRescopeContract(oldContract).blockingReasons.includes(
    "m3plus-rescope-contract-mismatch",
  ));
  const shrunkenProtectedInventory = passingGate({});
  shrunkenProtectedInventory.zones.scoreMarkedNeutral.evaluatedProtectedCount = 8;
  shrunkenProtectedInventory.zones.scoreMarkedNeutral.totalProtectedCount = 8;
  shrunkenProtectedInventory.zones.scoreMarkedNeutral.insufficientEvidenceCount = 8;
  check(
    "protected-inventory-cannot-shrink-to-green",
    evaluateRescopeContract(shrunkenProtectedInventory).zones.scoreMarkedNeutral.ready === false,
  );
  const missingStraightGold = passingGate({});
  missingStraightGold.zones.unmarkedStraight.goldJoinReady = false;
  missingStraightGold.zones.unmarkedStraight.intonationGoldJoinedUnitCount = 0;
  missingStraightGold.zones.unmarkedStraight.intonationGoldUnjoinedUnitCount = 12;
  check(
    "straight-independent-gold-is-required",
    evaluateRescopeContract(missingStraightGold).zones.unmarkedStraight.ready === false,
  );
  const shrunkenCenterGold = passingGate({});
  shrunkenCenterGold.zones.techniqueCenter.intonationGoldExpectedUnitCount = 3;
  shrunkenCenterGold.zones.techniqueCenter.intonationGoldObservedUnitCount = 3;
  shrunkenCenterGold.zones.techniqueCenter.intonationGoldJoinedUnitCount = 3;
  check(
    "center-gold-unit-inventory-cannot-shrink",
    evaluateRescopeContract(shrunkenCenterGold).zones.techniqueCenter.ready === false,
  );

  const baseline = await createWorkspace();
  const sourceAudit = await auditSourceBindings(baseline.gate, { sourceRoot: baseline.root });
  check("all-source-bindings-physically-hashed", sourceAudit.ready === true
    && Object.values(sourceAudit.bindings).every((binding) => binding.ready === true));
  const passed = await runWorkspace(baseline, "pass");
  check("offline-evidence-ready", passed.report.offlineEvidenceReady === true);
  check("runtime-foundation-ready", passed.report.runtimeFoundationReady === true);
  check("runtime-row-audit-ready", passed.report.runtimeAuditReady === true);
  check("all-three-layers-required-for-pilot", passed.report.readyForMonitoredPilot === true);
  check("default-runtime-remains-off", passed.report.defaultM3PlusReadyAfter === false);
  check("ordinary-foundation-audit-reused-on-full-latest-run", foundationCalls.at(-1)?.runs?.[0]?.items?.length === 1
    && foundationCalls.at(-1)?.options?.latestOnly === true
    && foundationCalls.at(-1)?.options?.requireFeatureReview === true);
  check("audit-json-written", JSON.parse(await fs.readFile(
    path.join(baseline.root, "out-pass", "m3plus-monitored-pilot-audit.json"),
    "utf8",
  )).runtimeAuditReady === true);

  const sourceTamper = await createWorkspace();
  await fs.writeFile(path.join(sourceTamper.root, sourceTamper.sourceBindings.humanGold.path), "tampered\n", "utf8");
  const sourceTampered = await runWorkspace(sourceTamper, "source-tamper");
  check("source-sha-tamper-blocks", sourceTampered.report.offlineEvidenceReady === false
    && sourceTampered.report.blockingReasons.includes("m3plus-rescope-source-binding-sha-mismatch:humanGold"));

  const sourcePathSubstitution = await createWorkspace();
  sourcePathSubstitution.gate.sourceBindings.humanGold = {
    ...sourcePathSubstitution.gate.sourceBindings.evaluator,
  };
  await sourcePathSubstitution.writeGateAndRebind();
  const sourcePathSubstituted = await runWorkspace(sourcePathSubstitution, "source-path-substitution");
  check("source-binding-canonical-path-required", sourcePathSubstituted.report.offlineEvidenceReady === false
    && sourcePathSubstituted.report.blockingReasons.includes("m3plus-rescope-source-binding-path-mismatch:humanGold"));

  const noRuntime = await createWorkspace();
  delete noRuntime.item.candidateGate.m3plusPitchSafetyRuntime;
  await noRuntime.writeCandidateAndRuns();
  const noRuntimeResult = await runWorkspace(noRuntime, "no-runtime");
  check("missing-runtime-contract-blocks", noRuntimeResult.report.runtimeFoundationReady === false
    && noRuntimeResult.report.blockingReasons.includes("m3plus-runtime-contract-missing"));

  const emptyLatest = await createWorkspace();
  const priorRun = structuredClone(emptyLatest.run);
  await fs.writeFile(
    emptyLatest.batchRunsAbsolute,
    `${JSON.stringify(priorRun)}\n${JSON.stringify({ batchRunId: "empty-latest", autoDiagnosisIssued: false, items: [] })}\n`,
    "utf8",
  );
  const emptyResult = await runWorkspace(emptyLatest, "empty-latest");
  check("physical-empty-latest-blocks", emptyResult.report.runtimeFoundationReady === false
    && emptyResult.report.blockingReasons.includes("m3plus-runtime-latest-batch-empty"));

  const photoLatest = await createWorkspace();
  const ordinaryPrior = structuredClone(photoLatest.run);
  await fs.writeFile(
    photoLatest.batchRunsAbsolute,
    `${JSON.stringify(ordinaryPrior)}\n${JSON.stringify({
      batchRunId: "photo-latest",
      autoDiagnosisIssued: false,
      items: [{ kind: "photo-score", analysisStatus: "photo_score_review_ready" }],
    })}\n`,
    "utf8",
  );
  const photoResult = await runWorkspace(photoLatest, "photo-latest");
  check("physical-photo-only-latest-blocks", photoResult.report.runtimeFoundationReady === false
    && photoResult.report.blockingReasons.includes("m3plus-runtime-latest-batch-photo-only"));

  const multipleOrdinaryLatest = await createWorkspace();
  multipleOrdinaryLatest.run.items = [structuredClone(multipleOrdinaryLatest.item), multipleOrdinaryLatest.item];
  await multipleOrdinaryLatest.writeCandidateAndRuns();
  const multipleOrdinaryResult = await runWorkspace(multipleOrdinaryLatest, "multiple-ordinary-latest");
  check("full-latest-batch-cannot-ignore-earlier-ordinary-item", multipleOrdinaryResult.report.runtimeFoundationReady === false
    && multipleOrdinaryResult.report.blockingReasons.includes("m3plus-runtime-latest-ordinary-feature-item-count-invalid:2")
    && foundationCalls.at(-1)?.runs?.[0]?.items?.length === 2);

  const artifactHash = await createWorkspace();
  artifactHash.item.candidateRowsSha256 = "f".repeat(64);
  await fs.writeFile(artifactHash.batchRunsAbsolute, `${JSON.stringify(artifactHash.run)}\n`, "utf8");
  const hashResult = await runWorkspace(artifactHash, "artifact-hash");
  check("candidate-artifact-sha-mismatch-blocks", hashResult.report.runtimeFoundationReady === false
    && hashResult.report.blockingReasons.includes("m3plus-runtime-candidate-artifact-sha-mismatch"));

  const reviewOnly = await createWorkspace();
  reviewOnly.rows[0].autoDecision = "auto_pass";
  await reviewOnly.writeCandidateAndRuns();
  const reviewOnlyResult = await runWorkspace(reviewOnly, "review-only");
  check("non-review-row-blocks", reviewOnlyResult.report.runtimeAuditReady === false
    && reviewOnlyResult.report.blockingReasons.includes("m3plus-runtime-row-not-review-required:0"));

  const markedLeak = await createWorkspace();
  markedLeak.rows[1].m3plusPitchSafetyEvidence.decision = "issue_detected";
  markedLeak.rows[1].m3plusPitchSafetyEvidence.accusationIssued = true;
  await markedLeak.writeCandidateAndRuns();
  const markedResult = await runWorkspace(markedLeak, "marked-leak");
  check("score-marked-accusation-blocks", markedResult.report.runtimeFoundationReady === true
    && markedResult.report.runtimeAuditReady === false
    && markedResult.report.blockingReasons.includes("m3plus-runtime-score-marked-accusation:1"));

  const dispersionLeak = await createWorkspace();
  dispersionLeak.rows[2].m3plusPitchSafetyEvidence.decision = "confirmed_center";
  await dispersionLeak.writeCandidateAndRuns();
  const dispersionResult = await runWorkspace(dispersionLeak, "dispersion-leak");
  check("high-dispersion-leak-blocks", dispersionResult.report.runtimeFoundationReady === true
    && dispersionResult.report.runtimeAuditReady === false
    && dispersionResult.report.blockingReasons.includes("m3plus-runtime-high-dispersion-leak:2"));

  const policyMismatch = await createWorkspace();
  policyMismatch.rows[0].m3plusPitchSafetyEvidence.policySemanticSha256 = "b".repeat(64);
  await policyMismatch.writeCandidateAndRuns();
  const policyResult = await runWorkspace(policyMismatch, "policy-mismatch");
  check("row-policy-hash-mismatch-blocks", policyResult.report.runtimeAuditReady === false
    && policyResult.report.blockingReasons.includes("m3plus-runtime-row-policy-sha-mismatch:0"));

  const reportBinding = await createWorkspace();
  reportBinding.runtime.rescopeReportSha256 = "0".repeat(64);
  await reportBinding.writeCandidateAndRuns();
  const reportBindingResult = await runWorkspace(reportBinding, "report-binding");
  check("runtime-rescope-report-hash-mismatch-blocks", reportBindingResult.report.runtimeFoundationReady === false
    && reportBindingResult.report.blockingReasons.includes("m3plus-runtime-rescope-report-binding-mismatch"));

  const ordinaryFoundationFailure = await createWorkspace();
  const foundationFailureResult = await runWorkspace(
    ordinaryFoundationFailure,
    "ordinary-foundation-failure",
    () => ({ ok: false, failures: [{ code: "feature-review-candidate-rows-artifact-sha-mismatch" }] }),
  );
  check("ordinary-foundation-failure-propagates", foundationFailureResult.report.runtimeFoundationReady === false
    && foundationFailureResult.report.blockingReasons.includes(
      "m3plus-runtime-ordinary-foundation:feature-review-candidate-rows-artifact-sha-mismatch",
    ));

  const goldGap = await createWorkspace();
  goldGap.gate.releaseGateReady = false;
  goldGap.gate.zones.techniqueCenter.gatePassed = false;
  goldGap.gate.zones.techniqueCenter.goldJoinReady = false;
  goldGap.gate.zones.techniqueCenter.intonationGoldJoinedDecisionCount = 0;
  goldGap.gate.zones.techniqueCenter.intonationGoldUnjoinedDecisionCount = 3;
  goldGap.gate.zones.techniqueCenter.intonationGoldAgreementCount = 0;
  goldGap.gate.zones.techniqueCenter.intonationGoldDisagreementCount = 0;
  goldGap.gate.zones.techniqueCenter.intonationGoldAgreementRate = null;
  goldGap.gate.blockingReasons = ["m3plus-rescope-center-intonation-gold-join-missing"];
  await goldGap.writeGateAndRebind();
  const goldGapResult = await runWorkspace(goldGap, "gold-gap");
  check("gold-gap-keeps-current-audit-red", goldGapResult.report.offlineEvidenceReady === false
    && goldGapResult.report.readyForMonitoredPilot === false
    && goldGapResult.report.zones.techniqueCenter.agreementRate === null
    && goldGapResult.report.blockingReasons.includes(
      "m3plus-rescope-gate-blocking:m3plus-rescope-center-intonation-gold-join-missing",
    ));
} finally {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}

console.log(JSON.stringify({ ok: true, checks }, null, 2));
