# -*- coding: utf-8 -*-
"""Read-only audit: score-store sections vs the original pagewise MusicXML.

Finds stale-cache-polluted scores (like 炫动 was: store 67 measures vs MXL 181).
For each score in data/erhu-score-imports.json:
  - store measure/note counts (what's currently used downstream)
  - the ORIGINAL pagewise MXL counts, located by matching the score's pdfHash (SHA-1)
    to ANY scorejob dir that has a pagewise/ folder (the store's own sourcePdfPath
    scorejob may have lost its pagewise -- 炫动's case -- so match by hash, not path)
  - a verdict: OK / POLLUTED (store << MXL) / no-mxl-on-disk

NOTHING is written. This only reports. Rebuild is a separate, per-score, backed-up step.

MXL measure count = sum of per-page <measure> elements (pagewise pages restart local
measure numbers, so the total piece length is their sum). Notes = <note> minus <rest>.
.mxl is usually a zip container; raw-XML-with-.mxl-extension is handled too.

Run: python-service/.venv/Scripts/python.exe scripts/experiments/audit_store_vs_mxl.py
"""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
STORE = REPO_ROOT / "data" / "erhu-score-imports.json"
IMPORTS = REPO_ROOT / "data" / "score-imports"


def sha1(path: Path) -> str | None:
    try:
        return hashlib.sha1(path.read_bytes()).hexdigest()
    except Exception:
        return None


def read_score_xml(mxl_path: Path) -> bytes:
    try:
        with zipfile.ZipFile(mxl_path) as zf:
            names = [n for n in zf.namelist()
                     if n.lower().endswith((".xml", ".musicxml")) and not n.startswith("META-INF")]
            if names:
                return zf.read(names[0])
            return zf.read(zf.namelist()[0])
    except zipfile.BadZipFile:
        return mxl_path.read_bytes()


def count_mxl_page(mxl_path: Path) -> tuple[int, int]:
    """(measure_count, note_count) for one page MXL, PER-PART (parts share the same
    measure count, so we take the max over parts -> the true per-page measure count,
    not the multi-part-inflated total). Notes = densest part's real (non-rest) notes."""
    try:
        root = ET.fromstring(read_score_xml(mxl_path))
    except Exception:
        return (0, 0)
    parts = [el for el in root.iter() if el.tag.split("}")[-1] == "part"]
    if not parts:  # timewise or unexpected -> fall back to raw count
        measures = [el for el in root.iter() if el.tag.split("}")[-1] == "measure"]
        notes = [el for el in root.iter() if el.tag.split("}")[-1] == "note"]
        real = [n for n in notes if not any(c.tag.split("}")[-1] == "rest" for c in n)]
        return (len(measures), len(real))
    per_measures, per_notes = [], []
    for p in parts:
        ms = [el for el in p.iter() if el.tag.split("}")[-1] == "measure"]
        ns = [el for el in p.iter() if el.tag.split("}")[-1] == "note"]
        real = [n for n in ns if not any(c.tag.split("}")[-1] == "rest" for c in n)]
        per_measures.append(len(ms))
        per_notes.append(len(real))
    return (max(per_measures) if per_measures else 0, max(per_notes) if per_notes else 0)


def count_pagewise(pagewise_dir: Path) -> tuple[int, int, int]:
    """(total_measures, total_notes, page_count) summed across page-*/*.mxl."""
    pages = sorted(pagewise_dir.glob("page-*/*.mxl"))
    tm = tn = 0
    for p in pages:
        m, n = count_mxl_page(p)
        tm += m
        tn += n
    return (tm, tn, len(pages))


def build_hash_to_pagewise() -> dict[str, Path]:
    """SHA-1(source.pdf) -> the MOST COMPLETE scorejob pagewise dir (max page count).
    Same PDF can be re-imported into several scorejobs; some are partial (1-page) stubs,
    so picking the first match can falsely match a stub. Pick the one with most pages."""
    best: dict[str, tuple[int, Path]] = {}
    for job in IMPORTS.glob("scorejob-*"):
        pw = job / "pagewise"
        pdf = job / "source.pdf"
        if pw.is_dir() and pdf.exists():
            h = sha1(pdf)
            if not h:
                continue
            pages = len(list(pw.glob("page-*/*.mxl")))
            if h not in best or pages > best[h][0]:
                best[h] = (pages, pw)
    return {h: p for h, (n, p) in best.items()}


def store_stats(score: dict) -> tuple[int, int, int]:
    secs = score.get("sections") or []
    notes = [n for s in secs for n in (s.get("notes") or [])]
    measures = [int(n.get("measureIndex", 0)) for n in notes if int(n.get("measureIndex", 0)) > 0]
    return (len(secs), len(notes), max(measures) if measures else 0)


def main() -> int:
    store = json.loads(STORE.read_text(encoding="utf-8"))
    hash_to_pw = build_hash_to_pagewise()

    rows = []
    for sc in store.get("scores", []):
        title = (sc.get("title") or "?")[:12]
        ssec, snote, smax = store_stats(sc)
        pdf_hash = (sc.get("pdfHash") or "").lower()
        pw = hash_to_pw.get(pdf_hash)
        if pw is None:
            rows.append((title, sc.get("scoreId"), ssec, snote, smax, None, None, None,
                         sc.get("selectedPartId"), "no-mxl-on-disk"))
            continue
        mm, mn, pc = count_pagewise(pw)
        # POLLUTED if store measures are a small fraction of MXL measures
        verdict = "OK"
        if mm > 0 and smax < 0.8 * mm:
            verdict = "POLLUTED"
        elif mm == 0:
            verdict = "mxl-empty"
        rows.append((title, sc.get("scoreId"), ssec, snote, smax, mm, mn, pc,
                     sc.get("selectedPartId"), verdict))

    print(f"{'title':12} {'storeSec':>8} {'storeNote':>9} {'storeMax':>8} {'mxlMeas':>7} {'mxlNote':>7} {'pg':>3} {'part':>8}  verdict")
    polluted = []
    for (title, sid, ssec, snote, smax, mm, mn, pc, part, verdict) in rows:
        mm_s = "-" if mm is None else mm
        mn_s = "-" if mn is None else mn
        pc_s = "-" if pc is None else pc
        print(f"{title:12} {ssec:>8} {snote:>9} {smax:>8} {str(mm_s):>7} {str(mn_s):>7} {str(pc_s):>3} {str(part)[:8]:>8}  {verdict}")
        if verdict == "POLLUTED":
            polluted.append((title, sid, smax, mm))

    print(f"\nPOLLUTED ({len(polluted)}): rebuild candidates (store maxMeasure vs mxl measures)")
    for (title, sid, smax, mm) in polluted:
        print(f"  {title}  {sid}  store={smax}  mxl={mm}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
