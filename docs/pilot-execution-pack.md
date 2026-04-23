# Pilot Execution Pack

This document describes the pilot-facing layer that now sits on top of the existing whole-piece scaffold and research export pipeline.

## Goal

Turn the current `桃花坞` whole-piece pass into a repeatable small-sample pilot workflow:

1. run the whole-piece pass
2. extract the weakest sections automatically
3. hand those sections to teachers first
4. keep the participant, teacher, and researcher aligned on the same priority list

## Current command

```powershell
npm run pilot:pack:taohuawu
```

## Current output

The command reads:

- `data/piece-pass/taohuawu-whole-v3/taohuawu-test-fragment-whole-piece-pass.json`

And writes:

- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-pilot-overview.md`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-participant-run-sheet.md`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-weak-sections.csv`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-teacher-validation-sheet.csv`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-pilot-manifest.json`

## Recommended usage

- Use the participant run sheet during the actual recording session.
- Use the weak-sections CSV to decide which sections should be reviewed first.
- Give the teacher-validation CSV to two teachers when running pilot validation.
- Keep the manifest as a frozen reference to the exact whole-piece pass that produced the pack.

## Why this matters

The project no longer relies on manually reading the whole-piece report to decide what to validate first. The pilot pack turns the current whole-piece pass into a stable operational artifact that can be reused across repeated recordings.
