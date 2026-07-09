import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3plus", "monitored-pilot");
const DEFAULT_MODE_EVAL = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-eval.json",
);
const DEFAULT_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack",
  "m3plus-pitch-mode-review-labels.csv",
);
const DEFAULT_CANDIDATE_QUALITY_SOURCE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "m3plus-pitch-mode-review.csv",
);
const DEFAULT_CANDIDATE_QUALITY_COMPLETED = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "pitch-mode-review-pack-candidate-quality",
  "m3plus-pitch-mode-review.completed.csv",
);

const RELEASE_MODES = ["slide-like", "trill-like"];
const CONTROL_MODES = ["stable"];
const EXPECTED_BEHAVIOR = {
  "slide-like": "slide",
  "trill-like": "trill",
};

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    minPrecision: 0.9,
    minModeSpecificScored: 3,
    maxMeasureIndex: 1,
    minReviewConfidence: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
    if (arg === "--min-precision") args.minPrecision = Number(argv[++index] || args.minPrecision);
    if (arg === "--min-mode-specific-scored") args.minModeSpecificScored = Number(argv[++index] || args.minModeSpecificScored);
    if (arg === "--max-measure-index") args.maxMeasureIndex = Number(argv[++index] || args.maxMeasureIndex);
    if (arg === "--min-review-confidence") args.minReviewConfidence = Number(argv[++index] || args.minReviewConfidence);
  }
  return args;
}

function rel(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
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
  let text = "";
  try {
    text = await fs.readFile(path.resolve(process.cwd(), filePath), "utf8");
  } catch {
    return { exists: false, rows: [] };
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return { exists: true, rows: [] };
  const headers = splitCsvLine(lines.shift());
  const rows = lines.map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] || "";
    });
    return row;
  });
  return { exists: true, rows };
}

