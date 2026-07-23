#!/usr/bin/env python3
"""Verify the completed P1 clean-domain report against the frozen contract."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
EVALUATOR = REPO / "scripts/experiments/eval_western_p1_clean_domain_candidates.py"
PROTOCOL = REPO / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"
REPORT = REPO / "docs/evidence/western-strings-p1-clean-domain-safety-20260724.json"


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_evaluator():
    spec = importlib.util.spec_from_file_location("p1_clean_eval", EVALUATOR)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_domain(domain: dict) -> None:
    flag_count = sum(row["countedNegativeOrBurdenFlags"] for row in domain["recordings"])
    position_count = sum(row["countedPositionCount"] for row in domain["recordings"])
    maximum = max((row["rate"] for row in domain["recordings"]), default=0.0)
    assert domain["flagCount"] == flag_count
    assert domain["positionCount"] == position_count
    assert domain["rate"] == round(flag_count / max(1, position_count), 9)
    assert domain["flagsPer1000Positions"] == round(
        1000.0 * flag_count / max(1, position_count), 6
    )
    assert domain["maximumPerRecordingRate"] == round(maximum, 9)


def main() -> int:
    evaluator = load_evaluator()
    protocol = json.loads(PROTOCOL.read_text(encoding="utf-8"))
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    semantic = dict(report)
    expected_sha = semantic.pop("evidenceSemanticSha256")
    assert hashlib.sha256(canonical_json(semantic).encode()).hexdigest() == expected_sha

    assert report["preregistration"]["protocolSemanticSha256"] == protocol[
        "protocolSemanticSha256"
    ]
    assert report["preregistration"]["gitCommitShaBeforeEvaluation"].startswith("8de5b9e")
    assert report["preregistration"]["executionRunnerCommitSha"].startswith("0b4d9cc")
    assert report["executionDiscipline"]["candidateRetuned"] is False
    assert report["executionDiscipline"]["thresholdChanged"] is False
    assert report["executionDiscipline"]["inputSelectionChanged"] is False
    assert report["executionDiscipline"]["priorFailedAttempt"][
        "candidateCountsPrintedOrRead"
    ] is False

    candidate_specs = {row["candidateId"]: row for row in protocol["candidates"]}
    results = {row["candidateId"]: row for row in report["candidateResults"]}
    assert set(results) == set(candidate_specs)
    assert len(results) == 7
    for candidate_id, result in results.items():
        for domain in result["domains"].values():
            verify_domain(domain)
        eliminated, reasons = evaluator.elimination_decision(
            candidate_specs[candidate_id],
            result["domains"],
            protocol["eliminationRules"],
        )
        assert result["eliminated"] is eliminated
        assert result["eliminationReasons"] == reasons
        assert result["promotionReady"] is False
        assert result["studentFacing"] is False
        assert result["automaticAdoptionReady"] is False

    temporal = [
        row
        for row in results.values()
        if "authoritative-local-clean" in row["domains"]
    ]
    assert len(temporal) == 6
    for row in temporal:
        assert row["domains"]["authoritative-local-clean"]["positionCount"] == 743
        assert row["domains"]["consumed-round5-known-negatives"]["positionCount"] == 624
        assert row["domains"]["public-professional-burden"]["positionCount"] == 6652
        assert row["domains"]["public-professional-burden"][
            "falsePositiveCountAuthoritative"
        ] is False
    assert results["pitch-trajectory-center-strict-v1"]["domains"][
        "pitch-artifact-local-clean"
    ]["positionCount"] == 506

    assert sorted(report["conclusions"]["eliminatedCandidateIds"]) == sorted(results)
    assert report["conclusions"]["retainedCandidateIds"] == []
    assert report["conclusions"]["studentFacing"] is False
    assert all(value is False for value in report["studentSwitches"].values())
    print("western P1 clean-domain result verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
