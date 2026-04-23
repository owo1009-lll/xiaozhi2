import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getErhuPiece } from "../src/erhuStudyPieces.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readArg(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index < process.argv.length - 1) {
    return process.argv[index + 1];
  }
  return fallback;
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function meterBeats(meter = "4/4") {
  const [beats] = String(meter).split("/");
  return Math.max(1, safeNumber(beats, 4));
}

function sectionLengthBeats(section) {
  return (section.notes || []).reduce((maxValue, note) => {
    const endBeat = (safeNumber(note.measureIndex, 1) - 1) * meterBeats(section.meter) + safeNumber(note.beatStart, 0) + safeNumber(note.beatDuration, 1);
    return Math.max(maxValue, endBeat);
  }, 0);
}

function flattenPiece(piece) {
  let cursorBeats = 0;
  let measureCursor = 1;
  const flattened = [];

  for (const section of piece.sections || []) {
    const beatsPerMeasure = meterBeats(section.meter);
    const sectionLength = Math.max(sectionLengthBeats(section), beatsPerMeasure);
    const measureSpan = Math.max(1, Math.ceil(sectionLength / beatsPerMeasure));

    for (const note of section.notes || []) {
      const localBeat = (safeNumber(note.measureIndex, 1) - 1) * beatsPerMeasure + safeNumber(note.beatStart, 0);
      flattened.push({
        ...note,
        sectionId: section.sectionId,
        sectionTitle: section.title,
        tempo: section.tempo,
        meter: section.meter,
        globalStartBeat: cursorBeats + localBeat,
        globalDurationBeat: safeNumber(note.beatDuration, 1),
        globalMeasureIndex: measureCursor + safeNumber(note.measureIndex, 1) - 1,
      });
    }

    cursorBeats += sectionLength;
    measureCursor += measureSpan;
  }

  return flattened.sort((left, right) => left.globalStartBeat - right.globalStartBeat);
}

function buildNoteJson(piece) {
  const flattened = flattenPiece(piece);
  return {
    pieceId: piece.pieceId,
    title: piece.title,
    composer: piece.composer,
    targetSkills: piece.targetSkills || [],
    difficulty: piece.difficulty,
    coverageMode: piece.coverageMode || "fragment",
    sourceAudio: piece.sourceAudio || "",
    sourceScore: piece.sourceScore || "",
    wholePieceExportReady: Boolean(piece.wholePieceExportReady),
    sections: (piece.sections || []).map((section) => ({
      sectionId: section.sectionId,
      title: section.title,
      tempo: section.tempo,
      meter: section.meter,
      sequenceIndex: section.sequenceIndex,
      researchWindowHints: section.researchWindowHints || [],
      notes: section.notes || [],
    })),
    sectionTimeline: (piece.sections || []).map((section, index) => {
      const priorSections = (piece.sections || []).slice(0, index);
      const startBeat = priorSections.reduce((sum, item) => sum + Math.max(sectionLengthBeats(item), meterBeats(item.meter)), 0);
      const durationBeats = Math.max(sectionLengthBeats(section), meterBeats(section.meter));
      const secondsPerBeat = 60 / Math.max(30, safeNumber(section.tempo, 72));
      return {
        sectionId: section.sectionId,
        title: section.title,
        sequenceIndex: section.sequenceIndex,
        meter: section.meter,
        tempo: section.tempo,
        startBeat,
        durationBeats,
        estimatedDurationSeconds: Number((durationBeats * secondsPerBeat).toFixed(2)),
        researchWindowHints: section.researchWindowHints || [],
      };
    }),
    aggregateNotes: flattened,
  };
}

