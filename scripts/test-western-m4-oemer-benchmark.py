from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "experiments"))

from eval_western_strings_m4_oemer_benchmark import (  # noqa: E402
    THREAD_ENV,
    aggregate_metrics,
    automatic_adoption_ready,
    build_oemer_env,
    classify_oemer_failure,
    compare_engines,
    find_musicxml,
)


with tempfile.TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    assert find_musicxml(root) is None
    only = root / "score.musicxml"
    only.write_text("<score-partwise/>", encoding="utf-8")
    assert find_musicxml(root) == only
    (root / "second.musicxml").write_text("<score-partwise/>", encoding="utf-8")
    assert find_musicxml(root) is None

    log = root / "oemer.log"
    log.write_text("assert track_nums == 2, track_nums\nAssertionError: 3\n", encoding="utf-8")
    assert classify_oemer_failure(log) == "oemer-build-track-count-assertion"

    compat = root / "compat"
    compat.mkdir()
    env = build_oemer_env({"PYTHONPATH": "existing"}, compat)
    assert env["PYTHONPATH"] == str(compat) + os.pathsep + "existing"
    assert all(env[key] == value for key, value in THREAD_ENV.items())

oemer_rows = [
    {
        "pieceId": "a",
        "parseOk": True,
        "benchmarkUsable": True,
        "goldNotes": 100,
        "draftNotes": 100,
        "pitchExact": 99,
        "pitchPrecision": 0.99,
        "pitchRecall": 0.99,
        "onsetQuarterAccuracy": 0.99,
        "measureAccuracy": 0.99,
        "goldSourceVerified": "yes",
    },
    {
        "pieceId": "b",
        "parseOk": True,
        "benchmarkUsable": True,
        "goldNotes": 100,
        "draftNotes": 125,
        "pitchExact": 80,
        "pitchPrecision": 0.64,
        "pitchRecall": 0.8,
        "onsetQuarterAccuracy": 0.99,
        "measureAccuracy": 0.99,
        "goldSourceVerified": "yes",
    },
]
audiveris_rows = [
    {
        "pieceId": "a",
        "parseOk": True,
        "benchmarkUsable": True,
        "goldNotes": 100,
        "draftNotes": 100,
        "pitchExact": 90,
        "pitchPrecision": 0.9,
        "pitchRecall": 0.9,
        "onsetQuarterAccuracy": 0.9,
        "measureAccuracy": 0.9,
        "goldSourceVerified": "yes",
    }
]
summary = aggregate_metrics(oemer_rows)
assert summary["pitchPrecision"] == round(179 / 225, 6)
assert summary["pitchRecall"] == 0.895
assert summary["strictPassRows"] == 1
assert summary["engineFailureRows"] == 0
assert summary["pitchRecallIncludingEngineFailures"] == 0.895
assert summary["onsetQuarterAccuracy"] == 0.99
assert summary["measureAccuracy"] == 0.99
assert summary["pitchOnlyStrictPassRows"] == 1
assert summary["strictPassPieceIds"] == ["a"]
comparison = compare_engines(oemer_rows, audiveris_rows)
assert comparison["perPiece"] == [
    {
        "pieceId": "a",
        "oemerStatus": None,
        "oemerPrecision": 0.99,
        "oemerRecall": 0.99,
        "audiverisPrecision": 0.9,
        "audiverisRecall": 0.9,
        "precisionDelta": 0.09,
        "recallDelta": 0.09,
    }
]
assert comparison["oemer"]["strictPassRows"] == 1
assert comparison["pairedSubset"]["pieceIds"] == ["a"]
assert automatic_adoption_ready(aggregate_metrics([]), 0) is False
assert automatic_adoption_ready(summary, 2) is False
assert automatic_adoption_ready(aggregate_metrics([oemer_rows[0]]), 1) is True
pitch_only = [{**oemer_rows[0], "onsetQuarterAccuracy": 0.2}]
assert aggregate_metrics(pitch_only)["pitchOnlyStrictPassRows"] == 1
assert aggregate_metrics(pitch_only)["strictPassRows"] == 0
assert automatic_adoption_ready(aggregate_metrics(pitch_only), 1) is False

print('{"ok": true, "checks": ["output-discovery", "failure-classification", "thread-env", "strict-gate", "engine-comparison"]}')
