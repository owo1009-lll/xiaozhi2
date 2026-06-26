# Western Strings M0 Alignment Report

Date: 2026-06-27

Branch: `feature/western-strings-m0-alignment`

Scope: eval-only validation for migrating the existing bowed-string practice
diagnosis pipeline from erhu to western strings. No production wiring, no
teacher-backend changes, and no existing erhu data was modified.

## Decision

M0 passes.

The western-strings migration has enough alignment evidence to continue past
M0. Across Bach10, a URMP violin/cello smoke test, and a MusicNet string-scale
smoke test, at least one non-sanity alignment method reaches the Green gate:

- median onset error < 150 ms
- hit@300 ms >= 85%
- coverage >= 80%

The strongest practical candidates are:

- Bach10: `parangonar-basic-pitch`
- URMP: `parangonar-basic-pitch`
- MusicNet: `basic-pitch-dtw`

`crepe-dtw` was also run as the plan-specified f0-DTW baseline and reached Green
on all three probes.

## Methods

The scripts use the same metric definitions across datasets:

- `linear-scoretime`: sanity baseline only, excluded from GO decisions.
- `crepe-dtw`: torchcrepe f0 track aligned to score pitch template by DTW.
- `pyin-dtw`: lightweight f0-DTW comparison baseline.
- `basic-pitch-dtw`: Basic Pitch note events aligned to score notes by DTW.
- `parangonar-basic-pitch`: Parangonar note matcher over Basic Pitch events.

Coverage is defined as valid predictions divided by gold notes. Missing or
low-confidence predictions count against coverage.

## M0a: Bach10 Violin/Soprano

Source: `https://github.com/flippy-fyp/Bach10_v1.1`

Input: 10 Bach10 pieces, source/instrument id 1 only.

Gold notes: 425.

Best method: `parangonar-basic-pitch`.

| method | grade | coverage | median | p90 | hit@100ms | hit@300ms |
|---|---:|---:|---:|---:|---:|---:|
| `parangonar-basic-pitch` | Green | 0.998 | 35.2 ms | 117.4 ms | 0.854 | 0.958 |
| `crepe-dtw` | Green | 1.000 | 46.0 ms | 192.2 ms | 0.776 | 0.932 |
| `pyin-dtw` | Green | 1.000 | 49.5 ms | 216.1 ms | 0.774 | 0.929 |
| `basic-pitch-dtw` | Green | 1.000 | 42.6 ms | 321.2 ms | 0.772 | 0.892 |
| `linear-scoretime` | Red | 1.000 | 278.1 ms | 679.2 ms | 0.216 | 0.541 |

Decision: `GO_TO_M0B`.

Artifacts:

- `data/experiments/western-strings-m0/m0a-bach10/m0a-bach10-summary.json`
- `data/experiments/western-strings-m0/m0a-bach10/m0a-bach10-per-note.csv`
- `data/experiments/western-strings-m0/m0a-bach10/m0a-bach10-per-piece.csv`

## M0b: URMP Violin/Cello Smoke

Official source: `https://datadryad.org/dataset/doi:10.5061/dryad.ng3r749`

Practical file-level mirror used for this smoke test:
`https://huggingface.co/datasets/Eredis02/URMP`

Why a mirror was used: the official Dryad API exposes the URMP dataset as one
large `Dataset.tar.gz` file, while the HuggingFace mirror exposes individual
URMP files. This allowed a small violin/cello smoke test without downloading the
full archive.

Input: `01_Jupiter_vn_vc`, separated violin and cello tracks.

Gold notes: 146.

Best method: `parangonar-basic-pitch`.

