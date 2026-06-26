# -*- coding: utf-8 -*-
"""M0c western-strings migration probe on small MusicNet string samples.

Eval-only. This is a scale/noise stress test, not a replacement for M0b:
MusicNet labels are score-aligned and musician-verified but are reported by
the dataset authors to have residual annotation noise, and many recordings are
mixes. The two default fixtures are single-instrument Bach movements to keep
the smoke test focused:

  2191: Bach solo violin
  2298: Bach solo cello

MusicNet CSV columns include sample-index audio times at 44100 Hz and MIDI
note numbers. Reference MIDI files come from the official MusicNet MIDI archive.
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import librosa
import pandas as pd
import pretty_midi
import soundfile as sf

import eval_western_strings_m0_bach10 as bach10


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MUSICNET = REPO / "data" / "experiments" / "western-strings-m0" / "raw" / "MusicNet-HF"
DEFAULT_MIDI_ROOT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m0"
    / "raw"
    / "MusicNet-Zenodo"
    / "midis"
    / "musicnet_midis"
)
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m0" / "m0c-musicnet"
MUSICNET_SR = 44100.0

SAMPLES = [
    {
        "id": "2191",
        "split": "test",
        "instrument": "violin",
        "ensemble": "Solo Violin",
        "midi": "Bach/2191_vs6_5.mid",
        "audio": "2191.wav",
        "labels": "2191.csv",
        "minHz": librosa.note_to_hz("G3"),
        "maxHz": librosa.note_to_hz("A7"),
    },
    {
        "id": "2298",
        "split": "test",
        "instrument": "cello",
        "ensemble": "Solo Cello",
        "midi": "Bach/2298_cs4-6gig.mid",
        "audio": "2298.wav",
        "labels": "2298.csv",
        "minHz": librosa.note_to_hz("C2"),
        "maxHz": librosa.note_to_hz("A5"),
    },
]


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def load_musicnet_sample(data_root: Path, midi_root: Path, spec: dict) -> tuple[list[bach10.Note], Path, list[dict]]:
    audio_path = data_root / spec["audio"]
    label_path = data_root / spec["labels"]
    midi_path = midi_root / spec["midi"]
    for path in [audio_path, label_path, midi_path]:
        if not path.exists():
            raise FileNotFoundError(path)

    pm = pretty_midi.PrettyMIDI(str(midi_path))
    midi_notes = []
    for instrument in pm.instruments:
        if not instrument.is_drum:
            midi_notes.extend(instrument.notes)
    midi_notes = sorted(midi_notes, key=lambda n: (float(n.start), int(n.pitch), float(n.end)))

    df = pd.read_csv(label_path).sort_values(["start_time", "note", "end_time"]).reset_index(drop=True)
    if len(midi_notes) != len(df):
        raise ValueError(f"MusicNet {spec['id']} MIDI/label note count mismatch: {len(midi_notes)} vs {len(df)}")
    mismatches = [
        (i, int(midi_notes[i].pitch), int(row.note))
        for i, row in df.iterrows()
        if int(midi_notes[i].pitch) != int(row.note)
    ]
    if mismatches:
        raise ValueError(f"MusicNet {spec['id']} pitch mismatches: {mismatches[:10]}")

    by_score_time: dict[float, set[int]] = {}
    for note in midi_notes:
        by_score_time.setdefault(round(float(note.start), 3), set()).add(int(note.pitch))

    notes: list[bach10.Note] = []
    for idx, (midi_note, row) in enumerate(zip(midi_notes, df.itertuples(index=False))):
        score_time = float(midi_note.start)
        notes.append(
            bach10.Note(
                piece=f"MusicNet-{spec['id']}:{spec['instrument']}",
                idx=idx,
                score_time=score_time,
                gold_time=float(row.start_time) / MUSICNET_SR,
                midi=int(midi_note.pitch),
                double_stop=len(by_score_time.get(round(score_time, 3), set())) >= 2,
                legato="unknown",
            )
        )

    sanity = [
        {
            "id": spec["id"],
            "instrument": spec["instrument"],
            "ensemble": spec["ensemble"],
            "audioPath": str(audio_path.relative_to(REPO)),
            "midiPath": str(midi_path.relative_to(REPO)),
            "labelsPath": str(label_path.relative_to(REPO)),
            "goldNotes": len(notes),
            "doubleStopNotes": sum(1 for n in notes if n.double_stop),
            "audioDuration": float(sf.info(str(audio_path)).duration),
            "minScoreTime": min(n.score_time for n in notes),
            "maxScoreTime": max(n.score_time for n in notes),
            "minGoldTime": min(n.gold_time for n in notes),
            "maxGoldTime": max(n.gold_time for n in notes),
        }
    ]
    return notes, audio_path, sanity


def with_pitch_range(spec: dict, fn):
    old_min = bach10.VIOLIN_MIN_HZ
    old_max = bach10.VIOLIN_MAX_HZ
    bach10.VIOLIN_MIN_HZ = float(spec["minHz"])
    bach10.VIOLIN_MAX_HZ = float(spec["maxHz"])
    try:
        return fn()
    finally:
        bach10.VIOLIN_MIN_HZ = old_min
        bach10.VIOLIN_MAX_HZ = old_max


def aggregate(rows: list[dict], method: str) -> dict:
    notes = []
    preds = []
    for row in rows:
        if row["method"] != method:
            continue
        notes.append(
            bach10.Note(
                piece=str(row["piece"]),
                idx=int(row["noteIndex"]),
                score_time=float(row["scoreTime"]),
                gold_time=float(row["goldTime"]),
                midi=int(row["midi"]),
                double_stop=str(row["doubleStop"]).lower() == "true",
                legato=str(row["legato"]),
            )
        )
        preds.append(None if row["predTime"] == "" else float(row["predTime"]))
    summary, _ = bach10.evaluate_predictions(notes, preds, method)
    summary["piece"] = "__aggregate__"
    summary["grade"] = bach10.grade(summary)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--musicnet-root", default=str(DEFAULT_MUSICNET))
    parser.add_argument("--musicnet-midi-root", default=str(DEFAULT_MIDI_ROOT))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT))
    parser.add_argument(
        "--methods",
        default="linear-scoretime,crepe-dtw,pyin-dtw,basic-pitch-dtw,parangonar-basic-pitch",
        help="comma-separated: linear-scoretime,crepe-dtw,pyin-dtw,basic-pitch-dtw,parangonar-basic-pitch",
    )
    args = parser.parse_args()

    data_root = Path(args.musicnet_root)
    midi_root = Path(args.musicnet_midi_root)
    out_dir = Path(args.out_dir)
    methods = [m.strip() for m in args.methods.split(",") if m.strip()]

    all_rows: list[dict] = []
    per_sample: list[dict] = []
    sanity_rows: list[dict] = []

    for spec in SAMPLES:
        notes, audio_path, sanity = load_musicnet_sample(data_root, midi_root, spec)
        sanity_rows.extend(sanity)
        predictions: dict[str, list[float | None]] = {}

        if "linear-scoretime" in methods:
            predictions["linear-scoretime"] = bach10.predict_linear_scoretime(notes)
        if "crepe-dtw" in methods:
            predictions["crepe-dtw"] = with_pitch_range(spec, lambda: bach10.predict_crepe_dtw(notes, audio_path))
        if "pyin-dtw" in methods:
            predictions["pyin-dtw"] = with_pitch_range(spec, lambda: bach10.predict_pyin_dtw(notes, audio_path))

        events = None
        if "basic-pitch-dtw" in methods or "parangonar-basic-pitch" in methods:
            events = with_pitch_range(
                spec, lambda: bach10.basic_pitch_events(audio_path, out_dir / "cache" / "basic-pitch")
            )
        if "basic-pitch-dtw" in methods:
            predictions["basic-pitch-dtw"] = bach10.predict_basic_pitch_assignment(notes, events or [])
        if "parangonar-basic-pitch" in methods:
            predictions["parangonar-basic-pitch"] = bach10.predict_parangonar_basic_pitch(notes, events or [])

        for method, preds in predictions.items():
            summary, rows = bach10.evaluate_predictions(notes, preds, method)
            summary["id"] = spec["id"]
            summary["instrument"] = spec["instrument"]
            summary["ensemble"] = spec["ensemble"]
            summary["grade"] = bach10.grade(summary)
            per_sample.append(summary)
            all_rows.extend(rows)

    aggregate_rows = [aggregate(all_rows, method) for method in sorted({row["method"] for row in all_rows})]
    decision_candidates = [s for s in aggregate_rows if s["method"] != "linear-scoretime"]
    if not decision_candidates:
        decision_candidates = aggregate_rows
    best = sorted(
        decision_candidates,
        key=lambda s: (
            {"green": 0, "yellow": 1, "red": 2}.get(str(s["grade"]), 9),
            999.0 if s.get("medianOnsetError") is None else float(s["medianOnsetError"]),
        ),
    )[0]

    result = {
        "dataset": "MusicNet DreamyWanderer/HuggingFace two-sample string smoke",
        "source": "https://huggingface.co/datasets/DreamyWanderer/MusicNet",
        "officialSource": "https://zenodo.org/records/5120004",
        "samples": [{"id": s["id"], "instrument": s["instrument"], "ensemble": s["ensemble"]} for s in SAMPLES],
        "thresholds": {
            "green": {"medianOnsetError": "<0.150s", "hitAt300ms": ">=0.85", "coverage": ">=0.80"},
            "red": {"medianOnsetError": ">0.300s", "hitAt300ms": "<0.70", "coverage": "<0.60"},
        },
        "aggregate": aggregate_rows,
        "perSample": per_sample,
        "bestAggregate": best,
        "m0cDecision": "GREEN" if best["grade"] == "green" else ("RED" if best["grade"] == "red" else "YELLOW_REVIEW"),
        "notes": [
            "MusicNet is a scale/noise stress test; the official metadata reports residual labeling error.",
            "The default samples are solo violin/cello to avoid conflating scale with accompaniment separation.",
        ],
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "m0c-musicnet-summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(out_dir / "m0c-musicnet-per-note.csv", all_rows)
    write_csv(out_dir / "m0c-musicnet-per-sample.csv", per_sample)
    write_csv(out_dir / "m0c-musicnet-sanity.csv", sanity_rows)

    print("[M0c MusicNet string smoke]")
    print(f"  samples={len(SAMPLES)} notes={sum(int(r['goldNotes']) for r in sanity_rows)}")
    for s in aggregate_rows:
        med = None if s["medianOnsetError"] is None else round(float(s["medianOnsetError"]), 4)
        p90 = None if s["p90OnsetError"] is None else round(float(s["p90OnsetError"]), 4)
        print(
            f"  {s['method']}: grade={s['grade']} coverage={s['coverage']:.3f} "
            f"median={med}s p90={p90}s hit100={s['hitAt100ms']:.3f} hit300={s['hitAt300ms']:.3f}"
        )
    print(f"  decision={result['m0cDecision']} best={best['method']}")
    print(f"  wrote {out_dir}")


if __name__ == "__main__":
    main()
