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
    excludeTitles: [],
    minConfidence: 0.72,
    importWarnMs: Number(process.env.ERHU_REAL_CORPUS_IMPORT_WARN_MS || 60000),
    analysisWarnMs: Number(process.env.ERHU_REAL_CORPUS_ANALYSIS_WARN_MS || 120000),
    strict: false,
    requestTimeoutMs: 30000,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--run") parsed.run = true;
    else if (arg === "--root") parsed.roots.push(args[++i]);
    else if (arg === "--base-url") parsed.baseUrl = args[++i];
    else if (arg === "--output-dir") parsed.outputDir = path.resolve(REPO_ROOT, args[++i]);
    else if (arg === "--max-pairs") parsed.maxPairs = Number(args[++i]) || 0;
    else if (arg === "--pair-offset") parsed.pairOffset = Math.max(0, Number(args[++i]) || 0);
    else if (arg === "--exclude-title") parsed.excludeTitles.push(args[++i] || "");
    else if (arg === "--min-confidence") parsed.minConfidence = Number(args[++i]) || parsed.minConfidence;
    else if (arg === "--import-warn-ms") parsed.importWarnMs = Math.max(0, Number(args[++i]) || parsed.importWarnMs);
    else if (arg === "--analysis-warn-ms") parsed.analysisWarnMs = Math.max(0, Number(args[++i]) || parsed.analysisWarnMs);
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "--request-timeout-ms") parsed.requestTimeoutMs = Math.max(1000, Number(args[++i]) || parsed.requestTimeoutMs);
  }
  parsed.roots = [...new Set(parsed.roots.filter(Boolean))];
  parsed.excludeTitles = [...new Set(parsed.excludeTitles.map((item) => normalizeTitle(item)).filter(Boolean))];
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runPreflight(baseUrl, timeoutMs) {
  const preflight = {
    ok: false,
    baseUrl,
    checkedAt: new Date().toISOString(),
    failures: [],
  };
  try {
    preflight.health = await fetchJsonWithTimeout(`${baseUrl}/api/health`, {}, timeoutMs);
  } catch (error) {
    preflight.failures.push(`node-gateway-unreachable: ${String(error?.message || error)}`);
  }
  try {
    const analyzerStatus = await fetchJsonWithTimeout(`${baseUrl}/api/erhu/analyzer-status`, {}, timeoutMs);
    preflight.analyzer = analyzerStatus?.analyzer || analyzerStatus;
    if (!preflight.analyzer?.reachable) {
      preflight.failures.push(`python-analyzer-unreachable: ${preflight.analyzer?.mode || "unknown"}`);
    }
  } catch (error) {
    preflight.failures.push(`python-analyzer-status-error: ${String(error?.message || error)}`);
  }
  preflight.ok = preflight.failures.length === 0;
  return preflight;
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

function titleExcludedByArgs(title, excludeTitles) {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  return (excludeTitles || []).some((excluded) => normalized === excluded || normalized.includes(excluded) || excluded.includes(normalized));
}

async function postPdfImport(baseUrl, pair, timeoutMs) {
  const form = new FormData();
  const bytes = await fs.readFile(pair.pdfPath);
  form.append("pdf", new Blob([bytes], { type: "application/pdf" }), path.basename(pair.pdfPath));
  form.append("titleHint", pair.title);
  return fetchJsonWithTimeout(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: form }, timeoutMs);
}

async function pollImport(baseUrl, jobId, timeoutMs) {
  for (let i = 0; i < 240; i += 1) {
    const json = await fetchJsonWithTimeout(`${baseUrl}/api/erhu/scores/import-pdf/${jobId}`, {}, timeoutMs);
    const job = json.job || {};
    if (job.omrStatus === "completed" || job.omrStatus === "failed") return job;
    await sleep(2000);
  }
  throw new Error("PDF import timed out");
}

async function postWholePiece(baseUrl, pair, job, timeoutMs) {
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
  return fetchJsonWithTimeout(`${baseUrl}/api/erhu/piece-pass-jobs`, { method: "POST", body: form }, timeoutMs);
}

async function pollPiecePass(baseUrl, jobId, timeoutMs) {
  for (let i = 0; i < 720; i += 1) {
    const json = await fetchJsonWithTimeout(`${baseUrl}/api/erhu/piece-pass-jobs/${jobId}`, {}, timeoutMs);
    const job = json.job || {};
    if (job.status === "completed" || job.status === "failed") return job;
    await sleep(3000);
  }
  throw new Error("whole-piece analysis timed out");
}

