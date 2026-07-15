#!/usr/bin/env python3
"""Probe the upper bound of time-signature-constrained OMR rhythm repair.

This eval-only script normalizes each eligible draft measure to its written
time-signature duration in memory, then re-evaluates onset accuracy against the
independent real-photo gold. It does not write repaired MusicXML and is not the
final minimal-edit solver; lack of improvement is a stop signal for that work.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_omr_benchmark import (  # noqa: E402
    Note,
    align_notes,
    child,
    child_text,
    local_name,
    parse_duration,
    parse_notes,
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
    / "measure-duration-normalization"
)
ONSET_TOLERANCE_QUARTERS = 0.25
REPAIR_TICKS_PER_QUARTER = 48
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


def normalized_measure_duration(
    observed: float,
    expected: float,
    *,
    first_or_last: bool,
    implicit: bool,
    has_backup: bool,
) -> tuple[float, str]:
    if observed <= 0.0 or expected <= 0.0:
        return observed, "missing-duration-evidence"
    if implicit or (first_or_last and observed < expected - 1e-6):
        return observed, "pickup-or-partial-measure"
    if has_backup:
        return observed, "polyphonic-backup-unsupported"
    ratio = observed / expected
    if ratio < 0.50 or ratio > 2.00:
        return observed, "structural-ratio-out-of-range"
    if abs(observed - expected) <= 1e-6:
        return observed, "already-satisfies-time-signature"
    return expected, "normalized-to-time-signature"


def minimal_edit_measure_durations(
    observed: list[float], expected: float
) -> tuple[list[float] | None, dict[str, Any]]:
    """Find a bounded exact-meter repair without scaling every duration."""

    if not observed or expected <= 0.0 or any(value <= 0.0 for value in observed):
        return None, {"reason": "invalid-duration-input", "changed": 0}
    target_ticks = int(round(expected * REPAIR_TICKS_PER_QUARTER))
    observed_ticks = [int(round(value * REPAIR_TICKS_PER_QUARTER)) for value in observed]
    if sum(observed_ticks) == target_ticks:
        return list(observed), {"reason": "already-satisfies-time-signature", "changed": 0}

    candidate_rows: list[list[tuple[int, float]]] = []
    standard_ticks = {
        max(1, int(round(value * REPAIR_TICKS_PER_QUARTER))) for value in STANDARD_DURATIONS
    }
    for value, original_ticks in zip(observed, observed_ticks):
        local = {
            original_ticks,
            max(1, int(round(original_ticks * 0.5))),
            max(1, int(round(original_ticks * 2.0))),
        }
        local.update(
            ticks
            for ticks in standard_ticks
            if 0.5 <= ticks / max(1, original_ticks) <= 2.0
        )
        candidates = []
        for ticks in sorted(local):
            if ticks == original_ticks:
                cost = 0.0
            else:
                cost = 1.0 + 0.25 * abs(math.log2(ticks / max(1, original_ticks)))
            candidates.append((ticks, cost))
        candidate_rows.append(candidates)

    # total ticks -> (cost, changed count, repaired prefix)
    states: dict[int, tuple[float, int, list[int]]] = {0: (0.0, 0, [])}
    for original_ticks, candidates in zip(observed_ticks, candidate_rows):
        next_states: dict[int, tuple[float, int, list[int]]] = {}
        for total, (cost, changed, prefix) in states.items():
            for ticks, edit_cost in candidates:
                new_total = total + ticks
                if new_total > target_ticks:
                    continue
                candidate = (
                    cost + edit_cost,
                    changed + int(ticks != original_ticks),
                    [*prefix, ticks],
                )
                previous = next_states.get(new_total)
                if previous is None or candidate[:2] < previous[:2]:
                    next_states[new_total] = candidate
        states = next_states
        if not states:
            break
    selected = states.get(target_ticks)
    if selected is None:
        return None, {"reason": "no-exact-meter-candidate", "changed": 0}
    _, changed, repaired_ticks = selected
    max_changes = max(1, min(3, math.ceil(len(observed) * 0.25)))
    if changed > max_changes:
        return None, {
            "reason": "too-many-duration-edits",
            "changed": changed,
            "maxChanges": max_changes,
        }
    return (
        [ticks / REPAIR_TICKS_PER_QUARTER for ticks in repaired_ticks],
        {"reason": "minimal-edit-time-signature", "changed": changed, "maxChanges": max_changes},
    )


def parse_part_notes_minimal_edit(part: ET.Element) -> tuple[list[Note], dict[str, int]]:
    notes: list[Note] = []
    divisions = 1.0
    beats = 4.0
    beat_type = 4.0
    piece_cursor = 0.0
    measures = [item for item in list(part) if local_name(str(item.tag)) == "measure"]
    reasons: dict[str, int] = {}

    for measure_offset, measure in enumerate(measures):
        measure_index = measure_offset + 1
        has_backup = False
        tokens: list[dict[str, Any]] = []
        previous_token_index: int | None = None
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
            elif name == "forward":
                tokens.append({"duration": parse_duration(item, divisions), "midis": []})
                previous_token_index = len(tokens) - 1
            elif name == "note":
                duration = parse_duration(item, divisions)
                midi = pitch_to_midi(item)
                is_chord = child(item, "chord") is not None
                if is_chord and previous_token_index is not None:
                    if midi is not None and child(item, "rest") is None:
                        tokens[previous_token_index]["midis"].append(midi)
                    continue
                tokens.append(
                    {
                        "duration": duration,
                        "midis": [midi] if midi is not None and child(item, "rest") is None else [],
                    }
                )
                previous_token_index = len(tokens) - 1

        observed = [float(token["duration"]) for token in tokens]
        observed_total = sum(observed)
        expected = beats * 4.0 / beat_type if beat_type > 0.0 else observed_total
        implicit = str(measure.attrib.get("implicit") or "").lower() == "yes"
        first_or_last = measure_offset in {0, len(measures) - 1}
        if has_backup:
            repaired = None
            detail = {"reason": "polyphonic-backup-unsupported", "changed": 0}
        elif implicit or (first_or_last and observed_total < expected - 1e-6):
            repaired = None
            detail = {"reason": "pickup-or-partial-measure", "changed": 0}
        elif observed_total / max(0.001, expected) < 0.5 or observed_total / max(0.001, expected) > 2.0:
            repaired = None
            detail = {"reason": "structural-ratio-out-of-range", "changed": 0}
        else:
            repaired, detail = minimal_edit_measure_durations(observed, expected)
        reason = str(detail["reason"])
        reasons[reason] = reasons.get(reason, 0) + 1
        durations = repaired if repaired is not None else observed
        cursor = 0.0
        for token, duration in zip(tokens, durations):
            for midi in token["midis"]:
                notes.append(
                    Note(
                        midi=int(midi),
                        onset_quarters=piece_cursor + cursor,
                        duration_quarters=duration,
                        measure_index=measure_index,
                    )
                )
            cursor += duration
        piece_cursor += cursor
    return notes, reasons


def parse_notes_minimal_edit(path: Path) -> tuple[list[Note], dict[str, int]]:
    root = ET.fromstring(read_score_xml(path))
    parts = [item for item in root.iter() if local_name(str(item.tag)) == "part"]
    if not parts:
        raise ValueError("no-part")
    parsed = [parse_part_notes_minimal_edit(part) for part in parts]
    return max(parsed, key=lambda item: len(item[0]))


def parse_notes_many_minimal_edit(paths: list[Path]) -> tuple[list[Note], dict[str, int]]:
    combined: list[Note] = []
    reasons: dict[str, int] = {}
    onset_offset = 0.0
    measure_offset = 0
    for path in paths:
        path_notes, path_reasons = parse_notes_minimal_edit(path)
        combined.extend(
            Note(
                midi=note.midi,
                onset_quarters=note.onset_quarters + onset_offset,
                duration_quarters=note.duration_quarters,
                measure_index=note.measure_index + measure_offset,
            )
            for note in path_notes
        )
        for key, count in path_reasons.items():
            reasons[key] = reasons.get(key, 0) + count
        if path_notes:
            onset_offset += max(note.onset_quarters + note.duration_quarters for note in path_notes)
            measure_offset += max(note.measure_index for note in path_notes)
    return combined, reasons


def parse_part_notes_normalized(part: ET.Element) -> tuple[list[Note], dict[str, int]]:
    notes: list[Note] = []
    divisions = 1.0
    beats = 4.0
    beat_type = 4.0
    piece_cursor = 0.0
    measures = [item for item in list(part) if local_name(str(item.tag)) == "measure"]
    reasons: dict[str, int] = {}

    for measure_offset, measure in enumerate(measures):
        measure_index = measure_offset + 1
        measure_cursor = 0.0
        measure_max = 0.0
        previous_note_onset = 0.0
        local_notes: list[tuple[int, float, float]] = []
        has_backup = False
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
                measure_cursor = max(0.0, measure_cursor - parse_duration(item, divisions))
            elif name == "forward":
                measure_cursor += parse_duration(item, divisions)
                measure_max = max(measure_max, measure_cursor)
            elif name == "note":
                duration = parse_duration(item, divisions)
                is_chord = child(item, "chord") is not None
                onset = previous_note_onset if is_chord else measure_cursor
                midi = pitch_to_midi(item)
                if midi is not None and child(item, "rest") is None:
                    local_notes.append((midi, onset, duration))
                previous_note_onset = onset
                if not is_chord:
                    measure_cursor += duration
                    measure_max = max(measure_max, measure_cursor)

        expected = beats * 4.0 / beat_type if beat_type > 0.0 else measure_max
        target, reason = normalized_measure_duration(
            measure_max,
            expected,
            first_or_last=measure_offset in {0, len(measures) - 1},
            implicit=str(measure.attrib.get("implicit") or "").lower() == "yes",
            has_backup=has_backup,
        )
        reasons[reason] = reasons.get(reason, 0) + 1
        scale = target / measure_max if measure_max > 0.0 else 1.0
        for midi, onset, duration in local_notes:
            notes.append(
                Note(
                    midi=midi,
                    onset_quarters=piece_cursor + onset * scale,
                    duration_quarters=duration * scale,
                    measure_index=measure_index,
                )
            )
        piece_cursor += target
    return notes, reasons


def parse_notes_normalized(path: Path) -> tuple[list[Note], dict[str, int]]:
    root = ET.fromstring(read_score_xml(path))
    parts = [item for item in root.iter() if local_name(str(item.tag)) == "part"]
    if not parts:
        raise ValueError("no-part")
    parsed = [parse_part_notes_normalized(part) for part in parts]
    return max(parsed, key=lambda item: len(item[0]))


def parse_notes_many_normalized(paths: list[Path]) -> tuple[list[Note], dict[str, int]]:
    combined: list[Note] = []
    reasons: dict[str, int] = {}
    onset_offset = 0.0
    measure_offset = 0
    for path in paths:
        notes, path_reasons = parse_notes_normalized(path)
        combined.extend(
            Note(
                midi=note.midi,
                onset_quarters=note.onset_quarters + onset_offset,
                duration_quarters=note.duration_quarters,
                measure_index=note.measure_index + measure_offset,
            )
            for note in notes
        )
        for key, count in path_reasons.items():
            reasons[key] = reasons.get(key, 0) + count
        if notes:
            onset_offset += max(note.onset_quarters + note.duration_quarters for note in notes)
            measure_offset += max(note.measure_index for note in notes)
    return combined, reasons


def onset_metric(gold: list[Note], draft: list[Note]) -> dict[str, Any]:
    pairs = align_notes(gold, draft)
    paired = [(g, d) for g, d in pairs if g is not None and d is not None]
    exact = sum(
        abs(gold[int(g)].onset_quarters - draft[int(d)].onset_quarters)
        <= ONSET_TOLERANCE_QUARTERS
        for g, d in paired
    )
    return {
        "goldNotes": len(gold),
        "pairedNotes": len(paired),
        "onsetExact": exact,
        "onsetQuarterAccuracy": round(exact / len(gold), 6) if gold else 0.0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", default=str(DEFAULT_BENCHMARK))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()
    benchmark = json.loads(Path(args.benchmark).read_text(encoding="utf-8"))
    rows = []
    for source in benchmark["rows"]:
        if not source.get("benchmarkUsable"):
            continue
        gold_path = repo_path(source["goldPath"])
        draft_paths = [repo_path(value) for value in str(source["draftPath"]).split("|") if value]
        gold = parse_notes(gold_path)
        normalized, reasons = parse_notes_many_normalized(draft_paths)
        metric = onset_metric(gold, normalized)
        minimal_edit, minimal_edit_reasons = parse_notes_many_minimal_edit(draft_paths)
        minimal_edit_metric = onset_metric(gold, minimal_edit)
        rows.append(
            {
                "pieceId": source["pieceId"],
                "baselineOnsetQuarterAccuracy": source["onsetQuarterAccuracy"],
                "normalizedOnsetQuarterAccuracy": metric["onsetQuarterAccuracy"],
                "delta": round(metric["onsetQuarterAccuracy"] - float(source["onsetQuarterAccuracy"]), 6),
                "minimalEditOnsetQuarterAccuracy": minimal_edit_metric["onsetQuarterAccuracy"],
                "minimalEditDelta": round(
                    minimal_edit_metric["onsetQuarterAccuracy"] - float(source["onsetQuarterAccuracy"]),
                    6,
                ),
                "goldNotes": metric["goldNotes"],
                "normalizationReasons": reasons,
                "minimalEditReasons": minimal_edit_reasons,
            }
        )
    gold_total = sum(int(row["goldNotes"]) for row in rows)
    baseline_exact = sum(round(float(row["baselineOnsetQuarterAccuracy"]) * int(row["goldNotes"])) for row in rows)
    normalized_exact = sum(round(float(row["normalizedOnsetQuarterAccuracy"]) * int(row["goldNotes"])) for row in rows)
    minimal_edit_exact = sum(
        round(float(row["minimalEditOnsetQuarterAccuracy"]) * int(row["goldNotes"]))
        for row in rows
    )
    summary = {
        "pieceCount": len(rows),
        "goldNotes": gold_total,
        "baselineOnsetQuarterAccuracy": round(baseline_exact / gold_total, 6) if gold_total else 0.0,
        "normalizedOnsetQuarterAccuracy": round(normalized_exact / gold_total, 6) if gold_total else 0.0,
        "delta": round((normalized_exact - baseline_exact) / gold_total, 6) if gold_total else 0.0,
        "minimalEditOnsetQuarterAccuracy": round(minimal_edit_exact / gold_total, 6) if gold_total else 0.0,
        "minimalEditDelta": round((minimal_edit_exact - baseline_exact) / gold_total, 6) if gold_total else 0.0,
        "improvedPieceCount": sum(float(row["delta"]) > 0.0 for row in rows),
        "regressedPieceCount": sum(float(row["delta"]) < 0.0 for row in rows),
        "minimalEditImprovedPieceCount": sum(float(row["minimalEditDelta"]) > 0.0 for row in rows),
        "minimalEditRegressedPieceCount": sum(float(row["minimalEditDelta"]) < 0.0 for row in rows),
        "evalOnlyGatePassed": False,
    }
    report = {
        "schemaVersion": 1,
        "evalOnly": True,
        "studentFacing": False,
        "purpose": "upper-bound probe for time-signature-constrained OMR rhythm repair",
        "summary": summary,
        "rows": rows,
        "limitations": [
            "normalization scales a whole monophonic measure and is not the final minimal-edit duration solver",
            "measures with backups, pickup/final partial bars, or extreme duration ratios are left unchanged",
            "a positive result only justifies implementing and testing a discrete minimal-edit repair",
        ],
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# M4 measure-duration normalization probe",
        "",
        "Eval-only; no MusicXML was modified.",
        "",
        f"- baseline onset-quarter accuracy: {summary['baselineOnsetQuarterAccuracy']}",
        f"- normalized onset-quarter accuracy: {summary['normalizedOnsetQuarterAccuracy']}",
        f"- delta: {summary['delta']}",
        f"- minimal-edit onset-quarter accuracy: {summary['minimalEditOnsetQuarterAccuracy']}",
        f"- minimal-edit delta: {summary['minimalEditDelta']}",
        f"- improved / regressed pieces: {summary['improvedPieceCount']} / {summary['regressedPieceCount']}",
        f"- minimal-edit improved / regressed pieces: {summary['minimalEditImprovedPieceCount']} / {summary['minimalEditRegressedPieceCount']}",
        "",
        "| piece | baseline | scaled | scaled delta | minimal edit | minimal-edit delta |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['pieceId']} | {row['baselineOnsetQuarterAccuracy']} | "
            f"{row['normalizedOnsetQuarterAccuracy']} | {row['delta']} | "
            f"{row['minimalEditOnsetQuarterAccuracy']} | {row['minimalEditDelta']} |"
        )
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "summary": summary, "rows": rows, "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
