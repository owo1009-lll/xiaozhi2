#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the round-3 recording etudes (fresh-blind + real-error takes).

Five NEW pieces (never used in rounds 1/2, per the fresh-blind default-new-
piece rule), first position, single voice, erhu-player-friendly:

  A (correct takes, fresh-blind intake):
    r3-01  E minor  4/4  stepwise + small leaps
    r3-02  A major  3/4  new meter for this project
    r3-03  G major  4/4  broken thirds (new figure vs r2-02 stepwise)
  B (planted-error takes, real-error ground truth):
    r3-04  C major  4/4  6 planted errors (wrong/missing/extra/drag)
    r3-05  D major  4/4  6 planted errors

Every planted-error entry is verified against the composed stream (measure,
beat, pitch) at generation time — construction-grade gold. Deterministic.

Output: 音频/round3-谱子/r3-0N.musicxml + README-演奏要求.md
PDF/PNG export runs separately through MuseScore 4 CLI.
"""
from __future__ import annotations

import sys
from pathlib import Path

from music21 import clef, key, metadata, meter, note, stream, tempo

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "音频" / "round3-谱子"


def build(measures, ks_sharps, ts="4/4", bpm=76, title=""):
    s = stream.Score()
    s.insert(0, metadata.Metadata())
    s.metadata.title = title
    s.metadata.composer = "practice etude (round 3)"
    p = stream.Part()
    p.insert(0, clef.TrebleClef())
    p.insert(0, key.KeySignature(ks_sharps))
    p.insert(0, meter.TimeSignature(ts))
    p.insert(0, tempo.MetronomeMark(number=bpm))
    for index, items in enumerate(measures, start=1):
        m = stream.Measure(number=index)
        for item in items:
            m.append(item)
        p.append(m)
    s.append(p)
    return s


def n(pitch, ql=1.0):
    x = note.Note(pitch)
    x.quarterLength = ql
    return x


def q(p): return n(p, 1.0)
def h(p): return n(p, 2.0)
def w(p): return n(p, 4.0)
def e(p): return n(p, 0.5)
def dh(p): return n(p, 3.0)


def etude_r3_01():
    """E minor, 4/4, 76bpm: stepwise line with small leaps, 18 measures."""
    ms = [
        [q("E4"), q("F#4"), q("G4"), q("A4")],
        [q("B4"), q("A4"), q("G4"), q("F#4")],
        [q("E4"), q("G4"), q("B4"), q("E5")],
        [h("D5"), h("B4")],
        [q("C5"), q("B4"), q("A4"), q("G4")],
        [q("F#4"), q("G4"), q("A4"), q("F#4")],
        [h("G4"), h("E4")],
        [q("E4"), q("B4"), q("G4"), q("E5")],
        [q("D5"), q("C5"), q("B4"), q("A4")],
        [h("B4"), h("G4")],
        [q("A4"), q("B4"), q("C5"), q("D5")],
        [q("E5"), q("D5"), q("C5"), q("B4")],
        [q("A4"), q("C5"), q("E5"), q("A4")],
        [h("B4"), h("F#4")],
        [q("G4"), q("F#4"), q("E4"), q("G4")],
        [q("B4"), q("A4"), q("F#4"), q("D#4")],
        [h("E4"), h("B4")],
        [w("E4")],
    ]
    return build(ms, 1, "4/4", 76, "r3-01 Etude in E minor - correct take")


def etude_r3_02():
    """A major, 3/4, 80bpm: waltz-like, first 3/4 piece in the project, 20 measures."""
    ms = [
        [q("A4"), q("B4"), q("C#5")],
        [h("E5"), q("C#5")],
        [q("D5"), q("C#5"), q("B4")],
        [dh("A4")],
        [q("E4"), q("A4"), q("C#5")],
        [h("B4"), q("A4")],
        [q("G#4"), q("A4"), q("B4")],
        [dh("A4")],
        [q("C#5"), q("D5"), q("E5")],
        [h("F#5"), q("E5")],
        [q("D5"), q("C#5"), q("B4")],
        [dh("C#5")],
        [q("B4"), q("C#5"), q("D5")],
        [h("E5"), q("A4")],
        [q("B4"), q("G#4"), q("E4")],
        [dh("A4")],
        [q("A4"), q("C#5"), q("E5")],
        [h("D5"), q("B4")],
        [q("C#5"), q("B4"), q("G#4")],
        [dh("A4")],
    ]
    return build(ms, 3, "3/4", 80, "r3-02 Little Waltz in A - correct take")


def etude_r3_03():
    """G major, 4/4, 84bpm: broken thirds ascending/descending, 16 measures."""
    ms = [
        [q("G4"), q("B4"), q("A4"), q("C5")],
        [q("B4"), q("D5"), q("C5"), q("E5")],
        [h("D5"), h("B4")],
        [q("C5"), q("A4"), q("B4"), q("G4")],
        [q("A4"), q("F#4"), q("G4"), q("E4")],
        [h("D4"), h("G4")],
        [q("G4"), q("B4"), q("D5"), q("G5")],
        [q("F#5"), q("D5"), q("E5"), q("C5")],
        [q("D5"), q("B4"), q("C5"), q("A4")],
        [h("B4"), h("G4")],
        [q("E4"), q("G4"), q("F#4"), q("A4")],
        [q("G4"), q("B4"), q("A4"), q("C5")],
        [h("B4"), h("D5")],
        [q("C5"), q("B4"), q("A4"), q("F#4")],
        [h("G4"), h("D4")],
        [w("G4")],
    ]
    return build(ms, 1, "4/4", 84, "r3-03 Broken Thirds in G - correct take")


def etude_r3_04():
    """C major, 4/4, 72bpm: plain quarters/halves for clean error planting."""
    ms = [
        [q("C4"), q("D4"), q("E4"), q("F4")],
        [q("G4"), q("F4"), q("E4"), q("D4")],
        [q("C4"), q("E4"), q("G4"), q("C5")],
        [h("B4"), h("G4")],
        [q("A4"), q("G4"), q("F4"), q("E4")],
        [q("D4"), q("E4"), q("F4"), q("D4")],
        [h("E4"), h("C4")],
        [q("G4"), q("A4"), q("B4"), q("C5")],
        [q("D5"), q("C5"), q("B4"), q("A4")],
        [h("G4"), h("E4")],
        [q("F4"), q("A4"), q("G4"), q("B4")],
        [q("C5"), q("G4"), q("E4"), q("G4")],
        [h("D4"), h("G4")],
        [w("C4")],
    ]
    return build(ms, 0, "4/4", 72, "r3-04 Etude in C - planted errors")


R3_04_ERRORS = [
    ("wrong", 2, 1, "G4", "把本小节第 1 拍的 G4 拉成 A4(高一个全音),时值不变"),
    ("wrong", 8, 3, "B4", "把本小节第 3 拍的 B4 拉成 Bb4(低半音),时值不变"),
    ("missing", 5, 2, "G4", "完全跳过本小节第 2 拍的 G4(直接留一拍空,不要用别的音填)"),
    ("extra", 9, 1, "D5", "把本小节第 1 拍的 D5 连拉两次(各约半拍),再继续后面的音"),
    ("drag", 4, 1, "B4", "把本小节的二分音符 B4 拖长到约 3 拍,后面的 G4 顺延缩短"),
    ("drag", 11, 2, "A4", "把本小节第 2 拍的 A4 拖长到约 2 拍,之后追回节拍"),
]


def etude_r3_05():
    """D major, 4/4, 78bpm: eighth-note lines with landing quarters."""
    ms = [
        [e("D4"), e("E4"), e("F#4"), e("G4"), q("A4"), q("F#4")],
        [e("G4"), e("F#4"), e("E4"), e("D4"), h("E4")],
        [q("F#4"), q("A4"), q("D5"), q("A4")],
        [h("B4"), h("F#4")],
        [e("G4"), e("A4"), e("B4"), e("C#5"), q("D5"), q("A4")],
        [q("B4"), q("G4"), q("A4"), q("F#4")],
        [h("G4"), h("E4")],
        [q("D4"), q("F#4"), q("A4"), q("D5")],
        [e("C#5"), e("B4"), e("A4"), e("G4"), q("F#4"), q("A4")],
        [h("E4"), h("A4")],
        [q("D5"), q("B4"), q("G4"), q("E4")],
        [h("F#4"), h("A4")],
        [w("D4")],
    ]
    return build(ms, 2, "4/4", 78, "r3-05 Etude in D - planted errors")


R3_05_ERRORS = [
    ("wrong", 3, 3, "D5", "把本小节第 3 拍的 D5 拉成 C#5(低半音),时值不变"),
    ("missing", 6, 2, "G4", "完全跳过本小节第 2 拍的 G4(留空,不补别的音)"),
    ("missing", 11, 3, "G4", "完全跳过本小节第 3 拍的 G4"),
    ("extra", 8, 4, "D5", "把本小节第 4 拍的 D5 连拉两次(各约半拍)"),
    ("extra", 10, 3, "A4", "把本小节第 3-4 拍的 A4 拉成两个一拍的 A4(重复一次)"),
    ("drag", 12, 1, "F#4", "把本小节的二分音符 F#4 拖长到约 3 拍,后面的 A4 顺延缩短"),
]


def verify_errors(score: stream.Score, entries, name: str):
    """Construction-gold check: each entry's (measure, beat, pitch) must match."""
    part = score.parts[0]
    for kind, measure_number, beat, pitch, _text in entries:
        m = part.measure(measure_number)
        if m is None:
            raise SystemExit(f"{name}: measure {measure_number} missing")
        hit = None
        for x in m.notes:
            if abs(float(x.beat) - beat) < 1e-6:
                hit = x
                break
        if hit is None or hit.pitch.nameWithOctave.replace("-", "b") != pitch:
            got = hit.pitch.nameWithOctave if hit is not None else None
            raise SystemExit(
                f"{name}: {kind} entry expects {pitch} at m{measure_number} beat {beat}, got {got}")


