import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getErhuPiece, getErhuPieceSummaries, getErhuSection } from "./src/erhuStudyPieces.js";
import { RESEARCH_TEMPLATE_LIBRARY } from "./src/researchProtocolData.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const STUDY_STORE_FILE = path.join(DATA_DIR, "erhu-study-records.json");
const DIST_DIR = path.join(__dirname, "dist");

app.use(express.json({ limit: "30mb" }));

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
}

async function readStudyStore() {
  try {
    const raw = await fs.readFile(STUDY_STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      participants: Array.isArray(parsed.participants) ? parsed.participants.map((item) => normalizeParticipantRecord(item)) : [],
      analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
      validationReviews: Array.isArray(parsed.validationReviews) ? parsed.validationReviews.map((item) => normalizeValidationReview(item)) : [],
    };
  } catch {
    return {
      participants: [],
      analyses: [],
      validationReviews: [],
    };
  }
}

async function writeStudyStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STUDY_STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length;
}

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

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function convertRowsToCsv(headers, rows) {
  const lines = [headers.map((header) => escapeCsvCell(header)).join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCsvCell(row[header])).join(","));
  });
  return lines.join("\n");
}

function getExpectedDurationSeconds(section) {
  const totalBeats = getArray(section?.notes).reduce((sum, note) => sum + safeNumber(note.beatDuration, 0), 0);
  return totalBeats * (60 / Math.max(30, safeNumber(section?.tempo, 72)));
}

