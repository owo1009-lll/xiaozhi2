# -*- coding: utf-8 -*-
"""Evaluate Sync Toolbox MRMS-DTW as an external score/audio sync baseline.

This is not a note matcher. It aligns a symbolic chroma score template to audio
chroma and evaluates the resulting audio-time -> score-position curve against
the second-level gold points.

Run with the isolated model-bakeoff venv because synctoolbox is not production.
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from synctoolbox.dtw.mrmsdtw import sync_via_mrmsdtw

REPO_ROOT = Path(__file__).resolve().parents[2]


def load_score_template(score_id: str, hop_seconds: float):
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((item for item in store.get("scores", []) if item.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")
    notes = []
    for section in score.get("sections", []) or []:
        tempo = max(30.0, float(section.get("tempo") or 72.0))
        for note in section.get("notes", []) or []:
            pos = note.get("notePosition") or {}
            if str(pos.get("scoreLineRole", "erhu")) != "erhu":
                continue
            midi = note.get("midiPitch")
            if midi is None:
                continue
            measure = int(note.get("measureIndex") or pos.get("globalMeasureIndex") or 0)
            if measure <= 0:
                continue
            notes.append({
                "sort": (
                    float(pos.get("globalMeasureIndex") or note.get("measureIndex") or measure),
                    float(note.get("beatStart", 0.0)),
                    float(note.get("beatDuration", 0.0)),
                    int(round(float(midi))),
                ),
                "measure": measure,
                "page": int(pos.get("pageNumber") or 0),
                "midi": int(round(float(midi))),
                "duration": float(note.get("beatDuration", 1.0)) * 60.0 / tempo,
            })
    notes.sort(key=lambda item: item["sort"])
    by_measure: dict[int, list[dict]] = defaultdict(list)
    for note in notes:
        by_measure[note["measure"]].append(note)
    for measure_notes in by_measure.values():
        ordered = sorted(measure_notes, key=lambda item: item["sort"])
        for idx, note in enumerate(ordered):
            if len(ordered) == 1:
                note["position"] = "single"
            elif idx == 0:
                note["position"] = "start"
            elif idx == len(ordered) - 1:
                note["position"] = "end"
            else:
                note["position"] = "middle"

    cols, meta = [], []
    for note in notes:
        col = np.zeros(12, dtype=np.float32)
        col[note["midi"] % 12] = 1.0
        frames = max(1, int(round(note["duration"] / hop_seconds)))
        for _ in range(frames):
            cols.append(col)
            meta.append({"measure": note["measure"], "position": note["position"], "page": note["page"]})
    return np.stack(cols, axis=1), meta


def load_gold(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            rows.append({
                "timeLabel": row.get("timeLabel", ""),
                "timeSeconds": float(row["timeSeconds"]),
                "measure": int(row["measure"]),
                "position": str(row.get("positionInMeasure", "")).strip(),
            })
    return rows


def position_matches(expected: str, predicted: str) -> bool:
    return expected == predicted or (predicted == "single" and expected in {"start", "middle", "end"})


def eval_curve(audio_to_score_frame: np.ndarray, meta: list[dict], gold: list[dict], *, hop_seconds: float, window_seconds: float):
    rows = []
    exact = within1 = position = 0
    for row in gold:
        f0 = max(0, int(np.floor(row["timeSeconds"] / hop_seconds)))
        f1 = min(len(audio_to_score_frame), int(np.ceil((row["timeSeconds"] + window_seconds) / hop_seconds)) + 1)
        candidates = []
        for frame in range(f0, max(f0 + 1, f1)):
            score_idx = int(round(audio_to_score_frame[min(frame, len(audio_to_score_frame) - 1)]))
            score_idx = max(0, min(len(meta) - 1, score_idx))
            pred = meta[score_idx]
            m_err = int(pred["measure"]) - int(row["measure"])
            pos_hit = int(pred["measure"]) == int(row["measure"]) and position_matches(row["position"], pred["position"])
            candidates.append({
                "frame": frame,
                "time": round(frame * hop_seconds, 3),
                "predMeasure": int(pred["measure"]),
                "predPosition": str(pred["position"]),
                "measureError": m_err,
                "measureExact": m_err == 0,
                "measureWithin1": abs(m_err) <= 1,
                "positionHit": pos_hit,
                "_rank": (int(not pos_hit), int(m_err != 0), int(abs(m_err) > 1), abs(m_err)),
            })
        best = min(candidates, key=lambda item: item["_rank"])
        exact += int(best["measureExact"])
        within1 += int(best["measureWithin1"])
        position += int(best["positionHit"])
        rows.append({
            **row,
            "predMeasure": best["predMeasure"],
            "predPosition": best["predPosition"],
            "selectedFrameTime": best["time"],
            "measureError": best["measureError"],
            "measureExact": best["measureExact"],
            "measureWithin1": best["measureWithin1"],
            "positionHit": best["positionHit"],
        })
    n = max(1, len(gold))
    return {
        "pointCount": len(gold),
        "windowSeconds": window_seconds,
        "measureExactRate": round(exact / n, 3),
        "measureWithin1Rate": round(within1 / n, 3),
        "positionHitRate": round(position / n, 3),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--score-id", default="score-mofx8cdb-sbrqgx")
    parser.add_argument("--audio", default="data/real-tests/originals/xuan-dong-full.mp3")
    parser.add_argument("--gold", default="data/experiments/note-alignment/xuandong-m1-note-position-gold.csv")
    parser.add_argument("--hop-seconds", type=float, default=0.1)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    template, meta = load_score_template(args.score_id, args.hop_seconds)
    waveform, sr = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    target_sr = 22050
    if sr != target_sr:
        waveform = librosa.resample(waveform, orig_sr=sr, target_sr=target_sr)
        sr = target_sr
    hop_length = max(1, int(round(sr * args.hop_seconds)))
    audio_chroma = librosa.feature.chroma_cqt(y=waveform, sr=sr, hop_length=hop_length).astype(np.float32)
    n = min(template.shape[1], 20000)
    template = template[:, :n]
    meta = meta[:n]

    wp = sync_via_mrmsdtw(
        template,
        audio_chroma,
        input_feature_rate=int(round(1.0 / args.hop_seconds)),
        verbose=False,
        normalize_chroma=True,
    )
    audio_frames = np.arange(audio_chroma.shape[1], dtype=float)
    audio_to_score = np.interp(audio_frames, wp[1], wp[0], left=wp[0, 0], right=wp[0, -1])
    gold = load_gold(REPO_ROOT / args.gold)
    results = [eval_curve(audio_to_score, meta, gold, hop_seconds=args.hop_seconds, window_seconds=w) for w in (1.0, 2.0, 5.0)]

    print(f"[SyncToolbox MRMS-DTW | {args.score_id} | scoreFrames={template.shape[1]} audioFrames={audio_chroma.shape[1]}]")
    for result in results:
        print(
            f"  window={result['windowSeconds']:.0f}s "
            f"measureExact={result['measureExactRate']} "
            f"measure±1={result['measureWithin1Rate']} "
            f"positionHit={result['positionHitRate']}"
        )
    print("  per-point (5s window):")
    for row in results[-1]["rows"]:
        print(
            f"    {row['timeLabel']:>4} m{row['measure']:>3} {row['position']:<5} "
            f"-> m{row['predMeasure']:>3} {row['predPosition']:<6} "
            f"exact={row['measureExact']} pos={row['positionHit']}"
        )

    out = {"scoreId": args.score_id, "hopSeconds": args.hop_seconds, "results": results}
    out_dir = REPO_ROOT / "data" / "experiments" / "model-bakeoff"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else out_dir / f"synctoolbox-mrmsdtw-{args.score_id}.json"
    if not out_path.is_absolute():
        out_path = REPO_ROOT / out_path
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
