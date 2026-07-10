#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Production offline pipeline: photo score + recording -> machine-only decision.

Single entry point for the M4 photo-score flow (layered gate, machine-only):
  1. Run Audiveris on preprocessing variants (up2 / up2-otsu / up3) of the photo
     (cached per variant; skips variants already recognized).
  2. Arbitrate variants with the student's recording (basic-pitch events):
     winner needs >= MIN_CONFIRMED audio-confirmed notes and >= MIN_AGREEMENT
     alignment agreement.
  3. Emit decision:
       full-feedback:<variant>      annotated photo, greens/reds active
       degraded-feedback:<variant>  greens-only annotation, zero accusations
       retake-photo                 nothing recognizable / zero audio support
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
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_m4_real_jpg_omr import preprocess  # noqa: E402
from eval_western_strings_m4_omr_render_gold import run_audiveris, DEFAULT_AUDIVERIS  # noqa: E402
import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402

VARIANTS = ["up2", "up2-otsu", "up3"]
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


def decide(cands: list[dict]) -> str:
    scored = [c for c in cands if c.get("status") == "ok"]
    winner = max(scored, key=lambda c: (c["confirmed"], c["agreement"]), default=None)
    if winner is None or winner["confirmed"] <= 0:
        return "retake-photo"
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
    out_root = Path(args.out).resolve() / name
    work = out_root / "variants"
    out_root.mkdir(parents=True, exist_ok=True)

    aev = anchor.audio_events(audio)

    cands = []
    for variant in VARIANTS:
        row = {"variant": variant}
        try:
            vdir = recognize_variant(photo, variant, work, Path(args.audiveris), args.timeout)
            r = _run_variant(name, photo, audio, vdir, out_root, aev)
            row.update({"status": r.get("status", "ok"),
                        "confirmed": (r.get("verdictCounts") or {}).get("confirmed", 0),
                        "agreement": r.get("audioAgreementHeard", 0.0),
                        "pieceGate": r.get("pieceGate"),
                        "annotated": r.get("annotated"),
                        "verdictCounts": r.get("verdictCounts")})
        except Exception as exc:
            row.update({"status": f"error: {exc}"[:200], "confirmed": 0, "agreement": 0.0})
        cands.append(row)

    decision = decide(cands)
    winner_variant = decision.split(":", 1)[1] if ":" in decision else None
    audit = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "pipeline": "western-photo-score-v1",
        "photo": str(photo), "audio": str(audio),
        "decision": decision,
        "winnerVariant": winner_variant,
        "candidates": cands,
        "thresholds": {"minConfirmed": MIN_CONFIRMED, "minAgreement": MIN_AGREEMENT},
        "failClosed": {"studentRuntimeTouched": False,
                       "missingExtraVerdictsEmitted": False,
                       "accusationsRequireBothNeighborConfidence": True},
    }
    (out_root / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"decision": decision, "audit": str(out_root / "audit.json"),
                      "candidates": [{k: c.get(k) for k in ("variant", "status", "confirmed", "agreement")}
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
