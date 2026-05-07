import {
  ISSUE_SESSION_STORAGE_PREFIX,
  LEGACY_ISSUE_SESSION_STORAGE_PREFIX,
  extractSectionPageNumber,
  formatPitchLabelText,
  formatRhythmLabelText,
  formatScoreTitle,
  getDisplayPitchScore,
  getDisplayRhythmScore,
} from "../analysisLabels.js";

export const STUDENT_APP_STATE_KEY = "ai-erhu.student-app-state-v6";
export const LEGACY_STUDENT_APP_STATE_KEYS = [
  "ai-erhu.student-app-state-v2",
  "ai-erhu.student-app-state-v3",
  "ai-erhu.student-app-state-v4",
  "ai-erhu.student-app-state-v5",
];

export function formatAnalysisTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

export function getAudioMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder?.isTypeSupported) return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((item) => window.MediaRecorder.isTypeSupported(item)) || "";
}

export function getAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.src = objectUrl;
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      audio.removeAttribute("src");
      audio.load();
    };
    audio.onloadedmetadata = () => {
      const duration = Number(audio.duration);
      cleanup();
      resolve(Number.isFinite(duration) ? duration : null);
    };
    audio.onerror = () => {
      cleanup();
      resolve(null);
    };
  });
}

export function summarizePrimaryFocus(analysis) {
  if (!analysis) return "节奏问题";
  if (analysis.recommendedPracticePath === "pitch-first") return "音准问题";
  if (analysis.recommendedPracticePath === "rhythm-first") return "节奏问题";
  return getDisplayRhythmScore(analysis) <= getDisplayPitchScore(analysis) ? "节奏问题" : "音准问题";
}

export function buildOverallFeedback(analysis) {
  if (!analysis) return "";
  const focus = summarizePrimaryFocus(analysis);
  const noteCount = Array.isArray(analysis.noteFindings) ? analysis.noteFindings.length : Number(analysis?.diagnostics?.noteFindingCount || 0);
  const measureCount = Array.isArray(analysis.measureFindings)
    ? analysis.measureFindings.length
    : Number(analysis?.diagnostics?.measureFindingCount || 0);
  const uncertainCount =
    Number(analysis?.diagnostics?.uncertainPitchCount)
    || (Array.isArray(analysis.noteFindings) ? analysis.noteFindings.filter((item) => item?.isUncertain).length : 0)
    || 0;

  const parts = [
    `本次录音优先需要处理的是${focus}。`,
    `系统共定位到 ${noteCount} 个问题音和 ${measureCount} 个问题小节。`,
  ];
  if (uncertainCount > 0) {
    parts.push(`其中有 ${uncertainCount} 个音的证据偏弱，建议结合示范回放复核。`);
  }
  return parts.join("");
}

export function getAnalysisIssueStats(analysis) {
  const noteFindings = Array.isArray(analysis?.noteFindings) ? analysis.noteFindings : [];
  const measureFindings = Array.isArray(analysis?.measureFindings) ? analysis.measureFindings : [];
  const pitchNoteCount = noteFindings.filter((item) => {
    const pitchLabel = String(item?.pitchLabel || "").trim();
    return pitchLabel && pitchLabel !== "pitch-ok";
  }).length;
  const rhythmNoteCount = noteFindings.filter((item) => item?.rhythmType || item?.rhythmLabel || item?.rhythmTypeLabel).length;
  const pitchMeasureCount = measureFindings.filter((item) => String(item?.issueType || "").startsWith("pitch")).length;
  const rhythmMeasureCount = measureFindings.filter((item) => {
    const issueType = String(item?.issueType || "");
    return issueType.startsWith("rhythm") || Boolean(item?.rhythmType);
  }).length;
  const reviewCount = noteFindings.filter((item) => item?.isUncertain || item?.pitchLabel === "pitch-review").length;
  return {
    noteCount: noteFindings.length,
    measureCount: measureFindings.length,
    pitchIssueCount: pitchNoteCount + pitchMeasureCount,
    rhythmIssueCount: rhythmNoteCount + rhythmMeasureCount,
    reviewCount,
  };
}

export function buildStudentPracticeAdvice(analysis) {
  if (!analysis) return "";
  const stats = getAnalysisIssueStats(analysis);
  if (analysis.recommendedPracticePath === "pitch-first") {
    return `先慢速处理音准落点，再回到原速。当前定位到 ${stats.pitchIssueCount} 处音准相关问题。`;
  }
  if (analysis.recommendedPracticePath === "rhythm-first") {
    return `先用节拍器处理节奏稳定性，再合回音高。当前定位到 ${stats.rhythmIssueCount} 处节奏相关问题。`;
  }
  return "先打开问题谱面复核标记，再选择最明显的一处进行重练。";
}

export function buildTopIssueLine(analysis) {
  const noteFindings = Array.isArray(analysis?.noteFindings) ? analysis.noteFindings : [];
  const pitchIssue = noteFindings.find((item) => item?.pitchLabel && item.pitchLabel !== "pitch-ok");
  const rhythmIssue = noteFindings.find((item) => item?.rhythmType || item?.rhythmLabel || item?.rhythmTypeLabel);
  const labels = [];
  if (pitchIssue) labels.push(formatPitchLabelText(pitchIssue.pitchLabel));
  if (rhythmIssue) labels.push(formatRhythmLabelText(rhythmIssue));
  return labels.length ? labels.join("，") : "暂无明确问题音，建议查看整曲概览。";
}

