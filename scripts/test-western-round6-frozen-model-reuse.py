from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier


REPO = Path(__file__).resolve().parents[1]
SCRIPT = (
    REPO
    / "scripts/experiments/train_western_round6_full_score_candidate.py"
)
SPEC = importlib.util.spec_from_file_location("round6_frozen_candidate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    contract_path = root / "contract.json"
    manifest_path = root / "manifest.csv"
    truth_path = root / "truth.json"
    report_path = root / "report.json"
    unused_output_model = root / "must-not-be-created.joblib"
    frozen_model_path = root / "stage-a-model.joblib"
    contract_path.write_text(
        json.dumps({
            "promotion": {
                "minPrecision": 0.9,
                "minRecall": 0.5,
                "maxStrictFalseAccusations": 0,
            },
        })
        + "\n",
        encoding="utf-8",
    )
    manifest_path.write_text("recordingId\n", encoding="utf-8")
    truth_path.write_text("{}\n", encoding="utf-8")

    feature_names = list(MODULE.REQUIRED_TEMPORAL_FEATURES)
    train_x = np.asarray([
        [0.0 for _ in feature_names],
        [0.1 for _ in feature_names],
        [0.9 for _ in feature_names],
        [1.0 for _ in feature_names],
    ])
    train_y = np.asarray([0, 0, 1, 1])
    models = {}
    for gate in MODULE.GATES:
        model = RandomForestClassifier(**MODULE.MODEL_PARAMS)
        model.fit(train_x, train_y)
        models[gate] = model
    joblib.dump({
        "contract": MODULE.STAGE_A_MODEL_CONTRACT,
        "candidateContract": MODULE.CONTRACT,
        "featureNames": feature_names,
        "modelParams": MODULE.MODEL_PARAMS,
        "models": models,
        "sourceHashes": {"fixture": True},
    }, frozen_model_path)
    frozen_sha = MODULE.sha256(frozen_model_path)

    dataset = []
    for split in ("calibration", "fresh-blind"):
        for gate in MODULE.GATES:
            for index, positive in enumerate((False, True)):
                dataset.append({
                    "recordingId": f"{split}-{gate}-{index}",
                    "pieceId": f"{split}-piece",
                    "performerId": f"{split}-performer",
                    "deviceId": "device",
                    "roomId": "room",
                    "split": split,
                    "gate": gate,
                    "label": "positive" if positive else "confusion_negative",
                    "truthRole": (
                        "target-positive"
                        if positive
                        else "target-confusion-negative"
                    ),
                    "eventId": f"{gate}-{index}",
                    "noteIndex": index,
                    "features": {
                        name: 1.0 if positive else 0.0
                        for name in feature_names
                    },
                })

    original_validate = MODULE.intake.validate
    original_build_dataset = MODULE.build_dataset
    original_frozen_rules = MODULE.base.evaluate_frozen_gap_refinement
    original_train = MODULE.base.train_and_evaluate
    MODULE.REPO = root
    MODULE.intake.REPO = root
    MODULE.base.REPO = root
    MODULE.intake.validate = lambda *_args: {
        "ready": True,
        "contractVersion": "fixture",
        "hashes": {},
        "blockingReasons": [],
    }
    MODULE.build_dataset = lambda *_args, **_kwargs: dataset
    MODULE.base.evaluate_frozen_gap_refinement = lambda *_args, **_kwargs: {
        "fixture": True
    }
    MODULE.base.train_and_evaluate = lambda *_args, **_kwargs: (
        (_ for _ in ()).throw(AssertionError("fresh evaluation retrained"))
    )
    try:
        report = MODULE.run(
            contract_path,
            manifest_path,
            truth_path,
            report_path,
            unused_output_model,
            frozen_model_path=frozen_model_path,
        )
    finally:
        MODULE.intake.validate = original_validate
        MODULE.build_dataset = original_build_dataset
        MODULE.base.evaluate_frozen_gap_refinement = original_frozen_rules
        MODULE.base.train_and_evaluate = original_train

    assert report["evaluationPerformed"] is True
    assert report["trainingPerformed"] is False
    assert report["frozenModelLoaded"] is True
    assert report["modelArtifact"]["sha256"] == frozen_sha
    assert report["modelArtifact"]["path"] == "stage-a-model.joblib"
    assert report["promotedGates"] == list(MODULE.GATES)
    assert not unused_output_model.exists()
    assert MODULE.sha256(frozen_model_path) == frozen_sha

print("western Round-6 frozen model reuse tests passed")
