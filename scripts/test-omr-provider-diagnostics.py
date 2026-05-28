from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))

from analyzer import ErhuAnalyzer  # noqa: E402
from config import Settings  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def reasons(stats: dict[str, object]) -> list[str]:
    recommendation = stats.get("secondaryProviderRecommendation")
    require(isinstance(recommendation, dict), "Expected secondary provider recommendation.")
    return list(recommendation.get("reasons") or [])


def main() -> int:
    settings = Settings(
        audiveris_cli=sys.executable,
        homr_cli=sys.executable,
        omr_secondary_low_confidence_threshold=0.85,
        omr_secondary_low_part_confidence_threshold=0.85,
        omr_secondary_low_erhu_ratio_threshold=0.5,
    )
    analyzer = ErhuAnalyzer(settings)

    low_voice_stats = analyzer._with_omr_provider_diagnostics(
        {"mode": "pagewise", "pageCount": 10},
        omr_status="completed",
        omr_confidence=0.9,
        selected_part_confidence=0.82,
        piece_pack={"scoreLineStats": {"noteCount": 120, "erhuRatio": 0.31}},
    )
    low_voice_reasons = reasons(low_voice_stats)
    require(low_voice_stats.get("secondaryProviderRecommended") is True, "Low voice quality should recommend secondary OMR.")
    require("low-selected-part-confidence" in low_voice_reasons, f"Missing part-confidence reason: {low_voice_reasons}")
    require("low-erhu-line-ratio" in low_voice_reasons, f"Missing erhu-ratio reason: {low_voice_reasons}")

    covered_full_score_stats = analyzer._with_omr_provider_diagnostics(
        {"mode": "pagewise", "pageCount": 10},
        omr_status="completed",
        omr_confidence=0.9,
        selected_part_confidence=0.9,
        piece_pack={"scoreLineStats": {"noteCount": 120, "erhuRatio": 0.31, "erhuPageCoverage": 0.9}},
    )
    require(
        "low-erhu-line-ratio" not in reasons(covered_full_score_stats),
        "Low erhu note ratio alone should not recommend secondary OMR when erhu pages are covered.",
    )

    clean_stats = analyzer._with_omr_provider_diagnostics(
        {"mode": "pagewise", "pageCount": 2},
        omr_status="completed",
        omr_confidence=0.9,
        selected_part_confidence=0.96,
        piece_pack={"scoreLineStats": {"noteCount": 120, "erhuRatio": 1.0}},
    )
    require(clean_stats.get("secondaryProviderRecommended") is False, "Clean import should not recommend secondary OMR.")
    require(reasons(clean_stats) == [], f"Clean import should have no secondary reasons: {reasons(clean_stats)}")

    failed_stats = analyzer._with_omr_provider_diagnostics(
        {"mode": "none", "pageCount": 1},
        omr_status="failed",
        omr_confidence=0.0,
        selected_part_confidence=0.0,
        piece_pack=None,
    )
    failed_reasons = reasons(failed_stats)
    homr_candidates = [item for item in failed_stats.get("providerCandidates") or [] if item.get("provider") == "homr"]
    require("primary-import-failed" in failed_reasons, f"Missing failed-import reason: {failed_reasons}")
    require(homr_candidates, "Missing homr candidate.")
    require(homr_candidates[0].get("mainlineExecutable") is False, "HOMR must remain diagnostic-only.")

    print(json.dumps({
        "ok": True,
        "lowVoiceReasons": low_voice_reasons,
        "cleanRecommended": clean_stats.get("secondaryProviderRecommended"),
        "failedReasons": failed_reasons,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
