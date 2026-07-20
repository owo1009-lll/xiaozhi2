from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

from eval_western_m4_perfect_observation_upper_bound import evaluate_piece, portable, sha256
from eval_western_strings_m4_omr_benchmark import Note, align_notes, parse_notes, safe_rate
from eval_western_strings_m4_rhythm_candidate_oracle import (
    NOTATION_QUARTERS,
    TICKS_PER_QUARTER,
    MeasureRhythm,
    RhythmToken,
    _best_part_measures,
    parse_measure_rhythms_many,
)


REPO = Path(__file__).resolve().parents[2]
UPPER_BOUND = REPO / "data/experiments/western-strings-m4/perfect-observation-upper-bound/report.json"
NOTE_AUDIT = REPO / "data/experiments/western-strings-m4/render-gold-omr/render-gold-note-level-audit.json"
OUTPUT = REPO / "data/experiments/western-strings-m4/clean-constraint-solver-poc/report.json"
STRICT_THRESHOLD = 0.95
STOP_LOSS_TARGET = 0.80
ONSET_TOLERANCE_QUARTERS = 0.25


def duration_candidates(token: RhythmToken) -> tuple[int, ...]:
    original = max(1, int(round(token.duration_quarters * TICKS_PER_QUARTER)))
    bases: set[float] = set()
    if token.beam_count > 0:
        bases.add(1 / (2**token.beam_count))
    notation = NOTATION_QUARTERS.get(token.notation_type)
    if notation is not None:
        bases.add(notation)
    if not bases:
        return (original,)
    values = {
        max(1, int(round(base * (1.5 if token.dot_count else 1.0) * TICKS_PER_QUARTER)))
        for base in bases
    }
    values.add(original)
    return tuple(sorted(values))


def solve_measure(measure: MeasureRhythm, target_ticks: int) -> dict[str, Any]:
    if measure.has_backup or target_ticks <= 0 or not measure.tokens:
        return {"solved": False, "reason": "polyphonic-or-empty", "durationTicks": []}
    states: dict[int, tuple[float, int, tuple[int, ...]]] = {0: (0.0, 0, ())}
    for token in measure.tokens:
        original = max(1, int(round(token.duration_quarters * TICKS_PER_QUARTER)))
        next_states: dict[int, tuple[float, int, tuple[int, ...]]] = {}
        for total, (cost, changed, durations) in states.items():
            for ticks in duration_candidates(token):
                new_total = total + ticks
                if new_total > target_ticks:
                    continue
                candidate = (
                    cost + (0.0 if ticks == original else 1.0 + 0.25 * abs(math.log2(ticks / original))),
                    changed + int(ticks != original),
                    durations + (ticks,),
                )
                previous = next_states.get(new_total)
                if previous is None or candidate[:2] < previous[:2]:
                    next_states[new_total] = candidate
        states = next_states
        if not states:
            return {"solved": False, "reason": "meter-unreachable", "durationTicks": []}
    selected = states.get(target_ticks)
    if selected is None:
        return {"solved": False, "reason": "meter-unreachable", "durationTicks": []}
    cost, changed, durations = selected
    cursor = 0
    sounding_onsets: list[int] = []
    for token, ticks in zip(measure.tokens, durations):
        if token.sounding_note:
            sounding_onsets.append(cursor)
        cursor += ticks
    return {
        "solved": True,
        "reason": "",
        "durationTicks": list(durations),
        "soundingOnsetTicks": sounding_onsets,
        "changedTokenCount": changed,
        "cost": round(cost, 6),
        "meterSatisfied": cursor == target_ticks,
    }


