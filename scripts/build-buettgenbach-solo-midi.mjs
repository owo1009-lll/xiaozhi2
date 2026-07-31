import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Compiles the Büttgenbach LilyPond editions (Kayser Op.20, Wohlfahrt Op.45)
// into one solo-violin MIDI per etude.
//
// Transcoding, not recognition: the .ly file IS the source the published PDF
// was engraved from, so pitches and durations are exact and no per-note human
// verification is needed.
//
// Both books keep every etude in a single master file as `study<ROMAN>`.
// Sibling variables `study<ROMAN>prologI/II` are the preparatory bowing
// exercises printed above an etude and `study<ROMAN>theme` is a theme snippet;
// neither is part of the etude, so only bare roman-numeral names are compiled.
//
//   node scripts/build-buettgenbach-solo-midi.mjs <master.ly> <id-prefix> <out-dir>
const LILYPOND = path.join(
  process.env.LOCALAPPDATA || "",
  "Microsoft/WinGet/Packages/LilyPond.LilyPond_Microsoft.Winget.Source_8wekyb3d8bbwe/lilypond-2.24.4/bin/lilypond.exe",
);

const masterPath = path.resolve(process.argv[2] || "");
const idPrefix = String(process.argv[3] || "").trim();
const outDir = path.resolve(process.argv[4] || "");
if (!fs.existsSync(masterPath)) throw new Error(`master .ly not found: ${masterPath}`);
if (!idPrefix) throw new Error("id prefix is required");
if (!fs.existsSync(LILYPOND)) throw new Error(`LilyPond not found: ${LILYPOND}`);
fs.mkdirSync(outDir, { recursive: true });

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function romanToInt(roman) {
  let total = 0;
  for (let i = 0; i < roman.length; i += 1) {
    const value = ROMAN[roman[i]];
    total += value < ROMAN[roman[i + 1]] ? -value : value;
  }
  return total;
}

const sourceDir = path.dirname(masterPath);
const master = fs.readFileSync(masterPath, "utf8");

// The published build runs `m4 master.ly | lilypond -`: the tail of the file is
// an m4 template that emits \score blocks and book structure. m4 is not
// required here because that tail contains no music — every note lives in the
// plain LilyPond section above it, and this script writes its own \score. So
// the file is cut at the first m4 directive and only the music is included.
const masterLines = master.split(/\r?\n/);
const m4Start = masterLines.findIndex((line) => /^(include|define|dnl)\(/.test(line));
if (m4Start >= 0) {
  const tail = masterLines.slice(m4Start).join("\n");
  if (/^study[IVXLC]+\s*=/m.test(tail)) {
    throw new Error("m4 section contains music definitions; truncating would drop notes.");
  }
}
const musicOnly = m4Start >= 0 ? masterLines.slice(0, m4Start).join("\n") : master;
const masterName = `_music-${path.basename(masterPath)}`;
fs.writeFileSync(path.join(sourceDir, masterName), `${musicOnly}\n`, "utf8");
const studies = [...new Set(
  [...master.matchAll(/^(study[IVXLC]+)\s*=/gm)].map((match) => match[1]),
)].map((name) => ({ name, number: romanToInt(name.slice("study".length)) }))
  .sort((a, b) => a.number - b.number);

const built = [];
const failed = [];
for (const study of studies) {
  const id = `${idPrefix}-no${String(study.number).padStart(2, "0")}`;
  const wrapperName = `_solo-${study.name}.ly`;
  fs.writeFileSync(path.join(sourceDir, wrapperName), [
    '\\version "2.24.4"',
    `\\include "${masterName}"`,
    `\\score { \\new Staff \\${study.name} \\midi { } }`,
    "",
  ].join("\n"), "utf8");

  try {
    execFileSync(LILYPOND, ["-s", wrapperName], { cwd: sourceDir, timeout: 300000 });
  } catch {
    // These 2.18-era sources emit deprecation warnings and a non-zero exit
    // while still writing the MIDI, so the file check below is what decides.
  }
  const produced = path.join(sourceDir, `${wrapperName.replace(/\.ly$/, "")}.mid`);
  if (!fs.existsSync(produced)) {
    failed.push({ study: study.name, number: study.number, reason: "no midi produced" });
    continue;
  }
  const destination = path.join(outDir, `${id}.mid`);
  fs.copyFileSync(produced, destination);
  built.push({ number: study.number, variable: study.name, id, bytes: fs.statSync(destination).size });
}

console.log(JSON.stringify({
  ok: failed.length === 0,
  master: path.relative(process.cwd(), masterPath).replace(/\\/g, "/"),
  studiesFound: studies.length,
  built: built.length,
  failed,
  outputs: built,
}, null, 2));
if (failed.length) process.exitCode = 1;
