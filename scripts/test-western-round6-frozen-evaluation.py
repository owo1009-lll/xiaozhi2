#!/usr/bin/env python3
"""Tests for the once-only Round-6 fresh-blind evaluation guard."""
from __future__ import annotations

import importlib.util
import json
import shutil
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
            "feature-extractor": "scripts/feature_extractor.py",
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
                "model": "data/experiments/stage-a-model.joblib",
                "consumedLedger": "data/experiments/consumed.json",
                "stagedProtocol": "data/experiments/p3.json",
                "stageASignoffLineage": (
                    "data/experiments/stage-a-lineage.json"
                ),
                "stageASafetyReport": (
                    "data/experiments/stage-a-safety-report.json"
                ),
                "stageASafetyConsumed": (
                    "data/experiments/stage-a-safety-consumed.json"
                ),
                "stageBSignoffLineage": (
                    "data/experiments/stage-b-lineage.json"
                ),
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
                "sourceContract": "western-round6-full-score-candidate-v2",
                "modelFamily": (
                    "full-score-performance-only-random-forest-binary-per-gate"
                ),
                "featurePolicy": "alignment-performance-only-no-fixed-acoustic-v1",
                "excludedScoreContextFeatures": [
                    "n_0OutOfRange",
                    "n_m1OutOfRange",
                    "n_m2OutOfRange",
                    "n_p1OutOfRange",
                    "n_p2OutOfRange",
                    "scoreNextInterval",
                    "scorePreviousInterval",
                ],
                "excludedFixedAcousticFeatures": [
                    "acousticAvailable",
                    "targetInteriorAttackRatio",
                    "targetMeanVoicedProbability",
                    "targetNearPitchOccupancy",
                    "targetOnsetMax",
                    "targetOnsetMean",
                    "targetOnsetPeakCount",
                    "targetPeakDb",
                    "targetPitchOccupancy",
                    "targetRmsDb",
                    "targetVoicedFrameRatio",
                ],
                "requiredTemporalFeatures": [
                    "n_0AssignmentGap",
                    "n_0DurationMissing",
                    "n_0DurationRatio",
                    "n_0IoiDeviation",
                    "n_0IoiMissing",
                    "segmentMaxIoiDeviation",
                    "segmentMeanIoiDeviation",
                    "targetWindowEventCount",
                ],
                "strictFalseAccusationDenominator": (
                    "every fresh score position not signed positive for the evaluated gate"
                ),
                "modelParams": model_params,
                "frozenRuleContracts": {
                    "gapRefinement": "gap-refinement",
                    "gapStrict": "gap-strict",
                    "rhythmRefinement": "rhythm-refinement",
                    "rhythmStrict": "rhythm-strict",
                },
                "allowedCandidateFamilies": [
                    "full-score-performance-only-random-forest-binary-per-gate",
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
        stage_a_ids = [f"r6-cal-{index + 1}" for index in range(6)]
        stage_b_ids = [f"r6-fresh-{index + 1}" for index in range(6)]
        manifest_path = root / protocol["paths"]["manifest"]
        manifest_path.write_text(
            "recordingId,split,audioPath\n"
            + "".join(
                f"{recording_id},calibration,data/private/{recording_id}.wav\n"
                for recording_id in stage_a_ids
            )
            + "".join(
                f"{recording_id},fresh-blind,data/private/{recording_id}.wav\n"
                for recording_id in stage_b_ids
            ),
            encoding="utf-8",
        )
        (root / protocol["paths"]["truth"]).write_text("{}\n", encoding="utf-8")
        fresh_audio_hashes = {}
        for recording_id in stage_b_ids:
            audio_path = root / f"data/private/{recording_id}.wav"
            audio_path.write_bytes(f"audio-{recording_id}".encode())
            fresh_audio_hashes[recording_id] = MODULE.sha256_path(audio_path)

        staged_core = {
            "contract": MODULE.P3_CONTRACT,
            "stageA": {"recordingIds": stage_a_ids},
            "stageB": {"recordingIds": stage_b_ids},
        }
        staged = {
            "schemaVersion": 1,
            **staged_core,
            "sourceBindings": [],
            "protocolSemanticSha256": MODULE.semantic_sha(staged_core),
        }
        staged_path = root / protocol["paths"]["stagedProtocol"]
        staged_path.write_text(
            json.dumps(staged, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        stage_a_lineage_path = (
            root / protocol["paths"]["stageASignoffLineage"]
        )
        stage_a_lineage = {
            "contract": MODULE.STAGE_A_LINEAGE_CONTRACT,
            "scope": {
                "split": "calibration",
                "recordingIds": stage_a_ids,
            },
        }
        stage_a_lineage_path.write_text(
            json.dumps(stage_a_lineage, indent=2) + "\n",
            encoding="utf-8",
        )
        model_path = root / protocol["paths"]["model"]
        model_path.write_bytes(b"frozen-stage-a-model")
        authorization_hashes = {
            "protocolSha256": MODULE.sha256_path(staged_path),
            "stageALineageSha256": MODULE.sha256_path(stage_a_lineage_path),
            "safetyModelSha256": MODULE.sha256_path(model_path),
        }
        safety_consumed_path = (
            root / protocol["paths"]["stageASafetyConsumed"]
        )
        safety_consumed = {
            "contract": MODULE.STAGE_A_CONSUMED_CONTRACT,
            "p3ProtocolSemanticSha256": staged["protocolSemanticSha256"],
            "modelSha256": authorization_hashes["safetyModelSha256"],
            "cleanSafetyConsumed": True,
            "freshAudioRead": False,
            "studentFacing": False,
            "automaticAuthorizationGranted": False,
        }
        safety_consumed_path.write_text(
            json.dumps(safety_consumed, indent=2) + "\n",
            encoding="utf-8",
        )
        safety_report_path = root / protocol["paths"]["stageASafetyReport"]
        safety_report = {
            "contract": MODULE.STAGE_A_SAFETY_CONTRACT,
            "p3ProtocolSemanticSha256": staged["protocolSemanticSha256"],
            "stageAPassed": True,
            "stageBFreshRecordingAuthorized": True,
            "trainingPerformed": True,
            "cleanSafetyEvaluationPerformed": True,
            "freshAudioRead": False,
            "studentFacing": False,
            "automaticAuthorizationGranted": False,
            "blockingReasons": [],
            "modelArtifact": {
                "sha256": authorization_hashes["safetyModelSha256"],
            },
        }
        safety_report_path.write_text(
            json.dumps(safety_report, indent=2) + "\n",
            encoding="utf-8",
        )
        authorization_hashes.update({
            "safetyReportSha256": MODULE.sha256_path(safety_report_path),
            "safetyConsumedSha256": MODULE.sha256_path(safety_consumed_path),
        })
        stage_b_lineage = {
            "contract": MODULE.STAGE_B_LINEAGE_CONTRACT,
            "scope": {
                "split": "fresh-blind",
                "recordingIds": stage_b_ids,
            },
            "stageAAuthorization": {
                "contract": MODULE.STAGE_B_AUTHORIZATION_CONTRACT,
                "p3ProtocolSemanticSha256": staged[
                    "protocolSemanticSha256"
                ],
                "stageAPassed": True,
                "stageBFreshRecordingAuthorized": True,
                "authorizationHashes": authorization_hashes,
            },
            "audioSha256ByRecording": fresh_audio_hashes,
            "appliedHashes": {
                "manifestSha256": MODULE.sha256_path(manifest_path),
                "truthSha256": MODULE.sha256_path(
                    root / protocol["paths"]["truth"]
                ),
            },
            "calibrationPreservation": {
                "unchanged": True,
                "manifestProjectionBeforeSha256": "a" * 64,
                "manifestProjectionAfterSha256": "a" * 64,
                "truthProjectionBeforeSha256": "b" * 64,
                "truthProjectionAfterSha256": "b" * 64,
            },
            "studentFacing": False,
            "automaticAuthorizationGranted": False,
        }
        (root / protocol["paths"]["stageBSignoffLineage"]).write_text(
            json.dumps(stage_b_lineage, indent=2) + "\n",
            encoding="utf-8",
        )

        candidate = SimpleNamespace(
            CONTRACT="western-round6-full-score-candidate-v2",
            MODEL_FAMILY=(
                "full-score-performance-only-random-forest-binary-per-gate"
            ),
            FEATURE_POLICY="alignment-performance-only-no-fixed-acoustic-v1",
            EXCLUDED_SCORE_CONTEXT_FEATURES=tuple(
                protocol["candidate"]["excludedScoreContextFeatures"]
            ),
            EXCLUDED_FIXED_ACOUSTIC_FEATURES=tuple(
                protocol["candidate"]["excludedFixedAcousticFeatures"]
            ),
            REQUIRED_TEMPORAL_FEATURES=tuple(
                protocol["candidate"]["requiredTemporalFeatures"]
            ),
            STRICT_FALSE_ACCUSATION_DENOMINATOR=(
                "every fresh score position not signed positive for the evaluated gate"
            ),
            GATES=MODULE.EXPECTED_GATES,
            MODEL_PARAMS=model_params,
            FROZEN_GAP_REFINEMENT_CONTRACT="gap-refinement",
            FROZEN_GAP_STRICT_CONTRACT="gap-strict",
            FROZEN_RHYTHM_REFINEMENT_CONTRACT="rhythm-refinement",
            FROZEN_RHYTHM_STRICT_CONTRACT="rhythm-strict",
            intake=SimpleNamespace(REPO=root),
        )
        calls = {"evaluation": 0}
        intake_counts = {
            "positiveByGate": {
                gate: 2 for gate in MODULE.EXPECTED_GATES
            },
            "confusionNegativeByGate": {
                gate: 4 for gate in MODULE.EXPECTED_GATES
            },
            "freshBlindPositiveByGate": {
                gate: 1 for gate in MODULE.EXPECTED_GATES
            },
            "freshBlindConfusionNegativeByGate": {
                gate: 2 for gate in MODULE.EXPECTED_GATES
            },
        }
        valid_denominators = {
            split: {
                gate: {
                    "allScorePositions": 20,
                    "positivePositions": 1,
                    "strictNegativePositions": 19,
                    "ordinaryUnlistedPositions": 8,
                    "targetConfusionNegativePositions": 2,
                    "otherGateOrControlPositions": 9,
                }
                for gate in MODULE.EXPECTED_GATES
            }
            for split in ("calibration", "fresh-blind")
        }

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
                "counts": intake_counts,
                "blockingReasons": [],
            }

        def evaluate(
            _contract,
            _manifest,
            _truth,
            report,
            model,
            frozen_model,
        ):
            calls["evaluation"] += 1
            report.write_text("{}\n", encoding="utf-8")
            assert model == frozen_model
            return {
                "contract": candidate.CONTRACT,
                "modelFamily": candidate.MODEL_FAMILY,
                "featurePolicy": candidate.FEATURE_POLICY,
                "excludedScoreContextFeatures": list(
                    candidate.EXCLUDED_SCORE_CONTEXT_FEATURES
                ),
                "excludedFixedAcousticFeatures": list(
                    candidate.EXCLUDED_FIXED_ACOUSTIC_FEATURES
                ),
                "requiredTemporalFeatures": list(
                    candidate.REQUIRED_TEMPORAL_FEATURES
                ),
                "strictFalseAccusationDenominator": (
                    candidate.STRICT_FALSE_ACCUSATION_DENOMINATOR
                ),
                "trainingPerformed": False,
                "frozenModelLoaded": True,
                "evaluationPerformed": True,
                "datasetRows": 160,
                "denominators": valid_denominators,
                "evaluation": {
                    "featureNames": [
                        *candidate.REQUIRED_TEMPORAL_FEATURES,
                        "operationEvidence",
                    ],
                },
                "promotedGates": [],
                "modelArtifact": {
                    "sha256": MODULE.sha256_path(frozen_model),
                },
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
        original_source = stale_source.read_text(encoding="utf-8")
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
        stale_source.write_text(original_source, encoding="utf-8")

        with tempfile.TemporaryDirectory() as bad_temp:
            bad_root = Path(bad_temp)
            shutil.copytree(root, bad_root, dirs_exist_ok=True)

            def malformed_evaluate(
                _contract,
                _manifest,
                _truth,
                report,
                model,
                frozen_model,
            ):
                report.write_text("{}\n", encoding="utf-8")
                assert model == frozen_model
                return {
                    "contract": candidate.CONTRACT,
                    "modelFamily": candidate.MODEL_FAMILY,
                    "featurePolicy": candidate.FEATURE_POLICY,
                    "excludedScoreContextFeatures": list(
                        candidate.EXCLUDED_SCORE_CONTEXT_FEATURES
                    ),
                    "excludedFixedAcousticFeatures": list(
                        candidate.EXCLUDED_FIXED_ACOUSTIC_FEATURES
                    ),
                    "requiredTemporalFeatures": list(
                        candidate.REQUIRED_TEMPORAL_FEATURES
                    ),
                    "strictFalseAccusationDenominator": (
                        candidate.STRICT_FALSE_ACCUSATION_DENOMINATOR
                    ),
                    "trainingPerformed": False,
                    "frozenModelLoaded": True,
                    "modelArtifact": {
                        "sha256": MODULE.sha256_path(frozen_model),
                    },
                    "evaluationPerformed": True,
                }

            malformed = MODULE.run(
                repo_root=bad_root,
                protocol_path=bad_root / "config/protocol.json",
                module=candidate,
                intake_validator=ready_intake,
                evaluator=malformed_evaluate,
            )
            assert malformed["evaluationPerformed"] is False
            assert malformed["promotionEvidenceEligible"] is False
            assert malformed["freshBlindConsumed"] is True
            assert "round6-candidate-evidence-denominators-missing" in malformed[
                "blockingReasons"
            ]
            malformed_ledger = json.loads(
                (bad_root / protocol["paths"]["consumedLedger"]).read_text(
                    encoding="utf-8"
                )
            )
            assert malformed_ledger["status"] == "evaluation-failed"

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
