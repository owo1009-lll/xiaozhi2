from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from eval_western_strings_m4_omr_benchmark import (
    Note,
    align_notes,
    child,
    child_text,
    local_name,
    parse_duration,
    parse_notes,
    read_score_xml,
)


REPO = Path(__file__).resolve().parents[2]
DEFAULT_NOTE_AUDIT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "render-gold-omr"
    / "render-gold-note-level-audit.json"
)
DEFAULT_OUTPUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clean-failure-modes"
    / "structure-attribution.json"
)
ONSET_TOLERANCE_QUARTERS = 0.25
DURATION_TOLERANCE_QUARTERS = 0.125


@dataclass(frozen=True)
class MeasureInfo:
    index: int
    duration_quarters: float
    expected_quarters: float | None
    time_signature: str | None
    repeat_marks: int


def round_metric(value: float | None) -> float | None:
    return None if value is None or not math.isfinite(value) else round(value, 6)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def median_absolute_deviation(values: list[float]) -> float:
    if not values:
        return math.nan
    centre = statistics.median(values)
    return statistics.median(abs(value - centre) for value in values)


def quantize_offset(value: float) -> float:
    return round(value / ONSET_TOLERANCE_QUARTERS) * ONSET_TOLERANCE_QUARTERS


def classify_onset_offsets(offsets: list[float]) -> dict[str, Any]:
    if not offsets:
        return {
            "mode": "no-aligned-notes",
            "standardDeviation": None,
            "medianAbsoluteDeviation": None,
            "stepCount": 0,
        }
    quantized = [quantize_offset(value) for value in offsets]
    changes = [right - left for left, right in zip(quantized, quantized[1:]) if right != left]
    nondecreasing = sum(change > 0 for change in changes)
    nonincreasing = sum(change < 0 for change in changes)
    monotonic_share = (
        max(nondecreasing, nonincreasing) / len(changes) if changes else 1.0
    )
    standard_deviation = statistics.pstdev(offsets)
    mad = median_absolute_deviation(offsets)
    offset_range = max(offsets) - min(offsets)
    step_density = len(changes) / max(1, len(offsets) - 1)
    nonzero_share = sum(abs(value) > ONSET_TOLERANCE_QUARTERS for value in offsets) / len(offsets)

    if nonzero_share <= 0.05:
        mode = "aligned-or-isolated-error"
    elif mad <= 0.125 and offset_range <= 0.5:
        mode = "constant-offset"
    elif len(changes) >= 2 and monotonic_share >= 0.85 and offset_range >= 1.0:
        mode = "monotonic-drift-after-edit"
    elif len(changes) >= 1 and step_density <= 0.12:
        mode = "piecewise-constant-steps"
    else:
        mode = "random"
    return {
        "mode": mode,
        "pairedOffsetCount": len(offsets),
        "medianSignedOffsetQuarters": round_metric(statistics.median(offsets)),
        "standardDeviation": round_metric(standard_deviation),
        "medianAbsoluteDeviation": round_metric(mad),
        "minimumOffsetQuarters": round_metric(min(offsets)),
        "maximumOffsetQuarters": round_metric(max(offsets)),
        "stepCount": len(changes),
        "stepDensity": round_metric(step_density),
        "monotonicChangeShare": round_metric(monotonic_share),
        "nonzeroOffsetShare": round_metric(nonzero_share),
    }


def parse_measure_info(path: Path) -> list[MeasureInfo]:
    root = ET.fromstring(read_score_xml(path))
    parts = [item for item in root.iter() if local_name(str(item.tag)) == "part"]
    candidates = [_parse_part_measures(part) for part in parts]
    return max(candidates, key=len) if candidates else []


def _parse_part_measures(part: ET.Element) -> list[MeasureInfo]:
    divisions = 1.0
    beats: float | None = None
    beat_type: float | None = None
    rows: list[MeasureInfo] = []
    measures = [item for item in list(part) if local_name(str(item.tag)) == "measure"]
    for index, measure in enumerate(measures, start=1):
        cursor = 0.0
        maximum = 0.0
        repeat_marks = 0
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
                        beats = float(child_text(time, "beats"))
                        beat_type = float(child_text(time, "beat-type"))
                    except ValueError:
                        beats = beat_type = None
            elif name == "backup":
                cursor = max(0.0, cursor - parse_duration(item, divisions))
            elif name == "forward":
                cursor += parse_duration(item, divisions)
                maximum = max(maximum, cursor)
            elif name == "note":
                duration = parse_duration(item, divisions)
                if child(item, "chord") is None:
                    cursor += duration
                    maximum = max(maximum, cursor)
            elif name == "barline":
                repeat_marks += sum(
                    1 for nested in item.iter() if local_name(str(nested.tag)) == "repeat"
                )
        expected = beats * 4.0 / beat_type if beats and beat_type else None
        signature = f"{int(beats)}/{int(beat_type)}" if beats and beat_type else None
        rows.append(MeasureInfo(index, maximum, expected, signature, repeat_marks))
    return rows


