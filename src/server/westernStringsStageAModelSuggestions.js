import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { nowIso, safeString } from "./baseUtils.js";
import { readScoreStoreFromSqlite } from "./scoreStoreSqlite.js";

const execFileAsync = promisify(execFile);
const JOB_CONTRACT = "western-stage-a-model-suggestion-job-v1";
const REPORT_CONTRACT = "western-round6-stage-a-model-teacher-suggestions-v1";
const activeJobs = new Map();
let queueTail = Promise.resolve();

function outputDir(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-stage-a-model-suggestions");
}

function reportPath(repoRoot, submissionId) {
  return path.join(outputDir(repoRoot), `${submissionId}.json`);
}

function statusPath(repoRoot, submissionId) {
  return path.join(outputDir(repoRoot), `${submissionId}.status.json`);
}

function pathIsInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveDataFile(repoRoot, rawPath, label) {
  const normalized = safeString(rawPath).trim().replace(/\\/g, "/");
  const resolved = normalized.startsWith("/data/")
    ? path.resolve(repoRoot, normalized.slice(1))
    : path.resolve(repoRoot, normalized);
  const dataRoot = path.resolve(repoRoot, "data");
  if (!pathIsInside(dataRoot, resolved)) throw new Error(`${label} resolved outside the data directory.`);
  const [realDataRoot, realPath] = await Promise.all([fs.realpath(dataRoot), fs.realpath(resolved)]);
  if (!pathIsInside(realDataRoot, realPath)) throw new Error(`${label} resolved outside the data directory.`);
  return realPath;
}

async function buildIdentity(repoRoot, submission) {
  const submissionId = safeString(submission?.submissionId).trim();
  const scoreId = safeString(submission?.scoreId).trim();
  if (!submissionId || !scoreId || safeString(submission?.kind) === "photo-score") {
    throw new Error("Stage A suggestions require a clean-score controlled submission.");
  }
  const scoreStore = readScoreStoreFromSqlite(path.join(repoRoot, "data", "erhu-score-imports.sqlite"));
  const score = (scoreStore.scores || []).find((item) => safeString(item?.scoreId).trim() === scoreId);
  if (!score?.musicxmlPath) throw new Error(`score ${scoreId} has no MusicXML source.`);
  const [scorePath, audioPath] = await Promise.all([
    resolveDataFile(repoRoot, score.musicxmlPath, "score MusicXML"),
    resolveDataFile(repoRoot, submission.audioPath || submission.audioSubmission?.storedPath, "submission audio"),
  ]);
  const [scoreSha256, audioSha256] = await Promise.all([sha256File(scorePath), sha256File(audioPath)]);
  return { submissionId, scoreId, scorePath, audioPath, scoreSha256, audioSha256 };
}

