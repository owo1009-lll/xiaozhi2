import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    if (child.exitCode !== null) fail(`server exited before health check: ${child.exitCode}`);
    try {
      const { response, json } = await fetchJson(`${baseUrl}/api/health`);
      if (response.ok && json.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fail("server health check timed out");
}

async function waitForRunningQueue(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const { response, json } = await fetchJson(`${baseUrl}/api/erhu/ops/health`);
    if (response.ok && Number(json?.tasks?.queues?.scoreImports?.running) >= 1) return json.tasks.queues.scoreImports;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("score-import queue did not reach running=1");
}

function pdfForm(titleHint) {
  const form = new FormData();
  form.set("titleHint", titleHint);
  form.set("pdf", new Blob([Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")], { type: "application/pdf" }), `${titleHint}.pdf`);
  return form;
}

async function main() {
  const mockAnalyzer = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/score/import-pdf") {
      const payload = await readJsonRequest(request);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        job: {
          jobId: payload.jobId,
          title: payload.titleHint || "Queue 429 test",
          omrStatus: "failed",
          omrConfidence: 0,
          detectedParts: ["Erhu"],
          selectedPart: "Erhu",
          omrStats: { mode: "delayed", pageCount: 1 },
          warnings: ["delayed queue test"],
          error: "delayed queue test",
          progress: 1,
          stage: "failed",
        },
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  const analyzerPort = await listen(mockAnalyzer);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-queue-429-"));
  const serverPort = await freePort();
  const server = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(serverPort),
      ERHU_DATA_DIR: dataDir,
      ERHU_ANALYZER_URL: `http://127.0.0.1:${analyzerPort}`,
      ERHU_SCORE_IMPORT_CONCURRENCY: "1",
      ERHU_SCORE_IMPORT_MAX_PENDING: "0",
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

    const first = await fetchJson(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: pdfForm("queue-first") });
    if (first.response.status !== 202) fail(`expected first import to start with 202, got ${first.response.status}`);

    const runningQueue = await waitForRunningQueue(baseUrl);
    const second = await fetchJson(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: pdfForm("queue-second") });
    if (second.response.status !== 429) fail(`expected second import to be rejected with 429, got ${second.response.status}`);
    if (second.json?.queue?.name !== "score-import") fail("429 response did not include score-import queue stats");
    if (Number(second.json?.queue?.capacity) !== 1) fail("429 queue capacity should reflect concurrency=1 maxPending=0");

    console.log(JSON.stringify({
      ok: true,
      checks: ["http-429", "queue-stats", "score-import-capacity"],
      runningQueue,
      rejectedQueue: second.json.queue,
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
