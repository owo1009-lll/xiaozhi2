import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFEST = path.join("data", "experiments", "western-strings-m4", "independent-gold-workspace.csv");
const DEFAULT_INTAKE = path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv");

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    intake: DEFAULT_INTAKE,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (arg === "--intake") args.intake = argv[++index] || args.intake;
    else if (arg === "--dry-run") args.dryRun = true;
  }
  return args;
}

function repoPath(value) {
  return path.isAbsolute(String(value || "")) ? String(value) : path.join(process.cwd(), String(value || ""));
}

function repoRelative(value) {
  const relative = path.relative(process.cwd(), value).replace(/\\/g, "/");
  return relative.startsWith("..") ? value.replace(/\\/g, "/") : relative;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [headers = [], ...items] = rows;
  return {
    headers,
    rows: items
      .filter((item) => item.some((value) => String(value || "").trim()))
      .map((item) => Object.fromEntries(headers.map((header, index) => [header, item[index] || ""]))),
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(filePath, rows, headers) {
  const text = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] || "")).join(",")),
  ].join("\n") + "\n";
  await fs.writeFile(filePath, text, "utf8");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha1(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha1").update(data).digest("hex");
}

function rowKey(row) {
  return `${row.recordingId || ""}::${row.pieceId || ""}`;
}

function timestamp() {
  const now = new Date();
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = repoPath(args.manifest);
  const intakePath = repoPath(args.intake);
  const { rows: manifestRows } = parseCsv(await fs.readFile(manifestPath, "utf8"));
  const { headers: intakeHeaders, rows: intakeRows } = parseCsv(await fs.readFile(intakePath, "utf8"));
  const intakeByKey = new Map(intakeRows.map((row) => [rowKey(row), row]));

  const applied = [];
  const skipped = [];
  for (const row of manifestRows) {
    const editablePath = repoPath(row.editableGoldPath);
    const draftPath = repoPath(row.draftPath);
    if (String(row.reviewStatus || "").trim().toLowerCase() !== "approved") {
      skipped.push({ ...row, reason: "review-status-not-approved" });
      continue;
    }
    if (!(await exists(editablePath))) {
      skipped.push({ ...row, reason: "editable-gold-missing" });
      continue;
    }
    if (!(await exists(draftPath))) {
      skipped.push({ ...row, reason: "draft-missing" });
      continue;
    }
    const editableHash = await sha1(editablePath);
    const draftHash = await sha1(draftPath);
    if (editableHash === draftHash) {
      skipped.push({ ...row, reason: "editable-gold-still-identical-to-draft" });
      continue;
    }
    const intakeRow = intakeByKey.get(rowKey(row));
    if (!intakeRow) {
      skipped.push({ ...row, reason: "intake-row-missing" });
      continue;
    }
    intakeRow.requiredCleanScorePath = repoRelative(editablePath);
    intakeRow.cleanScoreReviewStatus = "approved";
    intakeRow.cleanScoreReviewNotes = [
      intakeRow.cleanScoreReviewNotes || "",
      `M4 independent gold applied ${new Date().toISOString()}`,
    ].filter(Boolean).join(" | ");
    applied.push({
      recordingId: row.recordingId || "",
      pieceId: row.pieceId || "",
      editableGoldPath: repoRelative(editablePath),
    });
  }

  let backup = "";
  if (!args.dryRun && applied.length) {
    backup = `${intakePath}.bak-${timestamp()}`;
    await fs.copyFile(intakePath, backup);
    await writeCsv(intakePath, intakeRows, intakeHeaders);
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    manifest: repoRelative(manifestPath),
    intake: repoRelative(intakePath),
    backup: backup ? repoRelative(backup) : "",
    appliedRows: applied.length,
    skippedRows: skipped.length,
    applied,
    skipped: skipped.map((row) => ({
      recordingId: row.recordingId || "",
      pieceId: row.pieceId || "",
      reason: row.reason,
    })),
    next: applied.length
      ? "Run npm run western:m4-omr-benchmark and npm run western:project-status."
      : "No independent gold was applied. Edit the workspace MXL files so their SHA differs from the draft, set reviewStatus=approved for checked rows, then rerun this command.",
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
