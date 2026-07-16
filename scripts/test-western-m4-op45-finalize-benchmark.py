from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[0] / "experiments"))

from finalize_western_strings_m4_op45_same_edition_benchmark import finalize  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def score(step: str) -> str:
    return (
        "<score-partwise><part><measure number='1'>"
        f"<note><pitch><step>{step}</step><octave>4</octave></pitch>"
        "<duration>1</duration></note></measure></part></score-partwise>"
    )


with tempfile.TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    source = root / "source.png"
    candidate = root / "candidate.musicxml"
    review = root / "review.json"
    gold = root / "op45-gold.musicxml"
    provenance = root / "op45-provenance.json"
    out = root / "comparison.json"
    source.write_bytes(b"same-edition-photo")
    candidate.write_text(score("A"), encoding="utf-8")
    review.write_text(json.dumps({
        "schemaVersion": 2,
        "pieceId": "wohlfahrt-op45-no34-photo",
        "reviewer": "teacher-a",
        "reviewedAt": "2026-07-16T00:00:00Z",
        "sourceImageSha256": sha256(source),
        "candidateMusicXmlSha256": sha256(candidate),
        "checks": {"pitch": True, "rhythm": True, "header": True, "measure": True},
        "allChecksPassed": True,
    }), encoding="utf-8")

    base_gold = root / "beijing-gold.musicxml"
    base_gold.write_text(score("B"), encoding="utf-8")
    base = {
        "pieceId": "beijing",
        "benchmarkUsable": True,
        "parseOk": True,
        "humanVerifiedCleanScore": "yes",
        "goldPath": str(base_gold),
        "goldNotes": 1,
        "draftNotes": 1,
        "pitchExact": 1,
        "pitchPrecision": 1.0,
        "pitchRecall": 1.0,
        "onsetQuarterAccuracy": 1.0,
        "measureAccuracy": 1.0,
    }
    base_audiveris = root / "base-audiveris.json"
    base_oemer = root / "base-oemer.json"
    base_homr = root / "base-homr.json"
    base_audiveris.write_text(json.dumps({"rows": [{**base, "variant": "up2"}]}), encoding="utf-8")
    base_oemer.write_text(json.dumps({"rows": [base]}), encoding="utf-8")
    base_homr.write_text(json.dumps({"rows": [base]}), encoding="utf-8")

    audiveris_draft = root / "audiveris.mxl"
    oemer_draft = root / "oemer.musicxml"
    audiveris_draft.write_text(score("A"), encoding="utf-8")
    oemer_draft.write_text(score("A"), encoding="utf-8")

    report = finalize(
        review_path=review,
        source_path=source,
        candidate_path=candidate,
        gold_path=gold,
        provenance_path=provenance,
        audiveris_draft=audiveris_draft,
        oemer_draft=oemer_draft,
        homr_draft=candidate,
        base_audiveris_report=base_audiveris,
        base_oemer_report=base_oemer,
        base_homr_report=base_homr,
        out_path=out,
    )
    assert out.is_file()
    assert out.with_suffix(".md").is_file()
    assert report["goldIdentity"]["distinctGoldPageCount"] == 2
    assert report["candidate"]["observedHumanReviewedRows"] == 2
    assert report["candidate"]["observedIndependentRows"] == 1
    assert report["candidate"]["candidateEngineBiasRows"] == 1
    assert report["candidate"]["automaticAdoptionReady"] is False
    op45_rows = [row for row in report["rows"] if row.get("pieceId") == "wohlfahrt-op45-no34-photo"]
    assert len(op45_rows) == 3
    assert all(row["benchmarkUsable"] for row in op45_rows)
    assert next(row for row in op45_rows if row["engine"] == "homr")["candidateEngineBiasRisk"] is True
    assert next(row for row in op45_rows if row["engine"] == "oemer")["candidateEngineBiasRisk"] is False

print('{"ok": true, "checks": ["promotion", "frozen-three-engine-rows", "two-page-report", "candidate-bias-exclusion"]}')
