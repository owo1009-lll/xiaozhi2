import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const outputRoot = path.join(repoRoot, "data", "real-tests", "alignment-quality");
const MAINLINE_ANALYSIS_MODES = new Set(["whole-piece"]);
const MAINLINE_REVIEW_WARN_THRESHOLD = Number(process.env.ERHU_MAINLINE_REVIEW_WARN_THRESHOLD || 0.35);

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
      console.warn(`[dtw-quality] Skipping unreadable corpus summary ${path.relative(repoRoot, summaryPath)}: ${error.message}`);
    }
  }
  return analyses;
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
  return true;
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

function parseXmlNoteId(noteId) {
  const match = String(noteId || "").trim().match(/^xml-m(\d+)-n(\d+)$/i);
  return match ? { measureIndex: Number(match[1]), noteIndex: Number(match[2]) } : null;
}

function issueMeasureIndex(issueOrMeasure = 0) {
  if (issueOrMeasure && typeof issueOrMeasure === "object") {
    return Number(issueOrMeasure.measureIndex) || parseXmlNoteId(issueOrMeasure.noteId)?.measureIndex || 1;
  }
  return Number(issueOrMeasure) || 1;
}

function noteMeasureMatchesIssue(note, issueOrMeasure) {
  const numericMeasure = issueMeasureIndex(issueOrMeasure);
  if (Number(note?.measureIndex) === numericMeasure) return true;
  const position = note?.notePosition || {};
  if (Number(position.localMeasureIndex) === numericMeasure) return true;
  const localNote = parseXmlNoteId(position.localNoteId);
  return Boolean(localNote && localNote.measureIndex === numericMeasure);
}

function noteIdMatchesIssue(note, issue) {
  const noteId = String(issue?.noteId || "").trim();
  if (!noteId) return true;
  if (String(note?.noteId || "") === noteId) return true;
  const position = note?.notePosition || {};
  return String(position.localNoteId || "") === noteId;
}

function noteMatchesIssue(note, issue) {
  return noteMeasureMatchesIssue(note, issue) && noteIdMatchesIssue(note, issue);
}

function hasErhuMeasure(section, issueOrMeasure) {
  return (section?.notes || []).some((note) => (
    noteMeasureMatchesIssue(note, issueOrMeasure) && isErhuNote(note, section)
  ));
}

function sortedErhuMeasureNotes(section, issueOrMeasure) {
  return (section?.notes || [])
    .filter((note) => noteMeasureMatchesIssue(note, issueOrMeasure) && isErhuNote(note, section))
    .sort((left, right) => {
      const beatDelta = numberValue(left?.beatStart, 0) - numberValue(right?.beatStart, 0);
      if (Math.abs(beatDelta) > 0.0001) return beatDelta;
      return numberValue(left?.notePosition?.normalizedX, 0) - numberValue(right?.notePosition?.normalizedX, 0);
    });
}

function hasProjectedErhuNote(section, issue) {
  const candidates = sortedErhuMeasureNotes(section, issue);
  if (!candidates.length) return false;
  const noteId = String(issue?.noteId || "").trim();
  if (noteId && candidates.some((note) => noteIdMatchesIssue(note, issue))) return true;
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
  const exact = pageSections.find((section) => (section.notes || []).some((note) => (
    noteMatchesIssue(note, issue)
  )));
  if (exact) return exact;
  return pageSections.find((section) => hasErhuMeasure(section, issue)) || pageSections[0] || null;
}

function scopeIssueToAnalysis(issue, analysis) {
  return {
    ...issue,
    sectionId: issue?.sectionId || analysis?.sectionId || "",
  };
}

