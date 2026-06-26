import assert from "node:assert/strict";
import fs from "node:fs";

const studentApp = fs.readFileSync("src/StudentApp.jsx", "utf8");
const stringsApp = fs.readFileSync("src/WesternStringsApp.jsx", "utf8");
const researchApi = fs.readFileSync("src/researchApi.js", "utf8");
const stringsRoutes = fs.readFileSync("src/server/westernStringsRoutes.js", "utf8");

const studentSideSources = [
  ["src/StudentApp.jsx", studentApp],
  ["src/WesternStringsApp.jsx", stringsApp],
  ["src/researchApi.js", researchApi],
];

for (const [sourceName, sourceText] of studentSideSources) {
  assert(!sourceText.includes("/api/strings/alignment-preview"), `${sourceName} must not call the offline alignment preview route`);
  assert(!sourceText.includes("/api/strings/analyze"), `${sourceName} must not call a student-facing western strings analyze route`);
  assert(!sourceText.includes("/api/strings/review"), `${sourceName} must not call a western strings review route`);
}

assert(stringsRoutes.includes('router.get("/api/strings/alignment-preview"'), "server should expose only the offline preview route for M2 validation");
assert(!stringsRoutes.includes('router.post("/api/strings/analyze"'), "student-facing western strings analyze route must remain disabled");
assert(!stringsRoutes.includes('router.post("/api/strings/review"'), "western strings review writeback route must remain disabled");

console.log(JSON.stringify({ ok: true, checks: ["western-strings-auto-feedback-default-off"] }));
