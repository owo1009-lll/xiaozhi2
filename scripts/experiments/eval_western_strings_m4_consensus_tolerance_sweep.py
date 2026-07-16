#!/usr/bin/env python3
"""Audit whether one uniform OMR onset-consensus tolerance can expand M4.

This is evaluation-only. Engine outputs select notes; independent gold only
measures the selected subset. No page-specific exception is allowed.
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


DEFAULT_OUT = (
    consensus.REPO
    / "data/experiments/western-strings-m4/engine-consensus-tolerance-sweep/report.json"
)
TOLERANCES = (0.0, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25)
MODE_SPECS = {
    "audiveris-homr": ("homr",),
    "audiveris-homr-oemer": ("homr", "oemer"),
}


def configuration_is_candidate(summary: dict[str, Any]) -> bool:
    return bool(
        summary.get("allPiecesPrecisionPassed")
        and summary.get("allPiecesCoveragePassed")
    )


def evaluate_configuration(
    pieces: list[dict[str, Any]],
    required_engines: tuple[str, ...],
    tolerance: float,
) -> dict[str, Any]:
    per_piece = []
    for piece in pieces:
        anchor = piece["anchor"]
        gold = piece["gold"]
        engines = piece["engines"]
        maps = piece["maps"]
        if not all(engines.get(name) for name in required_engines):
            selected = []
        else:
            selected = consensus.select_anchor_indexes(
                anchor,
                engines,
                maps,
                required_engines=required_engines,
                local_onset_tolerance=tolerance,
            )
        metrics = consensus.evaluate_selection(gold, anchor, selected)
        per_piece.append({"pieceId": piece["pieceId"], **metrics})

    selected_count = sum(row["selectedNotes"] for row in per_piece)
    correct_count = sum(row["correctNotes"] for row in per_piece)
    gold_count = sum(piece["goldNoteCount"] for piece in pieces)
    precision = correct_count / selected_count if selected_count else None
    coverage = correct_count / gold_count if gold_count else 0.0
    summary = {
        "requiredEngines": list(required_engines),
        "localOnsetToleranceQuarters": tolerance,
        "selectedNotes": selected_count,
        "correctNotes": correct_count,
        "wrongNotes": selected_count - correct_count,
        "precision": round(precision, 6) if precision is not None else None,
        "goldCoverage": round(coverage, 6),
        "allPiecesPrecisionPassed": all(
            row["precisionPassed"] for row in per_piece
        ),
        "allPiecesCoveragePassed": all(
            row["goldCoverage"] >= consensus.MIN_GOLD_COVERAGE
            for row in per_piece
        ),
        "perPiece": per_piece,
    }
    summary["expansionCandidate"] = configuration_is_candidate(summary)
    return summary


def load_pieces(
    audiveris_report: dict[str, Any],
    homr_report: dict[str, Any],
    oemer_report: dict[str, Any],
) -> list[dict[str, Any]]:
    audiveris_rows = {
        str(row.get("pieceId") or row.get("piece") or ""): row
        for row in audiveris_report.get("rows", [])
        if row.get("variant") == "up2" and row.get("status") == "ok"
    }
    engine_rows = {
        "homr": {
            str(row.get("pieceId") or ""): row
            for row in homr_report.get("rows", [])
            if row.get("parseOk")
        },
        "oemer": {
            str(row.get("pieceId") or ""): row
            for row in oemer_report.get("rows", [])
            if row.get("parseOk")
        },
    }
    pieces = []
    for piece_id, row in sorted(audiveris_rows.items()):
        anchor = consensus.read_notes(row.get("draftPath"))
        gold = consensus.read_notes(row.get("goldPath"))
        engines = {
            name: consensus.read_notes(rows[piece_id].get("draftPath"))
            for name, rows in engine_rows.items()
            if piece_id in rows
        }
        pieces.append(
            {
                "pieceId": piece_id,
                "anchor": anchor,
                "gold": gold,
                "goldNoteCount": len(gold),
                "engines": engines,
                "maps": {
                    name: consensus.aligned_index_map(anchor, notes)
                    for name, notes in engines.items()
                    if notes
                },
            }
        )
    return pieces


def build_report(
    audiveris_report: dict[str, Any],
    homr_report: dict[str, Any],
    oemer_report: dict[str, Any],
) -> dict[str, Any]:
    pieces = load_pieces(audiveris_report, homr_report, oemer_report)
    configurations = [
        evaluate_configuration(pieces, required, tolerance)
        for required in MODE_SPECS.values()
        for tolerance in TOLERANCES
    ]
    candidates = [row for row in configurations if row["expansionCandidate"]]
    return {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evaluationMode": "eval-only-uniform-consensus-tolerance-sweep",
        "selectionDiscipline": (
            "one uniform engine/tolerance policy across every page; "
            "independent gold is evaluation-only"
        ),
        "thresholds": {
            "minPrecision": consensus.MIN_PRECISION,
            "minGoldCoverage": consensus.MIN_GOLD_COVERAGE,
            "minSelectedPerPiece": consensus.MIN_SELECTED_PER_PIECE,
        },
        "pieceCount": len(pieces),
        "configurationCount": len(configurations),
        "configurations": configurations,
        "expansionCandidates": candidates,
        "expansionCandidateFound": bool(candidates),
        "runtimeReady": False,
        "studentGateReady": False,
        "blockingReasons": (
            []
            if candidates
            else ["no-uniform-consensus-tolerance-passes-every-piece"]
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audiveris-report", default=str(consensus.DEFAULT_AUDIVERIS_REPORT))
    parser.add_argument("--homr-report", default=str(consensus.DEFAULT_HOMR_REPORT))
    parser.add_argument("--oemer-report", default=str(consensus.DEFAULT_OEMER_REPORT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()
    report = build_report(
        consensus.read_report(Path(args.audiveris_report)),
        consensus.read_report(Path(args.homr_report)),
        consensus.read_report(Path(args.oemer_report)),
    )
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "report": str(out.relative_to(consensus.REPO)),
                "configurationCount": report["configurationCount"],
                "expansionCandidateFound": report["expansionCandidateFound"],
                "studentGateReady": report["studentGateReady"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
