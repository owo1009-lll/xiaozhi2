from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from sihsm_extract import estimate_pitch, load_audio
from sihsm_posterior import cents


def _align(*xs):
    n = min(len(x) for x in xs)
    return [np.asarray(x[:n], np.float64) for x in xs]


def _db(num, den):
    return float(10 * np.log10((float(num) + 1e-9) / (float(den) + 1e-9)))


def si_sdr(est, ref):
    est, ref = _align(est, ref)
    est, ref = est - est.mean(), ref - ref.mean()
    target = np.dot(est, ref) / (np.dot(ref, ref) + 1e-9) * ref
    return _db(np.sum(target * target), np.sum((est - target) ** 2))


def bss_like(est, target, accomp):
    est, target, accomp = _align(est, target, accomp)
    st = np.dot(est, target) / (np.dot(target, target) + 1e-9) * target
    si = np.dot(est, accomp) / (np.dot(accomp, accomp) + 1e-9) * accomp
    art = est - st - si
    return {
        "SDR": _db(np.sum(st * st), np.sum((si + art) ** 2)),
        "SIR": _db(np.sum(st * st), np.sum(si * si)),
        "SAR": _db(np.sum((st + si) ** 2), np.sum(art * art)),
    }


def pitch_accuracy(est, ref, sr, profile="erhu"):
    frames = np.arange(0, min(len(est), len(ref)) / sr, 0.02)
    ef, ec = estimate_pitch(est, sr, frames, profile)
    rf, rc = estimate_pitch(ref, sr, frames, profile)
    active = (rf > 0) & (rc > 0.1)
    if not np.any(active):
        return {"pitchAccuracy50c": None, "pitchFrames": 0}
    ok = [abs(cents(a, b)) <= 50 for a, b in zip(ef[active], rf[active]) if a > 0 and b > 0]
    return {"pitchAccuracy50c": float(np.mean(ok)) if ok else 0.0, "pitchFrames": int(np.sum(active))}


def evaluate(est_path, target_path, accomp_path=None, profile="erhu"):
    est, sr = load_audio(est_path)
    target, tsr = load_audio(target_path)
    if sr != tsr:
        raise ValueError("sample-rate mismatch")
    out = {"SI_SDR": si_sdr(est, target)}
    if accomp_path:
        accomp, asr = load_audio(accomp_path)
        if sr != asr:
            raise ValueError("sample-rate mismatch")
        out.update(bss_like(est, target, accomp))
    out.update(pitch_accuracy(est, target, sr, profile))
    return out


def main() -> int:
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--estimate", required=True)
    p.add_argument("--target", required=True)
    p.add_argument("--accompaniment")
    p.add_argument("--instrument", default="erhu")
    args = p.parse_args()
    print(json.dumps(evaluate(args.estimate, args.target, args.accompaniment, args.instrument), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
