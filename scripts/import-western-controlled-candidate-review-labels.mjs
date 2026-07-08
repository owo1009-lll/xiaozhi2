import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTROLLED_CANDIDATE_REVIEW_HEADERS,
  controlledCandidateRowsToCsv,
} from "./export-western-controlled-candidate-review.mjs";

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
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
  return dataRows.map((dataRow) => Object.fromEntries(headers.map((header, index) => [header, dataRow[index] ?? ""])));
}

function normalizeStatus(value) {
  const status = safeString(value).trim().toLowerCase();
  return ["usable", "wrong", "uncertain"].includes(status) ? status : "";
}

function candidateKey(row) {
  return [
    safeString(row.batchRunId),
    safeString(row.submissionId),
    safeString(row.candidateId),
  ].join("::");
}

async function readCsvRows(filePath) {
  try {
    return parseCsv(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function mergeControlledCandidateReviewLabels({
  reviewsPath,
  labelsPath = path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
} = {}) {
  if (!reviewsPath) {
    throw new Error("--reviews is required");
  }
  const resolvedReviewsPath = path.resolve(process.cwd(), reviewsPath);
  const resolvedLabelsPath = path.resolve(process.cwd(), labelsPath);
  const incomingRows = (await readCsvRows(resolvedReviewsPath))
    .map((row) => ({ ...row, teacherCandidateStatus: normalizeStatus(row.teacherCandidateStatus) }))
    .filter((row) => row.teacherCandidateStatus);
  const existingRows = await readCsvRows(resolvedLabelsPath);
  const rowsByKey = new Map();
  for (const row of existingRows) {
    const key = candidateKey(row);
    if (key.replace(/:/g, "")) rowsByKey.set(key, row);
  }
  let inserted = 0;
  let updated = 0;
  for (const row of incomingRows) {
    const key = candidateKey(row);
    if (!key.replace(/:/g, "")) continue;
    if (rowsByKey.has(key)) updated += 1;
    else inserted += 1;
    rowsByKey.set(key, row);
  }
  const mergedRows = [...rowsByKey.values()].sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
  await fs.mkdir(path.dirname(resolvedLabelsPath), { recursive: true });
  await fs.writeFile(resolvedLabelsPath, controlledCandidateRowsToCsv(mergedRows), "utf8");
  return {
    ok: true,
    source: path.relative(process.cwd(), resolvedReviewsPath).replace(/\\/g, "/"),
    labelsPath: path.relative(process.cwd(), resolvedLabelsPath).replace(/\\/g, "/"),
    incomingReviewedRows: incomingRows.length,
    inserted,
    updated,
    totalRows: mergedRows.length,
  };
}

function parseArgs(argv) {
  const args = {
    reviews: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review.completed.csv"),
    labels: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reviews") args.reviews = argv[++index] || args.reviews;
    else if (arg === "--labels") args.labels = argv[++index] || args.labels;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await mergeControlledCandidateReviewLabels({
    reviewsPath: args.reviews,
    labelsPath: args.labels,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
