#!/usr/bin/env python3
"""Prepare a bounded DoReMi Stage-B adaptation pilot without blind-test leakage.

DoReMi provides full-page images, page-level MUSCIMA annotations, and a full
MusicXML score. The selected quartet pages contain one system per page. This
adapter uses the annotated staff lines to crop each staff, uses annotated
barlines to split the corresponding measures from MusicXML, and pairs the
top-to-bottom crops with Clarity's official per-part token sequences.

The public archive does not contain a dataset license file. Outputs are marked
local eval-only and must not be redistributed or connected to student runtime.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


REPO = Path(__file__).resolve().parents[2]
M4_ROOT = (REPO / "data" / "experiments" / "western-strings-m4").resolve()
DEFAULT_SOURCE = (
    M4_ROOT
    / "public-score-corpora"
    / "doremi-v1"
    / "pilot-extracted"
)
DEFAULT_CLARITY_TRAIN = M4_ROOT / "clarity-train-source-audit"
DEFAULT_OUT = M4_ROOT / "doremi-clarity-adaptation-pilot"
BLIND_GOLD_ROOT = M4_ROOT / "independent-real-photo-gold"


@dataclass(frozen=True)
class WorkSpec:
    name: str
    work_id: str
    split: str
    max_pages: int


WORK_SPECS = (
    WorkSpec("Bartok - String Quartet 5 mvt 3", "doremi-bartok-sq5-m3", "train", 24),
    WorkSpec("Delius - String Quartet mvt III", "doremi-delius-sq-m3", "validation", 12),
    WorkSpec("Schumann - String Quartet 1 mvt 3", "doremi-schumann-sq1-m3", "synthetic-test", 12),
)
EXPECTED_SPLITS = ("train", "validation", "synthetic-test")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--clarity-train-root", type=Path, default=DEFAULT_CLARITY_TRAIN)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--reset-output", action="store_true")
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_output_root(path: Path) -> None:
    if path == M4_ROOT or not path.is_relative_to(M4_ROOT):
        raise RuntimeError(f"Unsafe DoReMi output root: {path}")
    if path.is_relative_to(BLIND_GOLD_ROOT.resolve()):
        raise RuntimeError("DoReMi pilot output must not touch frozen blind gold.")


def load_clarity_tokenizer(train_root: Path):
    module_path = train_root / "src" / "data" / "convert_tokens.py"
    if not module_path.is_file():
        raise FileNotFoundError(f"Clarity tokenizer missing: {module_path}")
    train_root_text = str(train_root)
    if train_root_text not in sys.path:
        sys.path.insert(0, train_root_text)
    spec = importlib.util.spec_from_file_location("m4_clarity_convert_tokens", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load Clarity tokenizer: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def find_unique(root: Path, folder: str, pattern: str) -> Path:
    matches = sorted((root / folder).glob(pattern))
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected one {folder}/{pattern} source, found {len(matches)}: {matches[:5]}"
        )
    return matches[0].resolve()


def page_number(path: Path) -> int:
    match = re.search(r"(?:Page_|-)(\d+)(?:\.xml|\.png)$", path.name)
    if match is None:
        raise ValueError(f"Could not parse page number: {path.name}")
    return int(match.group(1))


def annotation_nodes(path: Path) -> list[dict[str, int | str]]:
    rows: list[dict[str, int | str]] = []
    for node in ET.parse(path).findall(".//Node"):
        rows.append(
            {
                "class_name": node.findtext("ClassName", ""),
                "top": int(node.findtext("Top", "0")),
                "left": int(node.findtext("Left", "0")),
                "width": int(node.findtext("Width", "0")),
                "height": int(node.findtext("Height", "0")),
            }
        )
    return rows


def split_page_musicxml(source: Path, output: Path, start_index: int, count: int) -> None:
    tree = ET.parse(source)
    root = tree.getroot()
    parts = root.findall("part")
    if not parts:
        raise RuntimeError(f"MusicXML contains no parts: {source}")
    measure_counts = {len(part.findall("measure")) for part in parts}
    if len(measure_counts) != 1:
        raise RuntimeError(f"MusicXML part measure counts differ: {source} {measure_counts}")
    total = next(iter(measure_counts))
    if start_index < 0 or count < 1 or start_index + count > total:
        raise RuntimeError(
            f"Invalid page measure slice start={start_index} count={count} total={total}"
        )

    for part in parts:
        measures = part.findall("measure")
        carried_attributes = None
        for measure in measures[:start_index]:
            attributes = measure.find("attributes")
            if attributes is not None:
                carried_attributes = copy.deepcopy(attributes)
        selected = set(measures[start_index : start_index + count])
        for measure in measures:
            if measure not in selected:
                part.remove(measure)
        first_measure = part.find("measure")
        if (
            first_measure is not None
            and first_measure.find("attributes") is None
            and carried_attributes is not None
        ):
            first_measure.insert(0, copy.deepcopy(carried_attributes))

    output.parent.mkdir(parents=True, exist_ok=True)
    tree.write(output, encoding="utf-8", xml_declaration=True)


def group_staff_lines(nodes: list[dict[str, int | str]]) -> list[list[dict[str, int | str]]]:
    lines = sorted(
        (row for row in nodes if row["class_name"] == "kStaffLine"),
        key=lambda row: (int(row["top"]), int(row["left"])),
    )
    if not lines or len(lines) % 5:
        raise RuntimeError(f"Expected a non-zero multiple of five staff lines, got {len(lines)}")
    groups = [lines[index : index + 5] for index in range(0, len(lines), 5)]
    for group in groups:
        tops = [int(row["top"]) for row in group]
        if tops != sorted(tops):
            raise RuntimeError(f"Staff-line ordering is invalid: {tops}")
    return groups


def crop_staffs(image_path: Path, groups: list[list[dict[str, int | str]]], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as source_image:
        image = source_image.convert("L")
        image_width, image_height = image.size
        left = max(0, min(int(line["left"]) for group in groups for line in group) - 160)
        right = min(
            image_width,
            max(int(line["left"]) + int(line["width"]) for group in groups for line in group)
            + 160,
        )
        staff_tops = [min(int(line["top"]) for line in group) for group in groups]
        staff_bottoms = [
            max(int(line["top"]) + int(line["height"]) for line in group) for group in groups
        ]
        boundaries = [0]
        for index in range(len(groups) - 1):
            boundaries.append((staff_bottoms[index] + staff_tops[index + 1]) // 2)
        boundaries.append(image_height)

        crops: list[Path] = []
        for index, _ in enumerate(groups):
            top = max(boundaries[index], staff_tops[index] - 160)
            bottom = min(boundaries[index + 1], staff_bottoms[index] + 180)
            if right - left < 256 or bottom - top < 64:
                raise RuntimeError(
                    f"Suspicious staff crop on {image_path.name}: {(left, top, right, bottom)}"
                )
            crop = image.crop((left, top, right, bottom))
            output = out_dir / f"staff-{index + 1:02d}.png"
            crop.save(output)
            crops.append(output.resolve())
    return crops


def crop_ink_fraction(path: Path) -> float:
    with Image.open(path) as image:
        gray = image.convert("L")
        histogram = gray.histogram()
        dark = sum(histogram[:220])
        return dark / max(1, gray.width * gray.height)


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    source_root = args.source_root.resolve()
    train_root = args.clarity_train_root.resolve()
    output_root = args.out.resolve()
    validate_output_root(output_root)
    if not source_root.is_dir():
        raise FileNotFoundError(f"DoReMi pilot source missing: {source_root}")
    if args.reset_output and output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    tokenizer = load_clarity_tokenizer(train_root)
    output_rows: list[dict] = []
    work_reports: list[dict] = []
    for work in WORK_SPECS:
        source_musicxml = find_unique(source_root, "MusicXML", f"{work.name}*.xml")
        images = {
            page_number(path): path.resolve()
            for path in (source_root / "Images").glob(f"{work.name}-*.png")
        }
        annotations = {
            page_number(path): path.resolve()
            for path in (source_root / "Parsed_by_page_omr_xml").glob(
                f"Parsed_{work.name}*Page_*.xml"
            )
        }
        selected_pages = list(range(1, work.max_pages + 1))
        missing_images = sorted(set(selected_pages) - set(images))
        missing_annotations = sorted(set(selected_pages) - set(annotations))
        if missing_images or missing_annotations:
            raise RuntimeError(
                f"{work.work_id} selected pages are incomplete: "
                f"images={missing_images}, annotations={missing_annotations}"
            )

        measure_cursor = 0
        work_rows: list[dict] = []
        page_reports: list[dict] = []
        for page in selected_pages:
            nodes = annotation_nodes(annotations[page])
            measure_count = sum(row["class_name"] == "barline" for row in nodes)
            if measure_count < 1:
                raise RuntimeError(f"{work.work_id} page {page} has no annotated barlines.")
            page_dir = output_root / "pages" / work.split / work.work_id / f"page-{page:03d}"
            page_score = page_dir / "page.musicxml"
            split_page_musicxml(source_musicxml, page_score, measure_cursor, measure_count)
            tokens = tokenizer.convert_musicxml_file(page_score)
            staff_tokens = tokenizer._split_staff_sequences_for_validation(tokens)
            for sequence in staff_tokens:
                tokenizer.validate_token_sequence(sequence, strict=False)

            staff_groups = group_staff_lines(nodes)
            staff_crops = crop_staffs(images[page], staff_groups, page_dir / "staff-crops")
            if len(staff_crops) != len(staff_tokens):
                raise RuntimeError(
                    f"{work.work_id} page {page} crop/token mismatch: "
                    f"{len(staff_crops)} != {len(staff_tokens)}"
                )

            for staff_index, (crop_path, sequence) in enumerate(
                zip(staff_crops, staff_tokens, strict=True), start=1
            ):
                ink_fraction = crop_ink_fraction(crop_path)
                if not 0.005 <= ink_fraction <= 0.50:
                    raise RuntimeError(
                        f"Suspicious crop ink fraction {ink_fraction:.6f}: {crop_path}"
                    )
                row = {
                    "sample_id": f"{work.work_id}-p{page:03d}-s{staff_index:02d}",
                    "dataset": "doremi-v1-local-eval-only",
                    "split": work.split,
                    "work_id": work.work_id,
                    "page_number": page,
                    "staff_index": staff_index,
                    "source_measure_start": measure_cursor + 1,
                    "source_measure_end": measure_cursor + measure_count,
                    "image_path": str(crop_path),
                    "source_path": str(page_score.resolve()),
                    "source_score_path": str(source_musicxml),
                    "source_page_image_path": str(images[page]),
                    "source_page_annotation_path": str(annotations[page]),
                    "image_sha256": sha256_file(crop_path),
                    "image_ink_fraction": round(ink_fraction, 6),
                    "token_sequence": sequence,
                    "token_count": len(sequence),
                    "license_status": "unverified-local-eval-only",
                }
                work_rows.append(row)
                output_rows.append(row)
            page_reports.append(
                {
                    "page": page,
                    "measureStart": measure_cursor + 1,
                    "measureEnd": measure_cursor + measure_count,
                    "measureCount": measure_count,
                    "staffCount": len(staff_crops),
                    "maxTokenCount": max(len(sequence) for sequence in staff_tokens),
                }
            )
            measure_cursor += measure_count

        work_reports.append(
            {
                "workId": work.work_id,
                "sourceName": work.name,
                "split": work.split,
                "selectedPageCount": len(selected_pages),
                "generatedStaffPairCount": len(work_rows),
                "selectedMeasureCount": measure_cursor,
                "pages": page_reports,
            }
        )

    split_counts = Counter(str(row["split"]) for row in output_rows)
    work_ids_by_split = {
        split: sorted({str(row["work_id"]) for row in output_rows if row["split"] == split})
        for split in EXPECTED_SPLITS
    }
    overlap = {
        f"{left}:{right}": sorted(set(work_ids_by_split[left]) & set(work_ids_by_split[right]))
        for index, left in enumerate(EXPECTED_SPLITS)
        for right in EXPECTED_SPLITS[index + 1 :]
        if set(work_ids_by_split[left]) & set(work_ids_by_split[right])
    }
    image_hashes = [str(row["image_sha256"]) for row in output_rows]
    duplicate_hashes = sorted(
        image_hash for image_hash, count in Counter(image_hashes).items() if count > 1
    )
    long_sequences = [row["sample_id"] for row in output_rows if int(row["token_count"]) > 256]

    manifests = {}
    for split in EXPECTED_SPLITS:
        path = output_root / f"doremi-clarity-{split}-tokens.jsonl"
        write_jsonl(path, [row for row in output_rows if row["split"] == split])
        manifests[split] = str(path)
    combined_manifest = output_root / "doremi-clarity-all-tokens.jsonl"
    write_jsonl(combined_manifest, output_rows)

    ready = bool(
        output_rows
        and all(split_counts[split] > 0 for split in EXPECTED_SPLITS)
        and not overlap
        and not duplicate_hashes
        and not long_sequences
    )
    report = {
        "schemaVersion": 1,
        "purpose": "M4 bounded DoReMi Stage-B adaptation feasibility pilot",
        "evalOnly": True,
        "studentRuntimeTouched": False,
        "studentGateReady": False,
        "blindHoldoutContaminated": False,
        "licenseStatus": "unverified-local-eval-only",
        "sourceRoot": str(source_root),
        "workReports": work_reports,
        "staffPairCount": len(output_rows),
        "splitCounts": dict(split_counts),
        "workIdsBySplit": work_ids_by_split,
        "workOverlap": overlap,
        "duplicateImageHashCount": len(duplicate_hashes),
        "overLengthSequenceCount": len(long_sequences),
        "overLengthSequences": long_sequences,
        "datasetReady": ready,
        "artifacts": {"combinedManifest": str(combined_manifest), **manifests},
    }
    report_path = output_root / "doremi-clarity-adaptation-readiness.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
