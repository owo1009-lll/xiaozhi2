import { useEffect, useMemo, useRef, useState } from "react";
import { playReferenceNotes, unlockAudio } from "./audioSynth";
import { fetchPieces, fetchParticipant, fetchResearchOverview, fetchResearchParticipants, createAnalysis, saveExpertRating, saveStudyRecord } from "./researchApi";
import { RESEARCH_PROTOCOL } from "./researchProtocol";

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
  { key: "usefulness", label: "AI 反馈对本次练习有帮助" },
  { key: "easeOfUse", label: "系统易于理解和操作" },
  { key: "feedbackClarity", label: "错音/错拍提示清楚" },
  { key: "confidence", label: "使用后更有信心改进演奏" },
  { key: "continuance", label: "愿意继续在课后练习中使用" },
];

const DEFAULT_EXPERIENCE = Object.fromEntries(EXPERIENCE_QUESTIONS.map((item) => [item.key, 3]));
const DEFAULT_EXPERT_RATING = { participantId: "", stage: "pretest", pitchScore: 80, rhythmScore: 80, raterId: "expert-1", comments: "" };

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(safeNumber(value))));
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

function pitchLabelText(value) {
  if (value === "pitch-flat") return "音高偏低";
  if (value === "pitch-sharp") return "音高偏高";
  if (value === "pitch-review") return "音高需复核";
  if (value === "pitch-ok") return "音高基本正确";
  return value || "音高未标注";
}

function rhythmLabelText(item) {
  const value = item?.rhythmType || item?.rhythmLabel;
  if (item?.rhythmTypeLabel) return item.rhythmTypeLabel;
  if (value === "rhythm-rush") return "节奏抢拍";
  if (value === "rhythm-drag") return "节奏拖拍";
  if (value === "rhythm-duration-short") return "时值偏短";
  if (value === "rhythm-duration-long") return "时值偏长";
  if (value === "rhythm-rush-short") return "抢拍且时值偏短";
  if (value === "rhythm-drag-long") return "拖拍且时值偏长";
  if (value === "rhythm-missing") return "疑似漏音或起拍未捕获";
  if (value === "rhythm-unstable") return "节奏不稳";
  if (value === "rhythm-ok") return "节奏基本正确";
  return value || "节奏未标注";
}

function measureIssueLabelText(item) {
  const value = item?.issueType || item?.issueLabel;
  if (value === "rhythm-measure-rush") return "小节整体偏快";
  if (value === "rhythm-measure-drag") return "小节整体偏慢";
  if (value === "rhythm-measure-short") return "小节时值普遍偏短";
  if (value === "rhythm-measure-long") return "小节时值普遍偏长";
  if (value === "rhythm-unstable") return "节奏不稳";
  if (value === "pitch-unstable") return "音准不稳";
  return item?.issueLabel || "问题类型未标注";
}

function preprocessModeLabel(value) {
  if (value === "melody-focus") return "伴奏抑制 / 旋律增强";
  return "关闭";
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

function SectionTitle({ step, title, description }) {
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
      <p>平均持续使用意愿：{group.averageContinuance}</p>
    </div>
  );
}

