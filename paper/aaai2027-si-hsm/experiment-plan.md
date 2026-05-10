# Experiment Plan

## Primary Evaluation Question

Can score-informed posterior pitch selection plus harmonic masking extract erhu from accompanied recordings without erhu-specific separation training data better than off-the-shelf source separators and simpler score-only or pitch-only masks?

## Dataset: Erhu-PA

Each item must include:

- mixture audio
- target erhu reference, if available
- accompaniment reference, if available
- MusicXML target score, or the branch's compact JSON note format
- license and release status
- accompaniment type
- difficulty metadata

Subsets:

| Subset | Target count | Required GT | Difficulty metadata |
| --- | ---: | --- | --- |
| Piano | 16 | erhu + accompaniment stems | piano density, spectral overlap |
| Orch-light | 8 | erhu + accompaniment stems | string-energy ratio, spectral overlap |
| Orch-heavy | 8 | erhu + accompaniment stems | unison-string ratio, spectral overlap |
| Jinghu-transfer | 3-4 | target + accompaniment stems | pitch range, spectral overlap |
| Banhu-transfer | 3-4 | target + accompaniment stems | pitch range, spectral overlap |
| Gaohu-transfer | 3-4 | target + accompaniment stems | pitch range, spectral overlap |

Release rule:

- Only authorized or self-recorded audio can be redistributed.
- Copyright-restricted items can be used for internal evaluation only and should be represented by metadata plus evaluation scripts.
- Do not report clean-stem separation metrics for any item without true references.
- Cross-instrument transfer items must be self-recorded or authorized. Public video-platform recordings may only be used for qualitative demonstrations, not objective tables.
- Clean stems are evaluation references only. They are not used to train or tune an erhu-specific separation model.

## Baselines

Internal:

- Mixture
- HPSS
- Score-only harmonic mask
- Pitch-only harmonic mask
- Full posterior SI-HSM
- Oracle IBM or IRM

External:

- Open-Unmix
- Spleeter
- HTDemucs
- BS-RoFormer or Mel-RoFormer, using the vocals or monophonic-target proxy stem because erhu-specific checkpoints are unavailable

## Metrics

Separation:

- SI-SDR
- SDR
- SIR
- SAR

Pitch target quality:

- raw pitch accuracy within 50 cents
- voiced-frame false positive rate
- voiced-frame false negative rate
The current branch computes pitch accuracy; voiced-frame FP/FN can be derived from the same frame estimates after real labels are available.

Downstream diagnosis:

- note-level precision, recall, F1
- measure-level precision, recall, F1
- false-positive rate
- teacher-reviewed path agreement

## Robustness Tests

Score perturbations:

- timing shift: 0, 0.5, 1, 2, 3 seconds
- missing notes: 0%, 10%, 20%
- pitch corruption: random +/-100 cents drift on 0%, 10%, 20% of score notes
- octave errors: 0%, 10%, 20%

Real-world subset:

- 4-6 student recordings without full clean stems but with teacher-reviewed local pitch-error labels.
- Report downstream pitch-error detection F1, measure-level F1, and false-positive rate.
- These samples support practice-diagnosis claims but do not enter SDR/SIR/SAR.

Pitch-detector sensitivity:

- confidence threshold or posterior lambda sweep
- weak-performance frames
- tail notes
- vibrato-heavy notes

## Ablations

Each ablation changes one component:

- no score prior
- no detector posterior
- no octave candidates
- rectangular mask instead of Gaussian mask
- no HPSS
- no posterior confidence weighting
- no residual mix

P0 method ablations:

- previous fallback fusion versus Bayesian posterior selection
- asymmetric score-only octave expansion versus symmetric detector-and-score octave expansion
- no cross-instrument retuning versus pitch-range-only transfer

## Acceptance Criteria Before Writing Main Claims

- At least 24 items have clean target and accompaniment references.
- Every reported metric maps to an item with valid references.
- Strong neural baselines are reproducible from documented commands.
- The method wins or is competitive in at least piano and light-orchestral subsets.
- The plural bowed-string claim is backed by Jinghu, Banhu, and Gaohu transfer items.
- Failure in heavy orchestral settings is quantified, not hidden.
- Downstream diagnosis results use teacher-reviewed or otherwise defensible labels.
