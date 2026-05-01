import fs from "node:fs";
import path from "node:path";
import { auditScoreIssueProjection } from "./score-issue-audit.mjs";

const repoRoot = process.cwd();

function readJson(relativePath, fallback) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return fallback;
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function collectRealCorpusAnalyses() {
  const corpusRoot = path.join(repoRoot, "data", "real-tests", "corpus-runs");
  if (!fs.existsSync(corpusRoot)) return [];
  const analyses = [];
  for (const entry of fs.readdirSync(corpusRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(corpusRoot, entry.name, "run-summary.json");
    if (!fs.existsSync(summaryPath)) continue;
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      for (const result of summary.results || []) {
        const analysis = result?.piecePassJob?.wholePieceAnalysis;
        if (result?.status === "completed" && analysis?.analysisId) {
          analyses.push(analysis);
        }
      }
    } catch (error) {
      console.warn(`[score-issues] Skipping unreadable corpus summary ${path.relative(repoRoot, summaryPath)}: ${error.message}`);
    }
  }
  return analyses;
}

function analysisTimestamp(analysis) {
  const direct = Date.parse(analysis?.createdAt || analysis?.completedAt || analysis?.updatedAt || "");
  if (Number.isFinite(direct)) return direct;
  const idText = String(analysis?.analysisId || "");
  const match = idText.match(/piecepassjob-([a-z0-9]+)-/i);
  if (!match) return 0;
  const value = Number.parseInt(match[1], 36);
  return Number.isFinite(value) ? value : 0;
}

function latestMainlineAnalyses(analyses = []) {
  const latestByKey = new Map();
  for (const analysis of analyses) {
    if (String(analysis?.analysisMode || "") !== "whole-piece") continue;
    const key = `${String(analysis?.scoreId || "")}::${String(analysis?.audioHash || "") || "no-audio"}`;
    const timestamp = analysisTimestamp(analysis);
    const existing = latestByKey.get(key);
    if (!existing || timestamp >= existing.timestamp) {
      latestByKey.set(key, { analysis, timestamp });
    }
  }
  return [...latestByKey.values()].map((item) => item.analysis);
}

function buildWarnings(analysis, result) {
  const warnings = [];
  if (String(analysis?.analysisMode || "") === "whole-piece") {
    if (result.sourcePages.length > 1 && result.visiblePages.length <= 1 && result.visibleIssues > 0) {
      warnings.push({
        type: "low-visible-page-coverage",
        analysisId: analysis.analysisId,
        sourcePageCount: result.sourcePages.length,
        visiblePageCount: result.visiblePages.length,
      });
    }
    if (result.reviewRate > 0.35) {
      warnings.push({
        type: "high-review-rate",
        analysisId: analysis.analysisId,
        reviewRate: result.reviewRate,
      });
    }
  }
  return warnings;
}

function auditAnalysis(score, analysis) {
  const result = auditScoreIssueProjection(score, analysis);
  const warnings = buildWarnings(analysis, result);
  return {
    failures: result.failures,
    warnings,
    visibleNotes: result.visibleNotes,
    hiddenNotes: result.hiddenNotes,
    visibleMeasures: result.visibleMeasures,
    hiddenMeasures: result.hiddenMeasures,
    sourcePages: result.sourcePages,
    visiblePages: result.visiblePages,
    reviewPages: result.reviewPages,
    totalIssues: result.totalIssues,
    visibleIssues: result.visibleIssues,
    reviewIssues: result.reviewIssues,
  };
}

const scoreStore = readJson("data/erhu-score-imports.json", { scores: [] });
const piecePassStore = readJson("data/erhu-piece-pass-jobs.json", { jobs: [] });
const studyStore = readJson("data/erhu-study-records.json", { analyses: [] });
const scoresById = new Map((scoreStore.scores || []).map((score) => [score.scoreId, score]));
const analysesById = new Map();

for (const job of piecePassStore.jobs || []) {
  if (job.status !== "completed" || !job.wholePieceAnalysis) continue;
  analysesById.set(job.wholePieceAnalysis.analysisId, job.wholePieceAnalysis);
}
for (const analysis of studyStore.analyses || []) {
  if (analysis?.analysisId) analysesById.set(analysis.analysisId, analysis);
}
for (const analysis of collectRealCorpusAnalyses()) {
  analysesById.set(analysis.analysisId, analysis);
}
const analyses = [...analysesById.values()];
const latestMainlineAnalysesList = latestMainlineAnalyses(analyses);

