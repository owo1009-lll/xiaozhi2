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
- Historical `reviewRate` values that still appear in DTW quality reports are archived/stale trend data from older runs. They are not evidence of a regression in the current mainline.
- Latest real-corpus mainline sample: `8` whole-piece analyses, `latestMainlineReviewRate = 0`, `latestMainlineAccompanimentFailureRate = 0`.
- Actual real-corpus `--run` coverage now includes all 8 matched corpus pairs: `20190306桃花坞`, `第二二胡狂想曲`, `第四二胡狂想曲`, `浮生`, `古巷深处`, `维奥莱塔组曲07 - 二胡 中胡`, `雪山魂塑`, and `炫动`.
- The 8-song cached end-to-end pass completed with `0` P0 failures, all sections matched, and score issue review artifacts generated for each run batch.
- The all-in-one routine `npm run test:real-corpus:strict` has been verified across all 8 pairs: `8/8` completed, score issue review item count `8`, browser smoke `ok`.
- `npm run review:p0-score-issues -- --run-summary <run-summary.json>` remains the manual P0 review helper for the score-issue page. It clicks every issue in `炫动` and `古巷深处` and verifies that original-audio playback seeks to a nonzero timestamp instead of replaying from `0:00`.
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
- Re-ran the latest 8-card strict review batch with `npm run smoke:score-issues -- --all-cards`, saving screenshots under `data/real-tests/visual-review/2026-04-30T02-49-24-929Z`; every issue page opened, rendered its score, showed highlights, and linked the first problem item to original-audio playback.
- Added mobile viewport coverage to `npm run smoke:score-issues` with horizontal-overflow detection, and adjusted the mobile problem-score layout so the issue list scrolls inside its own block instead of clipping the whole sidebar.
- Added `npm run smoke:score-issues:mobile` as the fixed 390x844 mobile review-page smoke entry point for already-generated corpus runs.
- Strengthened score issue smoke checks so complex-score review pages must keep problem numbering, issue tone color classes, color legend, and erhu melody-line mode visible.
- Added a targeted P0 browser review helper, `npm run review:p0-score-issues`, for clicking every issue in `炫动` and `古巷深处`, capturing screenshots, checking highlight-number correspondence, and verifying original-audio seek times.
- Fixed imported whole-score measure highlights so reliable problem-measure items render exact measure boxes from erhu melody note coordinates, instead of only showing same-page note highlights.
- Improved OMR melody/accompaniment line splitting for repeated multi-staff systems: the importer now keeps the top staff in each system instead of relying only on whole-page line modulo, with a regression case in `test:score-markings`.
- Improved ambiguous OMR line splitting when a sparse pseudo-line appears above the real melody within the same system: dense monophonic lower melody lines can now be promoted while the one-note artifact is suppressed, with a regression case in `test:score-markings`.
- Improved whole-PDF MusicXML page localization: `<print new-page="yes">` now advances the score page and resets system numbering, so smaller whole-file OMR outputs do not project later-page issues onto page 1.
- Improved unknown-MusicXML measure parsing so non-numeric printed measure labels such as `1A`, `X2`, or coda labels no longer abort score import; numeric parts are preserved and fully non-numeric labels fall back to sequence order.
- Improved MusicXML multi-voice timing support: `<backup>` and `<forward>` now adjust the per-measure beat cursor, so OMR exports that encode overlapping voices do not push secondary or resumed melody notes onto the wrong beat.
- Improved MusicXML ornament handling so `<grace>` and `<cue>` notes are ignored as formal diagnosis/highlight notes while cue-note duration still preserves the following beat timeline.
- Tightened MusicXML part-candidate scoring for Chinese-named piano parts (`钢琴` / `鋼琴`), so a following generic `Voice` part is treated as accompaniment-split risk instead of being auto-trusted as erhu projection.
- Cleaned student-facing status wording so import states and whole-piece speed notes no longer expose raw internal status or cache wording.
- Cleaned remaining student whole-piece progress wording so long waits and repeated runs no longer mention model internals, backend services, or cache mechanics.
- Cleaned remaining queue/cache/write-style student status wording in the import and whole-piece progress panels, and added a copy guard so those phrases do not return.
- Cleaned student-facing failure banners so analyzer/job/API/path details are replaced with learner-readable retry guidance.
- Added `test:student-ui-copy` to the P0 routine so student-facing mojibake and raw backend error leaks are caught before release.
- Extended the student UI copy guard to the app shell title/description and PWA manifest so release packaging does not regress to research/prototype wording or mojibake.
- Added `test:separation-quality` to the P0 routine so erhu-focus separation confidence remains auditable through energy ratio and score-band pitch-hit diagnostics.
- Added `npm run audit:separation-quality` and `npm run audit:separation-quality:all` to rank real-corpus and cached separation confidence distributions. The latest real-corpus audit currently finds `16` separation records, `5` below `0.4`, median confidence `0.592`, and the lowest current cases are `第四二胡狂想曲`, `20190306桃花坞`, `雪山魂塑`, and `浮生`.
- Extended `test:dtw-quality` so review hotspots include reason breakdowns plus concrete page/measure/note samples. The latest mainline score/audio set still has `latestMainlineReviewRate = 0`; the remaining historical review load is dominated by `exact-note-on-accompaniment` and `accompaniment-only-section` in stale analyses.
- Extended the student UI copy guard to the problem-score page and to display source labels, preventing raw model/library/fallback labels from reappearing in learner-facing text.
- Updated the installable PWA manifest and browser title from research-prototype wording to the student-facing `二胡 AI 自主练习` product name.
- Added a Windows local shell-app installer script, `npm run install:windows`, that creates Start/Stop shortcuts targeting the production launcher without changing the diagnosis chain.
- Hardened the Windows shortcut installer so `-OutputDir` works with both relative and absolute paths, making local install smoke checks safer.
- Added `test:windows-installer` to create temporary Start/Stop shortcuts and verify their launcher targets before deleting the smoke directory.
- Added PNG maskable PWA icons and strengthened `test:pwa` so install compatibility is checked beyond SVG icon presence.
- Extended the MusicXML fallback test to cover compressed `.mxl` uploads, matching the student backup-score file picker.
- Re-verified the full real-corpus strict routine after the cleanup with run batch `2026-04-30T02-49-24-929Z`; `8/8` completed, score issue smoke checked `8` cards, latest DTW quality is `latestMainlineReviewRate = 0`, `latestMainlineAccompanimentFailureRate = 0`, and historical `reviewRate = 0.0669`.
- Re-ran the full real-corpus strict routine with run batch `2026-04-30T05-47-54-108Z`; `8/8` completed with `0` P0 failures, desktop smoke checked all `8` review cards, mobile smoke passed at `390x844`, and refreshed DTW quality is `latestMainlineReviewRate = 0`, `latestMainlineAccompanimentFailureRate = 0`, historical `reviewRate = 0.0616`.

