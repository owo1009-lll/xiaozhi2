#!/usr/bin/env python3
"""Regression tests for the eval-only Clarity-OMR M4 benchmark."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_clarity_benchmark import auto_trim_page  # noqa: E402
from eval_western_strings_m4_oemer_benchmark import (  # noqa: E402
    aggregate_metrics,
    automatic_adoption_ready,
)


def benchmark_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "pieceId": "fixture",
        "benchmarkUsable": True,
        "parseOk": True,
        "goldSourceVerified": "yes",
        "goldNotes": 100,
        "draftNotes": 100,
        "pitchExact": 100,
        "pitchPrecision": 1.0,
        "pitchRecall": 1.0,
        "onsetQuarterAccuracy": 1.0,
        "measureAccuracy": 1.0,
    }
    row.update(overrides)
    return row


def test_auto_trim_page() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        source = root / "source.png"
        output = root / "trimmed.png"
        pdf = root / "trimmed.pdf"
        image = Image.new("RGB", (200, 300), "black")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 50, 199, 249), fill="white")
        image.save(source)
        metadata = auto_trim_page(source, output, pdf)
        assert metadata["crop"] == [0, 50, 200, 250]
        assert metadata["outputSize"] == [200, 200]
        assert output.is_file()
        assert pdf.is_file()


def test_complete_gate_rejects_structure_errors() -> None:
    rows = [benchmark_row(onsetQuarterAccuracy=0.4, measureAccuracy=0.8)]
    summary = aggregate_metrics(rows)
    assert summary["pitchOnlyStrictPassRows"] == 1
    assert summary["strictPassRows"] == 0
    assert automatic_adoption_ready(summary, 1) is False


def test_complete_gate_accepts_only_all_strict_rows() -> None:
    rows = [benchmark_row(pieceId="a"), benchmark_row(pieceId="b")]
    summary = aggregate_metrics(rows)
    assert summary["strictPassRows"] == 2
    assert automatic_adoption_ready(summary, 2) is True


if __name__ == "__main__":
    test_auto_trim_page()
    test_complete_gate_rejects_structure_errors()
    test_complete_gate_accepts_only_all_strict_rows()
    print("western M4 Clarity benchmark tests passed")
