from __future__ import annotations

import argparse
import base64
import io
import json
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
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
    parser.add_argument("--omit-measures", default="", help="Comma-separated score measure ranges skipped by the audio, e.g. 202-211.")
    parser.add_argument("--scan-preprocess-mode", default="off", help="preprocessMode sent to the analyzer during scan windows. 'off' skips source separation for speed.")
    parser.add_argument("--concurrency", type=int, default=2, help="Number of sections to scan in parallel.")
    parser.add_argument("--retry", type=int, default=2, help="Max retries per section on connection errors.")
    parser.add_argument(
        "--alignment-mode",
        choices=["hint", "content"],
        default="hint",
        help="hint (default): legacy sequence-index timing hints. content: locate each "
        "section in the recording by chroma subsequence DTW before scanning.",
    )
    parser.add_argument("--content-hint-radius", type=float, default=1.0, help="Probe radius around content-aligned starts (content mode).")
    return parser.parse_args()


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
        result = float(value)
        return result if result == result else float(fallback)  # reject NaN
    except (TypeError, ValueError):
        return float(fallback)


def meter_beats(meter: str | None) -> float:
    if not meter:
        return 4.0
    beats = str(meter).split("/")[0]
    try:
        return max(1.0, float(beats))
    except ValueError:
        return 4.0


def section_to_alignment_dict(section: dict) -> dict:
    """Adapt a real piece section into the minimal shape content_alignment expects.

    The erhu-line role lives at note.notePosition.scoreLineRole. We carry it onto a
    flat `role` field. If ANY note in the section declares a role, we trust those
    roles strictly (notes without an explicit "erhu" role are treated as
    accompaniment and excluded from the template). Only when the section has no role
    annotation at all do we fall back to treating every note as erhu (built-in
    single-line pieces such as the taohuawu fragment have no scoreLineRole)."""
    notes = section.get("notes") or []
    has_role = any((note.get("notePosition") or {}).get("scoreLineRole") for note in notes)
    adapted_notes = []
    for note in notes:
        role = str((note.get("notePosition") or {}).get("scoreLineRole") or "").strip().lower()
        effective_role = role if has_role else "erhu"
        adapted_notes.append({
            "midiPitch": note.get("midiPitch", 0),
            "beatStart": note.get("beatStart", 0.0),
            "beatDuration": note.get("beatDuration", 1.0),
            "role": effective_role or "unknown",
        })
    return {
        "sectionId": section.get("sectionId"),
        "sequenceIndex": int(safe_number(section.get("sequenceIndex"), 0)),
        "tempo": section.get("tempo") or 72,
        "notes": adapted_notes,
    }


