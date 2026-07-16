from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from sklearn.ensemble import (
    ExtraTreesClassifier,
    HistGradientBoostingClassifier,
    RandomForestClassifier,
)
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import eval_western_bach_violin_raw_audio_perturbations as raw  # noqa: E402
from eval_western_bach_violin_basic_pitch_transcription import (  # noqa: E402
    filter_events,
    load_reference_rows,
)
from eval_western_bach_violin_error_perturbations import (  # noqa: E402
    DEVELOPMENT_SPLIT,
    HOLDOUT_SPLIT,
    build_event_index,
    nearby_event_indices,
    rows_by_unit,
)


DEFAULT_AUDIT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
DEFAULT_ROWS = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-chord-timing.csv"
DEFAULT_RECOGNITION = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-transcription.json"
DEFAULT_EVENT_GATE = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-error-perturbations.json"
DEFAULT_DEVELOPMENT_RAW = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-raw-audio-perturbations-development"
DEFAULT_HOLDOUT_RAW = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-raw-audio-perturbations"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-weak-note-gate.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-weak-note-gate.md"
FEATURE_NAMES = (
    "rms100VsUnitDb",
    "rms250VsUnitDb",
    "rms100VsLocalDb",
    "rms250VsLocalDb",
    "peak100VsUnitDb",
    "post30To80RmsVsUnitDb",
    "post30To80RmsVsLocalDb",
    "post30To150RmsVsUnitDb",
    "post30To150RmsVsLocalDb",
    "post30To80PeakVsUnitDb",
    "eventConfidence",
    "eventDurationSeconds",
    "eventStartDeltaSeconds",
)


def safe_db_ratio(value: float, reference: float) -> float:
    return float(20.0 * np.log10(max(value, 1e-8) / max(reference, 1e-8)))


def rms(segment: np.ndarray) -> float:
    if not len(segment):
        return 0.0
    return float(np.sqrt(np.mean(np.square(segment, dtype=np.float64))))


def centered_segment(
    waveform: np.ndarray,
    sample_rate: int,
    center_seconds: float,
    duration_seconds: float,
) -> np.ndarray:
    half = duration_seconds / 2.0
    start = max(0, int(round((center_seconds - half) * sample_rate)))
    end = min(len(waveform), int(round((center_seconds + half) * sample_rate)))
    return waveform[start:end]


def bounded_segment(
    waveform: np.ndarray,
    sample_rate: int,
    start_seconds: float,
    end_seconds: float,
) -> np.ndarray:
    start = max(0, int(round(start_seconds * sample_rate)))
    end = min(len(waveform), int(round(end_seconds * sample_rate)))
    return waveform[start:max(start, end)]


def frame_rms_values(
    waveform: np.ndarray,
    sample_rate: int,
    start_seconds: float,
    end_seconds: float,
    excluded_start_seconds: float | None = None,
    excluded_end_seconds: float | None = None,
    frame_seconds: float = 0.10,
) -> list[float]:
    frame_samples = max(1, int(round(frame_seconds * sample_rate)))
    start = max(0, int(round(start_seconds * sample_rate)))
    end = min(len(waveform), int(round(end_seconds * sample_rate)))
    values = []
    for frame_start in range(start, max(start, end - frame_samples + 1), frame_samples):
        frame_end = min(end, frame_start + frame_samples)
        frame_center = (frame_start + frame_end) / (2.0 * sample_rate)
        if (
            excluded_start_seconds is not None
            and excluded_end_seconds is not None
            and excluded_start_seconds <= frame_center <= excluded_end_seconds
        ):
            continue
        values.append(rms(waveform[frame_start:frame_end]))
    return values


