from __future__ import annotations

import json
import tempfile
from pathlib import Path

import numpy as np

from metrics import evaluate
from sihsm_extract import extract_file, write_audio


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        sr = 16000
        t = np.arange(sr * 2) / sr
        target = 0.4 * np.sin(2 * np.pi * 440 * t)
        accomp = 0.4 * np.sin(2 * np.pi * 660 * t)
        write_audio(root / "mix.wav", target + accomp, sr)
        write_audio(root / "target.wav", target, sr)
        write_audio(root / "acc.wav", accomp, sr)
        (root / "score.json").write_text(json.dumps({"notes": [{"onset": 0, "duration": 2, "midi": 69}]}), encoding="utf-8")
        result = extract_file(root / "mix.wav", root / "score.json", root / "out", "erhu", "full")
        metrics = evaluate(result["outputPath"], root / "target.wav", root / "acc.wav", "erhu")
        assert (root / "out" / "posterior_trace.json").exists()
        assert metrics["SI_SDR"] > -5
    print("sihsm pipeline tests ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
