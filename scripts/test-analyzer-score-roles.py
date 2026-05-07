# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))

from analyzer_score_roles import (  # noqa: E402
    collapse_erhu_melody_events,
    find_musicxml_part_candidate,
    has_accompaniment_part_candidate,
    is_ambiguous_part_candidate,
    is_clean_solo_part_candidate,
    is_explicit_erhu_part_candidate,
    should_apply_erhu_range_fallback,
)
from schemas import NoteEvent  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def note(
    note_id: str,
    measure: int,
    beat: float,
    duration: float,
    pitch: int,
    role: str = "",
    confidence: float = 0.0,
    staff: int = 1,
) -> NoteEvent:
    position = {"staffIndex": staff}
    if role:
        position.update({"scoreLineRole": role, "scoreLineConfidence": confidence})
    return NoteEvent(
        noteId=note_id,
        measureIndex=measure,
        beatStart=beat,
        beatDuration=duration,
        midiPitch=pitch,
        notePosition=position,
    )


def main() -> int:
    candidates = [
        {"id": "P1", "name": "Piano", "label": "Piano", "staffCount": 2, "isLikelyPiano": True},
        {"id": "P2", "name": "Erhu", "label": "Erhu", "staffCount": 1, "chordRatio": 0.0},
        {"id": "P3", "name": "Voice", "label": "Voice", "staffCount": 1, "chordRatio": 0.04},
    ]
    require(find_musicxml_part_candidate(candidates, "P2") is candidates[1], "candidate lookup should match selected id")
    require(find_musicxml_part_candidate(candidates, "Erhu") is candidates[1], "candidate lookup should match selected label")
    require(find_musicxml_part_candidate(candidates, "") is candidates[0], "candidate lookup should fall back to first candidate")
    require(is_explicit_erhu_part_candidate(candidates[1]), "English Erhu label should be explicit erhu")
    require(has_accompaniment_part_candidate(candidates), "piano candidate should mark accompaniment present")
    require(is_explicit_erhu_part_candidate({"id": "P4", "name": "二胡", "label": ""}), "Simplified Chinese 二胡 label should be explicit erhu")
    require(is_explicit_erhu_part_candidate({"id": "P5", "name": " 二 胡 ", "label": ""}), "Chinese 二胡 label should tolerate whitespace")
    require(is_explicit_erhu_part_candidate({"id": "P6", "name": "Erhu II", "label": ""}), "Erhu II label should be explicit erhu")
    require(is_explicit_erhu_part_candidate({"id": "P7", "name": "Erhu 1", "label": ""}), "Erhu 1 label should be explicit erhu")
    require(has_accompaniment_part_candidate([{"id": "P8", "name": "钢琴", "label": ""}]), "Simplified Chinese 钢琴 should mark accompaniment present")
    require(has_accompaniment_part_candidate([{"id": "P9", "name": "鋼 琴", "label": ""}]), "Traditional Chinese 鋼琴 should tolerate whitespace")
    require(has_accompaniment_part_candidate([{"id": "P10", "name": "伴奏", "label": ""}]), "Chinese 伴奏 should mark accompaniment present")
    require(not is_clean_solo_part_candidate(candidates[2], candidates), "Voice should not be clean solo when piano is present")
    require(is_clean_solo_part_candidate(candidates[2], [candidates[2]]), "single monophonic Voice should be clean solo")
    require(is_ambiguous_part_candidate(candidates[0], candidates), "piano-like candidate should be ambiguous for erhu projection")
    require(
        should_apply_erhu_range_fallback(
            {
                "noteCount": 20,
                "erhuRangeRatio": 0.94,
                "chordRatio": 0.08,
                "score": 0.8,
                "selectedPartConfidence": 0.75,
                "staffCount": 1,
                "isLikelyPiano": False,
                "safeForErhuProjection": False,
            },
            clean_solo=False,
            ambiguous=True,
        ),
        "range fallback should accept strong monophonic scanned candidates",
    )
    require(
        not should_apply_erhu_range_fallback(
            {
                "noteCount": 20,
                "erhuRangeRatio": 0.94,
                "chordRatio": 0.08,
                "score": 0.8,
                "selectedPartConfidence": 0.75,
                "staffCount": 2,
                "isLikelyPiano": False,
                "safeForErhuProjection": False,
            },
            clean_solo=False,
            ambiguous=True,
        ),
        "range fallback should reject multi-staff candidates",
    )

    role_collapsed = collapse_erhu_melody_events(
        [
            note("erhu-1", 1, 0.0, 1.0, 74, "erhu", 0.9, 1),
            note("acc-1", 1, 0.0, 1.0, 48, "accompaniment", 0.8, 2),
            note("erhu-2", 1, 1.0, 1.0, 76, "erhu", 0.9, 1),
        ]
    )
    require([item.noteId for item in role_collapsed] == ["erhu-1", "erhu-2"], "role collapse should keep confident erhu notes only")

    staff_collapsed = collapse_erhu_melody_events(
        [
            note("top", 1, 0.0, 1.0, 76, "", 0.0, 1),
            note("lower", 1, 0.0, 1.5, 52, "", 0.0, 2),
            note("top-2", 1, 1.0, 1.0, 77, "", 0.0, 1),
        ]
    )
    require([item.noteId for item in staff_collapsed] == ["top", "top-2"], "staff collapse should prefer top staff before chord reduction")

    no_erhu = collapse_erhu_melody_events([note("acc-only", 1, 0.0, 1.0, 52, "accompaniment", 0.8, 2)])
    require(no_erhu == [], "line-role analysis with no erhu line should not fall back to accompaniment")

    print(json.dumps({"ok": True, "checks": ["candidate-roles", "range-fallback", "melody-collapse"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