## 2026-05-01 Scanned PDF And Corpus Checkpoint

Completed:

- Added `弦歌吟.pdf` as the first real scanned-PDF baseline sample. `npm run audit:unknown-pdf-omr -- --pdf "C:\Users\Administrator\Music\弦歌吟.pdf"` completed with `omrConfidence = 0.86`, `33` structured sections, and `501` notes.
- Fixed the unknown-PDF OMR baseline reporter so cached PDF-import jobs count structured sections from the persisted score store instead of reporting `0` sections when the import job omits `piecePack.sections`.
- Recorded the current scanned-score failure mode: `弦歌吟` imports successfully, but OMR voice splitting marks only `123/501` notes as erhu melody. The supplied recording also skips score measures `202-211`; current pagewise OMR uses local page/system measure numbers, so this is tracked as a known-gapped baseline rather than a clean no-gap regression test.
- Ran the `弦歌吟` end-to-end sample once: `12/12` sections matched, `0` failed sections, first cache-miss analysis took about `18.3s`, and score-issue smoke verified original-audio seek playback.
- Ran the next diverse 5-song real-corpus batch (`古巷深处`, `维奥莱塔组曲07 - 二胡 中胡`, `雪山魂塑`, `弦歌吟`, `炫动`) with `--run --smoke-review --strict`: `5/5` completed, `0` P0 failures, review-page smoke passed for all `5` cards.
- Refreshed the real-corpus trend report after the batch; latest trend summary has `completedPairCount = 71` and `p0FailureCount = 0`.
- Added a guarded erhu-range fallback for scanned/generic `Voice` imports: when the selected candidate is single-staff, non-piano, high `erhuRangeRatio`, and very low `chordRatio`, isolated in-range notes on low-confidence lines can be promoted to `erhu-range-fallback` instead of being dropped as accompaniment. `npm run test:score-markings` now covers a piano-plus-scanned-Voice fixture.
- Re-ran the Xian Ge Yin scanned-PDF baseline after the fallback: `completed`, `omrConfidence = 0.9`, `58` structured sections, `1034` notes, and `1032/1034` notes marked as erhu melody (`erhuRatio = 0.998`). This replaces the earlier `123/501` scanned voice-splitting failure as the current baseline for this sample.
- Ran the fourth-rhapsody 3-worker cache-miss performance experiment on port `8102` with a fresh `ERHU_CLIP_FEATURE_CACHE_VERSION`: `104/104` sections matched, `cacheHits = 0`, no failed sections, elapsed `108.23s`. This is slower than the current accepted baseline, so do not raise the production analyzer worker default to `3` yet.
- Refreshed the fourth-rhapsody separation hotspots reported by the all-cache audit (`page-09-s14`, `page-09-s16`, `page-10-s06`) with the current analyzer and `--refresh-cache`: `3/3` sections matched, `cacheHits = 0`, no failures, and the refreshed applied `separationScoreBandRatio` values were `0.864`, `1.0`, and `1.0`. The old low score-band records are stale cache artifacts, not current strategy failures.
- Fixed legacy pagewise imported-score reuse for older cached OMR records that predate `measureNumberSource = pagewise-count`. Normalization now infers global measure numbers from page-local measure order, keeps local page measure metadata, and lets real-corpus reruns reuse known-good pagewise scores instead of replacing them with a weaker fresh OMR import.
- Verified the fix on the Second Erhu Rhapsody pair: the strict single-pair run reused `score-moef6aiw-f1evny`, completed `19/19` structured sections, and the review smoke confirmed original-audio seek playback at a nonzero timestamp.
- Re-ran the first 3 real-corpus strict pairs after the legacy pagewise reuse fix: `3/3` completed, `0` P0 failures, review smoke passed for all cards, and original-audio seek playback was verified for Taohuawu, Second Erhu Rhapsody, and Fourth Erhu Rhapsody.
- Current DTW projection audits still report `latestMainlineAccompanimentFailureRate = 0`, so hidden-accompaniment points are not counted as successful visible highlights. The latest/current `reviewRate` warning is now a P1 OMR voice-line quality signal rather than a P0 projection failure; the active hotspots are Violeta Suite 07, Xuandong, Fusheng, Guxiang Shenchu, and Xueshan Hunsu.
- The latest 3-pair strict run also shows the remaining first-pass performance risk: Fourth Erhu Rhapsody took about `264.974s` with `106` cache misses in that batch, so long fragmented scores still need performance work even though the P0 flow completes.
- Added legacy pagewise issue-location compatibility in the DTW audit, P0 score-issue projection audit, and student score-issue page. Older analyses that still store page-local `measureIndex` / `noteId` now resolve through `sourcePageNumber + localMeasureIndex + localNoteId` against normalized global-measure scores instead of being treated as review-only.
- Re-ran `test:score-issues` and `test:dtw-quality` after that compatibility fix: latest/current mainline now reports `latestMainlineReviewRate = 0`, `currentMainlineReviewRate = 0`, and `latestMainlineAccompanimentFailureRate = 0`. The previous hotspots in Violeta Suite 07, Xuandong, Fusheng, Guxiang Shenchu, and Xueshan Hunsu are no longer active current-mainline review hotspots.
- Re-ran the next 5 real-corpus strict pairs after the pagewise compatibility fix (`Fusheng`, `Guxiang Shenchu`, `Violeta Suite 07`, `Xueshan Hunsu`, `Xian Ge Yin`): `5/5` completed, `0` P0 failures, review-page smoke passed on all `5` cards, and original-audio seek playback was verified on every card. The only new performance warning was Violeta Suite 07 first-pass cache-miss analysis: `78.547s` for `150` sections.
- Re-ran mobile review-page smoke for that 5-song batch at `390x844`: all `5` cards passed, no horizontal body overflow was detected, and original-audio seek playback still worked on every checked issue page. Screenshots were saved under `data/real-tests/browser-smoke/2026-05-01-next5-mobile-post-pagewise-compat`.
- Fixed the analyzer request schema so legacy `preprocessMode=off` is no longer overridden by the default `separationMode=auto`. This makes separation on/off experiments truthful for direct analyzer and script callers while explicit `separationMode` still takes precedence.
- Rechecked the current separation hotspot `Xueshan Hunsu page-06-s03`: current auto separation remains a real low-but-accepted case (`confidence = 0.421`, `energyRatio = 0.335`, `scoreBandRatio = 0.351`). After the schema fix, the `preprocessMode=off` control correctly reports `separationApplied = false`, confirming that future separation strategy experiments can compare auto vs raw audio reliably.
- Re-ran the full `npm run test:mainline-p0` after the schema fix: P0 still passes, including analyzer dependency checks, PWA, Windows shortcuts, frontend build, student copy guard, MusicXML, separation quality, score markings, score issue projection, DTW alignment quality, and real-corpus pairing audit.
- Tuned auto separation acceptance with a borderline guard: if separation confidence is below `0.43` and score-band match is below `0.40` with enough pitch evidence, auto now falls back to raw audio. Targeted checks show `Xueshan Hunsu page-06-s03` now falls back to `appliedPreprocessMode = off`, removing the extra low-confidence rhythm finding, while `Violeta Suite 07 page-04-s12` and `Xian Ge Yin page-08-s04` still keep erhu-focus separation.
- Re-ran `npm run test:mainline-p0` after the borderline separation guard: P0 still passes and DTW remains `latestMainlineReviewRate = 0`, `currentMainlineReviewRate = 0`, `latestMainlineAccompanimentFailureRate = 0`.

