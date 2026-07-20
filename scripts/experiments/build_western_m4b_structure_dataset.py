#!/usr/bin/env python3
"""Build the Appendix C.3 synthetic-first structure dataset and frozen split ledger."""

from __future__ import annotations

import hashlib
import json
import math
import shutil
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO / "config" / "western-m4b-dataset.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_compact_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def bbox_polygon(bbox: list[float]) -> list[list[float]]:
    x1, y1, x2, y2 = [float(value) for value in bbox]
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def structure_gold(sidecar: dict[str, Any]) -> dict[str, Any]:
    systems = [
        {"systemIndex": row["systemIndex"], "polygon": bbox_polygon(row["bboxPixels"])}
        for row in sidecar["systems"]
    ]
    staffs = [
        {
            "staffIndex": row["staffIndex"],
            "systemIndex": row["systemIndex"],
            "polygon": bbox_polygon(row["bboxPixels"]),
            "staffLines": [
                [[float(row["bboxPixels"][0]), y], [float(row["bboxPixels"][2]), y]]
                for y in np.linspace(float(row["bboxPixels"][1]), float(row["bboxPixels"][3]), 5)
            ],
        }
        for row in sidecar["staves"]
    ]
    measures = [
        {
            "globalMeasureIndex": row["globalMeasureIndex"],
            "systemIndex": row["systemIndex"],
            "staffIndex": row["staffIndex"],
            "polygon": bbox_polygon(row["bboxPixels"]),
        }
        for row in sidecar["measures"]
    ]
    barlines = []
    for system in sidecar["systems"]:
        rows = sorted(
            [row for row in sidecar["measures"] if row["systemIndex"] == system["systemIndex"]],
            key=lambda row: row["bboxPixels"][2],
        )
        for index, row in enumerate(rows):
            x = float(row["bboxPixels"][2])
            y1, y2 = float(row["bboxPixels"][1]), float(row["bboxPixels"][3])
            is_piece_end = row["globalMeasureIndex"] == max(item["globalMeasureIndex"] for item in sidecar["measures"])
            barlines.append({
                "systemIndex": row["systemIndex"],
                "afterGlobalMeasureIndex": row["globalMeasureIndex"],
                "type": "final" if is_piece_end else "single",
                "line": [[x, y1], [x, y2]],
                "systemOrdinal": index,
            })
    first_staff = sidecar["staves"][0]
    x1, y1, x2, y2 = [float(value) for value in first_staff["bboxPixels"]]
    interline = max(1.0, (y2 - y1) / 4.0)
    meter_regions = [{
        "systemIndex": first_staff["systemIndex"],
        "polygon": bbox_polygon([x1 + 4.5 * interline, y1 - 0.5 * interline, x1 + 7.5 * interline, y2 + 0.5 * interline]),
    }]
    return {
        "pageCorners": [[0.0, 0.0], [float(sidecar["page"]["widthPixels"] - 1), 0.0], [float(sidecar["page"]["widthPixels"] - 1), float(sidecar["page"]["heightPixels"] - 1)], [0.0, float(sidecar["page"]["heightPixels"] - 1)]],
        "systems": systems,
        "staffs": staffs,
        "barlines": barlines,
        "measureBoxes": measures,
        "meterRegions": meter_regions,
        "sameEdition": True,
        "judgeable": True,
    }


def transform_points(points: list[list[float]], homography: np.ndarray, curve_amplitude: float, width: int) -> list[list[float]]:
    source = np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)
    projected = cv2.perspectiveTransform(source, homography).reshape(-1, 2)
    projected[:, 1] += curve_amplitude * np.sin(np.pi * projected[:, 0] / max(1, width - 1))
    return [[round(float(x), 3), round(float(y), 3)] for x, y in projected]


