"""Generate the Round 5 targeted-diagnosis capture pack scores.

Produces the 12 frozen recording slots defined by
docs/round5-targeted-diagnosis-capture-pack/capture-plan.mjs
(contract western-round5-targeted-diagnosis-intake-v1):

  * 12 brand-new single-voice violin etudes, never used in Round 4 or in any
    threshold tuning. Calibration (6) and fresh-blind (6) use two disjoint
    melodic templates and 12 distinct tonics, per the blind red line.
  * Each score physically contains every structure the confusion negatives
    need: whole-tone steps, chromatic steps, a NOTATED repeated note, a
    NOTATED slide, a fermata, long bows and a phrase ending.
  * A "-marked" copy with an in-score tag at each of that take's 12 event
    slots, for the performer to read.
  * manifest.csv + position-truth.json with measure/beat/scoreMidi filled in
    BEFORE recording (asPerformed and completeErrorInventory stay open until
    note-by-note review after the take).

This only prepares capture material. It does not tune anything, does not touch
any student runtime switch, and must never be used to retune the already
frozen Round 5 thresholds.
"""
import json
import os

from music21 import expressions, key, metadata, meter, note, spanner, stream, tempo

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "data", "private", "western-strings-round5")

CONTRACT = "western-round5-targeted-diagnosis-intake-v1"
GATES = ["merged_substitution", "missing", "extra", "drag"]

POSITIVE_INSTRUCTIONS = {
    "merged_substitution": "把目标谱音稳定演奏成相邻半音或全音，时值不变。",
    "missing": "完全跳过目标谱音，不用邻音或滑音填补。",
    "extra": "把目标谱音清楚地重复起弓两次，谱面仍只有一个音。",
    "drag": "把目标谱音明显拖长，并压缩或推迟后继音。",
}

NEGATIVE_KINDS = {
    "merged_substitution": ["adjacent-semitone-clean", "adjacent-wholetone-clean"],
    "missing": ["wrong-pitch-control", "neighbor-extension-control", "slide-control", "alignment-gap-control"],
    "extra": ["normal-bow-change", "vibrato-peak", "notated-repeated-note"],
    "drag": ["natural-rubato", "written-fermata-or-tie", "normal-long-bow"],
}

# Concrete performer wording per confusion negative. The contract's generic
# "play normally" is not enough for the pitch/gap controls: those must
# reproduce the acoustic confusion without being the gate's own error.
NEGATIVE_INSTRUCTIONS = {
    "adjacent-semitone-clean":
        "半音级进：按谱准确拉，音准要稳。这是「错音」的负例——不要跑调。",
    "adjacent-wholetone-clean":
        "全音级进：按谱准确拉，音准要稳。这是「错音」的负例——不要跑调。",
    "wrong-pitch-control":
        "错音对照：把这个音清楚地拉成高一个全音的错音，时值不变。它是「漏音」的负例——"
        "音要拉出来、只是拉错，用来证明漏音判据不会把错音误判成漏音。",
    "neighbor-extension-control":
        "邻音延长对照：把它前面那个音拖长、盖住这一拍，这个音自然被吃掉。"
        "它是「漏音」的负例——不要主动跳过，是被前音盖住的。",
    "slide-control":
        "滑音对照：按谱面标记的滑音正常滑过去。它是「漏音」的负例——滑音期间会有对齐缺口，但不是漏音。",
    "alignment-gap-control":
        "普通缺口对照：这一拍完全按谱正常拉，不做任何处理。用来证明普通对齐缺口不会被判成漏音。",
    "normal-bow-change":
        "正常换弓：在这个长音中间正常换一次弓，音高与时值都不变。它是「多拉」的负例——换弓不是多拉一次。",
    "vibrato-peak":
        "揉弦：在这个长音上正常揉弦。它是「多拉」的负例——揉弦的波峰不是第二次起弓。",
    "notated-repeated-note":
        "谱面重复音：谱面本来就写了两个同音，正常各拉一次。它是「多拉」的负例——照谱拉两次是对的。",
    "natural-rubato":
        "自然收句：乐句收尾处自然地稍作呼吸/渐慢，再接下去。它是「拖拍」的负例——这是音乐性，不是拖。",
    "written-fermata-or-tie":
        "延长记号：谱面写了延长记号，按记号自然延长。它是「拖拍」的负例——谱面允许的长不算拖。",
    "normal-long-bow":
        "长弓：这个长音按谱面时值拉满，不多不少。它是「拖拍」的负例。",
}

