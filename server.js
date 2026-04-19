import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getErhuPiece, getErhuPieceSummaries, getErhuSection } from "./src/erhuStudyPieces.js";

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
      participants: Array.isArray(parsed.participants) ? parsed.participants : [],
      analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
    };
  } catch {
    return {
      participants: [],
      analyses: [],
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
    return {
      noteId: note.noteId,
      measureIndex: note.measureIndex,
      expectedMidi: note.midiPitch,
      centsError: pitchDirection.cents,
      onsetErrorMs: rhythmDirection.ms,
      pitchLabel: pitchDirection.label,
      rhythmLabel: rhythmDirection.label,
    };
  });

  const demoSegments = Array.from(new Set(measureFindings.map((item) => item.measureIndex))).map((measureIndex) => ({
    measureIndex,
    demoAudio: safeString(section?.demoAudio),
    label: `标准示范 · 第 ${measureIndex} 小节`,
  }));

  return {
    overallPitchScore,
    overallRhythmScore,
    measureFindings,
    noteFindings,
    demoSegments,
    confidence: clamp(0.62 + ((seed % 12) / 100), 0.52, 0.78),
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
    participant = {
      participantId,
      groupId,
      createdAt: nowIso(),
      lastActiveAt: nowIso(),
      pretest: null,
      weeklySessions: [],
      posttest: null,
      experienceScales: null,
      usageLogs: [],
      expertRatings: {
        pretest: null,
        posttest: null,
        weekly: [],
      },
    };
    store.participants.push(participant);
  } else if (groupId) {
    participant.groupId = groupId;
  }
  if (!participant.expertRatings || typeof participant.expertRatings !== "object") {
    participant.expertRatings = {
      pretest: null,
      posttest: null,
      weekly: [],
    };
  }
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
  participant.experienceScales = {
    usefulness: safeNumber(payload.experienceScales?.usefulness, 0),
    easeOfUse: safeNumber(payload.experienceScales?.easeOfUse, 0),
    feedbackClarity: safeNumber(payload.experienceScales?.feedbackClarity, 0),
    confidence: safeNumber(payload.experienceScales?.confidence, 0),
    continuance: safeNumber(payload.experienceScales?.continuance, 0),
    notes: safeString(payload.notes),
    submittedAt: nowIso(),
    sessionStage: safeString(payload.sessionStage),
  };
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
    participant.expertRatings.weekly = getArray(participant.expertRatings.weekly).concat(rating).slice(-24);
  }
  participant.lastActiveAt = rating.submittedAt;
}

function buildParticipantView(participant, store) {
  const analyses = store.analyses
    .filter((item) => item.participantId === participant.participantId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

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
    pitchGain,
    rhythmGain,
  };
}

function buildParticipantSummary(participant, store) {
  const view = buildParticipantView(participant, store);
  return {
    participantId: view.participantId,
    groupId: view.groupId,
    createdAt: view.createdAt,
    lastActiveAt: view.lastActiveAt || view.createdAt,
    analysisCount: view.analyses.length,
    weeklySessionCount: getArray(view.weeklySessions).length,
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
    expertPretestPitch: view.expertRatings?.pretest?.pitchScore ?? null,
    expertPosttestPitch: view.expertRatings?.posttest?.pitchScore ?? null,
    expertPretestRhythm: view.expertRatings?.pretest?.rhythmScore ?? null,
    expertPosttestRhythm: view.expertRatings?.posttest?.rhythmScore ?? null,
  };
}

function convertStoreToCsv(store) {
  const lines = [
    [
      "participantId",
      "groupId",
      "pretestPitch",
      "posttestPitch",
      "pitchGain",
      "pretestRhythm",
      "posttestRhythm",
      "rhythmGain",
      "weeklySessionCount",
      "usefulness",
      "easeOfUse",
      "feedbackClarity",
      "confidence",
      "continuance",
      "expertPretestPitch",
      "expertPosttestPitch",
      "expertPretestRhythm",
      "expertPosttestRhythm",
    ].join(","),
  ];

  store.participants.forEach((participant) => {
    const pitchGain =
      participant.pretest && participant.posttest
        ? safeNumber(participant.posttest.pitchScore) - safeNumber(participant.pretest.pitchScore)
        : "";
    const rhythmGain =
      participant.pretest && participant.posttest
        ? safeNumber(participant.posttest.rhythmScore) - safeNumber(participant.pretest.rhythmScore)
        : "";
    lines.push([
      participant.participantId,
      participant.groupId,
      participant.pretest?.pitchScore ?? "",
      participant.posttest?.pitchScore ?? "",
      pitchGain,
      participant.pretest?.rhythmScore ?? "",
      participant.posttest?.rhythmScore ?? "",
      rhythmGain,
      getArray(participant.weeklySessions).length,
      participant.experienceScales?.usefulness ?? "",
      participant.experienceScales?.easeOfUse ?? "",
      participant.experienceScales?.feedbackClarity ?? "",
      participant.experienceScales?.confidence ?? "",
      participant.experienceScales?.continuance ?? "",
      participant.expertRatings?.pretest?.pitchScore ?? "",
      participant.expertRatings?.posttest?.pitchScore ?? "",
      participant.expertRatings?.pretest?.rhythmScore ?? "",
      participant.expertRatings?.posttest?.rhythmScore ?? "",
    ].join(","));
  });

  return lines.join("\n");
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ai-erhu-research-prototype", at: nowIso() });
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
    analysisMode: safeString(analysis.analysisMode, "fallback"),
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
  const withGain = participants.filter((item) => item.pitchGain != null);
  const withQuestionnaire = participants.filter((item) => item.experienceScales?.submittedAt);
  const withExpertPost = participants.filter((item) => item.expertRatings?.posttest);
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
       questionnaireCount: withQuestionnaire.length,
       expertRatedCount: withExpertPost.length,
      averagePitchGain: Number(averagePitchGain.toFixed(2)),
      averageRhythmGain: Number(averageRhythmGain.toFixed(2)),
       averageUsefulness: Number(average(withQuestionnaire.map((item) => item.experienceScales?.usefulness)).toFixed(2)),
       averageContinuance: Number(average(withQuestionnaire.map((item) => item.experienceScales?.continuance)).toFixed(2)),
       groups: buildGroupOverview(participants),
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

app.get("/api/erhu/research/export", async (req, res) => {
  const format = safeString(req.query.format, "json").toLowerCase();
  const store = await readStudyStore();
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=erhu-study-records.csv");
    return res.send(convertStoreToCsv(store));
  }
  return res.json({ ok: true, ...store });
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
