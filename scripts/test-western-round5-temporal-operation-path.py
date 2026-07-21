#!/usr/bin/env python3
"""Audit the frozen temporal operation-path smoke evidence."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
EVIDENCE = REPO / "docs/evidence/western-strings-round5-temporal-operation-path-20260722.json"
REPORT = REPO / "data/experiments/western-strings-round5-temporal-operation-path/report.json"


def bound_sha256(path: Path, mode: str) -> str:
    data = path.read_bytes()
    if mode == "lf-normalized-sha256":
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    else:
        assert mode == "raw-sha256"
    return hashlib.sha256(data).hexdigest()


def main() -> int:
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
    canonical = json.dumps(observed, sort_keys=True, separators=(",", ":"))
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
    assert "gap-refinement-fresh-blind-not-run" in refinement["promotionBlockingReasons"]

    print(json.dumps({
        "ok": True,
        "checks": [
            "source-binding-current",
            "raw-operation-path-rejected",
            "policy-c-gap-refinement-diagnostic-boundary",
            "strict-confirmed-recall-unchanged",
            "student-and-automatic-gates-closed",
        ],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
