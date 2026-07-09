import { pathToFileURL } from "node:url";

import { buildProjectStatus, writeProjectStatus } from "./status-western-strings-project.mjs";

function parseArgs(argv) {
  const args = {
    out: "data/experiments/western-strings-project-gate.json",
    require: new Set(["ordinary", "m3plus", "m4"]),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--require") {
      args.require = new Set(String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return args;
}

export function evaluateProjectGate(status, requiredTracks) {
  const failures = [];
  const controlled = status.tracks?.controlledCandidate || {};
  const m3plus = status.tracks?.m3plusPitchModes || {};
  const m4 = status.tracks?.m4Omr || {};

  if (requiredTracks.has("ordinary") && !controlled.studentSafeCandidateGateReady) {
    failures.push({
      track: "M2/M3 ordinary upload candidate gate",
      reason: controlled.blockingReasons || ["ordinary-upload-gate-not-ready"],
      artifact: controlled.confidencePilot?.thresholdPoolReviewPage || controlled.reviewArtifacts?.thresholdPoolReviewPage || controlled.confidencePilot?.validationReviewPage || controlled.reviewArtifacts?.reviewPage || "",
    });
  }
  if (requiredTracks.has("m3plus") && !m3plus.m3plusModeReleaseReady) {
    failures.push({
      track: "M3+ pitch behavior modes",
      reason: m3plus.blockingReasons || ["m3plus-gate-not-ready"],
      artifact: m3plus.reviewArtifacts?.modeEvalJson || m3plus.reviewArtifacts?.reviewPage || "",
    });
  }
  if (requiredTracks.has("m4") && !m4.m4OmrDraftQualityReady) {
    failures.push({
      track: "M4 OMR benchmark",
      reason: m4.blockingReasons || ["m4-omr-gate-not-ready"],
      artifact: m4.artifacts?.independentGoldTodo || "",
    });
  }

  return {
    projectReleaseReady: failures.length === 0,
    requiredTracks: [...requiredTracks],
    failures,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await buildProjectStatus();
  const gate = evaluateProjectGate(status, args.require);
  const report = {
    ...status,
    projectGate: gate,
  };
  const outPath = await writeProjectStatus(report, args.out);
  console.log(JSON.stringify({
    ok: true,
    projectReleaseReady: gate.projectReleaseReady,
    requiredTracks: gate.requiredTracks,
    failures: gate.failures,
    out: outPath.replace(process.cwd(), ".").replace(/\\/g, "/"),
  }, null, 2));
  if (!gate.projectReleaseReady) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
