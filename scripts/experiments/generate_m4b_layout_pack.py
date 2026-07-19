#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate 6 fresh page layouts for the M4b fresh-blind capture pack.

M4b's blind rule needs 6 page layouts never used by the M4b POC/training/tuning
(so not r2-01, r2-06, r3-01, and not the round4 audio pack). These are brand-new,
deliberately varied in meter, length, system count and density so the structure
model sees genuinely unseen layouts. Content is throwaway first-position single
voice — for M4b only the page *structure* matters, not the notes.

The OWNER still photographs these with 3 physical devices and labels each photo's
structure by hand; those real inputs cannot be generated. This only removes the
"find 6 unused scores" chore.

Output: 音频/m4b-layouts/layout-0N.musicxml  (PDF/PNG rendered separately via MuseScore 4)
"""
from __future__ import annotations

import sys
from pathlib import Path

from music21 import clef, duration, key, metadata, meter, note, stream, tempo

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "音频" / "m4b-layouts"


def build(measures, ks_sharps, ts="4/4", bpm=80, title="", beat_ql=None):
    s = stream.Score()
    s.insert(0, metadata.Metadata())
    s.metadata.title = title
    s.metadata.composer = "layout sample (M4b fresh-blind)"
    p = stream.Part()
    p.insert(0, clef.TrebleClef())
    p.insert(0, key.KeySignature(ks_sharps))
    p.insert(0, meter.TimeSignature(ts))
    if beat_ql is None:
        p.insert(0, tempo.MetronomeMark(number=bpm))
    else:
        p.insert(0, tempo.MetronomeMark(number=bpm, referent=duration.Duration(quarterLength=beat_ql)))
    for index, items in enumerate(measures, start=1):
        m = stream.Measure(number=index)
        for item in items:
            m.append(item)
        p.append(m)
    s.append(p)
    return s


def nt(pitch, ql):
    x = note.Note(pitch)
    x.quarterLength = ql
    return x


def q(p): return nt(p, 1.0)
def h(p): return nt(p, 2.0)
def w(p): return nt(p, 4.0)
def e(p): return nt(p, 0.5)
def dh(p): return nt(p, 3.0)
def dq(p): return nt(p, 1.5)


SCALE = ["A3", "B3", "C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5", "F5", "G5"]


def walk(start, pattern, dur):
    """Build a measure by stepping through SCALE from `start` by pattern offsets."""
    out = []
    idx = SCALE.index(start)
    for step, d in zip(pattern, dur):
        idx = max(0, min(len(SCALE) - 1, idx + step))
        out.append(nt(SCALE[idx], d))
    return out


def layout_01():
    """A major, 4/4, dense eighth-note lines, 20 measures -> many systems."""
    ms = []
    for i in range(20):
        base = SCALE[(i % 6) + 2]
        ms.append(walk(base, [1, 1, -1, 1, -1, 1, -1, -1], [0.5] * 8))
    ms[-1] = [w("A4")]
    return build(ms, 3, "4/4", 88, "M4b layout-01 (A, 4/4 dense)")


def layout_02():
    """E minor, 3/4, waltz feel, 24 measures (long)."""
    ms = []
    for i in range(24):
        base = SCALE[(i % 7) + 1]
        ms.append(walk(base, [2, -1, -1], [1.0, 1.0, 1.0]))
    ms[-1] = [dh("E4")]
    return build(ms, 1, "3/4", 84, "M4b layout-02 (e minor, 3/4 long)")


def layout_03():
    """D major, 6/8, compound meter, 14 measures."""
    ms = []
    for i in range(14):
        base = SCALE[(i % 5) + 3]
        ms.append(walk(base, [1, 1, 1, -1, -1, -1], [0.5] * 6))
    ms[-1] = [dh("D4")]
    return build(ms, 2, "6/8", 52, "M4b layout-03 (D, 6/8 compound)", beat_ql=1.5)


def layout_04():
    """G major, 2/4, short measures -> tight bar spacing, 16 measures."""
    ms = []
    for i in range(16):
        base = SCALE[(i % 6) + 2]
        ms.append(walk(base, [1, -1, 1, -1], [0.5, 0.5, 0.5, 0.5]))
    ms[-1] = [h("G4")]
    return build(ms, 1, "2/4", 96, "M4b layout-04 (G, 2/4 tight)")


def layout_05():
    """C major, 4/4, sparse half/whole notes -> low density, 12 measures."""
    ms = [
        [h("C4"), h("E4")], [h("G4"), h("E4")], [w("F4")], [h("A4"), h("F4")],
        [h("G4"), h("B4")], [w("C5")], [h("B4"), h("G4")], [h("A4"), h("F4")],
        [w("G4")], [h("E4"), h("G4")], [h("D4"), h("F4")], [w("C4")],
    ]
    return build(ms, 0, "4/4", 72, "M4b layout-05 (C, 4/4 sparse)")


def layout_06():
    """F major, 3/8, uncommon meter, 18 measures."""
    ms = []
    for i in range(18):
        base = SCALE[(i % 6) + 2]
        ms.append(walk(base, [1, 1, -1], [0.5, 0.5, 0.5]))
    ms[-1] = [dq("F4")]
    return build(ms, -1, "3/8", 60, "M4b layout-06 (F, 3/8 uncommon)", beat_ql=0.5)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    pieces = [
        ("layout-01", layout_01()),
        ("layout-02", layout_02()),
        ("layout-03", layout_03()),
        ("layout-04", layout_04()),
        ("layout-05", layout_05()),
        ("layout-06", layout_06()),
    ]
    for name, score in pieces:
        path = OUT / f"{name}.musicxml"
        score.write("musicxml", fp=str(path))
        systems = len(list(score.parts[0].getElementsByClass(stream.Measure)))
        print(f"{name}: {systems} measures -> {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
