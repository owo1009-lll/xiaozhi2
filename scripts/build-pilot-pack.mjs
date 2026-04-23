import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatSeconds(value) {
  const total = Math.max(0, Math.round(toNumber(value, 0)));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows, columns) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","));
  return [header, ...body].join("\n");
}

async function resolveLatestWholePiecePass(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const jsonFiles = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      jsonFiles.push(...(await resolveLatestWholePiecePass(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith("-whole-piece-pass.json")) {
      const stat = await fs.stat(fullPath);
      jsonFiles.push({ path: fullPath, mtimeMs: stat.mtimeMs });
    }
  }
  return jsonFiles;
}

function buildOverviewMarkdown(payload, weakestRows, topCount) {
  const summary = payload.summary || {};
  const weakestList = weakestRows
    .slice(0, topCount)
    .map(
      (row, index) =>
        `${index + 1}. ${row.sectionTitle} (${row.sectionId}) | seq ${row.sequenceIndex} | combined ${row.combinedScore} | path ${row.recommendedPracticePath} | window ${formatSeconds(row.startSeconds)}-${formatSeconds(row.endSeconds)}`,
    )
    .join("\n");

  return `# Pilot Execution Pack: ${summary.pieceTitle || payload.pieceId}

## Whole-piece snapshot

- pieceId: \`${summary.pieceId || payload.pieceId}\`
- structured coverage: \`${summary.matchedSectionCount}/${summary.structuredSectionCount}\`
- note coverage: \`${summary.matchedNoteCount}/${summary.structuredNoteCount}\`
- weighted pitch: \`${summary.weightedPitchScore}\`
- weighted rhythm: \`${summary.weightedRhythmScore}\`
- weighted combined: \`${summary.weightedCombinedScore}\`
- dominant practice path: \`${summary.dominantPracticePath}\`

## Recommended pilot focus

Use the current whole-piece scaffold for a small real-sample pilot. Prioritize teacher review on the weakest sections first, because those are the most likely places where score alignment, mixed-audio interference, or rule thresholds still need calibration.

## Priority weak sections

${weakestList || "- none"}

## Suggested pilot workflow

1. Recruit 5-10 learners who can submit recorded practice audio.
2. Run the whole-piece pass once per recording.
3. Ask two teachers to review the top ${topCount} weakest sections from each pass.
4. Compare teacher path labels against the system path and mark whether each section should stay \`pitch-first\`, \`rhythm-first\`, or move to \`review-first\`.
5. Use the adjudication workflow only for sections with persistent disagreement.
`;
}

function buildParticipantRunSheet(payload, weakestRows, topCount) {
  const summary = payload.summary || {};
  const selected = weakestRows.slice(0, topCount);
  const lines = selected
    .map(
      (row, index) =>
        `- Block ${index + 1}: ${row.sectionTitle} (${formatSeconds(row.startSeconds)}-${formatSeconds(row.endSeconds)}) -> system path \`${row.recommendedPracticePath}\`, combined \`${row.combinedScore}\``,
    )
    .join("\n");

  return `# Participant Run Sheet: ${summary.pieceTitle || payload.pieceId}

## Goal

Use this sheet during pilot execution so that the participant, researcher, and teacher all focus on the same section order.

## Before recording

- confirm participant id and group
- confirm the score segment or whole-piece recording source
- enable \`melody-focus\` for mixed erhu + piano audio
- keep the same device and distance across repeated takes when possible

## Recommended review order

${lines || "- none"}

## After recording

- export the whole-piece pass result
- attach teacher review for the weak sections first
- log whether the participant understood the structured feedback
- record whether the system path suggestion matched teacher judgment
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const topCount = Math.max(1, toNumber(args["top-count"], 8));
  let piecePassPath = args["piece-pass-json"] ? path.resolve(repoRoot, args["piece-pass-json"]) : "";

  if (!piecePassPath) {
    const candidates = await resolveLatestWholePiecePass(path.resolve(repoRoot, "data", "piece-pass"));
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    if (!candidates.length) {
      throw new Error("No whole-piece pass JSON files were found under data/piece-pass.");
    }
    piecePassPath = candidates[0].path;
  }

  const payload = JSON.parse(await fs.readFile(piecePassPath, "utf-8"));
  const summary = payload.summary || {};
  const sectionPasses = Array.isArray(payload.sectionPasses) ? [...payload.sectionPasses] : [];
  sectionPasses.sort((left, right) => toNumber(left.combinedScore, 999) - toNumber(right.combinedScore, 999));

  const outputDir = path.resolve(
    repoRoot,
    args["output-dir"] || path.join("data", "pilot-pack", `${summary.pieceId || payload.pieceId || "piece"}-pilot`),
  );
  await fs.mkdir(outputDir, { recursive: true });

  const weakestRows = sectionPasses.map((row, index) => ({
    rank: index + 1,
    pieceId: row.pieceId,
    pieceTitle: row.pieceTitle,
    sequenceIndex: row.sequenceIndex,
    sectionId: row.sectionId,
    sectionTitle: row.sectionTitle,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds,
    durationSeconds: row.durationSeconds,
    noteCount: row.noteCount,
    combinedScore: row.combinedScore,
    overallPitchScore: row.overallPitchScore,
    overallRhythmScore: row.overallRhythmScore,
    confidence: row.confidence,
    recommendedPracticePath: row.recommendedPracticePath,
    summaryText: row.summaryText,
    teacherComment: row.teacherComment,
  }));

  const teacherValidationRows = weakestRows.slice(0, topCount).map((row) => ({
    ...row,
    teacherPrimaryPath: "",
    teacherIssueNoteIds: "",
    teacherIssueMeasureIndexes: "",
    teacherCommentManual: "",
    agreementWithSystem: "",
    needsAdjudication: "",
  }));

  const manifest = {
    sourceWholePiecePass: piecePassPath,
    generatedAt: new Date().toISOString(),
    pieceId: summary.pieceId || payload.pieceId,
    pieceTitle: summary.pieceTitle || payload.pieceId,
    structuredSectionCount: summary.structuredSectionCount || 0,
    structuredNoteCount: summary.structuredNoteCount || 0,
    weightedPitchScore: summary.weightedPitchScore ?? null,
    weightedRhythmScore: summary.weightedRhythmScore ?? null,
    weightedCombinedScore: summary.weightedCombinedScore ?? null,
    dominantPracticePath: summary.dominantPracticePath || "review-first",
    topWeakSections: weakestRows.slice(0, topCount).map((row) => ({
      rank: row.rank,
      sectionId: row.sectionId,
      sectionTitle: row.sectionTitle,
      combinedScore: row.combinedScore,
      recommendedPracticePath: row.recommendedPracticePath,
      startSeconds: row.startSeconds,
      endSeconds: row.endSeconds,
    })),
  };

  await fs.writeFile(
    path.join(outputDir, `${manifest.pieceId}-pilot-overview.md`),
    buildOverviewMarkdown(payload, weakestRows, topCount),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outputDir, `${manifest.pieceId}-participant-run-sheet.md`),
    buildParticipantRunSheet(payload, weakestRows, topCount),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outputDir, `${manifest.pieceId}-weak-sections.csv`),
    toCsv(weakestRows, [
      "rank",
      "pieceId",
      "pieceTitle",
      "sequenceIndex",
      "sectionId",
      "sectionTitle",
      "startSeconds",
      "endSeconds",
      "durationSeconds",
      "noteCount",
      "combinedScore",
      "overallPitchScore",
      "overallRhythmScore",
      "confidence",
      "recommendedPracticePath",
      "summaryText",
      "teacherComment",
    ]),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outputDir, `${manifest.pieceId}-teacher-validation-sheet.csv`),
    toCsv(teacherValidationRows, [
      "rank",
      "pieceId",
      "pieceTitle",
      "sequenceIndex",
      "sectionId",
      "sectionTitle",
      "startSeconds",
      "endSeconds",
      "combinedScore",
      "recommendedPracticePath",
      "teacherPrimaryPath",
      "teacherIssueNoteIds",
      "teacherIssueMeasureIndexes",
      "teacherCommentManual",
      "agreementWithSystem",
      "needsAdjudication",
    ]),
    "utf-8",
  );
  await fs.writeFile(path.join(outputDir, `${manifest.pieceId}-pilot-manifest.json`), JSON.stringify(manifest, null, 2), "utf-8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputDir,
        pieceId: manifest.pieceId,
        topWeakSection: manifest.topWeakSections[0] || null,
        fileCount: 5,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
