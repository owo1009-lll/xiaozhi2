#!/usr/bin/env python3
"""Test whether relative audio IOI can rank clean gold above an OMR draft.

The probe is eval-only. It compares within-measure relative IOI shapes after
pitch-sequence alignment, so global tempo does not matter. It never edits a
score and cannot turn performance agreement into independent score truth.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_omr_benchmark import repo_path  # noqa: E402
from eval_western_strings_m4_rhythm_candidate_oracle import (  # noqa: E402
    _best_part_measures,
    exact_pitch_measure_pairs,
    parse_measure_rhythms_many,
)
from proto_western_strings_score_anchored_feedback import (  # noqa: E402
    PRIVATE,
    align,
    audio_events,
)


DEFAULT_BENCHMARK = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-source-benchmark"
    / "omr-benchmark.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "audio-rhythm-ranking"
)
MIN_INTERVALS = 12
MIN_INTERVAL_COVERAGE = 0.30
SELECTION_MARGIN = 0.05
MEASURE_MIN_INTERVALS = 2
MEASURE_MIN_INTERVAL_COVERAGE = 0.60
MEASURE_MARGIN_GRID = (0.0, 0.02, 0.05, 0.08, 0.12, 0.20, 0.30)


def timed_mxl_events(path: Path, *, offset: float = 0.0, measure_offset: int = 0) -> list[dict[str, Any]]:
    from music21 import converter

    score = converter.parse(str(path))
    events: dict[float, dict[str, Any]] = {}
    for note in score.flatten().notes:
        onset = round(float(note.offset) + offset, 6)
        event = events.setdefault(
            onset,
            {
                "offsetQuarters": onset,
                "measure": int(note.measureNumber or 0) + measure_offset,
                "midis": set(),
            },
        )
        event["midis"].update(int(pitch.midi) for pitch in note.pitches)
    return [
        {**events[key], "midis": sorted(events[key]["midis"])}
        for key in sorted(events)
    ]


def timed_mxl_events_many(paths: list[Path]) -> list[dict[str, Any]]:
    combined: list[dict[str, Any]] = []
    offset = 0.0
    measure_offset = 0
    for path in paths:
        events = timed_mxl_events(path, offset=offset, measure_offset=measure_offset)
        combined.extend(events)
        if events:
            local_offsets = [float(event["offsetQuarters"]) for event in events]
            positive_steps = [
                right - left
                for left, right in zip(local_offsets, local_offsets[1:])
                if right > left
            ]
            tail = float(np.median(positive_steps)) if positive_steps else 1.0
            offset = max(local_offsets) + max(0.125, tail)
            measure_offset = max(int(event["measure"]) for event in events)
    return combined


def normalized_ioi_error(score_ioi: list[float], audio_ioi: list[float]) -> float | None:
    if len(score_ioi) != len(audio_ioi) or len(score_ioi) < 2:
        return None
    score = np.asarray(score_ioi, dtype=np.float64)
    audio = np.asarray(audio_ioi, dtype=np.float64)
    valid = np.isfinite(score) & np.isfinite(audio) & (score > 0.0) & (audio > 0.0)
    score = score[valid]
    audio = audio[valid]
    if score.size < 2:
        return None
    score /= float(np.median(score))
    audio /= float(np.median(audio))
    return float(np.mean(np.abs(np.log2(audio / score))))


def augment_audio_onsets(audio_path: Path, basic_events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add pitch-supported flux/voicing onsets without trusting onset-only peaks."""

    import librosa

    waveform, sample_rate = librosa.load(str(audio_path), sr=22050, mono=True)
    hop_length = 256
    onset_frames = librosa.onset.onset_detect(
        y=waveform,
        sr=sample_rate,
        hop_length=hop_length,
        units="frames",
        backtrack=False,
    )
    f0, voiced, _ = librosa.pyin(
        waveform,
        fmin=float(librosa.note_to_hz("C3")),
        fmax=float(librosa.note_to_hz("A7")),
        sr=sample_rate,
        hop_length=hop_length,
        frame_length=2048,
    )
    frame_times = librosa.frames_to_time(np.arange(len(f0)), sr=sample_rate, hop_length=hop_length)
    valid = np.asarray(voiced, dtype=bool) & np.isfinite(f0)
    voiced_starts = np.flatnonzero(valid & np.r_[True, ~valid[:-1]])
    candidate_times = sorted(
        set(float(value) for value in librosa.frames_to_time(onset_frames, sr=sample_rate, hop_length=hop_length))
        | set(float(frame_times[index]) for index in voiced_starts)
    )
    augmented = [dict(event) for event in basic_events]
    existing_starts = [float(event["start"]) for event in augmented]
    for start in candidate_times:
        if any(abs(start - existing) <= 0.08 for existing in existing_starts):
            continue
        indexes = np.flatnonzero(
            (frame_times >= max(0.0, start - 0.02))
            & (frame_times <= start + 0.18)
            & valid
        )
        if indexes.size < 4:
            continue
        midi_values = librosa.hz_to_midi(f0[indexes])
        if float(np.percentile(midi_values, 90) - np.percentile(midi_values, 10)) > 1.5:
            continue
        midi = int(round(float(np.median(midi_values))))
        augmented.append(
            {
                "start": start,
                "end": start + 0.15,
                "midis": [midi],
                "source": "spectral-flux-or-voicing-boundary",
            }
        )
        existing_starts.append(start)
    return sorted(augmented, key=lambda event: float(event["start"]))


