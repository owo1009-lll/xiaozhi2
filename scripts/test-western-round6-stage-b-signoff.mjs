import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyTruthSignoff } from "./apply-western-truth-signoff.mjs";
import { writeTruthSignoffPack } from "./generate-western-round5-truth-signoff-pack.mjs";
import {
  STAGE_A_CONSUMED_CONTRACT,
  STAGE_A_LINEAGE_CONTRACT,
  STAGE_A_SAFETY_CONTRACT,
  STAGE_B_AUTHORIZATION_CONTRACT,
  STAGE_B_LINEAGE_CONTRACT,
  canonicalJson,
} from "./western-round6-staged-signoff-support.mjs";

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fileHash = async (root, relative) => hash(await fs.readFile(path.join(root, relative)));
const writeJson = async (root, relative, value) => {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "round6-stage-b-signoff-"));
try {
  const paths = {
    contract: "config/contract.json",
    manifest: "private/manifest.csv",
    truth: "private/truth.json",
    protocol: "evidence/p3.json",
    position: "experiments/position/report.json",
    stageALineage: "experiments/stage-a-signoff/ledger.json",
    safetyReport: "experiments/stage-a-safety/report.json",
    safetyConsumed: "experiments/stage-a-safety/consumed.json",
    safetyModel: "experiments/stage-a-safety/model.joblib",
    stageBLedger: "experiments/stage-b-signoff/ledger.json",
    completed: "private/stage-b.completed.json",
    out: "private/stage-b-signoff",
  };
  const authorizationOptions = {
    positionBalancePath: paths.position,
    stageALineagePath: paths.stageALineage,
    safetyReportPath: paths.safetyReport,
    safetyConsumedPath: paths.safetyConsumed,
    safetyModelPath: paths.safetyModel,
  };
  const contract = {
    contractVersion: "western-round6-counterbalanced-diagnosis-v1",
    allowedGates: ["merged_substitution", "missing", "extra", "drag"],
    allowedSplits: ["calibration", "fresh-blind"],
    allowedLabels: ["positive", "confusion_negative"],
    privacy: { requiredConsent: "yes", requiredLicenseStatus: "local-only" },
    splitDiscipline: { calibrationAndFreshPerformersDisjoint: true },
  };
  await writeJson(root, paths.contract, contract);

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
  const stageBIds = [];
  for (const split of ["calibration", "fresh-blind"]) {
    for (let index = 0; index < 6; index += 1) {
      const prefix = split === "calibration" ? "cal" : "fresh";
      const recordingId = `r6-${prefix}-${index + 1}`;
      const audioPath = `private/${recordingId}.wav`;
      const signed = split === "calibration";
      (signed ? stageAIds : stageBIds).push(recordingId);
      rows.push({
        recordingId,
        pieceId: `${prefix}-piece-${Math.floor(index / 3) + 1}`,
        performerId: signed
          ? `cal-performer-${(index % 3) + 1}`
          : `fresh-placeholder-${(index % 3) + 1}`,
        deviceId: `device-${(index % 3) + 1}`,
        roomId: `${prefix}-room-${Math.floor(index / 3) + 1}`,
        split,
        audioPath,
        scorePath: `private/${prefix}.musicxml`,
        consent: signed ? "yes" : "pending",
        licenseStatus: signed ? "local-only" : "local-private-pending",
      });
      truth.recordings[recordingId] = {
        completeErrorInventory: signed,
        events: [{
          eventId: "missing-positive",
          gate: "missing",
          label: "positive",
          measure: 2,
          beat: 1,
          scoreMidi: 69,
          plannedPerformance: "skip",
          asPerformed: signed ? "signed calibration" : "",
        }],
      };
      if (signed) {
        const absolute = path.join(root, audioPath);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, `audio-${recordingId}`);
      }
    }
  }
  const manifestBytes = Buffer.from(
    `${headers.join(",")}\n${rows.map(
      (row) => headers.map((header) => row[header]).join(","),
    ).join("\n")}\n`,
  );
  const truthBytes = Buffer.from(`${JSON.stringify(truth, null, 2)}\n`);
  await fs.mkdir(path.dirname(path.join(root, paths.manifest)), { recursive: true });
  await fs.writeFile(path.join(root, paths.manifest), manifestBytes);
  await fs.writeFile(path.join(root, paths.truth), truthBytes);

  const profile = (ids, prefix) => ({
    recordingIds: ids,
    performerIds: [
      `${prefix}-performer-1`,
      `${prefix}-performer-2`,
      `${prefix}-performer-3`,
    ],
    deviceIds: ["device-1", "device-2", "device-3"],
    roomIds: [`${prefix}-room-1`, `${prefix}-room-2`],
  });
  const protocolCore = {
    contract: "western-p3-staged-minimal-recording-protocol-v1",
    stageA: { recordingIds: stageAIds, profile: profile(stageAIds, "cal") },
    stageB: { recordingIds: stageBIds, profile: profile(stageBIds, "fresh") },
  };
  const protocol = {
    schemaVersion: 1,
    ...protocolCore,
    sourceBindings: [
      { path: paths.contract, sha256: await fileHash(root, paths.contract) },
      { path: paths.manifest, sha256: await fileHash(root, paths.manifest) },
      { path: paths.truth, sha256: await fileHash(root, paths.truth) },
    ],
    protocolSemanticSha256: hash(Buffer.from(canonicalJson(protocolCore), "utf8")),
  };
  await writeJson(root, paths.protocol, protocol);

  for (const recordingId of stageBIds) {
    await fs.writeFile(
      path.join(root, `private/${recordingId}.wav`),
      `audio-${recordingId}`,
    );
  }
  const unauthorized = await writeTruthSignoffPack({
    repoRoot: root,
    contractPath: paths.contract,
    manifestPath: paths.manifest,
    truthPath: paths.truth,
    outDir: paths.out,
    roundNumber: 6,
    split: "fresh-blind",
    stagedProtocolPath: paths.protocol,
    stageAAuthorizationOptions: authorizationOptions,
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.freshAudioRead, false);

  const currentHashes = {
    protocolSha256: await fileHash(root, paths.protocol),
    protocolSemanticSha256: protocol.protocolSemanticSha256,
    contractSha256: await fileHash(root, paths.contract),
    manifestSha256: await fileHash(root, paths.manifest),
    truthSha256: await fileHash(root, paths.truth),
  };
  await writeJson(root, paths.position, {
    contract: "western-round5-position-balance-preflight-v2",
    sourceHashes: {
      manifestSha256: currentHashes.manifestSha256,
      truthSha256: currentHashes.truthSha256,
    },
    readyForRecording: true,
    audioRead: false,
    confoundedSplitGates: [],
    rhythmReviewHint: { confoundedSplits: [] },
  });
  const lineage = {
    schemaVersion: 1,
    contract: STAGE_A_LINEAGE_CONTRACT,
    scope: { split: "calibration", recordingIds: stageAIds },
    stagedProtocol: {
      protocolSemanticSha256: protocol.protocolSemanticSha256,
    },
    sourceHashes: {
      manifestSha256: currentHashes.manifestSha256,
      truthSha256: currentHashes.truthSha256,
    },
    appliedHashes: {
      manifestSha256: currentHashes.manifestSha256,
      truthSha256: currentHashes.truthSha256,
    },
  };
  await writeJson(root, paths.stageALineage, lineage);
  currentHashes.positionBalanceSha256 = await fileHash(root, paths.position);
  currentHashes.signoffLineageSha256 = await fileHash(root, paths.stageALineage);
  await fs.mkdir(path.dirname(path.join(root, paths.safetyModel)), { recursive: true });
  await fs.writeFile(path.join(root, paths.safetyModel), "frozen-stage-a-model");
  const modelSha256 = await fileHash(root, paths.safetyModel);
  await writeJson(root, paths.safetyConsumed, {
    contract: STAGE_A_CONSUMED_CONTRACT,
    p3ProtocolSemanticSha256: protocol.protocolSemanticSha256,
    sourceHashes: currentHashes,
    modelSha256,
    cleanSafetyConsumed: true,
    freshAudioRead: false,
    studentFacing: false,
    automaticAuthorizationGranted: false,
  });
  await writeJson(root, paths.safetyReport, {
    contract: STAGE_A_SAFETY_CONTRACT,
    p3ProtocolSemanticSha256: protocol.protocolSemanticSha256,
    sourceHashes: currentHashes,
    preflightReady: true,
    executionRequested: true,
    trainingPerformed: true,
    cleanSafetyEvaluationPerformed: true,
    stageAPassed: true,
    stageBFreshRecordingAuthorized: true,
    freshAudioRead: false,
    studentFacing: false,
    automaticAuthorizationGranted: false,
    modelArtifact: { path: paths.safetyModel, sha256: modelSha256 },
    blockingReasons: [],
  });

  const pack = await writeTruthSignoffPack({
    repoRoot: root,
    contractPath: paths.contract,
    manifestPath: paths.manifest,
    truthPath: paths.truth,
    outDir: paths.out,
    roundNumber: 6,
    split: "fresh-blind",
    stagedProtocolPath: paths.protocol,
    stageAAuthorizationOptions: authorizationOptions,
  });
  assert.equal(pack.ok, true);
  assert.equal(pack.recordingCount, 6);
  assert.equal(pack.scope.split, "fresh-blind");
  assert.equal(
    pack.stageAAuthorization.contract,
    STAGE_B_AUTHORIZATION_CONTRACT,
  );
  const html = await fs.readFile(path.join(root, paths.out, "index.html"), "utf8");
  assert(html.includes('"split":"fresh-blind"'));
  assert(html.includes(STAGE_B_AUTHORIZATION_CONTRACT));
  assert(!html.includes("r6-cal-1"));

  const completedTruth = {
    contractVersion: truth.contractVersion,
    recordings: Object.fromEntries(stageBIds.map((recordingId) => [
      recordingId,
      {
        ...truth.recordings[recordingId],
        completeErrorInventory: true,
        events: [{
          ...truth.recordings[recordingId].events[0],
          asPerformed: "signed untouched fresh",
        }],
      },
    ])),
  };
  const completed = {
    contractVersion: "western-truth-signoff-completed-v1",
    roundNumber: 6,
    scope: { split: "fresh-blind", recordingIds: stageBIds },
    stageAAuthorization: pack.stageAAuthorization,
    sourceContractSha256: pack.contractSha256,
    sourceManifestSha256: pack.manifestSha256,
    sourceTruthSha256: pack.truthSha256,
    audioSha256ByRecording: Object.fromEntries(await Promise.all(
      stageBIds.map(async (recordingId) => [
        recordingId,
        await fileHash(root, `private/${recordingId}.wav`),
      ]),
    )),
    recordingMetadata: Object.fromEntries(stageBIds.map((recordingId, index) => [
      recordingId,
      {
        performerId: `fresh-performer-${(index % 3) + 1}`,
        deviceId: `device-${(index % 3) + 1}`,
        roomId: `fresh-room-${Math.floor(index / 3) + 1}`,
        consent: "yes",
        licenseStatus: "local-only",
      },
    ])),
    truth: completedTruth,
  };
  await writeJson(root, paths.completed, completed);
  const applyOptions = {
    repoRoot: root,
    contractPath: paths.contract,
    manifestPath: paths.manifest,
    truthPath: paths.truth,
    completedPath: paths.completed,
    roundNumber: 6,
    scopeSplit: "fresh-blind",
    stagedProtocolPath: paths.protocol,
    ledgerPath: paths.stageBLedger,
    stageAAuthorizationOptions: authorizationOptions,
  };
  const tampered = structuredClone(completed);
  tampered.stageAAuthorization.authorizationHashes.safetyModelSha256 = "0".repeat(64);
  await writeJson(root, paths.completed, tampered);
  const rejected = await applyTruthSignoff(applyOptions);
  assert.equal(rejected.ok, false);
  assert(rejected.blockingReasons.includes("completed-stage-a-authorization-mismatch"));

  await writeJson(root, paths.completed, completed);
  const calibrationManifestBefore = rows
    .filter((row) => row.split === "calibration")
    .map((row) => structuredClone(row));
  const calibrationTruthBefore = Object.fromEntries(stageAIds.map(
    (recordingId) => [recordingId, structuredClone(truth.recordings[recordingId])],
  ));
  const dryRun = await applyTruthSignoff(applyOptions);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.calibrationPreservation.unchanged, true);
  const applied = await applyTruthSignoff({ ...applyOptions, apply: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);

  const appliedManifest = (await fs.readFile(path.join(root, paths.manifest), "utf8"))
    .trim().split(/\r?\n/).slice(1).map((line) => {
      const values = line.split(",");
      return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    });
  assert.deepEqual(
    appliedManifest.filter((row) => row.split === "calibration"),
    calibrationManifestBefore,
  );
  const appliedTruth = JSON.parse(
    await fs.readFile(path.join(root, paths.truth), "utf8"),
  );
  assert.deepEqual(
    Object.fromEntries(stageAIds.map(
      (recordingId) => [recordingId, appliedTruth.recordings[recordingId]],
    )),
    calibrationTruthBefore,
  );
  const ledger = JSON.parse(
    await fs.readFile(path.join(root, paths.stageBLedger), "utf8"),
  );
  assert.equal(ledger.contract, STAGE_B_LINEAGE_CONTRACT);
  assert.equal(ledger.scope.split, "fresh-blind");
  assert.equal(ledger.calibrationPreservation.unchanged, true);
  assert.equal(
    ledger.stageAAuthorization.authorizationHashes.safetyModelSha256,
    modelSha256,
  );

  const repeated = await applyTruthSignoff(applyOptions);
  assert.equal(repeated.ok, false);
  assert(repeated.blockingReasons.includes("round6-stage-b-signoff-already-applied"));
  await assert.rejects(
    () => writeTruthSignoffPack({
      repoRoot: root,
      contractPath: paths.contract,
      manifestPath: paths.manifest,
      truthPath: paths.truth,
      roundNumber: 6,
    }),
    /round6 truth-signoff split is required/,
  );

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "fresh-audio-not-read-before-stage-a-authorization",
      "fresh-only-pack-binds-stage-a-authorization",
      "tampered-authorization-fails-closed",
      "fresh-apply-preserves-calibration",
      "stage-b-lineage-ledger-written-once",
      "round6-unscoped-signoff-disabled",
    ],
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