function buildMusicXml(piece) {
  const divisions = 8;
  const measures = [];
  let globalMeasure = 1;

  for (const section of piece.sections || []) {
    const beatsPerMeasure = meterBeats(section.meter);
    const beatType = safeNumber(String(section.meter).split("/")[1], 4);
    const sectionLength = Math.max(sectionLengthBeats(section), beatsPerMeasure);
    const measureCount = Math.max(1, Math.ceil(sectionLength / beatsPerMeasure));
    const notesByMeasure = new Map();

    for (const note of section.notes || []) {
      const measureIndex = safeNumber(note.measureIndex, 1);
      if (!notesByMeasure.has(measureIndex)) {
        notesByMeasure.set(measureIndex, []);
      }
      notesByMeasure.get(measureIndex).push(note);
    }

    for (let localMeasure = 1; localMeasure <= measureCount; localMeasure += 1) {
      const xmlParts = [];
      xmlParts.push(`<measure number="${globalMeasure}">`);
      if (localMeasure === 1) {
        xmlParts.push(
          "<attributes>",
          `<divisions>${divisions}</divisions>`,
          "<key><fifths>2</fifths></key>",
          `<time><beats>${beatsPerMeasure}</beats><beat-type>${beatType}</beat-type></time>`,
          "<clef><sign>G</sign><line>2</line></clef>",
          "</attributes>",
          `<direction placement="above"><direction-type><words>${section.title}</words></direction-type><sound tempo="${section.tempo}"/></direction>`,
        );
      }

      const notes = (notesByMeasure.get(localMeasure) || []).slice().sort((left, right) => safeNumber(left.beatStart, 0) - safeNumber(right.beatStart, 0));
      let cursor = 0;
      const measureTotal = beatsPerMeasure;
      for (const note of notes) {
        const noteStart = safeNumber(note.beatStart, 0);
        const noteDuration = safeNumber(note.beatDuration, 1);
        if (noteStart > cursor) {
          const restDuration = noteStart - cursor;
          xmlParts.push(
            "<note>",
            "<rest/>",
            `<duration>${Math.round(restDuration * divisions)}</duration>`,
            "</note>",
          );
        }
        const midiPitch = safeNumber(note.midiPitch, 60);
        const pitchClass = midiPitch % 12;
        const octave = Math.floor(midiPitch / 12) - 1;
        const pitchMap = {
          0: ["C", 0],
          1: ["C", 1],
          2: ["D", 0],
          3: ["D", 1],
          4: ["E", 0],
          5: ["F", 0],
          6: ["F", 1],
          7: ["G", 0],
          8: ["G", 1],
          9: ["A", 0],
          10: ["A", 1],
          11: ["B", 0],
        };
        const [step, alter] = pitchMap[pitchClass];
        xmlParts.push(
          "<note>",
          "<pitch>",
          `<step>${step}</step>`,
          alter ? `<alter>${alter}</alter>` : "",
          `<octave>${octave}</octave>`,
          "</pitch>",
          `<duration>${Math.round(noteDuration * divisions)}</duration>`,
          "</note>",
        );
        cursor = noteStart + noteDuration;
      }
      if (cursor < measureTotal) {
        xmlParts.push(
          "<note>",
          "<rest/>",
          `<duration>${Math.round((measureTotal - cursor) * divisions)}</duration>`,
          "</note>",
        );
      }
      xmlParts.push("</measure>");
      measures.push(xmlParts.filter(Boolean).join(""));
      globalMeasure += 1;
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="3.1">',
    "<work><work-title>",
    piece.title,
    "</work-title></work>",
    "<part-list><score-part id=\"P1\"><part-name>Erhu</part-name></score-part></part-list>",
    "<part id=\"P1\">",
    measures.join(""),
    "</part>",
    "</score-partwise>",
  ].join("");
}

function encodeVariableLength(value) {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }
  return bytes;
}

