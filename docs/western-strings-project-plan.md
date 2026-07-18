# 弓弦乐器练习诊断平台 — 完整项目开发手册

> 本文是**可交付开发执行**的完整项目计划(10 章)。战略与 M0–M5 闸门详见 [western-strings-migration-plan.md](western-strings-migration-plan.md);本手册在其上补全:资产盘点、M0 SOP+结果、M1–M5 工程拆解、后台/UI/API/schema 变更、数据集许可证、版本定义、论文产出对应、时间线/人力/停止条件。
> **状态:M1 已完成并通过收口回归;M2 teacher-only preview 已接入;M2e 学生式事件扰动已通过 synthetic gate;M2f 真实学生录音 release gate 已于 2026-07-08 通过;M3 core diagnosis gate 已通过;最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环、gated preview UI、clean-score + audio 受控提交流、离线复核队列、fail-closed 批处理审计执行器已接入。** 离线/gated preview 已验证的核心类别只有 pitch / onset / missing;当前三项学生运行时开关仍全为 false,不向学生端输出这些诊断。duration 与 extra-note 仍为 review-only:6 套 drag/extra 波形注入集及逐音期望标签已经生成,但尚未被任何正式评测消费,且缺真实学生逐音真值;双音 `19/24` 是独立 double-stop recall,不得混写成 extra-note。普通 clean-score batch 当前无条件进入 Basic Pitch + gap-penalty DTW 的 dynamic-shadow 路径,输出全量候选 artifact 与审计摘要,所有候选仍为 `review_required`。旧 pYIN 线性映射、RF confidence scorer、first-measure release/approval/pilot 只保留为历史 telemetry,不再具有授权力。运行时默认且强制 fail-closed;它仍不是任意上传音频实时学生诊断器。二胡产品线已从默认产品范围移除;仅保留论文证据和西洋弦乐仍依赖的共享模块/数据。
>
> **范围变更(2026-07-09):** PDF/图片谱面 **OMR 识别**由原"Out(避免坎1)"上调为**主线路线内里程碑 M4**(详见第 3、6 章)。**判断层不变**(音高/节奏诊断仍是音频侧 M2/M3);OMR 只解决"谱面从哪来",且必须先过**note-level 精度闸门**才被信任,不达标的识别谱一律 fail-closed 退人工核对,**绝不直接进判断**——这是从二胡坎1吸取的纪律。
>
> **路线重构(2026-07-09,2026-07-17 更新):** 原"技巧识别 M4(技法名称展示)"**已删除**。M3+ 不再要求颤音/装饰音音频分类,而改为**音高指控安全**:平拉和谱面声明的揉弦/滑音只在稳定中心证据充分时判断;谱面标记的 tr/装饰音/泛音区零指控;高离散度一律 `insufficient_evidence`。**不展示技法名、不降音准标准、拿不准仍退复核**。当前 `3/8` 只是 score-intent center agreement/coverage,独立逐音 intonation gold 尚未连接,不得写成精度。双音 multi-f0 独立支线保留。里程碑重编号:**OMR = M4(提前)、大提琴 = M5(最后)**。
>
> **受控 pilot 决策包(2026-07-10,历史审批流程):** 负责人批准与五批一次性离线 pilot 是旧 RF/first-measure 事实,已显式 superseded。当前 `western:release-review` 必须生成 `schemaVersion=2`、使用 `western-ordinary-dynamic-shadow-release-v1`,并带同轮 live ordinary/M3+ evidence projection SHA;decision/preflight 会重新计算该绑定,手写或陈旧绿报告不得通过。新 approval 必须持久化并复核“独立 monitored pilot”与“默认运行时 fail-closed”两项确认。在 r3 接受性证据和两轨独立 `authorizationReady=true` 合同缺任一项时,`western:controlled-pilot-decision`、旧 approval 和旧 start preflight 都必须失败。未来若重新授权,仍须按 release review → 新 scope approval → decision → start preflight 顺序执行,且默认学生运行时全程 fail-closed。
>
> **受控 pilot 机器验证已扩到 5 条独立录音(2026-07-10,r2-08 前历史状态):** 全曲口径仍不可放行:275 候选 / 33 个模型原始 auto-pass / 11 个严格候选,全曲有效 coverage=4.00%;联合 threshold sweep 证明不能靠放宽参数同时满足 precision≥90% 与 coverage≥20%。但错误高度集中在后续小节,因此新增明确的 **first-measure-only** 受控范围:只有第 1 小节且 confidence≥0.95 才可 auto-pass,其余全部 `review_required`。该范围历史留一录音为 12/12 正确、coverage=25.53%(5 条录音),真实受控 pilot 为 11/11 正确、coverage=26.83%(5 条独立录音),0 known wrong、0 unknown。runtime scope 已在显式 pilot flag 下接线并通过正反单测/临时 smoke;默认学生端仍 fail-closed。`machinePreflightPassed=true`,`teacherReviewAllowed=true` 当时只授权准备一份全新的、小型盲验包;该授权已用于后续 `r2-08`,不再表示当前仍缺待复核包。后续小节自动化仍未解决。
> **历史 Fresh blind 入场(2026-07-10,已消费且已 superseded):** 当时为旧 first-measure 路线建立的 `fresh-blind-intake-stage/status` 原子登记与审计链已经用于 `r2-08`;`readyForMachinePrecheck=true` 只说明那次旧入场合规,不授权当前 dynamic-shadow。现有 12 条录音、`r2-08` 及后续 r3 接受性材料均不能用于新的发布盲审。未来另取全新录音+新曲目时可复用“内容哈希/谱面批准/失败不替换”的输入纪律,但必须另建当前版本的 full-piece dynamic release 合同,不得直接沿用旧 intake 状态或教师包。

> **第二轮受控执行(2026-07-15):** 8/8 组新音频、MusicXML 和谱面图片已完成审计与机器分析。导入时暴露并修复了“多小节 MusicXML 被压缩到第 1 小节”的结构缺陷;结构闸门现要求候选音符数、小节数和唯一 note ID 均与源谱一致。`r2-08` 精确 fresh-blind pilot 处理 60 个候选,模型原始 auto-pass=3,但 scoped/self-checked auto-pass 均为 0,因此按 fail-closed 中止且未发布学生反馈。尚欠的只读运维尸检是逐条记录 3 个原始 auto-pass 被 scope/self-check 的哪条规则抑制;它只改进可观测性,不恢复旧 RF 授权。M3+ 新库存为 444 音符/292 review-only 候选。原始 `README-怎么用.md` 已确认 M3 场景数量为错音 5 / 漏音 5 / 拖拍 4,并已用于机器候选搜索;但 `notes.txt` 未提供具体小节,所以精确 recall/precision 仍不得计算。当前结论是“第二轮机器链路完成,发布闸门未过”,不是 V2 默认开放。
> 旧 runner 当时会从历史 session 排除已执行 `recordingId`,并以 `pilot-reused-recording` 阻断重复录音;该行为只解释历史五批和 `r2-08`。当前 runner 的旧 RF executor 已删除,新的 dynamic pilot executor 未实现前固定 fail-closed,上述旧参数不能启动当前 pilot。
>
> **当前分支刷新(2026-07-18):** `feature/model-bakeoff-omr-align` 已重新运行 HOMR 部署 preflight、ordinary dynamic-shadow live preflight、`western:project-status` 与 `western:project-gate`。P0 冻结 5 谱完整通过 `1/5`,谱号/调号/拍号=`3/5,2/5,2/5`;默认学生端三项运行时开关仍全关。ordinary 当前失败项是 live artifact verifier 未实现、r3 接受性未执行、独立授权关闭和因果能量否决未冻结;M3+ gold-free runtime foundation/物理 audit 已通过,但 v2 因保护库存仅 8/14 实际执行、平拉独立 gold join=`0/12`、揉弦/滑音 join=`0/8` 而 fail-closed;M4 OMR 自动采纳也未达标。HOMR v3 候选池使 12 份缓存重放的机器可用数由纯 Audiveris `3/12` 提升到 `9/12`,但所有输出仍受 P0/曲级/邻音纪律约束,`m4OmrAutoScoreReady=false` 不变。
> **HOMR v3 运维/治理边界:** 具名 AGPL-3.0/六模型审查已批准唯一范围 `controlled-offline-review-only`;稳定音频/HOMR 隔离运行时、依赖锁、离线 wheelhouse 和启动自检均已固化,本机 live preflight 三绿。preflight 与 review-record SHA-256 绑定,审批或 artifact 漂移会 fail-closed。学生端网络使用、自动采纳和再分发仍关闭;不得把受控离线部署就绪外推成默认生产发布授权。
> **ordinary dynamic-shadow 基础层:** Basic Pitch + gap-penalty DTW 当前合同为 `western-ordinary-dynamic-shadow-candidate-v1` / `western-ordinary-dynamic-shadow-policy-v1`。独立 Python 3.11 venv 禁止 system/user site,完整包集合、requirements lock 与 Basic Pitch SavedModel tree hash 均由 live preflight 精确校验;config/lock/model 另由代码常量锚定并写入 cache/candidate attestation。ordinary 强制全谱分析;候选不仅必须与 score 音符数相等,还逐音绑定唯一连续 `noteIndex` 及 `noteId/sectionId/measureIndex/midi` identity。venv 本体不进 Git,新环境用 `npm run western:ordinary-dynamic-shadow-runtime-setup` 建立,缺失即 fail-closed。当前仅 `foundationReady=true`;r3 live artifact verifier 尚未实现,故 `r3AcceptanceReady=false`,`authorizationReady=false`,`studentGateReady=false`。
> **pilot executor 安全停机:** 旧 runner 不再默认导入 RF review-pack executor。`western-ordinary-dynamic-shadow-pilot-executor-v1` 尚未实现,所以 start preflight 即使拿到测试用批准也会因 executor 缺失而 fail-closed;只有后续显式实现并验证新 executor 才能移除此 blocker。

---

## 1. 项目目标与版本定义

**目标**:一个**乐器无关**的练习自动诊断系统——上传音频 + 谱面(**PDF/图片经 OMR 识别,或干净 MusicXML/MIDI**),系统在**高置信片段**自动给诊断,其余进复核;**绝不低置信硬判给学生**。先以**小提琴**验证打通,架构覆盖弓弦家族。**谱面侧同样 fail-closed**:OMR 识别结果必须先过精度闸门(M4),不达标的谱不得直接进判断,退人工核对。

**版本定义(每级"用户能看到什么"):**
| 版本 | 能力 | 学生看到 | 教师看到 | 达成条件 |
|---|---|---|---|---|
| **Legacy evidence(二胡保留材料)** | 人在环:人工锚点→教师结构化标注→导出 | 不作为当前产品入口 | 论文证据/困难案例/共享模块 | 已归档保留 |
| **V2-alpha(小提琴)** | 高置信 note 对齐自动判,后台离线 | 暂不开放 | 自动预测+置信+证据+一键改正 | M2:auto_pass precision≥90%、coverage≥20%、跨曲验证 |
| **V2-release** | 基础诊断 core(音准/起音/漏音)对高置信开放;时值/多音 review-only | 高置信音的诊断+谱面定位;低置信"需复核" | 复核+回流 | M3 core 完成 + 教师闭环 |
| **V3-beta** | 覆盖率提升,多曲稳定 | 更多自动诊断 | 同上 | 500 真值/10 曲、coverage≥30%、precision≥90% |
| **V3-release** | 大部分常规段自动,散板/复杂仍复核 | 大部分常规段自动 | 同上 | coverage≥40-60%、unsupported 稳定拒绝 |
| (M3+ 音高安全) | 平拉/谱面声明技法段的中心音高 probe;谱面标记区零指控;双音 multi-f0 | 安全减少误指控 | 同上 | 独立逐音 intonation gold 连接后 precision≥90%、unsafe=0;全部标记单元实际执行且零指控;不稳证据 100% 退复核;runtime audit 独立通过 |
| (谱面 M4) | PDF/图片谱 OMR 识别入口 | 上传 PDF/拍照谱→自动识别成可判断谱 | 识别草稿+置信+人工核对 | note-level OMR 准确率达标(见 M4);不达标退人工核谱 |
| (大提琴 M5) | 弓弦家族扩展 | 同小提琴 | 同 | cello 独立 M0 + 重校准 |

