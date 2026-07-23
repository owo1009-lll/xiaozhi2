#!/usr/bin/env python3
"""Result-blind unit checks for the frozen P1 clean-domain evaluator."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts/experiments/eval_western_p1_clean_domain_candidates.py"


def load_module():
    spec = importlib.util.spec_from_file_location("p1_clean_eval", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    module = load_module()
    assert module.rate(0, 0) == 0
    assert module.rate(1, 4) == 0.25

    summary = module.summarize_domain(
        role="test",
        records=[
            {
                "recordingId": "a",
                "count": 1,
                "denominator": 100,
                "rate": 0.01,
            },
            {
                "recordingId": "b",
                "count": 2,
                "denominator": 100,
                "rate": 0.02,
            },
        ],
        count_field="count",
        denominator_field="denominator",
        authoritative_false_positive=True,
    )
    assert summary["flagCount"] == 3
    assert summary["positionCount"] == 200
    assert summary["flagsPer1000Positions"] == 15
    assert summary["maximumPerRecordingRate"] == 0.02

    automatic = {
        "candidateId": "automatic",
        "outputSemantic": "automatic_issue_candidate",
    }
    review = {"candidateId": "review", "outputSemantic": "review_hint"}
    rules = {
        "automatic_issue_candidate": {
            "authoritativeLocalCleanFalsePositiveMax": 0,
            "consumedRound5KnownNegativeFalsePositiveMax": 0,
            "publicProfessionalBurdenPooledPer1000Max": 5.0,
            "publicProfessionalBurdenAnyRecordingPer1000Max": 10.0,
        },
        "review_hint": {
            "authoritativeLocalCleanHintRateMax": 0.02,
            "authoritativeLocalCleanAnyRecordingHintRateMax": 0.05,
            "consumedRound5KnownNegativeHintRateMax": 0.02,
            "consumedRound5AnyRecordingHintRateMax": 0.05,
            "publicProfessionalBurdenPooledPer1000Max": 20.0,
            "publicProfessionalBurdenAnyRecordingPer1000Max": 50.0,
        },
    }
    safe_domains = {
        "authoritative-local-clean": {
            "flagCount": 0,
            "rate": 0.0,
            "maximumPerRecordingRate": 0.0,
        },
        "consumed-round5-known-negatives": {
            "flagCount": 0,
            "rate": 0.0,
            "maximumPerRecordingRate": 0.0,
        },
        "public-professional-burden": {
            "flagsPer1000Positions": 0.0,
            "maximumPerRecordingRate": 0.0,
        },
    }
    assert module.elimination_decision(automatic, safe_domains, rules) == (False, [])
    assert module.elimination_decision(review, safe_domains, rules) == (False, [])

    unsafe = dict(safe_domains)
    unsafe["authoritative-local-clean"] = {
        "flagCount": 1,
        "rate": 0.001,
        "maximumPerRecordingRate": 0.01,
    }
    eliminated, reasons = module.elimination_decision(automatic, unsafe, rules)
    assert eliminated
    assert reasons == ["authoritative-local-clean-false-positive"]

    context = {
        "times": np.asarray([0.0, 0.2, 0.4, 0.6, 0.8]),
        "envelope": np.asarray([1.0, 0.0, 0.0, 0.9, 0.0]),
    }
    ratio = module.temporal.interior_attack_ratio(context, 0.0, 1.0)
    assert 0.89 <= ratio <= 0.91
    print("western P1 clean-domain candidate evaluator tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
