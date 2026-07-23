#!/usr/bin/env python3
"""Build the canonical stakeholder report artifact for the P0-P3 decision."""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
P0 = (
    REPO
    / "docs/evidence/western-strings-round5-evidence-accounting-20260724.json"
)
P1_PREREG = (
    REPO
    / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"
)
P1_RESULTS = (
    REPO
    / "docs/evidence/western-strings-p1-clean-domain-safety-20260724.json"
)
P2 = (
    REPO
    / "docs/evidence/western-strings-p2-public-error-recall-audit-20260724.json"
)
P3 = (
    REPO
    / "docs/evidence/western-strings-p3-minimal-recording-preregistration-20260724.json"
)
OUT_ARTIFACT = (
    REPO
    / "docs/evidence/western-strings-zero-recording-stakeholder-report-20260724.artifact.json"
)
TITLE = "少录音优先决策"
GENERATED_AT = "2026-07-24T00:00:00+08:00"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def report_path(path: Path) -> str:
    return path.resolve().relative_to(REPO.resolve()).as_posix()


def fmt(value: float | int | None, digits: int = 2) -> str:
    if value is None:
        return "不适用"
    return f"{float(value):.{digits}f}"


def pct(value: float | int | None, digits: int = 2) -> str:
    if value is None:
        return "不适用"
    return f"{float(value) * 100:.{digits}f}%"


def get_domain(
    candidate: dict[str, Any],
    domain_id: str,
) -> dict[str, Any] | None:
    domain = candidate.get("domains", {}).get(domain_id)
    return domain if isinstance(domain, dict) else None


def dp_grid(thresholds: dict[str, Any]) -> str:
    by_gate = thresholds.get("temporalParamsByGate")
    if not isinstance(by_gate, dict):
        temporal = thresholds.get("temporalParams")
        if isinstance(temporal, dict):
            return (
                "extra DP: "
                f"conf={temporal['minConfidence']}, pitch={temporal['pitchWeight']}, "
                f"del={temporal['deletePenalty']}, ins={temporal['insertPenalty']}, "
                f"merge={temporal['mergePenalty']}, dur={temporal['durationWeight']}, "
                f"reattack={temporal['reattackRatio']}, "
                f"dragDur={temporal['dragDurationRatio']}, "
                f"dragIOI={temporal['dragIoiRatio']}"
            )
        return ""
    labels = (
        ("merged_substitution", "M"),
        ("missing", "N"),
        ("extra", "E"),
        ("drag", "D"),
    )
    fields = (
        ("minConfidence", "conf"),
        ("pitchWeight", "pitch"),
        ("deletePenalty", "del"),
        ("insertPenalty", "ins"),
        ("mergePenalty", "merge"),
        ("durationWeight", "dur"),
        ("reattackRatio", "reattack"),
        ("dragDurationRatio", "dragDur"),
        ("dragIoiRatio", "dragIOI"),
    )
    chunks = []
    for field, label in fields:
        values = "/".join(str(by_gate[gate][field]) for gate, _ in labels)
        chunks.append(f"{label}[M/N/E/D]={values}")
    return "; ".join(chunks)


