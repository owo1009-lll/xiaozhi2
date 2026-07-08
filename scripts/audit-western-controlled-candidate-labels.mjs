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

function candidateKey(row) {
  return [
    safeString(row.batchRunId),
    safeString(row.submissionId),
    safeString(row.candidateId),
  ].join("::");
}

async function loadCandidateRows(rows) {
  const cache = new Map();
  const enriched = [];
  for (const row of rows) {
    const candidateRowsPath = safeString(row.candidateRowsPath);
    let candidate = null;
    if (candidateRowsPath) {
      const resolved = path.resolve(process.cwd(), candidateRowsPath);
      if (!cache.has(resolved)) {
        try {
          const parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
          const byId = new Map((parsed.candidateRows || []).map((item) => [safeString(item.candidateId), item]));
          cache.set(resolved, byId);
        } catch {
          cache.set(resolved, new Map());
        }
      }
      candidate = cache.get(resolved).get(safeString(row.candidateId)) || null;
    }
    enriched.push({
      ...(candidate || {}),
      ...row,
      teacherCandidateStatus: normalizeStatus(row.teacherCandidateStatus),
    });
  }
  return enriched;
}

function scenarioFromRecordingId(recordingId) {
  const text = safeString(recordingId);
  const match = text.match(/ex\d+-(.+)$/i);
  return match ? match[1] : text;
}

function pitchClass(midi) {
  const value = numeric(midi);
  return value === null ? "" : String(((Math.round(value) % 12) + 12) % 12);
}

function statusSummary(rows) {
  const counts = { usable: 0, wrong: 0, uncertain: 0, blank: 0 };
  for (const row of rows) {
    const status = normalizeStatus(row.teacherCandidateStatus);
    if (status) counts[status] += 1;
    else counts.blank += 1;
  }
  return counts;
}

function evaluateRule(rows, rule) {
  const scored = rows.filter((row) => ["usable", "wrong"].includes(normalizeStatus(row.teacherCandidateStatus)));
  const selected = scored.filter(rule.predicate);
  const usable = selected.filter((row) => row.teacherCandidateStatus === "usable").length;
  const wrong = selected.filter((row) => row.teacherCandidateStatus === "wrong").length;
  const precision = selected.length ? usable / selected.length : null;
  return {
    ruleId: rule.ruleId,
    description: rule.description,
    selectedCount: selected.length,
    usableCount: usable,
    wrongCount: wrong,
    precision: precision === null ? null : Number(precision.toFixed(6)),
    coverage: scored.length ? Number((selected.length / scored.length).toFixed(6)) : 0,
  };
}

function uniqueSortedNumbers(rows, field, maxValues = 40) {
  const values = [...new Set(rows.map((row) => numeric(row[field])).filter((value) => value !== null))]
    .sort((left, right) => left - right);
  if (values.length <= maxValues) return values;
  const result = [];
  for (let index = 0; index < maxValues; index += 1) {
    result.push(values[Math.floor(index * (values.length - 1) / (maxValues - 1))]);
  }
  return [...new Set(result)];
}

function buildAuditRules(rows) {
  const numericFields = [
    "centsError",
    "absCentsError",
    "voicedFrameCount",
    "medianObservedMidi",
    "midi",
    "predictedOnsetSeconds",
    "noteIndex",
    "measureIndex",
    "confidenceScore",
    "midiDelta",
  ];
  const categoricalFields = [
    "piece",
    "recordingId",
    "recordingScenario",
    "pitchSupportWithin80Cents",
    "method",
    "analysisMode",
    "sectionId",
    "midiPitchClass",
  ];
  const rules = [];
  for (const field of categoricalFields) {
    const values = [...new Set(rows.map((row) => safeString(row[field])).filter(Boolean))].sort();
    for (const value of values) {
      rules.push({
        ruleId: `${field}=${value}`,
        description: `${field} == ${value}`,
        predicate: (row) => safeString(row[field]) === value,
      });
    }
  }
  for (const field of numericFields) {
    for (const threshold of uniqueSortedNumbers(rows, field)) {
      rules.push({
        ruleId: `${field}<=${threshold}`,
        description: `${field} <= ${threshold}`,
        predicate: (row) => {
          const value = numeric(row[field]);
          return value !== null && value <= threshold;
        },
      });
      rules.push({
        ruleId: `${field}>=${threshold}`,
        description: `${field} >= ${threshold}`,
        predicate: (row) => {
          const value = numeric(row[field]);
          return value !== null && value >= threshold;
        },
      });
    }
  }
  for (const threshold of [5, 10, 15, 20, 25, 35, 50, 65, 80, 120, 200, 500, 1000]) {
    rules.push({
      ruleId: `abs(centsError)<=${threshold}`,
      description: `abs(centsError) <= ${threshold}`,
      predicate: (row) => {
        const value = numeric(row.centsError);
        return value !== null && Math.abs(value) <= threshold;
      },
    });
    rules.push({
      ruleId: `abs(midiDelta)<=${threshold / 100}`,
      description: `abs(midiDelta) <= ${threshold / 100}`,
      predicate: (row) => {
        const value = numeric(row.midiDelta);
        return value !== null && Math.abs(value) <= threshold / 100;
      },
    });
  }
  return rules;
}

