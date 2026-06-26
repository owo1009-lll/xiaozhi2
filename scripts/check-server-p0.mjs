import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "server.js");
const jsonStorePath = path.join(repoRoot, "src", "server", "jsonStore.js");
const opsRoutesPath = path.join(repoRoot, "src", "server", "opsRoutes.js");
const researchServicePath = path.join(repoRoot, "src", "server", "researchService.js");
const researchRoutesPath = path.join(repoRoot, "src", "server", "researchRoutes.js");
const scoreRoutesPath = path.join(repoRoot, "src", "server", "scoreRoutes.js");
const teacherValidationServicePath = path.join(repoRoot, "src", "server", "teacherValidationService.js");
const teacherValidationRoutesPath = path.join(repoRoot, "src", "server", "teacherValidationRoutes.js");
const packagePath = path.join(repoRoot, "package.json");
const mainlinePath = path.join(repoRoot, "scripts", "run-mainline-p0-checks.ps1");
const analysisRoutesPath = path.join(repoRoot, "src", "server", "analysisRoutes.js");

const serverText = fs.readFileSync(serverPath, "utf8");
const analysisRoutesText = fs.readFileSync(analysisRoutesPath, "utf8");
const jsonStoreText = fs.readFileSync(jsonStorePath, "utf8");
const opsRoutesText = fs.readFileSync(opsRoutesPath, "utf8");
const researchServiceText = fs.readFileSync(researchServicePath, "utf8");
const researchRoutesText = fs.readFileSync(researchRoutesPath, "utf8");
const scoreRoutesText = fs.readFileSync(scoreRoutesPath, "utf8");
const teacherValidationServiceText = fs.readFileSync(teacherValidationServicePath, "utf8");
const teacherValidationRoutesText = fs.readFileSync(teacherValidationRoutesPath, "utf8");
const serverRuntimeText = `${serverText}\n${jsonStoreText}`;
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const mainlineText = fs.readFileSync(mainlinePath, "utf8");
const failures = [];

function lineNumberForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function fail(reason, offset = 0) {
  failures.push({
    path: "server.js",
    line: lineNumberForOffset(serverText, Math.max(0, offset)),
    reason,
  });
}

function routeKey(method, routePath) {
  return `${method.toUpperCase()} ${routePath}`;
}

const routeRegex = /app\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;
const routerRouteRegex = /router\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g;
const routes = new Map();
const routeSources = [
  { path: "server.js", text: serverText, regex: routeRegex },
  { path: "src/server/analysisRoutes.js", text: analysisRoutesText, regex: routerRouteRegex },
  { path: "src/server/opsRoutes.js", text: opsRoutesText, regex: routerRouteRegex },
  { path: "src/server/researchRoutes.js", text: researchRoutesText, regex: routerRouteRegex },
  { path: "src/server/scoreRoutes.js", text: scoreRoutesText, regex: routerRouteRegex },
  { path: "src/server/teacherValidationRoutes.js", text: teacherValidationRoutesText, regex: routerRouteRegex },
];
for (const source of routeSources) {
  for (const match of source.text.matchAll(source.regex)) {
    const key = routeKey(match[1], match[2]);
    if (!routes.has(key)) routes.set(key, []);
    routes.get(key).push({
      path: source.path,
      line: lineNumberForOffset(source.text, match.index || 0),
    });
  }
}

for (const [key, offsets] of routes.entries()) {
  if (offsets.length > 1) {
    failures.push({
      path: offsets[0].path,
      line: offsets[0].line,
      reason: `Duplicate Express route: ${key} at ${offsets.map((item) => `${item.path}:${item.line}`).join(", ")}`,
    });
  }
}

const importPdfKey = routeKey("post", "/api/erhu/scores/import-pdf");
if ((routes.get(importPdfKey) || []).length !== 1) {
  fail("Exactly one POST /api/erhu/scores/import-pdf route is required.");
}

