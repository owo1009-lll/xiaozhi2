from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from pathlib import Path

from sihsm_posterior import midi_hz, timing_weight

TARGET_NAMES = ("二胡", "erhu", "京胡", "jinghu", "板胡", "banhu", "高胡", "gaohu")
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


@dataclass
class Note:
    onset: float
    duration: float
    midi: int
    note_id: str
    part: str = ""

    @property
    def freq(self) -> float:
        return midi_hz(self.midi)


def _tag(node: ET.Element) -> str:
    return node.tag.rsplit("}", 1)[-1]


def _text(node: ET.Element, name: str, default: str = "") -> str:
    for child in node:
        if _tag(child) == name:
            return (child.text or default).strip()
    return default


def _child(node: ET.Element, name: str) -> ET.Element | None:
    return next((child for child in node if _tag(child) == name), None)


def _midi(note: ET.Element) -> int | None:
    pitch = _child(note, "pitch")
    if pitch is None:
        return None
    step = _text(pitch, "step")
    octave = _text(pitch, "octave")
    if step not in STEP or not octave:
        return None
    alter = int(float(_text(pitch, "alter", "0") or 0))
    return (int(octave) + 1) * 12 + STEP[step] + alter


def _tempo(root: ET.Element) -> float:
    for node in root.iter():
        if _tag(node) == "sound" and node.get("tempo"):
            return float(node.get("tempo") or 120.0)
    return 120.0


def _part_names(root: ET.Element) -> dict[str, str]:
    out = {}
    for node in root.iter():
        if _tag(node) == "score-part":
            out[node.get("id", "")] = _text(node, "part-name")
    return out


def _pick_part(root: ET.Element, target_part: str | None) -> ET.Element:
    names = _part_names(root)
    parts = [node for node in root.iter() if _tag(node) == "part"]
    if target_part:
        key = target_part.lower()
        for part in parts:
            name = names.get(part.get("id", ""), "")
            if key in part.get("id", "").lower() or key in name.lower():
                return part
    for part in parts:
        name = names.get(part.get("id", ""), "").lower()
        if any(label in name for label in TARGET_NAMES):
            return part
    if not parts:
        raise ValueError("MusicXML has no part")
    return parts[0]


def read_notes(path: str | Path, target_part: str | None = None) -> list[Note]:
    path = Path(path)
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data.get("notes", data if isinstance(data, list) else [])
        return [Note(float(r["onset"]), float(r["duration"]), int(r["midi"]), str(r.get("noteId", i))) for i, r in enumerate(rows)]

    root = ET.parse(path).getroot()
    tempo = _tempo(root)
    q_to_s = 60.0 / max(tempo, 1e-6)
    part = _pick_part(root, target_part)
    divisions, qpos, notes = 1.0, 0.0, []
    for measure in [n for n in part if _tag(n) == "measure"]:
        attrs = _child(measure, "attributes")
        if attrs is not None:
            divisions = float(_text(attrs, "divisions", str(divisions)) or divisions)
        note_i = 0
        for node in [n for n in measure if _tag(n) == "note"]:
            dur_q = float(_text(node, "duration", "0") or 0) / max(divisions, 1e-6)
            midi = _midi(node)
            is_chord = _child(node, "chord") is not None
            if midi is not None and _child(node, "rest") is None:
                note_i += 1
                notes.append(Note(qpos * q_to_s, dur_q * q_to_s, midi, f"m{measure.get('number', '?')}-n{note_i}", part.get("id", "")))
            if not is_chord:
                qpos += dur_q
    return notes


def notes_as_dicts(notes: list[Note]) -> list[dict]:
    return [asdict(note) | {"freq": note.freq} for note in notes]


def score_at_frames(notes: list[Note], frames: list[float], audio_duration: float, tolerance: float = 2.0) -> list[dict]:
    if not notes:
        return [{"freq": 0.0, "timing": 0.0, "note_id": ""} for _ in frames]
    score_end = max(note.onset + note.duration for note in notes)
    scale = audio_duration / score_end if audio_duration > 0 and score_end > 0 else 1.0
    rows = []
    for frame in frames:
        best, best_gap = None, 1e9
        for note in notes:
            start, end = note.onset * scale, (note.onset + note.duration) * scale
            gap = 0.0 if start <= frame <= end else min(abs(frame - start), abs(frame - end))
            if gap < best_gap:
                best, best_gap = note, gap
        active = best is not None and best_gap <= tolerance
        rows.append({"freq": best.freq if active else 0.0, "timing": timing_weight(best_gap, tolerance) if active else 0.0, "note_id": best.note_id if active else ""})
    return rows
