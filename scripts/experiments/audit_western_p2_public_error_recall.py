#!/usr/bin/env python3
"""Audit whether existing public aligned datasets can support real error recall."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
M0_ROOT = REPO / "data/experiments/western-strings-m0"
ACCOMPANIED_ROOT = (
    REPO / "data/experiments/western-strings-musicnet-accompanied-violin"
)
DATASET_INDEX = (
    REPO
    / "data/experiments/western-strings-m1/western-strings-dataset-index.csv"
)
OUT_JSON = (
    REPO
    / "docs/evidence/western-strings-p2-public-error-recall-audit-20260724.json"
)
OUT_MD = REPO / "docs/western-strings-p2-public-error-recall-audit.md"
CONTRACT = "western-p2-public-error-recall-audit-v1"
METHODS = {
    "basic-pitch-dtw",
    "crepe-dtw",
    "linear-scoretime",
    "parangonar-basic-pitch",
    "pyin-dtw",
}
REFERENCE_COLUMNS = {
    "piece",
    "noteIndex",
    "method",
    "scoreTime",
    "goldTime",
    "predTime",
    "absError",
    "midi",
    "doubleStop",
    "legato",
}
ERROR_LABEL_NAMES = {
    "adjudicated",
    "asperformed",
    "correctness",
    "deviationlabel",
    "error",
    "errortype",
    "extra",
    "insertion",
    "iserror",
    "missing",
    "omission",
    "performednote",
    "targetgate",
    "timingerror",
    "wrongpitch",
}

DATASETS = {
    "bach10": {
        "summary": M0_ROOT / "m0a-bach10/m0a-bach10-summary.json",
        "perNote": M0_ROOT / "m0a-bach10/m0a-bach10-per-note.csv",
        "sanity": M0_ROOT / "m0a-bach10/m0a-bach10-sanity.csv",
        "evaluator": REPO / "scripts/experiments/eval_western_strings_m0_bach10.py",
        "expectedUniqueNotes": 425,
        "expectedItemCount": 10,
        "sanityNoteField": "violinGoldNotes",
    },
    "urmp": {
        "summary": M0_ROOT / "m0b-urmp/m0b-urmp-summary.json",
        "perNote": M0_ROOT / "m0b-urmp/m0b-urmp-per-note.csv",
        "sanity": M0_ROOT / "m0b-urmp/m0b-urmp-sanity.csv",
        "evaluator": REPO / "scripts/experiments/eval_western_strings_m0_urmp.py",
        "expectedUniqueNotes": 146,
        "expectedItemCount": 2,
        "sanityNoteField": "goldNotes",
    },
    "musicnet-solo": {
        "summary": M0_ROOT / "m0c-musicnet/m0c-musicnet-summary.json",
        "perNote": M0_ROOT / "m0c-musicnet/m0c-musicnet-per-note.csv",
        "sanity": M0_ROOT / "m0c-musicnet/m0c-musicnet-sanity.csv",
        "evaluator": REPO / "scripts/experiments/eval_western_strings_m0_musicnet.py",
        "expectedUniqueNotes": 1517,
        "expectedItemCount": 2,
        "sanityNoteField": "goldNotes",
    },
}

ACCOMPANIED_REPORT = ACCOMPANIED_ROOT / "report.json"
ACCOMPANIED_EVALUATOR = (
    REPO / "scripts/experiments/eval_western_musicnet_accompanied_violin.py"
)
ACCOMPANIED_LABELS = (
    ACCOMPANIED_ROOT / "raw/2330.csv",
    ACCOMPANIED_ROOT / "raw/2334.csv",
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def report_path(path: Path) -> str:
    return path.resolve().relative_to(REPO.resolve()).as_posix()


def bool_cell(value: str | None) -> bool:
    return str(value or "").strip().lower() == "true"


def verify_source_contracts() -> None:
    bach = DATASETS["bach10"]["evaluator"].read_text(encoding="utf-8")
    urmp = DATASETS["urmp"]["evaluator"].read_text(encoding="utf-8")
    musicnet = DATASETS["musicnet-solo"]["evaluator"].read_text(encoding="utf-8")
    accompanied = ACCOMPANIED_EVALUATOR.read_text(encoding="utf-8")
    required = {
        "bach10-schema": (
            bach,
            "audio_time_ms  score_time_ms  midi_pitch  source_id",
        ),
        "bach10-source-filter": (bach, "if source != 1:"),
        "urmp-count-identity": (urmp, "MIDI/gold note count mismatch"),
        "urmp-pitch-identity": (urmp, "pitch mismatches"),
        "musicnet-count-identity": (
            musicnet,
            "MIDI/label note count mismatch",
        ),
        "musicnet-pitch-identity": (musicnet, "pitch mismatches"),
        "musicnet-label-noise-caveat": (
            musicnet,
            "residual annotation noise",
        ),
        "accompanied-violin-filter": (
            accompanied,
            "int(row.get(\"instrument\") or 0) == VIOLIN_INSTRUMENT_ID",
        ),
    }
    missing = [name for name, (source, token) in required.items() if token not in source]
    if missing:
        raise RuntimeError(f"p2-source-contract-drift:{','.join(missing)}")


def audit_m0_dataset(dataset_id: str, spec: dict[str, Any]) -> dict[str, Any]:
    summary = read_json(spec["summary"])
    per_note = read_csv(spec["perNote"])
    sanity = read_csv(spec["sanity"])
    if not per_note:
        raise RuntimeError(f"p2-empty-per-note:{dataset_id}")
    columns = set(per_note[0])
    if columns != REFERENCE_COLUMNS:
        raise RuntimeError(
            f"p2-column-drift:{dataset_id}:{sorted(columns)}"
        )
    methods = {row["method"] for row in per_note}
    if methods != METHODS:
        raise RuntimeError(f"p2-method-drift:{dataset_id}:{sorted(methods)}")

    key_rows: dict[tuple[str, str], list[dict[str, str]]] = {}
    method_keys: set[tuple[str, str, str]] = set()
    for row in per_note:
        note_key = (row["piece"], row["noteIndex"])
        method_key = (*note_key, row["method"])
        if method_key in method_keys:
            raise RuntimeError(f"p2-duplicate-method-row:{dataset_id}:{method_key}")
        method_keys.add(method_key)
        key_rows.setdefault(note_key, []).append(row)

    reference_fields = (
        "scoreTime",
        "goldTime",
        "midi",
        "doubleStop",
        "legato",
    )
    inconsistent = []
    for key, rows in key_rows.items():
        references = {
            tuple(row[field] for field in reference_fields)
            for row in rows
        }
        if len(rows) != len(METHODS) or len(references) != 1:
            inconsistent.append(key)
    if inconsistent:
        raise RuntimeError(
            f"p2-reference-expansion-inconsistent:{dataset_id}:{inconsistent[:5]}"
        )

    unique_notes = len(key_rows)
    if unique_notes != int(spec["expectedUniqueNotes"]):
        raise RuntimeError(
            f"p2-note-count-drift:{dataset_id}:{unique_notes}"
        )
    if len(sanity) != int(spec["expectedItemCount"]):
        raise RuntimeError(
            f"p2-item-count-drift:{dataset_id}:{len(sanity)}"
        )
    sanity_notes = sum(
        int(row[str(spec["sanityNoteField"])])
        for row in sanity
    )
    if sanity_notes != unique_notes:
        raise RuntimeError(
            f"p2-sanity-note-count-mismatch:{dataset_id}:{sanity_notes}"
        )
    forbidden_present = sorted(
        column for column in columns if column.lower() in ERROR_LABEL_NAMES
    )
    if forbidden_present:
        raise RuntimeError(
            f"p2-unexpected-error-label:{dataset_id}:{forbidden_present}"
        )

    if dataset_id == "bach10":
        pairing = {
            "samePartRepeatedPerformancePairs": 0,
            "reason": (
                "10 首不同众赞歌各只有一条 source_id=1 小提琴/高音声部；"
                "其他 source ID 是同次合奏中的不同声部。"
            ),
        }
        score_label_identity = (
            "The source schema carries one shared MIDI pitch beside score and "
            "audio onset times; it does not carry intended-versus-performed pitch."
        )
        item_summary = {
            "pieces": len(sanity),
            "instruments": ["violin/soprano source_id=1"],
            "doubleStopNotes": sum(int(row["doubleStopNotes"]) for row in sanity),
            "legatoKnownNotes": sum(int(row["legatoKnownNotes"]) for row in sanity),
        }
    elif dataset_id == "urmp":
        pairing = {
            "samePartRepeatedPerformancePairs": 0,
            "reason": (
                "小提琴和大提琴文件是同一 Jupiter 合奏的不同声部，"
                "不是同一声部的正确/错误两次演奏。"
            ),
        }
        score_label_identity = (
            "The evaluator hard-fails on MIDI/gold count or pitch mismatch; "
            "remaining score-versus-audio differences are onset/duration alignment."
        )
        item_summary = {
            "pieces": len({row["piece"] for row in sanity}),
            "tracks": [row["track"] for row in sanity],
            "instruments": [row["instrument"] for row in sanity],
        }
    else:
        pairing = {
            "samePartRepeatedPerformancePairs": 0,
            "reason": (
                "样本 2191 与 2298 是不同 Bach 作品、不同乐器，"
                "不是同一声部的成对演奏。"
            ),
        }
        score_label_identity = (
            "The evaluator hard-fails on MIDI/label count or pitch mismatch; "
            "the authors' estimated residual label noise has no adjudicated positions."
        )
        item_summary = {
            "samples": [row["id"] for row in sanity],
            "ensembles": [row["ensemble"] for row in sanity],
            "instruments": [row["instrument"] for row in sanity],
            "doubleStopNotes": sum(int(row["doubleStopNotes"]) for row in sanity),
        }

    return {
        "datasetId": dataset_id,
        "artifactDatasetName": summary.get("dataset"),
        "grain": "one aligned reference note, repeated once per evaluation method",
        "artifactRows": len(per_note),
        "uniqueAlignedReferenceNotes": unique_notes,
        "methodsPerReferenceNote": len(METHODS),
        "itemSummary": item_summary,
        "columns": sorted(columns),
        "adjudicatedErrorLabelColumns": [],
        "scoreAndAudioOnsetPairAvailable": True,
        "timingResidualComputable": True,
        "timingResidualEligibleAsErrorGold": False,
        "timingResidualExclusionReasons": [
            "Score time and performance time differ under expressive tempo and rubato.",
            "No external correctness rubric or human error adjudication is attached.",
            "Thresholding the evaluated timing feature to create truth would be circular.",
        ],
        "pairingAudit": pairing,
        "scoreLabelIdentityAudit": score_label_identity,
        "adjudicatedRealErrorPositives": 0,
        "realErrorRecallDerivable": False,
        "eligibleUses": [
            "real-performance alignment evaluation",
            "recognition stress testing",
            "clean-like burden diagnostics with an explicit non-gold caveat",
        ],
        "ineligibleUses": [
            "wrong/missing/extra/drag error recall",
            "student-facing detector promotion",
        ],
    }


def audit_accompanied_musicnet() -> dict[str, Any]:
    report = read_json(ACCOMPANIED_REPORT)
    if report.get("schemaVersion") != "western-musicnet-accompanied-violin-v1":
        raise RuntimeError("p2-accompanied-report-contract-drift")
    if report.get("evidenceType") != (
        "independent-full-mix-audio-event-recognition-against-"
        "instrument-labelled-note-gold"
    ):
        raise RuntimeError("p2-accompanied-evidence-type-drift")

    sample_by_id = {str(row["id"]): row for row in report["samples"]}
    label_counts: dict[str, int] = {}
    label_columns: set[str] = set()
    for path in ACCOMPANIED_LABELS:
        sample_id = path.stem
        rows = read_csv(path)
        if not rows:
            raise RuntimeError(f"p2-empty-accompanied-labels:{sample_id}")
        label_columns.update(rows[0])
        violin = [
            row
            for row in rows
            if int(row.get("instrument") or 0) == 41
        ]
        label_counts[sample_id] = len(violin)
        expected_sha = sample_by_id[sample_id]["labelsSha256"]
        if sha256(path) != expected_sha:
            raise RuntimeError(f"p2-accompanied-label-sha-drift:{sample_id}")

    expected_counts = {
        "2330": int(report["development"]["aggregate"]["50ms"]["referenceNotes"]),
        "2334": int(report["holdout"]["aggregate"]["50ms"]["referenceNotes"]),
    }
    if label_counts != expected_counts:
        raise RuntimeError(
            f"p2-accompanied-label-count-drift:{label_counts}:{expected_counts}"
        )
    forbidden_present = sorted(
        column for column in label_columns
        if column.lower() in ERROR_LABEL_NAMES
    )
    if forbidden_present:
        raise RuntimeError(
            f"p2-unexpected-accompanied-error-label:{forbidden_present}"
        )
    samples = [
        {
            "id": str(row["id"]),
            "split": row["split"],
            "work": row["work"],
            "performerSource": row["performerSource"],
            "violinReferenceNotes": label_counts[str(row["id"])],
        }
        for row in report["samples"]
    ]
    return {
        "datasetId": "musicnet-accompanied-violin",
        "grain": "one instrument-labelled violin note in a violin+piano mix",
        "samples": samples,
        "uniqueInstrumentLabelledReferenceNotes": sum(label_counts.values()),
        "labelColumns": sorted(label_columns),
        "adjudicatedErrorLabelColumns": [],
        "pairingAudit": {
            "samePartRepeatedPerformancePairs": 0,
            "reason": (
                "开发集 2330 与留出集 2334 使用不同奏鸣曲和不同演奏者；"
                "它们是识别评测分割，不是同一声部的正确/错误演奏对。"
            ),
        },
        "timingResidualComputable": False,
        "adjudicatedRealErrorPositives": 0,
        "realErrorRecallDerivable": False,
        "eligibleUses": [
            "full-mix target-instrument recognition/isolation evaluation",
            "accompaniment-domain precision and coverage stress testing",
        ],
        "ineligibleUses": [
            "wrong/missing/extra/drag error recall",
            "student-facing detector promotion",
        ],
        "recognitionGateReady": report["accompaniedViolinRecognitionReady"],
        "studentReleaseEligible": report["studentReleaseEligible"],
        "labelNoiseCaveat": (
            "The estimated roughly 4% residual MusicNet label error has no known "
            "per-position adjudication and cannot be counted as detector positives."
        ),
    }


def raw_reproducibility_audit() -> dict[str, Any]:
    rows = [
        row
        for row in read_csv(DATASET_INDEX)
        if row.get("dataset") in {"bach10", "urmp", "musicnet"}
    ]
    expected_rows = 14
    if len(rows) != expected_rows:
        raise RuntimeError(f"p2-dataset-index-row-drift:{len(rows)}")
    present = {
        field: sum(bool_cell(row.get(field)) for row in rows)
        for field in ("audioExists", "scoreExists", "goldExists")
    }
    return {
        "indexedDatasetRows": len(rows),
        "locallyPresentByIndex": present,
        "rawM0ReplayableWithoutRedownload": all(
            count == len(rows) for count in present.values()
        ),
        "impact": (
            "The tracked summaries, per-note tables, evaluator contracts, and "
            "hashes are sufficient for this label-semantics audit, but the M0 "
            "metrics cannot currently be rerun locally without redownloading raw data."
        ),
        "severity": "medium",
    }


def build_report() -> dict[str, Any]:
    verify_source_contracts()
    m0 = [
        audit_m0_dataset(dataset_id, spec)
        for dataset_id, spec in DATASETS.items()
    ]
    accompanied = audit_accompanied_musicnet()
    reproducibility = raw_reproducibility_audit()
    same_part_pairs = sum(
        row["pairingAudit"]["samePartRepeatedPerformancePairs"]
        for row in [*m0, accompanied]
    )
    aligned_notes = sum(row["uniqueAlignedReferenceNotes"] for row in m0)
    instrument_labelled_notes = accompanied[
        "uniqueInstrumentLabelledReferenceNotes"
    ]
    source_paths = [
        DATASET_INDEX,
        ACCOMPANIED_REPORT,
        ACCOMPANIED_EVALUATOR,
        *ACCOMPANIED_LABELS,
    ]
    for spec in DATASETS.values():
        source_paths.extend(
            (spec["summary"], spec["perNote"], spec["sanity"], spec["evaluator"])
        )
    return {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "evidenceDate": "2026-07-24",
        "evidenceRole": "public-real-domain-error-recall-derivability-audit",
        "sourceBindings": [
            {"path": report_path(path), "sha256": sha256(path)}
            for path in source_paths
        ],
        "intendedUse": (
            "Determine whether already-aligned public real recordings contain "
            "independent positive truth for wrong, missing, extra, or drag recall."
        ),
        "datasets": [*m0, accompanied],
        "profile": {
            "m0AlignedReferenceNotes": aligned_notes,
            "accompaniedInstrumentLabelledReferenceNotes": instrument_labelled_notes,
            "totalReferenceNoteEventsInspected": (
                aligned_notes + instrument_labelled_notes
            ),
            "samePartRepeatedPerformancePairs": same_part_pairs,
            "adjudicatedRealErrorPositiveCount": 0,
        },
        "reproducibility": reproducibility,
        "decision": {
            "realErrorRecallMetricDerivable": False,
            "weakRealRecallEvidenceAvailable": False,
            "reason": (
                "All public truth is alignment or instrument-labelled note truth. "
                "There are zero adjudicated error positives and zero repeated "
                "same-part correct/error performance pairs."
            ),
            "timingResidualPolicy": (
                "Do not label large score-to-performance onset residuals as drag "
                "errors: expressive timing is unadjudicated and a residual "
                "threshold would manufacture circular truth."
            ),
            "syntheticRecallPolicy": (
                "Synthetic injection remains precision-side support only and "
                "must not be reported as real-domain recall."
            ),
            "p2ReducesPositiveErrorRecordingNeed": False,
            "promotionAuthorized": False,
        },
        "stopLines": {
            "m4OmrFurtherInvestment": False,
            "waveformEnergyMissingNoteFurtherInvestment": False,
        },
        "releaseSafety": {
            "round4AndRound5AcceptanceReuse": False,
            "postBlindRetuning": False,
            "studentSwitchesRemainFalse": True,
            "failClosed": True,
        },
        "findings": [
            {
                "severity": "critical",
                "confidence": "high",
                "finding": "No public dataset supplies real error-positive truth.",
                "evidence": (
                    "0 adjudicated positives and 0 same-part repeated-performance "
                    "pairs across four audited dataset paths."
                ),
                "impact": "Recall for student errors cannot be computed or weakly inferred.",
            },
            {
                "severity": "high",
                "confidence": "high",
                "finding": "Timing residuals are not error labels.",
                "evidence": (
                    f"{aligned_notes} score/audio onset pairs exist, but score pitch "
                    "and annotation pitch are identical by schema or evaluator assertion."
                ),
                "impact": (
                    "Treating residual thresholds as drag truth would evaluate a "
                    "detector against labels generated from its own feature."
                ),
            },
            {
                "severity": reproducibility["severity"],
                "confidence": "high",
                "finding": "The M0 raw fixtures are absent locally.",
                "evidence": (
                    "The dataset index reports 0/14 audio, 0/14 score, and "
                    "0/14 gold files present."
                ),
                "impact": (
                    "The semantic audit is source-bound, but numerical M0 "
                    "regeneration requires a public-data redownload."
                ),
            },
        ],
    }


def markdown(report: dict[str, Any]) -> str:
    profile = report["profile"]
    lines = [
        "# P2 公开数据真实错误召回可派生性审计",
        "",
        "结论：Bach10、URMP、MusicNet 现有证据不能给出哪怕“弱”的真实错误召回。"
        "它们有真实演奏和对齐真值，但没有经人工裁定的错误正例，也没有同一声部的正确/错误成对演奏。",
        "",
        "## 数据与粒度",
        "",
        "| 数据路径 | 可检查参考音符 | 成对同声部演奏 | 经裁定错误正例 | 可派生真实错误召回 |",
        "|---|---:|---:|---:|---|",
    ]
    for row in report["datasets"]:
        notes = row.get(
            "uniqueAlignedReferenceNotes",
            row.get("uniqueInstrumentLabelledReferenceNotes", 0),
        )
        lines.append(
            f"| `{row['datasetId']}` | {notes} | "
            f"{row['pairingAudit']['samePartRepeatedPerformancePairs']} | "
            f"{row['adjudicatedRealErrorPositives']} | 否 |"
        )
    lines.extend([
        "",
        f"共检查 {profile['totalReferenceNoteEventsInspected']} 个参考音符事件："
        f"{profile['m0AlignedReferenceNotes']} 个带 score/audio 起音对齐，"
        f"{profile['accompaniedInstrumentLabelledReferenceNotes']} 个伴奏混音中的小提琴标签。",
        "",
        "## 为什么不能把时间残差当作错误",
        "",
        "- Bach10 的一行只有同一个 MIDI 音高、score onset、audio onset 和声部编号；不存在“应演音高/实际音高”两列。",
        "- URMP 与 MusicNet 评测器会在乐谱 MIDI 和演奏标签的音符数或音高不一致时直接报错，留下的是表情速度、rubato 和对齐差异，不是错误裁定。",
        "- 用 score/audio 残差超过某阈值定义 `drag`，再用同一残差特征评估检测器，会制造循环真值。",
        "- MusicNet 约 4% 的残余标注误差没有已知位置，不能把统计噪声折算成检测正例。",
        "",
        "## 各数据集的配对结论",
        "",
    ])
    for row in report["datasets"]:
        lines.append(
            f"- `{row['datasetId']}`：{row['pairingAudit']['reason']}"
        )
    lines.extend([
        "",
        "## 可保留与不可保留的证据",
        "",
        "- 可保留：真实演奏对齐能力、音符识别压力测试、伴奏混音目标乐器隔离，以及带明确“非错误 gold”警告的负担诊断。",
        "- 不可保留：错音、漏音、多音、拖拍召回；这些数据不能授权学生端或自动指控晋升。",
        "- 合成注入仍只允许作精度侧支持，不得再上报为真实域召回。",
        "",
        "## 复现限制",
        "",
        "数据索引显示 M0 的 14 行原始 audio/score/gold 当前均不在本机；"
        "本审计依靠已跟踪的汇总表、逐音表、评测器强一致性断言和 SHA，足以判定标签语义，"
        "但若要重算历史 M0 数值仍需重新下载公开原始数据。",
        "",
        "## 裁决",
        "",
        "- P2 可派生真实错误正例：`0`。",
        "- P2 可派生真实错误召回：`false`；弱旁证同样为 `false`。",
        "- P2 不减少真实错误录音需求；但是否值得录，必须先服从 P1 的干净域安全淘汰结果。",
        "- M4 OMR 与能量验漏音维持收线；Round 4/5 不复用验收；看盲集后不回调。",
        "- 学生三个开关继续 `false`，系统保持 fail-closed。",
        "",
        "机器可核验来源与 SHA-256 见配套 JSON。",
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
        "referenceNoteEvents": report["profile"]["totalReferenceNoteEventsInspected"],
        "samePartRepeatedPerformancePairs": (
            report["profile"]["samePartRepeatedPerformancePairs"]
        ),
        "adjudicatedRealErrorPositiveCount": (
            report["profile"]["adjudicatedRealErrorPositiveCount"]
        ),
        "realErrorRecallMetricDerivable": (
            report["decision"]["realErrorRecallMetricDerivable"]
        ),
        "weakRealRecallEvidenceAvailable": (
            report["decision"]["weakRealRecallEvidenceAvailable"]
        ),
        "outJson": report_path(args.out_json),
        "outMarkdown": report_path(args.out_md),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