def transform_gold(gold: dict[str, Any], homography: np.ndarray, curve_amplitude: float, width: int, height: int) -> dict[str, Any]:
    output = {
        "pageCorners": transform_points(gold["pageCorners"], homography, curve_amplitude, width),
        "systems": [],
        "staffs": [],
        "barlines": [],
        "measureBoxes": [],
        "meterRegions": [],
        "sameEdition": gold["sameEdition"],
        "judgeable": gold["judgeable"],
        "image": {"width": width, "height": height},
    }
    for key in ["systems", "measureBoxes", "meterRegions"]:
        output[key] = [
            {**row, "polygon": transform_points(row["polygon"], homography, curve_amplitude, width)}
            for row in gold[key]
        ]
    for row in gold["staffs"]:
        output["staffs"].append({
            **row,
            "polygon": transform_points(row["polygon"], homography, curve_amplitude, width),
            "staffLines": [
                transform_points(line, homography, curve_amplitude, width)
                for line in row["staffLines"]
            ],
        })
    for row in gold["barlines"]:
        output["barlines"].append({
            **row,
            "line": transform_points(row["line"], homography, curve_amplitude, width),
        })
    return output


def augment_page(
    image: np.ndarray,
    rng: np.random.Generator,
    curve_range: dict[str, float],
) -> tuple[np.ndarray, np.ndarray, float, dict[str, Any]]:
    source_height, source_width = image.shape[:2]
    output_width, output_height = 920, 1260
    minimum_curve = float(curve_range["minimumAbsolute"])
    maximum_curve = float(curve_range["maximumAbsolute"])
    if not 0 <= minimum_curve <= maximum_curve:
        raise ValueError(f"invalid curve amplitude range: {curve_range}")
    curve_sign = -1.0 if rng.random() < 0.5 else 1.0
    curve_amplitude = curve_sign * float(rng.uniform(minimum_curve, maximum_curve))
    margin_x, margin_y = 75, 125
    jitter_x = output_width * 0.045
    jitter_y = 25
    target = np.float32([
        [margin_x + rng.uniform(-jitter_x, jitter_x), margin_y + rng.uniform(-jitter_y, jitter_y)],
        [output_width - margin_x + rng.uniform(-jitter_x, jitter_x), margin_y + rng.uniform(-jitter_y, jitter_y)],
        [output_width - margin_x + rng.uniform(-jitter_x, jitter_x), output_height - margin_y + rng.uniform(-jitter_y, jitter_y)],
        [margin_x + rng.uniform(-jitter_x, jitter_x), output_height - margin_y + rng.uniform(-jitter_y, jitter_y)],
    ])
    source = np.float32([[0, 0], [source_width - 1, 0], [source_width - 1, source_height - 1], [0, source_height - 1]])
    homography = cv2.getPerspectiveTransform(source, target)
    background_value = int(rng.integers(12, 70))
    canvas = np.full((output_height, output_width, 3), background_value, dtype=np.uint8)
    warped = cv2.warpPerspective(image, homography, (output_width, output_height), borderValue=(background_value,) * 3)
    mask = cv2.warpPerspective(np.full((source_height, source_width), 255, dtype=np.uint8), homography, (output_width, output_height))
    canvas[mask > 0] = warped[mask > 0]
    grid_x, grid_y = np.meshgrid(np.arange(output_width, dtype=np.float32), np.arange(output_height, dtype=np.float32))
    map_y = grid_y - curve_amplitude * np.sin(np.pi * grid_x / max(1, output_width - 1))
    canvas = cv2.remap(canvas, grid_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(background_value,) * 3)
    shadow_strength = float(rng.uniform(0.0, 0.28))
    shadow = np.linspace(1.0 - shadow_strength, 1.0, output_width, dtype=np.float32)[None, :, None]
    if rng.random() < 0.5:
        shadow = shadow[:, ::-1]
    canvas = np.clip(canvas.astype(np.float32) * shadow, 0, 255).astype(np.uint8)
    if rng.random() < 0.45:
        sigma = float(rng.uniform(0.35, 1.25))
        canvas = cv2.GaussianBlur(canvas, (0, 0), sigma)
    handwriting_count = int(rng.integers(0, 4))
    for _ in range(handwriting_count):
        x1 = int(rng.integers(50, output_width - 50))
        y1 = int(rng.integers(50, output_height - 50))
        x2 = int(np.clip(x1 + rng.integers(-80, 81), 0, output_width - 1))
        y2 = int(np.clip(y1 + rng.integers(-35, 36), 0, output_height - 1))
        cv2.line(canvas, (x1, y1), (x2, y2), (35, 35, 110), int(rng.integers(1, 3)), cv2.LINE_AA)
    jpeg_quality = int(rng.integers(62, 96))
    return canvas, homography, curve_amplitude, {
        "backgroundValue": background_value,
        "curveAmplitudePixels": round(curve_amplitude, 4),
        "shadowStrength": round(shadow_strength, 4),
        "handwritingStrokeCount": handwriting_count,
        "jpegQuality": jpeg_quality,
    }


