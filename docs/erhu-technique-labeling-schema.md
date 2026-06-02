# 二胡技巧 / 错音教师标注扩展 schema（设计文档）

状态：设计草案，用于指导后续实现；本文件本身不改任何代码。

更新时间：2026-06-01

关联文档：[erhu-technique-detection-criteria.md](erhu-technique-detection-criteria.md)（判定边界与初始阈值）。

## 目标

把"二胡技巧 / 错音"的教师判断接入**现有** teacher-validation 体系，作为 `validationReviews` 的扩展字段，用于后续训练一个轻量、可解释、数据驱动阈值的判定器。

明确不做：

- 不新建平行的标注数据集或独立 store；
- 不要求教师给 `cents` / `Hz` / `ms` 阈值；
- 不在本阶段实现导出 / 导入 / 训练脚本（仅冻结字段口径）。

教师只做**结果判断**："这个音该不该报错 / 是不是技巧 / 是否需要复核"。系统负责从这些判断里学习边界。

## 复用现有基础设施（不另起炉灶）

后续实现必须**扩展**下列已存在的位置，而不是重写。经核对，这些文件与字段当前真实存在：

| 位置 | 当前作用 | 本扩展如何接入 |
|---|---|---|
| `src/server/teacherValidationService.js` | 规范化 / 存储 / 合并 `validationReviews`（按 `analysisId` + `raterId` 去重） | 在 review row 规范化里新增技巧标签字段，沿用现有 pipe-join 约定 |
| `src/server/teacherValidationRoutes.js` | 教师评审 API | 后续透传新增字段 |
| `src/server/researchService.js` / `researchRoutes.js` | 研究数据导出 | 导出时带上新增字段 |
| `scripts/teacher-validation-support.mjs` | pack / 规范化共享逻辑 | 标注样本导出复用此处 |
| `scripts/build-*-teacher-validation-pack.mjs`、`import-teacher-validation-reviews.mjs` | 生成待标注 pack / 导入教师标注 | 新字段加入 pack 列与导入列 |
| `test:teacher-validation`、`audit:teacher-validation-readiness` | 现有回归 | 扩展后必须仍通过 |
| `quality-baseline-support.mjs` | 从 `validationReviews` 算 noteF1 / precision 等 | 不变；新字段是附加，不破坏现有指标 |

现有 review row 字段（**保留不动**）：
`reviewId`、`analysisId`、`raterId`、`reviewStatus`、`includeInBaseline`、
`overallAgreement`、`teacherPrimaryPath`、`teacherIssueNoteIds`、`teacherIssueMeasureIndexes`。

### 关键约定：列表字段用 pipe-join 字符串，不是 JSON 数组

现有 `teacherIssueNoteIds` 在 store / CSV 里是 `"n2|n6|n7"` 形式（见 teacherValidationService.js 规范化逻辑）。**新增的 noteId 列表字段必须沿用同一约定**，以保证 CSV 往返可读、与现有导入逻辑一致。只有结构化的 `teacherTechniqueLabels` 用 JSON（见下）。

## 新增字段（冻结口径）

挂在每条 `validationReviews` row 上：

| 字段 | 类型 | 说明 |
|---|---|---|
| `teacherPitchIssueNoteIds` | pipe-join 字符串 | 教师判定为音准错误的 noteId，如 `"n6"` |
| `teacherRhythmIssueNoteIds` | pipe-join 字符串 | 教师判定为节奏错误的 noteId |
| `teacherReviewNoteIds` | pipe-join 字符串 | 教师认为证据不足、需复核的 noteId |
| `teacherAcceptableNoteIds` | pipe-join 字符串 | 教师认为可接受 / 无需报错的 noteId |
| `teacherTechniqueLabels` | JSON 字符串 | 每音一条结构化标签，见下 |

`teacherTechniqueLabels`（JSON 数组，整体存为一个字符串字段以适配 CSV/store）：

```json
[
  {
    "noteId": "n6",
    "label": "pitch-error",
    "technique": "none",
    "confidence": "high",
    "comment": "stable low pitch, should be reported"
  }
]
```

允许的 `label`：

- `pitch-error` — 音准错误，应报
- `rhythm-error` — 节奏错误，应报
- `acceptable` — 可接受，不应报
- `expression-or-technique` — 表现性技巧，容忍或仅措辞提示
- `review-unclear` — 证据不足，进入复核

允许的 `technique`：

- `none`
- `glide`（滑音）
- `vibrato`（揉弦）
- `trill`（颤音 / 打音）
- `unknown-technique`

允许的 `confidence`：`high` / `medium` / `low`（教师对自己判断的把握，**不是** cents 数值）。

四个 `*NoteIds` 字段与 `teacherTechniqueLabels` 冗余但互补：前者便于现有 pipe-join 流程直接消费，后者保留逐音的 technique / confidence / comment 供训练。实现时以 `teacherTechniqueLabels` 为权威源，四个列表由它派生。

## v1 音频呈现方式（不承诺 per-note 切片）

