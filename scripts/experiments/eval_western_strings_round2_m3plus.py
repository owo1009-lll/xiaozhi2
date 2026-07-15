from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np


REPO = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from create_western_strings_m2f_results_review_pack import (  # noqa: E402
    align_score_to_events_dtw,
    load_basic_pitch_events,
    parse_score_notes,
)
from eval_western_strings_m3plus_pitch_modes import (  # noqa: E402
    analyze_pitch_window,
    collect_score_notes,
    extract_f0,
    load_score_store,
)


DEFAULT_MANIFEST = REPO / "data" / "private" / "western-strings-round2" / "manifest.csv"
DEFAULT_HUMAN_GOLD = REPO / "docs" / "western-strings-round2-m3plus-human-gold.json"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-round2" / "m3plus-aligned-eval.json"
SCENARIOS = {"slide", "trill_vibrato", "double_stop"}
RELEASE_RATE = 0.9


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.DictReader(handle) if row.get("scenario") in SCENARIOS]


def read_human_gold(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        str(row.get("recordingId") or ""): row
        for row in payload.get("recordings", [])
        if row.get("recordingId")
    }


def exact_match(event: dict[str, Any] | None) -> bool:
    return bool(event is not None and int(event.get("pitchDiff", 999)) == 0)


def score_groups(notes: list[dict[str, Any]]) -> list[list[int]]:
    groups: dict[tuple[int, float], list[int]] = defaultdict(list)
    for index, note in enumerate(notes):
        groups[(int(note.get("measureIndex") or 0), round(float(note.get("beatStart") or 0.0), 3))].append(index)
    return list(groups.values())


def slide_pair_detected(
    first: dict[str, Any],
    second: dict[str, Any],
    first_event: dict[str, Any] | None,
    second_event: dict[str, Any] | None,
    times: np.ndarray,
    midi_track: np.ndarray,
) -> tuple[bool, int]:
    if not first_event or not second_event:
        return False, 0
    first_midi = int(first["midi"])
    second_midi = int(second["midi"])
    if first_midi == second_midi:
        return False, 0
    second_onset = float(second_event["start"])
    start = max(float(first_event["start"]), second_onset - 0.8)
    end = min(float(second_event["end"]), second_onset + 0.35)
    values = midi_track[(times >= start) & (times <= end)]
    values = values[np.isfinite(values)]
    lower = min(first_midi, second_midi)
    upper = max(first_midi, second_midi)
    interior_frames = int(np.sum((values > lower + 0.25) & (values < upper - 0.25)))
    return interior_frames >= 3, interior_frames


def evaluate_slide(
    notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
    times: np.ndarray,
    midi_track: np.ndarray,
) -> dict[str, Any]:
    by_measure: dict[int, list[int]] = defaultdict(list)
    for index, note in enumerate(notes):
        if "slur" in set(note.get("techniques") or []):
            by_measure[int(note.get("measureIndex") or 0)].append(index)
    pairs = [indices for indices in by_measure.values() if len(indices) == 2]
    rows = []
    for first_index, second_index in pairs:
        detected, interior_frames = slide_pair_detected(
            notes[first_index],
            notes[second_index],
            matched[first_index],
            matched[second_index],
            times,
            midi_track,
        )
        rows.append({
            "measureIndex": int(notes[first_index].get("measureIndex") or 0),
            "firstMidi": int(notes[first_index]["midi"]),
            "secondMidi": int(notes[second_index]["midi"]),
            "intermediateFrameCount": interior_frames,
            "detected": detected,
        })
    return {
        "expectedPairCount": len(rows),
        "detectedPairCount": sum(row["detected"] for row in rows),
        "detectionRate": round(sum(row["detected"] for row in rows) / len(rows), 6) if rows else None,
        "rows": rows,
    }


