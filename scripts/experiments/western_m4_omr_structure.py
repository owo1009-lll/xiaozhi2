#!/usr/bin/env python3
"""Read Audiveris structural evidence without trusting exported notation blindly.

The module is intentionally conservative.  It uses both the raw ``.omr`` graph
and exported MusicXML, and reports separate clef, key, and meter evidence.  A
missing symbol is not silently converted into a default.
"""

from __future__ import annotations

import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _score(element: ET.Element) -> float | None:
    for key in ("ctx-grade", "grade"):
        raw = element.attrib.get(key)
        if raw is None:
            continue
        try:
            return float(raw)
        except ValueError:
            continue
    return None


def _bounds(element: ET.Element) -> dict[str, int] | None:
    value = next(
        (child for child in list(element) if local_name(str(child.tag)) == "bounds"),
        None,
    )
    if value is None:
        return None
    try:
        return {key: int(round(float(value.attrib[key]))) for key in ("x", "y", "w", "h")}
    except (KeyError, ValueError):
        return None


def _read_omr_roots(path: Path) -> list[ET.Element]:
    if not zipfile.is_zipfile(path):
        raise ValueError(f"not-an-omr-archive:{path}")
    with zipfile.ZipFile(path) as archive:
        members = sorted(
            name
            for name in archive.namelist()
            if "/sheet#" in name and name.lower().endswith(".xml")
        )
        if not members:
            raise ValueError(f"omr-sheet-xml-missing:{path}")
        return [ET.fromstring(archive.read(name)) for name in members]


def _read_musicxml_root(path: Path) -> ET.Element:
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            members = sorted(
                name
                for name in archive.namelist()
                if name.lower().endswith((".xml", ".musicxml"))
                and not name.startswith("META-INF/")
            )
            if not members:
                raise ValueError(f"musicxml-member-missing:{path}")
            return ET.fromstring(archive.read(members[0]))
    return ET.fromstring(path.read_bytes())


def _best_part(root: ET.Element) -> ET.Element | None:
    parts = [element for element in root.iter() if local_name(str(element.tag)) == "part"]
    if not parts:
        return None
    return max(
        parts,
        key=lambda part: sum(
            1
            for note in part.iter()
            if local_name(str(note.tag)) == "note"
            and not any(local_name(str(child.tag)) == "rest" for child in list(note))
        ),
    )


def _child_text(element: ET.Element, name: str) -> str:
    child = next(
        (item for item in list(element) if local_name(str(item.tag)) == name),
        None,
    )
    return (child.text or "").strip() if child is not None else ""


_STEP_TO_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _note_midi(note: ET.Element) -> int | None:
    pitch = next(
        (item for item in list(note) if local_name(str(item.tag)) == "pitch"),
        None,
    )
    if pitch is None:
        return None
    step = _child_text(pitch, "step")
    try:
        octave = int(_child_text(pitch, "octave"))
        alter = int(float(_child_text(pitch, "alter") or "0"))
    except ValueError:
        return None
    if step not in _STEP_TO_SEMITONE:
        return None
    return 12 * (octave + 1) + _STEP_TO_SEMITONE[step] + alter


def _duration_quarters(element: ET.Element, divisions: int) -> float:
    try:
        return float(_child_text(element, "duration")) / max(1, divisions)
    except ValueError:
        return 0.0


def _measure_duration_quarters(measure: ET.Element, divisions: int) -> tuple[float, int]:
    """Return the furthest notated time in a measure and the active divisions."""
    cursor = 0.0
    furthest = 0.0
    last_note_start = 0.0
    active_divisions = divisions
    for element in list(measure):
        tag = local_name(str(element.tag))
        if tag == "attributes":
            raw_divisions = _child_text(element, "divisions")
            try:
                active_divisions = max(1, int(raw_divisions))
            except ValueError:
                pass
        elif tag == "note":
            duration = _duration_quarters(element, active_divisions)
            is_chord = any(local_name(str(child.tag)) == "chord" for child in list(element))
            if is_chord:
                furthest = max(furthest, last_note_start + duration)
            else:
                last_note_start = cursor
                cursor += duration
                furthest = max(furthest, cursor)
        elif tag == "backup":
            cursor = max(0.0, cursor - _duration_quarters(element, active_divisions))
        elif tag == "forward":
            cursor += _duration_quarters(element, active_divisions)
            furthest = max(furthest, cursor)
    return furthest, active_divisions