def extract_features(
    waveform: np.ndarray,
    sample_rate: int,
    row: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    unit_rms: float | None = None,
    event_index: dict[Any, Any] | None = None,
) -> list[float]:
    predicted_time = float(row["predictedTime"])
    if unit_rms is None:
        unit_values = frame_rms_values(
            waveform,
            sample_rate,
            0.0,
            len(waveform) / sample_rate,
        )
        unit_rms = float(np.median(unit_values)) if unit_values else rms(waveform)
    local_values = frame_rms_values(
        waveform,
        sample_rate,
        predicted_time - 1.5,
        predicted_time + 1.5,
        predicted_time - 0.25,
        predicted_time + 0.25,
    )
    local_rms = float(np.median(local_values)) if local_values else unit_rms
    segment100 = centered_segment(waveform, sample_rate, predicted_time, 0.10)
    segment250 = centered_segment(waveform, sample_rate, predicted_time, 0.25)
    rms100 = rms(segment100)
    rms250 = rms(segment250)
    peak100 = float(np.max(np.abs(segment100))) if len(segment100) else 0.0
    post30_to_80 = bounded_segment(
        waveform,
        sample_rate,
        predicted_time + 0.03,
        predicted_time + 0.08,
    )
    post30_to_150 = bounded_segment(
        waveform,
        sample_rate,
        predicted_time + 0.03,
        predicted_time + 0.15,
    )
    post30_to_80_rms = rms(post30_to_80)
    post30_to_150_rms = rms(post30_to_150)
    post30_to_80_peak = (
        float(np.max(np.abs(post30_to_80))) if len(post30_to_80) else 0.0
    )

    event_index = event_index if event_index is not None else build_event_index(events)
    candidates = nearby_event_indices(
        event_index,
        int(row["midi"]),
        predicted_time,
        0.30,
    )
    if candidates:
        candidate = min(
            (events[index] for index in candidates),
            key=lambda event: abs(float(event["start"]) - predicted_time),
        )
        event_confidence = float(candidate.get("confidence") or 0.0)
        event_duration = max(0.0, float(candidate["end"]) - float(candidate["start"]))
        event_delta = abs(float(candidate["start"]) - predicted_time)
    else:
        event_confidence = 0.0
        event_duration = 0.0
        event_delta = 0.30

    return [
        safe_db_ratio(rms100, unit_rms),
        safe_db_ratio(rms250, unit_rms),
        safe_db_ratio(rms100, local_rms),
        safe_db_ratio(rms250, local_rms),
        safe_db_ratio(peak100, unit_rms),
        safe_db_ratio(post30_to_80_rms, unit_rms),
        safe_db_ratio(post30_to_80_rms, local_rms),
        safe_db_ratio(post30_to_150_rms, unit_rms),
        safe_db_ratio(post30_to_150_rms, local_rms),
        safe_db_ratio(post30_to_80_peak, unit_rms),
        event_confidence,
        event_duration,
        event_delta,
    ]


def load_split_examples(
    split: str,
    audit: dict[str, Any],
    recognition: dict[str, Any],
    event_gate: dict[str, Any],
    rows_path: Path,
    raw_dir: Path,
) -> list[dict[str, Any]]:
    sources = raw.select_split_units(audit["rows"], split)
    source_by_unit = {str(source["unit"]): source for source in sources}
    units = set(source_by_unit)
    rows = [
        row
        for row in raw.read_candidate_rows(rows_path)
        if str(row["unit"]) in units
    ]
    references = load_reference_rows(REPO_ROOT / str(audit["datasetRoot"]))
    raw.add_gold_offsets(rows, references)
    grouped_rows = rows_by_unit(rows)
    selected_filter = ((recognition.get("eventFilterCalibration") or {}).get("selected") or {})
    min_confidence = float(selected_filter.get("minConfidence", 0.38))
    min_duration = float(selected_filter.get("minDurationSeconds", 0.08))
    support_threshold = float(event_gate.get("selectedThresholdSeconds") or 0.30)
    neighbor_radius = int(event_gate.get("neighborRadius") or 2)
    clean_cache = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-cache"
    clean_events = {
        unit: filter_events(
            json.loads((clean_cache / f"{unit}.basic-pitch.json").read_text(encoding="utf-8")),
            min_confidence,
            min_duration,
        )
        for unit in units
    }
    weak_events = {
        unit: filter_events(
            json.loads(
                (
                    raw_dir
                    / "basic-pitch-cache"
                    / f"{unit}-weak-note-{raw.PERTURBATION_VERSION}.basic-pitch.json"
                ).read_text(encoding="utf-8")
            ),
            min_confidence,
            min_duration,
        )
        for unit in units
    }
    targets = raw.select_targets(
        grouped_rows,
        clean_events,
        units,
        support_threshold,
        neighbor_radius,
        8,
        2.0,
        split,
    )
    target_keys = {(str(row["unit"]), int(row["noteIndex"])) for row in targets}
    strict_args = (
        split,
        grouped_rows,
        clean_events,
        raw.DEFAULT_CENTER_THRESHOLD_SECONDS,
        support_threshold,
        neighbor_radius,
        raw.DEFAULT_TARGET_EVENT_CONFIDENCE,
        raw.DEFAULT_SCORE_ISOLATION_SECONDS,
    )
    clean_accepted = {
        (str(row["unit"]), int(row["noteIndex"]))
        for row in raw.strict_accepted_rows(*strict_args)
    }
    weak_accepted = {
        (str(row["unit"]), int(row["noteIndex"]))
        for row in raw.strict_accepted_rows(
            split,
            grouped_rows,
            weak_events,
            raw.DEFAULT_CENTER_THRESHOLD_SECONDS,
            support_threshold,
            neighbor_radius,
            raw.DEFAULT_TARGET_EVENT_CONFIDENCE,
            raw.DEFAULT_SCORE_ISOLATION_SECONDS,
        )
    }

    examples = []
    for unit in sorted(units):
        clean_waveform, sample_rate = librosa.load(
            str(REPO_ROOT / source_by_unit[unit]["audioPath"]),
            sr=22050,
            mono=True,
        )
        weak_waveform, weak_sample_rate = librosa.load(
            str(raw_dir / "audio" / f"{unit}-weak-note-{raw.PERTURBATION_VERSION}.wav"),
            sr=22050,
            mono=True,
        )
        if sample_rate != weak_sample_rate:
            raise RuntimeError(f"sample-rate-mismatch:{unit}")
        clean_unit_values = frame_rms_values(
            clean_waveform,
            sample_rate,
            0.0,
            len(clean_waveform) / sample_rate,
        )
        clean_unit_rms = float(np.median(clean_unit_values)) if clean_unit_values else rms(clean_waveform)
        weak_unit_values = frame_rms_values(
            weak_waveform,
            weak_sample_rate,
            0.0,
            len(weak_waveform) / weak_sample_rate,
        )
        weak_unit_rms = float(np.median(weak_unit_values)) if weak_unit_values else rms(weak_waveform)
        clean_event_index = build_event_index(clean_events[unit])
        weak_event_index = build_event_index(weak_events[unit])
        for target in targets:
            if str(target["unit"]) != unit:
                continue
            key = (unit, int(target["noteIndex"]))
            if key not in target_keys:
                continue
            examples.append(
                {
                    "unit": unit,
                    "noteIndex": key[1],
                    "label": 1,
                    "scenario": "clean",
                    "strictAccepted": key in clean_accepted,
                    "features": extract_features(
                        clean_waveform,
                        sample_rate,
                        target,
                        clean_events[unit],
                        unit_rms=clean_unit_rms,
                        event_index=clean_event_index,
                    ),
                }
            )
            examples.append(
                {
                    "unit": unit,
                    "noteIndex": key[1],
                    "label": 0,
                    "scenario": "weak-note",
                    "strictAccepted": key in weak_accepted,
                    "features": extract_features(
                        weak_waveform,
                        weak_sample_rate,
                        target,
                        weak_events[unit],
                        unit_rms=weak_unit_rms,
                        event_index=weak_event_index,
                    ),
                }
            )
    return examples


