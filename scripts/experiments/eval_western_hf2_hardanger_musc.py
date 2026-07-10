from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import pretty_midi


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_basic_pitch_transcription import (  # noqa: E402
    aggregate_units,
    evaluate_unit,
)
from eval_western_bach_violin_musc_transcription import (  # noqa: E402
    load_or_predict_musc_events,
    normalize_postprocessing,
    postprocessing_tag,
    v2_core_gate,
    v3_core_gate,
    verify_musc_checkout,
)


DEFAULT_AUDIT = REPO_ROOT / "data" / "experiments" / "western-strings-hf2-hardanger-audit.json"
DEFAULT_CALIBRATION = (
    REPO_ROOT
    / "data"
    / "experiments"
    / "western-strings-bach-violin-musc-calibration"
    / "report.json"
)
DEFAULT_MUSC_REPO = REPO_ROOT / "data" / "external" / "violin-transcription"
DEFAULT_OUTPUT_DIR = (
    REPO_ROOT / "data" / "experiments" / "western-strings-hf2-hardanger-musc"
)
DOUBLE_STOP_ONSET_TOLERANCE_SECONDS = 0.012
EMOTION_ORDER = {name: index for index, name in enumerate(("original", "angry", "happy", "sad", "tender"))}


def reference_rows_from_midi(path: Path) -> list[dict[str, str]]:
    midi = pretty_midi.PrettyMIDI(str(path))
    notes = sorted(
        [note for instrument in midi.instruments for note in instrument.notes],
        key=lambda note: (note.start, note.pitch, note.end),
    )
    groups: list[list[pretty_midi.Note]] = []
    for note in notes:
        if not groups or note.start - groups[-1][0].start > DOUBLE_STOP_ONSET_TOLERANCE_SECONDS:
            groups.append([note])
        else:
            groups[-1].append(note)
    double_stop_ids = {id(note) for group in groups if len(group) > 1 for note in group}
    return [
        {
            "goldTime": str(note.start),
            "goldOffset": str(note.end),
            "midi": str(note.pitch),
            "doubleStop": str(id(note) in double_stop_ids).lower(),
        }
        for note in notes
    ]


def select_pairs(audit: dict[str, Any], selection: str) -> list[dict[str, Any]]:
    human_verified = [
        row
        for row in audit.get("pairs") or []
        if row.get("ready") is True and row.get("humanVerifiedHf1") is True
    ]
    if selection == "direct-core":
        human_verified = [row for row in human_verified if row.get("emotion") == "original"]
    return sorted(
        human_verified,
        key=lambda row: (
            str(row.get("songName") or ""),
            EMOTION_ORDER.get(str(row.get("emotion") or ""), len(EMOTION_ORDER)),
            str(row.get("id") or ""),
        ),
    )


def aggregate_role(units: list[dict[str, Any]], role: str) -> dict[str, Any]:
    return aggregate_units([unit["musc"] for unit in units if unit["role"] == role])


def group_metrics(units: list[dict[str, Any]], field: str) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for unit in units:
        grouped[str(unit.get(field) or "unknown")].append(unit["musc"])
    return {key: aggregate_units(value) for key, value in sorted(grouped.items())}


def musc_cache_path(
    audio_path: Path,
    cache_dir: Path,
    postprocessing: dict[str, Any],
) -> Path:
    return cache_dir / f"{audio_path.stem}.{postprocessing_tag(postprocessing)}.musc.json"


def build_incremental_plan(
    selected: list[dict[str, Any]],
    cache_dir: Path,
    postprocessing: dict[str, Any],
    *,
    force: bool,
    max_new_units: int,
) -> list[dict[str, Any]]:
    if max_new_units < 0:
        raise ValueError("max_new_units must be non-negative")
    new_units = 0
    plan = []
    for source in selected:
        cache_path = musc_cache_path(Path(source["audioPath"]), cache_dir, postprocessing)
        cached = cache_path.is_file() and not force
        if cached:
            action = "cache"
        elif new_units < max_new_units:
            action = "predict"
            new_units += 1
        else:
            action = "pending"
        plan.append({"source": source, "cachePath": cache_path, "action": action})
    return plan


