#!/usr/bin/env python3
"""Run the synthetic+real-negative engineering acceptance for Appendix C.2c-f."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

from western_m4a_registration import (  # noqa: E402
    attach_feedback_and_annotation,
    build_audio_evidence,
    load_registry_entry,
    read_image,
    register_supported_edition,
    safe_registry_artifact,
    write_image,
)


OUT = REPO / "data" / "experiments" / "western-strings-m4a" / "engineering-acceptance"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_photo(render: Path, output: Path, *, blur: float = 0.0) -> None:
    reference = read_image(render)
    if reference is None:
        raise RuntimeError(f"missing reference: {render}")
    height, width = reference.shape[:2]
    canvas = np.full((1500, 1300, 3), 22, dtype=np.uint8)
    source = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    target = np.float32([[270, 55], [1075, 90], [1130, 1430], [205, 1390]])
    transform = cv2.getPerspectiveTransform(source, target)
    warped = cv2.warpPerspective(reference, transform, (canvas.shape[1], canvas.shape[0]))
    mask = cv2.warpPerspective(np.full((height, width), 255, dtype=np.uint8), transform, (canvas.shape[1], canvas.shape[0]))
    canvas[mask > 0] = warped[mask > 0]
    if blur:
        canvas = cv2.GaussianBlur(canvas, (0, 0), blur)
    write_image(output, canvas)


def summarize(
    case_id: str,
    result: dict[str, Any],
    photo: Path,
    audio: Path | None,
    audit: Path | None = None,
) -> dict[str, Any]:
    quality = result.get("registrationQuality", {})
    feedback = result.get("feedback") or {}
    annotated_value = feedback.get("annotatedPhoto")
    annotated = Path(annotated_value) if annotated_value else None
    return {
        "caseId": case_id,
        "ready": result["ready"],
        "reason": result["reason"],
        "blockingReasons": result["blockingReasons"],
        "photo": photo.relative_to(REPO).as_posix(),
        "photoSha256": sha256(photo),
        "audio": audio.relative_to(REPO).as_posix() if audio else None,
        "audioSha256": sha256(audio) if audio else None,
        "audioAgreement": result.get("audioSentinel", {}).get("agreement"),
        "registrationQuality": {
            "ready": quality.get("ready", False),
            "goodMatchCount": quality.get("goodMatchCount", 0),
            "inlierCount": quality.get("inlierCount", 0),
            "inlierRatio": quality.get("inlierRatio", 0),
            "referenceGridCoverage": quality.get("referenceGridCoverage", 0),
            "systemConsistency": quality.get("systemConsistency", 0),
            "barlineConsistency": quality.get("barlineConsistency", 0),
            "structuralResidualNormalized": quality.get("structuralResidualNormalized", 1),
            "deformation": quality.get("deformation", {}),
        },
        "projectedCounts": {
            key: len(result.get("projectedCoordinates", {}).get(key, []))
            for key in ["systems", "staves", "measures", "notes"]
        },
        "feedbackProjection": {
            "ready": feedback.get("projectionReady", False),
            "expectedAnchorCount": feedback.get("expectedAnchorCount", 0),
            "mappedAnchorCount": feedback.get("mappedAnchorCount", 0),
        },
        "audit": audit.relative_to(REPO).as_posix() if audit else None,
        "auditSha256": sha256(audit) if audit else None,
        "annotatedPhoto": annotated.relative_to(REPO).as_posix() if annotated else None,
        "annotatedPhotoSha256": sha256(annotated) if annotated else None,
        "omrUsed": result["omrUsed"],
        "reviewRequired": result["reviewRequired"],
        "studentFacing": result["studentFacing"],
        "automaticAdoptionAuthorized": result["automaticAdoptionAuthorized"],
    }


def run_positive(piece_id: str, audio: Path) -> dict[str, Any]:
    entry, context = load_registry_entry(piece_id, "self-authored-v1")
    if entry is None:
        raise RuntimeError(f"missing registry entry: {piece_id}")
    registry_root = context["path"].parent
    render = safe_registry_artifact(registry_root, entry["renderPath"])
    score = safe_registry_artifact(registry_root, entry["musicxmlPath"])
    case_root = OUT / f"positive-{piece_id}"
    case_root.mkdir(parents=True, exist_ok=True)
    photo = case_root / "perspective-photo.jpg"
    build_photo(render, photo)
    evidence = build_audio_evidence(score, audio)
    result = register_supported_edition(
        piece_id=piece_id,
        edition_id="self-authored-v1",
        photo_path=photo,
        audio_evidence=evidence,
    )
    attach_feedback_and_annotation(result, evidence, photo, case_root / "annotated-photo.jpg")
    audit = case_root / "audit.json"
    audit.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summarize(f"positive-{piece_id}", result, photo, audio, audit)


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    positives = [
        run_positive("r2-01", REPO / "data/private/western-strings-round2/r2-01.m4a"),
        run_positive("r2-06", REPO / "data/private/western-strings-round2/r2-06.m4a"),
        run_positive("r3-01", REPO / "data/private/western-strings-round3/r3-01.m4a"),
    ]

    entry, context = load_registry_entry("r2-01", "self-authored-v1")
    if entry is None:
        raise RuntimeError("r2-01 registry entry missing")
    render = safe_registry_artifact(context["path"].parent, entry["renderPath"])
    score = safe_registry_artifact(context["path"].parent, entry["musicxmlPath"])
    r2_01_audio = REPO / "data/private/western-strings-round2/r2-01.m4a"
    correct_evidence = build_audio_evidence(score, r2_01_audio)

    negative_root = OUT / "negative-inputs"
    negative_root.mkdir()
    blurred = negative_root / "blurred.jpg"
    build_photo(render, blurred, blur=18)
    blur_result = register_supported_edition(
        piece_id="r2-01",
        edition_id="self-authored-v1",
        photo_path=blurred,
        audio_evidence=correct_evidence,
    )

    clean = negative_root / "clean-perspective.jpg"
    build_photo(render, clean)
    clean_image = read_image(clean)
    if clean_image is None:
        raise RuntimeError("synthetic clean photo missing")
    half = negative_root / "half-page.jpg"
    write_image(half, clean_image[: clean_image.shape[0] // 2])
    half_result = register_supported_edition(
        piece_id="r2-01",
        edition_id="self-authored-v1",
        photo_path=half,
        audio_evidence=correct_evidence,
    )

    wrong_renderer_photo = REPO / "data/private/western-strings-round2/r2-01-screenphoto.jpg"
    wrong_renderer_result = register_supported_edition(
        piece_id="r2-01",
        edition_id="self-authored-v1",
        photo_path=wrong_renderer_photo,
        audio_evidence=correct_evidence,
    )
    unknown_result = register_supported_edition(
        piece_id="not-in-library",
        edition_id="v1",
        photo_path=clean,
        audio_evidence=correct_evidence,
    )
    negatives = [
        summarize("negative-blurred", blur_result, blurred, r2_01_audio),
        summarize("negative-half-page", half_result, half, r2_01_audio),
        summarize("negative-wrong-renderer-edition", wrong_renderer_result, wrong_renderer_photo, r2_01_audio),
        summarize("negative-not-in-library", unknown_result, clean, r2_01_audio),
    ]
    all_rows = positives + negatives
    engineering_ready = (
        all(row["ready"] for row in positives)
        and all(row["feedbackProjection"]["ready"] for row in positives)
        and all(
            row["feedbackProjection"]["expectedAnchorCount"]
            == row["feedbackProjection"]["mappedAnchorCount"]
            == row["projectedCounts"]["notes"]
            for row in positives
        )
        and all(not row["ready"] for row in negatives)
        and all(row["omrUsed"] is False for row in all_rows)
        and all(row["studentFacing"] is False for row in all_rows)
        and all(row["automaticAdoptionAuthorized"] is False for row in all_rows)
    )
    report = {
        "contract": "western-m4a-engineering-acceptance-v1",
        "complete": True,
        "engineeringReady": engineering_ready,
        "evidenceClass": "engineering-only-synthetic-positive-and-real-wrong-edition-negative",
        "doesNotSatisfyFrozenRealPhotoAcceptance": True,
        "provenance": {
            "implementation": "scripts/western_m4a_registration.py",
            "implementationSha256": sha256(REPO / "scripts/western_m4a_registration.py"),
            "policy": "config/western-m4a-registration.json",
            "policySha256": sha256(REPO / "config/western-m4a-registration.json"),
            "registry": "data/experiments/western-strings-m4a/supported-editions/registry.json",
            "registrySha256": sha256(REPO / "data/experiments/western-strings-m4a/supported-editions/registry.json"),
        },
        "positives": positives,
        "negatives": negatives,
        "summary": {
            "positivePassed": sum(row["ready"] for row in positives),
            "positiveCount": len(positives),
            "negativeBlocked": sum(not row["ready"] for row in negatives),
            "negativeCount": len(negatives),
            "omrUsedCount": sum(row["omrUsed"] for row in all_rows),
            "studentFacingCount": sum(row["studentFacing"] for row in all_rows),
        },
        "interpretation": [
            "The complete page-detection, homography/TPS, quality-gate, audio-sentinel, coordinate-projection, diagnosis, and annotation chain is executable.",
            "The owner-captured 2026-07-17 screen photo uses a different renderer/layout and is correctly rejected as the wrong registered edition despite high audio agreement.",
            "This report does not count as the >=10 real screen-photo acceptance required to open M4a.",
        ],
    }
    report_path = OUT / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": engineering_ready, "report": report_path.relative_to(REPO).as_posix(), "summary": report["summary"]}, ensure_ascii=False, indent=2))
    if not engineering_ready:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
