#!/usr/bin/env python3
"""Regression tests for the eval-only Clarity-OMR M4 benchmark."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, ImageDraw

EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

import eval_western_strings_m4_clarity_benchmark as clarity_benchmark  # noqa: E402
from eval_western_strings_m4_clarity_benchmark import adaptation_decision, auto_trim_page  # noqa: E402
from eval_western_strings_m4_oemer_benchmark import (  # noqa: E402
    aggregate_metrics,
    automatic_adoption_ready,
)
from prepare_western_strings_m4_clarity_adaptation_dataset import (  # noqa: E402
    M4_ROOT,
    validate_managed_output_root,
)
from train_western_strings_m4_clarity_adaptation_pilot import (  # noqa: E402
    validate_dataset_splits,
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


def test_custom_pipeline_uses_absolute_paths_and_cpu_stage_a() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        log = root / "clarity.log"
        with patch.object(clarity_benchmark.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            exit_code, _, error = clarity_benchmark.run_clarity(
                Path("python.exe"),
                Path("relative-clarity-repo"),
                Path("relative-input.pdf"),
                Path("relative-output.musicxml"),
                Path("relative-work"),
                log,
                {},
                "cuda",
                1,
                30,
                Path("relative-yolo.pt"),
                Path("relative-candidate.safetensors"),
                "cpu",
            )
        assert exit_code == 0
        assert error == ""
        command = run.call_args.args[0]
        assert Path(command[1]).resolve() == clarity_benchmark.CLARITY_PIPELINE_RUNNER.resolve()
        assert command[command.index("--stage-a-device") + 1] == "cpu"
        assert Path(command[command.index("--pdf") + 1]).is_absolute()
        assert Path(command[command.index("--output-musicxml") + 1]).is_absolute()
        assert Path(run.call_args.kwargs["cwd"]).is_absolute()


def test_adaptation_rejects_partial_improvement_with_structure_regression() -> None:
    baseline = {
        "rows": 5,
        "usableRows": 5,
        "strictPassRows": 0,
        "pitchPrecision": 0.72,
        "pitchRecall": 0.35,
        "onsetQuarterAccuracy": 0.03,
        "measureAccuracy": 0.10,
    }
    candidate = {
        "rows": 5,
        "usableRows": 5,
        "strictPassRows": 0,
        "pitchPrecision": 0.80,
        "pitchRecall": 0.31,
        "onsetQuarterAccuracy": 0.02,
        "measureAccuracy": 0.06,
    }
    decision = adaptation_decision(candidate, baseline)
    assert decision["retainForFurtherEvaluation"] is False
    assert decision["checkpointDisposition"] == "reject-and-delete"
    assert decision["metricDeltasVsOfficialClarity"]["pitchPrecision"] > 0
    assert decision["metricDeltasVsOfficialClarity"]["measureAccuracy"] < 0


def test_adaptation_fails_closed_on_missing_or_incomplete_metrics() -> None:
    complete = {
        "rows": 5,
        "usableRows": 5,
        "strictPassRows": 0,
        "pitchPrecision": 0.8,
        "pitchRecall": 0.4,
        "onsetQuarterAccuracy": 0.2,
        "measureAccuracy": 0.3,
    }
    missing = dict(complete)
    del missing["measureAccuracy"]
    missing_decision = adaptation_decision(missing, complete)
    assert missing_decision["retainForFurtherEvaluation"] is False
    assert missing_decision["reason"] == "adaptation-required-metrics-missing-or-invalid"

    incomplete = dict(complete, usableRows=4)
    incomplete_decision = adaptation_decision(incomplete, complete)
    assert incomplete_decision["retainForFurtherEvaluation"] is False
    assert incomplete_decision["reason"] == "adaptation-incomplete-or-row-mismatch"

    tiny_regression = dict(complete, measureAccuracy=complete["measureAccuracy"] - 0.0000001)
    tiny_regression["pitchPrecision"] += 0.01
    tiny_decision = adaptation_decision(tiny_regression, complete)
    assert tiny_decision["retainForFurtherEvaluation"] is False


def test_adaptation_retains_only_complete_non_regressive_improvement() -> None:
    baseline = {
        "rows": 5,
        "usableRows": 5,
        "strictPassRows": 0,
        "pitchPrecision": 0.7,
        "pitchRecall": 0.4,
        "onsetQuarterAccuracy": 0.2,
        "measureAccuracy": 0.3,
    }
    candidate = dict(baseline, pitchPrecision=0.71)
    decision = adaptation_decision(candidate, baseline)
    assert decision["retainForFurtherEvaluation"] is True
    assert decision["productionEligible"] is False
    assert decision["checkpointDisposition"] == "retain-eval-only"


def test_adaptation_dataset_guards_reset_and_cross_split_leakage() -> None:
    try:
        validate_managed_output_root(M4_ROOT)
    except RuntimeError:
        pass
    else:
        raise AssertionError("reset guard must reject the M4 root itself")

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        images = []
        for index, payload in enumerate((b"train", b"validation", b"test")):
            image = root / f"image-{index}.png"
            image.write_bytes(payload)
            images.append(image)
        safe_rows = {
            "train": [{"work_id": "bwv1001", "image_path": str(images[0])}],
            "validation": [{"work_id": "bwv1005", "image_path": str(images[1])}],
            "synthetic-test": [{"work_id": "bwv1006", "image_path": str(images[2])}],
        }
        audit = validate_dataset_splits(safe_rows)
        assert audit["workOverlap"] == {}
        assert audit["imageHashOverlap"] == {}

        leaked_work = dict(safe_rows)
        leaked_work["validation"] = [
            {"work_id": "bwv1001", "image_path": str(images[1])}
        ]
        try:
            validate_dataset_splits(leaked_work)
        except RuntimeError:
            pass
        else:
            raise AssertionError("work leakage across splits must fail closed")

        leaked_image = dict(safe_rows)
        leaked_image["validation"] = [
            {"work_id": "bwv1005", "image_path": str(images[0])}
        ]
        try:
            validate_dataset_splits(leaked_image)
        except RuntimeError:
            pass
        else:
            raise AssertionError("image leakage across splits must fail closed")


if __name__ == "__main__":
    test_auto_trim_page()
    test_complete_gate_rejects_structure_errors()
    test_complete_gate_accepts_only_all_strict_rows()
    test_custom_pipeline_uses_absolute_paths_and_cpu_stage_a()
    test_adaptation_rejects_partial_improvement_with_structure_regression()
    test_adaptation_fails_closed_on_missing_or_incomplete_metrics()
    test_adaptation_retains_only_complete_non_regressive_improvement()
    test_adaptation_dataset_guards_reset_and_cross_split_leakage()
    print("western M4 Clarity benchmark tests passed")