function auditNoteIssue(score, analysis, issue) {
  const scopedIssue = scopeIssueToAnalysis(issue, analysis);
  const section = resolveQualitySection(score, scopedIssue);
  const noteId = String(issue?.noteId || "").trim();
  if (!section) {
    return { status: "review", reason: "missing-section" };
  }
  const exactNote = (section.notes || []).find((note) => (
    noteMatchesIssue(note, scopedIssue)
  ));
  if (exactNote && isErhuNote(exactNote, section)) {
    return { status: "exact-note", sectionId: section.sectionId };
  }
  if (exactNote && isAccompanimentNote(exactNote, section)) {
    return {
      status: "review",
      reason: "exact-note-on-accompaniment",
      sectionId: section.sectionId,
      noteId,
      analysisId: analysis.analysisId,
    };
  }
  if (hasProjectedErhuNote(section, scopedIssue)) {
    return { status: "exact-note", reason: "projected-to-erhu-measure-note", sectionId: section.sectionId };
  }
  if (hasErhuMeasure(section, scopedIssue)) {
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
  const scopedIssue = scopeIssueToAnalysis(issue, analysis);
  const section = resolveQualitySection(score, scopedIssue);
  if (!section) {
    return { status: "review", reason: "missing-section" };
  }
  if (hasErhuMeasure(section, scopedIssue)) {
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
    issueCount: 0,
    reviewIssueCount: 0,
    reviewRate: 0,
    accompanimentFailureCount: 0,
    accompanimentFailureRate: 0,
    reviewReasonBreakdown: {},
    reviewSamples: [],
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

function finalizeAnalysisSummary(target) {
  const totalIssues = target.noteIssueCount + target.measureIssueCount;
  const totalFailures = target.noteAccompanimentFailureCount + target.measureAccompanimentFailureCount;
  const totalReview = target.noteReviewCount + target.measureReviewCount;
  target.issueCount = totalIssues;
  target.reviewIssueCount = totalReview;
  target.reviewRate = rate(totalReview, totalIssues);
  target.accompanimentFailureCount = totalFailures;
  target.accompanimentFailureRate = rate(totalFailures, totalIssues);
  return target;
}

function addReason(target, reason) {
  const key = String(reason || "unknown-review-reason");
  target[key] = (target[key] || 0) + 1;
}

function mergeReasonBreakdown(target, source = {}) {
  for (const [reason, count] of Object.entries(source || {})) {
    target[reason] = (target[reason] || 0) + numberValue(count, 0);
  }
  return target;
}

function topReasonText(source = {}, limit = 3) {
  return Object.entries(source || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(", ");
}

function addReviewSample(result, issueType, issue, auditItem) {
  const reason = auditItem?.reason || "unknown-review-reason";
  addReason(result.reviewReasonBreakdown, reason);
  if (result.reviewSamples.length >= 20) return;
  result.reviewSamples.push({
    issueType,
    reason,
    sectionId: auditItem?.sectionId || issue?.sectionId || "",
    pageNumber: Number(issue?.sourcePageNumber || issue?.pageNumber) || null,
    measureIndex: Number(issue?.measureIndex) || null,
    noteId: issue?.noteId || "",
    severity: issue?.severity || "",
    issueKind: issue?.type || issue?.issueType || "",
  });
}

function addAnalysisSummary(target, result) {
  target.checkedAnalyses += 1;
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
    target[key] += result[key];
  }
  return target;
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
    const mode = String(analysis?.analysisMode || "");
    if (!MAINLINE_ANALYSIS_MODES.has(mode)) continue;
    const key = `${String(analysis?.scoreId || "")}::${String(analysis?.audioHash || "") || "no-audio"}`;
    const timestamp = analysisTimestamp(analysis);
    const existing = latestByKey.get(key);
    if (!existing || timestamp >= existing.timestamp) {
      latestByKey.set(key, { analysis, timestamp });
    }
  }
  return [...latestByKey.values()].map((item) => item.analysis);
}

function currentMainlineAnalyses(analyses = []) {
  const latestByScore = new Map();
  for (const analysis of analyses) {
    const mode = String(analysis?.analysisMode || "");
    if (!MAINLINE_ANALYSIS_MODES.has(mode)) continue;
    const key = String(analysis?.scoreId || analysis?.pieceId || analysis?.pieceTitle || "").trim();
    if (!key) continue;
    const timestamp = analysisTimestamp(analysis);
    const existing = latestByScore.get(key);
    if (!existing || timestamp >= existing.timestamp) {
      latestByScore.set(key, { analysis, timestamp });
    }
  }
  return [...latestByScore.values()].map((item) => item.analysis);
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
      addReviewSample(result, "note", issue, item);
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
      addReviewSample(result, "measure", issue, item);
    }
  }

  return { result: finalizeAnalysisSummary(result), failures };
}

