#!/usr/bin/env python3
"""Evaluate M4b POC promotion only on the frozen fresh-blind intake."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_m4b_structure_poc import match_polygons, sha256, summarize_counts  # noqa: E402
from western_m4b_structure_poc import analyze_photo, load_policy  # noqa: E402


def relative(path: Path) -> str:
    return str(path.resolve().relative_to(REPO)).replace("\\", "/")


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_inside(relative_path: str) -> Path | None:
    if not relative_path or Path(relative_path).is_absolute():
        return None
    target = (REPO / relative_path).resolve()
    return target if REPO in target.parents else None


def exact_structure(result: dict[str, Any], labels: dict[str, Any]) -> bool:
    evidence = result.get("structureEvidence", {})
    systems = evidence.get("systems", [])
    gold_systems = labels.get("systems", [])
    if len(systems) != len(gold_systems):
        return False
    for system_index in range(len(gold_systems)):
        predicted = sum(
            1 for row in evidence.get("measureBoxes", []) if row.get("systemIndex") == system_index
        )
        expected = sum(
            1 for row in labels.get("measureBoxes", []) if row.get("systemIndex") == system_index
        )
        if predicted != expected:
            return False
    return True


def blocked_report(
    *,
    policy_path: Path,
    dataset_policy_path: Path,
    decision_path: Path,
    intake_path: Path,
    decision: dict[str, Any],
    blockers: list[str],
    counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    return {
        "contract": "western-m4b-fresh-blind-promotion-evaluation-v1",
        "complete": True,
        "operationalReady": True,
        "promotionReady": False,
        "evidenceClass": "fresh-blind-test-only",
        "counts": counts or {"rows": 0, "validRows": 0, "piecesOrLayouts": 0, "devices": 0},
        "metrics": None,
        "thresholds": decision.get("thresholds", {}),
        "freshBlindMinimums": decision.get("freshBlindMinimums", {}),
        "blockingReasons": sorted(set(blockers)),
        "provenance": {
            "structurePolicy": relative(policy_path),
            "structurePolicySha256": sha256(policy_path),
            "datasetPolicy": relative(dataset_policy_path),
            "datasetPolicySha256": sha256(dataset_policy_path),
            "signedDecision": relative(decision_path),
            "signedDecisionSha256": sha256(decision_path),
            "intake": relative(intake_path),
            "intakePresent": intake_path.exists(),
            "evaluator": relative(Path(__file__)),
            "evaluatorSha256": sha256(Path(__file__)),
        },
        "boundary": {
            "expandedInvestmentOnly": True,
            "automaticAdoptionAuthorized": False,
            "studentFacing": False,
            "freshBlindTrainingEligible": False,
        },
    }


def evaluate() -> dict[str, Any]:
    policy_path = REPO / "config" / "western-m4b-structure-poc.json"
    dataset_policy_path = REPO / "config" / "western-m4b-dataset.json"
    policy = load_policy()
    dataset_policy = load_json(dataset_policy_path)
    decision_path = REPO / policy["evaluation"]["promotionDecision"]
    decision = load_json(decision_path)
    intake_path = REPO / dataset_policy["freshBlind"]["intakeManifest"]
    if not intake_path.exists():
        return blocked_report(
            policy_path=policy_path,
            dataset_policy_path=dataset_policy_path,
            decision_path=decision_path,
            intake_path=intake_path,
            decision=decision,
            blockers=["m4b-fresh-blind-intake-missing"],
        )

    try:
        intake = load_json(intake_path)
    except Exception:
        return blocked_report(
            policy_path=policy_path,
            dataset_policy_path=dataset_policy_path,
            decision_path=decision_path,
            intake_path=intake_path,
            decision=decision,
            blockers=["m4b-fresh-blind-intake-invalid"],
        )
    blockers = []
    rows = intake.get("rows", []) if intake.get("contract") == "western-m4b-fresh-blind-intake-v1" else []
    if not rows and intake.get("contract") != "western-m4b-fresh-blind-intake-v1":
        blockers.append("m4b-fresh-blind-intake-contract-mismatch")
    if len({row.get("caseId") for row in rows}) != len(rows):
        blockers.append("m4b-fresh-blind-duplicate-case-id")

    attestation = intake.get("captureAttestation", {})
    if (
        attestation.get("contract") != "western-m4b-fresh-blind-capture-attestation-v1"
        or attestation.get("noReplacementAllowed") is not True
        or attestation.get("trainingEligible") is not False
        or not attestation.get("confirmations")
        or not all(value is True for value in attestation.get("confirmations", {}).values())
    ):
        blockers.append("m4b-fresh-blind-capture-attestation-invalid")
    attested_artifacts = [
        ("capturePolicy", "capturePolicySha256", "m4b-fresh-capture-policy"),
        ("captureMetadata", "captureMetadataSha256", "m4b-fresh-capture-metadata"),
        ("thresholdDecision", "thresholdDecisionSha256", "m4b-fresh-threshold-decision"),
    ]
    capture_policy: dict[str, Any] = {}
    capture_metadata: dict[str, Any] = {}
    for path_key, hash_key, label in attested_artifacts:
        artifact = resolve_inside(str(attestation.get(path_key) or ""))
        if artifact is None or not artifact.is_file() or file_hash(artifact) != attestation.get(hash_key):
            blockers.append(f"{label}-binding-invalid")
            continue
        if path_key == "captureMetadata":
            try:
                capture_metadata = load_json(artifact)
            except Exception:
                blockers.append("m4b-fresh-capture-metadata-invalid")
        if path_key == "capturePolicy":
            try:
                capture_policy = load_json(artifact)
            except Exception:
                blockers.append("m4b-fresh-capture-policy-invalid")
    if resolve_inside(str(attestation.get("thresholdDecision") or "")) != decision_path.resolve():
        blockers.append("m4b-fresh-threshold-decision-path-mismatch")
    if (
        capture_policy.get("contract") != "western-m4b-fresh-blind-capture-policy-v1"
        or capture_policy.get("minimumValidPhotos") != decision["freshBlindMinimums"]["pages"]
        or capture_policy.get("minimumLayouts") != decision["freshBlindMinimums"]["piecesOrLayouts"]
        or capture_policy.get("minimumDevices") != decision["freshBlindMinimums"]["devices"]
    ):
        blockers.append("m4b-fresh-capture-policy-minimum-drift")
    if (
        capture_metadata.get("contract") != "western-m4b-fresh-blind-capture-metadata-v1"
        or capture_metadata.get("captureBatchId") != attestation.get("captureBatchId")
    ):
        blockers.append("m4b-fresh-capture-metadata-contract-mismatch")
    for field in capture_policy.get("requiredMetadataConfirmations", []):
        if capture_metadata.get(field) is not True or attestation.get("confirmations", {}).get(field) is not True:
            blockers.append(f"m4b-fresh-capture-confirmation-invalid:{field}")
    metadata_layouts = capture_metadata.get("layouts", [])
    metadata_devices = capture_metadata.get("devices", [])
    metadata_layout_ids = {row.get("pieceOrLayoutId") for row in metadata_layouts if row.get("pieceOrLayoutId")}
    metadata_device_ids = {row.get("deviceId") for row in metadata_devices if row.get("deviceId")}
    metadata_fingerprints = {row.get("sourceFingerprintSha256") for row in metadata_layouts if row.get("sourceFingerprintSha256")}
    if (
        len(metadata_layout_ids) != len(capture_policy.get("layoutSlots", []))
        or len(metadata_fingerprints) != len(capture_policy.get("layoutSlots", []))
        or len(metadata_device_ids) != len(capture_policy.get("deviceSlots", []))
    ):
        blockers.append("m4b-fresh-capture-distinct-layout-or-device-proof-invalid")

    manifest_path = REPO / dataset_policy["outputRoot"] / "manifest.json"
    manifest = load_json(manifest_path)
    protected_hashes = {
        value
        for row in [
            *manifest.get("syntheticRows", []),
            *manifest.get("frozenSourceGoldRows", []),
            *manifest.get("frozenScreenPhotoRows", []),
        ]
        for value in [row.get("photoSha256") or row.get("image", {}).get("sha256")]
        if value
    }
    valid_rows = []
    required = dataset_policy["realAnnotation"]["requiredLabels"]
    for row in rows:
        case_id = str(row.get("caseId") or "unknown")
        photo = (REPO / str(row.get("photoPath") or "")).resolve()
        label_path = (REPO / str(row.get("labelPath") or "")).resolve()
        if REPO not in photo.parents or REPO not in label_path.parents or not photo.is_file() or not label_path.is_file():
            blockers.append(f"m4b-fresh-blind-artifact-missing-or-invalid:{case_id}")
            continue
        try:
            label = load_json(label_path)
        except Exception:
            blockers.append(f"m4b-fresh-blind-artifact-missing-or-invalid:{case_id}")
            continue
        photo_sha256 = file_hash(photo)
        labels = label.get("labels", {})
        binding_ready = (
            row.get("trainingEligible") is False
            and row.get("role") == "fresh-blind-test-only"
            and label.get("contract") == "western-m4b-real-structure-label-v1"
            and label.get("caseId") == row.get("caseId")
            and label.get("photoSha256") == photo_sha256
            and label.get("pieceOrLayoutId") == row.get("pieceOrLayoutId")
            and label.get("deviceId") == row.get("deviceId")
            and label.get("captureBatchId") == row.get("captureBatchId")
            and row.get("pieceOrLayoutId") in metadata_layout_ids
            and row.get("deviceId") in metadata_device_ids
            and row.get("captureBatchId") == attestation.get("captureBatchId")
            and labels.get("judgeable") is True
            and all(name in labels for name in required)
        )
        if not binding_ready:
            blockers.append(f"m4b-fresh-blind-label-binding-invalid:{case_id}")
            continue
        if photo_sha256 in protected_hashes:
            blockers.append(f"m4b-fresh-blind-reuses-protected-photo:{case_id}")
            continue
        valid_rows.append({"row": row, "photo": photo, "labelPath": label_path, "label": label})

    pieces = {item["row"]["pieceOrLayoutId"] for item in valid_rows}
    devices = {item["row"]["deviceId"] for item in valid_rows}
    counts = {
        "rows": len(rows),
        "validRows": len(valid_rows),
        "piecesOrLayouts": len(pieces),
        "devices": len(devices),
    }
    minimums = decision["freshBlindMinimums"]
    if counts["validRows"] < int(minimums["pages"]):
        blockers.append(f"m4b-fresh-blind-photo-count-below-{minimums['pages']}")
    if counts["piecesOrLayouts"] < int(minimums["piecesOrLayouts"]):
        blockers.append(f"m4b-fresh-blind-layout-count-below-{minimums['piecesOrLayouts']}")
    if counts["devices"] < int(minimums["devices"]):
        blockers.append(f"m4b-fresh-blind-device-count-below-{minimums['devices']}")
    if blockers:
        return blocked_report(
            policy_path=policy_path,
            dataset_policy_path=dataset_policy_path,
            decision_path=decision_path,
            intake_path=intake_path,
            decision=decision,
            blockers=blockers,
            counts=counts,
        )

    iou_threshold = float(policy["evaluation"]["boxIouThreshold"])
    measure_rows = []
    meter_rows = []
    exact_count = 0
    case_audits = []
    for item in valid_rows:
        labels = item["label"]["labels"]
        result = analyze_photo(item["photo"], expected_staff_count=len(labels["staffs"]))
        evidence = result.get("structureEvidence", {})
        measure = match_polygons(evidence.get("measureBoxes", []), labels["measureBoxes"], iou_threshold)
        meter = match_polygons(evidence.get("meterRegions", []), labels["meterRegions"], iou_threshold)
        exact = exact_structure(result, labels)
        exact_count += int(exact)
        measure_rows.append(measure)
        meter_rows.append(meter)
        case_audits.append({
            "caseId": item["row"]["caseId"],
            "photoSha256": file_hash(item["photo"]),
            "labelSha256": file_hash(item["labelPath"]),
            "measureBoxes": measure,
            "meterRegions": meter,
            "exactPageStructure": exact,
            "structureReviewRequired": result.get("structureReviewRequired", True),
            "automaticAdoptionAuthorized": False,
            "studentFacing": False,
        })

    injection_count = min(int(policy["evaluation"]["conflictInjectionCount"]), len(valid_rows))
    conflicts = []
    for item in valid_rows[:injection_count]:
        result = analyze_photo(
            item["photo"],
            content_constraints={"meterQuarters": 4.0, "measureDurationQuarters": [3.0]},
            expected_staff_count=len(item["label"]["labels"]["staffs"]),
        )
        caught = (
            result.get("reason") == policy["graphDecoder"]["conflictDisposition"]
            and "meter-measure-duration-conflict" in result.get("blockingReasons", [])
            and result.get("structureReviewRequired") is True
            and result.get("automaticAdoptionAuthorized") is False
        )
        conflicts.append({"caseId": item["row"]["caseId"], "caught": caught})

    measure = summarize_counts(measure_rows)
    meter = summarize_counts(meter_rows)
    exact_rate = exact_count / len(valid_rows)
    conflict_rate = sum(int(row["caught"]) for row in conflicts) / injection_count if injection_count else 0.0
    metrics = {
        "measureBoxF1": measure["f1"],
        "exactPageStructureRate": round(exact_rate, 6),
        "structureConflictReviewRequiredRate": round(conflict_rate, 6),
        "meterRegionF1": meter["f1"],
    }
    thresholds = decision["thresholds"]
    comparison = {
        name: {"value": metrics[name], "threshold": value, "passes": metrics[name] >= float(value)}
        for name, value in thresholds.items()
    }
    promotion_ready = (
        decision.get("approved") is True
        and decision.get("confirmNoRetroactiveThresholdTuning") is True
        and all(row["passes"] for row in comparison.values())
    )
    if not promotion_ready:
        blockers.append("m4b-fresh-blind-promotion-threshold-not-met")
    return {
        "contract": "western-m4b-fresh-blind-promotion-evaluation-v1",
        "complete": True,
        "operationalReady": True,
        "promotionReady": promotion_ready,
        "evidenceClass": "fresh-blind-test-only",
        "counts": counts,
        "metrics": metrics,
        "metricDetails": {
            "measureBoxes": measure,
            "exactPageStructure": {"passed": exact_count, "total": len(valid_rows), "rate": round(exact_rate, 6)},
            "meterRegions": meter,
            "structureConflictReviewRequired": {
                "caught": sum(int(row["caught"]) for row in conflicts),
                "total": injection_count,
                "rate": round(conflict_rate, 6),
            },
        },
        "thresholds": thresholds,
        "freshBlindMinimums": minimums,
        "thresholdComparison": comparison,
        "blockingReasons": sorted(set(blockers)),
        "provenance": {
            "structurePolicy": relative(policy_path),
            "structurePolicySha256": sha256(policy_path),
            "datasetPolicy": relative(dataset_policy_path),
            "datasetPolicySha256": sha256(dataset_policy_path),
            "datasetManifest": relative(manifest_path),
            "datasetManifestSha256": sha256(manifest_path),
            "signedDecision": relative(decision_path),
            "signedDecisionSha256": sha256(decision_path),
            "intake": relative(intake_path),
            "intakeSha256": sha256(intake_path),
            "evaluator": relative(Path(__file__)),
            "evaluatorSha256": sha256(Path(__file__)),
        },
        "boundary": {
            "expandedInvestmentOnly": True,
            "automaticAdoptionAuthorized": False,
            "studentFacing": False,
            "freshBlindTrainingEligible": False,
        },
        "conflictInjections": conflicts,
        "cases": case_audits,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default="data/experiments/western-strings-m4b/structure-poc/fresh-blind-promotion-report.json",
    )
    args = parser.parse_args()
    output = (REPO / args.out).resolve()
    report = evaluate()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "operationalReady": report["operationalReady"],
        "promotionReady": report["promotionReady"],
        "counts": report["counts"],
        "blockingReasons": report["blockingReasons"],
        "output": str(output),
    }, ensure_ascii=False))
    return 0 if report["promotionReady"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
