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

Before staging that fresh recording, run `npm run western:fresh-blind-intake-status`.
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

Independent gold application has two safety gates:

- the editable MXL/MusicXML file must differ from the Audiveris draft; and
- the workspace row must explicitly set `reviewStatus=approved`.

Rows left as `needs-human-edit` must not be applied, even if the file timestamp
or bytes changed. Use `npm run western:m4-apply-independent-gold-workspace --
--dry-run` before applying changes.

Before asking anyone to edit future score files, run
`npm run western:m4-preflight`. It runs the M4 readiness, benchmark,
independent-gold todo/workspace, provenance, workspace audit, project status,
independent-gold note summary, and next-action handoff commands in one machine
self-test pass. The note summary is only a machine-readable preview of the
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
