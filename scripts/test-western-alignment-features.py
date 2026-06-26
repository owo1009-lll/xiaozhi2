from __future__ import annotations

import csv
import importlib.util
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "experiments" / "build_western_strings_alignment_features.py"
spec = importlib.util.spec_from_file_location("western_alignment_features", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
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


def main() -> int:
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        per_note = root / "m0a-test" / "m0a-test-per-note.csv"
        base = {
            "piece": "fixture",
            "noteIndex": "0",
            "scoreTime": "1.0",
            "goldTime": "10.0",
            "midi": "69",
            "doubleStop": "False",
            "legato": "unknown",
        }
        write_rows(
            per_note,
            [
                {**base, "method": "linear-scoretime", "predTime": "9.0", "absError": "1.0"},
                {**base, "method": "basic-pitch-dtw", "predTime": "10.05", "absError": "0.05"},
                {**base, "method": "parangonar-basic-pitch", "predTime": "10.2", "absError": "0.2"},
            ],
        )

        rows = module.build_feature_rows(root)
        require(len(rows) == 1, f"expected one pivoted feature row, got {len(rows)}")
        row = rows[0]
        require(row["selectedMethod"] == "parangonar-basic-pitch", "default selected method should be Parangonar+BasicPitch")
        require(row["labelSelectedWithin150ms"] == "0", "0.2s selected error should fail 150ms label")
        require(row["labelSelectedWithin300ms"] == "1", "0.2s selected error should pass 300ms label")
        require(row["labelOracleBestMethod"] == "basic-pitch-dtw", "oracle audit label should identify the closest method")
        require(row["agreementWithin300ms"] == "2", f"expected two predictions in a 300ms cluster, got {row['agreementWithin300ms']}")
        candidates = module.build_candidate_rows(rows)
        require(len(candidates) == 3, f"expected one candidate row per method, got {len(candidates)}")
        basic_pitch = next(item for item in candidates if item["method"] == "basic-pitch-dtw")
        parangonar = next(item for item in candidates if item["method"] == "parangonar-basic-pitch")
        require(basic_pitch["isOracleBestMethod"] == "1", "candidate table should mark the closest method")
        require(parangonar["isDefaultSelectedMethod"] == "1", "candidate table should mark the default selected method")
        require(parangonar["labelCandidateWithin300ms"] == "1", "candidate table should keep per-method labels")
        summary = module.summarize(rows)
        require(summary["rowCount"] == 1, "summary row count should match")
        require("leakageWarning" in summary, "summary must warn that label columns are gold-derived")
        candidate_summary = module.summarize_candidates(candidates)
        require(candidate_summary["rowCount"] == 3, "candidate summary row count should match")
    print('{"ok": true, "checks": ["western-alignment-feature-pivot"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