function routeHandler(method, routePath) {
  for (const source of routeSources) {
    for (const prefix of ["app", "router"]) {
      const marker = `${prefix}.${method}("${routePath}"`;
      const start = source.text.indexOf(marker);
      if (start < 0) continue;
      const nextRouteOffsets = ["\napp.", "\nrouter.", "\n  router."]
        .map((nextMarker) => source.text.indexOf(nextMarker, start + marker.length))
        .filter((offset) => offset >= 0);
      const nextRoute = nextRouteOffsets.length ? Math.min(...nextRouteOffsets) : -1;
      return source.text.slice(start, nextRoute < 0 ? source.text.length : nextRoute);
    }
  }
  return "";
}

const importPdfHandler = routeHandler("post", "/api/erhu/scores/import-pdf");
const requiredImportSnippets = [
  {
    text: "allowReuse: true",
    reason: "PDF import cached-hit path must explicitly allow score reuse.",
  },
  {
    text: "buildCachedImportPreviewPages",
    reason: "PDF import cached-hit path must preserve preview page rebuilding.",
  },
  {
    text: "buildReusedOmrStats",
    reason: "PDF import cached-hit path must preserve reused OMR stats.",
  },
  {
    text: "selectedPartConfidence",
    reason: "PDF import cached-hit path must preserve selected-part confidence.",
  },
  {
    text: "partCandidates",
    reason: "PDF import cached-hit path must preserve part candidates.",
  },
  {
    text: "launchScoreImportTask",
    reason: "PDF import uncached path must queue the async import task.",
  },
  {
    text: "return res.status(202)",
    reason: "PDF import uncached path must return 202 for async processing.",
  },
];
for (const { text, reason } of requiredImportSnippets) {
  if (!importPdfHandler.includes(text)) {
    fail(reason, serverText.indexOf(importPdfHandler));
  }
}
if (/callExternalScoreImportLongTimeout\s*\(/.test(importPdfHandler)) {
  fail("PDF import route must not call the long-running Python import synchronously.", serverText.indexOf("callExternalScoreImportLongTimeout", serverText.indexOf(importPdfHandler)));
}

const requiredServerSnippets = [
  { text: "async function atomicWriteJson", reason: "JSON stores must use temp-file-then-rename atomic writes." },
  { text: "async function enqueueStoreOperation", reason: "JSON stores must serialize writes through a per-store queue." },
  { text: "mergeStudyStores", reason: "Study-record writes must merge against the latest queued file state." },
  { text: "compactScoreStoreForWrite", reason: "Score import store must compact/archive oversized data." },
  { text: "writeScoreStoreArchive", reason: "Score import compaction must archive removed entries instead of silently dropping them." },
  { text: "recoverStaleJobsOnStartup", reason: "Startup must recover processing jobs lost across Node/Python restarts." },
  { text: "void recoverStaleJobsOnStartup()", reason: "Startup recovery must be invoked from the server listener." },
];
for (const { text, reason } of requiredServerSnippets) {
  if (!serverRuntimeText.includes(text)) {
    fail(reason);
  }
}

const reusableImportOffset = serverText.indexOf("function findReusableImportedScore");
const reusableImportEnd = serverText.indexOf("const activeScoreImportTasks", reusableImportOffset);
const reusableImportBlock = reusableImportOffset >= 0
  ? serverText.slice(reusableImportOffset, reusableImportEnd >= 0 ? reusableImportEnd : undefined)
  : "";
if (!serverText.includes("function scoreSourceFileExists")) {
  fail("Score import cache reuse must validate that stored MusicXML sources still exist.");
}
if (!serverText.includes("fsSync.existsSync(localPath)")) {
  fail("Score import source-file guard must check local MusicXML source existence.");
}
if (!reusableImportBlock.includes("scoreSourceFileExists(score)")) {
  fail("Reusable score-import cache hits must reject stale records whose MusicXML source is missing.", reusableImportOffset);
}

const westernMetadataSnippets = [
  {
    path: "server.js",
    text: "instrument: safeString(score.instrument",
    reason: "Imported score normalization must preserve western string instrument metadata.",
    haystack: serverText,
  },
  {
    path: "server.js",
    text: "scoreSource: safeString(score.scoreSource",
    reason: "Imported score normalization must preserve clean-score source metadata.",
    haystack: serverText,
  },
  {
    path: "server.js",
    text: "tempoKnown: safeBoolean(score.tempoKnown",
    reason: "Imported score normalization must preserve explicit tempo-known metadata.",
    haystack: serverText,
  },
  {
    path: "src/server/scoreRoutes.js",
    text: "const instrument = safeString(req.body?.instrument)",
    reason: "MusicXML upload route must accept instrument metadata.",
    haystack: scoreRoutesText,
  },
  {
    path: "src/server/scoreRoutes.js",
    text: "const scoreSource = safeString(req.body?.scoreSource, \"musicxml\")",
    reason: "MusicXML upload route must accept clean-score source metadata.",
    haystack: scoreRoutesText,
  },
  {
    path: "src/server/scoreRoutes.js",
    text: "const tempoKnown = safeBoolean(req.body?.tempoKnown, false)",
    reason: "MusicXML upload route must accept tempo-known metadata.",
    haystack: scoreRoutesText,
  },
];
for (const item of westernMetadataSnippets) {
  if (!item.haystack.includes(item.text)) {
    failures.push({
      path: item.path,
      line: 1,
      reason: item.reason,
    });
  }
}

if (!serverText.includes("createTeacherValidationRouter(teacherValidationService)")) {
  fail("Teacher validation routes must be mounted through src/server/teacherValidationRoutes.js.");
}
if (!serverText.includes("createTeacherValidationService({")) {
  fail("Teacher validation business logic must be configured through src/server/teacherValidationService.js.");
}
if (!serverText.includes('from "./src/server/researchService.js"')) {
  fail("Research and validation business helpers must be imported from src/server/researchService.js.");
}
if (!serverText.includes("createResearchRouter({ readStudyStore, writeStudyStore, fetchAnalyzerStatus })")) {
  fail("Research/study HTTP routes must be mounted through src/server/researchRoutes.js.");
}
if (!serverText.includes("createOpsRouter({")) {
  fail("Operational health/job routes must be mounted through src/server/opsRoutes.js.");
}
if (!serverText.includes("createAnalysisRouter({")) {
  fail("Analysis and piece HTTP routes must be mounted through src/server/analysisRoutes.js.");
}
if (!serverText.includes("createScoreRouter({")) {
  fail("Score import HTTP routes must be mounted through src/server/scoreRoutes.js.");
}
for (const leakedFunction of [
  "function buildOpsHealth",
  "function readOpsJobs",
  "function cancelOpsJob",
  "function retryOpsJob",
  "function buildTeacherScoreLocator",
  "function listTeacherValidationPacks",
  "function readTeacherValidationPack",
  "function updateTeacherValidationReview",
  "function resolveTeacherValidationAssetPath",
  "function applyTeacherValidationPack",
  "function ensureParticipantRecord",
  "function appendAnalysisToParticipant",
  "function buildParticipantView",
  "function buildValidationSummary",
  "function createValidationReview",
  "function buildDataQualityOverview",
  'app.get("/api/erhu/research/overview"',
  'app.post("/api/erhu/validation-review"',
  'app.post("/api/erhu/task-plan"',
  'app.get("/api/erhu/analysis/:analysisId"',
  'app.get("/api/erhu/ops/health"',
  'app.get("/api/erhu/ops/jobs"',
  'app.post("/api/erhu/ops/jobs/:type/:jobId/cancel"',
  'app.post("/api/erhu/ops/jobs/:type/:jobId/retry"',
  'app.post("/api/erhu/ops/jobs/:type/:jobId/resume"',
  'app.post("/api/erhu/scores/import-pdf"',
  'app.post("/api/erhu/scores/import-musicxml"',
  'app.post("/api/erhu/scores/:scoreId/select-part"',
  'app.get("/api/erhu/piece-pass/latest"',
  'app.post("/api/erhu/piece-pass-jobs"',
  'app.get("/api/erhu/piece-pass-jobs/:jobId"',
  'app.get("/api/erhu/pieces"',
  'app.post("/api/erhu/auto-detect-section"',
  'app.post("/api/erhu/analyze"',
  'app.get("/api/erhu/analyze-jobs/:jobId"',
]) {
  const offset = serverText.indexOf(leakedFunction);
  if (offset >= 0) {
    fail(`Teacher validation implementation leaked back into server.js: ${leakedFunction}.`, offset);
  }
}
if (!teacherValidationServiceText.includes("function buildTeacherScoreLocator")) {
  failures.push({
    path: "src/server/teacherValidationService.js",
    line: 1,
    reason: "Teacher score locator logic must live in teacherValidationService.js.",
  });
}
if (!teacherValidationRoutesText.includes("createTeacherValidationRouter")) {
  failures.push({
    path: "src/server/teacherValidationRoutes.js",
    line: 1,
    reason: "Teacher validation HTTP routes must live in teacherValidationRoutes.js.",
  });
}
if (!researchRoutesText.includes("createResearchRouter")) {
  failures.push({
    path: "src/server/researchRoutes.js",
    line: 1,
    reason: "Research HTTP routes must live in researchRoutes.js.",
  });
}
if (!opsRoutesText.includes("createOpsRouter")) {
  failures.push({
    path: "src/server/opsRoutes.js",
    line: 1,
    reason: "Operational health/job routes must live in opsRoutes.js.",
  });
}
if (!analysisRoutesText.includes("createAnalysisRouter")) {
  failures.push({
    path: "src/server/analysisRoutes.js",
    line: 1,
    reason: "Analysis and piece HTTP routes must live in analysisRoutes.js.",
  });
}
if (!scoreRoutesText.includes("createScoreRouter")) {
  failures.push({
    path: "src/server/scoreRoutes.js",
    line: 1,
    reason: "Score import HTTP routes must live in scoreRoutes.js.",
  });
}
for (const requiredFunction of [
  "function ensureParticipantRecord",
  "function appendAnalysisToParticipant",
  "function buildParticipantView",
  "function buildValidationSummary",
  "function createValidationReview",
  "function buildDataQualityOverview",
]) {
  if (!researchServiceText.includes(requiredFunction)) {
    failures.push({
      path: "src/server/researchService.js",
      line: 1,
      reason: `Research service must own ${requiredFunction}.`,
    });
  }
}

const serverLineCount = serverText.split(/\r?\n/).length;
if (serverLineCount > 4700) {
  failures.push({
    path: "server.js",
    line: 1,
    reason: `server.js has ${serverLineCount} lines; keep extracted research/validation/route logic out of the gateway file.`,
  });
}

if (packageJson.scripts?.["test:server-p0"] !== "node scripts\\check-server-p0.mjs") {
  failures.push({
    path: "package.json",
    line: 1,
    reason: "package.json must expose test:server-p0.",
  });
}

if (!mainlineText.includes('Invoke-Step "server P0 guards" { npm run test:server-p0 }')) {
  failures.push({
    path: "scripts/run-mainline-p0-checks.ps1",
    line: 1,
    reason: "test:mainline-p0 must run the server P0 guard.",
  });
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      duplicateRouteCount: [...routes.values()].filter((items) => items.length > 1).length,
      importPdfRoute: "async-cached-and-uncached-guarded",
      storeGuards: ["atomic-write", "write-queue", "study-store-merge", "score-store-archive", "startup-recovery"],
      serverLineCount,
    },
    null,
    2,
  ),
);
