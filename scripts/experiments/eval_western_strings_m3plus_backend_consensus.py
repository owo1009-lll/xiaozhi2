#!/usr/bin/env python3
"""Cross-check score-conditioned M3+ evidence across independent F0 backends.

The three source diagnostics are frozen before this script runs.  This tool is
eval-only: it aggregates matching unit windows with a median, fits thresholds
on measures 1-4, evaluates measures 5-8, and never relabels score intent or
enables student feedback.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_REPORTS = {
    "crepe-tiny": REPO
    / "data/experiments/western-strings-m3plus/protocol-order-diagnostic/protocol-order-diagnostic.json",
    "crepe-full": REPO
    / "data/experiments/western-strings-m3plus/protocol-order-diagnostic-crepe-full/protocol-order-diagnostic.json",
    "pyin": REPO
    / "data/experiments/western-strings-m3plus/protocol-order-diagnostic-pyin/protocol-order-diagnostic.json",
}
DEFAULT_OUT = (
    REPO
    / "data/experiments/western-strings-m3plus/backend-consensus"
)
MODE_CONFIG = {
    "vibrato": {
        "recordingId": "m3p-02",
        "feature": "periodicBandEnergyRatio4To8Hz",
        "physicalThreshold": 0.15,
        "evidenceMeaning": "periodic pitch energy in the 4-8 Hz vibrato band",
    },
    "trill": {
        "recordingId": "m3p-02",
        "feature": "knownPitchSwitchCount",
        "physicalThreshold": 2.0,
        "evidenceMeaning": "repeated score-conditioned base/upper pitch switches",
    },
    "ornament": {
        "recordingId": "m3p-03",
        "feature": "earlyOrnamentUpperSeconds",
        "physicalThreshold": 0.04,
        "evidenceMeaning": "brief upper-note excursion near the start that returns to base",
    },
    "slide": {
        "recordingId": "m3p-04",
        "feature": "absoluteNetMotionSemitones",
        "physicalThreshold": 0.80,
        "evidenceMeaning": "score-conditioned source-to-target net pitch motion",
    },
}
MIN_PRECISION = 0.90
MIN_RECALL = 0.80
MIN_CLASS_ROWS = 4
MIN_BACKENDS = 2
MAX_BOUNDARY_SPREAD_SECONDS = 0.25


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _metrics(values: list[tuple[float, bool]], threshold: float) -> dict[str, Any]:
    tp = fp = tn = fn = 0
    for value, positive in values:
        predicted = value >= threshold
        if predicted and positive:
            tp += 1
        elif predicted:
            fp += 1
        elif positive:
            fn += 1
        else:
            tn += 1
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return {
        "truePositive": tp,
        "falsePositive": fp,
        "trueNegative": tn,
        "falseNegative": fn,
        "precision": round(precision, 6) if precision is not None else None,
        "recall": round(recall, 6) if recall is not None else None,
    }


def fit_threshold(
    calibration: list[tuple[float, bool]],
    holdout: list[tuple[float, bool]],
) -> dict[str, Any]:
    candidates = []
    for threshold in sorted({value for value, _ in calibration}):
        metrics = _metrics(calibration, threshold)
        if metrics["precision"] is not None and metrics["precision"] >= MIN_PRECISION:
            candidates.append((threshold, metrics))
    if not candidates:
        return {
            "fitReady": False,
            "reason": "no-calibration-threshold-meets-precision",
            "calibrationCount": len(calibration),
            "holdoutCount": len(holdout),
        }
    threshold, calibration_metrics = max(
        candidates,
        key=lambda item: (float(item[1]["recall"] or 0.0), -float(item[0])),
    )
    return {
        "fitReady": True,
        "threshold": round(float(threshold), 6),
        "calibration": calibration_metrics,
        "holdout": _metrics(holdout, threshold),
        "calibrationCount": len(calibration),
        "holdoutCount": len(holdout),
    }


def _candidate_rows(report: dict[str, Any], recording_id: str) -> list[dict[str, Any]]:
    if str(report.get("recordingId") or "") == recording_id:
        rows = list(report.get("observedFeatureRows") or [])
        if not rows:
            raise ValueError(f"report has no observed rows for {recording_id}")
        return rows
    candidates = report.get("remainingLocalizationCandidates") or []
    candidate = next(
        (row for row in candidates if row.get("recordingId") == recording_id),
        None,
    )
    if candidate is None:
        raise ValueError(f"report has no {recording_id} localization candidate")
    return list(candidate.get("bestReportRows") or [])


def largest_boundary_consensus(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Select the largest time-consistent subset without looking at features."""

    for size in range(len(rows), MIN_BACKENDS - 1, -1):
        candidates = []
        for subset in itertools.combinations(rows, size):
            start_spread = max(row["start"] for row in subset) - min(
                row["start"] for row in subset
            )
            end_spread = max(row["end"] for row in subset) - min(
                row["end"] for row in subset
            )
            if (
                start_spread <= MAX_BOUNDARY_SPREAD_SECONDS
                and end_spread <= MAX_BOUNDARY_SPREAD_SECONDS
            ):
                candidates.append((start_spread + end_spread, subset))
        if candidates:
            return list(min(candidates, key=lambda item: item[0])[1])
    return []


