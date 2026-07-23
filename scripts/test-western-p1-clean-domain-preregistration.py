#!/usr/bin/env python3
"""Contract checks for the P1 clean-domain preregistration."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts/experiments/preregister_western_p1_clean_domain_candidates.py"
REPORT = REPO / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"


def load_module():
    spec = importlib.util.spec_from_file_location("p1_preregistration", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    module = load_module()
    rebuilt = module.build_protocol()
    stored = json.loads(REPORT.read_text(encoding="utf-8"))
    assert rebuilt == stored

    semantic = dict(stored)
    expected_sha = semantic.pop("protocolSemanticSha256")
    actual_sha = hashlib.sha256(module.canonical_json(semantic).encode()).hexdigest()
    assert actual_sha == expected_sha

    candidates = {row["candidateId"]: row for row in stored["candidates"]}
    assert len(candidates) == 7
    assert set(candidates) == {
        "alignment-gap-refined-self-check-v1",
        "alignment-gap-strict-missing-v1",
        "relative-ioi-duration-review-v1",
        "relative-ioi-duration-strict-v1",
        "pitch-trajectory-center-strict-v1",
        "onset-density-extra-strict-v1",
        "temporal-operation-sequence-union-v1",
    }
    for candidate in candidates.values():
        assert candidate["positionFeaturesAllowed"] is False
        assert candidate["rawEnergyAllowed"] is False
        assert candidate["studentFacing"] is False
        assert candidate["automaticAdoptionReady"] is False

    excluded = {row["candidate"]: row["status"] for row in stored["excludedOrDeferred"]}
    assert excluded["raw-waveform-energy-absence"] == "stop-line"
    assert excluded["M4-OMR"] == "stop-line"
    assert excluded["score-position-or-static-context-RF"] == "prohibited"

    datasets = stored["datasets"]
    assert datasets["authoritative-local-clean"]["recordingCount"] == 17
    assert datasets["public-professional-burden"]["recordingCount"] == 7
    assert datasets["public-professional-burden"]["performerCount"] == 6
    assert datasets["public-professional-burden"]["workCount"] == 6
    assert datasets["pitch-artifact-local-clean"]["recordingCount"] == 11
    assert datasets["consumed-round5-known-negatives"]["crossContextCoverage"] == {
        "performerCount": 2,
        "deviceCount": 3,
        "roomCount": 2,
    }
    assert stored["retuningAfterEvaluationAllowed"] is False
    assert stored["reportingContract"]["syntheticRecallMayRepresentRealRecall"] is False
    assert stored["authorization"]["studentFacing"] is False
    assert stored["authorization"]["automaticAccusationReady"] is False
    print("western P1 clean-domain preregistration tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
