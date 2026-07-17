#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const FRESH_ROOT = path.join(
  "data",
  "experiments",
  "western-strings-m4",
  "homr-fresh-sourcegold-revalidation-20260717",
);

const DEFAULTS = Object.freeze({
  report: path.join(FRESH_ROOT, "homr-source-benchmark.json"),
  sourceCsv: path.join(FRESH_ROOT, "homr-source-benchmark.csv"),
  intake: path.join(
    "data",
    "experiments",
    "western-strings-m4",
    "independent-real-photo-gold",
    "independent-source-benchmark-intake.csv",
  ),
  goldManifest: path.join(
    "data",
    "experiments",
    "western-strings-m4",
    "independent-real-photo-gold",
    "independent-gold-manifest.json",
  ),
  evaluator: path.join("scripts", "experiments", "eval_western_strings_m4_homr_benchmark.py"),
  freezer: path.join("scripts", "freeze-western-strings-homr-evidence.mjs"),
  out: path.join("docs", "evidence", "western-strings-homr-sourcegold-20260717.json"),
});

const EXPECTED_PATHS = Object.freeze({
  "violin-ex05": {
    source: "data/private/western-strings-m2/violin-ex05-score.jpg",
    gold: "data/experiments/western-strings-m4/independent-real-photo-gold/violin-ex05.independent-source-gold.musicxml",
  },
  "violin-ex08": {
    source: "data/private/western-strings-m2/violin-ex08-score.jpg",
    gold: "data/experiments/western-strings-m4/independent-real-photo-gold/violin-ex08.independent-source-gold.musicxml",
  },
  "violin-ex09": {
    source: "data/private/western-strings-m2/violin-ex09-score.jpg",
    gold: "data/experiments/western-strings-m4/independent-real-photo-gold/violin-ex09.independent-source-gold.musicxml",
  },
  "violin-ex10": {
    source: "data/private/western-strings-m2/violin-ex10-score.jpg",
    gold: "data/experiments/western-strings-m4/independent-real-photo-gold/violin-ex10.independent-source-gold.musicxml",
  },
  "violin-ex12": {
    source: "data/private/western-strings-m2/violin-ex12-score.jpg",
    gold: "data/experiments/western-strings-m4/independent-real-photo-gold/violin-ex12.independent-source-gold.musicxml",
  },
});

