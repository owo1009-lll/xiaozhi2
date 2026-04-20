import { useEffect, useRef, useState } from "react";
import { playReferenceNotes, unlockAudio } from "./audioSynth";
import {
  batchCreateParticipants,
  createAnalysis,
  fetchAnalyzerStatus,
  fetchDataQuality,
  fetchExpertRatings,
  fetchInterviews,
  fetchParticipant,
  fetchPendingRatings,
  fetchPieces,
  fetchQuestionnaires,
  fetchResearchOverview,
  fetchResearchParticipants,
  fetchTasks,
  saveExpertRating,
  saveInterviewNote,
  saveInterviewSampling,
  saveParticipantProfile,
  saveTaskPlan,
  saveStudyRecord,
} from "./researchApi";
import { RESEARCH_PROTOCOL, RESEARCH_TEMPLATE_LIBRARY } from "./researchProtocolData";

const SESSION_STAGE_OPTIONS = [
  { value: "pretest", label: "前测" },
  { value: "week1", label: "第 1 周" },
  { value: "week2", label: "第 2 周" },
  { value: "week3", label: "第 3 周" },
  { value: "week4", label: "第 4 周" },
  { value: "week5", label: "第 5 周" },
  { value: "week6", label: "第 6 周" },
  { value: "week7", label: "第 7 周" },
  { value: "week8", label: "第 8 周" },
  { value: "posttest", label: "后测" },
];

const APP_TABS = [
  { id: "workspace", label: "受试工作台" },
  { id: "dashboard", label: "研究总览" },
  { id: "protocol", label: "协议说明" },
];

const EXPERIENCE_QUESTIONS = [
  { key: "usefulness", label: "AI 反馈对本轮练习有帮助" },
  { key: "easeOfUse", label: "系统易于理解和操作" },
  { key: "feedbackClarity", label: "错音与错拍提示足够清晰" },
  { key: "confidence", label: "使用后更有信心改进演奏" },
  { key: "continuance", label: "愿意在课后继续使用该工具" },
];

const DEFAULT_EXPERIENCE = Object.fromEntries(EXPERIENCE_QUESTIONS.map((item) => [item.key, 3]));
const DEFAULT_PROFILE = {
  alias: "",
  institution: "",
  major: "",
  grade: "",
  yearsOfTraining: 0,
  weeklyPracticeMinutes: 0,
  deviceLabel: "",
  consentSigned: false,
  notes: "",
};
const DEFAULT_EXPERT_RATING = {
  participantId: "",
  stage: "pretest",
  pitchScore: 80,
  rhythmScore: 80,
  raterId: "expert-1",
  comments: "",
};
const DEFAULT_TASK_PLAN = {
  taskId: "",
  stage: "week1",
  pieceId: "",
  sectionId: "",
  focus: "",
  instructions: "",
  practiceTargetMinutes: 30,
  dueDate: "",
  status: "assigned",
  assignedBy: "researcher-1",
};
const DEFAULT_INTERVIEW_NOTE = {
  interviewId: "",
  stage: "posttest",
  interviewerId: "researcher-1",
  summary: "",
  barriers: "",
  strategyChanges: "",
  representativeQuote: "",
  nextAction: "",
  followUpNeeded: false,
};
const DEFAULT_SAMPLING_MARK = {
  selected: false,
  priority: "candidate",
  reason: "",
  markedBy: "researcher-1",
};

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(safeNumber(value))));
}

function plusNumber(value) {
  if (value == null || value === "") return "—";
  const numeric = safeNumber(value, NaN);
  if (!Number.isFinite(numeric)) return "—";
  return numeric > 0 ? `+${numeric}` : `${numeric}`;
}

function severityText(value) {
  if (value === "high") return "高优先级";
  if (value === "medium") return "中优先级";
  return "低优先级";
}

function confidenceText(value) {
  const numeric = safeNumber(value, NaN);
  if (!Number.isFinite(numeric)) return "未报告";
  return `${Math.round(numeric * 100)}%`;
}

function formatDateTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function getAudioMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder?.isTypeSupported) {
    return "";
  }
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((item) => window.MediaRecorder.isTypeSupported(item)) || "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取音频失败"));
    reader.readAsDataURL(file);
  });
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

function parseBatchParticipantText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t|,/).map((item) => item.trim()))
    .filter((parts) => parts[0] && parts[0].toLowerCase() !== "participantid")
    .map((parts) => ({
      participantId: parts[0],
      groupId: parts[1] || "experimental",
      profile: {
        alias: parts[2] || "",
        institution: parts[3] || "",
        grade: parts[4] || "",
      },
    }));
}

function SectionTitle({ step, title, description }) {
  function loadParticipantWorkspace(participant) {
    setParticipantId(participant.participantId || "");
    setGroupId(participant.groupId || "experimental");
    setActiveTab("workspace");
    setStatusMessage(`已切换到 ${participant.participantId} 的工作台。`);
  }

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

function ScoreBadge({ label, value, accent, suffix = "" }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong style={{ color: accent }}>
        {clampScore(value)}
        {suffix}
      </strong>
    </div>
  );
}

