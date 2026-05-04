import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.dirname(__dirname);

function fail(message) {
  throw new Error(message);
}

function expectIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    fail(`${label} missing ${needle}`);
  }
}

function expectAtLeast(text, pattern, count, label) {
  const matches = text.match(pattern) || [];
  if (matches.length < count) {
    fail(`${label} expected at least ${count} matches, found ${matches.length}`);
  }
}

const [server, studentApp, docs] = await Promise.all([
  fs.readFile(path.join(repoRoot, "server.js"), "utf8"),
  fs.readFile(path.join(repoRoot, "src", "StudentApp.jsx"), "utf8"),
  fs.readFile(path.join(repoRoot, "docs", "mainline-app-priority.md"), "utf8"),
]);

expectIncludes(server, "musicxmlFallbackAvailable", "server score-import fallback contract");
expectIncludes(server, 'fallbackActions: fallbackActions.length ? fallbackActions : (musicxmlFallbackAvailable ? ["import-musicxml"] : [])', "server fallback action normalization");
expectIncludes(server, "isMusicXmlSource", "server MusicXML source guard");
expectIncludes(server, "interruptedByRestart", "server recovery marker");
expectIncludes(server, "retryable", "server retry marker");
expectIncludes(server, 'recoveryReason: "node-service-restart"', "server recovery reason");
expectIncludes(server, "recoverStaleJobsOnStartup", "server startup recovery");
expectIncludes(server, 'musicxmlFallbackAvailable: false', "direct MusicXML failure should not self-advertise fallback");
expectAtLeast(server, /recoveryReason:\s*"node-service-restart"/g, 3, "all stale job recovery paths");
expectAtLeast(server, /fallbackActions:\s*\["import-musicxml"\]/g, 2, "PDF fallback paths");

expectIncludes(studentApp, "hasScoreMusicXmlFallback", "student fallback helper");
expectIncludes(studentApp, "showMusicXmlFallback", "student fallback display gate");
expectIncludes(studentApp, 'actions.includes("import-musicxml")', "student fallback action check");
expectIncludes(studentApp, "PDF 自动识谱失败时", "student fallback copy");
expectIncludes(studentApp, "handleImportMusicXml", "student fallback import handler");

expectIncludes(docs, "2026-05-04 P2 Contract Checkpoint", "documented job contract");
expectIncludes(docs, 'recoveryReason: "node-service-restart"', "documented recovery reason");
expectIncludes(docs, 'fallbackActions: ["import-musicxml"]', "documented MusicXML fallback action");

console.log(JSON.stringify({ ok: true, checks: ["job-recovery-contract", "musicxml-fallback-contract", "student-fallback-ui"] }));
