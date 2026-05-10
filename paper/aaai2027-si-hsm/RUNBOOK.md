# SI-HSM Research Runbook

This branch is ready for real data once manifests are filled.

## 1. Validate Data Manifests

```bash
python paper/aaai2027-si-hsm/code/validate_manifest.py paper/aaai2027-si-hsm/manifests/erhu-pa.manifest.json --strict-paths
python paper/aaai2027-si-hsm/code/validate_manifest.py paper/aaai2027-si-hsm/manifests/cross-bowed.manifest.json --strict-paths
```

## 2. Run One Item

```bash
python paper/aaai2027-si-hsm/code/run_sihsm.py --mixture path/to/mix.wav --score path/to/score.musicxml --out-dir runs/item01 --instrument erhu --mode full
```

Supported internal modes:

- `full`
- `score_only`
- `pitch_only`
- `hpss`

Each full run writes `full.wav` and `posterior_trace.json`.

## 3. Run Manifest Experiments

```bash
python paper/aaai2027-si-hsm/code/run_manifest.py --manifest paper/aaai2027-si-hsm/manifests/erhu-pa.manifest.json --out-dir paper/aaai2027-si-hsm/runs/erhu-pa --robustness
```

The script runs mixture, HPSS, score-only, pitch-only, full SI-HSM, and oracle masks when clean references exist. Items without references still produce estimates but do not enter SDR/SIR/SAR.

## 4. External Baseline Status

```bash
python paper/aaai2027-si-hsm/code/external_baselines.py --manifest paper/aaai2027-si-hsm/manifests/erhu-pa.manifest.json --out-dir paper/aaai2027-si-hsm/runs/erhu-pa
```

Missing dependencies are marked `skipped`; no empty metrics are fabricated.

## 5. Build Paper Tables

```bash
python paper/aaai2027-si-hsm/code/summarize_manifest.py --manifest paper/aaai2027-si-hsm/manifests/erhu-pa.manifest.json --out-dir paper/aaai2027-si-hsm/tables
python paper/aaai2027-si-hsm/code/make_tables.py --results paper/aaai2027-si-hsm/runs/erhu-pa/results.csv --out-dir paper/aaai2027-si-hsm/tables
```

## Data Rules

- Clean stems are evaluation references only, never training data.
- No-reference student recordings are for downstream teacher-label F1 only.
- Jinghu, Banhu, and Gaohu transfer rows must be self-recorded or authorized.
