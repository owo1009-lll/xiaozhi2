import {
  clamp,
  createId,
  getArray,
  nowIso,
  safeBoolean,
  safeNumber,
  safeString,
} from "./baseUtils.js";

const REQUIRED_VALIDATION_RATERS = Math.max(1, safeNumber(process.env.ERHU_VALIDATION_RATERS_REQUIRED, 2));
const ADJUDICATION_OVERALL_GAP_THRESHOLD = 2;
const ADJUDICATION_NOTE_F1_THRESHOLD = 0.67;
const ADJUDICATION_MEASURE_F1_THRESHOLD = 0.67;

function normalizeTaskPlanRecord(taskPlan = {}) {
  const status = safeString(taskPlan.status, "assigned");
  return {
    taskId: safeString(taskPlan.taskId),
    stage: safeString(taskPlan.stage, "week1"),
    pieceId: safeString(taskPlan.pieceId),
    sectionId: safeString(taskPlan.sectionId),
    focus: safeString(taskPlan.focus),
    instructions: safeString(taskPlan.instructions),
    practiceTargetMinutes: clamp(safeNumber(taskPlan.practiceTargetMinutes, 30), 0, 600),
    dueDate: safeString(taskPlan.dueDate),
    status,
    assignedBy: safeString(taskPlan.assignedBy, "researcher"),
    createdAt: safeString(taskPlan.createdAt, nowIso()),
    updatedAt: safeString(taskPlan.updatedAt, taskPlan.createdAt || nowIso()),
    completedAt: status === "completed" ? safeString(taskPlan.completedAt, taskPlan.updatedAt || nowIso()) : safeString(taskPlan.completedAt),
  };
}

function normalizeInterviewRecord(interview = {}) {
  return {
    interviewId: safeString(interview.interviewId),
    stage: safeString(interview.stage, "posttest"),
    interviewerId: safeString(interview.interviewerId, "researcher"),
    summary: safeString(interview.summary),
    barriers: safeString(interview.barriers),
    strategyChanges: safeString(interview.strategyChanges),
    representativeQuote: safeString(interview.representativeQuote),
    nextAction: safeString(interview.nextAction),
    followUpNeeded: safeBoolean(interview.followUpNeeded, false),
    submittedAt: safeString(interview.submittedAt, nowIso()),
  };
}

function normalizeInterviewSamplingRecord(sampling = {}) {
  return {
    selected: safeBoolean(sampling.selected, false),
    priority: safeString(sampling.priority, "candidate"),
    reason: safeString(sampling.reason),
    markedBy: safeString(sampling.markedBy, "researcher"),
    updatedAt: safeString(sampling.updatedAt, nowIso()),
  };
}

function toUniqueStringList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => safeString(item).trim()).filter(Boolean)));
  }
  return Array.from(new Set(String(value || "").split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean)));
}

function toUniqueNumberList(value) {
  return Array.from(
    new Set(
      toUniqueStringList(value)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.round(item)),
    ),
  );
}

