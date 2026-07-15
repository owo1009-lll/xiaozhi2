#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M4 real-photo OMR evaluation and preprocessing sweep.

Without ``--intake``, the approved .mxl files are Audiveris drafts approved
UNCHANGED by a human, so the result measures re-recognition consistency only.
With ``--intake``, source-derived independent gold is verified and evaluated by
the same strict benchmark implementation used by the M4 release audit.

Also probes preprocessing variants (up2 baseline / up2+otsu / up3) on a subset.
Eval-only; touches nothing in production.
"""
from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_western_strings_m4_omr_render_gold import (  # noqa: E402
    REPO, DEFAULT_AUDIVERIS, run_audiveris, note_events, compare)
from eval_western_strings_m4_omr_benchmark import evaluate_pair  # noqa: E402

PRIVATE = REPO / "data" / "private" / "western-strings-m2"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "real-jpg-omr"


def load_intake(path: Path | None) -> dict[str, dict[str, str]]:
    if path is None:
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {str(row.get("pieceId") or "").strip(): row for row in rows if str(row.get("pieceId") or "").strip()}


def repo_path(raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else REPO / path


def preprocess(jpg: Path, out_png: Path, variant: str) -> Path:
    from PIL import Image
    import numpy as np
    img = Image.open(jpg).convert("L")
    if variant == "up2":
        img = img.resize((img.width * 2, img.height * 2), Image.Resampling.LANCZOS)
    elif variant == "up3":
        img = img.resize((img.width * 3, img.height * 3), Image.Resampling.LANCZOS)
    elif variant == "up2-otsu":
        img = img.resize((img.width * 2, img.height * 2), Image.Resampling.LANCZOS)
        arr = np.asarray(img)
        hist, _ = np.histogram(arr, bins=256, range=(0, 256))
        total = arr.size
        best_t, best_var = 128, -1.0
        w0 = 0; sum0 = 0.0; sum_all = float((hist * np.arange(256)).sum())
        for t in range(256):
            w0 += hist[t]
            if w0 == 0 or w0 == total:
                continue
            sum0 += t * hist[t]
            m0 = sum0 / w0
            m1 = (sum_all - sum0) / (total - w0)
            var = w0 * (total - w0) * (m0 - m1) ** 2
            if var > best_var:
                best_var, best_t = var, t
        img = Image.fromarray(((arr > best_t) * 255).astype("uint8"))
    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out_png, dpi=(300, 300))
    return out_png


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pieces", nargs="+", default=None)
    ap.add_argument("--variants", nargs="+", default=["up2"])
    ap.add_argument("--intake", default="", help="Optional independent source-gold intake CSV.")
    ap.add_argument("--audiveris", default=str(DEFAULT_AUDIVERIS))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--timeout", type=int, default=420)
    ap.add_argument("--reuse-existing", action="store_true", help="Reuse MXL files already present under each variant output.")
    args = ap.parse_args(argv)

    intake_path = Path(args.intake) if args.intake else None
    intake_by_piece = load_intake(intake_path)
    pieces = args.pieces or list(intake_by_piece) or [f"violin-ex{i:02d}" for i in range(1, 13)]
    out_root = Path(args.out); out_root.mkdir(parents=True, exist_ok=True)
    results = []
    for piece in pieces:
        intake_row = intake_by_piece.get(piece)
        if intake_path is not None and intake_row is None:
            raise SystemExit(f"piece not found in intake: {piece}")
        jpg = repo_path(intake_row["currentScorePath"]) if intake_row else PRIVATE / f"{piece}-score.jpg"
        gold = repo_path(intake_row["requiredCleanScorePath"]) if intake_row else PRIVATE / f"{piece}.mxl"
        for variant in args.variants:
            pdir = out_root / piece / variant
            row = {"piece": piece, "variant": variant}
            try:
                existing_mxls = sorted((pdir / "omr").rglob("*.mxl")) if args.reuse_existing else []
                if args.reuse_existing and (pdir / "omr").exists():
                    code, mxls = (0 if existing_mxls else 1), existing_mxls
                    row["reusedExisting"] = True
                else:
                    prep = preprocess(jpg, pdir / f"{piece}-{variant}.png", variant)
                    code, mxls = run_audiveris(Path(args.audiveris), prep, pdir / "omr", args.timeout)
                row["audiverisExit"] = code
                if not mxls:
                    row["status"] = "omr-no-output"
                elif intake_row:
                    benchmark_row = evaluate_pair(
                        intake_row,
                        {piece: {"mxl": str(sorted(mxls)[0])}},
                        pdir / "omr",
                        0.25,
                    )
                    row.update(benchmark_row)
                    row["status"] = "ok" if benchmark_row.get("parseOk") else benchmark_row.get("blockingReason", "benchmark-failed")
                else:
                    gseq, _, g_meas = note_events(gold)
                    rseq, _, r_meas = note_events(mxls[0])
                    row.update(compare(gseq, rseq))
                    row.update({"goldMeasures": g_meas, "recMeasures": r_meas, "status": "ok"})
            except Exception as exc:
                row["status"] = f"error: {exc}"[:200]
            results.append(row)
            print(json.dumps(row, ensure_ascii=False))

    by_variant = {}
    for v in {r["variant"] for r in results}:
        ok = [r for r in results if r["variant"] == v and r.get("status") == "ok"]
        if ok:
            pitch_f1 = [
                float(r["pitchF1"])
                if "pitchF1" in r
                else (2.0 * float(r["pitchPrecision"]) * float(r["pitchRecall"]))
                / max(float(r["pitchPrecision"]) + float(r["pitchRecall"]), 1e-12)
                for r in ok
            ]
            by_variant[v] = {
                "n": len(ok),
                "meanPitchPrecision": round(sum(r["pitchPrecision"] for r in ok) / len(ok), 4),
                "meanPitchRecall": round(sum(r["pitchRecall"] for r in ok) / len(ok), 4),
                "meanPitchF1": round(sum(pitch_f1) / len(ok), 4),
            }
    summary = {"createdAt": datetime.now(timezone.utc).isoformat(),
               "evaluationMode": "independent-source-gold" if intake_path else "re-recognition-consistency",
               "intake": str(intake_path) if intake_path else "",
               "caveat": "Independent source-derived gold with manifest/hash/license verification."
               if intake_path else
               "Gold = human-approved UNCHANGED Audiveris drafts; this measures re-recognition consistency, not independent accuracy.",
               "rows": results, "byVariant": by_variant}
    (out_root / "real-jpg-omr-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(by_variant, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
