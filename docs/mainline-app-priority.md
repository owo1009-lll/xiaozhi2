# Mainline App Priority

This file records the highest-priority product line for this project.

## Mainline task

Build a `Web / PWA / shell-app` style erhu practice system with the following core flow:

1. learner imports a `PDF` score
2. learner uploads or records performance audio
3. the system analyzes pitch and rhythm
4. the system localizes problems at note and measure level
5. the system gives demo playback and structured feedback to the learner

Everything else is secondary to this chain.

## Priority order

Highest priority:

- PDF score intake
- student-facing recording/upload flow
- deep-learning pitch diagnosis
- deep-learning rhythm diagnosis
- note/measure localization
- feedback presentation for students
- app delivery quality

Lower priority:

- teacher-side validation
- adjudication workflow
- heavy research admin features
- optional external evaluation layers

## Deep-learning requirement

This project should now treat both of the following as required:

- pitch diagnosis must use a deep-learning model
- rhythm diagnosis must also move toward a deep-learning model

Current status:

- pitch: already on a deep-learning path through `torchcrepe`
- rhythm: still mainly uses `onset + DTW + rule typing`

So the current rhythm stack is only an interim implementation, not the final mainline target.

## Immediate implication

When there is a tradeoff, prefer work that strengthens this path:

`PDF -> score representation -> audio -> DL pitch/rhythm -> localization -> feedback UI`

Do not let optional research-management features displace this mainline.
