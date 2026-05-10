# AAAI 2027 SI-HSM Project

## Working Title

Score-Informed Pitch-Guided Target Extraction for Low-Resource Bowed-String Instruments

## Core Position

This branch treats erhu separation as score-informed target extraction for a low-resource target instrument, not as a conventional supervised source-separation problem.

The central claim is:

> A score prior plus a pretrained pitch detector can drive target extraction for erhu without any erhu-specific separation training data, improving accompanied-recording analysis in piano and light-orchestral settings while exposing clear failure boundaries in dense unison orchestration.

## Scope Rules

- No claim of a fully training-free system. The separator itself is not trained, but the pitch detector can be pretrained.
- No claim of universal superiority over neural separators. The paper should report where the method wins, ties, and fails.
- No use of copyrighted recordings as an open dataset unless release rights are confirmed.
- No synthetic SDR/SIR/SAR claims in the main paper. Separation metrics require clean target and accompaniment references.
- Clean stems are not used for training. They are only used as evaluation references for SDR/SIR/SAR/SI-SDR.
- The plural "low-resource bowed-string instruments" claim requires a mini cross-instrument experiment on self-recorded or authorized Jinghu, Banhu, and Gaohu samples.

## P0 Review Blockers

The paper is not submission-ready until these are complete:

1. Replace the previous log-linear pitch fusion wording with a Bayesian posterior:
   `P(f | x, S, t) proportional to P(x | f, t) P(f | S, t)`.
2. Use symmetric octave-expanded candidates:
   `C_t = union_{k in {-1,0,+1}} {2^k f_det(t), 2^k f_score(t)}`.
3. Add the cross-instrument mini generalization set:
   Jinghu, Banhu, and Gaohu, 3-4 self-recorded or authorized items each, with only instrument pitch-range parameters changed.

## Directory Map

- `paper-outline.md` - AAAI paper structure and page budget.
- `experiment-plan.md` - datasets, baselines, metrics, ablations, robustness tests.
- `dataset-manifest.schema.json` - required metadata for each Erhu-PA item.
- `code/` - independent research code for posterior SI-HSM and manifest validation.
- `manifests/` - dataset manifest templates for Erhu-PA and cross-instrument transfer sets.
- `RUNBOOK.md` - exact commands to validate manifests, run extraction, run experiments, and build tables.
- `todo.md` - implementation and writing checklist.

## Implemented Non-Data Tooling

- MusicXML/JSON score reader for target-line notes.
- Bayesian posterior pitch selector with symmetric octave candidates.
- Posterior-weighted harmonic mask with HPSS reconstruction.
- Internal baselines: mixture, HPSS, score-only, pitch-only, oracle IBM, oracle IRM.
- Batch manifest runner with robustness perturbations.
- Separation and pitch metrics: SI-SDR, SDR/SIR/SAR approximation, pitch accuracy within 50 cents.
- External baseline status script that records missing dependencies as `skipped`.
- Dataset and result table generators.

## Remaining Data Milestones

1. Freeze the exact research claim and contribution wording.
2. Build the Erhu-PA manifest with license and ground-truth status for every item.
3. Add Jinghu, Banhu, and Gaohu self-recorded or authorized transfer items.
4. Run external baselines: HTDemucs and one modern strong separator such as BS-RoFormer or Mel-RoFormer.
5. Generate main results, ablation table, robustness curves, and downstream diagnosis table.
6. Draft the AAAI paper only after real metrics are available.
