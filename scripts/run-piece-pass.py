from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import subprocess
import sys
import random
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib import error, request

import soundfile as sf


SCRIPT_ROOT = Path(__file__).resolve().parents[1]
CWD_ROOT = Path.cwd().resolve()
REPO_ROOT = CWD_ROOT if (CWD_ROOT / "package.json").exists() and (CWD_ROOT / "scripts").exists() else SCRIPT_ROOT


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a whole-piece pass by chaining sequence-aware section scans and focused re-analysis."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="Node gateway base URL.")
    parser.add_argument("--analyzer-url", default="http://127.0.0.1:8000", help="Python analyzer base URL.")
    parser.add_argument("--piece-id", default="taohuawu-test-fragment", help="Piece id to evaluate.")
    parser.add_argument("--score-id", default="", help="Imported score id to evaluate as a whole piece.")
    parser.add_argument("--audio", default="data/test_audio_mix.mp3", help="Whole-song audio file.")
    parser.add_argument("--output-dir", default="data/piece-pass", help="Directory for generated outputs.")
    parser.add_argument("--preprocess-mode", default="auto", help="Preprocess mode forwarded to the analyzer.")
    parser.add_argument("--hint-radius", type=float, default=2.0, help="Seconds around each research hint to probe during the scan.")
    parser.add_argument("--hint-step", type=float, default=1.0, help="Step size between hint probes.")
    parser.add_argument("--window-padding", type=float, default=3.0, help="Padding seconds added to each section window.")
    parser.add_argument("--max-candidates-per-section", type=int, default=2, help="Maximum scan windows per section.")
    parser.add_argument("--max-sections", type=int, default=0, help="Optional cap for faster test passes.")
    parser.add_argument("--section-id", action="append", default=[], help="Only evaluate selected section ids. Repeatable.")
    parser.add_argument("--section-ids", default="", help="Comma-separated section ids. Safer than repeated flags on Windows.")
    parser.add_argument("--skip-scan", action="store_true", help="Reuse an existing scan JSON in the output directory instead of re-running the scan.")
    parser.add_argument("--cache-dir", default="", help="Optional directory for per-section cached pass rows. Defaults to <output-dir>/section-cache.")
    parser.add_argument("--refresh-cache", action="store_true", help="Ignore existing per-section cache and recompute all section passes.")
    parser.add_argument("--scan-preprocess-mode", default="off", help="preprocessMode used during scan windows. 'off' skips source separation for speed.")
    parser.add_argument("--scan-concurrency", type=int, default=2, help="Number of sections to scan in parallel.")
    parser.add_argument("--analysis-concurrency", type=int, default=3, help="Number of sections to analyze in parallel during the analysis pass.")
    parser.add_argument("--analysis-retry", type=int, default=2, help="Max retries per section on transient connection errors.")
    parser.add_argument("--analysis-timeout-seconds", type=float, default=90.0, help="HTTP timeout for each focused section analysis.")
    parser.add_argument("--audio-hash", default="", help="Content hash for the input audio. Used to isolate per-section caches.")
    parser.add_argument("--reuse-scan-analyses", action="store_true", help="Use scan-window analyses as final section rows instead of re-analyzing every section.")
    parser.add_argument("--fast-window-min-duration", type=float, default=0.0, help="Minimum seconds per section window in fast sequence scan.")
    parser.add_argument("--fast-window-scale", type=float, default=1.6, help="Duration scale applied to score-estimated section length in fast sequence scan.")
    parser.add_argument(
        "--fast-sequence-scan",
        action="store_true",
        help="Skip expensive analyzer-based section detection and build ordered section windows from score timing hints.",
    )
    return parser.parse_args()


