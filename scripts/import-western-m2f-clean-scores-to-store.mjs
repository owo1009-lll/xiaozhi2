import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Blob } from "node:buffer";
import { pathToFileURL } from "node:url";
import { readScoreStoreFromSqlite } from "../src/server/scoreStoreSqlite.js";

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizePath(value) {
  return safeString(value).replace(/\\/g, "/");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  const normalizedHeaders = headers.map((header) => safeString(header).replace(/^\uFEFF/, ""));
  return {
    headers: normalizedHeaders,
    rows: dataRows.map((dataRow) => Object.fromEntries(normalizedHeaders.map((header, index) => [header, dataRow[index] ?? ""]))),
  };
}

async function readCsv(filePath) {
  return parseCsv(await fs.readFile(filePath, "utf8"));
}

function writeCsv(headers, rows) {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] ?? "")).join(",")),
  ].join("\n") + "\n";
}

function sha1(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

async function backupFile(filePath, stamp) {
  const backupPath = `${filePath}.bak-${stamp}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function postMusicXmlImport({
  serverUrl,
  scorePath,
  titleHint,
  selectedPartHint,
  instrument,
}) {
  const fileBuffer = await fs.readFile(scorePath);
  const formData = new FormData();
  formData.append("musicxml", new Blob([fileBuffer]), path.basename(scorePath));
  formData.append("titleHint", titleHint);
  formData.append("selectedPartHint", selectedPartHint);
  formData.append("instrument", instrument);
  formData.append("scoreSource", "musicxml");
  formData.append("tempoKnown", "false");
  formData.append("tempoSource", "unknown");
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/erhu/scores/import-musicxml`, {
    method: "POST",
    body: formData,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`MusicXML import failed for ${scorePath}: HTTP ${response.status} ${body.error || ""}`);
  }
  const scoreId = safeString(body.job?.scoreId || body.job?.reusedScoreId);
  if (!scoreId) {
    throw new Error(`MusicXML import did not return scoreId for ${scorePath}`);
  }
  return {
    scoreId,
    jobId: safeString(body.scoreImportJobId || body.job?.jobId),
  };
}

