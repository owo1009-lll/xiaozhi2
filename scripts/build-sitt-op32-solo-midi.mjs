import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Compiles the Mutopia Sitt Op.32 Book 1 LilyPond sources into one solo-violin
// MIDI per etude.
//
// This is transcoding, not recognition: the .ly files ARE the source the
// published PDF was engraved from, so the resulting pitches and durations are
// exact. No OMR, and therefore no per-note human verification.
//
// Each etude names its music variable with a Portuguese ordinal (um, dois,
// tres, ...), so the name is read out of the file rather than assumed. Exactly
// one etude is included per compile, and the wrapper forces a single
// \new Staff, which keeps the output monophonic even if a source ever gained a
// second voice.
//
//   node scripts/build-sitt-op32-solo-midi.mjs <lys-dir> <out-dir>
const LILYPOND = path.join(
  process.env.LOCALAPPDATA || "",
  "Microsoft/WinGet/Packages/LilyPond.LilyPond_Microsoft.Winget.Source_8wekyb3d8bbwe/lilypond-2.24.4/bin/lilypond.exe",
);

const sourceDir = path.resolve(process.argv[2] || "");
const outDir = path.resolve(process.argv[3] || "");
if (!fs.existsSync(sourceDir)) throw new Error(`source dir not found: ${sourceDir}`);
if (!fs.existsSync(LILYPOND)) throw new Error(`LilyPond not found: ${LILYPOND}`);
fs.mkdirSync(outDir, { recursive: true });

const etudes = fs.readdirSync(sourceDir)
  .filter((name) => /^\d+\.ly$/.test(name))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

const built = [];
const failed = [];
for (const name of etudes) {
  const number = Number.parseInt(name, 10);
  const id = `sitt-op32-book1-no${String(number).padStart(2, "0")}`;

  const music = fs.readFileSync(path.join(sourceDir, name), "utf8");
  const variable = music.match(/^\s*([A-Za-z]+)\s*=\s*\\relative/m)?.[1];
  if (!variable) {
    failed.push({ etude: number, reason: "music variable not found in source" });
    continue;
  }

  const wrapper = path.join(sourceDir, `_solo-${number}.ly`);
  fs.writeFileSync(wrapper, [
    '\\version "2.24.4"',
    '\\include "defs.ly"',
    `\\include "${name}"`,
    `\\score { \\new Staff \\${variable} \\midi { } }`,
    "",
  ].join("\n"), "utf8");

  try {
    // LilyPond names the MIDI after the input file and writes it beside it.
    execFileSync(LILYPOND, ["-s", `_solo-${number}.ly`], { cwd: sourceDir, timeout: 180000 });
  } catch {
    // A non-zero exit is common for these 2.12-era sources (deprecation
    // warnings); the MIDI is still produced, so the file check below decides.
  }
  const produced = path.join(sourceDir, `_solo-${number}.mid`);
  if (!fs.existsSync(produced)) {
    failed.push({ etude: number, reason: "no midi produced" });
    continue;
  }
  const destination = path.join(outDir, `${id}.mid`);
  fs.copyFileSync(produced, destination);
  built.push({
    etude: number,
    id,
    midi: path.relative(process.cwd(), destination).replace(/\\/g, "/"),
    bytes: fs.statSync(destination).size,
  });
}

console.log(JSON.stringify({
  ok: failed.length === 0,
  source: "Mutopia Project #929 — Hans Sitt, 100 Etudes Op.32 Book 1",
  license: "CC BY-SA 2.5",
  attributionRequired: true,
  etudesFound: etudes.length,
  built: built.length,
  failed,
  outputs: built,
}, null, 2));
if (failed.length) process.exitCode = 1;
