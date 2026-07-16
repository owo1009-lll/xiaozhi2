#!/usr/bin/env python3
"""Promote the reviewed Op.45 candidate to a traceable same-edition gold file.

The operation is fail-closed: every review checkbox, reviewer identity, and
source/candidate hash must match before any gold artifact is written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
CANDIDATE_ROOT = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "op45-34-same-edition-gold-candidate"
)
DEFAULT_SOURCE = CANDIDATE_ROOT / "source-score.png"
DEFAULT_CANDIDATE = CANDIDATE_ROOT / "op45-34-homr-candidate.musicxml"
DEFAULT_GOLD = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "independent-real-photo-gold" / "op45-34.human-reviewed-same-edition-gold.musicxml"
)
DEFAULT_PROVENANCE = DEFAULT_GOLD.with_name("op45-34-same-edition-gold-provenance.json")
REQUIRED_CHECKS = ("pitch", "rhythm", "header", "measure")
EXPECTED_PIECE_ID = "wohlfahrt-op45-no34-photo"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def score_counts(path: Path) -> tuple[int, int]:
    root = ET.parse(path).getroot()
    measures = sum(1 for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "measure")
    pitched_notes = 0
    for note in (node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "note"):
        child_names = {child.tag.rsplit("}", 1)[-1] for child in note}
        if "pitch" in child_names and "rest" not in child_names:
            pitched_notes += 1
    if measures <= 0 or pitched_notes <= 0:
        raise ValueError("candidate MusicXML contains no usable measures or pitched notes")
    return measures, pitched_notes


def validate_review(
    review: dict[str, Any],
    *,
    source_sha256: str,
    candidate_sha256: str,
) -> None:
    if review.get("pieceId") != EXPECTED_PIECE_ID:
        raise ValueError("review pieceId does not match the Op.45 candidate")
    reviewer = str(review.get("reviewer") or "").strip()
    if not reviewer:
        raise ValueError("reviewer identity is required")
    if not str(review.get("reviewedAt") or "").strip():
        raise ValueError("reviewedAt is required")
    checks = review.get("checks")
    if not isinstance(checks, dict) or any(checks.get(key) is not True for key in REQUIRED_CHECKS):
        raise ValueError("all four review checks must be explicitly true")
    if review.get("allChecksPassed") is not True:
        raise ValueError("allChecksPassed must be true")
    if str(review.get("sourceImageSha256") or "").lower() != source_sha256.lower():
        raise ValueError("source image SHA-256 does not match the reviewed artifact")
    if str(review.get("candidateMusicXmlSha256") or "").lower() != candidate_sha256.lower():
        raise ValueError("candidate MusicXML SHA-256 does not match the reviewed artifact")


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def promote(
    *,
    review_path: Path,
    source_path: Path = DEFAULT_SOURCE,
    candidate_path: Path = DEFAULT_CANDIDATE,
    gold_path: Path = DEFAULT_GOLD,
    provenance_path: Path = DEFAULT_PROVENANCE,
) -> dict[str, Any]:
    for label, path in (("review", review_path), ("source", source_path), ("candidate", candidate_path)):
        if not path.is_file():
            raise FileNotFoundError(f"{label} file is missing: {path}")

    review = json.loads(review_path.read_text(encoding="utf-8-sig"))
    source_hash = sha256(source_path)
    candidate_hash = sha256(candidate_path)
    validate_review(review, source_sha256=source_hash, candidate_sha256=candidate_hash)
    measures, pitched_notes = score_counts(candidate_path)

    if gold_path.exists() and sha256(gold_path) != candidate_hash:
        raise FileExistsError(f"refusing to replace a different existing gold file: {gold_path}")
    gold_path.parent.mkdir(parents=True, exist_ok=True)
    if not gold_path.exists():
        temporary_gold = gold_path.with_suffix(gold_path.suffix + ".tmp")
        shutil.copy2(candidate_path, temporary_gold)
        temporary_gold.replace(gold_path)

    provenance = {
        "schemaVersion": 1,
        "pieceId": EXPECTED_PIECE_ID,
        "title": "Wohlfahrt Op.45 No.34",
        "goldPath": str(gold_path.relative_to(REPO)) if gold_path.is_relative_to(REPO) else str(gold_path),
        "goldSha256": sha256(gold_path),
        "sourceImagePath": str(source_path.relative_to(REPO)) if source_path.is_relative_to(REPO) else str(source_path),
        "sourceImageSha256": source_hash,
        "candidateMusicXmlPath": str(candidate_path.relative_to(REPO)) if candidate_path.is_relative_to(REPO) else str(candidate_path),
        "candidateMusicXmlSha256": candidate_hash,
        "reviewResultPath": str(review_path.relative_to(REPO)) if review_path.is_relative_to(REPO) else str(review_path),
        "reviewResultSha256": sha256(review_path),
        "reviewer": str(review["reviewer"]).strip(),
        "reviewedAt": review["reviewedAt"],
        "comments": str(review.get("comments") or "").strip(),
        "checks": {key: True for key in REQUIRED_CHECKS},
        "reviewStatus": "human-exhaustive-review-approved",
        "authoringMethod": "HOMR draft exhaustively compared with the same photographed edition",
        "candidateEngine": "homr-0.7.0",
        "independentFromCandidateEngine": False,
        "candidateEngineBiasRisk": True,
        "automaticAdoptionReady": False,
        "automaticAdoptionRule": "This page remains evaluation-only until all engines are rerun and the multi-page gate is recomputed.",
        "measures": measures,
        "pitchedNotes": pitched_notes,
        "promotedAt": datetime.now(timezone.utc).isoformat(),
    }
    write_json_atomic(provenance_path, provenance)
    return provenance


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", required=True, help="Downloaded review JSON from the Op.45 comparison page")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--candidate", default=str(DEFAULT_CANDIDATE))
    parser.add_argument("--gold", default=str(DEFAULT_GOLD))
    parser.add_argument("--provenance", default=str(DEFAULT_PROVENANCE))
    args = parser.parse_args(argv)
    provenance = promote(
        review_path=Path(args.review).resolve(),
        source_path=Path(args.source).resolve(),
        candidate_path=Path(args.candidate).resolve(),
        gold_path=Path(args.gold).resolve(),
        provenance_path=Path(args.provenance).resolve(),
    )
    print(json.dumps(provenance, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
