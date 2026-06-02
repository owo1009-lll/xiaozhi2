#!/usr/bin/env node
// Plan C anchoring aid: cut a long recording into sequential overlapping review clips
// + a timestamp index + a manifest skeleton with the constant columns pre-filled.
// You listen through the clips, and for each clean erhu passage fill the anchor fields
// (audio start/end in SOURCE seconds, score page, measure range, phraseNote) and set
// humanMatched=yes, then run scripts/build-manual-anchor-pack.mjs. This only slices
// audio for listening -- it does NOT auto-propose windows (automatic alignment is
// unreliable here), so nothing misleads the human anchor.
//
// Run:
//   node scripts/slice-review-clips.mjs --audio data/real-tests/originals/second-rhapsody-full.mp3 \
//     --label 2nd --piece-title "第二号狂想曲" --source-long-piece second-rhapsody \
//     --score-id score-moef6aiw-f1evny --score-pdf data/score-imports/scorejob-momnhibn-4ha9k0/source.pdf \
//     --output-dir "C:/Users/Administrator/Desktop/erhu-anchor-clips/second-rhapsody"
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    audio: "", label: "clip", clipSeconds: 45, overlap: 5, outputDir: "",
    pieceTitle: "", sourceLongPiece: "", scoreId: "", scorePdf: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--audio") parsed.audio = argv[++i];
    else if (a === "--label") parsed.label = argv[++i];
    else if (a === "--clip-seconds") parsed.clipSeconds = Math.max(5, Number(argv[++i]) || parsed.clipSeconds);
    else if (a === "--overlap") parsed.overlap = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--output-dir") parsed.outputDir = argv[++i];
    else if (a === "--piece-title") parsed.pieceTitle = argv[++i];
    else if (a === "--source-long-piece") parsed.sourceLongPiece = argv[++i];
    else if (a === "--score-id") parsed.scoreId = argv[++i];
    else if (a === "--score-pdf") parsed.scorePdf = argv[++i];
  }
  return parsed;
}

function resolveInput(p) {
  const t = String(p || "").trim();
  if (!t) return "";
  return path.isAbsolute(t) ? t : path.resolve(REPO_ROOT, t);
}

function audioDurationSeconds(absAudio) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", absAudio,
  ], { encoding: "utf8" });
  const value = Number(String(out).trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`could not read duration: ${absAudio}`);
  return value;
}

function stamp(seconds) {
  const total = Math.round(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}m${ss}s`;
}

async function main() {
  const args = parseArgs();
  if (!args.audio) throw new Error("--audio is required");
  const absAudio = resolveInput(args.audio);
  if (!fs.existsSync(absAudio)) throw new Error(`audio not found: ${absAudio}`);
  const sourceAudioRepoRel = path.relative(REPO_ROOT, absAudio).split(path.sep).join("/");

  const duration = audioDurationSeconds(absAudio);
  const step = Math.max(1, args.clipSeconds - args.overlap);
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(REPO_ROOT, "data", "teacher-manual-anchors", "review-clips", args.label);
  await fsp.mkdir(outputDir, { recursive: true });

  const indexRows = [["clipFile", "startSeconds", "endSeconds", "startStamp", "endStamp"]];
  let clipCount = 0;
  for (let start = 0; start < duration; start += step) {
    const end = Math.min(duration, start + args.clipSeconds);
    const clipName = `${args.label}_${stamp(start)}-${stamp(end)}.mp3`;
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-ss", String(start), "-to", String(end),
      "-i", absAudio, "-c", "copy", path.join(outputDir, clipName),
    ]);
    indexRows.push([clipName, start.toFixed(1), end.toFixed(1), stamp(start), stamp(end)]);
    clipCount += 1;
    if (end >= duration) break;
  }

  await fsp.writeFile(
    path.join(outputDir, "INDEX.csv"),
    indexRows.map((r) => r.join(",")).join("\n") + "\n", "utf8",
  );

  // manifest skeleton: constants pre-filled, anchor fields blank for the human.
  const header = "pieceTitle,sourceLongPiece,sourceAudioPath,scorePdfPath,scoreId,audioStartSeconds,audioEndSeconds,scorePage,measureRange,phraseNote,humanMatched";
  const exampleRow = [
    args.pieceTitle, args.sourceLongPiece, sourceAudioRepoRel, args.scorePdf, args.scoreId,
    "<start>", "<end>", "<page>", "<m1-mN>", "<乐句说明>", "no",
  ].join(",");
  await fsp.writeFile(
    path.join(outputDir, "manifest-skeleton.csv"),
    [
      `# Listen through the clips (see INDEX.csv for each clip's SOURCE start time).`,
      `# A clip named ${args.label}_05m00s-05m45s starts at 300s; a phrase 12s into it -> source 312s.`,
      `# Fill one row per clean erhu passage: real audioStartSeconds/audioEndSeconds (SOURCE seconds),`,
      `# scorePage + measureRange (printed numbers), phraseNote, then set humanMatched=yes.`,
      `# Copy filled rows into data/teacher-manual-anchors/manifest.csv and run build-manual-anchor-pack.mjs.`,
      header,
      exampleRow,
    ].join("\n") + "\n", "utf8",
  );

  console.log(JSON.stringify({
    ok: true,
    audio: sourceAudioRepoRel,
    durationSeconds: Number(duration.toFixed(1)),
    clipSeconds: args.clipSeconds,
    overlap: args.overlap,
    clipCount,
    outputDir,
  }, null, 2));
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
