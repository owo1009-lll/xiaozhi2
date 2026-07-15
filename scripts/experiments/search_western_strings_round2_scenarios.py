from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from create_western_strings_m2f_results_review_pack import (  # noqa: E402
    align_score_to_events_dtw,
    load_basic_pitch_events,
    parse_score_notes,
)


DEFAULT_MANIFEST = REPO / "data" / "private" / "western-strings-round2" / "manifest.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-round2" / "scenario-search.json"
DEFAULT_CSV = REPO / "data" / "experiments" / "western-strings-round2" / "scenario-search-candidates.csv"
DEFAULT_MARKDOWN = REPO / "data" / "experiments" / "western-strings-round2" / "scenario-search.md"
TARGET_SCENARIOS = {"wrong_pitch", "missing_note", "rhythm_shift"}


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def exact_match(event: dict[str, Any] | None) -> bool:
    return bool(event is not None and int(event.get("pitchDiff", 999)) == 0)


def neighboring_exact_count(matched: list[dict[str, Any] | None], index: int, radius: int = 2) -> int:
    start = max(0, index - radius)
    stop = min(len(matched), index + radius + 1)
    return sum(1 for offset in range(start, stop) if offset != index and exact_match(matched[offset]))


def wrong_pitch_candidates(
    score_notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
) -> list[dict[str, Any]]:
    rows = []
    for index, (note, event) in enumerate(zip(score_notes, matched)):
        if event is None:
            continue
        pitch_diff = int(event.get("pitchDiff", 0))
        confidence = float(event.get("confidence", 0.0))
        neighbor_support = neighboring_exact_count(matched, index)
        if not (1 <= abs(pitch_diff) <= 2 and confidence >= 0.35 and neighbor_support >= 2):
            continue
        rows.append({
            "candidateType": "wrong_pitch",
            "noteIndex": int(note["noteIndex"]),
            "measureIndex": int(note["measure"]),
            "scoreMidi": int(note["midi"]),
            "observedMidi": int(event["midi"]),
            "predictedOnsetSeconds": round(float(event["start"]), 3),
            "pitchSemitoneError": pitch_diff,
            "neighborExactSupport": neighbor_support,
            "eventConfidence": round(confidence, 4),
            "anomalyScore": round(neighbor_support + abs(pitch_diff) + confidence, 4),
        })
    return sorted(rows, key=lambda row: (-row["anomalyScore"], row["noteIndex"]))


def missing_note_candidates(
    score_notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
) -> list[dict[str, Any]]:
    rows = []
    for index, (note, event) in enumerate(zip(score_notes, matched)):
        if event is not None:
            continue
        before = any(exact_match(matched[offset]) for offset in range(max(0, index - 3), index))
        after = any(exact_match(matched[offset]) for offset in range(index + 1, min(len(matched), index + 4)))
        neighbor_support = neighboring_exact_count(matched, index, radius=3)
        if not (before and after and neighbor_support >= 2):
            continue
        rows.append({
            "candidateType": "missing_note",
            "noteIndex": int(note["noteIndex"]),
            "measureIndex": int(note["measure"]),
            "scoreMidi": int(note["midi"]),
            "observedMidi": "",
            "predictedOnsetSeconds": "",
            "pitchSemitoneError": "",
            "neighborExactSupport": neighbor_support,
            "eventConfidence": "",
            "anomalyScore": float(neighbor_support),
        })
    return sorted(rows, key=lambda row: (-row["anomalyScore"], row["noteIndex"]))


def nearest_exact_index(
    matched: list[dict[str, Any] | None],
    index: int,
    direction: int,
    radius: int = 4,
) -> int | None:
    for distance in range(1, radius + 1):
        candidate = index + (direction * distance)
        if candidate < 0 or candidate >= len(matched):
            break
        if exact_match(matched[candidate]):
            return candidate
    return None


def rhythm_shift_candidates(
    score_notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
) -> list[dict[str, Any]]:
    rows = []
    for index, (note, event) in enumerate(zip(score_notes, matched)):
        if not exact_match(event):
            continue
        left = nearest_exact_index(matched, index, -1)
        right = nearest_exact_index(matched, index, 1)
        if left is None or right is None:
            continue
        left_score = float(score_notes[left]["scoreBeat"])
        current_score = float(note["scoreBeat"])
        right_score = float(score_notes[right]["scoreBeat"])
        if not (left_score < current_score < right_score):
            continue
        left_time = float(matched[left]["start"])
        current_time = float(event["start"])
        right_time = float(matched[right]["start"])
        score_span = right_score - left_score
        time_span = right_time - left_time
        if score_span <= 0 or time_span <= 0:
            continue
        expected_time = left_time + ((current_score - left_score) / score_span) * time_span
        residual_seconds = current_time - expected_time
        seconds_per_beat = time_span / score_span
        residual_beats = residual_seconds / seconds_per_beat if seconds_per_beat > 0 else 0.0
        if residual_beats < 0.5:
            continue
        rows.append({
            "candidateType": "rhythm_shift",
            "noteIndex": int(note["noteIndex"]),
            "measureIndex": int(note["measure"]),
            "scoreMidi": int(note["midi"]),
            "observedMidi": int(event["midi"]),
            "predictedOnsetSeconds": round(current_time, 3),
            "pitchSemitoneError": 0,
            "neighborExactSupport": 2,
            "eventConfidence": round(float(event.get("confidence", 0.0)), 4),
            "timingResidualSeconds": round(residual_seconds, 3),
            "timingResidualBeats": round(residual_beats, 3),
            "anomalyScore": round(residual_beats, 4),
        })
    return sorted(rows, key=lambda row: (-row["anomalyScore"], row["noteIndex"]))


