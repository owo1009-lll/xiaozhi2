import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseCsv } from "./teacher-validation-support.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";

const DEFAULT_PREDICTIONS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration",
  "candidate-confidence-recalibration-pilot-predictions.csv",
);
const DEFAULT_RELEASE = path.join(
  "models",
  "western-strings",
  "ordinary-upload-confidence-rf-v1",
  "release.json",
);
const DEFAULT_OUT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-evidence-audit.json",
);
const DEFAULT_MD = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-evidence-audit.md",
);
const DEFAULT_SESSIONS_ROOT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-sessions",
);
const DEFAULT_KNOWN_LABELS = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "confidence-recalibration",
  "combined-controlled-candidate-review-labels.csv",
);
const DEFAULT_SCOPE_SMOKE = path.join(
  "data",
  "experiments",
  "western-strings-m3",
  "ordinary-monitored-pilot",
  "ordinary-monitored-pilot-smoke.json",
);
const MIN_PRECISION = 0.9;
const MIN_COVERAGE = 0.2;
const MIN_SELECTED = 10;
const SAFE_SCOPE_MAX_MEASURE_INDEX = 1;
const SAFE_SCOPE_MIN_CONFIDENCE = 0.95;
const MIN_OPERATIONAL_RECORDINGS_BEFORE_PROFESSIONAL_AUDIT = 5;