**硬原则**:precision 是硬门槛(≥90% 才给学生);coverage≥20% 才能命名为 V2-alpha,之后**覆盖率是结果不是目标**(覆盖低但准也算阶段成功);fail-closed 四态。

---

## 2. 共享资产盘点(西洋弦乐复用 / 论文证据 / 冻结)

**后台 `src/server/`(✅ 多数与乐器无关,直接复用):**
| 模块 | 处理 |
|---|---|
| `teacherValidationService.js` / `teacherValidationRoutes.js` | ✅ 复用(teacher-ready gate、结构化字段、四态基础) |
| `scoreStoreSqlite.js` / `scoreStoreSupport.js` / `scoreRoutes.js` | ✅ 复用(改喂干净 MIDI/MusicXML;**停用 OMR 导入路径**) |
| `analyzerClient.js` / `analysisRoutes.js` / `taskQueue.js` / `jsonStore.js` / `baseUtils.js` | ✅ 复用 |
| `scoreLineRoles.js` / `omrStats.js` | ⚠️ 二胡/OMR 相关,弦乐第一版**不接**;**M4 谱面识别时再评估复用** |
| `researchService.js` / `researchRoutes.js` / `opsRoutes.js` | ✅ 复用(研究/运维) |

**前端(✅ 复用,改文案/乐器配置):** `TeacherValidationApp.jsx` + `src/teacherValidation/*`(ScoreLocatorPanel/SegmentAudioPlayer/atoms/utils)、`StudentApp.jsx`、`MainApp.jsx`、`PdfScoreHelper.jsx`。

**生产脚本 `scripts/*.mjs`(✅ 复用):** `build-manual-anchor-pack` / `export-manual-anchor-labels` / `slice-review-clips` / `import-teacher-validation-reviews` / `audit-teacher-validation-readiness` / `test-teacher-validation-workflow` / `build-quality-baseline` / `check-*`(p0/pwa/frontend-split/quality-baseline)。
**npm 生产入口:** `dev/server/build/start`、`analyzer:start`、`teacher:*`、`test:teacher-validation`、`check-server-p0`。

**保留数据资产:** 教师包 `manual-anchor-{fusheng,rhapsody-2,xuandong}`、导出 `technique-labeling-export/2026-06-24T10-55-04-081Z` 等二胡材料仅作为论文证据/困难案例保留;不再作为当前产品默认入口。与 `paper/ei-journal`、`paper/erhu-system-paper` 相关的数据不得删除。

**冻结/保留(不接当前产品默认入口):** 二胡 OMR/Audiveris 链路(**M4 谱面识别将重新评估复用 Audiveris,但须过 M4 精度闸门方可进判断**)、`scan-piece-segments`、长曲自动对齐实验脚本(`align-*`、`anchor_eval`、`eval_*` 二胡系列)、二胡 score store 条目。保留原因仅限两类:论文证据,或西洋弦乐主线仍依赖的共享代码/数据。

**纯实验(`scripts/experiments/*.py`,121 个 .py):** 标记为 eval-only,不进生产;弦乐线新增的 M0 脚本(`eval_western_strings_m0_{bach10,urmp,musicnet}.py`)同此类。

**裁决:后台/教师闭环/导出/前端 = 直接复用;OMR/二胡对齐 = 冻结;实验脚本 = 保留不接生产。**

---

## 3. 西洋弦乐迁移范围(in / out)
**In(第一版,谱面侧先用干净谱):** 小提琴;输入 = 音频 + **MusicXML/MIDI/dataset-score**;note 对齐 + 基础诊断 core(音准/起音/漏音);时值/extra-note 多音 review-only;四态置信门;教师复核回流。
**In(M3+ 音高指控安全):** 平拉和谱面意图揉弦/滑音区只在稳定中心证据充分时判断,并另用独立逐音 intonation gold 验证;谱面标记 tr/装饰音/泛音区零指控;高离散度输出 `insufficient_evidence`;双音 multi-f0 独立验证。**不展示技法名、不降音准标准、拿不准仍退复核**。
**In(路线内,M4 谱面侧):** PDF/图片谱面 **OMR 识别**为主入口——但**带精度闸门**:OMR→MusicXML 草稿先在带 gold 谱的数据集上验 note-level 准确率,达标才可直接喂判断;不达标退 Audiveris 草稿 + 人工核对(复用现有 m2f clean-score 流程)。**绝不让未过闸门的 OMR 谱直接进判断(坎1纪律)。**
**Out(后续):** 技法名称展示/技法质量评价、大提琴(M5)、散板/重 rubato 曲目自动判(直接 reject_unsupported)。

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
- **真实学生录音一律走单独授权与脱敏流程**:记录 consent、licenseStatus、匿名化 `studentId`、device/noise/scenario;原始音频只放本地 `data/` 或受控存储,不入仓库、不随论文发布。
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
- **API(当前):** `GET /api/strings/alignment-preview` + `POST /api/strings/alignment-preview/reviews`,仅教师后台离线预览/复核。
- **API(当前最小学生闭环):** `POST /api/strings/analyze` 读取 M2d/M2f/M3 证据并 fail-closed;只暴露 core passed categories = pitch / onset / missing。该路由也接受 clean-score `scoreId` + audio 的受控提交,默认写入离线复核队列并返回 `studentReady=false`。`GET /api/strings/controlled-submissions`、`GET /api/strings/controlled-submissions/:id/audio`、`POST /api/strings/controlled-submissions/reviews` 提供离线队列读取、试听和审核。`POST /api/strings/controlled-submissions/run-batch` 只处理 `accepted_for_batch` 项并写入 batch run 审计记录,`autoDiagnosisIssued=false`。ordinary clean-score batch 无条件使用 Basic Pitch + gap-penalty DTW dynamic-shadow;旧 `dataset/piece/recordingId` 元数据不能触发 legacy replay,旧 RF 仅作为 `authorizationIgnored=true` telemetry。服务端独立核验音频 SHA-256、当前 score payload SHA、cache identity/model/policy、候选 artifact SHA 和全部候选行;任一不一致即 fail-closed。当前 gate 是 `western-ordinary-dynamic-shadow-gate-v1-review-only`,所有结果均为 `review_required`,`studentFacing=false`,`automaticAdoptionReady=false`;因果能量否决明确为 `excluded-review-only`。`POST /api/strings/review` 记录复核回流。该实现是受控离线影子层,不是任意上传音频实时学生诊断器。
- **验收:** auto_pass precision≥90%、coverage≥20%、按曲报告、留一曲验证、无真值泄漏。

### M3 — 基础教学诊断(core:音准/起音/漏音)
- **当前 V2 core release 范围:** 音准偏差 / 起音时序 / 漏音 / 音高不稳 / 低置信警告。
- **当前 review-only:** 时值过短/过长、extra-note。两者原因不同:已生成 6 套波形注入集（`r2-01/r2-08 × 3` 种子）,共含 24 个 drag 时值目标和 30 个 extra 目标以及逐音窗口/期望标签,但尚未被任何正式评测消费,也缺真实学生逐音真值。工具就位不等于 release 证据;双音 `19/24` 是 `r2-07` double-stop recall,不是 extra-note 指标。
- **多音口径澄清:** 多音/extra-note 本身可以由人工复核判断;本轮只是复核时没有发现多音错误样本,所以当前 release gate 没有覆盖它。后续要开放自动多音反馈,应补采或构造经人工确认的 extra-note 样本,而不是把多音视为不可判定类别。
- **第一版建议阈值(必须由教师样本复验后才能 release):**
  - pitch: `abs(centsError) >= 35c` 进入 pitch issue;20-35c 默认 review hint,不直接给学生硬错。
  - onset: `abs(onsetErrorMs) >= 120ms` 进入 rhythm issue;legato/weak-onset 只给 review reason。
  - missing: 只在 M2 `auto_pass` 或教师确认的对齐范围内判定。
  - extra: 先在现有 30 个注入目标上冻结可重复量化口径并跑正式前置闸;再补经人工确认的真实 extra-note 场景。
  - duration: 先按本手册执行项 5 定义可重复量化口径并消费现有 24 个 drag 注入目标;随后补真实学生逐音真值。两步完成前保持 review-only。
- **frontend(学生端):** 高置信音诊断 + 谱面定位;低置信"需复核";reject 段明确提示。
- **验收:** note-level 反馈落到谱面位置;低置信不反馈;教师复核可用 + 回流。

