# Western Strings Review Policy

Updated: 2026-07-18

This project must not use the user or a professional teacher as a debugging tool.
Human review is a final adjudication step, not the first quality gate.

## Default Flow

Every review package or monitored-pilot step must pass machine checks before it is
sent to the user or teacher.

1. Run the relevant status or audit command.
2. Confirm audio files exist and can be opened by the generated page or API.
3. Confirm score locators, page ranges, and measure context are present.
4. Confirm the package states exactly what the reviewer must judge.
5. Confirm unsafe known errors and unsupported modes are blocked before review.
6. Ask for human review only for rows that remain genuinely unknown.

If any of these checks fails, the next action is engineering work, not teacher
review.

## Human Review Budget

Manual review should be small and targeted.

- If an audit finds only known-safe rows, do not ask for review.
- If an audit finds known-wrong auto-pass rows, stop and fix the model or
  candidate generation.
- If an audit finds unknown auto-pass rows, export only those unknown rows.
- Do not send broad packages while audio playback, score alignment, or button
  interactions are still unverified.

## Current Self-Test Commands

Use these before asking for any review:

- `npm run western:project-status`
- `npm run western:next-actions`
- `npm run test:western-project-gate`
- `npm run western:ordinary-dynamic-shadow-runtime-preflight`
- `npm run test:western-dynamic-shadow-policy`
- `npm run test:western-offline-feature-audio`
- `npm run test:western-alignment-preview`
- `npm run test:western-m3plus-rescope-gate`
- `npm run test:western-m3plus-runtime-policy`
- `npm run western:m3plus-monitored-pilot-audit`
- `npm run western:m4-gold-provenance-audit`
- `npm run western:m4-independent-gold-workspace-audit`
- `npm run western:m4-preflight`

## Current Decisions

### Ordinary Upload

The current ordinary authority is the review-only dynamic-shadow path. Its
pinned audio runtime passes the foundation preflight, but the live r3 artifact
verifier is not implemented, r3 acceptance has not run, the causal-energy veto
is not included in the frozen runtime, and `authorizationReady=false`. No
ordinary monitored pilot or professional-review pack is authorized yet.

The newer gap-penalty DTW plus causal-energy-veto research executor is a real
positive result: after three-stage confirmation it reached 97.91% clean
precision and 36.00% coverage, with `releaseCoverageReady=true` for the public
synthetic-perturbation research gate. It does not set `studentGateReady` and is
not wired as current pilot authority. Its main diagnostic contribution is that
the old executor's whole-piece linear time mapping, rather than threshold
tuning alone, was the principal coverage bottleneck.

The old first-measure RF result (historical 12/12 and operational 11/11, with
25.53% and 26.83% scoped coverage) is consumed and superseded. Its former
`teacherReviewAllowed=true` and `western:controlled-pilot-evidence-audit`
cannot authorize another pack. The legacy
`western:fresh-blind-intake-*` aliases intentionally exit before reading or
writing evidence. The `western:historical-fresh-blind-intake-*` aliases plus
the exact `--historical-replay` flag exist only to reproduce that historical
record; they cannot create current release authority.

Round-3 is implementation-acceptance evidence, not release-blind evidence:
`r3-01` has already been consumed by infrastructure replay, while `r3-02` and
`r3-03` remain reserves that may be used only after the live verifier exists.
The required current release contract is
`ordinary-dynamic-shadow-full-score-fresh-blind-v1`, using a wholly new
recording and new piece after implementation acceptance. Its runner and audit
are not implemented, so there is currently nothing to stage or send for human
review.

### M3+ Pitch Safety (rescope four-zone contract)

`npm run western:m3plus-monitored-pilot-audit` must pass before any M3+
monitored pilot. Since the 2026-07-17 rescope decision the audit no longer
scores audio technique-mode detection; it audits the frozen holdout
rescope-gate report (`npm run western:m3plus-rescope-gate`) against the
four-zone pitch-safety contract (`m3plus-rescope-four-zone-v2`):

Regenerate that report only when its source evidence changes, then create a
fresh controlled batch bound to the new report SHA. Release review uses
`npm run test:western-m3plus-rescope-gate` and must not rewrite the report
under an already-audited batch.

- unmarked straight-tone zone: 12 expected source units; independent per-unit
  intonation gold is currently 0/12, so precision is not authorized
- score-marked zone (tr/ornament/harmonic): 14 protected units are frozen, but
  only 8 have actual policy execution and 6 remain declared-only; every unit
  must execute and remain `insufficient_evidence`
- technique-center zone: 8 expected source units; independent per-unit
  intonation gold is currently 0/8. The existing 3/8 score-intent agreement is
  not intonation accuracy, and 17 round-2 vibrato gold units remain unscored
- unstable fallback: every high-dispersion stress case becomes
  `insufficient_evidence`, zero accusations
- rhythm/onset lane: inherits the unchanged M3 core gate (not re-scored here),
  whose evidence remains thin at only two error examples per class