async function readJson(filePath) {
  try {
    return { exists: true, value: JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8")) };
  } catch {
    return { exists: false, value: null };
  }
}

function key(row = {}) {
  return [
    row.recordingId,
    row.scenario,
    row.noteIndex,
    row.noteId,
    row.candidateMode,
    row.flags,
    row.predictedOnsetSeconds,
  ].map((value) => String(value || "").trim()).join("\u001f");
}

function modeByName(modeEval) {
  return new Map((modeEval?.perMode || []).map((item) => [String(item.candidateMode || ""), item]));
}

function numberValue(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function exactSet(actual, expected) {
  const actualSorted = [...new Set(actual || [])].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.length === expectedSorted.length
    && actualSorted.every((item, index) => item === expectedSorted[index]);
}

function releaseEvidenceRows(labels, candidateQualityKeys, args) {
  return labels.filter((row) => {
    const mode = String(row.candidateMode || "").trim();
    if (!RELEASE_MODES.includes(mode)) return false;
    if (!candidateQualityKeys.has(key(row))) return false;
    if (String(row.audioScoreMatch || "").trim() !== "match") return false;
    if (String(row.pitchJudgeable || "").trim() !== "yes") return false;
    if (String(row.observedPitchBehavior || "").trim() !== EXPECTED_BEHAVIOR[mode]) return false;
    if (!["in-tune", "sharp", "flat", "wrong-note"].includes(String(row.pitchAccuracyLabel || "").trim())) return false;
    if (numberValue(row.measureIndex, Number.POSITIVE_INFINITY) > args.maxMeasureIndex) return false;
    if (numberValue(row.reviewConfidence, 0) < args.minReviewConfidence) return false;
    return true;
  });
}

function renderMarkdown(report) {
  const releaseLines = Object.entries(report.releaseModes).flatMap(([mode, item]) => [
    `### ${mode}`,
    "",
    `- ready: ${item.ready}`,
    `- modeSpecificScored: ${item.modeSpecificScored}`,
    `- modeSpecificPrecision: ${item.modeSpecificPrecision}`,
    `- modeSpecificUnsafe: ${item.modeSpecificUnsafe}`,
    `- evidenceRows: ${item.evidenceRows}`,
    `- recordings: ${item.recordingIds.join(", ") || "none"}`,
    "",
  ]);
  return [
    "# M3+ Monitored Pilot Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Decision",
    "",
    `- ok: ${report.ok}`,
    `- readyForMonitoredPilot: ${report.readyForMonitoredPilot}`,
    `- teacherReviewNeeded: ${report.teacherReviewNeeded}`,
    `- defaultM3PlusReadyAfter: ${report.defaultM3PlusReadyAfter}`,
    "",
    "## Scope",
    "",
    `- allowedReleaseModes: ${report.scope.allowedReleaseModes.join(", ")}`,
    `- controlModes: ${report.scope.controlModes.join(", ")}`,
    `- maxMeasureIndex: ${report.scope.maxMeasureIndex}`,
    "- Release evidence must come from the completed candidate-quality pack.",
    "- Later measures and non-release modes remain review_required.",
    "",
    "## Release Modes",
    "",
    ...releaseLines,
    "## Blocked Modes",
    "",
    ...(report.blockedModes.length ? report.blockedModes.map((mode) => `- ${mode}`) : ["- none"]),
    "",
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "## Safety Notes",
    "",
    "- This audit does not enable the default student runtime.",
    "- This is not technique-name display; it only validates pitch-judgement modes.",
    "- If any unknown or unsafe evidence appears, stop and keep M3+ review-only.",
    "",
  ].join("\n");
}

export async function runM3PlusMonitoredPilotAudit(args = {}) {
  const options = { ...parseArgs([]), ...args };
  const outDir = path.resolve(process.cwd(), options.outDir);
  const modeEvalRead = await readJson(DEFAULT_MODE_EVAL);
  const labelsRead = await readCsv(DEFAULT_LABELS);
  const candidateSourceRead = await readCsv(DEFAULT_CANDIDATE_QUALITY_SOURCE);
  const candidateCompletedRead = await readCsv(DEFAULT_CANDIDATE_QUALITY_COMPLETED);
  const modeEval = modeEvalRead.value;
  const perMode = modeByName(modeEval);
  const candidateQualityKeys = new Set(candidateSourceRead.rows.map(key));
  const completedQualityKeys = new Set(candidateCompletedRead.rows.map(key));
  const evidenceRows = releaseEvidenceRows(labelsRead.rows, candidateQualityKeys, options);
  const evidenceByMode = new Map(RELEASE_MODES.map((mode) => [mode, evidenceRows.filter((row) => row.candidateMode === mode)]));
  const blockingReasons = [];

  if (!modeEvalRead.exists) blockingReasons.push("m3plus-mode-eval-missing");
  if (!labelsRead.exists) blockingReasons.push("m3plus-labels-missing");
  if (!candidateSourceRead.exists) blockingReasons.push("m3plus-candidate-quality-source-missing");
  if (!candidateCompletedRead.exists) blockingReasons.push("m3plus-candidate-quality-completed-missing");
  if (modeEval?.ok !== true) blockingReasons.push("m3plus-mode-eval-not-ok");
  if (modeEval?.studentGateReady === true || modeEval?.runtimeEffect !== "none") {
    blockingReasons.push("m3plus-runtime-not-fail-closed");
  }
  if (!exactSet(modeEval?.releaseReadyModes || [], RELEASE_MODES)) {
    blockingReasons.push(`m3plus-release-modes-unexpected:${(modeEval?.releaseReadyModes || []).join("|")}`);
  }
  if (!CONTROL_MODES.every((mode) => (modeEval?.controlReadyModes || []).includes(mode))) {
    blockingReasons.push("m3plus-control-mode-missing");
  }

  for (const row of candidateSourceRead.rows) {
    if (numberValue(row.measureIndex, Number.POSITIVE_INFINITY) > options.maxMeasureIndex) {
      blockingReasons.push(`m3plus-candidate-quality-non-first-measure:${row.rowId || key(row)}`);
    }
    if (![...RELEASE_MODES, "variable-f0"].includes(String(row.candidateMode || "").trim())) {
      blockingReasons.push(`m3plus-candidate-quality-unexpected-mode:${row.candidateMode || "blank"}`);
    }
  }
  for (const row of candidateCompletedRead.rows) {
    const match = String(row.audioScoreMatch || "").trim();
    if (match !== "match") {
      blockingReasons.push(`m3plus-candidate-quality-nonmatch:${row.rowId || key(row)}:${match || "blank"}`);
    }
    if (!candidateQualityKeys.has(key(row))) {
      blockingReasons.push(`m3plus-candidate-quality-completed-unknown-row:${row.rowId || key(row)}`);
    }
  }
  for (const row of candidateSourceRead.rows) {
    if (!completedQualityKeys.has(key(row))) {
      blockingReasons.push(`m3plus-candidate-quality-unreviewed-row:${row.rowId || key(row)}`);
    }
  }

  const releaseModes = {};
  for (const mode of RELEASE_MODES) {
    const item = perMode.get(mode) || {};
    const rows = evidenceByMode.get(mode) || [];
    const modeSpecificScored = numberValue(item.modeSpecificScored, 0);
    const modeSpecificPrecision = Number(item.modeSpecificPrecision);
    const modeSpecificUnsafe = numberValue(item.modeSpecificUnsafe, 0);
    if (item.releaseReady !== true) blockingReasons.push(`m3plus-release-mode-not-ready:${mode}`);
    if (modeSpecificScored < options.minModeSpecificScored) blockingReasons.push(`m3plus-release-mode-scored-too-low:${mode}`);
    if (!Number.isFinite(modeSpecificPrecision) || modeSpecificPrecision < options.minPrecision) {
      blockingReasons.push(`m3plus-release-mode-precision-too-low:${mode}`);
    }
    if (modeSpecificUnsafe !== 0) blockingReasons.push(`m3plus-release-mode-unsafe:${mode}`);
    if (rows.length < options.minModeSpecificScored) blockingReasons.push(`m3plus-release-mode-evidence-rows-too-low:${mode}`);
    releaseModes[mode] = {
      ready: item.releaseReady === true
        && modeSpecificScored >= options.minModeSpecificScored
        && Number.isFinite(modeSpecificPrecision)
        && modeSpecificPrecision >= options.minPrecision
        && modeSpecificUnsafe === 0
        && rows.length >= options.minModeSpecificScored,
      modeSpecificScored,
      modeSpecificPrecision: Number.isFinite(modeSpecificPrecision) ? modeSpecificPrecision : null,
      modeSpecificUnsafe,
      evidenceRows: rows.length,
      recordingIds: [...new Set(rows.map((row) => row.recordingId).filter(Boolean))].sort(),
      rowIds: rows.map((row) => row.rowId || key(row)),
    };
  }

  const blockedModes = [];
  for (const item of modeEval?.perMode || []) {
    const mode = String(item.candidateMode || "");
    if (RELEASE_MODES.includes(mode) || CONTROL_MODES.includes(mode)) continue;
    blockedModes.push(mode);
    if (item.releaseReady === true) blockingReasons.push(`m3plus-nonrelease-mode-ready:${mode}`);
  }

  const uniqueBlockingReasons = [...new Set(blockingReasons)];
  const report = {
    ok: uniqueBlockingReasons.length === 0,
    generatedAt: new Date().toISOString(),
    readyForMonitoredPilot: uniqueBlockingReasons.length === 0,
    teacherReviewNeeded: false,
    defaultM3PlusReadyAfter: false,
    scope: {
      allowedReleaseModes: RELEASE_MODES,
      controlModes: CONTROL_MODES,
      maxMeasureIndex: options.maxMeasureIndex,
      minPrecision: options.minPrecision,
      minModeSpecificScored: options.minModeSpecificScored,
      minReviewConfidence: options.minReviewConfidence,
    },
    inputs: {
      modeEval: DEFAULT_MODE_EVAL.replace(/\\/g, "/"),
      labels: DEFAULT_LABELS.replace(/\\/g, "/"),
      candidateQualitySource: DEFAULT_CANDIDATE_QUALITY_SOURCE.replace(/\\/g, "/"),
      candidateQualityCompleted: DEFAULT_CANDIDATE_QUALITY_COMPLETED.replace(/\\/g, "/"),
    },
    counts: {
      labelRows: labelsRead.rows.length,
      candidateQualityRows: candidateSourceRead.rows.length,
      completedCandidateQualityRows: candidateCompletedRead.rows.length,
      releaseEvidenceRows: evidenceRows.length,
    },
    releaseModes,
    blockedModes,
    blockingReasons: uniqueBlockingReasons,
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "m3plus-monitored-pilot-audit.json");
  const mdPath = path.join(outDir, "m3plus-monitored-pilot-audit.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  return { report, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { report, jsonPath, mdPath } = await runM3PlusMonitoredPilotAudit(args);
  console.log(JSON.stringify({
    ok: report.ok,
    readyForMonitoredPilot: report.readyForMonitoredPilot,
    teacherReviewNeeded: report.teacherReviewNeeded,
    defaultM3PlusReadyAfter: report.defaultM3PlusReadyAfter,
    releaseModes: report.releaseModes,
    blockedModes: report.blockedModes,
    blockingReasons: report.blockingReasons,
    out: {
      json: rel(jsonPath),
      md: rel(mdPath),
    },
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
