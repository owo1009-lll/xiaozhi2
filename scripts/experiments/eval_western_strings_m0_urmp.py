# -*- coding: utf-8 -*-
"""M0b western-strings migration probe on URMP individual string tracks.

Eval-only. Uses a tiny, per-file download from the public HuggingFace mirror
of URMP instead of the 12GB Dryad archive. The current smoke fixture is
01_Jupiter_vn_vc, which has violin and cello separated audio, score MIDI, and
URMP note-level onset annotations.

URMP Notes columns are:
  audio_onset_sec  frequency_hz  duration_sec
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from pathlib import Path

import librosa
import numpy as np
import pretty_midi
import soundfile as sf

import eval_western_strings_m0_bach10 as bach10


REPO = Path(__file__).resolve().parents[2]
DEFAULT_URMP = REPO / "data" / "experiments" / "western-strings-m0" / "raw" / "URMP-Eredis02"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m0" / "m0b-urmp"

TRACKS = [
    {
        "piece": "01_Jupiter_vn_vc",
        "track": "vn",
        "instrument": "violin",
        "midiInstrumentIndex": 0,
        "audio": "AuSep_1_vn_01_Jupiter.wav",
        "notes": "Notes_1_vn_01_Jupiter.txt",
        "midi": "Sco_01_Jupiter_vn_vc.mid",
        "minHz": librosa.note_to_hz("G3"),
        "maxHz": librosa.note_to_hz("A7"),
    },
    {
        "piece": "01_Jupiter_vn_vc",
        "track": "vc",
        "instrument": "cello",
        "midiInstrumentIndex": 1,
        "audio": "AuSep_2_vc_01_Jupiter.wav",
        "notes": "Notes_2_vc_01_Jupiter.txt",
        "midi": "Sco_01_Jupiter_vn_vc.mid",
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


def load_urmp_track(root: Path, spec: dict) -> tuple[list[bach10.Note], Path, list[dict]]:
    piece_dir = root / spec["piece"]
    midi_path = piece_dir / spec["midi"]
    audio_path = piece_dir / spec["audio"]
    notes_path = piece_dir / spec["notes"]
    for path in [midi_path, audio_path, notes_path]:
        if not path.exists():
            raise FileNotFoundError(path)

    pm = pretty_midi.PrettyMIDI(str(midi_path))
    instrument = pm.instruments[int(spec["midiInstrumentIndex"])]
    midi_notes = sorted(instrument.notes, key=lambda n: (float(n.start), int(n.pitch), float(n.end)))

    gold_rows: list[tuple[float, int, float]] = []
    for raw in notes_path.read_text(encoding="utf-8").splitlines():
        parts = raw.split()
        if len(parts) < 3:
            continue
        onset = float(parts[0])
        midi = int(round(float(librosa.hz_to_midi(float(parts[1])))))
        duration = float(parts[2])
        gold_rows.append((onset, midi, duration))

    if len(midi_notes) != len(gold_rows):
        raise ValueError(
            f"{spec['piece']} {spec['track']} MIDI/gold note count mismatch: "
            f"{len(midi_notes)} vs {len(gold_rows)}"
        )

    pitch_mismatches = [
        (i, int(m.pitch), int(g[1]))
        for i, (m, g) in enumerate(zip(midi_notes, gold_rows))
        if int(m.pitch) != int(g[1])
    ]
    if pitch_mismatches:
        raise ValueError(f"{spec['piece']} {spec['track']} pitch mismatches: {pitch_mismatches[:10]}")

    by_score_time: dict[float, set[int]] = {}
    for note in midi_notes:
        by_score_time.setdefault(round(float(note.start), 3), set()).add(int(note.pitch))

    notes: list[bach10.Note] = []
    for idx, (midi_note, gold) in enumerate(zip(midi_notes, gold_rows)):
        score_time = float(midi_note.start)
        notes.append(
            bach10.Note(
                piece=f"{spec['piece']}:{spec['track']}",
                idx=idx,
                score_time=score_time,
                gold_time=float(gold[0]),
                midi=int(midi_note.pitch),
                double_stop=len(by_score_time.get(round(score_time, 3), set())) >= 2,
                legato="unknown",
            )
        )

    sanity = [
        {
            "piece": spec["piece"],
            "track": spec["track"],
            "instrument": spec["instrument"],
            "audioPath": str(audio_path.relative_to(REPO)),
            "midiPath": str(midi_path.relative_to(REPO)),
            "notesPath": str(notes_path.relative_to(REPO)),
            "goldNotes": len(notes),
            "doubleStopNotes": sum(1 for n in notes if n.double_stop),
            "minScoreTime": min(n.score_time for n in notes),
            "maxScoreTime": max(n.score_time for n in notes),
            "minGoldTime": min(n.gold_time for n in notes),
            "maxGoldTime": max(n.gold_time for n in notes),
            "audioDuration": float(sf.info(str(audio_path)).duration),
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


def aggregate_rows(rows: list[dict], method: str) -> tuple[dict, list[dict]]:
    notes: list[bach10.Note] = []
    preds: list[float | None] = []
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
    return summary, rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--urmp-root", default=str(DEFAULT_URMP))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT))
    parser.add_argument(
        "--methods",
        default="linear-scoretime,crepe-dtw,pyin-dtw,basic-pitch-dtw,parangonar-basic-pitch",
        help="comma-separated: linear-scoretime,crepe-dtw,pyin-dtw,basic-pitch-dtw,parangonar-basic-pitch",
    )
    args = parser.parse_args()

    root = Path(args.urmp_root)
    out_dir = Path(args.out_dir)
    methods = [m.strip() for m in args.methods.split(",") if m.strip()]

    all_rows: list[dict] = []
    per_track: list[dict] = []
    sanity_rows: list[dict] = []

    for spec in TRACKS:
        notes, audio_path, sanity = load_urmp_track(root, spec)
        sanity_rows.extend(sanity)
        predictions: dict[str, list[float | None]] = {}

        if "linear-scoretime" in methods:
            predictions["linear-scoretime"] = bach10.predict_linear_scoretime(notes)
        if "crepe-dtw" in methods:
            predictions["crepe-dtw"] = with_pitch_range(spec, lambda: bach10.predict_crepe_dtw(notes, audio_path))
        if "pyin-dtw" in methods:
            predictions["pyin-dtw"] = with_pitch_range(spec, lambda: bach10.predict_pyin_dtw(notes, audio_path))

        events: list[dict] | None = None
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
            summary["piece"] = spec["piece"]
            summary["track"] = spec["track"]
            summary["instrument"] = spec["instrument"]
            summary["grade"] = bach10.grade(summary)
            per_track.append(summary)
            all_rows.extend(rows)

    aggregate = [aggregate_rows(all_rows, method)[0] for method in sorted({row["method"] for row in all_rows})]
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
        "dataset": "URMP Eredis02/HuggingFace smoke subset",
        "source": "https://huggingface.co/datasets/Eredis02/URMP",
        "tracks": [{"piece": t["piece"], "track": t["track"], "instrument": t["instrument"]} for t in TRACKS],
        "thresholds": {
            "green": {"medianOnsetError": "<0.150s", "hitAt300ms": ">=0.85", "coverage": ">=0.80"},
            "red": {"medianOnsetError": ">0.300s", "hitAt300ms": "<0.70", "coverage": "<0.60"},
        },
        "aggregate": aggregate,
        "decisionCandidateMethods": [s["method"] for s in decision_candidates],
        "perTrack": per_track,
        "bestAggregate": best,
        "m0bDecision": "GREEN" if best["grade"] == "green" else ("RED" if best["grade"] == "red" else "YELLOW_REVIEW"),
        "notes": [
            "This is an M0b smoke test on one URMP violin/cello piece, not a full-dataset claim.",
            "Dryad official archive is a single ~12GB file; this run uses a public file-level HuggingFace mirror.",
        ],
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "m0b-urmp-summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(out_dir / "m0b-urmp-per-note.csv", all_rows)
    write_csv(out_dir / "m0b-urmp-per-track.csv", per_track)
    write_csv(out_dir / "m0b-urmp-sanity.csv", sanity_rows)

    print("[M0b URMP violin/cello smoke]")
    print(f"  tracks={len(TRACKS)} notes={sum(int(r['goldNotes']) for r in sanity_rows)}")
    for s in aggregate:
        med = None if s["medianOnsetError"] is None else round(float(s["medianOnsetError"]), 4)
        p90 = None if s["p90OnsetError"] is None else round(float(s["p90OnsetError"]), 4)
        print(
            f"  {s['method']}: grade={s['grade']} coverage={s['coverage']:.3f} "
            f"median={med}s p90={p90}s hit100={s['hitAt100ms']:.3f} hit300={s['hitAt300ms']:.3f}"
        )
    print(f"  decision={result['m0bDecision']} best={best['method']}")
    print(f"  wrote {out_dir}")


if __name__ == "__main__":
    main()
