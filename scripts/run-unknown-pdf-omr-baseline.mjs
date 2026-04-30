import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOT = "C:\\Users\\Administrator\\Music\\电台节目";
const OUTPUT_ROOT = path.join(REPO_ROOT, "data", "real-tests", "unknown-pdf-omr");
const DEFAULT_SAMPLE_PATTERNS = [
  /流浪者之歌/u,
  /古巷深处/u,
];

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseUrl: "http://127.0.0.1:3000",
    root: DEFAULT_ROOT,
    outputDir: path.join(OUTPUT_ROOT, new Date().toISOString().replace(/[:.]/g, "-")),
    pdfs: [],
    timeoutMs: 120000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") args.baseUrl = argv[++index] || args.baseUrl;
    else if (arg === "--root") args.root = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--output-dir") args.outputDir = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--pdf") args.pdfs.push(path.resolve(REPO_ROOT, argv[++index] || ""));
    else if (arg === "--request-timeout-ms") args.timeoutMs = Math.max(1000, Number(argv[++index]) || args.timeoutMs);
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relativePath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
}

function stripExtension(value) {
  return String(value || "").replace(/\.[^.]+$/i, "");
}

function titleFromPdf(filePath) {
  return stripExtension(path.basename(filePath)).trim();
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!response.ok) {
      const message = json?.error || json?.message || response.statusText || "request failed";
      throw new Error(`${message} (${response.status})`);
    }
    return json;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function walk(root, out = []) {
  if (!root || !fsSync.existsSync(root)) return out;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(absolute, out);
    else if (/\.pdf$/i.test(entry.name)) out.push(absolute);
  }
  return out;
}

async function defaultSamplePdfs(root) {
  const allPdfs = await walk(root);
  const patterns = [
    new RegExp("\\u6d41\\u6d6a\\u8005\\u4e4b\\u6b4c", "u"),
    new RegExp("\\u6d6e\\u751f", "u"),
    new RegExp("\\u7ef4\\u5965\\u83b1\\u5854\\u7ec4\\u66f207", "u"),
  ];
  const samples = [];
  for (const pattern of patterns) {
    const match = allPdfs.find((filePath) => pattern.test(path.basename(filePath)));
    if (match) samples.push(match);
  }
  return [...new Set(samples)];
}

async function postPdfImport(baseUrl, pdfPath, timeoutMs) {
  const form = new FormData();
  const bytes = await fs.readFile(pdfPath);
  form.append("pdf", new Blob([bytes], { type: "application/pdf" }), path.basename(pdfPath));
  form.append("titleHint", titleFromPdf(pdfPath));
  const startedAt = Date.now();
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: form }, timeoutMs);
  return { response, requestMs: Date.now() - startedAt };
}

async function pollImport(baseUrl, jobId, timeoutMs) {
  const startedAt = Date.now();
  for (let index = 0; index < 240; index += 1) {
    const json = await fetchJsonWithTimeout(`${baseUrl}/api/erhu/scores/import-pdf/${jobId}`, {}, timeoutMs);
    const job = json.job || {};
    if (job.omrStatus === "completed" || job.omrStatus === "failed") {
      return { job, pollMs: Date.now() - startedAt };
    }
    await sleep(2000);
  }
  throw new Error("PDF import timed out");
}

function summarizeJob(pdfPath, postResult, pollResult) {
  const job = pollResult.job || {};
  const sections = Array.isArray(job.piecePack?.sections) ? job.piecePack.sections : [];
  const notes = sections.flatMap((section) => Array.isArray(section.notes) ? section.notes : []);
  return {
    title: titleFromPdf(pdfPath),
    pdfPath,
    status: job.omrStatus || "unknown",
    scoreId: job.scoreId || "",
    selectedPart: job.selectedPart || "",
    selectedPartConfidence: Number(job.selectedPartConfidence || 0),
    detectedParts: job.detectedParts || [],
    omrConfidence: Number(job.omrConfidence || 0),
    omrStats: job.omrStats || {},
    sectionCount: sections.length || Number(job.piecePack?.sections?.length || 0),
    noteCount: notes.length || Number(job.piecePack?.noteCount || 0),
    scoreLineStats: job.scoreLineStats || job.piecePack?.scoreLineStats || {},
    warnings: job.warnings || [],
    requestMs: postResult.requestMs,
    importMs: postResult.requestMs + pollResult.pollMs,
  };
}

async function main() {
  const args = parseArgs();
  await fs.mkdir(args.outputDir, { recursive: true });
  const pdfs = args.pdfs.length ? args.pdfs : await defaultSamplePdfs(args.root);
  const report = {
    createdAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    sampleCount: pdfs.length,
    samples: [],
    failures: [],
  };

  try {
    report.preflight = await fetchJsonWithTimeout(`${args.baseUrl}/api/health`, {}, args.timeoutMs);
  } catch (error) {
    report.failures.push({ title: "preflight", error: String(error?.message || error) });
  }

  for (const pdfPath of pdfs) {
    const title = titleFromPdf(pdfPath);
    try {
      const postResult = await postPdfImport(args.baseUrl, pdfPath, args.timeoutMs);
      const jobId = postResult.response?.job?.jobId || postResult.response?.jobId;
      if (!jobId) throw new Error("missing import job id");
      const pollResult = await pollImport(args.baseUrl, jobId, args.timeoutMs);
      report.samples.push(summarizeJob(pdfPath, postResult, pollResult));
    } catch (error) {
      const failure = {
        title,
        pdfPath,
        status: "request-failed",
        error: String(error?.message || error),
      };
      report.samples.push(failure);
      report.failures.push(failure);
    }
  }

  report.statusCounts = report.samples.reduce((counts, sample) => {
    const key = sample.status || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  report.completedCount = report.statusCounts.completed || 0;
  report.failedCount = (report.statusCounts.failed || 0) + (report.statusCounts["request-failed"] || 0);
  report.failedSamples = report.samples
    .filter((sample) => sample.status === "failed" || sample.status === "request-failed")
    .map((sample) => ({
      title: sample.title || "",
      pdfPath: sample.pdfPath || "",
      status: sample.status || "",
      omrConfidence: sample.omrConfidence ?? null,
      pageCount: sample.omrStats?.pageCount ?? null,
      resultCount: sample.omrStats?.resultCount ?? null,
      error: sample.error || "",
    }));
  report.failures = [
    ...report.failures,
    ...report.failedSamples.filter((sample) => sample.status === "failed"),
  ];

  const jsonPath = path.join(args.outputDir, "unknown-pdf-omr-baseline.json");
  const latestJsonPath = path.join(OUTPUT_ROOT, "latest-unknown-pdf-omr-baseline.json");
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify({
    sampleCount: report.sampleCount,
    statusCounts: report.statusCounts,
    completedCount: report.completedCount,
    failedCount: report.failedCount,
    failedSamples: report.failedSamples,
    failures: report.failures,
    output: relativePath(jsonPath),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
