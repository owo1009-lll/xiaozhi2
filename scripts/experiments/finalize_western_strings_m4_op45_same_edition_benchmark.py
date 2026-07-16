#!/usr/bin/env python3
"""Promote reviewed Op.45 gold and build the two-page three-engine report.

The command reuses frozen OMR outputs. It does not rerun any engine. HOMR's
candidate-derived gold is retained as human-reviewed evidence but excluded
from the independent automatic-adoption page count.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from eval_western_strings_m4_omr_benchmark import REPO, evaluate_pair
from promote_western_strings_m4_op45_same_edition_gold import (
    DEFAULT_CANDIDATE,
    DEFAULT_GOLD,
    DEFAULT_PROVENANCE,
    DEFAULT_SOURCE,
    promote,
    sha256,
    write_json_atomic,
)
from summarize_western_strings_m4_same_edition_benchmark import (
    DEFAULT_AUDIVERIS,
    DEFAULT_HOMR,
    DEFAULT_OEMER,
    build_report,
    select_rows,
    write_markdown,
)


DEFAULT_AUDIVERIS_DRAFT = (
    REPO / "data" / "experiments" / "western-strings-m4" / "new-test-runs" /
    "etude-op45-no34-score" / "up4-retry" / "omr" /
    "etude-op45-no34-up4-autocontrast.mxl"
)
DEFAULT_OEMER_DRAFT = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "op45-34-same-edition-benchmark" / "oemer" / "op45-34-photo" /
    "omr-sk120" / "op45-34-photo-up2.musicxml"
)
DEFAULT_HOMR_DRAFT = DEFAULT_CANDIDATE
DEFAULT_OUT = (
    REPO / "data" / "experiments" / "western-strings-m4" /
    "same-edition-multipage-benchmark" / "same-edition-engine-comparison.json"
)
PIECE_ID = "wohlfahrt-op45-no34-photo"
RECORDING_ID = "wohlfahrt-op45-no34-human-reviewed-gold"


def evaluate_existing_draft(
    *,
    engine_key: str,
    variant: str,
    draft_path: Path,
    gold_path: Path,
    provenance: dict[str, Any],
    provenance_path: Path,
) -> dict[str, Any]:
    if not draft_path.is_file():
        raise FileNotFoundError(f"{engine_key} frozen draft is missing: {draft_path}")
    reviewer = str(provenance.get("reviewer") or "").strip()
    if not reviewer:
        raise ValueError("promoted provenance has no reviewer")
    row = {
        "pieceId": PIECE_ID,
        "recordingId": RECORDING_ID,
        "requiredCleanScorePath": str(gold_path),
        "cleanScoreReviewStatus": "approved",
        "cleanScoreReviewedBy": reviewer,
    }
    result = evaluate_pair(
        row,
        {PIECE_ID: {"mxl": str(draft_path)}},
        draft_path.parent,
        0.25,
    )
    if not result.get("parseOk") or not result.get("benchmarkUsable"):
        raise ValueError(
            f"{engine_key} frozen draft cannot enter the benchmark: "
            f"{result.get('blockingReason') or 'unknown-error'}"
        )
    candidate_engine = str(provenance.get("candidateEngine") or "")
    evaluated_engine = "audiveris" if engine_key.startswith("audiveris") else engine_key
    bias_risk = (
        bool(provenance.get("candidateEngineBiasRisk"))
        and candidate_engine.lower().startswith(evaluated_engine.lower())
    )
    result.update({
        "engine": engine_key,
        "variant": variant,
        "status": "ok",
        "reusedExisting": True,
        "draftSha256": sha256(draft_path),
        "goldProvenancePath": (
            str(provenance_path.relative_to(REPO))
            if provenance_path.is_relative_to(REPO)
            else str(provenance_path)
        ),
        "goldCandidateEngine": candidate_engine,
        "goldIndependentFromEvaluatedEngine": not bias_risk,
        "candidateEngineBiasRisk": bias_risk,
    })
    return result


def finalize(
    *,
    review_path: Path,
    source_path: Path = DEFAULT_SOURCE,
    candidate_path: Path = DEFAULT_CANDIDATE,
    gold_path: Path = DEFAULT_GOLD,
    provenance_path: Path = DEFAULT_PROVENANCE,
    audiveris_draft: Path = DEFAULT_AUDIVERIS_DRAFT,
    oemer_draft: Path = DEFAULT_OEMER_DRAFT,
    homr_draft: Path = DEFAULT_HOMR_DRAFT,
    base_audiveris_report: Path = DEFAULT_AUDIVERIS,
    base_oemer_report: Path = DEFAULT_OEMER,
    base_homr_report: Path = DEFAULT_HOMR,
    out_path: Path = DEFAULT_OUT,
) -> dict[str, Any]:
    provenance = promote(
        review_path=review_path,
        source_path=source_path,
        candidate_path=candidate_path,
        gold_path=gold_path,
        provenance_path=provenance_path,
    )
    rows_by_engine = {
        "audiveris-up2": select_rows(base_audiveris_report, "audiveris-up2"),
        "oemer": select_rows(base_oemer_report, "oemer"),
        "homr": select_rows(base_homr_report, "homr"),
    }
    specifications = (
        ("audiveris-up2", "up4-rescue", audiveris_draft),
        ("oemer", "up2-sk120", oemer_draft),
        ("homr", "native-source", homr_draft),
    )
    for engine_key, variant, draft_path in specifications:
        rows_by_engine[engine_key].append(evaluate_existing_draft(
            engine_key=engine_key,
            variant=variant,
            draft_path=draft_path,
            gold_path=gold_path,
            provenance=provenance,
            provenance_path=provenance_path,
        ))

    report = build_report(rows_by_engine)
    report["op45GoldPromotion"] = provenance
    report["audiverisPreprocessingPolicy"] = {
        "summaryKey": "audiveris-up2",
        "meaning": "legacy aggregate key; inspect each row's variant",
        "beijingVariant": "up2",
        "op45Variant": "up4-rescue",
        "productionComparable": False,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(out_path, report)
    write_markdown(report, out_path.with_suffix(".md"))
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", required=True)
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--candidate", default=str(DEFAULT_CANDIDATE))
    parser.add_argument("--gold", default=str(DEFAULT_GOLD))
    parser.add_argument("--provenance", default=str(DEFAULT_PROVENANCE))
    parser.add_argument("--audiveris-draft", default=str(DEFAULT_AUDIVERIS_DRAFT))
    parser.add_argument("--oemer-draft", default=str(DEFAULT_OEMER_DRAFT))
    parser.add_argument("--homr-draft", default=str(DEFAULT_HOMR_DRAFT))
    parser.add_argument("--base-audiveris-report", default=str(DEFAULT_AUDIVERIS))
    parser.add_argument("--base-oemer-report", default=str(DEFAULT_OEMER))
    parser.add_argument("--base-homr-report", default=str(DEFAULT_HOMR))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)
    report = finalize(
        review_path=Path(args.review).resolve(),
        source_path=Path(args.source).resolve(),
        candidate_path=Path(args.candidate).resolve(),
        gold_path=Path(args.gold).resolve(),
        provenance_path=Path(args.provenance).resolve(),
        audiveris_draft=Path(args.audiveris_draft).resolve(),
        oemer_draft=Path(args.oemer_draft).resolve(),
        homr_draft=Path(args.homr_draft).resolve(),
        base_audiveris_report=Path(args.base_audiveris_report).resolve(),
        base_oemer_report=Path(args.base_oemer_report).resolve(),
        base_homr_report=Path(args.base_homr_report).resolve(),
        out_path=Path(args.out).resolve(),
    )
    print(json.dumps({
        "out": str(Path(args.out).resolve()),
        "goldIdentity": report["goldIdentity"],
        "candidate": report["candidate"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
