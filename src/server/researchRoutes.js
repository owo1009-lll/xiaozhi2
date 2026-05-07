import express from "express";

import { RESEARCH_TEMPLATE_LIBRARY } from "../researchProtocolData.js";
import { clamp, getArray, nowIso, safeBoolean, safeNumber, safeString } from "./baseUtils.js";
import {
  applyExperienceScale,
  applyExpertRating,
  applyInterviewNote,
  applyInterviewSampling,
  applyParticipantProfile,
  applyTaskPlan,
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
} from "./researchService.js";

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + safeNumber(value), 0) / values.length;
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

export function createResearchRouter({ readStudyStore, writeStudyStore, fetchAnalyzerStatus }) {
  const router = express.Router();

router.get("/analysis/:analysisId", async (req, res) => {
  const store = await readStudyStore();
  const analysis = store.analyses.find((item) => item.analysisId === req.params.analysisId);
  if (!analysis) {
    return res.status(404).json({ error: "analysis not found." });
  }
  return res.json({ ok: true, analysis });
});

router.post("/study-record", async (req, res) => {
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

router.post("/participant-profile", async (req, res) => {
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

router.post("/expert-rating", async (req, res) => {
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

router.get("/study-records/:participantId", async (req, res) => {
  const store = await readStudyStore();
  const participant = store.participants.find((item) => item.participantId === req.params.participantId);
  if (!participant) {
    return res.json({ ok: true, participant: null });
  }
  const scoreId = safeString(req.query.scoreId);
  const pieceId = safeString(req.query.pieceId);
  return res.json({
    ok: true,
    participant: buildParticipantView(participant, store, { scoreId, pieceId }),
  });
});

router.get("/research/overview", async (req, res) => {
  const store = await readStudyStore();
  const participants = store.participants.map((participant) => buildParticipantView(participant, store));
  const dataQuality = buildDataQualityOverview(store);
  const validationSummary = buildValidationSummary(store);
  const adjudicationSummary = buildAdjudicationSummary(store);
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
      validatedAnalysisCount: validationSummary.validatedAnalysisCount,
      fullyValidatedAnalysisCount: validationSummary.fullyValidatedAnalysisCount,
      requiredValidationRaters: validationSummary.requiredRaterCount,
      pendingValidationCount: validationSummary.pendingValidationCount,
      adjudicationResolvedCount: adjudicationSummary.adjudicationResolvedCount,
      adjudicationPendingCount: adjudicationSummary.pendingAdjudicationCount,
      averageAdjudicationNoteF1: adjudicationSummary.averageNoteF1,
      averageAdjudicationMeasureF1: adjudicationSummary.averageMeasureF1,
      adjudicationPathAgreementRate: adjudicationSummary.averagePathAgreement,
      groups: buildGroupOverview(participants),
      pendingRatings: buildPendingRatings(store),
      pendingValidationReviews: buildPendingValidationReviews(store),
      pendingAdjudications: adjudicationSummary.pendingAdjudications,
      validationSummary,
      adjudicationSummary,
      dataQuality,
      analyzer,
    },
  });
});

router.get("/research/participants", async (req, res) => {
  const store = await readStudyStore();
  const participants = store.participants
    .map((participant) => buildParticipantSummary(participant, store))
    .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)));
  return res.json({ ok: true, participants });
});

router.get("/research/data-quality", async (req, res) => {
  const store = await readStudyStore();
  return res.json({ ok: true, dataQuality: buildDataQualityOverview(store) });
});

router.get("/research/tasks", async (req, res) => {
  const store = await readStudyStore();
  const tasks = buildTaskExportRows(store).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return res.json({ ok: true, tasks });
});

router.get("/research/interviews", async (req, res) => {
  const store = await readStudyStore();
  const interviews = buildInterviewExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, interviews });
});

router.get("/research/questionnaires", async (req, res) => {
  const store = await readStudyStore();
  const questionnaires = buildQuestionnaireExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, questionnaires });
});