const summary = {
  checkedAnalyses: 0,
  skippedMissingScore: 0,
  visibleNotes: 0,
  hiddenNotes: 0,
  visibleMeasures: 0,
  hiddenMeasures: 0,
  sourcePages: [],
  visiblePages: [],
  reviewPages: [],
  perAnalysis: [],
  latestMainline: {
    checkedAnalyses: 0,
    visibleNotes: 0,
    hiddenNotes: 0,
    visibleMeasures: 0,
    hiddenMeasures: 0,
    visibleIssues: 0,
    reviewIssues: 0,
    sourcePages: [],
    visiblePages: [],
    reviewPages: [],
    perAnalysis: [],
    warnings: [],
    failures: [],
  },
  warnings: [],
  failures: [],
};

for (const analysis of analyses) {
  const score = scoresById.get(String(analysis.scoreId || ""));
  if (!score) {
    summary.skippedMissingScore += 1;
    continue;
  }
  summary.checkedAnalyses += 1;
  const result = auditAnalysis(score, analysis);
  summary.visibleNotes += result.visibleNotes;
  summary.hiddenNotes += result.hiddenNotes;
  summary.visibleMeasures += result.visibleMeasures;
  summary.hiddenMeasures += result.hiddenMeasures;
  for (const page of result.sourcePages) summary.sourcePages.push(page);
  for (const page of result.visiblePages) summary.visiblePages.push(page);
  for (const page of result.reviewPages) summary.reviewPages.push(page);
  summary.warnings.push(...result.warnings);
  summary.failures.push(...result.failures);
  const perAnalysisItem = {
    analysisId: analysis.analysisId,
    pieceTitle: analysis.pieceTitle,
    analysisMode: analysis.analysisMode,
    sourcePages: result.sourcePages,
    visiblePages: result.visiblePages,
    reviewPages: result.reviewPages,
    visibleIssues: result.visibleIssues,
    reviewIssues: result.reviewIssues,
    warnings: result.warnings,
  };
  if (
    String(analysis.analysisMode || "") === "whole-piece"
    || result.warnings.length
    || result.failures.length
  ) {
    summary.perAnalysis.push(perAnalysisItem);
  }
}

summary.sourcePages = [...new Set(summary.sourcePages)].sort((left, right) => left - right);
summary.visiblePages = [...new Set(summary.visiblePages)].sort((left, right) => left - right);
summary.reviewPages = [...new Set(summary.reviewPages)].sort((left, right) => left - right);

for (const analysis of latestMainlineAnalysesList) {
  const score = scoresById.get(String(analysis.scoreId || ""));
  if (!score) continue;
  const result = auditAnalysis(score, analysis);
  summary.latestMainline.checkedAnalyses += 1;
  summary.latestMainline.visibleNotes += result.visibleNotes;
  summary.latestMainline.hiddenNotes += result.hiddenNotes;
  summary.latestMainline.visibleMeasures += result.visibleMeasures;
  summary.latestMainline.hiddenMeasures += result.hiddenMeasures;
  summary.latestMainline.visibleIssues += result.visibleIssues;
  summary.latestMainline.reviewIssues += result.reviewIssues;
  for (const page of result.sourcePages) summary.latestMainline.sourcePages.push(page);
  for (const page of result.visiblePages) summary.latestMainline.visiblePages.push(page);
  for (const page of result.reviewPages) summary.latestMainline.reviewPages.push(page);
  summary.latestMainline.warnings.push(...result.warnings);
  summary.latestMainline.failures.push(...result.failures);
  summary.latestMainline.perAnalysis.push({
    analysisId: analysis.analysisId,
    pieceTitle: analysis.pieceTitle,
    sourcePages: result.sourcePages,
    visiblePages: result.visiblePages,
    reviewPages: result.reviewPages,
    visibleIssues: result.visibleIssues,
    reviewIssues: result.reviewIssues,
    warnings: result.warnings,
  });
}

summary.latestMainline.sourcePages = [...new Set(summary.latestMainline.sourcePages)].sort((left, right) => left - right);
summary.latestMainline.visiblePages = [...new Set(summary.latestMainline.visiblePages)].sort((left, right) => left - right);
summary.latestMainline.reviewPages = [...new Set(summary.latestMainline.reviewPages)].sort((left, right) => left - right);

console.log(JSON.stringify(summary, null, 2));
if (summary.failures.length || summary.latestMainline.failures.length) {
  process.exitCode = 1;
}
