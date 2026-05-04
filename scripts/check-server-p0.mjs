import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "server.js");
const jsonStorePath = path.join(repoRoot, "src", "server", "jsonStore.js");
const packagePath = path.join(repoRoot, "package.json");
const mainlinePath = path.join(repoRoot, "scripts", "run-mainline-p0-checks.ps1");

const serverText = fs.readFileSync(serverPath, "utf8");
const jsonStoreText = fs.readFileSync(jsonStorePath, "utf8");
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
const routes = new Map();
for (const match of serverText.matchAll(routeRegex)) {
  const key = routeKey(match[1], match[2]);
  if (!routes.has(key)) routes.set(key, []);
  routes.get(key).push(match.index || 0);
}

for (const [key, offsets] of routes.entries()) {
  if (offsets.length > 1) {
    failures.push({
      path: "server.js",
      line: lineNumberForOffset(serverText, offsets[0]),
      reason: `Duplicate Express route: ${key} at lines ${offsets.map((offset) => lineNumberForOffset(serverText, offset)).join(", ")}`,
    });
  }
}

const importPdfKey = routeKey("post", "/api/erhu/scores/import-pdf");
if ((routes.get(importPdfKey) || []).length !== 1) {
  fail("Exactly one POST /api/erhu/scores/import-pdf route is required.");
}

function routeHandler(routePath) {
  const marker = `app.post("${routePath}"`;
  const start = serverText.indexOf(marker);
  if (start < 0) return "";
  const nextRoute = serverText.indexOf("\napp.", start + marker.length);
  return serverText.slice(start, nextRoute < 0 ? serverText.length : nextRoute);
}

const importPdfHandler = routeHandler("/api/erhu/scores/import-pdf");
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
    },
    null,
    2,
  ),
);
