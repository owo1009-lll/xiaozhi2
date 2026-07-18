#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the round-4 release-level fresh-blind recording pack.

Six brand-new pieces never used in rounds 1/2/3. This is the final
owner-facing recording ledger item under the 2026-07-19 recording-cap
clause (docs/project-status.md): once these six takes pass the frozen
release fresh-blind contract, no further recordings will be requested.

  A (correct takes, 2):
    r4-01  D minor  4/4  narrative line (first minor-key correct take)
    r4-02  G major  6/8  siciliano feel (first 6/8 piece in the project)
  B (technique takes, 2 — technique-safety regions recorded in sidecars):
    r4-03  A minor  4/4  long tones with vibrato/trill regions
    r4-04  D major  4/4  slide (portamento) pairs
  C (planted-error takes, 2 — closes the r2fb "positions not recorded" gap):
    r4-05  G major  4/4  6 planted errors (wrong x2 / missing / extra / drag x2)
    r4-06  C major  3/4  6 planted errors (wrong / missing x2 / extra x2 / drag)

Every planted-error and technique-region entry is verified against the
composed stream (measure, beat, pitch) at generation time — construction
grade gold. Deterministic. Single voice, first position, no double stops
(known basic-pitch polyphony limitation is deliberately avoided).

Output: 音频/round4-谱子/r4-0N.musicxml (+ -marked editions, sidecar JSON,
README-round4-演奏要求.md). PDF/PNG export runs separately via MuseScore 4.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from music21 import clef, duration, expressions, key, metadata, meter, note, stream, tempo

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "音频" / "round4-谱子"


def build(measures, ks_sharps, ts="4/4", bpm=76, title="", beat_ql=None):
    s = stream.Score()
    s.insert(0, metadata.Metadata())
    s.metadata.title = title
    s.metadata.composer = "practice etude (round 4)"
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


def n(pitch, ql=1.0):
    x = note.Note(pitch)
    x.quarterLength = ql
    return x


def q(p): return n(p, 1.0)
def h(p): return n(p, 2.0)
def w(p): return n(p, 4.0)
def e(p): return n(p, 0.5)
def dh(p): return n(p, 3.0)
def dq(p): return n(p, 1.5)


# --- A 组:正常演奏 -------------------------------------------------------

def etude_r4_01():
    """D minor, 4/4, 74bpm: stepwise narrative line, 16 measures."""
    ms = [
        [q("D4"), q("E4"), q("F4"), q("G4")],
        [q("A4"), q("G4"), q("F4"), q("E4")],
        [q("D4"), q("F4"), q("A4"), q("D5")],
        [h("C5"), h("A4")],
        [q("B-4"), q("A4"), q("G4"), q("F4")],
        [q("E4"), q("F4"), q("G4"), q("E4")],
        [h("F4"), h("D4")],
        [q("A4"), q("B-4"), q("C5"), q("D5")],
        [q("E5"), q("D5"), q("C5"), q("B-4")],
        [h("A4"), h("F4")],
        [q("G4"), q("A4"), q("B-4"), q("G4")],
        [q("A4"), q("F4"), q("D4"), q("F4")],
        [h("E4"), h("A4")],
        [q("D5"), q("C5"), q("B-4"), q("A4")],
        [q("G4"), q("E4"), q("F4"), q("E4")],
        [w("D4")],
    ]
    return build(ms, -1, "4/4", 74, "r4-01 Etude in D minor - correct take")


def etude_r4_02():
    """G major, 6/8, dotted-quarter=52: siciliano feel, 14 measures."""
    ms = [
        [e("G4"), e("A4"), e("B4"), e("D5"), e("B4"), e("G4")],
        [q("C5"), e("B4"), q("A4"), e("F#4")],
        [e("G4"), e("B4"), e("D5"), e("G5"), e("D5"), e("B4")],
        [dq("E5"), dq("D5")],
        [e("C5"), e("D5"), e("E5"), e("D5"), e("C5"), e("B4")],
        [q("A4"), e("B4"), q("C5"), e("A4")],
        [e("B4"), e("A4"), e("G4"), e("A4"), e("B4"), e("C5")],
        [dq("B4"), dq("G4")],
        [e("D5"), e("E5"), e("F#5"), e("G5"), e("F#5"), e("E5")],
        [q("D5"), e("B4"), q("G4"), e("B4")],
        [e("C5"), e("B4"), e("A4"), e("D5"), e("C5"), e("B4")],
        [dq("A4"), dq("D5")],
        [q("B4"), e("A4"), q("A4"), e("F#4")],
        [dh("G4")],
    ]
    return build(ms, 1, "6/8", 52, "r4-02 Siciliano in G - correct take", beat_ql=1.5)


