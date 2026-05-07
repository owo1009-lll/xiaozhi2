# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import re
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from analyzer_utils import beats_per_measure, parse_musicxml_measure_index, safe_float
from schemas import AnalyzeRequest, MusicXmlImportRequest, NoteEvent, PiecePack, ScoreImportJobResult, ScoreImportRequest

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover - optional dependency
    PdfReader = None


class ScoreImportMixin:
    def _parse_musicxml_source_to_section(
        self,
        source_path: Path,
        request: ScoreImportRequest,
        selected_part_hint: str,
        section_id: str,
        section_title: str,
        sequence_index: int,
    ) -> tuple[dict[str, Any] | None, list[str], str, list[dict[str, Any]], dict[str, Any]]:
        xml_text = self._read_musicxml_source(source_path)
        if not xml_text.strip():
            return None, [], selected_part_hint, [], {}

        detected_parts = self._extract_musicxml_parts(xml_text)
        part_candidates = self._extract_musicxml_part_candidates(xml_text, selected_part_hint)
        resolved_candidate, selected_part_confidence = self._resolve_selected_part_from_candidates(part_candidates, selected_part_hint)
        resolved_part = str((resolved_candidate or {}).get("selectionKey") or (resolved_candidate or {}).get("id") or "").strip()
        resolved_part_label = str((resolved_candidate or {}).get("label") or (resolved_candidate or {}).get("name") or "").strip()
        resolved_part_id = str((resolved_candidate or {}).get("id") or "").strip()
        if not resolved_part:
            resolved_part = self._resolve_selected_part(detected_parts, selected_part_hint)
        if not resolved_part_label:
            resolved_part_label = self._resolve_selected_part(detected_parts, selected_part_hint)
        detected_tempo = self._extract_musicxml_tempo(xml_text)
        # If MusicXML has no tempo (Audiveris missed it), try image-based OCR on the page PDF.
        # Typical layout: pagewise/page-NNN/page-NNN.mxl → PDF at pagewise/page-NNN.pdf
        if detected_tempo == 72:
            page_stem = source_path.stem.split(".")[0]  # "page-001" from "page-001.mvt2"
            page_pdf = source_path.parent.parent / (page_stem + ".pdf")
            if not page_pdf.exists():
                page_pdf = source_path.parent / (page_stem + ".pdf")
            if not page_pdf.exists():
                page_pdf = source_path.with_suffix(".pdf")
            if page_pdf.exists():
                ocr_tempo = self._extract_tempo_from_pdf_image(page_pdf)
                if ocr_tempo:
                    detected_tempo = ocr_tempo
        temp_request = AnalyzeRequest(
            participantId="score-import",
            pieceId=request.jobId,
            sectionId=section_id,
            piecePack={
                "pieceId": request.jobId,
                "sectionId": section_id,
                "title": request.titleHint or request.originalFilename or request.jobId,
                "meter": "4/4",
                "tempo": detected_tempo,
                "notes": [],
                "scoreSource": {"format": "musicxml", "encoding": "utf-8", "data": xml_text},
            },
        )
        refined_candidate = self._refine_selected_part_candidate_with_layout(
            xml_text,
            temp_request,
            part_candidates,
            resolved_candidate,
        )
        if refined_candidate is not None:
            resolved_candidate = refined_candidate
            resolved_part = str((resolved_candidate or {}).get("selectionKey") or (resolved_candidate or {}).get("id") or resolved_part).strip() or resolved_part
            resolved_part_label = str((resolved_candidate or {}).get("label") or (resolved_candidate or {}).get("name") or resolved_part_label).strip() or resolved_part_label
            resolved_part_id = str((resolved_candidate or {}).get("id") or resolved_part_id).strip() or resolved_part_id
            selected_part_confidence = float((resolved_candidate or {}).get("selectedPartConfidence", selected_part_confidence or 0.0))
        parsed_notes = self._parse_musicxml_score(xml_text, temp_request, resolved_part)
        if not parsed_notes:
            return None, detected_parts, resolved_part, part_candidates, {}
        page_number_match = re.search(r"page[-\s]?0*(\d+)", section_id, flags=re.IGNORECASE)
        page_number = int(page_number_match.group(1)) if page_number_match else 1
        score_markings = self._extract_musicxml_markings(
            xml_text,
            resolved_part,
            section_id,
            page_number,
            detected_tempo,
        )
        score_line_counts: dict[str, int] = {}
        score_line_sources: dict[str, int] = {}
        for note in parsed_notes:
            note_position = getattr(note, "note_position", None) or {}
            role = str(note_position.get("scoreLineRole") or "missing")
            source = str(note_position.get("scoreLineSource") or "missing")
            score_line_counts[role] = score_line_counts.get(role, 0) + 1
            score_line_sources[source] = score_line_sources.get(source, 0) + 1
        score_line_note_count = max(1, len(parsed_notes))
        score_line_stats = {
            "noteCount": len(parsed_notes),
            "erhuNoteCount": int(score_line_counts.get("erhu", 0)),
            "accompanimentNoteCount": int(score_line_counts.get("accompaniment", 0)),
            "unknownNoteCount": int(score_line_counts.get("unknown", 0) + score_line_counts.get("missing", 0)),
            "erhuRatio": round(float(score_line_counts.get("erhu", 0)) / score_line_note_count, 3),
            "splitApplied": bool(score_line_counts.get("erhu", 0) and score_line_counts.get("accompaniment", 0)),
            "roleCounts": score_line_counts,
            "sourceCounts": score_line_sources,
        }

        section = {
            "sectionId": section_id,
            "title": section_title,
            "tempo": detected_tempo,
            "meter": "4/4",
            "demoAudio": "",
            "sequenceIndex": sequence_index,
            "notes": [
                {
                    "noteId": note.note_id,
                    "measureIndex": note.measure_index,
                    "beatStart": note.beat_start,
                    "beatDuration": note.beat_duration,
                    "midiPitch": note.midi_pitch,
                    "notePosition": dict(note.note_position or {}) if getattr(note, "note_position", None) else None,
                    "articulations": list(note.articulations or []),
                    "notations": list(note.notations or []),
                    "techniques": list(note.techniques or []),
                    "activeTempo": note.active_tempo or detected_tempo,
                    "activeDynamic": note.active_dynamic or "",
                    "dynamicValue": note.dynamic_value,
                }
                for note in parsed_notes
            ],
            "markings": score_markings.get("markings", []),
            "tempoChanges": score_markings.get("tempoChanges", []),
            "dynamicChanges": score_markings.get("dynamicChanges", []),
            "repeatStructure": score_markings.get("repeatStructure", []),
            "partCandidates": part_candidates,
            "selectedPart": resolved_part_label or resolved_part,
            "selectedPartId": resolved_part_id,
            "selectedPartConfidence": round(float(selected_part_confidence or 0.0), 3),
            "erhuProjectionMode": "exact" if bool((resolved_candidate or {}).get("safeForErhuProjection")) else "blocked",
            "erhuProjectionReason": "" if bool((resolved_candidate or {}).get("safeForErhuProjection")) else "no-safe-erhu-part-candidate",
            "scoreLineStats": score_line_stats,
        }
        return section, detected_parts, resolved_part_label or resolved_part, part_candidates, score_markings.get("markingStats", {})

    def _extract_selected_part_measure_sequence(self, xml_text: str, selected_part_hint: str | None) -> list[int]:
        if not xml_text.strip():
            return []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return []

        candidates = self._extract_musicxml_part_candidates(xml_text, selected_part_hint)
        selected_candidate, _ = self._resolve_selected_part_from_candidates(candidates, selected_part_hint)
        selected_part_id = str((selected_candidate or {}).get("id") or "").strip()
        parts = [element for element in root.iter() if self._xml_local_tag(element) == "part"]
        part = next(
            (
                element
                for element in parts
                if selected_part_id and element.attrib.get("id", "").strip() == selected_part_id
            ),
            parts[0] if parts else None,
        )
        if part is None:
            return []
        return [
            parse_musicxml_measure_index(measure.attrib.get("number"), measure_position)
            for measure_position, measure in enumerate(self._xml_children(part, "measure"), start=1)
        ]

    def _apply_pagewise_global_measure_numbers(
        self,
        section: dict[str, Any],
        xml_text: str,
        selected_part_hint: str | None,
        first_global_measure: int,
        page_index: int,
    ) -> tuple[dict[str, Any], int]:
        notes = list(section.get("notes") or [])
        measure_sequence = self._extract_selected_part_measure_sequence(xml_text, selected_part_hint)
        if not measure_sequence:
            seen_note_measures: list[int] = []
            for note in notes:
                measure_index = max(1, int(safe_float(note.get("measureIndex"), 1)))
                if measure_index not in seen_note_measures:
                    seen_note_measures.append(measure_index)
            measure_sequence = seen_note_measures
        if not measure_sequence:
            return section, first_global_measure

        local_to_global: dict[int, int] = {}
        for offset, local_measure in enumerate(measure_sequence):
            local_to_global.setdefault(int(local_measure), first_global_measure + offset)
        note_fallback_ordinals: dict[int, int] = {}
        next_fallback_ordinal = len(measure_sequence)

        def map_measure(local_measure: int) -> int:
            nonlocal next_fallback_ordinal
            local_measure = max(1, int(local_measure))
            if local_measure in local_to_global:
                return local_to_global[local_measure]
            if local_measure not in note_fallback_ordinals:
                note_fallback_ordinals[local_measure] = next_fallback_ordinal
                next_fallback_ordinal += 1
            return first_global_measure + note_fallback_ordinals[local_measure]

        for note_order, note in enumerate(notes, start=1):
            local_measure = max(1, int(safe_float(note.get("measureIndex"), 1)))
            global_measure = map_measure(local_measure)
            note_position = dict(note.get("notePosition") or {})
            note_position.setdefault("localMeasureIndex", local_measure)
            note_position["globalMeasureIndex"] = global_measure
            note_position["measureNumberSource"] = "pagewise-count"
            note["notePosition"] = note_position
            note["measureIndex"] = global_measure
            original_note_id = str(note.get("noteId") or "")
            note_position.setdefault("localNoteId", original_note_id)
            note_index_match = re.search(r"-n(\d+)\b", original_note_id)
            note_index = int(note_index_match.group(1)) if note_index_match else note_order
            note["noteId"] = f"xml-m{global_measure}-n{note_index}"

        for collection_key in ("markings", "tempoChanges", "dynamicChanges", "repeatStructure"):
            for item in list(section.get(collection_key) or []):
                if not isinstance(item, dict):
                    continue
                local_measure = max(1, int(safe_float(item.get("measureIndex"), 1)))
                item["localMeasureIndex"] = local_measure
                item["measureIndex"] = map_measure(local_measure)
                item["measureNumberSource"] = "pagewise-count"

        global_measures = [
            int(note.get("measureIndex", 0))
            for note in notes
            if int(safe_float(note.get("measureIndex"), 0)) > 0
        ]
        if global_measures:
            section["measureRange"] = [min(global_measures), max(global_measures)]
        section["measureNumbering"] = {
            "source": "pagewise-count",
            "pageIndex": page_index,
            "firstGlobalMeasure": first_global_measure,
            "lastGlobalMeasure": first_global_measure + len(measure_sequence) - 1,
            "localMeasureCount": len(measure_sequence),
        }
        return section, first_global_measure + next_fallback_ordinal

    def _build_piece_pack_from_musicxml_sources(
        self,
        musicxml_sources: list[Path],
        request: ScoreImportRequest,
        selected_part_hint: str,
    ) -> tuple[dict[str, Any] | None, list[str], str]:
        sections: list[dict[str, Any]] = []
        detected_parts: list[str] = []
        all_part_candidates: list[dict[str, Any]] = []
        aggregate_marking_stats: dict[str, int] = {
            "markingCount": 0,
            "tempoChangeCount": 0,
            "dynamicChangeCount": 0,
            "repeatCount": 0,
        }
        aggregate_score_line_stats: dict[str, int] = {
            "noteCount": 0,
            "erhuNoteCount": 0,
            "accompanimentNoteCount": 0,
            "unknownNoteCount": 0,
        }
        resolved_part = selected_part_hint or "erhu"
        resolved_part_label = selected_part_hint or "erhu"
        resolved_part_id = ""
        multiple_sources = len(musicxml_sources) > 1
        next_global_measure = 1

        for index, source_path in enumerate(musicxml_sources, start=1):
            section_id = "section-a" if not multiple_sources and index == 1 else f"page-{index:02d}"
            section_title = "自动识谱段落" if not multiple_sources and index == 1 else f"自动识谱第 {index} 页"
            section, parts, next_resolved_part, part_candidates, marking_stats = self._parse_musicxml_source_to_section(
                source_path,
                request,
                resolved_part,
                section_id,
                section_title,
                index,
            )
            for candidate in part_candidates:
                candidate_key = str(candidate.get("selectionKey") or candidate.get("id") or candidate.get("label") or candidate.get("name") or "").strip()
                if candidate_key and not any(
                    str(existing.get("selectionKey") or existing.get("id") or existing.get("label") or existing.get("name") or "").strip() == candidate_key
                    for existing in all_part_candidates
                ):
                    all_part_candidates.append(candidate)
            for key in aggregate_marking_stats:
                aggregate_marking_stats[key] += int(safe_float(marking_stats.get(key), 0))
            for part_name in parts:
                if part_name and part_name not in detected_parts:
                    detected_parts.append(part_name)
            resolved_part = next_resolved_part or resolved_part
            if section:
                resolved_part_label = str(section.get("selectedPart") or resolved_part_label or resolved_part).strip() or resolved_part_label
                resolved_part_id = str(section.get("selectedPartId") or resolved_part_id).strip()
                if multiple_sources:
                    xml_text = self._read_musicxml_source(source_path)
                    section, next_global_measure = self._apply_pagewise_global_measure_numbers(
                        section,
                        xml_text,
                        resolved_part_id or resolved_part,
                        next_global_measure,
                        index,
                    )
                section_line_stats = section.get("scoreLineStats") or {}
                for key in aggregate_score_line_stats:
                    aggregate_score_line_stats[key] += int(safe_float(section_line_stats.get(key), 0))
                page_image_path = ""
                if request.outputDir:
                    candidate_image = Path(request.outputDir) / "pagewise" / f"page-{index:03d}.png"
                    if candidate_image.exists():
                        page_image_path = f"/data/score-imports/{request.jobId}/pagewise/{candidate_image.name}"
                if page_image_path:
                    section["pageImagePath"] = page_image_path
                sections.extend(self._chunk_imported_section(section))

        if not sections:
            return None, detected_parts or [selected_part_hint], resolved_part_label or resolved_part

        piece_pack = {
            "pieceId": request.jobId,
            "title": request.titleHint or request.originalFilename or request.jobId,
            "composer": "Audiveris OMR",
            "selectedPart": resolved_part_label or resolved_part,
            "selectedPartId": resolved_part_id,
            "detectedParts": detected_parts or [resolved_part_label or resolved_part],
            "selectedPartConfidence": round(
                float(
                    next(
                        (
                            item.get("selectedPartConfidence", item.get("score", 0.0))
                            for item in all_part_candidates
                            if (
                                str(item.get("selectionKey") or item.get("id") or "").strip() == resolved_part
                                or str(item.get("id") or "").strip() == resolved_part_id
                                or str(item.get("label") or item.get("name") or "").strip() == resolved_part_label
                            )
                        ),
                        0.0,
                    )
                ),
                3,
            ),
            "partCandidates": all_part_candidates,
            "markingStats": aggregate_marking_stats,
            "scoreLineStats": {
                **aggregate_score_line_stats,
                "erhuRatio": round(
                    float(aggregate_score_line_stats.get("erhuNoteCount", 0))
                    / max(1, int(aggregate_score_line_stats.get("noteCount", 0))),
                    3,
                ),
                "splitApplied": bool(
                    aggregate_score_line_stats.get("erhuNoteCount", 0)
                    and aggregate_score_line_stats.get("accompanimentNoteCount", 0)
                ),
            },
            "sections": sections,
        }
        return piece_pack, list(piece_pack["detectedParts"]), resolved_part_label or resolved_part

    def _chunk_imported_section(self, section: dict[str, Any]) -> list[dict[str, Any]]:
        notes = list(section.get("notes") or [])
        if not notes:
            return [section]
        if len(notes) <= 20:
            return [section]

        measure_beats = beats_per_measure(section.get("meter"))
        ordered_notes = sorted(
            notes,
            key=lambda note: (
                int(note.get("measureIndex", 0)),
                float(note.get("beatStart", 0.0)),
                float(note.get("beatDuration", 0.0)),
                int(note.get("midiPitch", 0)),
            ),
        )
        enriched_notes: list[dict[str, Any]] = []
        measure_groups: dict[int, list[dict[str, Any]]] = {}
        absolute_beat_min = math.inf
        absolute_beat_max = 0.0
        for note in ordered_notes:
            measure_index = max(1, int(note.get("measureIndex", 1)))
            beat_start = float(note.get("beatStart", 0.0))
            beat_duration = max(0.125, float(note.get("beatDuration", 0.0)) or 0.25)
            absolute_start = ((measure_index - 1) * measure_beats) + beat_start
            absolute_end = absolute_start + beat_duration
            enriched_note = {
                **note,
                "_absoluteBeatStart": absolute_start,
                "_absoluteBeatEnd": absolute_end,
            }
            enriched_notes.append(enriched_note)
            measure_groups.setdefault(measure_index, []).append(enriched_note)
            absolute_beat_min = min(absolute_beat_min, absolute_start)
            absolute_beat_max = max(absolute_beat_max, absolute_end)

        total_measure_count = len(measure_groups)
        total_beat_span = max(0.0, absolute_beat_max - (0.0 if math.isinf(absolute_beat_min) else absolute_beat_min))
        note_density = float(len(enriched_notes)) / max(1, total_measure_count)
        if len(enriched_notes) <= 36 and total_measure_count <= 3 and total_beat_span <= 12.0:
            return [section]

        dense_import = len(enriched_notes) >= 100 or note_density >= 10.0 or total_beat_span >= 28.0
        very_dense_import = len(enriched_notes) >= 180 or note_density >= 16.0 or total_beat_span >= 48.0
        target_note_count = 22 if very_dense_import else (30 if dense_import else 40)
        max_note_count = 34 if very_dense_import else (46 if dense_import else 58)
        target_measure_span = 2 if very_dense_import else (3 if dense_import else 4)
        max_measure_span = target_measure_span + 1
        target_beat_span = 8.0 if very_dense_import else (12.0 if dense_import else 16.0)
        hard_beat_span = target_beat_span + 4.0
        gap_trigger_beats = 1.25 if dense_import else 1.75

        chunks: list[dict[str, Any]] = []
        current_notes: list[dict[str, Any]] = []
        current_measures: list[int] = []
        current_beat_start = 0.0
        current_beat_end = 0.0

        def flush_chunk() -> None:
            nonlocal current_notes, current_measures, current_beat_start, current_beat_end
            if not current_notes:
                return
            chunk_index = len(chunks) + 1
            base_sequence = int(section.get("sequenceIndex", 1))
            sanitized_notes = [
                {
                    key: value
                    for key, value in note.items()
                    if not str(key).startswith("_")
                }
                for note in current_notes
            ]
            chunk_role_counts: dict[str, int] = {}
            for note in sanitized_notes:
                role = str((note.get("notePosition") or {}).get("scoreLineRole") or "missing")
                chunk_role_counts[role] = chunk_role_counts.get(role, 0) + 1
            chunk_note_count = max(1, len(sanitized_notes))
            chunk = {
                **section,
                "sectionId": f"{section.get('sectionId', 'section')}-s{chunk_index:02d}",
                "title": f"{section.get('title', '自动识谱段落')} 片段 {chunk_index}",
                "sequenceIndex": (base_sequence * 100) + chunk_index,
                "notes": sanitized_notes,
                "sourceSectionId": section.get("sectionId", ""),
                "measureRange": [min(current_measures), max(current_measures)] if current_measures else [],
                "chunkBeatRange": [round(current_beat_start, 3), round(current_beat_end, 3)] if current_notes else [],
                "chunkedImported": True,
                "scoreLineStats": {
                    "noteCount": len(sanitized_notes),
                    "erhuNoteCount": int(chunk_role_counts.get("erhu", 0)),
                    "accompanimentNoteCount": int(chunk_role_counts.get("accompaniment", 0)),
                    "unknownNoteCount": int(chunk_role_counts.get("unknown", 0) + chunk_role_counts.get("missing", 0)),
                    "erhuRatio": round(float(chunk_role_counts.get("erhu", 0)) / chunk_note_count, 3),
                    "splitApplied": bool(chunk_role_counts.get("erhu", 0) and chunk_role_counts.get("accompaniment", 0)),
                    "roleCounts": chunk_role_counts,
                },
            }
            chunks.append(chunk)
            current_notes = []
            current_measures = []
            current_beat_start = 0.0
            current_beat_end = 0.0

        measure_items = sorted(measure_groups.items(), key=lambda item: item[0])
        for measure_index, measure_notes in measure_items:
            measure_start = min(float(note.get("_absoluteBeatStart", 0.0)) for note in measure_notes)
            measure_end = max(float(note.get("_absoluteBeatEnd", 0.0)) for note in measure_notes)
            if current_notes and (
                (
                    (measure_start - current_beat_end) > gap_trigger_beats
                    and len(current_notes) >= max(8, target_note_count // 2)
                )
                or ((max(current_measures) - min(current_measures) + 1) >= max_measure_span)
                or ((current_beat_end - current_beat_start) >= hard_beat_span)
                or (len(current_notes) + len(measure_notes) > max_note_count)
                or (
                    len(current_notes) >= target_note_count
                    and (
                        len(current_measures) >= target_measure_span
                        or (current_beat_end - current_beat_start) >= target_beat_span
                    )
                )
            ):
                flush_chunk()
            current_notes.extend(measure_notes)
            current_measures.append(measure_index)
            current_beat_start = measure_start if len(current_notes) == len(measure_notes) else min(current_beat_start, measure_start)
            current_beat_end = max(current_beat_end, measure_end)
        flush_chunk()

        if len(chunks) >= 2 and len(chunks[-1]["notes"]) < 12:
            tail = chunks.pop()
            chunks[-1]["notes"].extend(tail["notes"])
            merged_role_counts: dict[str, int] = {}
            for note in chunks[-1]["notes"]:
                role = str((note.get("notePosition") or {}).get("scoreLineRole") or "missing")
                merged_role_counts[role] = merged_role_counts.get(role, 0) + 1
            merged_note_count = max(1, len(chunks[-1]["notes"]))
            chunks[-1]["scoreLineStats"] = {
                "noteCount": len(chunks[-1]["notes"]),
                "erhuNoteCount": int(merged_role_counts.get("erhu", 0)),
                "accompanimentNoteCount": int(merged_role_counts.get("accompaniment", 0)),
                "unknownNoteCount": int(merged_role_counts.get("unknown", 0) + merged_role_counts.get("missing", 0)),
                "erhuRatio": round(float(merged_role_counts.get("erhu", 0)) / merged_note_count, 3),
                "splitApplied": bool(merged_role_counts.get("erhu", 0) and merged_role_counts.get("accompaniment", 0)),
                "roleCounts": merged_role_counts,
            }
            measure_range = list(chunks[-1].get("measureRange") or [])
            tail_range = list(tail.get("measureRange") or [])
            if measure_range and tail_range:
                chunks[-1]["measureRange"] = [min(measure_range[0], tail_range[0]), max(measure_range[-1], tail_range[-1])]
            beat_range = list(chunks[-1].get("chunkBeatRange") or [])
            tail_beat_range = list(tail.get("chunkBeatRange") or [])
            if beat_range and tail_beat_range:
                chunks[-1]["chunkBeatRange"] = [min(beat_range[0], tail_beat_range[0]), max(beat_range[-1], tail_beat_range[-1])]

        return chunks or [section]

    def import_pdf_score(self, request: ScoreImportRequest) -> ScoreImportJobResult:
        output_dir = Path(request.outputDir or (Path(self.settings.data_root) / "score-imports" / request.jobId))
        output_dir.mkdir(parents=True, exist_ok=True)

        pdf_path = Path(request.pdfPath)
        selected_part = (request.selectedPartHint or "erhu").strip() or "erhu"
        preview_pages = self._build_preview_pages(pdf_path, request.jobId)
        pdf_page_count = 1
        if PdfReader is not None:
            try:
                pdf_page_count = max(1, len(PdfReader(str(pdf_path)).pages))
            except Exception:
                pdf_page_count = 1
        try:
            pdf_file_size_bytes = max(0, int(pdf_path.stat().st_size))
        except Exception:
            pdf_file_size_bytes = 0

        warnings: list[str] = []
        piece_pack = None
        musicxml_path = ""
        omr_confidence = 0.0
        detected_parts: list[str] = [selected_part]
        omr_stats: dict[str, Any] = {"mode": "none", "pageCount": pdf_page_count}

        audiveris_cli = self.settings.audiveris_cli.strip()
        if audiveris_cli and os.path.exists(audiveris_cli):
            musicxml_sources: list[Path] = []
            generated_musicxml = None
            whole_pdf_attempted = False
            whole_pdf_skipped_reason = ""
            whole_pdf_max_pages = max(1, int(self.settings.omr_whole_pdf_max_pages))
            whole_pdf_max_file_mb = max(0.0, float(self.settings.omr_whole_pdf_max_file_mb))
            whole_pdf_size_limit_bytes = int(whole_pdf_max_file_mb * 1024 * 1024) if whole_pdf_max_file_mb > 0 else 0
            within_whole_pdf_page_limit = pdf_page_count <= whole_pdf_max_pages
            within_whole_pdf_size_limit = (
                whole_pdf_size_limit_bytes <= 0
                or pdf_file_size_bytes <= 0
                or pdf_file_size_bytes <= whole_pdf_size_limit_bytes
            )
            if within_whole_pdf_page_limit and within_whole_pdf_size_limit:
                whole_pdf_attempted = True
                generated_musicxml = self._run_audiveris(pdf_path, output_dir)
            else:
                whole_pdf_skipped_reason = "page-count" if not within_whole_pdf_page_limit else "file-size"
                if whole_pdf_skipped_reason == "file-size":
                    warnings.append("Large PDF skipped whole-file OMR and used pagewise OMR to reduce first import latency.")
                else:
                    warnings.append("Multi-page PDF used pagewise OMR directly to reduce import latency.")
            if generated_musicxml:
                musicxml_sources = [Path(generated_musicxml)]
                musicxml_path = generated_musicxml
                omr_confidence = 0.82
                omr_stats = {
                    "mode": "whole-pdf",
                    "pageCount": pdf_page_count,
                    "resultCount": 1,
                    "wholePdfAttempted": True,
                    "wholePdfSkippedReason": "",
                    "wholePdfMaxFileMb": whole_pdf_max_file_mb,
                    "pdfFileSizeBytes": pdf_file_size_bytes,
                }
            else:
                pagewise_sources, pagewise_stats = self._run_audiveris_pagewise(pdf_path, output_dir / "pagewise")
                if pagewise_sources:
                    musicxml_sources = [Path(item) for item in pagewise_sources]
                    musicxml_path = str(musicxml_sources[0])
                    omr_confidence = self._estimate_pagewise_omr_confidence(pagewise_stats, len(pagewise_sources))
                    omr_stats = {
                        **pagewise_stats,
                        "wholePdfAttempted": whole_pdf_attempted,
                        "wholePdfSkippedReason": whole_pdf_skipped_reason,
                        "wholePdfMaxFileMb": whole_pdf_max_file_mb,
                        "pdfFileSizeBytes": pdf_file_size_bytes,
                        "mode": str(pagewise_stats.get("mode") or "pagewise"),
                    }
                    if whole_pdf_attempted:
                        warnings.append("Whole-PDF OMR failed; fell back to pagewise OMR.")
                else:
                    warnings.append("Audiveris 已调用，但未生成可用 MusicXML。")

            if musicxml_sources and not piece_pack:
                built_piece_pack, detected_parts, resolved_part = self._build_piece_pack_from_musicxml_sources(
                    musicxml_sources,
                    request,
                    selected_part,
                )
                if built_piece_pack:
                    piece_pack = built_piece_pack
                    selected_part = resolved_part
                else:
                    warnings.append("已生成 MusicXML，但当前未能稳定解析为结构化音符。")
        else:
            warnings.append("本机未配置 Audiveris，当前将优先使用已知曲目自动匹配。")

        warnings = self._compact_import_warnings(warnings)

        if not piece_pack:
            return ScoreImportJobResult(
                jobId=request.jobId,
                omrStatus="failed",
                omrConfidence=0.0,
                scoreId=None,
                title=request.titleHint or request.originalFilename or request.jobId,
                sourcePdfPath=request.pdfPath,
                musicxmlPath=musicxml_path or None,
                previewPages=preview_pages,
                detectedParts=[selected_part],
                selectedPart=selected_part,
                selectedPartCandidates=[selected_part],
                piecePack=None,
                omrStats=omr_stats,
                warnings=warnings,
                error="当前 PDF 尚未自动转换为可分析乐谱。请检查 Audiveris 是否正常输出，或导入已知内置曲目。",
            )

        if isinstance(piece_pack, dict):
            piece_pack["selectedPart"] = piece_pack.get("selectedPart") or selected_part
            piece_pack["detectedParts"] = list(piece_pack.get("detectedParts") or detected_parts or [selected_part])
            selected_part = str(piece_pack.get("selectedPart") or selected_part)
            detected_parts = list(piece_pack.get("detectedParts") or [selected_part])
        part_candidates = list(piece_pack.get("partCandidates") or []) if isinstance(piece_pack, dict) else []
        selected_part_confidence = (
            safe_float(piece_pack.get("selectedPartConfidence"), 0.0)
            if isinstance(piece_pack, dict)
            else 0.0
        )
        marking_stats = dict(piece_pack.get("markingStats") or {}) if isinstance(piece_pack, dict) else {}
        if isinstance(omr_stats, dict):
            top_candidate = part_candidates[0] if part_candidates else {}
            omr_stats = {
                **omr_stats,
                "partCandidateCount": len(part_candidates),
                "selectedPartConfidence": round(float(selected_part_confidence or 0.0), 3),
                "topPartCandidateScore": round(float(top_candidate.get("score", 0.0)), 3) if top_candidate else 0.0,
                "topPartCandidateAmbiguous": bool(top_candidate.get("selectionAmbiguous")) if top_candidate else False,
            }

        return ScoreImportJobResult(
            jobId=request.jobId,
            omrStatus="completed",
            omrConfidence=omr_confidence or (0.44 if request.fallbackPieceId else 0.58),
            scoreId=request.jobId,
            title=request.titleHint or request.originalFilename or request.jobId,
            sourcePdfPath=request.pdfPath,
            musicxmlPath=musicxml_path or None,
            previewPages=preview_pages,
            detectedParts=detected_parts,
            selectedPart=selected_part,
            selectedPartCandidates=detected_parts,
            selectedPartConfidence=round(float(selected_part_confidence or 0.0), 3),
            partCandidates=part_candidates,
            markingStats=marking_stats,
            piecePack=piece_pack,
            omrStats=omr_stats,
            warnings=warnings,
            error=None,
        )

    def import_musicxml_score(self, request: MusicXmlImportRequest) -> ScoreImportJobResult:
        output_dir = Path(request.outputDir or (Path(self.settings.data_root) / "score-imports" / request.jobId))
        output_dir.mkdir(parents=True, exist_ok=True)

        musicxml_path = Path(request.musicxmlPath)
        selected_part = (request.selectedPartHint or "erhu").strip() or "erhu"
        warnings: list[str] = []
        detected_parts: list[str] = [selected_part]

        if not musicxml_path.exists():
            return ScoreImportJobResult(
                jobId=request.jobId,
                omrStatus="failed",
                omrConfidence=0.0,
                scoreId=None,
                title=request.titleHint or request.originalFilename or request.jobId,
                sourcePdfPath=None,
                musicxmlPath=str(musicxml_path),
                detectedParts=detected_parts,
                selectedPart=selected_part,
                selectedPartCandidates=detected_parts,
                warnings=["MusicXML 文件不存在。"],
                error="MusicXML 文件不存在，无法生成结构化乐谱。",
            )

        try:
            piece_pack, detected_parts, resolved_part = self._build_piece_pack_from_musicxml_sources(
                [musicxml_path],
                request,
                selected_part,
            )
        except Exception as error:
            return ScoreImportJobResult(
                jobId=request.jobId,
                omrStatus="failed",
                omrConfidence=0.0,
                scoreId=None,
                title=request.titleHint or request.originalFilename or request.jobId,
                sourcePdfPath=None,
                musicxmlPath=str(musicxml_path),
                detectedParts=detected_parts,
                selectedPart=selected_part,
                selectedPartCandidates=detected_parts,
                warnings=[str(error)],
                error="MusicXML 解析失败，无法生成结构化乐谱。",
            )

        if not piece_pack:
            return ScoreImportJobResult(
                jobId=request.jobId,
                omrStatus="failed",
                omrConfidence=0.0,
                scoreId=None,
                title=request.titleHint or request.originalFilename or request.jobId,
                sourcePdfPath=None,
                musicxmlPath=str(musicxml_path),
                detectedParts=detected_parts,
                selectedPart=selected_part,
                selectedPartCandidates=detected_parts,
                warnings=["MusicXML 中没有解析出可分析的二胡旋律音符。"],
                error="MusicXML 未生成可分析曲库，请检查声部选择或文件内容。",
            )

        if isinstance(piece_pack, dict):
            piece_pack["composer"] = piece_pack.get("composer") or "MusicXML import"
            piece_pack["selectedPart"] = piece_pack.get("selectedPart") or resolved_part
            piece_pack["detectedParts"] = list(piece_pack.get("detectedParts") or detected_parts or [resolved_part])
            selected_part = str(piece_pack.get("selectedPart") or resolved_part)
            detected_parts = list(piece_pack.get("detectedParts") or [selected_part])

        part_candidates = list(piece_pack.get("partCandidates") or []) if isinstance(piece_pack, dict) else []
        selected_part_confidence = (
            safe_float(piece_pack.get("selectedPartConfidence"), 0.0)
            if isinstance(piece_pack, dict)
            else 0.0
        )
        marking_stats = dict(piece_pack.get("markingStats") or {}) if isinstance(piece_pack, dict) else {}
        section_count = len(piece_pack.get("sections") or []) if isinstance(piece_pack, dict) else 0
        omr_confidence = max(0.65, min(0.96, float(selected_part_confidence or 0.0) or 0.88))

        return ScoreImportJobResult(
            jobId=request.jobId,
            omrStatus="completed",
            omrConfidence=omr_confidence,
            scoreId=request.jobId,
            title=request.titleHint or request.originalFilename or request.jobId,
            sourcePdfPath=None,
            musicxmlPath=str(musicxml_path),
            previewPages=[],
            detectedParts=detected_parts,
            selectedPart=selected_part,
            selectedPartCandidates=detected_parts,
            selectedPartConfidence=round(float(selected_part_confidence or 0.0), 3),
            partCandidates=part_candidates,
            markingStats=marking_stats,
            piecePack=piece_pack,
            omrStats={
                "mode": "musicxml-upload",
                "pageCount": 0,
                "resultCount": section_count,
                "wholePdfAttempted": False,
            },
            warnings=warnings,
            error=None,
        )
