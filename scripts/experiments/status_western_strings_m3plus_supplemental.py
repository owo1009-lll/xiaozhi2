#!/usr/bin/env python3
"""Audit the M3+ supplemental recording package without modifying inputs."""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = REPO / "音频" / "m3plus-supplemental"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m3plus" / "supplemental-intake-status.json"


def probe_duration(path: Path) -> tuple[float | None, str]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(path),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None, (result.stderr or "ffprobe-failed").strip()[:160]
    try:
        return float(result.stdout.strip()), ""
    except ValueError:
        return None, "duration-not-numeric"


def audit(source: Path) -> dict[str, Any]:
    manifest_path = source / "manifest-template.csv"
    rows: list[dict[str, str]] = []
    if manifest_path.exists():
        with manifest_path.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
    recordings: list[dict[str, Any]] = []
    blockers: list[str] = []
    for row in rows:
        recording_id = str(row.get("recordingId") or "").strip()
        audio_path = source / str(row.get("audioFile") or "")
        score_path = source / str(row.get("scoreFile") or "")
        page_names = [item for item in str(row.get("scorePages") or "").split("|") if item]
        page_paths = [source / item for item in page_names]
        item_blockers: list[str] = []
        duration: float | None = None
        if not score_path.is_file():
            item_blockers.append("score-missing")
        if not page_paths or any(not path.is_file() for path in page_paths):
            item_blockers.append("score-page-missing")
        if not audio_path.is_file():
            item_blockers.append("audio-missing")
        else:
            duration, probe_error = probe_duration(audio_path)
            if duration is None:
                item_blockers.append(f"audio-decode-failed:{probe_error}")
            elif duration < 10.0:
                item_blockers.append("audio-too-short")
        blockers.extend(f"{recording_id}:{reason}" for reason in item_blockers)
        recordings.append(
            {
                "recordingId": recording_id,
                "audio": str(audio_path),
                "score": str(score_path),
                "scorePages": [str(path) for path in page_paths],
                "durationSeconds": round(duration, 3) if duration is not None else None,
                "ready": not item_blockers,
                "blockingReasons": item_blockers,
            }
        )
    if not manifest_path.exists():
        blockers.append("manifest-missing")
    if len(rows) != 4:
        blockers.append(f"recording-row-count:{len(rows)}")
    ready_count = sum(bool(row["ready"]) for row in recordings)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": str(source),
        "recordingCount": len(recordings),
        "readyRecordingCount": ready_count,
        "missingRecordingCount": sum("audio-missing" in row["blockingReasons"] for row in recordings),
        "readyForMachineAnalysis": len(recordings) == 4 and ready_count == 4 and not blockers,
        "humanTask": "none" if len(recordings) == 4 and ready_count == 4 and not blockers else "record-m3plus-supplemental-takes",
        "blockingReasons": blockers,
        "recordings": recordings,
        "scoreIntent": str(source / "score-intent.json"),
        "instructions": str(source / "README-录音说明.md"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    report = audit(args.source.resolve())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                key: report[key]
                for key in [
                    "recordingCount",
                    "readyRecordingCount",
                    "missingRecordingCount",
                    "readyForMachineAnalysis",
                    "humanTask",
                    "blockingReasons",
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
