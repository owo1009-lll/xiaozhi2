#!/usr/bin/env python3
"""Replay the 12 cached photo-score runs under P0 feedback policies.

No OMR or audio inference is run. The script re-evaluates cached Audiveris
archives with the current P0 structure gate and compares two explicit policies:
strict review, and a green-only simulation that emits zero accusations.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from western_m4_omr_structure import evaluate_p0_structure


REPO = Path(__file__).resolve().parents[2]
DEFAULT_RUNS = REPO / "data/analysis-photo-score"
DEFAULT_OUT = REPO / "data/experiments/western-strings-m4/p0-feedback-impact"
DEFAULT_DUAL_EVIDENCE = (
    REPO / "data/experiments/western-strings-m4/dual-evidence-gold-audit/report.json"
)
MIN_CONFIRMED = 20
MIN_AGREEMENT = 0.6


def _candidate_gate(piece_dir: Path, variant: str) -> dict:
    omr_dir = piece_dir / "variants" / variant / "omr"
    archives = sorted(omr_dir.glob("*.omr"))
    exports = sorted(omr_dir.glob("*.mxl"))
    if not archives:
        return {
            "ready": False,
            "clefReady": False,
            "keyReady": False,
            "meterReady": False,
            "reasons": ["omr-archive-missing"],
        }
    return evaluate_p0_structure(archives[0], exports)


def _winner(candidates: list[dict], require_structure: bool = False) -> dict | None:
    usable = [
        row
        for row in candidates
        if row.get("status") == "ok"
        and (not require_structure or (row.get("scoreStructureGate") or {}).get("ready") is True)
    ]
    return max(
        usable,
        key=lambda row: (int(row.get("confirmed") or 0), float(row.get("agreement") or 0.0)),
        default=None,
    )


def _strict_decision(candidates: list[dict]) -> str:
    any_winner = _winner(candidates)
    if any_winner is None or int(any_winner.get("confirmed") or 0) <= 0:
        return "retake-photo"
    winner = _winner(candidates, require_structure=True)
    if winner is None:
        return "score-structure-review-required"
    if (
        int(winner.get("confirmed") or 0) >= MIN_CONFIRMED
        and float(winner.get("agreement") or 0.0) >= MIN_AGREEMENT
    ):
        return f"full-feedback:{winner['variant']}"
    return f"degraded-feedback:{winner['variant']}"


def _green_only_decision(candidates: list[dict]) -> tuple[str, int]:
    strict = _strict_decision(candidates)
    if strict != "score-structure-review-required":
        winner = _winner(candidates, require_structure=True) or _winner(candidates)
        return strict, int((winner or {}).get("confirmed") or 0)
    winner = _winner(candidates)
    confirmed = int((winner or {}).get("confirmed") or 0)
    if winner is None or confirmed <= 0:
        return "retake-photo", 0
    return f"degraded-green-only:{winner['variant']}", confirmed


def evaluate_piece(piece_dir: Path) -> dict:
    audit = json.loads((piece_dir / "audit.json").read_text(encoding="utf-8"))
    candidates: list[dict] = []
    for source in audit.get("candidates") or []:
        variant = str(source.get("variant") or "")
        candidates.append(
            {
                "variant": variant,
                "status": source.get("status"),
                "confirmed": int(source.get("confirmed") or 0),
                "agreement": float(source.get("agreement") or 0.0),
                "scoreStructureGate": _candidate_gate(piece_dir, variant),
            }
        )
    strict = _strict_decision(candidates)
    green_only, retained_green = _green_only_decision(candidates)
    return {
        "pieceId": piece_dir.name,
        "historicalDecision": audit.get("decision"),
        "strictReviewDecision": strict,
        "greenOnlyDecision": green_only,
        "retainedConfirmedGreenCount": retained_green,
        "greenOnlyAccusationCount": 0,
        "anyP0Ready": any(
            (row.get("scoreStructureGate") or {}).get("ready") is True for row in candidates
        ),
        "candidates": candidates,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", default=str(DEFAULT_RUNS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--dual-evidence-report", default=str(DEFAULT_DUAL_EVIDENCE))
    args = parser.parse_args()

    run_root = Path(args.runs)
    rows = [
        evaluate_piece(path)
        for path in sorted(run_root.glob("violin-ex[0-9][0-9]"))
        if (path / "audit.json").exists()
    ]
    historical = Counter(str(row["historicalDecision"]).split(":", 1)[0] for row in rows)
    strict = Counter(str(row["strictReviewDecision"]).split(":", 1)[0] for row in rows)
    green_only = Counter(str(row["greenOnlyDecision"]).split(":", 1)[0] for row in rows)
    dual_path = Path(args.dual_evidence_report)
    dual = json.loads(dual_path.read_text(encoding="utf-8")) if dual_path.exists() else {}
    dual_summary = dual.get("summary") or {}
    sequence = dual_summary.get("sequence") or {}
    summary = {
        "pieceCount": len(rows),
        "historicalDecisionCounts": dict(historical),
        "p0ReadyPieceCount": sum(bool(row["anyP0Ready"]) for row in rows),
        "strictReviewDecisionCounts": dict(strict),
        "greenOnlyDecisionCounts": dict(green_only),
        "greenOnlyRetainedPieceCount": sum(
            str(row["greenOnlyDecision"]).startswith("degraded-green-only:") for row in rows
        ),
        "greenOnlyRetainedConfirmedNoteCount": sum(
            int(row["retainedConfirmedGreenCount"])
            for row in rows
            if str(row["greenOnlyDecision"]).startswith("degraded-green-only:")
        ),
        "greenOnlyAccusationCount": 0,
        "greenOnlyGoldAudit": {
            "basis": "sequence-mapping; structural-is-diagnostic-only",
            "precision": sequence.get("precision"),
            "wilson95Lower": sequence.get("wilson95Lower"),
            "minPiecePrecision": dual_summary.get("minPieceSequencePrecision"),
            "evalOnlyGatePassed": dual_summary.get("evalOnlyGatePassed"),
            "source": str(dual_path),
        },
        "greenOnlyRecommendedForProduction": bool(dual_summary.get("evalOnlyGatePassed") is True),
        "productionPolicyChanged": False,
    }
    report = {
        "schemaVersion": 1,
        "evalOnly": True,
        "summary": summary,
        "rows": rows,
        "interpretation": [
            "Historical decisions are replayed from the 12 cached three-variant audits; no OMR or audio model was rerun.",
            "Strict-review is the current production behavior when no variant passes P0.",
            "Green-only is a policy simulation: it retains only independently audio-confirmed green notes and emits zero accusations.",
            "The independent-gold sequence audit is the primary green-safety lens; structural mapping remains diagnostic-only because OMR measure structure is weak.",
            "Overall sequence precision is high but its per-piece floor fails, so green-only remains eval-only.",
            "This report measures availability impact and does not change production policy.",
        ],
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    lines = [
        "# M4 P0 feedback impact",
        "",
        "Cached 12-photo replay; no OMR/audio recomputation.",
        "",
        f"- historical: `{dict(historical)}`",
        f"- any P0-ready variant: {summary['p0ReadyPieceCount']}/{summary['pieceCount']}",
        f"- strict review: `{dict(strict)}`",
        f"- green-only simulation: `{dict(green_only)}`",
        f"- retained confirmed greens: {summary['greenOnlyRetainedConfirmedNoteCount']}",
        "- green-only accusations: 0",
        f"- prior green sequence precision: {sequence.get('precision')} (minimum piece {dual_summary.get('minPieceSequencePrecision')})",
        f"- green-only recommended for production: {summary['greenOnlyRecommendedForProduction']}",
        "- production policy changed: false",
        "",
        "| piece | historical | P0 | strict | green-only | retained greens |",
        "|---|---|---:|---|---|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['pieceId']} | {row['historicalDecision']} | {row['anyP0Ready']} | "
            f"{row['strictReviewDecision']} | {row['greenOnlyDecision']} | "
            f"{row['retainedConfirmedGreenCount']} |"
        )
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "summary": summary, "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