# Short tag printed ABOVE the note in the engraved score. Kept deliberately
# short: long labels get clipped at the right page margin.
SHORT_TAGS = {
    "merged_substitution": "★错音·拉高全音",
    "missing": "★漏音·整个跳过",
    "extra": "★多拉·连拉两次",
    "drag": "★拖拍·明显拖长",
    "adjacent-semitone-clean": "○半音级进·准确拉",
    "adjacent-wholetone-clean": "○全音级进·准确拉",
    "wrong-pitch-control": "○拉错音·非漏音",
    "neighbor-extension-control": "○前音盖住·非漏音",
    "slide-control": "○照记号滑·非漏音",
    "alignment-gap-control": "○完全正常拉",
    "normal-bow-change": "○正常换弓·非多拉",
    "vibrato-peak": "○正常揉弦·非多拉",
    "notated-repeated-note": "○谱面两音·各拉一次",
    "natural-rubato": "○自然收句·非拖拍",
    "written-fermata-or-tie": "○按延长记号·非拖拍",
    "normal-long-bow": "○长弓拉满·非拖拍",
}

# One-line version printed in the blank lower half of the page.
BRIEF = {
    "merged_substitution": "把这个音稳定拉成高一个全音，时值不变",
    "missing": "完全跳过这个音，不用邻音或滑音填补",
    "extra": "把这个音清楚地重复起弓两次（谱面只有一个音）",
    "drag": "把这个音明显拖长，后继音顺延压缩",
    "adjacent-semitone-clean": "半音级进，按谱准确拉、音准要稳（错音负例）",
    "adjacent-wholetone-clean": "全音级进，按谱准确拉、音准要稳（错音负例）",
    "wrong-pitch-control": "故意拉成高一个全音的错音——音要出来、只是拉错（漏音负例）",
    "neighbor-extension-control": "把前一个音拖长、盖住这一拍（漏音负例）",
    "slide-control": "按谱面滑音记号正常滑过去（漏音负例）",
    "alignment-gap-control": "完全按谱正常拉，不做任何处理（漏音负例）",
    "normal-bow-change": "在这个长音中间正常换一次弓（多拉负例）",
    "vibrato-peak": "在这个长音上正常揉弦（多拉负例）",
    "notated-repeated-note": "谱面本来就是两个同音，各拉一次（多拉负例）",
    "natural-rubato": "乐句收尾自然呼吸/稍渐慢（拖拍负例）",
    "written-fermata-or-tie": "按延长记号自然延长（拖拍负例）",
    "normal-long-bow": "长弓按谱面时值拉满，不多不少（拖拍负例）",
}

# Anchor -> (measure, beat). Every score carries all 16 anchors; each take uses
# the 4 positives plus the 8 negatives its rotation selects.
ANCHORS = {
    "merged_substitution-positive": (5, 1.0),
    "missing-positive": (12, 2.0),
    "extra-positive": (15, 1.0),
    "drag-positive": (17, 1.0),
    "adjacent-wholetone-clean": (2, 1.0),
    "adjacent-semitone-clean": (4, 1.0),
    "wrong-pitch-control": (9, 2.0),
    "neighbor-extension-control": (10, 2.0),
    "slide-control": (8, 1.0),
    "alignment-gap-control": (16, 2.0),
    "normal-bow-change": (13, 1.0),
    "vibrato-peak": (7, 1.0),
    "notated-repeated-note": (6, 4.0),
    "natural-rubato": (14, 3.0),
    "written-fermata-or-tie": (11, 1.0),
    "normal-long-bow": (3, 1.0),
}

