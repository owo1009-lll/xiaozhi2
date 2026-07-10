from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
DEFAULT_ALIGNMENT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-chord-timing.json"
DEFAULT_RECOGNITION = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-transcription.json"
DEFAULT_PERTURBATION = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-error-perturbations.json"
DEFAULT_RAW_AUDIO = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-raw-audio-perturbations" / "report.json"
DEFAULT_WEAK_NOTE = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-weak-note-gate.json"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-v2-audit.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-v2-audit.md"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_audit(
    dataset: dict[str, Any],
    alignment: dict[str, Any],
    recognition: dict[str, Any],
    perturbation: dict[str, Any] | None = None,
    raw_audio: dict[str, Any] | None = None,
    weak_note: dict[str, Any] | None = None,
) -> dict[str, Any]:
    perturbation = perturbation or {}
    raw_audio = raw_audio or {}
    weak_note = weak_note or {}
    counts = dataset.get("counts") or {}
    alignment_holdout = alignment.get("holdout") or {}
    recognition_holdout = ((recognition.get("eventFilterCalibration") or {}).get("holdout") or {})
    data_ready = bool(
        dataset.get("readyForEvalBenchmark") is True
        and int(counts.get("readyForEvalBenchmarkRows") or 0) >= 65
        and int(counts.get("developmentReferencePerformerRows") or 0) > 0
        and int(counts.get("holdoutUnseenPerformerRows") or 0) > 0
    )
    alignment_v2 = bool(
        alignment.get("externalControlledPilotReady") is True
        and (alignment_holdout.get("precisionWithin300msAmongPredictions") or 0.0) >= 0.90
        and (alignment_holdout.get("coverage") or 0.0) >= 0.80
    )
    recognition_v2 = bool(
        recognition.get("recognitionV2AlphaReady") is True
        and (recognition_holdout.get("precision") or 0.0) >= 0.90
        and (recognition_holdout.get("recall") or 0.0) >= 0.20
    )
    public_v2_alpha = data_ready and alignment_v2 and recognition_v2
    perturbation_holdout = perturbation.get("holdout") or {}
    perturbation_clean = perturbation_holdout.get("clean") or {}
    public_event_v3 = bool(
        public_v2_alpha
        and perturbation.get("publicEventPerturbationGateReady") is True
        and (perturbation_clean.get("precisionWithin300ms") or 0.0) >= 0.95
        and (perturbation_clean.get("coverage") or 0.0) >= 0.30
        and int(perturbation_holdout.get("unsafeTargetAutoPassCount") or 0) == 0
    )
    strict_raw = raw_audio.get("strictPolicy") or {}
    strict_raw_clean = strict_raw.get("clean") or {}
    public_raw_core = bool(
        public_v2_alpha
        and raw_audio.get("rawAudioCoreErrorGateReady") is True
        and (strict_raw_clean.get("precisionWithin300ms") or 0.0) >= 0.95
        and (strict_raw_clean.get("coverage") or 0.0) >= 0.30
        and int(strict_raw.get("eligibleTargetCount") or 0) >= 30
        and int(strict_raw.get("coreUnsafeTargetAutoPassCount") or 0) == 0
    )
    public_weak_note = bool(
        public_raw_core
        and weak_note.get("weakNotePublicRawAudioGateReady") is True
    )
    raw_audio_v3 = bool(
        public_raw_core
        and raw_audio.get("rawAudioStudentErrorGateReady") is True
        and weak_note.get("weakNoteStudentErrorGateReady") is True
    )
    v3_ready = raw_audio_v3
    near_perfect = bool(
        v3_ready
        and dataset.get("humanNoteOnsetGold") is True
        and (alignment_holdout.get("precisionWithin300msAmongPredictions") or 0.0) >= 0.99
        and (alignment_holdout.get("coverage") or 0.0) >= 0.99
        and (recognition_holdout.get("precision") or 0.0) >= 0.99
        and (recognition_holdout.get("recall") or 0.0) >= 0.99
    )
    blockers = []
    if not data_ready:
        blockers.append("external-corpus-audit-not-ready")
    if not alignment_v2:
        blockers.append("unseen-performer-alignment-v2-gate-not-ready")
    if not recognition_v2:
        blockers.append("unseen-performer-recognition-v2-gate-not-ready")
    if not public_event_v3:
        blockers.extend(
            [
                "v3-requires-public-audio-error-perturbation-gate",
                "v3-event-subset-requires-95pct-precision-and-30pct-coverage",
            ]
        )
    if not raw_audio_v3:
        blockers.append("raw-audio-error-perturbation-gate-not-ready")
    if not public_raw_core:
        blockers.append("public-waveform-core-error-gate-not-ready")
    if not public_weak_note:
        blockers.append("weak-note-auto-pass-gate-not-ready-review-only")
    if dataset.get("humanNoteOnsetGold") is not True:
        blockers.append("reference-note-times-are-estimated-not-human-gold")
    blockers.append("professional-clean-recordings-do-not-establish-student-domain-error-robustness")
    return {
        "ok": True,
        "scope": "public-professional-violin-recordings",
        "dataset": {
            "evalReadyMovements": counts.get("readyForEvalBenchmarkRows"),
            "developmentMovements": counts.get("developmentReferencePerformerRows"),
            "holdoutMovements": counts.get("holdoutUnseenPerformerRows"),
            "referenceNotes": counts.get("referenceNotes"),
            "humanNoteOnsetGold": False,
        },
        "alignmentHoldout": alignment_holdout,
        "recognitionHoldout": recognition_holdout,
        "gates": {
            "dataReady": data_ready,
            "alignmentV2Ready": alignment_v2,
            "recognitionV2AlphaReady": recognition_v2,
            "publicProfessionalV2AlphaReady": public_v2_alpha,
            "publicEventV3PrototypeReady": public_event_v3,
            "publicRawAudioCorePrototypeReady": public_raw_core,
            "publicWeakNotePrototypeReady": public_weak_note,
            "rawAudioV3Ready": raw_audio_v3,
            "v3Ready": v3_ready,
            "nearPerfectReady": near_perfect,
            "defaultStudentReleaseEligible": False,
        },
        "blockingReasons": list(dict.fromkeys(blockers)),
        "nextAction": (
            "Freeze the public-professional raw-audio core gate for missing-note, wrong-pitch and late-onset. "
            "Keep weak-note and extra-note diagnosis review-only. Public recordings can continue development and stress testing, "
            "but cannot establish student-domain release eligibility."
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Western Strings Public Bach V2 Audit",
            "",
            f"- scope: {report['scope']}",
            f"- gates: {report['gates']}",
            f"- alignment holdout: {report['alignmentHoldout']}",
            f"- recognition holdout: {report['recognitionHoldout']}",
            "",
            "## Blocking Reasons",
            "",
            *[f"- {reason}" for reason in report["blockingReasons"]],
            "",
            "## Next Action",
            "",
            report["nextAction"],
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Combine Bach violin dataset, alignment and transcription evidence into explicit V-level gates.")
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET))
    parser.add_argument("--alignment", default=str(DEFAULT_ALIGNMENT))
    parser.add_argument("--recognition", default=str(DEFAULT_RECOGNITION))
    parser.add_argument("--perturbation", default=str(DEFAULT_PERTURBATION))
    parser.add_argument("--raw-audio", default=str(DEFAULT_RAW_AUDIO))
    parser.add_argument("--weak-note", default=str(DEFAULT_WEAK_NOTE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_audit(
        load_json(Path(args.dataset).resolve()),
        load_json(Path(args.alignment).resolve()),
        load_json(Path(args.recognition).resolve()),
        load_json(Path(args.perturbation).resolve()),
        load_json(Path(args.raw_audio).resolve()),
        load_json(Path(args.weak_note).resolve()),
    )
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["gates"]["publicProfessionalV2AlphaReady"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
