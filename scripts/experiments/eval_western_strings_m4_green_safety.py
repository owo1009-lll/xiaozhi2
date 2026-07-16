#!/usr/bin/env python3
"""Audit false green notes and runtime-only piece safety signals.

The independent score is used only to label/evaluate pieces. Candidate gates
may use only fields available at runtime. This script is eval-only and never
changes the student feedback policy.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_DUAL_REPORT = (
    REPO / "data/experiments/western-strings-m4/dual-evidence-gold-audit/report.json"
)
DEFAULT_RUNS = REPO / "data/analysis-photo-score"
DEFAULT_VERDICTS = REPO / "data/experiments/western-strings-m4/score-anchored-proto"
DEFAULT_OUT = REPO / "data/experiments/western-strings-m4/green-safety-audit"


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return float(ordered[index])


def runtime_features(
    piece_row: dict[str, Any],
    runs_root: Path,
    verdict_root: Path,
) -> dict[str, Any]:
    piece = str(piece_row["piece"])
    verdict_path = verdict_root / piece / f"{piece}-verdicts.json"
    audit_path = runs_root / piece / "audit.json"
    verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    per_note = list(verdict.get("perNote") or [])
    greens = [row for row in per_note if row.get("verdict") == "confirmed"]
    residuals = [
        abs(float(row["timingDeviationSec"]))
        for row in greens
        if row.get("timingDeviationSec") is not None
    ]
    counts = Counter(verdict.get("verdictCounts") or {})
    total = sum(int(value) for value in counts.values())
    candidates = [
        row for row in audit.get("candidates") or [] if row.get("status") == "ok"
    ]
    agreements = [float(row.get("agreement") or 0.0) for row in candidates]
    confirmed = [int(row.get("confirmed") or 0) for row in candidates]
    confirmed_mean = statistics.mean(confirmed) if confirmed else 0.0
    return {
        "pieceId": piece,
        "greenCount": len(greens),
        "greenDensity": round(len(greens) / max(1, len(per_note)), 6),
        "audioAgreement": round(float(verdict.get("audioAgreementHeard") or 0.0), 6),
        "pieceGateOk": int(verdict.get("pieceGate") == "ok"),
        "uncertainMeasureCount": len(verdict.get("uncertainMeasures") or []),
        "uncertainEventRate": round(
            int(counts.get("anchor-uncertain", 0)) / max(1, total), 6
        ),
        "neutralEventRate": round(
            (
                int(counts.get("no-audio-evidence", 0))
                + int(counts.get("beyond-recording", 0))
            )
            / max(1, total),
            6,
        ),
        "timingAbsMedianSec": (
            round(float(statistics.median(residuals)), 6) if residuals else None
        ),
        "timingAbsP90Sec": (
            round(float(percentile(residuals, 0.90)), 6) if residuals else None
        ),
        "usableVariantCount": len(candidates),
        "variantAgreementRange": (
            round(max(agreements) - min(agreements), 6) if agreements else None
        ),
        "variantConfirmedCv": (
            round(float(statistics.pstdev(confirmed) / confirmed_mean), 6)
            if len(confirmed) > 1 and confirmed_mean > 0
            else 0.0
        ),
    }


def classify_false_green(
    piece: str,
    row: dict[str, Any],
    per_note: list[dict[str, Any]],
    repeated_substitutions: Counter[tuple[tuple[int, ...], tuple[int, ...]]],
) -> str:
    index = int(row["draftIndex"])
    draft_pitch = tuple(int(value) for value in row.get("draftMidis") or [])
    gold_pitch = tuple(int(value) for value in row.get("goldMidis") or [])
    structural = row.get("structuralGoldIndex")
    sequence = row.get("sequenceGoldIndex")
    previous = per_note[index - 1] if index > 0 else {}
    if structural is None or structural != sequence:
        return "score-audio-coincidence-with-structure-drift"
    if index > 0 and previous.get("scoreMidis") == row.get("draftMidis"):
        return "missing-onset-repeated-pitch-collapse"
    if repeated_substitutions[(draft_pitch, gold_pitch)] >= 2:
        return "systematic-score-audio-pitch-coincidence"
    return "isolated-score-audio-pitch-coincidence"


def false_green_autopsy(
    piece_rows: list[dict[str, Any]], verdict_root: Path
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for piece_row in piece_rows:
        piece = str(piece_row["piece"])
        false_rows = [
            row
            for row in piece_row.get("rows") or []
            if row.get("verdict") == "confirmed"
            and row.get("sequenceGoldIndex") is not None
            and row.get("sequenceExact") is False
        ]
        if not false_rows:
            continue
        verdict = json.loads(
            (verdict_root / piece / f"{piece}-verdicts.json").read_text(encoding="utf-8")
        )
        per_note = list(verdict.get("perNote") or [])
        substitutions = Counter(
            (
                tuple(int(value) for value in row.get("draftMidis") or []),
                tuple(
                    int(value)
                    for value in next(
                        detail
                        for detail in piece_row.get("falseGreenRows") or []
                        if int(detail["draftIndex"]) == int(row["draftIndex"])
                    ).get("goldMidis")
                    or []
                ),
            )
            for row in false_rows
        )
        false_by_index = {
            int(row["draftIndex"]): row for row in piece_row.get("falseGreenRows") or []
        }
        for row in false_rows:
            index = int(row["draftIndex"])
            detail = false_by_index[index]
            merged = {**row, "goldMeasure": detail.get("goldMeasure"), "goldMidis": detail.get("goldMidis")}
            evidence = per_note[index]
            output.append(
                {
                    "pieceId": piece,
                    "draftIndex": index,
                    "draftMeasure": row.get("draftMeasure"),
                    "goldMeasure": detail.get("goldMeasure"),
                    "draftMidis": row.get("draftMidis"),
                    "goldMidis": detail.get("goldMidis"),
                    "audioMidis": evidence.get("audioMidis"),
                    "timingDeviationSec": evidence.get("timingDeviationSec"),
                    "sequenceGoldIndex": row.get("sequenceGoldIndex"),
                    "structuralGoldIndex": row.get("structuralGoldIndex"),
                    "f0Evidence": row.get("f0Evidence"),
                    "mechanism": classify_false_green(
                        piece, merged, per_note, substitutions
                    ),
                }
            )
    return output


def candidate_thresholds(values: list[float]) -> list[float]:
    unique = sorted(set(values))
    if not unique:
        return []
    epsilon = max(1e-9, (unique[-1] - unique[0]) * 1e-6)
    return [unique[0] - epsilon] + [
        (left + right) / 2.0 for left, right in zip(unique, unique[1:])
    ] + [unique[-1] + epsilon]


def fit_zero_false_positive_threshold(
    rows: list[dict[str, Any]], feature: str
) -> dict[str, Any] | None:
    usable = [row for row in rows if row.get(feature) is not None]
    if not usable or not any(not row["safe"] for row in usable):
        return None
    best = None
    values = [float(row[feature]) for row in usable]
    for direction in ("le", "ge"):
        for threshold in candidate_thresholds(values):
            passed = [
                row
                for row in usable
                if (float(row[feature]) <= threshold if direction == "le" else float(row[feature]) >= threshold)
            ]
            unsafe_passed = sum(not row["safe"] for row in passed)
            if unsafe_passed:
                continue
            safe_passed = sum(bool(row["safe"]) for row in passed)
            candidate = {
                "direction": direction,
                "threshold": round(threshold, 9),
                "safePassed": safe_passed,
                "unsafePassed": unsafe_passed,
                "totalPassed": len(passed),
            }
            score = (safe_passed, len(passed))
            if best is None or score > best[0]:
                best = (score, candidate)
    return best[1] if best else None


def passes_threshold(row: dict[str, Any], feature: str, gate: dict[str, Any] | None) -> bool:
    if gate is None or row.get(feature) is None:
        return False
    value = float(row[feature])
    threshold = float(gate["threshold"])
    return value <= threshold if gate["direction"] == "le" else value >= threshold


def evaluate_feature(rows: list[dict[str, Any]], feature: str) -> dict[str, Any]:
    in_sample = fit_zero_false_positive_threshold(rows, feature)
    predictions = []
    for holdout in rows:
        training = [row for row in rows if row is not holdout]
        gate = fit_zero_false_positive_threshold(training, feature)
        predictions.append(
            {
                "pieceId": holdout["pieceId"],
                "safe": holdout["safe"],
                "passed": passes_threshold(holdout, feature, gate),
                "trainedGate": gate,
            }
        )
    passed = [row for row in predictions if row["passed"]]
    safe_count = sum(bool(row["safe"]) for row in predictions)
    safe_passed = sum(bool(row["safe"]) for row in passed)
    unsafe_passed = sum(not row["safe"] for row in passed)
    return {
        "feature": feature,
        "inSampleGate": in_sample,
        "leaveOnePieceOut": {
            "safePieceCount": safe_count,
            "unsafePieceCount": len(predictions) - safe_count,
            "passedPieceCount": len(passed),
            "safePassed": safe_passed,
            "unsafePassed": unsafe_passed,
            "precision": round(safe_passed / len(passed), 6) if passed else None,
            "safeCoverage": round(safe_passed / safe_count, 6) if safe_count else 0.0,
            "predictions": predictions,
        },
        "runtimeGateCandidate": bool(
            passed and unsafe_passed == 0 and safe_passed / max(1, safe_count) >= 0.20
        ),
    }


def evaluate_nested_feature_selection(
    rows: list[dict[str, Any]], feature_names: list[str]
) -> dict[str, Any]:
    predictions = []
    for holdout in rows:
        training = [row for row in rows if row is not holdout]
        candidates = []
        for feature in feature_names:
            gate = fit_zero_false_positive_threshold(training, feature)
            if gate is not None:
                candidates.append((gate["safePassed"], gate["totalPassed"], feature, gate))
        candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
        if not candidates:
            selected_feature, selected_gate = None, None
        else:
            _, _, selected_feature, selected_gate = candidates[0]
        predictions.append(
            {
                "pieceId": holdout["pieceId"],
                "safe": holdout["safe"],
                "selectedFeature": selected_feature,
                "selectedGate": selected_gate,
                "passed": bool(
                    selected_feature
                    and passes_threshold(holdout, selected_feature, selected_gate)
                ),
            }
        )
    passed = [row for row in predictions if row["passed"]]
    safe_count = sum(bool(row["safe"]) for row in predictions)
    safe_passed = sum(bool(row["safe"]) for row in passed)
    unsafe_passed = sum(not row["safe"] for row in passed)
    return {
        "method": "outer-LOPO-with-inner-runtime-feature-selection",
        "passedPieceCount": len(passed),
        "safePassed": safe_passed,
        "unsafePassed": unsafe_passed,
        "precision": round(safe_passed / len(passed), 6) if passed else None,
        "safeCoverage": round(safe_passed / safe_count, 6) if safe_count else 0.0,
        "predictions": predictions,
        "releaseCandidate": bool(
            passed and unsafe_passed == 0 and safe_passed / max(1, safe_count) >= 0.20
        ),
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    summary = report["summary"]
    lines = [
        "# M4 green safety audit",
        "",
        "Eval-only. No student policy is changed.",
        "",
        f"- pieces with evaluable greens: {summary['evaluablePieceCount']}",
        f"- sequence-perfect pieces: {summary['safePieceCount']}",
        f"- non-perfect pieces: {summary['unsafePieceCount']}",
        f"- sequence false greens: {summary['falseGreenCount']}",
        f"- single-feature fresh-validation candidate: {summary['freshValidationCandidateFound']}",
        f"- nested release candidate: {summary['releaseGateCandidateFound']}",
        f"- production policy changed: {summary['productionPolicyChanged']}",
        "",
        "## False-green autopsy",
        "",
        "| piece | draft | measure | draft -> gold | audio | residual(s) | mechanism |",
        "|---|---:|---:|---|---|---:|---|",
    ]
    for row in report["falseGreenAutopsy"]:
        lines.append(
            f"| {row['pieceId']} | {row['draftIndex']} | {row['draftMeasure']} | "
            f"{row['draftMidis']} -> {row['goldMidis']} | {row['audioMidis']} | "
            f"{row['timingDeviationSec']} | {row['mechanism']} |"
        )
    lines.extend(
        [
            "",
            "## Runtime-only feature probes",
            "",
            "| feature | in-sample gate | LOPO precision | LOPO safe coverage | unsafe passed | candidate |",
            "|---|---|---:|---:|---:|---:|",
        ]
    )
    for row in report["featureAudits"]:
        gate = row.get("inSampleGate")
        gate_text = (
            f"{gate['direction']} {gate['threshold']}" if gate else "none"
        )
        lo = row["leaveOnePieceOut"]
        lines.append(
            f"| {row['feature']} | {gate_text} | {lo['precision']} | "
            f"{lo['safeCoverage']} | {lo['unsafePassed']} | {row['runtimeGateCandidate']} |"
        )
    nested = report["nestedFeatureSelection"]
    lines.extend(
        [
            "",
            "## Nested feature-selection audit",
            "",
            f"- precision: {nested['precision']}",
            f"- safe coverage: {nested['safeCoverage']}",
            f"- unsafe pieces passed: {nested['unsafePassed']}",
            f"- release candidate: {nested['releaseCandidate']}",
        ]
    )
    lines.extend(
        [
            "",
            "## Decision",
            "",
            "- Structural mapping remains a diagnostic lens only; it is not a green definition.",
            "- A post-hoc full-data split is not enough. Only leave-one-piece-out results can nominate a runtime gate.",
            "- No runtime-only gate is wired unless it catches every held-out unsafe piece and retains at least 20% of safe pieces.",
            "- Even a passing probe would still require a fresh independent piece before production use.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dual-report", default=str(DEFAULT_DUAL_REPORT))
    parser.add_argument("--runs", default=str(DEFAULT_RUNS))
    parser.add_argument("--verdicts", default=str(DEFAULT_VERDICTS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)
    dual = json.loads(Path(args.dual_report).read_text(encoding="utf-8"))
    piece_rows = list(dual.get("pieces") or [])
    feature_rows = []
    for piece_row in piece_rows:
        precision = (piece_row.get("sequence") or {}).get("precision")
        if precision is None or int(piece_row.get("greenEvents") or 0) <= 0:
            continue
        features = runtime_features(piece_row, Path(args.runs), Path(args.verdicts))
        features.update(
            {
                "safe": float(precision) == 1.0,
                "sequencePrecision": float(precision),
            }
        )
        feature_rows.append(features)
    feature_names = [
        "greenCount",
        "greenDensity",
        "audioAgreement",
        "pieceGateOk",
        "uncertainMeasureCount",
        "uncertainEventRate",
        "neutralEventRate",
        "timingAbsMedianSec",
        "timingAbsP90Sec",
        "usableVariantCount",
        "variantAgreementRange",
        "variantConfirmedCv",
    ]
    feature_audits = [evaluate_feature(feature_rows, name) for name in feature_names]
    autopsy = false_green_autopsy(piece_rows, Path(args.verdicts))
    fresh_candidate_found = any(row["runtimeGateCandidate"] for row in feature_audits)
    nested = evaluate_nested_feature_selection(feature_rows, feature_names)
    report = {
        "schemaVersion": 1,
        "evalOnly": True,
        "studentFacing": False,
        "summary": {
            "evaluablePieceCount": len(feature_rows),
            "safePieceCount": sum(bool(row["safe"]) for row in feature_rows),
            "unsafePieceCount": sum(not row["safe"] for row in feature_rows),
            "falseGreenCount": len(autopsy),
            "falseGreenMechanisms": dict(Counter(row["mechanism"] for row in autopsy)),
            "freshValidationCandidateFound": fresh_candidate_found,
            "releaseGateCandidateFound": nested["releaseCandidate"],
            "freshIndependentValidationRequired": True,
            "productionPolicyChanged": False,
        },
        "pieceRuntimeFeatures": feature_rows,
        "falseGreenAutopsy": autopsy,
        "featureAudits": feature_audits,
        "nestedFeatureSelection": nested,
        "interpretation": [
            "Sequence mapping defines false greens; structural mapping is diagnostic-only because OMR measure structure is weak.",
            "A perfect full-data threshold is post-hoc and is not sufficient for release.",
            "Leave-one-piece-out fitting prevents each holdout from choosing its own threshold.",
            "Any candidate still requires fresh independent piece validation before production use.",
        ],
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_markdown(out / "report.md", report)
    print(json.dumps({"ok": True, "summary": report["summary"], "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
