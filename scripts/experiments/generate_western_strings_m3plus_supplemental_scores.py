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

from music21 import articulations, clef, expressions, key, metadata, meter, note, stream, tempo


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
        measure.append(value)
    part.append(measure)
    return int(measure.number)


def straight_negative() -> ScoreSpec:
    score, part = base_score("M3P-01 Straight tones - no vibrato, trill, or slide", bpm=52)
    pitches = ["G3", "D4", "A4", "E5", "B4", "F#5"] * 4
    labels: list[dict[str, Any]] = []
    for pair_index in range(0, len(pitches), 2):
        values = [half(pitches[pair_index]), half(pitches[pair_index + 1])]
        if pair_index == 0:
            text_mark(values[0], "senza vibrato - straight tone")
        measure = add_measure(part, values)
        for note_index, value in enumerate(values, start=1):
            labels.append(
                {
                    "measure": measure,
                    "noteIndex": note_index,
                    "writtenPitch": value.nameWithOctave,
                    "expectedBehavior": "stable",
                    "expectedPositiveModes": [],
                    "expectedNegativeModes": ["slide", "trill", "vibrato", "ornament", "harmonic"],
                }
            )
    return ScoreSpec(
        "m3p-01",
        "纯直音负例",
        "为滑音、颤音、揉弦、装饰音和泛音模式提供真实负例。",
        [
            "所有音都拉成平直长音。",
            "禁止揉弦、颤音、滑音和任何装饰音。",
            "每个音保持到谱面时值结束，音与音之间正常换弓即可。",
        ],
        score,
        labels,
    )


def vibrato_trill_positive() -> ScoreSpec:
    score, part = base_score("M3P-02 Vibrato then trill in every measure", bpm=50)
    pairs = [("A4", "B4"), ("D5", "E5"), ("G4", "A4"), ("E5", "F5")] * 2
    labels: list[dict[str, Any]] = []
    for vibrato_pitch, trill_pitch in pairs:
        vibrato_note = text_mark(half(vibrato_pitch), "vib.")
        trill_note = half(trill_pitch)
        trill_note.expressions.append(expressions.Trill())
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
            "每小节第 1 个音使用连续、明显的揉弦。",
            "每小节第 2 个音严格演奏谱面颤音，主音和上方音都要清楚。",
            "不要在两个音之间滑音。",
        ],
        score,
        labels,
    )


def ornament_contrast() -> ScoreSpec:
    score, part = base_score("M3P-03 Ornament then plain-note contrast", bpm=56)
    pitches = ["A4", "B4", "C5", "D5", "E5", "D5", "C5", "B4"]
    labels: list[dict[str, Any]] = []
    intro = [text_mark(half("A4"), "plain intro"), half("A4")]
    intro_measure = add_measure(part, intro)
    for note_index, value in enumerate(intro, start=1):
        labels.append(
            {
                "measure": intro_measure,
                "noteIndex": note_index,
                "writtenPitch": value.nameWithOctave,
                "expectedBehavior": "stable",
                "expectedPositiveModes": [],
                "expectedNegativeModes": ["ornament", "trill", "slide"],
            }
        )
    for index, pitch in enumerate(pitches):
        ornament_note = half(pitch)
        ornament_name = "mordent" if index % 2 == 0 else "turn"
        ornament_note.expressions.append(expressions.Mordent() if ornament_name == "mordent" else expressions.Turn())
        plain_note = text_mark(half(pitch), "plain")
        measure = add_measure(part, [ornament_note, plain_note])
        labels.extend(
            [
                {
                    "measure": measure,
                    "noteIndex": 1,
                    "writtenPitch": ornament_note.nameWithOctave,
                    "expectedBehavior": f"ornament-{ornament_name}",
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
            "第 1 小节是两个普通准备音，不加装饰。",
            "从第 2 小节开始，每小节第 1 个音按谱面的波音或回音记号演奏。",
            "从第 2 小节开始，每小节第 2 个同音高音符不加装饰，保持平直。",
            "不要把第 2 个音也演奏成颤音或揉弦。",
        ],
        score,
        labels,
    )


def harmonic_contrast() -> ScoreSpec:
    score, part = base_score("M3P-04 Natural harmonics and open-string controls", bpm=48)
    pairs = [("G4", "G3"), ("D5", "D4"), ("A5", "A4"), ("E6", "E5")] * 2
    labels: list[dict[str, Any]] = []
    for sounding_pitch, open_pitch in pairs:
        harmonic_note = half(sounding_pitch)
        harmonic = articulations.StringHarmonic()
        harmonic.harmonicType = "natural"
        harmonic.pitchType = "sounding"
        harmonic_note.articulations.append(harmonic)
        text_mark(harmonic_note, "nat. harm.")
        ordinary_note = text_mark(half(open_pitch), "open string")
        measure = add_measure(part, [harmonic_note, ordinary_note])
        labels.extend(
            [
                {
                    "measure": measure,
                    "noteIndex": 1,
                    "writtenPitch": harmonic_note.nameWithOctave,
                    "expectedBehavior": "natural-harmonic-sounding-pitch",
                    "expectedPositiveModes": ["harmonic"],
                    "expectedNegativeModes": [],
                },
                {
                    "measure": measure,
                    "noteIndex": 2,
                    "writtenPitch": ordinary_note.nameWithOctave,
                    "expectedBehavior": "stable-open-string",
                    "expectedPositiveModes": [],
                    "expectedNegativeModes": ["harmonic"],
                },
            ]
        )
    return ScoreSpec(
        "m3p-04",
        "自然泛音与空弦对照",
        "验证谱面 sounding-pitch 角色和真实自然泛音录音。",
        [
            "每小节第 1 个音演奏自然泛音，谱面写的是实际发声音高。",
            "依次使用 G、D、A、E 弦的八度自然泛音；第二轮重复一次。",
            "每小节第 2 个音演奏对应空弦普通音，不加揉弦。",
        ],
        score,
        labels,
    )


SPECS = [straight_negative, vibrato_trill_positive, ornament_contrast, harmonic_contrast]


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
        "目的:补齐真实负例、装饰音、泛音和独立揉弦/颤音证据。机器已生成谱面和计划真值;录音前它们不是 performance gold。",
        "",
        "## 录音要求",
        "",
        "- 每份谱从头到尾录一遍，单独保存为 `m3p-01.m4a` 至 `m3p-04.m4a`。",
        "- 只录小提琴，不放伴奏；保持手机位置不变，避免削波和环境噪声。",
        "- 按谱面速度演奏；开头可留 1–2 秒静音，但不要口头报数。",
        "- 某处演错时整条重录，不在同一文件内停下重来。",
        "",
    ]
    for spec in specs:
        lines.extend([f"## {spec.score_id} {spec.title}", "", spec.purpose, ""])
        lines.extend(f"- {instruction}" for instruction in spec.instructions)
        lines.append("")
    lines.extend(
        [
            "录完后只需把 4 个音频放回本目录。系统会先做机器预检；只有预检通过才会提出一次人工确认，不再让教师反复复核定位错误的包。",
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
                "title": spec.title,
                "purpose": spec.purpose,
                "instructions": spec.instructions,
                "performanceConfirmed": False,
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