def split_for(index: int, split_counts: dict[str, int]) -> str:
    cursor = 0
    for name, count in split_counts.items():
        cursor += int(count)
        if index < cursor:
            return name
    raise ValueError(f"variant index outside split contract: {index}")


def file_record(path: Path, **extra: Any) -> dict[str, Any]:
    return {**extra, "path": relative(path), "sha256": sha256(path), "bytes": path.stat().st_size}


def build_synthetic(config: dict[str, Any], output_root: Path) -> list[dict[str, Any]]:
    registry_path = REPO / config["synthetic"]["registryPath"]
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    registry_root = registry_path.parent
    synthetic_root = output_root / "synthetic"
    if synthetic_root.exists():
        shutil.rmtree(synthetic_root)
    rows = []
    split_counts = config["synthetic"]["splitsByVariant"]
    variants = int(config["synthetic"]["variantsPerEdition"])
    if sum(int(value) for value in split_counts.values()) != variants:
        raise ValueError("synthetic split counts do not sum to variantsPerEdition")
    for entry_index, entry in enumerate(registry["entries"]):
        render_path = registry_root / entry["renderPath"]
        sidecar_path = registry_root / entry["coordinateSidecarPath"]
        image = cv2.imdecode(np.frombuffer(render_path.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise FileNotFoundError(render_path)
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        gold = structure_gold(sidecar)
        for variant_index in range(variants):
            rng = np.random.default_rng(int(config["synthetic"]["seed"]) + entry_index * 1000 + variant_index)
            split = split_for(variant_index, split_counts)
            curve_range = config["synthetic"]["curveAmplitudePixelsBySplit"][split]
            augmented, homography, curve_amplitude, augmentation = augment_page(image, rng, curve_range)
            transformed = transform_gold(gold, homography, curve_amplitude, augmented.shape[1], augmented.shape[0])
            case_id = f"{entry['pieceId']}-{entry['editionId']}-s{variant_index + 1:02d}"
            case_root = synthetic_root / split / case_id
            image_path = case_root / "photo.jpg"
            label_path = case_root / "structure.json"
            case_root.mkdir(parents=True, exist_ok=True)
            quality = augmentation["jpegQuality"]
            ok, encoded = cv2.imencode(".jpg", augmented, [cv2.IMWRITE_JPEG_QUALITY, quality])
            if not ok:
                raise RuntimeError(f"jpeg encoding failed: {case_id}")
            image_path.write_bytes(encoded.tobytes())
            label = {
                "contract": "western-m4b-structure-label-v1",
                "caseId": case_id,
                "source": {
                    "pieceId": entry["pieceId"],
                    "editionId": entry["editionId"],
                    "registrySha256": sha256(registry_path),
                    "renderSha256": entry["renderSha256"],
                    "coordinateSidecarSha256": entry["coordinateSidecarSha256"],
                },
                "split": split,
                "augmentation": augmentation,
                "labels": transformed,
            }
            write_compact_json(label_path, label)
            rows.append({
                "caseId": case_id,
                "pieceId": entry["pieceId"],
                "editionId": entry["editionId"],
                "split": split,
                "image": file_record(image_path),
                "label": file_record(label_path),
                "counts": {
                    "systems": len(transformed["systems"]),
                    "staffs": len(transformed["staffs"]),
                    "barlines": len(transformed["barlines"]),
                    "measures": len(transformed["measureBoxes"]),
                    "meterRegions": len(transformed["meterRegions"]),
                },
                "augmentation": augmentation,
            })
    return rows


def freeze_rows(rows: list[dict[str, Any]], role: str) -> list[dict[str, Any]]:
    output = []
    for row in rows:
        photo = REPO / row["photoPath"]
        item = {
            **row,
            "role": role,
            "trainingEligible": False,
            "photoSha256": sha256(photo),
            "photoBytes": photo.stat().st_size,
        }
        if row.get("goldPath"):
            gold = REPO / row["goldPath"]
            item["goldSha256"] = sha256(gold)
            item["goldBytes"] = gold.stat().st_size
        output.append(item)
    return output


def m4a_rows(config: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    report_path = REPO / config["m4aLabelSource"]["acceptanceReportPath"]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    successful, active = [], []
    for row in report.get("positiveCases", []):
        if row.get("available") is not True:
            continue
        target = successful if row.get("ready") is True else active
        target.append({
            "caseId": row["caseId"],
            "photoPath": row["photo"],
            "photoSha256": row["photoSha256"],
            "role": config["m4aLabelSource"]["successfulPhotosRole" if row.get("ready") is True else "failedPhotosRole"],
            "trainingEligible": row.get("ready") is True,
            "sourceEvidenceDigest": report.get("evidenceDigest", ""),
        })
    return successful, active


def fresh_blind_rows(config: dict[str, Any]) -> list[dict[str, Any]]:
    intake_path = REPO / config["freshBlind"]["intakeManifest"]
    if not intake_path.is_file():
        return []
    intake = json.loads(intake_path.read_text(encoding="utf-8"))
    rows = []
    for row in intake.get("rows", []):
        photo = REPO / row.get("photoPath", "")
        label = REPO / row.get("labelPath", "")
        if not photo.is_file() or not label.is_file():
            continue
        rows.append({
            **row,
            "role": "fresh-blind-test-only",
            "trainingEligible": False,
            "photoSha256": sha256(photo),
            "labelSha256": sha256(label),
        })
    return rows


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    output_root = REPO / config["outputRoot"]
    output_root.mkdir(parents=True, exist_ok=True)
    synthetic = build_synthetic(config, output_root)
    source_gold = freeze_rows(config["frozenSourceGoldTestOnly"], "frozen-source-gold-test-only")
    screen_photos = freeze_rows(config["frozenScreenPhotoTestOnly"], "frozen-screen-photo-test-only")
    m4a_success, active_learning = m4a_rows(config)
    fresh_blind = fresh_blind_rows(config)
    fresh_policy = config["freshBlind"]
    fresh_pieces = len({row.get("pieceOrLayoutId") for row in fresh_blind if row.get("pieceOrLayoutId")})
    fresh_devices = len({row.get("deviceId") for row in fresh_blind if row.get("deviceId")})
    fresh_ready = (
        len(fresh_blind) >= fresh_policy["minimumPhotos"]
        and fresh_pieces >= fresh_policy["minimumPiecesOrLayouts"]
        and fresh_devices >= fresh_policy["minimumDevices"]
    )
    label_schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "western-m4b-real-structure-label-v1",
        "type": "object",
        "required": ["contract", "caseId", "photoSha256", "pieceOrLayoutId", "deviceId", "captureBatchId", "labels"],
        "properties": {
            "contract": {"const": "western-m4b-real-structure-label-v1"},
            "caseId": {"type": "string", "minLength": 1},
            "photoSha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
            "pieceOrLayoutId": {"type": "string", "minLength": 1},
            "deviceId": {"type": "string", "minLength": 1},
            "captureBatchId": {"type": "string", "minLength": 1},
            "labels": {
                "type": "object",
                "required": config["realAnnotation"]["requiredLabels"],
            },
        },
    }
    write_json(output_root / "real-structure-label.schema.json", label_schema)
    template = {
        "contract": "western-m4b-fresh-blind-intake-v1",
        "rows": [
            {
                "caseId": f"m4b-fresh-{index + 1:02d}",
                "photoPath": "",
                "labelPath": "",
                "pieceOrLayoutId": "",
                "deviceId": "",
                "captureBatchId": "",
            }
            for index in range(fresh_policy["targetPhotos"])
        ],
    }
    write_json(output_root / "fresh-blind-intake.template.json", template)
    manifest = {
        "contract": "western-m4b-structure-dataset-manifest-v1",
        "policy": relative(CONFIG_PATH),
        "policySha256": sha256(CONFIG_PATH),
        "syntheticRows": synthetic,
        "frozenSourceGoldRows": source_gold,
        "frozenScreenPhotoRows": screen_photos,
        "m4aAutoLabeledRows": m4a_success,
        "activeLearningRows": active_learning,
        "freshBlindRows": fresh_blind,
    }
    manifest_path = output_root / "manifest.json"
    write_json(manifest_path, manifest)
    split_counts = {
        split: sum(row["split"] == split for row in synthetic)
        for split in config["synthetic"]["splitsByVariant"]
    }
    curve_ranges = {
        split: {
            "minimumAbsolute": round(min(abs(float(row["augmentation"]["curveAmplitudePixels"])) for row in synthetic if row["split"] == split), 4),
            "maximumAbsolute": round(max(abs(float(row["augmentation"]["curveAmplitudePixels"])) for row in synthetic if row["split"] == split), 4),
        }
        for split in config["synthetic"]["splitsByVariant"]
    }
    report = {
        "contract": "western-m4b-structure-dataset-report-v1",
        "complete": True,
        "dataFoundationReady": len(synthetic) == 60 and len(source_gold) == 5 and len(screen_photos) == 8,
        "realAnnotationTargetReady": len(m4a_success) >= config["realAnnotation"]["minimumTarget"],
        "freshBlindReady": fresh_ready,
        "manifest": relative(manifest_path),
        "manifestSha256": sha256(manifest_path),
        "provenance": {
            "policy": relative(CONFIG_PATH),
            "policySha256": sha256(CONFIG_PATH),
            "builder": relative(Path(__file__).resolve()),
            "builderSha256": sha256(Path(__file__).resolve()),
        },
        "artifacts": {
            "labelSchema": file_record(output_root / "real-structure-label.schema.json"),
            "freshBlindTemplate": file_record(output_root / "fresh-blind-intake.template.json"),
        },
        "counts": {
            "synthetic": len(synthetic),
            "syntheticSplits": split_counts,
            "syntheticCurveAmplitudePixelsBySplit": curve_ranges,
            "frozenSourceGoldTestOnly": len(source_gold),
            "frozenScreenPhotoTestOnly": len(screen_photos),
            "m4aAutoLabeled": len(m4a_success),
            "activeLearning": len(active_learning),
            "freshBlind": len(fresh_blind),
            "freshBlindPiecesOrLayouts": fresh_pieces,
            "freshBlindDevices": fresh_devices,
        },
        "blockingReasons": [
            *([] if len(m4a_success) >= config["realAnnotation"]["minimumTarget"] else [f"m4b-real-structure-labels-below-{config['realAnnotation']['minimumTarget']}"]),
            *([] if fresh_ready else ["m4b-fresh-blind-dataset-not-ready"]),
        ],
        "discipline": {
            "sourceGoldTrainingEligible": False,
            "screenPhotoTrainingEligible": False,
            "freshBlindTrainingEligible": False,
            "m4aFailuresEnterActiveLearningOnly": True,
        },
    }
    report_path = output_root / "report.json"
    write_json(report_path, report)
    print(json.dumps({"ok": report["dataFoundationReady"], "report": relative(report_path), "counts": report["counts"], "blockingReasons": report["blockingReasons"]}, ensure_ascii=False, indent=2))
    if not report["dataFoundationReady"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
