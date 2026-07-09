import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BENCHMARK = path.join("data", "experiments", "western-strings-m4", "omr-benchmark.json");
const DEFAULT_READINESS = path.join("data", "experiments", "western-strings-m4", "omr-readiness.json");
const DEFAULT_OUT_DIR = path.join("data", "experiments", "western-strings-m4");

function parseArgs(argv) {
  const args = {
    benchmark: DEFAULT_BENCHMARK,
    readiness: DEFAULT_READINESS,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--benchmark") args.benchmark = argv[++index] || args.benchmark;
    else if (arg === "--readiness") args.readiness = argv[++index] || args.readiness;
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

function buildTodoRows(report, readinessReport = {}) {
  const readinessRows = buildReadinessMap(readinessReport);
  return (report.rows || [])
    .filter((row) => row.goldEqualsDraftHash || row.benchmarkUsable === false)
    .map((row) => {
      const readiness = readinessRows.get(readinessKey(row)) || {};
      return {
        recordingId: row.recordingId || "",
        pieceId: row.pieceId || "",
        scoreId: readiness.scoreId || "",
        issue: row.blockingReason || "benchmark-row-not-usable",
        action: "Create independent human-corrected gold MusicXML/MXL from the source score image; do not reuse the Audiveris draft as gold.",
        sourceScorePath: readiness.sourceScorePath || "",
        goldPath: row.goldPath || "",
        draftPath: row.draftPath || "",
        goldEqualsDraftHash: row.goldEqualsDraftHash || "",
        parseOk: row.parseOk ? "yes" : "",
        goldNotes: row.goldNotes ?? "",
        draftNotes: row.draftNotes ?? "",
      };
    });
}

function buildMarkdown(report, todoRows) {
  const lines = [
    "# M4 independent gold score 校正清单",
    "",
    "本文件由 `npm run western:m4-independent-gold-todo` 生成。",
    "",
    "目的：M4 OMR 准确率只能用 **独立人工校正的 gold score** 评估。",
    "如果 clean score 与 Audiveris draft 完全同 SHA-1，系统会判定为 self-comparison，并阻止把 100% 自比结果当作 OMR 证据。",
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
    "2. 对照原谱检查当前 `goldPath` 或 `draftPath`。可以用 draft 当起点，但必须逐小节核对。",
    "3. 保存新的独立 gold MusicXML/MXL，不要直接复制 Audiveris draft。",
    "4. 运行 `npm run western:m4-independent-gold-workspace-audit`，确认 changed/approved 状态。",
    "5. 确认无误后，只把该行 `reviewStatus` 改为 `approved`。",
    "6. 先运行 `npm run western:m4-apply-independent-gold-workspace -- --dry-run`。",
    "7. dry-run 只显示预期行会 apply 后，再正式运行 apply 和 `npm run western:m4-omr-benchmark`。",
    "",
    "## 待处理行",
    "",
    "| # | recordingId | pieceId | scoreId | issue | sourceScorePath | current goldPath | draftPath | notes |",
    "|---:|---|---|---|---|---|---|---|---|",
  ];
  todoRows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.recordingId} | ${row.pieceId} | ${row.scoreId} | ${row.issue} | \`${row.sourceScorePath}\` | \`${row.goldPath}\` | \`${row.draftPath}\` | goldNotes=${row.goldNotes}; draftNotes=${row.draftNotes}; parseOk=${row.parseOk} |`,
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
            <h3>谱面编辑动作</h3>
            <ol>
              <li>只做谱面 gold 校正，不做教师音频诊断。</li>
              <li>打开左侧原谱图片，逐小节核对当前 gold 或 Audiveris draft。</li>
              <li>保存新的独立 gold MusicXML/MXL，不要直接复制 Audiveris draft。</li>
              <li>运行 <code>npm run western:m4-independent-gold-workspace-audit</code> 检查状态。</li>
              <li>确认无误后，把 workspace CSV 中该行 <code>reviewStatus</code> 改为 <code>approved</code>。</li>
              <li>正式应用前必须先 dry-run。</li>
            </ol>
            <dl>
              <dt>sourceScorePath</dt><dd>${renderPathLink(outDir, row.sourceScorePath)}</dd>
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
    dt { margin-top: 10px; font-weight: 700; font-size: 13px; color: #374151; }
    dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    a { color: #0f5e9c; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } .score { border-right: 0; border-bottom: 1px solid #e4e9f0; } }
  </style>
</head>
<body>
  <header>
    <h1>M4 independent gold score 校正清单</h1>
    <p class="muted">用途：防止把 Audiveris draft 与自身比较得到的 100% 误当成 OMR 准确率。只有人工独立校正的 gold score 才能用于 M4 评估。本页不是教师音频诊断复核。</p>
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
  const outDir = path.resolve(process.cwd(), args.outDir);
  const report = JSON.parse(await fs.readFile(benchmarkPath, "utf8"));
  const readinessReport = JSON.parse(await fs.readFile(readinessPath, "utf8"));
  const todoRows = buildTodoRows(report, readinessReport);
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
    "goldPath",
    "draftPath",
    "goldEqualsDraftHash",
    "parseOk",
    "goldNotes",
    "draftNotes",
  ]);
  await fs.writeFile(mdPath, buildMarkdown(report, todoRows), "utf8");
  await fs.writeFile(htmlPath, buildHtml(report, todoRows, outDir), "utf8");
  console.log(JSON.stringify({
    ok: true,
    todoRows: todoRows.length,
    benchmark: args.benchmark,
    readiness: args.readiness,
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
