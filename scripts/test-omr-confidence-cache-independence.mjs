// Regression guard: OMR pagewise confidence must depend only on OMR quality
// (coverage, tile pressure, workers), never on cache hit rates. Cache hits are a
// re-import performance property; letting them raise confidence made the same PDF
// score higher on a warm re-import than on the cold first import and cross the
// low-confidence gate. This checks both the JS (calibrateOmrConfidence) and the
// Python (_estimate_pagewise_omr_confidence) implementations and that they agree,
// so the two cannot silently drift apart.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calibrateOmrConfidence } from "../src/server/omrStats.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Identical OMR outcome (same pages, coverage, tiling, workers); only cache differs.
const base = { mode: "pagewise", pageCount: 11, resultCount: 9, tileOmrRuns: 0, workers: 1 };
const cold = { ...base, pageResultCacheHitRate: 0, renderCacheHitRate: 0 };
const warm = { ...base, pageResultCacheHitRate: 1, renderCacheHitRate: 1 };

const failures = [];

// rawConfidence 0 so the returned value is the calibrated quality score itself.
const jsCold = calibrateOmrConfidence(0, cold);
const jsWarm = calibrateOmrConfidence(0, warm);
if (jsCold !== jsWarm) {
  failures.push(`JS confidence depends on cache: cold=${jsCold} warm=${jsWarm}`);
}

// A persisted record may carry an old warm-cache-inflated confidence as base.
// Recalibration with cold stats must return the cold quality score, not the
// stale high base -- otherwise pollution survives forever via Math.max.
const jsPollutedBase = calibrateOmrConfidence(0.9, cold);
if (jsPollutedBase !== jsCold) {
  failures.push(`stale high base survives recalibration: polluted=${jsPollutedBase} cold=${jsCold}`);
}

// Python side, through the analyzer's own method, using the venv interpreter.
const pyExe = path.join(repoRoot, "python-service", ".venv", "Scripts", "python.exe");
const pySnippet = `
import json, sys
sys.path.insert(0, r"${path.join(repoRoot, "python-service")}")
from analyzer import ErhuAnalyzer
from config import Settings
az = ErhuAnalyzer(Settings())
base = {"pageCount": 11, "resultCount": 9, "tileOmrRuns": 0, "workers": 1}
cold = {**base, "pageResultCacheHitRate": 0.0, "renderCacheHitRate": 0.0}
warm = {**base, "pageResultCacheHitRate": 1.0, "renderCacheHitRate": 1.0}
c = az._estimate_pagewise_omr_confidence(cold, 9)
w = az._estimate_pagewise_omr_confidence(warm, 9)
print("PYRESULT " + json.dumps({"cold": c, "warm": w}))
`;
const py = spawnSync(pyExe, ["-c", pySnippet], { encoding: "utf8", cwd: repoRoot });
if (py.status !== 0) {
  failures.push(`Python check failed to run: ${py.stderr || py.error || "unknown"}`);
} else {
  const line = (py.stdout || "").split("\n").find((l) => l.startsWith("PYRESULT "));
  if (!line) {
    failures.push(`Python check produced no result. stdout=${py.stdout}`);
  } else {
    const { cold: pyCold, warm: pyWarm } = JSON.parse(line.slice("PYRESULT ".length));
    if (pyCold !== pyWarm) {
      failures.push(`Python confidence depends on cache: cold=${pyCold} warm=${pyWarm}`);
    }
    // The JS calibrated score and the Python score must also agree (same formula).
    if (Math.abs(pyCold - jsCold) > 1e-6) {
      failures.push(`JS and Python confidence disagree: js=${jsCold} py=${pyCold}`);
    }
  }
}

const report = { ok: failures.length === 0, jsCold, jsWarm, failures };
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
