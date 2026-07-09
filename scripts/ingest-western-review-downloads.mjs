import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TARGETS = [
  {
    name: "ordinary-recalibration-validation",
    source: path.join(
      "data",
      "experiments",
      "western-strings-m3",
      "confidence-recalibration-validation-review",
      "controlled-candidate-review.csv",
    ),
    dest: path.join(
      "data",
      "experiments",
      "western-strings-m3",
      "confidence-recalibration-validation-review",
      "controlled-candidate-review.completed.csv",
    ),
    filePattern: /^controlled-candidate-review.*\.csv$/i,
    keyColumns: ["reviewRowNumber", "candidateId"],
  },
  {
    name: "m3plus-round2",
    source: path.join(
      "data",
      "experiments",
      "western-strings-m3plus",
      "pitch-mode-review-pack-round2",
      "m3plus-pitch-mode-review.csv",
    ),
    dest: path.join(
      "data",
      "experiments",
      "western-strings-m3plus",
      "pitch-mode-review-pack-round2",
      "m3plus-pitch-mode-review.completed.csv",
    ),
    filePattern: /^m3plus-pitch-mode-review.*\.csv$/i,
    keyColumns: ["rowId"],
  },
];

function parseArgs(argv) {
  const args = {
    downloadsDir: path.join(os.homedir(), "Downloads"),
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--downloads-dir") args.downloadsDir = argv[++index] || args.downloadsDir;
    else if (arg === "--apply") args.apply = true;
  }
  return args;
}

function splitCsvLine(line) {
  const cols = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cols.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines.shift());
  const rows = lines.map((line) => {
    const cols = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cols[index] ?? ""]));
  });
  return { headers, rows };
}

async function readCsv(filePath) {
  const text = await fs.readFile(path.resolve(process.cwd(), filePath), "utf8");
  return parseCsv(text);
}

function rowKey(row, columns) {
  return columns.map((column) => String(row[column] ?? "")).join("::");
}

function keySet(rows, columns) {
  return new Set(rows.map((row) => rowKey(row, columns)));
}

function sameKeys(sourceRows, candidateRows, columns) {
  if (sourceRows.length !== candidateRows.length) return false;
  const sourceKeys = keySet(sourceRows, columns);
  const candidateKeys = keySet(candidateRows, columns);
  if (sourceKeys.size !== candidateKeys.size) return false;
  for (const key of sourceKeys) {
    if (!candidateKeys.has(key)) return false;
  }
  return true;
}

async function findCandidateFiles(downloadsDir, filePattern) {
  const entries = await fs.readdir(downloadsDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !filePattern.test(entry.name)) continue;
    const fullPath = path.join(downloadsDir, entry.name);
    const stat = await fs.stat(fullPath);
    files.push({
      fullPath,
      name: entry.name,
      lastWriteTime: stat.mtime.toISOString(),
      size: stat.size,
    });
  }
  return files.sort((a, b) => String(b.lastWriteTime).localeCompare(String(a.lastWriteTime)));
}

async function inspectTarget(target, downloadsDir, apply) {
  const source = await readCsv(target.source);
  const candidates = await findCandidateFiles(downloadsDir, target.filePattern);
  const inspected = [];
  for (const candidate of candidates) {
    let parsed = { rows: [] };
    let parseError = "";
    try {
      parsed = parseCsv(await fs.readFile(candidate.fullPath, "utf8"));
    } catch (error) {
      parseError = String(error?.message || error);
    }
    const keysMatch = !parseError && sameKeys(source.rows, parsed.rows, target.keyColumns);
    inspected.push({
      file: candidate.fullPath,
      rows: parsed.rows.length,
      keysMatch,
      parseError,
      lastWriteTime: candidate.lastWriteTime,
      size: candidate.size,
    });
  }
  const match = inspected.find((item) => item.keysMatch);
  let copied = false;
  if (match && apply) {
    await fs.mkdir(path.dirname(path.resolve(process.cwd(), target.dest)), { recursive: true });
    await fs.copyFile(match.file, path.resolve(process.cwd(), target.dest));
    copied = true;
  }
  return {
    name: target.name,
    source: target.source.replace(/\\/g, "/"),
    dest: target.dest.replace(/\\/g, "/"),
    expectedRows: source.rows.length,
    matchedFile: match?.file || "",
    copied,
    status: match ? (copied ? "copied" : "match-found-dry-run") : "no-matching-download",
    inspected,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];
  for (const target of TARGETS) {
    results.push(await inspectTarget(target, args.downloadsDir, args.apply));
  }
  const ok = results.every((result) => result.status === "copied" || result.status === "match-found-dry-run");
  console.log(JSON.stringify({
    ok,
    apply: args.apply,
    downloadsDir: args.downloadsDir,
    results,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
