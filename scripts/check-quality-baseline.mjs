import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT, buildQualitySnapshot, compareQualitySnapshot } from "./quality-baseline-support.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const baselinePath = path.resolve(REPO_ROOT, readArg("--baseline", "docs/quality-baseline.json"));
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const current = buildQualitySnapshot({ repoRoot: REPO_ROOT });
const latencyTolerance = Number(process.env.ERHU_QUALITY_LATENCY_TOLERANCE || "1.1");
const result = compareQualitySnapshot(current, baseline, { latencyTolerance });

const payload = {
  ok: result.ok,
  baselinePath,
  failures: result.failures,
  skipped: result.skipped,
  baseline: {
    validation: baseline.validation,
    performance: baseline.performance,
  },
  current: {
    validation: current.validation,
    performance: current.performance,
  },
};

if (!result.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
