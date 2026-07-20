#!/usr/bin/env python3
"""Evaluate the M4b explicit-structure POC on the frozen synthetic-test split."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

from western_m4b_structure_poc import POLICY_PATH, analyze_photo, load_policy, read_image  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def polygon_iou(left: list[list[float]], right: list[list[float]]) -> float:
    left_polygon = cv2.convexHull(np.asarray(left, dtype=np.float32))
    right_polygon = cv2.convexHull(np.asarray(right, dtype=np.float32))
    left_area = float(cv2.contourArea(left_polygon))
    right_area = float(cv2.contourArea(right_polygon))
    intersection, _ = cv2.intersectConvexConvex(left_polygon, right_polygon)
    union = left_area + right_area - float(intersection)
    return float(intersection) / union if union > 0 else 0.0


def match_polygons(
    predicted: list[dict[str, Any]],
    gold: list[dict[str, Any]],
    threshold: float,
) -> dict[str, Any]:
    candidates = []
    for predicted_index, prediction in enumerate(predicted):
        for gold_index, target in enumerate(gold):
            if prediction.get("systemIndex") != target.get("systemIndex"):
                continue
            score = polygon_iou(prediction["polygonPixels"], target["polygon"])
            if score >= threshold:
                candidates.append((score, predicted_index, gold_index))
    matched_predicted: set[int] = set()
    matched_gold: set[int] = set()
    matches = []
    for score, predicted_index, gold_index in sorted(candidates, reverse=True):
        if predicted_index in matched_predicted or gold_index in matched_gold:
            continue
        matched_predicted.add(predicted_index)
        matched_gold.add(gold_index)
        matches.append({
            "predictedIndex": predicted_index,
            "goldIndex": gold_index,
            "iou": round(score, 6),
        })
    return {
        "truePositive": len(matches),
        "falsePositive": len(predicted) - len(matches),
        "falseNegative": len(gold) - len(matches),
        "matches": matches,
    }


def summarize_counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    true_positive = sum(int(row["truePositive"]) for row in rows)
    false_positive = sum(int(row["falsePositive"]) for row in rows)
    false_negative = sum(int(row["falseNegative"]) for row in rows)
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 0.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 0.0
    f1 = 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
    }


def exact_structure(result: dict[str, Any], gold: dict[str, Any]) -> bool:
    evidence = result.get("structureEvidence", {})
    predicted_systems = evidence.get("systems", [])
    gold_systems = gold["labels"]["systems"]
    if len(predicted_systems) != len(gold_systems):
        return False
    for system_index in range(len(gold_systems)):
        predicted_count = sum(
            1 for row in evidence.get("measureBoxes", []) if row["systemIndex"] == system_index
        )
        gold_count = sum(
            1 for row in gold["labels"]["measureBoxes"] if row["systemIndex"] == system_index
        )
        if predicted_count != gold_count:
            return False
    return True


def draw_polygon(image: np.ndarray, points: list[list[float]], color: tuple[int, int, int], thickness: int) -> None:
    polygon = np.rint(np.asarray(points, dtype=np.float32)).astype(np.int32).reshape(-1, 1, 2)
    cv2.polylines(image, [polygon], True, color, thickness, cv2.LINE_AA)


def render_overlay(photo: Path, result: dict[str, Any], gold: dict[str, Any], output: Path) -> None:
    image = read_image(photo)
    if image is None:
        return
    for row in gold["labels"]["measureBoxes"]:
        draw_polygon(image, row["polygon"], (255, 96, 32), 2)
    for row in result.get("structureEvidence", {}).get("measureBoxes", []):
        draw_polygon(image, row["polygonPixels"], (32, 220, 32), 2)
    for row in gold["labels"]["meterRegions"]:
        draw_polygon(image, row["polygon"], (255, 0, 255), 3)
    for row in result.get("structureEvidence", {}).get("meterRegions", []):
        draw_polygon(image, row["polygonPixels"], (0, 255, 255), 2)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tofile(str(output))


def evaluate(output_root: Path) -> dict[str, Any]:
    policy = load_policy()
    manifest_path = REPO / "data" / "experiments" / "western-strings-m4b" / "dataset" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    split = str(policy["evaluation"]["split"])
    rows = [row for row in manifest["syntheticRows"] if row["split"] == split]
    threshold = float(policy["evaluation"]["boxIouThreshold"])
    decision_path = REPO / policy["evaluation"]["promotionDecision"]
    decision = json.loads(decision_path.read_text(encoding="utf-8"))
    output_root.mkdir(parents=True, exist_ok=True)

    case_audits = []
    measure_matches = []
    meter_matches = []
    exact_count = 0
    for row in rows:
        photo = REPO / row["image"]["path"]
        gold_path = REPO / row["label"]["path"]
        gold = json.loads(gold_path.read_text(encoding="utf-8"))
        expected_staff_count = len(gold["labels"]["staffs"])
        result = analyze_photo(photo, expected_staff_count=expected_staff_count)
        evidence = result.get("structureEvidence", {})
        measures = match_polygons(evidence.get("measureBoxes", []), gold["labels"]["measureBoxes"], threshold)
        meters = match_polygons(evidence.get("meterRegions", []), gold["labels"]["meterRegions"], threshold)
        is_exact = exact_structure(result, gold)
        exact_count += int(is_exact)
        measure_matches.append(measures)
        meter_matches.append(meters)
        overlay_path = output_root / "cases" / row["caseId"] / "overlay.jpg"
        result_path = output_root / "cases" / row["caseId"] / "result.json"
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        render_overlay(photo, result, gold, overlay_path)
        case_audits.append({
            "caseId": row["caseId"],
            "pieceId": row["pieceId"],
            "split": row["split"],
            "result": str(result_path.relative_to(REPO)).replace("\\", "/"),
            "resultSha256": sha256(result_path),
            "overlay": str(overlay_path.relative_to(REPO)).replace("\\", "/"),
            "overlaySha256": sha256(overlay_path),
            "measureBoxes": measures,
            "meterRegions": meters,
            "exactPageStructure": is_exact,
            "structureReviewRequired": bool(result.get("structureReviewRequired", True)),
        })

    injection_target = int(policy["evaluation"]["conflictInjectionCount"])
    injected_audits = []
    for row in rows[:injection_target]:
        result = analyze_photo(
            REPO / row["image"]["path"],
            content_constraints={"meterQuarters": 4.0, "measureDurationQuarters": [3.0]},
            expected_staff_count=len(json.loads((REPO / row["label"]["path"]).read_text(encoding="utf-8"))["labels"]["staffs"]),
        )
        caught = (
            result.get("reason") == policy["graphDecoder"]["conflictDisposition"]
            and "meter-measure-duration-conflict" in result.get("blockingReasons", [])
            and result.get("structureReviewRequired") is True
            and result.get("automaticAdoptionAuthorized") is False
        )
        injected_audits.append({"caseId": row["caseId"], "caught": caught})

    measure_summary = summarize_counts(measure_matches)
    meter_summary = summarize_counts(meter_matches)
    exact_rate = exact_count / len(rows) if rows else 0.0
    caught_count = sum(int(row["caught"]) for row in injected_audits)
    conflict_rate = caught_count / injection_target if injection_target else 0.0
    thresholds = decision["thresholds"]
    synthetic_threshold_comparison = {
        "measureBoxF1": {
            "value": measure_summary["f1"],
            "threshold": thresholds["measureBoxF1"],
            "passes": measure_summary["f1"] >= float(thresholds["measureBoxF1"]),
        },
        "exactPageStructureRate": {
            "value": round(exact_rate, 6),
            "threshold": thresholds["exactPageStructureRate"],
            "passes": exact_rate >= float(thresholds["exactPageStructureRate"]),
        },
        "structureConflictReviewRequiredRate": {
            "value": round(conflict_rate, 6),
            "threshold": thresholds["structureConflictReviewRequiredRate"],
            "passes": conflict_rate >= float(thresholds["structureConflictReviewRequiredRate"]),
        },
        "meterRegionF1": {
            "value": meter_summary["f1"],
            "threshold": thresholds["meterRegionF1"],
            "passes": meter_summary["f1"] >= float(thresholds["meterRegionF1"]),
        },
    }
    engineering_ready = (
        len(rows) == 12
        and len(injected_audits) == injection_target
        and conflict_rate == 1.0
        and all(not row["structureReviewRequired"] for row in case_audits)
    )
    return {
        "contract": "western-m4b-explicit-structure-poc-evaluation-v1",
        "complete": True,
        "engineeringReady": engineering_ready,
        "promotionReady": False,
        "promotionReason": "synthetic-engineering-evidence-is-not-fresh-blind-evidence",
        "evidenceClass": "synthetic-engineering-only",
        "split": split,
        "caseCount": len(rows),
        "metrics": {
            "measureBoxes": measure_summary,
            "exactPageStructure": {"passed": exact_count, "total": len(rows), "rate": round(exact_rate, 6)},
            "meterRegions": meter_summary,
            "structureConflictReviewRequired": {
                "caught": caught_count,
                "total": injection_target,
                "rate": round(conflict_rate, 6),
            },
        },
        "syntheticThresholdComparison": synthetic_threshold_comparison,
        "promotionBoundary": {
            "signedDecision": str(decision_path.relative_to(REPO)).replace("\\", "/"),
            "signedDecisionSha256": sha256(decision_path),
            "thresholdsFrozenBeforeEvaluation": True,
            "freshBlindRequired": True,
            "automaticAdoptionAuthorized": False,
            "studentFacing": False,
        },
        "provenance": {
            "policy": str(POLICY_PATH.relative_to(REPO)).replace("\\", "/"),
            "policySha256": sha256(POLICY_PATH),
            "manifest": str(manifest_path.relative_to(REPO)).replace("\\", "/"),
            "manifestSha256": sha256(manifest_path),
            "evaluator": str(Path(__file__).resolve().relative_to(REPO)).replace("\\", "/"),
            "evaluatorSha256": sha256(Path(__file__).resolve()),
        },
        "conflictInjections": injected_audits,
        "cases": case_audits,
        "blockingReasons": ["m4b-fresh-blind-promotion-evaluation-not-ready"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="data/experiments/western-strings-m4b/structure-poc/report.json")
    args = parser.parse_args()
    output = (REPO / args.out).resolve()
    report = evaluate(output.parent)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "engineeringReady": report["engineeringReady"],
        "promotionReady": report["promotionReady"],
        "metrics": report["metrics"],
        "output": str(output),
    }, ensure_ascii=False))
    return 0 if report["engineeringReady"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
