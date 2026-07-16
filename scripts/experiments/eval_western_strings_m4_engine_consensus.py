#!/usr/bin/env python3
"""Evaluate cross-engine OMR consensus on the frozen real-photo benchmark.

The experiment uses Audiveris as the coordinate-bearing anchor and aligns HOMR
and Oemer note sequences to it. Gold is used only after selection, to evaluate
the selected subset. Nothing in this script updates the score store or runtime
OMR policy.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eval_western_strings_m4_omr_benchmark import (
    REPO,
    Note,
    align_notes,
    parse_notes_many,
    repo_path,
)


DEFAULT_AUDIVERIS_REPORT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-real-jpg-variants"
    / "real-jpg-omr-summary.json"
)
DEFAULT_HOMR_REPORT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "homr-source-benchmark"
    / "homr-source-benchmark.json"
)
DEFAULT_OEMER_REPORT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "oemer-source-benchmark"
    / "oemer-source-benchmark.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "engine-consensus"
)
MIN_PRECISION = 0.98
MIN_GOLD_COVERAGE = 0.20
MIN_SELECTED_PER_PIECE = 10


def read_report(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(path)
    return json.loads(path.read_text(encoding="utf-8"))


def split_paths(value: Any) -> list[Path]:
    return [repo_path(item) for item in str(value or "").split("|") if item.strip()]


def read_notes(value: Any) -> list[Note]:
    paths = split_paths(value)
    if not paths or not all(path.is_file() for path in paths):
        return []
    return parse_notes_many(paths)


def read_oemer_coordinates(
    row: dict[str, Any],
    expected_note_count: int,
) -> tuple[dict[int, dict[str, Any]], str]:
    if row.get("coordinateAdapterReady") is not True:
        return {}, ""
    sidecar_value = row.get("coordinateSidecarPath")
    canvas_value = row.get("coordinateCanvasPath")
    if not sidecar_value or not canvas_value:
        return {}, ""
    sidecar = repo_path(sidecar_value)
    canvas = repo_path(canvas_value)
    if not sidecar.is_file() or not canvas.is_file():
        return {}, ""
    payload = read_report(sidecar)
    notes = payload.get("notes") or []
    if (
        payload.get("coordinateSpace") != "oemer-clean-dewarped-canvas"
        or int(payload.get("coordinateNoteCount") or -1) != expected_note_count
        or len(notes) != expected_note_count
    ):
        return {}, ""
    coordinates: dict[int, dict[str, Any]] = {}
    for note in notes:
        index = note.get("xmlPitchedNoteIndex")
        bbox = note.get("bboxNormalized")
        center = note.get("centerPixels")
        if (
            not isinstance(index, int)
            or not isinstance(bbox, list)
            or len(bbox) != 4
            or not all(isinstance(value, (int, float)) for value in bbox)
            or not isinstance(center, list)
            or len(center) != 2
            or not all(isinstance(value, (int, float)) for value in center)
        ):
            return {}, ""
        coordinates[index] = {
            "bboxNormalized": [round(float(value), 8) for value in bbox],
            "centerPixels": [round(float(value), 3) for value in center],
            "measureIndex": int(note.get("measureIndex") or 0),
        }
    if set(coordinates) != set(range(expected_note_count)):
        return {}, ""
    return coordinates, str(canvas.relative_to(REPO)).replace("\\", "/")


def local_onsets(notes: list[Note]) -> list[float]:
    starts: dict[int, float] = {}
    for note in notes:
        starts[note.measure_index] = min(
            starts.get(note.measure_index, note.onset_quarters),
            note.onset_quarters,
        )
    return [note.onset_quarters - starts[note.measure_index] for note in notes]


def aligned_index_map(anchor: list[Note], other: list[Note]) -> dict[int, int]:
    return {
        anchor_index: other_index
        for anchor_index, other_index in align_notes(anchor, other)
        if anchor_index is not None and other_index is not None
    }


def gold_index_map(gold: list[Note], anchor: list[Note]) -> dict[int, int]:
    return {
        anchor_index: gold_index
        for gold_index, anchor_index in align_notes(gold, anchor)
        if gold_index is not None and anchor_index is not None
    }


def audiveris_omr_path(draft_value: Any) -> str:
    paths = split_paths(draft_value)
    if not paths:
        return ""
    direct = [path.with_suffix(".omr") for path in paths if path.with_suffix(".omr").is_file()]
    candidates = direct or sorted({item for path in paths for item in path.parent.glob("*.omr")})
    return str(candidates[0].relative_to(REPO)) if len(candidates) == 1 else ""


def select_anchor_indexes(
    anchor: list[Note],
    engines: dict[str, list[Note]],
    maps: dict[str, dict[int, int]],
    *,
    required_engines: tuple[str, ...],
    local_onset_tolerance: float | None = None,
) -> list[int]:
    anchor_local = local_onsets(anchor)
    engine_local = {name: local_onsets(notes) for name, notes in engines.items()}
    selected: list[int] = []
    for anchor_index, note in enumerate(anchor):
        supported = True
        for engine_name in required_engines:
            other_index = maps.get(engine_name, {}).get(anchor_index)
            if other_index is None:
                supported = False
                break
            other = engines[engine_name][other_index]
            if other.midi != note.midi:
                supported = False
                break
            if local_onset_tolerance is not None and abs(
                anchor_local[anchor_index] - engine_local[engine_name][other_index]
            ) > local_onset_tolerance:
                supported = False
                break
        if supported:
            selected.append(anchor_index)
    return selected


def evaluate_selection(
    gold: list[Note],
    anchor: list[Note],
    selected: list[int],
) -> dict[str, Any]:
    mapping = gold_index_map(gold, anchor)
    correct = sum(
        1
        for anchor_index in selected
        if anchor_index in mapping and gold[mapping[anchor_index]].midi == anchor[anchor_index].midi
    )
    selected_count = len(selected)
    precision = correct / selected_count if selected_count else None
    coverage = correct / len(gold) if gold else 0.0
    return {
        "selectedNotes": selected_count,
        "correctNotes": correct,
        "wrongNotes": selected_count - correct,
        "precision": round(precision, 6) if precision is not None else None,
        "goldCoverage": round(coverage, 6),
        "precisionPassed": bool(
            selected_count >= MIN_SELECTED_PER_PIECE
            and precision is not None
            and precision >= MIN_PRECISION
        ),
        "passed": bool(
            selected_count >= MIN_SELECTED_PER_PIECE
            and precision is not None
            and precision >= MIN_PRECISION
            and coverage >= MIN_GOLD_COVERAGE
        ),
    }


def aggregate(per_piece: list[dict[str, Any]], mode: str) -> dict[str, Any]:
    rows = [row["modes"][mode] for row in per_piece]
    selected = sum(int(row["selectedNotes"]) for row in rows)
    correct = sum(int(row["correctNotes"]) for row in rows)
    gold = sum(int(row["goldNotes"]) for row in per_piece)
    precision = correct / selected if selected else None
    coverage = correct / gold if gold else 0.0
    return {
        "selectedNotes": selected,
        "correctNotes": correct,
        "wrongNotes": selected - correct,
        "precision": round(precision, 6) if precision is not None else None,
        "goldCoverage": round(coverage, 6),
        "allPiecesPassed": all(row["passed"] for row in rows),
        "allPiecesPrecisionPassed": all(row["precisionPassed"] for row in rows),
        "passedPieceCount": sum(bool(row["passed"]) for row in rows),
        "pieceCount": len(rows),
    }


def build_report(
    audiveris_report: dict[str, Any],
    homr_report: dict[str, Any],
    oemer_report: dict[str, Any],
) -> dict[str, Any]:
    audiveris_rows = {
        str(row.get("pieceId") or row.get("piece") or ""): row
        for row in audiveris_report.get("rows", [])
        if row.get("variant") == "up2" and row.get("status") == "ok"
    }
    homr_rows = {
        str(row.get("pieceId") or ""): row
        for row in homr_report.get("rows", [])
        if row.get("parseOk")
    }
    oemer_rows = {
        str(row.get("pieceId") or ""): row
        for row in oemer_report.get("rows", [])
        if row.get("parseOk")
    }
    per_piece: list[dict[str, Any]] = []
    selected_notes: list[dict[str, Any]] = []
    for piece_id, anchor_row in sorted(audiveris_rows.items()):
        anchor = read_notes(anchor_row.get("draftPath"))
        gold = read_notes(anchor_row.get("goldPath"))
        engines: dict[str, list[Note]] = {}
        if piece_id in homr_rows:
            engines["homr"] = read_notes(homr_rows[piece_id].get("draftPath"))
        if piece_id in oemer_rows:
            engines["oemer"] = read_notes(oemer_rows[piece_id].get("draftPath"))
        maps = {
            name: aligned_index_map(anchor, notes)
            for name, notes in engines.items()
            if notes
        }
        oemer_coordinates, oemer_canvas = read_oemer_coordinates(
            oemer_rows.get(piece_id, {}),
            len(engines.get("oemer") or []),
        )
        mode_specs = {
            "audiverisHomrPitch": (("homr",), None),
            "audiverisHomrPitchLocalOnset25": (("homr",), 0.25),
            "audiverisOemerPitch": (("oemer",), None),
            "allThreePitch": (("homr", "oemer"), None),
            "allAvailablePitchLocalOnset25": (
                ("homr", "oemer") if engines.get("oemer") else ("homr",),
                0.25,
            ),
        }
        mode_results: dict[str, Any] = {}
        coordinate_ready_selected: list[int] = []
        for mode, (required, onset_tolerance) in mode_specs.items():
            if not all(name in engines and engines[name] for name in required):
                selected: list[int] = []
            else:
                selected = select_anchor_indexes(
                    anchor,
                    engines,
                    maps,
                    required_engines=required,
                    local_onset_tolerance=onset_tolerance,
                )
            mode_results[mode] = evaluate_selection(gold, anchor, selected)
            if mode == "allAvailablePitchLocalOnset25":
                for anchor_index in selected:
                    candidate = {
                        "pieceId": piece_id,
                        "audiverisNoteIndex": anchor_index,
                        "midi": anchor[anchor_index].midi,
                        "measureIndex": anchor[anchor_index].measure_index,
                        "reviewLocatorReady": False,
                    }
                    oemer_index = maps.get("oemer", {}).get(anchor_index)
                    coordinate = oemer_coordinates.get(oemer_index) if oemer_index is not None else None
                    if coordinate is not None and oemer_canvas:
                        candidate.update(
                            {
                                "reviewLocatorReady": True,
                                "reviewLocator": {
                                    "engine": "oemer",
                                    "oemerNoteIndex": oemer_index,
                                    "canvasPath": oemer_canvas,
                                    **coordinate,
                                },
                            }
                        )
                        coordinate_ready_selected.append(anchor_index)
                    selected_notes.append(candidate)
        mode_results["coordinateReadyAllAvailablePitchLocalOnset25"] = evaluate_selection(
            gold,
            anchor,
            coordinate_ready_selected,
        )
        per_piece.append(
            {
                "pieceId": piece_id,
                "goldNotes": len(gold),
                "audiverisNotes": len(anchor),
                "homrAvailable": bool(engines.get("homr")),
                "oemerAvailable": bool(engines.get("oemer")),
                "audiverisOmrPath": audiveris_omr_path(anchor_row.get("draftPath")),
                "modes": mode_results,
            }
        )
    modes = [
        "audiverisHomrPitch",
        "audiverisHomrPitchLocalOnset25",
        "audiverisOemerPitch",
        "allThreePitch",
        "allAvailablePitchLocalOnset25",
        "coordinateReadyAllAvailablePitchLocalOnset25",
    ]
    summaries = {mode: aggregate(per_piece, mode) for mode in modes}
    candidate = summaries["allAvailablePitchLocalOnset25"]
    coordinate_candidate = summaries["coordinateReadyAllAvailablePitchLocalOnset25"]
    locator_ready_count = sum(bool(row.get("reviewLocatorReady")) for row in selected_notes)
    locator_coverage = locator_ready_count / len(selected_notes) if selected_notes else 0.0
    pilot_safe_subset_found = bool(
        candidate["precision"] is not None
        and candidate["precision"] >= MIN_PRECISION
        and candidate["allPiecesPrecisionPassed"]
    )
    runtime_ready = bool(
        per_piece
        and candidate["precision"] is not None
        and candidate["precision"] >= MIN_PRECISION
        and candidate["goldCoverage"] >= MIN_GOLD_COVERAGE
        and candidate["allPiecesPassed"]
        and all(row["audiverisOmrPath"] for row in per_piece)
        and locator_coverage == 1.0
    )
    return {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evaluationMode": "eval-only-cross-engine-consensus",
        "selectionDiscipline": "engine outputs only; independent gold is evaluation-only",
        "thresholds": {
            "minPrecision": MIN_PRECISION,
            "minGoldCoverage": MIN_GOLD_COVERAGE,
            "minSelectedPerPiece": MIN_SELECTED_PER_PIECE,
        },
        "anchorEngine": "audiveris-up2",
        "coordinatePolicy": {
            "candidateSource": "audiveris anchor plus mapped Oemer bbox sidecar",
            "selectedRowsCarryAudiverisNoteIndex": True,
            "selectedRowsCarryReviewLocator": True,
            "reviewLocatorReadyCount": locator_ready_count,
            "selectedCandidateCount": len(selected_notes),
            "reviewLocatorCoverage": round(locator_coverage, 6),
            "coordinateReadySubset": coordinate_candidate,
            "runtimeCoordinateAdapterReady": bool(selected_notes and locator_coverage == 1.0),
            "reason": (
                "all-per-piece-consensus-gates-passed"
                if runtime_ready
                else "consensus-or-review-locator-gate-not-passed-on-every-piece"
            ),
        },
        "summaries": summaries,
        "perPiece": per_piece,
        "selectedCandidateNotes": selected_notes,
        "pilotSafeSubsetFound": pilot_safe_subset_found,
        "runtimeReady": runtime_ready,
        "studentGateReady": False,
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# M4 cross-engine OMR consensus",
        "",
        "Eval-only. Gold is not used for selection and the student gate is unchanged.",
        "",
        "| mode | precision | gold coverage | passed pieces |",
        "|---|---:|---:|---:|",
    ]
    for mode, summary in report["summaries"].items():
        precision = summary["precision"]
        lines.append(
            f"| {mode} | {precision if precision is not None else 'n/a'} | "
            f"{summary['goldCoverage']} | {summary['passedPieceCount']}/{summary['pieceCount']} |"
        )
    lines.extend(
        [
            "",
            f"- runtimeReady: `{str(report['runtimeReady']).lower()}`",
            f"- coordinate adapter: `{report['coordinatePolicy']['reason']}`",
            "- A high aggregate precision does not override a failing per-piece precision gate.",
            "",
        ]
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audiveris-report", default=str(DEFAULT_AUDIVERIS_REPORT))
    parser.add_argument("--homr-report", default=str(DEFAULT_HOMR_REPORT))
    parser.add_argument("--oemer-report", default=str(DEFAULT_OEMER_REPORT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)
    report = build_report(
        read_report(Path(args.audiveris_report)),
        read_report(Path(args.homr_report)),
        read_report(Path(args.oemer_report)),
    )
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    report_path = out / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "report.md").write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({
        "report": str(report_path.relative_to(REPO)),
        "runtimeReady": report["runtimeReady"],
        "summaries": report["summaries"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