def emit_progress(progress: float, stage: str, message: str) -> None:
    print(
        "__PROGRESS__" + json.dumps(
            {
                "progress": round(max(0.0, min(1.0, float(progress))), 4),
                "stage": stage,
                "message": message,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def read_json(url: str) -> dict:
    with request.urlopen(url, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url: str, payload: dict, timeout_seconds: float = 240.0) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req, timeout=max(5.0, float(timeout_seconds))) as response:
        return json.loads(response.read().decode("utf-8"))


def safe_number(value, fallback=0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return numeric if numeric == numeric else float(fallback)


def meter_beats(meter: str | None) -> float:
    if not meter:
        return 4.0
    beats = str(meter).split("/")[0]
    try:
        return max(1.0, float(beats))
    except ValueError:
        return 4.0


def section_length_beats(section: dict) -> float:
    beats_per_measure = meter_beats(section.get("meter"))
    notes = section.get("notes") or []
    max_offset = 0.0
    for note in notes:
        end_beat = (
            (safe_number(note.get("measureIndex"), 1) - 1.0) * beats_per_measure
            + safe_number(note.get("beatStart"), 0.0)
            + safe_number(note.get("beatDuration"), 1.0)
        )
        max_offset = max(max_offset, end_beat)
    return max(max_offset, beats_per_measure)


def estimate_section_duration_seconds(
    section: dict,
    window_padding: float,
    min_duration_seconds: float = 8.0,
    duration_scale: float = 1.6,
) -> float:
    tempo = max(30.0, safe_number(section.get("tempo"), 72.0))
    expected_duration = section_length_beats(section) * (60.0 / tempo)
    return max(
        expected_duration + window_padding,
        expected_duration * max(1.0, duration_scale),
        max(1.0, min_duration_seconds),
    )


def hash_json(value: object) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def resolve_audio_hash(audio_path: Path, explicit_hash: str = "") -> str:
    if explicit_hash:
        return explicit_hash
    name_hash = audio_path.name.split(".")[0]
    if len(name_hash) >= 16 and all(char in "0123456789abcdefABCDEF" for char in name_hash[:16]):
        return name_hash
    stat = audio_path.stat()
    return hashlib.sha1(f"{audio_path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")).hexdigest()


def section_fingerprint(section: dict) -> str:
    return hash_json(
        {
            "sectionId": section.get("sectionId"),
            "sourceSectionId": section.get("sourceSectionId"),
            "title": section.get("title"),
            "sequenceIndex": section.get("sequenceIndex"),
            "tempo": section.get("tempo"),
            "meter": section.get("meter"),
            "measureRange": section.get("measureRange"),
            "notes": [
                {
                    "noteId": note.get("noteId"),
                    "measureIndex": note.get("measureIndex"),
                    "beatStart": note.get("beatStart"),
                    "beatDuration": note.get("beatDuration"),
                    "midiPitch": note.get("midiPitch"),
                }
                for note in (section.get("notes") or [])
            ],
        }
    )


def piece_fingerprint(piece: dict) -> str:
    return hash_json(
        {
            "pieceId": piece.get("pieceId"),
            "scoreId": piece.get("scoreId"),
            "title": piece.get("title"),
            "sections": [
                {
                    "sectionId": section.get("sectionId"),
                    "sourceSectionId": section.get("sourceSectionId"),
                    "sequenceIndex": section.get("sequenceIndex"),
                    "noteCount": len(section.get("notes") or []),
                    "fingerprint": section_fingerprint(section),
                }
                for section in (piece.get("sections") or [])
            ],
        }
    )


def slice_audio(audio_path: Path, start_seconds: float, duration_seconds: float) -> tuple[bytes, float]:
    info = sf.info(str(audio_path))
    start_frame = max(0, int(start_seconds * info.samplerate))
    end_frame = min(info.frames, start_frame + int(duration_seconds * info.samplerate))
    waveform, sample_rate = sf.read(str(audio_path), start=start_frame, stop=end_frame, dtype="float32")
    buffer = io.BytesIO()
    sf.write(buffer, waveform, sample_rate, format="WAV")
    return buffer.getvalue(), len(waveform) / sample_rate


def analyze_window(
    analyzer_url: str,
    piece: dict,
    section: dict,
    wav_bytes: bytes,
    duration_seconds: float,
    preprocess_mode: str,
    label: str,
    timeout_seconds: float = 90.0,
) -> dict:
    piece_pack = {
        "pieceId": piece.get("pieceId"),
        "sectionId": section.get("sectionId"),
        "title": piece.get("title"),
        "meter": section.get("meter"),
        "tempo": section.get("tempo"),
        "demoAudio": section.get("demoAudio", ""),
        "calibrationProfile": section.get("calibrationProfile") or {},
        "notes": section.get("notes", []),
    }
    payload = {
        "participantId": f"piece-pass-{label}",
        "groupId": "piece-pass",
        "sessionStage": "pretest",
        "pieceId": piece.get("pieceId"),
        "sectionId": section.get("sectionId"),
        "preprocessMode": preprocess_mode,
        "piecePack": piece_pack,
        "audioSubmission": {
            "name": f"{label}.wav",
            "mimeType": "audio/wav",
            "size": len(wav_bytes),
            "duration": duration_seconds,
        },
        "audioDataUrl": "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode("ascii"),
    }
    return post_json(f"{analyzer_url}/analyze", payload, timeout_seconds=timeout_seconds).get("analysis") or {}


def mean_weighted(rows: list[dict], key: str, weight_key: str) -> float:
    numerator = 0.0
    denominator = 0.0
    for row in rows:
        weight = max(1.0, safe_number(row.get(weight_key), 1))
        value = safe_number(row.get(key), 0)
        numerator += value * weight
        denominator += weight
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator, 2)


def is_failed_section_row(row: dict) -> bool:
    if not row:
        return True
    return bool(
        row.get("failed")
        or row.get("analysisFailed")
        or row.get("error")
        or row.get("failureReason")
    )


def run_scan(args: argparse.Namespace, scan_output_dir: Path) -> Path:
    scan_output_dir.mkdir(parents=True, exist_ok=True)
    output_key = args.score_id or args.piece_id
    scan_json = scan_output_dir / f"{output_key}-segment-scan.json"
    if args.skip_scan and scan_json.exists():
        return scan_json
    if args.fast_sequence_scan:
        raise RuntimeError("fast sequence scan requires piece context; call build_fast_sequence_scan instead")

    command = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "scan-piece-segments.py"),
        "--base-url",
        args.base_url,
        "--analyzer-url",
        args.analyzer_url,
        "--audio",
        args.audio,
        "--output-dir",
        str(scan_output_dir),
        "--hint-radius",
        str(args.hint_radius),
        "--hint-step",
        str(args.hint_step),
        "--window-padding",
        str(args.window_padding),
        "--max-candidates-per-section",
        str(args.max_candidates_per_section),
        "--scan-preprocess-mode",
        args.scan_preprocess_mode,
        "--concurrency",
        str(args.scan_concurrency),
    ]
    if args.score_id:
        command.extend(["--score-id", args.score_id])
    else:
        command.extend(["--piece-id", args.piece_id])
    if args.max_sections and args.max_sections > 0:
        command.extend(["--max-sections", str(args.max_sections)])

    merged_section_ids = [value.strip() for value in args.section_id if value and value.strip()]
    if args.section_ids:
        merged_section_ids.extend(value.strip() for value in str(args.section_ids).split(",") if value.strip())
    if merged_section_ids:
        command.extend(["--section-ids", ",".join(dict.fromkeys(merged_section_ids))])

    process = subprocess.Popen(
        command,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Emit timed progress ticks while scan runs (0.18 → 0.34, every 8 s).
    _scan_done = threading.Event()

    def _tick_scan_progress() -> None:
        tick = 0
        while not _scan_done.wait(timeout=8.0):
            tick += 1
            p = min(0.18 + tick * 0.02, 0.34)
            emit_progress(p, "scanning-sections", "正在定位整曲各段落的最佳窗口。")

    ticker = threading.Thread(target=_tick_scan_progress, daemon=True)
    ticker.start()

    stdout_bytes, stderr_bytes = process.communicate()
    _scan_done.set()
    ticker.join(timeout=1.0)

    # Always forward scan stderr so warnings appear in job logs regardless of exit code.
    if stderr_bytes:
        for line in stderr_bytes.decode("utf-8", errors="replace").splitlines():
            if line.strip():
                sys.stderr.write(line + "\n")

    if process.returncode != 0:
        stdout = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
        raise SystemExit(f"whole-piece scan failed (exit {process.returncode}):\n{stdout}")

    if not scan_json.exists():
        raise SystemExit(f"scan finished without producing {scan_json}")
    return scan_json


def _selected_sections_for_pass(args: argparse.Namespace, piece: dict) -> list[dict]:
    selected_section_ids = {value.strip() for value in args.section_id if value and value.strip()}
    if args.section_ids:
        selected_section_ids.update(value.strip() for value in str(args.section_ids).split(",") if value.strip())
    sections = [section for section in (piece.get("sections") or []) if section.get("notes")]
    if selected_section_ids:
        sections = [section for section in sections if section.get("sectionId") in selected_section_ids]
    sections.sort(key=lambda item: int(safe_number(item.get("sequenceIndex"), 0)))
    if args.max_sections and args.max_sections > 0:
        sections = sections[: args.max_sections]
    return sections


def _patch_missing_or_oversized_hints(sections: list[dict], audio_duration: float) -> tuple[list[dict], float]:
    if not sections:
        return sections, 0.0

    ordered = sorted(sections, key=lambda item: int(safe_number(item.get("sequenceIndex"), 0)))
    cumulative = 0.0
    generated: dict[str, float] = {}
    for section in ordered:
        section_id = str(section.get("sectionId") or "")
        generated[section_id] = round(cumulative, 2)
        cumulative += max(2.0, estimate_section_duration_seconds(section, 0.0))

    all_hints = [safe_number(h, float("nan")) for section in ordered for h in (section.get("researchWindowHints") or [])]
    all_hints = [value for value in all_hints if value == value and value >= 0]
    estimated_piece_duration = max(all_hints) if all_hints else cumulative

    patched = []
    for section in sections:
        section_id = str(section.get("sectionId") or "")
        hints = [safe_number(h, float("nan")) for h in (section.get("researchWindowHints") or [])]
        hints = [value for value in hints if value == value and value >= 0]
        if not hints:
            hints = [generated.get(section_id, 0.0)]
        patched.append({**section, "researchWindowHints": hints})

    if audio_duration > 0:
        patched_hints = [h for section in patched for h in (section.get("researchWindowHints") or [])]
        max_hint = max(patched_hints) if patched_hints else 0.0
        if max_hint > audio_duration * 0.95:
            scale = (audio_duration * 0.88) / max_hint
            sys.stderr.write(
                f"INFO: fast sequence hints rescaled by {scale:.3f} "
                f"(max_hint={max_hint:.1f}s > audio={audio_duration:.1f}s)\n"
            )
            patched = [
                {
                    **section,
                    "researchWindowHints": [
                        round(max(0.0, safe_number(h, 0.0) * scale), 2)
                        for h in (section.get("researchWindowHints") or [])
                    ],
                }
                for section in patched
            ]

    return patched, estimated_piece_duration


def build_fast_sequence_scan(args: argparse.Namespace, scan_output_dir: Path, piece: dict, audio_path: Path) -> Path:
    scan_output_dir.mkdir(parents=True, exist_ok=True)
    output_key = args.score_id or args.piece_id
    scan_json = scan_output_dir / f"{output_key}-segment-scan.json"
    if args.skip_scan and scan_json.exists():
        return scan_json

    try:
        audio_duration = float(sf.info(str(audio_path)).duration)
    except Exception:
        audio_duration = 0.0

    sections, estimated_piece_duration = _patch_missing_or_oversized_hints(
        _selected_sections_for_pass(args, piece),
        audio_duration,
    )
    sequence_path: list[dict] = []
    scan_results: list[dict] = []
    previous_start = 0.0
    planned_starts: list[tuple[dict, float]] = []

    for section in sections:
        hints = [safe_number(h, 0.0) for h in (section.get("researchWindowHints") or [previous_start])]
        start_seconds = max(0.0, min(hints) if hints else previous_start)
        start_seconds = max(previous_start, start_seconds)
        if audio_duration > 0:
            start_seconds = min(start_seconds, max(0.0, audio_duration - 1.0))
        planned_starts.append((section, start_seconds))
        previous_start = start_seconds

    min_duration = safe_number(args.fast_window_min_duration, 0.0) or (3.5 if args.fast_sequence_scan else 8.0)
    for index, (section, start_seconds) in enumerate(planned_starts):
        window_duration = estimate_section_duration_seconds(
            section,
            args.window_padding,
            min_duration_seconds=min_duration,
            duration_scale=safe_number(args.fast_window_scale, 1.6),
        )
        next_start = planned_starts[index + 1][1] if index + 1 < len(planned_starts) else None
        if next_start is not None and next_start > start_seconds + 0.25:
            # In fast ordered scans, the next section start is a stronger bound
            # than a per-section duration expansion. This avoids overlapping
            # every short OMR chunk and cuts first-run whole-piece latency.
            bounded_duration = max(min_duration, (next_start - start_seconds) + args.window_padding)
            window_duration = min(window_duration, bounded_duration)
        if audio_duration > 0:
            window_duration = min(window_duration, max(1.0, audio_duration - start_seconds))

        item = {
            "sectionId": section.get("sectionId"),
            "sectionTitle": section.get("title"),
            "sequenceIndex": int(safe_number(section.get("sequenceIndex"), 0)),
            "startSeconds": round(start_seconds, 2),
            "durationSeconds": round(window_duration, 2),
            "score": None,
            "nearestHintDistance": 0,
            "priorAdjustedScore": 0,
            "overallPitchScore": None,
            "overallRhythmScore": None,
            "confidence": None,
            "recommendedPracticePath": "review-first",
            "measureFindingCount": 0,
            "noteFindingCount": 0,
            "measureFindings": [],
            "noteFindings": [],
            "demoSegments": [],
            "studentPitchScore": None,
            "studentRhythmScore": None,
            "studentCombinedScore": None,
            "summaryText": "",
            "diagnostics": {"analysisSource": "fast-sequence-window"},
        }
        sequence_path.append(item)
        scan_results.append(
            {
                "sectionId": section.get("sectionId"),
                "sectionTitle": section.get("title"),
                "sequenceIndex": int(safe_number(section.get("sequenceIndex"), 0)),
                "expectedDurationSeconds": round(max(1.0, window_duration - args.window_padding), 2),
                "windowDurationSeconds": round(window_duration, 2),
                "candidateCount": 1,
                "bestMatch": item,
                "topMatches": [item],
            }
        )

    audio_coverage = {
        "audioDurationSeconds": round(audio_duration, 2),
        "estimatedPieceDurationSeconds": round(estimated_piece_duration, 2),
        "isPartial": False,
        "scannedSectionCount": len(sequence_path),
        "skippedSectionCount": 0,
        "lastScannedSectionId": sequence_path[-1]["sectionId"] if sequence_path else None,
        "skippedSectionIds": [],
        "scanMode": "fast-sequence-window",
    }
    payload = {
        "pieceId": output_key,
        "audio": str(audio_path),
        "audioCoverage": audio_coverage,
        "scanResults": scan_results,
        "rankedMatches": sequence_path,
        "sequenceAwarePath": sequence_path,
    }
    scan_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (scan_output_dir / f"{output_key}-segment-scan.md").write_text(
        "\n".join(
            [
                "# Fast Sequence Scan Report",
                "",
                f"- Piece: {piece.get('title')} ({output_key})",
                f"- Audio: {audio_path}",
                f"- Sections: {len(sequence_path)}",
                "- Mode: score-order timing hints, no analyzer scan",
            ]
        ),
        encoding="utf-8",
    )
    return scan_json


def summarize_piece_pass(piece: dict, section_rows: list[dict], audio_coverage: dict | None = None) -> dict:
    structured_sections = piece.get("sections") or []
    structured_section_count = len(structured_sections)
    structured_note_count = sum(len(section.get("notes") or []) for section in structured_sections)
    successful_rows = [row for row in section_rows if not is_failed_section_row(row)]
    failed_rows = [row for row in section_rows if is_failed_section_row(row)]
    matched_section_count = len(successful_rows)
    matched_note_count = sum(int(row.get("noteCount") or 0) for row in successful_rows)
    attempted_section_count = len(section_rows)
    failed_section_count = len(failed_rows)
    timed_out_section_count = sum(
        1 for row in failed_rows if "timed out" in str(row.get("failureReason") or row.get("error") or "").lower()
    )
    practice_counter = Counter(row.get("recommendedPracticePath") or "review-first" for row in successful_rows)

    weakest_sections = sorted(
        successful_rows,
        key=lambda row: (safe_number(row.get("combinedScore"), 999), safe_number(row.get("confidence"), 0)),
    )[:5]

    dominant_path = practice_counter.most_common(1)[0][0] if practice_counter else "review-first"
    coverage_ratio = round(matched_section_count / structured_section_count, 3) if structured_section_count else 0.0
    note_coverage_ratio = round(matched_note_count / structured_note_count, 3) if structured_note_count else 0.0
    attempted_ratio = round(attempted_section_count / structured_section_count, 3) if structured_section_count else 0.0
    analysis_completeness_ratio = round(matched_section_count / attempted_section_count, 3) if attempted_section_count else 0.0
    reliable = analysis_completeness_ratio >= 0.85 and matched_section_count > 0

    return {
        "pieceId": piece.get("pieceId"),
        "pieceTitle": piece.get("title"),
        "structuredSectionCount": structured_section_count,
        "structuredNoteCount": structured_note_count,
        "attemptedSectionCount": attempted_section_count,
        "failedSectionCount": failed_section_count,
        "timedOutSectionCount": timed_out_section_count,
        "matchedSectionCount": matched_section_count,
        "matchedNoteCount": matched_note_count,
        "sectionCoverageRatio": coverage_ratio,
        "noteCoverageRatio": note_coverage_ratio,
        "attemptedSectionRatio": attempted_ratio,
        "analysisCompletenessRatio": analysis_completeness_ratio,
        "analysisReliable": reliable,
        "weightedPitchScore": mean_weighted(successful_rows, "overallPitchScore", "noteCount"),
        "weightedRhythmScore": mean_weighted(successful_rows, "overallRhythmScore", "noteCount"),
        "weightedStudentPitchScore": mean_weighted(successful_rows, "studentPitchScore", "noteCount"),
        "weightedStudentRhythmScore": mean_weighted(successful_rows, "studentRhythmScore", "noteCount"),
        "weightedConfidence": mean_weighted(successful_rows, "confidence", "noteCount"),
        "weightedCombinedScore": mean_weighted(successful_rows, "combinedScore", "noteCount"),
        "weightedStudentCombinedScore": mean_weighted(successful_rows, "studentCombinedScore", "noteCount"),
        "totalMeasureFindings": int(sum(safe_number(row.get("measureFindingCount"), 0) for row in successful_rows)),
        "totalNoteFindings": int(sum(safe_number(row.get("noteFindingCount"), 0) for row in successful_rows)),
        "dominantPracticePath": dominant_path,
        "practicePathCounts": dict(practice_counter),
        "weakestSections": [
            {
                "sectionId": row.get("sectionId"),
                "sectionTitle": row.get("sectionTitle"),
                "sequenceIndex": row.get("sequenceIndex"),
                "combinedScore": row.get("combinedScore"),
                "studentCombinedScore": row.get("studentCombinedScore"),
                "recommendedPracticePath": row.get("recommendedPracticePath"),
                "summaryText": row.get("summaryText"),
            }
            for row in weakest_sections
        ],
        **({"audioCoverage": audio_coverage} if audio_coverage else {}),
    }


def build_summary_text(summary: dict) -> str:
    weakest = summary.get("weakestSections") or []
    weakest_labels = ", ".join(
        f"{item.get('sequenceIndex')}.{item.get('sectionTitle')}({item.get('combinedScore')})" for item in weakest[:3]
    )
    reliability = ""
    if not summary.get("analysisReliable"):
        reliability = (
            f" 本次整曲分析只完成 {summary.get('matchedSectionCount')}/"
            f"{summary.get('attemptedSectionCount')} 个候选段落，"
            f"其中 {summary.get('failedSectionCount')} 段失败或超时，结果需复核。"
        )
    return (
        f"当前整曲 pass 已覆盖 {summary.get('matchedSectionCount')}/{summary.get('structuredSectionCount')} 个结构化段落，"
        f"加权音准 {summary.get('weightedPitchScore')}，加权节奏 {summary.get('weightedRhythmScore')}，"
        f"整曲优先练习路径为 {summary.get('dominantPracticePath')}。"
        + reliability
        + (f" 当前最弱的段落是 {weakest_labels}。" if weakest_labels else "")
    )


def resolve_cache_dir(output_dir: Path, cache_dir_arg: str) -> Path:
    if cache_dir_arg:
        return (REPO_ROOT / cache_dir_arg).resolve()
    return output_dir / "section-cache"


def build_section_cache_key(
    piece_id: str,
    section_id: str,
    start_seconds: float,
    duration_seconds: float,
    preprocess_mode: str,
    audio_hash: str,
    piece_hash: str,
    section_hash: str,
) -> str:
    return hash_json(
        {
            "version": "piece-pass-section-v3",
            "audioHash": audio_hash,
            "pieceId": piece_id,
            "pieceFingerprint": piece_hash,
            "sectionId": section_id,
            "sectionFingerprint": section_hash,
            "startSeconds": round(start_seconds, 2),
            "durationSeconds": round(duration_seconds, 2),
            "preprocessMode": preprocess_mode,
        }
    )[:20]


def cache_path_for_section(
    cache_dir: Path,
    piece_id: str,
    section_id: str,
    start_seconds: float,
    duration_seconds: float,
    preprocess_mode: str,
    audio_hash: str,
    piece_hash: str,
    section_hash: str,
) -> Path:
    cache_key = build_section_cache_key(
        piece_id,
        section_id,
        start_seconds,
        duration_seconds,
        preprocess_mode,
        audio_hash,
        piece_hash,
        section_hash,
    )
    safe_section_id = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in section_id) or "section"
    return cache_dir / f"{safe_section_id}-{cache_key}.json"


