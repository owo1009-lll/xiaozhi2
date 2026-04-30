from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))
warnings.filterwarnings("ignore", message="pkg_resources is deprecated.*")

from analyzer import ErhuAnalyzer, SymbolicNote, midi_to_frequency  # noqa: E402
from config import Settings  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    import numpy as np

    analyzer = ErhuAnalyzer(Settings())
    score_notes = [
        SymbolicNote(
            note_id="n1",
            measure_index=1,
            beat_start=0.0,
            beat_duration=1.0,
            midi_pitch=74,
            expected_onset=0.0,
            expected_offset=1.0,
        ),
        SymbolicNote(
            note_id="n2",
            measure_index=1,
            beat_start=1.0,
            beat_duration=1.0,
            midi_pitch=76,
            expected_onset=1.0,
            expected_offset=2.0,
        ),
    ]
    pitch_track = [
        {"time": 0.0, "frequency": midi_to_frequency(74), "confidence": 0.9},
        {"time": 0.5, "frequency": midi_to_frequency(76), "confidence": 0.8},
        {"time": 1.0, "frequency": midi_to_frequency(40), "confidence": 0.9},
        {"time": 1.5, "frequency": midi_to_frequency(74), "confidence": 0.1},
    ]
    base_waveform = np.ones(1000, dtype=np.float32)
    enhanced_waveform = np.full(1000, 0.5, dtype=np.float32)

    quality = analyzer._measure_separation_quality(
        score_notes,
        pitch_track,
        base_waveform,
        enhanced_waveform,
    )
    require(abs(float(quality["separationEnergyRatio"]) - 0.5) < 0.001, f"bad energy ratio: {quality}")
    require(
        abs(float(quality["separationScoreBandRatio"]) - (2 / 3)) < 0.001,
        f"bad score-band ratio: {quality}",
    )
    require(int(quality["separationConfidentPitchCount"]) == 3, f"bad confident count: {quality}")
    require(int(quality["separationScoreBandHitCount"]) == 2, f"bad hit count: {quality}")
    wrapped_confidence = analyzer._estimate_separation_confidence(
        score_notes,
        pitch_track,
        base_waveform,
        enhanced_waveform,
    )
    require(
        abs(wrapped_confidence - float(quality["separationConfidence"])) < 0.0001,
        "confidence wrapper should match quality payload",
    )

    print(json.dumps({"ok": True, "quality": quality}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
