from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import torch


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_basic_pitch_transcription import (  # noqa: E402
    evaluate_unit,
    load_reference_rows,
    metrics_from_counts,
)
from eval_western_bach_violin_gate_pilot import select_pilot_units  # noqa: E402
from eval_western_bach_violin_musc_transcription import (  # noqa: E402
    DEFAULT_AUDIT,
    DEFAULT_MUSC_REPO,
    decode_musc_output,
    normalize_postprocessing,
    postprocessing_tag,
    verify_musc_checkout,
)


DEFAULT_OUTPUT_DIR = (
    REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-musc-calibration"
)
ONSET_THRESHOLDS = (0.2, 0.3, 0.4, 0.5)
FRAME_THRESHOLDS = (0.2, 0.3, 0.4)
MINIMUM_NOTE_LENGTHS_MS = (30.0, 60.0, 90.0, 127.7)


def candidate_grid() -> list[dict[str, float]]:
    return [
        normalize_postprocessing(
            {
                "onsetThreshold": onset,
                "frameThreshold": frame,
                "minimumNoteLengthMs": minimum,
            }
        )
        for onset in ONSET_THRESHOLDS
        for frame in FRAME_THRESHOLDS
        for minimum in MINIMUM_NOTE_LENGTHS_MS
    ]


def aggregate_candidate(unit_rows: list[dict[str, Any]]) -> dict[str, Any]:
    output = {}
    for tolerance in ("50ms", "100ms", "300ms"):
        reference = sum(int(row["metrics"][tolerance]["referenceNotes"]) for row in unit_rows)
        estimated = sum(int(row["metrics"][tolerance]["estimatedNotes"]) for row in unit_rows)
        matched = sum(int(row["metrics"][tolerance]["matchedNotes"]) for row in unit_rows)
        output[tolerance] = metrics_from_counts(reference, estimated, matched)
    return output


def qualifies_v2(metrics: dict[str, Any]) -> bool:
    tolerant = metrics["100ms"]
    return bool(
        (tolerant.get("precision") or 0.0) >= 0.90
        and (tolerant.get("recall") or 0.0) >= 0.85
    )


def qualifies_v3(metrics: dict[str, Any]) -> bool:
    strict = metrics["50ms"]
    tolerant = metrics["100ms"]
    return bool(
        (strict.get("precision") or 0.0) >= 0.90
        and (strict.get("recall") or 0.0) >= 0.80
        and (tolerant.get("precision") or 0.0) >= 0.90
        and (tolerant.get("recall") or 0.0) >= 0.85
    )


def candidate_rank(row: dict[str, Any]) -> tuple[float, ...]:
    strict = row["aggregate"]["50ms"]
    tolerant = row["aggregate"]["100ms"]
    config = row["postprocessing"]
    return (
        float(row["v3Qualified"]),
        float(row["v2Qualified"]),
        float(tolerant.get("f1") or 0.0),
        float(tolerant.get("recall") or 0.0),
        float(strict.get("f1") or 0.0),
        float(config["minimumNoteLengthMs"]),
        float(config["onsetThreshold"]),
        float(config["frameThreshold"]),
    )


