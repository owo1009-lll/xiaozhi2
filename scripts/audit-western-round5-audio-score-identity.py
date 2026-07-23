#!/usr/bin/env python3
"""Audit Round 5 audio-to-score identity without reading diagnosis labels.

The audit compares the pitch-event sequence extracted from every recording
with every frozen MusicXML score.  It is deliberately independent of
position-truth.json and of all gate outcomes, so it can detect an intake
swap without selecting the mapping that happens to score better downstream.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment

REPO = Path(__file__).resolve().parents[1]
EXPERIMENTS = REPO / "scripts" / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_bach_violin_basic_pitch_transcription import filter_events  # noqa: E402
from eval_western_strings_injected_errors_dynamic_gate import (  # noqa: E402
    EVENT_FILTER,
    score_notes,
)

ROUND5 = REPO / "data" / "private" / "western-strings-round5"
MANIFEST = ROUND5 / "manifest.csv"
RUNNER_CACHE = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-injected-errors"
    / "dynamic-gate-preexam"
    / "basic-pitch-cache"
)
OUT_DIR = REPO / "data" / "experiments" / "western-strings-round5-audio-score-identity"
REPORT = OUT_DIR / "report.json"
GAP_SCORE_COST = 1.35
GAP_EVENT_COST = 0.75


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def substitution_cost(score_midi: int, event_midi: int) -> float:
    distance = abs(score_midi - event_midi)
    if distance == 0:
        return 0.0
    if distance == 1:
        return 0.85
    if distance == 2:
        return 1.35
    return min(4.0, 2.2 + distance * 0.18)


def alignment_metrics(score_midis: list[int], event_midis: list[int]) -> dict:
    """Return a global, gap-aware pitch-sequence distance and match counts."""
    n, m = len(score_midis), len(event_midis)
    costs = np.zeros((n + 1, m + 1), dtype=np.float64)
    back = np.zeros((n + 1, m + 1), dtype=np.uint8)
    costs[:, 0] = np.arange(n + 1) * GAP_SCORE_COST
    costs[0, :] = np.arange(m + 1) * GAP_EVENT_COST
    back[1:, 0] = 2
    back[0, 1:] = 3

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            candidates = (
                costs[i - 1, j - 1] + substitution_cost(score_midis[i - 1], event_midis[j - 1]),
                costs[i - 1, j] + GAP_SCORE_COST,
                costs[i, j - 1] + GAP_EVENT_COST,
            )
            action = min(range(3), key=candidates.__getitem__)
            costs[i, j] = candidates[action]
            back[i, j] = action + 1

    exact = 0
    within_one = 0
    paired = 0
    i, j = n, m
    while i > 0 or j > 0:
        action = int(back[i, j])
        if action == 1:
            distance = abs(score_midis[i - 1] - event_midis[j - 1])
            exact += int(distance == 0)
            within_one += int(distance <= 1)
            paired += 1
            i -= 1
            j -= 1
        elif action == 2:
            i -= 1
        elif action == 3:
            j -= 1
        else:
            raise RuntimeError(f"invalid alignment backtrace at {i},{j}")

    normalizer = max(1, n + m)
    return {
        "normalizedCost": round(float(costs[n, m]) / normalizer, 6),
        "rawCost": round(float(costs[n, m]), 6),
        "scoreNotes": n,
        "audioEvents": m,
        "paired": paired,
        "exactPitchMatches": exact,
        "withinOneSemitoneMatches": within_one,
        "exactScoreCoverage": round(exact / max(1, n), 6),
    }


def read_manifest() -> list[dict]:
    with MANIFEST.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != 12:
        raise SystemExit(f"expected 12 manifest rows, got {len(rows)}")
    return rows


def read_cached_events(audio: Path) -> tuple[list[dict], Path]:
    cache = RUNNER_CACHE / f"{audio.stem}.basic-pitch.json"
    if not cache.exists():
        raise SystemExit(f"missing frozen-runner Basic Pitch cache: {cache}")
    if cache.stat().st_mtime_ns < audio.stat().st_mtime_ns:
        raise SystemExit(f"stale frozen-runner Basic Pitch cache: {cache}")
    events = json.loads(cache.read_text(encoding="utf-8"))
    filtered = filter_events(
        events,
        EVENT_FILTER["minConfidence"],
        EVENT_FILTER["minDurationSeconds"],
    )
    return filtered, cache


def counterpart(recording_id: str) -> str:
    if "-cal-" in recording_id:
        return recording_id.replace("-cal-", "-fresh-")
    if "-fresh-" in recording_id:
        return recording_id.replace("-fresh-", "-cal-")
    return recording_id


def source_by_hash(audio_hash: str) -> str | None:
    source_dirs = (ROUND5 / "r5 call", ROUND5 / "r5 fresh")
    for directory in source_dirs:
        if not directory.exists():
            continue
        for candidate in sorted(directory.glob("*.m4a")):
            if sha256(candidate) == audio_hash:
                return candidate.relative_to(REPO).as_posix()
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=REPORT)
    args = parser.parse_args()

    rows = read_manifest()
    recordings = []
    scores = []
    for row in rows:
        recording_id = row["recordingId"]
        audio = REPO / row["audioPath"]
        score = REPO / row["scorePath"]
        if not audio.exists() or not score.exists():
            raise SystemExit(f"missing input for {recording_id}")
        audio_hash = sha256(audio)
        events, cache = read_cached_events(audio)
        recordings.append(
            {
                "recordingId": recording_id,
                "audioPath": row["audioPath"],
                "audioSha256": audio_hash,
                "sourcePath": source_by_hash(audio_hash),
                "cachePath": cache.relative_to(REPO).as_posix(),
                "eventMidis": [int(event["midi"]) for event in events],
            }
        )
        scores.append(
            {
                "scoreId": recording_id,
                "scorePath": row["scorePath"],
                "scoreSha256": sha256(score),
                "scoreMidis": [int(note["midi"]) for note in score_notes(score)],
            }
        )

    matrix = np.zeros((len(recordings), len(scores)), dtype=np.float64)
    comparisons = []
    for i, recording in enumerate(recordings):
        row_results = []
        for j, score in enumerate(scores):
            metrics = alignment_metrics(score["scoreMidis"], recording["eventMidis"])
            matrix[i, j] = metrics["normalizedCost"]
            row_results.append({"scoreId": score["scoreId"], **metrics})
        row_results.sort(key=lambda item: (item["normalizedCost"], -item["exactScoreCoverage"]))
        margin = (
            row_results[1]["normalizedCost"] - row_results[0]["normalizedCost"]
            if len(row_results) > 1
            else math.inf
        )
        comparisons.append(
            {
                "recordingId": recording["recordingId"],
                "sourcePath": recording["sourcePath"],
                "bestScoreId": row_results[0]["scoreId"],
                "runnerUpScoreId": row_results[1]["scoreId"],
                "costMarginToRunnerUp": round(margin, 6),
                "expectedScoreRank": next(
                    index + 1
                    for index, result in enumerate(row_results)
                    if result["scoreId"] == recording["recordingId"]
                ),
                "candidates": row_results,
            }
        )

    audio_indices, score_indices = linear_sum_assignment(matrix)
    assignment = {
        recordings[int(i)]["recordingId"]: scores[int(j)]["scoreId"]
        for i, j in zip(audio_indices, score_indices)
    }
    expected = all(assignment[item["recordingId"]] == item["recordingId"] for item in recordings)
    reversed_by_split = all(
        assignment[item["recordingId"]] == counterpart(item["recordingId"])
        for item in recordings
    )
    if expected:
        verdict = "current-mapping-confirmed"
    elif reversed_by_split:
        verdict = "cal-fresh-reversed"
    else:
        verdict = "mixed-or-permuted"

    report = {
        "schemaVersion": "western-round5-audio-score-identity-v1",
        "method": {
            "labelIndependent": True,
            "truthLabelsRead": False,
            "gateOutcomesRead": False,
            "pitchExtractor": "frozen-runner-basic-pitch-cache",
            "cacheFreshnessChecked": True,
            "matching": "all-pairs global gap-aware pitch-sequence alignment plus Hungarian assignment",
        },
        "verdict": verdict,
        "currentMappingConfirmed": expected,
        "calFreshReversed": reversed_by_split,
        "globalAssignment": assignment,
        "recordings": [
            {
                key: value
                for key, value in recording.items()
                if key != "eventMidis"
            }
            for recording in recordings
        ],
        "scores": [
            {key: value for key, value in score.items() if key != "scoreMidis"}
            for score in scores
        ],
        "comparisons": comparisons,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(
        {
            "verdict": verdict,
            "currentMappingConfirmed": expected,
            "calFreshReversed": reversed_by_split,
            "globalAssignment": assignment,
            "bestMatches": [
                {
                    "recordingId": item["recordingId"],
                    "sourcePath": item["sourcePath"],
                    "bestScoreId": item["bestScoreId"],
                    "costMarginToRunnerUp": item["costMarginToRunnerUp"],
                    "expectedScoreRank": item["expectedScoreRank"],
                }
                for item in comparisons
            ],
            "report": args.out.relative_to(REPO).as_posix(),
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
