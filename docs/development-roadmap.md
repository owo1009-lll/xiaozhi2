# AI 二胡项目开发执行路线图

这份文档不是论文写作提纲，而是项目开发路线图。目标是让你随时知道当前做到哪一步、下一步做什么、用了哪些方法，以及每一步最终会在系统里呈现什么效果。

## 总目标

做出一个面向二胡教学研究的 AI 原型系统，满足以下闭环：

1. 学生选择曲目与段落
2. 学生录音或上传录音
3. 系统分析音准与节奏
4. 系统定位到小节与音符级别的问题
5. 系统给出示范回放与结构化反馈
6. 研究者收集实验数据、问卷、教师评分与访谈
7. 系统自动导出统计结果与论文素材

## 当前已完成

### 阶段 1：研究原型框架

- 做了什么：
  - React + Vite 前端
  - Express 网关
  - FastAPI Python 分析服务
  - 研究数据录入、导出、问卷、教师评分、访谈、任务计划
- 用到的方法：
  - Web 前后端分离
  - 结构化 JSON 接口
- 当前呈现效果：
  - 已可录音上传、查看分析结果、登记受试者、导出研究数据

### 阶段 2：深度学习音高分析

- 做了什么：
  - 接入 `torchcrepe`
  - 接入 `librosa.pyin` 作为音高回退
  - 接入 `librosa` onset 检测
- 用到的方法：
  - 深度学习音高估计：`torchcrepe`
  - 传统音频分析：`librosa`
- 当前呈现效果：
  - 系统已能从录音中提取音高轨迹和起音候选

### 阶段 3：符号乐谱 + DTW 对齐

- 做了什么：
  - 分析器支持 `piecePack.notes`
  - 支持内联 `MusicXML`
  - 支持内联 `MIDI`（安装 `pretty_midi` 后）
  - 用 `DTW` 取代原来的启发式逐音匹配
- 用到的方法：
  - 符号乐谱解析
  - 动态时间规整 `DTW`
  - 基于序列的音高/时序匹配
- 当前呈现效果：
  - 对齐逻辑更接近真实“乐谱-演奏匹配”，不再只是按时间窗口硬对位

## 接下来要做什么

### 阶段 4：二胡特征适配

- 目标：
  - 减少滑音、揉弦、长音进入阶段带来的误判
- 要做的事：
  - 引入“稳定段”音高评分，而不是整音平均
  - 对疑似滑音段设置容忍区
  - 对低置信度音高帧标记为弱证据
- 用到的方法：
  - 规则诊断
  - 稳定段筛选
  - 置信度加权
- 最终效果：
  - 反馈更像教师判断，不会把大量表现性处理都误判成错音

当前进度：

- 已完成稳定段音高提取
- 已完成滑音样 / 揉弦样音符识别
- 已完成自适应音准容忍阈值
- 已完成低置信度音高的降权与“需复核”标记

### 阶段 5：问题解释层

- 目标：
  - 把底层误差转换成学生能看懂的反馈
- 要做的事：
  - 统一问题类型：音高偏低、音高偏高、节奏偏早、节奏偏晚、节奏不稳
  - 生成“第几小节 / 第几个音”的提示
  - 绑定示范音频与问题小节
- 用到的方法：
  - 规则映射
  - 结构化反馈模板
- 最终效果：
  - 学生打开结果页后能直接看到错在哪里，而不只是一个总分

当前进度：

- 已完成整体判断 `summaryText`
- 已完成老师式点评 `teacherComment`
- 已完成优先练习顺序 `practiceTargets`
- 已完成问题音 / 问题小节的原因说明和练习建议

### 阶段 6：真实实验执行层

- 目标：
  - 支撑正式教育实验
- 要做的事：
  - 批量导入受试者
  - 分组管理
  - 周任务追踪
  - 缺测提醒
  - 教师评分与访谈抽样
- 用到的方法：
  - 研究流程管理
  - 数据质量控制
- 最终效果：
  - 系统不仅能分析演奏，还能真正支持实验全过程

### 阶段 7：统计与论文素材自动化

- 目标：
  - 把研究数据自动转成论文图表与文本素材
- 要做的事：
  - 导出 CSV
  - 自动生成 t 检验、ANCOVA、相关分析结果
  - 自动生成中文结果段落和 Word 草稿
- 用到的方法：
  - `pandas`
  - `scipy`
  - `statsmodels`
  - `python-docx`
- 最终效果：
  - 研究者不用手工整理每一张表和每一段结果描述

## 深度学习在这个项目中的位置

当前真正属于深度学习的核心模块是：

- `torchcrepe`：逐帧音高估计

当前不需要强行用深度学习的模块是：

