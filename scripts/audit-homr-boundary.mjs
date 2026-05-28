import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const scoreImportSource = readText("python-service/analyzer_score_import.py");
const analyzerSource = readText("python-service/analyzer.py");
const runtimeSource = readText("python-service/analyzer_runtime.py");
const configSource = readText("python-service/config.py");

const homrExecutionPatterns = [
  /def\s+_run_homr\b/i,
  /\b_run_homr\s*\(/i,
  /subprocess\.(?:run|Popen)\s*\([^)]*homr/i,
  /homr_cli\s*,/i,
];

const scannedSources = {
  "python-service/analyzer_score_import.py": scoreImportSource,
  "python-service/analyzer.py": analyzerSource,
  "python-service/analyzer_runtime.py": runtimeSource,
};

const executionMatches = [];
for (const [relativePath, source] of Object.entries(scannedSources)) {
  for (const pattern of homrExecutionPatterns) {
    if (pattern.test(source)) {
      executionMatches.push({ file: relativePath, pattern: String(pattern) });
    }
  }
}

requireCondition(
  scoreImportSource.includes('"provider": "audiveris"') && scoreImportSource.includes('"role": "primary"'),
  "Audiveris must remain the primary OMR provider.",
);
requireCondition(
  scoreImportSource.includes('"provider": "homr"') && scoreImportSource.includes('"role": "secondary-candidate"'),
  "HOMR must remain a secondary diagnostic candidate.",
);
requireCondition(
  scoreImportSource.includes('"mainlineExecutable": False'),
  "HOMR must be explicitly marked as non-executable in the mainline.",
);
requireCondition(
  scoreImportSource.includes("_run_audiveris(pdf_path, output_dir)") &&
    scoreImportSource.includes("_run_audiveris_pagewise(pdf_path, output_dir / \"pagewise\")"),
  "PDF score import must still execute the Audiveris whole/pagewise path.",
);
requireCondition(configSource.includes("ERHU_HOMR_CLI"), "HOMR CLI setting should remain diagnostic-only configuration.");
requireCondition(runtimeSource.includes('"homr"'), "Dependency report should still expose HOMR availability.");
requireCondition(executionMatches.length === 0, `HOMR execution path found: ${JSON.stringify(executionMatches)}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      primaryProvider: "audiveris",
      homrRole: "secondary-candidate",
      homrExecutesInMainline: false,
      homrMainlineExecutable: false,
      checkedFiles: Object.keys(scannedSources),
    },
    null,
    2,
  ),
);
