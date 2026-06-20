import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteJson,
  enqueueStoreOperation,
  readJsonFileUnlocked,
  waitForStoreOperations,
} from "./jsonStore.js";
import {
  clamp,
  getArray,
  nowIso,
  nullableInteger,
  repairMojibakeText,
  safeNumber,
  safeString,
} from "./baseUtils.js";
import {
  getErhuMelodyNotes,
  hasAccompanimentPartCandidate,
  resolveIssueSection,
} from "../scoreIssue/scoreIssueProjection.js";

function toUniqueStringList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => (item == null ? "" : String(item)).trim()).filter(Boolean)));
  }
  return Array.from(new Set(String(value || "").split(/[\s,;|，；]+/).map((item) => item.trim()).filter(Boolean)));
}

function toUniqueNumberList(value) {
  return Array.from(
    new Set(
      toUniqueStringList(value)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.round(item)),
    ),
  );
}

function parsePagewiseSectionPage(section = {}) {
  const sectionText = `${safeString(section.sectionId)} ${safeString(section.sourceSectionId)}`;
  const sectionMatch = sectionText.match(/\bpage-(\d+)/i);
  if (sectionMatch) return Math.max(1, Math.round(safeNumber(sectionMatch[1], 1)));
  const notePage = getArray(section.notes)
    .map((note) => safeNumber(note?.notePosition?.pageNumber, NaN))
    .find((value) => Number.isFinite(value) && value > 0);
  if (Number.isFinite(notePage)) return Math.max(1, Math.round(notePage));
  const numberingPage = safeNumber(section?.measureNumbering?.pageIndex, NaN);
  return Number.isFinite(numberingPage) && numberingPage > 0 ? Math.max(1, Math.round(numberingPage)) : 0;
}

function toWebDataPath(...parts) {
  return `/data/${parts.map((part) => String(part).replace(/\\/g, "/")).join("/")}`;
}

function toWebPathFromAbsolute(filePath, { dataDir, asciiRuntimeRoot }) {
  const absolute = safeString(filePath);
  if (!absolute) return "";
  const relative = path.relative(dataDir, absolute);
  if (relative && !relative.startsWith("..")) {
    return toWebDataPath(relative);
  }
  const aliasDataDir = path.join(asciiRuntimeRoot, "data");
  const aliasRelative = path.relative(aliasDataDir, absolute);
  if (aliasRelative && !aliasRelative.startsWith("..") && !path.isAbsolute(aliasRelative)) {
    return toWebDataPath(aliasRelative);
  }
  return absolute;
}

function normalizeTeacherValidationPackId(value) {
  const packId = safeString(value).trim();
  if (!packId || !/^[\w.-]+$/.test(packId)) {
    throw new Error("invalid teacher validation pack id.");
  }
  return packId;
}

function resolveTeacherValidationPackDir(packId, packsDir) {
  const normalizedPackId = normalizeTeacherValidationPackId(packId);
  const root = path.resolve(packsDir);
  const resolved = path.resolve(root, normalizedPackId);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("invalid teacher validation pack path.");
  }
  return resolved;
}

function teacherValidationReviewFile(packDir) {
  return path.join(packDir, "teacher-review-template.json");
}

// Phase 2 (manual-anchor technique screening): segment-level structured labels.
// These live on the review row and the pack only -- they are NOT imported into the
// quality baseline (technique-labeling stays out of noteF1). Enums are validated so
// statistics/export stay consistent (no "滑音"/"上滑"/"glide" drift in free text).
const TEACHER_MATCH_STATUSES = new Set(["match", "mismatch", "uncertain"]);
const TEACHER_TECHNIQUE_TAGS = new Set([
  "none", "glide", "vibrato", "trill", "ornament", "position-shift", "bowing", "uncertain",
]);

function normalizeTeacherMatchStatus(value) {
  const text = safeString(value).trim().toLowerCase();
  return TEACHER_MATCH_STATUSES.has(text) ? text : "";
}

function normalizeTeacherTechniqueTags(value) {
  const tags = toUniqueStringList(value)
    .map((tag) => safeString(tag).trim().toLowerCase())
    .filter((tag) => TEACHER_TECHNIQUE_TAGS.has(tag));
  // "none" means no technique present, so it is mutually exclusive with any real
  // technique tag -- drop it when others are tagged (else stats are ambiguous).
  const others = tags.filter((tag) => tag !== "none");
  return (others.length ? others : tags).join("|");
}

function normalizeTeacherConfidence(value) {
  if (value === "" || value == null) return "";
  const num = Number(value);
  // Non-numeric (e.g. "bad") must NOT become a fake low confidence of 1 -> keep empty.
  return Number.isFinite(num) ? clamp(num, 1, 5) : "";
}

function normalizeTeacherReviewRow(row = {}) {
  return {
    ...row,
    caseId: safeString(row.caseId),
    analysisId: safeString(row.analysisId),
    raterId: safeString(row.raterId, "teacher-1"),
    reviewStatus: safeString(row.reviewStatus, "pending").toLowerCase(),
    includeInBaseline: /^(no|false|0)$/i.test(safeString(row.includeInBaseline, "yes").trim()) ? "no" : "yes",
    overallAgreement: row.overallAgreement === "" || row.overallAgreement == null ? "" : clamp(safeNumber(row.overallAgreement, 0), 0, 5),
    teacherPrimaryPath: safeString(row.teacherPrimaryPath, ""),
    teacherIssueNoteIds: toUniqueStringList(row.teacherIssueNoteIds).join("|"),
    teacherIssueMeasureIndexes: toUniqueNumberList(row.teacherIssueMeasureIndexes).join("|"),
    teacherMatchStatus: normalizeTeacherMatchStatus(row.teacherMatchStatus),
    teacherTechniqueTags: normalizeTeacherTechniqueTags(row.teacherTechniqueTags),
    teacherTechniqueConfidence: normalizeTeacherConfidence(row.teacherTechniqueConfidence),
    teacherTechniqueUncertain: /^(yes|true|1)$/i.test(safeString(row.teacherTechniqueUncertain).trim()) ? "yes" : "",
    comments: safeString(row.comments),
  };
}

function isTeacherReviewComplete(row = {}) {
  return safeString(row.reviewStatus).toLowerCase() === "complete" && safeString(row.includeInBaseline, "yes") === "yes";
}

function summarizeTeacherReviewRows(rows = []) {
  const normalizedRows = getArray(rows).map((row) => normalizeTeacherReviewRow(row));
  const completedCount = normalizedRows.filter((row) => safeString(row.reviewStatus).toLowerCase() === "complete").length;
  const includedCompleteCount = normalizedRows.filter((row) => isTeacherReviewComplete(row)).length;
  return {
    totalCount: normalizedRows.length,
    completedCount,
    includedCompleteCount,
    excludedCount: normalizedRows.filter((row) => safeString(row.includeInBaseline) === "no").length,
    pendingCount: Math.max(0, normalizedRows.length - completedCount),
  };
}

function parseTeacherLocalNoteId(noteId) {
  const match = safeString(noteId).match(/^xml-m(\d+)-n(\d+)$/i);
  if (!match) return null;
  return {
    measureIndex: Math.max(1, Math.round(safeNumber(match[1], 1))),
    noteOrdinal: Math.max(1, Math.round(safeNumber(match[2], 1))),
  };
}

function findTeacherScoreSection(score = {}, item = {}, analysis = {}) {
  const sections = getArray(score.sections);
  if (!sections.length) return null;
  const targetSectionId = safeString(item.sectionId || analysis.sectionId);
  if (targetSectionId) {
    const exact = sections.find((section) =>
      safeString(section.sectionId) === targetSectionId || safeString(section.sourceSectionId) === targetSectionId,
    );
    if (exact) return exact;
  }
  const pageMatch = targetSectionId.match(/\bpage-(\d+)/i);
  if (pageMatch) {
    const pageNumber = Math.max(1, Math.round(safeNumber(pageMatch[1], 1)));
    const pageSection = sections.find((section) => parsePagewiseSectionPage(section) === pageNumber);
    if (pageSection) return pageSection;
  }
  return sections[0] || null;
}

function formatTeacherMeasureLabel(localMeasureIndex, globalMeasureIndex = 0) {
  const local = Math.max(1, Math.round(safeNumber(localMeasureIndex, 1)));
  const global = Math.round(safeNumber(globalMeasureIndex, 0));
  if (global > 0 && global !== local) return `第 ${global} 小节（片段第 ${local} 小节）`;
  return `第 ${local} 小节`;
}