当前没有 per-note 音频切片导出机制（`separate-erhu` 只存整段 enhanced/residual）。因此 v1：

- **整段音频路径** + **该音的时间戳区间**（`onsetSeconds` / `offsetSeconds`） + **谱面定位**（`measureIndex` / `noteId` / `notePosition`）。
- 教师在播放器里跳到时间戳听，不依赖每音一个音频文件。
- 因此导出的"音频路径"是整段路径，**不会为空**（避免 per-note 切片缺失导致的空路径问题）。
- per-note 切片导出列为后续可选增强，不是 v1 前置条件。

## 每条待标注样本携带的分析特征（供训练）

每行 = 一个音符 / 片段，包含系统侧信号（教师不需看这些，但训练需要）。

经核对真实 real-corpus 落盘数据（`run-summary.json` 里的 `wholePieceAnalysis.noteFindings`，对应 `schemas.py` 的 `NoteFinding`），特征分两层：

### v1 已落盘特征（现有 corpus 直接可取，v1 默认只用这些）

- 标识：`pieceId`、`sectionId`、`noteId`、`measureIndex`
- 音高：`centsError`、`rawCentsError`、`pitchToleranceCents`、`octaveFlexSemitones`
- 节奏：`onsetErrorMs`、`durationErrorMs`、`expectedDurationMs`、`observedDurationMs`、`rhythmType`、`rhythmLabel`
- 系统判断：`pitchLabel`、`isUncertain`、`severity`、`evidenceLabel`、`confidence`
- 音频 / 谱面：整段音频路径、`startSeconds` / `endSeconds`、谱面定位（`pageNumber` 等）

注意字段名：对外 `NoteFinding` 用 `confidence`（已 round），**不是**内部的 `estimatedConfidence`。

### v2 需要额外采集的技法特征（现有 corpus 没有，v1 不依赖）

- `pitchSpreadCents`、`glideRunMs`、`glideLike`、`vibratoAmplitudeCents`、`vibratoLike`、`trillLike`、`trillSwitchCount`、`entryCents`、`exitCents`、`stablePointCount`、`segmentPointCount`、`estimatedConfidence`

这些是 `analyzer_scoring.py` 内部 `aligned_notes` dict 的中间字段，**从未进入对外 `NoteFinding` schema，因此不落盘、现有 corpus 取不到**。要采集它们必须二选一（见下"n6 边界"）。

样本来源：Phase 0 audit 结果、real-corpus / 分析缓存、已知问题样本（n6、n5/n7 rush）。

## v1 默认路径：只用已落盘特征（路径 C）

v1 默认采用**路径 C**：只用上面"v1 已落盘特征"训练，先把标注 → 训练 → 离线评估闭环跑通。理由：A（扩 `NoteFinding` schema）影响 analyzer 输出 + 前端 + 存储，范围大；B（旁路 dump 中间字段）需重跑 corpus，工程量也不小；C 最简单，符合"代码简单明了"。

### v1 的诚实边界：不能修 n6

n6 的 glide-swallow 依赖 `pitchSpreadCents`（12c 稳定音）、`glideRunMs`、`stablePointCount` 等 **v2 才有的技法特征**。因此：

- **v1 不承诺、也无法修 n6** —— n6 保持[已记录的已知局限](erhu-technique-detection-criteria.md)。
- n5/n7 rush 同理：v1 可用 `rhythmType` / `onsetErrorMs` 学习，但 rush 的全局 tempo_ratio 伪差是另一条独立问题，不在本数据集范围。
- 若将来要让模型修 n6，必须先做 A 或 B 之一来采集技法特征：
  - **A**：把这几个字段加进对外 `NoteFinding` schema（碰 schema + analyzer + 前端 + 存储）。
  - **B**：训练专用旁路 dump（重跑 corpus，把 `aligned_notes` 中间字段写入训练文件，不碰 schema）。
- 现在**不为 n6 扩大范围**：先跑通 v1 数据闭环，n6 / 技法特征放到 v2。

## 最小可训练数据要求（防过拟合）

- 每个 `label` 类至少 **30 条**有效教师标签；
- 每个样本至少 **2 位教师**（`raterId` 不同）；
- 分歧样本进入**现有 adjudication 流程**（不新建仲裁机制）；
- 类别严重不平衡时，训练脚本必须报告每类样本数并拒绝静默训练。

## 训练计划（仅写清，本阶段不训练）

- 定位：**轻量、可解释、数据驱动阈值**——不是"消灭阈值"。决策树的每个分裂节点本身就是一个阈值；模型的价值是用教师数据拟合并交叉验证这些阈值，而非人手猜。
- v1 候选：Logistic Regression / shallow Decision Tree / Random Forest。
- 若用决策树：`max_depth <= 4`、`min_samples_leaf >= 5`、分层交叉验证、并用 Phase 0 的 inner-repeat 检查阈值在 madmom 抖动下是否稳定（不能只看一次 precision/F1）。
- 训练依赖放 `research-analysis/requirements-train.txt`，**不**加进 `python-service/requirements*.txt`（不进生产服务链路）；训练脚本在 sklearn 缺失时必须清晰报错。