def extract_raw_structure(roots: Iterable[ET.Element]) -> dict[str, Any]:
    staffs: list[str] = []
    clefs: list[dict[str, Any]] = []
    keys: list[dict[str, Any]] = []
    time_numbers: list[dict[str, Any]] = []
    direct_meters: list[dict[str, Any]] = []
    repeats: list[dict[str, Any]] = []
    coordinate_symbols: list[dict[str, Any]] = []
    for page_index, root in enumerate(roots, 1):
        for element in root.iter():
            tag = local_name(str(element.tag))
            if tag == "staff" and element.attrib.get("id"):
                staffs.append(f"{page_index}:{element.attrib['id']}")
            elif tag == "clef" and element.attrib.get("shape"):
                clefs.append(
                    {
                        "page": page_index,
                        "staff": element.attrib.get("staff"),
                        "kind": element.attrib.get("kind"),
                        "shape": element.attrib.get("shape"),
                        "score": _score(element),
                        "bounds": _bounds(element),
                    }
                )
            elif tag == "key" and (
                element.attrib.get("fifths") not in (None, "")
                or element.attrib.get("shape") == "KEY_CANCEL"
            ):
                fifths = element.attrib.get("fifths")
                if fifths in (None, "") and element.attrib.get("shape") == "KEY_CANCEL":
                    fifths = "0"
                keys.append(
                    {
                        "page": page_index,
                        "staff": element.attrib.get("staff"),
                        "shape": element.attrib.get("shape"),
                        "fifths": int(fifths) if fifths not in (None, "") else None,
                        "score": _score(element),
                        "bounds": _bounds(element),
                    }
                )
            elif tag in {"time-whole", "time-pair"} and element.attrib.get("time-rational"):
                rational = str(element.attrib["time-rational"])
                try:
                    beats_raw, beat_type_raw = rational.split("/", 1)
                    beats = int(beats_raw)
                    beat_type = int(beat_type_raw)
                except (TypeError, ValueError):
                    continue
                direct_meters.append(
                    {
                        "page": page_index,
                        "staff": element.attrib.get("staff"),
                        "beats": beats,
                        "beatType": beat_type,
                        "score": _score(element),
                    }
                )
            elif tag == "time-number" and element.attrib.get("shape"):
                raw_value = element.attrib.get("value")
                time_numbers.append(
                    {
                        "page": page_index,
                        "staff": element.attrib.get("staff"),
                        "side": element.attrib.get("side"),
                        "value": int(raw_value) if str(raw_value or "").isdigit() else None,
                        "shape": element.attrib.get("shape"),
                        "score": _score(element),
                        "bounds": _bounds(element),
                    }
                )
            elif "REPEAT" in str(element.attrib.get("shape") or "") or tag in {
                "repeat-dot-pair",
                "ending",
            }:
                repeats.append(
                    {
                        "page": page_index,
                        "tag": tag,
                        "shape": element.attrib.get("shape", ""),
                        "score": _score(element),
                    }
                )
            if tag in {"head", "alter", "ledger", "clef"} and element.attrib.get("id"):
                bounds = _bounds(element)
                if bounds:
                    coordinate_symbols.append(
                        {
                            "page": page_index,
                            "staff": element.attrib.get("staff"),
                            "id": element.attrib.get("id"),
                            "tag": tag,
                            "shape": element.attrib.get("shape", ""),
                            "score": _score(element),
                            "bounds": bounds,
                        }
                    )
    meters: list[dict[str, Any]] = list(direct_meters)
    grouped: dict[tuple[int, str | None], dict[str, dict[str, Any]]] = {}
    for item in time_numbers:
        grouped.setdefault((item["page"], item["staff"]), {})[str(item["side"])] = item
    for (page, staff), pair in grouped.items():
        top = pair.get("TOP")
        bottom = pair.get("BOTTOM")
        if top and bottom and top.get("value") and bottom.get("value"):
            candidate = {
                "page": page,
                "staff": staff,
                "beats": top["value"],
                "beatType": bottom["value"],
                "score": min(value for value in (top.get("score"), bottom.get("score")) if value is not None),
            }
            if not any(
                (item["page"], item.get("staff"), item["beats"], item["beatType"])
                == (candidate["page"], candidate.get("staff"), candidate["beats"], candidate["beatType"])
                for item in meters
            ):
                meters.append(candidate)
    return {
        "staffs": staffs,
        "clefs": clefs,
        "keys": keys,
        "meters": meters,
        "repeatSymbols": repeats,
        "coordinateSymbols": coordinate_symbols,
    }


