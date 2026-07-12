#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate 8 simple violin etudes for the round-2 recording session.

Each etude is tailored to its r2-NN checklist scenario, stays in first
position (violin-friendly, erhu-player-friendly), and ships with its exact
MusicXML source — which doubles as TRUE INDEPENDENT GOLD for the photo-domain
OMR benchmark (print -> photograph -> recognize -> compare vs this source).

Output: 音频/round2-谱子/r2-NN-<name>.{musicxml,png}  (PNG ~3300px wide, printable)
Deterministic (no randomness) so the gold is reproducible from this script.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from music21 import stream, note, chord, meter, key, tempo, metadata, expressions, spanner, clef

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "音频" / "round2-谱子"

# ---------------- composition helpers ----------------

def build_part(measures: list[list], ks_sharps: int, ts: str = "4/4", bpm: int = 76):
    s = stream.Score()
    p = stream.Part()
    p.insert(0, clef.TrebleClef())
    p.insert(0, key.KeySignature(ks_sharps))
    p.insert(0, meter.TimeSignature(ts))
    p.insert(0, tempo.MetronomeMark(number=bpm))
    for m_items in measures:
        m = stream.Measure()
        for item in m_items:
            m.append(item)
        p.append(m)
    s.append(p)
    return s

def q(p):  n = note.Note(p); n.quarterLength = 1.0; return n
def h(p):  n = note.Note(p); n.quarterLength = 2.0; return n
def w(p):  n = note.Note(p); n.quarterLength = 4.0; return n
def e(p):  n = note.Note(p); n.quarterLength = 0.5; return n
def dq(p): n = note.Note(p); n.quarterLength = 1.5; return n

def trill(n):
    n.expressions.append(expressions.Trill()); return n

def dstop(p_low, p_high, ql=2.0):
    c = chord.Chord([p_low, p_high]); c.quarterLength = ql; return c

# ---------------- 8 etudes ----------------

def etude_01():  # 正常演奏基线:D 大调级进,四分音符为主
    D = ["D4","E4","F#4","G4","A4","B4","C#5","D5"]
    ms = []
    ms.append([q("D4"),q("E4"),q("F#4"),q("G4")]); ms.append([q("A4"),q("G4"),q("F#4"),q("E4")])
    ms.append([q("D4"),q("F#4"),q("A4"),q("D5")]); ms.append([h("C#5"),h("A4")])
    ms.append([q("B4"),q("A4"),q("G4"),q("F#4")]); ms.append([q("E4"),q("F#4"),q("G4"),q("E4")])
    ms.append([q("F#4"),q("A4"),q("G4"),q("E4")]); ms.append([w("D4")])
    ms.append([q("D5"),q("C#5"),q("B4"),q("A4")]); ms.append([q("B4"),q("C#5"),q("D5"),q("B4")])
    ms.append([q("A4"),q("F#4"),q("G4"),q("E4")]); ms.append([h("F#4"),h("E4")]); ms.append([w("D4")])
    return build_part(ms, 2), "D大调级进练习(正常演奏)"

def etude_02():  # 故意错音场景:G 大调,音型清晰易于"指定错音"
    ms = []
    ms.append([q("G4"),q("A4"),q("B4"),q("G4")]); ms.append([q("C5"),q("B4"),q("A4"),q("B4")])
    ms.append([q("D5"),q("C5"),q("B4"),q("A4")]); ms.append([h("G4"),h("B4")])
    ms.append([q("E5"),q("D5"),q("C5"),q("B4")]); ms.append([q("A4"),q("B4"),q("C5"),q("A4")])
    ms.append([q("B4"),q("G4"),q("A4"),q("F#4")]); ms.append([w("G4")])
    ms.append([q("G4"),q("B4"),q("D5"),q("B4")]); ms.append([q("C5"),q("A4"),q("F#4"),q("A4")])
    ms.append([h("G4"),h("D5")]); ms.append([w("G4")])
    return build_part(ms, 1), "G大调旋律(错音场景用)"

