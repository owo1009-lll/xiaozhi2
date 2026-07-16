#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_western_strings_m4_omr_render_gold import (  # noqa: E402
    DEFAULT_AUDIVERIS,
    compare,
    note_events,
    run_audiveris,
)
from eval_western_strings_m4_real_jpg_omr import adaptive_interline_plan, preprocess  # noqa: E402
import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402
from western_m4_omr_structure import evaluate_p0_structure  # noqa: E402


DEFAULT_AUDITS = [
    REPO / "data/experiments/western-strings-m4/new-test-runs/etude-op45-no34-score/audit.json",
    REPO / "data/experiments/western-strings-m4/new-test-runs/beijing-jinshan-score/audit.json",
]
DEFAULT_OUT = REPO / "data/experiments/western-strings-m4/adaptive-interline-probe"
DEFAULT_GOLD_BY_PIECE = {
    "beijing-jinshan-score": (
        REPO
        / "data/experiments/western-strings-m4/independent-real-photo-gold"
        / "beijing-jinshan.independent-human-gold.musicxml"
    ),
}
DEFAULT_MANUAL_4X_BY_PIECE = {
    "etude-op45-no34-score": (
        REPO / "data/experiments/western-strings-m4/new-test-runs"
        / "etude-op45-no34-score/up4-retry"
    ),
}


