from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


REPO = Path(__file__).resolve().parents[2]
DEFAULT_INTAKE = REPO / "data" / "experiments" / "western-strings-m2" / "clean-score-intake.csv"
DEFAULT_AUDIVERIS_SUMMARY = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m2"
    / "audiveris-draft"
    / "audiveris-draft-musicxml-summary.json"
)
DEFAULT_DRAFT_ROOT = REPO / "data" / "experiments" / "western-strings-m2" / "audiveris-draft"
DEFAULT_OUT_DIR = REPO / "data" / "experiments" / "western-strings-m4"


@dataclass(frozen=True)
class Note:
    midi: int
    onset_quarters: float
    duration_quarters: float
    measure_index: int


def repo_path(value: str | Path) -> Path:
    path = Path(str(value))
    if path.is_absolute():
        return path
    return REPO / path


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in columns})


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child(element: ET.Element, name: str) -> ET.Element | None:
    for item in list(element):
        if local_name(str(item.tag)) == name:
            return item
    return None


def child_text(element: ET.Element, name: str, default: str = "") -> str:
    item = child(element, name)
    if item is None or item.text is None:
        return default
    return item.text.strip()


def read_score_xml(path: Path) -> bytes:
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            members = [
                name
                for name in archive.namelist()
                if name.lower().endswith((".xml", ".musicxml")) and not name.startswith("META-INF/")
            ]
            if not members:
                raise ValueError("no-musicxml-member")
            return archive.read(sorted(members)[0])
    return path.read_bytes()


def pitch_to_midi(note: ET.Element) -> int | None:
    pitch = child(note, "pitch")
    if pitch is None:
        return None
    step = child_text(pitch, "step")
    octave_text = child_text(pitch, "octave")
    if step not in {"C", "D", "E", "F", "G", "A", "B"} or not octave_text:
        return None
    semitone = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[step]
    try:
        octave = int(octave_text)
        alter = int(float(child_text(pitch, "alter", "0") or "0"))
    except ValueError:
        return None
    return (octave + 1) * 12 + semitone + alter


def parse_duration(note: ET.Element, divisions: float) -> float:
    text = child_text(note, "duration")
    if not text or divisions <= 0:
        return 0.0
    try:
        return float(text) / divisions
    except ValueError:
        return 0.0


def parse_part_notes(part: ET.Element) -> list[Note]:
    notes: list[Note] = []
    divisions = 1.0
    piece_cursor = 0.0
    measure_index = 0

    for measure in [item for item in list(part) if local_name(str(item.tag)) == "measure"]:
        measure_index += 1
        measure_cursor = 0.0
        measure_max = 0.0
        previous_note_onset = 0.0
        for item in list(measure):
            name = local_name(str(item.tag))
            if name == "attributes":
                divisions_text = child_text(item, "divisions")
                if divisions_text:
                    try:
                        divisions = max(float(divisions_text), 1.0)
                    except ValueError:
                        pass
            elif name == "backup":
                measure_cursor = max(0.0, measure_cursor - parse_duration(item, divisions))
            elif name == "forward":
                measure_cursor += parse_duration(item, divisions)
                measure_max = max(measure_max, measure_cursor)
            elif name == "note":
                duration = parse_duration(item, divisions)
                is_chord = child(item, "chord") is not None
                onset = previous_note_onset if is_chord else measure_cursor
                midi = pitch_to_midi(item)
                if midi is not None and child(item, "rest") is None:
                    notes.append(
                        Note(
                            midi=midi,
                            onset_quarters=piece_cursor + onset,
                            duration_quarters=duration,
                            measure_index=measure_index,
                        )
                    )
                previous_note_onset = onset
                if not is_chord:
                    measure_cursor += duration
                    measure_max = max(measure_max, measure_cursor)
        piece_cursor += measure_max
    return notes


def parse_notes(path: Path) -> list[Note]:
    root = ET.fromstring(read_score_xml(path))
    parts = [item for item in root.iter() if local_name(str(item.tag)) == "part"]
    if not parts:
        raise ValueError("no-part")
    per_part = [parse_part_notes(part) for part in parts]
    return max(per_part, key=len) if per_part else []


