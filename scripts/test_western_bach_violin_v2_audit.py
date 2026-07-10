from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/audit_western_bach_violin_v2.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_v2_audit", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinV2AuditTest(unittest.TestCase):
    def test_v2_can_pass_while_v3_and_near_perfect_remain_closed(self) -> None:
        dataset = {
            "readyForEvalBenchmark": True,
            "counts": {
                "readyForEvalBenchmarkRows": 65,
                "developmentReferencePerformerRows": 31,
                "holdoutUnseenPerformerRows": 34,
                "referenceNotes": 58000,
            },
        }
        alignment = {
            "externalControlledPilotReady": True,
            "holdout": {"precisionWithin300msAmongPredictions": 0.93, "coverage": 0.95},
        }
        recognition = {
            "recognitionV2AlphaReady": True,
            "eventFilterCalibration": {"holdout": {"precision": 0.91, "recall": 0.77}},
        }
        perturbation = {
            "publicEventPerturbationGateReady": True,
            "rawAudioStudentErrorGateReady": False,
            "holdout": {
                "clean": {"precisionWithin300ms": 0.96, "coverage": 0.44},
                "unsafeTargetAutoPassCount": 0,
            },
        }
        raw_audio = {
            "rawAudioCoreErrorGateReady": True,
            "rawAudioStudentErrorGateReady": False,
            "strictPolicy": {
                "eligibleTargetCount": 42,
                "coreUnsafeTargetAutoPassCount": 0,
                "clean": {"precisionWithin300ms": 0.97, "coverage": 0.33},
            },
        }
        weak_note = {
            "weakNotePublicRawAudioGateReady": False,
            "weakNoteStudentErrorGateReady": False,
        }
        report = MODULE.build_audit(
            dataset,
            alignment,
            recognition,
            perturbation,
            raw_audio,
            weak_note,
        )
        self.assertTrue(report["gates"]["publicProfessionalV2AlphaReady"])
        self.assertTrue(report["gates"]["publicEventV3PrototypeReady"])
        self.assertTrue(report["gates"]["publicRawAudioCorePrototypeReady"])
        self.assertFalse(report["gates"]["publicWeakNotePrototypeReady"])
        self.assertFalse(report["gates"]["rawAudioV3Ready"])
        self.assertFalse(report["gates"]["v3Ready"])
        self.assertFalse(report["gates"]["nearPerfectReady"])
        self.assertFalse(report["gates"]["defaultStudentReleaseEligible"])

    def test_v2_fails_closed_when_alignment_precision_drops(self) -> None:
        dataset = {
            "readyForEvalBenchmark": True,
            "counts": {
                "readyForEvalBenchmarkRows": 65,
                "developmentReferencePerformerRows": 31,
                "holdoutUnseenPerformerRows": 34,
            },
        }
        alignment = {
            "externalControlledPilotReady": True,
            "holdout": {"precisionWithin300msAmongPredictions": 0.89, "coverage": 0.95},
        }
        recognition = {
            "recognitionV2AlphaReady": True,
            "eventFilterCalibration": {"holdout": {"precision": 0.91, "recall": 0.77}},
        }
        report = MODULE.build_audit(dataset, alignment, recognition, {})
        self.assertFalse(report["gates"]["publicProfessionalV2AlphaReady"])


if __name__ == "__main__":
    unittest.main()
