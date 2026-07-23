#!/usr/bin/env python3
"""Tests for the pre-recording Round 5 position-balance audit."""
from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).with_name("audit-western-round5-position-balance.py")
SPEC = importlib.util.spec_from_file_location("round5_position_balance", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def rows(confounded: bool) -> list[dict]:
    output = []
    for split in ("calibration", "fresh-blind"):
        for gate in MODULE.segment.GATES:
            for recording in range(6):
                for label, suffix in (
                    ("positive", "p"),
                    ("confusion_negative", "n1"),
                    ("confusion_negative", "n2"),
                ):
                    score_interval = (
                        -7.0 if label == "positive" else 2.0
                    ) if confounded and gate == "missing" else float(recording % 2)
                    output.append({
                        "recordingId": f"{split}-{recording}",
                        "eventId": f"{gate}-{suffix}",
                        "split": split,
                        "gate": gate,
                        "label": label,
                        "features": {
                            "scorePreviousInterval": score_interval,
                            "scoreNextInterval": 0.0,
                            "segmentEdgeStatus": 0.0,
                        },
                    })
    return output


def main() -> int:
    bad = MODULE.audit_rows(rows(confounded=True))
    assert bad["readyForRecording"] is False
    assert "calibration:missing" in bad["confoundedSplitGates"]
    assert "fresh-blind:missing" in bad["confoundedSplitGates"]

    good = MODULE.audit_rows(rows(confounded=False))
    assert good["readyForRecording"] is True
    assert good["confoundedSplitGates"] == []
    print("western Round-5 position balance tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
