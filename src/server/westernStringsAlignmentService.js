import fs from "node:fs/promises";
import path from "node:path";

import { clamp, safeBoolean, safeNumber, safeString } from "./baseUtils.js";

export const WESTERN_ALIGNMENT_METHOD_PREFERENCE = [
  "parangonar-basic-pitch",
  "basic-pitch-dtw",
  "crepe-dtw",
  "pyin-dtw",
  "linear-scoretime",
];

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

function methodRank(method) {
  const index = WESTERN_ALIGNMENT_METHOD_PREFERENCE.indexOf(method);
  return index >= 0 ? index : WESTERN_ALIGNMENT_METHOD_PREFERENCE.length;
}

function noteKey(row) {
  return [row.dataset, row.piece, row.noteIndex].map((item) => safeString(item)).join("\u0000");
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = noteKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function chooseCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const leftDistance = numberOrNull(left.candidateToMedianAbsSeconds) ?? 999;
    const rightDistance = numberOrNull(right.candidateToMedianAbsSeconds) ?? 999;
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return methodRank(left.method) - methodRank(right.method);
  })[0];
}

function buildCandidateSource(row) {
  return {
    method: safeString(row.method),
    predTime: numberOrNull(row.predTime),
    candidateToMedianAbsSeconds: numberOrNull(row.candidateToMedianAbsSeconds),
  };
}

function confidenceScore(row) {
  const methodCount = Math.max(1, Math.round(safeNumber(row.methodCount, 1)));
  const agreement300 = clamp(Math.round(safeNumber(row.agreementWithin300ms, 0)) / methodCount, 0, 1);
  const distance = Math.max(0, safeNumber(row.candidateToMedianAbsSeconds, 1));
  const distanceScore = clamp(1 - distance / 0.3, 0, 1);
  return Number(((agreement300 * 0.7) + (distanceScore * 0.3)).toFixed(4));
}

function buildDecision(candidates, { includeLabels = false } = {}) {
  const selected = chooseCandidate(candidates);
  const decision = {
    noteId: `${safeString(selected.dataset)}:${safeString(selected.piece)}:${safeString(selected.noteIndex)}`,
    dataset: safeString(selected.dataset),
    piece: safeString(selected.piece),
    noteIndex: Math.round(safeNumber(selected.noteIndex, 0)),
    midi: Math.round(safeNumber(selected.midi, 0)),
    scoreTime: numberOrNull(selected.scoreTime),
    predictedOnsetSeconds: numberOrNull(selected.predTime),
    autoDecision: "auto_pass",
    confidenceScore: confidenceScore(selected),
    confidenceModelVersion: "western-m2-median-consensus-v1",
    reviewRequiredReason: "",
    candidateSources: candidates
      .map(buildCandidateSource)
      .sort((left, right) => methodRank(left.method) - methodRank(right.method)),
    evidence: {
      selectedMethod: safeString(selected.method),
      methodCount: Math.round(safeNumber(selected.methodCount, candidates.length)),
      validPredictionCount: Math.round(safeNumber(selected.validPredictionCount, candidates.length)),
      predictionSpanSeconds: numberOrNull(selected.predictionSpanSeconds),
      agreementWithin100ms: Math.round(safeNumber(selected.agreementWithin100ms, 0)),
      agreementWithin300ms: Math.round(safeNumber(selected.agreementWithin300ms, 0)),
      doubleStop: safeString(selected.doubleStop) === "1",
      legato: safeString(selected.legato, "unknown"),
    },
  };
  if (includeLabels) {
    decision.evaluation = {
      labelCandidateAbsError: numberOrNull(selected.labelCandidateAbsError),
      labelCandidateWithin100ms: safeString(selected.labelCandidateWithin100ms) === "1",
      labelCandidateWithin150ms: safeString(selected.labelCandidateWithin150ms) === "1",
      labelCandidateWithin300ms: safeString(selected.labelCandidateWithin300ms) === "1",
    };
  }
  return decision;
}

function summarize(decisions, { includeLabels = false } = {}) {
  const autoPassCount = decisions.filter((item) => item.autoDecision === "auto_pass").length;
  const summary = {
    noteCount: decisions.length,
    autoPassCount,
    reviewRequiredCount: decisions.length - autoPassCount,
    coverage: decisions.length ? Number((autoPassCount / decisions.length).toFixed(4)) : 0,
    confidenceModelVersion: "western-m2-median-consensus-v1",
  };
  if (includeLabels) {
    const evaluated = decisions.filter((item) => item.evaluation);
    const correct = evaluated.filter((item) => item.evaluation.labelCandidateWithin300ms).length;
    summary.evaluation = {
      evaluatedCount: evaluated.length,
      correctWithin300ms: correct,
      precisionWithin300ms: evaluated.length ? Number((correct / evaluated.length).toFixed(4)) : 0,
    };
  }
  return summary;
}

export async function buildWesternAlignmentPreview({
  repoRoot = process.cwd(),
  featuresPath = "data/experiments/western-strings-m2/alignment-candidate-feature-table.csv",
  dataset = "",
  piece = "",
  limit = 0,
  includeLabels = false,
} = {}) {
  const resolvedPath = path.resolve(repoRoot, featuresPath);
  const text = await fs.readFile(resolvedPath, "utf8");
  const rows = parseCsv(text)
    .filter((row) => !dataset || safeString(row.dataset) === dataset)
    .filter((row) => !piece || safeString(row.piece) === piece);
  const decisions = groupRows(rows)
    .map((group) => buildDecision(group, { includeLabels }))
    .sort((left, right) => (
      left.dataset.localeCompare(right.dataset) ||
      left.piece.localeCompare(right.piece) ||
      left.noteIndex - right.noteIndex
    ));
  const cappedDecisions = limit > 0 ? decisions.slice(0, limit) : decisions;
  return {
    ok: true,
    source: path.relative(repoRoot, resolvedPath).replace(/\\/g, "/"),
    filters: { dataset, piece, limit },
    summary: summarize(decisions, { includeLabels }),
    decisions: cappedDecisions,
  };
}

export function parsePreviewQuery(query = {}) {
  return {
    dataset: safeString(query.dataset).trim(),
    piece: safeString(query.piece).trim(),
    limit: Math.max(0, Math.round(safeNumber(query.limit, 0))),
    includeLabels: safeBoolean(query.includeLabels, false),
  };
}
