import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { playReferenceNotes, unlockAudio } from "./audioSynth";
import {
  batchCreateParticipants,
  createAnalysis,
  fetchAdjudicationSummary,
  fetchAdjudications,
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
  fetchValidationReviews,
  fetchValidationSummary,
  saveAdjudication,
  saveExpertRating,
  saveInterviewNote,
  saveInterviewSampling,
  saveParticipantProfile,
  saveTaskPlan,
  saveStudyRecord,
  saveValidationReview,
} from "./researchApi";
import ResearchChrome from "./research/ResearchChrome.jsx";
import {
  DEFAULT_ADJUDICATION,
  DEFAULT_EXPERIENCE,
  DEFAULT_EXPERT_RATING,
  DEFAULT_INTERVIEW_NOTE,
  DEFAULT_PROFILE,
  DEFAULT_SAMPLING_MARK,
  DEFAULT_TASK_PLAN,
  DEFAULT_VALIDATION_REVIEW,
  fileToDataUrl,
  getAudioDuration,
  getAudioMimeType,
  parseBatchParticipantText,
  safeNumber,
} from "./research/ResearchAppSupport.jsx";

const ResearchWorkspaceTab = lazy(() => import("./research/ResearchWorkspaceTab.jsx"));
const ResearchDashboardTab = lazy(() => import("./research/ResearchDashboardTab.jsx"));
const ResearchProtocolTab = lazy(() => import("./research/ResearchProtocolTab.jsx"));

