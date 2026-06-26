from __future__ import annotations

import csv
import importlib.util
import json
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "experiments" / "build_western_strings_dataset_index.py"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_module():
    spec = importlib.util.spec_from_file_location("western_dataset_index", MODULE_PATH)
    require(spec is not None and spec.loader is not None, "could not load dataset index module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def build_fixture(root: Path) -> None:
    write_csv(
        root / "m0a-bach10" / "m0a-bach10-sanity.csv",
        [
            {
                "piece": "bach-piece",
                "audioPath": "data/experiments/western-strings-m0/raw/Bach10_v1.1/bach-piece/bach-piece-violin.wav",
                "audioDuration": 10,
                "violinGoldNotes": 2,
                "doubleStopNotes": 0,
                "minScoreTime": 0,
                "maxScoreTime": 1,
                "minGoldTime": 0,
                "maxGoldTime": 1,
            }
        ],
    )
    write_csv(
        root / "m0a-bach10" / "m0a-bach10-per-note.csv",
        [
            {"piece": "bach-piece", "noteIndex": 0, "method": "linear", "scoreTime": 0.0, "goldTime": 0.1, "predTime": 0.1, "absError": 0, "midi": 67, "doubleStop": "False", "legato": "unknown"},
            {"piece": "bach-piece", "noteIndex": 0, "method": "crepe", "scoreTime": 0.0, "goldTime": 0.1, "predTime": 0.2, "absError": 0.1, "midi": 67, "doubleStop": "False", "legato": "unknown"},
            {"piece": "bach-piece", "noteIndex": 1, "method": "linear", "scoreTime": 1.0, "goldTime": 1.1, "predTime": 1.1, "absError": 0, "midi": 69, "doubleStop": "False", "legato": "unknown"},
        ],
    )

    write_csv(
        root / "m0b-urmp" / "m0b-urmp-sanity.csv",
        [
            {
                "piece": "urmp-piece",
                "track": "vn",
                "instrument": "violin",
                "audioPath": "data/experiments/western-strings-m0/raw/URMP/au.wav",
                "midiPath": "data/experiments/western-strings-m0/raw/URMP/score.mid",
                "notesPath": "data/experiments/western-strings-m0/raw/URMP/notes.txt",
                "goldNotes": 1,
                "doubleStopNotes": 0,
                "minScoreTime": 0,
                "maxScoreTime": 0,
                "minGoldTime": 2,
                "maxGoldTime": 2,
                "audioDuration": 5,
            }
        ],
    )
    write_csv(
        root / "m0b-urmp" / "m0b-urmp-per-note.csv",
        [
            {"piece": "urmp-piece:vn", "noteIndex": 0, "method": "linear", "scoreTime": 0.0, "goldTime": 2.0, "predTime": 2.0, "absError": 0, "midi": 71, "doubleStop": "False", "legato": "unknown"}
        ],
    )

    write_csv(
        root / "m0c-musicnet" / "m0c-musicnet-sanity.csv",
        [
            {
                "id": "2191",
                "instrument": "violin",
                "ensemble": "Solo Violin",
                "audioPath": "data/experiments/western-strings-m0/raw/MusicNet/2191.wav",
                "midiPath": "data/experiments/western-strings-m0/raw/MusicNet/2191.mid",
                "labelsPath": "data/experiments/western-strings-m0/raw/MusicNet/2191.csv",
                "goldNotes": 1,
                "doubleStopNotes": 1,
                "audioDuration": 8,
                "minScoreTime": 0,
                "maxScoreTime": 0,
                "minGoldTime": 3,
                "maxGoldTime": 3,
            }
        ],
    )
    write_csv(
        root / "m0c-musicnet" / "m0c-musicnet-per-note.csv",
        [
            {"piece": "MusicNet-2191:violin", "noteIndex": 0, "method": "linear", "scoreTime": 0.0, "goldTime": 3.0, "predTime": 3.0, "absError": 0, "midi": 72, "doubleStop": "True", "legato": "unknown"}
        ],
    )


def main() -> int:
    module = load_module()
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir) / "m0"
        build_fixture(root)
        pieces = module.load_piece_index(root)
        gold_notes = module.load_gold_notes(root, pieces)
        summary = module.summarize(pieces, gold_notes)

    require(len(pieces) == 3, f"expected 3 indexed pieces, got {len(pieces)}")
    require(len(gold_notes) == 4, f"expected duplicate per-method notes to be deduplicated, got {len(gold_notes)}")
    require(any(row["pieceId"] == "urmp:urmp-piece:vn" for row in gold_notes), "URMP piece:track mapping should resolve")
    require(any(row["pieceId"] == "musicnet:2191:violin" and row["doubleStop"] is True for row in gold_notes), "MusicNet mapping should preserve double-stop label")
    require(summary["datasets"]["bach10"]["goldNotes"] == 2, "Bach10 gold count should come from sanity table")
    print(json.dumps({"ok": True, "pieces": len(pieces), "goldNotes": len(gold_notes)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