### M3+ — 少退复核延伸(音高指控安全)
- **目的(2026-07-17 重定):** M3+ 发布链只回答“现有证据是否足以安全指控音准问题”,不再要求机器识别或展示揉弦、滑音、颤音、装饰音名称。旧技法检测器和粗状态分类器保留为研究证据,不再决定发布。
- **无标记平拉区:** 对齐、帧级 f0 质量与音内离散度均合格时,用稳定段 f0 中位数判断中心音高;不满足证据要求则输出 `insufficient_evidence`。
- **谱面标记区:** `tr`、装饰音和泛音区域一律中性处理,不得生成音准指控;只允许 `review_required` / `insufficient_evidence`。此规则依赖谱面划区,不依赖颤音或装饰音音频检测器。
- **谱面意图技法区:** 揉弦用稳定中心 f0 中位数判断;滑音只在目标尾段支持和中心证据均充分时判断目标音高。窗口定位、f0 质量或稳定性不足时一律不指控。谱面意图只能定义目标和保护规则,不能替代独立人工逐音 intonation gold。
- **不稳兜底:** 音内 f0 离散度超过冻结阈值时,100% 输出 `insufficient_evidence`,指控数必须为 0。
- **多声部支线不变:** 双音 double-stop 仍需 **multi-f0(多基频)** 独立验证;未通过前保持 `review_required`。
- **明确退出发布链:** 颤音/装饰音音频检测、窗边界继续调参、粗状态分类器不再作为 M3+ 发布前置;自然泛音仍不做自动音准检测。历史脚本和报告仅用于说明边界。
- **验收:** ①无标记平拉区独立音准 gold precision≥90% 且 unsafe=0;②所有纳入分母的 tr/装饰音/泛音保护单元必须实际经过策略且指控数=0,只声明不得算通过;③揉弦/滑音区必须按 recording/unit/note 连接独立逐音 intonation gold 后中心音高 precision≥90%;④不稳定样本由原始诊断独立枚举,100% 落 `insufficient_evidence` 且零指控;⑤节奏/起音继续绑定真实 M3 core 闸门,不在 M3+ 重定义;⑥物理 batch 的 gold-free runtime audit 独立通过。
- **统一 v2 离线入口:** `npm run western:m3plus-rescope-gate`,合同为 `m3plus-rescope-four-zone-v2`。它分开报告 source binding、offline probe 与 release gate;当前必须 fail-closed,不能用字段自洽的汇总 JSON 代替物理来源、运行时或授权。
- **证据口径纠正:** 平拉区冻结 12 个来源单元,8 个机器可判仅是 score-intent probe,独立逐音 gold join=`0/12`;保护区冻结总分母 14,只有 8 个 m3p holdout 单元实际经过策略,round2 另有 6 个 tr 只在人工记录中声明,不得靠删除声明缩分母。揉弦/滑音 `3/8=37.5%` 只是 score-intent center agreement/decision coverage,独立 gold join=`0/8`,agreement/precision 不可定义。另有 17 个 round2 揉弦单元只有技法执行确认而 unscored。
- **运行时分层:** `m3plus-gold-free-runtime-v1` 不得读取 `expectedBehavior`、评测 split 或人工 gold,只消费谱面标记和音频物理特征。保护标记、低有声率、高离散度、缺字段与不可信窗口一律 fail-closed。即使 runtime foundation 接线通过,全部候选仍为 `review_required`,`studentFacing=false`,`feedbackAuthorized=false`;只有物理来源 runtime audit 通过后才可继续讨论独立发布授权,学生闸门默认仍关。
- **历史执行状态(2026-07-09,旧 detector 路线):** 已新增 eval-only 清点命令 `npm run western:m3plus-pitch-modes`。全量跑通 12 条真实/准真实录音、2588 个谱面音符,输出 `data/experiments/western-strings-m3plus/m3plus-pitch-mode-inventory.csv` 与 `m3plus-pitch-mode-summary.json`;其中 1269 个音符被标为需关注的 pitch-behavior 候选(以 `slide-like`、`variable-f0` 为主)。已新增 `npm run western:m3plus-review-pack`,从 inventory 抽样生成本地人工复核包 `data/experiments/western-strings-m3plus/pitch-mode-review-pack/index.html`:共 48 条,`slide-like` / `trill-like` / `double-stop-candidate` / `ornament-candidate` / `stable` / `variable-f0` 各 8 条,并附本地短 WAV 与对应五线谱图片(`score-images/`,按 piece/page/measure/note 定位)。复核页已改为正常中文说明,提供单条"匹配且音准正确/不确定/不匹配"快捷按钮,也提供"未标全部设为匹配且正确/不确定"批量按钮;批量按钮只填未标项,不得替代听辨。第一轮 48 条与第二轮 36 条补强样本已累计导入,`npm run western:m3plus-review-status` 实测 `m3plusModeEvalReady=true`:98 reviewed / 74 scored,每类 reviewed/scored 缺口均为 0。旧 `western:m3plus-mode-eval` 曾返回 `releaseReadyModes=[slide-like,trill-like]`,`controlReadyModes=["stable"]`,但该结论只属于 first-measure 研究子集,已被 2026-07-17 音高安全重定覆盖,不再具有发布 authority。累计复核的 74 match / 19 mismatch / 5 uncertain-or-other 继续保留为旧候选定位风险证据;不得据此开启学生端或重新派发同一复核包。
- **第二轮真实对齐复验(2026-07-15):** 新增 `npm run western:round2-m3plus-eval`,用 Basic Pitch 序列 DTW 替代旧线性时间窗。项目负责人已确认 `r2-06` 实际演奏了谱面标出的 6 个颤音,其余 17 个长音使用揉弦;确认记录保存在 `docs/western-strings-round2-m3plus-human-gold.json`。实测滑音 7/12(58.3%)、颤音 0/6、揉弦 1/17(5.9%)、双音两声部完整识别 19/24(79.2%),四项均未达 90%。旧报告中的 16 个揉弦分母来自对齐器漏掉第 2 音;现已改为以谱面全集计数,未匹配音按漏检保留。新增 `npm run western:round2-m3plus-diagnostic` 后确认 12/23(`52.2%`)音符窗口不合理;即使用受控时值锚定窗口,最佳训练内单特征也仅 precision/recall=`66.7%/66.7%`,不能靠重排阈值达到 90%。旧 `releaseReadyModes` 只能解释为 first-measure 安全子集证据,不能推广到第二轮整段真实录音。当前无足够真实负例,不得靠降阈值凑 recall;所有模式继续 fail-closed。自然泛音音准检测已取消;解析器保留泛音 pitch-role 仅用于通用 MusicXML 兼容。
- **M3+ 历史补证(2026-07-15/16,旧 detector 路线已完成):** `npm run western:m3plus-supplemental-scores` 生成 `音频/m3plus-supplemental/` 四条固定音符受控任务:①C4–C5 上行 8 个纯直音负例;②8 个揉弦+8 个颤音独立正例;③8 个装饰音+8 个同音高普通音对照;④8 组滑音+8 个同目标音直音对照。四条录音已到位,并确认整体高八度;定位层固定使用 `+12` 半音。真实 CREPE 评测中 `m3p-01` 为 `8/8`,`m3p-02/03/04` 冻结结果为 `10/16`、`14/16`、`13/16`;这些结果证明旧技法 detector 未过跨后端 holdout,现仅作为负证据和 v2 rescope 的输入资产。2026-07-17 后不再要求为 detector 重录、调窗或在通过旧模式闸门后再派专业复核;学生端始终 fail-closed。`western:m3plus-rescope-gate` 是当前评测入口,但其 v2 报告在未执行保护单元和独立 intonation gold 未补齐前也没有发布 authority。
- **教师式粗状态与小节三态复验(2026-07-16):** 新增 `npm run western:m3plus-coarse-state-eval`,将三份复核包的 98 条历史窗口特征与 98 条标签完整一一连接。排除音频谱面不匹配后有 74 条、11 份录音可评估;按录音留一时,旧窗口聚合特征对 `straight/active` 均找不到同时满足 precision>=90%、recall>=80% 的操作点。`slide/trill` 各只有 5 个正例且仅覆盖 2/3 份正例录音,证据不足。粗状态保持 review-only,真实补录仍使用新版 pYIN 帧级+直音控制+holdout。小节反馈采用 `issue_detected / confirmed_clean / insufficient_evidence` 三态;未知不得改写成正确。真实波形扰动下,80% 确认阈值的 clean 小节覆盖仅 13.22%,扩展扰动仍有 3 个危险 clean 判定,故小节摘要不用于扩大自动放行。完整证据见 [western-strings-coarse-state-measure-evidence-2026-07-16.md](western-strings-coarse-state-measure-evidence-2026-07-16.md)。
- **M4 小节级相对 IOI 复验(2026-07-16):** 在 50 个 gold/draft 音高序列完全相同的单声部小节上,用 Basic Pitch 对齐音频后比较相对 IOI。默认 60% 区间覆盖门槛只得到 precision=66.67%、coverage=6%;放宽到 30% 也只有 80%/10%。加入 spectral-flux+pYIN 起音并集后默认 precision=0%、coverage=4%。后续已将有界视觉候选 oracle 从 `44/50` 补到 `49/50`,并用 `top-k=512` 实际保留 `48/50`正确候选;但 Basic Pitch 仅 `14/50` 小节有足够 IOI 证据,连续 pYIN F0 形状只有 `11/50`,两者固定 margin 与按曲留一均选择 `0/50`。其中 `33/50` 小节只是整体时值按同一比例缩放,未知速度时音频相对 IOI 理论上就不能判断拍号;必须由 P0 独立证据确定拍号。因此 `runtimeReady=false`:只保留 review/reranking 研究特征,禁止自动修改 OMR 节奏。
- **M4 P0 与自适应预处理复验(2026-07-16):** raw Audiveris 结构解析补齐了无 `shape` 的 key 与 `time-whole`,冻结 5 张照片 P0 由 `0/5` 提到 `1/5`,且保持证据冲突时 fail-closed。《北京的金山上》人工 MusicXML 独立 gold 显示 `up2` pitch P/R/F1=`87.14%/35.47%/50.41%`,修正实验对比度链后的自适应谱线间距缩放=`28.28%/16.28%/20.66%`;因三项退化,自适应变体不接生产。

### M4 — PDF/图片谱面识别(OMR,带精度闸门)
- **动机:** 让学生/教师直接传 PDF 或拍照谱,不必先有干净电子谱。**这是主线诉求,但也正是二胡翻车的坎1**,因此按 M0 同样的纪律:先在数据集上验准确率,再谈信任。
- **pipeline:** PDF/图片 → Audiveris OMR → MusicXML 草稿 → **note-level 精度评测**(对齐 gold MusicXML,报 pitch 识别正确率 / onset 正确率 / 小节级错误率 / 漏识别率)→ 达标进 score store(`scoreSource=omr`),不达标进人工核对队列(复用 m2f clean-score 流程)。
- **精度闸门(2026-07-15 独立审计口径):** 独立 render-gold 基准(32 乐章,gold=公版 MusicXML 与 Audiveris 无关)实测:干净渲染 mean pitch P=96.9%/R=93.8%,合成 scan/photo mean P/R 分别为 94.4%/89.2% 与 94.9%/88.5%,达到**研究级平均指标**。但同时满足逐谱 P≥98% 且 R≥95% 的只有 **12/32(37.5%)**,低于自动采纳要求的 90%。另用公开 Kayser Op.20 LilyPond 源谱建立 5 份真实照片独立 gold,来源 commit/许可/SHA-256 均可审计;真实照片总体 pitch P/R=`84.7%/71.5%`,严格通过 `0/5`。结论:研究基准通过,自动采纳不通过——
  - **A 层自动采纳:** 当前关闭。只有严格逐谱通过率≥90%,且至少 3 份真照片独立 gold 通过后才可讨论。
  - **B 层变体赛马+音频仲裁:** 保留为 eval-only 候选生成/失败自检原型,不得把模型间一致或与录音吻合当成独立 OMR 正确率。
  - **C 层 fail-closed 人工:** 当前真实照片生产口径。独立 gold 评测未达标、无输出、全变体打架或复调密集均退人工核谱/重拍。
  - **诊断联动:** OMR 谱未经人工核对的小节,禁用 pitch/onset/duration/missing/extra 学生硬判;只允许展示“录音与谱面此处不一致,需复核”,防止 OMR 错谱冤枉学生。
  详见 `docs/western-strings-m4-omr-independent-benchmark.md`;脚本 `scripts/experiments/eval_western_strings_m4_omr_render_gold.py`、`eval_western_strings_m4_real_jpg_omr.py`。
