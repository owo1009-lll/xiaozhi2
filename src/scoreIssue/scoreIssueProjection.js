import {
  ISSUE_SESSION_SCHEMA_VERSION,
  ISSUE_SESSION_STORAGE_PREFIX,
  extractSectionPageNumber,
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
} from "../analysisLabels.js";

export function getIssueSessionId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("issueSession") || "";
}

export function attachOriginalAudio(analysis, originalAudio) {
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

export function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function firstOptionalNumber(...values) {
  for (const value of values) {
    const numeric = optionalNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

export function clampNumber(value, min, max) {
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

export function copyIssueTimingFields(item) {
  const timing = {};
  for (const field of ISSUE_TIMING_FIELDS) {
    const numeric = optionalNumber(item?.[field]);
    if (numeric !== null) timing[field] = numeric;
  }
  return timing;
}

export function meterBeatsValue(meter = "4/4") {
  const beats = String(meter || "4/4").split("/")[0];
  const numeric = Number(beats);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 4;
}

export function getSectionSecondsPerBeat(section) {
  const tempo = clampNumber(firstOptionalNumber(section?.tempo, 72), 30, 300) || 72;
  return 60 / tempo;
}

export function getSectionMeasureRange(section) {
  const values = (Array.isArray(section?.notes) ? section.notes : [])
    .map((note) => optionalNumber(note?.measureIndex))
    .filter((value) => value !== null && value > 0);
  if (!values.length) return { min: 1, max: 1 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function findIssueSectionSummary(analysis, issue, section) {
  const sectionId = String(issue?.sectionId || section?.sectionId || "");
  const summaries = Array.isArray(analysis?.sectionSummaries) ? analysis.sectionSummaries : [];
  return summaries.find((item) => String(item?.sectionId || "") === sectionId) || null;
}

export function getIssueAudioWindow(issue, section, analysis) {
  const summary = findIssueSectionSummary(analysis, issue, section);
  const start = firstOptionalNumber(issue?.startSeconds, summary?.startSeconds, 0) ?? 0;
  const end = firstOptionalNumber(issue?.endSeconds, summary?.endSeconds);
  return {
    start: Math.max(0, start),
    end: end !== null && end > start ? end : null,
  };
}

export function estimateIssueTimeSeconds(issue, section, kind, analysis) {
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

export function getIssueDurationSeconds(issue, section, kind) {
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

export function buildIssuePlaybackWindow(issue, section, kind, analysis, audioElement) {
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

export function formatPlaybackSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

const SCORE_ISSUE_LINE_MODE_PREFIX = "ai-erhu.score-issue-line-mode.";
const SCORE_ISSUE_LINE_MODES = new Set(["auto"]);

export function readStoredLineMode(scoreId) {
  if (typeof window === "undefined") return "auto";
  const key = `${SCORE_ISSUE_LINE_MODE_PREFIX}${String(scoreId || "")}`;
  const value = window.localStorage.getItem(key);
  return SCORE_ISSUE_LINE_MODES.has(value) ? value : "auto";
}

export function writeStoredLineMode(scoreId, mode) {
  if (typeof window === "undefined" || !scoreId) return;
  const key = `${SCORE_ISSUE_LINE_MODE_PREFIX}${String(scoreId || "")}`;
  if (!mode || mode === "auto") {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, mode);
}

export function readStoredSession(issueSessionId) {
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

export function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

export function getDerivedPageImagePath(score, pageNumber) {
  const pdfUrl = String(score?.sourcePdfPath || "").trim();
  if (!pdfUrl) return "";
  const match = pdfUrl.match(/^(.*)\/source\.pdf$/i);
  if (!match) return "";
  return `${match[1]}/pagewise/page-${String(Math.max(1, Number(pageNumber) || 1)).padStart(3, "0")}.png`;
}

export function buildImportedPageImagePath(score, section, pageNumber) {
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

export function getAbsoluteIssuePage(section, issue = null) {
  const sectionPage = Number(section?.pageNumber);
  if (Number.isFinite(sectionPage) && sectionPage > 0) return Math.round(sectionPage);
  const extractedPage = extractSectionPageNumber(section || {});
  if (Number.isFinite(extractedPage) && extractedPage > 0) return Math.round(extractedPage);
  const issuePage = Number(issue?.pageNumber);
  if (Number.isFinite(issuePage) && issuePage > 0) return Math.round(issuePage);
  return 1;
}

export function readNotePosition(note, section, pageOverride = 0) {
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

export function getNoteStaffIndex(note) {
  const staffIndex = Number(note?.notePosition?.staffIndex);
  return Number.isFinite(staffIndex) && staffIndex >= 1 ? Math.round(staffIndex) : 1;
}

export function getErhuStaffIndex(section, fallback = 1) {
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

export function getSectionNoteCount(section) {
  return Array.isArray(section?.notes) ? section.notes.length : Number(section?.noteCount) || 0;
}

export function shouldProjectImportedFullScoreSection(section) {
  const descriptor = `${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`;
  return /page[-\s]?0*\d+/i.test(descriptor) || /自动识谱第\s*\d+\s*页/i.test(descriptor);
}

export function getScoreIssueLineMode(score) {
  const mode = String(score?.scoreIssueLineMode || "auto");
  return SCORE_ISSUE_LINE_MODES.has(mode) ? mode : "auto";
}

export function getSelectedPartCandidate(score) {
  const candidates = Array.isArray(score?.partCandidates) ? score.partCandidates : [];
  if (!candidates.length) return null;
  const selected = String(score?.selectedPartId || score?.selectedPart || "").trim().toLowerCase();
  return candidates.find((candidate) => (
    [candidate?.id, candidate?.selectionKey, candidate?.qualifiedLabel, candidate?.name, candidate?.label]
      .map((item) => String(item || "").trim().toLowerCase())
      .includes(selected)
  )) || candidates[0] || null;
}

export function isExplicitErhuPartCandidate(candidate) {
  const label = `${candidate?.id || ""} ${candidate?.name || ""} ${candidate?.label || ""}`;
  return /\berhu\b|二胡/i.test(label);
}

export function hasAccompanimentPartCandidate(score) {
  const candidates = Array.isArray(score?.partCandidates) ? score.partCandidates : [];
  return candidates.some((candidate) => {
    const label = `${candidate?.id || ""} ${candidate?.name || ""} ${candidate?.label || ""}`;
    return /\b(piano|pno|accompaniment)\b|钢琴|伴奏/i.test(label)
      || Boolean(candidate?.isLikelyPiano)
      || Math.max(1, Number(candidate?.staffCount || 1)) >= 2;
  });
}

export function isCleanSoloSelectedPart(score) {
  const candidate = getSelectedPartCandidate(score);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return true;
  if (hasAccompanimentPartCandidate(score)) return false;
  return !candidate?.isLikelyPiano
    && Number(candidate?.chordRatio || 0) < 0.18
    && Math.max(1, Number(candidate?.staffCount || 1)) <= 1;
}

export function getImportedProjectionSource(section, score = null) {
  return Array.isArray(section?.partCandidates) && section.partCandidates.length ? section : score;
}

export function sectionHasConfidentErhuLine(section) {
  const stats = section?.scoreLineStats && typeof section.scoreLineStats === "object" ? section.scoreLineStats : null;
  if (Number(stats?.erhuNoteCount) > 0) return true;
  return (Array.isArray(section?.notes) ? section.notes : []).some((note) => {
    const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
    const confidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
    return role === "erhu" && confidence >= 0.66;
  });
}

export function isAmbiguousImportedPart(score) {
  const candidate = getSelectedPartCandidate(score);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return false;
  return hasAccompanimentPartCandidate(score) || Boolean(candidate?.isLikelyPiano) || Number(candidate?.chordRatio || 0) >= 0.18;
}

export function isBlockedImportedProjection(section, score = null) {
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

export function isErhuMelodySystemIndex(systemIndex, score = null) {
  const numeric = Math.round(Number(systemIndex) || 0);
  if (!numeric) return true;
  if (isCleanSoloSelectedPart(score)) return true;
  if (isAmbiguousImportedPart(score)) return false;
  return (numeric - 1) % 3 === 0;
}

export function isErhuMelodyNote(note, section, score = null) {
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

export function getErhuMelodyNotes(section, score = null) {
  return (Array.isArray(section?.notes) ? section.notes : []).filter((note) => isErhuMelodyNote(note, section, score));
}

export function issueMeasureIndex(issueOrMeasure = 0) {
  if (issueOrMeasure && typeof issueOrMeasure === "object") {
    return Number(issueOrMeasure.measureIndex) || parseXmlNoteId(issueOrMeasure.noteId)?.measureIndex || 1;
  }
  return Number(issueOrMeasure) || 1;
}

export function noteMeasureMatchesIssue(note, issueOrMeasure) {
  const numericMeasure = issueMeasureIndex(issueOrMeasure);
  if (Number(note?.measureIndex) === numericMeasure) return true;
  const position = note?.notePosition || {};
  if (Number(position.localMeasureIndex) === numericMeasure) return true;
  const localNote = parseXmlNoteId(position.localNoteId);
  return Boolean(localNote && localNote.measureIndex === numericMeasure);
}

export function noteIdMatchesIssue(note, issue) {
  const noteId = String(issue?.noteId || "").trim();
  if (!noteId) return true;
  if (String(note?.noteId || "") === noteId) return true;
  const position = note?.notePosition || {};
  return String(position.localNoteId || "") === noteId;
}

export function noteMatchesIssue(note, issue) {
  return noteMeasureMatchesIssue(note, issue) && noteIdMatchesIssue(note, issue);
}

export function hasErhuMelodyMeasure(section, measureIndex, score = null, issue = null) {
  if (!shouldProjectImportedFullScoreSection(section)) return true;
  const target = issue || measureIndex;
  return getErhuMelodyNotes(section, score).some((note) => noteMeasureMatchesIssue(note, target));
}

export function findMatchingErhuMeasureIndex(section, issue, score = null) {
  if (!section) return null;
  const match = getErhuMelodyNotes(section, score).find((note) => noteMeasureMatchesIssue(note, issue));
  const numeric = Number(match?.measureIndex);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

export function getSectionSystemOrder(section, score = null) {
  const systems = new Set();
  for (const note of getErhuMelodyNotes(section, score)) {
    const systemIndex = Number(note?.notePosition?.systemIndex);
    if (Number.isFinite(systemIndex) && systemIndex > 0) systems.add(Math.round(systemIndex));
  }
  return [...systems].sort((left, right) => left - right);
}

export function getSystemMedianY(section, systemIndex, score = null) {
  const values = getErhuMelodyNotes(section, score)
    .filter((note) => Math.round(Number(note?.notePosition?.systemIndex) || 0) === Math.round(Number(systemIndex) || 0))
    .map((note) => Number(note?.notePosition?.normalizedY))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

export function projectImportedFullScorePositionToErhuBand(position, section) {
  return position;
}

export function isLikelyNonScoreLeadPage(section, score) {
  const pageNumber = getAbsoluteIssuePage(section);
  const totalPages = Number(score?.omrStats?.pageCount) || (Array.isArray(score?.previewPages) ? score.previewPages.length : 0);
  if (totalPages < 4 || pageNumber > 2) return false;
  const noteCount = getSectionNoteCount(section);
  const title = String(section?.title || section?.displayTitle || "");
  const isAutoPage = /自动识谱第\s*[12]\s*页|page[-\s]?0?[12]\b/i.test(`${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${title}`);
  return isAutoPage && noteCount > 0 && noteCount < 12;
}

export function isLikelyAccompanimentOnlySection(section, score = null) {
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

export function findErhuNotePosition(section, issue, preferredStaffIndex, score = null) {
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  const targetStaff = Number(preferredStaffIndex) || getErhuStaffIndex(section);
  const melodyNotes = notes.filter((item) => getNoteStaffIndex(item) === targetStaff && isErhuMelodyNote(item, section, score));
  const absolutePage = getAbsoluteIssuePage(section, issue);
  const importedFullScore = shouldProjectImportedFullScoreSection(section);
  const issueNoteId = String(issue?.noteId || "");

  if (importedFullScore) {
    const sameMeasureImported = melodyNotes
      .filter((item) => noteMeasureMatchesIssue(item, issue) && readNotePosition(item, section, absolutePage))
      .sort((left, right) => {
        const beatDelta = Number(left?.beatStart || 0) - Number(right?.beatStart || 0);
        if (Math.abs(beatDelta) > 0.0001) return beatDelta;
        return Number(left?.notePosition?.normalizedX || 0) - Number(right?.notePosition?.normalizedX || 0);
      });

    const exactImportedNote = issueNoteId
      ? sameMeasureImported.find((item) => noteIdMatchesIssue(item, issue))
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
    .filter((item) => noteMeasureMatchesIssue(item, issue) && readNotePosition(item, section, absolutePage))
    .sort((left, right) => {
      const beatDelta = Number(left?.beatStart || 0) - Number(right?.beatStart || 0);
      if (Math.abs(beatDelta) > 0.0001) return beatDelta;
      return Number(left?.notePosition?.normalizedX || 0) - Number(right?.notePosition?.normalizedX || 0);
    });

  const exact = sameMeasure.find((item) => noteIdMatchesIssue(item, issue));
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

export function hasExactErhuIssueNote(section, issue, preferredStaffIndex, score = null) {
  if (!shouldProjectImportedFullScoreSection(section)) return true;
  return Boolean(findErhuNotePosition(section, issue, preferredStaffIndex, score));
}

export function summarizeOverallFeedback(analysis) {
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

export function buildMeasureIssues(analysis) {
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

export function buildNoteIssues(analysis) {
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

export function getIssueTone(labels = []) {
  const text = labels.join(" ");
  const hasPitch = /音准|pitch/i.test(text);
  const hasRhythm = /节奏|rhythm/i.test(text);
  if (hasPitch && hasRhythm) return "both";
  if (hasPitch) return "pitch";
  if (hasRhythm) return "rhythm";
  return "review";
}

export function mergeIssueTones(tones = []) {
  const cleaned = tones.filter(Boolean);
  if (!cleaned.length) return "review";
  if (cleaned.includes("both")) return "both";
  if (cleaned.includes("pitch") && cleaned.includes("rhythm")) return "both";
  return cleaned[0] || "review";
}

export function issueToneClass(tone) {
  if (tone === "pitch") return " issue-tone-pitch";
  if (tone === "rhythm") return " issue-tone-rhythm";
  if (tone === "both") return " issue-tone-both";
  return " issue-tone-review";
}

export function clampPercent(value, min = 0, max = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

export function buildMelodyBand({ currentPage, effectiveSections, noteOverlayItems, overlayItems, selectedNoteKey, activeMeasureKey, score }) {
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

export function mapPercentToMelodyBand(value, band) {
  if (!band) return value;
  return ((Number(value) - band.top) / Math.max(1, band.height)) * 100;
}

export function mapOverlayToMelodyBand(item, band) {
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

export function mapNoteToMelodyBand(item, band) {
  if (!band) return item;
  const top = mapPercentToMelodyBand(item.top, band);
  if (top < -2 || top > 102) return null;
  return {
    ...item,
    top: clampPercent(top, -4, 104),
  };
}


export function getDominantStaffIndex(section) {
  return getErhuStaffIndex(section, 1);
}

export function sectionKey(sectionId, measureIndex) {
  return `${String(sectionId || "section")}::${Number(measureIndex) || 1}`;
}

export function getIssueNoteOrdinal(noteId, fallbackOrder = 0) {
  const parsed = parseXmlNoteId(noteId);
  if (parsed?.noteIndex) return parsed.noteIndex;
  const numeric = Number(fallbackOrder);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

export function formatDisplayMeasureLabel(measureIndex, displayMeasureIndex = null) {
  const display = Number(displayMeasureIndex);
  if (Number.isFinite(display) && display > 0) return `第 ${Math.round(display)} 小节`;
  const fallback = Number(measureIndex);
  if (Number.isFinite(fallback) && fallback > 0) return `第 ${Math.round(fallback)} 小节`;
  return "未定位小节";
}

export function formatDisplayNoteLabel(noteId, measureIndex, displayMeasureIndex = null, fallbackOrder = 0) {
  const noteOrdinal = getIssueNoteOrdinal(noteId, fallbackOrder);
  const measureLabel = formatDisplayMeasureLabel(measureIndex, displayMeasureIndex);
  return noteOrdinal ? `${measureLabel}第 ${noteOrdinal} 音` : measureLabel;
}

export function getSectionMeasureValues(section, score = null) {
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

export function shouldUseRawMusicXmlMeasureNumbers(sections, score = null) {
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

export function buildDisplayMeasureLookup(score, sections, projectionScore = null) {
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

export function resolveIssueSection(score, fallbackSection, issue) {
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
            hasErhuMelodyMeasure(matched, measureIndex, score, issue) &&
            (!noteId || (matched.notes || []).some((note) => (
              noteMatchesIssue(note, issue) &&
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
          if (Number.isFinite(measureIndex) && !noteMeasureMatchesIssue(note, issue)) return false;
          if (noteId && !noteIdMatchesIssue(note, issue)) return false;
          return isErhuMelodyNote(note, candidate, score);
        });
      });
      if (exactErhuSection) return exactErhuSection;
      const measureErhuSection = pageSections.find((candidate) => (
        Number.isFinite(measureIndex)
        && hasErhuMelodyMeasure(candidate, measureIndex, score, issue)
      ));
      if (measureErhuSection) return measureErhuSection;
    }
    const erhuPageSection = pageSections.find((candidate) => getErhuMelodyNotes(candidate, score).length > 0);
    if (erhuPageSection) return erhuPageSection;
  }
  return fallbackSection || sections[0] || null;
}

export function resolvePreferredSection(score, fallbackSection, analysis) {
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