def summarize_measure_structure(gold: list[MeasureInfo], draft: list[MeasureInfo]) -> dict[str, Any]:
    same_count = len(gold) == len(draft)
    comparable = min(len(gold), len(draft))
    gold_unbalanced = [
        row.index
        for row in gold
        if row.expected_quarters is not None
        and abs(row.duration_quarters - row.expected_quarters) > DURATION_TOLERANCE_QUARTERS
    ]
    draft_unbalanced = [
        row.index
        for row in draft
        if row.expected_quarters is not None
        and abs(row.duration_quarters - row.expected_quarters) > DURATION_TOLERANCE_QUARTERS
    ]
    duration_mismatches = [
        index + 1
        for index in range(comparable)
        if abs(gold[index].duration_quarters - draft[index].duration_quarters)
        > DURATION_TOLERANCE_QUARTERS
    ]
    gold_pickup = bool(
        gold
        and gold[0].expected_quarters is not None
        and gold[0].duration_quarters < gold[0].expected_quarters - DURATION_TOLERANCE_QUARTERS
    )
    draft_pickup = bool(
        draft
        and draft[0].expected_quarters is not None
        and draft[0].duration_quarters < draft[0].expected_quarters - DURATION_TOLERANCE_QUARTERS
    )
    gold_meter_changes = sum(
        left.time_signature != right.time_signature
        for left, right in zip(gold, gold[1:])
    )
    draft_meter_changes = sum(
        left.time_signature != right.time_signature
        for left, right in zip(draft, draft[1:])
    )
    gold_repeats = sum(row.repeat_marks for row in gold)
    draft_repeats = sum(row.repeat_marks for row in draft)

    if not same_count:
        if gold_pickup != draft_pickup:
            mode = "measure-count-mismatch-pickup"
        elif gold_repeats != draft_repeats:
            mode = "measure-count-mismatch-repeat-handling"
        elif gold_meter_changes or draft_meter_changes:
            mode = "measure-count-mismatch-inline-meter"
        else:
            mode = "measure-count-mismatch-other"
    elif duration_mismatches:
        mode = "same-count-duration-reconstruction"
    elif draft_unbalanced != gold_unbalanced:
        mode = "same-count-meter-balance"
    else:
        mode = "same-count-measure-index-other"
    return {
        "mode": mode,
        "goldMeasureCount": len(gold),
        "predictedMeasureCount": len(draft),
        "sameMeasureCount": same_count,
        "goldPickup": gold_pickup,
        "predictedPickup": draft_pickup,
        "goldRepeatMarkCount": gold_repeats,
        "predictedRepeatMarkCount": draft_repeats,
        "goldInlineMeterChangeCount": gold_meter_changes,
        "predictedInlineMeterChangeCount": draft_meter_changes,
        "goldUnbalancedMeasureCount": len(gold_unbalanced),
        "predictedUnbalancedMeasureCount": len(draft_unbalanced),
        "durationMismatchCount": len(duration_mismatches),
        "firstDurationMismatchMeasure": duration_mismatches[0] if duration_mismatches else None,
    }


