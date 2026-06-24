# -*- coding: utf-8 -*-
"""Run SI-HSM score-informed separation on a full recording -> erhu stem wav.

Uses the AAAI code (paper/aaai2027-si-hsm/code/sihsm_extract.extract_waveform). Builds
the erhu-part Note list from data/erhu-score-imports.json (onset = cumulative beats ->
seconds at a nominal tempo; score_at_frames rescales to audio duration internally, so
only the PROPORTIONAL ordering matters). The stem is then fed to the global-DTW
alignment experiment to measure separation's effect on alignment accuracy.

Run:
  python-service/.venv/Scripts/python.exe scripts/experiments/separate_piece.py \
    --score-id score-mofx8cdb-sbrqgx \
    --audio data/real-tests/originals/xuan-dong-full.mp3 \
    --mode full --out data/experiments/stems/xuandong-erhu-full.wav
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
AAAI_CODE = REPO_ROOT / "paper" / "aaai2027-si-hsm" / "code"
sys.path.insert(0, str(AAAI_CODE))

from score_io import Note  # noqa: E402
from sihsm_extract import extract_waveform, load_audio, write_audio, Config  # noqa: E402


def build_erhu_notes(score_id: str, nominal_tempo: float = 100.0) -> list[Note]:
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((s for s in store.get("scores", []) if s.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")
    rows = []
    for section in score.get("sections", []):
        for note in section.get("notes", []) or []:
            pos = note.get("notePosition") or {}
            if str(pos.get("scoreLineRole", "erhu")) != "erhu":
                continue
            midi = note.get("midiPitch")
            if midi is None:
                continue
            gm = float(pos.get("globalMeasureIndex") or note.get("measureIndex") or 0)
            rows.append((gm, float(note.get("beatStart", 0.0)),
                         int(round(float(midi))), float(note.get("beatDuration", 1.0)),
                         str(note.get("noteId", ""))))
    rows.sort(key=lambda r: (r[0], r[1]))
    spb = 60.0 / nominal_tempo
    notes, cursor, last_key = [], 0.0, None
    for gm, bs, midi, dur, nid in rows:
        # cumulative beats: advance by measure boundaries + within-measure beatStart
        key = (gm, bs)
        if last_key is not None and key != last_key:
            cursor += 0.0  # ordering only; onset set below from a running counter
        onset = len(notes) * 0.0  # placeholder, replaced below
        notes.append(Note(0.0, max(0.125, dur) * spb, midi, nid or f"n{len(notes)}"))
        last_key = key
    # assign monotonic onsets by cumulative duration (proportional musical timeline)
    t = 0.0
    rebuilt = []
    for n in notes:
        rebuilt.append(Note(t, n.duration, n.midi, n.note_id))
        t += n.duration
    return rebuilt


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--score-id", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--mode", default="full", choices=["full", "pitch_only", "score_only", "hpss"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    notes = build_erhu_notes(args.score_id)
    y, sr = load_audio(str((REPO_ROOT / args.audio).resolve()))
    stem, _trace = extract_waveform(y, sr, notes, profile="erhu", mode=args.mode, cfg=Config())
    out_path = REPO_ROOT / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_audio(str(out_path), stem, sr)
    print(json.dumps({
        "ok": True, "mode": args.mode, "scoreId": args.score_id,
        "erhuNotes": len(notes), "audioSeconds": round(len(y) / sr, 1),
        "stem": str(out_path), "stemRms": round(float(np.sqrt(np.mean(stem ** 2))), 5),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