export default function ResearchApp({ onBackToStudent }) {
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
  const [manualPiecePack, setManualPiecePack] = useState(null);
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
  const [validationReviews, setValidationReviews] = useState([]);
  const [validationSummary, setValidationSummary] = useState(null);
  const [adjudications, setAdjudications] = useState([]);
  const [adjudicationSummary, setAdjudicationSummary] = useState(null);
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
  const [validationSaving, setValidationSaving] = useState(false);
  const [adjudicationSaving, setAdjudicationSaving] = useState(false);
  const [batchImporting, setBatchImporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("系统已就绪，可开始录音、分析与研究数据录入。");
  const [experienceScales, setExperienceScales] = useState(DEFAULT_EXPERIENCE);
  const [experienceNotes, setExperienceNotes] = useState("");
  const [expertRating, setExpertRating] = useState(DEFAULT_EXPERT_RATING);
  const [validationReview, setValidationReview] = useState(DEFAULT_VALIDATION_REVIEW);
  const [adjudication, setAdjudication] = useState(DEFAULT_ADJUDICATION);
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
  const activeScorePack = manualPiecePack?.notes?.length ? manualPiecePack : selectedSection;
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
  const latestValidationReviews = validationReviews.slice(0, 8);
  const latestAdjudications = adjudications.slice(0, 8);
  const participantAnalyses = participantRecord?.analyses || [];
  const participantAdjudications =
    participantRecord?.adjudications?.slice().sort((left, right) => String(right.resolvedAt).localeCompare(String(left.resolvedAt))) || [];
  const requiredValidationRaters = researchOverview?.requiredValidationRaters || validationSummary?.requiredRaterCount || 2;
  const fullyValidatedAnalyses = participantAnalyses.filter((item) => {
    const uniqueRaters = new Set(
      (participantRecord?.validationReviews || [])
        .filter((review) => review.analysisId === item.analysisId)
        .map((review) => review.raterId)
        .filter(Boolean),
    );
    return uniqueRaters.size >= requiredValidationRaters;
  });
  const selectedValidationAnalysis =
    participantAnalyses.find((item) => item.analysisId === validationReview.analysisId) ||
    (analysis && participantAnalyses.find((item) => item.analysisId === analysis.analysisId)) ||
    participantAnalyses[0] ||
    null;
  const selectedValidationReviews =
    participantRecord?.validationReviews
      ?.filter((item) => item.analysisId === selectedValidationAnalysis?.analysisId)
      ?.sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt))) || [];
  const currentValidationRecord =
    selectedValidationReviews.find((item) => item.raterId === validationReview.raterId) || selectedValidationReviews[0] || null;
  const selectedAdjudicationAnalysis =
    fullyValidatedAnalyses.find((item) => item.analysisId === adjudication.analysisId) ||
    fullyValidatedAnalyses.find((item) => item.analysisId === selectedValidationAnalysis?.analysisId) ||
    fullyValidatedAnalyses[0] ||
    null;
  const selectedAdjudicationReviews =
    participantRecord?.validationReviews
      ?.filter((item) => item.analysisId === selectedAdjudicationAnalysis?.analysisId)
      ?.sort((left, right) => String(left.raterId).localeCompare(String(right.raterId))) || [];
  const currentAdjudicationRecord =
    participantAdjudications.find((item) => item.analysisId === selectedAdjudicationAnalysis?.analysisId) || null;
  const selectedPendingAdjudication =
    (researchOverview?.pendingAdjudications || adjudicationSummary?.pendingAdjudications || []).find(
      (item) => item.analysisId === selectedAdjudicationAnalysis?.analysisId,
    ) || null;

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

  useEffect(() => {
    const fallbackAnalysis = analysis || participantAnalyses[0] || null;
    const knownAnalysisIds = new Set(participantAnalyses.map((item) => item.analysisId));
    setValidationReview((prev) => {
      const currentIsValid =
        Boolean(prev.analysisId) &&
        (knownAnalysisIds.has(prev.analysisId) || (analysis?.analysisId && prev.analysisId === analysis.analysisId));

      if (currentIsValid || !fallbackAnalysis?.analysisId) {
        return prev;
      }

      return {
        ...prev,
        analysisId: fallbackAnalysis.analysisId,
        teacherPrimaryPath:
          fallbackAnalysis.recommendedPracticePath ||
          fallbackAnalysis.practiceTargets?.[0]?.practicePath ||
          "review-first",
        teacherIssueNoteIds: "",
        teacherIssueMeasureIndexes: "",
        comments: "",
        overallAgreement: DEFAULT_VALIDATION_REVIEW.overallAgreement,
      };
    });
  }, [analysis, participantAnalyses]);

  useEffect(() => {
    if (!selectedValidationAnalysis?.analysisId) return;

    const existing = selectedValidationReviews.find((item) => item.raterId === validationReview.raterId) || null;
    const defaultTeacherPath =
      selectedValidationAnalysis.recommendedPracticePath ||
      selectedValidationAnalysis.practiceTargets?.[0]?.practicePath ||
      "review-first";

    setValidationReview((prev) => {
      const next = existing
        ? {
            ...prev,
            analysisId: existing.analysisId,
            raterId: existing.raterId || prev.raterId,
            overallAgreement: existing.overallAgreement || DEFAULT_VALIDATION_REVIEW.overallAgreement,
            teacherPrimaryPath: existing.teacherPrimaryPath || defaultTeacherPath,
            teacherIssueNoteIds: (existing.teacherIssueNoteIds || []).join(", "),
            teacherIssueMeasureIndexes: (existing.teacherIssueMeasureIndexes || []).join(", "),
            comments: existing.comments || "",
          }
        : {
            ...prev,
            analysisId: selectedValidationAnalysis.analysisId,
            teacherPrimaryPath: defaultTeacherPath,
            teacherIssueNoteIds: "",
            teacherIssueMeasureIndexes: "",
            comments: "",
            overallAgreement: DEFAULT_VALIDATION_REVIEW.overallAgreement,
          };

      return prev.analysisId === next.analysisId &&
        prev.raterId === next.raterId &&
        prev.overallAgreement === next.overallAgreement &&
        prev.teacherPrimaryPath === next.teacherPrimaryPath &&
        prev.teacherIssueNoteIds === next.teacherIssueNoteIds &&
        prev.teacherIssueMeasureIndexes === next.teacherIssueMeasureIndexes &&
        prev.comments === next.comments
        ? prev
        : next;
    });
  }, [participantRecord, selectedValidationAnalysis, validationReview.raterId]);

  useEffect(() => {
    const fallbackAnalysis = selectedAdjudicationAnalysis || null;
    setAdjudication((prev) => {
      if (!fallbackAnalysis?.analysisId) {
        return prev.analysisId ? { ...DEFAULT_ADJUDICATION, adjudicatorId: prev.adjudicatorId } : prev;
      }

      if (prev.analysisId === fallbackAnalysis.analysisId) {
        return prev;
      }

      return {
        ...prev,
        analysisId: fallbackAnalysis.analysisId,
        finalPrimaryPath:
          fallbackAnalysis.recommendedPracticePath || fallbackAnalysis.practiceTargets?.[0]?.practicePath || "review-first",
        finalIssueNoteIds: "",
        finalIssueMeasureIndexes: "",
        triggerReasons: "",
        comments: "",
      };
    });
  }, [selectedAdjudicationAnalysis]);

  useEffect(() => {
    if (!selectedAdjudicationAnalysis?.analysisId) return;

    setAdjudication((prev) => {
      const next = currentAdjudicationRecord
        ? {
            ...prev,
            analysisId: currentAdjudicationRecord.analysisId,
            adjudicatorId: currentAdjudicationRecord.adjudicatorId || prev.adjudicatorId,
            finalPrimaryPath: currentAdjudicationRecord.finalPrimaryPath || prev.finalPrimaryPath,
            finalIssueNoteIds: (currentAdjudicationRecord.finalIssueNoteIds || []).join(", "),
            finalIssueMeasureIndexes: (currentAdjudicationRecord.finalIssueMeasureIndexes || []).join(", "),
            triggerReasons: (currentAdjudicationRecord.triggerReasons || []).join(" | "),
            comments: currentAdjudicationRecord.comments || "",
          }
        : {
            ...prev,
            analysisId: selectedAdjudicationAnalysis.analysisId,
            finalPrimaryPath:
              selectedAdjudicationAnalysis.recommendedPracticePath ||
              selectedAdjudicationAnalysis.practiceTargets?.[0]?.practicePath ||
              "review-first",
            finalIssueNoteIds: "",
            finalIssueMeasureIndexes: "",
            triggerReasons: selectedPendingAdjudication?.adjudicationReason || "",
            comments: "",
          };

      return prev.analysisId === next.analysisId &&
        prev.adjudicatorId === next.adjudicatorId &&
        prev.finalPrimaryPath === next.finalPrimaryPath &&
        prev.finalIssueNoteIds === next.finalIssueNoteIds &&
        prev.finalIssueMeasureIndexes === next.finalIssueMeasureIndexes &&
        prev.triggerReasons === next.triggerReasons &&
        prev.comments === next.comments
        ? prev
        : next;
    });
  }, [currentAdjudicationRecord, selectedAdjudicationAnalysis, selectedPendingAdjudication]);

  async function loadDashboardData() {
    setDashboardLoading(true);
    try {
      const [
        overviewJson,
        participantsJson,
        qualityJson,
        taskJson,
        interviewJson,
        questionnaireJson,
        ratingsJson,
        validationJson,
        validationSummaryJson,
        adjudicationJson,
        adjudicationSummaryJson,
        pendingJson,
        analyzerJson,
      ] = await Promise.all([
        fetchResearchOverview(),
        fetchResearchParticipants(),
        fetchDataQuality(),
        fetchTasks(),
        fetchInterviews(),
        fetchQuestionnaires(),
        fetchExpertRatings(),
        fetchValidationReviews(),
        fetchValidationSummary(),
        fetchAdjudications(),
        fetchAdjudicationSummary(),
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
      setValidationReviews(validationJson?.reviews || []);
      setValidationSummary(validationSummaryJson?.validationSummary || overviewJson?.overview?.validationSummary || null);
      setAdjudications(adjudicationJson?.adjudications || []);
      setAdjudicationSummary(adjudicationSummaryJson?.adjudicationSummary || overviewJson?.overview?.adjudicationSummary || null);
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
      const json = await createAnalysis({
        participantId: participantId.trim(),
        groupId,
        sessionStage,
        pieceId: selectedPiece.pieceId,
        sectionId: selectedSection.sectionId,
        preprocessMode,
        piecePackOverride: manualPiecePack?.notes?.length ? manualPiecePack : null,
        audioSubmission: {
          name: audioFile.name,
          mimeType: audioFile.type || "audio/webm",
          size: audioFile.size,
          duration: audioDuration,
        },
        audioFile,
      });
      setAnalysis(json.analysis || null);
      setValidationReview((prev) => ({
        ...DEFAULT_VALIDATION_REVIEW,
        raterId: prev.raterId,
        analysisId: json.analysis?.analysisId || "",
        teacherPrimaryPath: json.analysis?.recommendedPracticePath || "review-first",
      }));
      setStatusMessage(
        json.analysis?.analysisMode === "external"
          ? `外部 Python 分析服务已返回结果${preprocessMode === "melody-focus" ? "，并启用了伴奏抑制。" : ""}，可继续查看问题音和问题小节。`
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
    if (!activeScorePack?.notes?.length) return;
    try {
      stopDemoRef.current?.();
      stopDemoRef.current = await playReferenceNotes(activeScorePack.notes, activeScorePack.tempo);
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

  async function handleValidationReviewSubmit() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }
    if (!validationReview.analysisId) {
      setErrorMessage("请先选择要验证的分析记录。");
      return;
    }

    setValidationSaving(true);
    setErrorMessage("");
    try {
      const json = await saveValidationReview({
        analysisId: validationReview.analysisId,
        raterId: validationReview.raterId,
        overallAgreement: validationReview.overallAgreement,
        teacherPrimaryPath: validationReview.teacherPrimaryPath,
        teacherIssueNoteIds: validationReview.teacherIssueNoteIds,
        teacherIssueMeasureIndexes: validationReview.teacherIssueMeasureIndexes,
        comments: validationReview.comments,
      });
      setValidationSummary(json?.validationSummary || null);
      setStatusMessage(`教师标注验证已保存：${json?.review?.raterId || validationReview.raterId}`);
      setValidationReview((prev) => ({
        ...prev,
        analysisId: json?.review?.analysisId || prev.analysisId,
        raterId: json?.review?.raterId || prev.raterId,
        overallAgreement: json?.review?.overallAgreement || prev.overallAgreement,
        teacherPrimaryPath: json?.review?.teacherPrimaryPath || prev.teacherPrimaryPath,
        teacherIssueNoteIds: (json?.review?.teacherIssueNoteIds || []).join(", "),
        teacherIssueMeasureIndexes: (json?.review?.teacherIssueMeasureIndexes || []).join(", "),
        comments: json?.review?.comments || "",
      }));
      await refreshParticipantRecord();
      await loadDashboardData();
    } catch (error) {
      setErrorMessage(error.message || "教师标注验证保存失败。");
    } finally {
      setValidationSaving(false);
    }
  }

  function loadValidationReviewIntoForm(review) {
    if (!review) return;
    setValidationReview((prev) => ({
      ...prev,
      analysisId: review.analysisId || prev.analysisId,
      raterId: review.raterId || prev.raterId,
      overallAgreement: review.overallAgreement || DEFAULT_VALIDATION_REVIEW.overallAgreement,
      teacherPrimaryPath: review.teacherPrimaryPath || prev.teacherPrimaryPath,
      teacherIssueNoteIds: (review.teacherIssueNoteIds || []).join(", "),
      teacherIssueMeasureIndexes: (review.teacherIssueMeasureIndexes || []).join(", "),
      comments: review.comments || "",
    }));
    setStatusMessage(`已载入 ${review.raterId || "teacher"} 的教师验证。`);
  }

  function loadParticipantWorkspace(participant) {
    if (!participant?.participantId) return;
    setParticipantId(participant.participantId);
    setGroupId(participant.groupId || "experimental");
    setActiveTab("workspace");
    setStatusMessage(`已切换到 ${participant.participantId} 的工作台。`);
  }

  async function handleAdjudicationSubmit() {
    if (!participantId.trim()) {
      setErrorMessage("请先填写受试编号。");
      return;
    }
    if (!adjudication.analysisId) {
      setErrorMessage("请先选择要裁决的分析记录。");
      return;
    }

    setAdjudicationSaving(true);
    setErrorMessage("");
    try {
      const json = await saveAdjudication({
        analysisId: adjudication.analysisId,
        adjudicatorId: adjudication.adjudicatorId,
        finalPrimaryPath: adjudication.finalPrimaryPath,
        finalIssueNoteIds: adjudication.finalIssueNoteIds,
        finalIssueMeasureIndexes: adjudication.finalIssueMeasureIndexes,
        triggerReasons: adjudication.triggerReasons,
        comments: adjudication.comments,
      });
      setAdjudicationSummary(json?.adjudicationSummary || null);
      setStatusMessage(`已保存最终裁决：${json?.adjudication?.analysisId || adjudication.analysisId}`);
      setAdjudication((prev) => ({
        ...prev,
        analysisId: json?.adjudication?.analysisId || prev.analysisId,
        adjudicatorId: json?.adjudication?.adjudicatorId || prev.adjudicatorId,
        finalPrimaryPath: json?.adjudication?.finalPrimaryPath || prev.finalPrimaryPath,
        finalIssueNoteIds: (json?.adjudication?.finalIssueNoteIds || []).join(", "),
        finalIssueMeasureIndexes: (json?.adjudication?.finalIssueMeasureIndexes || []).join(", "),
        triggerReasons: (json?.adjudication?.triggerReasons || []).join(" | "),
        comments: json?.adjudication?.comments || "",
      }));
      await refreshParticipantRecord();
      await loadDashboardData();
    } catch (error) {
      setErrorMessage(error.message || "最终裁决保存失败。");
    } finally {
      setAdjudicationSaving(false);
    }
  }

  function loadAdjudicationIntoForm(record) {
    if (!record) return;
    setAdjudication((prev) => ({
      ...prev,
      analysisId: record.analysisId || prev.analysisId,
      adjudicatorId: record.adjudicatorId || prev.adjudicatorId,
      finalPrimaryPath: record.finalPrimaryPath || prev.finalPrimaryPath,
      finalIssueNoteIds: Array.isArray(record.finalIssueNoteIds)
        ? record.finalIssueNoteIds.join(", ")
        : String(record.finalIssueNoteIds || ""),
      finalIssueMeasureIndexes: Array.isArray(record.finalIssueMeasureIndexes)
        ? record.finalIssueMeasureIndexes.join(", ")
        : String(record.finalIssueMeasureIndexes || ""),
      triggerReasons: Array.isArray(record.triggerReasons) ? record.triggerReasons.join(" | ") : String(record.triggerReasons || ""),
      comments: record.comments || "",
    }));
    setStatusMessage(`已载入 ${record.analysisId} 的最终裁决。`);
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
      <ResearchChrome
        activeTab={activeTab}
        analysis={analysis}
        errorMessage={errorMessage}
        installPromptEvent={installPromptEvent}
        onBackToStudent={onBackToStudent}
        onInstallApp={handleInstallApp}
        onTabChange={setActiveTab}
        statusMessage={statusMessage}
      />

      {activeTab === "workspace" ? (
        <Suspense fallback={<div className="empty-card">Loading workspace...</div>}>
          <ResearchWorkspaceTab
            ctx={{
              adjudication,
              adjudicationSaving,
              analysis,
              analysisLoading,
              audioDuration,
              audioFile,
              audioPreviewUrl,
              currentAdjudicationRecord,
              currentValidationRecord,
              experienceNotes,
              experienceScales,
              fileInputRef,
              groupId,
              handleAdjudicationSubmit,
              handleAnalyze,
              handleAudioFile,
              handlePlayDemo,
              handleSaveInterviewNote,
              handleSaveProfile,
              handleSaveQuestionnaire,
              handleSaveSamplingMark,
              handleSaveTaskPlan,
              handleValidationReviewSubmit,
              interviewNote,
              interviewSaving,
              loadAdjudicationIntoForm,
              loadInterviewIntoEditor,
              loadTaskIntoEditor,
              loadValidationReviewIntoForm,
              participantInterviews,
              participantQuestionnaires,
              participantRecord,
              participantTaskPlans,
              participantId,
              pieces,
              preprocessMode,
              profile,
              profileSaving,
              questionnaireSaving,
              recentLogs,
              recording,
              samplingMark,
              samplingSaving,
              selectedAdjudicationAnalysis,
              selectedAdjudicationReviews,
              selectedPendingAdjudication,
              selectedPiece,
              selectedPieceId,
              selectedSection,
              selectedSectionId,
              selectedValidationAnalysis,
              selectedValidationReviews,
              sessionStage,
              setAdjudication,
              setAnalysis,
              setExperienceNotes,
              setExperienceScales,
              setGroupId,
              setInterviewNote,
              setParticipantId,
              setPreprocessMode,
              setProfile,
              setSamplingMark,
              setSelectedPieceId,
              setSelectedSectionId,
              setSessionStage,
              setTaskPlan,
              setValidationReview,
              startRecording,
              stopRecording,
              taskPlan,
              taskPlanSections,
              taskSaving,
              validationReview,
              validationSaving,
            }}
          />
        </Suspense>
      ) : null}

      {activeTab === "dashboard" ? (
        <Suspense fallback={<div className="empty-card">Loading research dashboard...</div>}>
          <ResearchDashboardTab
            dashboardLoading={dashboardLoading}
            researchOverview={researchOverview}
            analyzerStatus={analyzerStatus}
            groupSummaries={groupSummaries}
            expertRating={expertRating}
            setExpertRating={setExpertRating}
            handleExpertRatingSubmit={handleExpertRatingSubmit}
            expertSaving={expertSaving}
            loadDashboardData={loadDashboardData}
            batchImportText={batchImportText}
            setBatchImportText={setBatchImportText}
            handleBatchImport={handleBatchImport}
            batchImporting={batchImporting}
            pendingRatings={pendingRatings}
            loadPendingRating={loadPendingRating}
            validationSummary={validationSummary}
            setParticipantId={setParticipantId}
            setValidationReview={setValidationReview}
            setActiveTab={setActiveTab}
            setStatusMessage={setStatusMessage}
            selectedPiece={selectedPiece}
            selectedSection={selectedSection}
            manualPiecePack={manualPiecePack}
            setManualPiecePack={setManualPiecePack}
            adjudicationSummary={adjudicationSummary}
            setAdjudication={setAdjudication}
            dataQuality={dataQuality}
            loadParticipantWorkspace={loadParticipantWorkspace}
            researchParticipants={researchParticipants}
            latestQuestionnaires={latestQuestionnaires}
            latestValidationReviews={latestValidationReviews}
            latestAdjudications={latestAdjudications}
            latestRatings={latestRatings}
            latestTasks={latestTasks}
            latestInterviews={latestInterviews}
          />
        </Suspense>
      ) : null}

      {activeTab === "protocol" ? (
        <Suspense fallback={<div className="empty-card">Loading protocol...</div>}>
          <ResearchProtocolTab />
        </Suspense>
      ) : null}
    </div>
  );
}
