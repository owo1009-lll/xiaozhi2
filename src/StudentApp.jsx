import { useEffect, useMemo, useRef, useState } from "react";
import { playReferenceNotes, unlockAudio } from "./audioSynth";
import {
  buildIssueSessionPayload,
  clampScore,
  formatMeasureIssueLabelText,
  formatMeasureLabel,
  formatNoteLabel,
  formatPitchLabelText,
  formatPracticePathLabel,
  formatPracticeTargetTitle,
  formatPreprocessModeLabel,
  formatRhythmLabelText,
  formatSectionDisplayName,
  formatSourceLabel,
  getDisplayCombinedScore,
  getDisplayPitchScore,
  getDisplayRhythmScore,
  replaceXmlIdsInText,
} from "./analysisLabels.js";
import {
  createAnalysis,
  fetchAnalyzerStatus,
  fetchLatestPiecePassSummary,
  fetchParticipant,
  fetchScore,
  fetchScoreImportJob,
  importScorePdf,
} from "./researchApi";

function confidenceText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : "未报告";
}

function percentText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : "0%";
}

function importProgressHeadline(job) {
  if (job?.cacheHit) return "已复用旧识谱结果";
  if (job?.omrStatus === "failed") return "识谱失败";
  if (job?.omrStatus === "completed") return "识谱完成";
  if (job?.stage === "omr-running") return "正在识谱";
  return "排队中";
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

function ScoreBadge({ label, value, suffix = "" }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong>
        {clampScore(value)}
        {suffix}
      </strong>
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

function buildScoreDisplayTitle(score, titleHint, scorePdfFile) {
  const rawTitle = String(score?.title || "").trim();
  const suspiciousCount = (rawTitle.match(/�/g) || []).length + (rawTitle.includes("锟") ? 2 : 0);
  const chineseCount = (rawTitle.match(/[\u4e00-\u9fff]/g) || []).length;
  if (rawTitle && !(chineseCount === 0 && suspiciousCount >= 2)) {
    return rawTitle;
  }
  if (titleHint.trim()) return titleHint.trim();
  if (scorePdfFile?.name) {
    return scorePdfFile.name.replace(/\.pdf$/i, "");
  }
  return "已导入曲谱";
}

export default function StudentApp({ onOpenResearch }) {
  const [studentId, setStudentId] = useState("");
  const [scorePdfFile, setScorePdfFile] = useState(null);
  const [titleHint, setTitleHint] = useState("");
  const [scoreJob, setScoreJob] = useState(null);
  const [score, setScore] = useState(null);
  const [selectedSectionId, setSelectedSectionId] = useState("");
  const [audioFile, setAudioFile] = useState(null);
  const [audioDuration, setAudioDuration] = useState(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [participantSnapshot, setParticipantSnapshot] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [piecePassSummary, setPiecePassSummary] = useState(null);
  const [piecePassLoading, setPiecePassLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("先导入 PDF 曲谱，再选择段落并上传演奏音频。");
  const [errorMessage, setErrorMessage] = useState("");
  const [importingScore, setImportingScore] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [separationMode, setSeparationMode] = useState("auto");
  const [analyzerStatus, setAnalyzerStatus] = useState(null);
  const scoreFileInputRef = useRef(null);
  const audioFileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const stopDemoRef = useRef(() => {});

  useEffect(() => {
    const cachedStudentId = localStorage.getItem("ai-erhu.student-id");
    if (cachedStudentId) {
      setStudentId(cachedStudentId);
      return;
    }
    const generated = `student-${Date.now().toString(36)}`;
    setStudentId(generated);
    localStorage.setItem("ai-erhu.student-id", generated);
  }, []);

  useEffect(() => {
    fetchAnalyzerStatus()
      .then((json) => setAnalyzerStatus(json?.analyzer || null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!scoreJob?.jobId || scoreJob?.omrStatus !== "processing") return undefined;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (cancelled) return;
        try {
          const refresh = await fetchScoreImportJob(scoreJob.jobId);
          const nextJob = refresh?.job || null;
          if (!nextJob) continue;
          if (cancelled) return;
          setScoreJob(nextJob);
          if (nextJob?.omrStatus === "processing") {
            const progress = Number(nextJob?.progress);
            setStatusMessage(
              nextJob?.warnings?.[0]
              || (Number.isFinite(progress)
                ? `后台识谱进行中：${Math.max(1, Math.round(progress * 100))}%`
                : "后台识谱进行中，请稍候。"),
            );
            continue;
          }
          return;
        } catch {
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
    if (!scoreJob?.scoreId || scoreJob?.omrStatus !== "completed") return undefined;
    let cancelled = false;
    const loadImportedScore = async () => {
      try {
        const scoreJson = await fetchScore(scoreJob.scoreId);
        if (cancelled) return;
        const nextScore = scoreJson?.score || null;
        setScore(nextScore);
        setSelectedSectionId((current) => current || nextScore?.sections?.[0]?.sectionId || "");
        setStatusMessage(scoreJob?.warnings?.[0] || "曲谱已导入，请选择段落并上传音频。");
      } catch {
        if (!cancelled) {
          setStatusMessage("识谱结果已生成，但曲谱加载失败，请稍后重试。");
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
    setStatusMessage("自动识谱失败，请更换 PDF 或稍后重试。");
    return undefined;
  }, [scoreJob?.error, scoreJob?.omrStatus]);

  useEffect(() => {
    if (studentId.trim()) {
      localStorage.setItem("ai-erhu.student-id", studentId.trim());
    }
  }, [studentId]);

  useEffect(() => {
    if (!studentId.trim()) return;
    refreshParticipantSnapshot(studentId.trim());
  }, [studentId]);

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
      // noop
    }
  }, []);

  useEffect(() => {
    const nextPieceId = score?.pieceId;
    const nextTitle = score?.title;
    if (!nextPieceId && !nextTitle) {
      setPiecePassSummary(null);
      return undefined;
    }

    let disposed = false;
    setPiecePassLoading(true);
    fetchLatestPiecePassSummary({ pieceId: nextPieceId, title: nextTitle })
      .then((json) => {
        if (!disposed) {
          setPiecePassSummary(json?.piecePass || null);
        }
      })
      .catch(() => {
        if (!disposed) {
          setPiecePassSummary(null);
        }
      })
      .finally(() => {
        if (!disposed) {
          setPiecePassLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [score?.pieceId, score?.title]);

  const selectedSection = useMemo(
    () => score?.sections?.find((section) => section.sectionId === selectedSectionId) || null,
    [score, selectedSectionId],
  );

  const recentAnalyses = useMemo(
    () =>
      [...(participantSnapshot?.analyses || [])].sort(
        (left, right) => new Date(right?.createdAt || 0).getTime() - new Date(left?.createdAt || 0).getTime(),
      ),
    [participantSnapshot],
  );

  const recentHistory = useMemo(() => recentAnalyses.slice(0, 6), [recentAnalyses]);

  const historySummary = useMemo(() => {
    const scoped = selectedSectionId ? recentAnalyses.filter((item) => item.sectionId === selectedSectionId) : recentAnalyses;
    const latest = scoped[0] || null;
    const best = scoped.reduce(
      (winner, item) => (winner == null || getDisplayCombinedScore(item) > getDisplayCombinedScore(winner) ? item : winner),
      scoped[0] || null,
    );
    const averagePitch = scoped.length
      ? Math.round(scoped.reduce((sum, item) => sum + getDisplayPitchScore(item), 0) / scoped.length)
      : 0;
    const averageRhythm = scoped.length
      ? Math.round(scoped.reduce((sum, item) => sum + getDisplayRhythmScore(item), 0) / scoped.length)
      : 0;
    return {
      scopedCount: scoped.length,
      latest,
      best,
      averagePitch,
      averageRhythm,
    };
  }, [recentAnalyses, selectedSectionId]);

  const displayScoreTitle = buildScoreDisplayTitle(score, titleHint, scorePdfFile);

  async function refreshParticipantSnapshot(nextParticipantId = studentId) {
    const resolvedParticipantId = String(nextParticipantId || "").trim();
    if (!resolvedParticipantId) return;
    setHistoryLoading(true);
    try {
      const json = await fetchParticipant(resolvedParticipantId);
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
    setStatusMessage("正在导入 PDF 并启动自动识谱，请稍候。");
    try {
      const json = await importScorePdf(scorePdfFile, titleHint.trim());
      const job = json?.job || null;
      setScoreJob(job);
      if (job?.scoreId) {
        const scoreJson = await fetchScore(job.scoreId);
        const nextScore = scoreJson?.score || null;
        setScore(nextScore);
        setSelectedSectionId(nextScore?.sections?.[0]?.sectionId || "");
        setStatusMessage(job?.warnings?.length ? job.warnings[0] : "曲谱已导入，请选择段落并上传音频。");
      } else {
        const refresh = await fetchScoreImportJob(json?.scoreImportJobId || job?.jobId);
        setScoreJob(refresh?.job || job);
        setStatusMessage("识谱任务已提交，页面会自动更新进度。");
      }
    } catch (error) {
      setImportingScore(false);
      setErrorMessage(error.message || "PDF 导入失败。");
    }
  }

  async function handleAudioFile(file) {
    if (!file) return;
    setAudioFile(file);
    setAnalysis(null);
    setErrorMessage("");
    setStatusMessage(`已载入音频：${file.name}`);
    const duration = await getAudioDuration(file);
    setAudioDuration(duration);
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
    if (!audioFile) {
      setErrorMessage("请先上传或录制音频。");
      return;
    }
    setAnalyzing(true);
    setErrorMessage("");
    setStatusMessage("系统正在执行二胡增强、音高和节奏分析，请稍候。");
    try {
      const resolvedStudentId = studentId.trim() || `student-${Date.now().toString(36)}`;
      const json = await createAnalysis({
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
      setAnalysis(json?.analysis || null);
      setStatusMessage("诊断完成，可以查看问题小节、问题音和推荐练习路径。");
      await refreshParticipantSnapshot(resolvedStudentId);
    } catch (error) {
      setErrorMessage(error.message || "分析失败。");
    } finally {
      setAnalyzing(false);
    }
  }

  function handleLoadHistoryItem(item) {
    if (!item) return;
    setAnalysis(item);
    if (item.sectionId) {
      setSelectedSectionId(item.sectionId);
    }
    setStatusMessage("已载入历史诊断结果，可以继续查看反馈或重新录音。");
  }

  async function handlePlayDemo() {
    if (!selectedSection?.notes?.length) return;
    try {
      stopDemoRef.current?.();
      stopDemoRef.current = await playReferenceNotes(selectedSection.notes, selectedSection.tempo);
      setStatusMessage("正在播放示范音，请对照结果页进行重练。");
    } catch {
      setErrorMessage("示范音播放失败。");
    }
  }

  function handleOpenIssueScorePage() {
    if (!analysis || !score || !selectedSection) return;
    const issueSessionId = `issue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(
      `ai-erhu.issue-session.${issueSessionId}`,
      JSON.stringify(buildIssueSessionPayload({ analysis, score, section: selectedSection })),
    );
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "score-issues");
    url.searchParams.set("issueSession", issueSessionId);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">AI ERHU SELF-PRACTICE</span>
          <h1>二胡 AI 练习 App</h1>
          <p>导入 PDF 曲谱，上传演奏音频，系统自动识谱、增强二胡主旋律，并把音高与节奏问题定位到小节和音位。</p>
          <div className="hero-badges">
            <span>PDF 自动识谱</span>
            <span>二胡 / 钢琴分离</span>
            <span>深度学习音高</span>
            <span>深度学习节奏</span>
          </div>
        </div>
        <div className="hero-side">
          <ScoreBadge label="分析器" value={analyzerStatus?.reachable ? 100 : 0} suffix="%" />
          <ScoreBadge label="音高" value={getDisplayPitchScore(analysis)} />
          <ScoreBadge label="节奏" value={getDisplayRhythmScore(analysis)} />
          <button type="button" className="secondary-button" onClick={onOpenResearch}>
            进入研究后台
          </button>
        </div>
      </header>

      <div className="status-banner">
        <strong>状态：</strong>
        {statusMessage}
      </div>
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <div className="grid-layout">
        <section className="panel-card">
          <StepTitle step="01" title="导入 PDF 曲谱" description="先导入整份 PDF。识谱完成后，再从自动识别出的段落里选择当前要分析的片段。" />
          <div className="field-grid">
            <label>
              <span>学生编号</span>
              <input value={studentId} onChange={(event) => setStudentId(event.target.value)} placeholder="例如 student-001" />
            </label>
            <label>
              <span>标题提示</span>
              <input value={titleHint} onChange={(event) => setTitleHint(event.target.value)} placeholder="可留空，系统会结合 PDF 文件名识别" />
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
          <input ref={scoreFileInputRef} className="hidden-input" type="file" accept="application/pdf" onChange={(event) => setScorePdfFile(event.target.files?.[0] || null)} />
          <div className="upload-meta">
            <span>PDF：{scorePdfFile?.name || "尚未选择 PDF"}</span>
            <span>状态：{scoreJob?.omrStatus || "未开始"}</span>
            <span>识谱置信度：{scoreJob ? confidenceText(scoreJob.omrConfidence) : "未报告"}</span>
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
        </section>

        <section className="panel-card">
          <StepTitle step="02" title="确认识谱结果 / 选段落" description="这里展示整份 PDF 识别出的曲目和可分析段落。系统不会把整页内部原始 ID 直接给学生。" />
          {score ? (
            <>
              <div className="piece-summary">
                <h3>{displayScoreTitle}</h3>
                <p>声部：{score.selectedPart || "Voice"}</p>
                <p>可分析段落：{score.sections?.length || 0}</p>
              </div>
              <div className="field-grid">
                <label>
                  <span>分析段落</span>
                  <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)}>
                    {(score.sections || []).map((section) => (
                      <option key={section.sectionId} value={section.sectionId}>
                        {formatSectionDisplayName(section)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {selectedSection ? (
                <div className="section-meta">
                  <span>拍号：{selectedSection.meter || "4/4"}</span>
                  <span>速度：♪ = {selectedSection.tempo || 72}</span>
                  <span>音符数：{selectedSection.noteCount || selectedSection.notes?.length || 0}</span>
                  <span>小节数：{selectedSection.measureCount || 0}</span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-card">还没有可用的结构化曲谱。先完成 PDF 导入。</div>
          )}
        </section>

        <section className="panel-card">
          <StepTitle step="03" title="录音或上传演奏" description="支持直接录音或上传音频。检测到伴奏时，系统会优先自动启用二胡增强 / 钢琴抑制。" />
          <div className="action-row">
            <button type="button" className="primary-button" onClick={recording ? stopRecording : startRecording}>
              {recording ? "结束录音" : "开始录音"}
            </button>
            <button type="button" className="secondary-button" onClick={() => audioFileInputRef.current?.click()}>
              上传音频
            </button>
            <button type="button" className="secondary-button" onClick={handleAnalyze} disabled={analyzing}>
              {analyzing ? "分析中..." : "开始诊断"}
            </button>
          </div>
          <input ref={audioFileInputRef} className="hidden-input" type="file" accept="audio/*" onChange={(event) => handleAudioFile(event.target.files?.[0] || null)} />
          <div className="field-grid">
            <label>
              <span>二胡增强 / 钢琴抑制</span>
              <select value={separationMode} onChange={(event) => setSeparationMode(event.target.value)}>
                <option value="auto">自动启用（推荐）</option>
                <option value="erhu-focus">强制启用 erhu-focus</option>
                <option value="off">关闭分离，直接分析原音</option>
              </select>
            </label>
          </div>
          <div className="upload-meta">
            <span>音频：{audioFile?.name || "尚未选择音频"}</span>
            <span>时长：{audioDuration == null ? "待解析" : `${audioDuration.toFixed(1)} 秒`}</span>
          </div>
          {audioPreviewUrl ? <audio controls className="audio-player" src={audioPreviewUrl} /> : null}
        </section>

        <section className="panel-card">
          <StepTitle step="04" title="查看诊断结果" description="结果统一按“小节 / 音位”表达，不再向学生暴露 `xml-m8-n3` 这种内部 ID。" />
          {analysis ? (
            <>
              <div className="result-grid">
                <ScoreBadge label="音高" value={getDisplayPitchScore(analysis)} />
                <ScoreBadge label="节奏" value={getDisplayRhythmScore(analysis)} />
                <ScoreBadge label="综合" value={getDisplayCombinedScore(analysis)} />
                <ScoreBadge label="练习路径" value={formatPracticePathLabel(analysis.recommendedPracticePath)} />
              </div>

              <div className="summary-grid">
                <div className="history-card">
                  <h3>总体判断</h3>
                  <p>{replaceXmlIdsInText(analysis.summaryText || "系统已完成本轮诊断。")}</p>
                  {analysis.teacherComment ? <p className="supporting-copy">{replaceXmlIdsInText(analysis.teacherComment)}</p> : null}
                  <p className="supporting-copy">
                    预处理：{formatPreprocessModeLabel(analysis.separationMode || analysis.diagnostics?.appliedPreprocessMode || "off")}
                  </p>
                </div>
                <div className="history-card">
                  <h3>诊断链路</h3>
                  <p>音高模型：{formatSourceLabel(analysis.diagnostics?.pitchSource)}</p>
                  <p>起拍检测：{formatSourceLabel(analysis.diagnostics?.onsetSource)}</p>
                  <p>节拍跟踪：{formatSourceLabel(analysis.diagnostics?.beatSource)}</p>
                  <p>问题音：{analysis.noteFindings?.length || 0}</p>
                  <p>问题小节：{analysis.measureFindings?.length || 0}</p>
                </div>
              </div>

              <div className="summary-grid">
                <div className="history-card">
                  <h3>优先练习顺序</h3>
                  {(analysis.practiceTargets || []).length ? (
                    <ol className="compact-list practice-list">
                      {(analysis.practiceTargets || []).map((target) => (
                        <li key={`${target.priority}-${target.targetId || target.measureIndex || target.title}`}>
                          <strong>{formatPracticeTargetTitle(target)}</strong>
                          <span className="finding-help">{replaceXmlIdsInText(target.why)}</span>
                          <span className="finding-help">建议：{replaceXmlIdsInText(target.action)}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>当前没有生成明确的优先练习列表。</p>
                  )}
                </div>
                <div className="history-card">
                  <h3>操作</h3>
                  <div className="action-row">
                    <button type="button" className="primary-button" onClick={handleOpenIssueScorePage}>
                      打开问题乐谱页
                    </button>
                    <button type="button" className="secondary-button" onClick={handlePlayDemo} disabled={!selectedSection}>
                      播放示范音
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setAnalysis(null)}>
                      清空本轮结果
                    </button>
                  </div>
                </div>
              </div>

              <div className="findings-grid">
                <div className="finding-card">
                  <h3>问题小节</h3>
                  {(analysis.measureFindings || []).length ? (
                    <ul>
                      {analysis.measureFindings.map((item) => (
                        <li key={`${item.measureIndex}-${item.issueType}`}>
                          <strong>{formatMeasureLabel(item.measureIndex)}</strong>
                          <span className="finding-help">{formatMeasureIssueLabelText(item)}</span>
                          {item.detail ? <span className="finding-help">{item.detail}</span> : null}
                          {item.coachingTip ? <span className="finding-help">建议：{item.coachingTip}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>当前没有明显的小节级问题。</p>
                  )}
                </div>

                <div className="finding-card">
                  <h3>问题音</h3>
                  {(analysis.noteFindings || []).length ? (
                    <ul>
                      {analysis.noteFindings.map((item) => (
                        <li key={`${item.noteId}-${item.measureIndex}`}>
                          <strong>{formatNoteLabel(item.noteId, item.measureIndex)}</strong>
                          <span className="finding-help">
                            {formatPitchLabelText(item.pitchLabel)}，{formatRhythmLabelText(item)}
                          </span>
                          {item.durationErrorMs != null ? (
                            <span className="finding-help">
                              时值偏差：{item.durationErrorMs > 0 ? "+" : ""}
                              {item.durationErrorMs} ms
                            </span>
                          ) : null}
                          {item.why ? <span className="finding-help">{replaceXmlIdsInText(item.why)}</span> : null}
                          {item.action ? <span className="finding-help">建议：{replaceXmlIdsInText(item.action)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>当前没有定位到明确的问题音。</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-card">完成 PDF 导入、选段和音频上传后，点击“开始诊断”。</div>
          )}
        </section>

        <section className="panel-card">
          <StepTitle step="05" title="最近诊断记录" description="这里保留最近几次分析记录，便于回看分数变化和对比不同录音。" />
          <div className="upload-meta">
            <span>学生编号：{studentId || "未设置"}</span>
            <span>历史条数：{recentHistory.length}</span>
            <span>{historyLoading ? "正在刷新..." : "历史已就绪"}</span>
          </div>
          {recentHistory.length ? (
            <>
              <div className="summary-grid">
                <div className="history-card">
                  <h3>当前段落统计</h3>
                  <p>匹配分析次数：{historySummary.scopedCount}</p>
                  <p>平均音高：{historySummary.averagePitch}</p>
                  <p>平均节奏：{historySummary.averageRhythm}</p>
                </div>
                <div className="history-card">
                  <h3>最近一次</h3>
                  {historySummary.latest ? (
                    <>
                      <p>{formatAnalysisTime(historySummary.latest.createdAt)}</p>
                      <p>综合：{getDisplayCombinedScore(historySummary.latest)}</p>
                      <p>路径：{formatPracticePathLabel(historySummary.latest.recommendedPracticePath)}</p>
                      <button type="button" className="secondary-button" onClick={() => handleLoadHistoryItem(historySummary.latest)}>
                        打开最近结果
                      </button>
                    </>
                  ) : (
                    <p>当前没有匹配到当前段落的历史记录。</p>
                  )}
                </div>
                <div className="history-card">
                  <h3>最佳成绩</h3>
                  {historySummary.best ? (
                    <>
                      <p>{formatAnalysisTime(historySummary.best.createdAt)}</p>
                      <p>综合：{getDisplayCombinedScore(historySummary.best)}</p>
                      <p>预处理：{formatPreprocessModeLabel(historySummary.best.diagnostics?.appliedPreprocessMode || historySummary.best.preprocessMode)}</p>
                      <button type="button" className="secondary-button" onClick={() => handleLoadHistoryItem(historySummary.best)}>
                        打开最佳结果
                      </button>
                    </>
                  ) : (
                    <p>当前没有可用的最佳分析记录。</p>
                  )}
                </div>
                <div className="history-card">
                  <h3>整曲深测摘要</h3>
                  {piecePassLoading ? (
                    <p>正在读取当前曲目的整曲摘要...</p>
                  ) : piecePassSummary?.summary ? (
                    <>
                      <p>
                        覆盖：{piecePassSummary.summary.matchedSectionCount}/{piecePassSummary.summary.structuredSectionCount}
                      </p>
                      <p>
                        整曲：{getDisplayCombinedScore(piecePassSummary.summary)} / 路径 {formatPracticePathLabel(piecePassSummary.summary.dominantPracticePath)}
                      </p>
                      <p>
                        音高 {Math.round(Number((piecePassSummary.summary.weightedStudentPitchScore ?? piecePassSummary.summary.weightedPitchScore) || 0))} / 节奏{" "}
                        {Math.round(Number((piecePassSummary.summary.weightedStudentRhythmScore ?? piecePassSummary.summary.weightedRhythmScore) || 0))}
                      </p>
                    </>
                  ) : (
                    <p>当前曲目还没有可用的整曲深测摘要。</p>
                  )}
                </div>
              </div>
              <div className="history-list">
                {recentHistory.map((item) => (
                  <div className="history-item" key={item.analysisId}>
                    <div>
                      <strong>{item.pieceId || "unknown-piece"} / {item.sectionId || "unknown-section"}</strong>
                      <p>
                        音高 {clampScore(getDisplayPitchScore(item))} / 节奏 {clampScore(getDisplayRhythmScore(item))} / 路径 {formatPracticePathLabel(item.recommendedPracticePath)}
                      </p>
                      <p>
                        {formatAnalysisTime(item.createdAt)} / 预处理 {formatPreprocessModeLabel(item.diagnostics?.appliedPreprocessMode || item.preprocessMode || "off")} / 音高模型{" "}
                        {formatSourceLabel(item.diagnostics?.pitchSource)} / 节奏模型 {formatSourceLabel(item.diagnostics?.beatSource || item.diagnostics?.onsetSource)}
                      </p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => handleLoadHistoryItem(item)}>
                      查看结果
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-card">当前还没有历史诊断记录。完成一次上传与分析后，这里会自动出现最近结果。</div>
          )}
        </section>
      </div>
    </div>
  );
}
