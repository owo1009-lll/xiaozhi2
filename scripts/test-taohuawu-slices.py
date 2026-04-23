from __future__ import annotations

import argparse
import base64
import csv
import io
import json
from dataclasses import dataclass
from pathlib import Path
from urllib import error, request

import soundfile as sf


SCRIPT_ROOT = Path(__file__).resolve().parents[1]
CWD_ROOT = Path.cwd().resolve()
REPO_ROOT = CWD_ROOT if (CWD_ROOT / "package.json").exists() and (CWD_ROOT / "scripts").exists() else SCRIPT_ROOT


DEFAULT_SLICES = [
    ("entry-a", 6.0, 12.0),
    ("entry-b", 8.0, 12.0),
    ("entry-c", 10.0, 12.0),
    ("entry-d", 12.0, 12.0),
    ("entry-e", 14.0, 12.0),
    ("late-control", 40.0, 12.0),
]


@dataclass
class SliceSpec:
    label: str
    start: float
    duration: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run repeated slice tests for the built-in Taohuawu fragment.")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="Node gateway base URL.")
    parser.add_argument("--analyzer-url", default="http://127.0.0.1:8000", help="Python analyzer base URL.")
    parser.add_argument("--piece-id", default="taohuawu-test-fragment", help="Built-in piece id.")
    parser.add_argument("--section-id", default="entry-phrase", help="Built-in section id.")
    parser.add_argument("--audio", default="data/test_audio_mix.mp3", help="Audio file to slice.")
    parser.add_argument("--output-dir", default="data/taohuawu-slice-tests", help="Directory for JSON/CSV/Markdown outputs.")
    parser.add_argument(
        "--slice",
        action="append",
        default=[],
        help="Override or add slices as label:start:duration, for example entry-a:8:12",
    )
    return parser.parse_args()


def read_json(url: str) -> dict:
    with request.urlopen(url, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req, timeout=240) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_slice_specs(raw_specs: list[str]) -> list[SliceSpec]:
    if not raw_specs:
        return [SliceSpec(label, start, duration) for label, start, duration in DEFAULT_SLICES]

    slices: list[SliceSpec] = []
    for raw in raw_specs:
        label, start, duration = raw.split(":")
        slices.append(SliceSpec(label=label.strip(), start=float(start), duration=float(duration)))
    return slices


def load_piece_pack(base_url: str, piece_id: str, section_id: str) -> dict:
    piece_json = read_json(f"{base_url}/api/erhu/pieces/{piece_id}")
    piece = piece_json.get("piece") or {}
    section = next((item for item in piece.get("sections", []) if item.get("sectionId") == section_id), None)
    if not section:
        raise RuntimeError(f"section not found: {piece_id}/{section_id}")
    return {
        "pieceId": piece.get("pieceId"),
        "sectionId": section.get("sectionId"),
        "title": piece.get("title"),
        "meter": section.get("meter"),
        "tempo": section.get("tempo"),
        "demoAudio": section.get("demoAudio", ""),
        "notes": section.get("notes", []),
    }


def slice_audio(audio_path: Path, start_seconds: float, duration_seconds: float) -> tuple[bytes, int, float]:
    info = sf.info(str(audio_path))
    start_frame = max(0, int(start_seconds * info.samplerate))
    end_frame = min(info.frames, start_frame + int(duration_seconds * info.samplerate))
    if end_frame <= start_frame:
        raise RuntimeError(f"invalid slice range: {start_seconds}-{start_seconds + duration_seconds}")

    waveform, sample_rate = sf.read(str(audio_path), start=start_frame, stop=end_frame, dtype="float32")
    buffer = io.BytesIO()
    sf.write(buffer, waveform, sample_rate, format="WAV")
    actual_duration = len(waveform) / sample_rate
    return buffer.getvalue(), sample_rate, actual_duration


