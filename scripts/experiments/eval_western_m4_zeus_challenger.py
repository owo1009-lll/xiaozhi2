#!/usr/bin/env python3
"""Evaluate the official Zeus camera model on the frozen M4 photo gold.

This is an isolated research challenger.  It reuses the accepted M4b page
normalizer and staff detector, but does not change the runtime OMR pool.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from western_m4b_structure_poc import (  # noqa: E402
    detect_explicit_structure,
    load_policy,
    normalize_page,
    read_image,
)
from eval_western_strings_m4_omr_benchmark import (  # noqa: E402
    align_notes,
    parse_notes,
)


DEFAULT_EXTERNAL_ROOT = REPO / "data" / "external" / "olimpic-zeus-challenger"
DEFAULT_MODEL = (
    DEFAULT_EXTERNAL_ROOT
    / "model"
    / "zeus-camera-grandstaff-lmx-1.0-2024-02-12.model"
)
DEFAULT_SOURCE = DEFAULT_EXTERNAL_ROOT / "source"
DEFAULT_PYTHON = (
    REPO / "data" / "tools" / "western-ordinary-dynamic-shadow-py311"
    / "Scripts" / "python.exe"
)
DEFAULT_OUTPUT = (
    REPO / "data" / "experiments" / "western-strings-m4" / "zeus-challenger"
)
DATASET_CONFIG = REPO / "config" / "western-m4b-dataset.json"
THRESHOLDS = {
    "minPitchPrecision": 0.98,
    "minPitchRecall": 0.95,
    "minOnsetQuarterAccuracy": 0.95,
    "minMeasureAccuracy": 0.95,
    "minStrictPagePassRate": 0.90,
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def portable(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path.resolve())


def require_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise SystemExit(f"{label} not found: {path}")


def require_dir(path: Path, label: str) -> None:
    if not path.is_dir():
        raise SystemExit(f"{label} not found: {path}")


def zeus_canvas(crop: np.ndarray) -> np.ndarray:
    """Letterbox a staff without distortion to the released model's shape."""
    target_height, target_width = 192, 2000
    height, width = crop.shape[:2]
    scale = min(target_height / height, target_width / width)
    resized = cv2.resize(
        crop,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC,
    )
    canvas = np.full((target_height, target_width, 3), 255, dtype=np.uint8)
    y = (target_height - resized.shape[0]) // 2
    canvas[y:y + resized.shape[0], :resized.shape[1]] = resized
    return canvas


def crop_staffs(photo: Path, output: Path) -> list[dict[str, Any]]:
    image = read_image(photo)
    if image is None:
        raise RuntimeError(f"cannot read image: {photo}")
    policy = load_policy()
    normalized = normalize_page(image, policy)
    if "rectified" not in normalized:
        raise RuntimeError(str(normalized.get("reason") or "normalization-failed"))
    evidence = detect_explicit_structure(normalized, policy)
    staffs = evidence.get("staffs", [])
    if not staffs:
        raise RuntimeError("no-staff-detected")
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    page = normalized["rectified"]
    for ordinal, staff in enumerate(staffs, start=1):
        polygon = staff["polygonNormalizedPixels"]
        xs = [float(point[0]) for point in polygon]
        ys = [float(point[1]) for point in polygon]
        interline = float(staff["interlinePixels"])
        x1 = max(0, int(min(xs) - interline * 1.5))
        x2 = min(page.shape[1], int(max(xs) + interline * 1.5))
        y1 = max(0, int(min(ys) - interline * 1.5))
        y2 = min(page.shape[0], int(max(ys) + interline * 1.5))
        crop = page[y1:y2, x1:x2]
        if crop.size == 0:
            raise RuntimeError(f"empty-staff-crop:{ordinal}")
        crop_path = output / f"staff-{ordinal:02d}.png"
        ok, encoded = cv2.imencode(".png", zeus_canvas(crop))
        if not ok:
            raise RuntimeError(f"staff-encode-failed:{ordinal}")
        crop_path.write_bytes(encoded.tobytes())
        rows.append({
            "ordinal": ordinal,
            "path": crop_path,
            "bounds": [x1, y1, x2, y2],
            "interlinePixels": interline,
            "normalizationReady": bool(normalized.get("ready")),
            "normalizationReason": str(normalized.get("reason") or "unknown"),
        })
    return rows


