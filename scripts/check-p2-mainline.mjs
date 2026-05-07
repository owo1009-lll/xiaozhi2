import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const lineBudgets = [
  { path: "server.js", maxLines: 4700 },
  { path: "python-service/analyzer.py", maxLines: 6900 },
  { path: "src/StudentApp.jsx", maxLines: 1400 },
  { path: "src/ScoreIssuePage.jsx", maxLines: 950 },
];

const requiredModules = [
  {
    path: "python-service/analyzer_models.py",
    importedBy: "python-service/analyzer.py",
    importText: "from analyzer_models import ObservedNote, SymbolicNote",
  },
  {
    path: "python-service/analyzer_audio.py",
    importedBy: "python-service/analyzer.py",
    importText: "from analyzer_audio import",
  },
  {
    path: "python-service/analyzer_musicxml.py",
    importedBy: "python-service/analyzer.py",
    importText: "from analyzer_musicxml import",
  },
  {
    path: "python-service/analyzer_score_import.py",
    importedBy: "python-service/analyzer.py",
    importText: "from analyzer_score_import import ScoreImportMixin",
  },
  {
    path: "python-service/analyzer_score_roles.py",
    importedBy: "python-service/analyzer.py",
    importText: "from analyzer_score_roles import",
  },
  {
    path: "src/server/analysisRoutes.js",
    importedBy: "server.js",
    importText: 'from "./src/server/analysisRoutes.js"',
  },
  {
    path: "src/server/scoreRoutes.js",
    importedBy: "server.js",
    importText: 'from "./src/server/scoreRoutes.js"',
  },
  {
    path: "src/server/opsRoutes.js",
    importedBy: "server.js",
    importText: 'from "./src/server/opsRoutes.js"',
  },
  {
    path: "src/server/researchRoutes.js",
    importedBy: "server.js",
    importText: 'from "./src/server/researchRoutes.js"',
  },
  {
    path: "src/server/researchService.js",
    importedBy: "server.js",
    importText: 'from "./src/server/researchService.js"',
  },
  {
    path: "src/student/studentAppUtils.js",
    importedBy: "src/StudentApp.jsx",
    importText: "./student/studentAppUtils.js",
  },
  {
    path: "src/student/studentStatus.js",
    importedBy: "src/StudentApp.jsx",
    importText: "./student/studentStatus.js",
  },
  {
    path: "src/scoreIssue/scoreIssueProjection.js",
    importedBy: "src/ScoreIssuePage.jsx",
    importText: "./scoreIssue/scoreIssueProjection.js",
  },
];

const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

for (const item of lineBudgets) {
  const text = read(item.path);
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > item.maxLines) {
    failures.push({
      path: item.path,
      reason: `${item.path} has ${lineCount} lines; P2 budget is ${item.maxLines}.`,
    });
  }
}

for (const item of requiredModules) {
  const modulePath = path.join(repoRoot, item.path);
  if (!fs.existsSync(modulePath)) {
    failures.push({ path: item.path, reason: "Required P2 split module is missing." });
    continue;
  }
  const importerText = read(item.importedBy);
  if (!importerText.includes(item.importText)) {
    failures.push({
      path: item.importedBy,
      reason: `${item.importedBy} must import/use ${item.path}.`,
    });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      lineBudgets: lineBudgets.map((item) => ({
        path: item.path,
        maxLines: item.maxLines,
        lineCount: read(item.path).split(/\r?\n/).length,
      })),
      requiredModules: requiredModules.map((item) => item.path),
    },
    null,
    2,
  ),
);
