from __future__ import annotations

from typing import Any

from analyzer_utils import normalize_part_label, safe_float
from schemas import NoteEvent


def find_musicxml_part_candidate(candidates: list[dict[str, Any]], selected_label: str | None) -> dict[str, Any] | None:
    if not candidates:
        return None
    normalized_selected = normalize_part_label(selected_label)
    if normalized_selected:
        for candidate in candidates:
            labels = [
                normalize_part_label(str(candidate.get("id") or "")),
                normalize_part_label(str(candidate.get("name") or "")),
                normalize_part_label(str(candidate.get("label") or "")),
            ]
            if normalized_selected in labels:
                return candidate
    return candidates[0]


def is_explicit_erhu_part_candidate(candidate: dict[str, Any] | None) -> bool:
    if not candidate:
        return False
    label = " ".join(str(candidate.get(key) or "") for key in ("id", "name", "label")).lower()
    return "erhu" in label or "浜岃儭" in label


def has_accompaniment_part_candidate(candidates: list[dict[str, Any]] | None) -> bool:
    for candidate in candidates or []:
        label = " ".join(str(candidate.get(key) or "") for key in ("id", "name", "label")).lower()
        if (
            "piano" in label
            or "pianoforte" in label
            or "pno" in label
            or "pn." in label
            or "accompaniment" in label
            or "閽㈢惔" in label
            or "閶肩惔" in label
            or "浼村" in label
        ):
            return True
        if bool(candidate.get("isLikelyPiano")):
            return True
        if int(safe_float(candidate.get("staffCount"), 1)) >= 2:
            return True
    return False


def is_clean_solo_part_candidate(
    candidate: dict[str, Any] | None,
    candidates: list[dict[str, Any]] | None = None,
) -> bool:
    if not candidate:
        return False
    if is_explicit_erhu_part_candidate(candidate):
        return True
    if has_accompaniment_part_candidate(candidates):
        return False
    return (
        not bool(candidate.get("isLikelyPiano"))
        and safe_float(candidate.get("chordRatio"), 0.0) < 0.18
        and int(safe_float(candidate.get("staffCount"), 1)) <= 1
    )


def is_ambiguous_part_candidate(
    candidate: dict[str, Any] | None,
    candidates: list[dict[str, Any]] | None = None,
) -> bool:
    if not candidate or is_explicit_erhu_part_candidate(candidate):
        return False
    return (
        has_accompaniment_part_candidate(candidates)
        or bool(candidate.get("isLikelyPiano"))
        or safe_float(candidate.get("chordRatio"), 0.0) >= 0.18
    )


def should_apply_erhu_range_fallback(
    selected_part_candidate: dict[str, Any] | None,
    clean_solo: bool,
    ambiguous: bool,
) -> bool:
    if clean_solo or not ambiguous or not selected_part_candidate:
        return False
    if bool(selected_part_candidate.get("isLikelyPiano")):
        return False
    if int(safe_float(selected_part_candidate.get("staffCount"), 1)) > 1:
        return False
    note_count = int(safe_float(selected_part_candidate.get("noteCount"), 0))
    erhu_range_ratio = safe_float(selected_part_candidate.get("erhuRangeRatio"), 0.0)
    chord_ratio = safe_float(selected_part_candidate.get("chordRatio"), 1.0)
    candidate_score = safe_float(selected_part_candidate.get("score"), 0.0)
    candidate_confidence = safe_float(selected_part_candidate.get("selectedPartConfidence"), candidate_score)
    if note_count < 8 or erhu_range_ratio < 0.82 or chord_ratio > 0.14:
        return False
    if bool(selected_part_candidate.get("safeForErhuProjection")):
        return True
    candidate_strength = max(candidate_score, candidate_confidence)
    return (
        erhu_range_ratio >= 0.9
        and (
            (chord_ratio <= 0.04 and candidate_strength >= 0.55)
            or (chord_ratio <= 0.14 and candidate_strength >= 0.75)
        )
    )