def align_notes(gold: list[Note], draft: list[Note]) -> list[tuple[int | None, int | None]]:
    rows = len(gold) + 1
    cols = len(draft) + 1
    dp = [[0] * cols for _ in range(rows)]
    move = [[""] * cols for _ in range(rows)]
    for i in range(1, rows):
        dp[i][0] = i
        move[i][0] = "del"
    for j in range(1, cols):
        dp[0][j] = j
        move[0][j] = "ins"
    for i in range(1, rows):
        for j in range(1, cols):
            substitution = 0 if gold[i - 1].midi == draft[j - 1].midi else 1
            choices = [
                (dp[i - 1][j - 1] + substitution, "sub"),
                (dp[i - 1][j] + 1, "del"),
                (dp[i][j - 1] + 1, "ins"),
            ]
            best_cost, best_move = min(choices, key=lambda item: item[0])
            dp[i][j] = best_cost
            move[i][j] = best_move
    pairs: list[tuple[int | None, int | None]] = []
    i = len(gold)
    j = len(draft)
    while i > 0 or j > 0:
        step = move[i][j]
        if step == "sub":
            pairs.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif step == "del":
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1
    pairs.reverse()
    return pairs


def safe_rate(numerator: int | float, denominator: int | float) -> float:
    if denominator <= 0:
        return 0.0
    return float(numerator) / float(denominator)


def find_draft_path(piece_id: str, summary_by_piece: dict[str, dict[str, Any]], draft_root: Path) -> Path | None:
    summary = summary_by_piece.get(piece_id) or {}
    raw = str(summary.get("mxl") or "")
    if raw:
        direct = Path(raw)
        if direct.exists():
            return direct
    candidates = sorted((draft_root / f"{piece_id}-audiveris").rglob("*.mxl"))
    return candidates[0] if candidates else None