- 符号乐谱解析
- `DTW` 对齐
- 规则反馈生成
- 研究流程管理
- 统计分析与论文导出

原因很直接：这些部分的核心问题是工程稳定性和教育可解释性，不是模型复杂度。

## 是否要加入注意力机制

当前阶段不建议加入。

### 原因

- 现在的主要瓶颈是：
  - 对齐是否稳定
  - 二胡滑音/揉弦如何减少误判
  - 反馈是否足够清晰
- 这些问题不能靠“先加注意力机制”解决
- 目前你已经有深度学习成分，不需要为了“看起来更 AI”而加入注意力机制

### 什么时候再考虑注意力机制

只有在你进入下面这个阶段时，注意力机制才值得加入：

- 你已经积累了真实标注数据
- 你想训练自己的错误诊断模型
- 你不再满足于 `torchcrepe + DTW + 规则反馈`
- 你要让模型直接学习“音高曲线 + 节奏 + 乐谱上下文 -> 错误类型”

### 那时可考虑的结构

- `BiLSTM + Attention`
- `Transformer Encoder`
- `Score-Audio Cross Attention`

### 注意力机制未来的合理位置

- 用在“错误诊断分类器”
- 用在“乐谱上下文建模”
- 用在“音频片段与符号乐谱的跨模态匹配”

不是现在这个阶段的主线。

## 你接下来最该看的顺序

如果你想知道项目现在应该先做什么，按这个顺序看：

1. 先把 `DTW` 对齐跑稳
2. 再做二胡滑音/揉弦容忍
3. 再做问题解释层优化
4. 再做真实教师标注验证
5. 最后才考虑是否训练带注意力机制的新模型
## Current Checkpoint

- Completed: `teacher validation workflow`
  Backend now stores teacher validation reviews and computes note-level F1, measure-level F1, and practice-path agreement.
- Completed: `practice path refinement`
  The analyzer and UI now distinguish `pitch-first`, `rhythm-first`, and `review-first`.
- Completed: `research analysis integration`
  `research-analysis/analyze_exports.py` now accepts `validation-reviews.csv` and generates validation tables, path-confusion tables, and validation figures.
- Completed: `dual-rater reliability support`
  The backend now stores multiple validation reviews per `analysisId` keyed by `raterId`, the app can switch between teacher reviews, and the analysis script now generates `table_inter_rater_pairs.csv`, `table_inter_rater_summary.csv`, and `figure_inter_rater_metrics.png`.
- Completed: `validation protocol and stratified reliability outputs`
  The project now includes a clean protocol reference in `docs/teacher-validation-protocol.md`, template exports for teacher validation and adjudication, and stratified inter-rater tables by group, stage, and piece plus an adjudication queue.
- Completed: `adjudication closure in app + exports`
  The app now stores final adjudication records, exposes adjudication APIs and exports, and writes adjudication summaries into the research analysis pipeline.
- Completed: `automatic rhythm error typing`
  The analyzer, Node fallback, and UI now distinguish `rhythm-rush`, `rhythm-drag`, `rhythm-duration-short`, `rhythm-duration-long`, `rhythm-missing`, and measure-level rhythm trends, with duration drift shown in the findings UI.
- Completed: `mixture-audio preprocessing`
  The analyzer and UI now support optional `melody-focus` preprocessing for accompaniment suppression / melody enhancement before pitch and rhythm analysis.
- Completed: `PDF manual score helper`
  The app now includes a client-side PDF preview and manual note-entry helper that can generate a temporary `piecePackOverride` and send it through the same Node + Python analysis flow for score-aware testing.
- Completed: `Taohuawu built-in fragment + slice harness`
  The project now ships a reusable built-in `taohuawu-test-fragment / entry-phrase` score pack and a repeatable multi-slice test script for running the same phrase against mixed-audio windows without writing results into the study store.
- Completed: `Taohuawu major-section pack + score export`
  The built-in `taohuawu-test-fragment` pack now carries seven ordered major sections, exports aggregate `notes.json`, `MusicXML`, `MIDI`, and `structure.json`, and can be reused as a whole-piece test scaffold rather than a single temporary fragment.
- Completed: `automatic section detection + long-audio scan`
  The backend now exposes `/api/erhu/auto-detect-section` for clip-level section ranking, and the optimized `scan-piece-segments.py` harness can scan a long mixed recording against all structured sections with bounded candidate windows.
- Completed: `PDF page rendering pipeline`
  The project now includes `scripts/render-pdf-pages.mjs`, so additional score pages can be rendered locally from the PDF and used to continue manual transcription beyond the first previewed page.