def collapse_erhu_melody_events(note_events: list[NoteEvent]) -> list[NoteEvent]:
    if not note_events:
        return note_events

    has_line_roles = any(str((getattr(note, "notePosition", None) or {}).get("scoreLineRole") or "").strip() for note in note_events)
    role_filtered = [
        note
        for note in note_events
        if str((getattr(note, "notePosition", None) or {}).get("scoreLineRole") or "").lower() == "erhu"
        and safe_float((getattr(note, "notePosition", None) or {}).get("scoreLineConfidence"), 0.0) >= 0.66
    ]
    if role_filtered:
        note_events = role_filtered
    elif has_line_roles:
        return []
    elif len(note_events) <= 1:
        return note_events

    staff_counts: dict[int, int] = {}
    for note in note_events:
        position = getattr(note, "notePosition", None) or {}
        staff_index = int(safe_float(position.get("staffIndex"), 1))
        if staff_index >= 1:
            staff_counts[staff_index] = staff_counts.get(staff_index, 0) + 1
    if len(staff_counts) > 1:
        preferred_staff = min(staff_counts.keys())
        staff_filtered = [
            note
            for note in note_events
            if int(safe_float((getattr(note, "notePosition", None) or {}).get("staffIndex"), 1)) == preferred_staff
        ]
        if staff_filtered:
            note_events = staff_filtered

    ordered = sorted(
        note_events,
        key=lambda item: (int(item.measureIndex), round(float(item.beatStart), 4), -float(item.beatDuration), int(item.midiPitch)),
    )

    groups: list[list[NoteEvent]] = []
    current_group: list[NoteEvent] = []
    current_key: tuple[int, float] | None = None
    for note in ordered:
        group_key = (int(note.measureIndex), round(float(note.beatStart), 4))
        if current_key != group_key:
            if current_group:
                groups.append(current_group)
            current_group = [note]
            current_key = group_key
        else:
            current_group.append(note)
    if current_group:
        groups.append(current_group)

    collapsed: list[NoteEvent] = []
    previous_pitch: int | None = None
    erhu_min_pitch = 52
    erhu_max_pitch = 96

    for group in groups:
        deduped_by_pitch: dict[int, NoteEvent] = {}
        for note in group:
            midi_pitch = int(note.midiPitch)
            existing = deduped_by_pitch.get(midi_pitch)
            if existing is None or float(note.beatDuration) > float(existing.beatDuration):
                deduped_by_pitch[midi_pitch] = note

        candidates = list(deduped_by_pitch.values())
        in_range = [note for note in candidates if erhu_min_pitch <= int(note.midiPitch) <= erhu_max_pitch]
        working = in_range or candidates

        if previous_pitch is None:
            chosen = max(working, key=lambda item: (float(item.beatDuration), int(item.midiPitch)))
        else:
            chosen = min(
                working,
                key=lambda item: (
                    abs(int(item.midiPitch) - previous_pitch),
                    -float(item.beatDuration),
                    -int(item.midiPitch),
                ),
            )
            close_candidates = [
                note for note in working if abs(int(note.midiPitch) - previous_pitch) <= 7
            ]
            if close_candidates:
                chosen = max(close_candidates, key=lambda item: (float(item.beatDuration), -abs(int(item.midiPitch) - previous_pitch)))

        previous_pitch = int(chosen.midiPitch)
        collapsed.append(chosen)

    normalized: list[NoteEvent] = []
    for index, note in enumerate(collapsed, start=1):
        normalized.append(
            NoteEvent(
                noteId=note.noteId or f"xml-note-{index}",
                measureIndex=int(note.measureIndex),
                beatStart=float(note.beatStart),
                beatDuration=max(float(note.beatDuration), 0.25),
                midiPitch=int(note.midiPitch),
                notePosition=dict(note.notePosition or {}) if getattr(note, "notePosition", None) else None,
                articulations=list(getattr(note, "articulations", []) or []),
                notations=list(getattr(note, "notations", []) or []),
                techniques=list(getattr(note, "techniques", []) or []),
                activeTempo=int(getattr(note, "activeTempo", 0) or 0) or None,
                activeDynamic=str(getattr(note, "activeDynamic", "") or "").strip() or None,
                dynamicValue=safe_float(getattr(note, "dynamicValue", None), 0.0) or None,
            )
        )
    return normalized
