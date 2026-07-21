import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildWesternOrdinaryReviewAssistDecision } from "../src/server/westernStringsAlignmentService.js";

const CONTRACT = "western-round5-review-assist-calibration-pack-v1";
const REVIEW_ASSIST_CONTRACT = "western-round4-policy-c-review-assist-v1";
const DEFAULT_RUNS = path.join("data", "experiments", "western-strings-m3", "controlled-submission-batch-runs.jsonl");
const DEFAULT_SUBMISSIONS = path.join("data", "experiments", "western-strings-m3", "controlled-submissions.jsonl");
const DEFAULT_OUT = path.join("data", "experiments", "western-strings-round5-review-assist-calibration-pack");
const DEFAULT_FROZEN_REPORT = path.join(
  "data", "experiments", "western-strings-round4", "ordinary-fresh-blind", "report.json",
);
const PRIVATE_MANIFESTS = [
  path.join("data", "private", "western-strings-round2", "manifest.csv"),
  path.join("data", "private", "western-strings-round2-fresh-blind", "manifest.csv"),
  path.join("data", "private", "western-strings-round3", "manifest.csv"),
  path.join("data", "private", "western-strings-round4", "manifest.csv"),
];

function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") value += char;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...data] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  return data.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

async function readJsonl(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function sha256File(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function workspacePath(repoRoot, relativePath) {
  const value = safeString(relativePath).trim();
  if (!value || path.isAbsolute(value)) return "";
  const resolved = path.resolve(repoRoot, value);
  return isInside(path.resolve(repoRoot), resolved) ? resolved : "";
}

function relativePath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

async function loadPrivateManifestIndex(repoRoot, manifestPaths = PRIVATE_MANIFESTS) {
  const byRecording = new Map();
  for (const manifestPath of manifestPaths) {
    try {
      const rows = parseCsv(await fs.readFile(path.resolve(repoRoot, manifestPath), "utf8"));
      for (const row of rows) {
        const recordingId = safeString(row.recordingId).trim();
        if (recordingId) byRecording.set(recordingId, row);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return byRecording;
}

function physicalReviewDecision(candidate = {}) {
  const decision = candidate.reviewAssistDecision || {};
  if (decision.contract !== REVIEW_ASSIST_CONTRACT
      || decision.reviewerOnly !== true
      || decision.requiresHumanReview !== true
      || decision.studentFacing !== false
      || decision.automaticAccusationAuthorized !== false
      || !["confirmed_issue", "self_check_hint"].includes(decision.outputSemantic)) return null;
  return decision;
}

function safeReviewDecision(candidate = {}, { allowRecompute = false } = {}) {
  const physical = physicalReviewDecision(candidate);
  if (physical) return { decision: physical, provenance: "physical-candidate-artifact" };
  if (!allowRecompute) return null;
  const recomputed = buildWesternOrdinaryReviewAssistDecision(candidate);
  if (recomputed.contract !== REVIEW_ASSIST_CONTRACT
      || recomputed.reviewerOnly !== true
      || recomputed.requiresHumanReview !== true
      || recomputed.studentFacing !== false
      || recomputed.automaticAccusationAuthorized !== false
      || !["confirmed_issue", "self_check_hint"].includes(recomputed.outputSemantic)) return null;
  return { decision: recomputed, provenance: "frozen-report-live-recomputed" };
}

function calibrationRow({
  root, run = {}, item = {}, artifact = {}, candidatePath, artifactSha256,
  candidate, decision, decisionProvenance, submission = {}, manifest = {}, recordingId = "",
  frozenReportPath = "", frozenReportSha256 = "",
}) {
  const audioSource = workspacePath(root, manifest.audioPath)
    || (isInside(root, path.resolve(safeString(submission.audioPath))) ? path.resolve(submission.audioPath) : "");
  const scoreSource = workspacePath(root, manifest.scorePath);
  const noteIndex = Number(candidate.noteIndex);
  const audioHash = safeString(item.audioHash || submission.audioHash || artifact.audioSha256).toLowerCase();
  const scoreId = safeString(item.scoreId || submission.scoreId || artifact.scoreId || manifest.scoreId);
  if (!recordingId || !Number.isInteger(noteIndex) || !audioHash || !scoreId) return null;
  return {
    identityKey: `${audioHash}::${scoreId}::${noteIndex}`,
    batchRunId: safeString(run.batchRunId || artifact.batchRunId),
    submissionId: safeString(item.submissionId || artifact.submissionId),
    candidateRowsPath: relativePath(root, candidatePath),
    candidateRowsSha256: artifactSha256,
    decisionProvenance,
    ...(frozenReportPath ? { frozenReportPath, frozenReportSha256 } : {}),
    candidateId: safeString(candidate.candidateId),
    noteId: safeString(candidate.noteId),
    noteIndex,
    dataset: safeString(item.dataset || submission.dataset || manifest.sourceRound),
    recordingId,
    pieceId: safeString(item.piece || submission.piece || manifest.pieceId),
    scoreId,
    audioHash,
    audioSourcePath: audioSource ? relativePath(root, audioSource) : "",
    scoreSourcePath: scoreSource ? relativePath(root, scoreSource) : "",
    measure: Number(candidate.measureIndex),
    beat: Number(candidate.beatStart) + 1,
    scoreMidi: Number(candidate.midi),
    predictedOnsetSeconds: candidate.predictedOnsetSeconds == null
      ? null : Number(candidate.predictedOnsetSeconds),
    sourceSemantic: decision.outputSemantic,
    sourceReason: safeString(decision.reason),
    calibrationOnly: true,
    freshBlindEligible: false,
  };
}

export async function collectReviewAssistCalibrationRows({
  repoRoot = process.cwd(),
  runsPath = DEFAULT_RUNS,
  submissionsPath = DEFAULT_SUBMISSIONS,
  manifestPaths = PRIVATE_MANIFESTS,
  frozenReportPath = DEFAULT_FROZEN_REPORT,
} = {}) {
  const root = path.resolve(repoRoot);
  const [runs, submissions, manifestIndex] = await Promise.all([
    readJsonl(path.resolve(root, runsPath)),
    readJsonl(path.resolve(root, submissionsPath)),
    loadPrivateManifestIndex(root, manifestPaths),
  ]);
  const submissionById = new Map(submissions.map((row) => [safeString(row.submissionId), row]));
  const rowsByIdentity = new Map();
  const rejectedArtifacts = [];
  const latestItemBySubmission = new Map();
  for (const run of runs) {
    for (const item of Array.isArray(run?.items) ? run.items : []) {
      if (safeString(item.submissionId)) latestItemBySubmission.set(safeString(item.submissionId), { run, item });
    }
  }
  for (const { run, item } of latestItemBySubmission.values()) {
      const candidatePath = workspacePath(root, item.candidateRowsPath);
      if (!candidatePath) continue;
      let artifactSha256;
      let artifact;
      try {
        artifactSha256 = await sha256File(candidatePath);
        if (!/^[a-f0-9]{64}$/.test(safeString(item.candidateRowsSha256).toLowerCase())
            || artifactSha256 !== safeString(item.candidateRowsSha256).toLowerCase()) {
          rejectedArtifacts.push({
            batchRunId: safeString(run.batchRunId),
            submissionId: safeString(item.submissionId),
            reason: "candidate-artifact-sha-mismatch",
          });
          continue;
        }
        artifact = JSON.parse(await fs.readFile(candidatePath, "utf8"));
      } catch (error) {
        rejectedArtifacts.push({
          batchRunId: safeString(run.batchRunId),
          submissionId: safeString(item.submissionId),
          reason: "candidate-artifact-unreadable",
          error: String(error?.message || error),
        });
        continue;
      }
      if (safeString(artifact.batchRunId) !== safeString(run.batchRunId)
          || safeString(artifact.submissionId) !== safeString(item.submissionId)) {
        rejectedArtifacts.push({
          batchRunId: safeString(run.batchRunId),
          submissionId: safeString(item.submissionId),
          reason: "candidate-artifact-identity-mismatch",
        });
        continue;
      }
      const submission = submissionById.get(safeString(item.submissionId)) || {};
      const recordingId = safeString(item.recordingId || submission.recordingId).trim();
      const manifest = manifestIndex.get(recordingId) || {};
      for (const candidate of Array.isArray(artifact.candidateRows) ? artifact.candidateRows : []) {
        const resolved = safeReviewDecision(candidate);
        if (!resolved) continue;
        const row = calibrationRow({
          root, run, item, artifact, candidatePath, artifactSha256, candidate,
          decision: resolved.decision, decisionProvenance: resolved.provenance,
          submission, manifest, recordingId,
        });
        if (row) rowsByIdentity.set(row.identityKey, row);
      }
  }

  let frozenSource = null;
  const absoluteFrozenReport = workspacePath(root, frozenReportPath);
  if (absoluteFrozenReport) {
    try {
      const reportBytes = await fs.readFile(absoluteFrozenReport);
      const reportSha256 = crypto.createHash("sha256").update(reportBytes).digest("hex");
      const report = JSON.parse(reportBytes.toString("utf8"));
      const manifestPath = workspacePath(root, report.manifestPath);
      const truthPath = workspacePath(root, report.positionTruthPath);
      const manifestCurrent = Boolean(manifestPath)
        && await sha256File(manifestPath) === safeString(report.manifestSha256).toLowerCase();
      const truthCurrent = Boolean(truthPath)
        && await sha256File(truthPath) === safeString(report.positionTruthSha256).toLowerCase();
      if (!manifestCurrent || !truthCurrent || report?.policyCReviewAssist?.contract !== REVIEW_ASSIST_CONTRACT) {
        rejectedArtifacts.push({
          source: safeString(frozenReportPath).replace(/\\/g, "/"),
          reason: "frozen-policy-c-report-binding-invalid",
        });
      } else {
        for (const recording of Array.isArray(report.recordings) ? report.recordings : []) {
          const candidatePath = workspacePath(root, recording.candidateRowsPath);
          if (!candidatePath) continue;
          const artifactSha256 = await sha256File(candidatePath);
          if (artifactSha256 !== safeString(recording.candidateArtifactSha256).toLowerCase()) {
            rejectedArtifacts.push({ recordingId: recording.recordingId, reason: "frozen-candidate-artifact-sha-mismatch" });
            continue;
          }
          const artifact = JSON.parse(await fs.readFile(candidatePath, "utf8"));
          const manifest = manifestIndex.get(safeString(recording.recordingId)) || {};
          const linked = latestItemBySubmission.get(safeString(artifact.submissionId)) || {};
          const item = linked.item || {};
          const run = linked.run || {};
          const submission = submissionById.get(safeString(artifact.submissionId)) || {};
          for (const candidate of Array.isArray(artifact.candidateRows) ? artifact.candidateRows : []) {
            const resolved = safeReviewDecision(candidate, { allowRecompute: true });
            if (!resolved) continue;
            const row = calibrationRow({
              root, run, item, artifact, candidatePath, artifactSha256, candidate, submission,
              decision: resolved.decision, decisionProvenance: resolved.provenance,
              manifest, recordingId: safeString(recording.recordingId),
              frozenReportPath: relativePath(root, absoluteFrozenReport), frozenReportSha256: reportSha256,
            });
            if (row && !rowsByIdentity.has(row.identityKey)) rowsByIdentity.set(row.identityKey, row);
          }
        }
        frozenSource = {
          path: relativePath(root, absoluteFrozenReport),
          sha256: reportSha256,
          evidenceDigestSha256: safeString(report.evidenceDigestSha256),
          policyCReviewAssistGateReady: report.policyCReviewAssist.reviewAssistGateReady === true,
        };
      }
    } catch (error) {
      rejectedArtifacts.push({
        source: safeString(frozenReportPath).replace(/\\/g, "/"),
        reason: "frozen-policy-c-report-unreadable",
        error: String(error?.message || error),
      });
    }
  }
  const rows = [...rowsByIdentity.values()].sort((left, right) => left.identityKey.localeCompare(right.identityKey));
  return {
    contract: CONTRACT,
    sourceRuns: safeString(runsPath).replace(/\\/g, "/"),
    sourceSubmissions: safeString(submissionsPath).replace(/\\/g, "/"),
    runCount: runs.length,
    submissionCount: submissions.length,
    latestSubmissionArtifactCount: latestItemBySubmission.size,
    frozenSource,
    rows,
    rejectedArtifacts,
  };
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderReviewPackHtml({ ledger, ledgerSha256 }) {
  const payload = JSON.stringify(ledger.rows).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Round 5 calibration 复核包</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;background:#f3f5f8;color:#172033;margin:0}main{max-width:1100px;margin:auto;padding:20px}header{position:sticky;top:0;background:#f3f5f8;border-bottom:1px solid #ccd4df;padding:12px 0;z-index:2}.card{background:#fff;border:1px solid #d9e0e8;border-radius:8px;padding:14px;margin:12px 0}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.meta span{background:#f7f9fb;padding:6px}.controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}select,input,textarea,button{font:inherit;padding:7px;border:1px solid #b8c2cf;border-radius:5px}textarea{grid-column:1/-1;min-height:48px}button{background:#2457c5;color:#fff;cursor:pointer}.warn{color:#9a3412;font-weight:700}@media(max-width:720px){.meta,.controls{grid-template-columns:1fr}}</style>
</head><body><main><header><h1>Round 5 calibration 复核包</h1><p class="warn">只生成 calibration 草稿，绝不生成 fresh-blind。机器提示不是标签；请听音后独立填写。</p><button id="download">下载已完成 JSON</button> <span id="summary"></span></header><section id="recordings"></section><section id="rows"></section></main>
<script>const ROWS=${payload};const CONTRACT=${JSON.stringify(CONTRACT)};const LEDGER_SHA=${JSON.stringify(ledgerSha256)};const state=new Map();const recordingState=new Map();
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function audio(row){return row.localAudioPath?'<audio controls preload="none" src="'+esc(row.localAudioPath)+'"></audio>':'<strong class="warn">音频源缺失</strong>';}
function renderRecordings(){const ids=[...new Set(ROWS.map(r=>r.recordingId))];const root=document.getElementById('recordings');root.innerHTML='<h2>录音元数据</h2>'+ids.map(id=>{const s=recordingState.get(id)||{consent:'yes',licenseStatus:'local-only'};recordingState.set(id,s);return '<article class="card"><strong>'+esc(id)+'</strong><div class="controls"><input data-r="'+esc(id)+'" data-mf="performerId" placeholder="performerId" value="'+esc(s.performerId||'')+'"><input data-r="'+esc(id)+'" data-mf="deviceId" placeholder="deviceId" value="'+esc(s.deviceId||'')+'"><input data-r="'+esc(id)+'" data-mf="roomId" placeholder="roomId" value="'+esc(s.roomId||'')+'"><input data-r="'+esc(id)+'" data-mf="consent" placeholder="consent=yes" value="'+esc(s.consent||'yes')+'"><input data-r="'+esc(id)+'" data-mf="licenseStatus" placeholder="licenseStatus=local-only" value="'+esc(s.licenseStatus||'local-only')+'"></div></article>';}).join('');root.querySelectorAll('[data-r]').forEach(el=>el.addEventListener('change',()=>{const v=recordingState.get(el.dataset.r)||{};v[el.dataset.mf]=el.value;recordingState.set(el.dataset.r,v);summary();}));}
function render(){renderRecordings();const root=document.getElementById('rows');root.innerHTML=ROWS.map((row,i)=>{const s=state.get(row.identityKey)||{};return '<article class="card"><div class="meta"><span>'+esc(row.recordingId)+'</span><span>小节 '+row.measure+' / 拍 '+row.beat+'</span><span>MIDI '+row.scoreMidi+'</span><span>机器：'+esc(row.sourceSemantic)+'</span></div>'+audio(row)+'<div class="controls"><select data-k="'+esc(row.identityKey)+'" data-f="label"><option value="">未标</option><option value="positive" '+(s.label==='positive'?'selected':'')+'>真实错误正例</option><option value="confusion_negative" '+(s.label==='confusion_negative'?'selected':'')+'>混淆负例/不是该错</option><option value="uncertain" '+(s.label==='uncertain'?'selected':'')+'>不确定</option></select><select data-k="'+esc(row.identityKey)+'" data-f="gate"><option value="">选择 gate</option>'+['merged_substitution','missing','extra','drag'].map(g=>'<option '+(s.gate===g?'selected':'')+'>'+g+'</option>').join('')+'</select><input data-k="'+esc(row.identityKey)+'" data-f="reviewedBy" placeholder="复核人" value="'+esc(s.reviewedBy||'')+'"><input data-k="'+esc(row.identityKey)+'" data-f="confusionKind" placeholder="负例混淆类型" value="'+esc(s.confusionKind||'')+'"><textarea data-k="'+esc(row.identityKey)+'" data-f="asPerformed" placeholder="实际如何演奏（正/负例均必填）">'+esc(s.asPerformed||'')+'</textarea><textarea data-k="'+esc(row.identityKey)+'" data-f="comments" placeholder="备注">'+esc(s.comments||'')+'</textarea></div></article>';}).join('');root.querySelectorAll('[data-k]').forEach(el=>el.addEventListener('change',()=>{const v=state.get(el.dataset.k)||{};v[el.dataset.f]=el.value;state.set(el.dataset.k,v);summary();}));summary();}
function summary(){const done=[...state.values()].filter(v=>v.label).length;const metadataDone=[...recordingState.values()].filter(v=>v.performerId&&v.deviceId&&v.roomId&&v.consent==='yes'&&v.licenseStatus==='local-only').length;document.getElementById('summary').textContent='已标 '+done+' / '+ROWS.length+'；元数据 '+metadataDone+' / '+recordingState.size;}
document.getElementById('download').onclick=()=>{const reviews=ROWS.map(row=>({identityKey:row.identityKey,...(state.get(row.identityKey)||{})})).filter(row=>row.label);const recordingMetadata=Object.fromEntries(recordingState);const payload={contract:CONTRACT,ledgerSha256:LEDGER_SHA,calibrationOnly:true,freshBlindEligible:false,recordingMetadata,reviews};const blob=new Blob([JSON.stringify(payload,null,2)+'\\n'],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='round5-review-assist-calibration.completed.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};render();</script></body></html>`;
}

export async function writeReviewAssistCalibrationPack({
  repoRoot = process.cwd(),
  outDir = DEFAULT_OUT,
  runsPath = DEFAULT_RUNS,
  submissionsPath = DEFAULT_SUBMISSIONS,
  manifestPaths = PRIVATE_MANIFESTS,
  frozenReportPath = DEFAULT_FROZEN_REPORT,
} = {}) {
  const root = path.resolve(repoRoot);
  const output = path.resolve(root, outDir);
  const collected = await collectReviewAssistCalibrationRows({
    repoRoot: root, runsPath, submissionsPath, manifestPaths, frozenReportPath,
  });
  await fs.mkdir(path.join(output, "audio"), { recursive: true });
  const audioBySource = new Map();
  const sourceWarnings = [];
  for (const row of collected.rows) {
    const source = workspacePath(root, row.audioSourcePath);
    const scoreSource = workspacePath(root, row.scoreSourcePath);
    if (scoreSource) row.scoreSourceSha256 = await sha256File(scoreSource);
    if (!source) {
      sourceWarnings.push({ identityKey: row.identityKey, reason: "audio-source-missing" });
      continue;
    }
    const audioSourceSha256 = await sha256File(source);
    row.audioSourceSha256 = audioSourceSha256;
    if (row.audioHash && audioSourceSha256 !== row.audioHash) {
      sourceWarnings.push({ identityKey: row.identityKey, reason: "audio-source-sha-mismatch" });
      continue;
    }
    if (!audioBySource.has(source)) {
      const extension = path.extname(source) || ".m4a";
      const target = path.join(output, "audio", `${row.audioHash || crypto.createHash("sha1").update(source).digest("hex")}${extension}`);
      await fs.copyFile(source, target);
      audioBySource.set(source, relativePath(output, target));
    }
    row.localAudioPath = audioBySource.get(source);
  }
  const ledger = {
    schemaVersion: 1,
    contract: CONTRACT,
    generatedAt: new Date().toISOString(),
    scope: "teacher-reviewed-calibration-draft-only",
    calibrationOnly: true,
    freshBlindEligible: false,
    sourceRuns: collected.sourceRuns,
    sourceSubmissions: collected.sourceSubmissions,
    frozenSource: collected.frozenSource,
    sourceSummary: {
      runCount: collected.runCount,
      submissionCount: collected.submissionCount,
      latestSubmissionArtifactCount: collected.latestSubmissionArtifactCount,
      candidateCount: collected.rows.length,
      rejectedArtifactCount: collected.rejectedArtifacts.length,
      sourceWarningCount: sourceWarnings.length,
    },
    rejectedArtifacts: collected.rejectedArtifacts,
    sourceWarnings,
    rows: collected.rows,
  };
  const ledgerBytes = `${JSON.stringify(ledger, null, 2)}\n`;
  const ledgerSha256 = crypto.createHash("sha256").update(ledgerBytes).digest("hex");
  await fs.writeFile(path.join(output, "ledger.json"), ledgerBytes, "utf8");
  await fs.writeFile(path.join(output, "index.html"), renderReviewPackHtml({ ledger, ledgerSha256 }), "utf8");
  const playableCandidateCount = ledger.rows.filter((row) => row.localAudioPath).length;
  const readyForReview = playableCandidateCount > 0;
  const blockingReasons = readyForReview ? [] : ["round5-review-assist-calibration-no-current-candidates"];
  return {
    ok: true,
    contract: CONTRACT,
    outDir: relativePath(root, output),
    reviewPage: relativePath(root, path.join(output, "index.html")),
    ledger: relativePath(root, path.join(output, "ledger.json")),
    ledgerSha256,
    candidateCount: ledger.rows.length,
    playableCandidateCount,
    copiedAudioCount: audioBySource.size,
    rejectedArtifactCount: ledger.rejectedArtifacts.length,
    readyForReview,
    blockingReasons,
    calibrationOnly: true,
    freshBlindEligible: false,
  };
}

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT,
    runsPath: DEFAULT_RUNS,
    submissionsPath: DEFAULT_SUBMISSIONS,
    frozenReportPath: DEFAULT_FROZEN_REPORT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out-dir") args.outDir = argv[++index] || args.outDir;
    else if (argv[index] === "--runs") args.runsPath = argv[++index] || args.runsPath;
    else if (argv[index] === "--submissions") args.submissionsPath = argv[++index] || args.submissionsPath;
    else if (argv[index] === "--frozen-report") args.frozenReportPath = argv[++index] || args.frozenReportPath;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  writeReviewAssistCalibrationPack(parseArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