async function readScoreStore(scoreStorePath) {
  try {
    return JSON.parse(await fs.readFile(scoreStorePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { scores: [], jobs: [] };
    throw error;
  }
}

async function readScoreStoreForImport({ jsonPath, sqlitePath }) {
  if (sqlitePath && fsSync.existsSync(sqlitePath)) {
    return {
      store: readScoreStoreFromSqlite(sqlitePath),
      source: "sqlite",
      path: sqlitePath,
    };
  }
  return {
    store: await readScoreStore(jsonPath),
    source: "json",
    path: jsonPath,
  };
}

function existingScoreByMusicXmlHash(scoreStore, hash) {
  const expectedHash = `musicxml:${hash}`;
  return (Array.isArray(scoreStore.scores) ? scoreStore.scores : []).find((score) => safeString(score.pdfHash) === expectedHash);
}

function findCleanScoreRow(cleanRows, recordingId) {
  return cleanRows.find((row) => safeString(row.recordingId) === recordingId) || null;
}

function mergeHeaders(headers, extraHeaders) {
  const merged = [...headers];
  for (const header of extraHeaders) {
    if (!merged.includes(header)) merged.push(header);
  }
  return merged;
}

export async function planWesternM2fCleanScoreImports({
  repoRoot = process.cwd(),
  manifestPath = path.join("data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv"),
  cleanScoreIntakePath = path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv"),
  scoreStorePath = path.join("data", "erhu-score-imports.json"),
  scoreStoreSqlitePath = path.join("data", "erhu-score-imports.sqlite"),
} = {}) {
  const resolvedManifestPath = path.resolve(repoRoot, manifestPath);
  const resolvedCleanScoreIntakePath = path.resolve(repoRoot, cleanScoreIntakePath);
  const resolvedScoreStorePath = path.resolve(repoRoot, scoreStorePath);
  const resolvedScoreStoreSqlitePath = path.resolve(repoRoot, scoreStoreSqlitePath);
  const manifest = await readCsv(resolvedManifestPath);
  const cleanScoreIntake = await readCsv(resolvedCleanScoreIntakePath);
  const scoreStoreRead = await readScoreStoreForImport({
    jsonPath: resolvedScoreStorePath,
    sqlitePath: resolvedScoreStoreSqlitePath,
  });
  const scoreStore = scoreStoreRead.store;
  const rows = [];
  for (const manifestRow of manifest.rows) {
    const recordingId = safeString(manifestRow.recordingId);
    const cleanRow = findCleanScoreRow(cleanScoreIntake.rows, recordingId);
    const cleanScorePath = normalizePath(cleanRow?.requiredCleanScorePath || manifestRow.scorePath);
    const resolvedCleanScorePath = path.resolve(repoRoot, cleanScorePath);
    const existingScoreId = safeString(manifestRow.scoreId || cleanRow?.scoreId).trim();
    const cleanScoreReviewStatus = safeString(cleanRow?.cleanScoreReviewStatus).trim().toLowerCase();
    const fileExists = Boolean(cleanScorePath && fsSync.existsSync(resolvedCleanScorePath));
    let hash = "";
    let scoreIdByHash = "";
    if (fileExists) {
      const fileBuffer = await fs.readFile(resolvedCleanScorePath);
      hash = sha1(fileBuffer);
      scoreIdByHash = safeString(existingScoreByMusicXmlHash(scoreStore, hash)?.scoreId);
    }
    const action = existingScoreId
      ? "skip-existing-score-id"
      : scoreIdByHash
        ? "reuse-existing-score-by-hash"
        : cleanScoreReviewStatus === "approved" && fileExists
          ? "import"
          : "blocked";
    const blockers = [
      cleanScoreReviewStatus === "approved" ? "" : "clean-score-not-approved",
      fileExists ? "" : "clean-score-file-missing",
    ].filter(Boolean);
    rows.push({
      recordingId,
      pieceId: safeString(manifestRow.pieceId),
      scenario: safeString(manifestRow.scenario),
      cleanScorePath,
      cleanScoreReviewStatus,
      fileExists,
      hash,
      existingScoreId,
      scoreIdByHash,
      plannedScoreId: existingScoreId || scoreIdByHash,
      action,
      blockers,
    });
  }
  return {
    repoRoot,
    paths: {
      manifest: path.relative(repoRoot, resolvedManifestPath).replace(/\\/g, "/"),
      cleanScoreIntake: path.relative(repoRoot, resolvedCleanScoreIntakePath).replace(/\\/g, "/"),
      scoreStore: path.relative(repoRoot, resolvedScoreStorePath).replace(/\\/g, "/"),
    },
    manifest,
    cleanScoreIntake,
    scoreStorePath: resolvedScoreStorePath,
    scoreStoreSqlitePath: resolvedScoreStoreSqlitePath,
    scoreStoreSource: scoreStoreRead.source,
    rows,
    summary: {
      rowCount: rows.length,
      importCount: rows.filter((row) => row.action === "import").length,
      reuseByHashCount: rows.filter((row) => row.action === "reuse-existing-score-by-hash").length,
      existingScoreIdCount: rows.filter((row) => row.action === "skip-existing-score-id").length,
      blockedCount: rows.filter((row) => row.action === "blocked").length,
    },
  };
}

export async function applyWesternM2fCleanScoreImports({
  repoRoot = process.cwd(),
  manifestPath = path.join("data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv"),
  cleanScoreIntakePath = path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv"),
  scoreStorePath = path.join("data", "erhu-score-imports.json"),
  scoreStoreSqlitePath = path.join("data", "erhu-score-imports.sqlite"),
  serverUrl = "http://127.0.0.1:3000",
  selectedPartHint = "violin",
  instrument = "violin",
  apply = false,
} = {}) {
  const plan = await planWesternM2fCleanScoreImports({ repoRoot, manifestPath, cleanScoreIntakePath, scoreStorePath, scoreStoreSqlitePath });
  if (!apply) {
    return {
      ok: true,
      applied: false,
      scoreStoreSource: plan.scoreStoreSource,
      summary: plan.summary,
      rows: plan.rows.map(({ recordingId, pieceId, scenario, cleanScorePath, action, plannedScoreId, blockers }) => ({
        recordingId,
        pieceId,
        scenario,
        cleanScorePath,
        action,
        plannedScoreId,
        blockers,
      })),
    };
  }
  if (plan.summary.blockedCount > 0) {
    throw new Error("Cannot apply: at least one clean-score row is blocked.");
  }
  const stamp = nowStamp();
  const resolvedManifestPath = path.resolve(repoRoot, manifestPath);
  const resolvedCleanScoreIntakePath = path.resolve(repoRoot, cleanScoreIntakePath);
  const backups = [
    await backupFile(resolvedManifestPath, stamp),
    await backupFile(resolvedCleanScoreIntakePath, stamp),
  ];
  if (fsSync.existsSync(plan.scoreStorePath)) {
    backups.push(await backupFile(plan.scoreStorePath, stamp));
  }
  if (fsSync.existsSync(plan.scoreStoreSqlitePath)) {
    backups.push(await backupFile(plan.scoreStoreSqlitePath, stamp));
  }
  const imported = [];
  const failed = [];
  for (const row of plan.rows) {
    if (row.action === "skip-existing-score-id") {
      imported.push({ ...row, finalScoreId: row.existingScoreId, source: "existing-score-id" });
      continue;
    }
    if (row.action === "reuse-existing-score-by-hash") {
      imported.push({ ...row, finalScoreId: row.scoreIdByHash, source: "hash-reuse" });
      continue;
    }
    if (row.action !== "import") continue;
    try {
      const result = await postMusicXmlImport({
        serverUrl,
        scorePath: path.resolve(repoRoot, row.cleanScorePath),
        titleHint: row.pieceId || row.recordingId,
        selectedPartHint,
        instrument,
      });
      imported.push({ ...row, finalScoreId: result.scoreId, jobId: result.jobId, source: "import" });
    } catch (error) {
      failed.push({ ...row, error: String(error?.message || error) });
    }
  }
  if (failed.length) {
    return {
      ok: false,
      applied: true,
      backups: backups.map((item) => path.relative(repoRoot, item).replace(/\\/g, "/")),
      scoreStoreSource: plan.scoreStoreSource,
      imported,
      failed,
      message: "One or more imports failed. Store may contain successful partial imports; rerun will reuse by hash.",
    };
  }
  const finalScoreIdByRecordingId = new Map(imported.map((row) => [row.recordingId, row.finalScoreId]));
  const manifestHeaders = mergeHeaders(plan.manifest.headers, ["scoreId"]);
  const intakeHeaders = mergeHeaders(plan.cleanScoreIntake.headers, ["scoreId"]);
  const nextManifestRows = plan.manifest.rows.map((row) => {
    const nextScoreId = finalScoreIdByRecordingId.get(safeString(row.recordingId));
    return nextScoreId ? { ...row, scoreId: nextScoreId } : row;
  });
  const nextIntakeRows = plan.cleanScoreIntake.rows.map((row) => {
    const nextScoreId = finalScoreIdByRecordingId.get(safeString(row.recordingId));
    return nextScoreId ? { ...row, scoreId: nextScoreId } : row;
  });
  await fs.writeFile(resolvedManifestPath, writeCsv(manifestHeaders, nextManifestRows), "utf8");
  await fs.writeFile(resolvedCleanScoreIntakePath, writeCsv(intakeHeaders, nextIntakeRows), "utf8");
  return {
    ok: true,
    applied: true,
    backups: backups.map((item) => path.relative(repoRoot, item).replace(/\\/g, "/")),
    scoreStoreSource: plan.scoreStoreSource,
    imported,
    failed: [],
    updatedRows: imported.length,
  };
}

function parseArgs(argv) {
  const args = {
    apply: false,
    manifest: path.join("data", "experiments", "western-strings-m2", "real-student-recordings-manifest.csv"),
    cleanScoreIntake: path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv"),
    scoreStore: path.join("data", "erhu-score-imports.json"),
    scoreStoreSqlite: path.join("data", "erhu-score-imports.sqlite"),
    serverUrl: "http://127.0.0.1:3000",
    selectedPart: "violin",
    instrument: "violin",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (arg === "--clean-score-intake") args.cleanScoreIntake = argv[++index] || args.cleanScoreIntake;
    else if (arg === "--score-store") args.scoreStore = argv[++index] || args.scoreStore;
    else if (arg === "--score-store-sqlite") args.scoreStoreSqlite = argv[++index] || args.scoreStoreSqlite;
    else if (arg === "--server-url") args.serverUrl = argv[++index] || args.serverUrl;
    else if (arg === "--selected-part") args.selectedPart = argv[++index] || args.selectedPart;
    else if (arg === "--instrument") args.instrument = argv[++index] || args.instrument;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await applyWesternM2fCleanScoreImports({
    manifestPath: args.manifest,
    cleanScoreIntakePath: args.cleanScoreIntake,
    scoreStorePath: args.scoreStore,
    scoreStoreSqlitePath: args.scoreStoreSqlite,
    serverUrl: args.serverUrl,
    selectedPartHint: args.selectedPart,
    instrument: args.instrument,
    apply: args.apply,
  });
  console.log(JSON.stringify({
    ok: result.ok,
    applied: result.applied,
    summary: result.summary,
    scoreStoreSource: result.scoreStoreSource,
    importCount: result.imported?.filter((row) => row.source === "import").length || 0,
    reusedCount: result.imported?.filter((row) => row.source === "hash-reuse").length || 0,
    existingCount: result.imported?.filter((row) => row.source === "existing-score-id").length || 0,
    updatedRows: result.updatedRows || 0,
    failedCount: result.failed?.length || 0,
    backups: result.backups,
    message: result.message,
    rows: result.applied ? undefined : result.rows,
  }, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
