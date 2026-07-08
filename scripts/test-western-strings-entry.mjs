import assert from "node:assert/strict";
import fs from "node:fs";

const mainApp = fs.readFileSync("src/MainApp.jsx", "utf8");
const stringsApp = fs.readFileSync("src/WesternStringsApp.jsx", "utf8");
const api = fs.readFileSync("src/researchApi.js", "utf8");

assert(mainApp.includes('params.get("mode") === "strings"'), "MainApp should expose ?mode=strings");
assert(mainApp.includes("WesternStringsApp"), "MainApp should lazy-load WesternStringsApp");

assert(stringsApp.includes("importScoreMusicXml"), "Western strings entry should support MusicXML");
assert(stringsApp.includes("importScoreMidi"), "Western strings entry should support MIDI");
assert(stringsApp.includes("fetchWesternStudentAnalysis"), "Western strings entry should expose the M3-gated student analysis preview");
assert(stringsApp.includes("saveWesternStudentReview"), "Western strings entry should save M3 review feedback");
assert(stringsApp.includes("Submit recording for review"), "Western strings entry should expose controlled recording intake");
assert(stringsApp.includes("Submit for offline review"), "Western strings entry should keep uploaded audio in offline review");
assert(stringsApp.includes("audioInputRef"), "Western strings entry should include an audio file input");
assert(stringsApp.includes("Controlled submissions"), "Western strings entry should expose the offline controlled-submission queue");
assert(stringsApp.includes("accepted_for_batch"), "Western strings entry should allow safe offline batch handoff");
assert(stringsApp.includes("reject_unsupported"), "Western strings entry should allow unsupported submissions to be rejected");
assert(stringsApp.includes("Run batch audit"), "Western strings entry should expose a fail-closed batch audit trigger");
assert(stringsApp.includes("No automatic diagnosis was issued"), "Western strings entry should make batch audit non-student-facing");
assert(!stringsApp.includes("importScorePdf"), "Western strings entry must not import the PDF/OMR path");
assert(!stringsApp.includes("application/pdf"), "Western strings entry must not expose PDF file inputs");
assert(stringsApp.includes('scoreSource: scoreKind'), "Western strings entry should pass scoreSource metadata");
assert(stringsApp.includes('tempoKnown: scoreKind === "midi"'), "Western strings entry should distinguish MIDI known tempo from MusicXML unknown tempo");

assert(api.includes("export async function importScoreMidi"), "research API should expose MIDI import helper");
assert(api.includes("/api/erhu/scores/import-midi"), "MIDI helper should call the MIDI import route");
assert(api.includes("export async function fetchWesternStudentAnalysis"), "research API should expose western student analysis helper");
assert(api.includes("/api/strings/analyze"), "western student analysis helper should call the gated route");
assert(api.includes("payload?.audioFile instanceof File"), "western student analysis helper should submit uploaded audio as multipart form data");
assert(api.includes("export async function fetchWesternControlledSubmissions"), "research API should expose controlled-submission queue helper");
assert(api.includes("/api/strings/controlled-submissions"), "controlled-submission helper should call the review queue route");
assert(api.includes("export async function saveWesternControlledSubmissionReview"), "research API should expose controlled-submission review helper");
assert(api.includes("export async function runWesternControlledSubmissionBatch"), "research API should expose controlled-submission batch helper");
assert(api.includes("/api/strings/controlled-submissions/run-batch"), "controlled-submission batch helper should call the batch route");
assert(api.includes("export async function saveWesternStudentReview"), "research API should expose western student review helper");
assert(api.includes("/api/strings/review"), "western student review helper should call the gated route");

console.log(JSON.stringify({ ok: true, checks: ["western-strings-entry-clean-score-only", "western-strings-m3-ui-hook"] }));
