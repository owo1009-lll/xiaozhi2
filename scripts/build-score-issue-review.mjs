import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ISSUE_SESSION_SCHEMA_VERSION,
  ISSUE_SESSION_STORAGE_PREFIX,
  buildIssueSessionPayload,
  repairMojibakeText,
} from "../src/analysisLabels.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_ROOT = path.join(REPO_ROOT, "data");

function readJsonFile(filePath, fallback = null) {
  if (!filePath || !fsSync.existsSync(filePath)) return fallback;
  return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
}

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    runSummary: "",
    outputDir: "",
    baseUrl: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-summary") parsed.runSummary = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--output-dir") parsed.outputDir = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--base-url") parsed.baseUrl = argv[++index] || "";
  }
  return parsed;
}

function findLatestRunSummary() {
  const corpusRoot = path.join(DATA_ROOT, "real-tests", "corpus-runs");
  if (!fsSync.existsSync(corpusRoot)) return "";
  const candidates = fsSync.readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(corpusRoot, entry.name, "run-summary.json"))
    .filter((summaryPath) => fsSync.existsSync(summaryPath))
    .map((summaryPath) => {
      const summary = readJsonFile(summaryPath, {});
      return {
        summaryPath,
        createdAt: Date.parse(summary?.createdAt || "") || fsSync.statSync(summaryPath).mtimeMs,
        resultCount: Array.isArray(summary?.results) ? summary.results.length : 0,
      };
    })
    .filter((item) => item.resultCount > 0)
    .sort((left, right) => right.createdAt - left.createdAt);
  return candidates[0]?.summaryPath || "";
}

