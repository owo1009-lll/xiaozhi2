#!/usr/bin/env python3
"""Measure whether an exact rhythm is reachable from conservative OMR candidates.

The benchmark deliberately separates candidate generation from candidate
selection.  It only evaluates monophonic measures whose aligned gold and draft
pitch sequences are identical.  Gold timing is used solely as an oracle to ask
whether a decoder *could* produce the correct rhythm; it is never used by a
runtime path.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_omr_benchmark import (  # noqa: E402
    align_notes,
    child,
    child_text,
    local_name,
    parse_duration,
    parse_notes,
    parse_notes_many,
    pitch_to_midi,
    read_score_xml,
    repo_path,
)


DEFAULT_BENCHMARK = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-source-benchmark"
    / "omr-benchmark.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "rhythm-candidate-oracle"
)
TICKS_PER_QUARTER = 48
COMMON_METER_QUARTERS = (2.0, 3.0, 4.0)
STANDARD_DURATIONS = (
    1 / 12,
    1 / 8,
    1 / 6,
    1 / 4,
    1 / 3,
    1 / 2,
    2 / 3,
    3 / 4,
    1.0,
    1.5,
    2.0,
    3.0,
    4.0,
)


@dataclass(frozen=True)
class RhythmToken:
    duration_quarters: float
    sounding_note: bool
    notation_type: str = ""
    dot_count: int = 0
    beam_count: int = 0
    tie_start: bool = False
    tie_stop: bool = False
    is_rest: bool = False


@dataclass(frozen=True)
class MeasureRhythm:
    measure_index: int
    pitches: tuple[int, ...]
    note_onset_ticks: tuple[int, ...]
    tokens: tuple[RhythmToken, ...]
    expected_ticks: int
    has_backup: bool


def _best_part_measures(path: Path, measure_offset: int = 0) -> list[MeasureRhythm]:
    root = ET.fromstring(read_score_xml(path))
    parts = [item for item in root.iter() if local_name(str(item.tag)) == "part"]
    if not parts:
        raise ValueError(f"no-part:{path}")

    def parse_part(part: ET.Element) -> list[MeasureRhythm]:
        divisions = 1.0
        beats = 4.0
        beat_type = 4.0
        parsed: list[MeasureRhythm] = []
        measures = [item for item in list(part) if local_name(str(item.tag)) == "measure"]
        for offset, measure in enumerate(measures, 1):
            cursor = 0.0
            previous_onset = 0.0
            has_backup = False
            tokens: list[RhythmToken] = []
            notes: list[tuple[int, float]] = []
            for item in list(measure):
                name = local_name(str(item.tag))
                if name == "attributes":
                    divisions_text = child_text(item, "divisions")
                    if divisions_text:
                        try:
                            divisions = max(float(divisions_text), 1.0)
                        except ValueError:
                            pass
                    time = child(item, "time")
                    if time is not None:
                        try:
                            beats = float(child_text(time, "beats", str(beats)))
                            beat_type = float(child_text(time, "beat-type", str(beat_type)))
                        except ValueError:
                            pass
                elif name == "backup":
                    has_backup = True
                    cursor = max(0.0, cursor - parse_duration(item, divisions))
                elif name == "forward":
                    duration = parse_duration(item, divisions)
                    tokens.append(RhythmToken(duration, False))
                    cursor += duration
                elif name == "note":
                    duration = parse_duration(item, divisions)
                    is_chord = child(item, "chord") is not None
                    onset = previous_onset if is_chord else cursor
                    midi = pitch_to_midi(item)
                    sounding = midi is not None and child(item, "rest") is None
                    if not is_chord:
                        notation_type = child_text(item, "type")
                        dot_count = sum(
                            1 for value in list(item) if local_name(str(value.tag)) == "dot"
                        )
                        beam_count = sum(
                            1
                            for value in list(item)
                            if local_name(str(value.tag)) == "beam"
                            and (value.text or "").strip() not in {"", "none"}
                        )
                        tie_types = {
                            value.attrib.get("type", "")
                            for value in list(item)
                            if local_name(str(value.tag)) == "tie"
                        }
                        tokens.append(
                            RhythmToken(
                                duration,
                                sounding,
                                notation_type=notation_type,
                                dot_count=dot_count,
                                beam_count=beam_count,
                                tie_start="start" in tie_types,
                                tie_stop="stop" in tie_types,
                                is_rest=child(item, "rest") is not None,
                            )
                        )
                    if sounding:
                        notes.append((int(midi), onset))
                    previous_onset = onset
                    if not is_chord:
                        cursor += duration
            expected_quarters = beats * 4.0 / beat_type if beat_type > 0.0 else cursor
            parsed.append(
                MeasureRhythm(
                    measure_index=offset + measure_offset,
                    pitches=tuple(midi for midi, _ in notes),
                    note_onset_ticks=tuple(
                        int(round(onset * TICKS_PER_QUARTER)) for _, onset in notes
                    ),
                    tokens=tuple(tokens),
                    expected_ticks=int(round(expected_quarters * TICKS_PER_QUARTER)),
                    has_backup=has_backup,
                )
            )
        return parsed

    candidates = [parse_part(part) for part in parts]
    return max(candidates, key=lambda rows: sum(len(row.pitches) for row in rows))


def parse_measure_rhythms_many(paths: list[Path]) -> list[MeasureRhythm]:
    combined: list[MeasureRhythm] = []
    measure_offset = 0
    for path in paths:
        measures = _best_part_measures(path, measure_offset)
        combined.extend(measures)
        if measures:
            measure_offset = max(row.measure_index for row in combined)
    return combined


def candidate_duration_ticks(duration_quarters: float) -> tuple[int, ...]:
    original = max(1, int(round(duration_quarters * TICKS_PER_QUARTER)))
    values = {
        original,
        max(1, int(round(original * 0.5))),
        max(1, int(round(original * 2.0))),
    }
    values.update(
        max(1, int(round(value * TICKS_PER_QUARTER)))
        for value in STANDARD_DURATIONS
        if 0.25 <= (value * TICKS_PER_QUARTER) / original <= 4.0
    )
    return tuple(sorted(values))


NOTATION_QUARTERS = {
    "128th": 1 / 32,
    "64th": 1 / 16,
    "32nd": 1 / 8,
    "16th": 1 / 4,
    "eighth": 1 / 2,
    "quarter": 1.0,
    "half": 2.0,
    "whole": 4.0,
    "breve": 8.0,
}


def visual_candidate_duration_ticks(token: RhythmToken) -> tuple[int, ...]:
    """Return bounded duration candidates supported by visible notation classes.

    The original exported duration remains a candidate, but unlike the legacy
    oracle this function never enumerates every standard note value.  Black
    notehead ambiguity is limited to eighth/quarter, dots can be retained or
    removed, and explicit rests use the same bounded duration family.
    """

    original = max(1, int(round(token.duration_quarters * TICKS_PER_QUARTER)))
    values = {original}
    base = NOTATION_QUARTERS.get(token.notation_type)
    if base is None:
        return (original,)

    families = {base}
    if token.notation_type in {"eighth", "quarter"}:
        families.update({0.5, 1.0})
    for value in families:
        values.add(max(1, int(round(value * TICKS_PER_QUARTER))))
        if token.dot_count > 0:
            values.add(max(1, int(round(value * 1.5 * TICKS_PER_QUARTER))))

    return tuple(sorted(values))


def build_visual_candidate_provider(measure: MeasureRhythm):
    """Add bounded candidates supported by beam and local tuplet context.

    A missing or extra beam changes a note by one duration class, so only the
    adjacent beam classes are added.  Tuplet duration is propagated only when
    at least three matching tokens already expose the same 3:2 timing inside
    the measure.  Both signals are available in the draft MusicXML and do not
    use gold timing.
    """

    triplet_eighth_count = sum(
        token.notation_type == "eighth"
        and math.isclose(token.duration_quarters, 1 / 3, abs_tol=1e-6)
        for token in measure.tokens
    )
    triplet_sixteenth_count = sum(
        token.notation_type == "16th"
        and math.isclose(token.duration_quarters, 1 / 6, abs_tol=1e-6)
        for token in measure.tokens
    )

    def provider(token: RhythmToken) -> tuple[int, ...]:
        values = set(visual_candidate_duration_ticks(token))
        if token.beam_count > 0:
            beam_quarters = 1 / (2**token.beam_count)
            values.update(
                max(1, int(round(value * TICKS_PER_QUARTER)))
                for value in (beam_quarters / 2, beam_quarters, beam_quarters * 2)
            )
            if (
                triplet_eighth_count >= 3
                and token.notation_type in {"eighth", "16th"}
            ):
                values.add(int(round(TICKS_PER_QUARTER / 3)))
            if (
                triplet_sixteenth_count >= 3
                and token.notation_type in {"eighth", "16th", "32nd"}
            ):
                values.add(int(round(TICKS_PER_QUARTER / 6)))
        return tuple(sorted(values))

    return provider


def generate_visual_rhythm_candidates(
    draft: MeasureRhythm,
    target_ticks: int,
    *,
    top_k: int = 16,
) -> list[dict[str, Any]]:
    """Generate low-edit measure rhythms without consulting gold timing."""

    if (
        draft.has_backup
        or target_ticks <= 0
        or top_k <= 0
        or any(token.duration_quarters <= 0.0 for token in draft.tokens)
    ):
        return []
    provider = build_visual_candidate_provider(draft)
    # cumulative ticks -> bounded alternatives (cost, changed, durations)
    states: dict[int, list[tuple[float, int, tuple[int, ...]]]] = {
        0: [(0.0, 0, ())]
    }
    for token in draft.tokens:
        original = max(1, int(round(token.duration_quarters * TICKS_PER_QUARTER)))
        next_states: dict[int, list[tuple[float, int, tuple[int, ...]]]] = defaultdict(list)
        for total, alternatives in states.items():
            for cost, changed, durations in alternatives:
                for ticks in provider(token):
                    new_total = total + ticks
                    if new_total > target_ticks:
                        continue
                    edit_cost = (
                        0.0
                        if ticks == original
                        else 1.0 + 0.25 * abs(math.log2(ticks / original))
                    )
                    next_states[new_total].append(
                        (
                            cost + edit_cost,
                            changed + int(ticks != original),
                            durations + (int(ticks),),
                        )
                    )
        states = {}
        for total, alternatives in next_states.items():
            unique: dict[tuple[int, ...], tuple[float, int, tuple[int, ...]]] = {}
            for candidate in alternatives:
                previous = unique.get(candidate[2])
                if previous is None or candidate[:2] < previous[:2]:
                    unique[candidate[2]] = candidate
            states[total] = sorted(unique.values(), key=lambda item: item[:2])[:top_k]
        if not states:
            return []

    results: list[dict[str, Any]] = []
    for cost, changed, durations in states.get(target_ticks, []):
        cursor = 0
        note_onsets: list[int] = []
        for token, ticks in zip(draft.tokens, durations):
            if token.sounding_note:
                note_onsets.append(cursor)
            cursor += ticks
        results.append(
            {
                "targetTicks": int(target_ticks),
                "durationTicks": list(durations),
                "noteOnsetTicks": note_onsets,
                "cost": round(float(cost), 6),
                "changed": int(changed),
            }
        )
    return results


def reachable_gold_rhythm(
    draft: MeasureRhythm,
    gold_onset_ticks: tuple[int, ...],
    target_ticks: int,
    candidate_provider=None,
) -> dict[str, Any]:
    """Return the lowest-edit exact-meter path that meets all gold checkpoints."""

    if (
        draft.has_backup
        or target_ticks <= 0
        or len(draft.pitches) != len(gold_onset_ticks)
        or any(token.duration_quarters <= 0.0 for token in draft.tokens)
    ):
        return {"reachable": False, "changed": None, "cost": None}

    # cumulative ticks -> (cost, changed count)
    states: dict[int, tuple[float, int]] = {0: (0.0, 0)}
    note_index = 0
    for token in draft.tokens:
        if token.sounding_note:
            required = gold_onset_ticks[note_index]
            note_index += 1
            states = {total: value for total, value in states.items() if total == required}
        if not states:
            return {"reachable": False, "changed": None, "cost": None}

        original = max(1, int(round(token.duration_quarters * TICKS_PER_QUARTER)))
        next_states: dict[int, tuple[float, int]] = {}
        for total, (cost, changed) in states.items():
            candidates = (
                candidate_provider(token)
                if candidate_provider is not None
                else candidate_duration_ticks(token.duration_quarters)
            )
            for ticks in candidates:
                new_total = total + ticks
                if new_total > target_ticks:
                    continue
                edit_cost = 0.0 if ticks == original else 1.0 + 0.25 * abs(math.log2(ticks / original))
                candidate = (cost + edit_cost, changed + int(ticks != original))
                previous = next_states.get(new_total)
                if previous is None or candidate < previous:
                    next_states[new_total] = candidate
        states = next_states

    selected = states.get(target_ticks)
    if note_index != len(gold_onset_ticks) or selected is None:
        return {"reachable": False, "changed": None, "cost": None}
    cost, changed = selected
    return {"reachable": True, "changed": changed, "cost": round(cost, 6)}


def draft_note_onsets(draft: MeasureRhythm) -> tuple[int, ...]:
    cursor = 0
    values: list[int] = []
    for token in draft.tokens:
        if token.sounding_note:
            values.append(cursor)
        cursor += int(round(token.duration_quarters * TICKS_PER_QUARTER))
    return tuple(values)


def relative_ioi_shape(onset_ticks: tuple[int, ...]) -> tuple[float, ...] | None:
    """Return a meter-scale-invariant rhythm shape for two or more onsets."""
    if len(onset_ticks) < 2:
        return None
    intervals = [right - left for left, right in zip(onset_ticks, onset_ticks[1:])]
    if any(value <= 0 for value in intervals):
        return None
    total = sum(intervals)
    if total <= 0:
        return None
    return tuple(value / total for value in intervals)


def relative_ioi_shape_matches(
    left: tuple[int, ...],
    right: tuple[int, ...],
    tolerance: float = 1e-6,
) -> bool | None:
    left_shape = relative_ioi_shape(left)
    right_shape = relative_ioi_shape(right)
    if left_shape is None or right_shape is None or len(left_shape) != len(right_shape):
        return None
    return all(abs(a - b) <= tolerance for a, b in zip(left_shape, right_shape))


def exact_pitch_measure_pairs(
    gold_path: Path,
    draft_paths: list[Path],
    gold_measures: list[MeasureRhythm],
    draft_measures: list[MeasureRhythm],
) -> list[tuple[MeasureRhythm, MeasureRhythm]]:
    gold_notes = parse_notes(gold_path)
    draft_notes = parse_notes_many(draft_paths)
    gold_pitches: dict[int, list[int]] = defaultdict(list)
    draft_pitches: dict[int, list[int]] = defaultdict(list)
    for note in gold_notes:
        gold_pitches[note.measure_index].append(note.midi)
    for note in draft_notes:
        draft_pitches[note.measure_index].append(note.midi)

    support: Counter[tuple[int, int]] = Counter()
    for gold_index, draft_index in align_notes(gold_notes, draft_notes):
        if gold_index is None or draft_index is None:
            continue
        gold_note = gold_notes[gold_index]
        draft_note = draft_notes[draft_index]
        if gold_note.midi == draft_note.midi:
            support[(gold_note.measure_index, draft_note.measure_index)] += 1

    gold_by_index = {row.measure_index: row for row in gold_measures}
    draft_by_index = {row.measure_index: row for row in draft_measures}
    pairs: list[tuple[MeasureRhythm, MeasureRhythm]] = []
    for (gold_measure, draft_measure), count in sorted(support.items()):
        gold_sequence = gold_pitches[gold_measure]
        draft_sequence = draft_pitches[draft_measure]
        if not gold_sequence or gold_sequence != draft_sequence or count != len(gold_sequence):
            continue
        gold_row = gold_by_index.get(gold_measure)
        draft_row = draft_by_index.get(draft_measure)
        if gold_row is None or draft_row is None or gold_row.has_backup or draft_row.has_backup:
            continue
        pairs.append((gold_row, draft_row))
    return pairs


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0


def evaluate_piece(source: dict[str, Any]) -> dict[str, Any]:
    gold_path = repo_path(source["goldPath"])
    draft_paths = [repo_path(value) for value in str(source["draftPath"]).split("|") if value]
    gold_measures = _best_part_measures(gold_path)
    draft_measures = parse_measure_rhythms_many(draft_paths)
    pairs = exact_pitch_measure_pairs(
        gold_path,
        draft_paths,
        gold_measures,
        draft_measures,
    )

    counts: Counter[str] = Counter()
    changed_counts: list[int] = []
    details: list[dict[str, Any]] = []
    common_targets = tuple(int(round(value * TICKS_PER_QUARTER)) for value in COMMON_METER_QUARTERS)
    for gold, draft in pairs:
        counts["comparableMeasures"] += 1
        counts["comparableNotes"] += len(gold.pitches)
        baseline_exact = draft_note_onsets(draft) == gold.note_onset_ticks
        counts["baselineExactMeasures"] += int(baseline_exact)
        relative_shape_exact = relative_ioi_shape_matches(
            draft_note_onsets(draft),
            gold.note_onset_ticks,
        )
        counts["relativeShapeComparableMeasures"] += int(relative_shape_exact is not None)
        counts["relativeShapeExactMeasures"] += int(relative_shape_exact is True)
        meter_matches = gold.expected_ticks == draft.expected_ticks
        counts["meterMatches"] += int(meter_matches)
        notation_scale_confounded = bool(not meter_matches and relative_shape_exact is True)
        counts["notationScaleConfoundedMeasures"] += int(notation_scale_confounded)

        current = reachable_gold_rhythm(draft, gold.note_onset_ticks, draft.expected_ticks)
        gold_meter = reachable_gold_rhythm(draft, gold.note_onset_ticks, gold.expected_ticks)
        common_results = [
            (target, reachable_gold_rhythm(draft, gold.note_onset_ticks, target))
            for target in common_targets
        ]
        reachable_common = [(target, result) for target, result in common_results if result["reachable"]]
        counts["currentMeterReachableMeasures"] += int(current["reachable"])
        counts["goldMeterReachableMeasures"] += int(gold_meter["reachable"])
        counts["commonMeterReachableMeasures"] += int(bool(reachable_common))
        visual_candidate_provider = build_visual_candidate_provider(draft)
        visual_current = reachable_gold_rhythm(
            draft,
            gold.note_onset_ticks,
            draft.expected_ticks,
            candidate_provider=visual_candidate_provider,
        )
        visual_gold = reachable_gold_rhythm(
            draft,
            gold.note_onset_ticks,
            gold.expected_ticks,
            candidate_provider=visual_candidate_provider,
        )
        counts["visualCurrentMeterReachableMeasures"] += int(visual_current["reachable"])
        counts["visualGoldMeterReachableMeasures"] += int(visual_gold["reachable"])
        counts["visualCandidateTokens"] += len(draft.tokens)
        counts["visualAmbiguousTokens"] += sum(
            len(visual_candidate_duration_ticks(token)) > 1 for token in draft.tokens
        )
        counts["visualRestTokens"] += sum(token.is_rest for token in draft.tokens)
        counts["visualDotTokens"] += sum(token.dot_count > 0 for token in draft.tokens)
        counts["visualTieEdgeCandidates"] += sum(token.tie_start or token.tie_stop for token in draft.tokens)
        if gold_meter["reachable"] and gold_meter["changed"] is not None:
            changed_counts.append(int(gold_meter["changed"]))
        details.append(
            {
                "goldMeasure": gold.measure_index,
                "draftMeasure": draft.measure_index,
                "noteCount": len(gold.pitches),
                "baselineExact": baseline_exact,
                "relativeIoiShapeExact": relative_shape_exact,
                "notationScaleConfounded": notation_scale_confounded,
                "goldMeterQuarters": gold.expected_ticks / TICKS_PER_QUARTER,
                "draftMeterQuarters": draft.expected_ticks / TICKS_PER_QUARTER,
                "meterMatches": meter_matches,
                "currentMeterReachable": current["reachable"],
                "goldMeterReachable": gold_meter["reachable"],
                "goldMeterChangedTokens": gold_meter["changed"],
                "reachableCommonMeterQuarters": [
                    target / TICKS_PER_QUARTER for target, _ in reachable_common
                ],
                "visualCurrentMeterReachable": visual_current["reachable"],
                "visualGoldMeterReachable": visual_gold["reachable"],
                "visualCandidateSetSizes": [
                    len(visual_candidate_provider(token)) for token in draft.tokens
                ],
            }
        )

    comparable = counts["comparableMeasures"]
    return {
        "pieceId": source["pieceId"],
        **dict(counts),
        "meterMatchRate": _rate(counts["meterMatches"], comparable),
        "baselineExactMeasureRate": _rate(counts["baselineExactMeasures"], comparable),
        "relativeShapeExactMeasureRate": _rate(
            counts["relativeShapeExactMeasures"],
            counts["relativeShapeComparableMeasures"],
        ),
        "currentMeterCandidateRecall": _rate(counts["currentMeterReachableMeasures"], comparable),
        "goldMeterCandidateRecall": _rate(counts["goldMeterReachableMeasures"], comparable),
        "commonMeterCandidateRecall": _rate(counts["commonMeterReachableMeasures"], comparable),
        "visualCurrentMeterCandidateRecall": _rate(
            counts["visualCurrentMeterReachableMeasures"], comparable
        ),
        "visualGoldMeterCandidateRecall": _rate(
            counts["visualGoldMeterReachableMeasures"], comparable
        ),
        "medianChangedTokensAtGoldMeter": (
            float(sorted(changed_counts)[len(changed_counts) // 2]) if changed_counts else None
        ),
        "details": details,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", default=str(DEFAULT_BENCHMARK))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    benchmark = json.loads(Path(args.benchmark).read_text(encoding="utf-8"))
    rows = [evaluate_piece(source) for source in benchmark["rows"] if source.get("benchmarkUsable")]
    totals: Counter[str] = Counter()
    for row in rows:
        for key in (
            "comparableMeasures",
            "comparableNotes",
            "baselineExactMeasures",
            "relativeShapeComparableMeasures",
            "relativeShapeExactMeasures",
            "notationScaleConfoundedMeasures",
            "meterMatches",
            "currentMeterReachableMeasures",
            "goldMeterReachableMeasures",
            "commonMeterReachableMeasures",
            "visualCurrentMeterReachableMeasures",
            "visualGoldMeterReachableMeasures",
            "visualCandidateTokens",
            "visualAmbiguousTokens",
            "visualRestTokens",
            "visualDotTokens",
            "visualTieEdgeCandidates",
        ):
            totals[key] += int(row.get(key) or 0)
    comparable = totals["comparableMeasures"]
    summary = {
        "pieceCount": len(rows),
        **dict(totals),
        "meterMatchRate": _rate(totals["meterMatches"], comparable),
        "baselineExactMeasureRate": _rate(totals["baselineExactMeasures"], comparable),
        "relativeShapeExactMeasureRate": _rate(
            totals["relativeShapeExactMeasures"],
            totals["relativeShapeComparableMeasures"],
        ),
        "currentMeterCandidateRecall": _rate(totals["currentMeterReachableMeasures"], comparable),
        "goldMeterCandidateRecall": _rate(totals["goldMeterReachableMeasures"], comparable),
        "commonMeterCandidateRecall": _rate(totals["commonMeterReachableMeasures"], comparable),
        "visualCurrentMeterCandidateRecall": _rate(
            totals["visualCurrentMeterReachableMeasures"], comparable
        ),
        "visualGoldMeterCandidateRecall": _rate(
            totals["visualGoldMeterReachableMeasures"], comparable
        ),
        "candidateGenerationGatePassed": (
            comparable >= 30
            and _rate(totals["visualGoldMeterReachableMeasures"], comparable) >= 0.95
        ),
        "selectorTrainingAllowed": (
            comparable >= 30
            and _rate(totals["visualGoldMeterReachableMeasures"], comparable) >= 0.95
        ),
        "runtimeReady": False,
    }
    report = {
        "schemaVersion": 3,
        "evalOnly": True,
        "studentFacing": False,
        "purpose": "candidate-generation oracle; gold timing is never a runtime feature",
        "commonMeterQuarters": list(COMMON_METER_QUARTERS),
        "summary": summary,
        "rows": rows,
        "interpretation": [
            "Only exact-pitch monophonic measure pairs are comparable, so pitch omissions do not masquerade as rhythm errors.",
            "Relative IOI shape is invariant to a uniform notation scale; meter-mismatched measures with an exact relative shape are reported as edition/notation confounds, not raw OMR rhythm failures.",
            "A high common-meter oracle recall proves candidate generation is possible; it does not prove the correct meter can be selected automatically.",
            "The release gate uses only bounded visual candidates from note type, adjacent beam-count ambiguity, repeated in-measure tuplet context, dots, rests, and tie evidence. Broad standard-duration enumeration is retained as a diagnostic upper bound only.",
            "Selector training is forbidden unless the bounded visual oracle reaches 95% recall on at least 30 comparable measures.",
            "The selector must use independent visual or calibrated audio evidence and pass a separate holdout gate before runtime use.",
        ],
    }

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# M4 rhythm candidate oracle",
        "",
        "Eval-only. Gold timing is used only to measure candidate reachability.",
        "",
        f"- comparable measures / notes: {comparable} / {totals['comparableNotes']}",
        f"- meter match rate: {summary['meterMatchRate']}",
        f"- baseline exact-measure rate: {summary['baselineExactMeasureRate']}",
        f"- relative-IOI shape exact rate: {summary['relativeShapeExactMeasureRate']}",
        f"- notation-scale confounded measures: {totals['notationScaleConfoundedMeasures']}",
        f"- current-meter candidate recall: {summary['currentMeterCandidateRecall']}",
        f"- common-meter candidate recall: {summary['commonMeterCandidateRecall']}",
        f"- bounded visual candidate recall (current meter): {summary['visualCurrentMeterCandidateRecall']}",
        f"- bounded visual candidate recall (gold meter oracle): {summary['visualGoldMeterCandidateRecall']}",
        f"- candidate-generation gate: {summary['candidateGenerationGatePassed']}",
        f"- selector training allowed: {summary['selectorTrainingAllowed']}",
        f"- runtime ready: {summary['runtimeReady']}",
        "",
        "| piece | measures | notes | meter match | baseline exact | relative IOI | scale-confounded | broad common | visual current | visual gold-meter |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['pieceId']} | {row.get('comparableMeasures', 0)} | "
            f"{row.get('comparableNotes', 0)} | {row['meterMatchRate']} | "
            f"{row['baselineExactMeasureRate']} | {row['relativeShapeExactMeasureRate']} | "
            f"{row.get('notationScaleConfoundedMeasures', 0)} | {row['commonMeterCandidateRecall']} | "
            f"{row['visualCurrentMeterCandidateRecall']} | {row['visualGoldMeterCandidateRecall']} |"
        )
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "summary": summary, "out": str(out)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