- **schema:** score 记录加 `scoreSource=omr`、`omrEngine`、`omrConfidence`、`omrReviewStatus`(draft/human-approved);低置信小节单独标记,判断时该小节降级 review。
- **与判断层的关系:** OMR 只解决"谱面从哪来";判断仍是音频侧 M2/M3。**谱面错 → 判断全错**,所以 OMR 闸门必须比音频闸门更严,且学生端要明示"此谱由识别得到、是否经人工核对"。
- **验收:** OMR note 准确率达标闸门通过;不达标谱 100% 走人工;`scoreSource=omr` 全链路可追溯;判断层不读取 `omrReviewStatus≠human-approved` 且未过闸门的谱。
- **多引擎统一阈值扩展审计(2026-07-16):** `npm run western:m4-consensus-tolerance-sweep` 对 Audiveris+HOMR 与 Audiveris+HOMR+Oemer 两种策略、9 个局部 onset 容差共 18 组做统一跨页评测。双引擎最好总 precision/coverage=`98.62%/45.69%`，但最差页 precision=`94.33%`；三引擎保持总 precision=`100%`，最高 coverage=`13.61%`。没有任何配置同时通过逐页 precision≥98% 与 coverage≥20%，故 `expansionCandidateFound=false`；不得按页面身份特判，也不接学生端。
- **重复同音过滤的跨域否证(2026-07-16):** 在上述 5 张 Kayser 真照片上，相邻同 MIDI 谱音转 review 可把双引擎候选提高到总 precision=`99.71%`、coverage=`43.71%`，且 5 页均过 98%/20%；但冻结规则在第一首独立 Bach 合成照片(`bwv1001_mov1`)逐页 HOMR 复验仅得 precision/coverage=`90.72%/33.08%`。`npm run western:m4-repeated-pitch-confirmation` 固化该负结果，剩余 5 首未用于调参。结论是规则域内过拟合，`candidateRejected=true`，不得接 runtime 或学生端。
- **当前执行状态(2026-07-15):** `npm run western:m4-independent-benchmark-audit` 与 `western:m4-preflight` 已将证据拆开。独立 render/scan/photo 三域达到研究报告下限,故 `m4OmrAccuracyClaimReady=true`;严格逐谱仅 12/32,真实照片独立源谱 gold 严格通过 0/5(P/R=`84.7%/71.5%`),故 `m4OmrAutomaticAdoptionReady=false`,`m4OmrAutoScoreReady=false`。5×3 预处理 sweep 中 `up2` 最好;`up3` 和 Otsu 总体退化,没有可接生产的参数改进。既有 12 条混合 benchmark 中 8 条为人工批准未改草稿、4 条为独立编辑 gold;均无需重复复核。当前 `humanTask=none`,也不能打开自动运行时。实时事实以 `npm run western:m4-preflight` 和 `npm run western:project-status` 为准。
- **运行时置信探针(2026-07-15):** `npm run western:m4-omr-confidence-probe` 只使用识别规模、页数和 Audiveris 日志等运行时可见特征,按 6 个 BWV 作品留一。LR/RF AUC=0.567/0.800;RF 最佳观察点 precision=0.80、coverage=0.156,没有达到 0.90/0.20 的安全子集。该负结果已接入独立审计,禁止用自报置信绕过逐谱精度门槛。
- **更强引擎对照(2026-07-16 更新):** `npm run western:m4-oemer-benchmark` 已在同一 5 份真实照片 source-gold 上评测 Oemer 0.1.8。`ex05` 的播放器黑边曾导致错误 3 tracks/builder 断言；仅对该明确失败采用固定行均值裁边重试后，Oemer 达到 5/5 输出。全 5 份 P/R=`71.9%/76.2%`、onset/measure=`5.4%/18.2%`,严格通过 `0/5`;同 5 份 Audiveris 为 P/R=`85.5%/72.1%`。fallback 解决崩溃和坐标缺失，但 precision/节奏结构不足，不能替换 Audiveris。模型训练时 `scikit-learn 1.2.0` 与本机 1.8.0 的兼容性已用精确 1.2.0 复跑排除。该比较保持 eval-only、`studentGateReady=false`。
- **HOMR 坐标后续:** 当前 v3 候选池不含 Oemer;Oemer 只保留为 eval 基准与坐标 sidecar 先例。HOMR 在 12 份历史池候选中赢 8 份,却只给无框音符列表。后排任务是为 HOMR 建 bbox/版面坐标适配器并制作独立人工坐标 gold;`coordinateGoldReady=false` 时不得把音符列表反馈宣称为像素定位反馈。
- **Transformer 引擎对照与闸门修正(2026-07-15 历史首跑;2026-07-17 已复验):** 首跑四舍五入值曾为 pitch P/R=`89.0%/96.2%`,onset-quarter/measure=`30.7%/79.0%`。当前权威口径是 ONNX Runtime 1.27.0 从零复验的 `88.33%/95.78%/30.03%/79.04%`,完整 score gate 仍为 `0/5`。pitch-only 假通过证明自动采纳必须同时满足 pitch precision/recall 与 onset/measure;HOMR 只获 `controlled-offline-review-only` 候选池批准。
- **同版人工 gold 与照片域复验(2026-07-17 修正):** 《北京的金山上》172 音人工 MusicXML 与三引擎输出已统一复算；HOMR 的 P/R=`98.84%/98.84%`、onset/measure=`100%/100%`。全新目录非复用重跑得到逐字节相同的 HOMR MusicXML，故该页结果可重复；但输入是已拉直、无透视和手写干扰的干净谱页图，不是原始弯曲手机照片，证据域必须标为 clean-page/scan，不能外推为照片域。冻结 5 张独立 source-gold 照片以当前 ONNX Runtime 1.27.0 fresh 重跑为 pitch P/R=`88.33%/95.78%`、onset/measure=`30.03%/79.04%`、严格 `0/5`。因此 M4 照片域仍未过关，`automaticAdoptionReady=false`,`studentGateReady=false`；只有拿原始手机照片配同版独立 gold 复测，才可计入照片域采纳样本。
- **最低成本照片扩证:** `r2-camera-photo-benchmark` 中的 8 张 PNG 已证实为 clean render,不能计相机域;单独的 8 张负责人屏拍属于 `screen-photo-of-pdf`,必须与纸拍分域。把 r2 八页打印并重新手机拍摄约需 15 分钟,构造 gold 可沿用,输入域分类通过后可把纸拍 source-gold 从 5 行扩到 13 行。Op.45 四项复核 JSON 可把同版 gold 从 1 页增至 2 页,但 HOMR 起草偏倚必须单列,不得计入 HOMR 独立采纳分母。
- **拍号/节奏尺子修正(2026-07-16):** 生产 MusicXML 导入器不再把缺失拍号静默改成 `4/4`;显式拍号才写 `meterKnown=true`,缺失时保留 `meterKnown=false` 并使节奏输出 fail-closed。内部时值统一为四分音符单位,`6/8` 小节跨度修正为 3.0;拍号漏识时允许从小节时值众数得到仅供布局/对齐的 `measureQuarterSpan`,不得据此宣称拍号已识别。独立 gold 还存在照片版与公开源谱的等价记谱差异:50 个精确音高配对小节中绝对起点一致 16 个、相对 IOI 形状一致 34 个,33 个被标记为 notation-scale confound。common-meter oracle 能覆盖 50/50,但运行时选择仍未解决;Basic Pitch 相对 IOI 排序只在 2/5 曲目安全作出选择,所以 M4 仍不接学生端。
- **Clarity-OMR 对照(2026-07-15):** `npm run western:m4-clarity-benchmark` 已在同一 5 份 source-gold 上运行官方 beam-5 管线。原样截图含播放器黑边,Stage A 在 smoke 中检出 0 个谱表;冻结的通用裁页后 5/5 输出,但 pitch P/R=`72.8%/35.5%`,onset-quarter/measure accuracy=`2.8%/10.1%`,完整严格通过 `0/5`。Clarity 不替换现有引擎,不进入学生端。
- **Clarity 监督适配闭环与停止裁决(2026-07-15):** 数据前置已从单页扩为 32/32 个 Bach movement,得到 592 个原始/296 个去重 staff-token 对,按作品划分为 train/validation/synthetic-test=`199/39/58` 条且无盲测泄漏。64-step bf16+DoRA 峰值 reserved 显存约 `1.21 GiB`,held-out teacher-forced/自回归指标均提高;随后用 Stage-A CPU、Stage-B GPU 的兼容启动器在冻结 5 张真实照片上重跑完整闸门。候选 5/5 输出,pitch P/R=`80.00%/31.44%`,onset-quarter/measure accuracy=`2.04%/6.26%`,严格通过 `0/5`;相较官方 Clarity 基线只提高 precision,其余三项退化。按“完整四指标不得退化且至少一项提升,或严格通过数增加”的预设规则,决策为 `reject-and-delete`;候选不接生产,不再靠增加训练步数追数。

### M5 — 大提琴扩展
- cello pitch range + onset/pitch 参数 + **专属误差分析** + **重新校准阈值(不复用小提琴)** + **独立 cello M0**。
- 表述:架构"配置层预留",非"同时支持"。

---

## 7. 后台 / UI / API / schema 变更汇总
- **schema:** score 加 `instrument/scoreSource/tempoKnown/tempoSource`;note finding 加 `autoDecision/confidenceScore/confidenceModelVersion/candidateSources/reviewRequiredReason/teacherOverride`。
- **API 当前新增:** `/api/strings/alignment-preview`、`/api/strings/alignment-preview/reviews`,只供教师后台离线预览。
- **API 当前最小学生闭环:** `/api/strings/analyze`、`/api/strings/review`;前者同时检查 M2d sequence support、M2f real-student gate 和 M3 core diagnosis gate,缺任一证据即 `studentReady=false` 且不返回自动诊断。clean-score + audio 受控提交已接入同一路由,只登记为 offline review intake;controlled-submission 队列支持列表、缓存音频试听、审核状态回写和 fail-closed batch audit。
- **UI:** 教师后台加"自动预测+置信+证据+改正+回流";学生端加四态展示;乐器选择。
- **feature flag:** `strings.autoFeedback`(默认关)。
- **不动:** 二胡现有后台/包/导出(冻结)。

**canonical score metadata 约定(防字段漂移):**
| 层级 | 字段 | 语义 |
|---|---|---|
| score/job 持久化 | `instrument`, `scoreSource`, `tempoKnown`, `tempoSource` | 对外/后台读取的稳定字段 |
| piecePack/section | `instrument`, `scoreSourceType`, `tempoKnown`, `tempoSource` | analyzer 内部输入/输出字段 |
| note finding | `autoDecision`, `confidenceScore`, `confidenceModelVersion`, `candidateSources`, `reviewRequiredReason`, `teacherOverride` | M2 之后新增,未接生产前不得影响学生端 |

`scoreSource` 与 `scoreSourceType` 不再新增第三套同义字段;新增 adapter 必须在测试里同时验证持久化层和 piecePack 层。

**模型产物与版本治理(防止实验结果漂移进生产):**
- 模型/阈值产物只允许放在 `models/western-strings/<modelVersion>/`,包含 `model.json`、`metrics.json`、`feature_schema.json`、`training_manifest.json`。
- `training_manifest.json` 必须记录数据集版本、gold CSV 路径、特征脚本 commit、禁用的 gold-derived 字段清单和按曲留一结果。
- 只有 `metrics.json` 证明 precision 达标、M2f 真实录音 gate 通过,对应 `confidenceModelVersion` 才能被 `/api/strings/analyze` 读取。
- 回滚策略:保留上一版 `modelVersion`;教师 preview 可显示新旧版本对照,学生端只读 release-approved 版本。

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
- **支持:** clean MusicXML/MIDI + **单声部小提琴**音频 → 输出**音准 / 起音 / 漏音 / 低置信提示**。
- **暂不开放硬反馈:** 时值 / extra-note。6 套注入集已把工具和期望标签准备好,但尚无正式消费报告与真实学生逐音真值;先冻结可重复量化口径并跑合成前置闸,再定向补真实样本。双音 recall 是独立 multi-f0 支线,不得与 extra-note 合并报告。
- **不支持:** 技巧自动判定、PDF 识谱、强 rubato / 多声部混音自动反馈、大提琴。
- **auto_pass precision≥90% 硬门槛;coverage 作结果报告**。coverage <20% 时只能保持 teacher-only preview 或受限内部 alpha,不能命名为 V2-alpha;coverage 达到 20% 后仍以 precision 和 unsafe=0 为 release 硬门槛。

