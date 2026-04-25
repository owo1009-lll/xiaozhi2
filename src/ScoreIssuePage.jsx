import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import {
  extractSectionPageNumber,
  ISSUE_SESSION_SCHEMA_VERSION,
  ISSUE_SESSION_STORAGE_PREFIX,
  formatMeasureLabel,
  formatNoteLabel,
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

const SCORE_ISSUE_LINE_MODE_PREFIX = "ai-erhu.score-issue-line-mode.";
const SCORE_ISSUE_LINE_MODES = new Set(["auto", "safe", "all", "first-of-three", "odd", "first-only"]);

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
  const selected = String(score?.selectedPart || score?.selectedPartId || "").trim().toLowerCase();
  return candidates.find((candidate) => (
    [candidate?.id, candidate?.name, candidate?.label]
      .map((item) => String(item || "").trim().toLowerCase())
      .includes(selected)
  )) || candidates[0] || null;
}

function isExplicitErhuPartCandidate(candidate) {
  const label = `${candidate?.id || ""} ${candidate?.name || ""} ${candidate?.label || ""}`;
  return /\berhu\b|二胡/i.test(label);
}

function isCleanSoloSelectedPart(score) {
  const candidate = getSelectedPartCandidate(score);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return true;
  return !candidate?.isLikelyPiano
    && Number(candidate?.chordRatio || 0) < 0.18
    && Math.max(1, Number(candidate?.staffCount || 1)) <= 1;
}

function isAmbiguousImportedPart(score) {
  const candidate = getSelectedPartCandidate(score);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return false;
  return Boolean(candidate?.isLikelyPiano) || Number(candidate?.chordRatio || 0) >= 0.18;
}

function isErhuMelodySystemIndex(systemIndex, score = null) {
  const numeric = Math.round(Number(systemIndex) || 0);
  if (!numeric) return true;
  const lineMode = getScoreIssueLineMode(score);
  if (lineMode === "all") return true;
  if (lineMode === "first-of-three") return (numeric - 1) % 3 === 0;
  if (lineMode === "odd") return numeric % 2 === 1;
  if (lineMode === "first-only") return numeric === 1;
  if (lineMode === "safe" && isAmbiguousImportedPart(score)) return false;
  if (isCleanSoloSelectedPart(score)) return true;
  if (isAmbiguousImportedPart(score)) return false;
  return (numeric - 1) % 3 === 0;
}

function isErhuMelodyNote(note, section, score = null) {
  const descriptor = `${note?.partName || ""} ${note?.partLabel || ""} ${note?.instrument || ""} ${section?.selectedPart || ""}`;
  if (/\b(piano|pno|accompaniment)\b|钢琴|伴奏/i.test(descriptor)) return false;
  if (!shouldProjectImportedFullScoreSection(section)) return true;
  return isErhuMelodySystemIndex(note?.notePosition?.systemIndex, score);
}

function getErhuMelodyNotes(section, score = null) {
  return (Array.isArray(section?.notes) ? section.notes : []).filter((note) => isErhuMelodyNote(note, section, score));
}

