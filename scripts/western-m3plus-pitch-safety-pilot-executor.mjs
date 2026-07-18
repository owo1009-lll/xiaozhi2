#!/usr/bin/env node
// M3+ pitch-safety pilot executor (v1).
//
// Review-only companion to the ordinary dynamic-shadow executor: it audits
// the M3+ pitch-safety evidence carried by the latest controlled batch (the
// one the ordinary executor just produced in the same session), verifies
// the gold-free runtime descriptor and every per-row decision, and writes a
// human review artifact. It never publishes feedback and never opens the
// student gate; issue_detected rows are listed for human review only.
import fs from "node:fs";
import path from "node:path";

import { readWorkspaceArtifactSync } from "./audit-western-ordinary-dynamic-shadow-acceptance.mjs";

export const M3PLUS_PILOT_EXECUTOR_CONTRACT = "western-m3plus-pitch-safety-pilot-executor-v1";
const M3PLUS_RUNTIME_CONTRACT = "m3plus-gold-free-runtime-v1";
const VALID_DECISIONS = new Set(["confirmed_center", "issue_detected", "insufficient_evidence"]);
const BATCH_RUNS_RELATIVE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "controlled-submission-batch-runs.jsonl",
);

export function m3plusPilotExecutorReadiness() {
  return { ready: true, contract: M3PLUS_PILOT_EXECUTOR_CONTRACT, blockingReasons: [] };
}

function readLatestBatchRun(repoRoot, fail) {
  const artifact = readWorkspaceArtifactSync(repoRoot, BATCH_RUNS_RELATIVE);
  if (artifact.status !== "ok") {
    fail(`m3plus-pilot-batch-runs-${artifact.status}`);
    return null;
  }
  const lines = artifact.bytes.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    fail("m3plus-pilot-batch-runs-empty");
    return null;
  }
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("m3plus-pilot-batch-runs-tail-unparseable");
    return null;
  }
}

export async function runM3PlusPitchSafetyPilotSession({
  repoRoot = process.cwd(),
  batchLimit = 1,
  outDir = "",
  includeRecordingIds = [],
  excludeRecordingIds = [],
} = {}) {
  const blockers = [];
  const fail = (reason) => blockers.push(reason);
  const include = new Set((includeRecordingIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const exclude = new Set((excludeRecordingIds || []).map((value) => String(value || "").trim()).filter(Boolean));
  const limit = Math.max(1, Math.min(20, Math.round(Number(batchLimit) || 1)));

  const run = readLatestBatchRun(repoRoot, fail);
  const items = Array.isArray(run?.items) ? run.items : [];
  const auditedItems = [];
  const decisionCounts = { confirmed_center: 0, issue_detected: 0, insufficient_evidence: 0 };
  const issueRows = [];
  let rowCount = 0;
  if (run && !items.length) fail("m3plus-pilot-latest-batch-empty");
  if (run && items.length > limit) fail(`m3plus-pilot-latest-batch-item-count-invalid:${items.length}:${limit}`);
  for (const item of items) {
    const id = String(item?.submissionId || "unknown");
    const recordingId = String(item?.recordingId || "").trim();
    if (exclude.has(recordingId)) fail(`m3plus-pilot-excluded-recording-in-batch:${recordingId}`);
    if (include.size > 0 && !include.has(recordingId)) {
      fail(`m3plus-pilot-unrequested-recording-in-batch:${recordingId || id}`);
    }
    if (item?.autoDiagnosisIssued === true) fail(`m3plus-pilot-item-auto-diagnosis-issued:${id}`);
    const artifact = readWorkspaceArtifactSync(repoRoot, item?.candidateRowsPath);
    if (artifact.status !== "ok") {
      fail(`m3plus-pilot-candidate-artifact-${artifact.status}:${id}`);
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(artifact.bytes.toString("utf8"));
    } catch {
      fail(`m3plus-pilot-candidate-artifact-unparseable:${id}`);
      continue;
    }
    const runtime = payload?.candidateGate?.m3plusPitchSafetyRuntime
      || payload?.summary?.m3plusPitchSafetyRuntime
      || {};
    if (
      runtime.reviewOnlyRuntimeWired !== true
      || runtime.contractReady !== true
      || runtime.reviewOnly !== true
      || runtime.feedbackAuthorized !== false
      || runtime.authorizationReady !== false
      || runtime.studentGateReady !== false
      || runtime.studentFacing !== false
    ) {
      fail(`m3plus-pilot-runtime-descriptor-invalid:${id}`);
    }
    if (runtime.runtimeContract && runtime.runtimeContract !== M3PLUS_RUNTIME_CONTRACT) {
      fail(`m3plus-pilot-runtime-contract-invalid:${id}:${runtime.runtimeContract}`);
    }
    const rows = Array.isArray(payload?.candidateRows) ? payload.candidateRows : [];
    if (!rows.length) {
      fail(`m3plus-pilot-candidate-rows-missing:${id}`);
      continue;
    }
    rows.forEach((row, index) => {
      const evidence = row?.m3plusPitchSafetyEvidence;
      if (row?.autoDecision !== "review_required" || row?.studentFacing !== false) {
        fail(`m3plus-pilot-row-not-review-only:${id}:${index}`);
        return;
      }
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        fail(`m3plus-pilot-row-evidence-missing:${id}:${index}`);
        return;
      }
      const decision = String(evidence.decision || "");
      if (!VALID_DECISIONS.has(decision)) {
        fail(`m3plus-pilot-row-decision-invalid:${id}:${index}:${decision || "missing"}`);
        return;
      }
      rowCount += 1;
      decisionCounts[decision] += 1;
      if (decision === "issue_detected") {
        issueRows.push({
          submissionId: id,
          recordingId,
          noteIndex: index,
          noteId: row?.noteId || null,
          measureIndex: row?.measureIndex ?? null,
        });
      }
    });
    auditedItems.push({ submissionId: id, recordingId, candidateRowCount: rows.length });
  }
  if (!blockers.length && rowCount === 0) fail("m3plus-pilot-no-evidence-rows");

  const result = {
    contract: M3PLUS_PILOT_EXECUTOR_CONTRACT,
    ok: blockers.length === 0,
    reviewOnly: true,
    feedbackAuthorized: false,
    studentFacing: false,
    blockers: [...new Set(blockers)],
    batchRunId: String(run?.batchRunId || ""),
    auditedItems,
    rowCount,
    decisionCounts,
    issueRowsForHumanReview: issueRows,
  };
  if (outDir) {
    const absoluteDir = path.resolve(repoRoot, outDir);
    fs.mkdirSync(absoluteDir, { recursive: true });
    fs.writeFileSync(
      path.join(absoluteDir, "m3plus-pilot-review.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
  }
  return result;
}
runM3PlusPitchSafetyPilotSession.contract = M3PLUS_PILOT_EXECUTOR_CONTRACT;
