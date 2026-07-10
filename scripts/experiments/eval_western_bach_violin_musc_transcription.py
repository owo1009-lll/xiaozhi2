from __future__ import annotations

import argparse
import hashlib
import json
import math
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
    aggregate_units,
    evaluate_unit,
    load_events,
    load_reference_rows,
)


DEFAULT_AUDIT = (
    REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
)
DEFAULT_MUSC_REPO = REPO_ROOT / "data" / "external" / "violin-transcription"
DEFAULT_BASIC_CACHE = (
    REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-cache"
)
DEFAULT_OUTPUT_DIR = (
    REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-musc-pilot"
)
EXPECTED_REPO_COMMIT = "17e198cad1f355c566a26a6d58ee0559fd198ffa"
EXPECTED_WEIGHT_SHA256 = "a913356f059be6dc930be41158ac864f7d5511889ef0b2a6b6ba75a4a8732750"
MONOPHONIC_DOUBLE_STOP_RATIO_MAX = 0.05
DEFAULT_POSTPROCESSING = {
    "onsetThreshold": 0.5,
    "frameThreshold": 0.3,
    "minimumNoteLengthMs": 127.7,
}
FRESH_CONFIRMATION_PERFORMERS = ("Oliver Colbentson", "Silei Li")
FRESH_CORE_PERFORMERS = ("Oliver Colbentson",)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def double_stop_ratio(row: dict[str, Any]) -> float:
    return safe_float(row.get("referenceDoubleStopNoteCount")) / max(
        1.0, safe_float(row.get("referenceNoteCount"), 1.0)
    )


def select_holdout_pilot(rows: list[dict[str, Any]], max_units: int = 6) -> list[dict[str, Any]]:
    eligible = [
        row
        for row in rows
        if row.get("readyForEvalBenchmark") is True
        and row.get("benchmarkSplit") == "holdout-unseen-performer"
    ]
    by_work: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in eligible:
        by_work[str(row.get("work") or "unknown")].append(row)
    selected = []
    for work in sorted(by_work):
        selected.append(
            min(
                by_work[work],
                key=lambda row: (
                    double_stop_ratio(row),
                    safe_float((row.get("audio") or {}).get("durationSeconds"), 1e9),
                    str(row.get("unit") or ""),
                ),
            )
        )
        if len(selected) >= max_units:
            break
    return selected


def select_fresh_confirmation(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        [
            row
            for row in rows
            if row.get("readyForEvalBenchmark") is True
            and row.get("benchmarkSplit") == "holdout-unseen-performer"
            and row.get("violinist") in FRESH_CONFIRMATION_PERFORMERS
        ],
        key=lambda row: (
            str(row.get("violinist") or ""),
            str(row.get("work") or ""),
            str(row.get("movement") or ""),
            str(row.get("unit") or ""),
        ),
    )


def verify_musc_checkout(repo: Path) -> dict[str, Any]:
    model_py = repo / "musc" / "model.py"
    weight = repo / "musc" / "violin_model.pt"
    git_head = repo / ".git" / "HEAD"
    issues = []
    if not model_py.is_file():
        issues.append("musc-model-code-missing")
    if not weight.is_file():
        issues.append("musc-weight-missing")
    weight_hash = sha256_file(weight) if weight.is_file() else None
    if weight_hash != EXPECTED_WEIGHT_SHA256:
        issues.append("musc-weight-sha256-mismatch")
    commit = None
    if git_head.is_file():
        head_value = git_head.read_text(encoding="utf-8").strip()
        if head_value.startswith("ref: "):
            ref_path = repo / ".git" / head_value[5:]
            if ref_path.is_file():
                commit = ref_path.read_text(encoding="utf-8").strip()
        else:
            commit = head_value
    if commit != EXPECTED_REPO_COMMIT:
        issues.append("musc-repository-commit-mismatch")
    return {
        "repository": "https://github.com/MTG/violin-transcription",
        "license": "AGPL-3.0",
        "commit": commit,
        "expectedCommit": EXPECTED_REPO_COMMIT,
        "weightPath": str(weight),
        "weightBytes": weight.stat().st_size if weight.is_file() else None,
        "weightSha256": weight_hash,
        "expectedWeightSha256": EXPECTED_WEIGHT_SHA256,
        "ready": not issues,
        "issues": issues,
    }


