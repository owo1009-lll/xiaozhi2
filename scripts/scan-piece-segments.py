from __future__ import annotations

import argparse
import base64
import io
import json
from pathlib import Path
from urllib import error, request

import soundfile as sf


SCRIPT_ROOT = Path(__file__).resolve().parents[1]
CWD_ROOT = Path.cwd().resolve()
REPO_ROOT = CWD_ROOT if (CWD_ROOT / "package.json").exists() and (CWD_ROOT / "scripts").exists() else SCRIPT_ROOT


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scan a long audio file against all sections of a structured piece.")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="Node gateway base URL.")
    parser.add_argument("--analyzer-url", default="http://127.0.0.1:8000", help="Python analyzer base URL.")
    parser.add_argument("--piece-id", default="taohuawu-test-fragment", help="Piece id to scan.")
    parser.add_argument("--score-id", default="", help="Imported score id to scan.")
    parser.add_argument("--audio", default="data/test_audio_mix.mp3", help="Audio file to slice.")
    parser.add_argument("--output-dir", default="data/piece-segment-scan", help="Directory for scan outputs.")
    parser.add_argument("--hint-radius", type=float, default=2.0, help="Seconds around each hint to probe.")
    parser.add_argument("--hint-step", type=float, default=1.0, help="Step size between hint probes.")
    parser.add_argument("--window-padding", type=float, default=4.0, help="Extra seconds added to each expected segment duration.")
    parser.add_argument("--max-candidates-per-section", type=int, default=4, help="Maximum slice starts to test for each section.")
    parser.add_argument("--max-sections", type=int, default=0, help="Optional hard cap on section count for faster scans.")
    parser.add_argument("--section-id", action="append", default=[], help="Only scan selected section ids. Repeatable.")
    parser.add_argument("--section-ids", default="", help="Comma-separated section ids. Prefer this on Windows shells that mangle repeated flags.")
    return parser.parse_args()


def read_json(url: str) -> dict:
    with request.urlopen(url, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req, timeout=240) as response:
        return json.loads(response.read().decode("utf-8"))


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
        end_beat = (float(note.get("measureIndex", 1)) - 1.0) * beats_per_measure + float(note.get("beatStart", 0.0)) + float(note.get("beatDuration", 1.0))
        max_offset = max(max_offset, end_beat)
    return max(max_offset, beats_per_measure)


def slice_audio(audio_path: Path, start_seconds: float, duration_seconds: float) -> tuple[bytes, float]:
    info = sf.info(str(audio_path))
    start_frame = max(0, int(start_seconds * info.samplerate))
    end_frame = min(info.frames, start_frame + int(duration_seconds * info.samplerate))
    waveform, sample_rate = sf.read(str(audio_path), start=start_frame, stop=end_frame, dtype="float32")
    buffer = io.BytesIO()
    sf.write(buffer, waveform, sample_rate, format="WAV")
    return buffer.getvalue(), len(waveform) / sample_rate


def analyze_window(analyzer_url: str, piece: dict, section: dict, wav_bytes: bytes, duration_seconds: float, label: str) -> dict:
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
        "participantId": f"scan-{label}",
        "groupId": "scan",
        "sessionStage": "pretest",
        "pieceId": piece.get("pieceId"),
        "sectionId": section.get("sectionId"),
        "preprocessMode": "auto",
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


def score_analysis(analysis: dict) -> float:
    pitch_score = float(analysis.get("overallPitchScore") or 0)
    rhythm_score = float(analysis.get("overallRhythmScore") or 0)
    confidence = float(analysis.get("confidence") or 0)
    measure_penalty = len(analysis.get("measureFindings") or []) * 0.8
    note_penalty = len(analysis.get("noteFindings") or []) * 0.4
    return round(pitch_score * 0.45 + rhythm_score * 0.45 + confidence * 10 - measure_penalty - note_penalty, 2)


def nearest_hint_distance(start_seconds: float, hints: list[float]) -> float | None:
    if not hints:
        return None
    return round(min(abs(start_seconds - float(hint)) for hint in hints), 2)


