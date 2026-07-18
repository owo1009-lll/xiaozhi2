from __future__ import annotations

import copy
import hashlib
import sys
import tempfile
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m3plus_rescope_gate import (  # noqa: E402
    CONTRACT,
    build_source_binding,
    evaluate_rescope_gate,
    flatten_rows,
    independently_unstable_reason,
)


FIXED_GENERATED_AT = "2026-07-18T00:00:00Z"
SOURCE_BINDINGS = {
    "machineSource": {"path": "fixtures/machine.json", "sha256": "1" * 64},
    "humanGold": {"path": "fixtures/human-gold.json", "sha256": "2" * 64},
    "m3CoreGate": {"path": "fixtures/m3-core.json", "sha256": "3" * 64},
    "rescopeDecision": {"path": "fixtures/rescope-decision.md", "sha256": "4" * 64},
    "evaluator": {"path": "fixtures/evaluator.py", "sha256": "5" * 64},
}


def row(
    behavior: str,
    unit: int,
    *,
    error: float = 0.0,
    spread: float = 20.0,
    local: bool = True,
    tail_base_rate: float = 0.0,
) -> dict:
    diagnostics = {
        "f0QualityReady": True,
        "medianCents": error,
        "spreadCentsP95P05": spread,
        "iqrCents": spread,
        "exitCents": 200.0 + error,
        "knownTailBaseRatio": tail_base_rate,
        "knownPairSupportRate": 1.0,
    }
    return {
        "recordingId": "fixture",
        "unitIndex": unit,
        "measure": unit + 1,
        "evaluationSplit": "holdout",
        "expectedBehavior": behavior,
        "localizationUnitReady": local,
        "baseMidi": 60,
        "auxiliaryMidi": 62 if behavior in {"slide-source", "trill", "ornament-upper-mordent"} else None,
        "modeDiagnostics": diagnostics,
    }


def passing_m3_core() -> dict:
    return {
        "ok": True,
        "diagnosisGateReady": True,
        "gate": {
            "minPrecision": 0.9,
            "requiredCategories": ["pitch", "onset", "missing"],
        },
        "categories": {
            "onset": {
                "requiredForRelease": True,
                "autoIssueCount": 2,
                "correctIssueCount": 2,
                "unsafeIssueCount": 0,
                "precision": 1.0,
                "ready": True,
                "status": "ready",
            }
        },
    }


def fixture() -> tuple[dict, dict, dict]:
    rows = [row("stable", index) for index in range(12)]
    for source_row in rows[-4:]:
        source_row["modeDiagnostics"]["spreadCentsP95P05"] = 120.0

    rows.extend([
        row("vibrato", 20, error=10.0),
        row("slide-source", 21, error=15.0),
        row("vibrato", 22, error=5.0),
        row("vibrato", 23, spread=120.0),
        row("slide-source", 24, tail_base_rate=1.0),
        row("vibrato", 25, local=False),
        row("vibrato", 26, local=False),
        row("slide-source", 27, local=False),
    ])
    marked_behaviors = [
        "trill",
        "ornament-upper-mordent",
        "harmonic",
        "trill",
        "ornament-upper-mordent",
        "harmonic",
        "trill",
        "ornament-upper-mordent",
    ]
    rows.extend(row(behavior, 40 + index, error=400.0) for index, behavior in enumerate(marked_behaviors))
    machine = {
        "scoreTechniqueIntentReady": True,
        "recordings": [{"recordingId": "fixture", "rows": rows}],
    }
    human = {
        "recordings": [{
            "recordingId": "round2",
            "performanceExecutionVerified": True,
            "trillExpectedNoteCount": 6,
            "vibratoExpectedLongNoteCount": 17,
        }],
    }
    return machine, human, passing_m3_core()


def add_all_intonation_gold(machine: dict, human: dict) -> None:
    human["intonationGoldUnits"] = [
        {
            "recordingId": source_row["recordingId"],
            "measure": source_row["measure"],
            "unitIndex": source_row["unitIndex"],
            "intonationGoldVerified": True,
            "pitchAccuracyLabel": "in-tune",
        }
        for source_row in flatten_rows(machine)
        if source_row.get("expectedBehavior") in {"stable", "vibrato", "slide-source"}
    ]