# --- B 组:技法 -----------------------------------------------------------

def etude_r4_03():
    """A minor, 4/4, 66bpm: long tones for vibrato/trill, 14 measures."""
    ms = [
        [w("A4")],
        [h("B4"), h("C5")],
        [w("E5")],
        [h("D5"), h("C5")],
        [q("B4"), q("C5"), h("B4")],
        [w("A4")],
        [h("E4"), h("A4")],
        [w("B4")],
        [h("C5"), h("D5")],
        [w("E5")],
        [h("D5"), h("B4")],
        [q("C5"), q("B4"), h("A4")],
        [h("G4"), h("E4")],
        [w("A4")],
    ]
    return build(ms, 0, "4/4", 66, "r4-03 Long Tones in A minor - vibrato/trill take")


# (technique, measure, beat, pitch, 谱面标注)
R4_03_TECHNIQUE = [
    ("vibrato", 1, 1.0, "A4", "揉弦"),
    ("vibrato", 3, 1.0, "E5", "揉弦"),
    ("trill", 4, 1.0, "D5", "tr"),
    ("vibrato", 5, 3.0, "B4", "揉弦"),
    ("vibrato", 7, 3.0, "A4", "揉弦"),
    ("trill", 8, 1.0, "B4", "tr"),
    ("vibrato", 9, 3.0, "D5", "揉弦"),
    ("vibrato", 10, 1.0, "E5", "揉弦"),
    ("trill", 11, 3.0, "B4", "tr"),
    ("vibrato", 12, 3.0, "A4", "揉弦"),
    ("vibrato", 14, 1.0, "A4", "揉弦"),
]


def etude_r4_04():
    """D major, 4/4, 70bpm: slide (portamento) pairs, 14 measures."""
    ms = [
        [q("D4"), q("E4"), q("F#4"), q("G4")],
        [q("A4"), q("D5"), h("A4")],
        [q("B4"), q("G4"), q("A4"), q("F#4")],
        [h("G4"), q("B4"), q("A4")],
        [q("F#4"), q("A4"), q("D5"), q("E5")],
        [h("F#5"), h("D5")],
        [q("E5"), q("D5"), q("B4"), q("A4")],
        [h("G4"), h("F#4")],
        [q("D4"), q("F#4"), q("A4"), q("D5")],
        [h("B4"), q("G4"), q("A4")],
        [q("D5"), q("C#5"), q("B4"), q("C#5")],
        [h("D5"), h("A4")],
        [q("B4"), q("A4"), q("G4"), q("F#4")],
        [w("D4")],
    ]
    return build(ms, 2, "4/4", 70, "r4-04 Slides in D - portamento take")


# (startM, startBeat, startPitch, endM, endBeat, endPitch, direction)
R4_04_SLIDES = [
    (2, 1.0, "A4", 2, 2.0, "D5", "up"),
    (4, 1.0, "G4", 4, 3.0, "B4", "up"),
    (5, 4.0, "E5", 6, 1.0, "F#5", "up"),
    (7, 2.0, "D5", 7, 3.0, "B4", "down"),
    (9, 3.0, "A4", 9, 4.0, "D5", "up"),
    (10, 1.0, "B4", 10, 3.0, "G4", "down"),
    (12, 1.0, "D5", 12, 3.0, "A4", "down"),
]


# --- C 组:故意出错(位置预记录) -----------------------------------------

def etude_r4_05():
    """G major, 4/4, 76bpm: plain quarters/halves for clean error planting."""
    ms = [
        [q("G4"), q("A4"), q("B4"), q("C5")],
        [q("D5"), q("C5"), q("B4"), q("A4")],
        [q("G4"), q("B4"), q("D5"), q("G5")],
        [h("E5"), h("C5")],
        [q("D5"), q("B4"), q("C5"), q("A4")],
        [q("B4"), q("G4"), q("A4"), q("F#4")],
        [h("G4"), h("D4")],
        [q("E4"), q("F#4"), q("G4"), q("A4")],
        [q("B4"), q("C5"), q("D5"), q("E5")],
        [h("D5"), h("B4")],
        [q("C5"), q("A4"), q("F#4"), q("A4")],
        [q("G4"), q("B4"), q("A4"), q("F#4")],
        [h("A4"), h("F#4")],
        [w("G4")],
    ]
    return build(ms, 1, "4/4", 76, "r4-05 Etude in G - planted errors")


