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
- `npm run western:ordinary-monitored-pilot-audit`
- `npm run western:m3plus-monitored-pilot-audit`

## Current Decisions

### Ordinary Upload

`npm run western:ordinary-monitored-pilot-audit` must pass before any ordinary
upload monitored pilot. The current audit passes with no teacher review needed:
all self-checked auto-pass rows are known usable, with zero known wrong rows and
zero unknown rows.

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

M4 still requires independent gold correction. Do not ask for broad model or
teacher review until the independent-gold workspace is corrected and the OMR
benchmark is rerun.

This M4 task is a score-editor task, not an audio-diagnosis task: compare each
source score image/PDF against the editable MusicXML/MXL gold file. A music
teacher is only needed if they are acting as a score editor; they should not be
asked to judge intonation, rhythm, or student performance for this gate.

Independent gold application has two safety gates:

- the editable MXL/MusicXML file must differ from the Audiveris draft; and
- the workspace row must explicitly set `reviewStatus=approved`.

Rows left as `needs-human-edit` must not be applied, even if the file timestamp
or bytes changed. Use `npm run western:m4-apply-independent-gold-workspace --
--dry-run` before applying changes.

Before any apply attempt, run
`npm run western:m4-independent-gold-workspace-audit`. It reports:

- changed but not approved files;
- approved files that are still byte-identical to the Audiveris draft;
- missing source/current/draft/editable files; and
- rows that are actually ready to apply.
