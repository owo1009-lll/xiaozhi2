"""Emit the round-4 planted-error position sidecar.

Single source of truth is R4_05_ERRORS / R4_06_ERRORS in
generate_round4_release_pack.py. This script only *reads* those constants and
writes a machine-readable ground-truth sidecar next to the round-4 private
takes; it never rewrites the MusicXML/PNG scores (those stay byte-stable so the
already-imported score-store artifacts keep their digests).

The sidecar feeds the fresh-blind runner's preGateOnly localization reference
(--position-truth). It is evidence only: it never authorizes the student
runtime.
"""
import json
import os
import sys

from music21 import pitch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_round4_release_pack import R4_05_ERRORS, R4_06_ERRORS  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "data", "private", "western-strings-round4", "error-positions.json")

# recordingId (as stored in the controlled-submissions / manifest) -> scoreId
RECORDINGS = [
    ("round4-r4-05", "score-mrukri11-3irrzl", R4_05_ERRORS),
    ("round4-r4-06", "score-mrukria4-u84gv1", R4_06_ERRORS),
]


def build_entries(errors):
    out = []
    for kind, measure, beat, score_pitch, short, text in errors:
        out.append({
            "kind": kind,
            "measure": int(measure),
            "beat": float(beat),
            "scorePitch": score_pitch,
            "scoreMidi": int(pitch.Pitch(score_pitch.replace("b", "-")).midi),
            "short": short,
            "detail": text,
        })
    return out


def main():
    payload = {
        "contractNote": (
            "planted-error ground-truth positions for the round-4 error-reference "
            "takes; consumed by the fresh-blind runner --position-truth as a "
            "preGateOnly localization reference only. It never authorizes the "
            "student runtime and is not a precision or zero-leak claim."
        ),
        "beatConvention": "1-based beat within the measure; candidate rows use beatStart = beat - 1 (quarter units)",
        "recordings": {
            recording_id: {"scoreId": score_id, "errors": build_entries(errors)}
            for recording_id, score_id, errors in RECORDINGS
        },
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    total = sum(len(v["errors"]) for v in payload["recordings"].values())
    print(f"wrote {OUT} ({total} planted errors across {len(RECORDINGS)} takes)")


if __name__ == "__main__":
    main()