def evaluate_trill_vibrato(
    notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
    times: np.ndarray,
    midi_track: np.ndarray,
) -> dict[str, Any]:
    trill_rows = []
    vibrato_rows = []
    for index, note in enumerate(notes):
        event = matched[index]
        if event is None:
            continue
        next_start = next(
            (float(candidate["start"]) for candidate in matched[index + 1 :] if candidate is not None),
            float(event["end"]),
        )
        features = analyze_pitch_window(
            times=times,
            midi_track=midi_track,
            target_midi=int(note["midi"]),
            start_seconds=max(0.0, float(event["start"]) - 0.02),
            end_seconds=max(float(event["end"]), next_start - 0.02),
        )
        flags = set(features.get("flags") or [])
        row = {
            "measureIndex": int(note.get("measureIndex") or 0),
            "midi": int(note["midi"]),
            "flags": sorted(flags),
            "detected": False,
        }
        if "trill-mark" in set(note.get("techniques") or []):
            row["detected"] = "trill-like" in flags
            row["trillGapCentsApprox"] = features.get("trillGapCentsApprox")
            row["trillSwitchCountApprox"] = features.get("trillSwitchCountApprox")
            trill_rows.append(row)
        else:
            row["detected"] = "vibrato-like" in flags
            row["vibratoRateHzApprox"] = features.get("vibratoRateHzApprox")
            row["vibratoAmplitudeCentsApprox"] = features.get("vibratoAmplitudeCentsApprox")
            vibrato_rows.append(row)
    return {
        "trill": {
            "expectedNoteCount": len(trill_rows),
            "detectedNoteCount": sum(row["detected"] for row in trill_rows),
            "detectionRate": round(sum(row["detected"] for row in trill_rows) / len(trill_rows), 6) if trill_rows else None,
            "rows": trill_rows,
        },
        "vibrato": {
            "instructionExpectedLongNoteCount": len(vibrato_rows),
            "detectedNoteCount": sum(row["detected"] for row in vibrato_rows),
            "detectionRate": round(sum(row["detected"] for row in vibrato_rows) / len(vibrato_rows), 6) if vibrato_rows else None,
            "rows": vibrato_rows,
        },
    }


def evaluate_double_stop(
    notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
) -> dict[str, Any]:
    rows = []
    for group in score_groups(notes):
        if len(group) < 2:
            continue
        expected_pitches = sorted({int(notes[index]["midi"]) for index in group})
        if len(expected_pitches) < 2:
            continue
        exact_pitches = sorted({int(notes[index]["midi"]) for index in group if exact_match(matched[index])})
        rows.append({
            "measureIndex": int(notes[group[0]].get("measureIndex") or 0),
            "beatStart": float(notes[group[0]].get("beatStart") or 0.0),
            "expectedPitches": expected_pitches,
            "exactDetectedPitches": exact_pitches,
            "allPitchesDetected": exact_pitches == expected_pitches,
        })
    detected = sum(row["allPitchesDetected"] for row in rows)
    return {
        "expectedGroupCount": len(rows),
        "allPitchesDetectedGroupCount": detected,
        "groupRecall": round(detected / len(rows), 6) if rows else None,
        "rows": rows,
    }


