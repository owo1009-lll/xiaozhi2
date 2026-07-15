#!/usr/bin/env python3
"""Generate a low-load, work-disjoint Clarity adaptation dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from collections import Counter
from pathlib import Path

from probe_western_strings_m4_clarity_adaptation import (
    BLIND_GOLD_ROOT,
    DEFAULT_CLARITY_TRAIN,
    _is_relative_to,
    image_sanity_metrics,
    install_node_rasterizer,
    install_training_crop_padding,
    install_verovio_musicxml_loader,
    load_generator,
    read_jsonl,
)


REPO = Path(__file__).resolve().parents[2]
M4_ROOT = (REPO / "data" / "experiments" / "western-strings-m4").resolve()
DEFAULT_SPLIT_MANIFEST = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-adaptation-split"
    / "clarity-adaptation-source-split.jsonl"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-adaptation-dataset"
)
EXPECTED_SOURCE_COUNTS = {"train": 21, "validation": 4, "synthetic-test": 7}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_managed_output_root(output_root: Path) -> None:
    if output_root == M4_ROOT or not output_root.is_relative_to(M4_ROOT):
        raise RuntimeError(
            "Adaptation output must be a child of data/experiments/western-strings-m4; "
            f"refusing unsafe output root: {output_root}"
        )


def validate_source_split(rows: list[dict]) -> dict:
    sample_ids = [str(row.get("sample_id", "")).strip() for row in rows]
    if any(not sample_id for sample_id in sample_ids):
        raise RuntimeError("Adaptation split contains a blank sample_id.")
    duplicate_sample_ids = sorted(
        sample_id for sample_id, count in Counter(sample_ids).items() if count > 1
    )
    if duplicate_sample_ids:
        raise RuntimeError(f"Adaptation split contains duplicate sample IDs: {duplicate_sample_ids}")

    work_splits: dict[str, set[str]] = {}
    for row in rows:
        work_id = str(row.get("work_id", "")).strip()
        split = str(row.get("split", "")).strip()
        if not work_id:
            raise RuntimeError("Adaptation split contains a blank work_id.")
        work_splits.setdefault(work_id, set()).add(split)
    overlap = {
        work_id: sorted(splits)
        for work_id, splits in work_splits.items()
        if len(splits) > 1
    }
    if overlap:
        raise RuntimeError(f"Adaptation works cross split boundaries: {overlap}")
    return {
        "workIdsBySplit": {
            split: sorted(work_id for work_id, splits in work_splits.items() if split in splits)
            for split in EXPECTED_SOURCE_COUNTS
        },
        "workOverlap": overlap,
    }


def extract_musicxml(source_path: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not zipfile.is_zipfile(source_path):
        shutil.copy2(source_path, destination)
        return destination
    with zipfile.ZipFile(source_path) as archive:
        candidates = [
            name
            for name in archive.namelist()
            if name.lower().endswith((".xml", ".musicxml"))
            and not name.lower().startswith("meta-inf/")
        ]
        if not candidates:
            raise RuntimeError(f"No MusicXML payload found inside {source_path}")
        destination.write_bytes(archive.read(candidates[0]))
    return destination


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clarity-train-root", type=Path, default=DEFAULT_CLARITY_TRAIN)
    parser.add_argument("--split-manifest", type=Path, default=DEFAULT_SPLIT_MANIFEST)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--style", default="leipzig-default")
    parser.add_argument("--max-pages-per-score", type=int, default=1)
    parser.add_argument("--reset-output", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    train_root = args.clarity_train_root.resolve()
    split_manifest = args.split_manifest.resolve()
    output_root = args.out.resolve()
    blind_root = BLIND_GOLD_ROOT.resolve()
    validate_managed_output_root(output_root)
    if not split_manifest.exists():
        raise FileNotFoundError(f"Adaptation split manifest not found: {split_manifest}")
    if args.reset_output and output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    split_rows = read_jsonl(split_manifest)
    source_counts = Counter(str(row.get("split", "")) for row in split_rows)
    if dict(source_counts) != EXPECTED_SOURCE_COUNTS:
        raise RuntimeError(
            f"Unexpected source split counts: {dict(source_counts)} != {EXPECTED_SOURCE_COUNTS}"
        )
    split_audit = validate_source_split(split_rows)

    generator_rows: list[dict] = []
    metadata_by_source: dict[str, dict] = {}
    for row in split_rows:
        source_path = Path(str(row["musicxml_path"])).resolve()
        if not source_path.exists():
            raise FileNotFoundError(f"Split source score missing: {source_path}")
        if _is_relative_to(source_path, blind_root):
            raise RuntimeError("Blind real-photo gold must never enter adaptation generation.")
        split = str(row["split"])
        sample_id = str(row["sample_id"])
        generator_path = extract_musicxml(
            source_path,
            output_root / "sources" / split / f"{sample_id}.musicxml",
        ).resolve()
        metadata = {
            "sample_id": sample_id,
            "work_id": str(row["work_id"]),
            "split": split,
            "source_score_path": str(source_path),
            "generator_score_path": str(generator_path),
        }
        metadata_by_source[str(generator_path).lower()] = metadata
        generator_rows.append(
            {
                "sample_id": sample_id,
                "dataset": "m4_bach_violin_adaptation",
                "split": split,
                "musicxml_path": str(generator_path),
            }
        )

    source_manifest = output_root / "clarity-adaptation-source-manifest.jsonl"
    source_manifest.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in generator_rows),
        encoding="utf-8",
    )
    generator = load_generator(train_root)
    with tempfile.TemporaryDirectory(prefix="m4-clarity-dataset-raster-") as scratch:
        install_verovio_musicxml_loader(generator)
        install_node_rasterizer(generator, Path(scratch))
        install_training_crop_padding(generator)
        official_summary = generator.run(
            project_root=train_root,
            data_root=train_root / "data",
            input_manifest=source_manifest,
            output_dir=output_root / "generated",
            style_ids=[args.style],
            max_scores=len(generator_rows),
            max_pages_per_score=max(1, args.max_pages_per_score),
            seed=1337,
            render=True,
            write_png=True,
            roundtrip_validate=False,
            show_verovio_warnings=False,
            workers=1,
            allow_fallback_labels=False,
        )

    official_manifest = (
        output_root / "generated" / "manifests" / "synthetic_token_manifest.jsonl"
    )
    official_rows = read_jsonl(official_manifest)
    output_rows: list[dict] = []
    seen_pairs: set[tuple[str, str]] = set()
    duplicate_count = 0
    missing_images: list[str] = []
    invalid_tokens: list[str] = []
    unmapped_sources: list[str] = []
    source_sample_ids: set[str] = set()
    visual_paths: dict[str, Path] = {}
    for row in official_rows:
        source_path = Path(str(row.get("source_path", "")))
        if not source_path.is_absolute():
            source_path = (train_root / source_path).resolve()
        else:
            source_path = source_path.resolve()
        metadata = metadata_by_source.get(str(source_path).lower())
        if metadata is None:
            unmapped_sources.append(str(source_path))
            continue
        image_path = Path(str(row.get("image_path", "")))
        if not image_path.is_absolute():
            image_path = (train_root / image_path).resolve()
        else:
            image_path = image_path.resolve()
        if not image_path.exists():
            missing_images.append(str(image_path))
            continue
        tokens = row.get("token_sequence")
        if not isinstance(tokens, list) or tokens[:1] != ["<bos>"] or tokens[-1:] != ["<eos>"]:
            invalid_tokens.append(str(row.get("sample_id", "")))
            continue
        pair_key = (str(image_path).lower(), json.dumps(tokens, separators=(",", ":")))
        if pair_key in seen_pairs:
            duplicate_count += 1
            continue
        seen_pairs.add(pair_key)
        normalized = dict(row)
        normalized.update(
            {
                "dataset": "m4_bach_violin_adaptation",
                "split": metadata["split"],
                "work_id": metadata["work_id"],
                "source_sample_id": metadata["sample_id"],
                "source_score_path": metadata["source_score_path"],
                "image_path": str(image_path),
                "source_path": str(source_path),
                "image_sha256": sha256_file(image_path),
            }
        )
        output_rows.append(normalized)
        source_sample_ids.add(metadata["sample_id"])
        visual_paths[str(image_path)] = image_path

    manifests: dict[str, Path] = {}
    for split in ("train", "validation", "synthetic-test"):
        path = output_root / f"clarity-adaptation-{split}-tokens.jsonl"
        split_output = [row for row in output_rows if row["split"] == split]
        path.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in split_output),
            encoding="utf-8",
        )
        manifests[split] = path
    combined_manifest = output_root / "clarity-adaptation-all-tokens.jsonl"
    combined_manifest.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in output_rows),
        encoding="utf-8",
    )

    visual_metrics = {
        path_text: image_sanity_metrics(path)
        for path_text, path in sorted(visual_paths.items())
    }
    suspicious = [path for path, metrics in visual_metrics.items() if metrics["suspicious"]]
    token_counts = Counter(str(row["split"]) for row in output_rows)
    image_hashes_by_split = {
        split: {
            str(row.get("image_sha256", ""))
            for row in output_rows
            if row.get("split") == split and row.get("image_sha256")
        }
        for split in EXPECTED_SOURCE_COUNTS
    }
    split_pairs = (
        ("train", "validation"),
        ("train", "synthetic-test"),
        ("validation", "synthetic-test"),
    )
    image_hash_overlap = {
        f"{left}:{right}": sorted(image_hashes_by_split[left] & image_hashes_by_split[right])
        for left, right in split_pairs
        if image_hashes_by_split[left] & image_hashes_by_split[right]
    }
    missing_sources = sorted(set(metadata["sample_id"] for metadata in metadata_by_source.values()) - source_sample_ids)
    ready = bool(
        output_rows
        and all(token_counts[split] > 0 for split in EXPECTED_SOURCE_COUNTS)
        and not missing_sources
        and not missing_images
        and not invalid_tokens
        and not unmapped_sources
        and not suspicious
        and not image_hash_overlap
        and int(official_summary.get("token_pairing_mismatches", 0) or 0) == 0
    )
    report = {
        "schemaVersion": 1,
        "purpose": "M4 low-load work-disjoint Clarity adaptation dataset",
        "evalOnly": True,
        "studentRuntimeTouched": False,
        "blindHoldoutContaminated": False,
        "style": args.style,
        "maxPagesPerScore": max(1, args.max_pages_per_score),
        "sourceCounts": dict(source_counts),
        "splitAudit": split_audit,
        "generatedSourceCount": len(source_sample_ids),
        "tokenCounts": dict(token_counts),
        "officialTokenRowCount": len(official_rows),
        "deduplicatedTokenRowCount": len(output_rows),
        "duplicateImageTokenPairCount": duplicate_count,
        "missingSourceCount": len(missing_sources),
        "missingSources": missing_sources,
        "missingImageCount": len(missing_images),
        "invalidTokenSequenceCount": len(invalid_tokens),
        "unmappedSourceCount": len(unmapped_sources),
        "suspiciousVisualSampleCount": len(suspicious),
        "crossSplitImageHashOverlap": image_hash_overlap,
        "tokenPairingMismatchCount": int(
            official_summary.get("token_pairing_mismatches", 0) or 0
        ),
        "datasetReady": ready,
        "artifacts": {
            "sourceManifest": str(source_manifest),
            "combinedTokenManifest": str(combined_manifest),
            "trainTokenManifest": str(manifests["train"]),
            "validationTokenManifest": str(manifests["validation"]),
            "syntheticTestTokenManifest": str(manifests["synthetic-test"]),
        },
    }
    report_path = output_root / "clarity-adaptation-dataset-readiness.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