function hashString(input) {
  let hash = 0;
  const text = safeString(input);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function pickFromSeed(seed, values = []) {
  if (!values.length) return null;
  return values[Math.abs(seed) % values.length];
}

function buildFallbackExplanation(overallPitchScore, overallRhythmScore, noteFindings, measureFindings) {
  const dominantDimension = overallRhythmScore < overallPitchScore ? "节奏" : "音准";
  const summaryText = `本次录音优先需要处理的是${dominantDimension}问题。系统定位到 ${noteFindings.length} 个问题音和 ${measureFindings.length} 个问题小节。`;
  const topNote = noteFindings[0];
  const topMeasure = measureFindings[0];
  const teacherComment = topNote
    ? `建议先处理 ${topNote.noteId}，确认单音稳定后再回到整段。`
    : topMeasure
      ? `建议先重练第 ${topMeasure.measureIndex} 小节，再回到整段复录。`
      : "当前结果较稳定，可保持当前练习方式。";

  const practiceTargets = [];
  if (topNote) {
    const practicePath =
      topNote.isUncertain || topNote.pitchLabel === "pitch-review"
        ? "review-first"
        : topNote.rhythmLabel !== "rhythm-ok" && topNote.pitchLabel === "pitch-ok"
          ? "rhythm-first"
          : "pitch-first";
    practiceTargets.push({
      priority: 1,
      targetType: "note",
      targetId: topNote.noteId,
      measureIndex: topNote.measureIndex,
      title: `先处理 ${topNote.noteId} 的落点与起拍`,
      why: topNote.why || "该音是当前偏差最集中的位置。",
      action: topNote.action || "先听示范，再做局部循环练习。",
      severity: topNote.severity || "medium",
      evidenceLabel: topNote.evidenceLabel || null,
      practicePath,
      pathReason:
        practicePath === "rhythm-first"
          ? "教师可先检查拍点是否明显偏前或偏后。"
          : practicePath === "pitch-first"
            ? "教师可先检查左手落点是否偏高或偏低。"
            : "系统建议先复核，再决定调整方向。",
    });
  }
  if (topMeasure) {
    const practicePath = topMeasure.issueLabel === "rhythm-unstable" ? "rhythm-first" : "pitch-first";
    practiceTargets.push({
      priority: practiceTargets.length + 1,
      targetType: "measure",
      targetId: `measure-${topMeasure.measureIndex}`,
      measureIndex: topMeasure.measureIndex,
      title: `重练第 ${topMeasure.measureIndex} 小节`,
      why: topMeasure.detail || "该小节内部偏差较集中。",
      action: topMeasure.coachingTip || "先拆拍，再回到整小节练习。",
      severity: topMeasure.severity || "medium",
      evidenceLabel: topMeasure.issueLabel || null,
      practicePath,
      pathReason: practicePath === "rhythm-first" ? "该小节主要反映拍点稳定性问题。" : "该小节主要反映音高稳定性问题。",
    });
  }

  return { summaryText, teacherComment, recommendedPracticePath: practiceTargets[0]?.practicePath || "review-first", practiceTargets };
}

function buildFallbackAnalysis(payload, section) {
  const notes = getArray(section?.notes);
  const measureCount = Math.max(1, ...notes.map((note) => safeNumber(note.measureIndex, 1)));
  const expectedDuration = getExpectedDurationSeconds(section);
  const actualDuration = safeNumber(payload?.audioSubmission?.duration, expectedDuration || 1);
  const ratio = expectedDuration > 0 ? actualDuration / expectedDuration : 1;
  const seed = hashString([
    payload.participantId,
    payload.groupId,
    payload.sessionStage,
    payload.pieceId,
    payload.sectionId,
    payload.audioSubmission?.name,
    payload.audioSubmission?.size,
    payload.audioSubmission?.duration,
  ].join("|"));

  const stageOffset = safeString(payload.sessionStage).startsWith("post") ? 5 : safeString(payload.sessionStage).startsWith("week") ? 2 : -2;
  const pitchBase = 76 + stageOffset + (seed % 9);
  const rhythmPenalty = Math.round(Math.abs(ratio - 1) * 120);
  const rhythmBase = 88 + stageOffset - rhythmPenalty + (seed % 5);
  const overallPitchScore = clamp(pitchBase, 48, 96);
  const overallRhythmScore = clamp(rhythmBase, 42, 96);

  const pitchDirections = [
    { label: "音高偏低", cents: -28 },
    { label: "音高略低", cents: -15 },
    { label: "音高略高", cents: 17 },
    { label: "音高偏高", cents: 31 },
  ];
  const rhythmDirections = [
    { label: "节奏偏早", ms: -82, type: "early" },
    { label: "节奏偏晚", ms: 96, type: "late" },
    { label: "拍点不稳", ms: 0, type: "unstable" },
  ];

  const measureFindings = Array.from({ length: Math.min(3, measureCount) }, (_, index) => {
    const measureIndex = ((seed + index * 7) % measureCount) + 1;
    const rhythmDirection = pickFromSeed(seed + index * 13, rhythmDirections);
    return {
      measureIndex,
      issueType: rhythmDirection.type,
      issueLabel: rhythmDirection.label,
      detail: `该小节与标准速度相比出现约 ${Math.abs(rhythmDirection.ms)} ms 的偏差。`,
    };
  });

  const pickedNotes = notes
    .filter((_, index) => (index + seed) % 4 === 0)
    .slice(0, 4);

  const noteFindings = pickedNotes.map((note, index) => {
    const pitchDirection = pickFromSeed(seed + index * 5, pitchDirections);
    const rhythmDirection = pickFromSeed(seed + index * 11, rhythmDirections);
    const severity = Math.abs(pitchDirection.cents) >= 28 || Math.abs(rhythmDirection.ms) >= 90 ? "high" : "medium";
    return {
      noteId: note.noteId,
      measureIndex: note.measureIndex,
      expectedMidi: note.midiPitch,
      centsError: pitchDirection.cents,
      onsetErrorMs: rhythmDirection.ms,
      pitchLabel: pitchDirection.label,
      rhythmLabel: rhythmDirection.label,
      pitchToleranceCents: 18,
      confidence: clamp(0.62 + ((seed + index) % 10) / 100, 0.55, 0.8),
      isUncertain: false,
      evidenceLabel: "fallback-simulation",
      severity,
      why: `${pitchDirection.label}，并且${rhythmDirection.label}。`,
      action:
        rhythmDirection.type === "late"
          ? "先跟节拍器重练这一音，再回到整小节。"
          : pitchDirection.cents < 0
            ? "先慢速拉长该音，确认落点后再连接前后音。"
            : "先听示范，再做 3 次局部循环练习。",
    };
  });

  const enrichedMeasureFindings = measureFindings.map((item) => ({
    ...item,
    severity: item.issueType === "unstable" ? "medium" : "low",
    coachingTip: item.issueType === "late" ? "先拆拍再回到整小节练习。" : "先放慢速度确认每拍位置。",
  }));

  const demoSegments = Array.from(new Set(enrichedMeasureFindings.map((item) => item.measureIndex))).map((measureIndex) => ({
    measureIndex,
    demoAudio: safeString(section?.demoAudio),
    label: `标准示范 · 第 ${measureIndex} 小节`,
  }));

  const explanation = buildFallbackExplanation(overallPitchScore, overallRhythmScore, noteFindings, enrichedMeasureFindings);

  return {
    overallPitchScore,
    overallRhythmScore,
    measureFindings: enrichedMeasureFindings,
    noteFindings,
    demoSegments,
    confidence: clamp(0.62 + ((seed % 12) / 100), 0.52, 0.78),
    summaryText: explanation.summaryText,
    teacherComment: explanation.teacherComment,
    recommendedPracticePath: explanation.recommendedPracticePath,
    practiceTargets: explanation.practiceTargets,
    analysisMode: "fallback",
  };
}

async function callExternalAnalyzer(payload, section) {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl) return null;
  const response = await fetch(`${analyzerUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participantId: payload.participantId,
      groupId: payload.groupId,
      sessionStage: payload.sessionStage,
      pieceId: payload.pieceId,
      sectionId: payload.sectionId,
      piecePack: section,
      audioSubmission: payload.audioSubmission,
      audioDataUrl: payload.audioDataUrl,
    }),
  });
  if (!response.ok) {
    throw new Error(`外部分析器请求失败：${response.status}`);
  }
  const json = await response.json();
  return json?.analysis || null;
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
    pieceId: analysisRecord.pieceId,
    sectionId: analysisRecord.sectionId,
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
    pieceId: analysisRecord.pieceId,
    sectionId: analysisRecord.sectionId,
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

function buildParticipantView(participant, store) {
  const analyses = store.analyses
    .filter((item) => item.participantId === participant.participantId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const validationReviews = getArray(store.validationReviews)
    .filter((item) => item.participantId === participant.participantId)
    .sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));

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
    pieceId: analysis.pieceId,
    sectionId: analysis.sectionId,
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
  const reminders = store.participants
    .map((participant) => {
      const missingItems = [];
      const posttestQuestionnaire = getArray(participant.questionnaires).some((item) => item.sessionStage === "posttest");
      const overdueTaskCount = getArray(participant.taskPlans).filter((task) => isTaskOverdue(task)).length;

      if (!participant.profile?.updatedAt) missingItems.push("profile");
      if (!participant.pretest) missingItems.push("pretest-analysis");
      if (!participant.posttest) missingItems.push("posttest-analysis");
      if (participant.pretest && !participant.expertRatings?.pretest) missingItems.push("pretest-expert-rating");
      if (participant.posttest && !participant.expertRatings?.posttest) missingItems.push("posttest-expert-rating");
      if (participant.posttest && !posttestQuestionnaire) missingItems.push("posttest-questionnaire");
      if (overdueTaskCount > 0) missingItems.push("overdue-task");
      if (participant.interviewSampling?.selected && getArray(participant.interviews).length === 0) missingItems.push("pending-interview");

      return {
        participantId: participant.participantId,
        groupId: participant.groupId,
        missingItems,
        overdueTaskCount,
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
    samplingCount: samplingRows.filter((item) => item.selected).length,
    samplingCompletedCount: samplingRows.filter((item) => item.selected && item.interviewCount > 0).length,
    reminders,
    taskBoard: buildTaskQualityBoard(store),
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
  return store.analyses
    .filter((analysis) => !getArray(store.validationReviews).some((review) => review.analysisId === analysis.analysisId))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .map((analysis) => ({
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
  const systemNoteIds = Array.from(new Set(getArray(analysis.noteFindings).map((item) => safeString(item.noteId)).filter(Boolean)));
  const systemMeasureIndexes = Array.from(new Set(getArray(analysis.measureFindings).map((item) => safeNumber(item.measureIndex)).filter((item) => Number.isFinite(item))));
  const noteMetrics = calculateBinaryMetrics(systemNoteIds, teacherIssueNoteIds);
  const measureMetrics = calculateBinaryMetrics(systemMeasureIndexes, teacherIssueMeasureIndexes);
  const systemRecommendedPath =
    safeString(analysis.recommendedPracticePath) ||
    safeString(getArray(analysis.practiceTargets)[0]?.practicePath) ||
    "review-first";

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

function buildValidationSummary(store) {
  const reviews = getArray(store.validationReviews);
  return {
    reviewCount: reviews.length,
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
      "pieceId",
      "sectionId",
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

async function fetchAnalyzerStatus() {
  const analyzerUrl = safeString(process.env.ERHU_ANALYZER_URL).replace(/\/+$/, "");
  if (!analyzerUrl) {
    return {
      configured: false,
      reachable: false,
      mode: "fallback-only",
      serviceUrl: "",
    };
  }

  try {
    const response = await fetch(`${analyzerUrl}/health`);
    if (!response.ok) {
      return {
        configured: true,
        reachable: false,
        mode: "external-unreachable",
        serviceUrl: analyzerUrl,
        statusCode: response.status,
      };
    }
    const json = await response.json();
    return {
      configured: true,
      reachable: true,
      mode: safeString(json.mode, "external"),
      serviceUrl: analyzerUrl,
      details: json,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      mode: "external-error",
      serviceUrl: analyzerUrl,
      error: safeString(error?.message, "unknown"),
    };
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ai-erhu-research-prototype", at: nowIso() });
});

app.get("/api/erhu/analyzer-status", async (req, res) => {
  const analyzer = await fetchAnalyzerStatus();
  res.json({ ok: true, analyzer });
});

app.get("/api/erhu/pieces", (req, res) => {
  res.json({ ok: true, pieces: getErhuPieceSummaries() });
});

app.get("/api/erhu/pieces/:pieceId", (req, res) => {
  const piece = getErhuPiece(req.params.pieceId);
  if (!piece) {
    return res.status(404).json({ error: "piece not found" });
  }
  return res.json({ ok: true, piece });
});

app.post("/api/erhu/analyze", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  const groupId = safeString(payload.groupId, "experimental");
  const pieceId = safeString(payload.pieceId);
  const sectionId = safeString(payload.sectionId);

  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const section = getErhuSection(pieceId, sectionId);
  if (!section) {
    return res.status(404).json({ error: "piece section not found." });
  }

  let analysis = null;
  try {
    analysis = await callExternalAnalyzer(payload, section);
  } catch {
    analysis = null;
  }

  if (!analysis) {
    analysis = buildFallbackAnalysis(payload, section);
  } else {
    analysis.analysisMode = "external";
  }

  const analysisRecord = {
    analysisId: createId("analysis"),
    participantId,
    groupId,
    sessionStage: safeString(payload.sessionStage, "pretest"),
    pieceId,
    sectionId,
    audioSubmission: payload.audioSubmission || null,
    overallPitchScore: clamp(safeNumber(analysis.overallPitchScore, 0), 0, 100),
    overallRhythmScore: clamp(safeNumber(analysis.overallRhythmScore, 0), 0, 100),
    measureFindings: getArray(analysis.measureFindings),
    noteFindings: getArray(analysis.noteFindings),
    demoSegments: getArray(analysis.demoSegments),
    confidence: clamp(safeNumber(analysis.confidence, 0), 0, 1),
    summaryText: safeString(analysis.summaryText),
    teacherComment: safeString(analysis.teacherComment),
    recommendedPracticePath: safeString(analysis.recommendedPracticePath),
    practiceTargets: getArray(analysis.practiceTargets),
    analysisMode: safeString(analysis.analysisMode, "fallback"),
    diagnostics: analysis.diagnostics && typeof analysis.diagnostics === "object" ? analysis.diagnostics : null,
    createdAt: nowIso(),
  };

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, groupId);
  store.analyses.push(analysisRecord);
  appendAnalysisToParticipant(participant, payload, analysisRecord);
  await writeStudyStore(store);

  return res.json({
    ok: true,
    analysis: analysisRecord,
  });
});

app.get("/api/erhu/analysis/:analysisId", async (req, res) => {
  const store = await readStudyStore();
  const analysis = store.analyses.find((item) => item.analysisId === req.params.analysisId);
  if (!analysis) {
    return res.status(404).json({ error: "analysis not found." });
  }
  return res.json({ ok: true, analysis });
});

app.post("/api/erhu/study-record", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyExperienceScale(participant, payload);
  await writeStudyStore(store);

  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/participant-profile", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyParticipantProfile(participant, payload);
  await writeStudyStore(store);

  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/expert-rating", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, ""));
  applyExpertRating(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.get("/api/erhu/study-records/:participantId", async (req, res) => {
  const store = await readStudyStore();
  const participant = store.participants.find((item) => item.participantId === req.params.participantId);
  if (!participant) {
    return res.json({ ok: true, participant: null });
  }
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.get("/api/erhu/research/overview", async (req, res) => {
  const store = await readStudyStore();
  const participants = store.participants.map((participant) => buildParticipantView(participant, store));
  const dataQuality = buildDataQualityOverview(store);
  const validationSummary = buildValidationSummary(store);
  const withGain = participants.filter((item) => item.pitchGain != null);
  const withQuestionnaire = participants.filter((item) => getArray(item.questionnaires).length > 0);
  const withExpertPost = participants.filter((item) => item.expertRatings?.posttest);
  const withProfile = participants.filter((item) => item.profile?.updatedAt);
  const analyzer = await fetchAnalyzerStatus();
  const averagePitchGain = withGain.length
    ? withGain.reduce((sum, item) => sum + safeNumber(item.pitchGain), 0) / withGain.length
    : 0;
  const averageRhythmGain = withGain.length
    ? withGain.reduce((sum, item) => sum + safeNumber(item.rhythmGain), 0) / withGain.length
    : 0;

  return res.json({
    ok: true,
    overview: {
      participantCount: participants.length,
      analysisCount: store.analyses.length,
      completedPairCount: withGain.length,
      profileCompletedCount: withProfile.length,
      questionnaireCount: withQuestionnaire.length,
      questionnaireEntryCount: buildQuestionnaireExportRows(store).length,
      taskPlanCount: buildTaskExportRows(store).length,
      completedTaskCount: buildTaskExportRows(store).filter((item) => item.status === "completed").length,
      interviewCount: buildInterviewExportRows(store).length,
      expertRatedCount: withExpertPost.length,
      averagePitchGain: Number(averagePitchGain.toFixed(2)),
      averageRhythmGain: Number(averageRhythmGain.toFixed(2)),
      averageUsefulness: Number(average(withQuestionnaire.map((item) => item.experienceScales?.usefulness)).toFixed(2)),
      averageContinuance: Number(average(withQuestionnaire.map((item) => item.experienceScales?.continuance)).toFixed(2)),
      validationReviewCount: validationSummary.reviewCount,
      averageValidationAgreement: validationSummary.averageAgreement,
      averageValidationNoteF1: validationSummary.averageNoteF1,
      averageValidationMeasureF1: validationSummary.averageMeasureF1,
      validationPathAgreementRate: validationSummary.pathAgreementRate,
      pendingValidationCount: validationSummary.pendingValidationCount,
      groups: buildGroupOverview(participants),
      pendingRatings: buildPendingRatings(store),
      pendingValidationReviews: buildPendingValidationReviews(store),
      validationSummary,
      dataQuality,
      analyzer,
    },
  });
});

app.get("/api/erhu/research/participants", async (req, res) => {
  const store = await readStudyStore();
  const participants = store.participants
    .map((participant) => buildParticipantSummary(participant, store))
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));
  return res.json({ ok: true, participants });
});

app.get("/api/erhu/research/data-quality", async (req, res) => {
  const store = await readStudyStore();
  return res.json({ ok: true, dataQuality: buildDataQualityOverview(store) });
});

app.get("/api/erhu/research/tasks", async (req, res) => {
  const store = await readStudyStore();
  const tasks = buildTaskExportRows(store).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return res.json({ ok: true, tasks });
});

app.get("/api/erhu/research/interviews", async (req, res) => {
  const store = await readStudyStore();
  const interviews = buildInterviewExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, interviews });
});

app.get("/api/erhu/research/questionnaires", async (req, res) => {
  const store = await readStudyStore();
  const questionnaires = buildQuestionnaireExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, questionnaires });
});

app.get("/api/erhu/research/expert-ratings", async (req, res) => {
  const store = await readStudyStore();
  const ratings = buildExpertRatingExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, ratings });
});

app.get("/api/erhu/research/validation-reviews", async (req, res) => {
  const store = await readStudyStore();
  const reviews = buildValidationReviewRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, reviews });
});

app.get("/api/erhu/research/validation-summary", async (req, res) => {
  const store = await readStudyStore();
  return res.json({
    ok: true,
    validationSummary: buildValidationSummary(store),
    pendingValidationReviews: buildPendingValidationReviews(store),
  });
});

app.get("/api/erhu/research/pending-ratings", async (req, res) => {
  const store = await readStudyStore();
  return res.json({ ok: true, pendingRatings: buildPendingRatings(store) });
});

app.get("/api/erhu/research/templates", async (req, res) => {
  const templates = RESEARCH_TEMPLATE_LIBRARY.map((item) => ({
    templateId: item.templateId,
    title: item.title,
    filename: item.filename,
    description: item.description,
  }));
  return res.json({ ok: true, templates });
});

app.get("/api/erhu/research/templates/:templateId", async (req, res) => {
  const template = RESEARCH_TEMPLATE_LIBRARY.find((item) => item.templateId === req.params.templateId);
  if (!template) {
    return res.status(404).json({ error: "template not found." });
  }

  const format = safeString(req.query.format, "md").toLowerCase();
  const fileExt = format === "txt" ? "txt" : "md";
  res.setHeader("Content-Type", `text/${fileExt}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename=${template.filename.replace(/\.md$/i, `.${fileExt}`)}`);
  if (fileExt === "txt") {
    return res.send(template.content.replace(/^#+\s?/gm, ""));
  }
  return res.send(template.content);
});

app.post("/api/erhu/task-plan", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyTaskPlan(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/interview-note", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyInterviewNote(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/interview-sampling", async (req, res) => {
  const payload = req.body || {};
  const participantId = safeString(payload.participantId).trim();
  if (!participantId) {
    return res.status(400).json({ error: "participantId is required." });
  }

  const store = await readStudyStore();
  const participant = ensureParticipantRecord(store, participantId, safeString(payload.groupId, "experimental"));
  applyInterviewSampling(participant, payload);
  await writeStudyStore(store);
  return res.json({ ok: true, participant: buildParticipantView(participant, store) });
});

app.post("/api/erhu/validation-review", async (req, res) => {
  const payload = req.body || {};
  const analysisId = safeString(payload.analysisId).trim();
  if (!analysisId) {
    return res.status(400).json({ error: "analysisId is required." });
  }

  const store = await readStudyStore();
  let review = null;
  try {
    review = createValidationReview(store, payload);
  } catch (error) {
    return res.status(404).json({ error: safeString(error?.message, "validation review failed.") });
  }

  const reviewIndex = getArray(store.validationReviews).findIndex((item) => item.analysisId === review.analysisId);
  if (reviewIndex >= 0) {
    store.validationReviews[reviewIndex] = {
      ...store.validationReviews[reviewIndex],
      ...review,
      reviewId: store.validationReviews[reviewIndex].reviewId || review.reviewId,
    };
  } else {
    store.validationReviews.push(review);
  }

  await writeStudyStore(store);
  const participant = store.participants.find((item) => item.participantId === review.participantId) || null;
  return res.json({
    ok: true,
    review,
    participant: participant ? buildParticipantView(participant, store) : null,
    validationSummary: buildValidationSummary(store),
  });
});

app.post("/api/erhu/research/batch-participants", async (req, res) => {
  const entries = getArray(req.body?.participants);
  if (!entries.length) {
    return res.status(400).json({ error: "participants array is required." });
  }

  const store = await readStudyStore();
  const imported = [];

  entries.forEach((entry) => {
    const participantId = safeString(entry.participantId).trim();
    if (!participantId) return;
    const participant = ensureParticipantRecord(store, participantId, safeString(entry.groupId, "experimental"));
    if (entry.profile && typeof entry.profile === "object") {
      participant.profile = {
        alias: safeString(entry.profile.alias, participant.profile?.alias || ""),
        institution: safeString(entry.profile.institution, participant.profile?.institution || ""),
        major: safeString(entry.profile.major, participant.profile?.major || ""),
        grade: safeString(entry.profile.grade, participant.profile?.grade || ""),
        yearsOfTraining: clamp(safeNumber(entry.profile.yearsOfTraining, participant.profile?.yearsOfTraining || 0), 0, 80),
        weeklyPracticeMinutes: clamp(
          safeNumber(entry.profile.weeklyPracticeMinutes, participant.profile?.weeklyPracticeMinutes || 0),
          0,
          10080,
        ),
        deviceLabel: safeString(entry.profile.deviceLabel, participant.profile?.deviceLabel || ""),
        consentSigned: safeBoolean(entry.profile.consentSigned, participant.profile?.consentSigned || false),
        notes: safeString(entry.profile.notes, participant.profile?.notes || ""),
        updatedAt: nowIso(),
      };
      participant.lastActiveAt = participant.profile.updatedAt;
    }
    imported.push(buildParticipantSummary(participant, store));
  });

  await writeStudyStore(store);
  return res.json({ ok: true, importedCount: imported.length, participants: imported });
});

app.get("/api/erhu/research/export", async (req, res) => {
  const format = safeString(req.query.format, "json").toLowerCase();
  const dataset = safeString(req.query.dataset, "participants");
  const store = await readStudyStore();
  const payload = buildExportPayload(store, dataset);
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=erhu-study-${payload.dataset}.csv`);
    return res.send(convertRowsToCsv(payload.headers, payload.rows));
  }
  return res.json({ ok: true, dataset: payload.dataset, rows: payload.rows, store });
});

app.use(express.static(DIST_DIR));

app.get(/.*/, async (req, res) => {
  try {
    await fs.access(path.join(DIST_DIR, "index.html"));
    res.sendFile(path.join(DIST_DIR, "index.html"));
  } catch {
    res.status(404).send("dist/index.html not found. Run `npm run build` first.");
  }
});

app.listen(port, () => {
  console.log(`AI Erhu prototype listening on http://localhost:${port}`);
});