def score_relative_ioi(events: list[dict[str, Any]], detected: list[dict[str, Any]]) -> dict[str, Any]:
    mapping, _ = align(events, detected)
    by_measure: dict[int, list[int]] = {}
    for index, event in enumerate(events):
        by_measure.setdefault(int(event.get("measure") or 0), []).append(index)
    possible_intervals = 0
    evaluated_intervals = 0
    measure_errors: list[tuple[float, int]] = []
    for measure, indexes in sorted(by_measure.items()):
        if measure <= 0 or len(indexes) < 3:
            continue
        possible_intervals += len(indexes) - 1
        score_ioi: list[float] = []
        audio_ioi: list[float] = []
        for left, right in zip(indexes, indexes[1:]):
            left_audio = mapping[left]
            right_audio = mapping[right]
            if left_audio is None or right_audio is None or right_audio <= left_audio:
                continue
            expected = float(events[right]["offsetQuarters"]) - float(events[left]["offsetQuarters"])
            observed = float(detected[right_audio]["start"]) - float(detected[left_audio]["start"])
            if expected <= 0.0 or observed <= 0.0:
                continue
            score_ioi.append(expected)
            audio_ioi.append(observed)
        error = normalized_ioi_error(score_ioi, audio_ioi)
        if error is not None:
            measure_errors.append((error, len(score_ioi)))
            evaluated_intervals += len(score_ioi)
    weighted_error = (
        sum(error * count for error, count in measure_errors)
        / sum(count for _, count in measure_errors)
        if measure_errors
        else None
    )
    coverage = evaluated_intervals / possible_intervals if possible_intervals else 0.0
    return {
        "relativeIoiError": round(weighted_error, 6) if weighted_error is not None else None,
        "evaluatedMeasureCount": len(measure_errors),
        "evaluatedIntervalCount": evaluated_intervals,
        "possibleIntervalCount": possible_intervals,
        "intervalCoverage": round(coverage, 6),
        "evidenceReady": bool(
            weighted_error is not None
            and evaluated_intervals >= MIN_INTERVALS
            and coverage >= MIN_INTERVAL_COVERAGE
        ),
    }


def select_candidate(gold: dict[str, Any], draft: dict[str, Any]) -> str:
    if not gold.get("evidenceReady") or not draft.get("evidenceReady"):
        return "uncertain"
    gold_error = float(gold["relativeIoiError"])
    draft_error = float(draft["relativeIoiError"])
    if gold_error + SELECTION_MARGIN < draft_error:
        return "gold"
    if draft_error + SELECTION_MARGIN < gold_error:
        return "draft"
    return "uncertain"


