import { useEffect, useMemo, useRef, useState } from "react";
import { playReferenceNotes, unlockAudio } from "./audioSynth";

const SESSION_STAGE_OPTIONS = [
  { value: "pretest", label: "前测" },
  { value: "week1", label: "第1周" },
  { value: "week2", label: "第2周" },
  { value: "week3", label: "第3周" },
  { value: "week4", label: "第4周" },
  { value: "week5", label: "第5周" },
  { value: "week6", label: "第6周" },
  { value: "week7", label: "第7周" },
  { value: "week8", label: "第8周" },
  { value: "posttest", label: "后测" },
];

const EXPERIENCE_QUESTIONS = [
  { key: "usefulness", label: "AI反馈对本次练习有帮助" },
  { key: "easeOfUse", label: "系统易于理解和操作" },
  { key: "feedbackClarity", label: "错音/错拍提示清楚" },
  { key: "confidence", label: "使用后更有信心改进演奏" },
  { key: "continuance", label: "愿意继续在课后练习中使用" },
];

const DEFAULT_EXPERIENCE = Object.fromEntries(EXPERIENCE_QUESTIONS.map((item) => [item.key, 3]));

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatDateTime(value) {
  if (!value) return "尚未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(safeNumber(value))));
}

function getAudioMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder?.isTypeSupported) {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
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

function ScoreBadge({ label, value, accent }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong style={{ color: accent }}>{clampScore(value)}</strong>
    </div>
  );
}

function RangeQuestion({ label, value, onChange }) {
  return (
    <label className="range-question">
      <span>{label}</span>
      <div className="range-row">
        <input
          type="range"
          min="1"
          max="5"
          step="1"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <strong>{value}</strong>
      </div>
    </label>
  );
}

