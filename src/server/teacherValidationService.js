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

function summarizeTeacherPackReadiness(pack = {}) {
  const items = getArray(pack.items);
  const totalCount = items.length;
  const audioClipItemCount = items.filter((item) => safeString(item.audioClipPath)).length;
  const trustedAlignmentItemCount = items.filter((item) => item.alignmentEvidence?.trusted === true).length;
  const controlledItemCount = items.filter((item) => safeString(item.sourceKind) === "controlled-piece-pass").length;
  const guardedItemCount = items.filter((item) => item.scoreLocator?.lineProjectionGuardApplied === true).length;
  const noLocatorNoteCount = items.filter((item) => !getArray(item.scoreLocator?.notePositions).length).length;
  const reasons = [];
  if (totalCount > 0 && audioClipItemCount < totalCount) reasons.push("missing-audio-clips");
  if (totalCount > 0 && trustedAlignmentItemCount < totalCount) reasons.push("untrusted-alignment");
  if (totalCount > 0 && noLocatorNoteCount > 0) reasons.push("missing-score-locators");
  if (totalCount > 0 && controlledItemCount < totalCount) reasons.push("not-controlled-review-pack");
  return {
    reviewReady: totalCount > 0 && reasons.length === 0,
    reviewReadinessReasons: reasons,
    audioClipItemCount,
    trustedAlignmentItemCount,
    controlledItemCount,
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

function buildTeacherAlignmentEvidenceFromPassJson(passJson = {}) {
  const coverage = passJson?.summary?.audioCoverage || passJson?.audioCoverage || {};
  const scanMode = safeString(coverage.scanMode);
  const audioDurationSeconds = safeNumber(coverage.audioDurationSeconds, null);
  const estimatedPieceDurationSeconds = safeNumber(coverage.estimatedPieceDurationSeconds, null);
  const durationRatio =
    audioDurationSeconds && estimatedPieceDurationSeconds
      ? Number((estimatedPieceDurationSeconds / audioDurationSeconds).toFixed(3))
      : null;
  const trusted = Boolean(scanMode) && scanMode !== "fast-sequence-window";
  return {
    trusted,
    scanMode: scanMode || "unknown",
    audioDurationSeconds,
    estimatedPieceDurationSeconds,
    durationRatio,
    reason: trusted
      ? "segment windows came from an analyzer-backed scan"
      : scanMode === "fast-sequence-window"
        ? "fast sequence windows are score-order estimates, not teacher-grade audio/PDF alignment"
        : "missing analyzer-backed alignment evidence",
  };
}

function readTeacherAlignmentEvidence(item = {}, analysis = {}, repoRoot) {
  const embedded = item.alignmentEvidence || analysis?.sourceMetadata?.alignmentEvidence;
  if (embedded && typeof embedded === "object") {
    return {
      trusted: embedded.trusted === true,
      scanMode: safeString(embedded.scanMode, "unknown"),
      audioDurationSeconds: safeNumber(embedded.audioDurationSeconds, null),
      estimatedPieceDurationSeconds: safeNumber(embedded.estimatedPieceDurationSeconds, null),
      durationRatio: safeNumber(embedded.durationRatio, null),
      reason: safeString(embedded.reason),
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
  const locator = {
    scoreId: safeString(score.scoreId),
    sectionId: safeString(section.sectionId),
    sectionTitle: repairMojibakeText(section.title || item.sectionTitle || analysis.sectionTitle),
    pageNumber: parsePagewiseSectionPage(section) || notePositions[0]?.pageNumber || 1,
    pageImagePath: pageImagePath.startsWith("/data/") ? pageImagePath : toWebPathFromAbsolute(pageImagePath, pathContext),
    sourcePdfPath: safeString(score.sourcePdfPath || item.sourcePdfPath),
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
          selectedCount: safeNumber(pack.manifest.selectedCount, pack.items.length),
          warningCount: safeNumber(pack.manifest.warningCount, getArray(pack.manifest.warnings).length),
          updatedAt: stat.mtime.toISOString(),
          summary: pack.summary,
          ...summarizeTeacherPackReadiness(pack),
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
};