function formatTeacherNoteLabel(localMeasureIndex, noteOrdinal, globalMeasureIndex = 0) {
  return `${formatTeacherMeasureLabel(localMeasureIndex, globalMeasureIndex)} · 第 ${Math.max(1, Math.round(safeNumber(noteOrdinal, 1)))} 个音`;
}

function buildTeacherAudioAlignment(audioSegment = {}, measurePositions = []) {
  const startSeconds = safeNumber(audioSegment?.startSeconds, NaN);
  const endSeconds = safeNumber(audioSegment?.endSeconds, NaN);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds || !measurePositions.length) {
    return null;
  }
  const durationSeconds = safeNumber(audioSegment?.durationSeconds, endSeconds - startSeconds);
  const sortedMeasures = measurePositions.slice().sort((left, right) => left.measureIndex - right.measureIndex);
  const weightedMeasures = sortedMeasures.map((measure) => ({
    ...measure,
    estimatedBeats: Math.max(1, safeNumber(measure.estimatedBeats, 4)),
  }));
  const totalBeats = weightedMeasures.reduce((sum, measure) => sum + measure.estimatedBeats, 0) || weightedMeasures.length;
  let cursor = 0;
  const measures = weightedMeasures.map((measure) => {
    const startOffsetSeconds = (cursor / totalBeats) * durationSeconds;
    cursor += measure.estimatedBeats;
    const endOffsetSeconds = (cursor / totalBeats) * durationSeconds;
    return {
      measureIndex: measure.measureIndex,
      globalMeasureIndex: measure.globalMeasureIndex,
      label: measure.label,
      startSeconds: Number((startSeconds + startOffsetSeconds).toFixed(2)),
      endSeconds: Number((startSeconds + endOffsetSeconds).toFixed(2)),
      startOffsetSeconds: Number(startOffsetSeconds.toFixed(2)),
      endOffsetSeconds: Number(endOffsetSeconds.toFixed(2)),
    };
  });
  const first = measures[0];
  const last = measures[measures.length - 1];
  return {
    startSeconds,
    endSeconds,
    durationSeconds: Number((endSeconds - startSeconds).toFixed(2)),
    measureRangeLabel: first && last
      ? first.measureIndex === last.measureIndex
        ? first.label
        : `${first.label} 至 ${last.label}`
      : "",
    measures,
  };
}

function buildTeacherMeasurePositions(notePositions = [], section = {}) {
  const notesByMeasure = new Map();
  for (const note of getArray(notePositions)) {
    if (!notesByMeasure.has(note.measureIndex)) notesByMeasure.set(note.measureIndex, []);
    notesByMeasure.get(note.measureIndex).push(note);
  }
  return Array.from(notesByMeasure.entries())
    .map(([measureIndex, notes]) => {
      const xs = notes.map((note) => note.x);
      const ys = notes.map((note) => note.y);
      const xMin = clamp(Math.min(...xs) - 0.025, 0, 1);
      const xMax = clamp(Math.max(...xs) + 0.045, 0, 1);
      const yMin = clamp(Math.min(...ys) - 0.035, 0, 1);
      const yMax = clamp(Math.max(...ys) + 0.045, 0, 1);
      const maxBeatEnd = Math.max(
        1,
        ...notes.map((note) => safeNumber(note.beatStart, 0) + Math.max(0.125, safeNumber(note.beatDuration, 0.25))),
      );
      const globalMeasureIndex = notes.find((note) => safeNumber(note.globalMeasureIndex, 0) > 0)?.globalMeasureIndex || measureIndex;
      const systemIndex = notes.find((note) => nullableInteger(note.systemIndex))?.systemIndex || null;
      const staffIndex = notes.find((note) => nullableInteger(note.staffIndex))?.staffIndex || null;
      return {
        measureIndex,
        globalMeasureIndex,
        displayMeasureIndex: globalMeasureIndex || measureIndex,
        label: formatTeacherMeasureLabel(measureIndex, globalMeasureIndex),
        xMin,
        yMin,
        xMax,
        yMax,
        noteCount: notes.length,
        estimatedBeats: maxBeatEnd,
        pageNumber: notes[0]?.pageNumber || parsePagewiseSectionPage(section) || 1,
        systemIndex,
        staffIndex,
      };
    })
    .sort((left, right) => left.measureIndex - right.measureIndex);
}

function buildTeacherFocusRegions(notePositions = []) {
  const groups = new Map();
  for (const note of getArray(notePositions)) {
    const pageNumber = Math.max(1, Math.round(safeNumber(note.pageNumber, 1)));
    const systemIndex = nullableInteger(note.systemIndex) || 0;
    const staffIndex = nullableInteger(note.staffIndex) || 0;
    const key = [pageNumber, systemIndex, staffIndex].join(":");
    if (!groups.has(key)) {
      groups.set(key, { pageNumber, systemIndex, staffIndex, notes: [] });
    }
    groups.get(key).notes.push(note);
  }
  return Array.from(groups.values())
    .map((group) => {
      const xs = group.notes.map((note) => safeNumber(note.x, NaN)).filter(Number.isFinite);
      const ys = group.notes.map((note) => safeNumber(note.y, NaN)).filter(Number.isFinite);
      if (!xs.length || !ys.length) return null;
      return {
        pageNumber: group.pageNumber,
        systemIndex: group.systemIndex || null,
        staffIndex: group.staffIndex || null,
        label: "二胡定位行",
        xMin: clamp(Math.min(...xs) - 0.035, 0, 1),
        xMax: clamp(Math.max(...xs) + 0.055, 0, 1),
        yMin: clamp(Math.min(...ys) - 0.045, 0, 1),
        yMax: clamp(Math.max(...ys) + 0.055, 0, 1),
        noteCount: group.notes.length,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.pageNumber - right.pageNumber
      || safeNumber(left.systemIndex, 0) - safeNumber(right.systemIndex, 0)
      || safeNumber(left.staffIndex, 0) - safeNumber(right.staffIndex, 0),
    );
}

function teacherLineKey(entry = {}) {
  const pageNumber = nullableInteger(entry.pageNumber) || 1;
  const systemIndex = nullableInteger(entry.systemIndex) || 1;
  const staffIndex = nullableInteger(entry.staffIndex) || 1;
  return `${pageNumber}:${systemIndex}:${staffIndex}`;
}

function buildTeacherLineGroups(notePositions = []) {
  const groups = new Map();
  for (const note of getArray(notePositions)) {
    const key = teacherLineKey(note);
    if (!groups.has(key)) groups.set(key, { key, notes: [], issueHits: 0, yValues: [] });
    const group = groups.get(key);
    group.notes.push(note);
    group.yValues.push(safeNumber(note.y, 0));
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    yMin: Math.min(...group.yValues),
    yMedian: group.yValues.slice().sort((left, right) => left - right)[Math.floor(group.yValues.length / 2)] || 0,
  }));
}

function noteMatchesTeacherIssueId(note = {}, issueNoteIds = new Set()) {
  return issueNoteIds.has(safeString(note.noteId)) || issueNoteIds.has(safeString(note.sourceNoteId));
}

function isTeacherPatternLineGroup(group = {}) {
  const first = getArray(group.notes)[0] || {};
  return isTeacherErhuLineRank({ notePosition: { systemIndex: first.systemIndex } });
}

function chooseTeacherLocatorLineGroup(notePositions = [], issueNoteIds = new Set(), lineRankFilterApplied = false) {
  const groups = buildTeacherLineGroups(notePositions);
  if (groups.length <= 1) return groups[0] || null;
  for (const group of groups) {
    group.issueHits = group.notes.filter((note) => noteMatchesTeacherIssueId(note, issueNoteIds)).length;
  }
  const patternGroups = lineRankFilterApplied ? groups.filter((group) => isTeacherPatternLineGroup(group)) : groups;
  const candidates = patternGroups.length ? patternGroups : groups;
  const issueGroups = candidates.filter((group) => group.issueHits > 0);
  const ranked = (issueGroups.length ? issueGroups : candidates)
    .slice()
    .sort((left, right) =>
      left.yMedian - right.yMedian
      || right.issueHits - left.issueHits
      || right.notes.length - left.notes.length,
    );
  return ranked[0] || null;
}