function calculateBinaryMetrics(systemValues = [], teacherValues = []) {
  const systemSet = new Set(systemValues);
  const teacherSet = new Set(teacherValues);
  const matched = Array.from(teacherSet).filter((item) => systemSet.has(item));
  const precision = systemSet.size ? matched.length / systemSet.size : null;
  const recall = teacherSet.size ? matched.length / teacherSet.size : null;
  const f1 = precision != null && recall != null && (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return {
    matched,
    matchedCount: matched.length,
    missedTeacherValues: Array.from(teacherSet).filter((item) => !systemSet.has(item)),
    extraSystemValues: Array.from(systemSet).filter((item) => !teacherSet.has(item)),
    precision,
    recall,
    f1,
  };
}

function getAnalysisSystemNoteIds(analysis = {}) {
  return Array.from(new Set(getArray(analysis.noteFindings).map((item) => safeString(item.noteId)).filter(Boolean)));
}

function getAnalysisSystemMeasureIndexes(analysis = {}) {
  return Array.from(
    new Set(
      getArray(analysis.measureFindings)
        .map((item) => safeNumber(item.measureIndex))
        .filter((item) => Number.isFinite(item)),
    ),
  );
}

function getAnalysisRecommendedPracticePath(analysis = {}) {
  return safeString(analysis.recommendedPracticePath) || safeString(getArray(analysis.practiceTargets)[0]?.practicePath) || "review-first";
}

function normalizeValidationReview(review = {}) {
  return {
    reviewId: safeString(review.reviewId),
    analysisId: safeString(review.analysisId),
    participantId: safeString(review.participantId),
    groupId: safeString(review.groupId, "experimental"),
    sessionStage: safeString(review.sessionStage),
    pieceId: safeString(review.pieceId),
    sectionId: safeString(review.sectionId),
    raterId: safeString(review.raterId, "expert"),
    overallAgreement: clamp(safeNumber(review.overallAgreement, 0), 0, 5),
    teacherPrimaryPath: safeString(review.teacherPrimaryPath, "review-first"),
    teacherIssueNoteIds: toUniqueStringList(review.teacherIssueNoteIds),
    teacherIssueMeasureIndexes: toUniqueNumberList(review.teacherIssueMeasureIndexes),
    comments: safeString(review.comments),
    noteMatchedCount: safeNumber(review.noteMatchedCount, 0),
    notePrecision: review.notePrecision == null ? null : safeNumber(review.notePrecision, 0),
    noteRecall: review.noteRecall == null ? null : safeNumber(review.noteRecall, 0),
    noteF1: review.noteF1 == null ? null : safeNumber(review.noteF1, 0),
    measureMatchedCount: safeNumber(review.measureMatchedCount, 0),
    measurePrecision: review.measurePrecision == null ? null : safeNumber(review.measurePrecision, 0),
    measureRecall: review.measureRecall == null ? null : safeNumber(review.measureRecall, 0),
    measureF1: review.measureF1 == null ? null : safeNumber(review.measureF1, 0),
    missedTeacherNoteIds: toUniqueStringList(review.missedTeacherNoteIds),
    extraSystemNoteIds: toUniqueStringList(review.extraSystemNoteIds),
    missedTeacherMeasureIndexes: toUniqueNumberList(review.missedTeacherMeasureIndexes),
    extraSystemMeasureIndexes: toUniqueNumberList(review.extraSystemMeasureIndexes),
    systemRecommendedPath: safeString(review.systemRecommendedPath),
    pathAgreement: safeBoolean(review.pathAgreement, false),
    submittedAt: safeString(review.submittedAt, nowIso()),
  };
}

function normalizeAdjudicationRecord(adjudication = {}) {
  return {
    adjudicationId: safeString(adjudication.adjudicationId),
    analysisId: safeString(adjudication.analysisId),
    participantId: safeString(adjudication.participantId),
    groupId: safeString(adjudication.groupId, "experimental"),
    sessionStage: safeString(adjudication.sessionStage),
    pieceId: safeString(adjudication.pieceId),
    sectionId: safeString(adjudication.sectionId),
    adjudicatorId: safeString(adjudication.adjudicatorId, "researcher"),
    sourceRaterIds: toUniqueStringList(adjudication.sourceRaterIds),
    triggerReasons: toUniqueStringList(adjudication.triggerReasons),
    finalPrimaryPath: safeString(adjudication.finalPrimaryPath, "review-first"),
    finalIssueNoteIds: toUniqueStringList(adjudication.finalIssueNoteIds),
    finalIssueMeasureIndexes: toUniqueNumberList(adjudication.finalIssueMeasureIndexes),
    comments: safeString(adjudication.comments),
    noteMatchedCount: safeNumber(adjudication.noteMatchedCount, 0),
    notePrecision: adjudication.notePrecision == null ? null : safeNumber(adjudication.notePrecision, 0),
    noteRecall: adjudication.noteRecall == null ? null : safeNumber(adjudication.noteRecall, 0),
    noteF1: adjudication.noteF1 == null ? null : safeNumber(adjudication.noteF1, 0),
    measureMatchedCount: safeNumber(adjudication.measureMatchedCount, 0),
    measurePrecision: adjudication.measurePrecision == null ? null : safeNumber(adjudication.measurePrecision, 0),
    measureRecall: adjudication.measureRecall == null ? null : safeNumber(adjudication.measureRecall, 0),
    measureF1: adjudication.measureF1 == null ? null : safeNumber(adjudication.measureF1, 0),
    systemRecommendedPath: safeString(adjudication.systemRecommendedPath),
    pathAgreement: safeBoolean(adjudication.pathAgreement, false),
    resolvedAt: safeString(adjudication.resolvedAt, nowIso()),
  };
}

function normalizeParticipantRecord(participant = {}) {
  const questionnaires = Array.isArray(participant.questionnaires)
    ? participant.questionnaires
    : participant.experienceScales?.submittedAt
      ? [participant.experienceScales]
      : [];

  return {
    participantId: safeString(participant.participantId),
    groupId: safeString(participant.groupId, "experimental"),
    createdAt: safeString(participant.createdAt, nowIso()),
    lastActiveAt: safeString(participant.lastActiveAt, participant.createdAt || nowIso()),
    profile:
      participant.profile && typeof participant.profile === "object"
        ? {
            alias: safeString(participant.profile.alias),
            institution: safeString(participant.profile.institution),
            major: safeString(participant.profile.major),
            grade: safeString(participant.profile.grade),
            yearsOfTraining: safeNumber(participant.profile.yearsOfTraining, 0),
            weeklyPracticeMinutes: safeNumber(participant.profile.weeklyPracticeMinutes, 0),
            deviceLabel: safeString(participant.profile.deviceLabel),
            consentSigned: safeBoolean(participant.profile.consentSigned, false),
            notes: safeString(participant.profile.notes),
            updatedAt: safeString(participant.profile.updatedAt, participant.createdAt || nowIso()),
          }
        : null,
    pretest: participant.pretest || null,
    weeklySessions: getArray(participant.weeklySessions),
    posttest: participant.posttest || null,
    experienceScales: participant.experienceScales || null,
    questionnaires,
    usageLogs: getArray(participant.usageLogs),
    taskPlans: getArray(participant.taskPlans).map((item) => normalizeTaskPlanRecord(item)),
    interviews: getArray(participant.interviews).map((item) => normalizeInterviewRecord(item)),
    interviewSampling: normalizeInterviewSamplingRecord(participant.interviewSampling || {}),
    expertRatings:
      participant.expertRatings && typeof participant.expertRatings === "object"
        ? {
            pretest: participant.expertRatings.pretest || null,
            posttest: participant.expertRatings.posttest || null,
            weekly: getArray(participant.expertRatings.weekly),
          }
        : {
            pretest: null,
            posttest: null,
            weekly: [],
          },
  };
}

function ensureParticipantRecord(store, participantId, groupId) {
  let participant = store.participants.find((item) => item.participantId === participantId);
  if (!participant) {
    participant = normalizeParticipantRecord({
      participantId,
      groupId,
      createdAt: nowIso(),
      lastActiveAt: nowIso(),
    });
    store.participants.push(participant);
  } else if (groupId) {
    participant.groupId = groupId;
  }
  participant = Object.assign(participant, normalizeParticipantRecord(participant));
  return participant;
}

function appendAnalysisToParticipant(participant, payload, analysisRecord) {
  const usageLog = {
    analysisId: analysisRecord.analysisId,
    scoreId: analysisRecord.scoreId,
    pieceId: analysisRecord.pieceId,
    sectionId: analysisRecord.sectionId,
    pieceTitle: analysisRecord.pieceTitle,
    sectionTitle: analysisRecord.sectionTitle,
    audioHash: analysisRecord.audioHash,
    sessionStage: analysisRecord.sessionStage,
    overallPitchScore: analysisRecord.overallPitchScore,
    overallRhythmScore: analysisRecord.overallRhythmScore,
    confidence: analysisRecord.confidence,
    at: analysisRecord.createdAt,
  };
  participant.usageLogs = getArray(participant.usageLogs).concat(usageLog).slice(-100);
  participant.lastActiveAt = analysisRecord.createdAt;

  const summary = {
    analysisId: analysisRecord.analysisId,
    scoreId: analysisRecord.scoreId,
    pieceId: analysisRecord.pieceId,
    sectionId: analysisRecord.sectionId,
    pieceTitle: analysisRecord.pieceTitle,
    sectionTitle: analysisRecord.sectionTitle,
    audioHash: analysisRecord.audioHash,
    pitchScore: analysisRecord.overallPitchScore,
    rhythmScore: analysisRecord.overallRhythmScore,
    at: analysisRecord.createdAt,
  };

  if (payload.sessionStage === "pretest") {
    participant.pretest = summary;
    return;
  }
  if (payload.sessionStage === "posttest") {
    participant.posttest = summary;
    return;
  }
  participant.weeklySessions = getArray(participant.weeklySessions).concat({
    stage: payload.sessionStage,
    ...summary,
  }).slice(-24);
}

function applyExperienceScale(participant, payload) {
  const questionnaire = {
    questionnaireId: createId("questionnaire"),
    usefulness: safeNumber(payload.experienceScales?.usefulness, 0),
    easeOfUse: safeNumber(payload.experienceScales?.easeOfUse, 0),
    feedbackClarity: safeNumber(payload.experienceScales?.feedbackClarity, 0),
    confidence: safeNumber(payload.experienceScales?.confidence, 0),
    continuance: safeNumber(payload.experienceScales?.continuance, 0),
    notes: safeString(payload.notes),
    submittedAt: nowIso(),
    sessionStage: safeString(payload.sessionStage),
  };
  const questionnaireIndex = getArray(participant.questionnaires).findIndex(
    (item) => item.sessionStage === questionnaire.sessionStage,
  );
  if (questionnaireIndex >= 0) {
    const current = getArray(participant.questionnaires)[questionnaireIndex];
    participant.questionnaires[questionnaireIndex] = {
      ...current,
      ...questionnaire,
      questionnaireId: current.questionnaireId || questionnaire.questionnaireId,
    };
    participant.experienceScales = participant.questionnaires[questionnaireIndex];
  } else {
    participant.questionnaires = getArray(participant.questionnaires).concat(questionnaire).slice(-24);
    participant.experienceScales = questionnaire;
  }
  participant.lastActiveAt = participant.experienceScales.submittedAt;
}

function applyExpertRating(participant, payload) {
  const rating = {
    ratingId: createId("rating"),
    stage: safeString(payload.stage, "pretest"),
    pitchScore: clamp(safeNumber(payload.pitchScore, 0), 0, 100),
    rhythmScore: clamp(safeNumber(payload.rhythmScore, 0), 0, 100),
    raterId: safeString(payload.raterId, "expert"),
    comments: safeString(payload.comments),
    submittedAt: nowIso(),
  };

  if (rating.stage === "pretest") {
    participant.expertRatings.pretest = rating;
  } else if (rating.stage === "posttest") {
    participant.expertRatings.posttest = rating;
  } else {
    const weekly = getArray(participant.expertRatings.weekly);
    const existingIndex = weekly.findIndex((item) => item.stage === rating.stage && item.raterId === rating.raterId);
    if (existingIndex >= 0) {
      weekly[existingIndex] = {
        ...weekly[existingIndex],
        ...rating,
        ratingId: weekly[existingIndex].ratingId || rating.ratingId,
      };
      participant.expertRatings.weekly = weekly;
    } else {
      participant.expertRatings.weekly = weekly.concat(rating).slice(-24);
    }
  }
  participant.lastActiveAt = rating.submittedAt;
}

function applyParticipantProfile(participant, payload) {
  participant.profile = {
    alias: safeString(payload.profile?.alias),
    institution: safeString(payload.profile?.institution),
    major: safeString(payload.profile?.major),
    grade: safeString(payload.profile?.grade),
    yearsOfTraining: clamp(safeNumber(payload.profile?.yearsOfTraining, 0), 0, 80),
    weeklyPracticeMinutes: clamp(safeNumber(payload.profile?.weeklyPracticeMinutes, 0), 0, 10080),
    deviceLabel: safeString(payload.profile?.deviceLabel),
    consentSigned: safeBoolean(payload.profile?.consentSigned, false),
    notes: safeString(payload.profile?.notes),
    updatedAt: nowIso(),
  };
  participant.lastActiveAt = participant.profile.updatedAt;
}

function applyTaskPlan(participant, payload) {
  const nextTask = normalizeTaskPlanRecord({
    taskId: safeString(payload.taskId) || createId("task"),
    stage: safeString(payload.stage, "week1"),
    pieceId: safeString(payload.pieceId),
    sectionId: safeString(payload.sectionId),
    focus: safeString(payload.focus),
    instructions: safeString(payload.instructions),
    practiceTargetMinutes: safeNumber(payload.practiceTargetMinutes, 30),
    dueDate: safeString(payload.dueDate),
    status: safeString(payload.status, "assigned"),
    assignedBy: safeString(payload.assignedBy, "researcher"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const existingTasks = getArray(participant.taskPlans);
  const taskIndex = existingTasks.findIndex(
    (item) => item.taskId === nextTask.taskId || (!payload.taskId && item.stage === nextTask.stage),
  );

  if (taskIndex >= 0) {
    const current = normalizeTaskPlanRecord(existingTasks[taskIndex]);
    existingTasks[taskIndex] = normalizeTaskPlanRecord({
      ...current,
      ...nextTask,
      taskId: current.taskId || nextTask.taskId,
      createdAt: current.createdAt || nextTask.createdAt,
      completedAt: nextTask.status === "completed" ? nowIso() : current.completedAt,
    });
    participant.taskPlans = existingTasks;
  } else {
    participant.taskPlans = existingTasks.concat(nextTask).slice(-48);
  }

  participant.lastActiveAt = nowIso();
}

function applyInterviewNote(participant, payload) {
  const nextInterview = normalizeInterviewRecord({
    interviewId: safeString(payload.interviewId) || createId("interview"),
    stage: safeString(payload.stage, "posttest"),
    interviewerId: safeString(payload.interviewerId, "researcher"),
    summary: safeString(payload.summary),
    barriers: safeString(payload.barriers),
    strategyChanges: safeString(payload.strategyChanges),
    representativeQuote: safeString(payload.representativeQuote),
    nextAction: safeString(payload.nextAction),
    followUpNeeded: safeBoolean(payload.followUpNeeded, false),
    submittedAt: nowIso(),
  });

  const interviews = getArray(participant.interviews);
  const interviewIndex = interviews.findIndex(
    (item) =>
      item.interviewId === nextInterview.interviewId ||
      (!payload.interviewId && item.stage === nextInterview.stage && item.interviewerId === nextInterview.interviewerId),
  );

  if (interviewIndex >= 0) {
    interviews[interviewIndex] = normalizeInterviewRecord({
      ...interviews[interviewIndex],
      ...nextInterview,
      interviewId: interviews[interviewIndex].interviewId || nextInterview.interviewId,
    });
    participant.interviews = interviews;
  } else {
    participant.interviews = interviews.concat(nextInterview).slice(-24);
  }

  participant.lastActiveAt = nextInterview.submittedAt;
}

function applyInterviewSampling(participant, payload) {
  participant.interviewSampling = normalizeInterviewSamplingRecord({
    selected: payload.selected,
    priority: payload.priority,
    reason: payload.reason,
    markedBy: payload.markedBy,
    updatedAt: nowIso(),
  });
  participant.lastActiveAt = participant.interviewSampling.updatedAt;
}

function matchesAnalysisScope(analysis, scoreId = "", pieceId = "") {
  const normalizedScoreId = safeString(scoreId).trim();
  const normalizedPieceId = safeString(pieceId).trim();
  if (!normalizedScoreId && !normalizedPieceId) return true;
  const analysisScoreId = safeString(analysis?.scoreId);
  const analysisPieceId = safeString(analysis?.pieceId);
  if (normalizedScoreId && (analysisScoreId === normalizedScoreId || analysisPieceId === normalizedScoreId)) {
    return true;
  }
  if (normalizedPieceId && analysisPieceId === normalizedPieceId) {
    return true;
  }
  return false;
}

function buildParticipantView(participant, store, options = {}) {
  const scoreId = safeString(options.scoreId);
  const pieceId = safeString(options.pieceId);
  const hasScope = Boolean(scoreId || pieceId);
  const analyses = store.analyses
    .filter((item) => item.participantId === participant.participantId)
    .filter((item) => matchesAnalysisScope(item, scoreId, pieceId))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const scopedAnalysisIds = new Set(analyses.map((item) => item.analysisId).filter(Boolean));
  const validationReviews = getArray(store.validationReviews)
    .filter((item) => item.participantId === participant.participantId)
    .filter((item) => !hasScope || scopedAnalysisIds.has(item.analysisId))
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));
  const adjudications = getArray(store.adjudications)
    .filter((item) => item.participantId === participant.participantId)
    .filter((item) => !hasScope || scopedAnalysisIds.has(item.analysisId))
    .sort((left, right) => String(right.resolvedAt).localeCompare(String(left.resolvedAt)));

  const pitchGain =
    participant.pretest && participant.posttest
      ? safeNumber(participant.posttest.pitchScore) - safeNumber(participant.pretest.pitchScore)
      : null;
  const rhythmGain =
    participant.pretest && participant.posttest
      ? safeNumber(participant.posttest.rhythmScore) - safeNumber(participant.pretest.rhythmScore)
      : null;

  return {
    ...participant,
    analyses,
    validationReviews,
    adjudications,
    pitchGain,
    rhythmGain,
  };
}

function buildParticipantSummary(participant, store) {
  const view = buildParticipantView(participant, store);
  const latestQuestionnaire = getArray(view.questionnaires)
    .slice()
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)))[0] || null;
  const latestInterview = getArray(view.interviews)
    .slice()
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)))[0] || null;
  const latestValidation = getArray(view.validationReviews)[0] || null;
  const latestAdjudication = getArray(view.adjudications)[0] || null;
  const participantAnalysisIds = new Set(getArray(view.analyses).map((item) => item.analysisId).filter(Boolean));
  const pendingAdjudicationCount = buildPendingAdjudications(store).filter((item) => participantAnalysisIds.has(item.analysisId)).length;
  const adjudicationStatuses = getArray(view.analyses).map((item) => getAdjudicationStatusForAnalysis(store, item.analysisId));
  const adjudicationStatus = adjudicationStatuses.includes("pending")
    ? "pending"
    : adjudicationStatuses.includes("resolved")
      ? "resolved"
      : adjudicationStatuses.includes("not-ready")
        ? "not-ready"
        : "not-needed";
  return {
    participantId: view.participantId,
    groupId: view.groupId,
    createdAt: view.createdAt,
    lastActiveAt: view.lastActiveAt || view.createdAt,
    analysisCount: view.analyses.length,
    weeklySessionCount: getArray(view.weeklySessions).length,
    profileCompleted: Boolean(view.profile?.updatedAt),
    consentSigned: Boolean(view.profile?.consentSigned),
    institution: view.profile?.institution || "",
    grade: view.profile?.grade || "",
    pretestPitch: view.pretest?.pitchScore ?? null,
    posttestPitch: view.posttest?.pitchScore ?? null,
    pretestRhythm: view.pretest?.rhythmScore ?? null,
    posttestRhythm: view.posttest?.rhythmScore ?? null,
    pitchGain: view.pitchGain,
    rhythmGain: view.rhythmGain,
    usefulness: view.experienceScales?.usefulness ?? null,
    easeOfUse: view.experienceScales?.easeOfUse ?? null,
    feedbackClarity: view.experienceScales?.feedbackClarity ?? null,
    confidence: view.experienceScales?.confidence ?? null,
    continuance: view.experienceScales?.continuance ?? null,
    questionnaireCount: getArray(view.questionnaires).length,
    latestQuestionnaireStage: latestQuestionnaire?.sessionStage ?? null,
    taskPlanCount: getArray(view.taskPlans).length,
    completedTaskCount: getArray(view.taskPlans).filter((item) => item.status === "completed").length,
    interviewCount: getArray(view.interviews).length,
    latestInterviewStage: latestInterview?.stage ?? null,
    interviewSamplingSelected: Boolean(view.interviewSampling?.selected),
    interviewSamplingPriority: view.interviewSampling?.priority || "",
    interviewSamplingReason: view.interviewSampling?.reason || "",
    expertPretestPitch: view.expertRatings?.pretest?.pitchScore ?? null,
    expertPosttestPitch: view.expertRatings?.posttest?.pitchScore ?? null,
    expertPretestRhythm: view.expertRatings?.pretest?.rhythmScore ?? null,
    expertPosttestRhythm: view.expertRatings?.posttest?.rhythmScore ?? null,
    validationReviewCount: getArray(view.validationReviews).length,
    latestValidationAt: latestValidation?.submittedAt ?? null,
    averageValidationAgreement:
      getArray(view.validationReviews).length
        ? Number(average(getArray(view.validationReviews).map((item) => item.overallAgreement)).toFixed(2))
        : null,
    latestValidationPathAgreement: latestValidation?.pathAgreement ?? null,
    adjudicationCount: getArray(view.adjudications).length,
    latestAdjudicationAt: latestAdjudication?.resolvedAt ?? null,
    latestAdjudicationPathAgreement: latestAdjudication?.pathAgreement ?? null,
    pendingAdjudicationCount,
    adjudicationStatus,
  };
}