def score_measure_relative_ioi(
    events: list[dict[str, Any]],
    mapping: list[int | None],
    detected: list[dict[str, Any]],
    measure: int,
) -> dict[str, Any]:
    """Score one monophonic measure against aligned audio onset intervals."""

    indexes = [
        index
        for index, event in enumerate(events)
        if int(event.get("measure") or 0) == int(measure)
    ]
    if len(indexes) < 3 or any(len(events[index].get("midis") or []) != 1 for index in indexes):
        return {
            "relativeIoiError": None,
            "evaluatedIntervalCount": 0,
            "possibleIntervalCount": max(0, len(indexes) - 1),
            "intervalCoverage": 0.0,
            "evidenceReady": False,
        }
    score_ioi: list[float] = []
    audio_ioi: list[float] = []
    for left, right in zip(indexes, indexes[1:]):
        left_audio = mapping[left]
        right_audio = mapping[right]
        if left_audio is None or right_audio is None or right_audio <= left_audio:
            continue
        expected = float(events[right]["offsetQuarters"]) - float(events[left]["offsetQuarters"])
        observed = float(detected[right_audio]["start"]) - float(detected[left_audio]["start"])
        if expected <= 0.0 or observed <= 0.0:
            continue
        score_ioi.append(expected)
        audio_ioi.append(observed)
    error = normalized_ioi_error(score_ioi, audio_ioi)
    possible = len(indexes) - 1
    evaluated = len(score_ioi)
    coverage = evaluated / possible if possible else 0.0
    return {
        "relativeIoiError": round(error, 6) if error is not None else None,
        "evaluatedIntervalCount": evaluated,
        "possibleIntervalCount": possible,
        "intervalCoverage": round(coverage, 6),
        "evidenceReady": bool(
            error is not None
            and evaluated >= MEASURE_MIN_INTERVALS
            and coverage >= MEASURE_MIN_INTERVAL_COVERAGE
        ),
    }


def select_measure_candidate(row: dict[str, Any], margin: float) -> str:
    gold = row.get("gold") or {}
    draft = row.get("draft") or {}
    if not gold.get("evidenceReady") or not draft.get("evidenceReady"):
        return "uncertain"
    gold_error = float(gold["relativeIoiError"])
    draft_error = float(draft["relativeIoiError"])
    if gold_error + margin < draft_error:
        return "gold"
    if draft_error + margin < gold_error:
        return "draft"
    return "uncertain"


def summarize_measure_rows(rows: list[dict[str, Any]], margin: float) -> dict[str, Any]:
    selections = [select_measure_candidate(row, margin) for row in rows]
    selected = [value for value in selections if value != "uncertain"]
    correct = sum(value == "gold" for value in selected)
    wrong = sum(value == "draft" for value in selected)
    precision = correct / len(selected) if selected else None
    return {
        "margin": margin,
        "rowCount": len(rows),
        "evidenceReadyRows": sum(
            bool(row.get("gold", {}).get("evidenceReady"))
            and bool(row.get("draft", {}).get("evidenceReady"))
            for row in rows
        ),
        "selectedRows": len(selected),
        "goldSelectedRows": correct,
        "draftSelectedRows": wrong,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(len(selected) / len(rows), 6) if rows else 0.0,
    }


def measure_rows_at_coverage(
    rows: list[dict[str, Any]],
    minimum_coverage: float,
) -> list[dict[str, Any]]:
    adjusted: list[dict[str, Any]] = []
    for row in rows:
        candidate = dict(row)
        for key in ("gold", "draft"):
            metric = dict(row.get(key) or {})
            metric["evidenceReady"] = bool(
                metric.get("relativeIoiError") is not None
                and int(metric.get("evaluatedIntervalCount") or 0) >= MEASURE_MIN_INTERVALS
                and float(metric.get("intervalCoverage") or 0.0) >= minimum_coverage
            )
            candidate[key] = metric
        adjusted.append(candidate)
    return adjusted


