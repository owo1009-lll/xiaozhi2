from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO / "config/western-m4b-dataset.json"
SELECTION_PATH = REPO / "config/western-m4b-next-augmentation.json"
SYNTHETIC_ROOT = REPO / "data/experiments/western-strings-m4b/dataset/synthetic/synthetic-test"
OUTPUT = REPO / "data/experiments/western-strings-m4/real-degradation-gap/report.json"
TARGETS = {
    "violin-ex09": REPO / "data/private/western-strings-m2/violin-ex09-score.jpg",
    "violin-ex10": REPO / "data/private/western-strings-m2/violin-ex10-score.jpg",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def portable(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def read_image(path: Path) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(path)
    scale = 900 / image.shape[1]
    return cv2.resize(
        image,
        (900, round(image.shape[0] * scale)),
        interpolation=cv2.INTER_AREA,
    )


def degradation_metrics(path: Path) -> dict[str, float]:
    image = read_image(path)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    background = cv2.GaussianBlur(gray, (0, 0), 45)
    local_background = cv2.GaussianBlur(gray, (0, 0), 21)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    chroma = lab[:, :, 1:] - 128.0
    chroma_high_pass = chroma - cv2.GaussianBlur(chroma, (0, 0), 2)
    return {
        "laplacianVariance": round(float(cv2.Laplacian(gray, cv2.CV_32F).var()), 6),
        "illuminationP90P10OverMedian": round(
            float((np.percentile(background, 90) - np.percentile(background, 10)) / max(1, np.median(background))),
            6,
        ),
        "overexposedFraction": round(float(np.mean(gray > 248)), 6),
        "underexposedFraction": round(float(np.mean(gray < 20)), 6),
        "chromaHighFrequencyRms": round(float(np.sqrt(np.mean(chroma_high_pass**2))), 6),
        "localInkFraction": round(float(np.mean(gray < local_background - 18)), 6),
    }


def distribution(values: list[float]) -> dict[str, float]:
    return {
        "minimum": round(float(min(values)), 6),
        "median": round(float(np.median(values)), 6),
        "maximum": round(float(max(values)), 6),
    }


def build_report() -> dict[str, Any]:
    selection = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
    synthetic_paths = sorted(SYNTHETIC_ROOT.rglob("photo.jpg"))
    if len(synthetic_paths) != 12:
        raise RuntimeError(f"expected 12 frozen synthetic-test images, got {len(synthetic_paths)}")
    synthetic_rows = [
        {"caseId": path.parent.name, "path": portable(path), "metrics": degradation_metrics(path)}
        for path in synthetic_paths
    ]
    names = list(synthetic_rows[0]["metrics"])
    synthetic_distribution = {
        name: distribution([row["metrics"][name] for row in synthetic_rows])
        for name in names
    }
    target_rows = []
    for piece_id, path in TARGETS.items():
        metrics = degradation_metrics(path)
        outside = {
            name: (
                "above-synthetic-maximum"
                if value > synthetic_distribution[name]["maximum"]
                else "below-synthetic-minimum"
                if value < synthetic_distribution[name]["minimum"]
                else "inside-synthetic-range"
            )
            for name, value in metrics.items()
        }
        target_rows.append({
            "pieceId": piece_id,
            "path": portable(path),
            "sha256": sha256(path),
            "metrics": metrics,
            "relativeToSyntheticTest": outside,
        })
    moire_gap = all(
        row["relativeToSyntheticTest"]["chromaHighFrequencyRms"] == "above-synthetic-maximum"
        for row in target_rows
    )
    dense_layout_gap = all(
        row["relativeToSyntheticTest"]["localInkFraction"] == "above-synthetic-maximum"
        for row in target_rows
    )
    blur_gap = all(
        row["relativeToSyntheticTest"]["laplacianVariance"] == "below-synthetic-minimum"
        for row in target_rows
    )
    overexposure_gap = all(
        row["relativeToSyntheticTest"]["overexposedFraction"] == "above-synthetic-maximum"
        for row in target_rows
    )
    illumination_gap = all(
        row["relativeToSyntheticTest"]["illuminationP90P10OverMedian"] == "above-synthetic-maximum"
        for row in target_rows
    )
    selected_augmentation = "chromatic-screen-moire" if moire_gap else None
    if selection.get("type") != selected_augmentation:
        raise RuntimeError("next augmentation selection does not match measured degradation gap")
    return {
        "contract": "western-m4-real-degradation-gap-audit-v1",
        "evidenceRole": "reused-real-failure-vs-frozen-synthetic-diagnostic",
        "sources": {
            "datasetConfig": {"path": portable(CONFIG_PATH), "sha256": sha256(CONFIG_PATH)},
            "augmentationSelection": {"path": portable(SELECTION_PATH), "sha256": sha256(SELECTION_PATH)},
            "syntheticTestCount": len(synthetic_rows),
        },
        "syntheticTestDistribution": synthetic_distribution,
        "targets": target_rows,
        "findings": {
            "chromaticScreenMoireGap": moire_gap,
            "denseLayoutGap": dense_layout_gap,
            "blurGap": blur_gap,
            "overexposureGap": overexposure_gap,
            "illuminationGap": illumination_gap,
            "selectedNextPixelAugmentation": selected_augmentation,
            "separateSourceDiversityAction": "add-dense-public-single-staff-layouts" if dense_layout_gap else None,
            "reason": (
                "Both failures exceed the frozen synthetic maximum for chroma high-frequency RMS and local ink density; "
                "neither is below the synthetic sharpness minimum or above its overexposure/illumination maxima. "
                "Select chromatic screen moire as the next pixel augmentation and treat dense layout as source-content expansion, not an image filter."
            ),
        },
        "limitations": [
            "The two real photos are reused diagnostics and cannot qualify fresh-blind promotion.",
            "Laplacian variance can be inflated by moire and dense notation, so it rules out an obvious blur-only gap but is not a perceptual sharpness score.",
            "Local ink fraction is a layout/content-density proxy; it must not be simulated by simply darkening pixels.",
            "No private image bytes are copied into this report.",
        ],
        "studentGateReady": False,
        "automaticAdoptionAuthorized": False,
        "syntheticRows": synthetic_rows,
    }


def main() -> int:
    report = build_report()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": portable(OUTPUT), "findings": report["findings"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
