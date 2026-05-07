import fs from "node:fs";
import path from "node:path";
import { auditScoreIssueProjection } from "./score-issue-audit.mjs";
import {
  buildDisplayMeasureLookup,
  findErhuNotePosition,
  formatDisplayMeasureLabel,
  formatDisplayNoteLabel,
  getErhuMelodyNotes,
  isErhuMelodyNote,
  isExplicitErhuPartCandidate,
  isLikelyAccompanimentOnlySection,
  resolveIssueSection,
  sectionKey,
  shouldProjectImportedFullScoreSection,
} from "../src/scoreIssue/scoreIssueProjection.js";

const repoRoot = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeNote({
  noteId,
  measureIndex,
  beatStart = 0,
  x = 0.2,
  y = 0.2,
  staffIndex = 1,
  systemIndex = 1,
  role = "erhu",
  confidence = 0.92,
  partName = "二胡",
  localMeasureIndex = measureIndex,
  localNoteId = noteId,
}) {
  return {
    noteId,
    measureIndex,
    beatStart,
    partName,
    notePosition: {
      normalizedX: x,
      normalizedY: y,
      staffIndex,
      systemIndex,
      scoreLineRole: role,
      scoreLineConfidence: confidence,
      localMeasureIndex,
      localNoteId,
    },
  };
}

function makeErhuSection({
  sectionId,
  pageNumber,
  sequenceIndex = 1,
  measureCount = 4,
  notePrefix = sectionId,
}) {
  const notes = Array.from({ length: measureCount }, (_, index) => {
    const measureIndex = index + 1;
    return makeNote({
      noteId: `${notePrefix}-m${measureIndex}-n1`,
      measureIndex,
      beatStart: 0,
      x: 0.12 + index * 0.04,
      y: 0.26,
      role: "erhu",
      partName: "二胡",
    });
  });
  return {
    sectionId,
    sourceSectionId: sectionId,
    title: `自动识谱第 ${pageNumber} 页 片段 ${sequenceIndex}`,
    pageNumber,
    sequenceIndex,
    selectedPart: "二胡",
    measureCount,
    scoreLineStats: {
      erhuNoteCount: notes.length,
      accompanimentNoteCount: 0,
    },
    notes,
  };
}