def add_round2_protected_execution(machine: dict, human: dict) -> None:
    protected_rows = [row("trill", 100 + index, error=400.0) for index in range(6)]
    machine["recordings"][0]["rows"].extend(protected_rows)
    human["protectedScoreUnits"] = [
        {
            "recordingId": source_row["recordingId"],
            "measure": source_row["measure"],
            "unitIndex": source_row["unitIndex"],
            "scoreProtectionVerified": True,
        }
        for source_row in protected_rows
    ]


def evaluate(machine: dict, human: dict, m3_core: dict, **kwargs: object) -> dict:
    return evaluate_rescope_gate(
        machine,
        human,
        m3_core,
        source_bindings=copy.deepcopy(SOURCE_BINDINGS),
        generated_at=FIXED_GENERATED_AT,
        **kwargs,
    )


def test_current_evidence_is_red_without_note_level_gold_join() -> None:
    machine, human, m3_core = fixture()
    report = evaluate(machine, human, m3_core)
    assert report["schemaVersion"] == 2
    assert report["contract"] == CONTRACT == "m3plus-rescope-four-zone-v2"
    assert report["generatedAt"] == FIXED_GENERATED_AT
    assert report["sourceBindingsReady"] is True
    assert report["releaseGateReady"] is False
    assert "m3plus-rescope-center-intonation-gold-join-missing" in report["blockingReasons"]
    assert "m3plus-rescope-score-marked-declared-only-not-evaluated" in report["blockingReasons"]

    marked = report["zones"]["scoreMarkedNeutral"]
    assert marked["evaluatedProtectedCount"] == 8
    assert marked["declaredOnlyProtectedCount"] == 6
    assert marked["expectedProtectedCount"] == 14
    assert marked["totalProtectedCount"] == 14
    assert marked["totalDeclaredOrEvaluatedCount"] == 14
    assert marked["insufficientEvidenceCount"] == 8
    assert marked["gatePassed"] is False

    center = report["zones"]["techniqueCenter"]
    assert center["expectedCount"] == 8
    assert center["decisionCount"] == 3
    assert center["decisionCoverage"] == 0.375
    assert center["scoreIntentCenterAgreementCount"] == 3
    assert center["scoreIntentCenterAgreementRate"] == 1.0
    assert "precision" not in center
    assert center["intonationGoldJoinedUnitCount"] == 0
    assert center["goldJoinReady"] is False
    assert center["gatePassed"] is False
    assert report["sourceEvidence"]["round2UnscoredVibratoGoldCount"] == 17
    assert report["zones"]["unmarkedStraight"]["goldJoinReady"] is False
    assert "m3plus-rescope-straight-intonation-gold-join-missing" in report["blockingReasons"]


def test_fully_bound_future_fixture_can_pass() -> None:
    machine, human, m3_core = fixture()
    add_round2_protected_execution(machine, human)
    add_all_intonation_gold(machine, human)
    report = evaluate(machine, human, m3_core)
    assert report["releaseGateReady"] is True, report["blockingReasons"]
    assert report["zones"]["scoreMarkedNeutral"]["gatePassed"] is True
    assert report["zones"]["scoreMarkedNeutral"]["evaluatedProtectedCount"] == 14
    assert report["zones"]["scoreMarkedNeutral"]["protectedGoldJoinedUnitCount"] == 6
    assert report["zones"]["unmarkedStraight"]["goldJoinReady"] is True
    assert report["zones"]["techniqueCenter"]["goldJoinReady"] is True
    assert report["zones"]["techniqueCenter"]["intonationGoldAgreementRate"] == 1.0
    assert report["zones"]["rhythmOnset"]["gatePassed"] is True


def test_source_bindings_are_required_and_hash_bytes() -> None:
    machine, human, m3_core = fixture()
    broken_bindings = copy.deepcopy(SOURCE_BINDINGS)
    broken_bindings.pop("humanGold")
    report = evaluate_rescope_gate(
        machine,
        human,
        m3_core,
        source_bindings=broken_bindings,
        generated_at=FIXED_GENERATED_AT,
    )
    assert report["sourceBindingsReady"] is False
    assert "m3plus-rescope-source-bindings-incomplete" in report["blockingReasons"]

    with tempfile.TemporaryDirectory(prefix="m3plus-binding-") as temp_dir:
        source = Path(temp_dir) / "source.json"
        source.write_bytes(b"abc")
        binding = build_source_binding(source)
    assert binding["sha256"] == hashlib.sha256(b"abc").hexdigest()
    assert binding["path"].replace("\\", "/").endswith("/source.json")


