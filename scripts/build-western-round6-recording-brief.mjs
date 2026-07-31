import fs from "node:fs";
import path from "node:path";

// Derives a performer-facing recording brief from the frozen Round 6 truth.
// READ ONLY with respect to the protocol: position-truth.json and manifest.csv
// are two of the 13 frozen sourceBindings, so this script never writes to them.
// It only emits a new derived sheet next to the materials.
//
//   node scripts/build-western-round6-recording-brief.mjs
const repoRoot = process.cwd();
const packDir = path.join(repoRoot, "data", "private", "western-strings-round6-counterbalanced");
const truth = JSON.parse(fs.readFileSync(path.join(packDir, "position-truth.json"), "utf8"));

const manifestRows = fs.readFileSync(path.join(packDir, "manifest.csv"), "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .slice(1)
  .map((line) => {
    const [recordingId, pieceId, performerId, deviceId, roomId, split] = line.replace(/^﻿/, "").split(",");
    return { recordingId, pieceId, performerId, deviceId, roomId, split };
  });

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(midi) {
  if (!Number.isInteger(midi)) return "";
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

const stageA = manifestRows.filter((row) => row.split === "calibration");
const pieces = [...new Set(stageA.map((row) => row.pieceId))];

const lines = [
  "# Round 6 Stage A 录制总表（派生文档，可重新生成）",
  "",
  "由 `node scripts/build-western-round6-recording-brief.mjs` 从 `position-truth.json` 直接生成。",
  "本文件是派生说明，不是合同；真值以 `position-truth.json` 为准。",
  "",
  "## 通用规则",
  "",
  "- 每条录音都要**从头到尾完整拉完 18 小节**，只在下表列出的位置按标签处理，其余全部正常演奏。",
  "- 一条录音 = 一个完整 take，中间不剪辑、不拼接、不重录接续。",
  "- 手机录 m4a 即可，**关闭降噪/美化/自动增益**。",
  "- 文件名必须严格等于录音 ID，例如 `r6-cal-a-01.m4a`。",
  "",
  "## 为什么必须三遍都录",
  "",
  "同一个小节位置在三遍里轮换成「真错误」和两种「混淆负例」。上一轮（Round 5）就是没做这个轮换，",
  "结果标签能直接从谱面位置推出来（静态特征即可 `12/12 @ 0 误报`），整批数据作废。",
  "**只录其中一遍、或改变错误落在哪个小节，这批数据同样作废。**",
  "",
];

// The tag vocabulary is fixed, so the action text is explained once instead of
// being repeated in every cell.
const legend = new Map();
for (const recording of Object.values(truth.recordings || {})) {
  for (const event of recording.events || []) {
    if (!legend.has(event.scoreTag)) legend.set(event.scoreTag, event.plannedPerformance);
  }
}
lines.push("## 标签含义（★ = 真错误，○ = 混淆负例：听感接近但**不是**错误）", "");
lines.push("| 标签 | 怎么拉 |", "|---|---|");
for (const [tag, action] of legend) lines.push(`| ${tag} | ${action} |`);
lines.push("");

for (const pieceId of pieces) {
  const takes = stageA.filter((row) => row.pieceId === pieceId);
  lines.push(`## ${pieceId}`, "");
  lines.push("| 第几遍 | 录音 ID | 演奏者 | 设备 | 房间 |", "|---|---|---|---|---|");
  takes.forEach((take, index) => {
    lines.push(`| 第 ${index + 1} 遍 | \`${take.recordingId}\` | ${take.performerId} | ${take.deviceId} | ${take.roomId} |`);
  });
  lines.push("");

  // Rows are score positions; columns are the three takes. Reading across a row
  // shows exactly what changes between takes at that measure.
  const byMeasure = new Map();
  takes.forEach((take, index) => {
    for (const event of truth.recordings?.[take.recordingId]?.events || []) {
      if (!byMeasure.has(event.measure)) {
        byMeasure.set(event.measure, { beat: event.beat, scoreMidi: event.scoreMidi, cells: ["", "", ""] });
      }
      byMeasure.get(event.measure).cells[index] = event.scoreTag;
    }
  });

  lines.push(`### ${pieceId} 三遍对照（横着读 = 这个位置每遍怎么变）`, "");
  lines.push(
    `| 小节 | 拍 | 目标音 | ${takes.map((take, index) => `第 ${index + 1} 遍 (${take.recordingId.slice(-2)})`).join(" | ")} |`,
    `|---:|---:|---|${takes.map(() => "---").join("|")}|`,
  );
  for (const [measure, row] of [...byMeasure.entries()].sort((a, b) => a[0] - b[0])) {
    const target = `${noteName(row.scoreMidi)} (${row.scoreMidi})`;
    lines.push(`| ${measure} | ${row.beat} | ${target} | ${row.cells.join(" | ")} |`);
  }
  lines.push("");

  const counts = takes.map((take) => {
    const events = truth.recordings?.[take.recordingId]?.events || [];
    return {
      id: take.recordingId,
      positives: events.filter((event) => event.label === "positive").length,
      negatives: events.filter((event) => event.label === "confusion_negative").length,
    };
  });
  lines.push("每遍事件数（自查用）：", "");
  for (const item of counts) lines.push(`- \`${item.id}\`：★ 真错误 ${item.positives} 个，○ 混淆负例 ${item.negatives} 个`);
  lines.push("");
}

const outPath = path.join(packDir, "Stage-A-录制总表.md");
fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  out: path.relative(repoRoot, outPath).replace(/\\/g, "/"),
  pieces,
  takes: stageA.length,
  wroteProtocolFiles: false,
}, null, 2));
