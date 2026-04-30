# Mainline App Priority

This file records the highest-priority product line for this project.

## Mainline Task

Build a `Web / PWA / shell-app` style erhu practice system with this core flow:

1. learner imports a `PDF` score
2. learner uploads or records performance audio
3. the system analyzes pitch and rhythm
4. the system localizes problems at note and measure level
5. the system gives original-audio playback, score highlighting, and structured feedback to the learner

Everything else is secondary to this chain.

## Priority Order

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

## Deep-Learning Requirement

This project treats both of the following as required:

- pitch diagnosis must use a deep-learning model
- rhythm diagnosis must move toward a deep-learning model

Current status:

- pitch: on a deep-learning path through `torchcrepe`
- rhythm: mainline uses `madmom RNN onset/beat + score-aware DTW`, with the older onset/rule stack kept as fallback

The current rhythm stack is acceptable for the prototype mainline when `madmom` is available. Fallback results must remain lower confidence.

## Current Mainline Status, 2026-04-30

Latest validated state:

- `npm run test:mainline-p0` passes.
- Analyzer runtime reports CUDA PyTorch on `NVIDIA GeForce RTX 5060`.
- Latest real-corpus mainline sample: `8` whole-piece analyses, `latestMainlineReviewRate = 0`, `latestMainlineAccompanimentFailureRate = 0`.
- Actual real-corpus `--run` coverage now includes all 8 matched corpus pairs: `20190306桃花坞`, `第二二胡狂想曲`, `第四二胡狂想曲`, `浮生`, `古巷深处`, `维奥莱塔组曲07 - 二胡 中胡`, `雪山魂塑`, and `炫动`.
- The 8-song cached end-to-end pass completed with `0` P0 failures, all sections matched, and score issue review artifacts generated for each run batch.
- The all-in-one routine `npm run test:real-corpus:strict` has been verified across all 8 pairs: `8/8` completed, score issue review item count `8`, browser smoke `ok`.
- Browser smoke checks for generated review artifacts are now reusable both as `npm run smoke:score-issues` and as the real-corpus `--smoke-review` option; strict corpus runs now check every generated review card, write only one issue session at a time to avoid browser storage quota collisions, and verify that each issue score page loads with original-audio panel, issue list, rendered score, melody-line view, and problem-item audio seek feedback.
- Historical review hotspots remain in older cached runs, mainly old `20190306桃花坞`, `炫动`, and `雪山魂塑` analyses. They are tracked as review-risk trend, not as current P0 failures.
- Current DTW mainline does not count hidden accompaniment notes as successful visible highlights; uncertain projection is kept as `需复核`.

Recently completed:

- Original-audio snippet playback from problem notes/measures in the score issue page.
- Real-corpus score issue review artifacts: `score-issue-review.html`, manifest JSON, and session JSON.
- Review artifact risk labels for OMR confidence, many pages, dense issues, many sections, first-run analysis, location review, and accompaniment-projection suspicion.
- Shared score issue projection audit rules between the P0 test and review artifact generator.
- DTW quality report now includes latest-mainline per-piece rows and historical review hotspots.
- Student-facing copy has been cleaned for the main upload/import flow: technical cache and fallback wording is less exposed.

## 2026-04-28 P0 Implementation Checkpoint

Completed:

- Added a formal `MusicXML` fallback import path so new pieces are not blocked entirely when Audiveris OMR fails.
- Exposed the fallback through `POST /api/erhu/scores/import-musicxml` and `/score/import-musicxml`.
- Added a student-side backup score-file import button while keeping `PDF` as the default main route.
- Updated `start-prod` so if an old Python analyzer is still occupying port `8000`, the app can automatically start the current analyzer on `8100` and point Node to it.
- Verified one real-corpus end-to-end run for `20190306桃花坞`: `22/22` attempted sections matched, with no score-issue projection failure.
- Fixed imported-score whole-piece filtering so sections with explicit `erhu` line evidence are no longer discarded just because the global part candidate is low confidence.
- Verified `第二二胡狂想曲`: `19/19` attempted sections matched after the filter fix.
- Reduced imported-score whole-piece wait time by enabling bounded scan/analysis concurrency and lowering duplicate retries; the cached verification pass completed in about `3.2s`.

## 2026-04-29 Continuation Checkpoint

Completed:

- Enabled the production launcher to prefer the global CUDA PyTorch runtime while still loading the project virtualenv packages, so `torchcrepe` can use the local GPU when available.
- Verified analyzer runtime reports `torch 2.11.0+cu128`, `cuda`, and `NVIDIA GeForce RTX 5060`.
- Ran non-Taohuawu real-corpus end-to-end tests for `第四二胡狂想曲`, `浮生`, and `古巷深处`.
- Added stricter issue-score projection guards: when a score contains accompaniment, stale cached `scoreLineRole=erhu` is no longer trusted by itself; unreliable markers become `需复核`.
- Added a DTW alignment quality report with mode-level breakdown, separating new whole-piece results from old historical external/fallback analyses.

Latest validation from that checkpoint:

- `第四二胡狂想曲`: PDF import cache hit, `104/104` sections matched, whole-piece analysis completed, but runtime was still long at about `659s`.
- `浮生`: PDF import cache hit, `11/11` sections matched, whole-piece analysis completed in about `3.1s`.
- `古巷深处`: PDF import cache hit, `17/17` sections matched, whole-piece analysis completed in about `154s`.
- `test:score-issues`: no accompaniment projection failures.
- `test:dtw-quality`: no accompaniment projection failures.

## 2026-04-29 Speed Checkpoint

Completed:

- Whole-piece section analysis now sends the original audio path plus `windowStartSeconds/windowEndSeconds` to the analyzer instead of cutting every section into a base64 WAV payload.
- Highly fragmented OMR scores now get a bounded per-section fast-window cap in production whole-piece jobs, preventing long tail windows from dominating the pass.
- Verified cached repeat analysis for `第四二胡狂想曲`: `104/104` sections matched, `2002/2002` notes covered, `cacheHits=104`, and wall time dropped from about `659s` to about `3.2s`.
- Re-ran projection checks after the speed change: no accompaniment projection failures.

Current caveat:

- This checkpoint proves repeated/manual retests are now fast. A completely first-time long score with no section cache will still take longer because the first deep pitch/rhythm pass must create the cache.

## 2026-04-30 Review And UI Checkpoint

Completed:

- Fixed research `summary.json` serialization so `NaN` / `Infinity` become `null`, and JSON writing uses `allow_nan=false` equivalent behavior where applicable.
- Score issue page can play the corresponding original-audio segment for a clicked problem note or measure.
- Real-corpus end-to-end runs automatically emit score issue review artifacts for browser visual inspection.
- Review artifacts now expose visible pages, review pages, issue pages, section pages, risk chips, weak-evidence counts, and location-review counts.
- `test:score-issues` and `review:score-issues` now use the same projection audit module.
- `test:dtw-quality` now prints compact review hotspots and writes the same information into `latest-dtw-alignment-quality.md`.
- Added `npm run smoke:score-issues` for reusable headless browser smoke checks against a generated score issue review artifact.
- Verified all 8 real-corpus `--run` pairs across separate run batches, with `npm run smoke:score-issues` passing for each generated artifact batch.
- Added `--smoke-review` to the real-corpus runner so end-to-end corpus batches can fail strict mode when the generated score issue review page does not open correctly.
- Strengthened score issue review smoke coverage so `--smoke-review` checks every review card in the generated batch, and the generated review HTML clears older issue-session cache entries before opening a new large score.
- Added original-audio snippet linkage to the score issue smoke check: each checked issue page clicks a problem item and verifies the playback hint plus active issue state.
- Ran screenshot-based visual review on the complex-score issue pages for `浮生`, `古巷深处`, `炫动`, `第四二胡狂想曲`, and `维奥莱塔组曲07 - 二胡 中胡`; first issue pages showed readable controls, rendered score images, and visible highlights.
- Improved OMR melody/accompaniment line splitting for repeated multi-staff systems: the importer now keeps the top staff in each system instead of relying only on whole-page line modulo, with a regression case in `test:score-markings`.
- Improved ambiguous OMR line splitting when a sparse pseudo-line appears above the real melody within the same system: dense monophonic lower melody lines can now be promoted while the one-note artifact is suppressed, with a regression case in `test:score-markings`.
- Cleaned student-facing status wording so import states and whole-piece speed notes no longer expose raw internal status or cache wording.
- Cleaned remaining student whole-piece progress wording so long waits and repeated runs no longer mention model internals, backend services, or cache mechanics.
- Cleaned student-facing failure banners so analyzer/job/API/path details are replaced with learner-readable retry guidance.
- Added `test:student-ui-copy` to the P0 routine so student-facing mojibake and raw backend error leaks are caught before release.
- Re-verified the full real-corpus strict routine after the cleanup with run batch `2026-04-30T02-49-24-929Z`; `8/8` completed, score issue smoke checked `8` cards, latest DTW quality is `latestMainlineReviewRate = 0`, `latestMainlineAccompanimentFailureRate = 0`, and historical `reviewRate = 0.0669`.

## Next In Order

1. Keep periodic real-corpus `--run` tests in the routine, using `npm run test:real-corpus:strict` for automated review-page smoke checks during each batch. `npm run smoke:score-issues -- --run-summary <run-summary.json>` remains available for already-generated runs.
2. Continue improving OMR section/voice quality so historical and unknown-PDF review items become reliable note or measure highlights.
3. Do deeper human visual review on complex scores beyond smoke checks: `浮生`, `古巷深处`, `炫动`, `第四二胡狂想曲`, and `维奥莱塔组曲07 - 二胡 中胡`.
4. Continue student UI cleanup where technical labels remain visible outside the main upload/import path.
5. Keep manual `MusicXML` import as the fallback for PDFs whose Audiveris output is too noisy.
6. Treat installable shell-app packaging as lower priority until the diagnosis chain is visually reliable.

## Immediate Implication

When there is a tradeoff, prefer work that strengthens this path:

`PDF -> score representation -> audio -> DL pitch/rhythm -> localization -> feedback UI`

Do not let optional research-management features displace this mainline.