def threshold_summary(candidate: dict[str, Any]) -> str:
    thresholds = candidate["thresholds"]
    candidate_id = candidate["candidateId"]
    grid = dp_grid(thresholds)
    if candidate_id == "alignment-gap-refined-self-check-v1":
        return f"{grid}; rule=gap AND same-position substitution/deletion-in-gap-run"
    if candidate_id == "alignment-gap-strict-missing-v1":
        return (
            f"{grid}; missing only; maxGapCount="
            f"{thresholds['maxAssignmentGapCount']}; maxGapRate="
            f"{thresholds['maxAssignmentGapRate']}"
        )
    if candidate_id == "relative-ioi-duration-review-v1":
        return (
            f"{grid}; relIOI>{thresholds['relativeIoiDeviationGreaterThan']}; "
            f"duration≥{thresholds['eventDurationRatioAtLeast']}; "
            f"confidence≥{thresholds['eventConfidenceAtLeast']}"
        )
    if candidate_id == "relative-ioi-duration-strict-v1":
        return (
            f"{grid}; relIOI>{thresholds['relativeIoiDeviationGreaterThan']}; "
            f"duration≥{thresholds['eventDurationRatioAtLeast']}; "
            f"confidence≥{thresholds['eventConfidenceAtLeast']}"
        )
    if candidate_id == "pitch-trajectory-center-strict-v1":
        return (
            f"pitchTolerance={thresholds['pitchToleranceCents']}c; "
            f"spreadP95-P05≤{thresholds['maxSpreadCentsP95P05']}c; "
            f"IQR≤{thresholds['maxIqrCents']}c; "
            f"frames≥{thresholds['minTotalFrameCount']}; "
            f"voicedFrames≥{thresholds['minVoicedFrameCount']}; "
            f"voicedRatio≥{thresholds['minVoicedFrameRatio']}; "
            f"glissTail={thresholds['glissandoTargetTailFraction']}"
        )
    if candidate_id == "onset-density-extra-strict-v1":
        return (
            f"{grid}; interiorAttack≥{thresholds['interiorAttackRatioAtLeast']}; "
            f"startMargin={thresholds['interiorStartMargin']}; "
            f"endMargin={thresholds['interiorEndMargin']}"
        )
    if candidate_id == "temporal-operation-sequence-union-v1":
        return f"{grid}; union=match/insert/delete/merge/split"
    raise RuntimeError(f"unknown-p1-candidate:{candidate_id}")


