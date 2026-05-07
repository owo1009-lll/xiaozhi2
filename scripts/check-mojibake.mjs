import fs from "node:fs";
import { execFileSync } from "node:child_process";

const MOJIBAKE_PATTERNS = [
  "\u6d5c\u5c83",
  "\u95bd\u3222",
  "\u95b6\u80a9",
  "\u6d7c\u6751",
  "\u5997\u51ad",
  "\u9367\u7008",
];

const TEXT_FILE_RE = /\.(?:js|jsx|mjs|ts|tsx|py|md|json|html|css|ps1|bat|cmd|txt|webmanifest)$/i;
const CJK_RE = /[\u3400-\u9fff]/;
const CODING_COOKIE_RE = /coding[:=]\s*utf-8/i;

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" }).toString("utf8");
  return output.split("\0").filter(Boolean);
}

function lineForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

const failures = [];

for (const filePath of trackedFiles()) {
  if (!TEXT_FILE_RE.test(filePath)) continue;
  const text = fs.readFileSync(filePath, "utf8");
  for (const pattern of MOJIBAKE_PATTERNS) {
    const index = text.indexOf(pattern);
    if (index >= 0) {
      failures.push({
        path: filePath,
        line: lineForIndex(text, index),
        reason: `Possible mojibake pattern ${JSON.stringify(pattern)} found.`,
      });
    }
  }

  if (filePath.endsWith(".py") && CJK_RE.test(text)) {
    const firstTwoLines = text.split(/\r?\n/).slice(0, 2).join("\n");
    if (!CODING_COOKIE_RE.test(firstTwoLines)) {
      failures.push({
        path: filePath,
        line: 1,
        reason: "Python file contains CJK text but lacks a UTF-8 coding cookie in the first two lines.",
      });
    }
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checked: trackedFiles().length, mojibakePatterns: MOJIBAKE_PATTERNS }, null, 2));
