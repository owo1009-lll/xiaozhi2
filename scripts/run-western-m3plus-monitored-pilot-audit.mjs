import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m3plus", "monitored-pilot");
const DEFAULT_RESCOPE_GATE = path.join(
  "data",
  "experiments",
  "western-strings-m3plus",
  "rescope-gate",
  "report.json",
);

export const CONTRACT = "m3plus-rescope-four-zone-v1";
export const SUPERSEDED_CONTRACT = "first-measure-slide-trill-candidate-quality"
  + " (superseded by the 2026-07-17 M3+ rescope decision; audio technique-mode"
  + " detection is retired, not pending repair)";
export const RELEASE_ZONES = [
  "unmarkedStraight",
  "scoreMarkedNeutral",
  "techniqueCenter",
  "unstableFailClosed",
];
export const INHERITED_ZONES = { rhythmOnset: "inherits-m3-core-gate-unchanged" };

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    rescopeGate: DEFAULT_RESCOPE_GATE,
    minPrecision: 0.9,
    maxPitchToleranceCents: 50,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
    if (arg === "--rescope-gate") args.rescopeGate = argv[++index] || args.rescopeGate;
    if (arg === "--min-precision") args.minPrecision = Number(argv[++index] || args.minPrecision);
    if (arg === "--max-pitch-tolerance-cents") {
      args.maxPitchToleranceCents = Number(argv[++index] || args.maxPitchToleranceCents);
    }
  }
  return args;
}

