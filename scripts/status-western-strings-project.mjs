import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateControlledCandidateGate } from "./eval-western-controlled-candidate-gate.mjs";
import { buildControlledCandidateReviewStatus } from "./status-western-controlled-candidate-review.mjs";

const DEFAULT_OUT = path.join("data", "experiments", "western-strings-project-status.json");

const CONTROLLED_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "controlled-candidate-review-labels.csv",
);
const CONTROLLED_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "index.html",
);
const CONTROLLED_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "offline-feature-candidate-review",
  "controlled-candidate-review.completed.csv",
);
const M3PLUS_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review.csv",
);
const M3PLUS_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review-labels.csv",
);
const M3PLUS_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review.completed.csv",
);
const M3PLUS_REVIEW_PAGE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "index.html",
);

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
  }
  return args;
}

async function exists(filePath) {
  try {
    await fs.access(path.resolve(process.cwd(), filePath));
    return true;
  } catch {
    return false;
  }
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

async function readCsv(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  let text = "";
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch {
    return [];
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const headers = splitCsvLine(lines.shift());
  return lines.map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] || "";
    });
    return row;
  });
}

function isM3PlusReviewed(row) {
  return [
    "audioScoreMatch",
    "observedPitchBehavior",
    "pitchJudgementMode",
    "pitchJudgeable",
    "pitchAccuracyLabel",
    "reviewConfidence",
    "reviewComments",
  ].some((field) => String(row[field] || "").trim() !== "");
}

function isM3PlusScored(row) {
  return (
    String(row.audioScoreMatch || "").trim() === "match"
    && String(row.pitchJudgeable || "").trim() === "yes"
    && ["in-tune", "sharp", "flat", "wrong-note"].includes(String(row.pitchAccuracyLabel || "").trim())
  );
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const key = String(row[field] || "blank").trim() || "blank";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

async function buildM3PlusStatus() {
  const sourceRows = await readCsv(M3PLUS_SOURCE);
  const labelRows = await readCsv(M3PLUS_LABELS);
  const sourceIds = new Set(sourceRows.map((row) => row.rowId).filter(Boolean));
  const reviewedRows = labelRows.filter((row) => sourceIds.has(row.rowId) && isM3PlusReviewed(row));
  const scoredRows = reviewedRows.filter(isM3PlusScored);
  const sourceModeCounts = countBy(sourceRows, "candidateMode");
  const reviewedModeCounts = countBy(reviewedRows, "candidateMode");
  const scoredModeCounts = countBy(scoredRows, "candidateMode");
  const minReviewedPerMode = 5;
  const minScoredPerMode = 3;
  const perMode = {};
  for (const mode of Object.keys(sourceModeCounts).sort()) {
    const reviewed = reviewedModeCounts[mode] || 0;
    const scored = scoredModeCounts[mode] || 0;
    perMode[mode] = {
      total: sourceModeCounts[mode],
      reviewed,
      scored,
      reviewedDeficit: Math.max(0, minReviewedPerMode - reviewed),
      scoredDeficit: Math.max(0, minScoredPerMode - scored),
    };
  }
  const blockingReasons = [];
  if (!(await exists(M3PLUS_SOURCE))) blockingReasons.push("m3plus-review-source-missing");
  if (!(await exists(M3PLUS_LABELS))) blockingReasons.push("m3plus-review-labels-missing");
  if (!(await exists(M3PLUS_COMPLETED))) blockingReasons.push("m3plus-review-completed-csv-missing");
  if (Object.values(perMode).some((item) => item.reviewedDeficit > 0)) {
    blockingReasons.push("m3plus-review-reviewed-per-mode-too-low");
  }
  if (Object.values(perMode).some((item) => item.scoredDeficit > 0)) {
    blockingReasons.push("m3plus-review-scored-per-mode-too-low");
  }
  return {
    ok: true,
    m3plusModeEvalReady: blockingReasons.length === 0,
    studentGateReady: false,
    reason: "human-label-status-only",
    counts: {
      rowCount: sourceRows.length,
      labelRows: labelRows.length,
      reviewedRows: reviewedRows.length,
      scoredRows: scoredRows.length,
      missingLabelRows: Math.max(0, sourceRows.length - labelRows.length),
    },
    perMode,
    blockingReasons,
    reviewArtifacts: {
      reviewPage: M3PLUS_REVIEW_PAGE.replace(/\\/g, "/"),
      completedCsv: M3PLUS_COMPLETED.replace(/\\/g, "/"),
      labelsCsv: M3PLUS_LABELS.replace(/\\/g, "/"),
    },
  };
}

async function buildControlledStatus() {
  const report = await evaluateControlledCandidateGate({
    reviewCsvPath: CONTROLLED_LABELS,
    minReviewedRows: 30,
    minScoredRows: 30,
    minPrecision: 0.9,
  });
  const status = buildControlledCandidateReviewStatus(report);
  status.reviewArtifacts = {
    reviewPage: CONTROLLED_REVIEW_PAGE.replace(/\\/g, "/"),
    completedCsv: CONTROLLED_COMPLETED.replace(/\\/g, "/"),
    labelsCsv: CONTROLLED_LABELS.replace(/\\/g, "/"),
  };
  return status;
}

function summarizeNextActions(controlled, m3plus) {
  const actions = [];
  if (!controlled.studentSafeCandidateGateReady) {
    actions.push({
      priority: 1,
      track: "M2/M3 ordinary upload candidate gate",
      action: "Finish the current blind review batch, import it, then rerun gate/status.",
      artifact: controlled.reviewArtifacts.reviewPage,
      reason: controlled.blockingReasons,
    });
  }
  if (!m3plus.m3plusModeEvalReady) {
    actions.push({
      priority: 2,
      track: "M3+ pitch behavior modes",
      action: "Finish M3+ pitch behavior labels, import them, then evaluate per-mode precision separately.",
      artifact: m3plus.reviewArtifacts.reviewPage,
      reason: m3plus.blockingReasons,
    });
  }
  if (!actions.length) {
    actions.push({
      priority: 1,
      track: "Release review",
      action: "Both label gates have enough data for offline evaluation; run the relevant precision/unsafe checks before touching runtime gates.",
      artifact: "",
      reason: [],
    });
  }
  return actions;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [controlledCandidate, m3plusPitchModes] = await Promise.all([
    buildControlledStatus(),
    buildM3PlusStatus(),
  ]);
  const status = {
    ok: true,
    generatedAt: new Date().toISOString(),
    project: "western-strings-practice-diagnostics",
    branchGoal: "advance handbook batches without changing student runtime gates before evidence is ready",
    runtimeStudentGate: {
      ordinaryUploadAutoFeedbackReady: controlledCandidate.studentSafeCandidateGateReady,
      m3plusAutoFeedbackReady: false,
      policy: "fail-closed",
    },
    tracks: {
      controlledCandidate,
      m3plusPitchModes,
    },
    nextActions: summarizeNextActions(controlledCandidate, m3plusPitchModes),
  };
  const outPath = path.resolve(process.cwd(), args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: status.ok,
    runtimeStudentGate: status.runtimeStudentGate,
    controlledCandidate: {
      ready: controlledCandidate.studentSafeCandidateGateReady,
      counts: controlledCandidate.counts,
      blockingReasons: controlledCandidate.blockingReasons,
    },
    m3plusPitchModes: {
      ready: m3plusPitchModes.m3plusModeEvalReady,
      counts: m3plusPitchModes.counts,
      blockingReasons: m3plusPitchModes.blockingReasons,
    },
    nextActions: status.nextActions,
    out: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