function parseArgs(argv) {
  const args = {
    predictions: DEFAULT_PREDICTIONS,
    release: DEFAULT_RELEASE,
    out: DEFAULT_OUT,
    markdown: DEFAULT_MD,
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    knownLabels: DEFAULT_KNOWN_LABELS,
    scopeSmoke: DEFAULT_SCOPE_SMOKE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--predictions") args.predictions = argv[++index] || args.predictions;
    else if (arg === "--release") args.release = argv[++index] || args.release;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--markdown") args.markdown = argv[++index] || args.markdown;
    else if (arg === "--sessions-root") args.sessionsRoot = argv[++index] || args.sessionsRoot;
    else if (arg === "--known-labels") args.knownLabels = argv[++index] || args.knownLabels;
    else if (arg === "--scope-smoke") args.scopeSmoke = argv[++index] || args.scopeSmoke;
  }
  return args;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function labelStatus(row = {}) {
  const status = String(row.teacherCandidateStatus || row["\uFEFFteacherCandidateStatus"] || "")
    .trim()
    .toLowerCase();
  return ["usable", "wrong"].includes(status) ? status : "";
}

function releaseExcludedRecordingIds(release = {}) {
  const ids = new Set();
  for (const section of [release.blindValidation, release.thresholdPoolValidation]) {
    for (const item of Array.isArray(section?.excludedKnownBadSources) ? section.excludedKnownBadSources : []) {
      const recordingId = String(item?.recordingId || "").trim();
      if (recordingId) ids.add(recordingId);
    }
  }
  return ids;
}

function summarizeSelection(rows, threshold) {
  const selected = rows.filter((row) => Number(row.probabilityUsable) >= threshold);
  const usable = selected.filter((row) => row.teacherCandidateStatus === "usable").length;
  const wrong = selected.filter((row) => row.teacherCandidateStatus === "wrong").length;
  const byRecording = new Map();
  for (const row of selected) {
    const recordingId = String(row.recordingId || "unknown");
    const group = byRecording.get(recordingId) || { selected: 0, usable: 0, wrong: 0 };
    group.selected += 1;
    group[row.teacherCandidateStatus] += 1;
    byRecording.set(recordingId, group);
  }
  const recordingMetrics = [...byRecording.entries()].map(([recordingId, counts]) => ({
    recordingId,
    ...counts,
    precision: counts.selected ? counts.usable / counts.selected : null,
  }));
  return {
    threshold,
    selected: selected.length,
    usable,
    wrong,
    precision: selected.length ? usable / selected.length : null,
    coverage: rows.length ? selected.length / rows.length : 0,
    distinctRecordingCount: recordingMetrics.length,
    worstRecordingPrecision: recordingMetrics.length
      ? Math.min(...recordingMetrics.map((item) => item.precision))
      : null,
    recordingMetrics,
  };
}

function summarizeOperationalSelection(rows, threshold) {
  const selected = rows.filter((row) => Number(row.confidenceProbability) >= threshold);
  const known = selected.filter((row) => ["usable", "wrong"].includes(row.teacherCandidateStatus));
  const usable = known.filter((row) => row.teacherCandidateStatus === "usable").length;
  const wrong = known.filter((row) => row.teacherCandidateStatus === "wrong").length;
  return {
    threshold,
    selected: selected.length,
    coverage: rows.length ? selected.length / rows.length : 0,
    knownSelected: known.length,
    knownUsable: usable,
    knownWrong: wrong,
    knownPrecision: known.length ? usable / known.length : null,
  };
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function loadOperationalCandidateRows({ sessionsRoot, knownLabels }) {
  const labelRows = parseCsv(await fs.readFile(path.resolve(knownLabels), "utf8"));
  const labels = new Map();
  for (const row of labelRows) {
    const status = labelStatus(row);
    if (!status) continue;
    labels.set([
      String(row.scoreId || "").trim(),
      String(row.recordingId || "").trim(),
      String(row.candidateId || "").trim(),
    ].join("::"), status);
  }
  const root = path.resolve(sessionsRoot);
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const session = await readJsonOrNull(path.join(root, entry.name, "session.json"));
    if (
      session?.executionPerformed !== true
      || session?.sessionStatus !== "completed_safe"
      || session?.evidenceInvalidated === true
    ) continue;
    let submissions = Array.isArray(session.selectedSubmissions) ? session.selectedSubmissions : [];
    if (!submissions.length && session.artifacts?.precisionSummary) {
      const precision = await readJsonOrNull(path.resolve(session.artifacts.precisionSummary));
      submissions = Array.isArray(precision?.selectedSubmissions) ? precision.selectedSubmissions : [];
    }
    const selection = session.artifacts?.selectionJson
      ? await readJsonOrNull(path.resolve(session.artifacts.selectionJson))
      : null;
    const candidatePaths = [
      ...(selection?.knownUsableRows || []),
      ...(selection?.knownWrongRows || []),
      ...(selection?.rows || []),
    ].map((row) => String(row?.candidateRowsPath || "").trim()).filter(Boolean);
    if (!submissions.length || !candidatePaths.length) continue;
    const artifact = await readJsonOrNull(path.resolve(candidatePaths[0]));
    const submission = submissions[0];
    for (const candidate of Array.isArray(artifact?.candidateRows) ? artifact.candidateRows : []) {
      const key = [submission.scoreId, submission.recordingId, candidate.candidateId].join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...candidate,
        scoreId: submission.scoreId,
        recordingId: submission.recordingId,
        piece: submission.piece,
        teacherCandidateStatus: labels.get(key) || "",
      });
    }
  }
  return rows;
}

