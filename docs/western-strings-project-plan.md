# 弓弦乐器练习诊断平台 — 完整项目开发手册

> 本文是**可交付开发执行**的完整项目计划(10 章)。战略与 M0–M5 闸门详见 [western-strings-migration-plan.md](western-strings-migration-plan.md);本手册在其上补全:资产盘点、M0 SOP+结果、M1–M5 工程拆解、后台/UI/API/schema 变更、数据集许可证、版本定义、论文产出对应、时间线/人力/停止条件。
> **状态:M0 已通过(GREEN),进入 Phase 1。** 二胡自动线冻结为 V1.5(人在环 + 困难案例/论文证据)。

---

## 1. 项目目标与版本定义

**目标**:一个**乐器无关**的练习自动诊断系统——上传音频(+干净谱面),系统在**高置信片段**自动给诊断,其余进复核;**绝不低置信硬判给学生**。先以**小提琴**验证打通,架构覆盖弓弦家族。

**版本定义(每级"用户能看到什么"):**
| 版本 | 能力 | 学生看到 | 教师看到 | 达成条件 |
|---|---|---|---|---|
| **V1.5(当前,二胡)** | 人在环:人工锚点→教师结构化标注→导出 | 无自动反馈 | 标注后台 + 导出 | 已达成 |
| **V2-alpha(小提琴)** | 高置信 note 对齐自动判,后台离线 | 暂不开放 | 自动预测+置信+证据+一键改正 | M2:auto_pass precision≥90%、coverage≥20%、跨曲验证 |
| **V2-release** | 基础诊断(音准/节奏/漏多音)对高置信开放 | 高置信音的诊断+谱面定位;低置信"需复核" | 复核+回流 | M3 完成 + 教师闭环 |
| **V3-beta** | 覆盖率提升,多曲稳定 | 更多自动诊断 | 同上 | 500 真值/10 曲、coverage≥30%、precision≥90% |
| **V3-release** | 大部分常规段自动,散板/复杂仍复核 | 大部分常规段自动 | 同上 | coverage≥40-60%、unsupported 稳定拒绝 |
| (技巧 M4) | 揉弦/弓法等,达标才自动、否则 review | 达标技巧标注 | 复核 | 每类 AUC≥0.70、precision≥90% |
| (大提琴 M5) | 弓弦家族扩展 | 同小提琴 | 同 | cello 独立 M0 + 重校准 |

**硬原则**:precision 是硬门槛(≥90% 才给学生);**覆盖率是结果不是目标**(覆盖低但准也算阶段成功);fail-closed 四态。

---

## 2. 当前二胡资产盘点(复用 / 冻结 / 实验)

**后台 `src/server/`(✅ 多数与乐器无关,直接复用):**
| 模块 | 处理 |
|---|---|
| `teacherValidationService.js` / `teacherValidationRoutes.js` | ✅ 复用(teacher-ready gate、结构化字段、四态基础) |
| `scoreStoreSqlite.js` / `scoreStoreSupport.js` / `scoreRoutes.js` | ✅ 复用(改喂干净 MIDI/MusicXML;**停用 OMR 导入路径**) |
| `analyzerClient.js` / `analysisRoutes.js` / `taskQueue.js` / `jsonStore.js` / `baseUtils.js` | ✅ 复用 |
| `scoreLineRoles.js` / `omrStats.js` | ⚠️ 二胡/OMR 相关,弦乐第一版**不接** |
| `researchService.js` / `researchRoutes.js` / `opsRoutes.js` | ✅ 复用(研究/运维) |

**前端(✅ 复用,改文案/乐器配置):** `TeacherValidationApp.jsx` + `src/teacherValidation/*`(ScoreLocatorPanel/SegmentAudioPlayer/atoms/utils)、`StudentApp.jsx`、`MainApp.jsx`、`PdfScoreHelper.jsx`。

**生产脚本 `scripts/*.mjs`(✅ 复用):** `build-manual-anchor-pack` / `export-manual-anchor-labels` / `slice-review-clips` / `import-teacher-validation-reviews` / `audit-teacher-validation-readiness` / `test-teacher-validation-workflow` / `build-quality-baseline` / `check-*`(p0/pwa/frontend-split/quality-baseline)。
**npm 生产入口:** `dev/server/build/start`、`analyzer:start`、`teacher:*`、`test:teacher-validation`、`check-server-p0`。