function buildParticipantExportRows(store) {
  return store.participants.map((participant) => buildParticipantSummary(participant, store));
}

function buildQuestionnaireExportRows(store) {
  return store.participants.flatMap((participant) =>
    getArray(participant.questionnaires).map((questionnaire) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      sessionStage: questionnaire.sessionStage,
      usefulness: questionnaire.usefulness,
      easeOfUse: questionnaire.easeOfUse,
      feedbackClarity: questionnaire.feedbackClarity,
      confidence: questionnaire.confidence,
      continuance: questionnaire.continuance,
      notes: questionnaire.notes,
      submittedAt: questionnaire.submittedAt,
    })),
  );
}

function buildExpertRatingExportRows(store) {
  return store.participants.flatMap((participant) => {
    const prePost = [participant.expertRatings?.pretest, participant.expertRatings?.posttest].filter(Boolean);
    const weekly = getArray(participant.expertRatings?.weekly);
    return prePost.concat(weekly).map((rating) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      stage: rating.stage,
      pitchScore: rating.pitchScore,
      rhythmScore: rating.rhythmScore,
      raterId: rating.raterId,
      comments: rating.comments,
      submittedAt: rating.submittedAt,
    }));
  });
}

function buildAnalysisExportRows(store) {
  return store.analyses.map((analysis) => ({
    analysisId: analysis.analysisId,
    participantId: analysis.participantId,
    groupId: analysis.groupId,
    sessionStage: analysis.sessionStage,
    scoreId: analysis.scoreId || "",
    pieceId: analysis.pieceId,
    sectionId: analysis.sectionId,
    audioHash: analysis.audioHash || "",
    overallPitchScore: analysis.overallPitchScore,
    overallRhythmScore: analysis.overallRhythmScore,
    confidence: analysis.confidence,
    recommendedPracticePath: analysis.recommendedPracticePath || "",
    analysisMode: analysis.analysisMode,
    createdAt: analysis.createdAt,
  }));
}

