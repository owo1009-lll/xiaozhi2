#!/usr/bin/env python3
"""Evaluate Oemer on the frozen M4 independent real-photo benchmark.

This is an eval-only engine comparison. It never updates the score store,
teacher packs, or any student-facing OMR gate.
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

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_western_strings_m4_omr_benchmark import (  # noqa: E402
    REPO,
    evaluate_pair,
    parse_notes,
    read_csv,
    repo_path,
    safe_rate,
    verify_source_derived_gold,
    write_csv,
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
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "oemer-source-benchmark"
)
STRICT_MIN_PRECISION = 0.98
STRICT_MIN_RECALL = 0.95
STRICT_MIN_ONSET_QUARTER_ACCURACY = 0.95
STRICT_MIN_MEASURE_ACCURACY = 0.95
THREAD_ENV = {
    "OMP_NUM_THREADS": "4",
    "OPENBLAS_NUM_THREADS": "4",
    "MKL_NUM_THREADS": "4",
    "NUMBA_NUM_THREADS": "4",
    "TF_NUM_INTRAOP_THREADS": "4",
    "TF_NUM_INTEROP_THREADS": "2",
}


def prepare_up2(source: Path, destination: Path) -> Path:
    with Image.open(source) as opened:
        image = opened.convert("L")
        image = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)
        destination.parent.mkdir(parents=True, exist_ok=True)
        image.convert("RGB").save(destination, dpi=(300, 300))
    return destination


def build_oemer_env(base: dict[str, str], sklearn_site_packages: Path | None = None) -> dict[str, str]:
    env = dict(base)
    env.update(THREAD_ENV)
    if sklearn_site_packages is not None:
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = str(sklearn_site_packages) + (os.pathsep + existing if existing else "")
    return env


def find_musicxml(output_dir: Path) -> Path | None:
    candidates = sorted(output_dir.rglob("*.musicxml"))
    return candidates[0] if len(candidates) == 1 else None


def classify_oemer_failure(log_path: Path) -> str:
    if not log_path.is_file():
        return ""
    log = log_path.read_bytes().decode("utf-8", errors="ignore")
    if "assert track_nums == 2" in log and "AssertionError: 3" in log:
        return "oemer-build-track-count-assertion"
    if "Traceback (most recent call last)" in log:
        return "oemer-runtime-error"
    return ""


def runtime_probe(python: Path, env: dict[str, str]) -> dict[str, str]:
    code = (
        "import importlib.metadata, json, sklearn; "
        "print(json.dumps({'sklearn': sklearn.__version__, "
        "'oemer': importlib.metadata.version('oemer')}))"
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


def run_oemer(
    python: Path,
    image: Path,
    output_dir: Path,
    log_path: Path,
    env: dict[str, str],
    timeout_seconds: int,
    expected_sklearn: str,
) -> tuple[int, float, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    version_check = (
        f"assert sklearn.__version__ == {expected_sklearn!r}, sklearn.__version__; "
        if expected_sklearn
        else ""
    )
    command_code = f"import onnxruntime, sklearn; {version_check}from oemer.ete import main; main()"
    command = [
        str(python),
        "-c",
        command_code,
        image.name,
        "-o",
        output_dir.name,
    ]
    started = time.monotonic()
    try:
        with log_path.open("wb") as log_handle:
            completed = subprocess.run(
                command,
                cwd=image.parent,
                env=env,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                timeout=timeout_seconds,
                check=False,
            )
        return completed.returncode, time.monotonic() - started, ""
    except subprocess.TimeoutExpired:
        return 124, time.monotonic() - started, "oemer-timeout"


def aggregate_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    usable = [row for row in rows if row.get("benchmarkUsable") and row.get("parseOk")]
    verified_rows = [row for row in rows if row.get("goldSourceVerified") == "yes"]
    gold_notes = sum(int(row.get("goldNotes") or 0) for row in usable)
    attempted_gold_notes = sum(int(row.get("goldNotes") or 0) for row in verified_rows)
    draft_notes = sum(int(row.get("draftNotes") or 0) for row in usable)
    pitch_exact = sum(int(row.get("pitchExact") or 0) for row in usable)
    onset_exact = sum(
        round(float(row.get("onsetQuarterAccuracy") or 0) * int(row.get("goldNotes") or 0))
        for row in usable
    )
    measure_exact = sum(
        round(float(row.get("measureAccuracy") or 0) * int(row.get("goldNotes") or 0))
        for row in usable
    )
    pitch_only_strict_rows = [
        row
        for row in usable
        if float(row.get("pitchPrecision") or 0) >= STRICT_MIN_PRECISION
        and float(row.get("pitchRecall") or 0) >= STRICT_MIN_RECALL
    ]
    strict_rows = [
        row
        for row in pitch_only_strict_rows
        if float(row.get("onsetQuarterAccuracy") or 0) >= STRICT_MIN_ONSET_QUARTER_ACCURACY
        and float(row.get("measureAccuracy") or 0) >= STRICT_MIN_MEASURE_ACCURACY
    ]
    return {
        "rows": len(rows),
        "usableRows": len(usable),
        "engineFailureRows": len(rows) - len(usable),
        "goldNotes": gold_notes,
        "attemptedGoldNotes": attempted_gold_notes,
        "draftNotes": draft_notes,
        "pitchExact": pitch_exact,
        "pitchPrecision": round(safe_rate(pitch_exact, draft_notes), 6),
        "pitchRecall": round(safe_rate(pitch_exact, gold_notes), 6),
        "pitchRecallIncludingEngineFailures": round(safe_rate(pitch_exact, attempted_gold_notes), 6),
        "onsetQuarterAccuracy": round(safe_rate(onset_exact, gold_notes), 6),
        "measureAccuracy": round(safe_rate(measure_exact, gold_notes), 6),
        "pitchOnlyStrictPassRows": len(pitch_only_strict_rows),
        "pitchOnlyStrictPassPieceIds": [row.get("pieceId") for row in pitch_only_strict_rows],
        "strictPassRows": len(strict_rows),
        "strictPassPieceIds": [row.get("pieceId") for row in strict_rows],
    }


def automatic_adoption_ready(summary: dict[str, Any], expected_rows: int) -> bool:
    return (
        expected_rows > 0
        and summary.get("rows") == expected_rows
        and summary.get("usableRows") == expected_rows
        and summary.get("engineFailureRows") == 0
        and summary.get("strictPassRows") == expected_rows
    )


def audiveris_up2_rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    report = json.loads(path.read_text(encoding="utf-8"))
    return [row for row in report.get("rows", []) if row.get("variant") == "up2" and row.get("status") == "ok"]


def compare_engines(oemer_rows: list[dict[str, Any]], audiveris_rows: list[dict[str, Any]]) -> dict[str, Any]:
    audiveris_by_piece = {str(row.get("pieceId") or row.get("piece") or ""): row for row in audiveris_rows}
    per_piece = []
    paired_piece_ids: list[str] = []
    for row in oemer_rows:
        piece_id = str(row.get("pieceId") or "")
        baseline = audiveris_by_piece.get(piece_id)
        if baseline is None or not row.get("parseOk"):
            if baseline is not None:
                per_piece.append(
                    {
                        "pieceId": piece_id,
                        "oemerStatus": row.get("status"),
                        "oemerPrecision": "",
                        "oemerRecall": "",
                        "audiverisPrecision": baseline.get("pitchPrecision"),
                        "audiverisRecall": baseline.get("pitchRecall"),
                        "precisionDelta": "",
                        "recallDelta": "",
                    }
                )
            continue
        paired_piece_ids.append(piece_id)
        per_piece.append(
            {
                "pieceId": piece_id,
                "oemerStatus": row.get("status"),
                "oemerPrecision": row.get("pitchPrecision"),
                "oemerRecall": row.get("pitchRecall"),
                "audiverisPrecision": baseline.get("pitchPrecision"),
                "audiverisRecall": baseline.get("pitchRecall"),
                "precisionDelta": round(
                    float(row.get("pitchPrecision") or 0) - float(baseline.get("pitchPrecision") or 0), 6
                ),
                "recallDelta": round(
                    float(row.get("pitchRecall") or 0) - float(baseline.get("pitchRecall") or 0), 6
                ),
            }
        )
    paired = set(paired_piece_ids)
    return {
        "oemer": aggregate_metrics(oemer_rows),
        "audiverisUp2": aggregate_metrics(audiveris_rows),
        "pairedSubset": {
            "pieceIds": paired_piece_ids,
            "oemer": aggregate_metrics([row for row in oemer_rows if row.get("pieceId") in paired]),
            "audiverisUp2": aggregate_metrics(
                [row for row in audiveris_rows if (row.get("pieceId") or row.get("piece")) in paired]
            ),
        },
        "perPiece": per_piece,
    }


def add_verified_gold_context(row: dict[str, Any], intake_row: dict[str, str]) -> None:
    gold_path = repo_path(intake_row.get("requiredCleanScorePath", ""))
    verified, error = verify_source_derived_gold(intake_row, gold_path)
    row["goldSourceVerified"] = "yes" if verified else ""
    row["goldProvenance"] = intake_row.get("goldProvenance", "")
    row["goldSourceError"] = error
    if verified:
        row["goldNotes"] = len(parse_notes(gold_path))


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
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--pieces", nargs="+", default=[])
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--sklearn-site-packages", default="")
    parser.add_argument("--expected-sklearn", default="")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--reuse-existing", action="store_true")
    args = parser.parse_args(argv)

    intake_path = Path(args.intake)
    out_root = Path(args.out)
    report_path = out_root / "oemer-source-benchmark.json"
    python = Path(args.python)
    sklearn_site_packages = Path(args.sklearn_site_packages).resolve() if args.sklearn_site_packages else None
    if not intake_path.is_file():
        raise SystemExit(f"intake not found: {intake_path}")
    if sklearn_site_packages is not None and not sklearn_site_packages.is_dir():
        raise SystemExit(f"scikit-learn site-packages not found: {sklearn_site_packages}")

    rows_in = read_csv(intake_path)
    if args.pieces:
        requested = set(args.pieces)
        rows_in = [row for row in rows_in if row.get("pieceId") in requested]
        missing = requested - {str(row.get("pieceId") or "") for row in rows_in}
        if missing:
            raise SystemExit(f"pieces not found in intake: {sorted(missing)}")
    if not rows_in:
        raise SystemExit("benchmark intake contains no rows")
    env = build_oemer_env(os.environ, sklearn_site_packages)
    try:
        runtime = runtime_probe(python, env)
        runtime_available = True
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        if not args.reuse_existing:
            raise SystemExit(f"Oemer runtime probe failed: {error}") from error
        runtime = read_previous_runtime(report_path)
        runtime_available = False
        runtime["reusedExistingOnly"] = True
    runtime["oemerRuntimeAvailable"] = runtime_available
    runtime["python"] = str(python)
    if runtime_available and args.expected_sklearn and runtime.get("sklearn") != args.expected_sklearn:
        raise SystemExit(
            f"scikit-learn version mismatch: expected {args.expected_sklearn}, got {runtime.get('sklearn')}"
        )

    out_root.mkdir(parents=True, exist_ok=True)
    csv_path = out_root / "oemer-source-benchmark.csv"
    results: list[dict[str, Any]] = []
    for index, intake_row in enumerate(rows_in, start=1):
        piece_id = str(intake_row.get("pieceId") or "")
        source = repo_path(intake_row.get("currentScorePath", ""))
        piece_dir = out_root / piece_id
        image = piece_dir / f"{piece_id}-up2.png"
        omr_dir = piece_dir / "omr-sk120"
        log_path = piece_dir / "oemer-sk120.log"
        print(json.dumps({"stage": "piece-start", "index": index, "total": len(rows_in), "pieceId": piece_id}), flush=True)
        row: dict[str, Any] = {"pieceId": piece_id, "engine": "oemer", "variant": "up2", "status": ""}
        if not source.is_file():
            row["status"] = "source-image-missing"
            results.append(row)
            continue
        prepare_up2(source, image)
        existing = find_musicxml(omr_dir) if args.reuse_existing else None
        existing_failure = classify_oemer_failure(log_path) if args.reuse_existing and existing is None else ""
        if existing is not None:
            exit_code, runtime_seconds, run_error = 0, 0.0, ""
            row["reusedExisting"] = True
        elif existing_failure:
            exit_code, runtime_seconds, run_error = 1, 0.0, existing_failure
            row["reusedExistingFailure"] = True
        elif not runtime_available:
            exit_code, runtime_seconds, run_error = 127, 0.0, "oemer-runtime-missing"
        else:
            exit_code, runtime_seconds, run_error = run_oemer(
                python,
                image,
                omr_dir,
                log_path,
                env,
                args.timeout,
                args.expected_sklearn,
            )
            existing = find_musicxml(omr_dir)
        row.update(
            {
                "oemerExit": exit_code,
                "runtimeSeconds": round(runtime_seconds, 3),
                "logPath": str(log_path.relative_to(REPO)) if log_path.is_relative_to(REPO) else str(log_path),
            }
        )
        if existing is None:
            row["status"] = run_error or "oemer-output-missing-or-ambiguous"
            add_verified_gold_context(row, intake_row)
        else:
            benchmark = evaluate_pair(
                intake_row,
                {piece_id: {"mxl": str(existing)}},
                omr_dir,
                onset_tolerance_quarters=0.25,
            )
            row.update(benchmark)
            row["status"] = "ok" if benchmark.get("parseOk") else benchmark.get("blockingReason", "parse-failed")
        results.append(row)
        comparison = compare_engines(results, audiveris_up2_rows(Path(args.audiveris_report)))
        checkpoint = {
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "complete": len(results) == len(rows_in),
            "evaluationMode": "independent-source-gold",
            "runtime": runtime,
            "threadLimits": THREAD_ENV,
            "strictThresholds": {
                "minPitchPrecision": STRICT_MIN_PRECISION,
                "minPitchRecall": STRICT_MIN_RECALL,
                "minOnsetQuarterAccuracy": STRICT_MIN_ONSET_QUARTER_ACCURACY,
                "minMeasureAccuracy": STRICT_MIN_MEASURE_ACCURACY,
            },
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
                    "runtimeSeconds": row.get("runtimeSeconds"),
                }
            ),
            flush=True,
        )

    comparison = compare_engines(results, audiveris_up2_rows(Path(args.audiveris_report)))
    final_report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "complete": len(results) == len(rows_in),
        "evaluationMode": "independent-source-gold",
        "runtime": {**runtime, "expectedSklearn": args.expected_sklearn},
        "threadLimits": THREAD_ENV,
        "strictThresholds": {
            "minPitchPrecision": STRICT_MIN_PRECISION,
            "minPitchRecall": STRICT_MIN_RECALL,
            "minOnsetQuarterAccuracy": STRICT_MIN_ONSET_QUARTER_ACCURACY,
            "minMeasureAccuracy": STRICT_MIN_MEASURE_ACCURACY,
        },
        "gate": {
            "name": "western-strings-m4-oemer-source-benchmark",
            "automaticAdoptionReady": automatic_adoption_ready(comparison["oemer"], len(rows_in)),
            "studentGateReady": False,
            "reason": "eval-only-stronger-omr-engine-comparison",
            "runtimeEffect": "none",
        },
        "comparison": comparison,
        "artifacts": {
            "intake": str(intake_path),
            "audiverisReport": str(args.audiveris_report),
            "json": str(report_path),
            "csv": str(csv_path),
        },
        "rows": results,
    }
    write_report(report_path, final_report)
    columns = sorted({key for row in results for key in row})
    write_csv(csv_path, results, columns)
    print(json.dumps({"gate": final_report["gate"], "comparison": comparison}, ensure_ascii=False, indent=2))
    return 0 if len(results) == len(rows_in) and all(row.get("status") == "ok" for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
