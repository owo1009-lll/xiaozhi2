#!/usr/bin/env python3
"""Regression checks for the zero-recording-first stakeholder report."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments"
    / "build_western_zero_recording_stakeholder_report.py"
)
SPEC = importlib.util.spec_from_file_location(
    "zero_recording_stakeholder_report",
    SCRIPT,
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        artifact = MODULE.run(Path(temp) / "artifact.json")

    manifest = artifact["manifest"]
    snapshot = artifact["snapshot"]
    assert artifact["surface"] == "report"
    assert manifest["title"] == "少录音优先决策"
    assert manifest["blocks"][0] == {
        "id": "title",
        "type": "markdown",
        "body": "# 少录音优先决策",
    }
    assert manifest["blocks"][1]["body"].startswith("## Executive Summary")
    assert len(manifest["charts"]) == 1
    assert len(manifest["tables"]) == 4
    candidates = snapshot["datasets"]["candidate_outcomes"]
    assert len(candidates) == 7
    assert all(row["retained"] == "否" for row in candidates)
    assert all(row["safetyLimitsBreached"] >= 1 for row in candidates)
    assert {row["candidateId"] for row in candidates} == {
        "alignment-gap-refined-self-check-v1",
        "alignment-gap-strict-missing-v1",
        "relative-ioi-duration-review-v1",
        "relative-ioi-duration-strict-v1",
        "pitch-trajectory-center-strict-v1",
        "onset-density-extra-strict-v1",
        "temporal-operation-sequence-union-v1",
    }
    assert len(snapshot["datasets"]["round5_accounting"]) == 6
    public = snapshot["datasets"]["public_recall"]
    assert sum(row["referenceNotes"] for row in public) == 5326
    assert sum(row["adjudicatedErrorPositives"] for row in public) == 0
    stages = snapshot["datasets"]["recording_stages"]
    assert stages[0]["recordings"] == 6
    assert stages[0]["condition"] == "现在必要"
    assert stages[1]["recordings"] == 6
    assert stages[1]["condition"] == "仅 Stage A 全部通过"
    p3_block = next(
        block for block in manifest["blocks"] if block["id"] == "p3-heading"
    )
    assert "现在只录 6 条" in p3_block["body"]
    assert "P≥90% / R≥50% / strict FP=0" in p3_block["body"]
    caveats = next(
        block for block in manifest["blocks"] if block["id"] == "caveats"
    )
    assert "三个学生开关继续为 false" in caveats["body"]
    assert "M4 OMR" in caveats["body"]
    assert len(artifact["sources"]) == 9
    print("western zero-recording stakeholder report tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
