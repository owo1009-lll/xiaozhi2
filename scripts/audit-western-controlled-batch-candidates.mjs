import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return {
            _invalidJsonLine: index + 1,
            _error: String(error?.message || error),
          };
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function pushFailure(failures, code, details = {}) {
  failures.push({ code, ...details });
}

export function auditFeatureReviewItem(item = {}, { runIndex = 0, itemIndex = 0, sourceRoot = "" } = {}) {
  const failures = [];
  const summary = item.analysisSummary || {};
  const candidates = Array.isArray(item.candidatePreview) ? item.candidatePreview : [];
  const candidateRowCount = asNumber(item.candidateRowCount, 0);
  const candidateGate = item.candidateGate || {};
  const candidateRowsPath = safeString(item.candidateRowsPath);

  if (item.autoDiagnosisIssued !== false) {
    pushFailure(failures, "feature-review-issued-auto-diagnosis", { runIndex, itemIndex });
  }
  if (!candidateGate || typeof candidateGate !== "object" || Array.isArray(candidateGate)) {
    pushFailure(failures, "feature-review-candidate-gate-missing", { runIndex, itemIndex });
  } else {
    if (candidateGate.ready !== false) {
      pushFailure(failures, "feature-review-candidate-gate-ready-not-false", {
        runIndex,
        itemIndex,
        ready: candidateGate.ready,
      });
    }
    if (asNumber(candidateGate.autoPassCandidateCount, 0) !== 0) {
      pushFailure(failures, "feature-review-candidate-gate-auto-pass-nonzero", {
        runIndex,
        itemIndex,
        autoPassCandidateCount: candidateGate.autoPassCandidateCount,
      });
    }
    if (asNumber(candidateGate.evaluatedCandidateCount, 0) !== candidateRowCount) {
      pushFailure(failures, "feature-review-candidate-gate-count-mismatch", {
        runIndex,
        itemIndex,
        evaluatedCandidateCount: candidateGate.evaluatedCandidateCount,
        candidateRowCount,
      });
    }
    if (!safeString(candidateGate.gateVersion)) {
      pushFailure(failures, "feature-review-candidate-gate-version-missing", { runIndex, itemIndex });
    }
    if (!safeString(candidateGate.reason)) {
      pushFailure(failures, "feature-review-candidate-gate-reason-missing", { runIndex, itemIndex });
    }
  }
  if (asNumber(summary.autoPassCount, 0) !== 0) {
    pushFailure(failures, "feature-review-summary-auto-pass-nonzero", {
      runIndex,
      itemIndex,
      autoPassCount: summary.autoPassCount,
    });
  }
  if (summary.studentFacing === true) {
    pushFailure(failures, "feature-review-summary-student-facing", { runIndex, itemIndex });
  }
  if (summary.studentSafeGateReady === true) {
    pushFailure(failures, "feature-review-summary-student-gate-ready", { runIndex, itemIndex });
  }
  if (candidateRowCount <= 0) {
    pushFailure(failures, "feature-review-candidate-rows-missing", { runIndex, itemIndex });
  }
  if (!candidateRowsPath) {
    pushFailure(failures, "feature-review-candidate-rows-path-missing", { runIndex, itemIndex });
  } else if (sourceRoot) {
    const artifactPath = path.resolve(sourceRoot, candidateRowsPath);
    if (!fsSync.existsSync(artifactPath)) {
      pushFailure(failures, "feature-review-candidate-rows-artifact-missing", {
        runIndex,
        itemIndex,
        candidateRowsPath,
      });
    } else {
      try {
        const artifact = JSON.parse(fsSync.readFileSync(artifactPath, "utf8"));
        const rows = Array.isArray(artifact.candidateRows) ? artifact.candidateRows : [];
        if (asNumber(artifact.rowCount, -1) !== candidateRowCount || rows.length !== candidateRowCount) {
          pushFailure(failures, "feature-review-candidate-rows-artifact-count-mismatch", {
            runIndex,
            itemIndex,
            candidateRowsPath,
            artifactRowCount: artifact.rowCount,
            artifactRowsLength: rows.length,
            candidateRowCount,
          });
        }
      } catch (error) {
        pushFailure(failures, "feature-review-candidate-rows-artifact-invalid", {
          runIndex,
          itemIndex,
          candidateRowsPath,
          error: String(error?.message || error),
        });
      }
    }
  }
  if (!candidates.length) {
    pushFailure(failures, "feature-review-candidate-preview-missing", { runIndex, itemIndex });
  }
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (safeString(candidate.autoDecision) !== "review_required") {
      pushFailure(failures, "feature-review-candidate-not-review-required", {
        runIndex,
        itemIndex,
        candidateIndex,
        autoDecision: candidate.autoDecision,
      });
    }
    if (candidate.studentSafeGateReady !== false) {
      pushFailure(failures, "feature-review-candidate-student-gate-not-false", {
        runIndex,
        itemIndex,
        candidateIndex,
        studentSafeGateReady: candidate.studentSafeGateReady,
      });
    }
    if (candidate.studentFacing !== false) {
      pushFailure(failures, "feature-review-candidate-student-facing-not-false", {
        runIndex,
        itemIndex,
        candidateIndex,
        studentFacing: candidate.studentFacing,
      });
    }
    if (safeString(candidate.gateDecision) !== "review_required") {
      pushFailure(failures, "feature-review-candidate-gate-decision-not-review", {
        runIndex,
        itemIndex,
        candidateIndex,
        gateDecision: candidate.gateDecision,
      });
    }
    if (!safeString(candidate.gateVersion)) {
      pushFailure(failures, "feature-review-candidate-gate-version-missing", {
        runIndex,
        itemIndex,
        candidateIndex,
      });
    }
    if (!safeString(candidate.gateReason)) {
      pushFailure(failures, "feature-review-candidate-gate-reason-missing", {
        runIndex,
        itemIndex,
        candidateIndex,
      });
    }
  }

  return failures;
}

