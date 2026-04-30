import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checkedFiles = [
  "src/StudentApp.jsx",
  "src/ScoreIssuePage.jsx",
  "src/analysisLabels.js",
];

const mojibakeMarkers = [
  "\ufffd",
  "\u00c3",
  "\u00c2",
  "\u00e2\u20ac",
  "\u93c8",
  "\u951b",
  "\u9286",
  "\u95c7",
  "\u6fb6",
  "\u9359",
  "\u9410",
  "\u5997",
  "\u7ed7",
];

const rawStudentErrorPatterns = [
  {
    pattern: /setErrorMessage\([^;\n]*(?:error|err)\.message\s*\|\|/g,
    reason: "setErrorMessage must not expose raw error.message in the student UI.",
  },
  {
    pattern: /setErrorMessage\([^;\n]*(?:job|nextJob|scoreJob|analysisJob|piecePassJob)\??\.error\s*\|\|/g,
    reason: "setErrorMessage must not expose raw job.error in the student UI.",
  },
  {
    pattern: /\{[^}\n]*(?:job|nextJob|scoreJob|analysisJob|piecePassJob)\??\.error\s*\|\|[^}\n]*\}/g,
    reason: "Rendered JSX must not expose raw job.error in the student UI.",
  },
  {
    pattern: /return\s+(?:job|nextJob|scoreJob|analysisJob|piecePassJob)\??\.message\s*\|\|/g,
    reason: "Status helpers must sanitize job.message before rendering.",
  },
];

function lineNumberForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

const failures = [];

for (const relativePath of checkedFiles) {
  const absolutePath = path.join(repoRoot, relativePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  for (const marker of mojibakeMarkers) {
    const index = text.indexOf(marker);
    if (index >= 0) {
      failures.push({
        path: relativePath,
        line: lineNumberForOffset(text, index),
        reason: `Possible mojibake marker ${JSON.stringify(marker)} found.`,
      });
    }
  }
}

const studentAppPath = path.join(repoRoot, "src/StudentApp.jsx");
const studentAppText = fs.readFileSync(studentAppPath, "utf8");
if (!studentAppText.includes("function friendlyErrorMessage(")) {
  failures.push({
    path: "src/StudentApp.jsx",
    line: 1,
    reason: "Student UI must keep a friendlyErrorMessage guard.",
  });
}

for (const { pattern, reason } of rawStudentErrorPatterns) {
  for (const match of studentAppText.matchAll(pattern)) {
    failures.push({
      path: "src/StudentApp.jsx",
      line: lineNumberForOffset(studentAppText, match.index || 0),
      reason,
    });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checkedFiles }, null, 2));