R4_05_ERRORS = [
    ("wrong", 2, 1, "D5", "错音:改拉E5", "把本小节第 1 拍的 D5 拉成 E5(高一个全音),时值不变"),
    ("wrong", 9, 2, "C5", "错音:改拉#C5", "把本小节第 2 拍的 C5 拉成 C#5(高半音),时值不变"),
    ("missing", 5, 3, "C5", "漏音:跳过不拉", "完全跳过本小节第 3 拍的 C5(留一拍空,不要用别的音填)"),
    ("extra", 11, 1, "C5", "多拉:连拉两次", "把本小节第 1 拍的 C5 连拉两次(各约半拍),再继续后面的音"),
    ("drag", 7, 1, "G4", "拖拍:拖到约3拍", "把本小节的二分音符 G4 拖长到约 3 拍,后面的 D4 顺延缩短"),
    ("drag", 12, 3, "A4", "拖拍:拖到约2拍", "把本小节第 3 拍的 A4 拖长到约 2 拍,之后追回节拍"),
]


def etude_r4_06():
    """C major, 3/4, 80bpm: first planted-error piece in triple meter."""
    ms = [
        [q("C4"), q("D4"), q("E4")],
        [q("F4"), q("E4"), q("D4")],
        [h("E4"), q("G4")],
        [q("A4"), q("G4"), q("F4")],
        [h("E4"), q("C4")],
        [q("D4"), q("E4"), q("F4")],
        [h("G4"), q("E4")],
        [q("C5"), q("B4"), q("A4")],
        [h("G4"), q("A4")],
        [q("B4"), q("C5"), q("D5")],
        [h("C5"), q("G4")],
        [q("A4"), q("F4"), q("D4")],
        [h("G4"), q("B4")],
        [q("C5"), q("G4"), q("E4")],
        [q("F4"), q("E4"), q("D4")],
        [dh("C4")],
    ]
    return build(ms, 0, "3/4", 80, "r4-06 Etude in C (3/4) - planted errors")


R4_06_ERRORS = [
    ("wrong", 8, 1, "C5", "错音:改拉B4", "把本小节第 1 拍的 C5 拉成 B4(低半音),时值不变"),
    ("missing", 4, 2, "G4", "漏音:跳过不拉", "完全跳过本小节第 2 拍的 G4(留空,不补别的音)"),
    ("missing", 10, 3, "D5", "漏音:跳过不拉", "完全跳过本小节第 3 拍的 D5"),
    ("extra", 3, 3, "G4", "多拉:连拉两次", "把本小节第 3 拍的 G4 连拉两次(各约半拍)"),
    ("extra", 14, 1, "C5", "多拉:连拉两次", "把本小节第 1 拍的 C5 连拉两次(各约半拍)"),
    ("drag", 11, 1, "C5", "拖拍:拖到约2.5拍", "把本小节的二分音符 C5 拖长到约 2.5 拍,后面的 G4 顺延缩短"),
]


# --- 构造级验证 -----------------------------------------------------------

def find_note(score: stream.Score, measure_number: int, beat: float, name: str):
    part = score.parts[0]
    m = part.measure(measure_number)
    if m is None:
        raise SystemExit(f"{name}: measure {measure_number} missing")
    for x in m.notes:
        if abs(float(x.beat) - float(beat)) < 1e-6:
            return x
    return None


def check_pitch(x, pitch: str, name: str, where: str):
    if x is None or x.pitch.nameWithOctave.replace("-", "b") != pitch.replace("-", "b"):
        got = x.pitch.nameWithOctave if x is not None else None
        raise SystemExit(f"{name}: expects {pitch} at {where}, got {got}")


def verify_errors(score: stream.Score, entries, name: str):
    for kind, measure_number, beat, pitch, _short, _text in entries:
        x = find_note(score, measure_number, beat, name)
        check_pitch(x, pitch, name, f"m{measure_number} beat {beat} ({kind})")


def verify_technique(score: stream.Score, entries, name: str):
    for technique, measure_number, beat, pitch, _mark in entries:
        x = find_note(score, measure_number, beat, name)
        check_pitch(x, pitch, name, f"m{measure_number} beat {beat} ({technique})")


def verify_slides(score: stream.Score, entries, name: str):
    for sm, sb, sp, em, eb, ep, _direction in entries:
        check_pitch(find_note(score, sm, sb, name), sp, name, f"m{sm} beat {sb} (slide start)")
        check_pitch(find_note(score, em, eb, name), ep, name, f"m{em} beat {eb} (slide end)")


