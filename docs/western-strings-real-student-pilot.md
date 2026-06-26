# Western Strings M2f Real-Student Recording Pilot

> Purpose: this is the required release gate after synthetic M2d/M2e tests.
> Passing synthetic event perturbations is not enough to open student-facing
> automatic feedback. Real recordings must pass this pilot first.

Recorder-facing checklist: [western-strings-m2f-recording-checklist.md](western-strings-m2f-recording-checklist.md).

## Scope

M2f validates the current western-strings `studentSafe=1` gate on real or
realistic student violin recordings.

Supported first pass:

- instrument: violin only
- score input: clean MusicXML/MIDI or dataset score
- feedback scope: note alignment and basic pitch/rhythm/missing-note evidence
- excluded: technique labels, PDF OMR, cello, heavy rubato, mixed ensemble audio

## Required Recording Set

Minimum before the gate can pass:

- at least 6 recordings
- at least 3 students or performers
- all required scenarios represented:
  - `correct`
  - `wrong_pitch`
  - `missing_note`
  - `rhythm_shift`
  - `weak_onset`
  - `noisy`

Recommended pilot size before release discussion:

- 3-5 students
- 2 short pieces per student
- 30-90 seconds per recording
- phone and clean microphone variants if possible

## Manifest

Default path:

`data/experiments/western-strings-m2/real-student-recordings-manifest.csv`

Generate fillable templates:

```powershell
npm run western:m2f-templates
```

This writes `real-student-recordings-manifest.template.csv` and
`real-student-recording-results.template.csv` under
`data/experiments/western-strings-m2/`. The templates are not read by the gate
until copied/renamed to the default manifest/results paths. This preserves
fail-closed behavior while giving the recorder a safe column template.

After the filled manifest exists, generate a matching results skeleton:

```powershell
npm run western:m2f-results-skeleton
```

This creates `real-student-recording-results.csv` with the same `recordingId`
values as the manifest and blank metric columns. Fill those counts only after
running the `studentSafe=1` alignment gate on each real recording.

Required columns:

| column | rule |
|---|---|
| `recordingId` | stable unique id |
| `studentId` | anonymized id |
| `instrument` | currently must be `violin` |
| `pieceId` | score/piece id |
| `audioPath` | repo-relative or absolute local path; file must exist |
| `scorePath` or `scoreId` | one must be present; `scorePath` must exist |
| `scenario` | one of the required scenarios above, plus optional `extra_note` |
| `humanChecked` | must be `yes` |
| `consent` | must be `yes` |
| `licenseStatus` | `local-only` or `cleared` |
| `startSeconds` / `endSeconds` | optional window; if one is present both must be valid |
| `notes` | optional |

Example:

```csv
recordingId,studentId,instrument,pieceId,audioPath,scorePath,scoreId,scenario,humanChecked,consent,licenseStatus,startSeconds,endSeconds,notes
stu01-scale-correct,stu01,violin,scale-g-major,data/private/student/stu01-scale.wav,data/private/score/scale.musicxml,,correct,yes,yes,local-only,0,45,clean phone recording
```

## Results File

Default path:

`data/experiments/western-strings-m2/real-student-recording-results.csv`

Required columns:

| column | meaning |
|---|---|
| `recordingId` | matches manifest |
| `autoPassCount` | number of notes released by the gate |
| `correctWithin300ms` | auto-pass notes that match the human/gold target within 300 ms |
| `unsafeTargetAutoPassCount` | known wrong/missing/shifted target notes incorrectly auto-passed |

The M2f gate passes only when:

- manifest is complete and meets minimum recording/student/scenario counts
- results exist for the recordings
- `correctWithin300ms / autoPassCount >= 0.90`
- `unsafeTargetAutoPassCount == 0`

## Command

Gate check with current local data:

```powershell
npm run western:m2f-gate
```

The command reports `studentGateReady=false` until real manifest and results
files exist and pass the gate. The CI/regression command
`npm run test:western-m2f-real-recordings` intentionally expects the current
no-real-data state to fail closed.

## Product Rule

Do not expose `/api/strings/analyze` or student-facing automatic feedback until
M2f passes. Until then, western strings remains teacher-only preview plus
offline evidence review.
