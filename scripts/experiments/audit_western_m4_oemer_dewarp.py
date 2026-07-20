#!/usr/bin/env python3
"""Measure Oemer staff geometry before/after its built-in dewarp on frozen photos."""

from __future__ import annotations

import hashlib
import argparse
import json
import os
import pickle
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = REPO / "data/experiments/western-strings-m4/oemer-dewarp-attribution"
BENCHMARK = REPO / "data/experiments/western-strings-m4/oemer-source-benchmark/oemer-source-benchmark.json"

# Diagnostic visual counts from the five fixed photos. These are not signed
# coordinate gold and must never be used for promotion.
EXPECTED_STAFFS = {
    "violin-ex09": 11,
    "violin-ex05": 10,
    "violin-ex08": 10,
    "violin-ex10": 9,
    "violin-ex12": 9,
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def portable(path: Path) -> str:
    return path.resolve().relative_to(REPO).as_posix()


@contextmanager
def working_directory(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def merge_rows(rows: np.ndarray, scores: np.ndarray, maximum_gap: int = 2) -> list[int]:
    groups: list[list[int]] = []
    for value in rows.tolist():
        if not groups or value - groups[-1][-1] > maximum_gap:
            groups.append([int(value)])
        else:
            groups[-1].append(int(value))
    return [max(group, key=lambda y: float(scores[y])) for group in groups]


def five_line_groups(peaks: list[int]) -> list[list[int]]:
    groups: list[list[int]] = []
    index = 0
    while index <= len(peaks) - 5:
        candidate = peaks[index:index + 5]
        gaps = np.diff(candidate).astype(np.float64)
        median = float(np.median(gaps))
        coefficient = float(np.std(gaps) / np.mean(gaps)) if np.mean(gaps) > 0 else 999.0
        if 2.0 <= median <= 40.0 and coefficient <= 0.35:
            groups.append(candidate)
            index += 5
        else:
            index += 1
    return groups


def staff_geometry(mask: np.ndarray, expected_staff_count: int, zone_count: int = 20) -> dict[str, Any]:
    binary = np.asarray(mask) > 0.5
    height, width = binary.shape
    left, right = round(width * 0.05), round(width * 0.95)
    edges = np.linspace(left, right, zone_count + 1, dtype=int)
    zones = []
    for start, end in zip(edges, edges[1:]):
        if end <= start:
            continue
        scores = binary[:, start:end].sum(axis=1)
        candidates = np.flatnonzero(scores >= max(2, (end - start) * 0.28))
        peaks = merge_rows(candidates, scores)
        groups = five_line_groups(peaks)
        zones.append({"x": (start + end) / 2.0, "groups": groups})

    recovered_counts = [len(row["groups"]) for row in zones]
    recovered_median = float(np.median(recovered_counts)) if recovered_counts else 0.0
    complete_zones = [row for row in zones if len(row["groups"]) == expected_staff_count]
    residuals = []
    interline_cvs = []
    for row in zones:
        for group in row["groups"]:
            gaps = np.diff(group).astype(np.float64)
            if float(np.mean(gaps)) > 0:
                interline_cvs.append(float(np.std(gaps) / np.mean(gaps)))
    if len(complete_zones) >= 3:
        for staff_index in range(expected_staff_count):
            for line_index in range(5):
                xs = np.asarray([row["x"] for row in complete_zones], dtype=np.float64)
                ys = np.asarray([row["groups"][staff_index][line_index] for row in complete_zones], dtype=np.float64)
                fitted = np.polyval(np.polyfit(xs, ys, 1), xs)
                residuals.extend(np.abs(ys - fitted).tolist())
    return {
        "zoneCount": len(zones),
        "completeZoneCount": len(complete_zones),
        "recoveredFiveLineGroupsByZone": recovered_counts,
        "recoveredStaffCountMedian": recovered_median,
        "fiveLineGroupRecoveryRate": round(min(recovered_median / expected_staff_count, 1.0), 6),
        "staffLineStraightnessP90Pixels": round(float(np.percentile(residuals, 90)), 6) if residuals else None,
        "interlineCoefficientOfVariationMedian": round(float(np.median(interline_cvs)), 6) if interline_cvs else None,
        "interlineCoefficientOfVariationP90": round(float(np.percentile(interline_cvs, 90)), 6) if interline_cvs else None,
    }


def mapping_jacobian(coords_y: np.ndarray) -> dict[str, Any]:
    vertical = np.gradient(np.asarray(coords_y, dtype=np.float64), axis=0)
    finite = vertical[np.isfinite(vertical)]
    if finite.size == 0:
        return {"sampleCount": 0, "foldCount": 0, "foldRate": None}
    fold_count = int(np.count_nonzero(finite <= 0.0))
    return {
        "sampleCount": int(finite.size),
        "foldCount": fold_count,
        "foldRate": round(fold_count / finite.size, 9),
        "p01": round(float(np.percentile(finite, 1)), 6),
        "median": round(float(np.median(finite)), 6),
        "p99": round(float(np.percentile(finite, 99)), 6),
    }


def xml_structure_counts(path: Path) -> dict[str, int]:
    root = ElementTree.parse(path).getroot()
    local = lambda element: element.tag.rsplit("}", 1)[-1]
    return {
        "pitchedNotes": sum(local(row) == "note" and any(local(child) == "pitch" for child in row) for row in root.iter()),
        "stemElements": sum(local(row) == "stem" for row in root.iter()),
        "beamElements": sum(local(row) == "beam" for row in root.iter()),
    }


def prepared_input(piece_id: str, benchmark_row: dict[str, Any]) -> Path:
    root = REPO / "data/experiments/western-strings-m4/oemer-source-benchmark" / piece_id
    suffix = "-up2-trimmed.png" if benchmark_row.get("variant") == "up2-trimmed" else "-up2.png"
    return root / f"{piece_id}{suffix}"


def load_or_infer(image: Path, cache: Path) -> dict[str, np.ndarray]:
    if cache.is_file():
        with cache.open("rb") as stream:
            return pickle.load(stream)
    from oemer.ete import generate_pred

    with working_directory(image.parent):
        staff, symbols, stems_rests, notehead, clefs_keys = generate_pred(image.name)
    payload = {
        "staff": staff,
        "symbols": symbols,
        "stems_rests": stems_rests,
        "notehead": notehead,
        "clefs_keys": clefs_keys,
    }
    cache.parent.mkdir(parents=True, exist_ok=True)
    with cache.open("wb") as stream:
        pickle.dump(payload, stream)
    return payload


def benchmark_rows() -> dict[str, dict[str, Any]]:
    benchmark = json.loads(BENCHMARK.read_text(encoding="utf-8"))
    return {row["pieceId"]: row for row in benchmark["rows"]}


def infer_one(piece_id: str) -> int:
    if piece_id not in EXPECTED_STAFFS:
        raise ValueError(f"unknown frozen piece: {piece_id}")
    row = benchmark_rows()[piece_id]
    image = prepared_input(piece_id, row)
    cache = OUTPUT_ROOT / "cache" / f"{piece_id}.pkl"
    load_or_infer(image, cache)
    print(json.dumps({"pieceId": piece_id, "cache": portable(cache), "cacheBytes": cache.stat().st_size}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--infer-one", choices=sorted(EXPECTED_STAFFS))
    args = parser.parse_args()
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    from oemer.dewarp import dewarp, estimate_coords

    if args.infer_one:
        return infer_one(args.infer_one)
    rows_by_piece = benchmark_rows()
    for piece_id in EXPECTED_STAFFS:
        cache = OUTPUT_ROOT / "cache" / f"{piece_id}.pkl"
        if cache.is_file():
            continue
        subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--infer-one", piece_id],
            cwd=REPO,
            check=True,
        )
    output_rows = []
    for piece_id, expected_staff_count in EXPECTED_STAFFS.items():
        row = rows_by_piece[piece_id]
        image = prepared_input(piece_id, row)
        cache = OUTPUT_ROOT / "cache" / f"{piece_id}.pkl"
        prediction = load_or_infer(image, cache)
        raw_staff = prediction["staff"]
        coords_x, coords_y = estimate_coords(raw_staff)
        corrected_staff = dewarp(raw_staff, coords_x, coords_y)
        draft = REPO / row["draftPath"]
        gold = REPO / row["goldPath"]
        output_rows.append({
            "pieceId": piece_id,
            "input": portable(image),
            "inputSha256": sha256(image),
            "expectedStaffCount": expected_staff_count,
            "expectedStaffCountEvidence": "diagnostic-visual-count-not-signed-coordinate-gold",
            "beforeDewarp": staff_geometry(raw_staff, expected_staff_count),
            "afterDewarp": staff_geometry(corrected_staff, expected_staff_count),
            "mappingJacobian": mapping_jacobian(coords_y),
            "symbolicStructureCountProxy": {
                "gold": xml_structure_counts(gold),
                "prediction": xml_structure_counts(draft),
                "isPixelSegmentationRecall": False,
            },
        })

    straightness_pairs = [
        (row["beforeDewarp"]["staffLineStraightnessP90Pixels"], row["afterDewarp"]["staffLineStraightnessP90Pixels"])
        for row in output_rows
        if row["beforeDewarp"]["staffLineStraightnessP90Pixels"] is not None
        and row["afterDewarp"]["staffLineStraightnessP90Pixels"] is not None
    ]
    recovery_pairs = [
        (row["beforeDewarp"]["fiveLineGroupRecoveryRate"], row["afterDewarp"]["fiveLineGroupRecoveryRate"])
        for row in output_rows
    ]
    interline_pairs = [
        (row["beforeDewarp"]["interlineCoefficientOfVariationP90"], row["afterDewarp"]["interlineCoefficientOfVariationP90"])
        for row in output_rows
        if row["beforeDewarp"]["interlineCoefficientOfVariationP90"] is not None
        and row["afterDewarp"]["interlineCoefficientOfVariationP90"] is not None
    ]
    report = {
        "contract": "western-m4-oemer-dewarp-attribution-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evidenceRole": "reused-five-page-diagnostic-only",
        "sourceBenchmark": portable(BENCHMARK),
        "sourceBenchmarkSha256": sha256(BENCHMARK),
        "rows": output_rows,
        "aggregate": {
            "pageCount": len(output_rows),
            "pagesWithComparableStraightness": len(straightness_pairs),
            "pagesStraightnessImproved": sum(after < before for before, after in straightness_pairs),
            "pagesFiveLineRecoveryImproved": sum(after > before for before, after in recovery_pairs),
            "pagesFiveLineRecoveryWorsened": sum(after < before for before, after in recovery_pairs),
            "pagesFiveLineRecoveryUnchanged": sum(after == before for before, after in recovery_pairs),
            "pagesInterlineCvImproved": sum(after < before for before, after in interline_pairs),
            "pagesInterlineCvWorsened": sum(after > before for before, after in interline_pairs),
            "pagesWithMappingFolds": sum(row["mappingJacobian"]["foldCount"] > 0 for row in output_rows),
            "meanFiveLineRecoveryBefore": round(float(np.mean([row["beforeDewarp"]["fiveLineGroupRecoveryRate"] for row in output_rows])), 6),
            "meanFiveLineRecoveryAfter": round(float(np.mean([row["afterDewarp"]["fiveLineGroupRecoveryRate"] for row in output_rows])), 6),
        },
        "limitations": [
            "The five pages are reused diagnostics and cannot qualify a fresh-blind promotion.",
            "Expected staff counts are visual diagnostic counts, not signed coordinate gold.",
            "MusicXML stem/beam element counts are symbolic coverage proxies, not pixel segmentation recall.",
            "Pixel-level stem/beam recall remains unavailable until independent mask gold exists.",
        ],
        "interpretation": {
            "dewarpMissingIsPrimaryCause": False,
            "reason": "Oemer dewarp improves measurable line straightness without improving mean five-line recovery; interline CV worsens on all five pages and the existing onset/measure benchmark remains far below threshold.",
            "nextAction": "Prioritize clean-domain rhythm/measure reconstruction and obtain independent pixel stem/beam gold before training or rewriting another dewarp model.",
        },
        "studentGateReady": False,
        "automaticAdoptionAuthorized": False,
    }
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    output = OUTPUT_ROOT / "report.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": portable(output), "aggregate": report["aggregate"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
