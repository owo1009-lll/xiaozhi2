from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_gate_pilot import (  # noqa: E402
    detect_violin_activity_start,
    load_or_extract_f0,
)


DEFAULT_MANIFEST = REPO_ROOT / "data" / "experiments" / "western-strings-m2" / "real-student-recordings-manifest.csv"
DEFAULT_BASIC_PITCH = REPO_ROOT / "data" / "experiments" / "western-strings-m2" / "results-review-pack" / "cache" / "basic-pitch"
DEFAULT_CACHE = REPO_ROOT / "data" / "experiments" / "western-strings-violin-activity-anchor-cache"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-violin-activity-anchor-regression.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-violin-activity-anchor-regression.md"
MAX_AGREEMENT_SECONDS = 0.300


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def sha1(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def first_basic_pitch_violin_event(path: Path) -> dict[str, Any] | None:
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    candidates = []
    for row in rows if isinstance(rows, list) else []:
        try:
            start = float(row.get("start"))
            midi = float(row.get("midi"))
            confidence = float(row.get("confidence") or 0.0)
        except (TypeError, ValueError):
            continue
        if 54.5 <= midi <= 105.0 and start >= 0.0:
            candidates.append({"start": start, "midi": midi, "confidence": confidence})
    return min(candidates, key=lambda item: item["start"]) if candidates else None


def evaluate(
    manifest_path: Path,
    basic_pitch_dir: Path,
    cache_dir: Path,
) -> dict[str, Any]:
    manifest = read_csv_rows(manifest_path)
    rows = []
    scenario_counts: Counter[str] = Counter()
    scenario_agree: Counter[str] = Counter()
    blockers = []
    for source in manifest:
        recording_id = str(source.get("recordingId") or "").strip()
        scenario = str(source.get("scenario") or "unknown").strip()
        audio_path = (REPO_ROOT / str(source.get("audioPath") or "")).resolve()
        basic_pitch_path = basic_pitch_dir / f"{recording_id}.basic-pitch.json"
        row_blockers = []
        if not audio_path.is_file():
            row_blockers.append("audio-missing")
        basic_pitch = first_basic_pitch_violin_event(basic_pitch_path)
        if basic_pitch is None:
            row_blockers.append("basic-pitch-first-event-missing")
        activity_start = None
        if audio_path.is_file():
            times, midi_track, _ = load_or_extract_f0(audio_path, cache_dir, sha1(audio_path))
            activity_start = detect_violin_activity_start(times, midi_track)
            if activity_start is None:
                row_blockers.append("pyin-violin-activity-start-missing")
        agreement_error = (
            abs(float(activity_start) - float(basic_pitch["start"]))
            if activity_start is not None and basic_pitch is not None
            else None
        )
        agrees = agreement_error is not None and agreement_error <= MAX_AGREEMENT_SECONDS
        scenario_counts[scenario] += 1
        if agrees:
            scenario_agree[scenario] += 1
        blockers.extend(row_blockers)
        rows.append(
            {
                "recordingId": recording_id,
                "scenario": scenario,
                "audioPath": str(audio_path.relative_to(REPO_ROOT)).replace("\\", "/") if audio_path.is_file() else str(audio_path),
                "pyinActivityStartSeconds": round(float(activity_start), 6) if activity_start is not None else None,
                "basicPitchFirstEventSeconds": round(float(basic_pitch["start"]), 6) if basic_pitch is not None else None,
                "basicPitchFirstEventMidi": basic_pitch.get("midi") if basic_pitch is not None else None,
                "agreementErrorSeconds": round(float(agreement_error), 6) if agreement_error is not None else None,
                "agreesWithin300ms": agrees,
                "blockingReasons": row_blockers,
            }
        )
    comparable = [row for row in rows if row["agreementErrorSeconds"] is not None]
    agreed = [row for row in comparable if row["agreesWithin300ms"]]
    scenario_metrics = {
        scenario: {
            "rows": count,
            "agreed": scenario_agree[scenario],
            "agreementRate": scenario_agree[scenario] / count if count else 0.0,
        }
        for scenario, count in sorted(scenario_counts.items())
    }
    agreement_rate = len(agreed) / len(comparable) if comparable else 0.0
    ready = (
        len(comparable) == len(manifest)
        and agreement_rate >= 0.90
        and all(metric["agreed"] >= 1 for metric in scenario_metrics.values())
    )
    return {
        "ok": True,
        "evidenceType": "machine-machine-student-domain-non-regression-precheck",
        "counts": {
            "manifestRows": len(manifest),
            "comparableRows": len(comparable),
            "agreedWithin300ms": len(agreed),
            "disagreed": len(comparable) - len(agreed),
        },
        "agreementRate": agreement_rate,
        "scenarioMetrics": scenario_metrics,
        "readyForControlledFeatureFlag": ready,
        "releaseEligible": False,
        "caveat": "This compares two independent machine estimators; it is not human onset gold and cannot open the default runtime.",
        "blockingReasons": sorted(set(blockers)) if blockers else ([] if ready else ["activity-anchor-machine-agreement-below-gate"]),
        "rows": rows,
    }


def render_markdown(report: dict[str, Any]) -> str:
    counts = report.get("counts") or {}
    return "\n".join(
        [
            "# Violin Activity Anchor Student-Domain Regression",
            "",
            f"- manifest rows: {counts.get('manifestRows', 0)}",
            f"- comparable rows: {counts.get('comparableRows', 0)}",
            f"- agreed within 300 ms: {counts.get('agreedWithin300ms', 0)}",
            f"- agreement rate: {report.get('agreementRate')}",
            f"- readyForControlledFeatureFlag: {str(report.get('readyForControlledFeatureFlag', False)).lower()}",
            f"- releaseEligible: false",
            "",
            "This is a machine-machine non-regression precheck, not human onset gold. Default runtime stays off.",
            "",
            "| Recording | Scenario | pYIN start | Basic Pitch start | Error | <=300ms |",
            "|---|---|---:|---:|---:|---:|",
            *[
                f"| {row['recordingId']} | {row['scenario']} | {row['pyinActivityStartSeconds']} | {row['basicPitchFirstEventSeconds']} | {row['agreementErrorSeconds']} | {row['agreesWithin300ms']} |"
                for row in report.get("rows", [])
            ],
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cross-check a pYIN violin-activity start anchor against cached Basic Pitch events.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--basic-pitch-dir", default=str(DEFAULT_BASIC_PITCH))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = evaluate(Path(args.manifest).resolve(), Path(args.basic_pitch_dir).resolve(), Path(args.cache_dir).resolve())
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in ("ok", "evidenceType", "counts", "agreementRate", "scenarioMetrics", "readyForControlledFeatureFlag", "releaseEligible", "caveat", "blockingReasons")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