- Completed: `Taohuawu extended major-section coverage`
  The built-in `taohuawu-test-fragment` pack now covers nineteen ordered sections, extending from the opening material into later modulation / con-brio passages and re-exporting as aggregate `notes`, `MusicXML`, `MIDI`, and `structure` outputs.
- Completed: `time-prior and sequence-aware section scoring`
  Automatic section detection now supports optional `windowStartSeconds` and `expectedSequenceIndex` priors, and the long-audio scan harness now emits a sequence-aware path instead of only flat per-section rankings.
- Completed: `Taohuawu 25-section structured scaffold`
  The built-in `taohuawu-test-fragment` pack now carries twenty-five ordered sections, extending the structured score scaffold deeper into the later PDF pages and raising the aggregate exported scaffold to 180 notes.
- Completed: `whole-piece pass orchestration`
  The project now includes `scripts/run-piece-pass.py`, which first runs a sequence-aware scan and then re-analyzes the chosen windows section by section to produce whole-piece JSON, CSV, and Markdown summaries.
- Completed: `Windows-safe section filter forwarding`
  `scan-piece-segments.py` now accepts `--section-ids a,b,c`, which avoids repeated-flag forwarding issues on Windows shells and keeps targeted scans reproducible from npm scripts.
- Completed: `Taohuawu 33-section scaffold`
  The built-in `taohuawu-test-fragment` pack now carries thirty-three ordered sections, extending structured coverage into the later Allegro Vivace material and raising the aggregate exported scaffold to 257 notes.
- Completed: `late-section validation scan`
  The new post-250s sections were validated against the mixed recording with targeted `--section-ids` scans, confirming stable candidate windows across the new late-piece segment cluster.
- Completed: `whole-piece pass v2`
  A refreshed full-song pass now runs across all thirty-three sections and writes updated whole-piece JSON, CSV, and Markdown outputs under `data/piece-pass/taohuawu-whole-v2`.
- Current next step:
  continue manual transcription through the remaining PDF pages until the structured pack becomes a true whole-score representation of `桃花坞`, then validate a full-song pass before moving into the real-sample pilot and formal adjudication stage.

## 2026-04-21 Update

- Completed: `Taohuawu 41-section late-page scaffold`
  The built-in `taohuawu-test-fragment` pack now extends through the remaining late-page main material, carrying forty-one ordered sections and 328 structured notes across the whole-piece scaffold.
- Completed: `whole-piece pass v3`
  A new whole-piece pass now runs across all forty-one sections and writes refreshed JSON, CSV, and Markdown outputs under `data/piece-pass/taohuawu-whole-v3`.
- Completed: `whole-piece summary export integration`
  The research export pipeline now copies the newest whole-piece pass summary into `exports/piece-pass-summary.json` and `exports/piece-pass-sections.csv`, and `research-analysis/analyze_exports.py` now emits dedicated piece-pass tables, figures, and report sections.
- Completed: `pilot execution pack generation`
  The project now includes `scripts/build-pilot-pack.mjs`, pilot run-sheet templates, and teacher batch validation templates so the weakest whole-piece sections can be exported into an operational pilot packet instead of being copied by hand from reports.
- Current next step:
  run a real-sample pilot with the generated pilot pack, collect teacher validation on the weakest sections, and decide whether the remaining PDF pages need full literal transcription or only targeted reinforcement.

## 2026-04-21 Research Focus Update

- Main study framing:
  The project should now be framed primarily as `AI-supported self-practice` rather than `teacher-evaluation-first`.
- Primary outcome domains:
  pitch gain, rhythm gain, self-practice behavior, questionnaire responses, and interview evidence on feedback use.
- Teacher-related modules:
  keep teacher validation, dual-rater reliability, and adjudication as optional secondary validation tools, not as the required main path.
- Current next step:
  run a self-practice pilot with repeated learner takes, logs, questionnaires, and interviews, then decide later whether any teacher-side validity check is still needed.

## 2026-04-21 Mainline Priority Reset

- Highest-priority product line:
  build the student-facing `Web / PWA / shell-app` flow around `PDF score -> recording/upload -> diagnosis -> feedback`.
- Deep-learning requirement:
  both `pitch` and `rhythm` are now considered required deep-learning directions for the mainline product.
- Current gap:
  pitch already uses a deep-learning model path (`torchcrepe`), but rhythm is still mainly `onset + DTW + rule typing`, so rhythm deep learning remains an unfinished mainline requirement.
- Secondary systems:
  teacher validation, adjudication, and research-management workflows remain available but should no longer outrank the student-facing diagnosis product line.
- Current next step:
  push the project toward formal PDF intake and a student-facing diagnosis app, while planning the next upgrade step for a deep-learning rhythm model.

## 2026-04-21 Student Mainline Implementation

