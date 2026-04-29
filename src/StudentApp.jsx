import { useEffect, useMemo, useRef, useState } from "react";
import { playReferenceNotes, unlockAudio } from "./audioSynth";
import {
  buildIssueSessionPayload,
  clampScore,
  extractSectionPageNumber,
  ISSUE_SESSION_SCHEMA_VERSION,
  ISSUE_SESSION_STORAGE_PREFIX,
  LEGACY_ISSUE_SESSION_STORAGE_PREFIX,
  formatScoreTitle,
  formatPracticePathLabel,
  formatSectionDisplayName,
  formatPitchLabelText,
  formatRhythmLabelText,
  getDisplayCombinedScore,
  getDisplayPitchScore,
  getDisplayRhythmScore,
} from "./analysisLabels.js";
import {
  createAnalysisJob,
  createPiecePassJob,
  fetchAnalysisJob,
  fetchAnalyzerStatus,
  fetchLatestPiecePassSummary,
  fetchParticipant,
  fetchPiecePassJob,
  fetchScore,
  fetchScoreImportJob,
  importScoreMusicXml,
  importScorePdf,
  selectScorePart,
} from "./researchApi";

const STUDENT_APP_STATE_KEY = "ai-erhu.student-app-state-v6";
const LEGACY_STUDENT_APP_STATE_KEYS = [
  "ai-erhu.student-app-state-v2",
  "ai-erhu.student-app-state-v3",
  "ai-erhu.student-app-state-v4",
  "ai-erhu.student-app-state-v5",
];

function percentText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : "0%";
}

function scoreImportQualityText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "未开始";
  if (numeric >= 0.85) return "较好";
  if (numeric >= 0.65) return "可用，建议复核";
  return "需复核";
}

function getPartCandidates(job, score) {
  return (Array.isArray(job?.partCandidates) && job.partCandidates.length ? job.partCandidates : score?.partCandidates || [])
    .filter(Boolean);
}

function getPartCandidateKey(candidate, index = 0) {
  return String(candidate?.selectionKey || candidate?.id || candidate?.qualifiedLabel || candidate?.label || candidate?.name || `part-${index + 1}`);
}

function getSelectedPartKey(job, score) {
  return String(job?.selectedPartId || job?.selectedPart || score?.selectedPartId || score?.selectedPart || "");
}

function getSelectedPartConfidence(job, score) {
  if (hasReliableErhuLineSplit(score)) {
    const scoreConfidence = Number(score?.selectedPartConfidence);
    const jobConfidence = Number(job?.selectedPartConfidence);
    const bestKnown = Math.max(
      Number.isFinite(scoreConfidence) ? scoreConfidence : 0,
      Number.isFinite(jobConfidence) ? jobConfidence : 0,
    );
    return Math.max(bestKnown, 0.82);
  }
  const numeric = Number(job?.selectedPartConfidence ?? score?.selectedPartConfidence);
  return Number.isFinite(numeric) ? numeric : 0;
}

function hasReliableErhuLineSplit(score) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  if (!sections.length) return false;
  let erhuNotes = 0;
  let roleTaggedNotes = 0;
  let sectionsWithErhu = 0;
  for (const section of sections) {
    let sectionErhuNotes = 0;
    for (const note of Array.isArray(section?.notes) ? section.notes : []) {
      const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
      const confidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
      if (role) roleTaggedNotes += 1;
      if (role === "erhu" && confidence >= 0.66) {
        erhuNotes += 1;
        sectionErhuNotes += 1;
      }
    }
    if (sectionErhuNotes > 0) sectionsWithErhu += 1;
  }
  return erhuNotes >= 12 && sectionsWithErhu >= 2 && roleTaggedNotes >= erhuNotes;
}

function isAccompanimentCandidate(candidate) {
  const label = String(candidate?.label || candidate?.name || candidate?.role || "").toLowerCase();
  return /piano|pno|pn\.|伴奏|钢琴|accompaniment/.test(label);
}

function needsPartReview(job, score) {
  if ((job?.omrStatus || score?.omrStatus) !== "completed") return false;
  if (job?.selectedPartConfirmed || score?.selectedPartConfirmed) return false;
  if (hasReliableErhuLineSplit(score)) return false;
  const candidates = getPartCandidates(job, score);
  if (candidates.length <= 1) return false;
  return getSelectedPartConfidence(job, score) > 0 && getSelectedPartConfidence(job, score) < 0.7;
}

function formatPartCandidateLabel(candidate, index = 0) {
  const noteCount = Number(candidate?.noteCount);
  const measureCount = Number(candidate?.measureCount);
  const isAccompaniment = isAccompanimentCandidate(candidate);
  const details = [];
  if (Number.isFinite(noteCount)) details.push(`${noteCount} 个音`);
  if (Number.isFinite(measureCount)) details.push(`${measureCount} 小节`);
  const prefix = isAccompaniment ? `伴奏行 ${index + 1}（通常不要选）` : `旋律行 ${index + 1}`;
  return `${prefix}${details.length ? `：${details.join("，")}` : ""}`;
}

function importProgressHeadline(job) {
  if (job?.cacheHit) return "已复用上次识谱结果";
  if (job?.omrStatus === "failed") return "识谱失败";
  if (job?.omrStatus === "completed") return "识谱完成";
  if (job?.stage === "omr-running") return "正在识谱";
  if (job?.stage === "building-piecepack") return "正在整理段落";
  return "识谱排队中";
}

function buildImportStatusMessage(job) {
  if (!job) return "先导入 PDF 曲谱，再选择段落并上传音频。";
  if (job.cacheHit) return "同一份 PDF 已完成过识谱，可以直接选择段落。";
  if (job.omrStatus === "completed") return "识谱完成，可以开始选择段落。";
  if (job.omrStatus === "failed") return job.error || "自动识谱失败，请更换 PDF 或稍后重试。";
  return job.message || `识谱进行中：${percentText(job.progress)}`;
}

function analysisProgressHeadline(job) {
  if (job?.status === "failed") return "分析失败";
  if (job?.status === "completed") return "分析完成";
  if (job?.stage === "loading-score") return "正在读取曲谱";
  if (job?.stage === "detecting-section") return "正在定位段落";
  if (job?.stage === "analyzing") return "正在分析音频";
  if (job?.stage === "saving") return "正在保存结果";
  return "分析排队中";
}

function buildAnalysisStatusMessage(job) {
  if (!job) return "";
  if (job?.status === "failed") return job.error || "分析失败，请稍后重试。";
  if (job?.status === "completed") return "诊断完成，可以打开问题谱面页。";
  return job?.message || `分析进行中：${percentText(job?.progress)}`;
}

function piecePassProgressHeadline(job) {
  if (job?.status === "failed") return "整曲分析失败";
  if (job?.status === "completed") return "整曲分析完成";
  if (job?.stage === "scanning-sections") return "正在扫描整曲段落";
  if (job?.stage === "analyzing-sections") return "正在分析整曲段落";
  if (job?.stage === "writing-results") return "正在写入整曲结果";
  if (job?.stage === "checking-services") return "正在准备整曲分析";
  return "整曲分析排队中";
}

function getPiecePassCompletionState(summary = {}) {
  const attempted = Math.max(0, Math.round(Number(summary?.attemptedSectionCount) || 0));
  const matched = Math.max(0, Math.round(Number(summary?.matchedSectionCount) || 0));
  const failed = Math.max(0, Math.round(Number(summary?.failedSectionCount) || 0));
  const timedOut = Math.max(0, Math.round(Number(summary?.timedOutSectionCount) || 0));
  const complete = matched > 0 && failed === 0 && timedOut === 0 && (!attempted || matched >= attempted);
  return { attempted, matched, failed, timedOut, complete };
}

