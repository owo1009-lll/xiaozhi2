#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Route-B step 2: photo-domain augmentation for the synthetic Clarity dataset.

Reads the synth train token manifest, renders scan-like and photo-like degraded
copies of every training staff image (reusing the measured degradation module
from the render-gold benchmark), and writes an augmented train manifest:

  original clean rows + scan rows + photo rows   (train ONLY)

Validation / synthetic-test manifests are untouched, so eval stays clean-domain
comparable across rounds. Deterministic per-row seeds."""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_m4_omr_render_gold import degrade_image  # noqa: E402

DATASET = REPO / "data" / "experiments" / "western-strings-m4" / "clarity-adaptation-dataset-synth"
TRAIN = DATASET / "clarity-adaptation-train-tokens.jsonl"
OUT_DIR = DATASET / "generated" / "degraded"
OUT_MANIFEST = DATASET / "clarity-adaptation-train-tokens-augmented.jsonl"

rows = [json.loads(l) for l in TRAIN.read_text(encoding="utf-8").splitlines() if l.strip()]
OUT_DIR.mkdir(parents=True, exist_ok=True)

out_rows = list(rows)
stats = {"clean": len(rows), "scan": 0, "photo": 0, "failed": 0}
for i, row in enumerate(rows):
    src = Path(row["image_path"])
    if not src.is_absolute():
        src = DATASET / src
    if not src.is_file():
        stats["failed"] += 1
        continue
    for level in ("scan", "photo"):
        dst = OUT_DIR / f"{src.stem}.{level}{src.suffix}"
        try:
            degrade_image(src, dst, level, seed=10007 * (i + 1) + (1 if level == "scan" else 2))
        except Exception as exc:
            stats["failed"] += 1
            print(json.dumps({"row": i, "level": level, "error": str(exc)[:100]}))
            continue
        new_row = dict(row)
        new_row["image_path"] = str(dst)
        new_row["sample_id"] = f"{row['sample_id']}::{level}"
        new_row["style_id"] = f"{row.get('style_id', 'default')}-{level}"
        out_rows.append(new_row)
        stats[level] += 1

OUT_MANIFEST.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out_rows),
                        encoding="utf-8")
print(json.dumps({"evalOnly": True, "rows": len(out_rows), **stats,
                  "manifest": str(OUT_MANIFEST)}, ensure_ascii=False))
