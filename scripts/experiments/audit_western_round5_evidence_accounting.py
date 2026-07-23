#!/usr/bin/env python3
"""Re-account consumed Round-5 evidence without selecting or retuning a candidate."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
SEGMENT_REPORT = (
    REPO / "data/experiments/western-strings-round5-segment-edit-path/report.json"
)
POSITION_REPORT = (
    REPO / "data/experiments/western-strings-round5-position-balance/report.json"
)
CALIBRATION_REPORT = (
    REPO
    / "data/experiments/western-strings-round5-calibration-failure-audit/report.json"
)
WAVEFORM_REPORT = (
    REPO
    / "docs/evidence/western-strings-round5-policy-c-waveform-robustness-20260724.json"
)
TEMPORAL_POLICY = (
    REPO / "scripts/experiments/eval_western_round5_temporal_operation_path.py"
)
OUT_JSON = (
    REPO / "docs/evidence/western-strings-round5-evidence-accounting-20260724.json"
)
OUT_MD = REPO / "docs/western-strings-round5-evidence-accounting.md"
CONTRACT = "western-round5-evidence-accounting-v1"
EXPECTED_CONTRACTS = {
    SEGMENT_REPORT: "western-round5-segment-edit-path-candidate-v1",
    POSITION_REPORT: "western-round5-position-balance-preflight-v2",
    CALIBRATION_REPORT: "western-round5-calibration-failure-audit-v1",
    WAVEFORM_REPORT: "western-round5-policy-c-waveform-robustness-diagnostic-v1",
}
POSITION_FEATURES = {
    "n_0OutOfRange",
    "n_m1OutOfRange",
    "n_m2OutOfRange",
    "n_p1OutOfRange",
    "n_p2OutOfRange",
    "scoreNextInterval",
    "scorePreviousInterval",
}
GATES = ("merged_substitution", "missing", "extra", "drag")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metrics(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row[key]
        for key in (
            "truePositive",
            "falsePositive",
            "falseNegative",
            "trueNegative",
            "precision",
            "recall",
        )
    }


def report_path(path: Path) -> str:
    return path.resolve().relative_to(REPO.resolve()).as_posix()


def segment_rows(
    segment: dict[str, Any],
    position: dict[str, Any],
    calibration: dict[str, Any],
) -> list[dict[str, Any]]:
    position_confounded = set(position["confoundedSplitGates"])
    calibration_confounded = set(calibration["positionConfoundingDetectedGates"])
    rows = []
    for gate in GATES:
        contaminated_splits = sorted(
            item.split(":", 1)[0]
            for item in position_confounded
            if item.endswith(f":{gate}")
        )
        if gate in calibration_confounded and "calibration" not in contaminated_splits:
            contaminated_splits.append("calibration")
        rows.append({
            "candidateId": f"segment-rf-{gate}",
            "family": "fixed-random-forest-with-score-context",
            "gate": gate,
            "observedFreshBlind": metrics(segment["evaluation"]["gates"][gate]),
            "readsPositionFeatures": True,
            "positionConfoundedSplits": sorted(set(contaminated_splits)),
            "accountingClass": "invalidated-by-position-confounding",
            "validClaim": (
                "Package-specific predictions are reproducible, but neither precision nor "
                "recall establishes performance generalization."
            ),
            "invalidClaim": "Do not promote or compare this raw number as a detector result.",
        })
    return rows


def frozen_rule_rows(
    segment: dict[str, Any],
    position: dict[str, Any],
) -> list[dict[str, Any]]:
    frozen = segment["frozenGapRefinement"]
    rhythm_position_confounded = position["rhythmReviewHint"]["confoundedSplits"]
    return [
        {
            "candidateId": "gap-refinement-self-check",
            "family": "frozen-alignment-gap-rule",
            "gates": ["merged_substitution", "missing"],
            "observedFreshBlind": metrics(frozen["freshBlind"]),
            "byGateRecall": frozen["freshBlind"]["byTargetGate"],
            "readsPositionFeatures": False,
            "positionBalanced": False,
            "accountingClass": "genuine-detection-failure-on-fixed-position-sample",
            "validClaim": (
                "The frozen rule truly detected only 1/12 targets and produced one full-score "
                "false positive; position leakage cannot explain away the 11 misses."
            ),
            "scopeCaveat": (
                "Target placement is not counterbalanced, so the exact rate is not a "
                "generalization estimate."
            ),
        },
        {
            "candidateId": "gap-strict-missing",
            "family": "frozen-alignment-gap-rule-with-health-guard",
            "gates": ["missing"],
            "observedFreshBlind": metrics(frozen["strictIssueCandidate"]["freshBlind"]),
            "readsPositionFeatures": False,
            "positionBalanced": False,
            "accountingClass": "genuine-detection-failure-on-fixed-position-sample",
            "validClaim": (
                "The frozen strict rule truly detected 1/6 missing targets and produced one "
                "full-score false positive; its 16.67% recall is not a score-position model artifact."
            ),
            "scopeCaveat": (
                "Target placement is not counterbalanced, so the exact rate is not a "
                "generalization estimate."
            ),
        },
        {
            "candidateId": "rhythm-structural-self-check",
            "family": "frozen-relative-ioi-duration-operation-rule",
            "gates": ["extra", "drag"],
            "observedFreshBlind": metrics(
                frozen["rhythmStructuralRefinement"]["freshBlind"]
            ),
            "byGateRecall": (
                frozen["rhythmStructuralRefinement"]["freshBlind"]["byTargetGate"]
            ),
            "readsPositionFeatures": False,
            "positionBalanced": False,
            "positionConfoundedSplits": rhythm_position_confounded,
            "accountingClass": "real-sensitivity-observation-safety-not-generalizable",
            "validClaim": (
                "The frozen performance rule really found 4/12 targets and missed 8/12."
            ),
            "invalidClaim": (
                "Its 0/312 package false-positive count cannot establish clean-domain safety, "
                "because the extra/drag target positions are score-context identifiable."
            ),
        },
        {
            "candidateId": "rhythm-strict-extra-drag",
            "family": "frozen-high-confidence-relative-ioi-duration-operation-rule",
            "gates": ["extra", "drag"],
            "observedFreshBlind": metrics(
                frozen["rhythmStructuralRefinement"]["strictIssueCandidate"]["freshBlind"]
            ),
            "readsPositionFeatures": False,
            "positionBalanced": False,
            "positionConfoundedSplits": rhythm_position_confounded,
            "accountingClass": "real-sensitivity-observation-safety-not-generalizable",
            "validClaim": (
                "The frozen strict performance rule really found 4/12 targets and missed 8/12."
            ),
            "invalidClaim": (
                "Its 0/312 package false-positive count cannot establish clean-domain safety, "
                "because the extra/drag target positions are score-context identifiable."
            ),
        },
    ]


def calibration_rows(calibration: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for gate, result in calibration["gates"].items():
        performance = result["performanceOnlyRandomForest"]
        rows.append({
            "candidateId": f"performance-only-calibration-{gate}",
            "family": "score-context-excluded-random-forest-loro",
            "gate": gate,
            "observedCalibrationLoro": performance["metrics"],
            "freshBlindRowsUsed": 0,
            "readsPositionFeatures": False,
            "accountingClass": "position-controlled-calibration-diagnostic-failed",
            "validClaim": (
                "After excluding score-only features, the fixed RF still fails the 90/50/0 "
                "joint floor on calibration leave-one-recording-out."
            ),
            "promotionEligible": False,
        })
    return rows


def waveform_rows(waveform: dict[str, Any]) -> list[dict[str, Any]]:
    energy = waveform["energyAbsence"]["round5Diagnostic"]["pooled"]
    pitch = waveform["targetPitchAbsence"]["round5Diagnostic"]["pooled"]
    return [
        {
            "candidateId": "waveform-energy-absence",
            "family": "frozen-relative-energy-threshold",
            "observedAllRound5": metrics(energy),
            "readsPositionFeatures": False,
            "accountingClass": "genuine-cross-domain-detection-failure",
            "validClaim": (
                "The frozen synthetic threshold emitted no flag on any of 12 real targets. "
                "Its 0% real-domain recall is a genuine transfer failure."
            ),
            "decision": "stop-no-further-investment",
        },
        {
            "candidateId": "waveform-target-pitch-absence",
            "family": "frozen-target-pitch-frame-threshold",
            "observedAllRound5": metrics(pitch),
            "readsPositionFeatures": False,
            "accountingClass": "genuine-cross-domain-precision-and-recall-failure",
            "validClaim": (
                "The frozen synthetic threshold found 5/12 targets but flagged 49/660 ordinary "
                "positions; the 9.26% precision failure is not caused by score-position leakage."
            ),
            "decision": "reject",
        },
    ]


def build_report() -> dict[str, Any]:
    for path, contract in EXPECTED_CONTRACTS.items():
        observed = read_json(path).get("contract")
        if observed != contract:
            raise RuntimeError(
                f"round5-accounting-contract-mismatch:{report_path(path)}:{observed}"
            )
    segment = read_json(SEGMENT_REPORT)
    position = read_json(POSITION_REPORT)
    calibration = read_json(CALIBRATION_REPORT)
    waveform = read_json(WAVEFORM_REPORT)
    leaked_features = sorted(
        set(segment["evaluation"]["featureNames"]) & POSITION_FEATURES
    )
    if leaked_features != sorted(POSITION_FEATURES):
        raise RuntimeError("round5-accounting-position-feature-set-drift")
    temporal_source = TEMPORAL_POLICY.read_text(encoding="utf-8")
    if any(feature in temporal_source for feature in POSITION_FEATURES):
        raise RuntimeError("round5-accounting-temporal-rule-position-feature-leak")
    accounting = [
        *segment_rows(segment, position, calibration),
        *frozen_rule_rows(segment, position),
        *calibration_rows(calibration),
        *waveform_rows(waveform),
    ]
    return {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "evidenceDate": "2026-07-24",
        "evidenceRole": "consumed-round5-reaccounting-only",
        "round5Consumed": True,
        "freshBlindRetuned": False,
        "modelRetrained": False,
        "thresholdChanged": False,
        "studentFacing": False,
        "automaticAccusationReady": False,
        "sourceBindings": [
            {
                "path": report_path(path),
                "sha256": sha256(path),
            }
            for path in (*EXPECTED_CONTRACTS, TEMPORAL_POLICY)
        ],
        "positionLeakAudit": {
            "segmentModelPositionFeatures": leaked_features,
            "confoundedSplitGates": position["confoundedSplitGates"],
            "calibrationPositionConfoundedGates": (
                calibration["positionConfoundingDetectedGates"]
            ),
            "rhythmTargetPositionConfoundedSplits": (
                position["rhythmReviewHint"]["confoundedSplits"]
            ),
        },
        "accounting": accounting,
        "conclusions": {
            "invalidatedByPositionConfounding": [
                row["candidateId"]
                for row in accounting
                if row["accountingClass"] == "invalidated-by-position-confounding"
            ],
            "genuineDetectionFailures": [
                row["candidateId"]
                for row in accounting
                if row["accountingClass"] in {
                    "genuine-detection-failure-on-fixed-position-sample",
                    "genuine-cross-domain-detection-failure",
                    "genuine-cross-domain-precision-and-recall-failure",
                }
            ],
            "retainedOnlyAsSensitivityObservation": [
                "rhythm-structural-self-check",
                "rhythm-strict-extra-drag",
            ],
            "positionControlledCandidatePassed": False,
            "strictConfirmedRecall": "2/12",
            "round5CanAuthorizePromotion": False,
        },
        "blockingReasons": [
            "round5-consumed-no-retest",
            "round5-segment-rf-position-confounded",
            "round5-performance-only-calibration-candidates-failed",
            "round5-gap-frozen-rules-low-recall-and-nonzero-fp",
            "round5-rhythm-safety-not-position-balanced",
            "round5-waveform-energy-real-domain-transfer-failed",
            "round5-waveform-target-pitch-joint-floor-failed",
        ],
    }


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Round 5 证据重记账",
        "",
        "结论：Round 5 已消费；本报告只重分类，不调阈值、不重训、不复考。",
        "",
        "| 候选 | 观测 | 位置结论 | 可保留结论 |",
        "|---|---:|---|---|",
    ]
    for row in report["accounting"]:
        observed = (
            row.get("observedFreshBlind")
            or row.get("observedCalibrationLoro")
            or row.get("observedAllRound5")
        )
        metric_text = (
            f"TP={observed['truePositive']}, FP={observed['falsePositive']}, "
            f"P={observed['precision']:.2%}, R={observed['recall']:.2%}"
        )
        claim = row.get("validClaim", "")
        lines.append(
            f"| `{row['candidateId']}` | {metric_text} | "
            f"`{row['accountingClass']}` | {claim} |"
        )
    lines.extend([
        "",
        "## 裁决",
        "",
        "- 片段随机森林四个 gate 的原始数字全部失去泛化资格；不是四个都“检测失败”，而是训练或评测位置已混淆。",
        "- gap 自查 `1/12` 与 missing strict `1/6` 是冻结、无位置输入规则的真实漏检；位置混淆不能把它们救回来。",
        "- rhythm soft/strict 的 `4/12` 是可保留的真实灵敏度观测，但 `0/312 FP` 不能作为独立安全结论。",
        "- 固定能量阈值在真实 Round 5 为 `0/12`，判定跨域失败并收线；target-pitch 阈值为 `5/12 @ 49/660 FP`，同样淘汰。",
        "- 排除谱面特征后的 calibration LORO 没有任何候选通过 `90% precision / 50% recall / 0 FP`。",
        "- 严格确诊维持 `2/12`，所有学生开关保持 false。",
        "",
        "机器证据源和 SHA-256 见配套 JSON。",
        "",
    ])
    return "\n".join(lines)


def run(out_json: Path, out_md: Path) -> dict[str, Any]:
    report = build_report()
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(markdown(report), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-json", type=Path, default=OUT_JSON)
    parser.add_argument("--out-md", type=Path, default=OUT_MD)
    args = parser.parse_args()
    report = run(args.out_json, args.out_md)
    print(json.dumps({
        "contract": report["contract"],
        "accountingRows": len(report["accounting"]),
        "invalidatedByPositionConfounding": (
            report["conclusions"]["invalidatedByPositionConfounding"]
        ),
        "genuineDetectionFailures": (
            report["conclusions"]["genuineDetectionFailures"]
        ),
        "positionControlledCandidatePassed": (
            report["conclusions"]["positionControlledCandidatePassed"]
        ),
        "strictConfirmedRecall": report["conclusions"]["strictConfirmedRecall"],
        "outJson": report_path(args.out_json),
        "outMarkdown": report_path(args.out_md),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