export function evaluateControlledPilotEvidence({
  predictionRows,
  operationalCandidateRows = [],
  runtimeScopeSmoke = null,
  release,
  projectStatus,
}) {
  const excludedRecordingIds = releaseExcludedRecordingIds(release);
  const scoredRows = predictionRows
    .map((row) => ({
      ...row,
      teacherCandidateStatus: labelStatus(row),
      probabilityUsable: finiteNumber(row.probabilityUsable),
    }))
    .filter((row) => row.teacherCandidateStatus && row.probabilityUsable !== null)
    .filter((row) => !excludedRecordingIds.has(String(row.recordingId || "").trim()));
  const releaseThreshold = finiteNumber(release.threshold) ?? 0.8;
  const thresholds = [...new Set([
    0.5, 0.6, 0.7, 0.75, releaseThreshold, 0.85, 0.9, 0.95, 0.98, 0.99,
  ])].sort((left, right) => left - right);
  const sweep = thresholds.map((threshold) => summarizeSelection(scoredRows, threshold));
  const releaseOperatingPoint = sweep.find((item) => item.threshold === releaseThreshold)
    || summarizeSelection(scoredRows, releaseThreshold);
  const historicalMachineGatePassed = releaseOperatingPoint.selected >= MIN_SELECTED
    && releaseOperatingPoint.precision !== null
    && releaseOperatingPoint.precision >= MIN_PRECISION
    && releaseOperatingPoint.coverage >= MIN_COVERAGE
    && releaseOperatingPoint.distinctRecordingCount >= 2;
  const operationalPilot = projectStatus?.controlledPilotEvidence || {};
  const operationalGate = operationalPilot.v2AlphaGate || {};
  const operationalMachineGatePassed = operationalGate.ready === true;
  const operationalThresholds = [...new Set([
    ...thresholds,
    ...operationalCandidateRows
      .map((row) => finiteNumber(row.confidenceProbability))
      .filter((value) => value !== null),
  ])].sort((left, right) => left - right);
  const jointThresholdSweep = operationalThresholds.map((threshold) => {
    const historical = summarizeSelection(scoredRows, threshold);
    const operational = summarizeOperationalSelection(operationalCandidateRows, threshold);
    const meetsJointFloor = historical.selected >= MIN_SELECTED
      && historical.precision !== null
      && historical.precision >= MIN_PRECISION
      && historical.coverage >= MIN_COVERAGE
      && operational.coverage >= MIN_COVERAGE
      && operational.knownSelected >= 5
      && operational.knownPrecision !== null
      && operational.knownPrecision >= MIN_PRECISION;
    return { threshold, historical, operational, meetsJointFloor };
  });
  const jointThresholdCandidates = jointThresholdSweep
    .filter((item) => item.meetsJointFloor)
    .sort((left, right) => (
      right.operational.coverage - left.operational.coverage
      || right.historical.precision - left.historical.precision
    ));
  const historicalScopeRows = scoredRows.filter(
    (row) => Number(row.measureIndex) <= SAFE_SCOPE_MAX_MEASURE_INDEX,
  );
  const operationalScopeRows = operationalCandidateRows.filter(
    (row) => Number(row.measureIndex) <= SAFE_SCOPE_MAX_MEASURE_INDEX,
  );
  const historicalScope = summarizeSelection(historicalScopeRows, SAFE_SCOPE_MIN_CONFIDENCE);
  const operationalScope = summarizeOperationalSelection(
    operationalScopeRows,
    SAFE_SCOPE_MIN_CONFIDENCE,
  );
  const scopedMachineGatePassed = historicalScope.selected >= MIN_SELECTED
    && historicalScope.precision !== null
    && historicalScope.precision >= MIN_PRECISION
    && historicalScope.coverage >= MIN_COVERAGE
    && historicalScope.distinctRecordingCount >= 2
    && operationalScope.knownSelected >= 5
    && operationalScope.knownPrecision !== null
    && operationalScope.knownPrecision >= MIN_PRECISION
    && operationalScope.coverage >= MIN_COVERAGE;
  const releaseScope = release?.runtimePolicy?.controlledPilotScope || {};
  const runtimeScopeWired = releaseScope.scopeName === "first-measure-only"
    && Number(releaseScope.maxMeasureIndex) === SAFE_SCOPE_MAX_MEASURE_INDEX
    && Number(releaseScope.minConfidence) === SAFE_SCOPE_MIN_CONFIDENCE
    && runtimeScopeSmoke?.ok === true
    && runtimeScopeSmoke?.defaultOrdinaryReadyAfter === false
    && runtimeScopeSmoke?.batchItem?.candidateGate?.controlledPilotScope?.scopeName === "first-measure-only";
  const enoughOperationalRecordingsForProfessionalAudit = Number(
    operationalPilot.safeDistinctRecordingCount || 0,
  ) >= MIN_OPERATIONAL_RECORDINGS_BEFORE_PROFESSIONAL_AUDIT;
  const scopedTeacherReviewAllowed = scopedMachineGatePassed
    && runtimeScopeWired
    && enoughOperationalRecordingsForProfessionalAudit;
  const teacherReviewAllowed = (historicalMachineGatePassed && operationalMachineGatePassed)
    || scopedTeacherReviewAllowed;
  const blockingReasons = [];
  if (!historicalMachineGatePassed) blockingReasons.push("historical-loro-release-point-below-floor");
  if (operationalGate.meetsPrecisionFloor !== true) blockingReasons.push("controlled-pilot-precision-below-floor");
  if (operationalGate.meetsCoverageFloor !== true) blockingReasons.push("controlled-pilot-coverage-below-floor");
  if (operationalGate.hasCrossPieceEvidence !== true) blockingReasons.push("controlled-pilot-cross-piece-evidence-missing");
  if (operationalCandidateRows.length > 0 && jointThresholdCandidates.length === 0) {
    blockingReasons.push("no-simple-confidence-threshold-meets-joint-floor");
  }
  if (scopedMachineGatePassed && !runtimeScopeWired) blockingReasons.push("scoped-runtime-wiring-not-verified");
  if (scopedMachineGatePassed && !enoughOperationalRecordingsForProfessionalAudit) {
    blockingReasons.push("scoped-pilot-independent-recordings-below-floor");
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    policy: {
      minPrecision: MIN_PRECISION,
      minCoverage: MIN_COVERAGE,
      minSelected: MIN_SELECTED,
      teacherReviewAllowedOnlyAfterMachineGate: true,
    },
    excludedKnownBadRecordingIds: [...excludedRecordingIds].sort(),
    historicalLoro: {
      scoredRows: scoredRows.length,
      releaseThreshold,
      releaseOperatingPoint,
      thresholdSweep: sweep,
      machineGatePassed: historicalMachineGatePassed,
      note: "Leave-one-recording-out evidence only; it is not a substitute for a final blind professional audit.",
    },
    operationalPilot: {
      completedSafeSessionCount: Number(operationalPilot.completedSafeSessionCount || 0),
      safeDistinctRecordingCount: Number(operationalPilot.safeDistinctRecordingCount || 0),
      safeDistinctPieceCount: Number(operationalPilot.safeDistinctPieceCount || 0),
      totalCandidateCount: Number(operationalPilot.totalCandidateCount || 0),
      modelAutoPassCandidateCount: Number(operationalPilot.modelAutoPassCandidateCount || 0),
      pilotEligibleAutoPassCandidateCount: Number(operationalPilot.pilotEligibleAutoPassCandidateCount || 0),
      suppressedModelAutoPassCandidateCount: Number(operationalPilot.suppressedModelAutoPassCandidateCount || 0),
      precision: operationalGate.precision ?? null,
      coverage: Number(operationalGate.coverage || 0),
      machineGatePassed: operationalMachineGatePassed,
    },
    thresholdDiagnostic: {
      operationalCandidateRows: operationalCandidateRows.length,
      operationalKnownLabelRows: operationalCandidateRows.filter(
        (row) => ["usable", "wrong"].includes(row.teacherCandidateStatus),
      ).length,
      simpleThresholdCandidateFound: jointThresholdCandidates.length > 0,
      bestCandidate: jointThresholdCandidates[0] || null,
      fixedThresholdSweep: thresholds.map((threshold) => {
        const historical = summarizeSelection(scoredRows, threshold);
        const operational = summarizeOperationalSelection(operationalCandidateRows, threshold);
        return { threshold, historical, operational };
      }),
      conclusion: jointThresholdCandidates.length > 0
        ? "simple-confidence-threshold-candidate-found-eval-only"
        : "threshold-tuning-alone-cannot-meet-precision-and-coverage-floors",
    },
    scopedV2AlphaCandidate: {
      scopeName: "first-measure-only",
      maxMeasureIndex: SAFE_SCOPE_MAX_MEASURE_INDEX,
      minConfidence: SAFE_SCOPE_MIN_CONFIDENCE,
      historical: {
        scopeRows: historicalScopeRows.length,
        ...historicalScope,
      },
      operational: {
        scopeRows: operationalScopeRows.length,
        ...operationalScope,
      },
      machineGatePassed: scopedMachineGatePassed,
      runtimeScopeWired,
      minOperationalRecordingsForProfessionalAudit: MIN_OPERATIONAL_RECORDINGS_BEFORE_PROFESSIONAL_AUDIT,
      operationalRecordingCount: Number(operationalPilot.safeDistinctRecordingCount || 0),
      enoughOperationalRecordingsForProfessionalAudit,
      teacherReviewAllowed: scopedTeacherReviewAllowed,
      nextAction: scopedMachineGatePassed && !runtimeScopeWired
        ? "Wire the first-measure-only scope behind the controlled-pilot flag, rerun runtime smoke, and keep teacher review blocked until the scoped runtime audit passes."
        : scopedMachineGatePassed && !enoughOperationalRecordingsForProfessionalAudit
          ? "Run additional independent machine-only controlled pilots inside the first-measure scope. Do not request professional review before five recordings pass."
          : scopedMachineGatePassed
            ? "The scoped machine gate is ready for one small fresh blind professional audit."
        : "Do not wire a scoped runtime gate; improve candidate/localization evidence first.",
    },
    machinePreflightPassed: (historicalMachineGatePassed && operationalMachineGatePassed)
      || scopedTeacherReviewAllowed,
    teacherReviewAllowed,
    blockingReasons,
    nextAction: teacherReviewAllowed
      ? "Generate one small fresh blind professional audit pack; do not reuse training or pilot labels."
      : scopedMachineGatePassed
        ? runtimeScopeWired && !enoughOperationalRecordingsForProfessionalAudit
          ? "Do not request teacher review yet. Expand the machine-only first-measure pilot to five independent recordings; later measures remain review_required."
          : "Do not request teacher review yet. Wire and machine-test the first-measure-only V2-alpha scope; later measures remain review_required."
      : jointThresholdCandidates.length > 0
        ? "Do not request teacher review yet. Validate the eval-only threshold candidate on machine gold before any fresh blind professional audit."
        : "Do not request teacher review. Threshold tuning alone is insufficient; keep default runtime fail-closed and improve candidate/localization evidence.",
  };
}

