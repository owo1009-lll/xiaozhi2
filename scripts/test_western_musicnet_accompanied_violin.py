from __future__ import annotations

import csv
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPERIMENTS = ROOT / "scripts" / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_musicnet_accompanied_violin import (  # noqa: E402
    candidate_key,
    gate_checks,
    load_violin_reference_rows,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "labels.csv"
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=("start_time", "end_time", "instrument", "note"),
            )
            writer.writeheader()
            writer.writerows(
                [
                    {"start_time": 44100, "end_time": 66150, "instrument": 41, "note": 69},
                    {"start_time": 44100, "end_time": 66150, "instrument": 41, "note": 76},
                    {"start_time": 44100, "end_time": 88200, "instrument": 1, "note": 45},
                    {"start_time": 88200, "end_time": 110250, "instrument": 41, "note": 71},
                ]
            )
        rows = load_violin_reference_rows(path)

    require(len(rows) == 3, "piano gold must be excluded")
    require(rows[0]["goldTime"] == "1.0", "sample time must convert to seconds")
    require(rows[0]["doubleStop"] == "true" and rows[1]["doubleStop"] == "true", "shared violin onset must mark both double-stop notes")
    require(rows[2]["doubleStop"] == "false", "single violin onset must remain single")

    passing = {
        "aggregate": {
            "50ms": {"precision": 0.91, "recall": 0.81},
            "100ms": {"precision": 0.92, "recall": 0.86, "f1": 0.89},
        }
    }
    failing = {
        "aggregate": {
            "50ms": {"precision": 0.91, "recall": 0.79},
            "100ms": {"precision": 0.92, "recall": 0.86, "f1": 0.89},
        }
    }
    require(all(gate_checks(passing).values()), "all frozen floors should pass")
    require(not all(gate_checks(failing).values()), "one missed floor should fail closed")

    strong = {"minConfidence": 0.4, "minDurationSeconds": 0.05, "development": passing}
    weak = {"minConfidence": 0.3, "minDurationSeconds": 0.03, "development": failing}
    require(candidate_key(strong) > candidate_key(weak), "candidate selection should prioritize passed checks")
    print("musicnet accompanied violin evaluator tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
