import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotateImportedSectionsScoreLineRoles,
  buildScoreLineStatsFromNotes,
  buildScoreLineStatsFromSections,
  effectiveSelectedPartConfidence,
} from "../src/server/scoreLineRoles.js";
import { buildOmrQualityGate, normalizeOmrStats } from "../src/server/omrStats.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const pruneStale = args.has("--prune-stale");
const storePath = path.join(repoRoot, "data", "erhu-score-imports.json");
const reportDir = path.join(repoRoot, "data", "real-tests", "score-line-migration");
const reportPath = path.join(reportDir, "latest-score-line-migration.json");

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round3(value) {
  return Number(numberValue(value).toFixed(3));
}

function getNotes(score) {
  return (Array.isArray(score?.sections) ? score.sections : [])
    .flatMap((section) => (Array.isArray(section?.notes) ? section.notes : []));
}

function hasImportedLayout(score) {
  return (Array.isArray(score?.sections) ? score.sections : []).some((section) => (
    /page[-\s]?0*\d+/i.test(`${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`) &&
    (section?.notes || []).some((note) => Number.isFinite(Number(note?.notePosition?.normalizedY)))
  ));
}

function rolelessLayoutNoteCount(score) {
  return getNotes(score).filter((note) => (
    Number.isFinite(Number(note?.notePosition?.normalizedY)) &&
    !String(note?.notePosition?.scoreLineRole || "").trim()
  )).length;
}

function needsCoverageStats(score) {
  const stats = score?.scoreLineStats || {};
  return getNotes(score).length > 0 && (
    !Number.isFinite(Number(stats.erhuPageCoverage)) ||
    !Number.isFinite(Number(stats.erhuMeasureCoverage))
  );
}

function buildResidualSummary(scores) {
  const rows = [];
  const counts = {
    scoreCount: scores.length,
    importedLayoutScoreCount: 0,
    rolelessImportedScoreCount: 0,
    missingCoverageStatsCount: 0,
    lowSelectedPartConfidenceCount: 0,
    lowErhuCoverageCount: 0,
  };

  for (const score of scores) {
    const notes = getNotes(score);
    const stats = score?.scoreLineStats || {};
    const importedLayout = hasImportedLayout(score);
    const rolelessNotes = rolelessLayoutNoteCount(score);
    const missingCoverageStats = needsCoverageStats(score);
    const selectedPartConfidence = numberValue(score?.selectedPartConfidence);
    const erhuRatio = numberValue(stats.erhuRatio);
    const erhuPageCoverage = numberValue(stats.erhuPageCoverage);
    const lowErhuCoverage = importedLayout && notes.length > 0 && erhuRatio < 0.5 && erhuPageCoverage < 0.72;

    if (importedLayout) counts.importedLayoutScoreCount += 1;
    if (importedLayout && rolelessNotes > 0) counts.rolelessImportedScoreCount += 1;
    if (missingCoverageStats) counts.missingCoverageStatsCount += 1;
    if (selectedPartConfidence > 0 && selectedPartConfidence < 0.85) counts.lowSelectedPartConfidenceCount += 1;
    if (lowErhuCoverage) counts.lowErhuCoverageCount += 1;

    if (importedLayout && (rolelessNotes > 0 || missingCoverageStats || lowErhuCoverage)) {
      rows.push({
        scoreId: score?.scoreId || "",
        title: score?.title || "",
        noteCount: notes.length,
        rolelessNotes,
        selectedPartConfidence,
        erhuRatio,
        erhuPageCoverage,
        missingCoverageStats,
        lowErhuCoverage,
      });
    }
  }
  return {
    ...counts,
    topResiduals: rows
      .sort((left, right) => (right.rolelessNotes - left.rolelessNotes) || left.title.localeCompare(right.title, "zh-Hans-CN"))
      .slice(0, 20),
  };
}

function buildJobResidualSummary(jobs) {
  const rows = [];
  let cachedJobMissingStatsCount = 0;
  for (const job of jobs) {
    const cached = Boolean(job?.cacheHit || job?.reusedScoreId);
    const noteCount = numberValue(job?.scoreLineStats?.noteCount);
    const sectionCount = numberValue(job?.sectionCount);
    if (cached && noteCount <= 0 && sectionCount <= 0) {
      cachedJobMissingStatsCount += 1;
      rows.push({
        jobId: job?.jobId || "",
        scoreId: job?.scoreId || "",
        title: job?.title || "",
      });
    }
  }
  return {
    cachedJobMissingStatsCount,
    topResiduals: rows.slice(0, 20),
  };
}