def load_cached_section_row(
    cache_dir: Path,
    piece_id: str,
    section_id: str,
    start_seconds: float,
    duration_seconds: float,
    preprocess_mode: str,
    audio_hash: str,
    piece_hash: str,
    section_hash: str,
) -> dict | None:
    cache_path = cache_path_for_section(
        cache_dir,
        piece_id,
        section_id,
        start_seconds,
        duration_seconds,
        preprocess_mode,
        audio_hash,
        piece_hash,
        section_hash,
    )
    if not cache_path.exists():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    row = payload.get("sectionRow") if isinstance(payload, dict) else None
    return row if isinstance(row, dict) else None


def write_cached_section_row(
    cache_dir: Path,
    piece_id: str,
    section_id: str,
    start_seconds: float,
    duration_seconds: float,
    preprocess_mode: str,
    audio_hash: str,
    piece_hash: str,
    section_hash: str,
    row: dict,
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_path_for_section(
        cache_dir,
        piece_id,
        section_id,
        start_seconds,
        duration_seconds,
        preprocess_mode,
        audio_hash,
        piece_hash,
        section_hash,
    )
    cache_path.write_text(
        json.dumps(
            {
                "cacheVersion": "piece-pass-section-v7-imported-rhythm-outlier-review",
                "audioHash": audio_hash,
                "pieceFingerprint": piece_hash,
                "sectionFingerprint": section_hash,
                "pieceId": piece_id,
                "sectionId": section_id,
                "startSeconds": round(start_seconds, 2),
                "durationSeconds": round(duration_seconds, 2),
                "preprocessMode": preprocess_mode,
                "sectionRow": row,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def write_csv(path: Path, rows: list[dict]) -> None:
    fieldnames = [
        "pieceId",
        "pieceTitle",
        "sequenceIndex",
        "sectionId",
        "sectionTitle",
        "startSeconds",
        "endSeconds",
        "durationSeconds",
        "noteCount",
        "measureCount",
        "rawScanScore",
        "priorAdjustedScore",
        "nearestHintDistance",
        "overallPitchScore",
        "overallRhythmScore",
        "studentPitchScore",
        "studentRhythmScore",
        "confidence",
        "combinedScore",
        "studentCombinedScore",
        "recommendedPracticePath",
        "measureFindingCount",
        "noteFindingCount",
        "summaryText",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({name: row.get(name, "") for name in fieldnames})


def write_markdown(path: Path, summary: dict, rows: list[dict], scan_json_path: Path) -> None:
    lines = [
        "# Whole-piece pass report",
        "",
        f"- Piece: {summary.get('pieceTitle')} ({summary.get('pieceId')})",
        f"- Structured coverage: {summary.get('matchedSectionCount')} / {summary.get('structuredSectionCount')} sections",
        f"- Weighted pitch / rhythm: {summary.get('weightedPitchScore')} / {summary.get('weightedRhythmScore')}",
        f"- Student display pitch / rhythm: {summary.get('weightedStudentPitchScore')} / {summary.get('weightedStudentRhythmScore')}",
        f"- Weighted combined score: {summary.get('weightedCombinedScore')}",
        f"- Student display combined score: {summary.get('weightedStudentCombinedScore')}",
        f"- Dominant practice path: {summary.get('dominantPracticePath')}",
        f"- Total note / measure findings: {summary.get('totalNoteFindings')} / {summary.get('totalMeasureFindings')}",
        f"- Scan JSON: {scan_json_path}",
        "",
        "## Summary",
        "",
        build_summary_text(summary),
        "",
        "## Weakest sections",
        "",
    ]

    for item in summary.get("weakestSections") or []:
        lines.extend(
            [
                f"- {item.get('sequenceIndex')}. {item.get('sectionTitle')} ({item.get('sectionId')}): "
                f"score {item.get('combinedScore')}, path {item.get('recommendedPracticePath')}",
            ]
        )

    lines.extend(["", "## Section schedule", ""])
    for row in rows:
        lines.extend(
            [
                f"### {row.get('sequenceIndex')}. {row.get('sectionTitle')} / {row.get('sectionId')}",
                f"- Window: {row.get('startSeconds')}s - {row.get('endSeconds')}s",
                f"- Pitch / rhythm / combined: {row.get('overallPitchScore')} / {row.get('overallRhythmScore')} / {row.get('combinedScore')}",
                f"- Student display pitch / rhythm / combined: {row.get('studentPitchScore')} / {row.get('studentRhythmScore')} / {row.get('studentCombinedScore')}",
                f"- Practice path: {row.get('recommendedPracticePath')}",
                f"- Summary: {row.get('summaryText')}",
                "",
            ]
        )

    path.write_text("\n".join(lines), encoding="utf-8")


def _analyze_section_item(
    item: dict,
    section: dict,
    audio_path: Path,
    cache_dir: Path,
    piece: dict,
    audio_hash: str,
    piece_hash: str,
    analyzer_url: str,
    preprocess_mode: str,
    refresh_cache: bool,
    analysis_timeout_seconds: float,
) -> tuple[dict, bool]:
    section_id = item.get("sectionId")
    start_seconds = safe_number(item.get("startSeconds"), 0.0)
    duration_seconds = max(1.0, safe_number(item.get("durationSeconds"), 8.0))
    note_count = len(section.get("notes") or [])
    measure_count = len({note.get("measureIndex") for note in section.get("notes") or []})
    piece_id = str(piece.get("pieceId"))
    current_section_fingerprint = section_fingerprint(section)

    row = None if refresh_cache else load_cached_section_row(
        cache_dir,
        piece_id,
        str(section_id),
        start_seconds,
        duration_seconds,
        preprocess_mode,
        audio_hash,
        piece_hash,
        current_section_fingerprint,
    )
    if row:
        row = dict(row)
        row["rawScanScore"] = item.get("score")
        row["priorAdjustedScore"] = item.get("priorAdjustedScore")
        row["nearestHintDistance"] = item.get("nearestHintDistance")
        return row, True

    wav_bytes, actual_duration = slice_audio(audio_path, start_seconds, duration_seconds)
    analysis = analyze_window(
        analyzer_url, piece, section, wav_bytes, actual_duration, preprocess_mode,
        f"{section_id}-{start_seconds}",
        timeout_seconds=analysis_timeout_seconds,
    )
    combined_score = round(
        safe_number(analysis.get("overallPitchScore"), 0) * 0.45
        + safe_number(analysis.get("overallRhythmScore"), 0) * 0.45
        + safe_number(analysis.get("confidence"), 0) * 10,
        2,
    )
    row = {
        "pieceId": piece.get("pieceId"),
        "pieceTitle": piece.get("title"),
        "sequenceIndex": int(section.get("sequenceIndex") or 0),
        "sectionId": section_id,
        "sectionTitle": section.get("title"),
        "startSeconds": round(start_seconds, 2),
        "endSeconds": round(start_seconds + actual_duration, 2),
        "durationSeconds": round(actual_duration, 2),
        "noteCount": note_count,
        "measureCount": measure_count,
        "rawScanScore": item.get("score"),
        "priorAdjustedScore": item.get("priorAdjustedScore"),
        "nearestHintDistance": item.get("nearestHintDistance"),
        "overallPitchScore": analysis.get("overallPitchScore"),
        "overallRhythmScore": analysis.get("overallRhythmScore"),
        "studentPitchScore": analysis.get("studentPitchScore", analysis.get("overallPitchScore")),
        "studentRhythmScore": analysis.get("studentRhythmScore", analysis.get("overallRhythmScore")),
        "confidence": analysis.get("confidence"),
        "combinedScore": combined_score,
        "studentCombinedScore": analysis.get(
            "studentCombinedScore",
            round(
                (
                    safe_number(analysis.get("studentPitchScore", analysis.get("overallPitchScore")), 0)
                    + safe_number(analysis.get("studentRhythmScore", analysis.get("overallRhythmScore")), 0)
                )
                / 2.0
            ),
        ),
        "recommendedPracticePath": analysis.get("recommendedPracticePath"),
        "measureFindingCount": len(analysis.get("measureFindings") or []),
        "noteFindingCount": len(analysis.get("noteFindings") or []),
        "measureFindings": analysis.get("measureFindings") or [],
        "noteFindings": analysis.get("noteFindings") or [],
        "demoSegments": analysis.get("demoSegments") or [],
        "summaryText": analysis.get("summaryText") or "",
        "teacherComment": analysis.get("teacherComment") or "",
        "practiceTargets": analysis.get("practiceTargets") or [],
        "diagnostics": analysis.get("diagnostics") or {},
    }
    write_cached_section_row(
        cache_dir,
        piece_id,
        str(section_id),
        start_seconds,
        duration_seconds,
        preprocess_mode,
        audio_hash,
        piece_hash,
        current_section_fingerprint,
        row,
    )
    return row, False


def build_section_row_from_scan_item(item: dict, section: dict, piece: dict) -> dict:
    start_seconds = safe_number(item.get("startSeconds"), 0.0)
    duration_seconds = max(1.0, safe_number(item.get("durationSeconds"), 8.0))
    note_count = len(section.get("notes") or [])
    measure_count = len({note.get("measureIndex") for note in section.get("notes") or []})
    overall_pitch = item.get("overallPitchScore")
    overall_rhythm = item.get("overallRhythmScore")
    combined_score = round(
        safe_number(overall_pitch, 0) * 0.45
        + safe_number(overall_rhythm, 0) * 0.45
        + safe_number(item.get("confidence"), 0) * 10,
        2,
    )
    return {
        "pieceId": piece.get("pieceId"),
        "pieceTitle": piece.get("title"),
        "sequenceIndex": int(section.get("sequenceIndex") or 0),
        "sectionId": item.get("sectionId") or section.get("sectionId"),
        "sectionTitle": item.get("sectionTitle") or section.get("title"),
        "startSeconds": round(start_seconds, 2),
        "endSeconds": round(start_seconds + duration_seconds, 2),
        "durationSeconds": round(duration_seconds, 2),
        "noteCount": note_count,
        "measureCount": measure_count,
        "rawScanScore": item.get("score"),
        "priorAdjustedScore": item.get("priorAdjustedScore"),
        "nearestHintDistance": item.get("nearestHintDistance"),
        "overallPitchScore": overall_pitch,
        "overallRhythmScore": overall_rhythm,
        "studentPitchScore": item.get("studentPitchScore", overall_pitch),
        "studentRhythmScore": item.get("studentRhythmScore", overall_rhythm),
        "confidence": item.get("confidence"),
        "combinedScore": combined_score,
        "studentCombinedScore": item.get(
            "studentCombinedScore",
            round((safe_number(overall_pitch, 0) + safe_number(overall_rhythm, 0)) / 2.0),
        ),
        "recommendedPracticePath": item.get("recommendedPracticePath"),
        "measureFindingCount": item.get("measureFindingCount", 0),
        "noteFindingCount": item.get("noteFindingCount", 0),
        "measureFindings": item.get("measureFindings") or [],
        "noteFindings": item.get("noteFindings") or [],
        "demoSegments": item.get("demoSegments") or [],
        "summaryText": item.get("summaryText") or "",
        "teacherComment": "",
        "practiceTargets": [],
        "diagnostics": {
            **(item.get("diagnostics") or {}),
            "analysisSource": "scan-window",
        },
    }


def build_failed_section_row(item: dict, section: dict, piece: dict, exc: Exception) -> dict:
    note_count = len(section.get("notes") or [])
    measure_count = len({note.get("measureIndex") for note in section.get("notes") or []})
    error_text = str(exc) or exc.__class__.__name__
    return {
        "pieceId": piece.get("pieceId"),
        "pieceTitle": piece.get("title"),
        "sequenceIndex": int(section.get("sequenceIndex") or 0),
        "sectionId": item.get("sectionId") or section.get("sectionId"),
        "sectionTitle": item.get("sectionTitle") or section.get("title"),
        "startSeconds": round(safe_number(item.get("startSeconds"), 0.0), 2),
        "endSeconds": round(safe_number(item.get("endSeconds"), 0.0), 2),
        "durationSeconds": round(safe_number(item.get("durationSeconds"), 0.0), 2),
        "noteCount": note_count,
        "measureCount": measure_count,
        "rawScanScore": item.get("score"),
        "priorAdjustedScore": item.get("priorAdjustedScore"),
        "nearestHintDistance": item.get("nearestHintDistance"),
        "overallPitchScore": 0,
        "overallRhythmScore": 0,
        "studentPitchScore": 0,
        "studentRhythmScore": 0,
        "confidence": 0,
        "combinedScore": 0,
        "studentCombinedScore": 0,
        "recommendedPracticePath": "review-first",
        "measureFindingCount": 0,
        "noteFindingCount": 0,
        "measureFindings": [],
        "noteFindings": [],
        "demoSegments": [],
        "summaryText": f"该段落分析超时或失败，已跳过深度诊断：{error_text}",
        "teacherComment": "",
        "practiceTargets": [],
        "failed": True,
        "error": error_text,
        "analysisFailed": True,
        "failureReason": error_text,
        "diagnostics": {
            "analysisSource": "focused-analysis-failed",
            "failureReason": error_text,
        },
    }


def main() -> int:
    args = parse_args()
    output_dir = (REPO_ROOT / args.output_dir).resolve()
    scan_output_dir = output_dir / "scan"
    cache_dir = resolve_cache_dir(output_dir, args.cache_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_key = args.score_id or args.piece_id
    audio_path = (REPO_ROOT / args.audio).resolve()
    audio_hash = resolve_audio_hash(audio_path, args.audio_hash)

    try:
        emit_progress(0.04, "checking-services", "正在检查整曲分析服务。")
        read_json(f"{args.base_url}/api/health")
        read_json(f"{args.analyzer_url}/health")
        if args.score_id:
            piece_json = read_json(f"{args.base_url}/api/erhu/pieces/from-score/{args.score_id}")
        else:
            piece_json = read_json(f"{args.base_url}/api/erhu/pieces/{args.piece_id}")
    except error.URLError as exc:
        raise SystemExit(f"service check failed: {exc}") from exc

    piece = piece_json.get("piece") or {}
    if not piece:
        raise SystemExit(f"piece not found: {args.score_id or args.piece_id}")
    current_piece_fingerprint = piece_fingerprint(piece)

    if args.fast_sequence_scan:
        emit_progress(0.34, "scanning-sections", "已按曲谱顺序生成整曲段落窗口，正在进入深度分析。")
        scan_json_path = build_fast_sequence_scan(args, scan_output_dir, piece, audio_path)
    else:
        emit_progress(0.18, "scanning-sections", "正在定位整曲中各段落的最佳窗口。")
        scan_json_path = run_scan(args, scan_output_dir)
    scan_payload = json.loads(scan_json_path.read_text(encoding="utf-8"))
    sequence_path = scan_payload.get("sequenceAwarePath") or []
    audio_coverage = scan_payload.get("audioCoverage")
    section_lookup = {section.get("sectionId"): section for section in piece.get("sections") or []}

    valid_items = [(item, section_lookup.get(item.get("sectionId"))) for item in sequence_path]
    valid_items = [(item, sec) for item, sec in valid_items if sec]
    total_sections = max(1, len(valid_items))
    section_rows = []
    cache_hits = 0
    completed_count = 0
    progress_lock = threading.Lock()

    def _run_item(pair: tuple) -> tuple[dict, bool]:
        item, sec = pair
        if args.reuse_scan_analyses:
            return build_section_row_from_scan_item(item, sec, piece), True
        last_exc: Exception | None = None
        for attempt in range(max(1, args.analysis_retry + 1)):
            try:
                return _analyze_section_item(
                    item, sec, audio_path, cache_dir, piece, audio_hash, current_piece_fingerprint,
                    args.analyzer_url, args.preprocess_mode, args.refresh_cache, args.analysis_timeout_seconds,
                )
            except Exception as exc:
                last_exc = exc
                if attempt < args.analysis_retry:
                    time.sleep(3 * (attempt + 1) + random.uniform(0, 2))
        raise last_exc  # type: ignore[misc]

    concurrency = max(1, args.analysis_concurrency)
    if concurrency <= 1 or len(valid_items) <= 1:
        for pair in valid_items:
            try:
                row, hit = _run_item(pair)
            except Exception as exc:
                item, sec = pair
                sys.stderr.write(f"WARNING: analysis skipped {sec.get('sectionId')} after retries: {exc}\n")
                row, hit = build_failed_section_row(item, sec, piece, exc), False
            section_rows.append(row)
            cache_hits += hit
            completed_count += 1
            label = "复用并汇总" if hit else "分析"
            emit_progress(
                0.35 + (completed_count / total_sections) * 0.5,
                "analyzing-sections",
                f"正在{label}第 {completed_count}/{total_sections} 个段落。",
            )
    else:
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            future_map = {executor.submit(_run_item, pair): pair for pair in valid_items}
            for future in as_completed(future_map):
                pair = future_map[future]
                try:
                    row, hit = future.result()
                except Exception as exc:
                    item, sec = pair
                    sys.stderr.write(
                        f"WARNING: analysis skipped {sec.get('sectionId')} after retries: {exc}\n"
                    )
                    row, hit = build_failed_section_row(item, sec, piece, exc), False
                with progress_lock:
                    section_rows.append(row)
                    cache_hits += hit
                    completed_count += 1
                    n = completed_count
                emit_progress(
                    0.35 + (n / total_sections) * 0.5,
                    "analyzing-sections",
                    f"正在分析整曲各段落（{n}/{total_sections}）。",
                )

    section_rows.sort(key=lambda row: (row.get("sequenceIndex") or 0, row.get("startSeconds") or 0))
    summary = summarize_piece_pass(piece, section_rows, audio_coverage=audio_coverage)
    summary["summaryText"] = build_summary_text(summary)
    summary["scoreId"] = args.score_id
    summary["audioHash"] = audio_hash
    summary["analysisReuseMode"] = "scan-window" if args.reuse_scan_analyses else "focused-analysis"

    json_payload = {
        "pieceId": output_key,
        "scoreId": args.score_id,
        "audioHash": audio_hash,
        "audio": str(audio_path),
        "scanJsonPath": str(scan_json_path),
        "summary": summary,
        "sectionPasses": section_rows,
    }

    emit_progress(0.92, "writing-results", "正在写入整曲分析结果。")

    json_path = output_dir / f"{output_key}-whole-piece-pass.json"
    summary_path = output_dir / f"{output_key}-whole-piece-summary.json"
    csv_path = output_dir / f"{output_key}-whole-piece-pass.csv"
    md_path = output_dir / f"{output_key}-whole-piece-pass.md"
    json_path.write_text(json.dumps(json_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_path.write_text(
        json.dumps(
            {
                "pieceId": output_key,
                "scoreId": args.score_id,
                "audioHash": audio_hash,
                "audio": str(audio_path),
                "scanJsonPath": str(scan_json_path),
                "summary": summary,
                "cacheDir": str(cache_dir),
                "cacheHits": cache_hits,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    write_csv(csv_path, section_rows)
    write_markdown(md_path, summary, section_rows, scan_json_path)

    print(
        json.dumps(
            {
                "pieceId": output_key,
                "scoreId": args.score_id,
                "audioHash": audio_hash,
                "matchedSectionCount": summary.get("matchedSectionCount"),
                "structuredSectionCount": summary.get("structuredSectionCount"),
                "weightedPitchScore": summary.get("weightedPitchScore"),
                "weightedRhythmScore": summary.get("weightedRhythmScore"),
                "dominantPracticePath": summary.get("dominantPracticePath"),
                "outputDir": str(output_dir),
                "cacheDir": str(cache_dir),
                "cacheHits": cache_hits,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    emit_progress(1.0, "completed", "整曲分析完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