function toDataWebPath(filePath) {
  const relative = path.relative(DATA_ROOT, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return `/data/${relative.split(path.sep).join("/")}`;
}

function cleanText(value, fallback = "") {
  return repairMojibakeText(value) || fallback;
}

function uniqueSortedNumbers(values = []) {
  return [...new Set(values.map((value) => Math.round(Number(value))).filter((value) => Number.isFinite(value) && value > 0))]
    .sort((left, right) => left - right);
}

function pageNumberFromText(value) {
  const match = String(value || "").match(/page[-\s]?0*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function collectIssuePages(analysis = {}) {
  const pages = [];
  for (const item of analysis.noteFindings || []) {
    pages.push(item?.sourcePageNumber, item?.pageNumber);
  }
  for (const item of analysis.measureFindings || []) {
    pages.push(item?.sourcePageNumber, item?.pageNumber);
  }
  return uniqueSortedNumbers(pages);
}

function collectSectionPages(analysis = {}, score = {}) {
  const pages = [];
  for (const item of analysis.sectionSummaries || []) {
    pages.push(item?.pageNumber, pageNumberFromText(item?.sectionId), pageNumberFromText(item?.sourceSectionId), pageNumberFromText(item?.sectionTitle));
  }
  for (const section of score.sections || []) {
    pages.push(section?.pageNumber, pageNumberFromText(section?.sectionId), pageNumberFromText(section?.sourceSectionId), pageNumberFromText(section?.title));
  }
  return uniqueSortedNumbers(pages);
}

function sectionPage(section = {}) {
  return Math.max(
    1,
    Math.round(
      Number(section?.pageNumber)
      || pageNumberFromText(section?.sectionId)
      || pageNumberFromText(section?.sourceSectionId)
      || pageNumberFromText(section?.title)
      || 1,
    ),
  );
}

function isImportedSection(section = {}) {
  return /page[-\s]?0*\d+/i.test(`${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`);
}

function isErhuNote(note = {}, section = {}) {
  if (!isImportedSection(section)) return true;
  const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
  const confidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
  if (role === "erhu" && confidence >= 0.66) return true;
  if (role) return false;
  return false;
}

function isAccompanimentOnly(section = {}) {
  const stats = section?.scoreLineStats || {};
  const erhuCount = Number(stats.erhuNoteCount) || 0;
  const accompanimentCount = Number(stats.accompanimentNoteCount) || 0;
  if (erhuCount <= 0 && accompanimentCount > 0) return true;
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  return notes.length > 0 && !notes.some((note) => isErhuNote(note, section));
}

function hasErhuMeasure(section = {}, measureIndex = 0) {
  const numericMeasure = Number(measureIndex) || 1;
  return (section?.notes || []).some((note) => Number(note?.measureIndex) === numericMeasure && isErhuNote(note, section));
}

function resolveIssueSection(score = {}, issue = {}) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const requestedId = String(issue?.sectionId || "").trim();
  const measureIndex = Number(issue?.measureIndex);
  const noteId = String(issue?.noteId || "").trim();
  if (requestedId) {
    const matched = sections.find((section) => (
      String(section?.sectionId || "") === requestedId
      || String(section?.sourceSectionId || "") === requestedId
    ));
    if (matched && !isAccompanimentOnly(matched) && hasErhuMeasure(matched, measureIndex)) return matched;
  }
  const page = Number(issue?.sourcePageNumber || issue?.pageNumber);
  if (Number.isFinite(page) && page > 0) {
    const pageSections = sections.filter((section) => sectionPage(section) === Math.round(page));
    const exact = pageSections.find((section) => (section.notes || []).some((note) => (
      Number(note?.measureIndex) === measureIndex
      && (!noteId || String(note?.noteId || "") === noteId)
      && isErhuNote(note, section)
    )));
    if (exact) return exact;
    const measure = pageSections.find((section) => hasErhuMeasure(section, measureIndex));
    if (measure) return measure;
    return pageSections.find((section) => !isAccompanimentOnly(section)) || null;
  }
  return null;
}

function auditScoreIssueProjection(score = {}, analysis = {}) {
  const sourcePages = [];
  const visiblePages = [];
  const reviewPages = [];
  const failures = [];
  let visibleNotes = 0;
  let reviewNotes = 0;
  let visibleMeasures = 0;
  let reviewMeasures = 0;

  for (const issue of analysis.noteFindings || []) {
    const section = resolveIssueSection(score, issue);
    const sourcePage = Number(issue?.sourcePageNumber || issue?.pageNumber) || (section ? sectionPage(section) : 0);
    if (sourcePage > 0) sourcePages.push(sourcePage);
    const note = (section?.notes || []).find((item) => (
      String(item?.noteId || "") === String(issue?.noteId || "")
      && Number(item?.measureIndex) === Number(issue?.measureIndex)
    ));
    if (!section || !note || !isErhuNote(note, section)) {
      reviewNotes += 1;
      if (sourcePage > 0) reviewPages.push(sourcePage);
      continue;
    }
    visibleNotes += 1;
    visiblePages.push(sectionPage(section));
    const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
    if (role && role !== "erhu") {
      failures.push({ type: "note-on-accompaniment", noteId: issue.noteId, sectionId: section.sectionId });
    }
  }

  for (const issue of analysis.measureFindings || []) {
    const section = resolveIssueSection(score, issue);
    const sourcePage = Number(issue?.sourcePageNumber || issue?.pageNumber) || (section ? sectionPage(section) : 0);
    if (sourcePage > 0) sourcePages.push(sourcePage);
    if (!section || !hasErhuMeasure(section, issue.measureIndex)) {
      reviewMeasures += 1;
      if (sourcePage > 0) reviewPages.push(sourcePage);
      continue;
    }
    visibleMeasures += 1;
    visiblePages.push(sectionPage(section));
    if (isAccompanimentOnly(section)) {
      failures.push({ type: "measure-on-accompaniment", measureIndex: issue.measureIndex, sectionId: section.sectionId });
    }
  }

  const visibleIssues = visibleNotes + visibleMeasures;
  const reviewIssues = reviewNotes + reviewMeasures;
  const totalIssues = visibleIssues + reviewIssues;
  return {
    sourcePages: uniqueSortedNumbers(sourcePages),
    visiblePages: uniqueSortedNumbers(visiblePages),
    reviewPages: uniqueSortedNumbers(reviewPages),
    visibleNotes,
    reviewNotes,
    visibleMeasures,
    reviewMeasures,
    visibleIssues,
    reviewIssues,
    reviewRate: totalIssues ? Number((reviewIssues / totalIssues).toFixed(4)) : 0,
    failures,
  };
}

function buildRiskLabels(item) {
  const labels = [];
  if (item.omrConfidence > 0 && item.omrConfidence < 0.88) labels.push("识谱质量偏低");
  if (item.scoreIssueAudit.reviewIssues > 0) labels.push("有复核项");
  if (item.scoreIssueAudit.failures.length > 0) labels.push("疑似伴奏误投");
  if (item.issuePages.length >= 5) labels.push("跨页较多");
  if (item.noteIssueCount + item.measureIssueCount >= 50) labels.push("问题密集");
  if (item.attemptedSections >= 80) labels.push("分段很多");
  if (item.cacheMisses > 0) labels.push("含首次分析");
  return labels;
}

function formatPageList(pages = []) {
  return pages.length ? pages.join(", ") : "无";
}

function formatMs(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  if (numeric < 1000) return `${Math.round(numeric)}ms`;
  return `${(numeric / 1000).toFixed(1)}s`;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function sessionIdFor(score, analysis) {
  const scoreId = String(score?.scoreId || analysis?.scoreId || "score").replace(/[^\w.-]+/g, "-");
  const audioHash = String(analysis?.audioHash || analysis?.originalAudio?.audioHash || "no-audio-hash").replace(/[^\w.-]+/g, "-");
  const analysisId = String(analysis?.analysisId || analysis?.createdAt || Date.now().toString(36)).replace(/[^\w.-]+/g, "-");
  return `issue-v${ISSUE_SESSION_SCHEMA_VERSION}-${scoreId}-${audioHash}-whole-piece-${analysisId}`;
}

function buildOriginalAudio(analysis = {}) {
  if (analysis.originalAudio?.url) return analysis.originalAudio;
  const url = analysis.originalAudioUrl || analysis.audioUrl || "";
  if (!url) return null;
  return {
    url,
    durationSeconds: analysis.audioDurationSeconds ?? null,
    filename: analysis.audioFilename || analysis.audioSubmission?.name || "",
    audioHash: analysis.audioHash || "",
  };
}

function buildReviewItem(result, score) {
  const analysis = result?.piecePassJob?.wholePieceAnalysis;
  if (!analysis || !score) return null;
  const sessionId = sessionIdFor(score, analysis);
  const issuePages = collectIssuePages(analysis);
  const sectionPages = collectSectionPages(analysis, score);
  const summary = result?.piecePassJob?.summary || {};
  const checks = result?.checks || {};
  const noteIssueCount = Array.isArray(analysis.noteFindings) ? analysis.noteFindings.length : Number(summary.totalNoteFindings || 0);
  const measureIssueCount = Array.isArray(analysis.measureFindings) ? analysis.measureFindings.length : Number(summary.totalMeasureFindings || 0);
  const weakEvidenceCount = (analysis.noteFindings || []).filter((item) => item?.isUncertain || String(item?.pitchLabel || "") === "pitch-review").length;
  const scoreIssueAudit = auditScoreIssueProjection(score, analysis);
  const payload = buildIssueSessionPayload({
    analysis,
    score,
    section: null,
    mode: "whole-piece",
    originalAudio: buildOriginalAudio(analysis),
  });
  const item = {
    sessionId,
    title: cleanText(result?.title || analysis.pieceTitle || score.title, "未命名曲目"),
    scoreId: score.scoreId || analysis.scoreId || "",
    analysisId: analysis.analysisId || "",
    status: result?.status || "",
    omrConfidence: Number(result?.importJob?.omrConfidence || score.omrConfidence || 0),
    issuePages,
    sectionPages,
    visiblePages: scoreIssueAudit.visiblePages,
    reviewPages: scoreIssueAudit.reviewPages,
    noteIssueCount,
    measureIssueCount,
    weakEvidenceCount,
    locationReviewIssueCount: scoreIssueAudit.reviewIssues,
    scoreIssueAudit,
    analysisMs: result?.analysisMs || result?.piecePassJob?.durationMs || 0,
    importMs: result?.importMs || 0,
    cacheHits: Number(summary.sectionCacheHitCount || 0),
    cacheMisses: Number(summary.sectionCacheMissCount || Math.max(0, Number(summary.attemptedSectionCount || 0) - Number(summary.sectionCacheHitCount || 0))),
    matchedSections: Number(summary.matchedSectionCount || 0),
    attemptedSections: Number(summary.attemptedSectionCount || 0),
    warnings: result?.checks?.warnings || [],
    p0Failures: checks.p0Failures || [],
    payload,
  };
  return {
    ...item,
    riskLabels: buildRiskLabels(item),
  };
}

function buildReviewHtml({ report, items, baseUrl, sessionsJsonPath, manifestJsonPath }) {
  const sessionPayloads = Object.fromEntries(items.map((item) => [item.sessionId, item.payload]));
  const riskLabelHtml = (item) => item.riskLabels.length
    ? `<div class="risk-list">${item.riskLabels.map((label) => `<span>${htmlEscape(label)}</span>`).join("")}</div>`
    : `<div class="risk-list"><span class="is-calm">常规复核</span></div>`;
  const rows = items.map((item) => `
    <article class="review-card">
      <div class="card-head">
        <div>
          <h2>${htmlEscape(item.title)}</h2>
          <p class="muted">${htmlEscape(item.analysisId)}</p>
        </div>
        <button type="button" data-session-id="${htmlEscape(item.sessionId)}">打开问题谱面</button>
      </div>
      ${riskLabelHtml(item)}
      <dl>
        <div><dt>问题</dt><dd>${item.noteIssueCount} 个音 / ${item.measureIssueCount} 个小节</dd></div>
        <div><dt>问题页</dt><dd>${htmlEscape(formatPageList(item.issuePages))}</dd></div>
        <div><dt>可见页</dt><dd>${htmlEscape(formatPageList(item.visiblePages))}</dd></div>
        <div><dt>需复核页</dt><dd>${htmlEscape(formatPageList(item.reviewPages))}</dd></div>
        <div><dt>段落页</dt><dd>${htmlEscape(formatPageList(item.sectionPages))}</dd></div>
        <div><dt>OMR</dt><dd>${item.omrConfidence ? item.omrConfidence.toFixed(2) : "无"}</dd></div>
        <div><dt>段落</dt><dd>${item.matchedSections}/${item.attemptedSections}</dd></div>
        <div><dt>耗时</dt><dd>导入 ${htmlEscape(formatMs(item.importMs) || "无")} / 分析 ${htmlEscape(formatMs(item.analysisMs) || "无")}</dd></div>
        <div><dt>快速复用</dt><dd>${item.cacheHits} 段 / 新分析 ${item.cacheMisses} 段</dd></div>
        <div><dt>定位复核</dt><dd>${item.locationReviewIssueCount} 个问题项</dd></div>
        <div><dt>弱证据</dt><dd>${item.weakEvidenceCount} 个音</dd></div>
      </dl>
      ${item.warnings.length ? `<p class="warning">警告：${htmlEscape(item.warnings.join("；"))}</p>` : ""}
      ${item.p0Failures.length ? `<p class="danger">P0：${htmlEscape(item.p0Failures.join("；"))}</p>` : ""}
      <p class="checklist">目测重点：翻页后定位是否在二胡旋律行；编号顺序是否合理；音准/节奏颜色是否匹配；点击问题项是否播放对应原音片段。</p>
    </article>
  `).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>真实曲库问题谱面复核</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei", system-ui, sans-serif; background: #f6f7f8; color: #172026; }
    body { margin: 0; padding: 24px; }
    main { max-width: 1180px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 24px; }
    h2 { margin: 0 0 4px; font-size: 18px; }
    .muted { color: #66727a; margin: 0; font-size: 12px; }
    .review-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
    .review-card { background: #fff; border: 1px solid #dde3e6; border-radius: 8px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    button { border: 1px solid #1f6feb; background: #1f6feb; color: #fff; border-radius: 6px; padding: 8px 12px; cursor: pointer; white-space: nowrap; }
    button:hover { background: #1958bd; }
    .risk-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }
    .risk-list span { background: #eef4ff; border: 1px solid #c7d8ff; color: #174ea6; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 600; }
    .risk-list .is-calm { background: #edf8f0; border-color: #bbdfc6; color: #24713b; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 14px; margin: 0; }
    dt { color: #6a747b; font-size: 12px; }
    dd { margin: 2px 0 0; font-weight: 600; overflow-wrap: anywhere; }
    .checklist { color: #46525a; line-height: 1.55; margin-bottom: 0; }
    .warning { color: #8a5a00; background: #fff8df; border: 1px solid #f0d57d; border-radius: 6px; padding: 8px; }
    .danger { color: #a40e26; background: #fff0f2; border: 1px solid #f0b8c1; border-radius: 6px; padding: 8px; }
    .empty { background: #fff; border: 1px solid #dde3e6; border-radius: 8px; padding: 18px; }
    .footer { margin-top: 18px; color: #66727a; font-size: 13px; }
    code { background: #eef1f3; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>真实曲库问题谱面复核</h1>
        <p class="muted">生成时间：${htmlEscape(new Date().toLocaleString("zh-CN"))}；样本：${items.length}；来源：${htmlEscape(report.createdAt || "")}</p>
      </div>
      <p class="muted">需通过本地应用地址打开本页，不能直接 file:// 打开。</p>
    </header>
    ${items.length ? `<section class="review-grid">${rows}</section>` : `<section class="empty">没有可复核的 completed whole-piece 结果。</section>`}
    <p class="footer">会话数据已嵌入本页；点击按钮会写入 <code>${ISSUE_SESSION_STORAGE_PREFIX}</code> 下的 localStorage/sessionStorage，再打开问题谱面页。原始会话 JSON：${htmlEscape(path.basename(sessionsJsonPath))}；清单 JSON：${htmlEscape(path.basename(manifestJsonPath))}。</p>
  </main>
  <script id="score-issue-sessions" type="application/json">${jsonForScript(sessionPayloads)}</script>
  <script>
    const sessions = JSON.parse(document.getElementById("score-issue-sessions").textContent);
    const storagePrefix = ${JSON.stringify(ISSUE_SESSION_STORAGE_PREFIX)};
    const fallbackBaseUrl = ${JSON.stringify(baseUrl || "")};
    function appOrigin() {
      if (location.protocol === "http:" || location.protocol === "https:") return location.origin;
      return fallbackBaseUrl || "http://127.0.0.1:3000";
    }
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-session-id]");
      if (!button) return;
      const sessionId = button.dataset.sessionId;
      const payload = sessions[sessionId];
      if (!payload) return;
      const serialized = JSON.stringify(payload);
      try {
        window.localStorage.setItem(storagePrefix + sessionId, serialized);
        window.sessionStorage.setItem(storagePrefix + sessionId, serialized);
      } catch (error) {
        alert("无法写入浏览器会话缓存：" + error.message);
        return;
      }
      const url = new URL("/", appOrigin());
      url.searchParams.set("mode", "score-issues");
      url.searchParams.set("issueSession", sessionId);
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    });
  </script>
</body>
</html>`;
}

export async function writeScoreIssueReviewArtifacts(options = {}) {
  const runSummaryPath = options.runSummary
    ? path.resolve(REPO_ROOT, options.runSummary)
    : findLatestRunSummary();
  if (!runSummaryPath) {
    return { itemCount: 0, skipped: true, reason: "no-run-summary" };
  }
  const report = readJsonFile(runSummaryPath, null);
  if (!report) {
    return { itemCount: 0, skipped: true, reason: "unreadable-run-summary", runSummaryPath };
  }
  const outputDir = options.outputDir
    ? path.resolve(REPO_ROOT, options.outputDir)
    : path.dirname(runSummaryPath);
  await fs.mkdir(outputDir, { recursive: true });

  const scoreStore = readJsonFile(path.join(DATA_ROOT, "erhu-score-imports.json"), { scores: [] });
  const scoresById = new Map((scoreStore.scores || []).map((score) => [String(score.scoreId || ""), score]));
  const items = [];
  for (const result of report.results || []) {
    if (result?.status !== "completed") continue;
    const analysis = result?.piecePassJob?.wholePieceAnalysis;
    const scoreId = String(analysis?.scoreId || result?.importJob?.scoreId || "");
    const score = scoresById.get(scoreId);
    const item = buildReviewItem(result, score);
    if (item) items.push(item);
  }

  const publicItems = items.map(({ payload, ...item }) => ({
    ...item,
    issueScoreUrl: `/?mode=score-issues&issueSession=${encodeURIComponent(item.sessionId)}`,
  }));
  const sessions = Object.fromEntries(items.map((item) => [item.sessionId, item.payload]));
  const manifestPath = path.join(outputDir, "score-issue-review-manifest.json");
  const sessionsPath = path.join(outputDir, "score-issue-review-sessions.json");
  const htmlPath = path.join(outputDir, "score-issue-review.html");
  await fs.writeFile(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    runSummaryPath: path.relative(REPO_ROOT, runSummaryPath),
    itemCount: publicItems.length,
    items: publicItems,
  }, null, 2), "utf8");
  await fs.writeFile(sessionsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    storagePrefix: ISSUE_SESSION_STORAGE_PREFIX,
    sessions,
  }, null, 2), "utf8");
  await fs.writeFile(htmlPath, buildReviewHtml({
    report,
    items,
    baseUrl: options.baseUrl || report.baseUrl || "http://127.0.0.1:3000",
    sessionsJsonPath: sessionsPath,
    manifestJsonPath: manifestPath,
  }), "utf8");

  return {
    itemCount: items.length,
    htmlPath,
    htmlWebPath: toDataWebPath(htmlPath),
    manifestPath,
    manifestWebPath: toDataWebPath(manifestPath),
    sessionsPath,
    sessionsWebPath: toDataWebPath(sessionsPath),
  };
}

async function main() {
  const args = parseArgs();
  const result = await writeScoreIssueReviewArtifacts({
    runSummary: args.runSummary,
    outputDir: args.outputDir,
    baseUrl: args.baseUrl,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
