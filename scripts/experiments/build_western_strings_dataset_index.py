# -*- coding: utf-8 -*-
"""Build a unified western-strings dataset index from M0 artifacts.

Eval/data-prep only. This does not copy restricted dataset audio or MIDI into
the repository. It consolidates the existing M0 sanity/per-note files into:

- a per-piece index with audio/score/gold paths and availability flags
- a per-gold-note table used by later M1/M2 tooling
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_M0_ROOT = REPO / "data" / "experiments" / "western-strings-m0"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m1"


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise FileNotFoundError(path)
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def normalize_repo_path(value: str | None) -> str:
    text = str(value or "").strip().replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text


def repo_path_exists(repo_relative: str) -> bool:
    return bool(repo_relative) and (REPO / repo_relative).exists()


def as_int(value: str | None, default: int = 0) -> int:
    try:
        return int(float(str(value or "").strip()))
    except (TypeError, ValueError):
        return default


def as_float(value: str | None) -> float | None:
    try:
        return float(str(value or "").strip())
    except (TypeError, ValueError):
        return None


def make_piece_id(dataset: str, *parts: str) -> str:
    clean = [str(item or "").strip().replace(" ", "_").replace(":", "_") for item in parts if str(item or "").strip()]
    return f"{dataset}:{':'.join(clean)}"


def infer_bach10_paths(piece: str) -> tuple[str, str]:
    base = f"data/experiments/western-strings-m0/raw/Bach10_v1.1/{piece}/{piece}"
    return f"{base}.txt", f"{base}.txt"


def load_piece_index(m0_root: Path) -> list[dict[str, Any]]:
    pieces: list[dict[str, Any]] = []

    bach_sanity = read_csv(m0_root / "m0a-bach10" / "m0a-bach10-sanity.csv")
    for row in bach_sanity:
        piece = row.get("piece", "")
        score_path, gold_path = infer_bach10_paths(piece)
        audio_path = normalize_repo_path(row.get("audioPath"))
        pieces.append(
            {
                "dataset": "bach10",
                "pieceId": make_piece_id("bach10", piece),
                "piece": piece,
                "track": "violin",
                "instrument": "violin",
                "audioPath": audio_path,
                "scorePath": score_path,
                "goldPath": gold_path,
                "audioExists": repo_path_exists(audio_path),
                "scoreExists": repo_path_exists(score_path),
                "goldExists": repo_path_exists(gold_path),
                "goldNoteCount": as_int(row.get("violinGoldNotes")),
                "doubleStopNotes": as_int(row.get("doubleStopNotes")),
                "minScoreTime": as_float(row.get("minScoreTime")),
                "maxScoreTime": as_float(row.get("maxScoreTime")),
                "minGoldTime": as_float(row.get("minGoldTime")),
                "maxGoldTime": as_float(row.get("maxGoldTime")),
                "audioDuration": as_float(row.get("audioDuration")),
            }
        )

    urmp_sanity = read_csv(m0_root / "m0b-urmp" / "m0b-urmp-sanity.csv")
    for row in urmp_sanity:
        audio_path = normalize_repo_path(row.get("audioPath"))
        score_path = normalize_repo_path(row.get("midiPath"))
        gold_path = normalize_repo_path(row.get("notesPath"))
        pieces.append(
            {
                "dataset": "urmp",
                "pieceId": make_piece_id("urmp", row.get("piece", ""), row.get("track", "")),
                "piece": row.get("piece", ""),
                "track": row.get("track", ""),
                "instrument": row.get("instrument", ""),
                "audioPath": audio_path,
                "scorePath": score_path,
                "goldPath": gold_path,
                "audioExists": repo_path_exists(audio_path),
                "scoreExists": repo_path_exists(score_path),
                "goldExists": repo_path_exists(gold_path),
                "goldNoteCount": as_int(row.get("goldNotes")),
                "doubleStopNotes": as_int(row.get("doubleStopNotes")),
                "minScoreTime": as_float(row.get("minScoreTime")),
                "maxScoreTime": as_float(row.get("maxScoreTime")),
                "minGoldTime": as_float(row.get("minGoldTime")),
                "maxGoldTime": as_float(row.get("maxGoldTime")),
                "audioDuration": as_float(row.get("audioDuration")),
            }
        )

    musicnet_sanity = read_csv(m0_root / "m0c-musicnet" / "m0c-musicnet-sanity.csv")
    for row in musicnet_sanity:
        audio_path = normalize_repo_path(row.get("audioPath"))
        score_path = normalize_repo_path(row.get("midiPath"))
        gold_path = normalize_repo_path(row.get("labelsPath"))
        pieces.append(
            {
                "dataset": "musicnet",
                "pieceId": make_piece_id("musicnet", row.get("id", ""), row.get("instrument", "")),
                "piece": row.get("id", ""),
                "track": row.get("instrument", ""),
                "instrument": row.get("instrument", ""),
                "audioPath": audio_path,
                "scorePath": score_path,
                "goldPath": gold_path,
                "audioExists": repo_path_exists(audio_path),
                "scoreExists": repo_path_exists(score_path),
                "goldExists": repo_path_exists(gold_path),
                "goldNoteCount": as_int(row.get("goldNotes")),
                "doubleStopNotes": as_int(row.get("doubleStopNotes")),
                "minScoreTime": as_float(row.get("minScoreTime")),
                "maxScoreTime": as_float(row.get("maxScoreTime")),
                "minGoldTime": as_float(row.get("minGoldTime")),
                "maxGoldTime": as_float(row.get("maxGoldTime")),
                "audioDuration": as_float(row.get("audioDuration")),
            }
        )

    return pieces


def piece_lookup_key(dataset: str, piece: str) -> str:
    return f"{dataset}\0{piece}"


def load_gold_notes(m0_root: Path, pieces: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_dataset_piece: dict[str, dict[str, Any]] = {}
    for item in pieces:
        dataset = str(item["dataset"])
        if dataset == "urmp":
            raw_piece = f"{item['piece']}:{item['track']}"
        elif dataset == "musicnet":
            raw_piece = f"MusicNet-{item['piece']}:{item['instrument']}"
        else:
            raw_piece = str(item["piece"])
        by_dataset_piece[piece_lookup_key(dataset, raw_piece)] = item
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()

    sources = [
        ("bach10", m0_root / "m0a-bach10" / "m0a-bach10-per-note.csv"),
        ("urmp", m0_root / "m0b-urmp" / "m0b-urmp-per-note.csv"),
        ("musicnet", m0_root / "m0c-musicnet" / "m0c-musicnet-per-note.csv"),
    ]
    for dataset, path in sources:
        for row in read_csv(path):
            note_index = as_int(row.get("noteIndex"), -1)
            raw_piece = row.get("piece", "")
            piece = by_dataset_piece.get(piece_lookup_key(dataset, raw_piece))
            if piece is None:
                # MusicNet per-note uses MusicNet-2191:violin, while the sanity
                # table stores id/instrument. The lookup above accounts for it;
                # if a future source differs, fail loudly instead of fabricating.
                raise KeyError(f"missing piece index for {dataset}:{raw_piece}")
            key = (str(piece["pieceId"]), note_index)
            if key in seen:
                continue
            seen.add(key)
            rows.append(
                {
                    "dataset": dataset,
                    "pieceId": piece["pieceId"],
                    "piece": piece["piece"],
                    "track": piece["track"],
                    "instrument": piece["instrument"],
                    "noteIndex": note_index,
                    "scoreTime": as_float(row.get("scoreTime")),
                    "goldTime": as_float(row.get("goldTime")),
                    "midi": as_int(row.get("midi")),
                    "doubleStop": str(row.get("doubleStop", "")).strip().lower() == "true",
                    "legato": row.get("legato", "unknown"),
                    "audioPath": piece["audioPath"],
                    "scorePath": piece["scorePath"],
                    "goldPath": piece["goldPath"],
                }
            )

    return rows


def summarize(pieces: list[dict[str, Any]], gold_notes: list[dict[str, Any]]) -> dict[str, Any]:
    by_dataset: dict[str, dict[str, int]] = {}
    for piece in pieces:
        bucket = by_dataset.setdefault(str(piece["dataset"]), {"pieces": 0, "goldNotes": 0, "audioAvailable": 0, "scoreAvailable": 0, "goldAvailable": 0})
        bucket["pieces"] += 1
        bucket["goldNotes"] += int(piece.get("goldNoteCount") or 0)
        bucket["audioAvailable"] += 1 if piece.get("audioExists") else 0
        bucket["scoreAvailable"] += 1 if piece.get("scoreExists") else 0
        bucket["goldAvailable"] += 1 if piece.get("goldExists") else 0
    return {
        "pieceCount": len(pieces),
        "goldNoteCount": len(gold_notes),
        "datasets": by_dataset,
        "licensePolicy": "index-only; do not commit or redistribute raw dataset audio/MIDI/labels",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--m0-root", default=str(DEFAULT_M0_ROOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    m0_root = Path(args.m0_root)
    out_root = Path(args.out)
    pieces = load_piece_index(m0_root)
    gold_notes = load_gold_notes(m0_root, pieces)
    summary = summarize(pieces, gold_notes)

    out_root.mkdir(parents=True, exist_ok=True)
    (out_root / "western-strings-dataset-index.json").write_text(
        json.dumps({"summary": summary, "pieces": pieces}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_csv(
        out_root / "western-strings-dataset-index.csv",
        pieces,
        [
            "dataset",
            "pieceId",
            "piece",
            "track",
            "instrument",
            "audioPath",
            "scorePath",
            "goldPath",
            "audioExists",
            "scoreExists",
            "goldExists",
            "goldNoteCount",
            "doubleStopNotes",
            "minScoreTime",
            "maxScoreTime",
            "minGoldTime",
            "maxGoldTime",
            "audioDuration",
        ],
    )
    write_csv(
        out_root / "western-strings-gold-notes.csv",
        gold_notes,
        [
            "dataset",
            "pieceId",
            "piece",
            "track",
            "instrument",
            "noteIndex",
            "scoreTime",
            "goldTime",
            "midi",
            "doubleStop",
            "legato",
            "audioPath",
            "scorePath",
            "goldPath",
        ],
    )
    print(json.dumps({"ok": True, **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
