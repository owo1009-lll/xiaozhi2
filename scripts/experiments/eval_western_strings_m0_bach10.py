# -*- coding: utf-8 -*-
"""M0a western-strings migration probe on Bach10 violin/soprano stems.

Eval-only. Reads Bach10_v1.1 from data/experiments/western-strings-m0/raw,
uses only source/instrument id 1 (violin/soprano), and reports whether this
project's alignment-style baselines are good enough to justify continuing the
western-strings migration.

Bach10 .txt columns are:
  audio_time_ms  score_time_ms  midi_pitch  source_id

So score_time_ms is used as the symbolic score axis, audio_time_ms is used only
as the gold onset time for evaluation.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import librosa
import numpy as np
import soundfile as sf
from scipy.optimize import linear_sum_assignment


REPO = Path(__file__).resolve().parents[2]
DEFAULT_BACH10 = REPO / "data" / "experiments" / "western-strings-m0" / "raw" / "Bach10_v1.1"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m0" / "m0a-bach10"

VIOLIN_MIN_HZ = librosa.note_to_hz("G3")
VIOLIN_MAX_HZ = librosa.note_to_hz("A7")


@dataclass
class Note:
    piece: str
    idx: int
    score_time: float
    gold_time: float
    midi: int
    double_stop: bool = False
    legato: str = "unknown"


def finite_median(values: list[float]) -> float | None:
    values = [float(v) for v in values if math.isfinite(float(v))]
    if not values:
        return None
    return float(statistics.median(values))


def percentile(values: list[float], q: float) -> float | None:
    values = [float(v) for v in values if math.isfinite(float(v))]
    if not values:
        return None
    return float(np.percentile(np.asarray(values, dtype=np.float64), q))


def safe_rate(num: int, den: int) -> float | None:
    return None if den <= 0 else float(num) / float(den)


def discover_pieces(root: Path) -> list[Path]:
    return sorted(p for p in root.iterdir() if p.is_dir() and (p / f"{p.name}.txt").exists())


def load_violin_notes(piece_dir: Path) -> list[Note]:
    txt = piece_dir / f"{piece_dir.name}.txt"
    notes: list[Note] = []
    with txt.open(encoding="utf-8") as f:
        for raw in f:
            parts = raw.split()
            if len(parts) < 4:
                continue
            audio_ms, score_ms, midi, source = map(int, parts[:4])
            if source != 1:
                continue
            notes.append(
                Note(
                    piece=piece_dir.name,
                    idx=len(notes),
                    score_time=score_ms / 1000.0,
                    gold_time=audio_ms / 1000.0,
                    midi=midi,
                )
            )
    # Mark same-score-time multi-pitch notes. Bach10 soprano/violin is mostly monophonic,
    # but keep the report honest if the dataset contains any double-stops.
    by_score: dict[float, set[int]] = {}
    for note in notes:
        by_score.setdefault(round(note.score_time, 3), set()).add(note.midi)
    for note in notes:
        note.double_stop = len(by_score.get(round(note.score_time, 3), set())) >= 2
    return notes


def violin_audio_path(piece_dir: Path) -> Path:
    path = piece_dir / f"{piece_dir.name}-violin.wav"
    if not path.exists():
        raise FileNotFoundError(f"missing violin stem: {path}")
    return path


def score_template_frames(notes: list[Note], frame_times: np.ndarray) -> np.ndarray:
    """Step-function score MIDI template over score-time frame grid."""
    starts = np.asarray([n.score_time for n in notes], dtype=np.float64)
    pitches = np.asarray([n.midi for n in notes], dtype=np.float64)
    order = np.argsort(starts)
    starts = starts[order]
    pitches = pitches[order]
    idx = np.searchsorted(starts, frame_times, side="right") - 1
    idx = np.clip(idx, 0, len(pitches) - 1)
    return pitches[idx]


def predict_pyin_dtw(notes: list[Note], wav_path: Path) -> list[float | None]:
    """Continuous f0 DTW baseline, a lightweight proxy for CREPE-DTW."""
    y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    hop_length = 512
    f0, voiced, _ = librosa.pyin(
        y,
        fmin=VIOLIN_MIN_HZ,
        fmax=VIOLIN_MAX_HZ,
        sr=sr,
        hop_length=hop_length,
        frame_length=2048,
    )
    audio_times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop_length)
    valid = np.isfinite(f0) & voiced
    if int(valid.sum()) < 8:
        return [None for _ in notes]
    audio_midi = np.full_like(f0, np.nan, dtype=np.float64)
    audio_midi[valid] = librosa.hz_to_midi(f0[valid])

    score_duration = max(n.score_time for n in notes) + 0.25
    score_times = np.arange(0.0, score_duration, hop_length / sr)
    score_midi = score_template_frames(notes, score_times)

    # Cost: pitch distance, with a moderate penalty for unvoiced frames.
    C = np.abs(score_midi[:, None] - np.nan_to_num(audio_midi[None, :], nan=-99.0))
    C[:, ~valid] = 18.0
    C = C.astype(np.float32)
    _, wp = librosa.sequence.dtw(C=C, backtrack=True, subseq=False)
    # librosa returns path from end to start; sort by score frame.
    pairs = sorted((int(i), int(j)) for i, j in wp)
    by_score: dict[int, list[int]] = {}
    for i, j in pairs:
        by_score.setdefault(i, []).append(j)

    preds: list[float | None] = []
    for note in notes:
        sidx = int(np.argmin(np.abs(score_times - note.score_time)))
        # Find nearest score frame present in the path.
        if sidx not in by_score:
            nearest = min(by_score, key=lambda k: abs(k - sidx))
        else:
            nearest = sidx
        js = by_score.get(nearest, [])
        if not js:
            preds.append(None)
            continue
        preds.append(float(np.median(audio_times[js])))
    return preds


def predict_crepe_dtw(notes: list[Note], wav_path: Path) -> list[float | None]:
    """CREPE f0 DTW baseline using torchcrepe.

    This is the stricter version of the f0-DTW baseline named in the M0 plan.
    It keeps the same downstream DTW/evaluation path as pYIN so the difference
    is the pitch tracker, not the alignment scorer.
    """
    try:
        import torch
        import torchcrepe
    except Exception as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(f"torchcrepe unavailable: {exc}") from exc

    sr = 16000
    hop_length = 160  # 10ms at 16kHz
    y, _ = librosa.load(str(wav_path), sr=sr, mono=True)
    if len(y) < sr // 2:
        return [None for _ in notes]
    audio = torch.tensor(y, dtype=torch.float32).unsqueeze(0)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    audio = audio.to(device)
    with torch.no_grad():
        f0, periodicity = torchcrepe.predict(
            audio,
            sr,
            hop_length,
            float(VIOLIN_MIN_HZ),
            float(VIOLIN_MAX_HZ),
            model="full",
            batch_size=2048,
            device=device,
            return_periodicity=True,
        )
    f0_np = f0.squeeze(0).detach().cpu().numpy().astype(np.float64)
    periodicity_np = periodicity.squeeze(0).detach().cpu().numpy().astype(np.float64)
    audio_times = librosa.frames_to_time(np.arange(len(f0_np)), sr=sr, hop_length=hop_length)
    valid = np.isfinite(f0_np) & (f0_np > 0.0) & (periodicity_np >= 0.1)
    if int(valid.sum()) < 8:
        return [None for _ in notes]
    audio_midi = np.full_like(f0_np, np.nan, dtype=np.float64)
    audio_midi[valid] = librosa.hz_to_midi(f0_np[valid])

    score_duration = max(n.score_time for n in notes) + 0.25
    score_times = np.arange(0.0, score_duration, hop_length / sr)
    score_midi = score_template_frames(notes, score_times)

    C = np.abs(score_midi[:, None] - np.nan_to_num(audio_midi[None, :], nan=-99.0))
    C[:, ~valid] = 18.0
    C = C.astype(np.float32)
    _, wp = librosa.sequence.dtw(C=C, backtrack=True, subseq=False)
    pairs = sorted((int(i), int(j)) for i, j in wp)
    by_score: dict[int, list[int]] = {}
    for i, j in pairs:
        by_score.setdefault(i, []).append(j)

    preds: list[float | None] = []
    for note in notes:
        sidx = int(np.argmin(np.abs(score_times - note.score_time)))
        nearest = sidx if sidx in by_score else min(by_score, key=lambda k: abs(k - sidx))
        js = by_score.get(nearest, [])
        preds.append(None if not js else float(np.median(audio_times[js])))
    return preds


def basic_pitch_events(wav_path: Path, cache_dir: Path) -> list[dict]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / f"{wav_path.stem}.basic-pitch.json"
    if cache.exists():
        events = json.loads(cache.read_text(encoding="utf-8"))
        return sorted(events, key=lambda e: (float(e["start"]), float(e["end"]), int(e["midi"])))
    try:
        from basic_pitch.inference import predict
    except Exception as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(f"basic_pitch unavailable: {exc}") from exc

    _, _, note_events = predict(
        wav_path,
        minimum_frequency=VIOLIN_MIN_HZ,
        maximum_frequency=VIOLIN_MAX_HZ,
        minimum_note_length=80.0,
    )
    events = [
        {
            "start": float(start),
            "end": float(end),
            "midi": int(pitch),
            "confidence": float(confidence),
        }
        for start, end, pitch, confidence, *_ in note_events
    ]
    events = sorted(events, key=lambda e: (float(e["start"]), float(e["end"]), int(e["midi"])))
    cache.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    return events


def predict_basic_pitch_assignment(notes: list[Note], events: list[dict]) -> list[float | None]:
    """Order-preserving-ish event assignment via monotonic DTW over pitch events."""
    if not events:
        return [None for _ in notes]
    score_pitch = np.asarray([n.midi for n in notes], dtype=np.float32)
    perf_pitch = np.asarray([e["midi"] for e in events], dtype=np.float32)
    C = np.abs(score_pitch[:, None] - perf_pitch[None, :]).astype(np.float32)
    _, wp = librosa.sequence.dtw(C=C, backtrack=True, subseq=False)
    pairs = sorted((int(i), int(j)) for i, j in wp)
    by_note: dict[int, list[int]] = {}
    for i, j in pairs:
        by_note.setdefault(i, []).append(j)
    preds: list[float | None] = []
    for i in range(len(notes)):
        js = by_note.get(i, [])
        if not js:
            preds.append(None)
            continue
        # If DTW maps multiple performance events to a note, choose the closest pitch,
        # then highest confidence, then earliest event.
        j = min(
            js,
            key=lambda k: (
                abs(float(events[k]["midi"]) - float(notes[i].midi)),
                -float(events[k].get("confidence", 0.0)),
                float(events[k]["start"]),
            ),
        )
        preds.append(float(events[j]["start"]))
    return preds


def _score_array_for_parangonar(notes: list[Note]) -> np.ndarray:
    dtype = [
        ("id", "U32"),
        ("pitch", "i4"),
        ("onset_beat", "f4"),
        ("duration_beat", "f4"),
        ("onset_quarter", "f4"),
        ("duration_quarter", "f4"),
        ("is_grace", "bool"),
    ]
    arr = np.zeros(len(notes), dtype=dtype)
    for i, note in enumerate(notes):
        if i + 1 < len(notes):
            dur = max(0.05, float(notes[i + 1].score_time - note.score_time))
        elif i > 0:
            dur = max(0.05, float(note.score_time - notes[i - 1].score_time))
        else:
            dur = 0.5
        arr[i]["id"] = f"s{i}"
        arr[i]["pitch"] = int(note.midi)
        # Bach10 score_time is an arbitrary score-side axis; Parangonar only needs
        # it to preserve symbolic order and relative spacing.
        arr[i]["onset_beat"] = float(note.score_time)
        arr[i]["duration_beat"] = float(dur)
        arr[i]["onset_quarter"] = float(note.score_time)
        arr[i]["duration_quarter"] = float(dur)
        arr[i]["is_grace"] = False
    return arr


def _performance_array_for_parangonar(events: list[dict]) -> np.ndarray:
    dtype = [
        ("id", "U32"),
        ("pitch", "i4"),
        ("onset_sec", "f4"),
        ("duration_sec", "f4"),
        ("velocity", "i4"),
    ]
    arr = np.zeros(len(events), dtype=dtype)
    for i, event in enumerate(events):
        conf = float(event.get("confidence", 0.75))
        arr[i]["id"] = f"p{i}"
        arr[i]["pitch"] = int(event["midi"])
        arr[i]["onset_sec"] = float(event["start"])
        arr[i]["duration_sec"] = max(0.02, float(event["end"]) - float(event["start"]))
        arr[i]["velocity"] = int(max(1, min(127, round(conf * 127.0))))
    return arr


def predict_parangonar_basic_pitch(notes: list[Note], events: list[dict]) -> list[float | None]:
    """Parangonar AutomaticNoteMatcher over Basic Pitch note events."""
    if not events:
        return [None for _ in notes]
    try:
        from parangonar.match import AutomaticNoteMatcher
    except Exception as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(f"parangonar unavailable: {exc}") from exc

    matcher = AutomaticNoteMatcher()
    alignments = matcher(_score_array_for_parangonar(notes), _performance_array_for_parangonar(events))
    perf_by_id = {f"p{i}": event for i, event in enumerate(events)}
    score_to_perf: dict[int, list[dict]] = {}
    for item in alignments:
        if item.get("label") != "match":
            continue
        sid = str(item.get("score_id", ""))
        pid = str(item.get("performance_id", ""))
        if not sid.startswith("s") or pid not in perf_by_id:
            continue
        try:
            score_idx = int(sid[1:])
        except ValueError:
            continue
        if 0 <= score_idx < len(notes):
            score_to_perf.setdefault(score_idx, []).append(perf_by_id[pid])

    preds: list[float | None] = []
    for i, note in enumerate(notes):
        candidates = score_to_perf.get(i, [])
        if not candidates:
            preds.append(None)
            continue
        event = min(
            candidates,
            key=lambda e: (
                abs(float(e["midi"]) - float(note.midi)),
                -float(e.get("confidence", 0.0)),
                float(e["start"]),
            ),
        )
        preds.append(float(event["start"]))
    return preds


def predict_linear_scoretime(notes: list[Note]) -> list[float | None]:
    if len(notes) < 2:
        return [None for _ in notes]
    s0, s1 = notes[0].score_time, notes[-1].score_time
    a0, a1 = notes[0].gold_time, notes[-1].gold_time
    if abs(s1 - s0) < 1e-6:
        return [None for _ in notes]
    return [a0 + (n.score_time - s0) * (a1 - a0) / (s1 - s0) for n in notes]


def evaluate_predictions(notes: list[Note], preds: list[float | None], method: str) -> tuple[dict, list[dict]]:
    rows: list[dict] = []
    errors: list[float] = []
    missing = 0
    for note, pred in zip(notes, preds):
        err = None if pred is None else abs(float(pred) - note.gold_time)
        if err is None:
            missing += 1
        else:
            errors.append(err)
        rows.append(
            {
                "piece": note.piece,
                "noteIndex": note.idx,
                "method": method,
                "scoreTime": round(note.score_time, 6),
                "goldTime": round(note.gold_time, 6),
                "predTime": "" if pred is None else round(float(pred), 6),
                "absError": "" if err is None else round(float(err), 6),
                "midi": note.midi,
                "doubleStop": note.double_stop,
                "legato": note.legato,
            }
        )
    n = len(notes)
    valid = len(errors)
    summary = {
        "method": method,
        "goldNotes": n,
        "validPredictions": valid,
        "missingPredictions": missing,
        "coverage": safe_rate(valid, n),
        "medianOnsetError": finite_median(errors),
        "p90OnsetError": percentile(errors, 90),
        "hitAt100ms": safe_rate(sum(e <= 0.1 for e in errors), n),
        "hitAt300ms": safe_rate(sum(e <= 0.3 for e in errors), n),
        "doubleStopNotes": sum(1 for n0 in notes if n0.double_stop),
        "legatoKnownNotes": sum(1 for n0 in notes if n0.legato != "unknown"),
    }
    return summary, rows


def grade(summary: dict) -> str:
    med = summary.get("medianOnsetError")
    hit300 = summary.get("hitAt300ms")
    cov = summary.get("coverage")
    if med is None or hit300 is None or cov is None:
        return "red"
    if med < 0.150 and hit300 >= 0.85 and cov >= 0.80:
        return "green"
    if med > 0.300 or hit300 < 0.70 or cov < 0.60:
        return "red"
    return "yellow"


def write_csv(path: Path, rows: Iterable[dict]) -> None:
    rows = list(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bach10-root", default=str(DEFAULT_BACH10))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT))
    parser.add_argument("--max-pieces", type=int, default=0, help="0 = all")
    parser.add_argument(
        "--methods",
        default="linear-scoretime,crepe-dtw,pyin-dtw,basic-pitch-dtw,parangonar-basic-pitch",
        help="comma-separated: linear-scoretime,crepe-dtw,pyin-dtw,basic-pitch-dtw,parangonar-basic-pitch",
    )
    args = parser.parse_args()

    bach10_root = Path(args.bach10_root)
    out_dir = Path(args.out_dir)
    methods = [m.strip() for m in args.methods.split(",") if m.strip()]
    pieces = discover_pieces(bach10_root)
    if args.max_pieces:
        pieces = pieces[: args.max_pieces]
    if not pieces:
        raise SystemExit(f"no Bach10 pieces found at {bach10_root}")

    all_rows: list[dict] = []
    all_summaries: list[dict] = []
    sanity_rows: list[dict] = []

    for piece_dir in pieces:
        notes = load_violin_notes(piece_dir)
        wav = violin_audio_path(piece_dir)
        info = sf.info(str(wav))
        sanity_rows.append(
            {
                "piece": piece_dir.name,
                "audioPath": str(wav.relative_to(REPO)),
                "audioDuration": round(float(info.duration), 6),
                "samplerate": int(info.samplerate),
                "channels": int(info.channels),
                "violinGoldNotes": len(notes),
                "doubleStopNotes": sum(1 for n in notes if n.double_stop),
                "legatoKnownNotes": sum(1 for n in notes if n.legato != "unknown"),
                "minScoreTime": min(n.score_time for n in notes) if notes else None,
                "maxScoreTime": max(n.score_time for n in notes) if notes else None,
                "minGoldTime": min(n.gold_time for n in notes) if notes else None,
                "maxGoldTime": max(n.gold_time for n in notes) if notes else None,
            }
        )

        method_predictions: dict[str, list[float | None]] = {}
        if "linear-scoretime" in methods:
            method_predictions["linear-scoretime"] = predict_linear_scoretime(notes)
        if "crepe-dtw" in methods:
            method_predictions["crepe-dtw"] = predict_crepe_dtw(notes, wav)
        if "pyin-dtw" in methods:
            method_predictions["pyin-dtw"] = predict_pyin_dtw(notes, wav)
        if "basic-pitch-dtw" in methods:
            events = basic_pitch_events(wav, out_dir / "cache" / "basic-pitch")
            method_predictions["basic-pitch-dtw"] = predict_basic_pitch_assignment(notes, events)
        if "parangonar-basic-pitch" in methods:
            events = basic_pitch_events(wav, out_dir / "cache" / "basic-pitch")
            method_predictions["parangonar-basic-pitch"] = predict_parangonar_basic_pitch(notes, events)

        for method, preds in method_predictions.items():
            summary, rows = evaluate_predictions(notes, preds, method)
            summary["piece"] = piece_dir.name
            summary["grade"] = grade(summary)
            all_summaries.append(summary)
            all_rows.extend(rows)

    # Aggregate per method across all pieces.
    aggregate: list[dict] = []
    for method in sorted({row["method"] for row in all_rows}):
        method_notes = [
            Note(
                piece=str(row["piece"]),
                idx=int(row["noteIndex"]),
                score_time=float(row["scoreTime"]),
                gold_time=float(row["goldTime"]),
                midi=int(row["midi"]),
                double_stop=str(row["doubleStop"]).lower() == "true",
                legato=str(row["legato"]),
            )
            for row in all_rows
            if row["method"] == method
        ]
        preds = [
            None if row["predTime"] == "" else float(row["predTime"])
            for row in all_rows
            if row["method"] == method
        ]
        summary, _ = evaluate_predictions(method_notes, preds, method)
        summary["piece"] = "__aggregate__"
        summary["grade"] = grade(summary)
        aggregate.append(summary)

    decision_candidates = [s for s in aggregate if s["method"] != "linear-scoretime"]
    if not decision_candidates:
        decision_candidates = aggregate
    best = sorted(
        decision_candidates,
        key=lambda s: (
            {"green": 0, "yellow": 1, "red": 2}.get(str(s["grade"]), 9),
            999.0 if s.get("medianOnsetError") is None else float(s["medianOnsetError"]),
        ),
    )[0]

    result = {
        "dataset": "Bach10_v1.1",
        "source": "https://github.com/flippy-fyp/Bach10_v1.1",
        "pieceCount": len(pieces),
        "instrument": "violin/soprano source_id=1",
        "thresholds": {
            "green": {"medianOnsetError": "<0.150s", "hitAt300ms": ">=0.85", "coverage": ">=0.80"},
            "red": {"medianOnsetError": ">0.300s", "hitAt300ms": "<0.70", "coverage": "<0.60"},
        },
        "aggregate": aggregate,
        "decisionCandidateMethods": [s["method"] for s in decision_candidates],
        "perPiece": all_summaries,
        "bestAggregate": best,
        "m0aDecision": "GO_TO_M0B" if best["grade"] == "green" else ("STOP_RED" if best["grade"] == "red" else "YELLOW_REVIEW"),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "m0a-bach10-summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(out_dir / "m0a-bach10-per-note.csv", all_rows)
    write_csv(out_dir / "m0a-bach10-per-piece.csv", all_summaries)
    write_csv(out_dir / "m0a-bach10-sanity.csv", sanity_rows)

    print("[M0a Bach10 violin/soprano]")
    print(f"  pieces={len(pieces)} notes={sum(int(r['violinGoldNotes']) for r in sanity_rows)}")
    for s in aggregate:
        med = None if s["medianOnsetError"] is None else round(float(s["medianOnsetError"]), 4)
        p90 = None if s["p90OnsetError"] is None else round(float(s["p90OnsetError"]), 4)
        print(
            f"  {s['method']}: grade={s['grade']} coverage={s['coverage']:.3f} "
            f"median={med}s p90={p90}s hit100={s['hitAt100ms']:.3f} hit300={s['hitAt300ms']:.3f}"
        )
    print(f"  decision={result['m0aDecision']} best={best['method']}")
    print(f"  wrote {out_dir}")


if __name__ == "__main__":
    main()
