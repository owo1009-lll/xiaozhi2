#!/usr/bin/env python3
"""Eval-only evidence for whether printed repeat marks should be expanded."""
from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

from music21 import converter


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SCORE = (
    REPO / "音频/Bach独奏小提琴数据集/bach-violin-dataset"
    / "scores/bwv1005/bwv1005_mov4.mxl"
)
DEFAULT_ALIGNMENT = (
    REPO / "音频/Bach独奏小提琴数据集/bach-violin-dataset"
    / "alignments/emil-telmanyi/emil-telmanyi_bwv1005_mov4.csv"
)
DEFAULT_BEIJING = (
    REPO / "data/experiments/western-strings-m4/independent-real-photo-gold"
    / "beijing-jinshan.independent-human-gold.musicxml"
)
DEFAULT_OP45_CANDIDATE = (
    REPO / "data/experiments/western-strings-m4/op45-34-same-edition-gold-candidate"
    / "op45-34-homr-candidate.musicxml"
)
DEFAULT_OP45_PUBLIC_REFERENCE = (
    REPO / "data/experiments/western-strings-m4/op45-34-public-reference/input.musicxml"
)
DEFAULT_OUT = REPO / "data/experiments/western-strings-m4/repeat-route-probe"


def note_event_count(part) -> int:
    return len(list(part.recurse().notes))


def repeat_markers(part) -> list[dict]:
    rows = []
    for measure in part.getElementsByClass("Measure"):
        for side, barline in (("left", measure.leftBarline), ("right", measure.rightBarline)):
            direction = getattr(barline, "direction", None)
            if direction:
                rows.append({
                    "measure": int(measure.number),
                    "side": side,
                    "direction": str(direction),
                })
    return rows


def alignment_row_count(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return sum(1 for _ in csv.DictReader(handle))


def evaluate_route(score_path: Path, alignment_path: Path) -> dict:
    score = converter.parse(str(score_path))
    part = score.parts[0]
    markers = repeat_markers(part)
    printed = note_event_count(part)
    expanded = note_event_count(part.expandRepeats()) if markers else printed
    observed = alignment_row_count(alignment_path)
    printed_error = abs(printed - observed)
    expanded_error = abs(expanded - observed)
    return {
        "score": str(score_path),
        "alignmentTruth": str(alignment_path),
        "truthDefinition": "public performance note-alignment row count",
        "repeatMarkers": markers,
        "printedNoteEvents": printed,
        "expandedNoteEvents": expanded,
        "observedPerformanceEvents": observed,
        "printedAbsoluteCountError": printed_error,
        "expandedAbsoluteCountError": expanded_error,
        "preferredRouteByCount": (
            "printed"
            if printed_error < expanded_error
            else "expanded"
            if expanded_error < printed_error
            else "undetermined"
        ),
        "automaticExpansionSupported": expanded_error < printed_error,
    }


def inspect_no_repeat_case(score_path: Path) -> dict:
    score = converter.parse(str(score_path))
    part = score.parts[0]
    markers = repeat_markers(part)
    return {
        "score": str(score_path),
        "noteEvents": note_event_count(part),
        "repeatMarkers": markers,
        "status": "not-applicable-no-repeat-markers" if not markers else "repeat-markers-present",
    }


def inspect_op45_repeat_hypothesis(candidate_path: Path, public_reference_path: Path) -> dict:
    candidate = inspect_no_repeat_case(candidate_path)
    public_reference = inspect_no_repeat_case(public_reference_path)
    marker_count = len(candidate["repeatMarkers"]) + len(public_reference["repeatMarkers"])
    return {
        "sameEditionCandidate": candidate,
        "independentPublicReference": public_reference,
        "machineReadableRepeatMarkerCount": marker_count,
        "status": (
            "repeat-hypothesis-testable"
            if marker_count
            else "repeat-hypothesis-unsupported-no-markers"
        ),
        "interpretation": (
            "At least one readable score contains repeat markers; route selection still requires performance truth."
            if marker_count
            else "Neither readable Op.45 score contains repeat markers, so the 52.56% audio agreement cannot be attributed to repeat expansion from current evidence."
        ),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--score", default=str(DEFAULT_SCORE))
    parser.add_argument("--alignment", default=str(DEFAULT_ALIGNMENT))
    parser.add_argument("--beijing-score", default=str(DEFAULT_BEIJING))
    parser.add_argument("--op45-candidate", default=str(DEFAULT_OP45_CANDIDATE))
    parser.add_argument("--op45-public-reference", default=str(DEFAULT_OP45_PUBLIC_REFERENCE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    route = evaluate_route(Path(args.score).resolve(), Path(args.alignment).resolve())
    beijing = inspect_no_repeat_case(Path(args.beijing_score).resolve())
    op45 = inspect_op45_repeat_hypothesis(
        Path(args.op45_candidate).resolve(),
        Path(args.op45_public_reference).resolve(),
    )
    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "scope": "eval-only repeat-route evidence",
        "productionPolicyChanged": False,
        "beijing": beijing,
        "op45": op45,
        "routeEvidence": route,
        "decision": (
            "keep-repeat-route-review-required"
            if not route["automaticExpansionSupported"]
            else "expansion-candidate-requires-more-pieces"
        ),
        "interpretation": (
            "Repeat symbols do not prove that a performance takes the repeat. "
            "The tested Bach performance matches the printed event count and would be doubled incorrectly by blind expansion."
        ),
    }
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out / "report.md").write_text(
        "\n".join([
            "# M4 repeat-route probe",
            "",
            "Eval-only; no production route or student feedback policy changed.",
            "",
            f"- Beijing case: `{beijing['status']}`",
            f"- Op.45 repeat hypothesis: `{op45['status']}`",
            f"- Op.45 machine-readable repeat markers: `{op45['machineReadableRepeatMarkerCount']}`",
            f"- Bach printed events: `{route['printedNoteEvents']}`",
            f"- Bach expanded events: `{route['expandedNoteEvents']}`",
            f"- Performance alignment rows: `{route['observedPerformanceEvents']}`",
            f"- Preferred route by count: `{route['preferredRouteByCount']}`",
            f"- Decision: `{report['decision']}`",
            "",
            report["interpretation"],
            "",
            op45["interpretation"],
            "",
        ]),
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
