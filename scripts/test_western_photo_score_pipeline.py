#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fast fail-closed tests for the photo-score pipeline (pure logic, no OMR/audio)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from western_photo_score_pipeline import decide, MIN_CONFIRMED, MIN_AGREEMENT  # noqa: E402
from proto_western_strings_score_anchored_feedback import (  # noqa: E402
    _pitch_cost,
    align,
    compute_verdicts,
    strict_audio_verdict,
)
from western_m4_omr_structure import (  # noqa: E402
    evaluate_musicxml_only_structure,
    evaluate_p0_records,
    extract_musicxml_structure,
    extract_raw_structure,
)

checks = []

def check(name, cond):
    checks.append(name)
    assert cond, f"FAILED: {name}"

# ---- decide(): machine-only layered decisions ----
ready_structure = {"ready": True, "clefReady": True, "keyReady": True, "meterReady": True}
ok = {"status": "ok", "variant": "up2", "confirmed": 50, "agreement": 0.9,
      "scoreStructureGate": ready_structure}
check("decide-full", decide([ok]) == "full-feedback:up2")
weak = {**ok, "confirmed": 5}
check("decide-degraded-low-confirmed", decide([weak]) == "degraded-feedback:up2")
lowagr = {**ok, "agreement": 0.3}
check("decide-degraded-low-agreement", decide([lowagr]) == "degraded-feedback:up2")
check("decide-retake-no-output", decide([{"status": "omr-no-output", "variant": "up2",
                                          "confirmed": 0, "agreement": 0.0}]) == "retake-photo")
check("decide-retake-zero-confirmed", decide([{**ok, "confirmed": 0}]) == "retake-photo")
check("decide-structure-review-missing-gate",
      decide([{key: value for key, value in ok.items() if key != "scoreStructureGate"}])
      == "score-structure-review-required")
check("decide-structure-review-failed-gate",
      decide([{**ok, "scoreStructureGate": {"ready": False}}])
      == "score-structure-review-required")
best = {**ok, "variant": "up3", "confirmed": 80}
check("decide-picks-max-confirmed", decide([ok, best]) == "full-feedback:up3")
check("decide-thresholds-documented", MIN_CONFIRMED == 20 and abs(MIN_AGREEMENT - 0.6) < 1e-9)

# ---- decide(): HOMR joins the pool with the same currency + gate rules ----
homr_ok = {"status": "ok", "variant": "homr", "engine": "homr", "confirmed": 90,
           "agreement": 0.95, "scoreStructureGate": ready_structure}
check("decide-homr-wins-on-currency", decide([ok, homr_ok]) == "full-feedback:homr")
homr_gate_failed = {**homr_ok, "scoreStructureGate": {"ready": False}}
check("decide-homr-gate-outranks-currency", decide([ok, homr_gate_failed]) == "full-feedback:up2")
homr_unavailable = {"status": "homr-unavailable", "variant": "homr", "engine": "homr",
                    "confirmed": 0, "agreement": 0.0}
check("decide-homr-unavailable-degrades-to-audiveris",
      decide([ok, homr_unavailable]) == "full-feedback:up2")
homr_weak = {**homr_ok, "confirmed": 55, "agreement": 0.5}
check("decide-homr-degraded-below-agreement",
      decide([homr_weak]) == "degraded-feedback:homr")

# ---- P0 score structure: explicit OR corroborated evidence, conflicts still fail ----
raw_ready = {
    "staffs": ["1:1"],
    "clefs": [{"page": 1, "staff": "1", "kind": "TREBLE", "score": 0.95}],
    "keys": [{"page": 1, "staff": "1", "fifths": 1, "score": 0.95}],
    "meters": [{"page": 1, "staff": "1", "beats": 4, "beatType": 4, "score": 0.95}],
}
exported_ready = {
    "clefs": [("G", "2")],
    "keys": [1],
    "meters": [(4, 4)],
    "pitchInViolinRangeRate": 1.0,
    "measureDurationConsistencyRate": 1.0,
    "measureDurationComparableCount": 8,
    "measureDurationMatchCount": 8,
}
p0 = evaluate_p0_records(raw_ready, exported_ready)
check("p0-all-ready", p0["ready"] is True)
p0_missing_clef = evaluate_p0_records({**raw_ready, "clefs": []}, exported_ready)
check("p0-missing-clef-fails", p0_missing_clef["ready"] is False
      and "clef-line-start-coverage-missing" in p0_missing_clef["reasons"])
p0_implicit_key = evaluate_p0_records({**raw_ready, "keys": []}, {**exported_ready, "keys": [0]})
check("p0-implicit-zero-key-passes", p0_implicit_key["ready"] is True
      and p0_implicit_key["evidence"]["keyEvidenceMode"] == "implicit-zero")
