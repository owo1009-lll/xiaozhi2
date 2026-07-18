from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Iterable


M3PLUS_EVALUATION_CONTRACT = "m3plus-rescope-four-zone-v2"
M3PLUS_RUNTIME_CONTRACT = "m3plus-gold-free-runtime-v1"
M3PLUS_RUNTIME_POLICY_VERSION = "m3plus-gold-free-pitch-safety-policy-v1"
M3PLUS_F0_BACKEND = "librosa-pyin"

M3PLUS_PITCH_TOLERANCE_CENTS = 50.0
M3PLUS_MAX_SPREAD_P95_P05_CENTS = 80.0
M3PLUS_MAX_IQR_CENTS = 80.0
M3PLUS_MIN_TOTAL_FRAME_COUNT = 12
M3PLUS_MIN_VOICED_FRAME_COUNT = 12
M3PLUS_MIN_VOICED_FRAME_RATIO = 0.70
M3PLUS_GLISSANDO_TARGET_TAIL_FRACTION = 0.35

_PROTECTED_EXACT_MARKINGS = {
    "delayed-turn",
    "inverted-delayed-turn",
    "inverted-mordent",
    "inverted-turn",
    "mordent",
    "ornament",
    "ornaments",
    "shake",
    "schleifer",
    "trill",
    "trill-mark",
    "turn",
}
_GLISSANDO_MARKINGS = {"gliss", "glissando", "portamento", "slide"}


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _normal_markings(values: Iterable[Any] | None) -> list[str]:
    source = [values] if isinstance(values, str) else (values or [])
    return sorted({str(value).strip().lower() for value in source if str(value).strip()})


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _frame_count(value: Any) -> int:
    number = _finite(value)
    return max(0, int(number)) if number is not None else 0


def protected_score_markings(
    score_techniques: Iterable[Any] | None,
    score_notations: Iterable[Any] | None,
) -> list[str]:
    markings = sorted({*_normal_markings(score_techniques), *_normal_markings(score_notations)})
    return [
        marking
        for marking in markings
        if (
            marking in _PROTECTED_EXACT_MARKINGS
            or "harmonic" in marking
            or "ornament" in marking
            or "trill" in marking
            or "mordent" in marking
            or marking.endswith("-turn")
        )
    ]


def has_glissando_marking(
    score_techniques: Iterable[Any] | None,
    score_notations: Iterable[Any] | None,
) -> bool:
    markings = sorted({*_normal_markings(score_techniques), *_normal_markings(score_notations)})
    return any(marking in _GLISSANDO_MARKINGS or "gliss" in marking for marking in markings)


M3PLUS_RUNTIME_POLICY_DESCRIPTOR = {
    "evaluationContract": M3PLUS_EVALUATION_CONTRACT,
    "runtimeContract": M3PLUS_RUNTIME_CONTRACT,
    "policyVersion": M3PLUS_RUNTIME_POLICY_VERSION,
    "f0Backend": M3PLUS_F0_BACKEND,
    "thresholds": {
        "pitchToleranceCents": M3PLUS_PITCH_TOLERANCE_CENTS,
        "maxSpreadCentsP95P05": M3PLUS_MAX_SPREAD_P95_P05_CENTS,
        "maxIqrCents": M3PLUS_MAX_IQR_CENTS,
        "minTotalFrameCount": M3PLUS_MIN_TOTAL_FRAME_COUNT,
        "minVoicedFrameCount": M3PLUS_MIN_VOICED_FRAME_COUNT,
        "minVoicedFrameRatio": M3PLUS_MIN_VOICED_FRAME_RATIO,
        "glissandoTargetTailFraction": M3PLUS_GLISSANDO_TARGET_TAIL_FRACTION,
    },
    "zones": [
        "stable_center",
        "score_marked_neutral",
        "glissando_target_tail",
        "multi_f0_review_only",
    ],
    "protectedExactMarkings": sorted(_PROTECTED_EXACT_MARKINGS),
    "protectedSubstringRules": ["harmonic", "ornament", "trill", "mordent"],
    "glissandoMarkings": sorted(_GLISSANDO_MARKINGS),
    "failClosedChecks": [
        "timing-assignment",
        "analysis-window",
        "total-frame-floor",
        "voiced-frame-floor",
        "voiced-ratio-floor",
        "center-pitch",
        "dispersion",
    ],
    "protectedMarkingPolicy": "trill-ornament-harmonic-score-markings-neutralized",
    "authorizationPolicy": "review-only-no-student-feedback",
}
M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256 = hashlib.sha256(
    _canonical_json(M3PLUS_RUNTIME_POLICY_DESCRIPTOR).encode("utf-8")
).hexdigest()


def runtime_policy_descriptor() -> dict[str, Any]:
    return {
        **M3PLUS_RUNTIME_POLICY_DESCRIPTOR,
        "policySemanticSha256": M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256,
        "reviewOnly": True,
        "feedbackAuthorized": False,
        "studentFacing": False,
    }


