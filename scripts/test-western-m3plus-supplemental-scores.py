from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.experiments.generate_western_strings_m3plus_supplemental_scores import build


with tempfile.TemporaryDirectory() as temporary_directory:
    out = Path(temporary_directory)
    report = build(out)
    assert report["performanceGoldReady"] is False
    assert report["recordingCount"] == 4
    by_id = {row["recordingId"]: row for row in report["recordings"]}
    assert len(by_id["m3p-01"]["labels"]) == 8
    assert all(not row["expectedPositiveModes"] for row in by_id["m3p-01"]["labels"])
    assert sum("vibrato" in row["expectedPositiveModes"] for row in by_id["m3p-02"]["labels"]) == 8
    assert sum("trill" in row["expectedPositiveModes"] for row in by_id["m3p-02"]["labels"]) == 8
    assert sum("ornament" in row["expectedPositiveModes"] for row in by_id["m3p-03"]["labels"]) == 8
    assert sum(not row["expectedPositiveModes"] for row in by_id["m3p-03"]["labels"]) == 8
    assert sum("slide" in row["expectedPositiveModes"] for row in by_id["m3p-04"]["labels"]) == 16
    assert sum(not row["expectedPositiveModes"] for row in by_id["m3p-04"]["labels"]) == 8
    assert all(
        "harmonic" not in row["expectedPositiveModes"] + row["expectedNegativeModes"]
        for recording in report["recordings"]
        for row in recording["labels"]
    )
    readme = (out / "README-录音说明.md").read_text(encoding="utf-8")
    assert "不需要看谱" in readme
    assert "自然泛音音准检测已取消" in readme
    assert all((out / f"m3p-0{index}.musicxml").exists() for index in range(1, 5))
    assert all((out / f"m3p-0{index}.mid").exists() for index in range(1, 5))
    assert (out / "README-录音说明.md").exists()

print(json.dumps({"ok": True, "checks": ["four-fixed-sequences", "score-intent", "no-harmonic-mode", "recording-readme"]}))
