import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  return dataRows.map((dataRow) => Object.fromEntries(headers.map((header, index) => [header, dataRow[index] ?? ""])));
}

function numeric(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function selectLatestValidRun(runs = []) {
  const validRuns = runs.filter((run) => !run?._invalidJsonLine);
  return validRuns.length ? [validRuns[validRuns.length - 1]] : runs;
}

async function readCandidateArtifact(repoRoot, candidateRowsPath) {
  const resolved = path.resolve(repoRoot, candidateRowsPath);
  const artifact = JSON.parse(await fs.readFile(resolved, "utf8"));
  return {
    artifactPath: path.relative(repoRoot, resolved).replace(/\\/g, "/"),
    rows: asArray(artifact.candidateRows),
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function controlledCandidateKey(row = {}) {
  return [
    safeString(row.batchRunId),
    safeString(row.submissionId),
    safeString(row.candidateId),
  ].join("::");
}

function hasReviewLabel(row = {}) {
  return ["usable", "wrong", "uncertain"].includes(safeString(row.teacherCandidateStatus).trim().toLowerCase());
}

async function readReviewedCandidateKeys({
  repoRoot = process.cwd(),
  labelsPath = path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
} = {}) {
  const resolvedLabelsPath = path.resolve(repoRoot, labelsPath);
  try {
    const rows = parseCsv(await fs.readFile(resolvedLabelsPath, "utf8"));
    return new Set(rows.filter(hasReviewLabel).map(controlledCandidateKey).filter((key) => key.replace(/:/g, "")));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

function audioExtensionFromName(name = "") {
  const ext = path.extname(safeString(name)).toLowerCase();
  return ext || ".m4a";
}

async function attachLocalAudioFiles(rows = [], {
  repoRoot = process.cwd(),
  outDir = "",
  submissionsPath = path.join("data", "experiments", "western-strings-m3", "controlled-submissions.jsonl"),
} = {}) {
  const submissions = await readJsonl(path.resolve(repoRoot, submissionsPath));
  const submissionById = new Map(submissions.map((submission) => [safeString(submission.submissionId), submission]));
  const audioDir = path.join(outDir, "audio");
  const clipDir = path.join(outDir, "clips");
  const scoreImageDir = path.join(outDir, "score-images");
  await fs.rm(audioDir, { recursive: true, force: true });
  await fs.rm(clipDir, { recursive: true, force: true });
  await fs.rm(scoreImageDir, { recursive: true, force: true });
  await fs.mkdir(audioDir, { recursive: true });
  await fs.mkdir(clipDir, { recursive: true });
  await fs.mkdir(scoreImageDir, { recursive: true });
  const copiedBySubmission = new Map();

  for (const [rowIndex, row] of rows.entries()) {
    const submissionId = safeString(row.submissionId);
    if (!submissionId) continue;

    const submission = submissionById.get(submissionId) || {};
    const ext = audioExtensionFromName(submission.audioSubmission?.name || row.audioName);
    const candidates = [];
    const storedAudioPath = safeString(submission.audioPath);
    if (storedAudioPath) candidates.push(path.resolve(storedAudioPath));
    const audioHash = safeString(row.audioHash || submission.audioHash);
    if (audioHash) {
      candidates.push(path.resolve(repoRoot, "data", "analysis-audio-cache", `${audioHash}${ext}`));
      for (const fallbackExt of [".m4a", ".mp3", ".wav", ".aac", ".flac"]) {
        candidates.push(path.resolve(repoRoot, "data", "analysis-audio-cache", `${audioHash}${fallbackExt}`));
      }
    }

    let sourceAudioPath = "";
    for (const candidate of candidates) {
      if (candidate && await fileExists(candidate)) {
        sourceAudioPath = candidate;
        break;
      }
    }
    if (!sourceAudioPath) continue;

    if (copiedBySubmission.has(submissionId)) {
      row.localAudioPath = copiedBySubmission.get(submissionId);
    } else {
      const targetExt = path.extname(sourceAudioPath) || ext;
      const targetPath = path.join(audioDir, `${submissionId}${targetExt}`);
      if (!await fileExists(targetPath)) await fs.copyFile(sourceAudioPath, targetPath);
      const relativeAudioPath = path.relative(outDir, targetPath).replace(/\\/g, "/");
      copiedBySubmission.set(submissionId, relativeAudioPath);
      row.localAudioPath = relativeAudioPath;
    }

    const predictedSeconds = numeric(row.predictedOnsetSeconds, 0) || 0;
    const clipStart = Math.max(0, predictedSeconds - 2);
    row.localClipStartSeconds = Number(clipStart.toFixed(3));
    row.localClipCueSeconds = Number(Math.max(0, predictedSeconds - clipStart).toFixed(3));
    const clipName = `candidate-${String(rowIndex + 1).padStart(2, "0")}-${submissionId}.wav`;
    const clipPath = path.join(clipDir, clipName);
    if (!await fileExists(clipPath)) {
      try {
        await execFileAsync("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          String(clipStart.toFixed(3)),
          "-t",
          "6",
          "-i",
          sourceAudioPath,
          "-ac",
          "1",
          "-ar",
          "44100",
          clipPath,
        ], { windowsHide: true });
      } catch {
        // Keep the full local audio fallback if ffmpeg is unavailable or this source fails.
      }
    }
    if (await fileExists(clipPath)) row.localClipPath = path.relative(outDir, clipPath).replace(/\\/g, "/");

    const piece = safeString(row.piece);
    const scoreSourcePath = piece ? path.resolve(repoRoot, "data", "private", "western-strings-m2", `${piece}-score.jpg`) : "";
    if (scoreSourcePath && await fileExists(scoreSourcePath)) {
      const scoreTargetPath = path.join(scoreImageDir, `${piece}-score.jpg`);
      if (!await fileExists(scoreTargetPath)) await fs.copyFile(scoreSourcePath, scoreTargetPath);
      row.localScoreImagePath = path.relative(outDir, scoreTargetPath).replace(/\\/g, "/");
    }
  }
}

export async function collectControlledCandidateReviewRows({
  repoRoot = process.cwd(),
  source = path.join("data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"),
  latestOnly = true,
} = {}) {
  const sourcePath = path.resolve(repoRoot, source);
  const allRuns = await readJsonl(sourcePath);
  const runs = latestOnly ? selectLatestValidRun(allRuns) : allRuns;
  const rows = [];
  const skipped = [];
  for (const run of runs) {
    for (const item of asArray(run.items)) {
      if (item.analysisStatus !== "offline_feature_review_ready") continue;
      const candidateRowsPath = safeString(item.candidateRowsPath);
      if (!candidateRowsPath) {
        skipped.push({
          batchRunId: safeString(run.batchRunId),
          submissionId: safeString(item.submissionId),
          reason: "candidateRowsPath-missing",
        });
        continue;
      }
      let artifact;
      try {
        artifact = await readCandidateArtifact(repoRoot, candidateRowsPath);
      } catch (error) {
        skipped.push({
          batchRunId: safeString(run.batchRunId),
          submissionId: safeString(item.submissionId),
          candidateRowsPath,
          reason: "candidateRowsPath-unreadable",
          error: String(error?.message || error),
        });
        continue;
      }
      for (const candidate of artifact.rows) {
        rows.push({
          reviewRowNumber: rows.length + 1,
          batchRunId: safeString(run.batchRunId),
          submissionId: safeString(item.submissionId),
          scoreId: safeString(item.scoreId),
          piece: safeString(item.piece),
          recordingId: safeString(item.recordingId),
          audioName: safeString(item.audioSubmission?.name),
          audioHash: safeString(item.audioHash),
          candidateRowsPath: artifact.artifactPath,
          candidateId: safeString(candidate.candidateId),
          noteId: safeString(candidate.noteId),
          noteIndex: candidate.noteIndex ?? "",
          sectionId: safeString(candidate.sectionId),
          sectionTitle: safeString(candidate.sectionTitle),
          measureIndex: candidate.measureIndex ?? "",
          pageNumber: candidate.pageNumber ?? "",
          midi: candidate.midi ?? "",
          predictedOnsetSeconds: candidate.predictedOnsetSeconds ?? "",
          method: safeString(candidate.method),
          analysisMode: safeString(candidate.analysisMode),
          voicedFrameCount: candidate.voicedFrameCount ?? "",
          medianObservedMidi: candidate.medianObservedMidi ?? "",
          centsError: candidate.centsError ?? "",
          pitchSupportWithin80Cents: candidate.pitchSupportWithin80Cents === true ? "yes" : "no",
          gateDecision: safeString(candidate.gateDecision),
          gateReason: safeString(candidate.gateReason),
          gateVersion: safeString(candidate.gateVersion),
          studentFacing: candidate.studentFacing === true ? "yes" : "no",
          teacherCandidateStatus: "",
          teacherCorrectOnsetSeconds: "",
          teacherCorrectMeasureIndex: "",
          teacherComments: "",
        });
      }
    }
  }
  return {
    source: path.relative(repoRoot, sourcePath).replace(/\\/g, "/"),
    runMode: latestOnly ? "latest" : "all",
    rows,
    skipped,
  };
}

export const CONTROLLED_CANDIDATE_REVIEW_HEADERS = [
  "reviewRowNumber",
  "batchRunId",
  "submissionId",
  "scoreId",
  "piece",
  "recordingId",
  "audioName",
  "audioHash",
  "candidateRowsPath",
  "candidateId",
  "noteId",
  "noteIndex",
  "sectionId",
  "sectionTitle",
  "measureIndex",
  "pageNumber",
  "midi",
  "predictedOnsetSeconds",
  "method",
  "analysisMode",
  "voicedFrameCount",
  "medianObservedMidi",
  "centsError",
  "pitchSupportWithin80Cents",
  "gateDecision",
  "gateReason",
  "gateVersion",
  "studentFacing",
  "teacherCandidateStatus",
  "teacherCorrectOnsetSeconds",
  "teacherCorrectMeasureIndex",
  "teacherComments",
];

export function controlledCandidateRowsToCsv(rows) {
  return `${CONTROLLED_CANDIDATE_REVIEW_HEADERS.join(",")}\n${rows.map((row) => (
    CONTROLLED_CANDIDATE_REVIEW_HEADERS.map((header) => csvEscape(row[header])).join(",")
  )).join("\n")}\n`;
}

export function selectCandidateReviewSample(rows = [], { limit = 30 } = {}) {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0 || rows.length <= numericLimit) return rows;
  const groups = new Map();
  for (const row of rows) {
    const key = safeString(row.submissionId, "unknown-submission");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const selected = [];
  const groupedRows = [...groups.values()];
  let cursor = 0;
  while (selected.length < numericLimit) {
    let added = false;
    for (const group of groupedRows) {
      if (group[cursor]) {
        selected.push(group[cursor]);
        added = true;
        if (selected.length >= numericLimit) break;
      }
    }
    if (!added) break;
    cursor += 1;
  }
  return selected;
}

export function isGateCandidateReviewRow(row = {}) {
  if (safeString(row.pitchSupportWithin80Cents).toLowerCase() === "yes") return true;
  const centsError = numeric(row.centsError);
  const voicedFrameCount = numeric(row.voicedFrameCount, 0);
  return centsError !== null && Math.abs(centsError) <= 80 && voicedFrameCount >= 2;
}

function buildReviewGuideMarkdown(rows = [], { totalRowCount = rows.length } = {}) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${safeString(row.piece, "unknown-piece")} / ${safeString(row.recordingId, "unknown-recording")}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const lines = [
    "# 普通上传候选复核指南",
    "",
    `当前抽样 ${rows.length} 条；最新 batch 候选总数 ${totalRowCount} 条。`,
    "",
    "## 标注口径",
    "- `usable`: 候选确实对应该谱面音符, 可以作为后续校准正例。",
    "- `wrong`: 候选明显错位、音高不对应, 或不能作为该谱面音符证据。",
    "- `uncertain`: 听不清、谱面位置无法确认, 或只能给定性判断。该状态不计入校准 precision。",
    "",
    "第一轮至少需要 30 条 `usable` 或 `wrong`。标完后在网页下载 `controlled-candidate-review.completed.csv`。",
    "",
    "## 抽样分组",
    "",
  ];
  for (const [group, groupRows] of grouped.entries()) {
    lines.push(`### ${group}`, "");
    lines.push("| 行号 | 预测秒 | 页 | 小节 | MIDI | 音高支持 | centsError | 候选 |");
    lines.push("|---:|---:|---:|---:|---:|---|---:|---|");
    for (const row of groupRows) {
      const cells = [
        row.reviewRowNumber,
        row.predictedOnsetSeconds,
        row.pageNumber,
        row.measureIndex,
        row.midi,
        row.pitchSupportWithin80Cents,
        row.centsError,
        safeString(row.candidateId),
      ].map((cell) => String(cell ?? "").replace(/\|/g, "\\|"));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function renderControlledCandidateReviewHtml(rows = [], {
  serverOrigin = "http://127.0.0.1:3000",
  totalRowCount = rows.length,
} = {}) {
  const payload = JSON.stringify(rows).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>普通上传候选复核</title>
  <style>
    body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f5f7fb; color: #172033; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    header { position: sticky; top: 0; z-index: 2; background: rgba(245,247,251,.96); border-bottom: 1px solid #d8dee9; padding: 16px 24px; margin: -24px -24px 20px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    code { background: #e2e8f0; border-radius: 4px; padding: 1px 4px; }
    .hint { color: #526070; line-height: 1.55; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
    button { border: 0; background: #1d4ed8; color: white; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-weight: 700; }
    button.secondary { background: #475569; }
    button.ghost { background: #64748b; }
    button.good { background: #15803d; }
    button.bad { background: #b91c1c; }
    button.warn { background: #b45309; }
    input { padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; min-width: 260px; }
    .card { background: white; border: 1px solid #d8dee9; border-radius: 8px; padding: 14px; margin: 14px 0; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
    .card.reviewed { opacity: .82; }
    .meta { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 8px; margin: 10px 0; }
    .meta div { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; }
    .label { display: block; color: #64748b; font-size: 12px; margin-bottom: 4px; }
    audio { width: 100%; margin: 8px 0; }
    .audio-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0 10px; }
    textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; min-height: 48px; }
    .status { font-weight: 700; }
    .empty { background: white; border: 1px dashed #94a3b8; border-radius: 8px; padding: 24px; }
    @media (max-width: 900px) { .meta { grid-template-columns: repeat(2, minmax(120px, 1fr)); } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>普通上传候选复核</h1>
      <p class="hint">用途：给 review-only pYIN 线性谱面候选打标签，用来校准后续 student-safe gate。这里的候选不能直接给学生反馈。</p>
      <p class="hint">当前显示 <strong>${rows.length}</strong> 条候选；最新 batch 候选总数 <strong>${totalRowCount}</strong> 条。默认按录音轮转抽样，满足第一轮至少 30 条复核的门槛。若 gate 评估提示没有规则被选中,运行 <code>npm run western:controlled-candidate-review-export -- --gate-candidates</code> 抽可校准候选。需要全量导出时运行 <code>npm run western:controlled-candidate-review-export -- --all</code>。</p>
      <div class="actions">
        <label>后台地址 <input id="serverOrigin" value="${htmlEscape(serverOrigin)}" /></label>
        <button type="button" id="downloadCsv">下载复核 CSV</button>
        <button type="button" class="secondary" id="showRemaining">只看未标</button>
        <button type="button" class="good" id="markRemainingUsable">一键未标=可用</button>
        <button type="button" class="bad" id="markRemainingWrong">一键未标=错误</button>
        <button type="button" class="warn" id="markRemainingUncertain">一键未标=不确定</button>
        <button type="button" class="ghost" id="clearAllMarks">清空本页标注</button>
        <span id="summary" class="hint"></span>
      </div>
    </header>
    <section id="rows"></section>
  </main>
  <script>
    const REVIEW_ROWS = ${payload};
    const TOTAL_ROW_COUNT = ${Number(totalRowCount) || rows.length};
    const state = new Map(REVIEW_ROWS.map((row, index) => [String(index), {
      teacherCandidateStatus: row.teacherCandidateStatus || "",
      teacherCorrectOnsetSeconds: row.teacherCorrectOnsetSeconds || "",
      teacherCorrectMeasureIndex: row.teacherCorrectMeasureIndex || "",
      teacherComments: row.teacherComments || ""
    }]));
    let onlyRemaining = false;
    const headers = ${JSON.stringify(CONTROLLED_CANDIDATE_REVIEW_HEADERS)};
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function csvEscape(value) {
      const text = String(value ?? "");
      return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    function audioUrl(row) {
      const origin = document.getElementById("serverOrigin").value.replace(/\\/$/, "");
      return origin + "/api/strings/controlled-submissions/" + encodeURIComponent(row.submissionId) + "/audio";
    }
    async function toggleAudio(index) {
      const audio = document.getElementById("audio-" + index);
      if (!audio) return;
      try {
        if (audio.paused) await audio.play();
        else audio.pause();
      } catch (error) {
        alert("音频无法播放。请确认后台地址正确,并且 :3000 服务正在运行。\\n" + (error && error.message ? error.message : error));
      }
    }
    function seekCandidate(index, seconds) {
      const audio = document.getElementById("audio-" + index);
      const numericSeconds = Number(seconds);
      if (!audio || !Number.isFinite(numericSeconds)) return;
      audio.currentTime = Math.max(0, numericSeconds);
      audio.focus();
    }
    function mark(index, status) {
      const next = state.get(String(index)) || {};
      next.teacherCandidateStatus = status;
      state.set(String(index), next);
      render();
    }
    function bulkMark(status, onlyBlank = true) {
      const label = status === "usable" ? "候选可用" : status === "wrong" ? "候选错误" : status === "uncertain" ? "不确定" : "空白";
      const affected = [];
      for (const [key, value] of state.entries()) {
        if (!onlyBlank || !value.teacherCandidateStatus) affected.push(key);
      }
      if (!affected.length) return;
      if (!confirm("将 " + affected.length + " 条" + (onlyBlank ? "未标候选" : "候选") + "标为：" + label + "。继续？")) return;
      for (const key of affected) {
        const next = state.get(key) || {};
        next.teacherCandidateStatus = status;
        state.set(key, next);
      }
      render();
    }
    function syncInput(index, key, value) {
      const next = state.get(String(index)) || {};
      next[key] = value;
      state.set(String(index), next);
      updateSummary();
    }
    function updateSummary() {
      let ok = 0, wrong = 0, uncertain = 0, blank = 0;
      for (const item of state.values()) {
        if (item.teacherCandidateStatus === "usable") ok += 1;
        else if (item.teacherCandidateStatus === "wrong") wrong += 1;
        else if (item.teacherCandidateStatus === "uncertain") uncertain += 1;
        else blank += 1;
      }
      document.getElementById("summary").textContent = "显示 " + REVIEW_ROWS.length + " / 总数 " + TOTAL_ROW_COUNT + " | 可用 " + ok + " | 错误 " + wrong + " | 不确定 " + uncertain + " | 未标 " + blank;
    }
    function render() {
      const root = document.getElementById("rows");
      const parts = [];
      REVIEW_ROWS.forEach((row, index) => {
        const review = state.get(String(index)) || {};
        if (onlyRemaining && review.teacherCandidateStatus) return;
        const reviewedClass = review.teacherCandidateStatus ? " reviewed" : "";
        parts.push(\`
          <article class="card\${reviewedClass}">
            <h2>#\${escapeHtml(row.reviewRowNumber || index + 1)} <span class="status">\${escapeHtml(review.teacherCandidateStatus || "未标")}</span></h2>
            <audio id="audio-\${index}" controls preload="metadata" src="\${escapeHtml(audioUrl(row))}"></audio>
            <div class="audio-controls">
              <button type="button" class="secondary" onclick="toggleAudio(\${index})">播放/暂停</button>
              <button type="button" class="ghost" onclick="seekCandidate(\${index}, \${Number(row.localClipCueSeconds) || 0})">跳到候选秒</button>
            </div>
            <div class="actions">
              <button type="button" class="good" onclick="mark(\${index}, 'usable')">候选可用</button>
              <button type="button" class="bad" onclick="mark(\${index}, 'wrong')">候选错误</button>
              <button type="button" class="warn" onclick="mark(\${index}, 'uncertain')">不确定</button>
              <button type="button" class="ghost" onclick="mark(\${index}, '')">清除</button>
            </div>
            <div class="meta">
              <div><span class="label">预测秒</span>\${escapeHtml(row.predictedOnsetSeconds)}</div>
              <div><span class="label">页 / 小节</span>\${escapeHtml(row.pageNumber)} / \${escapeHtml(row.measureIndex)}</div>
              <div><span class="label">MIDI</span>\${escapeHtml(row.midi)}</div>
              <div><span class="label">音高支持</span>\${escapeHtml(row.pitchSupportWithin80Cents)}</div>
              <div><span class="label">centsError</span>\${escapeHtml(row.centsError)}</div>
              <div><span class="label">gate</span>\${escapeHtml(row.gateReason)}</div>
            </div>
            <div class="meta">
              <div><span class="label">scoreId</span>\${escapeHtml(row.scoreId)}</div>
              <div><span class="label">录音</span>\${escapeHtml(row.piece || row.recordingId || row.audioName)}</div>
              <div><span class="label">noteId</span>\${escapeHtml(row.noteId)}</div>
              <div><span class="label">section</span>\${escapeHtml(row.sectionTitle || row.sectionId)}</div>
              <div><span class="label">method</span>\${escapeHtml(row.method)}</div>
              <div><span class="label">submissionId</span>\${escapeHtml(row.submissionId)}</div>
            </div>
            <div class="meta">
              <div><span class="label">正确秒(可选)</span><input value="\${escapeHtml(review.teacherCorrectOnsetSeconds || "")}" oninput="syncInput(\${index}, 'teacherCorrectOnsetSeconds', this.value)" /></div>
              <div><span class="label">正确小节(可选)</span><input value="\${escapeHtml(review.teacherCorrectMeasureIndex || "")}" oninput="syncInput(\${index}, 'teacherCorrectMeasureIndex', this.value)" /></div>
            </div>
            <label><span class="label">备注</span><textarea oninput="syncInput(\${index}, 'teacherComments', this.value)">\${escapeHtml(review.teacherComments || "")}</textarea></label>
          </article>\`);
      });
      root.innerHTML = parts.join("") || '<section class="empty">没有可显示的候选。</section>';
      updateSummary();
    }
    function downloadCsv() {
      const rows = REVIEW_ROWS.map((row, index) => ({ ...row, ...(state.get(String(index)) || {}) }));
      const csv = headers.join(",") + "\\n" + rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")).join("\\n") + "\\n";
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "controlled-candidate-review.completed.csv";
      link.click();
      URL.revokeObjectURL(url);
    }
    document.getElementById("downloadCsv").addEventListener("click", downloadCsv);
    document.getElementById("showRemaining").addEventListener("click", () => {
      onlyRemaining = !onlyRemaining;
      document.getElementById("showRemaining").textContent = onlyRemaining ? "显示全部" : "只看未标";
      render();
    });
    document.getElementById("markRemainingUsable").addEventListener("click", () => bulkMark("usable", true));
    document.getElementById("markRemainingWrong").addEventListener("click", () => bulkMark("wrong", true));
    document.getElementById("markRemainingUncertain").addEventListener("click", () => bulkMark("uncertain", true));
    document.getElementById("clearAllMarks").addEventListener("click", () => bulkMark("", false));
    window.mark = mark;
    window.bulkMark = bulkMark;
    window.toggleAudio = toggleAudio;
    window.seekCandidate = seekCandidate;
    window.syncInput = syncInput;
    render();
  </script>
</body>
</html>`;
}

function parseArgs(argv) {
  const args = {
    source: path.join("data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl"),
    outDir: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review"),
    serverOrigin: "http://127.0.0.1:3000",
    limit: 30,
    latestOnly: true,
    gateCandidatesOnly: false,
    excludeReviewed: true,
    labelsPath: path.join("data", "experiments", "western-strings-m3", "offline-feature-candidate-review", "controlled-candidate-review-labels.csv"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") args.source = argv[++index] || args.source;
    else if (arg === "--out-dir") args.outDir = argv[++index] || args.outDir;
    else if (arg === "--server-origin") args.serverOrigin = argv[++index] || args.serverOrigin;
    else if (arg === "--limit") args.limit = Number(argv[++index] || args.limit);
    else if (arg === "--all") args.limit = 0;
    else if (arg === "--all-runs") args.latestOnly = false;
    else if (arg === "--gate-candidates") args.gateCandidatesOnly = true;
    else if (arg === "--include-reviewed") args.excludeReviewed = false;
    else if (arg === "--exclude-reviewed") args.excludeReviewed = true;
    else if (arg === "--labels") args.labelsPath = argv[++index] || args.labelsPath;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exportRows = await collectControlledCandidateReviewRows({
    repoRoot: process.cwd(),
    source: args.source,
    latestOnly: args.latestOnly,
  });
  const candidatePool = args.gateCandidatesOnly ? exportRows.rows.filter(isGateCandidateReviewRow) : exportRows.rows;
  const reviewedKeys = args.excludeReviewed
    ? await readReviewedCandidateKeys({ repoRoot: process.cwd(), labelsPath: args.labelsPath })
    : new Set();
  const reviewPool = args.excludeReviewed
    ? candidatePool.filter((row) => !reviewedKeys.has(controlledCandidateKey(row)))
    : candidatePool;
  const outDir = path.resolve(process.cwd(), args.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const rows = selectCandidateReviewSample(reviewPool, { limit: args.limit });
  await attachLocalAudioFiles(rows, { repoRoot: process.cwd(), outDir });
  const csvPath = path.join(outDir, "controlled-candidate-review.csv");
  const jsonPath = path.join(outDir, "controlled-candidate-review.json");
  const htmlPath = path.join(outDir, "index.html");
  const guidePath = path.join(outDir, "review-guide.md");
  await fs.writeFile(csvPath, controlledCandidateRowsToCsv(rows), "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify({
    source: exportRows.source,
    runMode: exportRows.runMode,
    totalRowCount: exportRows.rows.length,
    gateCandidatesOnly: args.gateCandidatesOnly,
    excludeReviewed: args.excludeReviewed,
    reviewedLabelCount: reviewedKeys.size,
    eligibleBeforeReviewedFilter: candidatePool.length,
    eligibleRowCount: reviewPool.length,
    rowCount: rows.length,
    sampleLimit: args.limit,
    skippedCount: exportRows.skipped.length,
    skipped: exportRows.skipped,
    rows,
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(htmlPath, renderClearControlledCandidateReviewHtml(rows, {
    serverOrigin: args.serverOrigin,
    totalRowCount: exportRows.rows.length,
  }), "utf8");
  await fs.writeFile(guidePath, buildClearReviewGuideMarkdown(rows, {
    totalRowCount: exportRows.rows.length,
  }), "utf8");
  console.log(JSON.stringify({
    ok: true,
    source: exportRows.source,
    runMode: exportRows.runMode,
    totalRowCount: exportRows.rows.length,
    gateCandidatesOnly: args.gateCandidatesOnly,
    excludeReviewed: args.excludeReviewed,
    reviewedLabelCount: reviewedKeys.size,
    eligibleBeforeReviewedFilter: candidatePool.length,
    eligibleRowCount: reviewPool.length,
    rowCount: rows.length,
    sampleLimit: args.limit,
    skippedCount: exportRows.skipped.length,
    csvPath: path.relative(process.cwd(), csvPath).replace(/\\/g, "/"),
    jsonPath: path.relative(process.cwd(), jsonPath).replace(/\\/g, "/"),
    htmlPath: path.relative(process.cwd(), htmlPath).replace(/\\/g, "/"),
    guidePath: path.relative(process.cwd(), guidePath).replace(/\\/g, "/"),
  }, null, 2));
}

function buildClearReviewGuideMarkdown(rows = [], { totalRowCount = rows.length } = {}) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${safeString(row.piece, "unknown-piece")} / ${safeString(row.recordingId, "unknown-recording")}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const lines = [
    "# 普通上传候选复核指南",
    "",
    `当前抽样 ${rows.length} 条；最新 batch 候选总数 ${totalRowCount} 条。`,
    "",
    "## 你要标什么",
    "",
    "每一条候选的意思是：系统认为“录音某一秒附近”可能对应“谱面某一小节里的某个 MIDI 音”。",
    "你只需要听这一秒附近，判断这个候选能不能作为该谱面音符的证据。",
    "",
    "## 三个标注按钮",
    "",
    "- `usable`: 候选可用。音频这一秒附近确实能听到这个谱面音。",
    "- `wrong`: 候选错误。明显错位、音高不对、或不能作为该音符证据。",
    "- `uncertain`: 不确定。听不清、谱面位置无法确认、或只能定性判断。",
    "",
    "`usable` 和 `wrong` 会进入校准统计；`uncertain` 只保留记录，不计入 precision。",
    "",
    "## 抽样分组",
    "",
  ];
  for (const [group, groupRows] of grouped.entries()) {
    lines.push(`### ${group}`, "");
    lines.push("| 本页序号 | 原始行号 | 预测秒 | 页 | 小节 | MIDI | 音高支持 | centsError | 候选 |");
    lines.push("|---:|---:|---:|---:|---:|---:|---|---:|---|");
    groupRows.forEach((row, index) => {
      const cells = [
        index + 1,
        row.reviewRowNumber,
        row.predictedOnsetSeconds,
        row.pageNumber,
        row.measureIndex,
        row.midi,
        row.pitchSupportWithin80Cents,
        row.centsError,
        safeString(row.candidateId),
      ].map((cell) => String(cell ?? "").replace(/\|/g, "\\|"));
      lines.push(`| ${cells.join(" | ")} |`);
    });
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function renderClearControlledCandidateReviewHtml(rows = [], {
  serverOrigin = "http://127.0.0.1:3000",
  totalRowCount = rows.length,
} = {}) {
  const payload = JSON.stringify(rows).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>普通上传候选复核</title>
  <style>
    body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; background: #f5f7fb; color: #172033; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { position: sticky; top: 0; z-index: 3; background: rgba(245,247,251,.98); border-bottom: 1px solid #d8dee9; padding: 16px 24px; margin: -24px -24px 20px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    h2 { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; font-size: 20px; }
    code { background: #e2e8f0; border-radius: 4px; padding: 1px 4px; }
    .hint, .small { color: #526070; line-height: 1.55; }
    .task { background: #e8f1ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 10px 12px; margin: 10px 0; line-height: 1.6; }
    .actions, .audio-controls, .mark-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
    button, a.button-link { border: 0; background: #1d4ed8; color: white; padding: 10px 14px; border-radius: 6px; cursor: pointer; font-weight: 700; font-size: 14px; text-decoration: none; display: inline-flex; align-items: center; }
    button.secondary { background: #475569; }
    button.ghost, a.ghost { background: #64748b; }
    button.good { background: #15803d; }
    button.bad { background: #b91c1c; }
    button.warn { background: #b45309; }
    button:focus { outline: 3px solid #93c5fd; outline-offset: 2px; }
    input { padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; min-width: 260px; }
    .card { background: white; border: 1px solid #d8dee9; border-radius: 8px; padding: 16px; margin: 14px 0; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
    .card.reviewed { border-color: #94a3b8; }
    .status { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 10px; font-weight: 700; font-size: 13px; background: #e2e8f0; color: #334155; }
    .status.usable { background: #dcfce7; color: #166534; }
    .status.wrong { background: #fee2e2; color: #991b1b; }
    .status.uncertain { background: #fef3c7; color: #92400e; }
    .candidate-sentence { font-size: 17px; line-height: 1.65; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin: 10px 0; }
    .candidate-sentence strong { color: #0f172a; }
    .meta { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 8px; margin: 10px 0; }
    .meta div { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; }
    .label { display: block; color: #64748b; font-size: 12px; margin-bottom: 4px; }
    audio { width: 100%; margin: 8px 0; }
    textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; min-height: 56px; }
    .empty { background: white; border: 1px dashed #94a3b8; border-radius: 8px; padding: 24px; }
    @media (max-width: 900px) { .meta { grid-template-columns: repeat(2, minmax(120px, 1fr)); } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>普通上传候选复核</h1>
      <div class="task">
        <strong>你要做的事：</strong>每条候选都在问同一个问题：系统说“录音某一秒附近”可能是“谱面某一小节的某个音”。请听这一秒附近，判断这个候选对不对。
        <br />标题里的“候选 1 / 30”只是本页序号；卡片底部的“原始行号”只是系统内部编号，不是小节号。
      </div>
      <p class="hint">当前显示 <strong>${rows.length}</strong> 条候选；最新 batch 候选总数 <strong>${totalRowCount}</strong> 条。标完后点击“下载复核 CSV”。</p>
      <div class="actions">
        <label>后台地址 <input id="serverOrigin" value="${htmlEscape(serverOrigin)}" /></label>
        <button type="button" id="downloadCsv">下载复核 CSV</button>
        <button type="button" class="secondary" id="showRemaining">只看未标注</button>
        <button type="button" class="good" id="markRemainingUsable">一键：未标都正确</button>
        <button type="button" class="bad" id="markRemainingWrong">一键：未标都错误</button>
        <button type="button" class="warn" id="markRemainingUncertain">一键：未标都不确定</button>
        <button type="button" class="ghost" id="clearAllMarks">清空本页标注</button>
        <span id="summary" class="hint"></span>
      </div>
    </header>
    <section id="rows"></section>
  </main>
  <script>
    const REVIEW_ROWS = ${payload};
    const TOTAL_ROW_COUNT = ${Number(totalRowCount) || rows.length};
    const state = new Map(REVIEW_ROWS.map((row, index) => [String(index), {
      teacherCandidateStatus: row.teacherCandidateStatus || "",
      teacherCorrectOnsetSeconds: row.teacherCorrectOnsetSeconds || "",
      teacherCorrectMeasureIndex: row.teacherCorrectMeasureIndex || "",
      teacherComments: row.teacherComments || ""
    }]));
    let onlyRemaining = false;
    const headers = ${JSON.stringify(CONTROLLED_CANDIDATE_REVIEW_HEADERS)};
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function csvEscape(value) {
      const text = String(value ?? "");
      return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    function formatSeconds(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(2) + " 秒" : "未知秒";
    }
    function statusText(status) {
      if (status === "usable") return "正确 / 可用";
      if (status === "wrong") return "错误";
      if (status === "uncertain") return "不确定";
      return "未标注";
    }
    function audioUrl(row) {
      if (row.localClipPath) return row.localClipPath;
      if (row.localAudioPath) return row.localAudioPath;
      const origin = document.getElementById("serverOrigin").value.replace(/\\/$/, "");
      return origin + "/api/strings/controlled-submissions/" + encodeURIComponent(row.submissionId) + "/audio";
    }
    async function toggleAudio(index) {
      const audio = document.getElementById("audio-" + index);
      if (!audio) return;
      try {
        if (audio.paused) await audio.play();
        else audio.pause();
      } catch (error) {
        alert("音频无法播放。请确认页面旁边的 audio 文件夹存在，或 :3000 后台服务正在运行。\\n" + (error && error.message ? error.message : error));
      }
    }
    function seekCandidate(index, seconds) {
      const audio = document.getElementById("audio-" + index);
      const numericSeconds = Number(seconds);
      if (!audio || !Number.isFinite(numericSeconds)) return;
      audio.currentTime = Math.max(0, numericSeconds);
      audio.focus();
    }
    function mark(index, status) {
      const next = state.get(String(index)) || {};
      next.teacherCandidateStatus = status;
      state.set(String(index), next);
      render();
    }
    function bulkMark(status, onlyBlank = true) {
      const label = statusText(status);
      const affected = [];
      for (const [key, value] of state.entries()) {
        if (!onlyBlank || !value.teacherCandidateStatus) affected.push(key);
      }
      if (!affected.length) return;
      if (!confirm("将 " + affected.length + " 条" + (onlyBlank ? "未标注候选" : "候选") + "标为：" + label + "。继续？")) return;
      for (const key of affected) {
        const next = state.get(key) || {};
        next.teacherCandidateStatus = status;
        state.set(key, next);
      }
      render();
    }
    function syncInput(index, key, value) {
      const next = state.get(String(index)) || {};
      next[key] = value;
      state.set(String(index), next);
      updateSummary();
    }
    function updateSummary() {
      let usable = 0, wrong = 0, uncertain = 0, blank = 0;
      for (const item of state.values()) {
        if (item.teacherCandidateStatus === "usable") usable += 1;
        else if (item.teacherCandidateStatus === "wrong") wrong += 1;
        else if (item.teacherCandidateStatus === "uncertain") uncertain += 1;
        else blank += 1;
      }
      document.getElementById("summary").textContent = "本页 " + REVIEW_ROWS.length + " 条 | 正确 " + usable + " | 错误 " + wrong + " | 不确定 " + uncertain + " | 未标注 " + blank;
    }
    function render() {
      const root = document.getElementById("rows");
      const parts = [];
      REVIEW_ROWS.forEach((row, index) => {
        const review = state.get(String(index)) || {};
        if (onlyRemaining && review.teacherCandidateStatus) return;
        const reviewedClass = review.teacherCandidateStatus ? " reviewed" : "";
        const statusClass = review.teacherCandidateStatus || "";
        const predictedSeconds = formatSeconds(row.predictedOnsetSeconds);
        parts.push(\`
          <article class="card\${reviewedClass}">
            <h2>
              <span>候选 \${index + 1} / \${REVIEW_ROWS.length}</span>
              <span class="status \${escapeHtml(statusClass)}">状态：\${escapeHtml(statusText(review.teacherCandidateStatus))}</span>
            </h2>
            <div class="candidate-sentence">
              <strong>系统说：</strong>录音 <strong>\${escapeHtml(predictedSeconds)}</strong> 附近，可能对应谱面
              <strong>第 \${escapeHtml(row.measureIndex || "未知")} 小节</strong>、
              <strong>MIDI \${escapeHtml(row.midi || "未知")}</strong> 的音符。
              <br /><span class="small">下面播放器是候选点前后约 6 秒的短音频；候选点在短音频第 \${escapeHtml(row.localClipCueSeconds ?? "未知")} 秒。若页面内不能播放,请点“打开短音频文件”。</span>
            </div>
            <audio id="audio-\${index}" controls preload="metadata" src="\${escapeHtml(audioUrl(row))}"></audio>
            <div class="audio-controls">
              <button type="button" class="secondary" onclick="toggleAudio(\${index})">播放/暂停</button>
              <button type="button" class="ghost" onclick="seekCandidate(\${index}, \${Number(row.localClipCueSeconds) || 0})">跳到候选秒</button>
              <a class="button-link ghost" href="\${escapeHtml(audioUrl(row))}" target="_blank" rel="noreferrer">打开短音频文件</a>
            </div>
            \${row.localScoreImagePath ? \`
              <div class="candidate-sentence">
                <strong>对应谱面：</strong>请在下图找 <strong>第 \${escapeHtml(row.measureIndex || "未知")} 小节</strong>、MIDI <strong>\${escapeHtml(row.midi || "未知")}</strong>。这是当前候选所属练习曲的谱面图。
                <br /><img src="\${escapeHtml(row.localScoreImagePath)}" alt="候选对应谱面" style="width:100%; max-height:720px; object-fit:contain; margin-top:10px; border:1px solid #cbd5e1; border-radius:8px; background:white;" />
              </div>
            \` : \`
              <div class="candidate-sentence"><strong>对应谱面：</strong>未找到本地谱图。请按第 \${escapeHtml(row.measureIndex || "未知")} 小节 / MIDI \${escapeHtml(row.midi || "未知")} 判断。</div>
            \`}
            <div class="mark-controls">
              <button type="button" class="good" onclick="mark(\${index}, 'usable')">正确：候选可用</button>
              <button type="button" class="bad" onclick="mark(\${index}, 'wrong')">错误：不是这个谱面音</button>
              <button type="button" class="warn" onclick="mark(\${index}, 'uncertain')">不确定：听不出来</button>
              <button type="button" class="ghost" onclick="mark(\${index}, '')">清除本条</button>
            </div>
            <div class="meta">
              <div><span class="label">录音 / 曲目</span>\${escapeHtml(row.piece || row.recordingId || row.audioName)}</div>
              <div><span class="label">预测秒</span>\${escapeHtml(predictedSeconds)}</div>
              <div><span class="label">谱面小节</span>\${escapeHtml(row.measureIndex)}</div>
              <div><span class="label">MIDI 音高</span>\${escapeHtml(row.midi)}</div>
              <div><span class="label">音高是否接近</span>\${escapeHtml(row.pitchSupportWithin80Cents)}</div>
              <div><span class="label">音分误差</span>\${escapeHtml(row.centsError)}</div>
              <div><span class="label">有效音高帧</span>\${escapeHtml(row.voicedFrameCount)}</div>
              <div><span class="label">原始行号(不用判断)</span>\${escapeHtml(row.reviewRowNumber)}</div>
              <div><span class="label">短音频路径</span>\${escapeHtml(row.localClipPath || "未生成")}</div>
              <div><span class="label">短音频起点 / 候选点</span>\${escapeHtml(row.localClipStartSeconds ?? "")} / \${escapeHtml(row.localClipCueSeconds ?? "")}</div>
              <div><span class="label">完整录音路径</span>\${escapeHtml(row.localAudioPath || "后台接口")}</div>
            </div>
            <div class="meta">
              <div><span class="label">正确秒(可选)</span><input value="\${escapeHtml(review.teacherCorrectOnsetSeconds || "")}" oninput="syncInput(\${index}, 'teacherCorrectOnsetSeconds', this.value)" /></div>
              <div><span class="label">正确小节(可选)</span><input value="\${escapeHtml(review.teacherCorrectMeasureIndex || "")}" oninput="syncInput(\${index}, 'teacherCorrectMeasureIndex', this.value)" /></div>
              <div><span class="label">noteId</span>\${escapeHtml(row.noteId)}</div>
              <div><span class="label">candidateId</span>\${escapeHtml(row.candidateId)}</div>
            </div>
            <label><span class="label">备注(可选)</span><textarea oninput="syncInput(\${index}, 'teacherComments', this.value)">\${escapeHtml(review.teacherComments || "")}</textarea></label>
          </article>\`);
      });
      root.innerHTML = parts.join("") || '<section class="empty">没有可显示的候选。</section>';
      updateSummary();
    }
    function downloadCsv() {
      const rows = REVIEW_ROWS.map((row, index) => ({ ...row, ...(state.get(String(index)) || {}) }));
      const csv = headers.join(",") + "\\n" + rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")).join("\\n") + "\\n";
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "controlled-candidate-review.completed.csv";
      link.click();
      URL.revokeObjectURL(url);
    }
    document.getElementById("downloadCsv").addEventListener("click", downloadCsv);
    document.getElementById("showRemaining").addEventListener("click", () => {
      onlyRemaining = !onlyRemaining;
      document.getElementById("showRemaining").textContent = onlyRemaining ? "显示全部" : "只看未标注";
      render();
    });
    document.getElementById("markRemainingUsable").addEventListener("click", () => bulkMark("usable", true));
    document.getElementById("markRemainingWrong").addEventListener("click", () => bulkMark("wrong", true));
    document.getElementById("markRemainingUncertain").addEventListener("click", () => bulkMark("uncertain", true));
    document.getElementById("clearAllMarks").addEventListener("click", () => bulkMark("", false));
    window.mark = mark;
    window.bulkMark = bulkMark;
    window.toggleAudio = toggleAudio;
    window.seekCandidate = seekCandidate;
    window.syncInput = syncInput;
    render();
  </script>
</body>
</html>`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