function buildValidationReviewRows(store) {
  return getArray(store.validationReviews).map((review) => ({
    reviewId: review.reviewId,
    analysisId: review.analysisId,
    participantId: review.participantId,
    groupId: review.groupId,
    sessionStage: review.sessionStage,
    pieceId: review.pieceId,
    sectionId: review.sectionId,
    raterId: review.raterId,
    overallAgreement: review.overallAgreement,
    teacherPrimaryPath: review.teacherPrimaryPath,
    systemRecommendedPath: review.systemRecommendedPath,
    pathAgreement: review.pathAgreement,
    noteMatchedCount: review.noteMatchedCount,
    notePrecision: review.notePrecision,
    noteRecall: review.noteRecall,
    noteF1: review.noteF1,
    measureMatchedCount: review.measureMatchedCount,
    measurePrecision: review.measurePrecision,
    measureRecall: review.measureRecall,
    measureF1: review.measureF1,
    teacherIssueNoteIds: getArray(review.teacherIssueNoteIds).join("|"),
    teacherIssueMeasureIndexes: getArray(review.teacherIssueMeasureIndexes).join("|"),
    missedTeacherNoteIds: getArray(review.missedTeacherNoteIds).join("|"),
    extraSystemNoteIds: getArray(review.extraSystemNoteIds).join("|"),
    missedTeacherMeasureIndexes: getArray(review.missedTeacherMeasureIndexes).join("|"),
    extraSystemMeasureIndexes: getArray(review.extraSystemMeasureIndexes).join("|"),
    comments: review.comments,
    submittedAt: review.submittedAt,
  }));
}

