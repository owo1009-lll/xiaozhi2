import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import {
  extractSectionPageNumber,
  ISSUE_SESSION_SCHEMA_VERSION,
  ISSUE_SESSION_STORAGE_PREFIX,
  formatPracticePathLabel,
  formatScoreTitle,
  formatSectionDisplayName,
  getApproximateNotePosition,
  getDisplayCombinedScore,
  getDisplayPitchScore,
  getDisplayRhythmScore,
  getSectionMeasureCount,
  parseXmlNoteId,
  repairMojibakeText,
} from "./analysisLabels.js";
import { fetchScore } from "./researchApi.js";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

function getIssueSessionId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("issueSession") || "";
}

function attachOriginalAudio(analysis, originalAudio) {
  if (!analysis || !originalAudio?.url) return analysis || null;
  const durationSeconds = Number(originalAudio.durationSeconds);
  return {
    ...analysis,
    originalAudio,
    audioUrl: originalAudio.url,
    originalAudioUrl: originalAudio.url,
    audioDurationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : analysis.audioDurationSeconds,
    audioSubmission: {
      ...(analysis.audioSubmission || {}),
      name: originalAudio.filename || analysis.audioSubmission?.name || "",
      duration: Number.isFinite(durationSeconds) ? durationSeconds : analysis.audioSubmission?.duration,
    },
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstOptionalNumber(...values) {
  for (const value of values) {
    const numeric = optionalNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function clampNumber(value, min, max) {
  const numeric = optionalNumber(value);
  const lower = optionalNumber(min) ?? numeric ?? 0;
  const upper = optionalNumber(max);
  const safeUpper = upper !== null ? Math.max(lower, upper) : null;
  if (numeric === null) return lower;
  if (safeUpper !== null) return Math.min(Math.max(numeric, lower), safeUpper);
  return Math.max(numeric, lower);
}

const ISSUE_TIMING_FIELDS = [
  "startSeconds",
  "endSeconds",
  "audioStartSeconds",
  "audioEndSeconds",
  "playbackStartSeconds",
  "playbackEndSeconds",
  "issueStartSeconds",
  "issueEndSeconds",
  "expectedStartSeconds",
  "observedStartSeconds",
  "expectedOnsetSeconds",
  "observedOnsetSeconds",
  "onsetSeconds",
  "timeSeconds",
  "beatStart",
  "beatDuration",
  "expectedDurationMs",
  "observedDurationMs",
  "onsetErrorMs",
  "durationErrorMs",
];

function copyIssueTimingFields(item) {
  const timing = {};
  for (const field of ISSUE_TIMING_FIELDS) {
    const numeric = optionalNumber(item?.[field]);
    if (numeric !== null) timing[field] = numeric;
  }
  return timing;
}

function meterBeatsValue(meter = "4/4") {
  const beats = String(meter || "4/4").split("/")[0];
  const numeric = Number(beats);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 4;
}

function getSectionSecondsPerBeat(section) {
  const tempo = clampNumber(firstOptionalNumber(section?.tempo, 72), 30, 300) || 72;
  return 60 / tempo;
}

function getSectionMeasureRange(section) {
  const values = (Array.isArray(section?.notes) ? section.notes : [])
    .map((note) => optionalNumber(note?.measureIndex))
    .filter((value) => value !== null && value > 0);
  if (!values.length) return { min: 1, max: 1 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function findIssueSectionSummary(analysis, issue, section) {
  const sectionId = String(issue?.sectionId || section?.sectionId || "");
  const summaries = Array.isArray(analysis?.sectionSummaries) ? analysis.sectionSummaries : [];
  return summaries.find((item) => String(item?.sectionId || "") === sectionId) || null;
}

function getIssueAudioWindow(issue, section, analysis) {
  const summary = findIssueSectionSummary(analysis, issue, section);
  const start = firstOptionalNumber(issue?.startSeconds, summary?.startSeconds, 0) ?? 0;
  const end = firstOptionalNumber(issue?.endSeconds, summary?.endSeconds);
  return {
    start: Math.max(0, start),
    end: end !== null && end > start ? end : null,
  };
}

function estimateIssueTimeSeconds(issue, section, kind, analysis) {
  const window = getIssueAudioWindow(issue, section, analysis);
  const explicitTime = firstOptionalNumber(
    issue?.audioStartSeconds,
    issue?.playbackStartSeconds,
    issue?.issueStartSeconds,
    issue?.expectedStartSeconds,
    issue?.observedStartSeconds,
    issue?.expectedOnsetSeconds,
    issue?.observedOnsetSeconds,
    issue?.onsetSeconds,
    issue?.timeSeconds,
  );
  if (explicitTime !== null) {
    const windowDuration = window.end !== null ? window.end - window.start : null;
    const absoluteTime = window.start > 0 && windowDuration !== null && explicitTime <= windowDuration + 0.5
      ? window.start + explicitTime
      : explicitTime;
    return clampNumber(absoluteTime, window.start, window.end ?? Math.max(window.start, absoluteTime));
  }

  const measureIndex = Math.max(1, Math.round(firstOptionalNumber(issue?.measureIndex, 1) ?? 1));
  const beatStart = Math.max(0, firstOptionalNumber(issue?.beatStart, 0) ?? 0);
  const beatsPerMeasure = meterBeatsValue(section?.meter);
  const secondsPerBeat = getSectionSecondsPerBeat(section);
  const range = getSectionMeasureRange(section);
  const localMeasureOffset = Math.max(0, measureIndex - range.min);
  const beatOffset = localMeasureOffset * beatsPerMeasure + (kind === "measure" ? 0 : beatStart);
  const estimated = window.start + beatOffset * secondsPerBeat;

  if (window.end !== null && estimated > window.end + 0.5) {
    const totalMeasures = Math.max(1, range.max - range.min + 1);
    const ratio = clampNumber((measureIndex - range.min) / totalMeasures, 0, 0.95);
    return window.start + (window.end - window.start) * ratio;
  }

  if (window.end !== null) {
    return clampNumber(estimated, window.start, window.end);
  }
  return Math.max(0, estimated);
}

function getIssueDurationSeconds(issue, section, kind) {
  const secondsPerBeat = getSectionSecondsPerBeat(section);
  if (kind === "measure") {
    return meterBeatsValue(section?.meter) * secondsPerBeat;
  }
  const beatDuration = firstOptionalNumber(issue?.beatDuration);
  if (beatDuration !== null && beatDuration > 0) return beatDuration * secondsPerBeat;
  const durationMs = firstOptionalNumber(issue?.expectedDurationMs, issue?.observedDurationMs);
  if (durationMs !== null && durationMs > 0) return durationMs / 1000;
  return secondsPerBeat;
}

function buildIssuePlaybackWindow(issue, section, kind, analysis, audioElement) {
  const estimatedCenter = estimateIssueTimeSeconds(issue, section, kind, analysis);
  if (!Number.isFinite(estimatedCenter)) return null;
  const audioDuration = firstOptionalNumber(
    audioElement?.duration,
    analysis?.audioDurationSeconds,
    analysis?.originalAudio?.durationSeconds,
  );
  if (audioDuration !== null && audioDuration <= 0) return null;
  const sectionWindow = getIssueAudioWindow(issue, section, analysis);
  const maxAvailableTime = firstOptionalNumber(audioDuration, sectionWindow.end);
  const center = maxAvailableTime !== null
    ? clampNumber(estimatedCenter, 0, maxAvailableTime)
    : Math.max(0, estimatedCenter);
  const issueDuration = getIssueDurationSeconds(issue, section, kind);
  const preRoll = kind === "measure" ? 0.5 : 0.8;
  const postRoll = kind === "measure" ? 1.0 : 1.6;
  const targetDuration = clampNumber(issueDuration + preRoll + postRoll, kind === "measure" ? 4 : 3, kind === "measure" ? 10 : 6);
  let start = Math.max(0, center - preRoll);
  let end = start + targetDuration;
  if (sectionWindow.end !== null) end = Math.min(end, sectionWindow.end);
  if (audioDuration !== null) end = Math.min(end, audioDuration);
  if (end - start < 1.2) {
    const maxEnd = firstOptionalNumber(audioDuration, sectionWindow.end, start + 2.5) ?? start + 2.5;
    end = Math.min(maxEnd, start + 2.5);
  }
  if (audioDuration !== null && end > audioDuration) {
    end = audioDuration;
    start = Math.max(0, Math.min(start, end - targetDuration));
  }
  if (audioDuration !== null && start >= audioDuration) {
    start = Math.max(0, audioDuration - 1.2);
    end = audioDuration;
  }
  if (end <= start) end = start + 1.2;
  return { start, end };
}

function formatPlaybackSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

const SCORE_ISSUE_LINE_MODE_PREFIX = "ai-erhu.score-issue-line-mode.";
const SCORE_ISSUE_LINE_MODES = new Set(["auto"]);

function readStoredLineMode(scoreId) {
  if (typeof window === "undefined") return "auto";
  const key = `${SCORE_ISSUE_LINE_MODE_PREFIX}${String(scoreId || "")}`;
  const value = window.localStorage.getItem(key);
  return SCORE_ISSUE_LINE_MODES.has(value) ? value : "auto";
}

function writeStoredLineMode(scoreId, mode) {
  if (typeof window === "undefined" || !scoreId) return;
  const key = `${SCORE_ISSUE_LINE_MODE_PREFIX}${String(scoreId || "")}`;
  if (!mode || mode === "auto") {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, mode);
}

function readStoredSession(issueSessionId) {
  if (!issueSessionId || typeof window === "undefined") return null;
  try {
    const storageKey = `${ISSUE_SESSION_STORAGE_PREFIX}${issueSessionId}`;
    const raw = window.localStorage.getItem(storageKey) || window.sessionStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.schemaVersion === ISSUE_SESSION_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

function getDerivedPageImagePath(score, pageNumber) {
  const pdfUrl = String(score?.sourcePdfPath || "").trim();
  if (!pdfUrl) return "";
  const match = pdfUrl.match(/^(.*)\/source\.pdf$/i);
  if (!match) return "";
  return `${match[1]}/pagewise/page-${String(Math.max(1, Number(pageNumber) || 1)).padStart(3, "0")}.png`;
}

function buildImportedPageImagePath(score, section, pageNumber) {
  const baseSectionPage = extractSectionPageNumber(section || {});
  const explicit = String(section?.pageImagePath || "").trim();
  // Return explicit path for the section's base page
  if (explicit && (Number(pageNumber) || 1) === baseSectionPage) return explicit;
  // Only derive pagewise path for adjacent pages when section confirms images exist
  if (explicit) {
    const derived = getDerivedPageImagePath(score, pageNumber);
    if (derived) return derived;
  }
  // No confirmed pagewise images — use PDF.js directly
  return "";
}

function getAbsoluteIssuePage(section, issue = null) {
  const sectionPage = Number(section?.pageNumber);
  if (Number.isFinite(sectionPage) && sectionPage > 0) return Math.round(sectionPage);
  const extractedPage = extractSectionPageNumber(section || {});
  if (Number.isFinite(extractedPage) && extractedPage > 0) return Math.round(extractedPage);
  const issuePage = Number(issue?.pageNumber);
  if (Number.isFinite(issuePage) && issuePage > 0) return Math.round(issuePage);
  return 1;
}

function readNotePosition(note, section, pageOverride = 0) {
  const normalizedX = Number(note?.notePosition?.normalizedX);
  const normalizedY = Number(note?.notePosition?.normalizedY);
  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) {
    return null;
  }
  const absolutePage = Number(pageOverride) || getAbsoluteIssuePage(section);
  return {
    measureIndex: Number(note?.measureIndex) || 1,
    beatStart: Number(note?.beatStart) || 0,
    pageNumber: absolutePage,
    systemIndex: Number(note?.notePosition?.systemIndex) || 1,
    staffIndex: Number(note?.notePosition?.staffIndex) || 1,
    normalizedX,
    normalizedY,
    scoreLineRole: String(note?.notePosition?.scoreLineRole || ""),
    scoreLineConfidence: Number(note?.notePosition?.scoreLineConfidence) || 0,
  };
}

function getNoteStaffIndex(note) {
  const staffIndex = Number(note?.notePosition?.staffIndex);
  return Number.isFinite(staffIndex) && staffIndex >= 1 ? Math.round(staffIndex) : 1;
}

function getErhuStaffIndex(section, fallback = 1) {
  const explicit = Number(section?.selectedStaffIndex || section?.erhuStaffIndex);
  if (Number.isFinite(explicit) && explicit >= 1) return Math.round(explicit);
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  const staffs = new Set();
  for (const note of notes) {
    staffs.add(getNoteStaffIndex(note));
  }
  if (!staffs.size) return fallback;
  // In full scores the solo erhu line is the top staff; piano accompaniment is below.
  return Math.min(...staffs);
}

function getSectionNoteCount(section) {
  return Array.isArray(section?.notes) ? section.notes.length : Number(section?.noteCount) || 0;
}

function shouldProjectImportedFullScoreSection(section) {
  const descriptor = `${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`;
  return /page[-\s]?0*\d+/i.test(descriptor) || /自动识谱第\s*\d+\s*页/i.test(descriptor);
}

function getScoreIssueLineMode(score) {
  const mode = String(score?.scoreIssueLineMode || "auto");
  return SCORE_ISSUE_LINE_MODES.has(mode) ? mode : "auto";
}

function getSelectedPartCandidate(score) {
  const candidates = Array.isArray(score?.partCandidates) ? score.partCandidates : [];
  if (!candidates.length) return null;
  const selected = String(score?.selectedPartId || score?.selectedPart || "").trim().toLowerCase();
  return candidates.find((candidate) => (
    [candidate?.id, candidate?.selectionKey, candidate?.qualifiedLabel, candidate?.name, candidate?.label]
      .map((item) => String(item || "").trim().toLowerCase())
      .includes(selected)
  )) || candidates[0] || null;
}

function isExplicitErhuPartCandidate(candidate) {
  const label = `${candidate?.id || ""} ${candidate?.name || ""} ${candidate?.label || ""}`;
  return /\berhu\b|二胡/i.test(label);
}

function hasAccompanimentPartCandidate(score) {
  const candidates = Array.isArray(score?.partCandidates) ? score.partCandidates : [];
  return candidates.some((candidate) => {
    const label = `${candidate?.id || ""} ${candidate?.name || ""} ${candidate?.label || ""}`;
    return /\b(piano|pno|accompaniment)\b|钢琴|伴奏/i.test(label)
      || Boolean(candidate?.isLikelyPiano)
      || Math.max(1, Number(candidate?.staffCount || 1)) >= 2;
  });
}

function isCleanSoloSelectedPart(score) {
  const candidate = getSelectedPartCandidate(score);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return true;
  if (hasAccompanimentPartCandidate(score)) return false;
  return !candidate?.isLikelyPiano
    && Number(candidate?.chordRatio || 0) < 0.18
    && Math.max(1, Number(candidate?.staffCount || 1)) <= 1;
}

function getImportedProjectionSource(section, score = null) {
  return Array.isArray(section?.partCandidates) && section.partCandidates.length ? section : score;
}

function sectionHasConfidentErhuLine(section) {
  const stats = section?.scoreLineStats && typeof section.scoreLineStats === "object" ? section.scoreLineStats : null;
  if (Number(stats?.erhuNoteCount) > 0) return true;
  return (Array.isArray(section?.notes) ? section.notes : []).some((note) => {
    const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
    const confidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
    return role === "erhu" && confidence >= 0.66;
  });
}

function isAmbiguousImportedPart(score) {
  const candidate = getSelectedPartCandidate(score);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return false;
  return hasAccompanimentPartCandidate(score) || Boolean(candidate?.isLikelyPiano) || Number(candidate?.chordRatio || 0) >= 0.18;
}

function isBlockedImportedProjection(section, score = null) {
  if (sectionHasConfidentErhuLine(section)) return false;
  const mode = String(section?.erhuProjectionMode || "").trim().toLowerCase();
  if (mode === "blocked") return true;
  const source = getImportedProjectionSource(section, score);
  const candidate = getSelectedPartCandidate(source);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return false;
  if (!hasAccompanimentPartCandidate(source)) return false;
  const sectionConfidence = Number(section?.selectedPartConfidence);
  const sourceConfidence = Number(source?.selectedPartConfidence) || 0;
  const confidence = Number.isFinite(sectionConfidence) && sectionConfidence > 0
    ? sectionConfidence
    : sourceConfidence;
  return confidence < 0.62
    && (
      Boolean(candidate?.isLikelyAccompanimentSplit)
      || Boolean(candidate?.isAfterExplicitPiano)
      || Boolean(candidate?.isLikelyPiano)
      || !Boolean(candidate?.safeForErhuProjection)
    );
}

function isErhuMelodySystemIndex(systemIndex, score = null) {
  const numeric = Math.round(Number(systemIndex) || 0);
  if (!numeric) return true;
  if (isCleanSoloSelectedPart(score)) return true;
  if (isAmbiguousImportedPart(score)) return false;
  return (numeric - 1) % 3 === 0;
}

function isErhuMelodyNote(note, section, score = null) {
  const descriptor = `${note?.partName || ""} ${note?.partLabel || ""} ${note?.instrument || ""} ${section?.selectedPart || ""}`;
  if (/\b(piano|pno|accompaniment)\b|钢琴|伴奏/i.test(descriptor)) return false;
  if (!shouldProjectImportedFullScoreSection(section)) return true;
  if (isBlockedImportedProjection(section, score)) return false;
  const source = getImportedProjectionSource(section, score);
  const accompanimentPresent = hasAccompanimentPartCandidate(source) || hasAccompanimentPartCandidate(score);
  const lineRole = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
  const lineConfidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
  if (lineRole === "erhu" && lineConfidence >= 0.66) {
    // Current schema invalidates old issue sessions and always reloads the
    // latest server score, so the explicit line split is safer than guessing
    // from systemIndex.  This keeps all systems of the erhu line while excluding
    // accompaniment lines tagged below.
    return true;
  }
  if (lineRole) return false;
  if (accompanimentPresent || isAmbiguousImportedPart(score) || isAmbiguousImportedPart(source)) return false;
  return isErhuMelodySystemIndex(note?.notePosition?.systemIndex, score);
}

function getErhuMelodyNotes(section, score = null) {
  return (Array.isArray(section?.notes) ? section.notes : []).filter((note) => isErhuMelodyNote(note, section, score));
}

function hasErhuMelodyMeasure(section, measureIndex, score = null) {
  if (!shouldProjectImportedFullScoreSection(section)) return true;
  const numericMeasure = Number(measureIndex) || 1;
  return getErhuMelodyNotes(section, score).some((note) => Number(note?.measureIndex) === numericMeasure);
}

function getSectionSystemOrder(section, score = null) {
  const systems = new Set();
  for (const note of getErhuMelodyNotes(section, score)) {
    const systemIndex = Number(note?.notePosition?.systemIndex);
    if (Number.isFinite(systemIndex) && systemIndex > 0) systems.add(Math.round(systemIndex));
  }
  return [...systems].sort((left, right) => left - right);
}

function getSystemMedianY(section, systemIndex, score = null) {
  const values = getErhuMelodyNotes(section, score)
    .filter((note) => Math.round(Number(note?.notePosition?.systemIndex) || 0) === Math.round(Number(systemIndex) || 0))
    .map((note) => Number(note?.notePosition?.normalizedY))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function projectImportedFullScorePositionToErhuBand(position, section) {
  return position;
}

function isLikelyNonScoreLeadPage(section, score) {
  const pageNumber = getAbsoluteIssuePage(section);
  const totalPages = Number(score?.omrStats?.pageCount) || (Array.isArray(score?.previewPages) ? score.previewPages.length : 0);
  if (totalPages < 4 || pageNumber > 2) return false;
  const noteCount = getSectionNoteCount(section);
  const title = String(section?.title || section?.displayTitle || "");
  const isAutoPage = /自动识谱第\s*[12]\s*页|page[-\s]?0?[12]\b/i.test(`${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${title}`);
  return isAutoPage && noteCount > 0 && noteCount < 12;
}

function isLikelyAccompanimentOnlySection(section, score = null) {
  const descriptor = `${section?.selectedPart || ""} ${section?.partName || ""} ${section?.partLabel || ""} ${section?.title || ""}`;
  if (/\b(piano|pno|accompaniment)\b|钢琴|伴奏/i.test(descriptor)) return true;
  if (!shouldProjectImportedFullScoreSection(section)) return false;
  const stats = section?.scoreLineStats && typeof section.scoreLineStats === "object" ? section.scoreLineStats : null;
  if (stats) {
    const erhuCount = Number(stats.erhuNoteCount) || 0;
    const accompanimentCount = Number(stats.accompanimentNoteCount) || 0;
    if (erhuCount <= 0 && accompanimentCount > 0) return true;
  }
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  if (!notes.length) return false;
  const notesWithSystem = notes.filter((note) => Number.isFinite(Number(note?.notePosition?.systemIndex)));
  if (!notesWithSystem.length) return false;
  return !notesWithSystem.some((note) => isErhuMelodyNote(note, section, score));
}

function findErhuNotePosition(section, issue, preferredStaffIndex, score = null) {
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  const targetStaff = Number(preferredStaffIndex) || getErhuStaffIndex(section);
  const melodyNotes = notes.filter((item) => getNoteStaffIndex(item) === targetStaff && isErhuMelodyNote(item, section, score));
  const absolutePage = getAbsoluteIssuePage(section, issue);
  const measureIndex = Number(issue?.measureIndex) || getApproximateNotePosition(issue?.noteId, 1).measureIndex;
  const importedFullScore = shouldProjectImportedFullScoreSection(section);
  const issueNoteId = String(issue?.noteId || "");

  if (importedFullScore) {
    const sameMeasureImported = melodyNotes
      .filter((item) => Number(item?.measureIndex) === measureIndex && readNotePosition(item, section, absolutePage))
      .sort((left, right) => {
        const beatDelta = Number(left?.beatStart || 0) - Number(right?.beatStart || 0);
        if (Math.abs(beatDelta) > 0.0001) return beatDelta;
        return Number(left?.notePosition?.normalizedX || 0) - Number(right?.notePosition?.normalizedX || 0);
      });

    const exactImportedNote = issueNoteId
      ? sameMeasureImported.find((item) => String(item?.noteId || "") === issueNoteId)
      : null;
    if (exactImportedNote) return readNotePosition(exactImportedNote, section, absolutePage);

    const issueBeat = Number(issue?.beatStart);
    if (Number.isFinite(issueBeat) && sameMeasureImported.length) {
      const closest = sameMeasureImported.reduce((winner, item) => {
        if (!winner) return item;
        return Math.abs(Number(item?.beatStart || 0) - issueBeat) < Math.abs(Number(winner?.beatStart || 0) - issueBeat)
          ? item
          : winner;
      }, null);
      return readNotePosition(closest, section, absolutePage);
    }

    const parsed = parseXmlNoteId(issue?.noteId);
    if (parsed && sameMeasureImported.length) {
      const targetIndex = Math.max(0, Math.min(sameMeasureImported.length - 1, parsed.noteIndex - 1));
      return readNotePosition(sameMeasureImported[targetIndex], section, absolutePage);
    }

    return sameMeasureImported.length === 1 ? readNotePosition(sameMeasureImported[0], section, absolutePage) : null;
  }

  const sameMeasure = melodyNotes
    .filter((item) => Number(item?.measureIndex) === measureIndex && readNotePosition(item, section, absolutePage))
    .sort((left, right) => {
      const beatDelta = Number(left?.beatStart || 0) - Number(right?.beatStart || 0);
      if (Math.abs(beatDelta) > 0.0001) return beatDelta;
      return Number(left?.notePosition?.normalizedX || 0) - Number(right?.notePosition?.normalizedX || 0);
    });

  const exact = sameMeasure.find((item) => String(item?.noteId || "") === String(issue?.noteId || ""));
  if (exact) return readNotePosition(exact, section, absolutePage);

  const issueBeat = Number(issue?.beatStart);
  if (Number.isFinite(issueBeat) && sameMeasure.length) {
    const closest = sameMeasure.reduce((winner, item) => {
      if (!winner) return item;
      return Math.abs(Number(item?.beatStart || 0) - issueBeat) < Math.abs(Number(winner?.beatStart || 0) - issueBeat)
        ? item
        : winner;
    }, null);
    return readNotePosition(closest, section, absolutePage);
  }

  const parsed = parseXmlNoteId(issue?.noteId);
  if (parsed && sameMeasure.length) {
    const targetIndex = Math.max(0, Math.min(sameMeasure.length - 1, parsed.noteIndex - 1));
    return readNotePosition(sameMeasure[targetIndex], section, absolutePage);
  }

  return sameMeasure.length ? readNotePosition(sameMeasure[0], section, absolutePage) : null;
}

function hasExactErhuIssueNote(section, issue, preferredStaffIndex, score = null) {
  if (!shouldProjectImportedFullScoreSection(section)) return true;
  return Boolean(findErhuNotePosition(section, issue, preferredStaffIndex, score));
}

function summarizeOverallFeedback(analysis) {
  const focus =
    analysis?.recommendedPracticePath === "pitch-first"
      ? "音准问题"
      : analysis?.recommendedPracticePath === "rhythm-first"
        ? "节奏问题"
        : getDisplayRhythmScore(analysis) <= getDisplayPitchScore(analysis)
          ? "节奏问题"
          : "音准问题";
  const noteCount = Array.isArray(analysis?.noteFindings) ? analysis.noteFindings.length : 0;
  const measureCount = Array.isArray(analysis?.measureFindings) ? analysis.measureFindings.length : 0;
  const uncertainCount =
    Number(analysis?.diagnostics?.uncertainPitchCount)
    || (Array.isArray(analysis?.noteFindings) ? analysis.noteFindings.filter((item) => item?.isUncertain).length : 0)
    || 0;
  const lines = [
    `本次录音优先需要处理的是${focus}。`,
    `系统共定位到 ${noteCount} 个问题音和 ${measureCount} 个问题小节。`,
  ];
  if (uncertainCount > 0) {
    lines.push(`其中有 ${uncertainCount} 个音的证据偏弱，建议结合示范回放复核。`);
  }
  return lines.join("");
}

function buildMeasureIssues(analysis) {
  return (analysis?.measureFindings || []).map((item) => {
    const label = String(item?.issueType || "").startsWith("pitch") ? "音准问题" : "节奏问题";
    return {
      ...item,
      ...copyIssueTimingFields(item),
      sectionId: String(item?.sectionId || ""),
      sectionTitle: repairMojibakeText(item?.sectionTitle || ""),
      sourcePageNumber: Number(item?.pageNumber) || 0,
      pageNumber: 0,
      measureIndex: Number(item?.measureIndex) || 1,
      label,
      issueTone: getIssueTone([label]),
    };
  });
}

function buildNoteIssues(analysis) {
  return (analysis?.noteFindings || []).map((item) => {
    const tags = [];
    const pitchLabel = String(item?.pitchLabel || "");
    const isPitchReview = pitchLabel === "pitch-review";
    const rhythmType = String(item?.rhythmType || "");
    const rhythmReview =
      Boolean(item?.rhythmReview) || String(item?.evidenceLabel || "").includes("coarse-rhythm-review");
    if (pitchLabel && pitchLabel !== "pitch-ok" && !isPitchReview) tags.push("音准问题");
    if (rhythmType && rhythmType !== "rhythm-ok" && !rhythmReview) tags.push("节奏问题");
    if (isPitchReview || rhythmReview || item?.isUncertain) tags.push("需复核");
    return {
      ...item,
      ...copyIssueTimingFields(item),
      sectionId: String(item?.sectionId || ""),
      sectionTitle: repairMojibakeText(item?.sectionTitle || ""),
      sourcePageNumber: Number(item?.pageNumber) || 0,
      pageNumber: 0,
      noteId: item?.noteId,
      measureIndex: Number(item?.measureIndex) || 1,
      tags: tags.length ? [...new Set(tags)] : ["需复核"],
      issueTone: getIssueTone(tags.length ? tags : ["需复核"]),
    };
  });
}

function getIssueTone(labels = []) {
  const text = labels.join(" ");
  const hasPitch = /音准|pitch/i.test(text);
  const hasRhythm = /节奏|rhythm/i.test(text);
  if (hasPitch && hasRhythm) return "both";
  if (hasPitch) return "pitch";
  if (hasRhythm) return "rhythm";
  return "review";
}

function mergeIssueTones(tones = []) {
  const cleaned = tones.filter(Boolean);
  if (!cleaned.length) return "review";
  if (cleaned.includes("both")) return "both";
  if (cleaned.includes("pitch") && cleaned.includes("rhythm")) return "both";
  return cleaned[0] || "review";
}

function issueToneClass(tone) {
  if (tone === "pitch") return " issue-tone-pitch";
  if (tone === "rhythm") return " issue-tone-rhythm";
  if (tone === "both") return " issue-tone-both";
  return " issue-tone-review";
}

function clampPercent(value, min = 0, max = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function buildMelodyBand({ currentPage, effectiveSections, noteOverlayItems, overlayItems, selectedNoteKey, activeMeasureKey, score }) {
  const page = Math.max(1, Math.round(Number(currentPage) || 1));
  const erhuYValues = [];
  for (const currentSection of effectiveSections || []) {
    const absolutePage = getAbsoluteIssuePage(currentSection);
    if (absolutePage !== page) continue;
    for (const note of Array.isArray(currentSection?.notes) ? currentSection.notes : []) {
      if (!isErhuMelodyNote(note, currentSection, score)) continue;
      const y = Number(note?.notePosition?.normalizedY);
      if (Number.isFinite(y)) erhuYValues.push(y * 100);
    }
  }
  const pageNotes = (noteOverlayItems || []).filter((item) => Number(item.pageNumber) === page);
  const pageMeasures = (overlayItems || []).filter((item) => Number(item.pageNumber || currentPage) === page);
  const selectedNote = pageNotes.find((item) => item.key === selectedNoteKey) || null;
  const activeMeasure = pageMeasures.find((item) => item.measureKey === activeMeasureKey) || null;
  const firstIssue = selectedNote || pageNotes[0] || null;
  const focusY =
    Number.isFinite(Number(firstIssue?.top)) ? Number(firstIssue.top)
      : Number.isFinite(Number(activeMeasure?.top)) ? Number(activeMeasure.top) + Number(activeMeasure.height || 0) / 2
        : erhuYValues.length ? erhuYValues.sort((left, right) => left - right)[Math.floor(erhuYValues.length / 2)]
          : null;
  if (!Number.isFinite(Number(focusY))) return null;

  const nearErhuValues = erhuYValues.filter((value) => Math.abs(value - focusY) <= 12);
  const sourceValues = nearErhuValues.length ? nearErhuValues : [Number(focusY)];
  const minY = Math.min(...sourceValues);
  const maxY = Math.max(...sourceValues);
  const center = (minY + maxY) / 2;
  const rawHeight = Math.max(18, Math.min(28, (maxY - minY) + 16));
  const top = clampPercent(center - rawHeight / 2, 0, 100 - rawHeight);
  return {
    pageNumber: page,
    top,
    height: rawHeight,
    bottom: top + rawHeight,
  };
}

function mapPercentToMelodyBand(value, band) {
  if (!band) return value;
  return ((Number(value) - band.top) / Math.max(1, band.height)) * 100;
}

function mapOverlayToMelodyBand(item, band) {
  if (!band) return item;
  const top = mapPercentToMelodyBand(item.top, band);
  const height = (Number(item.height || 0) / Math.max(1, band.height)) * 100;
  if (top + height < -2 || top > 102) return null;
  return {
    ...item,
    top: clampPercent(top, -6, 106),
    height: clampPercent(height, 3, 100),
  };
}

function mapNoteToMelodyBand(item, band) {
  if (!band) return item;
  const top = mapPercentToMelodyBand(item.top, band);
  if (top < -2 || top > 102) return null;
  return {
    ...item,
    top: clampPercent(top, -4, 104),
  };
}

function ScoreBlock({ label, value }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong>{typeof value === "number" ? value : String(value || "")}</strong>
    </div>
  );
}

function getDominantStaffIndex(section) {
  return getErhuStaffIndex(section, 1);
}

function sectionKey(sectionId, measureIndex) {
  return `${String(sectionId || "section")}::${Number(measureIndex) || 1}`;
}

function getIssueNoteOrdinal(noteId, fallbackOrder = 0) {
  const parsed = parseXmlNoteId(noteId);
  if (parsed?.noteIndex) return parsed.noteIndex;
  const numeric = Number(fallbackOrder);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

function formatDisplayMeasureLabel(measureIndex, displayMeasureIndex = null) {
  const display = Number(displayMeasureIndex);
  if (Number.isFinite(display) && display > 0) return `第 ${Math.round(display)} 小节`;
  const fallback = Number(measureIndex);
  if (Number.isFinite(fallback) && fallback > 0) return `第 ${Math.round(fallback)} 小节`;
  return "未定位小节";
}

function formatDisplayNoteLabel(noteId, measureIndex, displayMeasureIndex = null, fallbackOrder = 0) {
  const noteOrdinal = getIssueNoteOrdinal(noteId, fallbackOrder);
  const measureLabel = formatDisplayMeasureLabel(measureIndex, displayMeasureIndex);
  return noteOrdinal ? `${measureLabel}第 ${noteOrdinal} 音` : measureLabel;
}

function getSectionMeasureValues(section, score = null) {
  const notes = getErhuMelodyNotes(section, score);
  const values = [...new Set(notes.map((note) => Number(note?.measureIndex)).filter((value) => Number.isFinite(value) && value > 0))]
    .map((value) => Math.round(value))
    .sort((left, right) => left - right);
  if (values.length) return values;
  return (Array.isArray(section?.measureRange) ? section.measureRange : [])
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
}

function shouldUseRawMusicXmlMeasureNumbers(sections, score = null) {
  const values = [];
  for (const currentSection of sections) {
    values.push(...getSectionMeasureValues(currentSection, score));
  }
  if (!values.length) return false;
  const maxMeasure = Math.max(...values);
  const uniqueRatio = new Set(values).size / Math.max(1, values.length);
  // If OMR preserved printed measure numbers, the maximum is usually well above
  // per-page local counts. Otherwise pagewise OMR often restarts at 1 on each page.
  return maxMeasure >= 40 || (maxMeasure >= 18 && uniqueRatio >= 0.65);
}

function buildDisplayMeasureLookup(score, sections, projectionScore = null) {
  const lookup = new Map();
  const orderedSections = (Array.isArray(sections) ? sections : [])
    .filter((item) => !isLikelyNonScoreLeadPage(item, score) && !isLikelyAccompanimentOnlySection(item, projectionScore || score))
    .slice()
    .sort((left, right) => {
      const pageDelta = extractSectionPageNumber(left) - extractSectionPageNumber(right);
      if (pageDelta) return pageDelta;
      const sequenceDelta = (Number(left?.sequenceIndex) || 0) - (Number(right?.sequenceIndex) || 0);
      if (sequenceDelta) return sequenceDelta;
      return String(left?.sectionId || "").localeCompare(String(right?.sectionId || ""));
    });
  const useRawNumbers = shouldUseRawMusicXmlMeasureNumbers(orderedSections, projectionScore || score);
  let cursor = 0;
  for (const currentSection of orderedSections) {
    const sectionId = String(currentSection?.sectionId || "");
    const values = getSectionMeasureValues(currentSection, projectionScore || score);
    if (!values.length) continue;
    if (useRawNumbers) {
      for (const measureIndex of values) {
        lookup.set(sectionKey(sectionId, measureIndex), measureIndex);
      }
      cursor = Math.max(cursor, ...values);
      continue;
    }
    for (const measureIndex of values) {
      cursor += 1;
      lookup.set(sectionKey(sectionId, measureIndex), cursor);
    }
  }
  return lookup;
}

function resolveIssueSection(score, fallbackSection, issue) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const requestedId = String(issue?.sectionId || "").trim();
  const issuePage = Number(issue?.sourcePageNumber || issue?.pageNumber);
  const measureIndex = Number(issue?.measureIndex);
  const noteId = String(issue?.noteId || "").trim();
  if (requestedId) {
    const matched = sections.find((item) => String(item?.sectionId || "") === requestedId || String(item?.sourceSectionId || "") === requestedId);
    if (matched) {
      const requestedIsUsable =
        !isLikelyAccompanimentOnlySection(matched, score) &&
        (
          !shouldProjectImportedFullScoreSection(matched) ||
          (
            Number.isFinite(measureIndex) &&
            hasErhuMelodyMeasure(matched, measureIndex, score) &&
            (!noteId || (matched.notes || []).some((note) => (
              String(note?.noteId || "") === noteId &&
              Number(note?.measureIndex) === measureIndex &&
              isErhuMelodyNote(note, matched, score)
            )))
          )
        );
      if (requestedIsUsable) return matched;
    }
  }
  if (Number.isFinite(issuePage) && issuePage > 0) {
    const pageSections = sections.filter((item) => extractSectionPageNumber(item) === Math.round(issuePage));
    if (pageSections.length && (Number.isFinite(measureIndex) || noteId)) {
      const exactErhuSection = pageSections.find((candidate) => {
        const notes = Array.isArray(candidate?.notes) ? candidate.notes : [];
        return notes.some((note) => {
          if (Number.isFinite(measureIndex) && Number(note?.measureIndex) !== measureIndex) return false;
          if (noteId && String(note?.noteId || "") !== noteId) return false;
          return isErhuMelodyNote(note, candidate, score);
        });
      });
      if (exactErhuSection) return exactErhuSection;
      const measureErhuSection = pageSections.find((candidate) => (
        Number.isFinite(measureIndex)
        && hasErhuMelodyMeasure(candidate, measureIndex, score)
      ));
      if (measureErhuSection) return measureErhuSection;
    }
    const erhuPageSection = pageSections.find((candidate) => getErhuMelodyNotes(candidate, score).length > 0);
    if (erhuPageSection) return erhuPageSection;
  }
  return fallbackSection || sections[0] || null;
}

function resolvePreferredSection(score, fallbackSection, analysis) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const analysisSectionId = String(analysis?.sectionId || "").trim();
  if (analysisSectionId) {
    const matchedAnalysisSection = sections.find(
      (item) => String(item?.sectionId || "") === analysisSectionId || String(item?.sourceSectionId || "") === analysisSectionId,
    );
    if (matchedAnalysisSection) return matchedAnalysisSection;
  }
  const fallbackSectionId = String(fallbackSection?.sectionId || "").trim();
  if (fallbackSectionId) {
    const matchedFallbackSection = sections.find(
      (item) => String(item?.sectionId || "") === fallbackSectionId || String(item?.sourceSectionId || "") === fallbackSectionId,
    );
    if (matchedFallbackSection) return matchedFallbackSection;
  }
  return fallbackSection || sections[0] || null;
}

export default function ScoreIssuePage() {
  const issueSessionId = getIssueSessionId();
  const stored = readStoredSession(issueSessionId);
  const [score, setScore] = useState(stored?.score || null);
  const [analysis, setAnalysis] = useState(() => attachOriginalAudio(stored?.analysis, stored?.originalAudio));
  const [section, setSection] = useState(() => resolvePreferredSection(stored?.score, stored?.section, stored?.analysis));
  const [error, setError] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(() => extractSectionPageNumber(resolvePreferredSection(stored?.score, stored?.section, stored?.analysis) || {}));
  const [selectedMeasureIndex, setSelectedMeasureIndex] = useState(null);
  const [selectedNoteKey, setSelectedNoteKey] = useState("");
  const [pageImageFailed, setPageImageFailed] = useState(false);
  const [zoom, setZoom] = useState(1.0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [lineMode, setLineMode] = useState(() => readStoredLineMode(stored?.score?.scoreId));
  const [playbackHint, setPlaybackHint] = useState("");
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const playbackStopTimerRef = useRef(null);
  const viewportRef = useRef(null);
  const hasAutoFittedRef = useRef(false);
  const hasAutoSelectedInitialIssuePageRef = useRef(false);
  const issueListRefs = useRef(new Map());
  const isWholePieceMode = stored?.mode === "whole-piece" || analysis?.analysisMode === "whole-piece";
  const projectionScore = useMemo(
    () => (score ? { ...score, scoreIssueLineMode: lineMode } : score),
    [lineMode, score],
  );

  useEffect(() => {
    const scoreId = score?.scoreId;
    if (!scoreId) return;
    setLineMode(readStoredLineMode(scoreId));
  }, [score?.scoreId]);

  useEffect(() => {
    if (!score?.scoreId) return;
    writeStoredLineMode(score.scoreId, lineMode);
  }, [lineMode, score?.scoreId]);

  useEffect(() => {
    let cancelled = false;
    async function loadScore() {
      const scoreId = String(stored?.score?.scoreId || "").trim();
      if (!scoreId) return;
      try {
        const json = await fetchScore(scoreId);
        if (cancelled) return;
        const nextScore = json?.score || null;
        if (!nextScore) return;
        setScore(nextScore);
        const nextSection = resolvePreferredSection(nextScore, stored?.section, stored?.analysis);
        setSection(nextSection);
        if (!isWholePieceMode) {
          setCurrentPage(extractSectionPageNumber(nextSection || {}));
        }
      } catch {
        if (!cancelled) {
          setError("问题谱面数据已失效，请返回结果页重新打开。");
        }
      }
    }
    void loadScore();
    return () => {
      cancelled = true;
    };
  }, [isWholePieceMode, issueSessionId, stored?.score?.scoreId]);

  useEffect(() => {
    const scoreId = String(score?.scoreId || "").trim();
    const analysisScoreId = String(analysis?.scoreId || "").trim();
    if (!scoreId || !analysisScoreId) return;
    if (scoreId === analysisScoreId) return;
    setAnalysis(null);
    setError("当前问题谱会话与分析结果不一致，请返回学生端结果页重新打开。");
  }, [analysis, score]);

  // Re-read analysis when the main app writes a new result to the same storage key.
  useEffect(() => {
    if (!issueSessionId) return undefined;
    const storageKey = `${ISSUE_SESSION_STORAGE_PREFIX}${issueSessionId}`;
    function onStorage(event) {
      if (event.key !== storageKey) return;
      const fresh = readStoredSession(issueSessionId);
      if (!fresh?.analysis) return;
      setAnalysis(attachOriginalAudio(fresh.analysis, fresh.originalAudio));
      const nextSection = resolvePreferredSection(score || fresh.score, fresh.section, fresh.analysis);
      if (nextSection) {
        setSection(nextSection);
        setCurrentPage(extractSectionPageNumber(nextSection));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [issueSessionId, score]);

  useEffect(() => {
    if (isWholePieceMode) return;
    const nextSection = resolvePreferredSection(score, section, analysis);
    if (!nextSection) return;
    const currentSectionId = String(section?.sectionId || "");
    const nextSectionId = String(nextSection?.sectionId || "");
    if (currentSectionId === nextSectionId) return;
    setSection(nextSection);
    setCurrentPage(extractSectionPageNumber(nextSection));
  }, [analysis, isWholePieceMode, score, section]);

  useEffect(() => {
    setPageImageFailed(false);
    hasAutoFittedRef.current = false;
  }, [score?.sourcePdfPath, section?.pageImagePath, currentPage]);

  const effectiveSections = useMemo(
    () => {
      const sections = isWholePieceMode ? (Array.isArray(score?.sections) ? score.sections : []) : (section ? [section] : []);
      return sections.filter((item) => !isWholePieceMode || (!isLikelyNonScoreLeadPage(item, score) && !isLikelyAccompanimentOnlySection(item, projectionScore)));
    },
    [isWholePieceMode, projectionScore, score, section],
  );
  const firstEffectivePage = useMemo(
    () => {
      const pages = effectiveSections
        .map((item) => getAbsoluteIssuePage(item))
        .filter((value) => Number.isFinite(value) && value > 0);
      return pages.length ? Math.min(...pages) : 1;
    },
    [effectiveSections],
  );
  const baseSectionPage = isWholePieceMode ? firstEffectivePage : extractSectionPageNumber(section || {});
  const pageImagePath = buildImportedPageImagePath(score, section, currentPage);
  const usePageImage = Boolean(pageImagePath && !pageImageFailed);
  const dominantStaffIndex = useMemo(() => getDominantStaffIndex(section || effectiveSections[0]), [effectiveSections, section]);
  const hasImportedScoreSections = useMemo(
    () => effectiveSections.some((item) => shouldProjectImportedFullScoreSection(item)),
    [effectiveSections],
  );
  const ambiguousImportedScore = hasImportedScoreSections && isAmbiguousImportedPart(score);
  const displayMeasureSections = useMemo(
    () => (isWholePieceMode ? effectiveSections : (Array.isArray(score?.sections) ? score.sections : effectiveSections)),
    [effectiveSections, isWholePieceMode, score?.sections],
  );
  const displayMeasureLookup = useMemo(
    () => buildDisplayMeasureLookup(score, displayMeasureSections, projectionScore),
    [displayMeasureSections, projectionScore, score],
  );

  useEffect(() => {
    if (!usePageImage) return;
    const previewCount = Array.isArray(score?.previewPages) ? score.previewPages.length : 0;
    const omrPageCount = Number(score?.omrStats?.pageCount);
    const effectivePageCount = Number.isFinite(omrPageCount) && omrPageCount > 0 ? omrPageCount : previewCount;
    setPageCount(effectivePageCount || 0);
  }, [currentPage, score?.omrStats?.pageCount, score?.previewPages, usePageImage]);

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;

    async function renderPdf() {
      const pdfUrl = score?.sourcePdfPath;
      if (!pdfUrl || !canvasRef.current || usePageImage) return;
      try {
        const document = await getDocument(pdfUrl).promise;
        if (cancelled) return;
        setPageCount(document.numPages || 0);
        const safePage = Math.min(Math.max(1, currentPage || 1), document.numPages || 1);
        const page = await document.getPage(safePage);
        if (cancelled) return;
        const containerWidth = viewportRef.current ? viewportRef.current.clientWidth - 8 : 0;
        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = containerWidth > 0 ? containerWidth / baseViewport.width : 1.8;
        const renderScale = Math.max(fitScale, 1.8);
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        setStageSize({ width: viewport.width, height: viewport.height });
        if (!hasAutoFittedRef.current) {
          setZoom(1.0);
          hasAutoFittedRef.current = true;
        }
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (err) {
        if (!cancelled && !(String(err?.message || err).includes("cancel") || String(err?.name || "").includes("cancel"))) {
          setError("无法加载乐谱页面，请尝试点击上方【打开 PDF】按钮在新窗口查看。");
        }
      }
    }

    void renderPdf();
    return () => {
      cancelled = true;
      if (renderTask?.cancel) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, [currentPage, score?.sourcePdfPath, usePageImage]);

  const measureCount = isWholePieceMode
    ? Math.max(1, ...effectiveSections.map((item) => getSectionMeasureCount(item)))
    : getSectionMeasureCount(section || {});
  const measureIssues = useMemo(
    () => buildMeasureIssues(analysis),
    [analysis],
  );
  const noteIssues = useMemo(
    () => buildNoteIssues(analysis),
    [analysis],
  );
  const visibleAnalysisForSummary = useMemo(
    () => ({
      ...analysis,
      measureFindings: measureIssues,
      noteFindings: noteIssues,
    }),
    [analysis, measureIssues, noteIssues],
  );
  const firstIssuePage = useMemo(() => {
    const pages = measureIssues
      .map((item) => extractSectionPageNumber(resolveIssueSection(score, section, item)))
      .concat(noteIssues.map((item) => extractSectionPageNumber(resolveIssueSection(score, section, item))))
      .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      .map((value) => Number(value));
    return pages.length ? Math.min(...pages) : baseSectionPage;
  }, [baseSectionPage, measureIssues, noteIssues, score, section]);

  useEffect(() => {
    if (!isWholePieceMode) return;
    if (hasAutoSelectedInitialIssuePageRef.current) return;
    hasAutoSelectedInitialIssuePageRef.current = true;
    if (currentPage === firstIssuePage) return;
    setCurrentPage(firstIssuePage);
  }, [currentPage, firstIssuePage, isWholePieceMode, score]);
  const issueMeasureKeys = [
    ...new Set(
      measureIssues
        .map((item) => sectionKey(item.sectionId || resolveIssueSection(score, section, item)?.sectionId, item.measureIndex))
        .concat(noteIssues.map((item) => sectionKey(item.sectionId || resolveIssueSection(score, section, item)?.sectionId, item.measureIndex))),
    ),
  ];
  const activeMeasureKey = selectedMeasureIndex || issueMeasureKeys[0] || "";
  const activeMeasureIndex = activeMeasureKey ? Number(String(activeMeasureKey).split("::").pop()) || null : null;

  const measurePageMap = useMemo(() => {
    const pageMap = new Map();
    for (const currentSection of effectiveSections) {
      const currentSectionId = String(currentSection?.sectionId || "");
      const sectionStaffIndex = getErhuStaffIndex(currentSection, dominantStaffIndex);
      const absolutePage = getAbsoluteIssuePage(currentSection);
      for (const note of Array.isArray(currentSection?.notes) ? currentSection.notes : []) {
        const measureIndex = Number(note?.measureIndex);
        const pageNumber = absolutePage;
        const staffIndex = getNoteStaffIndex(note);
        if (!Number.isFinite(measureIndex) || !Number.isFinite(pageNumber)) continue;
        if (staffIndex !== sectionStaffIndex) continue;
        if (!isErhuMelodyNote(note, currentSection, projectionScore)) continue;
        const key = sectionKey(currentSectionId, measureIndex);
        if (!pageMap.has(key)) {
          pageMap.set(key, pageNumber);
        }
      }
    }
    return pageMap;
  }, [dominantStaffIndex, effectiveSections, projectionScore]);

  const noteOverlayItems = useMemo(
    () =>
      noteIssues
        .map((item, index) => {
          const issueSection = resolveIssueSection(score, section, item);
          const issueSectionId = String(issueSection?.sectionId || item?.sectionId || "");
          const sectionStaffIndex = getErhuStaffIndex(issueSection, dominantStaffIndex);
          const exact = findErhuNotePosition(issueSection, item, sectionStaffIndex, projectionScore);
          if (exact) {
            const measureKey = sectionKey(issueSectionId, exact.measureIndex);
            return {
              key: `${issueSectionId}-${item?.noteId || index}-${exact.measureIndex}`,
              sectionId: issueSectionId,
              sectionTitle: formatSectionDisplayName(issueSection),
              noteId: item?.noteId || "",
              measureIndex: exact.measureIndex,
              displayMeasureIndex: displayMeasureLookup.get(measureKey) || exact.measureIndex,
              noteOrdinal: getIssueNoteOrdinal(item?.noteId, index + 1),
              left: Math.min(Math.max(exact.normalizedX * 100, 0), 100),
              top: Math.min(Math.max(exact.normalizedY * 100, 0), 100),
              systemIndex: exact.systemIndex,
              scoreLineRole: exact.scoreLineRole,
              scoreLineConfidence: exact.scoreLineConfidence,
              exact: true,
              pageNumber: exact.pageNumber,
              tags: item?.tags || [],
              issueTone: item?.issueTone || getIssueTone(item?.tags || []),
            };
          }
          if (shouldProjectImportedFullScoreSection(issueSection)) {
            return null;
          }
          const { measureIndex, noteIndex } = getApproximateNotePosition(item?.noteId, item?.measureIndex, index + 1);
          const measureKey = sectionKey(issueSectionId, measureIndex);
          const slotWidth = 100 / Math.max(1, measureCount);
          const measureLeft = Math.max(0, (measureIndex - 1) * slotWidth);
          const relativeStep = Math.min(0.85, 0.18 + ((noteIndex - 1) % 6) * 0.12);
          const bandIndex = (noteIndex - 1) % 3;
          return {
            key: `${issueSectionId}-${item?.noteId || index}-${measureIndex}-${noteIndex}`,
            sectionId: issueSectionId,
            sectionTitle: formatSectionDisplayName(issueSection),
            noteId: item?.noteId || "",
            measureIndex,
            displayMeasureIndex: displayMeasureLookup.get(measureKey) || measureIndex,
            noteOrdinal: noteIndex,
            left: Math.min(measureLeft + slotWidth * relativeStep, 98),
            top: 18 + bandIndex * 18,
            exact: false,
            pageNumber: measurePageMap.get(sectionKey(issueSectionId, measureIndex)) || extractSectionPageNumber(issueSection) || baseSectionPage,
            tags: item?.tags || [],
            issueTone: item?.issueTone || getIssueTone(item?.tags || []),
          };
        })
        .filter(Boolean),
    [baseSectionPage, displayMeasureLookup, dominantStaffIndex, measureCount, measurePageMap, noteIssues, projectionScore, score, section],
  );

  const measureIssueEntries = useMemo(
    () =>
      measureIssues.map((item, index) => {
        const issueSection = resolveIssueSection(score, section, item);
        const issueSectionId = String(issueSection?.sectionId || item.sectionId || "");
        const measureKey = sectionKey(issueSectionId, item.measureIndex);
        const leadPage = isWholePieceMode && isLikelyNonScoreLeadPage(issueSection, score);
        const accompanimentOnly = isWholePieceMode && isLikelyAccompanimentOnlySection(issueSection, projectionScore);
        const hasMelodyMeasure = Boolean(issueSection && hasErhuMelodyMeasure(issueSection, item.measureIndex, projectionScore));
        const locationReliable = Boolean(issueSection && !leadPage && !accompanimentOnly && hasMelodyMeasure);
        return {
          ...item,
          sectionId: issueSectionId,
          sectionTitle: item.sectionTitle || formatSectionDisplayName(issueSection),
          pageNumber: locationReliable
            ? (measurePageMap.get(sectionKey(issueSectionId, item.measureIndex)) || extractSectionPageNumber(issueSection))
            : (Number(item.sourcePageNumber || item.pageNumber) || extractSectionPageNumber(issueSection)),
          displayMeasureIndex: displayMeasureLookup.get(measureKey) || item.measureIndex,
          measureKey,
          issueKey: `measure-${measureKey}`,
          issueNumber: index + 1,
          issueTone: item.issueTone || getIssueTone([item.label]),
          locationReliable,
          needsReview: !locationReliable,
          reviewReason: locationReliable ? "" : "未定位到可靠二胡小节坐标，已保留为复核项",
        };
      }),
    [displayMeasureLookup, isWholePieceMode, measureIssues, measurePageMap, projectionScore, score, section],
  );

  const noteIssueEntries = useMemo(
    () =>
      noteIssues.map((item, index) => {
        const issueSection = resolveIssueSection(score, section, item);
        const issueSectionId = String(issueSection?.sectionId || item.sectionId || "");
        const overlayItem =
          noteOverlayItems.find((overlay) => String(overlay.noteId || "") === String(item.noteId || "") && overlay.measureIndex === item.measureIndex && overlay.sectionId === issueSectionId)
          || null;
        const overlayKey = overlayItem?.key || `note-${item.noteId || index}-${item.measureIndex}`;
        const importedSection = shouldProjectImportedFullScoreSection(issueSection);
        const locationReliable = Boolean(overlayItem && (!importedSection || overlayItem.exact));
        const tags = locationReliable ? item.tags : [...new Set([...(item.tags || []), "需复核"])];
        return {
          ...item,
          tags,
          sectionId: issueSectionId,
          sectionTitle: item.sectionTitle || formatSectionDisplayName(issueSection),
          pageNumber: locationReliable
            ? (overlayItem?.pageNumber || extractSectionPageNumber(issueSection))
            : (Number(item.sourcePageNumber || item.pageNumber) || extractSectionPageNumber(issueSection)),
          displayMeasureIndex: displayMeasureLookup.get(sectionKey(issueSectionId, item.measureIndex)) || item.measureIndex,
          noteOrdinal: getIssueNoteOrdinal(item.noteId, index + 1),
          overlayItem,
          overlayKey,
          issueKey: `note-${overlayKey}`,
          issueNumber: measureIssueEntries.length + index + 1,
          issueTone: item.issueTone || overlayItem?.issueTone || getIssueTone(tags || []),
          locationReliable,
          needsReview: !locationReliable,
          reviewReason: locationReliable ? "" : "未定位到可靠二胡音符坐标，已保留为复核项",
        };
      }),
    [displayMeasureLookup, measureIssueEntries.length, noteIssues, noteOverlayItems, score, section],
  );

  const issueNumberLookup = useMemo(() => {
    const combined = [
      ...measureIssueEntries.map((item) => ({ ...item, issueKind: "measure" })),
      ...noteIssueEntries.map((item) => ({ ...item, issueKind: "note" })),
    ].sort((left, right) => {
      const pageDelta = (Number(left.pageNumber) || 1) - (Number(right.pageNumber) || 1);
      if (pageDelta) return pageDelta;
      const sectionDelta = String(left.sectionId || "").localeCompare(String(right.sectionId || ""));
      if (sectionDelta) return sectionDelta;
      const measureDelta = (Number(left.measureIndex) || 1) - (Number(right.measureIndex) || 1);
      if (measureDelta) return measureDelta;
      const kindDelta = (left.issueKind === "measure" ? 0 : 1) - (right.issueKind === "measure" ? 0 : 1);
      if (kindDelta) return kindDelta;
      return String(left.noteId || left.issueKey || "").localeCompare(String(right.noteId || right.issueKey || ""));
    });
    return new Map(combined.map((item, index) => [item.issueKey, index + 1]));
  }, [measureIssueEntries, noteIssueEntries]);

  const measureOverlayKeys = useMemo(
    () => [...new Set(measureIssueEntries.filter((item) => item.locationReliable).map((item) => item.measureKey))],
    [measureIssueEntries],
  );

  const issueEntries = useMemo(
    () => [
      ...measureIssueEntries.map((item) => ({
        ...item,
        issueKind: "measure",
        listKey: item.issueKey,
        issueNumber: issueNumberLookup.get(item.issueKey) || item.issueNumber,
      })),
      ...noteIssueEntries.map((item) => ({
        ...item,
        issueKind: "note",
        listKey: item.overlayKey,
        issueNumber: issueNumberLookup.get(item.issueKey) || item.issueNumber,
      })),
    ].sort((left, right) => (left.issueNumber || 0) - (right.issueNumber || 0)),
    [issueNumberLookup, measureIssueEntries, noteIssueEntries],
  );

  const measureIssueNumberMap = useMemo(
    () => new Map(issueEntries.filter((item) => item.issueKind === "measure").map((item) => [item.measureKey, item.issueNumber])),
    [issueEntries],
  );

  const noteIssueNumberMap = useMemo(
    () => new Map(issueEntries.filter((item) => item.issueKind === "note").map((item) => [item.overlayKey, item.issueNumber])),
    [issueEntries],
  );

  const measureIssueToneMap = useMemo(() => {
    const toneMap = new Map();
    for (const item of issueEntries) {
      const key = item.measureKey || sectionKey(item.sectionId, item.measureIndex);
      if (!key) continue;
      toneMap.set(key, mergeIssueTones([toneMap.get(key), item.issueTone]));
    }
    return toneMap;
  }, [issueEntries]);

  const overlayItems = useMemo(() => {
    const exactMeasureOverlays = measureOverlayKeys
      .map((measureKey) => {
        const [measureSectionId, measureText] = String(measureKey).split("::");
        const measureIndex = Number(measureText) || 1;
        const measureSection = effectiveSections.find((item) => String(item?.sectionId || "") === measureSectionId) || section;
        if (shouldProjectImportedFullScoreSection(measureSection)) return null;
        const sectionStaffIndex = getErhuStaffIndex(measureSection, dominantStaffIndex);
        const absolutePage = getAbsoluteIssuePage(measureSection);
        const measureNotes = (Array.isArray(measureSection?.notes) ? measureSection.notes : [])
          .filter((item) => Number(item?.measureIndex) === measureIndex && getNoteStaffIndex(item) === sectionStaffIndex && isErhuMelodyNote(item, measureSection, projectionScore))
          .map((item) => {
            const position = readNotePosition(item, measureSection, absolutePage);
            return {
              pageNumber: position?.pageNumber || absolutePage,
              x: Number(position?.normalizedX),
              y: Number(position?.normalizedY),
            };
          })
          .filter((item) => item.pageNumber === currentPage && Number.isFinite(item.x) && Number.isFinite(item.y));
        if (!measureNotes.length) return null;
        const minX = Math.min(...measureNotes.map((item) => item.x * 100));
        const maxX = Math.max(...measureNotes.map((item) => item.x * 100));
        const minY = Math.min(...measureNotes.map((item) => item.y * 100));
        const maxY = Math.max(...measureNotes.map((item) => item.y * 100));
        return {
          measureKey,
          sectionId: measureSectionId,
          measureIndex,
          pageNumber: currentPage,
          issueTone: measureIssueToneMap.get(measureKey) || "review",
          left: Math.max(0, minX - 2.2),
          top: Math.max(0, minY - 3.2),
          width: Math.max(4.5, (maxX - minX) + 4.4),
          height: Math.max(6.2, (maxY - minY) + 6.4),
        };
      })
      .filter(Boolean);
    if (exactMeasureOverlays.length) {
      return exactMeasureOverlays;
    }
    return measureOverlayKeys
      .filter((measureKey) => (measurePageMap.get(measureKey) || baseSectionPage) === currentPage)
      .map((measureKey) => {
        const [measureSectionId, measureText] = String(measureKey).split("::");
        const measureSection = effectiveSections.find((item) => String(item?.sectionId || "") === measureSectionId) || section;
        if (shouldProjectImportedFullScoreSection(measureSection)) return null;
        const measureIndex = Number(measureText) || 1;
        const slotWidth = 100 / Math.max(1, measureCount);
        const left = Math.max(0, (measureIndex - 1) * slotWidth);
        return {
          measureKey,
          sectionId: measureSectionId,
          measureIndex,
          pageNumber: measurePageMap.get(measureKey) || baseSectionPage,
          issueTone: measureIssueToneMap.get(measureKey) || "review",
          left: Math.min(left, 96),
          top: 10,
          width: Math.max(5.5, Math.min(slotWidth, 18)),
          height: 18,
        };
      })
      .filter(Boolean);
  }, [baseSectionPage, currentPage, dominantStaffIndex, effectiveSections, measureCount, measureIssueToneMap, measureOverlayKeys, measurePageMap, projectionScore, section]);

  const effectiveWidth = stageSize.width > 0 ? stageSize.width * zoom : 0;
  const effectiveHeight = stageSize.height > 0 ? stageSize.height * zoom : 0;
  const melodyBand = useMemo(
    () => {
      if (!hasImportedScoreSections) return null;
      return buildMelodyBand({
        currentPage,
        effectiveSections,
        noteOverlayItems,
        overlayItems,
        selectedNoteKey,
        activeMeasureKey,
        score: projectionScore,
      });
    },
    [activeMeasureKey, currentPage, effectiveSections, hasImportedScoreSections, noteOverlayItems, overlayItems, projectionScore, selectedNoteKey],
  );
  const displayOverlayItems = useMemo(
    () => overlayItems
      .filter((item) => Number(item.pageNumber || currentPage) === currentPage)
      .map((item) => mapOverlayToMelodyBand(item, melodyBand))
      .filter(Boolean),
    [currentPage, melodyBand, overlayItems],
  );
  const displayNoteOverlayItems = useMemo(
    () => noteOverlayItems
      .filter((item) => item.pageNumber === currentPage)
      .map((item) => mapNoteToMelodyBand(item, melodyBand))
      .filter(Boolean),
    [currentPage, melodyBand, noteOverlayItems],
  );
  const currentPageHighlightCount = displayOverlayItems.length + displayNoteOverlayItems.length;
  const displayHeight = melodyBand && effectiveHeight
    ? effectiveHeight * (melodyBand.height / 100)
    : effectiveHeight;
  const sourceOffsetTop = melodyBand && effectiveHeight ? -(effectiveHeight * (melodyBand.top / 100)) : 0;
  const sectionDisplayName = isWholePieceMode ? `${formatScoreTitle(score)} · 整曲问题谱面` : formatSectionDisplayName(section);
  const originalAudioSource =
    analysis?.originalAudio?.url ||
    analysis?.originalAudioUrl ||
    analysis?.audioUrl ||
    analysis?.rawAudioPath ||
    analysis?.diagnostics?.rawAudioPath ||
    "";

  useEffect(() => {
    clearPlaybackStopTimer();
    setPlaybackHint("");
    if (!originalAudioSource || !audioRef.current) return;
    audioRef.current.load();
  }, [originalAudioSource]);

  useEffect(() => () => {
    clearPlaybackStopTimer();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !effectiveWidth || !displayHeight) return;
    const focusNote =
      displayNoteOverlayItems.find((item) => item.key === selectedNoteKey && item.pageNumber === currentPage)
      || displayNoteOverlayItems.find((item) => item.pageNumber === currentPage && sectionKey(item.sectionId, item.measureIndex) === activeMeasureKey && item.exact)
      || displayNoteOverlayItems.find((item) => item.pageNumber === currentPage && sectionKey(item.sectionId, item.measureIndex) === activeMeasureKey)
      || null;
    const focusMeasure = displayOverlayItems.find((item) => item.measureKey === activeMeasureKey) || null;
    const focusLeftPercent = focusNote ? focusNote.left : focusMeasure ? focusMeasure.left + focusMeasure.width / 2 : null;
    const focusTopPercent = focusNote ? focusNote.top : focusMeasure ? focusMeasure.top + focusMeasure.height / 2 : null;
    if (focusLeftPercent == null || focusTopPercent == null) return;
    const targetLeft = (focusLeftPercent / 100) * effectiveWidth - viewport.clientWidth / 2;
    const targetTop = (focusTopPercent / 100) * displayHeight - viewport.clientHeight / 2;
    viewport.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [activeMeasureKey, currentPage, displayHeight, displayNoteOverlayItems, displayOverlayItems, effectiveWidth, selectedNoteKey, zoom]);

  useEffect(() => {
    const targetKey = selectedNoteKey || (activeMeasureKey ? `measure-${activeMeasureKey}` : "");
    if (!targetKey) return;
    const target = issueListRefs.current.get(targetKey);
    if (!target?.scrollIntoView) return;
    target.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeMeasureKey, selectedNoteKey]);

  function clearPlaybackStopTimer() {
    if (playbackStopTimerRef.current && typeof window !== "undefined") {
      window.clearInterval(playbackStopTimerRef.current);
    }
    playbackStopTimerRef.current = null;
  }

  function playIssueAudio(issue, kind) {
    if (!issue || !originalAudioSource || !audioRef.current) return;
    const issueSection = resolveIssueSection(score, section, issue) || section || {};
    const playbackWindow = buildIssuePlaybackWindow(issue, issueSection, kind, analysis, audioRef.current);
    if (!playbackWindow) return;
    clearPlaybackStopTimer();
    const audio = audioRef.current;
    try {
      audio.currentTime = playbackWindow.start;
    } catch {
      setPlaybackHint("原音已加载，但浏览器暂时不能定位到该时间点。");
      return;
    }
    const label = kind === "measure" ? "小节" : "音符";
    const hint = `已定位${label}原音 ${formatPlaybackSeconds(playbackWindow.start)}-${formatPlaybackSeconds(playbackWindow.end)}`;
    setPlaybackHint(hint);
    const playPromise = audio.play();
    if (playPromise?.catch) {
      playPromise.catch(() => {
        setPlaybackHint(`${hint}，可手动点击播放。`);
      });
    }
    if (typeof window !== "undefined") {
      playbackStopTimerRef.current = window.setInterval(() => {
        const currentAudio = audioRef.current;
        if (!currentAudio || currentAudio.paused || currentAudio.ended) {
          clearPlaybackStopTimer();
          return;
        }
        if (currentAudio.currentTime >= playbackWindow.end - 0.05) {
          currentAudio.pause();
          clearPlaybackStopTimer();
        }
      }, 120);
    }
  }

  function handleMeasureJump(measureIndex, item = null) {
    const key = item?.measureKey || sectionKey(item?.sectionId || resolveIssueSection(score, section, item)?.sectionId, measureIndex);
    const playbackIssue = measureIssueEntries.find((entry) => entry.measureKey === key) || item;
    setCurrentPage(item?.pageNumber || measurePageMap.get(key) || baseSectionPage);
    setSelectedMeasureIndex(key);
    setSelectedNoteKey("");
    playIssueAudio(playbackIssue, "measure");
  }

  function handlePageNavigation(nextPage) {
    setSelectedMeasureIndex(null);
    setSelectedNoteKey("");
    setCurrentPage(Math.max(1, Math.min(pageCount || nextPage, nextPage)));
  }

  function handleNoteJump(noteItem, overlayItem) {
    if (!noteItem) return;
    const resolvedOverlay =
      overlayItem
      || noteOverlayItems.find((item) => (
        String(item.noteId || "") === String(noteItem.noteId || "")
        && item.measureIndex === noteItem.measureIndex
        && (!noteItem.sectionId || item.sectionId === noteItem.sectionId)
      ))
      || null;
    const key = sectionKey(resolvedOverlay?.sectionId || noteItem.sectionId || resolveIssueSection(score, section, noteItem)?.sectionId, noteItem.measureIndex);
    setCurrentPage(resolvedOverlay?.pageNumber || noteItem.pageNumber || measurePageMap.get(key) || baseSectionPage);
    setSelectedMeasureIndex(key);
    setSelectedNoteKey(resolvedOverlay?.key || "");
    playIssueAudio(noteItem, "note");
  }

  function handleImageLoad(event) {
    const image = event.currentTarget;
    const naturalW = image.naturalWidth || image.width || 0;
    const naturalH = image.naturalHeight || image.height || 0;
    setStageSize({ width: naturalW, height: naturalH });
    if (!hasAutoFittedRef.current && viewportRef.current && naturalW > 0) {
      const available = viewportRef.current.clientWidth - 8;
      setZoom(Math.max(0.75, Math.min(4, parseFloat((available / naturalW).toFixed(2)))));
      hasAutoFittedRef.current = true;
    }
  }

  function setIssueListRef(key, element) {
    if (!key) return;
    if (element) {
      issueListRefs.current.set(key, element);
      return;
    }
    issueListRefs.current.delete(key);
  }

  if (!analysis || !stored) {
    return (
      <div className="app-shell">
        <section className="panel-card">
          <h2>问题谱面页不可用</h2>
          <p className="supporting-copy">没有找到当前分析结果。请从学生端结果页重新打开“问题谱面页”。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell score-issue-shell">
      <header className="panel-card score-issue-header">
        <div className="score-issue-title">
          <h1>{sectionDisplayName || "问题谱面"}</h1>
          <div className="score-inline-scores">
            <span className="score-inline-chip">音准 <strong>{getDisplayPitchScore(analysis)}</strong></span>
            <span className="score-inline-chip">节奏 <strong>{getDisplayRhythmScore(analysis)}</strong></span>
            <span className="score-inline-chip">综合 <strong>{getDisplayCombinedScore(analysis)}</strong></span>
            <span className="score-inline-chip is-muted">{formatPracticePathLabel(analysis?.recommendedPracticePath)}</span>
          </div>
        </div>
        <div className="score-issue-actions">
          <button type="button" className="secondary-button" onClick={() => window.close()}>关闭</button>
          {score?.sourcePdfPath ? (
            <a className="secondary-link" href={score.sourcePdfPath} target="_blank" rel="noreferrer">打开 PDF</a>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="score-issue-layout">
        <aside className="panel-card score-sidebar">
          {originalAudioSource ? (
            <div className="sidebar-block">
              <p className="sidebar-label">原音</p>
              <audio ref={audioRef} controls preload="metadata" className="audio-player" src={originalAudioSource} />
              {playbackHint ? <p className="sidebar-meta">{playbackHint}</p> : null}
            </div>
          ) : null}

          <div className="sidebar-block">
            <p className="sidebar-label">总体反馈</p>
            <p className="sidebar-text">{summarizeOverallFeedback(visibleAnalysisForSummary)}</p>
            {ambiguousImportedScore ? (
              <p className="sidebar-meta">
                当前谱面只高亮二胡旋律单行。无法确认属于二胡旋律的疑似问题会保留在列表中，并标记为需复核，不再投射到伴奏谱。
              </p>
            ) : null}
            <p className="sidebar-meta">{formatDateTime(analysis?.createdAt || stored?.savedAt)}</p>
          </div>

          <div className="sidebar-block sidebar-issues">
            <p className="sidebar-label">问题列表</p>
            <div className="issue-list-block">
              {issueEntries.map((item, index) => {
                if (item.issueKind === "measure") {
                  return (
                    <button
                      type="button"
                      key={item.issueKey}
                      ref={(element) => setIssueListRef(item.issueKey, element)}
                      className={`issue-list-button${issueToneClass(item.issueTone)}${activeMeasureKey === item.measureKey && !selectedNoteKey ? " is-active" : ""}`}
                      onClick={() => handleMeasureJump(item.measureIndex, item)}
                    >
                      <strong>
                        <span className="issue-number-chip">{item.issueNumber}</span>
                        {formatDisplayMeasureLabel(item.measureIndex, item.displayMeasureIndex)}
                      </strong>
                      <span>
                        {item.label}
                        {item.needsReview ? `，${item.reviewReason || "需复核"}` : ""}
                      </span>
                    </button>
                  );
                }
                const overlayItem = item.overlayItem || null;
                const overlayKey = item.overlayKey || item.listKey || "";
                return (
                  <button
                    type="button"
                    key={`note-${item.noteId || index}-${item.measureIndex}`}
                    ref={(element) => setIssueListRef(overlayKey, element)}
                    className={`issue-list-button${issueToneClass(item.issueTone)}${selectedNoteKey && selectedNoteKey === overlayKey ? " is-active" : ""}`}
                    onClick={() => handleNoteJump(item, overlayItem)}
                  >
                    <strong>
                      <span className="issue-number-chip">{item.issueNumber}</span>
                      {formatDisplayNoteLabel(item.noteId, item.measureIndex, item.displayMeasureIndex, item.noteOrdinal)}
                    </strong>
                    <span>
                      {item.tags.join("、")}
                      {item.needsReview ? `，${item.reviewReason || "需复核"}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="panel-card score-page-panel">
          <div className="score-page-toolbar">
            <span>{sectionDisplayName || "当前段落"}</span>
            <span>第 {currentPage} 页{pageCount > 0 ? ` / ${pageCount}` : ""}</span>
            <span>本页 {currentPageHighlightCount} 个高亮 / 全曲 {issueEntries.length} 个问题</span>
            <span className="issue-color-legend">
              <i className="legend-dot issue-tone-pitch" />音准
              <i className="legend-dot issue-tone-rhythm" />节奏
              <i className="legend-dot issue-tone-both" />二者
            </span>
            {hasImportedScoreSections ? (
              <span className={`issue-line-mode${ambiguousImportedScore ? " is-ambiguous" : ""}`}>
                二胡旋律单行视图
              </span>
            ) : null}
          </div>

          <div className="score-page-nav">
            <button type="button" className="secondary-button" onClick={() => handlePageNavigation(currentPage - 1)} disabled={currentPage <= 1}>
              上一页
            </button>
            <button type="button" className="secondary-button" onClick={() => handlePageNavigation(firstIssuePage)}>
              回到问题页
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => handlePageNavigation(currentPage + 1)}
              disabled={pageCount > 0 && currentPage >= pageCount}
            >
              下一页
            </button>
            <div className="score-zoom-group">
              <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.max(0.75, Number((value - 0.15).toFixed(2))))}>
                缩小
              </button>
              <span className="score-zoom-label">{Math.round(zoom * 100)}%</span>
              <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.min(4, Number((value + 0.15).toFixed(2))))}>
                放大
              </button>
              <button type="button" className="secondary-button" onClick={() => {
                const w = stageSize.width;
                const cw = viewportRef.current?.clientWidth;
                if (w && cw) {
                  setZoom(Math.max(0.75, Math.min(4, parseFloat(((cw - 8) / w).toFixed(2)))));
                } else {
                  setZoom(1.0);
                }
              }}>
                适应宽度
              </button>
            </div>
          </div>

          <div ref={viewportRef} className="score-page-viewport">
            <div
              className={`score-page-stage${melodyBand ? " is-melody-band" : ""}`}
              style={{
                width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                height: displayHeight ? `${displayHeight}px` : undefined,
              }}
            >
              {usePageImage ? (
                <img
                  className={`score-page-image${melodyBand ? " score-page-source-cropped" : ""}`}
                  src={pageImagePath}
                  alt={`score-page-${currentPage}`}
                  onError={() => setPageImageFailed(true)}
                  onLoad={handleImageLoad}
                  style={{
                    width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                    height: effectiveHeight ? `${effectiveHeight}px` : undefined,
                    top: melodyBand ? `${sourceOffsetTop}px` : undefined,
                  }}
                />
              ) : (
                <canvas
                  ref={canvasRef}
                  className={`pdf-preview-canvas${melodyBand ? " score-page-source-cropped" : ""}`}
                  style={{
                    width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                    height: effectiveHeight ? `${effectiveHeight}px` : undefined,
                    top: melodyBand ? `${sourceOffsetTop}px` : undefined,
                  }}
                />
              )}
              <div className="score-measure-overlay" aria-hidden="true">
                {displayOverlayItems.map((item) => (
                  <button
                    type="button"
                    key={`measure-${item.measureKey}`}
                    className={`score-measure-highlight${issueToneClass(item.issueTone)}${activeMeasureKey === item.measureKey ? " is-active" : ""}`}
                    onClick={() => handleMeasureJump(item.measureIndex, item)}
                    style={{
                      left: `${item.left}%`,
                      top: `${item.top}%`,
                      width: `${item.width}%`,
                      height: `${item.height}%`,
                    }}
                  >
                    <span>{measureIssueNumberMap.get(item.measureKey) || item.measureIndex}</span>
                  </button>
                ))}
                {displayNoteOverlayItems
                  .map((item) => {
                    const relatedIssue =
                      noteIssueEntries.find((noteIssue) => String(noteIssue.noteId || "") === String(item.noteId || "") && noteIssue.measureIndex === item.measureIndex && noteIssue.sectionId === item.sectionId)
                      || { noteId: item.noteId, measureIndex: item.measureIndex };
                    return (
                      <button
                        type="button"
                        key={item.key}
                        className={`score-note-highlight${issueToneClass(item.issueTone)}${item.exact ? " is-exact" : ""}${selectedNoteKey === item.key ? " is-selected" : ""}`}
                        style={{ left: `${item.left}%`, top: `${item.top}%` }}
                        onClick={() => handleNoteJump(relatedIssue, item)}
                        aria-label={formatDisplayNoteLabel(
                          item.noteId,
                          item.measureIndex,
                          relatedIssue.displayMeasureIndex || item.displayMeasureIndex,
                          relatedIssue.noteOrdinal || item.noteOrdinal,
                        )}
                      >
                        <span className="score-note-index">{noteIssueNumberMap.get(item.key) || "•"}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
