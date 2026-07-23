#!/usr/bin/env python3
"""Tests for the Round 6 counterbalanced capture candidate."""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

GENERATOR_PATH = (
    Path(__file__).parent
    / "experiments"
    / "generate_round6_counterbalanced_capture_pack.py"
)
AUDIT_PATH = Path(__file__).with_name("audit-western-round5-position-balance.py")


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GENERATOR = load("round6_generator", GENERATOR_PATH)
AUDIT = load("round6_position_audit", AUDIT_PATH)


def main() -> int:
    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory) / "round6"
        generated = GENERATOR.generate(out, with_pdf=False)
        assert generated["recordings"] == 12
        assert generated["scores"] == 4
        manifest = out / "manifest.csv"
        truth = out / "position-truth.json"
        report = AUDIT.run(manifest, truth, out / "position-report.json")
        assert report["contract"] == "western-round5-position-balance-preflight-v2"
        assert report["readyForRecording"] is True
        assert report["confoundedSplitGates"] == []
        assert report["rhythmReviewHint"]["confoundedSplits"] == []

        truth_rows = json.loads(truth.read_text(encoding="utf-8"))["recordings"]
        for gate in GENERATOR.GATES:
            for score_name in ("cal-a", "cal-b", "fresh-a", "fresh-b"):
                recordings = [
                    events["events"]
                    for recording_id, events in truth_rows.items()
                    if recording_id.startswith(f"r6-{score_name}-")
                ]
                labels_by_measure = {
                    measure: sorted(
                        event["label"]
                        for recording in recordings
                        for event in recording
                        if event["gate"] == gate and event["measure"] == measure
                    )
                    for measure in GENERATOR.ANCHORS[gate]
                }
                assert all(
                    labels == [
                        "confusion_negative",
                        "confusion_negative",
                        "positive",
                    ]
                    for labels in labels_by_measure.values()
                )
    print("western Round-6 counterbalanced capture-pack tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
