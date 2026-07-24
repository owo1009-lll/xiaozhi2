import path from "node:path";
import {
  getArray,
  nowIso,
  parseTimestampMs,
  safeNumber,
  safeString,
  sortNewestFirst,
} from "./baseUtils.js";

export function readScoreStoreLimits(env = process.env) {
  return {
    archiveAfterDays: Math.max(1, Math.round(safeNumber(env.ERHU_SCORE_STORE_ARCHIVE_AFTER_DAYS, 14))),
    maxJobs: Math.max(50, Math.round(safeNumber(env.ERHU_SCORE_STORE_MAX_JOBS, 200))),
    maxDuplicateScores: Math.max(1, Math.round(safeNumber(env.ERHU_SCORE_STORE_MAX_DUPLICATE_SCORES, 2))),
    maxLegacyScoresPerTitle: Math.max(1, Math.round(safeNumber(env.ERHU_SCORE_STORE_MAX_LEGACY_SCORES_PER_TITLE, 1))),
    maxTotalScores: Math.max(20, Math.round(safeNumber(env.ERHU_SCORE_STORE_MAX_TOTAL_SCORES, 100))),
  };
}

function isProcessingJob(job = {}) {
  return safeString(job.omrStatus) === "processing" || safeString(job.status) === "processing";
}

function isTerminalJob(job = {}) {
  const status = safeString(job.omrStatus || job.status).toLowerCase();
  return status === "completed" || status === "failed";
}

function jobReferenceMs(job = {}) {
  return (
    parseTimestampMs(job.completedAt)
    || parseTimestampMs(job.updatedAt)
    || parseTimestampMs(job.createdAt)
    || 0
  );
}

function isOldTerminalJob(job = {}, limits = readScoreStoreLimits()) {
  if (!isTerminalJob(job) || isProcessingJob(job)) return false;
  const referenceMs = jobReferenceMs(job);
  if (!referenceMs) return false;
  const cutoffMs = Date.now() - (Math.max(1, safeNumber(limits.archiveAfterDays, 14)) * 24 * 60 * 60 * 1000);
  return referenceMs < cutoffMs;
}

export function compactScoreStoreForWrite(
  store = {},
  {
    limits = readScoreStoreLimits(),
    normalizeScoreImportJob,
    normalizeImportedScoreRecord,
    normalizeSearchText,
  } = {},
) {
  if (typeof normalizeScoreImportJob !== "function") {
    throw new TypeError("compactScoreStoreForWrite requires normalizeScoreImportJob.");
  }
  if (typeof normalizeImportedScoreRecord !== "function") {
    throw new TypeError("compactScoreStoreForWrite requires normalizeImportedScoreRecord.");
  }
  if (typeof normalizeSearchText !== "function") {
    throw new TypeError("compactScoreStoreForWrite requires normalizeSearchText.");
  }

  const jobs = getArray(store.jobs).map((item) => normalizeScoreImportJob(item)).sort(sortNewestFirst);
  const activeJobs = jobs.filter((job) => isProcessingJob(job));
  const recentInactiveJobs = jobs.filter((job) => !isProcessingJob(job) && !isOldTerminalJob(job, limits));
  const retainedRecentJobs = [...activeJobs, ...recentInactiveJobs.slice(0, Math.max(0, limits.maxJobs - activeJobs.length))];
  const protectedScoreIds = new Set(retainedRecentJobs.map((job) => safeString(job.scoreId)).filter(Boolean));

  const scores = getArray(store.scores).map((item) => normalizeImportedScoreRecord(item)).sort(sortNewestFirst);
  const groupedScores = new Map();
  for (const score of scores) {
    const pdfHash = safeString(score.pdfHash).trim();
    const selectedPart = safeString(score.selectedPart, "erhu").toLowerCase();
    const title = normalizeSearchText(score.title);
    const key = pdfHash ? `pdf:${pdfHash}:${selectedPart}` : `legacy:${title}:${selectedPart}`;
    if (!groupedScores.has(key)) groupedScores.set(key, []);
    groupedScores.get(key).push(score);
  }

  const keepScoreIds = new Set(protectedScoreIds);
  for (const [key, group] of groupedScores.entries()) {
    const limit = key.startsWith("legacy:")
      ? limits.maxLegacyScoresPerTitle
      : limits.maxDuplicateScores;
    group.slice(0, limit).forEach((score) => keepScoreIds.add(safeString(score.scoreId)));
  }

  const protectedOrRecentScores = scores.filter((score) => keepScoreIds.has(safeString(score.scoreId)));
  const overflowCandidates = protectedOrRecentScores.filter((score) => !protectedScoreIds.has(safeString(score.scoreId)));
  if (protectedOrRecentScores.length > limits.maxTotalScores) {
    const protectedScores = protectedOrRecentScores.filter((score) => protectedScoreIds.has(safeString(score.scoreId)));
    const allowedOverflowCount = Math.max(0, limits.maxTotalScores - protectedScores.length);
    const overflowKeepIds = new Set(
      overflowCandidates
        .sort(sortNewestFirst)
        .slice(0, allowedOverflowCount)
        .map((score) => safeString(score.scoreId)),
    );
    keepScoreIds.clear();
    protectedScores.forEach((score) => keepScoreIds.add(safeString(score.scoreId)));
    overflowKeepIds.forEach((scoreId) => keepScoreIds.add(scoreId));
  }

  const retainedScores = scores.filter((score) => keepScoreIds.has(safeString(score.scoreId)));
  const retainedScoreIds = new Set(retainedScores.map((score) => safeString(score.scoreId)));
  const archivedScores = scores.filter((score) => !retainedScoreIds.has(safeString(score.scoreId)));
  const retainedScoreJobIds = new Set(
    retainedScores
      .map((score) => safeString(score.sourceJobId || score.jobId))
      .filter(Boolean),
  );
  const retainedRecentJobIds = new Set(retainedRecentJobs.map((job) => safeString(job.jobId)).filter(Boolean));
  const retainedJobs = jobs.filter((job) => {
    const jobId = safeString(job.jobId);
    const scoreId = safeString(job.scoreId);
    return (
      isProcessingJob(job)
      || retainedRecentJobIds.has(jobId)
      || retainedScoreJobIds.has(jobId)
      || (scoreId && retainedScoreIds.has(scoreId))
    );
  });
  const retainedJobIds = new Set(retainedJobs.map((job) => safeString(job.jobId)).filter(Boolean));
  const archivedJobs = jobs.filter((job) => !retainedJobIds.has(safeString(job.jobId)));
  return {
    store: {
      jobs: retainedJobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
      scores: retainedScores.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
    },
    archive: archivedJobs.length || archivedScores.length
      ? {
          archivedAt: nowIso(),
          reason: "score-store-size-cap",
          thresholds: limits,
          jobs: archivedJobs,
          scores: archivedScores,
        }
      : null,
  };
}

export async function writeScoreStoreArchive(archive, { archiveDir, atomicWriteJson } = {}) {
  if (!archive) return;
  if (!archiveDir) {
    throw new TypeError("writeScoreStoreArchive requires archiveDir.");
  }
  if (typeof atomicWriteJson !== "function") {
    throw new TypeError("writeScoreStoreArchive requires atomicWriteJson.");
  }
  const archivePath = path.join(
    archiveDir,
    `erhu-score-imports-archive-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await atomicWriteJson(archivePath, archive, { pretty: false });
}
