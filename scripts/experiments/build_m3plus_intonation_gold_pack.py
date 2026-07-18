#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the M3+ per-unit intonation-gold annotation pack for the owner.

The rescope gate needs INDEPENDENT per-unit intonation gold joinable by
(recordingId, measure, unitIndex): 12 unmarked-straight source units
(currently 0/12) and 8 vibrato/slide targets (currently 0/8). This tool
slices the m3p holdout audio into per-unit clips and emits a Chinese
annotation page whose export matches the gate schema exactly
(`intonationGoldUnits`: pitchAccuracyLabel in {in-tune, sharp, flat,
wrong-note}, intonationGoldVerified=true).

  generate:  python build_m3plus_intonation_gold_pack.py
  merge:     python build_m3plus_intonation_gold_pack.py --merge <completed.json>

Merge appends verified rows into docs/western-strings-round2-m3plus-human-gold.json
(non-destructive, deduped by unit key) and reminds to rerun the rescope gate.
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE = (REPO / "data" / "experiments" / "western-strings-m3plus"
          / "supplemental-machine-eval" / "supplemental-machine-eval.json")
HUMAN_GOLD = REPO / "docs" / "western-strings-round2-m3plus-human-gold.json"
OUT = REPO / "data" / "experiments" / "western-strings-m3plus" / "intonation-gold-pack"
TARGET_BEHAVIORS = {"stable", "vibrato", "slide-source"}
PAD_SECONDS = 0.6

BEHAVIOR_CN = {
    "stable": ("平拉", "判这个音整体的音准中心:准 / 偏高 / 偏低 / 拉错音"),
    "vibrato": ("揉弦", "判揉弦的摆动中心(不是波动本身):中心准 / 中心偏高 / 中心偏低 / 拉错音"),
    "slide-source": ("滑音", "掐头去尾,判滑音到达并停住的目标音:准 / 偏高 / 偏低 / 拉错音"),
}


def load_units() -> list[dict]:
    report = json.loads(SOURCE.read_text(encoding="utf-8"))
    units = []
    for recording in report.get("recordings") or []:
        for row in recording.get("rows") or []:
            if row.get("evaluationSplit") != "holdout":
                continue
            if str(row.get("expectedBehavior")) not in TARGET_BEHAVIORS:
                continue
            units.append({
                "recordingId": recording["recordingId"],
                "audioPath": recording["audioPath"],
                "measure": int(row.get("measure") or 0),
                "unitIndex": int(row.get("unitIndex") if row.get("unitIndex") is not None else -1),
                "expectedBehavior": str(row.get("expectedBehavior")),
                "basePitch": str(row.get("basePitch") or ""),
                "baseMidi": row.get("baseMidi"),
                "startSec": float(row.get("firstVoicedSeconds") or 0.0),
                "endSec": float(row.get("lastVoicedSeconds") or 0.0),
            })
    units.sort(key=lambda u: (u["expectedBehavior"], u["recordingId"], u["measure"], u["unitIndex"]))
    return units


def slice_clips(units: list[dict]) -> None:
    import librosa
    import soundfile as sf
    clips = OUT / "clips"
    clips.mkdir(parents=True, exist_ok=True)
    cache: dict[str, tuple] = {}
    for unit in units:
        path = unit["audioPath"]
        if path not in cache:
            cache[path] = librosa.load(path, sr=22050, mono=True)
        y, sr = cache[path]
        start = max(0.0, unit["startSec"] - PAD_SECONDS)
        end = min(len(y) / sr, unit["endSec"] + PAD_SECONDS)
        clip = y[int(start * sr):int(end * sr)]
        name = f"{unit['recordingId']}-m{unit['measure']}-u{unit['unitIndex']}.wav"
        sf.write(str(clips / name), clip, sr)
        unit["clip"] = f"clips/{name}"


def render_html(units: list[dict]) -> str:
    rows = []
    for index, unit in enumerate(units):
        behavior_cn, guidance = BEHAVIOR_CN[unit["expectedBehavior"]]
        uid = f"{unit['recordingId']}:m{unit['measure']}:u{unit['unitIndex']}"
        rows.append(f"""
<div class="unit" data-recording="{html.escape(unit['recordingId'])}" data-measure="{unit['measure']}" data-unit="{unit['unitIndex']}">
  <h3>{index + 1}/{len(units)} — {html.escape(uid)} <span class="tag">{behavior_cn}</span></h3>
  <p>谱面音高:<b>{html.escape(unit['basePitch'])}</b>(MIDI {unit['baseMidi']}),第 {unit['measure']} 小节。{html.escape(guidance)}</p>
  <audio controls preload="none" src="{unit['clip']}"></audio>
  <div class="btns">
    <label><input type="radio" name="lab-{index}" value="in-tune">准(in-tune)</label>
    <label><input type="radio" name="lab-{index}" value="sharp">偏高(sharp)</label>
    <label><input type="radio" name="lab-{index}" value="flat">偏低(flat)</label>
    <label><input type="radio" name="lab-{index}" value="wrong-note">拉错音(wrong-note)</label>
    <label><input type="radio" name="lab-{index}" value="uncertain">听不准/跳过</label>
  </div>
  <input class="note" placeholder="备注(可选)" />
</div>""")
    return f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>M3+ 逐音音准 gold 标注(12 平拉 + 8 技法)</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;line-height:1.6}}
