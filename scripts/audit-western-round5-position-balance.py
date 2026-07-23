#!/usr/bin/env python3
"""Check Round 5 label-position balance before recording any audio.

Only MusicXML and planned truth positions are read.  If a score-context-only
rule can separate positives from confusion negatives under leave-one-recording
out, the plan is rejected before recording.  The rhythm self-check design is
also checked against every score position because its false-positive
denominator is the complete performance, not only the annotated event slots.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from music21 import converter

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import audit_western_round5_calibration_failure_modes as failure_audit  # noqa: E402
import train_western_round5_segment_edit_path as segment  # noqa: E402

CONTRACT = "western-round5-position-balance-preflight-v2"
MANIFEST = REPO / "data/private/western-strings-round5/manifest.csv"
TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
OUT = (
    REPO
    / "data/experiments"
    / "western-strings-round5-position-balance"
    / "report.json"
)
RHYTHM_GATES = frozenset({"extra", "drag"})
RHYTHM_REVIEW_FLOOR = {
    "minPrecision": 0.90,
    "minRecall": 0.20,
    "maxCleanHintRate": 0.02,
}
SCORE_CONTEXT_FEATURES = {
    "scorePreviousInterval",
    "scoreNextInterval",
    "segmentEdgeStatus",
    "scoreDurationQuarter",
    "scorePreviousDurationRatio",
    "scoreNextDurationRatio",
    "scoreBeat",
    "scoreBeatStrength",
    "scoreRepeatedPrevious",
    "scoreRepeatedNext",
    "scoreNormalizedIndex",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def display_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO).as_posix()
    except ValueError:
        return str(resolved)


def score_positions(score_path: Path) -> list[dict[str, Any]]:
    score = converter.parse(str(score_path))
    notes = list(score.flatten().notes)
    positions = []
    for index, item in enumerate(notes):
        midis = sorted(int(pitch.midi) for pitch in item.pitches)
        positions.append({
            "noteIndex": index,
            "measure": int(item.measureNumber or 0),
            "beat": float(item.beat),
            "scoreMidi": midis[0],
            "durationQuarter": float(item.quarterLength),
            "beatStrength": float(item.beatStrength or 0.0),
        })
    for index, position in enumerate(positions):
        midi = int(position["scoreMidi"])
        duration = max(0.001, float(position["durationQuarter"]))
        previous = positions[index - 1] if index else None
        following = positions[index + 1] if index + 1 < len(positions) else None
        position["features"] = {
            "scorePreviousInterval": float(
                midi - int(previous["scoreMidi"])
            ) if previous else 0.0,
            "scoreNextInterval": float(
                int(following["scoreMidi"]) - midi
            ) if following else 0.0,
            "segmentEdgeStatus": float(
                index < 2 or index + 2 >= len(positions)
            ),
            "scoreDurationQuarter": duration,
            "scorePreviousDurationRatio": (
                duration / max(0.001, float(previous["durationQuarter"]))
                if previous else 0.0
            ),
            "scoreNextDurationRatio": (
                float(following["durationQuarter"]) / duration
                if following else 0.0
            ),
            "scoreBeat": float(position["beat"]),
            "scoreBeatStrength": float(position["beatStrength"]),
            "scoreRepeatedPrevious": float(
                previous is not None and int(previous["scoreMidi"]) == midi
            ),
            "scoreRepeatedNext": float(
                following is not None and int(following["scoreMidi"]) == midi
            ),
            "scoreNormalizedIndex": (
                index / max(1, len(positions) - 1)
            ),
        }
    return positions


def plan_rows(
    manifest_path: Path,
    truth_path: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        manifest = list(csv.DictReader(handle))
    truth = json.loads(truth_path.read_text(encoding="utf-8"))["recordings"]
    event_rows = []
    rhythm_position_rows = []
    for metadata in manifest:
        recording_id = metadata["recordingId"]
        truth_recording = truth.get(recording_id)
        if not truth_recording:
            raise ValueError(f"round5-truth-recording-missing:{recording_id}")
        score_path = REPO / metadata["scorePath"]
        positions = score_positions(score_path)
        rhythm_positive_indices = set()
        for event in truth_recording.get("events", []):
            index = segment.truth_note_index(positions, event)
            if event["gate"] in RHYTHM_GATES and event["label"] == "positive":
                rhythm_positive_indices.add(index)
            event_rows.append({
                "recordingId": recording_id,
                "eventId": event.get("eventId"),
                "split": metadata["split"],
                "gate": event["gate"],
                "label": event["label"],
                "features": positions[index]["features"],
            })
        for position in positions:
            index = int(position["noteIndex"])
            rhythm_position_rows.append({
                "recordingId": recording_id,
                "eventId": f"rhythm-position-{index}",
                "split": metadata["split"],
                "gate": "rhythm_review_hint",
                "label": (
                    "positive" if index in rhythm_positive_indices else "negative"
                ),
                "features": position["features"],
            })
    return event_rows, rhythm_position_rows


def score_context_rows(
    manifest_path: Path,
    truth_path: Path,
) -> list[dict[str, Any]]:
    """Compatibility helper for callers that only need annotated event rows."""
    return plan_rows(manifest_path, truth_path)[0]


def rhythm_metrics(
    rows: list[dict[str, Any]],
    predicted: list[int],
) -> dict[str, Any]:
    truth = np.asarray(
        [int(row["label"] == "positive") for row in rows],
        dtype=np.int8,
    )
    estimate = np.asarray(predicted, dtype=np.int8)
    result = segment.binary_metrics(truth, estimate)
    negative_count = result["falsePositive"] + result["trueNegative"]
    result["cleanHintRate"] = round(
        result["falsePositive"] / max(1, negative_count),
        6,
    )
    result["passesReviewFloor"] = bool(
        result["precision"] >= RHYTHM_REVIEW_FLOOR["minPrecision"]
        and result["recall"] >= RHYTHM_REVIEW_FLOOR["minRecall"]
        and result["cleanHintRate"] <= RHYTHM_REVIEW_FLOOR["maxCleanHintRate"]
    )
    return result


def select_rhythm_rule(
    rows: list[dict[str, Any]],
) -> dict[str, Any] | None:
    candidates = []
    for name in sorted(SCORE_CONTEXT_FEATURES):
        values = [float(row["features"].get(name, 0.0)) for row in rows]
        for threshold in failure_audit.thresholds(values):
            for direction in ("gte", "lte"):
                predicted = [
                    int(value >= threshold) if direction == "gte"
                    else int(value <= threshold)
                    for value in values
                ]
                result = rhythm_metrics(rows, predicted)
                if result["passesReviewFloor"]:
                    candidates.append({
                        "feature": name,
                        "direction": direction,
                        "threshold": threshold,
                        "metrics": result,
                    })
    if not candidates:
        return None
    candidates.sort(key=lambda item: (
        -item["metrics"]["recall"],
        -item["metrics"]["precision"],
        item["metrics"]["cleanHintRate"],
        item["feature"],
        item["direction"],
        item["threshold"],
    ))
    return candidates[0]


def nested_rhythm_loro(rows: list[dict[str, Any]]) -> dict[str, Any]:
    predictions: dict[tuple[str, str], int] = {}
    selected_rules = []
    recordings = sorted({row["recordingId"] for row in rows})
    for held_out in recordings:
        train = [row for row in rows if row["recordingId"] != held_out]
        test = [row for row in rows if row["recordingId"] == held_out]
        rule = select_rhythm_rule(train)
        selected_rules.append({
            "heldOutRecordingId": held_out,
            "feature": rule["feature"] if rule else None,
            "direction": rule["direction"] if rule else None,
            "threshold": round(float(rule["threshold"]), 6) if rule else None,
            "trainingMetrics": rule["metrics"] if rule else None,
        })
        for row in test:
            key = (row["recordingId"], str(row["eventId"]))
            predictions[key] = failure_audit.apply_rule(row, rule)
    ordered = [
        predictions[(row["recordingId"], str(row["eventId"]))]
        for row in rows
    ]
    families = {
        (item["feature"], item["direction"])
        for item in selected_rules
        if item["feature"] is not None
    }
    result = rhythm_metrics(rows, ordered)
    stable_family = len(families) == 1 and all(
        item["feature"] is not None for item in selected_rules
    )
    score_context_rf = failure_audit.random_forest_loro(
        rows,
        performance_only=False,
    )
    rf_review_metrics = rhythm_metrics(
        rows,
        [
            int(item["predictedPositive"])
            for item in score_context_rf["rows"]
        ],
    )
    univariate_confounded = bool(
        result["passesReviewFloor"] and stable_family
    )
    random_forest_confounded = bool(
        rf_review_metrics["passesReviewFloor"]
    )
    return {
        "method": "nested-rhythm-score-context-only-rule-leave-one-recording-out",
        "selectionUsesHeldOutRows": False,
        "selectedRules": selected_rules,
        "stableFeatureDirectionAcrossFolds": stable_family,
        "metrics": result,
        "univariateConfounded": univariate_confounded,
        "scoreContextRandomForest": {
            **score_context_rf,
            "reviewFloorMetrics": rf_review_metrics,
        },
        "randomForestConfounded": random_forest_confounded,
        "confounded": bool(
            univariate_confounded or random_forest_confounded
        ),
    }


def audit_rows(
    rows: list[dict[str, Any]],
    rhythm_position_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    by_split = {}
    detected = []
    rhythm_by_split = {}
    rhythm_detected = []
    for split in ("calibration", "fresh-blind"):
        by_split[split] = {}
        for gate in segment.GATES:
            gate_rows = [
                row for row in rows
                if row["split"] == split and row["gate"] == gate
            ]
            result = failure_audit.nested_univariate_loro(
                gate_rows,
                allowed_features={
                    "scorePreviousInterval",
                    "scoreNextInterval",
                    "segmentEdgeStatus",
                },
                method="nested-score-context-only-rule-leave-one-recording-out",
            )
            confounded = result["candidateReadyForNewFreshBlind"]
            by_split[split][gate] = {
                "rows": len(gate_rows),
                "scoreContextOnlyRule": result,
                "confounded": confounded,
            }
            if confounded:
                detected.append(f"{split}:{gate}")
        rhythm_rows = [
            row for row in (rhythm_position_rows or [])
            if row["split"] == split
        ]
        rhythm_result = nested_rhythm_loro(rhythm_rows) if rhythm_rows else None
        rhythm_by_split[split] = {
            "rows": len(rhythm_rows),
            "positiveRows": sum(
                row["label"] == "positive" for row in rhythm_rows
            ),
            "negativeRows": sum(
                row["label"] != "positive" for row in rhythm_rows
            ),
            "scoreContextOnlyRule": rhythm_result,
            "confounded": bool(rhythm_result and rhythm_result["confounded"]),
        }
        if rhythm_by_split[split]["confounded"]:
            rhythm_detected.append(split)
    return {
        "bySplit": by_split,
        "confoundedSplitGates": detected,
        "rhythmReviewHint": {
            "thresholds": RHYTHM_REVIEW_FLOOR,
            "bySplit": rhythm_by_split,
            "confoundedSplits": rhythm_detected,
        },
        "readyForRecording": not detected and not rhythm_detected,
    }


def run(manifest_path: Path, truth_path: Path, out_path: Path) -> dict[str, Any]:
    event_rows, rhythm_position_rows = plan_rows(manifest_path, truth_path)
    result = audit_rows(event_rows, rhythm_position_rows)
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "evidenceRole": "pre-recording-position-balance-only",
        "sourceHashes": {
            "manifestSha256": sha256(manifest_path),
            "truthSha256": sha256(truth_path),
        },
        **result,
        "requiredBalanceDimensions": [
            *sorted(SCORE_CONTEXT_FEATURES),
        ],
        "audioRead": False,
        "promotionEvidenceEligible": False,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "blockingReasons": [
            f"round5-position-score-context-confounded:{item}"
            for item in result["confoundedSplitGates"]
        ] + [
            f"round5-rhythm-position-score-context-confounded:{split}"
            for split in result["rhythmReviewHint"]["confoundedSplits"]
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--truth", type=Path, default=TRUTH)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    report = run(args.manifest, args.truth, args.out)
    print(json.dumps({
        "contract": report["contract"],
        "readyForRecording": report["readyForRecording"],
        "confoundedSplitGates": report["confoundedSplitGates"],
        "rhythmConfoundedSplits": (
            report["rhythmReviewHint"]["confoundedSplits"]
        ),
        "audioRead": report["audioRead"],
        "blockingReasons": report["blockingReasons"],
        "out": display_path(args.out),
    }, ensure_ascii=False, indent=2))
    return int(args.require_ready and not report["readyForRecording"])


if __name__ == "__main__":
    raise SystemExit(main())
