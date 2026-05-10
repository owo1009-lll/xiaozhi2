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