| method | grade | coverage | median | p90 | hit@100ms | hit@300ms |
|---|---:|---:|---:|---:|---:|---:|
| `parangonar-basic-pitch` | Green | 0.986 | 19.1 ms | 175.8 ms | 0.856 | 0.938 |
| `crepe-dtw` | Green | 1.000 | 84.0 ms | 196.5 ms | 0.582 | 0.973 |
| `pyin-dtw` | Green | 1.000 | 46.6 ms | 171.3 ms | 0.733 | 0.993 |
| `basic-pitch-dtw` | Yellow | 1.000 | 23.8 ms | 482.8 ms | 0.733 | 0.829 |
| `linear-scoretime` | Red | 1.000 | 372.2 ms | 720.7 ms | 0.137 | 0.418 |

Decision: Green smoke test. This is not a full URMP dataset claim.

Artifacts:

- `data/experiments/western-strings-m0/m0b-urmp/m0b-urmp-summary.json`
- `data/experiments/western-strings-m0/m0b-urmp/m0b-urmp-per-note.csv`
- `data/experiments/western-strings-m0/m0b-urmp/m0b-urmp-per-track.csv`

## M0c: MusicNet String Scale Smoke

Official source: `https://zenodo.org/records/5120004`

Practical file-level mirror used for the audio/label files:
`https://huggingface.co/datasets/DreamyWanderer/MusicNet`

Input: two solo string samples:

- `2191`: Bach solo violin, 551 notes.
- `2298`: Bach solo cello, 966 notes.

Gold notes: 1517.

Best method: `basic-pitch-dtw`.

| method | grade | coverage | median | p90 | hit@100ms | hit@300ms |
|---|---:|---:|---:|---:|---:|---:|
| `basic-pitch-dtw` | Green | 1.000 | 58.4 ms | 179.9 ms | 0.760 | 0.953 |
| `crepe-dtw` | Green | 1.000 | 64.3 ms | 221.2 ms | 0.711 | 0.933 |
| `pyin-dtw` | Green | 1.000 | 70.4 ms | 493.0 ms | 0.678 | 0.852 |
| `parangonar-basic-pitch` | Yellow | 0.873 | 53.4 ms | 224.3 ms | 0.700 | 0.796 |
| `linear-scoretime` | Green | 1.000 | 127.9 ms | 331.0 ms | 0.401 | 0.870 |

Decision: Green scale/noise smoke. This is not a full MusicNet benchmark.

Artifacts:

- `data/experiments/western-strings-m0/m0c-musicnet/m0c-musicnet-summary.json`
- `data/experiments/western-strings-m0/m0c-musicnet/m0c-musicnet-per-note.csv`
- `data/experiments/western-strings-m0/m0c-musicnet/m0c-musicnet-per-sample.csv`

## Interpretation

The western-string alignment premise is supported by local evidence. Compared
with the erhu line, the critical difference is not only the instrument family;
it is also the availability of clean score/audio/gold-note datasets and
less-rubato validation material.

M0 does not prove a finished product. It proves that the next phase is worth
building:

1. Start with clean MIDI/MusicXML inputs, not PDF OMR.
2. Use a confidence-gated alignment ensemble, with `basic-pitch-dtw`,
   `crepe-dtw`, and `parangonar-basic-pitch` as candidates.
3. Keep `linear-scoretime` only as a sanity baseline.
4. Report double-stop and legato cases separately when reliable labels exist.
5. Keep fail-closed behavior: low-confidence notes go to review, not auto-pass.

## Limitations

- URMP was evaluated on a small violin/cello smoke subset, not the full dataset.
- MusicNet was evaluated on two solo string samples. Mixed chamber works remain
  a later stress test.
- Bach10 and MusicNet are not technique-label datasets. They validate alignment,
  not bowing/vibrato/shift diagnosis.
- `parangonar-basic-pitch` can emit sampling warnings on dense passages; it is
  useful but should remain behind confidence gates.

## Recommended Next Step

Proceed to Phase 1 on the western-strings branch:

1. Build a clean MIDI/MusicXML ingestion path for violin first.
2. Turn the M0 scripts into a reusable alignment evaluation harness.
3. Add confidence calibration over the candidate methods.
4. Only after V2 pitch/rhythm/missing-note diagnostics are stable, start a
   separate technique-labeling plan.
