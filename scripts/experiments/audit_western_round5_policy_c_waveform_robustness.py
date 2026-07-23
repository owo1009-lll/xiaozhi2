#!/usr/bin/env python3
"""Audit frozen Policy-C waveform absence thresholds on consumed Round 5.

The thresholds were selected on the r2-01 synthetic injection development
set. Round 5 is never used for threshold selection or retuning. Its labels and
audio have already been inspected, and its room is perfectly confounded with
split, so this report is diagnostic-only and can never authorize promotion.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_policy_c_waveform_absence import (  # noqa: E402
    INJECT_DIR,
    PRIVATE,
    V2_SETS,
    evaluate_rows,
    prepare_injected,
    select_threshold,
    waveform_absence_rows,
)
from eval_western_strings_duration_extra_quantization import analyze_take  # noqa: E402
from train_western_round5_segment_edit_path import score_positions, truth_note_index  # noqa: E402


CONTRACT = "western-round5-policy-c-waveform-robustness-diagnostic-v1"
EVIDENCE_DATE = "2026-07-24"
PRECISION_FLOOR = 0.90
RECALL_FLOOR = 0.50
FROZEN_ENERGY_THRESHOLD = -134.825302
FROZEN_PITCH_THRESHOLD = 0.0
DEFAULT_MANIFEST = REPO / "data/private/western-strings-round5/manifest.csv"
DEFAULT_TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
DEFAULT_OUT = (
    REPO
    / "docs/evidence/western-strings-round5-policy-c-waveform-robustness-20260724.json"
)
LF_NORMALIZED_SUFFIXES = {
    ".csv",
    ".json",
    ".mjs",
    ".musicxml",
    ".py",
    ".txt",
    ".xml",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO.resolve()).as_posix()
    except ValueError as error:
        raise ValueError(f"source-outside-repository:{resolved}") from error


def source_binding(paths: list[Path]) -> dict[str, Any]:
    unique = sorted({path.resolve() for path in paths}, key=relative_path)
    missing = [relative_path(path) for path in unique if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"source-files-missing:{','.join(missing)}")
    files = []
    for path in unique:
        if path.suffix.lower() in LF_NORMALIZED_SUFFIXES:
            normalized = (
                path.read_text(encoding="utf-8")
                .replace("\r\n", "\n")
                .replace("\r", "\n")
            )
            digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
            hash_mode = "lf-normalized-sha256"
        else:
            digest = sha256(path)
            hash_mode = "raw-sha256"
        files.append({
            "path": relative_path(path),
            "sha256": digest,
            "hashMode": hash_mode,
        })
    aggregate = hashlib.sha256(
        json.dumps(
            files,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return {
        "hashAlgorithm": "sha256",
        "fileCount": len(files),
        "aggregateSha256": aggregate,
        "files": files,
    }


def frozen_thresholds() -> tuple[dict[str, Any], dict[str, Any]]:
    dev_names = [name for name in V2_SETS if name.startswith("r2-01-")]
    if len(dev_names) != 3:
        raise ValueError(f"synthetic-development-set-count-invalid:{len(dev_names)}")
    dev = prepare_injected(dev_names)
    energy_selected, energy_qualifying_count = select_threshold(dev, "relativeEnergyDb")
    pitch_selected, pitch_qualifying_count = select_threshold(dev, "targetPitchFrameRatio")
    observed_energy = float(energy_selected["threshold"])
    observed_pitch = float(pitch_selected["threshold"])
    if abs(observed_energy - FROZEN_ENERGY_THRESHOLD) > 1e-9:
        raise ValueError(
            "frozen-energy-threshold-drift:"
            f"expected={FROZEN_ENERGY_THRESHOLD}:observed={observed_energy}"
        )
    if abs(observed_pitch - FROZEN_PITCH_THRESHOLD) > 1e-9:
        raise ValueError(
            "frozen-pitch-threshold-drift:"
            f"expected={FROZEN_PITCH_THRESHOLD}:observed={observed_pitch}"
        )
    return (
        {
            "feature": "relativeEnergyDb",
            "threshold": FROZEN_ENERGY_THRESHOLD,
            "selectionDomain": "r2-01 waveform-injection-v2 (3 seeds)",
            "qualifyingDevelopmentThresholdCount": energy_qualifying_count,
            "syntheticDevelopment": energy_selected["pooled"],
        },
        {
            "feature": "targetPitchFrameRatio",
            "threshold": FROZEN_PITCH_THRESHOLD,
            "selectionDomain": "r2-01 waveform-injection-v2 (3 seeds)",
            "qualifyingDevelopmentThresholdCount": pitch_qualifying_count,
            "syntheticDevelopment": pitch_selected["pooled"],
        },
    )


def prepare_round5(
    manifest_path: Path,
    truth_path: Path,
) -> tuple[list[dict[str, Any]], list[Path]]:
    truth = read_json(truth_path)
    if truth.get("contractVersion") != "western-round5-targeted-diagnosis-intake-v1":
        raise ValueError("round5-truth-contract-invalid")
    prepared: list[dict[str, Any]] = []
    sources = [manifest_path, truth_path]
    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        manifest_rows = list(csv.DictReader(handle))
    if len(manifest_rows) != 12:
        raise ValueError(f"round5-recording-count-invalid:{len(manifest_rows)}")
    for manifest in manifest_rows:
        recording_id = manifest["recordingId"]
        recording_truth = truth.get("recordings", {}).get(recording_id)
        if not recording_truth or recording_truth.get("completeErrorInventory") is not True:
            raise ValueError(f"round5-complete-inventory-missing:{recording_id}")
        audio = REPO / manifest["audioPath"]
        score = REPO / manifest["scorePath"]
        if not audio.is_file() or not score.is_file():
            raise FileNotFoundError(f"round5-source-missing:{recording_id}")
        positions = score_positions(score)
        missing_positives = {
            truth_note_index(positions, event)
            for event in recording_truth.get("events", [])
            if event.get("gate") == "missing" and event.get("label") == "positive"
        }
        missing_confusions = {
            truth_note_index(positions, event)
            for event in recording_truth.get("events", [])
            if event.get("gate") == "missing"
            and event.get("label") == "confusion_negative"
        }
        if len(missing_positives) != 1 or len(missing_confusions) != 2:
            raise ValueError(
                f"round5-missing-gate-denominator-invalid:{recording_id}:"
                f"positive={len(missing_positives)}:confusion={len(missing_confusions)}"
            )
        take = analyze_take(score, audio)
        rows = waveform_absence_rows(audio, take)
        if len(rows) != len(positions):
            raise ValueError(
                f"round5-score-row-count-mismatch:{recording_id}:"
                f"positions={len(positions)}:rows={len(rows)}"
            )
        prepared.append({
            "recordingId": recording_id,
            "split": manifest["split"],
            "performerId": manifest["performerId"],
            "deviceId": manifest["deviceId"],
            "roomId": manifest["roomId"],
            "rows": rows,
            "positives": missing_positives,
            "confusionNegatives": missing_confusions,
        })
        sources.extend([audio, score])
    return prepared, sources


def evaluate_records(
    records: list[dict[str, Any]],
    threshold: float,
    feature: str,
) -> dict[str, Any]:
    rows_by_take = [
        (record["recordingId"], record["rows"], record["positives"])
        for record in records
    ]
    evaluated = evaluate_rows(rows_by_take, threshold, feature)
    signed_confusion_flags = 0
    total_flags = 0
    assignment_gaps = 0
    for record in records:
        flags = {
            int(row["noteIndex"])
            for row in record["rows"]
            if row["assignmentGap"] and float(row[feature]) <= threshold
        }
        total_flags += len(flags)
        assignment_gaps += sum(bool(row["assignmentGap"]) for row in record["rows"])
        signed_confusion_flags += len(flags & record["confusionNegatives"])
    return {
        "recordingCount": len(records),
        "scorePositionCount": sum(len(record["rows"]) for record in records),
        "signedPositiveCount": sum(len(record["positives"]) for record in records),
        "signedConfusionNegativeCount": sum(
            len(record["confusionNegatives"]) for record in records
        ),
        "assignmentGapCount": assignment_gaps,
        "flagCount": total_flags,
        "signedConfusionFalsePositiveCount": signed_confusion_flags,
        **evaluated["pooled"],
        "takes": evaluated["takes"],
    }


def stratified_evaluation(
    records: list[dict[str, Any]],
    threshold: float,
    feature: str,
) -> dict[str, Any]:
    output = {"pooled": evaluate_records(records, threshold, feature)}
    for dimension in ("split", "performerId", "deviceId", "roomId"):
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in records:
            groups[str(record[dimension])].append(record)
        output[dimension] = {
            key: evaluate_records(group, threshold, feature)
            for key, group in sorted(groups.items())
        }
    return output


def diagnostic_joint_floor_summary(evaluation: dict[str, Any]) -> dict[str, Any]:
    strata = [
        evaluation["pooled"],
        *evaluation["split"].values(),
        *evaluation["performerId"].values(),
        *evaluation["deviceId"].values(),
        *evaluation["roomId"].values(),
    ]
    failed = [
        {
            "recordingCount": row["recordingCount"],
            "precision": row["precision"],
            "recall": row["recall"],
        }
        for row in strata
        if row["jointFloorReady"] is not True
    ]
    return {
        "pooledJointFloorReady": evaluation["pooled"]["jointFloorReady"] is True,
        "allReportedStrataJointFloorReady": not failed,
        "failedStratumCount": len(failed),
        "failedStrata": failed,
    }


def build_report(
    records: list[dict[str, Any]],
    binding_paths: list[Path],
    energy_threshold: dict[str, Any],
    pitch_threshold: dict[str, Any],
) -> dict[str, Any]:
    energy = stratified_evaluation(
        records,
        float(energy_threshold["threshold"]),
        "relativeEnergyDb",
    )
    pitch = stratified_evaluation(
        records,
        float(pitch_threshold["threshold"]),
        "targetPitchFrameRatio",
    )
    energy_summary = diagnostic_joint_floor_summary(energy)
    pitch_summary = diagnostic_joint_floor_summary(pitch)
    blocking_reasons = [
        "round5-consumed-diagnostic-not-promotion-evidence",
        "round5-position-targets-score-context-confounded",
        "round5-room-perfectly-confounded-with-split",
        "independent-cross-performer-device-fresh-evidence-missing",
        *(
            []
            if energy_summary["allReportedStrataJointFloorReady"]
            else ["frozen-waveform-energy-cross-domain-joint-floor-failed"]
        ),
        *(
            []
            if pitch_summary["allReportedStrataJointFloorReady"]
            else ["frozen-target-pitch-cross-domain-joint-floor-failed"]
        ),
    ]
    return {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "evidenceDate": EVIDENCE_DATE,
        "scope": "consumed-multi-device-room-diagnostic-only",
        "evidenceRole": "diagnostic-only",
        "studentFacing": False,
        "automaticAccusationReady": False,
        "reviewAssistPromotionReady": False,
        "promotionEvidenceEligible": False,
        "freshBlindPromotionEligible": False,
        "round5Consumed": True,
        "thresholdRetunedOnRound5": False,
        "completeInventoryNegativesUsed": True,
        "denominatorDefinition": (
            "For the missing gate, the signed positive is positive and every "
            "other score position is a strict negative."
        ),
        "floors": {
            "minPrecision": PRECISION_FLOOR,
            "minRecall": RECALL_FLOOR,
        },
        "sample": {
            "recordings": len(records),
            "scorePositions": sum(len(record["rows"]) for record in records),
            "missingPositives": sum(len(record["positives"]) for record in records),
            "missingConfusionNegatives": sum(
                len(record["confusionNegatives"]) for record in records
            ),
            "performers": len({record["performerId"] for record in records}),
            "devices": len({record["deviceId"] for record in records}),
            "rooms": len({record["roomId"] for record in records}),
        },
        "independenceAudit": {
            "thresholdSelectionUsesRound5": False,
            "round5LabelsPreviouslyInspected": True,
            "round5AudioPreviouslyEvaluated": True,
            "samePerformersAcrossSplits": True,
            "sameDevicesAcrossSplits": True,
            "roomPerfectlyConfoundedWithSplit": True,
            "positionTargetsScoreContextConfounded": True,
        },
        "energyAbsence": {
            "frozenThreshold": energy_threshold,
            "round5Diagnostic": energy,
            "diagnosticJointFloor": energy_summary,
            "energyRobustnessReady": False,
        },
        "targetPitchAbsence": {
            "frozenThreshold": pitch_threshold,
            "round5Diagnostic": pitch,
            "diagnosticJointFloor": pitch_summary,
            "targetPitchRobustnessReady": False,
        },
        "sourceBinding": source_binding(binding_paths),
        "blockingReasons": blocking_reasons,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--truth", type=Path, default=DEFAULT_TRUTH)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = args.manifest.resolve()
    truth = args.truth.resolve()
    energy_threshold, pitch_threshold = frozen_thresholds()
    records, round5_sources = prepare_round5(manifest, truth)
    dev_names = [name for name in V2_SETS if name.startswith("r2-01-")]
    synthetic_sources: list[Path] = []
    for name in dev_names:
        piece = name.split("-injected")[0]
        synthetic_sources.extend([
            INJECT_DIR / f"{name}.wav",
            INJECT_DIR / f"{name}.labels.json",
            PRIVATE / f"{piece}.musicxml",
        ])
    implementation_sources = [
        Path(__file__),
        REPO / "scripts/experiments/eval_western_policy_c_waveform_absence.py",
        REPO / "scripts/experiments/train_western_round5_segment_edit_path.py",
    ]
    report = build_report(
        records,
        [*round5_sources, *synthetic_sources, *implementation_sources],
        energy_threshold,
        pitch_threshold,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "ok": True,
        "report": relative_path(args.out),
        "energy": report["energyAbsence"]["round5Diagnostic"]["pooled"],
        "targetPitch": report["targetPitchAbsence"]["round5Diagnostic"]["pooled"],
        "promotionEvidenceEligible": report["promotionEvidenceEligible"],
        "blockingReasons": report["blockingReasons"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