function hasErhuMelodyMeasure(section, measureIndex, score = null) {
  if (!shouldProjectImportedFullScoreSection(section)) return true;
  if (isAmbiguousImportedPart(score)) return true;
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
  if (isAmbiguousImportedPart(score)) return false;
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  if (!notes.length) return false;
  const notesWithSystem = notes.filter((note) => Number.isFinite(Number(note?.notePosition?.systemIndex)));
  if (!notesWithSystem.length) return false;
  return !notesWithSystem.some((note) => isErhuMelodySystemIndex(note?.notePosition?.systemIndex, score));
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
    const exactImportedNote = issueNoteId
      ? notes.find((item) => (
        String(item?.noteId || "") === issueNoteId
        && Number(item?.measureIndex) === measureIndex
        && readNotePosition(item, section, absolutePage)
      ))
      : null;
    if (!exactImportedNote) return null;
    if (getNoteStaffIndex(exactImportedNote) !== targetStaff || !isErhuMelodyNote(exactImportedNote, section, score)) {
      return null;
    }
    return readNotePosition(exactImportedNote, section, absolutePage);
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

function resolveIssueSection(score, fallbackSection, issue) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const requestedId = String(issue?.sectionId || "").trim();
  if (requestedId) {
    const matched = sections.find((item) => String(item?.sectionId || "") === requestedId || String(item?.sourceSectionId || "") === requestedId);
    if (matched) return matched;
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
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
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
      if (!stored?.score?.scoreId || score?.sourcePdfPath) return;
      try {
        const json = await fetchScore(stored.score.scoreId);
        if (cancelled) return;
        const nextScore = json?.score || null;
        setScore(nextScore);
        const nextSection = resolvePreferredSection(nextScore, stored?.section, stored?.analysis);
        setSection(nextSection);
        setCurrentPage(extractSectionPageNumber(nextSection || {}));
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
  }, [score?.sourcePdfPath, stored]);

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
    () => buildMeasureIssues(analysis).filter((item) => {
      const issueSection = resolveIssueSection(score, section, item);
      return !isWholePieceMode || (
        !isLikelyNonScoreLeadPage(issueSection, score)
        && !isLikelyAccompanimentOnlySection(issueSection, projectionScore)
        && hasErhuMelodyMeasure(issueSection, item.measureIndex, projectionScore)
      );
    }),
    [analysis, isWholePieceMode, projectionScore, score, section],
  );
  const noteIssues = useMemo(
    () => buildNoteIssues(analysis).filter((item) => {
      const issueSection = resolveIssueSection(score, section, item);
      return !isWholePieceMode || (
        !isLikelyNonScoreLeadPage(issueSection, score)
        && !isLikelyAccompanimentOnlySection(issueSection, projectionScore)
        && hasErhuMelodyMeasure(issueSection, item.measureIndex, projectionScore)
      );
    }),
    [analysis, isWholePieceMode, projectionScore, score, section],
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
  const issueMeasureIndexes = [...new Set(measureIssues.map((item) => item.measureIndex).concat(noteIssues.map((item) => item.measureIndex)))].sort((left, right) => left - right);
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
            return {
              key: `${issueSectionId}-${item?.noteId || index}-${exact.measureIndex}`,
              sectionId: issueSectionId,
              sectionTitle: formatSectionDisplayName(issueSection),
              noteId: item?.noteId || "",
              measureIndex: exact.measureIndex,
              left: Math.min(Math.max(exact.normalizedX * 100, 0), 100),
              top: Math.min(Math.max(exact.normalizedY * 100, 0), 100),
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
            left: Math.min(measureLeft + slotWidth * relativeStep, 98),
            top: 18 + bandIndex * 18,
            exact: false,
            pageNumber: measurePageMap.get(sectionKey(issueSectionId, measureIndex)) || extractSectionPageNumber(issueSection) || baseSectionPage,
            tags: item?.tags || [],
            issueTone: item?.issueTone || getIssueTone(item?.tags || []),
          };
        })
        .filter(Boolean),
    [baseSectionPage, dominantStaffIndex, measureCount, measurePageMap, noteIssues, projectionScore, score, section],
  );

  const measureIssueEntries = useMemo(
    () =>
      measureIssues.map((item, index) => {
        const issueSection = resolveIssueSection(score, section, item);
        const issueSectionId = String(issueSection?.sectionId || item.sectionId || "");
        return {
          ...item,
          sectionId: issueSectionId,
          sectionTitle: item.sectionTitle || formatSectionDisplayName(issueSection),
          pageNumber: measurePageMap.get(sectionKey(issueSectionId, item.measureIndex)) || extractSectionPageNumber(issueSection),
          measureKey: sectionKey(issueSectionId, item.measureIndex),
          issueKey: `measure-${sectionKey(issueSectionId, item.measureIndex)}`,
          issueNumber: index + 1,
          issueTone: item.issueTone || getIssueTone([item.label]),
        };
      }),
    [measureIssues, measurePageMap, score, section],
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
        return {
          ...item,
          sectionId: issueSectionId,
          sectionTitle: item.sectionTitle || formatSectionDisplayName(issueSection),
          pageNumber: overlayItem?.pageNumber || extractSectionPageNumber(issueSection),
          overlayItem,
          overlayKey,
          issueKey: `note-${overlayKey}`,
          issueNumber: measureIssueEntries.length + index + 1,
          issueTone: item.issueTone || overlayItem?.issueTone || getIssueTone(item.tags || []),
        };
      }),
    [measureIssueEntries.length, noteIssues, noteOverlayItems, score, section],
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
    () => [...new Set(measureIssueEntries.map((item) => item.measureKey))],
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
  const sectionDisplayName = isWholePieceMode ? `${formatScoreTitle(score)} · 整曲问题谱面` : formatSectionDisplayName(section);
  const originalAudioSource = analysis?.originalAudio?.url || analysis?.originalAudioUrl || analysis?.audioUrl || "";

  useEffect(() => {
    if (!originalAudioSource || !audioRef.current) return;
    audioRef.current.load();
  }, [originalAudioSource]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !effectiveWidth || !effectiveHeight) return;
    const focusNote =
      noteOverlayItems.find((item) => item.key === selectedNoteKey && item.pageNumber === currentPage)
      || noteOverlayItems.find((item) => item.pageNumber === currentPage && sectionKey(item.sectionId, item.measureIndex) === activeMeasureKey && item.exact)
      || noteOverlayItems.find((item) => item.pageNumber === currentPage && sectionKey(item.sectionId, item.measureIndex) === activeMeasureKey)
      || null;
    const focusMeasure = overlayItems.find((item) => item.measureKey === activeMeasureKey) || null;
    const focusLeftPercent = focusNote ? focusNote.left : focusMeasure ? focusMeasure.left + focusMeasure.width / 2 : null;
    const focusTopPercent = focusNote ? focusNote.top : focusMeasure ? focusMeasure.top + focusMeasure.height / 2 : null;
    if (focusLeftPercent == null || focusTopPercent == null) return;
    const targetLeft = (focusLeftPercent / 100) * effectiveWidth - viewport.clientWidth / 2;
    const targetTop = (focusTopPercent / 100) * effectiveHeight - viewport.clientHeight / 2;
    viewport.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [activeMeasureKey, currentPage, effectiveHeight, effectiveWidth, noteOverlayItems, overlayItems, selectedNoteKey, zoom]);

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

  function handleMeasureJump(measureIndex, item = null) {
    const key = item?.measureKey || sectionKey(item?.sectionId || resolveIssueSection(score, section, item)?.sectionId, measureIndex);
    setCurrentPage(item?.pageNumber || measurePageMap.get(key) || baseSectionPage);
    setSelectedMeasureIndex(key);
    setSelectedNoteKey("");
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
            </div>
          ) : null}

          <div className="sidebar-block">
            <p className="sidebar-label">总体反馈</p>
            <p className="sidebar-text">{summarizeOverallFeedback(visibleAnalysisForSummary)}</p>
            {ambiguousImportedScore ? (
              <p className="sidebar-meta">
                当前谱面声部识别存在伴奏混入风险。若问题点没有显示在二胡谱行，请在右侧“高亮声部”中切换模式校准。
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
                        {formatMeasureLabel(item.measureIndex)}
                      </strong>
                      <span>{isWholePieceMode ? `${item.sectionTitle || "整曲"} · ` : ""}{item.label}</span>
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
                      {formatNoteLabel(item.noteId, item.measureIndex)}
                    </strong>
                    <span>
                      {isWholePieceMode ? `${item.sectionTitle || "整曲"} · ` : ""}
                      {item.tags.join("、")}
                      {!overlayItem ? "，未定位到可靠二胡音符坐标" : ""}
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
            <span>{issueMeasureIndexes.length} 个问题小节</span>
            <span className="issue-color-legend">
              <i className="legend-dot issue-tone-pitch" />音准
              <i className="legend-dot issue-tone-rhythm" />节奏
              <i className="legend-dot issue-tone-both" />二者
            </span>
            {hasImportedScoreSections ? (
              <label className={`issue-line-mode${ambiguousImportedScore ? " is-ambiguous" : ""}`}>
                <span>高亮声部</span>
                <select value={lineMode} onChange={(event) => setLineMode(event.target.value)}>
                  <option value="auto">自动</option>
                  <option value="safe">安全模式</option>
                  <option value="all">全部 Voice 音符</option>
                  <option value="first-of-three">每组第 1 行</option>
                  <option value="odd">奇数行</option>
                  <option value="first-only">仅第 1 行</option>
                </select>
              </label>
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
              className="score-page-stage"
              style={{
                width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                height: effectiveHeight ? `${effectiveHeight}px` : undefined,
              }}
            >
              {usePageImage ? (
                <img
                  className="score-page-image"
                  src={pageImagePath}
                  alt={`score-page-${currentPage}`}
                  onError={() => setPageImageFailed(true)}
                  onLoad={handleImageLoad}
                  style={{
                    width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                    height: effectiveHeight ? `${effectiveHeight}px` : undefined,
                  }}
                />
              ) : (
                <canvas
                  ref={canvasRef}
                  className="pdf-preview-canvas"
                  style={{
                    width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                    height: effectiveHeight ? `${effectiveHeight}px` : undefined,
                  }}
                />
              )}
              <div className="score-measure-overlay" aria-hidden="true">
                {overlayItems.map((item) => (
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
                {noteOverlayItems
                  .filter((item) => item.pageNumber === currentPage)
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
                        aria-label={formatNoteLabel(item.noteId, item.measureIndex)}
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
