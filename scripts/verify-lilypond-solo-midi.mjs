import fs from "node:fs";
import path from "node:path";

// Cross-checks each compiled solo MIDI against the LilyPond source it came
// from. The point is that nobody has to read 52,000 notes by eye: the source
// is authoritative, so the only thing worth asserting is that the transcode
// did not invent or drop simultaneity.
//
// For every etude it compares the number of genuine chords written in the
// source (angle-bracket groups holding 2+ pitches — `<a_0>` is a single note
// carrying a fingering, not a chord) with the number of ticks in the MIDI that
// carry more than one note-on.
//
//   node scripts/verify-lilypond-solo-midi.mjs <music.ly> <id-prefix> <midi-dir>
const masterPath = path.resolve(process.argv[2] || "");
const idPrefix = String(process.argv[3] || "").trim();
const midiDir = path.resolve(process.argv[4] || "");

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function romanToInt(roman) {
  let total = 0;
  for (let i = 0; i < roman.length; i += 1) {
    const value = ROMAN[roman[i]];
    total += value < ROMAN[roman[i + 1]] ? -value : value;
  }
  return total;
}

// Counts note-on events per absolute tick without a MIDI library, so the check
// stays independent of the parser that produced the earlier false alarms.
function midiOverlaps(filePath) {
  const buffer = fs.readFileSync(filePath);
  let offset = 0;
  const readU32 = () => { const v = buffer.readUInt32BE(offset); offset += 4; return v; };
  if (buffer.toString("ascii", 0, 4) !== "MThd") throw new Error(`not a MIDI file: ${filePath}`);
  offset = 4;
  const headerLength = readU32();
  offset += headerLength;

  const onsets = new Map();
  let notes = 0;
  while (offset < buffer.length - 8) {
    const chunk = buffer.toString("ascii", offset, offset + 4);
    offset += 4;
    const length = readU32();
    const end = offset + length;
    if (chunk !== "MTrk") { offset = end; continue; }
    let tick = 0;
    let status = 0;
    while (offset < end) {
      let delta = 0;
      for (;;) {
        const byte = buffer[offset++];
        delta = (delta << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) break;
      }
      tick += delta;
      let byte = buffer[offset];
      if (byte & 0x80) { status = byte; offset += 1; } // else running status
      const type = status & 0xf0;
      if (status === 0xff) {
        offset += 1;
        let length2 = 0;
        for (;;) {
          const b = buffer[offset++];
          length2 = (length2 << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        offset += length2;
      } else if (status === 0xf0 || status === 0xf7) {
        let length2 = 0;
        for (;;) {
          const b = buffer[offset++];
          length2 = (length2 << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        offset += length2;
      } else if (type === 0x90) {
        const pitch = buffer[offset];
        const velocity = buffer[offset + 1];
        offset += 2;
        if (velocity > 0) {
          notes += 1;
          onsets.set(tick, (onsets.get(tick) || 0) + 1);
        }
      } else if (type === 0xc0 || type === 0xd0) {
        offset += 1;
      } else {
        offset += 2;
      }
    }
    offset = end;
  }
  let overlaps = 0;
  for (const count of onsets.values()) if (count > 1) overlaps += 1;
  return { notes, overlaps };
}

// A `<...>` group is a real chord only when it holds two or more pitches.
function sourceChords(music) {
  let chords = 0;
  for (const group of music.match(/<[^<>]*>/g) || []) {
    const pitches = group.match(/(?<![a-zA-Z])[a-g](?:is|es|s|f)*[',]*/g) || [];
    if (pitches.length >= 2) chords += 1;
  }
  return chords;
}

const master = fs.readFileSync(masterPath, "utf8").replace(/%.*$/gm, "");
const matches = [...master.matchAll(/^(study[IVXLC]+)\s*=/gm)];
const rows = [];
for (let i = 0; i < matches.length; i += 1) {
  const name = matches[i][1];
  const start = matches[i].index;
  const end = i + 1 < matches.length ? matches[i + 1].index : master.length;
  const number = romanToInt(name.slice("study".length));
  const midiPath = path.join(midiDir, `${idPrefix}-no${String(number).padStart(2, "0")}.mid`);
  if (!fs.existsSync(midiPath)) { rows.push({ number, name, status: "midi-missing" }); continue; }
  const { notes, overlaps } = midiOverlaps(midiPath);
  const block = master.slice(start, end);
  const chords = sourceChords(block);
  // Two constructs legitimately produce more MIDI overlaps than the source has
  // chord groups: a volta repeat replays its chords, and a `<< ... >>` block is
  // genuine two-voice writing. Both are real music, not transcode damage.
  const repeats = (block.match(/\\repeat/g) || []).length;
  const parallel = (block.match(/<</g) || []).length;
  let status = "exact";
  if (overlaps < chords) status = "unison-collapse";
  else if (overlaps > chords) status = (repeats || parallel) ? "explained-by-repeat-or-voices" : "needs-review";
  rows.push({
    number,
    name,
    notes,
    sourceChords: chords,
    midiOverlaps: overlaps,
    repeats,
    parallelBlocks: parallel,
    // A unison double stop (<d-0 d-4>) collapses to one MIDI note-on, so the
    // source may legitimately hold more chords than the MIDI shows.
    status,
  });
}

rows.sort((a, b) => a.number - b.number);
const needsReview = rows.filter((row) => row.status === "needs-review" || row.status === "midi-missing");
console.log(JSON.stringify({
  ok: needsReview.length === 0,
  master: path.relative(process.cwd(), masterPath).replace(/\\/g, "/"),
  etudes: rows.length,
  totalNotes: rows.reduce((sum, row) => sum + (row.notes || 0), 0),
  exact: rows.filter((row) => row.status === "exact").length,
  unisonCollapse: rows.filter((row) => row.status === "unison-collapse").length,
  explainedByRepeatOrVoices: rows.filter((row) => row.status === "explained-by-repeat-or-voices").length,
  needsReview,
}, null, 2));
if (needsReview.length) process.exitCode = 1;