**数据资产:** 教师包 `manual-anchor-{fusheng,rhapsody-2,xuandong}`(二胡,冻结保留为困难案例);导出 `technique-labeling-export/2026-06-24T10-55-04-081Z`(37 段,论文负结果证据)。

**冻结(不删、不接生产):** 二胡 OMR/Audiveris 链路、`scan-piece-segments`、长曲自动对齐实验脚本(`align-*`、`anchor_eval`、`eval_*` 二胡系列)、二胡 score store 条目。**保留为 V1.5 成果 + 论文能力边界证据。**

**纯实验(`scripts/experiments/*.py`,121 个 .py):** 标记为 eval-only,不进生产;弦乐线新增的 M0 脚本(`eval_western_strings_m0_{bach10,urmp,musicnet}.py`)同此类。

**裁决:后台/教师闭环/导出/前端 = 直接复用;OMR/二胡对齐 = 冻结;实验脚本 = 保留不接生产。**

---

## 3. 西洋弦乐迁移范围(in / out)
**In(第一版):** 小提琴;输入 = 音频 + **MusicXML/MIDI/dataset-score**;note 对齐 + 基础诊断(音准/节奏/漏多音);四态置信门;教师复核回流。
**Out(后续):** PDF OMR(避免坎1)、技巧识别(M4 后置)、大提琴(M5)、用户上传任意谱面、散板/重 rubato 曲目自动判(直接 reject_unsupported)。

---

## 4. 数据集与许可证计划
| 数据集 | 用途 | 许可证现状 | 仓库政策 |
|---|---|---|---|
| **Bach10** | M0a smoke(只评 violin/soprano part) | 原集研究用、条款需逐个确认;合成变体 CC BY-NC | **仅本地缓存,不入仓库,不随论文公开音频**;引用论文 |
| **URMP** | M0b 分轨 violin/cello | 研究用途;再分发条款不明确 | 仅本地缓存;引用;公开前确认 |
| **MusicNet** | M0c 规模/跨曲 | 多为自由许可(标签 CC BY 类),含 ~4% 标签噪声 | 标签可按 CC BY 描述/引用;**音频不重打包**;先确认 |
| **ASAP** | 方法参考(钢琴) | 见其仓库 | 不作弦乐主验证集 |

