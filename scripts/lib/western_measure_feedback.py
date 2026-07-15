"""Conservative note-to-measure feedback aggregation for Western strings.

This module is evidence plumbing, not a release decision. It intentionally
distinguishes "confirmed clean" from "no issue was detected".
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any


CONFIRMED_CORRECT = "confirmed_correct"
ISSUE_DETECTED = "issue_detected"
UNCERTAIN = "uncertain"
UNSUPPORTED = "unsupported"
VALID_NOTE_STATES = {CONFIRMED_CORRECT, ISSUE_DETECTED, UNCERTAIN, UNSUPPORTED}


def summarize_measure_evidence(
    note_rows: list[dict[str, Any]],
    *,
    min_confirmed_fraction: float = 0.80,
) -> dict[str, Any]:
    if not 0.0 <= min_confirmed_fraction <= 1.0:
        raise ValueError("min_confirmed_fraction must be within [0, 1]")
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    invalid_rows = 0
    for row in note_rows:
        try:
            measure = int(row.get("measureIndex") or 0)
        except (TypeError, ValueError):
            measure = 0
        state = str(row.get("evidenceState") or "").strip()
        if measure <= 0 or state not in VALID_NOTE_STATES:
            invalid_rows += 1
            continue
        grouped[measure].append(row)

    measures = []
    for measure_index, rows in sorted(grouped.items()):
        counts = {state: 0 for state in VALID_NOTE_STATES}
        for row in rows:
            counts[str(row["evidenceState"]).strip()] += 1
        total = len(rows)
        confirmed_fraction = counts[CONFIRMED_CORRECT] / total if total else 0.0
        if counts[ISSUE_DETECTED] > 0:
            decision = "issue_detected"
            reason = "high-confidence-note-issue-present"
        elif confirmed_fraction >= min_confirmed_fraction:
            decision = "confirmed_clean"
            reason = "sufficient-confirmed-note-coverage-without-issue"
        else:
            decision = "insufficient_evidence"
            reason = "confirmed-note-coverage-below-threshold"
        measures.append({
            "measureIndex": measure_index,
            "decision": decision,
            "reason": reason,
            "noteCount": total,
            "confirmedCorrectCount": counts[CONFIRMED_CORRECT],
            "issueCount": counts[ISSUE_DETECTED],
            "uncertainCount": counts[UNCERTAIN],
            "unsupportedCount": counts[UNSUPPORTED],
            "confirmedFraction": round(confirmed_fraction, 6),
            "studentMessageAllowed": decision in {"issue_detected", "confirmed_clean"},
        })

    decision_counts = {
        decision: sum(1 for row in measures if row["decision"] == decision)
        for decision in ("issue_detected", "confirmed_clean", "insufficient_evidence")
    }
    decided = decision_counts["issue_detected"] + decision_counts["confirmed_clean"]
    return {
        "measureCount": len(measures),
        "decidedMeasureCount": decided,
        "decisionCoverage": round(decided / len(measures), 6) if measures else 0.0,
        "decisionCounts": decision_counts,
        "invalidRowCount": invalid_rows,
        "minConfirmedFraction": min_confirmed_fraction,
        "measures": measures,
    }
