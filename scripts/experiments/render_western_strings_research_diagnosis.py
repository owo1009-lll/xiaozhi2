#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Research-level diagnosis viewer: score + recording -> a page you can read.

This is NOT the safety-gated production pipeline (ordinary dynamic-shadow /
M3+ / M4). It reuses the already-validated score<->audio verdict algorithm
from proto_western_strings_score_anchored_feedback.py (chord-aware
Needleman-Wunsch alignment + fail-closed verdict discipline: recording-
coverage end, strict pitch greens, piece-level agreement gate, both-neighbor
red rule) with NO OMR/photo dependency at all -- it works directly off a
clean MusicXML file, so it sidesteps the M4 photo-OMR gap entirely.

Purpose: let the owner look at real diagnosis output on a real recording
right now, to judge whether the underlying judgment is good enough before
investing in scaling up coverage. This produces no runtime artifact, touches
no gate/authorization state, and is not wired to any student-facing path.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402

DEFAULT_OUT_ROOT = REPO / "data" / "experiments" / "western-strings-research-diagnosis"
VERDICT_LABELS = {
    "confirmed": "音准确认",
    "pitch-mismatch": "音高不符",
    "no-audio-evidence": "未听到证据",
    "beyond-recording": "超出录音范围",
    "anchor-uncertain": "位置不确定",
}


def midi_name(midi: int) -> str:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return f"{names[midi % 12]}{midi // 12 - 1}"


def score_events_with_offsets(score_path: Path) -> list[dict]:
    """Same chord grouping as anchor.mxl_events, but also keeps the musical
    offset and a human-readable measure/beat label for display."""
    from music21 import converter

    stream = converter.parse(str(score_path))
    events: dict[float, dict] = {}
    for note in stream.flatten().notes:
        offset = round(float(note.offset), 4)
        entry = events.setdefault(offset, {
            "measure": int(note.measureNumber or 0),
            "beat": float(note.beat) if note.beat is not None else None,
            "midis": set(),
        })
        entry["midis"].update(int(pitch.midi) for pitch in note.pitches)
    ordered = []
    for offset in sorted(events):
        entry = events[offset]
        ordered.append({
            "measure": entry["measure"],
            "beat": entry["beat"],
            "midis": sorted(entry["midis"]),
        })
    return ordered


def render_html(payload: dict) -> str:
    def esc(value):
        return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    rows = []
    for row in payload["notes"]:
        color = anchor.COLORS.get(row["verdict"], (107, 114, 128))
        rgb = f"rgb({color[0]},{color[1]},{color[2]})"
        deviation = row.get("timingDeviationSec")
        deviation_text = f"{deviation:+.2f}s" if deviation is not None else "—"
        rows.append(
            "<tr>"
            f"<td>{row['measure']}</td>"
            f"<td>{row['beat'] if row['beat'] is not None else '—'}</td>"
            f"<td>{esc(', '.join(row['scoreNoteNames']))}</td>"
            f"<td>{esc(', '.join(row['audioNoteNames']) if row['audioNoteNames'] else '—')}</td>"
            f"<td style=\"color:{rgb};font-weight:600\">{esc(VERDICT_LABELS.get(row['verdict'], row['verdict']))}</td>"
            f"<td>{deviation_text}</td>"
            "</tr>"
        )
    counts = payload["verdictCounts"]
    count_badges = "".join(
        f"<span style=\"display:inline-block;margin-right:14px;\">"
        f"<span style=\"display:inline-block;width:12px;height:12px;border-radius:2px;"
        f"background:rgb({anchor.COLORS[key][0]},{anchor.COLORS[key][1]},{anchor.COLORS[key][2]});"
        f"margin-right:6px;vertical-align:middle;\"></span>"
        f"{esc(VERDICT_LABELS.get(key, key))}: {counts.get(key, 0)}</span>"
        for key in anchor.COLORS
    )
    return f"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<title>{esc(payload['title'])} — 研究级诊断</title>