function buildAdjudicationRows(store) {
  return getArray(store.adjudications).map((adjudication) => ({
    adjudicationId: adjudication.adjudicationId,
    analysisId: adjudication.analysisId,
    participantId: adjudication.participantId,
    groupId: adjudication.groupId,
    sessionStage: adjudication.sessionStage,
    pieceId: adjudication.pieceId,
    sectionId: adjudication.sectionId,
    adjudicatorId: adjudication.adjudicatorId,
    sourceRaterIds: getArray(adjudication.sourceRaterIds).join("|"),
    triggerReasons: getArray(adjudication.triggerReasons).join("|"),
    finalPrimaryPath: adjudication.finalPrimaryPath,
    systemRecommendedPath: adjudication.systemRecommendedPath,
    pathAgreement: adjudication.pathAgreement,
    noteMatchedCount: adjudication.noteMatchedCount,
    notePrecision: adjudication.notePrecision,
    noteRecall: adjudication.noteRecall,
    noteF1: adjudication.noteF1,
    measureMatchedCount: adjudication.measureMatchedCount,
    measurePrecision: adjudication.measurePrecision,
    measureRecall: adjudication.measureRecall,
    measureF1: adjudication.measureF1,
    finalIssueNoteIds: getArray(adjudication.finalIssueNoteIds).join("|"),
    finalIssueMeasureIndexes: getArray(adjudication.finalIssueMeasureIndexes).join("|"),
    comments: adjudication.comments,
    resolvedAt: adjudication.resolvedAt,
  }));
}

function buildTaskExportRows(store) {
  return store.participants.flatMap((participant) =>
    getArray(participant.taskPlans).map((task) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      taskId: task.taskId,
      stage: task.stage,
      pieceId: task.pieceId,
      sectionId: task.sectionId,
      focus: task.focus,
      instructions: task.instructions,
      practiceTargetMinutes: task.practiceTargetMinutes,
      dueDate: task.dueDate,
      status: task.status,
      assignedBy: task.assignedBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
    })),
  );
}

function buildInterviewExportRows(store) {
  return store.participants.flatMap((participant) =>
    getArray(participant.interviews).map((interview) => ({
      participantId: participant.participantId,
      groupId: participant.groupId,
      interviewId: interview.interviewId,
      stage: interview.stage,
      interviewerId: interview.interviewerId,
      summary: interview.summary,
      barriers: interview.barriers,
      strategyChanges: interview.strategyChanges,
      representativeQuote: interview.representativeQuote,
      nextAction: interview.nextAction,
      followUpNeeded: interview.followUpNeeded,
      submittedAt: interview.submittedAt,
    })),
  );
}

function buildSamplingExportRows(store) {
  return store.participants.map((participant) => ({
    participantId: participant.participantId,
    groupId: participant.groupId,
    selected: Boolean(participant.interviewSampling?.selected),
    priority: participant.interviewSampling?.priority || "",
    reason: participant.interviewSampling?.reason || "",
    markedBy: participant.interviewSampling?.markedBy || "",
    updatedAt: participant.interviewSampling?.updatedAt || "",
    interviewCount: getArray(participant.interviews).length,
  }));
}

function isTaskOverdue(task) {
  if (!task?.dueDate || task.status === "completed") return false;
  const due = new Date(task.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

function buildTaskQualityBoard(store) {
  const rows = [];
  const stageKeys = new Set();
  store.participants.forEach((participant) => {
    getArray(participant.taskPlans).forEach((task) => {
      stageKeys.add(task.stage || "week1");
    });
  });
  const groups = ["experimental", "control"];
  const stages = Array.from(stageKeys).sort((left, right) => String(left).localeCompare(String(right)));

  stages.forEach((stage) => {
    groups.forEach((groupId) => {
      const stageTasks = buildTaskExportRows(store).filter((item) => item.stage === stage && item.groupId === groupId);
      const assigned = stageTasks.length;
      const completed = stageTasks.filter((item) => item.status === "completed").length;
      const inProgress = stageTasks.filter((item) => item.status === "in-progress").length;
      const overdue = stageTasks.filter((item) => isTaskOverdue(item)).length;
      rows.push({
        stage,
        groupId,
        assignedCount: assigned,
        completedCount: completed,
        inProgressCount: inProgress,
        overdueCount: overdue,
        completionRate: assigned ? Number(((completed / assigned) * 100).toFixed(2)) : 0,
      });
    });
  });

  return rows;
}

function buildDataQualityOverview(store) {
  const pendingAdjudications = buildPendingAdjudications(store);
  const pendingAnalysisIds = new Set(pendingAdjudications.map((item) => item.analysisId));
  const reminders = store.participants
    .map((participant) => {
      const missingItems = [];
      const posttestQuestionnaire = getArray(participant.questionnaires).some((item) => item.sessionStage === "posttest");
      const overdueTaskCount = getArray(participant.taskPlans).filter((task) => isTaskOverdue(task)).length;
      const participantAnalysisIds = new Set(
        getArray(store.analyses)
          .filter((analysis) => analysis.participantId === participant.participantId)
          .map((analysis) => analysis.analysisId)
          .filter(Boolean),
      );
      const pendingAdjudicationCount = Array.from(participantAnalysisIds).filter((analysisId) => pendingAnalysisIds.has(analysisId)).length;

      if (!participant.profile?.updatedAt) missingItems.push("profile");
      if (!participant.pretest) missingItems.push("pretest-analysis");
      if (!participant.posttest) missingItems.push("posttest-analysis");
      if (participant.pretest && !participant.expertRatings?.pretest) missingItems.push("pretest-expert-rating");
      if (participant.posttest && !participant.expertRatings?.posttest) missingItems.push("posttest-expert-rating");
      if (participant.posttest && !posttestQuestionnaire) missingItems.push("posttest-questionnaire");
      if (overdueTaskCount > 0) missingItems.push("overdue-task");
      if (participant.interviewSampling?.selected && getArray(participant.interviews).length === 0) missingItems.push("pending-interview");
      if (pendingAdjudicationCount > 0) missingItems.push("pending-adjudication");

      return {
        participantId: participant.participantId,
        groupId: participant.groupId,
        missingItems,
        overdueTaskCount,
        pendingAdjudicationCount,
        interviewSamplingSelected: Boolean(participant.interviewSampling?.selected),
        interviewSamplingPriority: participant.interviewSampling?.priority || "",
        interviewSamplingReason: participant.interviewSampling?.reason || "",
        needsAttention: missingItems.length > 0,
        lastActiveAt: participant.lastActiveAt || participant.createdAt,
      };
    })
    .filter((item) => item.needsAttention)
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));

  const allParticipants = store.participants;
  const samplingRows = buildSamplingExportRows(store);

  return {
    reminderCount: reminders.length,
    missingProfileCount: allParticipants.filter((item) => !item.profile?.updatedAt).length,
    missingPretestCount: allParticipants.filter((item) => !item.pretest).length,
    missingPosttestCount: allParticipants.filter((item) => !item.posttest).length,
    overdueTaskParticipantCount: reminders.filter((item) => item.missingItems.includes("overdue-task")).length,
    pendingInterviewCount: reminders.filter((item) => item.missingItems.includes("pending-interview")).length,
    pendingAdjudicationCount: pendingAdjudications.length,
    samplingCount: samplingRows.filter((item) => item.selected).length,
    samplingCompletedCount: samplingRows.filter((item) => item.selected && item.interviewCount > 0).length,
    reminders,
    taskBoard: buildTaskQualityBoard(store),
    pendingAdjudications,
    samplingRows: samplingRows
      .filter((item) => item.selected)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
  };
}

