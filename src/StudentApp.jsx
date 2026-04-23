import { useEffect, useMemo, useRef, useState } from "react";
import { playReferenceNotes, unlockAudio } from "./audioSynth";
import {
  createAnalysis,
  fetchAnalyzerStatus,
  fetchLatestPiecePassSummary,
  fetchParticipant,
  fetchScore,
  fetchScoreImportJob,
  importScorePdf,
} from "./researchApi";

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function confidenceText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : "未报告";
}

function percentText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : "0%";
}

function importStageLabel(value) {
  if (value === "queued") return "已排队";
  if (value === "omr-running") return "按页识谱中";
  if (value === "completed") return "识谱完成";
  if (value === "failed") return "识谱失败";
  return value || "未开始";
}

function formatHitRatio(hits, misses, fallbackRate) {
  const hitCount = Number(hits);
  const missCount = Number(misses);
  if (Number.isFinite(hitCount) && Number.isFinite(missCount) && hitCount + missCount > 0) {
    return `${Math.round((hitCount / (hitCount + missCount)) * 100)}%`;
  }
  const rate = Number(fallbackRate);
  return Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : "0%";
}

function buildOmrProgressSteps(job) {
  const progress = Number(job?.progress || 0);
  const processing = job?.omrStatus === "processing";
  const completed = job?.omrStatus === "completed";
  const failed = job?.omrStatus === "failed";
  const cacheHit = Boolean(job?.cacheHit);
  const mode = String(job?.omrStats?.mode || "");
  const pageCacheChecked = cacheHit
    || mode === "pagewise"
    || mode === "whole-pdf"
    || mode === "reused-score"
    || Number(job?.omrStats?.pageResultCacheHits || 0) > 0
    || Number(job?.omrStats?.pageResultCacheMisses || 0) > 0;

  return [
    {
      key: "queued",
      label: "Queued",
      state: failed ? "done" : (processing || completed || progress > 0 ? "done" : "current"),
    },
    {
      key: "cache",
      label: cacheHit ? "Reuse cached score" : "Check page cache",
      state: failed ? (pageCacheChecked ? "done" : "failed") : (pageCacheChecked ? "done" : (processing ? "current" : "pending")),
    },
    {
      key: "omr",
      label: cacheHit ? "Skip OMR" : (mode === "whole-pdf" ? "Whole-PDF OMR" : "Pagewise OMR"),
      state: failed ? "failed" : (completed ? "done" : (processing ? "current" : "pending")),
    },
    {
      key: "build",
      label: "Build sections",
      state: failed ? "failed" : (completed ? "done" : (processing && progress >= 0.85 ? "current" : "pending")),
    },
  ];
}

function importProgressHeadline(job) {
  if (job?.cacheHit) return "Reuse cached score";
  if (job?.omrStatus === "failed") return "Import failed";
  if (job?.omrStatus === "completed") {
    if (job?.omrStats?.mode === "whole-pdf") return "Whole-PDF OMR complete";
    if (job?.omrStats?.mode === "pagewise") return "Pagewise OMR complete";
    return "Import complete";
  }
  if (job?.stage === "omr-running") return "Running pagewise OMR";
  return "Queued";
}

function practicePathLabel(value) {
  if (value === "pitch-first") return "先修音准";
  if (value === "rhythm-first") return "先修节奏";
  return "先复核";
}

function preprocessModeLabel(value) {
  if (value === "erhu-focus" || value === "melody-focus") return "二胡增强 / 钢琴抑制";
  if (value === "off") return "关闭";
  return value || "自动";
}

function sourceLabel(value) {
  if (value === "torchcrepe") return "torchcrepe";
  if (value === "madmom-rnn-onset") return "madmom RNN onset";
  if (value === "madmom-rnn-onset-relaxed") return "madmom RNN onset";
  if (value === "madmom-rnn-beat") return "madmom RNN beat";
  if (value === "madmom-onset-beat-grid") return "madmom onset beat grid";
  if (value === "librosa-onset") return "librosa onset";
  if (value === "librosa-pyin") return "librosa pYIN";
  if (value === "score-fallback" || value === "score-beat-fallback") return "score fallback";
  if (value === "synthetic") return "synthetic";
  return value || "unknown";
}