# --- 谱面标注 -------------------------------------------------------------

def add_technique_marks(score: stream.Score, entries):
    part = score.parts[0]
    for technique, measure_number, beat, _pitch, mark in entries:
        m = part.measure(measure_number)
        if technique == "trill":
            for x in m.notes:
                if abs(float(x.beat) - beat) < 1e-6:
                    x.expressions.append(expressions.Trill())
                    break
        else:
            text = expressions.TextExpression(mark)
            text.placement = "above"
            m.insert(float(beat) - 1.0, text)
    return score


def add_slide_marks(score: stream.Score, entries):
    part = score.parts[0]
    arrow = {"up": "滑↑", "down": "滑↓"}
    for sm, sb, _sp, em, eb, _ep, direction in entries:
        m = part.measure(em)
        text = expressions.TextExpression(arrow[direction])
        text.placement = "above"
        m.insert(float(eb) - 1.0, text)
    return score


CIRCLED = "①②③④⑤⑥⑦⑧⑨"


def annotated_copy(build_fn, entries, title_suffix="(错误标注版,仅供演奏参考)"):
    """Performer edition: red markers above each planted-error note. The CLEAN
    file stays the evaluation gold; this copy is for the music stand only and
    must not be photographed for the OMR/M4a sets."""
    score = build_fn()
    score.metadata.title = f"{score.metadata.title} {title_suffix}"
    part = score.parts[0]
    for index, (kind, measure_number, beat, pitch, short, _text) in enumerate(entries, start=1):
        m = part.measure(measure_number)
        text = expressions.TextExpression(f"{CIRCLED[index - 1]}{short}")
        text.placement = "above"
        try:
            text.style.color = "#CC0000"
            text.style.fontSize = 11
        except Exception:
            pass
        m.insert(float(beat) - 1.0, text)
    return score


def checklist_md(name: str, entries) -> str:
    lines = [f"### {name} 错误清单(共 {len(entries)} 处,其余全部按谱正确演奏)", ""]
    for index, (kind, measure_number, beat, pitch, _short, text) in enumerate(entries, start=1):
        kind_cn = {"wrong": "错音", "missing": "漏音", "extra": "多拉", "drag": "拖拍"}[kind]
        lines.append(f"{index}. **[{kind_cn}] 第 {measure_number} 小节,第 {beat} 拍({pitch})**:{text}")
    lines.append("")
    return "\n".join(lines)


