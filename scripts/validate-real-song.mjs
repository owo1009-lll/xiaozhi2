import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const resultsDir = path.join(repoRoot, "data", "real-tests", "results");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "song";
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

function runCurl(args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`curl timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function importPdf({ pdfPath, titleHint, baseUrl, slug }) {
  const responsePath = path.join(resultsDir, `${slug}-import-response.json`);
  const startedAt = Date.now();
  const { stdout } = await runCurl([
    "-s",
    "-o",
    responsePath,
    "-w",
    "%{http_code}",
    "-F",
    `titleHint=${titleHint}`,
    "-F",
    `pdf=@${pdfPath};type=application/pdf`,
    `${baseUrl}/api/erhu/scores/import-pdf`,
  ]);
  const elapsedMs = Date.now() - startedAt;
  const statusCode = Number.parseInt(stdout.trim(), 10);
  const json = JSON.parse(await fs.readFile(responsePath, "utf8"));
  if (statusCode >= 400 || !json?.ok) {
    throw new Error(`PDF import failed: ${statusCode} ${JSON.stringify(json)}`);
  }
  return { elapsedMs, response: json };
}

async function analyzeSong({ audioPath, scoreId, participantId, baseUrl, slug }) {
  const filename = path.basename(audioPath);
  const payload = {
    participantId,
    groupId: "experimental",
    sessionStage: "pilot",
    scoreId,
    autoDetectSection: true,
    preprocessMode: "auto",
    separationMode: "auto",
    audioSubmission: {
      name: filename,
      mimeType: filename.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "application/octet-stream",
    },
  };
  const responsePath = path.join(resultsDir, `${slug}-analyze-response.json`);

  const startedAt = Date.now();
  const { stdout } = await runCurl([
    "-s",
    "-o",
    responsePath,
    "-w",
    "%{http_code}",
    "-F",
    `payload=${JSON.stringify(payload)}`,
    "-F",
    `audio=@${audioPath};type=${filename.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "application/octet-stream"}`,
    `${baseUrl}/api/erhu/analyze`,
  ]);
  const elapsedMs = Date.now() - startedAt;
  const statusCode = Number.parseInt(stdout.trim(), 10);
  const json = JSON.parse(await fs.readFile(responsePath, "utf8"));
  if (statusCode >= 400 || !json?.ok) {
    throw new Error(`Analyze failed: ${statusCode} ${JSON.stringify(json)}`);
  }
  return { elapsedMs, response: json };
}

function buildSummary(importResult, analyzeResult, options) {
  const job = importResult.response?.job || {};
  const analysis = analyzeResult.response?.analysis || {};
  const diagnostics = analysis.diagnostics || {};
  return {
    slug: options.slug,
    testedAt: nowIso(),
    titleHint: options.titleHint,
    pdfPath: options.pdfPath,
    audioPath: options.audioPath,
    import: {
      elapsedMs: importResult.elapsedMs,
      jobId: importResult.response?.scoreImportJobId || job.jobId || "",
      scoreId: job.scoreId || "",
      omrStatus: job.omrStatus || "",
      omrConfidence: job.omrConfidence ?? null,
      selectedPart: job.selectedPart || "",
      detectedParts: job.detectedParts || [],
      warnings: job.warnings || [],
      error: job.error || "",
      previewPageCount: Array.isArray(job.previewPages) ? job.previewPages.length : 0,
    },
    analysis: {
      elapsedMs: analyzeResult.elapsedMs,
      analysisId: analysis.analysisId || "",
      sectionId: analysis.sectionId || "",
      overallPitchScore: analysis.overallPitchScore ?? null,
      overallRhythmScore: analysis.overallRhythmScore ?? null,
      studentCombinedScore: analysis.studentCombinedScore ?? null,
      recommendedPracticePath: analysis.recommendedPracticePath || "",
      confidence: analysis.confidence ?? null,
      separationApplied: analysis.separationApplied ?? false,
      separationMode: analysis.separationMode || "",
      separationConfidence: analysis.separationConfidence ?? null,
      decodeMethod: diagnostics.decodeMethod || "",
      pitchSource: diagnostics.pitchSource || "",
      onsetSource: diagnostics.onsetSource || "",
      beatSource: diagnostics.beatSource || "",
      scoreSource: diagnostics.scoreSource || "",
      alignedNoteCount: diagnostics.alignedNoteCount ?? null,
      pitchTrackCount: diagnostics.pitchTrackCount ?? null,
      onsetCount: diagnostics.onsetCount ?? null,
      beatCount: diagnostics.beatCount ?? null,
      measureFindingCount: Array.isArray(analysis.measureFindings) ? analysis.measureFindings.length : 0,
      noteFindingCount: Array.isArray(analysis.noteFindings) ? analysis.noteFindings.length : 0,
      uncertainPitchCount: diagnostics.uncertainPitchCount ?? null,
      glideLikeCount: diagnostics.glideLikeCount ?? null,
      vibratoLikeCount: diagnostics.vibratoLikeCount ?? null,
      trillLikeCount: diagnostics.trillLikeCount ?? null,
      pluckLikeCount: diagnostics.pluckLikeCount ?? null,
      tapLikeCount: diagnostics.tapLikeCount ?? null,
      harmonicLikeCount: diagnostics.harmonicLikeCount ?? null,
      octaveFlexCount: diagnostics.octaveFlexCount ?? null,
      techniqueReliefCount: diagnostics.techniqueReliefCount ?? null,
      warnings: diagnostics.warnings || [],
      autoDetectionTopCandidates: Array.isArray(diagnostics.autoDetection?.topCandidates)
        ? diagnostics.autoDetection.topCandidates.map((candidate) => ({
            sectionId: candidate.sectionId,
            score: candidate.score,
            priorAdjustedScore: candidate.priorAdjustedScore,
            confidence: candidate.confidence,
            noteCount: candidate.sourceSection?.noteCount ?? null,
          }))
        : [],
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const pdfPath = args.pdf;
  const audioPath = args.audio;
  const titleHint = args.title || path.parse(pdfPath || audioPath || "song").name;
  const slug = slugify(args.slug || titleHint);
  const baseUrl = args.baseUrl || "http://127.0.0.1:3000";

  if (!pdfPath || !audioPath) {
    throw new Error("Usage: node scripts/validate-real-song.mjs --pdf <pdf> --audio <audio> [--title <title>] [--slug <slug>]");
  }

  await ensureDir(resultsDir);

  const importResult = await importPdf({ pdfPath, titleHint, baseUrl, slug });
  const scoreId = importResult.response?.job?.scoreId;
  if (!scoreId) {
    throw new Error(`Imported score missing scoreId: ${JSON.stringify(importResult.response)}`);
  }

  const analyzeResult = await analyzeSong({
    audioPath,
    scoreId,
    participantId: `REAL-${slug.toUpperCase()}`,
    baseUrl,
    slug,
  });

  const summary = buildSummary(importResult, analyzeResult, {
    slug,
    titleHint,
    pdfPath,
    audioPath,
  });

  await fs.writeFile(
    path.join(resultsDir, `${slug}-validation.json`),
    JSON.stringify(summary, null, 2),
    "utf8",
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