function buildPendingRatings(store) {
  return store.participants
    .map((participant) => {
      const pendingStages = [];
      if (participant.pretest && !participant.expertRatings?.pretest) {
        pendingStages.push("pretest");
      }
      if (participant.posttest && !participant.expertRatings?.posttest) {
        pendingStages.push("posttest");
      }
      return {
        participantId: participant.participantId,
        groupId: participant.groupId,
        pendingStages,
        lastActiveAt: participant.lastActiveAt || participant.createdAt,
      };
    })
    .filter((item) => item.pendingStages.length)
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));
}

function buildPendingValidationReviews(store) {
  const requiredRaterCount = REQUIRED_VALIDATION_RATERS;
  return store.analyses
    .map((analysis) => {
      const analysisReviews = getArray(store.validationReviews).filter((review) => review.analysisId === analysis.analysisId);
      const uniqueRaters = Array.from(new Set(analysisReviews.map((review) => safeString(review.raterId)).filter(Boolean)));
      return {
        analysis,
        reviewCount: analysisReviews.length,
        uniqueRaterCount: uniqueRaters.length,
        requiredRaterCount,
      };
    })
    .filter((item) => item.uniqueRaterCount < requiredRaterCount)
    .sort((left, right) => String(right.analysis.createdAt).localeCompare(String(left.analysis.createdAt)))
    .map(({ analysis, reviewCount, uniqueRaterCount, requiredRaterCount: requiredCount }) => ({
      analysisId: analysis.analysisId,
      participantId: analysis.participantId,
      groupId: analysis.groupId,
      sessionStage: analysis.sessionStage,
      pieceId: analysis.pieceId,
      sectionId: analysis.sectionId,
      createdAt: analysis.createdAt,
      noteFindingCount: getArray(analysis.noteFindings).length,
      measureFindingCount: getArray(analysis.measureFindings).length,
      recommendedPracticePath: safeString(analysis.recommendedPracticePath),
      reviewCount,
      uniqueRaterCount,
      requiredRaterCount: requiredCount,
    }));
}

function createValidationReview(store, payload) {
  const analysisId = safeString(payload.analysisId).trim();
  const analysis = store.analyses.find((item) => item.analysisId === analysisId);
  if (!analysis) {
    throw new Error("analysis not found.");
  }

  const teacherIssueNoteIds = toUniqueStringList(payload.teacherIssueNoteIds);
  const teacherIssueMeasureIndexes = toUniqueNumberList(payload.teacherIssueMeasureIndexes);
  const systemNoteIds = getAnalysisSystemNoteIds(analysis);
  const systemMeasureIndexes = getAnalysisSystemMeasureIndexes(analysis);
  const noteMetrics = calculateBinaryMetrics(systemNoteIds, teacherIssueNoteIds);
  const measureMetrics = calculateBinaryMetrics(systemMeasureIndexes, teacherIssueMeasureIndexes);
  const systemRecommendedPath = getAnalysisRecommendedPracticePath(analysis);

  return normalizeValidationReview({
    reviewId: safeString(payload.reviewId) || createId("validation"),
    analysisId: analysis.analysisId,
    participantId: analysis.participantId,
    groupId: analysis.groupId,
    sessionStage: analysis.sessionStage,
    pieceId: analysis.pieceId,
    sectionId: analysis.sectionId,
    raterId: safeString(payload.raterId, "expert"),
    overallAgreement: safeNumber(payload.overallAgreement, 0),
    teacherPrimaryPath: safeString(payload.teacherPrimaryPath, "review-first"),
    teacherIssueNoteIds,
    teacherIssueMeasureIndexes,
    comments: safeString(payload.comments),
    noteMatchedCount: noteMetrics.matchedCount,
    notePrecision: noteMetrics.precision,
    noteRecall: noteMetrics.recall,
    noteF1: noteMetrics.f1,
    measureMatchedCount: measureMetrics.matchedCount,
    measurePrecision: measureMetrics.precision,
    measureRecall: measureMetrics.recall,
    measureF1: measureMetrics.f1,
    missedTeacherNoteIds: noteMetrics.missedTeacherValues,
    extraSystemNoteIds: noteMetrics.extraSystemValues,
    missedTeacherMeasureIndexes: measureMetrics.missedTeacherValues,
    extraSystemMeasureIndexes: measureMetrics.extraSystemValues,
    systemRecommendedPath,
    pathAgreement: safeString(payload.teacherPrimaryPath, "review-first") === systemRecommendedPath,
    submittedAt: nowIso(),
  });
}

function computeAdjudicationReasonsFromPair(pair = {}) {
  const reasons = [];
  if (!safeBoolean(pair.pathMatch, false)) {
    reasons.push("practice-path mismatch");
  }
  if (safeNumber(pair.overallAgreementGap, 0) >= ADJUDICATION_OVERALL_GAP_THRESHOLD) {
    reasons.push("overall-agreement gap >= 2");
  }
  if (pair.noteOverlapF1 != null && safeNumber(pair.noteOverlapF1, 1) < ADJUDICATION_NOTE_F1_THRESHOLD) {
    reasons.push("note-overlap F1 < 0.67");
  }
  if (pair.measureOverlapF1 != null && safeNumber(pair.measureOverlapF1, 1) < ADJUDICATION_MEASURE_F1_THRESHOLD) {
    reasons.push("measure-overlap F1 < 0.67");
  }
  return reasons;
}

function buildValidationPairRecords(store) {
  return store.analyses
    .map((analysis) => {
      const latestByRater = new Map();
      getArray(store.validationReviews)
        .filter((review) => review.analysisId === analysis.analysisId)
        .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)))
        .forEach((review) => {
          const raterId = safeString(review.raterId);
          if (raterId && !latestByRater.has(raterId)) {
            latestByRater.set(raterId, review);
          }
        });

      const sourceReviews = Array.from(latestByRater.values())
        .slice(0, REQUIRED_VALIDATION_RATERS)
        .sort((left, right) => safeString(left.raterId).localeCompare(safeString(right.raterId)));

      if (sourceReviews.length < REQUIRED_VALIDATION_RATERS) {
        return null;
      }

      const [first, second] = sourceReviews;
      const noteOverlap = calculateBinaryMetrics(first.teacherIssueNoteIds, second.teacherIssueNoteIds);
      const measureOverlap = calculateBinaryMetrics(first.teacherIssueMeasureIndexes, second.teacherIssueMeasureIndexes);
      const pair = {
        analysisId: analysis.analysisId,
        participantId: analysis.participantId,
        groupId: analysis.groupId,
        sessionStage: analysis.sessionStage,
        pieceId: analysis.pieceId,
        sectionId: analysis.sectionId,
        scoreUnit: `${analysis.pieceId}/${analysis.sectionId}`,
        sourceRaterIds: sourceReviews.map((item) => item.raterId),
        raterAId: first.raterId,
        raterBId: second.raterId,
        overallAgreementA: first.overallAgreement,
        overallAgreementB: second.overallAgreement,
        overallAgreementGap: Math.abs(safeNumber(first.overallAgreement) - safeNumber(second.overallAgreement)),
        teacherPrimaryPathA: first.teacherPrimaryPath,
        teacherPrimaryPathB: second.teacherPrimaryPath,
        pathMatch: safeString(first.teacherPrimaryPath) === safeString(second.teacherPrimaryPath),
        noteOverlapPrecision: noteOverlap.precision,
        noteOverlapRecall: noteOverlap.recall,
        noteOverlapF1: noteOverlap.f1,
        measureOverlapPrecision: measureOverlap.precision,
        measureOverlapRecall: measureOverlap.recall,
        measureOverlapF1: measureOverlap.f1,
      };
      const reasons = computeAdjudicationReasonsFromPair(pair);
      return {
        ...pair,
        adjudicationReason: reasons.join(" | "),
        requiresAdjudication: reasons.length > 0,
      };
    })
    .filter(Boolean);
}

