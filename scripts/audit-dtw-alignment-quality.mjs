import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const outputRoot = path.join(repoRoot, "data", "real-tests", "alignment-quality");

function readJson(relativePath, fallback) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return fallback;
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sectionPage(section) {
  const text = `${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`;
  const match = text.match(/page[-\s]?0*(\d+)/i);
  if (match) return Number(match[1]);
  return Math.max(1, Math.round(numberValue(section?.pageNumber, 1)));
}

function isImportedSection(section) {
  return /page[-\s]?0*\d+/i.test(`${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`);
}

function isErhuMelodySystemIndex(systemIndex) {
  const numeric = Math.round(Number(systemIndex) || 0);
  if (!numeric) return false;
  return (numeric - 1) % 3 === 0;
}

function isErhuNote(note, section) {
  if (!isImportedSection(section)) return true;
  const position = note?.notePosition || {};
  const role = String(position.scoreLineRole || "").toLowerCase();
  const confidence = numberValue(position.scoreLineConfidence, 0);
  if (role !== "erhu" || confidence < 0.66) return false;
  const stats = section?.scoreLineStats || {};
  const accompanimentCount = numberValue(stats.accompanimentNoteCount, 0);
  if (accompanimentCount <= 0) return true;
  return isErhuMelodySystemIndex(position.systemIndex);
}

function isAccompanimentNote(note, section) {
  if (!isImportedSection(section)) return false;
  const position = note?.notePosition || {};
  const role = String(position.scoreLineRole || "").toLowerCase();
  if (!role) return false;
  return role !== "erhu";
}

function isAccompanimentOnly(section) {
  const stats = section?.scoreLineStats || {};
  const erhuCount = numberValue(stats.erhuNoteCount, 0);
  const accompanimentCount = numberValue(stats.accompanimentNoteCount, 0);
  if (erhuCount <= 0 && accompanimentCount > 0) return true;
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  return notes.length > 0 && !notes.some((note) => isErhuNote(note, section));
}

function hasErhuMeasure(section, measureIndex) {
  const numericMeasure = Number(measureIndex) || 1;
  return (section?.notes || []).some((note) => (
    Number(note?.measureIndex) === numericMeasure && isErhuNote(note, section)
  ));
}

function parseXmlNoteId(noteId) {
  const match = String(noteId || "").trim().match(/^xml-m(\d+)-n(\d+)$/i);
  return match ? { measureIndex: Number(match[1]), noteIndex: Number(match[2]) } : null;
}

function sortedErhuMeasureNotes(section, measureIndex) {
  const numericMeasure = Number(measureIndex) || 1;
  return (section?.notes || [])
    .filter((note) => Number(note?.measureIndex) === numericMeasure && isErhuNote(note, section))
    .sort((left, right) => {
      const beatDelta = numberValue(left?.beatStart, 0) - numberValue(right?.beatStart, 0);
      if (Math.abs(beatDelta) > 0.0001) return beatDelta;
      return numberValue(left?.notePosition?.normalizedX, 0) - numberValue(right?.notePosition?.normalizedX, 0);
    });
}

function hasProjectedErhuNote(section, issue) {
  const measureIndex = Number(issue?.measureIndex) || parseXmlNoteId(issue?.noteId)?.measureIndex || 1;
  const candidates = sortedErhuMeasureNotes(section, measureIndex);
  if (!candidates.length) return false;
  const noteId = String(issue?.noteId || "").trim();
  if (noteId && candidates.some((note) => String(note?.noteId || "") === noteId)) return true;
  const beatStart = Number(issue?.beatStart);
  if (Number.isFinite(beatStart)) return true;
  const parsed = parseXmlNoteId(noteId);
  return Boolean(parsed && parsed.noteIndex >= 1);
}

function findSectionById(score, sectionId) {
  const requested = String(sectionId || "").trim();
  if (!requested) return null;
  return (score?.sections || []).find((section) => (
    String(section?.sectionId || "") === requested || String(section?.sourceSectionId || "") === requested
  )) || null;
}