def measure_coverage_sensitivity(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    reports = []
    for minimum_coverage in (0.30, 0.40, 0.50, 0.60, 0.70):
        adjusted = measure_rows_at_coverage(rows, minimum_coverage)
        reports.append(
            {
                "minimumIntervalCoverage": minimum_coverage,
                "fixedMargin": summarize_measure_rows(adjusted, SELECTION_MARGIN),
                "leaveOnePieceOut": leave_one_piece_out_measure_eval(adjusted),
            }
        )
    return reports


def choose_measure_margin(
    rows: list[dict[str, Any]],
    *,
    min_precision: float = 0.90,
    min_selected: int = 5,
) -> float | None:
    eligible: list[tuple[int, float]] = []
    for margin in MEASURE_MARGIN_GRID:
        summary = summarize_measure_rows(rows, margin)
        precision = summary["selectionPrecision"]
        if (
            summary["selectedRows"] >= min_selected
            and precision is not None
            and precision >= min_precision
        ):
            eligible.append((int(summary["selectedRows"]), float(margin)))
    if not eligible:
        return None
    eligible.sort(key=lambda item: (-item[0], item[1]))
    return eligible[0][1]


def leave_one_piece_out_measure_eval(rows: list[dict[str, Any]]) -> dict[str, Any]:
    pieces = sorted({str(row.get("pieceId") or "") for row in rows if row.get("pieceId")})
    predictions: list[dict[str, Any]] = []
    folds: list[dict[str, Any]] = []
    for piece in pieces:
        training = [row for row in rows if row.get("pieceId") != piece]
        holdout = [row for row in rows if row.get("pieceId") == piece]
        margin = choose_measure_margin(training)
        fold_predictions = []
        for row in holdout:
            selection = select_measure_candidate(row, margin) if margin is not None else "uncertain"
            prediction = {
                "pieceId": piece,
                "goldMeasure": row.get("goldMeasure"),
                "draftMeasure": row.get("draftMeasure"),
                "margin": margin,
                "selection": selection,
            }
            predictions.append(prediction)
            fold_predictions.append(prediction)
        folds.append(
            {
                "holdoutPiece": piece,
                "trainingRowCount": len(training),
                "holdoutRowCount": len(holdout),
                "selectedMargin": margin,
                "selectedRows": sum(row["selection"] != "uncertain" for row in fold_predictions),
                "goldSelectedRows": sum(row["selection"] == "gold" for row in fold_predictions),
                "draftSelectedRows": sum(row["selection"] == "draft" for row in fold_predictions),
            }
        )
    selected = [row for row in predictions if row["selection"] != "uncertain"]
    correct = sum(row["selection"] == "gold" for row in selected)
    wrong = sum(row["selection"] == "draft" for row in selected)
    precision = correct / len(selected) if selected else None
    coverage = len(selected) / len(rows) if rows else 0.0
    return {
        "validation": "leave-one-piece-out-margin-selection",
        "pieceCount": len(pieces),
        "rowCount": len(rows),
        "selectedRows": len(selected),
        "goldSelectedRows": correct,
        "draftSelectedRows": wrong,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(coverage, 6),
        "evalOnlyGatePassed": bool(
            len(rows) >= 30
            and len(pieces) >= 5
            and len(selected) >= 10
            and precision is not None
            and precision >= 0.90
            and coverage >= 0.20
        ),
        "runtimeReady": False,
        "folds": folds,
        "predictions": predictions,
    }


def summarize_method(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    ready_rows = [row for row in rows if row[key]["selection"] != "uncertain"]
    gold_selected = sum(row[key]["selection"] == "gold" for row in rows)
    draft_selected = sum(row[key]["selection"] == "draft" for row in rows)
    precision = gold_selected / len(ready_rows) if ready_rows else None
    coverage = len(ready_rows) / len(rows) if rows else 0.0
    return {
        "pieceCount": len(rows),
        "readySelectionCount": len(ready_rows),
        "goldSelectedCount": gold_selected,
        "draftSelectedCount": draft_selected,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(coverage, 6),
        "evalOnlyGatePassed": bool(
            len(rows) >= 5
            and len(ready_rows) >= 3
            and precision is not None
            and precision >= 0.90
            and draft_selected == 0
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", default=str(DEFAULT_BENCHMARK))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    benchmark = json.loads(Path(args.benchmark).read_text(encoding="utf-8"))
    rows = []
    measure_rows: list[dict[str, Any]] = []
    failures = []
    for source in benchmark["rows"]:
        if not source.get("benchmarkUsable"):
            continue
        piece = str(source["pieceId"])
        try:
            gold_events = timed_mxl_events(repo_path(source["goldPath"]))
            draft_paths = [repo_path(value) for value in str(source["draftPath"]).split("|") if value]
            draft_events = timed_mxl_events_many(draft_paths)
            audio_path = PRIVATE / f"{piece}.m4a"
            detected = audio_events(audio_path)
            augmented = augment_audio_onsets(audio_path, detected)
            gold_metric = score_relative_ioi(gold_events, detected)
            draft_metric = score_relative_ioi(draft_events, detected)
            ensemble_gold = score_relative_ioi(gold_events, augmented)
            ensemble_draft = score_relative_ioi(draft_events, augmented)
            rows.append(
                {
                    "pieceId": piece,
                    "gold": gold_metric,
                    "draft": draft_metric,
                    "selection": select_candidate(gold_metric, draft_metric),
                    "basicEventCount": len(detected),
                    "ensembleEventCount": len(augmented),
                    "ensemble": {
                        "gold": ensemble_gold,
                        "draft": ensemble_draft,
                        "selection": select_candidate(ensemble_gold, ensemble_draft),
                    },
                }
            )
            gold_mapping, _ = align(gold_events, detected)
            draft_mapping, _ = align(draft_events, detected)
            ensemble_gold_mapping, _ = align(gold_events, augmented)
            ensemble_draft_mapping, _ = align(draft_events, augmented)
            gold_measures = _best_part_measures(repo_path(source["goldPath"]))
            draft_measures = parse_measure_rhythms_many(draft_paths)
            comparable_pairs = exact_pitch_measure_pairs(
                repo_path(source["goldPath"]),
                draft_paths,
                gold_measures,
                draft_measures,
            )
            for gold_measure, draft_measure in comparable_pairs:
                gold_measure_metric = score_measure_relative_ioi(
                    gold_events,
                    gold_mapping,
                    detected,
                    gold_measure.measure_index,
                )
                draft_measure_metric = score_measure_relative_ioi(
                    draft_events,
                    draft_mapping,
                    detected,
                    draft_measure.measure_index,
                )
                ensemble_gold_measure_metric = score_measure_relative_ioi(
                    gold_events,
                    ensemble_gold_mapping,
                    augmented,
                    gold_measure.measure_index,
                )
                ensemble_draft_measure_metric = score_measure_relative_ioi(
                    draft_events,
                    ensemble_draft_mapping,
                    augmented,
                    draft_measure.measure_index,
                )
                measure_rows.append(
                    {
                        "pieceId": piece,
                        "goldMeasure": gold_measure.measure_index,
                        "draftMeasure": draft_measure.measure_index,
                        "noteCount": len(gold_measure.pitches),
                        "gold": gold_measure_metric,
                        "draft": draft_measure_metric,
                        "ensembleGold": ensemble_gold_measure_metric,
                        "ensembleDraft": ensemble_draft_measure_metric,
                        "fixedMarginSelection": select_measure_candidate(
                            {"gold": gold_measure_metric, "draft": draft_measure_metric},
                            SELECTION_MARGIN,
                        ),
                    }
                )
        except Exception as error:
            failures.append({"pieceId": piece, "error": f"{type(error).__name__}: {error}"})
    summary = summarize_method(
        [{"basic": {"selection": row["selection"]}} for row in rows], "basic"
    )
    ensemble_summary = summarize_method(rows, "ensemble")
    measure_fixed_summary = summarize_measure_rows(measure_rows, SELECTION_MARGIN)
    measure_lopo = leave_one_piece_out_measure_eval(measure_rows)
    measure_ensemble_rows = [
        {
            **row,
            "gold": row["ensembleGold"],
            "draft": row["ensembleDraft"],
        }
        for row in measure_rows
    ]
    measure_ensemble_fixed_summary = summarize_measure_rows(
        measure_ensemble_rows,
        SELECTION_MARGIN,
    )
    measure_ensemble_lopo = leave_one_piece_out_measure_eval(measure_ensemble_rows)
    report = {
        "schemaVersion": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "evalOnly": True,
        "studentFacing": False,
        "purpose": "relative-IOI ranking of clean gold versus OMR draft",
        "thresholds": {
            "minIntervals": MIN_INTERVALS,
            "minIntervalCoverage": MIN_INTERVAL_COVERAGE,
            "selectionMargin": SELECTION_MARGIN,
            "minSelectionPrecision": 0.90,
        },
        "summary": summary,
        "ensembleSummary": ensemble_summary,
        "measureLevel": {
            "scope": "exact-pitch monophonic gold/draft measure pairs",
            "fixedMarginSummary": measure_fixed_summary,
            "leaveOnePieceOut": measure_lopo,
            "ensembleFixedMarginSummary": measure_ensemble_fixed_summary,
            "ensembleLeaveOnePieceOut": measure_ensemble_lopo,
            "basicCoverageSensitivity": measure_coverage_sensitivity(measure_rows),
            "ensembleCoverageSensitivity": measure_coverage_sensitivity(measure_ensemble_rows),
            "rows": measure_rows,
            "runtimeReady": False,
        },
        "rows": rows,
        "failures": failures,
        "limitations": [
            "clean gold is used only for evaluation and is unavailable to the production ranker",
            "performance can follow an erroneous score, so audio agreement remains correlated evidence",
            "Basic Pitch onset misses and expressive timing reduce interval coverage",
            "measure-level rows use independent gold only to score which of the two candidates was correct; gold is never a runtime feature",
            "a passing measure-level eval proves relative-IOI ranking signal, not that production can generate a complete correct candidate set",
        ],
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# M4 audio relative-IOI candidate ranking",
        "",
        "Eval-only; no score was edited.",
        "",
        f"- basic gold / draft / uncertain: {summary['goldSelectedCount']} / {summary['draftSelectedCount']} / {len(rows) - summary['readySelectionCount']}",
        f"- selection precision / coverage: {summary['selectionPrecision']} / {summary['selectionCoverage']}",
        f"- basic eval-only gate passed: {summary['evalOnlyGatePassed']}",
        f"- ensemble gold / draft / uncertain: {ensemble_summary['goldSelectedCount']} / {ensemble_summary['draftSelectedCount']} / {len(rows) - ensemble_summary['readySelectionCount']}",
        f"- ensemble precision / coverage: {ensemble_summary['selectionPrecision']} / {ensemble_summary['selectionCoverage']}",
        f"- ensemble eval-only gate passed: {ensemble_summary['evalOnlyGatePassed']}",
        f"- measure rows / evidence-ready: {measure_fixed_summary['rowCount']} / {measure_fixed_summary['evidenceReadyRows']}",
        f"- measure fixed-margin precision / coverage: {measure_fixed_summary['selectionPrecision']} / {measure_fixed_summary['selectionCoverage']}",
        f"- measure LOPO precision / coverage: {measure_lopo['selectionPrecision']} / {measure_lopo['selectionCoverage']}",
        f"- measure LOPO eval-only gate passed: {measure_lopo['evalOnlyGatePassed']}",
        f"- measure onset-ensemble fixed precision / coverage: {measure_ensemble_fixed_summary['selectionPrecision']} / {measure_ensemble_fixed_summary['selectionCoverage']}",
        f"- measure onset-ensemble LOPO precision / coverage: {measure_ensemble_lopo['selectionPrecision']} / {measure_ensemble_lopo['selectionCoverage']}",
        f"- measure onset-ensemble LOPO eval-only gate passed: {measure_ensemble_lopo['evalOnlyGatePassed']}",
        "- measure runtime ready: False",
        "",
        "| piece | basic selection | ensemble selection | basic events | ensemble events |",
        "|---|---|---|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['pieceId']} | {row['selection']} | {row['ensemble']['selection']} | "
            f"{row['basicEventCount']} | {row['ensembleEventCount']} |"
        )
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": not failures,
        "summary": summary,
        "ensembleSummary": ensemble_summary,
        "measureFixedMarginSummary": measure_fixed_summary,
        "measureLeaveOnePieceOut": {
            key: value
            for key, value in measure_lopo.items()
            if key not in {"folds", "predictions"}
        },
        "measureEnsembleFixedMarginSummary": measure_ensemble_fixed_summary,
        "measureEnsembleLeaveOnePieceOut": {
            key: value
            for key, value in measure_ensemble_lopo.items()
            if key not in {"folds", "predictions"}
        },
        "failures": failures,
        "out": str(out),
    }, ensure_ascii=False, indent=2))
    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