function applyTeacherLocatorLineGuard(locator = null, issueNoteIds = new Set(), section = {}) {
  if (!locator || typeof locator !== "object") return locator;
  const notePositions = getArray(locator.notePositions);
  const groups = buildTeacherLineGroups(notePositions);
  if (groups.length <= 1) return locator;
  const selectedGroup = chooseTeacherLocatorLineGroup(notePositions, issueNoteIds, locator.lineRankFilterApplied === true);
  if (!selectedGroup) return locator;
  const selectedKey = selectedGroup.key;
  const filteredNotes = notePositions.filter((note) => teacherLineKey(note) === selectedKey);
  const measurePositions = buildTeacherMeasurePositions(filteredNotes, section);
  return {
    ...locator,
    noteCount: filteredNotes.length,
    lineProjectionGuardApplied: true,
    lineProjectionGuard: {
      selectedLineKey: selectedKey,
      originalLineCount: groups.length,
      droppedLineCount: Math.max(0, groups.length - 1),
      droppedNoteCount: Math.max(0, notePositions.length - filteredNotes.length),
    },
    focusRegions: buildTeacherFocusRegions(filteredNotes),
    notePositions: filteredNotes,
    measurePositions,
    audioAlignment: buildTeacherAudioAlignment(locator.audioSegment, measurePositions),
  };
}

function summarizeTeacherPackReadiness(pack = {}, repoRoot = "") {
  const items = getArray(pack.items);
  const totalCount = items.length;
  const reviewMode = safeString(pack.manifest?.reviewMode);
  const isTechniqueLabeling = reviewMode === "technique-labeling";
  const audioClipItemCount = items.filter((item) => safeString(item.audioClipPath)).length;
  const trustedAlignmentItemCount = items.filter((item) => item.alignmentEvidence?.trusted === true).length;
  const teacherReadyTrustedItemCount = items.filter((item) => item.alignmentEvidence?.teacherReadyTrusted === true).length;
  // PDF readiness: require a non-empty path AND, when repoRoot is provided, that the
  // file actually exists -- otherwise a moved/missing PDF passes readiness and only
  // 404s when the teacher opens it. Tests call this without repoRoot and fall back to
  // the non-empty-path check.
  const pdfAssetItemCount = items.filter((item) => {
    const pdfPath = safeString(item.sourcePdfPath || item.review?.sourcePdfPath);
    if (!pdfPath) return false;
    if (!repoRoot) return true;
    return fsSync.existsSync(resolveRepoPath(pdfPath, repoRoot));
  }).length;
  const originalVerifiedItemCount = items.filter((item) => safeString(item.sourceKind) === "original-score-verified").length;
  const guardedItemCount = items.filter((item) => item.scoreLocator?.lineProjectionGuardApplied === true).length;
  // manual-anchor items are technique-labelled from scratch: the teacher opens the
  // audio + PDF and judges match from the section's page/measure title, so system
  // notePositions are not required (free-rhythm/散板 sections often have none). Waive
  // the score-locator requirement for confirmed manual-anchor items; analyzer/content
  // items still require it.
  const isManualAnchorItem = (item) =>
    item.alignmentEvidence?.scanMode === "manual-anchor"
    && item.alignmentEvidence?.manualAnchorConfirmed === true;
  const noLocatorNoteCount = items.filter(
    (item) => !isManualAnchorItem(item) && !getArray(item.scoreLocator?.notePositions).length,
  ).length;
  const reasons = [];
  if (totalCount > 0 && audioClipItemCount < totalCount) reasons.push("missing-audio-clips");
  if (totalCount > 0 && trustedAlignmentItemCount < totalCount) reasons.push("untrusted-alignment");
  if (totalCount > 0 && noLocatorNoteCount > 0) reasons.push("missing-score-locators");
  if (isTechniqueLabeling && totalCount > 0 && teacherReadyTrustedItemCount < totalCount) reasons.push("not-teacher-ready-trusted");
  if (isTechniqueLabeling && totalCount > 0 && pdfAssetItemCount < totalCount) reasons.push("missing-pdf-assets");
  if (!isTechniqueLabeling && (reviewMode !== "original-score-verified" || originalVerifiedItemCount < totalCount)) {
    reasons.push("not-original-score-verified");
  }
  return {
    reviewReady: totalCount > 0 && reasons.length === 0,
    reviewReadinessReasons: reasons,
    audioClipItemCount,
    trustedAlignmentItemCount,
    teacherReadyTrustedItemCount,
    pdfAssetItemCount,
    originalVerifiedItemCount,
    guardedItemCount,
    noLocatorNoteCount,
  };
}

function isTeacherPagewiseSection(section = {}) {
  return /\bpage-\d+/i.test(`${safeString(section.sectionId)} ${safeString(section.sourceSectionId)} ${safeString(section.title)}`);
}

function hasGenericVoiceSelectedPart(section = {}, score = {}) {
  const labels = [
    section.selectedPart,
    section.selectedPartId,
    score.selectedPart,
    score.selectedPartId,
    ...getArray(section.partCandidates).flatMap((candidate) => [candidate?.id, candidate?.name, candidate?.label]),
    ...getArray(score.partCandidates).flatMap((candidate) => [candidate?.id, candidate?.name, candidate?.label]),
  ].map((value) => safeString(value)).join(" ");
  const explicitErhu = /\berhu\b|二胡/i.test(labels);
  return !explicitErhu && /\bvoice\b/i.test(labels);
}

function shouldUseTeacherFullScoreLineRankFilter(section = {}, score = {}) {
  if (!isTeacherPagewiseSection(section)) return false;
  const notes = getArray(section.notes);
  const lineRanks = new Set();
  let hasNonFirstStaff = false;
  for (const note of notes) {
    const position = note?.notePosition || {};
    const systemIndex = nullableInteger(position.systemIndex);
    if (systemIndex) lineRanks.add(systemIndex);
    if ((nullableInteger(position.staffIndex) || 1) !== 1) hasNonFirstStaff = true;
  }
  if (lineRanks.size < 2 || hasNonFirstStaff) return false;
  return hasAccompanimentPartCandidate(score)
    || hasAccompanimentPartCandidate(section)
    || hasGenericVoiceSelectedPart(section, score);
}

function isTeacherErhuLineRank(note = {}) {
  const systemIndex = nullableInteger(note?.notePosition?.systemIndex);
  return !systemIndex || (systemIndex - 1) % 3 === 0;
}

function filterTeacherLocatorNotesToErhuLineRank(notes = [], section = {}, score = {}) {
  if (!shouldUseTeacherFullScoreLineRankFilter(section, score)) return notes;
  return getArray(notes).filter((note) => isTeacherErhuLineRank(note));
}

function filterTeacherAnalysisToLocator(analysis = {}, scoreLocator = null) {
  if (!scoreLocator || typeof scoreLocator !== "object") return analysis || {};
  const locatorNoteIds = new Set();
  for (const note of getArray(scoreLocator.notePositions)) {
    if (note.noteId) locatorNoteIds.add(safeString(note.noteId));
    if (note.sourceNoteId) locatorNoteIds.add(safeString(note.sourceNoteId));
  }
  const locatorMeasureIndexes = new Set();
  for (const measure of getArray(scoreLocator.measurePositions)) {
    for (const value of [measure.measureIndex, measure.globalMeasureIndex, measure.displayMeasureIndex]) {
      const numeric = nullableInteger(value);
      if (numeric) locatorMeasureIndexes.add(String(numeric));
    }
  }
  return {
    ...analysis,
    noteFindings: getArray(analysis.noteFindings).filter((finding) => {
      const noteId = safeString(finding.noteId);
      return !noteId || locatorNoteIds.has(noteId);
    }),
    measureFindings: getArray(analysis.measureFindings).filter((finding) => {
      const measureIndex = nullableInteger(finding.measureIndex);
      return !measureIndex || locatorMeasureIndexes.has(String(measureIndex));
    }),
  };
}