## 模型产物策略（先冻结）

- `data/` 整体被 gitignore，因此**可入库**模型放 `models/erhu-technique-judge.json`（仓库根的新目录，纳入版本控制，满足可回退）。
- 临时训练报告放 `data/teacher-validation/technique-model-runs/`（不入库）。
- 未通过离线评估的模型不得入库。

## 集成纪律（后续阶段）

- 先离线评估：precision / recall / F1、混淆矩阵、n6 是否从 review 变 pitch-error、n5/n7 rush 是否仍作为独立 rhythm 问题保留。
- 只有模型**明显优于**当前规则、且 inner-repeat 稳定，才进入集成。
- 集成时保持简单可回退（env 开关），不一次性替换现有规则。
- 不碰 `paper/`、`paper/aaai2027-si-hsm`。

## 本阶段验收（仅文档）

- `git status` 只出现本新增文档；
- 文档明确不创建平行 teacher dataset；
- 文档列出现有 pack / import / store / 服务需扩展的真实位置（已核对存在）；
- 文档明确 v1 不要求 per-note 音频切片；
- 文档写明最小样本量与双评 + adjudication 要求。

后续代码阶段才运行：`test:teacher-validation`、`audit:teacher-validation-readiness`、`build`。

## 实现前事实核实（已确认）

已读 `scripts/teacher-validation-support.mjs` 核实，三项结论：

1. **CSV 列顺序 — 新列追加末尾安全。** `toCsv` 用 `Object.keys(rows[0])` 取表头，`parseCsv` 按**表头名**映射回字段（不是按列位置），所以新字段加在 `reviewTemplateRow` 返回对象的任意位置都能正确解析；为兼容旧模板 / 旧 CSV，约定**追加在末尾**。

2. **`teacherTechniqueLabels` JSON 单列 — 安全，无需降级。** `csvEscape` 对含 `" , \r \n` 的值做 RFC4180 转义（加引号、内部 `"` → `""`），`parseCsv` 是带 `inQuotes` 状态机的手写解析器（不是 `split(",")`），能正确还原引号内的逗号 / 换行 / 转义引号。因此 JSON 字符串可作为单列安全往返，**不需要降级成 pipe 格式**。

3. **训练特征只有一半落盘。** 见上"训练特征分两层"：v1 已落盘特征可直接用；`pitchSpreadCents` / `glideRunMs` / `vibratoAmplitudeCents` / `stablePointCount` / `estimatedConfidence` 未进 `NoteFinding` schema，现有 corpus 取不到，属 v2（需路径 A 或 B）。

## teacher-ready alignment gate（已实现）

技巧标注包必须通过 **teacher-ready alignment gate** 才会进入教师后台。仅 `scanMode==analyzer-window`（即旧 `trusted`）不够——它只证明扫描是分析器产出的，不证明音频窗与谱面段内容对齐。真实长录音的谱面估时长会严重失真（如 601s 录音估出 ~10s），导致段窗挤在开头、音频与谱面错配。

三道闸门（`buildAlignmentEvidence` / server `buildTeacherAlignmentEvidenceFromPassJson` 同步实现，env 可调）：

| 闸门 | 默认 | 含义 |
|---|---|---|
| `durationRatio = estimatedPieceDuration / audioDuration >= 0.5` | 0.5 | 时间尺度合理性。**不是内容匹配证明**，但极低值（几百秒录音估出几秒）直接判不可自动给教师 |
| 无严重段窗重叠（`>=4s` 或 `>=较短窗 25%`） | 4s / 0.25 | 轻微 padding 重叠允许；严重重叠说明段定位不可靠 |
| 至少 1 个 system finding | 1 | 技巧标注样本需要有可判断的对象 |

结果（当前真实样本）：54 个 scanMode-trusted 样本**全部** teacher-ready=false（`duration-ratio-too-low` + `section-windows-overlap`），所以 `teacher:technique-labeling-export` 默认导出 **0 行**——这是如实的"当前没有 teacher-ready 样本"，不是 bug。`audit:teacher-validation-readiness` 现在同时报 `teacherReadyCandidateCount` 与 `rejectedNotTeacherReady*`，避免误读 trusted 计数。

诚实边界：`0.5` 是基于当前合成/真实数据的保守初值；真实轻滑音与正常 tempo 分布仍需教师数据校准，避免误拒。要产出真正 teacher-ready 的样本，需先解决长录音的段级音频-谱面对齐（比闸门更深的问题）。

## 仍需确认（写导出脚本时）

- `teacherTechniqueLabels` 单 JSON 列在 Excel 手工编辑后另存的转义是否仍合规（程序往返已确认安全，人工经 Excel 编辑是另一回事，建议教师用提供的模板而非 Excel 重存）。
- real-corpus 已落盘 `NoteFinding` 是否覆盖足够多的 `label` 类样本，以达每类 ≥30；不足时如何补采。
