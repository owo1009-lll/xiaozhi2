#!/usr/bin/env python3
"""Compare the local Op.45 No.34 HOMR draft with an independent public MIDI.

The public MIDI is performance-aligned MPE data, so this probe evaluates pitch
order only. It must never be presented as same-edition rhythm/measure gold or
used to open the student-facing OMR adoption gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import mido
import numpy as np

from eval_western_strings_m4_omr_benchmark import parse_notes


REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "op45-34-public-reference"
)
DEFAULT_MIDI = DEFAULT_ROOT / "Wohlfahrt_Op45-34_BernardChevalier.mid"
DEFAULT_HOMR = DEFAULT_ROOT / "input.musicxml"
DEFAULT_OUT = DEFAULT_ROOT / "op45-34-public-reference-comparison.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_mpe_note_sequence(path: Path) -> list[int]:
    """Merge MPE note-on events by absolute tick across all MIDI tracks."""

    midi = mido.MidiFile(path)
    events: list[tuple[int, int, int]] = []
    for track_index, track in enumerate(midi.tracks):
        absolute_tick = 0
        for message in track:
            absolute_tick += int(message.time)
            if message.type == "note_on" and int(message.velocity) > 0:
                events.append((absolute_tick, track_index, int(message.note)))
    events.sort(key=lambda item: (item[0], item[1]))
    return [pitch for _, _, pitch in events]


def local_pitch_alignment(
    draft: list[int],
    reference: list[int],
    *,
    match_score: int = 3,
    mismatch_penalty: int = 2,
    gap_penalty: int = 2,
) -> dict[str, Any]:
    """Smith-Waterman alignment for an independently sourced pitch sequence."""

    scores = np.zeros((len(draft) + 1, len(reference) + 1), dtype=np.int32)
    moves = np.zeros_like(scores, dtype=np.int8)
    best_score = 0
    best_i = 0
    best_j = 0
    for i in range(1, len(draft) + 1):
        for j in range(1, len(reference) + 1):
            candidates = (
                0,
                int(scores[i - 1, j - 1])
                + (match_score if draft[i - 1] == reference[j - 1] else -mismatch_penalty),
                int(scores[i - 1, j]) - gap_penalty,
                int(scores[i, j - 1]) - gap_penalty,
            )
            move = int(np.argmax(candidates))
            scores[i, j] = candidates[move]
            moves[i, j] = move
            if int(scores[i, j]) > best_score:
                best_score = int(scores[i, j])
                best_i = i
                best_j = j

    i = best_i
    j = best_j
    pairs: list[tuple[int | None, int | None, bool]] = []
    while i > 0 and j > 0 and int(scores[i, j]) > 0:
        move = int(moves[i, j])
        if move == 1:
            pairs.append((i - 1, j - 1, draft[i - 1] == reference[j - 1]))
            i -= 1
            j -= 1
        elif move == 2:
            pairs.append((i - 1, None, False))
            i -= 1
        elif move == 3:
            pairs.append((None, j - 1, False))
            j -= 1
        else:
            break
    pairs.reverse()

    draft_indexes = [draft_index for draft_index, _, _ in pairs if draft_index is not None]
    reference_indexes = [
        reference_index for _, reference_index, _ in pairs if reference_index is not None
    ]
    exact = sum(
        1
        for draft_index, reference_index, is_exact in pairs
        if draft_index is not None and reference_index is not None and is_exact
    )
    substitutions = sum(
        1
        for draft_index, reference_index, is_exact in pairs
        if draft_index is not None and reference_index is not None and not is_exact
    )
    draft_gaps = sum(1 for draft_index, _, _ in pairs if draft_index is None)
    reference_gaps = sum(1 for _, reference_index, _ in pairs if reference_index is None)
    return {
        "score": best_score,
        "draftSpan": [min(draft_indexes), max(draft_indexes)] if draft_indexes else None,
        "referenceSpan": (
            [min(reference_indexes), max(reference_indexes)] if reference_indexes else None
        ),
        "exactMatches": exact,
        "substitutions": substitutions,
        "draftGaps": draft_gaps,
        "referenceGaps": reference_gaps,
        "alignedDraftCoverage": exact / len(draft) if draft else 0.0,
        "alignedReferenceCoverage": exact / len(reference) if reference else 0.0,
        "alignedExactRate": exact / max(1, exact + substitutions + draft_gaps + reference_gaps),
    }


def build_report(homr_path: Path, midi_path: Path) -> dict[str, Any]:
    draft = [note.midi for note in parse_notes(homr_path)]
    reference = read_mpe_note_sequence(midi_path)
    alignment = local_pitch_alignment(draft, reference)
    strict_exact_run = bool(
        alignment["exactMatches"] >= 100
        and alignment["substitutions"] == 0
        and alignment["draftGaps"] == 0
        and alignment["referenceGaps"] == 0
    )
    return {
        "schemaVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "purpose": "independent-public-pitch-order-corroboration",
        "evalOnly": True,
        "studentFacing": False,
        "inputs": {
            "homrMusicXml": str(homr_path),
            "homrSha256": sha256(homr_path),
            "publicPerformanceMidi": str(midi_path),
            "publicPerformanceMidiSha256": sha256(midi_path),
        },
        "counts": {
            "homrNotes": len(draft),
            "publicMidiNotes": len(reference),
        },
        "pitchOrderAlignment": alignment,
        "interpretation": {
            "strictExactRunObserved": strict_exact_run,
            "editionSpecificDraftPrefixNotes": (
                alignment["draftSpan"][0] if alignment["draftSpan"] else None
            ),
            "claim": (
                "The HOMR draft contains a long exact pitch-order run from the independent "
                "public reference after an edition-specific photographed-score prefix."
                if strict_exact_run
                else "No sufficiently long exact independent pitch-order run was observed."
            ),
        },
        "gate": {
            "sameEditionHumanGold": False,
            "rhythmEvaluated": False,
            "measureStructureEvaluated": False,
            "automaticAdoptionReady": False,
            "reason": "public-performance-midi-is-pitch-order-corroboration-only",
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--homr", default=str(DEFAULT_HOMR))
    parser.add_argument("--midi", default=str(DEFAULT_MIDI))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    homr_path = Path(args.homr).resolve()
    midi_path = Path(args.midi).resolve()
    out_path = Path(args.out).resolve()
    if not homr_path.is_file():
        raise SystemExit(f"HOMR MusicXML not found: {homr_path}")
    if not midi_path.is_file():
        raise SystemExit(f"public MIDI not found: {midi_path}")
    report = build_report(homr_path, midi_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
