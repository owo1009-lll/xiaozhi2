#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEvidence,
  runFreeze,
  serializeEvidence,
} from "./freeze-western-strings-homr-evidence.mjs";

const PIECES = ["violin-ex05", "violin-ex08", "violin-ex09", "violin-ex10", "violin-ex12"];
const REPORT_ORDER = ["violin-ex09", "violin-ex05", "violin-ex08", "violin-ex10", "violin-ex12"];
const STATS = {
  "violin-ex09": [288, 386, 288, 0.746114, 1, 0.996528, 0.996528],
  "violin-ex05": [288, 288, 288, 1, 1, 0.006944, 1],
  "violin-ex08": [341, 373, 292, 0.782842, 0.856305, 0.032258, 0.043988],
  "violin-ex10": [324, 326, 307, 0.941718, 0.947531, 0.444444, 0.996914],
  "violin-ex12": [324, 324, 324, 1, 1, 0.080247, 1],
};
const AGGREGATE = {
  rows: 5,
  usableRows: 5,
  engineFailureRows: 0,
  unusableEvidenceRows: 0,
  goldNotes: 1565,
  attemptedGoldNotes: 1565,
  draftNotes: 1697,
  pitchExact: 1499,
  pitchPrecision: 0.883324,
  pitchRecall: 0.957827,
  pitchMissRate: 0.042173,
  pitchRecallIncludingEngineFailures: 0.957827,
  onsetQuarterAccuracy: 0.300319,
  measureAccuracy: 0.790415,
  pitchOnlyStrictPassRows: 2,
  pitchOnlyStrictPassPieceIds: ["violin-ex05", "violin-ex12"],
  strictPassRows: 0,
  strictPassPieceIds: [],
};
const THRESHOLDS = {
  minPitchPrecision: 0.98,
  minPitchRecall: 0.95,
  minOnsetQuarterAccuracy: 0.95,
  minMeasureAccuracy: 0.95,
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows, headers) {
  return `${[headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

async function write(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function createFixture(root) {
  const freshRoot = "data/experiments/western-strings-m4/homr-fresh-sourcegold-revalidation-20260717";
  const goldRoot = "data/experiments/western-strings-m4/independent-real-photo-gold";
  const reportPath = `${freshRoot}/homr-source-benchmark.json`;
  const sourceCsvPath = `${freshRoot}/homr-source-benchmark.csv`;
  const intakePath = `${goldRoot}/independent-source-benchmark-intake.csv`;
  const goldManifestPath = `${goldRoot}/independent-gold-manifest.json`;
  const evaluatorPath = "scripts/experiments/eval_western_strings_m4_homr_benchmark.py";
  const freezerPath = "scripts/freeze-western-strings-homr-evidence.mjs";
  const outPath = "docs/evidence/western-strings-homr-sourcegold-20260717.json";

  await write(root, evaluatorPath, "# frozen evaluator fixture\n");
  await write(root, freezerPath, "// frozen manifest writer fixture\n");

  const intakeRows = [];
  const photoGold = [];
  const reportRows = [];
  const originalOutput = new Map();
  for (const pieceId of PIECES) {
    const sourcePath = `data/private/western-strings-m2/${pieceId}-score.jpg`;
    const goldPath = `${goldRoot}/${pieceId}.independent-source-gold.musicxml`;
    const outputPath = `${freshRoot}/${pieceId}/input.musicxml`;
    const inputCopyPath = `${freshRoot}/${pieceId}/input.jpg`;
    const sourceBytes = Buffer.from(`source-photo:${pieceId}\n`);
    const goldBytes = Buffer.from(`<score id="${pieceId}"/>\n`);
    const outputBytes = Buffer.from(`<homr id="${pieceId}"/>\n`);
    await write(root, sourcePath, sourceBytes);
    await write(root, goldPath, goldBytes);
    await write(root, outputPath, outputBytes);
    await write(root, inputCopyPath, sourceBytes);
    originalOutput.set(pieceId, outputBytes);

    intakeRows.push({
      pieceId,
      currentScorePath: sourcePath,
      requiredCleanScorePath: goldPath,
      cleanScoreReviewStatus: "approved",
      cleanScoreReviewedBy: "1",
      cleanScoreReviewNotes: "approved, independent source",
      goldProvenance: "independent-source-derived-gold",
      goldSourceManifest: goldManifestPath,
    });
    photoGold.push({
      pieceId,
      path: `${pieceId}.independent-source-gold.musicxml`,
      sha256: sha256(goldBytes),
      bytes: goldBytes.length,
    });
  }

  for (const pieceId of REPORT_ORDER) {
    const [goldNotes, draftNotes, pitchExact, pitchPrecision, pitchRecall, onset, measure] = STATS[pieceId];
    reportRows.push({
      pieceId,
      engine: "homr",
      engineVersion: "0.7.0",
      variant: "native-source",
      status: "ok",
      homrExit: 0,
      runtimeSeconds: 1,
      goldPath: `${goldRoot}/${pieceId}.independent-source-gold.musicxml`,
      draftPath: `${freshRoot}/${pieceId}/input.musicxml`,
      parseOk: true,
      benchmarkUsable: true,
      goldProvenance: "independent-source-derived-gold",
      goldSourceManifest: goldManifestPath,
      goldSourceVerified: "yes",
      cleanScoreReviewStatus: "approved",
      cleanScoreReviewedBy: "1",
      humanVerifiedCleanScore: "yes",
      goldNotes,
      draftNotes,
      pitchExact,
      pitchPrecision,
      pitchRecall,
      onsetQuarterAccuracy: onset,
      measureAccuracy: measure,
    });
  }

  const intakeHeaders = [
    "pieceId",
    "currentScorePath",
    "requiredCleanScorePath",
    "cleanScoreReviewStatus",
    "cleanScoreReviewedBy",
    "cleanScoreReviewNotes",
    "goldProvenance",
    "goldSourceManifest",
  ];
  const intakeText = csv(intakeRows, intakeHeaders);
  await write(root, intakePath, intakeText);
  await write(root, sourceCsvPath, csv(reportRows, ["pieceId", "status", "pitchPrecision", "pitchRecall"]));
  await write(root, goldManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    sourceRepository: "https://example.test/source",
    sourceCommit: "0123456789abcdef",
    license: "CC-BY-SA-4.0",
    photoGold,
  }, null, 2)}\n`);

  const report = {
    createdAt: "2026-07-16T18:56:48.111006+00:00",
    complete: true,
    evaluationMode: "independent-source-gold",
    runtime: {
      homr: "0.7.0",
      numpy: "2.4.6",
      onnxruntime: "1.27.0",
      providers: ["CPUExecutionProvider"],
      homrExecutableAvailable: true,
      license: "AGPL-3.0",
    },
    threadLimits: { OMP_NUM_THREADS: "2" },
    strictThresholds: THRESHOLDS,
    gate: {
      automaticAdoptionReady: false,
      minimumIndependentRows: 5,
      observedIndependentRows: 5,
      sampleSizeReady: true,
      studentGateReady: false,
    },
    comparison: { homr: AGGREGATE },
    artifacts: { intake: intakePath, json: reportPath, csv: sourceCsvPath },
    rows: reportRows,
  };
  await write(root, reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return {
    options: {
      repoRoot: root,
      report: reportPath,
      sourceCsv: sourceCsvPath,
      intake: intakePath,
      goldManifest: goldManifestPath,
      evaluator: evaluatorPath,
      freezer: freezerPath,
      out: outPath,
    },
    paths: {
      report: path.join(root, ...reportPath.split("/")),
      intake: path.join(root, ...intakePath.split("/")),
      goldManifest: path.join(root, ...goldManifestPath.split("/")),
      evaluator: path.join(root, ...evaluatorPath.split("/")),
      freezer: path.join(root, ...freezerPath.split("/")),
      out: path.join(root, ...outPath.split("/")),
      output(pieceId) {
        return path.join(root, ...`${freshRoot}/${pieceId}/input.musicxml`.split("/"));
      },
    },
    intakeText,
    report,
    originalOutput,
  };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "western-homr-freeze-"));
