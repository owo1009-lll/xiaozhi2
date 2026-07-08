# Western Strings Practice Diagnostics

This repository is now scoped to the western bowed-string practice diagnosis line.

Current product target:

- Input: clean MusicXML or MIDI score plus a single-instrument recording.
- Primary instrument: violin.
- Extension targets: viola and cello after separate validation gates.
- Runtime policy: fail closed. Only high-confidence candidates can become `auto_pass`; all uncertain cases remain `review_required`.

## Current Status

- Western strings M0/M1/M2/M3 infrastructure is present.
- Ordinary-upload candidate review is available under:
  `data/experiments/western-strings-m3/offline-feature-candidate-review/`
- Candidate confidence pilot command:

```bash
npm run western:controlled-candidate-confidence-pilot
```

- Review status command:

```bash
npm run western:controlled-candidate-review-status
```

- Main local app:

```bash
npm run start
```

Open the app in western strings mode:

```text
http://127.0.0.1:3000/?mode=strings
```

The default browser entry also routes to western strings.

## Preserved Shared Infrastructure

Some legacy filenames still contain `erhu` because western strings reuses shared
infrastructure originally built for the previous prototype:

- score store and score-import services
- teacher validation service
- analyzer client and analysis job plumbing
- selected score-line role helpers

Do not delete these shared modules until their western-string replacements are
explicitly implemented and tested.

## Removed or Moved Out

Loose AI music-theory / AAAI music-theory residual files were moved to:

```text
C:\Users\Administrator\Downloads\ai乐理\migrated-from-ai-erhu-20260709
```

The paper directories `paper/ei-journal` and `paper/erhu-system-paper` are kept
in place because they are paper evidence, not runtime product code.

## Verification

Core checks used after cleanup:

```bash
npm run western:controlled-candidate-confidence-pilot
npm run test:western-alignment-preview
npm run build
```