def prior_adjusted_score(raw_score: float, hint_distance: float | None, expected_sequence: int, actual_sequence: int) -> float:
    adjusted = raw_score
    if hint_distance is not None:
        adjusted -= hint_distance * 1.75
    if expected_sequence > 0 and actual_sequence > 0:
        adjusted -= abs(expected_sequence - actual_sequence) * 2.5
    return round(adjusted, 2)


def build_candidates(hints: list[float], hint_radius: float, hint_step: float, max_candidates: int) -> list[float]:
    if not hints:
        return [0.0]

    unique_candidates: set[float] = set()
    distances = [0.0]
    if hint_step > 0:
        distance = hint_step
        while distance <= hint_radius + 1e-6:
            distances.append(round(distance, 3))
            distance += hint_step

    for hint in hints:
        hint_value = float(hint)
        unique_candidates.add(round(max(0.0, hint_value), 2))
        for distance in distances[1:]:
            unique_candidates.add(round(max(0.0, hint_value - distance), 2))
            unique_candidates.add(round(max(0.0, hint_value + distance), 2))

    ranked = sorted(
        unique_candidates,
        key=lambda candidate: (
            min(abs(candidate - float(hint)) for hint in hints),
            candidate,
        ),
    )
    return ranked[: max(1, max_candidates)]


def scan_section(
    analyzer_url: str,
    audio_path: Path,
    piece: dict,
    section: dict,
    hint_radius: float,
    hint_step: float,
    window_padding: float,
    max_candidates: int,
) -> dict:
    hints = section.get("researchWindowHints") or [0.0]
    expected_duration = section_length_beats(section) * (60.0 / max(30.0, float(section.get("tempo") or 72)))
    window_duration = max(expected_duration + window_padding, expected_duration * 1.6, 8.0)

    candidates = build_candidates([float(hint) for hint in hints], hint_radius, hint_step, max_candidates)

    best = None
    attempts = []
    for start_seconds in candidates:
        wav_bytes, actual_duration = slice_audio(audio_path, start_seconds, window_duration)
        analysis = analyze_window(analyzer_url, piece, section, wav_bytes, actual_duration, f"{section.get('sectionId')}-{start_seconds}")
        score = score_analysis(analysis)
        hint_distance = nearest_hint_distance(start_seconds, [float(hint) for hint in hints])
        summary = {
            "sectionId": section.get("sectionId"),
            "sectionTitle": section.get("title"),
            "sequenceIndex": int(section.get("sequenceIndex") or 0),
            "startSeconds": start_seconds,
            "durationSeconds": round(actual_duration, 2),
            "score": score,
            "nearestHintDistance": hint_distance,
            "priorAdjustedScore": prior_adjusted_score(score, hint_distance, int(section.get("sequenceIndex") or 0), int(section.get("sequenceIndex") or 0)),
            "overallPitchScore": analysis.get("overallPitchScore"),
            "overallRhythmScore": analysis.get("overallRhythmScore"),
            "confidence": analysis.get("confidence"),
            "recommendedPracticePath": analysis.get("recommendedPracticePath"),
            "measureFindingCount": len(analysis.get("measureFindings") or []),
            "noteFindingCount": len(analysis.get("noteFindings") or []),
            "summaryText": analysis.get("summaryText") or "",
            "diagnostics": analysis.get("diagnostics") or {},
        }
        attempts.append(summary)
        if best is None or summary["priorAdjustedScore"] > best["priorAdjustedScore"]:
            best = summary

    attempts.sort(key=lambda item: (item["priorAdjustedScore"], item["score"]), reverse=True)
    return {
        "sectionId": section.get("sectionId"),
        "sectionTitle": section.get("title"),
        "sequenceIndex": int(section.get("sequenceIndex") or 0),
        "expectedDurationSeconds": round(expected_duration, 2),
        "windowDurationSeconds": round(window_duration, 2),
        "candidateCount": len(candidates),
        "bestMatch": best,
        "topMatches": attempts[:3],
    }


