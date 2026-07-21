#!/usr/bin/env python3
"""Evaluate a review-only candidate for merged adjacent substitutions.

This is a development pre-gate.  Round 4 exposed one case where a wrong note
was played as the following note's pitch and Basic Pitch merged both notes into
one long event.  Because the rule was discovered after inspecting Round 4, the
result cannot promote a diagnosis.  Independent positive replication is a
hard requirement.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
CONTRACT = "western-ordinary-merged-substitution-pre-gate-v1"
MIN_COMBINED_DURATION_COVERAGE = 0.90
MAX_SUBSTITUTION_DISTANCE_SEMITONES = 2
ROUND4_REPORT = REPO / "data/experiments/western-strings-round4/ordinary-fresh-blind/report.json"
ROUND4_TRUTH = REPO / "data/private/western-strings-round4/error-positions.json"
OUT_DIR = REPO / "data/experiments/western-strings-round4/merged-substitution-candidate"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def normalized_candidate_rows(candidate_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "noteIndex": int(row.get("noteIndex", index)),
            "scoreMidi": int(row.get("midi", 0)),
            "beatDuration": float(row.get("beatDuration") or 0.0),
            "assigned": row.get("m3plusTimingAssignmentAvailable") is True,
            "pitchDistanceSemitones": row.get("basicPitchPitchDistanceSemitones"),
            "eventDurationRatio": (row.get("dynamicShadowEvidence") or {}).get("eventDurationRatio"),
            "protected": (row.get("m3plusPitchSafetyEvidence") or {}).get("zone") == "score_marked_neutral",
            "onsetGroupSize": int(row.get("onsetGroupSize") or 1),
            "polyphonic": row.get("polyphonicScoreRegion") is True,
            "measureIndex": int(row.get("measureIndex") or 0),
            "beatStart": float(row.get("beatStart") or 0.0),
        }
        for index, row in enumerate(candidate_rows)
    ]


def detect_merged_substitution_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for index in range(1, len(rows) - 1):
        previous, current, following = rows[index - 1], rows[index], rows[index + 1]
        current_duration = float(current.get("beatDuration") or 0.0)
        following_duration = float(following.get("beatDuration") or 0.0)
        duration_ratio = following.get("eventDurationRatio")
        pitch_distance = abs(int(current.get("scoreMidi", 0)) - int(following.get("scoreMidi", 0)))
        combined_duration = current_duration + following_duration
        combined_coverage = (
            float(duration_ratio) * following_duration / combined_duration
            if duration_ratio is not None and combined_duration > 0 and following_duration > 0
            else None
        )
        if not (
            previous.get("assigned") is True
            and current.get("assigned") is False
            and following.get("assigned") is True
            and following.get("pitchDistanceSemitones") == 0
            and 1 <= pitch_distance <= MAX_SUBSTITUTION_DISTANCE_SEMITONES
            and combined_coverage is not None
            and combined_coverage >= MIN_COMBINED_DURATION_COVERAGE
            and current.get("protected") is not True
            and following.get("protected") is not True
            and int(current.get("onsetGroupSize") or 1) == 1
            and int(following.get("onsetGroupSize") or 1) == 1
            and current.get("polyphonic") is not True
            and following.get("polyphonic") is not True
        ):
            continue
        candidates.append(
            {
                "noteIndex": int(current.get("noteIndex", index)),
                "measureIndex": int(current.get("measureIndex") or 0),
                "beatStart": float(current.get("beatStart") or 0.0),
                "scoreMidi": int(current.get("scoreMidi", 0)),
                "followingScoreMidi": int(following.get("scoreMidi", 0)),
                "pitchDistanceSemitones": pitch_distance,
                "combinedDurationCoverage": round(combined_coverage, 6),
                "reviewerOnly": True,
                "studentFacing": False,
                "automaticAccusationAuthorized": False,
            }
        )
    return candidates


def evaluate_round4() -> dict[str, Any]:
    report = read_json(ROUND4_REPORT)
    truth = read_json(ROUND4_TRUTH).get("recordings", {})
    rows_out: list[dict[str, Any]] = []
    total_positions = 0
    planted_positions = 0
    strict_confirmed = int((report.get("policyCReviewAssist") or {}).get("planted", {}).get("strictConfirmed", 0))
    for recording in report.get("recordings", []):
        recording_id = str(recording.get("recordingId") or "")
        artifact = read_json(REPO / recording["candidateRowsPath"])
        rows = normalized_candidate_rows(artifact.get("candidateRows", []))
        total_positions += len(rows)
        errors = truth.get(recording_id, {}).get("errors", [])
        planted_positions += len(errors)
        error_by_position = {
            (int(error["measure"]), float(error["beat"]) - 1.0): str(error["kind"])
            for error in errors
        }
        for candidate in detect_merged_substitution_candidates(rows):
            rows_out.append(
                {
                    "recordingId": recording_id,
                    **candidate,
                    "truthKind": error_by_position.get(
                        (candidate["measureIndex"], candidate["beatStart"]),
                        "non_planted",
                    ),
                }
            )
    wrong_hits = sum(row["truthKind"] == "wrong" for row in rows_out)
    non_planted_flags = sum(row["truthKind"] == "non_planted" for row in rows_out)
    return {
        "totalPositions": total_positions,
        "plantedPositions": planted_positions,
        "nonPlantedPositions": total_positions - planted_positions,
        "existingStrictConfirmed": strict_confirmed,
        "mergedSubstitutionCandidateCount": len(rows_out),
        "mergedSubstitutionWrongHits": wrong_hits,
        "nonPlantedFlags": non_planted_flags,
        "diagnosticStrictCeiling": strict_confirmed + wrong_hits,
        "rows": rows_out,
    }


def normalized_quantization_rows(take: dict[str, Any]) -> list[dict[str, Any]]:
    notes = take["notes"]
    source_rows = take["rows"]
    score_durations = [
        float(notes[index + 1]["scoreUnit"]) - float(note["scoreUnit"])
        for index, note in enumerate(notes[:-1])
    ]
    fallback_duration = score_durations[-1] if score_durations else 1.0
    score_durations.append(fallback_duration)
    return [
        {
            "noteIndex": index,
            "scoreMidi": int(note["midi"]),
            "beatDuration": score_durations[index],
            "assigned": row.get("predictedTime") is not None,
            "pitchDistanceSemitones": row.get("pitchDistanceSemitones"),
            "eventDurationRatio": row.get("eventDurationRatio"),
            "protected": False,
            "onsetGroupSize": 1,
            "polyphonic": False,
            "measureIndex": 0,
            "beatStart": 0.0,
        }
        for index, (note, row) in enumerate(zip(notes, source_rows))
    ]


def evaluate_external_sets() -> dict[str, Any]:
    sys.path.insert(0, str(REPO / "scripts/experiments"))
    from eval_western_strings_duration_extra_quantization import (  # noqa: PLC0415
        INJECT_DIR,
        NATURAL_TAKES,
        PRIVATE,
        ROUND3,
        R3_TRUTH,
        V2_SETS,
        analyze_take,
    )

    sets: list[dict[str, Any]] = []
    for name in V2_SETS:
        piece = name.split("-injected")[0]
        take = analyze_take(PRIVATE / f"{piece}.musicxml", INJECT_DIR / f"{name}.wav")
        candidates = detect_merged_substitution_candidates(normalized_quantization_rows(take))
        labels = read_json(INJECT_DIR / f"{name}.labels.json")
        wrong_indexes = {
            int(item["scoreEventIndex"])
            for item in labels["injections"]
            if item["type"] == "wrong"
        }
        positive_replications = sum(
            int(candidate["noteIndex"]) in wrong_indexes for candidate in candidates
        )
        sets.append({
            "set": name,
            "kind": "waveform-injection-v2",
            "candidateCount": len(candidates),
            "positiveReplicationCount": positive_replications,
        })
    for name, score_path, audio_path in NATURAL_TAKES:
        take = analyze_take(score_path, audio_path)
        candidates = detect_merged_substitution_candidates(normalized_quantization_rows(take))
        sets.append({
            "set": name,
            "kind": "natural-student-domain",
            "candidateCount": len(candidates),
            "positiveReplicationCount": 0,
        })
    r3_truth = {
        item["take"]: item
        for item in read_json(R3_TRUTH).get("takes", [])
    }
    for name in ("r3-04", "r3-05"):
        take = analyze_take(ROUND3 / f"{name}.musicxml", ROUND3 / f"{name}.m4a")
        candidates = detect_merged_substitution_candidates(normalized_quantization_rows(take))
        wrong_indexes = {
            int(item["scoreEventIndex"])
            for item in r3_truth.get(name, {}).get("entries", [])
            if item.get("type") == "wrong"
            and item.get("verified") is True
            and "not-performed" not in str(item.get("asPerformed", ""))
        }
        positive_replications = sum(
            int(candidate["noteIndex"]) in wrong_indexes for candidate in candidates
        )
        sets.append({
            "set": name,
            "kind": "owner-confirmed-real-errors",
            "candidateCount": len(candidates),
            "positiveReplicationCount": positive_replications,
        })
    return {
        "setCount": len(sets),
        "candidateCount": sum(row["candidateCount"] for row in sets),
        "independentPositiveReplicationCount": sum(
            row["positiveReplicationCount"] for row in sets
        ),
        "sets": sets,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-external", action="store_true")
    args = parser.parse_args()
    round4 = evaluate_round4()
    external = None if args.skip_external else evaluate_external_sets()
    positive_replication_ready = bool(
        external and external["independentPositiveReplicationCount"] >= 1
    )
    blocking_reasons = ["merged-substitution-fresh-blind-evidence-missing"]
    if not positive_replication_ready:
        blocking_reasons.insert(0, "merged-substitution-independent-positive-replication-missing")
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "scope": "development-preGateOnly",
        "rule": {
            "isolatedAssignmentGap": True,
            "followingEventExactPitch": True,
            "maxSubstitutionDistanceSemitones": MAX_SUBSTITUTION_DISTANCE_SEMITONES,
            "minCombinedDurationCoverage": MIN_COMBINED_DURATION_COVERAGE,
            "monophonicUnmarkedOnly": True,
        },
        "round4Development": round4,
        "externalEvidence": external,
        "developmentSignalReady": (
            round4["mergedSubstitutionWrongHits"] >= 1
            and round4["nonPlantedFlags"] == 0
        ),
        "positiveReplicationReady": positive_replication_ready,
        "reviewAssistPromotionReady": False,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "blockingReasons": blocking_reasons,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# Merged-substitution candidate (development pre-gate)",
        "",
        f"- development signal ready: {str(report['developmentSignalReady']).lower()}",
        f"- Round-4 diagnostic strict ceiling: {round4['diagnosticStrictCeiling']}/12",
        f"- Round-4 non-planted flags: {round4['nonPlantedFlags']}/{round4['nonPlantedPositions']}",
        f"- independent positive replications: {external['independentPositiveReplicationCount'] if external else 0}",
        "- promotion ready: false",
        "- student-facing: false",
        "",
        "This rule was discovered after Round 4 inspection. It may guide the next fresh-blind pack, but cannot promote a diagnosis.",
    ]
    (OUT_DIR / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "report": report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
