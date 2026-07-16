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
const pipeline = path.join(repoRoot, "scripts", "western_photo_score_pipeline.py");
const pythonRunner = path.join(repoRoot, "scripts", "run-python.ps1");

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const limit = Math.max(0, Math.round(Number(process.argv[2] || 5)));
const submissions = readJsonl(subsPath).filter((s) => s.kind === "photo-score");
const reviews = readJsonl(reviewsPath);
const latestAction = new Map();
for (const r of reviews) latestAction.set(r.submissionId, r.action);
const alreadyRun = new Set(readJsonl(outJsonl).map((r) => r.submissionId));

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
      "-ExecutionPolicy", "Bypass", "-File", pythonRunner,
      pipeline, "--photo", photo, "--audio", audio,
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
    record = parsed
      ? {
        ...record,
        status: "ok",
        decision: parsed.decision,
        audit: parsed.audit,
        p0StructureGateVersion: parsed.p0StructureGateVersion || 0,
      }
      : { ...record, status: "failed", reason: `pipeline-exit-${res.status}` };
  }
  items.push(record);
  fs.mkdirSync(path.dirname(outJsonl), { recursive: true });
  fs.appendFileSync(outJsonl, JSON.stringify(record) + "\n", "utf8");
}
console.log(JSON.stringify({ ok: true, queued: queue.length, ran: items.length, items, note: "review-only; autoDiagnosisIssued=false; student runtime untouched" }));
