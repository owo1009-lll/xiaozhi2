from __future__ import annotations

import csv
import importlib.util
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "experiments" / "eval_western_strings_confidence_gate.py"
spec = importlib.util.spec_from_file_location("western_confidence_gate", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def write_rows(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def base_row(note_index: int, method: str, distance: float, correct: str) -> dict[str, object]:
    return {
        "dataset": "fixture-a",
        "piece": "piece",
        "noteIndex": str(note_index),
        "method": method,
        "midi": "69",
        "scoreTime": str(note_index),
        "goldTime": str(note_index + 0.1),
        "predTime": str(note_index + 0.1 + (0.0 if correct == "1" else 1.0)),
        "doubleStop": "0",
        "legato": "unknown",
        "methodCount": "2",
        "validPredictionCount": "2",
        "predictionSpanSeconds": "0.08" if correct == "1" else "0.8",
        "predictionStdSeconds": "0.04" if correct == "1" else "0.4",
        "candidateToMedianAbsSeconds": str(distance),
        "agreementWithin100ms": "2" if correct == "1" else "1",
        "agreementWithin300ms": "2" if correct == "1" else "1",
        "isDefaultSelectedMethod": "1" if method == "basic-pitch-dtw" else "0",
        "isOracleBestMethod": correct,
        "labelCandidateAbsError": "0.02" if correct == "1" else "1.0",
        "labelCandidateWithin100ms": correct,
        "labelCandidateWithin150ms": correct,
        "labelCandidateWithin300ms": correct,
    }


def main() -> int:
    with tempfile.TemporaryDirectory() as temp_dir:
        feature_path = Path(temp_dir) / "candidate.csv"
        rows = [
            base_row(0, "basic-pitch-dtw", 0.01, "1"),
            base_row(0, "crepe-dtw", 0.02, "1"),
            base_row(1, "basic-pitch-dtw", 0.01, "1"),
            base_row(1, "crepe-dtw", 0.02, "1"),
            base_row(2, "basic-pitch-dtw", 0.6, "0"),
            base_row(2, "crepe-dtw", 0.7, "0"),
        ]
        write_rows(feature_path, rows)
        loaded = module.read_rows(feature_path)
        rule, metrics = module.fit_rule(loaded, 0.9)
        require(metrics["precision"] == 1.0, f"expected perfect precision on the tight cluster, got {metrics}")
        require(metrics["coverage"] > 0.6, f"expected two of three notes to pass, got {metrics}")
        evaluated = module.evaluate_rule(loaded, rule)
        require(evaluated["autoPassCount"] == 2, f"evaluation should count notes, not candidates: {evaluated}")
    print('{"ok": true, "checks": ["western-confidence-gate-note-level"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
