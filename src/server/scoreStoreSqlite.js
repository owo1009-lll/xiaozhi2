import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getArray, nowIso, safeString } from "./baseUtils.js";

export const SCORE_STORE_SQLITE_SCHEMA_VERSION = 1;

function ensureParentDir(filePath) {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
}

function jsonText(value) {
  return JSON.stringify(value ?? {});
}

function parsePayload(text, fallback = {}) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return fallback;
  }
}

function rowTimestamp(record = {}) {
  return safeString(record.updatedAt || record.completedAt || record.createdAt || nowIso());
}

function jobStatus(job = {}) {
  return safeString(job.omrStatus || job.status);
}

export function openScoreStoreDatabase(dbPath) {
  ensureParentDir(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export function ensureScoreStoreSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS score_store_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS score_import_jobs (
      job_id TEXT PRIMARY KEY,
      score_id TEXT,
      pdf_hash TEXT,
      status TEXT,
      updated_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      archive_source TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_score_import_jobs_active_updated
      ON score_import_jobs (archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_score_import_jobs_score_id
      ON score_import_jobs (score_id);
    CREATE INDEX IF NOT EXISTS idx_score_import_jobs_pdf_hash
      ON score_import_jobs (pdf_hash);
    CREATE TABLE IF NOT EXISTS imported_scores (
      score_id TEXT PRIMARY KEY,
      pdf_hash TEXT,
      selected_part TEXT,
      title TEXT,
      updated_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      archive_source TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_imported_scores_active_updated
      ON imported_scores (archived, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_imported_scores_pdf_part
      ON imported_scores (pdf_hash, selected_part);
  `);
  db.prepare(`
    INSERT INTO score_store_meta (key, value)
    VALUES ('schemaVersion', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(SCORE_STORE_SQLITE_SCHEMA_VERSION));
}

function existingArchivedState(db, table, idColumn, idValue) {
  const row = db.prepare(`SELECT archived FROM ${table} WHERE ${idColumn} = ?`).get(idValue);
  return row ? Number(row.archived) : null;
}

export function upsertScoreImportJobRow(db, job = {}, { archived = false, archiveSource = "" } = {}) {
  const jobId = safeString(job.jobId);
  if (!jobId) return false;
  const archivedValue = archived ? 1 : 0;
  const existingArchived = existingArchivedState(db, "score_import_jobs", "job_id", jobId);
  if (archivedValue && existingArchived === 0) return false;
  db.prepare(`
    INSERT INTO score_import_jobs
      (job_id, score_id, pdf_hash, status, updated_at, archived, archive_source, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      score_id = excluded.score_id,
      pdf_hash = excluded.pdf_hash,
      status = excluded.status,
      updated_at = excluded.updated_at,
      archived = excluded.archived,
      archive_source = excluded.archive_source,
      payload = excluded.payload
  `).run(
    jobId,
    safeString(job.scoreId),
    safeString(job.pdfHash),
    jobStatus(job),
    rowTimestamp(job),
    archivedValue,
    safeString(archiveSource),
    jsonText(job),
  );
  return true;
}

export function upsertImportedScoreRow(db, score = {}, { archived = false, archiveSource = "" } = {}) {
  const scoreId = safeString(score.scoreId);
  if (!scoreId) return false;
  const archivedValue = archived ? 1 : 0;
  const existingArchived = existingArchivedState(db, "imported_scores", "score_id", scoreId);
  if (archivedValue && existingArchived === 0) return false;
  db.prepare(`
    INSERT INTO imported_scores
      (score_id, pdf_hash, selected_part, title, updated_at, archived, archive_source, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(score_id) DO UPDATE SET
      pdf_hash = excluded.pdf_hash,
      selected_part = excluded.selected_part,
      title = excluded.title,
      updated_at = excluded.updated_at,
      archived = excluded.archived,
      archive_source = excluded.archive_source,
      payload = excluded.payload
  `).run(
    scoreId,
    safeString(score.pdfHash),
    safeString(score.selectedPart, "erhu"),
    safeString(score.title),
    rowTimestamp(score),
    archivedValue,
    safeString(archiveSource),
    jsonText(score),
  );
  return true;
}

function readStoreFromDb(db, { includeArchived = false } = {}) {
  const archivedClause = includeArchived ? "" : "WHERE archived = 0";
  const jobs = db.prepare(`
    SELECT payload FROM score_import_jobs
    ${archivedClause}
    ORDER BY updated_at DESC
  `).all().map((row) => parsePayload(row.payload));
  const scores = db.prepare(`
    SELECT payload FROM imported_scores
    ${archivedClause}
    ORDER BY updated_at DESC
  `).all().map((row) => parsePayload(row.payload));
  return { jobs, scores };
}

export function readScoreStoreFromSqlite(dbPath, options = {}) {
  if (!fsSync.existsSync(dbPath)) return { jobs: [], scores: [] };
  const db = openScoreStoreDatabase(dbPath);
  try {
    ensureScoreStoreSchema(db);
    return readStoreFromDb(db, options);
  } finally {
    db.close();
  }
}

export function summarizeScoreStoreSqlite(dbPath) {
  if (!fsSync.existsSync(dbPath)) {
    return { exists: false, activeJobs: 0, archivedJobs: 0, activeScores: 0, archivedScores: 0 };
  }
  const db = openScoreStoreDatabase(dbPath);
  try {
    ensureScoreStoreSchema(db);
    const count = (table, archived) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE archived = ?`).get(archived).count || 0);
    return {
      exists: true,
      activeJobs: count("score_import_jobs", 0),
      archivedJobs: count("score_import_jobs", 1),
      activeScores: count("imported_scores", 0),
      archivedScores: count("imported_scores", 1),
      schemaVersion: safeString(db.prepare("SELECT value FROM score_store_meta WHERE key = 'schemaVersion'").get()?.value),
    };
  } finally {
    db.close();
  }
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function listArchiveFiles(archiveDir) {
  try {
    const entries = await fs.readdir(archiveDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^erhu-score-imports-archive-.*\.json$/i.test(entry.name))
      .map((entry) => path.join(archiveDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function insertStore(db, store = {}, { archived = false, archiveSource = "" } = {}) {
  let insertedJobs = 0;
  let insertedScores = 0;
  for (const job of getArray(store.jobs)) {
    if (upsertScoreImportJobRow(db, job, { archived, archiveSource })) insertedJobs += 1;
  }
  for (const score of getArray(store.scores)) {
    if (upsertImportedScoreRow(db, score, { archived, archiveSource })) insertedScores += 1;
  }
  return { insertedJobs, insertedScores };
}

export function writeScoreStoreToSqlite(
  dbPath,
  store = {},
  { archive = null, archiveSource = `score-store-archive-${nowIso().replace(/[:.]/g, "-")}` } = {},
) {
  const db = openScoreStoreDatabase(dbPath);
  try {
    ensureScoreStoreSchema(db);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM score_import_jobs WHERE archived = 0").run();
    db.prepare("DELETE FROM imported_scores WHERE archived = 0").run();
    const active = insertStore(db, store, { archived: false, archiveSource: "" });
    const archived = archive
      ? insertStore(db, archive, {
          archived: true,
          archiveSource,
        })
      : { insertedJobs: 0, insertedScores: 0 };
    db.exec("COMMIT");
    return { active, archived };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors when SQLite has already closed the transaction.
    }
    throw error;
  } finally {
    db.close();
  }
}

export function upsertScoreImportJobInSqlite(dbPath, job = {}) {
  const db = openScoreStoreDatabase(dbPath);
  try {
    ensureScoreStoreSchema(db);
    db.exec("BEGIN IMMEDIATE");
    const normalized = { ...job };
    upsertScoreImportJobRow(db, normalized, { archived: false, archiveSource: "" });
    db.exec("COMMIT");
    return normalized;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors when SQLite has already closed the transaction.
    }
    throw error;
  } finally {
    db.close();
  }
}

export function upsertImportedScoreInSqlite(dbPath, score = {}) {
  const db = openScoreStoreDatabase(dbPath);
  try {
    ensureScoreStoreSchema(db);
    db.exec("BEGIN IMMEDIATE");
    const normalized = { ...score };
    upsertImportedScoreRow(db, normalized, { archived: false, archiveSource: "" });
    db.exec("COMMIT");
    return normalized;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors when SQLite has already closed the transaction.
    }
    throw error;
  } finally {
    db.close();
  }
}

async function backupIfRequested(filePath, backupDir, backupLabel) {
  if (!filePath || !fsSync.existsSync(filePath)) return "";
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.${backupLabel}.bak`);
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

export async function migrateScoreStoreToSqlite({
  storePath,
  archiveDir,
  dbPath,
  dryRun = false,
  force = false,
  backup = true,
} = {}) {
  if (!storePath) throw new TypeError("migrateScoreStoreToSqlite requires storePath.");
  if (!archiveDir) throw new TypeError("migrateScoreStoreToSqlite requires archiveDir.");
  if (!dbPath) throw new TypeError("migrateScoreStoreToSqlite requires dbPath.");

  const backupLabel = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDir = dryRun ? await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-score-sqlite-")) : "";
  const targetDbPath = dryRun ? path.join(tempDir, path.basename(dbPath)) : dbPath;
  if (!dryRun && fsSync.existsSync(targetDbPath) && !force) {
    throw new Error(`SQLite database already exists: ${targetDbPath}. Use --force to replace it.`);
  }
  if (!dryRun && force) {
    await fs.rm(targetDbPath, { force: true });
    await fs.rm(`${targetDbPath}-shm`, { force: true });
    await fs.rm(`${targetDbPath}-wal`, { force: true });
  }

  const backupDir = path.join(path.dirname(storePath), "sqlite-backups");
  const backupPath = backup && !dryRun ? await backupIfRequested(storePath, backupDir, backupLabel) : "";
  const archiveFiles = await listArchiveFiles(archiveDir);
  const activeStore = await readJson(storePath, { jobs: [], scores: [] });
  const db = openScoreStoreDatabase(targetDbPath);
  const archiveReports = [];
  try {
    ensureScoreStoreSchema(db);
    db.exec("BEGIN IMMEDIATE");
    const active = insertStore(db, activeStore, { archived: false, archiveSource: "" });
    for (const archivePath of archiveFiles) {
      const archiveStore = await readJson(archivePath, { jobs: [], scores: [] });
      const inserted = insertStore(db, archiveStore, {
        archived: true,
        archiveSource: path.basename(archivePath),
      });
      archiveReports.push({
        archivePath,
        jobs: getArray(archiveStore.jobs).length,
        scores: getArray(archiveStore.scores).length,
        insertedJobs: inserted.insertedJobs,
        insertedScores: inserted.insertedScores,
      });
    }
    db.exec("COMMIT");
    const summary = summarizeScoreStoreSqlite(targetDbPath);
    return {
      ok: true,
      dryRun,
      dbPath: dryRun ? "" : targetDbPath,
      tempDbPath: dryRun ? targetDbPath : "",
      storePath,
      archiveDir,
      archiveFileCount: archiveFiles.length,
      active,
      archives: archiveReports,
      summary,
      backupPath,
      rollback: dryRun
        ? "dry-run only; no rollback required"
        : `Stop the app, delete ${targetDbPath}, and keep using JSON backup ${backupPath || storePath}.`,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors when SQLite has already aborted the transaction.
    }
    throw error;
  } finally {
    db.close();
    if (dryRun) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}
