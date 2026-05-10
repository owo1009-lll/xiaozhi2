# TODO

## P0: Claim and Data Validity

- [ ] Confirm the final claim avoids "fully training-free" wording.
- [ ] Keep the title plural only if Jinghu, Banhu, and Gaohu transfer items are included.
- [ ] List every candidate Erhu-PA item with license status.
- [ ] Mark which items have true clean target and accompaniment stems.
- [ ] Remove or quarantine any item without usable ground truth from SDR/SIR/SAR reporting.
- [ ] Decide which data can be released, which can only be described by metadata, and which cannot be used.
- [ ] Add cross-instrument manifest entries for Jinghu, Banhu, and Gaohu, using only self-recorded or authorized data.

## P0: Core Method

- [ ] Implement score-only harmonic mask.
- [ ] Implement pitch-only harmonic mask.
- [ ] Implement Bayesian posterior pitch selection.
- [ ] Use symmetric octave candidates from both detector and score frequencies.
- [ ] Implement posterior-weighted Gaussian harmonic mask.
- [ ] Add configuration for instrument pitch range, harmonic count, bandwidth, residual mix, and posterior weight.
- [ ] Export `posterior_trace.json` with detector likelihood, score prior, posterior, and chosen pitch per frame.

## P1: Evaluation

- [ ] Run internal baselines on all valid items.
- [ ] Run HTDemucs.
- [ ] Run BS-RoFormer or Mel-RoFormer.
- [ ] Run oracle IBM or IRM.
- [ ] Compute SI-SDR, SDR, SIR, SAR.
- [ ] Compute downstream pitch and diagnosis metrics.
- [ ] Generate robustness perturbation benchmark.
- [ ] Generate ablation table.
- [ ] Run pitch-range-only transfer on Jinghu, Banhu, and Gaohu.
- [ ] Run 4-6 teacher-reviewed real student samples for downstream F1.

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

## P0 Blockers Before AAAI Submission

- [ ] Bayesian posterior replaces log-linear fusion wording and implementation.
- [ ] Symmetric octave expansion replaces score-only octave expansion.
- [ ] Cross-instrument transfer set supports the plural title claim.