p0_implicit_key_default = evaluate_p0_records(
    {**raw_ready, "keys": []}, {**exported_ready, "keys": []}
)
check("p0-implicit-zero-key-export-default-passes", p0_implicit_key_default["ready"] is True
      and p0_implicit_key_default["evidence"]["keyEvidenceMode"] == "implicit-zero-export-default")
p0_low_grade_clef = evaluate_p0_records(
    {**raw_ready, "clefs": [{**raw_ready["clefs"][0], "score": 0.4}]}, exported_ready
)
check("p0-low-grade-consistent-clef-passes-structurally", p0_low_grade_clef["ready"] is True
      and p0_low_grade_clef["evidence"]["clefEvidenceMode"] == "structural")
p0_low_grade_key = evaluate_p0_records(
    {
        "staffs": ["1:1", "1:2"],
        "clefs": [
            {"page": 1, "staff": "1", "kind": "TREBLE", "score": 0.95},
            {"page": 1, "staff": "2", "kind": "TREBLE", "score": 0.95},
        ],
        "keys": [
            {"page": 1, "staff": "1", "fifths": 3, "score": 0.72},
            {"page": 1, "staff": "2", "fifths": 3, "score": 0.74},
        ],
        "meters": raw_ready["meters"],
    },
    {**exported_ready, "keys": [3]},
)
check("p0-low-grade-consistent-key-passes-structurally", p0_low_grade_key["ready"] is True
      and p0_low_grade_key["evidence"]["keyEvidenceMode"] == "structural")
p0_missing_meter = evaluate_p0_records({**raw_ready, "meters": []}, exported_ready)
check("p0-missing-meter-passes-structurally", p0_missing_meter["ready"] is True
      and p0_missing_meter["evidence"]["meterEvidenceMode"] == "structural")
p0_key_conflict = evaluate_p0_records(
    {**raw_ready, "keys": [{**raw_ready["keys"][0], "fifths": -1}]}, exported_ready
)
check("p0-key-conflict-fails", p0_key_conflict["ready"] is False
      and "key-signature-conflict" in p0_key_conflict["reasons"])
p0_meter_conflict = evaluate_p0_records(
    {**raw_ready, "meters": [{**raw_ready["meters"][0], "beats": 3}]}, exported_ready
)
check("p0-meter-conflict-fails-even-with-consistency", p0_meter_conflict["ready"] is False
      and "meter-conflict" in p0_meter_conflict["reasons"])

xml = ET.fromstring("""
<score-partwise><part id="P1"><measure number="1"><attributes><divisions>1</divisions>
<key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
<clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration></note>
<note><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration></note>
<note><pitch><step>B</step><octave>3</octave></pitch><duration>1</duration></note>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
</measure></part></score-partwise>
""")
extracted = extract_musicxml_structure([xml])
check("p0-extract-meter-consistency", extracted["measureDurationConsistencyRate"] == 1.0
      and extracted["measureDurationComparableCount"] == 1)
check("p0-extract-violin-range", extracted["pitchInViolinRangeRate"] == 1.0
      and extracted["pitchMinMidi"] == 55 and extracted["pitchMaxMidi"] == 60)

raw_xml = ET.fromstring("""
<sheet><page><staff id="1"/><system><sig><inters>
  <clef kind="TREBLE" shape="G_CLEF" staff="1" grade="0.95"/>
  <key fifths="3" staff="1" grade="0.70" ctx-grade="0.91"/>
  <time-whole time-rational="4/4" shape="COMMON_TIME" staff="1" grade="0.79"/>
</inters></sig></system></page></sheet>
""")
raw_extracted = extract_raw_structure([raw_xml])
check("p0-extract-key-without-shape", raw_extracted["keys"][0]["fifths"] == 3
      and raw_extracted["keys"][0]["score"] == 0.91)
check("p0-extract-time-whole", raw_extracted["meters"][0]["beats"] == 4
      and raw_extracted["meters"][0]["beatType"] == 4)

# ---- MusicXML-only structure gate (HOMR: no .omr raw evidence exists) ----
import tempfile

MXL_TEMPLATE = """<score-partwise><part id="P1"><measure number="1"><attributes>
<divisions>1</divisions><key><fifths>{fifths}</fifths></key>{time}
<clef><sign>{sign}</sign><line>{line}</line></clef></attributes>
<note><pitch><step>G</step><octave>{octave}</octave></pitch><duration>1</duration></note>
<note><pitch><step>A</step><octave>{octave}</octave></pitch><duration>1</duration></note>
<note><pitch><step>B</step><octave>{octave}</octave></pitch><duration>1</duration></note>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
</measure></part></score-partwise>"""

def write_mxl(tmp, name, **kw):
    params = {"fifths": 0, "time": "<time><beats>4</beats><beat-type>4</beat-type></time>",
              "sign": "G", "line": 2, "octave": 3}
    params.update(kw)
    p = Path(tmp) / name
    p.write_text(MXL_TEMPLATE.format(**params), encoding="utf-8")
    return p