def sha1(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def evaluate_pair(
    row: dict[str, str],
    summary_by_piece: dict[str, dict[str, Any]],
    draft_root: Path,
    onset_tolerance_quarters: float,
) -> dict[str, Any]:
    piece_id = row.get("pieceId", "").strip()
    recording_id = row.get("recordingId", "").strip()
    gold_path = repo_path(row.get("requiredCleanScorePath", ""))
    draft_path = find_draft_path(piece_id, summary_by_piece, draft_root)
    clean_score_review_status = row.get("cleanScoreReviewStatus", "").strip().lower()
    clean_score_reviewed_by = row.get("cleanScoreReviewedBy", "").strip()
    human_verified_clean_score = clean_score_review_status == "approved" and bool(clean_score_reviewed_by)
    result: dict[str, Any] = {
        "recordingId": recording_id,
        "pieceId": piece_id,
        "goldPath": str(gold_path.relative_to(REPO)) if gold_path.exists() else str(gold_path),
        "draftPath": str(draft_path.relative_to(REPO)) if draft_path and draft_path.exists() else "",
        "parseOk": False,
        "benchmarkUsable": False,
        "goldEqualsDraftHash": "",
        "goldProvenance": "",
        "cleanScoreReviewStatus": row.get("cleanScoreReviewStatus", "").strip(),
        "cleanScoreReviewedBy": clean_score_reviewed_by,
        "humanVerifiedCleanScore": "yes" if human_verified_clean_score else "",
        "blockingReason": "",
    }
    if not gold_path.exists():
        result["blockingReason"] = "gold-clean-score-missing"
        return result
    if draft_path is None or not draft_path.exists():
        result["blockingReason"] = "audiveris-draft-missing"
        return result
    gold_hash = sha1(gold_path)
    draft_hash = sha1(draft_path)
    gold_equals_draft = gold_hash == draft_hash
    gold_provenance = (
        "human-approved-unchanged-draft"
        if gold_equals_draft and human_verified_clean_score
        else "self-comparison-unverified"
        if gold_equals_draft
        else "independent-edited-gold"
    )
    benchmark_usable = (not gold_equals_draft) or human_verified_clean_score
    try:
        gold_notes = parse_notes(gold_path)
        draft_notes = parse_notes(draft_path)
        pairs = align_notes(gold_notes, draft_notes)
    except Exception as exc:  # pragma: no cover - batch report should continue
        result["blockingReason"] = f"parse-error:{type(exc).__name__}:{str(exc)[:120]}"
        return result

    gold_count = len(gold_notes)
    draft_count = len(draft_notes)
    paired = [(gold_i, draft_i) for gold_i, draft_i in pairs if gold_i is not None and draft_i is not None]
    missing = sum(1 for gold_i, draft_i in pairs if gold_i is not None and draft_i is None)
    extra = sum(1 for gold_i, draft_i in pairs if gold_i is None and draft_i is not None)
    substitutions = 0
    pitch_exact = 0
    onset_exact = 0
    measure_exact = 0
    onset_errors: list[float] = []
    for gold_i, draft_i in paired:
        gold_note = gold_notes[int(gold_i)]
        draft_note = draft_notes[int(draft_i)]
        pitch_matches = gold_note.midi == draft_note.midi
        if pitch_matches:
            pitch_exact += 1
        else:
            substitutions += 1
        onset_error = abs(gold_note.onset_quarters - draft_note.onset_quarters)
        onset_errors.append(onset_error)
        if onset_error <= onset_tolerance_quarters:
            onset_exact += 1
        if gold_note.measure_index == draft_note.measure_index:
            measure_exact += 1

    result.update(
        {
            "parseOk": True,
            "benchmarkUsable": benchmark_usable,
            "goldEqualsDraftHash": "yes" if gold_equals_draft else "",
            "goldProvenance": gold_provenance,
            "blockingReason": ""
            if benchmark_usable
            else "gold-clean-score-identical-to-audiveris-draft-without-human-review",
            "goldNotes": gold_count,
            "draftNotes": draft_count,
            "pairedNotes": len(paired),
            "pitchExact": pitch_exact,
            "substitutions": substitutions,
            "missingNotes": missing,
            "extraNotes": extra,
            "pitchAccuracy": round(safe_rate(pitch_exact, gold_count), 6),
            "missingRate": round(safe_rate(missing, gold_count), 6),
            "extraRate": round(safe_rate(extra, gold_count), 6),
            "onsetQuarterAccuracy": round(safe_rate(onset_exact, gold_count), 6),
            "measureAccuracy": round(safe_rate(measure_exact, gold_count), 6),
            "medianOnsetQuarterError": round(median(onset_errors), 6) if onset_errors else "",
        }
    )
    return result


def median(values: list[float]) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def summarize(rows: list[dict[str, Any]], thresholds: dict[str, float]) -> dict[str, Any]:
    parsed = [row for row in rows if row.get("parseOk")]
    usable = [row for row in parsed if row.get("benchmarkUsable")]
    totals = {
        "goldNotes": sum(int(row.get("goldNotes") or 0) for row in usable),
        "draftNotes": sum(int(row.get("draftNotes") or 0) for row in usable),
        "pitchExact": sum(int(row.get("pitchExact") or 0) for row in usable),
        "missingNotes": sum(int(row.get("missingNotes") or 0) for row in usable),
        "extraNotes": sum(int(row.get("extraNotes") or 0) for row in usable),
        "onsetExact": sum(
            round(float(row.get("onsetQuarterAccuracy") or 0) * int(row.get("goldNotes") or 0)) for row in usable
        ),
        "measureExact": sum(
            round(float(row.get("measureAccuracy") or 0) * int(row.get("goldNotes") or 0)) for row in usable
        ),
    }
    gold_total = totals["goldNotes"]
    aggregate = {
        "pitchAccuracy": round(safe_rate(totals["pitchExact"], gold_total), 6),
        "missingRate": round(safe_rate(totals["missingNotes"], gold_total), 6),
        "extraRate": round(safe_rate(totals["extraNotes"], gold_total), 6),
        "onsetQuarterAccuracy": round(safe_rate(totals["onsetExact"], gold_total), 6),
        "measureAccuracy": round(safe_rate(totals["measureExact"], gold_total), 6),
    }
    quality_ready = (
        len(parsed) == len(rows)
        and len(usable) == len(rows)
        and aggregate["pitchAccuracy"] >= thresholds["minPitchAccuracy"]
        and aggregate["missingRate"] <= thresholds["maxMissingRate"]
        and aggregate["extraRate"] <= thresholds["maxExtraRate"]
        and aggregate["onsetQuarterAccuracy"] >= thresholds["minOnsetQuarterAccuracy"]
        and aggregate["measureAccuracy"] >= thresholds["minMeasureAccuracy"]
    )
    return {
        "rows": len(rows),
        "parseOkRows": len(parsed),
        "usableBenchmarkRows": len(usable),
        "sameHashRows": len([row for row in parsed if row.get("goldEqualsDraftHash")]),
        "humanApprovedUnchangedRows": len(
            [row for row in parsed if row.get("goldProvenance") == "human-approved-unchanged-draft"]
        ),
        "selfComparisonRows": len(
            [row for row in parsed if row.get("goldProvenance") == "self-comparison-unverified"]
        ),
        "blockedRows": len(rows) - len(usable),
        **totals,
        **aggregate,
        "m4OmrDraftQualityReady": quality_ready,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate Audiveris OMR drafts against approved clean-score gold files.")
    parser.add_argument("--intake", default=str(DEFAULT_INTAKE))
    parser.add_argument("--audiveris-summary", default=str(DEFAULT_AUDIVERIS_SUMMARY))
    parser.add_argument("--draft-root", default=str(DEFAULT_DRAFT_ROOT))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--onset-tolerance-quarters", type=float, default=0.25)
    parser.add_argument("--min-pitch-accuracy", type=float, default=0.98)
    parser.add_argument("--max-missing-rate", type=float, default=0.02)
    parser.add_argument("--max-extra-rate", type=float, default=0.02)
    parser.add_argument("--min-onset-quarter-accuracy", type=float, default=0.95)
    parser.add_argument("--min-measure-accuracy", type=float, default=0.95)
    args = parser.parse_args()

    intake_path = Path(args.intake)
    summary_path = Path(args.audiveris_summary)
    draft_root = Path(args.draft_root)
    out_dir = Path(args.out_dir)
    if not intake_path.exists():
        raise SystemExit(f"intake not found: {intake_path}")
    if not summary_path.exists():
        raise SystemExit(f"Audiveris summary not found: {summary_path}")
    summary_rows = json.loads(summary_path.read_text(encoding="utf-8"))
    summary_by_piece = {str(row.get("pieceId") or ""): row for row in summary_rows}
    rows = [
        evaluate_pair(
            row,
            summary_by_piece,
            draft_root,
            onset_tolerance_quarters=float(args.onset_tolerance_quarters),
        )
        for row in read_csv(intake_path)
    ]
    thresholds = {
        "minPitchAccuracy": float(args.min_pitch_accuracy),
        "maxMissingRate": float(args.max_missing_rate),
        "maxExtraRate": float(args.max_extra_rate),
        "minOnsetQuarterAccuracy": float(args.min_onset_quarter_accuracy),
        "minMeasureAccuracy": float(args.min_measure_accuracy),
    }
    summary = summarize(rows, thresholds)
    report = {
        "ok": True,
        "gate": {
            "name": "western-strings-m4-omr-benchmark",
            "m4OmrBenchmarkEvaluated": True,
            "m4OmrDraftQualityReady": summary["m4OmrDraftQualityReady"],
            "studentGateReady": False,
            "reason": "omr-benchmark-eval-only",
            "runtimeEffect": "none",
        },
        "thresholds": thresholds,
        "counts": summary,
        "artifacts": {
            "intake": str(intake_path.relative_to(REPO)) if intake_path.is_relative_to(REPO) else str(intake_path),
            "audiverisSummary": str(summary_path.relative_to(REPO)) if summary_path.is_relative_to(REPO) else str(summary_path),
            "json": "data/experiments/western-strings-m4/omr-benchmark.json",
            "csv": "data/experiments/western-strings-m4/omr-benchmark.csv",
        },
        "notes": [
            "This is an eval-only OMR draft-vs-gold benchmark. It does not approve OMR output for runtime diagnosis.",
            "Pitch/onset/measure metrics are sequence-alignment proxies; release thresholds must be calibrated before any student-facing use.",
            "Byte-identical rows are usable only when cleanScoreReviewStatus=approved and cleanScoreReviewedBy is present; otherwise they remain self-comparison-unverified and blocked.",
            "human-approved-unchanged-draft rows must be reported separately from independent-edited-gold rows.",
        ],
        "rows": rows,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    json_out = out_dir / "omr-benchmark.json"
    csv_out = out_dir / "omr-benchmark.csv"
    json_out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_csv(
        csv_out,
        rows,
        [
            "recordingId",
            "pieceId",
            "parseOk",
            "benchmarkUsable",
            "goldEqualsDraftHash",
            "goldProvenance",
            "cleanScoreReviewStatus",
            "cleanScoreReviewedBy",
            "humanVerifiedCleanScore",
            "goldNotes",
            "draftNotes",
            "pairedNotes",
            "pitchExact",
            "substitutions",
            "missingNotes",
            "extraNotes",
            "pitchAccuracy",
            "missingRate",
            "extraRate",
            "onsetQuarterAccuracy",
            "measureAccuracy",
            "medianOnsetQuarterError",
            "blockingReason",
            "goldPath",
            "draftPath",
        ],
    )
    print(json.dumps({key: report[key] for key in ["ok", "gate", "counts", "artifacts"]}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
