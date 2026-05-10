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
- Target-only solo erhu files can be used for SI-SDR, pitch, and score-alignment sanity tests, but not for SIR/SAR.
- No-reference student recordings are for downstream teacher-label F1 only.
- Jinghu, Banhu, and Gaohu transfer rows must be self-recorded or authorized.

## Local VIP Solo Data Probe

```bash
python paper/aaai2027-si-hsm/code/probe_vip_dataset.py --dir C:\Users\Administrator\Music\VipSongsDownload --out-dir paper/aaai2027-si-hsm/runs.local/vip-data-test --seconds 20
```

This writes a local target-only manifest, 20-second smoke-test clips, SI-HSM outputs, posterior traces, and `vip-data-test.csv`.

## Build Local Synthetic Mixtures from VIP Solo Audio

```bash
python paper/aaai2027-si-hsm/code/build_vip_synthetic_mix.py --dir C:\Users\Administrator\Music\VipSongsDownload --out-dir paper/aaai2027-si-hsm/runs.local/vip-synthetic-mix
python paper/aaai2027-si-hsm/code/run_manifest.py --manifest paper/aaai2027-si-hsm/runs.local/vip-synthetic-mix/vip-synthetic-mix.local.manifest.json --out-dir paper/aaai2027-si-hsm/runs.local/vip-synthetic-results
```

This creates internal `synthetic_mix` items with target, accompaniment, mixture, MIDI score paths, and hard/medium/easy target SNR levels at -6/0/+6 dB.