README = """# Round-4 录音任务:发布级 fresh-blind 录音包(录音需求就此封顶)

六首全新曲目,全部第一把位、单声部、无双音。这是 2026-07-19 录音封顶承诺
(docs/project-status.md)里唯一剩余的录音项:**这 6 首录完且通过冻结发布门槛后,
上线所需录音就此封死,不再新增**(仅有的例外:考试不及格针对失败项重录/负责人主动扩范围)。

## 通用录音要求

- 环境:安静房间,手机/录音笔距琴约 0.5–1 米;
- 格式:m4a 或 wav,每首单独一个文件;
- 命名:`r4-01.m4a` … `r4-06.m4a`(和谱号一致);
- 每首**从头完整拉到尾**,自然波动不必机械,拉错了(A/B 组)不要停,继续拉完;
- 录完不要试听后重录多遍——**第一条完整可用的就交**(保留自然样本分布);
- 建议由**未参与过调参的演奏者**录(录过 r2fb 那位就符合,这些曲子对 TA 也是全新的);
- 交付时请附一句每首的录音日期与演奏者(登记元数据需要)。

## A 组:r4-01 / r4-02(正常演奏)

按谱正确演奏即可。注意:

- `r4-01` 是 d 小调(1 个降号,谱面 B 都是 bB);
- `r4-02` 是 **6/8 拍**(本项目第一次用),附点四分音符 = 52,数两大拍即可。

## B 组:r4-03 / r4-04(技法演奏)

- `r4-03`(揉弦/颤音):谱面标"揉弦"的长音请加明显揉弦;标 `tr` 的音拉颤音
  (与上方二度来回)。**没有标注的音就平拉**——标注区之外保持干净,这正是
  technique-safety 要考的边界。
- `r4-04`(滑音):谱面标"滑↑ / 滑↓"处,从前一个音**滑进**该音(明显的滑音/portamento);
  没有标注的地方正常换指,不要顺手滑。

标注位置已同时写入 `r4-03-technique-regions.json` / `r4-04-slide-regions.json`
(机器侧 technique-safety 标记区直接用它,不再需要你回忆位置)。

## C 组:r4-05 / r4-06(按清单故意出错,位置已预记录)

先把曲子按谱练顺,然后**严格按下面清单在指定位置制造错误**,清单外的所有音都要拉对。
每处错误做完就正常继续,不要停顿或重来。这两条就是补上 r2fb 那批"故意出错但没记位置"
缺口的正式真值采集:**位置在这里已经白纸黑字,录完不需要你再补任何记录**。
如果实际演奏时某处没做出来或做错了位置,只需回一句"第 N 条没做成/做在了第 X 小节",
其余照单即可。

演奏时可用**错误标注版**(`r4-05-marked.pdf` / `r4-06-marked.pdf`,红字①-⑥直接标在
对应音符上方,编号与下表一致)。注意:**将来 M4a 拍照任务必须用干净版**
(标注版红字会污染照片域样本)。

注意 `r4-06` 是 3/4 拍。

{checklist_05}
{checklist_06}

## 提交后会发生什么

- 六条录音进 `data/private/western-strings-round4/`,不进 git,不外发;
- 作为**发布级 fresh-blind**(全新曲目+全新录音)一次性消费:A 组走 clean-full
  (谱面即真值),B 组走 technique-safety(标记区 0 指控),C 组走已知真值精度考
  (清单即真值,含位置);
- 通过冻结门槛 → 录音需求封顶生效,上线剩余项只剩 M4a 拍照验收、学生端接线和最终批准;
- 不通过 → 只针对失败项重录(封顶条款例外 1),不会重开整包。
"""


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    pieces = [
        ("r4-01", etude_r4_01(), None),
        ("r4-02", etude_r4_02(), None),
        ("r4-03", add_technique_marks(etude_r4_03(), R4_03_TECHNIQUE), None),
        ("r4-04", add_slide_marks(etude_r4_04(), R4_04_SLIDES), None),
        ("r4-05", etude_r4_05(), R4_05_ERRORS),
        ("r4-06", etude_r4_06(), R4_06_ERRORS),
    ]

    verify_technique(etude_r4_03(), R4_03_TECHNIQUE, "r4-03")
    verify_slides(etude_r4_04(), R4_04_SLIDES, "r4-04")

    for name, score, errors in pieces:
        if errors:
            verify_errors(score, errors, name)
        path = OUT / f"{name}.musicxml"
        score.write("musicxml", fp=str(path))
        print(f"{name}: {len(list(score.parts[0].recurse().notes))} notes -> {path.name}")

    for name, build_fn, errors in (("r4-05", etude_r4_05, R4_05_ERRORS),
                                   ("r4-06", etude_r4_06, R4_06_ERRORS)):
        marked = annotated_copy(build_fn, errors)
        marked_path = OUT / f"{name}-marked.musicxml"
        marked.write("musicxml", fp=str(marked_path))
        print(f"{name}-marked: {len(errors)} in-score markers -> {marked_path.name}")

    technique_sidecar = {
        "scoreId": "r4-03",
        "contractNote": "technique-safety marked regions; zero accusations expected inside these regions",
        "regions": [
            {"technique": t, "measure": m, "beat": b, "pitch": p, "scoreMark": mark}
            for t, m, b, p, mark in R4_03_TECHNIQUE
        ],
    }
    (OUT / "r4-03-technique-regions.json").write_text(
        json.dumps(technique_sidecar, ensure_ascii=False, indent=2), encoding="utf-8")

    slide_sidecar = {
        "scoreId": "r4-04",
        "contractNote": "technique-safety marked regions (slides); zero accusations expected inside these regions",
        "slides": [
            {"start": {"measure": sm, "beat": sb, "pitch": sp},
             "end": {"measure": em, "beat": eb, "pitch": ep},
             "direction": direction}
            for sm, sb, sp, em, eb, ep, direction in R4_04_SLIDES
        ],
    }
    (OUT / "r4-04-slide-regions.json").write_text(
        json.dumps(slide_sidecar, ensure_ascii=False, indent=2), encoding="utf-8")
    print("technique/slide sidecars written")

    readme = README.format(checklist_05=checklist_md("r4-05", R4_05_ERRORS),
                           checklist_06=checklist_md("r4-06", R4_06_ERRORS))
    (OUT / "README-round4-演奏要求.md").write_text(readme, encoding="utf-8")
    print(f"README-round4-演奏要求.md written to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