# Major-key signature by tonic pitch class.
SHARPS_BY_PC = {0: 0, 1: -5, 2: 2, 3: -3, 4: 4, 5: -1, 6: 6, 7: 1, 8: -4, 9: 3, 10: -2, 11: 5}

# 18-measure skeleton. Lists are scale degrees; "H" prefix = two half notes.
TEMPLATE_A = [
    [0, 1, 2, 3], [4, 3, 2, 1], ["H", 0, 4], None, [2, 3, 4, 5],
    [4, 2, 1, 1], ["H", 5, 2], "SLIDE", [3, 4, 2, 0], [1, 2, 3, 4],
    "FERMATA", [5, 4, 3, 2], ["H", 1, 4], [2, 3, 4, 5], [4, 3, 2, 1],
    [0, 2, 4, 2], ["H", 3, 0], "FINAL",
]
TEMPLATE_B = [
    [4, 3, 2, 1], [1, 0, 3, 4], ["H", 4, 1], None, [5, 4, 3, 2],
    [1, 3, 2, 2], ["H", 0, 3], "SLIDE", [2, 1, 4, 5], [4, 5, 3, 1],
    "FERMATA", [0, 1, 2, 3], ["H", 4, 2], [5, 3, 1, 0], [2, 4, 3, 1],
    [1, 0, 2, 4], ["H", 5, 1], "FINAL",
]

CAL_TONICS = [62, 57, 67, 60, 65, 64]    # D A G C F E
FRESH_TONICS = [59, 58, 63, 68, 66, 61]  # B Bb Eb Ab F# Db
SCALE_STEPS = [0, 2, 4, 5, 7, 9]         # major-scale degrees used by the templates


def event_slots(task_index):
    """Reimplements capture-plan.mjs eventSlots() exactly."""
    slots = []
    for gate in GATES:
        kinds = NEGATIVE_KINDS[gate]
        selected = [kinds[(task_index * 2) % len(kinds)], kinds[(task_index * 2 + 1) % len(kinds)]]
        slots.append({
            "eventId": f"{gate}-positive", "gate": gate, "label": "positive",
            "anchor": f"{gate}-positive", "plannedPerformance": POSITIVE_INSTRUCTIONS[gate],
        })
        for index, kind in enumerate(selected):
            slots.append({
                "eventId": f"{gate}-negative-{index + 1}", "gate": gate,
                "label": "confusion_negative", "confusionKind": kind, "anchor": kind,
                "plannedPerformance": NEGATIVE_INSTRUCTIONS[kind],
            })
    return slots


def build_score(template, tonic, title, tempo_bpm, meter_str="4/4"):
    part = stream.Part()
    slide_pair = []
    for index, spec in enumerate(template):
        measure = stream.Measure(number=index + 1)
        if index == 0:
            measure.insert(0, key.KeySignature(SHARPS_BY_PC[tonic % 12]))
            measure.insert(0, meter.TimeSignature(meter_str))
            measure.insert(0, tempo.MetronomeMark(number=tempo_bpm))
        if spec is None:  # chromatic bar -> semitone steps
            for offset in range(4):
                measure.append(note.Note(midi=tonic + 7 + offset, quarterLength=1.0))
        elif spec == "SLIDE":
            first = note.Note(midi=tonic + 4, quarterLength=2.0)
            second = note.Note(midi=tonic + 11, quarterLength=2.0)
            measure.append(first)
            measure.append(second)
            slide_pair = [first, second]
        elif spec == "FERMATA":
            long_note = note.Note(midi=tonic + 7, quarterLength=4.0)
            long_note.expressions.append(expressions.Fermata())
            measure.append(long_note)
        elif spec == "FINAL":
            measure.append(note.Note(midi=tonic, quarterLength=4.0))
        elif spec[0] == "H":
            for degree in spec[1:]:
                measure.append(note.Note(midi=tonic + SCALE_STEPS[degree], quarterLength=2.0))
        else:
            for degree in spec:
                measure.append(note.Note(midi=tonic + SCALE_STEPS[degree], quarterLength=1.0))
        part.append(measure)
    if len(slide_pair) == 2:
        part.insert(0, spanner.Glissando(slide_pair[0], slide_pair[1]))
    score = stream.Score()
    score.insert(0, part)
    score.insert(0, metadata.Metadata(title=title))
    return score