function buildIncompletePiecePassMessage(summary = {}) {
  const state = getPiecePassCompletionState(summary);
  const total = state.attempted || Number(summary?.structuredSectionCount) || 0;
  const failed = Math.max(state.failed, state.timedOut);
  return `整曲分析未完成：已完成 ${state.matched}/${total || "?"} 段，失败或超时 ${failed} 段。当前问题谱会漏报，已阻止作为正式结果打开。`;
}

function buildPiecePassStatusMessage(job) {
  if (!job) return "";
  if (job?.status === "failed") return job.error || "整曲分析失败，请稍后重试。";
  if (job?.status === "completed") {
    const summary = job?.summary || {};
    if (summary?.analysisReliable === false || !getPiecePassCompletionState(summary).complete) {
      return buildIncompletePiecePassMessage(summary);
    }
    return "整曲分析完成，已更新整曲概览。";
  }
  if (job?.stage === "checking-services") return "正在检查整曲分析服务。";
  if (job?.stage === "scanning-sections") return "正在扫描整曲段落。";
  if (job?.stage === "analyzing-sections") return "正在分析整曲段落。";
  if (job?.stage === "writing-results") return "正在写入整曲分析结果。";
  return "整曲分析进行中。";
}

function buildPiecePassProgressDetailText(job) {
  const detail = job?.progressDetail;
  const total = Math.max(0, Math.round(Number(detail?.totalSections) || 0));
  if (!total) return "";
  const completed = Math.max(
    0,
    Math.round(Number(detail?.completedSections || detail?.currentSection) || 0),
  );
  const failed = Math.max(0, Math.round(Number(detail?.failedSections) || 0));
  const cacheHits = Math.max(0, Math.round(Number(detail?.cacheHits) || 0));
  const remaining = Math.max(0, total - completed);
  const parts = [`已完成 ${Math.min(completed, total)} / ${total} 个段落`];
  if (detail?.currentSectionTitle) parts.push(`当前段落：${detail.currentSectionTitle}`);
  if (job?.status === "processing" && remaining > 0) parts.push(`剩余 ${remaining} 段`);
  if (cacheHits > 0) parts.push(`快速复用 ${cacheHits} 段`);
  if (failed > 0) parts.push(`失败 ${failed} 段`);
  return parts.join("，");
}

function formatDurationMs(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  if (!ms) return "";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}

function buildPiecePassTimingText(job) {
  const timing = job?.timing || {};
  const parts = [];
  const elapsed = formatDurationMs(timing.elapsedMs);
  const remaining = formatDurationMs(timing.estimatedRemainingMs);
  if (elapsed) parts.push(`已用时：${elapsed}`);
  if (job?.status === "processing" && remaining) parts.push(`预计剩余：${remaining}`);
  if (timing.slowNoProgress) parts.push("当前阶段超过 2 分钟没有新进度，系统仍在等待模型返回。");
  return parts.join("，");
}

function formatAnalysisTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

function getAudioMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder?.isTypeSupported) return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((item) => window.MediaRecorder.isTypeSupported(item)) || "";
}

function getAudioDuration(file) {
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

function MetricCard({ label, value, suffix = "" }) {
  const numeric = Number(value);
  const displayValue = Number.isFinite(numeric) ? `${clampScore(numeric)}${suffix}` : String(value || "--");
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong>{displayValue}</strong>
    </div>
  );
}

