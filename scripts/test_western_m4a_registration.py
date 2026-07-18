from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))

from western_m4a_registration import (  # noqa: E402
    apply_tps_residual,
    attach_feedback_and_annotation,
    evaluate_audio_sentinel,
    fit_tps_residual,
    read_image,
    register_supported_edition,
    write_image,
)


REGISTRY_ROOT = REPO / "data" / "experiments" / "western-strings-m4a" / "supported-editions"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def synthetic_photo(render: Path, output: Path, *, blur: float = 0.0) -> None:
    reference = read_image(render)
    require(reference is not None, f"missing render: {render}")
    height, width = reference.shape[:2]
    canvas = np.full((1500, 1300, 3), 24, dtype=np.uint8)
    source = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    target = np.float32([[270, 55], [1075, 90], [1130, 1430], [205, 1390]])
    transform = cv2.getPerspectiveTransform(source, target)
    warped = cv2.warpPerspective(reference, transform, (canvas.shape[1], canvas.shape[0]))
    mask = cv2.warpPerspective(np.full((height, width), 255, dtype=np.uint8), transform, (canvas.shape[1], canvas.shape[0]))
    canvas[mask > 0] = warped[mask > 0]
    if blur > 0:
        canvas = cv2.GaussianBlur(canvas, (0, 0), blur)
    write_image(output, canvas, quality=91)


def audio_evidence(agreement: float) -> dict:
    return {
        "contract": "western-m4a-audio-sentinel-evidence-v1",
        "agreement": agreement,
        "confirmed": 50,
        "eventCount": 52,
        "source": "unit-test-controlled-evidence",
    }