function findPageSections(score, issue) {
  const page = Number(issue?.sourcePageNumber || issue?.pageNumber);
  if (!Number.isFinite(page) || page <= 0) return [];
  return (score?.sections || []).filter((section) => sectionPage(section) === Math.round(page));
}

function resolveQualitySection(score, issue) {
  const byId = findSectionById(score, issue?.sectionId);
  if (byId) return byId;
  const pageSections = findPageSections(score, issue);
  if (!pageSections.length) return null;
  const measureIndex = Number(issue?.measureIndex);
  const noteId = String(issue?.noteId || "").trim();
  const exact = pageSections.find((section) => (section.notes || []).some((note) => (
    Number(note?.measureIndex) === measureIndex
    && (!noteId || String(note?.noteId || "") === noteId)
  )));
  if (exact) return exact;
  return pageSections.find((section) => hasErhuMeasure(section, measureIndex)) || pageSections[0] || null;
}

function auditNoteIssue(score, analysis, issue) {
  const section = resolveQualitySection(score, issue);
  const measureIndex = Number(issue?.measureIndex) || 1;
  const noteId = String(issue?.noteId || "").trim();
  if (!section) {
    return { status: "review", reason: "missing-section" };
  }
  const exactNote = (section.notes || []).find((note) => (
    String(note?.noteId || "") === noteId && Number(note?.measureIndex) === measureIndex
  ));
  if (exactNote && isErhuNote(exactNote, section)) {
    return { status: "exact-note", sectionId: section.sectionId };
  }
  if (exactNote && isAccompanimentNote(exactNote, section)) {
    return {
      status: "accompaniment-failure",
      reason: "exact-note-on-accompaniment",
      sectionId: section.sectionId,
      noteId,
      analysisId: analysis.analysisId,
    };
  }
  if (hasProjectedErhuNote(section, issue)) {
    return { status: "exact-note", reason: "projected-to-erhu-measure-note", sectionId: section.sectionId };
  }
  if (hasErhuMeasure(section, measureIndex)) {
    return { status: "measure-only", sectionId: section.sectionId };
  }
  if (isAccompanimentOnly(section)) {
    return {
      status: "review",
      reason: "accompaniment-only-section",
      sectionId: section.sectionId,
    };
  }
  return { status: "review", reason: "no-erhu-note-in-measure", sectionId: section.sectionId };
}

function auditMeasureIssue(score, analysis, issue) {
  const section = resolveQualitySection(score, issue);
  const measureIndex = Number(issue?.measureIndex) || 1;
  if (!section) {
    return { status: "review", reason: "missing-section" };
  }
  if (hasErhuMeasure(section, measureIndex)) {
    return { status: "exact-measure", sectionId: section.sectionId };
  }
  if (isAccompanimentOnly(section)) {
    return {
      status: "review",
      reason: "accompaniment-only-section",
      sectionId: section.sectionId,
    };
  }
  return { status: "review", reason: "no-erhu-measure", sectionId: section.sectionId };
}

