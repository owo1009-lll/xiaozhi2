from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "experiments"))

from summarize_western_strings_m4_same_edition_benchmark import build_report  # noqa: E402


with tempfile.TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    gold = root / "gold.musicxml"
    gold.write_text("<score-partwise/>", encoding="utf-8")
    base = {
        "benchmarkUsable": True,
        "parseOk": True,
        "humanVerifiedCleanScore": "yes",
        "goldPath": str(gold),
        "goldNotes": 100,
        "draftNotes": 100,
        "pitchExact": 100,
        "pitchPrecision": 1.0,
        "pitchRecall": 1.0,
        "onsetQuarterAccuracy": 1.0,
        "measureAccuracy": 1.0,
    }
    report = build_report({
        "audiveris-up2": [{**base, "pitchExact": 80, "pitchPrecision": 0.8, "pitchRecall": 0.8}],
        "oemer": [{**base, "pitchExact": 70, "pitchPrecision": 0.7, "pitchRecall": 0.7}],
        "homr": [base],
    })
    assert report["goldIdentity"]["sameGoldVerified"] is True
    assert report["candidate"]["engine"] == "homr"
    assert report["candidate"]["observedIndependentRows"] == 1
    assert report["candidate"]["observedIndependentCameraPhotoRows"] == 0
    assert report["candidate"]["observedHumanReviewedRows"] == 1
    assert report["candidate"]["candidateEngineBiasRows"] == 0
    assert report["candidate"]["sampleSizeReady"] is False
    assert report["candidate"]["automaticAdoptionReady"] is False
    assert report["candidate"]["cameraPhotoAutomaticAdoptionReady"] is False
    assert report["engines"]["audiveris-up2"]["pitchMissRate"] == 0.2

    gold_two = root / "gold-two.musicxml"
    gold_two.write_text("<score-partwise><part/></score-partwise>", encoding="utf-8")
    second = {**base, "pieceId": "second-page", "goldPath": str(gold_two), "goldNotes": 50, "draftNotes": 50, "pitchExact": 50}
    first = {**base, "pieceId": "first-page"}
    two_page_report = build_report({
        "audiveris-up2": [{**first, "pitchPrecision": 0.8, "pitchRecall": 0.8}, {**second, "pitchPrecision": 0.8, "pitchRecall": 0.8}],
        "oemer": [{**first, "pitchPrecision": 0.7, "pitchRecall": 0.7}, {**second, "pitchPrecision": 0.7, "pitchRecall": 0.7}],
        "homr": [first, second],
    })
    assert two_page_report["goldIdentity"]["distinctGoldPageCount"] == 2
    assert len(two_page_report["goldIdentity"]["goldSha256s"]) == 2
    assert two_page_report["candidate"]["observedIndependentRows"] == 2
    assert two_page_report["candidate"]["observedHumanReviewedRows"] == 2
    assert two_page_report["candidate"]["observedStrictPass"] is True
    assert two_page_report["candidate"]["automaticAdoptionReady"] is False

    photo_rows = [
        {
            **base,
            "pieceId": f"photo-{index}",
            "goldPath": str(root / f"photo-{index}.musicxml"),
            "inputDomain": "camera-photo",
            "cameraPhotoDomainEligible": "yes",
        }
        for index in range(5)
    ]
    for row in photo_rows:
        Path(row["goldPath"]).write_text(
            f"<score-partwise><credit>{row['pieceId']}</credit></score-partwise>",
            encoding="utf-8",
        )
    photo_report = build_report({
        "audiveris-up2": photo_rows,
        "oemer": photo_rows,
        "homr": photo_rows,
    })
    assert photo_report["candidate"]["observedIndependentCameraPhotoRows"] == 5
    assert photo_report["candidate"]["cameraPhotoSampleSizeReady"] is True
    assert photo_report["candidate"]["cameraPhotoAutomaticAdoptionReady"] is True

    biased_second = {**second, "candidateEngineBiasRisk": True}
    biased_report = build_report({
        "audiveris-up2": [first, second],
        "oemer": [first, second],
        "homr": [first, biased_second],
    })
    assert biased_report["goldIdentity"]["distinctGoldPageCount"] == 2
    assert biased_report["candidate"]["observedHumanReviewedRows"] == 2
    assert biased_report["candidate"]["observedIndependentRows"] == 1
    assert biased_report["candidate"]["candidateEngineBiasRows"] == 1
    assert biased_report["candidate"]["reason"] == "candidate-engine-derived-gold-excluded-from-independent-gate"
    assert biased_report["candidate"]["automaticAdoptionReady"] is False

    mismatched_gold = root / "wrong-gold.musicxml"
    mismatched_gold.write_text("<score-partwise><credit/></score-partwise>", encoding="utf-8")
    try:
        build_report({
            "audiveris-up2": [first, second],
            "oemer": [first, second],
            "homr": [first, {**second, "goldPath": str(mismatched_gold)}],
        })
    except ValueError as error:
        assert "same set of gold MusicXML" in str(error)
    else:
        raise AssertionError("a mismatched engine gold set must be rejected")

print('{"ok": true, "checks": ["same-gold-identity", "multi-page-count", "mismatched-set-rejected", "strict-positive-small-sample-rejected"]}')