def find_note(score, measure_number, beat):
    measure = score.parts[0].measure(measure_number)
    if measure is None:
        return None
    for item in measure.notes:
        if abs(float(item.beat) - float(beat)) < 1e-6:
            return item
    return None


def annotate(score, slots):
    part = score.parts[0]
    for slot in slots:
        measure_number, beat = ANCHORS[slot["anchor"]]
        key_name = slot["gate"] if slot["label"] == "positive" else slot["confusionKind"]
        text = expressions.TextExpression(SHORT_TAGS[key_name])
        text.placement = "above"
        part.measure(measure_number).insert(float(beat) - 1.0, text)
    return score


# A4 page so the credit block below can be positioned deterministically.
PAGE_HEIGHT, PAGE_WIDTH, SIDE_MARGIN = 1683.36, 1190.55, 85.0
DEFAULTS_XML = (
    "<scaling><millimeters>7.05</millimeters><tenths>40</tenths></scaling>"
    f"<page-layout><page-height>{PAGE_HEIGHT}</page-height><page-width>{PAGE_WIDTH}</page-width>"
    "<page-margins type=\"both\"><left-margin>85</left-margin><right-margin>85</right-margin>"
    "<top-margin>85</top-margin><bottom-margin>85</bottom-margin></page-margins></page-layout>"
)


def inject_credits(xml_path, title_text, body_lines):
    """Title at the top, playing instructions in the blank lower half of page 1.

    MusicXML credit coordinates run from the bottom-left of the page. The whole
    instruction block must be ONE credit with embedded newlines: MuseScore
    collapses many separate credits onto a single line regardless of default-y.
    """
    import xml.etree.ElementTree as ET

    tree = ET.parse(xml_path)
    root = tree.getroot()

    defaults = root.find("defaults")
    if defaults is None:
        defaults = ET.Element("defaults")
        root.insert(0, defaults)
    for child in ET.fromstring(f"<d>{DEFAULTS_XML}</d>"):
        if defaults.find(child.tag) is None:
            defaults.append(child)

    insert_at = list(root).index(root.find("part-list"))

    title = ET.Element("credit", {"page": "1"})
    ET.SubElement(title, "credit-type").text = "title"
    title_words = ET.SubElement(title, "credit-words", {
        "default-x": f"{PAGE_WIDTH / 2:.2f}", "default-y": "1560",
        "justify": "center", "valign": "top", "font-size": "18",
    })
    title_words.text = title_text
    root.insert(insert_at, title)

    block = ET.Element("credit", {"page": "1"})
    block_words = ET.SubElement(block, "credit-words", {
        "default-x": str(SIDE_MARGIN), "default-y": "660",
        "justify": "left", "valign": "top", "font-size": "8",
    })
    block_words.text = "\n".join(body_lines)
    root.insert(insert_at + 1, block)

    with open(xml_path, "w", encoding="utf-8") as handle:
        handle.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        handle.write(ET.tostring(root, encoding="unicode"))