function formatAnalysisTime(value) {
  if (!value) return "鏃犳椂闂?";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

function combinedScore(item) {
  return Math.round((Number(item?.overallPitchScore || 0) + Number(item?.overallRhythmScore || 0)) / 2);
}

function displayPitchScore(item) {
  return Math.round(Number(item?.studentPitchScore ?? item?.overallPitchScore ?? 0));
}

function displayRhythmScore(item) {
  return Math.round(Number(item?.studentRhythmScore ?? item?.overallRhythmScore ?? 0));
}

function displayCombinedScore(item) {
  if (item?.studentCombinedScore != null) return Math.round(Number(item.studentCombinedScore || 0));
  if (item?.weightedStudentCombinedScore != null) return Math.round(Number(item.weightedStudentCombinedScore || 0));
  if (item?.weightedCombinedScore != null) return Math.round(Number(item.weightedCombinedScore || 0));
  if (item?.studentPitchScore != null || item?.studentRhythmScore != null) {
    return Math.round((displayPitchScore(item) + displayRhythmScore(item)) / 2);
  }
  return combinedScore(item);
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
  if (value === "rhythm-missing") return "疑似漏音";
  if (value === "rhythm-unstable") return "节奏不稳";
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

function getAudioMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder?.isTypeSupported) return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((item) => window.MediaRecorder.isTypeSupported(item)) || "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
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
            const progressText = Number.isFinite(progress) ? `后台识谱进行中：${Math.max(1, Math.round(progress * 100))}%` : "后台识谱进行中，请稍候。";
            setStatusMessage(nextJob?.warnings?.[0] || progressText);
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
        setStatusMessage(scoreJob?.warnings?.[0] || "曲谱已导入，可继续选择段落并上传音频。");
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
    setStatusMessage(scoreJob?.warnings?.[0] || "自动识谱失败，请更换 PDF 或稍后重试。");
    return undefined;
  }, [scoreJob?.error, scoreJob?.omrStatus, scoreJob?.warnings]);

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
      (winner, item) => (displayCombinedScore(item) > displayCombinedScore(winner) ? item : winner),
      scoped[0] || null,
    );
    const averagePitch = scoped.length
      ? Math.round(scoped.reduce((sum, item) => sum + displayPitchScore(item), 0) / scoped.length)
      : 0;
    const averageRhythm = scoped.length
      ? Math.round(scoped.reduce((sum, item) => sum + displayRhythmScore(item), 0) / scoped.length)
      : 0;
    return {
      scopedCount: scoped.length,
      latest,
      best,
      averagePitch,
      averageRhythm,
    };
  }, [recentAnalyses, selectedSectionId]);

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
    setStatusMessage("正在导入 PDF 并尝试自动识谱，请稍候。");
    try {
      const json = await importScorePdf(scorePdfFile, titleHint.trim());
      const job = json?.job || null;
      setScoreJob(job);
      if (job?.scoreId) {
        const scoreJson = await fetchScore(job.scoreId);
        const nextScore = scoreJson?.score || null;
        setScore(nextScore);
        setSelectedSectionId(nextScore?.sections?.[0]?.sectionId || "");
        setStatusMessage(job?.warnings?.length ? job.warnings[0] : "曲谱已导入，可继续选择段落并上传音频。");
      } else {
        const refresh = await fetchScoreImportJob(json?.scoreImportJobId || job?.jobId);
        setScoreJob(refresh?.job || job);
        setStatusMessage("识谱未完成，请查看错误提示或改用已知曲目 PDF。");
      }
    } catch (error) {
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
      setErrorMessage("请先选择一个段落。");
      return;
    }
    if (!audioFile) {
      setErrorMessage("请先上传或录制音频。");
      return;
    }
    setAnalyzing(true);
    setErrorMessage("");
    setStatusMessage("系统正在执行二胡增强、音高与节奏分析，请稍候。");
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
      setStatusMessage("诊断完成，可查看问题音、问题小节和推荐练习路径。");
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
    setStatusMessage("已载入历史诊断结果，可继续查看反馈或重新录音。");
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

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">AI ERHU SELF-PRACTICE</span>
          <h1>二胡 AI 练习 App</h1>
          <p>上传 PDF 曲谱，系统自动识谱；上传或录制演奏音频后，自动进行二胡增强、音高与节奏诊断，并把问题定位到小节和音符。</p>
          <div className="hero-badges">
            <span>PDF 自动导入</span>
            <span>二胡/钢琴分离</span>
            <span>深度学习音高</span>
            <span>深度学习节奏</span>
          </div>
        </div>
        <div className="hero-side">
          <ScoreBadge label="分析器" value={analyzerStatus?.reachable ? 100 : 0} suffix="%" />
          <ScoreBadge label="音高" value={displayPitchScore(analysis)} />
          <ScoreBadge label="节奏" value={displayRhythmScore(analysis)} />
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
          <StepTitle step="01" title="导入 PDF 曲谱" description="默认主链是 PDF 自动导入。系统会优先尝试自动识谱；若当前 PDF 命中已知曲目，也会自动映射到内置结构化曲库。" />
          <div className="field-grid">
            <label>
              <span>学生编号</span>
              <input value={studentId} onChange={(event) => setStudentId(event.target.value)} placeholder="例如 student-001" />
            </label>
            <label>
              <span>标题提示</span>
              <input value={titleHint} onChange={(event) => setTitleHint(event.target.value)} placeholder="可留空，系统会参考 PDF 文件名" />
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
            <span>导入状态：{scoreJob?.omrStatus || "未开始"}</span>
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
              <div className="omr-step-list">
                {buildOmrProgressSteps(scoreJob).map((step) => (
                  <span key={step.key} className={`omr-step is-${step.state}`}>
                    {step.label}
                  </span>
                ))}
              </div>
              <div className="omr-stats-grid">
                <span>模式：{scoreJob?.omrStats?.mode || "pending"}</span>
                <span>页数：{Number(scoreJob?.omrStats?.pageCount || scoreJob?.previewPages?.length || 0)}</span>
                <span>结果缓存命中率：{formatHitRatio(scoreJob?.omrStats?.pageResultCacheHits, scoreJob?.omrStats?.pageResultCacheMisses, scoreJob?.omrStats?.pageResultCacheHitRate)}</span>
                <span>渲染缓存命中率：{formatHitRatio(scoreJob?.omrStats?.renderCacheHits, scoreJob?.omrStats?.renderCacheMisses, scoreJob?.omrStats?.renderCacheHitRate)}</span>
                <span>页级 OMR 次数：{Number(scoreJob?.omrStats?.pageOmrRuns || 0)}</span>
                <span>工作线程：{Number(scoreJob?.omrStats?.workers || 0)}</span>
              </div>
              {scoreJob?.cacheHit ? <p>本次导入直接复用了已有识谱结果。</p> : null}
            </div>
          ) : null}
          {scoreJob?.sourcePdfPath ? (
            <p className="supporting-copy">
              源文件：<a className="secondary-link" href={scoreJob.sourcePdfPath} target="_blank" rel="noreferrer">打开 PDF</a>
            </p>
          ) : null}
          {scoreJob?.warnings?.length ? (
            <div className="history-card">
              <h3>导入提示</h3>
              <ul>
                {scoreJob.warnings.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="panel-card">
          <StepTitle step="02" title="确认识谱结果 / 选段落" description="导入成功后，从自动识别出的曲目段落中选择一个段落进行分析。" />
          {score ? (
            <>
              <div className="piece-summary">
                <h3>{score.title}</h3>
                <p>scoreId：{score.scoreId}</p>
                <p>声部：{score.selectedPart || "erhu"}</p>
                <p>段落数：{score.sections?.length || 0}</p>
              </div>
              <div className="field-grid">
                <label>
                  <span>分析段落</span>
                  <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)}>
                    {(score.sections || []).map((section) => (
                      <option key={section.sectionId} value={section.sectionId}>
                        {section.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {selectedSection ? (
                <div className="section-meta">
                  <span>节拍：{selectedSection.meter}</span>
                  <span>速度：♩={selectedSection.tempo}</span>
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
          <StepTitle step="03" title="录音或上传演奏" description="支持直接录音或上传音频。若检测到伴奏，系统会优先自动启用二胡增强/钢琴抑制。" />
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
          {audioPreviewUrl ? (
            <audio controls className="audio-player" src={audioPreviewUrl}>
              当前浏览器不支持音频预览。
            </audio>
          ) : null}
        </section>

        <section className="panel-card">
          <StepTitle step="04" title="查看诊断与重练" description="系统会先做二胡增强，再执行深度学习音高/节奏诊断，并输出问题小节、问题音和推荐练习路径。" />
          {analysis ? (
            <>
              <div className="result-grid">
                <ScoreBadge label="音高" value={displayPitchScore(analysis)} />
                <ScoreBadge label="节奏" value={displayRhythmScore(analysis)} />
                <ScoreBadge label="置信度" value={(analysis.confidence || 0) * 100} suffix="%" />
                <ScoreBadge label="分离置信度" value={Number((analysis.separationConfidence ?? analysis.diagnostics?.separationConfidence ?? 0) * 100)} suffix="%" />
              </div>
              <div className="summary-grid">
                <div className="history-card">
                  <h3>总体判断</h3>
                  <p>{analysis.summaryText || "系统已完成诊断。"}</p>
                  {analysis.teacherComment ? <p className="supporting-copy">{analysis.teacherComment}</p> : null}
                  <p className="supporting-copy">
                    推荐路径：{practicePathLabel(analysis.recommendedPracticePath)} / 预处理：{preprocessModeLabel(analysis.diagnostics?.appliedPreprocessMode || "off")}
                  </p>
                </div>
                <div className="history-card">
                  <h3>优先练习顺序</h3>
                  {(analysis.practiceTargets || []).length ? (
                    <ol className="compact-list practice-list">
                      {analysis.practiceTargets.map((target) => (
                        <li key={`${target.priority}-${target.targetId || target.measureIndex || target.title}`}>
                          <strong>{target.title}</strong>
                          <span>{target.why}</span>
                          <span>{target.action}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>当前未生成明确的优先练习列表。</p>
                  )}
                </div>
              </div>

              <div className="summary-grid">
                <div className="history-card">
                  <h3>分离与诊断链</h3>
                  <p>预处理：{preprocessModeLabel(analysis.separationMode || analysis.diagnostics?.appliedPreprocessMode || "off")}</p>
                  <p>分离启用：{(analysis.separationApplied ?? analysis.diagnostics?.separationApplied) ? "是" : "否"}</p>
                  <p>音高模型：{sourceLabel(analysis.diagnostics?.pitchSource)}</p>
                  <p>节奏起点：{sourceLabel(analysis.diagnostics?.onsetSource)}</p>
                  <p>节拍跟踪：{sourceLabel(analysis.diagnostics?.beatSource)}</p>
                  <p>乐谱来源：{analysis.diagnostics?.scoreSource || "unknown"}</p>
                </div>
                <div className="history-card">
                  <h3>本轮分析概览</h3>
                  <p>问题音数：{analysis.noteFindings?.length || 0}</p>
                  <p>问题小节数：{analysis.measureFindings?.length || 0}</p>
                  <p>对齐音符数：{analysis.diagnostics?.alignedNoteCount || 0}</p>
                  <p>建议主线：{practicePathLabel(analysis.recommendedPracticePath)}</p>
                </div>
              </div>

              <div className="findings-grid">
                <div className="finding-card">
                  <h3>问题小节</h3>
                  {(analysis.measureFindings || []).length ? (
                    <ul>
                      {analysis.measureFindings.map((item) => (
                        <li key={`${item.measureIndex}-${item.issueType}`}>
                          <strong>第 {item.measureIndex} 小节：</strong>
                          {measureIssueLabelText(item)}
                          {item.detail ? `（${item.detail}）` : ""}
                          {item.coachingTip ? <span className="finding-help">{`建议：${item.coachingTip}`}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>当前未发现明显的小节级问题。</p>
                  )}
                </div>
                <div className="finding-card">
                  <h3>问题音</h3>
                  {(analysis.noteFindings || []).length ? (
                    <ul>
                      {analysis.noteFindings.map((item) => (
                        <li key={item.noteId}>
                          <strong>{item.noteId}</strong>
                          {`：第 ${item.measureIndex} 小节，${pitchLabelText(item.pitchLabel)}，${rhythmLabelText(item)}`}
                          {item.durationErrorMs != null ? <span className="finding-help">{`时值偏差：${item.durationErrorMs > 0 ? "+" : ""}${item.durationErrorMs} ms`}</span> : null}
                          {item.why ? <span className="finding-help">{`原因：${item.why}`}</span> : null}
                          {item.action ? <span className="finding-help">{`练习建议：${item.action}`}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>当前未定位到明确问题音。</p>
                  )}
                </div>
              </div>

              <div className="action-row">
                <button type="button" className="primary-button" onClick={handlePlayDemo} disabled={!selectedSection}>
                  播放示范音
                </button>
                <button type="button" className="secondary-button" onClick={() => setAnalysis(null)}>
                  清空本轮结果
                </button>
              </div>

              {(analysis.rawAudioPath || analysis.erhuEnhancedAudioPath || analysis.accompanimentResidualPath || analysis.diagnostics?.rawAudioPath || analysis.diagnostics?.erhuEnhancedAudioPath || analysis.diagnostics?.accompanimentResidualPath) ? (
                <div className="summary-grid">
                  {(analysis.rawAudioPath || analysis.diagnostics?.rawAudioPath) ? (
                    <div className="history-card">
                      <h3>原音</h3>
                      <audio controls className="audio-player" src={analysis.rawAudioPath || analysis.diagnostics?.rawAudioPath} />
                    </div>
                  ) : null}
                  {(analysis.erhuEnhancedAudioPath || analysis.diagnostics?.erhuEnhancedAudioPath) ? (
                    <div className="history-card">
                      <h3>二胡增强轨</h3>
                      <audio controls className="audio-player" src={analysis.erhuEnhancedAudioPath || analysis.diagnostics?.erhuEnhancedAudioPath} />
                    </div>
                  ) : null}
                  {(analysis.accompanimentResidualPath || analysis.diagnostics?.accompanimentResidualPath) ? (
                    <div className="history-card">
                      <h3>钢琴残余轨</h3>
                      <audio controls className="audio-player" src={analysis.accompanimentResidualPath || analysis.diagnostics?.accompanimentResidualPath} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-card">完成 PDF 导入、选段和音频上传后，点击“开始诊断”。</div>
          )}
        </section>

        <section className="panel-card">
          <StepTitle step="05" title="最近诊断历史" description="学生端默认保留最近几次分析记录，便于回看分数变化、重新打开旧结果或对比不同录音。" />
          <div className="upload-meta">
            <span>学生编号：{studentId || "未设置"}</span>
            <span>历史条数：{recentHistory.length}</span>
            <span>{historyLoading ? "正在刷新..." : "历史已就绪"}</span>
          </div>
          {recentHistory.length ? (
            <>
              <div className="summary-grid">
                <div className="history-card">
                  <h3>当前段落跟踪</h3>
                  <p>匹配分析次数：{historySummary.scopedCount}</p>
                  <p>平均音高：{historySummary.averagePitch}</p>
                  <p>平均节奏：{historySummary.averageRhythm}</p>
                </div>
                <div className="history-card">
                  <h3>最新一次</h3>
                  {historySummary.latest ? (
                    <>
                      <p>{formatAnalysisTime(historySummary.latest.createdAt)}</p>
                      <p>综合：{displayCombinedScore(historySummary.latest)}</p>
                      <p>路径：{practicePathLabel(historySummary.latest.recommendedPracticePath)}</p>
                      <button type="button" className="secondary-button" onClick={() => handleLoadHistoryItem(historySummary.latest)}>
                        打开最新分析
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
                      <p>综合：{displayCombinedScore(historySummary.best)}</p>
                      <p>分离：{preprocessModeLabel(historySummary.best.diagnostics?.appliedPreprocessMode || historySummary.best.preprocessMode)}</p>
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
                    <p>正在读取当前曲目的整曲摘要…</p>
                  ) : piecePassSummary?.summary ? (
                    <>
                      <p>
                        覆盖：{piecePassSummary.summary.matchedSectionCount}/{piecePassSummary.summary.structuredSectionCount}
                      </p>
                      <p>
                        整曲：{displayCombinedScore(piecePassSummary.summary)} / 路径{" "}
                        {practicePathLabel(piecePassSummary.summary.dominantPracticePath)}
                      </p>
                      <p>
                        音高 {Math.round(Number((piecePassSummary.summary.weightedStudentPitchScore ?? piecePassSummary.summary.weightedPitchScore) || 0))} / 节奏{" "}
                        {Math.round(Number((piecePassSummary.summary.weightedStudentRhythmScore ?? piecePassSummary.summary.weightedRhythmScore) || 0))}
                      </p>
                      <p>{formatAnalysisTime(piecePassSummary.updatedAt)}</p>
                      {(piecePassSummary.summary.weakestSections || []).length ? (
                        <ul>
                          {(piecePassSummary.summary.weakestSections || []).slice(0, 3).map((item) => (
                            <li key={`${item.sectionId}-${item.sequenceIndex}`}>
                              {item.sequenceIndex}. {item.sectionTitle} ({Math.round(Number((item.studentCombinedScore ?? item.combinedScore) || 0))})
                            </li>
                          ))}
                        </ul>
                      ) : null}
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
                      音高 {clampScore(displayPitchScore(item))} · 节奏 {clampScore(displayRhythmScore(item))} ·
                      路径 {practicePathLabel(item.recommendedPracticePath)}
                    </p>
                    <p>
                      {formatAnalysisTime(item.createdAt)} ·
                      预处理 {preprocessModeLabel(item.diagnostics?.appliedPreprocessMode || item.preprocessMode || "off")} ·
                      音高模型 {sourceLabel(item.diagnostics?.pitchSource)} ·
                      节奏模型 {sourceLabel(item.diagnostics?.beatSource || item.diagnostics?.onsetSource)}
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