function migrateScore(score) {
  const annotatedSections = annotateImportedSectionsScoreLineRoles(score?.sections || [], score);
  const sections = annotatedSections.map((section) => {
    const notes = Array.isArray(section?.notes) ? section.notes : [];
    if (!notes.length) return section;
    return {
      ...section,
      scoreLineStats: buildScoreLineStatsFromNotes(notes),
    };
  });
  const scoreLineStats = buildScoreLineStatsFromSections(sections);
  return {
    ...score,
    selectedPartConfidence: round3(effectiveSelectedPartConfidence(score?.selectedPartConfidence, sections)),
    scoreLineStats: {
      ...(score?.scoreLineStats && typeof score.scoreLineStats === "object" ? score.scoreLineStats : {}),
      ...scoreLineStats,
    },
    sections,
  };
}

function migrateJob(job, scoreById) {
  const score = scoreById.get(String(job?.scoreId || ""));
  if (!score || !Boolean(job?.cacheHit || job?.reusedScoreId)) return job;
  const sections = Array.isArray(score.sections) ? score.sections : [];
  const sectionCount = sections.length;
  const scoreLineStats = score.scoreLineStats && typeof score.scoreLineStats === "object"
    ? score.scoreLineStats
    : buildScoreLineStatsFromSections(sections);
  const selectedPartConfidence = round3(effectiveSelectedPartConfidence(score.selectedPartConfidence, sections));
  const omrStats = normalizeOmrStats(job.omrStats || score.omrStats);
  const omrQualityGate = buildOmrQualityGate({
    omrStatus: job.omrStatus || score.omrStatus,
    omrConfidence: numberValue(job.omrConfidence, score.omrConfidence),
    omrStats,
    selectedPartConfidence,
    scoreLineStats,
    partCandidates: Array.isArray(score.partCandidates) ? score.partCandidates : [],
    sectionCount,
    selectedPartConfirmed: Boolean(job.selectedPartConfirmed || score.selectedPartConfirmed),
  });
  return {
    ...job,
    selectedPartConfidence,
    partCandidates: Array.isArray(score.partCandidates) ? score.partCandidates : job.partCandidates,
    markingStats: score.markingStats || job.markingStats,
    scoreLineStats,
    sectionCount,
    omrStats: { ...omrStats, qualityGate: omrQualityGate },
    omrQualityGate,
  };
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function scoreIsReferenced(scoreId) {
  const text = [
    readTextIfExists(path.join(repoRoot, "data", "erhu-analysis-jobs.json")),
    readTextIfExists(path.join(repoRoot, "data", "erhu-piece-pass-jobs.json")),
    readTextIfExists(path.join(repoRoot, "data", "erhu-study-records.json")),
  ].join("\n");
  return Boolean(scoreId && text.includes(scoreId));
}

function isPrunableStaleScore(score) {
  const notes = getNotes(score);
  if (!notes.length || scoreIsReferenced(score?.scoreId || "")) return false;
  const hasPosition = notes.some((note) => Number.isFinite(Number(note?.notePosition?.normalizedX)) && Number.isFinite(Number(note?.notePosition?.normalizedY)));
  const title = String(score?.title || "");
  if (hasPosition) return false;
  if (/frontend-verify/i.test(title)) return true;
  const stats = score?.scoreLineStats || {};
  const partCandidates = Array.isArray(score?.partCandidates) ? score.partCandidates : [];
  if (partCandidates.length) return false;
  return numberValue(score?.selectedPartConfidence) === 0 &&
    numberValue(score?.omrConfidence) <= 0.72 &&
    numberValue(stats.erhuRatio) === 0;
}

function isPrunableStaleJob(job, activeScoreIds, prunedScoreIds) {
  const scoreId = String(job?.scoreId || "");
  const title = `${job?.title || ""} ${job?.originalFilename || ""}`;
  const orphanCachedJob = Boolean(job?.cacheHit || job?.reusedScoreId) && scoreId && !activeScoreIds.has(scoreId);
  return scoreId &&
    !activeScoreIds.has(scoreId) &&
    !scoreIsReferenced(scoreId) &&
    (prunedScoreIds.has(scoreId) || orphanCachedJob || /frontend-verify/i.test(title));
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function main() {
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const jobs = Array.isArray(store.jobs) ? store.jobs : [];
  const scores = Array.isArray(store.scores) ? store.scores : [];
  const migratedScores = scores.map(migrateScore);
  const scoreById = new Map(migratedScores.map((score) => [String(score?.scoreId || ""), score]));
  const migratedJobs = jobs.map((job) => migrateJob(job, scoreById));
  const prunedScores = pruneStale ? migratedScores.filter(isPrunableStaleScore) : [];
  const finalScores = pruneStale
    ? migratedScores.filter((score) => !prunedScores.some((item) => item.scoreId === score.scoreId))
    : migratedScores;
  const prunedScoreIds = new Set(prunedScores.map((score) => String(score?.scoreId || "")).filter(Boolean));
  const activeScoreIds = new Set(finalScores.map((score) => String(score?.scoreId || "")).filter(Boolean));
  const prunedJobs = pruneStale ? migratedJobs.filter((job) => isPrunableStaleJob(job, activeScoreIds, prunedScoreIds)) : [];
  const prunedJobIds = new Set(prunedJobs.map((job) => String(job?.jobId || "")).filter(Boolean));
  const finalJobs = pruneStale ? migratedJobs.filter((job) => !prunedJobIds.has(String(job?.jobId || ""))) : migratedJobs;
  const changedScores = migratedScores.filter((score, index) => JSON.stringify(score) !== JSON.stringify(scores[index]));
  const changedJobs = migratedJobs.filter((job, index) => JSON.stringify(job) !== JSON.stringify(jobs[index]));
  const report = {
    createdAt: new Date().toISOString(),
    mode: apply ? "apply" : "audit",
    pruneStale,
    storePath: path.relative(repoRoot, storePath),
    scoreCount: scores.length,
    changedScoreCount: changedScores.length,
    changedJobCount: changedJobs.length,
    finalScoreCount: finalScores.length,
    prunedScoreCount: prunedScores.length,
    prunedJobCount: prunedJobs.length,
    before: buildResidualSummary(scores),
    after: buildResidualSummary(finalScores),
    beforeJobs: buildJobResidualSummary(jobs),
    afterJobs: buildJobResidualSummary(finalJobs),
    prunedScores: prunedScores.map((score) => ({
      scoreId: score.scoreId || "",
      title: score.title || "",
      noteCount: getNotes(score).length,
    })),
    prunedJobs: prunedJobs.map((job) => ({
      jobId: job.jobId || "",
      scoreId: job.scoreId || "",
      title: job.title || "",
    })),
    changedScores: changedScores.slice(0, 30).map((score) => ({
      scoreId: score.scoreId || "",
      title: score.title || "",
      selectedPartConfidence: score.selectedPartConfidence,
      erhuRatio: score.scoreLineStats?.erhuRatio,
      erhuPageCoverage: score.scoreLineStats?.erhuPageCoverage,
      erhuMeasureCoverage: score.scoreLineStats?.erhuMeasureCoverage,
    })),
  };

  fs.mkdirSync(reportDir, { recursive: true });
  if (apply && (changedScores.length || changedJobs.length || prunedScores.length || prunedJobs.length)) {
    const backupDir = path.join(repoRoot, "data", "store-archive");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `erhu-score-imports-score-line-backup-${stamp}.json`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(storePath, backupPath);
    report.backupPath = path.relative(repoRoot, backupPath);
    if (prunedScores.length || prunedJobs.length) {
      const prunedPath = path.join(backupDir, `erhu-score-imports-pruned-stale-${stamp}.json`);
      writeJsonAtomic(prunedPath, { scores: prunedScores, jobs: prunedJobs });
      report.prunedPath = path.relative(repoRoot, prunedPath);
    }
    writeJsonAtomic(storePath, { ...store, jobs: finalJobs, scores: finalScores });
  }
  writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify({
    ok: true,
    mode: report.mode,
    outputPath: path.relative(repoRoot, reportPath),
    backupPath: report.backupPath || "",
    prunedPath: report.prunedPath || "",
    scoreCount: report.scoreCount,
    changedScoreCount: report.changedScoreCount,
    changedJobCount: report.changedJobCount,
    finalScoreCount: report.finalScoreCount,
    prunedScoreCount: report.prunedScoreCount,
    prunedJobCount: report.prunedJobCount,
    before: report.before,
    after: report.after,
    beforeJobs: report.beforeJobs,
    afterJobs: report.afterJobs,
  }, null, 2));
}

main();