function reviewHotspots(items = [], limit = 5) {
  return items
    .filter((item) => item.reviewIssueCount > 0 || item.accompanimentFailureCount > 0)
    .slice(0, limit)
    .map((item) => ({
      pieceTitle: item.pieceTitle || item.scoreId,
      analysisId: item.analysisId,
      issueCount: item.issueCount,
      reviewIssueCount: item.reviewIssueCount,
      reviewRate: item.reviewRate,
      accompanimentFailureCount: item.accompanimentFailureCount,
      topReviewReasons: topReasonText(item.reviewReasonBreakdown),
    }));
}

function reviewIssueSamples(items = [], limit = 20) {
  const samples = [];
  for (const item of items) {
    for (const sample of item.reviewSamples || []) {
      samples.push({
        pieceTitle: item.pieceTitle || item.scoreId,
        analysisId: item.analysisId,
        ...sample,
      });
      if (samples.length >= limit) return samples;
    }
  }
  return samples;
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
  for (const analysis of collectRealCorpusAnalyses()) {
    byId.set(analysis.analysisId, analysis);
  }
  return [...byId.values()];
}

function writeMarkdown(report, filePath) {
  const latestReviewHotspots = reviewHotspots(report.latestMainlinePerAnalysis, 10);
  const currentReviewHotspots = reviewHotspots(report.currentMainlinePerAnalysis, 10);
  const allReviewHotspots = reviewHotspots(report.perAnalysis, 10);
  const latestReviewSamples = reviewIssueSamples(report.latestMainlinePerAnalysis, 20);
  const currentReviewSamples = reviewIssueSamples(report.currentMainlinePerAnalysis, 20);
  const allReviewSamples = reviewIssueSamples(report.perAnalysis, 20);
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
    "## Mainline Only",
    "",
    `- Mainline checked analyses: ${report.mainline?.checkedAnalyses || 0}`,
    `- Mainline note exact rate: ${((report.mainline?.exactNoteRate || 0) * 100).toFixed(1)}%`,
    `- Mainline measure-located rate: ${((report.mainline?.measureLocatedRate || 0) * 100).toFixed(1)}%`,
    `- Mainline review-needed rate: ${((report.mainline?.reviewRate || 0) * 100).toFixed(1)}%`,
    `- Mainline accompaniment failure rate: ${((report.mainline?.accompanimentFailureRate || 0) * 100).toFixed(2)}%`,
    "",
    "## Latest Mainline By Score/Audio",
    "",
    `- Latest mainline checked analyses: ${report.latestMainline?.checkedAnalyses || 0}`,
    `- Latest mainline note exact rate: ${((report.latestMainline?.exactNoteRate || 0) * 100).toFixed(1)}%`,
    `- Latest mainline measure-located rate: ${((report.latestMainline?.measureLocatedRate || 0) * 100).toFixed(1)}%`,
    `- Latest mainline review-needed rate: ${((report.latestMainline?.reviewRate || 0) * 100).toFixed(1)}%`,
    `- Latest mainline accompaniment failure rate: ${((report.latestMainline?.accompanimentFailureRate || 0) * 100).toFixed(2)}%`,
    "",
    "## Current Mainline By Score",
    "",
    `- Current mainline checked analyses: ${report.currentMainline?.checkedAnalyses || 0}`,
    `- Current mainline note exact rate: ${((report.currentMainline?.exactNoteRate || 0) * 100).toFixed(1)}%`,
    `- Current mainline measure-located rate: ${((report.currentMainline?.measureLocatedRate || 0) * 100).toFixed(1)}%`,
    `- Current mainline review-needed rate: ${((report.currentMainline?.reviewRate || 0) * 100).toFixed(1)}%`,
    `- Current mainline accompaniment failure rate: ${((report.currentMainline?.accompanimentFailureRate || 0) * 100).toFixed(2)}%`,
    "",
    "## Current Mainline Per Analysis",
    "",
    "| Piece | Analysis | Issues | Review-needed | Review % | Accompaniment failures |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...(report.currentMainlinePerAnalysis?.length
      ? report.currentMainlinePerAnalysis.map((item) => `| ${item.pieceTitle || item.scoreId} | ${item.analysisId} | ${item.issueCount} | ${item.reviewIssueCount} | ${(item.reviewRate * 100).toFixed(1)}% | ${item.accompanimentFailureCount} |`)
      : ["| None |  | 0 | 0 | 0.0% | 0 |"]),
    "",
    "## Current Mainline Review Hotspots",
    "",
    "| Piece | Analysis | Issues | Review-needed | Review % | Top reasons | Accompaniment failures |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: |",
    ...(currentReviewHotspots.length
      ? currentReviewHotspots.map((item) => `| ${item.pieceTitle} | ${item.analysisId} | ${item.issueCount} | ${item.reviewIssueCount} | ${(item.reviewRate * 100).toFixed(1)}% | ${item.topReviewReasons || ""} | ${item.accompanimentFailureCount} |`)
      : ["| None |  | 0 | 0 | 0.0% |  | 0 |"]),
    "",
    "## Latest Mainline Per Analysis",
    "",
    "| Piece | Analysis | Issues | Review-needed | Review % | Accompaniment failures |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...(report.latestMainlinePerAnalysis?.length
      ? report.latestMainlinePerAnalysis.map((item) => `| ${item.pieceTitle || item.scoreId} | ${item.analysisId} | ${item.issueCount} | ${item.reviewIssueCount} | ${(item.reviewRate * 100).toFixed(1)}% | ${item.accompanimentFailureCount} |`)
      : ["| None |  | 0 | 0 | 0.0% | 0 |"]),
    "",
    "## Latest Mainline Review Hotspots",
    "",
    "| Piece | Analysis | Issues | Review-needed | Review % | Top reasons | Accompaniment failures |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: |",
    ...(latestReviewHotspots.length
      ? latestReviewHotspots.map((item) => `| ${item.pieceTitle} | ${item.analysisId} | ${item.issueCount} | ${item.reviewIssueCount} | ${(item.reviewRate * 100).toFixed(1)}% | ${item.topReviewReasons || ""} | ${item.accompanimentFailureCount} |`)
      : ["| None |  | 0 | 0 | 0.0% |  | 0 |"]),
    "",
    "## Historical / All Review Hotspots",
    "",
    "| Piece | Analysis | Issues | Review-needed | Review % | Top reasons | Accompaniment failures |",
    "| --- | --- | ---: | ---: | ---: | --- | ---: |",
    ...(allReviewHotspots.length
      ? allReviewHotspots.map((item) => `| ${item.pieceTitle} | ${item.analysisId} | ${item.issueCount} | ${item.reviewIssueCount} | ${(item.reviewRate * 100).toFixed(1)}% | ${item.topReviewReasons || ""} | ${item.accompanimentFailureCount} |`)
      : ["| None |  | 0 | 0 | 0.0% |  | 0 |"]),
    "",
    "## Review Reason Breakdown",
    "",
    `- Latest mainline: ${topReasonText(report.latestMainlineReviewReasonBreakdown) || "none"}`,
    `- Current mainline: ${topReasonText(report.currentMainlineReviewReasonBreakdown) || "none"}`,
    `- Mainline: ${topReasonText(report.mainlineReviewReasonBreakdown) || "none"}`,
    `- All analyses: ${topReasonText(report.reviewReasonBreakdown) || "none"}`,
    "",
    "## Latest Mainline Review Samples",
    "",
    "| Piece | Analysis | Type | Reason | Section | Page | Measure | Note |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ...(latestReviewSamples.length
      ? latestReviewSamples.map((item) => `| ${item.pieceTitle} | ${item.analysisId} | ${item.issueType} | ${item.reason} | ${item.sectionId || ""} | ${item.pageNumber || ""} | ${item.measureIndex || ""} | ${item.noteId || ""} |`)
      : ["| None |  |  |  |  |  |  |  |"]),
    "",
    "## Current Mainline Review Samples",
    "",
    "| Piece | Analysis | Type | Reason | Section | Page | Measure | Note |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ...(currentReviewSamples.length
      ? currentReviewSamples.map((item) => `| ${item.pieceTitle} | ${item.analysisId} | ${item.issueType} | ${item.reason} | ${item.sectionId || ""} | ${item.pageNumber || ""} | ${item.measureIndex || ""} | ${item.noteId || ""} |`)
      : ["| None |  |  |  |  |  |  |  |"]),
    "",
    "## Historical / All Review Samples",
    "",
    "| Piece | Analysis | Type | Reason | Section | Page | Measure | Note |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ...(allReviewSamples.length
      ? allReviewSamples.map((item) => `| ${item.pieceTitle} | ${item.analysisId} | ${item.issueType} | ${item.reason} | ${item.sectionId || ""} | ${item.pageNumber || ""} | ${item.measureIndex || ""} | ${item.noteId || ""} |`)
      : ["| None |  |  |  |  |  |  |  |"]),
    "",
    "## Warnings",
    "",
    ...(report.warnings?.length ? report.warnings.map((warning) => `- ${warning}`) : ["- None"]),
    "",
    "## Per Analysis",
    "",
    "| Piece | Analysis | Notes exact/measure/review/fail | Measures exact/review/fail | Review % |",
    "| --- | --- | --- | --- | ---: |",
  ];
  for (const item of report.perAnalysis) {
    lines.push(`| ${item.pieceTitle || item.scoreId} | ${item.analysisId} | ${item.noteExactCount}/${item.noteMeasureOnlyCount}/${item.noteReviewCount}/${item.noteAccompanimentFailureCount} | ${item.measureExactCount}/${item.measureReviewCount}/${item.measureAccompanimentFailureCount} | ${(item.reviewRate * 100).toFixed(1)}% |`);
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
const latestMainlineAnalysesList = latestMainlineAnalyses(analyses);
const currentMainlineAnalysesList = currentMainlineAnalyses(analyses);

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
  mainline: emptyTotals(),
  latestMainline: emptyTotals(),
  currentMainline: emptyTotals(),
  perAnalysis: [],
  latestMainlinePerAnalysis: [],
  currentMainlinePerAnalysis: [],
  reviewReasonBreakdown: {},
  mainlineReviewReasonBreakdown: {},
  latestMainlineReviewReasonBreakdown: {},
  currentMainlineReviewReasonBreakdown: {},
  failures: [],
  warnings: [],
};