**通用安全默认(写死):**
- **数据集音频/标签一律不提交进 git**;`data/` 已 gitignore;只提交**我们的 adapter 代码 + 指标 JSON/CSV(去标识)**。
- 任何**公开发布(论文/开源)前,逐数据集核实许可证**;不确定的只用"metadata 描述",不放原始数据。
- 来源:[Bach10](https://labsites.rochester.edu/air/datasets/Bach10%20Dataset_v1.0.pdf)、[URMP](https://labsites.rochester.edu/air/publications/li2018creating.pdf)、[MusicNet(Zenodo)](https://zenodo.org/records/5120004)、[ASAP](https://github.com/fosfrancesco/asap-dataset)。

---

## 5. M0 验证 SOP + 结果(已完成,GREEN)

**SOP(如已执行):** 建分支 `feature/western-strings-m0-alignment` → 接入数据集(只取目标乐器 part)→ adapter 输出三件套(audio / score 音符序列 / gold note-onset 秒)→ 跑 `crepe-dtw` + `parangonar-basic-pitch` + `basic-pitch-dtw` → 按定义算 median/p90 onset、hit@100/300ms、coverage、double-stop/legato 单独报 → 两级闸门判定。

**结果(commit 660dce5,GREEN):**
| 数据集 | 最佳方法 | median onset | hit@300ms | 判定 |
|---|---|---|---|---|
| Bach10 (M0a) | parangonar-basic-pitch | 35.2ms | 95.8% | 🟢 |
| URMP (M0b) | parangonar-basic-pitch | 19.1ms | 93.8% | 🟢 |
| MusicNet (M0c) | basic-pitch-dtw | 58.4ms | 95.3% | 🟢 |
真实 CREPE-DTW 三层亦全绿。报告:`docs/western-strings-m0-alignment-report.md`;脚本:`scripts/experiments/eval_western_strings_m0_*.py`;产物:`data/experiments/western-strings-m0/`。

**诚实 caveat:** M0 用数据集 gold + 干净谱 + 精录/有拍音频(最有利工况)。**未覆盖**:真实学生录音(错音/音准漂/噪声)、真实 MusicXML、V2 置信门在真实输入上的 precision。**M0 证明地基(对齐)可行,V2/V3 仍需在真实输入上验证。**

---

## 6. M1–M5 工程开发拆解(可直接派给开发)

### M1 — 干净谱面接入(MusicXML/MIDI first)
- **backend:** 新增 `instrumentConfig`(violin G3-A7 / viola C3-E7 / cello C2-C6,tracking range,可逐曲收窄);`scoreImporter` 支持 MusicXML + MIDI → 统一 score store;**停用 OMR 导入路由**。
- **schema:** score 记录加 `instrument`、`scoreSource: musicxml|midi|dataset`、`tempoKnown`/`tempoSource`(沿用二胡线教训,不伪造 72)。
- **adapter:** dataset→score store(复用 M0 adapter 思路)。
- **测试:** Bach10/URMP/MusicNet 能统一进 store;不依赖 Audiveris;无污染缓存。
- **交付物:** importer + instrumentConfig + 3 个 adapter + 单测。

### M2 — 小提琴 V2 置信门
- **backend:** `noteAlignmentService`(CREPE/Basic Pitch/Parangonar/local DTW/onset 候选);`confidenceModel`(LR/RF,**置信模型而非投票**,沿用二胡 ensemble 教训);四态决策。
- **schema(每 note finding):** `autoDecision`、`confidenceScore`、`confidenceModelVersion`、`candidateSources[]`、`reviewRequiredReason`、`teacherOverride`。
- **reason codes:** `double-stop-unsupported`/`legato-onset-ambiguous`/`rubato-section`/`low-pitch-confidence`/`polyphonic-texture`/`score-audio-range-mismatch`/`weak-onset`/`dataset-label-uncertain`。
- **frontend(后台):** 自动预测位置 + 置信 + 证据 + 一键确认/改正 + 是否采纳 + 回流开关。**默认 feature flag 关闭,先后台验证。**
- **API:** `POST /api/strings/analyze`(audio+scoreId→note findings+decisions);`POST /api/strings/review`(override→训练集回流)。
- **验收:** auto_pass precision≥90%、coverage≥20%、按曲报告、留一曲验证、无真值泄漏。

### M3 — 基础教学诊断(先于技巧)
- 诊断:音准偏差 / 起音时序 / 音长误差 / 漏音·多音 / 音高不稳 / 低置信警告。
- **frontend(学生端):** 高置信音诊断 + 谱面定位;低置信"需复核";reject 段明确提示。
- **验收:** note-level 反馈落到谱面位置;低置信不反馈;教师复核可用 + 回流。

### M4 — 技巧识别 pilot(后置,降承诺)
- 短窗(5-10s/音符邻域),先 vibrato→pizzicato→staccato/legato→spiccato→position shift→harmonic。
- 数据:教师短窗标注 / 公开技巧数据(核许可证)/ 合成仅预训练。
- **验收:** 每类报 AUC + **PR-AUC** + 每类正负样本数 + **按曲留一**;AUC≥0.70 且 PR-AUC 明显高于正例基率才继续;precision≥90% 才 auto_pass。

### M5 — 大提琴扩展
- cello pitch range + onset/pitch 参数 + **专属误差分析** + **重新校准阈值(不复用小提琴)** + **独立 cello M0**。
- 表述:架构"配置层预留",非"同时支持"。

---

## 7. 后台 / UI / API / schema 变更汇总
- **schema:** score 加 `instrument/scoreSource/tempoKnown/tempoSource`;note finding 加 `autoDecision/confidenceScore/confidenceModelVersion/candidateSources/reviewRequiredReason/teacherOverride`。
- **API 新增:** `/api/strings/analyze`、`/api/strings/review`;score import 走 MusicXML/MIDI。
- **UI:** 教师后台加"自动预测+置信+证据+改正+回流";学生端加四态展示;乐器选择。
- **feature flag:** `strings.autoFeedback`(默认关),`strings.technique`(默认关)。
- **不动:** 二胡现有后台/包/导出(冻结)。

**canonical score metadata 约定(防字段漂移):**
| 层级 | 字段 | 语义 |
|---|---|---|
| score/job 持久化 | `instrument`, `scoreSource`, `tempoKnown`, `tempoSource` | 对外/后台读取的稳定字段 |
| piecePack/section | `instrument`, `scoreSourceType`, `tempoKnown`, `tempoSource` | analyzer 内部输入/输出字段 |
| note finding | `autoDecision`, `confidenceScore`, `confidenceModelVersion`, `candidateSources`, `reviewRequiredReason`, `teacherOverride` | M2 之后新增,未接生产前不得影响学生端 |

`scoreSource` 与 `scoreSourceType` 不再新增第三套同义字段;新增 adapter 必须在测试里同时验证持久化层和 piecePack 层。

## 7A. V2 落地细节(审查 v2 新增)
**① 置信模型泄漏黑名单(训练禁用):** 禁用任何**真值派生**字段(`goldError`/`measureError`/与 gold 比对得到的误差量);**允许** method agreement、Parangonar cost、Basic Pitch confidence、CREPE pitch stability、onset 距离、polyphony/legato flag、score-context(前后音/密度)。评估按曲留一(LOPO),训练/测试不同曲。

**② reason code → UI 文案映射:**
| reason code | 学生看到 | 教师看到 |
|---|---|---|
| `low-pitch-confidence` | (不显示该音诊断) | 音高置信低,需复核 |
| `double-stop-unsupported` | 此处双音/和弦,暂不自动判 | double-stop,自动跳过 |
| `legato-onset-ambiguous` | (不显示起音诊断) | 连奏起音边界不清 |
| `rubato-section` | 此段自由节奏,暂不自动判 | rubato 段,review |
| `polyphonic-texture` | 多声部,暂不自动判 | polyphony,review |
| `score-audio-range-mismatch` | 录音与谱面不匹配 | 范围不符,reject |
| `weak-onset` | (不显示起音诊断) | 弱起音,review |
| `dataset-label-uncertain` | — | 数据标签不确定(仅评估) |

**③ 失败/降级操作表(触发 → 行为):**
| 触发 | 行为 |
|---|---|
| 同 onset ≥2 pitch(double-stop) | `review_required` |
| legato 起音边界不清 | `review_required` |
| pitch confidence < 阈值 | 不给学生硬反馈 |
| 音频与谱面长度/范围不匹配 | `reject_unsupported` |
| 模型分歧大 / 置信模型低分 | `review_required` |
| 系统异常 | `failed`(提示重试/人工锚点) |

**④ V2-alpha 产品范围(先不承诺完整教学系统):**
- **支持:** clean MusicXML/MIDI + **单声部小提琴**音频 → 输出**音准 / 节奏 / 漏音 / 多音 / 低置信提示**。
- **不支持:** 技巧自动判定、PDF 识谱、强 rubato / 多声部混音自动反馈、大提琴。
- **auto_pass precision≥90% 硬门槛;coverage 作结果报告**(低也可上线,只要准)。

---

## 8. 测试与验收标准
| 阶段 | 必测命令/证据 | 通过标准 | 失败处理 |
|---|---|---|---|
| M1 clean score | `test:western-string-config`, `test:western-musicxml-import`, `test:western-midi-import`, dataset adapter 输出样本 | MusicXML/MIDI/dataset-score 统一进入 note schema;不触发 OMR/Audiveris;metadata 持久化无漂移 | 不进入 M2 生产接入 |
| M2 alignment gate | feature table + confidence gate LODO;按数据集/按曲报告 | `auto_pass` 对齐 precision≥90%;coverage 只报告;无真值泄漏;reason codes 命中正确 | 降级 `review_required`,不接学生端 |
| M2b student-like pilot | 合成错音/漏音/节奏扰动 + 少量真实学生录音 | 真实输入下 precision 仍≥90%;错误样本不会被误 auto_pass | 继续后台离线,不得 release |
| M3 diagnosis | pitch/rhythm/missing/extra note 的独立评测表 | 音准、起音、时值、漏音/多音的诊断 precision 分开达标;低置信不反馈;回流可导出 | 仅显示对齐,不显示诊断 |
| M4 technique | 每类 AUC/PR-AUC/正负数/按曲留一 | AUC≥0.70 且 PR-AUC 明显高于基率;precision≥90% 才 auto_pass | 永久 review hint |
| 全程 | `check-server-p0` / `test:teacher-validation` / `build` | eval-only 脚本不写生产;数据不进仓库;feature flag 关时学生端零自动输出 | 阻断发布 |

**指标拆分(避免把对齐和诊断混在一起):**
- 对齐层: `AlignmentPrecision@100ms/300ms`, `median/p90 onset error`, `coverage`, `reject/review reason counts`。
- 诊断层: `Pitch MAE cents`, `onset error MAE`, `duration error MAE`, `missing/extra F1`, `diagnosis auto_pass precision`。
- 产品层: auto 段是否有教学价值;若 auto 只覆盖极简单音,即使 precision 达标也只算 alpha,不算 release。

---

## 9. 论文产出对应表(二胡 ↔ 小提琴对比)
| 贡献点 | 证据 | 类型 |
|---|---|---|
| 全自动音符级对齐在**二胡**上结构性受阻 | 粗定位 ~22s、ensemble 60%、置信门 oracle 也到不了 90%@20% | **负结果/能力边界** |
| "为何二胡比西洋乐难"(rubato/软起音/连续音高/OMR谱/分布外) | 分离证否 + 文献对比 | 分析贡献 |
| 同一 pipeline 在**西洋弦乐**上对齐可行 | M0:median 19-58ms、hit@300ms 93-96% | **正结果/对比** |
| 人在环可靠数据生产(二胡 37 段) | Plan C 流水线 + teacher-ready gate | 系统/数据贡献 |
| (待)小提琴 V2 高置信自动诊断 | M2 precision/coverage | 系统贡献 |
- **要生成的表:** 各乐器对齐精度对比表、二胡置信门负结果表、(待)小提琴 V2 precision/coverage 表、技巧 PR-AUC 表。
- **目标期刊**(WOS/EI/SSCI):贡献=系统 + 能力边界对比 + 人在环数据方法;**诚实负结果是卖点之一**。

---

## 10. 时间线 / 人力 / 风险 / 停止条件
**粗工时(单人):**
| 阶段 | 估时 |
|---|---|
| M0 | ✅ 已完成 |
| M1 干净谱接入 | 3-5 天 |
| M2 V2 置信门 | 1-2 周(含真值/模型/后台) |
| M3 基础诊断 | 1-2 周 |
| M4 技巧 pilot | 2-3 周(含教师标注) |
| M5 大提琴 | 1-2 周(+独立 M0) |

**停止条件(kill criteria):**
- M2 在真实输入上 auto_pass precision <90% 且补数据/调特征仍上不去 → 降级 review-only,不给学生自动反馈。
- M4 某类 AUC<0.65 → 该类永久 review-only。
- M5 cello 独立 M0 不过 → cello 暂缓。
- 任何阶段:数据许可证不清 → 不公开、不进仓库。

**风险表:**
| 风险 | 缓解 |
|---|---|
| 真实学生录音比数据集难 | M2 必须在学生样本上验证,不止数据集 gold |
| 置信门覆盖率过低无产品价值 | 定"最低可上线覆盖率";auto 段须有教学价值,非只覆盖简单音 |
| 重引 OMR → 坎1 重现 | 第一版只 MusicXML/MIDI |
| 数据许可证 | 不进仓库、公开前核实 |
| 技巧被高估 | 后置 + 单独数据 + 降承诺 |

---

## 立即下一步(Phase 1 / M1)
当前进度:
- ✅ `instrumentConfig` 已落地为 `config/western-string-instruments.json`,覆盖 violin / viola / cello;`npm run test:western-string-config` 已验证音域与 first-version flag。
- ✅ clean MusicXML 入口已支持西洋弦乐元数据透传与落盘:`instrument` / `scoreSource` / `tempoKnown` / `tempoSource`;`npm run test:western-musicxml-import`、`npm run test:server-boundaries`、`npm run test:server-p0` 已验证。
- ✅ clean MIDI 入口已补齐:`/api/erhu/scores/import-midi` → Python `/score/import-midi` → 统一 piecePack/score store;默认 `scoreSource=midi`, `tempoKnown=true`, `tempoSource=midi`;`npm run test:western-midi-import` 与 route boundary 已验证。运行该成功路径需要项目 Python 环境安装 `python-service/requirements-optional.txt` 中已声明的 `pretty_midi`。
- ✅ explicit violin part 导入不会触发二胡 melody-collapse,并保留 violin notes;旧二胡 MusicXML import / score roles 回归通过。
- ✅ dataset adapter 选择低风险统一导出路径:从 M0 artifacts 生成 `western-strings-dataset-index.{json,csv}` 与 `western-strings-gold-notes.csv`,共 14 个 piece / 2088 个 gold notes;只索引 raw 数据路径和 availability,不复制受限音频/MIDI/标签;`npm run test:western-dataset-index` 已验证 key 映射和去重。
- ✅ 西洋弦乐 clean-score 入口已加 `?mode=strings`:只允许 MusicXML/MIDI,不暴露 PDF OMR 控件;`npm run test:western-strings-entry` 以 source contract 验证 clean-score-only。
- ✅ M2 特征表第一版已完成:从 M0 per-note CSV 生成 note-level pivot 与 candidate-level 表;`label*` 字段显式标为 gold-derived,训练时禁用;`npm run test:western-alignment-features` 已验证。
- ✅ M2 置信门 eval-only 探针已完成:基于 candidate-level 表做 fail-closed 规则搜索,LODO 三折 precision 均 >0.96、coverage=1.0;`npm run test:western-confidence-gate` 已验证。注意:这证明高置信子集存在。
- ✅ M2 后台离线 preview API 已接入:`GET /api/strings/alignment-preview` 从 candidate feature table 生成 note-level `autoDecision/confidenceScore/candidateSources/evidence`;默认不返回 gold-derived label,`includeLabels=1` 仅用于离线验收;`npm run test:western-alignment-preview` 验证默认无泄漏与 precision@300ms=0.9818。
- ✅ M2 默认关闭学生自动反馈的源契约已补:`npm run test:western-feature-flags` 验证学生端/clean-score 入口不调用 `/api/strings/*` 自动诊断,服务端仅暴露离线 preview,不暴露 analyze/review 写入路由。
- ✅ M2 教师后台离线 preview 面板已接入:教师可加载前 8 条 note-level 预测证据并提交 confirm/correct/review_required,写入 ignored 的 `alignment-preview-reviews.jsonl`;仍不进入学生端、不进入质量基线。
- ✅ M2b student-like feature-level pilot 已补:`npm run test:western-m2b-pilot` 用 correlated +800ms 扰动证明当前 median-consensus preview 在一致性错误上不安全,因此 **不得开放学生端自动反馈**;只能保持 teacher-only preview。
- ✅ M2 release gate 已 fail-closed 接入 preview service:`studentSafe=1` 会读取 M2b 证据;证据缺失或 `studentGateReady=false` 时全部降为 `review_required`,测试覆盖默认 teacher preview 与 student-safe 两种模式。
- ✅ M2c 独立音频证据探针已补:`npm run test:western-m2c-audio-support` 用 Basic Pitch 事件支持检验 correlated drift。结果:基准 precision=0.9921 / coverage=0.7864,但 +800ms 相关漂移仍有 112 个重复同音误通过(precision=0),所以学生端 release 仍不达标。

剩余 M1 步骤:
1. M1 收口时再跑 `test:western-string-config` / `test:western-musicxml-import` / `test:western-midi-import` / `test:western-dataset-index` / `test:western-strings-entry` / `test:server-boundaries` / `test:server-p0` / `test:musicxml-import` / `test:analyzer-score-roles` / `test:teacher-validation` / `build`。

**完成即 M1 达标,进 M2 置信门。**

当前 M2 剩余步骤:
1. 若要继续冲学生端 V2,必须新增比 Basic Pitch event support 更强的独立音频证据(如局部谱图相似/起音峰支持/真实学生录音评测);在此之前 `studentSafe=1` 强制全量 `review_required`。
