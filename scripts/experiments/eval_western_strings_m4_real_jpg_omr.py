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
ADAPTIVE_TARGET_INTERLINE_PX = 20.0
ADAPTIVE_MAX_PIXELS = 18_000_000
ADAPTIVE_CONTRAST_CUTOFF_PERCENT = 1.0


def load_intake(path: Path | None) -> dict[str, dict[str, str]]:
    if path is None:
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {str(row.get("pieceId") or "").strip(): row for row in rows if str(row.get("pieceId") or "").strip()}


def repo_path(raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else REPO / path


def estimate_staff_interline(img) -> tuple[float | None, float]:
    """Estimate the dominant staff-line spacing from horizontal ink periodicity."""
    import numpy as np
    from PIL import ImageOps

    gray = ImageOps.autocontrast(img.convert("L"))
    ink_projection = (255.0 - np.asarray(gray, dtype=np.float32)).mean(axis=1)
    if ink_projection.size < 16 or float(ink_projection.std()) < 1e-6:
        return None, 0.0
    projection = (ink_projection - ink_projection.mean()) / ink_projection.std()
    max_lag = min(40, projection.size // 4)
    scores = []
    for lag in range(3, max_lag + 1):
        score = float(np.mean(projection[:-lag] * projection[lag:]))
        scores.append((lag, score))
    if not scores:
        return None, 0.0
    local_peaks = [
        item
        for index, item in enumerate(scores)
        if item[1] >= (scores[index - 1][1] if index else float("-inf"))
        and item[1] >= (scores[index + 1][1] if index + 1 < len(scores) else float("-inf"))
    ]
    lag, score = max(local_peaks or scores, key=lambda item: item[1])
    return (float(lag), score) if score >= 0.2 else (None, score)


def adaptive_interline_plan(img, target: float = ADAPTIVE_TARGET_INTERLINE_PX,
                            max_pixels: int = ADAPTIVE_MAX_PIXELS) -> dict:
    interline, confidence = estimate_staff_interline(img)
    if interline is None:
        raise ValueError(f"staff interline not measurable (autocorrelation={confidence:.3f})")
    requested_scale = target / interline
    pixel_cap_scale = (max_pixels / float(img.width * img.height)) ** 0.5
    scale = max(0.5, min(requested_scale, pixel_cap_scale, 6.0))
    width = max(1, round(img.width * scale))
    height = max(1, round(img.height * scale))
    return {
        "sourceSize": [img.width, img.height],
        "sourcePixels": img.width * img.height,
        "estimatedInterlinePx": round(interline, 3),
        "autocorrelation": round(confidence, 6),
        "targetInterlinePx": target,
        "requestedScale": round(requested_scale, 6),
        "pixelCapScale": round(pixel_cap_scale, 6),
        "maxPixels": max_pixels,
        "appliedScale": round(scale, 6),
        "achievedInterlinePx": round(interline * scale, 3),
        "pixelCapApplied": scale + 1e-9 < requested_scale,
        "preparedSize": [width, height],
        "preparedPixels": width * height,
        "contrastNormalization": "autocontrast-cutoff",
        "contrastCutoffPercent": ADAPTIVE_CONTRAST_CUTOFF_PERCENT,
    }


def preprocess(jpg: Path, out_png: Path, variant: str) -> Path:
    from PIL import Image
    import numpy as np
    out_png.parent.mkdir(parents=True, exist_ok=True)
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
    elif variant == "adaptive-interline":
        from PIL import ImageOps
        plan = adaptive_interline_plan(img)
        img = ImageOps.autocontrast(
            img,
            cutoff=ADAPTIVE_CONTRAST_CUTOFF_PERCENT,
        ).resize(
            tuple(plan["preparedSize"]), Image.Resampling.LANCZOS
        )
        out_png.with_suffix(".preprocess.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    else:
        raise ValueError(f"unknown preprocessing variant: {variant}")
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
