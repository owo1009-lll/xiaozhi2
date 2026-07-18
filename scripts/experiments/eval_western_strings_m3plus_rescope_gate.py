#!/usr/bin/env python3
"""Evaluate the respecified M3+ pitch-safety gate.

This gate does not detect or name techniques. Score-marked trill, ornament,
and harmonic regions are neutralized; stable F0 evidence is used only for
center-pitch decisions. Missing or unstable evidence always fails closed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
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
DEFAULT_M3_CORE_GATE = (
    REPO / "data" / "experiments" / "western-strings-m3" / "m3-diagnosis-summary.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3plus"
    / "rescope-gate"
    / "report.json"
)
RESCOPE_DECISION = "docs/western-strings-m3plus-rescope-decision.md"
RESCOPE_DECISION_PATH = REPO / RESCOPE_DECISION
CONTRACT = "m3plus-rescope-four-zone-v2"
MARKED_BEHAVIORS = {"trill", "ornament-upper-mordent", "harmonic"}
SOURCE_BINDING_KEYS = {"machineSource", "humanGold", "m3CoreGate", "rescopeDecision"}
INTONATION_LABELS = {"in-tune", "sharp", "flat", "wrong-note"}
EXPECTED_STRAIGHT_UNIT_COUNT = 12
EXPECTED_TECHNIQUE_CENTER_UNIT_COUNT = 8
EXPECTED_PROTECTED_UNIT_COUNT = 14
EXPECTED_ROUND2_PROTECTED_UNIT_COUNT = 6


def generated_at_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def display_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO.resolve()).as_posix()
    except ValueError:
        return resolved.as_posix()


def build_source_binding(path: Path) -> dict[str, str]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": display_path(path), "sha256": digest.hexdigest()}


def source_bindings_ready(bindings: dict[str, Any] | None) -> bool:
    if not isinstance(bindings, dict) or set(bindings) != SOURCE_BINDING_KEYS:
        return False
    for binding in bindings.values():
        if not isinstance(binding, dict):
            return False
        path_value = str(binding.get("path") or "").strip()
        sha_value = str(binding.get("sha256") or "").strip().lower()
        if not path_value or len(sha_value) != 64:
            return False
        try:
            int(sha_value, 16)
        except ValueError:
            return False
    return True


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


def unit_key(row: dict[str, Any]) -> tuple[str, int, int]:
    return (
        str(row.get("recordingId") or "").strip(),
        int(row.get("measure") or 0),
        int(row.get("unitIndex") if row.get("unitIndex") is not None else -1),
    )


def unit_key_text(row: dict[str, Any]) -> str:
    recording_id, measure, unit_index = unit_key(row)
    return f"{recording_id}:m{measure}:u{unit_index}"


def independently_unstable_reason(
    row: dict[str, Any],
    *,
    max_straight_spread_cents: float,
    max_vibrato_iqr_cents: float,
    minimum_slide_tail_target_rate: float,
    minimum_slide_pitch_support_rate: float,
) -> str | None:
    """Label raw holdout diagnostics as unstable without consulting a decision."""
    if row.get("localizationUnitReady") is not True:
        return None
    diagnostics = row.get("modeDiagnostics") or {}
    if diagnostics.get("f0QualityReady") is not True:
        return None
    behavior = str(row.get("expectedBehavior") or "unknown")
    if behavior == "stable":
        spread = finite_number(diagnostics.get("spreadCentsP95P05"))
        if spread is not None and spread > max_straight_spread_cents:
            return "straight-f0-dispersion-too-high"
    elif behavior == "vibrato":
        spread = finite_number(diagnostics.get("iqrCents"))
        if spread is not None and spread > max_vibrato_iqr_cents:
            return "vibrato-center-dispersion-too-high"
    elif behavior == "slide-source":
        tail_base_rate = finite_number(diagnostics.get("knownTailBaseRatio"))
        pitch_support_rate = finite_number(diagnostics.get("knownPairSupportRate"))
        if tail_base_rate is None or pitch_support_rate is None:
            return None
        if (
            1.0 - tail_base_rate < minimum_slide_tail_target_rate
            or pitch_support_rate < minimum_slide_pitch_support_rate
        ):
            return "slide-target-tail-unstable"
    return None


def evaluate_m3_core_onset(m3_core_gate: dict[str, Any]) -> dict[str, Any]:
    gate = m3_core_gate.get("gate") or {}
    onset = (m3_core_gate.get("categories") or {}).get("onset") or {}
    minimum_precision = finite_number(gate.get("minPrecision"))
    precision = finite_number(onset.get("precision"))
    auto_issue_count = finite_number(onset.get("autoIssueCount"))
    unsafe_issue_count = finite_number(onset.get("unsafeIssueCount"))
    required_categories = set(gate.get("requiredCategories") or [])
    overall_ready = bool(
        m3_core_gate.get("ok") is True
        and m3_core_gate.get("diagnosisGateReady") is True
    )
    onset_ready = bool(
        overall_ready
        and "onset" in required_categories
        and onset.get("requiredForRelease") is True
        and onset.get("ready") is True
        and onset.get("status") == "ready"
        and auto_issue_count is not None
        and auto_issue_count > 0
        and precision is not None
        and minimum_precision is not None
        and precision >= minimum_precision
        and unsafe_issue_count == 0
    )
    return {
        "m3CoreGateReady": overall_ready,
        "onsetReady": onset_ready,
        "onsetAutoIssueCount": auto_issue_count,
        "onsetPrecision": precision,
        "onsetUnsafeIssueCount": unsafe_issue_count,
        "minimumPrecision": minimum_precision,
    }


def intonation_gold_by_unit(human_gold: dict[str, Any]) -> tuple[dict[tuple[str, int, int], dict[str, Any]], int]:
    rows = human_gold.get("intonationGoldUnits") or []
    indexed: dict[tuple[str, int, int], dict[str, Any]] = {}
    duplicate_count = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        label = str(row.get("pitchAccuracyLabel") or "").strip()
        if row.get("intonationGoldVerified") is not True or label not in INTONATION_LABELS:
            continue
        key = unit_key(row)
        if not key[0] or key[2] < 0:
            continue
        if key in indexed:
            duplicate_count += 1
            continue
        indexed[key] = row
    return indexed, duplicate_count


def protected_gold_by_unit(human_gold: dict[str, Any]) -> tuple[set[tuple[str, int, int]], int]:
    indexed: set[tuple[str, int, int]] = set()
    duplicate_count = 0
    for row in human_gold.get("protectedScoreUnits") or []:
        if not isinstance(row, dict) or row.get("scoreProtectionVerified") is not True:
            continue
        key = unit_key(row)
        if not key[0] or key[2] < 0:
            continue
        if key in indexed:
            duplicate_count += 1
            continue
        indexed.add(key)
    return indexed, duplicate_count


def summarize_intonation_gold(
    source_rows: list[dict[str, Any]],
    decisions: list[dict[str, Any]],
    intonation_gold: dict[tuple[str, int, int], dict[str, Any]],
    duplicate_gold_count: int,
    expected_unit_count: int,
) -> dict[str, Any]:
    scored_decisions = [row for row in decisions if row["decision"] != "insufficient_evidence"]
    joined_units = [row for row in source_rows if unit_key(row) in intonation_gold]
    joined_scored = [row for row in scored_decisions if unit_key(row) in intonation_gold]
    agreement_count = 0
    false_positive_count = 0
    for decision in joined_scored:
        gold_label = str(intonation_gold[unit_key(decision)].get("pitchAccuracyLabel") or "")
        expected_decision = "confirmed_center" if gold_label == "in-tune" else "issue_detected"
        if decision["decision"] == expected_decision:
            agreement_count += 1
        if decision["decision"] == "issue_detected" and gold_label == "in-tune":
            false_positive_count += 1
    disagreement_count = len(joined_scored) - agreement_count
    agreement_rate = agreement_count / len(joined_scored) if joined_scored else None
    join_ready = bool(
        len(source_rows) == expected_unit_count
        and len(joined_units) == expected_unit_count
        and len(joined_scored) == len(scored_decisions)
        and duplicate_gold_count == 0
    )
    return {
        "intonationGoldExpectedUnitCount": expected_unit_count,
        "intonationGoldObservedUnitCount": len(source_rows),
        "intonationGoldJoinedUnitCount": len(joined_units),
        "intonationGoldUnjoinedUnitCount": expected_unit_count - len(joined_units),
        "intonationGoldExpectedDecisionCount": len(scored_decisions),
        "intonationGoldJoinedDecisionCount": len(joined_scored),
        "intonationGoldUnjoinedDecisionCount": len(scored_decisions) - len(joined_scored),
        "intonationGoldAgreementCount": agreement_count,
        "intonationGoldDisagreementCount": disagreement_count,
        "intonationGoldAgreementRate": (
            round(agreement_rate, 6) if agreement_rate is not None else None
        ),
        "intonationGoldFalsePositiveCount": false_positive_count,
        "intonationGoldDuplicateUnitCount": duplicate_gold_count,
        "goldJoinReady": join_ready,
    }


def evaluate_rescope_gate(
    machine_report: dict[str, Any],
    human_gold: dict[str, Any],
    m3_core_gate: dict[str, Any],
    *,
    source_bindings: dict[str, Any] | None = None,
    generated_at: str | None = None,
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
    decision_by_key = {unit_key(row): row for row in decisions}
    straight_decisions = [row for row in decisions if row["zone"] == "unmarked_straight"]
    center_decisions = [row for row in decisions if row["zone"] == "technique_center"]
    marked_decisions = [row for row in decisions if row["zone"] == "score_marked_neutral"]
    center_source_rows = [
        row for row in holdout_rows
        if str(row.get("expectedBehavior") or "") in {"vibrato", "slide-source"}
    ]
    straight = summarize_zone(straight_decisions, minimum_straight_decisions)
    intonation_gold, duplicate_gold_count = intonation_gold_by_unit(human_gold)
    straight_gold = summarize_intonation_gold(
        [row for row in holdout_rows if str(row.get("expectedBehavior") or "") == "stable"],
        straight_decisions,
        intonation_gold,
        duplicate_gold_count,
        EXPECTED_STRAIGHT_UNIT_COUNT,
    )
    straight.update(straight_gold)
    straight["evidenceSemantics"] = (
        "score-intent center probe plus independent per-unit intonation-gold agreement"
    )

    verified_gold = [
        row for row in human_gold.get("recordings") or []
        if row.get("performanceExecutionVerified") is True
    ]
    round2_marked_count = sum(int(row.get("trillExpectedNoteCount") or 0) for row in verified_gold)
    round2_unscored_vibrato_count = sum(
        int(row.get("vibratoExpectedLongNoteCount") or 0) for row in verified_gold
    )
    protected_gold_units, protected_gold_duplicate_count = protected_gold_by_unit(human_gold)
    evaluated_protected_keys = {unit_key(row) for row in marked_decisions}
    joined_round2_protected_count = len(protected_gold_units & evaluated_protected_keys)
    protected_gold_inventory_ready = bool(
        round2_marked_count == EXPECTED_ROUND2_PROTECTED_UNIT_COUNT
        and len(protected_gold_units) == EXPECTED_ROUND2_PROTECTED_UNIT_COUNT
        and protected_gold_duplicate_count == 0
    )
    declared_only_protected_count = (
        EXPECTED_ROUND2_PROTECTED_UNIT_COUNT - joined_round2_protected_count
        if protected_gold_inventory_ready
        else EXPECTED_ROUND2_PROTECTED_UNIT_COUNT
    )
    marked_accusations = sum(row["accusationIssued"] for row in marked_decisions)
    marked_insufficient = sum(
        row["decision"] == "insufficient_evidence" for row in marked_decisions
    )
    marked = {
        "m3pHoldoutMarkedCount": len(marked_decisions),
        "evaluatedProtectedCount": len(marked_decisions),
        "declaredOnlyProtectedCount": declared_only_protected_count,
        "expectedProtectedCount": EXPECTED_PROTECTED_UNIT_COUNT,
        "totalProtectedCount": EXPECTED_PROTECTED_UNIT_COUNT,
        "totalDeclaredOrEvaluatedCount": len(marked_decisions) + declared_only_protected_count,
        "protectedGoldExpectedUnitCount": EXPECTED_ROUND2_PROTECTED_UNIT_COUNT,
        "protectedGoldJoinedUnitCount": joined_round2_protected_count,
        "protectedGoldDuplicateUnitCount": protected_gold_duplicate_count,
        "protectedGoldInventoryReady": protected_gold_inventory_ready,
        "insufficientEvidenceCount": marked_insufficient,
        "accusationCount": marked_accusations,
        "policy": "score markings force neutral review; audio technique detection is not consulted",
    }
    independently_unstable = [
        (row, reason)
        for row in holdout_rows
        if (
            reason := independently_unstable_reason(
                row,
                max_straight_spread_cents=max_straight_spread_cents,
                max_vibrato_iqr_cents=max_vibrato_iqr_cents,
                minimum_slide_tail_target_rate=minimum_slide_tail_target_rate,
                minimum_slide_pitch_support_rate=minimum_slide_pitch_support_rate,
            )
        ) is not None
    ]
    unstable_decisions = [decision_by_key.get(unit_key(row)) for row, _ in independently_unstable]
    unstable_guard = {
        "enumerationSource": "raw-holdout-diagnostics-before-policy-decision",
        "expectedCaseCount": len(independently_unstable),
        "expectedCaseKeys": [unit_key_text(row) for row, _ in independently_unstable],
        "expectedReasons": [reason for _, reason in independently_unstable],
        "testedCount": sum(row is not None for row in unstable_decisions),
        "insufficientEvidenceCount": sum(
            row is not None and row["decision"] == "insufficient_evidence"
            for row in unstable_decisions
        ),
        "accusationCount": sum(
            row is not None and row["accusationIssued"] for row in unstable_decisions
        ),
    }

    scored_center_decisions = [
        row for row in center_decisions if row["decision"] != "insufficient_evidence"
    ]
    center_gold = summarize_intonation_gold(
        center_source_rows,
        center_decisions,
        intonation_gold,
        duplicate_gold_count,
        EXPECTED_TECHNIQUE_CENTER_UNIT_COUNT,
    )
    score_intent_agreement_count = sum(
        row["decision"] == "confirmed_center" for row in scored_center_decisions
    )
    score_intent_agreement_rate = (
        score_intent_agreement_count / len(scored_center_decisions)
        if scored_center_decisions else None
    )
    center = {
        "evidenceSemantics": "score-intent-center-agreement; not human-intonation-gold precision",
        "expectedCount": len(center_source_rows),
        "decisionCount": len(scored_center_decisions),
        "insufficientEvidenceCount": len(center_source_rows) - len(scored_center_decisions),
        "decisionCoverage": round(
            len(scored_center_decisions) / len(center_source_rows), 6
        ) if center_source_rows else 0.0,
        "scoreIntentCenterAgreementCount": score_intent_agreement_count,
        "scoreIntentIssueCount": sum(
            row["decision"] == "issue_detected" for row in scored_center_decisions
        ),
        "scoreIntentCenterAgreementRate": (
            round(score_intent_agreement_rate, 6)
            if score_intent_agreement_rate is not None else None
        ),
        **center_gold,
    }

    m3_core = evaluate_m3_core_onset(m3_core_gate)
    bindings_ready = source_bindings_ready(source_bindings)

    straight["gatePassed"] = bool(
        straight["decisionCount"] >= minimum_straight_decisions
        and straight["precision"] is not None
        and straight["precision"] >= minimum_precision
        and straight["unsafeAccusationCount"] == 0
        and straight["goldJoinReady"]
        and straight["intonationGoldAgreementRate"] is not None
        and straight["intonationGoldAgreementRate"] >= minimum_precision
        and straight["intonationGoldFalsePositiveCount"] == 0
    )
    center["gatePassed"] = bool(
        center["decisionCount"] >= minimum_technique_center_decisions
        and center["scoreIntentCenterAgreementRate"] is not None
        and center["scoreIntentCenterAgreementRate"] >= minimum_precision
        and center["goldJoinReady"]
        and center["intonationGoldAgreementRate"] is not None
        and center["intonationGoldAgreementRate"] >= minimum_precision
        and center["intonationGoldFalsePositiveCount"] == 0
    )
    marked["gatePassed"] = bool(
        marked["evaluatedProtectedCount"] == EXPECTED_PROTECTED_UNIT_COUNT
        and marked["insufficientEvidenceCount"] == marked["evaluatedProtectedCount"]
        and marked["accusationCount"] == 0
        and marked["declaredOnlyProtectedCount"] == 0
        and marked["protectedGoldInventoryReady"]
        and marked["protectedGoldJoinedUnitCount"] == EXPECTED_ROUND2_PROTECTED_UNIT_COUNT
    )
    unstable_guard["gatePassed"] = bool(
        unstable_guard["expectedCaseCount"] > 0
        and unstable_guard["testedCount"] == unstable_guard["expectedCaseCount"]
        and unstable_guard["insufficientEvidenceCount"] == unstable_guard["expectedCaseCount"]
        and unstable_guard["accusationCount"] == 0
    )

    blockers: list[str] = []
    if not bindings_ready:
        blockers.append("m3plus-rescope-source-bindings-incomplete")
    if machine_report.get("scoreTechniqueIntentReady") is not True:
        blockers.append("m3plus-rescope-score-intent-not-ready")
    if not verified_gold:
        blockers.append("m3plus-rescope-human-gold-missing")
    elif round2_unscored_vibrato_count <= 0:
        blockers.append("m3plus-rescope-human-gold-content-missing")
    if not m3_core["m3CoreGateReady"]:
        blockers.append("m3plus-rescope-m3-core-gate-not-ready")
    if not m3_core["onsetReady"]:
        blockers.append("m3plus-rescope-m3-core-onset-not-ready")
    if not straight["goldJoinReady"]:
        blockers.append("m3plus-rescope-straight-intonation-gold-join-missing")
    elif (
        straight["intonationGoldAgreementRate"] is None
        or straight["intonationGoldAgreementRate"] < minimum_precision
        or straight["intonationGoldFalsePositiveCount"] > 0
    ):
        blockers.append("m3plus-rescope-straight-intonation-gold-agreement-failed")
    if not straight["gatePassed"]:
        blockers.append("m3plus-rescope-straight-pitch-safety-failed")
    if marked["declaredOnlyProtectedCount"] > 0:
        blockers.append("m3plus-rescope-score-marked-declared-only-not-evaluated")
    if not marked["gatePassed"]:
        blockers.append("m3plus-rescope-score-marked-neutrality-failed")
    if not center["goldJoinReady"]:
        blockers.append("m3plus-rescope-center-intonation-gold-join-missing")
    elif (
        center["intonationGoldAgreementRate"] is None
        or center["intonationGoldAgreementRate"] < minimum_precision
        or center["intonationGoldFalsePositiveCount"] > 0
    ):
        blockers.append("m3plus-rescope-center-intonation-gold-agreement-failed")
    if not center["gatePassed"]:
        blockers.append("m3plus-rescope-technique-center-pitch-safety-failed")
    if not unstable_guard["gatePassed"]:
        blockers.append("m3plus-rescope-unstable-fail-closed-failed")

    return {
        "schemaVersion": 2,
        "contract": CONTRACT,
        "generatedAt": generated_at or generated_at_utc(),
        "purpose": "M3+ pitch-safety evaluation after technique-detector rescope",
        "rescopeDecisionSource": RESCOPE_DECISION,
        "evalOnly": True,
        "studentFacing": False,
        "studentGateReady": False,
        "productionPolicyChanged": False,
        "releaseGateReady": not blockers,
        "sourceBindingsReady": bindings_ready,
        "sourceBindings": source_bindings or {},
        "thresholds": {
            "pitchToleranceCents": pitch_tolerance_cents,
            "minimumPrecision": minimum_precision,
            "maxStraightSpreadCents": max_straight_spread_cents,
            "maxVibratoIqrCents": max_vibrato_iqr_cents,
            "minimumSlideTailTargetRate": minimum_slide_tail_target_rate,
            "minimumSlidePitchSupportRate": minimum_slide_pitch_support_rate,
            "minimumStraightDecisions": minimum_straight_decisions,
            "minimumTechniqueCenterDecisions": minimum_technique_center_decisions,
            "expectedStraightUnitCount": EXPECTED_STRAIGHT_UNIT_COUNT,
            "expectedTechniqueCenterUnitCount": EXPECTED_TECHNIQUE_CENTER_UNIT_COUNT,
            "expectedProtectedUnitCount": EXPECTED_PROTECTED_UNIT_COUNT,
            "expectedRound2ProtectedUnitCount": EXPECTED_ROUND2_PROTECTED_UNIT_COUNT,
            "evaluationSplit": "holdout-only",
        },
        "sourceEvidence": {
            "scoreTechniqueIntentReady": machine_report.get("scoreTechniqueIntentReady") is True,
            "verifiedHumanGoldRecordingCount": len(verified_gold),
            "round2DeclaredOnlyMarkedCount": round2_marked_count,
            "round2UnscoredVibratoGoldCount": round2_unscored_vibrato_count,
            "round2UnscoredVibratoReason": "stable-center F0 evidence is not present in the legacy aligned report",
            "m3CoreOnset": m3_core,
            "straightIntonationGoldJoinReady": straight["goldJoinReady"],
            "centerIntonationGoldJoinReady": center["goldJoinReady"],
        },
        "zones": {
            "unmarkedStraight": straight,
            "scoreMarkedNeutral": marked,
            "techniqueCenter": center,
            "unstableFailClosed": unstable_guard,
            "rhythmOnset": {
                "policy": "delegated-to-m3-core",
                "changedByThisGate": False,
                "m3CoreGateReady": m3_core["m3CoreGateReady"],
                "onsetReady": m3_core["onsetReady"],
                "gatePassed": m3_core["onsetReady"],
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
    parser.add_argument("--m3-core-gate", type=Path, default=DEFAULT_M3_CORE_GATE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.source.is_file():
        raise SystemExit(f"missing M3+ machine report: {args.source}")
    if not args.human_gold.is_file():
        raise SystemExit(f"missing M3+ human gold: {args.human_gold}")
    if not args.m3_core_gate.is_file():
        raise SystemExit(f"missing M3 core gate: {args.m3_core_gate}")
    if not RESCOPE_DECISION_PATH.is_file():
        raise SystemExit(f"missing M3+ rescope decision: {RESCOPE_DECISION_PATH}")
    source_bindings = {
        "machineSource": build_source_binding(args.source),
        "humanGold": build_source_binding(args.human_gold),
        "m3CoreGate": build_source_binding(args.m3_core_gate),
        "rescopeDecision": build_source_binding(RESCOPE_DECISION_PATH),
    }
    report = evaluate_rescope_gate(
        json.loads(args.source.read_text(encoding="utf-8")),
        json.loads(args.human_gold.read_text(encoding="utf-8")),
        json.loads(args.m3_core_gate.read_text(encoding="utf-8")),
        source_bindings=source_bindings,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["releaseGateReady"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
