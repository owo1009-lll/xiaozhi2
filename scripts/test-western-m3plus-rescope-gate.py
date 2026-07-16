from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m3plus_rescope_gate import evaluate_rescope_gate  # noqa: E402


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
        "iqrCents": spread / 2.0,
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


def fixture() -> tuple[dict, dict]:
    rows = [row("stable", index) for index in range(5)]
    rows[-1]["modeDiagnostics"]["spreadCentsP95P05"] = 120.0
    rows.extend([
        row("vibrato", 10, error=10.0),
        row("slide-source", 11, error=15.0),
        row("slide-source", 12, tail_base_rate=1.0),
    ])
    rows.extend([
        row("trill", 20, error=400.0),
        row("ornament-upper-mordent", 21, error=400.0),
        row("harmonic", 22, error=400.0),
        row("trill", 23, error=400.0),
    ])
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
    return machine, human


def test_rescope_gate_passes_without_technique_detection() -> None:
    machine, human = fixture()
    report = evaluate_rescope_gate(machine, human)
    assert report["releaseGateReady"] is True, report["blockingReasons"]
    assert report["zones"]["unmarkedStraight"]["precision"] == 1.0
    assert report["zones"]["techniqueCenter"]["precision"] == 1.0
    assert report["zones"]["scoreMarkedNeutral"]["accusationCount"] == 0
    assert report["zones"]["unstableFailClosed"]["testedCount"] == 2
    assert report["zones"]["unstableFailClosed"]["accusationCount"] == 0
    assert all(
        decision["decision"] == "insufficient_evidence"
        for decision in report["decisions"]
        if decision["zone"] == "score_marked_neutral"
    )
    assert {
        decision["expectedBehavior"]
        for decision in report["decisions"]
        if decision["zone"] == "score_marked_neutral"
    } == {"trill", "ornament-upper-mordent", "harmonic"}


def test_unsafe_center_accusation_closes_gate() -> None:
    machine, human = fixture()
    machine["recordings"][0]["rows"][0]["modeDiagnostics"]["medianCents"] = 75.0
    report = evaluate_rescope_gate(machine, human)
    assert report["releaseGateReady"] is False
    assert report["zones"]["unmarkedStraight"]["unsafeAccusationCount"] == 1
    assert "m3plus-rescope-straight-pitch-safety-failed" in report["blockingReasons"]


def test_missing_human_gold_fails_closed() -> None:
    machine, _ = fixture()
    report = evaluate_rescope_gate(machine, {"recordings": []})
    assert report["releaseGateReady"] is False
    assert "m3plus-rescope-human-gold-missing" in report["blockingReasons"]


def test_empty_human_gold_content_fails_closed() -> None:
    machine, human = fixture()
    human["recordings"][0]["trillExpectedNoteCount"] = 0
    human["recordings"][0]["vibratoExpectedLongNoteCount"] = 0
    report = evaluate_rescope_gate(machine, human)
    assert report["releaseGateReady"] is False
    assert "m3plus-rescope-human-gold-content-missing" in report["blockingReasons"]


if __name__ == "__main__":
    test_rescope_gate_passes_without_technique_detection()
    test_unsafe_center_accusation_closes_gate()
    test_missing_human_gold_fails_closed()
    test_empty_human_gold_content_fails_closed()
    print("western M3+ rescope gate tests passed")