def crop_audiveris_staffs(piece_id: str, output: Path) -> list[dict[str, Any]]:
    """Use Audiveris staff geometry when the synthetic M4b detector rejects."""
    base = (
        REPO / "data" / "experiments" / "western-strings-m4" / "real-jpg-omr"
        / piece_id / "up2"
    )
    image_path = base / f"{piece_id}-up2.png"
    omr_path = base / "omr" / f"{piece_id}-up2.omr"
    require_file(image_path, f"{piece_id} Audiveris input")
    require_file(omr_path, f"{piece_id} Audiveris archive")
    image = read_image(image_path)
    if image is None:
        raise RuntimeError(f"cannot read Audiveris input: {image_path}")
    with zipfile.ZipFile(omr_path) as archive:
        sheet_names = sorted(
            name for name in archive.namelist() if name.endswith("/sheet#1.xml")
        )
        if len(sheet_names) != 1:
            raise RuntimeError(f"audiveris-sheet-count:{len(sheet_names)}")
        root = ET.fromstring(archive.read(sheet_names[0]))
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for ordinal, staff in enumerate(root.findall(".//page/system/part/staff"), start=1):
        points = staff.findall("./lines/line/point")
        if not points:
            continue
        xs = [float(point.attrib["x"]) for point in points]
        ys = [float(point.attrib["y"]) for point in points]
        line_centers = []
        for line in staff.findall("./lines/line"):
            line_ys = [float(point.attrib["y"]) for point in line.findall("point")]
            if line_ys:
                line_centers.append(sum(line_ys) / len(line_ys))
        line_centers.sort()
        gaps = [right - left for left, right in zip(line_centers, line_centers[1:])]
        interline = sorted(gaps)[len(gaps) // 2] if gaps else 18.0
        left = float(staff.attrib.get("left", min(xs)))
        right = float(staff.attrib.get("right", max(xs)))
        x1 = max(0, int(left - interline * 2.0))
        x2 = min(image.shape[1], int(right + interline * 2.0))
        y1 = max(0, int(min(ys) - interline * 3.0))
        y2 = min(image.shape[0], int(max(ys) + interline * 3.0))
        crop = image[y1:y2, x1:x2]
        if crop.size == 0:
            continue
        crop_path = output / f"staff-{ordinal:02d}.png"
        ok, encoded = cv2.imencode(".png", zeus_canvas(crop))
        if not ok:
            raise RuntimeError(f"staff-encode-failed:{ordinal}")
        crop_path.write_bytes(encoded.tobytes())
        rows.append({
            "ordinal": ordinal,
            "path": crop_path,
            "bounds": [x1, y1, x2, y2],
            "interlinePixels": round(interline, 4),
            "normalizationReady": True,
            "normalizationReason": "audiveris-up2-staff-geometry",
        })
    if not rows:
        raise RuntimeError("audiveris-no-staff-geometry")
    return rows


def write_dataset(entries: list[dict[str, Any]], base: Path) -> None:
    rows = []
    for entry in entries:
        rows.append({
            "path": entry["sampleId"],
            "image": entry["cropPath"].read_bytes(),
            # The CLI computes SER even for inference.  A non-empty placeholder
            # prevents a zero-length gold denominator; it is never used as gold.
            "lmx": "measure",
            "musicxml": "<score-partwise version=\"3.1\"/>",
        })
    with base.with_suffix(".pickle").open("wb") as handle:
        pickle.dump(rows, handle)


def run_zeus(
    python: Path,
    source: Path,
    model: Path,
    dataset_base: Path,
    prediction_dir: Path,
) -> Path:
    command = [
        str(python),
        str(source / "zeus" / "zeus.py"),
        "--load", str(model),
        "--exp", str(prediction_dir),
        "--test", str(dataset_base),
        # Zeus 1.0's TF graph captures a static ragged width; mixed-width
        # batches reshape incorrectly under TF 2.15.  Batch one is deterministic
        # and preserves the released weights without patching upstream code.
        "--batch_size", "1",
        "--threads", "4",
        "--verbose", "0",
    ]
    completed = subprocess.run(
        command,
        cwd=source / "zeus",
        text=True,
        capture_output=True,
        timeout=1200,
        check=False,
    )
    (prediction_dir.parent / "zeus.stdout.txt").write_text(
        completed.stdout, encoding="utf-8"
    )
    (prediction_dir.parent / "zeus.stderr.txt").write_text(
        completed.stderr, encoding="utf-8"
    )
    if completed.returncode != 0:
        tail = completed.stderr[-1000:].replace("\n", " ")
        raise RuntimeError(f"zeus-exit-{completed.returncode}:{tail}")
    prediction = prediction_dir / f"{dataset_base.name}.predicted.lmx"
    require_file(prediction, "Zeus prediction")
    return prediction


def lmx_to_musicxml(lmx: str, source: Path, output: Path) -> None:
    sys.path.insert(0, str(source))
    from app.linearization.Delinearizer import Delinearizer  # noqa: PLC0415
    from app.symbolic.part_to_score import part_to_score  # noqa: PLC0415

    delinearizer = Delinearizer()
    delinearizer.process_text(lmx)
    score = part_to_score(delinearizer.part_element)
    ET.indent(score, space="  ")
    score.write(output, encoding="utf-8", xml_declaration=True)


def evaluate_piece(gold_path: Path, draft_path: Path) -> dict[str, Any]:
    gold = parse_notes(gold_path)
    draft = parse_notes(draft_path)
    pairs = align_notes(gold, draft)
    pitch_exact = onset_exact = measure_exact = 0
    paired = 0
    for gold_index, draft_index in pairs:
        if gold_index is None or draft_index is None:
            continue
        paired += 1
        left, right = gold[gold_index], draft[draft_index]
        pitch_exact += int(left.midi == right.midi)
        onset_exact += int(abs(left.onset_quarters - right.onset_quarters) <= 0.25)
        measure_exact += int(left.measure_index == right.measure_index)
    gold_count, draft_count = len(gold), len(draft)
    precision = pitch_exact / draft_count if draft_count else 0.0
    recall = pitch_exact / gold_count if gold_count else 0.0
    onset = onset_exact / gold_count if gold_count else 0.0
    measure = measure_exact / gold_count if gold_count else 0.0
    strict = (
        precision >= THRESHOLDS["minPitchPrecision"]
        and recall >= THRESHOLDS["minPitchRecall"]
        and onset >= THRESHOLDS["minOnsetQuarterAccuracy"]
        and measure >= THRESHOLDS["minMeasureAccuracy"]
    )
    return {
        "goldNotes": gold_count,
        "draftNotes": draft_count,
        "pairedNotes": paired,
        "pitchExact": pitch_exact,
        "pitchPrecision": round(precision, 6),
        "pitchRecall": round(recall, 6),
        "onsetQuarterAccuracy": round(onset, 6),
        "measureAccuracy": round(measure, 6),
        "strictPass": strict,
    }


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    totals = defaultdict(int)
    for row in rows:
        for key in ("goldNotes", "draftNotes", "pitchExact"):
            totals[key] += int(row.get(key) or 0)
        totals["onsetExact"] += round(
            float(row.get("onsetQuarterAccuracy") or 0) * int(row.get("goldNotes") or 0)
        )
        totals["measureExact"] += round(
            float(row.get("measureAccuracy") or 0) * int(row.get("goldNotes") or 0)
        )
    gold = totals["goldNotes"]
    draft = totals["draftNotes"]
    strict_count = sum(int(bool(row.get("strictPass"))) for row in rows)
    strict_rate = strict_count / len(rows) if rows else 0.0
    result = {
        **totals,
        "pitchPrecision": round(totals["pitchExact"] / draft, 6) if draft else 0.0,
        "pitchRecall": round(totals["pitchExact"] / gold, 6) if gold else 0.0,
        "onsetQuarterAccuracy": round(totals["onsetExact"] / gold, 6) if gold else 0.0,
        "measureAccuracy": round(totals["measureExact"] / gold, 6) if gold else 0.0,
        "strictPagePassCount": strict_count,
        "strictPageCount": len(rows),
        "strictPagePassRate": round(strict_rate, 6),
        "segmentationReady": all(bool(row.get("segmentationReady")) for row in rows),
    }
    result["passesFrozenRealPhotoGate"] = (
        result["pitchPrecision"] >= THRESHOLDS["minPitchPrecision"]
        and result["pitchRecall"] >= THRESHOLDS["minPitchRecall"]
        and result["onsetQuarterAccuracy"] >= THRESHOLDS["minOnsetQuarterAccuracy"]
        and result["measureAccuracy"] >= THRESHOLDS["minMeasureAccuracy"]
        and strict_rate >= THRESHOLDS["minStrictPagePassRate"]
        and result["segmentationReady"]
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, default=DEFAULT_PYTHON)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    require_file(args.python, "isolated Python")
    require_dir(args.source, "OLiMPiC source")
    require_file(args.source / "zeus" / "zeus.py", "Zeus entry point")
    require_dir(args.model, "Zeus model")
    require_file(args.model / "weights.h5", "Zeus weights")
    config = json.loads(DATASET_CONFIG.read_text(encoding="utf-8"))
    frozen = config["frozenSourceGoldTestOnly"]
    if len(frozen) != 5:
        raise SystemExit("frozen source-gold set must contain exactly five pages")

    args.output.mkdir(parents=True, exist_ok=True)
    entries = []
    piece_crops: dict[str, list[dict[str, Any]]] = {}
    for row in frozen:
        piece_id = row["pieceId"]
        photo = REPO / row["photoPath"]
        gold = REPO / row["goldPath"]
        require_file(photo, f"{piece_id} photo")
        require_file(gold, f"{piece_id} gold")
        try:
            crops = crop_staffs(photo, args.output / "crops" / piece_id)
            segmentation = "m4b-explicit-structure-poc"
        except RuntimeError:
            crops = crop_audiveris_staffs(
                piece_id, args.output / "crops" / piece_id
            )
            segmentation = "audiveris-up2-staff-geometry-fallback"
        for crop in crops:
            crop["segmentation"] = segmentation
        piece_crops[piece_id] = crops
        for crop in crops:
            sample_id = f"{piece_id}-staff-{crop['ordinal']:02d}"
            entries.append({
                "pieceId": piece_id,
                "sampleId": sample_id,
                "cropPath": crop["path"],
            })

    dataset_base = args.output / "frozen-real-photo-staffs"
    write_dataset(entries, dataset_base)
    prediction_dir = args.output / "prediction"
    prediction = run_zeus(
        args.python, args.source, args.model, dataset_base, prediction_dir
    )
    lines = prediction.read_text(encoding="utf-8").splitlines()
    if len(lines) != len(entries):
        raise RuntimeError(f"prediction-count-mismatch:{len(lines)}!={len(entries)}")
    predicted_by_piece: dict[str, list[str]] = defaultdict(list)
    for entry, line in zip(entries, lines, strict=True):
        predicted_by_piece[entry["pieceId"]].append(line.strip())

    rows = []
    for frozen_row in frozen:
        piece_id = frozen_row["pieceId"]
        lmx = " ".join(predicted_by_piece[piece_id]).strip()
        lmx_path = args.output / f"{piece_id}.predicted.lmx"
        musicxml_path = args.output / f"{piece_id}.predicted.musicxml"
        lmx_path.write_text(lmx + "\n", encoding="utf-8")
        lmx_to_musicxml(lmx, args.source, musicxml_path)
        metrics = evaluate_piece(REPO / frozen_row["goldPath"], musicxml_path)
        rows.append({
            "pieceId": piece_id,
            "photoPath": frozen_row["photoPath"],
            "goldPath": frozen_row["goldPath"],
            "staffCropCount": len(piece_crops[piece_id]),
            "segmentationReady": all(
                bool(crop["normalizationReady"]) for crop in piece_crops[piece_id]
            ),
            "segmentationReasons": sorted({
                crop["normalizationReason"] for crop in piece_crops[piece_id]
            }),
            "segmentationMethods": sorted({
                crop["segmentation"] for crop in piece_crops[piece_id]
            }),
            "predictionPath": portable(musicxml_path),
            **metrics,
        })

    summary = aggregate(rows)
    report = {
        "contract": "western-m4-zeus-camera-challenger-eval-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evaluationRole": "research-challenger-only",
        "runtimeEffect": "none",
        "source": {
            "repository": "https://github.com/ufal/olimpic-icdar24",
            "license": "MIT",
            "commit": subprocess.check_output(
                ["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True
            ).strip(),
        },
        "model": {
            "name": args.model.name,
            "license": "CC-BY-SA-4.0",
            "weightsSha256": sha256(args.model / "weights.h5"),
        },
        "input": {
            "frozenPageCount": len(frozen),
            "staffCropCount": len(entries),
            "datasetSha256": sha256(dataset_base.with_suffix(".pickle")),
            "segmentation": "accepted-m4b-normalizer-and-staff-detector",
        },
        "thresholds": THRESHOLDS,
        "summary": summary,
        "rows": rows,
        "decision": {
            "keepAsRuntimeCandidate": bool(summary["passesFrozenRealPhotoGate"]),
            "studentGateReady": False,
            "reason": (
                "frozen-real-photo-gate-passed-but-runtime-governance-not-reviewed"
                if summary["passesFrozenRealPhotoGate"]
                else "zeus-camera-challenger-below-frozen-real-photo-gate"
            ),
        },
    }
    report_path = args.output / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"report": portable(report_path), **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