def candidate_rows(
    prereg: dict[str, Any],
    results: dict[str, Any],
) -> list[dict[str, Any]]:
    result_by_id = {
        row["candidateId"]: row
        for row in results["candidateResults"]
    }
    labels = {
        "alignment-gap-refined-self-check-v1": "Gap 复核",
        "alignment-gap-strict-missing-v1": "Gap 严格漏音",
        "relative-ioi-duration-review-v1": "IOI/时值复核",
        "relative-ioi-duration-strict-v1": "IOI/时值严格",
        "pitch-trajectory-center-strict-v1": "音高轨迹严格",
        "onset-density-extra-strict-v1": "起音密度严格",
        "temporal-operation-sequence-union-v1": "时序操作并集",
    }
    rows = []
    for order, frozen in enumerate(prereg["candidates"], 1):
        result = result_by_id[frozen["candidateId"]]
        local = get_domain(result, "authoritative-local-clean")
        round5 = get_domain(result, "consumed-round5-known-negatives")
        public = get_domain(result, "public-professional-burden")
        rows.append({
            "order": order,
            "candidateId": frozen["candidateId"],
            "candidateLabel": labels[frozen["candidateId"]],
            "family": frozen["family"],
            "role": (
                "自动指控"
                if frozen["outputSemantic"] == "automatic_issue_candidate"
                else "复核提示"
            ),
            "thresholdSummary": threshold_summary(frozen),
            "thresholdsJson": json.dumps(
                frozen["thresholds"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
            "safetyLimitsBreached": len(result["eliminationReasons"]),
            "eliminationReasons": "；".join(result["eliminationReasons"]),
            "retained": "否",
            "localFlags": local.get("flagCount") if local else None,
            "localPositions": local.get("positionCount") if local else None,
            "localPer1000": local.get("flagsPer1000Positions") if local else None,
            "localMaxRate": local.get("maximumPerRecordingRate") if local else None,
            "round5Flags": round5.get("flagCount") if round5 else None,
            "round5Positions": round5.get("positionCount") if round5 else None,
            "round5Per1000": (
                round5.get("flagsPer1000Positions") if round5 else None
            ),
            "round5MaxRate": (
                round5.get("maximumPerRecordingRate") if round5 else None
            ),
            "publicFlags": public.get("flagCount") if public else None,
            "publicPositions": public.get("positionCount") if public else None,
            "publicPer1000": (
                public.get("flagsPer1000Positions") if public else None
            ),
            "publicMaxRate": (
                public.get("maximumPerRecordingRate") if public else None
            ),
            "localEvidence": (
                "不适用"
                if local is None
                else (
                    f"{local['flagCount']}/{local['positionCount']}="
                    f"{local['flagsPer1000Positions']:.2f}/1000；"
                    f"单条最高 {local['maximumPerRecordingRate']:.2%}"
                )
            ),
            "round5Evidence": (
                "不适用"
                if round5 is None
                else (
                    f"{round5['flagCount']}/{round5['positionCount']}="
                    f"{round5['flagsPer1000Positions']:.2f}/1000；"
                    f"单条最高 {round5['maximumPerRecordingRate']:.2%}"
                )
            ),
            "publicEvidence": (
                "不适用"
                if public is None
                else (
                    f"{public['flagCount']}/{public['positionCount']}="
                    f"{public['flagsPer1000Positions']:.2f}/1000；"
                    f"单条最高 {public['maximumPerRecordingRate']:.2%}"
                )
            ),
        })
    return rows


def round5_rows(p0: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = {row["candidateId"]: row for row in p0["accounting"]}
    return [
        {
            "order": 1,
            "evidence": "4 个片段 RF gate",
            "observed": "原始数字可复现",
            "classification": "位置混淆作废",
            "claim": "不能把原始 P/R 当作检测器泛化能力。",
        },
        {
            "order": 2,
            "evidence": "Gap 自查",
            "observed": (
                f"{by_id['gap-refinement-self-check']['observedFreshBlind']['truePositive']}"
                "/12 @ "
                f"{by_id['gap-refinement-self-check']['observedFreshBlind']['falsePositive']}"
                " FP"
            ),
            "classification": "真实检测失败",
            "claim": "规则不读位置；11 个漏检不能由位置混淆洗掉。",
        },
        {
            "order": 3,
            "evidence": "Gap 严格漏音",
            "observed": (
                f"{by_id['gap-strict-missing']['observedFreshBlind']['truePositive']}"
                "/6 @ "
                f"{by_id['gap-strict-missing']['observedFreshBlind']['falsePositive']}"
                " FP"
            ),
            "classification": "真实检测失败",
            "claim": "规则不读位置；召回 16.67% 是固定样本上的真实漏检。",
        },
        {
            "order": 4,
            "evidence": "节奏 soft/strict",
            "observed": "4/12 @ 包内 0 FP",
            "classification": "只保留灵敏度观察",
            "claim": "4 个命中有效；0 FP 因目标位置可由谱面识别，不能证明安全。",
        },
        {
            "order": 5,
            "evidence": "波形能量验漏音",
            "observed": (
                f"{by_id['waveform-energy-absence']['observedAllRound5']['truePositive']}"
                "/12 @ 0/660 FP"
            ),
            "classification": "真实跨域失败",
            "claim": "冻结合成阈值在真实域召回为 0，维持收线。",
        },
        {
            "order": 6,
            "evidence": "目标音高缺失",
            "observed": (
                f"{by_id['waveform-target-pitch-absence']['observedAllRound5']['truePositive']}"
                "/12 @ "
                f"{by_id['waveform-target-pitch-absence']['observedAllRound5']['falsePositive']}"
                "/660 FP"
            ),
            "classification": "真实精度与召回失败",
            "claim": "P=9.26%、R=41.67%，不是位置模型造成。",
        },
    ]


def public_rows(p2: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for order, dataset in enumerate(p2["datasets"], 1):
        notes = dataset.get(
            "uniqueAlignedReferenceNotes",
            dataset.get("uniqueInstrumentLabelledReferenceNotes", 0),
        )
        rows.append({
            "order": order,
            "dataset": dataset["datasetId"],
            "referenceNotes": notes,
            "samePartPairs": dataset["pairingAudit"][
                "samePartRepeatedPerformancePairs"
            ],
            "adjudicatedErrorPositives": dataset[
                "adjudicatedRealErrorPositives"
            ],
            "recallDerivable": "否",
            "reason": dataset["pairingAudit"]["reason"],
        })
    return rows


def recording_rows(p3: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "order": 1,
            "stage": "Stage A：现在录",
            "recordings": p3["stageA"]["recordingCount"],
            "purpose": "反平衡 calibration + 既有 clean 安全淘汰",
            "condition": "现在必要",
            "outcome": "任一安全上限超限即收线，不录 fresh",
        },
        {
            "order": 2,
            "stage": "Stage B：条件追加",
            "recordings": p3["stageB"]["recordingCount"],
            "purpose": "冻结模型的一次性 untouched fresh 召回/精度评测",
            "condition": "仅 Stage A 全部通过",
            "outcome": "P≥90%、R≥50%、strict FP=0；通过也不自动发布",
        },
    ]


def sources() -> list[dict[str, Any]]:
    source_rows = (
        ("p0-accounting", "Round 5 证据重记账", P0),
        ("p1-prereg", "P1 候选预注册与冻结门槛", P1_PREREG),
        ("p1-results", "P1 真实干净域安全筛选", P1_RESULTS),
        ("p2-audit", "P2 公开数据召回可派生性审计", P2),
        ("p3-protocol", "P3 最小录音分阶段协议", P3),
    )
    return [
        {
            "id": source_id,
            "label": label,
            "path": report_path(path),
            "query": {
                "description": "读取已提交、SHA 绑定的项目证据 JSON。",
                "engine": "python-local",
                "language": "python",
                "sql": (
                    "import json\n"
                    "from pathlib import Path\n"
                    f"data = json.loads(Path({report_path(path)!r})."
                    "read_text(encoding='utf-8'))"
                ),
                "tables_used": [report_path(path)],
                "metric_definitions": [
                    f"文件 SHA-256={sha256(path)}",
                ],
            },
        }
        for source_id, label, path in source_rows
    ]


def materialize_dataset(
    dataset: str,
    rows: list[dict[str, Any]],
    sql: str,
) -> list[dict[str, Any]]:
    if not rows:
        raise RuntimeError(f"empty-report-dataset:{dataset}")
    columns = list(rows[0])
    if any(list(row) != columns for row in rows):
        raise RuntimeError(f"inconsistent-report-dataset-columns:{dataset}")
    quoted_columns = ", ".join(f'"{column}"' for column in columns)
    placeholders = ", ".join("?" for _ in columns)
    with sqlite3.connect(":memory:") as connection:
        connection.execute(
            f'CREATE TABLE "{dataset}" ({quoted_columns})'
        )
        connection.executemany(
            f'INSERT INTO "{dataset}" ({quoted_columns}) VALUES ({placeholders})',
            [[row[column] for column in columns] for row in rows],
        )
        connection.row_factory = sqlite3.Row
        result = connection.execute(sql).fetchall()
    return [dict(row) for row in result]


def derived_source(
    dataset: str,
    sql: str,
    label: str,
    metric_definitions: list[str],
) -> dict[str, Any]:
    return {
        "id": f"stakeholder-report-{dataset}",
        "label": label,
        "path": "scripts/experiments/build_western_zero_recording_stakeholder_report.py",
        "query": {
            "description": (
                "从 P0-P3 已审阅 JSON 确定性生成内存 SQLite 表，"
                "再执行本查询产生最终报告快照；不重新训练、不改阈值。"
            ),
            "engine": "sqlite-in-memory",
            "language": "sql",
            "sql": sql,
            "tables_used": [dataset],
            "filters": [
                "仅使用 2026-07-24 已冻结证据",
                "Round 4/5 不作验收",
                "不把合成召回当真实召回",
            ],
            "metric_definitions": metric_definitions,
        },
    }


def build_artifact() -> dict[str, Any]:
    p0 = read_json(P0)
    prereg = read_json(P1_PREREG)
    results = read_json(P1_RESULTS)
    p2 = read_json(P2)
    p3 = read_json(P3)

    if p0["conclusions"]["strictConfirmedRecall"] != "2/12":
        raise RuntimeError("stakeholder-p0-strict-recall-drift")
    if prereg["protocolSemanticSha256"] != (
        "efe62f7b1dac036336647918f04c158be9f0d3113a6de8b637106cf42cef62f6"
    ):
        raise RuntimeError("stakeholder-p1-protocol-sha-drift")
    if len(results["conclusions"]["eliminatedCandidateIds"]) != 7:
        raise RuntimeError("stakeholder-p1-elimination-count-drift")
    if results["conclusions"]["retainedCandidateIds"]:
        raise RuntimeError("stakeholder-p1-retained-candidate-drift")
    if p2["profile"]["adjudicatedRealErrorPositiveCount"] != 0:
        raise RuntimeError("stakeholder-p2-positive-count-drift")
    if p3["recordingDecision"]["minimumUnavoidableNewRecordingsNow"] != 6:
        raise RuntimeError("stakeholder-p3-minimum-recording-drift")
    if p3["recordingDecision"]["recordAllTwelveNow"] is not False:
        raise RuntimeError("stakeholder-p3-staging-drift")

    candidate_sql = 'SELECT * FROM "candidate_outcomes" ORDER BY "order" ASC'
    p0_sql = 'SELECT * FROM "round5_accounting" ORDER BY "order" ASC'
    p2_sql = (
        'SELECT * FROM "public_recall" '
        'ORDER BY "referenceNotes" DESC, "order" ASC'
    )
    p3_sql = 'SELECT * FROM "recording_stages" ORDER BY "order" ASC'
    candidates = materialize_dataset(
        "candidate_outcomes",
        candidate_rows(prereg, results),
        candidate_sql,
    )
    p0_rows = materialize_dataset(
        "round5_accounting",
        round5_rows(p0),
        p0_sql,
    )
    p2_rows = materialize_dataset(
        "public_recall",
        public_rows(p2),
        p2_sql,
    )
    p3_rows = materialize_dataset(
        "recording_stages",
        recording_rows(p3),
        p3_sql,
    )
    threshold_markdown = "\n".join(
        f"- **{row['candidateLabel']}**（{row['role']}）："
        f"{row['thresholdSummary']}"
        for row in candidates
    )
    candidate_result_markdown = "\n".join(
        f"- **{row['candidateLabel']}**：本地 `{row['localEvidence']}`；"
        f"Round 5 `{row['round5Evidence']}`；公开专业 `{row['publicEvidence']}`；"
        f"淘汰原因：{row['eliminationReasons']}。"
        for row in candidates
    )
    candidate_source = derived_source(
        "candidate_outcomes",
        candidate_sql,
        "P1 候选阈值与安全淘汰汇总",
        [
            "违反安全上限数=候选 eliminationReasons 的预注册上限条目数。",
            "公开专业 flags 是负担而非权威假阳。",
        ],
    )
    p0_source = derived_source(
        "round5_accounting",
        p0_sql,
        "Round 5 证据分类汇总",
        ["观测值按位置混淆、真实失败或灵敏度观察重新分类。"],
    )
    p2_source = derived_source(
        "public_recall",
        p2_sql,
        "P2 公开数据召回可派生性汇总",
        ["错误正例必须有独立人工裁定；对齐残差不计错误正例。"],
    )
    p3_source = derived_source(
        "recording_stages",
        p3_sql,
        "P3 最小分阶段录音汇总",
        [
            "当前最小录音量=Stage A calibration 录音数。",
            "Stage B 仅在 Stage A 全部安全上限通过后计入条件追加量。",
        ],
    )
    all_sources = [
        *sources(),
        candidate_source,
        p0_source,
        p2_source,
        p3_source,
    ]
    automatic_limits = prereg["eliminationRules"]["automatic_issue_candidate"]
    review_limits = prereg["eliminationRules"]["review_hint"]
    p3_sha = p3["protocolSemanticSha256"]
    artifact = {
        "surface": "report",
        "manifest": {
            "version": 1,
            "surface": "report",
            "title": TITLE,
            "description": (
                "P0-P3 零录音优先审计、候选安全淘汰和最小分阶段录音决策。"
            ),
            "generatedAt": GENERATED_AT,
            "sources": all_sources,
            "blocks": [
                {
                    "id": "title",
                    "type": "markdown",
                    "body": f"# {TITLE}",
                },
                {
                    "id": "executive-summary",
                    "type": "markdown",
                    "body": (
                        "## Executive Summary\n\n"
                        "- **Round 5 的原始片段 RF 数字因位置混淆作废，"
                        "但 gap 与波形路线的低召回是真失败。** 严格确诊保持 `2/12`。\n"
                        "- **P1 冻结的 7 个可直接运行候选全部在真实干净域安全闸淘汰，"
                        "0 个进入召回审计。** 没有在看结果后放宽任何门槛。\n"
                        "- **P2 检查 5,326 个公开参考音符事件，错误正例与同声部演奏对均为 0。** "
                        "公开数据不能提供真实错误召回或弱旁证。\n"
                        "- **当前非录不可的是 6 条 calibration，不是一次录满 12。** "
                        "只有冻结的 performance-only RF 先通过既有 clean 安全闸，"
                        "才条件追加 6 条 untouched fresh。"
                    ),
                },
                {
                    "id": "p1-finding",
                    "type": "markdown",
                    "body": (
                        "## 七个可直接运行候选全部在安全闸前淘汰\n\n"
                        "P1 的分母是本地权威 clean `743` 个位置、Round 5 已消费普通位置 "
                        "`624` 个、公开专业 Bach `6,652` 个；音高轨迹另按 `506` 个可判位置。"
                        "自动指控候选要求本地和 Round 5 `0 FP`、公开合并负担不超过 "
                        "`5/1000` 且任一录音不超过 `10/1000`。复核提示允许本地/Round 5 "
                        "合并 `2%`、单条 `5%`，公开合并 `20/1000`、单条 `50/1000`。"
                        "图中条数是违反了几项预注册安全上限，不把不同分母的误报率强行放在同一轴。"
                    ),
                },
                {
                    "id": "candidate-breach-chart-block",
                    "type": "chart",
                    "chartId": "candidate-breach-chart",
                },
                {
                    "id": "candidate-threshold-heading",
                    "type": "markdown",
                    "body": (
                        "## 冻结候选与精确门槛\n\n"
                        "以下逐项保留每个候选的固定触发阈值。"
                        "DP 数字按 `M/N/E/D=错音/漏音/多音/拖拍` 顺序列出；"
                        "完整 JSON 阈值仍保留在图表数据详情与 P1 预注册源中。\n\n"
                        f"{threshold_markdown}\n\n"
                        "### 冻结后的真实干净域结果\n\n"
                        f"{candidate_result_markdown}\n\n"
                        "后附表只保留角色、违反上限数与最终决策；逐域精确负担仍在上方和底层数据中。"
                    ),
                    "sourceId": "p1-prereg",
                },
                {
                    "id": "candidate-table-block",
                    "type": "table",
                    "tableId": "candidate-table",
                },
                {
                    "id": "p0-heading",
                    "type": "markdown",
                    "body": (
                        "## Round 5：位置混淆不能掩盖真实失败\n\n"
                        "四个含谱面上下文的片段 RF gate 失去泛化资格；"
                        "这不等于所有路线都只是混淆。gap 规则不读取位置，"
                        "其 `1/12` 与漏音 `1/6` 是真实漏检；波形能量 `0/12` "
                        "以及目标音高缺失 `5/12 @ 49/660 FP` 同样是真跨域失败。"
                        "节奏 `4/12` 只保留灵敏度观察，包内 `0 FP` 不可外推安全。"
                    ),
                    "sourceId": "p0-accounting",
                },
                {
                    "id": "p0-table-block",
                    "type": "table",
                    "tableId": "p0-table",
                },
                {
                    "id": "p2-heading",
                    "type": "markdown",
                    "body": (
                        "## 公开对齐数据没有错误正例\n\n"
                        "Bach10、URMP 与 MusicNet 的真实演奏标签是对齐或乐器音符真值，"
                        "不是错音、漏音、多音或拖拍的人工裁定。"
                        "把 score/audio 起音残差阈值化成 drag，再用同一残差评测，"
                        "会制造循环真值。因此 P2 不减少真实错误 calibration 的需要。"
                    ),
                    "sourceId": "p2-audit",
                },
                {
                    "id": "p2-table-block",
                    "type": "table",
                    "tableId": "p2-table",
                },
                {
                    "id": "p3-heading",
                    "type": "markdown",
                    "body": (
                        "## 现在只录 6 条，而不是一次录 12 条\n\n"
                        "P1 还留下一个不能零录音执行的预注册候选："
                        "`performance-only-RF-v2` 需要反平衡 calibration 才能拟合。"
                        "现有 Round 6 设计可无损拆为 calibration 6 条和 fresh 6 条；"
                        "两边各有两份新谱×三次角色轮换，每 gate 都是 "
                        "`6 positive + 12 confusion-negative`，曲目和演奏者跨 split 不重叠。\n\n"
                        "1. 现在只录并完整签署 6 条 calibration。\n"
                        "2. 按冻结 RF 参数和 `0.5` 决策点训练，先跑既有 P1 clean 安全闸。\n"
                        "3. 任一安全上限超限就收线，省掉 6 条 fresh；strict 保持 `2/12`。\n"
                        "4. 只有 Stage A 全通过，才冻结模型并补 6 条 fresh，一次性按 "
                        "`P≥90% / R≥50% / strict FP=0` 评测。\n\n"
                        f"分阶段协议语义 SHA-256：`{p3_sha}`。"
                    ),
                    "sourceId": "p3-protocol",
                },
                {
                    "id": "p3-table-block",
                    "type": "table",
                    "tableId": "p3-table",
                },
                {
                    "id": "further-questions",
                    "type": "markdown",
                    "body": (
                        "## 进一步问题\n\n"
                        "- Stage A 的冻结 RF 能否在本地 clean、Round 5 普通位置和公开专业演奏"
                        "同时守住自动指控安全上限？这是决定是否补 fresh 的唯一问题。\n"
                        "- 若 Stage A 失败，下一步不是放宽阈值或换位置特征，"
                        "而是把自动确诊路线按 strict `2/12` 收线，仅保留人工复核辅助。\n"
                        "- 若 Stage A 通过，Stage B 的 6 条 fresh 仍只产生性能证据，"
                        "不会自动打开学生端授权。"
                    ),
                },
                {
                    "id": "caveats",
                    "type": "markdown",
                    "body": (
                        "## 约束与假设\n\n"
                        "- 公开专业演奏没有逐音 clean 裁定，因此其 flags 称为负担，"
                        "不是权威假阳；淘汰依据仍是预注册负担上限。\n"
                        "- 当前 6 条是现有两谱×三角色反平衡设计下的最小 calibration，"
                        "不是对总体泛化置信度的充分样本声明。\n"
                        "- Round 4/5 已消费，不复用为验收；Stage A 不读取 fresh，"
                        "Stage B 看过结果后不回调、不重测。\n"
                        "- M4 OMR 与波形能量验漏音维持收线；合成召回不代表真实召回。\n"
                        "- 三个学生开关继续为 false，系统保持 fail-closed。"
                    ),
                },
            ],
            "charts": [
                {
                    "id": "candidate-breach-chart",
                    "title": "冻结候选违反的安全上限数量",
                    "description": "7/7 至少违反一项预注册安全上限，0 个进入召回审计。",
                    "dataset": "candidate_outcomes",
                    "type": "bar",
                    "encodings": {
                        "x": {
                            "field": "candidateLabel",
                            "type": "nominal",
                            "label": "候选",
                        },
                        "y": {
                            "field": "safetyLimitsBreached",
                            "type": "quantitative",
                            "label": "违反上限数",
                        },
                    },
                    "options": {
                        "orientation": "vertical",
                        "grouping": "single",
                        "legend": {"show": False},
                        "valueLabels": {"show": True},
                        "palette": {"kind": "single", "root": "orange"},
                    },
                    "source": candidate_source,
                }
            ],
            "tables": [
                {
                    "id": "candidate-table",
                    "title": "候选安全淘汰决策",
                    "description": (
                        "7 个候选；本地/Round 5 为权威普通位置，公开域为专业演奏负担。"
                    ),
                    "dataset": "candidate_outcomes",
                    "columns": [
                        {"field": "candidateLabel", "label": "候选", "type": "text"},
                        {"field": "role", "label": "语义", "type": "text"},
                        {
                            "field": "safetyLimitsBreached",
                            "label": "违反上限数",
                            "type": "number",
                        },
                        {"field": "retained", "label": "保留", "type": "text"},
                    ],
                    "defaultSort": {
                        "field": "candidateLabel",
                        "direction": "asc",
                    },
                    "source": candidate_source,
                },
                {
                    "id": "p0-table",
                    "title": "Round 5 证据分类",
                    "description": "只重新记账，不调参、不重训、不复考。",
                    "dataset": "round5_accounting",
                    "columns": [
                        {"field": "evidence", "label": "证据", "type": "text"},
                        {"field": "observed", "label": "观测", "type": "text"},
                        {
                            "field": "classification",
                            "label": "分类",
                            "type": "text",
                        },
                        {"field": "claim", "label": "允许结论", "type": "text"},
                    ],
                    "defaultSort": {"field": "evidence", "direction": "asc"},
                    "source": p0_source,
                },
                {
                    "id": "p2-table",
                    "title": "公开数据错误召回可派生性",
                    "description": "参考音符事件不等于经裁定错误正例。",
                    "dataset": "public_recall",
                    "columns": [
                        {"field": "dataset", "label": "数据集", "type": "text"},
                        {
                            "field": "referenceNotes",
                            "label": "参考音符",
                            "type": "number",
                        },
                        {
                            "field": "samePartPairs",
                            "label": "同声部演奏对",
                            "type": "number",
                        },
                        {
                            "field": "adjudicatedErrorPositives",
                            "label": "错误正例",
                            "type": "number",
                        },
                        {
                            "field": "recallDerivable",
                            "label": "可派生召回",
                            "type": "text",
                        },
                    ],
                    "defaultSort": {
                        "field": "referenceNotes",
                        "direction": "desc",
                    },
                    "source": p2_source,
                },
                {
                    "id": "p3-table",
                    "title": "最小分阶段录音量",
                    "description": "Stage B 仅在 Stage A 守住全部安全上限后授权。",
                    "dataset": "recording_stages",
                    "columns": [
                        {"field": "stage", "label": "阶段", "type": "text"},
                        {
                            "field": "recordings",
                            "label": "录音数",
                            "type": "number",
                        },
                        {"field": "condition", "label": "触发条件", "type": "text"},
                        {"field": "outcome", "label": "淘汰/通过动作", "type": "text"},
                    ],
                    "defaultSort": {"field": "stage", "direction": "asc"},
                    "source": p3_source,
                },
            ],
        },
        "snapshot": {
            "version": 1,
            "status": "ready",
            "generatedAt": GENERATED_AT,
            "datasets": {
                "candidate_outcomes": candidates,
                "round5_accounting": p0_rows,
                "public_recall": p2_rows,
                "recording_stages": p3_rows,
            },
        },
        "sources": all_sources,
        "package_info": {
            "audience": "product stakeholders",
            "audienceSpecification": "executive-report.md",
            "deliveryMode": "mcp-app",
            "requiredStructureMap": {
                "title": "title",
                "executiveSummary": "executive-summary",
                "keyFindingsWithVisualEvidence": [
                    "p1-finding",
                    "candidate-breach-chart-block",
                    "candidate-threshold-heading",
                    "candidate-table-block",
                    "p0-heading",
                    "p0-table-block",
                    "p2-heading",
                    "p2-table-block",
                ],
                "recommendedNextSteps": [
                    "p3-heading",
                    "p3-table-block",
                ],
                "furtherQuestions": "further-questions",
                "caveatsAndAssumptions": "caveats",
            },
            "chartMap": [
                {
                    "section": "七个可直接运行候选全部在安全闸前淘汰",
                    "question": "每个候选违反了多少项预注册安全上限？",
                    "family": "comparison",
                    "type": "bar",
                    "x": "candidateLabel",
                    "y": "safetyLimitsBreached",
                    "takeaway": "7/7 至少违反一项，0 个可进入召回审计。",
                    "palettePolicy": "single-root preferred; orange; direct values",
                }
            ],
            "visualOmissionNotes": [
                "P0、P2 与 P3 需要精确语义或条件查阅，使用表格比图形更诚实。",
                "不同候选/域的分母和安全语义不同，未把原始负担率画在同一轴。",
            ],
        },
    }
    return artifact


def run(out_artifact: Path) -> dict[str, Any]:
    artifact = build_artifact()
    out_artifact.parent.mkdir(parents=True, exist_ok=True)
    out_artifact.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return artifact


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-artifact", type=Path, default=OUT_ARTIFACT)
    args = parser.parse_args()
    artifact = run(args.out_artifact)
    print(json.dumps({
        "surface": artifact["surface"],
        "title": artifact["manifest"]["title"],
        "blocks": len(artifact["manifest"]["blocks"]),
        "charts": len(artifact["manifest"]["charts"]),
        "tables": len(artifact["manifest"]["tables"]),
        "datasets": {
            key: len(rows)
            for key, rows in artifact["snapshot"]["datasets"].items()
        },
        "outArtifact": report_path(args.out_artifact),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
