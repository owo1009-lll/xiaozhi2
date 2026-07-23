#!/usr/bin/env python3
"""Generate a score-position-counterbalanced Round 6 capture candidate.

Every score is recorded three times.  For each diagnosis gate, the same three
score positions rotate through positive, confusion-negative A, and
confusion-negative B roles.  Static score context therefore cannot identify
the planned label.  This script creates pre-recording material only.
"""
from __future__ import annotations

import argparse
import copy
import csv
import json
import subprocess
from pathlib import Path
from typing import Any

from music21 import expressions, key, metadata, meter, note, stream, tempo

REPO = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO / "config/western-strings-round6-counterbalanced-contract.json"
DEFAULT_OUT = REPO / "data/private/western-strings-round6-counterbalanced"
GATES = ("merged_substitution", "missing", "extra", "drag")
ANCHORS = {
    "merged_substitution": (2, 3, 4),
    "missing": (5, 6, 7),
    "extra": (8, 9, 10),
    "drag": (11, 12, 13),
}
INSTRUCTIONS = {
    "merged_substitution": {
        "positive": "把目标音稳定拉成高一个全音，时值不变。",
        "negativeA": "按谱准确拉目标音，保持音准稳定。",
        "negativeB": "按谱准确拉目标音，并正常连接前后音。",
        "kindA": "accurate-pitch-control",
        "kindB": "ordinary-step-control",
        "tagPositive": "★错音",
        "tagA": "○准音A",
        "tagB": "○准音B",
    },
    "missing": {
        "positive": "完全跳过目标音，不用邻音或滑音填补。",
        "negativeA": "把目标音拉成高一个全音；音要出现，只是音高错误。",
        "negativeB": "把前一个音拖长并盖住目标拍点，不主动跳过目标音。",
        "kindA": "wrong-pitch-control",
        "kindB": "neighbor-extension-control",
        "tagPositive": "★漏音",
        "tagA": "○错音非漏",
        "tagB": "○前音盖住",
    },
    "extra": {
        "positive": "在目标长音内清楚地重新起弓一次，形成谱外第二次发音。",
        "negativeA": "在目标长音内正常换弓，保持一个连续谱音。",
        "negativeB": "在目标长音上正常揉弦，不重新起弓。",
        "kindA": "normal-bow-change",
        "kindB": "vibrato-peak",
        "tagPositive": "★多拉",
        "tagA": "○正常换弓",
        "tagB": "○正常揉弦",
    },
    "drag": {
        "positive": "把目标长音明显拖长，并压缩或推迟后继音。",
        "negativeA": "目标长音只作自然微小 rubato，不超出正常乐句处理。",
        "negativeB": "按谱把目标长音拉满，不多不少。",
        "kindA": "natural-rubato",
        "kindB": "normal-long-bow",
        "tagPositive": "★拖拍",
        "tagA": "○自然rubato",
        "tagB": "○正常长弓",
    },
}
SCORE_SPECS = (
    ("calibration", "cal-a", 62, (0, 2, 5, 4), 80),
    ("calibration", "cal-b", 65, (0, 3, 5, 4), 88),
    ("fresh-blind", "fresh-a", 67, (0, 2, 4, 5), 84),
    ("fresh-blind", "fresh-b", 59, (0, 1, 5, 4), 92),
)


def manifest_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO).as_posix()
    except ValueError:
        return str(path.resolve())


def build_score(
    *,
    tonic: int,
    quarter_pattern: tuple[int, int, int, int],
    title: str,
    tempo_bpm: int,
) -> stream.Score:
    part = stream.Part()
    for measure_number in range(1, 19):
        measure = stream.Measure(number=measure_number)
        if measure_number == 1:
            measure.insert(0, key.KeySignature(0))
            measure.insert(0, meter.TimeSignature("4/4"))
            measure.insert(0, tempo.MetronomeMark(number=tempo_bpm))
        if 8 <= measure_number <= 13:
            measure.append(note.Note(midi=tonic + 7, quarterLength=2.0))
            measure.append(note.Note(midi=tonic + 4, quarterLength=2.0))
        else:
            for interval in quarter_pattern:
                measure.append(note.Note(midi=tonic + interval, quarterLength=1.0))
        part.append(measure)
    score = stream.Score()
    score.insert(0, part)
    score.insert(0, metadata.Metadata(title=title))
    return score


def anchor_note(score: stream.Score, measure_number: int) -> note.Note:
    measure = score.parts[0].measure(measure_number)
    matches = [
        item for item in measure.notes
        if abs(float(item.beat) - 1.0) <= 1e-6
    ]
    if len(matches) != 1:
        raise RuntimeError(f"round6-anchor-not-unique:{measure_number}")
    return matches[0]


def rotated_events(score: stream.Score, rotation: int) -> list[dict[str, Any]]:
    events = []
    for gate in GATES:
        measures = ANCHORS[gate]
        roles = {
            measures[rotation]: "positive",
            measures[(rotation + 1) % 3]: "negativeA",
            measures[(rotation + 2) % 3]: "negativeB",
        }
        instruction = INSTRUCTIONS[gate]
        for measure_number in measures:
            role = roles[measure_number]
            target = anchor_note(score, measure_number)
            positive = role == "positive"
            event = {
                "eventId": f"{gate}-m{measure_number}",
                "gate": gate,
                "label": "positive" if positive else "confusion_negative",
                "measure": measure_number,
                "beat": 1.0,
                "scoreMidi": int(target.pitch.midi),
                "plannedPerformance": instruction[role],
                "scoreTag": instruction[
                    "tagPositive" if positive
                    else "tagA" if role == "negativeA"
                    else "tagB"
                ],
                "asPerformed": "",
            }
            if not positive:
                event["confusionKind"] = instruction[
                    "kindA" if role == "negativeA" else "kindB"
                ]
            events.append(event)
    return events


