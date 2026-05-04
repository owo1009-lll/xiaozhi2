import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  migrateScoreStoreToSqlite,
  readScoreStoreFromSqlite,
  summarizeScoreStoreSqlite,
} from "../src/server/scoreStoreSqlite.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-sqlite-migration-test-"));
try {
  const dataDir = path.join(tempDir, "data");
  const archiveDir = path.join(dataDir, "store-archive");
  const storePath = path.join(dataDir, "erhu-score-imports.json");
  const dbPath = path.join(dataDir, "erhu-score-imports.sqlite");
  await writeJson(storePath, {
    jobs: [
      {
        jobId: "active-job",
        scoreId: "active-score",
        pdfHash: "hash-active",
        omrStatus: "completed",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      {
        jobId: "processing-job",
        scoreId: "",
        pdfHash: "hash-processing",
        omrStatus: "processing",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
    ],
    scores: [
      {
        scoreId: "active-score",
        pdfHash: "hash-active",
        selectedPart: "erhu",
        title: "Active score",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ],
  });
  await writeJson(path.join(archiveDir, "erhu-score-imports-archive-2026-04-01T00-00-00-000Z.json"), {
    archivedAt: "2026-04-01T00:00:00.000Z",
    jobs: [
      {
        jobId: "archived-job",
        scoreId: "archived-score",
        pdfHash: "hash-archived",
        omrStatus: "failed",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      {
        jobId: "active-job",
        scoreId: "stale-archive-score",
        pdfHash: "stale-archive-hash",
        omrStatus: "failed",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ],
    scores: [
      {
        scoreId: "archived-score",
        pdfHash: "hash-archived",
        selectedPart: "erhu",
        title: "Archived score",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ],
  });

  const dryRun = await migrateScoreStoreToSqlite({ storePath, archiveDir, dbPath, dryRun: true });
  assert(dryRun.ok === true, "dry-run should succeed");
  assert(dryRun.summary.activeJobs === 2, "dry-run active job count mismatch");
  assert(dryRun.summary.archivedJobs === 1, "dry-run should not let archive duplicate overwrite active job");
  await fs.access(dbPath).then(
    () => assert(false, "dry-run should not create final database"),
    () => undefined,
  );

  const migrated = await migrateScoreStoreToSqlite({ storePath, archiveDir, dbPath, dryRun: false, force: true });
  assert(migrated.ok === true, "migration should succeed");
  assert(migrated.backupPath, "migration should create JSON backup");
  await fs.access(migrated.backupPath);

  const summary = summarizeScoreStoreSqlite(dbPath);
  assert(summary.exists === true, "SQLite database should exist");
  assert(summary.schemaVersion === "1", "SQLite schema version mismatch");
  assert(summary.activeJobs === 2, "active job count mismatch");
  assert(summary.archivedJobs === 1, "archived job count mismatch");
  assert(summary.activeScores === 1, "active score count mismatch");
  assert(summary.archivedScores === 1, "archived score count mismatch");

  const activeStore = readScoreStoreFromSqlite(dbPath);
  assert(activeStore.jobs.length === 2, "active read should exclude archived jobs");
  assert(activeStore.scores.length === 1, "active read should exclude archived scores");
  assert(activeStore.jobs.some((job) => job.jobId === "processing-job"), "processing job should be preserved");
  const activeJob = activeStore.jobs.find((job) => job.jobId === "active-job");
  assert(activeJob?.scoreId === "active-score", "active row should win over archived duplicate");

  const allStore = readScoreStoreFromSqlite(dbPath, { includeArchived: true });
  assert(allStore.jobs.length === 3, "includeArchived should return active plus archived jobs");
  assert(allStore.scores.length === 2, "includeArchived should return active plus archived scores");

  console.log(JSON.stringify({
    ok: true,
    checks: ["dry-run", "json-backup", "active-wins-over-archive", "active-read-excludes-archive", "include-archive-read"],
    summary,
  }, null, 2));
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
