#!/usr/bin/env python3
"""Tests for the Round-5 targeted diagnosis intake contract."""
from __future__ import annotations

import csv
import importlib.util
import json
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "status_western_round5_targeted_intake.py"
SPEC = importlib.util.spec_from_file_location("round5_intake", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        MODULE.REPO = root
        contract_path = root / "contract.json"
        manifest_path = root / "data/private/western-strings-round5/manifest.csv"
        truth_path = root / "data/private/western-strings-round5/position-truth.json"
        contract = {
            "contractVersion": "test-round5-v1",
            "allowedSplits": ["calibration", "fresh-blind"],
            "allowedGates": ["merged_substitution", "missing", "extra", "drag"],
            "allowedLabels": ["positive", "confusion_negative"],
            "minimums": {
                "performers": 1,
                "devices": 1,
                "rooms": 1,
                "positivePerGate": 1,
                "freshBlindPositivePerGate": 1,
                "confusionNegativePerGate": 1,
                "freshBlindConfusionNegativePerGate": 1,
            },
            "privacy": {
                "requiredConsent": "yes",
                "requiredLicenseStatus": "local-only",
                "requiredPathPrefix": "data/private/western-strings-round5/",
            },
        }
        write_json(contract_path, contract)
        missing = MODULE.validate(contract_path, manifest_path, truth_path)
        assert missing["ready"] is False
        assert "round5-manifest-missing" in missing["blockingReasons"]
        assert missing["hashes"]["contractSha256"] == MODULE.sha256(contract_path)
        assert missing["hashes"]["manifestSha256"] is None
        assert missing["hashes"]["truthSha256"] is None

        private = manifest_path.parent
        private.mkdir(parents=True, exist_ok=True)
        (private / "take.wav").write_bytes(b"audio")
        (private / "score.musicxml").write_text("<score-partwise/>", encoding="utf-8")
        with manifest_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=sorted(MODULE.REQUIRED_MANIFEST_FIELDS))
            writer.writeheader()
            writer.writerow({
                "recordingId": "r5-test",
                "pieceId": "piece-fresh",
                "performerId": "performer-1",
                "deviceId": "device-1",
                "roomId": "room-1",
                "split": "fresh-blind",
                "audioPath": "data/private/western-strings-round5/take.wav",
                "scorePath": "data/private/western-strings-round5/score.musicxml",
                "consent": "yes",
                "licenseStatus": "local-only",
            })
        events = []
        for gate in contract["allowedGates"]:
            for label in contract["allowedLabels"]:
                event = {
                    "gate": gate,
                    "label": label,
                    "measure": 1,
                    "beat": 1,
                    "scoreMidi": 69,
                    "asPerformed": "test",
                }
                if label == "confusion_negative":
                    event["confusionKind"] = "clean-control"
                events.append(event)
        write_json(truth_path, {
            "contractVersion": contract["contractVersion"],
            "recordings": {"r5-test": {"events": events}},
        })
        ready = MODULE.validate(contract_path, manifest_path, truth_path)
        assert ready["ready"] is True, ready["blockingReasons"]
        assert ready["studentFacing"] is False
        assert ready["automaticAuthorizationGranted"] is False
        assert ready["hashes"]["contractSha256"] == MODULE.sha256(contract_path)
        assert ready["hashes"]["manifestSha256"] == MODULE.sha256(manifest_path)
        assert ready["hashes"]["truthSha256"] == MODULE.sha256(truth_path)
    print("western Round-5 targeted intake tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
