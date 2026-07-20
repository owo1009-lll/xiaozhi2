from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import zipfile
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET

from PIL import Image


REPO = Path(__file__).resolve().parents[2]
DEFAULT_ATTRIBUTION = (
    REPO
    / "data/experiments/western-strings-m4/clean-failure-modes/structure-attribution.json"
)
DEFAULT_NOTE_AUDIT = (
    REPO
    / "data/experiments/western-strings-m4/render-gold-omr/render-gold-note-level-audit.json"
)
DEFAULT_OUTPUT = (
    REPO
    / "data/experiments/western-strings-m4/clean-failure-modes/barline-crosscheck.json"
)
POSITION_TOLERANCE_RATIO = 0.012
DECODING_LOCK_THRESHOLD = 0.80


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def multiply(
    left: tuple[float, float, float, float, float, float],
    right: tuple[float, float, float, float, float, float],
) -> tuple[float, float, float, float, float, float]:
    a, b, c, d, e, f = left
    g, h, i, j, k, ell = right
    return (
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * ell + e,
        b * k + d * ell + f,
    )


def parse_transform(value: str) -> tuple[float, float, float, float, float, float]:
    result = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for name, payload in re.findall(r"([A-Za-z]+)\s*\(([^)]*)\)", value or ""):
        values = [float(item) for item in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", payload)]
        if name == "translate" and values:
            current = (1.0, 0.0, 0.0, 1.0, values[0], values[1] if len(values) > 1 else 0.0)
        elif name == "scale" and values:
            current = (values[0], 0.0, 0.0, values[1] if len(values) > 1 else values[0], 0.0, 0.0)
        elif name == "matrix" and len(values) == 6:
            current = tuple(values)  # type: ignore[assignment]
        elif name:
            raise ValueError(f"unsupported-svg-transform:{name}")
        else:
            continue
        result = multiply(result, current)
    return result


def apply(
    matrix: tuple[float, float, float, float, float, float], x: float, y: float
) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f


def first_path_segment(path_data: str) -> tuple[float, float, float, float]:
    values = [float(item) for item in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", path_data)]
    if len(values) < 4:
        raise ValueError("barline-path-has-no-segment")
    return values[0], values[1], values[2], values[3]


def gold_barlines(svg_path: Path, png_path: Path) -> list[tuple[float, float]]:
    root = ET.fromstring(svg_path.read_bytes())
    inner = next(
        (
            row
            for row in root.iter()
            if local(str(row.tag)) == "svg"
            and "definition-scale" in str(row.attrib.get("class") or "").split()
        ),
        None,
    )
    if inner is None:
        raise ValueError("definition-scale-svg-missing")
    view_box = [float(item) for item in str(inner.attrib.get("viewBox") or "").split()]
    if len(view_box) != 4 or view_box[2] <= 0 or view_box[3] <= 0:
        raise ValueError("definition-scale-viewbox-invalid")
    width, height = Image.open(png_path).size
    scale_x = width / view_box[2]
    scale_y = height / view_box[3]
    positions: list[tuple[float, float]] = []

    def walk(
        element: ET.Element,
        parent_matrix: tuple[float, float, float, float, float, float],
        inside_barline: bool,
    ) -> None:
        matrix = multiply(parent_matrix, parse_transform(str(element.attrib.get("transform") or "")))
        classes = str(element.attrib.get("class") or "").split()
        selected = inside_barline or "barLine" in classes
        if selected and local(str(element.tag)) == "path":
            x1, y1, x2, y2 = first_path_segment(str(element.attrib.get("d") or ""))
            left = apply(matrix, x1, y1)
            right = apply(matrix, x2, y2)
            positions.append(
                (
                    ((left[0] + right[0]) / 2.0 - view_box[0]) * scale_x,
                    ((left[1] + right[1]) / 2.0 - view_box[1]) * scale_y,
                )
            )
        for child in list(element):
            walk(child, matrix, selected)

    walk(inner, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), False)
    return positions


def predicted_barlines(xml_bytes: bytes) -> list[tuple[float, float]]:
    root = ET.fromstring(xml_bytes)
    positions: list[tuple[float, float]] = []
    for row in root.iter():
        if local(str(row.tag)) != "barline":
            continue
        median = next((item for item in list(row) if local(str(item.tag)) == "median"), None)
        if median is None:
            continue
        points = [item for item in list(median) if local(str(item.tag)) in {"p1", "p2"}]
        if len(points) != 2:
            continue
        values = [(float(item.attrib["x"]), float(item.attrib["y"])) for item in points]
        positions.append(
            ((values[0][0] + values[1][0]) / 2.0, (values[0][1] + values[1][1]) / 2.0)
        )
    return positions


def match_positions(
    gold: Iterable[tuple[float, float]],
    predicted: Iterable[tuple[float, float]],
    tolerance: float,
) -> int:
    gold_rows = list(gold)
    predicted_rows = list(predicted)
    candidates = sorted(
        (
            math.hypot(gx - px, gy - py),
            gold_index,
            predicted_index,
        )
        for gold_index, (gx, gy) in enumerate(gold_rows)
        for predicted_index, (px, py) in enumerate(predicted_rows)
        if abs(gx - px) <= tolerance and abs(gy - py) <= tolerance
    )
    used_gold: set[int] = set()
    used_predicted: set[int] = set()
    for _, gold_index, predicted_index in candidates:
        if gold_index in used_gold or predicted_index in used_predicted:
            continue
        used_gold.add(gold_index)
        used_predicted.add(predicted_index)
    return len(used_gold)


def audit_piece(row: dict[str, object]) -> dict[str, object]:
    draft_path = REPO / str(row["recognizedScore"])
    piece_root = draft_path.parents[1]
    render_paths = sorted((piece_root / "render").glob("page-*.svg"))
    omr_path = draft_path.with_suffix(".omr")
    pages: list[dict[str, object]] = []
    with zipfile.ZipFile(omr_path) as archive:
        sheet_names = sorted(
            (name for name in archive.namelist() if re.fullmatch(r"sheet#\d+/sheet#\d+\.xml", name)),
            key=lambda name: int(re.search(r"\d+", name).group()),  # type: ignore[union-attr]
        )
        if len(sheet_names) != len(render_paths):
            raise ValueError(f"sheet-page-count-mismatch:{row['pieceId']}")
        for page_index, (svg_path, sheet_name) in enumerate(zip(render_paths, sheet_names), start=1):
            png_path = svg_path.with_suffix(".png")
            gold = gold_barlines(svg_path, png_path)
            predicted = predicted_barlines(archive.read(sheet_name))
            tolerance = max(12.0, Image.open(png_path).size[0] * POSITION_TOLERANCE_RATIO)
            matched = match_positions(gold, predicted, tolerance)
            pages.append(
                {
                    "page": page_index,
                    "goldBarlineCount": len(gold),
                    "predictedBarlineCount": len(predicted),
                    "matchedBarlineCount": matched,
                    "recall": round(matched / len(gold), 6) if gold else None,
                    "precision": round(matched / len(predicted), 6) if predicted else None,
                    "positionTolerancePixels": round(tolerance, 3),
                    "normal": bool(gold and matched == len(gold) == len(predicted)),
                }
            )
    return {
        "pieceId": row["pieceId"],
        "measureAccuracy": row["measureAccuracy"],
        "measureMode": row["measure"]["mode"],  # type: ignore[index]
        "barlineRecallNormal": bool(
            pages
            and all(page["matchedBarlineCount"] == page["goldBarlineCount"] for page in pages)
        ),
        "barlinePrecisionNormal": bool(
            pages
            and all(page["matchedBarlineCount"] == page["predictedBarlineCount"] for page in pages)
        ),
        "barlineDetectionNormal": bool(pages and all(page["normal"] for page in pages)),
        "pages": pages,
    }


def build_report(
    attribution: dict[str, object], note_audit: dict[str, object]
) -> dict[str, object]:
    failed = [row for row in attribution["rows"] if row["measureFailed"]]  # type: ignore[index]
    paths_by_piece = {
        row["piece"]: row
        for row in note_audit["rows"]  # type: ignore[index]
        if row.get("status") == "ok"
    }
    rows = [audit_piece({**paths_by_piece[row["pieceId"]], **row}) for row in failed]
    normal = sum(bool(row["barlineDetectionNormal"]) for row in rows)
    recall_normal = sum(bool(row["barlineRecallNormal"]) for row in rows)
    precision_normal = sum(bool(row["barlinePrecisionNormal"]) for row in rows)
    missing = len(rows) - recall_normal
    extra = len(rows) - precision_normal
    share = normal / len(rows) if rows else 0.0
    return {
        "contract": "western-m4-clean-barline-crosscheck-v1",
        "evidenceRole": "clean-render-raw-barline-vs-semantic-svg-root-cause-diagnostic",
        "thresholds": {
            "decodingLockMinNormalFailureShare": DECODING_LOCK_THRESHOLD,
            "positionToleranceWidthRatio": POSITION_TOLERANCE_RATIO,
        },
        "aggregate": {
            "measureFailedPieceCount": len(rows),
            "barlineNormalPieceCount": normal,
            "barlineAbnormalPieceCount": len(rows) - normal,
            "barlineNormalFailureShare": round(share, 6),
            "barlineRecallNormalPieceCount": recall_normal,
            "barlineRecallNormalFailureShare": round(recall_normal / len(rows), 6) if rows else 0.0,
            "barlinePrecisionNormalPieceCount": precision_normal,
            "barlinePrecisionNormalFailureShare": round(precision_normal / len(rows), 6) if rows else 0.0,
            "missingBarlinePieceCount": missing,
            "missingBarlineFailureShare": round(missing / len(rows), 6) if rows else 0.0,
            "extraBarlinePieceCount": extra,
            "extraBarlineFailureShare": round(extra / len(rows), 6) if rows else 0.0,
            "decodingPrimaryCauseLocked": share >= DECODING_LOCK_THRESHOLD,
            "barlineDetectionComponentRemainsMaterial": share < DECODING_LOCK_THRESHOLD,
        },
        "method": {
            "gold": "Verovio SVG barLine path centres from the exact clean render",
            "prediction": "Audiveris raw barline Inter median coordinates from the matching OMR sheet",
            "normalDefinition": "every page has one-to-one position matches with no missing or extra raw barline",
            "recallNormalDefinition": "every SVG barline has a position-matched raw Audiveris barline; extras are reported separately",
            "scope": "diagnostic only; no photo-domain or student-runtime claim",
        },
        "studentGateReady": False,
        "runtimeEffect": "none",
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Cross-check clean measure failures against raw barlines.")
    parser.add_argument("--attribution", type=Path, default=DEFAULT_ATTRIBUTION)
    parser.add_argument("--note-audit", type=Path, default=DEFAULT_NOTE_AUDIT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    attribution = json.loads(args.attribution.read_text(encoding="utf-8"))
    note_audit = json.loads(args.note_audit.read_text(encoding="utf-8"))
    report = build_report(attribution, note_audit)
    report["sources"] = {
        "attribution": {
            "path": args.attribution.relative_to(REPO).as_posix(),
            "sha256": sha256(args.attribution),
        },
        "noteAudit": {
            "path": args.note_audit.relative_to(REPO).as_posix(),
            "sha256": sha256(args.note_audit),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": args.output.relative_to(REPO).as_posix(), **report["aggregate"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
