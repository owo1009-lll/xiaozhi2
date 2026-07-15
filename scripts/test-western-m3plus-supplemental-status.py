from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.experiments.generate_western_strings_m3plus_supplemental_scores import build
from scripts.experiments.status_western_strings_m3plus_supplemental import audit


with tempfile.TemporaryDirectory() as temporary_directory:
    source = Path(temporary_directory)
    build(source)
    report = audit(source)
    assert report["recordingCount"] == 4
    assert report["readyRecordingCount"] == 0
    assert report["missingRecordingCount"] == 4
    assert report["readyForMachineAnalysis"] is False
    assert report["humanTask"] == "record-m3plus-supplemental-takes"
    assert len([reason for reason in report["blockingReasons"] if reason.endswith(":audio-missing")]) == 4

print(json.dumps({"ok": True, "checks": ["missing-audio-fail-closed", "exact-human-task"]}))
