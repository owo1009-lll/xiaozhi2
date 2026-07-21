import assert from "node:assert/strict";
import fs from "node:fs";

const studentApp = fs.readFileSync("src/StudentApp.jsx", "utf8");
const stringsApp = fs.readFileSync("src/WesternStringsApp.jsx", "utf8");
const researchApi = fs.readFileSync("src/researchApi.js", "utf8");
const stringsRoutes = fs.readFileSync("src/server/westernStringsRoutes.js", "utf8");

const studentSideSources = [
  ["src/StudentApp.jsx", studentApp],
  ["src/WesternStringsApp.jsx", stringsApp],
];

for (const [sourceName, sourceText] of studentSideSources) {
  assert(!sourceText.includes("/api/strings/alignment-preview"), `${sourceName} must not call the offline alignment preview route`);
  assert(!sourceText.includes("/api/strings/analyze"), `${sourceName} must not directly call the western strings analyze route before UI review`);
  assert(!sourceText.includes("/api/strings/review"), `${sourceName} must not directly call the western strings review route before UI review`);
}

assert(stringsRoutes.includes('router.get("/api/strings/alignment-preview"'), "server should expose the offline preview route for teacher validation");
assert(stringsRoutes.includes('router.post("/api/strings/analyze"'), "server should expose the M3-gated western strings analyze route");
assert(stringsRoutes.includes('router.post("/api/strings/review"'), "server should expose the M3-gated western strings review route");
assert(researchApi.includes("fetchWesternAlignmentPreview"), "teacher backend may load the offline western strings preview");
assert(researchApi.includes("saveWesternAlignmentPreviewReview"), "teacher backend may save offline western strings preview reviews");
assert(stringsApp.includes("复核辅助：机器确诊候选"), "teacher queue should expose Policy C confirmed candidates");
assert(stringsApp.includes("自查提示"), "teacher queue should distinguish Policy C self-check hints");
assert(stringsApp.includes("仅供教师复核，不会自动发送给学生。"), "teacher queue should state the reviewer-only boundary");

console.log(JSON.stringify({ ok: true, checks: ["western-strings-student-api-gated", "western-strings-ui-default-off"] }));