def evaluate_recording(
    row: dict[str, str],
    store: dict[str, Any],
    cache_dir: Path,
    human_gold: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    recording_id = str(row.get("recordingId") or "")
    score_path = REPO / str(row.get("scorePath") or "")
    audio_path = REPO / str(row.get("audioPath") or "")
    parsed_notes = parse_score_notes(score_path)
    score, notes = collect_score_notes(store, str(row.get("scoreId") or ""))
    if score is None or len(parsed_notes) != len(notes):
        return {
            "recordingId": recording_id,
            "scenario": row.get("scenario"),
            "ok": False,
            "reason": f"score-note-count-mismatch:{len(parsed_notes)}:{len(notes)}",
        }
    events = load_basic_pitch_events(audio_path, cache_dir / f"{recording_id}.json")
    matched = align_score_to_events_dtw(parsed_notes, events)
    times, midi_track, _ = extract_f0(audio_path)
    base = {
        "recordingId": recording_id,
        "scenario": row.get("scenario"),
        "ok": True,
        "scoreNoteCount": len(notes),
        "basicPitchEventCount": len(events),
        "matchedNoteCount": sum(event is not None for event in matched),
        "exactPitchMatchedNoteCount": sum(exact_match(event) for event in matched),
        "alignmentMethod": "basic-pitch-sequence-dtw",
        "humanGold": human_gold.get(recording_id),
    }
    scenario = str(row.get("scenario") or "")
    if scenario == "slide":
        base["modeEvidence"] = evaluate_slide(notes, matched, times, midi_track)
    elif scenario == "trill_vibrato":
        base["modeEvidence"] = evaluate_trill_vibrato(notes, matched, times, midi_track)
    elif scenario == "double_stop":
        base["modeEvidence"] = evaluate_double_stop(notes, matched)
    return base


def render_markdown(report: dict[str, Any]) -> str:
    by_scenario = {item["scenario"]: item for item in report["items"]}
    slide = (by_scenario.get("slide") or {}).get("modeEvidence") or {}
    trill_vibrato = (by_scenario.get("trill_vibrato") or {}).get("modeEvidence") or {}
    double_stop = (by_scenario.get("double_stop") or {}).get("modeEvidence") or {}
    return "\n".join([
        "# 第二轮 M3+ 谱面标记对齐评测",
        "",
        "本报告用 Basic Pitch 序列对齐替代旧线性时间窗。r2-06 的颤音和揉弦执行已由项目负责人确认；"
        "其他模式仍缺独立负例，因此本报告仍不是 release gold。",
        "",
        "| 模式 | 机器检测 | 结果 |",
        "|---|---:|---|",
        f"| 滑音连接 | {slide.get('detectedPairCount', 0)}/{slide.get('expectedPairCount', 0)} | {'通过' if (slide.get('detectionRate') or 0) >= RELEASE_RATE else '未达 90%'} |",
        f"| 颤音标记 | {(trill_vibrato.get('trill') or {}).get('detectedNoteCount', 0)}/{(trill_vibrato.get('trill') or {}).get('expectedNoteCount', 0)} | {'通过' if ((trill_vibrato.get('trill') or {}).get('detectionRate') or 0) >= RELEASE_RATE else '未达 90%'} |",
        f"| 揉弦长音 | {(trill_vibrato.get('vibrato') or {}).get('detectedNoteCount', 0)}/{(trill_vibrato.get('vibrato') or {}).get('instructionExpectedLongNoteCount', 0)} | {'通过' if ((trill_vibrato.get('vibrato') or {}).get('detectionRate') or 0) >= RELEASE_RATE else '未达 90%'} |",
        f"| 双音两声部 | {double_stop.get('allPitchesDetectedGroupCount', 0)}/{double_stop.get('expectedGroupCount', 0)} | {'通过' if (double_stop.get('groupRecall') or 0) >= RELEASE_RATE else '未达 90%'} |",
        "",
        "- 当前没有独立负例,不能据此计算 precision 或开放学生端。",
        "- 装饰音(非 trill)和泛音没有第二轮真实样本,继续 review-only。",
        "- 所有未达标模式保持 fail-closed。",
        "",
    ])


def build_report(items: list[dict[str, Any]]) -> dict[str, Any]:
    by_scenario = {item.get("scenario"): item for item in items if item.get("ok") is True}
    slide = (by_scenario.get("slide") or {}).get("modeEvidence") or {}
    trill_vibrato = (by_scenario.get("trill_vibrato") or {}).get("modeEvidence") or {}
    double_stop = (by_scenario.get("double_stop") or {}).get("modeEvidence") or {}
    rates = {
        "slide": slide.get("detectionRate"),
        "trill": (trill_vibrato.get("trill") or {}).get("detectionRate"),
        "vibrato": (trill_vibrato.get("vibrato") or {}).get("detectionRate"),
        "doubleStop": double_stop.get("groupRecall"),
    }
    threshold_checks = {
        name: bool(value is not None and float(value) >= RELEASE_RATE)
        for name, value in rates.items()
    }
    trill_gold = (by_scenario.get("trill_vibrato") or {}).get("humanGold") or {}
    performance_gold_ready = bool(trill_gold.get("performanceExecutionVerified") is True)
    blocking_reasons = [
        "m3plus-round2-negative-controls-missing",
        "m3plus-ornament-real-sample-missing",
        "m3plus-harmonic-real-sample-missing",
    ]
    if not performance_gold_ready:
        blocking_reasons.append("m3plus-round2-performance-execution-not-human-verified")
    if not all(threshold_checks.values()):
        blocking_reasons.append("m3plus-round2-mode-detection-below-90-percent")
    return {
        "ok": all(item.get("ok") is True for item in items),
        "evaluationLevel": "human-confirmed-trill-vibrato-aligned-machine-pilot",
        "humanVerifiedPerformanceGold": performance_gold_ready,
        "negativeControlAvailable": False,
        "releaseThreshold": RELEASE_RATE,
        "thresholdChecks": threshold_checks,
        "machineThresholdPassed": all(threshold_checks.values()),
        "studentGateReady": False,
        "releaseEvidenceReady": False,
        "alignmentMethod": "basic-pitch-sequence-dtw",
        "items": items,
        "blockingReasons": blocking_reasons,
    }


def run(manifest_path: Path, human_gold_path: Path, out_path: Path) -> dict[str, Any]:
    cache_dir = out_path.parent / "m3plus-basic-pitch-cache"
    store = load_score_store(REPO)
    human_gold = read_human_gold(human_gold_path)
    items = [evaluate_recording(row, store, cache_dir, human_gold) for row in read_manifest(manifest_path)]
    report = build_report(items)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out_path.with_suffix(".md").write_text(render_markdown(report), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate round-2 M3+ score-marked recordings with aligned audio windows.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--human-gold", type=Path, default=DEFAULT_HUMAN_GOLD)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    report = run(args.manifest.resolve(), args.human_gold.resolve(), args.out.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    os.environ.setdefault("MKL_NUM_THREADS", "2")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    raise SystemExit(main())