function buildMidi(piece) {
  const ticksPerQuarter = 480;
  const events = [];
  const trackTitle = Buffer.from(piece.title, "utf8");
  events.push({ tick: 0, bytes: [0xff, 0x03, trackTitle.length, ...trackTitle] });
  events.push({ tick: 0, bytes: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] });

  let sectionStartBeat = 0;
  for (const section of piece.sections || []) {
    const microsecondsPerQuarter = Math.round(60000000 / Math.max(30, safeNumber(section.tempo, 72)));
    const tempoBytes = [(microsecondsPerQuarter >> 16) & 0xff, (microsecondsPerQuarter >> 8) & 0xff, microsecondsPerQuarter & 0xff];
    events.push({ tick: Math.round(sectionStartBeat * ticksPerQuarter), bytes: [0xff, 0x51, 0x03, ...tempoBytes] });

    const sectionLabel = Buffer.from(section.title, "utf8");
    events.push({ tick: Math.round(sectionStartBeat * ticksPerQuarter), bytes: [0xff, 0x01, sectionLabel.length, ...sectionLabel] });

    const beatsPerMeasure = meterBeats(section.meter);
    for (const note of section.notes || []) {
      const noteStart = (safeNumber(note.measureIndex, 1) - 1) * beatsPerMeasure + safeNumber(note.beatStart, 0);
      const startTick = Math.round((sectionStartBeat + noteStart) * ticksPerQuarter);
      const endTick = startTick + Math.round(safeNumber(note.beatDuration, 1) * ticksPerQuarter);
      const midiPitch = safeNumber(note.midiPitch, 60);
      events.push({ tick: startTick, bytes: [0x90, midiPitch, 0x64] });
      events.push({ tick: endTick, bytes: [0x80, midiPitch, 0x40] });
    }
    sectionStartBeat += Math.max(sectionLengthBeats(section), beatsPerMeasure);
  }

  events.sort((left, right) => left.tick - right.tick || left.bytes[0] - right.bytes[0]);

  let lastTick = 0;
  const trackBytes = [];
  for (const event of events) {
    const delta = Math.max(0, event.tick - lastTick);
    trackBytes.push(...encodeVariableLength(delta), ...event.bytes);
    lastTick = event.tick;
  }
  trackBytes.push(0x00, 0xff, 0x2f, 0x00);

  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (ticksPerQuarter >> 8) & 0xff, ticksPerQuarter & 0xff,
  ]);
  const trackHeader = Buffer.from([
    0x4d, 0x54, 0x72, 0x6b,
    (trackBytes.length >> 24) & 0xff,
    (trackBytes.length >> 16) & 0xff,
    (trackBytes.length >> 8) & 0xff,
    trackBytes.length & 0xff,
  ]);

  return Buffer.concat([header, trackHeader, Buffer.from(trackBytes)]);
}

async function main() {
  const pieceId = readArg("--piece-id", "taohuawu-test-fragment");
  const outputDir = path.resolve(repoRoot, readArg("--output-dir", `data/score-exports/${pieceId}`));
  const piece = getErhuPiece(pieceId);
  if (!piece) {
    throw new Error(`piece not found: ${pieceId}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  const notesJson = buildNoteJson(piece);
  const musicXml = buildMusicXml(piece);
  const midiBuffer = buildMidi(piece);
  const structureJson = {
    pieceId: piece.pieceId,
    title: piece.title,
    coverageMode: piece.coverageMode || "fragment",
    sectionCount: piece.sections?.length || 0,
    sectionIds: (piece.sections || []).map((section) => section.sectionId),
    sourceAudio: piece.sourceAudio || "",
    sourceScore: piece.sourceScore || "",
    wholePieceExportReady: Boolean(piece.wholePieceExportReady),
    exportedAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(outputDir, `${pieceId}.notes.json`), JSON.stringify(notesJson, null, 2), "utf8");
  await fs.writeFile(path.join(outputDir, `${pieceId}.musicxml`), musicXml, "utf8");
  await fs.writeFile(path.join(outputDir, `${pieceId}.mid`), midiBuffer);
  await fs.writeFile(path.join(outputDir, `${pieceId}.structure.json`), JSON.stringify(structureJson, null, 2), "utf8");

  console.log(JSON.stringify({
    ok: true,
    pieceId,
    outputDir,
    files: [`${pieceId}.notes.json`, `${pieceId}.musicxml`, `${pieceId}.mid`, `${pieceId}.structure.json`],
    sectionCount: piece.sections?.length || 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