export default function App() {
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
  const [preprocessMode, setPreprocessMode] = useState("off");
  const [analysis, setAnalysis] = useState(null);
  const [participantRecord, setParticipantRecord] = useState(null);
  const [researchOverview, setResearchOverview] = useState(null);
  const [researchParticipants, setResearchParticipants] = useState([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("系统已准备，可进行曲目选择、录音与研究记录。");
  const [experienceScales, setExperienceScales] = useState(DEFAULT_EXPERIENCE);
  const [experienceNotes, setExperienceNotes] = useState("");
  const [questionnaireSaving, setQuestionnaireSaving] = useState(false);
  const [expertRating, setExpertRating] = useState(DEFAULT_EXPERT_RATING);
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const stopDemoRef = useRef(() => {});

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
        // noop
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
    if (participantId.trim()) {
      localStorage.setItem(
        "ai-erhu.participant",
        JSON.stringify({ participantId: participantId.trim(), groupId, sessionStage }),
      );
      setExpertRating((prev) => ({ ...prev, participantId: participantId.trim() }));
    }
  }, [participantId, groupId, sessionStage]);

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
      .catch((error) => {
        setErrorMessage(error.message || "曲目包加载失败。");
      });
  }, [selectedPieceId]);

  useEffect(() => {
    if (!participantId.trim()) {
      setParticipantRecord(null);
      return;
    }
    fetchParticipant(participantId.trim())
      .then((json) => setParticipantRecord(json?.participant || null))
      .catch(() => {});
  }, [participantId]);

  useEffect(() => () => {
    try {
      stopDemoRef.current?.();
    } catch {
      // noop
    }
  }, []);

  useEffect(() => {
    if (!audioFile) return undefined;
    const objectUrl = URL.createObjectURL(audioFile);
    setAudioPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [audioFile]);

  useEffect(() => {
    if (activeTab !== "dashboard") return;
    loadDashboardData();
  }, [activeTab]);

  const selectedPiece = useMemo(
    () => pieces.find((piece) => piece.pieceId === selectedPieceId) || null,
    [pieces, selectedPieceId],
  );
  const selectedSection = useMemo(
    () => selectedPiece?.sections?.find((section) => section.sectionId === selectedSectionId) || null,
    [selectedPiece, selectedSectionId],
  );

  async function loadDashboardData() {
    setDashboardLoading(true);
    try {
      const [overviewJson, participantsJson] = await Promise.all([fetchResearchOverview(), fetchResearchParticipants()]);
      setResearchOverview(overviewJson?.overview || null);
      setResearchParticipants(participantsJson?.participants || []);
    } catch (error) {
      setErrorMessage(error.message || "研究总览加载失败。");
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
      // noop
    }
  }

  async function handleAudioFile(file) {
    if (!file) return;
    setErrorMessage("");
    setStatusMessage(`已载入音频：${file.name}`);
    setAudioFile(file);
    setAnalysis(null);
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
          setErrorMessage("未捕获到录音内容。");
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
      setErrorMessage("无法启动录音，请检查麦克风权限。");
      setRecording(false);
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
      setErrorMessage("请先选择曲目和段落。");
      return;
    }
    if (!audioFile) {
      setErrorMessage("请先录音或上传音频。");
      return;
    }

    setAnalysisLoading(true);
    setErrorMessage("");
    setStatusMessage("系统正在执行音准与节奏诊断，请稍候。");
    try {
      const json = await createAnalysis({
        participantId: participantId.trim(),
        groupId,
        sessionStage,
        pieceId: selectedPiece.pieceId,
        sectionId: selectedSection.sectionId,
        preprocessMode,
        audioSubmission: {
          name: audioFile.name,
          mimeType: audioFile.type || "audio/webm",
          size: audioFile.size,
          duration: audioDuration,
        },
        audioFile,
      });
      setAnalysis(json.analysis || null);
      setStatusMessage(
        json.analysis?.analysisMode === "external"
          ? `深度学习分析已完成${preprocessMode === "melody-focus" ? "，并启用了伴奏抑制。" : ""}，可查看错音/错拍并进行重练。`
          : "已返回研究原型结果。若配置外部分析器，可切换到深度学习分析。",
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
      setStatusMessage("正在播放标准示范，可对照结果页进行重练。");
    } catch {
      setErrorMessage("标准示范播放失败。");
    }
  }

  async function handleSaveQuestionnaire() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号后再提交问卷。");
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
      setErrorMessage(error.message || "提交失败。");
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
      setErrorMessage("请填写专家评分对应的受试编号。");
      return;
    }
    setErrorMessage("");
    try {
      await saveExpertRating(expertRating);
      setStatusMessage("专家评分已写入研究数据。");
      await refreshParticipantRecord();
      await loadDashboardData();
    } catch (error) {
      setErrorMessage(error.message || "专家评分提交失败。");
    }
  }

  const recentLogs = participantRecord?.usageLogs?.slice(-5).reverse() || [];
  const groupSummaries = researchOverview?.groups || [];

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">AI + 音乐教育 + 深度学习</span>
          <h1>AI 二胡教学干预研究原型</h1>
          <p>
            面向 SSCI 的教育干预研究工具。当前原型聚焦高校二胡学习者的音准与节奏训练，支持受试登录、
            任务选择、非实时诊断、标准示范回放、学习体验记录和研究数据总览。
          </p>
          <div className="hero-badges">
            <span>教育干预研究</span>
            <span>PWA / 壳 App</span>
            <span>音准 + 节奏</span>
            <span>6-8 周实验</span>
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
        <strong>状态：</strong>{statusMessage}
      </div>
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      {activeTab === "workspace" ? (
        <div className="grid-layout">
          <section className="panel-card">
            <SectionTitle step="01" title="登录与受试编号" description="填写受试编号、组别与阶段，所有分析日志都会写入研究记录表。" />
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
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mini-metrics">
              <div>
                <span>系统前测音准</span>
                <strong>{participantRecord?.pretest?.pitchScore == null ? "未记录" : `${clampScore(participantRecord.pretest.pitchScore)}分`}</strong>
              </div>
              <div>
                <span>系统后测音准</span>
                <strong>{participantRecord?.posttest?.pitchScore == null ? "未记录" : `${clampScore(participantRecord.posttest.pitchScore)}分`}</strong>
              </div>
              <div>
                <span>系统音准增益</span>
                <strong>{participantRecord?.pitchGain == null ? "待形成" : `+${participantRecord.pitchGain}`}</strong>
              </div>
              <div>
                <span>系统节奏增益</span>
                <strong>{participantRecord?.rhythmGain == null ? "待形成" : `+${participantRecord.rhythmGain}`}</strong>
              </div>
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="02" title="曲目与任务选择" description="统一采用结构化曲目包，便于深度学习分析器与研究日志复用。" />
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
                    <option key={piece.pieceId} value={piece.pieceId}>{piece.title}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>练习段落</span>
                <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)}>
                  {(selectedPiece?.sections || []).map((section) => (
                    <option key={section.sectionId} value={section.sectionId}>{section.title}</option>
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
            <SectionTitle step="03" title="录音 / 上传" description="支持手机端直接录音或上传练习音频，所有反馈均为录制后分析。" />
            <div className="action-row">
              <button type="button" className="primary-button" onClick={recording ? stopRecording : startRecording}>
                {recording ? "结束录音" : "开始录音"}
              </button>
              <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                上传音频
              </button>
              <button type="button" className="secondary-button" onClick={handleAnalyze} disabled={analysisLoading}>
                {analysisLoading ? "分析中..." : "开始诊断"}
              </button>
            </div>
            <input ref={fileInputRef} className="hidden-input" type="file" accept="audio/*" onChange={(event) => handleAudioFile(event.target.files?.[0] || null)} />
            <div className="upload-meta">
              <span>文件：{audioFile?.name || "尚未选择音频"}</span>
              <span>时长：{audioDuration == null ? "待解析" : `${audioDuration.toFixed(1)} 秒`}</span>
              <span>大小：{audioFile ? `${(audioFile.size / 1024 / 1024).toFixed(2)} MB` : "0 MB"}</span>
            </div>
            <div className="field-grid">
              <label>
                <span>混合音频预处理</span>
                <select value={preprocessMode} onChange={(event) => setPreprocessMode(event.target.value)}>
                  <option value="off">关闭，适合纯二胡录音</option>
                  <option value="melody-focus">启用伴奏抑制 / 旋律增强，适合带伴奏或合奏音频</option>
                </select>
              </label>
            </div>
            {audioPreviewUrl ? (
              <audio controls className="audio-player" src={audioPreviewUrl}>
                当前浏览器不支持音频预览。
              </audio>
            ) : null}
          </section>

          <section className="panel-card">
            <SectionTitle step="04" title="分析结果页" description="结果固定为问题小节、问题音、音准方向与节奏偏差，便于直接进入教育分析。" />
            {analysis ? (
              <>
                <div className="result-grid">
                  <ScoreBadge label="总音准" value={analysis.overallPitchScore} accent="#0f766e" />
                  <ScoreBadge label="总节奏" value={analysis.overallRhythmScore} accent="#b45309" />
                  <ScoreBadge label="置信度" value={safeNumber((analysis.confidence || 0) * 100)} accent="#4338ca" suffix="%" />
                  <ScoreBadge label="模式指示" value={analysis.analysisMode === "external" ? 100 : 68} accent="#7c3aed" />
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
                      ) : <p>当前没有形成明确的优先练习顺序。</p>}
                    </div>
                  </div>
                ) : null}
                <div className="findings-grid">
                  <div className="finding-card">
                    <h3>小节级问题</h3>
                    {(analysis.measureFindings || []).length ? (
                      <ul>
                        {analysis.measureFindings.map((item) => (
                          <li key={`${item.measureIndex}-${item.issueType}`}>
                            <strong>第 {item.measureIndex} 小节：</strong>
                            {measureIssueLabelText(item)}
                            {item.severity ? ` · ${severityText(item.severity)}` : ""}
                            {item.detail ? `；${item.detail}` : ""}
                            {item.coachingTip ? <span className="finding-help">{`建议：${item.coachingTip}`}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : <p>当前未发现明显的小节级结构问题。</p>}
                  </div>
                  <div className="finding-card">
                    <h3>音符级问题</h3>
                    {(analysis.noteFindings || []).length ? (
                      <ul>
                        {analysis.noteFindings.map((item) => (
                          <li key={item.noteId}>
                            <strong>{item.noteId}</strong>
                            {`：第 ${item.measureIndex} 小节，${pitchLabelText(item.pitchLabel)}，${rhythmLabelText(item)}`}
                            {item.severity ? ` · ${severityText(item.severity)}` : ""}
                            {item.evidenceLabel ? <span className="finding-help">{`证据：${item.evidenceLabel}`}</span> : null}
                            {item.confidence != null ? <span className="finding-help">{`置信度：${confidenceText(item.confidence)}`}</span> : null}
                            {item.durationErrorMs != null && Math.abs(safeNumber(item.durationErrorMs)) > 0 ? (
                              <span className="finding-help">{`时值偏差：${item.durationErrorMs > 0 ? "+" : ""}${item.durationErrorMs} ms`}</span>
                            ) : null}
                            {item.why ? <span className="finding-help">{`原因：${item.why}`}</span> : null}
                            {item.action ? <span className="finding-help">{`怎么练：${item.action}`}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : <p>当前未定位到具体错音。</p>}
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-card">尚未生成诊断结果。完成录音或上传后，点击“开始诊断”进入研究反馈流程。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="05" title="标准示范回放与重练" description="默认播放结构化标准音符序列，便于与结果页对照后立即进行二次练习。" />
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
            <SectionTitle step="06" title="学习记录与问卷" description="该模块记录学习体验、使用日志与后续访谈线索，服务于教育干预论文分析。" />
            <div className="question-grid">
              {EXPERIENCE_QUESTIONS.map((item) => (
                <RangeQuestion key={item.key} label={item.label} value={experienceScales[item.key]} onChange={(value) => setExperienceScales((prev) => ({ ...prev, [item.key]: value }))} />
              ))}
            </div>
            <label className="notes-field">
              <span>开放性反馈</span>
              <textarea rows="4" value={experienceNotes} onChange={(event) => setExperienceNotes(event.target.value)} placeholder="记录本轮练习困难、AI 反馈是否清晰，以及是否愿意继续使用。" />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveQuestionnaire} disabled={questionnaireSaving}>
                {questionnaireSaving ? "提交中..." : "保存学习体验"}
              </button>
            </div>
            <div className="history-card">
              <h3>最近使用日志</h3>
              {recentLogs.length ? (
                <ul>
                  {recentLogs.map((item) => (
                    <li key={item.analysisId || item.at}>
                      <strong>{item.sessionStage}</strong>
                      {` · ${item.pieceId}/${item.sectionId} · 音准 ${clampScore(item.overallPitchScore)} · 节奏 ${clampScore(item.overallRhythmScore)} · ${formatDateTime(item.at)}`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>当前还没有形成可回顾的研究日志。</p>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {activeTab === "dashboard" ? (
        <div className="dashboard-layout">
          <section className="panel-card">
            <SectionTitle step="R1" title="研究总览" description="查看样本规模、前后测增益、组间统计和体验量表情况。" />
            {dashboardLoading ? (
              <div className="empty-card">正在加载研究数据...</div>
            ) : researchOverview ? (
              <>
                <div className="result-grid">
                  <ScoreBadge label="参与者" value={researchOverview.participantCount} accent="#1d4ed8" />
                  <ScoreBadge label="分析记录" value={researchOverview.analysisCount} accent="#0f766e" />
                  <ScoreBadge label="配对完成" value={researchOverview.completedPairCount} accent="#7c3aed" />
                  <ScoreBadge label="问卷提交" value={researchOverview.questionnaireCount} accent="#b45309" />
                </div>
                <div className="result-grid">
                  <ScoreBadge label="平均音准增益" value={researchOverview.averagePitchGain} accent="#0f766e" />
                  <ScoreBadge label="平均节奏增益" value={researchOverview.averageRhythmGain} accent="#b45309" />
                  <ScoreBadge label="平均有用性" value={researchOverview.averageUsefulness * 20} accent="#7c3aed" suffix="%" />
                  <ScoreBadge label="平均持续使用意愿" value={researchOverview.averageContinuance * 20} accent="#1d4ed8" suffix="%" />
                </div>
                <div className="summary-grid">
                  {groupSummaries.map((group) => (
                    <GroupOverviewCard key={group.groupId} group={group} />
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-card">研究总览尚未形成。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="R2" title="专家评分录入" description="研究者可录入前测、后测或周次专家评分，作为人工效标与后续统计依据。" />
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
                <span>评分者编号</span>
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
              <textarea rows="4" value={expertRating.comments} onChange={(event) => setExpertRating((prev) => ({ ...prev, comments: event.target.value }))} placeholder="记录节奏不稳、小节性问题或对 AI 反馈的人工判断。" />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleExpertRatingSubmit}>
                保存专家评分
              </button>
              <button type="button" className="secondary-button" onClick={loadDashboardData}>
                刷新研究总览
              </button>
              <a className="secondary-link" href="/api/erhu/research/export?format=csv" target="_blank" rel="noreferrer">
                导出 CSV
              </a>
              <a className="secondary-link" href="/api/erhu/research/export?format=json" target="_blank" rel="noreferrer">
                导出 JSON
              </a>
            </div>
          </section>

          <section className="panel-card dashboard-span">
            <SectionTitle step="R3" title="参与者列表" description="汇总展示每位受试的系统增益、量表情况和专家评分完成状态，便于后续筛选与统计。" />
            {dashboardLoading ? (
              <div className="empty-card">正在加载参与者列表...</div>
            ) : researchParticipants.length ? (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>受试编号</th>
                      <th>组别</th>
                      <th>分析数</th>
                      <th>系统音准增益</th>
                      <th>系统节奏增益</th>
                      <th>有用性</th>
                      <th>持续使用意愿</th>
                      <th>专家前测音准</th>
                      <th>专家后测音准</th>
                      <th>最近活跃</th>
                    </tr>
                  </thead>
                  <tbody>
                    {researchParticipants.map((participant) => (
                      <tr key={participant.participantId}>
                        <td>{participant.participantId}</td>
                        <td>{participant.groupId === "experimental" ? "实验组" : "对照组"}</td>
                        <td>{participant.analysisCount}</td>
                        <td>{participant.pitchGain == null ? "—" : participant.pitchGain}</td>
                        <td>{participant.rhythmGain == null ? "—" : participant.rhythmGain}</td>
                        <td>{participant.usefulness ?? "—"}</td>
                        <td>{participant.continuance ?? "—"}</td>
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
          </section>
        </div>
      ) : null}
    </div>
  );
}