function filterTeacherItemIssuesToLocator(item = {}, review = {}, scoreLocator = null) {
  if (!scoreLocator || typeof scoreLocator !== "object") return { item, review };
  const locatorNoteIds = new Set();
  for (const note of getArray(scoreLocator.notePositions)) {
    if (note.noteId) locatorNoteIds.add(safeString(note.noteId));
    if (note.sourceNoteId) locatorNoteIds.add(safeString(note.sourceNoteId));
  }
  const locatorMeasureIndexes = new Set();
  for (const measure of getArray(scoreLocator.measurePositions)) {
    for (const value of [measure.measureIndex, measure.globalMeasureIndex, measure.displayMeasureIndex]) {
      const numeric = nullableInteger(value);
      if (numeric) locatorMeasureIndexes.add(String(numeric));
    }
  }
  const systemIssueNoteIds = toUniqueStringList(item.systemIssueNoteIds || review.systemIssueNoteIds)
    .filter((noteId) => locatorNoteIds.has(noteId));
  const systemIssueMeasureIndexes = toUniqueNumberList(item.systemIssueMeasureIndexes || review.systemIssueMeasureIndexes)
    .filter((measureIndex) => locatorMeasureIndexes.has(String(measureIndex)));
  return {
    item: {
      ...item,
      systemIssueNoteIds,
      systemIssueMeasureIndexes,
      noteFindingCount: systemIssueNoteIds.length,
      measureFindingCount: systemIssueMeasureIndexes.length,
    },
    review: {
      ...review,
      systemIssueNoteIds: systemIssueNoteIds.join("|"),
      systemIssueMeasureIndexes: systemIssueMeasureIndexes.join("|"),
    },
  };
}

function resolveRepoPath(value, repoRoot) {
  const text = safeString(value);
  if (!text) return "";
  return path.isAbsolute(text) ? text : path.resolve(repoRoot, text);
}

function effectiveTeacherAudioSegment(item = {}, review = {}) {
  const audioClipPath = safeString(item.audioClipPath || review.audioClipPath);
  const rawSegment = item.audioSegment || {};
  if (!audioClipPath) return rawSegment;
  const rawDuration = safeNumber(rawSegment.durationSeconds, NaN);
  const startSeconds = safeNumber(rawSegment.startSeconds, NaN);
  const endSeconds = safeNumber(rawSegment.endSeconds, NaN);
  const durationSeconds = Number.isFinite(rawDuration)
    ? rawDuration
    : Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds
      ? endSeconds - startSeconds
      : 0;
  return {
    startSeconds: 0,
    endSeconds: Number(durationSeconds.toFixed(2)),
    durationSeconds: Number(durationSeconds.toFixed(2)),
    sourceStartSeconds: Number.isFinite(startSeconds) ? startSeconds : null,
    sourceEndSeconds: Number.isFinite(endSeconds) ? endSeconds : null,
  };
}

// Teacher-ready gate thresholds. Must stay in sync with the same constants in
// scripts/teacher-validation-support.mjs so pack-time and server-time agree.
const TEACHER_READY_MIN_DURATION_RATIO = Number.isFinite(Number(process.env.ERHU_TEACHER_READY_MIN_DURATION_RATIO))
  ? Number(process.env.ERHU_TEACHER_READY_MIN_DURATION_RATIO)
  : 0.5;
const TEACHER_READY_OVERLAP_MIN_SECONDS = Number.isFinite(Number(process.env.ERHU_TEACHER_READY_OVERLAP_MIN_SECONDS))
  ? Number(process.env.ERHU_TEACHER_READY_OVERLAP_MIN_SECONDS)
  : 4.0;
const TEACHER_READY_OVERLAP_MIN_RATIO = Number.isFinite(Number(process.env.ERHU_TEACHER_READY_OVERLAP_MIN_RATIO))
  ? Number(process.env.ERHU_TEACHER_READY_OVERLAP_MIN_RATIO)
  : 0.25;
const TEACHER_READY_MIN_SYSTEM_FINDINGS = Math.max(0, Math.round(
  Number.isFinite(Number(process.env.ERHU_TEACHER_READY_MIN_SYSTEM_FINDINGS))
    ? Number(process.env.ERHU_TEACHER_READY_MIN_SYSTEM_FINDINGS)
    : 1,
));
// Span/duration ratio must be sane in BOTH directions. Too-low = sections crammed
// into a sliver of the recording (old estimatedPieceDuration bug). Too-high = a few
// short sections spread across far too much audio (content-DTW scattering similar
// passages across the whole piece, e.g. 326s span for a 13s expected -> ratio ~24).
const TEACHER_READY_MAX_DURATION_RATIO = Number.isFinite(Number(process.env.ERHU_TEACHER_READY_MAX_DURATION_RATIO))
  ? Number(process.env.ERHU_TEACHER_READY_MAX_DURATION_RATIO)
  : 2.0;
// Only analyzer-backed scan modes are trusted. Allowlist (not "anything != fast")
// so a future scanMode is not silently trusted.
const TEACHER_READY_TRUSTED_SCAN_MODES = new Set(["analyzer-window", "content-aligned", "manual-anchor"]);
// Content alignment that fails the monotonic DP scatters its windows across the
// recording (the DP silently falls back to greedy per-slot picks). A content path
// with too many out-of-order windows is not teacher-grade. Measured real recordings
// scatter at 40-46%; a well-aligned piece is ~0%. Reject above this fraction.
const TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE = Number.isFinite(
  Number(process.env.ERHU_TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE),
)
  ? Number(process.env.ERHU_TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE)
  : 0.05;
// A monotonic content path can still be WRONG: ordered windows that skip large
// stretches of audio (e.g. 2nd rhapsody coarse: windows in order but a 158s gap with
// real erhu in it). monotonicity + span-ratio miss this. Coverage = sum(window
// durations)/alignedSpan (1.0 = contiguous; low = big gaps). maxGapRatio = largest
// inter-window gap / median window. Conservative fail-closed bounds (loosen once an
// expected-gap-aware aligner exists, since real interludes legitimately lower these).
const TEACHER_READY_MIN_COVERAGE_RATIO = Number.isFinite(Number(process.env.ERHU_TEACHER_READY_MIN_COVERAGE_RATIO))
  ? Number(process.env.ERHU_TEACHER_READY_MIN_COVERAGE_RATIO)
  : 0.6;
const TEACHER_READY_MAX_GAP_RATIO = Number.isFinite(Number(process.env.ERHU_TEACHER_READY_MAX_GAP_RATIO))
  ? Number(process.env.ERHU_TEACHER_READY_MAX_GAP_RATIO)
  : 2.0;

// A section window pair is a SEVERE overlap (not just padding touch) when the
// later window starts well inside the earlier one: by an absolute margin OR by a
// fraction of the shorter window. Mild padding overlap is allowed.
function hasSevereWindowOverlap(windows = []) {
  for (let index = 1; index < windows.length; index += 1) {
    const prev = windows[index - 1];
    const cur = windows[index];
    const overlap = prev.end - cur.start;
    if (overlap <= 0) continue;
    const shorter = Math.min(prev.end - prev.start, cur.end - cur.start);
    const ratio = shorter > 0 ? overlap / shorter : 1;
    if (overlap >= TEACHER_READY_OVERLAP_MIN_SECONDS || ratio >= TEACHER_READY_OVERLAP_MIN_RATIO) {
      return true;
    }
  }
  return false;
}