def evaluate_unit_grid(
    model: Any,
    source: dict[str, Any],
    reference_rows: list[dict[str, str]],
    candidates: list[dict[str, float]],
    output_path: Path,
    *,
    batch_size: int,
    force: bool,
) -> dict[str, Any]:
    if output_path.is_file() and not force:
        cached = json.loads(output_path.read_text(encoding="utf-8"))
        if cached.get("candidateTags") == [postprocessing_tag(item) for item in candidates]:
            return cached
    audio_path = REPO_ROOT / str(source["audioPath"])
    waveform, _ = librosa.load(str(audio_path), sr=44100, mono=True, dtype=np.float32)
    raw_output = model.predict(waveform, batch_size)
    candidate_rows = []
    for config in candidates:
        events = decode_musc_output(
            model,
            raw_output,
            config,
            include_pitch_bends=False,
        )
        candidate_rows.append(
            {
                "tag": postprocessing_tag(config),
                "postprocessing": config,
                "metrics": evaluate_unit(reference_rows, events)["byOnsetTolerance"],
            }
        )
    result = {
        "unit": source["unit"],
        "work": source["work"],
        "movement": source["movement"],
        "benchmarkSplit": source["benchmarkSplit"],
        "referenceNotes": len(reference_rows),
        "candidateTags": [postprocessing_tag(item) for item in candidates],
        "candidates": candidate_rows,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
    return result


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# MUSC Postprocessing Calibration",
        "",
        "Development-reference-performer only. No unseen-performer result is used for selection.",
        "",
        f"- calibrationV2Ready: {str(report['calibrationV2Ready']).lower()}",
        f"- calibrationV3Ready: {str(report['calibrationV3Ready']).lower()}",
        f"- selectedPostprocessing: {report['selectedPostprocessing']}",
        f"- selectedAggregate: {report['selectedAggregate']}",
        f"- candidateCount: {report['candidateCount']}",
        f"- v2QualifiedCandidateCount: {report['v2QualifiedCandidateCount']}",
        f"- v3QualifiedCandidateCount: {report['v3QualifiedCandidateCount']}",
        "",
    ]
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calibrate MUSC note decoding on the fixed Bach reference performer only."
    )
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--musc-repo", default=str(DEFAULT_MUSC_REPO))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--max-units", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = json.loads(Path(args.audit).resolve().read_text(encoding="utf-8"))
    selected_units = select_pilot_units(audit["rows"], max(1, int(args.max_units)))
    if not selected_units or any(
        row.get("benchmarkSplit") != "development-reference-performer"
        for row in selected_units
    ):
        raise SystemExit("Calibration units must come only from the reference-performer development split.")
    dataset_root = REPO_ROOT / str(audit["datasetRoot"])
    references = load_reference_rows(dataset_root)
    candidates = candidate_grid()
    output_dir = Path(args.output_dir).resolve()

    musc_repo = Path(args.musc_repo).resolve()
    checkout = verify_musc_checkout(musc_repo)
    if checkout["ready"] is not True:
        raise SystemExit(f"MUSC checkout is not ready: {checkout['issues']}")
    if str(musc_repo) not in sys.path:
        sys.path.insert(0, str(musc_repo))
    from musc.model import PretrainedModel  # noqa: E402

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = PretrainedModel(instrument="violin").to(device)
    unit_reports = []
    failures = []
    for index, source in enumerate(selected_units, start=1):
        print(f"[{index}/{len(selected_units)}] {source['unit']}", file=sys.stderr, flush=True)
        try:
            reference_rows = references.get(source["pieceId"], [])
            if not reference_rows:
                raise ValueError("reference-notes-missing")
            unit_reports.append(
                evaluate_unit_grid(
                    model,
                    source,
                    reference_rows,
                    candidates,
                    output_dir / "unit-grid" / f"{source['unit']}.json",
                    batch_size=max(1, int(args.batch_size)),
                    force=bool(args.force),
                )
            )
        except Exception as exc:
            failures.append({"unit": source["unit"], "reason": f"{type(exc).__name__}:{exc}"})

    rows_by_tag: dict[str, list[dict[str, Any]]] = defaultdict(list)
    config_by_tag = {}
    for unit in unit_reports:
        for candidate in unit["candidates"]:
            rows_by_tag[candidate["tag"]].append(candidate)
            config_by_tag[candidate["tag"]] = candidate["postprocessing"]
    candidate_reports = []
    for tag, rows in sorted(rows_by_tag.items()):
        aggregate = aggregate_candidate(rows)
        candidate_reports.append(
            {
                "tag": tag,
                "postprocessing": config_by_tag[tag],
                "aggregate": aggregate,
                "v2Qualified": qualifies_v2(aggregate),
                "v3Qualified": qualifies_v3(aggregate),
            }
        )
    selected = max(candidate_reports, key=candidate_rank) if candidate_reports else None
    v2_ready = bool(
        not failures
        and len(unit_reports) == len(selected_units)
        and selected
        and selected["v2Qualified"]
    )
    v3_ready = bool(v2_ready and selected and selected["v3Qualified"])
    report = {
        "ok": bool(unit_reports) and not failures,
        "evidenceType": "public-professional-reference-performer-development-calibration",
        "selectionDiscipline": "one development movement per work; no unseen-performer data used",
        "muscCheckout": checkout,
        "device": device,
        "candidateCount": len(candidate_reports),
        "v2QualifiedCandidateCount": sum(row["v2Qualified"] for row in candidate_reports),
        "v3QualifiedCandidateCount": sum(row["v3Qualified"] for row in candidate_reports),
        "selectedPostprocessing": selected["postprocessing"] if selected else None,
        "selectedAggregate": selected["aggregate"] if selected else None,
        "calibrationV2Ready": v2_ready,
        "calibrationV3Ready": v3_ready,
        "units": unit_reports,
        "candidates": sorted(candidate_reports, key=candidate_rank, reverse=True),
        "failures": failures,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "report.md").write_text(render_markdown(report), encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "candidateCount": report["candidateCount"],
                "v2QualifiedCandidateCount": report["v2QualifiedCandidateCount"],
                "v3QualifiedCandidateCount": report["v3QualifiedCandidateCount"],
                "selectedPostprocessing": report["selectedPostprocessing"],
                "selectedAggregate": report["selectedAggregate"],
                "calibrationV2Ready": v2_ready,
                "calibrationV3Ready": v3_ready,
                "failures": failures,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if v2_ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
