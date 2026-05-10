# TODO

## P0: Claim and Data Validity

- [x] Confirm the final claim avoids "fully training-free" wording.
- [ ] Keep the title plural only if Jinghu, Banhu, and Gaohu transfer items are included.
- [ ] List every candidate Erhu-PA item with license status.
- [ ] Mark which items have true clean target and accompaniment stems.
- [ ] Remove or quarantine any item without usable ground truth from SDR/SIR/SAR reporting.
- [ ] Decide which data can be released, which can only be described by metadata, and which cannot be used.
- [ ] Add cross-instrument manifest entries for Jinghu, Banhu, and Gaohu, using only self-recorded or authorized data.

## P0: Core Method

- [x] Implement score-only harmonic mask.
- [x] Implement pitch-only harmonic mask.
- [x] Implement Bayesian posterior pitch selection.
- [x] Use symmetric octave candidates from both detector and score frequencies.
- [x] Implement posterior-weighted Gaussian harmonic mask.
- [x] Add configuration for instrument pitch range, harmonic count, bandwidth, residual mix, and posterior weight.
- [x] Export `posterior_trace.json` with detector likelihood, score prior, posterior, and chosen pitch per frame.

## P1: Evaluation

- [x] Add runner for internal baselines on all valid items.
- [x] Add external-baseline dependency/status framework for HTDemucs and BS-RoFormer/Mel-RoFormer proxy policy.
- [x] Implement oracle IBM or IRM.
- [x] Compute SI-SDR, SDR, SIR, SAR.
- [x] Compute pitch metrics and add downstream F1 utility for teacher-reviewed labels.
- [x] Generate robustness perturbation benchmark.
- [x] Add result table generator.
- [ ] Run pitch-range-only transfer on Jinghu, Banhu, and Gaohu.
- [ ] Run 4-6 teacher-reviewed real student samples for downstream F1.

## P2: Paper Assets

- [ ] Create AAAI LaTeX skeleton after final author kit is available.
- [ ] Create Figure 1 framework diagram.
- [ ] Create Figure 2 robustness curves.
- [ ] Create Figure 3 spectrogram comparison.
- [x] Create Table 1 dataset summary generator.
- [x] Create Table 2 main results generator.
- [ ] Create Table 3 ablation results.
- [ ] Create Table 4 downstream diagnosis results.

## P2: Release Package

- [ ] Prepare anonymous code repository.
- [ ] Prepare anonymous dataset metadata package.
- [x] Add reproducibility commands.
- [x] Add environment file.
- [x] Add model/download notes for external baselines.
- [ ] Add limitations and ethics notes.

## P0 Blockers Before AAAI Submission

- [x] Bayesian posterior replaces log-linear fusion wording and implementation.
- [x] Symmetric octave expansion replaces score-only octave expansion.
- [ ] Cross-instrument transfer set supports the plural title claim.