def render_pdf(xml_path, pdf_path):
    import subprocess
    for candidate in (r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe",
                      r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe"):
        if os.path.exists(candidate):
            result = subprocess.run([candidate, "-o", pdf_path, xml_path],
                                    capture_output=True, timeout=300)
            return os.path.exists(pdf_path), result.returncode
    return False, -1


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest_rows = []
    truth_recordings = {}
    readme_sections = []

    for task_index in range(12):
        fresh = task_index >= 6
        local = task_index % 6
        slug = "fresh" if fresh else "cal"
        recording_id = f"r5-{slug}-{local + 1:02d}"
        template = TEMPLATE_B if fresh else TEMPLATE_A
        tonic = (FRESH_TONICS if fresh else CAL_TONICS)[local]
        tempo_bpm = 72 + (local * 4)
        title = f"{recording_id} Round5 targeted etude"

        score = build_score(template, tonic, title, tempo_bpm)
        slots = event_slots(task_index)

        events = []
        for slot in slots:
            measure_number, beat = ANCHORS[slot["anchor"]]
            target = find_note(score, measure_number, beat)
            if target is None:
                raise SystemExit(f"{recording_id}: anchor {slot['anchor']} -> m{measure_number} b{beat} has no note")
            events.append({
                "eventId": slot["eventId"], "gate": slot["gate"], "label": slot["label"],
                "measure": measure_number, "beat": beat, "scoreMidi": int(target.pitch.midi),
                "asPerformed": "",
                **({"confusionKind": slot["confusionKind"]} if "confusionKind" in slot else {}),
                "plannedPerformance": slot["plannedPerformance"],
            })
        if len({(e["measure"], e["beat"]) for e in events}) != 12:
            raise SystemExit(f"{recording_id}: expected 12 distinct positions")

        row = {
            "recordingId": recording_id, "pieceId": f"{recording_id}-etude",
            "performerId": f"performer-{(local % 2) + 1}",
            "deviceId": f"device-{(local // 2) + 1}",
            "roomId": "room-2" if fresh else "room-1",
            "split": "fresh-blind" if fresh else "calibration",
            "audioPath": f"data/private/western-strings-round5/{recording_id}.wav",
            "scorePath": f"data/private/western-strings-round5/{recording_id}.musicxml",
            "consent": "yes", "licenseStatus": "local-only",
        }
        manifest_rows.append(row)
        truth_recordings[recording_id] = {"completeErrorInventory": False, "events": events}

        score.write("musicxml", fp=os.path.join(OUT, f"{recording_id}.musicxml"))
        marked_path = os.path.join(OUT, f"{recording_id}-marked.musicxml")
        annotate(build_score(template, tonic, title, tempo_bpm), slots).write("musicxml", fp=marked_path)

        credit_lines = [
            f"{recording_id}  ·  {row['split']}  ·  {row['performerId']} / {row['deviceId']} / "
            f"{row['roomId']}  ·  {tempo_bpm} bpm",
            "★ = 故意制造该错误    ○ = 混淆负例，要拉得「像但不是」    录完不要回头调阈值",
        ]
        for event in events:
            mark = "★" if event["label"] == "positive" else "○"
            key_name = event["gate"] if event["label"] == "positive" else event["confusionKind"]
            credit_lines.append(
                f"{mark}  m{event['measure']} b{event['beat']:g}  ({event['scoreMidi']})   {BRIEF[key_name]}")
        inject_credits(marked_path, f"{recording_id}  Round 5 定向诊断练习曲", credit_lines)
        pdf_ok, _ = render_pdf(marked_path, os.path.join(OUT, f"{recording_id}.pdf"))
        if not pdf_ok:
            raise SystemExit(f"{recording_id}: PDF render failed")

        lines = [
            f"### {recording_id}（{row['split']}）", "",
            f"- 演奏者 **{row['performerId']}** / 设备 **{row['deviceId']}** / 房间 **{row['roomId']}**",
            f"- 谱子 `{recording_id}.musicxml`；**照着标注版 `{recording_id}-marked.musicxml` 拉**（MuseScore 打开）",
            f"- {tempo_bpm} bpm，18 小节，单声部第一把位",
            "", "| 槽位 | 小节/拍 | 谱面音(midi) | 怎么拉 |", "|---|---|---|---|",
        ]
        for event in events:
            tag = "★" if event["label"] == "positive" else "○"
            lines.append(
                f"| {tag} `{event['eventId']}` | m{event['measure']} b{event['beat']:g} "
                f"| {event['scoreMidi']} | {event['plannedPerformance']} |")
        lines.append("")
        readme_sections.append("\n".join(lines))

    fields = ["recordingId", "pieceId", "performerId", "deviceId", "roomId", "split",
              "audioPath", "scorePath", "consent", "licenseStatus"]
    with open(os.path.join(OUT, "manifest.csv"), "w", encoding="utf-8") as handle:
        handle.write(",".join(fields) + "\n")
        for row in manifest_rows:
            handle.write(",".join(str(row[f]) for f in fields) + "\n")

    with open(os.path.join(OUT, "position-truth.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "contractVersion": CONTRACT,
            "recordingRequirements": {
                "completeErrorInventory": True,
                "meaning": "Every performed error in this recording has been position-labelled; "
                           "unlisted score positions are ordinary-correct.",
            },
            "recordings": truth_recordings,
        }, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    readme = [
        "# Round 5 定向诊断录制说明（12 条）", "",
        f"合同：`{CONTRACT}`。**谱子与位置已在录音前登记冻结**（盲测红线）。", "",
        "## 录之前必须知道的三条", "",
        "1. **不要改谱、不要换曲**。12 首已分成 calibration / fresh-blind 两组互不重叠的材料。",
        "2. **★正例 = 故意制造那个错误；○负例 = 要拉得「像但不是」**，严格按表里的说明。",
        "3. **录完不许回头调阈值**。这轮是验收已冻结的判据，看了结果再调这批就白录了。", "",
        "## 流程", "",
        "1. 用 MuseScore 打开 `*-marked.musicxml`，谱面上每个槽位都标了 `★正例/○负例 + 槽位名`。",
        "2. 按表录**无损 WAV** → `data/private/western-strings-round5/<recordingId>.wav`。",
        "   同一遍演奏**不可**复制成多个设备样本，必须真的换设备/房间重录。",
        "3. 逐条试听，把 `position-truth.json` 里每个事件的 `asPerformed` 填上实际结果；",
        "   **出现计划外的错误也必须新增事件**（完整错误清单原则）。",
        "4. 全部复核完，才把该条的 `completeErrorInventory` 改成 `true`。",
        "5. 跑 `npm run western:round5-targeted-intake`，通过后再跑 `npm run western:round5-segment-edit-path`。", "",
        "## 谱面内置结构（负例靠它们成立）", "",
        "| 小节 | 结构 | 服务的负例 |", "|---|---|---|",
        "| m2 | 全音级进 | adjacent-wholetone-clean |",
        "| m3 / m13 | 长弓（二分音符） | normal-long-bow / normal-bow-change |",
        "| m4 | 半音级进（半音阶） | adjacent-semitone-clean |",
        "| m6 | **谱面重复音**（b3=b4 同音） | notated-repeated-note |",
        "| m7 | 长音（适合揉弦） | vibrato-peak |",
        "| m8 | **记谱滑音 gliss** | slide-control |",
        "| m11 | **延长记号 fermata** | written-fermata-or-tie |",
        "| m14 | 乐句收尾 | natural-rubato |", "", "---", "",
    ]
    readme.extend(readme_sections)
    with open(os.path.join(OUT, "README-round5-录制说明.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(readme))

    print(f"12 scores + marked copies -> {OUT}")
    print("manifest.csv / position-truth.json / README-round5-录制说明.md written")


if __name__ == "__main__":
    main()