def select_sequence_path(scan_results: list[dict]) -> list[dict]:
    ordered_results = sorted(scan_results, key=lambda item: item.get("sequenceIndex") or 0)
    path = []
    previous_start = -1.0

    for item in ordered_results:
        choices = item.get("topMatches") or []
        selected = None
        for candidate in choices:
            candidate_start = float(candidate.get("startSeconds") or 0.0)
            if previous_start < 0 or candidate_start >= previous_start:
                selected = candidate
                break
        if selected is None and choices:
            selected = choices[0]
        if selected is not None:
            previous_start = float(selected.get("startSeconds") or previous_start)
            path.append(
                {
                    "sectionId": item.get("sectionId"),
                    "sectionTitle": item.get("sectionTitle"),
                    "sequenceIndex": item.get("sequenceIndex"),
                    **selected,
                }
            )

    return path


def main() -> int:
    args = parse_args()
    output_dir = (REPO_ROOT / args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        read_json(f"{args.base_url}/api/health")
        read_json(f"{args.analyzer_url}/health")
        if args.score_id:
            piece_json = read_json(f"{args.base_url}/api/erhu/pieces/from-score/{args.score_id}")
        else:
            piece_json = read_json(f"{args.base_url}/api/erhu/pieces/{args.piece_id}")
    except error.URLError as exc:
        raise SystemExit(f"service check failed: {exc}") from exc

    piece = piece_json.get("piece") or {}
    audio_path = (REPO_ROOT / args.audio).resolve()

    selected_section_ids = {value.strip() for value in args.section_id if value and value.strip()}
    if args.section_ids:
        selected_section_ids.update(value.strip() for value in str(args.section_ids).split(",") if value.strip())
    sections = piece.get("sections", [])
    if selected_section_ids:
        sections = [section for section in sections if section.get("sectionId") in selected_section_ids]
    if args.max_sections and args.max_sections > 0:
        sections = sections[: args.max_sections]

    scan_results = []
    for section in sections:
        if not section.get("notes"):
            continue
        scan_results.append(
            scan_section(
                args.analyzer_url,
                audio_path,
                piece,
                section,
                args.hint_radius,
                args.hint_step,
                args.window_padding,
                args.max_candidates_per_section,
            )
        )

    ranked = sorted(
        [
            {
                "sectionId": item["sectionId"],
                "sectionTitle": item["sectionTitle"],
                "sequenceIndex": item.get("sequenceIndex"),
                **(item["bestMatch"] or {}),
            }
            for item in scan_results
            if item.get("bestMatch")
        ],
        key=lambda item: item["priorAdjustedScore"],
        reverse=True,
    )
    sequence_path = select_sequence_path(scan_results)

    (output_dir / f"{args.piece_id}-segment-scan.json").write_text(
        json.dumps(
            {
                "pieceId": args.piece_id,
                "audio": str(audio_path),
                "scanResults": scan_results,
                "rankedMatches": ranked,
                "sequenceAwarePath": sequence_path,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    lines = [
        "# Piece Segment Scan Report",
        "",
        f"- Piece: {piece.get('title')} ({args.piece_id})",
        f"- Audio: {audio_path}",
        "",
        "## Ranked best matches",
        "",
    ]
    for item in ranked:
        lines.extend(
            [
                f"### {item['sectionId']} / {item['sectionTitle']}",
                f"- Best window: {item['startSeconds']}s - {round(item['startSeconds'] + item['durationSeconds'], 2)}s",
                f"- Score: {item['score']}",
                f"- Pitch / rhythm: {item['overallPitchScore']} / {item['overallRhythmScore']}",
                f"- Practice path: {item['recommendedPracticePath']}",
                f"- Summary: {item['summaryText']}",
                "",
            ]
        )
    lines.extend(
        [
            "## Sequence-aware path",
            "",
        ]
    )
    for item in sequence_path:
        lines.extend(
            [
                f"### {item['sequenceIndex']}. {item['sectionId']} / {item['sectionTitle']}",
                f"- Selected window: {item['startSeconds']}s - {round(item['startSeconds'] + item['durationSeconds'], 2)}s",
                f"- Prior-adjusted score: {item['priorAdjustedScore']}",
                f"- Raw score: {item['score']}",
                f"- Hint distance: {item.get('nearestHintDistance')}",
                "",
            ]
        )
    (output_dir / f"{args.piece_id}-segment-scan.md").write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps({"pieceId": args.piece_id, "sectionCount": len(scan_results), "topMatch": ranked[0] if ranked else None, "sequencePathLength": len(sequence_path), "outputDir": str(output_dir)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
