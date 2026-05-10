# Results Status

## VIP Synthetic SNR Smoke Test

Local data path:

`paper/aaai2027-si-hsm/runs.local/vip-snr-results-60s-v2`

Data:

- 8 VIP erhu solo recordings.
- 3 synthetic accompaniment target-SNR levels: hard -6 dB, medium 0 dB, easy +6 dB.
- 24 mixture items total.
- First 60 seconds per item for fast iteration.

Average results:

| Subset | Best internal non-oracle | SI-SDR | SIR | Pitch@50c |
| --- | --- | ---: | ---: | ---: |
| piano_easy | pitch-only | 9.739 | 23.622 | 0.722 |
| piano_easy | full SI-HSM | 8.338 | 22.845 | 0.721 |
| piano_medium | pitch-only | 6.108 | 17.814 | 0.511 |
| piano_medium | full SI-HSM | 5.037 | 16.223 | 0.533 |
| piano_hard | pitch-only | 1.744 | 10.490 | 0.346 |
| piano_hard | full SI-HSM | 1.000 | 8.556 | 0.365 |

Interpretation:

- The SNR generator is now valid: target and accompaniment stems sum to the mixture, and target SNR is -6/0/+6 dB.
- Full SI-HSM improves clearly over the mixture at all SNR levels.
- Pitch-only currently beats full SI-HSM on SI-SDR, while full SI-HSM is slightly better on pitch accuracy at medium and hard SNR.
- This indicates the BasicPitch-derived score prior is still too noisy for final claims; the next method step is to improve score-prior reliability or reduce its weight when the detector evidence is strong.

## Score Weight Sweep at 0 dB SNR

Local data path:

`paper/aaai2027-si-hsm/runs.local/score-weight-sweep-60s-v2`

Setup:

- subset: `piano_medium`
- 8 VIP pieces
- 60-second clips
- score weights: 0, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0
- `score_weight=0` is the pitch-only limit.

| Score weight | SI-SDR | SIR | SAR | Pitch@50c |
|---:|---:|---:|---:|---:|
| 0 | 6.108 | 17.814 | 6.488 | 0.511 |
| 0.1 | 6.120 | 16.948 | 6.585 | 0.521 |
| 0.2 | 5.864 | 16.794 | 6.323 | 0.528 |
| 0.4 | 5.519 | 16.490 | 5.982 | 0.529 |
| 0.6 | 5.296 | 16.300 | 5.761 | 0.529 |
| 0.8 | 5.149 | 16.332 | 5.597 | 0.533 |
| 1.0 | 5.037 | 16.223 | 5.487 | 0.533 |

Interpretation:

- The curve is near-flat at 0-0.1 and declines after 0.2.
- The best SI-SDR is at score weight 0.1, but the margin over pitch-only is small: +0.012 dB.
- Pitch accuracy improves as score weight increases, but SI-SDR and SAR fall.
- This supports the hypothesis that BasicPitch MIDI is a noisy score prior. The next evidence step should be a clean-score contrast on one piece, not another blind formula change.

## Liangxiao Score Quality Contrast

Local data path:

`paper/aaai2027-si-hsm/runs.local/liangxiao-score-quality-60s-v2`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- target SNR: 0 dB
- score weight: 0.4
- clip length: 60 seconds

| Score | Notes | MIDI range | SI-SDR | SIR | SAR | Pitch@50c |
|---|---:|---:|---:|---:|---:|---:|
| BasicPitch | 463 | 58-94 | 5.512 | 16.625 | 5.951 | 0.510 |
| cleaned BasicPitch | 287 | 55-82 | 5.527 | 16.398 | 5.992 | 0.512 |
| oracle target pitch | 200 | 58-77 | 8.370 | 17.906 | 8.944 | 0.516 |

Interpretation:

- Simple rule-based MIDI cleanup is not enough: SI-SDR improves by only +0.015 dB and SIR decreases.
- A clean, aligned pitch-score upper bound improves SI-SDR by +2.858 dB and SIR by +1.281 dB over BasicPitch.
- This means score quality and alignment are real bottlenecks, but the score branch can help when the score is reliable.
- The next practical step is to create real manual MIDI for 3-5 core pieces or add automatic score reliability gating before running cross-instrument experiments.

## Liangxiao Reliability Gating Diagnostic

Local data path:

`paper/aaai2027-si-hsm/runs.local/liangxiao-score-quality-gating-hard-60s`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- target SNR: 0 dB
- score weight: 0.4
- score input: BasicPitch MIDI
- gating: hard CREPE-score octave agreement gate

| Score | SI-SDR | SIR | SAR | Pitch@50c |
|---|---:|---:|---:|---:|
| BasicPitch, no gating | 5.512 | 16.625 | 5.951 | 0.510 |
| BasicPitch, hard gating | 6.505 | 16.997 | 6.991 | 0.490 |
| Oracle target pitch, no gating | 8.370 | 17.906 | 8.944 | 0.516 |
| Oracle target pitch, hard gating | 6.484 | 16.851 | 6.986 | 0.484 |

Interpretation:

- Hard gating recovers +0.993 dB SI-SDR and +0.372 dB SIR for noisy BasicPitch scores.
- The same hard gate hurts the oracle target-pitch score by -1.886 dB SI-SDR.
- Therefore reliability gating is useful for noisy automatic scores, but it must be adaptive to score source quality. It should not be used blindly for clean manual or oracle-aligned scores.
- The next method step is to expose score-source modes: `auto_transcribed` uses hard gating; `manual_aligned` uses weak or no gating.

## Liangxiao Soft-Gating Alpha Sweep

Local data path:

`paper/aaai2027-si-hsm/runs.local/liangxiao-reliability-alpha-60s`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- score weight: 0.4
- gating: `effective_score_weight = global_score_weight * reliability^alpha`

| Alpha | BasicPitch SI-SDR | Oracle SI-SDR | BasicPitch delta | Oracle delta |
|---:|---:|---:|---:|---:|
| 0 | 5.512 | 8.370 | 0.000 | 0.000 |
| 0.5 | 5.628 | 8.266 | +0.116 | -0.104 |
| 1 | 5.732 | 8.100 | +0.220 | -0.270 |
| 2 | 5.968 | 7.681 | +0.456 | -0.689 |
| 4 | 6.440 | 6.549 | +0.928 | -1.821 |

Interpretation:

- Continuous soft gating creates the expected tradeoff curve.
- No single alpha in this simple reliability formulation gives both BasicPitch recovery >= +1 dB and Oracle degradation <= -0.5 dB.
- This supports a score-source-aware policy or a richer reliability model, rather than blindly expanding the current gate to all SNR levels.

## Source-Aware 8-Piece SNR Smoke Test

Local data path:

`paper/aaai2027-si-hsm/runs.local/vip-snr-source-aware-results-60s`

Setup:

- 8 VIP pieces.
- SNR levels: +6, 0, -6 dB.
- score source: `auto_transcribed`.
- score-source-aware gate: alpha=4.
- methods: mixture, pitch-only, full+gating, oracle IRM.

| SNR subset | Mixture SI-SDR | Pitch-only SI-SDR | Full+gating SI-SDR | Oracle IRM SI-SDR | Full - Pitch |
|---|---:|---:|---:|---:|---:|
| piano_easy | 5.998 | 9.739 | 9.731 | 22.816 | -0.008 |
| piano_medium | -0.004 | 6.108 | 6.135 | 18.986 | +0.027 |
| piano_hard | -6.015 | 1.744 | 1.719 | 14.780 | -0.025 |

Interpretation:

- Full+gating is far above the mixture at all SNR levels.
- Full+gating is essentially tied with pitch-only, but only beats it on the medium SNR subset.
- Pitch accuracy improves slightly under full+gating in every SNR subset, while SIR is lower than pitch-only.
- The next debug target is not global gating strength; it is the per-frame rule that improves pitch localization but lets more accompaniment leak than pitch-only.
