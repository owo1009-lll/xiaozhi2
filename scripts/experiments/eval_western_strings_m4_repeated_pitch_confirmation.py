#!/usr/bin/env python3
"""Confirm a frozen repeated-pitch consensus rule on independent photo gold.

The rule was discovered on the five real-photo Kayser pages: an Audiveris and
HOMR pitch/onset consensus note is sent to review when either adjacent
Audiveris score note has the same MIDI pitch.  This script evaluates that
already-frozen rule on one independent synthetic-photo Bach movement.  Gold is
used only for the final measurement; no runtime score or OMR output is edited.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import eval_western_strings_m4_engine_consensus as consensus


DEFAULT_PIECE = "bwv1001_mov1"
DEFAULT_PHOTO_ROOT = (
    consensus.REPO
    / "data/experiments/western-strings-m4/render-gold-omr-photo"
)
DEFAULT_HOMR_ROOT = (
    consensus.REPO
    / "data/experiments/western-strings-m4/homr-synthetic-photo-confirmation"
)
DEFAULT_OUT = (
    DEFAULT_HOMR_ROOT / "repeated-pitch-confirmation.json"
)
LOCAL_ONSET_TOLERANCE_QUARTERS = 0.25


def has_adjacent_repeated_pitch(notes: list[consensus.Note], index: int) -> bool:
    midi = notes[index].midi
    return bool(
        (index > 0 and notes[index - 1].midi == midi)
        or (index + 1 < len(notes) and notes[index + 1].midi == midi)
    )


def find_gold_score(piece: str) -> Path:
    candidates = [
        path
        for path in consensus.REPO.rglob(f"{piece}.mxl")
        if "bach-violin-dataset" in path.as_posix()
        and "/scores/" in path.as_posix()
    ]
    if len(candidates) != 1:
        raise FileNotFoundError(
            f"expected one independent Bach gold score for {piece}, found {len(candidates)}"
        )
    return candidates[0]


def evaluate_piece(piece: str, photo_root: Path, homr_root: Path) -> dict[str, Any]:
    gold_path = find_gold_score(piece)
    audiveris_path = photo_root / piece / "omr" / f"{piece}.mxl"
    homr_paths = sorted((homr_root / piece / "pages").glob("page-*.musicxml"))
    if not audiveris_path.is_file():
        raise FileNotFoundError(audiveris_path)
    if not homr_paths:
        raise FileNotFoundError(
            f"pagewise HOMR MusicXML missing under {homr_root / piece / 'pages'}"
        )

    gold = consensus.read_notes(str(gold_path))
    anchor = consensus.read_notes(str(audiveris_path))
    homr = consensus.read_notes("|".join(str(path) for path in homr_paths))
    if not gold or not anchor or not homr:
        raise RuntimeError("gold, Audiveris, and HOMR must all contain pitched notes")

    mapping = consensus.aligned_index_map(anchor, homr)
    selected = consensus.select_anchor_indexes(
        anchor,
        {"homr": homr},
        {"homr": mapping},
        required_engines=("homr",),
        local_onset_tolerance=LOCAL_ONSET_TOLERANCE_QUARTERS,
    )
    filtered = [
        index for index in selected if not has_adjacent_repeated_pitch(anchor, index)
    ]
    baseline = consensus.evaluate_selection(gold, anchor, selected)
    repeated_pitch_filtered = consensus.evaluate_selection(gold, anchor, filtered)
    return {
        "pieceId": piece,
        "goldPath": str(gold_path.relative_to(consensus.REPO)).replace("\\", "/"),
        "audiverisPath": str(audiveris_path.relative_to(consensus.REPO)).replace("\\", "/"),
        "homrPaths": [
            str(path.relative_to(consensus.REPO)).replace("\\", "/")
            for path in homr_paths
        ],
        "goldNotes": len(gold),
        "audiverisNotes": len(anchor),
        "homrNotes": len(homr),
        "baselineConsensus": baseline,
        "repeatedPitchFiltered": repeated_pitch_filtered,
        "removedAdjacentRepeatedPitchNotes": len(selected) - len(filtered),
    }


def build_report(piece: dict[str, Any]) -> dict[str, Any]:
    metrics = piece["repeatedPitchFiltered"]
    candidate_passed = bool(metrics.get("passed"))
    return {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evaluationMode": "eval-only-first-independent-photo-confirmation",
        "selectionDiscipline": (
            "the repeated-pitch exclusion and onset tolerance were frozen on the "
            "five Kayser real-photo development pages before this Bach movement "
            "was evaluated"
        ),
        "policy": {
            "requiredEngines": ["audiveris", "homr"],
            "localOnsetToleranceQuarters": LOCAL_ONSET_TOLERANCE_QUARTERS,
            "excludeAnchorWhenAdjacentMidiMatches": True,
        },
        "thresholds": {
            "minPrecision": consensus.MIN_PRECISION,
            "minGoldCoverage": consensus.MIN_GOLD_COVERAGE,
            "minSelectedNotes": consensus.MIN_SELECTED_PER_PIECE,
        },
        "piece": piece,
        "confirmationPassed": candidate_passed,
        "candidateRejected": not candidate_passed,
        "remainingIndependentPiecesConsumed": 0,
        "runtimeReady": False,
        "studentGateReady": False,
        "blockingReasons": (
            ["repeated-pitch-consensus-fails-first-independent-photo-confirmation"]
            if not candidate_passed
            else ["single-synthetic-photo-confirmation-is-not-a-student-release-gate"]
        ),
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    piece = report["piece"]
    before = piece["baselineConsensus"]
    after = piece["repeatedPitchFiltered"]
    lines = [
        "# M4 repeated-pitch consensus confirmation",
        "",
        "Eval-only. No score, OMR output, runtime policy, or student gate was changed.",
        "",
        f"- piece: {piece['pieceId']}",
        f"- baseline precision / coverage: {before['precision']} / {before['goldCoverage']}",
        f"- repeated-pitch-filtered precision / coverage: {after['precision']} / {after['goldCoverage']}",
        f"- removed adjacent repeated-pitch notes: {piece['removedAdjacentRepeatedPitchNotes']}",
        f"- confirmation passed: {report['confirmationPassed']}",
        f"- candidate rejected: {report['candidateRejected']}",
        "- remaining independent pieces consumed: 0",
        "- runtime ready: false",
        "- student gate ready: false",
        "",
        "The rule improved the five-page development result, but it did not reach",
        "the 98% precision floor on the first independent synthetic-photo movement.",
        "The remaining five movements were left untouched instead of tuning on them.",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--piece", default=DEFAULT_PIECE)
    parser.add_argument("--photo-root", default=str(DEFAULT_PHOTO_ROOT))
    parser.add_argument("--homr-root", default=str(DEFAULT_HOMR_ROOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    report = build_report(
        evaluate_piece(args.piece, Path(args.photo_root), Path(args.homr_root))
    )
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(out.with_suffix(".md"), report)
    print(
        json.dumps(
            {
                "report": str(out.relative_to(consensus.REPO)),
                "confirmationPassed": report["confirmationPassed"],
                "candidateRejected": report["candidateRejected"],
                "studentGateReady": report["studentGateReady"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
