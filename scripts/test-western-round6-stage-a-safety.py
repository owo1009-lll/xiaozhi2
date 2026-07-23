from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import tempfile
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts/run_western_round6_stage_a_safety.py"
SPEC = importlib.util.spec_from_file_location("round6_stage_a_safety", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def features(value: float) -> dict[str, float]:
    return {
        name: value
        for name in MODULE.candidate.REQUIRED_TEMPORAL_FEATURES
    }


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    contract_path = root / "config/contract.json"
    manifest_path = root / "private/manifest.csv"
    truth_path = root / "private/truth.json"
    protocol_path = root / "evidence/p3.json"
    position_path = root / "experiments/position.json"
    lineage_path = root / "experiments/signoff-lineage.json"
    consumed_path = root / "experiments/safety/consumed.json"
    report_path = root / "experiments/safety/report.json"
    model_path = root / "experiments/safety/model.joblib"
    p1_path = (
        root
        / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"
    )
    contract = {
        "contractVersion": "western-round6-counterbalanced-diagnosis-v1",
        "privacy": {
            "requiredConsent": "yes",
            "requiredLicenseStatus": "local-only",
        },
    }
    write_json(contract_path, contract)

    manifest_fields = [
        "recordingId",
        "pieceId",
        "performerId",
        "deviceId",
        "roomId",
        "split",
        "audioPath",
        "scorePath",
        "consent",
        "licenseStatus",
    ]
    manifest: list[dict[str, str]] = []
    truth: dict[str, Any] = {
        "contractVersion": contract["contractVersion"],
        "recordings": {},
    }
    stage_a_ids: list[str] = []
    stage_b_ids: list[str] = []
    audio_hashes: dict[str, str] = {}
    for split in ("calibration", "fresh-blind"):
        for take in range(6):
            prefix = "cal" if split == "calibration" else "fresh"
            recording_id = f"r6-{prefix}-{take + 1}"
            audio_path = root / f"private/{recording_id}.wav"
            if split == "calibration":
                stage_a_ids.append(recording_id)
                audio_path.parent.mkdir(parents=True, exist_ok=True)
                audio_path.write_bytes(f"audio-{recording_id}".encode())
                audio_hashes[recording_id] = sha(audio_path)
            else:
                stage_b_ids.append(recording_id)
            manifest.append({
                "recordingId": recording_id,
                "pieceId": f"{prefix}-piece-{take // 3 + 1}",
                "performerId": (
                    f"cal-performer-{take % 3 + 1}"
                    if split == "calibration"
                    else f"fresh-performer-{take % 3 + 1}"
                ),
                "deviceId": f"device-{take % 3 + 1}",
                "roomId": f"{prefix}-room-{take // 3 + 1}",
                "split": split,
                "audioPath": audio_path.relative_to(root).as_posix(),
                "scorePath": f"private/{prefix}.musicxml",
                "consent": "yes" if split == "calibration" else "pending",
                "licenseStatus": (
                    "local-only"
                    if split == "calibration"
                    else "local-private-pending"
                ),
            })
            events = []
            for gate_index, gate in enumerate(MODULE.GATES):
                for role in range(3):
                    events.append({
                        "eventId": f"{gate}-{role}",
                        "gate": gate,
                        "label": (
                            "positive"
                            if role == take % 3
                            else "confusion_negative"
                        ),
                        "measure": 2 + gate_index * 3 + role,
                        "beat": 1,
                        "scoreMidi": 60 + gate_index,
                        "asPerformed": (
                            "signed"
                            if split == "calibration"
                            else ""
                        ),
                    })
            truth["recordings"][recording_id] = {
                "completeErrorInventory": split == "calibration",
                "events": events,
            }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=manifest_fields)
        writer.writeheader()
        writer.writerows(manifest)
    write_json(truth_path, truth)

    original_manifest_sha = "1" * 64
    original_truth_sha = "2" * 64
    protocol_core = {
        "contract": MODULE.P3_CONTRACT,
        "stageA": {
            "recordingIds": stage_a_ids,
            "cleanSafetyLimits": {
                "authoritativeLocalCleanFalsePositiveMax": 0,
                "consumedRound5KnownNegativeFalsePositiveMax": 0,
                "publicProfessionalBurdenPooledPer1000Max": 5.0,
                "publicProfessionalBurdenAnyRecordingPer1000Max": 10.0,
            },
        },
        "stageB": {"recordingIds": stage_b_ids},
    }
    protocol = {
        "schemaVersion": 1,
        **protocol_core,
        "sourceBindings": [
            {
                "path": contract_path.relative_to(root).as_posix(),
                "sha256": sha(contract_path),
            },
            {
                "path": manifest_path.relative_to(root).as_posix(),
                "sha256": original_manifest_sha,
            },
            {
                "path": truth_path.relative_to(root).as_posix(),
                "sha256": original_truth_sha,
            },
        ],
        "protocolSemanticSha256": hashlib.sha256(
            MODULE.canonical_json(protocol_core).encode()
        ).hexdigest(),
    }
    write_json(protocol_path, protocol)
    write_json(lineage_path, {
        "contract": MODULE.LINEAGE_CONTRACT,
        "scope": {
            "split": "calibration",
            "recordingIds": stage_a_ids,
        },
        "stagedProtocol": {
            "protocolSemanticSha256": protocol[
                "protocolSemanticSha256"
            ],
        },
        "sourceHashes": {
            "manifestSha256": original_manifest_sha,
            "truthSha256": original_truth_sha,
        },
        "appliedHashes": {
            "manifestSha256": sha(manifest_path),
            "truthSha256": sha(truth_path),
        },
        "audioSha256ByRecording": audio_hashes,
    })
    write_json(position_path, {
        "contract": "western-round5-position-balance-preflight-v2",
        "sourceHashes": {
            "manifestSha256": sha(manifest_path),
            "truthSha256": sha(truth_path),
        },
        "readyForRecording": True,
        "audioRead": False,
        "confoundedSplitGates": [],
        "rhythmReviewHint": {"confoundedSplits": []},
    })
    write_json(p1_path, {"datasets": {}})

    preflight = MODULE.validate_stage_a_inputs(
        repo=root,
        protocol_path=protocol_path,
        contract_path=contract_path,
        manifest_path=manifest_path,
        truth_path=truth_path,
        position_balance_path=position_path,
        lineage_path=lineage_path,
    )
    assert preflight["ready"] is True, preflight["blockingReasons"]
    assert preflight["counts"] == {
        "recordings": 6,
        "events": 72,
        "signedEvents": 72,
        "completeInventories": 6,
    }
    assert preflight["freshAudioRead"] is False

    dataset = []
    for gate in MODULE.GATES:
        for index in range(18):
            dataset.append({
                "gate": gate,
                "label": "positive" if index < 6 else "confusion_negative",
                "features": features(1.0 if index < 6 else 0.0),
            })
    models, feature_names = MODULE.fit_models(dataset)
    original_extractor = MODULE.candidate.base.extract_segment_features
    MODULE.candidate.base.extract_segment_features = (
        lambda take, note_index: take["featureRows"][note_index]
    )
    try:
        def prepared(recording_id: str, truth_index: int | None = None) -> dict[str, Any]:
            truth_sets = {gate: set() for gate in MODULE.GATES}
            if truth_index is not None:
                truth_sets["missing"].add(truth_index)
            return {
                "recordingId": recording_id,
                "take": {
                    "notes": [{} for _ in range(5)],
                    "featureRows": [features(0.0) for _ in range(5)],
                },
                "truth": truth_sets,
            }

        domains = {
            "authoritative-local-clean": [prepared("local")],
            "consumed-round5-known-negatives": [prepared("round5", 2)],
            "public-professional-burden": [prepared("public")],
        }

        result = MODULE.run(
            repo=root,
            protocol_path=protocol_path,
            contract_path=contract_path,
            manifest_path=manifest_path,
            truth_path=truth_path,
            position_balance_path=position_path,
            lineage_path=lineage_path,
            consumed_ledger_path=consumed_path,
            report_path=report_path,
            model_path=model_path,
            execute=True,
            build_dataset=lambda *_args, **_kwargs: dataset,
            prepare_domains=lambda **_kwargs: domains,
        )
        assert result["trainingPerformed"] is True
        assert result["cleanSafetyEvaluationPerformed"] is True
        assert result["stageAPassed"] is True
        assert result["stageBFreshRecordingAuthorized"] is True
        assert result["freshAudioRead"] is False
        assert result["safetyLimitViolations"] == []
        assert consumed_path.is_file()

        repeated = MODULE.run(
            repo=root,
            protocol_path=protocol_path,
            contract_path=contract_path,
            manifest_path=manifest_path,
            truth_path=truth_path,
            position_balance_path=position_path,
            lineage_path=lineage_path,
            consumed_ledger_path=consumed_path,
            report_path=report_path,
            model_path=model_path,
            execute=True,
            build_dataset=lambda *_args, **_kwargs: dataset,
            prepare_domains=lambda **_kwargs: domains,
        )
        assert repeated["cleanSafetyEvaluationPerformed"] is False
        assert repeated["blockingReasons"] == [
            "round6-stage-a-clean-safety-already-consumed"
        ]
    finally:
        MODULE.candidate.base.extract_segment_features = original_extractor

print("western Round-6 Stage-A safety tests passed")
