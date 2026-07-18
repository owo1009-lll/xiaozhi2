#!/usr/bin/env node
// Ordinary dynamic-shadow pilot executor (v1).
//
// Review-only telemetry executor for the monitored pilot: it selects
// eligible accepted submissions, runs the controlled batch through the
// attested offline analysis, and audits every produced candidate row as
// review_required with zero auto-pass. The dynamic shadow never authorizes
// anything in v1, so every pilot-eligible/self-checked/known count is
// structurally zero; shadow selections are reported as telemetry only and
// go to human review. Student-facing output stays impossible here.
import fs from "node:fs";
import path from "node:path";

import { readWorkspaceArtifactSync } from "./audit-western-ordinary-dynamic-shadow-acceptance.mjs";

export const ORDINARY_PILOT_EXECUTOR_CONTRACT = "western-ordinary-dynamic-shadow-pilot-executor-v1";

export function ordinaryPilotExecutorReadiness({ probeRuntime = true } = {}) {
  const blockingReasons = [];
  if (probeRuntime) {
    // Lazy import keeps module load light; the probe spawns the pinned venv.
    return import("./run-western-ordinary-audio-python.mjs").then(({ evaluateOrdinaryAudioRuntime }) => {
      const runtime = evaluateOrdinaryAudioRuntime();
      if (runtime.runtimeReady !== true) {
        blockingReasons.push("ordinary-pilot-executor-runtime-not-ready");
        blockingReasons.push(...(runtime.blockingReasons || []));
      }
      return {
        ready: blockingReasons.length === 0,
        contract: ORDINARY_PILOT_EXECUTOR_CONTRACT,
        blockingReasons: [...new Set(blockingReasons)],
      };
    });
  }
  return Promise.resolve({ ready: true, contract: ORDINARY_PILOT_EXECUTOR_CONTRACT, blockingReasons: [] });
}

function auditBatchItem(repoRoot, item, telemetry, fail) {
  const id = String(item?.submissionId || "unknown");
  if (item?.analysisStatus !== "offline_feature_review_ready") {
    fail(`ordinary-pilot-item-status-invalid:${id}:${item?.analysisStatus || "missing"}`);
    return;
  }
  if (item?.autoDiagnosisIssued === true) fail(`ordinary-pilot-item-auto-diagnosis-issued:${id}`);
  const artifact = readWorkspaceArtifactSync(repoRoot, item?.candidateRowsPath);
  if (artifact.status !== "ok") {
    fail(`ordinary-pilot-candidate-artifact-${artifact.status}:${id}`);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    fail(`ordinary-pilot-candidate-artifact-unparseable:${id}`);
    return;
  }
  const rows = Array.isArray(payload?.candidateRows) ? payload.candidateRows : [];
  if (!rows.length) {
    fail(`ordinary-pilot-candidate-rows-missing:${id}`);
    return;
  }
  if (Number(item?.candidateRowCount) !== rows.length) {
    fail(`ordinary-pilot-candidate-row-count-mismatch:${id}`);
  }
  rows.forEach((row, index) => {
    if (row?.autoDecision !== "review_required"
        || row?.studentFacing !== false
        || row?.feedbackAuthorized !== false
        || row?.studentSafeGateReady !== false) {
      fail(`ordinary-pilot-row-not-review-only:${id}:${index}`);
      return;
    }
    telemetry.totalCandidateCount += 1;
    if (row?.dynamicShadowEvidence?.selected === true) telemetry.shadowSelectedCandidateCount += 1;
  });
}

