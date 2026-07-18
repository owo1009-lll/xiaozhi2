#!/usr/bin/env python3
"""M4a supported-edition photo registration and review-only feedback projection."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[1]
CONFIG_PATH = REPO / "config" / "western-m4a-registration.json"
REGISTRY_PATH = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4a"
    / "supported-editions"
    / "registry.json"
)
RESULT_CONTRACT = "western-m4a-supported-edition-registration-v1"
REGISTRY_CONTRACT = "western-m4a-supported-edition-registry-v1"
AUDIO_EVIDENCE_CONTRACT = "western-m4a-audio-sentinel-evidence-v1"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_image(path: Path) -> np.ndarray | None:
    try:
        return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    except (OSError, ValueError):
        return None


def write_image(path: Path, image: np.ndarray, quality: int = 91) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower()
    parameters = [cv2.IMWRITE_JPEG_QUALITY, quality] if suffix in {".jpg", ".jpeg"} else []
    ok, encoded = cv2.imencode(suffix, image, parameters)
    if not ok:
        raise RuntimeError(f"could not encode image: {path}")
    encoded.tofile(path)


def load_policy(repo_root: Path = REPO) -> dict[str, Any]:
    value = json.loads((repo_root / "config/western-m4a-registration.json").read_text(encoding="utf-8"))
    if value.get("contract") != "western-m4a-registration-policy-v1":
        raise RuntimeError("M4a registration policy contract mismatch")
    if value.get("policy") != {
        "studentFacing": False,
        "automaticAdoptionAuthorized": False,
        "reviewRequired": True,
        "omrAllowedInMainChain": False,
    }:
        raise RuntimeError("M4a registration safety policy drift")
    if float(value.get("audioSentinel", {}).get("minimumAgreement", -1)) != 0.6:
        raise RuntimeError("M4a audio sentinel threshold drift")
    return value


def safe_registry_artifact(registry_root: Path, relative_path: str) -> Path:
    candidate = (registry_root / relative_path).resolve()
    try:
        candidate.relative_to(registry_root.resolve())
    except ValueError as error:
        raise RuntimeError("M4a registry artifact path escape") from error
    if not candidate.is_file():
        raise RuntimeError(f"M4a registry artifact missing: {relative_path}")
    return candidate


def load_registry_entry(
    piece_id: str,
    edition_id: str,
    repo_root: Path = REPO,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    registry_path = repo_root / REGISTRY_PATH.relative_to(REPO)
    registry_bytes = registry_path.read_bytes()
    registry = json.loads(registry_bytes.decode("utf-8"))
    if registry.get("contract") != REGISTRY_CONTRACT:
        raise RuntimeError("M4a supported-edition registry contract mismatch")
    entries = [
        row
        for row in registry.get("entries", [])
        if row.get("pieceId") == piece_id and row.get("editionId") == edition_id
    ]
    if not entries:
        return None, {"path": registry_path, "sha256": sha256_bytes(registry_bytes), "registry": registry}
    if len(entries) != 1:
        raise RuntimeError("M4a supported-edition registry duplicate entry")
    entry = entries[0]
    registry_root = registry_path.parent
    for kind, path_field, hash_field in [
        ("MusicXML", "musicxmlPath", "musicxmlSha256"),
        ("render", "renderPath", "renderSha256"),
        ("coordinate sidecar", "coordinateSidecarPath", "coordinateSidecarSha256"),
    ]:
        artifact = safe_registry_artifact(registry_root, str(entry.get(path_field, "")))
        if sha256_bytes(artifact.read_bytes()) != entry.get(hash_field):
            raise RuntimeError(f"M4a registry {kind} hash mismatch")
    if not all(str(entry.get(field, "")).strip() for field in ["confirmedBy", "confirmedAt", "confirmationMethod"]):
        raise RuntimeError("M4a registry human confirmation missing")
    if entry.get("licenseStatus") not in {"self-authored", "public-domain", "local-only"}:
        raise RuntimeError("M4a registry license not approved")
    return entry, {"path": registry_path, "sha256": sha256_bytes(registry_bytes), "registry": registry}


def evaluate_audio_sentinel(audio_evidence: dict[str, Any] | None) -> dict[str, Any]:
    policy = load_policy()
    threshold = float(policy["audioSentinel"]["minimumAgreement"])
    if not audio_evidence or audio_evidence.get("contract") != AUDIO_EVIDENCE_CONTRACT:
        return {
            "ready": False,
            "reason": policy["audioSentinel"]["missingEvidenceDisposition"],
            "minimumAgreement": threshold,
            "agreement": None,
        }
    agreement = audio_evidence.get("agreement")
    if not isinstance(agreement, (int, float)) or not math.isfinite(float(agreement)):
        return {
            "ready": False,
            "reason": policy["audioSentinel"]["missingEvidenceDisposition"],
            "minimumAgreement": threshold,
            "agreement": None,
        }
    ready = float(agreement) >= threshold
    return {
        "ready": ready,
        "reason": "ok" if ready else policy["audioSentinel"]["mismatchDisposition"],
        "minimumAgreement": threshold,
        "agreement": round(float(agreement), 6),
        "confirmed": int(audio_evidence.get("confirmed", 0)),
        "eventCount": int(audio_evidence.get("eventCount", 0)),
        "source": str(audio_evidence.get("source", "")),
    }


def resize_for_work(image: np.ndarray, maximum_dimension: int) -> tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    scale = min(1.0, maximum_dimension / max(width, height))
    if scale == 1:
        return image, scale
    return cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA), scale


def detect_page(image: np.ndarray, scale_to_original: float) -> dict[str, Any]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    threshold, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (21, 21))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return {"ready": False, "reason": "page-region-not-found", "polygonPixels": [], "coverage": 0.0}
    contour = max(contours, key=cv2.contourArea)
    area = float(cv2.contourArea(contour))
    coverage = area / float(image.shape[0] * image.shape[1])
    perimeter = cv2.arcLength(contour, True)
    polygon = cv2.approxPolyDP(contour, 0.02 * perimeter, True).reshape(-1, 2)
    if len(polygon) != 4:
        polygon = cv2.boxPoints(cv2.minAreaRect(contour))
    polygon_original = np.round(polygon / scale_to_original, 2).tolist()
    return {
        "ready": coverage >= 0.12,
        "reason": "ok" if coverage >= 0.12 else "page-region-too-small",
        "threshold": round(float(threshold), 3),
        "coverage": round(coverage, 6),
        "polygonPixels": polygon_original,
    }


def tps_kernel(distances_squared: np.ndarray) -> np.ndarray:
    return distances_squared * np.log(distances_squared + 1e-12)


def fit_tps_residual(
    source_points: np.ndarray,
    residuals: np.ndarray,
    regularization: float,
) -> dict[str, np.ndarray]:
    source = np.asarray(source_points, dtype=np.float64)
    values = np.asarray(residuals, dtype=np.float64)
    if source.ndim != 2 or source.shape[1] != 2 or source.shape != values.shape or len(source) < 3:
        raise ValueError("TPS source/residual controls must be matching Nx2 arrays")
    minimum = source.min(axis=0)
    span = np.maximum(source.max(axis=0) - minimum, 1e-9)
    normalized = (source - minimum) / span
    differences = normalized[:, None, :] - normalized[None, :, :]
    kernel = tps_kernel(np.sum(differences * differences, axis=2))
    affine = np.column_stack((np.ones(len(source)), normalized))
    system = np.block(
        [
            [kernel + np.eye(len(source)) * regularization, affine],
            [affine.T, np.zeros((3, 3))],
        ]
    )
    target = np.vstack((values, np.zeros((3, 2))))
    solution = np.linalg.solve(system, target)
    return {
        "controls": normalized,
        "minimum": minimum,
        "span": span,
        "weights": solution[: len(source)],
        "affine": solution[len(source) :],
    }


def apply_tps_residual(model: dict[str, np.ndarray], points: np.ndarray) -> np.ndarray:
    values = np.asarray(points, dtype=np.float64)
    normalized = (values - model["minimum"]) / model["span"]
    differences = normalized[:, None, :] - model["controls"][None, :, :]
    kernel = tps_kernel(np.sum(differences * differences, axis=2))
    affine = np.column_stack((np.ones(len(values)), normalized))
    return kernel @ model["weights"] + affine @ model["affine"]


def perspective_points(points: np.ndarray, transform: np.ndarray) -> np.ndarray:
    return cv2.perspectiveTransform(np.asarray(points, dtype=np.float64).reshape(-1, 1, 2), transform).reshape(-1, 2)


def grid_coverage(points: np.ndarray, width: int, height: int, cells: int = 4) -> float:
    if not len(points):
        return 0.0
    x = np.clip((points[:, 0] / max(width, 1) * cells).astype(int), 0, cells - 1)
    y = np.clip((points[:, 1] / max(height, 1) * cells).astype(int), 0, cells - 1)
    return len(set(zip(x.tolist(), y.tolist()))) / float(cells * cells)


def build_tps_if_helpful(
    reference_points: np.ndarray,
    query_points: np.ndarray,
    homography: np.ndarray,
    query_shape: tuple[int, int],
    policy: dict[str, Any],
    coverage: float,
) -> tuple[dict[str, np.ndarray] | None, dict[str, Any]]:
    deformation = policy["deformation"]
    predicted = perspective_points(reference_points, homography)
    residuals = query_points - predicted
    diagonal = math.hypot(query_shape[1], query_shape[0])
    baseline = np.linalg.norm(residuals, axis=1) / max(diagonal, 1)
    summary = {
        "model": "homography",
        "eligible": False,
        "activated": False,
        "baselineResidualP90Normalized": round(float(np.quantile(baseline, 0.9)), 8),
        "validationResidualImprovement": 0.0,
    }
    if len(reference_points) < int(deformation["minimumTpsInliers"]) or coverage < float(deformation["minimumTpsGridCoverage"]):
        return None, summary
    if summary["baselineResidualP90Normalized"] < float(deformation["activationResidualNormalized"]):
        return None, summary
    indices = np.linspace(
        0,
        len(reference_points) - 1,
        min(len(reference_points), int(deformation["maximumControlPoints"])),
        dtype=int,
    )
    refs = reference_points[indices]
    residual_values = residuals[indices]
    validation_mask = np.arange(len(refs)) % 5 == 0
    if validation_mask.sum() < 3 or (~validation_mask).sum() < 6:
        return None, summary
    try:
        validation_model = fit_tps_residual(
            refs[~validation_mask],
            residual_values[~validation_mask],
            float(deformation["regularization"]),
        )
        correction = apply_tps_residual(validation_model, refs[validation_mask])
    except (ValueError, np.linalg.LinAlgError):
        return None, summary
    before = np.mean(np.linalg.norm(residual_values[validation_mask], axis=1))
    after = np.mean(np.linalg.norm(residual_values[validation_mask] - correction, axis=1))
    improvement = float((before - after) / max(before, 1e-9))
    summary["eligible"] = True
    summary["validationResidualImprovement"] = round(improvement, 6)
    if improvement < float(deformation["minimumResidualImprovement"]):
        return None, summary
    try:
        model = fit_tps_residual(refs, residual_values, float(deformation["regularization"]))
    except np.linalg.LinAlgError:
        return None, summary
    summary["model"] = "homography+tps"
    summary["activated"] = True
    summary["controlPointCount"] = len(refs)
    return model, summary


def structural_residual(reference_gray: np.ndarray, rectified_gray: np.ndarray, sidecar: dict[str, Any]) -> float:
    reference_edges = cv2.Canny(reference_gray, 60, 160)
    query_edges = cv2.Canny(rectified_gray, 60, 160)
    mask = np.zeros_like(reference_edges)
    for system in sidecar["systems"]:
        x1, y1, x2, y2 = system["bboxPixels"]
        padding = max(12, (y2 - y1) * 2)
        cv2.rectangle(mask, (max(0, x1 - 10), max(0, y1 - padding)), (min(mask.shape[1] - 1, x2 + 10), min(mask.shape[0] - 1, y2 + padding)), 255, -1)
    reference_points = (reference_edges > 0) & (mask > 0)
    query_points = (query_edges > 0) & (mask > 0)
    if reference_points.sum() < 50 or query_points.sum() < 50:
        return 1.0
    distance = cv2.distanceTransform((query_edges == 0).astype(np.uint8), cv2.DIST_L2, 3)
    mean_distance = float(np.mean(np.minimum(distance[reference_points], 24.0)))
    return mean_distance / math.hypot(reference_gray.shape[1], reference_gray.shape[0])


def barline_consistency(rectified_gray: np.ndarray, sidecar: dict[str, Any]) -> tuple[float, list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    for system in sidecar["systems"]:
        system_index = system["systemIndex"]
        measures = [row for row in sidecar["measures"] if row["systemIndex"] == system_index]
        hits = 0
        responses = []
        for measure in measures:
            x = int(measure["bboxPixels"][2])
            y1, y2 = int(measure["bboxPixels"][1]), int(measure["bboxPixels"][3])
            left, right = max(0, x - 8), min(rectified_gray.shape[1], x + 9)
            top, bottom = max(0, y1 - 3), min(rectified_gray.shape[0], y2 + 3)
            patch = cv2.GaussianBlur(rectified_gray[top:bottom, left:right], (3, 3), 0)
            if patch.size:
                threshold, dark = cv2.threshold(patch, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
                fractions = np.mean(dark > 0, axis=0)
                response = float(np.max(fractions))
                contrast = response - float(np.median(fractions))
            else:
                threshold, response, contrast = 0.0, 0.0, 0.0
            hit = response >= 0.3 and contrast >= 0.12
            responses.append({
                "measureIndex": measure["globalMeasureIndex"],
                "response": round(response, 6),
                "contrast": round(contrast, 6),
                "threshold": round(float(threshold), 3),
                "hit": hit,
            })
            if hit:
                hits += 1
        ratio = hits / len(measures) if measures else 0.0
        rows.append({
            "systemIndex": system_index,
            "hits": hits,
            "expected": len(measures),
            "ratio": round(ratio, 6),
            "responses": responses,
        })
    total_expected = sum(row["expected"] for row in rows)
    total_hits = sum(row["hits"] for row in rows)
    return (total_hits / total_expected if total_expected else 0.0), rows


def project_box(
    box: list[int],
    homography: np.ndarray,
    tps_model: dict[str, np.ndarray] | None,
    photo_width: int,
    photo_height: int,
) -> dict[str, Any]:
    x1, y1, x2, y2 = box
    reference_points = np.float64(
        [
            [x1, y1],
            [(x1 + x2) / 2, y1],
            [x2, y1],
            [x2, (y1 + y2) / 2],
            [x2, y2],
            [(x1 + x2) / 2, y2],
            [x1, y2],
            [x1, (y1 + y2) / 2],
        ]
    )
    projected = perspective_points(reference_points, homography)
    if tps_model is not None:
        projected += apply_tps_residual(tps_model, reference_points)
    polygon = [[round(float(x), 2), round(float(y), 2)] for x, y in projected]
    minimum = projected.min(axis=0)
    maximum = projected.max(axis=0)
    bbox = [
        max(0, min(photo_width - 1, math.floor(minimum[0]))),
        max(0, min(photo_height - 1, math.floor(minimum[1]))),
        max(1, min(photo_width, math.ceil(maximum[0]))),
        max(1, min(photo_height, math.ceil(maximum[1]))),
    ]
    return {"polygonPixels": polygon, "bboxPixels": bbox}


def project_sidecar(
    sidecar: dict[str, Any],
    homography: np.ndarray,
    tps_model: dict[str, np.ndarray] | None,
    photo_shape: tuple[int, int],
) -> dict[str, list[dict[str, Any]]]:
    height, width = photo_shape
    output: dict[str, list[dict[str, Any]]] = {}
    for name in ["systems", "staves", "measures", "notes"]:
        output[name] = []
        for row in sidecar[name]:
            identity = {key: value for key, value in row.items() if key not in {"bboxPixels", "bboxNormalized"}}
            output[name].append({**identity, **project_box(row["bboxPixels"], homography, tps_model, width, height)})
    return output


def registration_quality(
    reference: np.ndarray,
    photo: np.ndarray,
    sidecar: dict[str, Any],
    policy: dict[str, Any],
) -> tuple[dict[str, Any], np.ndarray | None, dict[str, np.ndarray] | None]:
    settings = policy["registration"]
    maximum = int(settings["maxWorkingDimension"])
    reference_work, reference_scale = resize_for_work(reference, maximum)
    photo_work, photo_scale = resize_for_work(photo, maximum)
    reference_gray = cv2.cvtColor(reference_work, cv2.COLOR_BGR2GRAY)
    photo_gray = cv2.cvtColor(photo_work, cv2.COLOR_BGR2GRAY)
    page = detect_page(photo_work, photo_scale)
    blur_variance = float(cv2.Laplacian(photo_gray, cv2.CV_64F).var())
    checks = {
        "imageDimensions": photo.shape[1] >= int(settings["minimumImageWidth"]) and photo.shape[0] >= int(settings["minimumImageHeight"]),
        "pageDetection": page["ready"],
        "blur": blur_variance >= float(settings["minimumLaplacianVariance"]),
    }
    sift = cv2.SIFT_create(nfeatures=7000, contrastThreshold=0.02, edgeThreshold=12)
    reference_keypoints, reference_descriptors = sift.detectAndCompute(reference_gray, None)
    photo_keypoints, photo_descriptors = sift.detectAndCompute(photo_gray, None)
    if reference_descriptors is None or photo_descriptors is None:
        return {
            "ready": False,
            "checks": checks,
            "pageDetection": page,
            "laplacianVariance": round(blur_variance, 6),
            "goodMatchCount": 0,
            "inlierCount": 0,
            "inlierRatio": 0.0,
            "referenceGridCoverage": 0.0,
            "systemConsistency": 0.0,
            "barlineConsistency": 0.0,
            "structuralResidualNormalized": 1.0,
            "deformation": {"model": "none", "activated": False},
        }, None, None
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    matches = matcher.knnMatch(reference_descriptors, photo_descriptors, k=2)
    reverse_matches = matcher.knnMatch(photo_descriptors, reference_descriptors, k=2)
    ratio_threshold = float(settings["ratioTest"])
    reverse_good = {
        first.queryIdx: first.trainIdx
        for first, second in reverse_matches
        if first.distance < ratio_threshold * second.distance
    }
    forward_good = [
        first
        for first, second in matches
        if first.distance < ratio_threshold * second.distance
    ]
    mutual_good_count = sum(
        1 for row in forward_good if reverse_good.get(row.trainIdx) == row.queryIdx
    )
    good = forward_good
    checks["goodMatches"] = len(good) >= int(settings["minimumGoodMatches"])
    if len(good) < 4:
        return {
            "ready": False,
            "checks": checks,
            "pageDetection": page,
            "laplacianVariance": round(blur_variance, 6),
            "goodMatchCount": len(good),
            "inlierCount": 0,
            "inlierRatio": 0.0,
            "referenceGridCoverage": 0.0,
            "systemConsistency": 0.0,
            "barlineConsistency": 0.0,
            "structuralResidualNormalized": 1.0,
            "deformation": {"model": "none", "activated": False},
        }, None, None
    reference_points_work = np.float64([reference_keypoints[row.queryIdx].pt for row in good])
    photo_points_work = np.float64([photo_keypoints[row.trainIdx].pt for row in good])
    homography_work, inlier_mask = cv2.findHomography(
        reference_points_work,
        photo_points_work,
        cv2.RANSAC,
        float(settings["ransacReprojectionPixels"]),
        maxIters=5000,
        confidence=0.999,
    )
    if homography_work is None or inlier_mask is None:
        checks.update({"inliers": False, "inlierRatio": False})
        return {
            "ready": False,
            "checks": checks,
            "pageDetection": page,
            "laplacianVariance": round(blur_variance, 6),
            "goodMatchCount": len(good),
            "inlierCount": 0,
            "inlierRatio": 0.0,
            "referenceGridCoverage": 0.0,
            "systemConsistency": 0.0,
            "barlineConsistency": 0.0,
            "structuralResidualNormalized": 1.0,
            "deformation": {"model": "none", "activated": False},
        }, None, None
    inliers = inlier_mask.ravel().astype(bool)
    inlier_count = int(inliers.sum())
    ratio = inlier_count / len(good)
    reference_points = reference_points_work[inliers] / reference_scale
    photo_points = photo_points_work[inliers] / photo_scale
    transform_reference_scale = np.diag([reference_scale, reference_scale, 1.0])
    transform_photo_inverse = np.diag([1 / photo_scale, 1 / photo_scale, 1.0])
    homography = transform_photo_inverse @ homography_work @ transform_reference_scale
    homography /= homography[2, 2]
    coverage = grid_coverage(reference_points, reference.shape[1], reference.shape[0])

    system_rows = []
    for system in sidecar["systems"]:
        x1, y1, x2, y2 = system["bboxPixels"]
        padding = max(18, (y2 - y1) * 2.5)
        count = int(
            np.sum(
                (reference_points[:, 0] >= x1 - 20)
                & (reference_points[:, 0] <= x2 + 20)
                & (reference_points[:, 1] >= y1 - padding)
                & (reference_points[:, 1] <= y2 + padding)
            )
        )
        system_rows.append({"systemIndex": system["systemIndex"], "inlierCount": count, "consistent": count >= 3})
    system_consistency = sum(row["consistent"] for row in system_rows) / len(system_rows) if system_rows else 0.0

    tps_model, deformation = build_tps_if_helpful(
        reference_points,
        photo_points,
        homography,
        photo.shape[:2],
        policy,
        coverage,
    )
    try:
        photo_to_reference = np.linalg.inv(homography)
        rectified = cv2.warpPerspective(photo, photo_to_reference, (reference.shape[1], reference.shape[0]), flags=cv2.INTER_LINEAR)
        rectified_gray = cv2.cvtColor(rectified, cv2.COLOR_BGR2GRAY)
        reference_full_gray = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
        residual = structural_residual(reference_full_gray, rectified_gray, sidecar)
        barline, barline_rows = barline_consistency(rectified_gray, sidecar)
    except (cv2.error, np.linalg.LinAlgError):
        residual, barline, barline_rows = 1.0, 0.0, []
    checks.update(
        {
            "inliers": inlier_count >= int(settings["minimumInliers"]),
            "inlierRatio": ratio >= float(settings["minimumInlierRatio"]),
            "referenceGridCoverage": coverage >= float(settings["minimumReferenceGridCoverage"]),
            "systemConsistency": system_consistency >= float(settings["minimumSystemConsistency"]),
            "barlineConsistency": (
                barline >= float(settings["minimumBarlineConsistency"])
                and bool(barline_rows)
                and min(row["ratio"] for row in barline_rows) >= float(settings["minimumPerSystemBarlineConsistency"])
            ),
            "structuralResidual": residual <= float(settings["maximumStructuralResidualNormalized"]),
        }
    )
    ready = all(checks.values())
    return {
        "ready": ready,
        "checks": checks,
        "pageDetection": page,
        "laplacianVariance": round(blur_variance, 6),
        "referenceKeypoints": len(reference_keypoints),
        "photoKeypoints": len(photo_keypoints),
        "goodMatchCount": len(good),
        "mutualGoodMatchCount": mutual_good_count,
        "inlierCount": inlier_count,
        "inlierRatio": round(ratio, 6),
        "referenceGridCoverage": round(coverage, 6),
        "systemConsistency": round(system_consistency, 6),
        "systemRows": system_rows,
        "barlineConsistency": round(barline, 6),
        "barlineRows": barline_rows,
        "structuralResidualNormalized": round(residual, 8),
        "deformation": deformation,
        "referenceToPhotoHomography": np.round(homography, 10).tolist(),
        "photoToReferenceHomography": np.round(np.linalg.inv(homography), 10).tolist(),
    }, homography, tps_model


def fail_closed_result(reason: str, photo_path: Path, piece_id: str, edition_id: str) -> dict[str, Any]:
    return {
        "contract": RESULT_CONTRACT,
        "ready": False,
        "reason": reason,
        "blockingReasons": [reason],
        "pieceId": piece_id,
        "editionId": edition_id,
        "photo": str(photo_path),
        "omrUsed": False,
        "machineFeedbackPrepared": False,
        "reviewRequired": True,
        "studentFacing": False,
        "automaticAdoptionAuthorized": False,
        "autoDiagnosisIssued": False,
    }


def register_supported_edition(
    *,
    piece_id: str,
    edition_id: str,
    photo_path: Path,
    audio_evidence: dict[str, Any] | None,
    repo_root: Path = REPO,
) -> dict[str, Any]:
    photo_path = Path(photo_path).resolve()
    try:
        policy = load_policy(repo_root)
        entry, registry_context = load_registry_entry(piece_id, edition_id, repo_root)
    except (OSError, ValueError, json.JSONDecodeError, RuntimeError) as error:
        result = fail_closed_result("supported-edition-registry-integrity-failed", photo_path, piece_id, edition_id)
        result["detail"] = str(error)
        return result
    if entry is None:
        return fail_closed_result("supported-edition-not-in-library", photo_path, piece_id, edition_id)
    photo = read_image(photo_path)
    if photo is None:
        return fail_closed_result("supported-edition-registration-review-required", photo_path, piece_id, edition_id)
    registry_root = registry_context["path"].parent
    reference_path = safe_registry_artifact(registry_root, entry["renderPath"])
    sidecar_path = safe_registry_artifact(registry_root, entry["coordinateSidecarPath"])
    reference = read_image(reference_path)
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    if reference is None:
        return fail_closed_result("supported-edition-registry-integrity-failed", photo_path, piece_id, edition_id)
    quality, homography, tps_model = registration_quality(reference, photo, sidecar, policy)
    audio_sentinel = evaluate_audio_sentinel(audio_evidence)
    blocking_reasons = []
    if not quality["ready"] or homography is None:
        blocking_reasons.append("supported-edition-registration-review-required")
    if not audio_sentinel["ready"]:
        blocking_reasons.append(audio_sentinel["reason"])
    projected = (
        project_sidecar(sidecar, homography, tps_model, photo.shape[:2])
        if homography is not None and quality["ready"]
        else {"systems": [], "staves": [], "measures": [], "notes": []}
    )
    ready = not blocking_reasons
    reason = "supported-edition-registration-ready" if ready else blocking_reasons[0]
    return {
        "contract": RESULT_CONTRACT,
        "ready": ready,
        "reason": reason,
        "blockingReasons": blocking_reasons,
        "pieceId": piece_id,
        "editionId": edition_id,
        "photo": str(photo_path),
        "photoSha256": sha256_bytes(photo_path.read_bytes()),
        "registry": {
            "source": registry_context["path"].relative_to(repo_root).as_posix(),
            "sha256": registry_context["sha256"],
            "entryTriplet": {
                "musicxmlSha256": entry["musicxmlSha256"],
                "renderSha256": entry["renderSha256"],
                "coordinateSidecarSha256": entry["coordinateSidecarSha256"],
            },
        },
        "registrationQuality": quality,
        "audioSentinel": audio_sentinel,
        "projectedCoordinates": projected,
        "deformationModel": quality.get("deformation", {}).get("model", "none"),
        "omrUsed": False,
        "machineFeedbackPrepared": ready,
        "reviewRequired": True,
        "studentFacing": False,
        "automaticAdoptionAuthorized": False,
        "autoDiagnosisIssued": False,
    }


def build_audio_evidence(score_path: Path, audio_path: Path) -> dict[str, Any]:
    experiments = REPO / "scripts" / "experiments"
    sys.path.insert(0, str(experiments))
    import proto_western_strings_score_anchored_feedback as anchor  # type: ignore

    events = anchor.mxl_events(score_path)
    audio_events = anchor.audio_events(audio_path)
    verdicts, matches, predicted_times, agreement, piece_gate = anchor.compute_verdicts(
        events,
        audio_events,
        [False] * len(events),
    )
    per_note = []
    pitched_note_cursor = 0
    for index, event in enumerate(events):
        match = matches[index]
        pitched_note_count = max(1, len(event["midis"]))
        pitched_note_indices = list(range(pitched_note_cursor, pitched_note_cursor + pitched_note_count))
        pitched_note_cursor += pitched_note_count
        per_note.append(
            {
                "eventIndex": index,
                "measure": event["measure"],
                "scoreMidis": event["midis"],
                "xmlPitchedNoteIndices": pitched_note_indices,
                "verdict": verdicts[index],
                "audioMidis": audio_events[match]["midis"] if match is not None else None,
                "timingDeviationSeconds": (
                    round(audio_events[match]["start"] - predicted_times[index], 4)
                    if match is not None and predicted_times is not None
                    else None
                ),
            }
        )
    return {
        "contract": AUDIO_EVIDENCE_CONTRACT,
        "agreement": float(agreement),
        "confirmed": verdicts.count("confirmed"),
        "eventCount": len(events),
        "audioEventCount": len(audio_events),
        "pieceGate": piece_gate,
        "source": "registered-musicxml-plus-basic-pitch-score-anchored-verdicts",
        "verdictCounts": {label: verdicts.count(label) for label in anchor.COLORS},
        "perNote": per_note,
    }


def attach_feedback_and_annotation(
    result: dict[str, Any],
    audio_evidence: dict[str, Any],
    photo_path: Path,
    annotated_path: Path,
) -> None:
    if not result["ready"]:
        result["feedback"] = None
        return
    image = read_image(photo_path)
    if image is None:
        raise RuntimeError("photo disappeared after registration")
    projected_notes = result["projectedCoordinates"]["notes"]
    events = audio_evidence.get("perNote", [])
    notes_by_xml_index = {int(note["xmlPitchedNoteIndex"]): note for note in projected_notes}
    palette = {
        "confirmed": (67, 160, 46),
        "pitch-mismatch": (38, 38, 220),
        "no-audio-evidence": (150, 150, 150),
        "beyond-recording": (150, 150, 150),
        "anchor-uncertain": (0, 165, 255),
    }
    projected_feedback = []
    fallback_cursor = 0
    mapped_indices: list[int] = []
    for event in events:
        count = max(1, len(event.get("scoreMidis", [])))
        raw_indices = event.get("xmlPitchedNoteIndices")
        if raw_indices is None:
            raw_indices = list(range(fallback_cursor, fallback_cursor + count))
        indices = [int(value) for value in raw_indices]
        fallback_cursor = max(fallback_cursor + count, (max(indices) + 1) if indices else fallback_cursor)
        anchors = [notes_by_xml_index[index] for index in indices if index in notes_by_xml_index]
        mapped_indices.extend(indices)
        projected_feedback.append({**event, "xmlPitchedNoteIndices": indices, "projectedNoteAnchors": anchors})

    expected_indices = sorted(notes_by_xml_index)
    projection_ready = (
        bool(projected_feedback)
        and sorted(mapped_indices) == expected_indices
        and all(
            len(row["projectedNoteAnchors"]) == len(row["xmlPitchedNoteIndices"])
            for row in projected_feedback
        )
    )
    if not projection_ready:
        reason = "supported-edition-registration-review-required"
        if reason not in result["blockingReasons"]:
            result["blockingReasons"].append(reason)
        result["ready"] = False
        result["reason"] = reason
        result["machineFeedbackPrepared"] = False
        result["feedback"] = {
            "annotationStyle": "registered-photo-pixel-polygons",
            "reviewOnly": True,
            "projectionReady": False,
            "expectedAnchorCount": len(expected_indices),
            "mappedAnchorCount": sum(len(row["projectedNoteAnchors"]) for row in projected_feedback),
            "perNote": projected_feedback,
            "verdictCounts": audio_evidence.get("verdictCounts", {}),
            "annotatedPhoto": None,
            "annotatedPhotoSha256": None,
        }
        result["autoDiagnosisIssued"] = False
        return

    for event in projected_feedback:
        for anchor_row in event["projectedNoteAnchors"]:
            polygon = np.int32(np.round(anchor_row["polygonPixels"])).reshape(-1, 1, 2)
            cv2.polylines(image, [polygon], True, palette.get(event["verdict"], (150, 150, 150)), 3, cv2.LINE_AA)
    write_image(annotated_path, image)
    result["feedback"] = {
        "annotationStyle": "registered-photo-pixel-polygons",
        "reviewOnly": True,
        "projectionReady": True,
        "expectedAnchorCount": len(expected_indices),
        "mappedAnchorCount": len(mapped_indices),
        "perNote": projected_feedback,
        "verdictCounts": audio_evidence.get("verdictCounts", {}),
        "annotatedPhoto": str(annotated_path),
        "annotatedPhotoSha256": sha256_bytes(annotated_path.read_bytes()),
    }
    result["autoDiagnosisIssued"] = False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--piece-id", required=True)
    parser.add_argument("--edition-id", required=True)
    parser.add_argument("--photo", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True, help="output directory")
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    photo = Path(args.photo).resolve()
    audio = Path(args.audio).resolve()
    try:
        entry, context = load_registry_entry(args.piece_id, args.edition_id)
        if entry is None:
            result = fail_closed_result("supported-edition-not-in-library", photo, args.piece_id, args.edition_id)
        elif not audio.is_file():
            result = fail_closed_result("supported-edition-audio-agreement-missing", photo, args.piece_id, args.edition_id)
        else:
            score = safe_registry_artifact(context["path"].parent, entry["musicxmlPath"])
            audio_evidence = build_audio_evidence(score, audio)
            result = register_supported_edition(
                piece_id=args.piece_id,
                edition_id=args.edition_id,
                photo_path=photo,
                audio_evidence=audio_evidence,
            )
            attach_feedback_and_annotation(result, audio_evidence, photo, out / "annotated-photo.jpg")
    except Exception as error:  # fail closed at the process boundary
        result = fail_closed_result("supported-edition-registration-review-required", photo, args.piece_id, args.edition_id)
        result["detail"] = f"{type(error).__name__}: {error}"
    audit_path = out / "registration-audit.json"
    audit_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
