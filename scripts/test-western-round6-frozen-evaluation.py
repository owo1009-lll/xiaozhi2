#!/usr/bin/env python3
"""Tests for the once-only Round-6 fresh-blind evaluation guard."""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).resolve().parent / "run_western_round6_frozen_evaluation.py"
SPEC = importlib.util.spec_from_file_location("round6_frozen_evaluation", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for directory in ("config", "scripts", "data/private", "data/experiments"):
            (root / directory).mkdir(parents=True, exist_ok=True)
        roles = {
            "execution-guard": "scripts/guard.py",
            "candidate-runner": "scripts/candidate.py",
            "temporal-operation-policy": "scripts/temporal.py",
            "intake-validator": "scripts/intake.py",
            "audio-feature-analyzer": "scripts/audio.py",
            "round6-contract": "config/contract.json",
        }
        for index, relative in enumerate(roles.values()):
            (root / relative).write_text(f"source-{index}\n", encoding="utf-8")

        model_params = {
            "n_estimators": 256,
            "max_depth": 4,
            "min_samples_leaf": 2,
            "class_weight": "balanced_subsample",
            "random_state": 20260722,
            "n_jobs": 1,
        }
        protocol = {
            "contractVersion": MODULE.PROTOCOL_CONTRACT,
            "status": "pre-registered-before-audio",
            "paths": {
                "contract": "config/contract.json",
                "manifest": "data/private/manifest.csv",
                "truth": "data/private/truth.json",
                "report": "data/experiments/report.json",
                "model": "data/experiments/model.joblib",
                "consumedLedger": "data/experiments/consumed.json",
            },
            "sourceBindings": [
                {
                    "role": role,
                    "path": relative,
                    "hashMode": "lf-normalized-sha256",
                    "sha256": MODULE.sha256_path(
                        root / relative,
                        "lf-normalized-sha256",
                    ),
                }
                for role, relative in roles.items()
            ],
            "evaluation": {
                "calibrationSplit": "calibration",
                "freshBlindSplit": "fresh-blind",
                "freshBlindRunLimit": 1,
                "freshUsedForSelection": False,
                "decisionThreshold": 0.5,
                "gates": list(MODULE.EXPECTED_GATES),
                "promotionThresholds": {
                    "minPrecision": 0.9,
                    "minRecall": 0.5,
                    "maxStrictFalseAccusations": 0,
                },
                "promotionScope": "independent-per-gate",
                "completeInventoryRequired": True,
                "scorePositionCounterbalanceRequired": True,
            },
            "candidate": {
                "sourceContract": "western-round5-segment-edit-path-candidate-v1",
                "modelFamily": "fixed-random-forest-binary-per-gate",
                "modelParams": model_params,
                "frozenRuleContracts": {
                    "gapRefinement": "gap-refinement",
                    "gapStrict": "gap-strict",
                    "rhythmRefinement": "rhythm-refinement",
                    "rhythmStrict": "rhythm-strict",
                },
                "allowedCandidateFamilies": [
                    "fixed-random-forest-binary-per-gate",
                    "frozen-gap-refinement-self-check",
                    "frozen-gap-strict-missing",
                    "frozen-rhythm-structural-self-check",
                    "frozen-rhythm-strict-extra-drag",
                ],
                "postFreshRetuningAllowed": False,
            },
            "interpretation": {
                "numericPassIsEvidenceNotReleaseAuthorization": True,
                "partialGatePassDoesNotAuthorizeOtherGates": True,
                "failedOrCrashedFreshRunMayNotBeRepeated": True,
                "newCandidateAfterFreshRequiresNewUntouchedPackage": True,
            },
            "studentFacing": False,
            "automaticAuthorizationGranted": False,
        }
        protocol_path = root / "config/protocol.json"
        protocol_path.write_text(
            json.dumps(protocol, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (root / "data/private/manifest.csv").write_text("recordingId\n", encoding="utf-8")
        (root / "data/private/truth.json").write_text("{}\n", encoding="utf-8")

        candidate = SimpleNamespace(
            CONTRACT="western-round5-segment-edit-path-candidate-v1",
            GATES=MODULE.EXPECTED_GATES,
            MODEL_PARAMS=model_params,
            FROZEN_GAP_REFINEMENT_CONTRACT="gap-refinement",
            FROZEN_GAP_STRICT_CONTRACT="gap-strict",
            FROZEN_RHYTHM_REFINEMENT_CONTRACT="rhythm-refinement",
            FROZEN_RHYTHM_STRICT_CONTRACT="rhythm-strict",
            intake=SimpleNamespace(REPO=root),
        )
        calls = {"evaluation": 0}

        def pending_intake(*_args):
            return {
                "ready": False,
                "hashes": {"truthSha256": "pending"},
                "blockingReasons": ["audio-pending"],
            }

        def ready_intake(*_args):
            return {
                "ready": True,
                "hashes": {"truthSha256": "ready"},
                "blockingReasons": [],
            }

        def evaluate(_contract, _manifest, _truth, report, model):
            calls["evaluation"] += 1
            report.write_text("{}\n", encoding="utf-8")
            model.write_bytes(b"model")
            return {
                "evaluationPerformed": True,
                "promotedGates": [],
                "automaticAccusationReady": False,
                "studentFacing": False,
            }

        pending = MODULE.run(
            repo_root=root,
            protocol_path=protocol_path,
            module=candidate,
            intake_validator=pending_intake,
            evaluator=evaluate,
        )
        assert pending["runnerReady"] is True
        assert pending["intakeReady"] is False
        assert pending["evaluationPerformed"] is False
        assert pending["freshBlindConsumed"] is False
        assert not (root / protocol["paths"]["consumedLedger"]).exists()

        stale_source = root / roles["temporal-operation-policy"]
        stale_source.write_text("changed\n", encoding="utf-8")
        stale = MODULE.run(
            repo_root=root,
            protocol_path=protocol_path,
            module=candidate,
            intake_validator=ready_intake,
            evaluator=evaluate,
        )
        assert stale["runnerReady"] is False
        assert "round6-evaluation-source-sha-mismatch:temporal-operation-policy" in stale[
            "blockingReasons"
        ]
        assert calls["evaluation"] == 0
        stale_source.write_text("source-2\n", encoding="utf-8")

        completed = MODULE.run(
            repo_root=root,
            protocol_path=protocol_path,
            module=candidate,
            intake_validator=ready_intake,
            evaluator=evaluate,
        )
        assert completed["ok"] is True
        assert completed["evaluationPerformed"] is True
        assert completed["freshBlindConsumed"] is True
        assert completed["promotionEvidenceEligible"] is True
        assert completed["automaticAccusationReady"] is False
        assert calls["evaluation"] == 1
        ledger = json.loads(
            (root / protocol["paths"]["consumedLedger"]).read_text(encoding="utf-8")
        )
        assert ledger["status"] == "evaluation-completed"
        assert ledger["freshBlindConsumed"] is True

        repeated = MODULE.run(
            repo_root=root,
            protocol_path=protocol_path,
            module=candidate,
            intake_validator=ready_intake,
            evaluator=evaluate,
        )
        assert repeated["evaluationPerformed"] is False
        assert repeated["freshBlindConsumed"] is True
        assert repeated["blockingReasons"] == ["round6-fresh-blind-already-consumed"]
        assert calls["evaluation"] == 1

        (root / protocol["paths"]["consumedLedger"]).write_text(
            "not-json\n",
            encoding="utf-8",
        )
        corrupt_ledger = MODULE.run(
            repo_root=root,
            protocol_path=protocol_path,
            module=candidate,
            intake_validator=ready_intake,
            evaluator=evaluate,
        )
        assert corrupt_ledger["freshBlindConsumed"] is True
        assert corrupt_ledger["consumedLedgerStatus"] == "unreadable"
        assert calls["evaluation"] == 1

    print("western Round-6 frozen evaluation tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