// Strict numeric coercion that PRESERVES null/missing. safeNumber(null, null)
// returns 0 (Number(null) === 0), which would mask a missing monotonicity field as a
// passing 0 -- so the gate's fail-closed checks must read these fields through this
// instead. Mirrors numeric() in scripts/teacher-validation-support.mjs.
function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Single source of truth for the teacher-ready gate. Used by BOTH the pass.json
// builder and the embedded-evidence reader, so an old pack that once stored
// teacherReadyTrusted:true is re-judged by the current rules (scanMode allowlist +
// coverage-aware ratio bounds) rather than trusted blindly. Inputs are the already
// derived fields; missing fields fail closed (conservative reject).
function evaluateTeacherReadyGate({
  scanMode,
  coverageMode,
  durationRatio,
  alignedSpanRatio,
  hasWindowOverlap,
  totalSystemFindings,
  monotonicViolationRate,
  greedyFallbackCount,
  contentAlignmentMonotonic,
  alignedWindowCoverageRatio,
  maxInterWindowGapRatio,
  manualAnchorConfirmed,
} = {}) {
  const scanModeTrusted = TEACHER_READY_TRUSTED_SCAN_MODES.has(safeString(scanMode));
  // manual-anchor = a human listened, marked the audio window, and confirmed it
  // matches the score. That human verification IS the alignment evidence -- stronger
  // than any automatic check -- so the automatic alignment gates (ratio, overlap,
  // content-path, and no-system-findings, since these are technique-labeling samples
  // labelled from scratch) do not apply. But the confirmation must be an EXPLICIT
  // field in the evidence (manualAnchorConfirmed === true), not merely the scanMode:
  // otherwise editing scanMode alone would bypass every check. Fail closed if absent.
  const isManualAnchor = safeString(scanMode) === "manual-anchor";
  const isPartialCoverage = safeString(coverageMode).startsWith("partial");
  const teacherReadyReasons = [];
  if (isManualAnchor) {
    if (manualAnchorConfirmed !== true) teacherReadyReasons.push("manual-anchor-unconfirmed");
  } else {
    if (isPartialCoverage) {
      if (alignedSpanRatio == null) {
        teacherReadyReasons.push("aligned-span-ratio-missing");
      } else {
        if (alignedSpanRatio < TEACHER_READY_MIN_DURATION_RATIO) {
          teacherReadyReasons.push(`aligned-span-ratio-too-low:${alignedSpanRatio}`);
        }
        if (alignedSpanRatio > TEACHER_READY_MAX_DURATION_RATIO) {
          teacherReadyReasons.push(`aligned-span-ratio-too-high:${alignedSpanRatio}`);
        }
      }
    } else if (durationRatio == null) {
      teacherReadyReasons.push("duration-ratio-too-low:missing");
    } else {
      if (durationRatio < TEACHER_READY_MIN_DURATION_RATIO) {
        teacherReadyReasons.push(`duration-ratio-too-low:${durationRatio}`);
      }
      if (durationRatio > TEACHER_READY_MAX_DURATION_RATIO) {
        teacherReadyReasons.push(`duration-ratio-too-high:${durationRatio}`);
      }
    }
    if (hasWindowOverlap) teacherReadyReasons.push("section-windows-overlap");
    if (safeNumber(totalSystemFindings, 0) < TEACHER_READY_MIN_SYSTEM_FINDINGS) {
      teacherReadyReasons.push("no-system-findings");
    }
  }
  // Monotonicity gate (Phase 1), applied ONLY to content-aligned scans. analyzer-
  // window etc. never produce these fields, so they are untouched. For a content
  // path we FAIL CLOSED: an old content pack written before these fields existed
  // cannot be confirmed in-order, so it is rejected rather than skipped.
  if (safeString(scanMode) === "content-aligned") {
    // Use Number.isFinite (not safeNumber) -- safeNumber(null, null) returns 0 because
    // Number(null) === 0, which would mask a missing rate as a passing 0.
    const violationRate = Number.isFinite(monotonicViolationRate) ? monotonicViolationRate : null;
    if (violationRate == null) {
      // content-aligned but no monotonicity evidence -> cannot trust it
      teacherReadyReasons.push("content-path-monotonicity-missing");
    } else if (violationRate > TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE) {
      teacherReadyReasons.push(`content-path-not-monotonic:${violationRate}`);
    }
    // The DP told us directly whether it found a full ordered path. greedyFallback >0
    // (or monotonicFeasible === false) means it degraded to scattered greedy picks --
    // closer to the root cause than the violation rate alone, and caught even when
    // the resulting starts happen to look mostly ordered. Also FAIL CLOSED when this
    // evidence is absent: a content path with neither field cannot be confirmed
    // non-degraded. New producers write both, so good new data is unaffected.
    const fallbackCount = Number.isFinite(greedyFallbackCount) ? greedyFallbackCount : null;
    const hasGreedyEvidence = fallbackCount != null || typeof contentAlignmentMonotonic === "boolean";
    if (!hasGreedyEvidence) {
      teacherReadyReasons.push("content-path-greedy-evidence-missing");
    } else if ((fallbackCount != null && fallbackCount > 0) || contentAlignmentMonotonic === false) {
      teacherReadyReasons.push(`content-path-greedy-fallback:${fallbackCount != null ? fallbackCount : "unknown"}`);
    }
    // Coverage / gap: a monotonic path that skips large stretches of audio is still
    // wrong. Fail closed when the evidence is absent (old content pack).
    const coverageRatio = Number.isFinite(alignedWindowCoverageRatio) ? alignedWindowCoverageRatio : null;
    const gapRatio = Number.isFinite(maxInterWindowGapRatio) ? maxInterWindowGapRatio : null;
    if (coverageRatio == null) {
      teacherReadyReasons.push("content-path-coverage-missing");
    } else if (coverageRatio < TEACHER_READY_MIN_COVERAGE_RATIO) {
      teacherReadyReasons.push(`content-path-coverage-too-low:${coverageRatio}`);
    }
    if (gapRatio != null && gapRatio > TEACHER_READY_MAX_GAP_RATIO) {
      teacherReadyReasons.push(`content-path-gap-too-large:${gapRatio}`);
    }
  }
  return {
    scanModeTrusted,
    teacherReadyReasons,
    teacherReadyTrusted: scanModeTrusted && teacherReadyReasons.length === 0,
  };
}

function teacherAlignmentReasonText(scanMode, scanModeTrusted) {
  if (safeString(scanMode) === "manual-anchor") {
    return "human-confirmed manual anchor (technique-labeling sample), not an analyzer scan";
  }
  if (scanModeTrusted) return "segment windows came from an analyzer-backed scan";
  return scanMode === "fast-sequence-window"
    ? "fast sequence windows are score-order estimates, not teacher-grade audio/PDF alignment"
    : "missing analyzer-backed alignment evidence";
}

function buildTeacherAlignmentEvidenceFromPassJson(passJson = {}) {
  const coverage = passJson?.summary?.audioCoverage || passJson?.audioCoverage || {};
  const sectionPasses = getArray(passJson?.sectionPasses);
  const scanMode = safeString(coverage.scanMode);
  const audioDurationSeconds = safeNumber(coverage.audioDurationSeconds, null);
  const estimatedPieceDurationSeconds = safeNumber(coverage.estimatedPieceDurationSeconds, null);
  const durationRatio =
    audioDurationSeconds && estimatedPieceDurationSeconds
      ? Number((estimatedPieceDurationSeconds / audioDurationSeconds).toFixed(3))
      : null;
  const totalSystemFindings = sectionPasses.reduce(
    (total, section) => total + getArray(section?.noteFindings).length + getArray(section?.measureFindings).length,
    0,
  );
  const windows = sectionPasses
    .map((section, index) => ({
      order: Number.isFinite(Number(section?.sequenceIndex)) ? Number(section.sequenceIndex) : index,
      start: safeNumber(section?.startSeconds, null),
      end: safeNumber(section?.endSeconds, null),
    }))
    .filter((window) => window.start != null && window.end != null && window.end > window.start)
    .sort((left, right) => left.order - right.order);
  const hasWindowOverlap = hasSevereWindowOverlap(windows);
  // Coverage / largest inter-window gap (content-path "ordered but skips audio" guard).
  let alignedWindowCoverageRatio = null;
  let maxInterWindowGapSeconds = null;
  let maxInterWindowGapRatio = null;
  if (windows.length >= 1) {
    const sumDurations = windows.reduce((total, w) => total + (w.end - w.start), 0);
    const windowSpan = Math.max(...windows.map((w) => w.end)) - Math.min(...windows.map((w) => w.start));
    alignedWindowCoverageRatio = windowSpan > 0 ? Number((sumDurations / windowSpan).toFixed(3)) : null;
    let maxGap = 0;
    for (let index = 1; index < windows.length; index += 1) {
      maxGap = Math.max(maxGap, Math.max(0, windows[index].start - windows[index - 1].end));
    }
    maxInterWindowGapSeconds = Number(maxGap.toFixed(2));
    const durations = windows.map((w) => w.end - w.start).sort((a, b) => a - b);
    const medianDuration = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
    maxInterWindowGapRatio = medianDuration > 0 ? Number((maxGap / medianDuration).toFixed(3)) : null;
  }
  // Coverage-aware ratio: full(-piece) uses estimatedPieceDuration / audio; partial
  // uses alignedSpan / expectedAlignedSpan (a span far larger than the sections'
  // own expected length means the windows are scattered, not contiguous).
  const coverageMode = safeString(coverage.wholePieceCoverageMode || coverage.alignmentCoverageMode);
  const alignedSpan = safeNumber(coverage.alignedSpanDurationSeconds, null);
  const expectedAlignedSpan = safeNumber(coverage.expectedAlignedSpanDurationSeconds, null);
  const alignedSpanRatio = (alignedSpan != null && expectedAlignedSpan && expectedAlignedSpan > 0)
    ? Number((alignedSpan / expectedAlignedSpan).toFixed(3))
    : null;
  const monotonicViolationRate = finiteNumberOrNull(coverage.monotonicViolationRate);
  const greedyFallbackCount = finiteNumberOrNull(coverage.greedyFallbackCount);
  const contentAlignmentMonotonic =
    typeof coverage.contentAlignmentMonotonic === "boolean" ? coverage.contentAlignmentMonotonic : null;
  const manualAnchorConfirmed = coverage.manualAnchorConfirmed === true;
  const { scanModeTrusted, teacherReadyReasons, teacherReadyTrusted } = evaluateTeacherReadyGate({
    scanMode,
    coverageMode,
    durationRatio,
    alignedSpanRatio,
    hasWindowOverlap,
    totalSystemFindings,
    monotonicViolationRate,
    greedyFallbackCount,
    contentAlignmentMonotonic,
    alignedWindowCoverageRatio,
    maxInterWindowGapRatio,
    manualAnchorConfirmed,
  });
  return {
    trusted: scanModeTrusted,
    scanModeTrusted,
    teacherReadyTrusted,
    teacherReadyReasons,
    scanMode: scanMode || "unknown",
    audioDurationSeconds,
    estimatedPieceDurationSeconds,
    durationRatio,
    alignedSpanDurationSeconds: alignedSpan,
    expectedAlignedSpanDurationSeconds: expectedAlignedSpan,
    alignedSpanRatio,
    coverageMode: coverageMode || null,
    totalSystemFindings,
    hasWindowOverlap,
    monotonicViolationRate,
    greedyFallbackCount,
    contentAlignmentMonotonic,
    alignedWindowCoverageRatio,
    maxInterWindowGapSeconds,
    maxInterWindowGapRatio,
    manualAnchorConfirmed,
    teacherReadyThresholds: {
      minDurationRatio: TEACHER_READY_MIN_DURATION_RATIO,
      maxDurationRatio: TEACHER_READY_MAX_DURATION_RATIO,
      overlapMinSeconds: TEACHER_READY_OVERLAP_MIN_SECONDS,
      overlapMinRatio: TEACHER_READY_OVERLAP_MIN_RATIO,
      minSystemFindings: TEACHER_READY_MIN_SYSTEM_FINDINGS,
      maxMonotonicViolationRate: TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE,
      minCoverageRatio: TEACHER_READY_MIN_COVERAGE_RATIO,
      maxGapRatio: TEACHER_READY_MAX_GAP_RATIO,
    },
    reason: teacherAlignmentReasonText(scanMode, scanModeTrusted),
  };
}