def extract_musicxml_structure(roots: Iterable[ET.Element]) -> dict[str, Any]:
    clefs: list[tuple[str, str]] = []
    keys: list[int] = []
    meters: list[tuple[int, int]] = []
    repeats: list[dict[str, Any]] = []
    midi_values: list[int] = []
    measure_durations: list[dict[str, Any]] = []
    active_divisions = 1
    active_meter: tuple[int, int] | None = None
    for root in roots:
        part = _best_part(root)
        if part is None:
            continue
        measure_index = 0
        for measure in [item for item in list(part) if local_name(str(item.tag)) == "measure"]:
            measure_index += 1
            observed_duration, active_divisions = _measure_duration_quarters(
                measure, active_divisions
            )
            for element in measure.iter():
                tag = local_name(str(element.tag))
                if tag == "clef":
                    clefs.append((_child_text(element, "sign"), _child_text(element, "line")))
                elif tag == "key":
                    fifths = _child_text(element, "fifths")
                    try:
                        keys.append(int(fifths))
                    except ValueError:
                        pass
                elif tag == "time":
                    try:
                        active_meter = (
                            int(_child_text(element, "beats")),
                            int(_child_text(element, "beat-type")),
                        )
                        meters.append(active_meter)
                    except ValueError:
                        pass
                elif tag == "note":
                    midi = _note_midi(element)
                    if midi is not None:
                        midi_values.append(midi)
                elif tag == "repeat":
                    repeats.append(
                        {
                            "measure": measure_index,
                            "type": "repeat",
                            "direction": element.attrib.get("direction", ""),
                            "times": element.attrib.get("times", ""),
                        }
                    )
                elif tag == "ending":
                    repeats.append(
                        {
                            "measure": measure_index,
                            "type": "ending",
                            "number": element.attrib.get("number", ""),
                            "endingType": element.attrib.get("type", ""),
                        }
                    )
                elif tag == "sound":
                    for key in ("dacapo", "dalsegno", "tocoda", "fine", "segno", "coda"):
                        if element.attrib.get(key):
                            repeats.append(
                                {
                                    "measure": measure_index,
                                    "type": key,
                                    "value": element.attrib.get(key),
                                }
                            )
            expected_duration = (
                active_meter[0] * 4.0 / active_meter[1]
                if active_meter and active_meter[1] > 0
                else None
            )
            measure_durations.append(
                {
                    "index": len(measure_durations) + 1,
                    "observedQuarters": observed_duration,
                    "expectedQuarters": expected_duration,
                    "matches": bool(
                        expected_duration is not None
                        and abs(observed_duration - expected_duration) <= 0.125
                    ),
                }
            )

    comparable = [
        item
        for item in measure_durations
        if item["expectedQuarters"] is not None and item["observedQuarters"] > 0
    ]
    adjusted = list(comparable)
    # A short first or last measure can be a legitimate pickup/complement pair.
    # Only these two global boundary measures receive that exception.
    if adjusted and adjusted[0]["observedQuarters"] < adjusted[0]["expectedQuarters"]:
        adjusted = adjusted[1:]
    if adjusted and adjusted[-1]["observedQuarters"] < adjusted[-1]["expectedQuarters"]:
        adjusted = adjusted[:-1]
    meter_consistency = (
        sum(bool(item["matches"]) for item in adjusted) / len(adjusted)
        if adjusted
        else None
    )
    violin_range_count = sum(55 <= midi <= 105 for midi in midi_values)
    return {
        "clefs": clefs,
        "keys": keys,
        "meters": meters,
        "repeatStructure": repeats,
        "pitchMinMidi": min(midi_values) if midi_values else None,
        "pitchMaxMidi": max(midi_values) if midi_values else None,
        "pitchInViolinRangeRate": (
            violin_range_count / len(midi_values) if midi_values else None
        ),
        "noteCount": len(midi_values),
        "measureDurationConsistencyRate": meter_consistency,
        "measureDurationComparableCount": len(adjusted),
        "measureDurationMatchCount": sum(bool(item["matches"]) for item in adjusted),
    }


