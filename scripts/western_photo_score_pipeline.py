#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Production offline pipeline: photo score + recording -> machine-only decision.

Single entry point for the M4 photo-score flow (layered gate, machine-only):
  1. Run Audiveris on preprocessing variants (up2 / up2-otsu / up3) of the photo
     (cached per variant; skips variants already recognized), plus HOMR on the
     original photo as a fourth pool candidate. Direct research runs may
     explicitly tolerate a missing HOMR executable; controlled deployment uses
     --require-complete-engine-pool and fails before audio/OMR work instead.
  2. Arbitrate candidates with the student's recording (basic-pitch events):
     winner needs >= MIN_CONFIRMED audio-confirmed notes and >= MIN_AGREEMENT
     alignment agreement, and must pass its score-structure gate (Audiveris:
     P0 raw+export evidence; HOMR: MusicXML-only export evidence).
  3. Emit decision:
       full-feedback:<variant>      annotated photo, greens/reds active
       degraded-feedback:<variant>  greens-only annotation, zero accusations
       retake-photo                 nothing recognizable / zero audio support
     HOMR emits no pixel coordinates, so a HOMR winner ships list-style
     per-measure feedback (verdicts JSON), not an annotated photo.
  4. Write an audit JSON (all candidates, metrics, decision, artifact paths).

Fail-closed guarantees (manual M4 layered gate):
  - never accuses without local alignment confidence (both-neighbor rule);
  - piece-level agreement < 0.6 demotes all accusations;
  - missing/extra style verdicts are NOT emitted at all (OMR not human-verified);
  - this pipeline never touches the student runtime gates.

Usage:
  python scripts/western_photo_score_pipeline.py --photo P.jpg --audio A.m4a --out DIR
  python scripts/western_photo_score_pipeline.py --piece violin-ex02   (M2f shortcut)
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_m4_real_jpg_omr import preprocess  # noqa: E402
from eval_western_strings_m4_omr_render_gold import run_audiveris, DEFAULT_AUDIVERIS  # noqa: E402
import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402
from western_m4_omr_structure import (  # noqa: E402
    evaluate_musicxml_only_structure,
    evaluate_p0_structure,
)

VARIANTS = ["up2", "up2-otsu", "up3"]
HOMR_VARIANT = "homr"
DEFAULT_HOMR = (REPO / "data" / "tools" / "homr-0.7.0-ort1.27.0"
                / "Scripts" / "homr.exe")
MIN_CONFIRMED = 20
MIN_AGREEMENT = 0.6


def recognize_variant(photo: Path, variant: str, work: Path, audiveris: Path, timeout: int) -> Path:
    """OMR one preprocessing variant (cached); returns variant omr dir."""
    vdir = work / variant
    omr_dir = vdir / "omr"
    if list(omr_dir.glob("*.mxl")) and list(omr_dir.glob("*.omr")):
        return vdir
    prep = preprocess(photo, vdir / f"{photo.stem}-{variant}.png", variant)
    run_audiveris(audiveris, prep, omr_dir, timeout)
    return vdir


def recognize_homr(photo: Path, work: Path, homr_exe: Path,
                   timeout: int) -> tuple[Path | None, int | None]:
    """HOMR the original photo; return (MusicXML, process exit code)."""
    vdir = work / HOMR_VARIANT
    vdir.mkdir(parents=True, exist_ok=True)
    got = sorted(vdir.glob("*.musicxml")) + sorted(vdir.glob("*.mxl"))
    if got:
        return got[0], None
    local = vdir / photo.name
    if not local.is_file():
        shutil.copyfile(photo, local)
    with (vdir / "homr.log").open("wb") as log:
        completed = subprocess.run([str(homr_exe), local.name], cwd=vdir, stdout=log,
                                   stderr=subprocess.STDOUT, timeout=timeout, check=False)
    got = sorted(vdir.glob("*.musicxml")) + sorted(vdir.glob("*.mxl"))
    return (got[0] if got else None), completed.returncode


def engine_pool_status(audiveris: Path, homr_exe: Path) -> dict:
    """Return executable-level readiness for the final in-process safety check."""
    missing = []
    if not audiveris.is_file():
        missing.append("audiveris")
    if not homr_exe.is_file():
        missing.append("homr")
    return {
        "required": ["audiveris", "homr"],
        "complete": not missing,
        "degraded": bool(missing),
        "missing": missing,
    }


