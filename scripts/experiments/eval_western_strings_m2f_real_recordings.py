from __future__ import annotations

import argparse
import csv
import json
import math
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recordings-manifest.csv"
DEFAULT_RESULTS = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recording-results.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "m2f-real-student-recording-summary.json"

REQUIRED_COLUMNS = [
    "recordingId",
    "studentId",
    "instrument",
    "pieceId",
    "audioPath",
    "scenario",
    "humanChecked",
    "consent",
    "licenseStatus",
]
VALID_SCENARIOS = {
    "correct",
    "wrong_pitch",
    "missing_note",
    "extra_note",
    "rhythm_shift",
    "weak_onset",
    "noisy",
}
VALID_LICENSE_STATUS = {"local-only", "cleared"}
DEFAULT_REQUIRED_SCENARIOS = ["correct", "wrong_pitch", "missing_note", "rhythm_shift", "weak_onset", "noisy"]
SCORE_STORE = REPO / "data" / "erhu-score-imports.json"
SCORE_STORE_SQLITE = REPO / "data" / "erhu-score-imports.sqlite"
PRIVATE_REPO_DATA_ROOT = REPO / "data" / "private"
CLEAN_SCORE_EXTENSIONS = {".musicxml", ".xml", ".mxl", ".mid", ".midi"}


def read_csv(path: Path) -> tuple[list[dict[str, str]], list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader), list(reader.fieldnames or [])


def repo_path(value: str) -> Path:
    path = Path(value.strip())
    return path if path.is_absolute() else REPO / path


def path_is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
    except ValueError:
        return False
    return True


def load_score_ids(path: Path = SCORE_STORE) -> set[str]:
    score_ids: set[str] = set()
    if not path.exists():
        data = {"scores": []}
    else:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {"scores": []}
    score_ids.update(
        str(score.get("scoreId", "")).strip()
        for score in data.get("scores", [])
        if isinstance(score, dict) and str(score.get("scoreId", "")).strip()
    )
    sqlite_path = path.with_suffix(".sqlite")
    if path == SCORE_STORE:
        sqlite_path = SCORE_STORE_SQLITE
    if sqlite_path.exists():
        try:
            with sqlite3.connect(sqlite_path) as connection:
                for (score_id,) in connection.execute(
                    "SELECT score_id FROM imported_scores WHERE archived = 0 AND score_id <> ''"
                ):
                    if str(score_id).strip():
                        score_ids.add(str(score_id).strip())
        except sqlite3.Error:
            pass
    return score_ids


def is_yes(value: str) -> bool:
    return value.strip().lower() in {"yes", "y", "true", "1"}


def safe_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def safe_nonnegative_int(value: Any) -> int | None:
    numeric = safe_float(value)
    if numeric is None or numeric < 0 or not numeric.is_integer():
        return None
    return int(numeric)