function runSyntheticProjectionTests() {
  assert(
    shouldProjectImportedFullScoreSection({ title: "自动识谱第 7 页 片段 3" }),
    "Chinese imported-section titles must be recognized",
  );
  assert(
    isExplicitErhuPartCandidate({ name: " 二胡 ", label: "Erhu II" }),
    "Simplified Chinese and English erhu part labels must be explicit erhu candidates",
  );
  assert(
    isExplicitErhuPartCandidate({ name: "二胡 1" }),
    "Numbered erhu part labels must remain explicit erhu candidates",
  );

  const mixedSection = {
    sectionId: "page-07-mixed",
    sourceSectionId: "page-07-mixed",
    title: "自动识谱第 7 页 片段 3",
    pageNumber: 7,
    sequenceIndex: 3,
    selectedPart: "二胡",
    scoreLineStats: {
      erhuNoteCount: 3,
      accompanimentNoteCount: 3,
    },
    notes: [
      makeNote({
        noteId: "xml-m9-n3",
        measureIndex: 9,
        beatStart: 0.5,
        x: 0.18,
        y: 0.42,
        role: "erhu",
        partName: "二胡",
      }),
      makeNote({
        noteId: "xml-m9-n4",
        measureIndex: 9,
        beatStart: 1.0,
        x: 0.34,
        y: 0.42,
        role: "erhu",
        partName: "二胡",
      }),
      makeNote({
        noteId: "xml-m9-n5",
        measureIndex: 9,
        beatStart: 1.5,
        x: 0.52,
        y: 0.43,
        role: "erhu",
        partName: "二胡 1",
      }),
      makeNote({
        noteId: "piano-m9-n1",
        measureIndex: 9,
        beatStart: 0.5,
        x: 0.19,
        y: 0.64,
        staffIndex: 2,
        systemIndex: 2,
        role: "accompaniment",
        partName: "钢琴",
      }),
      makeNote({
        noteId: "piano-m9-n2",
        measureIndex: 9,
        beatStart: 1.0,
        x: 0.35,
        y: 0.64,
        staffIndex: 2,
        systemIndex: 2,
        role: "accompaniment",
        partName: "鋼琴",
      }),
      makeNote({
        noteId: "piano-m9-n3",
        measureIndex: 9,
        beatStart: 1.5,
        x: 0.53,
        y: 0.64,
        staffIndex: 2,
        systemIndex: 2,
        role: "accompaniment",
        partName: "伴奏",
      }),
    ],
  };
  const pianoOnlySection = {
    sectionId: "page-07-piano",
    sourceSectionId: "page-07-piano",
    title: "自动识谱第 7 页 片段 4",
    pageNumber: 7,
    sequenceIndex: 4,
    selectedPart: "钢琴伴奏",
    scoreLineStats: {
      erhuNoteCount: 0,
      accompanimentNoteCount: 2,
    },
    notes: [
      makeNote({
        noteId: "xml-m9-n5",
        measureIndex: 9,
        x: 0.51,
        y: 0.66,
        staffIndex: 2,
        systemIndex: 2,
        role: "accompaniment",
        partName: "钢琴",
      }),
      makeNote({
        noteId: "xml-m10-n1",
        measureIndex: 10,
        x: 0.62,
        y: 0.7,
        staffIndex: 2,
        systemIndex: 2,
        role: "accompaniment",
        partName: "伴奏",
      }),
    ],
  };
  const score = {
    scoreId: "synthetic-score-projection",
    selectedPartId: "erhu",
    partCandidates: [
      { id: "erhu", name: "二胡", staffCount: 1 },
      { id: "piano", name: "鋼琴伴奏", staffCount: 2, isLikelyPiano: true },
    ],
    sections: [pianoOnlySection, mixedSection],
  };

  assert(isErhuMelodyNote(mixedSection.notes[0], mixedSection, score), "Tagged erhu notes must remain projectable");
  assert(!isErhuMelodyNote(mixedSection.notes[3], mixedSection, score), "Piano/accompaniment notes must not be projectable");
  assert(!isErhuMelodyNote(mixedSection.notes[4], mixedSection, score), "Traditional Chinese piano labels must be excluded");
  assert(!isErhuMelodyNote(mixedSection.notes[5], mixedSection, score), "Accompaniment labels must be excluded");
  assert(isLikelyAccompanimentOnlySection(pianoOnlySection, score), "Piano-only sections must be filtered out");
  assert(!isLikelyAccompanimentOnlySection(mixedSection, score), "Sections with confident erhu notes must remain usable");

  const melodyNotes = getErhuMelodyNotes(mixedSection, score);
  assert(melodyNotes.length === 3, `Expected 3 erhu melody notes, got ${melodyNotes.length}`);
  assert(melodyNotes.every((note) => String(note.partName || "").includes("二胡")), "Only erhu notes should remain in melody notes");

  const targetIssue = {
    sectionId: "page-07-piano",
    sourcePageNumber: 7,
    pageNumber: 7,
    measureIndex: 9,
    noteId: "xml-m9-n5",
    beatStart: 1.5,
  };
  const resolved = resolveIssueSection(score, pianoOnlySection, targetIssue);
  assert(resolved?.sectionId === mixedSection.sectionId, "Issue resolution must ignore requested piano-only sections and choose the erhu section");

  const position = findErhuNotePosition(resolved, targetIssue, 1, score);
  assert(position, "Exact erhu note position should be found");
  assert(position.scoreLineRole === "erhu", "Resolved note position must be on the erhu line");
  assert(Math.abs(position.normalizedY - 0.43) < 0.0001, "Resolved note position must not use piano accompaniment coordinates");

  const displaySections = [];
  for (let index = 0; index < 8; index += 1) {
    const pageNumber = 3 + Math.floor(index / 2);
    displaySections.push(makeErhuSection({
      sectionId: `page-${String(pageNumber).padStart(2, "0")}-prior-${index + 1}`,
      pageNumber,
      sequenceIndex: index + 1,
      measureCount: 8,
    }));
  }
  const currentDisplaySection = {
    ...mixedSection,
    sequenceIndex: 99,
    measureCount: 12,
    notes: [
      ...Array.from({ length: 12 }, (_, index) => makeNote({
        noteId: `display-m${index + 1}-n1`,
        measureIndex: index + 1,
        x: 0.1 + index * 0.03,
        y: 0.42,
        role: "erhu",
        partName: "二胡",
      })),
      ...mixedSection.notes,
    ],
    scoreLineStats: {
      erhuNoteCount: 15,
      accompanimentNoteCount: 3,
    },
  };
  displaySections.push(currentDisplaySection);
  const displayLookup = buildDisplayMeasureLookup({ ...score, sections: displaySections }, displaySections, score);
  assert(
    displayLookup.get(sectionKey(mixedSection.sectionId, 9)) === 73,
    "Local section measure 9 should map to global display measure 73",
  );
  assert(formatDisplayMeasureLabel(9, 73) === "第 73 小节", "Measure labels must use readable global measure numbers");
  assert(
    formatDisplayNoteLabel("xml-m9-n5", 9, 73) === "第 73 小节第 5 音",
    "XML note IDs must render as readable measure and note numbers",
  );
}

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

runSyntheticProjectionTests();

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
