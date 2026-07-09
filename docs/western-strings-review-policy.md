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