**⑤ M2f 真实学生录音 release gate(学生端硬前置):**
- 最小 manifest:`data/experiments/western-strings-m2/real-student-recordings-manifest.csv`。
- 最小 results:`data/experiments/western-strings-m2/real-student-recording-results.csv`。
- 录制执行清单:`docs/western-strings-m2f-recording-checklist.md`。
- 最小样本:不少于 6 条录音、3 名学生或准学生;必须覆盖 `correct`、`wrong_pitch`、`missing_note`、`rhythm_shift`、`weak_onset`、`noisy` 六类场景。
- 每条 manifest 必须有真实音频路径、scoreId 或 score path、consent、licenseStatus、humanChecked、scenario、匿名化 `studentId`。
- 模板生成命令:`npm run western:m2f-templates`;该命令只生成 `.template.csv`,不会让 release gate 误通过。
- Manifest 预检命令:`npm run western:m2f-manifest-status`;clean-score 缺口清单命令:`npm run western:m2f-clean-score-intake`;clean-score 审核包命令:`npm run western:m2f-score-review-pack`;Audiveris 草稿命令:`npm run western:m2f-audiveris-drafts`;Audiveris 草稿预置命令:`npm run western:m2f-stage-audiveris-drafts -- --apply`;clean-score 审核状态命令:`npm run western:m2f-clean-score-review-status`;clean-score 应用命令:`npm run western:m2f-apply-clean-scores -- --apply`;状态查看命令:`npm run western:m2f-status`;Release gate 命令:`npm run western:m2f-gate`。未提供数据时应 fail-closed,输出 `studentGateReady=false`;`western:m2f-gate` 在未 ready 时必须非零退出;真实数据 precision<90% 或 unsafe target auto-pass>0 时不得开放学生端。`npm run test:western-m2f-real-recordings` 仅作为当前无真实数据状态的 fail-closed 回归测试。

**⑥ M2f results 填写 SOP(防止 manifest 有了但 results 无法落地):**
1. 运行 `npm run western:m2f-templates`,复制模板为正式 manifest;真实学生录音放在 `data/private/...` 或仓库外私有目录。local-only 私有谱面若用 `scorePath` 放在仓库内,也必须在 `data/private/...`。仓库内普通路径会被 gate 拒绝。
2. 填满 manifest 后先运行 `npm run western:m2f-clean-score-intake`,生成 `data/experiments/western-strings-m2/clean-score-intake.csv`;该表列出每条 JPG/PNG 谱图应替换到的 clean MusicXML/MXL/MIDI 路径,或需要填写的已有 `scoreId`。
3. 运行 `npm run western:m2f-score-review-pack`,打开 `data/experiments/western-strings-m2/score-review-pack/index.html`;该本地审核页把每条录音、JPG 谱图和目标 clean-score 路径放在一起,用于人工清谱/核谱。
4. 可选运行 `npm run western:m2f-audiveris-drafts`,为每张谱图生成 Audiveris `.mxl` 草稿和 `audiveris-draft-musicxml-summary.json`。草稿只能作为人工校对起点,不得未经核谱直接进入 release gate。
5. 可选运行 `npm run western:m2f-stage-audiveris-drafts -- --apply`,把可解析的 Audiveris 草稿复制到 `requiredCleanScorePath` 指向的 `.mxl` 目标并更新 intake,但不设置 `approved`。
6. 将人工核对后的 clean MusicXML/MXL/MIDI 放到 `clean-score-intake.csv` 的 `requiredCleanScorePath`,或在该表里填写已有 clean-score `scoreId`;逐行确认后将 `cleanScoreReviewStatus` 填为 `approved`;然后运行 `npm run western:m2f-clean-score-review-status`。该命令只读报告 pending/approved 状态,可在人工核谱中途反复运行。
7. `npm run western:m2f-clean-score-review-status` ready 后,运行 `npm run western:m2f-apply-clean-scores -- --apply`。该命令只在所有 clean score 真实存在且全部显式 `approved` 时才写回 manifest,缺任一项或未核谱则 fail-closed 且不改 manifest。
8. 运行 `npm run western:m2f-manifest-status`。该命令只检查录音/clean-score 清单,不要求 results 文件。通过后再运行 `npm run western:m2f-results-skeleton`,生成与 manifest `recordingId` 一一对应的 results skeleton。
9. 对每条录音用当前 teacher-only preview / `studentSafe=1` 证据跑离线复核。复核者按谱面或人工 gold 判断每个 auto-pass 音是否在 300ms 内命中,并统计:
   - `autoPassCount`: gate 放行的音符数;
   - `correctWithin300ms`: 放行且与人工/gold 目标在 300ms 内一致的音符数;
   - `unsafeTargetAutoPassCount`: 已知错误目标(错音、漏音、明显节奏偏移、弱起音目标等)被错误 auto-pass 的数量。
10. 第二人或同一教师复查异常行后再运行 `npm run western:m2f-status`;只有 status 干净后才运行 `npm run western:m2f-gate` 作为 release 阻断命令。
11. `eval_western_strings_m2f_real_recordings.py` 只校验 manifest/results 完整性和统计闸门,不会自动生成上述三列计数;计数必须来自真实 preview 输出 + 人工/gold 复核。

---

## 8. 测试与验收标准
| 阶段 | 必测命令/证据 | 通过标准 | 失败处理 |
|---|---|---|---|
| M1 clean score | `test:western-string-config`, `test:western-musicxml-import`, `test:western-midi-import`, dataset adapter 输出样本 | MusicXML/MIDI/dataset-score 统一进入 note schema;不触发 OMR/Audiveris;metadata 持久化无漂移 | 不进入 M2 生产接入 |
| M2 alignment gate | feature table + confidence gate LODO;按数据集/按曲报告 | `auto_pass` 对齐 precision≥90%;coverage 只报告;无真值泄漏;reason codes 命中正确 | 降级 `review_required`,不接学生端 |
| M2b student-like pilot | 合成错音/漏音/节奏扰动 | 合成/特征扰动不能暴露系统性误 auto_pass | 继续后台离线,不得 release |
| M2d/M2e sequence support gate | 当前音 + 邻近音的 Basic Pitch 事件序列支持;再用学生式事件扰动复验 | 基准 precision≥90%、coverage≥20%,且 correlated drift / 错音 / 漏音 / 弱起音目标 0 auto-pass | 未过则 `studentSafe=1` 全量 review |
| M2f real-student recording gate | 真实/准真实学生录音 manifest + results;覆盖正确、错音、漏音、节奏偏移、弱起音、噪声/手机录音 | 真实输入 precision≥90%, unsafe target auto-pass=0,录音/授权/场景完整 | 未过则不得开放 `/api/strings/analyze` |
| M3 diagnosis | pitch/onset/missing core 评测表;duration/extra 可选扩展 | 当前 release 只要求音准、起音、漏音分别 precision≥90% 且 unsafe=0;duration/extra 先定义量化合同并消费现有 6 套注入集,再补真实逐音真值。未通过前保持 review-only;低置信不反馈;回流可导出 | 仅显示对齐,不显示诊断 |
| M3+ pitch-safety rescope | 平拉/谱面意图中心音高 probe、独立逐音 intonation gold join、谱面标记区中性化、离散度兜底、双音独立支线 | gold 连接后的可判区 precision≥90%、unsafe=0;全部标记单元实际执行且指控=0;不稳样本 100% `insufficient_evidence`;物理 runtime audit 通过 | 任一缺口 fail-closed;旧技法检测器仅作研究证据 |
| M4 OMR gate | OMR 草稿 vs gold MusicXML note-level 评测;人工核谱状态审计 | pitch/onset/measure/漏识别达到 M4 闸门;未过闸门 100% 退人工核谱 | OMR 只作草稿,不得进入判断层 |
| 全程 | `check-server-p0` / `test:teacher-validation` / `test:western-project-gate` / `build` | eval-only 脚本不写生产;数据不进仓库;feature flag 关时学生端零自动输出;项目级 gate 必须保持 fail-closed,且 M4 自比样本不得误判为独立 gold | 阻断发布 |

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
- **要生成的表:** 各乐器对齐精度对比表、二胡置信门负结果表、(待)小提琴 V2 precision/coverage 表、(待)M3+ 技法区音准 precision 表、(待)OMR 识别准确率表。
- **目标期刊**(WOS/EI/SSCI):贡献=系统 + 能力边界对比 + 人在环数据方法;**诚实负结果是卖点之一**。

---

## 10. 时间线 / 人力 / 风险 / 停止条件
**粗工时(单人):**
| 阶段 | 估时 |
|---|---|
| M0 | ✅ 已完成 |
| M1 干净谱接入 | ✅ 已完成 |
| M2 V2 置信门 | teacher-only preview + synthetic gate + M2f 真实录音 gate 已通过;学生端开放前进入 M3 基础诊断与 API 审查 |
| M3 基础诊断 core | ✅ 已完成(pitch/onset/missing) |
| M3+ 音高指控安全延伸 | v2 离线 probe 已能复跑但证据完整性闸未过;gold-free runtime foundation 与物理 runtime audit 已完成并保持 review-only;当前仍缺 6 个保护单元的实际策略执行、平拉独立逐音 intonation gold join=`0/12`、揉弦/滑音 join=`0/8` 和独立发布授权;multi-f0 双音按需 |
| M4 PDF 谱面 OMR | 2-4 周(Audiveris 接入 + 精度评测闸门 + 人工核对闭环) |
| M5 大提琴 | 1-2 周(+独立 M0) |

**停止条件(kill criteria):**
- M2 在真实输入上 auto_pass precision <90% 且补数据/调特征仍上不去 → 降级 review-only,不给学生自动反馈。
- M3+ 在独立逐音 intonation gold 未连接、gold precision<90%、unsafe>0、存在只声明未执行的保护单元、谱面标记区出现任何指控、或高离散样本没有 100% 退 `insufficient_evidence` 时 → 保持 fail-closed。runtime foundation 也不得绕过物理 batch audit 与独立授权;双音仍按独立 multi-f0 闸门。
- M4 OMR note 准确率在数据集上达不到闸门且调参/换引擎仍上不去 → OMR 只作草稿、永久走人工核谱,不自动进判断(退回坎1前的干净谱路线)。
- M5 cello 独立 M0 不过 → cello 暂缓。
- 任何阶段:数据许可证不清 → 不公开、不进仓库。

**风险表:**
| 风险 | 缓解 |
|---|---|
| 真实学生录音比数据集难 | M2 必须在学生样本上验证,不止数据集 gold |
| 置信门覆盖率过低无产品价值 | 定"最低可上线覆盖率";auto 段须有教学价值,非只覆盖简单音 |
| 重引 OMR → 坎1 重现 | OMR 独立精度闸门(M4);未过闸门/未人工核对的谱 fail-closed 退人工;判断层只读达标或 human-approved 的谱 |
| 数据许可证 | 不进仓库、公开前核实 |
| 为减少复核而降低音准标准 | M3+ 只能通过稳定中心证据或中性化减少误指控;旧技法分类器不得强行放行;拿不准仍退复核,precision≥90% 与 unsafe=0 不动 |

---