def compute_content_alignment(audio_path: Path, ordered_sections: list[dict]) -> list[dict]:
    """Run chroma subsequence-DTW occurrence alignment for the scanned sections.

    Returns a LIST aligned 1:1 with `ordered_sections` (same order in, same order
    out), each {start,end,duration,score}. A list (slot index), not a dict keyed
    by sectionId, so a section that recurs keeps a distinct window per occurrence
    -- a dict key would let the 2nd occurrence overwrite the 1st and silently drop
    the B1 repeat-rounds guarantee. Import is local so the legacy hint path never
    needs librosa/content_alignment."""
    sys.path.insert(0, str(SCRIPT_ROOT / "scripts" / "lib"))
    import content_alignment as ca  # noqa: E402

    waveform, sample_rate = sf.read(str(audio_path), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sample_rate != ca.DEFAULT_SR:
        import librosa
        waveform = librosa.resample(waveform, orig_sr=sample_rate, target_sr=ca.DEFAULT_SR)
    play_order = [section_to_alignment_dict(s) for s in ordered_sections]
    aligned = ca.align_occurrences(play_order, waveform)
    result = []
    for entry in aligned:
        result.append({
            "start": float(entry["start"]),
            "end": float(entry["end"]),
            "duration": round(float(entry["end"]) - float(entry["start"]), 3),
            "score": entry.get("cost"),
        })
    return result


def section_length_beats(section: dict) -> float:
    beats_per_measure = meter_beats(section.get("meter"))
    notes = section.get("notes") or []
    min_measure_index = min(
        (float(note.get("measureIndex", 1)) for note in notes),
        default=1.0,
    )
    max_offset = 0.0
    for note in notes:
        end_beat = (float(note.get("measureIndex", 1)) - min_measure_index) * beats_per_measure + float(note.get("beatStart", 0.0)) + float(note.get("beatDuration", 1.0))
        max_offset = max(max_offset, end_beat)
    return max(max_offset, beats_per_measure)


def parse_measure_ranges(raw: str | None) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for token in str(raw or "").replace(";", ",").split(","):
        text = token.strip()
        if not text:
            continue
        if "-" in text:
            left, right = text.split("-", 1)
        elif ":" in text:
            left, right = text.split(":", 1)
        else:
            left = right = text
        try:
            start = max(1, int(float(left.strip())))
            end = max(1, int(float(right.strip())))
        except ValueError:
            continue
        ranges.append((min(start, end), max(start, end)))
    return ranges


def positive_int(value: object) -> int:
    try:
        numeric = int(float(value))  # type: ignore[arg-type]
        return numeric if numeric > 0 else 0
    except (TypeError, ValueError):
        return 0


def section_measure_bounds(section: dict) -> tuple[int, int] | None:
    measures = [
        positive_int(note.get("measureIndex"))
        for note in (section.get("notes") or [])
        if positive_int(note.get("measureIndex")) > 0
    ]
    if not measures:
        raw_range = section.get("measureRange") or []
        measures = [positive_int(value) for value in raw_range if positive_int(value) > 0]
    if not measures:
        return None
    return min(measures), max(measures)


def section_intersects_measure_ranges(section: dict, ranges: list[tuple[int, int]]) -> bool:
    if not ranges:
        return False
    bounds = section_measure_bounds(section)
    if bounds is None:
        return False
    start, end = bounds
    return any(start <= range_end and end >= range_start for range_start, range_end in ranges)


def slice_audio(audio_path: Path, start_seconds: float, duration_seconds: float) -> tuple[bytes, float]:
    info = sf.info(str(audio_path))
    start_frame = max(0, int(start_seconds * info.samplerate))
    end_frame = min(info.frames, start_frame + int(duration_seconds * info.samplerate))
    waveform, sample_rate = sf.read(str(audio_path), start=start_frame, stop=end_frame, dtype="float32")
    buffer = io.BytesIO()
    sf.write(buffer, waveform, sample_rate, format="WAV")
    return buffer.getvalue(), len(waveform) / sample_rate


def analyze_window(analyzer_url: str, piece: dict, section: dict, wav_bytes: bytes, duration_seconds: float, label: str, scan_preprocess_mode: str = "off") -> dict:
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
        "preprocessMode": scan_preprocess_mode,
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


def add_fallback_timing_hints(sections: list[dict], audio_duration: float) -> list[dict]:
    if audio_duration <= 0 or not sections:
        return sections
    hinted = [section for section in sections if section.get("researchWindowHints")]
    if len(hinted) >= max(2, int(len(sections) * 0.4)):
        return sections

    ordered = sorted(sections, key=lambda item: int(item.get("sequenceIndex") or 0))
    count = max(1, len(ordered))
    # Keep the last generated hint before the end of the file so the scan window
    # still has room for the final phrase.
    usable_span = max(8.0, audio_duration * 0.9)
    generated: dict[str, float] = {}
    for index, section in enumerate(ordered):
        section_id = str(section.get("sectionId") or "")
        generated[section_id] = round((index / max(1, count - 1)) * usable_span, 2)

    patched: list[dict] = []
    for section in sections:
        if section.get("researchWindowHints"):
            patched.append(section)
            continue
        section_id = str(section.get("sectionId") or "")
        patched.append({**section, "researchWindowHints": [generated.get(section_id, 0.0)]})
    return patched


def scan_section(
    analyzer_url: str,
    audio_path: Path,
    piece: dict,
    section: dict,
    hint_radius: float,
    hint_step: float,
    window_padding: float,
    max_candidates: int,
    scan_preprocess_mode: str = "off",
    content_duration: float | None = None,
) -> dict:
    hints = section.get("researchWindowHints") or [0.0]
    expected_duration = section_length_beats(section) * (60.0 / max(30.0, float(section.get("tempo") or 72)))
    # Content mode: trust the chroma-aligned duration for the window so a wrong
    # tempo/rest estimate cannot truncate or overshoot. Hint mode: keep the legacy
    # beats/tempo estimate.
    if content_duration is not None and content_duration > 0:
        window_duration = max(content_duration + window_padding, 4.0)
    else:
        window_duration = max(expected_duration + window_padding, expected_duration * 1.6, 8.0)

    candidates = build_candidates([float(hint) for hint in hints], hint_radius, hint_step, max_candidates)

    best = None
    attempts = []
    for start_seconds in candidates:
        wav_bytes, actual_duration = slice_audio(audio_path, start_seconds, window_duration)
        analysis = analyze_window(analyzer_url, piece, section, wav_bytes, actual_duration, f"{section.get('sectionId')}-{start_seconds}", scan_preprocess_mode)
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
            "measureFindings": analysis.get("measureFindings") or [],
            "noteFindings": analysis.get("noteFindings") or [],
            "demoSegments": analysis.get("demoSegments") or [],
            "studentPitchScore": analysis.get("studentPitchScore", analysis.get("overallPitchScore")),
            "studentRhythmScore": analysis.get("studentRhythmScore", analysis.get("overallRhythmScore")),
            "studentCombinedScore": analysis.get("studentCombinedScore"),
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
        # Content-alignment provenance so audits can compare the chroma-aligned
        # window against the score-estimated one (None in legacy hint mode).
        "contentStartSeconds": section.get("contentStartSeconds"),
        "contentEndSeconds": section.get("contentEndSeconds"),
        "contentDurationSeconds": section.get("contentDurationSeconds"),
        "contentAlignmentScore": section.get("contentAlignmentScore"),
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

    sections_to_scan = [s for s in sections if s.get("notes")]
    omitted_measure_ranges = parse_measure_ranges(args.omit_measures)
    omitted_sections: list[dict] = []
    if omitted_measure_ranges:
        kept_sections: list[dict] = []
        for section in sections_to_scan:
            if section_intersects_measure_ranges(section, omitted_measure_ranges):
                omitted_sections.append(section)
            else:
                kept_sections.append(section)
        sections_to_scan = kept_sections
        sys.stderr.write(
            f"INFO: omitted measure ranges {omitted_measure_ranges}; "
            f"skipping {len(omitted_sections)} intersecting sections.\n"
        )

    # Coverage detection: if audio is shorter than the piece, only scan reachable sections.
    audio_duration = 0.0
    estimated_piece_duration = 0.0
    is_partial = False
    skipped_beyond_audio: list[dict] = []
    use_content_alignment = args.alignment_mode == "content"

    try:
        audio_info = sf.info(str(audio_path))
        audio_duration = audio_info.duration

        if use_content_alignment:
            # Content mode: locate each section in the recording by chroma DTW and
            # write those true starts as the sole timing hints. Apply results by
            # SLOT ORDER (not sectionId) so a recurring section keeps a distinct
            # window per occurrence. The legacy fallback-hint generator AND the
            # hint rescale/partial logic below are skipped entirely -- they assume
            # sequence-index timing and would re-scale or truncate content windows
            # (e.g. when the last section sits near the file end), destroying the
            # alignment. Content computes its own estimatedPieceDuration from the
            # aligned ends.
            ordered_sections = sorted(sections_to_scan, key=lambda s: int(safe_number(s.get("sequenceIndex"), 0)))
            aligned_list = compute_content_alignment(audio_path, ordered_sections)
            for section, aligned in zip(ordered_sections, aligned_list):
                section["researchWindowHints"] = [round(aligned["start"], 2)]
                section["contentStartSeconds"] = round(aligned["start"], 3)
                section["contentEndSeconds"] = round(aligned["end"], 3)
                section["contentDurationSeconds"] = round(aligned["duration"], 3)
                section["contentAlignmentScore"] = aligned["score"]
            aligned_ends = [a["end"] for a in aligned_list]
            estimated_piece_duration = max(aligned_ends) if aligned_ends else 0.0
        else:
            sections_to_scan = add_fallback_timing_hints(sections_to_scan, audio_duration)

            all_hints = [float(h) for s in sections_to_scan for h in (s.get("researchWindowHints") or [])]
            if all_hints:
                max_hint = max(all_hints)
                estimated_piece_duration = max_hint

                # For imported OMR scores, section timing hints are estimated from generated
                # score chunks and can be much longer than the real recording. Do not use
                # those hints to declare a full recording "partial".
                if not args.score_id and max_hint > audio_duration * 1.8:
                    is_partial = True
                    coverage_limit = audio_duration * 1.35  # generous buffer for tempo variation
                    within: list[dict] = []
                    beyond: list[dict] = []
                    for s in sections_to_scan:
                        sec_max_hint = max(float(h) for h in (s.get("researchWindowHints") or [0.0]))
                        (within if sec_max_hint <= coverage_limit else beyond).append(s)
                    sections_to_scan = within
                    skipped_beyond_audio = beyond
                    sys.stderr.write(
                        f"INFO: partial audio ({audio_duration:.1f}s / ~{estimated_piece_duration:.1f}s piece). "
                        f"Scanning {len(within)} sections, skipping {len(beyond)} beyond audio.\n"
                    )

                # Rescale hints within the coverage range if they still exceed audio duration.
                within_hints = [float(h) for s in sections_to_scan for h in (s.get("researchWindowHints") or [])]
                if within_hints:
                    within_max = max(within_hints)
                    if within_max > audio_duration * 0.95:
                        scale = (audio_duration * 0.88) / within_max
                        sys.stderr.write(
                            f"INFO: hints rescaled by {scale:.3f} "
                            f"(max_hint={within_max:.1f}s > audio={audio_duration:.1f}s)\n"
                        )
                        sections_to_scan = [
                            {**s, "researchWindowHints": [round(max(0.0, float(h) * scale), 2) for h in (s.get("researchWindowHints") or [])]}
                            if s.get("researchWindowHints") else s
                            for s in sections_to_scan
                        ]
    except Exception as _hint_exc:
        sys.stderr.write(f"WARNING: coverage detection failed: {_hint_exc}\n")

    scan_results = []

    def _scan_one(section: dict) -> dict:
        last_exc: Exception | None = None
        for attempt in range(max(1, args.retry + 1)):
            try:
                return scan_section(
                    args.analyzer_url,
                    audio_path,
                    piece,
                    section,
                    args.content_hint_radius if use_content_alignment else args.hint_radius,
                    args.hint_step,
                    args.window_padding,
                    args.max_candidates_per_section,
                    args.scan_preprocess_mode,
                    content_duration=section.get("contentDurationSeconds") if use_content_alignment else None,
                )
            except Exception as exc:
                last_exc = exc
                if attempt < args.retry:
                    # Jittered backoff: base delay + random offset to avoid thundering herd
                    time.sleep(3 * (attempt + 1) + random.uniform(0, 2))
        raise last_exc  # type: ignore[misc]

    skipped_count = 0
    if args.concurrency <= 1 or len(sections_to_scan) <= 1:
        for section in sections_to_scan:
            scan_results.append(_scan_one(section))
    else:
        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            future_map = {executor.submit(_scan_one, section): section for section in sections_to_scan}
            for future in as_completed(future_map):
                section = future_map[future]
                try:
                    scan_results.append(future.result())
                except Exception as exc:
                    skipped_count += 1
                    sys.stderr.write(
                        f"WARNING: scan skipped {section.get('sectionId')} after retries: {exc}\n"
                    )

    # Fail loudly if too many sections were skipped — prevents silent garbage results.
    min_ok = max(1, int(len(sections_to_scan) * 0.5))
    if len(scan_results) < min_ok:
        raise SystemExit(
            f"scan aborted: only {len(scan_results)}/{len(sections_to_scan)} sections succeeded "
            f"({skipped_count} skipped after retries). Reduce --concurrency or check analyzer health."
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

    output_key = args.score_id or args.piece_id
    last_scanned_section_id = sequence_path[-1]["sectionId"] if sequence_path else None
    audio_coverage = {
        "audioDurationSeconds": round(audio_duration, 2),
        "estimatedPieceDurationSeconds": round(estimated_piece_duration, 2),
        "isPartial": is_partial,
        "scannedSectionCount": len(scan_results),
        "skippedSectionCount": len(skipped_beyond_audio) + len(omitted_sections),
        "lastScannedSectionId": last_scanned_section_id,
        "skippedSectionIds": [s.get("sectionId") for s in skipped_beyond_audio] + [s.get("sectionId") for s in omitted_sections],
        "omittedMeasureRanges": [[start, end] for start, end in omitted_measure_ranges],
        "omittedSectionIds": [s.get("sectionId") for s in omitted_sections],
        "scanMode": "content-aligned" if use_content_alignment else "analyzer-window",
    }
    if use_content_alignment:
        # Coverage semantics relative to THIS scan's selected sections, so a small
        # --max-sections / --section-ids / omit run is not mislabeled partial
        # (reviewer #2 + #5). selected = sections actually scanned (post note/omit
        # filtering), not the pre-filter count. Aligned results carry their content
        # window in the scan_result itself (occurrence-safe; no sectionId keying).
        structured_section_count = len(piece.get("sections") or [])
        selected_section_count = len(sections_to_scan)
        aligned_results = [s for s in scan_results if s.get("contentStartSeconds") is not None]
        aligned_section_count = len(aligned_results)
        aligned_windows = sorted(
            ((float(s["contentStartSeconds"]), float(s["contentEndSeconds"])) for s in aligned_results),
            key=lambda w: w[0],
        )
        aligned_span = round(aligned_windows[-1][1] - aligned_windows[0][0], 2) if aligned_windows else 0.0
        # expected = sum of aligned sections' score-estimated durations (divisor for
        # the partial alignedSpanRatio gate; full-piece uses estimatedPieceDuration).
        # expectedDurationSeconds is already on each scan_result.
        expected_aligned_span = round(sum(
            float(s.get("expectedDurationSeconds") or 0.0) for s in aligned_results
        ), 2)
        full_selected = aligned_section_count == selected_section_count and selected_section_count > 0
        full_piece = full_selected and selected_section_count == structured_section_count
        # full-piece estimatedPieceDuration = last aligned END (not last start)
        aligned_piece_end = round(max((w[1] for w in aligned_windows), default=0.0), 2)
        audio_coverage.update({
            "structuredSectionCount": structured_section_count,
            "selectedSectionCount": selected_section_count,
            "alignedSectionCount": aligned_section_count,
            "alignmentCoverageMode": "full-selected" if full_selected else "partial-selected",
            "wholePieceCoverageMode": "full-piece" if full_piece else "partial-piece",
            "alignedSpanDurationSeconds": aligned_span,
            "expectedAlignedSpanDurationSeconds": expected_aligned_span,
            # estimatedPieceDurationSeconds only meaningful for whole-piece coverage,
            # and is the last aligned END so durationRatio is not underestimated.
            "estimatedPieceDurationSeconds": aligned_piece_end if full_piece else None,
        })
    (output_dir / f"{output_key}-segment-scan.json").write_text(
        json.dumps(
            {
                "pieceId": output_key,
                "audio": str(audio_path),
                "audioCoverage": audio_coverage,
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
        f"- Piece: {piece.get('title')} ({output_key})",
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
    (output_dir / f"{output_key}-segment-scan.md").write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps({"pieceId": output_key, "sectionCount": len(scan_results), "topMatch": ranked[0] if ranked else None, "sequencePathLength": len(sequence_path), "outputDir": str(output_dir)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
