import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOTS = [
  "C:\\Users\\Administrator\\Music\\\u7535\u53f0\u8282\u76ee",
  "C:\\Users\\Administrator\\Music",
];
const EXCLUDED_TITLES = new Set(["\u706b"]);

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    roots: [...DEFAULT_ROOTS],
    baseUrl: "http://127.0.0.1:3000",
    outputDir: path.join(REPO_ROOT, "data", "real-tests", "corpus-runs", new Date().toISOString().replace(/[:.]/g, "-")),
    run: false,
    maxPairs: 0,
    pairOffset: 0,
    minConfidence: 0.72,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--run") parsed.run = true;
    else if (arg === "--root") parsed.roots.push(args[++i]);
    else if (arg === "--base-url") parsed.baseUrl = args[++i];
    else if (arg === "--output-dir") parsed.outputDir = path.resolve(REPO_ROOT, args[++i]);
    else if (arg === "--max-pairs") parsed.maxPairs = Number(args[++i]) || 0;
    else if (arg === "--pair-offset") parsed.pairOffset = Math.max(0, Number(args[++i]) || 0);
    else if (arg === "--min-confidence") parsed.minConfidence = Number(args[++i]) || parsed.minConfidence;
  }
  parsed.roots = [...new Set(parsed.roots.filter(Boolean))];
  return parsed;
}

function stripExtension(value) {
  return String(value || "").replace(/\.[^.]+$/i, "");
}

function stripParenthetical(value) {
  return String(value || "")
    .replace(/[\uff08(][^\uff09)]*[\uff09)]/g, "")
    .replace(/\[[^\]]*]/g, "")
    .replace(/\u3010[^\u3011]*\u3011/g, "");
}

function displayTitleFromPdf(filePath) {
  return stripParenthetical(stripExtension(path.basename(filePath))).trim();
}

function displayTitleFromAudio(filePath) {
  let name = stripExtension(path.basename(filePath));
  name = name.replace(/^H1gh_To_F29\s*-\s*/i, "");
  name = name.replace(/^[^-]+-\s*/, "");
  name = name.replace(/\s*--\s*.*$/, "");
  return stripParenthetical(name).trim();
}

function normalizeTitle(value) {
  return stripParenthetical(value)
    .replace(/\s*--\s*.*$/, "")
    .replace(/\u94a2\u7434\u4f34\u594f\u7248|\u94a2\u4f34\u603b\u8c31|\u4e3a\u4e8c\u80e1\u4e0e\u94a2\u7434\u800c\u4f5c/g, "")
    .replace(/\u4e8c\u80e1|\u4e2d\u80e1|\u5b9a\u7a3f/g, "")
    .replace(/\d{4}|\d{2}/g, "")
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "")
    .toLowerCase();
}

function titleMatchScore(pdfPath, audioPath) {
  const pdfNorm = normalizeTitle(displayTitleFromPdf(pdfPath));
  const audioNorm = normalizeTitle(displayTitleFromAudio(audioPath));
  if (!pdfNorm || !audioNorm) return 0;
  if (pdfNorm === audioNorm) return 1;
  if (pdfNorm.length >= 2 && audioNorm.endsWith(pdfNorm)) return 0.92;
  if (audioNorm.includes(pdfNorm) || pdfNorm.includes(audioNorm)) {
    return Math.min(audioNorm.length, pdfNorm.length) / Math.max(audioNorm.length, pdfNorm.length);
  }
  return 0;
}

async function walk(root, out = []) {
  if (!root || !fsSync.existsSync(root)) return out;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(absolute, out);
    else out.push(absolute);
  }
  return out;
}

function bestAudioForPdf(pdfPath, audioFiles) {
  const candidates = audioFiles
    .map((audioPath) => ({
      audioPath,
      score: titleMatchScore(pdfPath, audioPath),
      audioTitle: displayTitleFromAudio(audioPath),
    }))
    .filter((item) => item.score >= 0.72)
    .sort((left, right) => right.score - left.score || left.audioTitle.localeCompare(right.audioTitle, "zh-Hans-CN"));
  return candidates[0] || null;
}

function shouldExcludePdf(pdfPath) {
  const title = displayTitleFromPdf(pdfPath);
  const normalized = normalizeTitle(title);
  if (EXCLUDED_TITLES.has(title) || EXCLUDED_TITLES.has(normalized)) return "unsupported-jianpu-or-explicit-exclusion";
  if (/\u7b80\u8c31/.test(title)) return "unsupported-jianpu-or-explicit-exclusion";
  return "";
}

async function postPdfImport(baseUrl, pair) {
  const form = new FormData();
  const bytes = await fs.readFile(pair.pdfPath);
  form.append("pdf", new Blob([bytes], { type: "application/pdf" }), path.basename(pair.pdfPath));
  form.append("titleHint", pair.title);
  const response = await fetch(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`PDF import failed: ${response.status}`);
  return response.json();
}