## 附录 A. 当前状态与下一步
当前进度:
- ✅ `instrumentConfig` 已落地为 `config/western-string-instruments.json`,覆盖 violin / viola / cello;`npm run test:western-string-config` 已验证音域与 first-version flag。
- ✅ clean MusicXML 入口已支持西洋弦乐元数据透传与落盘:`instrument` / `scoreSource` / `tempoKnown` / `tempoSource`;`npm run test:western-musicxml-import`、`npm run test:server-boundaries`、`npm run test:server-p0` 已验证。
- ✅ clean MIDI 入口已补齐:`/api/erhu/scores/import-midi` → Python `/score/import-midi` → 统一 piecePack/score store;默认 `scoreSource=midi`, `tempoKnown=true`, `tempoSource=midi`;`npm run test:western-midi-import` 与 route boundary 已验证。运行该成功路径需要项目 Python 环境安装 `python-service/requirements-optional.txt` 中已声明的 `pretty_midi`。
- ✅ explicit violin part 导入不会触发二胡 melody-collapse,并保留 violin notes;旧二胡 MusicXML import / score roles 回归通过。
- ✅ dataset adapter 选择低风险统一导出路径:从 M0 artifacts 生成 `western-strings-dataset-index.{json,csv}` 与 `western-strings-gold-notes.csv`,共 14 个 piece / 2088 个 gold notes;只索引 raw 数据路径和 availability,不复制受限音频/MIDI/标签;`npm run test:western-dataset-index` 已验证 key 映射和去重。
- ✅ 西洋弦乐 clean-score 入口已加 `?mode=strings`:只允许 MusicXML/MIDI,不暴露 PDF OMR 控件;`npm run test:western-strings-entry` 以 source contract 验证 clean-score-only。
- ✅ M2 特征表第一版已完成:从 M0 per-note CSV 生成 note-level pivot 与 candidate-level 表;`label*` 字段显式标为 gold-derived,训练时禁用;`npm run test:western-alignment-features` 已验证。
- ✅ M2 置信门 eval-only 探针已完成:基于 candidate-level 表做 fail-closed 规则搜索,LODO 三折 precision 均 >0.96、coverage=1.0;`npm run test:western-confidence-gate` 已验证。注意:这只证明公开数据集/gold 条件下存在高置信子集,不等于真实学生录音 student-safe。
- ✅ M2 后台离线 preview API 已接入:`GET /api/strings/alignment-preview` 从 candidate feature table 生成 note-level `autoDecision/confidenceScore/candidateSources/evidence`;默认不返回 gold-derived label,`includeLabels=1` 仅用于离线验收;`npm run test:western-alignment-preview` 验证默认无泄漏与 precision@300ms=0.9818。
- ✅ M2 默认关闭学生自动反馈的源契约已补:`npm run test:western-feature-flags` 验证学生端/clean-score 入口不调用 `/api/strings/*` 自动诊断,服务端仅暴露离线 preview,不暴露 analyze/review 写入路由。
- ✅ M2 教师后台离线 preview 面板已接入:教师可加载前 8 条 note-level 预测证据并提交 confirm/correct/review_required,写入 ignored 的 `alignment-preview-reviews.jsonl`;仍不进入学生端、不进入质量基线。
- ✅ M2b student-like feature-level pilot 已补:`npm run test:western-m2b-pilot` 用 correlated +800ms 扰动证明当前 median-consensus preview 在一致性错误上不安全,因此 **不得开放学生端自动反馈**;只能保持 teacher-only preview。
- ✅ M2 release gate 已 fail-closed 接入 preview service:`studentSafe=1` 现在读取 M2d 序列支持证据;证据缺失或 `studentGateReady=false` 时全部降为 `review_required`,测试覆盖默认 teacher preview 与 student-safe 两种模式。
- ✅ M2c 独立音频证据探针已补:`npm run test:western-m2c-audio-support` 用 Basic Pitch 事件支持检验 correlated drift。结果:基准 precision=0.9921 / coverage=0.7864,但 +800ms 相关漂移仍有 112 个重复同音误通过(precision=0),所以单音事件支持不达标。
- ✅ M2d 序列级 Basic Pitch 支持已补:`npm run test:western-m2d-sequence-support` 要求当前音及相邻音序列都有事件支持。release 候选阈值收紧为 30ms 后,结果:基准 precision=1.0000 / coverage=0.2443,+800ms correlated drift autoPass=0。
- ✅ M2e 学生式事件扰动已补:`npm run test:western-m2e-student-events` 直接改 Basic Pitch 事件,覆盖漏音、错音、延迟 800ms、弱起音和额外杂散音。30ms 序列闸门下所有目标错误 `targetAutoPass=0`;这比 feature-only 扰动更强,但仍不是最终真实学生录音验证。
- ✅ M2d 已接入 preview service 的 `studentSafe=1` 决策级闸门:证据缺失或单条序列支持不足时 fail-closed;M2d ready 时只放行通过序列支持的 note。
- ✅ M2f 真实学生录音 release gate 已补并通过:`npm run western:m2f-gate` 校验真实录音 manifest/results、样本数、学生数、错误场景、授权、路径与结果安全性。2026-07-08 人工/gold 复核完成:12 条小提琴录音、3 个匿名学生、6 类场景各 2 条;`autoPassCount=431`,`correctWithin300ms=431`,`unsafeTargetAutoPassCount=0`,`precisionWithin300ms=1.0000`,`studentGateReady=true`。这里的 `studentGateReady` 仅是 M2f 局部历史字段,不是当前 ordinary/project runtime 开关;当前三项学生运行时仍全关。通过命令:`npm run western:m2f-status`,`npm run western:m2f-gate`,`npm run test:western-m2f-templates`。
- ✅ PDF/JPG→MusicXML 草稿路径已实测并脚本化:`npm run western:m2f-audiveris-drafts` 使用本地 Audiveris 5.10.2 console,对 M2f 谱图做 2x 预处理并批量 OMR;练习曲 5 换用高清谱图后,12/12 可生成可解析 `.mxl` 草稿。该路径仅作为人工清谱/核谱辅助,不得未经人工确认直接作为 V2 clean score release 证据。本轮 M2f 通过依据是已核实 manifest/results 与人工/gold 复核计数。
- ✅ M2d/M2e 通过/拒绝证据已映射到教师后台:Western strings preview 默认加载 `studentSafe=1`,显示 release gate 状态、source、review reason、相邻音序列 Basic Pitch 支持、method agreement 与 candidate sources,方便教师快速复核。
- ✅ M1 收口已完成: `test:western-string-config` / `test:western-musicxml-import` / `test:western-midi-import` / `test:western-dataset-index` / `test:western-strings-entry` / `test:server-boundaries` / `test:server-p0` / `test:musicxml-import` / `test:analyzer-score-roles` / `test:teacher-validation` / `build` 全部通过。

**M1 已完成。M2f 真实学生录音 gate 已通过;M3 core diagnosis gate 已通过;最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环已接入;Western strings UI 已支持 clean-score 或 review-only JPG/PNG/WebP 谱面照片 + audio 受控提交进入离线复核队列,并可试听/预览/审核队列项、运行 fail-closed batch audit。学生端仍未开放任意上传音频实时自动反馈。**