def build_piece_attribution(row: dict[str, Any]) -> dict[str, Any]:
    gold_path = REPO / str(row["goldScore"])
    draft_path = REPO / str(row["recognizedScore"])
    gold_notes = parse_notes(gold_path)
    draft_notes = parse_notes(draft_path)
    pairs = align_notes(gold_notes, draft_notes)
    paired = [
        (gold_notes[int(gold_index)], draft_notes[int(draft_index)])
        for gold_index, draft_index in pairs
        if gold_index is not None and draft_index is not None
    ]
    offsets = [draft.onset_quarters - gold.onset_quarters for gold, draft in paired]
    onset = classify_onset_offsets(offsets)
    first_offset = next(
        (
            gold.measure_index
            for gold, draft in paired
            if abs(draft.onset_quarters - gold.onset_quarters) > ONSET_TOLERANCE_QUARTERS
        ),
        None,
    )
    onset["firstOffsetMeasure"] = first_offset
    measures = summarize_measure_structure(
        parse_measure_info(gold_path), parse_measure_info(draft_path)
    )
    return {
        "pieceId": row["piece"],
        "onsetQuarterAccuracy": row["onsetQuarterAccuracy"],
        "measureAccuracy": row["measureAccuracy"],
        "onsetFailed": float(row["onsetQuarterAccuracy"]) < 0.95,
        "measureFailed": float(row["measureAccuracy"]) < 0.95,
        "onset": onset,
        "measure": measures,
    }


def concentration(
    rows: list[dict[str, Any]],
    key: str,
    failure_key: str,
    known_systematic_modes: set[str],
) -> dict[str, Any]:
    failed = [row for row in rows if row[failure_key]]
    counts = Counter(row[key]["mode"] for row in failed)
    dominant_mode, dominant_count = counts.most_common(1)[0] if counts else (None, 0)
    share = dominant_count / len(failed) if failed else 0.0
    known_systematic_count = sum(counts[mode] for mode in known_systematic_modes)
    known_systematic_share = known_systematic_count / len(failed) if failed else 0.0
    return {
        "failedPieceCount": len(failed),
        "modeCounts": dict(sorted(counts.items())),
        "dominantMode": dominant_mode,
        "dominantModeShare": round_metric(share),
        "moreThanHalfConcentratedInOneMode": share > 0.5,
        "knownSystematicModeCount": known_systematic_count,
        "knownSystematicModeShare": round_metric(known_systematic_share),
        "moreThanHalfExplainedByKnownSystematicModes": known_systematic_share > 0.5,
    }


def build_report(note_audit: dict[str, Any]) -> dict[str, Any]:
    rows = [build_piece_attribution(row) for row in note_audit["rows"] if row["status"] == "ok"]
    onset = concentration(
        rows,
        "onset",
        "onsetFailed",
        {"constant-offset", "piecewise-constant-steps", "monotonic-drift-after-edit"},
    )
    measure = concentration(
        rows,
        "measure",
        "measureFailed",
        {
            "measure-count-mismatch-pickup",
            "measure-count-mismatch-repeat-handling",
            "measure-count-mismatch-inline-meter",
        },
    )
    return {
        "contract": "western-m4-clean-structure-attribution-v1",
        "evidenceRole": "clean-digital-render-root-cause-diagnostic",
        "thresholds": {
            "minOnsetQuarterAccuracy": 0.95,
            "minMeasureAccuracy": 0.95,
            "onsetToleranceQuarters": ONSET_TOLERANCE_QUARTERS,
            "durationToleranceQuarters": DURATION_TOLERANCE_QUARTERS,
        },
        "aggregate": {
            "pieceCount": len(rows),
            "onset": onset,
            "measure": measure,
            "systematicFailureModeSupported": (
                onset["moreThanHalfExplainedByKnownSystematicModes"]
                or measure["moreThanHalfExplainedByKnownSystematicModes"]
            ),
            "broadCapabilityDeficitSupported": (
                not onset["moreThanHalfExplainedByKnownSystematicModes"]
                and not measure["moreThanHalfExplainedByKnownSystematicModes"]
            ),
        },
        "method": {
            "alignment": "same pitch-sequence Levenshtein alignment as the frozen note-level evaluator",
            "signedOffset": "predicted onset quarters minus gold onset quarters",
            "measureDuration": "maximum MusicXML voice cursor per measure, compared with active meter",
            "scope": "diagnostic only; no student or fresh-blind claim",
        },
        "studentGateReady": False,
        "runtimeEffect": "none",
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Attribute clean-render onset and measure failures.")
    parser.add_argument("--note-audit", type=Path, default=DEFAULT_NOTE_AUDIT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    source = json.loads(args.note_audit.read_text(encoding="utf-8"))
    report = build_report(source)
    report["source"] = {
        "path": args.note_audit.relative_to(REPO).as_posix(),
        "sha256": sha256(args.note_audit),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": args.output.relative_to(REPO).as_posix(), **report["aggregate"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
