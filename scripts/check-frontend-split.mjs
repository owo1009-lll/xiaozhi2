import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainAppPath = path.join(repoRoot, "src", "MainApp.jsx");
const mainAppText = fs.readFileSync(mainAppPath, "utf8");

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

for (const moduleName of ["StudentApp", "ResearchApp", "ScoreIssuePage", "HealthPage"]) {
  requireMatch(
    new RegExp(`const\\s+${moduleName}\\s*=\\s*lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*["']\\./${moduleName}\\.jsx["']\\s*\\)\\s*\\)`),
    `${moduleName} must be dynamically imported.`,
  );
  forbidMatch(
    new RegExp(`import\\s+${moduleName}\\s+from\\s+["']\\./${moduleName}\\.jsx["']`),
    `${moduleName} must not be statically imported into MainApp.`,
  );
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, splitRoutes: ["student", "research", "score-issues", "health"] }, null, 2));
