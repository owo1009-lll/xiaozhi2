# Paper Outline

Target venue: AAAI 2027.

Planning assumption: 7 pages of technical content plus references, subject to the final AAAI 2027 author kit.

## Title

Score-Informed Pitch-Guided Target Extraction for Low-Resource Bowed-String Instruments

Optional conservative subtitle:

No Erhu-Specific Separation Training for Accompanied Erhu Recordings

## Abstract

Four-sentence structure:

1. Low-resource instruments such as erhu lack isolated stems for training supervised source-separation models, yet target extraction from accompanied recordings is required for practice feedback and music analysis.
2. We propose a score-informed target extraction framework that combines weak score priors, a pretrained pitch detector, posterior pitch selection, and harmonic spectral masking.
3. We instantiate the framework for erhu and evaluate it on Erhu-PA, covering piano, light orchestral, and dense orchestral accompaniment against neural, classical, score-only, and pitch-only baselines.
4. The method improves target SDR and downstream pitch-diagnosis stability in piano and light-orchestral settings, transfers to related bowed-string instruments by changing pitch-range parameters, and exposes failure boundaries under dense unison strings and poor score alignment.

## 1. Introduction

Budget: 0.8 pages.

Questions answered:

- Why is target extraction needed for erhu practice feedback?
- Why are standard supervised separators insufficient for low-resource instruments?
- Why can score priors and pitch observations complement each other?
- What are the contributions?

Contribution wording:

- C1: We formulate accompanied-erhu separation as score-informed target extraction for low-resource single-line instruments.
- C2: We propose a posterior pitch selection mechanism combining score priors and pretrained pitch-detector observations.
- C3: We introduce a posterior-weighted harmonic mask that requires no erhu-specific separation training data.
- C4: We build Erhu-PA with transparent ground-truth and license metadata.
- C5: We connect separation quality to downstream practice-diagnosis stability.
- C6: We report a mini cross-instrument transfer experiment on Jinghu, Banhu, and Gaohu, using only instrument pitch-range changes.

## 2. Related Work

Budget: 0.5 pages.

Sections:

- Neural music source separation: Open-Unmix, Spleeter, Demucs/HTDemucs, BS-RoFormer, Mel-RoFormer, Banquet.
- Score-informed separation: NMF, score following, MIDI-informed separation.
- Pitch-guided and low-resource target extraction: pYIN, CREPE, BasicPitch, pitch-informed masks, non-Western instrument audio AI.

Positioning:

This work is neither blind supervised separation nor pure score-informed separation. It is score-prior and pitch-observation target extraction designed for low-resource, approximately monophonic instruments.

## 3. Method

Budget: 1.75 pages.

### 3.1 Problem Formulation

Input:

```text
x(t) = s(t) + a(t)
```

where `s(t)` is the target erhu signal and `a(t)` is accompaniment.

Weak score:

```text
S = {(onset_i, duration_i, pitch_i)}
```

Output:

```text
s_hat(t)
```

Goal: estimate the target without training an erhu-specific separator.

Applicability conditions:

- The target is approximately monophonic.
- The target has a harmonic structure that can be represented by a small number of harmonic bands.
- A weakly aligned score or symbolic target line is available.
- The target pitch range is known for the instrument.

### 3.2 Framework Overview

Figure 1: block diagram.

```text
Mixture -> STFT/HPSS -> Score Prior
                      -> Pitch Observation
                      -> Posterior Pitch Selection
                      -> Harmonic Target Mask
                      -> Reconstruction
```

### 3.3 Score Prior Construction

Extract target pitch, onset, duration, frequency, and tolerance windows from MusicXML or MIDI. Use global duration scaling first; support local timing tolerance for student-level timing drift.

### 3.4 Pretrained Pitch Observation

Use a general pretrained pitch detector to produce:

```text
f_det(t), c_det(t)
```

The method uses this as an observation source, not as erhu-specific training data.

### 3.5 Bayesian Pitch Posterior Selection

Candidate set:

```text
C_t = union_{k in {-1,0,+1}} {2^k f_det(t), 2^k f_score(t)}
```

Decision:

```text
f_eff(t) = argmax_f P(x | f, t) * P(f | S, t)
```

`P(x | f, t)` is a detector likelihood derived from the pitch estimate and confidence. High confidence yields a narrow likelihood; low confidence yields a wide likelihood. `P(f | S, t)` is an octave-aware score prior derived from the active score window, instrument range, and timing tolerance. Octave flex emerges from the posterior instead of a hand-coded fallback.

### 3.6 Posterior-Weighted Harmonic Mask

Build a harmonic comb around `f_eff(t)`.

Key parameters:

- harmonic count `H`
- bandwidth in cents `B`
- residual mix `rho`
- posterior confidence weight `gamma_t`

Low-confidence frames use conservative masks.

### 3.7 Reconstruction

Apply the mask to the harmonic spectrogram and reconstruct by iSTFT. This is not the method contribution and should be described in three compact sentences. Report runtime complexity and real-time factor.

## 4. Experiments

Budget: 1.25 pages.

Required contents:

- Erhu-PA dataset summary with license and ground-truth status.
- Cross-instrument mini transfer set: Jinghu, Banhu, and Gaohu, self-recorded or authorized, 3-4 items each.
- Baselines: mixture, HPSS, score-only, pitch-only, Open-Unmix, Spleeter, HTDemucs, BS-RoFormer or Mel-RoFormer, oracle mask.
- Metrics: SDR or SI-SDR, SIR, SAR, pitch accuracy within 50 cents, downstream diagnosis metrics.
- Robustness tests over score shift, missing notes, pitch corruption, and octave errors.
- Ablations over score prior, detector posterior, octave candidates, mask shape, HPSS, and confidence weighting.

Data authenticity note:

The orchestral-heavy subset may use authorized sample-library renderings or synthetic mixtures to obtain clean reference stems. This must be stated in the main dataset paragraph, not hidden in a footnote.

## 5. Results and Discussion

Budget: 1.6 pages.

Tables and figures:

- Table 2: main method-by-accompaniment results.
- Table 3: ablation results.
- Table 4: downstream diagnosis results.
- Figure 2: robustness curves.
- Figure 3: spectrogram comparison.

Expected honest interpretation:

- Piano: proposed method should be strongest or clearly competitive.
- Light orchestral: proposed method should be competitive with strong neural baselines.
- Heavy orchestral: proposed method may tie or lose because harmonic overlap is intrinsic.

Failure boundaries should be folded into the downstream/failure discussion to preserve page budget.

## 6. Conclusion and Limitations

Budget: 0.35 pages.

Must include:

- No erhu-specific separation training data.
- Low-resource target extraction framing.
- Limitations: small dataset, data-release constraints, dense unison failure, monophonic target assumption, unverified transfer to other instruments.

Page budget control:

- Related Work target: 0.4 pages.
- Reconstruction target: 3 sentences.
- Figure 1 target: compact single-column version.
- Failure boundaries: merge into Results and Discussion.
