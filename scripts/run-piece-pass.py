from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import subprocess
import sys
from collections import Counter
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
    parser.add_argument("--hint-radius", type=float, default=1.0, help="Seconds around each research hint to probe during the scan.")
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


def post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req, timeout=240) as response:
        return json.loads(response.read().decode("utf-8"))


def safe_number(value, fallback=0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return numeric if numeric == numeric else float(fallback)


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
    return post_json(f"{analyzer_url}/analyze", payload).get("analysis") or {}


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


def run_scan(args: argparse.Namespace, scan_output_dir: Path) -> Path:
    scan_output_dir.mkdir(parents=True, exist_ok=True)
    output_key = args.score_id or args.piece_id
    scan_json = scan_output_dir / f"{output_key}-segment-scan.json"
    if args.skip_scan and scan_json.exists():
        return scan_json

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

    completed = subprocess.run(
        command,
        cwd=str(REPO_ROOT),
        check=False,
        capture_output=True,
    )
    if completed.returncode != 0:
        stdout = completed.stdout.decode("utf-8", errors="replace") if completed.stdout else ""
        stderr = completed.stderr.decode("utf-8", errors="replace") if completed.stderr else ""
        raise SystemExit(
            "whole-piece scan failed:\n"
            f"STDOUT:\n{stdout}\n"
            f"STDERR:\n{stderr}"
        )

    if not scan_json.exists():
        raise SystemExit(f"scan finished without producing {scan_json}")
    return scan_json


def summarize_piece_pass(piece: dict, section_rows: list[dict]) -> dict:
    structured_sections = piece.get("sections") or []
    structured_section_count = len(structured_sections)
    structured_note_count = sum(len(section.get("notes") or []) for section in structured_sections)
    matched_section_count = len(section_rows)
    matched_note_count = sum(int(row.get("noteCount") or 0) for row in section_rows)
    practice_counter = Counter(row.get("recommendedPracticePath") or "review-first" for row in section_rows)

    weakest_sections = sorted(
        section_rows,
        key=lambda row: (safe_number(row.get("combinedScore"), 999), safe_number(row.get("confidence"), 0)),
    )[:5]

    dominant_path = practice_counter.most_common(1)[0][0] if practice_counter else "review-first"
    coverage_ratio = round(matched_section_count / structured_section_count, 3) if structured_section_count else 0.0
    note_coverage_ratio = round(matched_note_count / structured_note_count, 3) if structured_note_count else 0.0

    return {
        "pieceId": piece.get("pieceId"),
        "pieceTitle": piece.get("title"),
        "structuredSectionCount": structured_section_count,
        "structuredNoteCount": structured_note_count,
        "matchedSectionCount": matched_section_count,
        "matchedNoteCount": matched_note_count,
        "sectionCoverageRatio": coverage_ratio,
        "noteCoverageRatio": note_coverage_ratio,
        "weightedPitchScore": mean_weighted(section_rows, "overallPitchScore", "noteCount"),
        "weightedRhythmScore": mean_weighted(section_rows, "overallRhythmScore", "noteCount"),
        "weightedStudentPitchScore": mean_weighted(section_rows, "studentPitchScore", "noteCount"),
        "weightedStudentRhythmScore": mean_weighted(section_rows, "studentRhythmScore", "noteCount"),
        "weightedConfidence": mean_weighted(section_rows, "confidence", "noteCount"),
        "weightedCombinedScore": mean_weighted(section_rows, "combinedScore", "noteCount"),
        "weightedStudentCombinedScore": mean_weighted(section_rows, "studentCombinedScore", "noteCount"),
        "totalMeasureFindings": int(sum(safe_number(row.get("measureFindingCount"), 0) for row in section_rows)),
        "totalNoteFindings": int(sum(safe_number(row.get("noteFindingCount"), 0) for row in section_rows)),
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
    }


def build_summary_text(summary: dict) -> str:
    weakest = summary.get("weakestSections") or []
    weakest_labels = ", ".join(
        f"{item.get('sequenceIndex')}.{item.get('sectionTitle')}({item.get('combinedScore')})" for item in weakest[:3]
    )
    return (
        f"当前整曲 pass 已覆盖 {summary.get('matchedSectionCount')}/{summary.get('structuredSectionCount')} 个结构化段落，"
        f"加权音准 {summary.get('weightedPitchScore')}，加权节奏 {summary.get('weightedRhythmScore')}，"
        f"整曲优先练习路径为 {summary.get('dominantPracticePath')}。"
        + (f" 当前最弱的段落是 {weakest_labels}。" if weakest_labels else "")
    )


def resolve_cache_dir(output_dir: Path, cache_dir_arg: str) -> Path:
    if cache_dir_arg:
        return (REPO_ROOT / cache_dir_arg).resolve()
    return output_dir / "section-cache"


def build_section_cache_key(piece_id: str, section_id: str, start_seconds: float, duration_seconds: float, preprocess_mode: str) -> str:
    raw = f"{piece_id}|{section_id}|{start_seconds:.2f}|{duration_seconds:.2f}|{preprocess_mode}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def cache_path_for_section(cache_dir: Path, piece_id: str, section_id: str, start_seconds: float, duration_seconds: float, preprocess_mode: str) -> Path:
    cache_key = build_section_cache_key(piece_id, section_id, start_seconds, duration_seconds, preprocess_mode)
    safe_section_id = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in section_id) or "section"
    return cache_dir / f"{safe_section_id}-{cache_key}.json"