def select_candidates(
    scenario: str,
    score_notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
) -> list[dict[str, Any]]:
    if scenario == "wrong_pitch":
        return wrong_pitch_candidates(score_notes, matched)
    if scenario == "missing_note":
        return missing_note_candidates(score_notes, matched)
    if scenario == "rhythm_shift":
        return rhythm_shift_candidates(score_notes, matched)
    return []


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "recordingId", "scenario", "rank", "selectedWithinExpectedQuota", "candidateType",
        "noteIndex", "measureIndex", "scoreMidi", "observedMidi", "predictedOnsetSeconds",
        "pitchSemitoneError", "timingResidualSeconds", "timingResidualBeats",
        "neighborExactSupport", "eventConfidence", "anomalyScore",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# 第二轮错误场景自动搜索",
        "",
        "README 只提供错误类型和数量(5/5/4),未提供具体小节。以下位置是机器假设,不是人工 gold,不得据此计算 recall/precision。",
        "",
        "| 录音 | 场景 | README 目标数 | 阈值候选数 | 前 N 个预测小节 |",
        "|---|---|---:|---:|---|",
    ]
    for item in report["items"]:
        measures = ", ".join(str(row["measureIndex"]) for row in item["selectedCandidates"]) or "none"
        lines.append(
            f"| {item['recordingId']} | {item['scenario']} | {item['expectedIssueCount']} | "
            f"{item['thresholdCandidateCount']} | {measures} |"
        )
    lines.extend([
        "",
        "## 口径",
        "",
        "- wrong_pitch: Basic Pitch 事件与谱音相差 1-2 个半音,且邻近至少两个音精确匹配。",
        "- missing_note: 序列 DTW 未匹配该谱音,且前后邻音均有精确支持。",
        "- rhythm_shift: 当前音相对前后精确匹配锚点的局部插值晚至少 0.5 拍。",
        "- `selectedWithinExpectedQuota=true` 只表示按 README 数量取前 N 个,不表示已由教师确认。",
        "",
    ])
    return "\n".join(lines)


def run(manifest_path: Path, out_path: Path, csv_path: Path, markdown_path: Path) -> dict[str, Any]:
    rows = [row for row in read_manifest(manifest_path) if row.get("scenario") in TARGET_SCENARIOS]
    cache_root = out_path.parent / "basic-pitch-cache"
    report_items = []
    flat_rows = []
    for row in rows:
        recording_id = str(row.get("recordingId") or "").strip()
        score_path = REPO / str(row.get("scorePath") or "")
        audio_path = REPO / str(row.get("audioPath") or "")
        expected_count = int(row.get("expectedIssueCount") or 0)
        score_notes = parse_score_notes(score_path)
        events = load_basic_pitch_events(audio_path, cache_root / f"{recording_id}.basic-pitch.json")
        matched = align_score_to_events_dtw(score_notes, events)
        candidates = select_candidates(str(row["scenario"]), score_notes, matched)
        selected = candidates[:expected_count]
        for rank, candidate in enumerate(candidates, start=1):
            flat_rows.append({
                "recordingId": recording_id,
                "scenario": row["scenario"],
                "rank": rank,
                "selectedWithinExpectedQuota": rank <= expected_count,
                **candidate,
            })
        report_items.append({
            "recordingId": recording_id,
            "scenario": row["scenario"],
            "expectedIssueCount": expected_count,
            "scoreNoteCount": len(score_notes),
            "basicPitchEventCount": len(events),
            "matchedScoreNoteCount": sum(event is not None for event in matched),
            "thresholdCandidateCount": len(candidates),
            "selectedCandidates": selected,
            "status": "machine-hypothesis-unverified",
        })
    report = {
        "ok": True,
        "evaluationLevel": "scenario-count-plus-machine-location-hypothesis",
        "exactLocationGoldAvailable": False,
        "exactRecallPrecisionAvailable": False,
        "sourceManifest": str(manifest_path.relative_to(REPO)).replace("\\", "/"),
        "items": report_items,
        "artifacts": {
            "json": str(out_path.relative_to(REPO)).replace("\\", "/"),
            "csv": str(csv_path.relative_to(REPO)).replace("\\", "/"),
            "markdown": str(markdown_path.relative_to(REPO)).replace("\\", "/"),
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(csv_path, flat_rows)
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Search round-2 README-count scenarios for likely note locations.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--markdown", type=Path, default=DEFAULT_MARKDOWN)
    args = parser.parse_args()
    report = run(args.manifest.resolve(), args.out.resolve(), args.csv.resolve(), args.markdown.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    raise SystemExit(main())
