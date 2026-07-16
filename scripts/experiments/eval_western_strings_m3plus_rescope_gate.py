#!/usr/bin/env python3
"""Evaluate the respecified M3+ pitch-safety gate.

This gate does not detect or name techniques. Score-marked trill, ornament,
and harmonic regions are neutralized; stable F0 evidence is used only for
center-pitch decisions. Missing or unstable evidence always fails closed.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3plus"
    / "supplemental-machine-eval"
    / "supplemental-machine-eval.json"
)
DEFAULT_HUMAN_GOLD = REPO / "docs" / "western-strings-round2-m3plus-human-gold.json"
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3plus"
    / "rescope-gate"
    / "report.json"
)
RESCOPE_DECISION = "docs/western-strings-m3plus-rescope-decision.md"
MARKED_BEHAVIORS = {"trill", "ornament-upper-mordent", "harmonic"}


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def flatten_rows(machine_report: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for recording in machine_report.get("recordings") or []:
        for source_row in recording.get("rows") or []:
            row = dict(source_row)
            row.setdefault("recordingId", recording.get("recordingId"))
            rows.append(row)
    return rows


def _insufficient(row: dict[str, Any], zone: str, reason: str) -> dict[str, Any]:
    return {
        "recordingId": row.get("recordingId"),
        "measure": row.get("measure"),
        "unitIndex": row.get("unitIndex"),
        "evaluationSplit": row.get("evaluationSplit"),
        "expectedBehavior": row.get("expectedBehavior"),
        "zone": zone,
        "decision": "insufficient_evidence",
        "reason": reason,
        "centerErrorCents": None,
        "dispersionCents": None,
        "accusationIssued": False,
    }


def evaluate_holdout_row(
    row: dict[str, Any],
    *,
    pitch_tolerance_cents: float,
    max_straight_spread_cents: float,
    max_vibrato_iqr_cents: float,
    minimum_slide_tail_target_rate: float,
    minimum_slide_pitch_support_rate: float,
) -> dict[str, Any]:
    behavior = str(row.get("expectedBehavior") or "unknown")
    diagnostics = row.get("modeDiagnostics") or {}

    if behavior in MARKED_BEHAVIORS:
        return _insufficient(row, "score_marked_neutral", "score-marked-region-neutralized")

    if behavior not in {"stable", "vibrato", "slide-source"}:
        return _insufficient(row, "unsupported", "unsupported-pitch-behavior")
    zone = "unmarked_straight" if behavior == "stable" else "technique_center"
    if row.get("localizationUnitReady") is not True:
        return _insufficient(row, zone, "localization-not-ready")
    if diagnostics.get("f0QualityReady") is not True:
        return _insufficient(row, zone, "f0-quality-not-ready")

    error_cents: float | None
    dispersion_cents: float | None
    if behavior == "stable":
        error_cents = finite_number(diagnostics.get("medianCents"))
        dispersion_cents = finite_number(diagnostics.get("spreadCentsP95P05"))
        if dispersion_cents is None:
            return _insufficient(row, zone, "straight-dispersion-missing")
        if dispersion_cents > max_straight_spread_cents:
            result = _insufficient(row, zone, "straight-f0-dispersion-too-high")
            result["dispersionCents"] = round(dispersion_cents, 6)
            return result
    elif behavior == "vibrato":
        error_cents = finite_number(diagnostics.get("medianCents"))
        dispersion_cents = finite_number(diagnostics.get("iqrCents"))
        if dispersion_cents is None:
            return _insufficient(row, zone, "vibrato-center-dispersion-missing")
        if dispersion_cents > max_vibrato_iqr_cents:
            result = _insufficient(row, zone, "vibrato-center-dispersion-too-high")
            result["dispersionCents"] = round(dispersion_cents, 6)
            return result
    else:
        base_midi = finite_number(row.get("baseMidi"))
        auxiliary_midi = finite_number(row.get("auxiliaryMidi"))
        exit_cents = finite_number(diagnostics.get("exitCents"))
        tail_base_rate = finite_number(diagnostics.get("knownTailBaseRatio"))
        pitch_support_rate = finite_number(diagnostics.get("knownPairSupportRate"))
        if None in (base_midi, auxiliary_midi, exit_cents, tail_base_rate, pitch_support_rate):
            return _insufficient(row, zone, "slide-target-tail-evidence-missing")
        tail_target_rate = 1.0 - float(tail_base_rate)
        if (
            tail_target_rate < minimum_slide_tail_target_rate
            or float(pitch_support_rate) < minimum_slide_pitch_support_rate
        ):
            result = _insufficient(row, zone, "slide-target-tail-unstable")
            result["slideTailTargetRate"] = round(tail_target_rate, 6)
            result["slidePitchSupportRate"] = round(float(pitch_support_rate), 6)
            return result
        interval_cents = (float(auxiliary_midi) - float(base_midi)) * 100.0
        error_cents = float(exit_cents) - interval_cents
        dispersion_cents = None

    if error_cents is None:
        return _insufficient(row, zone, "center-pitch-evidence-missing")
    issue = abs(error_cents) > pitch_tolerance_cents
    return {
        "recordingId": row.get("recordingId"),
        "measure": row.get("measure"),
        "unitIndex": row.get("unitIndex"),
        "evaluationSplit": row.get("evaluationSplit"),
        "expectedBehavior": behavior,
        "zone": zone,
        "decision": "issue_detected" if issue else "confirmed_center",
        "reason": "center-pitch-outside-tolerance" if issue else "center-pitch-within-tolerance",
        "centerErrorCents": round(float(error_cents), 6),
        "dispersionCents": round(float(dispersion_cents), 6) if dispersion_cents is not None else None,
        "accusationIssued": issue,
    }


def summarize_zone(rows: list[dict[str, Any]], minimum_decisions: int) -> dict[str, Any]:
    scored = [row for row in rows if row["decision"] != "insufficient_evidence"]
    confirmed = sum(row["decision"] == "confirmed_center" for row in scored)
    unsafe = sum(row["decision"] == "issue_detected" for row in scored)
    precision = confirmed / len(scored) if scored else None
    return {
        "expectedCount": len(rows),
        "decisionCount": len(scored),
        "confirmedCenterCount": confirmed,
        "unsafeAccusationCount": unsafe,
        "insufficientEvidenceCount": len(rows) - len(scored),
        "decisionCoverage": round(len(scored) / len(rows), 6) if rows else 0.0,
        "precision": round(precision, 6) if precision is not None else None,
        "minimumDecisionCount": minimum_decisions,
    }


def evaluate_rescope_gate(
    machine_report: dict[str, Any],
    human_gold: dict[str, Any],
    *,
    pitch_tolerance_cents: float = 50.0,
    minimum_precision: float = 0.90,
    max_straight_spread_cents: float = 80.0,
    max_vibrato_iqr_cents: float = 80.0,
    minimum_slide_tail_target_rate: float = 0.70,
    minimum_slide_pitch_support_rate: float = 0.65,
    minimum_straight_decisions: int = 4,
    minimum_technique_center_decisions: int = 2,
) -> dict[str, Any]:
    holdout_rows = [
        row for row in flatten_rows(machine_report)
        if row.get("evaluationSplit") == "holdout"
    ]
    decisions = [
        evaluate_holdout_row(
            row,
            pitch_tolerance_cents=pitch_tolerance_cents,
            max_straight_spread_cents=max_straight_spread_cents,
            max_vibrato_iqr_cents=max_vibrato_iqr_cents,
            minimum_slide_tail_target_rate=minimum_slide_tail_target_rate,
            minimum_slide_pitch_support_rate=minimum_slide_pitch_support_rate,
        )
        for row in holdout_rows
    ]
    straight_rows = [row for row in decisions if row["zone"] == "unmarked_straight"]
    center_rows = [row for row in decisions if row["zone"] == "technique_center"]
    marked_rows = [row for row in decisions if row["zone"] == "score_marked_neutral"]
    straight = summarize_zone(straight_rows, minimum_straight_decisions)
    center = summarize_zone(center_rows, minimum_technique_center_decisions)

    verified_gold = [
        row for row in human_gold.get("recordings") or []
        if row.get("performanceExecutionVerified") is True
    ]
    round2_marked_count = sum(int(row.get("trillExpectedNoteCount") or 0) for row in verified_gold)
    round2_unscored_vibrato_count = sum(
        int(row.get("vibratoExpectedLongNoteCount") or 0) for row in verified_gold
    )
    marked_accusations = sum(row["accusationIssued"] for row in marked_rows)
    marked = {
        "m3pHoldoutMarkedCount": len(marked_rows),
        "round2HumanGoldMarkedCount": round2_marked_count,
        "totalProtectedCount": len(marked_rows) + round2_marked_count,
        "insufficientEvidenceCount": len(marked_rows) + round2_marked_count,
        "accusationCount": marked_accusations,
        "policy": "score markings force neutral review; audio technique detection is not consulted",
    }
    unstable_rows = [
        row for row in decisions
        if row["reason"] in {
            "straight-f0-dispersion-too-high",
            "vibrato-center-dispersion-too-high",
            "slide-target-tail-unstable",
        }
    ]
    unstable_guard = {
        "testedCount": len(unstable_rows),
        "insufficientEvidenceCount": sum(
            row["decision"] == "insufficient_evidence" for row in unstable_rows
        ),
        "accusationCount": sum(row["accusationIssued"] for row in unstable_rows),
    }

    straight["gatePassed"] = bool(
        straight["decisionCount"] >= minimum_straight_decisions
        and straight["precision"] is not None
        and straight["precision"] >= minimum_precision
        and straight["unsafeAccusationCount"] == 0
    )
    center["gatePassed"] = bool(
        center["decisionCount"] >= minimum_technique_center_decisions
        and center["precision"] is not None
        and center["precision"] >= minimum_precision
        and center["unsafeAccusationCount"] == 0
    )
    marked["gatePassed"] = bool(
        marked["totalProtectedCount"] > 0 and marked["accusationCount"] == 0
    )
    unstable_guard["gatePassed"] = bool(
        unstable_guard["testedCount"] > 0
        and unstable_guard["insufficientEvidenceCount"] == unstable_guard["testedCount"]
        and unstable_guard["accusationCount"] == 0
    )

    blockers: list[str] = []
    if machine_report.get("scoreTechniqueIntentReady") is not True:
        blockers.append("m3plus-rescope-score-intent-not-ready")
    if not verified_gold:
        blockers.append("m3plus-rescope-human-gold-missing")
    elif round2_marked_count <= 0 or round2_unscored_vibrato_count <= 0:
        blockers.append("m3plus-rescope-human-gold-content-missing")
    if not straight["gatePassed"]:
        blockers.append("m3plus-rescope-straight-pitch-safety-failed")
    if not marked["gatePassed"]:
        blockers.append("m3plus-rescope-score-marked-neutrality-failed")
    if not center["gatePassed"]:
        blockers.append("m3plus-rescope-technique-center-pitch-safety-failed")
    if not unstable_guard["gatePassed"]:
        blockers.append("m3plus-rescope-unstable-fail-closed-failed")

    return {
        "schemaVersion": 1,
        "purpose": "M3+ pitch-safety evaluation after technique-detector rescope",
        "rescopeDecisionSource": RESCOPE_DECISION,
        "evalOnly": True,
        "studentFacing": False,
        "studentGateReady": False,
        "productionPolicyChanged": False,
        "releaseGateReady": not blockers,
        "thresholds": {
            "pitchToleranceCents": pitch_tolerance_cents,
            "minimumPrecision": minimum_precision,
            "maxStraightSpreadCents": max_straight_spread_cents,
            "maxVibratoIqrCents": max_vibrato_iqr_cents,
            "minimumSlideTailTargetRate": minimum_slide_tail_target_rate,
            "minimumSlidePitchSupportRate": minimum_slide_pitch_support_rate,
            "minimumStraightDecisions": minimum_straight_decisions,
            "minimumTechniqueCenterDecisions": minimum_technique_center_decisions,
            "evaluationSplit": "holdout-only",
        },
        "sourceEvidence": {
            "scoreTechniqueIntentReady": machine_report.get("scoreTechniqueIntentReady") is True,
            "verifiedHumanGoldRecordingCount": len(verified_gold),
            "round2MarkedGoldCount": round2_marked_count,
            "round2UnscoredVibratoGoldCount": round2_unscored_vibrato_count,
            "round2UnscoredVibratoReason": "stable-center F0 evidence is not present in the legacy aligned report",
        },
        "zones": {
            "unmarkedStraight": straight,
            "scoreMarkedNeutral": marked,
            "techniqueCenter": center,
            "unstableFailClosed": unstable_guard,
            "rhythmOnset": {
                "policy": "delegated-to-m3-core",
                "changedByThisGate": False,
            },
        },
        "blockingReasons": blockers,
        "decisions": decisions,
        "researchOnlyEvidence": {
            "legacyTechniqueDetectorsRequiredForRelease": False,
            "coarseStateClassifierRequiredForRelease": False,
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--human-gold", type=Path, default=DEFAULT_HUMAN_GOLD)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.source.is_file():
        raise SystemExit(f"missing M3+ machine report: {args.source}")
    if not args.human_gold.is_file():
        raise SystemExit(f"missing M3+ human gold: {args.human_gold}")
    report = evaluate_rescope_gate(
        json.loads(args.source.read_text(encoding="utf-8")),
        json.loads(args.human_gold.read_text(encoding="utf-8")),
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["releaseGateReady"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
