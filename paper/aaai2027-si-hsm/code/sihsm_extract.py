from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import median_filter

from score_io import Note, notes_as_dicts, read_notes, score_at_frames
from sihsm_posterior import PROFILES, choose_pitch, midi_hz


@dataclass
class Config:
    n_fft: int = 2048
    hop: int = 512
    harmonics: int = 6
    bandwidth_cents: float = 38.0
    residual: float = 0.05
    tolerance: float = 2.0
    trace_stride: int = 1


def load_audio(path: str | Path) -> tuple[np.ndarray, int]:
    try:
        y, sr = sf.read(path, always_2d=True)
        return y.mean(axis=1).astype(np.float32), int(sr)
    except Exception:
        import librosa
        y, sr = librosa.load(path, sr=None, mono=True)
        return y.astype(np.float32), int(sr)


def write_audio(path: str | Path, y: np.ndarray, sr: int) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    sf.write(path, y / peak * 0.98 if peak > 1 else y, sr)


def _stft(y: np.ndarray, sr: int, cfg: Config):
    f, t, z = signal.stft(y, sr, nperseg=cfg.n_fft, noverlap=cfg.n_fft - cfg.hop, boundary="zeros", padded=True)
    return f, t, z


def _istft(z, sr: int, cfg: Config, length: int) -> np.ndarray:
    _, y = signal.istft(z, sr, nperseg=cfg.n_fft, noverlap=cfg.n_fft - cfg.hop, input_onesided=True)
    return np.pad(y, (0, max(0, length - len(y))))[:length].astype(np.float32)


def hpss(z):
    mag = np.abs(z)
    h = median_filter(mag, size=(1, 17))
    p = median_filter(mag, size=(17, 1))
    hmask = h * h / (h * h + p * p + 1e-9)
    return z * hmask, z * (1.0 - hmask)


def estimate_pitch(y: np.ndarray, sr: int, frames: np.ndarray, profile: str) -> tuple[np.ndarray, np.ndarray]:
    lo, hi = PROFILES.get(profile, PROFILES["erhu"])
    fmin, fmax = midi_hz(lo), midi_hz(hi)
    win = max(1024, int(sr * 0.046))
    out_f, out_c = [], []
    for sec in frames:
        center = int(sec * sr)
        start, end = max(0, center - win // 2), min(len(y), center + win // 2)
        frame = y[start:end]
        if len(frame) < win // 3 or float(np.max(np.abs(frame))) < 1e-5:
            out_f.append(0.0); out_c.append(0.0); continue
        frame = (frame - frame.mean()) * np.hanning(len(frame))
        ac = np.correlate(frame, frame, mode="full")[len(frame) - 1 :]
        a, b = int(sr / fmax), min(len(ac) - 1, int(sr / fmin))
        if b <= a or ac[0] <= 1e-9:
            out_f.append(0.0); out_c.append(0.0); continue
        lag = a + int(np.argmax(ac[a:b]))
        conf = max(0.0, min(1.0, float(ac[lag] / (ac[0] + 1e-9))))
        out_f.append(float(sr / lag) if conf >= 0.08 else 0.0)
        out_c.append(conf)
    return np.asarray(out_f, np.float32), np.asarray(out_c, np.float32)


def _mask(freqs, frames, f_det, c_det, score_rows, profile: str, mode: str, cfg: Config):
    mask = np.full((len(freqs), len(frames)), cfg.residual, np.float32)
    bw_ratio = 2.0 ** (cfg.bandwidth_cents / 1200.0) - 1.0
    trace = []
    for i, sec in enumerate(frames):
        score_f, timing = score_rows[i]["freq"], score_rows[i]["timing"]
        if mode == "score_only":
            chosen = {"f_eff": score_f, "confidence": timing, "candidates": []}
        elif mode == "pitch_only":
            chosen = {"f_eff": float(f_det[i]), "confidence": float(c_det[i]), "candidates": []}
        else:
            chosen = choose_pitch(float(f_det[i]), float(c_det[i]), score_f, profile, timing)
        base, gamma = float(chosen["f_eff"]), float(chosen["confidence"])
        if base > 0 and gamma > 0:
            for h in range(1, cfg.harmonics + 1):
                center = base * h
                if center > freqs[-1]:
                    break
                sigma = max(20.0, center * bw_ratio)
                mask[:, i] = np.maximum(mask[:, i], gamma * np.exp(-0.5 * ((freqs - center) / sigma) ** 2))
        if i % max(1, cfg.trace_stride) == 0:
            trace.append({"time": float(sec), "det": float(f_det[i]), "detConfidence": float(c_det[i]), "score": score_f, "noteId": score_rows[i]["note_id"], "f_eff": base, "confidence": gamma, "candidates": chosen["candidates"]})
    return mask, trace


def extract_waveform(y: np.ndarray, sr: int, notes: list[Note], profile: str = "erhu", mode: str = "full", cfg: Config | None = None):
    cfg = cfg or Config()
    freqs, frames, z = _stft(y, sr, cfg)
    harmonic, percussive = hpss(z)
    if mode == "hpss":
        return _istft(harmonic + cfg.residual * percussive, sr, cfg, len(y)), []
    f_det, c_det = estimate_pitch(y, sr, frames, profile)
    score_rows = score_at_frames(notes, [float(t) for t in frames], len(y) / sr, cfg.tolerance)
    mask, trace = _mask(freqs, frames, f_det, c_det, score_rows, profile, mode, cfg)
    return _istft(harmonic * mask + cfg.residual * percussive, sr, cfg, len(y)), trace


def extract_file(mixture: str | Path, score: str | Path, out_dir: str | Path, profile: str = "erhu", mode: str = "full", target_part: str | None = None, cfg: Config | None = None, notes: list[Note] | None = None) -> dict:
    out_dir = Path(out_dir)
    y, sr = load_audio(mixture)
    notes = notes or read_notes(score, target_part)
    est, trace = extract_waveform(y, sr, notes, profile, mode, cfg)
    wav = out_dir / f"{mode}.wav"
    write_audio(wav, est, sr)
    if trace:
        (out_dir / "posterior_trace.json").write_text(json.dumps({"mode": mode, "profile": profile, "notes": notes_as_dicts(notes), "frames": trace}, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"outputPath": str(wav), "frames": len(trace)}
