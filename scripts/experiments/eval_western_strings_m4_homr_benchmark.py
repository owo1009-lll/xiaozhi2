#!/usr/bin/env python3
"""Evaluate HOMR on the frozen M4 independent real-photo benchmark.

This is an eval-only comparison. It never updates the score store, teacher
packs, or any student-facing OMR gate. The strict gate includes both pitch and
score-structure accuracy; a pitch-perfect but rhythmically invalid MusicXML is
not eligible for automatic adoption.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_western_strings_m4_omr_benchmark import (  # noqa: E402
    REPO,
    evaluate_pair,
    read_csv,
    repo_path,
    write_csv,
)
from eval_western_strings_m4_oemer_benchmark import (  # noqa: E402
    STRICT_MIN_MEASURE_ACCURACY,
    STRICT_MIN_ONSET_QUARTER_ACCURACY,
    STRICT_MIN_PRECISION,
    STRICT_MIN_RECALL,
    MIN_AUTOMATIC_ADOPTION_ROWS,
    THREAD_ENV,
    add_verified_gold_context,
    aggregate_metrics,
    audiveris_up2_rows,
    automatic_adoption_ready,
)


DEFAULT_INTAKE = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-real-photo-gold"
    / "independent-source-benchmark-intake.csv"
)
DEFAULT_AUDIVERIS_REPORT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-real-jpg-variants"
    / "real-jpg-omr-summary.json"
)
DEFAULT_OEMER_REPORT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "oemer-source-benchmark"
    / "oemer-source-benchmark.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "homr-source-benchmark"
)
DEFAULT_HOMR_EXECUTABLE = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "homr-compat-venv"
    / "Scripts"
    / "homr.exe"
)


def strict_thresholds() -> dict[str, float]:
    return {
        "minPitchPrecision": STRICT_MIN_PRECISION,
        "minPitchRecall": STRICT_MIN_RECALL,
        "minOnsetQuarterAccuracy": STRICT_MIN_ONSET_QUARTER_ACCURACY,
        "minMeasureAccuracy": STRICT_MIN_MEASURE_ACCURACY,
    }


def find_musicxml(input_image: Path) -> Path | None:
    expected = input_image.with_suffix(".musicxml")
    if expected.is_file():
        return expected
    candidates = sorted(input_image.parent.glob("*.musicxml"))
    return candidates[0] if len(candidates) == 1 else None


def classify_homr_failure(log_path: Path, exit_code: int) -> str:
    if not log_path.is_file():
        return "homr-runtime-error" if exit_code else ""
    log = log_path.read_bytes().decode("utf-8", errors="ignore")
    if "No staff detected" in log or "No staffs detected" in log:
        return "homr-staff-detection-failed"
    if "Traceback (most recent call last)" in log:
        return "homr-runtime-error"
    return "homr-nonzero-exit" if exit_code else ""


def derive_python(executable: Path, explicit_python: str) -> Path:
    if explicit_python:
        return Path(explicit_python).resolve()
    sibling = executable.with_name("python.exe")
    return sibling if sibling.is_file() else Path(sys.executable).resolve()


def runtime_probe(python: Path, env: dict[str, str]) -> dict[str, Any]:
    code = (
        "import importlib.metadata, json, numpy, onnxruntime; "
        "print(json.dumps({'homr': importlib.metadata.version('homr'), "
        "'numpy': numpy.__version__, 'onnxruntime': onnxruntime.__version__, "
        "'providers': onnxruntime.get_available_providers()}))"
    )
    completed = subprocess.run(
        [str(python), "-c", code],
        check=True,
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


def run_homr(
    executable: Path,
    input_image: Path,
    log_path: Path,
    env: dict[str, str],
    timeout_seconds: int,
) -> tuple[int, float, str]:
    started = time.monotonic()
    try:
        with log_path.open("wb") as log_handle:
            completed = subprocess.run(
                [str(executable), input_image.name],
                cwd=input_image.parent,
                env=env,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                timeout=timeout_seconds,
                check=False,
            )
        error = classify_homr_failure(log_path, completed.returncode)
        return completed.returncode, time.monotonic() - started, error
    except subprocess.TimeoutExpired:
        return 124, time.monotonic() - started, "homr-timeout"


def read_report_rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return list(report.get("rows") or [])


def build_per_piece(
    homr_rows: list[dict[str, Any]],
    audiveris_rows: list[dict[str, Any]],
    oemer_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    audiveris = {str(row.get("pieceId") or row.get("piece") or ""): row for row in audiveris_rows}
    oemer = {str(row.get("pieceId") or ""): row for row in oemer_rows}
    output = []
    for row in homr_rows:
        piece_id = str(row.get("pieceId") or "")
        baseline = audiveris.get(piece_id, {})
        alternative = oemer.get(piece_id, {})
        output.append(
            {
                "pieceId": piece_id,
                "homrStatus": row.get("status"),
                "homrPrecision": row.get("pitchPrecision", ""),
                "homrRecall": row.get("pitchRecall", ""),
                "homrOnsetQuarterAccuracy": row.get("onsetQuarterAccuracy", ""),
                "homrMeasureAccuracy": row.get("measureAccuracy", ""),
                "audiverisPrecision": baseline.get("pitchPrecision", ""),
                "audiverisRecall": baseline.get("pitchRecall", ""),
                "oemerPrecision": alternative.get("pitchPrecision", ""),
                "oemerRecall": alternative.get("pitchRecall", ""),
            }
        )
    return output


def compare_engines(
    homr_rows: list[dict[str, Any]],
    audiveris_rows: list[dict[str, Any]],
    oemer_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "homr": aggregate_metrics(homr_rows),
        "audiverisUp2": aggregate_metrics(audiveris_rows),
        "oemer": aggregate_metrics(oemer_rows),
        "perPiece": build_per_piece(homr_rows, audiveris_rows, oemer_rows),
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_previous_runtime(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return dict(report.get("runtime") or {})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--intake", default=str(DEFAULT_INTAKE))
    parser.add_argument("--audiveris-report", default=str(DEFAULT_AUDIVERIS_REPORT))
    parser.add_argument("--oemer-report", default=str(DEFAULT_OEMER_REPORT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--homr-executable", default=str(DEFAULT_HOMR_EXECUTABLE))
    parser.add_argument("--python", default="")
    parser.add_argument("--pieces", nargs="+", default=[])
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--reuse-existing", action="store_true")
    args = parser.parse_args(argv)

    intake_path = Path(args.intake)
    out_root = Path(args.out)
    executable = Path(args.homr_executable).resolve()
    report_path = out_root / "homr-source-benchmark.json"
    if not intake_path.is_file():
        raise SystemExit(f"intake not found: {intake_path}")
    executable_available = executable.is_file()
    if not executable_available and not args.reuse_existing:
        raise SystemExit(
            "HOMR executable not found. Install homr==0.7.0 in the isolated "
            f"environment first: {executable}"
        )

    rows_in = read_csv(intake_path)
    if args.pieces:
        requested = set(args.pieces)
        rows_in = [row for row in rows_in if row.get("pieceId") in requested]
        missing = requested - {str(row.get("pieceId") or "") for row in rows_in}
        if missing:
            raise SystemExit(f"pieces not found in intake: {sorted(missing)}")
    if not rows_in:
        raise SystemExit("benchmark intake contains no rows")

    env = dict(os.environ)
    env.update(THREAD_ENV)
    if executable_available:
        python = derive_python(executable, args.python)
        try:
            runtime = runtime_probe(python, env)
            runtime["python"] = str(python)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            if not args.reuse_existing:
                raise SystemExit(f"HOMR runtime probe failed: {error}") from error
            runtime = read_previous_runtime(report_path)
            executable_available = False
            runtime["reusedExistingOnly"] = True
    else:
        runtime = read_previous_runtime(report_path)
        runtime["reusedExistingOnly"] = True
    runtime["homrExecutable"] = str(executable)
    runtime["homrExecutableAvailable"] = executable_available
    runtime["license"] = "AGPL-3.0"

    out_root.mkdir(parents=True, exist_ok=True)
    csv_path = out_root / "homr-source-benchmark.csv"
    results: list[dict[str, Any]] = []
    audiveris_rows = audiveris_up2_rows(Path(args.audiveris_report))
    oemer_rows = read_report_rows(Path(args.oemer_report))

    for index, intake_row in enumerate(rows_in, start=1):
        piece_id = str(intake_row.get("pieceId") or "")
        source = repo_path(intake_row.get("currentScorePath", ""))
        piece_dir = out_root / piece_id
        piece_dir.mkdir(parents=True, exist_ok=True)
        input_image = piece_dir / f"input{source.suffix.lower() or '.jpg'}"
        log_path = piece_dir / "homr.log"
        row: dict[str, Any] = {
            "pieceId": piece_id,
            "engine": "homr",
            "engineVersion": runtime.get("homr"),
            "variant": "native-source",
            "status": "",
        }
        print(
            json.dumps({"stage": "piece-start", "index": index, "total": len(rows_in), "pieceId": piece_id}),
            flush=True,
        )
        if not source.is_file():
            row["status"] = "source-image-missing"
            add_verified_gold_context(row, intake_row)
            results.append(row)
            continue
        if not input_image.is_file() or not args.reuse_existing:
            shutil.copy2(source, input_image)
        existing = find_musicxml(input_image) if args.reuse_existing else None
        if existing is not None:
            exit_code, runtime_seconds, run_error = 0, 0.0, ""
            row["reusedExisting"] = True
        elif not executable_available:
            exit_code, runtime_seconds, run_error = 127, 0.0, "homr-executable-missing"
        else:
            for stale in piece_dir.glob("*.musicxml"):
                stale.unlink()
            exit_code, runtime_seconds, run_error = run_homr(
                executable,
                input_image,
                log_path,
                env,
                args.timeout,
            )
            existing = find_musicxml(input_image)
        row.update(
            {
                "homrExit": exit_code,
                "runtimeSeconds": round(runtime_seconds, 3),
                "logPath": str(log_path.relative_to(REPO)) if log_path.is_relative_to(REPO) else str(log_path),
            }
        )
        if existing is None:
            row["status"] = run_error or "homr-output-missing-or-ambiguous"
            add_verified_gold_context(row, intake_row)
        else:
            benchmark = evaluate_pair(
                intake_row,
                {piece_id: {"mxl": str(existing)}},
                piece_dir,
                onset_tolerance_quarters=0.25,
            )
            row.update(benchmark)
            row["status"] = "ok" if benchmark.get("parseOk") else benchmark.get("blockingReason", "parse-failed")
        results.append(row)
        comparison = compare_engines(results, audiveris_rows, oemer_rows)
        checkpoint = {
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "complete": len(results) == len(rows_in),
            "evaluationMode": "independent-source-gold",
            "runtime": runtime,
            "threadLimits": THREAD_ENV,
            "strictThresholds": strict_thresholds(),
            "studentGateReady": False,
            "runtimeEffect": "none",
            "comparison": comparison,
            "rows": results,
        }
        write_report(report_path, checkpoint)
        print(
            json.dumps(
                {
                    "stage": "piece-complete",
                    "pieceId": piece_id,
                    "status": row.get("status"),
                    "pitchPrecision": row.get("pitchPrecision"),
                    "pitchRecall": row.get("pitchRecall"),
                    "onsetQuarterAccuracy": row.get("onsetQuarterAccuracy"),
                    "runtimeSeconds": row.get("runtimeSeconds"),
                }
            ),
            flush=True,
        )

    comparison = compare_engines(results, audiveris_rows, oemer_rows)
    final_report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "complete": len(results) == len(rows_in),
        "evaluationMode": "independent-source-gold",
        "runtime": runtime,
        "threadLimits": THREAD_ENV,
        "strictThresholds": strict_thresholds(),
        "gate": {
            "name": "western-strings-m4-homr-source-benchmark",
            "automaticAdoptionReady": automatic_adoption_ready(comparison["homr"], len(rows_in)),
            "minimumIndependentRows": MIN_AUTOMATIC_ADOPTION_ROWS,
            "observedIndependentRows": len(rows_in),
            "sampleSizeReady": len(rows_in) >= MIN_AUTOMATIC_ADOPTION_ROWS,
            "studentGateReady": False,
            "reason": "eval-only-transformer-omr-engine-comparison",
            "runtimeEffect": "none",
        },
        "comparison": comparison,
        "artifacts": {
            "intake": str(intake_path),
            "audiverisReport": str(args.audiveris_report),
            "oemerReport": str(args.oemer_report),
            "json": str(report_path),
            "csv": str(csv_path),
        },
        "rows": results,
    }
    write_report(report_path, final_report)
    columns = sorted({key for row in results for key in row})
    write_csv(csv_path, results, columns)
    print(json.dumps({"gate": final_report["gate"], "comparison": comparison}, ensure_ascii=False, indent=2))
    return 0 if all(row.get("status") == "ok" for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