当前下一阶段步骤:
1. 以 M2f 通过结果作为 V2-alpha 学生端前置证据,保留 `real-student-recording-results.csv` 和 gate 输出作为审计依据。
2. ✅ M3a 诊断复核表与 fail-closed validator 已接入:`npm run western:m3-diagnosis-skeleton` 生成 `data/experiments/western-strings-m3/real-student-diagnosis-results.csv`;`npm run western:m3-status` / `npm run western:m3-gate` 默认评估 V2 core required categories = pitch / onset / missing。duration / extra 仍可记录,但默认 `review_only`,不阻塞当前 core gate。
3. ✅ M3b 本地复核网页已接入:`npm run western:m3-diagnosis-review-pack` 生成 `data/experiments/western-strings-m3/diagnosis-review-pack/index.html`;页面复用 M2f 音频、谱图和 auto-pass 预览,按录音聚合填写五类诊断的系统诊断数/正确数/危险误判数,支持"已填诊断全部正确"、清零、按场景预填草稿、下载 CSV。
4. ✅ M3c 第一轮人工/gold 复核已导入:12 行结果覆盖 431 个 M2f auto-pass note;`npm run western:m3-status` 和 `npm run western:m3-gate` 已通过 core gate。pitch=2/2、onset=2/2、missing=2/2,三类 precision=1.0000 且 unsafe=0,但每类仅 2 个有效错误样本,证据浓度薄;duration 与 extra status=`review_only`。
5. 后续若要开放 duration/extra-note 反馈,先冻结节奏不稳定下可重复的逐音量化合同,再让正式 V2 全曲前置闸消费现有 6 套注入集（24 drag、30 extra 目标）;机器摸底后再定向采集并签收真实学生逐音真值。之后用 `--required-categories all` 或显式 required list 重跑 gate;未通过前不得给学生硬反馈。
6. ✅ 最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环已接入,默认仍 fail-closed;离线/gated preview 只展示 core passed categories,当前不进入学生运行时输出。`test:western-alignment-preview` 覆盖 route ready/fail-closed。
7. ✅ Western strings 页面已接入 gated preview UI:只加载已验证样本,显示 allowed categories = pitch / onset / missing、review-only = duration / extra,并可写回 confirm/review。`test:western-strings-entry` 覆盖 UI hook;`test:western-feature-flags` 确认离线 preview 仍未被学生侧直接调用。
8. ✅ UI 已从“已验证样本预览”升级到真实 clean-score + audio 的受控提交流:上传音频只进入 `controlled-submissions.jsonl` 离线复核队列并返回 `studentReady=false`,不会生成学生端硬诊断。
9. ✅ 离线复核队列已接入:可列出 controlled submissions、试听缓存音频、写入 `controlled-submission-reviews.jsonl`,并把条目标为 `accepted_for_batch` / `review_required` / `reject_unsupported` / `failed`。
10. ✅ fail-closed 批处理审计执行器已升级到 ordinary dynamic-shadow:`POST /api/strings/controlled-submissions/run-batch` 只处理 `accepted_for_batch` 项,写入 `controlled-submission-batch-runs.jsonl`,并固定 `autoDiagnosisIssued=false`。每个 ordinary clean-score + audio 项都运行 Basic Pitch + gap-penalty DTW,不再因历史 `dataset/piece/recordingId` 回放旧 gated pipeline。Python 缓存按音频内容 SHA-256、模型 tree hash、推理/策略版本寻址并原子写入;服务端对同一音频独立算 SHA-256,复核 cache realpath、内部 identity、模型/策略和当前 canonical score payload。全谱约束同时验证行数、唯一连续 `noteIndex=0..N-1` 及每行 `noteId/sectionId/measureIndex/midi`;候选 artifact 自身另有 SHA-256。`npm run western:controlled-batch-candidate-audit` 默认要求物理最新 run 至少有一个 ordinary feature-review item,并重读当前 score store 与全部候选行,空/photo-only/失败 latest run 不得绿。任何 provenance/路径/哈希/逐音 identity 漂移都回退失败;正常结果也全部 `review_required`,`studentFacing=false`,`automaticAdoptionReady=false`。旧 RF、复核包和 first-measure pilot 仍可追溯,但只作 `authorizationIgnored` 历史 telemetry,不得再决定当前授权。
10a. ✅ 照片谱受控生产链已接通:浏览器只接受经文件签名验证的 JPG/PNG/WebP,照片与录音独立哈希缓存并在队列中显示;一般受控 batch 可把 `photo-score` 项分派到受管 Python 照片谱分析器,每次最多 5 条,结果写为 `photo_score_review_ready` 和独立审计日志。该链始终 `autoDiagnosisIssued=false`,`studentFacing=false`;多页 PDF 不走单页照片入口。multipart、伪造 MIME、缓存路径越界、批处理分派、审计以及桌面/移动浏览器交互均已验证。
11. 📚 普通上传候选复核输入预检曾接入并打通:`npm run western:controlled-candidate-input-status` 只读检查 M2f manifest、clean-score intake、score store、controlled submissions 和 batch 候选行。2026-07-08 的历史快照为 12/12 音频存在、12/12 clean score 已批准且文件存在、12/12 已导入 score store 并回填 `scoreId`;当时最新 run `strings-batch-mrb9twcr-ls0kkl` 生成 12 个 `offline_feature_review_ready` 项、2588 行旧 review-only 候选 artifact。该 run 与后续人工校准均只保留为 RF 路线历史,不能再称为当前最新或当前授权证据。2026-07-18 用历史 `r3-01` 做了现行 schema-3 冷/热基础设施重跑:`strings-batch-mrpytpgd-kxkws5` miss、`strings-batch-mrpyuerg-wa5yec` hit;两次均全谱 59/59、54 行 shadow selected、0 auto-pass、runtime attestation 通过,且候选行哈希完全一致。逐音 identity 加固后又完成热跑 `strings-batch-mrpzqs9h-f8fien`:59/59 行的 score/candidate identity digest 同为 `ce816a0e0bed67d72498996d8b1e59eb84f7562e08830df717dbb4a294d423ea`。M3+ v2 evaluator/source-binding 与 runtime 物理链加固后的最新热跑为 `strings-batch-mrq5lf8u-cr2dqk`,59/59 行、候选 SHA-256=`3b6390877072d1e09591bc9f13f0e22f64b0f3602617cac1f7dd9ada7d7410b4`,standalone 全 artifact 审计 0 failure。它们只证明当前实现链可复核,不计入 r3 接受性或 fresh-blind 发布证据。历史 run 可用脚本的 `--all-runs` 模式追溯,但其中旧 schema 失败是预期结果。
12. 📚 **历史人工复核口径(已完成,不得重新派发同一包):** 打开 `data/experiments/western-strings-m3/offline-feature-candidate-review/index.html`,逐条试听并看候选的预测秒/页/小节/MIDI。若候选确实对应该谱面音符且足以作为后续校准正例,标 `usable`;若候选明显错位、音高不对应、或不能作为该音符证据,标 `wrong`;若听不清、谱音位置无法确认、或只能给定性判断,标 `uncertain`。新版页面用“候选 1 / 30”作本页序号,并在卡片中写明“系统说:录音 X 秒附近可能对应第 Y 小节/MIDI Z”;原始行号只是内部编号,不用判断。导出脚本会把涉及的音频复制到复核页旁边的 `audio/` 文件夹,页面提供 `播放/暂停` 与 `跳到候选秒` 中文按钮,不必依赖浏览器原生音频小图标或后台音频接口;也提供 `一键未标=可用`、`一键未标=错误`、`一键未标=不确定` 和 `清空本页标注`。批量按钮只填未标项,不会覆盖已单独修改的候选。`usable` 与 `wrong` 才计入可评分样本;`uncertain` 只保留记录,不计入 precision/coverage 校准。该规则仅用于复现历史校准流程;现有复核、导入和后续 confidence validation 已完成,当前不再要求先做 30 条或重跑同一 gate-candidates 包。
13. ✅ 2026-07-08 普通上传候选第二轮复核已导入:最新下载的 `controlled-candidate-review.completed.csv` 为 30 条可评分样本(16 usable / 14 wrong),合并后累计 labels 为 60 条(46 usable / 14 wrong)。`npm run western:controlled-candidate-review-status` 仍返回 `candidate-review-no-rule-meets-precision`;最新 30 条单独评估的最佳规则 precision 约 0.533,不达 0.90 学生安全闸门。新增只读诊断命令 `npm run western:controlled-candidate-label-audit` 会扫描累计 labels、候选 JSON、数值阈值和分类字段,输出 `candidate-label-audit.json`;本轮发现累计样本存在小样本/批次偏差,最新 30 条在 `--min-selected 10` 下没有任何规则达到 0.90 precision。因此普通上传音频继续保持 `review_required`,不得开放学生端自动反馈。复核页已改为每条生成约 6 秒本地短音频 `clips/`、候选秒按短音频内部时间跳转,并显示对应谱面图 `score-images/`;若页面内播放器不可用,可点“打开短音频文件”直接播放 WAV。
14. ✅ 下一批复核导出已改为默认排除已标候选:`western:controlled-candidate-review-export` 会读取累计 `controlled-candidate-review-labels.csv`,自动跳过已有 `usable/wrong/uncertain` 的候选,避免重复复核。需要复现旧页面或回溯历史时才加 `--include-reviewed`。本轮 `--gate-candidates` 重导出显示:可校准候选 226 条,已标 60 条,排除后剩 196 条,当前页面抽取 30 条且与 labels 重叠为 0;短音频和谱图均已生成。
15. 📚 **历史 RF 证据:** 2026-07-09 置信模型 pilot 读取累计 60 条 `usable/wrong` 标签,按 recordingId 留一得到 RF threshold=0.7(selected=32,precision=0.9375,coverage=0.5333),随后 fresh blind validation 也已完成。该证据可解释旧路线演进,但 release-review / controlled-pilot-decision 已被 dynamic-shadow 合同 supersede,不得据此恢复 RF runtime 或生成新授权。
16. ✅ 项目级状态命令已更新到当前证据:`npm run western:project-status` 输出 `ordinaryDynamicShadow` live preflight、r3 acceptance、authorization 与历史 RF supersession,同时汇总 M3+ 和 M4。M3+ 会固定并重哈希 5 个规范 source bindings(含 evaluator),再重审物理 JSONL 尾批、同批全部 ordinary items、完整 candidate artifact、score store/identity、runtime policy、analyzer 与 rescope report;缓存 audit/release 不能掩盖物理漂移。当前三个学生运行时开关均为 false;ordinary 为 `foundationReady=true`,`r3AcceptanceReady=false`,`authorizationReady=false`,`energyVetoIncluded=false`。`npm run western:project-gate` 按设计非零退出:除 ordinary dynamic acceptance/authorization/energy 与 M4 automatic adoption 外,M3+ v2 的 runtime foundation/物理 audit 虽已通过,仍因 6 个 declared-only 保护单元、平拉独立逐音 gold join=`0/12`、揉弦/滑音 join=`0/8` 和独立授权关闭而阻断。
17. 📚 **历史 RF fresh validation:** 30 行 reviewed/scored 中 usable=27、wrong=3,旧 RF threshold=0.7 precision=0.90;后续 P1.1 也曾通过旧 monitored-pilot audit。这些工件继续可审计,但 `ordinary-monitored-pilot-audit.readyForMonitoredPilot=false`,`authorizationStatus=superseded-historical-rf-only`;旧 release flag 不得再设置。
18. ✅ **历史证据,复核已完成,不得重新派发:** 2026-07-09 threshold-pool 分层包曾在 2528 个候选中抽取 60 行 high / above-threshold / near-threshold / low 样本。该包的人工复核、导入和 `western:controlled-candidate-confidence-stratified-eval` 均已完成,结果见第 19 项;它只用于证明旧 confidence-only 规则失效,当前不再要求教师重做该包。
19. ⚠️ **历史失败,后续 P1.1 也已被 dynamic-shadow supersede:** 2026-07-09 threshold-pool 分层复核为 usable=23 / wrong=36 / uncertain=1,旧规则 selected precision=0.5556。P1.1 后来改善了旧 RF 证据,但两者都不再决定当前 pilot;当前只认版本化 dynamic-shadow acceptance 与新 authorization 合同。
20. ✅ 2026-07-09 threshold-pool 失败诊断已固化:`npm run western:controlled-candidate-confidence-threshold-diagnosis` 输出 `data/experiments/western-strings-m3/confidence-threshold-pool-review/confidence-threshold-pool-diagnosis.json`。诊断显示 selected wrong=16,其中 above-threshold=13、high=3;最佳简单规则 `predictedUsableProbability>=0.95` 只有 selected=14、usable=12、wrong=2、precision=0.857,没有任何 selected≥10 且 precision≥0.90 的简单规则。当时据此转向 context-feature 重校准;该重校准现已完成,见第 21 项。
21. 📚 **历史 P1.1:** context-feature 重校准的旧报告为 pilot precision=0.942857、validation precision=1、runtime-selected threshold-pool precision=1(12/53)。冻结 RF artifact 保留用于复现,但旧负责人批准和 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE` 均不再有效;RF 只能作为 `authorizationIgnored` telemetry。
21a. ✅ **2026-07-18 当前 ordinary 基础层:** isolated live runtime、代码锚定的 config/lock/model identity、版本化 dynamic policy、全谱行数+逐音 identity 绑定及音频/cache/model/score/candidate 全链 SHA-256 二次审计已就位。r3 接受性 schema 已先 fail-closed 固定为“live artifact verifier 未实现”;下一步先实现真实 artifact 重读/重算,再消费 `r3-02/r3-03` 生成接受性报告。随后仍需独立发布证据与 `western-ordinary-dynamic-shadow-release-v1` 授权,默认学生端保持关闭。
21b. ⛔ **当前 full-score fresh-blind 入口未实现:** 目标合同为 `ordinary-dynamic-shadow-full-score-fresh-blind-v1`;在 runner/audit 落地前,不得调用旧 `western:fresh-blind-intake-stage/status`,也不得把旧 V2-alpha first-measure 状态或工件列作当前下一步。当前 release review、decision、start preflight 已按 live 合同刷新为红,不再保留磁盘上的旧 v1 绿灯。
22. 📚 2026-07-09 M3+ 第二轮补强包历史证据:`npm run western:m3plus-review-pack-round2` 的 36 条非 control 样本已导入,累计 98 reviewed / 74 scored。旧 `western:m3plus-mode-eval` 的 first-measure slide/trill 结果只保留为研究证据;2026-07-17 rescope 已取消其发布 authority,不得据此再设计窄范围学生端 pilot。
# 2026-07-09 历史闸门状态补充(已被 2026-07-17 状态覆盖)

- P1 confidence 重校准的 30 行 context-validation 历史值为 precision=0.90 / coverage=1.0。该 RF flag/pilot 路线已 superseded,不得再设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1`;当前只认 dynamic-shadow 版本化合同。
- M3+ second-round plus first-measure candidate-quality review had been imported: 98 reviewed / 74 scored. The old per-mode eval and 24/98 non-match/uncertain rows remain historical detector/localization evidence only; the 2026-07-17 rescope supersedes the proposed first-measure slide/trill monitored pilot.
- 本补充仅用于解释历史流转;当前状态以文件顶部 2026-07-18 分支刷新和项目总 gate 为准。
# 2026-07-09 P1.1 context validation update

- The old P1 confidence recalibration blind validation failed historically. It remains evidence only and should not be reviewed again.
- P1.1 deployable context/candidate-quality validation has since been imported and passed the current precision floor.
- Student-facing ordinary-upload auto feedback remains fail-closed. This RF-era evidence cannot start a monitored pilot; a future product step requires the new dynamic-shadow acceptance and authorization contracts.

# 2026-07-09 M3+ candidate-quality review update

- M3+ localization diagnosis identified `stu02-ex05-weak_onset` as a recording-level 100% non-match source (9/9 mismatch). Candidate-quality sampling is now stricter: it only draws from recordings whose prior M3+ review rows were all audio-score matches.
- `npm run western:m3plus-review-pack-candidate-quality` now generates `data/experiments/western-strings-m3plus/pitch-mode-review-pack-candidate-quality/index.html`, restricted to first-measure rows from previously all-match recordings, with already-reviewed rows excluded. Later measures are excluded because their linear score-time windows drift.
- The generated pack has 24 rows and is for evidence collection only. M3+ pitch-behavior feedback remains review-only until the refreshed labels pass per-mode precision and localization checks.

# 2026-07-09 M3+ first-measure release-evidence history(2026-07-17 superseded)

