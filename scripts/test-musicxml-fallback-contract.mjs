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

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
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
          title: payload.titleHint || "Forced OMR failure",
          omrStatus: "failed",
          omrConfidence: 0,
          detectedParts: [payload.selectedPartHint || "erhu"],
          selectedPart: payload.selectedPartHint || "erhu",
          omrStats: { mode: "failed", pageCount: 1 },
          warnings: ["forced omr failure"],
          error: "forced omr failure",
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-fallback-"));
  const serverPort = await freePort();
  const server = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(serverPort),
      ERHU_DATA_DIR: dataDir,
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
    form.set("titleHint", "Forced fallback contract");
    form.set("selectedPartHint", "erhu");
    form.set("pdf", new Blob([Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")], { type: "application/pdf" }), "forced-fallback.pdf");

    const started = await fetchJson(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: form });
    if (started.response.status !== 202) fail(`expected 202 from PDF import, got ${started.response.status}`);
    const jobId = started.json.scoreImportJobId;
    if (!jobId) fail("missing scoreImportJobId");
    const job = await pollImportJob(baseUrl, jobId);

    if (job.omrStatus !== "failed") fail(`expected failed job, got ${job.omrStatus}`);
    if (job.stage !== "failed") fail(`expected failed stage, got ${job.stage}`);
    if (job.musicxmlFallbackAvailable !== true) fail("failed PDF job did not advertise MusicXML fallback");
    if (!Array.isArray(job.fallbackActions) || !job.fallbackActions.includes("import-musicxml")) {
      fail("failed PDF job missing import-musicxml fallback action");
    }
    if (job.retryable !== true) fail("failed PDF job should be retryable");
    if (importPdfCalls !== 1) fail(`expected one analyzer /score/import-pdf call, got ${importPdfCalls}`);

    const studentApp = await fs.readFile(path.join(repoRoot, "src", "StudentApp.jsx"), "utf8");
    if (!studentApp.includes("showMusicXmlFallback") || !studentApp.includes("PDF 自动识谱失败时")) {
      fail("student fallback UI contract is not present");
    }

    console.log(JSON.stringify({
      ok: true,
      checks: ["pdf-failed-job-fallback-action", "isolated-data-dir", "student-fallback-ui-contract"],
      job: {
        jobId: job.jobId,
        omrStatus: job.omrStatus,
        stage: job.stage,
        musicxmlFallbackAvailable: job.musicxmlFallbackAvailable,
        fallbackActions: job.fallbackActions,
        retryable: job.retryable,
      },
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
