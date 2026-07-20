from __future__ import annotations

from eval_western_m4_reused_photo_structure_recall import SymbolNote, metrics, structure_counts


def note(midi: int, measure: int, stem: str = "up") -> SymbolNote:
    return SymbolNote(midi, float(measure - 1), 1.0, measure, stem)


def main() -> int:
    gold = [note(60, 1), note(62, 1), note(64, 2), note(65, 2, "")]
    draft = [note(60, 1), note(63, 1), note(64, 2)]
    counts = structure_counts(gold, draft, coordinate_count=3)
    result = metrics(counts)
    assert counts["associatedNoteheads"] == 3
    assert result["noteheadAssociationRecall"] == 0.75
    assert result["pitchValidatedNoteheadRecall"] == 0.5
    assert result["stemAssociationRecall"] == 1.0
    assert result["decodedBarlineBoundaryRecall"] == 1.0

    no_boundary = [note(60, 1), note(62, 1), note(64, 1)]
    counts = structure_counts(gold[:3], no_boundary, coordinate_count=3)
    assert metrics(counts)["decodedBarlineBoundaryRecall"] == 0.0
    print('{"ok":true,"checks":["alignment","stem-association","barline-boundary","coordinate-contract"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
