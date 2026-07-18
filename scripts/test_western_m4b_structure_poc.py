#!/usr/bin/env python3
"""Contract tests for the fail-closed M4b explicit-structure POC."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from western_m4b_structure_poc import (
    analyze_photo,
    decode_structure_graph,
    load_policy,
    shadow_content_challenger,
)


REPO = Path(__file__).resolve().parents[1]
MANIFEST = REPO / "data" / "experiments" / "western-strings-m4b" / "dataset" / "manifest.json"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def synthetic_test_photo() -> Path:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    row = next(row for row in manifest["syntheticRows"] if row["split"] == "synthetic-test")
    return REPO / row["image"]["path"]


def main() -> int:
    policy = load_policy()
    result = analyze_photo(synthetic_test_photo())
    require(result["ready"] is True, "known synthetic case should produce a structure candidate")
    require(result["reason"] == policy["graphDecoder"]["candidateDisposition"], "candidate disposition drifted")
    require(result["structureReviewRequired"] is False, "clean structure should have no detected conflict")
    require(result["reviewRequired"] is True, "POC candidates must remain review-only")
    require(result["studentFacing"] is False, "POC must never be student-facing")
    require(result["automaticAdoptionAuthorized"] is False, "POC must never authorize adoption")
    evidence = result["structureEvidence"]
    require(len(evidence["systems"]) == 4, "known case system count drifted")
    require(len(evidence["measureBoxes"]) == 21, "known case measure count drifted")

    conflict = decode_structure_graph(
        evidence,
        policy,
        {"meterQuarters": 4.0, "measureDurationQuarters": [3.0]},
    )
    require(conflict["structureReviewRequired"] is True, "meter conflict must fail closed")
    require(conflict["decision"] == "structure-review-required", "conflict disposition must be explicit")
    require("meter-measure-duration-conflict" in conflict["conflicts"], "meter conflict reason missing")
    require(conflict["silentGuess"] is False, "graph must not silently guess")

    polygon = evidence["measureBoxes"][0]["polygonPixels"]
    center_x = sum(point[0] for point in polygon) / 4.0
    center_y = sum(point[1] for point in polygon) / 4.0
    challenger = shadow_content_challenger(
        result["structureGraph"],
        evidence,
        [
            {"engine": "homr-high-recall", "x": center_x, "y": center_y, "midi": 69},
            {"engine": "audiveris-supplement", "x": center_x, "y": center_y, "midi": 69},
            {"engine": "oemer-supplement", "x": None, "y": None, "midi": 72},
        ],
        policy,
    )
    require(challenger["ready"] is True, "clean structure should permit shadow assignment")
    require(len(challenger["consensusCandidates"]) == 1, "two-engine consensus should be retained")
    require(challenger["unassignableCount"] == 1, "coordinate-free candidate must be unassignable")
    require(challenger["shadowOnly"] is True, "challenger must remain shadow-only")
    require(challenger["productionCandidatePool"] is False, "challenger must not enter production")
    require(challenger["studentFacing"] is False, "challenger must not face students")

    with tempfile.TemporaryDirectory() as temporary:
        missing = Path(temporary) / "missing.jpg"
        failed = analyze_photo(missing)
    require(failed["ready"] is False, "missing photo must fail closed")
    require(failed["structureReviewRequired"] is True, "missing photo must require review")
    require(failed["automaticAdoptionAuthorized"] is False, "missing photo must never authorize adoption")

    print("western m4b structure poc tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