def etude_03():  # 漏音场景:A 小调,均匀八分音符便于"跳过整音"
    ms = []
    ms.append([e("A4"),e("B4"),e("C5"),e("B4"),q("A4"),q("E4")])
    ms.append([e("C5"),e("D5"),e("E5"),e("D5"),q("C5"),q("A4")])
    ms.append([q("E5"),q("D5"),q("C5"),q("B4")]); ms.append([h("A4"),h("E4")])
    ms.append([e("A4"),e("C5"),e("B4"),e("D5"),q("C5"),q("E5")])
    ms.append([q("D5"),q("B4"),q("C5"),q("A4")]); ms.append([h("B4"),h("E4")]); ms.append([w("A4")])
    ms.append([q("A4"),q("E5"),q("C5"),q("A4")]); ms.append([h("B4"),h("G#4")]); ms.append([w("A4")])
    return build_part(ms, 0), "a小调八分音符练习(漏音场景用)"

def etude_04():  # 节奏偏移场景:C 大调附点节奏
    ms = []
    ms.append([dq("C4"),e("D4"),q("E4"),q("F4")]); ms.append([dq("G4"),e("F4"),q("E4"),q("D4")])
    ms.append([dq("E4"),e("F4"),q("G4"),q("A4")]); ms.append([h("G4"),h("E4")])
    ms.append([dq("A4"),e("G4"),q("F4"),q("E4")]); ms.append([dq("D4"),e("E4"),q("F4"),q("D4")])
    ms.append([q("E4"),q("G4"),q("F4"),q("D4")]); ms.append([w("C4")])
    ms.append([dq("C5"),e("B4"),q("A4"),q("G4")]); ms.append([q("A4"),q("F4"),q("G4"),q("E4")])
    ms.append([h("D4"),h("G4")]); ms.append([w("C4")])
    return build_part(ms, 0, bpm=69), "C大调附点节奏练习(节奏偏移场景用)"

def etude_05():  # 滑音场景:G 大调,长连线级进对(便于加滑音)
    ms = []
    def slurred_pair(m, a, b):
        n1, n2 = h(a), h(b)
        m.extend([n1, n2]); return n1, n2
    pairs = [("G4","B4"),("A4","C5"),("B4","D5"),("C5","E5"),
             ("D5","B4"),("C5","A4"),("B4","G4"),("A4","F#4")]
    s = stream.Score(); p = stream.Part()
    p.insert(0, clef.TrebleClef()); p.insert(0, key.KeySignature(1)); p.insert(0, meter.TimeSignature("4/4"))
    p.insert(0, tempo.MetronomeMark(number=60))
    for a, b in pairs:
        m = stream.Measure(); n1, n2 = slurred_pair([], a, b)
        m.append(n1); m.append(n2)
        m.insert(0, spanner.Slur([n1, n2]))
        p.append(m)
    last = stream.Measure(); last.append(w("G4")); p.append(last)
    s.append(p)
    return s, "G大调连线级进(滑音场景用)"

def etude_06():  # 揉弦/颤音场景:D 大调长音 + 颤音记号
    ms = []
    ms.append([w("A4")]); ms.append([w("D5")])
    ms.append([h("F#4"), trill(h("E4"))]); ms.append([w("D4")])
    ms.append([w("B4")]); ms.append([trill(h("A4")), h("F#4")])
    ms.append([w("G4")]); ms.append([h("E4"), trill(h("D4"))]) ; ms.append([w("D4")])
    ms.append([w("D5")]); ms.append([trill(h("C#5")), h("B4")]); ms.append([w("A4")])
    return build_part(ms, 2, bpm=56), "D大调长音与颤音(揉弦/颤音场景用)"

def etude_07():  # 双音场景:A 弦旋律 + 空 D 弦持续音
    ms = []
    ms.append([dstop("D4","A4"), dstop("D4","B4")]); ms.append([dstop("D4","C#5"), dstop("D4","A4")])
    ms.append([dstop("D4","B4"), dstop("D4","G4")]); ms.append([dstop("D4","F#4", 4.0)])
    ms.append([dstop("D4","A4"), dstop("D4","D5")]); ms.append([dstop("D4","C#5"), dstop("D4","B4")])
    ms.append([dstop("D4","A4"), dstop("D4","E4")]); ms.append([dstop("D4","F#4", 4.0)])
    ms.append([dstop("D4","G4"), dstop("D4","B4")]); ms.append([dstop("D4","A4", 4.0)]); ms.append([dstop("D4","D4", 4.0)])
    return build_part(ms, 2, bpm=56), "空弦双音练习(双音场景用)"

