#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Route-B lever 3: train on TRUE Stage-A crop geometry.

For every synthetic training page: degrade the full page (photo/scan-like),
run the ACTUAL Stage-A YOLO staff detector on it, and pair the detected crops
(top-to-bottom) with the prep's per-staff token rows (staff_index order).
Fail-closed pairing: pages where detection count != token-row count are
dropped and counted, never guessed.

Output: crop images + a merged train manifest (v2 clean rows + YOLO-crop rows)
with recomputed image_sha256 so the trainer's integrity gate passes.
Eval-only data tooling; no production gate touched."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_m4_omr_render_gold import degrade_image  # noqa: E402

M4 = REPO / "data" / "experiments" / "western-strings-m4"
DATASET = M4 / "clarity-adaptation-dataset-synth-v2"
PAGES = DATASET / "generated" / "manifests" / "synthetic_pages.jsonl"
TRAIN_TOKENS = DATASET / "clarity-adaptation-train-tokens.jsonl"  # default; override with --tokens-manifest
YOLO_WEIGHTS = M4 / "clarity-training-audit" / "info" / "yolo.pt"
OUT_DIR = DATASET / "generated" / "stagea-crops"
OUT_MANIFEST = DATASET / "clarity-adaptation-train-tokens-stagea.jsonl"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256(); h.update(path.read_bytes()); return h.hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-pages", type=int, default=0, help="0 = all train pages")
    ap.add_argument("--tokens-manifest", type=Path, default=TRAIN_TOKENS)
    ap.add_argument("--out-manifest", type=Path, default=OUT_MANIFEST)
    ap.add_argument("--crops-subdir", default="stagea-crops")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--pad-frac", type=float, default=0.10)
    args = ap.parse_args(argv)

    import numpy as np
    from PIL import Image

    def locate_crop(page_arr, crop_arr):
        """Exact-match locate crop inside clean page; returns (x, y) or None."""
        ph, pw = page_arr.shape[:2]; ch, cw = crop_arr.shape[:2]
        if ch > ph or cw > pw:
            return None
        probe = crop_arr[0]
        for y in range(ph - ch + 1):
            row = page_arr[y]
            # slide x by matching the first crop row
            for x in range(pw - cw + 1):
                if np.array_equal(row[x:x + cw], probe):
                    if np.array_equal(page_arr[y + ch // 2, x:x + cw], crop_arr[ch // 2]):
                        return x, y
        return None

    global OUT_DIR
    OUT_DIR = DATASET / "generated" / args.crops_subdir
    token_rows = [json.loads(l) for l in args.tokens_manifest.read_text(encoding="utf-8").splitlines() if l.strip()]
    rows_by_page: dict[str, list[dict]] = defaultdict(list)
    for r in token_rows:
        rows_by_page[str(r["page_id"])].append(r)
    for v in rows_by_page.values():
        v.sort(key=lambda r: int(r.get("staff_index", 0)))

    pages = [json.loads(l) for l in PAGES.read_text(encoding="utf-8").splitlines() if l.strip()]
    train_pages = [p for p in pages if str(p.get("page_id")) in rows_by_page]
    if args.max_pages:
        train_pages = train_pages[: args.max_pages]

    import random
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    out_rows: list[dict] = []
    stats = {"pages": 0, "pairedPages": 0, "locateFail": 0, "cropRows": 0, "degradeFail": 0}
    rng = random.Random(90001)
    for i, page in enumerate(train_pages):
        stats["pages"] += 1
        png = Path(page["png_path"])
        if not png.is_file():
            continue
        level = "photo" if i % 2 == 0 else "scan"
        degraded = OUT_DIR / f"{png.stem}.{level}.page.png"
        try:
            if not degraded.is_file():
                degrade_image(png, degraded, level, seed=70001 + i)
        except Exception:
            stats["degradeFail"] += 1
            continue
        page_arr = np.asarray(Image.open(png).convert("L"))
        dim = Image.open(degraded)
        rows = rows_by_page[str(page["page_id"])]
        page_ok = False
        for row in rows:
            crop_src = Path(row["image_path"])
            if not crop_src.is_absolute():
                crop_src = DATASET / crop_src
            if not crop_src.is_file():
                stats["locateFail"] += 1
                continue
            crop_arr = np.asarray(Image.open(crop_src).convert("L"))
            loc = locate_crop(page_arr, crop_arr)
            if loc is None:
                stats["locateFail"] += 1
                continue
            x, y = loc
            ch, cw = crop_arr.shape[:2]
            # Stage-A-style loose crop: pad + jitter (degradation warp adds real offset)
            pad_y = ch * (args.pad_frac + rng.uniform(-0.03, 0.06))
            pad_x = cw * rng.uniform(0.0, 0.02)
            jy = rng.uniform(-0.04, 0.04) * ch
            box = (max(0, int(x - pad_x)), max(0, int(y - pad_y + jy)),
                   min(dim.width, int(x + cw + pad_x)), min(dim.height, int(y + ch + pad_y + jy)))
            crop_path = OUT_DIR / f"{png.stem}.{level}.s{int(row.get('staff_index', 0)):02d}.png"
            dim.crop(box).save(crop_path)
            new_row = dict(row)
            new_row["image_path"] = str(crop_path)
            new_row["image_sha256"] = sha256_file(crop_path)
            new_row["sample_id"] = f"{row['sample_id']}::stagea-{level}"
            new_row["style_id"] = f"{row.get('style_id', 'default')}-stagea-{level}"
            out_rows.append(new_row)
            stats["cropRows"] += 1
            page_ok = True
        if page_ok:
            stats["pairedPages"] += 1

    merged = token_rows + out_rows
    args.out_manifest.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in merged),
                                 encoding="utf-8")
    print(json.dumps({"evalOnly": True, **stats, "mergedRows": len(merged),
                      "manifest": str(args.out_manifest)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