function buildPendingAdjudications(store) {
  const adjudicatedAnalysisIds = new Set(getArray(store.adjudications).map((item) => item.analysisId).filter(Boolean));
  return buildValidationPairRecords(store)
    .filter((item) => item.requiresAdjudication && !adjudicatedAnalysisIds.has(item.analysisId))
    .sort((left, right) => String(right.analysisId).localeCompare(String(left.analysisId)));
}

function buildAdjudicationSummary(store) {
  const pairRecords = buildValidationPairRecords(store);
  const adjudications = getArray(store.adjudications);
  const pendingAdjudications = buildPendingAdjudications(store);

  return {
    pairCount: pairRecords.length,
    adjudicationRequiredCount: pairRecords.filter((item) => item.requiresAdjudication).length,
    pendingAdjudicationCount: pendingAdjudications.length,
    adjudicationResolvedCount: adjudications.length,
    averagePathAgreement: adjudications.length ? Number((adjudications.filter((item) => item.pathAgreement).length / adjudications.length).toFixed(3)) : 0,
    averageNoteF1: adjudications.length ? Number(average(adjudications.map((item) => item.noteF1)).toFixed(3)) : 0,
    averageMeasureF1: adjudications.length ? Number(average(adjudications.map((item) => item.measureF1)).toFixed(3)) : 0,
    pendingAdjudications,
  };
}

function getAdjudicationStatusForAnalysis(store, analysisId) {
  if (getArray(store.adjudications).some((item) => item.analysisId === analysisId)) {
    return "resolved";
  }

  const uniqueRaters = new Set(
    getArray(store.validationReviews)
      .filter((item) => item.analysisId === analysisId)
      .map((item) => safeString(item.raterId))
      .filter(Boolean),
  );

  if (uniqueRaters.size < REQUIRED_VALIDATION_RATERS) {
    return "not-ready";
  }

  const pendingPair = buildPendingAdjudications(store).find((item) => item.analysisId === analysisId);
  return pendingPair ? "pending" : "not-needed";
}

function createAdjudication(store, payload) {
  const analysisId = safeString(payload.analysisId).trim();
  const analysis = store.analyses.find((item) => item.analysisId === analysisId);
  if (!analysis) {
    throw new Error("analysis not found.");
  }

  const sourcePair = buildValidationPairRecords(store).find((item) => item.analysisId === analysisId);
  if (!sourcePair) {
    throw new Error("at least two validation reviews are required before adjudication.");
  }

  const finalIssueNoteIds = toUniqueStringList(payload.finalIssueNoteIds);
  const finalIssueMeasureIndexes = toUniqueNumberList(payload.finalIssueMeasureIndexes);
  const systemNoteIds = getAnalysisSystemNoteIds(analysis);
  const systemMeasureIndexes = getAnalysisSystemMeasureIndexes(analysis);
  const noteMetrics = calculateBinaryMetrics(systemNoteIds, finalIssueNoteIds);
  const measureMetrics = calculateBinaryMetrics(systemMeasureIndexes, finalIssueMeasureIndexes);
  const triggerReasons = toUniqueStringList(payload.triggerReasons).length
    ? toUniqueStringList(payload.triggerReasons)
    : sourcePair.adjudicationReason
      ? sourcePair.adjudicationReason.split(" | ").filter(Boolean)
      : ["manual-review"];
  const systemRecommendedPath = getAnalysisRecommendedPracticePath(analysis);

  return normalizeAdjudicationRecord({
    adjudicationId: safeString(payload.adjudicationId) || createId("adjudication"),
    analysisId: analysis.analysisId,
    participantId: analysis.participantId,
    groupId: analysis.groupId,
    sessionStage: analysis.sessionStage,
    pieceId: analysis.pieceId,
    sectionId: analysis.sectionId,
    adjudicatorId: safeString(payload.adjudicatorId, "researcher"),
    sourceRaterIds: sourcePair.sourceRaterIds,
    triggerReasons,
    finalPrimaryPath: safeString(payload.finalPrimaryPath, "review-first"),
    finalIssueNoteIds,
    finalIssueMeasureIndexes,
    comments: safeString(payload.comments),
    noteMatchedCount: noteMetrics.matchedCount,
    notePrecision: noteMetrics.precision,
    noteRecall: noteMetrics.recall,
    noteF1: noteMetrics.f1,
    measureMatchedCount: measureMetrics.matchedCount,
    measurePrecision: measureMetrics.precision,
    measureRecall: measureMetrics.recall,
    measureF1: measureMetrics.f1,
    systemRecommendedPath,
    pathAgreement: safeString(payload.finalPrimaryPath, "review-first") === systemRecommendedPath,
    resolvedAt: nowIso(),
  });
}

function buildValidationSummary(store) {
  const reviews = getArray(store.validationReviews);
  const analysesWithValidation = Array.from(new Set(reviews.map((item) => item.analysisId).filter(Boolean)));
  const fullyValidatedAnalysisCount = store.analyses.filter((analysis) => {
    const uniqueRaters = new Set(
      reviews.filter((item) => item.analysisId === analysis.analysisId).map((item) => safeString(item.raterId)).filter(Boolean),
    );
    return uniqueRaters.size >= REQUIRED_VALIDATION_RATERS;
  }).length;
  return {
    reviewCount: reviews.length,
    validatedAnalysisCount: analysesWithValidation.length,
    fullyValidatedAnalysisCount,
    requiredRaterCount: REQUIRED_VALIDATION_RATERS,
    averageAgreement: reviews.length ? Number(average(reviews.map((item) => item.overallAgreement)).toFixed(2)) : 0,
    averageNotePrecision: reviews.length ? Number(average(reviews.map((item) => item.notePrecision)).toFixed(3)) : 0,
    averageNoteRecall: reviews.length ? Number(average(reviews.map((item) => item.noteRecall)).toFixed(3)) : 0,
    averageNoteF1: reviews.length ? Number(average(reviews.map((item) => item.noteF1)).toFixed(3)) : 0,
    averageMeasurePrecision: reviews.length ? Number(average(reviews.map((item) => item.measurePrecision)).toFixed(3)) : 0,
    averageMeasureRecall: reviews.length ? Number(average(reviews.map((item) => item.measureRecall)).toFixed(3)) : 0,
    averageMeasureF1: reviews.length ? Number(average(reviews.map((item) => item.measureF1)).toFixed(3)) : 0,
    pathAgreementRate: reviews.length ? Number((reviews.filter((item) => item.pathAgreement).length / reviews.length).toFixed(3)) : 0,
    pendingValidationCount: buildPendingValidationReviews(store).length,
  };
}