for (const analysis of analyses) {
  const score = scoresById.get(String(analysis.scoreId || ""));
  if (!score) {
    report.skippedMissingScore += 1;
    continue;
  }
  const { result, failures } = auditAnalysis(score, analysis);
  report.perAnalysis.push(result);
  report.failures.push(...failures);
  const mode = String(result.analysisMode || "unknown");
  if (!report.modeBreakdown[mode]) report.modeBreakdown[mode] = emptyTotals();
  addAnalysisSummary(report, result);
  mergeReasonBreakdown(report.reviewReasonBreakdown, result.reviewReasonBreakdown);
  addAnalysisSummary(report.modeBreakdown[mode], result);
  if (MAINLINE_ANALYSIS_MODES.has(mode)) {
    addAnalysisSummary(report.mainline, result);
    mergeReasonBreakdown(report.mainlineReviewReasonBreakdown, result.reviewReasonBreakdown);
  }
}

for (const analysis of latestMainlineAnalysesList) {
  const score = scoresById.get(String(analysis.scoreId || ""));
  if (!score) continue;
  const { result } = auditAnalysis(score, analysis);
  report.latestMainlinePerAnalysis.push(result);
  addAnalysisSummary(report.latestMainline, result);
  mergeReasonBreakdown(report.latestMainlineReviewReasonBreakdown, result.reviewReasonBreakdown);
}

