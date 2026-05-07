import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeScoreStoreToSqlite } from "../src/server/scoreStoreSqlite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.dirname(__dirname);

function fail(message) {
  throw new Error(message);
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    fail(`non-json response from ${url}: ${text.slice(0, 160)}`);
  }
  return { response, json, text };
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) fail(`server exited before health check: ${child.exitCode}`);
    try {
      const { response, json } = await fetchJson(`${baseUrl}/api/health`);
      if (response.ok && json.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  fail("server health check timed out");
}

async function pollImportJob(baseUrl, jobId) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const { response, json } = await fetchJson(`${baseUrl}/api/erhu/scores/import-pdf/${jobId}`);
    if (!response.ok) fail(`poll failed: ${response.status}`);
    const job = json.job;
    if (job?.omrStatus === "failed" || job?.omrStatus === "completed") return job;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  fail("score import job did not reach terminal state");
}

async function pollAnalysisJob(baseUrl, jobId) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const { response, json } = await fetchJson(`${baseUrl}/api/erhu/analyze-jobs/${jobId}`);
    if (!response.ok) fail(`analysis poll failed: ${response.status}`);
    const job = json.job;
    if (job?.status === "failed" || job?.status === "completed") return job;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  fail("analysis job did not reach terminal state");
}

async function pollPiecePassJob(baseUrl, jobId) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const { response, json } = await fetchJson(`${baseUrl}/api/erhu/piece-pass-jobs/${jobId}`);
    if (!response.ok) fail(`piece-pass poll failed: ${response.status}`);
    const job = json.job;
    if (job?.status === "failed" || job?.status === "completed") return job;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  fail("piece-pass job did not reach terminal state");
}

function buildMockPiecePack(title) {
  return {
    pieceId: "ops-health-piece",
    title,
    composer: "ops smoke",
    selectedPartId: "erhu",
    selectedPartConfidence: 0.98,
    sections: [
      {
        sectionId: "ops-section",
        title: "Ops section",
        meter: "4/4",
        tempo: 72,
        notes: [{ id: "n1", measureIndex: 1, beatStart: 0, beatDuration: 1, midi: 62, pitch: "D4", sourcePartId: "erhu" }],
      },
    ],
  };
}

function buildAnalysisPiecePack() {
  return {
    pieceId: "ops-analysis-piece",
    sectionId: "ops-analysis-section",
    title: "Ops analysis section",
    meter: "4/4",
    tempo: 72,
    notes: [
      { noteId: "a1", measureIndex: 1, beatStart: 0, beatDuration: 1, midiPitch: 62 },
      { noteId: "a2", measureIndex: 1, beatStart: 1, beatDuration: 1, midiPitch: 64 },
    ],
  };
}