def validate_manifest(
    manifest_path: Path,
    *,
    min_recordings: int,
    min_students: int,
    required_scenarios: list[str],
) -> dict[str, Any]:
    blockers: list[str] = []
    warnings: list[str] = []
    if not manifest_path.exists():
        return {
            "manifestReady": False,
            "blockingReasons": ["manifest-missing"],
            "warnings": [],
            "rows": 0,
            "recordings": 0,
            "students": 0,
            "scenarioCounts": {},
            "invalidRows": [],
        }

    rows, columns = read_csv(manifest_path)
    missing_columns = [column for column in REQUIRED_COLUMNS if column not in columns]
    if missing_columns:
        blockers.append("manifest-missing-columns:" + "|".join(missing_columns))

    invalid_rows: list[dict[str, Any]] = []
    seen_recording_ids: set[str] = set()
    recording_ids: set[str] = set()
    student_ids: set[str] = set()
    scenario_counts: Counter[str] = Counter()
    known_score_ids = load_score_ids()

    for index, row in enumerate(rows, start=2):
        errors: list[str] = []
        recording_id = row.get("recordingId", "").strip()
        student_id = row.get("studentId", "").strip()
        instrument = row.get("instrument", "").strip().lower()
        scenario = row.get("scenario", "").strip().lower()
        audio_path = row.get("audioPath", "").strip()
        score_path = row.get("scorePath", "").strip() or row.get("scoreSourcePath", "").strip()
        score_id = row.get("scoreId", "").strip()
        start_seconds = row.get("startSeconds", "").strip()
        end_seconds = row.get("endSeconds", "").strip()
        license_status = row.get("licenseStatus", "").strip().lower()

        if not recording_id:
            errors.append("recordingId-missing")
        elif recording_id in seen_recording_ids:
            errors.append("recordingId-duplicate")
        else:
            seen_recording_ids.add(recording_id)
        if not student_id:
            errors.append("studentId-missing")
        if instrument != "violin":
            errors.append("instrument-not-violin")
        if scenario not in VALID_SCENARIOS:
            errors.append("scenario-invalid")
        if not audio_path:
            errors.append("audioPath-missing")
        else:
            audio_resolved = repo_path(audio_path)
            if not audio_resolved.exists():
                errors.append("audioPath-not-found")
            elif not audio_resolved.is_file():
                errors.append("audioPath-not-file")
            elif path_is_within(audio_resolved, REPO) and not path_is_within(audio_resolved, PRIVATE_REPO_DATA_ROOT):
                errors.append("audioPath-not-private")
        if not score_path and not score_id:
            errors.append("scorePath-or-scoreId-missing")
        elif score_path:
            score_resolved = repo_path(score_path)
            if not score_resolved.exists():
                errors.append("scorePath-not-found")
            elif not score_resolved.is_file():
                errors.append("scorePath-not-file")
            else:
                if score_resolved.suffix.lower() not in CLEAN_SCORE_EXTENSIONS:
                    errors.append("scorePath-not-clean-score")
                if (
                    license_status == "local-only"
                    and path_is_within(score_resolved, REPO)
                    and not path_is_within(score_resolved, PRIVATE_REPO_DATA_ROOT)
                ):
                    errors.append("scorePath-not-private")
        if score_id and score_id not in known_score_ids:
            errors.append("scoreId-not-found")
        if not is_yes(row.get("humanChecked", "")):
            errors.append("humanChecked-not-yes")
        if not is_yes(row.get("consent", "")):
            errors.append("consent-not-yes")
        if license_status not in VALID_LICENSE_STATUS:
            errors.append("licenseStatus-invalid")
        start = safe_float(start_seconds) if start_seconds else None
        end = safe_float(end_seconds) if end_seconds else None
        if (start is None) != (end is None):
            errors.append("window-start-end-incomplete")
        if start is not None and end is not None and end <= start:
            errors.append("window-invalid")

        if errors:
            invalid_rows.append({"line": index, "recordingId": recording_id, "errors": errors})
            continue

        recording_ids.add(recording_id)
        student_ids.add(student_id)
        scenario_counts[scenario] += 1

    if invalid_rows:
        blockers.append("manifest-invalid-rows")
    if len(recording_ids) < min_recordings:
        blockers.append(f"recordings-below-min:{len(recording_ids)}/{min_recordings}")
    if len(student_ids) < min_students:
        blockers.append(f"students-below-min:{len(student_ids)}/{min_students}")
    missing_scenarios = [scenario for scenario in required_scenarios if scenario_counts[scenario] == 0]
    if missing_scenarios:
        blockers.append("scenarios-missing:" + "|".join(missing_scenarios))
    if len(rows) == 0:
        blockers.append("manifest-empty")
    if any(row.get("scenario", "").strip().lower() == "correct" for row in rows) and scenario_counts["correct"] == 0:
        warnings.append("correct-scenario-present-only-in-invalid-rows")

    return {
        "manifestReady": not blockers,
        "blockingReasons": blockers,
        "warnings": warnings,
        "rows": len(rows),
        "recordings": len(recording_ids),
        "recordingIds": sorted(recording_ids),
        "students": len(student_ids),
        "scenarioCounts": dict(sorted(scenario_counts.items())),
        "invalidRows": invalid_rows[:20],
    }


