#!/usr/bin/env python3
"""Validate the Round-5 targeted diagnosis capture intake."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[1]
DEFAULT_CONTRACT = REPO / "config/western-strings-round5-targeted-contract.json"
DEFAULT_MANIFEST = REPO / "data/private/western-strings-round5/manifest.csv"
DEFAULT_TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
DEFAULT_REPORT = REPO / "data/experiments/western-strings-round5-targeted-intake.json"
REQUIRED_MANIFEST_FIELDS = {
    "recordingId", "pieceId", "performerId", "deviceId", "roomId", "split",
    "audioPath", "scorePath", "consent", "licenseStatus",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO.resolve()).as_posix()
    except ValueError:
        return str(path.resolve()).replace("\\", "/")


def count_floor_issues(
    counts: Counter,
    gates: list[str],
    floor: int,
    prefix: str,
) -> list[str]:
    return [f"{prefix}:{gate}:{counts[gate]}/{floor}" for gate in gates if counts[gate] < floor]


def validate(contract_path: Path, manifest_path: Path, truth_path: Path) -> dict[str, Any]:
    blockers: list[str] = []
    if not contract_path.exists():
        return {
            "ready": False,
            "studentFacing": False,
            "automaticAuthorizationGranted": False,
            "hashes": {
                "contractSha256": None,
                "manifestSha256": None,
                "truthSha256": None,
            },
            "blockingReasons": ["round5-contract-missing"],
        }
    contract = read_json(contract_path)
    contract_sha256 = sha256(contract_path)
    if not manifest_path.exists():
        blockers.append("round5-manifest-missing")
    if not truth_path.exists():
        blockers.append("round5-position-truth-missing")
    if blockers:
        return {
            "contractVersion": contract["contractVersion"],
            "ready": False,
            "studentFacing": False,
            "automaticAuthorizationGranted": False,
            "blockingReasons": blockers,
            "hashes": {
                "contractSha256": contract_sha256,
                "manifestSha256": None,
                "truthSha256": None,
            },
            "paths": {"manifest": rel(manifest_path), "truth": rel(truth_path)},
        }

    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = set(reader.fieldnames or [])
        manifest_rows = list(reader)
    missing_fields = sorted(REQUIRED_MANIFEST_FIELDS - fields)
    if missing_fields:
        blockers.append(f"round5-manifest-fields-missing:{','.join(missing_fields)}")

    allowed_splits = set(contract["allowedSplits"])
    allowed_gates = list(contract["allowedGates"])
    allowed_labels = set(contract["allowedLabels"])
    privacy = contract["privacy"]
    manifest_by_id: dict[str, dict[str, str]] = {}
    for index, row in enumerate(manifest_rows, start=2):
        recording_id = str(row.get("recordingId") or "").strip()
        if not recording_id:
            blockers.append(f"round5-recording-id-missing:line-{index}")
            continue
        if recording_id in manifest_by_id:
            blockers.append(f"round5-recording-id-duplicate:{recording_id}")
            continue
        manifest_by_id[recording_id] = row
        split = str(row.get("split") or "").strip()
        if split not in allowed_splits:
            blockers.append(f"round5-split-invalid:{recording_id}:{split}")
        if str(row.get("consent") or "").strip().lower() != privacy["requiredConsent"]:
            blockers.append(f"round5-consent-invalid:{recording_id}")
        if str(row.get("licenseStatus") or "").strip() != privacy["requiredLicenseStatus"]:
            blockers.append(f"round5-license-invalid:{recording_id}")
        for field in ("audioPath", "scorePath"):
            value = str(row.get(field) or "").replace("\\", "/")
            if not value.startswith(privacy["requiredPathPrefix"]):
                blockers.append(f"round5-private-path-invalid:{recording_id}:{field}")
            elif not (REPO / value).is_file():
                blockers.append(f"round5-file-missing:{recording_id}:{field}")

    truth = read_json(truth_path)
    if truth.get("contractVersion") != contract["contractVersion"]:
        blockers.append("round5-truth-contract-mismatch")
    truth_recordings = truth.get("recordings")
    if not isinstance(truth_recordings, dict):
        truth_recordings = {}
        blockers.append("round5-truth-recordings-invalid")

    positive = Counter()
    negative = Counter()
    fresh_positive = Counter()
    fresh_negative = Counter()
    truth_event_count = 0
    for recording_id, spec in truth_recordings.items():
        manifest = manifest_by_id.get(recording_id)
        if manifest is None:
            blockers.append(f"round5-truth-recording-not-in-manifest:{recording_id}")
            continue
        events = spec.get("events") if isinstance(spec, dict) else None
        if not isinstance(events, list):
            blockers.append(f"round5-truth-events-invalid:{recording_id}")
            continue
        for event_index, event in enumerate(events):
            truth_event_count += 1
            gate = str(event.get("gate") or "")
            label = str(event.get("label") or "")
            if gate not in allowed_gates:
                blockers.append(f"round5-truth-gate-invalid:{recording_id}:{event_index}")
                continue
            if label not in allowed_labels:
                blockers.append(f"round5-truth-label-invalid:{recording_id}:{event_index}")
                continue
            for field in ("measure", "beat", "scoreMidi", "asPerformed"):
                if event.get(field) in (None, ""):
                    blockers.append(f"round5-truth-field-missing:{recording_id}:{event_index}:{field}")
            if label == "confusion_negative" and not event.get("confusionKind"):
                blockers.append(f"round5-confusion-kind-missing:{recording_id}:{event_index}")
            target = positive if label == "positive" else negative
            target[gate] += 1
            if manifest.get("split") == "fresh-blind":
                fresh_target = fresh_positive if label == "positive" else fresh_negative
                fresh_target[gate] += 1

    for recording_id in manifest_by_id:
        if recording_id not in truth_recordings:
            blockers.append(f"round5-manifest-recording-without-truth:{recording_id}")

    calibration_pieces = {
        row.get("pieceId") for row in manifest_rows if row.get("split") == "calibration"
    }
    fresh_pieces = {
        row.get("pieceId") for row in manifest_rows if row.get("split") == "fresh-blind"
    }
    for piece in sorted((calibration_pieces & fresh_pieces) - {None, ""}):
        blockers.append(f"round5-piece-split-leak:{piece}")
    calibration_contexts = {
        (row.get("performerId"), row.get("deviceId"), row.get("roomId"))
        for row in manifest_rows if row.get("split") == "calibration"
    }
    fresh_contexts = {
        (row.get("performerId"), row.get("deviceId"), row.get("roomId"))
        for row in manifest_rows if row.get("split") == "fresh-blind"
    }
    for performer, device, room in sorted(calibration_contexts & fresh_contexts):
        blockers.append(f"round5-context-split-leak:{performer}:{device}:{room}")

    minimums = contract["minimums"]
    performers = {row.get("performerId") for row in manifest_rows if row.get("performerId")}
    devices = {row.get("deviceId") for row in manifest_rows if row.get("deviceId")}
    rooms = {row.get("roomId") for row in manifest_rows if row.get("roomId")}
    if len(performers) < minimums["performers"]:
        blockers.append(f"round5-performers-below-floor:{len(performers)}/{minimums['performers']}")
    if len(devices) < minimums["devices"]:
        blockers.append(f"round5-devices-below-floor:{len(devices)}/{minimums['devices']}")
    if len(rooms) < minimums["rooms"]:
        blockers.append(f"round5-rooms-below-floor:{len(rooms)}/{minimums['rooms']}")
    blockers.extend(count_floor_issues(positive, allowed_gates, minimums["positivePerGate"], "round5-positive-below-floor"))
    blockers.extend(count_floor_issues(fresh_positive, allowed_gates, minimums["freshBlindPositivePerGate"], "round5-fresh-positive-below-floor"))
    blockers.extend(count_floor_issues(negative, allowed_gates, minimums["confusionNegativePerGate"], "round5-negative-below-floor"))
    blockers.extend(count_floor_issues(fresh_negative, allowed_gates, minimums["freshBlindConfusionNegativePerGate"], "round5-fresh-negative-below-floor"))

    return {
        "contractVersion": contract["contractVersion"],
        "ready": len(blockers) == 0,
        "studentFacing": False,
        "automaticAuthorizationGranted": False,
        "counts": {
            "recordings": len(manifest_by_id),
            "truthEvents": truth_event_count,
            "performers": len(performers),
            "devices": len(devices),
            "rooms": len(rooms),
            "positiveByGate": dict(positive),
            "confusionNegativeByGate": dict(negative),
            "freshBlindPositiveByGate": dict(fresh_positive),
            "freshBlindConfusionNegativeByGate": dict(fresh_negative),
        },
        "minimums": minimums,
        "hashes": {
            "contractSha256": contract_sha256,
            "manifestSha256": sha256(manifest_path),
            "truthSha256": sha256(truth_path),
        },
        "paths": {"manifest": rel(manifest_path), "truth": rel(truth_path)},
        "blockingReasons": blockers,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--truth", type=Path, default=DEFAULT_TRUTH)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    report = validate(args.contract, args.manifest, args.truth)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if args.require_ready and not report["ready"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
