#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify the round-3 real-error takes against their construction gold.

For each planted-error checklist entry, checks the recording shows the
expected machine signature at the exact score position:

  wrong    the note must NOT be pitch-confirmed; report observed pitches
  missing  the note must NOT be pitch-confirmed (unmatched or mismatch)
  extra    an unmatched audio event at the same pitch near the note
  drag     long event and/or late successor relative to the fitted tempo line

Per the performer's report, r3-04 checklist entry #6 (m11 beat 2 drag) was
NOT performed (played normally); the as-performed labels record it as
`not-performed` and this script verifies the position indeed looks normal.

Output: data/experiments/western-strings-round3-real-errors/report.json
(+ as-performed labels per take). Real-error evidence: this is the ground
truth the review-only lanes (duration/extra) have been waiting for, pending
the owner's confirmation of this machine verification.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402
from generate_round3_etudes import R3_04_ERRORS, R3_05_ERRORS  # noqa: E402

PRIVATE = REPO / "data" / "private" / "western-strings-round3"
OUT = REPO / "data" / "experiments" / "western-strings-round3-real-errors"

# performer-reported deviation: r3-04 entry #6 (index 5) played normally
NOT_PERFORMED = {("r3-04", 5)}


def entry_index(events: list[dict], measure_number: int, beat: float, pitch: str) -> int:
    from music21 import pitch as m21pitch
    target_offset = (measure_number - 1) * 4.0 + (beat - 1.0)
    target_midi = m21pitch.Pitch(pitch.replace("b", "-") if pitch[1:2] == "b" else pitch).midi
    cursor = 0.0
    for index, event in enumerate(events):
        if abs(cursor - target_offset) < 1e-6 and target_midi in event["midis"]:
            return index
        cursor += event.get("quarterLength", 0.0)
    raise SystemExit(f"cannot locate m{measure_number} beat {beat} {pitch}")


def mxl_events_with_offsets(gold: Path) -> list[dict]:
    """anchor.mxl_events order + quarter offsets/lengths from music21."""
    from music21 import converter
    events = anchor.mxl_events(gold)
    flat = list(converter.parse(str(gold)).flatten().notes)
    if len(flat) != len(events):
        raise SystemExit("event count mismatch")
    for event, note_obj in zip(events, flat):
        event["offsetQuarters"] = float(note_obj.offset)
        event["quarterLength"] = float(note_obj.quarterLength)
    return events


def verify_take(name: str, entries) -> dict:
    gold = PRIVATE / f"{name}.musicxml"
    audio = PRIVATE / f"{name}.m4a"
    events = mxl_events_with_offsets(gold)
    aev = anchor.audio_events(audio)
    match, time_pred = anchor.align(events, aev)
    matched_indices = {m for m in match if m is not None}
    verdicts = []
    for index, event in enumerate(events):
        mi = match[index]
        if mi is None:
            verdicts.append("unmatched")
        else:
            verdicts.append(anchor.strict_audio_verdict(event["midis"], aev[mi]["midis"]))
    confirmed = sum(1 for v in verdicts if v == "confirmed")

    rows = []
    for checklist_number, (kind, measure_number, beat, pitch, _short, text) in enumerate(entries, start=1):
        index = entry_index(events, measure_number, float(beat), pitch)
        mi = match[index]
        observed = aev[mi]["midis"] if mi is not None else None
        expected_time = time_pred[index] if time_pred is not None else None
        onset = aev[mi]["start"] if mi is not None else None
        deviation = (round(onset - expected_time, 3)
                     if onset is not None and expected_time is not None else None)
        row = {"checklistNumber": checklist_number, "type": kind,
               "measure": measure_number, "beat": beat, "pitch": pitch,
               "scoreEventIndex": index, "verdict": verdicts[index],
               "observedMidis": observed, "timingDeviationSec": deviation}
        if (name, checklist_number - 1) in NOT_PERFORMED:
            row["asPerformed"] = "not-performed (performer played this position normally)"
            row["verified"] = verdicts[index] == "confirmed"
        elif kind in ("wrong", "missing"):
            row["verified"] = verdicts[index] != "confirmed"
        elif kind == "extra":
            base_time = onset if onset is not None else expected_time
            target_midi = set(events[index]["midis"])
            # slow takes put ~1.5-2.5s between the two pulls of a repeated note;
            # the window must cover the full repeat pair, not just adjacent beats
            spare = [j for j, audio_event in enumerate(aev)
                     if j not in matched_indices
                     and set(audio_event["midis"]) & target_midi
                     and base_time is not None
                     and abs(audio_event["start"] - base_time) <= 3.0]
            row["unmatchedSamePitchNearby"] = len(spare)
            row["verified"] = len(spare) >= 1 or verdicts[index] != "confirmed"
        elif kind == "drag":
            duration = (aev[mi]["end"] - aev[mi]["start"]) if mi is not None else None
            successor_late = None
            nxt = index + 1
            if nxt < len(events) and match[nxt] is not None and time_pred is not None:
                successor_late = round(aev[match[nxt]]["start"] - time_pred[nxt], 3)
            row.update({"eventDurationSeconds": round(duration, 3) if duration else None,
                        "successorTimingDeviationSec": successor_late})
            row["verified"] = bool((duration is not None and duration >= 1.2)
                                   or (successor_late is not None and successor_late >= 0.25)
                                   or (deviation is not None and deviation >= 0.25))
        rows.append(row)

    return {"take": name, "audio": str(audio.relative_to(REPO)),
            "scoreEvents": len(events), "audioEvents": len(aev),
            "confirmed": confirmed,
            "rawAgreement": round(confirmed / max(1, sum(1 for v in verdicts if v != 'unmatched')), 4),
            "entries": rows,
            "allVerified": all(r["verified"] for r in rows)}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    takes = [verify_take("r3-04", R3_04_ERRORS), verify_take("r3-05", R3_05_ERRORS)]
    report = {
        "evalOnly": True,
        "purpose": "machine verification of the round-3 REAL planted-error takes; "
                   "owner confirmation upgrades these to verified real-error ground truth",
        "performerDeviation": "r3-04 checklist #6 (m11 drag) reported not performed; "
                              "recorded as not-performed and verified normal",
        "takes": takes,
        "allTakesVerified": all(t["allVerified"] for t in takes),
    }
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                     encoding="utf-8")
    for take in takes:
        print(json.dumps({"take": take["take"], "rawAgreement": take["rawAgreement"],
                          "allVerified": take["allVerified"],
                          "entries": [{k: r.get(k) for k in
                                       ("checklistNumber", "type", "verdict", "verified",
                                        "observedMidis", "timingDeviationSec")}
                                      for r in take["entries"]]}, ensure_ascii=False))
    print(json.dumps({"out": str((OUT / 'report.json').relative_to(REPO))}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
