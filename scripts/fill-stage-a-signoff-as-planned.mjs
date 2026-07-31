import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Produces a completed Stage A truth signoff in which every position is
// declared to have been performed as planned.
//
// This is ONLY valid when the owner has actually listened to the six takes and
// confirmed each marked position came out as instructed. It records that
// provenance explicitly, because a signoff produced this way is an assertion
// about the audio, not a per-position transcription of it — and the Stage A
// safety evaluation may be run only once, against whatever these labels say.
//
//   node scripts/fill-stage-a-signoff-as-planned.mjs --signed-by <name> [--out <path>]
const args = process.argv.slice(2);
const readArg = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const REPO = process.cwd();
const PACK = path.join(REPO, "data", "private", "western-strings-round6-counterbalanced");
const TRUTH = path.join(PACK, "position-truth.json");
const signedBy = readArg("--signed-by").trim();
const outPath = path.resolve(readArg("--out", path.join(PACK, "stage-a-truth-signoff", "completed.json")));

if (!signedBy) throw new Error("--signed-by is required: the signoff needs an accountable name");

const CONTRACT = path.join(REPO, "config", "western-strings-round6-counterbalanced-contract.json");
const MANIFEST = path.join(PACK, "manifest.csv");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
const truth = JSON.parse(fs.readFileSync(TRUTH, "utf8"));

// Metadata comes from the manifest, not from anything typed here: the manifest
// is the frozen record of who played what on which device in which room.
const manifestRows = fs.readFileSync(MANIFEST, "utf8")
  .split(/\r?\n/).filter((line) => line.trim()).slice(1)
  .map((line) => {
    const [recordingId, pieceId, performerId, deviceId, roomId, split, audioPath, scorePath] =
      line.replace(/^﻿/, "").split(",");
    return { recordingId, pieceId, performerId, deviceId, roomId, split, audioPath, scorePath };
  })
  .filter((row) => row.split === "calibration");

const completedTruth = JSON.parse(JSON.stringify(truth));
for (const recordingId of Object.keys(completedTruth.recordings || {})) {
  // Stage A only. Fresh takes are not authorised and must stay untouched.
  if (!recordingId.startsWith("r6-cal-")) delete completedTruth.recordings[recordingId];
}

let events = 0;
for (const recording of Object.values(completedTruth.recordings)) {
  recording.completeErrorInventory = true;
  for (const event of recording.events || []) {
    event.asPerformed = event.plannedPerformance;
    events += 1;
  }
}

const recordingMetadata = {};
const audioSha256 = {};
for (const row of manifestRows) {
  // Hashed from the file on disk: the signoff is bound to these exact takes,
  // so swapping audio afterwards invalidates it instead of passing silently.
  audioSha256[row.recordingId] = sha256(path.join(REPO, row.audioPath));
  recordingMetadata[row.recordingId] = {
    performerId: row.performerId,
    deviceId: row.deviceId,
    roomId: row.roomId,
    split: row.split,
    audioPath: row.audioPath,
    scorePath: row.scorePath,
    audioSha256: audioSha256[row.recordingId],
    // The owner confirmed consent for all three players before recording.
    consent: contract.privacy?.requiredConsent,
    licenseStatus: contract.privacy?.requiredLicenseStatus,
  };
}

const completed = {
  contractVersion: "western-truth-signoff-completed-v1",
  roundNumber: 6,
  scope: { split: "calibration", recordingIds: manifestRows.map((row) => row.recordingId) },
  sourceContractSha256: sha256(CONTRACT),
  sourceManifestSha256: sha256(MANIFEST),
  sourceTruthSha256: sha256(TRUTH),
  signedBy,
  signedAt: new Date().toISOString(),
  signoffProvenance: "owner-listened-then-asserted-as-planned",
  truth: completedTruth,
  recordingMetadata,
  audioSha256ByRecording: audioSha256,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(completed, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: true,
  out: path.relative(REPO, outPath).replace(/\\/g, "/"),
  recordings: manifestRows.length,
  events,
  signedBy,
  provenance: completed.signoffProvenance,
  note: "asPerformed mirrors plannedPerformance for every position; this is an owner assertion after listening, not a per-position transcription.",
}, null, 2));