async function pollImport(baseUrl, jobId) {
  for (let i = 0; i < 240; i += 1) {
    const response = await fetch(`${baseUrl}/api/erhu/scores/import-pdf/${jobId}`);
    const json = await response.json();
    const job = json.job || {};
    if (job.omrStatus === "completed" || job.omrStatus === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("PDF import timed out");
}

async function postWholePiece(baseUrl, pair, job) {
  const form = new FormData();
  const bytes = await fs.readFile(pair.audioPath);
  form.append("audio", new Blob([bytes], { type: "audio/mpeg" }), path.basename(pair.audioPath));
  form.append(
    "payload",
    JSON.stringify({
      participantId: `REAL-CORPUS-${crypto.randomBytes(3).toString("hex")}`,
      groupId: "real-corpus",
      sessionStage: "whole-piece",
      scoreId: job.scoreId,
      title: pair.title,
      separationMode: "auto",
      preprocessMode: "auto",
    }),
  );
  const response = await fetch(`${baseUrl}/api/erhu/piece-pass-jobs`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`whole-piece job failed: ${response.status}`);
  return response.json();
}

async function pollPiecePass(baseUrl, jobId) {
  for (let i = 0; i < 720; i += 1) {
    const response = await fetch(`${baseUrl}/api/erhu/piece-pass-jobs/${jobId}`);
    const json = await response.json();
    const job = json.job || {};
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("whole-piece analysis timed out");
}

async function main() {
  const args = parseArgs();
  await fs.mkdir(args.outputDir, { recursive: true });
  const allFiles = [];
  for (const root of args.roots) await walk(root, allFiles);
  const uniqueFiles = [...new Set(allFiles.map((item) => path.resolve(item)))];
  const pdfFiles = uniqueFiles.filter((item) => /\.pdf$/i.test(item));
  const audioFiles = uniqueFiles.filter((item) => /\.(mp3|wav|m4a|flac|aac)$/i.test(item));
  const pairs = pdfFiles
    .map((pdfPath) => {
      const title = displayTitleFromPdf(pdfPath);
      const audio = bestAudioForPdf(pdfPath, audioFiles);
      const excludeReason = shouldExcludePdf(pdfPath);
      return {
        title,
        pdfPath,
        audioPath: audio?.audioPath || "",
        audioTitle: audio?.audioTitle || "",
        matchScore: audio?.score || 0,
        excluded: Boolean(excludeReason),
        excludeReason,
      };
    })
    .filter((pair) => pair.audioPath)
    .filter((pair) => !pair.excluded)
    .sort((left, right) => right.matchScore - left.matchScore || left.title.localeCompare(right.title, "zh-Hans-CN"));
  const dedupedPairs = [];
  const seenPairKeys = new Set();
  for (const pair of pairs) {
    const key = `${path.resolve(pair.pdfPath).toLowerCase()}::${path.resolve(pair.audioPath).toLowerCase()}`;
    if (seenPairKeys.has(key)) continue;
    seenPairKeys.add(key);
    dedupedPairs.push(pair);
  }
  const offsetPairs = args.pairOffset > 0 ? dedupedPairs.slice(args.pairOffset) : dedupedPairs;
  const selectedPairs = args.maxPairs > 0 ? offsetPairs.slice(0, args.maxPairs) : offsetPairs;
  const report = { createdAt: new Date().toISOString(), run: args.run, pairs: selectedPairs, results: [] };
  const summaryPath = path.join(args.outputDir, "run-summary.json");
  const writeReport = async () => {
    await fs.writeFile(summaryPath, JSON.stringify(report, null, 2), "utf8");
  };
  await fs.writeFile(path.join(args.outputDir, "manifest.json"), JSON.stringify(report, null, 2), "utf8");
  await writeReport();

  if (args.run) {
    for (const pair of selectedPairs) {
      const result = { title: pair.title, pdfPath: pair.pdfPath, audioPath: pair.audioPath, status: "pending" };
      report.results.push(result);
      await writeReport();
      try {
        const importStart = Date.now();
        result.status = "importing";
        await writeReport();
        const started = await postPdfImport(args.baseUrl, pair);
        result.scoreImportJobId = started.scoreImportJobId || started.job?.jobId || "";
        await writeReport();
        const importJob = await pollImport(args.baseUrl, result.scoreImportJobId);
        result.importMs = Date.now() - importStart;
        result.importJob = importJob;
        result.status = "imported";
        await writeReport();
        if (importJob.omrStatus !== "completed" || Number(importJob.omrConfidence || 0) < args.minConfidence) {
          result.status = "skipped-low-omr-confidence";
          await writeReport();
          continue;
        }
        const analysisStart = Date.now();
        result.status = "analyzing";
        await writeReport();
        const pieceStarted = await postWholePiece(args.baseUrl, pair, importJob);
        result.piecePassJobId = pieceStarted.piecePassJobId || pieceStarted.job?.jobId || "";
        await writeReport();
        const pieceJob = await pollPiecePass(args.baseUrl, result.piecePassJobId);
        result.analysisMs = Date.now() - analysisStart;
        result.piecePassJob = pieceJob;
        result.status = pieceJob.status === "completed" ? "completed" : "failed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error?.message || error);
      }
      await writeReport();
    }
  }
  await writeReport();
  console.log(JSON.stringify({ outputDir: args.outputDir, pairCount: selectedPairs.length, ran: args.run }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
