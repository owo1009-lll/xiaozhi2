#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageOps


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts/experiments/eval_western_strings_m4_real_jpg_omr.py"
SPEC = importlib.util.spec_from_file_location("m4_real_jpg", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

ADAPTIVE_PATH = REPO / "scripts/experiments/eval_western_strings_m4_adaptive_interline.py"
ADAPTIVE_SPEC = importlib.util.spec_from_file_location("m4_adaptive_interline", ADAPTIVE_PATH)
assert ADAPTIVE_SPEC and ADAPTIVE_SPEC.loader
ADAPTIVE = importlib.util.module_from_spec(ADAPTIVE_SPEC)
ADAPTIVE_SPEC.loader.exec_module(ADAPTIVE)


def staff_image(interline: int, width: int = 800, height: int = 500) -> Image.Image:
    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    for top in (70, 230, 390):
        for line in range(5):
            y = top + line * interline
            draw.line((40, y, width - 40, y), fill=0, width=1)
    return image


def main() -> int:
    for expected in (5, 9, 12):
        estimated, confidence = MODULE.estimate_staff_interline(staff_image(expected))
        assert estimated is not None
        assert abs(estimated - expected) <= 1, (expected, estimated, confidence)
        plan = MODULE.adaptive_interline_plan(staff_image(expected))
        assert 19.0 <= expected * plan["appliedScale"] <= 25.0, plan
        assert plan["achievedInterlinePx"] == round(expected * plan["appliedScale"], 3)
        assert plan["sourceSize"] == [800, 500]
        assert plan["contrastCutoffPercent"] == 1.0
        assert plan["preparedPixels"] <= MODULE.ADAPTIVE_MAX_PIXELS

    huge = staff_image(5, width=2500, height=2000)
    capped = MODULE.adaptive_interline_plan(huge)
    assert capped["pixelCapApplied"] is True
    assert capped["preparedPixels"] <= MODULE.ADAPTIVE_MAX_PIXELS + 10_000

    blank = Image.new("L", (500, 300), 255)
    estimated, _ = MODULE.estimate_staff_interline(blank)
    assert estimated is None

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        source = root / "source.png"
        output = root / "adaptive.png"
        source_image = staff_image(5)
        source_image.putpixel((0, 0), 250)
        source_image.save(source)
        MODULE.preprocess(source, output, "adaptive-interline")
        expected = ImageOps.autocontrast(
            source_image,
            cutoff=MODULE.ADAPTIVE_CONTRAST_CUTOFF_PERCENT,
        ).resize((3200, 2000), Image.Resampling.LANCZOS).convert("RGB")
        assert ImageChops.difference(Image.open(output), expected).getbbox() is None

    from music21 import note, stream

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)

        def write_score(name: str, pitches: list[int]) -> Path:
            score = stream.Score()
            part = stream.Part()
            measure = stream.Measure(number=1)
            for pitch in pitches:
                measure.append(note.Note(pitch, quarterLength=1.0))
            part.append(measure)
            score.append(part)
            path = root / f"{name}.musicxml"
            score.write("musicxml", fp=str(path))
            return path

        gold = write_score("gold", [60, 62, 64])
        baseline = write_score("baseline", [60, 62, 64])
        adaptive = write_score("adaptive", [60, 65, 64])
        comparison = ADAPTIVE.independent_gold_comparison(
            gold,
            [baseline],
            [adaptive],
        )
        assert comparison["baselineUp2"]["pitchPrecision"] == 1.0
        assert comparison["adaptiveInterline"]["pitchPrecision"] < 1.0
        assert comparison["adaptiveMinusBaseline"]["pitchF1"] < 0.0
    print("western M4 adaptive interline tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
