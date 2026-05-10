from __future__ import annotations

from math import exp, isfinite, log2

PROFILES = {
    "erhu": (52, 96),
    "jinghu": (67, 108),
    "banhu": (55, 98),
    "gaohu": (60, 103),
}


def midi_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((float(midi) - 69.0) / 12.0))


def cents(a: float, b: float) -> float:
    if a <= 0 or b <= 0:
        return 9999.0
    return 1200.0 * log2(float(a) / float(b))


def timing_weight(offset_seconds: float, tolerance_seconds: float = 2.0, floor: float = 0.02) -> float:
    return 1.0 if abs(float(offset_seconds)) <= tolerance_seconds else floor


def _gauss(f: float, center: float, sigma_cents: float) -> float:
    error = cents(f, center)
    return exp(-0.5 * (error / max(float(sigma_cents), 1e-6)) ** 2)


def _in_profile(f: float, profile: str) -> bool:
    lo, hi = PROFILES.get(profile, PROFILES["erhu"])
    return midi_hz(lo) <= f <= midi_hz(hi)


def _unique(freqs: list[float]) -> list[float]:
    out: list[float] = []
    for freq in sorted(f for f in freqs if isfinite(f) and f > 0):
        if not any(abs(cents(freq, seen)) < 3.0 for seen in out):
            out.append(freq)
    return out


def candidates(f_det: float, f_score: float, profile: str = "erhu") -> list[float]:
    freqs = []
    for base in (f_det, f_score):
        if base and base > 0:
            freqs.extend([base / 2.0, base, base * 2.0])
    return _unique([freq for freq in freqs if _in_profile(freq, profile)])


def detector_likelihood(f: float, f_det: float, confidence: float) -> float:
    if not f_det or f_det <= 0:
        return 0.05
    conf = max(0.0, min(1.0, float(confidence)))
    sigma = 24.0 + (1.0 - conf) * 620.0
    octave_mix = [(f_det / 2.0, 0.28), (f_det, 1.0), (f_det * 2.0, 0.35)]
    return max(1e-9, conf) * max(w * _gauss(f, center, sigma) for center, w in octave_mix if center > 0)


def score_prior(f: float, f_score: float, profile: str = "erhu", timing: float = 1.0) -> float:
    if not _in_profile(f, profile):
        return 1e-9
    if not f_score or f_score <= 0:
        return 1e-3
    octave_prior = [(f_score / 2.0, 0.25), (f_score, 1.0), (f_score * 2.0, 0.35)]
    return max(1e-9, float(timing)) * max(w * _gauss(f, center, 120.0) for center, w in octave_prior if center > 0)


def choose_pitch(f_det: float, confidence: float, f_score: float, profile: str = "erhu", timing: float = 1.0) -> dict:
    rows = []
    for freq in candidates(f_det, f_score, profile):
        like = detector_likelihood(freq, f_det, confidence)
        prior = score_prior(freq, f_score, profile, timing)
        rows.append({"f": freq, "likelihood": like, "prior": prior, "posterior": like * prior})
    if not rows:
        return {"f_eff": 0.0, "confidence": 0.0, "candidates": []}
    best = max(rows, key=lambda row: row["posterior"])
    total = sum(row["posterior"] for row in rows) or 1.0
    return {"f_eff": best["f"], "confidence": best["posterior"] / total, "candidates": rows}
