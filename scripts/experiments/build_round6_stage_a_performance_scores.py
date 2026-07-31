"""Rebuild the Round 6 Stage A performer-facing scores.

The original pack marks each target measure with a bare tag such as `★错音`, so a
player still has to hold a second document to know what to actually do. This
rebuilds the six Stage A PDFs as self-contained performance scores:

  * the target note is coloured red so there is no ambiguity about WHICH note,
  * the tag carries a short action right on the staff,
  * the full instruction list is printed on the score itself.

Read-only with respect to the protocol. `position-truth.json`, `manifest.csv`,
the clean `*.musicxml` scores and the contract are frozen sourceBindings and are
never written here; only `<recordingId>.pdf` is replaced in place, which
`materialsReady` checks by existence, not by hash.

    py -3.11 scripts/experiments/build_round6_stage_a_performance_scores.py
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
from pathlib import Path

from music21 import converter, expressions, style

REPO = Path(__file__).resolve().parents[2]
PACK = REPO / "data" / "private" / "western-strings-round6-counterbalanced"

# Short action shown on the staff. Keyed by the frozen scoreTag so that a new
# tag in the truth file fails loudly instead of silently printing a bare label.
SHORT_ACTION = {
    "★错音": "拉高一个全音，时值不变",
    "○准音A": "按谱准确拉，音准稳住",
    "○准音B": "按谱准确拉，前后连接自然",
    "★漏音": "整个音跳过，不补邻音",
    "○错音非漏": "拉高一个全音，但音要出声",
    "○前音盖住": "前一个音拖长盖住拍点，不跳过",
    "★多拉": "长音内重新起弓一次",
    "○正常换弓": "长音内正常换弓，仍是一个音",
    "○正常揉弦": "长音上正常揉弦，不重起弓",
    "★拖拍": "明显拖长，后面的音往后挤",
    "○自然rubato": "只做很小的自然 rubato",
    "○正常长弓": "拉满，不多不少",
}

MUSESCORE_CANDIDATES = [
    Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe"),
    Path(r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe"),
]


def musescore() -> Path:
    for candidate in MUSESCORE_CANDIDATES:
        if candidate.exists():
            return candidate
    raise SystemExit("MuseScore not found; cannot render PDFs.")


def stage_a_rows() -> list[dict[str, str]]:
    with (PACK / "manifest.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.DictReader(handle) if row["split"] == "calibration"]


def annotate(recording_id: str, row: dict[str, str], events: list[dict]) -> object:
    score = converter.parse(str(REPO / row["scorePath"]))
    part = score.parts[0]

    instruction_lines: list[str] = []
    for event in events:
        tag = event["scoreTag"]
        if tag not in SHORT_ACTION:
            raise SystemExit(f"unknown scoreTag {tag!r}; refuse to print an actionless score.")
        measure = part.measure(event["measure"])
        if measure is None:
            raise SystemExit(f"{recording_id}: measure {event['measure']} missing from the clean score.")

        # Colour the target note and hang the tag under it as a lyric. Lyrics
        # anchor to their own note, so they neither drift into a staircase the
        # way stacked text expressions do, nor overflow the right margin.
        target_offset = float(event.get("beat", 1)) - 1.0
        marked = False
        for candidate in measure.notes:
            if abs(float(candidate.offset) - target_offset) < 1e-6:
                if candidate.pitch.midi != event.get("scoreMidi"):
                    raise SystemExit(
                        f"{recording_id} m{event['measure']}: score note "
                        f"{candidate.pitch.midi} != truth {event.get('scoreMidi')}"
                    )
                candidate.style.color = "red"
                candidate.lyric = tag
                marked = True
                break
        if not marked:
            raise SystemExit(f"{recording_id}: no note at m{event['measure']} beat {event.get('beat')}.")

        instruction_lines.append(f"第 {event['measure']} 小节  {tag}：{SHORT_ACTION[tag]}")

    header = expressions.TextExpression("\n".join([
        f"{recording_id}   演奏者 {row['performerId']} · 设备 {row['deviceId']} · 房间 {row['roomId']}",
        "红色音符 = 要按它下面的标签处理；其余全部照谱正常演奏。",
        "★ = 真错误（要真的做出来）    ○ = 对照（听起来接近，但要拉正确）",
        "整首一次拉完，中间不停不剪辑；关闭手机降噪、美化与自动增益。",
        "",
        *instruction_lines,
    ]))
    header.style.fontSize = 8
    header.style.alignHorizontal = "left"
    first = part.measure(1)
    if first is not None:
        first.insert(0.0, header)
    return score


def main() -> int:
    truth = json.loads((PACK / "position-truth.json").read_text(encoding="utf-8"))
    binary = musescore()
    built: list[str] = []

    for row in stage_a_rows():
        recording_id = row["recordingId"]
        events = truth["recordings"][recording_id]["events"]
        score = annotate(recording_id, row, events)

        marked_xml = PACK / f"{recording_id}-performance.musicxml"
        score.write("musicxml", fp=str(marked_xml))
        pdf_path = PACK / f"{recording_id}.pdf"
        result = subprocess.run(
            [str(binary), "-o", str(pdf_path), str(marked_xml)],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0 or not pdf_path.exists():
            raise SystemExit(f"{recording_id}: MuseScore render failed: {result.stderr[:400]}")
        built.append(recording_id)

    print(json.dumps({
        "ok": True,
        "rebuilt": built,
        "wroteProtocolFiles": False,
        "note": "clean musicxml, manifest, truth and contract untouched",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
