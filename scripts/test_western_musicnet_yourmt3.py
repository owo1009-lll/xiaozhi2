#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile


REPO = Path(__file__).resolve().parents[1]
PATH = REPO / "scripts" / "experiments" / "eval_western_musicnet_yourmt3.py"
SPEC = importlib.util.spec_from_file_location("musicnet_yourmt3", PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def metric(precision: float, recall: float):
    return {
        "aggregate": {
            "50ms": {"precision": precision, "recall": recall},
            "100ms": {
                "precision": precision,
                "recall": recall,
                "f1": 2 * precision * recall / (precision + recall),
            },
        }
    }


def main() -> int:
    stronger = {
        "metrics": metric(0.91, 0.86),
        "minimumDurationSeconds": 0.05,
        "timeShiftSeconds": 0.0,
    }
    weaker = {
        "metrics": metric(0.80, 0.70),
        "minimumDurationSeconds": 0.03,
        "timeShiftSeconds": 0.0,
    }
    assert MODULE.candidate_key(stronger) > MODULE.candidate_key(weaker)
    events = [
        {"program": 40, "start": 0.0, "end": 0.2, "midi": 69},
        {"program": 0, "start": 0.0, "end": 0.2, "midi": 60},
    ]
    projected = [event for event in events if event["program"] in MODULE.PROGRAM_GROUPS["violin-only"]]
    assert len(projected) == 1 and projected[0]["midi"] == 69
    shifted = MODULE.shift_events(projected, -0.03)
    assert shifted[0]["start"] == 0.0 and shifted[0]["end"] == 0.17
    with tempfile.TemporaryDirectory() as directory:
        cache_path = Path(directory) / "events.json"
        MODULE.write_cached_transcription(cache_path, "audio-a", 60.0, events)
        assert MODULE.read_cached_transcription(cache_path, "audio-a", 60.0) == events
        assert MODULE.read_cached_transcription(cache_path, "audio-b", 60.0) is None
        stale = json.loads(cache_path.read_text(encoding="utf-8"))
        stale["checkpointSha256"] = "stale"
        cache_path.write_text(json.dumps(stale), encoding="utf-8")
        assert MODULE.read_cached_transcription(cache_path, "audio-a", 60.0) is None
    print("MusicNet YourMT3 challenger tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