const checks = [];
try {
  const fixture = await createFixture(root);
  const first = await buildEvidence(fixture.options);
  const second = await buildEvidence(fixture.options);
  assert.deepEqual(second, first);
  assert.equal(first.aggregate.pitchPrecision, 0.883324);
  assert.equal(first.aggregate.pitchRecall, 0.957827);
  assert.equal(first.aggregate.onsetQuarterAccuracy, 0.300319);
  assert.equal(first.aggregate.measureAccuracy, 0.790415);
  assert.equal(first.aggregate.strictPassRows, 0);
  assert.deepEqual(first.rows.map((row) => row.pieceId), PIECES);
  const serialized = serializeEvidence(first);
  assert(!serialized.includes(root));
  assert(!serialized.includes("python.exe"));
  assert(!serialized.includes("homr.exe"));
  assert(!serialized.includes("\\"));
  checks.push("stable-sanitized-manifest");

  await fs.writeFile(fixture.paths.evaluator, "# frozen evaluator fixture\r\n");
  await fs.writeFile(fixture.paths.freezer, "// frozen manifest writer fixture\r\n");
  assert.deepEqual(await buildEvidence(fixture.options), first);
  checks.push("tracked-script-line-ending-normalization");

  await runFreeze(fixture.options);
  await runFreeze({ ...fixture.options, check: true });
  const frozenLf = await fs.readFile(fixture.paths.out, "utf8");
  await fs.writeFile(fixture.paths.out, frozenLf.replaceAll("\n", "\r\n"));
  await runFreeze({ ...fixture.options, check: true });
  checks.push("write-and-check");

  await fs.appendFile(fixture.paths.output("violin-ex05"), "drift");
  await assert.rejects(
    runFreeze({ ...fixture.options, check: true }),
    /frozen-evidence-drift/,
  );
  await fs.writeFile(fixture.paths.output("violin-ex05"), fixture.originalOutput.get("violin-ex05"));
  await runFreeze({ ...fixture.options, check: true });
  checks.push("artifact-hash-drift-detected");

  const wrongRuntime = structuredClone(fixture.report);
  wrongRuntime.runtime.onnxruntime = "1.26.0";
  await fs.writeFile(fixture.paths.report, `${JSON.stringify(wrongRuntime, null, 2)}\n`);
  await assert.rejects(buildEvidence(fixture.options), /onnxruntime-version-mismatch/);
  await fs.writeFile(fixture.paths.report, `${JSON.stringify(fixture.report, null, 2)}\n`);
  checks.push("runtime-version-guard");

  const reused = structuredClone(fixture.report);
  reused.rows[0].reusedExisting = true;
  await fs.writeFile(fixture.paths.report, `${JSON.stringify(reused, null, 2)}\n`);
  await assert.rejects(buildEvidence(fixture.options), /reused-existing/);
  await fs.writeFile(fixture.paths.report, `${JSON.stringify(fixture.report, null, 2)}\n`);
  checks.push("fresh-no-reuse-guard");

  const duplicate = structuredClone(fixture.report);
  duplicate.rows[1].pieceId = duplicate.rows[0].pieceId;
  await fs.writeFile(fixture.paths.report, `${JSON.stringify(duplicate, null, 2)}\n`);
  await assert.rejects(buildEvidence(fixture.options), /piece-id-duplicate/);
  await fs.writeFile(fixture.paths.report, `${JSON.stringify(fixture.report, null, 2)}\n`);
  checks.push("unique-piece-guard");

  const escapedIntake = fixture.intakeText.replace(
    "data/private/western-strings-m2/violin-ex05-score.jpg",
    "../outside.jpg",
  );
  await fs.writeFile(fixture.paths.intake, escapedIntake);
  await assert.rejects(buildEvidence(fixture.options), /outside-repo/);
  await fs.writeFile(fixture.paths.intake, fixture.intakeText);
  checks.push("repo-path-boundary");

  const manifest = JSON.parse(await fs.readFile(fixture.paths.goldManifest, "utf8"));
  const validManifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  manifest.photoGold[0].sha256 = "0".repeat(64);
  await fs.writeFile(fixture.paths.goldManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(buildEvidence(fixture.options), /gold-hash-mismatch/);
  await fs.writeFile(fixture.paths.goldManifest, validManifestText);
  checks.push("gold-manifest-hash-guard");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, checks }));