def test_m3_core_onset_must_really_pass() -> None:
    machine, human, m3_core = fixture()
    add_round2_protected_execution(machine, human)
    add_all_intonation_gold(machine, human)
    m3_core["categories"]["onset"]["ready"] = False
    m3_core["categories"]["onset"]["status"] = "precision-below-threshold"
    report = evaluate(machine, human, m3_core)
    assert report["releaseGateReady"] is False
    assert "m3plus-rescope-m3-core-onset-not-ready" in report["blockingReasons"]
    assert report["zones"]["rhythmOnset"]["onsetReady"] is False
    assert report["zones"]["rhythmOnset"]["gatePassed"] is False


def test_unstable_cases_are_enumerated_from_raw_diagnostics() -> None:
    machine, human, m3_core = fixture()
    raw_unstable = [
        source_row
        for source_row in flatten_rows(machine)
        if independently_unstable_reason(
            source_row,
            max_straight_spread_cents=80.0,
            max_vibrato_iqr_cents=80.0,
            minimum_slide_tail_target_rate=0.70,
            minimum_slide_pitch_support_rate=0.65,
        ) is not None
    ]
    assert [source_row["unitIndex"] for source_row in raw_unstable] == [8, 9, 10, 11, 23, 24]
    report = evaluate(machine, human, m3_core)
    guard = report["zones"]["unstableFailClosed"]
    assert guard["enumerationSource"] == "raw-holdout-diagnostics-before-policy-decision"
    assert guard["expectedCaseCount"] == 6
    assert guard["testedCount"] == 6
    assert guard["insufficientEvidenceCount"] == 6
    assert guard["accusationCount"] == 0


def test_center_gold_disagreement_closes_gate() -> None:
    machine, human, m3_core = fixture()
    add_round2_protected_execution(machine, human)
    add_all_intonation_gold(machine, human)
    next(
        source_row for source_row in machine["recordings"][0]["rows"]
        if source_row["unitIndex"] == 20
    )["modeDiagnostics"]["medianCents"] = 75.0
    report = evaluate(machine, human, m3_core)
    assert report["releaseGateReady"] is False
    assert "m3plus-rescope-center-intonation-gold-agreement-failed" in report["blockingReasons"]
    center = report["zones"]["techniqueCenter"]
    assert center["intonationGoldFalsePositiveCount"] == 1
    assert center["intonationGoldDisagreementCount"] == 1


def test_missing_human_gold_fails_closed() -> None:
    machine, _, m3_core = fixture()
    report = evaluate(machine, {"recordings": []}, m3_core)
    assert report["releaseGateReady"] is False
    assert "m3plus-rescope-human-gold-missing" in report["blockingReasons"]
    assert "m3plus-rescope-straight-intonation-gold-join-missing" in report["blockingReasons"]
    assert "m3plus-rescope-center-intonation-gold-join-missing" in report["blockingReasons"]


def test_deleting_declared_inventory_cannot_create_false_green() -> None:
    machine, human, m3_core = fixture()
    human["recordings"][0]["trillExpectedNoteCount"] = 0
    add_all_intonation_gold(machine, human)
    report = evaluate(machine, human, m3_core)
    assert report["releaseGateReady"] is False
    assert report["zones"]["scoreMarkedNeutral"]["expectedProtectedCount"] == 14
    assert report["zones"]["scoreMarkedNeutral"]["evaluatedProtectedCount"] == 8
    assert report["zones"]["scoreMarkedNeutral"]["declaredOnlyProtectedCount"] == 6


if __name__ == "__main__":
    test_current_evidence_is_red_without_note_level_gold_join()
    test_fully_bound_future_fixture_can_pass()
    test_source_bindings_are_required_and_hash_bytes()
    test_m3_core_onset_must_really_pass()
    test_unstable_cases_are_enumerated_from_raw_diagnostics()
    test_center_gold_disagreement_closes_gate()
    test_missing_human_gold_fails_closed()
    test_deleting_declared_inventory_cannot_create_false_green()
    print("western M3+ rescope gate integrity tests passed")
