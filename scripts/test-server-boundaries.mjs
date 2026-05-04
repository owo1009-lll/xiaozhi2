import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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
    assert((await client.callExternalAnalyzerLongTimeout({ audioPath: "a.wav" }, { sectionId: "s1" })).analysisId === "analysis-long", "long analyze should return analysis");
    assert((await client.callExternalSectionRankLongTimeout({ audioPath: "a.wav" }, [{ sectionId: "s1" }], { pieceId: "p1" })).length === 1, "long section rank should return candidates");
    assert(requests.some((item) => item.body.audioPath === "alias:a.wav"), "long calls should send mapped audio path");
    assert(traces.some((line) => line.includes("upstream-analyze")), "long analyze should emit perf trace");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  await testAudioPayload();
  await testAnalyzerClientFetchPath();
  await testAnalyzerClientLongTimeout();
  console.log(JSON.stringify({ ok: true, checks: ["audio-payload", "analyzer-client-fetch", "analyzer-client-long-timeout"] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
