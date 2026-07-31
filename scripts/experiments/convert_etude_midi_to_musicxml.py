#!/usr/bin/env python3
"""Convert the exact solo MIDI of each etude into MusicXML for score import.

The MIDI came from the publisher's LilyPond source, so this is a format change,
not a transcription. The note count is asserted on both sides because the score
store and the coordinate sidecar are indexed by position: one dropped or added
note would shift every later highlight on the page.

    py -3.11 scripts/experiments/convert_etude_midi_to_musicxml.py \
        --midi-dir <dir> --coords-root <dir> --piece-prefix <id>
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def midi_note_count(path: Path) -> int:
    import mido

    total = 0
    for track in mido.MidiFile(path).tracks:
        for message in track:
            if message.type == "note_on" and message.velocity > 0:
                total += 1
    return total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--midi-dir", required=True)
    parser.add_argument("--coords-root", required=True)
    parser.add_argument("--piece-prefix", required=True)
    args = parser.parse_args()

    from music21 import chord, converter

    midi_dir = Path(args.midi_dir).resolve()
    coords_root = Path(args.coords_root).resolve()

    built: list[dict[str, object]] = []
    failed: list[dict[str, object]] = []
    for midi_path in sorted(midi_dir.glob(f"{args.piece_prefix}-no*.mid")):
        piece_id = midi_path.stem
        out_dir = coords_root / piece_id
        if not out_dir.exists():
            failed.append({"pieceId": piece_id, "reason": "coords dir missing"})
            continue
        try:
            expected = midi_note_count(midi_path)
            score = converter.parse(str(midi_path))
            out_path = out_dir / "score.musicxml"
            score.write("musicxml", fp=str(out_path))

            back = converter.parse(str(out_path))
            actual = sum(
                len(n.pitches) if isinstance(n, chord.Chord) else 1
                for n in back.flatten().notes
            )
            if actual != expected:
                failed.append({"pieceId": piece_id, "reason": f"note count {actual} != midi {expected}"})
                continue
            built.append({"pieceId": piece_id, "notes": actual})
        except Exception as error:  # noqa: BLE001
            failed.append({"pieceId": piece_id, "reason": str(error)[:160]})

    print(json.dumps({
        "ok": not failed,
        "built": len(built),
        "failed": failed,
    }, ensure_ascii=False, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
