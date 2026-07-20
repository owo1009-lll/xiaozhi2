from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import os
import pickle
from pathlib import Path
from typing import Any, Iterator

import cv2
import numpy as np
from PIL import Image

from build_western_m4b_structure_dataset import augment_page, split_for


REPO = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO / "data/experiments/western-strings-m4a/supported-editions/registry.json"
MASK_REGISTRY_PATH = REPO / "data/experiments/western-strings-m4a/supported-editions/semantic-mask-registry.json"
DATASET_CONFIG = REPO / "config/western-m4b-dataset.json"
DATASET_ROOT = REPO / "data/experiments/western-strings-m4b/dataset"
OUTPUT_ROOT = REPO / "data/experiments/western-strings-m4/semantic-mask-recall"
SYNTHETIC_VARIANT_INDEX = 16  # s17: first frozen synthetic-test case
EVALUATED_PIECES = {"r2-01"}
TOLERANCE_PIXELS = 2
PREDICTION_LAYERS = {
    "stem": ("stems_rests", False),
    "beam": ("symbols", False),
    "notehead": ("notehead", True),
    "barline": ("stems_rests", False),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def portable(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


@contextlib.contextmanager
def working_directory(path: Path) -> Iterator[None]:
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def load_or_infer(image_path: Path, cache_path: Path) -> dict[str, np.ndarray]:
    if cache_path.is_file():
        with cache_path.open("rb") as handle:
            return pickle.load(handle)
    from oemer.ete import generate_pred

    with working_directory(image_path.parent):
        staff, symbols, stems_rests, notehead, _ = generate_pred(image_path.name)
    result = {
        "staff": staff,
        "symbols": symbols,
        "stems_rests": stems_rests,
        "notehead": notehead,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("wb") as handle:
        pickle.dump(result, handle)
    return result


def load_mask(path: Path, size: tuple[int, int]) -> np.ndarray:
    image = Image.open(path).convert("L").resize(size, Image.Resampling.NEAREST)
    return (np.asarray(image) > 0).astype(np.uint8)


def warp_mask(mask: np.ndarray, homography: np.ndarray, curve_amplitude: float) -> np.ndarray:
    width, height = 920, 1260
    warped = cv2.warpPerspective(
        mask,
        homography,
        (width, height),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    grid_x, grid_y = np.meshgrid(
        np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32)
    )
    map_y = grid_y - curve_amplitude * np.sin(np.pi * grid_x / max(1, width - 1))
    return cv2.remap(
        warped,
        grid_x,
        map_y,
        cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )


def recall(gold: np.ndarray, prediction: np.ndarray) -> dict[str, Any]:
    gold_binary = gold > 0
    gold_pixels = int(np.count_nonzero(gold_binary))
    if gold_pixels == 0:
        return {
            "evaluable": False,
            "reason": "zero-positive-gold-pixels",
            "goldPixelCount": 0,
            "exactRecall": None,
            "tolerantRecall": None,
        }
    prediction_binary = (prediction > 0).astype(np.uint8)
    exact = int(np.count_nonzero(gold_binary & (prediction_binary > 0)))
    kernel_size = TOLERANCE_PIXELS * 2 + 1
    tolerant_prediction = cv2.dilate(
        prediction_binary, np.ones((kernel_size, kernel_size), dtype=np.uint8)
    )
    tolerant = int(np.count_nonzero(gold_binary & (tolerant_prediction > 0)))
    return {
        "evaluable": True,
        "goldPixelCount": gold_pixels,
        "exactMatchedPixelCount": exact,
        "tolerantMatchedPixelCount": tolerant,
        "exactRecall": round(exact / gold_pixels, 6),
        "tolerantRecall": round(tolerant / gold_pixels, 6),
    }


def synthetic_case(
    entry: dict[str, Any],
    entry_index: int,
    registry_root: Path,
    config: dict[str, Any],
) -> tuple[Path, dict[str, np.ndarray], dict[str, Any]]:
    render_path = registry_root / entry["renderPath"]
    render = cv2.imdecode(np.frombuffer(render_path.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
    if render is None:
        raise FileNotFoundError(entry["renderPath"])
    rng = np.random.default_rng(
        int(config["synthetic"]["seed"]) + entry_index * 1000 + SYNTHETIC_VARIANT_INDEX
    )
    split = split_for(SYNTHETIC_VARIANT_INDEX, config["synthetic"]["splitsByVariant"])
    curve_range = config["synthetic"]["curveAmplitudePixelsBySplit"][split]
    _, homography, curve_amplitude, augmentation = augment_page(render, rng, curve_range)
    case_id = f"{entry['pieceId']}-{entry['editionId']}-s{SYNTHETIC_VARIANT_INDEX + 1:02d}"
    case_root = DATASET_ROOT / "synthetic" / split / case_id
    label = json.loads((case_root / "structure.json").read_text(encoding="utf-8"))
    if label["augmentation"] != augmentation:
        raise RuntimeError(f"synthetic augmentation replay drift: {case_id}")
    masks = {
        name: warp_mask(
            load_mask(registry_root / metadata["path"], render.shape[1::-1]),
            homography,
            curve_amplitude,
        )
        for name, metadata in entry["semanticMasks"].items()
    }
    return case_root / "photo.jpg", masks, augmentation


def evaluate_case(
    case_id: str,
    domain: str,
    image_path: Path,
    masks: dict[str, np.ndarray],
    augmentation: dict[str, Any] | None,
) -> dict[str, Any]:
    from oemer.dewarp import dewarp, estimate_coords

    cache = OUTPUT_ROOT / "cache" / f"{case_id}.pkl"
    prediction = load_or_infer(image_path, cache)
    height, width = prediction["staff"].shape
    coords_x, coords_y = estimate_coords(prediction["staff"])
    rows: dict[str, Any] = {}
    for name, (layer_name, class_exclusive) in PREDICTION_LAYERS.items():
        source_gold = cv2.resize(masks[name], (width, height), interpolation=cv2.INTER_NEAREST)
        corrected_gold = dewarp(source_gold, coords_x, coords_y)
        corrected_prediction = dewarp(prediction[layer_name], coords_x, coords_y)
        rows[name] = {
            "predictionLayer": layer_name,
            "predictionLayerClassExclusive": class_exclusive,
            **recall(corrected_gold, corrected_prediction),
        }
    return {
        "caseId": case_id,
        "domain": domain,
        "input": portable(image_path),
        "inputSha256": sha256(image_path),
        "predictionSize": [width, height],
        "dewarpAppliedToPredictionAndGold": True,
        "augmentation": augmentation,
        "classes": rows,
    }


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for domain in ["clean-render", "synthetic-test"]:
        domain_rows = [row for row in rows if row["domain"] == domain]
        classes: dict[str, Any] = {}
        for name in PREDICTION_LAYERS:
            metrics = [row["classes"][name] for row in domain_rows]
            evaluable = [row for row in metrics if row["evaluable"]]
            gold_pixels = sum(row["goldPixelCount"] for row in evaluable)
            classes[name] = {
                "caseCount": len(metrics),
                "evaluableCaseCount": len(evaluable),
                "evaluable": bool(evaluable),
                "goldPixelCount": gold_pixels,
                "microExactRecall": (
                    round(sum(row["exactMatchedPixelCount"] for row in evaluable) / gold_pixels, 6)
                    if gold_pixels else None
                ),
                "microTolerantRecall": (
                    round(sum(row["tolerantMatchedPixelCount"] for row in evaluable) / gold_pixels, 6)
                    if gold_pixels else None
                ),
            }
        output[domain] = {"caseCount": len(domain_rows), "classes": classes}
    return output


def main() -> int:
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    mask_registry = json.loads(MASK_REGISTRY_PATH.read_text(encoding="utf-8"))
    masks_by_identity = {
        (row["pieceId"], row["editionId"]): row["semanticMasks"]
        for row in mask_registry["entries"]
    }
    config = json.loads(DATASET_CONFIG.read_text(encoding="utf-8"))
    registry_root = REGISTRY_PATH.parent
    rows = []
    for entry_index, entry in enumerate(registry["entries"]):
        if entry["pieceId"] not in EVALUATED_PIECES:
            continue
        entry = {
            **entry,
            "semanticMasks": masks_by_identity[(entry["pieceId"], entry["editionId"])],
        }
        render_path = registry_root / entry["renderPath"]
        render_size = Image.open(render_path).size
        render_masks = {
            name: load_mask(registry_root / metadata["path"], render_size)
            for name, metadata in entry["semanticMasks"].items()
        }
        rows.append(
            evaluate_case(entry["pieceId"], "clean-render", render_path, render_masks, None)
        )
        synthetic_image, synthetic_masks, augmentation = synthetic_case(
            entry, entry_index, registry_root, config
        )
        rows.append(
            evaluate_case(
                f"{entry['pieceId']}-s{SYNTHETIC_VARIANT_INDEX + 1:02d}",
                "synthetic-test",
                synthetic_image,
                synthetic_masks,
                augmentation,
            )
        )
    report = {
        "contract": "western-m4-oemer-semantic-mask-recall-v1",
        "evidenceRole": "render-and-synthetic-pixel-segmentation-diagnostic",
        "sources": {
            "registry": {"path": portable(REGISTRY_PATH), "sha256": sha256(REGISTRY_PATH)},
            "semanticMaskRegistry": {"path": portable(MASK_REGISTRY_PATH), "sha256": sha256(MASK_REGISTRY_PATH)},
            "datasetConfig": {"path": portable(DATASET_CONFIG), "sha256": sha256(DATASET_CONFIG)},
        },
        "runtime": {"oemerVersion": importlib.metadata.version("oemer")},
        "method": {
            "gold": "MuseScore SVG semantic classes rasterized at render resolution",
            "prediction": "Oemer raw segmentation; built-in dewarp applied identically to prediction and gold",
            "tolerancePixels": TOLERANCE_PIXELS,
            "nonExclusiveLayers": ["stems_rests", "symbols"],
        },
        "aggregate": aggregate(rows),
        "limitations": [
            "Evidence covers clean renders and deterministic synthetic-test images only, never real photos.",
            "The three registered scores contain no Beam SVG elements, so beam recall is not evaluable and is not treated as 100%.",
            "Oemer stems_rests and symbols layers are not class-exclusive; their pixel recall is valid for coverage diagnosis but cannot establish class precision.",
            "The registered pages are known engineering diagnostics, not fresh-blind promotion evidence.",
            "The current inference audit evaluates the r2-01 clean/synthetic pair; masks for the other registered pages are generated but not scored here.",
        ],
        "studentGateReady": False,
        "automaticAdoptionAuthorized": False,
        "rows": rows,
    }
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    output = OUTPUT_ROOT / "report.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": portable(output), "aggregate": report["aggregate"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