function emptyAnalysisSummary(analysis, score) {
  return {
    analysisId: analysis.analysisId || "",
    scoreId: analysis.scoreId || "",
    pieceTitle: analysis.pieceTitle || score?.title || "",
    analysisMode: analysis.analysisMode || "",
    noteIssueCount: 0,
    noteExactCount: 0,
    noteMeasureOnlyCount: 0,
    noteReviewCount: 0,
    noteAccompanimentFailureCount: 0,
    measureIssueCount: 0,
    measureExactCount: 0,
    measureReviewCount: 0,
    measureAccompanimentFailureCount: 0,
  };
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function emptyTotals() {
  return {
    checkedAnalyses: 0,
    noteIssueCount: 0,
    noteExactCount: 0,
    noteMeasureOnlyCount: 0,
    noteReviewCount: 0,
    noteAccompanimentFailureCount: 0,
    measureIssueCount: 0,
    measureExactCount: 0,
    measureReviewCount: 0,
    measureAccompanimentFailureCount: 0,
    exactNoteRate: 0,
    measureLocatedRate: 0,
    reviewRate: 0,
    accompanimentFailureRate: 0,
  };
}

function finalizeRates(target) {
  const totalIssues = target.noteIssueCount + target.measureIssueCount;
  const totalFailures = target.noteAccompanimentFailureCount + target.measureAccompanimentFailureCount;
  const totalReview = target.noteReviewCount + target.measureReviewCount;
  target.exactNoteRate = rate(target.noteExactCount, target.noteIssueCount);
  target.measureLocatedRate = rate(target.noteExactCount + target.noteMeasureOnlyCount + target.measureExactCount, totalIssues);
  target.reviewRate = rate(totalReview, totalIssues);
  target.accompanimentFailureRate = rate(totalFailures, totalIssues);
  return target;
}

function auditAnalysis(score, analysis) {
  const result = emptyAnalysisSummary(analysis, score);
  const failures = [];

  for (const issue of analysis?.noteFindings || []) {
    result.noteIssueCount += 1;
    const item = auditNoteIssue(score, analysis, issue);
    if (item.status === "exact-note") result.noteExactCount += 1;
    else if (item.status === "measure-only") result.noteMeasureOnlyCount += 1;
    else if (item.status === "accompaniment-failure") {
      result.noteAccompanimentFailureCount += 1;
      failures.push({ type: "note-on-accompaniment", ...item });
    } else {
      result.noteReviewCount += 1;
    }
  }

  for (const issue of analysis?.measureFindings || []) {
    result.measureIssueCount += 1;
    const item = auditMeasureIssue(score, analysis, issue);
    if (item.status === "exact-measure") result.measureExactCount += 1;
    else if (item.status === "accompaniment-failure") {
      result.measureAccompanimentFailureCount += 1;
      failures.push({ type: "measure-on-accompaniment", ...item });
    } else {
      result.measureReviewCount += 1;
    }
  }

  return { result, failures };
}

function collectAnalyses(piecePassStore, studyStore) {
  const byId = new Map();
  for (const job of piecePassStore.jobs || []) {
    if (job.status === "completed" && job.wholePieceAnalysis?.analysisId) {
      byId.set(job.wholePieceAnalysis.analysisId, job.wholePieceAnalysis);
    }
    if (job.status === "completed" && job.primaryAnalysis?.analysisId) {
      byId.set(job.primaryAnalysis.analysisId, job.primaryAnalysis);
    }
  }
  for (const analysis of studyStore.analyses || []) {
    if (analysis?.analysisId) byId.set(analysis.analysisId, analysis);
  }
  return [...byId.values()];
}

function writeMarkdown(report, filePath) {
  const lines = [
    "# DTW Alignment Quality Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Checked analyses: ${report.checkedAnalyses}`,
    `- Missing score analyses: ${report.skippedMissingScore}`,
    `- Note exact rate: ${(report.exactNoteRate * 100).toFixed(1)}%`,
    `- Note measure-located rate: ${(report.measureLocatedRate * 100).toFixed(1)}%`,
    `- Review-needed rate: ${(report.reviewRate * 100).toFixed(1)}%`,
    `- Accompaniment failure rate: ${(report.accompanimentFailureRate * 100).toFixed(2)}%`,
    `- Whole-piece note exact rate: ${((report.modeBreakdown?.["whole-piece"]?.exactNoteRate || 0) * 100).toFixed(1)}%`,
    `- Whole-piece accompaniment failure rate: ${((report.modeBreakdown?.["whole-piece"]?.accompanimentFailureRate || 0) * 100).toFixed(2)}%`,
    `- Whole-piece-section review rate: ${((report.modeBreakdown?.["whole-piece-section"]?.reviewRate || 0) * 100).toFixed(1)}%`,
    "",
    "## Per Analysis",
    "",
    "| Piece | Analysis | Notes exact/measure/review/fail | Measures exact/review/fail |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of report.perAnalysis) {
    lines.push(`| ${item.pieceTitle || item.scoreId} | ${item.analysisId} | ${item.noteExactCount}/${item.noteMeasureOnlyCount}/${item.noteReviewCount}/${item.noteAccompanimentFailureCount} | ${item.measureExactCount}/${item.measureReviewCount}/${item.measureAccompanimentFailureCount} |`);
  }
  if (report.failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of report.failures.slice(0, 50)) {
      lines.push(`- ${failure.type}: ${failure.analysisId || ""} ${failure.sectionId || ""} ${failure.noteId || ""}`);
    }
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

const scoreStore = readJson("data/erhu-score-imports.json", { scores: [] });
const piecePassStore = readJson("data/erhu-piece-pass-jobs.json", { jobs: [] });
const studyStore = readJson("data/erhu-study-records.json", { analyses: [] });
const scoresById = new Map((scoreStore.scores || []).map((score) => [String(score.scoreId || ""), score]));
const analyses = collectAnalyses(piecePassStore, studyStore);

const report = {
  generatedAt: new Date().toISOString(),
  checkedAnalyses: 0,
  skippedMissingScore: 0,
  noteIssueCount: 0,
  noteExactCount: 0,
  noteMeasureOnlyCount: 0,
  noteReviewCount: 0,
  noteAccompanimentFailureCount: 0,
  measureIssueCount: 0,
  measureExactCount: 0,
  measureReviewCount: 0,
  measureAccompanimentFailureCount: 0,
  exactNoteRate: 0,
  measureLocatedRate: 0,
  reviewRate: 0,
  accompanimentFailureRate: 0,
  modeBreakdown: {},
  perAnalysis: [],
  failures: [],
};

for (const analysis of analyses) {
  const score = scoresById.get(String(analysis.scoreId || ""));
  if (!score) {
    report.skippedMissingScore += 1;
    continue;
  }
  report.checkedAnalyses += 1;
  const { result, failures } = auditAnalysis(score, analysis);
  report.perAnalysis.push(result);
  report.failures.push(...failures);
  const mode = String(result.analysisMode || "unknown");
  if (!report.modeBreakdown[mode]) report.modeBreakdown[mode] = emptyTotals();
  report.modeBreakdown[mode].checkedAnalyses += 1;
  for (const key of [
    "noteIssueCount",
    "noteExactCount",
    "noteMeasureOnlyCount",
    "noteReviewCount",
    "noteAccompanimentFailureCount",
    "measureIssueCount",
    "measureExactCount",
    "measureReviewCount",
    "measureAccompanimentFailureCount",
  ]) {
    report[key] += result[key];
    report.modeBreakdown[mode][key] += result[key];
  }
}

const totalIssues = report.noteIssueCount + report.measureIssueCount;
const totalFailures = report.noteAccompanimentFailureCount + report.measureAccompanimentFailureCount;
finalizeRates(report);
for (const totals of Object.values(report.modeBreakdown)) {
  finalizeRates(totals);
}
report.perAnalysis.sort((left, right) => (
  (right.noteAccompanimentFailureCount + right.measureAccompanimentFailureCount)
  - (left.noteAccompanimentFailureCount + left.measureAccompanimentFailureCount)
  || (right.noteReviewCount + right.measureReviewCount) - (left.noteReviewCount + left.measureReviewCount)
));

ensureDir(outputRoot);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outputRoot, `${stamp}-dtw-alignment-quality.json`);
const latestJsonPath = path.join(outputRoot, "latest-dtw-alignment-quality.json");
const latestMdPath = path.join(outputRoot, "latest-dtw-alignment-quality.md");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
writeMarkdown(report, latestMdPath);

console.log(JSON.stringify({
  checkedAnalyses: report.checkedAnalyses,
  skippedMissingScore: report.skippedMissingScore,
  noteIssueCount: report.noteIssueCount,
  noteExactCount: report.noteExactCount,
  noteMeasureOnlyCount: report.noteMeasureOnlyCount,
  noteReviewCount: report.noteReviewCount,
  measureIssueCount: report.measureIssueCount,
  measureExactCount: report.measureExactCount,
  measureReviewCount: report.measureReviewCount,
  accompanimentFailureCount: totalFailures,
  exactNoteRate: report.exactNoteRate,
  measureLocatedRate: report.measureLocatedRate,
  reviewRate: report.reviewRate,
  output: path.relative(repoRoot, latestJsonPath),
}, null, 2));

if (totalFailures > 0) {
  process.exitCode = 1;
}