export async function runDynamicShadowPilotSession({
  repoRoot = process.cwd(),
  batchLimit = 1,
  outDir = "",
  selectionJson = "",
  summary: summaryPath = "",
  includeRecordingIds = [],
  excludeRecordingIds = [],
} = {}) {
  const blockingReasons = [];
  const fail = (reason) => blockingReasons.push(reason);
  const limit = Math.max(1, Math.min(20, Math.round(Number(batchLimit) || 1)));
  const service = await import("../src/server/westernStringsAlignmentService.js");

  const listed = await service.listWesternControlledSubmissions({ repoRoot, limit: 0 });
  const include = new Set((includeRecordingIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const exclude = new Set((excludeRecordingIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const seenRecordingIds = new Set();
  const eligible = [];
  for (const submission of listed?.submissions || []) {
    const recordingId = String(submission?.recordingId || "").trim();
    if (submission?.status !== "accepted_for_batch") continue;
    if (!recordingId || exclude.has(recordingId) || seenRecordingIds.has(recordingId)) continue;
    if (include.size > 0 && !include.has(recordingId)) continue;
    seenRecordingIds.add(recordingId);
    eligible.push(submission);
    if (eligible.length >= limit) break;
  }
  if (!eligible.length) fail("ordinary-pilot-no-eligible-submission");

  const telemetry = { totalCandidateCount: 0, shadowSelectedCandidateCount: 0 };
  let batch = null;
  if (!blockingReasons.length) {
    const result = await service.runWesternControlledSubmissionBatch({
      repoRoot,
      limit: eligible.length,
      submissionIds: eligible.map((submission) => submission.submissionId),
    });
    batch = result?.batch || {};
    const items = Array.isArray(batch.items) ? batch.items : [];
    if (items.length !== eligible.length) {
      fail(`ordinary-pilot-batch-item-count-invalid:${items.length}:${eligible.length}`);
    }
    for (const item of items) auditBatchItem(repoRoot, item, telemetry, fail);
  }

  const selectedSubmissions = eligible.map((submission) => ({
    submissionId: String(submission.submissionId || ""),
    recordingId: String(submission.recordingId || ""),
  }));
  const summary = {
    ok: blockingReasons.length === 0,
    contract: ORDINARY_PILOT_EXECUTOR_CONTRACT,
    reviewOnly: true,
    studentFacing: false,
    feedbackAuthorized: false,
    batchRunId: String(batch?.batchRunId || ""),
    selectedSubmissionCount: selectedSubmissions.length,
    selectedSubmissions,
    totalCandidateCount: telemetry.totalCandidateCount,
    // The v1 dynamic shadow authorizes nothing: every auto-pass lane is
    // structurally zero and shadow selections are telemetry for human review.
    modelAutoPassCandidateCount: 0,
    autoPassCandidateCount: 0,
    selfCheckedAutoPassCandidateCount: 0,
    knownUsableAutoPassCandidateCount: 0,
    knownWrongAutoPassCandidateCount: 0,
    unknownReviewCandidateCount: 0,
    shadowSelectedCandidateCount: telemetry.shadowSelectedCandidateCount,
    shadowCoverage: telemetry.totalCandidateCount > 0
      ? Number((telemetry.shadowSelectedCandidateCount / telemetry.totalCandidateCount).toFixed(6))
      : 0,
    defaultOrdinaryReadyAfter: false,
    reviewPack: null,
    blockingReasons: [...new Set(blockingReasons)],
  };

  if (selectionJson) {
    fs.mkdirSync(path.dirname(path.resolve(repoRoot, selectionJson)), { recursive: true });
    fs.writeFileSync(
      path.resolve(repoRoot, selectionJson),
      `${JSON.stringify({ contract: ORDINARY_PILOT_EXECUTOR_CONTRACT, selectedSubmissions }, null, 2)}\n`,
      "utf8",
    );
  }
  if (summaryPath) {
    fs.mkdirSync(path.dirname(path.resolve(repoRoot, summaryPath)), { recursive: true });
    fs.writeFileSync(path.resolve(repoRoot, summaryPath), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  if (outDir) fs.mkdirSync(path.resolve(repoRoot, outDir), { recursive: true });
  return { summary };
}
runDynamicShadowPilotSession.contract = ORDINARY_PILOT_EXECUTOR_CONTRACT;
