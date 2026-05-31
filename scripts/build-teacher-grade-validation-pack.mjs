import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PACK_ROOT,
  REPO_ROOT,
  buildTeacherValidationPack,
  getArray,
  readJson,
  safeString,
  writeJson,
} from "./teacher-validation-support.mjs";

const DEFAULT_ROOTS = [
  "C:\\Users\\Administrator\\Music\\\u7535\u53f0\u8282\u76ee",
  "C:\\Users\\Administrator\\Music",
];
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    repoRoot: REPO_ROOT,
    roots: [...DEFAULT_ROOTS],
    baseUrl: process.env.TEACHER_BASE_URL || "http://127.0.0.1:3000",
    analyzerUrl: process.env.TEACHER_ANALYZER_URL || "http://127.0.0.1:8000",
    runDir: "",
    packDir: "",
    maxPairs: 3,
    pairOffset: 0,
    titles: [],
    minMatchScore: 0.72,
    minOmrConfidence: 0.72,
    importMissingScores: true,
    maxSectionsPerPiece: 12,
    maxCandidatesPerSection: 2,
    hintRadius: 2,
    hintStep: 1,
    windowPadding: 4,
    scanConcurrency: 1,
    analysisConcurrency: 1,
    analysisTimeoutSeconds: 120,
    scanPreprocessMode: "auto",
    preprocessMode: "auto",
    reuseScanAnalyses: true,
    reuseExistingPasses: true,
    min: 30,
    max: 50,
    minSystemFindings: 0,
    raterId: "teacher-1",
    extractAudio: false,
    strictMin: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") parsed.repoRoot = path.resolve(argv[++index] || parsed.repoRoot);
    else if (arg === "--root") parsed.roots.push(argv[++index] || "");
    else if (arg === "--base-url") parsed.baseUrl = argv[++index] || parsed.baseUrl;
    else if (arg === "--analyzer-url") parsed.analyzerUrl = argv[++index] || parsed.analyzerUrl;
    else if (arg === "--run-dir") parsed.runDir = path.resolve(parsed.repoRoot, argv[++index] || "");
    else if (arg === "--pack-dir") parsed.packDir = path.resolve(parsed.repoRoot, argv[++index] || "");
    else if (arg === "--max-pairs") parsed.maxPairs = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--pair-offset") parsed.pairOffset = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--title") parsed.titles.push(argv[++index] || "");
    else if (arg === "--min-match-score") parsed.minMatchScore = Number(argv[++index]) || parsed.minMatchScore;
    else if (arg === "--min-omr-confidence") parsed.minOmrConfidence = Number(argv[++index]) || parsed.minOmrConfidence;
    else if (arg === "--no-import-missing-scores") parsed.importMissingScores = false;
    else if (arg === "--max-sections-per-piece") parsed.maxSectionsPerPiece = Math.max(1, Number(argv[++index]) || parsed.maxSectionsPerPiece);
    else if (arg === "--max-candidates-per-section") parsed.maxCandidatesPerSection = Math.max(1, Number(argv[++index]) || parsed.maxCandidatesPerSection);
    else if (arg === "--hint-radius") parsed.hintRadius = Math.max(0, Number(argv[++index]) || parsed.hintRadius);
    else if (arg === "--hint-step") parsed.hintStep = Math.max(0.25, Number(argv[++index]) || parsed.hintStep);
    else if (arg === "--window-padding") parsed.windowPadding = Math.max(0, Number(argv[++index]) || parsed.windowPadding);
    else if (arg === "--scan-concurrency") parsed.scanConcurrency = Math.max(1, Number(argv[++index]) || parsed.scanConcurrency);
    else if (arg === "--analysis-concurrency") parsed.analysisConcurrency = Math.max(1, Number(argv[++index]) || parsed.analysisConcurrency);
    else if (arg === "--analysis-timeout-seconds") parsed.analysisTimeoutSeconds = Math.max(10, Number(argv[++index]) || parsed.analysisTimeoutSeconds);
    else if (arg === "--scan-preprocess-mode") parsed.scanPreprocessMode = argv[++index] || parsed.scanPreprocessMode;
    else if (arg === "--preprocess-mode") parsed.preprocessMode = argv[++index] || parsed.preprocessMode;
    else if (arg === "--focused-analysis") parsed.reuseScanAnalyses = false;
    else if (arg === "--refresh-passes") parsed.reuseExistingPasses = false;
    else if (arg === "--min") parsed.min = Math.max(0, Number(argv[++index]) || parsed.min);
    else if (arg === "--max") parsed.max = Math.max(1, Number(argv[++index]) || parsed.max);
    else if (arg === "--min-system-findings") parsed.minSystemFindings = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--rater-id") parsed.raterId = argv[++index] || parsed.raterId;
    else if (arg === "--extract-audio") parsed.extractAudio = true;
    else if (arg === "--strict-min") parsed.strictMin = true;
  }

  parsed.roots = [...new Set(parsed.roots.filter(Boolean))];
  parsed.titles = [...new Set(parsed.titles.map((item) => normalizeTitle(item)).filter(Boolean))];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (!parsed.runDir) {
    parsed.runDir = path.join(parsed.repoRoot, "data", "teacher-validation", "alignment-runs", stamp);
  }
  if (!parsed.packDir) {
    parsed.packDir = path.join(parsed.repoRoot, DEFAULT_PACK_ROOT, stamp);
  }
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