export function loadPersistedStudentState() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STUDENT_APP_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const restoredScoreId = String(parsed.scoreId || parsed.scoreJob?.scoreId || "").trim();
    const restoredAnalysisScoreId = String(parsed.analysis?.scoreId || parsed.analysis?.pieceId || "").trim();
    const restoredAnalysis =
      restoredScoreId && restoredAnalysisScoreId && restoredAnalysisScoreId !== restoredScoreId
        ? null
        : parsed.analysis || null;
    const restoredPiecePassJob = parsed.piecePassJob?.status === "processing" ? parsed.piecePassJob : null;
    return {
      ...parsed,
      analysis: restoredAnalysis,
      piecePassJob: restoredPiecePassJob,
      piecePassSummary: null,
    };
  } catch {
    return null;
  }
}

export function clearIssueSessionCache(keepKey = "") {
  if (typeof window === "undefined") return;
  const cleanupStorage = (storage) => {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        !key ||
        (!key.startsWith(ISSUE_SESSION_STORAGE_PREFIX) && !key.startsWith(LEGACY_ISSUE_SESSION_STORAGE_PREFIX))
      ) {
        continue;
      }
      if (keepKey && key === keepKey) continue;
      keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  };
  cleanupStorage(window.localStorage);
  cleanupStorage(window.sessionStorage);
}

export function persistStudentState(snapshot) {
  if (typeof window === "undefined") return;
  try {
    LEGACY_STUDENT_APP_STATE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    window.localStorage.setItem(STUDENT_APP_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore quota errors.
  }
}

export function getSectionNoteCount(section) {
  return Array.isArray(section?.notes) ? section.notes.length : Number(section?.noteCount) || 0;
}

export function isLikelyImportedLeadPageSection(section, score) {
  const pageNumber = extractSectionPageNumber(section || {});
  const totalPages =
    Number(score?.omrStats?.pageCount)
    || (Array.isArray(score?.previewPages) ? score.previewPages.length : 0)
    || 0;
  if (totalPages < 4 || pageNumber > 2) return false;
  const noteCount = getSectionNoteCount(section);
  const title = String(section?.title || section?.displayTitle || "");
  const descriptor = `${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${title}`;
  const isAutoPage = /自动识谱第\s*[12]\s*页|page[-\s]?0?[12]\b/i.test(descriptor);
  return isAutoPage && noteCount > 0 && noteCount < 12;
}

export function isImportedFullScoreSection(section) {
  const descriptor = `${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`;
  return /page[-\s]?0*\d+/i.test(descriptor) || /自动识谱第\s*\d+\s*页/i.test(descriptor);
}

export function isErhuMelodySystemIndex(systemIndex) {
  const numeric = Math.round(Number(systemIndex) || 0);
  if (!numeric) return true;
  return (numeric - 1) % 3 === 0;
}

export function isLikelyAccompanimentOnlySection(section) {
  if (!isImportedFullScoreSection(section)) return false;
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  if (!notes.length) return false;
  const notesWithSystem = notes.filter((note) => Number.isFinite(Number(note?.notePosition?.systemIndex)));
  if (!notesWithSystem.length) return false;
  return !notesWithSystem.some((note) => isErhuMelodySystemIndex(note?.notePosition?.systemIndex));
}

export function getStudentVisibleSections(score) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const filtered = sections.filter(
    (section) => !isLikelyImportedLeadPageSection(section, score) && !isLikelyAccompanimentOnlySection(section),
  );
  return filtered.length ? filtered : sections;
}

export function pickVisibleSectionId(score, requestedSectionId) {
  const sections = getStudentVisibleSections(score);
  if (!sections.length) return "";
  if (requestedSectionId && sections.some((item) => item.sectionId === requestedSectionId)) {
    return requestedSectionId;
  }
  return sections[0]?.sectionId || "";
}

export function analysisMatchesScore(analysis, score) {
  if (!analysis || !score) return false;
  const scoreId = String(score.scoreId || "").trim();
  const pieceId = String(score.pieceId || "").trim();
  const analysisScoreId = String(analysis.scoreId || "").trim();
  const analysisPieceId = String(analysis.pieceId || "").trim();
  if (scoreId) {
    if (analysisScoreId || analysisPieceId) {
      return analysisScoreId === scoreId || analysisPieceId === scoreId;
    }
    return false;
  }
  if (pieceId && analysisPieceId && analysisPieceId === pieceId) return true;
  return false;
}

export function jobMatchesScore(job, score) {
  if (!job || !score) return false;
  const scoreId = String(score.scoreId || "").trim();
  const jobScoreId = String(job.scoreId || job.payload?.scoreId || job.wholePieceAnalysis?.scoreId || job.primaryAnalysis?.scoreId || "").trim();
  const jobPieceId = String(job.pieceId || job.payload?.pieceId || job.wholePieceAnalysis?.pieceId || job.primaryAnalysis?.pieceId || "").trim();
  if (scoreId) {
    if (jobScoreId || jobPieceId) return jobScoreId === scoreId || jobPieceId === scoreId;
    return false;
  }
  const pieceTitle = formatScoreTitle(score);
  const jobTitle = String(job.pieceTitle || job.title || job.wholePieceAnalysis?.pieceTitle || "").trim();
  return Boolean(pieceTitle && jobTitle && pieceTitle === jobTitle);
}

export function shouldShowResearchEntry() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("admin") === "1") return true;
  try {
    return window.localStorage.getItem("ai-erhu.show-research-entry") === "1";
  } catch {
    return false;
  }
}