function buildExportPayload(store, dataset) {
  const normalizedDataset = safeString(dataset, "participants").toLowerCase();
  if (normalizedDataset === "questionnaires") {
    const rows = buildQuestionnaireExportRows(store);
    const headers = [
      "participantId",
      "groupId",
      "sessionStage",
      "usefulness",
      "easeOfUse",
      "feedbackClarity",
      "confidence",
      "continuance",
      "notes",
      "submittedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "expert-ratings") {
    const rows = buildExpertRatingExportRows(store);
    const headers = ["participantId", "groupId", "stage", "pitchScore", "rhythmScore", "raterId", "comments", "submittedAt"];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "analyses") {
    const rows = buildAnalysisExportRows(store);
    const headers = [
      "analysisId",
      "participantId",
      "groupId",
      "sessionStage",
      "scoreId",
      "pieceId",
      "sectionId",
      "audioHash",
      "overallPitchScore",
      "overallRhythmScore",
      "confidence",
      "recommendedPracticePath",
      "analysisMode",
      "createdAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "validation-reviews") {
    const rows = buildValidationReviewRows(store);
    const headers = [
      "reviewId",
      "analysisId",
      "participantId",
      "groupId",
      "sessionStage",
      "pieceId",
      "sectionId",
      "raterId",
      "overallAgreement",
      "teacherPrimaryPath",
      "systemRecommendedPath",
      "pathAgreement",
      "noteMatchedCount",
      "notePrecision",
      "noteRecall",
      "noteF1",
      "measureMatchedCount",
      "measurePrecision",
      "measureRecall",
      "measureF1",
      "teacherIssueNoteIds",
      "teacherIssueMeasureIndexes",
      "missedTeacherNoteIds",
      "extraSystemNoteIds",
      "missedTeacherMeasureIndexes",
      "extraSystemMeasureIndexes",
      "comments",
      "submittedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "adjudications") {
    const rows = buildAdjudicationRows(store);
    const headers = [
      "adjudicationId",
      "analysisId",
      "participantId",
      "groupId",
      "sessionStage",
      "pieceId",
      "sectionId",
      "adjudicatorId",
      "sourceRaterIds",
      "triggerReasons",
      "finalPrimaryPath",
      "systemRecommendedPath",
      "pathAgreement",
      "noteMatchedCount",
      "notePrecision",
      "noteRecall",
      "noteF1",
      "measureMatchedCount",
      "measurePrecision",
      "measureRecall",
      "measureF1",
      "finalIssueNoteIds",
      "finalIssueMeasureIndexes",
      "comments",
      "resolvedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "tasks") {
    const rows = buildTaskExportRows(store);
    const headers = [
      "participantId",
      "groupId",
      "taskId",
      "stage",
      "pieceId",
      "sectionId",
      "focus",
      "instructions",
      "practiceTargetMinutes",
      "dueDate",
      "status",
      "assignedBy",
      "createdAt",
      "updatedAt",
      "completedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "interviews") {
    const rows = buildInterviewExportRows(store);
    const headers = [
      "participantId",
      "groupId",
      "interviewId",
      "stage",
      "interviewerId",
      "summary",
      "barriers",
      "strategyChanges",
      "representativeQuote",
      "nextAction",
      "followUpNeeded",
      "submittedAt",
    ];
    return { dataset: normalizedDataset, rows, headers };
  }
  if (normalizedDataset === "sampling") {
    const rows = buildSamplingExportRows(store);
    const headers = ["participantId", "groupId", "selected", "priority", "reason", "markedBy", "updatedAt", "interviewCount"];
    return { dataset: normalizedDataset, rows, headers };
  }
  const rows = buildParticipantExportRows(store);
  const headers = [
    "participantId",
    "groupId",
    "createdAt",
    "lastActiveAt",
    "analysisCount",
    "weeklySessionCount",
    "profileCompleted",
    "consentSigned",
    "institution",
    "grade",
    "pretestPitch",
    "posttestPitch",
    "pretestRhythm",
    "posttestRhythm",
    "pitchGain",
    "rhythmGain",
    "usefulness",
    "easeOfUse",
    "feedbackClarity",
    "confidence",
    "continuance",
    "questionnaireCount",
    "latestQuestionnaireStage",
    "taskPlanCount",
    "completedTaskCount",
    "interviewCount",
    "latestInterviewStage",
    "interviewSamplingSelected",
    "interviewSamplingPriority",
    "interviewSamplingReason",
    "expertPretestPitch",
    "expertPosttestPitch",
    "expertPretestRhythm",
    "expertPosttestRhythm",
    "validationReviewCount",
    "averageValidationAgreement",
    "adjudicationCount",
    "pendingAdjudicationCount",
    "adjudicationStatus",
    "latestAdjudicationAt",
    "latestAdjudicationPathAgreement",
  ];
  return { dataset: "participants", rows, headers };
}

function buildGroupOverview(participants = []) {
  const groups = ["experimental", "control"];
  return groups.map((groupId) => {
    const groupParticipants = participants.filter((participant) => participant.groupId === groupId);
    const completed = groupParticipants.filter((participant) => participant.pitchGain != null);
    return {
      groupId,
      participantCount: groupParticipants.length,
      completedPairCount: completed.length,
      averagePitchGain: Number(average(completed.map((participant) => participant.pitchGain)).toFixed(2)),
      averageRhythmGain: Number(average(completed.map((participant) => participant.rhythmGain)).toFixed(2)),
      averageUsefulness: Number(
        average(groupParticipants.map((participant) => participant.experienceScales?.usefulness)).toFixed(2),
      ),
      averageContinuance: Number(
        average(groupParticipants.map((participant) => participant.experienceScales?.continuance)).toFixed(2),
      ),
    };
  });
}

export {
  applyExperienceScale,
  applyExpertRating,
  applyInterviewNote,
  applyInterviewSampling,
  applyParticipantProfile,
  applyTaskPlan,
  appendAnalysisToParticipant,
  buildAdjudicationRows,
  buildAdjudicationSummary,
  buildDataQualityOverview,
  buildExpertRatingExportRows,
  buildExportPayload,
  buildGroupOverview,
  buildInterviewExportRows,
  buildParticipantSummary,
  buildParticipantView,
  buildPendingRatings,
  buildPendingValidationReviews,
  buildQuestionnaireExportRows,
  buildTaskExportRows,
  buildValidationReviewRows,
  buildValidationSummary,
  createAdjudication,
  createValidationReview,
  ensureParticipantRecord,
  normalizeAdjudicationRecord,
  normalizeInterviewRecord,
  normalizeParticipantRecord,
  normalizeTaskPlanRecord,
  normalizeValidationReview,
};