function StepTitle({ step, title, description }) {
  return (
    <div className="section-title">
      <span className="section-step">{step}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

function summarizePrimaryFocus(analysis) {
  if (!analysis) return "节奏问题";
  if (analysis.recommendedPracticePath === "pitch-first") return "音准问题";
  if (analysis.recommendedPracticePath === "rhythm-first") return "节奏问题";
  return getDisplayRhythmScore(analysis) <= getDisplayPitchScore(analysis) ? "节奏问题" : "音准问题";
}

function buildOverallFeedback(analysis) {
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

function getAnalysisIssueStats(analysis) {
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

function buildStudentPracticeAdvice(analysis) {
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

function buildTopIssueLine(analysis) {
  const noteFindings = Array.isArray(analysis?.noteFindings) ? analysis.noteFindings : [];
  const pitchIssue = noteFindings.find((item) => item?.pitchLabel && item.pitchLabel !== "pitch-ok");
  const rhythmIssue = noteFindings.find((item) => item?.rhythmType || item?.rhythmLabel || item?.rhythmTypeLabel);
  const labels = [];
  if (pitchIssue) labels.push(formatPitchLabelText(pitchIssue.pitchLabel));
  if (rhythmIssue) labels.push(formatRhythmLabelText(rhythmIssue));
  return labels.length ? labels.join("，") : "暂无明确问题音，建议查看整曲概览。";
}

function loadPersistedStudentState() {
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

function clearIssueSessionCache(keepKey = "") {
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

function persistStudentState(snapshot) {
  if (typeof window === "undefined") return;
  try {
    LEGACY_STUDENT_APP_STATE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    window.localStorage.setItem(STUDENT_APP_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore quota errors
  }
}

function pickSectionId(score, requestedSectionId) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  if (!sections.length) return "";
  if (requestedSectionId && sections.some((item) => item.sectionId === requestedSectionId)) {
    return requestedSectionId;
  }
  return sections[0].sectionId || "";
}

function getSectionNoteCount(section) {
  return Array.isArray(section?.notes) ? section.notes.length : Number(section?.noteCount) || 0;
}

function isLikelyImportedLeadPageSection(section, score) {
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

function isImportedFullScoreSection(section) {
  const descriptor = `${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`;
  return /page[-\s]?0*\d+/i.test(descriptor) || /自动识谱第\s*\d+\s*页/i.test(descriptor);
}

function isErhuMelodySystemIndex(systemIndex) {
  const numeric = Math.round(Number(systemIndex) || 0);
  if (!numeric) return true;
  return (numeric - 1) % 3 === 0;
}

function isLikelyAccompanimentOnlySection(section) {
  if (!isImportedFullScoreSection(section)) return false;
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  if (!notes.length) return false;
  const notesWithSystem = notes.filter((note) => Number.isFinite(Number(note?.notePosition?.systemIndex)));
  if (!notesWithSystem.length) return false;
  return !notesWithSystem.some((note) => isErhuMelodySystemIndex(note?.notePosition?.systemIndex));
}

function getStudentVisibleSections(score) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const filtered = sections.filter(
    (section) => !isLikelyImportedLeadPageSection(section, score) && !isLikelyAccompanimentOnlySection(section),
  );
  return filtered.length ? filtered : sections;
}

function pickVisibleSectionId(score, requestedSectionId) {
  const sections = getStudentVisibleSections(score);
  if (!sections.length) return "";
  if (requestedSectionId && sections.some((item) => item.sectionId === requestedSectionId)) {
    return requestedSectionId;
  }
  return sections[0]?.sectionId || "";
}

function analysisMatchesScore(analysis, score) {
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

function jobMatchesScore(job, score) {
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

export default function StudentApp({ onOpenResearch }) {
  const restoredStateRef = useRef(loadPersistedStudentState());
  const stopDemoRef = useRef(() => {});
  const scoreFileInputRef = useRef(null);
  const scoreMusicXmlInputRef = useRef(null);
  const audioFileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const [studentId, setStudentId] = useState(restoredStateRef.current?.studentId || "");
  const [scorePdfFile, setScorePdfFile] = useState(null);
  const [scoreMusicXmlFile, setScoreMusicXmlFile] = useState(null);
  const [scoreJob, setScoreJob] = useState(restoredStateRef.current?.scoreJob || null);
  const [analysisJob, setAnalysisJob] = useState(restoredStateRef.current?.analysisJob || null);
  const [piecePassJob, setPiecePassJob] = useState(restoredStateRef.current?.piecePassJob || null);
  const [score, setScore] = useState(null);
  const [selectedSectionId, setSelectedSectionId] = useState(restoredStateRef.current?.selectedSectionId || "");
  const [audioFile, setAudioFile] = useState(null);
  const [audioDuration, setAudioDuration] = useState(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState("");
  const [analysis, setAnalysis] = useState(restoredStateRef.current?.analysis || null);
  const [participantSnapshot, setParticipantSnapshot] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [excludedAnalysisIds, setExcludedAnalysisIds] = useState(() => new Set());
  const [piecePassSummary, setPiecePassSummary] = useState(restoredStateRef.current?.piecePassSummary || null);
  const [piecePassLoading, setPiecePassLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState(restoredStateRef.current?.statusMessage || "先导入 PDF 曲谱，再选择段落并上传音频。");
  const [errorMessage, setErrorMessage] = useState("");
  const [importingScore, setImportingScore] = useState(false);
  const [selectingPart, setSelectingPart] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [piecePassRunning, setPiecePassRunning] = useState(false);
  const [recording, setRecording] = useState(false);
  const [separationMode, setSeparationMode] = useState(restoredStateRef.current?.separationMode || "auto");
  const [analyzerStatus, setAnalyzerStatus] = useState(null);

  useEffect(() => {
    if (studentId.trim()) {
      window.localStorage.setItem("ai-erhu.student-id", studentId.trim());
      return;
    }
    const cachedStudentId = window.localStorage.getItem("ai-erhu.student-id");
    if (cachedStudentId) {
      setStudentId(cachedStudentId);
      return;
    }
    const generated = `student-${Date.now().toString(36)}`;
    setStudentId(generated);
    window.localStorage.setItem("ai-erhu.student-id", generated);
  }, [studentId]);

  useEffect(() => {
    persistStudentState({
      studentId,
      scoreId: score?.scoreId || scoreJob?.scoreId || "",
      scoreJob,
      selectedSectionId,
      analysisJob,
      analysis,
      piecePassJob: piecePassJob?.status === "processing" ? piecePassJob : null,
      piecePassSummary: null,
      separationMode,
      statusMessage,
    });
  }, [studentId, score?.scoreId, scoreJob, selectedSectionId, analysisJob, analysis, piecePassJob, piecePassSummary, separationMode, statusMessage]);

  useEffect(() => {
    fetchAnalyzerStatus()
      .then((json) => setAnalyzerStatus(json?.analyzer || null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const restored = restoredStateRef.current;
    const restoredScoreId = restored?.scoreId || restored?.scoreJob?.scoreId || "";
    if (!restoredScoreId || score?.scoreId === restoredScoreId) return;
    let cancelled = false;
    fetchScore(restoredScoreId)
      .then((json) => {
        if (cancelled) return;
        const nextScore = json?.score || null;
        setScore(nextScore);
        setSelectedSectionId((current) => pickVisibleSectionId(nextScore, current || restored?.selectedSectionId));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [score?.scoreId]);

  useEffect(() => {
    if (!scoreJob?.jobId || scoreJob?.omrStatus !== "processing") return undefined;
    let cancelled = false;
    let retryCount = 0;

    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (cancelled) return;
        try {
          const refresh = await fetchScoreImportJob(scoreJob.jobId);
          const nextJob = refresh?.job || null;
          if (!nextJob) continue;
          retryCount = 0;
          if (cancelled) return;
          setScoreJob(nextJob);
          setStatusMessage(buildImportStatusMessage(nextJob));
          if (nextJob?.omrStatus !== "processing") return;
        } catch (error) {
          const message = String(error?.message || "");
          if (message.includes("score import job not found")) {
            retryCount += 1;
            if (retryCount <= 5) continue;
            setScoreJob(null);
            setImportingScore(false);
            setStatusMessage("当前识谱任务已失效，请重新导入 PDF。");
            setErrorMessage("识谱任务已失效，请重新导入 PDF。");
            return;
          }
          if (!cancelled) {
            setImportingScore(false);
            setErrorMessage(error.message || "读取识谱进度失败。");
          }
          return;
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [scoreJob?.jobId, scoreJob?.omrStatus]);

  useEffect(() => {
    if (!analysisJob?.jobId || analysisJob?.status !== "processing") return undefined;
    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (cancelled) return;
        try {
          const refresh = await fetchAnalysisJob(analysisJob.jobId);
          const nextJob = refresh?.job || null;
          if (!nextJob) continue;
          if (cancelled) return;
          setAnalysisJob(nextJob);
          setStatusMessage(buildAnalysisStatusMessage(nextJob));
          if (nextJob?.status === "completed") {
            if (nextJob.analysis) {
              if (analysisMatchesScore(nextJob.analysis, score)) {
                setAnalysis(nextJob.analysis);
                if (nextJob.analysis?.sectionId) {
                  setSelectedSectionId(pickVisibleSectionId(score, nextJob.analysis.sectionId));
                }
              } else {
                setAnalysis(null);
                setAnalysisJob(null);
                clearIssueSessionCache();
                setErrorMessage("分析结果与当前曲谱不一致，已阻止打开旧结果。请重新分析当前曲目。");
              }
            }
            if (nextJob.participantId) {
              await refreshParticipantSnapshot(nextJob.participantId);
            }
            setAnalyzing(false);
            return;
          }
          if (nextJob?.status === "failed") {
            setErrorMessage(nextJob.error || "分析失败。");
            setAnalyzing(false);
            return;
          }
        } catch (error) {
          if (cancelled) return;
          const message = String(error?.message || "");
          if (message.includes("analysis job not found")) {
            setAnalysisJob(null);
            setStatusMessage("当前分析任务已失效，请重新上传音频并开始诊断。");
            setErrorMessage("分析任务已失效，请重新开始诊断。");
          } else {
            setErrorMessage(error.message || "读取分析进度失败。");
          }
          setAnalyzing(false);
          return;
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [analysisJob?.jobId, analysisJob?.status, score]);

  useEffect(() => {
    if (!piecePassJob?.jobId || piecePassJob?.status !== "processing") return undefined;
    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (cancelled) return;
        try {
          const refresh = await fetchPiecePassJob(piecePassJob.jobId);
          const nextJob = refresh?.job || null;
          if (!nextJob) continue;
          if (cancelled) return;
          setPiecePassJob(nextJob);
          setStatusMessage(buildPiecePassStatusMessage(nextJob));
          if (nextJob?.status === "completed") {
            if (!jobMatchesScore(nextJob, score)) {
              setPiecePassJob(null);
              setPiecePassSummary(null);
              setPiecePassRunning(false);
              setErrorMessage("整曲分析结果与当前曲谱不一致，已阻止打开旧结果。请重新运行当前曲目的整曲分析。");
              return;
            }
            setPiecePassSummary((current) => ({
              ...(current || {}),
              summary: nextJob.summary || current?.summary || null,
              updatedAt: nextJob.updatedAt,
            }));
            const completionState = getPiecePassCompletionState(nextJob.summary || {});
            if (nextJob.summary?.analysisReliable === false || !completionState.complete) {
              setAnalysis(null);
              setErrorMessage(buildIncompletePiecePassMessage(nextJob.summary || {}));
              setPiecePassRunning(false);
              return;
            }
            const completedAnalysis = nextJob.wholePieceAnalysis || nextJob.primaryAnalysis || null;
            if (completedAnalysis) {
              if (analysisMatchesScore(completedAnalysis, score)) {
                setAnalysis(completedAnalysis);
              } else {
                setAnalysis(null);
                setErrorMessage("整曲分析结果与当前曲谱不一致，已阻止打开旧结果。请重新运行当前曲目的整曲分析。");
              }
              if (completedAnalysis.sectionId) {
                setSelectedSectionId(pickVisibleSectionId(score, completedAnalysis.sectionId));
              }
            }
            setPiecePassRunning(false);
            return;
          }
          if (nextJob?.status === "failed") {
            setErrorMessage(nextJob.error || "整曲分析失败。");
            setPiecePassRunning(false);
            return;
          }
        } catch (error) {
          if (cancelled) return;
          const message = String(error?.message || "");
          if (message.includes("piece-pass job not found")) {
            setPiecePassJob(null);
            setStatusMessage("当前整曲分析任务已失效，请重新运行整曲分析。");
            setErrorMessage("整曲分析任务已失效，请重新运行整曲分析。");
          } else {
            setErrorMessage(error.message || "读取整曲分析进度失败。");
          }
          setPiecePassRunning(false);
          return;
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [piecePassJob?.jobId, piecePassJob?.status, score]);

  useEffect(() => {
    if (!scoreJob?.scoreId || scoreJob?.omrStatus !== "completed") return undefined;
    let cancelled = false;
    const loadImportedScore = async () => {
      try {
        const scoreJson = await fetchScore(scoreJob.scoreId);
        if (cancelled) return;
        const nextScore = scoreJson?.score || null;
        setScore(nextScore);
        setSelectedSectionId(pickVisibleSectionId(nextScore, ""));
        setAnalysis(null);
        setAnalysisJob(null);
        setPiecePassJob(null);
        setPiecePassSummary(null);
        clearIssueSessionCache();
        setStatusMessage(buildImportStatusMessage(scoreJob));
      } catch {
        if (!cancelled) {
          setStatusMessage("识谱完成，但曲谱加载失败，请稍后重试。");
        }
      } finally {
        if (!cancelled) {
          setImportingScore(false);
        }
      }
    };
    void loadImportedScore();
    return () => {
      cancelled = true;
    };
  }, [scoreJob?.scoreId, scoreJob?.omrStatus]);

  useEffect(() => {
    if (scoreJob?.omrStatus !== "failed") return undefined;
    setImportingScore(false);
    setErrorMessage(scoreJob?.error || "自动识谱失败。");
    setStatusMessage(buildImportStatusMessage(scoreJob));
    return undefined;
  }, [scoreJob?.error, scoreJob?.omrStatus]);

  useEffect(() => {
    LEGACY_STUDENT_APP_STATE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    clearIssueSessionCache();
  }, []);

  useEffect(() => {
    if (!studentId.trim()) return;
    void refreshParticipantSnapshot(studentId.trim());
  }, [studentId, score?.scoreId, score?.pieceId]);

  useEffect(() => {
    if (!audioFile) {
      setAudioPreviewUrl("");
      return undefined;
    }
    const objectUrl = URL.createObjectURL(audioFile);
    setAudioPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [audioFile]);

  useEffect(
    () => () => {
      try {
        stopDemoRef.current?.();
      } catch {
        // noop
      }
    },
    [],
  );

  useEffect(() => {
    const currentAudioHash = piecePassJob?.audioHash || piecePassSummary?.summary?.audioHash || "";
    if (!score || !currentAudioHash) {
      setPiecePassSummary(null);
      return undefined;
    }

    let disposed = false;
    setPiecePassLoading(true);
    fetchLatestPiecePassSummary({
      scoreId: score.scoreId,
      pieceId: score.pieceId,
      title: score.scoreId ? "" : formatScoreTitle(score),
      audioHash: currentAudioHash,
      participantId: studentId.trim(),
    })
      .then((json) => {
        if (!disposed) {
          setPiecePassSummary(json?.piecePass || null);
        }
      })
      .catch(() => {
        if (!disposed) setPiecePassSummary(null);
      })
      .finally(() => {
        if (!disposed) setPiecePassLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [piecePassJob?.audioHash, piecePassSummary?.summary?.audioHash, score?.scoreId, score?.pieceId, score?.title, studentId]);

  const visibleSections = useMemo(() => getStudentVisibleSections(score), [score]);
  const partCandidates = useMemo(() => getPartCandidates(scoreJob, score), [score, scoreJob]);
  const selectedPartKey = getSelectedPartKey(scoreJob, score);
  const selectedPartOptionValue = partCandidates.some((candidate, index) => getPartCandidateKey(candidate, index) === selectedPartKey)
    ? selectedPartKey
    : getPartCandidateKey(partCandidates[0], 0);
  const shouldReviewPart = needsPartReview(scoreJob, score);

  const selectedSection = useMemo(
    () => visibleSections.find((section) => section.sectionId === selectedSectionId) || null,
    [visibleSections, selectedSectionId],
  );

  useEffect(() => {
    if (!score) return;
    setSelectedSectionId((current) => pickVisibleSectionId(score, current));
  }, [score, visibleSections]);

  useEffect(() => {
    if (!analysis || !score) return;
    if (!analysisMatchesScore(analysis, score)) {
      setAnalysis(null);
      setPiecePassSummary(null);
      setPiecePassJob(null);
      clearIssueSessionCache();
    }
  }, [analysis, score]);

  const sectionMap = useMemo(
    () => new Map(visibleSections.map((section) => [section.sectionId, section])),
    [visibleSections],
  );

  const recentAnalyses = useMemo(
    () =>
      [...(participantSnapshot?.analyses || [])]
        .filter((item) => !excludedAnalysisIds.has(item.analysisId))
        .filter((item) => analysisMatchesScore(item, score))
        .sort(
          (left, right) => new Date(right?.createdAt || 0).getTime() - new Date(left?.createdAt || 0).getTime(),
        ),
    [participantSnapshot, excludedAnalysisIds, score],
  );

  const currentSectionHistory = useMemo(
    () => (selectedSectionId ? recentAnalyses.filter((item) => item.sectionId === selectedSectionId) : recentAnalyses),
    [recentAnalyses, selectedSectionId],
  );

  const recentHistory = useMemo(() => recentAnalyses.slice(0, 8), [recentAnalyses]);

  const historySummary = useMemo(() => {
    const latest = recentAnalyses[0] || null;
    const best = recentAnalyses.reduce(
      (winner, item) => (winner == null || getDisplayCombinedScore(item) > getDisplayCombinedScore(winner) ? item : winner),
      recentAnalyses[0] || null,
    );
    const averagePitch = recentAnalyses.length
      ? Math.round(recentAnalyses.reduce((sum, item) => sum + getDisplayPitchScore(item), 0) / recentAnalyses.length)
      : 0;
    const averageRhythm = recentAnalyses.length
      ? Math.round(recentAnalyses.reduce((sum, item) => sum + getDisplayRhythmScore(item), 0) / recentAnalyses.length)
      : 0;
    return {
      scopedCount: recentAnalyses.length,
      latest,
      best,
      averagePitch,
      averageRhythm,
    };
  }, [recentAnalyses]);

  const overallFeedback = buildOverallFeedback(analysis);
  const analysisIssueStats = useMemo(() => getAnalysisIssueStats(analysis), [analysis]);
  const studentPracticeAdvice = useMemo(() => buildStudentPracticeAdvice(analysis), [analysis]);
  const topIssueLine = useMemo(() => buildTopIssueLine(analysis), [analysis]);
  const analysisBusy = analyzing || analysisJob?.status === "processing";
  const wholePieceBusy = piecePassRunning || piecePassJob?.status === "processing";

  function describeHistorySection(item) {
    const knownSection = item.scoreId === score?.scoreId ? sectionMap.get(item.sectionId) : null;
    const sectionLabel = knownSection
      ? formatSectionDisplayName(knownSection)
      : formatSectionDisplayName({ sectionId: item.sectionId, title: item.sectionTitle });
    const rawPieceLabel = item.pieceTitle || item.scoreTitle || "";
    const pieceLabel = rawPieceLabel ? formatScoreTitle(rawPieceLabel) : item.pieceId || item.scoreId || "";
    if (pieceLabel && item.scoreId !== score?.scoreId) {
      return `${pieceLabel} · ${sectionLabel}`;
    }
    return sectionLabel;
  }

  async function refreshParticipantSnapshot(nextParticipantId = studentId) {
    const resolvedParticipantId = String(nextParticipantId || "").trim();
    if (!resolvedParticipantId) return;
    const resolvedScoreId = String(score?.scoreId || "").trim();
    const resolvedPieceId = String(score?.pieceId || score?.scoreId || "").trim();
    if (!resolvedScoreId && !resolvedPieceId) {
      setParticipantSnapshot(null);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const json = await fetchParticipant(resolvedParticipantId, {
        scoreId: resolvedScoreId,
        pieceId: resolvedPieceId,
      });
      setParticipantSnapshot(json?.participant || null);
    } catch {
      setParticipantSnapshot(null);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleImportScore() {
    if (!scorePdfFile) {
      setErrorMessage("请先选择 PDF 曲谱。");
      return;
    }
    setImportingScore(true);
    setErrorMessage("");
    setScore(null);
    setScoreJob(null);
    setAnalysis(null);
    setAnalysisJob(null);
    setPiecePassJob(null);
    setPiecePassSummary(null);
    setParticipantSnapshot(null);
    setExcludedAnalysisIds(new Set());
    setAudioFile(null);
    setAudioDuration(null);
    clearIssueSessionCache();
    setSelectedSectionId("");
    setStatusMessage("正在导入 PDF 并启动自动识谱，请稍候。");
    try {
      const json = await importScorePdf(scorePdfFile);
      const job = json?.job || null;
      setScoreJob(job);
      if (job?.scoreId) {
        const scoreJson = await fetchScore(job.scoreId);
        const nextScore = scoreJson?.score || null;
        setScore(nextScore);
        setSelectedSectionId(pickVisibleSectionId(nextScore, ""));
        setStatusMessage(buildImportStatusMessage(job));
        setImportingScore(false);
      } else {
        setStatusMessage(buildImportStatusMessage(job));
      }
    } catch (error) {
      setImportingScore(false);
      setErrorMessage(error.message || "PDF 导入失败。");
    }
  }

  async function handleImportMusicXml() {
    if (!scoreMusicXmlFile) {
      setErrorMessage("请先选择备用谱文件。");
      return;
    }
    setImportingScore(true);
    setErrorMessage("");
    setScore(null);
    setScoreJob(null);
    setAnalysis(null);
    setAnalysisJob(null);
    setPiecePassJob(null);
    setPiecePassSummary(null);
    setParticipantSnapshot(null);
    setExcludedAnalysisIds(new Set());
    setAudioFile(null);
    setAudioDuration(null);
    clearIssueSessionCache();
    setSelectedSectionId("");
    setStatusMessage("正在导入备用谱文件，并准备可分析曲谱。");
    try {
      const json = await importScoreMusicXml(scoreMusicXmlFile);
      const job = json?.job || null;
      setScoreJob(job);
      if (job?.scoreId) {
        const scoreJson = await fetchScore(job.scoreId);
        const nextScore = scoreJson?.score || null;
        setScore(nextScore);
        setSelectedSectionId(pickVisibleSectionId(nextScore, ""));
      }
      setStatusMessage(buildImportStatusMessage(job));
    } catch (error) {
      setErrorMessage(error.message || "备用谱文件导入失败。");
    } finally {
      setImportingScore(false);
    }
  }

  async function handleSelectPart(nextSelectedPart) {
    const scoreId = score?.scoreId || scoreJob?.scoreId;
    if (!scoreId || !nextSelectedPart || selectingPart) return;
    setSelectingPart(true);
    setImportingScore(true);
    setErrorMessage("");
    setAnalysis(null);
    setAnalysisJob(null);
    setPiecePassJob(null);
    setPiecePassSummary(null);
    clearIssueSessionCache();
    setStatusMessage("正在按你选择的二胡声部重新识谱，请稍候。");
    try {
      const json = await selectScorePart(scoreId, nextSelectedPart);
      const job = json?.job || null;
      setScoreJob(job);
      if (job?.scoreId && job?.omrStatus === "completed") {
        const scoreJson = await fetchScore(job.scoreId);
        const nextScore = scoreJson?.score || null;
        setScore(nextScore);
        setSelectedSectionId(pickVisibleSectionId(nextScore, ""));
      }
      setStatusMessage(buildImportStatusMessage(job));
    } catch (error) {
      setErrorMessage(error.message || "声部重选失败，请稍后重试。");
      setImportingScore(false);
    } finally {
      setSelectingPart(false);
    }
  }

  async function handleAudioFile(file) {
    if (!file) return;
    setAudioFile(file);
    setAnalysis(null);
    setAnalysisJob(null);
    setPiecePassJob(null);
    setPiecePassSummary(null);
    setErrorMessage("");
    setStatusMessage(`已载入音频：${file.name}`);
    const duration = await getAudioDuration(file);
    setAudioDuration(duration);
  }

  function handleScorePdfSelected(file) {
    setScorePdfFile(file || null);
    if (file) setScoreMusicXmlFile(null);
    setScore(null);
    setScoreJob(null);
    setAnalysis(null);
    setAnalysisJob(null);
    setPiecePassJob(null);
    setPiecePassSummary(null);
    setAudioFile(null);
    setAudioDuration(null);
    setSelectedSectionId("");
    setErrorMessage("");
    clearIssueSessionCache();
    if (file) {
      setStatusMessage(`已选择 PDF：${file.name}。请点击“开始导入与识谱”，完成后再上传对应音频。`);
    }
  }


  function handleScoreMusicXmlSelected(file) {
    setScoreMusicXmlFile(file || null);
    if (file) setScorePdfFile(null);
    setScore(null);
    setScoreJob(null);
    setAnalysis(null);
    setAnalysisJob(null);
    setPiecePassJob(null);
    setPiecePassSummary(null);
    setAudioFile(null);
    setAudioDuration(null);
    setSelectedSectionId("");
    setErrorMessage("");
    clearIssueSessionCache();
    if (file) {
      setStatusMessage(`已选择备用谱文件：${file.name}。PDF 自动识谱失败时可用它继续诊断。`);
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setErrorMessage("当前浏览器不支持录音，请改用上传音频。");
      return;
    }
    if (recording) return;
    try {
      await unlockAudio();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        if (!audioChunksRef.current.length) {
          setErrorMessage("没有录到有效音频。");
          return;
        }
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const extension = recorder.mimeType?.includes("mp4") ? "m4a" : recorder.mimeType?.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `erhu-session-${Date.now()}.${extension}`, { type: blob.type || "audio/webm" });
        await handleAudioFile(file);
      };
      recorder.start();
      setRecording(true);
      setStatusMessage("录音中，请演奏完成后点击“结束录音”。");
    } catch {
      setRecording(false);
      setErrorMessage("无法启动录音，请检查麦克风权限。");
    }
  }

  function stopRecording() {
    try {
      mediaRecorderRef.current?.stop();
      setStatusMessage("录音已结束，正在整理音频。");
    } catch {
      setErrorMessage("结束录音失败。");
    }
  }

  async function handleAnalyze() {
    if (!score?.scoreId) {
      setErrorMessage("请先导入 PDF 曲谱。");
      return;
    }
    if (!selectedSection) {
      setErrorMessage("请先选择一个分析段落。");
      return;
    }
    if (shouldReviewPart) {
      setErrorMessage("请先确认二胡旋律行，再上传音频分析。这样可以避免把音准和节奏问题标到钢琴伴奏谱上。");
      return;
    }
    if (!audioFile) {
      setErrorMessage("请先上传或录制音频。");
      return;
    }
    setAnalyzing(true);
    setAnalysisJob(null);
    setErrorMessage("");
    setStatusMessage("分析任务已提交，正在准备音频。");
    try {
      const resolvedStudentId = studentId.trim() || `student-${Date.now().toString(36)}`;
      const json = await createAnalysisJob({
        participantId: resolvedStudentId,
        groupId: "self-practice",
        sessionStage: "self-practice",
        scoreId: score.scoreId,
        pieceId: score.pieceId,
        sectionId: selectedSection.sectionId,
        preprocessMode: separationMode === "off" ? "off" : "erhu-focus",
        separationMode,
        audioSubmission: {
          name: audioFile.name,
          mimeType: audioFile.type || "audio/webm",
          size: audioFile.size,
          duration: audioDuration,
        },
        audioFile,
      });
      const nextJob = json?.job || null;
      setAnalysisJob(nextJob);
      setStatusMessage(buildAnalysisStatusMessage(nextJob));
    } catch (error) {
      setErrorMessage(error.message || "分析失败。");
      setAnalyzing(false);
    }
  }

  async function handleRunWholePiece() {
    if (!score?.scoreId) {
      setErrorMessage("请先导入 PDF 曲谱。");
      return;
    }
    if (shouldReviewPart) {
      setErrorMessage("请先确认二胡旋律行，再运行整曲分析。这样可以避免把音准和节奏问题标到钢琴伴奏谱上。");
      return;
    }
    if (!audioFile) {
      setErrorMessage("请先上传或录制完整音频，再开始整曲分析。");
      return;
    }
    setPiecePassRunning(true);
    setAnalysis(null);
    setAnalysisJob(null);
    clearIssueSessionCache();
    const queuedPiecePassJob = {
      jobId: "",
      scoreId: score.scoreId,
      pieceTitle: formatScoreTitle(score),
      status: "processing",
      stage: "checking-services",
      progress: 0.03,
      message: "整曲分析任务已提交，正在准备整曲扫描。",
    };
    setPiecePassJob(queuedPiecePassJob);
    setPiecePassSummary(null);
    setErrorMessage("");
    setStatusMessage("整曲分析任务已提交，正在准备整曲扫描。");
    try {
      const json = await createPiecePassJob({
        participantId: studentId.trim() || `student-${Date.now().toString(36)}`,
        scoreId: score.scoreId,
        pieceId: score.pieceId || score.scoreId,
        title: formatScoreTitle(score),
        preprocessMode: separationMode === "off" ? "off" : "auto",
        audioSubmission: {
          name: audioFile.name,
          mimeType: audioFile.type || "audio/webm",
          size: audioFile.size,
          duration: audioDuration,
        },
        audioFile,
      });
      const nextJob = json?.job || {
        ...queuedPiecePassJob,
        jobId: json?.jobId || json?.piecePassJobId || "",
      };
      if (nextJob?.scoreId && String(nextJob.scoreId) !== String(score.scoreId)) {
        setPiecePassJob(null);
        setPiecePassRunning(false);
        setErrorMessage("整曲分析任务与当前曲谱不一致，已阻止旧任务继续显示。请重新运行当前曲目的整曲分析。");
        return;
      }
      setPiecePassJob(nextJob);
      setStatusMessage(buildPiecePassStatusMessage(nextJob));
    } catch (error) {
      setPiecePassRunning(false);
      setErrorMessage(error.message || "整曲分析失败。");
    }
  }

  function handleDeleteHistoryItem(analysisId) {
    setExcludedAnalysisIds((prev) => new Set([...prev, analysisId]));
  }

  function handleClearSectionStats() {
    const idsToRemove = currentSectionHistory.map((item) => item.analysisId).filter(Boolean);
    setExcludedAnalysisIds((prev) => new Set([...prev, ...idsToRemove]));
  }

  function handleLoadHistoryItem(item) {
    if (!item) return;
    setAnalysis(item);
    if (item.sectionId) setSelectedSectionId(pickVisibleSectionId(score, item.sectionId));
    setStatusMessage("已载入这次练习结果，可以继续查看问题谱面或重新录音。");
  }

  async function handlePlayDemo() {
    if (!selectedSection?.notes?.length) return;
    try {
      stopDemoRef.current?.();
      stopDemoRef.current = await playReferenceNotes(selectedSection.notes, selectedSection.tempo);
      setStatusMessage("正在播放示范音，请对照问题谱面进行重练。");
    } catch {
      setErrorMessage("示范音播放失败。");
    }
  }

  function handleOpenIssueScorePage() {
    if (!analysis || !score) return;
    if (!analysisMatchesScore(analysis, score)) {
      setAnalysis(null);
      setPiecePassJob(null);
      setPiecePassSummary(null);
      clearIssueSessionCache();
      setErrorMessage("当前分析结果不属于当前 PDF 曲谱，已阻止打开旧问题谱。请重新运行当前曲目的分析。");
      return;
    }
    const isWholePiece = analysis.analysisMode === "whole-piece";
    const issueSection = isWholePiece
      ? null
      : visibleSections.find((item) => item.sectionId === analysis.sectionId)
        || selectedSection
        || null;
    if (!isWholePiece && !issueSection) return;
    const uniqueSource = analysis.analysisId || analysis.audioHash || analysis.createdAt || Date.now().toString(36);
    const sectionKey = isWholePiece ? "whole-piece" : issueSection.sectionId;
    const audioKey = analysis.audioHash || piecePassJob?.audioHash || piecePassSummary?.summary?.audioHash || "no-audio-hash";
    const issueSessionId = `issue-v${ISSUE_SESSION_SCHEMA_VERSION}-${score.scoreId}-${audioKey}-${sectionKey}-${uniqueSource}`;
    const analysisOriginalAudioUrl =
      analysis.originalAudio?.url
      || analysis.originalAudioUrl
      || analysis.audioUrl
      || "";
    const originalAudioForIssuePage = audioPreviewUrl ? {
      url: audioPreviewUrl,
      durationSeconds: audioDuration,
      filename: audioFile?.name || analysis.audioFilename || "",
      audioHash: audioKey,
    } : (analysisOriginalAudioUrl ? {
      url: analysisOriginalAudioUrl,
      durationSeconds: analysis.originalAudio?.durationSeconds ?? analysis.audioDurationSeconds ?? null,
      filename: analysis.originalAudio?.filename || analysis.audioSubmission?.name || analysis.audioFilename || "",
      audioHash: audioKey,
    } : null);
    const payload = JSON.stringify(buildIssueSessionPayload({
      analysis,
      score,
      section: issueSection,
      mode: isWholePiece ? "whole-piece" : "section",
      originalAudio: originalAudioForIssuePage,
    }));
    clearIssueSessionCache();
    const storageKey = `${ISSUE_SESSION_STORAGE_PREFIX}${issueSessionId}`;
    window.sessionStorage.setItem(storageKey, payload);
    window.localStorage.setItem(storageKey, payload);
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "score-issues");
    url.searchParams.set("issueSession", issueSessionId);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  const wholePieceSummary = piecePassJob?.summary || piecePassSummary?.summary || null;
  const visiblePiecePassJob = piecePassJob || (piecePassRunning ? {
    status: "processing",
    stage: "checking-services",
    progress: 0.03,
    message: "整曲分析任务已提交，正在准备整曲扫描。",
  } : null);

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">AI ERHU SELF-PRACTICE</span>
          <h1>二胡 AI 自主练习</h1>
          <p>导入 PDF 曲谱，选择段落，上传或录制演奏音频。系统会自动识谱、增强二胡主旋律，并把音准和节奏问题高亮到问题谱面页。</p>
          <div className="hero-badges">
            <span>PDF 自动识谱</span>
            <span>二胡 / 钢琴分离</span>
            <span>深度学习音高</span>
            <span>深度学习节奏</span>
          </div>
        </div>
        <div className="hero-side">
          <div className="score-badge">
            <span>分析服务</span>
            <strong style={{ color: analyzerStatus?.reachable ? "var(--accent)" : "#b42318" }}>
              {analyzerStatus == null ? "检测中" : analyzerStatus.reachable ? "正常" : "离线"}
            </strong>
          </div>
          <button type="button" className="secondary-button" onClick={onOpenResearch}>
            打开研究后台
          </button>
        </div>
      </header>

      <div className="status-banner">
        <strong>当前状态：</strong>
        {statusMessage}
      </div>
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <div className="grid-layout">
        <section className="panel-card">
          <StepTitle step="01" title="导入 PDF 曲谱" description="先导入整份 PDF，系统将自动识谱并准备好分析段落。" />
          <div className="field-grid">
            <label>
              <span>学生编号</span>
              <input value={studentId} onChange={(event) => setStudentId(event.target.value)} placeholder="例如 student-001" />
            </label>
          </div>
          <div className="action-row">
            <button type="button" className="secondary-button" onClick={() => scoreFileInputRef.current?.click()}>
              选择 PDF
            </button>
            <button type="button" className="primary-button" onClick={handleImportScore} disabled={importingScore}>
              {importingScore ? "导入中..." : "开始导入与识谱"}
            </button>
          </div>
          <input
            ref={scoreFileInputRef}
            className="hidden-input"
            type="file"
            accept="application/pdf"
            onChange={(event) => handleScorePdfSelected(event.target.files?.[0] || null)}
          />
          <div className="action-row">
            <button type="button" className="secondary-button" onClick={() => scoreMusicXmlInputRef.current?.click()}>
              选择备用谱文件
            </button>
            <button type="button" className="secondary-button" onClick={handleImportMusicXml} disabled={importingScore}>
              {importingScore ? "导入中..." : "导入备用谱文件"}
            </button>
          </div>
          <input
            ref={scoreMusicXmlInputRef}
            className="hidden-input"
            type="file"
            accept=".musicxml,.xml,.mxl,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml"
            onChange={(event) => handleScoreMusicXmlSelected(event.target.files?.[0] || null)}
          />
          <div className="upload-meta">
            <span>PDF：{scorePdfFile?.name || "尚未选择 PDF"}</span>
            <span>状态：{scoreJob?.omrStatus || "未开始"}</span>
            <span>识谱质量：{scoreJob ? scoreImportQualityText(scoreJob.omrConfidence) : "未开始"}</span>
          </div>
          {scoreJob ? (
            <div className="history-card omr-progress-card">
              <h3>识谱进度</h3>
              <div className="omr-progress-head">
                <span>{importProgressHeadline(scoreJob)}</span>
                <strong>{percentText(scoreJob.progress)}</strong>
              </div>
              <div className="omr-progress-track" aria-hidden="true">
                <span className="omr-progress-fill" style={{ width: percentText(scoreJob.progress) }} />
              </div>
              {scoreJob?.sourcePdfPath ? (
                <div className="action-row">
                  <a className="secondary-link" href={scoreJob.sourcePdfPath} target="_blank" rel="noreferrer">
                    打开 PDF
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}
          {shouldReviewPart ? (
            <div className="history-card warning-card">
              <h3>请选择二胡旋律行</h3>
              <p>
                这份谱面可能同时包含二胡和钢琴。请选实际演奏二胡旋律的那一行；如果选成伴奏行，后面的音准和节奏问题会标到钢琴谱上。
              </p>
              <label>
                <span>二胡旋律行</span>
                <select
                  value={selectedPartOptionValue}
                  onChange={(event) => handleSelectPart(event.target.value)}
                  disabled={selectingPart || importingScore}
                >
                  {partCandidates.map((candidate, index) => {
                    const value = getPartCandidateKey(candidate, index);
                    return (
                      <option key={value} value={value}>
                        {formatPartCandidateLabel(candidate, index)}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div className="action-row" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => handleSelectPart(selectedPartOptionValue)}
                  disabled={selectingPart || importingScore || !selectedPartOptionValue}
                >
                  {selectingPart || importingScore ? "正在确认..." : "确认使用此旋律行"}
                </button>
              </div>
              <p className="form-help">选择后系统会重新整理可分析段落。看不准时，优先选择标有 Eh. / Erhu / 二胡 的单旋律行，不要选择 Pno. / Piano / 钢琴伴奏行。</p>
            </div>
          ) : null}
        </section>

        <section className="panel-card">
          <StepTitle step="02" title="录音或上传演奏" description="支持直接录音或上传音频。检测到伴奏时，系统会优先自动启用二胡增强 / 钢琴抑制。" />
          <div className="action-row">
            <button type="button" className="primary-button" onClick={recording ? stopRecording : startRecording}>
              {recording ? "结束录音" : "开始录音"}
            </button>
            <button type="button" className="secondary-button" onClick={() => audioFileInputRef.current?.click()}>
              上传音频
            </button>
            <button type="button" className="secondary-button" onClick={handleAnalyze} disabled={analysisBusy || shouldReviewPart}>
              {analysisBusy ? "分析中..." : "分段诊断"}
            </button>
          </div>
          <input
            ref={audioFileInputRef}
            className="hidden-input"
            type="file"
            accept="audio/*"
            onChange={(event) => handleAudioFile(event.target.files?.[0] || null)}
          />
          <div className="field-grid">
            <label>
              <span>伴奏处理方式</span>
              <select value={separationMode} onChange={(event) => setSeparationMode(event.target.value)}>
                <option value="auto">自动处理（推荐）</option>
                <option value="erhu-focus">始终突出二胡旋律</option>
                <option value="off">不处理伴奏，直接分析原音</option>
              </select>
            </label>
          </div>
          <div className="upload-meta">
            <span>音频：{audioFile?.name || "尚未选择音频"}</span>
            <span>时长：{audioDuration == null ? "待解析" : `${audioDuration.toFixed(1)} 秒`}</span>
          </div>
          {analysisJob ? (
            <div className="history-card omr-progress-card">
              <h3>分析进度</h3>
              <div className="omr-progress-head">
                <span>{analysisProgressHeadline(analysisJob)}</span>
                <strong>{percentText(analysisJob.progress)}</strong>
              </div>
              <div className="omr-progress-track" aria-hidden="true">
                <span
                  className={`omr-progress-fill${analysisJob.stage === "analyzing" ? " is-analyzing" : ""}`}
                  style={{ width: percentText(analysisJob.progress) }}
                />
              </div>
              <p>{buildAnalysisStatusMessage(analysisJob)}{analysisJob.stage === "analyzing" ? " 音频分析需要 2–8 分钟，请耐心等待。" : ""}</p>
            </div>
          ) : null}
          {audioPreviewUrl ? <audio controls className="audio-player" src={audioPreviewUrl} /> : null}
          {!audioFile && analysis ? <p className="sidebar-meta">当前已恢复上次分析结果。如需重新分析，请重新上传音频。</p> : null}
        </section>

        <section className="panel-card">
          <StepTitle step="03" title="诊断结果" description="结果页只保留总分与总体反馈，所有问题统一在问题谱面页中高亮显示。" />
          {analysis ? (
            <>
              <div className="result-grid">
                <MetricCard label="综合" value={getDisplayCombinedScore(analysis)} />
                <MetricCard label="音准" value={getDisplayPitchScore(analysis)} />
                <MetricCard label="节奏" value={getDisplayRhythmScore(analysis)} />
              </div>
              <div className="history-card">
                <h3>总体反馈</h3>
                <p>{overallFeedback}</p>
              </div>
              <div className="summary-grid">
                <div className="history-card">
                  <h3>本次重点</h3>
                  <p>{formatPracticePathLabel(analysis.recommendedPracticePath)}</p>
                  <p>{studentPracticeAdvice}</p>
                </div>
                <div className="history-card">
                  <h3>问题概览</h3>
                  <p>问题音：{analysisIssueStats.noteCount} 个</p>
                  <p>问题小节：{analysisIssueStats.measureCount} 个</p>
                  <p>主要类型：{topIssueLine}</p>
                </div>
              </div>
              <div className="history-card">
                <h3>下一步</h3>
                <div className="action-row">
                  <button type="button" className="primary-button" onClick={handleOpenIssueScorePage}>
                    打开问题谱面页
                  </button>
                  <button type="button" className="secondary-button" onClick={handlePlayDemo} disabled={!selectedSection}>
                    播放示范音
                  </button>
                  <button type="button" className="secondary-button" onClick={() => setAnalysis(null)}>
                    清空本轮结果
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-card">完成 PDF 导入、上传音频后，点击【分段诊断】对当前选段诊断，或点击【整曲分析】对整首曲子逐段分析。</div>
          )}
        </section>

        <section className="panel-card">
          <StepTitle step="04" title="整曲分析" description="对当前录音逐段匹配曲谱，生成整曲或长片段概览。" />
          <div className="action-row">
            <button type="button" className="primary-button" onClick={handleRunWholePiece} disabled={wholePieceBusy || shouldReviewPart}>
              {wholePieceBusy ? "整曲分析中..." : "运行整曲分析"}
            </button>
          </div>
          {visiblePiecePassJob ? (
            <div className="omr-progress-card piece-pass-progress-card" style={{ marginTop: 14 }}>
              <div className="omr-progress-head">
                <span>{piecePassProgressHeadline(visiblePiecePassJob)}</span>
                <strong>{percentText(visiblePiecePassJob.progress)}</strong>
              </div>
              <div className="omr-progress-track" aria-hidden="true">
                <span
                  className={`omr-progress-fill${visiblePiecePassJob.status === "processing" ? " is-analyzing" : ""}`}
                  style={{ width: percentText(visiblePiecePassJob.progress) }}
                />
              </div>
              {visiblePiecePassJob.progressDetail?.totalSections ? (
                <p className="sidebar-meta">
                  {buildPiecePassProgressDetailText(visiblePiecePassJob)}
                </p>
              ) : null}
              {buildPiecePassTimingText(visiblePiecePassJob) ? (
                <p className="sidebar-meta">
                  {buildPiecePassTimingText(visiblePiecePassJob)}
                </p>
              ) : null}
              <p>{buildPiecePassStatusMessage(visiblePiecePassJob)}</p>
            </div>
          ) : null}
          {piecePassJob?.status === "failed" ? (
            <div className="error-banner" style={{ marginTop: 14 }}>
              整曲分析失败：{piecePassJob.error || "请检查音频文件后重试。"}
            </div>
          ) : null}
          {piecePassLoading ? (
            <p style={{ marginTop: 10 }}>正在读取当前曲目的整曲概览...</p>
          ) : wholePieceSummary ? (
            <div className="history-card" style={{ marginTop: 14 }}>
              <h3>整曲概览</h3>
              <p>
                已分析段落：{wholePieceSummary.matchedSectionCount} / {wholePieceSummary.structuredSectionCount}
                {" · "}
                综合评分：{getDisplayCombinedScore(wholePieceSummary)}
              </p>
              {Number.isFinite(Number(wholePieceSummary.sectionCacheHitCount)) ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  快速复用：{wholePieceSummary.sectionCacheHitCount || 0} / {wholePieceSummary.attemptedSectionCount || wholePieceSummary.structuredSectionCount || 0} 段。
                  {wholePieceSummary.firstPassCacheBuild ? " 本次有新段落需要完整分析，之后重跑会明显更快。" : " 本次主要复用已完成的分析结果。"}
                </p>
              ) : null}
              {wholePieceSummary.analysisReliable === false ? (
                <p className="error-text">
                  本次整曲分析不完整：有效段落 {wholePieceSummary.matchedSectionCount || 0} / {wholePieceSummary.attemptedSectionCount || wholePieceSummary.structuredSectionCount || 0}，
                  失败或超时 {wholePieceSummary.failedSectionCount || 0} 段。请重新分析或改用分段诊断，不要直接采用该整曲评分。
                </p>
              ) : null}
              {wholePieceSummary.hasNewerIncompleteResult ? (
                <p className="error-text">
                  最近一次整曲任务存在超时漏报，当前概览已自动回退到较早的完整结果；建议重新运行整曲分析生成新的完整问题谱。
                </p>
              ) : null}
              <p>建议路径：{formatPracticePathLabel(wholePieceSummary.dominantPracticePath)}</p>
              {wholePieceSummary.audioCoverage?.isPartial ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                  本次录音时长约 {Math.round(Number(wholePieceSummary.audioCoverage.audioDurationSeconds || 0))} 秒。
                  系统已跳过 {wholePieceSummary.audioCoverage.skippedSectionCount || 0} 个未匹配到的段落；这不代表录音不是完整曲目。
                </p>
              ) : null}
            </div>
          ) : !piecePassJob || piecePassJob.status === "failed" ? (
            <div className="empty-card" style={{ marginTop: 14 }}>上传完整音频后点击【运行整曲分析】，系统会逐段对比曲谱并生成整曲概览。</div>
          ) : null}
        </section>

        <section className="panel-card">
          <StepTitle step="05" title="练习记录" description="最近几次练习记录，按时间显示，不再限定为当前下拉段落。" />
          <div className="upload-meta">
            <span>当前曲目：{score ? formatScoreTitle(score) : "未导入"}</span>
            <span>当前段落：{selectedSection ? formatSectionDisplayName(selectedSection) : "未选择"}</span>
            <span>{historyLoading ? "正在刷新记录..." : `最近练习 ${recentHistory.length} 次`}</span>
          </div>
          <div className="summary-grid">
            <div className="history-card">
              <h3>练习统计</h3>
              <p>练习次数：{historySummary.scopedCount}</p>
              <p>平均音准：{historySummary.averagePitch}</p>
              <p>平均节奏：{historySummary.averageRhythm}</p>
              {currentSectionHistory.length > 0 ? (
                <button type="button" className="secondary-button" onClick={handleClearSectionStats} style={{ marginTop: 8 }}>
                  隐藏当前段记录
                </button>
              ) : null}
            </div>
            <div className="history-card">
              <h3>最近一次</h3>
              {historySummary.latest ? (
                <>
                  <p>{formatAnalysisTime(historySummary.latest.createdAt)}</p>
                  <p>综合：{getDisplayCombinedScore(historySummary.latest)}</p>
                  <p>练习路径：{formatPracticePathLabel(historySummary.latest.recommendedPracticePath)}</p>
                  <button type="button" className="secondary-button" onClick={() => handleLoadHistoryItem(historySummary.latest)}>
                    查看结果
                  </button>
                </>
              ) : (
                <p>暂无记录。</p>
              )}
            </div>
            <div className="history-card">
              <h3>历史最佳</h3>
              {historySummary.best ? (
                <>
                  <p>{formatAnalysisTime(historySummary.best.createdAt)}</p>
                  <p>综合：{getDisplayCombinedScore(historySummary.best)}</p>
                  <p>练习路径：{formatPracticePathLabel(historySummary.best.recommendedPracticePath)}</p>
                  <button type="button" className="secondary-button" onClick={() => handleLoadHistoryItem(historySummary.best)}>
                    查看结果
                  </button>
                </>
              ) : (
                <p>暂无记录。</p>
              )}
            </div>
          </div>
          {recentHistory.length ? (
            <div className="history-list">
              {recentHistory.map((item) => (
                <div className="history-item" key={item.analysisId}>
                  <div>
                    <strong>{describeHistorySection(item)}</strong>
                    <p>{formatAnalysisTime(item.createdAt)}</p>
                    <p>
                      综合 {clampScore(getDisplayCombinedScore(item))} · 音准 {clampScore(getDisplayPitchScore(item))} · 节奏 {clampScore(getDisplayRhythmScore(item))}
                    </p>
                    <p>
                      {formatPracticePathLabel(item.recommendedPracticePath)}
                      {" · "}
                      问题音 {getAnalysisIssueStats(item).noteCount}
                      {" · "}
                      问题小节 {getAnalysisIssueStats(item).measureCount}
                    </p>
                  </div>
                  <div className="action-col">
                    <button type="button" className="secondary-button" onClick={() => handleLoadHistoryItem(item)}>
                      查看结果
                    </button>
                    <button type="button" className="secondary-button" onClick={() => handleDeleteHistoryItem(item.analysisId)}>
                      隐藏
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-card">当前还没有练习记录。完成一次上传与分析后，这里会自动出现最近几次结果。</div>
          )}
        </section>
      </div>
    </div>
  );
}