def run_homr_candidate(name: str, mxl: Path, out_root: Path, aev: list[dict]) -> dict:
    """Score a HOMR MusicXML with the SAME arbitration currency and verdict
    discipline as the Audiveris variants. No pixel anchors exist, so feedback
    is a per-measure verdict list (JSON), never an annotated photo."""
    events = anchor.mxl_events(mxl)
    verdicts, match, time_pred, agree, piece_gate = anchor.compute_verdicts(
        events, aev, [False] * len(events))
    counts = {v: verdicts.count(v) for v in anchor.COLORS}
    out_dir = out_root / "annotated" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    listing = out_dir / f"{name}-homr-verdicts.json"
    listing.write_text(json.dumps(
        {"piece": name, "variant": HOMR_VARIANT, "annotationStyle": "score-list",
         "events": len(events), "audioNotes": len(aev),
         "verdictCounts": counts, "audioAgreementHeard": round(agree, 4),
         "pieceGate": piece_gate,
         "perNote": [{"i": i, "measure": events[i]["measure"], "verdict": verdicts[i],
                      "scoreMidis": events[i]["midis"],
                      "audioMidis": aev[match[i]]["midis"] if match[i] is not None else None,
                      "timingDeviationSec": (round(aev[match[i]]["start"] - time_pred[i], 3)
                                             if match[i] is not None and time_pred is not None
                                             else None)}
                     for i in range(len(events))]},
        ensure_ascii=False, indent=1), encoding="utf-8")
    return {"status": "ok", "confirmed": counts["confirmed"],
            "agreement": round(agree, 4), "pieceGate": piece_gate,
            "annotated": None, "annotationStyle": "score-list",
            "verdictListing": str(listing), "verdictCounts": counts}


