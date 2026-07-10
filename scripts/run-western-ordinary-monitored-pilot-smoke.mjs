import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runWesternControlledSubmissionBatch } from "../src/server/westernStringsAlignmentService.js";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3", "ordinary-monitored-pilot");
const RELEASE_REL = path.join("models", "western-strings", "ordinary-upload-confidence-rf-v1", "release.json");

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT_DIR, keepTemp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
    else if (arg === "--keep-temp") args.keepTemp = true;
  }
  return args;
}

function rel(filePath, root = process.cwd()) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function sineWavBuffer({ frequency = 440, durationSeconds = 1.25, sampleRate = 22050 } = {}) {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 12000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

async function copyFixture(fromRel, toRoot) {
  const from = path.resolve(fromRel);
  const to = path.join(toRoot, fromRel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  return rel(to, toRoot);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function setupTempRepo(tempRoot) {
  const m2Root = path.join(tempRoot, "data", "experiments", "western-strings-m2");
  const m3Root = path.join(tempRoot, "data", "experiments", "western-strings-m3");
  await fs.mkdir(m2Root, { recursive: true });
  await fs.mkdir(m3Root, { recursive: true });

  await writeJson(path.join(m2Root, "m2d-sequence-support-summary.json"), { ok: true, studentGateReady: true });
  await writeJson(path.join(m2Root, "m2f-real-student-recording-summary.json"), { ok: true, studentGateReady: true });
  await writeJson(path.join(m3Root, "m3-diagnosis-summary.json"), {
    ok: true,
    diagnosisGateReady: true,
    gate: { requiredCategories: ["pitch", "onset", "missing"], reviewOnlyCategories: ["duration", "extra"] },
  });

  await writeJson(path.join(tempRoot, "data", "erhu-score-imports.json"), {
    jobs: [],
    scores: [
      {
        scoreId: "score-test-clean",
        title: "Ordinary monitored pilot smoke score",
        scoreSource: "musicxml",
        sections: [
          {
            sectionId: "section-1",
            title: "Section 1",
            tempo: 72,
            notes: [
              { noteId: "n1", measureIndex: 1, beatStart: 0, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
              { noteId: "n2", measureIndex: 1, beatStart: 1, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
              { noteId: "n3", measureIndex: 1, beatStart: 2, beatDuration: 1, midiPitch: 69, notePosition: { pageNumber: 1, globalMeasureIndex: 1, localMeasureIndex: 1 } },
            ],
          },
        ],
      },
    ],
  });

  const audioPath = path.join(tempRoot, "student.wav");
  await fs.writeFile(audioPath, sineWavBuffer());
  await fs.writeFile(
    path.join(m3Root, "controlled-submissions.jsonl"),
    `${JSON.stringify({
      submissionId: "ordinary-smoke-1",
      submittedAt: new Date().toISOString(),
      scoreId: "score-test-clean",
      audioPath,
      instrument: "violin",
      limit: 3,
      status: "review_required",
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(m3Root, "controlled-submission-reviews.jsonl"),
    `${JSON.stringify({ submissionId: "ordinary-smoke-1", action: "accepted_for_batch" })}\n`,
    "utf8",
  );

  const copied = [];
  for (const fixture of [
    path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
    path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "candidate-confidence-pilot.json"),
    path.join("data", "experiments", "western-strings-m3", "confidence-recalibration", "combined-controlled-candidate-review-labels.csv"),
    path.join("data", "experiments", "western-strings-m3", "confidence-validation-review", "confidence-validation-eval.json"),
    path.join("data", "experiments", "western-strings-m3", "confidence-recalibration-context-validation-review", "confidence-recalibration-context-validation-eval.json"),
    RELEASE_REL,
  ]) {
    copied.push(await copyFixture(fixture, tempRoot));
  }
  return { copied, releasePath: path.join(tempRoot, RELEASE_REL) };
}

function summarizeItem(item) {
  return {
    analysisStatus: item?.analysisStatus || "",
    candidateRowsPath: item?.candidateRowsPath || "",
    candidateGate: {
      ready: item?.candidateGate?.ready === true,
      mode: item?.candidateGate?.mode || "",
      gateVersion: item?.candidateGate?.gateVersion || "",
      modelVersion: item?.candidateGate?.modelVersion || "",
      threshold: item?.candidateGate?.threshold ?? null,
      evaluatedCandidateCount: item?.candidateGate?.evaluatedCandidateCount ?? null,
      modelAutoPassCandidateCount: item?.candidateGate?.modelAutoPassCandidateCount ?? null,
      autoPassCandidateCount: item?.candidateGate?.autoPassCandidateCount ?? null,
      reviewRequiredCandidateCount: item?.candidateGate?.reviewRequiredCandidateCount ?? null,
      controlledPilotScope: item?.candidateGate?.controlledPilotScope || null,
      reason: item?.candidateGate?.reason || "",
    },
    previewDecisions: (item?.candidatePreview || []).map((candidate) => ({
      noteId: candidate.noteId,
      gateDecision: candidate.gateDecision,
      confidenceProbability: candidate.confidenceProbability ?? null,
      studentSafeGateReady: candidate.studentSafeGateReady === true,
      studentFacing: candidate.studentFacing === true,
    })),
  };
}

function renderMarkdown(report) {
  const gate = report.batchItem.candidateGate;
  return [
    "# Ordinary Upload Monitored Pilot Smoke",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Result",
    "",
    `- ok: ${report.ok}`,
    `- tempRunOnly: ${report.tempRunOnly}`,
    `- tempRootDeleted: ${report.tempRootDeleted}`,
    `- defaultOrdinaryReadyBefore: ${report.defaultOrdinaryReadyBefore}`,
    `- defaultOrdinaryReadyAfter: ${report.defaultOrdinaryReadyAfter}`,
    "",
    "## Runtime Gate",
    "",
    `- ready: ${gate.ready}`,
    `- mode: ${gate.mode}`,
    `- modelVersion: ${gate.modelVersion}`,
    `- threshold: ${gate.threshold}`,
    `- evaluatedCandidateCount: ${gate.evaluatedCandidateCount}`,
    `- modelAutoPassCandidateCount: ${gate.modelAutoPassCandidateCount}`,
    `- autoPassCandidateCount: ${gate.autoPassCandidateCount}`,
    `- reviewRequiredCandidateCount: ${gate.reviewRequiredCandidateCount}`,
    `- controlledPilotScope: ${gate.controlledPilotScope?.scopeName || "none"}`,
    `- controlledPilotScopeCoverage: ${gate.controlledPilotScope?.scopeCoverage ?? ""}`,
    "",
    "## Safety Interpretation",
    "",
    "- This smoke runs with the release flag only inside a temporary repo root.",
    "- It proves the disabled-by-default runtime wiring can execute the frozen RF scorer.",
    "- It does not enable ordinary-upload auto feedback in the default project runtime.",
    "- A real monitored pilot still needs human review of any auto_pass rows before release.",
    "",
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
  ].join("\n");
}

export async function runOrdinaryMonitoredPilotSmoke(args = {}) {
  const outDir = path.resolve(args.outDir || DEFAULT_OUT_DIR);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-ordinary-pilot-smoke-"));
  let tempRootDeleted = false;
  const oldEnable = process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE;
  const oldRelease = process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE;
  const statusBefore = await buildProjectStatus();
  let report;
  try {
    const setup = await setupTempRepo(tempRoot);
    process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE = "1";
    process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE = setup.releasePath;
    const result = await runWesternControlledSubmissionBatch({ repoRoot: tempRoot, limit: 1 });
    const item = result.batch.items[0] || {};
    const batchItem = summarizeItem(item);
    report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      tempRunOnly: true,
      tempRoot: args.keepTemp ? tempRoot : "",
      tempRootDeleted: false,
      copiedFixtures: setup.copied,
      defaultOrdinaryReadyBefore: statusBefore.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === true,
      defaultOrdinaryReadyAfter: null,
      batch: {
        status: result.batch.status,
        itemCount: result.batch.itemCount,
        reason: result.batch.reason,
      },
      batchItem,
      blockingReasons: [],
    };
    if (result.batch.itemCount !== 1) report.blockingReasons.push("expected-one-temp-batch-item");
    if (batchItem.candidateGate.ready !== true) report.blockingReasons.push("confidence-gate-not-ready-in-smoke");
    if (batchItem.candidateGate.mode !== "confidence_rf") report.blockingReasons.push("confidence-gate-mode-not-rf");
    if (batchItem.candidateGate.modelVersion !== "ordinary-upload-confidence-rf-v1") report.blockingReasons.push("unexpected-confidence-model-version");
    const evaluated = Number(batchItem.candidateGate.evaluatedCandidateCount);
    const autoPass = Number(batchItem.candidateGate.autoPassCandidateCount);
    const reviewRequired = Number(batchItem.candidateGate.reviewRequiredCandidateCount);
    if (batchItem.candidateGate.controlledPilotScope?.scopeName !== "first-measure-only") {
      report.blockingReasons.push("controlled-pilot-first-measure-scope-missing");
    }
    if (!Number.isFinite(evaluated) || evaluated <= 0) report.blockingReasons.push("no-candidates-evaluated");
    if (Number.isFinite(evaluated) && Number.isFinite(autoPass) && Number.isFinite(reviewRequired) && autoPass + reviewRequired !== evaluated) {
      report.blockingReasons.push("candidate-decision-count-mismatch");
    }
  } finally {
    if (oldEnable === undefined) delete process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE;
    else process.env.WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE = oldEnable;
    if (oldRelease === undefined) delete process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE;
    else process.env.WESTERN_STRINGS_ORDINARY_AUTO_GATE_RELEASE = oldRelease;
    if (!args.keepTemp) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRootDeleted = true;
    }
  }

  const statusAfter = await buildProjectStatus();
  report.defaultOrdinaryReadyAfter = statusAfter.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === true;
  report.tempRootDeleted = tempRootDeleted;
  if (report.defaultOrdinaryReadyBefore !== false) report.blockingReasons.push("default-ordinary-runtime-ready-before-smoke");
  if (report.defaultOrdinaryReadyAfter !== false) report.blockingReasons.push("default-ordinary-runtime-ready-after-smoke");
  report.ok = report.blockingReasons.length === 0;

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "ordinary-monitored-pilot-smoke.json");
  const mdPath = path.join(outDir, "ordinary-monitored-pilot-smoke.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  return { report, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { report, jsonPath, mdPath } = await runOrdinaryMonitoredPilotSmoke(args);
  console.log(JSON.stringify({
    ok: report.ok,
    blockingReasons: report.blockingReasons,
    defaultOrdinaryReadyAfter: report.defaultOrdinaryReadyAfter,
    gate: report.batchItem.candidateGate,
    out: {
      json: rel(jsonPath),
      md: rel(mdPath),
    },
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