<style>
body {{ font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 24px; color: #1f2937; background:#f8fafc; }}
h1 {{ font-size: 20px; margin-bottom: 4px; }}
.note {{ color: #b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:10px 14px; margin:12px 0; font-size:14px; }}
.stats {{ margin: 14px 0; font-size: 14px; }}
table {{ border-collapse: collapse; width: 100%; background:white; box-shadow:0 1px 2px rgba(0,0,0,0.06); }}
th, td {{ border: 1px solid #e2e8f0; padding: 6px 10px; font-size: 13px; text-align: left; }}
th {{ background: #f1f5f9; position: sticky; top: 0; }}
audio {{ width: 100%; margin: 12px 0; }}
</style></head>
<body>
<h1>{esc(payload['title'])}</h1>
<div class="note">研究级诊断工具,不是安全闸门后的正式产品判断;用于负责人本人快速判断这套判断算法在真实录音上够不够用。</div>
<audio controls preload="metadata" src="{esc(payload['audioRelPath'])}"></audio>
<div class="stats">
  <div>{count_badges}</div>
  <div style="margin-top:8px;">整体一致率(仅计确认/不符): <b>{payload['audioAgreementHeard']:.1%}</b>
  &nbsp;|&nbsp; 整曲判定: <b>{esc(payload['pieceGate'])}</b>
  &nbsp;|&nbsp; 谱面音符数: {payload['scoreNoteCount']} &nbsp;|&nbsp; 录音识别音符数: {payload['audioNoteCount']}</div>
</div>
<table>
<thead><tr><th>小节</th><th>拍</th><th>谱面音高</th><th>录音识别音高</th><th>判定</th><th>时值偏差</th></tr></thead>
<tbody>
{''.join(rows)}
</tbody>
</table>
</body></html>
"""


def run(score_path: Path, audio_path: Path, title: str, out_dir: Path) -> dict:
    score_events = score_events_with_offsets(score_path)
    plain_events = [{"measure": e["measure"], "midis": e["midis"]} for e in score_events]
    audio_ev = anchor.audio_events(audio_path)
    uncertain_flags = [False] * len(plain_events)
    verdicts, match, time_pred, agreement, piece_gate = anchor.compute_verdicts(
        plain_events, audio_ev, uncertain_flags,
    )
    notes = []
    for i, event in enumerate(score_events):
        audio_index = match[i] if match else None
        deviation = None
        if audio_index is not None and time_pred is not None:
            deviation = round(float(audio_ev[audio_index]["start"]) - float(time_pred[i]), 3)
        notes.append({
            "measure": event["measure"],
            "beat": round(event["beat"], 2) if event["beat"] is not None else None,
            "scoreNoteNames": [midi_name(m) for m in event["midis"]],
            "audioNoteNames": [midi_name(m) for m in audio_ev[audio_index]["midis"]] if audio_index is not None else [],
            "verdict": verdicts[i],
            "timingDeviationSec": deviation,
        })
    counts = {key: verdicts.count(key) for key in anchor.COLORS}
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_link = out_dir / audio_path.name
    if not audio_link.exists():
        audio_link.write_bytes(audio_path.read_bytes())
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "title": title,
        "scorePath": str(score_path.relative_to(REPO)) if score_path.is_relative_to(REPO) else str(score_path),
        "audioPath": str(audio_path.relative_to(REPO)) if audio_path.is_relative_to(REPO) else str(audio_path),
        "audioRelPath": audio_path.name,
        "scoreNoteCount": len(score_events),
        "audioNoteCount": len(audio_ev),
        "verdictCounts": counts,
        "audioAgreementHeard": agreement,
        "pieceGate": piece_gate,
        "notes": notes,
        "caveat": "research-only viewer; reuses the validated score-anchored verdict algorithm, no OMR/photo dependency, not the safety-gated production pipeline",
    }
    (out_dir / "diagnosis.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    html_path = out_dir / "index.html"
    html_path.write_text(render_html(payload), encoding="utf-8")
    return {"json": out_dir / "diagnosis.json", "html": html_path, "payload": payload}


def parse_manifest(manifest_path: Path) -> list[dict]:
    import csv

    with manifest_path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.DictReader(handle) if any((value or "").strip() for value in row.values())]


def render_index_html(rows: list[dict]) -> str:
    def esc(value):
        return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    ordered = sorted(rows, key=lambda row: row["audioAgreementHeard"])
    table_rows = []
    for row in ordered:
        counts = row["verdictCounts"]
        flagged = counts.get("pitch-mismatch", 0) + counts.get("no-audio-evidence", 0)
        agreement_pct = row["audioAgreementHeard"] * 100
        bar_color = "#16a34a" if agreement_pct >= 80 else ("#d97706" if agreement_pct >= 60 else "#dc2626")
        table_rows.append(
            "<tr>"
            f"<td><a href=\"{esc(row['relLink'])}\">{esc(row['title'])}</a></td>"
            f"<td>{row['scoreNoteCount']}</td>"
            f"<td style=\"color:{bar_color};font-weight:600\">{agreement_pct:.1f}%</td>"
            f"<td>{counts.get('confirmed', 0)}</td>"
            f"<td>{counts.get('pitch-mismatch', 0)}</td>"
            f"<td>{counts.get('no-audio-evidence', 0)}</td>"
            f"<td>{flagged}</td>"
            f"<td>{esc(row['pieceGate'])}</td>"
            "</tr>"
        )
    mean_agreement = sum(r["audioAgreementHeard"] for r in rows) / len(rows) if rows else 0
    return f"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<title>研究级诊断汇总</title>
<style>
body {{ font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 24px; color: #1f2937; background:#f8fafc; }}
h1 {{ font-size: 20px; }}
.note {{ color: #b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:10px 14px; margin:12px 0; font-size:14px; }}
table {{ border-collapse: collapse; width: 100%; background:white; box-shadow:0 1px 2px rgba(0,0,0,0.06); }}
th, td {{ border: 1px solid #e2e8f0; padding: 6px 10px; font-size: 13px; text-align: left; }}
th {{ background: #f1f5f9; }}
a {{ color:#2563eb; text-decoration:none; }}
a:hover {{ text-decoration:underline; }}
</style></head>
<body>
<h1>研究级诊断汇总 — {len(rows)} 条录音</h1>
<div class="note">研究级诊断工具,不是安全闸门后的正式产品判断。按一致率从低到高排序,一致率低的排在最上面,方便优先看有问题的录音。</div>
<div style="margin:10px 0;font-size:14px;">整体平均一致率: <b>{mean_agreement:.1%}</b></div>
<table>
<thead><tr><th>录音</th><th>谱面音符数</th><th>一致率</th><th>确认</th><th>不符</th><th>无证据</th><th>被标记合计</th><th>整曲判定</th></tr></thead>
<tbody>
{''.join(table_rows)}
</tbody>
</table>
</body></html>
"""


def run_manifest(manifest_path: Path, out_root: Path) -> list[dict]:
    rows = parse_manifest(manifest_path)
    results = []
    for row in rows:
        recording_id = (row.get("recordingId") or row.get("title") or "").strip()
        score_path = (REPO / row["scorePath"]).resolve()
        audio_path = (REPO / row["audioPath"]).resolve()
        title = (row.get("title") or recording_id or audio_path.stem).strip()
        out_dir = out_root / recording_id
        print(f"[{recording_id}] {title} ...", file=sys.stderr)
        try:
            result = run(score_path, audio_path, title, out_dir)
            payload = result["payload"]
            results.append({
                "recordingId": recording_id,
                "title": title,
                "relLink": f"{recording_id}/index.html",
                "scoreNoteCount": payload["scoreNoteCount"],
                "verdictCounts": payload["verdictCounts"],
                "audioAgreementHeard": payload["audioAgreementHeard"],
                "pieceGate": payload["pieceGate"],
                "error": None,
            })
        except Exception as exc:  # noqa: BLE001 - a single bad row must not stop the batch
            results.append({
                "recordingId": recording_id,
                "title": title,
                "relLink": "",
                "scoreNoteCount": 0,
                "verdictCounts": {},
                "audioAgreementHeard": 0.0,
                "pieceGate": "error",
                "error": f"{type(exc).__name__}: {exc}",
            })
            print(f"  FAILED: {exc}", file=sys.stderr)
    ok_results = [r for r in results if r["error"] is None]
    (out_root / "index.html").write_text(render_index_html(ok_results), encoding="utf-8")
    (out_root / "index.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    return results


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--score", help="Path to a clean .musicxml file")
    parser.add_argument("--audio", help="Path to the recording")
    parser.add_argument("--title", default=None)
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--manifest", help="CSV with recordingId,title,scorePath,audioPath columns; batch mode")
    args = parser.parse_args(argv)

    if args.manifest:
        out_root = Path(args.out_dir).resolve() if args.out_dir else DEFAULT_OUT_ROOT
        results = run_manifest(Path(args.manifest).resolve(), out_root)
        failed = [r for r in results if r["error"]]
        print(json.dumps({
            "recordingCount": len(results),
            "failedCount": len(failed),
            "failed": failed,
            "index": str((out_root / "index.html").relative_to(REPO)),
        }, ensure_ascii=False, indent=1))
        return 0

    if not args.score or not args.audio:
        parser.error("either --manifest, or both --score and --audio, are required")
    score_path = Path(args.score).resolve()
    audio_path = Path(args.audio).resolve()
    title = args.title or f"{score_path.stem} / {audio_path.stem}"
    out_dir = Path(args.out_dir).resolve() if args.out_dir else DEFAULT_OUT_ROOT / audio_path.stem

    result = run(score_path, audio_path, title, out_dir)
    summary = {
        "title": title,
        "verdictCounts": result["payload"]["verdictCounts"],
        "audioAgreementHeard": result["payload"]["audioAgreementHeard"],
        "pieceGate": result["payload"]["pieceGate"],
        "html": str(result["html"].relative_to(REPO)) if result["html"].is_relative_to(REPO) else str(result["html"]),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
