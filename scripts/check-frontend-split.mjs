import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainAppPath = path.join(repoRoot, "src", "MainApp.jsx");
const teacherEntryPath = path.join(repoRoot, "src", "TeacherValidationApp.jsx");
const teacherFeatureDir = path.join(repoRoot, "src", "teacherValidation");
const studentAppPath = path.join(repoRoot, "src", "StudentApp.jsx");
const studentFeatureDir = path.join(repoRoot, "src", "student");
const scoreIssuePagePath = path.join(repoRoot, "src", "ScoreIssuePage.jsx");
const scoreIssueFeatureDir = path.join(repoRoot, "src", "scoreIssue");
const mainAppText = fs.readFileSync(mainAppPath, "utf8");
const teacherEntryText = fs.readFileSync(teacherEntryPath, "utf8");
const studentAppText = fs.readFileSync(studentAppPath, "utf8");
const scoreIssuePageText = fs.readFileSync(scoreIssuePagePath, "utf8");

const failures = [];

function requireMatch(pattern, reason) {
  if (!pattern.test(mainAppText)) {
    failures.push({ path: "src/MainApp.jsx", reason });
  }
}

function forbidMatch(pattern, reason) {
  if (pattern.test(mainAppText)) {
    failures.push({ path: "src/MainApp.jsx", reason });
  }
}

requireMatch(/\blazy\b/, "MainApp must use React.lazy for route-level code splitting.");
requireMatch(/\bSuspense\b/, "MainApp must wrap lazy routes in Suspense.");

for (const moduleName of ["StudentApp", "ResearchApp", "ScoreIssuePage", "HealthPage", "TeacherValidationApp"]) {
  requireMatch(
    new RegExp(`const\\s+${moduleName}\\s*=\\s*lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*["']\\./${moduleName}\\.jsx["']\\s*\\)\\s*\\)`),
    `${moduleName} must be dynamically imported.`,
  );
  forbidMatch(
    new RegExp(`import\\s+${moduleName}\\s+from\\s+["']\\./${moduleName}\\.jsx["']`),
    `${moduleName} must not be statically imported into MainApp.`,
  );
}

if (!/export\s+\{\s*default\s*\}\s+from\s+["']\.\/teacherValidation\/TeacherValidationApp\.jsx["'];?/.test(teacherEntryText.trim())) {
  failures.push({
    path: "src/TeacherValidationApp.jsx",
    reason: "TeacherValidationApp entry must stay as a thin route-level re-export.",
  });
}

for (const fileName of [
  "TeacherValidationApp.jsx",
  "ScoreLocatorPanel.jsx",
  "SegmentAudioPlayer.jsx",
  "TeacherValidationAtoms.jsx",
  "teacherValidationUtils.js",
]) {
  const fullPath = path.join(teacherFeatureDir, fileName);
  if (!fs.existsSync(fullPath)) {
    failures.push({
      path: `src/teacherValidation/${fileName}`,
      reason: "Teacher validation feature files must remain grouped by feature.",
    });
  }
}

if (!studentAppText.includes("./student/studentAppUtils.js")) {
  failures.push({
    path: "src/StudentApp.jsx",
    reason: "Student app state, persistence, and section filtering helpers must stay in src/student/studentAppUtils.js.",
  });
}
if (!fs.existsSync(path.join(studentFeatureDir, "studentAppUtils.js"))) {
  failures.push({
    path: "src/student/studentAppUtils.js",
    reason: "Student helper module must remain grouped with the student feature.",
  });
}
if (!scoreIssuePageText.includes("./scoreIssue/scoreIssueProjection.js")) {
  failures.push({
    path: "src/ScoreIssuePage.jsx",
    reason: "Score issue projection and erhu/accompaniment locator rules must stay in src/scoreIssue/scoreIssueProjection.js.",
  });
}
if (!fs.existsSync(path.join(scoreIssueFeatureDir, "scoreIssueProjection.js"))) {
  failures.push({
    path: "src/scoreIssue/scoreIssueProjection.js",
    reason: "Score issue projection module must remain grouped with the scoreIssue feature.",
  });
}

const lineBudgets = [
  { path: "src/TeacherValidationApp.jsx", text: teacherEntryText, maxLines: 5 },
  { path: "src/ScoreIssuePage.jsx", text: scoreIssuePageText, maxLines: 950 },
  { path: "src/StudentApp.jsx", text: studentAppText, maxLines: 1400 },
];
for (const item of lineBudgets) {
  const lineCount = item.text.split(/\r?\n/).length;
  if (lineCount > item.maxLines) {
    failures.push({
      path: item.path,
      reason: `${item.path} has ${lineCount} lines; keep this route below ${item.maxLines} lines by moving feature logic into grouped modules.`,
    });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, splitRoutes: ["student", "research", "score-issues", "health", "teacher"] }, null, 2));