def etude_08():  # 盲测:F 大调小谣曲(全新旋律,正常演奏)
    ms = []
    ms.append([q("F4"),q("G4"),q("A4"),q("C5")]); ms.append([q("Bb4"),q("A4"),q("G4"),q("F4")])
    ms.append([q("G4"),q("A4"),q("Bb4"),q("G4")]); ms.append([h("A4"),h("F4")])
    ms.append([q("C5"),q("Bb4"),q("A4"),q("G4")]); ms.append([q("F4"),q("A4"),q("C5"),q("F5")])
    ms.append([q("E5"),q("C5"),q("D5"),q("Bb4")]); ms.append([w("F4")])
    ms.append([q("A4"),q("Bb4"),q("C5"),q("A4")]); ms.append([q("G4"),q("E4"),q("F4"),q("G4")])
    ms.append([h("A4"),h("G4")]); ms.append([w("F4")])
    return build_part(ms, -1, bpm=72), "F大调小谣曲(盲测,正常演奏)"

ETUDES = [etude_01, etude_02, etude_03, etude_04, etude_05, etude_06, etude_07, etude_08]

# ---------------- render ----------------

def render_png(musicxml_path: Path, png_path: Path, zoom: float = 2.0) -> int:
    import verovio
    tk = verovio.toolkit()
    tk.setOptions({"scale": 80, "footer": "none", "breaks": "auto", "adjustPageHeight": False})
    if not tk.loadData(musicxml_path.read_text(encoding="utf-8")):
        raise RuntimeError(f"verovio load failed: {musicxml_path}")
    pages = tk.getPageCount()
    svg = tk.renderToSVG(1)
    svg = svg.replace("{stroke:currentColor}", "{stroke:#000000}")
    svg = svg.replace('class="definition-scale" color="black"',
                      'class="definition-scale" color="black" stroke="#000000"')
    svg_path = png_path.with_suffix(".svg")
    svg_path.write_text(svg, encoding="utf-8")
    node_code = """
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
const zoom = Number(process.env.RG_ZOOM || '2.0');
const image = await loadImage(process.env.RG_SVG);
const w = Math.round(image.width * zoom), h = Math.round(image.height * zoom);
const canvas = createCanvas(w, h);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
ctx.drawImage(image, 0, 0, w, h);
await fs.writeFile(process.env.RG_PNG, canvas.toBuffer('image/png'));
"""
    import os
    env = {**os.environ, "RG_SVG": str(svg_path), "RG_PNG": str(png_path), "RG_ZOOM": str(zoom)}
    res = subprocess.run(["node", "--input-type=module", "-"], input=node_code, text=True,
                         capture_output=True, env=env, cwd=str(REPO))
    if res.returncode != 0:
        raise RuntimeError(f"rasterize failed: {res.stderr[:300]}")
    svg_path.unlink()
    return pages

ascii_titles = [
 "Etude in D (steps) - normal take",
 "Melody in G - wrong-note take",
 "Etude in A minor (8ths) - missing-note take",
 "Dotted rhythms in C - rhythm-shift take",
 "Slurred steps in G - slide take",
 "Long tones & trills in D - vibrato/trill take",
 "Open-string double stops - double-stop take",
 "Little Air in F - fresh blind take",
]

def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, fn in enumerate(ETUDES, start=1):
        score, title = fn()
        score.metadata = metadata.Metadata(title=f"r2-{i:02d}  {ascii_titles[i-1]}", composer="")
        base = OUT / f"r2-{i:02d}"
        xml_path = base.with_suffix(".musicxml")
        score.write("musicxml", fp=str(xml_path))
        pages = render_png(xml_path, base.with_suffix(".png"))
        n_notes = len(list(score.flatten().notes))
        rows.append((f"r2-{i:02d}", title, n_notes, pages))
        print(f"r2-{i:02d}  {title}  notes={n_notes} pages={pages}")
    print("\nAll etudes written to", OUT)
    return 0

if __name__ == "__main__":
    sys.exit(main())
