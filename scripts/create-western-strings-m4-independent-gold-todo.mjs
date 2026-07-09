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
        action: "Open sourceScorePath, verify/correct the score, save a new independent gold MXL/MusicXML, update goldPath, then rerun npm run western:m4-omr-benchmark.",
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
    "# M4 独立 gold score 校正清单",
    "",
    "本文件由 `npm run western:m4-independent-gold-todo` 生成。",
    "",
    "目的：M4 OMR 准确率只能用**独立人工校正的 gold score**评估。",
    "如果 approved clean score 与 Audiveris 草稿完全同 SHA-1，系统会判为自比 self-comparison，并阻止把 100% 当作 OMR 证据。",
    "",
    "当 `goldEqualsDraftHash=yes` 时，当前 draft-vs-gold 的 100% 匹配不是模型准确率证据。",
    "",
    "## 当前摘要",
    "",
    `- benchmark 行数：${report.counts?.rows ?? 0}`,
    `- 可解析草稿：${report.counts?.parseOkRows ?? 0}`,
    `- 可用于 OMR 准确率评估的行：${report.counts?.usableBenchmarkRows ?? 0}`,
    `- 被判为自比的行：${report.counts?.selfComparisonRows ?? 0}`,
    `- M4 draft quality ready：${report.gate?.m4OmrDraftQualityReady ? "yes" : "no"}`,
    "",
    "## 人工需要做什么",
    "",
    "对下面每一行：",
    "",
    "1. 打开 `sourceScorePath` 的原始谱面图片/PDF。",
    "2. 对照原谱人工检查当前 `goldPath` 或 `draftPath`。可以用 draft 当起点，但必须逐小节核对。",
    "3. 将人工确认后的谱保存成**新的独立 gold MusicXML/MXL**，不要直接覆盖 Audiveris draft。",
    "4. 更新 `goldPath` 或 clean-score intake，让它指向这个独立 gold 文件。",
    "5. 重新运行 `npm run western:m4-omr-benchmark`。",
    "6. 只有 `usableBenchmarkRows > 0` 且指标过线，M4 才能继续讨论 release gate；学生端默认仍 fail-closed。",
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
  console.log(JSON.stringify({
    ok: true,
    todoRows: todoRows.length,
    benchmark: args.benchmark,
    readiness: args.readiness,
    csv: path.relative(process.cwd(), csvPath).replace(/\\/g, "/"),
    markdown: path.relative(process.cwd(), mdPath).replace(/\\/g, "/"),
    readyForOmrAccuracyClaim: todoRows.length === 0 && Boolean(report.gate?.m4OmrDraftQualityReady),
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