function shouldExcludePdf(pdfPath) {
  const title = displayTitleFromPdf(pdfPath);
  const normalized = normalizeTitle(title);
  if (title === "\u706b" || normalized === "\u706b") return "unsupported-jianpu-or-explicit-exclusion";
  if (/\u7b80\u8c31/.test(title)) return "unsupported-jianpu-or-explicit-exclusion";
  return "";
}

function titleAllowed(title, titles) {
  if (!titles.length) return true;
  const normalized = normalizeTitle(title);
  return titles.some((item) => normalized === item || normalized.includes(item) || item.includes(normalized));
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

function bestAudioForPdf(pdfPath, audioFiles, minMatchScore) {
  return audioFiles
    .map((audioPath) => ({
      audioPath,
      score: titleMatchScore(pdfPath, audioPath),
      audioTitle: displayTitleFromAudio(audioPath),
    }))
    .filter((item) => item.score >= minMatchScore)
    .sort((left, right) => right.score - left.score || left.audioTitle.localeCompare(right.audioTitle, "zh-Hans-CN"))[0] || null;
}

async function discoverPairs(args) {
  const allFiles = [];
  for (const root of args.roots) await walk(root, allFiles);
  const uniqueFiles = [...new Set(allFiles.map((item) => path.resolve(item)))];
  const pdfFiles = uniqueFiles.filter((item) => /\.pdf$/i.test(item));
  const audioFiles = uniqueFiles.filter((item) => /\.(mp3|wav|m4a|flac|aac)$/i.test(item));
  const pairs = pdfFiles
    .map((pdfPath) => {
      const title = displayTitleFromPdf(pdfPath);
      const audio = bestAudioForPdf(pdfPath, audioFiles, args.minMatchScore);
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
    .filter((pair) => titleAllowed(pair.title, args.titles))
    .sort((left, right) => right.matchScore - left.matchScore || left.title.localeCompare(right.title, "zh-Hans-CN"));
  const deduped = [];
  const seen = new Set();
  for (const pair of pairs) {
    const key = `${path.resolve(pair.pdfPath).toLowerCase()}::${path.resolve(pair.audioPath).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(pair);
  }
  const offset = args.pairOffset > 0 ? deduped.slice(args.pairOffset) : deduped;
  return args.maxPairs > 0 ? offset.slice(0, args.maxPairs) : offset;
}

async function sha1File(filePath) {
  const hash = crypto.createHash("sha1");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
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
      throw new Error(json?.error || json?.message || response.statusText || `HTTP ${response.status}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollScoreImport(baseUrl, jobId, timeoutMs = 30000) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const json = await fetchJsonWithTimeout(`${baseUrl}/api/erhu/scores/import-pdf/${encodeURIComponent(jobId)}`, {}, timeoutMs);
    const job = json.job || {};
    if (job.omrStatus === "completed" || job.omrStatus === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`PDF import timed out: ${jobId}`);
}

async function importPdf(baseUrl, pair, timeoutMs = 30000) {
  const form = new FormData();
  const bytes = await fs.readFile(pair.pdfPath);
  form.append("pdf", new Blob([bytes], { type: "application/pdf" }), path.basename(pair.pdfPath));
  form.append("titleHint", pair.title);
  const started = await fetchJsonWithTimeout(`${baseUrl}/api/erhu/scores/import-pdf`, { method: "POST", body: form }, timeoutMs);
  const jobId = started.scoreImportJobId || started.job?.jobId;
  if (!jobId) throw new Error(`PDF import did not return a job id for ${pair.title}`);
  return pollScoreImport(baseUrl, jobId, timeoutMs);
}

function findExistingScoreImport(scoreStore, pdfHash, minOmrConfidence) {
  return getArray(scoreStore.jobs)
    .filter((job) => job.omrStatus === "completed")
    .filter((job) => safeString(job.scoreId))
    .filter((job) => safeString(job.pdfHash) === pdfHash)
    .filter((job) => Number(job.omrConfidence || 0) >= minOmrConfidence)
    .sort((left, right) =>
      Number(right.omrConfidence || 0) - Number(left.omrConfidence || 0)
      || safeString(right.updatedAt || right.createdAt).localeCompare(safeString(left.updatedAt || left.createdAt)),
    )[0] || null;
}

async function ensureScoreImport(args, pair) {
  const pdfHash = await sha1File(pair.pdfPath);
  const storePath = path.join(args.repoRoot, "data", "erhu-score-imports.json");
  const scoreStore = readJson(storePath, {});
  const existing = findExistingScoreImport(scoreStore, pdfHash, args.minOmrConfidence);
  if (existing) return { job: existing, imported: false, pdfHash };
  if (!args.importMissingScores) {
    throw new Error(`missing completed score import for ${pair.title}`);
  }
  const imported = await importPdf(args.baseUrl, pair);
  if (imported.omrStatus !== "completed" || Number(imported.omrConfidence || 0) < args.minOmrConfidence) {
    throw new Error(`score import is not usable for ${pair.title}: status=${imported.omrStatus}, confidence=${imported.omrConfidence}`);
  }
  return { job: imported, imported: true, pdfHash };
}

function slug(value) {
  return safeString(value, "item")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function passJsonPath(outputDir, scoreId) {
  return path.join(outputDir, `${scoreId}-whole-piece-pass.json`);
}

async function runCommand(command, commandArgs, { cwd, logPath }) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  fsSync.appendFileSync(logPath, `\n$ ${command} ${commandArgs.join(" ")}\n`, "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      fsSync.appendFileSync(logPath, chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      fsSync.appendFileSync(logPath, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function runTeacherGradePass(args, pair, scoreJob, index) {
  const outputDir = path.join(args.runDir, "passes", `${String(index + 1).padStart(2, "0")}-${slug(pair.title)}`);
  const expectedPassJson = passJsonPath(outputDir, scoreJob.scoreId);
  if (args.reuseExistingPasses && fsSync.existsSync(expectedPassJson)) {
    const existing = readJson(expectedPassJson, {});
    if (existing?.summary?.audioCoverage?.scanMode === "analyzer-window") {
      return { outputDir, passJsonPath: expectedPassJson, reused: true, passJson: existing };
    }
  }

  const commandArgs = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join("scripts", "run-python.ps1"),
    path.join("scripts", "run-piece-pass.py"),
    "--base-url",
    args.baseUrl,
    "--analyzer-url",
    args.analyzerUrl,
    "--score-id",
    scoreJob.scoreId,
    "--audio",
    pair.audioPath,
    "--output-dir",
    outputDir,
    "--max-sections",
    String(args.maxSectionsPerPiece),
    "--max-candidates-per-section",
    String(args.maxCandidatesPerSection),
    "--hint-radius",
    String(args.hintRadius),
    "--hint-step",
    String(args.hintStep),
    "--window-padding",
    String(args.windowPadding),
    "--scan-concurrency",
    String(args.scanConcurrency),
    "--analysis-concurrency",
    String(args.analysisConcurrency),
    "--analysis-timeout-seconds",
    String(args.analysisTimeoutSeconds),
    "--scan-preprocess-mode",
    args.scanPreprocessMode,
    "--preprocess-mode",
    args.preprocessMode,
  ];
  if (args.reuseScanAnalyses) commandArgs.push("--reuse-scan-analyses");
  await runCommand("powershell", commandArgs, {
    cwd: args.repoRoot,
    logPath: path.join(args.runDir, "teacher-grade-scan.log"),
  });

  const passJson = readJson(expectedPassJson, null);
  if (!passJson) throw new Error(`missing pass JSON: ${expectedPassJson}`);
  return { outputDir, passJsonPath: expectedPassJson, reused: false, passJson };
}

function buildPiecePassJob(pair, scoreJob, passResult) {
  const passJson = passResult.passJson || {};
  const summary = passJson.summary || {};
  const audioHash = safeString(passJson.audioHash || summary.audioHash);
  const jobId = `teachergrade-${crypto.createHash("sha1").update(`${scoreJob.scoreId}:${audioHash}:${pair.audioPath}`).digest("hex").slice(0, 12)}`;
  return {
    jobId,
    participantId: `teacher-grade-${audioHash.slice(0, 8) || "unknown"}`,
    scoreId: scoreJob.scoreId,
    pieceId: passJson.pieceId || scoreJob.scoreId,
    pieceTitle: summary.pieceTitle || scoreJob.title || pair.title,
    status: "completed",
    audioHash,
    audioPath: pair.audioPath,
    outputDir: passResult.outputDir,
    passJsonPath: passResult.passJsonPath,
    summary,
    wholePieceAnalysis: {
      analysisId: `${jobId}-whole-piece`,
      participantId: `teacher-grade-${audioHash.slice(0, 8) || "unknown"}`,
      groupId: "teacher-grade-alignment",
      sessionStage: "whole-piece",
      scoreId: scoreJob.scoreId,
      pieceId: passJson.pieceId || scoreJob.scoreId,
      sectionId: "whole-piece",
      pieceTitle: summary.pieceTitle || scoreJob.title || pair.title,
      audioHash,
      audioDurationSeconds: summary.audioCoverage?.audioDurationSeconds,
      recommendedPracticePath: summary.dominantPracticePath || "review-first",
      noteFindings: [],
      measureFindings: [],
    },
  };
}

async function runPreflight(args) {
  const health = await fetchJsonWithTimeout(`${args.baseUrl}/api/health`, {}, 10000);
  const analyzer = await fetchJsonWithTimeout(`${args.analyzerUrl}/health`, {}, 10000);
  return { health, analyzer };
}

async function main() {
  const args = parseArgs();
  await fs.mkdir(args.runDir, { recursive: true });
  await fs.mkdir(args.packDir, { recursive: true });

  const runSummaryPath = path.join(args.runDir, "run-summary.json");
  const report = {
    createdAt: new Date().toISOString(),
    source: "teacher-grade-alignment",
    baseUrl: args.baseUrl,
    analyzerUrl: args.analyzerUrl,
    maxSectionsPerPiece: args.maxSectionsPerPiece,
    maxCandidatesPerSection: args.maxCandidatesPerSection,
    runDir: args.runDir,
    packDir: args.packDir,
    pairs: [],
    results: [],
    statusCounts: {},
  };
  const writeReport = async () => writeJson(runSummaryPath, report);

  report.preflight = await runPreflight(args);
  report.pairs = await discoverPairs(args);
  await writeReport();
  if (!report.pairs.length) throw new Error("no matching PDF/audio pairs found");

  for (let index = 0; index < report.pairs.length; index += 1) {
    const pair = report.pairs[index];
    const result = {
      title: pair.title,
      pdfPath: pair.pdfPath,
      audioPath: pair.audioPath,
      audioTitle: pair.audioTitle,
      matchScore: pair.matchScore,
      status: "pending",
    };
    report.results.push(result);
    await writeReport();
    try {
      result.status = "ensuring-score-import";
      await writeReport();
      const scoreImport = await ensureScoreImport(args, pair);
      result.importedScore = scoreImport.imported;
      result.importJob = scoreImport.job;
      result.scoreId = scoreImport.job.scoreId;
      result.status = "scanning";
      await writeReport();

      const passResult = await runTeacherGradePass(args, pair, scoreImport.job, index);
      result.status = "completed";
      result.reusedPass = passResult.reused;
      result.piecePassJob = buildPiecePassJob(pair, scoreImport.job, passResult);
    } catch (error) {
      result.status = "failed";
      result.error = String(error?.message || error);
    }
    report.statusCounts = report.results.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    await writeReport();
  }

  report.completedCount = report.results.filter((item) => item.status === "completed").length;
  report.failedCount = report.results.filter((item) => item.status === "failed").length;
  await writeReport();

  const pack = await buildTeacherValidationPack({
    repoRoot: args.repoRoot,
    outputDir: args.packDir,
    unit: "section",
    sources: "teacher-grade-runs",
    max: args.max,
    min: args.min,
    minSystemFindings: args.minSystemFindings,
    raterId: args.raterId,
    extractAudio: args.extractAudio,
    strictMin: args.strictMin,
    requireTrustedAlignment: true,
  });
  report.pack = {
    outputDir: pack.outputDir,
    selectedCount: pack.manifest.selectedCount,
    warnings: pack.manifest.warnings,
  };
  await writeReport();

  console.log(JSON.stringify({
    ok: true,
    runSummaryPath,
    runDir: args.runDir,
    packDir: pack.outputDir,
    pairCount: report.pairs.length,
    completedCount: report.completedCount,
    failedCount: report.failedCount,
    selectedCount: pack.manifest.selectedCount,
    warnings: pack.manifest.warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
