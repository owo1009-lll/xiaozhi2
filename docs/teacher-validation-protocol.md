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