def corrected_notes(
    gold_path: Path, draft_paths: list[Path]
) -> tuple[list[Note], dict[str, Any], list[dict[str, Any]]]:
    gold_measures = {row.measure_index: row for row in _best_part_measures(gold_path)}
    draft_measures = parse_measure_rhythms_many(draft_paths)
    notes: list[Note] = []
    cursor_ticks = 0
    counts: Counter[str] = Counter()
    details: list[dict[str, Any]] = []
    for draft in draft_measures:
        gold = gold_measures.get(draft.measure_index)
        target_ticks = gold.expected_ticks if gold is not None else draft.expected_ticks
        solution = solve_measure(draft, target_ticks)
        counts["measureCount"] += 1
        counts["solvedMeasureCount"] += int(solution["solved"])
        counts["changedMeasureCount"] += int(
            solution["solved"] and solution["changedTokenCount"] > 0
        )
        counts["changedTokenCount"] += int(solution.get("changedTokenCount") or 0)
        if solution["solved"]:
            unique_original = list(dict.fromkeys(draft.note_onset_ticks))
            sounding = list(solution["soundingOnsetTicks"])
            if len(unique_original) == len(sounding):
                onset_map = dict(zip(unique_original, sounding))
                relative = [onset_map[value] for value in draft.note_onset_ticks]
            elif len(draft.note_onset_ticks) == len(sounding):
                relative = sounding
            else:
                relative = list(draft.note_onset_ticks)
                counts["chordMappingFallbackMeasureCount"] += 1
        else:
            relative = list(draft.note_onset_ticks)
        for midi, onset_ticks in zip(draft.pitches, relative):
            notes.append(
                Note(
                    midi=midi,
                    onset_quarters=(cursor_ticks + onset_ticks) / TICKS_PER_QUARTER,
                    duration_quarters=0.0,
                    measure_index=draft.measure_index,
                )
            )
        cursor_ticks += target_ticks
        details.append(
            {
                "measure": draft.measure_index,
                "targetTicks": target_ticks,
                "beamTokenCount": sum(token.beam_count > 0 for token in draft.tokens),
                "dotTokenCount": sum(token.dot_count > 0 for token in draft.tokens),
                "tieTokenCount": sum(token.tie_start or token.tie_stop for token in draft.tokens),
                **solution,
            }
        )
    counts["meterSatisfiedMeasureCount"] = sum(
        row.get("meterSatisfied") is True for row in details
    )
    return notes, dict(counts), details


def evaluate_notes(gold: list[Note], draft: list[Note]) -> dict[str, Any]:
    pairs = align_notes(gold, draft)
    aligned = [(left, right) for left, right in pairs if left is not None and right is not None]
    onset_exact = 0
    measure_exact = 0
    pitch_exact = 0
    for left, right in aligned:
        gold_note = gold[int(left)]
        draft_note = draft[int(right)]
        pitch_exact += int(gold_note.midi == draft_note.midi)
        onset_exact += int(
            abs(gold_note.onset_quarters - draft_note.onset_quarters)
            <= ONSET_TOLERANCE_QUARTERS
        )
        measure_exact += int(gold_note.measure_index == draft_note.measure_index)
    onset = safe_rate(onset_exact, len(gold))
    measure = safe_rate(measure_exact, len(gold))
    return {
        "goldNotes": len(gold),
        "draftNotes": len(draft),
        "pitchExact": pitch_exact,
        "onsetExact": onset_exact,
        "measureExact": measure_exact,
        "pitchPrecision": round(safe_rate(pitch_exact, len(draft)), 6),
        "pitchRecall": round(safe_rate(pitch_exact, len(gold)), 6),
        "onsetQuarterAccuracy": round(onset, 6),
        "measureAccuracy": round(measure, 6),
        "onsetPassed": onset >= STRICT_THRESHOLD,
        "measurePassed": measure >= STRICT_THRESHOLD,
        "structurePassed": onset >= STRICT_THRESHOLD and measure >= STRICT_THRESHOLD,
    }


def summarize(rows: list[dict[str, Any]], requested: int) -> dict[str, Any]:
    usable = [row for row in rows if row["status"] == "ok"]
    gold = sum(row["metrics"]["goldNotes"] for row in usable)
    draft = sum(row["metrics"]["draftNotes"] for row in usable)
    onset_passed = sum(row["metrics"]["onsetPassed"] for row in usable)
    measure_passed = sum(row["metrics"]["measurePassed"] for row in usable)
    structure_passed = sum(row["metrics"]["structurePassed"] for row in usable)
    counts: Counter[str] = Counter()
    for row in usable:
        counts.update(row["solver"])
    return {
        "requestedPieceCount": requested,
        "evaluatedPieceCount": len(usable),
        "failedPieceCount": requested - len(usable),
        "goldNotes": gold,
        "draftNotes": draft,
        "pitchPrecision": round(safe_rate(sum(row["metrics"]["pitchExact"] for row in usable), draft), 6),
        "pitchRecall": round(safe_rate(sum(row["metrics"]["pitchExact"] for row in usable), gold), 6),
        "onsetQuarterAccuracy": round(safe_rate(sum(row["metrics"]["onsetExact"] for row in usable), gold), 6),
        "measureAccuracy": round(safe_rate(sum(row["metrics"]["measureExact"] for row in usable), gold), 6),
        "onsetPassedPieceCount": onset_passed,
        "onsetPassedPieceRateAllRequested": round(safe_rate(onset_passed, requested), 6),
        "measurePassedPieceCount": measure_passed,
        "measurePassedPieceRateAllRequested": round(safe_rate(measure_passed, requested), 6),
        "structurePassedPieceCount": structure_passed,
        "structurePassedPieceRateAllRequested": round(safe_rate(structure_passed, requested), 6),
        **dict(counts),
        "meterSatisfiedMeasureRate": round(
            safe_rate(counts["meterSatisfiedMeasureCount"], counts["measureCount"]), 6
        ),
    }


