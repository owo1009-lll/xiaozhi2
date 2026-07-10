from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_error_perturbations.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_error_perturbations", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinErrorPerturbationTest(unittest.TestCase):
    def test_event_index_finds_only_nearby_same_pitch(self) -> None:
        events = [
            {"start": 1.0, "midi": 69},
            {"start": 1.1, "midi": 71},
            {"start": 1.2, "midi": 69},
        ]
        index = MODULE.build_event_index(events)
        self.assertEqual(MODULE.nearby_event_indices(index, 69, 1.05, 0.08), [0])
        self.assertEqual(MODULE.nearby_event_indices(index, 71, 1.05, 0.08), [1])

    def test_missing_note_mutation_drops_all_same_pitch_fragments_near_target(self) -> None:
        row = {
            "unit": "u",
            "noteIndex": 1,
            "midi": 69,
            "predictedTime": 1.0,
        }
        grouped = {"u": [row]}
        events = {
            "u": [
                {"start": 0.98, "end": 1.05, "midi": 69},
                {"start": 1.02, "end": 1.08, "midi": 69},
                {"start": 1.0, "end": 1.1, "midi": 71},
            ]
        }
        mutated = MODULE.mutate_events(grouped, events, {("u", 1)}, "missing-note", 0.05)
        self.assertEqual([(event["midi"], event["start"]) for event in mutated["u"]], [(71, 1.0)])


if __name__ == "__main__":
    unittest.main()