def resolve_repo_path(raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else REPO / path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manual_4x_reference(piece: str, prepared: Path) -> dict | None:
    root = DEFAULT_MANUAL_4X_BY_PIECE.get(piece)
    if root is None:
        return None
    reference_image = root / "etude-op45-no34-up4-autocontrast.png"
    reference_report = root / "report.json"
    if not reference_image.exists() or not reference_report.exists():
        return None
    report = json.loads(reference_report.read_text(encoding="utf-8"))
    prepared_hash = sha256(prepared)
    reference_hash = sha256(reference_image)
    return {
        "preparedImage": str(reference_image.relative_to(REPO)),
        "preparedSha256": reference_hash,
        "adaptivePreparedSha256": prepared_hash,
        "pixelIdentical": prepared_hash == reference_hash,
        "scoreEvents": int(report.get("scoreEvents") or 0),
        "preprocess": report.get("source", {}).get("preprocess"),
    }


def baseline_summary(audit: dict) -> dict:
    candidates = [row for row in audit.get("candidates", []) if row.get("status") == "ok"]
    winner = max(candidates, key=lambda row: (row.get("confirmed", 0), row.get("agreement", 0)), default={})
    return {
        "decision": audit.get("decision"),
        "variant": winner.get("variant"),
        "confirmed": winner.get("confirmed", 0),
        "audioAgreementHeard": winner.get("agreement", 0.0),
        "scoreStructureReady": (winner.get("scoreStructureGate") or {}).get("ready", False),
        "musicxmlPaths": list(
            (winner.get("scoreStructureGate") or {}).get("musicxmlPaths") or []
        ),
    }


def combined_note_sequence(paths: list[Path]) -> tuple[list, int]:
    sequence = []
    measure_count = 0
    for path in paths:
        current, _, current_measures = note_events(path)
        sequence.extend(current)
        measure_count += int(current_measures)
    return sequence, measure_count


def independent_gold_comparison(
    gold_path: Path,
    baseline_paths: list[Path],
    adaptive_paths: list[Path],
) -> dict:
    gold_sequence, gold_measures = combined_note_sequence([gold_path])
    adaptive_sequence, adaptive_measures = combined_note_sequence(adaptive_paths)
    baseline = None
    baseline_measures = 0
    if baseline_paths and all(path.exists() for path in baseline_paths):
        baseline_sequence, baseline_measures = combined_note_sequence(baseline_paths)
        baseline = compare(gold_sequence, baseline_sequence)
    adaptive = compare(gold_sequence, adaptive_sequence)
    try:
        display_path = str(gold_path.relative_to(REPO))
    except ValueError:
        display_path = str(gold_path)
    return {
        "path": display_path,
        "provenance": "independent-human-transcription-from-source-photo",
        "goldMeasures": gold_measures,
        "baselineMeasures": baseline_measures,
        "adaptiveMeasures": adaptive_measures,
        "baselineUp2": baseline,
        "adaptiveInterline": adaptive,
        "adaptiveMinusBaseline": {
            key: round(float(adaptive.get(key) or 0.0) - float((baseline or {}).get(key) or 0.0), 6)
            for key in ("pitchPrecision", "pitchRecall", "pitchF1")
        }
        if baseline is not None
        else None,
    }


def evaluate(audit_path: Path, out_root: Path, audiveris: Path, timeout: int) -> dict:
    from PIL import Image

    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    photo = resolve_repo_path(audit["photo"])
    audio = resolve_repo_path(audit["audio"])
    piece = str(audit.get("piece") or audit_path.parent.name)
    gold_path = DEFAULT_GOLD_BY_PIECE.get(piece)
    piece_root = out_root / piece
    omr_root = out_root / "omr-root"
    omr_dir = omr_root / piece / "adaptive-interline" / "omr"
    prepared = piece_root / f"{piece}-adaptive-interline.png"
    plan = adaptive_interline_plan(Image.open(photo))
    preprocess(photo, prepared, "adaptive-interline")
    code, mxls = run_audiveris(audiveris, prepared, omr_dir, timeout)
    row = {
        "piece": piece,
        "photo": str(photo.relative_to(REPO)),
        "audio": str(audio.relative_to(REPO)),
        "baseline": baseline_summary(audit),
        "preprocess": plan,
        "preparedSha256": sha256(prepared),
        "manual4xReference": manual_4x_reference(piece, prepared),
        "audiverisExit": code,
        "independentGoldAvailable": bool(gold_path and gold_path.exists()),
    }
    if not mxls:
        row["status"] = "omr-no-output"
        return row
    omrs = sorted(omr_dir.glob("*.omr"))
    gate = evaluate_p0_structure(omrs[0], sorted(mxls)) if omrs else {
        "ready": False,
        "reasons": ["omr-archive-missing"],
    }
    result = anchor.run_piece(
        piece,
        "adaptive-interline",
        piece_root / "diagnostic-overlay",
        omr_root=omr_root,
        photo_path=photo,
        audio_path=audio,
    )
    row.update({
        "status": result.get("status", "ok"),
        "scoreEvents": result.get("events", 0),
        "audioEvents": result.get("audioNotes", 0),
        "confirmed": (result.get("verdictCounts") or {}).get("confirmed", 0),
        "audioAgreementHeard": result.get("audioAgreementHeard", 0.0),
        "pieceGate": result.get("pieceGate"),
        "scoreStructureGate": gate,
        "coordinateOverlayUsable": False,
        "caveat": (
            "Independent human MusicXML gold is used for OMR precision/recall; audio agreement remains diagnostic only."
            if gold_path and gold_path.exists()
            else "No independent MusicXML gold: output and audio agreement are diagnostic, not OMR accuracy."
        ),
    })
    if gold_path and gold_path.exists():
        baseline_paths = [Path(value) for value in row["baseline"].get("musicxmlPaths") or []]
        row["independentGold"] = independent_gold_comparison(
            gold_path,
            baseline_paths,
            sorted(mxls),
        )
    return row


def write_markdown(report: dict, path: Path) -> None:
    lines = [
        "# M4 adaptive interline probe",
        "",
        "Eval-only. No production preprocessing or student feedback policy changed.",
        "Rows with independent human MusicXML gold report recall/miss rate/precision/F1; other rows remain diagnostic only.",
        "",
        "| piece | source interline | scale | achieved interline | events | manual 4x events | audio agreement | baseline R/Miss/P/F1 | adaptive R/Miss/P/F1 | P0 ready |",
        "|---|---:|---:|---:|---:|---:|---:|---|---|---|",
    ]
    for row in report["rows"]:
        plan = row["preprocess"]
        gold = row.get("independentGold") or {}
        baseline = gold.get("baselineUp2") or {}
        adaptive = gold.get("adaptiveInterline") or {}
        baseline_text = (
            f"{baseline.get('pitchRecall', 0):.1%}/{1.0 - baseline.get('pitchRecall', 0):.1%}/"
            f"{baseline.get('pitchPrecision', 0):.1%}/{baseline.get('pitchF1', 0):.1%}"
            if baseline
            else "n/a"
        )
        adaptive_text = (
            f"{adaptive.get('pitchRecall', 0):.1%}/{1.0 - adaptive.get('pitchRecall', 0):.1%}/"
            f"{adaptive.get('pitchPrecision', 0):.1%}/{adaptive.get('pitchF1', 0):.1%}"
            if adaptive
            else "n/a"
        )
        manual = row.get("manual4xReference") or {}
        lines.append(
            f"| {row['piece']} | {plan['estimatedInterlinePx']:.1f}px | "
            f"{plan['appliedScale']:.2f}x | {plan['achievedInterlinePx']:.1f}px | "
            f"{row.get('scoreEvents', 0)} | {manual.get('scoreEvents', 'n/a')} | "
            f"{row.get('audioAgreementHeard', 0):.2%} | {baseline_text} | "
            f"{adaptive_text} | {bool((row.get('scoreStructureGate') or {}).get('ready'))} |"
        )
    lines.extend([
        "",
        "## Interpretation",
        "",
        "- More output or higher audio agreement is only a usability signal; independent-gold precision/recall decides accuracy.",
        "- Recall and miss rate are reported before precision because missed notes are the dominant real-photo failure mode.",
        "- The variant remains eval-only until it improves an independent-gold set without weakening P0.",
        "- The adaptive overlay is intentionally marked unusable because coordinate scaling is not wired into the renderer.",
    ])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audits", nargs="+", default=[])
    parser.add_argument("--photo", default="", help="Direct photo input for one ad-hoc case.")
    parser.add_argument("--audio", default="", help="Direct audio input for one ad-hoc case.")
    parser.add_argument("--piece", default="adaptive-direct-case")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--audiveris", default=str(DEFAULT_AUDIVERIS))
    parser.add_argument("--timeout", type=int, default=420)
    parser.add_argument("--reset-output", action="store_true")
    args = parser.parse_args(argv)

    out_root = Path(args.out).resolve()
    if args.reset_output and out_root.exists():
        shutil.rmtree(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    if bool(args.photo) != bool(args.audio):
        parser.error("--photo and --audio must be provided together")
    audit_paths = list(args.audits)
    if not audit_paths and not args.photo:
        audit_paths = [str(path) for path in DEFAULT_AUDITS]
    if args.photo:
        direct_audit = out_root / f"{args.piece}-input-audit.json"
        direct_audit.write_text(json.dumps({
            "piece": args.piece,
            "photo": args.photo,
            "audio": args.audio,
            "decision": "not-run",
            "candidates": [],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        audit_paths.append(str(direct_audit))
    rows = []
    for raw in audit_paths:
        row = evaluate(Path(raw).resolve(), out_root, Path(args.audiveris), args.timeout)
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False))
    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "scope": "eval-only adaptive staff-interline preprocessing probe",
        "productionPolicyChanged": False,
        "rows": rows,
    }
    (out_root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report, out_root / "report.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