function selectBatchRunsForAudit(runs = [], { latestOnly = false } = {}) {
  const validRuns = runs.filter((run) => !run?._invalidJsonLine);
  if (!latestOnly) return runs;
  if (!validRuns.length) return runs;
  return [validRuns[validRuns.length - 1]];
}

export function auditControlledBatchRuns(runs = [], { requireFeatureReview = false, sourceRoot = "", latestOnly = false } = {}) {
  const failures = [];
  let runCount = 0;
  let featureReviewItemCount = 0;
  let candidateRowCount = 0;

  const selectedRuns = selectBatchRunsForAudit(runs, { latestOnly });
  const selectedRunIds = [];
  for (const [runIndex, run] of selectedRuns.entries()) {
    if (run?._invalidJsonLine) {
      pushFailure(failures, "invalid-jsonl-line", { runIndex, line: run._invalidJsonLine, error: run._error });
      continue;
    }
    runCount += 1;
    if (safeString(run.batchRunId)) selectedRunIds.push(safeString(run.batchRunId));
    if (run.autoDiagnosisIssued !== false && Array.isArray(run.items) && run.items.length) {
      pushFailure(failures, "batch-run-issued-auto-diagnosis", { runIndex });
    }
    for (const [itemIndex, item] of (Array.isArray(run.items) ? run.items : []).entries()) {
      if (item.analysisStatus !== "offline_feature_review_ready") continue;
      featureReviewItemCount += 1;
      candidateRowCount += asNumber(item.candidateRowCount, 0);
      failures.push(...auditFeatureReviewItem(item, { runIndex, itemIndex, sourceRoot }));
    }
  }

  if (requireFeatureReview && featureReviewItemCount === 0) {
    pushFailure(failures, "no-feature-review-items-found");
  }

  return {
    ok: failures.length === 0,
    runCount,
    auditedRunMode: latestOnly ? "latest" : "all",
    auditedBatchRunIds: selectedRunIds,
    featureReviewItemCount,
    candidateRowCount,
    failures,
  };
}

function parseArgs(argv) {
  const args = {
    source: path.join("data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"),
    out: "",
    requireFeatureReview: false,
    allRuns: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") args.source = argv[++index] || args.source;
    else if (arg === "--out") args.out = argv[++index] || "";
    else if (arg === "--require-feature-review") args.requireFeatureReview = true;
    else if (arg === "--all-runs") args.allRuns = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = path.resolve(process.cwd(), args.source);
  const report = auditControlledBatchRuns(await readJsonl(source), {
    requireFeatureReview: args.requireFeatureReview,
    sourceRoot: process.cwd(),
    latestOnly: !args.allRuns,
  });
  report.source = path.relative(process.cwd(), source).replace(/\\/g, "/");
  if (args.out) {
    const out = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
