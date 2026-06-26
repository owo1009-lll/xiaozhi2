# Western Strings M2f Recording Checklist

> Purpose: collect real or near-real student violin recordings for the M2f
> release gate. These recordings decide whether western strings automatic
> feedback can leave teacher-only preview. Templates and synthetic tests do not
> count as release evidence.

## 1. What To Record

Minimum set before the gate can pass:

- At least 6 recordings.
- At least 3 anonymized students or performers.
- Violin only for the first pass.
- Clean MusicXML or MIDI score for every recording.
- Each required scenario appears at least once:
  - `correct`
  - `wrong_pitch`
  - `missing_note`
  - `rhythm_shift`
  - `weak_onset`
  - `noisy`

Recommended pilot set:

- 3-5 students or performers.
- 2 short pieces per person.
- 30-90 seconds per recording.
- Keep pieces simple enough that the score and audio range match clearly.

## 2. Recording Rules

Good samples:

- Solo violin, no piano accompaniment or ensemble.
- The played passage matches the provided MusicXML/MIDI range.
- Audio starts near the score passage being tested.
- The performer intentionally plays the target scenario.
- The score is a clean MusicXML/MIDI file, not an OMR-generated PDF import.
- The file is stored locally/private and has consent.

Reject or redo:

- The recording contains a different passage than the score.
- The audio includes another instrument that masks the violin.
- The piece has heavy rubato or free timing throughout.
- The score is only a PDF with no clean MusicXML/MIDI.
- The file path contains a real student name that should not be stored.
- Consent or license status is unclear.

## 3. Scenario Guide

| scenario | What the performer should do | Notes |
|---|---|---|
| `correct` | Play the passage as accurately as possible. | This is the clean reference case. |
| `wrong_pitch` | Intentionally play one or more wrong notes. | Keep timing mostly normal. |
| `missing_note` | Skip one or more written notes. | Do not add an extra pause unless that is intended. |
| `rhythm_shift` | Play some notes early or late. | Keep pitch mostly correct. |
| `weak_onset` | Play soft or connected attacks that are hard to detect. | Useful for legato/soft-entry safety. |
| `noisy` | Record with phone noise or room noise. | Still keep the violin and score passage recognizable. |

Optional extra scenario:

- `extra_note`: add one or more notes that are not in the score.

## 4. Privacy And Storage

Use anonymized ids:

- `studentId`: `stu01`, `stu02`, `pilot-a`, etc.
- `recordingId`: stable id such as `stu01-scale-correct`.
- Avoid names, phone numbers, school names, or personal details in filenames.

Allowed storage:

- `data/private/...`
- another local private path outside the repo

Do not commit raw student recordings or private score files.

Required metadata:

- `consent=yes`
- `licenseStatus=local-only` or `licenseStatus=cleared`
- `humanChecked=yes`

## 5. Manifest Workflow

Generate templates:

```powershell
npm run western:m2f-templates
```

Copy or rename:

- from `real-student-recordings-manifest.template.csv`
- to `real-student-recordings-manifest.csv`

Default manifest path:

```text
data/experiments/western-strings-m2/real-student-recordings-manifest.csv
```

Required columns:

| column | Fill rule |
|---|---|
| `recordingId` | Stable unique id. |
| `studentId` | Anonymous id only. |
| `instrument` | `violin`. |
| `pieceId` | Stable piece id. |
| `audioPath` | Existing local path to the audio. |
| `scorePath` or `scoreId` | One must point to a clean MusicXML/MIDI score. |
| `scenario` | One of the required scenarios. |
| `humanChecked` | `yes`. |
| `consent` | `yes`. |
| `licenseStatus` | `local-only` or `cleared`. |
| `startSeconds` / `endSeconds` | Optional, but if one is filled both must be valid. |
| `notes` | Short context for the reviewer. |

Example:

```csv
recordingId,studentId,instrument,pieceId,audioPath,scorePath,scoreId,scenario,humanChecked,consent,licenseStatus,startSeconds,endSeconds,notes
stu01-scale-correct,stu01,violin,scale-g-major,data/private/student/stu01-scale.wav,data/private/score/scale.musicxml,,correct,yes,yes,local-only,0,45,clean phone recording
```

## 6. Results Workflow

After the filled manifest exists, generate a matching results skeleton:

```powershell
npm run western:m2f-results-skeleton
```

Default results path:

```text
data/experiments/western-strings-m2/real-student-recording-results.csv
```

Fill the results only after running the `studentSafe=1` gate on each recording.

Key result columns:

| column | Meaning |
|---|---|
| `autoPassCount` | Notes released by the gate. |
| `correctWithin300ms` | Auto-pass notes matching the human/gold target within 300 ms. |
| `unsafeTargetAutoPassCount` | Known wrong/missing/shifted target notes incorrectly auto-passed. |

## 7. Gate Check

Run:

```powershell
npm run western:m2f-gate
```

The student release gate can pass only when:

- minimum recording, student, and scenario counts are met
- all paths and consent/license fields are valid
- `correctWithin300ms / autoPassCount >= 0.90`
- `unsafeTargetAutoPassCount == 0`

If the command reports `studentGateReady=false`, the system stays in
teacher-only preview.

Regression note: `npm run test:western-m2f-real-recordings` is the repository
fail-closed test for the current no-real-data state. Use `western:m2f-gate` for
real pilot data.

## 8. Release Rule

Do not expose student-facing `/api/strings/analyze` until M2f passes on real
recordings. A small but safe auto-pass subset is acceptable. Unsafe auto-pass is
not acceptable.