def main() -> int:
    upper = json.loads(UPPER_BOUND.read_text(encoding="utf-8"))
    note_audit = json.loads(NOTE_AUDIT.read_text(encoding="utf-8"))
    source_by_piece = {row["piece"]: row for row in note_audit["rows"]}
    rows: list[dict[str, Any]] = []
    for upper_row in upper["rows"]:
        if upper_row["status"] != "ok":
            rows.append(
                {
                    "pieceId": upper_row["pieceId"],
                    "status": "upstream-error",
                    "error": upper_row.get("error", "perfect-observation-decode-failed"),
                }
            )
            continue
        piece_id = upper_row["pieceId"]
        source = source_by_piece[piece_id]
        gold_path = REPO / source["goldScore"]
        draft_paths = [REPO / page["output"] for page in upper_row["pages"]]
        try:
            baseline = evaluate_piece(gold_path, draft_paths)
            corrected, solver, details = corrected_notes(gold_path, draft_paths)
            metrics = evaluate_notes(parse_notes(gold_path), corrected)
            rows.append(
                {
                    "pieceId": piece_id,
                    "status": "ok",
                    "baseline": baseline,
                    "metrics": metrics,
                    "solver": solver,
                    "measures": details,
                }
            )
        except Exception as exc:
            rows.append(
                {
                    "pieceId": piece_id,
                    "status": "error",
                    "error": f"{type(exc).__name__}:{str(exc)[:300]}",
                }
            )
    summary = summarize(rows, upper["perfectObservationOemer"]["requestedPieceCount"])
    target_reached = bool(
        summary["failedPieceCount"] == 0
        and summary["onsetPassedPieceRateAllRequested"] >= STOP_LOSS_TARGET
        and summary["measurePassedPieceRateAllRequested"] >= STOP_LOSS_TARGET
    )
    report = {
        "contract": "western-m4-clean-constraint-solver-poc-v1",
        "evidenceRole": "clean-render-minimum-rhythm-constraint-solver-poc",
        "sources": {
            "upperBound": {"path": portable(UPPER_BOUND), "sha256": sha256(UPPER_BOUND)},
            "noteAudit": {"path": portable(NOTE_AUDIT), "sha256": sha256(NOTE_AUDIT)},
        },
        "thresholds": {
            "strictPerPieceMetricMin": STRICT_THRESHOLD,
            "cleanStopLossPerPiecePassRateMin": STOP_LOSS_TARGET,
            "onsetToleranceQuarters": ONSET_TOLERANCE_QUARTERS,
        },
        "method": {
            "solver": "dynamic programming; lowest edit cost among exact-meter duration paths",
            "hardConstraints": [
                "measure duration equals the observed meter",
                "beam count and notation type bound duration candidates",
                "dots are preserved in candidate duration",
                "stem-notehead groups and ties are preserved; pitch/note count are never changed",
            ],
            "meterObservation": "gold meter only, used as a diagnostic perfect-meter upper bound; gold note timing is never read",
            "scope": "clean render only; no real-photo tuning or runtime effect",
        },
        "aggregate": summary,
        "decision": {
            "clean80TargetReached": target_reached,
            "stopLossTriggered": not target_reached,
            "m4bDecodeLineViable": target_reached,
            "nextStep": (
                "proceed-to-one-shot-real-photo-symbol-diagnostic"
                if target_reached
                else "stop-clean-decoder-optimization-after-required-photo-diagnostic"
            ),
        },
        "studentGateReady": False,
        "automaticAdoptionAuthorized": False,
        "rows": rows,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": portable(OUTPUT), **summary, **report["decision"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
