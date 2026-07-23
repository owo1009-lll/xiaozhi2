import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_STAGED_PATHS,
  validateStageAAuthorization,
} from "./western-round6-staged-signoff-support.mjs";

const DEFAULT_ROOT = path.join("data", "private", "western-strings-round5");
const DEFAULT_CONTRACT = path.join("config", "western-strings-round5-targeted-contract.json");
const DEFAULT_MANIFEST = path.join(DEFAULT_ROOT, "manifest.csv");
const DEFAULT_TRUTH = path.join(DEFAULT_ROOT, "position-truth.json");
const DEFAULT_OUT = path.join(DEFAULT_ROOT, "truth-signoff");
const COMPLETED_CONTRACT = "western-truth-signoff-completed-v1";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const posixPath = (value) => value.replace(/\\/g, "/");
const sameIds = (left, right) => (
  JSON.stringify([...(left || [])].map(String).sort())
    === JSON.stringify([...(right || [])].map(String).sort())
);

async function fileExists(absolutePath) {
  try {
    await fs.access(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseCsv(text) {
  const rows = [];
  let current = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      current.push(value);
      value = "";
    } else if (char === "\n") {
      current.push(value);
      rows.push(current);
      current = [];
      value = "";
    } else if (char !== "\r") value += char;
  }
  if (current.length || value) {
    current.push(value);
    rows.push(current);
  }
  const [headers = [], ...body] = rows.filter((row) => row.some((cell) => cell.trim()));
  return body.map((row) => Object.fromEntries(
    headers.map((header, index) => [header.replace(/^\uFEFF/, ""), row[index] ?? ""]),
  ));
}

async function readSource(repoRoot, relativePath) {
  const absolute = path.resolve(repoRoot, relativePath);
  const bytes = await fs.readFile(absolute);
  return { absolute, bytes, sha256: sha256(bytes) };
}

function renderHtml({
  truth,
  recordings,
  contractSha256,
  manifestSha256,
  truthSha256,
  roundNumber = 5,
  scope = null,
  stageAAuthorization = null,
}) {
  const roundLabel = `Round ${roundNumber}`;
  const payload = JSON.stringify({
    truth,
    recordings,
    contractSha256,
    manifestSha256,
    truthSha256,
    roundNumber,
    scope,
    stageAAuthorization,
  })
    .replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${roundLabel} 逐条试听与真值签署</title>
  <style>
    body{margin:0;background:#f3f5f8;color:#172033;font-family:"Microsoft YaHei",sans-serif}
    main{max-width:1120px;margin:auto;padding:20px}.sticky{position:sticky;top:0;z-index:3;background:#f3f5f8;border-bottom:1px solid #cbd5e1;padding:12px 0}
    .card{background:#fff;border:1px solid #d7dee8;border-radius:9px;padding:14px;margin:14px 0}.event{border-top:1px solid #e2e8f0;padding:12px 0}
    .meta{display:flex;flex-wrap:wrap;gap:8px}.meta span{background:#f7f9fc;border-radius:5px;padding:5px 8px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}textarea,input,select,button{box-sizing:border-box;font:inherit;padding:8px;border:1px solid #b7c2d0;border-radius:5px}
    textarea{width:100%;min-height:62px;grid-column:1/-1}audio{width:100%;margin:10px 0}button{background:#2457c5;color:#fff;cursor:pointer}.secondary{background:#475569}
    .danger{color:#9a3412;font-weight:700}.ok{color:#166534;font-weight:700}.extra{background:#fff8e7;padding:10px;border-radius:7px;margin-top:8px}
    @media(max-width:700px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body><main>
  <section class="sticky">
    <h1>${roundLabel} 逐条试听与真值签署</h1>
    <p class="danger" id="no-machine-predictions">本页不展示任何机器预测。请只根据录音实际内容复核，避免污染 fresh-blind。</p>
    <button id="download">全部完成后下载签署包 JSON</button>
    <span id="summary"></span>
  </section>
  <section id="recordings"></section>
</main>
<script>
const PACK=${payload};
const GATES=["merged_substitution","missing","extra","drag"];
const LABELS=["positive","confusion_negative"];
const KEY="western-round${roundNumber}-truth-signoff:"+PACK.truthSha256;
const saved=JSON.parse(localStorage.getItem(KEY)||"{}");
const state={
  values:saved.values||{},
  inventories:saved.inventories||{},
  extras:saved.extras||{},
  metadata:Object.fromEntries(PACK.recordings.map((recording)=>[
    recording.recordingId,
    {
      performerId:recording.performerId,
      deviceId:recording.deviceId,
      roomId:recording.roomId,
      consent:recording.consent,
      licenseStatus:recording.licenseStatus,
      ...(saved.metadata?.[recording.recordingId]||{})
    }
  ])),
  metadataConfirmed:saved.metadataConfirmed||{}
};
const esc=(value)=>String(value??"").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const eventKey=(recordingId,eventId)=>recordingId+"::"+eventId;
function persist(){localStorage.setItem(KEY,JSON.stringify(state));summary();}
function valueFor(recordingId,event){
  return {...event,...(state.values[eventKey(recordingId,event.eventId)]||{})};
}
function eventFields(recordingId,event,isExtra=false){
  const value=valueFor(recordingId,event);
  const key=eventKey(recordingId,event.eventId);
  return '<div class="'+(isExtra?'extra':'event')+'" data-event="'+esc(key)+'">'
    +'<div class="meta"><span>'+esc(event.eventId)+'</span><span>m'+esc(value.measure)+' / b'+esc(value.beat)+'</span><span>MIDI '+esc(value.scoreMidi)+'</span></div>'
    +(event.plannedPerformance?'<p>计划：'+esc(event.plannedPerformance)+'</p>':'')
    +'<div class="grid">'
    +'<select data-key="'+esc(key)+'" data-field="gate">'+GATES.map(g=>'<option value="'+g+'" '+(value.gate===g?'selected':'')+'>'+g+'</option>').join('')+'</select>'
    +'<select data-key="'+esc(key)+'" data-field="label">'+LABELS.map(label=>'<option value="'+label+'" '+(value.label===label?'selected':'')+'>'+label+'</option>').join('')+'</select>'
    +(isExtra?'<input data-key="'+esc(key)+'" data-field="measure" type="number" min="1" step="1" value="'+esc(value.measure)+'" placeholder="小节"><input data-key="'+esc(key)+'" data-field="beat" type="number" min="0.001" step="0.001" value="'+esc(value.beat)+'" placeholder="拍"><input data-key="'+esc(key)+'" data-field="scoreMidi" type="number" min="0" max="127" step="1" value="'+esc(value.scoreMidi)+'" placeholder="MIDI">':'')
    +'<input data-key="'+esc(key)+'" data-field="confusionKind" value="'+esc(value.confusionKind||'')+'" placeholder="混淆类型（负例时填写）">'
    +'<textarea data-key="'+esc(key)+'" data-field="asPerformed" placeholder="必填：实际听到怎样演奏">'+esc(value.asPerformed||'')+'</textarea>'
    +(isExtra?'<button class="secondary" data-remove="'+esc(recordingId)+'" data-extra-id="'+esc(event.eventId)+'">删除计划外事件</button>':'')
    +'</div></div>';
}
function bindInputs(){
  document.querySelectorAll("[data-key]").forEach((element)=>element.addEventListener("change",()=>{
    const current=state.values[element.dataset.key]||{};
    current[element.dataset.field]=element.value;
    state.values[element.dataset.key]=current;
    persist();
  }));
  document.querySelectorAll("[data-inventory]").forEach((element)=>element.addEventListener("change",()=>{
    state.inventories[element.dataset.inventory]=element.checked;
    persist();
  }));
  document.querySelectorAll("[data-metadata-recording]").forEach((element)=>element.addEventListener("change",()=>{
    const recordingId=element.dataset.metadataRecording;
    state.metadata[recordingId]=state.metadata[recordingId]||{};
    state.metadata[recordingId][element.dataset.metadataField]=element.value;
    persist();
  }));
  document.querySelectorAll("[data-metadata-confirmed]").forEach((element)=>element.addEventListener("change",()=>{
    state.metadataConfirmed[element.dataset.metadataConfirmed]=element.checked;
    persist();
  }));
  document.querySelectorAll("[data-add]").forEach((element)=>element.addEventListener("click",()=>{
    const recordingId=element.dataset.add;
    const extras=state.extras[recordingId]||[];
    extras.push({eventId:"unplanned-"+Date.now()+"-"+extras.length,gate:"merged_substitution",label:"positive",measure:"",beat:"",scoreMidi:"",asPerformed:""});
    state.extras[recordingId]=extras;
    persist();render();
  }));
  document.querySelectorAll("[data-remove]").forEach((element)=>element.addEventListener("click",()=>{
    state.extras[element.dataset.remove]=(state.extras[element.dataset.remove]||[]).filter(row=>row.eventId!==element.dataset.extraId);
    delete state.values[eventKey(element.dataset.remove,element.dataset.extraId)];
    persist();render();
  }));
}
function render(){
  const root=document.getElementById("recordings");
  root.innerHTML=PACK.recordings.map((recording)=>{
    const spec=PACK.truth.recordings[recording.recordingId];
    const extras=state.extras[recording.recordingId]||[];
    const metadata=state.metadata[recording.recordingId]||{};
    return '<article class="card"><h2>'+esc(recording.recordingId)+' · '+esc(recording.split)+'</h2>'
      +'<div class="meta"><span>音频 SHA '+esc(recording.audioSha256.slice(0,12))+'…</span></div>'
      +'<audio controls preload="metadata" src="'+esc(recording.audioRelativePath)+'"></audio>'
      +'<div class="grid">'
      +'<input data-metadata-recording="'+esc(recording.recordingId)+'" data-metadata-field="performerId" value="'+esc(metadata.performerId)+'" placeholder="实际演奏者匿名 ID">'
      +'<input data-metadata-recording="'+esc(recording.recordingId)+'" data-metadata-field="deviceId" value="'+esc(metadata.deviceId)+'" placeholder="实际设备 ID">'
      +'<input data-metadata-recording="'+esc(recording.recordingId)+'" data-metadata-field="roomId" value="'+esc(metadata.roomId)+'" placeholder="实际房间 ID">'
      +'<select data-metadata-recording="'+esc(recording.recordingId)+'" data-metadata-field="consent"><option value="pending" '+(metadata.consent!=="yes"?'selected':'')+'>同意待确认</option><option value="yes" '+(metadata.consent==="yes"?'selected':'')+'>已取得同意</option></select>'
      +'<select data-metadata-recording="'+esc(recording.recordingId)+'" data-metadata-field="licenseStatus"><option value="local-private-pending" '+(metadata.licenseStatus!=="local-only"?'selected':'')+'>许可待确认</option><option value="local-only" '+(metadata.licenseStatus==="local-only"?'selected':'')+'>仅本地使用</option></select>'
      +'</div>'
      +'<p><label><input type="checkbox" data-metadata-confirmed="'+esc(recording.recordingId)+'" '+(state.metadataConfirmed[recording.recordingId]?'checked':'')+'> 我已核对本条实际演奏者、设备、房间、同意和许可</label></p>'
      +'<p><label><input type="checkbox" data-inventory="'+esc(recording.recordingId)+'" '+(state.inventories[recording.recordingId]?'checked':'')+'> 我已完整试听整条录音，并已追加所有计划外错误</label></p>'
      +(spec.events||[]).map(event=>eventFields(recording.recordingId,event)).join('')
      +extras.map(event=>eventFields(recording.recordingId,event,true)).join('')
      +'<button class="secondary" data-add="'+esc(recording.recordingId)+'">追加计划外错误</button></article>';
  }).join("");
  bindInputs();summary();
}
function materializeEvent(recordingId,event){
  const value=valueFor(recordingId,event);
  const result={...event,...value};
  result.measure=Number(result.measure);
  result.beat=Number(result.beat);
  result.scoreMidi=Number(result.scoreMidi);
  result.asPerformed=String(result.asPerformed||"").trim();
  if(!result.confusionKind) delete result.confusionKind;
  return result;
}
function validateAndBuild(){
  const problems=[];
  const truth=structuredClone(PACK.truth);
  const recordingMetadata={};
  for(const recording of PACK.recordings){
    const id=recording.recordingId;
    const base=PACK.truth.recordings[id];
    const metadata=state.metadata[id]||{};
    const events=[...(base.events||[]),...(state.extras[id]||[])].map(event=>materializeEvent(id,event));
    if(!state.inventories[id]) problems.push(id+"：尚未签署完整错误清单");
    if(!state.metadataConfirmed[id]) problems.push(id+"：尚未签署录音元数据");
    for(const field of ["performerId","deviceId","roomId"]){
      if(!String(metadata[field]||"").trim()) problems.push(id+"："+field+" 未填写");
    }
    if(metadata.consent!=="yes") problems.push(id+"：尚未确认录音同意");
    if(metadata.licenseStatus!=="local-only") problems.push(id+"：尚未确认仅本地许可");
    const positions=new Set();
    for(const event of events){
      if(!GATES.includes(event.gate)||!LABELS.includes(event.label)) problems.push(id+"/"+event.eventId+"：gate 或实际标签无效");
      if(!Number.isInteger(event.measure)||event.measure<1||!Number.isFinite(event.beat)||event.beat<=0||!Number.isInteger(event.scoreMidi)||event.scoreMidi<0||event.scoreMidi>127) problems.push(id+"/"+event.eventId+"：位置无效");
      if(!event.asPerformed) problems.push(id+"/"+event.eventId+"：实际演奏未填写");
      if(event.label==="confusion_negative"&&!String(event.confusionKind||"").trim()) problems.push(id+"/"+event.eventId+"：混淆负例必须填写 confusionKind");
      const position=event.measure+"|"+event.beat+"|"+event.scoreMidi;
      if(positions.has(position)) problems.push(id+"/"+event.eventId+"：与同录音另一事件位置重复");
      positions.add(position);
    }
    truth.recordings[id]={completeErrorInventory:true,events};
    recordingMetadata[id]={
      performerId:String(metadata.performerId||"").trim(),
      deviceId:String(metadata.deviceId||"").trim(),
      roomId:String(metadata.roomId||"").trim(),
      consent:String(metadata.consent||"").trim(),
      licenseStatus:String(metadata.licenseStatus||"").trim()
    };
  }
  const output={
    contractVersion:"${COMPLETED_CONTRACT}",
    roundNumber:PACK.roundNumber,
    ...(PACK.scope?{scope:PACK.scope}:{}),
    ...(PACK.stageAAuthorization?{stageAAuthorization:PACK.stageAAuthorization}:{}),
    sourceContractSha256:PACK.contractSha256,
    sourceManifestSha256:PACK.manifestSha256,
    sourceTruthSha256:PACK.truthSha256,
    audioSha256ByRecording:Object.fromEntries(PACK.recordings.map(row=>[row.recordingId,row.audioSha256])),
    recordingMetadata,
    truth
  };
  return {problems,output};
}
function summary(){
  const recordings=PACK.recordings.length;
  const inventoryDone=PACK.recordings.filter(row=>state.inventories[row.recordingId]).length;
  const metadataDone=PACK.recordings.filter(row=>state.metadataConfirmed[row.recordingId]).length;
  const allEvents=PACK.recordings.flatMap(row=>[...(PACK.truth.recordings[row.recordingId].events||[]),...(state.extras[row.recordingId]||[])].map(event=>[row.recordingId,event]));
  const filled=allEvents.filter(([id,event])=>String(valueFor(id,event).asPerformed||"").trim()).length;
  document.getElementById("summary").textContent=" 元数据 "+metadataDone+"/"+recordings+"；完整录音 "+inventoryDone+"/"+recordings+"；事件 "+filled+"/"+allEvents.length;
}
document.getElementById("download").addEventListener("click",()=>{
  const {problems,output}=validateAndBuild();
  if(problems.length){alert("还不能下载：\\n"+problems.slice(0,20).join("\\n")+(problems.length>20?"\\n…共 "+problems.length+" 项":""));return;}
  const blob=new Blob([JSON.stringify(output,null,2)+"\\n"],{type:"application/json"});
  const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="western-round"+PACK.roundNumber+"-truth-signoff.completed.json";link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
});
render();
</script></body></html>`;
}

export async function writeTruthSignoffPack({
  repoRoot = process.cwd(),
  contractPath,
  manifestPath = DEFAULT_MANIFEST,
  truthPath = DEFAULT_TRUTH,
  outDir = DEFAULT_OUT,
  roundNumber = 5,
  split,
  stagedProtocolPath = DEFAULT_STAGED_PATHS.protocol,
  stageAAuthorizationOptions = {},
} = {}) {
  if (![5, 6].includes(Number(roundNumber))) {
    throw new Error(`unsupported round number: ${roundNumber}`);
  }
  const root = path.resolve(repoRoot);
  const selectedContractPath = contractPath || (Number(roundNumber) === 6
    ? path.join("config", "western-strings-round6-counterbalanced-contract.json")
    : DEFAULT_CONTRACT);
  const [contractSource, manifestSource, truthSource] = await Promise.all([
    readSource(root, selectedContractPath),
    readSource(root, manifestPath),
    readSource(root, truthPath),
  ]);
  const contract = JSON.parse(contractSource.bytes.toString("utf8"));
  const manifest = parseCsv(manifestSource.bytes.toString("utf8"));
  const truth = JSON.parse(truthSource.bytes.toString("utf8"));
  const output = path.resolve(root, outDir);
  const blockers = [];
  const recordings = [];
  const selectedSplit = split ? String(split).trim() : "";
  if (Number(roundNumber) === 6 && !selectedSplit) {
    throw new Error("round6 truth-signoff split is required");
  }
  if (selectedSplit && (
    Number(roundNumber) !== 6
    || !["calibration", "fresh-blind"].includes(selectedSplit)
  )) {
    throw new Error(`unsupported truth-signoff split: ${selectedSplit}`);
  }
  const expectedContract = Number(roundNumber) === 6
    ? "western-round6-counterbalanced-diagnosis-v1"
    : "western-round5-targeted-diagnosis-intake-v1";
  if (contract.contractVersion !== expectedContract) {
    blockers.push(`round${roundNumber}-signoff-contract-invalid`);
  }
  if (truth.contractVersion !== expectedContract) {
    blockers.push(`round${roundNumber}-signoff-truth-contract-invalid`);
  }
  for (const row of manifest) {
    if (!truth.recordings?.[row.recordingId]) {
      blockers.push(`round${roundNumber}-signoff-truth-recording-missing:${row.recordingId}`);
    }
  }
  for (const recordingId of Object.keys(truth.recordings || {})) {
    if (!manifest.some((row) => row.recordingId === recordingId)) {
      blockers.push(`round${roundNumber}-signoff-manifest-recording-missing:${recordingId}`);
    }
  }
  const selectedManifest = selectedSplit
    ? manifest.filter((row) => row.split === selectedSplit)
    : manifest;
  if (selectedSplit && selectedManifest.length !== 6) {
    blockers.push(
      `round${roundNumber}-signoff-scope-recording-count-invalid:${
        selectedManifest.length
      }/6`,
    );
  }
  let stageAAuthorization = null;
  if (Number(roundNumber) === 6 && selectedSplit === "calibration") {
    const stageALineagePath = (
      stageAAuthorizationOptions.stageALineagePath
      || DEFAULT_STAGED_PATHS.stageALineage
    );
    if (await fileExists(path.resolve(root, stageALineagePath))) {
      blockers.push("round6-stage-a-signoff-already-applied");
    }
  }
  if (Number(roundNumber) === 6 && selectedSplit === "fresh-blind") {
    const authorization = await validateStageAAuthorization({
      ...stageAAuthorizationOptions,
      repoRoot: root,
      protocolPath: stagedProtocolPath,
      contractPath: selectedContractPath,
      manifestPath,
      truthPath,
    });
    if (!authorization.ready) {
      blockers.push(...authorization.blockingReasons);
    } else {
      const selectedIds = selectedManifest.map((row) => row.recordingId);
      if (!sameIds(selectedIds, authorization.stageBRecordingIds)) {
        blockers.push("round6-stage-b-recording-set-mismatch");
      } else {
        stageAAuthorization = authorization.authorizationBinding;
      }
    }
  }
  if (blockers.length) {
    return {
      ok: false,
      readyForSignoff: false,
      freshAudioRead: false,
      blockingReasons: [...new Set(blockers)].sort(),
    };
  }
  for (const row of selectedManifest) {
    if (!truth.recordings?.[row.recordingId]) continue;
    const audioPath = path.resolve(root, row.audioPath);
    try {
      const audioBytes = await fs.readFile(audioPath);
      recordings.push({
        ...row,
        audioSha256: sha256(audioBytes),
        audioRelativePath: posixPath(path.relative(output, audioPath)),
      });
    } catch (error) {
      blockers.push(
        `round${roundNumber}-signoff-audio-${
          error?.code === "ENOENT" ? "missing" : "unreadable"
        }:${row.recordingId}`,
      );
    }
  }
  if (blockers.length) {
    return {
      ok: false,
      readyForSignoff: false,
      freshAudioRead: selectedSplit === "fresh-blind",
      blockingReasons: [...new Set(blockers)].sort(),
    };
  }
  const selectedRecordingIds = recordings.map((row) => row.recordingId);
  const scopedTruth = selectedSplit
    ? {
      ...truth,
      recordings: Object.fromEntries(
        selectedRecordingIds.map(
          (recordingId) => [recordingId, truth.recordings[recordingId]],
        ),
      ),
    }
    : truth;
  const scope = selectedSplit
    ? { split: selectedSplit, recordingIds: selectedRecordingIds }
    : null;
  await fs.mkdir(output, { recursive: true });
  const html = renderHtml({
    truth: scopedTruth,
    recordings,
    contractSha256: contractSource.sha256,
    manifestSha256: manifestSource.sha256,
    truthSha256: truthSource.sha256,
    roundNumber: Number(roundNumber),
    scope,
    stageAAuthorization,
  });
  const pagePath = path.join(output, "index.html");
  await fs.writeFile(pagePath, html, "utf8");
  return {
    ok: true,
    readyForSignoff: true,
    page: posixPath(path.relative(root, pagePath)),
    contractSha256: contractSource.sha256,
    manifestSha256: manifestSource.sha256,
    truthSha256: truthSource.sha256,
    recordingCount: recordings.length,
    eventCount: recordings.reduce(
      (sum, row) => sum + truth.recordings[row.recordingId].events.length,
      0,
    ),
    audioHashesBound: recordings.length,
    scope,
    ...(stageAAuthorization ? { stageAAuthorization } : {}),
    machinePredictionsIncluded: false,
    blockingReasons: [],
  };
}

export const writeRound5TruthSignoffPack = writeTruthSignoffPack;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--contract") args.contractPath = argv[++index];
    else if (arg === "--manifest") args.manifestPath = argv[++index];
    else if (arg === "--truth") args.truthPath = argv[++index];
    else if (arg === "--out") args.outDir = argv[++index];
    else if (arg === "--round") args.roundNumber = Number(argv[++index]);
    else if (arg === "--split") args.split = argv[++index];
    else if (arg === "--staged-protocol") args.stagedProtocolPath = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  writeTruthSignoffPack(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
