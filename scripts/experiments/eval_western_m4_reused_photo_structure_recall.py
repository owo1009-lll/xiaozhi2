#!/usr/bin/env python3
"""One-shot symbolic structure recall audit on the reused five-photo M4 set.

The set has independent MusicXML truth but no same-edition pixel masks.  This
audit therefore measures decoded symbol associations and explicitly leaves
pixel segmentation recall unevaluable.  It never runs OMR inference and it
refuses to overwrite its report, so the diagnostic set cannot become a tuning
loop by accident.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_strings_m4_omr_benchmark import (  # noqa: E402
    Note,
    align_notes,
    child,
    child_text,
    local_name,
    pitch_to_midi,
    read_score_xml,
)


REPO = Path(__file__).resolve().parents[2]
BENCHMARK = (
    REPO
    / "data/experiments/western-strings-m4/oemer-source-benchmark/oemer-source-benchmark.json"
)
OUTPUT = (
    REPO
    / "data/experiments/western-strings-m4/reused-photo-structure-recall/report.json"
)
PIECE_IDS = (
    "violin-ex05",
    "violin-ex08",
    "violin-ex09",
    "violin-ex10",
    "violin-ex12",
)


@dataclass(frozen=True)
class SymbolNote:
    midi: int
    onset_quarters: float
    duration_quarters: float
    measure_index: int
    stem: str

    def alignment_note(self) -> Note:
        return Note(self.midi, self.onset_quarters, self.duration_quarters, self.measure_index)


def portable(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def parse_symbol_notes(path: Path) -> list[SymbolNote]:
    root = ET.fromstring(read_score_xml(path))
    parsed_parts: list[list[SymbolNote]] = []
    for part in [row for row in root.iter() if local_name(str(row.tag)) == "part"]:
        notes: list[SymbolNote] = []
        divisions = 1.0
        piece_cursor = 0.0
        for measure_index, measure in enumerate(
            [row for row in list(part) if local_name(str(row.tag)) == "measure"], start=1
        ):
            measure_cursor = 0.0
            measure_max = 0.0
            previous_onset = 0.0
            for item in list(measure):
                name = local_name(str(item.tag))
                if name == "attributes":
                    value = child_text(item, "divisions")
                    if value:
                        try:
                            divisions = max(float(value), 1.0)
                        except ValueError:
                            pass
                    continue
                duration_text = child_text(item, "duration")
                try:
                    duration = float(duration_text) / divisions if duration_text else 0.0
                except ValueError:
                    duration = 0.0
                if name == "backup":
                    measure_cursor = max(0.0, measure_cursor - duration)
                elif name == "forward":
                    measure_cursor += duration
                    measure_max = max(measure_max, measure_cursor)
                elif name == "note":
                    is_chord = child(item, "chord") is not None
                    onset = previous_onset if is_chord else measure_cursor
                    midi = pitch_to_midi(item)
                    if midi is not None and child(item, "rest") is None:
                        notes.append(
                            SymbolNote(
                                midi=midi,
                                onset_quarters=piece_cursor + onset,
                                duration_quarters=duration,
                                measure_index=measure_index,
                                stem=child_text(item, "stem").lower(),
                            )
                        )
                    previous_onset = onset
                    if not is_chord:
                        measure_cursor += duration
                        measure_max = max(measure_max, measure_cursor)
            piece_cursor += measure_max
        parsed_parts.append(notes)
    if not parsed_parts:
        raise ValueError(f"no-part:{path}")
    return max(parsed_parts, key=len)


def structure_counts(
    gold: list[SymbolNote],
    draft: list[SymbolNote],
    coordinate_count: int,
) -> dict[str, int]:
    if coordinate_count != len(draft):
        raise ValueError(f"coordinate-note-count-mismatch:{coordinate_count}!={len(draft)}")
    pairs = align_notes(
        [row.alignment_note() for row in gold],
        [row.alignment_note() for row in draft],
    )
    gold_to_draft = {
        gold_index: draft_index
        for gold_index, draft_index in pairs
        if gold_index is not None and draft_index is not None
    }
    paired = len(gold_to_draft)
    pitch_validated = sum(
        gold[gold_index].midi == draft[draft_index].midi
        for gold_index, draft_index in gold_to_draft.items()
    )
    stem_gold = [index for index, row in enumerate(gold) if row.stem in {"up", "down"}]
    stem_associated = sum(
        index in gold_to_draft and draft[gold_to_draft[index]].stem in {"up", "down"}
        for index in stem_gold
    )
    stem_direction = sum(
        index in gold_to_draft and draft[gold_to_draft[index]].stem == gold[index].stem
        for index in stem_gold
    )
    boundary_gold = [
        index
        for index in range(len(gold) - 1)
        if gold[index].measure_index != gold[index + 1].measure_index
    ]
    boundary_recalled = 0
    boundary_single_step = 0
    for index in boundary_gold:
        left = gold_to_draft.get(index)
        right = gold_to_draft.get(index + 1)
        if left is None or right is None or right <= left:
            continue
        delta = draft[right].measure_index - draft[left].measure_index
        boundary_recalled += int(delta > 0)
        boundary_single_step += int(delta == 1)
    return {
        "goldNoteheads": len(gold),
        "draftNoteheads": len(draft),
        "coordinateNoteheads": coordinate_count,
        "associatedNoteheads": paired,
        "pitchValidatedNoteheads": pitch_validated,
        "goldStemNotes": len(stem_gold),
        "associatedStemNotes": stem_associated,
        "directionCorrectStemNotes": stem_direction,
        "goldInternalBarlineBoundaries": len(boundary_gold),
        "recalledInternalBarlineBoundaries": boundary_recalled,
        "singleStepInternalBarlineBoundaries": boundary_single_step,
    }


def metrics(counts: dict[str, int]) -> dict[str, float | None]:
    return {
        "noteheadAssociationRecall": safe_rate(
            counts["associatedNoteheads"], counts["goldNoteheads"]
        ),
        "pitchValidatedNoteheadRecall": safe_rate(
            counts["pitchValidatedNoteheads"], counts["goldNoteheads"]
        ),
        "stemAssociationRecall": safe_rate(
            counts["associatedStemNotes"], counts["goldStemNotes"]
        ),
        "stemDirectionRecall": safe_rate(
            counts["directionCorrectStemNotes"], counts["goldStemNotes"]
        ),
        "decodedBarlineBoundaryRecall": safe_rate(
            counts["recalledInternalBarlineBoundaries"],
            counts["goldInternalBarlineBoundaries"],
        ),
        "singleStepBarlineBoundaryRecall": safe_rate(
            counts["singleStepInternalBarlineBoundaries"],
            counts["goldInternalBarlineBoundaries"],
        ),
    }


def add_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    keys = list(rows[0]["counts"]) if rows else []
    return {key: sum(int(row["counts"][key]) for row in rows) for key in keys}


def historical_baseline() -> dict[str, Any]:
    paths = []
    for path in (REPO / "data/experiments/western-strings-m4").rglob("*.json"):
        if path.resolve() == OUTPUT.resolve():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if all(piece_id in text for piece_id in PIECE_IDS):
            paths.append(portable(path))
    return {
        "knownArtifactMentionCountBeforeFormalLedger": len(paths),
        "knownArtifactPaths": sorted(paths),
        "interpretation": (
            "Conservative repository-artifact inventory only; it is not an exact historical "
            "raw-image access or inference count because the set predates the formal ledger."
        ),
    }


def build_report() -> dict[str, Any]:
    benchmark = json.loads(BENCHMARK.read_text(encoding="utf-8"))
    rows_by_piece = {row["pieceId"]: row for row in benchmark["rows"]}
    rows = []
    for piece_id in PIECE_IDS:
        source = rows_by_piece[piece_id]
        gold_path = REPO / source["goldPath"]
        draft_path = REPO / source["draftPath"]
        coordinate_path = REPO / source["coordinateSidecarPath"]
        sidecar = json.loads(coordinate_path.read_text(encoding="utf-8"))
        counts = structure_counts(
            parse_symbol_notes(gold_path),
            parse_symbol_notes(draft_path),
            int(sidecar["coordinateNoteCount"]),
        )
        rows.append(
            {
                "pieceId": piece_id,
                "goldPath": portable(gold_path),
                "goldSha256": sha256(gold_path),
                "draftPath": portable(draft_path),
                "draftSha256": sha256(draft_path),
                "coordinateSidecarPath": portable(coordinate_path),
                "coordinateSidecarSha256": sha256(coordinate_path),
                "counts": counts,
                "metrics": metrics(counts),
            }
        )
    aggregate_counts = add_counts(rows)
    return {
        "contract": "western-m4-reused-photo-structure-recall-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evidenceRole": "one-shot-reused-five-photo-symbolic-structure-diagnostic",
        "sourceBenchmark": portable(BENCHMARK),
        "sourceBenchmarkSha256": sha256(BENCHMARK),
        "diagnosticUseLedger": {
            "formalLedgerUseCount": 1,
            "uses": [
                {
                    "useNumber": 1,
                    "purpose": "M4 decoder handoff: one-shot notehead/stem/barline structure recall diagnosis",
                    "pieceCount": len(PIECE_IDS),
                    "inferenceRun": False,
                    "reusedFrozenOutputsOnly": True,
                }
            ],
            "historicalBaseline": historical_baseline(),
        },
        "method": {
            "gold": "independent source-derived MusicXML, human identity/range approved",
            "prediction": "frozen Oemer 0.1.8 MusicXML plus its coordinate sidecar; no inference rerun",
            "alignment": "same pitch-sequence Levenshtein alignment as the frozen M4 benchmark",
            "noteheadAssociationRecall": "aligned gold notes with an emitted coordinate-bearing draft note / gold pitched notes",
            "stemAssociationRecall": "aligned gold notes carrying an explicit gold stem with an explicit draft stem / explicit gold stems",
            "decodedBarlineBoundaryRecall": "internal gold note-to-note measure transitions whose aligned draft notes cross a draft measure boundary / internal gold transitions",
        },
        "aggregate": {"pieceCount": len(rows), "counts": aggregate_counts, "metrics": metrics(aggregate_counts)},
        "pixelSegmentationRecall": {
            "notehead": None,
            "stem": None,
            "barline": None,
            "evaluable": False,
            "reason": "no independent same-edition pixel/coordinate mask gold; independent source engraving has different layout",
        },
        "limitations": [
            "Association recall is a symbolic upper-bound proxy, not pixel segmentation recall or precision.",
            "A substituted pitch can still count as a notehead association because this audit isolates structural survival.",
            "Stem XML output proves decoder association, not that every stem pixel was correctly segmented.",
            "Barline recall measures decoded internal boundaries; it does not localize barline pixels.",
            "These five repeatedly viewed pages are diagnostic-only and permanently ineligible for fresh-blind promotion or tuning.",
        ],
        "freshBlindEligible": False,
        "tuningAuthorized": False,
        "studentGateReady": False,
        "automaticAdoptionAuthorized": False,
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        raise SystemExit(f"refusing-one-shot-rerun-existing-report:{output}")
    report = build_report()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": portable(output), "aggregate": report["aggregate"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
