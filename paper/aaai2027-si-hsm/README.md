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

## Directory Map

- `paper-outline.md` - AAAI paper structure and page budget.
- `experiment-plan.md` - datasets, baselines, metrics, ablations, robustness tests.
- `dataset-manifest.schema.json` - required metadata for each Erhu-PA item.
- `todo.md` - implementation and writing checklist.

## Immediate Milestones

1. Freeze the exact research claim and contribution wording.
2. Build the Erhu-PA manifest with license and ground-truth status for every item.
3. Implement three internal baselines: score-only mask, CREPE-only mask, and full posterior SI-HSM.
4. Run external baselines: HTDemucs and one modern strong separator such as BS-RoFormer or Mel-RoFormer.
5. Generate main results, ablation table, robustness curves, and downstream diagnosis table.
6. Draft the AAAI paper only after real metrics are available.
