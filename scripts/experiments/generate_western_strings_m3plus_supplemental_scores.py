#!/usr/bin/env python3
"""Generate the minimum real-recording score set still required by M3+.

The generated labels describe score intent only. They are not performance gold
until a human confirms that the corresponding recording followed the score and
the recording instructions.
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from music21 import clef, expressions, key, metadata, meter, note, spanner, stream, tempo


REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "音频" / "m3plus-supplemental"


@dataclass(frozen=True)
class ScoreSpec:
    score_id: str
    title: str
    purpose: str
    instructions: list[str]
    score: stream.Score
    labels: list[dict[str, Any]]


def half(pitch: str) -> note.Note:
    value = note.Note(pitch)
    value.quarterLength = 2.0
    return value


def quarter(pitch: str) -> note.Note:
    value = note.Note(pitch)
    value.quarterLength = 1.0
    return value


def whole(pitch: str) -> note.Note:
    value = note.Note(pitch)
    value.quarterLength = 4.0
    return value


def base_score(title: str, bpm: int = 56) -> tuple[stream.Score, stream.Part]:
    score = stream.Score()
    score.metadata = metadata.Metadata(title=title, composer="M3+ controlled recording")
    part = stream.Part()
    part.insert(0, clef.TrebleClef())
    part.insert(0, key.KeySignature(0))
    part.insert(0, meter.TimeSignature("4/4"))
    part.insert(0, tempo.MetronomeMark(number=bpm))
    score.append(part)
    return score, part


def text_mark(value: note.Note, text: str) -> note.Note:
    value.expressions.append(expressions.TextExpression(text))
    return value


def add_measure(part: stream.Part, values: list[note.Note]) -> int:
    measure = stream.Measure(number=len(part.getElementsByClass(stream.Measure)) + 1)
    for value in values:
        # A TextExpression attached to Note.expressions is not serialized by
        # music21. Place it on the measure timeline so it becomes a MusicXML
        # <direction><words> marking at the note onset.
        for expression in list(value.expressions):
            if isinstance(expression, expressions.TextExpression):
                value.expressions.remove(expression)
                measure.insert(measure.highestTime, expression)
        measure.append(value)
    part.append(measure)
    return int(measure.number)


def straight_negative() -> ScoreSpec:
    score, part = base_score("M3P-01 C-major ascending straight tones", bpm=60)
    pitches = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"]
    labels: list[dict[str, Any]] = []
    for pitch in pitches:
        value = text_mark(whole(pitch), "straight tone - 4 beats")
        measure = add_measure(part, [value])
        labels.append(
            {
                "measure": measure,
                "noteIndex": 1,
                "writtenPitch": value.nameWithOctave,
                "expectedBehavior": "stable",
                "expectedPositiveModes": [],
                "expectedNegativeModes": ["slide", "trill", "vibrato", "ornament"],
            }
        )
    return ScoreSpec(
        "m3p-01",
        "纯直音负例",
        "为滑音、颤音、揉弦和装饰音模式提供真实直音负例。",
        [
            "实际演奏顺序：C5、D5、E5、F5、G5、A5、B5、C6，上行一次。",
            "节拍器 60 BPM；每个音 4 拍，一音一弓。",
            "所有音都拉成平直长音。",
            "禁止揉弦、颤音、滑音和任何装饰音。",
        ],
        score,
        labels,
    )


def vibrato_trill_positive() -> ScoreSpec:
    score, part = base_score("M3P-02 Fixed vibrato and trill pairs", bpm=60)
    pairs = [("D4", "E4"), ("E4", "F4"), ("F4", "G4"), ("G4", "A4")] * 2
    labels: list[dict[str, Any]] = []
    for base_pitch, upper_pitch in pairs:
        vibrato_note = text_mark(half(base_pitch), "vibrato - 2 beats")
        trill_note = half(base_pitch)
        trill_note.expressions.append(expressions.Trill())
        text_mark(trill_note, f"trill {base_pitch}-{upper_pitch}")
        measure = add_measure(part, [vibrato_note, trill_note])
        labels.extend(
            [
                {
                    "measure": measure,
                    "noteIndex": 1,
                    "writtenPitch": vibrato_note.nameWithOctave,
                    "expectedBehavior": "vibrato",
                    "expectedPositiveModes": ["vibrato"],
                    "expectedNegativeModes": ["trill", "slide"],
                },
                {
                    "measure": measure,
                    "noteIndex": 2,
                    "writtenPitch": trill_note.nameWithOctave,
                    "expectedBehavior": "trill",
                    "trillUpperPitch": upper_pitch,
                    "expectedPositiveModes": ["trill"],
                    "expectedNegativeModes": ["vibrato", "slide"],
                },
            ]
        )
    return ScoreSpec(
        "m3p-02",
        "揉弦与颤音独立复验",
        "提供一条独立于 r2-06 的揉弦/颤音正例录音。",
        [
            "实际顺序共 4 组：D5、E5、F5、G5。",
            "每组先把主音拉 2 拍并使用连续、明显的揉弦。",
            "随后在同一主音上做 2 拍颤音；上方音依次为 E5、F5、G5、A5。",
            "不要在两个音之间滑音。",
            "必须把 4 组从 D5 到 G5 完整再演奏一遍，总计 8 个揉弦单元和 8 个颤音单元。",
        ],
        score,
        labels,
    )


def ornament_contrast() -> ScoreSpec:
    score, part = base_score("M3P-03 Fixed mordent and plain-note pairs", bpm=60)
    pairs = [("D4", "E4"), ("E4", "F4"), ("F4", "G4"), ("G4", "A4")] * 2
    labels: list[dict[str, Any]] = []
    for base_pitch, upper_pitch in pairs:
        ornament_note = half(base_pitch)
        ornament_note.expressions.append(expressions.Mordent())
        text_mark(ornament_note, f"{base_pitch}-{upper_pitch}-{base_pitch}, then hold")
        plain_note = text_mark(half(base_pitch), "plain - 2 beats")
        measure = add_measure(part, [ornament_note, plain_note])
        labels.extend(
            [
                {
                    "measure": measure,
                    "noteIndex": 1,
                    "writtenPitch": ornament_note.nameWithOctave,
                    "expectedBehavior": "ornament-upper-mordent",
                    "ornamentUpperPitch": upper_pitch,
                    "expectedPositiveModes": ["ornament"],
                    "expectedNegativeModes": ["trill", "slide"],
                },
                {
                    "measure": measure,
                    "noteIndex": 2,
                    "writtenPitch": plain_note.nameWithOctave,
                    "expectedBehavior": "stable",
                    "expectedPositiveModes": [],
                    "expectedNegativeModes": ["ornament", "trill", "slide"],
                },
            ]
        )
    return ScoreSpec(
        "m3p-03",
        "装饰音与普通音对照",
        "让装饰音主音判法拥有真实正例和同音高普通音负例。",
        [
            "实际顺序共 4 组：D5、E5、F5、G5。",
            "每组第 1 个音在开头快速演奏“主音-上方音-主音”一次，再保持主音至 2 拍结束。",
            "上方音依次为 E5、F5、G5、A5；不要连续反复，避免演成颤音。",
            "每组第 2 个同音高音符拉 2 拍平直音，不加装饰和揉弦。",
            "不要把第 2 个音也演奏成颤音或揉弦。",
            "必须把 4 组完整再演奏一遍，总计 8 个装饰音单元和 8 个直音对照。",
        ],
        score,
        labels,
    )


def slide_contrast() -> ScoreSpec:
    score, part = base_score("M3P-04 Fixed slide and straight-tone pairs", bpm=60)
    pairs = [("C4", "D4"), ("D4", "E4"), ("E4", "F4"), ("F4", "G4")] * 2
    labels: list[dict[str, Any]] = []
    for pair_index, (source_pitch, target_pitch) in enumerate(pairs, start=1):
        source_note = text_mark(quarter(source_pitch), f"slide to {target_pitch}")
        target_note = text_mark(quarter(target_pitch), "arrive")
        ordinary_note = text_mark(half(target_pitch), "plain - 2 beats")
        measure = add_measure(part, [source_note, target_note, ordinary_note])
        part.insert(0, spanner.Glissando(source_note, target_note))
        labels.extend(
            [
                {
                    "measure": measure,
                    "noteIndex": 1,
                    "writtenPitch": source_note.nameWithOctave,
                    "expectedBehavior": "slide-source",
                    "expectedPositiveModes": ["slide"],
                    "expectedNegativeModes": ["trill", "vibrato", "ornament"],
                    "pairId": f"slide-{pair_index:02d}",
                    "pairRole": "source",
                },
                {
                    "measure": measure,
                    "noteIndex": 2,
                    "writtenPitch": target_note.nameWithOctave,
                    "expectedBehavior": "slide-arrival",
                    "expectedPositiveModes": ["slide"],
                    "expectedNegativeModes": ["trill", "vibrato", "ornament"],
                    "pairId": f"slide-{pair_index:02d}",
                    "pairRole": "target",
                },
                {
                    "measure": measure,
                    "noteIndex": 3,
                    "writtenPitch": ordinary_note.nameWithOctave,
                    "expectedBehavior": "stable",
                    "expectedPositiveModes": [],
                    "expectedNegativeModes": ["slide", "trill", "vibrato", "ornament"],
                },
            ]
        )
    return ScoreSpec(
        "m3p-04",
        "滑音与直音对照",
        "提供固定滑音正例和同目标音直音负例；自然泛音音准检测已取消。",
        [
            "实际顺序共 4 组：C5→D5、D5→E5、E5→F5、F5→G5。",
            "每组第 1 拍拉起点音，第 2 拍连续滑到目标音；滑动中不要出现明显断音。",
            "随后把同一目标音再拉 2 拍平直音，作为不带滑音的对照。",
            "全程不加揉弦、颤音或装饰音。",
            "必须把 4 组完整再演奏一遍，总计 8 个滑音单元和 8 个直音对照。",
        ],
        score,
        labels,
    )


SPECS = [straight_negative, vibrato_trill_positive, ornament_contrast, slide_contrast]


def rasterize_svg(svg_path: Path, png_path: Path) -> None:
    node_code = """
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
const image = await loadImage(process.env.M3P_SVG);
const canvas = createCanvas(Math.round(image.width * 2), Math.round(image.height * 2));
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
await fs.writeFile(process.env.M3P_PNG, canvas.toBuffer('image/png'));
"""
    import os

    result = subprocess.run(
        ["node", "--input-type=module", "-"],
        input=node_code,
        text=True,
        capture_output=True,
        cwd=REPO,
        env={**os.environ, "M3P_SVG": str(svg_path), "M3P_PNG": str(png_path)},
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"score rasterization failed: {result.stderr[:300]}")


def render_score_pages(musicxml_path: Path, out_dir: Path, stem: str) -> list[str]:
    import verovio

    toolkit = verovio.toolkit()
    toolkit.setOptions({"scale": 65, "footer": "none", "breaks": "auto", "adjustPageHeight": True})
    if not toolkit.loadData(musicxml_path.read_text(encoding="utf-8")):
        raise RuntimeError(f"Verovio could not load {musicxml_path}")
    outputs: list[str] = []
    for page in range(1, toolkit.getPageCount() + 1):
        svg_path = out_dir / f"{stem}-page{page}.svg"
        png_path = out_dir / f"{stem}-page{page}.png"
        svg = toolkit.renderToSVG(page)
        svg = svg.replace("{stroke:currentColor}", "{stroke:#000000}")
        svg = svg.replace(
            'class="definition-scale" color="black"',
            'class="definition-scale" color="black" stroke="#000000"',
        )
        svg_path.write_text(svg, encoding="utf-8")
        rasterize_svg(svg_path, png_path)
        svg_path.unlink()
        outputs.append(png_path.name)
    return outputs


def write_readme(out_dir: Path, specs: list[ScoreSpec]) -> None:
    lines = [
        "# M3+ 最小补录包",
        "",
        "目的:补齐真实负例、装饰音、滑音和独立揉弦/颤音证据。自然泛音音准检测已取消。机器已生成固定音符参考和计划真值;录音前它们不是 performance gold。",
        "",
        "## 录音要求",
        "",
        "- 不需要看谱。严格按下方的固定音符顺序和文字要求演奏即可；MusicXML、MIDI 和谱图只供机器校验。",
        "- 每条单独保存为 `m3p-01.m4a` 至 `m3p-04.m4a`。",
        "- 只录小提琴，不放伴奏；保持手机位置不变，避免削波和环境噪声。",
        "- 统一使用节拍器 60 BPM；开头留 1–2 秒静音，但不要口头报数。",
        "- 某处演错时整条重录，不在同一文件内停下重来。",
        "- 本批实录按书面音高整体高八度演奏；下方已直接写成实际应拉的 C5–C6 音区，不要再自行移八度。机器定位固定加 `+12` 半音；该偏移只用于找窗，不会放宽音准或技法判定标准。",
        "",
    ]
    for spec in specs:
        lines.extend([f"## {spec.score_id} {spec.title}", "", spec.purpose, ""])
        lines.extend(f"- {instruction}" for instruction in spec.instructions)
        lines.append("")
    lines.extend(
        [
            "录完后只需把 4 个音频放回本目录。先运行 `npm run western:m3plus-supplemental-status` 确认 4/4 可解码，再运行 `npm run western:m3plus-supplemental-eval` 做固定序列定位和模式指标评测。",
            "谱面已经真实写入揉弦文字、颤音、装饰音、滑音及普通直音对照。机器先从谱面读取预期技法，再从音频核验是否按谱执行；谱面标了技法不等于演奏已经正确。",
            "机器定位和模式阈值未通过时先修特征，不交教师。机器通过后，演奏者确认四条均按本说明完成，再运行 `npm run western:m3plus-supplemental-eval -- --performance-confirmed`；之后最多提出一次专业复核。",
            "定位阶段允许实际演奏音高在目标附近 `±100 cents` 内波动；该范围只用于找到对应音符窗口，不代表系统认定这一音准正确。模式误报 precision 门槛仍保持 90%。",
            "该评测始终保持 `studentGateReady=false`，不会仅凭录音任务自动开放学生反馈。",
            "",
        ]
    )
    (out_dir / "README-录音说明.md").write_text("\n".join(lines), encoding="utf-8")


def build(out_dir: Path) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_rows: list[dict[str, Any]] = []
    score_intent: list[dict[str, Any]] = []
    specs = [factory() for factory in SPECS]
    for spec in specs:
        musicxml_path = out_dir / f"{spec.score_id}.musicxml"
        midi_path = out_dir / f"{spec.score_id}.mid"
        spec.score.write("musicxml", fp=str(musicxml_path))
        spec.score.write("midi", fp=str(midi_path))
        pages = render_score_pages(musicxml_path, out_dir, spec.score_id)
        manifest_rows.append(
            {
                "recordingId": spec.score_id,
                "audioFile": f"{spec.score_id}.m4a",
                "scoreFile": musicxml_path.name,
                "guideMidi": midi_path.name,
                "scorePages": "|".join(pages),
                "performanceConfirmed": "no",
                "reviewStatus": "awaiting-recording",
            }
        )
        score_intent.append(
            {
                "recordingId": spec.score_id,
                "scoreFile": musicxml_path.name,
                "title": spec.title,
                "purpose": spec.purpose,
                "instructions": spec.instructions,
                "performanceConfirmed": False,
                "localizationTransposeSemitones": 12,
                "labels": spec.labels,
            }
        )
    with (out_dir / "manifest-template.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(manifest_rows[0]))
        writer.writeheader()
        writer.writerows(manifest_rows)
    report = {
        "schemaVersion": 1,
        "purpose": "M3+ supplemental score intent; not performance gold until confirmed",
        "performanceGoldReady": False,
        "recordingCount": len(specs),
        "recordings": score_intent,
    }
    (out_dir / "score-intent.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_readme(out_dir, specs)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    report = build(args.out.resolve())
    print(json.dumps({"ok": True, "out": str(args.out), "recordingCount": report["recordingCount"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
