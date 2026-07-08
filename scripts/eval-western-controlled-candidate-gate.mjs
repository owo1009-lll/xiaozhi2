import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numeric(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function buildRules() {
  const rules = [
    {
      ruleId: "pitch-support-within-80cents",
      description: "pitchSupportWithin80Cents=yes",
      predicate: (row) => safeString(row.pitchSupportWithin80Cents).toLowerCase() === "yes",
    },
  ];
  for (const cents of [25, 35, 50, 80]) {
    for (const minVoicedFrames of [2, 4, 6]) {
      rules.push({
        ruleId: `abs-cents<=${cents}-voiced>=${minVoicedFrames}`,
        description: `abs(centsError)<=${cents} and voicedFrameCount>=${minVoicedFrames}`,
        predicate: (row) => {
          const centsError = numeric(row.centsError);
          const voicedFrameCount = numeric(row.voicedFrameCount, 0);
          return centsError !== null && Math.abs(centsError) <= cents && voicedFrameCount >= minVoicedFrames;
        },
      });
    }
  }
  return rules;
}

function evaluateRule(rows, rule) {
  const reviewedRows = rows.filter((row) => normalizeStatus(row.teacherCandidateStatus));
  const scoredRows = reviewedRows.filter((row) => ["usable", "wrong"].includes(normalizeStatus(row.teacherCandidateStatus)));
  const selected = scoredRows.filter(rule.predicate);
  const usable = selected.filter((row) => normalizeStatus(row.teacherCandidateStatus) === "usable").length;
  const wrong = selected.filter((row) => normalizeStatus(row.teacherCandidateStatus) === "wrong").length;
  const precision = selected.length ? usable / selected.length : null;
  const coverage = scoredRows.length ? selected.length / scoredRows.length : 0;
  return {
    ruleId: rule.ruleId,
    description: rule.description,
    selectedCount: selected.length,
    usableCount: usable,
    wrongCount: wrong,
    precision: precision === null ? null : Number(precision.toFixed(6)),
    coverage: Number(coverage.toFixed(6)),
  };
}

export async function evaluateControlledCandidateGate({
  reviewCsvPath,
  minReviewedRows = 30,
  minScoredRows = minReviewedRows,
  minPrecision = 0.9,
} = {}) {
  const csvPath = path.resolve(process.cwd(), reviewCsvPath || path.join(
    "data",
    "experiments",
    "western-strings-m3",
    "offline-feature-candidate-review",
    "controlled-candidate-review-labels.csv",
  ));
  let rows = [];
  let sourceExists = false;
  try {
    rows = parseCsv(await fs.readFile(csvPath, "utf8"));
    sourceExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const statusCounts = { usable: 0, wrong: 0, uncertain: 0, blank: 0 };
  for (const row of rows) {
    const status = normalizeStatus(row.teacherCandidateStatus);
    if (status) statusCounts[status] += 1;
    else statusCounts.blank += 1;
  }
  const reviewedRows = statusCounts.usable + statusCounts.wrong + statusCounts.uncertain;
  const scoredRows = statusCounts.usable + statusCounts.wrong;
  const ruleEvaluations = buildRules()
    .map((rule) => evaluateRule(rows, rule))
    .sort((left, right) => {
      const leftReadyPrecision = left.precision ?? -1;
      const rightReadyPrecision = right.precision ?? -1;
      if (leftReadyPrecision !== rightReadyPrecision) return rightReadyPrecision - leftReadyPrecision;
      return right.selectedCount - left.selectedCount;
    });
  const eligibleRules = ruleEvaluations.filter((rule) => (
    reviewedRows >= minReviewedRows
    && scoredRows >= minScoredRows
    && rule.selectedCount > 0
    && (rule.precision ?? 0) >= minPrecision
  ));
  const bestRule = eligibleRules[0] || null;
  const blockingReasons = [
    sourceExists ? "" : "candidate-review-csv-missing",
    reviewedRows >= minReviewedRows ? "" : "candidate-review-sample-count-too-low",
    scoredRows >= minScoredRows ? "" : "candidate-review-scored-sample-count-too-low",
    scoredRows > 0 ? "" : "candidate-review-no-scored-labels",
    bestRule ? "" : "candidate-review-no-rule-meets-precision",
  ].filter(Boolean);

  return {
    ok: true,
    source: path.relative(process.cwd(), csvPath).replace(/\\/g, "/"),
    sourceExists,
    gateVersion: "western-offline-feature-gate-v0-calibration-eval",
    studentSafeCandidateGateReady: blockingReasons.length === 0,
    minReviewedRows,
    minScoredRows,
    minPrecision,
    rowCount: rows.length,
    reviewedRows,
    scoredRows,
    statusCounts,
    bestRule,
    ruleEvaluations,
    blockingReasons,
  };
}

function parseArgs(argv) {
  const args = {
    reviews: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
    out: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-gate-eval.json"),
    minReviewedRows: 30,
    minScoredRows: 30,
    minPrecision: 0.9,
    failOnNotReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reviews") args.reviews = argv[++index] || args.reviews;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--min-reviewed-rows") args.minReviewedRows = Number(argv[++index] || args.minReviewedRows);
    else if (arg === "--min-scored-rows") args.minScoredRows = Number(argv[++index] || args.minScoredRows);
    else if (arg === "--min-precision") args.minPrecision = Number(argv[++index] || args.minPrecision);
    else if (arg === "--fail-on-not-ready") args.failOnNotReady = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await evaluateControlledCandidateGate({
    reviewCsvPath: args.reviews,
    minReviewedRows: args.minReviewedRows,
    minScoredRows: args.minScoredRows,
    minPrecision: args.minPrecision,
  });
  const outPath = path.resolve(process.cwd(), args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    studentSafeCandidateGateReady: report.studentSafeCandidateGateReady,
    reviewedRows: report.reviewedRows,
    scoredRows: report.scoredRows,
    minScoredRows: report.minScoredRows,
    bestRule: report.bestRule,
    blockingReasons: report.blockingReasons,
    out: path.relative(process.cwd(), outPath).replace(/\\/g, "/"),
  }, null, 2));
  if (args.failOnNotReady && !report.studentSafeCandidateGateReady) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
