#!/usr/bin/env node
// Forgery-rejection tests for the ordinary-dynamic-shadow r3 live-artifact
// verifier. A synthetic but fully consistent fixture must pass; every
// tampering (including a sophisticated forger who re-computes the top-level
// digest) must fail closed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ACCEPTANCE_REPORT_RELATIVE_PATH,
  BASIC_PITCH_CACHE_SCHEMA_VERSION,
  BASIC_PITCH_INFERENCE_VERSION,
  ORDINARY_DYNAMIC_ACCEPTANCE_VERSION,
  ORDINARY_DYNAMIC_CONTRACT_VERSION,
  ORDINARY_DYNAMIC_GATE_VERSION,
  ORDINARY_DYNAMIC_POLICY_VERSION,
  ORDINARY_DYNAMIC_TIMING_MODE,
  auditCandidateRunPayload,
  auditOrdinaryDynamicShadowAcceptanceLiveArtifacts,
  computeCandidateEvidenceSha256,
  evaluateDynamicShadowPolicy,
  sha256Canonical,
} from "./audit-western-ordinary-dynamic-shadow-acceptance.mjs";
import { ORDINARY_AUDIO_RUNTIME_ANCHORS } from "./run-western-ordinary-audio-python.mjs";

const anchors = ORDINARY_AUDIO_RUNTIME_ANCHORS;
const GREEN_RUNTIME_REPORT = {
  runtimeReady: true,
  runtimeId: anchors.runtimeId,
  configSemanticSha256: anchors.configSemanticSha256,
  requirementsLock: { normalizedSha256: anchors.requirementsLockSha256 },
  modelIdentity: { treeSha256: anchors.modelTreeSha256 },
};

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// ---- policy port sanity -----------------------------------------------------
const passingFeatures = {
  pitchDistanceSemitones: 0,
  eventConfidence: 0.9,
  relativeIoiDeviationRatio: 0.05,
  relativeEventConfidence: 1.1,
  eventDurationSeconds: 0.4,
  nearestSamePitchScoreDistanceQuarters: null,
  expectedDurationSeconds: 0.5,
  eventDurationRatio: 0.8,
};
assert.equal(evaluateDynamicShadowPolicy(passingFeatures).selected, true);
assert.equal(
  evaluateDynamicShadowPolicy({ ...passingFeatures, pitchDistanceSemitones: 1 }).selected,
  false,
  "non-zero pitch distance must not select",
);
assert.equal(
  evaluateDynamicShadowPolicy({ ...passingFeatures, relativeIoiDeviationRatio: 0.2 }).selected,
  false,
  "IOI deviation above the frozen limit must not select",
);
assert.equal(
  evaluateDynamicShadowPolicy({ ...passingFeatures, eventDurationRatio: 0.1 }).selected,
  false,
  "duration ratio below the frozen guard must not select",
);
assert.equal(
  evaluateDynamicShadowPolicy({ ...passingFeatures, nearestSamePitchScoreDistanceQuarters: 0.25 }).selected,
  false,
  "close same-pitch neighbors must not select",
);
const missingSamePitchField = { ...passingFeatures };
delete missingSamePitchField.nearestSamePitchScoreDistanceQuarters;
assert.equal(
  evaluateDynamicShadowPolicy(missingSamePitchField).selected,
  false,
  "a payload without the same-pitch field must not select",
);

