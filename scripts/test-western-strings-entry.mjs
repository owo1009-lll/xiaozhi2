import assert from "node:assert/strict";
import fs from "node:fs";

const mainApp = fs.readFileSync("src/MainApp.jsx", "utf8");
const stringsApp = fs.readFileSync("src/WesternStringsApp.jsx", "utf8");
const api = fs.readFileSync("src/researchApi.js", "utf8");

assert(mainApp.includes('params.get("mode") === "strings"'), "MainApp should expose ?mode=strings");
assert(mainApp.includes("WesternStringsApp"), "MainApp should lazy-load WesternStringsApp");

assert(stringsApp.includes("importScoreMusicXml"), "Western strings entry should support MusicXML");
assert(stringsApp.includes("importScoreMidi"), "Western strings entry should support MIDI");
assert(!stringsApp.includes("importScorePdf"), "Western strings entry must not import the PDF/OMR path");
assert(!stringsApp.includes("application/pdf"), "Western strings entry must not expose PDF file inputs");
assert(stringsApp.includes('scoreSource: scoreKind'), "Western strings entry should pass scoreSource metadata");
assert(stringsApp.includes('tempoKnown: scoreKind === "midi"'), "Western strings entry should distinguish MIDI known tempo from MusicXML unknown tempo");

assert(api.includes("export async function importScoreMidi"), "research API should expose MIDI import helper");
assert(api.includes("/api/erhu/scores/import-midi"), "MIDI helper should call the MIDI import route");

console.log(JSON.stringify({ ok: true, checks: ["western-strings-entry-clean-score-only"] }));
