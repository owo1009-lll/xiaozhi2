#!/usr/bin/env node
// Offline batch runner for photo-score controlled submissions (fail-closed).
// Picks kind=photo-score submissions whose latest review action is
// accepted_for_batch, runs the python photo-score pipeline per item, and
// appends an audit record. Never emits student-facing diagnosis:
// autoDiagnosisIssued=false always; artifacts go to teacher review only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const subsPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl");
const reviewsPath = path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl");
const outJsonl = path.join(repoRoot, "data", "experiments", "western-strings-m4", "photo-score-batch-runs.jsonl");
const photoScoreRunner = path.join(repoRoot, "scripts", "run-western-photo-score-python.ps1");
const deploymentPreflight = path.join(repoRoot, "scripts", "preflight-western-photo-score-deployment.mjs");

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function parseLastJson(text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* continue */ }
  }
  return null;
}

// Check governance and both isolated runtimes before looking at accepted work.
// A failed preflight therefore writes no batch row and consumes no submission.
const preflightResult = spawnSync(process.execPath, [deploymentPreflight, "--quiet"], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 2 * 60 * 1000,
  env: process.env,
});
if (preflightResult.status !== 0) {
  const report = parseLastJson(preflightResult.stderr) || parseLastJson(preflightResult.stdout);
  console.log(JSON.stringify({
    ok: false,
    queued: 0,
    ran: 0,
    reason: "photo-score-deployment-preflight-failed",
    blockingReasons: report?.blockingReasons || [`preflight-exit-${preflightResult.status}`],
    studentFacing: false,
    autoDiagnosisIssued: false,
  }));
  process.exit(1);
}

const limit = Math.max(0, Math.round(Number(process.argv[2] || 5)));
const submissions = readJsonl(subsPath).filter((s) => s.kind === "photo-score");
const reviews = readJsonl(reviewsPath);
const latestAction = new Map();
for (const r of reviews) latestAction.set(r.submissionId, r.action);
// Dependency or governance failures must remain retryable after remediation.
const alreadyRun = new Set(
  readJsonl(outJsonl).filter((r) => r.status === "ok").map((r) => r.submissionId),
);

const queue = submissions.filter((s) => latestAction.get(s.submissionId) === "accepted_for_batch" && !alreadyRun.has(s.submissionId)).slice(0, limit);
const items = [];
for (const sub of queue) {
  const photo = path.resolve(repoRoot, sub.scorePhotoPath || "");
  const audio = path.resolve(repoRoot, sub.audioPath || "");
  let record = { submissionId: sub.submissionId, ranAt: new Date().toISOString(), autoDiagnosisIssued: false, studentFacing: false };
  if (!fs.existsSync(photo) || !fs.existsSync(audio)) {
    record = { ...record, status: "failed", reason: "photo-or-audio-missing" };
  } else {
    const res = spawnSync("powershell.exe", [
      "-ExecutionPolicy", "Bypass", "-File", photoScoreRunner,
      "--photo", photo, "--audio", audio,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
      env: {
        ...process.env,
        ERHU_CPU_THREAD_LIMIT: process.env.ERHU_CPU_THREAD_LIMIT || "2",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
    const line = (res.stdout || "").split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
    let parsed = null; try { parsed = line ? JSON.parse(line) : null; } catch { /* keep null */ }
    record = res.status === 0 && parsed
      ? {
        ...record,
        status: "ok",
        decision: parsed.decision,
        audit: parsed.audit,
        p0StructureGateVersion: parsed.p0StructureGateVersion || 0,
      }
      : {
        ...record,
        status: "failed",
        reason: parsed?.reason || `pipeline-exit-${res.status}`,
      };
  }
  items.push(record);
  fs.mkdirSync(path.dirname(outJsonl), { recursive: true });
  fs.appendFileSync(outJsonl, JSON.stringify(record) + "\n", "utf8");
}
console.log(JSON.stringify({ ok: true, queued: queue.length, ran: items.length, items, note: "review-only; autoDiagnosisIssued=false; student runtime untouched" }));