export default function App() {
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
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("系统已准备，可进行曲目选择与录音。");
  const [experienceScales, setExperienceScales] = useState(DEFAULT_EXPERIENCE);
  const [experienceNotes, setExperienceNotes] = useState("");
  const [questionnaireSaving, setQuestionnaireSaving] = useState(false);
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
      } catch {
        // noop
      }
    }
  }, []);

  useEffect(() => {
    if (participantId.trim()) {
      localStorage.setItem(
        "ai-erhu.participant",
        JSON.stringify({ participantId: participantId.trim(), groupId, sessionStage }),
      );
    }
  }, [participantId, groupId, sessionStage]);

  useEffect(() => {
    fetch("/api/erhu/pieces")
      .then((response) => response.json())
      .then((json) => {
        const nextPieces = Array.isArray(json?.pieces) ? json.pieces : [];
        setPieces(nextPieces);
        if (!selectedPieceId && nextPieces[0]) {
          setSelectedPieceId(nextPieces[0].pieceId);
          setSelectedSectionId(nextPieces[0].sections?.[0]?.sectionId || "");
        }
      })
      .catch(() => {
        setErrorMessage("曲目包加载失败，请检查后端服务是否启动。");
      });
  }, [selectedPieceId]);

  useEffect(() => {
    if (!participantId.trim()) {
      setParticipantRecord(null);
      return;
    }
    fetch(`/api/erhu/study-records/${encodeURIComponent(participantId.trim())}`)
      .then((response) => response.json())
      .then((json) => setParticipantRecord(json?.participant || null))
      .catch(() => {});
  }, [participantId]);

  useEffect(() => () => {
    try {
      stopDemoRef.current?.();
    } catch {}
  }, []);

  useEffect(() => {
    if (!audioFile) return undefined;
    const objectUrl = URL.createObjectURL(audioFile);
    setAudioPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [audioFile]);

  const selectedPiece = useMemo(
    () => pieces.find((piece) => piece.pieceId === selectedPieceId) || null,
    [pieces, selectedPieceId],
  );
  const selectedSection = useMemo(
    () => selectedPiece?.sections?.find((section) => section.sectionId === selectedSectionId) || null,
    [selectedPiece, selectedSectionId],
  );

  async function refreshParticipantRecord() {
    if (!participantId.trim()) return;
    try {
      const response = await fetch(`/api/erhu/study-records/${encodeURIComponent(participantId.trim())}`);
      const json = await response.json();
      setParticipantRecord(json?.participant || null);
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
      const audioDataUrl = await fileToDataUrl(audioFile);
      const response = await fetch("/api/erhu/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        }),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "分析失败");
      }
      setAnalysis(json.analysis || null);
      setStatusMessage(json.analysis?.analysisMode === "external"
        ? "深度学习分析已完成，可查看错音/错拍并进行重练。"
        : "已返回研究原型结果。若配置外部分析器，可切换到深度学习分析。");
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
      const response = await fetch("/api/erhu/study-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantId: participantId.trim(),
          groupId,
          sessionStage,
          experienceScales,
          notes: experienceNotes,
        }),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "提交失败");
      }
      setStatusMessage("学习体验问卷已保存。");
      await refreshParticipantRecord();
    } catch (error) {
      setErrorMessage(error.message || "提交失败");
    } finally {
      setQuestionnaireSaving(false);
    }
  }

  const recentLogs = participantRecord?.usageLogs?.slice(-5).reverse() || [];
  const pretestScore = participantRecord?.pretest?.pitchScore ?? participantRecord?.pretest?.overallPitchScore ?? null;
  const posttestScore = participantRecord?.posttest?.pitchScore ?? participantRecord?.posttest?.overallPitchScore ?? null;
  const rhythmPretest = participantRecord?.pretest?.rhythmScore ?? participantRecord?.pretest?.overallRhythmScore ?? null;
  const rhythmPosttest = participantRecord?.posttest?.rhythmScore ?? participantRecord?.posttest?.overallRhythmScore ?? null;
  const pitchGain = pretestScore != null && posttestScore != null ? clampScore(posttestScore - pretestScore) : null;
  const rhythmGain = rhythmPretest != null && rhythmPosttest != null ? clampScore(rhythmPosttest - rhythmPretest) : null;

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">AI + 音乐教育 + 深度学习</span>
          <h1>AI二胡教学干预研究原型</h1>
          <p>
            本原型服务于 SSCI 导向的教育干预研究，聚焦高校二胡学习者的音准与节奏训练。
            当前反馈为非实时，支持受试登录、曲目任务选择、录音上传、结构化诊断、标准示范回放与学习体验记录。
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
          <ScoreBadge label="分析置信度" value={safeNumber((analysis?.confidence || 0) * 100)} accent="#4338ca" />
        </div>
      </header>

      <div className="status-banner">
        <strong>状态：</strong>{statusMessage}
      </div>
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <div className="grid-layout">
        <section className="panel-card">
          <SectionTitle
            step="01"
            title="登录与受试编号"
            description="填写受试编号、组别与当前阶段，系统会将分析日志写入研究记录表。"
          />
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
              <span>前测音准</span>
              <strong>{pretestScore == null ? "未记录" : `${clampScore(pretestScore)}分`}</strong>
            </div>
            <div>
              <span>后测音准</span>
              <strong>{posttestScore == null ? "未记录" : `${clampScore(posttestScore)}分`}</strong>
            </div>
            <div>
              <span>音准增益</span>
              <strong>{pitchGain == null ? "待形成" : `+${pitchGain}`}</strong>
            </div>
            <div>
              <span>节奏增益</span>
              <strong>{rhythmGain == null ? "待形成" : `+${rhythmGain}`}</strong>
            </div>
          </div>
        </section>

        <section className="panel-card">
          <SectionTitle
            step="02"
            title="曲目与任务选择"
            description="统一采用结构化曲目包，段落内包含标准音高、节拍、音符与示范信息。"
          />
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
          <SectionTitle
            step="03"
            title="录音 / 上传"
            description="支持手机端直接录音，也支持上传既有练习音频。系统只做录制后分析，不提供实时反馈。"
          />
          <div className="action-row">
            <button className="primary-button" onClick={recording ? stopRecording : startRecording}>
              {recording ? "结束录音" : "开始录音"}
            </button>
            <button className="secondary-button" onClick={() => fileInputRef.current?.click()}>
              上传音频
            </button>
            <button className="secondary-button" onClick={handleAnalyze} disabled={analysisLoading}>
              {analysisLoading ? "分析中..." : "开始诊断"}
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
              你的浏览器不支持音频预览。
            </audio>
          ) : null}
        </section>

        <section className="panel-card">
          <SectionTitle
            step="04"
            title="分析结果页"
            description="结果固定为哪一小节 / 哪一个音存在问题，并给出音准方向、节奏偏差和结构化置信度。"
          />
          {analysis ? (
            <>
              <div className="result-grid">
                <ScoreBadge label="总音准" value={analysis.overallPitchScore} accent="#0f766e" />
                <ScoreBadge label="总节奏" value={analysis.overallRhythmScore} accent="#b45309" />
                <ScoreBadge label="置信度" value={safeNumber((analysis.confidence || 0) * 100)} accent="#4338ca" />
                <ScoreBadge label="模式" value={analysis.analysisMode === "external" ? 100 : 68} accent="#7c3aed" />
              </div>
              <div className="findings-grid">
                <div className="finding-card">
                  <h3>小节级问题</h3>
                  {(analysis.measureFindings || []).length ? (
                    <ul>
                      {analysis.measureFindings.map((item) => (
                        <li key={`${item.measureIndex}-${item.issueType}`}>
                          <strong>第 {item.measureIndex} 小节：</strong>
                          {item.issueLabel}
                          {item.detail ? `；${item.detail}` : ""}
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
                          {`：第 ${item.measureIndex} 小节，${item.pitchLabel}，${item.rhythmLabel}`}
                        </li>
                      ))}
                    </ul>
                  ) : <p>当前未定位到具体错音。</p>}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-card">
              尚未生成诊断结果。完成录音或上传后，点击“开始诊断”进入研究反馈流程。
            </div>
          )}
        </section>

        <section className="panel-card">
          <SectionTitle
            step="05"
            title="标准示范回放与重练"
            description="示范回放默认播放结构化标准音符序列，便于与结果页对照后立即进行二次练习。"
          />
          <div className="action-row">
            <button className="primary-button" onClick={handlePlayDemo} disabled={!selectedSection}>
              播放标准示范
            </button>
            <button className="secondary-button" onClick={() => setAnalysis(null)}>
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
          <SectionTitle
            step="06"
            title="学习记录与问卷"
            description="该模块用于保存使用日志、学习体验量表与后续访谈线索，服务于教育干预论文分析。"
          />
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
              placeholder="记录本轮练习困难、AI反馈是否清晰，以及是否愿意继续使用。"
            />
          </label>
          <div className="action-row">
            <button className="primary-button" onClick={handleSaveQuestionnaire} disabled={questionnaireSaving}>
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
    </div>
  );
}
