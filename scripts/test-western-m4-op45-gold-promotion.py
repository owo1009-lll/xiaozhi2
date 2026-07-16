from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[0] / "experiments"))

from promote_western_strings_m4_op45_same_edition_gold import promote  # noqa: E402


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expect_failure(fragment: str, callback) -> None:
    try:
        callback()
    except (ValueError, FileExistsError) as error:
        assert fragment in str(error), (fragment, error)
    else:
        raise AssertionError(f"expected failure containing {fragment!r}")


with tempfile.TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    source = root / "source.png"
    candidate = root / "candidate.musicxml"
    review_path = root / "review.json"
    gold = root / "gold.musicxml"
    provenance = root / "provenance.json"
    source.write_bytes(b"same-edition-photo")
    candidate.write_text(
        "<score-partwise><part><measure number='1'><note><pitch><step>A</step><octave>4</octave></pitch></note></measure></part></score-partwise>",
        encoding="utf-8",
    )

    valid = {
        "schemaVersion": 2,
        "pieceId": "wohlfahrt-op45-no34-photo",
        "reviewer": "teacher-a",
        "reviewedAt": "2026-07-16T00:00:00Z",
        "sourceImageSha256": file_hash(source),
        "candidateMusicXmlSha256": file_hash(candidate),
        "checks": {"pitch": True, "rhythm": True, "header": True, "measure": True},
        "allChecksPassed": True,
    }

    missing_reviewer = {**valid, "reviewer": ""}
    review_path.write_text(json.dumps(missing_reviewer), encoding="utf-8")
    expect_failure("reviewer identity", lambda: promote(
        review_path=review_path, source_path=source, candidate_path=candidate,
        gold_path=gold, provenance_path=provenance,
    ))

    failed_check = {**valid, "checks": {**valid["checks"], "rhythm": False}}
    review_path.write_text(json.dumps(failed_check), encoding="utf-8")
    expect_failure("all four review checks", lambda: promote(
        review_path=review_path, source_path=source, candidate_path=candidate,
        gold_path=gold, provenance_path=provenance,
    ))

    wrong_hash = {**valid, "candidateMusicXmlSha256": "0" * 64}
    review_path.write_text(json.dumps(wrong_hash), encoding="utf-8")
    expect_failure("candidate MusicXML SHA-256", lambda: promote(
        review_path=review_path, source_path=source, candidate_path=candidate,
        gold_path=gold, provenance_path=provenance,
    ))

    review_path.write_text(json.dumps(valid), encoding="utf-8")
    result = promote(
        review_path=review_path, source_path=source, candidate_path=candidate,
        gold_path=gold, provenance_path=provenance,
    )
    assert gold.read_bytes() == candidate.read_bytes()
    assert result["reviewer"] == "teacher-a"
    assert result["measures"] == 1
    assert result["pitchedNotes"] == 1
    assert result["automaticAdoptionReady"] is False
    assert result["independentFromCandidateEngine"] is False
    assert json.loads(provenance.read_text(encoding="utf-8"))["goldSha256"] == file_hash(gold)

print('{"ok": true, "checks": ["reviewer", "all-checks", "hashes", "atomic-promotion"]}')
