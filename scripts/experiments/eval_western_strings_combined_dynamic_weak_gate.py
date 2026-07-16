#!/usr/bin/env python3
"""Evaluate a dynamic-timing AND local-energy gate on public waveform errors.

The energy model and every operating point are selected on the development
performer only. The unseen-performer holdout is evaluated once. This remains
eval-only because both the note times and errors are synthetic/public evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import librosa
import numpy as np


REPO = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import eval_western_bach_violin_weak_note_gate as weak  # noqa: E402
import eval_western_strings_dynamic_perturbation_gate as dynamic  # noqa: E402
from eval_western_bach_violin_basic_pitch_transcription import load_reference_rows  # noqa: E402
from eval_western_bach_violin_error_perturbations import DEVELOPMENT_SPLIT, HOLDOUT_SPLIT, build_event_index  # noqa: E402
from eval_western_bach_violin_raw_audio_perturbations import (  # noqa: E402
    PERTURBATION_VERSION,
    SCENARIOS,
    add_gold_offsets,
    read_candidate_rows,
    select_split_units,
)


DEFAULT_OUT = REPO / "data/experiments/western-strings-m3/dynamic-weak-combined-gate/report.json"
DEFAULT_FROZEN_DYNAMIC_GATE = (
    REPO / "data/experiments/western-strings-m3/dynamic-perturbation-gate/report.json"
)
RELEASE_COVERAGE_FLOOR = 0.20


def file_descriptor(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
    }


def cache_fingerprint(
    grouped: dict[str, list[dict[str, Any]]],
    sources: dict[str, dict[str, Any]],
    raw_dir: Path,
) -> str:
    descriptors: list[dict[str, Any]] = []
    for unit in sorted(grouped):
        descriptors.append(file_descriptor(REPO / str(sources[unit]["audioPath"])))
        descriptors.append(
            file_descriptor(raw_dir / "audio" / f"{unit}-weak-note-{PERTURBATION_VERSION}.wav")
        )
        descriptors.append({"unit": unit, "rowCount": len(grouped[unit])})
    encoded = json.dumps(descriptors, sort_keys=True, ensure_ascii=True).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()


def unit_reference_rms(waveform: np.ndarray, sample_rate: int) -> float:
    values = weak.frame_rms_values(
        waveform,
        sample_rate,
        0.0,
        len(waveform) / sample_rate,
    )
    return float(np.median(values)) if values else weak.rms(waveform)


def build_all_note_energy_features(
    grouped: dict[str, list[dict[str, Any]]],
    events_by_scenario: dict[str, dict[str, list[dict[str, Any]]]],
    sources: dict[str, dict[str, Any]],
    raw_dir: Path,
) -> tuple[list[tuple[str, int]], np.ndarray, np.ndarray]:
    keys: list[tuple[str, int]] = []
    clean_features: list[list[float]] = []
    weak_features: list[list[float]] = []
    for unit in sorted(grouped):
        clean_waveform, sample_rate = librosa.load(
            str(REPO / str(sources[unit]["audioPath"])),
            sr=22050,
            mono=True,
        )
        weak_waveform, weak_sample_rate = librosa.load(
            str(raw_dir / "audio" / f"{unit}-weak-note-{PERTURBATION_VERSION}.wav"),
            sr=22050,
            mono=True,
        )
        if sample_rate != weak_sample_rate:
            raise RuntimeError(f"sample-rate-mismatch:{unit}")
        clean_rms = unit_reference_rms(clean_waveform, sample_rate)
        weak_rms = unit_reference_rms(weak_waveform, weak_sample_rate)
        clean_events = events_by_scenario["clean"][unit]
        weak_events = events_by_scenario["weak-note"][unit]
        clean_event_index = build_event_index(clean_events)
        weak_event_index = build_event_index(weak_events)
        for row in grouped[unit]:
            keys.append((unit, int(row["noteIndex"])))
            if row.get("predictedTime") is None:
                # Keep unmatched gold notes in the coverage denominator. Their
                # dynamic evidence is incomplete, so they can never auto-pass;
                # the placeholder probability is therefore never consulted.
                missing = [0.0] * len(weak.FEATURE_NAMES)
                clean_features.append(missing)
                weak_features.append(missing)
                continue
            clean_features.append(
                weak.extract_features(
                    clean_waveform,
                    sample_rate,
                    row,
                    clean_events,
                    unit_rms=clean_rms,
                    event_index=clean_event_index,
                )
            )
            weak_features.append(
                weak.extract_features(
                    weak_waveform,
                    weak_sample_rate,
                    row,
                    weak_events,
                    unit_rms=weak_rms,
                    event_index=weak_event_index,
                )
            )
    return keys, np.asarray(clean_features, dtype=np.float64), np.asarray(weak_features, dtype=np.float64)


def load_or_build_energy_features(
    cache_path: Path,
    grouped: dict[str, list[dict[str, Any]]],
    events_by_scenario: dict[str, dict[str, list[dict[str, Any]]]],
    sources: dict[str, dict[str, Any]],
    raw_dir: Path,
) -> tuple[list[tuple[str, int]], np.ndarray, np.ndarray, bool]:
    fingerprint = cache_fingerprint(grouped, sources, raw_dir)
    if cache_path.is_file():
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
            if payload.get("schemaVersion") == 1 and payload.get("fingerprint") == fingerprint:
                keys = [(str(row[0]), int(row[1])) for row in payload["keys"]]
                clean = np.asarray(payload["cleanFeatures"], dtype=np.float64)
                weak_rows = np.asarray(payload["weakFeatures"], dtype=np.float64)
                if clean.shape == weak_rows.shape == (len(keys), len(weak.FEATURE_NAMES)):
                    return keys, clean, weak_rows, True
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            pass
    keys, clean, weak_rows = build_all_note_energy_features(
        grouped,
        events_by_scenario,
        sources,
        raw_dir,
    )
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "fingerprint": fingerprint,
                "featureNames": list(weak.FEATURE_NAMES),
                "keys": keys,
                "cleanFeatures": clean.tolist(),
                "weakFeatures": weak_rows.tolist(),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return keys, clean, weak_rows, False


def dynamic_selected(row: dict[str, Any], point: dict[str, Any]) -> bool:
    relative_floor = point.get("minRelativeEventConfidence")
    same_pitch_floor = point.get("minSamePitchScoreDistanceQuarters")
    nearest_same_pitch = row.get("nearestSamePitchScoreDistanceQuarters")
    return bool(
        row.get("pitchDistanceSemitones") == 0
        and row.get("eventConfidence") is not None
        and float(row["eventConfidence"]) >= float(point["minEventConfidence"])
        and row.get("relativeIoiDeviationRatio") is not None
        and float(row["relativeIoiDeviationRatio"]) <= float(point["deviationLimit"])
        and row.get("eventDurationSeconds") is not None
        and float(row["eventDurationSeconds"]) >= float(point["minEventDurationSeconds"])
        and (
            same_pitch_floor is None
            or (
                "nearestSamePitchScoreDistanceQuarters" in row
                and (
                    nearest_same_pitch is None
                    or float(nearest_same_pitch) >= float(same_pitch_floor)
                )
            )
        )
        and (
            relative_floor is None
            or (
                row.get("relativeEventConfidence") is not None
                and float(row["relativeEventConfidence"]) >= float(relative_floor)
            )
        )
    )


def combined_metrics(
    rows: list[dict[str, Any]],
    probabilities: dict[tuple[str, int], float],
    point: dict[str, Any],
    energy_threshold: float,
) -> dict[str, Any]:
    selected = [
        row
        for row in rows
        if dynamic_selected(row, point)
        and probabilities.get((str(row["unit"]), int(row["noteIndex"])), -1.0) >= energy_threshold
    ]
    correct = sum(
        row.get("onsetErrorSeconds") is not None
        and float(row["onsetErrorSeconds"]) <= 0.30
        for row in selected
    )
    targets = sum(bool(row.get("target")) for row in rows)
    unsafe = sum(bool(row.get("target")) for row in selected)
    unsafe_targets = [
        {
            "unit": str(row["unit"]),
            "noteIndex": int(row["noteIndex"]),
            "midi": int(row["midi"]) if row.get("midi") is not None else None,
            "goldTime": row.get("goldTime"),
            "predictedTime": row.get("predictedTime"),
            "onsetErrorSeconds": row.get("onsetErrorSeconds"),
            "eventConfidence": row.get("eventConfidence"),
            "relativeIoiDeviationRatio": row.get("relativeIoiDeviationRatio"),
            "relativeEventConfidence": row.get("relativeEventConfidence"),
            "eventDurationSeconds": row.get("eventDurationSeconds"),
            "energyProbability": probabilities.get(
                (str(row["unit"]), int(row["noteIndex"]))
            ),
        }
        for row in selected
        if row.get("target")
    ]
    return {
        "noteCount": len(rows),
        "selectedCount": len(selected),
        "correctWithin300msCount": correct,
        "precisionWithin300ms": correct / len(selected) if selected else None,
        "coverage": len(selected) / len(rows) if rows else 0.0,
        "targetCount": targets,
        "unsafeTargetAutoPassCount": unsafe,
        "unsafeTargetAutoPassRate": unsafe / targets if targets else 0.0,
        "unsafeTargets": unsafe_targets,
    }


def intersection_probabilities(
    keys: list[tuple[str, int]],
    probabilities_by_model: dict[str, dict[tuple[str, int], float]],
    thresholds: dict[str, float],
) -> dict[tuple[str, int], float]:
    """Return one only when every development-calibrated model accepts."""
    if not probabilities_by_model or set(probabilities_by_model) != set(thresholds):
        raise ValueError("energy-model-probabilities-and-thresholds-must-match")
    return {
        key: float(
            all(
                probabilities_by_model[model_name].get(key, -1.0) >= thresholds[model_name]
                for model_name in sorted(thresholds)
            )
        )
        for key in keys
    }


def dynamic_metrics(rows: list[dict[str, Any]], point: dict[str, Any]) -> dict[str, Any]:
    selected = [row for row in rows if dynamic_selected(row, point)]
    targets = sum(bool(row.get("target")) for row in rows)
    unsafe = sum(bool(row.get("target")) for row in selected)
    return {
        "targetCount": targets,
        "unsafeTargetAutoPassCount": unsafe,
        "unsafeTargetAutoPassRate": unsafe / targets if targets else 0.0,
    }


def evaluate_point(
    dynamic_rows: dict[str, list[dict[str, Any]]],
    clean_probabilities: dict[tuple[str, int], float],
    weak_probabilities: dict[tuple[str, int], float],
    point: dict[str, Any],
    energy_threshold: float,
) -> dict[str, Any]:
    clean = combined_metrics(dynamic_rows["clean"], clean_probabilities, point, energy_threshold)
    weak_metrics = combined_metrics(dynamic_rows["weak-note"], weak_probabilities, point, energy_threshold)
    core = {
        scenario: dynamic_metrics(dynamic_rows[scenario], point)
        for scenario in SCENARIOS
        if scenario != "weak-note"
    }
    return {
        "clean": clean,
        "weakNote": weak_metrics,
        "coreScenarios": core,
        "allErrorUnsafeTargetAutoPassCount": (
            weak_metrics["unsafeTargetAutoPassCount"]
            + sum(row["unsafeTargetAutoPassCount"] for row in core.values())
        ),
    }


def build_fold(
    split: str,
    raw_dir: Path,
    cache_dir: Path,
    audit: dict[str, Any],
    recognition: dict[str, Any],
    event_gate: dict[str, Any],
    all_rows: list[dict[str, Any]],
    selection_rank: int = 0,
) -> dict[str, Any]:
    event_filter = ((recognition.get("eventFilterCalibration") or {}).get("selected") or {})
    inputs = dynamic.build_fold_inputs(
        split=split,
        perturbation_dir=raw_dir,
        audit=audit,
        all_rows=all_rows,
        min_confidence=float(event_filter.get("minConfidence", 0.38)),
        min_duration=float(event_filter.get("minDurationSeconds", 0.08)),
        neighbor_threshold=float(event_gate.get("selectedThresholdSeconds") or 0.30),
        neighbor_radius=int(event_gate.get("neighborRadius") or 2),
        selection_rank=selection_rank,
    )
    grouped, targets, events_by_scenario = inputs
    sources = {
        str(row["unit"]): row
        for row in select_split_units(audit["rows"], split, selection_rank)
    }
    keys, clean_features, weak_features, cache_hit = load_or_build_energy_features(
        cache_dir
        / (
            f"{split}-all-note-energy-features.json"
            if selection_rank == 0
            else f"{split}-rank{selection_rank}-all-note-energy-features.json"
        ),
        grouped,
        events_by_scenario,
        sources,
        raw_dir,
    )
    broad = dynamic.evaluate_fold(
        grouped,
        targets,
        events_by_scenario,
        deviation_limit=max(dynamic.THRESHOLD_GRID),
        min_event_confidence=min(dynamic.EVENT_CONFIDENCE_GRID),
    )
    rows = {"clean": broad["clean"]["rows"]}
    rows.update({scenario: broad["scenarios"][scenario]["rows"] for scenario in SCENARIOS})
    return {
        "keys": keys,
        "cleanFeatures": clean_features,
        "weakFeatures": weak_features,
        "dynamicRows": rows,
        "cacheHit": cache_hit,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--frozen-dynamic-gate", default=str(DEFAULT_FROZEN_DYNAMIC_GATE))
    args = parser.parse_args()
    out = Path(args.out)
    cache_dir = out.parent / "feature-cache"
    audit = dynamic.load_json(dynamic.DEFAULT_AUDIT)
    recognition = dynamic.load_json(dynamic.DEFAULT_RECOGNITION)
    event_gate = dynamic.load_json(dynamic.DEFAULT_EVENT_GATE)
    frozen_dynamic_report = dynamic.load_json(Path(args.frozen_dynamic_gate))
    frozen_point = ((frozen_dynamic_report.get("jointSafetyProbe") or {}).get("selectedDevelopmentPoint"))
    if not frozen_point:
        raise RuntimeError("frozen-dynamic-development-point-missing")
    all_rows = read_candidate_rows(dynamic.DEFAULT_ROWS)
    add_gold_offsets(all_rows, load_reference_rows(dynamic.REPO / str(audit["datasetRoot"])))

    development_pairs = weak.load_split_examples(
        DEVELOPMENT_SPLIT,
        audit,
        recognition,
        event_gate,
        weak.DEFAULT_ROWS,
        weak.DEFAULT_DEVELOPMENT_RAW,
    )
    development = build_fold(
        DEVELOPMENT_SPLIT,
        dynamic.DEFAULT_DEVELOPMENT,
        cache_dir,
        audit,
        recognition,
        event_gate,
        all_rows,
    )
    development_x = np.asarray([row["features"] for row in development_pairs], dtype=np.float64)
    development_y = np.asarray([row["label"] for row in development_pairs], dtype=np.int64)
    single_model_results: list[dict[str, Any]] = []
    fitted_models: dict[str, Any] = {}
    energy_thresholds: dict[str, float] = {}
    development_clean_probabilities: dict[str, dict[tuple[str, int], float]] = {}
    development_weak_probabilities: dict[str, dict[tuple[str, int], float]] = {}
    for model_name, model in weak.build_models().items():
        model.fit(development_x, development_y)
        paired_probabilities = model.predict_proba(development_x)[:, 1]
        selected_energy = weak.choose_zero_unsafe_threshold(development_pairs, paired_probabilities)
        if selected_energy is None:
            continue
        fitted_models[model_name] = model
        energy_threshold = float(selected_energy["threshold"])
        energy_thresholds[model_name] = energy_threshold
        clean_probabilities = dict(
            zip(development["keys"], model.predict_proba(development["cleanFeatures"])[:, 1])
        )
        weak_probabilities = dict(
            zip(development["keys"], model.predict_proba(development["weakFeatures"])[:, 1])
        )
        development_clean_probabilities[model_name] = clean_probabilities
        development_weak_probabilities[model_name] = weak_probabilities
        single_model_results.append({
            "model": model_name,
            "energyThreshold": energy_threshold,
            **{
                key: frozen_point[key]
                for key in (
                    "deviationLimit",
                    "minEventConfidence",
                    "minRelativeEventConfidence",
                    "minEventDurationSeconds",
                )
            },
            **evaluate_point(
                development["dynamicRows"],
                clean_probabilities,
                weak_probabilities,
                frozen_point,
                energy_threshold,
            ),
        })

    selected = None
    if fitted_models:
        robust_clean_probabilities = intersection_probabilities(
            development["keys"],
            development_clean_probabilities,
            energy_thresholds,
        )
        robust_weak_probabilities = intersection_probabilities(
            development["keys"],
            development_weak_probabilities,
            energy_thresholds,
        )
        metrics = evaluate_point(
            development["dynamicRows"],
            robust_clean_probabilities,
            robust_weak_probabilities,
            frozen_point,
            0.5,
        )
        selected = {
            "energyPolicy": "all-model-intersection",
            "energyThresholds": energy_thresholds,
            **{
                key: frozen_point[key]
                for key in (
                    "deviationLimit",
                    "minEventConfidence",
                    "minRelativeEventConfidence",
                    "minEventDurationSeconds",
                )
            },
            **metrics,
        }

    holdout = None
    safe_fallback_passed = False
    release_coverage_ready = False
    holdout_cache_hit = False
    if selected is not None:
        holdout_fold = build_fold(
            HOLDOUT_SPLIT,
            dynamic.DEFAULT_HOLDOUT,
            cache_dir,
            audit,
            recognition,
            event_gate,
            all_rows,
        )
        holdout_cache_hit = bool(holdout_fold["cacheHit"])
        holdout_clean_by_model = {
            model_name: dict(
                zip(holdout_fold["keys"], model.predict_proba(holdout_fold["cleanFeatures"])[:, 1])
            )
            for model_name, model in fitted_models.items()
        }
        holdout_weak_by_model = {
            model_name: dict(
                zip(holdout_fold["keys"], model.predict_proba(holdout_fold["weakFeatures"])[:, 1])
            )
            for model_name, model in fitted_models.items()
        }
        clean_probabilities = intersection_probabilities(
            holdout_fold["keys"], holdout_clean_by_model, energy_thresholds
        )
        weak_probabilities = intersection_probabilities(
            holdout_fold["keys"], holdout_weak_by_model, energy_thresholds
        )
        holdout = evaluate_point(
            holdout_fold["dynamicRows"],
            clean_probabilities,
            weak_probabilities,
            selected,
            0.5,
        )
        safe_fallback_passed = bool(
            holdout["clean"]["selectedCount"] >= 30
            and holdout["clean"]["precisionWithin300ms"] is not None
            and holdout["clean"]["precisionWithin300ms"] >= 0.90
            and holdout["allErrorUnsafeTargetAutoPassCount"] == 0
        )
        release_coverage_ready = bool(
            safe_fallback_passed
            and holdout["clean"]["coverage"] >= RELEASE_COVERAGE_FLOOR
        )

    report = {
        "ok": True,
        "evidenceType": "previously-frozen-dynamic-plus-development-calibrated-energy-holdout-probe",
        "method": "dynamic-pitch-relative-ioi-and-all-shallow-energy-model-intersection",
        "selectionDiscipline": "dynamic point was frozen by the prior independent sweep; energy thresholds use development-reference-performer only; every energy model must accept",
        "frozenDynamicGateReport": str(Path(args.frozen_dynamic_gate).resolve()),
        "releaseCoverageFloor": RELEASE_COVERAGE_FLOOR,
        "evaluatedModelCount": len(fitted_models),
        "evaluatedDynamicPointCountPerModel": 1,
        "developmentSingleModelResults": single_model_results,
        "selectedDevelopmentPoint": selected,
        "developmentFeatureCacheHit": bool(development["cacheHit"]),
        "holdout": holdout,
        "holdoutFeatureCacheHit": holdout_cache_hit,
        "exploratorySafeFallbackHoldoutPassed": safe_fallback_passed,
        "releaseCoverageReady": release_coverage_ready,
        "publicSyntheticCombinedGateReady": False,
        "studentGateReady": False,
        "blockingReasons": [
            *([] if selected is not None else ["development-combined-policy-not-evaluable"]),
            *([] if safe_fallback_passed else ["holdout-combined-safety-gate-failed"]),
            *([] if release_coverage_ready else ["holdout-clean-coverage-below-release-floor"]),
            "fresh-independent-performer-confirmation-required-after-robustness-policy-change",
            "public-reference-times-are-estimated-not-human-note-level-truth",
            "waveform-errors-are-synthetic-not-real-student-errors",
            "independent-student-note-level-validation-required",
        ],
        "limitations": [
            "energy model is fit on paired synthetic weak-note targets only",
            "core errors are conservatively evaluated without energy-model veto",
            "student runtime remains fail-closed regardless of this public gate",
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if safe_fallback_passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
