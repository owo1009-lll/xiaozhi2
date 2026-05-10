from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from score_io import read_notes
from sihsm_extract import load_audio, write_audio
from sihsm_posterior import midi_hz

SNR_LEVELS = {"hard": -6.0, "medium": 0.0, "easy": 6.0}


def _id(stem: str) -> str:
    return stem.replace("张咏音 - ", "").replace(" ", "-")


def _tone(n: int, sr: int, freq: float, decay: float = 2.2) -> np.ndarray:
    t = np.arange(n, dtype=np.float32) / sr
    env = np.minimum(1.0, np.linspace(0, 1, max(1, min(n, int(sr * 0.03))))).tolist()
    env = np.asarray(env + [1.0] * max(0, n - len(env)), np.float32)[:n]
    env *= np.exp(-decay * t / max(t[-1] if n > 1 else 1.0, 0.1))
    return sum((0.9 / h) * np.sin(2 * np.pi * freq * h * t) for h in (1, 2, 3, 4)) * env


def synth_accompaniment(notes, sr: int, length: int, density: float = 1.0) -> np.ndarray:
    y = np.zeros(length, np.float32)
    last_onset = -9.0
    for i, note in enumerate(notes):
        min_gap = max(0.22, 0.75 / max(density, 0.1))
        if note.onset - last_onset < min_gap and i % 3:
            continue
        last_onset = note.onset
        start = int(note.onset * sr)
        dur = int(max(0.35, min(1.4, note.duration * 1.4)) * sr)
        end = min(length, start + dur)
        if start >= length or end <= start:
            continue
        root = max(36, note.midi - 24)
        chord = [root, root + (3 if note.midi % 12 in {0, 3, 5, 7, 10} else 4), root + 7]
        seg = sum(_tone(end - start, sr, midi_hz(m), 2.0 + 0.4 * j) for j, m in enumerate(chord)).astype(np.float32)
        y[start:end] += 0.06 * seg
        bass_start = min(length, start + int(0.38 * sr))
        bass_end = min(length, bass_start + int(0.55 * sr))
        if bass_end > bass_start and i % max(1, int(3 / max(density, 0.1))) == 0:
            y[bass_start:bass_end] += 0.035 * _tone(bass_end - bass_start, sr, midi_hz(max(28, root - 12)), 1.5)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    return y / peak if peak > 0 else y


def _rms(y: np.ndarray) -> float:
    return float(np.sqrt(np.mean(y * y) + 1e-12))


def mix_at_snr(target: np.ndarray, accompaniment: np.ndarray, snr_db: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    target_db = 20.0 * np.log10(_rms(target))
    accomp_db = 20.0 * np.log10(_rms(accompaniment))
    scale = 10.0 ** ((target_db - accomp_db - snr_db) / 20.0)
    acc = accompaniment * scale
    mix = target + acc
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    target_out = target
    if peak > 0.98:
        norm = 0.98 / peak
        mix, target_out, acc = mix * norm, target * norm, acc * norm
    return mix.astype(np.float32), target_out.astype(np.float32), acc.astype(np.float32)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dir", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--limit-seconds", type=float, default=0.0)
    p.add_argument("--levels", default="easy,medium,hard")
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
        for level in [x.strip() for x in args.levels.split(",") if x.strip()]:
            snr = SNR_LEVELS[level]
            acc_raw = synth_accompaniment(notes, sr, len(y), {"easy": 0.7, "medium": 1.0, "hard": 1.45}[level])
            mix, target_out, acc = mix_at_snr(y, acc_raw, snr)
            item_dir = audio_dir / level / item_id
            item_dir.mkdir(parents=True, exist_ok=True)
            target, accomp, mixture = item_dir / "target_erhu.wav", item_dir / "accompaniment_synth.wav", item_dir / "mixture.wav"
            write_audio(target, target_out, sr)
            write_audio(accomp, acc, sr)
            write_audio(mixture, mix, sr)
            items.append({
                "itemId": f"vip-synth-{level}-{item_id}",
                "title": item_id,
                "instrument": "erhu",
                "subset": f"piano_{level}",
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
                "difficulty": {"targetSnrDb": snr},
                "notes": "Synthetic accompaniment generated from target MIDI for internal pipeline testing."
            })
    manifest = {"schemaVersion": 1, "items": items}
    path = out / "vip-synthetic-mix.local.manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "items": len(items), "manifest": str(path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
