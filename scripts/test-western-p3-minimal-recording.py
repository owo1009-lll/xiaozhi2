#!/usr/bin/env python3
"""Regression checks for the staged minimum P3 recording protocol."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments"
    / "preregister_western_p3_minimal_recording.py"
)
SPEC = importlib.util.spec_from_file_location("p3_minimal_recording", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        report = MODULE.run(root / "protocol.json", root / "protocol.md")

    assert report["contract"] == "western-p3-staged-minimal-recording-protocol-v1"
    assert len(report["protocolSemanticSha256"]) == 64
    trigger = report["trigger"]
    assert trigger["p1RunnableCandidatesEliminated"] == 7
    assert trigger["p1RunnableCandidatesRetained"] == 0
    assert trigger["p2AdjudicatedRealErrorPositives"] == 0
    assert trigger["remainingCandidate"] == "performance-only-RF-v2"
    decision = report["recordingDecision"]
    assert decision["minimumUnavoidableNewRecordingsNow"] == 6
    assert decision["conditionalAdditionalFreshRecordings"] == 6
    assert decision["maximumTotalIfStageAPasses"] == 12
    assert decision["recordAllTwelveNow"] is False
    assert decision["recordingReductionIfStageAFails"] == 6
    for stage in (report["stageA"], report["stageB"]):
        assert stage["recordingCount"] == 6
        assert len(stage["profile"]["pieceIds"]) == 2
        assert set(stage["profile"]["recordingsPerPiece"].values()) == {3}
        assert all(
            counts == {"positive": 6, "confusionNegative": 12}
            for counts in stage["profile"]["byGate"].values()
        )
    assert set(report["stageA"]["profile"]["pieceIds"]).isdisjoint(
        report["stageB"]["profile"]["pieceIds"]
    )
    assert set(report["stageA"]["profile"]["performerIds"]).isdisjoint(
        report["stageB"]["profile"]["performerIds"]
    )
    assert report["stageA"]["candidate"]["decisionThreshold"] == 0.5
    assert report["stageA"]["candidate"]["modelParams"] == {
        "n_estimators": 256,
        "max_depth": 4,
        "min_samples_leaf": 2,
        "class_weight": "balanced_subsample",
        "random_state": 20260722,
        "n_jobs": 1,
    }
    operations = report["stageA"]["operations"]
    assert operations["truthSignoffPackCommand"] == (
        "npm run western:round6-stage-a-truth-signoff-pack"
    )
    assert operations["truthSignoffApplyCommand"] == (
        "npm run western:round6-stage-a-truth-signoff-apply -- "
        "--completed <path> --apply"
    )
    assert operations["safetyPreflightCommand"] == (
        "npm run western:round6-stage-a-safety-preflight"
    )
    assert operations["safetyEvaluationCommand"] == (
        "npm run western:round6-stage-a-safety-eval"
    )
    assert operations["freshAudioMustBeAbsent"] is True
    assert operations["cleanSafetyMayBeConsumedOnce"] is True
    assert report["stageB"]["promotionThresholds"] == {
        "minPrecision": 0.9,
        "minRecall": 0.5,
        "maxStrictFalseAccusations": 0,
    }
    assert report["stageB"]["postFreshRetuningAllowed"] is False
    assert report["discipline"]["freshReadDuringStageA"] is False
    assert report["discipline"]["studentSwitchesRemainFalse"] is True
    assert report["supersession"][
        "currentAuthorizedRecordingScope"
    ] == "stage-a-calibration-six-only"
    source_paths = {binding["path"] for binding in report["sourceBindings"]}
    assert source_paths == {
        "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json",
        "docs/evidence/western-strings-p1-clean-domain-safety-20260724.json",
        "docs/evidence/western-strings-p2-public-error-recall-audit-20260724.json",
        "config/western-strings-round6-evaluation-protocol.json",
        "config/western-strings-round6-counterbalanced-contract.json",
        "data/private/western-strings-round6-counterbalanced/manifest.csv",
        "data/private/western-strings-round6-counterbalanced/position-truth.json",
        "scripts/generate-western-round5-truth-signoff-pack.mjs",
        "scripts/apply-western-truth-signoff.mjs",
        "scripts/run_western_round6_stage_a_safety.py",
        "scripts/experiments/train_western_round6_full_score_candidate.py",
        "package.json",
    }
    print("western P3 minimum-recording preregistration tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