function rel(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

async function readJson(filePath) {
  try {
    return { exists: true, value: JSON.parse(await fs.readFile(path.resolve(process.cwd(), filePath), "utf8")) };
  } catch {
    return { exists: false, value: null };
  }
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function evaluateRescopeContract(gate, options = {}) {
  const minPrecision = Number.isFinite(options.minPrecision) ? options.minPrecision : 0.9;
  const maxPitchToleranceCents = Number.isFinite(options.maxPitchToleranceCents)
    ? options.maxPitchToleranceCents
    : 50;
  const blockingReasons = [];
  const zones = {};

  if (!gate || typeof gate !== "object") {
    return {
      ready: false,
      zones,
      blockingReasons: ["m3plus-rescope-gate-missing"],
    };
  }

  if (gate.evalOnly !== true) blockingReasons.push("m3plus-rescope-gate-not-eval-only");
  if (gate.productionPolicyChanged !== false) {
    blockingReasons.push("m3plus-rescope-gate-production-policy-changed");
  }
  if (gate.studentGateReady !== false) blockingReasons.push("m3plus-rescope-student-gate-not-fail-closed");
  if (gate.studentFacing !== false) blockingReasons.push("m3plus-rescope-student-facing-not-false");
  if (gate.releaseGateReady !== true) blockingReasons.push("m3plus-rescope-release-gate-not-ready");
  for (const reason of gate.blockingReasons || []) {
    blockingReasons.push(`m3plus-rescope-gate-blocking:${reason}`);
  }

  const thresholds = gate.thresholds || {};
  const gateMinPrecision = finiteNumber(thresholds.minimumPrecision);
  const gateTolerance = finiteNumber(thresholds.pitchToleranceCents);
  if (gateMinPrecision === null || gateMinPrecision < minPrecision) {
    blockingReasons.push("m3plus-threshold-precision-below-floor");
  }
  if (gateTolerance === null || gateTolerance > maxPitchToleranceCents) {
    blockingReasons.push("m3plus-threshold-tolerance-above-ceiling");
  }
  if (thresholds.evaluationSplit !== "holdout-only") {
    blockingReasons.push("m3plus-evaluation-split-not-holdout-only");
  }

  const zone = (name) => (gate.zones || {})[name] || null;

  const straight = zone("unmarkedStraight");
  const straightPrecision = finiteNumber(straight?.precision);
  const straightFloor = finiteNumber(thresholds.minimumStraightDecisions) ?? 4;
  const straightReady = Boolean(
    straight
    && straight.gatePassed === true
    && straightPrecision !== null
    && straightPrecision >= minPrecision
    && straight.unsafeAccusationCount === 0
    && finiteNumber(straight.decisionCount) !== null
    && straight.decisionCount >= straightFloor,
  );
  if (!straightReady) blockingReasons.push("m3plus-zone-not-ready:unmarkedStraight");
  zones.unmarkedStraight = {
    ready: straightReady,
    gatePassed: straight?.gatePassed === true,
    decisionCount: finiteNumber(straight?.decisionCount),
    precision: straightPrecision,
    unsafeAccusationCount: finiteNumber(straight?.unsafeAccusationCount),
    insufficientEvidenceCount: finiteNumber(straight?.insufficientEvidenceCount),
    decisionCoverage: finiteNumber(straight?.decisionCoverage),
  };

  const neutral = zone("scoreMarkedNeutral");
  const neutralProtected = finiteNumber(neutral?.totalProtectedCount);
  const neutralReady = Boolean(
    neutral
    && neutral.gatePassed === true
    && neutral.accusationCount === 0
    && neutralProtected !== null
    && neutralProtected > 0
    && finiteNumber(neutral.insufficientEvidenceCount) === neutralProtected,
  );
  if (!neutralReady) blockingReasons.push("m3plus-zone-not-ready:scoreMarkedNeutral");
  zones.scoreMarkedNeutral = {
    ready: neutralReady,
    gatePassed: neutral?.gatePassed === true,
    totalProtectedCount: neutralProtected,
    accusationCount: finiteNumber(neutral?.accusationCount),
    insufficientEvidenceCount: finiteNumber(neutral?.insufficientEvidenceCount),
  };

  const center = zone("techniqueCenter");
  const centerPrecision = finiteNumber(center?.precision);
  const centerFloor = finiteNumber(thresholds.minimumTechniqueCenterDecisions) ?? 2;
  const centerReady = Boolean(
    center
    && center.gatePassed === true
    && centerPrecision !== null
    && centerPrecision >= minPrecision
    && center.unsafeAccusationCount === 0
    && finiteNumber(center.decisionCount) !== null
    && center.decisionCount >= centerFloor,
  );
  if (!centerReady) blockingReasons.push("m3plus-zone-not-ready:techniqueCenter");
  zones.techniqueCenter = {
    ready: centerReady,
    gatePassed: center?.gatePassed === true,
    decisionCount: finiteNumber(center?.decisionCount),
    precision: centerPrecision,
    unsafeAccusationCount: finiteNumber(center?.unsafeAccusationCount),
    insufficientEvidenceCount: finiteNumber(center?.insufficientEvidenceCount),
    decisionCoverage: finiteNumber(center?.decisionCoverage),
  };

  const unstable = zone("unstableFailClosed");
  const unstableTested = finiteNumber(unstable?.testedCount);
  const unstableReady = Boolean(
    unstable
    && unstable.gatePassed === true
    && unstable.accusationCount === 0
    && unstableTested !== null
    && unstableTested > 0
    && finiteNumber(unstable.insufficientEvidenceCount) === unstableTested,
  );
  if (!unstableReady) blockingReasons.push("m3plus-zone-not-ready:unstableFailClosed");
  zones.unstableFailClosed = {
    ready: unstableReady,
    gatePassed: unstable?.gatePassed === true,
    testedCount: unstableTested,
    accusationCount: finiteNumber(unstable?.accusationCount),
    insufficientEvidenceCount: finiteNumber(unstable?.insufficientEvidenceCount),
  };

  const rhythm = zone("rhythmOnset");
  if (rhythm && rhythm.gatePassed === false) {
    blockingReasons.push("m3plus-zone-regressed:rhythmOnset");
  }
  zones.rhythmOnset = {
    ready: !(rhythm && rhythm.gatePassed === false),
    inherited: INHERITED_ZONES.rhythmOnset,
    gatePassed: rhythm?.gatePassed ?? null,
  };

  const unique = [...new Set(blockingReasons)];
  return { ready: unique.length === 0, zones, blockingReasons: unique };
}

function renderMarkdown(report) {
  const zoneLines = Object.entries(report.zones).flatMap(([name, item]) => [
    `### ${name}`,
    "",
    ...Object.entries(item).map(([key, value]) => `- ${key}: ${value === null ? "n/a" : value}`),
    "",
  ]);
  return [
    "# M3+ Monitored Pilot Audit (rescope four-zone contract)",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Decision",
    "",
    `- ok: ${report.ok}`,
    `- readyForMonitoredPilot: ${report.readyForMonitoredPilot}`,
    `- teacherReviewNeeded: ${report.teacherReviewNeeded}`,
    `- defaultM3PlusReadyAfter: ${report.defaultM3PlusReadyAfter}`,
    "",
    "## Contract",
    "",
    `- contract: ${report.contract}`,
    `- supersedes: ${report.supersededContract}`,
    `- releaseZones: ${report.scope.releaseZones.join(", ")}`,
    `- inheritedZones: rhythmOnset (${report.scope.inheritedZones.rhythmOnset})`,
    `- minPrecision: ${report.scope.minPrecision}`,
    `- maxPitchToleranceCents: ${report.scope.maxPitchToleranceCents}`,
    "- Release evidence is the frozen holdout rescope-gate report; no audio",
    "  technique-mode classification is required or displayed.",
    "",
    "## Zones",
    "",
    ...zoneLines,
    "## Blocking Reasons",
    "",
    ...(report.blockingReasons.length ? report.blockingReasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "## Safety Notes",
    "",
    "- This audit does not enable the default student runtime.",
    "- Score-marked regions and unstable notes must stay insufficient_evidence.",
    "- Any accusation from a protected zone stops the pilot immediately.",
    "- Owner approval still runs through the existing explicit command chain.",
    "",
  ].join("\n");
}

export async function runM3PlusMonitoredPilotAudit(args = {}) {
  const options = { ...parseArgs([]), ...args };
  const outDir = path.resolve(process.cwd(), options.outDir);
  const gateRead = await readJson(options.rescopeGate);
  const contract = evaluateRescopeContract(gateRead.value, options);
  const blockingReasons = [...contract.blockingReasons];
  if (!gateRead.exists) {
    blockingReasons.unshift("m3plus-rescope-gate-report-missing");
  }

  const uniqueBlockingReasons = [...new Set(blockingReasons)];
  const report = {
    ok: uniqueBlockingReasons.length === 0,
    generatedAt: new Date().toISOString(),
    readyForMonitoredPilot: uniqueBlockingReasons.length === 0,
    teacherReviewNeeded: false,
    defaultM3PlusReadyAfter: false,
    contract: CONTRACT,
    supersededContract: SUPERSEDED_CONTRACT,
    scope: {
      releaseZones: RELEASE_ZONES,
      inheritedZones: INHERITED_ZONES,
      minPrecision: options.minPrecision,
      maxPitchToleranceCents: options.maxPitchToleranceCents,
      evaluationSplit: "holdout-only",
    },
    inputs: {
      rescopeGate: String(options.rescopeGate).replace(/\\/g, "/"),
      rescopeGateExists: gateRead.exists,
    },
    zones: contract.zones,
    releaseModes: {},
    blockedModes: [],
    blockingReasons: uniqueBlockingReasons,
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "m3plus-monitored-pilot-audit.json");
  const mdPath = path.join(outDir, "m3plus-monitored-pilot-audit.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(report), "utf8");
  return { report, jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { report, jsonPath, mdPath } = await runM3PlusMonitoredPilotAudit(args);
  console.log(JSON.stringify({
    ok: report.ok,
    readyForMonitoredPilot: report.readyForMonitoredPilot,
    teacherReviewNeeded: report.teacherReviewNeeded,
    defaultM3PlusReadyAfter: report.defaultM3PlusReadyAfter,
    contract: report.contract,
    zones: Object.fromEntries(Object.entries(report.zones).map(([name, item]) => [name, item.ready])),
    blockingReasons: report.blockingReasons,
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
