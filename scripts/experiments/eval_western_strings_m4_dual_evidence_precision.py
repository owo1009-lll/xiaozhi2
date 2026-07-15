#!/usr/bin/env python3
"""Measure OMR-and-audio green-note precision against independent clean scores.

This is an eval-only audit. It never changes the photo-score runtime policy.
Green rows are evaluated with three mappings: sequence alignment, strict
measure/ordinal mapping, and their conservative intersection.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))

from proto_western_strings_score_anchored_feedback import (  # noqa: E402
    DEFAULT_OUT as PROTOTYPE_OUT,
    OMR_ROOT,
    PRIVATE,
    REPO,
    align,
    audio_events,
    mxl_events,
    run_piece,
)


DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "dual-evidence-gold-audit"
)
DEFAULT_PIECES = [f"violin-ex{index:02d}" for index in range(1, 13)]
F0_PITCH_TOLERANCE_CENTS = 50.0
F0_MIN_VOICED_COVERAGE = 0.60
F0_MIN_EVENT_SECONDS = 0.12


def extract_pyin_track(audio_path: Path) -> tuple[Any, Any]:
    """Return frame times and continuous violin-range MIDI estimates."""

    import librosa
    import numpy as np

    waveform, sample_rate = librosa.load(str(audio_path), sr=22050, mono=True)
    hop_length = 256
    f0, voiced, _ = librosa.pyin(
        waveform,
        fmin=float(librosa.midi_to_hz(50)),
        fmax=float(librosa.midi_to_hz(105)),
        sr=sample_rate,
        frame_length=2048,
        hop_length=hop_length,
    )
    midi = np.full(len(f0), np.nan, dtype=np.float64)
    valid = np.asarray(voiced, dtype=bool) & np.isfinite(f0)
    midi[valid] = librosa.hz_to_midi(f0[valid])
    times = librosa.times_like(f0, sr=sample_rate, hop_length=hop_length)
    return np.asarray(times, dtype=np.float64), midi


def frame_pitch_confirmation(
    score_midis: list[int],
    audio_event: dict[str, Any],
    frame_times: Any,
    frame_midi: Any,
) -> dict[str, Any]:
    """Verify one discrete event with continuous F0, or fail closed."""

    import numpy as np

    if len(score_midis) != 1 or len(audio_event.get("midis") or []) != 1:
        return {"state": "uncertain", "reason": "polyphonic-event-unsupported"}
    start = float(audio_event.get("start") or 0.0)
    end = float(audio_event.get("end") or start)
    duration = end - start
    if duration < F0_MIN_EVENT_SECONDS:
        return {"state": "uncertain", "reason": "event-too-short"}
    trim = min(0.05, duration * 0.20)
    inner_start, inner_end = start + trim, end - trim
    frame_indexes = np.flatnonzero(
        (np.asarray(frame_times) >= inner_start) & (np.asarray(frame_times) <= inner_end)
    )
    if frame_indexes.size < 4:
        return {"state": "uncertain", "reason": "too-few-f0-frames"}
    values = np.asarray(frame_midi, dtype=np.float64)[frame_indexes]
    voiced_values = values[np.isfinite(values)]
    voiced_coverage = float(voiced_values.size / frame_indexes.size)
    if voiced_values.size < 4 or voiced_coverage < F0_MIN_VOICED_COVERAGE:
        return {
            "state": "uncertain",
            "reason": "low-f0-voiced-coverage",
            "voicedCoverage": round(voiced_coverage, 6),
        }
    median_midi = float(np.median(voiced_values))
    cents_error = 100.0 * (median_midi - float(score_midis[0]))
    state = "confirmed" if abs(cents_error) <= F0_PITCH_TOLERANCE_CENTS else "mismatch"
    return {
        "state": state,
        "reason": "continuous-f0-within-tolerance" if state == "confirmed" else "continuous-f0-pitch-mismatch",
        "medianMidi": round(median_midi, 6),
        "centsError": round(cents_error, 3),
        "voicedCoverage": round(voiced_coverage, 6),
        "frameCount": int(frame_indexes.size),
    }


def event_substitution_cost(gold: dict[str, Any], draft: dict[str, Any]) -> float:
    gold_pitches = set(int(value) for value in gold.get("midis") or [])
    draft_pitches = set(int(value) for value in draft.get("midis") or [])
    if gold_pitches == draft_pitches:
        return 0.0
    if not gold_pitches or not draft_pitches:
        return 1.5
    overlap = len(gold_pitches & draft_pitches)
    union = len(gold_pitches | draft_pitches)
    return 1.0 - overlap / max(1, union) + 0.5


def align_event_indexes(
    gold: list[dict[str, Any]], draft: list[dict[str, Any]]
) -> dict[int, int]:
    """Map draft event indexes to gold indexes with position-regularized NW."""

    rows, cols = len(gold) + 1, len(draft) + 1
    gap = 1.0
    scores = [[0.0] * cols for _ in range(rows)]
    moves = [[""] * cols for _ in range(rows)]
    for i in range(1, rows):
        scores[i][0] = i * gap
        moves[i][0] = "del"
    for j in range(1, cols):
        scores[0][j] = j * gap
        moves[0][j] = "ins"
    for i in range(1, rows):
        for j in range(1, cols):
            normalized_offset = abs(i / max(1, len(gold)) - j / max(1, len(draft)))
            substitution = (
                scores[i - 1][j - 1]
                + event_substitution_cost(gold[i - 1], draft[j - 1])
                + 0.20 * normalized_offset
            )
            deletion = scores[i - 1][j] + gap
            insertion = scores[i][j - 1] + gap
            choices = ((substitution, "sub"), (deletion, "del"), (insertion, "ins"))
            scores[i][j], moves[i][j] = min(choices, key=lambda item: item[0])
    mapping: dict[int, int] = {}
    i, j = len(gold), len(draft)
    while i > 0 or j > 0:
        move = moves[i][j]
        if move == "sub":
            mapping[j - 1] = i - 1
            i -= 1
            j -= 1
        elif move == "del":
            i -= 1
        elif move == "ins":
            j -= 1
        else:
            break
    return mapping


def measure_ordinal_map(events: list[dict[str, Any]]) -> dict[int, tuple[int, int]]:
    counters: dict[int, int] = defaultdict(int)
    result: dict[int, tuple[int, int]] = {}
    for index, event in enumerate(events):
        measure = int(event.get("measure") or 0)
        ordinal = counters[measure]
        counters[measure] += 1
        result[index] = (measure, ordinal)
    return result


def structural_gold_lookup(events: list[dict[str, Any]]) -> dict[tuple[int, int], int]:
    return {key: index for index, key in measure_ordinal_map(events).items()}


def wilson_lower_bound(correct: int, total: int, z: float = 1.96) -> float:
    if total <= 0:
        return 0.0
    proportion = correct / total
    denominator = 1.0 + z * z / total
    center = proportion + z * z / (2.0 * total)
    margin = z * math.sqrt(
        proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total)
    )
    return max(0.0, (center - margin) / denominator)


def locate_draft_mxl(piece: str, variant: str) -> Path:
    paths = sorted((OMR_ROOT / piece / variant / "omr").glob("*.mxl"))
    if not paths:
        raise FileNotFoundError(f"draft MXL missing for {piece}/{variant}")
    return paths[0]


def ensure_verdict(
    piece: str,
    variant: str,
    prototype_root: Path,
    *,
    generate_missing: bool,
    refresh: bool,
) -> Path:
    verdict_path = prototype_root / piece / f"{piece}-verdicts.json"
    if verdict_path.is_file() and not refresh:
        return verdict_path
    if not generate_missing:
        raise FileNotFoundError(f"verdict missing: {verdict_path}")
    result = run_piece(piece, variant, prototype_root)
    if result.get("status", "ok") != "ok" or not verdict_path.is_file():
        raise RuntimeError(f"prototype failed for {piece}: {result}")
    return verdict_path


def evaluate_piece(
    piece: str,
    variant: str,
    prototype_root: Path,
    *,
    generate_missing: bool,
    refresh: bool,
) -> dict[str, Any]:
    gold_path = PRIVATE / f"{piece}.mxl"
    draft_path = locate_draft_mxl(piece, variant)
    verdict_path = ensure_verdict(
        piece,
        variant,
        prototype_root,
        generate_missing=generate_missing,
        refresh=refresh,
    )
    gold = mxl_events(gold_path)
    draft = mxl_events(draft_path)
    verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
    per_note = list(verdict.get("perNote") or [])
    if len(per_note) != len(draft):
        raise ValueError(
            f"verdict/draft event mismatch for {piece}: {len(per_note)} != {len(draft)}"
        )

    sequence = align_event_indexes(gold, draft)
    audio_path = PRIVATE / f"{piece}.m4a"
    detected_audio = audio_events(audio_path)
    audio_match, _ = align(draft, detected_audio)
    frame_times, frame_midi = extract_pyin_track(audio_path)
    f0_evidence: dict[int, dict[str, Any]] = {}
    for draft_index, audio_index in enumerate(audio_match):
        if audio_index is None:
            f0_evidence[draft_index] = {"state": "uncertain", "reason": "no-audio-event"}
            continue
        f0_evidence[draft_index] = frame_pitch_confirmation(
            draft[draft_index]["midis"],
            detected_audio[audio_index],
            frame_times,
            frame_midi,
        )
    draft_keys = measure_ordinal_map(draft)
    structural = structural_gold_lookup(gold)
    green_rows = [row for row in per_note if row.get("verdict") == "confirmed"]
    all_draft_rows = []
    false_green_rows = []
    caught_wrong = 0
    escaped_wrong = 0
    sequence_correct = structural_correct = consensus_correct = 0
    sequence_count = structural_count = consensus_count = 0
    f0_consensus_correct = f0_consensus_count = 0

    for draft_index, draft_event in enumerate(draft):
        sequence_gold_index = sequence.get(draft_index)
        structural_gold_index = structural.get(draft_keys[draft_index])
        sequence_exact = bool(
            sequence_gold_index is not None
            and set(draft_event["midis"]) == set(gold[sequence_gold_index]["midis"])
        )
        consensus_gold_index = (
            sequence_gold_index
            if sequence_gold_index is not None and sequence_gold_index == structural_gold_index
            else None
        )
        consensus_exact = bool(
            consensus_gold_index is not None
            and set(draft_event["midis"]) == set(gold[consensus_gold_index]["midis"])
        )
        is_green = per_note[draft_index].get("verdict") == "confirmed"
        if sequence_gold_index is not None and not sequence_exact:
            if is_green:
                escaped_wrong += 1
            else:
                caught_wrong += 1
        all_draft_rows.append(
            {
                "draftIndex": draft_index,
                "verdict": per_note[draft_index].get("verdict"),
                "draftMeasure": draft_event.get("measure"),
                "draftMidis": draft_event.get("midis"),
                "sequenceGoldIndex": sequence_gold_index,
                "structuralGoldIndex": structural_gold_index,
                "consensusGoldIndex": consensus_gold_index,
                "sequenceExact": sequence_exact,
                "consensusExact": consensus_exact,
                "f0Evidence": f0_evidence[draft_index],
            }
        )

    for row in green_rows:
        draft_index = int(row["i"])
        draft_event = draft[draft_index]
        sequence_gold_index = sequence.get(draft_index)
        structural_gold_index = structural.get(draft_keys[draft_index])
        if sequence_gold_index is not None:
            sequence_count += 1
            exact = set(draft_event["midis"]) == set(gold[sequence_gold_index]["midis"])
            sequence_correct += int(exact)
            if not exact:
                false_green_rows.append(
                    {
                        "draftIndex": draft_index,
                        "draftMeasure": draft_event.get("measure"),
                        "draftMidis": draft_event.get("midis"),
                        "goldMeasure": gold[sequence_gold_index].get("measure"),
                        "goldMidis": gold[sequence_gold_index].get("midis"),
                    }
                )
        if structural_gold_index is not None:
            structural_count += 1
            structural_correct += int(
                set(draft_event["midis"]) == set(gold[structural_gold_index]["midis"])
            )
        if sequence_gold_index is not None and sequence_gold_index == structural_gold_index:
            consensus_count += 1
            consensus_exact = set(draft_event["midis"]) == set(gold[sequence_gold_index]["midis"])
            consensus_correct += int(consensus_exact)
            if f0_evidence[draft_index].get("state") == "confirmed":
                f0_consensus_count += 1
                f0_consensus_correct += int(consensus_exact)

    def metric(correct: int, total: int) -> dict[str, Any]:
        return {
            "correct": correct,
            "total": total,
            "precision": round(correct / total, 6) if total else None,
            "wilson95Lower": round(wilson_lower_bound(correct, total), 6),
        }

    return {
        "piece": piece,
        "goldEvents": len(gold),
        "draftEvents": len(draft),
        "greenEvents": len(green_rows),
        "pieceGate": verdict.get("pieceGate"),
        "sequence": metric(sequence_correct, sequence_count),
        "structural": metric(structural_correct, structural_count),
        "consensus": metric(consensus_correct, consensus_count),
        "f0Consensus": metric(f0_consensus_correct, f0_consensus_count),
        "consensusGoldCoverage": round(consensus_count / len(gold), 6) if gold else 0.0,
        "f0ConsensusGoldCoverage": round(f0_consensus_count / len(gold), 6) if gold else 0.0,
        "caughtOmrPitchErrors": caught_wrong,
        "escapedOmrPitchErrors": escaped_wrong,
        "falseGreenRows": false_green_rows,
        "rows": all_draft_rows,
        "goldPath": str(gold_path),
        "draftPath": str(draft_path),
        "verdictPath": str(verdict_path),
    }


def aggregate(piece_rows: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in ("sequence", "structural", "consensus", "f0Consensus"):
        correct = sum(int(row[name]["correct"]) for row in piece_rows)
        total = sum(int(row[name]["total"]) for row in piece_rows)
        result[name] = {
            "correct": correct,
            "total": total,
            "precision": round(correct / total, 6) if total else None,
            "wilson95Lower": round(wilson_lower_bound(correct, total), 6),
        }
    gold_events = sum(int(row["goldEvents"]) for row in piece_rows)
    consensus_total = int(result["consensus"]["total"])
    result["consensusGoldCoverage"] = (
        round(consensus_total / gold_events, 6) if gold_events else 0.0
    )
    result["f0ConsensusGoldCoverage"] = (
        round(int(result["f0Consensus"]["total"]) / gold_events, 6)
        if gold_events
        else 0.0
    )
    result["caughtOmrPitchErrors"] = sum(
        int(row["caughtOmrPitchErrors"]) for row in piece_rows
    )
    result["escapedOmrPitchErrors"] = sum(
        int(row["escapedOmrPitchErrors"]) for row in piece_rows
    )
    wrong_total = result["caughtOmrPitchErrors"] + result["escapedOmrPitchErrors"]
    result["omrPitchErrorCatchRate"] = (
        round(result["caughtOmrPitchErrors"] / wrong_total, 6) if wrong_total else None
    )
    per_piece_precisions = [
        float(row["consensus"]["precision"])
        for row in piece_rows
        if row["consensus"]["precision"] is not None
    ]
    result["minPieceConsensusPrecision"] = (
        round(min(per_piece_precisions), 6) if per_piece_precisions else None
    )
    per_piece_f0_precisions = [
        float(row["f0Consensus"]["precision"])
        for row in piece_rows
        if row["f0Consensus"]["precision"] is not None
    ]
    result["minPieceF0ConsensusPrecision"] = (
        round(min(per_piece_f0_precisions), 6) if per_piece_f0_precisions else None
    )
    result["evalOnlyGatePassed"] = bool(
        result["f0Consensus"]["total"] >= 100
        and result["f0Consensus"]["precision"] is not None
        and result["f0Consensus"]["precision"] >= 0.99
        and result["f0Consensus"]["wilson95Lower"] >= 0.95
        and result["minPieceF0ConsensusPrecision"] is not None
        and result["minPieceF0ConsensusPrecision"] >= 0.95
    )
    return result


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    summary = report["summary"]
    lines = [
        "# M4 OMR + audio dual-evidence audit",
        "",
        "Eval-only. This report does not open any student gate.",
        "",
        f"- pieces: {len(report['pieces'])}",
        f"- sequence precision: {summary['sequence']['precision']}",
        f"- structural precision: {summary['structural']['precision']}",
        f"- conservative consensus precision: {summary['consensus']['precision']}",
        f"- consensus Wilson 95% lower: {summary['consensus']['wilson95Lower']}",
        f"- consensus gold coverage: {summary['consensusGoldCoverage']}",
        f"- continuous-F0 consensus precision: {summary['f0Consensus']['precision']}",
        f"- continuous-F0 consensus Wilson 95% lower: {summary['f0Consensus']['wilson95Lower']}",
        f"- continuous-F0 consensus gold coverage: {summary['f0ConsensusGoldCoverage']}",
        f"- OMR pitch errors caught / escaped: {summary['caughtOmrPitchErrors']} / {summary['escapedOmrPitchErrors']}",
        f"- eval-only gate passed: {summary['evalOnlyGatePassed']}",
        "",
        "| piece | green | sequence P | structural P | consensus P | F0 consensus P | F0 coverage | false green |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in report["pieces"]:
        lines.append(
            f"| {row['piece']} | {row['greenEvents']} | {row['sequence']['precision']} | "
            f"{row['structural']['precision']} | {row['consensus']['precision']} | "
            f"{row['f0Consensus']['precision']} | {row['f0ConsensusGoldCoverage']} | "
            f"{len(row['falseGreenRows'])} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pieces", nargs="+", default=DEFAULT_PIECES)
    parser.add_argument("--variant", default="up2")
    parser.add_argument("--prototype-root", default=str(PROTOTYPE_OUT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--generate-missing", action="store_true")
    parser.add_argument("--refresh-verdicts", action="store_true")
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    piece_rows = []
    failures = []
    no_output = []
    for piece in args.pieces:
        try:
            row = evaluate_piece(
                piece,
                args.variant,
                Path(args.prototype_root).resolve(),
                generate_missing=args.generate_missing,
                refresh=args.refresh_verdicts,
            )
            piece_rows.append(row)
            print(json.dumps({key: value for key, value in row.items() if key != "rows"}, ensure_ascii=False))
        except FileNotFoundError as error:
            if "draft MXL missing" in str(error):
                no_output.append({"piece": piece, "status": "omr-no-output", "error": str(error)})
                print(json.dumps(no_output[-1], ensure_ascii=False))
                continue
            failures.append({"piece": piece, "error": f"{type(error).__name__}: {error}"})
            print(json.dumps(failures[-1], ensure_ascii=False))
        except Exception as error:
            failures.append({"piece": piece, "error": f"{type(error).__name__}: {error}"})
            print(json.dumps(failures[-1], ensure_ascii=False))
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "purpose": "OMR-and-audio green precision against independent clean score",
        "evalOnly": True,
        "studentFacing": False,
        "studentGateReady": False,
        "pieces": piece_rows,
        "omrNoOutput": no_output,
        "failures": failures,
        "summary": aggregate(piece_rows),
        "caveats": [
            "sequence mapping can over-credit repeated pitches",
            "structural mapping can under-credit OMR measure drift",
            "consensus requires both mappings to agree and is the release-relevant audit",
            "continuous F0 is monophonic-only and rejects short, polyphonic, or weakly voiced events",
            "all results remain eval-only until an independent runtime gate is designed",
        ],
    }
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    write_markdown(out / "report.md", report)
    print(json.dumps({"ok": not failures, "summary": report["summary"], "omrNoOutput": no_output, "out": str(out)}, ensure_ascii=False))
    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