- Completed: `student-first app shell`
  The default root app is now a student-facing `PDF -> section -> upload/record -> diagnosis` flow, while the old research workspace is kept as a secondary mode.
- Completed: `score import job flow`
  The Node gateway now exposes `POST /api/erhu/scores/import-pdf`, `GET /api/erhu/scores/import-pdf/:jobId`, and `GET /api/erhu/scores/:scoreId`, and stores imported score jobs plus normalized structured scores in `data/erhu-score-imports.json`.
- Completed: `known-piece PDF fallback`
  When Audiveris is not configured locally, known PDFs such as `桃花坞` can still enter the mainline automatically by matching against the built-in structured score library instead of forcing the student into manual note entry.
- Completed: `erhu-focus separation outputs`
  The Python analyzer now exposes `POST /audio/separate-erhu`, upgrades preprocessing to `erhu-focus`, persists raw / enhanced / accompaniment residual audio previews under `/data/generated-audio/...`, and returns separation metadata in `analysis.diagnostics`.
- Completed: `score-aware analyze by scoreId`
  The main `POST /api/erhu/analyze` flow now accepts `scoreId` plus `separationMode=auto|off|erhu-focus`, so imported PDF scores can go through the same deep-learning pitch + DTW diagnosis chain without relying on built-in piece selection.
- Current next step:
  keep `Audiveris` as the preferred real OMR backend, continue trying to enable a true `madmom` rhythm-model environment on this machine, and polish the student UI/UX around automatic score import and diagnosis history.

## 2026-04-21 OMR + Whole-piece Stability Update

- Completed: `Audiveris pagewise OMR fallback`
  The Python score-import path now falls back from whole-PDF OMR to pagewise Audiveris runs, so `桃花坞` can complete automatic import with detected parts such as `Voice` and `Piano` instead of silently dropping back to the old manual path.
- Completed: `madmom rhythm model activation`
  The local Python environment now reports `madmom=true`, and the student-facing diagnosis path uses `madmom-rnn-onset` and `madmom-rnn-beat` in real runs rather than only the old librosa fallback.
- Completed: `imported-score section identity fixes`
  Imported score sections now retain the real `scorejob-*` piece id, and auto-detected section ids are written back correctly into the saved student analysis records.
- Completed: `whole-piece pass cache + summary artifact`
  `scripts/run-piece-pass.py` now writes a dedicated `*-whole-piece-summary.json` plus per-section cache files under `section-cache/`, so repeated whole-song deep passes can reuse prior section analyses instead of recomputing every matched section from scratch.
- Completed: `student whole-piece summary visibility`
  The student app can now fetch the newest whole-piece summary by `pieceId/title` and surface the current whole-song coverage, weighted scores, dominant practice path, and weakest sections inside the diagnosis history area.
- Current next step:
  run repeated whole-piece passes against the cached `桃花坞` scaffold to verify speed gains, then decide whether to bring whole-song pass triggering directly into the student UI.
## 2026-04-21 Mainline Priority Snapshot

- Mainline mission:
  keep the student-facing `PDF score -> record/upload -> deep-learning diagnosis -> localized feedback` flow as the highest-priority product line.
- Latest whole-piece baseline:
  the refreshed `妗冭姳鍧瀈 whole-piece pass now reports `41/41` matched sections, `weightedPitchScore=62.82`, `weightedRhythmScore=77.84`, `weightedCombinedScore=72.14`, and `weightedStudentCombinedScore=83.47`.
- Completed: `focused weak-section calibration round`
  Added section-level calibration profiles for `answer-loop`, `folk-dance-answer`, `pedal-tension-loop`, `descending-beacon`, and `con-brio-entry`, then reran a fresh whole-piece pass plus a cached verification pass.
- Calibration outcome:
  `folk-dance-answer` is no longer in the weakest-section list, while `answer-loop`, `descending-beacon`, `pedal-tension-loop`, and `con-brio-entry` still need another targeted pass; `bright-recap-fanfare` entered the new weakest group.
- Priority P0:
  keep improving core diagnosis quality on the current weakest sections: `answer-loop`, `bright-recap-fanfare`, `descending-beacon`, `pedal-tension-loop`, and `con-brio-entry`.
- Priority P1:
  continue polishing the student result page, diagnosis history, and re-record flow so the student-facing app feels like a product rather than a research console.
- Priority P2:
  improve unknown-PDF robustness in the automatic OMR pipeline so the mainline does not depend on piece-specific reinforcement.
- Priority P3:
  improve the diagnosis-first `erhu-focus` separation path, especially on mixed recordings with persistent piano residuals.
- Priority P4:
  package the current Web/PWA flow into a more installable shell-app experience after the diagnosis quality is stable enough.