function groupSummaries(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const value = safeString(row[field]) || "(blank)";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return [...groups.entries()]
    .map(([value, groupRows]) => {
      const counts = statusSummary(groupRows);
      const scored = counts.usable + counts.wrong;
      return {
        value,
        rowCount: groupRows.length,
        usable: counts.usable,
        wrong: counts.wrong,
        precisionIfSelected: scored ? Number((counts.usable / scored).toFixed(6)) : null,
      };
    })
    .sort((left, right) => right.rowCount - left.rowCount || String(left.value).localeCompare(String(right.value)));
}

export async function auditControlledCandidateLabels({
  labelsPath = path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
  outPath = path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-label-audit.json"),
  minSelected = 3,
  minPrecision = 0.9,
} = {}) {
  const resolvedLabelsPath = path.resolve(process.cwd(), labelsPath);
  const rows = await loadCandidateRows(parseCsv(await fs.readFile(resolvedLabelsPath, "utf8")));
  const enriched = rows.map((row) => {
    const midi = numeric(row.midi);
    const medianObservedMidi = numeric(row.medianObservedMidi);
    return {
      ...row,
      absCentsError: Math.abs(numeric(row.centsError, 0)),
      midiDelta: midi === null || medianObservedMidi === null ? "" : Number((medianObservedMidi - midi).toFixed(4)),
      recordingScenario: scenarioFromRecordingId(row.recordingId),
      midiPitchClass: pitchClass(row.midi),
      pitchSupportWithin80Cents: String(row.pitchSupportWithin80Cents).toLowerCase() === "true"
        ? "yes"
        : String(row.pitchSupportWithin80Cents).toLowerCase() === "false"
          ? "no"
          : safeString(row.pitchSupportWithin80Cents),
    };
  });
  const ruleEvaluations = buildAuditRules(enriched)
    .map((rule) => evaluateRule(enriched, rule))
    .filter((rule) => rule.selectedCount >= minSelected)
    .sort((left, right) => {
      if ((right.precision ?? -1) !== (left.precision ?? -1)) return (right.precision ?? -1) - (left.precision ?? -1);
      if (right.selectedCount !== left.selectedCount) return right.selectedCount - left.selectedCount;
      return String(left.ruleId).localeCompare(String(right.ruleId));
    });
  const passingRules = ruleEvaluations.filter((rule) => (rule.precision ?? 0) >= minPrecision);
  const report = {
    ok: true,
    source: path.relative(process.cwd(), resolvedLabelsPath).replace(/\\/g, "/"),
    thresholds: { minSelected, minPrecision },
    counts: statusSummary(enriched),
    rowCount: enriched.length,
    scoredRows: enriched.filter((row) => ["usable", "wrong"].includes(row.teacherCandidateStatus)).length,
    passingRuleCount: passingRules.length,
    bestPassingRules: passingRules.slice(0, 20),
    topRules: ruleEvaluations.slice(0, 30),
    groups: {
      recordingScenario: groupSummaries(enriched, "recordingScenario"),
      piece: groupSummaries(enriched, "piece"),
      pitchSupportWithin80Cents: groupSummaries(enriched, "pitchSupportWithin80Cents"),
    },
  };
  const resolvedOutPath = path.resolve(process.cwd(), outPath);
  await fs.mkdir(path.dirname(resolvedOutPath), { recursive: true });
  await fs.writeFile(resolvedOutPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return {
    ok: true,
    out: path.relative(process.cwd(), resolvedOutPath).replace(/\\/g, "/"),
    rowCount: report.rowCount,
    scoredRows: report.scoredRows,
    counts: report.counts,
    passingRuleCount: report.passingRuleCount,
    topRule: report.topRules[0] || null,
  };
}

function parseArgs(argv) {
  const args = {
    labels: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
    out: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-label-audit.json"),
    minSelected: 3,
    minPrecision: 0.9,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--labels") args.labels = argv[++index] || args.labels;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--min-selected") args.minSelected = Number(argv[++index] || args.minSelected);
    else if (arg === "--min-precision") args.minPrecision = Number(argv[++index] || args.minPrecision);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await auditControlledCandidateLabels({
    labelsPath: args.labels,
    outPath: args.out,
    minSelected: args.minSelected,
    minPrecision: args.minPrecision,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
