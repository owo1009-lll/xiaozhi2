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
- The score is only a JPG/PNG image; the manifest validator rejects this as
  `scorePath-not-clean-score` because V2 needs note-level MusicXML/MIDI.
- The file path contains a real student name that should not be stored.
- Consent or license status is unclear.

Optional draft OMR:

- Audiveris can be used to create a MusicXML/MXL draft from JPG/PDF score images.
- Run `npm run western:m2f-audiveris-drafts` to generate draft `.mxl` files and
  `audiveris-draft-musicxml-summary.json`.
- `npm run western:m2f-score-review-pack` shows the original score image, target
  clean-score path, available Audiveris draft path, and draft measure/note counts
  in one local review page.
- Run `npm run western:m2f-stage-audiveris-drafts -- --apply` to copy parseable
  Audiveris drafts into the target clean-score paths as pending `.mxl` files.
  This does not approve them.
- Treat the output as a transcription draft only. It becomes a valid M2f clean
  score only after a human checks the notes, rhythm, key, time signature, rests,
  repeats, and measure count against the original image.
- Audio-derived MIDI (for example Basic Pitch output from the student recording)
  must not be used as the clean score, because it can encode the student's
  mistakes into the target.

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

Do not commit raw student recordings or private score files. The M2f gate
enforces this for `audioPath` and local-only `scorePath`: a repo-local private
path is valid only under `data/private/...`; a repo-local public/test path fails
with `audioPath-not-private` or `scorePath-not-private`. Paths must point to
files, not directories. Absolute paths outside the repo remain allowed for local
private storage.

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

Before generating the results skeleton, run the manifest-only readiness check:

```powershell
npm run western:m2f-manifest-status
```

If the manifest uses JPG/PNG/PDF score images, run the clean-score intake helper:

```powershell
npm run western:m2f-clean-score-intake
```

This writes `data/experiments/western-strings-m2/clean-score-intake.csv`, one row
per recording. Use it to replace each image score with a clean
MusicXML/MXL/MIDI file, or to fill an existing clean-score `scoreId`. If
Audiveris drafts exist, prefill the target `.mxl` files with:

```powershell
npm run western:m2f-stage-audiveris-drafts -- --apply
```

After a human has checked the score against the original image, set
`cleanScoreReviewStatus` to `approved`; then run:

```powershell
npm run western:m2f-clean-score-review-status
```

This reports how many clean scores are still pending review and lists the
blocking rows. When it reports ready, run:

```powershell
npm run western:m2f-apply-clean-scores -- --apply
```

The apply command writes the manifest only when every requested clean score
exists and every row is explicitly marked `approved`. If any clean score is
missing or not reviewed, it exits without changing the manifest.
After it succeeds, rerun `npm run western:m2f-manifest-status`.

Manifest status checks recording counts, student counts, scenario coverage,
consent/license fields, clean-score availability, path existence, and private
storage rules. It does not require `real-student-recording-results.csv`.

Required columns:

| column | Fill rule |
|---|---|
| `recordingId` | Stable unique id. |
| `studentId` | Anonymous id only. |
| `instrument` | `violin`. |
| `pieceId` | Stable piece id. |
| `audioPath` | Existing local file path to the audio; if it is repo-local it must be under `data/private/...`. |
| `scorePath` or `scoreId` | One must point to a clean MusicXML/MIDI score; local-only repo-local score files must be under `data/private/...`. |
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
The evaluator does not infer these counts automatically; they come from
teacher/gold review of the preview output.

Key result columns:

| column | Meaning |
|---|---|
| `autoPassCount` | Notes released by the gate. |
| `correctWithin300ms` | Auto-pass notes matching the human/gold target within 300 ms. |
| `unsafeTargetAutoPassCount` | Known wrong/missing/shifted target notes incorrectly auto-passed. |

Recommended counting flow:

1. Open the `studentSafe=1` preview for the recording.
2. Count all notes with `auto_pass` into `autoPassCount`.
3. Compare those notes with the human/gold target and count matches within
   300 ms into `correctWithin300ms`.
4. For wrong-pitch, missing-note, rhythm-shift, weak-onset, or noisy target
   cases, count any unsafe released target into `unsafeTargetAutoPassCount`.
5. Recheck any row that would make precision fall below 90% or make unsafe
   auto-pass nonzero before running the release gate.

## 7. Gate Check

Inspect current status without failing the shell:

```powershell
npm run western:m2f-status
```

Run the release gate:

```powershell
npm run western:m2f-gate
```

The student release gate can pass only when:

- minimum recording, student, and scenario counts are met
- all paths and consent/license fields are valid
- `correctWithin300ms / autoPassCount >= 0.90`
- `unsafeTargetAutoPassCount == 0`

If the command reports `studentGateReady=false`, the system stays in
teacher-only preview. `western:m2f-gate` exits non-zero in that state by design;
`western:m2f-status` is the non-failing inspection command.

Regression note: `npm run test:western-m2f-real-recordings` is the repository
fail-closed test for the current no-real-data state. Use `western:m2f-gate` for
real pilot data.

## 8. Release Rule

Do not expose student-facing `/api/strings/analyze` until M2f passes on real
recordings. A small but safe auto-pass subset is acceptable. Unsafe auto-pass is
not acceptable.

## 9. Current Pilot Result

As of 2026-07-08, the first real/near-real student pilot has passed the M2f
release gate:

- recordings: 12
- students: 3 anonymous students
- scenarios: correct / wrong_pitch / missing_note / rhythm_shift / weak_onset /
  noisy, two recordings each
- auto-pass notes: 431
- reviewed correct within 300 ms: 431
- unsafe target auto-pass: 0
- precision within 300 ms: 1.0000

Verified commands:

```powershell
npm run western:m2f-status
npm run western:m2f-gate
npm run test:western-m2f-templates
```

This result clears the M2f release gate only. Student-facing release still
requires the next M3 basic-diagnosis gate and API review.