def evaluate_p0_records(
    raw: dict[str, Any],
    exported: dict[str, Any],
    min_symbol_score: float = 0.8,
    min_violin_range_rate: float = 0.95,
    min_meter_consistency_rate: float = 0.9,
) -> dict[str, Any]:
    reasons: list[str] = []
    staff_ids = set(raw.get("staffs") or [])
    raw_clefs = list(raw.get("clefs") or [])
    covered_staffs = {
        f"{item.get('page')}:{item.get('staff')}"
        for item in raw_clefs
        if item.get("staff") is not None
    }
    clef_scores = [item.get("score") for item in raw_clefs]
    clef_semantics_ok = bool(raw_clefs) and all(item.get("kind") == "TREBLE" for item in raw_clefs)
    clef_score_ok = bool(clef_scores) and all(
        score is not None and score >= min_symbol_score for score in clef_scores
    )
    exported_clefs = list(exported.get("clefs") or [])
    exported_clef_ok = bool(exported_clefs) and all(value == ("G", "2") for value in exported_clefs)
    clef_explicit_ready = bool(
        staff_ids
        and covered_staffs == staff_ids
        and clef_semantics_ok
        and clef_score_ok
        and exported_clef_ok
    )
    violin_range_rate = exported.get("pitchInViolinRangeRate")
    clef_structural_ready = bool(
        staff_ids
        and covered_staffs == staff_ids
        and clef_semantics_ok
        and exported_clef_ok
        and isinstance(violin_range_rate, (int, float))
        and violin_range_rate >= min_violin_range_rate
    )
    clef_conflict = bool(
        (raw_clefs and not clef_semantics_ok)
        or (exported_clefs and not exported_clef_ok)
    )
    clef_ready = bool(not clef_conflict and (clef_explicit_ready or clef_structural_ready))
    if not clef_ready:
        if covered_staffs != staff_ids:
            reasons.append("clef-line-start-coverage-missing")
        if clef_conflict:
            reasons.append("clef-conflict-or-unsupported")
        if not clef_score_ok and not clef_structural_ready:
            reasons.append("clef-confidence-insufficient")
        if not clef_explicit_ready and not clef_structural_ready:
            reasons.append("clef-structural-evidence-insufficient")

    raw_keys = list(raw.get("keys") or [])
    exported_keys = list(exported.get("keys") or [])
    explicit_key_scores = [item.get("score") for item in raw_keys]
    key_score_ok = bool(explicit_key_scores) and all(
        score is not None and score >= min_symbol_score for score in explicit_key_scores
    )
    raw_key_values = [item.get("fifths") for item in raw_keys if item.get("fifths") is not None]
    raw_key_sequence = list(dict.fromkeys(raw_key_values))
    exported_key_values = list(dict.fromkeys(exported_keys))
    key_covered_staffs = {
        f"{item.get('page')}:{item.get('staff')}"
        for item in raw_keys
        if item.get("staff") is not None and item.get("fifths") is not None
    }
    explicit_key_supported = bool(raw_key_values)
    key_semantics_ok = bool(
        explicit_key_supported
        and exported_key_values
        and raw_key_sequence == exported_key_values
    )
    key_conflict = bool(
        explicit_key_supported
        and exported_key_values
        and raw_key_sequence != exported_key_values
    )
    key_explicit_ready = bool(key_score_ok and key_semantics_ok)
    key_structural_ready = bool(
        staff_ids
        and key_covered_staffs == staff_ids
        and len(raw_key_sequence) == 1
        and raw_key_sequence == exported_key_values
    )
    # In C major / A minor there is no printed key-signature symbol.  Empty raw
    # evidence plus an exported zero is affirmative notation evidence, not a
    # missing-field failure.  A detected conflicting symbol still wins and fails.
    key_implicit_zero_ready = bool(
        not raw_key_values
        and exported_key_values in ([], [0])
        and staff_ids
        and covered_staffs == staff_ids
        and clef_semantics_ok
    )
    key_ready = bool(
        not key_conflict
        and (key_explicit_ready or key_structural_ready or key_implicit_zero_ready)
    )
    if not key_ready:
        if key_conflict:
            reasons.append("key-signature-conflict")
        if raw_keys and not key_score_ok and not key_structural_ready and not key_implicit_zero_ready:
            reasons.append("key-signature-confidence-insufficient")
        if not key_explicit_ready and not key_structural_ready and not key_implicit_zero_ready:
            reasons.append("key-signature-evidence-insufficient")

    raw_meters = list(raw.get("meters") or [])
    exported_meters = list(exported.get("meters") or [])
    meter_scores = [item.get("score") for item in raw_meters]
    meter_score_ok = bool(meter_scores) and all(
        score is not None and score >= min_symbol_score for score in meter_scores
    )
    raw_meter_values = [(int(item["beats"]), int(item["beatType"])) for item in raw_meters]
    raw_meter_sequence = list(dict.fromkeys(raw_meter_values))
    exported_meter_sequence = list(dict.fromkeys(tuple(value) for value in exported_meters))
    meter_semantics_ok = bool(
        raw_meter_sequence
        and exported_meter_sequence
        and raw_meter_sequence == exported_meter_sequence
    )
    meter_conflict = bool(
        raw_meter_sequence
        and exported_meter_sequence
        and raw_meter_sequence != exported_meter_sequence
    )
    meter_explicit_ready = bool(meter_score_ok and meter_semantics_ok)
    meter_consistency_rate = exported.get("measureDurationConsistencyRate")
    meter_comparable_count = int(exported.get("measureDurationComparableCount") or 0)
    meter_structural_ready = bool(
        exported_meter_sequence
        and isinstance(meter_consistency_rate, (int, float))
        and meter_comparable_count > 0
        and meter_consistency_rate >= min_meter_consistency_rate
    )
    meter_ready = bool(not meter_conflict and (meter_explicit_ready or meter_structural_ready))
    if not meter_ready:
        if meter_conflict:
            reasons.append("meter-conflict")
        if raw_meters and not meter_score_ok and not meter_structural_ready:
            reasons.append("meter-confidence-insufficient")
        if not meter_explicit_ready and not meter_structural_ready:
            reasons.append("meter-structural-evidence-insufficient")

    reasons = list(dict.fromkeys(reasons))
    return {
        "ready": bool(clef_ready and key_ready and meter_ready),
        "clefReady": clef_ready,
        "keyReady": key_ready,
        "meterReady": meter_ready,
        "reasons": reasons,
        "thresholds": {
            "minSymbolScore": min_symbol_score,
            "minViolinRangeRate": min_violin_range_rate,
            "minMeterConsistencyRate": min_meter_consistency_rate,
        },
        "evidence": {
            "staffCount": len(staff_ids),
            "lineStartClefCount": len(raw_clefs),
            "lineStartClefCoverage": (
                round(len(covered_staffs & staff_ids) / len(staff_ids), 6) if staff_ids else 0.0
            ),
            "rawClefKinds": dict(Counter(str(item.get("kind")) for item in raw_clefs)),
            "rawKeyFifths": raw_key_sequence,
            "keyLineStartCoverage": (
                round(len(key_covered_staffs & staff_ids) / len(staff_ids), 6) if staff_ids else 0.0
            ),
            "exportedKeyFifths": exported_key_values,
            "rawMeters": raw_meter_sequence,
            "exportedMeters": exported_meter_sequence,
            "clefEvidenceMode": (
                "explicit" if clef_explicit_ready else "structural" if clef_structural_ready else "none"
            ),
            "keyEvidenceMode": (
                "explicit"
                if key_explicit_ready
                else "structural"
                if key_structural_ready
                else "implicit-zero"
                if key_implicit_zero_ready and exported_key_values == [0]
                else "implicit-zero-export-default"
                if key_implicit_zero_ready
                else "none"
            ),
            "meterEvidenceMode": (
                "explicit" if meter_explicit_ready else "structural" if meter_structural_ready else "none"
            ),
            "pitchMinMidi": exported.get("pitchMinMidi"),
            "pitchMaxMidi": exported.get("pitchMaxMidi"),
            "pitchInViolinRangeRate": violin_range_rate,
            "measureDurationConsistencyRate": meter_consistency_rate,
            "measureDurationComparableCount": meter_comparable_count,
            "measureDurationMatchCount": exported.get("measureDurationMatchCount"),
        },
    }


