# Teacher Validation Protocol

## Goal

This document defines how dual-rater teacher validation should be conducted for the AI erhu intervention study.

## Assignment Rule

1. Each selected analysis record should be reviewed by two independent teachers.
2. Teachers should not see each other's labels before both reviews are submitted.
3. Both teachers must use the same rubric and the same three-path taxonomy:
   - `pitch-first`
   - `rhythm-first`
   - `review-first`
4. Every review must be stored with a unique `raterId`.

## Minimum Review Fields

- `overallAgreement` on a 1-5 scale
- `teacherPrimaryPath`
- teacher issue note ids
- teacher issue measure indexes
- free-text comments

## Adjudication Trigger

A dual-rated pair enters the adjudication queue when any of the following is true:

- practice-path mismatch
- overall agreement gap is `>= 2`
- note-overlap F1 is `< 0.67`
- measure-overlap F1 is `< 0.67`

## Adjudication Workflow

1. Export the adjudication queue from the research analysis outputs.
2. Assign a third teacher or the principal investigator to review flagged pairs.
3. Record the final decision in the adjudication form.
4. Keep both original ratings for reliability reporting.

## Recommended Reporting

- overall inter-rater `Cohen's kappa`
- overall `ICC` for teacher agreement
- breakdown by `groupId`
- breakdown by `sessionStage`
- breakdown by `pieceId/sectionId`
- adjudication count and adjudication rate

## Current Project Outputs

The project now generates:

- `table_inter_rater_pairs.csv`
- `table_inter_rater_summary.csv`
- `table_inter_rater_by_group.csv`
- `table_inter_rater_by_stage.csv`
- `table_inter_rater_by_piece.csv`
- `table_inter_rater_adjudication_queue.csv`
- `figure_inter_rater_metrics.png`

## Offline Corpus Pack Workflow

Use this workflow to turn radio-program PDF/audio runs into teacher-reviewed validation data without treating raw performances as ground truth.

1. Build a 30-50 item review pack from completed real-corpus runs:

   ```powershell
   npm run teacher:validation-pack -- --unit section --sources real-runs --min 30 --max 50
   ```

2. Send the generated `teacher-review-template.csv` or `teacher-review-template.json` plus `system-findings.csv` to the teacher.

3. The teacher marks each row as `reviewStatus=complete`, keeps `includeInBaseline=yes` only for suitable samples, and fills:
   - `overallAgreement`
   - `teacherPrimaryPath`
   - `teacherIssueNoteIds`
   - `teacherIssueMeasureIndexes`
   - `comments`

4. Dry-run the import:

   ```powershell
   npm run teacher:validation-import -- --pack-dir data\teacher-validation\packs\<pack> --reviews data\teacher-validation\packs\<pack>\teacher-review-filled.csv
   ```

5. Apply the import once the summary is correct:

   ```powershell
   npm run teacher:validation-import -- --pack-dir data\teacher-validation\packs\<pack> --reviews data\teacher-validation\packs\<pack>\teacher-review-filled.csv --apply
   ```

6. Rebuild and check the quality baseline:

   ```powershell
   npm run quality:baseline
   npm run test:quality-baseline
   ```

The pack can optionally cut audio snippets if `ffmpeg` is available:

```powershell
npm run teacher:validation-pack -- --unit section --sources real-runs --min 30 --max 50 --extract-audio
```

## Teacher Annotation Backend

Teachers should not edit the CSV/JSON files directly. After a pack is generated, open the local app and use:

```text
http://localhost:3000/?mode=teacher
```

The backend lists available packs, opens the source audio/PDF through server routes, saves each row back into `teacher-review-template.json`, and can import completed rows into `data/erhu-study-records.json`.

Rows are imported only when:

- `reviewStatus=complete`
- `includeInBaseline=yes`

After importing completed teacher rows, refresh the quality baseline:

```powershell
npm run quality:baseline
npm run test:quality-baseline
```