- The first-measure candidate-quality pack was completed and imported: 98 reviewed rows, 74 scored rows, no review/scored deficits.
- The old `western:m3plus-mode-eval` result was `releaseReadyModes=["slide-like","trill-like"]`, but it only described a narrow offline first-measure detector subset.
- The 2026-07-17 independent-holdout rescope below supersedes this section. It does not authorize a slide/trill monitored pilot or default student-facing feedback, and no repeat review of the same pack is requested.

# 2026-07-17 M3+ independent-holdout supersession

- The historical first-measure review result remains useful as a diagnostic snapshot, but it no longer authorizes a monitored pilot.
- Cross-backend CREPE tiny/full + pYIN holdout now uses mode-specific physical evidence. Precision/recall is vibrato `0.60/0.75`, trill `null/0.00`, ornament `null/0.00` with insufficient reliable positives, and slide `1.00/0.75`.
- At that historical detector checkpoint, `npm run western:m3plus-monitored-pilot-audit` returned `readyForMonitoredPilot=false` and the detector-scoped release field was false. This remains failure evidence for the retired detector route. The current four-zone v2 rescope is the evaluation contract, not release authority: the gold-free runtime foundation and physical runtime audit are complete and remain review-only, while the six declared-only protected units, independent per-note intonation gold/offline zones, and independent release authorization still block release; the student runtime stays off.

# 2026-07-10 公开 Bach 语料扩展验证

- 公开专业录音现在作为主开发集与压力测试集,不是学生域发布替代品。完整报告见 `docs/western-strings-public-bach-validation.md`。
- 65 个乐章按演奏者分成 31 development / 34 unseen-performer holdout。参考起音为数据集 CQT-DTW 估计,不是人工逐音 gold。
- Parangonar + Basic Pitch holdout 对齐达到 precision@300ms=92.81%、coverage=95.08%、median=35.4ms。
- Basic Pitch 独立识别经 development 阈值冻结后,holdout precision=90.50%、recall=77.67%,只够 V2-alpha 高精度子集。
- rawv2 原始波形注入表明漏音、+2 半音错音、迟到 800ms 的严格策略在 development/holdout 均为 0 危险放行;弱音仍无法跨演奏者安全自动判。
- 产品范围据此固定:公开专业录音核心三类可作为 V2/V3 研究原型;weak-note、extra-note 和学生域默认发布继续 fail-closed。
- 2026-07-16 三阶段安全子集确认进一步提高了研究覆盖:能量模型只在 development 拟合，策略只在 development+已消耗 rank-0 选择，rank-1 去除重叠后用 4 个新演奏者一次确认。加入重复同音高谱音 `0.5` 四分音符隔离闸后，clean precision/coverage=`97.91%/36.00%`，弱音=`97.88%/35.35%`，每类 32 个合成错误目标均 0 危险放行。该结果仅说明公开专业录音+合成波形扰动的研究 gate 过线；真实学生逐音真值仍缺，`ordinaryUploadAutoFeedbackReady=false` 不变。
- 同一逐音策略升到小节单位后，对“音高确认比例 + 相对 IOI + 因果能量”做了 `192` 点 oracle 上限测试。跨 development/rank-0/fresh rank-1 全部零危险的最低 clean coverage 仅 `2.61%`；达到 20% 覆盖的最佳点累计放行 `24` 个危险小节。`measureJointEvidenceReleaseReady=false`，小节汇总只作展示摘要，不能扩大 auto-pass。
- “完美”不是开发口号。只有独立人工逐音 gold、最终盲测、alignment/recognition precision 与 coverage/recall 均至少 99% 才可讨论近乎完美;当前未达到。

# 2026-07-10 PHENICX 人工 gold 阶段

- PHENICX-Anechoic 已下载到 gitignored `data/external/`,官方字节数与 MD5 校验通过;许可限定本地非商业研究,不得重新分发。
- 数据审计已通过:4/4 作品、22 条同步小提琴分轨、2,969 个人工对齐音符,score/gold 音高序列逐行一致。
- 已显式记录 54 个零时值 score 音符和 Beethoven 1 个 150ms score onset 回退装饰音;适配器必须保留行顺序并只在内存中做单调时间归一化。
- `violin.txt` 是整个小提琴声部复音 gold;必须混合每部作品全部 violin 分轨,不得拿单分轨对整声部 gold。
- 数据前置状态为 `readyForAlignmentBenchmark=true`;详细适配与模型闸门见 `docs/western-strings-phenicx-validation.md`。
- PHENICX 适配器已完成并通过确定性复跑:`adapterReady=true`,4/4 混音、0 clipping、2,969 行映射保留、重复生成 SHA-256 一致。固定分组为 development=Mozart/Beethoven、holdout=Mahler/Bruckner。
- 人工 gold 工程闸门已通过:`parangonar-with-basic-fallback` 在 PHENICX holdout 上 coverage 1.000、median 32.9ms、p90 352.6ms、`hit@300ms=0.8834`,且两首 holdout 逐曲通过。
- 复音子组仍未过同一闸门,第一轮 holdout 也在 fallback 加入前被查看过。下一步进入 Violin Etudes/F0 时冻结该组合,只做外部确认与识别评测;不得回用 PHENICX 调参,不得开放复音/学生自动反馈。

# 2026-07-10 MUSC 识别与 Violin MIDI 弱标签阶段

- Violin Etudes Zenodo 原始文件为 restricted,未取得访问权,不得伪装为已下载数据。
- 改用 MTG 官方 MUSC 预训练模型做直接音频转写评测。固定代码 commit 与权重 SHA-256,仅 eval-only,AGPL 影响未审前不进生产。
- 默认解码在快速音中失败;development-only 48 组后处理校准选出 `onset=0.5/frame=0.4/min=60ms`。V2 development 过,V3 50ms 未过。
- 冻结后在 Oliver/Silei fresh 录音确认:单声部核心 precision@100ms=0.9142、recall@100ms=0.9396,V2 通过;50ms precision=0.8025,V3 未过。双音全部 review-only。
- 开放 Violin MIDI Dataset 已完成全量结构审计:1,006/1,021 可用、15 个隔离、约 34 小时弱标签。其不含音频且非人工 gold,只准作弱标签扩展,不准作独立 benchmark。
- 统一总审计已接入 `western:project-status` 和独立命令 `western:public-model-gate`。当前只把专业单声部识别标为 V2 candidate;`studentReleaseEligible=false`,`V3=false`,`doubleStopAutoFeedbackReady=false`,`nearPerfect=false`。
- 下一研究闸门不是继续宣称完成,而是获得一份未用于调参的新外部人工 gold 做冻结确认,并单独提升双音与 50ms 精度。未过前默认学生端保持 fail-closed。

---

## 附录 B. 完成度快照与受阻点(2026-07-17 状态刷新)

**完成度估算(百分比沿用 2026-07-13 的最后一次加权核算;闸门状态已于 2026-07-17 刷新):**
口径说明:百分比只描述工程完成度,不具有发布 authority;实时发布结论以 `western:project-status` 和 `western:project-gate` 为准。当前定位是 **ordinary dynamic-shadow review-only foundation,尚非 pilot-ready**;默认学生端 fail-closed 未开放。照片谱生产链已注册进项目状态,但 M4 自动采纳未通过,不提高默认学生发布等级。
| 条目 | 完成度 |
|---|---|
| M0 / M1 / M2(含 M2f)/ M3 core | 100%(闸门通过;**但 M3 core 每类有效错误样本仅 2 个,证据浓度薄**,扩证依赖新增含错录音) |
| M3 全量(时值/多音) | ~70%(缺样本/口径,review-only) |
| M3+ 音高指控安全 | ~70%(四区 v2 probe 可复跑但 release gate fail-closed;8 个保护单元已执行、6 个只声明;平拉独立逐音 intonation gold join=`0/12`,揉弦/滑音 join=`0/8`;17 个 round2 揉弦单元仍 unscored;gold-free runtime/物理 audit/授权分层;双音独立) |
| M4 OMR+落到谱面 | ~92%(独立 render 基准、5 份真实照片 source-gold、完整 pitch/onset/measure 闸门、谱面锚定、照片入口和离线生产链已成;Audiveris/Oemer/HOMR/Clarity 均完整严格 0/5,HOMR 还证明 pitch-only 会假通过;Bach 和 DoReMi 两次监督适配均在真照片结构指标上退化,后续只接受拍照域+结构级监督或新增外部盲测,默认运行时关闭) |
| M5 大提琴 / V3 | 0% / ~10% |

**V2-release 剩余缺口:** 旧 RF 的 4% 全曲 coverage、first-measure 结果、五批 pilot 和 `r2-08` 均只作历史证据。当前顺序是 ① 先实现会重读/重算物理来源且能拒绝伪造报告的 live artifact verifier;② 核验器通过后才用 reserve take `r3-02/r3-03` 完成 dynamic-shadow 冷/热缓存、identity/provenance、全 artifact 接受性验证;③ 另取全新录音+新曲目的独立逐音/fresh-blind 证据,不能复用旧 12 条或 r3 接受性材料;④ 建立 `western-ordinary-dynamic-shadow-release-v1` 的独立授权并重走 release/approval/decision。公开合成扰动的 clean precision/coverage=`97.91%/36.00%` 是研究正结果,但因果能量否决尚未进入冻结部署物、真实学生逐音真值仍缺,不能直接升级为 pilot 或学生发布。

**本地安全清理:** `npm run western:cleanup` 只预览;`npm run western:cleanup:apply` 仅删除旧 model-bakeoff/Oemer/HOMR/Clarity 隔离环境、废弃第三方源码、M4 smoke 调试目录、可再下载的空缓存、`dist/` 和源码树 Python 缓存。本轮被拒绝的 Clarity 候选已按实验裁决单独删除,不会把模型权重写成长期清理规则。正式 benchmark MusicXML/JSON/CSV、适配数据集/训练报告/冻结照片评测以及 `clarity-training-audit`、`clarity-train-source-audit`、`clarity-pretrained` 会保留;脚本拒绝工作区外路径和 `paper/` 目标,不删除正式数据、生产模型、音频、教师复核、private intake 或论文;执行后必须重跑 `npm run build`。

**受阻点记录:MUSC 推理"假死"(2026-07-11,已定位为环境问题,不可复现):**
- 报告症状:44s 录音推理 30–50 分钟无输出,3s 音频单帧前向亦挂,GPU 5–9%/CPU 20%。
- 主环境复验:RTX 5060(sm_120)+ torch 2.11.0+cu128(arch_list 含 sm_120),3s 音频 predict **0.4 秒**完成;真实评测命令成功新增 1 单元(device=cuda)。
- 结论:模型与主环境健康;原卡死最可能为**别的解释器/环境(旧 torch 无 sm_120 二进制 → 首次 CUDA 调用 PTX JIT 假死)**或**权重网络下载被阻断**。复跑请确认 `python -c "import torch;print(torch.cuda.get_arch_list())"` 含 sm_120。
- HF2 direct-core 最终结果(2026-07-11,20/20 完成、0 失败):P@100ms=80.3%、R@100ms=56.8%、F1=66.6%(matched 7729/13601);**V2 闸门判定为不通过**(需 P≥90/R≥85)。结论为**能力边界证据**:小提琴域训练的 MUSC 在哈丹格尔提琴外域(共鸣弦/密集双音/舞曲节奏)显著退化——与二胡线"域外退化"叙事一致,可入论文;不构成小提琴产品线阻塞。运维备注:最长单元需 batch-size≤16(8GB 显存),其余可用 128。