function percent(value) {
  return value === null || value === undefined ? "n/a" : `${(Number(value) * 100).toFixed(2)}%`;
}

function renderMarkdown(report) {
  const historical = report.historicalLoro.releaseOperatingPoint;
  const operational = report.operationalPilot;
  return [
    "# Western Strings Controlled Pilot Evidence Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- machinePreflightPassed: ${report.machinePreflightPassed}`,
    `- teacherReviewAllowed: ${report.teacherReviewAllowed}`,
    `- nextAction: ${report.nextAction}`,
    "",
    "## Historical Leave-One-Recording-Out",
    "",
    `- release threshold: ${historical.threshold}`,
    `- selected: ${historical.selected}/${report.historicalLoro.scoredRows}`,
    `- precision: ${percent(historical.precision)}`,
    `- coverage: ${percent(historical.coverage)}`,
    `- wrong selected: ${historical.wrong}`,
    "",
    "## Operational Controlled Pilot",
    "",
    `- safe sessions: ${operational.completedSafeSessionCount}`,
    `- independent recordings/pieces: ${operational.safeDistinctRecordingCount}/${operational.safeDistinctPieceCount}`,
    `- model raw auto-pass: ${operational.modelAutoPassCandidateCount}`,
    `- strict self-check eligible: ${operational.pilotEligibleAutoPassCandidateCount}`,
    `- suppressed raw auto-pass: ${operational.suppressedModelAutoPassCandidateCount}`,
    `- precision: ${percent(operational.precision)}`,
    `- effective coverage: ${percent(operational.coverage)}`,
    `- simple threshold candidate found: ${report.thresholdDiagnostic.simpleThresholdCandidateFound}`,
    `- threshold conclusion: ${report.thresholdDiagnostic.conclusion}`,
    "",
    "## Scoped V2-Alpha Candidate",
    "",
    `- scope: ${report.scopedV2AlphaCandidate.scopeName}`,
    `- strict confidence: ${report.scopedV2AlphaCandidate.minConfidence}`,
    `- historical precision/coverage: ${percent(report.scopedV2AlphaCandidate.historical.precision)} / ${percent(report.scopedV2AlphaCandidate.historical.coverage)}`,
    `- operational precision/coverage: ${percent(report.scopedV2AlphaCandidate.operational.knownPrecision)} / ${percent(report.scopedV2AlphaCandidate.operational.coverage)}`,
    `- machineGatePassed: ${report.scopedV2AlphaCandidate.machineGatePassed}`,
    `- runtimeScopeWired: ${report.scopedV2AlphaCandidate.runtimeScopeWired}`,
    `- operational recordings: ${report.scopedV2AlphaCandidate.operationalRecordingCount}/${report.scopedV2AlphaCandidate.minOperationalRecordingsForProfessionalAudit}`,
    `- teacherReviewAllowed: ${report.scopedV2AlphaCandidate.teacherReviewAllowed}`,
    "",
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "## Policy",
    "",
    "- Machine tests run before any professional review request.",
    "- Rows not passing strict self-check remain review_required and are never shown as automatic student feedback.",
    "- Professional review is a final small blind audit, not a substitute for debugging candidate generation.",
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const predictionRows = parseCsv(await fs.readFile(path.resolve(args.predictions), "utf8"));
  const release = JSON.parse(await fs.readFile(path.resolve(args.release), "utf8"));
  const projectStatus = await buildProjectStatus();
  const runtimeScopeSmoke = await readJsonOrNull(path.resolve(args.scopeSmoke));
  const operationalCandidateRows = await loadOperationalCandidateRows({
    sessionsRoot: args.sessionsRoot,
    knownLabels: args.knownLabels,
  });
  const report = evaluateControlledPilotEvidence({
    predictionRows,
    operationalCandidateRows,
    runtimeScopeSmoke,
    release,
    projectStatus,
  });
  const out = path.resolve(args.out);
  const markdown = path.resolve(args.markdown);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(path.dirname(markdown), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdown, renderMarkdown(report), "utf8");
  console.log(JSON.stringify({
    ok: report.ok,
    machinePreflightPassed: report.machinePreflightPassed,
    teacherReviewAllowed: report.teacherReviewAllowed,
    historicalLoro: report.historicalLoro.releaseOperatingPoint,
    operationalPilot: report.operationalPilot,
    thresholdDiagnostic: {
      operationalCandidateRows: report.thresholdDiagnostic.operationalCandidateRows,
      operationalKnownLabelRows: report.thresholdDiagnostic.operationalKnownLabelRows,
      simpleThresholdCandidateFound: report.thresholdDiagnostic.simpleThresholdCandidateFound,
      conclusion: report.thresholdDiagnostic.conclusion,
    },
    scopedV2AlphaCandidate: report.scopedV2AlphaCandidate,
    blockingReasons: report.blockingReasons,
    out: path.relative(process.cwd(), out).replace(/\\/g, "/"),
    markdown: path.relative(process.cwd(), markdown).replace(/\\/g, "/"),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
