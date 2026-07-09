import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TODO = path.join("data", "experiments", "western-strings-m4", "independent-gold-todo.csv");
const DEFAULT_OUT_DIR = path.join("data", "private", "western-strings-m4-independent-gold");
const DEFAULT_MANIFEST = path.join("data", "experiments", "western-strings-m4", "independent-gold-workspace.csv");

function parseArgs(argv) {
  const args = {
    todo: DEFAULT_TODO,
    outDir: DEFAULT_OUT_DIR,
    manifest: DEFAULT_MANIFEST,
    overwrite: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--todo") args.todo = argv[++index] || args.todo;
    else if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
    else if (arg === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (arg === "--overwrite") args.overwrite = true;
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

function targetFileName(row) {
  const pieceId = String(row.pieceId || "piece").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `${pieceId}.independent-gold.mxl`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const todoPath = repoPath(args.todo);
  const outDir = repoPath(args.outDir);
  const manifestPath = repoPath(args.manifest);
  const todoRows = parseCsv(await fs.readFile(todoPath, "utf8"));
  await fs.mkdir(outDir, { recursive: true });

  const manifestRows = [];
  let copied = 0;
  let reused = 0;
  let missingDraft = 0;
  for (const row of todoRows) {
    const draftPath = repoPath(row.draftPath);
    const editablePath = path.join(outDir, targetFileName(row));
    const draftExists = await exists(draftPath);
    if (draftExists) {
      const editableExists = await exists(editablePath);
      if (args.overwrite || !editableExists) {
        await fs.copyFile(draftPath, editablePath);
        copied += 1;
      } else {
        reused += 1;
      }
    } else {
      missingDraft += 1;
    }
    manifestRows.push({
      recordingId: row.recordingId || "",
      pieceId: row.pieceId || "",
      scoreId: row.scoreId || "",
      sourceScorePath: row.sourceScorePath || "",
      currentGoldPath: row.goldPath || "",
      draftPath: row.draftPath || "",
      editableGoldPath: repoRelative(editablePath),
      reviewStatus: draftExists ? "needs-human-edit" : "draft-missing",
      action: "Edit editableGoldPath against sourceScorePath. Set reviewStatus=approved only after checking the score. Then run npm run western:m4-apply-independent-gold-workspace.",
    });
  }

  await writeCsv(manifestPath, manifestRows, [
    "recordingId",
    "pieceId",
    "scoreId",
    "sourceScorePath",
    "currentGoldPath",
    "draftPath",
    "editableGoldPath",
    "reviewStatus",
    "action",
  ]);

  console.log(JSON.stringify({
    ok: true,
    todoRows: todoRows.length,
    copied,
    reused,
    missingDraft,
    outDir: repoRelative(outDir),
    manifest: repoRelative(manifestPath),
    next: "Open each editableGoldPath in a MusicXML/MXL editor, correct it against sourceScorePath, set reviewStatus=approved, then run npm run western:m4-apply-independent-gold-workspace.",
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