for (const analysis of currentMainlineAnalysesList) {
  const score = scoresById.get(String(analysis.scoreId || ""));
  if (!score) continue;
  const { result } = auditAnalysis(score, analysis);
  report.currentMainlinePerAnalysis.push(result);
  addAnalysisSummary(report.currentMainline, result);
  mergeReasonBreakdown(report.currentMainlineReviewReasonBreakdown, result.reviewReasonBreakdown);
}

const totalIssues = report.noteIssueCount + report.measureIssueCount;
const totalFailures = report.noteAccompanimentFailureCount + report.measureAccompanimentFailureCount;
finalizeRates(report);
for (const totals of Object.values(report.modeBreakdown)) {
  finalizeRates(totals);
}
finalizeRates(report.mainline);
finalizeRates(report.latestMainline);
finalizeRates(report.currentMainline);
if (
  report.mainline.checkedAnalyses > 0
  && Number.isFinite(MAINLINE_REVIEW_WARN_THRESHOLD)
  && MAINLINE_REVIEW_WARN_THRESHOLD >= 0
  && report.mainline.reviewRate > MAINLINE_REVIEW_WARN_THRESHOLD
) {
  report.warnings.push(
    `Mainline whole-piece reviewRate ${(report.mainline.reviewRate * 100).toFixed(1)}% exceeds warning threshold ${(MAINLINE_REVIEW_WARN_THRESHOLD * 100).toFixed(1)}%.`,
  );
}
report.perAnalysis.sort((left, right) => (
  right.accompanimentFailureCount - left.accompanimentFailureCount
  || right.reviewIssueCount - left.reviewIssueCount
));
report.latestMainlinePerAnalysis.sort((left, right) => (
  right.reviewIssueCount - left.reviewIssueCount
  || String(left.pieceTitle || left.scoreId).localeCompare(String(right.pieceTitle || right.scoreId), "zh-Hans-CN")
));
report.currentMainlinePerAnalysis.sort((left, right) => (
  right.reviewIssueCount - left.reviewIssueCount
  || String(left.pieceTitle || left.scoreId).localeCompare(String(right.pieceTitle || right.scoreId), "zh-Hans-CN")
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
  mainlineCheckedAnalyses: report.mainline.checkedAnalyses,
  mainlineExactNoteRate: report.mainline.exactNoteRate,
  mainlineMeasureLocatedRate: report.mainline.measureLocatedRate,
  mainlineReviewRate: report.mainline.reviewRate,
  mainlineAccompanimentFailureRate: report.mainline.accompanimentFailureRate,
  latestMainlineCheckedAnalyses: report.latestMainline.checkedAnalyses,
  latestMainlineExactNoteRate: report.latestMainline.exactNoteRate,
  latestMainlineMeasureLocatedRate: report.latestMainline.measureLocatedRate,
  latestMainlineReviewRate: report.latestMainline.reviewRate,
  latestMainlineAccompanimentFailureRate: report.latestMainline.accompanimentFailureRate,
  latestMainlineReviewHotspots: reviewHotspots(report.latestMainlinePerAnalysis),
  latestMainlineReviewReasonBreakdown: report.latestMainlineReviewReasonBreakdown,
  latestMainlineReviewSamples: reviewIssueSamples(report.latestMainlinePerAnalysis, 10),
  currentMainlineCheckedAnalyses: report.currentMainline.checkedAnalyses,
  currentMainlineExactNoteRate: report.currentMainline.exactNoteRate,
  currentMainlineMeasureLocatedRate: report.currentMainline.measureLocatedRate,
  currentMainlineReviewRate: report.currentMainline.reviewRate,
  currentMainlineAccompanimentFailureRate: report.currentMainline.accompanimentFailureRate,
  currentMainlineReviewHotspots: reviewHotspots(report.currentMainlinePerAnalysis),
  currentMainlineReviewReasonBreakdown: report.currentMainlineReviewReasonBreakdown,
  currentMainlineReviewSamples: reviewIssueSamples(report.currentMainlinePerAnalysis, 10),
  historicalReviewHotspots: reviewHotspots(report.perAnalysis),
  historicalReviewReasonBreakdown: report.reviewReasonBreakdown,
  historicalReviewSamples: reviewIssueSamples(report.perAnalysis, 10),
  warnings: report.warnings,
  output: path.relative(repoRoot, latestJsonPath),
}, null, 2));

for (const warning of report.warnings) {
  console.warn(`[dtw-quality warning] ${warning}`);
}

if (totalFailures > 0) {
  process.exitCode = 1;
}