async function defaultRunner({ repoRoot, scorePath, audioPath, outPath }) {
  const command = safeString(process.env.WESTERN_STAGE_A_SUGGESTION_PYTHON).trim()
    || (process.platform === "win32" ? "py" : "python3");
  const args = [
    ...(path.basename(command).toLowerCase() === "py" || path.basename(command).toLowerCase() === "py.exe" ? ["-3.11"] : []),
    path.join(repoRoot, "scripts", "experiments", "score_submission_with_stage_a_model.py"),
    "--score", scorePath,
    "--audio", audioPath,
    "--out", outPath,
  ];
  await execFileAsync(command, args, { cwd: repoRoot, timeout: 30 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
}

export async function runWesternStageAModelSuggestionJob({
  repoRoot = process.cwd(),
  submission = {},
  runner = defaultRunner,
} = {}) {
  const identity = await buildIdentity(repoRoot, submission);
  const statePath = statusPath(repoRoot, identity.submissionId);
  const started = {
    contract: JOB_CONTRACT,
    submissionId: identity.submissionId,
    scoreId: identity.scoreId,
    scoreSha256: identity.scoreSha256,
    audioSha256: identity.audioSha256,
    status: "running",
    startedAt: nowIso(),
  };
  await atomicJson(statePath, started);
  const temporaryReport = path.join(outputDir(repoRoot), `${identity.submissionId}.${process.pid}.inference.tmp.json`);
  try {
    await runner({ repoRoot, ...identity, outPath: temporaryReport });
    const generated = JSON.parse(await fs.readFile(temporaryReport, "utf8"));
    if (generated?.contract !== REPORT_CONTRACT) throw new Error("Stage A scorer returned an unexpected report contract.");
    if (safeString(generated?.audioSha256).toLowerCase() !== identity.audioSha256) {
      throw new Error("Stage A scorer output does not match the submission audio.");
    }
    if (safeString(generated?.scoreSha256).toLowerCase() !== identity.scoreSha256) {
      throw new Error("Stage A scorer output does not match the score MusicXML.");
    }
    const storedReport = {
      ...generated,
      jobContract: JOB_CONTRACT,
      submissionId: identity.submissionId,
      scoreId: identity.scoreId,
      generatedAt: nowIso(),
    };
    await atomicJson(reportPath(repoRoot, identity.submissionId), storedReport);
    const succeeded = { ...started, status: "succeeded", finishedAt: nowIso(), suggestionCount: Number(storedReport.suggestionCount || 0) };
    await atomicJson(statePath, succeeded);
    return succeeded;
  } catch (error) {
    const failed = { ...started, status: "failed", finishedAt: nowIso(), error: safeString(error?.message || error) };
    await atomicJson(statePath, failed);
    throw error;
  } finally {
    await fs.rm(temporaryReport, { force: true });
  }
}

export async function enqueueWesternStageAModelSuggestionJob(options = {}) {
  const identity = await buildIdentity(options.repoRoot || process.cwd(), options.submission || {});
  const key = `${path.resolve(options.repoRoot || process.cwd())}\0${identity.submissionId}`;
  if (activeJobs.has(key)) return { queued: false, status: "already-running" };
  const existing = await readJsonOrNull(reportPath(options.repoRoot || process.cwd(), identity.submissionId));
  if (existing?.submissionId === identity.submissionId
    && existing?.scoreSha256 === identity.scoreSha256
    && existing?.audioSha256 === identity.audioSha256) {
    return { queued: false, status: "succeeded" };
  }
  await atomicJson(statusPath(options.repoRoot || process.cwd(), identity.submissionId), {
    contract: JOB_CONTRACT,
    submissionId: identity.submissionId,
    scoreId: identity.scoreId,
    scoreSha256: identity.scoreSha256,
    audioSha256: identity.audioSha256,
    status: "queued",
    queuedAt: nowIso(),
  });
  const job = queueTail.catch(() => {}).then(() => runWesternStageAModelSuggestionJob(options));
  queueTail = job;
  activeJobs.set(key, job);
  job.catch(() => {}).finally(() => activeJobs.delete(key));
  return { queued: true, status: "queued" };
}

export async function waitForWesternStageAModelSuggestionJob({ repoRoot = process.cwd(), submissionId = "" } = {}) {
  const key = `${path.resolve(repoRoot)}\0${safeString(submissionId).trim()}`;
  const job = activeJobs.get(key);
  if (job) await job;
  return readWesternStageAModelSuggestionJob({ repoRoot, submissionId });
}

export async function readWesternStageAModelSuggestionJob({ repoRoot = process.cwd(), submissionId = "", submission = null } = {}) {
  const target = safeString(submissionId || submission?.submissionId).trim();
  const [status, report] = await Promise.all([
    readJsonOrNull(statusPath(repoRoot, target)),
    readJsonOrNull(reportPath(repoRoot, target)),
  ]);
  if (!status) return { status: "not-scheduled", report: null };
  if (submission && report) {
    const identity = await buildIdentity(repoRoot, submission);
    if (report.submissionId !== identity.submissionId
      || report.scoreId !== identity.scoreId
      || report.scoreSha256 !== identity.scoreSha256
      || report.audioSha256 !== identity.audioSha256) {
      return { status: "stale", job: status, report: null };
    }
  }
  return { status: safeString(status.status, "unknown"), job: status, report };
}
