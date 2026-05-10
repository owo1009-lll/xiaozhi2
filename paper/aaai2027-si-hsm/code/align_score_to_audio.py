from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from score_io import Note, read_notes
from sihsm_extract import estimate_pitch, load_audio


def _score_track(notes: list[Note], hop: float) -> tuple[np.ndarray, np.ndarray]:
    end = max((n.onset + n.duration for n in notes), default=0.0)
    times = np.arange(0.0, end + hop, hop)
    freqs = np.zeros(len(times), np.float32)
    j = 0
    for i, t in enumerate(times):
        while j + 1 < len(notes) and notes[j].onset + notes[j].duration <= t:
            j += 1
        if j < len(notes) and notes[j].onset <= t < notes[j].onset + notes[j].duration:
            freqs[i] = notes[j].freq
    return times, freqs


def _cost(score_f: np.ndarray, audio_f: np.ndarray, audio_c: np.ndarray) -> np.ndarray:
    sf = score_f[:, None]
    af = audio_f[None, :]
    active = (sf > 0) & (af > 0)
    vals = []
    for k in (-1, 0, 1):
        with np.errstate(divide="ignore", invalid="ignore"):
            vals.append(np.abs(1200.0 * np.log2(af / (sf * (2.0 ** k)))))
    c = np.minimum.reduce(vals) / 600.0
    c = np.clip(c, 0.0, 2.0)
    c = np.where(active, c, 2.0)
    return (c * (0.6 + 0.4 * (1.0 - audio_c[None, :]))).astype(np.float32)


def _dtw_path(cost: np.ndarray) -> np.ndarray:
    try:
        import librosa
        _, wp = librosa.sequence.dtw(C=cost, subseq=False, backtrack=True)
        return wp[::-1]
    except Exception:
        n, m = cost.shape
        dp = np.full((n, m), np.inf, np.float32)
        dp[0, :] = np.cumsum(cost[0, :])
        dp[:, 0] = np.cumsum(cost[:, 0])
        for i in range(1, n):
            for j in range(1, m):
                dp[i, j] = cost[i, j] + min(dp[i - 1, j], dp[i, j - 1], dp[i - 1, j - 1])
        i, j, path = n - 1, int(np.argmin(dp[-1])), []
        while i > 0 or j > 0:
            path.append((i, j))
            opts = [(dp[i - 1, j - 1] if i and j else np.inf, i - 1, j - 1), (dp[i - 1, j] if i else np.inf, i - 1, j), (dp[i, j - 1] if j else np.inf, i, j - 1)]
            _, i, j = min(opts, key=lambda x: x[0])
        path.append((0, 0))
        return np.asarray(path[::-1], np.int32)


def align(notes: list[Note], audio: str | Path, hop: float = 0.02, profile: str = "erhu") -> list[dict]:
    y, sr = load_audio(audio)
    audio_times = np.arange(0.0, len(y) / sr, hop)
    audio_f, audio_c = estimate_pitch(y, sr, audio_times, profile)
    score_times, score_f = _score_track(notes, hop)
    path = _dtw_path(_cost(score_f, audio_f, audio_c))
    known_s, known_a = [], []
    for idx in np.unique(path[:, 0]):
        idx = int(np.clip(idx, 0, len(score_times) - 1))
        js = np.clip(path[path[:, 0] == idx, 1], 0, len(audio_times) - 1)
        known_s.append(float(score_times[idx]))
        known_a.append(float(np.median(audio_times[js])))
    mapped = np.interp(score_times, np.asarray(known_s), np.asarray(known_a))
    out = []
    for note in notes:
        start = float(np.interp(note.onset, score_times, mapped))
        end = float(np.interp(note.onset + note.duration, score_times, mapped))
        if end - start >= 0.03:
            out.append({"onset": start, "duration": end - start, "midi": note.midi, "noteId": note.note_id})
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--score", required=True)
    p.add_argument("--audio", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--instrument", default="erhu")
    p.add_argument("--hop", type=float, default=0.02)
    args = p.parse_args()
    notes = align(read_notes(args.score), args.audio, args.hop, args.instrument)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"notes": notes}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "notes": len(notes), "duration": notes[-1]["onset"] + notes[-1]["duration"] if notes else 0, "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