def load_cached_section_row(
    cache_dir: Path,
    piece_id: str,
    section_id: str,
    start_seconds: float,
    duration_seconds: float,
    preprocess_mode: str,
) -> dict | None:
    cache_path = cache_path_for_section(cache_dir, piece_id, section_id, start_seconds, duration_seconds, preprocess_mode)
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
    row: dict,
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_path_for_section(cache_dir, piece_id, section_id, start_seconds, duration_seconds, preprocess_mode)
    cache_path.write_text(
        json.dumps(
            {
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


def write_cached_section_row(
    cache_dir: Path,
    piece_id: str,
    section_id: str,
    start_seconds: float,
    duration_seconds: float,
    preprocess_mode: str,
    row: dict,
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_path_for_section(cache_dir, piece_id, section_id, start_seconds, duration_seconds, preprocess_mode)
    cache_path.write_text(
        json.dumps(
            {
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


def main() -> int:
    args = parse_args()
    output_dir = (REPO_ROOT / args.output_dir).resolve()
    scan_output_dir = output_dir / "scan"
    cache_dir = resolve_cache_dir(output_dir, args.cache_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_key = args.score_id or args.piece_id

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

    emit_progress(0.18, "scanning-sections", "正在定位整曲中各段落的最佳窗口。")
    scan_json_path = run_scan(args, scan_output_dir)
    scan_payload = json.loads(scan_json_path.read_text(encoding="utf-8"))
    sequence_path = scan_payload.get("sequenceAwarePath") or []
    section_lookup = {section.get("sectionId"): section for section in piece.get("sections") or []}
    audio_path = (REPO_ROOT / args.audio).resolve()

    section_rows = []
    cache_hits = 0
    total_sections = max(1, len(sequence_path))
    for item in sequence_path:
        section_id = item.get("sectionId")
        section = section_lookup.get(section_id)
        if not section:
            continue
        start_seconds = safe_number(item.get("startSeconds"), 0.0)
        duration_seconds = max(1.0, safe_number(item.get("durationSeconds"), 8.0))
        note_count = len(section.get("notes") or [])
        measure_count = len({note.get("measureIndex") for note in section.get("notes") or []})

        row = None if args.refresh_cache else load_cached_section_row(
            cache_dir,
            str(piece.get("pieceId")),
            str(section_id),
            start_seconds,
            duration_seconds,
            args.preprocess_mode,
        )
        if row:
            cache_hits += 1
            row["rawScanScore"] = item.get("score")
            row["priorAdjustedScore"] = item.get("priorAdjustedScore")
            row["nearestHintDistance"] = item.get("nearestHintDistance")
            section_rows.append(row)
            emit_progress(
                0.35 + (len(section_rows) / total_sections) * 0.5,
                "analyzing-sections",
                f"正在复用并汇总第 {len(section_rows)}/{total_sections} 个段落。",
            )
            continue

        wav_bytes, actual_duration = slice_audio(audio_path, start_seconds, duration_seconds)
        analysis = analyze_window(
            args.analyzer_url,
            piece,
            section,
            wav_bytes,
            actual_duration,
            args.preprocess_mode,
            f"{section_id}-{start_seconds}",
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
            "summaryText": analysis.get("summaryText") or "",
            "teacherComment": analysis.get("teacherComment") or "",
            "practiceTargets": analysis.get("practiceTargets") or [],
            "diagnostics": analysis.get("diagnostics") or {},
        }
        section_rows.append(row)
        write_cached_section_row(
            cache_dir,
            str(piece.get("pieceId")),
            str(section_id),
            start_seconds,
            duration_seconds,
            args.preprocess_mode,
            row,
        )
        emit_progress(
            0.35 + (len(section_rows) / total_sections) * 0.5,
            "analyzing-sections",
            f"正在分析第 {len(section_rows)}/{total_sections} 个段落。",
        )

    section_rows.sort(key=lambda row: (row.get("sequenceIndex") or 0, row.get("startSeconds") or 0))
    summary = summarize_piece_pass(piece, section_rows)
    summary["summaryText"] = build_summary_text(summary)

    json_payload = {
        "pieceId": args.piece_id,
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
                "pieceId": args.piece_id,
                "scoreId": args.score_id,
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
                "pieceId": args.piece_id,
                "scoreId": args.score_id,
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