function RangeQuestion({ label, value, onChange }) {
  return (
    <label className="range-question">
      <span>{label}</span>
      <div className="range-row">
        <input type="range" min="1" max="5" step="1" value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <strong>{value}</strong>
      </div>
    </label>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button type="button" className={`tab-button${active ? " is-active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

function GroupOverviewCard({ group }) {
  return (
    <div className="summary-card">
      <h4>{group.groupId === "experimental" ? "实验组" : "对照组"}</h4>
      <p>参与者：{group.participantCount}</p>
      <p>完成前后测配对：{group.completedPairCount}</p>
      <p>平均音准增益：{group.averagePitchGain}</p>
      <p>平均节奏增益：{group.averageRhythmGain}</p>
      <p>平均有用性：{group.averageUsefulness}</p>
      <p>平均持续使用：{group.averageContinuance}</p>
    </div>
  );
}

function ExportLink({ dataset, format, children }) {
  return (
    <a className="secondary-link" href={`/api/erhu/research/export?dataset=${dataset}&format=${format}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function TemplateDownloadLink({ templateId, children }) {
  return (
    <a className="secondary-link" href={`/api/erhu/research/templates/${templateId}?format=md`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export default function ResearchApp() {
  const [activeTab, setActiveTab] = useState("workspace");
  const [pieces, setPieces] = useState([]);
  const [participantId, setParticipantId] = useState("");
  const [groupId, setGroupId] = useState("experimental");
  const [sessionStage, setSessionStage] = useState("pretest");
  const [selectedPieceId, setSelectedPieceId] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [audioFile, setAudioFile] = useState(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState("");
  const [audioDuration, setAudioDuration] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [participantRecord, setParticipantRecord] = useState(null);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [researchOverview, setResearchOverview] = useState(null);
  const [dataQuality, setDataQuality] = useState(null);
  const [researchParticipants, setResearchParticipants] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [interviews, setInterviews] = useState([]);
  const [questionnaires, setQuestionnaires] = useState([]);
  const [expertRatings, setExpertRatings] = useState([]);
  const [pendingRatings, setPendingRatings] = useState([]);
  const [analyzerStatus, setAnalyzerStatus] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [samplingSaving, setSamplingSaving] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [interviewSaving, setInterviewSaving] = useState(false);
  const [questionnaireSaving, setQuestionnaireSaving] = useState(false);
  const [expertSaving, setExpertSaving] = useState(false);
  const [batchImporting, setBatchImporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("系统已就绪，可开始录音、分析与研究数据录入。");
  const [experienceScales, setExperienceScales] = useState(DEFAULT_EXPERIENCE);
  const [experienceNotes, setExperienceNotes] = useState("");
  const [expertRating, setExpertRating] = useState(DEFAULT_EXPERT_RATING);
  const [taskPlan, setTaskPlan] = useState(DEFAULT_TASK_PLAN);
  const [interviewNote, setInterviewNote] = useState(DEFAULT_INTERVIEW_NOTE);
  const [samplingMark, setSamplingMark] = useState(DEFAULT_SAMPLING_MARK);
  const [batchImportText, setBatchImportText] = useState("");
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const stopDemoRef = useRef(() => {});

  const selectedPiece = pieces.find((piece) => piece.pieceId === selectedPieceId) || null;
  const selectedSection = selectedPiece?.sections?.find((section) => section.sectionId === selectedSectionId) || null;
  const taskPlanPiece = pieces.find((piece) => piece.pieceId === (taskPlan.pieceId || selectedPieceId)) || selectedPiece || null;
  const taskPlanSections = taskPlanPiece?.sections || [];
  const recentLogs = participantRecord?.usageLogs?.slice(-6).reverse() || [];
  const participantTaskPlans =
    participantRecord?.taskPlans?.slice().sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))) || [];
  const participantInterviews =
    participantRecord?.interviews?.slice().sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt))) || [];
  const participantQuestionnaires = participantRecord?.questionnaires?.slice().reverse() || [];
  const groupSummaries = researchOverview?.groups || [];
  const latestTasks = tasks.slice(0, 8);
  const latestInterviews = interviews.slice(0, 8);
  const latestQuestionnaires = questionnaires.slice(0, 8);
  const latestRatings = expertRatings.slice(0, 8);

  useEffect(() => {
    const cachedParticipant = localStorage.getItem("ai-erhu.participant");
    if (cachedParticipant) {
      try {
        const parsed = JSON.parse(cachedParticipant);
        setParticipantId(parsed.participantId || "");
        setGroupId(parsed.groupId || "experimental");
        setSessionStage(parsed.sessionStage || "pretest");
        setExpertRating((prev) => ({ ...prev, participantId: parsed.participantId || "" }));
      } catch {
        // ignore cache errors
      }
    }
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPromptEvent(event);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    fetchPieces()
      .then((json) => {
        const nextPieces = Array.isArray(json?.pieces) ? json.pieces : [];
        setPieces(nextPieces);
        if (!selectedPieceId && nextPieces[0]) {
          setSelectedPieceId(nextPieces[0].pieceId);
          setSelectedSectionId(nextPieces[0].sections?.[0]?.sectionId || "");
        }
      })
      .catch((error) => setErrorMessage(error.message || "曲目加载失败"));
  }, [selectedPieceId]);

  useEffect(() => {
    if (!participantId.trim()) {
      setParticipantRecord(null);
      setProfile(DEFAULT_PROFILE);
      setSamplingMark(DEFAULT_SAMPLING_MARK);
      return;
    }
    fetchParticipant(participantId.trim())
      .then((json) => {
        const record = json?.participant || null;
        setParticipantRecord(record);
        setSamplingMark({
          selected: Boolean(record?.interviewSampling?.selected),
          priority: record?.interviewSampling?.priority || "candidate",
          reason: record?.interviewSampling?.reason || "",
          markedBy: record?.interviewSampling?.markedBy || "researcher-1",
        });
        if (record?.profile) {
          setProfile({
            alias: record.profile.alias || "",
            institution: record.profile.institution || "",
            major: record.profile.major || "",
            grade: record.profile.grade || "",
            yearsOfTraining: safeNumber(record.profile.yearsOfTraining),
            weeklyPracticeMinutes: safeNumber(record.profile.weeklyPracticeMinutes),
            deviceLabel: record.profile.deviceLabel || "",
            consentSigned: Boolean(record.profile.consentSigned),
            notes: record.profile.notes || "",
          });
        }
        if (record?.experienceScales) {
          setExperienceScales({
            usefulness: safeNumber(record.experienceScales.usefulness, 3),
            easeOfUse: safeNumber(record.experienceScales.easeOfUse, 3),
            feedbackClarity: safeNumber(record.experienceScales.feedbackClarity, 3),
            confidence: safeNumber(record.experienceScales.confidence, 3),
            continuance: safeNumber(record.experienceScales.continuance, 3),
          });
          setExperienceNotes(record.experienceScales.notes || "");
        }
      })
      .catch(() => {
        // allow empty participant state
        setSamplingMark(DEFAULT_SAMPLING_MARK);
      });
  }, [participantId]);

  useEffect(() => {
    if (!participantId.trim()) return;
    localStorage.setItem(
      "ai-erhu.participant",
      JSON.stringify({ participantId: participantId.trim(), groupId, sessionStage }),
    );
    setExpertRating((prev) => ({ ...prev, participantId: participantId.trim() }));
  }, [participantId, groupId, sessionStage]);

  useEffect(() => {
    if (!audioFile) return undefined;
    const objectUrl = URL.createObjectURL(audioFile);
    setAudioPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [audioFile]);

  useEffect(() => () => {
    try {
      stopDemoRef.current?.();
    } catch {
      // ignore audio cleanup failures
    }
  }, []);

  useEffect(() => {
    if (activeTab === "dashboard") {
      loadDashboardData();
    }
  }, [activeTab]);

  useEffect(() => {
    setTaskPlan((prev) => ({
      ...prev,
      pieceId: prev.pieceId || selectedPieceId,
      sectionId: prev.sectionId || selectedSectionId,
    }));
  }, [selectedPieceId, selectedSectionId]);

  async function loadDashboardData() {
    setDashboardLoading(true);
    try {
      const [overviewJson, participantsJson, qualityJson, taskJson, interviewJson, questionnaireJson, ratingsJson, pendingJson, analyzerJson] = await Promise.all([
        fetchResearchOverview(),
        fetchResearchParticipants(),
        fetchDataQuality(),
        fetchTasks(),
        fetchInterviews(),
        fetchQuestionnaires(),
        fetchExpertRatings(),
        fetchPendingRatings(),
        fetchAnalyzerStatus(),
      ]);
      setResearchOverview(overviewJson?.overview || null);
      setResearchParticipants(participantsJson?.participants || []);
      setDataQuality(qualityJson?.dataQuality || overviewJson?.overview?.dataQuality || null);
      setTasks(taskJson?.tasks || []);
      setInterviews(interviewJson?.interviews || []);
      setQuestionnaires(questionnaireJson?.questionnaires || []);
      setExpertRatings(ratingsJson?.ratings || []);
      setPendingRatings(pendingJson?.pendingRatings || overviewJson?.overview?.pendingRatings || []);
      setAnalyzerStatus(analyzerJson?.analyzer || overviewJson?.overview?.analyzer || null);
    } catch (error) {
      setErrorMessage(error.message || "研究总览加载失败");
    } finally {
      setDashboardLoading(false);
    }
  }

  async function refreshParticipantRecord() {
    if (!participantId.trim()) return;
    try {
      const json = await fetchParticipant(participantId.trim());
      setParticipantRecord(json?.participant || null);
      if (activeTab === "dashboard") {
        await loadDashboardData();
      }
    } catch {
      // keep previous participant state
    }
  }

  async function handleAudioFile(file) {
    if (!file) return;
    setErrorMessage("");
    setAnalysis(null);
    setAudioFile(file);
    setStatusMessage(`已载入音频：${file.name}`);
    const duration = await getAudioDuration(file);
    setAudioDuration(duration);
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setErrorMessage("当前浏览器不支持录音，请改用上传音频文件。");
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
          setErrorMessage("未捕获到录音内容");
          return;
        }
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const extension = recorder.mimeType?.includes("mp4") ? "m4a" : recorder.mimeType?.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `erhu-session-${Date.now()}.${extension}`, { type: blob.type || "audio/webm" });
        await handleAudioFile(file);
      };
      recorder.start();
      setRecording(true);
      setStatusMessage("录音中，请完成演奏后点击“结束录音”。");
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
      setErrorMessage("结束录音失败，请重试。");
    }
  }

  async function handleAnalyze() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }
    if (!selectedPiece || !selectedSection) {
      setErrorMessage("请先选择曲目与段落。");
      return;
    }
    if (!audioFile) {
      setErrorMessage("请先录音或上传音频。");
      return;
    }

    setAnalysisLoading(true);
    setErrorMessage("");
    setStatusMessage("正在执行音准与节奏分析，请稍候。");
    try {
      const audioDataUrl = await fileToDataUrl(audioFile);
      const json = await createAnalysis({
        participantId: participantId.trim(),
        groupId,
        sessionStage,
        pieceId: selectedPiece.pieceId,
        sectionId: selectedSection.sectionId,
        audioSubmission: {
          name: audioFile.name,
          mimeType: audioFile.type || "audio/webm",
          size: audioFile.size,
          duration: audioDuration,
        },
        audioDataUrl,
      });
      setAnalysis(json.analysis || null);
      setStatusMessage(
        json.analysis?.analysisMode === "external"
          ? "外部 Python 分析服务已返回结果，可继续查看问题音和问题小节。"
          : "当前使用本地回退分析结果。配置 Python 服务后可切换到深度学习分析。",
      );
      await refreshParticipantRecord();
    } catch (error) {
      setErrorMessage(error.message || "分析失败，请稍后重试。");
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function handlePlayDemo() {
    if (!selectedSection?.notes?.length) return;
    try {
      stopDemoRef.current?.();
      stopDemoRef.current = await playReferenceNotes(selectedSection.notes, selectedSection.tempo);
      setStatusMessage("正在播放标准示范，可对照结果进行重练。");
    } catch {
      setErrorMessage("标准示范播放失败。");
    }
  }

  async function handleSaveProfile() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }
    setProfileSaving(true);
    setErrorMessage("");
    try {
      await saveParticipantProfile({
        participantId: participantId.trim(),
        groupId,
        profile,
      });
      setStatusMessage("受试档案已保存。");
      await refreshParticipantRecord();
    } catch (error) {
      setErrorMessage(error.message || "保存受试档案失败。");
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleSaveSamplingMark() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }

    setSamplingSaving(true);
    setErrorMessage("");
    try {
      await saveInterviewSampling({
        participantId: participantId.trim(),
        groupId,
        ...samplingMark,
      });
      setStatusMessage("访谈抽样标记已保存。");
      await refreshParticipantRecord();
      if (activeTab === "dashboard") {
        await loadDashboardData();
      }
    } catch (error) {
      setErrorMessage(error.message || "保存访谈抽样标记失败。");
    } finally {
      setSamplingSaving(false);
    }
  }

  async function handleSaveTaskPlan() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }

    setTaskSaving(true);
    setErrorMessage("");
    try {
      await saveTaskPlan({
        participantId: participantId.trim(),
        groupId,
        ...taskPlan,
        pieceId: taskPlan.pieceId || selectedPieceId,
        sectionId: taskPlan.sectionId || selectedSectionId,
      });
      setStatusMessage("周任务计划已保存。");
      setTaskPlan((prev) => ({
        ...DEFAULT_TASK_PLAN,
        stage: prev.stage,
        pieceId: selectedPieceId,
        sectionId: selectedSectionId,
        assignedBy: prev.assignedBy,
      }));
      await refreshParticipantRecord();
    } catch (error) {
      setErrorMessage(error.message || "保存周任务计划失败。");
    } finally {
      setTaskSaving(false);
    }
  }

  async function handleSaveInterviewNote() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }

    setInterviewSaving(true);
    setErrorMessage("");
    try {
      await saveInterviewNote({
        participantId: participantId.trim(),
        groupId,
        ...interviewNote,
      });
      setStatusMessage("访谈记录已保存。");
      setInterviewNote((prev) => ({
        ...DEFAULT_INTERVIEW_NOTE,
        stage: prev.stage,
        interviewerId: prev.interviewerId,
      }));
      await refreshParticipantRecord();
    } catch (error) {
      setErrorMessage(error.message || "保存访谈记录失败。");
    } finally {
      setInterviewSaving(false);
    }
  }

  async function handleSaveQuestionnaire() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }
    setQuestionnaireSaving(true);
    setErrorMessage("");
    try {
      await saveStudyRecord({
        participantId: participantId.trim(),
        groupId,
        sessionStage,
        experienceScales,
        notes: experienceNotes,
      });
      setStatusMessage("学习体验问卷已保存。");
      await refreshParticipantRecord();
    } catch (error) {
      setErrorMessage(error.message || "保存问卷失败。");
    } finally {
      setQuestionnaireSaving(false);
    }
  }

  async function handleInstallApp() {
    if (!installPromptEvent) return;
    const result = await installPromptEvent.prompt();
    if (result?.outcome) {
      setStatusMessage(`安装提示结果：${result.outcome}`);
    }
    setInstallPromptEvent(null);
  }

  async function handleExpertRatingSubmit() {
    if (!expertRating.participantId.trim()) {
      setErrorMessage("请填写教师评分对应的受试编号。");
      return;
    }
    setExpertSaving(true);
    setErrorMessage("");
    try {
      await saveExpertRating(expertRating);
      setStatusMessage("教师评分已保存。");
      if (participantId.trim() === expertRating.participantId.trim()) {
        await refreshParticipantRecord();
      }
      await loadDashboardData();
    } catch (error) {
      setErrorMessage(error.message || "教师评分保存失败。");
    } finally {
      setExpertSaving(false);
    }
  }

  async function handleBatchImport() {
    const participants = parseBatchParticipantText(batchImportText);
    if (!participants.length) {
      setErrorMessage("请输入批量参与者清单，每行格式为 participantId,groupId,alias,institution,grade");
      return;
    }

    setBatchImporting(true);
    setErrorMessage("");
    try {
      const json = await batchCreateParticipants({ participants });
      setStatusMessage(`已导入 ${json.importedCount || participants.length} 名参与者。`);
      setBatchImportText("");
      await loadDashboardData();
    } catch (error) {
      setErrorMessage(error.message || "批量导入失败。");
    } finally {
      setBatchImporting(false);
    }
  }

  function loadPendingRating(item) {
    setExpertRating((prev) => ({
      ...prev,
      participantId: item.participantId,
      stage: item.pendingStages?.[0] || "pretest",
    }));
    setStatusMessage(`已载入 ${item.participantId} 的待评分记录。`);
  }

  function loadTaskIntoEditor(task) {
    setTaskPlan({
      taskId: task.taskId || "",
      stage: task.stage || "week1",
      pieceId: task.pieceId || selectedPieceId,
      sectionId: task.sectionId || selectedSectionId,
      focus: task.focus || "",
      instructions: task.instructions || "",
      practiceTargetMinutes: safeNumber(task.practiceTargetMinutes, 30),
      dueDate: task.dueDate || "",
      status: task.status || "assigned",
      assignedBy: task.assignedBy || "researcher-1",
    });
    setStatusMessage(`已载入 ${task.stage} 的周任务计划。`);
  }

  function loadInterviewIntoEditor(interview) {
    setInterviewNote({
      interviewId: interview.interviewId || "",
      stage: interview.stage || "posttest",
      interviewerId: interview.interviewerId || "researcher-1",
      summary: interview.summary || "",
      barriers: interview.barriers || "",
      strategyChanges: interview.strategyChanges || "",
      representativeQuote: interview.representativeQuote || "",
      nextAction: interview.nextAction || "",
      followUpNeeded: Boolean(interview.followUpNeeded),
    });
    setStatusMessage(`已载入 ${interview.stage} 的访谈记录。`);
  }

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">AI + 音乐教育 + 深度学习</span>
          <h1>AI 二胡教学干预研究原型</h1>
          <p>
            面向 SSCI 教育干预研究的 PWA 原型。当前版本覆盖受试档案录入、录音后分析、标准示范、学习体验问卷、教师评分和研究数据导出。
          </p>
          <div className="hero-badges">
            <span>教育干预研究</span>
            <span>PWA / 壳 App</span>
            <span>音准 + 节奏</span>
            <span>Python 外部分析服务</span>
          </div>
        </div>
        <div className="hero-side">
          <ScoreBadge label="最近音准" value={analysis?.overallPitchScore ?? 0} accent="#0f766e" />
          <ScoreBadge label="最近节奏" value={analysis?.overallRhythmScore ?? 0} accent="#b45309" />
          <ScoreBadge label="分析置信度" value={safeNumber((analysis?.confidence || 0) * 100)} accent="#4338ca" suffix="%" />
        </div>
      </header>

      <div className="toolbar">
        <div className="tab-row">
          {APP_TABS.map((tab) => (
            <TabButton key={tab.id} active={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}>
              {tab.label}
            </TabButton>
          ))}
        </div>
        {installPromptEvent ? (
          <button type="button" className="secondary-button" onClick={handleInstallApp}>
            安装到手机桌面
          </button>
        ) : null}
      </div>

      <div className="status-banner">
        <strong>状态：</strong>
        {statusMessage}
      </div>
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      {activeTab === "workspace" ? (
        <div className="grid-layout">
          <section className="panel-card">
            <SectionTitle step="01" title="受试编号与档案" description="保存受试分组、背景信息和知情同意状态，作为实验数据入口。" />
            <div className="field-grid">
              <label>
                <span>受试编号</span>
                <input value={participantId} onChange={(event) => setParticipantId(event.target.value)} placeholder="例如 EH-023" />
              </label>
              <label>
                <span>组别</span>
                <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                  <option value="experimental">实验组</option>
                  <option value="control">对照组</option>
                </select>
              </label>
              <label>
                <span>实验阶段</span>
                <select value={sessionStage} onChange={(event) => setSessionStage(event.target.value)}>
                  {SESSION_STAGE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="field-grid">
              <label>
                <span>匿名代号</span>
                <input value={profile.alias} onChange={(event) => setProfile((prev) => ({ ...prev, alias: event.target.value }))} placeholder="例如 P23" />
              </label>
              <label>
                <span>学校 / 机构</span>
                <input value={profile.institution} onChange={(event) => setProfile((prev) => ({ ...prev, institution: event.target.value }))} />
              </label>
              <label>
                <span>专业 / 方向</span>
                <input value={profile.major} onChange={(event) => setProfile((prev) => ({ ...prev, major: event.target.value }))} />
              </label>
              <label>
                <span>年级</span>
                <input value={profile.grade} onChange={(event) => setProfile((prev) => ({ ...prev, grade: event.target.value }))} />
              </label>
              <label>
                <span>学琴年限</span>
                <input
                  type="number"
                  min="0"
                  max="80"
                  value={profile.yearsOfTraining}
                  onChange={(event) => setProfile((prev) => ({ ...prev, yearsOfTraining: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>周练习时长（分钟）</span>
                <input
                  type="number"
                  min="0"
                  max="10080"
                  value={profile.weeklyPracticeMinutes}
                  onChange={(event) => setProfile((prev) => ({ ...prev, weeklyPracticeMinutes: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>设备型号</span>
                <input value={profile.deviceLabel} onChange={(event) => setProfile((prev) => ({ ...prev, deviceLabel: event.target.value }))} />
              </label>
              <div className="checkbox-field">
                <span>知情同意</span>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={profile.consentSigned}
                    onChange={(event) => setProfile((prev) => ({ ...prev, consentSigned: event.target.checked }))}
                  />
                  <span>已确认完成知情同意</span>
                </label>
              </div>
            </div>
            <label className="notes-field">
              <span>研究备注</span>
              <textarea rows="3" value={profile.notes} onChange={(event) => setProfile((prev) => ({ ...prev, notes: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveProfile} disabled={profileSaving}>
                {profileSaving ? "保存中..." : "保存受试档案"}
              </button>
            </div>
            <div className="mini-metrics">
              <div>
                <span>系统前测音准</span>
                <strong>{participantRecord?.pretest?.pitchScore == null ? "未记录" : `${clampScore(participantRecord.pretest.pitchScore)} 分`}</strong>
              </div>
              <div>
                <span>系统后测音准</span>
                <strong>{participantRecord?.posttest?.pitchScore == null ? "未记录" : `${clampScore(participantRecord.posttest.pitchScore)} 分`}</strong>
              </div>
              <div>
                <span>系统音准增益</span>
                <strong>{plusNumber(participantRecord?.pitchGain)}</strong>
              </div>
              <div>
                <span>系统节奏增益</span>
                <strong>{plusNumber(participantRecord?.rhythmGain)}</strong>
              </div>
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="01B" title="访谈抽样标记" description="标记优先访谈样本，记录抽样原因与优先级，便于正式实验阶段开展质性补充。" />
            <div className="field-grid">
              <label className="checkbox-field">
                <span>纳入访谈抽样</span>
                <div className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={samplingMark.selected}
                    onChange={(event) => setSamplingMark((prev) => ({ ...prev, selected: event.target.checked }))}
                  />
                  <span>将当前受试者纳入访谈候选队列</span>
                </div>
              </label>
              <label>
                <span>优先级</span>
                <select value={samplingMark.priority} onChange={(event) => setSamplingMark((prev) => ({ ...prev, priority: event.target.value }))}>
                  <option value="candidate">候选</option>
                  <option value="priority">优先</option>
                  <option value="reserve">备选</option>
                  <option value="completed">已访谈</option>
                </select>
              </label>
              <label>
                <span>标记人</span>
                <input value={samplingMark.markedBy} onChange={(event) => setSamplingMark((prev) => ({ ...prev, markedBy: event.target.value }))} />
              </label>
            </div>
            <label className="notes-field">
              <span>抽样原因</span>
              <textarea rows="3" value={samplingMark.reason} onChange={(event) => setSamplingMark((prev) => ({ ...prev, reason: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveSamplingMark} disabled={samplingSaving}>
                {samplingSaving ? "保存中..." : "保存抽样标记"}
              </button>
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="02" title="曲目与任务选择" description="统一调用结构化曲目包，供前端、Node 网关和 Python 分析服务复用。" />
            <div className="field-grid">
              <label>
                <span>研究曲目</span>
                <select
                  value={selectedPieceId}
                  onChange={(event) => {
                    const piece = pieces.find((item) => item.pieceId === event.target.value);
                    setSelectedPieceId(event.target.value);
                    setSelectedSectionId(piece?.sections?.[0]?.sectionId || "");
                  }}
                >
                  {pieces.map((piece) => (
                    <option key={piece.pieceId} value={piece.pieceId}>
                      {piece.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>练习段落</span>
                <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)}>
                  {(selectedPiece?.sections || []).map((section) => (
                    <option key={section.sectionId} value={section.sectionId}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selectedPiece ? (
              <div className="piece-summary">
                <h3>{selectedPiece.title}</h3>
                <p>难度：{selectedPiece.difficulty}</p>
                <p>目标技能：{(selectedPiece.targetSkills || []).join(" / ")}</p>
                {selectedSection ? (
                  <div className="section-meta">
                    <span>段落：{selectedSection.title}</span>
                    <span>速度：♩={selectedSection.tempo}</span>
                    <span>拍号：{selectedSection.meter}</span>
                    <span>音符数：{selectedSection.noteCount}</span>
                    <span>小节数：{selectedSection.measureCount}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="panel-card">
            <SectionTitle step="03" title="录音 / 上传" description="支持手机端录音与文件上传，所有反馈默认基于录制后分析。" />
            <div className="action-row">
              <button type="button" className="primary-button" onClick={recording ? stopRecording : startRecording}>
                {recording ? "结束录音" : "开始录音"}
              </button>
              <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                上传音频
              </button>
              <button type="button" className="secondary-button" onClick={handleAnalyze} disabled={analysisLoading}>
                {analysisLoading ? "分析中..." : "开始分析"}
              </button>
            </div>
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              accept="audio/*"
              onChange={(event) => handleAudioFile(event.target.files?.[0] || null)}
            />
            <div className="upload-meta">
              <span>文件：{audioFile?.name || "尚未选择音频"}</span>
              <span>时长：{audioDuration == null ? "待解析" : `${audioDuration.toFixed(1)} 秒`}</span>
              <span>大小：{audioFile ? `${(audioFile.size / 1024 / 1024).toFixed(2)} MB` : "0 MB"}</span>
            </div>
            {audioPreviewUrl ? (
              <audio controls className="audio-player" src={audioPreviewUrl}>
                当前浏览器不支持音频预览。
              </audio>
            ) : null}
          </section>

          <section className="panel-card">
            <SectionTitle step="04" title="分析结果" description="结果聚焦问题小节、问题音、偏差方向和示范回放，不追求商用级复杂评分。" />
            {analysis ? (
              <>
                <div className="result-grid">
                  <ScoreBadge label="总音准" value={analysis.overallPitchScore} accent="#0f766e" />
                  <ScoreBadge label="总节奏" value={analysis.overallRhythmScore} accent="#b45309" />
                  <ScoreBadge label="置信度" value={safeNumber((analysis.confidence || 0) * 100)} accent="#4338ca" suffix="%" />
                  <ScoreBadge label="分析模式" value={analysis.analysisMode === "external" ? 100 : 60} accent="#7c3aed" suffix="%" />
                </div>
                {(analysis.summaryText || analysis.teacherComment || (analysis.practiceTargets || []).length) ? (
                  <div className="summary-grid">
                    <div className="history-card">
                      <h3>整体判断</h3>
                      <p>{analysis.summaryText || "当前已生成结果，但整体说明尚未形成。"}</p>
                      {analysis.teacherComment ? <p className="supporting-copy">{analysis.teacherComment}</p> : null}
                    </div>
                    <div className="history-card">
                      <h3>优先练习顺序</h3>
                      {(analysis.practiceTargets || []).length ? (
                        <ol className="compact-list practice-list">
                          {analysis.practiceTargets.map((target) => (
                            <li key={`${target.targetType}-${target.targetId || target.measureIndex || target.priority}`}>
                              <strong>{target.title}</strong>
                              <span className="practice-meta">{`${severityText(target.severity)} · ${target.evidenceLabel || "系统建议"}`}</span>
                              <span>{target.why}</span>
                              <span>{target.action}</span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p>当前没有形成明确的优先练习顺序。</p>
                      )}
                    </div>
                  </div>
                ) : null}
                <div className="findings-grid">
                  <div className="finding-card">
                    <h3>问题小节</h3>
                    {(analysis.measureFindings || []).length ? (
                      <ul>
                        {analysis.measureFindings.map((item) => (
                          <li key={`${item.measureIndex}-${item.issueType}`}>
                            <strong>第 {item.measureIndex} 小节：</strong>
                            {item.issueLabel}
                            {item.severity ? ` · ${severityText(item.severity)}` : ""}
                            {item.detail ? ` (${item.detail})` : ""}
                            {item.coachingTip ? <span className="finding-help">{`建议：${item.coachingTip}`}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>当前没有定位到显著的小节级问题。</p>
                    )}
                  </div>
                  <div className="finding-card">
                    <h3>问题音</h3>
                    {(analysis.noteFindings || []).length ? (
                      <ul>
                        {analysis.noteFindings.map((item) => (
                          <li key={item.noteId}>
                            <strong>{item.noteId}</strong>
                            {`，第 ${item.measureIndex} 小节，${item.pitchLabel}，${item.rhythmLabel}`}
                            {item.severity ? ` · ${severityText(item.severity)}` : ""}
                            {item.evidenceLabel ? <span className="finding-help">{`证据：${item.evidenceLabel}`}</span> : null}
                            {item.confidence != null ? <span className="finding-help">{`置信度：${confidenceText(item.confidence)}`}</span> : null}
                            {item.why ? <span className="finding-help">{`原因：${item.why}`}</span> : null}
                            {item.action ? <span className="finding-help">{`怎么练：${item.action}`}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>当前没有定位到问题音。</p>
                    )}
                  </div>
                </div>
                {analysis.diagnostics ? (
                  <div className="history-card">
                    <h3>分析诊断</h3>
                    <div className="demo-note-list">
                      <span>依赖数：{Object.values(analysis.diagnostics.dependencyReport || {}).filter(Boolean).length}</span>
                      <span>音频字节：{analysis.diagnostics.decodedAudioBytes ?? 0}</span>
                      <span>对齐音符：{analysis.diagnostics.alignedNoteCount ?? 0}</span>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty-card">尚未生成诊断结果。完成录音或上传后，点击“开始分析”。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="05" title="标准示范与重练" description="默认播放结构化标准音符序列，方便演奏者对照错误位置立即重练。" />
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handlePlayDemo} disabled={!selectedSection}>
                播放标准示范
              </button>
              <button type="button" className="secondary-button" onClick={() => setAnalysis(null)}>
                清空本轮结果
              </button>
            </div>
            <div className="demo-note-list">
              {(selectedSection?.notes || []).slice(0, 12).map((note) => (
                <span key={note.noteId}>
                  {note.noteId} · M{note.measureIndex} · MIDI {note.midiPitch}
                </span>
              ))}
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="06" title="周任务计划" description="为每位受试者分配周次任务、练习重点和截止时间，支撑 6-8 周任务化练习设计。" />
            <div className="field-grid">
              <label>
                <span>任务阶段</span>
                <select value={taskPlan.stage} onChange={(event) => setTaskPlan((prev) => ({ ...prev, stage: event.target.value }))}>
                  {SESSION_STAGE_OPTIONS.filter((item) => item.value.startsWith("week") || item.value === "pretest" || item.value === "posttest").map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>曲目</span>
                <select
                  value={taskPlan.pieceId || selectedPieceId}
                  onChange={(event) =>
                    setTaskPlan((prev) => ({
                      ...prev,
                      pieceId: event.target.value,
                      sectionId: pieces.find((piece) => piece.pieceId === event.target.value)?.sections?.[0]?.sectionId || "",
                    }))
                  }
                >
                  {pieces.map((piece) => (
                    <option key={piece.pieceId} value={piece.pieceId}>
                      {piece.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>段落</span>
                <select value={taskPlan.sectionId || selectedSectionId} onChange={(event) => setTaskPlan((prev) => ({ ...prev, sectionId: event.target.value }))}>
                  {taskPlanSections.map((section) => (
                    <option key={section.sectionId} value={section.sectionId}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>目标分钟数</span>
                <input
                  type="number"
                  min="0"
                  max="600"
                  value={taskPlan.practiceTargetMinutes}
                  onChange={(event) => setTaskPlan((prev) => ({ ...prev, practiceTargetMinutes: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>截止日期</span>
                <input type="date" value={taskPlan.dueDate} onChange={(event) => setTaskPlan((prev) => ({ ...prev, dueDate: event.target.value }))} />
              </label>
              <label>
                <span>任务状态</span>
                <select value={taskPlan.status} onChange={(event) => setTaskPlan((prev) => ({ ...prev, status: event.target.value }))}>
                  <option value="assigned">已分配</option>
                  <option value="in-progress">进行中</option>
                  <option value="completed">已完成</option>
                </select>
              </label>
              <label>
                <span>指派人</span>
                <input value={taskPlan.assignedBy} onChange={(event) => setTaskPlan((prev) => ({ ...prev, assignedBy: event.target.value }))} />
              </label>
            </div>
            <label className="notes-field">
              <span>训练重点</span>
              <textarea rows="3" value={taskPlan.focus} onChange={(event) => setTaskPlan((prev) => ({ ...prev, focus: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>教师/研究者指令</span>
              <textarea rows="4" value={taskPlan.instructions} onChange={(event) => setTaskPlan((prev) => ({ ...prev, instructions: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveTaskPlan} disabled={taskSaving}>
                {taskSaving ? "保存中..." : "保存周任务"}
              </button>
            </div>
            <div className="queue-list">
              {participantTaskPlans.length ? (
                participantTaskPlans.map((item) => (
                  <div key={item.taskId || `${item.stage}-${item.updatedAt}`} className="queue-item">
                    <div>
                      <strong>{item.stage}</strong>
                      <p>
                        {item.pieceId}/{item.sectionId} · {item.status} · {item.practiceTargetMinutes} 分钟 · 截止 {item.dueDate || "未设置"}
                      </p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => loadTaskIntoEditor(item)}>
                      载入任务
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-card">当前还没有该受试者的周任务计划。</div>
              )}
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="07" title="访谈记录" description="记录半结构访谈摘要、学习障碍、策略变化和后续跟进建议，支撑体验与机制解释。" />
            <div className="field-grid">
              <label>
                <span>访谈阶段</span>
                <select value={interviewNote.stage} onChange={(event) => setInterviewNote((prev) => ({ ...prev, stage: event.target.value }))}>
                  {SESSION_STAGE_OPTIONS.filter((item) => item.value.startsWith("week") || item.value === "pretest" || item.value === "posttest").map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>访谈人</span>
                <input value={interviewNote.interviewerId} onChange={(event) => setInterviewNote((prev) => ({ ...prev, interviewerId: event.target.value }))} />
              </label>
              <label className="checkbox-field">
                <span>需要后续跟进</span>
                <div className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={interviewNote.followUpNeeded}
                    onChange={(event) => setInterviewNote((prev) => ({ ...prev, followUpNeeded: event.target.checked }))}
                  />
                  <span>标记为后续追访样本</span>
                </div>
              </label>
            </div>
            <label className="notes-field">
              <span>访谈摘要</span>
              <textarea rows="3" value={interviewNote.summary} onChange={(event) => setInterviewNote((prev) => ({ ...prev, summary: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>主要障碍</span>
              <textarea rows="3" value={interviewNote.barriers} onChange={(event) => setInterviewNote((prev) => ({ ...prev, barriers: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>练习策略变化</span>
              <textarea rows="3" value={interviewNote.strategyChanges} onChange={(event) => setInterviewNote((prev) => ({ ...prev, strategyChanges: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>代表性引语</span>
              <textarea rows="2" value={interviewNote.representativeQuote} onChange={(event) => setInterviewNote((prev) => ({ ...prev, representativeQuote: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>后续建议</span>
              <textarea rows="2" value={interviewNote.nextAction} onChange={(event) => setInterviewNote((prev) => ({ ...prev, nextAction: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveInterviewNote} disabled={interviewSaving}>
                {interviewSaving ? "保存中..." : "保存访谈记录"}
              </button>
            </div>
            <div className="queue-list">
              {participantInterviews.length ? (
                participantInterviews.map((item) => (
                  <div key={item.interviewId || `${item.stage}-${item.submittedAt}`} className="queue-item">
                    <div>
                      <strong>{item.stage}</strong>
                      <p>
                        {item.interviewerId} · {item.followUpNeeded ? "需要跟进" : "常规记录"} · {formatDateTime(item.submittedAt)}
                      </p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => loadInterviewIntoEditor(item)}>
                      载入记录
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-card">当前还没有该受试者的访谈记录。</div>
              )}
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="08" title="问卷与使用日志" description="按阶段保存学习体验问卷，并保留最近分析记录，服务于研究统计与访谈抽样。" />
            <div className="question-grid">
              {EXPERIENCE_QUESTIONS.map((item) => (
                <RangeQuestion
                  key={item.key}
                  label={item.label}
                  value={experienceScales[item.key]}
                  onChange={(value) => setExperienceScales((prev) => ({ ...prev, [item.key]: value }))}
                />
              ))}
            </div>
            <label className="notes-field">
              <span>开放性反馈</span>
              <textarea
                rows="4"
                value={experienceNotes}
                onChange={(event) => setExperienceNotes(event.target.value)}
                placeholder="记录本轮练习的困难、AI 反馈是否清晰，以及是否愿意继续使用。"
              />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveQuestionnaire} disabled={questionnaireSaving}>
                {questionnaireSaving ? "保存中..." : "保存学习体验"}
              </button>
            </div>
            <div className="history-columns">
              <div className="history-card">
                <h3>最近使用日志</h3>
                {recentLogs.length ? (
                  <ul className="compact-list">
                    {recentLogs.map((item) => (
                      <li key={item.analysisId || item.at}>
                        <strong>{item.sessionStage}</strong>
                        {` · ${item.pieceId}/${item.sectionId} · 音准 ${clampScore(item.overallPitchScore)} · 节奏 ${clampScore(item.overallRhythmScore)} · ${formatDateTime(item.at)}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>当前还没有使用日志。</p>
                )}
              </div>
              <div className="history-card">
                <h3>阶段问卷记录</h3>
                {participantQuestionnaires.length ? (
                  <ul className="compact-list">
                    {participantQuestionnaires.map((item) => (
                      <li key={item.questionnaireId || `${item.sessionStage}-${item.submittedAt}`}>
                        <strong>{item.sessionStage}</strong>
                        {` · 有用性 ${item.usefulness} · 持续使用 ${item.continuance} · ${formatDateTime(item.submittedAt)}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>当前还没有问卷记录。</p>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "dashboard" ? (
        <div className="dashboard-layout">
          <section className="panel-card">
            <SectionTitle step="R1" title="研究总览" description="查看样本规模、问卷条目、教师评分待办和分析器连通状态。" />
            {dashboardLoading ? (
              <div className="empty-card">正在加载研究数据...</div>
            ) : researchOverview ? (
              <>
                <div className="result-grid">
                  <ScoreBadge label="参与者" value={researchOverview.participantCount} accent="#1d4ed8" />
                  <ScoreBadge label="分析记录" value={researchOverview.analysisCount} accent="#0f766e" />
                  <ScoreBadge label="档案完成" value={researchOverview.profileCompletedCount} accent="#0f766e" />
                  <ScoreBadge label="问卷参与者" value={researchOverview.questionnaireCount} accent="#b45309" />
                </div>
                <div className="result-grid">
                  <ScoreBadge label="问卷条目" value={researchOverview.questionnaireEntryCount} accent="#7c3aed" />
                  <ScoreBadge label="任务计划" value={researchOverview.taskPlanCount} accent="#1d4ed8" />
                  <ScoreBadge label="已完成任务" value={researchOverview.completedTaskCount} accent="#0f766e" />
                  <ScoreBadge label="访谈记录" value={researchOverview.interviewCount} accent="#7c3aed" />
                </div>
                <div className="result-grid">
                  <ScoreBadge label="配对完成" value={researchOverview.completedPairCount} accent="#7c3aed" />
                  <ScoreBadge label="平均音准增益" value={researchOverview.averagePitchGain} accent="#0f766e" />
                  <ScoreBadge label="平均节奏增益" value={researchOverview.averageRhythmGain} accent="#b45309" />
                </div>
                <div className="result-grid">
                  <ScoreBadge label="平均有用性" value={researchOverview.averageUsefulness * 20} accent="#7c3aed" suffix="%" />
                  <ScoreBadge label="平均持续使用" value={researchOverview.averageContinuance * 20} accent="#1d4ed8" suffix="%" />
                  <ScoreBadge label="教师后测评分" value={researchOverview.expertRatedCount} accent="#7c3aed" />
                  <ScoreBadge label="分析器连通" value={analyzerStatus?.reachable ? 100 : 0} accent="#4338ca" suffix="%" />
                </div>
                <div className="summary-grid">
                  {groupSummaries.map((group) => (
                    <GroupOverviewCard key={group.groupId} group={group} />
                  ))}
                </div>
                <div className="history-card">
                  <h3>分析器状态</h3>
                  <div className="demo-note-list">
                    <span>模式：{analyzerStatus?.mode || "fallback-only"}</span>
                    <span>已配置：{analyzerStatus?.configured ? "是" : "否"}</span>
                    <span>可访问：{analyzerStatus?.reachable ? "是" : "否"}</span>
                    <span>服务地址：{analyzerStatus?.serviceUrl || "未配置"}</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-card">研究总览尚未形成。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R2" title="教师评分与数据导出" description="支持前测/后测或阶段评分录入，并导出参与者、问卷、评分和分析记录。" />
            <div className="field-grid">
              <label>
                <span>受试编号</span>
                <input value={expertRating.participantId} onChange={(event) => setExpertRating((prev) => ({ ...prev, participantId: event.target.value }))} placeholder="例如 EH-023" />
              </label>
              <label>
                <span>评分阶段</span>
                <select value={expertRating.stage} onChange={(event) => setExpertRating((prev) => ({ ...prev, stage: event.target.value }))}>
                  <option value="pretest">前测</option>
                  <option value="week4">阶段测量</option>
                  <option value="posttest">后测</option>
                </select>
              </label>
              <label>
                <span>评分教师</span>
                <input value={expertRating.raterId} onChange={(event) => setExpertRating((prev) => ({ ...prev, raterId: event.target.value }))} />
              </label>
              <label>
                <span>音准评分</span>
                <input type="number" min="0" max="100" value={expertRating.pitchScore} onChange={(event) => setExpertRating((prev) => ({ ...prev, pitchScore: Number(event.target.value) }))} />
              </label>
              <label>
                <span>节奏评分</span>
                <input type="number" min="0" max="100" value={expertRating.rhythmScore} onChange={(event) => setExpertRating((prev) => ({ ...prev, rhythmScore: Number(event.target.value) }))} />
              </label>
            </div>
            <label className="notes-field">
              <span>评分备注</span>
              <textarea rows="4" value={expertRating.comments} onChange={(event) => setExpertRating((prev) => ({ ...prev, comments: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleExpertRatingSubmit} disabled={expertSaving}>
                {expertSaving ? "保存中..." : "保存教师评分"}
              </button>
              <button type="button" className="secondary-button" onClick={loadDashboardData}>
                刷新研究数据
              </button>
            </div>
            <div className="link-row">
              <ExportLink dataset="participants" format="csv">导出参与者 CSV</ExportLink>
              <ExportLink dataset="sampling" format="csv">导出抽样 CSV</ExportLink>
              <ExportLink dataset="tasks" format="csv">导出任务 CSV</ExportLink>
              <ExportLink dataset="interviews" format="csv">导出访谈 CSV</ExportLink>
              <ExportLink dataset="questionnaires" format="csv">导出问卷 CSV</ExportLink>
              <ExportLink dataset="expert-ratings" format="csv">导出评分 CSV</ExportLink>
              <ExportLink dataset="analyses" format="csv">导出分析 CSV</ExportLink>
              <ExportLink dataset="participants" format="json">导出全量 JSON</ExportLink>
            </div>
            <div className="history-card">
              <h3>批量导入参与者</h3>
              <p>每行格式：participantId,groupId,alias,institution,grade</p>
              <label className="notes-field">
                <span>导入文本</span>
                <textarea
                  rows="5"
                  value={batchImportText}
                  onChange={(event) => setBatchImportText(event.target.value)}
                  placeholder={"EH-001,experimental,P01,Music University,Year 1\nEH-002,control,P02,Music University,Year 1"}
                />
              </label>
              <div className="action-row">
                <button type="button" className="primary-button" onClick={handleBatchImport} disabled={batchImporting}>
                  {batchImporting ? "导入中..." : "批量导入参与者"}
                </button>
              </div>
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="R3" title="待评分队列" description="列出已完成前测或后测但尚未录入教师评分的受试者，可一键载入评分表。" />
            {pendingRatings.length ? (
              <div className="queue-list">
                {pendingRatings.map((item) => (
                  <div key={`${item.participantId}-${item.pendingStages.join("-")}`} className="queue-item">
                    <div>
                      <strong>{item.participantId}</strong>
                      <p>{item.groupId === "experimental" ? "实验组" : "对照组"} · 待评分阶段：{item.pendingStages.join(" / ")}</p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => loadPendingRating(item)}>
                      载入评分
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-card">当前没有待评分记录。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R3B" title="缺测提醒与质控" description="汇总缺测、逾期任务和待访谈样本，帮助在正式实验阶段及时补录与跟进。" />
            {dataQuality ? (
              <>
                <div className="result-grid">
                  <ScoreBadge label="提醒数" value={dataQuality.reminderCount} accent="#b45309" />
                  <ScoreBadge label="缺少档案" value={dataQuality.missingProfileCount} accent="#7c3aed" />
                  <ScoreBadge label="缺前测" value={dataQuality.missingPretestCount} accent="#1d4ed8" />
                  <ScoreBadge label="缺后测" value={dataQuality.missingPosttestCount} accent="#4338ca" />
                </div>
                <div className="result-grid">
                  <ScoreBadge label="逾期任务样本" value={dataQuality.overdueTaskParticipantCount} accent="#b45309" />
                  <ScoreBadge label="抽样人数" value={dataQuality.samplingCount} accent="#0f766e" />
                  <ScoreBadge label="待访谈样本" value={dataQuality.pendingInterviewCount} accent="#7c3aed" />
                  <ScoreBadge label="已完成抽样访谈" value={dataQuality.samplingCompletedCount} accent="#1d4ed8" />
                </div>
                {dataQuality.reminders.length ? (
                  <div className="queue-list">
                    {dataQuality.reminders.slice(0, 8).map((item) => (
                      <div key={item.participantId} className="queue-item">
                        <div>
                          <strong>{item.participantId}</strong>
                          <p>
                            {item.groupId === "experimental" ? "实验组" : "对照组"} · 缺失项：{item.missingItems.join(" / ")}
                          </p>
                        </div>
                        <button type="button" className="secondary-button" onClick={() => loadParticipantWorkspace(item)}>
                          打开工作台
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-card">当前没有需要补录或跟进的样本。</div>
                )}
              </>
            ) : (
              <div className="empty-card">数据质量概览尚未生成。</div>
            )}
          </section>

          <section className="panel-card dashboard-span">
            <SectionTitle step="R3C" title="周任务完成率看板" description="按组别和周次查看任务完成率、进行中数量和逾期数量。" />
            {dataQuality?.taskBoard?.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>阶段</th>
                      <th>组别</th>
                      <th>已分配</th>
                      <th>已完成</th>
                      <th>进行中</th>
                      <th>逾期</th>
                      <th>完成率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataQuality.taskBoard.map((item) => (
                      <tr key={`${item.stage}-${item.groupId}`}>
                        <td>{item.stage}</td>
                        <td>{item.groupId === "experimental" ? "实验组" : "对照组"}</td>
                        <td>{item.assignedCount}</td>
                        <td>{item.completedCount}</td>
                        <td>{item.inProgressCount}</td>
                        <td>{item.overdueCount}</td>
                        <td>{item.completionRate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-card">当前没有可统计的任务计划。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R3D" title="访谈抽样队列" description="查看已标记的质性样本，追踪优先级、抽样原因和完成情况。" />
            {dataQuality?.samplingRows?.length ? (
              <div className="queue-list">
                {dataQuality.samplingRows.map((item) => (
                  <div key={item.participantId} className="queue-item">
                    <div>
                      <strong>{item.participantId}</strong>
                      <p>
                        {item.groupId === "experimental" ? "实验组" : "对照组"} · {item.priority} · 已访谈 {item.interviewCount} 次
                      </p>
                      <p>{item.reason || "未填写抽样原因"}</p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => loadParticipantWorkspace(item)}>
                      打开工作台
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-card">当前没有已标记的访谈抽样样本。</div>
            )}
          </section>

          <section className="panel-card dashboard-span">
            <SectionTitle step="R4" title="参与者列表" description="汇总每位受试的档案完成情况、系统增益、问卷数量和教师评分状态。" />
            {dashboardLoading ? (
              <div className="empty-card">正在加载参与者列表...</div>
            ) : researchParticipants.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>受试编号</th>
                      <th>组别</th>
                      <th>档案</th>
                      <th>分析数</th>
                      <th>音准增益</th>
                      <th>节奏增益</th>
                      <th>问卷数</th>
                      <th>任务数</th>
                      <th>已完成任务</th>
                      <th>访谈数</th>
                      <th>抽样标记</th>
                      <th>抽样优先级</th>
                      <th>最新问卷阶段</th>
                      <th>最新访谈阶段</th>
                      <th>教师前测音准</th>
                      <th>教师后测音准</th>
                      <th>最近活跃</th>
                    </tr>
                  </thead>
                  <tbody>
                    {researchParticipants.map((participant) => (
                      <tr key={participant.participantId}>
                        <td>{participant.participantId}</td>
                        <td>{participant.groupId === "experimental" ? "实验组" : "对照组"}</td>
                        <td>{participant.profileCompleted ? "完成" : "未完成"}</td>
                        <td>{participant.analysisCount}</td>
                        <td>{plusNumber(participant.pitchGain)}</td>
                        <td>{plusNumber(participant.rhythmGain)}</td>
                        <td>{participant.questionnaireCount}</td>
                        <td>{participant.taskPlanCount}</td>
                        <td>{participant.completedTaskCount}</td>
                        <td>{participant.interviewCount}</td>
                        <td>{participant.interviewSamplingSelected ? "是" : "否"}</td>
                        <td>{participant.interviewSamplingPriority || "—"}</td>
                        <td>{participant.latestQuestionnaireStage || "—"}</td>
                        <td>{participant.latestInterviewStage || "—"}</td>
                        <td>{participant.expertPretestPitch ?? "—"}</td>
                        <td>{participant.expertPosttestPitch ?? "—"}</td>
                        <td>{formatDateTime(participant.lastActiveAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-card">当前还没有参与者数据。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R5" title="最新问卷" description="查看最近提交的问卷条目，验证导出前的数据完整性。" />
            {latestQuestionnaires.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>受试编号</th>
                      <th>阶段</th>
                      <th>有用性</th>
                      <th>清晰度</th>
                      <th>持续使用</th>
                      <th>提交时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestQuestionnaires.map((item) => (
                      <tr key={`${item.participantId}-${item.sessionStage}-${item.submittedAt}`}>
                        <td>{item.participantId}</td>
                        <td>{item.sessionStage}</td>
                        <td>{item.usefulness}</td>
                        <td>{item.feedbackClarity}</td>
                        <td>{item.continuance}</td>
                        <td>{formatDateTime(item.submittedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-card">当前没有问卷记录。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R6" title="最新教师评分" description="查看最近保存的教师评分，确保评分流程写入成功。" />
            {latestRatings.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>受试编号</th>
                      <th>阶段</th>
                      <th>教师</th>
                      <th>音准</th>
                      <th>节奏</th>
                      <th>提交时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestRatings.map((item) => (
                      <tr key={`${item.participantId}-${item.stage}-${item.submittedAt}`}>
                        <td>{item.participantId}</td>
                        <td>{item.stage}</td>
                        <td>{item.raterId}</td>
                        <td>{item.pitchScore}</td>
                        <td>{item.rhythmScore}</td>
                        <td>{formatDateTime(item.submittedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-card">当前没有教师评分记录。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R7" title="最新任务计划" description="查看最近更新的周任务计划，确认实验组与对照组任务安排是否按周推进。" />
            {latestTasks.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>受试编号</th>
                      <th>阶段</th>
                      <th>曲目/段落</th>
                      <th>状态</th>
                      <th>目标分钟数</th>
                      <th>截止日期</th>
                      <th>更新时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestTasks.map((item) => (
                      <tr key={item.taskId}>
                        <td>{item.participantId}</td>
                        <td>{item.stage}</td>
                        <td>{`${item.pieceId}/${item.sectionId}`}</td>
                        <td>{item.status}</td>
                        <td>{item.practiceTargetMinutes}</td>
                        <td>{item.dueDate || "—"}</td>
                        <td>{formatDateTime(item.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-card">当前没有任务计划记录。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R8" title="最新访谈记录" description="查看最近保存的访谈条目，便于抽样分析 AI 反馈接受度与学习机制。" />
            {latestInterviews.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>受试编号</th>
                      <th>阶段</th>
                      <th>访谈人</th>
                      <th>需要跟进</th>
                      <th>摘要</th>
                      <th>提交时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestInterviews.map((item) => (
                      <tr key={item.interviewId}>
                        <td>{item.participantId}</td>
                        <td>{item.stage}</td>
                        <td>{item.interviewerId}</td>
                        <td>{item.followUpNeeded ? "是" : "否"}</td>
                        <td>{item.summary || "—"}</td>
                        <td>{formatDateTime(item.submittedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-card">当前没有访谈记录。</div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === "protocol" ? (
        <div className="protocol-layout">
          <section className="panel-card">
            <SectionTitle step="P1" title={RESEARCH_PROTOCOL.title} description={RESEARCH_PROTOCOL.summary} />
            <div className="protocol-stack">
              {RESEARCH_PROTOCOL.sections.map((section) => (
                <article key={section.title} className="protocol-card">
                  <h3>{section.title}</h3>
                  <ul>
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            <div className="history-card">
              <h3>研究模板导出</h3>
              <p>下面的模板可直接导出为 Markdown，适合进一步整理为论文附件、伦理申请材料或研究执行文档。</p>
              <div className="summary-grid">
                {RESEARCH_TEMPLATE_LIBRARY.map((template) => (
                  <article key={template.templateId} className="protocol-card">
                    <h3>{template.title}</h3>
                    <p>{template.description}</p>
                    <div className="link-row">
                      <TemplateDownloadLink templateId={template.templateId}>导出模板</TemplateDownloadLink>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