def evaluate_results(results_path: Path, valid_recording_ids: set[str]) -> dict[str, Any]:
    if not results_path.exists():
        return {
            "resultsReady": False,
            "blockingReasons": ["real-recording-results-missing"],
            "rows": 0,
            "autoPassCount": 0,
            "correctWithin300ms": 0,
            "unsafeTargetAutoPassCount": 0,
            "precisionWithin300ms": 0.0,
        }

    rows, columns = read_csv(results_path)
    required = ["recordingId", "autoPassCount", "correctWithin300ms", "unsafeTargetAutoPassCount"]
    missing_columns = [column for column in required if column not in columns]
    blockers: list[str] = []
    if missing_columns:
        blockers.append("results-missing-columns:" + "|".join(missing_columns))

    auto_pass = 0
    correct = 0
    unsafe = 0
    invalid_rows: list[dict[str, Any]] = []
    seen_result_ids: set[str] = set()
    matched_result_ids: set[str] = set()
    unknown_result_ids: set[str] = set()
    for index, row in enumerate(rows, start=2):
        errors: list[str] = []
        recording_id = row.get("recordingId", "").strip()
        if not recording_id:
            errors.append("recordingId-missing")
        elif recording_id in seen_result_ids:
            errors.append("recordingId-duplicate")
        else:
            seen_result_ids.add(recording_id)
            if valid_recording_ids and recording_id not in valid_recording_ids:
                unknown_result_ids.add(recording_id)
                errors.append("recordingId-not-in-manifest")
        row_auto = safe_nonnegative_int(row.get("autoPassCount"))
        row_correct = safe_nonnegative_int(row.get("correctWithin300ms"))
        row_unsafe = safe_nonnegative_int(row.get("unsafeTargetAutoPassCount"))
        if row_auto is None or row_correct is None or row_unsafe is None:
            errors.append("result-count-invalid")
        else:
            if row_correct > row_auto:
                errors.append("correctWithin300ms-greater-than-autoPassCount")
            if row_unsafe > row_auto:
                errors.append("unsafeTargetAutoPassCount-greater-than-autoPassCount")
        if errors:
            invalid_rows.append({"line": index, "recordingId": recording_id, "errors": errors})
            continue
        matched_result_ids.add(recording_id)
        auto_pass += row_auto
        correct += row_correct
        unsafe += row_unsafe
    if invalid_rows:
        blockers.append("results-invalid-rows")
    missing_result_ids = sorted(valid_recording_ids - matched_result_ids)
    if missing_result_ids:
        blockers.append("results-missing-recording-ids:" + "|".join(missing_result_ids[:20]))
    if unknown_result_ids:
        blockers.append("results-unknown-recording-ids:" + "|".join(sorted(unknown_result_ids)[:20]))
    if auto_pass <= 0:
        blockers.append("results-no-auto-pass")

    precision = round(correct / auto_pass, 4) if auto_pass else 0.0
    return {
        "resultsReady": not blockers,
        "blockingReasons": blockers,
        "rows": len(rows),
        "recordingIds": sorted(matched_result_ids),
        "missingRecordingIds": missing_result_ids[:20],
        "unknownRecordingIds": sorted(unknown_result_ids)[:20],
        "autoPassCount": auto_pass,
        "correctWithin300ms": correct,
        "unsafeTargetAutoPassCount": unsafe,
        "precisionWithin300ms": precision,
        "invalidRows": invalid_rows[:20],
    }


def run(
    manifest_path: Path,
    results_path: Path,
    *,
    min_recordings: int,
    min_students: int,
    required_scenarios: list[str],
    min_precision: float,
) -> dict[str, Any]:
    manifest = validate_manifest(
        manifest_path,
        min_recordings=min_recordings,
        min_students=min_students,
        required_scenarios=required_scenarios,
    )
    results = evaluate_results(results_path, set(manifest.get("recordingIds", [])))
    blockers = list(manifest["blockingReasons"]) + list(results["blockingReasons"])
    if results["precisionWithin300ms"] < min_precision:
        blockers.append(f"precision-below-min:{results['precisionWithin300ms']}/{min_precision}")
    if results["unsafeTargetAutoPassCount"] > 0:
        blockers.append(f"unsafe-target-auto-pass:{results['unsafeTargetAutoPassCount']}")

    return {
        "ok": True,
        "studentGateReady": not blockers,
        "gate": {
            "name": "western-strings-m2f-real-student-recording-pilot",
            "minRecordings": min_recordings,
            "minStudents": min_students,
            "requiredScenarios": required_scenarios,
            "minPrecisionWithin300ms": min_precision,
        },
        "manifestPath": str(manifest_path.relative_to(REPO) if manifest_path.is_relative_to(REPO) else manifest_path),
        "resultsPath": str(results_path.relative_to(REPO) if results_path.is_relative_to(REPO) else results_path),
        "blockingReasons": blockers,
        "manifest": manifest,
        "results": results,
        "warning": "M2f is the first real-student recording release gate. Synthetic M2d/M2e passing is not sufficient for student-facing auto feedback.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the western strings M2f real-student recording release gate inputs and results.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--results", default=str(DEFAULT_RESULTS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-recordings", type=int, default=6)
    parser.add_argument("--min-students", type=int, default=3)
    parser.add_argument("--required-scenarios", default=",".join(DEFAULT_REQUIRED_SCENARIOS))
    parser.add_argument("--min-precision", type=float, default=0.9)
    parser.add_argument("--expect-positive", action="store_true")
    parser.add_argument("--expect-negative", action="store_true")
    parser.add_argument("--fail-on-not-ready", action="store_true", help="exit non-zero when studentGateReady is false")
    args = parser.parse_args()

    summary = run(
        Path(args.manifest),
        Path(args.results),
        min_recordings=max(1, int(args.min_recordings)),
        min_students=max(1, int(args.min_students)),
        required_scenarios=[value.strip() for value in args.required_scenarios.split(",") if value.strip()],
        min_precision=float(args.min_precision),
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.expect_positive and not summary["studentGateReady"]:
        raise SystemExit("Expected real-student recording gate to pass, but it failed.")
    if args.expect_negative and summary["studentGateReady"]:
        raise SystemExit("Expected real-student recording gate to fail closed, but it passed.")
    if args.fail_on_not_ready and not summary["studentGateReady"]:
        raise SystemExit("M2f real-student recording gate is not ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
