import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { atomicWriteJson } from "../src/server/jsonStore.js";
import {
  compactScoreStoreForWrite,
  readScoreStoreLimits,
  writeScoreStoreArchive,
} from "../src/server/scoreStoreSupport.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const normalizeScoreImportJob = (job) => ({
  ...job,
  jobId: String(job.jobId || ""),
  scoreId: String(job.scoreId || ""),
  omrStatus: String(job.omrStatus || "processing"),
  updatedAt: job.updatedAt || job.completedAt || job.createdAt || "",
});

const normalizeImportedScoreRecord = (score) => ({
  ...score,
  scoreId: String(score.scoreId || ""),
  title: String(score.title || ""),
  selectedPart: String(score.selectedPart || "erhu"),
  updatedAt: score.updatedAt || score.createdAt || "",
});

const normalizeSearchText = (value) => String(value || "").trim().toLowerCase();

async function main() {
  const limits = readScoreStoreLimits({
    ERHU_SCORE_STORE_ARCHIVE_AFTER_DAYS: "14",
    ERHU_SCORE_STORE_MAX_JOBS: "50",
    ERHU_SCORE_STORE_MAX_DUPLICATE_SCORES: "1",
    ERHU_SCORE_STORE_MAX_LEGACY_SCORES_PER_TITLE: "1",
    ERHU_SCORE_STORE_MAX_TOTAL_SCORES: "20",
  });
  assert(limits.archiveAfterDays === 14, "archiveAfterDays should be configurable");

  const store = {
    jobs: [
      { jobId: "processing-old", scoreId: "", omrStatus: "processing", updatedAt: daysAgo(60) },
      { jobId: "recent-completed", scoreId: "score-recent", omrStatus: "completed", completedAt: daysAgo(2), updatedAt: daysAgo(2) },
      { jobId: "old-score-backed", scoreId: "score-old-kept", omrStatus: "completed", completedAt: daysAgo(60), updatedAt: daysAgo(60) },
      { jobId: "old-terminal", scoreId: "", omrStatus: "failed", completedAt: daysAgo(60), updatedAt: daysAgo(60) },
      { jobId: "invalid-date", scoreId: "", omrStatus: "completed", completedAt: "not-a-date", updatedAt: "not-a-date" },
    ],
    scores: [
      { scoreId: "score-recent", sourceJobId: "recent-completed", title: "Recent", pdfHash: "pdf-a", selectedPart: "erhu", updatedAt: daysAgo(2) },
      { scoreId: "score-old-kept", sourceJobId: "old-score-backed", title: "Old Kept", pdfHash: "pdf-b", selectedPart: "erhu", updatedAt: daysAgo(60) },
      { scoreId: "score-old-archived", sourceJobId: "missing-job", title: "Old Archived", pdfHash: "pdf-b", selectedPart: "erhu", updatedAt: daysAgo(61) },
    ],
  };

  const compacted = compactScoreStoreForWrite(store, {
    limits,
    normalizeScoreImportJob,
    normalizeImportedScoreRecord,
    normalizeSearchText,
  });

  const retainedJobIds = new Set(compacted.store.jobs.map((job) => job.jobId));
  const archivedJobIds = new Set((compacted.archive?.jobs || []).map((job) => job.jobId));
  const retainedScoreIds = new Set(compacted.store.scores.map((score) => score.scoreId));
  const archivedScoreIds = new Set((compacted.archive?.scores || []).map((score) => score.scoreId));

  assert(retainedJobIds.has("processing-old"), "processing jobs must never be age-archived");
  assert(retainedJobIds.has("recent-completed"), "recent terminal jobs should remain active");
  assert(retainedJobIds.has("old-score-backed"), "old jobs referenced by retained scores should remain active");
  assert(retainedJobIds.has("invalid-date"), "jobs without parseable timestamps should remain active");
  assert(archivedJobIds.has("old-terminal"), "old terminal jobs without retained score references should be archived");
  assert(retainedScoreIds.has("score-recent"), "recent score should remain active");
  assert(retainedScoreIds.has("score-old-kept"), "best duplicate score should remain active");
  assert(archivedScoreIds.has("score-old-archived"), "duplicate overflow score should be archived");

  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-score-archive-"));
  await writeScoreStoreArchive(compacted.archive, { archiveDir, atomicWriteJson });
  const archiveFiles = await fs.readdir(archiveDir);
  assert(archiveFiles.length === 1, `expected one archive file, got ${archiveFiles.length}`);
  const writtenArchive = JSON.parse(await fs.readFile(path.join(archiveDir, archiveFiles[0]), "utf8"));
  assert(writtenArchive.reason === "score-store-size-cap", "archive file should preserve archive reason");
  assert(writtenArchive.thresholds.archiveAfterDays === 14, "archive file should preserve archive thresholds");
  await fs.rm(archiveDir, { recursive: true, force: true });

  console.log(JSON.stringify({ ok: true, retainedJobs: [...retainedJobIds], archivedJobs: [...archivedJobIds] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
