#!/usr/bin/env python3
"""Evaluate Clarity-OMR on the frozen M4 real-photo source-gold set.

The comparison is eval-only. It uses one generic page trim because the frozen
screenshots contain viewer chrome, then runs the official beam-5 pipeline. It
never updates the score store or any student-facing OMR gate.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_western_strings_m4_omr_benchmark import (  # noqa: E402
    REPO,
    evaluate_pair,
    read_csv,
    repo_path,
    write_csv,
)
from eval_western_strings_m4_oemer_benchmark import (  # noqa: E402
    THREAD_ENV,
    add_verified_gold_context,
    aggregate_metrics,
    automatic_adoption_ready,
)
from eval_western_strings_m4_homr_benchmark import strict_thresholds  # noqa: E402


DEFAULT_INTAKE = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-real-photo-gold"
    / "independent-source-benchmark-intake.csv"
)
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "clarity-source-benchmark"
DEFAULT_CLARITY_REPO = REPO / "data" / "experiments" / "western-strings-m4" / "clarity-omr-src"
DEFAULT_PYTHON = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-compat-venv"
    / "Scripts"
    / "python.exe"
)
DEFAULT_EXTERNAL_REPORTS = {
    "audiveris": REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-real-jpg-variants"
    / "real-jpg-omr-summary.json",
    "oemer": REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "oemer-source-benchmark"
    / "oemer-source-benchmark.json",
    "homr": REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "homr-source-benchmark"
    / "homr-source-benchmark.json",
}


def auto_trim_page(source: Path, image_path: Path, pdf_path: Path, threshold: int = 100) -> dict[str, Any]:
    """Remove black viewer bars using only a fixed row-mean rule."""
    with Image.open(source) as opened:
        image = opened.convert("RGB")
        grayscale = np.asarray(image.convert("L"), dtype=np.float32)
        page_rows = np.flatnonzero(grayscale.mean(axis=1) >= threshold)
        if page_rows.size == 0:
            raise ValueError("no-page-like-rows")
        top = int(page_rows[0])
        bottom = int(page_rows[-1]) + 1
        cropped = image.crop((0, top, image.width, bottom))
        image_path.parent.mkdir(parents=True, exist_ok=True)
        cropped.save(image_path)
        cropped.save(pdf_path, "PDF", resolution=300.0)
        return {
            "method": "row-mean-page-trim",
            "threshold": threshold,
            "crop": [0, top, image.width, bottom],
            "sourceSize": [image.width, image.height],
            "outputSize": [cropped.width, cropped.height],
        }


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def runtime_probe(python: Path, env: dict[str, str]) -> dict[str, Any]:
    code = (
        "import importlib.metadata, json, torch; "
        "print(json.dumps({'torch': torch.__version__, "
        "'cudaAvailable': torch.cuda.is_available(), "
        "'transformers': importlib.metadata.version('transformers'), "
        "'ultralytics': importlib.metadata.version('ultralytics')}))"
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


def run_clarity(
    python: Path,
    clarity_repo: Path,
    input_pdf: Path,
    output_xml: Path,
    work_dir: Path,
    log_path: Path,
    env: dict[str, str],
    device: str,
    beam_width: int,
    timeout_seconds: int,
) -> tuple[int, float, str]:
    command = [
        str(python),
        str(clarity_repo / "omr.py"),
        str(input_pdf),
        "-o",
        str(output_xml),
        "--work-dir",
        str(work_dir),
        "--device",
        device,
        "--beam-width",
        str(beam_width),
    ]
    started = time.monotonic()
    try:
        with log_path.open("wb") as log_handle:
            completed = subprocess.run(
                command,
                cwd=clarity_repo,
                env=env,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                timeout=timeout_seconds,
                check=False,
            )
    except subprocess.TimeoutExpired:
        return 124, time.monotonic() - started, "clarity-timeout"
    error = "" if completed.returncode == 0 else "clarity-runtime-error"
    return completed.returncode, time.monotonic() - started, error


def external_summaries() -> dict[str, Any]:
    audiveris_report = read_json(DEFAULT_EXTERNAL_REPORTS["audiveris"])
    audiveris_rows = [
        row
        for row in audiveris_report.get("rows", [])
        if row.get("variant") == "up2" and row.get("status") == "ok"
    ]
    oemer = read_json(DEFAULT_EXTERNAL_REPORTS["oemer"])
    homr = read_json(DEFAULT_EXTERNAL_REPORTS["homr"])
    return {
        "audiverisUp2": aggregate_metrics(audiveris_rows),
        "oemer": oemer.get("comparison", {}).get("oemer", {}) if oemer.get("complete") is True else {},
        "homr": homr.get("comparison", {}).get("homr", {}) if homr.get("complete") is True else {},
    }


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--intake", default=str(DEFAULT_INTAKE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--clarity-repo", default=str(DEFAULT_CLARITY_REPO))
    parser.add_argument("--python", default=str(DEFAULT_PYTHON))
    parser.add_argument("--pieces", nargs="+", default=[])
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--beam-width", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--reuse-existing", action="store_true")
    args = parser.parse_args(argv)

    intake_path = Path(args.intake)
    out_root = Path(args.out)
    clarity_repo = Path(args.clarity_repo).resolve()
    python = Path(args.python).resolve()
    report_path = out_root / "clarity-source-benchmark.json"
    csv_path = out_root / "clarity-source-benchmark.csv"
    if not intake_path.is_file():
        raise SystemExit(f"intake not found: {intake_path}")

    rows_in = read_csv(intake_path)
    if args.pieces:
        requested = set(args.pieces)
        rows_in = [row for row in rows_in if row.get("pieceId") in requested]
        missing = requested - {str(row.get("pieceId") or "") for row in rows_in}
        if missing:
            raise SystemExit(f"pieces not found in intake: {sorted(missing)}")
    if not rows_in:
        raise SystemExit("benchmark intake contains no rows")

    runtime_available = python.is_file() and (clarity_repo / "omr.py").is_file()
    if not runtime_available and not args.reuse_existing:
        raise SystemExit("Clarity-OMR runtime is missing; rerun with --reuse-existing or install the isolated engine")
    env = dict(os.environ)
    env.update(THREAD_ENV)
    env.update({"USE_TF": "0", "TRANSFORMERS_NO_TF": "1"})
    previous_runtime = dict(read_json(report_path).get("runtime") or {})
    if runtime_available:
        try:
            runtime = runtime_probe(python, env)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            if not args.reuse_existing:
                raise SystemExit(f"Clarity-OMR runtime probe failed: {error}") from error
            runtime = previous_runtime
            runtime_available = False
    else:
        runtime = previous_runtime
    runtime.update(
        {
            "engine": "Clarity-OMR",
            "runtimeAvailable": runtime_available,
            "reusedExistingOnly": not runtime_available,
            "python": str(python),
            "clarityRepo": str(clarity_repo),
            "device": args.device,
            "beamWidth": args.beam_width,
            "license": "GPL-3.0",
        }
    )

    out_root.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for index, intake_row in enumerate(rows_in, start=1):
        piece_id = str(intake_row.get("pieceId") or "")
        source = repo_path(intake_row.get("currentScorePath", ""))
        piece_dir = out_root / piece_id
        input_png = piece_dir / "input-auto-trim.png"
        input_pdf = piece_dir / "input-auto-trim.pdf"
        output_xml = piece_dir / "input.musicxml"
        work_dir = piece_dir / "work"
        log_path = piece_dir / "clarity.log"
        preprocess_path = piece_dir / "preprocess.json"
        row: dict[str, Any] = {
            "pieceId": piece_id,
            "engine": "clarity-omr",
            "variant": f"auto-page-trim-beam{args.beam_width}",
            "status": "",
        }
        print(json.dumps({"stage": "piece-start", "index": index, "total": len(rows_in), "pieceId": piece_id}), flush=True)
        if not source.is_file():
            row["status"] = "source-image-missing"
            add_verified_gold_context(row, intake_row)
            results.append(row)
            continue

        existing = output_xml if args.reuse_existing and output_xml.is_file() else None
        if existing is not None:
            exit_code, runtime_seconds, run_error = 0, 0.0, ""
            row["reusedExisting"] = True
        elif not runtime_available:
            exit_code, runtime_seconds, run_error = 127, 0.0, "clarity-runtime-missing"
        else:
            piece_dir.mkdir(parents=True, exist_ok=True)
            preprocess = auto_trim_page(source, input_png, input_pdf)
            preprocess_path.write_text(json.dumps(preprocess, indent=2) + "\n", encoding="utf-8")
            if output_xml.is_file():
                output_xml.unlink()
            exit_code, runtime_seconds, run_error = run_clarity(
                python,
                clarity_repo,
                input_pdf,
                output_xml,
                work_dir,
                log_path,
                env,
                args.device,
                args.beam_width,
                args.timeout,
            )
            existing = output_xml if output_xml.is_file() else None
        row.update(
            {
                "clarityExit": exit_code,
                "runtimeSeconds": round(runtime_seconds, 3),
                "preprocess": "row-mean-page-trim",
                "logPath": str(log_path.relative_to(REPO)) if log_path.is_relative_to(REPO) else str(log_path),
            }
        )
        if existing is None:
            row["status"] = run_error or "clarity-output-missing"
            add_verified_gold_context(row, intake_row)
        else:
            benchmark = evaluate_pair(
                intake_row,
                {piece_id: {"mxl": str(existing)}},
                piece_dir,
                onset_tolerance_quarters=0.25,
            )
            row.update(benchmark)
            row["engine"] = "clarity-omr"
            row["variant"] = f"auto-page-trim-beam{args.beam_width}"
            row["status"] = "ok" if benchmark.get("parseOk") else benchmark.get("blockingReason", "parse-failed")
        results.append(row)

    clarity = aggregate_metrics(results)
    comparison = {"clarity": clarity, **external_summaries()}
    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "complete": len(results) == len(rows_in),
        "evaluationMode": "independent-source-gold",
        "inputVariant": "generic-auto-page-trim",
        "runtime": runtime,
        "threadLimits": THREAD_ENV,
        "strictThresholds": strict_thresholds(),
        "rawNativeSmoke": {
            "pieceId": "violin-ex05",
            "staffCrops": 0,
            "status": "clarity-staff-detection-failed",
            "includedInAggregate": False,
            "reason": "viewer chrome and black bars prevented native Stage-A staff detection",
        },
        "gate": {
            "name": "western-strings-m4-clarity-source-benchmark",
            "automaticAdoptionReady": automatic_adoption_ready(clarity, len(rows_in)),
            "studentGateReady": False,
            "reason": "eval-only-transformer-omr-engine-comparison",
            "runtimeEffect": "none",
        },
        "comparison": comparison,
        "artifacts": {
            "intake": str(intake_path),
            "json": str(report_path),
            "csv": str(csv_path),
        },
        "rows": results,
    }
    write_report(report_path, report)
    columns = sorted({key for row in results for key in row})
    write_csv(csv_path, results, columns)
    print(json.dumps({"gate": report["gate"], "comparison": comparison}, ensure_ascii=False, indent=2))
    return 0 if all(row.get("status") == "ok" for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
