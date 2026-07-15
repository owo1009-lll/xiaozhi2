from __future__ import annotations

import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
EXPERIMENTS = REPO / "scripts" / "experiments"
if str(EXPERIMENTS) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m3plus_pitch_modes import (  # noqa: E402
    is_harmonic_candidate,
    is_ornament_candidate,
    mark_double_stops,
)


def main() -> int:
    notes = [
        {"measureIndex": 1, "beatStart": 0.0, "midi": 62},
        {"measureIndex": 1, "beatStart": 0.0, "midi": 69},
        {"measureIndex": 1, "beatStart": 2.0, "midi": 64},
        {"measureIndex": 2, "beatStart": 0.0, "midi": 67},
        {"measureIndex": 2, "beatStart": 0.0, "midi": 67},
    ]
    mark_double_stops(notes)
    assert notes[0]["doubleStopCandidate"] is True
    assert notes[1]["doubleStopCandidate"] is True
    assert notes[2]["doubleStopCandidate"] is False
    assert notes[3]["doubleStopCandidate"] is False
    assert notes[4]["doubleStopCandidate"] is False

    assert is_ornament_candidate({"techniques": ["trill-mark"], "beatDuration": 1.0}, 1.0) is True
    assert is_ornament_candidate({"techniques": [], "beatDuration": 0.125}, 0.2) is True
    assert is_ornament_candidate({"techniques": [], "beatDuration": 0.5}, 0.4) is False
    assert is_harmonic_candidate({"techniques": ["harmonic-sounding-pitch"]}) is True
    assert is_harmonic_candidate({"techniques": []}) is False

    print("western M3+ symbolic mode tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