def checklist_md(name: str, entries) -> str:
    lines = [f"### {name} 错误清单(共 {len(entries)} 处,其余全部按谱正确演奏)", ""]
    for index, (kind, measure_number, beat, pitch, text) in enumerate(entries, start=1):
        kind_cn = {"wrong": "错音", "missing": "漏音", "extra": "多拉", "drag": "拖拍"}[kind]
        lines.append(f"{index}. **[{kind_cn}] 第 {measure_number} 小节,第 {beat} 拍({pitch})**:{text}")
    lines.append("")
    return "\n".join(lines)


README = """# Round-3 录音任务:演奏要求

两组共 5 首,均为**全新曲目**(fresh-blind 规则要求)。全部第一把位、单声部,按谱面速度记号用节拍器起速即可(允许自然波动,不必机械)。

## 通用录音要求

- 环境:安静房间,手机/录音笔距琴约 0.5–1 米;
- 格式:m4a 或 wav,每首单独一个文件;
- 命名:`r3-01.m4a` … `r3-05.m4a`(和谱号一致);
- 每首**从头完整拉到尾**,中途拉错(A 组)不要停,继续拉完——自然状态就是我们要的分布;
- 录完不要试听后重录多遍——**第一条完整可用的就交**(盲审要求自然样本);
- 交付时请附一句每首的录音日期与演奏者(登记元数据需要)。

## A 组:r3-01 / r3-02 / r3-03(正确演奏,fresh-blind 用)

按谱正确演奏即可,无需任何特殊处理。注意 r3-02 是 3/4 拍(本项目第一次用)。

## B 组:r3-04 / r3-05(按清单故意出错,真值采集用)

先把曲子按谱练顺,然后**严格按下面清单在指定位置制造错误**,清单外的所有音都要拉对。每处错误做完就正常继续,不要停顿或重来。

{checklist_04}
{checklist_05}

## 提交后会发生什么

- A 组走 fresh-blind 登记(`western:fresh-blind-intake-stage`),用于第一小节受控 pilot 盲审 + 新执行器全曲真考;
- B 组作为时值/多拉音等类别走出 review-only 的真实错误真值,以及注入预考(0/60)的终验;
- 录音只进 `data/private/`,不进 git,不外发。
"""


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    pieces = [
        ("r3-01", etude_r3_01(), None),
        ("r3-02", etude_r3_02(), None),
        ("r3-03", etude_r3_03(), None),
        ("r3-04", etude_r3_04(), R3_04_ERRORS),
        ("r3-05", etude_r3_05(), R3_05_ERRORS),
    ]
    for name, score, errors in pieces:
        if errors:
            verify_errors(score, errors, name)
        path = OUT / f"{name}.musicxml"
        score.write("musicxml", fp=str(path))
        print(f"{name}: {len(list(score.parts[0].recurse().notes))} notes -> {path.name}")
    readme = README.format(checklist_04=checklist_md("r3-04", R3_04_ERRORS),
                           checklist_05=checklist_md("r3-05", R3_05_ERRORS))
    (OUT / "README-演奏要求.md").write_text(readme, encoding="utf-8")
    print(f"README-演奏要求.md written to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
