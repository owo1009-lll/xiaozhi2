import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import nodeAssert from "node:assert/strict";
import express from "express";

import {
  buildAudioSubmissionFromUpload,
  buildPreparedAudioPayload,
  inferAudioExtension,
  normalizePreparedPayloadForAnalyzer,
  parseDataUrlToBuffer,
  parseIncomingPayload,
  persistPayloadAudio,
  persistUploadedAudioFile,
} from "../src/server/audioPayload.js";
import { createAnalyzerClient } from "../src/server/analyzerClient.js";
import { sha1 } from "../src/server/baseUtils.js";
import { createScoreRouter } from "../src/server/scoreRoutes.js";
import {
  createMemoryUploadProfiles,
  uploadErrorHandler,
} from "../src/server/uploadProfiles.js";
import {
  annotateImportedSectionsScoreLineRoles,
  buildScoreLineStatsFromSections,
  effectiveSelectedPartConfidence,
  hasAccompanimentPartCandidate,
  isExplicitErhuPartCandidate,
} from "../src/server/scoreLineRoles.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function testAudioPayload() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-audio-payload-"));
  const audioBuffer = Buffer.from("audio-bytes");
  const parsed = parseDataUrlToBuffer(`data:audio/wav;base64,${audioBuffer.toString("base64")}`);
  assert(parsed.mimeType === "audio/wav", "data URL mime type should be parsed");
  assert(Buffer.compare(parsed.buffer, audioBuffer) === 0, "data URL body should be decoded");
  assert(inferAudioExtension({ name: "take.MP3" }) === ".mp3", "explicit upload extension should win");
  assert(inferAudioExtension({}, "audio/webm") === ".webm", "mime type should infer extension");

  const persisted = await persistPayloadAudio(
    { audioDataUrl: `data:audio/wav;base64,${audioBuffer.toString("base64")}`, audioSubmission: { name: "take.wav" } },
    { audioCacheDir: tempDir },
  );
  assert(persisted.audioHash === sha1(audioBuffer), "payload audio hash should match bytes");
  assert((await fs.stat(persisted.audioPath)).isFile(), "payload audio should be cached to disk");

  const existing = await persistPayloadAudio({ audioPath: persisted.audioPath }, { audioCacheDir: tempDir });
  assert(existing.audioHash === persisted.audioHash, "existing cached path should reuse hash");
  const outsidePath = path.join(path.dirname(tempDir), `${path.basename(tempDir)}-outside.wav`);
  await fs.writeFile(outsidePath, audioBuffer);
  await nodeAssert.rejects(
    persistPayloadAudio({ audioPath: outsidePath }, { audioCacheDir: tempDir }),
    /managed audio cache/,
    "HTTP audio payloads must not read a path outside the managed cache",
  );
  await fs.rm(outsidePath, { force: true });

  const upload = await persistUploadedAudioFile(
    { originalname: "upload.m4a", mimetype: "audio/mp4", size: audioBuffer.length, buffer: audioBuffer },
    { audioCacheDir: tempDir },
  );
  assert(upload.audioPath.endsWith(".m4a"), "uploaded audio should keep explicit extension");

  const prepared = buildPreparedAudioPayload({ audioDataUrl: "data:audio/wav;base64,AAAA" }, persisted);
  assert(prepared.audioDataUrl === null && prepared.audioPath === persisted.audioPath, "prepared payload should prefer persisted path");
  const normalized = await normalizePreparedPayloadForAnalyzer(prepared, async (value) => `alias:${value}`);
  assert(normalized.audioPath.startsWith("alias:"), "analyzer payload should use path mapper");
  assert(parseIncomingPayload({ body: { payload: "{\"ok\":true}" } }).ok === true, "multipart payload JSON should parse");
  assert(Object.keys(parseIncomingPayload({ body: { payload: "not-json" } })).length === 0, "bad multipart payload should fall back to empty object");
  assert(buildAudioSubmissionFromUpload({ originalname: "a.wav", mimetype: "audio/wav", size: 5 }, { duration: 1.5 }).duration === 1.5, "upload metadata should keep fallback duration");
  await fs.rm(tempDir, { recursive: true, force: true });
}

