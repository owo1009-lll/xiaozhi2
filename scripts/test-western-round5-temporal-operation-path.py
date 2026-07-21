#!/usr/bin/env python3
"""Audit the frozen temporal operation-path smoke evidence."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
EVIDENCE = REPO / "docs/evidence/western-strings-round5-temporal-operation-path-20260722.json"
REPORT = REPO / "data/experiments/western-strings-round5-temporal-operation-path/report.json"
SCRIPT = REPO / "scripts/experiments/eval_western_round5_temporal_operation_path.py"
sys.path.insert(0, str(REPO / "scripts/experiments"))


def bound_sha256(path: Path, mode: str) -> str:
    data = path.read_bytes()
    if mode == "lf-normalized-sha256":
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    else:
        assert mode == "raw-sha256"
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    spec = importlib.util.spec_from_file_location("round5_temporal_operation_path", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    assert set(module.FROZEN_PARAMS_BY_GATE) == set(module.GATES)
    gaps, refined = module.policy_c_gap_refinement_indices(
        {"rows": [
            {"predictedTime": 0.0},
            {"predictedTime": None},
            {"predictedTime": None},
            {"predictedTime": None},
            {"predictedTime": 4.0},
        ]},
        {"merged_substitution": {1}, "missing": {2, 4}},
    )
    assert gaps == {1, 2, 3}
    assert refined == {1, 2}
    rhythm = module.rhythm_structural_refinement_indices(
        {"rows": [
            {"relativeIoiDeviationRatio": 0.20, "eventDurationRatio": 1.30, "eventConfidence": 0.80},
            {"relativeIoiDeviationRatio": 0.10, "eventDurationRatio": 1.30, "eventConfidence": 0.80},
            {"relativeIoiDeviationRatio": 0.20, "eventDurationRatio": 1.10, "eventConfidence": 0.80},
            {"relativeIoiDeviationRatio": 0.20, "eventDurationRatio": 1.30, "eventConfidence": 0.70},
            {"relativeIoiDeviationRatio": 0.20, "eventDurationRatio": 1.25, "eventConfidence": 0.80},
        ]},
        {"merged_substitution": {0, 1, 2, 3, 4}, "missing": set(), "extra": set(), "drag": set()},
    )
    assert rhythm == {0, 4}
    rhythm_strict = module.rhythm_structural_refinement_indices(
        {"rows": [
            {"relativeIoiDeviationRatio": 0.20, "eventDurationRatio": 1.30, "eventConfidence": 0.80},
            {"relativeIoiDeviationRatio": 0.20, "eventDurationRatio": 1.25, "eventConfidence": 0.80},
        ]},
        {"merged_substitution": {0, 1}, "missing": set(), "extra": set(), "drag": set()},
        module.RHYTHM_STRICT_ISSUE_CANDIDATE,
    )
    assert rhythm_strict == {0}

    evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    assert evidence["contract"] == "western-round5-temporal-operation-path-smoke-v1"
    assert evidence["scope"] == "architecture-smoke-preGateOnly"
    assert evidence["studentFacing"] is False
    assert evidence["automaticAccusationReady"] is False
    assert evidence["reviewAssistPromotionReady"] is False
    assert evidence["productionAdoptionReady"] is False
    assert evidence["promotionEvidenceEligible"] is False
    assert evidence["architectureCandidateRetained"] is False

    binding = evidence["sourceBinding"]
    observed = []
    for row in binding["files"]:
        source = REPO / row["path"]
        assert source.is_file(), row["path"]
        assert bound_sha256(source, row["hashMode"]) == row["sha256"], row["path"]
        observed.append({
            "path": row["path"], "hashMode": row["hashMode"], "sha256": row["sha256"],
        })
    canonical = json.dumps(observed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert hashlib.sha256(canonical.encode()).hexdigest() == binding["aggregateSha256"]
    assert binding["fileCount"] == len(observed)
    assert REPORT.read_bytes() == EVIDENCE.read_bytes()

    raw = evidence["round4InspectedReal"]["union"]
    assert raw["truePositive"] == 11
    assert raw["falsePositive"] == 55
    assert raw["jointFloorReady"] is False
    refinement = evidence["policyCGapRefinement"]
    combined = refinement["round4TwoLayerCombined"]
    assert combined["strictConfirmed"] == 2
    assert combined["refinedSelfCheckHints"] == 4
    assert combined["truePositive"] == 6
    assert combined["falsePositive"] == 0
    assert combined["precision"] == 1.0
    assert combined["recall"] == 0.5
    assert combined["strictConfirmedRecallUnchanged"] is True
    assert combined["automaticAccusationReady"] is False
    assert combined["reviewAssistPromotionReady"] is False
    assert refinement["candidateRetainedForFreshBlind"] is True
    assert refinement["naturalCleanStress"]["refined"]["falsePositive"] == 0
    assert len(refinement["naturalCleanStress"]["recordings"]) == 5
    public_stress = refinement["publicProfessionalStress"]
    assert public_stress["evidenceRole"] == "public-professional-unadjudicated-negative-burden-proxy"
    assert public_stress["inputContract"] == "whole-performance score with repeats expanded before alignment"
    assert public_stress["recordingCount"] == 2
    assert public_stress["scorePositionCount"] == 2301
    assert public_stress["assignmentGapCount"] == 936
    assert public_stress["refinedFlagCount"] == 595
    assert public_stress["refinedFlagsPer1000Positions"] == 258.583225
    assert public_stress["humanErrorGoldAvailable"] is False
    assert public_stress["falsePositiveCountAuthoritative"] is False
    assert public_stress["generalPurposeBurdenReady"] is False
    assert public_stress["promotionEvidenceEligible"] is False
    assert refinement["generalPurposeCandidateRetained"] is False
    assert "gap-refinement-fresh-blind-not-run" in refinement["promotionBlockingReasons"]
    assert "public-professional-negative-burden-not-cleared" in refinement["promotionBlockingReasons"]
    rhythm_refinement = evidence["rhythmStructuralRefinement"]
    assert rhythm_refinement["outputSemantic"] == "self_check_hint"
    assert rhythm_refinement["strictConfirmedRecallChanged"] is False
    assert rhythm_refinement["automaticAccusationReady"] is False
    assert rhythm_refinement["promotionEvidenceEligible"] is False
    assert rhythm_refinement["calibration"]["truePositive"] == 18
    assert rhythm_refinement["calibration"]["falsePositive"] == 1
    assert rhythm_refinement["syntheticHoldout"]["truePositive"] == 15
    assert rhythm_refinement["syntheticHoldout"]["falsePositive"] == 0
    assert rhythm_refinement["syntheticHoldout"]["recall"] == 0.555556
    assert rhythm_refinement["round4InspectedReal"]["truePositive"] == 4
    assert rhythm_refinement["round4InspectedReal"]["falsePositive"] == 0
    assert rhythm_refinement["round4InspectedReal"]["recall"] == 0.666667
    assert rhythm_refinement["naturalCleanStress"]["falsePositive"] == 5
    assert rhythm_refinement["naturalCleanStress"]["hintRate"] == 0.017544
    assert rhythm_refinement["candidateRetainedForFreshBlind"] is True
    assert "rhythm-structural-fresh-blind-not-run" in rhythm_refinement["promotionBlockingReasons"]
    strict_candidate = evidence["rhythmStrictIssueCandidate"]
    assert strict_candidate["outputSemantic"] == "issue_detected_candidate"
    assert strict_candidate["rule"]["eventDurationRatioAtLeast"] == 1.3
    assert strict_candidate["strictConfirmedRecallChanged"] is False
    assert strict_candidate["automaticAccusationEvidenceReady"] is False
    assert strict_candidate["automaticAccusationReady"] is False
    assert strict_candidate["promotionEvidenceEligible"] is False
    assert strict_candidate["calibration"]["truePositive"] == 18
    assert strict_candidate["calibration"]["falsePositive"] == 0
    assert strict_candidate["syntheticHoldout"]["truePositive"] == 14
    assert strict_candidate["syntheticHoldout"]["falsePositive"] == 0
    assert strict_candidate["syntheticHoldout"]["recall"] == 0.518519
    assert strict_candidate["round4InspectedReal"]["truePositive"] == 4
    assert strict_candidate["round4InspectedReal"]["falsePositive"] == 0
    assert strict_candidate["naturalCleanStress"]["falsePositive"] == 0
    assert strict_candidate["publicProfessionalStress"]["candidateCount"] == 13
    assert strict_candidate["publicProfessionalStress"]["falsePositiveCountAuthoritative"] is False
    assert strict_candidate["round4RecallLayers"]["strictPlusRhythmCandidate"]["truePositive"] == 6
    assert strict_candidate["round4RecallLayers"]["strictPlusRhythmCandidate"]["falsePositive"] == 0
    assert strict_candidate["round4RecallLayers"]["strictPlusRhythmAndGapSelfCheck"]["truePositive"] == 10
    assert strict_candidate["round4RecallLayers"]["strictPlusRhythmAndGapSelfCheck"]["falsePositive"] == 0
    assert strict_candidate["candidateRetainedForFreshBlind"] is True
    assert strict_candidate["generalPurposeCandidateRetained"] is False
    assert "rhythm-strict-fresh-blind-not-run" in strict_candidate["promotionBlockingReasons"]

    print(json.dumps({
        "ok": True,
        "checks": [
            "source-binding-current",
            "raw-operation-path-rejected",
            "policy-c-gap-refinement-diagnostic-boundary",
            "strict-confirmed-recall-unchanged",
            "public-professional-burden-not-mislabeled-as-false-positive",
            "rhythm-structural-refinement-fresh-blind-only",
            "rhythm-strict-issue-candidate-frozen-for-fresh-blind",
            "student-and-automatic-gates-closed",
        ],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
