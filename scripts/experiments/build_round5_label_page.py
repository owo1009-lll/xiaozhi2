"""Build the Round 5 truth-labeling web page.

Emits data/private/western-strings-round5/label.html: a self-contained local
page (no external requests) that plays each recording from its sibling .m4a,
shows every planted/negative slot with what was planned, lets the reviewer mark
"as-planned" or type the actual performance, sign completeErrorInventory per
recording, and download the completed position-truth.json.

It only edits asPerformed + completeErrorInventory; every other field is carried
through verbatim so the download matches the intake schema exactly.
"""
import csv
import json
import os

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "data", "private", "western-strings-round5")

truth = json.load(open(os.path.join(OUT, "position-truth.json"), encoding="utf-8"))
meta = {}
with open(os.path.join(OUT, "manifest.csv"), encoding="utf-8-sig", newline="") as handle:
    for row in csv.DictReader(handle):
        meta[row["recordingId"]] = {
            "split": row["split"], "performerId": row["performerId"],
            "deviceId": row["deviceId"], "roomId": row["roomId"],
            "audio": os.path.basename(row["audioPath"]),
            "pdf": row["recordingId"] + ".pdf",
        }

HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Round 5 真值标注</title>
<style>
:root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0d1117;color:#e6edf3}
*{box-sizing:border-box}
body{max-width:1100px;margin:0 auto;padding:0 18px 120px}
header{position:sticky;top:0;background:#0d1117ee;backdrop-filter:blur(6px);padding:14px 0;border-bottom:1px solid #30363d;z-index:5}
h1{font-size:20px;margin:0 0 8px;color:#7ee787}
.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.rules{font-size:13px;color:#9da7b3;margin:8px 0 0;line-height:1.7}
.rules b{color:#e6edf3}
button{background:#238636;color:#fff;border:0;padding:9px 16px;border-radius:7px;cursor:pointer;font-size:14px}
button:disabled{background:#30363d;color:#7d8590;cursor:not-allowed}
.count{font-weight:700;font-size:15px}
details{margin:14px 0;border:1px solid #30363d;border-radius:10px;overflow:hidden}
details[open]{border-color:#58a6ff}
summary{padding:12px 16px;cursor:pointer;background:#161b22;font-size:15px;display:flex;justify-content:space-between;align-items:center;gap:10px}
summary::-webkit-details-marker{display:none}
summary .tag{font-size:12px;color:#9da7b3;font-weight:400}
summary .st{font-size:13px;padding:2px 9px;border-radius:20px;border:1px solid}
.st.no{color:#f0883e;border-color:#f0883e}
.st.yes{color:#7ee787;border-color:#7ee787}
.body{padding:14px 16px}
audio{width:100%;margin:6px 0 12px}
.plink{font-size:13px;color:#58a6ff}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
th,td{border:1px solid #30363d;padding:7px 8px;text-align:left;vertical-align:top}
th{background:#161b22;position:sticky;top:0}
.pos{color:#f0883e;font-weight:700}
.neg{color:#79c0ff}
.plan{color:#9da7b3;font-size:12px}
input[type=text]{width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 8px;font-size:13px}
input[type=text].edited{border-color:#f0883e;background:#20160c}
tr.done td{background:#0f1a10}
.sign{margin-top:14px;padding:12px;border:1px solid #30363d;border-radius:8px;background:#161b22;display:flex;gap:10px;align-items:flex-start}
.sign input{margin-top:3px;transform:scale(1.3)}
.notes{width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:8px;font-size:13px;margin-top:8px;min-height:44px}
.hint{font-size:12px;color:#7d8590;margin-top:4px}
.warn{color:#f0883e}
</style>
</head>
<body>
<header>
  <h1>Round 5 真值标注 · 逐条听 → 标记 → 下载</h1>
  <div class="bar">
    <span class="count" id="count">已签 0 / 12</span>
    <button id="dl">下载 position-truth.json</button>
    <span class="hint" id="save">进度自动保存在本浏览器</span>
  </div>
  <div class="rules">
    <b>怎么填：</b>每条录音先听一耳朵确认<b>和它谱子是同一首</b>（调/旋律对得上）。逐个槽位：<b>拉得和计划一样就留空</b>；<b>有出入就在框里写实际拉成什么</b>。
    正常段落里<b>手滑拉错的音</b>写进该条底部「计划外错误」。全部核对完，勾选<b>「已听完并确认」</b>那条才算签署。12 条全签+下载后交给我跑闸。
  </div>
</header>
<main id="app"></main>
<script>
const TRUTH = __TRUTH__;
const META = __META__;
const STORE = "round5-label-v1";
let state = {};
try { state = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch(e){}

function save(){ try { localStorage.setItem(STORE, JSON.stringify(state)); } catch(e){} render(false); }
function st(rid){ state[rid] = state[rid] || {events:{}, notes:"", signed:false}; return state[rid]; }

const fmtBeat = b => Number.isInteger(b) ? b : b;

function render(full){
  const app = document.getElementById("app");
  if(full){
    app.innerHTML = Object.keys(TRUTH.recordings).map(rid => {
      const m = META[rid]||{}, rec = TRUTH.recordings[rid];
      const rows = rec.events.map(ev => {
        const pos = ev.label==="positive";
        const cls = pos?"pos":"neg";
        const mark = pos?"★":"○";
        const kind = pos?ev.gate:(ev.confusionKind||"");
        return `<tr data-rid="${rid}" data-ev="${ev.eventId}">
          <td class="${cls}">${mark} ${ev.gate}${pos?"":"·neg"}</td>
          <td>m${ev.measure} b${fmtBeat(ev.beat)}<br>midi ${ev.scoreMidi}</td>
          <td><div class="plan">${kind}</div>${ev.plannedPerformance}</td>
          <td><input type="text" data-rid="${rid}" data-ev="${ev.eventId}" placeholder="同计划就留空；有出入写实际拉成什么"></td>
        </tr>`;
      }).join("");
      return `<details data-card="${rid}">
        <summary>
          <span>${rid} <span class="tag">${m.split} · ${m.performerId}/${m.deviceId}/${m.roomId}</span></span>
          <span class="st no" data-st="${rid}">未签</span>
        </summary>
        <div class="body">
          <audio controls preload="none" src="${m.audio}"></audio>
          <a class="plink" href="${m.pdf}" target="_blank">↗ 打开标注 PDF（看每个槽位该怎么拉）</a>
          <table><thead><tr><th>槽位</th><th>位置</th><th>计划</th><th>实际拉成（同计划留空）</th></tr></thead><tbody>${rows}</tbody></table>
          <textarea class="notes" data-notes="${rid}" placeholder="计划外错误：写在正常段落里手滑拉错/漏的音，例如「m9 第2拍拉错成…」。没有就留空。"></textarea>
          <div class="hint">底部计划外错误若有，下载后连同告诉我，我补成正式事件。</div>
          <label class="sign"><input type="checkbox" data-sign="${rid}"><span><b>已听完并确认</b>这条的完整错误清单无误（= 签署 completeErrorInventory）。没听完别勾。</span></label>
        </div>
      </details>`;
    }).join("");
    // restore + bind
    Object.keys(TRUTH.recordings).forEach(rid=>{
      const s = state[rid]; if(!s) return;
      (rec => rec.events.forEach(ev=>{
        const inp = app.querySelector(`input[type=text][data-rid="${rid}"][data-ev="${ev.eventId}"]`);
        if(inp && s.events && s.events[ev.eventId]){ inp.value = s.events[ev.eventId]; if(inp.value.trim()) inp.classList.add("edited"); }
      }))(TRUTH.recordings[rid]);
      const nt = app.querySelector(`textarea[data-notes="${rid}"]`); if(nt && s.notes) nt.value = s.notes;
      const cb = app.querySelector(`input[data-sign="${rid}"]`); if(cb) cb.checked = !!s.signed;
    });
    app.addEventListener("input", e=>{
      const t = e.target;
      if(t.matches("input[type=text]")){ const s=st(t.dataset.rid); s.events[t.dataset.ev]=t.value; t.classList.toggle("edited", !!t.value.trim()); save(); }
      else if(t.matches("textarea[data-notes]")){ st(t.dataset.notes).notes=t.value; save(); }
    });
    app.addEventListener("change", e=>{
      if(e.target.matches("input[data-sign]")){ st(e.target.dataset.sign).signed=e.target.checked; save(); }
    });
  }
  // update signed badges + counter
  let n=0;
  Object.keys(TRUTH.recordings).forEach(rid=>{
    const signed = state[rid] && state[rid].signed; if(signed) n++;
    const badge = document.querySelector(`[data-st="${rid}"]`);
    if(badge){ badge.textContent = signed?"已签":"未签"; badge.className = "st "+(signed?"yes":"no"); }
  });
  document.getElementById("count").textContent = `已签 ${n} / 12`;
  const dl = document.getElementById("dl");
  dl.textContent = n<12 ? `下载 position-truth.json（还差 ${12-n} 条未签）` : "下载 position-truth.json ✓";
}

function download(){
  const out = JSON.parse(JSON.stringify(TRUTH));
  const notes = {};
  Object.keys(out.recordings).forEach(rid=>{
    const s = state[rid]||{events:{},notes:"",signed:false};
    const rec = out.recordings[rid];
    rec.completeErrorInventory = !!s.signed;
    rec.events.forEach(ev=>{
      const typed = (s.events[ev.eventId]||"").trim();
      ev.asPerformed = typed || (ev.label==="positive"
        ? "同计划·已按标注执行该错误" : "同计划·按描述干净演奏");
    });
    if((s.notes||"").trim()) notes[rid] = s.notes.trim();
  });
  if(Object.keys(notes).length) out.reviewerNotes = notes;
  const blob = new Blob([JSON.stringify(out,null,2)+"\\n"], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "position-truth.json"; a.click();
  URL.revokeObjectURL(a.href);
}
document.getElementById("dl").addEventListener("click", download);
render(true);
</script>
</body>
</html>
"""

html = (HTML
        .replace("__TRUTH__", json.dumps(truth, ensure_ascii=False))
        .replace("__META__", json.dumps(meta, ensure_ascii=False)))
with open(os.path.join(OUT, "label.html"), "w", encoding="utf-8") as handle:
    handle.write(html)
print("wrote", os.path.join(OUT, "label.html"))