def annotate_score(score: stream.Score, events: list[dict[str, Any]]) -> stream.Score:
    marked = copy.deepcopy(score)
    for event in events:
        label = expressions.TextExpression(event["scoreTag"])
        label.placement = "above"
        marked.parts[0].measure(event["measure"]).insert(0.0, label)
    return marked


def write_recording_instructions(
    path: Path,
    recording_id: str,
    events: list[dict[str, Any]],
) -> None:
    lines = [
        f"# {recording_id} 演奏说明",
        "",
        "必须从头到尾完整演奏；只在下列 12 个位置按说明处理，其余位置按谱正常演奏。",
        "",
        "| 小节 | 谱面标签 | 操作 |",
        "|---:|---|---|",
    ]
    for event in sorted(events, key=lambda item: item["measure"]):
        lines.append(
            f"| {event['measure']} | {event['scoreTag']} | "
            f"{event['plannedPerformance']} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def render_pdf(xml_path: Path, pdf_path: Path) -> bool:
    candidates = (
        Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe"),
        Path(r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe"),
    )
    executable = next((path for path in candidates if path.exists()), None)
    if executable is None:
        return False
    result = subprocess.run(
        [str(executable), "-o", str(pdf_path), str(xml_path)],
        capture_output=True,
        timeout=300,
        check=False,
    )
    return result.returncode == 0 and pdf_path.exists()


def write_manifest(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = [
        "recordingId",
        "pieceId",
        "performerId",
        "deviceId",
        "roomId",
        "split",
        "audioPath",
        "scorePath",
        "consent",
        "licenseStatus",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def generate(out: Path, *, with_pdf: bool) -> dict[str, Any]:
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    manifest_rows = []
    truth_recordings = {}
    rendered_pdfs = 0

    for split, score_name, tonic, pattern, tempo_bpm in SCORE_SPECS:
        score = build_score(
            tonic=tonic,
            quarter_pattern=pattern,
            title=f"Round 6 counterbalanced {score_name}",
            tempo_bpm=tempo_bpm,
        )
        clean_xml = out / f"r6-{score_name}.musicxml"
        score.write("musicxml", fp=str(clean_xml))
        split_prefix = "cal" if split == "calibration" else "fresh"
        score_group = 0 if score_name.endswith("a") else 1
        for rotation in range(3):
            recording_id = f"r6-{score_name}-{rotation + 1:02d}"
            events = rotated_events(score, rotation)
            marked_xml = out / f"{recording_id}-marked.musicxml"
            annotate_score(score, events).write("musicxml", fp=str(marked_xml))
            write_recording_instructions(
                out / f"{recording_id}-演奏说明.md",
                recording_id,
                events,
            )
            if with_pdf and render_pdf(marked_xml, out / f"{recording_id}.pdf"):
                rendered_pdfs += 1
            performer = f"{split_prefix}-performer-{rotation + 1}"
            room = f"{split_prefix}-room-{score_group + 1}"
            manifest_rows.append({
                "recordingId": recording_id,
                "pieceId": f"r6-{score_name}-etude",
                "performerId": performer,
                "deviceId": f"device-{rotation + 1}",
                "roomId": room,
                "split": split,
                "audioPath": manifest_path(out / f"{recording_id}.m4a"),
                "scorePath": manifest_path(clean_xml),
                "consent": "pending",
                "licenseStatus": "local-private-pending",
            })
            truth_recordings[recording_id] = {
                "completeErrorInventory": False,
                "events": events,
            }

    manifest = out / "manifest.csv"
    truth = out / "position-truth.json"
    write_manifest(manifest, manifest_rows)
    truth.write_text(
        json.dumps({
            "contractVersion": contract["contractVersion"],
            "recordingRequirements": {
                "completeErrorInventory": True,
                "meaning": (
                    "After recording, every performed error must be signed; "
                    "unlisted score positions are ordinary-correct."
                ),
            },
            "recordings": truth_recordings,
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    readme = out / "README-round6-录制说明.md"
    readme.write_text(
        "# Round 6 反向配平录制包\n\n"
        "状态：待录音、待逐条签署。每份 clean MusicXML 对应三次录音；同一目标位置"
        "会轮换为正例和两类混淆负例。禁止改变事件位置或只录其中一个 rotation。\n\n"
        "录音前必须运行：\n\n"
        "```powershell\n"
        "npm run western:round6-position-balance\n"
        "```\n\n"
        "录音后填写 `asPerformed`、把 `completeErrorInventory` 改为 true，并补齐"
        " consent/licenseStatus；fresh-blind 只能执行一次。\n",
        encoding="utf-8",
    )
    return {
        "contract": contract["contractVersion"],
        "out": manifest_path(out),
        "recordings": len(manifest_rows),
        "scores": len(SCORE_SPECS),
        "renderedPdfs": rendered_pdfs,
        "manifest": manifest_path(manifest),
        "truth": manifest_path(truth),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--no-pdf", action="store_true")
    args = parser.parse_args()
    result = generate(args.out.resolve(), with_pdf=not args.no_pdf)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