// ---- synthetic fixture ------------------------------------------------------
function buildFixture(root) {
  const storeRelative = path.join("data", "erhu-score-imports.json");
  const audioRelative = (id) => path.join("data", "private", "western-strings-round3", `${id}.m4a`);
  const cacheRelative = (id) => path.join("cache", `${id}.basic-pitch.json`);
  const runRelative = (id, label) => path.join("runs", `${id}-${label}.json`);

  const scoreFor = (id) => ({
    scoreId: `score-${id}`,
    title: id,
    sections: [
      {
        sectionId: "section-1",
        tempo: 72,
        notes: [
          { noteId: "n1", measureIndex: 1, beatStart: 0, beatDuration: 1, midiPitch: 69 },
          { noteId: "n2", measureIndex: 1, beatStart: 1, beatDuration: 1, midiPitch: 71 },
          { noteId: "n3", measureIndex: 1, beatStart: 2, beatDuration: 1, midiPitch: 73 },
        ],
      },
    ],
  });
  const scores = [scoreFor("r3-02"), scoreFor("r3-03")];
  const storeBytes = Buffer.from(`${JSON.stringify({ scores }, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(root, path.dirname(storeRelative)), { recursive: true });
  fs.writeFileSync(path.join(root, storeRelative), storeBytes);
  const storeSha256 = sha256(storeBytes);

  const recordings = [];
  for (const id of ["r3-02", "r3-03"]) {
    const audioBytes = Buffer.from(`synthetic-audio-${id}`);
    fs.mkdirSync(path.join(root, path.dirname(audioRelative(id))), { recursive: true });
    fs.writeFileSync(path.join(root, audioRelative(id)), audioBytes);
    const audioSha256 = sha256(audioBytes);
    const score = scores.find((item) => item.scoreId === `score-${id}`);
    const scorePayloadSha256 = sha256Canonical(score);

    const cachePayload = {
      schemaVersion: BASIC_PITCH_CACHE_SCHEMA_VERSION,
      cacheIdentity: {
        audioSha256,
        modelVersion: "basic-pitch-0.4.0-default-model",
        modelArtifactSha256: anchors.modelTreeSha256,
        inferenceVersion: BASIC_PITCH_INFERENCE_VERSION,
        policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
        runtimeId: anchors.runtimeId,
        runtimeConfigSemanticSha256: anchors.configSemanticSha256,
        runtimeRequirementsLockSha256: anchors.requirementsLockSha256,
      },
      events: [],
    };
    const cacheBytes = Buffer.from(`${JSON.stringify(cachePayload, null, 2)}\n`, "utf8");
    fs.mkdirSync(path.join(root, "cache"), { recursive: true });
    fs.writeFileSync(path.join(root, cacheRelative(id)), cacheBytes);
    const cacheArtifactSha256 = sha256(cacheBytes);

    const rowFor = (index, midi, selected) => ({
      noteIndex: index,
      noteId: `n${index + 1}`,
      midi,
      autoDecision: "review_required",
      studentFacing: false,
      feedbackAuthorized: false,
      studentSafeGateReady: false,
      dynamicShadowEvidence: {
        contractVersion: ORDINARY_DYNAMIC_CONTRACT_VERSION,
        policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
        timingMode: ORDINARY_DYNAMIC_TIMING_MODE,
        energyVetoIncluded: false,
        causalEnergyStatus: "excluded-review-only",
        selected,
        ...(selected
          ? passingFeatures
          : { ...passingFeatures, eventConfidence: 0.2 }),
      },
    });
    const candidateRows = [rowFor(0, 69, true), rowFor(1, 71, true), rowFor(2, 73, false)];

    const payloadFor = (cacheHit) => ({
      ok: true,
      summary: {
        analysisMode: "basic-pitch-dtw-pyin-review-v1",
        scoreId: `score-${id}`,
        noteCount: 3,
        candidateRowCount: 3,
        reviewRequiredCount: 3,
        autoPassCount: 0,
        dynamicShadowContractVersion: ORDINARY_DYNAMIC_CONTRACT_VERSION,
        dynamicShadowPolicyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
        dynamicShadowSelectedCount: 2,
        dynamicShadowEnergyVetoIncluded: false,
        studentSafeGateReady: false,
        studentFacing: false,
      },
      basicPitchCacheProvenance: {
        audioSha256,
        modelVersion: "basic-pitch-0.4.0-default-model",
        modelArtifactSha256: anchors.modelTreeSha256,
        inferenceVersion: BASIC_PITCH_INFERENCE_VERSION,
        policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
        runtimeId: anchors.runtimeId,
        runtimeConfigSemanticSha256: anchors.configSemanticSha256,
        runtimeRequirementsLockSha256: anchors.requirementsLockSha256,
        cachePath: cacheRelative(id).replace(/\\/g, "/"),
        cacheArtifactSha256,
        cacheHit,
        cacheSource: "content-addressed-cache",
        identityBound: true,
      },
      scoreProvenance: {
        scoreId: `score-${id}`,
        scorePayloadSha256,
        scoreStorePath: storeRelative.replace(/\\/g, "/"),
        scoreStoreArtifactSha256: storeSha256,
        noteCount: 3,
      },
      runtimeAttestation: {
        ready: true,
        runtimeId: anchors.runtimeId,
        configSemanticSha256: anchors.configSemanticSha256,
        requirementsLockSha256: anchors.requirementsLockSha256,
        modelArtifactSha256: anchors.modelTreeSha256,
        studentFacing: false,
        automaticAdoptionAuthorized: false,
      },
      candidateRows,
    });

    const runFor = (label) => {
      const payload = payloadFor(label === "warm");
      const runBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.mkdirSync(path.join(root, "runs"), { recursive: true });
      fs.writeFileSync(path.join(root, runRelative(id, label)), runBytes);
      return {
        label,
        cacheHit: label === "warm",
        cacheIdentityBound: true,
        candidateArtifactAuditPassed: true,
        allRowsReviewRequired: true,
        autoPassCount: 0,
        reviewRequiredCount: 3,
        candidateRowCount: 3,
        scoreNoteCount: 3,
        studentFacing: false,
        automaticAdoptionAuthorized: false,
        authorizationReady: false,
        energyVetoIncluded: false,
        causalEnergyStatus: "excluded-review-only",
        contractVersion: ORDINARY_DYNAMIC_CONTRACT_VERSION,
        policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
        gateVersion: ORDINARY_DYNAMIC_GATE_VERSION,
        timingMode: ORDINARY_DYNAMIC_TIMING_MODE,
        audioSha256,
        scorePayloadSha256,
        scoreStoreArtifactSha256: storeSha256,
        modelArtifactSha256: anchors.modelTreeSha256,
        cachePath: cacheRelative(id).replace(/\\/g, "/"),
        cacheArtifactSha256,
        candidateArtifactPath: runRelative(id, label).replace(/\\/g, "/"),
        candidateArtifactSha256: sha256(runBytes),
        candidateEvidenceSha256: computeCandidateEvidenceSha256(payload),
      };
    };

    recordings.push({
      recordingId: id,
      scoreId: `score-${id}`,
      audioPath: audioRelative(id).replace(/\\/g, "/"),
      audioSha256,
      scorePayloadSha256,
      scoreStoreArtifactSha256: storeSha256,
      scoreNoteCount: 3,
      candidateRowCount: 3,
      shadowSelectedCandidateCount: 2,
      exactPitchSelectedCount: 2,
      shadowCoverage: Number((2 / 3).toFixed(6)),
      allRowsReviewRequired: true,
      autoPassCount: 0,
      studentFacing: false,
      fullArtifactAuditPassed: true,
      coldRun: runFor("cold"),
      warmRun: runFor("warm"),
    });
  }

  const acceptance = {
    schemaVersion: 1,
    contractVersion: ORDINARY_DYNAMIC_ACCEPTANCE_VERSION,
    candidateContractVersion: ORDINARY_DYNAMIC_CONTRACT_VERSION,
    policyVersion: ORDINARY_DYNAMIC_POLICY_VERSION,
    gateVersion: ORDINARY_DYNAMIC_GATE_VERSION,
    timingMode: ORDINARY_DYNAMIC_TIMING_MODE,
    scope: "implementation-acceptance-preGateOnly",
    studentFacing: false,
    automaticAdoptionAuthorized: false,
    authorizationReady: false,
    energyVetoIncluded: false,
    causalEnergyStatus: "excluded-review-only",
    recordings,
    aggregate: {
      recordingCount: 2,
      coldCacheMissCount: 2,
      warmCacheHitCount: 2,
      coverageFloor: 0.2,
      allRowsReviewRequired: true,
      allArtifactsBound: true,
      coldWarmEvidenceStable: true,
    },
    acceptanceReady: true,
    blockingReasons: [],
  };
  return withDigest(acceptance, root);
}

function withDigest(acceptance, root) {
  const value = structuredClone(acceptance);
  delete value.evidenceDigestSha256;
  delete value.generatedAt;
  const digest = sha256Canonical(value);
  const finished = { ...acceptance, generatedAt: "2026-07-18T00:00:00.000Z", evidenceDigestSha256: digest };
  fs.mkdirSync(path.join(root, path.dirname(ACCEPTANCE_REPORT_RELATIVE_PATH)), { recursive: true });
  fs.writeFileSync(
    path.join(root, ACCEPTANCE_REPORT_RELATIVE_PATH),
    `${JSON.stringify(finished, null, 2)}\n`,
    "utf8",
  );
  return finished;
}

function audit(root) {
  return auditOrdinaryDynamicShadowAcceptanceLiveArtifacts({
    repoRoot: root,
    runtimeReport: GREEN_RUNTIME_REPORT,
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "western-shadow-acceptance-test-"));
try {
  // 1. Fully consistent synthetic evidence passes the live audit.
  const acceptance = buildFixture(root);
  const green = audit(root);
  assert.deepEqual(green.blockingReasons, [], `green fixture must pass: ${green.blockingReasons}`);
  assert.equal(green.ready, true);

  // The runner-side payload audit agrees on the same artifacts.
  const coldPayload = JSON.parse(
    fs.readFileSync(path.join(root, "runs", "r3-02-cold.json"), "utf8"),
  );
  const payloadAudit = auditCandidateRunPayload(coldPayload, { scoreId: "score-r3-02" });
  assert.equal(payloadAudit.ok, true, `payload audit must pass: ${payloadAudit.blockingReasons}`);
  assert.equal(payloadAudit.derived.selectedCount, 2);

  // 2. Tampering with the report body without re-computing the digest fails.
  const tamperedCoverage = structuredClone(acceptance);
  tamperedCoverage.recordings[0].shadowSelectedCandidateCount = 3;
  fs.writeFileSync(
    path.join(root, ACCEPTANCE_REPORT_RELATIVE_PATH),
    `${JSON.stringify(tamperedCoverage, null, 2)}\n`,
    "utf8",
  );
  const digestBroken = audit(root);
  assert.equal(digestBroken.ready, false);
  assert(
    digestBroken.blockingReasons.includes("ordinary-dynamic-shadow-r3-live-evidence-digest-invalid"),
    "digest tampering must be explicit",
  );

  // 3. A sophisticated forger who re-computes the digest still fails: the
  // claimed counts no longer match the artifact rows.
  withDigest(tamperedCoverage, root);
  const recountForged = audit(root);
  assert.equal(recountForged.ready, false);
  assert(
    recountForged.blockingReasons.some((reason) => reason.includes("candidate-claims-mismatch")),
    `forged counts must fail against artifact rows: ${recountForged.blockingReasons}`,
  );

  // 4. Tampering the candidate artifact bytes fails the hash binding.
  buildFixture(root);
  const coldRunPath = path.join(root, "runs", "r3-02-cold.json");
  const tamperedPayload = JSON.parse(fs.readFileSync(coldRunPath, "utf8"));
  tamperedPayload.candidateRows[0].autoDecision = "auto_pass";
  fs.writeFileSync(coldRunPath, `${JSON.stringify(tamperedPayload, null, 2)}\n`, "utf8");
  const artifactTampered = audit(root);
  assert.equal(artifactTampered.ready, false);
  assert(
    artifactTampered.blockingReasons.some((reason) => reason.includes("cold-candidate-artifact-stale")),
    `artifact tampering must fail the hash binding: ${artifactTampered.blockingReasons}`,
  );

  // 5. Even re-binding the tampered artifact hash + digest fails: an
  // auto-pass row can never audit clean.
  const rebound = structuredClone(buildFixture(root));
  fs.writeFileSync(coldRunPath, `${JSON.stringify(tamperedPayload, null, 2)}\n`, "utf8");
  rebound.recordings[0].coldRun.candidateArtifactSha256 = sha256(fs.readFileSync(coldRunPath));
  withDigest(rebound, root);
  const autoPassForged = audit(root);
  assert.equal(autoPassForged.ready, false);
  assert(
    autoPassForged.blockingReasons.some((reason) => reason.includes("candidate-row-invalid:0")),
    `an auto-pass row must fail the content audit: ${autoPassForged.blockingReasons}`,
  );

  // 6. Flipping a shadow decision without feature support fails the frozen
  // policy re-computation, even with hashes and digest re-bound.
  const flipped = structuredClone(buildFixture(root));
  const flippedPayload = JSON.parse(fs.readFileSync(coldRunPath, "utf8"));
  flippedPayload.candidateRows[2].dynamicShadowEvidence.selected = true;
  flippedPayload.summary.dynamicShadowSelectedCount = 3;
  fs.writeFileSync(coldRunPath, `${JSON.stringify(flippedPayload, null, 2)}\n`, "utf8");
  flipped.recordings[0].coldRun.candidateArtifactSha256 = sha256(fs.readFileSync(coldRunPath));
  flipped.recordings[0].coldRun.candidateEvidenceSha256 = computeCandidateEvidenceSha256(flippedPayload);
  withDigest(flipped, root);
  const policyForged = audit(root);
  assert.equal(policyForged.ready, false);
  assert(
    policyForged.blockingReasons.some((reason) => reason.includes("candidate-row-policy-recompute-mismatch:2")),
    `an unsupported selection must fail policy re-computation: ${policyForged.blockingReasons}`,
  );

  // 7. Deleting a cited cache artifact fails closed.
  buildFixture(root);
  fs.rmSync(path.join(root, "cache", "r3-03.basic-pitch.json"));
  const cacheMissing = audit(root);
  assert.equal(cacheMissing.ready, false);
  assert(
    cacheMissing.blockingReasons.some((reason) => reason.startsWith("ordinary-dynamic-shadow-r3-live:r3-03:cold-cache-artifact-")),
    `missing cache artifact must fail closed: ${cacheMissing.blockingReasons}`,
  );

  // 8. Re-pointing a recording at different audio fails the audio binding.
  buildFixture(root);
  fs.writeFileSync(
    path.join(root, "data", "private", "western-strings-round3", "r3-02.m4a"),
    Buffer.from("some-other-take"),
  );
  const audioSwapped = audit(root);
  assert.equal(audioSwapped.ready, false);
  assert(
    audioSwapped.blockingReasons.includes("ordinary-dynamic-shadow-r3-live:r3-02:audio-artifact-stale"),
    `swapped audio must fail the binding: ${audioSwapped.blockingReasons}`,
  );

  // 9. Editing the score in the store fails the score payload re-computation.
  buildFixture(root);
  const storePath = path.join(root, "data", "erhu-score-imports.json");
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  store.scores[0].sections[0].notes[0].midiPitch = 70;
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  const scoreEdited = audit(root);
  assert.equal(scoreEdited.ready, false);
  assert(
    scoreEdited.blockingReasons.some((reason) => reason.includes("score-store-artifact-stale"))
      && scoreEdited.blockingReasons.some((reason) => reason.includes("score-payload-stale")),
    `an edited score must fail both store and payload bindings: ${scoreEdited.blockingReasons}`,
  );

  // 10. A failed runtime preflight closes the audit regardless of artifacts.
  buildFixture(root);
  const runtimeDown = auditOrdinaryDynamicShadowAcceptanceLiveArtifacts({
    repoRoot: root,
    runtimeReport: { ...GREEN_RUNTIME_REPORT, runtimeReady: false },
  });
  assert.equal(runtimeDown.ready, false);
  assert(runtimeDown.blockingReasons.includes("ordinary-dynamic-shadow-r3-live-runtime-preflight-failed"));

  // 11. A missing acceptance report fails closed.
  fs.rmSync(path.join(root, ACCEPTANCE_REPORT_RELATIVE_PATH));
  const reportMissing = audit(root);
  assert.equal(reportMissing.ready, false);
  assert(reportMissing.blockingReasons.includes("ordinary-dynamic-shadow-r3-live-acceptance-unreadable"));

  console.log("ok - western ordinary dynamic shadow acceptance live-artifact verifier");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
