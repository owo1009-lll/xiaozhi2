from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "experiments"))

from eval_western_strings_m4_homr_benchmark import (  # noqa: E402
    build_per_piece,
    classify_homr_failure,
    compare_engines,
    find_musicxml,
    strict_thresholds,
)
from eval_western_strings_m4_oemer_benchmark import automatic_adoption_ready  # noqa: E402


with tempfile.TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    image = root / "input.jpg"
    image.write_bytes(b"image")
    assert find_musicxml(image) is None
    expected = root / "input.musicxml"
    expected.write_text("<score-partwise/>", encoding="utf-8")
    assert find_musicxml(image) == expected

    log = root / "homr.log"
    log.write_text("No staff detected", encoding="utf-8")
    assert classify_homr_failure(log, 1) == "homr-staff-detection-failed"
    log.write_text("Traceback (most recent call last)", encoding="utf-8")
    assert classify_homr_failure(log, 1) == "homr-runtime-error"

homr_rows = [
    {
        "pieceId": "a",
        "status": "ok",
        "parseOk": True,
        "benchmarkUsable": True,
        "goldSourceVerified": "yes",
        "goldNotes": 100,
        "draftNotes": 100,
        "pitchExact": 100,
        "pitchPrecision": 1.0,
        "pitchRecall": 1.0,
        "onsetQuarterAccuracy": 0.2,
        "measureAccuracy": 1.0,
    }
]
audiveris_rows = [{**homr_rows[0], "pitchExact": 90, "pitchPrecision": 0.9, "pitchRecall": 0.9}]
oemer_rows = [{**homr_rows[0], "pitchExact": 80, "pitchPrecision": 0.8, "pitchRecall": 0.8}]
comparison = compare_engines(homr_rows, audiveris_rows, oemer_rows)
assert comparison["homr"]["pitchOnlyStrictPassRows"] == 1
assert comparison["homr"]["strictPassRows"] == 0
assert comparison["homr"]["onsetQuarterAccuracy"] == 0.2
assert comparison["audiverisUp2"]["pitchPrecision"] == 0.9
assert comparison["oemer"]["pitchRecall"] == 0.8
assert build_per_piece(homr_rows, audiveris_rows, oemer_rows)[0]["pieceId"] == "a"
assert strict_thresholds() == {
    "minPitchPrecision": 0.98,
    "minPitchRecall": 0.95,
    "minOnsetQuarterAccuracy": 0.95,
    "minMeasureAccuracy": 0.95,
}
strict_homr = [{**homr_rows[0], "onsetQuarterAccuracy": 1.0}]
assert automatic_adoption_ready(compare_engines(strict_homr, [], [])["homr"], 1) is False

print(
    '{"ok": true, "checks": ["output-discovery", "failure-classification", '
    '"pitch-only-rejection", "three-engine-comparison"]}'
)
