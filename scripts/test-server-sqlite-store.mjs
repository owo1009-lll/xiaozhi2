import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readScoreStoreFromSqlite,
  summarizeScoreStoreSqlite,
  writeScoreStoreToSqlite,
} from "../src/server/scoreStoreSqlite.js";

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
  return { response, json };
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode !== null) {
      fail(`server exited before health check: ${child.exitCode}`);
    }
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
    if (job?.omrStatus === "failed" || job?.omrStatus === "completed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  fail("score import job did not reach terminal state");
}

function buildMockPiecePack(title) {
  return {
    pieceId: "sqlite-runtime-piece",
    title,
    composer: "SQLite runtime test",
    selectedPartId: "erhu",
    selectedPartConfidence: 0.98,
    sections: [
      {
        sectionId: "sqlite-runtime-section",
        title: "Runtime section",
        meter: "4/4",
        tempo: 72,
        notes: [
          {
            id: "n1",
            measureIndex: 1,
            beatStart: 0,
            beatDuration: 1,
            midi: 62,
            pitch: "D4",
            sourcePartId: "erhu",
          },
        ],
      },
    ],
  };
}

async function main() {
  let importPdfCalls = 0;
  const mockAnalyzer = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/score/import-pdf") {
      importPdfCalls += 1;
      const payload = await readJsonRequest(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        job: {
          jobId: payload.jobId,
          scoreId: "score-sqlite-runtime",
          title: payload.titleHint || "SQLite runtime import",
          omrStatus: "completed",
          omrConfidence: 0.93,
          selectedPart: payload.selectedPartHint || "erhu",
          detectedParts: [payload.selectedPartHint || "erhu"],
          selectedPartConfidence: 0.98,
          partCandidates: [{ partId: payload.selectedPartHint || "erhu", role: "erhu", confidence: 0.98 }],
          previewPages: [{ pageNumber: 1, type: "pdf", url: "/data/score-imports/runtime/source.pdf" }],
          omrStats: {
            mode: "mock",
            pageCount: 1,
            pageOmrRuns: 1,
            notes: 1,
            sections: 1,
            elapsedMs: 12,
          },
          piecePack: buildMockPiecePack(payload.titleHint || "SQLite runtime import"),
          warnings: [],
          error: "",
          progress: 1,
          stage: "completed",
        },
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  const analyzerPort = await listen(mockAnalyzer);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-sqlite-runtime-"));
  const serverPort = await freePort();
  const dbPath = path.join(dataDir, "score-imports.sqlite");
  writeScoreStoreToSqlite(dbPath, { jobs: [], scores: [] });
  const server = spawn(process.execPath, ["--no-warnings", "server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(serverPort),
      ERHU_DATA_DIR: dataDir,
      ERHU_SCORE_STORE_BACKEND: "auto",
      ERHU_SCORE_STORE_SQLITE_FILE: dbPath,
      ERHU_ANALYZER_URL: `http://127.0.0.1:${analyzerPort}`,
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
    form.set("titleHint", "SQLite runtime import");
    form.set("selectedPartHint", "erhu");
    form.set("pdf", new Blob([Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")], { type: "application/pdf" }), "sqlite-runtime.pdf");

    const started = await fetchJson(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: form });
    if (started.response.status !== 202) fail(`expected 202 from PDF import, got ${started.response.status}`);
    const jobId = started.json.scoreImportJobId;
    if (!jobId) fail("missing scoreImportJobId");
    const job = await pollImportJob(baseUrl, jobId);
    if (job.omrStatus !== "completed") fail(`expected completed job, got ${job.omrStatus}`);
    if (importPdfCalls !== 1) fail(`expected one analyzer /score/import-pdf call, got ${importPdfCalls}`);

    const jsonStorePath = path.join(dataDir, "erhu-score-imports.json");
    if (fsSync.existsSync(jsonStorePath)) {
      fail("SQLite score store backend rewrote erhu-score-imports.json");
    }
    const summary = summarizeScoreStoreSqlite(dbPath);
    if (!summary.exists || summary.activeJobs < 1 || summary.activeScores < 1) {
      fail(`SQLite score store missing imported rows: ${JSON.stringify(summary)}`);
    }
    const sqliteStore = readScoreStoreFromSqlite(dbPath);
    if (!sqliteStore.jobs.some((item) => item.jobId === jobId && item.omrStatus === "completed")) {
      fail("completed score import job was not persisted in SQLite");
    }

    console.log(JSON.stringify({
      ok: true,
      backend: "auto-sqlite",
      checks: ["server-runtime-sqlite-write-path", "json-store-not-rewritten", "completed-job-persisted"],
      summary,
      jobId,
    }, null, 2));
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