.unit{{border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin:14px 0}}
.tag{{background:#eef;border-radius:4px;padding:2px 8px;font-size:0.85em;margin-left:8px}}
.btns label{{margin-right:14px;white-space:nowrap}}
.note{{width:100%;margin-top:8px;padding:4px}}
#export{{position:sticky;bottom:12px;background:#1a7f37;color:#fff;border:none;border-radius:8px;padding:12px 22px;font-size:1em;cursor:pointer}}
#progress{{font-weight:bold}}
</style></head><body>
<h1>M3+ 逐音音准 gold 标注</h1>
<p>共 {len(units)} 个单元(平拉判整体中心;揉弦判摆动中心;滑音判掐头去尾后的目标音)。
每条听后选一项;"听不准/跳过"不会写入 gold。标完点底部导出,把下载的
<code>intonation-gold-units.completed.json</code> 发回即可。</p>
<p id="progress">已标 0 / {len(units)}</p>
{''.join(rows)}
<button id="export">导出标注 JSON</button>
<script>
const units = document.querySelectorAll('.unit');
function refresh() {{
  let done = 0;
  units.forEach((u) => {{ if (u.querySelector('input[type=radio]:checked')) done += 1; }});
  document.getElementById('progress').textContent = `已标 ${{done}} / ${{units.length}}`;
}}
document.addEventListener('change', refresh);
document.getElementById('export').onclick = () => {{
  const out = [];
  units.forEach((u) => {{
    const pick = u.querySelector('input[type=radio]:checked');
    if (!pick || pick.value === 'uncertain') return;
    out.push({{
      recordingId: u.dataset.recording,
      measure: Number(u.dataset.measure),
      unitIndex: Number(u.dataset.unit),
      pitchAccuracyLabel: pick.value,
      intonationGoldVerified: true,
      notes: u.querySelector('.note').value || "",
    }});
  }});
  const blob = new Blob([JSON.stringify({{ intonationGoldUnits: out }}, null, 2)],
                       {{ type: 'application/json' }});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'intonation-gold-units.completed.json';
  link.click();
}};
</script></body></html>"""


def merge(completed_path: Path) -> int:
    completed = json.loads(completed_path.read_text(encoding="utf-8"))
    incoming = completed.get("intonationGoldUnits") or []
    gold = json.loads(HUMAN_GOLD.read_text(encoding="utf-8"))
    existing = gold.setdefault("intonationGoldUnits", [])
    seen = {(str(r.get("recordingId")), int(r.get("measure") or 0),
             int(r.get("unitIndex") if r.get("unitIndex") is not None else -1))
            for r in existing}
    inserted = 0
    for row in incoming:
        key = (str(row.get("recordingId")), int(row.get("measure") or 0),
               int(row.get("unitIndex") if row.get("unitIndex") is not None else -1))
        if row.get("intonationGoldVerified") is not True or key in seen:
            continue
        existing.append(row)
        seen.add(key)
        inserted += 1
    HUMAN_GOLD.write_text(json.dumps(gold, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"inserted": inserted, "totalGoldUnits": len(existing),
                      "next": "npm run western:m3plus-rescope-gate"}, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merge", type=Path)
    args = parser.parse_args()
    if args.merge:
        return merge(args.merge)
    units = load_units()
    expected = {"stable": 12, "vibrato": 4, "slide-source": 4}
    counts = {b: sum(1 for u in units if u["expectedBehavior"] == b) for b in expected}
    if counts != expected:
        raise SystemExit(f"unit inventory mismatch: {counts} != {expected}")
    slice_clips(units)
    (OUT / "index.html").write_text(render_html(units), encoding="utf-8")
    (OUT / "units.json").write_text(json.dumps(
        {"evalOnly": True, "units": [{k: u[k] for k in u if k != "audioPath"} for u in units]},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"units": len(units), "byBehavior": counts,
                      "pack": str((OUT / 'index.html').relative_to(REPO))}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