async function testAnalyzerClientFetchPath() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(options.body || "{}")) });
    if (String(url).endsWith("/score/patch-tempos")) {
      return { ok: true, json: async () => ({ patches: { "page-01": 96 } }) };
    }
    if (String(url).endsWith("/score/import-pdf")) {
      return { ok: true, json: async () => ({ job: { jobId: "job-fetch" } }) };
    }
    return { ok: true, json: async () => ({ analysis: { analysisId: "analysis-fetch" } }) };
  };
  try {
    const client = createAnalyzerClient({
      env: { ERHU_ANALYZER_URL: "http://analyzer.test/" },
      toAnalyzerPath: async (value) => `alias:${value}`,
    });
    const analysis = await client.callExternalAnalyzer({ audioPath: "local.wav", audioDataUrl: "data" }, { sectionId: "s1" });
    assert(analysis.analysisId === "analysis-fetch", "fetch analyzer should return analysis");
    assert(calls[0].body.audioPath === "alias:local.wav", "fetch analyzer should send mapped audio path");
    assert(calls[0].body.audioDataUrl === null, "mapped audio path should suppress audio data URL");
    const job = await client.callExternalScoreImport({ jobId: "j1" });
    assert(job.jobId === "job-fetch", "fetch score import should return job");
    const patches = await client.callPatchTempos([{ sectionId: "page-01" }]);
    assert(patches["page-01"] === 96, "tempo patch helper should return patches");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnalyzerClientLongTimeout() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readRequestJson(request);
    requests.push({ url: request.url, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/score/import-pdf") response.end(JSON.stringify({ job: { jobId: "pdf-long" } }));
    else if (request.url === "/score/import-musicxml") response.end(JSON.stringify({ job: { jobId: "musicxml-long" } }));
    else if (request.url === "/score/import-midi") response.end(JSON.stringify({ job: { jobId: "midi-long" } }));
    else if (request.url === "/analyze") response.end(JSON.stringify({ analysis: { analysisId: "analysis-long" } }));
    else if (request.url === "/detect-sections") response.end(JSON.stringify({ candidates: [{ sectionId: "s1" }] }));
    else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  const port = await listen(server);
  try {
    const traces = [];
    const client = createAnalyzerClient({
      env: { ERHU_ANALYZER_URL: `http://127.0.0.1:${port}` },
      toAnalyzerPath: async (value) => `alias:${value}`,
      appendPerfTrace: (message) => traces.push(message),
    });
    assert((await client.callExternalScoreImportLongTimeout({ jobId: "pdf" })).jobId === "pdf-long", "long PDF import should return job");
    assert((await client.callExternalMusicXmlImportLongTimeout({ jobId: "musicxml" })).jobId === "musicxml-long", "long MusicXML import should return job");
    assert((await client.callExternalMidiImportLongTimeout({ jobId: "midi" })).jobId === "midi-long", "long MIDI import should return job");
    assert((await client.callExternalAnalyzerLongTimeout({ audioPath: "a.wav" }, { sectionId: "s1" })).analysisId === "analysis-long", "long analyze should return analysis");
    assert((await client.callExternalSectionRankLongTimeout({ audioPath: "a.wav" }, [{ sectionId: "s1" }], { pieceId: "p1" })).length === 1, "long section rank should return candidates");
    assert(requests.some((item) => item.body.audioPath === "alias:a.wav"), "long calls should send mapped audio path");
    assert(traces.some((line) => line.includes("upstream-analyze")), "long analyze should emit perf trace");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testWesternMusicXmlRouteMetadata() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-western-score-route-"));
  let store = { jobs: [], scores: [] };
  let analyzerPayload = null;
  const upload = createMemoryUploadProfiles().scoreImport;
  const app = express();
  app.use(createScoreRouter({
    upload,
    repoRoot: tempDir,
    SCORE_IMPORT_TASK_GATE: { canAccept: () => true },
    SCORE_STORE_FILE: path.join(tempDir, "score-store.json"),
    SCORE_IMPORTS_DIR: path.join(tempDir, "score-imports"),
    readScoreStore: async () => store,
    readScoreStoreUnlocked: async () => store,
    writeScoreStoreUnlocked: async (nextStore) => {
      store = nextStore;
    },
    normalizeScoreImportJob: (job) => ({ ...job }),
    normalizeImportedScoreRecord: (score) => ({ ...score }),
    findReusableImportedScore: () => null,
    findKnownPieceForPdf: () => null,
    cloneLibraryPieceForImport: () => null,
    toWebDataPath: (...parts) => `/data/${parts.join("/")}`,
    upsertScoreImportJob: async (job) => job,
    launchScoreImportTask: () => {},
    callExternalMusicXmlImportLongTimeout: async (payload) => {
      analyzerPayload = payload;
      return {
        jobId: payload.jobId,
        scoreId: payload.jobId,
        omrStatus: "completed",
        omrConfidence: 0.9,
        title: payload.titleHint,
        musicxmlPath: payload.musicxmlPath,
        detectedParts: ["Violin"],
        selectedPart: "Violin",
        selectedPartConfidence: 0.95,
        partCandidates: [{ id: "P1", name: "Violin", score: 0.95 }],
        piecePack: {
          pieceId: payload.jobId,
          title: payload.titleHint,
          composer: "MusicXML import",
          instrument: payload.instrument,
          scoreSourceType: payload.scoreSource,
          tempoKnown: payload.tempoKnown,
          tempoSource: payload.tempoSource,
          selectedPart: "Violin",
          selectedPartId: "P1",
          selectedPartConfidence: 0.95,
          partCandidates: [{ id: "P1", name: "Violin", score: 0.95 }],
          sections: [
            {
              sectionId: "section-a",
              title: "Violin test",
              instrument: payload.instrument,
              scoreSourceType: payload.scoreSource,
              tempoKnown: payload.tempoKnown,
              tempoSource: payload.tempoSource,
              selectedPart: "Violin",
              selectedPartId: "P1",
              selectedPartConfidence: 0.95,
              notes: [],
            },
          ],
        },
        warnings: [],
        error: "",
      };
    },
    buildMarkingStatsFromSections: () => ({}),
    getImportedScore: () => null,
    activeScoreImportTasks: new Map(),
  }));
  app.use(uploadErrorHandler);
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const formData = new FormData();
    formData.set("musicxml", new Blob(["<score-partwise version=\"3.1\"></score-partwise>"], { type: "application/vnd.recordare.musicxml+xml" }), "violin.musicxml");
    formData.set("titleHint", "Western Route Contract");
    formData.set("selectedPartHint", "violin");
    formData.set("instrument", "violin");
    formData.set("scoreSource", "musicxml");
    formData.set("tempoKnown", "false");
    formData.set("tempoSource", "unknown");
    const response = await fetch(`http://127.0.0.1:${port}/api/erhu/scores/import-musicxml`, {
      method: "POST",
      body: formData,
    });
    const body = await response.json();
    assert(response.status === 200 && body.ok === true, "western MusicXML route should complete");
    assert(analyzerPayload?.instrument === "violin", "route should forward instrument to analyzer");
    assert(analyzerPayload?.scoreSource === "musicxml", "route should forward scoreSource to analyzer");
    assert(analyzerPayload?.tempoKnown === false, "route should forward tempoKnown=false to analyzer");
    assert(analyzerPayload?.tempoSource === "unknown", "route should forward tempoSource to analyzer");
    assert(store.scores.length === 1, "route should persist one imported score");
    assert(store.scores[0].instrument === "violin", "persisted score should keep instrument");
    assert(store.scores[0].scoreSource === "musicxml", "persisted score should keep scoreSource");
    assert(store.scores[0].tempoKnown === false, "persisted score should keep tempoKnown=false");
    assert(store.scores[0].tempoSource === "unknown", "persisted score should keep tempoSource");

    const overLimitForm = new FormData();
    overLimitForm.set(
      "musicxml",
      new Blob(
        ["<score-partwise version=\"3.1\"></score-partwise>"],
        { type: "application/vnd.recordare.musicxml+xml" },
      ),
      "over-limit.musicxml",
    );
    for (let index = 0; index < 7; index += 1) overLimitForm.set(`field-${index}`, "x");
    const overLimitResponse = await fetch(`http://127.0.0.1:${port}/api/erhu/scores/import-musicxml`, {
      method: "POST",
      body: overLimitForm,
    });
    assert(overLimitResponse.status === 413, "an over-limit multipart request must fail as 413 JSON");
    assert((await overLimitResponse.json()).ok === false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testWesternMidiRouteMetadata() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-western-midi-route-"));
  let store = { jobs: [], scores: [] };
  let analyzerPayload = null;
  const upload = createMemoryUploadProfiles().scoreImport;
  const app = express();
  app.use(createScoreRouter({
    upload,
    repoRoot: tempDir,
    SCORE_IMPORT_TASK_GATE: { canAccept: () => true },
    SCORE_STORE_FILE: path.join(tempDir, "score-store.json"),
    SCORE_IMPORTS_DIR: path.join(tempDir, "score-imports"),
    readScoreStore: async () => store,
    readScoreStoreUnlocked: async () => store,
    writeScoreStoreUnlocked: async (nextStore) => {
      store = nextStore;
    },
    normalizeScoreImportJob: (job) => ({ ...job }),
    normalizeImportedScoreRecord: (score) => ({ ...score }),
    findReusableImportedScore: () => null,
    findKnownPieceForPdf: () => null,
    cloneLibraryPieceForImport: () => null,
    toWebDataPath: (...parts) => `/data/${parts.join("/")}`,
    upsertScoreImportJob: async (job) => job,
    launchScoreImportTask: () => {},
    callExternalMusicXmlImportLongTimeout: async () => null,
    callExternalMidiImportLongTimeout: async (payload) => {
      analyzerPayload = payload;
      return {
        jobId: payload.jobId,
        scoreId: payload.jobId,
        omrStatus: "completed",
        omrConfidence: 0.96,
        title: payload.titleHint,
        musicxmlPath: payload.midiPath,
        detectedParts: ["violin"],
        selectedPart: "violin",
        selectedPartConfidence: 1,
        piecePack: {
          pieceId: payload.jobId,
          title: payload.titleHint,
          composer: "MIDI import",
          instrument: payload.instrument,
          scoreSourceType: payload.scoreSource,
          tempoKnown: payload.tempoKnown,
          tempoSource: payload.tempoSource,
          selectedPart: "violin",
          selectedPartId: "violin",
          selectedPartConfidence: 1,
          sections: [
            {
              sectionId: "section-a",
              title: "MIDI test",
              instrument: payload.instrument,
              scoreSourceType: payload.scoreSource,
              tempoKnown: payload.tempoKnown,
              tempoSource: payload.tempoSource,
              selectedPart: "violin",
              notes: [],
            },
          ],
        },
        warnings: [],
        error: "",
      };
    },
    buildMarkingStatsFromSections: () => ({}),
    getImportedScore: () => null,
    activeScoreImportTasks: new Map(),
  }));
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const formData = new FormData();
    formData.set("midi", new Blob(["midi-bytes"], { type: "audio/midi" }), "violin.mid");
    formData.set("titleHint", "Western MIDI Route Contract");
    formData.set("selectedPartHint", "violin");
    formData.set("instrument", "violin");
    const response = await fetch(`http://127.0.0.1:${port}/api/erhu/scores/import-midi`, {
      method: "POST",
      body: formData,
    });
    const body = await response.json();
    assert(response.status === 200 && body.ok === true, "western MIDI route should complete");
    assert(analyzerPayload?.instrument === "violin", "MIDI route should forward instrument to analyzer");
    assert(analyzerPayload?.scoreSource === "midi", "MIDI route should default scoreSource=midi");
    assert(analyzerPayload?.tempoKnown === true, "MIDI route should default tempoKnown=true");
    assert(analyzerPayload?.tempoSource === "midi", "MIDI route should default tempoSource=midi");
    assert(store.scores.length === 1, "MIDI route should persist one imported score");
    assert(store.scores[0].instrument === "violin", "persisted MIDI score should keep instrument");
    assert(store.scores[0].scoreSource === "midi", "persisted MIDI score should keep scoreSource");
    assert(store.scores[0].tempoKnown === true, "persisted MIDI score should keep tempoKnown=true");
    assert(store.scores[0].tempoSource === "midi", "persisted MIDI score should keep tempoSource");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function testScoreLineRoleLabels() {
  assert(isExplicitErhuPartCandidate({ name: "二胡" }), "Node score-line role helper should detect Chinese 二胡");
  assert(isExplicitErhuPartCandidate({ name: " 二 胡 " }), "Node score-line role helper should tolerate whitespace in 二胡");
  assert(isExplicitErhuPartCandidate({ name: "Erhu II" }), "Node score-line role helper should detect Erhu variants");
  assert(
    hasAccompanimentPartCandidate({ partCandidates: [{ name: "钢琴" }] }),
    "Node score-line role helper should detect Chinese 钢琴",
  );
  assert(
    hasAccompanimentPartCandidate({ partCandidates: [{ name: "鋼 琴" }] }),
    "Node score-line role helper should tolerate whitespace in 鋼琴",
  );
  assert(
    hasAccompanimentPartCandidate({ partCandidates: [{ name: "伴奏" }] }),
    "Node score-line role helper should detect Chinese 伴奏",
  );
}

function testSingleLineMelodyProjection() {
  const score = {
    selectedPart: "Voice",
    selectedPartConfidence: 0.82,
    partCandidates: [
      { id: "P1", name: "Voice", label: "Voice", chordRatio: 0.55, staffCount: 1 },
      { id: "P2", name: "Piano", label: "Piano", isLikelyPiano: true, staffCount: 2 },
    ],
  };
  const melodicNotes = Array.from({ length: 12 }, (_, index) => ({
    noteId: `m${index + 1}`,
    measureIndex: index + 1,
    beatStart: 0,
    midiPitch: 68 + (index % 5),
    notePosition: {
      pageNumber: 1,
      systemIndex: 1,
      staffIndex: 1,
      normalizedX: 0.1 + index * 0.05,
      normalizedY: 0.12,
    },
  }));
  const lowLineNotes = melodicNotes.map((note, index) => ({
    ...note,
    noteId: `low${index + 1}`,
    measureIndex: index + 10,
    midiPitch: 45 + (index % 4),
    notePosition: {
      ...note.notePosition,
      pageNumber: 2,
      normalizedY: 0.64,
    },
  }));
  const sections = annotateImportedSectionsScoreLineRoles([
    { sectionId: "page-01", notes: melodicNotes },
    { sectionId: "page-02", notes: lowLineNotes },
  ], score);
  const stats = buildScoreLineStatsFromSections(sections);
  assert(
    sections[0].notes.every((note) => note.notePosition.scoreLineRole === "erhu"),
    "Single high monophonic imported line should project to the erhu line",
  );
  assert(
    sections[1].notes.every((note) => note.notePosition.scoreLineRole === "accompaniment"),
    "Low single imported lines should remain filtered as accompaniment",
  );
  assert(stats.erhuPageCoverage === 0.5, "Score-line stats should expose erhu page coverage");
  assert(effectiveSelectedPartConfidence(score.selectedPartConfidence, sections) >= 0.88, "Reliable erhu line evidence should lift part confidence");

  const legacySections = annotateImportedSectionsScoreLineRoles([
    { sectionId: "page-03", notes: melodicNotes.map((note) => ({ ...note, notePosition: { ...note.notePosition, pageNumber: 3 } })) },
  ], { selectedPart: "Voice", partCandidates: [] });
  assert(
    legacySections[0].notes.every((note) => note.notePosition.scoreLineRole === "erhu"),
    "Legacy pagewise scores without part candidates should still get line roles",
  );
}

async function main() {
  await testAudioPayload();
  await testAnalyzerClientFetchPath();
  await testAnalyzerClientLongTimeout();
  await testWesternMusicXmlRouteMetadata();
  await testWesternMidiRouteMetadata();
  testScoreLineRoleLabels();
  testSingleLineMelodyProjection();
  console.log(JSON.stringify({ ok: true, checks: ["audio-payload", "analyzer-client-fetch", "analyzer-client-long-timeout", "western-musicxml-route-metadata", "western-midi-route-metadata", "score-line-role-labels", "single-line-melody-projection"] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