function readTeacherAlignmentEvidence(item = {}, analysis = {}, repoRoot) {
  const embedded = item.alignmentEvidence || analysis?.sourceMetadata?.alignmentEvidence;
  if (embedded && typeof embedded === "object") {
    // Re-judge embedded evidence with the CURRENT gate instead of trusting a stored
    // teacherReadyTrusted/trusted flag. An old pack written before the scanMode
    // allowlist or the aligned-span-ratio bounds existed must not bypass them; if it
    // lacks the fields those rules need, the gate fails closed.
    const scanMode = safeString(embedded.scanMode, "unknown");
    const coverageMode = safeString(embedded.coverageMode) || null;
    const durationRatio = safeNumber(embedded.durationRatio, null);
    const alignedSpanRatio = safeNumber(embedded.alignedSpanRatio, null);
    const hasWindowOverlap = embedded.hasWindowOverlap === true;
    const totalSystemFindings = safeNumber(embedded.totalSystemFindings, null);
    const monotonicViolationRate = finiteNumberOrNull(embedded.monotonicViolationRate);
    const greedyFallbackCount = finiteNumberOrNull(embedded.greedyFallbackCount);
    const contentAlignmentMonotonic =
      typeof embedded.contentAlignmentMonotonic === "boolean" ? embedded.contentAlignmentMonotonic : null;
    const alignedWindowCoverageRatio = finiteNumberOrNull(embedded.alignedWindowCoverageRatio);
    const maxInterWindowGapSeconds = finiteNumberOrNull(embedded.maxInterWindowGapSeconds);
    const maxInterWindowGapRatio = finiteNumberOrNull(embedded.maxInterWindowGapRatio);
    const manualAnchorConfirmed = embedded.manualAnchorConfirmed === true;
    const { scanModeTrusted, teacherReadyReasons, teacherReadyTrusted } = evaluateTeacherReadyGate({
      scanMode,
      coverageMode,
      durationRatio,
      alignedSpanRatio,
      hasWindowOverlap,
      totalSystemFindings,
      monotonicViolationRate,
      greedyFallbackCount,
      contentAlignmentMonotonic,
      alignedWindowCoverageRatio,
      maxInterWindowGapRatio,
      manualAnchorConfirmed,
    });
    return {
      trusted: scanModeTrusted,
      scanModeTrusted,
      teacherReadyTrusted,
      teacherReadyReasons,
      scanMode,
      audioDurationSeconds: safeNumber(embedded.audioDurationSeconds, null),
      estimatedPieceDurationSeconds: safeNumber(embedded.estimatedPieceDurationSeconds, null),
      durationRatio,
      alignedSpanDurationSeconds: safeNumber(embedded.alignedSpanDurationSeconds, null),
      expectedAlignedSpanDurationSeconds: safeNumber(embedded.expectedAlignedSpanDurationSeconds, null),
      alignedSpanRatio,
      coverageMode,
      totalSystemFindings,
      hasWindowOverlap,
      monotonicViolationRate,
      greedyFallbackCount,
      contentAlignmentMonotonic,
      alignedWindowCoverageRatio,
      maxInterWindowGapSeconds,
      maxInterWindowGapRatio,
      manualAnchorConfirmed,
      teacherReadyThresholds: embedded.teacherReadyThresholds && typeof embedded.teacherReadyThresholds === "object"
        ? embedded.teacherReadyThresholds
        : null,
      reason: teacherAlignmentReasonText(scanMode, scanModeTrusted),
    };
  }
  const passJsonPath = resolveRepoPath(analysis?.sourceMetadata?.passJsonPath || item.passJsonPath, repoRoot);
  if (!passJsonPath || !fsSync.existsSync(passJsonPath)) {
    return {
      trusted: false,
      scanMode: "unknown",
      audioDurationSeconds: null,
      estimatedPieceDurationSeconds: null,
      durationRatio: null,
      reason: "missing analyzer-backed alignment evidence",
    };
  }
  try {
    const passJson = JSON.parse(fsSync.readFileSync(passJsonPath, "utf8"));
    return buildTeacherAlignmentEvidenceFromPassJson(passJson);
  } catch {
    return {
      trusted: false,
      scanMode: "unknown",
      audioDurationSeconds: null,
      estimatedPieceDurationSeconds: null,
      durationRatio: null,
      reason: "failed to read alignment evidence",
    };
  }
}

