#!/usr/bin/env python3
"""Diagnose protocol-order ambiguity in the real M3+ supplemental takes.

This tool is eval-only. It never rewrites score intent or promotes inferred
ordering to performance gold. The first supported case compares the frozen
M3P-02 whole-cycle repeat with the same performed units grouped by pitch.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path
from typing import Any, Callable

import librosa
import numpy as np

from diagnose_western_strings_round2_trill_vibrato import event_feature_row
from eval_western_strings_m3plus_supplemental import (
    DEFAULT_SOURCE,
    attach_session_pitch_baseline,
    extract_f0,
    evaluate_track,
    infer_modes,
    mode_metrics,
    periodic_pitch_features,
)


REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3plus"
    / "protocol-order-diagnostic"
)
FROZEN_ORDER = (1, 2, 3, 4, 5, 6, 7, 8)
PITCH_GROUPED_ORDER = (1, 5, 2, 6, 3, 7, 4, 8)


def reorder_recording_by_measure(
    recording: dict[str, Any], measure_order: tuple[int, ...]
) -> dict[str, Any]:
    candidate = copy.deepcopy(recording)
    labels = list(candidate.get("labels") or [])
    available = {int(label.get("measure") or 0) for label in labels}
    if available != set(measure_order):
        raise ValueError(
            f"measure order does not cover recording labels: {sorted(available)}"
        )
    candidate["labels"] = [
        label
        for measure in measure_order
        for label in labels
        if int(label.get("measure") or 0) == measure
    ]
    return candidate


def compare_recording_order_candidates(
    source: Path,
    recording: dict[str, Any],
    *,
    f0_backend: str,
    crepe_model: str,
) -> dict[str, Any]:
    times, midi_track, duration = extract_f0(
        source / f"{recording['recordingId']}.m4a",
        backend=f0_backend,
        crepe_model=crepe_model,
    )
    candidates: list[dict[str, Any]] = []
    reports: dict[str, dict[str, Any]] = {}
    for name, order in (
        ("frozen-whole-cycle-repeat", FROZEN_ORDER),
        ("observed-same-pitch-repeat", PITCH_GROUPED_ORDER),
    ):
        candidate = reorder_recording_by_measure(recording, order)
        report = evaluate_track(
            candidate,
            times,
            midi_track,
            duration,
            score_transpose_semitones=float(
                recording.get("localizationTransposeSemitones", 0.0)
            ),
        )
        reports[name] = report
        candidates.append(
            {
                "candidate": name,
                "measureOrder": list(order),
                "status": report["status"],
                **report["localization"],
                "modeMetricsAll": mode_metrics(report["rows"]),
                "unresolvedUnits": [
                    {
                        "unitIndex": row.get("unitIndex"),
                        "measure": row.get("measure"),
                        "expectedBehavior": row.get("expectedBehavior"),
                        "pitchSupportRate": row.get("pitchSupportRate"),
                    }
                    for row in report["rows"]
                    if row.get("localizationUnitReady") is not True
                ],
            }
        )
    best = max(
        candidates,
        key=lambda row: (
            int(row["readyUnitCount"]),
            -float(row["normalizedPathCost"]),
        ),
    )
    return {
        "recordingId": recording.get("recordingId"),
        "evalOnly": True,
        "performanceGoldRelabeled": False,
        "candidates": candidates,
        "bestLocalizationCandidate": best["candidate"],
        "bestReadyUnitCount": best["readyUnitCount"],
        "unitCount": best["unitCount"],
        "bestReportRows": compact_feature_rows(reports[best["candidate"]]["rows"]),
        "_bestRows": reports[best["candidate"]]["rows"],
    }


def _finite_feature(row: dict[str, Any], name: str) -> float | None:
    value = (row.get("modeDiagnostics") or {}).get(name)
    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _periodic_rate_in_band(row: dict[str, Any]) -> float | None:
    rate = _finite_feature(row, "periodicDominantRateHz")
    return None if rate is None else float(4.0 <= rate <= 12.0)


def _trill_switch_support(row: dict[str, Any]) -> float | None:
    switches = _finite_feature(row, "knownPitchSwitchCount")
    upper = _finite_feature(row, "knownUpperFrameRatio")
    if switches is None or upper is None:
        return None
    return switches * upper


def _known_switch_plus_chroma(row: dict[str, Any]) -> float | None:
    switches = _finite_feature(row, "knownPitchSwitchCount")
    chroma_switch_rate = _finite_feature(row, "chromaSwitchRateHz")
    if switches is None or chroma_switch_rate is None:
        return None
    return switches + chroma_switch_rate


def _relative_activity_minimum(row: dict[str, Any]) -> float | None:
    amplitude_delta = _finite_feature(row, "relativeAmplitudeDeltaCents")
    band_delta = _finite_feature(row, "relativeBandEnergyDelta4To8Hz")
    if amplitude_delta is None or band_delta is None:
        return None
    return min(amplitude_delta / 8.0, band_delta / 0.10)


def _absolute_feature(row: dict[str, Any], name: str) -> float | None:
    value = _finite_feature(row, name)
    return abs(value) if value is not None else None


def _early_ornament_seconds(row: dict[str, Any]) -> float | None:
    seconds = _finite_feature(row, "ornamentUpperSeconds")
    offset = _finite_feature(row, "ornamentFirstUpperOffsetSeconds")
    if seconds is None:
        return None
    return seconds if offset is not None and offset <= 0.15 else 0.0


FEATURES: dict[str, dict[str, Callable[[dict[str, Any]], float | None]]] = {
    "vibrato": {
        "periodicAmplitudeCents": lambda row: _finite_feature(
            row, "periodicAmplitudeCents"
        ),
        "periodicBandEnergyRatio4To8Hz": lambda row: _finite_feature(
            row, "periodicBandEnergyRatio4To8Hz"
        ),
        "periodicAutocorrelationPeak4To8Hz": lambda row: _finite_feature(
            row, "periodicAutocorrelationPeak4To8Hz"
        ),
        "relativeAutocorrelationPeakDelta4To8Hz": lambda row: _finite_feature(
            row, "relativeAutocorrelationPeakDelta4To8Hz"
        ),
        "autocorrelationAmplitudeProduct": lambda row: (
            _finite_feature(row, "periodicAutocorrelationPeak4To8Hz")
            * _finite_feature(row, "periodicAmplitudeCents")
            if _finite_feature(row, "periodicAutocorrelationPeak4To8Hz") is not None
            and _finite_feature(row, "periodicAmplitudeCents") is not None
            else None
        ),
        "harmonicRidgeAmplitudeCents": lambda row: _finite_feature(
            row, "harmonicRidgeAmplitudeCents"
        ),
        "harmonicRidgeBandEnergyRatio4To8Hz": lambda row: _finite_feature(
            row, "harmonicRidgeBandEnergyRatio4To8Hz"
        ),
        "harmonicRidgeAutocorrelationPeak4To8Hz": lambda row: _finite_feature(
            row, "harmonicRidgeAutocorrelationPeak4To8Hz"
        ),
        "harmonicRidgeAmplitudeAutocorrelationProduct": lambda row: (
            _finite_feature(row, "harmonicRidgeAmplitudeCents")
            * _finite_feature(row, "harmonicRidgeAutocorrelationPeak4To8Hz")
            if _finite_feature(row, "harmonicRidgeAmplitudeCents") is not None
            and _finite_feature(row, "harmonicRidgeAutocorrelationPeak4To8Hz")
            is not None
            else None
        ),
        "periodicRateIn4To12Hz": _periodic_rate_in_band,
        "relativeAmplitudeDeltaCents": lambda row: _finite_feature(
            row, "relativeAmplitudeDeltaCents"
        ),
        "relativeBandEnergyDelta4To8Hz": lambda row: _finite_feature(
            row, "relativeBandEnergyDelta4To8Hz"
        ),
        "relativeActivityMinimum": _relative_activity_minimum,
    },
    "trill": {
        "knownPitchSwitchCount": lambda row: _finite_feature(
            row, "knownPitchSwitchCount"
        ),
        "knownUpperFrameRatio": lambda row: _finite_feature(
            row, "knownUpperFrameRatio"
        ),
        "knownPairSwitchRateHz": lambda row: _finite_feature(
            row, "knownPairSwitchRateHz"
        ),
        "switchUpperProduct": _trill_switch_support,
        "chromaSwitchRateHz": lambda row: _finite_feature(
            row, "chromaSwitchRateHz"
        ),
        "secondaryChromaRatio": lambda row: _finite_feature(
            row, "secondaryChromaRatio"
        ),
        "onsetPeakRateHz": lambda row: _finite_feature(
            row, "onsetPeakRateHz"
        ),
        "knownSwitchPlusChroma": _known_switch_plus_chroma,
    },
    "ornament": {
        "knownUpperFrameRatio": lambda row: _finite_feature(
            row, "knownUpperFrameRatio"
        ),
        "knownUpperBoutCount": lambda row: _finite_feature(
            row, "knownUpperBoutCount"
        ),
        "ornamentUpperSeconds": lambda row: _finite_feature(
            row, "ornamentUpperSeconds"
        ),
        "earlyOrnamentUpperSeconds": _early_ornament_seconds,
    },
    "slide": {
        "positiveNetMotionSemitones": lambda row: _finite_feature(
            row, "knownPairNetMotionSemitones"
        ),
        "absoluteNetMotionSemitones": lambda row: _absolute_feature(
            row, "knownPairNetMotionSemitones"
        ),
        "knownPairMonotonicity": lambda row: _finite_feature(
            row, "knownPairMonotonicity"
        ),
        "knownPairDirectionalStepRate": lambda row: _finite_feature(
            row, "knownPairDirectionalStepRate"
        ),
        "knownPairTransitionSeconds": lambda row: _finite_feature(
            row, "knownPairTransitionSeconds"
        ),
    },
}


def attach_audio_window_features(
    audio_path: Path,
    rows: list[dict[str, Any]],
) -> None:
    """Attach score-window chroma/onset evidence without changing decisions."""

    waveform, sample_rate = librosa.load(str(audio_path), sr=22050, mono=True)
    hop_length = 256
    onset_envelope = librosa.onset.onset_strength(
        y=waveform,
        sr=sample_rate,
        hop_length=hop_length,
    )
    chroma = librosa.feature.chroma_cqt(
        y=waveform,
        sr=sample_rate,
        hop_length=hop_length,
    )
    frame_count = min(int(onset_envelope.size), int(chroma.shape[1]))
    onset_envelope = np.asarray(onset_envelope[:frame_count], dtype=np.float64)
    chroma = np.asarray(chroma[:, :frame_count], dtype=np.float64)
    frame_times = librosa.frames_to_time(
        np.arange(frame_count),
        sr=sample_rate,
        hop_length=hop_length,
    )
    stft = np.abs(
        librosa.stft(
            waveform,
            n_fft=8192,
            win_length=4096,
            hop_length=hop_length,
        )
    )
    stft_frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=8192)
    for row in rows:
        features = event_feature_row(
            [],
            onset_envelope,
            chroma,
            frame_times,
            float(row.get("startSeconds") or 0.0),
            float(row.get("endSeconds") or 0.0),
        )
        diagnostics = row.setdefault("modeDiagnostics", {})
        diagnostics.update(features)
        base_midi = row.get("baseMidi")
        if base_midi is None:
            continue
        frame_mask = (frame_times >= float(row.get("startSeconds") or 0.0)) & (
            frame_times <= float(row.get("endSeconds") or 0.0)
        )
        selected_frames = np.flatnonzero(frame_mask)
        ridge_times: list[float] = []
        ridge_midi: list[float] = []
        base_hz = float(librosa.midi_to_hz(float(base_midi)))
        for frame_index in selected_frames:
            harmonic_cents: list[float] = []
            for harmonic in range(1, 5):
                expected_hz = base_hz * harmonic
                if expected_hz >= sample_rate / 2.0:
                    break
                low_hz = expected_hz * (2.0 ** (-1.0 / 12.0))
                high_hz = expected_hz * (2.0 ** (1.0 / 12.0))
                band_indexes = np.flatnonzero(
                    (stft_frequencies >= low_hz) & (stft_frequencies <= high_hz)
                )
                if band_indexes.size == 0:
                    continue
                band_values = stft[band_indexes, frame_index]
                peak_offset = int(np.argmax(band_values))
                peak_magnitude = float(band_values[peak_offset])
                if not math.isfinite(peak_magnitude) or peak_magnitude <= 1e-8:
                    continue
                peak_hz = float(stft_frequencies[band_indexes[peak_offset]]) / harmonic
                harmonic_cents.append(1200.0 * math.log2(peak_hz / base_hz))
            if harmonic_cents:
                ridge_times.append(float(frame_times[frame_index]))
                ridge_midi.append(float(base_midi) + float(np.median(harmonic_cents)) / 100.0)
        ridge = periodic_pitch_features(
            np.asarray(ridge_times, dtype=np.float64),
            np.asarray(ridge_midi, dtype=np.float64),
            center_midi=float(base_midi),
        )
        diagnostics.update(
            {
                "harmonicRidgeFrameCount": len(ridge_midi),
                "harmonicRidgeAmplitudeCents": ridge["periodicAmplitudeCents"],
                "harmonicRidgeDominantRateHz": ridge["periodicDominantRateHz"],
                "harmonicRidgeBandEnergyRatio4To8Hz": ridge[
                    "periodicBandEnergyRatio4To8Hz"
                ],
                "harmonicRidgeAutocorrelationPeak4To8Hz": ridge[
                    "periodicAutocorrelationPeak4To8Hz"
                ],
                "harmonicRidgeAutocorrelationRateHz": ridge[
                    "periodicAutocorrelationRateHz"
                ],
            }
        )


def refine_vibrato_trill_boundaries(
    report: dict[str, Any],
    times: np.ndarray,
    midi_track: np.ndarray,
    *,
    pitch_tolerance_cents: float = 100.0,
) -> dict[str, Any]:
    """Move pair boundaries to the first sustained upper-note evidence.

    The written protocol fixes each pair as vibrato followed by trill.  This
    refinement only changes their shared boundary and never changes labels.
    Pairs without upper-note evidence retain the original boundary.
    """

    refined = copy.deepcopy(report)
    rows = refined.get("rows") or []
    refinements: list[dict[str, Any]] = []
    tolerance = max(0.1, float(pitch_tolerance_cents) / 100.0)
    for index in range(0, len(rows) - 1, 2):
        vibrato = rows[index]
        trill = rows[index + 1]
        if (
            vibrato.get("expectedBehavior") != "vibrato"
            or trill.get("expectedBehavior") != "trill"
            or trill.get("auxiliaryMidi") is None
        ):
            continue
        pair_start = float(vibrato.get("startSeconds") or 0.0)
        original_boundary = float(vibrato.get("endSeconds") or pair_start)
        pair_end = float(trill.get("endSeconds") or original_boundary)
        valid = (
            np.isfinite(times)
            & np.isfinite(midi_track)
            & (times >= pair_start)
            & (times <= pair_end)
        )
        local_times = np.asarray(times[valid], dtype=np.float64)
        local_midi = np.asarray(midi_track[valid], dtype=np.float64)
        if local_times.size < 12:
            continue
        base = float(trill["baseMidi"])
        auxiliary = float(trill["auxiliaryMidi"])
        base_distance = np.abs(local_midi - base)
        upper_distance = np.abs(local_midi - auxiliary)
        supported = np.minimum(base_distance, upper_distance) <= tolerance
        upper = supported & (upper_distance < base_distance)
        first_upper_index: int | None = None
        for candidate_index in np.flatnonzero(upper):
            stop = min(upper.size, int(candidate_index) + 5)
            if int(np.sum(upper[int(candidate_index) : stop])) >= 2:
                first_upper_index = int(candidate_index)
                break
        if first_upper_index is None:
            refinements.append(
                {
                    "measure": trill.get("measure"),
                    "changed": False,
                    "reason": "no-sustained-upper-note-evidence",
                    "originalBoundarySeconds": round(original_boundary, 6),
                }
            )
            continue
        proposed = float(local_times[first_upper_index]) - 0.12
        minimum_boundary = pair_start + 0.40
        maximum_boundary = pair_end - 0.40
        if minimum_boundary >= maximum_boundary:
            continue
        boundary = float(np.clip(proposed, minimum_boundary, maximum_boundary))
        for row, start, end in (
            (vibrato, pair_start, boundary),
            (trill, boundary, pair_end),
        ):
            row["startSeconds"] = round(start, 6)
            row["endSeconds"] = round(end, 6)
            row["durationSeconds"] = round(end - start, 6)
            predicted, decisions, diagnostics = infer_modes(
                row,
                times,
                midi_track,
                pitch_tolerance_cents=pitch_tolerance_cents,
            )
            row["predictedModes"] = predicted
            row["modeDecisions"] = decisions
            row["modeDiagnostics"] = diagnostics
        refinements.append(
            {
                "measure": trill.get("measure"),
                "changed": abs(boundary - original_boundary) > 1e-6,
                "reason": "first-sustained-upper-note-minus-preroll",
                "originalBoundarySeconds": round(original_boundary, 6),
                "refinedBoundarySeconds": round(boundary, 6),
                "deltaSeconds": round(boundary - original_boundary, 6),
            }
        )
    return {"report": refined, "refinements": refinements}


def _labeled_values(
    rows: list[dict[str, Any]],
    mode: str,
    extractor: Callable[[dict[str, Any]], float | None],
) -> list[tuple[float, bool]]:
    values: list[tuple[float, bool]] = []
    for row in rows:
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


def _threshold_metrics(
    values: list[tuple[float, bool]], threshold: float
) -> dict[str, Any]:
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


def fit_precision_constrained_threshold(
    calibration: list[tuple[float, bool]],
    holdout: list[tuple[float, bool]],
    *,
    min_precision: float = 0.90,
) -> dict[str, Any]:
    thresholds = sorted({value for value, _ in calibration})
    candidates: list[tuple[float, dict[str, Any]]] = []
    for threshold in thresholds:
        metrics = _threshold_metrics(calibration, threshold)
        precision = metrics["precision"]
        if precision is not None and precision >= min_precision:
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
        key=lambda item: (
            float(item[1]["recall"] or 0.0),
            -item[0],
        ),
    )
    return {
        "fitReady": True,
        "threshold": round(float(threshold), 6),
        "calibrationCount": len(calibration),
        "holdoutCount": len(holdout),
        "calibration": calibration_metrics,
        "holdout": _threshold_metrics(holdout, threshold),
    }


def feature_audit(rows: list[dict[str, Any]]) -> dict[str, Any]:
    calibration_rows = [
        row for row in rows if row.get("evaluationSplit") == "calibration"
    ]
    holdout_rows = [row for row in rows if row.get("evaluationSplit") == "holdout"]
    result: dict[str, Any] = {}
    for mode, feature_map in FEATURES.items():
        result[mode] = {}
        for name, extractor in feature_map.items():
            calibration = _labeled_values(calibration_rows, mode, extractor)
            holdout = _labeled_values(holdout_rows, mode, extractor)
            feature_result = fit_precision_constrained_threshold(calibration, holdout)
            feature_result["calibrationClassCounts"] = {
                "positive": sum(positive for _, positive in calibration),
                "negative": sum(not positive for _, positive in calibration),
            }
            feature_result["holdoutClassCounts"] = {
                "positive": sum(positive for _, positive in holdout),
                "negative": sum(not positive for _, positive in holdout),
            }
            holdout_metrics = feature_result.get("holdout") or {}
            feature_result["heldoutGatePassed"] = bool(
                min(
                    *feature_result["calibrationClassCounts"].values(),
                    *feature_result["holdoutClassCounts"].values(),
                )
                >= 4
                and feature_result.get("fitReady") is True
                and float(holdout_metrics.get("precision") or 0.0) >= 0.90
                and float(holdout_metrics.get("recall") or 0.0) >= 0.80
            )
            result[mode][name] = feature_result
    return result


VIBRATO_LINEAR_FEATURES = (
    "periodicAmplitudeCents",
    "periodicBandEnergyRatio4To8Hz",
    "periodicAutocorrelationPeak4To8Hz",
    "harmonicRidgeAmplitudeCents",
    "harmonicRidgeBandEnergyRatio4To8Hz",
    "harmonicRidgeAutocorrelationPeak4To8Hz",
)


def linear_feature_audit(
    rows: list[dict[str, Any]],
    *,
    mode: str = "vibrato",
    feature_names: tuple[str, ...] = VIBRATO_LINEAR_FEATURES,
) -> dict[str, Any]:
    """Fit one fixed L2 logistic model on calibration and score holdout."""

    split_rows: dict[str, list[tuple[list[float], bool]]] = {
        "calibration": [],
        "holdout": [],
    }
    for row in rows:
        split = str(row.get("evaluationSplit") or "")
        if split not in split_rows:
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
        values = [_finite_feature(row, name) for name in feature_names]
        if any(value is None for value in values):
            continue
        split_rows[split].append(
            ([float(value) for value in values if value is not None], mode in positives)
        )
    calibration = split_rows["calibration"]
    holdout = split_rows["holdout"]
    calibration_positives = sum(positive for _, positive in calibration)
    holdout_positives = sum(positive for _, positive in holdout)
    calibration_negatives = len(calibration) - calibration_positives
    holdout_negatives = len(holdout) - holdout_positives
    minimum = min(
        calibration_positives,
        calibration_negatives,
        holdout_positives,
        holdout_negatives,
    )
    if minimum < 4:
        return {
            "fitReady": False,
            "reason": "insufficient-class-rows",
            "featureNames": list(feature_names),
            "calibrationCounts": {
                "positive": calibration_positives,
                "negative": calibration_negatives,
            },
            "holdoutCounts": {
                "positive": holdout_positives,
                "negative": holdout_negatives,
            },
        }

    calibration_x = np.asarray([values for values, _ in calibration], dtype=np.float64)
    calibration_y = np.asarray([positive for _, positive in calibration], dtype=np.float64)
    holdout_x = np.asarray([values for values, _ in holdout], dtype=np.float64)
    mean = np.mean(calibration_x, axis=0)
    scale = np.std(calibration_x, axis=0)
    scale[scale < 1e-9] = 1.0
    train = (calibration_x - mean) / scale
    test = (holdout_x - mean) / scale
    weights = np.zeros(train.shape[1] + 1, dtype=np.float64)
    class_weights = np.where(
        calibration_y > 0.5,
        len(calibration_y) / (2.0 * calibration_positives),
        len(calibration_y) / (2.0 * calibration_negatives),
    )
    design = np.column_stack([np.ones(train.shape[0]), train])
    for _ in range(2000):
        logits = np.clip(design @ weights, -30.0, 30.0)
        probabilities = 1.0 / (1.0 + np.exp(-logits))
        error = class_weights * (probabilities - calibration_y)
        gradient = (design.T @ error) / float(np.sum(class_weights))
        gradient[1:] += 0.10 * weights[1:]
        weights -= 0.05 * gradient

    calibration_probabilities = 1.0 / (
        1.0 + np.exp(-np.clip(design @ weights, -30.0, 30.0))
    )
    holdout_design = np.column_stack([np.ones(test.shape[0]), test])
    holdout_probabilities = 1.0 / (
        1.0 + np.exp(-np.clip(holdout_design @ weights, -30.0, 30.0))
    )
    threshold_result = fit_precision_constrained_threshold(
        list(zip(calibration_probabilities.tolist(), calibration_y.astype(bool).tolist())),
        list(
            zip(
                holdout_probabilities.tolist(),
                [positive for _, positive in holdout],
            )
        ),
    )
    threshold_result.update(
        {
            "model": "fixed-l2-logistic",
            "l2Penalty": 0.10,
            "featureNames": list(feature_names),
            "coefficients": [round(float(value), 6) for value in weights[1:]],
            "intercept": round(float(weights[0]), 6),
            "studentFacing": False,
        }
    )
    holdout_metrics = threshold_result.get("holdout") or {}
    threshold_result["heldoutGatePassed"] = bool(
        threshold_result.get("fitReady") is True
        and float(holdout_metrics.get("precision") or 0.0) >= 0.90
        and float(holdout_metrics.get("recall") or 0.0) >= 0.80
    )
    return threshold_result


def compact_feature_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact = []
    for row in rows:
        diagnostics = row.get("modeDiagnostics") or {}
        features: dict[str, float] = {}
        for feature_map in FEATURES.values():
            for name, extractor in feature_map.items():
                value = extractor(row)
                if value is not None and math.isfinite(float(value)):
                    features[name] = float(value)
        compact.append(
            {
                "unitIndex": row.get("unitIndex"),
                "measure": row.get("measure"),
                "evaluationSplit": row.get("evaluationSplit"),
                "expectedBehavior": row.get("expectedBehavior"),
                "expectedPositiveModes": list(row.get("expectedPositiveModes") or []),
                "expectedNegativeModes": list(row.get("expectedNegativeModes") or []),
                "localizationUnitReady": bool(row.get("localizationUnitReady")),
                "f0QualityReady": bool(diagnostics.get("f0QualityReady")),
                "startSeconds": row.get("startSeconds"),
                "endSeconds": row.get("endSeconds"),
                "features": features,
            }
        )
    return compact


def score_adherence_issue_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Flag strong score/performance conflicts without relabeling performance gold."""

    issues = []
    for row in rows:
        if row.get("expectedBehavior") != "trill":
            continue
        diagnostics = row.get("modeDiagnostics") or {}
        if (
            row.get("localizationUnitReady") is True
            and diagnostics.get("f0QualityReady") is True
            and float(diagnostics.get("knownPitchSwitchCount") or 0.0) == 0.0
            and float(diagnostics.get("knownUpperFrameRatio") or 0.0) < 0.02
            and float(diagnostics.get("chromaSwitchRateHz") or 0.0) == 0.0
        ):
            issues.append(
                {
                    "recordingId": row.get("recordingId"),
                    "unitIndex": row.get("unitIndex"),
                    "measure": row.get("measure"),
                    "evaluationSplit": row.get("evaluationSplit"),
                    "expectedBehavior": "trill",
                    "startSeconds": row.get("startSeconds"),
                    "endSeconds": row.get("endSeconds"),
                    "reason": "expected-trill-has-no-upper-or-switch-evidence",
                    "requiresHumanConfirmationBeforeRelabel": True,
                }
            )
    return issues