## Next In Order

1. Keep periodic real-corpus `--run` tests in the routine, using `npm run test:real-corpus:strict` for automated review-page smoke checks during each batch. `npm run smoke:score-issues -- --run-summary <run-summary.json>` remains available for already-generated runs.
2. Continue improving OMR section/voice quality so historical and unknown-PDF review items become reliable note or measure highlights.
3. Continue deeper human visual review on saved complex-score screenshots beyond smoke assertions, especially cross-checking desktop and mobile captures for `浮生`, `古巷深处`, `炫动`, `第四二胡狂想曲`, and `维奥莱塔组曲07 - 二胡 中胡`.
4. Continue student UI cleanup where technical labels remain visible outside the main upload/import path.
5. Keep manual `MusicXML` import as the fallback for PDFs whose Audiveris output is too noisy.
6. Treat deeper installer packaging beyond local Windows shortcuts as lower priority until the diagnosis chain is visually reliable.

## Current P1/P2 Focus

- Refresh at least one targeted real-corpus `--run` after separation metrics are present in the cache, then use `npm run audit:separation-quality` to inspect `separationEnergyRatio` and `separationScoreBandRatio`, not only legacy confidence.
- Continue OMR section/voice improvements with `test:dtw-quality` review samples as the selector for exact pages, measures, and note IDs.
- Add 2-3 unknown/scanned PDF benchmark samples before treating unknown-PDF robustness as done.

## Immediate Implication

When there is a tradeoff, prefer work that strengthens this path:

`PDF -> score representation -> audio -> DL pitch/rhythm -> localization -> feedback UI`

Do not let optional research-management features displace this mainline.
