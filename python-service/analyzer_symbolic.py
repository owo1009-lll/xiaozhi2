# -*- coding: utf-8 -*-
from __future__ import annotations

from analyzer_common import *


class SymbolicScoreMixin:
    def _extract_musicxml_tempo(self, xml_text: str) -> int:
        """Return the first tempo (BPM) found in a musicxml string, or 72 as fallback."""
        try:
            root = ET.fromstring(xml_text)
            # Strip namespace for simpler search
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                # <sound tempo="120"/>
                if tag == "sound":
                    t = elem.get("tempo") or elem.get("Tempo")
                    if t:
                        try:
                            bpm = round(float(t))
                            if 20 <= bpm <= 300:
                                return bpm
                        except ValueError:
                            pass
                # <metronome><beat-unit>quarter</beat-unit><per-minute>120</per-minute></metronome>
                if tag == "per-minute":
                    try:
                        bpm = round(float(elem.text or ""))
                        if 20 <= bpm <= 300:
                            return bpm
                    except (ValueError, TypeError):
                        pass
                # <words>♩=120</words> or <words>q=120</words> or <words>= 120</words>
                if tag == "words" and elem.text:
                    import re
                    m = re.search(r"[=＝]\s*(\d+)", elem.text)
                    if m:
                        try:
                            bpm = int(m.group(1))
                            if 20 <= bpm <= 300:
                                return bpm
                        except ValueError:
                            pass
        except Exception:
            pass
        return 72


    def _xml_local_tag(self, node: ET.Element | None) -> str:
        return xml_local_tag(node)


    def _xml_child(self, node: ET.Element | None, tag: str) -> ET.Element | None:
        return xml_child(node, tag)


    def _xml_children(self, node: ET.Element | None, tag: str) -> list[ET.Element]:
        return xml_children(node, tag)


    def _extract_musicxml_part_candidates(self, xml_text: str, selected_hint: str | None = None) -> list[dict[str, Any]]:
        return extract_musicxml_part_candidates(xml_text, selected_hint)


    def _resolve_selected_part_from_candidates(
        self,
        candidates: list[dict[str, Any]],
        selected_hint: str | None,
    ) -> tuple[dict[str, Any] | None, float]:
        return resolve_selected_part_from_candidates(candidates, selected_hint)


    def _refine_selected_part_candidate_with_layout(
        self,
        xml_text: str,
        request: AnalyzeRequest,
        candidates: list[dict[str, Any]],
        selected_candidate: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        return refine_selected_part_candidate_with_layout(
            xml_text,
            request,
            candidates,
            selected_candidate,
            self._parse_musicxml_score,
            is_explicit_erhu_part_candidate,
        )


    def _extract_musicxml_markings(
        self,
        xml_text: str,
        selected_part_hint: str | None,
        section_id: str,
        page_number: int,
        default_tempo: int,
    ) -> dict[str, Any]:
        return extract_musicxml_markings(xml_text, selected_part_hint, section_id, page_number, default_tempo)

    # Score import methods live in analyzer_score_import.ScoreImportMixin.


    def _collect_musicxml_candidates(self, root_dir: Path) -> list[Path]:
        if not root_dir.exists():
            return []

        def priority(path: Path) -> tuple[int, str]:
            suffix = path.suffix.lower()
            if suffix == ".mxl":
                rank = 0
            elif suffix == ".musicxml":
                rank = 1
            else:
                rank = 2
            return (rank, str(path))

        candidates = [
            path
            for path in root_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in {".mxl", ".musicxml", ".xml"}
        ]
        return sorted(candidates, key=priority)


    def _read_musicxml_source(self, source_path: Path) -> str:
        if not source_path.exists():
            return ""
        if source_path.suffix.lower() == ".mxl":
            try:
                with zipfile.ZipFile(source_path) as archive:
                    root_name = ""
                    if "META-INF/container.xml" in archive.namelist():
                        container = ET.fromstring(archive.read("META-INF/container.xml"))
                        rootfile = next((element for element in container.iter() if element.tag.rsplit("}", 1)[-1] == "rootfile"), None)
                        root_name = rootfile.attrib.get("full-path", "") if rootfile is not None else ""
                    if not root_name:
                        root_name = next(
                            (name for name in archive.namelist() if name.lower().endswith((".musicxml", ".xml")) and not name.startswith("META-INF/")),
                            "",
                        )
                    if root_name:
                        return archive.read(root_name).decode("utf-8", errors="ignore")
            except Exception:
                return ""
        try:
            return source_path.read_text("utf-8")
        except UnicodeDecodeError:
            return source_path.read_text("utf-8", errors="ignore")
        except Exception:
            return ""


    def _extract_musicxml_parts(self, xml_text: str) -> list[str]:
        if not xml_text.strip():
            return []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return []

        detected: list[str] = []
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] != "score-part":
                continue
            part_name = ""
            for child in list(element):
                local_tag = child.tag.rsplit("}", 1)[-1]
                if local_tag == "part-name" and child.text:
                    part_name = child.text.strip()
                    break
            part_id = element.attrib.get("id", "").strip()
            candidate = part_name or part_id
            if candidate and candidate not in detected:
                detected.append(candidate)
        return detected


    def _resolve_selected_part(self, detected_parts: list[str], selected_hint: str | None) -> str:
        if not detected_parts:
            return (selected_hint or "erhu").strip() or "erhu"
        normalized_hint = normalize_part_label(selected_hint)
        if normalized_hint:
            for candidate in detected_parts:
                normalized_candidate = normalize_part_label(candidate)
                if normalized_hint in normalized_candidate or normalized_candidate in normalized_hint:
                    return candidate
        preferred_terms = ("二胡", "erhu")
        for candidate in detected_parts:
            normalized_candidate = normalize_part_label(candidate)
            if any(term in candidate.lower() or normalize_part_label(term) in normalized_candidate for term in preferred_terms):
                return candidate
        non_piano = [
            candidate
            for candidate in detected_parts
            if "piano" not in candidate.lower()
            and "钢琴" not in candidate
            and "鋼琴" not in candidate
            and "伴奏" not in candidate
        ]
        return non_piano[0] if non_piano else detected_parts[0]


    def _decode_symbolic_text(self, data: str, encoding: str | None) -> str:
        if not data:
            return ""
        if (encoding or "").lower() == "base64":
            try:
                return base64.b64decode(data).decode("utf-8")
            except Exception:
                return ""
        return data


    def _decode_symbolic_bytes(self, data: str, encoding: str | None) -> bytes:
        if not data:
            return b""
        if (encoding or "").lower() == "base64":
            try:
                return base64.b64decode(data)
            except Exception:
                return b""
        return data.encode("utf-8")


    def _hydrate_piece_notes(self, notes: list[NoteEvent], request: AnalyzeRequest) -> list[SymbolicNote]:
        measure_beats = beats_per_measure(request.piecePack.meter)
        seconds_per_beat = 60.0 / max(request.piecePack.tempo, 30)
        min_measure_index = min((int(note.measureIndex) for note in notes), default=1)
        hydrated: list[SymbolicNote] = []
        for index, note in enumerate(notes, start=1):
            # Imported PDF page/section clips can keep their original page-local
            # measure numbers (for display), but timing must be relative to the
            # analyzed clip. Otherwise a section starting at measure 9 is scored
            # as if eight full measures had elapsed before the clip begins.
            local_measure_offset = max(0, int(note.measureIndex) - min_measure_index)
            absolute_beat = (local_measure_offset * measure_beats) + float(note.beatStart)
            onset = absolute_beat * seconds_per_beat
            duration_seconds = max(0.05, float(note.beatDuration) * seconds_per_beat)
            hydrated.append(
                SymbolicNote(
                    note_id=note.noteId or f"note-{index}",
                    measure_index=int(note.measureIndex),
                    beat_start=float(note.beatStart),
                    beat_duration=float(note.beatDuration),
                    midi_pitch=int(note.midiPitch),
                    expected_onset=onset,
                    expected_offset=onset + duration_seconds,
                    note_position=dict(note.notePosition or {}) if getattr(note, "notePosition", None) else None,
                    articulations=list(getattr(note, "articulations", []) or []),
                    notations=list(getattr(note, "notations", []) or []),
                    techniques=list(getattr(note, "techniques", []) or []),
                    active_tempo=int(getattr(note, "activeTempo", 0) or 0) or None,
                    active_dynamic=str(getattr(note, "activeDynamic", "") or "").strip() or None,
                    dynamic_value=safe_float(getattr(note, "dynamicValue", None), 0.0) or None,
                )
            )
        return hydrated


    def _parse_musicxml_score(self, xml_text: str, request: AnalyzeRequest, selected_part_hint: str | None = None, collapse_melody: bool = True) -> list[SymbolicNote]:
        if not xml_text.strip():
            return []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return []

        def child(node: ET.Element | None, tag: str) -> ET.Element | None:
            if node is None:
                return None
            for element in list(node):
                if element.tag.rsplit("}", 1)[-1] == tag:
                    return element
            return None

        def children(node: ET.Element | None, tag: str) -> list[ET.Element]:
            if node is None:
                return []
            return [element for element in list(node) if element.tag.rsplit("}", 1)[-1] == tag]

        part_names: dict[str, str] = {}
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] != "score-part":
                continue
            part_id = element.attrib.get("id", "").strip()
            part_name = ""
            for node in list(element):
                if node.tag.rsplit("}", 1)[-1] == "part-name" and node.text:
                    part_name = node.text.strip()
                    break
            if part_id:
                part_names[part_id] = part_name or part_id

        part_candidates = [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "part"]
        if not part_candidates:
            return []
        part_candidate_stats = self._extract_musicxml_part_candidates(xml_text, selected_part_hint)
        selected_part_candidate, _selected_part_confidence = self._resolve_selected_part_from_candidates(part_candidate_stats, selected_part_hint)
        preferred_part_label = str((selected_part_candidate or {}).get("label") or (selected_part_candidate or {}).get("name") or "").strip()
        if not preferred_part_label:
            preferred_part_label = self._resolve_selected_part(list(part_names.values()), selected_part_hint)
        preferred_part_id = str((selected_part_candidate or {}).get("id") or "").strip()
        if not preferred_part_id:
            preferred_part_id = next(
                (part_id for part_id, part_name in part_names.items() if part_name == preferred_part_label),
                "",
            )
        part = next(
            (
                element
                for element in part_candidates
                if element.attrib.get("id", "").strip() == preferred_part_id
            ),
            None,
        ) or part_candidates[0]

        defaults_node = child(root, "defaults")
        page_layout = child(defaults_node, "page-layout") if defaults_node is not None else None
        page_width = max(1.0, safe_float(child(page_layout, "page-width").text if page_layout is not None and child(page_layout, "page-width") is not None else 0.0, 1000.0))
        page_height = max(1.0, safe_float(child(page_layout, "page-height").text if page_layout is not None and child(page_layout, "page-height") is not None else 0.0, 1400.0))
        page_left_margin = 0.0
        page_top_margin = 0.0
        if page_layout is not None:
            page_margins = children(page_layout, "page-margins")
            selected_margins = page_margins[0] if page_margins else None
            if selected_margins is not None:
                page_left_margin = safe_float(child(selected_margins, "left-margin").text if child(selected_margins, "left-margin") is not None else 0.0, 0.0)
                page_top_margin = safe_float(child(selected_margins, "top-margin").text if child(selected_margins, "top-margin") is not None else 0.0, 0.0)

        note_events: list[NoteEvent] = []
        divisions = 1.0
        last_note_start = 0.0
        current_clef_sign = "G"
        current_clef_line = 2
        current_clef_octave_change = 0
        current_system_index = 0
        current_system_top_line = page_top_margin + 140.0
        current_system_left = page_left_margin
        current_measure_offset = 0.0
        current_staff_distance = 70.0
        current_tempo = int(getattr(request.piecePack, "tempo", 72) or 72)
        current_dynamic = ""
        current_dynamic_value: float | None = None
        last_system_top_line: float | None = None
        staff_height = 40.0
        page_number_match = re.search(r"page[-\s]?0*(\d+)", str(getattr(request, "sectionId", "") or getattr(request.piecePack, "sectionId", "") or ""), flags=re.IGNORECASE)
        page_number = int(page_number_match.group(1)) if page_number_match else 1

        for measure_position, measure in enumerate(children(part, "measure"), start=1):
            print_node = child(measure, "print")
            new_system = measure_position == 1
            system_layout = child(print_node, "system-layout") if print_node is not None else None
            new_page = print_node is not None and str(print_node.attrib.get("new-page", "")).strip().lower() == "yes"
            if new_page and measure_position > 1:
                page_number += 1
                current_system_index = 0
                current_system_top_line = page_top_margin + 140.0
                current_measure_offset = 0.0
                last_system_top_line = None
                new_system = True
            if print_node is not None and str(print_node.attrib.get("new-system", "")).strip().lower() == "yes":
                new_system = True
            if system_layout is not None:
                new_system = True
            if new_system:
                current_system_index += 1
                left_margin = safe_float(child(child(system_layout, "system-margins"), "left-margin").text if system_layout is not None and child(system_layout, "system-margins") is not None and child(child(system_layout, "system-margins"), "left-margin") is not None else 0.0, 0.0)
                if last_system_top_line is None:
                    top_distance = safe_float(child(system_layout, "top-system-distance").text if system_layout is not None and child(system_layout, "top-system-distance") is not None else 0.0, 0.0)
                    current_system_top_line = page_top_margin + (top_distance if top_distance > 0 else 140.0)
                else:
                    system_distance = safe_float(child(system_layout, "system-distance").text if system_layout is not None and child(system_layout, "system-distance") is not None else 0.0, 0.0)
                    top_distance = safe_float(child(system_layout, "top-system-distance").text if system_layout is not None and child(system_layout, "top-system-distance") is not None else 0.0, 0.0)
                    next_gap = system_distance if system_distance > 0 else (top_distance if top_distance > 0 else 180.0)
                    current_system_top_line = last_system_top_line + staff_height + max(60.0, next_gap)
                current_system_left = page_left_margin + max(0.0, left_margin)
                current_measure_offset = 0.0
                last_system_top_line = current_system_top_line

            attributes = child(measure, "attributes")
            if attributes is not None:
                divisions_node = child(attributes, "divisions")
                if divisions_node is not None and divisions_node.text:
                    divisions = max(1.0, safe_float(divisions_node.text, 1.0))
                staves_node = child(attributes, "staves")
                if staves_node is not None and staves_node.text:
                    staves_count = max(1, int(safe_float(staves_node.text, 1)))
                    current_staff_distance = 70.0 if staves_count <= 1 else 90.0
                clef_nodes = children(attributes, "clef")
                if clef_nodes:
                    clef_node = clef_nodes[0]
                    sign_node = child(clef_node, "sign")
                    line_node = child(clef_node, "line")
                    octave_change_node = child(clef_node, "clef-octave-change")
                    if sign_node is not None and sign_node.text:
                        current_clef_sign = sign_node.text.strip() or current_clef_sign
                    if line_node is not None and line_node.text:
                        current_clef_line = max(1, min(5, int(safe_float(line_node.text, current_clef_line))))
                    current_clef_octave_change = int(safe_float(octave_change_node.text if octave_change_node is not None else 0, 0))

            current_beat = 0.0
            measure_index = parse_musicxml_measure_index(measure.attrib.get("number"), measure_position)
            clef_reference_diatonic, clef_reference_line = musicxml_clef_reference(
                current_clef_sign,
                current_clef_line,
                current_clef_octave_change,
            )
            top_line_diatonic = clef_reference_diatonic + ((5 - clef_reference_line) * 2)
            for direction in children(measure, "direction"):
                sound_node = child(direction, "sound")
                sound_tempo = sound_node.attrib.get("tempo") if sound_node is not None else None
                sound_dynamic = sound_node.attrib.get("dynamics") if sound_node is not None else None
                for direction_type in children(direction, "direction-type"):
                    metronome = child(direction_type, "metronome")
                    per_minute = child(metronome, "per-minute")
                    tempo_value = safe_float(sound_tempo, 0.0) or safe_float(per_minute.text if per_minute is not None else None, 0.0)
                    if tempo_value > 0:
                        current_tempo = int(round(tempo_value))
                    dynamics = child(direction_type, "dynamics")
                    dynamic_label, dynamic_value = extract_dynamic_label(dynamics, sound_dynamic)
                    if dynamic_label:
                        current_dynamic = dynamic_label
                        current_dynamic_value = dynamic_value
                if sound_tempo:
                    tempo_value = safe_float(sound_tempo, 0.0)
                    if tempo_value > 0:
                        current_tempo = int(round(tempo_value))
                if sound_dynamic and not current_dynamic:
                    dynamic_label, dynamic_value = extract_dynamic_label(None, sound_dynamic)
                    if dynamic_label:
                        current_dynamic = dynamic_label
                        current_dynamic_value = dynamic_value
            note_index = 0
            for element in list(measure):
                local_tag = element.tag.rsplit("}", 1)[-1]
                if local_tag in {"backup", "forward"}:
                    duration_node = child(element, "duration")
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
                note_index += 1
                is_rest = child(note, "rest") is not None
                is_chord = child(note, "chord") is not None
                is_grace = child(note, "grace") is not None
                is_cue = child(note, "cue") is not None
                is_unscored_note = is_grace or is_cue
                duration_node = child(note, "duration")
                duration_beats = safe_float(duration_node.text if duration_node is not None else 0.0) / divisions
                if not is_chord:
                    last_note_start = current_beat
                beat_start = last_note_start if is_chord else current_beat

                if not is_rest and not is_unscored_note:
                    pitch = child(note, "pitch")
                    if pitch is not None:
                        step_node = child(pitch, "step")
                        alter_node = child(pitch, "alter")
                        octave_node = child(pitch, "octave")
                        if step_node is not None and octave_node is not None and step_node.text and octave_node.text:
                            step_text = step_node.text.strip()
                            octave_value = int(safe_float(octave_node.text, 4))
                            alter_value = int(safe_float(alter_node.text if alter_node is not None else 0, 0))
                            midi_pitch = musicxml_pitch_to_midi(
                                step_text,
                                octave_value,
                                alter_value,
                            )
                            default_x = safe_float(note.attrib.get("default-x"), 0.0, )
                            staff_node = child(note, "staff")
                            staff_index = max(1, int(safe_float(staff_node.text if staff_node is not None else 1, 1)))
                            note_diatonic = musicxml_step_to_diatonic(step_text, octave_value)
                            staff_offset = float(staff_index - 1) * current_staff_distance
                            absolute_x = current_system_left + current_measure_offset + max(0.0, default_x)
                            absolute_y = current_system_top_line + staff_offset + ((top_line_diatonic - note_diatonic) * 5.0)
                            normalized_x = max(0.0, min(1.0, absolute_x / page_width))
                            normalized_y = max(0.0, min(1.0, absolute_y / page_height))
                            articulations: list[str] = []
                            notations: list[str] = []
                            techniques: list[str] = []
                            notations_node = child(note, "notations")
                            if notations_node is not None:
                                for notation_node in list(notations_node):
                                    local_notation = notation_node.tag.rsplit("}", 1)[-1]
                                    if local_notation in {"articulations", "technical", "ornaments"}:
                                        target = articulations if local_notation == "articulations" else techniques
                                        for sub_node in list(notation_node):
                                            tag = sub_node.tag.rsplit("}", 1)[-1]
                                            if tag:
                                                target.append(tag)
                                    elif local_notation:
                                        notations.append(local_notation)
                            note_events.append(
                                NoteEvent(
                                    noteId=f"xml-m{measure_index}-n{note_index}",
                                    measureIndex=measure_index,
                                    beatStart=beat_start,
                                    beatDuration=max(duration_beats, 0.25),
                                    midiPitch=midi_pitch,
                                    notePosition={
                                        "pageNumber": page_number,
                                        "systemIndex": current_system_index or 1,
                                        "staffIndex": staff_index,
                                        "normalizedX": round(float(normalized_x), 6),
                                        "normalizedY": round(float(normalized_y), 6),
                                        "pageWidth": round(float(page_width), 3),
                                        "pageHeight": round(float(page_height), 3),
                                        "source": "musicxml-layout",
                                    },
                                    articulations=sorted(set(articulations)),
                                    notations=sorted(set(notations)),
                                    techniques=sorted(set(techniques)),
                                    activeTempo=current_tempo,
                                    activeDynamic=current_dynamic,
                                    dynamicValue=current_dynamic_value,
                                )
                            )
                if not is_chord and not is_grace:
                    current_beat += max(duration_beats, 0.0)
            current_measure_offset += max(0.0, safe_float(measure.attrib.get("width"), 0.0))

        explicit_non_erhu_selected_part = bool(
            (selected_part_candidate or {}).get("selectedHintMatch")
            and not bool((selected_part_candidate or {}).get("explicitErhuName"))
            and not bool((selected_part_candidate or {}).get("isLikelyPiano"))
            and int(safe_float((selected_part_candidate or {}).get("staffCount"), 1)) <= 1
            and int(safe_float((selected_part_candidate or {}).get("noteCount"), 0)) > 0
        )
        if not explicit_non_erhu_selected_part:
            note_events = self._annotate_score_line_roles(note_events, selected_part_candidate, part_candidate_stats)
        if collapse_melody and not explicit_non_erhu_selected_part:
            note_events = collapse_erhu_melody_events(note_events)
        return self._hydrate_piece_notes(note_events, request)


    def _annotate_score_line_roles(
        self,
        note_events: list[NoteEvent],
        selected_part_candidate: dict[str, Any] | None,
        part_candidates: list[dict[str, Any]] | None = None,
    ) -> list[NoteEvent]:
        if not note_events:
            return note_events

        clean_solo = is_clean_solo_part_candidate(selected_part_candidate, part_candidates)
        ambiguous = is_ambiguous_part_candidate(selected_part_candidate, part_candidates)
        if not clean_solo and not ambiguous:
            return note_events
        safe_page_melody_projection = (
            ambiguous
            and bool((selected_part_candidate or {}).get("safeForErhuProjection"))
            and not bool((selected_part_candidate or {}).get("isLikelyPiano"))
            and not bool((selected_part_candidate or {}).get("isLikelyAccompanimentSplit"))
            and int(safe_float((selected_part_candidate or {}).get("staffCount"), 1)) <= 1
            and safe_float((selected_part_candidate or {}).get("chordRatio"), 0.0) < 0.08
            and safe_float((selected_part_candidate or {}).get("erhuRangeRatio"), 0.0) >= 0.75
        )
        erhu_range_fallback = should_apply_erhu_range_fallback(
            selected_part_candidate,
            clean_solo,
            ambiguous,
        )

        line_groups: dict[tuple[int, int, int], list[NoteEvent]] = {}
        global_onset_counts: dict[tuple[int, float], int] = {}
        for note in note_events:
            position = getattr(note, "notePosition", None) or {}
            page_number = int(safe_float(position.get("pageNumber"), 1))
            system_index = int(safe_float(position.get("systemIndex"), 1))
            staff_index = int(safe_float(position.get("staffIndex"), 1))
            line_groups.setdefault((page_number, system_index, staff_index), []).append(note)
            onset_key = (int(note.measureIndex), round(float(note.beatStart), 4))
            global_onset_counts[onset_key] = global_onset_counts.get(onset_key, 0) + 1

        page_order: dict[int, list[tuple[int, int, int]]] = {}
        for key, notes in line_groups.items():
            page_number = key[0]
            page_order.setdefault(page_number, []).append(key)
        for page_number, keys in list(page_order.items()):
            page_order[page_number] = sorted(
                keys,
                key=lambda key: median([
                    safe_float((getattr(note, "notePosition", None) or {}).get("normalizedY"), 0.0)
                    for note in line_groups.get(key, [])
                ]),
            )

        system_order: dict[tuple[int, int], list[tuple[int, int, int]]] = {}
        for key in line_groups:
            page_number, system_index, _staff_index = key
            system_order.setdefault((page_number, system_index), []).append(key)
        for system_key, keys in list(system_order.items()):
            system_order[system_key] = sorted(
                keys,
                key=lambda key: median([
                    safe_float((getattr(note, "notePosition", None) or {}).get("normalizedY"), 0.0)
                    for note in line_groups.get(key, [])
                ]),
            )

        line_metric_cache: dict[tuple[int, int, int], dict[str, float]] = {}

        def line_metrics(key: tuple[int, int, int]) -> dict[str, float]:
            if key in line_metric_cache:
                return line_metric_cache[key]
            notes = line_groups.get(key, [])
            line_onset_counts: dict[tuple[int, float], int] = {}
            pitches: list[int] = []
            for note in notes:
                onset_key = (int(note.measureIndex), round(float(note.beatStart), 4))
                line_onset_counts[onset_key] = line_onset_counts.get(onset_key, 0) + 1
                pitches.append(int(note.midiPitch))
            chord_excess = sum(max(0, count - 1) for count in line_onset_counts.values())
            range_hits = sum(1 for value in pitches if 52 <= value <= 96)
            metrics = {
                "note_count": float(len(notes)),
                "chord_ratio": chord_excess / max(1, len(notes)),
                "range_ratio": range_hits / max(1, len(pitches)),
                "pitch_span": float((max(pitches) - min(pitches)) if pitches else 0),
                "median_y": float(median([safe_float((getattr(note, "notePosition", None) or {}).get("normalizedY"), 0.0) for note in notes] or [0.0])),
            }
            line_metric_cache[key] = metrics
            return metrics

        sparse_system_lead_noise: set[tuple[int, int, int]] = set()
        sparse_system_lead_melody: set[tuple[int, int, int]] = set()
        if ambiguous:
            for keys in system_order.values():
                if len(keys) < 2:
                    continue
                first_key = keys[0]
                first_metrics = line_metrics(first_key)
                if first_metrics["note_count"] > 2:
                    continue
                melody_key = next(
                    (
                        candidate_key
                        for candidate_key in keys[1:]
                        if line_metrics(candidate_key)["note_count"] >= 3
                        and line_metrics(candidate_key)["chord_ratio"] < 0.12
                        and line_metrics(candidate_key)["range_ratio"] >= 0.75
                        and line_metrics(candidate_key)["pitch_span"] <= 36
                    ),
                    None,
                )
                if melody_key:
                    sparse_system_lead_noise.add(first_key)
                    sparse_system_lead_melody.add(melody_key)

        def is_erhu_pattern_line(key: tuple[int, int, int]) -> bool:
            page_number, system_index, _staff_index = key
            ordered_system_keys = system_order.get((page_number, system_index), [])
            if len(ordered_system_keys) >= 2:
                return ordered_system_keys.index(key) == 0 if key in ordered_system_keys else False
            ordered_page_keys = page_order.get(page_number, [])
            if safe_page_melody_projection and (
                len(ordered_page_keys) >= 2 or line_metrics(key)["note_count"] >= 4
            ):
                return True
            line_count = max(1, len(ordered_page_keys))
            line_rank = ordered_page_keys.index(key) if key in ordered_page_keys else 0
            if line_count == 1:
                return True
            if line_count == 2:
                return line_rank == 0
            return line_rank % 3 == 0

        page_has_dense_erhu_pattern_line: dict[int, bool] = {}
        for page_number, ordered_keys in page_order.items():
            dense_pattern_found = False
            for candidate_key in ordered_keys:
                if is_erhu_pattern_line(candidate_key) and len(line_groups.get(candidate_key, [])) >= 3:
                    dense_pattern_found = True
                    break
            page_has_dense_erhu_pattern_line[page_number] = dense_pattern_found

        line_roles: dict[tuple[int, int, int], tuple[str, float, str]] = {}
        for key, notes in line_groups.items():
            page_number = key[0]
            ordered_keys = page_order.get(page_number, [])
            line_rank = ordered_keys.index(key) if key in ordered_keys else 0
            line_count = max(1, len(ordered_keys))
            ordered_system_keys = system_order.get((key[0], key[1]), [])
            system_line_rank = ordered_system_keys.index(key) if key in ordered_system_keys else 0
            system_line_count = max(1, len(ordered_system_keys))

            if clean_solo:
                line_roles[key] = ("erhu", 0.92, "clean-solo-part")
                continue

            onset_counts: dict[tuple[int, float], int] = {}
            pitches: list[int] = []
            for note in notes:
                onset_key = (int(note.measureIndex), round(float(note.beatStart), 4))
                onset_counts[onset_key] = onset_counts.get(onset_key, 0) + 1
                pitches.append(int(note.midiPitch))
            chord_excess = sum(max(0, count - 1) for count in onset_counts.values())
            chord_ratio = chord_excess / max(1, len(notes))
            range_hits = sum(1 for value in pitches if 52 <= value <= 96)
            range_ratio = range_hits / max(1, len(pitches))
            pitch_span = (max(pitches) - min(pitches)) if pitches else 0

            erhu_pattern_score = 0.0
            if system_line_count >= 2:
                erhu_pattern_score = 0.76 if system_line_rank == 0 else 0.14
            elif (ambiguous and line_count == 1 and system_line_count == 1 and len(notes) >= 6
                  and chord_ratio <= 0.08 and range_ratio >= 0.78 and pitch_span <= 36 and line_metrics(key)["median_y"] <= 0.52):
                erhu_pattern_score = 0.72
            elif safe_page_melody_projection and (line_count >= 2 or len(notes) >= 4):
                erhu_pattern_score = 0.74
            elif line_count == 1:
                erhu_pattern_score = 0.42
            elif line_count == 2:
                erhu_pattern_score = 0.74 if line_rank == 0 else 0.18
            else:
                erhu_pattern_score = 0.74 if line_rank % 3 == 0 else 0.14
            if key in sparse_system_lead_melody:
                erhu_pattern_score = max(erhu_pattern_score, 0.74)

            confidence = erhu_pattern_score
            confidence += min(0.12, range_ratio * 0.12)
            confidence += 0.06 if pitch_span <= 36 else -0.05
            confidence -= min(0.18, chord_ratio * 0.75)
            if chord_ratio >= 0.18:
                # Piano/accompaniment lines are commonly polyphonic.  When the
                # imported part is ambiguous, do not allow a chord-dense line to
                # be projected as the erhu melody even if it is visually high.
                confidence = min(confidence - 0.18, 0.58)
            if ambiguous and line_count >= 4 and len(notes) <= 2 and page_has_dense_erhu_pattern_line.get(page_number, False):
                # Full-score OMR often turns title/text fragments or isolated
                # accompaniment artifacts into one or two pitched events above
                # the real system.  In student-facing diagnosis it is safer to
                # suppress those sparse pseudo-lines than to highlight them as
                # erhu issues.
                confidence = min(confidence - 0.22, 0.58)
            if key in sparse_system_lead_noise:
                # A very sparse pseudo-line above a dense monophonic line is more
                # likely an OMR text/ornament artifact than the erhu melody.
                confidence = min(confidence - 0.22, 0.58)
            confidence = max(0.05, min(0.9, confidence))
            role = "erhu" if confidence >= 0.66 else "accompaniment"
            source = "single-line-melody" if erhu_pattern_score >= 0.72 and line_count == 1 else "omr-line-split"
            line_roles[key] = (role, round(confidence, 3), source)

        apply_page_erhu_fallback(ambiguous, line_roles, page_order, system_order, line_metrics, sparse_system_lead_noise)

        annotated: list[NoteEvent] = []
        for note in note_events:
            position = dict(getattr(note, "notePosition", None) or {})
            key = (
                int(safe_float(position.get("pageNumber"), 1)),
                int(safe_float(position.get("systemIndex"), 1)),
                int(safe_float(position.get("staffIndex"), 1)),
            )
            role, confidence, source = line_roles.get(key, ("unknown", 0.0, "none"))
            if erhu_range_fallback and role != "erhu":
                metrics = line_metrics(key)
                page_number = key[0]
                ordered_keys = page_order.get(page_number, [])
                sparse_page_noise = (
                    ambiguous
                    and len(ordered_keys) >= 4
                    and len(line_groups.get(key, [])) <= 2
                    and page_has_dense_erhu_pattern_line.get(page_number, False)
                )
                onset_key = (int(note.measureIndex), round(float(note.beatStart), 4))
                if (
                    62 <= int(note.midiPitch) <= 93
                    and global_onset_counts.get(onset_key, 0) == 1
                    and metrics["chord_ratio"] <= 0.08
                    and metrics["range_ratio"] >= 0.75
                    and key not in sparse_system_lead_noise
                    and not sparse_page_noise
                ):
                    role = "erhu"
                    confidence = max(float(confidence), 0.68)
                    source = "erhu-range-fallback"
            position.update(
                {
                    "scoreLineRole": role,
                    "scoreLineConfidence": confidence,
                    "scoreLineSource": source,
                    "scoreLineId": f"p{key[0]}-sys{key[1]}-staff{key[2]}",
                }
            )
            annotated.append(
                NoteEvent(
                    noteId=note.noteId,
                    measureIndex=int(note.measureIndex),
                    beatStart=float(note.beatStart),
                    beatDuration=float(note.beatDuration),
                    midiPitch=int(note.midiPitch),
                    notePosition=position,
                    articulations=list(getattr(note, "articulations", []) or []),
                    notations=list(getattr(note, "notations", []) or []),
                    techniques=list(getattr(note, "techniques", []) or []),
                    activeTempo=int(getattr(note, "activeTempo", 0) or 0) or None,
                    activeDynamic=str(getattr(note, "activeDynamic", "") or "").strip() or None,
                    dynamicValue=safe_float(getattr(note, "dynamicValue", None), 0.0) or None,
                )
            )
        return annotated


    def _should_apply_erhu_range_fallback(
        self,
        selected_part_candidate: dict[str, Any] | None,
        clean_solo: bool,
        ambiguous: bool,
    ) -> bool:
        return should_apply_erhu_range_fallback(selected_part_candidate, clean_solo, ambiguous)


    def _parse_midi_score(self, midi_bytes: bytes, request: AnalyzeRequest) -> list[SymbolicNote]:
        if not midi_bytes or pretty_midi is None:
            return []
        with tempfile.TemporaryDirectory(prefix="ai-erhu-midi-") as temp_dir:
            midi_path = os.path.join(temp_dir, "score.mid")
            with open(midi_path, "wb") as handle:
                handle.write(midi_bytes)
            try:
                midi_file = pretty_midi.PrettyMIDI(midi_path)
            except Exception:
                return []

        instruments = [instrument for instrument in midi_file.instruments if not instrument.is_drum and instrument.notes]
        if not instruments:
            instruments = [instrument for instrument in midi_file.instruments if instrument.notes]
        if not instruments:
            return []

        instrument = max(instruments, key=lambda item: len(item.notes))
        tempo_changes, tempi = midi_file.get_tempo_changes()
        seconds_per_beat = 60.0 / max(request.piecePack.tempo, 30)
        if len(tempi):
            seconds_per_beat = 60.0 / max(float(tempi[0]), 30.0)
        measure_beats = beats_per_measure(request.piecePack.meter)

        note_events: list[NoteEvent] = []
        for index, note in enumerate(sorted(instrument.notes, key=lambda item: item.start), start=1):
            absolute_beats = note.start / seconds_per_beat if seconds_per_beat > 0 else 0.0
            beat_duration = max(0.25, (note.end - note.start) / seconds_per_beat if seconds_per_beat > 0 else 0.25)
            measure_index = int(absolute_beats // measure_beats) + 1
            beat_start = absolute_beats - ((measure_index - 1) * measure_beats)
            note_events.append(
                NoteEvent(
                    noteId=f"midi-n{index}",
                    measureIndex=measure_index,
                    beatStart=beat_start,
                    beatDuration=beat_duration,
                    midiPitch=int(note.pitch),
                )
            )

        return self._hydrate_piece_notes(note_events, request)
