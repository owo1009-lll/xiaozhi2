#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Layer-B prototype: audio-arbitrated OMR variant racing (no gold needed).

For a photo score, several preprocessing variants (up2 / up2-otsu / up3) may
produce structurally different recognitions. The student's own recording
arbitrates: each variant is scored by confirmed-note count and alignment
agreement; the winner must clear minimum evidence, otherwise the piece falls
through to layer C (human proofread). Eval-only.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from proto_western_strings_score_anchored_feedback import (  # noqa: E402
    REPO, PRIVATE, OMR_ROOT, run_piece, audio_events)

VARIANT_ROOT = REPO / "data" / "experiments" / "western-strings-m4" / "real-jpg-omr-variants"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "variant-arbiter"

MIN_CONFIRMED = 20     # winner must have real audio support
MIN_AGREEMENT = 0.6    # and a reliable alignment


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pieces", nargs="+", required=True)
    ap.add_argument("--variants", nargs="+", default=["up2", "up2-otsu", "up3"])
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    rows = []
    for piece in args.pieces:
        aev = audio_events(PRIVATE / f"{piece}.m4a")   # one basic-pitch pass per piece
        cands = []
        for variant in args.variants:
            root = OMR_ROOT if variant == "up2" else VARIANT_ROOT
            try:
                r = run_piece(piece, variant, out_root / "renders", omr_root=root, aev=aev)
            except Exception as exc:
                r = {"piece": piece, "variant": variant, "status": f"error: {exc}"[:160]}
            ok = r.get("pieceGate") == "ok" or (r.get("verdictCounts") is not None)
            cands.append({"variant": variant, "status": r.get("status", "ok"),
                          "confirmed": (r.get("verdictCounts") or {}).get("confirmed", 0),
                          "agreement": r.get("audioAgreementHeard", 0.0),
                          "uncertainMeasures": len(r.get("uncertainMeasures", [])) if ok else None,
                          "annotated": r.get("annotated")})
        scored = [c for c in cands if c["status"] == "ok"]
        winner = max(scored, key=lambda c: (c["confirmed"], c["agreement"]), default=None)
        # machine-only mode: no expert queue. Failures route to user-side retry
        # (retake-photo) or degraded feedback (confirmed-only display).
        if winner is None:
            decision = "retake-photo"          # OMR produced nothing on any variant
        elif winner["confirmed"] >= MIN_CONFIRMED and winner["agreement"] >= MIN_AGREEMENT:
            decision = winner["variant"]       # full feedback on winner
        elif winner["confirmed"] > 0:
            decision = f"degraded-feedback:{winner['variant']}"  # greens only, no accusations
        else:
            decision = "retake-photo"
        rows.append({"piece": piece, "decision": decision,
                     "winner": winner, "candidates": cands})
        print(json.dumps(rows[-1], ensure_ascii=False))

    (out_root / "arbiter-summary.json").write_text(json.dumps(
        {"createdAt": datetime.now(timezone.utc).isoformat(),
         "minConfirmed": MIN_CONFIRMED, "minAgreement": MIN_AGREEMENT,
         "note": "audio-arbitrated variant racing; no gold used", "rows": rows},
        ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