def choose_zero_unsafe_threshold(
    examples: list[dict[str, Any]],
    probabilities: np.ndarray,
    minimum_clean_targets: int = 30,
) -> dict[str, Any] | None:
    thresholds = sorted({0.0, 1.0, *(float(value) for value in probabilities)})
    candidates = []
    for threshold in thresholds:
        clean = sum(
            example["label"] == 1
            and example["strictAccepted"]
            and float(probability) >= threshold
            for example, probability in zip(examples, probabilities)
        )
        unsafe = sum(
            example["label"] == 0
            and example["strictAccepted"]
            and float(probability) >= threshold
            for example, probability in zip(examples, probabilities)
        )
        if clean >= minimum_clean_targets and unsafe == 0:
            candidates.append(
                {
                    "threshold": threshold,
                    "cleanAutoPassCount": clean,
                    "unsafeWeakAutoPassCount": unsafe,
                }
            )
    return max(candidates, key=lambda item: item["cleanAutoPassCount"]) if candidates else None


def evaluate_threshold(
    examples: list[dict[str, Any]],
    probabilities: np.ndarray,
    threshold: float,
) -> dict[str, Any]:
    clean_eligible = sum(example["label"] == 1 and example["strictAccepted"] for example in examples)
    weak_eligible = sum(example["label"] == 0 and example["strictAccepted"] for example in examples)
    clean_auto = sum(
        example["label"] == 1
        and example["strictAccepted"]
        and float(probability) >= threshold
        for example, probability in zip(examples, probabilities)
    )
    weak_unsafe = sum(
        example["label"] == 0
        and example["strictAccepted"]
        and float(probability) >= threshold
        for example, probability in zip(examples, probabilities)
    )
    return {
        "cleanStrictEligible": clean_eligible,
        "weakStrictEligible": weak_eligible,
        "cleanAutoPassCount": clean_auto,
        "cleanRetention": clean_auto / clean_eligible if clean_eligible else None,
        "unsafeWeakAutoPassCount": weak_unsafe,
        "unsafeWeakAutoPassRate": weak_unsafe / weak_eligible if weak_eligible else 0.0,
    }


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Bach Violin Weak-Note Public Raw-Audio Gate",
            "",
            "The model is fit only on reference-performer development recordings and frozen before unseen-performer evaluation.",
            "It uses single-recording energy/context and Basic Pitch evidence; it never compares against an unmutated source at inference time.",
            "",
            f"- model results: {report.get('modelResults')}",
            f"- weakNotePublicRawAudioGateReady: {str(report.get('weakNotePublicRawAudioGateReady', False)).lower()}",
            "",
        ]
    )


