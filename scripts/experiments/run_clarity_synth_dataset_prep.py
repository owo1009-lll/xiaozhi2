#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Zero-touch wrapper: run the existing Clarity dataset prep against the
synthetic merged manifest by overriding only EXPECTED_SOURCE_COUNTS.

The upstream script hardcodes the frozen pilot's counts {21,4,7} as a
fail-closed check; for the Route-B synthetic corpus the expected counts are
computed FROM the manifest itself (still fail-closed against manifest drift:
we re-assert synthetic-test stays exactly at the frozen 7 Bach rows and that
no synthetic row landed in synthetic-test)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import prepare_western_strings_m4_clarity_adaptation_dataset as prep  # noqa: E402

import argparse
_ap = argparse.ArgumentParser()
_ap.add_argument("--manifest", default=str(REPO / "data" / "experiments" / "western-strings-m4"
                                           / "clarity-synthetic-corpus" / "clarity-synthetic-merged-split.jsonl"))
_ap.add_argument("--out", default=str(REPO / "data" / "experiments" / "western-strings-m4"
                                      / "clarity-adaptation-dataset-synth"))
_args = _ap.parse_args()
MANIFEST = Path(_args.manifest)
OUT_ROOT = Path(_args.out)

rows = [json.loads(line) for line in MANIFEST.read_text(encoding="utf-8").splitlines() if line.strip()]
counts: dict[str, int] = {}
for r in rows:
    counts[r["split"]] = counts.get(r["split"], 0) + 1

# fail-closed invariants before we relax anything
assert counts.get("synthetic-test", 0) == 7, f"synthetic-test drifted: {counts}"
bad = [r["sample_id"] for r in rows
       if r["split"] == "synthetic-test" and r["dataset"] != "m4_bach_violin_adaptation"]
assert not bad, f"synthetic rows leaked into synthetic-test: {bad}"

prep.EXPECTED_SOURCE_COUNTS = counts
print(json.dumps({"overriddenExpectedCounts": counts, "holdoutFrozen": True}, ensure_ascii=False))

sys.argv = [sys.argv[0],
            "--split-manifest", str(MANIFEST),
            "--out", str(OUT_ROOT),
            "--reset-output"]
sys.exit(prep.main())
