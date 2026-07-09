import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFEST = path.join("data", "experiments", "western-strings-m4", "independent-gold-workspace.csv");
const DEFAULT_OUT = path.join("data", "experiments", "western-strings-m4", "independent-gold-workspace-audit.json");
const DEFAULT_CSV = path.join("data", "experiments", "western-strings-m4", "independent-gold-workspace-audit.csv");

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    out: DEFAULT_OUT,
    csv: DEFAULT_CSV,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--csv") args.csv = argv[++index] || args.csv;
  }
  return args;
}

function repoPath(value) {
  const text = String(value || "");
  return path.isAbsolute(text) ? text : path.join(process.cwd(), text);
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
  return items
    .filter((item) => item.some((value) => String(value || "").trim()))
    .map((item) => Object.fromEntries(headers.map((header, index) => [header, item[index] || ""])));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(filePath, rows, headers) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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

async function sha1IfExists(filePath) {
  if (!(await exists(filePath))) return "";
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha1").update(data).digest("hex");
}

function statusOf(row) {
  return String(row.reviewStatus || "").trim().toLowerCase();
}

async function auditRow(row) {
  const sourcePath = repoPath(row.sourceScorePath);
  const currentGoldPath = repoPath(row.currentGoldPath);
  const draftPath = repoPath(row.draftPath);
  const editablePath = repoPath(row.editableGoldPath);
  const [sourceExists, currentGoldExists, draftExists, editableExists] = await Promise.all([
    exists(sourcePath),
    exists(currentGoldPath),
    exists(draftPath),
    exists(editablePath),
  ]);
  const [currentGoldHash, draftHash, editableHash] = await Promise.all([
    sha1IfExists(currentGoldPath),
    sha1IfExists(draftPath),
    sha1IfExists(editablePath),
  ]);
  const reviewStatus = statusOf(row);
  const approved = reviewStatus === "approved";
  const editableDiffersFromDraft = Boolean(editableHash && draftHash && editableHash !== draftHash);
  const editableEqualsDraft = Boolean(editableHash && draftHash && editableHash === draftHash);
  const editableEqualsCurrentGold = Boolean(editableHash && currentGoldHash && editableHash === currentGoldHash);
  const issues = [];
  if (!sourceExists) issues.push("source-score-missing");
  if (!currentGoldExists) issues.push("current-gold-missing");
  if (!draftExists) issues.push("draft-missing");
  if (!editableExists) issues.push("editable-gold-missing");
  if (!approved) issues.push("review-status-not-approved");
  if (editableEqualsDraft) issues.push("editable-gold-still-identical-to-draft");
  if (editableDiffersFromDraft && !approved) issues.push("changed-but-not-approved");
  const applyReady = approved && sourceExists && currentGoldExists && draftExists && editableExists && editableDiffersFromDraft;
  if (applyReady) issues.push("apply-ready");
  return {
    recordingId: row.recordingId || "",
    pieceId: row.pieceId || "",
    reviewStatus,
    sourceScorePath: row.sourceScorePath || "",
    currentGoldPath: row.currentGoldPath || "",
    draftPath: row.draftPath || "",
    editableGoldPath: row.editableGoldPath || "",
    sourceExists: sourceExists ? "yes" : "no",
    currentGoldExists: currentGoldExists ? "yes" : "no",
    draftExists: draftExists ? "yes" : "no",
    editableExists: editableExists ? "yes" : "no",
    editableDiffersFromDraft: editableDiffersFromDraft ? "yes" : "no",
    editableEqualsCurrentGold: editableEqualsCurrentGold ? "yes" : "no",
    applyReady: applyReady ? "yes" : "no",
    issues: issues.join("|"),
  };
}

function countRows(rows, predicate) {
  return rows.filter(predicate).length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = repoPath(args.manifest);
  const outPath = repoPath(args.out);
  const csvPath = repoPath(args.csv);
  const manifestExists = await exists(manifestPath);
  if (!manifestExists) {
    const report = {
      ok: false,
      reason: "manifest-missing",
      manifest: repoRelative(manifestPath),
      next: "Run npm run western:m4-independent-gold-workspace first.",
    };
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const rows = parseCsv(await fs.readFile(manifestPath, "utf8"));
  const auditRows = [];
  for (const row of rows) {
    auditRows.push(await auditRow(row));
  }

  const readyToApplyRows = countRows(auditRows, (row) => row.applyReady === "yes");
  const changedButNotApprovedRows = countRows(auditRows, (row) => row.issues.includes("changed-but-not-approved"));
  const approvedButUnchangedRows = countRows(
    auditRows,
    (row) => row.reviewStatus === "approved" && row.issues.includes("editable-gold-still-identical-to-draft"),
  );
  const missingFileRows = countRows(
    auditRows,
    (row) => row.sourceExists === "no" || row.currentGoldExists === "no" || row.draftExists === "no" || row.editableExists === "no",
  );
  const pendingRows = countRows(auditRows, (row) => row.reviewStatus !== "approved");
  const issueCounts = {};
  for (const row of auditRows) {
    for (const issue of String(row.issues || "").split("|").filter(Boolean)) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
  }

  await writeCsv(csvPath, auditRows, [
    "recordingId",
    "pieceId",
    "reviewStatus",
    "sourceExists",
    "currentGoldExists",
    "draftExists",
    "editableExists",
    "editableDiffersFromDraft",
    "editableEqualsCurrentGold",
    "applyReady",
    "issues",
    "sourceScorePath",
    "currentGoldPath",
    "draftPath",
    "editableGoldPath",
  ]);

  const report = {
    ok: true,
    manifest: repoRelative(manifestPath),
    csv: repoRelative(csvPath),
    counts: {
      rows: auditRows.length,
      readyToApplyRows,
      pendingRows,
      changedButNotApprovedRows,
      approvedButUnchangedRows,
      missingFileRows,
      issueCounts,
    },
    humanTask: "score-editor-independent-gold-correction",
    teacherReviewNeeded: false,
    readyForApply: readyToApplyRows > 0 && changedButNotApprovedRows === 0 && approvedButUnchangedRows === 0 && missingFileRows === 0,
    rows: auditRows,
    next: readyToApplyRows
      ? "Run npm run western:m4-apply-independent-gold-workspace -- --dry-run before applying."
      : "Edit the workspace MXL files against source score images, then set reviewStatus=approved only for checked rows.",
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
