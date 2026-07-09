import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_INTAKE = path.join("data", "experiments", "western-strings-m2", "clean-score-intake.csv");
const DEFAULT_WORKSPACE = path.join("data", "experiments", "western-strings-m4", "independent-gold-workspace.csv");
const DEFAULT_OUT = path.join("data", "experiments", "western-strings-m4", "gold-provenance-audit.json");
const DEFAULT_CSV = path.join("data", "experiments", "western-strings-m4", "gold-provenance-audit.csv");

function parseArgs(argv) {
  const args = {
    intake: DEFAULT_INTAKE,
    workspace: DEFAULT_WORKSPACE,
    out: DEFAULT_OUT,
    csv: DEFAULT_CSV,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--intake") args.intake = argv[++index] || args.intake;
    else if (arg === "--workspace") args.workspace = argv[++index] || args.workspace;
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

function rowKey(row) {
  return `${row.recordingId || ""}::${row.pieceId || ""}`;
}

function isCleanScoreFile(filePath) {
  return [".mxl", ".musicxml", ".xml", ".mid", ".midi"].includes(path.extname(filePath).toLowerCase());
}

async function collectPieceNamedScoreCandidates(pieceIds) {
  const roots = [
    path.join(process.cwd(), "data", "private"),
    path.join(process.cwd(), "data", "experiments"),
  ];
  const pieceSet = new Set(pieceIds.filter(Boolean));
  const candidates = new Map();
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".venv" || entry.name === "node_modules") continue;
        await walk(fullPath);
      } else if (entry.isFile() && isCleanScoreFile(fullPath)) {
        const base = path.basename(fullPath).toLowerCase();
        for (const pieceId of pieceSet) {
          if (base.includes(pieceId.toLowerCase())) {
            const existing = candidates.get(pieceId) || [];
            existing.push(fullPath);
            candidates.set(pieceId, existing);
          }
        }
      }
    }
  }
  for (const root of roots) {
    await walk(root);
  }
  return candidates;
}

function cleanNotes(value) {
  return String(value || "").toLowerCase();
}

function hasAudiverisStagingEvidence(intakeRow) {
  const notes = cleanNotes(intakeRow.cleanScoreReviewNotes);
  return notes.includes("audiveris draft staged") || notes.includes("audiveris");
}

function filterAlternativeCandidates(pieceId, candidates, knownPaths) {
  const known = new Set([...knownPaths].filter(Boolean).map((item) => repoRelative(repoPath(item)).toLowerCase()));
  return (candidates.get(pieceId) || [])
    .map((item) => repoRelative(item))
    .filter((item) => {
      const lower = item.toLowerCase();
      if (known.has(lower)) return false;
      if (lower.includes("/audiveris-draft/")) return false;
      if (lower.includes("/western-strings-m4-independent-gold/")) return false;
      if (lower.includes("/western-strings-m2/") && lower.endsWith(`/${pieceId.toLowerCase()}.mxl`)) return false;
      return true;
    });
}

