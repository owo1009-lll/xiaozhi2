import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function readJson(relativePath, fallback) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return fallback;
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function sectionPage(section) {
  const candidates = [section?.sectionId, section?.sourceSectionId, section?.title].map((item) => String(item || ""));
  for (const value of candidates) {
    const match = value.match(/page[-\s]?0*(\d+)/i);
    if (match) return Number(match[1]);
  }
  return Math.max(1, Math.round(Number(section?.pageNumber) || 1));
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
  const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
  const confidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
  if (role === "erhu" && confidence >= 0.66) {
    const stats = section?.scoreLineStats || {};
    const accompanimentCount = Number(stats.accompanimentNoteCount) || 0;
    if (accompanimentCount <= 0) return true;
    return isErhuMelodySystemIndex(note?.notePosition?.systemIndex);
  }
  if (role) return false;
  return false;
}

function isAccompanimentOnly(section) {
  const stats = section?.scoreLineStats || {};
  const erhuCount = Number(stats.erhuNoteCount) || 0;
  const accompanimentCount = Number(stats.accompanimentNoteCount) || 0;
  if (erhuCount <= 0 && accompanimentCount > 0) return true;
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  return notes.length > 0 && !notes.some((note) => isErhuNote(note, section));
}

function hasErhuMeasure(section, measureIndex) {
  const numericMeasure = Number(measureIndex) || 1;
  return (section?.notes || []).some((note) => Number(note?.measureIndex) === numericMeasure && isErhuNote(note, section));
}

function resolveIssueSection(score, issue) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const requestedId = String(issue?.sectionId || "").trim();
  const measureIndex = Number(issue?.measureIndex);
  const noteId = String(issue?.noteId || "").trim();
  if (requestedId) {
    const matched = sections.find((section) => String(section?.sectionId || "") === requestedId || String(section?.sourceSectionId || "") === requestedId);
    if (matched && !isAccompanimentOnly(matched) && hasErhuMeasure(matched, measureIndex)) return matched;
  }
  const page = Number(issue?.sourcePageNumber || issue?.pageNumber);
  if (Number.isFinite(page) && page > 0) {
    const pageSections = sections.filter((section) => sectionPage(section) === Math.round(page));
    const exact = pageSections.find((section) => (section.notes || []).some((note) => (
      Number(note?.measureIndex) === measureIndex &&
      (!noteId || String(note?.noteId || "") === noteId) &&
      isErhuNote(note, section)
    )));
    if (exact) return exact;
    const measure = pageSections.find((section) => hasErhuMeasure(section, measureIndex));
    if (measure) return measure;
    return pageSections.find((section) => !isAccompanimentOnly(section)) || null;
  }
  return null;
}

function auditAnalysis(score, analysis) {
  const failures = [];
  let visibleNotes = 0;
  let hiddenNotes = 0;
  let visibleMeasures = 0;
  let hiddenMeasures = 0;
  for (const issue of analysis?.noteFindings || []) {
    const section = resolveIssueSection(score, issue);
    const note = (section?.notes || []).find((item) => (
      String(item?.noteId || "") === String(issue?.noteId || "") &&
      Number(item?.measureIndex) === Number(issue?.measureIndex)
    ));
    if (!section || !note || !isErhuNote(note, section)) {
      hiddenNotes += 1;
      continue;
    }
    visibleNotes += 1;
    const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
    if (role && role !== "erhu") {
      failures.push({ type: "note-on-accompaniment", analysisId: analysis.analysisId, sectionId: section.sectionId, noteId: issue.noteId });
    }
  }
  for (const issue of analysis?.measureFindings || []) {
    const section = resolveIssueSection(score, issue);
    if (!section || !hasErhuMeasure(section, issue.measureIndex)) {
      hiddenMeasures += 1;
      continue;
    }
    visibleMeasures += 1;
    if (isAccompanimentOnly(section)) {
      failures.push({ type: "measure-on-accompaniment", analysisId: analysis.analysisId, sectionId: section.sectionId, measureIndex: issue.measureIndex });
    }
  }
  return { failures, visibleNotes, hiddenNotes, visibleMeasures, hiddenMeasures };
}

const scoreStore = readJson("data/erhu-score-imports.json", { scores: [] });
const piecePassStore = readJson("data/erhu-piece-pass-jobs.json", { jobs: [] });
const studyStore = readJson("data/erhu-study-records.json", { analyses: [] });
const scoresById = new Map((scoreStore.scores || []).map((score) => [score.scoreId, score]));
const analyses = [];

for (const job of piecePassStore.jobs || []) {
  if (job.status !== "completed" || !job.wholePieceAnalysis) continue;
  analyses.push(job.wholePieceAnalysis);
}
for (const analysis of studyStore.analyses || []) {
  analyses.push(analysis);
}

const summary = {
  checkedAnalyses: 0,
  skippedMissingScore: 0,
  visibleNotes: 0,
  hiddenNotes: 0,
  visibleMeasures: 0,
  hiddenMeasures: 0,
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
  summary.failures.push(...result.failures);
}

console.log(JSON.stringify(summary, null, 2));
if (summary.failures.length) {
  process.exitCode = 1;
}
