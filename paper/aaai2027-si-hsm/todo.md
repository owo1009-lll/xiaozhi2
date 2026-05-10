# TODO

## P0: Claim and Data Validity

- [ ] Confirm the final claim avoids "fully training-free" wording.
- [ ] List every candidate Erhu-PA item with license status.
- [ ] Mark which items have true clean target and accompaniment stems.
- [ ] Remove or quarantine any item without usable ground truth from SDR/SIR/SAR reporting.
- [ ] Decide which data can be released, which can only be described by metadata, and which cannot be used.

## P0: Core Method

- [ ] Implement score-only harmonic mask.
- [ ] Implement pitch-only harmonic mask.
- [ ] Implement posterior pitch selection.
- [ ] Implement posterior-weighted Gaussian harmonic mask.
- [ ] Add configuration for instrument pitch range, harmonic count, bandwidth, residual mix, and posterior weight.

## P1: Evaluation

- [ ] Run internal baselines on all valid items.
- [ ] Run HTDemucs.
- [ ] Run BS-RoFormer or Mel-RoFormer.
- [ ] Run oracle IBM or IRM.
- [ ] Compute SI-SDR, SDR, SIR, SAR.
- [ ] Compute downstream pitch and diagnosis metrics.
- [ ] Generate robustness perturbation benchmark.
- [ ] Generate ablation table.

## P2: Paper Assets

- [ ] Create AAAI LaTeX skeleton after final author kit is available.
- [ ] Create Figure 1 framework diagram.
- [ ] Create Figure 2 robustness curves.
- [ ] Create Figure 3 spectrogram comparison.
- [ ] Create Table 1 dataset summary.
- [ ] Create Table 2 main results.
- [ ] Create Table 3 ablation results.
- [ ] Create Table 4 downstream diagnosis results.

## P2: Release Package

- [ ] Prepare anonymous code repository.
- [ ] Prepare anonymous dataset metadata package.
- [ ] Add reproducibility commands.
- [ ] Add environment file.
- [ ] Add model/download notes for external baselines.
- [ ] Add limitations and ethics notes.
