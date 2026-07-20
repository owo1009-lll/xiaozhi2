#!/usr/bin/env python3
"""Explicit four-layer M4b structure POC; research-only and fail-closed."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from western_m4a_registration import detect_page, read_image  # noqa: E402


POLICY_PATH = REPO / "config" / "western-m4b-structure-poc.json"
RESULT_CONTRACT = "western-m4b-explicit-structure-result-v2"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def portable_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path)


def load_policy() -> dict[str, Any]:
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


def order_quad(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    sums = points.sum(axis=1)
    differences = np.diff(points, axis=1).reshape(-1)
    return np.float32([
        points[np.argmin(sums)],
        points[np.argmin(differences)],
        points[np.argmax(sums)],
        points[np.argmax(differences)],
    ])


def estimate_and_flatten_curvature(
    rectified: np.ndarray,
    degree: int,
    maximum_pixels: float,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    gray = cv2.cvtColor(rectified, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    bright = gray > 135
    xs = np.arange(width, dtype=np.float64)
    search_height = max(30, min(height // 8, 140))
    traces = {"top": np.zeros(width, dtype=np.float64), "bottom": np.zeros(width, dtype=np.float64)}
    valid = {"top": np.zeros(width, dtype=bool), "bottom": np.zeros(width, dtype=bool)}
    for x in range(width):
        top_rows = np.flatnonzero(bright[:search_height, x])
        if top_rows.size:
            traces["top"][x] = float(top_rows[0])
            valid["top"][x] = True
        bottom_rows = np.flatnonzero(bright[height - search_height :, x])
        if bottom_rows.size:
            traces["bottom"][x] = float(height - search_height + bottom_rows[-1])
            valid["bottom"][x] = True

    candidates = []
    for edge in ("top", "bottom"):
        central = valid[edge] & (xs >= width * 0.04) & (xs <= width * 0.96)
        if central.sum() < max(20, degree + 2):
            continue
        normalized_x = (xs[central] / max(1, width - 1)) * 2.0 - 1.0
        coefficients = np.polyfit(normalized_x, traces[edge][central], degree)
        fitted = np.polyval(coefficients, (xs / max(1, width - 1)) * 2.0 - 1.0)
        edge_shift = fitted - float(np.median(fitted))
        candidates.append({
            "edge": edge,
            "shift": edge_shift,
            "residual": float(np.max(edge_shift) - np.min(edge_shift)),
            "coefficients": coefficients,
        })
    if not candidates:
        shift = np.zeros(width, dtype=np.float32)
        return rectified, shift, {"model": "none", "ready": True, "residualCurvePixels": 0.0}
    selected = max(candidates, key=lambda row: row["residual"])
    shift = selected["shift"]
    residual = selected["residual"]
    shift = np.clip(shift, -maximum_pixels, maximum_pixels).astype(np.float32)
    grid_x, grid_y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    map_y = grid_y + shift[None, :]
    flattened = cv2.remap(
        rectified,
        grid_x,
        map_y,
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    return flattened, shift, {
        "model": "page-edge-polynomial-dewarp",
        "selectedEdge": selected["edge"],
        "degree": degree,
        "ready": residual <= maximum_pixels * 2.0,
        "residualCurvePixels": round(residual, 4),
        "coefficients": [round(float(value), 8) for value in selected["coefficients"]],
        "edgeResidualCurvePixels": {
            row["edge"]: round(float(row["residual"]), 4) for row in candidates
        },
    }


def normalize_page(image: np.ndarray, policy: dict[str, Any]) -> dict[str, Any]:
    page = detect_page(image, 1.0)
    if not page["ready"] or len(page["polygonPixels"]) != 4:
        return {"ready": False, "reason": "page-normalization-failed", "pageDetection": page}
    settings = policy["normalization"]
    width, height = int(settings["rectifiedWidth"]), int(settings["rectifiedHeight"])
    source = order_quad(np.float32(page["polygonPixels"]))
    target = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    original_to_rectified = cv2.getPerspectiveTransform(source, target)
    rectified_to_original = np.linalg.inv(original_to_rectified)
    rectified = cv2.warpPerspective(image, original_to_rectified, (width, height), borderValue=(255, 255, 255))
    flattened, curve_shift, curvature = estimate_and_flatten_curvature(
        rectified,
        int(settings["curvaturePolynomialDegree"]),
        float(settings["maximumAcceptedResidualCurvePixels"]),
    )
    return {
        "ready": curvature["ready"],
        "reason": "ok" if curvature["ready"] else "curvature-normalization-review-required",
        "pageDetection": page,
        "rectified": flattened,
        "curveShift": curve_shift,
        "originalToRectified": original_to_rectified,
        "rectifiedToOriginal": rectified_to_original,
        "curvature": curvature,
        "width": width,
        "height": height,
    }


def merge_peak_rows(values: np.ndarray, scores: np.ndarray, maximum_gap: int) -> list[int]:
    groups: list[list[int]] = []
    for value in values.tolist():
        if not groups or value - groups[-1][-1] > maximum_gap:
            groups.append([int(value)])
        else:
            groups[-1].append(int(value))
    return [max(group, key=lambda row: float(scores[row])) for group in groups]


def find_staff_sequences(peaks: list[int], settings: dict[str, Any]) -> list[list[int]]:
    output = []
    index = 0
    while index <= len(peaks) - 5:
        candidate = peaks[index : index + 5]
        gaps = np.diff(candidate).astype(np.float64)
        median = float(np.median(gaps))
        coefficient = float(np.std(gaps) / median) if median > 0 else 999.0
        if (
            float(settings["minimumInterlinePixels"]) <= median <= float(settings["maximumInterlinePixels"])
            and coefficient <= float(settings["maximumInterlineCoefficientOfVariation"])
        ):
            output.append(candidate)
            index += 5
        else:
            index += 1
    return output


def merge_x_candidates(values: np.ndarray, maximum_gap: int) -> list[int]:
    groups: list[list[int]] = []
    for value in values.tolist():
        if not groups or value - groups[-1][-1] > maximum_gap:
            groups.append([int(value)])
        else:
            groups[-1].append(int(value))
    return [int(round(float(np.mean(group)))) for group in groups]


def describe_x_candidates(values: np.ndarray, scores: np.ndarray, maximum_gap: int) -> list[dict[str, Any]]:
    groups: list[list[int]] = []
    for value in values.tolist():
        if not groups or value - groups[-1][-1] > maximum_gap:
            groups.append([int(value)])
        else:
            groups[-1].append(int(value))
    return [
        {
            "x": int(round(float(np.mean(group)))),
            "strokeWidthPixels": len(group),
            "verticalInkPixels": int(max(scores[value] for value in group)),
        }
        for group in groups
    ]


def prune_close_barline_candidates(
    candidates: list[dict[str, Any]],
    minimum_distance: float,
) -> list[dict[str, Any]]:
    """Remove stem-like candidates that would create implausibly narrow measures."""
    output = [dict(row) for row in candidates]
    while len(output) >= 3:
        gaps = [float(right["x"] - left["x"]) for left, right in zip(output, output[1:])]
        short_indices = [index for index, gap in enumerate(gaps) if gap < minimum_distance]
        if not short_indices:
            break
        index = min(short_indices, key=lambda value: gaps[value])
        ordinary = [gap for gap in gaps if gap >= minimum_distance]
        typical = float(np.median(ordinary)) if ordinary else minimum_distance

        def removal_cost(remove_index: int) -> float:
            reduced = [row for row_index, row in enumerate(output) if row_index != remove_index]
            neighbor_gaps = [
                float(right["x"] - left["x"])
                for left, right in zip(reduced, reduced[1:])
            ]
            local_index = max(0, min(remove_index - 1, len(neighbor_gaps) - 1))
            spacing_cost = abs(neighbor_gaps[local_index] - typical) if neighbor_gaps else 0.0
            stroke_cost = float(output[remove_index]["strokeWidthPixels"]) * 5.0
            return spacing_cost + stroke_cost

        left_index, right_index = index, index + 1
        remove_index = min((left_index, right_index), key=removal_cost)
        output.pop(remove_index)
    return output


def polygon_from_rect(x1: float, y1: float, x2: float, y2: float) -> list[list[float]]:
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def detect_explicit_structure(normalized: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    image = normalized["rectified"]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    normal = policy["normalization"]
    settings = policy["structureVision"]
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        int(normal["adaptiveThresholdBlockSize"]),
        int(normal["adaptiveThresholdC"]),
    )
    height, width = binary.shape
    row_scores = (binary > 0).sum(axis=1)
    candidate_rows = np.flatnonzero(row_scores >= width * float(settings["minimumStaffLineInkFraction"]))
    row_peaks = merge_peak_rows(candidate_rows, row_scores, int(settings["rowPeakMergeGapPixels"]))
    sequences = find_staff_sequences(row_peaks, settings)
    horizontal_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(12, width // int(settings["horizontalKernelDivisor"])), 1),
    )
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel)
    systems = []
    staffs = []
    barlines = []
    measures = []
    for system_index, lines in enumerate(sequences):
        interline = float(np.median(np.diff(lines)))
        raw_y1 = max(0, int(np.floor(lines[0] - interline * float(settings["staffVerticalPaddingInterlines"]))))
        raw_y2 = min(height - 1, int(np.ceil(lines[-1] + interline * float(settings["staffVerticalPaddingInterlines"]))))
        horizontal_points = np.argwhere(horizontal[raw_y1 : raw_y2 + 1] > 0)
        if not horizontal_points.size:
            continue
        line_x_min = int(horizontal_points[:, 1].min())
        line_x_max = int(horizontal_points[:, 1].max())
        staff_x1 = max(0.0, line_x_min - interline * float(settings["staffLeftPaddingInterlines"]))
        staff_x2 = min(float(width - 1), float(line_x_max))
        roi = binary[raw_y1 : raw_y2 + 1]
        vertical_height = max(8, int(round(roi.shape[0] * 0.74)))
        vertical = cv2.morphologyEx(
            roi,
            cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_height)),
        )
        vertical_scores = (vertical > 0).sum(axis=0)
        raw_candidates = np.flatnonzero(
            vertical_scores >= roi.shape[0] * float(settings["barlineMinimumHeightFraction"])
        )
        x_candidates = describe_x_candidates(
            raw_candidates,
            vertical_scores,
            int(settings["barlineMergeGapPixels"]),
        )
        minimum_x = max(
            staff_x1 + (staff_x2 - staff_x1) * float(settings["barlineMinimumLeftOffsetFraction"]),
            width * float(settings["barlineMinimumPageLeftFraction"]),
        )
        maximum_x = max(
            staff_x2 + interline,
            width * float(settings["barlineMaximumPageRightFraction"]),
        )
        x_candidates = [row for row in x_candidates if minimum_x <= row["x"] <= maximum_x]
        x_candidates = prune_close_barline_candidates(
            x_candidates,
            interline * float(settings["minimumMeasureWidthInterlines"]),
        )
        if x_candidates:
            staff_x2 = max(staff_x2, float(x_candidates[-1]["x"]))
        staff = {
            "staffIndex": system_index,
            "systemIndex": system_index,
            "staffLinesNormalizedPixels": [[[staff_x1, float(y)], [staff_x2, float(y)]] for y in lines],
            "polygonNormalizedPixels": polygon_from_rect(staff_x1, raw_y1, staff_x2, raw_y2),
            "interlinePixels": round(interline, 4),
        }
        staffs.append(staff)
        system_barlines = []
        for ordinal, candidate in enumerate(x_candidates):
            x = int(candidate["x"])
            barline = {
                "systemIndex": system_index,
                "ordinal": ordinal,
                "type": "final" if system_index == len(sequences) - 1 and ordinal == len(x_candidates) - 1 else "single",
                "lineNormalizedPixels": [[float(x), float(raw_y1)], [float(x), float(raw_y2)]],
                "verticalInkPixels": int(candidate["verticalInkPixels"]),
                "strokeWidthPixels": int(candidate["strokeWidthPixels"]),
            }
            barlines.append(barline)
            system_barlines.append(barline)
        left = staff_x1
        system_measures = []
        for ordinal, barline in enumerate(system_barlines):
            right = float(barline["lineNormalizedPixels"][0][0])
            measure = {
                "systemIndex": system_index,
                "ordinal": ordinal,
                "polygonNormalizedPixels": polygon_from_rect(left, raw_y1, right, raw_y2),
                "widthInterlines": round((right - left) / max(interline, 1e-6), 4),
            }
            measures.append(measure)
            system_measures.append(measure)
            left = right
        systems.append({
            "systemIndex": system_index,
            "staffIndices": [system_index],
            "polygonNormalizedPixels": polygon_from_rect(staff_x1, raw_y1, staff_x2, raw_y2),
            "barlineCount": len(system_barlines),
            "measureCount": len(system_measures),
            "interlinePixels": round(interline, 4),
        })
    meter_regions = []
    if staffs:
        first = staffs[0]
        y1 = first["polygonNormalizedPixels"][0][1]
        y2 = first["polygonNormalizedPixels"][2][1]
        meter_regions.append({
            "systemIndex": 0,
            "proposalMethod": "normalized-page-geometry-calibration-prior",
            "contentConfirmed": False,
            "polygonNormalizedPixels": polygon_from_rect(
                width * float(settings["meterRegionPageLeftFraction"]),
                y1,
                width * float(settings["meterRegionPageRightFraction"]),
                y2,
            ),
        })
    return {
        "contract": "western-m4b-explicit-structure-evidence-v1",
        "binaryShape": [width, height],
        "rowPeakCount": len(row_peaks),
        "staffSequenceCount": len(sequences),
        "systems": systems,
        "staffs": staffs,
        "barlines": barlines,
        "measureBoxes": measures,
        "meterRegions": meter_regions,
    }


def flat_to_original(points: list[list[float]], normalized: dict[str, Any]) -> list[list[float]]:
    values = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    shift = normalized["curveShift"]
    indices = np.clip(np.round(values[:, 0]).astype(int), 0, len(shift) - 1)
    rectified = values.copy()
    rectified[:, 1] += shift[indices]
    original = cv2.perspectiveTransform(
        rectified.reshape(-1, 1, 2),
        normalized["rectifiedToOriginal"],
    ).reshape(-1, 2)
    return [[round(float(x), 3), round(float(y), 3)] for x, y in original]


def add_original_coordinates(evidence: dict[str, Any], normalized: dict[str, Any]) -> None:
    for row in evidence["systems"]:
        row["polygonPixels"] = flat_to_original(row["polygonNormalizedPixels"], normalized)
    for row in evidence["staffs"]:
        row["polygonPixels"] = flat_to_original(row["polygonNormalizedPixels"], normalized)
        row["staffLinesPixels"] = [flat_to_original(line, normalized) for line in row["staffLinesNormalizedPixels"]]
    for row in evidence["barlines"]:
        row["linePixels"] = flat_to_original(row["lineNormalizedPixels"], normalized)
    for row in evidence["measureBoxes"]:
        row["polygonPixels"] = flat_to_original(row["polygonNormalizedPixels"], normalized)
    for row in evidence["meterRegions"]:
        row["polygonPixels"] = flat_to_original(row["polygonNormalizedPixels"], normalized)


def decode_structure_graph(
    evidence: dict[str, Any],
    policy: dict[str, Any],
    content_constraints: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = policy["graphDecoder"]
    conflicts = []
    systems = evidence.get("systems", [])
    staffs = evidence.get("staffs", [])
    barlines = evidence.get("barlines", [])
    measures = evidence.get("measureBoxes", [])
    expected_staff_count = None
    if content_constraints:
        expected_staff_count = content_constraints.get("expectedStaffCount")
    recovered_staff_count = len(staffs)
    minimum_staff_recovery_rate = float(settings["minimumStaffRecoveryRate"])
    if not isinstance(expected_staff_count, int) or expected_staff_count <= 0:
        staff_recovery = {
            "verified": False,
            "ready": False,
            "reason": "expected-staff-count-missing",
            "expectedStaffCount": None,
            "recoveredStaffCount": recovered_staff_count,
            "recoveryRate": None,
            "minimumRecoveryRate": minimum_staff_recovery_rate,
        }
        conflicts.append("staff-recovery-unverified")
    else:
        recovery_rate = min(recovered_staff_count, expected_staff_count) / expected_staff_count
        recovery_ready = recovery_rate >= minimum_staff_recovery_rate
        staff_recovery = {
            "verified": True,
            "ready": recovery_ready,
            "reason": "ok" if recovery_ready else "staff-recovery-below-threshold",
            "expectedStaffCount": expected_staff_count,
            "recoveredStaffCount": recovered_staff_count,
            "recoveryRate": round(recovery_rate, 6),
            "minimumRecoveryRate": minimum_staff_recovery_rate,
        }
        if not recovery_ready:
            conflicts.append("staff-recovery-below-threshold")
    if not systems:
        conflicts.append("no-system-evidence")
    if len(staffs) != len(systems):
        conflicts.append("staff-system-cardinality-invalid")
    if any(len(row.get("staffLinesNormalizedPixels", [])) != 5 for row in staffs):
        conflicts.append("staff-line-cardinality-invalid")
    if not evidence.get("meterRegions"):
        conflicts.append("meter-region-missing")
    for system in systems:
        rows = [row for row in barlines if row["systemIndex"] == system["systemIndex"]]
        xs = [row["lineNormalizedPixels"][0][0] for row in rows]
        if not xs:
            conflicts.append(f"system-{system['systemIndex']}-barline-missing")
        if any(right <= left for left, right in zip(xs, xs[1:])):
            conflicts.append(f"system-{system['systemIndex']}-barline-order-invalid")
    minimum_width = float(policy["structureVision"]["minimumMeasureWidthInterlines"])
    if any(float(row.get("widthInterlines", 0)) < minimum_width for row in measures):
        conflicts.append("empty-or-too-narrow-measure")
    if content_constraints:
        meter_quarters = content_constraints.get("meterQuarters")
        durations = content_constraints.get("measureDurationQuarters", [])
        tolerance = float(settings["meterDurationToleranceQuarters"])
        if meter_quarters is not None and any(abs(float(value) - float(meter_quarters)) > tolerance for value in durations):
            conflicts.append("meter-measure-duration-conflict")
        if content_constraints.get("crossStaffConnectionLegal") is False:
            conflicts.append("cross-staff-connection-illegal")
    conflicts = sorted(set(conflicts))
    review_required = bool(conflicts)
    return {
        "contract": "western-m4b-structure-graph-v1",
        "decision": settings["conflictDisposition"] if review_required else settings["candidateDisposition"],
        "structureReviewRequired": review_required,
        "conflicts": conflicts,
        "graph": {
            "pageCount": 1,
            "systemCount": len(systems),
            "staffCount": len(staffs),
            "barlineCount": len(barlines),
            "measureCount": len(measures),
            "meterRegionCount": len(evidence.get("meterRegions", [])),
        },
        "staffRecovery": staff_recovery,
        "silentGuess": False,
        "reviewRequired": True,
        "studentFacing": False,
        "automaticAdoptionAuthorized": False,
    }


def shadow_content_challenger(
    graph: dict[str, Any],
    evidence: dict[str, Any],
    engine_candidates: list[dict[str, Any]],
    policy: dict[str, Any],
) -> dict[str, Any]:
    settings = policy["contentChallenger"]
    if graph["structureReviewRequired"]:
        return {
            "contract": "western-m4b-content-challenger-shadow-v1",
            "ready": False,
            "reason": "structure-review-required",
            "assignedCandidates": [],
            "consensusCandidates": [],
            "unassignableCount": len(engine_candidates),
            "shadowOnly": True,
            "productionCandidatePool": False,
            "studentFacing": False,
        }
    assigned = []
    unassignable = 0
    for candidate in engine_candidates:
        if candidate.get("x") is None or candidate.get("y") is None:
            unassignable += 1
            continue
        measure_index = None
        for index, measure in enumerate(evidence.get("measureBoxes", [])):
            polygon = np.asarray(measure["polygonPixels"], dtype=np.float32)
            if cv2.pointPolygonTest(polygon, (float(candidate["x"]), float(candidate["y"])), False) >= 0:
                measure_index = index
                break
        if measure_index is None:
            unassignable += 1
            continue
        assigned.append({**candidate, "structureMeasureIndex": measure_index})
    groups: dict[tuple[int, int], set[str]] = {}
    for row in assigned:
        key = (int(row["structureMeasureIndex"]), int(row["midi"]))
        groups.setdefault(key, set()).add(str(row["engine"]))
    consensus = [
        {"structureMeasureIndex": key[0], "midi": key[1], "engines": sorted(engines)}
        for key, engines in groups.items()
        if len(engines) >= int(settings["minimumConsensusEngines"])
    ]
    return {
        "contract": "western-m4b-content-challenger-shadow-v1",
        "ready": True,
        "reason": "shadow-candidates-prepared",
        "assignedCandidates": assigned,
        "consensusCandidates": consensus,
        "unassignableCount": unassignable,
        "minimumConsensusEngines": settings["minimumConsensusEngines"],
        "engines": settings["engines"],
        "shadowOnly": True,
        "productionCandidatePool": False,
        "studentFacing": False,
    }


def analyze_photo(
    photo_path: Path,
    *,
    content_constraints: dict[str, Any] | None = None,
    engine_candidates: list[dict[str, Any]] | None = None,
    expected_staff_count: int | None = None,
) -> dict[str, Any]:
    policy = load_policy()
    image = read_image(photo_path)
    if image is None:
        return {
            "contract": RESULT_CONTRACT,
            "ready": False,
            "reason": "structure-review-required",
            "blockingReasons": ["photo-missing-or-invalid"],
            "structureReviewRequired": True,
            "studentFacing": False,
            "automaticAdoptionAuthorized": False,
        }
    normalized = normalize_page(image, policy)
    if not normalized["ready"]:
        return {
            "contract": RESULT_CONTRACT,
            "ready": False,
            "reason": "structure-review-required",
            "blockingReasons": [normalized["reason"]],
            "normalization": {key: value for key, value in normalized.items() if key not in {"rectified", "curveShift", "originalToRectified", "rectifiedToOriginal"}},
            "structureReviewRequired": True,
            "studentFacing": False,
            "automaticAdoptionAuthorized": False,
        }
    evidence = detect_explicit_structure(normalized, policy)
    add_original_coordinates(evidence, normalized)
    constraints = dict(content_constraints or {})
    if expected_staff_count is not None:
        constraints["expectedStaffCount"] = expected_staff_count
    graph = decode_structure_graph(evidence, policy, constraints)
    challenger = shadow_content_challenger(graph, evidence, engine_candidates or [], policy)
    return {
        "contract": RESULT_CONTRACT,
        "ready": not graph["structureReviewRequired"],
        "reason": graph["decision"],
        "blockingReasons": graph["conflicts"],
        "photo": portable_path(photo_path),
        "photoSha256": sha256(photo_path),
        "normalization": {
            "ready": normalized["ready"],
            "reason": normalized["reason"],
            "pageDetection": normalized["pageDetection"],
            "curvature": normalized["curvature"],
            "rectifiedSize": [normalized["width"], normalized["height"]],
            "staffRecovery": graph["staffRecovery"],
        },
        "structureEvidence": evidence,
        "structureGraph": graph,
        "contentChallenger": challenger,
        "structureReviewRequired": graph["structureReviewRequired"],
        "silentGuess": False,
        "reviewRequired": True,
        "studentFacing": False,
        "automaticAdoptionAuthorized": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--photo", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--expected-staff-count", type=int)
    args = parser.parse_args()
    photo = Path(args.photo).resolve()
    result = analyze_photo(photo, expected_staff_count=args.expected_staff_count)
    output = Path(args.out).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ready": result["ready"], "reason": result["reason"], "output": str(output)}, ensure_ascii=False))
    return 0 if result["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