def evaluate_p0_structure(
    omr_path: Path,
    musicxml_paths: Iterable[Path],
    min_symbol_score: float = 0.8,
) -> dict[str, Any]:
    paths = list(musicxml_paths)
    if not paths:
        return {
            "ready": False,
            "clefReady": False,
            "keyReady": False,
            "meterReady": False,
            "reasons": ["musicxml-output-missing"],
        }
    try:
        raw = extract_raw_structure(_read_omr_roots(omr_path))
        exported = extract_musicxml_structure(_read_musicxml_root(path) for path in paths)
        result = evaluate_p0_records(raw, exported, min_symbol_score=min_symbol_score)
        result["omrPath"] = str(omr_path)
        result["musicxmlPaths"] = [str(path) for path in paths]
        return result
    except Exception as exc:
        return {
            "ready": False,
            "clefReady": False,
            "keyReady": False,
            "meterReady": False,
            "reasons": [f"structure-evidence-error:{type(exc).__name__}"],
            "error": str(exc)[:300],
            "omrPath": str(omr_path),
            "musicxmlPaths": [str(path) for path in paths],
        }


def read_omr_structure(path: Path) -> dict[str, Any]:
    """Public read-only adapter used by eval and focused-gold scripts."""
    return extract_raw_structure(_read_omr_roots(path))
