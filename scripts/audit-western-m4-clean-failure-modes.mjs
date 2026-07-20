#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSummary = path.join(
  repoRoot,
  "data/experiments/western-strings-m4/render-gold-omr/render-gold-omr-summary.json",
);
const defaultNoteAudit = path.join(
  repoRoot,
  "data/experiments/western-strings-m4/render-gold-omr/render-gold-note-level-audit.json",
);
const defaultOutput = path.join(
  repoRoot,
  "data/experiments/western-strings-m4/clean-failure-modes/report.json",
);

export const THRESHOLDS = Object.freeze({
  minPitchPrecision: 0.98,
  minPitchRecall: 0.95,
  minOnsetQuarterAccuracy: 0.95,
  minMeasureAccuracy: 0.95,
  maxMissingRate: 0.02,
  maxExtraRate: 0.02,
});

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function portable(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function classifyPitch(checks) {
  if (checks.pitchPrecision && checks.pitchRecall) return "passed";
  if (!checks.pitchPrecision && !checks.pitchRecall) return "precision-and-recall";
  if (!checks.pitchPrecision) return "precision-only";
  return "recall-only";
}

export function buildCleanFailureModeAudit(summary, noteAudit) {
  const noteRows = new Map((noteAudit.rows || []).map((row) => [row.piece, row]));
  const rows = (summary.pieces || []).map((pitchRow) => {
    const noteRow = noteRows.get(pitchRow.piece);
    if (!noteRow || noteRow.status !== "ok") {
      throw new Error(`clean-note-audit-row-missing:${pitchRow.piece}`);
    }
    const metrics = {
      pitchPrecision: Number(pitchRow.pitchPrecision),
      pitchRecall: Number(pitchRow.pitchRecall),
      onsetQuarterAccuracy: Number(noteRow.onsetQuarterAccuracy),
      measureAccuracy: Number(noteRow.measureAccuracy),
      missingRate: Number(noteRow.missingRate),
      extraRate: Number(noteRow.extraRate),
    };
    const checks = {
      pitchPrecision: metrics.pitchPrecision >= THRESHOLDS.minPitchPrecision,
      pitchRecall: metrics.pitchRecall >= THRESHOLDS.minPitchRecall,
      onsetQuarterAccuracy:
        metrics.onsetQuarterAccuracy >= THRESHOLDS.minOnsetQuarterAccuracy,
      measureAccuracy: metrics.measureAccuracy >= THRESHOLDS.minMeasureAccuracy,
      missingRate: metrics.missingRate <= THRESHOLDS.maxMissingRate,
      extraRate: metrics.extraRate <= THRESHOLDS.maxExtraRate,
    };
    const pitchStrictPassed = checks.pitchPrecision && checks.pitchRecall;
    const structureStrictPassed = checks.onsetQuarterAccuracy && checks.measureAccuracy;
    return {
      pieceId: pitchRow.piece,
      metrics,
      checks,
      pitchFailureMode: classifyPitch(checks),
      pitchStrictPassed,
      structureStrictPassed,
      completeFourMetricPassed: pitchStrictPassed && structureStrictPassed,
      completeSixMetricPassed:
        pitchStrictPassed
        && structureStrictPassed
        && checks.missingRate
        && checks.extraRate,
    };
  });
  if (rows.length !== noteRows.size) {
    throw new Error(`clean-audit-piece-count-mismatch:${rows.length}!=${noteRows.size}`);
  }
  const count = (predicate) => rows.filter(predicate).length;
  const pitchFailureModes = Object.fromEntries(
    ["passed", "precision-only", "recall-only", "precision-and-recall"].map(
      (name) => [name, count((row) => row.pitchFailureMode === name)],
    ),
  );
  const passCounts = Object.fromEntries(
    Object.keys(rows[0]?.checks || {}).map(
      (name) => [name, count((row) => row.checks[name] === true)],
    ),
  );
  const pitchStrictPassed = count((row) => row.pitchStrictPassed);
  const pitchStrictStructureFailed = count(
    (row) => row.pitchStrictPassed && !row.structureStrictPassed,
  );
  return {
    contract: "western-m4-clean-failure-mode-audit-v1",
    evidenceRole: "clean-digital-render-diagnostic",
    thresholds: THRESHOLDS,
    aggregate: {
      pieceCount: rows.length,
      sourceNoteMetrics: noteAudit.aggregate?.metrics || {},
      passCounts,
      pitchStrictPassed,
      pitchStrictFailed: rows.length - pitchStrictPassed,
      pitchFailureModes,
      pitchStrictStructureFailed,
      completeFourMetricPassed: count((row) => row.completeFourMetricPassed),
      completeSixMetricPassed: count((row) => row.completeSixMetricPassed),
    },
    interpretation: {
      structureReconstructionDeficitPresentInCleanDomain: pitchStrictStructureFailed > 0,
      geometryOnlyHypothesisSupported: false,
      reason:
        "Clean digital renders already fail onset and measure reconstruction, including pieces that pass strict pitch precision and recall.",
      nextAction:
        "Measure Oemer pre/post-dewarp geometry only to quantify the additional photo-domain loss; do not treat geometry as the sole root cause.",
    },
    studentGateReady: false,
    runtimeEffect: "none",
    rows,
  };
}

async function main() {
  const summaryPath = path.resolve(process.argv[2] || defaultSummary);
  const noteAuditPath = path.resolve(process.argv[3] || defaultNoteAudit);
  const outputPath = path.resolve(process.argv[4] || defaultOutput);
  const [summaryBytes, noteAuditBytes] = await Promise.all([
    fs.readFile(summaryPath),
    fs.readFile(noteAuditPath),
  ]);
  const report = buildCleanFailureModeAudit(
    JSON.parse(summaryBytes.toString("utf8")),
    JSON.parse(noteAuditBytes.toString("utf8")),
  );
  report.createdAt = new Date().toISOString();
  report.sources = {
    pitchSummary: { path: portable(summaryPath), sha256: sha256(summaryBytes) },
    noteLevelAudit: { path: portable(noteAuditPath), sha256: sha256(noteAuditBytes) },
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ report: portable(outputPath), aggregate: report.aggregate }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