def build_models() -> dict[str, Any]:
    return {
        "logistic-regression": Pipeline(
            [
                ("scale", StandardScaler()),
                (
                    "classifier",
                    LogisticRegression(
                        C=0.5,
                        class_weight="balanced",
                        max_iter=2000,
                        random_state=7,
                    ),
                ),
            ]
        ),
        "random-forest": RandomForestClassifier(
            n_estimators=500,
            max_depth=3,
            min_samples_leaf=4,
            class_weight="balanced",
            random_state=7,
            n_jobs=2,
        ),
        "extra-trees": ExtraTreesClassifier(
            n_estimators=500,
            max_depth=3,
            min_samples_leaf=4,
            class_weight="balanced",
            random_state=7,
            n_jobs=2,
        ),
        "hist-gradient-boosting": HistGradientBoostingClassifier(
            max_depth=2,
            max_iter=150,
            learning_rate=0.05,
            l2_regularization=1.0,
            random_state=7,
        ),
        "rbf-svm": Pipeline(
            [
                ("scale", StandardScaler()),
                (
                    "classifier",
                    SVC(
                        C=1.0,
                        kernel="rbf",
                        gamma="scale",
                        class_weight="balanced",
                        probability=True,
                        random_state=7,
                    ),
                ),
            ]
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fit and freeze a weak-note confidence gate on public Bach raw-audio perturbations.")
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--rows", default=str(DEFAULT_ROWS))
    parser.add_argument("--recognition", default=str(DEFAULT_RECOGNITION))
    parser.add_argument("--event-gate", default=str(DEFAULT_EVENT_GATE))
    parser.add_argument("--development-raw", default=str(DEFAULT_DEVELOPMENT_RAW))
    parser.add_argument("--holdout-raw", default=str(DEFAULT_HOLDOUT_RAW))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
    recognition = json.loads(Path(args.recognition).read_text(encoding="utf-8"))
    event_gate = json.loads(Path(args.event_gate).read_text(encoding="utf-8"))
    development = load_split_examples(
        DEVELOPMENT_SPLIT,
        audit,
        recognition,
        event_gate,
        Path(args.rows).resolve(),
        Path(args.development_raw).resolve(),
    )
    holdout = load_split_examples(
        HOLDOUT_SPLIT,
        audit,
        recognition,
        event_gate,
        Path(args.rows).resolve(),
        Path(args.holdout_raw).resolve(),
    )
    development_x = np.asarray([example["features"] for example in development], dtype=np.float64)
    development_y = np.asarray([example["label"] for example in development], dtype=np.int64)
    holdout_x = np.asarray([example["features"] for example in holdout], dtype=np.float64)
    model_results = {}
    passing_models = []
    for name, model in build_models().items():
        model.fit(development_x, development_y)
        development_probabilities = model.predict_proba(development_x)[:, 1]
        holdout_probabilities = model.predict_proba(holdout_x)[:, 1]
        selected = choose_zero_unsafe_threshold(development, development_probabilities)
        development_metrics = None
        holdout_metrics = None
        if selected is not None:
            development_metrics = evaluate_threshold(
                development,
                development_probabilities,
                float(selected["threshold"]),
            )
            holdout_metrics = evaluate_threshold(
                holdout,
                holdout_probabilities,
                float(selected["threshold"]),
            )
        passes = bool(
            selected is not None
            and development_metrics
            and holdout_metrics
            and development_metrics["cleanAutoPassCount"] >= 30
            and development_metrics["unsafeWeakAutoPassCount"] == 0
            and holdout_metrics["cleanAutoPassCount"] >= 30
            and holdout_metrics["unsafeWeakAutoPassCount"] == 0
        )
        if passes:
            passing_models.append(name)
        model_results[name] = {
            "selectedDevelopmentThreshold": None if selected is None else selected["threshold"],
            "development": development_metrics,
            "holdout": holdout_metrics,
            "passesExploratoryHoldoutGate": passes,
        }
    ready = bool(passing_models)
    report = {
        "ok": True,
        "evidenceType": "public-professional-waveform-synthetic-weak-note-classifier",
        "featureNames": list(FEATURE_NAMES),
        "selectionDiscipline": "fit each fixed shallow model and choose its zero-unsafe threshold on development-reference-performer; evaluate without threshold retuning on holdout-unseen-performer",
        "modelResults": model_results,
        "passingModels": passing_models,
        "weakNotePublicRawAudioGateReady": ready,
        "weakNoteStudentErrorGateReady": False,
        "limitations": [
            "weak-notes-are-synthetic-94pct-attenuation-not-human-performance-errors",
            "reference-note-times-are-estimated-cqt-dtw",
            "model-family-bakeoff-is-exploratory-and-the-holdout-is-not-a-fresh-final-test",
            "student-domain-release-remains-blocked",
        ],
    }
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