def summarize_result(label: str, start: float, duration: float, analysis: dict) -> dict:
    diagnostics = analysis.get("diagnostics") or {}
    overall_pitch = float(analysis.get("overallPitchScore") or 0)
    overall_rhythm = float(analysis.get("overallRhythmScore") or 0)
    combined = round((overall_pitch + overall_rhythm) / 2, 2)
    return {
        "label": label,
        "startSeconds": round(start, 2),
        "durationSeconds": round(duration, 2),
        "overallPitchScore": round(overall_pitch, 2),
        "overallRhythmScore": round(overall_rhythm, 2),
        "combinedScore": combined,
        "recommendedPracticePath": analysis.get("recommendedPracticePath") or "",
        "measureFindingCount": len(analysis.get("measureFindings") or []),
        "noteFindingCount": len(analysis.get("noteFindings") or []),
        "summaryText": analysis.get("summaryText") or "",
        "alignmentMode": diagnostics.get("alignmentMode") or "",
        "scoreNoteCount": diagnostics.get("scoreNoteCount"),
        "alignedNoteCount": diagnostics.get("alignedNoteCount"),
        "pitchTrackCount": diagnostics.get("pitchTrackCount"),
        "preprocessApplied": diagnostics.get("preprocessApplied"),
        "appliedPreprocessMode": diagnostics.get("appliedPreprocessMode") or "",
        "rhythmTypeCounts": json.dumps(diagnostics.get("rhythmTypeCounts") or {}, ensure_ascii=False),
    }


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def write_report(path: Path, piece_pack: dict, rows: list[dict]) -> None:
    lines = [
        "# Taohuawu Slice Test Report",
        "",
        f"- Piece fragment: {piece_pack.get('title')} / {piece_pack.get('sectionId')}",
        f"- Tempo and meter: {piece_pack.get('tempo')} BPM / {piece_pack.get('meter')}",
        f"- Note count: {len(piece_pack.get('notes') or [])}",
        "",
        "## Summary",
        "",
    ]

    for row in rows:
        lines.extend(
            [
                f"### {row['label']}",
                f"- Time window: {row['startSeconds']}s - {round(row['startSeconds'] + row['durationSeconds'], 2)}s",
                f"- Combined score: {row['combinedScore']} / pitch {row['overallPitchScore']} / rhythm {row['overallRhythmScore']}",
                f"- Practice path: {row['recommendedPracticePath']}",
                f"- Measure findings / note findings: {row['measureFindingCount']} / {row['noteFindingCount']}",
                f"- Summary: {row['summaryText']}",
                "",
            ]
        )

    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    args = parse_args()
    output_dir = (REPO_ROOT / args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        read_json(f"{args.base_url}/api/health")
        read_json(f"{args.analyzer_url}/health")
    except error.URLError as exc:
        raise SystemExit(f"service check failed: {exc}") from exc

    piece_pack = load_piece_pack(args.base_url, args.piece_id, args.section_id)
    slice_specs = parse_slice_specs(args.slice)
    audio_path = (REPO_ROOT / args.audio).resolve()

    rows: list[dict] = []
    analysis_details: dict[str, dict] = {}

    for spec in slice_specs:
        wav_bytes, sample_rate, actual_duration = slice_audio(audio_path, spec.start, spec.duration)
        audio_data_url = "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode("ascii")
        payload = {
            "participantId": f"slice-{spec.label}",
            "groupId": "pilot",
            "sessionStage": "pretest",
            "pieceId": piece_pack.get("pieceId"),
            "sectionId": piece_pack.get("sectionId"),
            "preprocessMode": "auto",
            "piecePack": piece_pack,
            "audioSubmission": {
                "name": f"{spec.label}.wav",
                "mimeType": "audio/wav",
                "size": len(wav_bytes),
                "duration": actual_duration,
                "sampleRate": sample_rate,
            },
            "audioDataUrl": audio_data_url,
        }
        response = post_json(f"{args.analyzer_url}/analyze", payload)
        analysis = response.get("analysis") or {}
        summary = summarize_result(spec.label, spec.start, actual_duration, analysis)
        rows.append(summary)
        analysis_details[spec.label] = analysis

    rows.sort(key=lambda item: item["combinedScore"], reverse=True)

    (output_dir / "summary.json").write_text(
        json.dumps(
            {
                "pieceId": args.piece_id,
                "sectionId": args.section_id,
                "audio": str(audio_path),
                "slices": rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (output_dir / "analysis-details.json").write_text(json.dumps(analysis_details, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(output_dir / "summary.csv", rows)
    write_report(output_dir / "report.md", piece_pack, rows)

    print(
        json.dumps(
            {
                "outputDir": str(output_dir),
                "topSlice": rows[0] if rows else None,
                "sliceCount": len(rows),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
