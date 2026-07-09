import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BENCHMARK = path.join("data", "experiments", "western-strings-m4", "omr-benchmark.json");
const DEFAULT_READINESS = path.join("data", "experiments", "western-strings-m4", "omr-readiness.json");
const DEFAULT_NOTE_SUMMARY = path.join("data", "experiments", "western-strings-m4", "independent-gold-note-summary.json");
const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m4");
const DEFAULT_EDITABLE_GOLD_DIR = path.join("data", "private", "western-strings-m4-independent-gold");

function parseArgs(argv) {
  const args = {
    benchmark: DEFAULT_BENCHMARK,
    readiness: DEFAULT_READINESS,
    noteSummary: DEFAULT_NOTE_SUMMARY,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--benchmark") args.benchmark = argv[++index] || args.benchmark;
    else if (arg === "--readiness") args.readiness = argv[++index] || args.readiness;
    else if (arg === "--note-summary") args.noteSummary = argv[++index] || args.noteSummary;
    else if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
  }
  return args;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(filePath, rows, columns) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ].join("\n") + "\n";
  await fs.writeFile(filePath, text, "utf8");
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readinessKey(row = {}) {
  return `${row.recordingId || ""}::${row.pieceId || ""}`;
}

function buildReadinessMap(readinessReport) {
  const map = new Map();
  for (const row of readinessReport.rows || []) {
    map.set(readinessKey(row), row);
  }
  return map;
}

function buildNoteSummaryMap(noteSummaryReport) {
  const map = new Map();
  for (const row of noteSummaryReport?.rows || []) {
    map.set(readinessKey(row), row);
  }
  return map;
}

function editableGoldPathFor(row) {
  const pieceId = String(row.pieceId || "piece").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.join(DEFAULT_EDITABLE_GOLD_DIR, `${pieceId}.independent-gold.mxl`).replace(/\\/g, "/");
}

function buildTodoRows(report, readinessReport = {}, noteSummaryReport = {}) {
  const readinessRows = buildReadinessMap(readinessReport);
  const noteSummaryRows = buildNoteSummaryMap(noteSummaryReport);
  return (report.rows || [])
    .filter((row) => row.goldEqualsDraftHash || row.benchmarkUsable === false)
    .map((row) => {
      const readiness = readinessRows.get(readinessKey(row)) || {};
      const base = {
        recordingId: row.recordingId || "",
        pieceId: row.pieceId || "",
        scoreId: readiness.scoreId || "",
        issue: row.blockingReason || "benchmark-row-not-usable",
        action: "Create independent human-corrected gold MusicXML/MXL from the source score image; do not reuse the Audiveris draft as gold.",
        sourceScorePath: readiness.sourceScorePath || "",
        editableGoldPath: editableGoldPathFor(row),
        goldPath: row.goldPath || "",
        draftPath: row.draftPath || "",
        goldEqualsDraftHash: row.goldEqualsDraftHash || "",
        parseOk: row.parseOk ? "yes" : "",
        goldNotes: row.goldNotes ?? "",
        draftNotes: row.draftNotes ?? "",
      };
      const summary = noteSummaryRows.get(readinessKey(base)) || {};
      return {
        ...base,
        noteSummaryParseOk: summary.parseOk || "",
        noteSummaryMeasures: summary.measureCount ?? "",
        noteSummaryNotes: summary.noteCount ?? "",
        noteSummaryPitchRange: summary.pitchRange || "",
        noteSummaryFirstNotes: summary.firstNotes || "",
      };
    });
}