def run_diagnostic(
    source: Path,
    *,
    f0_backend: str = "crepe",
    crepe_model: str = "tiny",
) -> dict[str, Any]:
    intent = json.loads((source / "score-intent.json").read_text(encoding="utf-8"))
    recordings = {
        str(recording.get("recordingId")): recording
        for recording in intent.get("recordings") or []
    }
    recording = recordings.get("m3p-02")
    straight = recordings.get("m3p-01")
    if recording is None or straight is None:
        raise ValueError("score intent must contain m3p-01 and m3p-02")
    remaining_localization_candidates = [
        compare_recording_order_candidates(
            source,
            recordings[recording_id],
            f0_backend=f0_backend,
            crepe_model=crepe_model,
        )
        for recording_id in ("m3p-03", "m3p-04")
        if recordings.get(recording_id) is not None
    ]
    times, midi_track, duration = extract_f0(
        source / "m3p-02.m4a", backend=f0_backend, crepe_model=crepe_model
    )
    candidates = []
    candidate_reports: dict[str, dict[str, Any]] = {}
    for name, order in (
        ("frozen-whole-cycle-repeat", FROZEN_ORDER),
        ("observed-same-pitch-repeat", PITCH_GROUPED_ORDER),
    ):
        candidate = reorder_recording_by_measure(recording, order)
        report = evaluate_track(
            candidate,
            times,
            midi_track,
            duration,
            score_transpose_semitones=float(
                recording.get("localizationTransposeSemitones", 0.0)
            ),
        )
        candidate_reports[name] = report
        candidates.append(
            {
                "candidate": name,
                "measureOrder": list(order),
                "status": report["status"],
                **report["localization"],
                "modeMetricsAll": mode_metrics(report["rows"]),
            }
        )

    straight_times, straight_midi, straight_duration = extract_f0(
        source / "m3p-01.m4a", backend=f0_backend, crepe_model=crepe_model
    )
    straight_report = evaluate_track(
        straight,
        straight_times,
        straight_midi,
        straight_duration,
        score_transpose_semitones=float(
            straight.get("localizationTransposeSemitones", 0.0)
        ),
    )
    attach_audio_window_features(source / "m3p-01.m4a", straight_report["rows"])
    observed_report = candidate_reports["observed-same-pitch-repeat"]
    attach_audio_window_features(source / "m3p-02.m4a", observed_report["rows"])
    session_pitch_baseline = attach_session_pitch_baseline(
        [straight_report, observed_report]
    )
    boundary_refinement = refine_vibrato_trill_boundaries(
        observed_report,
        times,
        midi_track,
    )
    refined_report = boundary_refinement["report"]
    attach_audio_window_features(source / "m3p-02.m4a", refined_report["rows"])
    refined_straight_report = copy.deepcopy(straight_report)
    refined_session_pitch_baseline = attach_session_pitch_baseline(
        [refined_straight_report, refined_report]
    )
    refined_audit_rows = refined_straight_report["rows"] + refined_report["rows"]
    remaining_mode_feature_audits: dict[str, Any] = {}
    for candidate in remaining_localization_candidates:
        recording_id = str(candidate.get("recordingId") or "")
        mode = "ornament" if recording_id == "m3p-03" else "slide"
        combined_rows = straight_report["rows"] + list(candidate.get("_bestRows") or [])
        remaining_mode_feature_audits[recording_id] = {
            "mode": mode,
            "straightNegativeSource": "m3p-01",
            "audit": feature_audit(combined_rows)[mode],
        }
        candidate.pop("_bestRows", None)
    audit_rows = straight_report["rows"] + observed_report["rows"]
    score_adherence_issues = score_adherence_issue_candidates(observed_report["rows"])
    expected_trill_rows = [
        row
        for row in observed_report["rows"]
        if str(row.get("expectedBehavior") or "") == "trill"
    ]
    best = max(
        candidates,
        key=lambda row: (
            int(row["readyUnitCount"]),
            -float(row["normalizedPathCost"]),
        ),
    )
    return {
        "schemaVersion": 1,
        "purpose": "M3+ protocol-order and scalar-feature separability diagnostic",
        "evalOnly": True,
        "studentFacing": False,
        "performanceGoldReady": False,
        "postHocProtocolInference": True,
        "f0Backend": f0_backend,
        "crepeModel": crepe_model if f0_backend == "crepe" else None,
        "recordingId": "m3p-02",
        "remainingLocalizationCandidates": remaining_localization_candidates,
        "remainingModeFeatureAudits": remaining_mode_feature_audits,
        "candidates": candidates,
        "bestLocalizationCandidate": best["candidate"],
        "sessionPitchBaseline": session_pitch_baseline,
        "featureAudit": feature_audit(audit_rows),
        "multivariateAudit": linear_feature_audit(audit_rows),
        "boundaryRefinementAudit": {
            "method": "first-sustained-upper-note-minus-120ms-preroll",
            "evalOnly": True,
            "studentFacing": False,
            "refinements": boundary_refinement["refinements"],
            "sessionPitchBaseline": refined_session_pitch_baseline,
            "featureAudit": feature_audit(refined_audit_rows),
            "multivariateAudit": linear_feature_audit(refined_audit_rows),
            "observedFeatureRows": compact_feature_rows(refined_report["rows"]),
        },
        "observedFeatureRows": compact_feature_rows(observed_report["rows"]),
        "scoreAdherenceIssueCandidates": score_adherence_issues,
        "scoreAdherenceSummary": {
            "expectedTrillUnitCount": len(expected_trill_rows),
            "trillUnitsWithExecutionEvidence": max(
                0, len(expected_trill_rows) - len(score_adherence_issues)
            ),
            "issueCandidateCount": len(score_adherence_issues),
            "formalMetricRelabeled": False,
            "ownerConfirmationRequired": bool(score_adherence_issues),
        },
        "decision": (
            "protocol-order-explains-localization-but-not-technique-evidence"
            if best["candidate"] == "observed-same-pitch-repeat"
            and int(best["readyUnitCount"]) == int(best["unitCount"])
            else "protocol-order-not-resolved"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--f0-backend", choices=("crepe", "pyin"), default="crepe")
    parser.add_argument("--crepe-model", choices=("tiny", "full"), default="tiny")
    args = parser.parse_args()
    report = run_diagnostic(
        args.source.resolve(),
        f0_backend=str(args.f0_backend),
        crepe_model=str(args.crepe_model),
    )
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "protocol-order-diagnostic.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({**report, "artifact": str(report_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
