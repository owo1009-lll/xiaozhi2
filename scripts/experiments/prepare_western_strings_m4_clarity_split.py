#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prepare a work-disjoint M4 Clarity adaptation split without blind-test leakage."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-adaptation-split"
)
BLIND_GOLD_ROOT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-real-photo-gold"
)
CANONICAL_MOVEMENT = re.compile(r"^(bwv\d+)_mov\d+\.mxl$", re.IGNORECASE)
SPLIT_BY_WORK = {
    "train": {"bwv1001", "bwv1002", "bwv1003", "bwv1004"},
    "validation": {"bwv1005"},
    "synthetic-test": {"bwv1006"},
}
EXPECTED_SPLIT_COUNTS = {"train": 21, "validation": 4, "synthetic-test": 7}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def discover_scores_root() -> Path:
    for candidate in REPO.rglob("bwv1001_mov1.mxl"):
        if candidate.parent.name.lower() == "bwv1001" and candidate.parent.parent.name == "scores":
            return candidate.parent.parent
    raise FileNotFoundError("Could not locate the Bach violin dataset scores directory.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scores-root", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--reset-output", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    scores_root = (args.scores_root or discover_scores_root()).resolve()
    output_root = args.out.resolve()
    blind_root = BLIND_GOLD_ROOT.resolve()
    if args.reset_output and output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    work_to_split = {
        work_id: split
        for split, work_ids in SPLIT_BY_WORK.items()
        for work_id in work_ids
    }
    rows: list[dict] = []
    unexpected_work_ids: set[str] = set()
    for score_path in sorted(scores_root.rglob("*.mxl")):
        match = CANONICAL_MOVEMENT.match(score_path.name)
        if not match:
            continue
        work_id = match.group(1).lower()
        split = work_to_split.get(work_id)
        if split is None:
            unexpected_work_ids.add(work_id)
            continue
        rows.append(
            {
                "sample_id": score_path.stem,
                "dataset": "m4_bach_violin_adaptation",
                "split": split,
                "work_id": work_id,
                "musicxml_path": str(score_path.resolve()),
                "sha256": sha256_file(score_path),
            }
        )

    counts = {
        split: sum(row["split"] == split for row in rows)
        for split in SPLIT_BY_WORK
    }
    work_sets = {
        split: {row["work_id"] for row in rows if row["split"] == split}
        for split in SPLIT_BY_WORK
    }
    split_pairs = [("train", "validation"), ("train", "synthetic-test"), ("validation", "synthetic-test")]
    work_overlap = {
        f"{left}:{right}": sorted(work_sets[left] & work_sets[right])
        for left, right in split_pairs
        if work_sets[left] & work_sets[right]
    }
    hashes_by_split: dict[str, set[str]] = {
        split: {row["sha256"] for row in rows if row["split"] == split}
        for split in SPLIT_BY_WORK
    }
    hash_overlap = {
        f"{left}:{right}": sorted(hashes_by_split[left] & hashes_by_split[right])
        for left, right in split_pairs
        if hashes_by_split[left] & hashes_by_split[right]
    }
    blind_manifest_path = blind_root / "independent-gold-manifest.json"
    blind_manifest = (
        json.loads(blind_manifest_path.read_text(encoding="utf-8"))
        if blind_manifest_path.exists()
        else {}
    )
    blind_path_rows = [
        row for row in rows if Path(row["musicxml_path"]).is_relative_to(blind_root)
    ]

    source_manifest = output_root / "clarity-adaptation-source-split.jsonl"
    source_manifest.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    ready = (
        len(rows) == 32
        and counts == EXPECTED_SPLIT_COUNTS
        and not unexpected_work_ids
        and not work_overlap
        and not hash_overlap
        and not blind_path_rows
        and len(blind_manifest.get("photoGold", [])) == 5
    )
    report = {
        "schemaVersion": 1,
        "purpose": "M4 Clarity supervised-adaptation split readiness",
        "evalOnly": True,
        "studentRuntimeTouched": False,
        "scoresRoot": str(scores_root),
        "canonicalMovementCount": len(rows),
        "splitCounts": counts,
        "expectedSplitCounts": EXPECTED_SPLIT_COUNTS,
        "splitWorkIds": {split: sorted(work_ids) for split, work_ids in work_sets.items()},
        "workOverlap": work_overlap,
        "hashOverlap": hash_overlap,
        "unexpectedWorkIds": sorted(unexpected_work_ids),
        "blindGoldRoot": str(blind_root),
        "blindPhotoCaseCount": len(blind_manifest.get("photoGold", [])),
        "blindHoldoutPathIncludedCount": len(blind_path_rows),
        "blindHoldoutFrozenTestOnly": not blind_path_rows,
        "adaptationSplitReady": ready,
        "artifacts": {"sourceManifest": str(source_manifest)},
    }
    report_path = output_root / "clarity-adaptation-split-readiness.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
