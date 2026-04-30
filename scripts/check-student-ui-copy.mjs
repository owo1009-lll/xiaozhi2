import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSourceLabel } from "../src/analysisLabels.js";

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
    pattern: /set(?:Error|ErrorMessage)\([^;\n]*(?:error|err)\.message\s*\|\|/g,
    reason: "Student error setters must not expose raw error.message.",
  },
  {
    pattern: /set(?:Error|ErrorMessage)\([^;\n]*(?:job|nextJob|scoreJob|analysisJob|piecePassJob)\??\.error\s*\|\|/g,
    reason: "Student error setters must not expose raw job.error.",
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

const staleStudentCopyPatterns = [
  {
    pattern: /已沿用上次识谱结果|同一份 PDF 已完成过识谱|识谱排队中|分析排队中|整曲分析排队中|正在写入整曲/g,
    reason: "Student status copy should describe learner-visible progress instead of queue/cache/write mechanics.",
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

for (const relativePath of ["src/StudentApp.jsx", "src/ScoreIssuePage.jsx"]) {
  const absolutePath = path.join(repoRoot, relativePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  for (const { pattern, reason } of rawStudentErrorPatterns) {
    for (const match of text.matchAll(pattern)) {
      failures.push({
        path: relativePath,
        line: lineNumberForOffset(text, match.index || 0),
        reason,
      });
    }
  }
  for (const { pattern, reason } of staleStudentCopyPatterns) {
    for (const match of text.matchAll(pattern)) {
      failures.push({
        path: relativePath,
        line: lineNumberForOffset(text, match.index || 0),
        reason,
      });
    }
  }
}

const sourceLabelInputs = [
  "torchcrepe",
  "madmom-rnn-onset",
  "madmom-rnn-beat",
  "madmom-onset-beat-grid",
  "librosa-onset",
  "librosa-pyin",
  "score-fallback",
  "score-beat-fallback",
  "synthetic",
  "unexpected-internal-source",
  "",
];
for (const input of sourceLabelInputs) {
  const output = formatSourceLabel(input);
  if (/\b(torchcrepe|madmom|librosa|fallback|synthetic|unknown|internal)\b/i.test(output)) {
    failures.push({
      path: "src/analysisLabels.js",
      line: 1,
      reason: `formatSourceLabel(${JSON.stringify(input)}) exposes technical text: ${JSON.stringify(output)}.`,
    });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checkedFiles }, null, 2));