with tempfile.TemporaryDirectory() as tmp:
    gate = evaluate_musicxml_only_structure([write_mxl(tmp, "ready.musicxml")])
    check("mxlgate-ready", gate["ready"] is True
          and gate["evidenceSource"] == "musicxml-only"
          and gate["evidence"]["keyEvidenceMode"] == "structural")
    gate_no_meter = evaluate_musicxml_only_structure([write_mxl(tmp, "nometer.musicxml", time="")])
    check("mxlgate-missing-meter-fails", gate_no_meter["ready"] is False
          and "meter-structural-evidence-insufficient" in gate_no_meter["reasons"])
    gate_bass = evaluate_musicxml_only_structure(
        [write_mxl(tmp, "bass.musicxml", sign="F", line=4)])
    check("mxlgate-non-treble-clef-fails", gate_bass["ready"] is False
          and "clef-structural-evidence-insufficient" in gate_bass["reasons"])
    gate_low = evaluate_musicxml_only_structure([write_mxl(tmp, "low.musicxml", octave=2)])
    check("mxlgate-out-of-violin-range-fails", gate_low["ready"] is False
          and gate_low["clefReady"] is False)
check("mxlgate-empty-fails", evaluate_musicxml_only_structure([])["ready"] is False)

# ---- compute_verdicts(): shared fail-closed discipline (anchors optional) ----
cv_score = [{"midis": [m]} for m in [60, 62, 64, 65, 67, 69, 71, 72, 74, 76]]
cv_audio = [{"start": i * 0.5, "midis": [m]}
            for i, m in enumerate([60, 62, 64, 65, 66, 69, 71, 72, 74, 76])]
verdicts, match, _, agree, gate = compute_verdicts(cv_score, cv_audio, [False] * 10)
check("cv-isolated-red-kept", verdicts[4] == "pitch-mismatch" and gate == "ok")
check("cv-greens-strict", verdicts.count("confirmed") == 9 and abs(agree - 0.9) < 1e-9)
verdicts_u, *_ = compute_verdicts(cv_score, cv_audio, [False] * 4 + [True] + [False] * 5)
check("cv-uncertain-flag-blue", verdicts_u[4] == "anchor-uncertain")
cv_audio_bad = [{"start": i * 0.5, "midis": [m + 1]} for i, m in
                enumerate([60, 62, 64, 65, 67, 69, 71, 72, 74, 76])]
verdicts_bad, _, _, agree_bad, gate_bad = compute_verdicts(cv_score, cv_audio_bad, [False] * 10)
check("cv-low-agreement-demotes-all-reds", gate_bad == "low-agreement-review"
      and verdicts_bad.count("pitch-mismatch") == 0 and agree_bad == 0.0)

# ---- _pitch_cost(): octave fold + chord awareness ----
check("cost-exact-zero", _pitch_cost([60], [60]) == 0.0)
check("cost-octave-half", _pitch_cost([60], [72]) == 0.5)
check("cost-wrong-semitone", _pitch_cost([60], [61]) == 1.0)
check("cost-chord-nearest", _pitch_cost([60, 67], [67]) == 0.0)

# Alignment may tolerate octave artifacts, but green evidence must not.
check("verdict-exact-green", strict_audio_verdict([60], [60]) == "confirmed")
check("verdict-octave-not-green", strict_audio_verdict([60], [72]) == "pitch-mismatch")
check("verdict-chord-subset-neutral", strict_audio_verdict([60, 67], [67]) == "no-audio-evidence")

# ---- align(): substitution catches an isolated wrong note; monotonic ----
score = [{"midis": [m]} for m in [60, 62, 64, 65, 67, 69, 71, 72, 74, 76]]
audio = [{"start": i * 0.5, "midis": [m]} for i, m in enumerate([60, 62, 64, 66, 67, 69, 71, 72, 74, 76])]
match, time_pred = align(score, audio)
check("align-all-matched", all(mi is not None for mi in match))
check("align-monotonic", all(match[i] < match[i + 1] for i in range(len(match) - 1)))
check("align-substitution-kept", match[3] == 3)  # wrong note (66 vs 65) matched, not gapped
check("align-timepred-fitted", time_pred is not None and abs(time_pred[1] - time_pred[0] - 0.5) < 0.05)

# ---- fail-closed audit contract fields exist in pipeline source ----
src = (REPO / "scripts" / "western_photo_score_pipeline.py").read_text(encoding="utf-8")
for token in ("studentRuntimeTouched", "missingExtraVerdictsEmitted", "retake-photo", "degraded-feedback",
              "score-structure-review-required", "scoreStructureRequiresClefKeyMeter",
              "western-photo-score-v3-homr-pool", "p0StructureGateVersion",
              "homr-unavailable", "annotationStyle", "enginePool"):
    check(f"audit-contract-{token}", token in src)

print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False))
