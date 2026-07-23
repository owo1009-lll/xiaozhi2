import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyTruthSignoff } from "./apply-western-truth-signoff.mjs";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "round6-truth-apply-"));
const privateDir = path.join(root, "private");
const contractPath = "private/contract.json";
const manifestPath = "private/manifest.csv";
const truthPath = "private/truth.json";
const completedPath = "private/completed.json";

try {
  await fs.mkdir(privateDir, { recursive: true });
  const contract = {
    contractVersion: "western-round5-targeted-diagnosis-intake-v1",
    allowedGates: ["merged_substitution", "missing", "extra", "drag"],
    allowedSplits: ["calibration", "fresh-blind"],
    allowedLabels: ["positive", "confusion_negative"],
    minimums: { performers: 6, devices: 3, rooms: 4 },
    privacy: { requiredConsent: "yes", requiredLicenseStatus: "local-only" },
    splitDiscipline: { calibrationAndFreshPerformersDisjoint: true },
  };
  const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
  await fs.writeFile(path.join(root, contractPath), contractBytes);

  const rows = [];
  const truth = {
    contractVersion: contract.contractVersion,
    recordings: {},
  };
  const metadata = {};
  const audioSha256ByRecording = {};
  for (let index = 0; index < 6; index += 1) {
    const split = index < 3 ? "calibration" : "fresh-blind";
    const recordingId = `r6-${index + 1}`;
    const audioPath = `private/${recordingId}.wav`;
    const audio = Buffer.from(`audio-${index}`);
    await fs.writeFile(path.join(root, audioPath), audio);
    audioSha256ByRecording[recordingId] = hash(audio);
    rows.push([
      recordingId,
      `piece-${index}`,
      `placeholder-${index}`,
      `planned-device-${index % 3}`,
      `planned-room-${index % 4}`,
      split,
      audioPath,
      `private/score-${index}.musicxml`,
      "pending",
      "local-private-pending",
    ].join(","));
    truth.recordings[recordingId] = {
      completeErrorInventory: false,
      events: [{
        eventId: "event-1",
        gate: "missing",
        label: "positive",
        measure: 2,
        beat: 1,
        scoreMidi: 69,
        plannedPerformance: "skip",
        asPerformed: "",
      }],
    };
    metadata[recordingId] = {
      performerId: `actual-performer-${index}`,
      deviceId: `actual-device-${index % 3}`,
      roomId: `actual-room-${index % 4}`,
      consent: "yes",
      licenseStatus: "local-only",
    };
  }
  const manifestBytes = Buffer.from([
    "recordingId,pieceId,performerId,deviceId,roomId,split,audioPath,scorePath,consent,licenseStatus",
    ...rows,
    "",
  ].join("\n"));
  const truthBytes = Buffer.from(`${JSON.stringify(truth, null, 2)}\n`);
  await fs.writeFile(path.join(root, manifestPath), manifestBytes);
  await fs.writeFile(path.join(root, truthPath), truthBytes);

  const completedTruth = structuredClone(truth);
  for (const spec of Object.values(completedTruth.recordings)) {
    spec.completeErrorInventory = true;
    spec.events[0].asPerformed = "reviewed by ear";
  }
  const completed = {
    contractVersion: "western-truth-signoff-completed-v1",
    roundNumber: 5,
    sourceContractSha256: hash(contractBytes),
    sourceManifestSha256: hash(manifestBytes),
    sourceTruthSha256: hash(truthBytes),
    audioSha256ByRecording,
    recordingMetadata: metadata,
    truth: completedTruth,
  };
  const writeCompleted = async (value) => fs.writeFile(
    path.join(root, completedPath),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  const run = (extra = {}) => applyTruthSignoff({
    repoRoot: root,
    contractPath,
    manifestPath,
    truthPath,
    completedPath,
    roundNumber: 5,
    ...extra,
  });
  await writeCompleted(completed);

  await assert.rejects(
    () => run({ roundNumber: 6 }),
    /round6 truth-signoff apply scope is required/,
  );
  const dryRun = await run();
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.readyToApply, true);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.recordingCount, 6);
  assert.equal(hash(await fs.readFile(path.join(root, manifestPath))), hash(manifestBytes));
  assert.equal(hash(await fs.readFile(path.join(root, truthPath))), hash(truthBytes));

  await writeCompleted({ ...completed, sourceTruthSha256: "0".repeat(64) });
  const stale = await run();
  assert.equal(stale.ok, false);
  assert(stale.blockingReasons.includes("source-truth-sha-mismatch"));

  const invalidMetadata = structuredClone(completed);
  invalidMetadata.recordingMetadata["r6-1"].consent = "pending";
  await writeCompleted(invalidMetadata);
  const consent = await run();
  assert.equal(consent.ok, false);
  assert(consent.blockingReasons.includes("recording-consent-invalid:r6-1"));

  const incomplete = structuredClone(completed);
  incomplete.truth.recordings["r6-1"].events[0].asPerformed = "";
  await writeCompleted(incomplete);
  const missingSignoff = await run();
  assert.equal(missingSignoff.ok, false);
  assert(missingSignoff.blockingReasons.includes("as-performed-missing:r6-1:event-1"));

  const alteredPlan = structuredClone(completed);
  alteredPlan.truth.recordings["r6-1"].events[0].plannedPerformance = "changed";
  await writeCompleted(alteredPlan);
  const planTamper = await run();
  assert.equal(planTamper.ok, false);
  assert(planTamper.blockingReasons.includes("planned-field-changed:r6-1:event-1:plannedPerformance"));

  await writeCompleted(completed);
  await fs.writeFile(path.join(root, "private", "r6-1.wav"), "changed-audio");
  const changedAudio = await run();
  assert.equal(changedAudio.ok, false);
  assert(changedAudio.blockingReasons.includes("audio-sha-mismatch:r6-1"));
  await fs.writeFile(path.join(root, "private", "r6-1.wav"), "audio-0");

  const applied = await run({ apply: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.proposedHashes.manifestSha256, hash(await fs.readFile(path.join(root, manifestPath))));
  assert.equal(applied.proposedHashes.truthSha256, hash(await fs.readFile(path.join(root, truthPath))));
  const appliedManifest = await fs.readFile(path.join(root, manifestPath), "utf8");
  assert(appliedManifest.includes("actual-performer-0"));
  assert(appliedManifest.includes(",yes,local-only"));
  const appliedTruth = JSON.parse(await fs.readFile(path.join(root, truthPath), "utf8"));
  assert.equal(appliedTruth.recordings["r6-1"].completeErrorInventory, true);
  assert.equal(appliedTruth.recordings["r6-1"].events[0].asPerformed, "reviewed by ear");
  assert.equal((await fs.stat(path.join(root, applied.backups.manifest))).isFile(), true);
  assert.equal((await fs.stat(path.join(root, applied.backups.truth))).isFile(), true);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "dry-run-does-not-write",
      "round6-unscoped-apply-disabled",
      "source-hash-staleness-fails-closed",
      "consent-and-license-fail-closed",
      "complete-signoff-required",
      "planned-fields-are-immutable",
      "audio-sha-revalidated",
      "explicit-apply-writes-both-files-with-backups",
    ],
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
