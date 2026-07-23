import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyTruthSignoff } from "./apply-western-truth-signoff.mjs";
import { writeTruthSignoffPack } from "./generate-western-round5-truth-signoff-pack.mjs";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "round6-stage-a-signoff-"));
try {
  const contractPath = "config/contract.json";
  const manifestPath = "private/manifest.csv";
  const truthPath = "private/truth.json";
  const stagedProtocolPath = "evidence/p3.json";
  const completedPath = "private/stage-a.completed.json";
  const outDir = "private/stage-a-signoff";
  const ledgerPath = "experiments/stage-a-signoff/ledger.json";
  await Promise.all([
    fs.mkdir(path.join(root, "config"), { recursive: true }),
    fs.mkdir(path.join(root, "private"), { recursive: true }),
    fs.mkdir(path.join(root, "evidence"), { recursive: true }),
  ]);

  const contract = {
    contractVersion: "western-round6-counterbalanced-diagnosis-v1",
    allowedGates: ["merged_substitution", "missing", "extra", "drag"],
    allowedSplits: ["calibration", "fresh-blind"],
    allowedLabels: ["positive", "confusion_negative"],
    minimums: { performers: 6, devices: 3, rooms: 4 },
    privacy: { requiredConsent: "yes", requiredLicenseStatus: "local-only" },
    splitDiscipline: { calibrationAndFreshPerformersDisjoint: true },
  };
  const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
  await fs.writeFile(path.join(root, contractPath), contractBytes);

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
  const rows = [];
  const truth = {
    contractVersion: contract.contractVersion,
    recordings: {},
  };
  const stageAIds = [];
  for (const split of ["calibration", "fresh-blind"]) {
    for (let index = 0; index < 6; index += 1) {
      const prefix = split === "calibration" ? "cal" : "fresh";
      const recordingId = `r6-${prefix}-${index + 1}`;
      const audioPath = `private/${recordingId}.wav`;
      if (split === "calibration") {
        stageAIds.push(recordingId);
        await fs.writeFile(path.join(root, audioPath), `audio-${recordingId}`);
      }
      rows.push({
        recordingId,
        pieceId: `${prefix}-piece-${Math.floor(index / 3) + 1}`,
        performerId: `${prefix}-placeholder-${(index % 3) + 1}`,
        deviceId: `device-${(index % 3) + 1}`,
        roomId: `${prefix}-room-${Math.floor(index / 3) + 1}`,
        split,
        audioPath,
        scorePath: `private/${prefix}.musicxml`,
        consent: "pending",
        licenseStatus: "local-private-pending",
      });
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
    }
  }
  const manifestBytes = Buffer.from(
    `${headers.join(",")}\n${rows.map(
      (row) => headers.map((header) => row[header]).join(","),
    ).join("\n")}\n`,
  );
  const truthBytes = Buffer.from(`${JSON.stringify(truth, null, 2)}\n`);
  await fs.writeFile(path.join(root, manifestPath), manifestBytes);
  await fs.writeFile(path.join(root, truthPath), truthBytes);

  const protocolCore = {
    contract: "western-p3-staged-minimal-recording-protocol-v1",
    stageA: {
      recordingIds: stageAIds,
      profile: {
        performerIds: ["cal-performer-1", "cal-performer-2", "cal-performer-3"],
        deviceIds: ["device-1", "device-2", "device-3"],
        roomIds: ["cal-room-1", "cal-room-2"],
      },
    },
  };
  const stagedProtocol = {
    schemaVersion: 1,
    ...protocolCore,
    sourceBindings: [
      { path: contractPath, sha256: hash(contractBytes) },
      { path: manifestPath, sha256: hash(manifestBytes) },
      { path: truthPath, sha256: hash(truthBytes) },
    ],
    protocolSemanticSha256: hash(
      Buffer.from(canonicalJson(protocolCore), "utf8"),
    ),
  };
  await fs.writeFile(
    path.join(root, stagedProtocolPath),
    `${JSON.stringify(stagedProtocol, null, 2)}\n`,
  );

  const pack = await writeTruthSignoffPack({
    repoRoot: root,
    contractPath,
    manifestPath,
    truthPath,
    outDir,
    roundNumber: 6,
    split: "calibration",
  });
  assert.equal(pack.ok, true);
  assert.equal(pack.recordingCount, 6);
  assert.equal(pack.scope.split, "calibration");
  assert.deepEqual(pack.scope.recordingIds, stageAIds);
  const html = await fs.readFile(path.join(root, outDir, "index.html"), "utf8");
  assert(html.includes('"split":"calibration"'));
  assert(!html.includes("r6-fresh-1"));

  const completedTruth = {
    contractVersion: truth.contractVersion,
    recordings: Object.fromEntries(stageAIds.map((recordingId) => [
      recordingId,
      {
        ...truth.recordings[recordingId],
        completeErrorInventory: true,
        events: [{
          ...truth.recordings[recordingId].events[0],
          asPerformed: "reviewed by ear",
        }],
      },
    ])),
  };
  const metadata = Object.fromEntries(stageAIds.map((recordingId, index) => [
    recordingId,
    {
      performerId: `cal-performer-${(index % 3) + 1}`,
      deviceId: `device-${(index % 3) + 1}`,
      roomId: `cal-room-${Math.floor(index / 3) + 1}`,
      consent: "yes",
      licenseStatus: "local-only",
    },
  ]));
  const audioSha256ByRecording = Object.fromEntries(
    await Promise.all(stageAIds.map(async (recordingId) => [
      recordingId,
      hash(await fs.readFile(path.join(root, `private/${recordingId}.wav`))),
    ])),
  );
  const completed = {
    contractVersion: "western-truth-signoff-completed-v1",
    roundNumber: 6,
    scope: { split: "calibration", recordingIds: stageAIds },
    sourceContractSha256: hash(contractBytes),
    sourceManifestSha256: hash(manifestBytes),
    sourceTruthSha256: hash(truthBytes),
    audioSha256ByRecording,
    recordingMetadata: metadata,
    truth: completedTruth,
  };
  await fs.writeFile(
    path.join(root, completedPath),
    `${JSON.stringify(completed, null, 2)}\n`,
  );
  const run = (extra = {}) => applyTruthSignoff({
    repoRoot: root,
    contractPath,
    manifestPath,
    truthPath,
    completedPath,
    roundNumber: 6,
    scopeSplit: "calibration",
    stagedProtocolPath,
    ledgerPath,
    ...extra,
  });

  const dryRun = await run();
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.recordingCount, 6);
  assert.equal(dryRun.eventCount, 6);
  assert.deepEqual(dryRun.scope.recordingIds, [...stageAIds].sort());

  const applied = await run({ apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.ledger, ledgerPath);
  const appliedTruth = JSON.parse(
    await fs.readFile(path.join(root, truthPath), "utf8"),
  );
  assert.equal(Object.keys(appliedTruth.recordings).length, 12);
  assert.equal(
    appliedTruth.recordings["r6-cal-1"].completeErrorInventory,
    true,
  );
  assert.equal(
    appliedTruth.recordings["r6-fresh-1"].completeErrorInventory,
    false,
  );
  const appliedManifest = await fs.readFile(path.join(root, manifestPath), "utf8");
  assert(appliedManifest.includes("cal-performer-1"));
  assert(appliedManifest.includes("fresh-placeholder-1"));
  const ledger = JSON.parse(
    await fs.readFile(path.join(root, ledgerPath), "utf8"),
  );
  assert.equal(ledger.contract, "western-round6-stage-a-signoff-lineage-v1");
  assert.deepEqual(ledger.scope.recordingIds, [...stageAIds].sort());

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "fresh-audio-not-required",
      "stage-a-scope-bound",
      "partial-apply-preserves-fresh",
      "stage-a-lineage-ledger-written",
    ],
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
