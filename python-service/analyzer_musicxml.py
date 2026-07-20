# -*- coding: utf-8 -*-
from __future__ import annotations

from collections.abc import Callable
from typing import Any
from xml.etree import ElementTree as ET

from analyzer_utils import musicxml_pitch_to_midi, normalize_part_label, normalize_musicxml_measure_indices, safe_float, trimmed_median


def xml_local_tag(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return node.tag.rsplit("}", 1)[-1]


def xml_child(node: ET.Element | None, tag: str) -> ET.Element | None:
    if node is None:
        return None
    for element in list(node):
        if xml_local_tag(element) == tag:
            return element
    return None


def xml_children(node: ET.Element | None, tag: str) -> list[ET.Element]:
    if node is None:
        return []
    return [element for element in list(node) if xml_local_tag(element) == tag]


def is_piano_part_name(label: str) -> bool:
    label_lower = label.lower()
    normalized_label = normalize_part_label(label)
    return (
        "piano" in label_lower
        or "pianoforte" in label_lower
        or "pno" in label_lower
        or "pn." in label_lower
        or "\u94a2\u7434" in normalized_label
        or "\u92fc\u7434" in normalized_label
    )


def is_violin_part_name(label: str) -> bool:
    label_lower = label.lower()
    normalized_label = normalize_part_label(label)
    return (
        "violin" in label_lower
        or "violino" in label_lower
        or normalized_label in {"vn", "vln", "vl"}
        or "小提琴" in normalized_label
    )


def extract_musicxml_part_candidates(xml_text: str, selected_hint: str | None = None) -> list[dict[str, Any]]:
    if not xml_text.strip():
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []

    part_names: dict[str, str] = {}
    for element in root.iter():
        if xml_local_tag(element) != "score-part":
            continue
        part_id = element.attrib.get("id", "").strip()
        part_name_node = xml_child(element, "part-name")
        part_name = (part_name_node.text or "").strip() if part_name_node is not None else ""
        if part_id:
            part_names[part_id] = part_name or part_id

    part_elements = [element for element in root.iter() if xml_local_tag(element) == "part"]
    normalized_label_counts: dict[str, int] = {}
    part_order: list[tuple[int, ET.Element, str, str]] = []
    explicit_piano_part_index: int | None = None
    for part_index, part in enumerate(part_elements, start=1):
        part_id = part.attrib.get("id", "").strip()
        part_name = part_names.get(part_id, part_id or "Voice")
        normalized_label = normalize_part_label(part_name)
        normalized_label_counts[normalized_label] = normalized_label_counts.get(normalized_label, 0) + 1
        part_order.append((part_index, part, part_id, part_name))
        if explicit_piano_part_index is None and is_piano_part_name(part_name):
            explicit_piano_part_index = part_index

    candidates: list[dict[str, Any]] = []
    normalized_hint = normalize_part_label(selected_hint)
    violin_hint = "violin" in normalized_hint or normalized_hint in {"vn", "vln", "vl", "小提琴"}
    for part_index, part, part_id, part_name in part_order:
        pitches: list[int] = []
        staff_indices: set[int] = set()
        note_count = 0
        measure_count = 0
        chord_count = 0
        non_empty_measure_count = 0
        previous_measure_note_onsets: set[tuple[int, float]] = set()

        for measure_position, measure in enumerate(xml_children(part, "measure"), start=1):
            measure_count += 1
            measure_note_count = 0
            attributes = xml_child(measure, "attributes")
            divisions_node = xml_child(attributes, "divisions")
            divisions = max(1.0, safe_float(divisions_node.text if divisions_node is not None else 1.0, 1.0))
            current_beat = 0.0
            last_note_start = 0.0
            for element in list(measure):
                local_tag = xml_local_tag(element)
                if local_tag in {"backup", "forward"}:
                    duration_node = xml_child(element, "duration")
                    duration_beats = safe_float(duration_node.text if duration_node is not None else 0.0) / divisions
                    if local_tag == "backup":
                        current_beat = max(0.0, current_beat - max(0.0, duration_beats))
                    else:
                        current_beat += max(0.0, duration_beats)
                    last_note_start = current_beat
                    continue
                if local_tag != "note":
                    continue
                note = element
                is_rest = xml_child(note, "rest") is not None
                is_chord = xml_child(note, "chord") is not None
                is_grace = xml_child(note, "grace") is not None
                is_cue = xml_child(note, "cue") is not None
                is_unscored_note = is_grace or is_cue
                duration_node = xml_child(note, "duration")
                duration_beats = safe_float(duration_node.text if duration_node is not None else 0.0) / divisions
                if not is_chord:
                    last_note_start = current_beat
                if not is_rest and not is_unscored_note:
                    onset_key = (measure_position, round(last_note_start, 4))
                    if onset_key in previous_measure_note_onsets:
                        chord_count += 1
                    previous_measure_note_onsets.add(onset_key)
                    pitch = xml_child(note, "pitch")
                    step_node = xml_child(pitch, "step")
                    octave_node = xml_child(pitch, "octave")
                    alter_node = xml_child(pitch, "alter")
                    if step_node is not None and octave_node is not None and step_node.text and octave_node.text:
                        note_count += 1
                        measure_note_count += 1
                        staff_node = xml_child(note, "staff")
                        staff_indices.add(max(1, int(safe_float(staff_node.text if staff_node is not None else 1, 1))))
                        pitches.append(
                            musicxml_pitch_to_midi(
                                step_node.text.strip(),
                                int(safe_float(octave_node.text, 4)),
                                int(safe_float(alter_node.text if alter_node is not None else 0, 0)),
                            )
                        )
                if not is_chord and not is_grace:
                    current_beat += max(duration_beats, 0.0)
            if measure_note_count > 0:
                non_empty_measure_count += 1

        min_pitch = min(pitches) if pitches else 0
        max_pitch = max(pitches) if pitches else 0
        pitch_span = max_pitch - min_pitch if pitches else 0
        staff_count = len(staff_indices) or 1
        normalized_name = normalize_part_label(part_name)
        name_lower = part_name.lower()
        erhu_name = ("erhu" in name_lower) or ("\u4e8c\u80e1" in part_name)
        violin_name = is_violin_part_name(part_name)
        explicit_target_name = erhu_name or (violin_name and violin_hint)
        piano_name = is_piano_part_name(part_name)
        voice_name = "voice" in name_lower or normalized_name == "voice"
        duplicate_label_count = normalized_label_counts.get(normalized_name, 0)
        is_generic_voice = voice_name and not erhu_name and not piano_name
        is_after_explicit_piano = explicit_piano_part_index is not None and part_index > explicit_piano_part_index
        range_hits = sum(1 for value in pitches if 52 <= value <= 96)
        range_ratio = (range_hits / len(pitches)) if pitches else 0.0
        chord_ratio = (chord_count / max(1, note_count)) if note_count else 0.0
        notes_per_measure = (note_count / max(1, measure_count)) if measure_count else 0.0
        active_measure_ratio = (non_empty_measure_count / max(1, measure_count)) if measure_count else 0.0
        avg_notes_per_active_measure = (note_count / max(1, non_empty_measure_count)) if non_empty_measure_count else 0.0
        measure_quality = 0.0
        if note_count > 0:
            measure_quality = min(
                1.0,
                (active_measure_ratio * 0.55)
                + (min(1.0, avg_notes_per_active_measure / 4.0) * 0.25)
                + (min(1.0, measure_count / 8.0) * 0.20),
            )
        monophonic_ratio = max(0.0, min(1.0, 1.0 - chord_ratio))
        low_range_penalty = 0.0
        if min_pitch and min_pitch < 48:
            low_range_penalty = min(0.22, ((48 - min_pitch) / 24.0) * 0.12)
        dense_voice_penalty = 0.12 if note_count >= 60 and chord_ratio >= 0.1 else 0.0
        after_piano_penalty = 0.36 if is_generic_voice and is_after_explicit_piano else 0.0
        chord_penalty = min(0.28, chord_ratio * 0.9) if chord_ratio >= 0.12 else min(0.14, chord_ratio * 0.55)
        likely_accompaniment_split = bool(
            is_generic_voice
            and (
                is_after_explicit_piano
                or chord_ratio >= 0.18
                or min_pitch < 48
                or (note_count >= 60 and chord_ratio >= 0.1)
            )
        )
        safe_for_erhu_projection = bool(
            explicit_target_name
            or (
                note_count >= 4
                and staff_count == 1
                and range_ratio >= 0.72
                and chord_ratio <= 0.12
                and min_pitch >= 52
                and not likely_accompaniment_split
                and (not is_after_explicit_piano or explicit_piano_part_index is None)
            )
        )
        score = (
            0.18
            + min(0.22, note_count / 480.0)
            + (range_ratio * 0.28)
            + (0.16 if staff_count == 1 else -0.16)
            + (0.14 if pitch_span <= 36 else -0.04)
            - chord_penalty
            + (0.25 if erhu_name else 0.0)
            + (0.25 if violin_name and violin_hint else 0.0)
            + (0.08 if voice_name else 0.0)
            - (0.35 if piano_name else 0.0)
            - low_range_penalty
            - dense_voice_penalty
            - after_piano_penalty
            + (0.18 if safe_for_erhu_projection else 0.0)
        )
        raw_hint_lower = str(selected_hint or "").strip().lower()
        selection_key = part_id or part_name
        selected_hint_match = bool(
            (
                raw_hint_lower
                and raw_hint_lower in {
                    str(part_id or "").strip().lower(),
                    str(selection_key or "").strip().lower(),
                    str(part_name or "").strip().lower(),
                }
            )
            or (normalized_hint and normalized_hint in normalize_part_label(part_name))
        )
        if selected_hint_match:
            score += 0.12
        if note_count <= 0:
            score = 0.0
        elif note_count < 4:
            score -= 0.14
        candidates.append(
            {
                "partIndex": part_index,
                "id": part_id,
                "name": part_name,
                "label": part_name,
                "selectionKey": selection_key,
                "qualifiedLabel": f"{part_name} [{part_id}]" if duplicate_label_count > 1 and part_id else part_name,
                "score": round(max(0.0, min(1.0, score)), 3),
                "noteCount": note_count,
                "measureCount": measure_count,
                "nonEmptyMeasureCount": non_empty_measure_count,
                "notesPerMeasure": round(notes_per_measure, 3),
                "activeMeasureRatio": round(active_measure_ratio, 3),
                "avgNotesPerActiveMeasure": round(avg_notes_per_active_measure, 3),
                "measureQuality": round(measure_quality, 3),
                "staffCount": staff_count,
                "pitchRange": [min_pitch, max_pitch] if pitches else [],
                "pitchSpan": pitch_span,
                "erhuRangeRatio": round(range_ratio, 3),
                "chordRatio": round(chord_ratio, 3),
                "monophonicRatio": round(monophonic_ratio, 3),
                "isLikelyPiano": bool(piano_name or staff_count >= 2 or chord_ratio > 0.18),
                "isGenericVoice": bool(is_generic_voice),
                "explicitErhuName": bool(erhu_name),
                "explicitViolinName": bool(violin_name),
                "selectedHintMatch": selected_hint_match,
                "isAfterExplicitPiano": bool(is_after_explicit_piano),
                "isLikelyAccompanimentSplit": likely_accompaniment_split,
                "safeForErhuProjection": safe_for_erhu_projection,
            }
        )

    candidates.sort(key=lambda item: (float(item.get("score", 0.0)), int(item.get("noteCount", 0))), reverse=True)
    if len(candidates) >= 2:
        gap = float(candidates[0].get("score", 0.0)) - float(candidates[1].get("score", 0.0))
        confidence = max(0.45, min(0.96, 0.58 + gap))
    elif candidates:
        confidence = max(0.55, min(0.96, float(candidates[0].get("score", 0.0))))
    else:
        confidence = 0.0
    top_score = float(candidates[0].get("score", 0.0)) if candidates else 0.0
    for index, candidate in enumerate(candidates):
        candidate_confidence = confidence if index == 0 else max(0.25, confidence - 0.18)
        if not bool(candidate.get("safeForErhuProjection")):
            candidate_confidence = min(candidate_confidence, 0.58 if index == 0 else 0.42)
        next_candidate = candidates[index + 1] if (index + 1) < len(candidates) else None
        next_score = float(next_candidate.get("score", 0.0)) if next_candidate else 0.0
        score_gap_to_next = float(candidate.get("score", 0.0)) - next_score if next_candidate else 0.0
        decisive_identity = bool(
            next_candidate
            and (
                (bool(candidate.get("selectedHintMatch")) and not bool(next_candidate.get("selectedHintMatch")))
                or (bool(candidate.get("explicitErhuName")) and not bool(next_candidate.get("explicitErhuName")))
                or (bool(candidate.get("explicitViolinName")) and not bool(next_candidate.get("explicitViolinName")))
                or (bool(candidate.get("safeForErhuProjection")) and not bool(next_candidate.get("safeForErhuProjection")))
                or (
                    float(candidate.get("measureQuality", 0.0)) - float(next_candidate.get("measureQuality", 0.0)) >= 0.18
                    and float(candidate.get("erhuRangeRatio", 0.0)) >= float(next_candidate.get("erhuRangeRatio", 0.0))
                )
            )
        )
        candidate["rank"] = index + 1
        candidate["selectedPartConfidence"] = round(candidate_confidence, 3)
        candidate["scoreGapToNext"] = round(max(0.0, score_gap_to_next), 3)
        candidate["scoreGapFromBest"] = round(max(0.0, top_score - float(candidate.get("score", 0.0))), 3)
        candidate["selectionAmbiguous"] = bool(
            index == 0
            and next_candidate is not None
            and score_gap_to_next < 0.08
            and not decisive_identity
        )
    return candidates


def candidate_matches_selected_hint(candidate: dict[str, Any], selected_hint: str | None) -> bool:
    raw_hint = str(selected_hint or "").strip()
    if not raw_hint:
        return False
    raw_hint_lower = raw_hint.lower()
    candidate_id = str(candidate.get("id") or "").strip().lower()
    candidate_key = str(candidate.get("selectionKey") or "").strip().lower()
    candidate_qualified = str(candidate.get("qualifiedLabel") or "").strip().lower()
    if raw_hint_lower and raw_hint_lower in {candidate_id, candidate_key, candidate_qualified}:
        return True
    normalized_hint = normalize_part_label(selected_hint)
    if not normalized_hint:
        return False
    for field in ("label", "name", "qualifiedLabel"):
        normalized_value = normalize_part_label(str(candidate.get(field) or ""))
        if normalized_value and (normalized_hint in normalized_value or normalized_value in normalized_hint):
            return True
    return False


def resolve_selected_part_from_candidates(
    candidates: list[dict[str, Any]],
    selected_hint: str | None,
) -> tuple[dict[str, Any] | None, float]:
    if not candidates:
        return None, 0.0
    for candidate in candidates:
        if candidate_matches_selected_hint(candidate, selected_hint):
            return candidate, float(candidate.get("selectedPartConfidence", candidate.get("score", 0.65)))
    safe_candidates = [
        candidate
        for candidate in candidates
        if bool(candidate.get("safeForErhuProjection")) and int(safe_float(candidate.get("noteCount"), 0)) > 0
    ]
    non_piano_candidates = [
        candidate
        for candidate in candidates
        if (
            int(safe_float(candidate.get("noteCount"), 0)) > 0
            and not is_piano_part_name(
                " ".join(str(candidate.get(key) or "") for key in ("name", "label", "qualifiedLabel"))
            )
            and int(safe_float(candidate.get("staffCount"), 1)) <= 1
        )
    ]
    best = safe_candidates[0] if safe_candidates else (non_piano_candidates[0] if non_piano_candidates else candidates[0])
    return best, float(best.get("selectedPartConfidence", best.get("score", 0.5)))


def extract_dynamic_label(dynamics_node: ET.Element | None, sound_value: str | None = None) -> tuple[str, float | None]:
    if dynamics_node is not None:
        for child in list(dynamics_node):
            tag = xml_local_tag(child).strip()
            if tag:
                return tag, safe_float(sound_value, 0.0) or None
    value = safe_float(sound_value, 0.0)
    if value > 0:
        if value <= 45:
            return "p", value
        if value <= 65:
            return "mp", value
        if value <= 85:
            return "mf", value
        if value <= 110:
            return "f", value
        return "ff", value
    return "", None


def empty_musicxml_markings() -> dict[str, Any]:
    return {"markings": [], "tempoChanges": [], "dynamicChanges": [], "repeatStructure": [], "markingStats": {}}


def extract_musicxml_markings(
    xml_text: str,
    selected_part_hint: str | None,
    section_id: str,
    page_number: int,
    default_tempo: int,
) -> dict[str, Any]:
    if not xml_text.strip():
        return empty_musicxml_markings()
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return empty_musicxml_markings()

    candidates = extract_musicxml_part_candidates(xml_text, selected_part_hint)
    selected_candidate, _ = resolve_selected_part_from_candidates(candidates, selected_part_hint)
    selected_part_id = str((selected_candidate or {}).get("id") or "").strip()
    parts = [element for element in root.iter() if xml_local_tag(element) == "part"]
    part = next((element for element in parts if element.attrib.get("id", "").strip() == selected_part_id), parts[0] if parts else None)
    if part is None:
        return empty_musicxml_markings()

    markings: list[dict[str, Any]] = []
    tempo_changes: list[dict[str, Any]] = []
    dynamic_changes: list[dict[str, Any]] = []
    repeat_structure: list[dict[str, Any]] = []
    divisions = 1.0
    current_tempo = int(default_tempo or 72)
    current_dynamic = ""
    measures = xml_children(part, "measure")
    measure_indices = normalize_musicxml_measure_indices([measure.attrib.get("number") for measure in measures])
    for measure_position, (measure, measure_index) in enumerate(zip(measures, measure_indices), start=1):
        attributes = xml_child(measure, "attributes")
        divisions_node = xml_child(attributes, "divisions")
        if divisions_node is not None and divisions_node.text:
            divisions = max(1.0, safe_float(divisions_node.text, divisions))
        for direction in xml_children(measure, "direction"):
            offset_node = xml_child(direction, "offset")
            beat_start = max(0.0, safe_float(offset_node.text if offset_node is not None else 0.0, 0.0) / divisions)
            placement = direction.attrib.get("placement", "")
            sound_node = xml_child(direction, "sound")
            sound_tempo = sound_node.attrib.get("tempo") if sound_node is not None else None
            sound_dynamic = sound_node.attrib.get("dynamics") if sound_node is not None else None
            if sound_node is not None:
                for route_key in ("dacapo", "dalsegno", "tocoda", "fine", "segno", "coda"):
                    route_value = str(sound_node.attrib.get(route_key) or "").strip()
                    if route_value:
                        repeat_structure.append(
                            {
                                "type": route_key,
                                "value": route_value,
                                "measureIndex": measure_index,
                                "beatStart": beat_start,
                                "pageNumber": page_number,
                                "sectionId": section_id,
                                "requiresReview": True,
                            }
                        )
            for direction_type in xml_children(direction, "direction-type"):
                words_node = xml_child(direction_type, "words")
                if words_node is not None and (words_node.text or "").strip():
                    markings.append(
                        {
                            "type": "text",
                            "text": (words_node.text or "").strip(),
                            "measureIndex": measure_index,
                            "beatStart": beat_start,
                            "pageNumber": page_number,
                            "placement": placement,
                            "sectionId": section_id,
                        }
                    )
                metronome = xml_child(direction_type, "metronome")
                per_minute = xml_child(metronome, "per-minute")
                tempo_value = safe_float(sound_tempo, 0.0) or safe_float(per_minute.text if per_minute is not None else None, 0.0)
                if tempo_value > 0:
                    current_tempo = int(round(tempo_value))
                    change = {
                        "type": "tempo",
                        "tempo": current_tempo,
                        "measureIndex": measure_index,
                        "beatStart": beat_start,
                        "pageNumber": page_number,
                        "sectionId": section_id,
                    }
                    tempo_changes.append(change)
                    markings.append({**change, "text": f"鈾?{current_tempo}"})
                dynamics = xml_child(direction_type, "dynamics")
                dynamic_label, dynamic_value = extract_dynamic_label(dynamics, sound_dynamic)
                if dynamic_label:
                    current_dynamic = dynamic_label
                    change = {
                        "type": "dynamic",
                        "dynamic": dynamic_label,
                        "dynamicValue": dynamic_value,
                        "measureIndex": measure_index,
                        "beatStart": beat_start,
                        "pageNumber": page_number,
                        "placement": placement,
                        "sectionId": section_id,
                    }
                    dynamic_changes.append(change)
                    markings.append({**change, "text": dynamic_label})
                wedge = xml_child(direction_type, "wedge")
                if wedge is not None:
                    wedge_type = wedge.attrib.get("type", "").strip()
                    if wedge_type:
                        markings.append(
                            {
                                "type": "wedge",
                                "wedgeType": wedge_type,
                                "text": "娓愬己" if wedge_type == "crescendo" else "娓愬急" if wedge_type == "diminuendo" else wedge_type,
                                "measureIndex": measure_index,
                                "beatStart": beat_start,
                                "pageNumber": page_number,
                                "placement": placement,
                                "sectionId": section_id,
                            }
                        )
            if sound_tempo and not any(item.get("measureIndex") == measure_index and item.get("beatStart") == beat_start for item in tempo_changes):
                tempo_value = safe_float(sound_tempo, 0.0)
                if tempo_value > 0:
                    current_tempo = int(round(tempo_value))
                    change = {
                        "type": "tempo",
                        "tempo": current_tempo,
                        "measureIndex": measure_index,
                        "beatStart": beat_start,
                        "pageNumber": page_number,
                        "sectionId": section_id,
                    }
                    tempo_changes.append(change)
                    markings.append({**change, "text": f"鈾?{current_tempo}"})
            if sound_dynamic:
                dynamic_label, dynamic_value = extract_dynamic_label(None, sound_dynamic)
                if dynamic_label and dynamic_label != current_dynamic:
                    current_dynamic = dynamic_label
                    change = {
                        "type": "dynamic",
                        "dynamic": dynamic_label,
                        "dynamicValue": dynamic_value,
                        "measureIndex": measure_index,
                        "beatStart": beat_start,
                        "pageNumber": page_number,
                        "sectionId": section_id,
                    }
                    dynamic_changes.append(change)
                    markings.append({**change, "text": dynamic_label})

        for barline in xml_children(measure, "barline"):
            ending = xml_child(barline, "ending")
            if ending is not None:
                repeat_structure.append(
                    {
                        "type": "ending",
                        "number": ending.attrib.get("number", ""),
                        "endingType": ending.attrib.get("type", ""),
                        "measureIndex": measure_index,
                        "pageNumber": page_number,
                        "sectionId": section_id,
                        "requiresReview": True,
                    }
                )
            repeat = xml_child(barline, "repeat")
            if repeat is not None:
                repeat_structure.append(
                    {
                        "type": "repeat",
                        "direction": repeat.attrib.get("direction", ""),
                        "times": repeat.attrib.get("times", ""),
                        "measureIndex": measure_index,
                        "pageNumber": page_number,
                        "sectionId": section_id,
                        "requiresReview": True,
                    }
                )

    return {
        "markings": markings,
        "tempoChanges": tempo_changes,
        "dynamicChanges": dynamic_changes,
        "repeatStructure": repeat_structure,
        "markingStats": {
            "markingCount": len(markings),
            "tempoChangeCount": len(tempo_changes),
            "dynamicChangeCount": len(dynamic_changes),
            "repeatCount": len(repeat_structure),
            "repeatRouteReady": not repeat_structure,
            "repeatRouteReason": "" if not repeat_structure else "repeat-route-review-required",
        },
    }


def extract_candidate_layout_profile(parsed_notes: list[Any]) -> dict[str, float | bool]:
    y_values: list[float] = []
    pitch_values: list[float] = []
    system_values: list[int] = []
    for note in parsed_notes or []:
        position = getattr(note, "notePosition", None) or getattr(note, "note_position", None) or {}
        normalized_y = safe_float(position.get("normalizedY"), None)
        if normalized_y is not None:
            y_values.append(float(normalized_y))
        system_index = int(safe_float(position.get("systemIndex"), 0))
        if system_index > 0:
            system_values.append(system_index)
        pitch_values.append(float(getattr(note, "midiPitch", getattr(note, "midi_pitch", 0)) or 0))
    if not y_values:
        return {
            "hasLayout": False,
            "medianY": 1.0,
            "minY": 1.0,
            "maxY": 1.0,
            "ySpread": 1.0,
            "medianPitch": 0.0,
            "systemCount": 0.0,
        }
    median_y = trimmed_median(y_values, 0.12)
    min_y = min(y_values)
    max_y = max(y_values)
    median_pitch = trimmed_median(pitch_values, 0.12) if pitch_values else 0.0
    return {
        "hasLayout": True,
        "medianY": float(median_y),
        "minY": float(min_y),
        "maxY": float(max_y),
        "ySpread": float(max_y - min_y),
        "medianPitch": float(median_pitch),
        "systemCount": float(len(set(system_values))),
    }


def score_layout_candidate(candidate: dict[str, Any], profile: dict[str, float | bool]) -> float:
    base_score = max(0.0, min(1.0, safe_float(candidate.get("score"), 0.0)))
    if not bool(profile.get("hasLayout")):
        return base_score
    median_y = max(0.0, min(1.0, safe_float(profile.get("medianY"), 1.0)))
    y_spread = max(0.0, min(1.0, safe_float(profile.get("ySpread"), 1.0)))
    median_pitch = safe_float(profile.get("medianPitch"), 0.0)
    top_bias = 1.0 - median_y
    compactness = 1.0 - min(1.0, y_spread / 0.42)
    pitch_bias = max(0.0, min(1.0, (median_pitch - 52.0) / 28.0))
    layout_score = (base_score * 0.56) + (top_bias * 0.28) + (compactness * 0.08) + (pitch_bias * 0.08)
    if bool(candidate.get("isLikelyAccompanimentSplit")):
        layout_score -= 0.18
    if bool(candidate.get("isAfterExplicitPiano")):
        layout_score -= 0.12
    if bool(candidate.get("isLikelyPiano")):
        layout_score -= 0.18
    return max(0.0, min(1.0, layout_score))


def refine_selected_part_candidate_with_layout(
    xml_text: str,
    request: Any,
    candidates: list[dict[str, Any]],
    selected_candidate: dict[str, Any] | None,
    parse_musicxml_score: Callable[[str, Any, str | None], list[Any]],
    is_explicit_erhu_part_candidate: Callable[[dict[str, Any] | None], bool],
) -> dict[str, Any] | None:
    if not candidates:
        return selected_candidate
    if is_explicit_erhu_part_candidate(selected_candidate):
        return selected_candidate
    safe_candidates = [
        candidate
        for candidate in candidates
        if bool(candidate.get("safeForErhuProjection")) and int(safe_float(candidate.get("noteCount"), 0)) > 0
    ]
    if len(safe_candidates) < 2:
        return selected_candidate

    preview_candidates = safe_candidates[: min(3, len(safe_candidates))]
    scored_previews: list[tuple[float, dict[str, Any], dict[str, float | bool]]] = []
    for candidate in preview_candidates:
        candidate_hint = str(candidate.get("selectionKey") or candidate.get("id") or candidate.get("label") or "").strip()
        if not candidate_hint:
            continue
        preview_notes = parse_musicxml_score(xml_text, request, candidate_hint)
        profile = extract_candidate_layout_profile(preview_notes)
        if not bool(profile.get("hasLayout")):
            continue
        scored_previews.append((score_layout_candidate(candidate, profile), candidate, profile))
    if not scored_previews:
        return selected_candidate

    scored_previews.sort(key=lambda item: item[0], reverse=True)
    best_score, best_candidate, _best_profile = scored_previews[0]
    current_candidate = selected_candidate or preview_candidates[0]
    current_entry = next(
        (
            item
            for item in scored_previews
            if str(item[1].get("selectionKey") or item[1].get("id") or "")
            == str(current_candidate.get("selectionKey") or current_candidate.get("id") or "")
        ),
        None,
    )
    current_score = current_entry[0] if current_entry else score_layout_candidate(
        current_candidate,
        extract_candidate_layout_profile(
            parse_musicxml_score(
                xml_text,
                request,
                str(current_candidate.get("selectionKey") or current_candidate.get("id") or current_candidate.get("label") or "").strip(),
            )
        ),
    )
    if best_candidate is current_candidate:
        return current_candidate
    if best_score >= (current_score + 0.08):
        return best_candidate
    if not bool(current_candidate.get("safeForErhuProjection")) and bool(best_candidate.get("safeForErhuProjection")):
        return best_candidate
    return current_candidate