function buildMarkdown(report, todoRows) {
  const lines = [
    "# M4 independent gold score 校正清单",
    "",
    "本文件由 `npm run western:m4-independent-gold-todo` 生成。",
    "",
    "目的：M4 OMR 准确率只能用独立人工校正的 gold score 评估。",
    "如果 clean score 与 Audiveris draft 完全相同，系统会判定为 self-comparison，并阻止把 100% 自比结果当作 OMR 证据。",
    "",
    "这不是教师音频诊断复核。人工任务只是在谱面编辑器里对照原谱图片/PDF 校正 MusicXML/MXL。",
    "",
    "## 当前摘要",
    "",
    `- benchmark 行数：${report.counts?.rows ?? 0}`,
    `- 可解析草稿：${report.counts?.parseOkRows ?? 0}`,
    `- 可用于 OMR 准确率评估的行：${report.counts?.usableBenchmarkRows ?? 0}`,
    `- 被判为 self-comparison 的行：${report.counts?.selfComparisonRows ?? 0}`,
    `- M4 draft quality ready：${report.gate?.m4OmrDraftQualityReady ? "yes" : "no"}`,
    "",
    "## 谱面编辑人员需要做什么",
    "",
    "对下面每一行：",
    "",
    "1. 打开 `sourceScorePath` 的原始谱面图片/PDF。",
    "2. 先运行 `npm run western:m4-preflight`，让机器完成全部可自测项。",
    "3. 如需查看来源细节，运行 `npm run western:m4-gold-provenance-audit`。",
    "4. 查看机器音符摘要（小节数、音符数、音域、前几个音），先识别明显异常。",
    "5. 在谱面编辑器中打开 `editableGoldPath`，对照原谱逐小节校正。",
    "6. 保存新的独立 gold MusicXML/MXL，不要直接复制 Audiveris draft。",
    "7. 运行 `npm run western:m4-independent-gold-workspace-audit`，确认 changed/approved 状态。",
    "8. 确认无误后，只把该行 `reviewStatus` 改为 `approved`。",
    "9. 先运行 `npm run western:m4-apply-independent-gold-workspace -- --dry-run`。",
    "10. dry-run 只显示预期行会 apply 后，再正式运行 apply 和 `npm run western:m4-omr-benchmark`。",
    "",
    "## 待处理行",
    "",
    "| # | recordingId | pieceId | scoreId | sourceScorePath | editableGoldPath | machine summary | notes |",
    "|---:|---|---|---|---|---|---|---|",
  ];
  todoRows.forEach((row, index) => {
    const summary = `parse=${row.noteSummaryParseOk}; measures=${row.noteSummaryMeasures}; notes=${row.noteSummaryNotes}; range=${row.noteSummaryPitchRange}; first=${row.noteSummaryFirstNotes}`;
    lines.push(
      `| ${index + 1} | ${row.recordingId} | ${row.pieceId} | ${row.scoreId} | \`${row.sourceScorePath}\` | \`${row.editableGoldPath}\` | ${summary} | goldNotes=${row.goldNotes}; draftNotes=${row.draftNotes}; parseOk=${row.parseOk} |`,
    );
  });
  lines.push("");
  return lines.join("\n");
}

function relativeLink(fromDir, targetPath) {
  if (!targetPath) return "";
  const absolute = path.resolve(process.cwd(), targetPath);
  return path.relative(fromDir, absolute).replace(/\\/g, "/");
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|webp|gif)$/i.test(String(filePath || ""));
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPathLink(outDir, filePath) {
  const text = String(filePath || "");
  if (!text) return '<span class="muted">空</span>';
  const href = relativeLink(outDir, text);
  return `<a href="${htmlEscape(href)}" target="_blank" rel="noreferrer">${htmlEscape(text)}</a>`;
}

function renderMachineSummary(row) {
  if (!row.noteSummaryParseOk) {
    return '<p class="muted">尚未生成机器音符摘要。运行 <code>npm run western:m4-preflight</code>。</p>';
  }
  return `
    <div class="machine-summary">
      <h3>机器音符摘要</h3>
      <div class="summary-grid">
        <span>parse: <strong>${htmlEscape(row.noteSummaryParseOk)}</strong></span>
        <span>measures: <strong>${htmlEscape(row.noteSummaryMeasures)}</strong></span>
        <span>notes: <strong>${htmlEscape(row.noteSummaryNotes)}</strong></span>
        <span>range: <strong>${htmlEscape(row.noteSummaryPitchRange)}</strong></span>
      </div>
      <p class="first-notes">${htmlEscape(row.noteSummaryFirstNotes)}</p>
      <p class="muted">这只是机器预览，用来减少盲审；最终仍要对照原谱校正。</p>
    </div>
  `;
}

