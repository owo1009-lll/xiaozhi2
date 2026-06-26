from __future__ import annotations

import json
import sys
import tempfile
import warnings
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))
warnings.filterwarnings("ignore", message="pkg_resources is deprecated.*")

from analyzer import ErhuAnalyzer  # noqa: E402
from analyzer_common import pretty_midi  # noqa: E402
from config import Settings  # noqa: E402
from schemas import MidiImportRequest  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def write_sample_midi(path: Path) -> None:
    require(pretty_midi is not None, "pretty_midi is required for MIDI import tests")
    midi = pretty_midi.PrettyMIDI(initial_tempo=96)
    violin = pretty_midi.Instrument(program=40, name="Violin")
    violin.notes.append(pretty_midi.Note(velocity=96, pitch=67, start=0.0, end=0.5))
    violin.notes.append(pretty_midi.Note(velocity=96, pitch=69, start=0.5, end=1.0))
    midi.instruments.append(violin)
    midi.write(str(path))


def main() -> int:
    analyzer = ErhuAnalyzer(Settings())
    with tempfile.TemporaryDirectory() as temp_dir:
        source = Path(temp_dir) / "violin.mid"
        write_sample_midi(source)
        result = analyzer.import_midi_score(
            MidiImportRequest(
                jobId="western-violin-midi-import-test",
                midiPath=str(source),
                originalFilename=source.name,
                titleHint="Western Violin MIDI Import Test",
                selectedPartHint="violin",
                instrument="violin",
                scoreSource="midi",
                tempoKnown=True,
                tempoSource="midi",
                outputDir=str(Path(temp_dir) / "out"),
            )
        )

    piece_pack = result.piecePack or {}
    notes = [note for section in piece_pack.get("sections", []) for note in (section.get("notes") or [])]
    require(result.omrStatus == "completed", f"western MIDI import should complete, got {result.omrStatus!r}: {result.error}")
    require(piece_pack.get("instrument") == "violin", f"expected instrument metadata, got {piece_pack.get('instrument')!r}")
    require(piece_pack.get("scoreSourceType") == "midi", f"expected MIDI source metadata, got {piece_pack.get('scoreSourceType')!r}")
    require(piece_pack.get("tempoKnown") is True, f"MIDI tempo should be known, got {piece_pack.get('tempoKnown')!r}")
    require(piece_pack.get("tempoSource") == "midi", f"expected MIDI tempo source, got {piece_pack.get('tempoSource')!r}")
    require([note.get("midiPitch") for note in notes] == [67, 69], f"unexpected MIDI pitches: {notes}")
    print(json.dumps({"ok": True, "selectedPart": result.selectedPart, "noteCount": len(notes)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
