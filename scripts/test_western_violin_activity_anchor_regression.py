from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_violin_activity_anchor_regression.py"
SPEC = importlib.util.spec_from_file_location("activity_anchor_regression", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class ViolinActivityAnchorRegressionTest(unittest.TestCase):
    def test_basic_pitch_event_uses_first_violin_range_event(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "events.json"
            path.write_text(json.dumps([
                {"start": 0.1, "midi": 40, "confidence": 0.9},
                {"start": 0.8, "midi": 69, "confidence": 0.7},
                {"start": 1.0, "midi": 72, "confidence": 0.8},
            ]), encoding="utf-8")
            event = MODULE.first_basic_pitch_violin_event(path)
        self.assertEqual(event["start"], 0.8)
        self.assertEqual(event["midi"], 69.0)


if __name__ == "__main__":
    unittest.main()