function buildHtml(report, todoRows, outDir) {
  const cards = todoRows.map((row, index) => {
    const sourceHref = relativeLink(outDir, row.sourceScorePath);
    const image = isImagePath(row.sourceScorePath)
      ? `<a href="${htmlEscape(sourceHref)}" target="_blank" rel="noreferrer"><img src="${htmlEscape(sourceHref)}" alt="${htmlEscape(row.pieceId)} 原谱"/></a>`
      : `<p><a href="${htmlEscape(sourceHref)}" target="_blank" rel="noreferrer">打开原谱文件</a></p>`;
    return `
      <section class="card">
        <div class="card-head">
          <div>
            <h2>${index + 1}. ${htmlEscape(row.pieceId)} / ${htmlEscape(row.recordingId)}</h2>
            <p class="muted">scoreId: ${htmlEscape(row.scoreId)} · issue: ${htmlEscape(row.issue)}</p>
          </div>
          <span class="pill">goldNotes=${htmlEscape(row.goldNotes)} · draftNotes=${htmlEscape(row.draftNotes)}</span>
        </div>
        <div class="grid">
          <div class="score">${image}</div>
          <div class="meta">
            ${renderMachineSummary(row)}
            <h3>谱面编辑动作</h3>
            <ol>
              <li>只做谱面 gold 校正，不做教师音频诊断。</li>
              <li>先运行 <code>npm run western:m4-preflight</code>，完成机器自测。</li>
              <li>如需查看来源细节，运行 <code>npm run western:m4-gold-provenance-audit</code>。</li>
              <li>打开左侧原谱图片，逐小节校对 <code>editableGoldPath</code>。</li>
              <li>保存新的独立 gold MusicXML/MXL，不要直接复制 Audiveris draft。</li>
              <li>运行 <code>npm run western:m4-independent-gold-workspace-audit</code> 检查状态。</li>
              <li>确认无误后，把 workspace CSV 中该行 <code>reviewStatus</code> 改为 <code>approved</code>。</li>
              <li>正式应用前必须先运行 <code>npm run western:m4-apply-independent-gold-workspace -- --dry-run</code>。</li>
            </ol>
            <dl>
              <dt>sourceScorePath</dt><dd>${renderPathLink(outDir, row.sourceScorePath)}</dd>
              <dt>editableGoldPath</dt><dd>${renderPathLink(outDir, row.editableGoldPath)}</dd>
              <dt>current goldPath</dt><dd>${renderPathLink(outDir, row.goldPath)}</dd>
              <dt>Audiveris draftPath</dt><dd>${renderPathLink(outDir, row.draftPath)}</dd>
              <dt>当前状态</dt><dd>goldEqualsDraftHash=${htmlEscape(row.goldEqualsDraftHash || "no")} · parseOk=${htmlEscape(row.parseOk || "")}</dd>
            </dl>
          </div>
        </div>
      </section>
    `;
  }).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>M4 independent gold score 校正清单</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #1f2933; }
    header { position: sticky; top: 0; z-index: 2; background: #fff; border-bottom: 1px solid #d7dde5; padding: 16px 24px; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    h2 { margin: 0; font-size: 18px; }
    h3 { margin: 0 0 8px; font-size: 15px; }
    code { background: #eef2f7; border-radius: 4px; padding: 1px 5px; }
    .summary { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .pill { display: inline-flex; align-items: center; border: 1px solid #c8d2df; border-radius: 999px; padding: 4px 10px; background: #fff; font-size: 13px; color: #3e4c59; }
    main { padding: 20px 24px 44px; }
    .card { background: #fff; border: 1px solid #d7dde5; border-radius: 10px; margin: 0 0 18px; overflow: hidden; box-shadow: 0 1px 2px rgba(15,23,42,0.05); }
    .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding: 14px 16px; border-bottom: 1px solid #e4e9f0; }
    .muted { color: #607080; font-size: 13px; margin: 4px 0 0; }
    .grid { display: grid; grid-template-columns: minmax(320px, 1.2fr) minmax(280px, 0.8fr); gap: 0; }
    .score { background: #f9fafb; padding: 12px; border-right: 1px solid #e4e9f0; }
    .score img { width: 100%; max-height: 720px; object-fit: contain; background: white; border: 1px solid #e4e9f0; }
    .meta { padding: 14px 16px; }
    .machine-summary { border: 1px solid #d7dde5; background: #f8fafc; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; }
    .summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; font-size: 13px; }
    .first-notes { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.45; background: #fff; border: 1px solid #e4e9f0; border-radius: 6px; padding: 8px; overflow-wrap: anywhere; }
    dt { margin-top: 10px; font-weight: 700; font-size: 13px; color: #374151; }
    dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    a { color: #0f5e9c; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } .score { border-right: 0; border-bottom: 1px solid #e4e9f0; } }
  </style>
</head>
<body>
  <header>
    <h1>M4 independent gold score 校正清单</h1>
    <p class="muted">用途：防止把 Audiveris draft 与自身比较得到的 100% 误当作 OMR 准确率。只有人工独立校正的 gold score 才能用于 M4 评估。本页不是教师音频诊断复核。</p>
    <div class="summary">
      <span class="pill">benchmark 行数: ${htmlEscape(report.counts?.rows ?? 0)}</span>
      <span class="pill">可解析草稿: ${htmlEscape(report.counts?.parseOkRows ?? 0)}</span>
      <span class="pill">可用 gold 行: ${htmlEscape(report.counts?.usableBenchmarkRows ?? 0)}</span>
      <span class="pill">self-comparison: ${htmlEscape(report.counts?.selfComparisonRows ?? 0)}</span>
      <span class="pill">draft quality ready: ${report.gate?.m4OmrDraftQualityReady ? "yes" : "no"}</span>
    </div>
  </header>
  <main>
    ${cards || "<p>没有待处理项。</p>"}
  </main>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const benchmarkPath = path.resolve(process.cwd(), args.benchmark);
  const readinessPath = path.resolve(process.cwd(), args.readiness);
  const noteSummaryPath = path.resolve(process.cwd(), args.noteSummary);
  const outDir = path.resolve(process.cwd(), args.outDir);
  const report = JSON.parse(await fs.readFile(benchmarkPath, "utf8"));
  const readinessReport = JSON.parse(await fs.readFile(readinessPath, "utf8"));
  const noteSummaryReport = await readJsonOptional(noteSummaryPath);
  const todoRows = buildTodoRows(report, readinessReport, noteSummaryReport || {});
  const csvPath = path.join(outDir, "independent-gold-todo.csv");
  const mdPath = path.join(outDir, "independent-gold-todo.md");
  const htmlPath = path.join(outDir, "independent-gold-todo.html");
  await writeCsv(csvPath, todoRows, [
    "recordingId",
    "pieceId",
    "scoreId",
    "issue",
    "action",
    "sourceScorePath",
    "editableGoldPath",
    "goldPath",
    "draftPath",
    "goldEqualsDraftHash",
    "parseOk",
    "goldNotes",
    "draftNotes",
    "noteSummaryParseOk",
    "noteSummaryMeasures",
    "noteSummaryNotes",
    "noteSummaryPitchRange",
    "noteSummaryFirstNotes",
  ]);
  await fs.writeFile(mdPath, buildMarkdown(report, todoRows), "utf8");
  await fs.writeFile(htmlPath, buildHtml(report, todoRows, outDir), "utf8");
  console.log(JSON.stringify({
    ok: true,
    todoRows: todoRows.length,
    benchmark: args.benchmark,
    readiness: args.readiness,
    noteSummary: args.noteSummary,
    csv: path.relative(process.cwd(), csvPath).replace(/\\/g, "/"),
    markdown: path.relative(process.cwd(), mdPath).replace(/\\/g, "/"),
    html: path.relative(process.cwd(), htmlPath).replace(/\\/g, "/"),
    readyForOmrAccuracyClaim: todoRows.length === 0 && Boolean(report.gate?.m4OmrDraftQualityReady),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