def evaluate_m3plus_pitch_safety(
    *,
    score_midi: int,
    score_techniques: Iterable[Any] | None,
    score_notations: Iterable[Any] | None,
    timing_assignment_available: bool,
    window_start_seconds: float | None,
    window_end_seconds: float | None,
    total_frame_count: int,
    voiced_frame_count: int,
    voiced_frame_ratio: float,
    median_observed_midi: float | None,
    spread_cents_p95_p05: float | None,
    iqr_cents: float | None,
    polyphonic_score_region: bool = False,
    glissando_target_midi: int | None = None,
    target_tail_window_start_seconds: float | None = None,
    target_tail_window_end_seconds: float | None = None,
    target_tail_total_frame_count: int = 0,
    target_tail_voiced_frame_count: int = 0,
    target_tail_voiced_frame_ratio: float = 0.0,
    target_tail_median_observed_midi: float | None = None,
    target_tail_spread_cents_p95_p05: float | None = None,
    target_tail_iqr_cents: float | None = None,
) -> dict[str, Any]:
    techniques = _normal_markings(score_techniques)
    notations = _normal_markings(score_notations)
    protected = protected_score_markings(techniques, notations)
    glissando_marked = has_glissando_marking(techniques, notations)

    zone = "score_marked_neutral" if protected else "stable_center"
    window_kind = "stable-center"
    target_midi = int(score_midi)
    selected_start = _finite(window_start_seconds)
    selected_end = _finite(window_end_seconds)
    selected_total = _frame_count(total_frame_count)
    selected_voiced = _frame_count(voiced_frame_count)
    selected_ratio = _finite(voiced_frame_ratio)
    selected_median = _finite(median_observed_midi)
    selected_spread = _finite(spread_cents_p95_p05)
    selected_iqr = _finite(iqr_cents)

    if not protected and glissando_marked:
        zone = "glissando_target_tail"
        window_kind = "glissando-target-tail"
        if glissando_target_midi is not None:
            target_midi = int(glissando_target_midi)
        selected_start = _finite(target_tail_window_start_seconds)
        selected_end = _finite(target_tail_window_end_seconds)
        selected_total = _frame_count(target_tail_total_frame_count)
        selected_voiced = _frame_count(target_tail_voiced_frame_count)
        selected_ratio = _finite(target_tail_voiced_frame_ratio)
        selected_median = _finite(target_tail_median_observed_midi)
        selected_spread = _finite(target_tail_spread_cents_p95_p05)
        selected_iqr = _finite(target_tail_iqr_cents)

    window_available = bool(
        selected_start is not None
        and selected_end is not None
        and selected_end > selected_start
        and selected_total > 0
    )
    high_dispersion = bool(
        (selected_spread is not None and selected_spread > M3PLUS_MAX_SPREAD_P95_P05_CENTS)
        or (selected_iqr is not None and selected_iqr > M3PLUS_MAX_IQR_CENTS)
    )
    center_error_cents = (
        (selected_median - target_midi) * 100.0
        if selected_median is not None
        else None
    )

    decision = "insufficient_evidence"
    reason = "pitch-safety-evidence-not-ready"
    if protected:
        reason = "score-marked-region-neutralized"
    elif polyphonic_score_region:
        zone = "multi_f0_review_only"
        reason = "polyphonic-score-region-requires-multi-f0"
    elif glissando_marked and glissando_target_midi is None:
        reason = "glissando-target-unavailable"
    elif not timing_assignment_available:
        reason = "timing-assignment-missing"
    elif not window_available:
        reason = "pitch-window-missing"
    elif selected_total < M3PLUS_MIN_TOTAL_FRAME_COUNT:
        reason = "pitch-window-frame-count-below-floor"
    elif selected_voiced < M3PLUS_MIN_VOICED_FRAME_COUNT:
        reason = "voiced-frame-count-below-floor"
    elif selected_ratio is None or selected_ratio < M3PLUS_MIN_VOICED_FRAME_RATIO:
        reason = "voiced-frame-ratio-below-floor"
    elif selected_median is None:
        reason = "center-pitch-missing"
    elif selected_spread is None or selected_iqr is None:
        reason = "pitch-dispersion-missing"
    elif high_dispersion:
        reason = "pitch-dispersion-too-high"
    elif center_error_cents is None:
        reason = "center-pitch-error-missing"
    elif abs(center_error_cents) > M3PLUS_PITCH_TOLERANCE_CENTS:
        decision = "issue_detected"
        reason = "center-pitch-outside-tolerance"
    else:
        decision = "confirmed_center"
        reason = "center-pitch-within-tolerance"

    return {
        "evaluationContract": M3PLUS_EVALUATION_CONTRACT,
        "runtimeContract": M3PLUS_RUNTIME_CONTRACT,
        "policyVersion": M3PLUS_RUNTIME_POLICY_VERSION,
        "policySemanticSha256": M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256,
        "f0Backend": M3PLUS_F0_BACKEND,
        "zone": zone,
        "decision": decision,
        "reason": reason,
        "accusationIssued": decision == "issue_detected",
        "highDispersion": high_dispersion,
        "reviewOnly": True,
        "feedbackAuthorized": False,
        "studentFacing": False,
        "scoreTechniques": techniques,
        "scoreNotations": notations,
        "protectedMarkings": protected,
        "polyphonicScoreRegion": bool(polyphonic_score_region),
        "glissandoMarked": glissando_marked,
        "glissandoTargetMidi": int(glissando_target_midi) if glissando_target_midi is not None else None,
        "analysisWindowKind": window_kind,
        "timingAssignmentAvailable": bool(timing_assignment_available),
        "windowAvailable": window_available,
        "windowStartSeconds": round(selected_start, 6) if selected_start is not None else None,
        "windowEndSeconds": round(selected_end, 6) if selected_end is not None else None,
        "totalFrameCount": selected_total,
        "voicedFrameCount": selected_voiced,
        "voicedFrameRatio": round(selected_ratio, 6) if selected_ratio is not None else None,
        "targetMidi": target_midi,
        "medianObservedMidi": round(selected_median, 6) if selected_median is not None else None,
        "centerErrorCents": round(center_error_cents, 6) if center_error_cents is not None else None,
        "spreadCentsP95P05": round(selected_spread, 6) if selected_spread is not None else None,
        "iqrCents": round(selected_iqr, 6) if selected_iqr is not None else None,
        "thresholds": dict(M3PLUS_RUNTIME_POLICY_DESCRIPTOR["thresholds"]),
    }
