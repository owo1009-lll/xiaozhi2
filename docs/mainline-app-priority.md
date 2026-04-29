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
- rhythm: mainline uses `madmom RNN onset/beat + score-aware DTW`, with the older onset/rule stack kept as fallback

So the current rhythm stack is acceptable for the prototype mainline only when `madmom` is available; fallback results must be labeled as lower confidence.

## 2026-04-28 P0 implementation checkpoint

Completed:

- Added a formal `MusicXML` fallback import path so new pieces are not blocked entirely when Audiveris OMR fails.
- Exposed the fallback through `POST /api/erhu/scores/import-musicxml` and `/score/import-musicxml`.
- Added a student-side `MusicXML` backup import button, while keeping `PDF` as the default main route.
- Updated `start-prod` so if an old Python analyzer is still occupying port `8000`, the app can automatically start the current analyzer on `8100` and point Node to it.
- Verified one real-corpus end-to-end run after the change: `20190306桃花坞`, `22/22` attempted sections matched, no score-issue projection failure.
- Fixed imported-score whole-piece filtering so sections with explicit `erhu` line evidence are no longer discarded just because the global part candidate is low confidence.
- Verified `第二二胡狂想曲`: `19/19` attempted sections matched after the filter fix.
- Reduced imported-score whole-piece wait time by enabling bounded scan/analysis concurrency and lowering duplicate retries; the cached verification pass completed in about `3.2s`.

Next in order:

1. Run more real-corpus end-to-end tests against non-Taohuawu pieces, and inspect the score-issue page visually during the same pass.
2. Inspect low-confidence OMR cases and improve part selection / section building.
3. Continue visual validation of the score issue page, especially cross-page note positioning, as part of each corpus run rather than as a delayed separate task.
4. Polish the student result/history UI only after the diagnosis chain is stable.

## 2026-04-29 continuation checkpoint

Completed:

- Enabled the production launcher to prefer the global CUDA PyTorch runtime while still loading the project virtualenv packages, so `torchcrepe` can use the local GPU when available.
- Verified analyzer runtime reports `torch 2.11.0+cu128`, `cuda`, and `NVIDIA GeForce RTX 5060`.
- Ran non-Taohuawu real-corpus end-to-end tests for `第四二胡狂想曲`, `浮生`, and `古巷深处`.
- Added stricter issue-score projection guards: when a score contains accompaniment, stale cached `scoreLineRole=erhu` is no longer trusted by itself; a marker must also satisfy the expected melody-line geometry, otherwise it becomes `需复核`.
- Added a DTW alignment quality report with mode-level breakdown, separating new whole-piece results from old historical external/fallback analyses.

Latest validation:

- `第四二胡狂想曲`: PDF import cache hit, `104/104` sections matched, whole-piece analysis completed, but runtime was still long at about `659s`.
- `浮生`: PDF import cache hit, `11/11` sections matched, whole-piece analysis completed in about `3.1s`.
- `古巷深处`: PDF import cache hit, `17/17` sections matched, whole-piece analysis completed in about `154s`.
- `test:score-issues`: no accompaniment projection failures.
- `test:dtw-quality`: no accompaniment projection failures; new `whole-piece` analyses have `100%` exact note/measure localization, while old historical external/fallback records remain mostly `需复核`.

Still P0:

1. Reduce worst-case whole-piece analysis time, especially large OMR packs such as `第四二胡狂想曲`.
2. Continue improving OMR section quality so more sections are safe for exact note highlighting instead of `需复核`.
3. Keep manual MusicXML import as the fallback for PDFs whose Audiveris output is too noisy.

## 2026-04-29 speed checkpoint

Completed:

- Whole-piece section analysis now sends the original audio path plus `windowStartSeconds/windowEndSeconds` to the analyzer instead of cutting every section into a base64 WAV payload.
- Highly fragmented OMR scores now get a bounded per-section fast-window cap in production whole-piece jobs, preventing long tail windows from dominating the pass.
- Verified cached repeat analysis for `第四二胡狂想曲`: `104/104` sections matched, `2002/2002` notes covered, `cacheHits=104`, and wall time dropped from about `659s` to about `3.2s`.
- Re-ran projection checks after the speed change: no accompaniment projection failures.

Current caveat:

- This checkpoint proves repeated/manual retests are now fast. A completely first-time long score with no section cache will still take longer because the first deep pitch/rhythm pass must create the cache.

## Immediate implication

When there is a tradeoff, prefer work that strengthens this path:

`PDF -> score representation -> audio -> DL pitch/rhythm -> localization -> feedback UI`

Do not let optional research-management features displace this mainline.

## 2026-04-29 review refinement

- `test:dtw-quality` now treats accompaniment projection failures as P0 failures, while `mainline` whole-piece `reviewRate` is tracked as a non-blocking warning trend.
- Real-corpus end-to-end runs should include score-issue page visual inspection in the same pass, especially for cross-page positioning and melody-line-only highlighting.
- Whole-piece jobs already expose section-level progress detail (`completedSections / totalSections / cacheHits`) and the student page displays it; UI polish should keep this granular state visible for long first-time analyses.