function summarizeStatusCounts(results = []) {
  return results.reduce((counts, item) => {
    const key = item.status || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function buildResultChecks(result, minConfidence, thresholds = {}) {
  const importJob = result.importJob || {};
  const pieceJob = result.piecePassJob || {};
  const summary = pieceJob.summary || {};
  const structured = Number(summary.structuredSectionCount || 0);
  const attempted = Number(summary.attemptedSectionCount || 0);
  const matched = Number(summary.matchedSectionCount || 0);
  const failed = Number(summary.failedSectionCount || 0);
  const timedOut = Number(summary.timedOutSectionCount || 0);
  const completeness = Number(summary.analysisCompletenessRatio ?? summary.sectionCoverageRatio ?? 0);
  const omrConfidence = Number(importJob.omrConfidence || 0);
  const importMs = Number(result.importMs || 0);
  const analysisMs = Number(result.analysisMs || 0);
  const cacheHitCount = Number(summary.sectionCacheHitCount || 0);
  const cacheMissCount = Number(summary.sectionCacheMissCount || Math.max(0, attempted - cacheHitCount));
  const cacheHitRate = Number(summary.sectionCacheHitRate || (attempted > 0 ? cacheHitCount / attempted : 0));
  const p0Failures = [];
  const warnings = [];

  if (result.status !== "completed") p0Failures.push(`status=${result.status || "unknown"}`);
  if (importJob.omrStatus && importJob.omrStatus !== "completed") p0Failures.push(`omr=${importJob.omrStatus}`);
  if (Number.isFinite(omrConfidence) && omrConfidence < minConfidence) p0Failures.push(`omr-confidence=${omrConfidence.toFixed(2)}`);
  if (!pieceJob.wholePieceAnalysis) p0Failures.push("missing-whole-piece-analysis");
  if (structured <= 0) p0Failures.push("no-structured-sections");
  if (attempted <= 0) p0Failures.push("no-attempted-sections");
  if (matched <= 0) p0Failures.push("no-matched-sections");
  if (failed > 0) p0Failures.push(`failed-sections=${failed}`);
  if (timedOut > 0) p0Failures.push(`timed-out-sections=${timedOut}`);
  if (Number.isFinite(completeness) && completeness > 0 && completeness < 0.98) {
    p0Failures.push(`completeness=${completeness.toFixed(2)}`);
  }
  if (summary.analysisReliable === false) p0Failures.push("analysis-unreliable");
  if (thresholds.importWarnMs > 0 && importMs >= thresholds.importWarnMs) {
    warnings.push(`slow-import=${importMs}ms`);
  }
  if (thresholds.analysisWarnMs > 0 && analysisMs >= thresholds.analysisWarnMs) {
    warnings.push(`slow-analysis=${analysisMs}ms`);
  }
  if (attempted >= 100 && analysisMs >= 60000 && cacheHitRate < 0.5) {
    warnings.push(`first-pass-fragmented-score=${analysisMs}ms, sections=${attempted}, cacheMisses=${cacheMissCount}`);
  }

  return {
    ok: p0Failures.length === 0,
    p0Failures,
    warnings,
    omrConfidence,
    structuredSectionCount: structured,
    attemptedSectionCount: attempted,
    matchedSectionCount: matched,
    failedSectionCount: failed,
    timedOutSectionCount: timedOut,
    completeness,
    totalNoteFindings: Number(summary.totalNoteFindings || 0),
    totalMeasureFindings: Number(summary.totalMeasureFindings || 0),
    sectionCacheHitCount: cacheHitCount,
    sectionCacheMissCount: cacheMissCount,
    sectionCacheHitRate: Number.isFinite(cacheHitRate) ? Number(cacheHitRate.toFixed(3)) : 0,
    importMs,
    analysisMs,
  };
}

function refreshReportSummary(report, minConfidence, thresholds = {}) {
  report.statusCounts = summarizeStatusCounts(report.results);
  report.p0Failures = [];
  report.performanceWarnings = [];
  if (report.preflight && !report.preflight.ok) {
    report.p0Failures.push({
      title: "preflight",
      status: "failed",
      failures: report.preflight.failures || ["preflight-failed"],
    });
  }
  for (const result of report.results || []) {
    result.checks = buildResultChecks(result, minConfidence, thresholds);
    if (!result.checks.ok) {
      report.p0Failures.push({
        title: result.title,
        status: result.status,
        failures: result.checks.p0Failures,
      });
    }
    for (const warning of result.checks.warnings || []) {
      report.performanceWarnings.push({
        title: result.title,
        warning,
      });
    }
  }
  report.p0FailureCount = report.p0Failures.length;
  report.performanceWarningCount = report.performanceWarnings.length;
  report.completedCount = report.statusCounts.completed || 0;
  report.skippedCount = Object.entries(report.statusCounts)
    .filter(([key]) => key.startsWith("skipped"))
    .reduce((sum, [, value]) => sum + value, 0);
  report.failedCount = (report.statusCounts.failed || 0) + report.p0FailureCount;
  return report;
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
    .filter((pair) => !titleExcludedByArgs(pair.title, args.excludeTitles))
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
  const report = {
    createdAt: new Date().toISOString(),
    run: args.run,
    strict: args.strict,
    baseUrl: args.baseUrl,
    requestTimeoutMs: args.requestTimeoutMs,
    performanceThresholds: {
      importWarnMs: args.importWarnMs,
      analysisWarnMs: args.analysisWarnMs,
    },
    excludeTitles: args.excludeTitles,
    pairs: selectedPairs,
    results: [],
  };
  const summaryPath = path.join(args.outputDir, "run-summary.json");
  const writeReport = async () => {
    await fs.writeFile(summaryPath, JSON.stringify(report, null, 2), "utf8");
  };
  await fs.writeFile(path.join(args.outputDir, "manifest.json"), JSON.stringify(report, null, 2), "utf8");
  await writeReport();

  if (args.run) {
    report.preflight = await runPreflight(args.baseUrl, args.requestTimeoutMs);
    refreshReportSummary(report, args.minConfidence, args);
    await writeReport();
    if (!report.preflight.ok) {
      console.log(JSON.stringify({
        outputDir: args.outputDir,
        pairCount: selectedPairs.length,
        ran: args.run,
        statusCounts: report.statusCounts,
        p0FailureCount: report.p0FailureCount,
        p0Failures: report.p0Failures,
        performanceWarningCount: report.performanceWarningCount,
        performanceWarnings: report.performanceWarnings,
      }, null, 2));
      if (args.strict) process.exit(1);
      return;
    }
    for (const pair of selectedPairs) {
      const result = { title: pair.title, pdfPath: pair.pdfPath, audioPath: pair.audioPath, status: "pending" };
      report.results.push(result);
      await writeReport();
      try {
        const importStart = Date.now();
        result.status = "importing";
        await writeReport();
        const started = await postPdfImport(args.baseUrl, pair, args.requestTimeoutMs);
        result.scoreImportJobId = started.scoreImportJobId || started.job?.jobId || "";
        await writeReport();
        const importJob = await pollImport(args.baseUrl, result.scoreImportJobId, args.requestTimeoutMs);
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
        const pieceStarted = await postWholePiece(args.baseUrl, pair, importJob, args.requestTimeoutMs);
        result.piecePassJobId = pieceStarted.piecePassJobId || pieceStarted.job?.jobId || "";
        await writeReport();
        const pieceJob = await pollPiecePass(args.baseUrl, result.piecePassJobId, args.requestTimeoutMs);
        result.analysisMs = Date.now() - analysisStart;
        result.piecePassJob = pieceJob;
        const summary = pieceJob.summary || {};
        const structured = Number(summary.structuredSectionCount || 0);
        const attempted = Number(summary.attemptedSectionCount || 0);
        const matched = Number(summary.matchedSectionCount || 0);
        const usableWholePiece =
          pieceJob.status === "completed"
          && pieceJob.wholePieceAnalysis
          && structured > 0
          && attempted > 0
          && matched > 0;
        result.status = usableWholePiece ? "completed" : "failed";
        if (!usableWholePiece) {
          result.error = pieceJob.error || `unusable whole-piece result: structured=${structured}, attempted=${attempted}, matched=${matched}`;
        }
      } catch (error) {
        result.status = "failed";
        result.error = String(error?.message || error);
      }
      await writeReport();
    }
  }
  await writeReport();
  refreshReportSummary(report, args.minConfidence, args);
  await writeReport();
  console.log(JSON.stringify({
    outputDir: args.outputDir,
    pairCount: selectedPairs.length,
    ran: args.run,
    statusCounts: report.statusCounts,
    p0FailureCount: report.p0FailureCount,
    p0Failures: report.p0Failures,
    performanceWarningCount: report.performanceWarningCount,
    performanceWarnings: report.performanceWarnings,
  }, null, 2));
  if (args.strict && report.p0FailureCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
