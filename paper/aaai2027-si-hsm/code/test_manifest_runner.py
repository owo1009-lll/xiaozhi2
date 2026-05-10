from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from sihsm_extract import write_audio


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        sr = 16000
        t = np.arange(sr) / sr
        write_audio(root / "mix.wav", 0.4 * np.sin(2 * np.pi * 440 * t) + 0.2 * np.sin(2 * np.pi * 660 * t), sr)
        write_audio(root / "target.wav", 0.4 * np.sin(2 * np.pi * 440 * t), sr)
        write_audio(root / "acc.wav", 0.2 * np.sin(2 * np.pi * 660 * t), sr)
        (root / "score.json").write_text(json.dumps({"notes": [{"onset": 0, "duration": 1, "midi": 69}]}), encoding="utf-8")
        (root / "manifest.json").write_text(json.dumps({"schemaVersion": 1, "items": [{
            "itemId": "smoke", "title": "smoke", "instrument": "erhu", "subset": "piano",
            "mixturePath": "mix.wav", "targetPath": "target.wav", "accompanimentPath": "acc.wav",
            "scorePath": "score.json", "licenseStatus": "internal_only", "gtStatus": "clean_stems",
            "evaluationUse": "objective_separation"
        }]}), encoding="utf-8")
        cmd = [sys.executable, str(Path(__file__).with_name("run_manifest.py")), "--manifest", str(root / "manifest.json"), "--out-dir", str(root / "runs"), "--robustness"]
        subprocess.check_call(cmd)
        assert (root / "runs" / "results.csv").exists()
    print("manifest runner tests ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
