#!/usr/bin/env python3
"""Summarize same-input-image, same-edition M4 OMR engine evidence.

This report deliberately keeps the one-page human transcription separate from
the older five-page source-derived benchmark. It never runs an OMR engine or
changes a runtime gate.

The report does not infer that an input image is a camera photo. Perspective,
page curvature, handwriting, and prior rectification must be audited by the
caller before assigning a photo-domain label.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from eval_western_strings_m4_omr_benchmark import REPO, repo_path
from eval_western_strings_m4_oemer_benchmark import (
    MIN_AUTOMATIC_ADOPTION_ROWS,
    aggregate_metrics,
    automatic_adoption_ready,
)


DEFAULT_AUDIVERIS = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "independent-real-photo-gold" / "beijing-jinshan-up2-vs-adaptive-blind-report.json"
)
DEFAULT_OEMER = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "beijing-same-edition-benchmark" / "oemer" / "oemer-source-benchmark.json"
)
DEFAULT_HOMR = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "beijing-same-edition-benchmark" / "homr" / "homr-source-benchmark.json"
)
DEFAULT_OUT = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "beijing-same-edition-benchmark" / "same-edition-engine-comparison.json"
)


def read_rows(path: Path) -> list[dict[str, Any]]:
    report = json.loads(path.read_text(encoding="utf-8"))
    return list(report.get("rows") or [])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def select_rows(path: Path, engine: str) -> list[dict[str, Any]]:
    rows = read_rows(path)
    if engine == "audiveris-up2":
        rows = [row for row in rows if row.get("variant") == "up2"]
    selected = []
    for raw in rows:
        row = dict(raw)
        row["engine"] = engine
        selected.append(row)
    return selected


def verified_gold_identity(rows_by_engine: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    identities: dict[str, list[dict[str, str]]] = {}
    hashes_by_engine: dict[str, set[str]] = {}
    for engine, rows in rows_by_engine.items():
        if not rows:
            raise ValueError(f"{engine} contains no same-edition rows")
        engine_identities: list[dict[str, str]] = []
        engine_hashes: set[str] = set()
        for row in rows:
            if not row.get("benchmarkUsable") or row.get("humanVerifiedCleanScore") != "yes":
                raise ValueError(f"{engine} row is not approved same-edition human gold")
            gold_path = repo_path(str(row.get("goldPath") or ""))
            if not gold_path.is_file():
                raise ValueError(f"{engine} gold file is missing: {gold_path}")
            gold_hash = sha256(gold_path)
            if gold_hash in engine_hashes:
                raise ValueError(f"{engine} contains duplicate rows for one gold MusicXML")
            engine_hashes.add(gold_hash)
            engine_identities.append({
                "pieceId": str(row.get("pieceId") or row.get("recordingId") or gold_path.stem),
                "path": str(gold_path.relative_to(REPO)) if gold_path.is_relative_to(REPO) else str(gold_path),
                "sha256": gold_hash,
            })
        identities[engine] = sorted(engine_identities, key=lambda item: item["sha256"])
        hashes_by_engine[engine] = engine_hashes

    expected_hashes = next(iter(hashes_by_engine.values()))
    mismatched = [engine for engine, hashes in hashes_by_engine.items() if hashes != expected_hashes]
    if mismatched:
        raise ValueError(
            "engine reports do not reference the same set of gold MusicXML files: "
            + ", ".join(mismatched)
        )
    return {
        "sameGoldVerified": True,
        "distinctGoldPageCount": len(expected_hashes),
        "goldSha256": next(iter(expected_hashes)) if len(expected_hashes) == 1 else "",
        "goldSha256s": sorted(expected_hashes),
        "perEngine": identities,
    }


def build_report(rows_by_engine: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    gold = verified_gold_identity(rows_by_engine)
    summaries = {engine: aggregate_metrics(rows) for engine, rows in rows_by_engine.items()}
    homr = summaries["homr"]
    observed = gold["distinctGoldPageCount"]
    homr_observed_strict = homr.get("strictPassRows") == homr.get("rows") == observed
    independent_homr_rows = [
        row for row in rows_by_engine["homr"]
        if not row.get("candidateEngineBiasRisk")
    ]
    independent_camera_photo_rows = [
        row
        for row in independent_homr_rows
        if row.get("cameraPhotoDomainEligible") == "yes"
        and row.get("inputDomain") == "camera-photo"
    ]
    independent_homr = aggregate_metrics(independent_homr_rows)
    independent_camera_photo = aggregate_metrics(independent_camera_photo_rows)
    independent_observed = len(independent_homr_rows)
    independent_camera_photo_observed = len(independent_camera_photo_rows)
    bias_rows = observed - independent_observed
    independent_strict = (
        independent_homr.get("strictPassRows")
        == independent_homr.get("rows")
        == independent_observed
    )
    automatic_ready = automatic_adoption_ready(independent_homr, independent_observed)
    camera_photo_automatic_ready = automatic_adoption_ready(
        independent_camera_photo,
        independent_camera_photo_observed,
    )
    return {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "scope": "same-input-image-same-edition-human-gold-three-engine-comparison",
        "evalOnly": True,
        "studentGateReady": False,
        "runtimeEffect": "none",
        "goldIdentity": gold,
        "engines": summaries,
        "candidate": {
            "engine": "homr" if homr_observed_strict else "",
            "observedStrictPass": homr_observed_strict,
            "independentStrictPass": independent_strict,
            "minimumIndependentRows": MIN_AUTOMATIC_ADOPTION_ROWS,
            "observedHumanReviewedRows": observed,
            "observedIndependentRows": independent_observed,
            "observedIndependentCameraPhotoRows": independent_camera_photo_observed,
            "candidateEngineBiasRows": bias_rows,
            "sampleSizeReady": independent_observed >= MIN_AUTOMATIC_ADOPTION_ROWS,
            "cameraPhotoSampleSizeReady": (
                independent_camera_photo_observed >= MIN_AUTOMATIC_ADOPTION_ROWS
            ),
            "automaticAdoptionReady": automatic_ready,
            "cameraPhotoAutomaticAdoptionReady": camera_photo_automatic_ready,
            "reason": (
                "candidate-engine-derived-gold-excluded-from-independent-gate"
                if bias_rows > 0
                else "strict-positive-result-but-independent-page-count-below-gate"
                if homr_observed_strict and independent_observed < MIN_AUTOMATIC_ADOPTION_ROWS
                else "strict-gate-not-passed"
            ),
        },
        "rows": [row for rows in rows_by_engine.values() for row in rows],
    }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# M4 same-edition OMR comparison",
        "",
        "Exact OMR input images, owner-approved same-edition MusicXML gold, three engines.",
        "Input-image domain (clean page, scan, or camera photo) must be audited separately.",
        "This is eval-only and cannot authorize production adoption by itself.",
        "",
        "| Engine | Pitch recall | Pitch miss rate | Pitch precision | Onset accuracy | Measure accuracy | Strict pages |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for engine in ("audiveris-up2", "oemer", "homr"):
        row = report["engines"][engine]
        lines.append(
            f"| {engine} | {row['pitchRecall']:.2%} | {row['pitchMissRate']:.2%} | "
            f"{row['pitchPrecision']:.2%} | "
            f"{row['onsetQuarterAccuracy']:.2%} | {row['measureAccuracy']:.2%} | "
            f"{row['strictPassRows']}/{row['rows']} |"
        )
    candidate = report["candidate"]
    lines.extend([
        "",
        "## Gate",
        "",
        f"- Candidate engine: `{candidate['engine'] or 'none'}`.",
        f"- Human-reviewed same-edition pages: `{candidate['observedHumanReviewedRows']}`.",
        f"- Independent same-edition pages: `{candidate['observedIndependentRows']}` / "
        f"`{candidate['minimumIndependentRows']}` required.",
        f"- Independent camera-photo pages: "
        f"`{candidate['observedIndependentCameraPhotoRows']}` / "
        f"`{candidate['minimumIndependentRows']}` required.",
        f"- Candidate-engine-derived pages excluded from the independent gate: "
        f"`{candidate['candidateEngineBiasRows']}`.",
        f"- Automatic adoption ready: `{str(candidate['automaticAdoptionReady']).lower()}`.",
        f"- Camera-photo automatic adoption ready: "
        f"`{str(candidate['cameraPhotoAutomaticAdoptionReady']).lower()}`.",
        "- Student-facing runtime remains disabled.",
    ])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audiveris", default=str(DEFAULT_AUDIVERIS))
    parser.add_argument("--oemer", default=str(DEFAULT_OEMER))
    parser.add_argument("--homr", default=str(DEFAULT_HOMR))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    report = build_report({
        "audiveris-up2": select_rows(Path(args.audiveris), "audiveris-up2"),
        "oemer": select_rows(Path(args.oemer), "oemer"),
        "homr": select_rows(Path(args.homr), "homr"),
    })
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(report, out.with_suffix(".md"))
    print(json.dumps({"candidate": report["candidate"], "engines": report["engines"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
