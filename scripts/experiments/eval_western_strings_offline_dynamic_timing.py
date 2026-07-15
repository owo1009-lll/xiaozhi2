#!/usr/bin/env python3
"""Audit dynamic score-to-audio timing on the 12 controlled recordings.

The manifest only supplies recording-level scenarios, not note-level error
locations. This script therefore reports candidate evidence and conflicts but
never converts them into precision/recall or a student release decision.
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from run_western_strings_offline_feature_analysis import (
    assign_basic_pitch_events,
    build_decisions,
    build_symbolic_timeline,
    collect_score_notes,
    extract_f0,
    load_store,
    read_basic_pitch_events,
    summarize,
)


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO / "data/experiments/western-strings-m2/real-student-recordings-manifest.csv"
DEFAULT_EVENTS = REPO / "data/experiments/western-strings-m2/results-review-pack/cache/basic-pitch"
DEFAULT_OUT = REPO / "data/experiments/western-strings-m3/offline-dynamic-timing-audit"


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def issue_counts(decisions: list[dict[str, Any]]) -> dict[str, int]:
    unassigned = 0
    event_pitch_conflict = 0
    stable_f0_conflict = 0
    for decision in decisions:
        evidence = decision.get("evidence") or {}
        if not evidence.get("timingAssignmentAvailable"):
            unassigned += 1
            continue
        if evidence.get("basicPitchPitchDistanceSemitones") != 0:
            event_pitch_conflict += 1
        elif not evidence.get("pitchSupportWithin80Cents"):
            stable_f0_conflict += 1
    return {
        "unassignedNoteCount": unassigned,
        "eventPitchConflictCount": event_pitch_conflict,
        "stableF0ConflictCount": stable_f0_conflict,
        "totalReviewEvidenceCount": unassigned + event_pitch_conflict + stable_f0_conflict,
    }


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    note_count = sum(int(row["noteCount"]) for row in rows)
    assigned = sum(int(row["timingAssignmentCount"]) for row in rows)
    supported = sum(int(row["pitchSupportWithin80CentsCount"]) for row in rows)
    conflicts = sum(int(row["totalReviewEvidenceCount"]) for row in rows)
    medians = [float(row["medianAbsCents"]) for row in rows if row.get("medianAbsCents") is not None]
    return {
        "recordingCount": len(rows),
        "noteCount": note_count,
        "timingAssignmentCount": assigned,
        "timingAssignmentRate": round(assigned / note_count, 6) if note_count else 0.0,
        "pitchSupportWithin80CentsCount": supported,
        "pitchSupportRate": round(supported / note_count, 6) if note_count else 0.0,
        "totalReviewEvidenceCount": conflicts,
        "medianOfRecordingMedianAbsCents": round(statistics.median(medians), 3) if medians else None,
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Ordinary-upload dynamic timing audit",
        "",
        f"Generated: {report['createdAt']}",
        "",
        "This is a machine-only evidence audit. Scenario labels are recording-level and cannot prove note-level precision.",
        "",
        "| recording | scenario | notes | assigned | pitch support | review evidence | median abs cents |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for row in report["rows"]:
        lines.append(
            f"| {row['recordingId']} | {row['scenario']} | {row['noteCount']} | "
            f"{row['timingAssignmentCount']} | {row['pitchSupportWithin80CentsCount']} | "
            f"{row['totalReviewEvidenceCount']} | {row.get('medianAbsCents', '')} |"
        )
    lines.extend([
        "",
        f"- aggregate assignment rate: {report['aggregate']['timingAssignmentRate']:.2%}",
        f"- aggregate pitch-support rate: {report['aggregate']['pitchSupportRate']:.2%}",
        f"- review-evidence count: {report['aggregate']['totalReviewEvidenceCount']}",
        "- studentGateReady: false",
        "- next gate: compare selected dynamic candidates with independent note-level truth; do not transfer labels from old linear windows.",
        "",
    ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--events-dir", default=str(DEFAULT_EVENTS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--recording-id", action="append", default=[])
    parser.add_argument("--max-recordings", type=int, default=0)
    args = parser.parse_args()

    requested = {value.strip() for value in args.recording_id if value.strip()}
    manifest_rows = read_manifest(Path(args.manifest))
    if requested:
        manifest_rows = [row for row in manifest_rows if row.get("recordingId") in requested]
    if args.max_recordings > 0:
        manifest_rows = manifest_rows[: args.max_recordings]
    store = load_store(REPO)
    rows: list[dict[str, Any]] = []
    by_scenario: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for index, source in enumerate(manifest_rows, start=1):
        recording_id = str(source.get("recordingId") or "").strip()
        score_id = str(source.get("scoreId") or "").strip()
        audio_path = REPO / str(source.get("audioPath") or "")
        events_path = Path(args.events_dir) / f"{recording_id}.basic-pitch.json"
        if not audio_path.is_file() or not events_path.is_file():
            raise FileNotFoundError(f"missing-input:{recording_id}:{audio_path}:{events_path}")
        score, notes = collect_score_notes(store, score_id)
        if not score or not notes:
            raise RuntimeError(f"score-not-found-or-empty:{score_id}")
        timeline = build_symbolic_timeline(notes)
        events = read_basic_pitch_events(events_path)
        assignments = assign_basic_pitch_events(timeline, events)
        times, midi_track, duration = extract_f0(audio_path)
        decisions = build_decisions(
            timeline,
            times,
            midi_track,
            duration,
            0,
            timing_assignments=assignments,
            analysis_mode="basic-pitch-dtw-pyin-review-v1",
        )
        summary = summarize(decisions, score, duration, len(timeline), "basic-pitch-dtw-pyin-review-v1")
        row = {
            "recordingId": recording_id,
            "scenario": str(source.get("scenario") or "unknown"),
            **summary,
            **issue_counts(decisions),
        }
        rows.append(row)
        by_scenario[row["scenario"]].append(row)
        print(json.dumps({"stage": "recording-complete", "index": index, "total": len(manifest_rows), "recordingId": recording_id}))

    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evaluationMode": "machine-only-recording-scenario-audit",
        "labelGranularity": "recording-level-only",
        "studentGateReady": False,
        "blockingReasons": ["independent-note-level-truth-not-evaluated"],
        "rows": rows,
        "aggregate": aggregate(rows),
        "byScenario": {scenario: aggregate(group) for scenario, group in sorted(by_scenario.items())},
    }
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "report.json"
    md_path = out_dir / "report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({"ok": True, "report": str(json_path), "aggregate": report["aggregate"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