def main() -> None:
    passed = evaluate_audio_sentinel(audio_evidence(0.6))
    require(passed["ready"] is True, "agreement exactly at 0.6 must pass")
    failed = evaluate_audio_sentinel(audio_evidence(0.599999))
    require(failed["ready"] is False and failed["reason"] == "supported-edition-audio-mismatch", "sub-floor agreement must fail")
    missing = evaluate_audio_sentinel(None)
    require(missing["ready"] is False and missing["reason"] == "supported-edition-audio-agreement-missing", "missing audio must fail")

    with tempfile.TemporaryDirectory(prefix="western-m4a-registration-test-") as temporary:
        temporary_root = Path(temporary)
        r2_01_render = REGISTRY_ROOT / "editions/r2-01/self-authored-v1/render-page-01.png"
        r2_06_render = REGISTRY_ROOT / "editions/r2-06/self-authored-v1/render-page-01.png"
        correct_photo = temporary_root / "r2-01-perspective.jpg"
        wrong_photo = temporary_root / "r2-06-perspective.jpg"
        synthetic_photo(r2_01_render, correct_photo)
        synthetic_photo(r2_06_render, wrong_photo)

        accepted = register_supported_edition(
            piece_id="r2-01",
            edition_id="self-authored-v1",
            photo_path=correct_photo,
            audio_evidence=audio_evidence(0.97),
        )
        require(accepted["ready"] is True, json.dumps(accepted.get("blockingReasons"), ensure_ascii=False))
        require(accepted["registrationQuality"]["ready"] is True, "registration quality must pass")
        require(accepted["registrationQuality"]["inlierRatio"] >= 0.3, "inlier ratio must be reported")
        require(accepted["registrationQuality"]["systemConsistency"] >= 0.75, "system consistency must pass")
        require(accepted["registrationQuality"]["barlineConsistency"] >= 0.6, "barline consistency must pass")
        require(len(accepted["projectedCoordinates"]["measures"]) == 21, "all measure boxes must project")
        require(len(accepted["projectedCoordinates"]["notes"]) == 67, "all note boxes must project")
        require(accepted["omrUsed"] is False, "M4a main chain must not use OMR")
        require(accepted["studentFacing"] is False and accepted["reviewRequired"] is True, "runtime must remain review-only")

        projection_evidence = {
            "perNote": [
                {
                    "eventIndex": index,
                    "measure": 0,
                    "scoreMidis": [60],
                    "verdict": "confirmed",
                }
                for index in range(67)
            ],
            "verdictCounts": {"confirmed": 67},
        }
        attach_feedback_and_annotation(
            accepted,
            projection_evidence,
            correct_photo,
            temporary_root / "annotated.jpg",
        )
        projected_anchor_count = sum(
            len(event["projectedNoteAnchors"])
            for event in accepted["feedback"]["perNote"]
        )
        require(projected_anchor_count == 67, "every diagnostic event must map to its registered note anchor")

        mismatched = register_supported_edition(
            piece_id="r2-01",
            edition_id="self-authored-v1",
            photo_path=correct_photo,
            audio_evidence=audio_evidence(0.97),
        )
        attach_feedback_and_annotation(
            mismatched,
            {**projection_evidence, "perNote": projection_evidence["perNote"][:-1]},
            correct_photo,
            temporary_root / "mismatched.jpg",
        )
        require(mismatched["ready"] is False, "a diagnostic-to-anchor count mismatch must fail closed")
        require(
            "supported-edition-registration-review-required" in mismatched["blockingReasons"],
            "an anchor mismatch must use the registration review exit",
        )

        unknown = register_supported_edition(
            piece_id="not-in-library",
            edition_id="v1",
            photo_path=correct_photo,
            audio_evidence=audio_evidence(1.0),
        )
        require(unknown["ready"] is False and unknown["reason"] == "supported-edition-not-in-library", "unknown score must fail closed")

        wrong = register_supported_edition(
            piece_id="r2-01",
            edition_id="self-authored-v1",
            photo_path=wrong_photo,
            audio_evidence=audio_evidence(0.2),
        )
        require(wrong["ready"] is False, "wrong edition/photo must be blocked")
        require("supported-edition-audio-mismatch" in wrong["blockingReasons"], "audio sentinel must independently block wrong content")

        blurred = temporary_root / "blurred.jpg"
        synthetic_photo(r2_01_render, blurred, blur=18)
        poor = register_supported_edition(
            piece_id="r2-01",
            edition_id="self-authored-v1",
            photo_path=blurred,
            audio_evidence=audio_evidence(1.0),
        )
        require(poor["ready"] is False, "blurred photo must fail closed")
        require("supported-edition-registration-review-required" in poor["blockingReasons"], "blurred photo must use registration exit")

        image = read_image(correct_photo)
        require(image is not None, "synthetic photo disappeared")
        half = temporary_root / "half-page.jpg"
        write_image(half, image[: image.shape[0] // 2])
        partial = register_supported_edition(
            piece_id="r2-01",
            edition_id="self-authored-v1",
            photo_path=half,
            audio_evidence=audio_evidence(1.0),
        )
        require(partial["ready"] is False, f"half page must fail closed: {json.dumps(partial.get('registrationQuality'), ensure_ascii=False)}")
        require("supported-edition-registration-review-required" in partial["blockingReasons"], "half page must use registration exit")

    source_points = np.float64([[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.25, 0.75]])
    residuals = np.column_stack((0.08 * np.sin(np.pi * source_points[:, 1]), np.zeros(len(source_points))))
    model = fit_tps_residual(source_points, residuals, regularization=1e-6)
    recovered = apply_tps_residual(model, source_points)
    require(float(np.max(np.abs(recovered - residuals))) < 1e-4, "TPS must reproduce curvature controls")

    implementation = (REPO / "scripts/western_m4a_registration.py").read_text(encoding="utf-8").lower()
    require("audiveris" not in implementation and "homr" not in implementation, "M4a implementation must contain no OMR engine integration")

    print(json.dumps({
        "ok": True,
        "checks": [
            "correct-perspective-registration-passes",
            "unknown-library-entry-fails-closed",
            "wrong-edition-audio-sentinel-fails-closed",
            "blurred-and-half-page-inputs-fail-closed",
            "all-measure-and-note-coordinates-back-project",
            "every-diagnostic-event-projects-to-a-registered-note-anchor",
            "diagnostic-anchor-count-mismatch-fails-closed",
            "audio-agreement-floor-is-exactly-0.6",
            "paper-curvature-tps-residual-is-operational",
            "main-chain-has-no-omr-engine",
            "review-only-student-switches-untouched",
        ],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