async function auditRows(intakeRows, workspaceRows) {
  const intakeByKey = new Map(intakeRows.map((row) => [rowKey(row), row]));
  const candidates = await collectPieceNamedScoreCandidates(workspaceRows.map((row) => row.pieceId || ""));
  const rows = [];
  for (const workspaceRow of workspaceRows) {
    const intakeRow = intakeByKey.get(rowKey(workspaceRow)) || {};
    const currentGoldPath = workspaceRow.currentGoldPath || intakeRow.requiredCleanScorePath || "";
    const draftPath = workspaceRow.draftPath || "";
    const editableGoldPath = workspaceRow.editableGoldPath || "";
    const sourceScorePath = workspaceRow.sourceScorePath || intakeRow.currentScorePath || "";
    const [currentGoldHash, draftHash, editableHash] = await Promise.all([
      sha1IfExists(repoPath(currentGoldPath)),
      sha1IfExists(repoPath(draftPath)),
      sha1IfExists(repoPath(editableGoldPath)),
    ]);
    const currentGoldEqualsDraft = Boolean(currentGoldHash && draftHash && currentGoldHash === draftHash);
    const editableEqualsDraft = Boolean(editableHash && draftHash && editableHash === draftHash);
    const editableEqualsCurrentGold = Boolean(editableHash && currentGoldHash && editableHash === currentGoldHash);
    const alternativeCandidates = filterAlternativeCandidates(workspaceRow.pieceId || "", candidates, [
      currentGoldPath,
      draftPath,
      editableGoldPath,
    ]);
    const sourceScoreType = intakeRow.currentScoreType || (isCleanScoreFile(sourceScorePath) ? "clean-score" : "image-or-unsupported");
    const audiverisStaged = hasAudiverisStagingEvidence(intakeRow);
    const manualGoldRequired = currentGoldEqualsDraft && editableEqualsDraft && alternativeCandidates.length === 0;
    const issues = [];
    if (sourceScoreType !== "clean-score") issues.push("source-score-is-image");
    if (currentGoldEqualsDraft) issues.push("current-gold-equals-draft");
    if (editableEqualsDraft) issues.push("editable-gold-equals-draft");
    if (editableEqualsCurrentGold) issues.push("editable-gold-equals-current-gold");
    if (audiverisStaged) issues.push("intake-notes-mention-audiveris-staging");
    if (alternativeCandidates.length === 0) issues.push("no-independent-clean-score-found");
    if (manualGoldRequired) issues.push("manual-score-editor-gold-required");
    rows.push({
      recordingId: workspaceRow.recordingId || "",
      pieceId: workspaceRow.pieceId || "",
      sourceScoreType,
      cleanScoreReviewStatus: intakeRow.cleanScoreReviewStatus || "",
      sourceScorePath,
      currentGoldPath,
      draftPath,
      editableGoldPath,
      currentGoldEqualsDraft: currentGoldEqualsDraft ? "yes" : "no",
      editableEqualsDraft: editableEqualsDraft ? "yes" : "no",
      editableEqualsCurrentGold: editableEqualsCurrentGold ? "yes" : "no",
      intakeNotesMentionAudiveris: audiverisStaged ? "yes" : "no",
      independentCandidateCount: String(alternativeCandidates.length),
      independentCandidates: alternativeCandidates.join("|"),
      manualGoldRequired: manualGoldRequired ? "yes" : "no",
      issues: issues.join("|"),
    });
  }
  return rows;
}

function count(rows, predicate) {
  return rows.filter(predicate).length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const intakePath = repoPath(args.intake);
  const workspacePath = repoPath(args.workspace);
  const outPath = repoPath(args.out);
  const csvPath = repoPath(args.csv);
  const intakeRows = parseCsv(await fs.readFile(intakePath, "utf8"));
  const workspaceRows = parseCsv(await fs.readFile(workspacePath, "utf8"));
  const rows = await auditRows(intakeRows, workspaceRows);
  const counts = {
    rows: rows.length,
    imageSourceRows: count(rows, (row) => row.sourceScoreType !== "clean-score"),
    currentGoldEqualsDraftRows: count(rows, (row) => row.currentGoldEqualsDraft === "yes"),
    editableEqualsDraftRows: count(rows, (row) => row.editableEqualsDraft === "yes"),
    audiverisStagingEvidenceRows: count(rows, (row) => row.intakeNotesMentionAudiveris === "yes"),
    independentCandidateRows: count(rows, (row) => Number(row.independentCandidateCount || 0) > 0),
    manualGoldRequiredRows: count(rows, (row) => row.manualGoldRequired === "yes"),
  };
  const report = {
    ok: true,
    intake: repoRelative(intakePath),
    workspace: repoRelative(workspacePath),
    csv: repoRelative(csvPath),
    counts,
    teacherReviewNeeded: false,
    humanTask: counts.manualGoldRequiredRows > 0 ? "score-editor-independent-gold-correction" : "none",
    conclusion: counts.manualGoldRequiredRows > 0
      ? "Current gold is not independent enough for OMR benchmarking; use score-editor correction against source score images before asking for any teacher review."
      : "Independent clean-score candidates were found; inspect the candidate list before asking for manual correction.",
    rows,
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeCsv(csvPath, rows, [
    "recordingId",
    "pieceId",
    "sourceScoreType",
    "cleanScoreReviewStatus",
    "currentGoldEqualsDraft",
    "editableEqualsDraft",
    "editableEqualsCurrentGold",
    "intakeNotesMentionAudiveris",
    "independentCandidateCount",
    "manualGoldRequired",
    "issues",
    "independentCandidates",
    "sourceScorePath",
    "currentGoldPath",
    "draftPath",
    "editableGoldPath",
  ]);
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
