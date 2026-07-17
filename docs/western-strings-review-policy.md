# Western Strings Review Policy

Updated: 2026-07-10

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
- `npm run western:controlled-pilot-evidence-audit`
- `npm run western:ordinary-monitored-pilot-audit`
- `npm run western:m3plus-monitored-pilot-audit`
- `npm run western:m4-gold-provenance-audit`
- `npm run western:m4-independent-gold-workspace-audit`
- `npm run western:m4-preflight`

## Current Decisions

### Ordinary Upload

`npm run western:ordinary-monitored-pilot-audit` must pass before any ordinary
upload monitored pilot. A safe session is not enough for V2-alpha: raw model
auto-pass rows must be separated from strict self-check eligible rows. Run
`npm run western:controlled-pilot-evidence-audit` before any new professional
review request. The current result has 100% precision on 11 strict self-check
rows but only 4.00% whole-piece operational coverage, below the 20% floor. The
joint threshold sweep found no confidence threshold that fixes the whole-piece
scope. A narrower first-measure-only scope has now passed machine checks across
five independent recordings: historical 12/12 and operational 11/11, with
25.53% and 26.83% scoped coverage. `teacherReviewAllowed=true` applies only to
one small fresh blind pack for that exact scope. Do not reuse existing labels,
do not include later measures, and do not send a pack until audio playback,
score location, controls, and scope membership pass machine QA. Raw model
auto-pass rows outside the scope remain `review_required`.

Stage that fresh recording with `npm run western:fresh-blind-intake-stage`; it audits a temporary
manifest and replaces the official intake only after every check passes. Confirm the persisted
candidate with `npm run western:fresh-blind-intake-status`.
The intake must use a new recording and, by default, a new piece/score; it also
requires a clean-score approval, consent/license metadata, a resolvable violin
part with a parseable first measure, decodable audio, and an existing score image/PDF. Any missing or reused
evidence blocks staging and professional review.
The ordinary precheck must use `--recording-id <fresh recordingId>` so accepted
historical submissions cannot be selected by list order.

### M3+ Pitch Behavior Modes

`npm run western:m3plus-monitored-pilot-audit` must pass before any M3+
monitored pilot. The current audit passes only for the narrow first-measure
candidate-quality subset:

- allowed release modes: `slide-like`, `trill-like`
- control mode: `stable`
- blocked modes: `double-stop-candidate`, `ornament-candidate`, `variable-f0`
- default student runtime remains disabled

This is not a broad M3+ release and not a technique-name display feature.

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