const EXPECTED_PIECE_IDS = Object.freeze(Object.keys(EXPECTED_PATHS).sort());
const EXPECTED_THRESHOLDS = Object.freeze({
  minPitchPrecision: 0.98,
  minPitchRecall: 0.95,
  minOnsetQuarterAccuracy: 0.95,
  minMeasureAccuracy: 0.95,
});
const EXPECTED_AGGREGATE = Object.freeze({
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
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function round6(value) {
  return Number(Number(value).toFixed(6));
}

function roundHalfEven(value) {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (Math.abs(fraction - 0.5) <= 1e-9) return lower % 2 === 0 ? lower : lower + 1;
  return Math.round(value);
}

function safeRate(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveOption(repoRoot, value, label) {
  const resolved = path.resolve(repoRoot, value || "");
  invariant(isWithin(repoRoot, resolved), `${label}-outside-repo:${value}`);
  return resolved;
}

function resolveRecordedPath(repoRoot, value, label) {
  invariant(typeof value === "string" && value.trim(), `${label}-missing`);
  invariant(!path.isAbsolute(value) && !path.win32.isAbsolute(value), `${label}-must-be-repo-relative:${value}`);
  const resolved = path.resolve(repoRoot, value.replace(/[\\/]+/g, path.sep));
  invariant(isWithin(repoRoot, resolved), `${label}-outside-repo:${value}`);
  return resolved;
}

function repoPath(repoRoot, absolutePath) {
  invariant(isWithin(repoRoot, absolutePath), `path-outside-repo:${absolutePath}`);
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

async function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label}-invalid:${error.message}`);
  }
  return value;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  invariant(!quoted, "csv-unclosed-quote");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  while (rows.length && rows.at(-1).every((value) => value === "")) rows.pop();
  invariant(rows.length >= 2, "csv-no-data-rows");
  const headers = rows[0].map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value));
  invariant(new Set(headers).size === headers.length, "csv-duplicate-header");
  return rows.slice(1).map((values, rowIndex) => {
    invariant(values.length === headers.length, `csv-column-count-mismatch:${rowIndex + 2}`);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

async function fileRecord(repoRoot, filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  invariant(stat?.isFile(), `${label}-missing:${repoPath(repoRoot, filePath)}`);
  const bytes = await fs.readFile(filePath);
  return {
    repoPath: repoPath(repoRoot, filePath),
    bytes: stat.size,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

async function normalizedTextFileRecord(repoRoot, filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  invariant(stat?.isFile(), `${label}-missing:${repoPath(repoRoot, filePath)}`);
  const normalized = (await fs.readFile(filePath, "utf8")).replace(/\r\n?/g, "\n");
  const bytes = Buffer.from(normalized, "utf8");
  return {
    repoPath: repoPath(repoRoot, filePath),
    normalizedBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    hashMode: "utf8-lf-normalized",
  };
}

function uniqueRows(rows, label) {
  const ids = rows.map((row) => String(row.pieceId || "").trim());
  invariant(ids.every(Boolean), `${label}-piece-id-missing`);
  invariant(new Set(ids).size === ids.length, `${label}-piece-id-duplicate`);
  invariant(jsonEqual([...ids].sort(), EXPECTED_PIECE_IDS), `${label}-piece-set-mismatch:${ids.join(",")}`);
  return new Map(rows.map((row) => [String(row.pieceId).trim(), row]));
}

function validateRowMetrics(row) {
  const pieceId = row.pieceId;
  for (const field of ["goldNotes", "draftNotes", "pitchExact"]) {
    invariant(Number.isInteger(row[field]) && row[field] >= 0, `${pieceId}-${field}-invalid`);
  }
  const pitchPrecision = round6(safeRate(row.pitchExact, row.draftNotes));
  const pitchRecall = round6(safeRate(row.pitchExact, row.goldNotes));
  invariant(row.pitchPrecision === pitchPrecision, `${pieceId}-pitch-precision-mismatch`);
  invariant(row.pitchRecall === pitchRecall, `${pieceId}-pitch-recall-mismatch`);
  for (const field of ["onsetQuarterAccuracy", "measureAccuracy"]) {
    invariant(Number.isFinite(row[field]) && row[field] >= 0 && row[field] <= 1, `${pieceId}-${field}-invalid`);
    const exact = roundHalfEven(row[field] * row.goldNotes);
    invariant(round6(safeRate(exact, row.goldNotes)) === row[field], `${pieceId}-${field}-not-count-derived`);
  }
}

export function recomputeAggregate(rows, thresholds = EXPECTED_THRESHOLDS) {
  const usable = rows.filter((row) => row.benchmarkUsable === true && row.parseOk === true);
  const engineFailures = rows.filter((row) => row.parseOk !== true);
  const unusableEvidence = rows.filter((row) => row.parseOk === true && row.benchmarkUsable !== true);
  const verified = rows.filter(
    (row) => row.goldSourceVerified === "yes" || row.humanVerifiedCleanScore === "yes",
  );
  rows.forEach(validateRowMetrics);
  const sum = (selected, field) => selected.reduce((total, row) => total + Number(row[field] || 0), 0);
  const goldNotes = sum(usable, "goldNotes");
  const attemptedGoldNotes = sum(verified, "goldNotes");
  const draftNotes = sum(usable, "draftNotes");
  const pitchExact = sum(usable, "pitchExact");
  const onsetExact = usable.reduce(
    (total, row) => total + roundHalfEven(row.onsetQuarterAccuracy * row.goldNotes),
    0,
  );
  const measureExact = usable.reduce(
    (total, row) => total + roundHalfEven(row.measureAccuracy * row.goldNotes),
    0,
  );
  const pitchOnly = usable.filter(
    (row) => row.pitchPrecision >= thresholds.minPitchPrecision && row.pitchRecall >= thresholds.minPitchRecall,
  );
  const strict = pitchOnly.filter(
    (row) => row.onsetQuarterAccuracy >= thresholds.minOnsetQuarterAccuracy
      && row.measureAccuracy >= thresholds.minMeasureAccuracy,
  );
  return {
    rows: rows.length,
    usableRows: usable.length,
    engineFailureRows: engineFailures.length,
    unusableEvidenceRows: unusableEvidence.length,
    goldNotes,
    attemptedGoldNotes,
    draftNotes,
    pitchExact,
    pitchPrecision: round6(safeRate(pitchExact, draftNotes)),
    pitchRecall: round6(safeRate(pitchExact, goldNotes)),
    pitchMissRate: round6(1 - safeRate(pitchExact, goldNotes)),
    pitchRecallIncludingEngineFailures: round6(safeRate(pitchExact, attemptedGoldNotes)),
    onsetQuarterAccuracy: round6(safeRate(onsetExact, goldNotes)),
    measureAccuracy: round6(safeRate(measureExact, goldNotes)),
    pitchOnlyStrictPassRows: pitchOnly.length,
    pitchOnlyStrictPassPieceIds: pitchOnly.map((row) => row.pieceId),
    strictPassRows: strict.length,
    strictPassPieceIds: strict.map((row) => row.pieceId),
  };
}

function assertAggregate(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    invariant(jsonEqual(actual?.[key], value), `${label}-${key}-mismatch`);
  }
}

function normalizeOptions(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  return {
    repoRoot,
    reportPath: resolveOption(repoRoot, options.report || DEFAULTS.report, "report"),
    sourceCsvPath: resolveOption(repoRoot, options.sourceCsv || DEFAULTS.sourceCsv, "source-csv"),
    intakePath: resolveOption(repoRoot, options.intake || DEFAULTS.intake, "intake"),
    goldManifestPath: resolveOption(
      repoRoot,
      options.goldManifest || DEFAULTS.goldManifest,
      "gold-manifest",
    ),
    evaluatorPath: resolveOption(repoRoot, options.evaluator || DEFAULTS.evaluator, "evaluator"),
    freezerPath: resolveOption(repoRoot, options.freezer || DEFAULTS.freezer, "freezer"),
    outPath: resolveOption(repoRoot, options.out || DEFAULTS.out, "out"),
    check: options.check === true,
  };
}

export async function buildEvidence(options = {}) {
  const opts = normalizeOptions(options);
  const report = await readJson(opts.reportPath, "fresh-report");
  const goldManifest = await readJson(opts.goldManifestPath, "gold-manifest");
  const intakeRows = parseCsv(await fs.readFile(opts.intakePath, "utf8"));

  invariant(report.complete === true, "fresh-report-incomplete");
  invariant(report.evaluationMode === "independent-source-gold", "fresh-report-mode-mismatch");
  invariant(report.runtime?.homr === "0.7.0", "fresh-report-homr-version-mismatch");
  invariant(report.runtime?.numpy === "2.4.6", "fresh-report-numpy-version-mismatch");
  invariant(report.runtime?.onnxruntime === "1.27.0", "fresh-report-onnxruntime-version-mismatch");
  invariant(report.runtime?.homrExecutableAvailable === true, "fresh-report-homr-executable-unavailable");
  invariant(report.runtime?.license === "AGPL-3.0", "fresh-report-license-mismatch");
  invariant(report.runtime?.reusedExistingOnly !== true, "fresh-report-reused-existing-only");
  invariant(jsonEqual(report.strictThresholds, EXPECTED_THRESHOLDS), "fresh-report-threshold-mismatch");
  invariant(Array.isArray(report.rows) && report.rows.length === 5, "fresh-report-row-count-mismatch");

  const reportByPiece = uniqueRows(report.rows, "fresh-report");
  const intakeByPiece = uniqueRows(intakeRows, "intake");
  invariant(Array.isArray(goldManifest.photoGold), "gold-manifest-photo-gold-missing");
  const goldByPiece = uniqueRows(goldManifest.photoGold, "gold-manifest");
  const freshRoot = path.dirname(opts.reportPath);

  const artifactIntake = resolveRecordedPath(opts.repoRoot, report.artifacts?.intake, "report-intake-path");
  const artifactJson = resolveRecordedPath(opts.repoRoot, report.artifacts?.json, "report-json-path");
  const artifactCsv = resolveRecordedPath(opts.repoRoot, report.artifacts?.csv, "report-csv-path");
  invariant(artifactIntake === opts.intakePath, "report-intake-path-mismatch");
  invariant(artifactJson === opts.reportPath, "report-json-path-mismatch");
  invariant(artifactCsv === opts.sourceCsvPath, "report-csv-path-mismatch");

  const aggregate = recomputeAggregate(report.rows, report.strictThresholds);
  assertAggregate(aggregate, report.comparison?.homr, "reported-aggregate");
  assertAggregate(aggregate, EXPECTED_AGGREGATE, "frozen-aggregate");
  invariant(report.gate?.automaticAdoptionReady === false, "fresh-report-automatic-adoption-mismatch");
  invariant(report.gate?.observedIndependentRows === 5, "fresh-report-observed-row-count-mismatch");
  invariant(report.gate?.minimumIndependentRows === 5, "fresh-report-minimum-row-count-mismatch");
  invariant(report.gate?.sampleSizeReady === true, "fresh-report-sample-size-not-ready");

  const frozenRows = [];
  for (const pieceId of EXPECTED_PIECE_IDS) {
    const row = reportByPiece.get(pieceId);
    const intake = intakeByPiece.get(pieceId);
    const goldEntry = goldByPiece.get(pieceId);
    const expected = EXPECTED_PATHS[pieceId];

    invariant(row.status === "ok" && row.parseOk === true && row.benchmarkUsable === true, `${pieceId}-not-usable`);
    invariant(row.engine === "homr" && row.engineVersion === "0.7.0", `${pieceId}-engine-mismatch`);
    invariant(row.homrExit === 0 && Number(row.runtimeSeconds) > 0, `${pieceId}-not-freshly-executed`);
    invariant(row.reusedExisting !== true, `${pieceId}-reused-existing`);
    invariant(row.goldSourceVerified === "yes", `${pieceId}-gold-source-unverified`);
    invariant(row.humanVerifiedCleanScore === "yes", `${pieceId}-gold-not-human-verified`);
    invariant(row.cleanScoreReviewStatus === "approved", `${pieceId}-report-review-not-approved`);
    invariant(intake.cleanScoreReviewStatus === "approved", `${pieceId}-intake-review-not-approved`);
    invariant(intake.goldProvenance === "independent-source-derived-gold", `${pieceId}-provenance-mismatch`);

    const sourcePath = resolveRecordedPath(opts.repoRoot, intake.currentScorePath, `${pieceId}-source-path`);
    const goldPath = resolveRecordedPath(opts.repoRoot, intake.requiredCleanScorePath, `${pieceId}-gold-path`);
    const rowGoldPath = resolveRecordedPath(opts.repoRoot, row.goldPath, `${pieceId}-report-gold-path`);
    const outputPath = resolveRecordedPath(opts.repoRoot, row.draftPath, `${pieceId}-output-path`);
    const recordedManifestPath = resolveRecordedPath(
      opts.repoRoot,
      intake.goldSourceManifest,
      `${pieceId}-intake-gold-manifest-path`,
    );
    const rowManifestPath = resolveRecordedPath(
      opts.repoRoot,
      row.goldSourceManifest,
      `${pieceId}-report-gold-manifest-path`,
    );
    invariant(repoPath(opts.repoRoot, sourcePath) === expected.source, `${pieceId}-source-path-mismatch`);
    invariant(repoPath(opts.repoRoot, goldPath) === expected.gold, `${pieceId}-gold-path-mismatch`);
    invariant(rowGoldPath === goldPath, `${pieceId}-report-gold-path-mismatch`);
    invariant(recordedManifestPath === opts.goldManifestPath, `${pieceId}-intake-gold-manifest-mismatch`);
    invariant(rowManifestPath === opts.goldManifestPath, `${pieceId}-report-gold-manifest-mismatch`);
    invariant(isWithin(freshRoot, outputPath), `${pieceId}-output-not-in-fresh-root`);
    invariant(path.dirname(outputPath) === path.join(freshRoot, pieceId), `${pieceId}-output-directory-mismatch`);
    invariant(["input.musicxml", "input.mxl"].includes(path.basename(outputPath)), `${pieceId}-output-name-mismatch`);

    const manifestGoldPath = path.resolve(path.dirname(opts.goldManifestPath), goldEntry.path || "");
    invariant(isWithin(path.dirname(opts.goldManifestPath), manifestGoldPath), `${pieceId}-manifest-gold-outside-root`);
    invariant(manifestGoldPath === goldPath, `${pieceId}-manifest-gold-path-mismatch`);

    const source = await fileRecord(opts.repoRoot, sourcePath, `${pieceId}-source`);
    const gold = await fileRecord(opts.repoRoot, goldPath, `${pieceId}-gold`);
    const output = await fileRecord(opts.repoRoot, outputPath, `${pieceId}-output`);
    const inputCopyPath = path.join(path.dirname(outputPath), `input${path.extname(sourcePath).toLowerCase()}`);
    const inputCopy = await fileRecord(opts.repoRoot, inputCopyPath, `${pieceId}-homr-input-copy`);
    invariant(gold.sha256 === String(goldEntry.sha256 || "").toLowerCase(), `${pieceId}-gold-hash-mismatch`);
    invariant(inputCopy.sha256 === source.sha256, `${pieceId}-homr-input-copy-hash-mismatch`);

    const pitchOnlyStrictPass = row.pitchPrecision >= EXPECTED_THRESHOLDS.minPitchPrecision
      && row.pitchRecall >= EXPECTED_THRESHOLDS.minPitchRecall;
    const strictPass = pitchOnlyStrictPass
      && row.onsetQuarterAccuracy >= EXPECTED_THRESHOLDS.minOnsetQuarterAccuracy
      && row.measureAccuracy >= EXPECTED_THRESHOLDS.minMeasureAccuracy;
    frozenRows.push({
      pieceId,
      sourceImage: source,
      homrInputCopy: inputCopy,
      gold: {
        ...gold,
        provenance: intake.goldProvenance,
        reviewStatus: intake.cleanScoreReviewStatus,
      },
      homrOutput: output,
      metrics: {
        goldNotes: row.goldNotes,
        draftNotes: row.draftNotes,
        pitchExact: row.pitchExact,
        pitchPrecision: row.pitchPrecision,
        pitchRecall: row.pitchRecall,
        onsetQuarterAccuracy: row.onsetQuarterAccuracy,
        measureAccuracy: row.measureAccuracy,
        pitchOnlyStrictPass,
        strictPass,
      },
    });
  }

  const sourceReport = await fileRecord(opts.repoRoot, opts.reportPath, "source-report");
  const sourceCsv = await fileRecord(opts.repoRoot, opts.sourceCsvPath, "source-csv");
  const intake = await fileRecord(opts.repoRoot, opts.intakePath, "intake");
  const manifestFile = await fileRecord(opts.repoRoot, opts.goldManifestPath, "gold-manifest");
  const evaluator = await normalizedTextFileRecord(opts.repoRoot, opts.evaluatorPath, "evaluator");
  const freezer = await normalizedTextFileRecord(opts.repoRoot, opts.freezerPath, "freezer");

  const automaticAdoptionReady = aggregate.rows >= 5
    && aggregate.usableRows === aggregate.rows
    && aggregate.engineFailureRows === 0
    && aggregate.unusableEvidenceRows === 0
    && aggregate.strictPassRows === aggregate.rows;
  invariant(automaticAdoptionReady === report.gate.automaticAdoptionReady, "automatic-adoption-recompute-mismatch");

  return {
    schemaVersion: 1,
    evidenceId: "western-strings-homr-sourcegold-20260717",
    authority: "current-frozen-homr-sourcegold-baseline",
    sourceCreatedAt: report.createdAt,
    evaluationMode: report.evaluationMode,
    freshRun: {
      reuseExisting: false,
      executedRows: 5,
      evidence: "every row has homrExit=0, runtimeSeconds>0, and no reusedExisting flag",
    },
    freezer,
    evaluator,
    intake,
    goldManifest: {
      ...manifestFile,
      sourceRepository: goldManifest.sourceRepository,
      sourceCommit: goldManifest.sourceCommit,
      license: goldManifest.license,
    },
    runtime: {
      homr: report.runtime.homr,
      numpy: report.runtime.numpy,
      onnxruntime: report.runtime.onnxruntime,
      providers: [...(report.runtime.providers || [])],
      license: report.runtime.license,
    },
    threadLimits: { ...(report.threadLimits || {}) },
    strictThresholds: { ...report.strictThresholds },
    aggregate: {
      ...aggregate,
      automaticAdoptionReady,
      studentGateReady: false,
    },
    rows: frozenRows,
    sourceArtifacts: {
      report: sourceReport,
      csv: sourceCsv,
    },
    limitations: [
      "Raw photos, gold, engine outputs, and the source report remain local gitignored artifacts; this tracked manifest freezes their paths and SHA-256 values.",
      "This evidence is an eval-only accuracy baseline and does not authorize automatic adoption or student-facing feedback.",
    ],
  };
}

export function serializeEvidence(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export async function runFreeze(options = {}) {
  const opts = normalizeOptions(options);
  const evidence = await buildEvidence(options);
  const serialized = serializeEvidence(evidence);
  if (opts.check) {
    const current = await fs.readFile(opts.outPath, "utf8").catch(() => null);
    invariant(current !== null, `frozen-evidence-missing:${repoPath(opts.repoRoot, opts.outPath)}`);
    const normalizedCurrent = current.replace(/\r\n?/g, "\n");
    invariant(normalizedCurrent === serialized, `frozen-evidence-drift:${repoPath(opts.repoRoot, opts.outPath)}`);
  } else {
    await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
    await fs.writeFile(opts.outPath, serialized, "utf8");
  }
  return { evidence, outPath: opts.outPath, checked: opts.check };
}

function parseArgs(argv) {
  const args = { check: false };
  const valueFlags = new Map([
    ["--report", "report"],
    ["--source-csv", "sourceCsv"],
    ["--intake", "intake"],
    ["--gold-manifest", "goldManifest"],
    ["--evaluator", "evaluator"],
    ["--freezer", "freezer"],
    ["--out", "out"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (valueFlags.has(arg)) {
      const value = argv[++index];
      invariant(value, `missing-value:${arg}`);
      args[valueFlags.get(arg)] = value;
    } else {
      throw new Error(`unknown-argument:${arg}`);
    }
  }
  return args;
}

async function main() {
  const result = await runFreeze(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    ok: true,
    checked: result.checked,
    out: repoPath(REPO_ROOT, result.outPath),
    rows: result.evidence.aggregate.rows,
    pitchPrecision: result.evidence.aggregate.pitchPrecision,
    pitchRecall: result.evidence.aggregate.pitchRecall,
    onsetQuarterAccuracy: result.evidence.aggregate.onsetQuarterAccuracy,
    measureAccuracy: result.evidence.aggregate.measureAccuracy,
    strictPassRows: result.evidence.aggregate.strictPassRows,
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