function buildTeacherScoreLocator(score = {}, item = {}, analysis = {}, pathContext) {
  if (!score || typeof score !== "object") return null;
  const fallbackSection = findTeacherScoreSection(score, item, analysis);
  const noteIds = toUniqueStringList(item.systemIssueNoteIds || item.review?.systemIssueNoteIds);
  const measureIndexes = toUniqueNumberList(item.systemIssueMeasureIndexes || item.review?.systemIssueMeasureIndexes);
  const firstFinding = getArray(analysis.noteFindings)[0] || getArray(analysis.measureFindings)[0] || {};
  const firstNoteId = noteIds[0] || safeString(firstFinding.noteId);
  const parsedNote = parseTeacherLocalNoteId(firstNoteId);
  const issue = {
    sectionId: safeString(item.sectionId || analysis.sectionId),
    sourcePageNumber: parsePagewiseSectionPage(fallbackSection || {}),
    pageNumber: parsePagewiseSectionPage(fallbackSection || {}),
    noteId: firstNoteId,
    measureIndex:
      parsedNote?.measureIndex
      || measureIndexes[0]
      || safeNumber(firstFinding.measureIndex, 0),
  };
  const section = resolveIssueSection(score, fallbackSection, issue);
  if (!section) return null;
  const lineRankFilterApplied = shouldUseTeacherFullScoreLineRankFilter(section, score);
  const sectionNotes = lineRankFilterApplied
    ? getArray(getErhuMelodyNotes(section, score)).filter((note) => isTeacherErhuLineRank(note))
    : getErhuMelodyNotes(section, score);
  const perMeasureOrdinal = new Map();
  const notePositions = [];
  for (const note of sectionNotes) {
    const position = note?.notePosition && typeof note.notePosition === "object" ? note.notePosition : {};
    const x = safeNumber(position.normalizedX, NaN);
    const y = safeNumber(position.normalizedY, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const parsedLocal = parseTeacherLocalNoteId(position.localNoteId || note.noteId);
    const measureIndex = Math.max(1, Math.round(safeNumber(position.localMeasureIndex, parsedLocal?.measureIndex || note.measureIndex || 1)));
    const nextOrdinal = safeNumber(perMeasureOrdinal.get(measureIndex), 0) + 1;
    perMeasureOrdinal.set(measureIndex, nextOrdinal);
    const noteOrdinal = Math.max(1, Math.round(safeNumber(parsedLocal?.noteOrdinal, nextOrdinal)));
    const localNoteId = safeString(position.localNoteId).trim() || `xml-m${measureIndex}-n${noteOrdinal}`;
    const globalMeasureIndex = nullableInteger(position.globalMeasureIndex) || nullableInteger(note.measureIndex);
    notePositions.push({
      noteId: localNoteId,
      sourceNoteId: safeString(note.noteId),
      measureIndex,
      globalMeasureIndex,
      displayMeasureIndex: globalMeasureIndex || measureIndex,
      noteOrdinal,
      label: formatTeacherNoteLabel(measureIndex, noteOrdinal, globalMeasureIndex),
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      pageNumber: Math.max(1, Math.round(safeNumber(position.pageNumber, parsePagewiseSectionPage(section) || 1))),
      systemIndex: nullableInteger(position.systemIndex),
      staffIndex: nullableInteger(position.staffIndex),
      scoreLineRole: safeString(position.scoreLineRole),
      scoreLineConfidence: safeNumber(position.scoreLineConfidence, null),
      scoreLineId: safeString(position.scoreLineId),
      midiPitch: nullableInteger(note.midiPitch),
      beatStart: safeNumber(note.beatStart, null),
      beatDuration: safeNumber(note.beatDuration, null),
    });
  }

  const measurePositions = buildTeacherMeasurePositions(notePositions, section);

  const pageImagePath = safeString(section.pageImagePath);
  const audioSegment = item.audioSegment || analysis.audioSegment;
  // Multi-page support: a manual-anchor segment can span a page range
  // (item.scorePageStart..scorePageEnd). Emit one rendered page image per page so the
  // teacher can follow a cross-page passage instead of seeing only the first page.
  const pageStart = safeNumber(item.scorePageStart, null);
  const pageEnd = safeNumber(item.scorePageEnd, null);
  let pages = null;
  if (pageStart != null && pageEnd != null && pageEnd > pageStart) {
    const imageByPage = new Map();
    for (const candidateSection of getArray(score.sections)) {
      const candidatePage = parsePagewiseSectionPage(candidateSection);
      const candidateImage = safeString(candidateSection.pageImagePath);
      if (candidatePage && candidateImage && !imageByPage.has(candidatePage)) imageByPage.set(candidatePage, candidateImage);
    }
    pages = [];
    for (let page = pageStart; page <= pageEnd; page += 1) {
      const image = imageByPage.get(page) || "";
      pages.push({
        pageNumber: page,
        pageImagePath: image.startsWith("/data/") ? image : (image ? toWebPathFromAbsolute(image, pathContext) : ""),
      });
    }
  }
  const locator = {
    scoreId: safeString(score.scoreId),
    sectionId: safeString(section.sectionId),
    sectionTitle: repairMojibakeText(section.title || item.sectionTitle || analysis.sectionTitle),
    pageNumber: parsePagewiseSectionPage(section) || notePositions[0]?.pageNumber || 1,
    pageImagePath: pageImagePath.startsWith("/data/") ? pageImagePath : toWebPathFromAbsolute(pageImagePath, pathContext),
    pages,
    sourcePdfPath: safeString(item.sourcePdfPath || score.sourcePdfPath),
    measureCount: Math.max(0, Math.round(safeNumber(section.measureCount, measurePositions.length))),
    noteCount: notePositions.length,
    lineRankFilterApplied,
    lineRankFilterRule: lineRankFilterApplied ? "first-line-of-three-staff-group" : "",
    focusRegions: buildTeacherFocusRegions(notePositions),
    notePositions,
    measurePositions,
    audioSegment,
    audioAlignment: buildTeacherAudioAlignment(audioSegment, measurePositions),
  };
  return applyTeacherLocatorLineGuard(locator, new Set(noteIds), section);
}

function normalizeEmbeddedTeacherScoreLocator(locator = null, audioSegment = {}) {
  if (!locator || typeof locator !== "object") return null;
  const notePositions = getArray(locator.notePositions);
  if (!notePositions.length) return null;
  const pageImagePath = safeString(locator.pageImagePath);
  const normalizedImagePath = pageImagePath.startsWith("/data/")
    ? pageImagePath
    : pageImagePath.startsWith("data/")
      ? `/${pageImagePath.replace(/\\/g, "/")}`
      : pageImagePath;
  const next = {
    ...locator,
    pageImagePath: normalizedImagePath,
    notePositions,
    measurePositions: getArray(locator.measurePositions),
    focusRegions: getArray(locator.focusRegions),
    audioSegment,
  };
  return {
    ...next,
    audioAlignment: next.audioAlignment || buildTeacherAudioAlignment(audioSegment, next.measurePositions),
  };
}

export function createTeacherValidationService({
  packsDir,
  repoRoot,
  dataDir,
  asciiRuntimeRoot,
  readScoreStore,
  readStudyStore,
  writeStudyStore,
  ensureParticipantRecord,
  createValidationReview,
  buildValidationSummary,
}) {
  const pathContext = { dataDir, asciiRuntimeRoot };

  async function readTeacherReviewRows(packDir) {
    const reviewFile = teacherValidationReviewFile(packDir);
    await waitForStoreOperations(reviewFile);
    const payload = await readJsonFileUnlocked(reviewFile, { schemaVersion: 1, reviews: [] });
    return getArray(payload.reviews || payload).map((row) => normalizeTeacherReviewRow(row));
  }

  async function writeTeacherReviewRows(packDir, rows) {
    const reviewFile = teacherValidationReviewFile(packDir);
    await enqueueStoreOperation(reviewFile, async () => {
      await atomicWriteJson(reviewFile, {
        schemaVersion: 1,
        updatedAt: nowIso(),
        reviews: getArray(rows).map((row) => normalizeTeacherReviewRow(row)),
      });
    });
  }

  async function readTeacherValidationPack(packId) {
    const normalizedPackId = normalizeTeacherValidationPackId(packId);
    const packDir = resolveTeacherValidationPackDir(normalizedPackId, packsDir);
    const manifest = await readJsonFileUnlocked(path.join(packDir, "manifest.json"), null);
    if (!manifest) {
      throw new Error("teacher validation pack not found.");
    }
    const analysesPayload = await readJsonFileUnlocked(path.join(packDir, "analyses.json"), { analyses: [] });
    const analyses = getArray(analysesPayload.analyses);
    const rows = await readTeacherReviewRows(packDir);
    const rowByCaseId = new Map(rows.map((row) => [safeString(row.caseId), row]));
    const analysisById = new Map(analyses.map((analysis) => [safeString(analysis.analysisId), analysis]));
    const manifestItems = getArray(manifest.items).length ? getArray(manifest.items) : rows;
    let scoreById = new Map();
    try {
      const scoreStore = await readScoreStore();
      scoreById = new Map(getArray(scoreStore.scores).map((score) => [safeString(score.scoreId), score]));
    } catch {
      scoreById = new Map();
    }
    const items = manifestItems.map((item) => {
      const caseId = safeString(item.caseId);
      const analysisId = safeString(item.analysisId);
      const review = rowByCaseId.get(caseId) || normalizeTeacherReviewRow(item);
      const analysis = analysisById.get(analysisId) || {};
      const score = scoreById.get(safeString(item.scoreId || analysis.scoreId || item.pieceId || analysis.pieceId));
      const audioClipPath = safeString(item.audioClipPath || review.audioClipPath);
      const effectiveItem = {
        ...item,
        audioClipPath,
        audioSegment: effectiveTeacherAudioSegment(item, review),
      };
      const alignmentEvidence = readTeacherAlignmentEvidence(item, analysis, repoRoot);
      const embeddedLocator = normalizeEmbeddedTeacherScoreLocator(item.scoreLocator || analysis.scoreLocator, effectiveItem.audioSegment);
      const scoreLocator = embeddedLocator || buildTeacherScoreLocator(score, effectiveItem, analysis, pathContext);
      const filteredAnalysis = filterTeacherAnalysisToLocator(analysis, scoreLocator);
      const filtered = filterTeacherItemIssuesToLocator(effectiveItem, review, scoreLocator);
      return {
        ...filtered.item,
        caseId,
        analysisId,
        audioClipPath,
        audioSegment: effectiveItem.audioSegment,
        review: filtered.review,
        analysis: filteredAnalysis,
        alignmentEvidence,
        scoreLocator,
        audioUrl: `/api/erhu/teacher-validation/packs/${encodeURIComponent(normalizedPackId)}/items/${encodeURIComponent(caseId)}/audio`,
        pdfUrl: `/api/erhu/teacher-validation/packs/${encodeURIComponent(normalizedPackId)}/items/${encodeURIComponent(caseId)}/pdf`,
      };
    });
    return {
      packId: normalizedPackId,
      packDir,
      manifest,
      analyses,
      reviews: rows,
      items,
      summary: summarizeTeacherReviewRows(rows),
    };
  }

  async function listTeacherValidationPacks() {
    if (!fsSync.existsSync(packsDir)) return [];
    const entries = await fs.readdir(packsDir, { withFileTypes: true });
    const packs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const pack = await readTeacherValidationPack(entry.name);
        const stat = await fs.stat(pack.packDir);
        packs.push({
          packId: pack.packId,
          generatedAt: safeString(pack.manifest.generatedAt),
          unit: safeString(pack.manifest.unit),
          sources: safeString(pack.manifest.sources),
          reviewMode: safeString(pack.manifest.reviewMode),
          selectedCount: safeNumber(pack.manifest.selectedCount, pack.items.length),
          warningCount: safeNumber(pack.manifest.warningCount, getArray(pack.manifest.warnings).length),
          updatedAt: stat.mtime.toISOString(),
          summary: pack.summary,
          ...summarizeTeacherPackReadiness(pack, repoRoot),
        });
      } catch {
        // Ignore incomplete pack folders.
      }
    }
    return packs.sort((left, right) => String(right.generatedAt || right.updatedAt).localeCompare(String(left.generatedAt || left.updatedAt)));
  }

  async function updateTeacherValidationReview(packId, caseId, payload = {}) {
    const pack = await readTeacherValidationPack(packId);
    const rows = pack.reviews.slice();
    const targetCaseId = safeString(caseId);
    const rowIndex = rows.findIndex((row) => row.caseId === targetCaseId);
    if (rowIndex < 0) {
      throw new Error("teacher validation case not found.");
    }
    const existing = rows[rowIndex];
    rows[rowIndex] = normalizeTeacherReviewRow({
      ...existing,
      raterId: payload.raterId ?? existing.raterId,
      reviewStatus: payload.reviewStatus ?? existing.reviewStatus,
      includeInBaseline: payload.includeInBaseline ?? existing.includeInBaseline,
      overallAgreement: payload.overallAgreement ?? existing.overallAgreement,
      teacherPrimaryPath: payload.teacherPrimaryPath ?? existing.teacherPrimaryPath,
      teacherIssueNoteIds: payload.teacherIssueNoteIds ?? existing.teacherIssueNoteIds,
      teacherIssueMeasureIndexes: payload.teacherIssueMeasureIndexes ?? existing.teacherIssueMeasureIndexes,
      teacherMatchStatus: payload.teacherMatchStatus ?? existing.teacherMatchStatus,
      teacherTechniqueTags: payload.teacherTechniqueTags ?? existing.teacherTechniqueTags,
      teacherTechniqueConfidence: payload.teacherTechniqueConfidence ?? existing.teacherTechniqueConfidence,
      teacherTechniqueUncertain: payload.teacherTechniqueUncertain ?? existing.teacherTechniqueUncertain,
      comments: payload.comments ?? existing.comments,
      updatedAt: nowIso(),
    });
    await writeTeacherReviewRows(pack.packDir, rows);
    return readTeacherValidationPack(pack.packId);
  }

  async function resolveTeacherValidationAssetPath(packId, caseId, assetType) {
    const pack = await readTeacherValidationPack(packId);
    const item = pack.items.find((candidate) => candidate.caseId === caseId);
    if (!item) {
      throw new Error("teacher validation case not found.");
    }
    const sourcePath = assetType === "pdf"
      ? safeString(item.sourcePdfPath || item.review?.sourcePdfPath)
      : safeString(item.audioClipPath || item.review?.audioClipPath || item.sourceAudioPath || item.review?.sourceAudioPath);
    if (!sourcePath) {
      throw new Error("asset path is missing.");
    }
    const candidate = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(repoRoot, sourcePath);
    if (!fsSync.existsSync(candidate)) {
      throw new Error("asset file not found.");
    }
    return candidate;
  }

  async function applyTeacherValidationPack(packId) {
    const pack = await readTeacherValidationPack(packId);
    if (safeString(pack.manifest?.reviewMode) === "technique-labeling") {
      throw new Error("technique-labeling packs are for teacher screening only and cannot be imported into the quality baseline.");
    }
    const acceptedRows = pack.reviews.filter((row) => isTeacherReviewComplete(row));
    const analysisById = new Map(pack.analyses.map((analysis) => [safeString(analysis.analysisId), analysis]));
    const missingAnalysisIds = acceptedRows.map((row) => row.analysisId).filter((analysisId) => !analysisById.has(analysisId));
    if (missingAnalysisIds.length) {
      throw new Error(`review rows reference missing analyses: ${missingAnalysisIds.join(", ")}`);
    }

    const store = await readStudyStore();
    for (const analysis of pack.analyses) {
      const existingIndex = store.analyses.findIndex((item) => safeString(item.analysisId) === safeString(analysis.analysisId));
      if (existingIndex >= 0) {
        store.analyses[existingIndex] = { ...store.analyses[existingIndex], ...analysis };
      } else {
        store.analyses.push(analysis);
      }
      if (analysis.participantId) {
        ensureParticipantRecord(store, safeString(analysis.participantId), safeString(analysis.groupId, "teacher-validation-corpus"));
      }
    }

    const importedReviews = acceptedRows.map((row) => createValidationReview(store, {
      ...row,
      raterId: safeString(row.raterId, "teacher-1"),
      teacherPrimaryPath: safeString(row.teacherPrimaryPath, "review-first"),
    }));
    for (const review of importedReviews) {
      const reviewIndex = getArray(store.validationReviews).findIndex(
        (item) => item.analysisId === review.analysisId && safeString(item.raterId) === safeString(review.raterId),
      );
      if (reviewIndex >= 0) {
        store.validationReviews[reviewIndex] = {
          ...store.validationReviews[reviewIndex],
          ...review,
          reviewId: store.validationReviews[reviewIndex].reviewId || review.reviewId,
        };
      } else {
        store.validationReviews.push(review);
      }
    }
    await writeStudyStore(store);
    return {
      acceptedReviewCount: importedReviews.length,
      skippedReviewCount: Math.max(0, pack.reviews.length - acceptedRows.length),
      importedAnalysisCount: pack.analyses.length,
      missingAnalysisIds,
      validationSummary: buildValidationSummary(store),
    };
  }

  return {
    listTeacherValidationPacks,
    readTeacherValidationPack,
    updateTeacherValidationReview,
    resolveTeacherValidationAssetPath,
    applyTeacherValidationPack,
  };
}

export const teacherValidationInternals = {
  buildTeacherScoreLocator,
  buildTeacherFocusRegions,
  normalizeTeacherReviewRow,
  summarizeTeacherReviewRows,
  summarizeTeacherPackReadiness,
  buildTeacherAlignmentEvidenceFromPassJson,
  readTeacherAlignmentEvidence,
  evaluateTeacherReadyGate,
};
