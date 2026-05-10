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

## Liangxiao Score Branch Mode Diagnostic

Local data path:

`paper/aaai2027-si-hsm/runs.local/liangxiao-score-branch-mode-60s`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- score weight: 0.4
- reliability alpha: 4

| Mode | BasicPitch SI-SDR | BasicPitch SIR | Oracle SI-SDR | Oracle SIR |
|---|---:|---:|---:|---:|
| pitch-only baseline | 6.322 | 18.253 | n/a | n/a |
| always | 6.440 | 17.317 | 6.549 | 17.133 |
| conditional | 6.547 | 17.300 | 6.979 | 17.211 |
| none | 6.872 | 16.445 | 6.872 | 16.445 |

Interpretation:

- Conditional score branching improves over always-on branching, especially for the oracle score, but does not recover SIR.
- Removing the score branch entirely gives the best SI-SDR on this item, but SIR is much worse than pitch-only.
- Therefore the remaining SIR loss is not explained only by an always-on score band. It also comes from the full-mode mask strength and fallback behavior.
- Next method debug should separate two axes: score-branch admission versus mask aggressiveness/gamma calibration.

## Liangxiao Detector Policy Diagnostic

Local data paths:

- `paper/aaai2027-si-hsm/runs.local/liangxiao-score-branch-mode-raw-60s`
- `paper/aaai2027-si-hsm/runs.local/liangxiao-score-branch-mode-posterior-60s`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- score weight: 0.4
- reliability alpha: 4

| Detector policy | Mode | BasicPitch SI-SDR | BasicPitch SIR |
|---|---|---:|---:|
| pitch-only baseline | n/a | 6.322 | 18.253 |
| posterior | none | 6.872 | 16.445 |
| raw | none | 6.322 | 18.253 |
| posterior | conditional | 6.547 | 17.300 |
| raw | conditional | 6.333 | 17.602 |

Interpretation:

- `none + raw` is identical to pitch-only, proving that the current `none` mode does not retain a hidden score fallback.
- The gap between `none + posterior` and pitch-only comes from detector-only posterior octave candidates and gamma behavior, not score leakage.
- `conditional + raw` improves SIR over `conditional + posterior`, but does not reach the pitch-only SIR baseline.
- Since first-layer fallback is not the remaining issue, the next scan should target mask aggressiveness: bandwidth, residual mix, and score/detector gamma calibration.

## Liangxiao First-Layer Score Admission Gate

Local data path:

`paper/aaai2027-si-hsm/runs.local/liangxiao-score-admission-gate-60s`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- score weight: 0.4
- reliability alpha: 4
- detector policy: `raw`
- first-layer score admission: only admit score when detector confidence is low and score reliability is greater than 0.6.

| Mode | Score | SI-SDR | SIR | SAR | Pitch@50c |
|---|---|---:|---:|---:|---:|
| always | BasicPitch | 6.440 | 17.317 | 6.885 | 0.499 |
| conditional | BasicPitch | 6.325 | 18.252 | 6.673 | 0.484 |
| none | BasicPitch | 6.322 | 18.253 | 6.670 | 0.484 |
| conditional | oracle target pitch | 6.331 | 18.241 | 6.681 | 0.485 |

Interpretation:

- The admission gate restores SIR to the pitch-only level, so the remaining accompaniment leakage from the previous run was caused by letting noisy automatic score candidates enter low-confidence frames.
- With current BasicPitch MIDI, the reliable-score frames are too sparse to add measurable gain: conditional mode is effectively pitch-only.
- This is a useful negative result for the paper: automatic pseudo-scores need reliability gating, but the current reliability rule is conservative and does not replace clean or aligned score data.

## Liangxiao Mask Parameter Sweep After Admission Gate

Local data path:

`paper/aaai2027-si-hsm/runs.local/liangxiao-mask-param-sweep-admission-60s`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- score branch: `conditional`
- detector policy: `raw`
- score admission threshold: 0.6

| Bandwidth | Residual | SI-SDR | SIR | SAR | Pitch@50c |
|---:|---:|---:|---:|---:|---:|
| 48 | 0.05 | 6.390 | 18.356 | 6.734 | 0.486 |
| 38 | 0.05 | 6.325 | 18.252 | 6.673 | 0.484 |
| 48 | 0.03 | 6.277 | 21.000 | 6.457 | 0.490 |
| 48 | 0.01 | 6.124 | 24.821 | 6.196 | 0.500 |

Interpretation:

- Lower residual improves SIR but reduces SI-SDR/SAR, so it is a stricter accompaniment suppression setting rather than a better overall separator.
- Bandwidth 48 cents and residual 0.05 is the current SI-SDR/SIR Pareto point for the automatic-score condition.

## Admission-Gated 8-Piece SNR Run

Local data path:

`paper/aaai2027-si-hsm/runs.local/vip-snr-admission-gated-bw48-res005-60s`

Setup:

- 8 VIP pieces.
- SNR levels: +6, 0, -6 dB.
- score source: `auto_transcribed`.
- score-source-aware gate: alpha=4.
- score branch: `conditional`.
- detector policy: `raw`.
- mask parameters: bandwidth 48 cents, residual 0.05.

| SNR subset | Mixture SI-SDR | Pitch-only SI-SDR | Full SI-HSM SI-SDR | Oracle IRM SI-SDR | Full - Pitch |
|---|---:|---:|---:|---:|---:|
| piano_easy | 5.998 | 9.777 | 9.776 | 22.816 | 0.000 |
| piano_medium | -0.004 | 6.154 | 6.153 | 18.986 | -0.002 |
| piano_hard | -6.015 | 1.794 | 1.789 | 14.780 | -0.005 |

Interpretation:

- Admission gating fixes the structural SIR regression: full SI-HSM and pitch-only now match within 0.01 dB SI-SDR and SIR across all SNR levels.
- It also confirms that the current automatic BasicPitch pseudo-score does not provide a usable separation gain after unreliable frames are blocked.
- The next useful data step is not another mask tweak; it is either cleaner aligned score input for a small core set, or a stronger score reliability model that admits more correct score frames without reopening wrong BasicPitch bands.

## Liangxiao Rough Manual Score Probe

Local data path:

`paper/aaai2027-si-hsm/runs.local/liangxiao-manual-score`

Setup:

- piece: Liangxiao
- subset: `piano_medium`
- source: local `良宵-jianpu.jpg`
- manual score type: rough first-60-second jianpu pitch skeleton, not publication-grade MuseScore/MIDI.
- alignment: global DTW from rough JSON score to target erhu audio.

| Score | Notes | MIDI range | Best score weight | SI-SDR | SIR | SAR | Pitch@50c |
|---|---:|---:|---:|---:|---:|---:|---:|
| BasicPitch | 463 | 58-94 | 0.4 | 5.512 | 16.625 | 5.951 | 0.510 |
| rough manual + global DTW | 124 | 62-73 | 0.2 | 6.326 | 17.144 | 6.780 | 0.496 |
| oracle target pitch | 200 | 58-77 | 0.4 | 8.370 | 17.906 | 8.944 | 0.516 |

Interpretation:

- The manual-alignment pipeline works and the rough score improves over BasicPitch by +0.814 dB SI-SDR.
- It still does not reach the expected 7.5-8.3 dB band, because the rough jianpu transcription is only a pitch skeleton and loses octave, rhythm, ornament, and phrase timing details.
- A real MuseScore/作曲大师 manual MIDI is still required before claiming the manual-score operating regime in the paper main table.