def normalize_musc_events(raw_notes: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    events = []
    for start, end, midi, amplitude, pitch_bends in raw_notes:
        start_value = float(start)
        end_value = float(end)
        amplitude_value = float(amplitude)
        bends = np.asarray([] if pitch_bends is None else pitch_bends, dtype=np.float64)
        if not all(math.isfinite(value) for value in (start_value, end_value, amplitude_value)):
            raise ValueError("musc-event-nonfinite")
        if end_value <= start_value:
            raise ValueError("musc-event-nonpositive-duration")
        if bends.size and not np.isfinite(bends).all():
            raise ValueError("musc-pitch-bend-nonfinite")
        events.append(
            {
                "start": start_value,
                "end": end_value,
                "midi": int(midi),
                "confidence": amplitude_value,
                "pitchBendFrameCount": int(bends.size),
                "meanAbsPitchBend": float(np.mean(np.abs(bends))) if bends.size else None,
                "maxAbsPitchBend": float(np.max(np.abs(bends))) if bends.size else None,
            }
        )
    return sorted(events, key=lambda item: (item["start"], item["end"], item["midi"]))


def normalize_postprocessing(value: dict[str, Any] | None) -> dict[str, float]:
    source = value or DEFAULT_POSTPROCESSING
    output = {
        "onsetThreshold": safe_float(source.get("onsetThreshold"), 0.5),
        "frameThreshold": safe_float(source.get("frameThreshold"), 0.3),
        "minimumNoteLengthMs": safe_float(source.get("minimumNoteLengthMs"), 127.7),
    }
    if not 0.0 < output["onsetThreshold"] < 1.0:
        raise ValueError("invalid-onset-threshold")
    if not 0.0 < output["frameThreshold"] < 1.0:
        raise ValueError("invalid-frame-threshold")
    if output["minimumNoteLengthMs"] <= 0.0:
        raise ValueError("invalid-minimum-note-length")
    return output


def postprocessing_tag(config: dict[str, float]) -> str:
    return "o{onset:03d}-f{frame:03d}-m{length:04d}".format(
        onset=round(config["onsetThreshold"] * 100),
        frame=round(config["frameThreshold"] * 100),
        length=round(config["minimumNoteLengthMs"]),
    )


def decode_musc_output(
    model: Any,
    output: dict[str, np.ndarray],
    config: dict[str, Any] | None = None,
    *,
    include_pitch_bends: bool = True,
) -> list[dict[str, Any]]:
    from musc.postprocessing import spotify_create_notes

    normalized = normalize_postprocessing(config)
    raw_notes = spotify_create_notes(
        output["note"],
        output["onset"],
        note_low=model.labeling.midi_centers[0],
        note_high=model.labeling.midi_centers[-1],
        onset_thresh=normalized["onsetThreshold"],
        frame_thresh=normalized["frameThreshold"],
        infer_onsets=True,
        min_note_len=max(
            1,
            int(
                round(
                    normalized["minimumNoteLengthMs"]
                    / 1000.0
                    * (model.sr / model.hop_length)
                )
            ),
        ),
        melodia_trick=True,
    )
    if include_pitch_bends:
        raw_notes_with_bends = model.get_pitch_bends(output["f0"], raw_notes)
    else:
        raw_notes_with_bends = [(*note, None) for note in raw_notes]
    times = output["time"]
    timed_notes = [
        (
            float(times[start]),
            float(times[end]),
            int(midi),
            float(amplitude),
            pitch_bends,
        )
        for start, end, midi, amplitude, pitch_bends in raw_notes_with_bends
    ]
    return normalize_musc_events(timed_notes)


def load_or_predict_musc_events(
    model: Any,
    audio_path: Path,
    cache_dir: Path,
    *,
    force: bool = False,
    batch_size: int = 32,
    postprocessing: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    normalized_postprocessing = normalize_postprocessing(postprocessing)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / (
        f"{audio_path.stem}.{postprocessing_tag(normalized_postprocessing)}.musc.json"
    )
    if cache_path.is_file() and not force:
        return sorted(
            json.loads(cache_path.read_text(encoding="utf-8")),
            key=lambda item: (float(item["start"]), float(item["end"]), int(item["midi"])),
        )
    waveform, _ = librosa.load(str(audio_path), sr=44100, mono=True, dtype=np.float32)
    output = model.predict(waveform, batch_size)
    events = decode_musc_output(
        model,
        output,
        normalized_postprocessing,
        include_pitch_bends=True,
    )
    cache_path.write_text(json.dumps(events, ensure_ascii=False) + "\n", encoding="utf-8")
    return events


def aggregate_selected(units: list[dict[str, Any]], model_name: str, role: str) -> dict[str, Any]:
    selected = [unit[model_name] for unit in units if unit["role"] == role]
    return aggregate_units(selected)


def v2_core_gate(metrics: dict[str, Any]) -> dict[str, Any]:
    tolerant = metrics.get("100ms") or {}
    checks = {
        "precisionAt100ms": (tolerant.get("precision") or 0.0) >= 0.90,
        "recallAt100ms": (tolerant.get("recall") or 0.0) >= 0.85,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "thresholds": {
            "precisionAt100msMin": 0.90,
            "recallAt100msMin": 0.85,
        },
    }


def v3_core_gate(metrics: dict[str, Any]) -> dict[str, Any]:
    strict = metrics.get("50ms") or {}
    tolerant = metrics.get("100ms") or {}
    checks = {
        "precisionAt50ms": (strict.get("precision") or 0.0) >= 0.90,
        "recallAt50ms": (strict.get("recall") or 0.0) >= 0.80,
        "precisionAt100ms": (tolerant.get("precision") or 0.0) >= 0.90,
        "recallAt100ms": (tolerant.get("recall") or 0.0) >= 0.85,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "thresholds": {
            "precisionAt50msMin": 0.90,
            "recallAt50msMin": 0.80,
            "precisionAt100msMin": 0.90,
            "recallAt100msMin": 0.85,
        },
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# MUSC Violin Transcription Pilot",
        "",
        "Frozen MTG MUSC model on unseen-performer public Bach recordings. Reference note times are estimated CQT-DTW, not human onset gold.",
        "",
        f"- muscV2CoreGatePassed: {str(report['muscV2CoreGatePassed']).lower()}",
        f"- muscV3CoreGatePassed: {str(report['muscV3CoreGatePassed']).lower()}",
        f"- studentReleaseEligible: {str(report['studentReleaseEligible']).lower()}",
        f"- checkout: {report['muscCheckout']}",
        "",
        "| Unit | Role | Gold | MUSC estimated | MUSC F1@50 | MUSC F1@100 | Basic F1@50 | Basic F1@100 |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for unit in report["units"]:
        musc = unit["musc"]["byOnsetTolerance"]
        basic = unit["basicPitch"]["byOnsetTolerance"]
        lines.append(
            f"| {unit['unit']} | {unit['role']} | {unit['musc']['referenceNotes']} | "
            f"{unit['musc']['estimatedNotes']} | {musc['50ms']['f1']} | {musc['100ms']['f1']} | "
            f"{basic['50ms']['f1']} | {basic['100ms']['f1']} |"
        )
    lines.append("")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate the frozen MTG MUSC model against the public Bach violin reference notes."
    )
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--musc-repo", default=str(DEFAULT_MUSC_REPO))
    parser.add_argument("--basic-cache", default=str(DEFAULT_BASIC_CACHE))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--max-units", type=int, default=6)
    parser.add_argument(
        "--selection",
        choices=("diagnostic-pilot", "fresh-confirmation"),
        default="diagnostic-pilot",
    )
    parser.add_argument("--unit", action="append", default=[])
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--postprocessing-config", default="")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = json.loads(Path(args.audit).resolve().read_text(encoding="utf-8"))
    dataset_root = REPO_ROOT / str(audit["datasetRoot"])
    references = load_reference_rows(dataset_root)
    requested = {str(value).strip() for value in args.unit if str(value).strip()}
    if requested:
        selected = [row for row in audit["rows"] if row.get("unit") in requested]
        selection_policy = "explicit-unit-list"
    elif args.selection == "fresh-confirmation":
        selected = select_fresh_confirmation(audit["rows"])
        selection_policy = "all units from frozen fresh performers: Oliver Colbentson and Silei Li"
    else:
        selected = select_holdout_pilot(audit["rows"], max(1, int(args.max_units)))
        selection_policy = "one-unseen-performer-unit-per-work; minimize double-stop ratio then duration"
    if not selected:
        raise SystemExit("No unseen-performer Bach units selected.")

    musc_repo = Path(args.musc_repo).resolve()
    checkout = verify_musc_checkout(musc_repo)
    if checkout["ready"] is not True:
        raise SystemExit(f"MUSC checkout is not ready: {checkout['issues']}")
    if str(musc_repo) not in sys.path:
        sys.path.insert(0, str(musc_repo))
    from musc.model import PretrainedModel  # noqa: E402

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = PretrainedModel(instrument="violin").to(device)
    postprocessing = DEFAULT_POSTPROCESSING
    if str(args.postprocessing_config).strip():
        calibration = json.loads(
            Path(args.postprocessing_config).resolve().read_text(encoding="utf-8")
        )
        postprocessing = calibration.get("selectedPostprocessing") or calibration
    postprocessing = normalize_postprocessing(postprocessing)
    output_dir = Path(args.output_dir).resolve()
    cache_dir = output_dir / "cache"
    basic_cache = Path(args.basic_cache).resolve()
    unit_reports = []
    failures = []
    for index, source in enumerate(selected, start=1):
        print(f"[{index}/{len(selected)}] {source['unit']}", file=sys.stderr, flush=True)
        try:
            reference_rows = references.get(source["pieceId"], [])
            if not reference_rows:
                raise ValueError("reference-notes-missing")
            audio_path = REPO_ROOT / str(source["audioPath"])
            musc_events = load_or_predict_musc_events(
                model,
                audio_path,
                cache_dir,
                force=bool(args.force),
                batch_size=max(1, int(args.batch_size)),
                postprocessing=postprocessing,
            )
            basic_events = load_events(basic_cache, audio_path)
            role = (
                "monophonic-core"
                if double_stop_ratio(source) <= MONOPHONIC_DOUBLE_STOP_RATIO_MAX
                else "double-stop-stress-review-only"
            )
            unit_reports.append(
                {
                    "unit": source["unit"],
                    "violinist": source["violinist"],
                    "work": source["work"],
                    "movement": source["movement"],
                    "benchmarkSplit": source["benchmarkSplit"],
                    "license": source["license"],
                    "doubleStopRatio": double_stop_ratio(source),
                    "role": role,
                    "pitchBendEventCount": sum(
                        int(event.get("pitchBendFrameCount") or 0) > 0 for event in musc_events
                    ),
                    "musc": evaluate_unit(reference_rows, musc_events),
                    "basicPitch": evaluate_unit(reference_rows, basic_events),
                }
            )
        except Exception as exc:
            failures.append({"unit": source["unit"], "reason": f"{type(exc).__name__}:{exc}"})

    musc_core = aggregate_selected(unit_reports, "musc", "monophonic-core")
    basic_core = aggregate_selected(unit_reports, "basicPitch", "monophonic-core")
    musc_stress = aggregate_selected(unit_reports, "musc", "double-stop-stress-review-only")
    basic_stress = aggregate_selected(unit_reports, "basicPitch", "double-stop-stress-review-only")
    v2_gate = v2_core_gate(musc_core)
    v3_gate = v3_core_gate(musc_core)
    performer_gates = {}
    if args.selection == "fresh-confirmation":
        for performer in FRESH_CORE_PERFORMERS:
            performer_units = [
                unit["musc"]
                for unit in unit_reports
                if unit["role"] == "monophonic-core" and unit["violinist"] == performer
            ]
            metrics = aggregate_units(performer_units)
            performer_gates[performer] = {
                "metrics": metrics,
                "v2Gate": v2_core_gate(metrics),
                "v3Gate": v3_core_gate(metrics),
            }
    fresh_confirmation_passed = bool(
        args.selection == "fresh-confirmation"
        and len(performer_gates) == len(FRESH_CORE_PERFORMERS)
        and all(value["v2Gate"]["passed"] for value in performer_gates.values())
        and v2_gate["passed"]
    )
    report = {
        "ok": bool(unit_reports) and not failures,
        "evidenceType": "public-professional-solo-violin-estimated-note-alignment",
        "selectionPolicy": selection_policy,
        "muscCheckout": checkout,
        "device": device,
        "postprocessing": postprocessing,
        "units": unit_reports,
        "aggregate": {
            "monophonicCore": {"musc": musc_core, "basicPitch": basic_core},
            "doubleStopStressReviewOnly": {"musc": musc_stress, "basicPitch": basic_stress},
        },
        "muscV2CoreGate": v2_gate,
        "muscV3CoreGate": v3_gate,
        "muscV2CoreGatePassed": not failures and v2_gate["passed"],
        "muscV3CoreGatePassed": not failures and v3_gate["passed"],
        "freshPerformerGates": performer_gates,
        "freshConfirmationPassed": not failures and fresh_confirmation_passed,
        "doubleStopAutoFeedbackEligible": False,
        "studentReleaseEligible": False,
        "releaseBlockers": [
            "reference-alignments-are-estimated-not-human-gold",
            "professional-clean-performance-domain-does-not-test-student-errors",
            "double-stop-stress-is-review-only",
            "external-musc-code-is-agpl-3.0-and-not-production-integrated",
        ],
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
                "device": device,
                "unitCount": len(unit_reports),
                "muscCore": musc_core,
                "basicPitchCore": basic_core,
                "muscDoubleStopStress": musc_stress,
                "basicPitchDoubleStopStress": basic_stress,
                "muscV2CoreGate": v2_gate,
                "muscV3CoreGate": v3_gate,
                "freshPerformerGates": performer_gates,
                "freshConfirmationPassed": fresh_confirmation_passed,
                "failures": failures,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["ok"] and report["muscV2CoreGatePassed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