The retired first-measure `slide-like`/`trill-like` candidate-quality contract
is superseded, not pending repair. The current gold-free runtime foundation and
physical runtime audit pass, but `offlineEvidenceReady=false` and
`authorizationReady=false` because the frozen execution and independent-gold
requirements above are incomplete. A passing runtime audit is only a physical
evidence precondition; it does not by itself authorize a monitored pilot. The
default student runtime stays disabled, both separately audited executors and
the owner's explicit approval command chain remain required, and this is not a
technique-name display feature.

### M4 OMR

The current 12 M4 rows already have explicit human clean-score approval and the
provenance audit reports `manualGoldRequiredRows=0`. Do not ask for another M4
review of this same set. If a future provenance audit reports rows that really
need independent correction, that is a score-editor task, not an audio-diagnosis
task: compare the source score image/PDF against editable MusicXML/MXL. A music
teacher should not be asked to judge intonation, rhythm, or student performance
for this gate.

The Oemer-era stronger-engine comparison is also complete. Oemer 0.1.8 failed
to produce MusicXML for one of five frozen source-gold photos and passed the
strict precision/recall gate on zero of five. This is a machine accuracy
limitation, not a request for more teacher review. That result keeps automatic
adoption and student release off; it does not prohibit an explicitly bounded
offline machine pipeline.

HOMR 0.7.0 was then evaluated on the same five sources. The current 2026-07-17
fresh authority uses ONNX Runtime 1.27.0 and reports P/R=0.883324/0.957827,
onset-quarter=0.300319, measure=0.790415, and complete strict pass 0/5. The
tracked aggregate and per-page hashes are in
`docs/evidence/western-strings-homr-sourcegold-20260717.json`; project status and
M4 preflight must read this manifest, not the 2026-07-15 first-run report.

Do not collapse three different boundaries. Inside the offline v3 function,
HOMR is a peer arbitration candidate and a winner directly produces a machine
full/degraded decision. The controlled batch still requires a prior human
`accepted_for_batch` action and writes review-only artifacts with
`studentFacing=false`. The formal analyzer mainline remains
`mainlineExecutable=false`, and student release/automatic adoption remain off.

HOMR licensing and deployment are an independent gate, not an accuracy metric.
Run `npm run western:photo-score-deployment-preflight` before any controlled
batch. Until the named AGPL/model review is recorded and both isolated runtimes,
the dependency lock, local models, and engine pool all pass, the preflight and
project gate must fail closed. A pending license decision is not a teacher or
score-editor review task and must never be filled with a fabricated reviewer.

Clarity-OMR was also evaluated on the same five frozen sources. Native viewer
screenshots failed Stage-A staff detection; a fixed, gold-independent page trim
allowed five outputs, but aggregate pitch P/R was 0.7277/0.3553 and
onset/measure accuracy was 0.0281/0.1010. Complete strict pass remained 0/5.
This is machine evidence only: do not assign another teacher review or enable
runtime OMR from it.

Independent gold application has two safety gates:

The 2026-07-15 M3+/M4 non-human validation evidence is recorded in
`western-strings-m3plus-m4-evidence-2026-07-15.md`. In particular:

- low-quality frame-F0 evidence is `uncertain`, never an automatic negative;
- unmarked legacy performances are not assumed to be technique-negative;
- OMR/audio agreement is correlated evidence and does not replace clean score gold;
- measure-level summaries cannot upgrade an unsafe note-level decision; and
- no supplemental M3+ teacher review is requested before the recordings exist and
  the machine gate has identified a real adjudication need.

- the editable MXL/MusicXML file must differ from the Audiveris draft; and
- the workspace row must explicitly set `reviewStatus=approved`.

Rows left as `needs-human-edit` must not be applied, even if the file timestamp
or bytes changed. Use `npm run western:m4-apply-independent-gold-workspace --
--dry-run` before applying changes.

Before asking anyone to edit future score files, run
`npm run western:m4-preflight`. It runs the M4 evidence readiness, benchmark,
independent-gold todo/workspace, provenance, workspace audit, independent
render/scan/photo benchmark audit, project status,
independent-gold note summary, and next-action handoff commands in one machine
self-test pass. This evidence preflight is not a photo-score deployment proof;
the latter is the separate fail-closed command
`npm run western:photo-score-deployment-preflight`. The note summary is only a machine-readable preview of the
current editable MXL files; it does not replace score-editor correction. If it
reports `humanTask=score-editor-independent-gold-correction`, then the
project has already exhausted the current automatic checks and the remaining
human work is score-editor correction only.

For the lower-level provenance detail, run
`npm run western:m4-gold-provenance-audit`. It reports whether the current
gold/editable files are still byte-identical to the Audiveris draft and whether
any independent clean-score candidates already exist in the repository. If it
reports `manualGoldRequiredRows`, the remaining task is score-editor gold
correction, not teacher audio diagnosis.

Before any apply attempt, run
`npm run western:m4-independent-gold-workspace-audit`. It reports:

- changed but not approved files;
- approved files that are still byte-identical to the Audiveris draft;
- missing source/current/draft/editable files; and
- rows that are actually ready to apply.
