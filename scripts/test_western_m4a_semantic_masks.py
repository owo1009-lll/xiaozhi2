from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from build_western_m4a_supported_editions import svg_path_polygons  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    cubic = svg_path_polygons("M0,0 C0,10 10,10 10,0")
    require(len(cubic) == 1 and len(cubic[0]) == 21, "cubic path sampling")
    polygon = svg_path_polygons("M0,0 L10,0 L10,10 L0,10 Z")
    require(len(polygon) == 1 and len(polygon[0]) == 4, "polygon path sampling")

    registry_root = REPO / "data/experiments/western-strings-m4a/supported-editions"
    registry = json.loads((registry_root / "semantic-mask-registry.json").read_text(encoding="utf-8"))
    product_registry = json.loads((registry_root / "registry.json").read_text(encoding="utf-8"))
    require(registry["contract"] == "western-m4-semantic-mask-registry-v1", "contract")
    product_entries = {
        (entry["pieceId"], entry["editionId"]): entry
        for entry in product_registry["entries"]
    }
    mask_entries = {
        (entry["pieceId"], entry["editionId"]): entry
        for entry in registry["entries"]
    }
    require(mask_entries.keys() == product_entries.keys(), "product registry identity set")
    expected_names = {"stem", "beam", "notehead", "barline"}
    for entry in registry["entries"]:
        product_entry = product_entries[(entry["pieceId"], entry["editionId"])]
        require(entry["renderPath"] == product_entry["renderPath"], "product render path")
        require(entry["renderSha256"] == product_entry["renderSha256"], "product render hash")
        render_size = Image.open(registry_root / entry["renderPath"]).size
        require(set(entry["semanticMasks"]) == expected_names, "mask set")
        for name, metadata in entry["semanticMasks"].items():
            path = registry_root / metadata["path"]
            image = Image.open(path).convert("L")
            foreground = image.histogram()[255]
            require(image.size == render_size, f"{name} dimensions")
            require(sha256(path) == metadata["sha256"], f"{name} hash")
            require(foreground == metadata["foregroundPixelCount"], f"{name} foreground")
            require(
                (metadata["elementCount"] == 0) == (foreground == 0),
                f"{name} empty-set semantics",
            )
    print(json.dumps({
        "ok": True,
        "checks": [
            "svg-path-rasterization",
            "product-registry-render-link",
            "four-mask-set",
            "render-size",
            "hash-and-pixel-count",
        ],
        "beamEvaluable": any(
            entry["semanticMasks"]["beam"]["elementCount"] > 0
            for entry in registry["entries"]
        ),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
