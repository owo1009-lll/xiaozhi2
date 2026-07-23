#!/usr/bin/env python3
"""Freeze the minimum staged P3 recording plan after P0-P2 exhaustion."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
P1_PREREG = (
    REPO
    / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"
)
P1_RESULTS = (
    REPO
    / "docs/evidence/western-strings-p1-clean-domain-safety-20260724.json"
)
P2_AUDIT = (
    REPO
    / "docs/evidence/western-strings-p2-public-error-recall-audit-20260724.json"
)
ROUND6_PROTOCOL = REPO / "config/western-strings-round6-evaluation-protocol.json"
ROUND6_CONTRACT = (
    REPO / "config/western-strings-round6-counterbalanced-contract.json"
)
ROUND6_ROOT = REPO / "data/private/western-strings-round6-counterbalanced"
ROUND6_MANIFEST = ROUND6_ROOT / "manifest.csv"
ROUND6_TRUTH = ROUND6_ROOT / "position-truth.json"
TRUTH_SIGNOFF_GENERATOR = REPO / "scripts/generate-western-round5-truth-signoff-pack.mjs"
TRUTH_SIGNOFF_APPLIER = REPO / "scripts/apply-western-truth-signoff.mjs"
STAGED_SIGNOFF_SUPPORT = (
    REPO / "scripts/western-round6-staged-signoff-support.mjs"
)
STAGE_A_SAFETY_RUNNER = REPO / "scripts/run_western_round6_stage_a_safety.py"
FROZEN_EVALUATION_RUNNER = (
    REPO / "scripts/run_western_round6_frozen_evaluation.py"
)
ROUND6_CANDIDATE_RUNNER = (
    REPO / "scripts/experiments/train_western_round6_full_score_candidate.py"
)
PACKAGE_JSON = REPO / "package.json"
OUT_JSON = (
    REPO
    / "docs/evidence/western-strings-p3-minimal-recording-preregistration-20260724.json"
)
OUT_MD = REPO / "docs/western-strings-p3-minimal-recording-plan.md"
CONTRACT = "western-p3-staged-minimal-recording-protocol-v1"
GATES = ("merged_substitution", "missing", "extra", "drag")
CALIBRATION_SPLIT = "calibration"
FRESH_SPLIT = "fresh-blind"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def semantic_sha(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def report_path(path: Path) -> str:
    return path.resolve().relative_to(REPO.resolve()).as_posix()


def event_rows(
    manifest: list[dict[str, str]],
    truth: dict[str, Any],
) -> list[dict[str, str]]:
    split_by_id = {row["recordingId"]: row["split"] for row in manifest}
    rows: list[dict[str, str]] = []
    recordings = truth.get("recordings")
    if not isinstance(recordings, dict):
        raise RuntimeError("p3-round6-truth-recordings-invalid")
    if set(recordings) != set(split_by_id):
        raise RuntimeError("p3-round6-manifest-truth-identity-mismatch")
    for recording_id, record in recordings.items():
        events = record.get("events")
        if not isinstance(events, list):
            raise RuntimeError(f"p3-round6-events-invalid:{recording_id}")
        for event in events:
            rows.append({
                "recordingId": recording_id,
                "split": split_by_id[recording_id],
                "gate": str(event.get("gate") or ""),
                "label": str(event.get("label") or ""),
                "eventId": str(event.get("eventId") or ""),
            })
    return rows


def split_profile(
    split: str,
    manifest: list[dict[str, str]],
    events: list[dict[str, str]],
) -> dict[str, Any]:
    rows = [row for row in manifest if row["split"] == split]
    split_events = [row for row in events if row["split"] == split]
    pieces = sorted({row["pieceId"] for row in rows})
    performers = sorted({row["performerId"] for row in rows})
    devices = sorted({row["deviceId"] for row in rows})
    rooms = sorted({row["roomId"] for row in rows})
    recordings_per_piece = {
        piece: sum(row["pieceId"] == piece for row in rows)
        for piece in pieces
    }
    by_gate = {}
    for gate in GATES:
        gate_events = [row for row in split_events if row["gate"] == gate]
        by_gate[gate] = {
            "positive": sum(row["label"] == "positive" for row in gate_events),
            "confusionNegative": sum(
                row["label"] == "confusion_negative"
                for row in gate_events
            ),
        }
    profile = {
        "recordingIds": sorted(row["recordingId"] for row in rows),
        "recordingCount": len(rows),
        "pieceIds": pieces,
        "performerIds": performers,
        "deviceIds": devices,
        "roomIds": rooms,
        "recordingsPerPiece": recordings_per_piece,
        "eventCount": len(split_events),
        "byGate": by_gate,
    }
    if profile["recordingCount"] != 6:
        raise RuntimeError(f"p3-{split}-recording-count-drift")
    if len(pieces) != 2 or any(count != 3 for count in recordings_per_piece.values()):
        raise RuntimeError(f"p3-{split}-counterbalance-triplet-drift")
    if any(
        counts != {"positive": 6, "confusionNegative": 12}
        for counts in by_gate.values()
    ):
        raise RuntimeError(f"p3-{split}-gate-count-drift:{by_gate}")
    return profile


def build_report() -> dict[str, Any]:
    p1_prereg = read_json(P1_PREREG)
    p1_results = read_json(P1_RESULTS)
    p2 = read_json(P2_AUDIT)
    evaluation = read_json(ROUND6_PROTOCOL)
    round6_contract = read_json(ROUND6_CONTRACT)
    manifest = read_csv(ROUND6_MANIFEST)
    truth = read_json(ROUND6_TRUTH)

    if p1_prereg.get("protocolSemanticSha256") != (
        "efe62f7b1dac036336647918f04c158be9f0d3113a6de8b637106cf42cef62f6"
    ):
        raise RuntimeError("p3-p1-preregistration-sha-drift")
    eliminated = p1_results["conclusions"]["eliminatedCandidateIds"]
    retained = p1_results["conclusions"]["retainedCandidateIds"]
    if len(eliminated) != 7 or retained:
        raise RuntimeError("p3-p1-result-drift")
    deferred = {
        row["candidate"]: row
        for row in p1_prereg["excludedOrDeferred"]
    }.get("performance-only-RF-v2")
    if deferred is None or deferred.get("status") != "deferred-not-executable-in-P1":
        raise RuntimeError("p3-performance-only-rf-deferral-drift")
    if p2["profile"]["adjudicatedRealErrorPositiveCount"] != 0:
        raise RuntimeError("p3-p2-error-positive-count-drift")
    if p2["decision"]["realErrorRecallMetricDerivable"] is not False:
        raise RuntimeError("p3-p2-recall-derivability-drift")
    if evaluation.get("contractVersion") != (
        "western-round6-frozen-evaluation-protocol-v1"
    ):
        raise RuntimeError("p3-round6-evaluation-contract-drift")
    if evaluation.get("status") != "pre-registered-before-audio":
        raise RuntimeError("p3-round6-evaluation-status-drift")
    if round6_contract.get("contractVersion") != (
        "western-round6-counterbalanced-diagnosis-v1"
    ):
        raise RuntimeError("p3-round6-contract-drift")

    events = event_rows(manifest, truth)
    calibration = split_profile(CALIBRATION_SPLIT, manifest, events)
    fresh = split_profile(FRESH_SPLIT, manifest, events)
    if set(calibration["pieceIds"]) & set(fresh["pieceIds"]):
        raise RuntimeError("p3-round6-piece-split-overlap")
    if set(calibration["performerIds"]) & set(fresh["performerIds"]):
        raise RuntimeError("p3-round6-performer-split-overlap")

    clean_limits = {
        key: int(value)
        if isinstance(value, float) and value.is_integer()
        else value
        for key, value in p1_prereg[
            "eliminationRules"
        ]["automatic_issue_candidate"].items()
    }
    frozen_evaluation = evaluation["evaluation"]
    candidate = evaluation["candidate"]
    protocol_core = {
        "contract": CONTRACT,
        "decisionDate": "2026-07-24",
        "trigger": {
            "p1RunnableCandidatesEliminated": len(eliminated),
            "p1RunnableCandidatesRetained": len(retained),
            "p2AdjudicatedRealErrorPositives": (
                p2["profile"]["adjudicatedRealErrorPositiveCount"]
            ),
            "remainingCandidate": "performance-only-RF-v2",
            "remainingCandidateRequiresNewCounterbalancedCalibration": True,
        },
        "recordingDecision": {
            "minimumUnavoidableNewRecordingsNow": calibration["recordingCount"],
            "conditionalAdditionalFreshRecordings": fresh["recordingCount"],
            "maximumTotalIfStageAPasses": (
                calibration["recordingCount"] + fresh["recordingCount"]
            ),
            "recordAllTwelveNow": False,
            "recordingReductionIfStageAFails": fresh["recordingCount"],
            "whyNotZero": (
                "The only unevaluated pre-registered audio candidate cannot be "
                "fitted without counterbalanced real calibration errors."
            ),
            "whyNotTwelveNow": (
                "A calibration-fitted candidate can first be eliminated on the "
                "already-frozen real clean domains without exposing or recording "
                "the fresh split."
            ),
        },
        "stageA": {
            "name": "counterbalanced-calibration-plus-existing-clean-safety",
            "recordingIds": calibration["recordingIds"],
            "recordingCount": calibration["recordingCount"],
            "profile": calibration,
            "candidate": {
                "sourceContract": candidate["sourceContract"],
                "modelFamily": candidate["modelFamily"],
                "featurePolicy": candidate["featurePolicy"],
                "excludedScoreContextFeatures": (
                    candidate["excludedScoreContextFeatures"]
                ),
                "excludedFixedAcousticFeatures": (
                    candidate["excludedFixedAcousticFeatures"]
                ),
                "requiredTemporalFeatures": candidate["requiredTemporalFeatures"],
                "modelParams": candidate["modelParams"],
                "decisionThreshold": frozen_evaluation["decisionThreshold"],
            },
            "cleanSafetyInputsRemainFrozen": True,
            "cleanSafetyLimits": clean_limits,
            "round5Role": (
                "known-negative consumed diagnostic only; never acceptance"
            ),
            "syntheticRecallMayRepresentRealRecall": False,
            "operations": {
                "truthSignoffPackCommand": (
                    "npm run western:round6-stage-a-truth-signoff-pack"
                ),
                "truthSignoffApplyCommand": (
                    "npm run western:round6-stage-a-truth-signoff-apply -- "
                    "--completed <path> --apply"
                ),
                "positionBalanceCommand": (
                    "npm run western:round6-position-balance"
                ),
                "safetyPreflightCommand": (
                    "npm run western:round6-stage-a-safety-preflight"
                ),
                "safetyEvaluationCommand": (
                    "npm run western:round6-stage-a-safety-eval"
                ),
                "safetyEvaluatorContract": (
                    "western-round6-stage-a-clean-safety-v1"
                ),
                "safetyEvaluatorPath": report_path(STAGE_A_SAFETY_RUNNER),
                "signoffLineagePath": (
                    "data/experiments/"
                    "western-strings-round6-stage-a-signoff/ledger.json"
                ),
                "safetyConsumedLedgerPath": (
                    "data/experiments/"
                    "western-strings-round6-stage-a-safety/consumed-ledger.json"
                ),
                "safetyReportPath": (
                    "data/experiments/"
                    "western-strings-round6-stage-a-safety/report.json"
                ),
                "modelPath": (
                    "data/experiments/"
                    "western-strings-round6-stage-a-safety/model.joblib"
                ),
                "freshAudioMustBeAbsent": True,
                "cleanSafetyMayBeConsumedOnce": True,
            },
            "passAction": (
                "Freeze the fitted model and complete Stage B without changing "
                "features, model parameters, decision threshold, or safety limits."
            ),
            "failAction": (
                "Stop with strict confirmed recall 2/12; do not record the six "
                "fresh takes for this candidate."
            ),
        },
        "stageB": {
            "name": "conditional-untouched-fresh-evaluation",
            "authorizedOnlyAfterStageAPass": True,
            "recordingIds": fresh["recordingIds"],
            "recordingCount": fresh["recordingCount"],
            "profile": fresh,
            "freshBlindRunLimit": frozen_evaluation["freshBlindRunLimit"],
            "freshUsedForSelection": frozen_evaluation["freshUsedForSelection"],
            "promotionThresholds": frozen_evaluation["promotionThresholds"],
            "promotionScope": frozen_evaluation["promotionScope"],
            "completeInventoryRequired": (
                frozen_evaluation["completeInventoryRequired"]
            ),
            "scorePositionCounterbalanceRequired": (
                frozen_evaluation["scorePositionCounterbalanceRequired"]
            ),
            "strictFalseAccusationDenominator": (
                candidate["strictFalseAccusationDenominator"]
            ),
            "postFreshRetuningAllowed": candidate["postFreshRetuningAllowed"],
            "trainingDuringFreshAllowed": False,
            "frozenStageAModelReuseRequired": True,
            "operations": {
                "truthSignoffPackCommand": (
                    "npm run western:round6-stage-b-truth-signoff-pack"
                ),
                "truthSignoffApplyCommand": (
                    "npm run western:round6-stage-b-truth-signoff-apply -- "
                    "--completed <path> --apply"
                ),
                "signoffLineagePath": (
                    "data/experiments/"
                    "western-strings-round6-stage-b-signoff/ledger.json"
                ),
                "frozenModelPath": (
                    "data/experiments/"
                    "western-strings-round6-stage-a-safety/model.joblib"
                ),
                "evaluationCommand": "npm run western:round6-frozen-eval",
                "evaluationRunnerPath": report_path(
                    FROZEN_EVALUATION_RUNNER
                ),
                "freshAudioMayBeReadOnce": True,
                "calibrationMayBeResigned": False,
                "candidateMayBeRefit": False,
            },
            "numericPassIsReleaseAuthorization": False,
        },
        "discipline": {
            "round4Round5ReusedAsAcceptance": False,
            "freshReadDuringStageA": False,
            "retuneAfterCleanSafety": False,
            "retuneAfterFresh": False,
            "round6UnscopedTruthSignoffAllowed": False,
            "studentSwitchesRemainFalse": True,
            "failClosed": True,
        },
        "stopLines": {
            "m4Omr": "no-further-investment",
            "waveformEnergyMissingNote": "no-further-investment",
        },
        "supersession": {
            "priorAllAtOnceRound6Scheduling": "deferred",
            "technicalTwelveTakePackRemainsValid": True,
            "currentAuthorizedRecordingScope": "stage-a-calibration-six-only",
        },
    }
    source_paths = (
        P1_PREREG,
        P1_RESULTS,
        P2_AUDIT,
        ROUND6_PROTOCOL,
        ROUND6_CONTRACT,
        ROUND6_MANIFEST,
        ROUND6_TRUTH,
        TRUTH_SIGNOFF_GENERATOR,
        TRUTH_SIGNOFF_APPLIER,
        STAGE_A_SAFETY_RUNNER,
        STAGED_SIGNOFF_SUPPORT,
        ROUND6_CANDIDATE_RUNNER,
        PACKAGE_JSON,
    )
    return {
        "schemaVersion": 1,
        **protocol_core,
        "sourceBindings": [
            {"path": report_path(path), "sha256": sha256(path)}
            for path in source_paths
        ],
        "protocolSemanticSha256": semantic_sha(protocol_core),
    }


def markdown(report: dict[str, Any]) -> str:
    decision = report["recordingDecision"]
    stage_a = report["stageA"]
    stage_b = report["stageB"]
    limits = stage_a["cleanSafetyLimits"]
    model = stage_a["candidate"]
    operations = stage_a["operations"]
    stage_b_operations = stage_b["operations"]
    lines = [
        "# P3 最小录音分阶段协议",
        "",
        "结论：现在非录不可的是 **6 条 calibration**，不是 0，也不是一次录满 12。"
        "只有这 6 条训练出的冻结候选先通过既有真实干净域安全闸，才追加 6 条 untouched fresh。",
        "",
        f"- 当前不可避免：`{decision['minimumUnavoidableNewRecordingsNow']}` 条。",
        f"- 条件追加：`{decision['conditionalAdditionalFreshRecordings']}` 条。",
        f"- 最坏总量：`{decision['maximumTotalIfStageAPasses']}` 条。",
        f"- Stage A 失败可避免：`{decision['recordingReductionIfStageAFails']}` 条 fresh。",
        f"- 协议语义 SHA-256：`{report['protocolSemanticSha256']}`。",
        "",
        "## 为什么必须先录 6 条",
        "",
        "P1 的 7 个可直接运行候选全部因真实干净域过度标注而淘汰；"
        "唯一尚未执行的 `performance-only-RF-v2` 明确需要新的反平衡 calibration 才能拟合。"
        "P2 检查的 5,326 个公开参考音符事件没有任何经裁定错误正例，也没有同声部正确/错误演奏对，不能代替 calibration。",
        "",
        "## Stage A：只录 calibration 6 条",
        "",
        f"录音 ID：`{'`, `'.join(stage_a['recordingIds'])}`。",
        "",
        "两份 calibration 新谱各录三次；同一位置在三次中轮换为 1 次正例、2 次混淆负例。"
        "每个 gate 合计 6 个正例和 12 个混淆负例。",
        "",
        "冻结候选：",
        "",
        f"- 模型：`{model['modelFamily']}`；决策点 `{model['decisionThreshold']}`。",
        f"- RF：`{json.dumps(model['modelParams'], ensure_ascii=False, sort_keys=True)}`。",
        f"- 禁止谱面位置特征：`{', '.join(model['excludedScoreContextFeatures'])}`。",
        f"- 禁止固定声学堆叠：`{', '.join(model['excludedFixedAcousticFeatures'])}`。",
        f"- 必须时序特征：`{', '.join(model['requiredTemporalFeatures'])}`。",
        "",
        "训练后先跑既有 P1 干净域，自动指控候选必须同时满足：",
        "",
        f"- 本地权威 clean：FP `≤{limits['authoritativeLocalCleanFalsePositiveMax']}`。",
        f"- Round 5 已消费普通位置：FP `≤{limits['consumedRound5KnownNegativeFalsePositiveMax']}`，只作诊断。",
        f"- 公开专业演奏：合并负担 `≤{limits['publicProfessionalBurdenPooledPer1000Max']}/1000`，"
        f"任一录音 `≤{limits['publicProfessionalBurdenAnyRecordingPer1000Max']}/1000`。",
        "",
        "任一超限立即淘汰并收线，不录 fresh。",
        "",
        "Stage A 固定执行链：",
        "",
        f"1. `{operations['truthSignoffPackCommand']}` 只读取 6 条 calibration；fresh 音频必须不存在。",
        f"2. 下载签署 JSON 后先 dry-run `{operations['truthSignoffApplyCommand'].replace(' --apply', '')}`，"
        "确认 `readyToApply=true` 后再加 `--apply`。",
        f"3. 依次运行 `{operations['positionBalanceCommand']}` 和 "
        f"`{operations['safetyPreflightCommand']}`。",
        f"4. 只执行一次 `{operations['safetyEvaluationCommand']}`；"
        "consumed ledger 在读取 clean 安全结果前写入，崩溃也不得重跑。",
        "",
        "## Stage B：仅在 Stage A 通过后补 fresh 6 条",
        "",
        f"录音 ID：`{'`, `'.join(stage_b['recordingIds'])}`。",
        "",
        "模型、特征、决策点和门槛全部保持冻结；fresh 只读一次。"
        "每个 gate 的门槛仍为 P≥90%、R≥50%、strict FP=0，"
        "任一数值通过也不自动取得学生端发布授权。",
        "",
        "Stage B 固定执行链：",
        "",
        f"1. `{stage_b_operations['truthSignoffPackCommand']}` 先验证 Stage A "
        "通过报告、consumed ledger 和冻结模型 SHA，再只读取 6 条 fresh。",
        f"2. 下载签署 JSON 后先 dry-run "
        f"`{stage_b_operations['truthSignoffApplyCommand'].replace(' --apply', '')}`，"
        "确认 calibration 投影完全不变后再加 `--apply`。",
        f"3. 只执行一次 `{stage_b_operations['evaluationCommand']}`；"
        "执行器只能加载 Stage A 模型，`trainingPerformed` 必须为 false，"
        "`frozenModelLoaded` 必须为 true。",
        "",
        "## 不变的红线",
        "",
        "- Round 4/5 不复用作验收。",
        "- Stage A 不读取 fresh；Stage B 看过结果后不回调、不重测。",
        "- Round 6 不允许无作用域一次性签满 12 条，也不允许重新签署 calibration。",
        "- 合成召回不代表真实召回。",
        "- M4 OMR 与能量验漏音继续收线。",
        "- 学生三个开关保持 false，系统 fail-closed。",
        "",
        "机器可核验来源与 SHA-256 见配套 JSON。",
        "",
    ]
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
        "protocolSemanticSha256": report["protocolSemanticSha256"],
        "minimumUnavoidableNewRecordingsNow": (
            report["recordingDecision"]["minimumUnavoidableNewRecordingsNow"]
        ),
        "conditionalAdditionalFreshRecordings": (
            report["recordingDecision"]["conditionalAdditionalFreshRecordings"]
        ),
        "recordAllTwelveNow": report["recordingDecision"]["recordAllTwelveNow"],
        "outJson": report_path(args.out_json),
        "outMarkdown": report_path(args.out_md),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