def render_markdown(report: dict[str, Any]) -> str:
    direct = report["aggregate"]["directHumanCore"]
    expressive = report["aggregate"]["transferredExpressiveStress"]
    return "\n".join(
        [
            "# Frozen MUSC on HF2 Hardanger Fiddle",
            "",
            "External expressive/polyphonic bowed-string stress test. The frozen MUSC model and postprocessing are not tuned on HF2.",
            "",
            f"- selection: {report['selection']}",
            f"- evaluated/expected: {len(report['units'])}/{report['expectedUnitCount']}",
            f"- evaluationComplete: {str(report['evaluationComplete']).lower()}",
            f"- newlyPredictedUnitCount: {report['newlyPredictedUnitCount']}",
            f"- pendingUnitCount: {report['pendingUnitCount']}",
            f"- hardangerDirectCoreV2Passed: {str(report['hardangerDirectCoreV2Passed']).lower()}",
            f"- hardangerDirectCoreV3Passed: {str(report['hardangerDirectCoreV3Passed']).lower()}",
            f"- doubleStopAutoFeedbackEligible: {str(report['doubleStopAutoFeedbackEligible']).lower()}",
            f"- readyForClassicalViolinReleaseBenchmark: {str(report['readyForClassicalViolinReleaseBenchmark']).lower()}",
            f"- direct core metrics: {direct}",
            f"- expressive stress metrics: {expressive}",
            f"- failures: {report['failures']}",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate frozen MUSC on HF2 human-verified Hardanger fiddle note annotations."
    )
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--calibration", default=str(DEFAULT_CALIBRATION))
    parser.add_argument("--musc-repo", default=str(DEFAULT_MUSC_REPO))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument(
        "--selection",
        choices=("direct-core", "all-human-verified"),
        default="direct-core",
    )
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument(
        "--max-new-units",
        type=int,
        default=1,
        help="Maximum uncached recordings to infer in this invocation; 0 is status-only.",
    )
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = json.loads(Path(args.audit).resolve().read_text(encoding="utf-8"))
    if audit.get("readyForExternalHumanVerifiedStressPilot") is not True:
        raise SystemExit("HF2 audit is not ready for the external stress pilot.")
    selected = select_pairs(audit, args.selection)
    expected = 20 if args.selection == "direct-core" else 100
    if len(selected) != expected:
        raise SystemExit(f"HF2 selection count mismatch: expected {expected}, found {len(selected)}")
    if int(args.max_new_units) < 0:
        raise SystemExit("--max-new-units must be non-negative.")

    calibration = json.loads(Path(args.calibration).resolve().read_text(encoding="utf-8"))
    if calibration.get("calibrationV2Ready") is not True:
        raise SystemExit("Frozen MUSC calibration is not V2-ready.")
    postprocessing = normalize_postprocessing(calibration.get("selectedPostprocessing"))
    musc_repo = Path(args.musc_repo).resolve()
    checkout = verify_musc_checkout(musc_repo)
    if checkout["ready"] is not True:
        raise SystemExit(f"MUSC checkout is not ready: {checkout['issues']}")
    output_dir = Path(args.output_dir).resolve()
    cache_dir = output_dir / "cache"
    if args.selection == "all-human-verified":
        direct_report_path = output_dir / "report-direct-core.json"
        if not direct_report_path.is_file():
            raise SystemExit("Run the incremental direct-core gate to completion before expressive stress.")
        direct_report = json.loads(direct_report_path.read_text(encoding="utf-8"))
        if direct_report.get("hardangerDirectCoreV2Passed") is not True:
            raise SystemExit("Direct-core V2 gate has not passed; expressive stress remains blocked.")

    plan = build_incremental_plan(
        selected,
        cache_dir,
        postprocessing,
        force=bool(args.force),
        max_new_units=int(args.max_new_units),
    )
    if int(args.max_new_units) == 0 and not args.force:
        cached = [item for item in plan if item["action"] == "cache"]
        pending = [item for item in plan if item["action"] == "pending"]
        suffix = "direct-core" if args.selection == "direct-core" else "all-human-verified"
        report_path = output_dir / f"report-{suffix}.json"
        prior_report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.is_file() else None
        print(
            json.dumps(
                {
                    "ok": True,
                    "selection": args.selection,
                    "statusOnly": True,
                    "expectedUnitCount": expected,
                    "cachedUnitCount": len(cached),
                    "pendingUnitCount": len(pending),
                    "nextPending": None
                    if not pending
                    else {
                        "id": pending[0]["source"]["id"],
                        "songName": pending[0]["source"]["songName"],
                        "emotion": pending[0]["source"]["emotion"],
                    },
                    "priorReportAvailable": prior_report is not None,
                    "priorEvaluationComplete": None
                    if prior_report is None
                    else prior_report.get("evaluationComplete"),
                    "priorDirectCoreV2Passed": None
                    if prior_report is None
                    else prior_report.get("hardangerDirectCoreV2Passed"),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    prediction_required = any(item["action"] == "predict" for item in plan)
    model = None
    device = "not-loaded"
    if prediction_required:
        import torch

        if str(musc_repo) not in sys.path:
            sys.path.insert(0, str(musc_repo))
        from musc.model import PretrainedModel  # noqa: E402

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = PretrainedModel(instrument="violin").to(device)

    units = []
    failures = []
    pending = []
    cache_hits = 0
    newly_predicted = 0
    for index, item in enumerate(plan, 1):
        source = item["source"]
        if item["action"] == "pending":
            pending.append({"id": source["id"], "songName": source["songName"], "emotion": source["emotion"]})
            continue
        print(
            f"[{index}/{len(selected)}] {item['action']} {source['songName']} / {source['emotion']}",
            file=sys.stderr,
            flush=True,
        )
        try:
            midi_path = Path(source["midiPath"]).resolve()
            audio_path = Path(source["audioPath"]).resolve()
            reference_rows = reference_rows_from_midi(midi_path)
            events = load_or_predict_musc_events(
                model,
                audio_path,
                cache_dir,
                force=item["action"] == "predict" and bool(args.force),
                batch_size=max(1, int(args.batch_size)),
                postprocessing=postprocessing,
            )
            if item["action"] == "cache":
                cache_hits += 1
            else:
                newly_predicted += 1
            role = (
                "direct-human-core"
                if source.get("emotion") == "original"
                else "transferred-expressive-stress"
            )
            units.append(
                {
                    "id": source["id"],
                    "songName": source["songName"],
                    "emotion": source["emotion"],
                    "role": role,
                    "goldProvenance": source["goldProvenance"],
                    "musc": evaluate_unit(reference_rows, events),
                    "predictedPitchBendNoteCount": sum(
                        int(event.get("pitchBendFrameCount") or 0) > 0 for event in events
                    ),
                }
            )
        except Exception as error:
            failures.append(
                {
                    "id": source.get("id") or "",
                    "songName": source.get("songName") or "",
                    "reason": f"{type(error).__name__}:{error}",
                }
            )

    direct_units = [unit for unit in units if unit["role"] == "direct-human-core"]
    direct = aggregate_units([unit["musc"] for unit in direct_units])
    expressive = aggregate_role(units, "transferred-expressive-stress")
    all_metrics = aggregate_units([unit["musc"] for unit in units])
    direct_v2 = v2_core_gate(direct)
    direct_v3 = v3_core_gate(direct)
    expressive_v2 = v2_core_gate(expressive) if expressive else None
    direct_failures = {
        failure["id"]
        for failure in failures
        if any(source["id"] == failure["id"] and source.get("emotion") == "original" for source in selected)
    }
    direct_pending = [row for row in pending if row.get("emotion") == "original"]
    direct_complete = len(direct_units) == 20 and not direct_failures and not direct_pending
    evaluation_complete = len(units) == expected and not failures and not pending
    report = {
        "ok": not failures,
        "dataset": "HF2 Hardanger Fiddle Dataset",
        "evidenceType": "external-human-verified-hardanger-note-onset-pitch-stress",
        "selection": args.selection,
        "selectionDiscipline": (
            "frozen MUSC code, weights, and Bach-development postprocessing; no HF2 tuning; "
            "direct-core uses the 20 original performances annotated by performers"
        ),
        "domainCaveat": (
            "Hardanger fiddle uses non-classical tuning, sympathetic strings, ornaments, and polyphony; "
            "it is an out-of-domain bowed-string stress test, not a classical violin release benchmark"
        ),
        "muscCheckout": checkout,
        "device": device,
        "postprocessing": postprocessing,
        "expectedUnitCount": expected,
        "evaluationComplete": evaluation_complete,
        "directCoreEvaluationComplete": direct_complete,
        "cacheHitUnitCount": cache_hits,
        "newlyPredictedUnitCount": newly_predicted,
        "pendingUnitCount": len(pending),
        "pending": pending,
        "units": units,
        "aggregate": {
            "directHumanCore": direct,
            "transferredExpressiveStress": expressive,
            "allSelected": all_metrics,
            "byEmotion": group_metrics(units, "emotion"),
        },
        "directCoreV2Gate": direct_v2,
        "directCoreV3Gate": direct_v3,
        "expressiveStressV2Gate": expressive_v2,
        "hardangerDirectCoreV2Passed": direct_v2["passed"] if direct_complete else None,
        "hardangerDirectCoreV3Passed": direct_v3["passed"] if direct_complete else None,
        "doubleStopAutoFeedbackEligible": False,
        "readyForClassicalViolinReleaseBenchmark": False,
        "readyForStudentRelease": False,
        "releaseBlockers": [
            "hardanger-fiddle-is-out-of-domain-for-classical-violin-release",
            "source-repository-preserves-only-one-raw-high-resolution-csv",
            "double-stop-precision-needs-a-dedicated-event-level-gate",
            "external-musc-code-is-agpl-3.0-and-not-production-integrated",
        ],
        "failures": failures,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = "direct-core" if args.selection == "direct-core" else "all-human-verified"
    report_path = output_dir / f"report-{suffix}.json"
    markdown_path = output_dir / f"report-{suffix}.md"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "selection": args.selection,
                "unitCount": len(units),
                "expectedUnitCount": expected,
                "evaluationComplete": evaluation_complete,
                "directCoreEvaluationComplete": direct_complete,
                "cacheHitUnitCount": cache_hits,
                "newlyPredictedUnitCount": newly_predicted,
                "pendingUnitCount": len(pending),
                "directHumanCore": direct,
                "transferredExpressiveStress": expressive,
                "directCoreV2Gate": direct_v2,
                "directCoreV3Gate": direct_v3,
                "hardangerDirectCoreV2Passed": report["hardangerDirectCoreV2Passed"],
                "hardangerDirectCoreV3Passed": report["hardangerDirectCoreV3Passed"],
                "failures": failures,
                "report": str(report_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if failures:
        return 2
    if direct_complete and report["hardangerDirectCoreV2Passed"] is not True:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