router.get("/research/expert-ratings", async (req, res) => {
  const store = await readStudyStore();
  const ratings = buildExpertRatingExportRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, ratings });
});

router.get("/research/validation-reviews", async (req, res) => {
  const store = await readStudyStore();
  const reviews = buildValidationReviewRows(store).sort((left, right) =>
    String(right.submittedAt).localeCompare(String(left.submittedAt)),
  );
  return res.json({ ok: true, reviews });
});

router.get("/research/validation-summary", async (req, res) => {
  const store = await readStudyStore();
  return res.json({
    ok: true,
    validationSummary: buildValidationSummary(store),
    pendingValidationReviews: buildPendingValidationReviews(store),
  });
});

router.get("/research/adjudications", async (req, res) => {
  const store = await readStudyStore();
  const adjudications = buildAdjudicationRows(store).sort((left, right) =>
    String(right.resolvedAt).localeCompare(String(left.resolvedAt)),
  );
  return res.json({ ok: true, adjudications });
});

router.get("/research/adjudication-summary", async (req, res) => {
  const store = await readStudyStore();
  return res.json({
    ok: true,
    adjudicationSummary: buildAdjudicationSummary(store),
  });
});

router.get("/research/pending-ratings", async (req, res) => {
  const store = await readStudyStore();
  return res.json({ ok: true, pendingRatings: buildPendingRatings(store) });
});

router.get("/research/templates", async (req, res) => {
  const templates = RESEARCH_TEMPLATE_LIBRARY.map((item) => ({
    templateId: item.templateId,
    title: item.title,
    filename: item.filename,
    description: item.description,
  }));
  return res.json({ ok: true, templates });
});

router.get("/research/templates/:templateId", async (req, res) => {
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

router.post("/task-plan", async (req, res) => {
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

router.post("/interview-note", async (req, res) => {
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

router.post("/interview-sampling", async (req, res) => {
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

router.post("/validation-review", async (req, res) => {
  const payload = req.body || {};
  const analysisId = safeString(payload.analysisId).trim();
  const raterId = safeString(payload.raterId, "expert").trim();
  if (!analysisId) {
    return res.status(400).json({ error: "analysisId is required." });
  }
  if (!raterId) {
    return res.status(400).json({ error: "raterId is required." });
  }

  const store = await readStudyStore();
  let review = null;
  try {
    review = createValidationReview(store, { ...payload, raterId });
  } catch (error) {
    return res.status(404).json({ error: safeString(error?.message, "validation review failed.") });
  }

  const reviewIndex = getArray(store.validationReviews).findIndex(
    (item) => item.analysisId === review.analysisId && safeString(item.raterId) === safeString(review.raterId),
  );
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

router.post("/adjudication", async (req, res) => {
  const payload = req.body || {};
  const analysisId = safeString(payload.analysisId).trim();
  if (!analysisId) {
    return res.status(400).json({ error: "analysisId is required." });
  }

  const store = await readStudyStore();
  let adjudication = null;
  try {
    adjudication = createAdjudication(store, payload);
  } catch (error) {
    return res.status(400).json({ error: safeString(error?.message, "adjudication failed.") });
  }

  const adjudicationIndex = getArray(store.adjudications).findIndex((item) => item.analysisId === adjudication.analysisId);
  if (adjudicationIndex >= 0) {
    store.adjudications[adjudicationIndex] = {
      ...store.adjudications[adjudicationIndex],
      ...adjudication,
      adjudicationId: store.adjudications[adjudicationIndex].adjudicationId || adjudication.adjudicationId,
    };
  } else {
    store.adjudications.push(adjudication);
  }

  await writeStudyStore(store);
  const participant = store.participants.find((item) => item.participantId === adjudication.participantId) || null;
  return res.json({
    ok: true,
    adjudication,
    participant: participant ? buildParticipantView(participant, store) : null,
    adjudicationSummary: buildAdjudicationSummary(store),
  });
});

router.post("/research/batch-participants", async (req, res) => {
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

router.get("/research/export", async (req, res) => {
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

  return router;
}
