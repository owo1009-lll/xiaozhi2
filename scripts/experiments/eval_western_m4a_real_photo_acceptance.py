#!/usr/bin/env python3
"""Evaluate the frozen M4a real-screen-photo acceptance contract."""

from __future__ import annotations

import hashlib
import html
import json
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


CONFIG_PATH = REPO / "config" / "western-m4a-real-photo-acceptance.json"
IMPLEMENTATION_PATH = REPO / "scripts" / "western_m4a_registration.py"
REGISTRY_PATH = REPO / "data" / "experiments" / "western-strings-m4a" / "supported-editions" / "registry.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_sha256(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def registration_summary(result: dict[str, Any]) -> dict[str, Any]:
    quality = result.get("registrationQuality", {})
    feedback = result.get("feedback") or {}
    return {
        "ready": result.get("ready", False),
        "reason": result.get("reason", ""),
        "blockingReasons": result.get("blockingReasons", []),
        "audioAgreement": result.get("audioSentinel", {}).get("agreement"),
        "registrationQuality": {
            "ready": quality.get("ready", False),
            "goodMatchCount": quality.get("goodMatchCount", 0),
            "inlierCount": quality.get("inlierCount", 0),
            "inlierRatio": quality.get("inlierRatio", 0),
            "referenceGridCoverage": quality.get("referenceGridCoverage", 0),
            "projectedPageVisibility": quality.get("projectedPageVisibility", 0),
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
        "omrUsed": result.get("omrUsed"),
        "reviewRequired": result.get("reviewRequired"),
        "studentFacing": result.get("studentFacing"),
        "automaticAdoptionAuthorized": result.get("automaticAdoptionAuthorized"),
        "autoDiagnosisIssued": result.get("autoDiagnosisIssued"),
    }


def draw_measure_overlay(result: dict[str, Any], photo: Path, output: Path) -> dict[str, Any]:
    image = read_image(photo)
    if image is None:
        raise RuntimeError(f"unable to read accepted photo: {photo}")
    polygons: list[tuple[dict[str, Any], np.ndarray]] = []
    invalid_measure_ids: list[Any] = []
    for row in result.get("projectedCoordinates", {}).get("measures", []):
        raw_points = np.asarray(row.get("polygonPixels", []), dtype="float32")
        if (
            raw_points.ndim != 2
            or raw_points.shape[0] < 3
            or raw_points.shape[1] != 2
            or not np.isfinite(raw_points).all()
        ):
            invalid_measure_ids.append(row.get("globalMeasureIndex"))
            continue
        points = cv2.convexHull(raw_points).reshape(-1, 2).astype("int32")
        if len(points) < 3:
            invalid_measure_ids.append(row.get("globalMeasureIndex"))
            continue
        polygons.append((row, points))
    if invalid_measure_ids:
        return {
            "ready": False,
            "reason": "supported-edition-projected-measure-polygon-invalid",
            "invalidMeasureIds": invalid_measure_ids,
        }
    for row, points in polygons:
        cv2.polylines(image, [points.reshape(-1, 1, 2)], True, (255, 120, 0), 3, cv2.LINE_AA)
        x, y = points[0]
        label = str(row.get("globalMeasureIndex", "?"))
        cv2.putText(image, label, (int(x), max(18, int(y) - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 80, 0), 2, cv2.LINE_AA)
    write_image(output, image, quality=92)
    return {
        "ready": True,
        "reason": "ok",
        "measureCount": len(polygons),
        "invalidMeasureIds": [],
    }


def audio_evidence_for(
    cache: dict[tuple[str, str, str], dict[str, Any]],
    piece_id: str,
    edition_id: str,
    audio_path: Path,
) -> dict[str, Any]:
    key = (piece_id, edition_id, str(audio_path.resolve()))
    if key not in cache:
        entry, context = load_registry_entry(piece_id, edition_id)
        if entry is None:
            raise RuntimeError(f"registered edition missing: {piece_id}:{edition_id}")
        score = safe_registry_artifact(context["path"].parent, entry["musicxmlPath"])
        cache[key] = build_audio_evidence(score, audio_path)
    return cache[key]


def run_positive(
    task: dict[str, Any],
    output_root: Path,
    evidence_cache: dict[tuple[str, str, str], dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    case_id = task["caseId"]
    photo = REPO / task["photoPath"]
    audio = REPO / task["audioPath"]
    if not photo.is_file():
        return ({
            "caseId": case_id,
            "pieceId": task["pieceId"],
            "editionId": task["editionId"],
            "captureVariant": task["captureVariant"],
            "available": False,
            "ready": False,
            "reason": "real-screen-photo-missing",
            "photo": task["photoPath"],
            "audio": task["audioPath"],
        }, [])
    evidence = audio_evidence_for(evidence_cache, task["pieceId"], task["editionId"], audio)
    case_root = output_root / "positive-cases" / case_id
    case_root.mkdir(parents=True, exist_ok=True)
    result = register_supported_edition(
        piece_id=task["pieceId"],
        edition_id=task["editionId"],
        photo_path=photo,
        audio_evidence=evidence,
    )
    attach_feedback_and_annotation(result, evidence, photo, case_root / "diagnostic-overlay.jpg")
    measure_overlay = case_root / "measure-review-overlay.jpg"
    if result["ready"]:
        overlay_validation = draw_measure_overlay(result, photo, measure_overlay)
        result["measureOverlayValidation"] = overlay_validation
        if not overlay_validation["ready"]:
            reason = overlay_validation["reason"]
            result["ready"] = False
            result["reason"] = reason
            result["blockingReasons"] = sorted(set([*result.get("blockingReasons", []), reason]))
    audit_path = case_root / "audit.json"
    write_json(audit_path, result)
    summary = {
        "caseId": case_id,
        "pieceId": task["pieceId"],
        "editionId": task["editionId"],
        "captureVariant": task["captureVariant"],
        "available": True,
        "photo": task["photoPath"],
        "photoSha256": sha256(photo),
        "audio": task["audioPath"],
        "audioSha256": sha256(audio),
        **registration_summary(result),
        "audit": relative(audit_path),
        "auditSha256": sha256(audit_path),
        "diagnosticOverlay": relative(case_root / "diagnostic-overlay.jpg") if result["ready"] else None,
        "diagnosticOverlaySha256": sha256(case_root / "diagnostic-overlay.jpg") if result["ready"] else None,
        "measureReviewOverlay": relative(measure_overlay) if result["ready"] else None,
        "measureReviewOverlaySha256": sha256(measure_overlay) if result["ready"] else None,
    }
    poor_rows: list[dict[str, Any]] = []
    source = read_image(photo)
    if source is None:
        return summary, poor_rows
    degraded_root = output_root / "poor-image-cases" / case_id
    degraded_root.mkdir(parents=True, exist_ok=True)
    transforms = {
        "gaussian-blur": cv2.GaussianBlur(source, (0, 0), 18),
        "half-page-crop": source[: max(1, source.shape[0] // 2)],
    }
    for transform_name, degraded in transforms.items():
        degraded_photo = degraded_root / f"{transform_name}.jpg"
        write_image(degraded_photo, degraded, quality=90)
        degraded_result = register_supported_edition(
            piece_id=task["pieceId"],
            edition_id=task["editionId"],
            photo_path=degraded_photo,
            audio_evidence=evidence,
        )
        degraded_audit = degraded_root / f"{transform_name}-audit.json"
        write_json(degraded_audit, degraded_result)
        poor_rows.append({
            "caseId": f"{case_id}:{transform_name}",
            "sourceCaseId": case_id,
            "transform": transform_name,
            "photo": relative(degraded_photo),
            "photoSha256": sha256(degraded_photo),
            "blocked": degraded_result["ready"] is False,
            **registration_summary(degraded_result),
            "audit": relative(degraded_audit),
            "auditSha256": sha256(degraded_audit),
        })
    return summary, poor_rows


def run_wrong_edition(
    row: dict[str, Any],
    output_root: Path,
    evidence_cache: dict[tuple[str, str, str], dict[str, Any]],
) -> dict[str, Any]:
    photo = REPO / row["photoPath"]
    audio = REPO / row["audioPath"]
    if not photo.is_file() or not audio.is_file():
        return {
            "caseId": row["caseId"],
            "available": False,
            "blocked": False,
            "reason": "wrong-edition-evidence-missing",
            "photo": row["photoPath"],
            "audio": row["audioPath"],
        }
    evidence = audio_evidence_for(
        evidence_cache,
        row["claimedPieceId"],
        row["claimedEditionId"],
        audio,
    )
    result = register_supported_edition(
        piece_id=row["claimedPieceId"],
        edition_id=row["claimedEditionId"],
        photo_path=photo,
        audio_evidence=evidence,
    )
    audit = output_root / "wrong-edition-cases" / f"{row['caseId']}-audit.json"
    write_json(audit, result)
    return {
        "caseId": row["caseId"],
        "claimedPieceId": row["claimedPieceId"],
        "claimedEditionId": row["claimedEditionId"],
        "available": True,
        "photo": row["photoPath"],
        "photoSha256": sha256(photo),
        "audio": row["audioPath"],
        "audioSha256": sha256(audio),
        "blocked": result["ready"] is False,
        **registration_summary(result),
        "audit": relative(audit),
        "auditSha256": sha256(audit),
    }


def review_basis(positives: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "caseId": row["caseId"],
            "photoSha256": row["photoSha256"],
            "measureReviewOverlaySha256": row["measureReviewOverlaySha256"],
            "projectedMeasureCount": row["projectedCounts"]["measures"],
        }
        for row in positives
        if row.get("ready") is True
    ]


def evaluate_owner_review(
    review_path: Path,
    evidence_digest: str,
    basis: list[dict[str, Any]],
) -> dict[str, Any]:
    try:
        review = json.loads(review_path.read_text(encoding="utf-8"))
    except Exception as error:
        return {
            "ready": False,
            "reason": "m4a-owner-measure-review-missing-or-invalid",
            "error": str(error),
            "reviewer": "",
            "reviewedAt": "",
            "confirmedMeasureCount": 0,
            "expectedMeasureCount": sum(row["projectedMeasureCount"] for row in basis),
            "confirmationRate": 0.0,
        }
    reasons = []
    if review.get("contract") != "western-m4a-owner-measure-review-v1":
        reasons.append("m4a-owner-review-contract-mismatch")
    if review.get("evidenceDigest") != evidence_digest:
        reasons.append("m4a-owner-review-evidence-digest-mismatch")
    if not str(review.get("reviewer", "")).strip() or not str(review.get("reviewedAt", "")).strip():
        reasons.append("m4a-owner-review-identity-missing")
    confirmations = {row.get("caseId"): row for row in review.get("cases", []) if isinstance(row, dict)}
    expected_measure_count = sum(row["projectedMeasureCount"] for row in basis)
    confirmed_measure_count = 0
    for row in basis:
        confirmation = confirmations.get(row["caseId"], {})
        if confirmation.get("allProjectedMeasureBoxesCorrect") is not True:
            reasons.append(f"m4a-owner-review-case-not-confirmed:{row['caseId']}")
            continue
        if int(confirmation.get("confirmedMeasureCount", -1)) != row["projectedMeasureCount"]:
            reasons.append(f"m4a-owner-review-measure-count-mismatch:{row['caseId']}")
            continue
        confirmed_measure_count += row["projectedMeasureCount"]
    rate = confirmed_measure_count / expected_measure_count if expected_measure_count else 0.0
    if rate != 1.0:
        reasons.append("m4a-owner-review-confirmation-rate-below-one")
    return {
        "ready": not reasons,
        "reason": "ok" if not reasons else reasons[0],
        "blockingReasons": sorted(set(reasons)),
        "source": relative(review_path),
        "sha256": sha256(review_path),
        "reviewer": review.get("reviewer", ""),
        "reviewedAt": review.get("reviewedAt", ""),
        "confirmedMeasureCount": confirmed_measure_count,
        "expectedMeasureCount": expected_measure_count,
        "confirmationRate": round(rate, 6),
    }


def write_owner_review_pack(
    output_root: Path,
    evidence_digest: str,
    basis: list[dict[str, Any]],
    positives: list[dict[str, Any]],
) -> None:
    pack_root = output_root / "owner-review"
    pack_root.mkdir(parents=True, exist_ok=True)
    positive_map = {row["caseId"]: row for row in positives}
    template = {
        "contract": "western-m4a-owner-measure-review-v1",
        "evidenceDigest": evidence_digest,
        "reviewer": "",
        "reviewedAt": "",
        "cases": [
            {
                "caseId": row["caseId"],
                "projectedMeasureCount": row["projectedMeasureCount"],
                "confirmedMeasureCount": 0,
                "allProjectedMeasureBoxesCorrect": False,
                "note": "",
            }
            for row in basis
        ],
    }
    write_json(pack_root / "owner-measure-review.template.json", template)
    cards = []
    for row in basis:
        positive = positive_map[row["caseId"]]
        overlay_path = REPO / positive["measureReviewOverlay"]
        overlay_url = Path("..").joinpath(Path(overlay_path).relative_to(output_root)).as_posix()
        cards.append(f"""
        <article data-case="{html.escape(row['caseId'])}" data-count="{row['projectedMeasureCount']}">
          <h2>{html.escape(row['caseId'])} · {row['projectedMeasureCount']} 个小节框</h2>
          <img src="{html.escape(overlay_url)}" alt="{html.escape(row['caseId'])} measure overlay">
          <label><input type="checkbox"> 我已逐框核对，全部位置正确</label>
        </article>""")
    html_value = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>M4a 小节框负责人复核</title><style>
body{{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#0f172a;color:#f8fafc}}header{{position:sticky;top:0;background:#111827;padding:12px 18px;z-index:2}}main{{max-width:1200px;margin:auto;padding:16px}}article{{background:#1e293b;padding:14px;border-radius:12px;margin:14px 0}}img{{width:100%;height:auto;background:white}}label{{display:block;padding:12px 0;font-size:18px}}input{{width:22px;height:22px;vertical-align:middle}}button,input[type=text]{{font-size:16px;padding:9px;margin:4px}}code{{color:#5eead4}}</style></head>
<body><header><strong>M4a 负责人逐框复核</strong> · evidence <code>{evidence_digest}</code></header><main>
<p>只确认蓝色小节框的位置；必须逐框查看。下载的 JSON 放入 Downloads 后运行 <code>npm run western:m4a-owner-review-intake</code>。</p>
<p><input id="reviewer" type="text" placeholder="负责人姓名"><button id="download">全部勾选后下载签署 JSON</button></p>
{''.join(cards) if cards else '<p>尚无通过配准的真实照片，当前不能签署。</p>'}
</main><script>
const digest={json.dumps(evidence_digest)};
document.querySelector('#download').addEventListener('click',()=>{{
 const reviewer=document.querySelector('#reviewer').value.trim();
 const articles=[...document.querySelectorAll('article')];
 if(!reviewer){{alert('请填写负责人姓名');return}}
 if(!articles.length||articles.some(a=>!a.querySelector('input').checked)){{alert('必须逐张全部勾选');return}}
 const value={{contract:'western-m4a-owner-measure-review-v1',evidenceDigest:digest,reviewer,reviewedAt:new Date().toISOString(),cases:articles.map(a=>({{caseId:a.dataset.case,projectedMeasureCount:Number(a.dataset.count),confirmedMeasureCount:Number(a.dataset.count),allProjectedMeasureBoxesCorrect:true,note:''}}))}};
 const blob=new Blob([JSON.stringify(value,null,2)+'\\n'],{{type:'application/json'}});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='m4a-owner-measure-review.json';link.click();URL.revokeObjectURL(link.href);
}});</script></body></html>"""
    (pack_root / "index.html").write_text(html_value, encoding="utf-8")


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    output_root = REPO / config["outputRoot"]
    output_root.mkdir(parents=True, exist_ok=True)
    evidence_cache: dict[tuple[str, str, str], dict[str, Any]] = {}
    positives: list[dict[str, Any]] = []
    poor_rows: list[dict[str, Any]] = []
    for task in config["positiveCaptureTasks"]:
        positive, derived = run_positive(task, output_root, evidence_cache)
        positives.append(positive)
        poor_rows.extend(derived)
    wrong_rows = [
        run_wrong_edition(row, output_root, evidence_cache)
        for row in config["wrongEditionCases"]
    ]
    basis = review_basis(positives)
    evidence_digest = canonical_sha256(basis)
    write_owner_review_pack(output_root, evidence_digest, basis, positives)
    owner_review = evaluate_owner_review(REPO / config["ownerReviewPath"], evidence_digest, basis)

    thresholds = config["thresholds"]
    positive_available = sum(row.get("available") is True for row in positives)
    positive_passed = sum(row.get("ready") is True for row in positives)
    positive_pass_rate = positive_passed / positive_available if positive_available else 0.0
    wrong_available = sum(row.get("available") is True for row in wrong_rows)
    wrong_leaks = sum(row.get("available") is True and row.get("blocked") is not True for row in wrong_rows)
    poor_leaks = sum(row.get("blocked") is not True for row in poor_rows)
    expected_poor_count = positive_available * len(thresholds["requiredPoorImageTransforms"])
    safety_rows = [row for row in positives + wrong_rows + poor_rows if row.get("available", True)]
    safety_ready = all(
        row.get("omrUsed") is False
        and row.get("reviewRequired") is True
        and row.get("studentFacing") is False
        and row.get("automaticAdoptionAuthorized") is False
        and row.get("autoDiagnosisIssued") is False
        for row in safety_rows
        if "omrUsed" in row
    )
    checks = {
        "positivePhotoCount": positive_available >= thresholds["minimumPositivePhotos"],
        "positivePassRate": positive_pass_rate >= thresholds["minimumPositivePassRate"],
        "ownerMeasureBoxConfirmation": owner_review["ready"]
        and owner_review["confirmationRate"] == thresholds["ownerMeasureBoxConfirmationRate"],
        "wrongEditionCount": wrong_available >= thresholds["minimumWrongEditionPhotos"],
        "wrongEditionLeakCount": wrong_leaks <= thresholds["maximumWrongEditionLeakCount"],
        "poorImageCoverage": len(poor_rows) == expected_poor_count
        and set(row["transform"] for row in poor_rows) == set(thresholds["requiredPoorImageTransforms"]),
        "poorImageLeakCount": poor_leaks <= thresholds["maximumPoorImageLeakCount"],
        "reviewOnlySafety": safety_ready,
    }
    blocking_reasons = []
    if not checks["positivePhotoCount"]:
        blocking_reasons.append(f"m4a-real-photo-positive-missing:{thresholds['minimumPositivePhotos'] - positive_available}")
    if positive_available and not checks["positivePassRate"]:
        blocking_reasons.append("m4a-real-photo-positive-pass-rate-below-0.90")
    if not checks["ownerMeasureBoxConfirmation"]:
        blocking_reasons.append("m4a-owner-measure-box-confirmation-not-ready")
    if not checks["wrongEditionCount"]:
        blocking_reasons.append("m4a-wrong-edition-real-photo-count-below-five")
    if not checks["wrongEditionLeakCount"]:
        blocking_reasons.append("m4a-wrong-edition-real-photo-leak-detected")
    if not checks["poorImageCoverage"]:
        blocking_reasons.append("m4a-real-photo-poor-image-coverage-not-ready")
    if not checks["poorImageLeakCount"]:
        blocking_reasons.append("m4a-real-photo-poor-image-leak-detected")
    if not checks["reviewOnlySafety"]:
        blocking_reasons.append("m4a-real-photo-review-only-safety-violated")
    report = {
        "contract": "western-m4a-real-photo-acceptance-v1",
        "complete": True,
        "acceptanceReady": all(checks.values()),
        "evidenceClass": config["evidenceClass"],
        "provenance": {
            "policy": relative(CONFIG_PATH),
            "policySha256": sha256(CONFIG_PATH),
            "implementation": relative(IMPLEMENTATION_PATH),
            "implementationSha256": sha256(IMPLEMENTATION_PATH),
            "registry": relative(REGISTRY_PATH),
            "registrySha256": sha256(REGISTRY_PATH),
        },
        "thresholds": thresholds,
        "checks": checks,
        "blockingReasons": blocking_reasons,
        "evidenceDigest": evidence_digest,
        "positiveCases": positives,
        "wrongEditionCases": wrong_rows,
        "poorImageCases": poor_rows,
        "ownerReview": owner_review,
        "summary": {
            "positiveExpected": len(config["positiveCaptureTasks"]),
            "positiveAvailable": positive_available,
            "positivePassed": positive_passed,
            "positivePassRate": round(positive_pass_rate, 6),
            "wrongEditionAvailable": wrong_available,
            "wrongEditionBlocked": wrong_available - wrong_leaks,
            "wrongEditionLeakCount": wrong_leaks,
            "poorImageExpected": expected_poor_count,
            "poorImageEvaluated": len(poor_rows),
            "poorImageBlocked": len(poor_rows) - poor_leaks,
            "poorImageLeakCount": poor_leaks,
            "ownerConfirmedMeasures": owner_review["confirmedMeasureCount"],
            "ownerExpectedMeasures": owner_review["expectedMeasureCount"],
        },
        "safety": config["safety"],
    }
    report_path = output_root / "report.json"
    write_json(report_path, report)
    print(json.dumps({
        "ok": report["acceptanceReady"],
        "report": relative(report_path),
        "summary": report["summary"],
        "blockingReasons": blocking_reasons,
        "ownerReviewPack": relative(output_root / "owner-review" / "index.html"),
    }, ensure_ascii=False, indent=2))
    if not report["acceptanceReady"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
