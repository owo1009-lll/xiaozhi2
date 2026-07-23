#!/usr/bin/env python3
"""Check Round 5 label-position balance before recording any audio.

Only MusicXML and planned truth positions are read.  If a score-context-only
rule can separate positives from confusion negatives under leave-one-recording
out, the plan is rejected before recording.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import audit_western_round5_calibration_failure_modes as failure_audit  # noqa: E402
import train_western_round5_segment_edit_path as segment  # noqa: E402

CONTRACT = "western-round5-position-balance-preflight-v1"
MANIFEST = REPO / "data/private/western-strings-round5/manifest.csv"
TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
OUT = (
    REPO
    / "data/experiments"
    / "western-strings-round5-position-balance"
    / "report.json"
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def score_context_rows(
    manifest_path: Path,
    truth_path: Path,
) -> list[dict[str, Any]]:
    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        manifest = list(csv.DictReader(handle))
    truth = json.loads(truth_path.read_text(encoding="utf-8"))["recordings"]
    rows = []
    for metadata in manifest:
        recording_id = metadata["recordingId"]
        truth_recording = truth.get(recording_id)
        if not truth_recording:
            raise ValueError(f"round5-truth-recording-missing:{recording_id}")
        score_path = REPO / metadata["scorePath"]
        positions = segment.score_positions(score_path)
        for event in truth_recording.get("events", []):
            index = segment.truth_note_index(positions, event)
            midi = int(positions[index]["scoreMidi"])
            previous_interval = (
                midi - int(positions[index - 1]["scoreMidi"])
                if index > 0 else 0
            )
            next_interval = (
                int(positions[index + 1]["scoreMidi"]) - midi
                if index + 1 < len(positions) else 0
            )
            rows.append({
                "recordingId": recording_id,
                "eventId": event.get("eventId"),
                "split": metadata["split"],
                "gate": event["gate"],
                "label": event["label"],
                "features": {
                    "scorePreviousInterval": float(previous_interval),
                    "scoreNextInterval": float(next_interval),
                    "segmentEdgeStatus": float(
                        index < 2 or index + 2 >= len(positions)
                    ),
                },
            })
    return rows


def audit_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_split = {}
    detected = []
    for split in ("calibration", "fresh-blind"):
        by_split[split] = {}
        for gate in segment.GATES:
            gate_rows = [
                row for row in rows
                if row["split"] == split and row["gate"] == gate
            ]
            result = failure_audit.nested_univariate_loro(
                gate_rows,
                allowed_features={
                    "scorePreviousInterval",
                    "scoreNextInterval",
                    "segmentEdgeStatus",
                },
                method="nested-score-context-only-rule-leave-one-recording-out",
            )
            confounded = result["candidateReadyForNewFreshBlind"]
            by_split[split][gate] = {
                "rows": len(gate_rows),
                "scoreContextOnlyRule": result,
                "confounded": confounded,
            }
            if confounded:
                detected.append(f"{split}:{gate}")
    return {
        "bySplit": by_split,
        "confoundedSplitGates": detected,
        "readyForRecording": not detected,
    }


def run(manifest_path: Path, truth_path: Path, out_path: Path) -> dict[str, Any]:
    result = audit_rows(score_context_rows(manifest_path, truth_path))
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "evidenceRole": "pre-recording-position-balance-only",
        "sourceHashes": {
            "manifestSha256": sha256(manifest_path),
            "truthSha256": sha256(truth_path),
        },
        **result,
        "requiredBalanceDimensions": [
            "scorePreviousInterval",
            "scoreNextInterval",
            "segmentEdgeStatus",
        ],
        "audioRead": False,
        "promotionEvidenceEligible": False,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "blockingReasons": [
            f"round5-position-score-context-confounded:{item}"
            for item in result["confoundedSplitGates"]
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--truth", type=Path, default=TRUTH)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    report = run(args.manifest, args.truth, args.out)
    print(json.dumps({
        "contract": report["contract"],
        "readyForRecording": report["readyForRecording"],
        "confoundedSplitGates": report["confoundedSplitGates"],
        "audioRead": report["audioRead"],
        "blockingReasons": report["blockingReasons"],
        "out": args.out.relative_to(REPO).as_posix(),
    }, ensure_ascii=False, indent=2))
    return int(args.require_ready and not report["readyForRecording"])


if __name__ == "__main__":
    raise SystemExit(main())