def decide(cands: list[dict]) -> str:
    scored = [c for c in cands if c.get("status") == "ok"]
    winner = max(scored, key=lambda c: (c["confirmed"], c["agreement"]), default=None)
    if winner is None or winner["confirmed"] <= 0:
        return "retake-photo"
    structurally_ready = [
        candidate
        for candidate in scored
        if (candidate.get("scoreStructureGate") or {}).get("ready") is True
    ]
    if not structurally_ready:
        return "score-structure-review-required"
    winner = max(
        structurally_ready,
        key=lambda c: (c["confirmed"], c["agreement"]),
    )
    if winner["confirmed"] >= MIN_CONFIRMED and winner["agreement"] >= MIN_AGREEMENT:
        return f"full-feedback:{winner['variant']}"
    return f"degraded-feedback:{winner['variant']}"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--photo", help="score photo (jpg/png)")
    ap.add_argument("--audio", help="student recording (m4a/wav/mp3)")
    ap.add_argument("--piece", help="M2f shortcut: violin-exNN resolves photo/audio from data/private")
    ap.add_argument("--out", default=str(REPO / "data" / "analysis-photo-score"))
    ap.add_argument("--audiveris", default=str(DEFAULT_AUDIVERIS))
    ap.add_argument("--homr", default=str(DEFAULT_HOMR))
    ap.add_argument(
        "--require-complete-engine-pool",
        action="store_true",
        help="fail before analysis unless both Audiveris and HOMR executables exist",
    )
    ap.add_argument("--timeout", type=int, default=420)
    args = ap.parse_args(argv)

    if args.piece:
        photo = anchor.PRIVATE / f"{args.piece}-score.jpg"
        audio = anchor.PRIVATE / f"{args.piece}.m4a"
        name = args.piece
    else:
        if not (args.photo and args.audio):
            ap.error("--photo and --audio are required (or use --piece)")
        photo, audio = Path(args.photo), Path(args.audio)
        name = photo.stem
    audiveris_exe = Path(args.audiveris).resolve()
    homr_exe = Path(args.homr).resolve()
    pool = engine_pool_status(audiveris_exe, homr_exe)
    if args.require_complete_engine_pool and not pool["complete"]:
        print(json.dumps({
            "ok": False,
            "reason": "required-engine-pool-incomplete",
            "enginePool": pool,
            "autoDiagnosisIssued": False,
            "studentFacing": False,
        }, ensure_ascii=False))
        return 2

    out_root = Path(args.out).resolve() / name
    work = out_root / "variants"
    out_root.mkdir(parents=True, exist_ok=True)

    aev = anchor.audio_events(audio)

    cands = []
    for variant in VARIANTS:
        row = {"variant": variant, "engine": "audiveris"}
        try:
            vdir = recognize_variant(photo, variant, work, audiveris_exe, args.timeout)
            r = _run_variant(name, photo, audio, vdir, out_root, aev)
            omr_files = sorted((vdir / "omr").glob("*.omr"))
            mxl_files = sorted((vdir / "omr").glob("*.mxl"))
            structure_gate = (
                evaluate_p0_structure(omr_files[0], mxl_files)
                if omr_files
                else {
                    "ready": False,
                    "clefReady": False,
                    "keyReady": False,
                    "meterReady": False,
                    "reasons": ["omr-archive-missing"],
                }
            )
            row.update({"status": r.get("status", "ok"),
                        "confirmed": (r.get("verdictCounts") or {}).get("confirmed", 0),
                        "agreement": r.get("audioAgreementHeard", 0.0),
                        "pieceGate": r.get("pieceGate"),
                        "annotated": r.get("annotated"),
                        "verdictCounts": r.get("verdictCounts"),
                        "scoreStructureGate": structure_gate})
        except Exception as exc:
            row.update({"status": f"error: {exc}"[:200], "confirmed": 0, "agreement": 0.0})
        cands.append(row)

    homr_row = {"variant": HOMR_VARIANT, "engine": "homr"}
    if not homr_exe.is_file():
        # Research-only direct runs may make this explicit degraded comparison.
        # Controlled runs pass --require-complete-engine-pool and never reach it.
        homr_row.update({"status": "homr-unavailable", "confirmed": 0, "agreement": 0.0})
    else:
        try:
            mxl, homr_exit_code = recognize_homr(photo, work, homr_exe, args.timeout)
            homr_row["processExitCode"] = homr_exit_code
            if mxl is None:
                homr_row.update({"status": "omr-no-output", "confirmed": 0, "agreement": 0.0})
            else:
                homr_row.update(run_homr_candidate(name, mxl, out_root, aev))
                homr_row["scoreStructureGate"] = evaluate_musicxml_only_structure([mxl])
        except Exception as exc:
            homr_row.update({"status": f"error: {exc}"[:200], "confirmed": 0, "agreement": 0.0})
    cands.append(homr_row)

    decision = decide(cands)
    winner_variant = decision.split(":", 1)[1] if ":" in decision else None
    winner_row = next((c for c in cands if c.get("variant") == winner_variant), None)
    audit = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "pipeline": "western-photo-score-v3-homr-pool",
        "p0StructureGateVersion": 2,
        "enginePool": [f"audiveris:{v}" for v in VARIANTS] + [HOMR_VARIANT],
        "enginePoolComplete": pool["complete"],
        "enginePoolDegraded": pool["degraded"],
        "enginePoolMissing": pool["missing"],
        "completeEnginePoolRequired": args.require_complete_engine_pool,
        "photo": str(photo), "audio": str(audio),
        "decision": decision,
        "winnerVariant": winner_variant,
        "winnerEngine": (winner_row or {}).get("engine"),
        "winnerAnnotationStyle": (winner_row or {}).get("annotationStyle",
                                                        "pixel-anchored" if winner_row else None),
        "candidates": cands,
        "thresholds": {"minConfirmed": MIN_CONFIRMED, "minAgreement": MIN_AGREEMENT},
        "failClosed": {"studentRuntimeTouched": False,
                       "missingExtraVerdictsEmitted": False,
                       "accusationsRequireBothNeighborConfidence": True,
                       "scoreStructureRequiresClefKeyMeter": True,
                       "requiredEnginePoolEnforced": args.require_complete_engine_pool},
    }
    (out_root / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"decision": decision, "audit": str(out_root / "audit.json"),
                      "p0StructureGateVersion": 2,
                      "candidates": [{k: c.get(k) for k in ("variant", "engine", "status", "confirmed", "agreement")}
                                     for c in cands]}, ensure_ascii=False))
    return 0


def _run_variant(name: str, photo: Path, audio: Path, vdir: Path, out_root: Path, aev) -> dict:
    """Adapter: reuse anchor.run_piece against our variants layout."""
    variant = vdir.name
    # emulate <root>/<piece>/<variant>/omr expected by run_piece
    shim = out_root / "shim"
    target = shim / name / variant / "omr"
    if not target.exists():
        src = vdir / "omr"
        if not src.exists() or not list(src.glob("*.mxl")):
            return {"status": "omr-no-output"}
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, target)
    return anchor.run_piece(name, variant, out_root / "annotated", omr_root=shim,
                            aev=aev, photo_path=photo, audio_path=audio)


if __name__ == "__main__":
    raise SystemExit(main())
