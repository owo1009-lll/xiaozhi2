import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { summarizeRound6CounterbalancedCapture } from "./status-western-strings-project.mjs";

const GATES = ["merged_substitution", "missing", "extra", "drag"];

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "western-round6-status-"));
try {
  const contractPath = path.join(root, "contract.json");
  const manifestPath = path.join(root, "manifest.csv");
  const truthPath = path.join(root, "position-truth.json");
  const positionBalancePath = path.join(root, "position-report.json");
  const intakePath = path.join(root, "intake.json");
  const contract = {
    contractVersion: "western-round6-counterbalanced-diagnosis-v1",
    status: "pre-recording-design-only",
    allowedGates: GATES,
    allowedSplits: ["calibration", "fresh-blind"],
    allowedLabels: ["positive", "confusion_negative"],
    minimums: {
      performers: 6,
      devices: 3,
      rooms: 4,
      positivePerGate: 12,
      freshBlindPositivePerGate: 6,
      confusionNegativePerGate: 24,
      freshBlindConfusionNegativePerGate: 12,
    },
    promotionThresholds: {
      minPrecision: 0.9,
      minRecall: 0.5,
      maxStrictFalseAccusations: 0,
    },
    privacy: {
      requiredConsent: "yes",
      requiredLicenseStatus: "local-only",
    },
    truth: { requiredCompleteErrorInventory: true },
    promotion: {
      minPrecision: 0.9,
      minRecall: 0.5,
      maxStrictFalseAccusations: 0,
      studentFacing: false,
      automaticAuthorizationGranted: false,
    },
    positionDesign: {
      recordingsPerScore: 3,
      roleRotation: [
        "positive",
        "confusion_negative_a",
        "confusion_negative_b",
      ],
      requiredPreflightContract: "western-round5-position-balance-preflight-v2",
      requiredPreflightReady: true,
    },
    splitDiscipline: {
      calibrationAndFreshScoresDisjoint: true,
      calibrationAndFreshPerformersDisjoint: true,
      freshBlindMayBeRunOnce: true,
      consumedRound4OrRound5AudioAllowed: false,
    },
    studentFacing: false,
    automaticAuthorizationGranted: false,
  };
  const manifestRows = [];
  const truthRecordings = {};
  for (const [pieceIndex, piece] of [
    { id: "cal-a", split: "calibration", room: "cal-room-1" },
    { id: "cal-b", split: "calibration", room: "cal-room-2" },
    { id: "fresh-a", split: "fresh-blind", room: "fresh-room-1" },
    { id: "fresh-b", split: "fresh-blind", room: "fresh-room-2" },
  ].entries()) {
    const scorePath = path.join(root, `${piece.id}.musicxml`);
    await fs.writeFile(scorePath, "<score-partwise/>\n");
    for (let takeIndex = 0; takeIndex < 3; takeIndex += 1) {
      const recordingId = `r6-${piece.id}-0${takeIndex + 1}`;
      manifestRows.push({
        recordingId,
        pieceId: `${piece.id}-piece`,
        performerId: `${piece.split === "calibration" ? "cal" : "fresh"}-performer-${
          takeIndex + 1
        }`,
        deviceId: `device-${takeIndex + 1}`,
        roomId: piece.room,
        split: piece.split,
        audioPath: path.join(root, `${recordingId}.m4a`),
        scorePath,
        consent: "pending",
        licenseStatus: "pending",
      });
      const events = [];
      for (const [gateIndex, gate] of GATES.entries()) {
        for (let roleIndex = 0; roleIndex < 3; roleIndex += 1) {
          events.push({
            eventId: `${gate}-${roleIndex}`,
            gate,
            label: roleIndex === takeIndex ? "positive" : "confusion_negative",
            measure: 2 + gateIndex * 3 + roleIndex,
            beat: 1,
            scoreMidi: 60 + pieceIndex,
            asPerformed: "",
          });
        }
      }
      truthRecordings[recordingId] = {
        completeErrorInventory: false,
        events,
      };
      await fs.writeFile(path.join(root, `${recordingId}.pdf`), "pdf\n");
      await fs.writeFile(path.join(root, `${recordingId}-演奏说明.md`), "instructions\n");
    }
  }
  const headers = [
    "recordingId",
    "pieceId",
    "performerId",
    "deviceId",
    "roomId",
    "split",
    "audioPath",
    "scorePath",
    "consent",
    "licenseStatus",
  ];
  const manifestBytes = Buffer.from(
    `${headers.join(",")}\n${manifestRows
      .map((row) => headers.map((header) => row[header]).join(","))
      .join("\n")}\n`,
    "utf8",
  );
  const contractBytes = jsonBytes(contract);
  const truthBytes = jsonBytes({
    contractVersion: contract.contractVersion,
    recordings: truthRecordings,
  });
  await fs.writeFile(contractPath, contractBytes);
  await fs.writeFile(manifestPath, manifestBytes);
  await fs.writeFile(truthPath, truthBytes);
  const hashes = {
    contractSha256: sha256(contractBytes),
    manifestSha256: sha256(manifestBytes),
    truthSha256: sha256(truthBytes),
  };
  await fs.writeFile(positionBalancePath, jsonBytes({
    contract: "western-round5-position-balance-preflight-v2",
    evidenceRole: "pre-recording-position-balance-only",
    sourceHashes: {
      manifestSha256: hashes.manifestSha256,
      truthSha256: hashes.truthSha256,
    },
    readyForRecording: true,
    confoundedSplitGates: [],
    rhythmReviewHint: { confoundedSplits: [] },
    audioRead: false,
    promotionEvidenceEligible: false,
    automaticAccusationReady: false,
    studentFacing: false,
    blockingReasons: [],
  }));
  await fs.writeFile(intakePath, jsonBytes({
    contractVersion: contract.contractVersion,
    ready: false,
    studentFacing: false,
    automaticAuthorizationGranted: false,
    hashes,
    blockingReasons: ["recording-input-pending"],
  }));

  const ready = await summarizeRound6CounterbalancedCapture({
    contractPath,
    manifestPath,
    truthPath,
    positionBalancePath,
    intakePath,
    materialsRoot: root,
  });
  assert.equal(ready.contractValid, true);
  assert.equal(ready.bindingCurrent, true);
  assert.equal(ready.designCountsReady, true);
  assert.equal(ready.materialsReady, true);
  assert.equal(ready.readyForRecording, true);
  assert.equal(ready.intakeReady, false);
  assert.equal(ready.recordingComplete, false);
  assert.equal(ready.counts.recordings, 12);
  assert.equal(ready.counts.truthEvents, 144);
  assert.deepEqual(ready.remainingExternalInput, {
    audioFiles: 12,
    consentRows: 12,
    licenseRows: 12,
    signedEvents: 144,
    completeInventories: 12,
  });
  assert.deepEqual(ready.designBlockingReasons, []);
  assert.equal(ready.studentFacing, false);
  assert.equal(ready.automaticAccusationReady, false);

  await fs.writeFile(truthPath, Buffer.concat([truthBytes, Buffer.from("\n")]));
  const stale = await summarizeRound6CounterbalancedCapture({
    contractPath,
    manifestPath,
    truthPath,
    positionBalancePath,
    intakePath,
    materialsRoot: root,
  });
  assert.equal(stale.bindings.positionBalance, false);
  assert.equal(stale.bindings.intake, false);
  assert.equal(stale.bindingCurrent, false);
  assert.equal(stale.readyForRecording, false);
  assert(stale.designBlockingReasons.includes(
    "round6-counterbalanced-position-binding-stale",
  ));
  assert(stale.recordingBlockingReasons.includes(
    "round6-counterbalanced-intake-binding-stale",
  ));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("western Round-6 project-status binding tests passed");