async function seedStores(dataDir) {
  const pdfDir = path.join(dataDir, "score-imports", "failed-job");
  await fs.mkdir(pdfDir, { recursive: true });
  await fs.writeFile(path.join(pdfDir, "source.pdf"), "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");
  const audioDir = path.join(dataDir, "analysis-audio-cache");
  await fs.mkdir(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, "ops-retry.wav");
  await fs.writeFile(audioPath, "mock audio", "utf8");
  const now = new Date().toISOString();
  const store = {
    jobs: [
      {
        jobId: "failed-job",
        title: "Failed PDF",
        sourcePdfPath: "/data/score-imports/failed-job/source.pdf",
        pdfHash: "failed-hash",
        originalFilename: "failed.pdf",
        omrStatus: "failed",
        stage: "failed",
        progress: 1,
        error: "Traceback: C:\\internal\\path should be sanitized",
        selectedPart: "erhu",
        selectedPartCandidates: ["erhu"],
        retryable: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    scores: [],
  };
  await fs.writeFile(path.join(dataDir, "erhu-score-imports.json"), JSON.stringify(store), "utf8");
  const reusableAnalysisPayload = {
    participantId: "ops-participant",
    groupId: "ops",
    sessionStage: "ops",
    pieceId: "ops-analysis-piece",
    sectionId: "ops-analysis-section",
    preprocessMode: "off",
    separationMode: "off",
    audioPath,
    audioHash: "audio-hash",
    audioSubmission: { name: "ops-retry.wav", duration: 4 },
    piecePackOverride: buildAnalysisPiecePack(),
    audioDataUrl: null,
  };
  await fs.writeFile(path.join(dataDir, "erhu-analysis-jobs.json"), JSON.stringify({
    jobs: [
      {
        jobId: "failed-analysis",
        participantId: "ops-participant",
        groupId: "ops",
        sessionStage: "ops",
        pieceId: "ops-analysis-piece",
        sectionId: "ops-analysis-section",
        status: "failed",
        stage: "failed",
        progress: 1,
        error: "analysis failed",
        retryable: true,
        audioHash: "audio-hash",
        audioPath,
        requestPayload: reusableAnalysisPayload,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }), "utf8");
  const reusablePiecePassPayload = {
    participantId: "ops-participant",
    pieceId: "ops-piece",
    preprocessMode: "off",
    audioPath,
    audioHash: "audio-hash",
    audioSubmission: { name: "ops-retry.wav", duration: 4 },
    audioDataUrl: null,
  };
  await fs.writeFile(path.join(dataDir, "erhu-piece-pass-jobs.json"), JSON.stringify({
    jobs: [
      {
        jobId: "failed-piece-pass",
        participantId: "ops-participant",
        pieceId: "ops-piece",
        pieceTitle: "Ops piece",
        sourceType: "piece",
        status: "failed",
        stage: "failed",
        progress: 1,
        error: "piece pass failed",
        retryable: true,
        audioHash: "audio-hash",
        audioPath,
        requestPayload: reusablePiecePassPayload,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }), "utf8");
  return store;
}

async function writeMockPiecePassRunner(dataDir) {
  const scriptPath = path.join(dataDir, "mock-piece-pass.py");
  await fs.writeFile(scriptPath, `
from __future__ import annotations
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--piece-id", default="")
parser.add_argument("--score-id", default="")
parser.add_argument("--audio", default="")
parser.add_argument("--output-dir", required=True)
parser.add_argument("--audio-hash", default="")
parser.add_argument("--base-url", default="")
parser.add_argument("--analyzer-url", default="")
parser.add_argument("--preprocess-mode", default="off")
args, _ = parser.parse_known_args()
key = args.score_id or args.piece_id or "ops-piece"
out = Path(args.output_dir)
out.mkdir(parents=True, exist_ok=True)
print("__PROGRESS__" + json.dumps({"progress": 0.5, "stage": "analyzing-sections", "message": "mock progress", "currentSection": 1, "totalSections": 1}), flush=True)
summary = {"summary": {
    "pieceTitle": "Ops piece",
    "audioHash": args.audio_hash,
    "analysisReliable": True,
    "structuredSectionCount": 1,
    "attemptedSectionCount": 1,
    "matchedSectionCount": 1,
    "weightedPitchScore": 91,
    "weightedRhythmScore": 92,
    "weightedStudentCombinedScore": 91.5,
    "weightedConfidence": 0.94,
    "audioCoverage": {"audioDurationSeconds": 4}
}}
pass_payload = {
    "pieceId": key,
    "audioHash": args.audio_hash,
    "sectionPasses": [{
        "sequenceIndex": 1,
        "sectionId": "ops-section",
        "sectionTitle": "Ops section",
        "overallPitchScore": 91,
        "overallRhythmScore": 92,
        "studentCombinedScore": 91.5,
        "confidence": 0.94,
        "noteFindings": [],
        "measureFindings": []
    }]
}
(out / f"{key}-whole-piece-summary.json").write_text(json.dumps(summary), encoding="utf-8")
(out / f"{key}-whole-piece-pass.json").write_text(json.dumps(pass_payload), encoding="utf-8")
`, "utf8");
  return scriptPath;
}

async function runScenario(backend) {
  let importPdfCalls = 0;
  const mockAnalyzer = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, mode: "mock" }));
      return;
    }
    if (request.method === "POST" && request.url === "/score/import-pdf") {
      importPdfCalls += 1;
      const payload = await readJsonRequest(request);
      if (String(payload.titleHint || "").includes("Cancel")) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        job: {
          jobId: payload.jobId,
          scoreId: `score-${payload.jobId}`,
          title: payload.titleHint || "Resumed PDF",
          omrStatus: "completed",
          omrConfidence: 0.91,
          selectedPart: payload.selectedPartHint || "erhu",
          detectedParts: [payload.selectedPartHint || "erhu"],
          selectedPartConfidence: 0.98,
          previewPages: [{ pageNumber: 1, type: "pdf", url: "/data/score-imports/runtime/source.pdf" }],
          omrStats: { mode: "mock", pageCount: 1, pageOmrRuns: 1, notes: 1, sections: 1 },
          piecePack: buildMockPiecePack(payload.titleHint || "Resumed PDF"),
          warnings: [],
          error: "",
          progress: 1,
          stage: "completed",
        },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/analyze") {
      const payload = await readJsonRequest(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        analysis: {
          overallPitchScore: 92,
          overallRhythmScore: 93,
          studentPitchScore: 92,
          studentRhythmScore: 93,
          studentCombinedScore: 92.5,
          confidence: 0.95,
          measureFindings: [],
          noteFindings: [],
          demoSegments: [],
          summaryText: "mock analysis",
          recommendedPracticePath: "review-first",
          practiceTargets: [],
          analysisMode: "mock",
          diagnostics: { sectionId: payload.sectionId },
        },
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  const analyzerPort = await listen(mockAnalyzer);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-ops-"));
  const seededStore = await seedStores(dataDir);
  const mockPiecePassRunner = await writeMockPiecePassRunner(dataDir);
  if (backend === "sqlite") {
    writeScoreStoreToSqlite(path.join(dataDir, "erhu-score-imports.sqlite"), seededStore);
  }
  const serverPort = await freePort();
  const server = spawn(process.execPath, ["--no-warnings", "server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(serverPort),
      ERHU_DATA_DIR: dataDir,
      ERHU_ANALYZER_URL: `http://127.0.0.1:${analyzerPort}`,
      ERHU_SCORE_STORE_BACKEND: backend,
      ERHU_PIECE_PASS_RUNNER_SCRIPT: mockPiecePassRunner,
      ERHU_PREFER_CUDA_PYTHON: "false",
      ERHU_TORCH_DEVICE: "cpu",
      CUDA_VISIBLE_DEVICES: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  server.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  try {
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    await waitForServer(baseUrl, server);

    const form = new FormData();
    form.set("titleHint", "Cancel PDF");
    form.set("selectedPartHint", "erhu");
    form.set("pdf", new Blob([Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")], { type: "application/pdf" }), "cancel.pdf");
    const startedCancel = await fetchJson(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: form });
    if (startedCancel.response.status !== 202) fail(`expected 202 from cancel fixture import, got ${startedCancel.response.status}`);
    const processingJobId = startedCancel.json.scoreImportJobId;
    if (!processingJobId) fail("missing processing fixture job id");

    const health = await fetchJson(`${baseUrl}/api/erhu/ops/health`);
    if (!health.response.ok || !health.json.ok) fail("ops health failed");
    if (health.json.cpuOnly?.expectedCpuOnly !== true) fail("ops health did not report CPU-only");
    if (health.json.store?.backend !== backend) fail(`ops health reported ${health.json.store?.backend} backend, expected ${backend}`);
    const healthText = JSON.stringify(health.json);
    if (/Traceback|C:\\internal\\path/i.test(healthText)) fail("ops health leaked internal failure text");

    const jobsResult = await fetchJson(`${baseUrl}/api/erhu/ops/jobs`);
    const jobs = jobsResult.json.jobs || [];
    const failedJob = jobs.find((job) => job.jobId === "failed-job");
    const failedAnalysisJob = jobs.find((job) => job.jobId === "failed-analysis");
    const failedPiecePassJob = jobs.find((job) => job.jobId === "failed-piece-pass");
    const processingJob = jobs.find((job) => job.jobId === processingJobId);
    if (!failedJob?.actions?.canResume || !failedJob?.actions?.canRetry) fail("failed score job should expose retry/resume");
    if (!failedAnalysisJob?.actions?.canResume || !failedAnalysisJob?.actions?.canRetry) fail("failed analysis job should expose retry/resume");
    if (!failedPiecePassJob?.actions?.canResume || !failedPiecePassJob?.actions?.canRetry) fail("failed piece-pass job should expose retry/resume");
    if (!processingJob?.actions?.canCancel) fail("processing score job should expose cancel");

    const cancelled = await fetchJson(`${baseUrl}/api/erhu/ops/jobs/score-import/${processingJobId}/cancel`, { method: "POST" });
    if (!cancelled.response.ok) fail(`cancel failed: ${cancelled.response.status}`);
    if (cancelled.json.job?.status !== "failed" || cancelled.json.job?.stage !== "cancelled") {
      fail("cancelled job did not reach failed/cancelled state");
    }

    const resumed = await fetchJson(`${baseUrl}/api/erhu/ops/jobs/score-import/failed-job/resume`, { method: "POST" });
    if (resumed.response.status !== 202) fail(`resume should return 202, got ${resumed.response.status}`);
    const newJobId = resumed.json.job?.jobId;
    if (!newJobId || resumed.json.job?.previousJobId !== "failed-job") fail("resume did not create a linked new job");
    const completed = await pollImportJob(baseUrl, newJobId);
    if (completed.omrStatus !== "completed") fail(`resumed job did not complete: ${completed.omrStatus}`);
    if (completed.previousJobId !== "failed-job") fail("completed resumed job lost previousJobId");

    const resumedAnalysis = await fetchJson(`${baseUrl}/api/erhu/ops/jobs/analysis/failed-analysis/resume`, { method: "POST" });
    if (resumedAnalysis.response.status !== 202) fail(`analysis resume should return 202, got ${resumedAnalysis.response.status}`);
    const analysisJobId = resumedAnalysis.json.job?.jobId;
    if (!analysisJobId || resumedAnalysis.json.job?.previousJobId !== "failed-analysis") fail("analysis resume did not create a linked new job");
    const completedAnalysis = await pollAnalysisJob(baseUrl, analysisJobId);
    if (completedAnalysis.status !== "completed" || completedAnalysis.previousJobId !== "failed-analysis") {
      fail(`resumed analysis job did not complete with previousJobId: ${JSON.stringify(completedAnalysis)}`);
    }
    if (completedAnalysis.requestPayload || completedAnalysis.audioPath) fail("analysis job response leaked reusable payload internals");

    const resumedPiecePass = await fetchJson(`${baseUrl}/api/erhu/ops/jobs/piece-pass/failed-piece-pass/resume`, { method: "POST" });
    if (resumedPiecePass.response.status !== 202) fail(`piece-pass resume should return 202, got ${resumedPiecePass.response.status}`);
    const piecePassJobId = resumedPiecePass.json.job?.jobId;
    if (!piecePassJobId || resumedPiecePass.json.job?.previousJobId !== "failed-piece-pass") fail("piece-pass resume did not create a linked new job");
    const completedPiecePass = await pollPiecePassJob(baseUrl, piecePassJobId);
    if (completedPiecePass.status !== "completed" || completedPiecePass.previousJobId !== "failed-piece-pass") fail("resumed piece-pass job did not complete with previousJobId");
    if (completedPiecePass.requestPayload || completedPiecePass.audioPath) fail("piece-pass job response leaked reusable payload internals");

    await new Promise((resolve) => setTimeout(resolve, 2100));
    const cancelledAfterAnalyzer = await fetchJson(`${baseUrl}/api/erhu/scores/import-pdf/${processingJobId}`);
    if (cancelledAfterAnalyzer.json.job?.stage !== "cancelled") fail("cancelled job was overwritten after analyzer returned");
    if (importPdfCalls !== 2) fail(`expected two analyzer import calls, got ${importPdfCalls}`);

    return {
      ok: true,
      backend,
      checks: ["ops-health", "sanitized-errors", "job-cancel", "score-resume", "analysis-resume", "piece-pass-resume", "cpu-only"],
      resumedJobId: newJobId,
      analysisJobId,
      piecePassJobId,
    };
  } finally {
    server.kill();
    mockAnalyzer.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    if (server.exitCode !== null && server.exitCode !== 0 && server.exitCode !== 1) {
      process.stderr.write(stdout);
      process.stderr.write(stderr);
    }
  }
}

async function main() {
  const scenarios = [];
  for (const backend of ["json", "sqlite"]) {
    scenarios.push(await runScenario(backend));
  }
  console.log(JSON.stringify({ ok: true, scenarios }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
