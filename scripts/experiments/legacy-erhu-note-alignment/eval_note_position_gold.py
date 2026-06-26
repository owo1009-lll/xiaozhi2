# -*- coding: utf-8 -*-
"""Evaluate measure + coarse in-measure position against human gold points.

The gold file is second-level: audio time -> score measure -> coarse position
inside that measure (start/middle/end). This script evaluates whether existing
alignment curves can hit those coarse note positions without requiring sub-second
manual timestamps.

Eval-only: writes under data/experiments/note-alignment and does not touch
production paths.
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import anchor_eval  # noqa: E402
import eval_m1_finetruth as m1  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "gdtw",
    str(Path(__file__).resolve().parent / "align-global-dtw-experiment.py"),
)
gdtw = importlib.util.module_from_spec(_spec)
sys.modules["gdtw_note_position"] = gdtw
_spec.loader.exec_module(gdtw)


def load_score_columns(score_id: str):
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
                "beatDuration": float(note.get("beatDuration", 1.0)),
                "tempo": tempo,
            })
    notes.sort(key=lambda item: item["sort"])

    by_measure: dict[int, list[dict]] = defaultdict(list)
    for note in notes:
        by_measure[note["measure"]].append(note)
    for measure_notes in by_measure.values():
        for idx, note in enumerate(measure_notes):
            note["ordinal"] = idx
            note["countInMeasure"] = len(measure_notes)
            if len(measure_notes) == 1:
                note["coarsePosition"] = "single"
            elif idx == 0:
                note["coarsePosition"] = "start"
            elif idx == len(measure_notes) - 1:
                note["coarsePosition"] = "end"
            else:
                note["coarsePosition"] = "middle"

    cols, meta = [], []
    hop_seconds = gdtw.HOP_SECONDS
    for note in notes:
        col = np.zeros(12, dtype=np.float32)
        col[note["midi"] % 12] = 1.0
        spb = 60.0 / float(note["tempo"])
        nframes = max(1, int(round((float(note["beatDuration"]) * spb) / hop_seconds)))
        for _ in range(nframes):
            cols.append(col)
            meta.append({
                "measure": note["measure"],
                "page": note["page"],
                "ordinal": note["ordinal"],
                "countInMeasure": note["countInMeasure"],
                "position": note["coarsePosition"],
            })
    if not cols:
        raise SystemExit(f"no erhu columns for score: {score_id}")
    return np.stack(cols, axis=1), meta


def cols_for_pages(meta: list[dict], p_lo: int, p_hi: int):
    idx = [i for i, item in enumerate(meta) if p_lo <= int(item["page"]) <= p_hi]
    return (idx[0], idx[-1] + 1) if idx else None


def align_blocks(template: np.ndarray, meta: list[dict], feat: np.ndarray, blocks: list[tuple[int, int, int, int]]):
    n_audio = feat.shape[1]
    pred_idx = np.full(n_audio, -1, dtype=np.int32)
    for f0, f1, c0, c1 in blocks:
        f0 = max(0, int(f0))
        f1 = min(n_audio, int(f1))
        if f1 - f0 < 2 or c1 - c0 < 2:
            continue
        _acc, wp = librosa.sequence.dtw(X=template[:, c0:c1], Y=feat[:, f0:f1], subseq=False, metric="cosine")
        lists = [[] for _ in range(f1 - f0)]
        for s_idx, a_idx in wp:
            if 0 <= a_idx < (f1 - f0):
                lists[a_idx].append(c0 + int(s_idx))
        for a_local, values in enumerate(lists):
            if values:
                pred_idx[f0 + a_local] = int(np.median(values))
    last = -1
    for i in range(n_audio):
        if pred_idx[i] < 0:
            pred_idx[i] = last
        else:
            last = pred_idx[i]
    return pred_idx


def load_gold(path: Path):
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            rows.append({
                "piece": row.get("piece", ""),
                "scoreId": row.get("scoreId", ""),
                "timeLabel": row.get("timeLabel", ""),
                "timeSeconds": float(row["timeSeconds"]),
                "measure": int(row["measure"]),
                "positionInMeasure": str(row.get("positionInMeasure", "")).strip(),
                "confidence": str(row.get("confidence", "")).strip(),
                "notes": row.get("notes", ""),
            })
    return rows


def position_matches(expected: str, predicted: str) -> bool:
    if expected == predicted:
        return True
    if predicted == "single" and expected in {"start", "end", "middle"}:
        return True
    return False


def pick_best_in_window(
    pred_idx: np.ndarray,
    meta: list[dict],
    audio_hop: float,
    truth_time: float,
    window_seconds: float,
    gold_measure: int,
    gold_position: str,
):
    f0 = max(0, int(np.floor(truth_time / audio_hop)))
    f1 = min(len(pred_idx), int(np.ceil((truth_time + window_seconds) / audio_hop)) + 1)
    candidates = []
    for frame in range(f0, max(f0 + 1, f1)):
        idx = int(pred_idx[min(frame, len(pred_idx) - 1)])
        pred = meta[idx] if 0 <= idx < len(meta) else None
        pred_measure = int(pred["measure"]) if pred else None
        pred_position = str(pred["position"]) if pred else ""
        exact = pred_measure == gold_measure
        within1 = pred_measure is not None and abs(pred_measure - gold_measure) <= 1
        pos_ok = exact and position_matches(gold_position, pred_position)
        measure_error_abs = 999999 if pred_measure is None else abs(pred_measure - gold_measure)
        candidates.append({
            "frame": frame,
            "time": round(frame * audio_hop, 3),
            "predMeasure": pred_measure,
            "predPosition": pred_position,
            "measureExact": exact,
            "measureWithin1": within1,
            "positionHit": pos_ok,
            "measureError": None if pred_measure is None else pred_measure - gold_measure,
            "_rank": (int(not pos_ok), int(not exact), int(not within1), measure_error_abs),
        })
    return min(candidates, key=lambda item: item["_rank"])


def eval_prediction(name: str, pred_idx: np.ndarray, meta: list[dict], audio_hop: float, gold: list[dict], *, window_seconds: float):
    rows = []
    measure_exact = measure_within1 = position_hit = joint_hit = 0
    for row in gold:
        best = pick_best_in_window(
            pred_idx,
            meta,
            audio_hop,
            float(row["timeSeconds"]),
            window_seconds,
            int(row["measure"]),
            row["positionInMeasure"],
        )
        pred_measure = best["predMeasure"]
        pred_position = best["predPosition"]
        exact = bool(best["measureExact"])
        within1 = bool(best["measureWithin1"])
        pos_ok = bool(best["positionHit"])
        measure_exact += int(exact)
        measure_within1 += int(within1)
        position_hit += int(pos_ok)
        joint_hit += int(pos_ok)
        rows.append({
            "timeLabel": row["timeLabel"],
            "timeSeconds": row["timeSeconds"],
            "goldMeasure": row["measure"],
            "goldPosition": row["positionInMeasure"],
            "evalWindowSeconds": window_seconds,
            "selectedFrameTime": best["time"],
            "predMeasure": pred_measure,
            "predPosition": pred_position,
            "measureExact": exact,
            "measureWithin1": within1,
            "positionHit": pos_ok,
            "measureError": best["measureError"],
        })
    n = max(1, len(gold))
    return {
        "name": name,
        "pointCount": len(gold),
        "measureExactRate": round(measure_exact / n, 3),
        "measureWithin1Rate": round(measure_within1 / n, 3),
        "positionHitRate": round(position_hit / n, 3),
        "jointHitRate": round(joint_hit / n, 3),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gold", default="data/experiments/note-alignment/xuandong-m1-note-position-gold.csv")
    parser.add_argument("--score-id", default="score-mofx8cdb-sbrqgx")
    parser.add_argument("--audio", default="data/real-tests/originals/xuan-dong-full.mp3")
    parser.add_argument("--manifest", default="data/teacher-manual-anchors/manifest-xuandong.csv")
    parser.add_argument("--feature", default="crepe", choices=["crepe", "chroma", "cens", "hpss"])
    parser.add_argument("--crepe-fmax", type=float, default=1400.0)
    parser.add_argument("--gold-window-seconds", type=float, default=1.0)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    gold_path = (REPO_ROOT / args.gold).resolve()
    gold = load_gold(gold_path)
    template, meta = load_score_columns(args.score_id)

    waveform, sr = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sr != gdtw.SR:
        waveform = librosa.resample(waveform, orig_sr=sr, target_sr=gdtw.SR)
    feat, audio_hop = gdtw.audio_feature(waveform, args.feature, crepe_fmax=args.crepe_fmax)

    baseline = align_blocks(template, meta, feat, [(0, feat.shape[1], 0, template.shape[1])])

    anchor_blocks = []
    for anchor in anchor_eval.load_anchors(REPO_ROOT / args.manifest):
        cr = cols_for_pages(meta, int(anchor["pageLo"]), int(anchor["pageHi"]))
        if cr:
            anchor_blocks.append((int(anchor["start"] / audio_hop), int(anchor["end"] / audio_hop), cr[0], cr[1]))
    anchored = align_blocks(template, meta, feat, anchor_blocks)

    results = [
        eval_prediction("baseline-global", baseline, meta, audio_hop, gold, window_seconds=args.gold_window_seconds),
        eval_prediction("manual-anchor-local", anchored, meta, audio_hop, gold, window_seconds=args.gold_window_seconds),
    ]

    print(f"[note-position gold | {args.score_id} | points={len(gold)} | feature={args.feature}/fmax={args.crepe_fmax}]")
    for result in results:
        print(
            f"  {result['name']:<20} measureExact={result['measureExactRate']} "
            f"measure±1={result['measureWithin1Rate']} positionHit={result['positionHitRate']}"
        )
    print("  per-point manual-anchor-local:")
    for row in results[1]["rows"]:
        print(
            f"    {row['timeLabel']:>4} m{row['goldMeasure']:>3} {row['goldPosition']:<5} "
            f"-> m{str(row['predMeasure']):>3} {row['predPosition']:<6} "
            f"exact={row['measureExact']} pos={row['positionHit']}"
        )

    out = {
        "scoreId": args.score_id,
        "gold": str(gold_path),
        "feature": args.feature,
        "crepeFmax": args.crepe_fmax,
        "goldWindowSeconds": args.gold_window_seconds,
        "results": results,
    }
    out_dir = REPO_ROOT / "data" / "experiments" / "note-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else out_dir / f"note-position-eval-{args.score_id}-{args.feature}.json"
    if not out_path.is_absolute():
        out_path = REPO_ROOT / out_path
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
