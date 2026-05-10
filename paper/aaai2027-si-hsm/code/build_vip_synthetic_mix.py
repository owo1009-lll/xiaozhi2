from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from score_io import read_notes
from sihsm_extract import load_audio, write_audio
from sihsm_posterior import midi_hz


def _id(stem: str) -> str:
    return stem.replace("张咏音 - ", "").replace(" ", "-")


def _tone(n: int, sr: int, freq: float) -> np.ndarray:
    t = np.arange(n, dtype=np.float32) / sr
    env = np.minimum(1.0, np.linspace(0, 1, max(1, min(n, int(sr * 0.03))))).tolist()
    env = np.asarray(env + [1.0] * max(0, n - len(env)), np.float32)[:n]
    env *= np.exp(-2.2 * t / max(t[-1] if n > 1 else 1.0, 0.1))
    return np.sin(2 * np.pi * freq * t) * env


def synth_accompaniment(notes, sr: int, length: int) -> np.ndarray:
    y = np.zeros(length, np.float32)
    last_onset = -9.0
    for i, note in enumerate(notes):
        if note.onset - last_onset < 0.75 and i % 3:
            continue
        last_onset = note.onset
        start = int(note.onset * sr)
        dur = int(max(0.35, min(1.4, note.duration * 1.4)) * sr)
        end = min(length, start + dur)
        if start >= length or end <= start:
            continue
        root = max(36, note.midi - 24)
        chord = [root, root + (3 if note.midi % 12 in {0, 3, 5, 7, 10} else 4), root + 7]
        seg = sum(_tone(end - start, sr, midi_hz(m)) for m in chord).astype(np.float32)
        y[start:end] += 0.055 * seg
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    return y / peak * 0.35 if peak > 0 else y


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dir", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--limit-seconds", type=float, default=0.0)
    args = p.parse_args()
    root, out = Path(args.dir), Path(args.out_dir)
    audio_dir = out / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for mid in sorted(root.glob("*_basic_pitch.mid")):
        stem = mid.name.replace("_basic_pitch.mid", "")
        mp3 = root / f"{stem}.mp3"
        if not mp3.exists():
            continue
        y, sr = load_audio(mp3)
        if args.limit_seconds > 0:
            y = y[: int(args.limit_seconds * sr)]
        notes = read_notes(mid)
        item_id = _id(stem)
        acc = synth_accompaniment(notes, sr, len(y))
        mix = np.clip(y * 0.78 + acc * 0.55, -1.0, 1.0)
        item_dir = audio_dir / item_id
        item_dir.mkdir(exist_ok=True)
        target, accomp, mixture = item_dir / "target_erhu.wav", item_dir / "accompaniment_synth.wav", item_dir / "mixture.wav"
        write_audio(target, y, sr)
        write_audio(accomp, acc, sr)
        write_audio(mixture, mix, sr)
        items.append({
            "itemId": f"vip-synth-{item_id}",
            "title": item_id,
            "instrument": "erhu",
            "subset": "piano",
            "mixturePath": str(mixture),
            "targetPath": str(target),
            "accompanimentPath": str(accomp),
            "scorePath": str(mid),
            "durationSeconds": round(len(y) / sr, 3),
            "sampleRate": sr,
            "channels": 1,
            "licenseStatus": "internal_only",
            "gtStatus": "synthetic_mix",
            "sourceType": "authorized_synthetic",
            "evaluationUse": "objective_separation",
            "notes": "Synthetic accompaniment generated from target MIDI for internal pipeline testing."
        })
    manifest = {"schemaVersion": 1, "items": items}
    path = out / "vip-synthetic-mix.local.manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "items": len(items), "manifest": str(path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
