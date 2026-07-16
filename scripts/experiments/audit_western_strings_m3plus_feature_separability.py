#!/usr/bin/env python3
"""Audit held-out scalar feature separability for M3+ ornament and slide.

The audit consumes an existing machine-eval report, so it does not rerun F0.
It is fail-closed on missing reliable positive/negative windows and fits every
threshold on calibration rows only before evaluating holdout rows.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Callable

from diagnose_western_strings_m3plus_protocol_order import (
    fit_precision_constrained_threshold,
)


REPO = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3plus"
    / "supplemental-machine-eval-octave12-full"
    / "supplemental-machine-eval.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3plus"
    / "feature-separability-audit"
)
MIN_CLASS_ROWS = 4


def _number(row: dict[str, Any], name: str) -> float | None:
    value = (row.get("modeDiagnostics") or {}).get(name)
    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _abs_number(row: dict[str, Any], name: str) -> float | None:
    value = _number(row, name)
    return abs(value) if value is not None else None


def _early_ornament_seconds(row: dict[str, Any]) -> float | None:
    seconds = _number(row, "ornamentUpperSeconds")
    offset = _number(row, "ornamentFirstUpperOffsetSeconds")
    if seconds is None:
        return None
    return seconds if offset is not None and offset <= 0.15 else 0.0


FEATURES: dict[str, dict[str, Callable[[dict[str, Any]], float | None]]] = {
    "ornament": {
        "knownUpperFrameRatio": lambda row: _number(row, "knownUpperFrameRatio"),
        "knownUpperBoutCount": lambda row: _number(row, "knownUpperBoutCount"),
        "ornamentUpperSeconds": lambda row: _number(row, "ornamentUpperSeconds"),
        "earlyOrnamentUpperSeconds": _early_ornament_seconds,
    },
    "slide": {
        "positiveNetMotionSemitones": lambda row: _number(
            row, "knownPairNetMotionSemitones"
        ),
        "absoluteNetMotionSemitones": lambda row: _abs_number(
            row, "knownPairNetMotionSemitones"
        ),
        "knownPairMonotonicity": lambda row: _number(
            row, "knownPairMonotonicity"
        ),
        "knownPairDirectionalStepRate": lambda row: _number(
            row, "knownPairDirectionalStepRate"
        ),
        "knownPairTransitionSeconds": lambda row: _number(
            row, "knownPairTransitionSeconds"
        ),
    },
}


def reliable_mode_values(
    rows: list[dict[str, Any]],
    mode: str,
    extractor: Callable[[dict[str, Any]], float | None],
    split: str,
) -> list[tuple[float, bool]]:
    values: list[tuple[float, bool]] = []
    for row in rows:
        if row.get("evaluationSplit") != split:
            continue
        diagnostics = row.get("modeDiagnostics") or {}
        if not bool(row.get("localizationUnitReady")) or not bool(
            diagnostics.get("f0QualityReady")
        ):
            continue
        positives = set(row.get("expectedPositiveModes") or [])
        negatives = set(row.get("expectedNegativeModes") or [])
        if mode not in positives and mode not in negatives:
            continue
        value = extractor(row)
        if value is not None:
            values.append((value, mode in positives))
    return values


def _class_counts(values: list[tuple[float, bool]]) -> dict[str, int]:
    positives = sum(positive for _, positive in values)
    return {"positive": positives, "negative": len(values) - positives}


def audit_report(report: dict[str, Any]) -> dict[str, Any]:
    rows = [row for recording in report.get("recordings") or [] for row in recording.get("rows") or []]
    modes: dict[str, Any] = {}
    for mode, feature_map in FEATURES.items():
        feature_results: dict[str, Any] = {}
        for name, extractor in feature_map.items():
            calibration = reliable_mode_values(
                rows, mode, extractor, "calibration"
            )
            holdout = reliable_mode_values(rows, mode, extractor, "holdout")
            calibration_counts = _class_counts(calibration)
            holdout_counts = _class_counts(holdout)
            enough = all(
                count >= MIN_CLASS_ROWS
                for count in (
                    calibration_counts["positive"],
                    calibration_counts["negative"],
                    holdout_counts["positive"],
                    holdout_counts["negative"],
                )
            )
            if not enough:
                feature_results[name] = {
                    "fitReady": False,
                    "reason": "insufficient-reliable-class-rows",
                    "minimumPerClassPerSplit": MIN_CLASS_ROWS,
                    "calibrationCounts": calibration_counts,
                    "holdoutCounts": holdout_counts,
                }
                continue
            result = fit_precision_constrained_threshold(calibration, holdout)
            result["calibrationCounts"] = calibration_counts
            result["holdoutCounts"] = holdout_counts
            feature_results[name] = result
        modes[mode] = feature_results
    any_holdout_pass = any(
        result.get("fitReady") is True
        and float((result.get("holdout") or {}).get("precision") or 0.0) >= 0.90
        and float((result.get("holdout") or {}).get("recall") or 0.0) >= 0.80
        for features in modes.values()
        for result in features.values()
    )
    return {
        "schemaVersion": 1,
        "purpose": "M3+ held-out scalar feature separability audit",
        "evalOnly": True,
        "studentFacing": False,
        "sourceReport": report.get("artifacts", {}).get("json"),
        "minimumPerClassPerSplit": MIN_CLASS_ROWS,
        "modes": modes,
        "anyFeaturePassesHeldoutGate": any_holdout_pass,
        "decision": (
            "scalar-feature-pilot-has-heldout-signal"
            if any_holdout_pass
            else "scalar-feature-pilot-not-release-ready"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    source = args.report.resolve()
    report = json.loads(source.read_text(encoding="utf-8"))
    result = audit_report(report)
    result["sourceReport"] = str(source)
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / "feature-separability-audit.json"
    artifact.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({**result, "artifact": str(artifact)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
