# Ordinary Dynamic Shadow Full-Score Fresh-Blind Evidence

Generated: 2026-07-21T15:50:09.517Z

Scope: implementation evidence only (preGateOnly). This report never
authorizes the student runtime and does not by itself grant the
separate western-ordinary-dynamic-shadow-release-v1 authorization.

- evidenceReady: true
- recordingCount: 6

## Clean-full tier (score is ground truth)

- round4-r4-01: coverage 0.90566 (floor 0.2)
- round4-r4-02: coverage 0.762712 (floor 0.2)

## Technique-safety tier (marked-zone accusation must be zero)

- totalMarkedZoneRows: 3
- totalMarkedZoneAccusations: 0
- round4-r4-03: markedZoneRows 3, accusations 0, coverage 0.5
- round4-r4-04: markedZoneRows 0, accusations 0, coverage 0.727273

## Error-reference tier (informational only, NOT ground-truth precision)

- round4-r4-05: coverage 0.688889 (reference only, no confirmed error positions)
- round4-r4-06: coverage 0.55 (reference only, no confirmed error positions)

## Planted-error localization reference (preGateOnly, review-only — NOT a runtime accusation)

- overall detection recall: 8/12 (0.6667)
- false-positive rate on clean notes of the same takes: 11/73 (0.1507)

By error kind:

- wrong: 3/3 (rate 1)
- missing: 3/3 (rate 1)
- extra: 1/3 (rate 0.3333)
- drag: 1/3 (rate 0.3333)

Per recording:

- round4-r4-05: detected 4/6; false-positive 5/39 clean notes
- round4-r4-06: detected 4/6; false-positive 6/34 clean notes

## Policy C review-assist gate (two-layer semantics)

- reviewAssistGateReady: true
- autoAccusationReady: false
- planted detected: 6/12 (0.5)
- planted strict confirmed / self-check hints: 2/4
- non-planted strict false accusations: 0/253
- non-planted self-check hints: 3/253 (0.011858)
- combined precision proxy: 0.666667
- waveform energy measured: false
- energyRobustnessReady: false
- assignment gaps are self-check hints, never automatic accusations

## Relative-IOI rhythm-channel diagnostic (preGateOnly)

- feature coverage: 246/265
- rhythm targets: 6
- frozen threshold 0.15: TP 5, FP 37, precision 0.119048, recall 0.833333
- best point at recall floor: threshold 0.305892, TP 4, FP 20, precision 0.166667, recall 0.666667
- evaluatedThresholdCount: 227
- jointFloorReady: false
- this channel remains diagnostic-only; no review hint or accusation is authorized

## Blocking Reasons

- none