def aggregate_mode(
    mode: str,
    config: dict[str, Any],
    reports: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    backend_rows = {
        backend: _candidate_rows(report, str(config["recordingId"]))
        for backend, report in reports.items()
    }
    unit_ids = {int(row.get("unitIndex")) for row in next(iter(backend_rows.values()))}
    if any(
        {int(row.get("unitIndex")) for row in rows} != unit_ids
        for rows in backend_rows.values()
    ):
        raise ValueError(f"{mode} backend reports do not contain the same units")

    feature = str(config["feature"])
    physical_threshold = float(config["physicalThreshold"])
    aggregated_rows: list[dict[str, Any]] = []
    issue_candidates: list[dict[str, Any]] = []
    for unit_id in sorted(unit_ids):
        rows = {
            backend: next(
                row for row in values if int(row.get("unitIndex")) == unit_id
            )
            for backend, values in backend_rows.items()
        }
        reference = next(iter(rows.values()))
        positive = mode in set(reference.get("expectedPositiveModes") or [])
        negative = mode in set(reference.get("expectedNegativeModes") or [])
        if not positive and not negative:
            continue
        usable = []
        for backend, row in rows.items():
            value = _finite((row.get("features") or {}).get(feature))
            start = _finite(row.get("startSeconds"))
            end = _finite(row.get("endSeconds"))
            if (
                row.get("f0QualityReady") is True
                and value is not None
                and start is not None
                and end is not None
            ):
                usable.append(
                    {"backend": backend, "value": value, "start": start, "end": end}
                )
        consensus = largest_boundary_consensus(usable)
        start_spread = (
            max(row["start"] for row in consensus) - min(row["start"] for row in consensus)
            if consensus
            else None
        )
        end_spread = (
            max(row["end"] for row in consensus) - min(row["end"] for row in consensus)
            if consensus
            else None
        )
        boundary_ready = len(consensus) >= MIN_BACKENDS
        aggregate_value = (
            _median([row["value"] for row in consensus]) if boundary_ready else None
        )
        support_count = sum(
            row["value"] >= physical_threshold for row in consensus
        )
        physical_consensus = bool(boundary_ready and support_count >= MIN_BACKENDS)
        if not boundary_ready or aggregate_value is None:
            physical_state = "uncertain"
        elif physical_consensus:
            physical_state = "confirmed"
        else:
            physical_state = "absent"
        result_row = {
            "unitIndex": unit_id,
            "measure": reference.get("measure"),
            "evaluationSplit": reference.get("evaluationSplit"),
            "expectedBehavior": reference.get("expectedBehavior"),
            "positive": positive,
            "negative": negative,
            "backendEvidence": usable,
            "backendEvidenceCount": len(usable),
            "boundaryConsensusBackends": [row["backend"] for row in consensus],
            "boundaryConsensusBackendCount": len(consensus),
            "boundaryStartSpreadSeconds": round(start_spread, 6) if start_spread is not None else None,
            "boundaryEndSpreadSeconds": round(end_spread, 6) if end_spread is not None else None,
            "boundaryConsensusReady": boundary_ready,
            "medianFeatureValue": round(aggregate_value, 6) if aggregate_value is not None else None,
            "physicalSupportBackendCount": support_count,
            "physicalConsensus": physical_consensus,
            "physicalState": physical_state,
        }
        aggregated_rows.append(result_row)
        if positive and not physical_consensus:
            issue_candidates.append(
                {
                    "recordingId": config["recordingId"],
                    "unitIndex": unit_id,
                    "measure": reference.get("measure"),
                    "evaluationSplit": reference.get("evaluationSplit"),
                    "expectedBehavior": reference.get("expectedBehavior"),
                    "reason": (
                        "cross-backend-window-evidence-insufficient"
                        if not boundary_ready
                        else "score-marked-mode-lacks-two-backend-physical-support"
                    ),
                    "requiresHumanConfirmationBeforeRelabel": True,
                }
            )

    calibration = [
        (float(row["medianFeatureValue"]), bool(row["positive"]))
        for row in aggregated_rows
        if row["evaluationSplit"] == "calibration"
        and row["medianFeatureValue"] is not None
    ]
    holdout = [
        (float(row["medianFeatureValue"]), bool(row["positive"]))
        for row in aggregated_rows
        if row["evaluationSplit"] == "holdout"
        and row["medianFeatureValue"] is not None
    ]
    class_counts = {
        "calibrationPositive": sum(positive for _, positive in calibration),
        "calibrationNegative": sum(not positive for _, positive in calibration),
        "holdoutPositive": sum(positive for _, positive in holdout),
        "holdoutNegative": sum(not positive for _, positive in holdout),
    }
    threshold = fit_threshold(calibration, holdout)
    holdout_metrics = threshold.get("holdout") or {}
    physical_calibration_metrics = _metrics(calibration, physical_threshold)
    physical_holdout_metrics = _metrics(holdout, physical_threshold)
    sample_gate = min(class_counts.values(), default=0) >= MIN_CLASS_ROWS
    fitted_threshold_is_physical = bool(
        threshold.get("fitReady") is True
        and float(threshold.get("threshold") or 0.0) >= physical_threshold
    )
    release_ready = bool(
        sample_gate
        and fitted_threshold_is_physical
        and float(physical_calibration_metrics.get("precision") or 0.0) >= MIN_PRECISION
        and float(physical_calibration_metrics.get("recall") or 0.0) >= MIN_RECALL
        and float(physical_holdout_metrics.get("precision") or 0.0) >= MIN_PRECISION
        and float(physical_holdout_metrics.get("recall") or 0.0) >= MIN_RECALL
    )
    return {
        "mode": mode,
        "recordingId": config["recordingId"],
        "feature": feature,
        "evidenceMeaning": config.get("evidenceMeaning"),
        "aggregation": "median-of-f0-quality-backends",
        "physicalThreshold": physical_threshold,
        "minimumBackends": MIN_BACKENDS,
        "maximumBoundarySpreadSeconds": MAX_BOUNDARY_SPREAD_SECONDS,
        "classCounts": class_counts,
        "sampleGatePassed": sample_gate,
        "thresholdAudit": threshold,
        "fittedThresholdMeetsPhysicalMinimum": fitted_threshold_is_physical,
        "physicalThresholdAudit": {
            "calibration": physical_calibration_metrics,
            "holdout": physical_holdout_metrics,
        },
        "releaseReady": release_ready,
        "studentFacing": False,
        "performanceGoldRelabeled": False,
        "rows": aggregated_rows,
        "scoreAdherenceIssueCandidates": issue_candidates,
    }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# M3+ cross-backend score-conditioned evidence",
        "",
        "Eval-only. Thresholds are fitted on measures 1-4 and scored on measures 5-8.",
        "No score intent is relabeled and no student-facing mode is enabled.",
        "",
        "| mode | feature | class counts (cal+/cal-/hold+/hold-) | holdout P/R | release | issue candidates |",
        "|---|---|---|---|---|---:|",
    ]
    for mode, result in report["modes"].items():
        counts = result["classCounts"]
        holdout = (result.get("physicalThresholdAudit") or {}).get("holdout") or {}
        lines.append(
            f"| {mode} | {result['feature']} | "
            f"{counts['calibrationPositive']}/{counts['calibrationNegative']}/"
            f"{counts['holdoutPositive']}/{counts['holdoutNegative']} | "
            f"{holdout.get('precision')}/{holdout.get('recall')} | "
            f"{result['releaseReady']} | {len(result['scoreAdherenceIssueCandidates'])} |"
        )
    lines.extend(
        [
            "",
            "## Decision",
            "",
            f"- Any mode release-ready: `{report['anyModeReleaseReady']}`.",
            "- Missing cross-backend evidence remains an adherence/re-recording candidate, not an automatic label change.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(report_paths: dict[str, Path]) -> dict[str, Any]:
    reports = {
        backend: json.loads(path.read_text(encoding="utf-8"))
        for backend, path in report_paths.items()
    }
    modes = {
        mode: aggregate_mode(mode, config, reports)
        for mode, config in MODE_CONFIG.items()
    }
    return {
        "schemaVersion": 1,
        "scope": "eval-only cross-backend score-conditioned M3+ evidence",
        "sourceReports": {backend: str(path) for backend, path in report_paths.items()},
        "backends": list(report_paths),
        "modes": modes,
        "anyModeReleaseReady": any(result["releaseReady"] for result in modes.values()),
        "studentFacing": False,
        "productionPolicyChanged": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    report = run(DEFAULT_REPORTS)
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    json_path = out / "report.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(report, out / "report.md")
    print(json.dumps({**report, "artifact": str(json_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
