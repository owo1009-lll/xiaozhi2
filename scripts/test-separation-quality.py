from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))
warnings.filterwarnings("ignore", message="pkg_resources is deprecated.*")

from analyzer import ErhuAnalyzer, SymbolicNote, midi_to_frequency  # noqa: E402
from config import Settings  # noqa: E402
from schemas import AnalyzeRequest, PiecePack, RankSectionsRequest  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    import numpy as np

    analyzer = ErhuAnalyzer(Settings())
    require(
        analyzer._resolve_preprocess_mode(
            AnalyzeRequest(participantId="legacy-off", preprocessMode="off", piecePack=PiecePack(notes=[]))
        ) == "off",
        "legacy preprocessMode=off should not be overridden by the separationMode default",
    )
    require(
        analyzer._resolve_preprocess_mode(
            AnalyzeRequest(participantId="legacy-auto", preprocessMode="auto", piecePack=PiecePack(notes=[]))
        ) == "auto",
        "legacy preprocessMode=auto should still request automatic separation",
    )
    require(
        analyzer._resolve_preprocess_mode(
            AnalyzeRequest(
                participantId="explicit-separation",
                preprocessMode="off",
                separationMode="erhu-focus",
                piecePack=PiecePack(notes=[]),
            )
        ) == "erhu-focus",
        "explicit separationMode should override preprocessMode",
    )
    require(
        analyzer._resolve_preprocess_mode(RankSectionsRequest(preprocessMode="off")) == "off",
        "rank-section preprocessMode=off should not be overridden by the separationMode default",
    )
    score_notes = [
        SymbolicNote(
            note_id="n1",
            measure_index=1,
            beat_start=0.0,
            beat_duration=1.0,
            midi_pitch=74,
            expected_onset=0.0,
            expected_offset=1.0,
        ),
        SymbolicNote(
            note_id="n2",
            measure_index=1,
            beat_start=1.0,
            beat_duration=1.0,
            midi_pitch=76,
            expected_onset=1.0,
            expected_offset=2.0,
        ),
    ]
    pitch_track = [
        {"time": 0.0, "frequency": midi_to_frequency(74), "confidence": 0.9},
        {"time": 0.5, "frequency": midi_to_frequency(76), "confidence": 0.8},
        {"time": 1.0, "frequency": midi_to_frequency(40), "confidence": 0.9},
        {"time": 1.5, "frequency": midi_to_frequency(74), "confidence": 0.1},
    ]
    base_waveform = np.ones(1000, dtype=np.float32)
    enhanced_waveform = np.full(1000, 0.5, dtype=np.float32)

    quality = analyzer._measure_separation_quality(
        score_notes,
        pitch_track,
        base_waveform,
        enhanced_waveform,
    )
    require(abs(float(quality["separationEnergyRatio"]) - 0.5) < 0.001, f"bad energy ratio: {quality}")
    require(
        abs(float(quality["separationScoreBandRatio"]) - (2 / 3)) < 0.001,
        f"bad score-band ratio: {quality}",
    )
    require(int(quality["separationConfidentPitchCount"]) == 3, f"bad confident count: {quality}")
    require(int(quality["separationScoreBandHitCount"]) == 2, f"bad hit count: {quality}")
    require(
        analyzer._should_reject_auto_separation_for_score_band(
            {
                "separationScoreBandRatio": 0.02,
                "separationConfidentPitchCount": 64,
            }
        ),
        "auto separation should reject low score-band matches when enough pitch evidence exists",
    )
    require(
        not analyzer._should_reject_auto_separation_for_score_band(
            {
                "separationScoreBandRatio": 0.02,
                "separationConfidentPitchCount": 4,
            }
        ),
        "auto separation should not reject sparse pitch evidence by score-band ratio alone",
    )
    require(
        not analyzer._should_reject_auto_separation_for_score_band(
            {
                "separationScoreBandRatio": 0.5,
                "separationConfidentPitchCount": 64,
            }
        ),
        "auto separation should keep usable score-band matches",
    )
    require(
        analyzer._should_reject_borderline_auto_separation(
            {
                "separationConfidence": 0.42,
                "separationScoreBandRatio": 0.35,
                "separationConfidentPitchCount": 64,
            }
        ),
        "borderline auto separation should reject weak score-band matches",
    )
    require(
        not analyzer._should_reject_borderline_auto_separation(
            {
                "separationConfidence": 0.42,
                "separationScoreBandRatio": 0.49,
                "separationConfidentPitchCount": 64,
            }
        ),
        "borderline auto separation should keep strong score-band matches",
    )
    require(
        not analyzer._should_reject_borderline_auto_separation(
            {
                "separationConfidence": 0.5,
                "separationScoreBandRatio": 0.2,
                "separationConfidentPitchCount": 64,
            }
        ),
        "confident auto separation should not use the borderline guard",
    )
    solo_request = AnalyzeRequest(
        participantId="clean-solo",
        preprocessMode="auto",
        piecePack=PiecePack(
            scoreLineStats={
                "erhuNoteCount": 2,
                "accompanimentNoteCount": 0,
                "splitApplied": False,
            },
            partCandidates=[
                {
                    "staffCount": 1,
                    "chordRatio": 0,
                    "erhuRangeRatio": 1,
                    "isLikelyPiano": False,
                    "isLikelyAccompanimentSplit": False,
                }
            ],
            notes=[],
        ),
    )
    clean_pitch_track = [
        {"time": index * 0.05, "frequency": midi_to_frequency(74 if index % 2 == 0 else 76), "confidence": 0.9}
        for index in range(32)
    ]
    clean_solo_quality = analyzer._clean_solo_pitch_quality(solo_request, score_notes, clean_pitch_track)
    require(
        analyzer._should_skip_auto_separation_for_clean_solo(solo_request, clean_solo_quality),
        f"auto separation should skip explicit clean solo audio: {clean_solo_quality}",
    )
    accompaniment_request = AnalyzeRequest(
        participantId="accompaniment-score",
        preprocessMode="auto",
        piecePack=PiecePack(
            scoreLineStats={
                "erhuNoteCount": 2,
                "accompanimentNoteCount": 12,
                "splitApplied": True,
            },
            partCandidates=[
                {
                    "staffCount": 2,
                    "chordRatio": 0.34,
                    "erhuRangeRatio": 0.4,
                    "isLikelyPiano": True,
                    "isLikelyAccompanimentSplit": True,
                }
            ],
            notes=[],
        ),
    )
    accompaniment_quality = analyzer._clean_solo_pitch_quality(accompaniment_request, score_notes, clean_pitch_track)
    require(
        not analyzer._should_skip_auto_separation_for_clean_solo(accompaniment_request, accompaniment_quality),
        "auto separation should not skip when the score exposes accompaniment context",
    )
    low_match_quality = dict(clean_solo_quality)
    low_match_quality["cleanSoloScoreBandRatio"] = 0.25
    require(
        not analyzer._should_skip_auto_separation_for_clean_solo(solo_request, low_match_quality),
        "auto separation should not skip clean-solo guard when raw pitch is outside the score band",
    )
    wrapped_confidence = analyzer._estimate_separation_confidence(
        score_notes,
        pitch_track,
        base_waveform,
        enhanced_waveform,
    )
    require(
        abs(wrapped_confidence - float(quality["separationConfidence"])) < 0.0001,
        "confidence wrapper should match quality payload",
    )

    print(json.dumps({"ok": True, "quality": quality}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
