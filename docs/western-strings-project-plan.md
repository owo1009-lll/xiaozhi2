# 弓弦乐器练习诊断平台 — 完整项目开发手册

> 本文是**可交付开发执行**的完整项目计划(10 章)。战略与 M0–M5 闸门详见 [western-strings-migration-plan.md](western-strings-migration-plan.md);本手册在其上补全:资产盘点、M0 SOP+结果、M1–M5 工程拆解、后台/UI/API/schema 变更、数据集许可证、版本定义、论文产出对应、时间线/人力/停止条件。
> **状态:M1 已完成并通过收口回归;M2 teacher-only preview 已接入;M2e 学生式事件扰动已通过 synthetic gate;M2f 真实学生录音 release gate 已于 2026-07-08 通过;M3 core diagnosis gate 已通过;最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环、gated preview UI、clean-score + audio 受控提交流、离线复核队列、fail-closed 批处理审计执行器已接入。** 离线/gated preview 已验证的核心类别只有 pitch / onset / missing;当前三项学生运行时开关仍全为 false,不向学生端输出这些诊断。duration 与 extra-note 仍为 review-only:6 套 drag/extra 波形注入集及逐音期望标签已经生成,但尚未被任何正式评测消费,且缺真实学生逐音真值;双音 `19/24` 是独立 double-stop recall,不得混写成 extra-note。普通 clean-score batch 当前无条件进入 Basic Pitch + gap-penalty DTW 的 dynamic-shadow 路径,输出全量候选 artifact 与审计摘要,所有候选仍为 `review_required`。旧 pYIN 线性映射、RF confidence scorer、first-measure release/approval/pilot 只保留为历史 telemetry,不再具有授权力。运行时默认且强制 fail-closed;它仍不是任意上传音频实时学生诊断器。二胡产品线已从默认产品范围移除;仅保留论文证据和西洋弦乐仍依赖的共享模块/数据。
>
> **范围变更(2026-07-09):** PDF/图片谱面 **OMR 识别**由原"Out(避免坎1)"上调为**主线路线内里程碑 M4**(详见第 3、6 章)。**判断层不变**(音高/节奏诊断仍是音频侧 M2/M3);OMR 只解决"谱面从哪来",且必须先过**note-level 精度闸门**才被信任,不达标的识别谱一律 fail-closed 退人工核对,**绝不直接进判断**——这是从二胡坎1吸取的纪律。
>
> **路线重构(2026-07-09,2026-07-17 更新):** 原"技巧识别 M4(技法名称展示)"**已删除**。M3+ 不再要求颤音/装饰音音频分类,而改为**音高指控安全**:平拉和谱面声明的揉弦/滑音只在稳定中心证据充分时判断;谱面标记的 tr/装饰音/泛音区零指控;高离散度一律 `insufficient_evidence`。**不展示技法名、不降音准标准、拿不准仍退复核**。当前 `3/8` 只是 score-intent center agreement/coverage,独立逐音 intonation gold 尚未连接,不得写成精度。双音 multi-f0 独立支线保留。里程碑重编号:**OMR = M4(提前)、大提琴 = M5(最后)**。
>
> **受控 pilot 决策包(2026-07-10,历史审批流程):** 负责人批准与五批一次性离线 pilot 是旧 RF/first-measure 事实,已显式 superseded。当前 `western:release-review` 必须生成 `schemaVersion=2`、使用 `western-ordinary-dynamic-shadow-release-v1`,并带同轮 live ordinary/M3+ evidence projection SHA;decision/preflight 会重新计算该绑定,手写或陈旧绿报告不得通过。新 approval 必须持久化并复核"独立 monitored pilot"与"默认运行时 fail-closed"两项确认。在 r3 接受性证据和两轨独立 `authorizationReady=true` 合同缺任一项时,`western:controlled-pilot-decision`、旧 approval 和旧 start preflight 都必须失败。**2026-07-19 更新:** 上述条件已全部满足——`authorizationReady` 改为从负责人常备批准文件派生(不再硬编码 false),负责人已"批"过受控试点、"认"过 fresh-blind 证据,两轨 `authorizationReady=true`,链式 rebind 后 `readyForControlledPilot=true`/`readyToStartControlledPilot=true`/`okToStartControlledPilot=true`。这只是"可启动",试点尚未实际执行;`studentGateReady` 结构性独立,仍为 `false`。
>
> **受控 pilot 机器验证已扩到 5 条独立录音(2026-07-10,r2-08 前历史状态):** 全曲口径仍不可放行:275 候选 / 33 个模型原始 auto-pass / 11 个严格候选,全曲有效 coverage=4.00%;联合 threshold sweep 证明不能靠放宽参数同时满足 precision≥90% 与 coverage≥20%。但错误高度集中在后续小节,因此新增明确的 **first-measure-only** 受控范围:只有第 1 小节且 confidence≥0.95 才可 auto-pass,其余全部 `review_required`。该范围历史留一录音为 12/12 正确、coverage=25.53%(5 条录音),真实受控 pilot 为 11/11 正确、coverage=26.83%(5 条独立录音),0 known wrong、0 unknown。runtime scope 已在显式 pilot flag 下接线并通过正反单测/临时 smoke;默认学生端仍 fail-closed。`machinePreflightPassed=true`,`teacherReviewAllowed=true` 当时只授权准备一份全新的、小型盲验包;该授权已用于后续 `r2-08`,不再表示当前仍缺待复核包。后续小节自动化仍未解决。
> **历史 Fresh blind 入场(2026-07-10,已消费且已 superseded):** 当时为旧 first-measure 路线建立的 `fresh-blind-intake-stage/status` 原子登记与审计链已经用于 `r2-08`;`readyForMachinePrecheck=true` 只说明那次旧入场合规,不授权当前 dynamic-shadow。现有 12 条录音、`r2-08` 及后续 r3 接受性材料均不能用于新的发布盲审。未来另取全新录音+新曲目时可复用“内容哈希/谱面批准/失败不替换”的输入纪律,但必须另建当前版本的 full-piece dynamic release 合同,不得直接沿用旧 intake 状态或教师包。

> **第二轮受控执行(2026-07-15):** 8/8 组新音频、MusicXML 和谱面图片已完成审计与机器分析。导入时暴露并修复了“多小节 MusicXML 被压缩到第 1 小节”的结构缺陷;结构闸门现要求候选音符数、小节数和唯一 note ID 均与源谱一致。`r2-08` 精确 fresh-blind pilot 处理 60 个候选,模型原始 auto-pass=3,但 scoped/self-checked auto-pass 均为 0,因此按 fail-closed 中止且未发布学生反馈。尚欠的只读运维尸检是逐条记录 3 个原始 auto-pass 被 scope/self-check 的哪条规则抑制;它只改进可观测性,不恢复旧 RF 授权。M3+ 新库存为 444 音符/292 review-only 候选。原始 `README-怎么用.md` 已确认 M3 场景数量为错音 5 / 漏音 5 / 拖拍 4,并已用于机器候选搜索;但 `notes.txt` 未提供具体小节,所以精确 recall/precision 仍不得计算。当前结论是“第二轮机器链路完成,发布闸门未过”,不是 V2 默认开放。
> 旧 runner 当时会从历史 session 排除已执行 `recordingId`,并以 `pilot-reused-recording` 阻断重复录音;该行为只解释历史五批和 `r2-08`。当前 runner 的旧 RF executor 已删除;2026-07-18 起两个新 pilot executor(ordinary dynamic-shadow / M3+ pitch-safety)已实现并接线,但启动仍被证据与授权位 fail-closed,上述旧参数不能启动当前 pilot。
>
> **当前分支刷新(2026-07-18):** `feature/model-bakeoff-omr-align` 已重新运行 HOMR 部署 preflight、ordinary dynamic-shadow live preflight、`western:project-status` 与 `western:project-gate`。P0 冻结 5 谱完整通过 `1/5`,谱号/调号/拍号=`3/5,2/5,2/5`;默认学生端三项运行时开关仍全关。ordinary 当前失败项(2026-07-18 更新)只剩独立授权关闭——live artifact verifier 已实现、r3 接受性已通过,因果能量否决门槛已按负责人决定(路 B)正式排除;M3+ gold-free runtime foundation/物理 audit 通过且五区证据完整(14/14 实际执行、平拉 gold join=`12/12`、揉弦/滑音 join=`8/8`),仅剩独立授权;M4 OMR 自动采纳仍未达标。HOMR v3 候选池使 12 份缓存重放的机器可用数由纯 Audiveris `3/12` 提升到 `9/12`,但所有输出仍受 P0/曲级/邻音纪律约束,`m4OmrAutoScoreReady=false` 不变。
> **HOMR v3 运维/治理边界:** 具名 AGPL-3.0/六模型审查已批准唯一范围 `controlled-offline-review-only`;稳定音频/HOMR 隔离运行时、依赖锁、离线 wheelhouse 和启动自检均已固化,本机 live preflight 三绿。preflight 与 review-record SHA-256 绑定,审批或 artifact 漂移会 fail-closed。学生端网络使用、自动采纳和再分发仍关闭;不得把受控离线部署就绪外推成默认生产发布授权。
> **公开模型 challenger 刷新(2026-07-20,2026-07-21 解释修正):** M4b 的 OLiMPiC/Zeus camera **GrandStaff** checkpoint 在冻结 5 张 source-gold 小提琴真照片的单谱表 crop 上得到 pitch P/R=`8.05%/9.14%`、onset-quarter=`0.13%`、measure=`5.43%`、严格整页=`0/5`。输出幻觉出不存在的低音谱表、低音音符和多 voice/backup 时间线，故有效结论只是“GrandStaff 模型与单行小提琴输入选型不匹配并应淘汰”，不得引用为相机 OMR 能力上限；切分实际 `4/5` 页就绪，不是主因。伴奏音频的 YourMT3+ instrument-aware challenger 在 MusicNet 未见演奏者 60 秒 holdout 达到 50ms P/R=`86.42%/70.35%`、100ms P/R=`96.30%/78.39%`，显著高于 Basic Pitch 但仍未同时通过冻结门槛；单录音 `+60ms` 调时在 holdout 恶化，已拒绝。该 checkpoint 许可未声明且有 MusicNet 训练重叠风险，只能作研究诊断。公开专业单声部 V2 继续是 research candidate；学生端资格仍必须由全新真实学生录音、逐音人工 gold、fresh-blind 验收和显式授权取得。
> **ordinary dynamic-shadow 基础层:** Basic Pitch + gap-penalty DTW 当前合同为 `western-ordinary-dynamic-shadow-candidate-v1` / `western-ordinary-dynamic-shadow-policy-v1`。独立 Python 3.11 venv 禁止 system/user site,完整包集合、requirements lock 与 Basic Pitch SavedModel tree hash 均由 live preflight 精确校验;config/lock/model 另由代码常量锚定并写入 cache/candidate attestation。ordinary 强制全谱分析;候选不仅必须与 score 音符数相等,还逐音绑定唯一连续 `noteIndex` 及 `noteId/sectionId/measureIndex/midi` identity。venv 本体不进 Git,新环境用 `npm run western:ordinary-dynamic-shadow-runtime-setup` 建立,缺失即 fail-closed。2026-07-19 更新:`foundationReady=true`,live artifact verifier 已实现并接入 status(逐产物重读重算+伪造拒绝测试),`r3AcceptanceReady=true`(r3-02/r3-03 冷/热验收通过并视为已消费),`freshBlindEvidence.ready=true`(新演奏者对原曲目的完整录音,三层分级);`authorizationReady=true`(负责人常备批准+scope-contract 精确匹配,见"授权接线"),`studentGateReady=false` 保持结构性设计关闭,与授权无关。
> **pilot executor(2026-07-18 已实现):** 旧 runner 不再默认导入 RF review-pack executor。`western-ordinary-dynamic-shadow-pilot-executor-v1`(review-only telemetry:模型 auto-pass 结构性为 0,shadow 选中数只作人工复核遥测,逐行审计 review_required)与 `western-m3plus-pitch-safety-pilot-executor-v1`(审计最新批 gold-free 证据、runtime 描述符与逐行 decision)已实现并由 `npm run test:western-pilot-executors` 覆盖(合同一致性、临时库实跑、过滤 fail-closed、artifact 篡改拒绝)。start preflight 不再因 executor 缺失阻断;启动仍被证据/授权位 fail-closed,executor 就绪不能绕过证据链。

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
- **证据口径纠正(2026-07-18 已闭合):** 平拉区冻结 12 个来源单元,独立逐音 gold join 已达 `12/12`(负责人逐单元标注);保护区冻结总分母 14,6 个 round2 tr 单元已逐单元实际经过同一策略(r2-06 全谱伪单元定位,6/6 中性、指控 0),`14/14` 实际执行,分母未缩。揉弦/滑音独立 gold join 已达 `8/8`,techniqueCenter 区按四区闸通过;旧 `0/12`、`8/14`、`0/8` 为历史口径。17 个 round2 揉弦单元仍只有技法执行确认而 unscored,不计入 gold。
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
| M3+ 音高指控安全延伸 | v2 五区离线证据完整(2026-07-18:14/14 保护单元实际执行、平拉 gold join=`12/12`、揉弦/滑音 join=`8/8`,`releaseGateReady=true`);gold-free runtime foundation 与物理 runtime audit 已完成并保持 review-only;当前仅缺独立发布授权;multi-f0 双音按需 |
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
16. ✅ 项目级状态命令已更新到当前证据:`npm run western:project-status` 输出 `ordinaryDynamicShadow` live preflight、r3 acceptance、authorization 与历史 RF supersession,同时汇总 M3+ 和 M4。M3+ 会固定并重哈希 5 个规范 source bindings(含 evaluator),再重审物理 JSONL 尾批、同批全部 ordinary items、完整 candidate artifact、score store/identity、runtime policy、analyzer 与 rescope report;缓存 audit/release 不能掩盖物理漂移。当前三个学生运行时开关均为 false(2026-07-19 授权接线未触碰这三个开关);ordinary 为 `foundationReady=true`,`liveArtifactVerifierReady=true`,`r3AcceptanceReady=true`,`freshBlindEvidence.ready=true`,`authorizationReady=true`,`causalEnergyStatus=excluded-review-only`。`npm run western:project-gate` 按设计非零退出:ordinary 轨 blocking 归零;M3+ v2 五区证据完整(14/14、gold join `12/12`/`8/8`)且 `authorizationReady=true`,仅剩结构性独立的 `m3plus-student-gate-closed`;M4 automatic adoption 仍未达标,`projectReleaseReady` 因此仍为 false。受控试点(review-only)链路已全绿可启动(`readyToStartControlledPilot=true`),尚未执行。
17. 📚 **历史 RF fresh validation:** 30 行 reviewed/scored 中 usable=27、wrong=3,旧 RF threshold=0.7 precision=0.90;后续 P1.1 也曾通过旧 monitored-pilot audit。这些工件继续可审计,但 `ordinary-monitored-pilot-audit.readyForMonitoredPilot=false`,`authorizationStatus=superseded-historical-rf-only`;旧 release flag 不得再设置。
18. ✅ **历史证据,复核已完成,不得重新派发:** 2026-07-09 threshold-pool 分层包曾在 2528 个候选中抽取 60 行 high / above-threshold / near-threshold / low 样本。该包的人工复核、导入和 `western:controlled-candidate-confidence-stratified-eval` 均已完成,结果见第 19 项;它只用于证明旧 confidence-only 规则失效,当前不再要求教师重做该包。
19. ⚠️ **历史失败,后续 P1.1 也已被 dynamic-shadow supersede:** 2026-07-09 threshold-pool 分层复核为 usable=23 / wrong=36 / uncertain=1,旧规则 selected precision=0.5556。P1.1 后来改善了旧 RF 证据,但两者都不再决定当前 pilot;当前只认版本化 dynamic-shadow acceptance 与新 authorization 合同。
20. ✅ 2026-07-09 threshold-pool 失败诊断已固化:`npm run western:controlled-candidate-confidence-threshold-diagnosis` 输出 `data/experiments/western-strings-m3/confidence-threshold-pool-review/confidence-threshold-pool-diagnosis.json`。诊断显示 selected wrong=16,其中 above-threshold=13、high=3;最佳简单规则 `predictedUsableProbability>=0.95` 只有 selected=14、usable=12、wrong=2、precision=0.857,没有任何 selected≥10 且 precision≥0.90 的简单规则。当时据此转向 context-feature 重校准;该重校准现已完成,见第 21 项。
21. 📚 **历史 P1.1:** context-feature 重校准的旧报告为 pilot precision=0.942857、validation precision=1、runtime-selected threshold-pool precision=1(12/53)。冻结 RF artifact 保留用于复现,但旧负责人批准和 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE` 均不再有效;RF 只能作为 `authorizationIgnored` telemetry。
21a. ✅ **2026-07-18 当前 ordinary 基础层:** isolated live runtime、代码锚定的 config/lock/model identity、版本化 dynamic policy、全谱行数+逐音 identity 绑定及音频/cache/model/score/candidate 全链 SHA-256 二次审计已就位。同日 live artifact verifier 已实现(逐产物重读/重算+11 项伪造拒绝测试)并接入 status;`r3-02/r3-03` 冷/热接受性报告已生成并通过,材料视为已消费。剩余仍是独立发布证据与 `western-ordinary-dynamic-shadow-release-v1` 授权,默认学生端保持关闭。
21b. ✅ **full-score fresh-blind 入口已实现(2026-07-18):** `ordinary-dynamic-shadow-full-score-fresh-blind-v1` 由 `scripts/eval-western-ordinary-fresh-blind.mjs` 实现,`npm run western:ordinary-fresh-blind-eval` 消费一位从未参与调参的新演奏者对 r2-01…r2-08(原曲目,`data/private/western-strings-round2-fresh-blind/`)的完整录音:clean-full 层(r2fb-01/08)shadow coverage 0.4925/0.7778 均过 0.2 冻结地板;technique-safety 层(r2fb-05/06/07)58 个标记区音符全部经 M3+ 中性化、0 指控,在全新音色上复验"标记区永不被冤枉";error-reference-only 层(r2fb-02/03/04,故意出错但未记录精确位置)显式标注 `groundTruthPrecision:false`,只作参考不计精度。`status` 每次构建都从磁盘重读重算(digest 绑定+7 项伪造拒绝测试),报告过期即红。**诚实边界:** 沿用原曲目、非新曲目,只够受控试点,不满足更严格的"全新录音+全新曲目"发布级要求。旧 `western:fresh-blind-intake-stage/status` 与旧 V2-alpha first-measure 状态仍不得列为当前授权入口。
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
- At that historical detector checkpoint, `npm run western:m3plus-monitored-pilot-audit` returned `readyForMonitoredPilot=false` and the detector-scoped release field was false. This remains failure evidence for the retired detector route. It no longer describes the current four-zone v2 route: the six declared-only protected units, independent per-note intonation gold joins, gold-free runtime foundation, physical runtime audit, and independent authorization were all completed by 2026-07-19. The controlled pilot is ready to start but has not run; the default student runtime remains off.

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
- 人工 gold 工程闸门已通过。2026-07-20 由 development 选出的 `parangonar-fallback-chord-onset-consensus` 只按谱面 `normalizedScoreOnset` 共享最早预测起音，不读取人工 `goldOnset`/`goldChordSize`；在 PHENICX holdout 上 coverage 1.000、median 28.3ms、p90 303.9ms、`hit@300ms=0.8978`，且两首 holdout 逐曲通过。
- 复音对齐子组现也通过同一工程门槛：coverage 1.000、median 41.5ms、p90 306.4ms、`hit@300ms=0.884`。但 holdout 在该候选提出前已经被查看，当前仍是顺序工程证据；必须冻结该组合并用新外部人工 gold 确认，且不得把“复音对齐通过”混写成“双音识别完成”或据此开放学生自动反馈。
- 独立音频识别基线也已补齐：Basic Pitch 不借谱面推理，25 组 development-only 置信度/时长组合中 0 组通过冻结门槛；选中组合在 holdout 的 100ms P/R=`93.11%/73.25%`、复音 recall=`54.8%`，50ms P/R=`77.24%/60.77%`。这证明现阶段的主要缺口是复音识别而非对齐；停止继续调同一 Basic Pitch 后处理，后续 Route B 必须评测不同复音转写架构，并仍需新外部人工 gold 冻结确认。

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
| M3+ 音高指控安全 | ~90%(四区 v2 五区证据完整,`releaseGateReady=true`:14/14 保护单元实际执行,平拉 gold join=`12/12`,揉弦/滑音 join=`8/8`;17 个 round2 揉弦单元仍 unscored 不计入 gold;gold-free runtime/物理 audit 通过;仅剩独立授权;双音独立) |
| M4 OMR+落到谱面 | ~92%(独立 render 基准、5 份真实照片 source-gold、完整 pitch/onset/measure 闸门、谱面锚定、照片入口和离线生产链已成;Audiveris/Oemer/HOMR/Clarity 均完整严格 0/5,HOMR 还证明 pitch-only 会假通过;Bach 和 DoReMi 两次监督适配均在真照片结构指标上退化,后续只接受拍照域+结构级监督或新增外部盲测,默认运行时关闭) |
| M5 大提琴 / V3 | 0% / ~10% |

**V2-release 剩余缺口(2026-07-19 更新):** 旧 RF 的 4% 全曲 coverage、first-measure 结果、五批 pilot 和 `r2-08` 均只作历史证据。① live artifact verifier(重读/重算物理来源+伪造报告拒绝)已实现;② `r3-02/r3-03` 冷/热缓存、identity/provenance、全 artifact 接受性验证已通过并视为已消费;③ `ordinary-dynamic-shadow-full-score-fresh-blind-v1` 已实现并实跑,新演奏者对原 8 首曲目的完整录音三层分级证据全绿(见 21b),但沿用旧曲目、非新曲目,只够受控试点门槛;④ `western-ordinary-dynamic-shadow-release-v1` 独立授权已完成接线并由负责人实际批准(2026-07-19,"批"+"认"),`authorizationReady` 不再硬编码,ordinary 轨 blocking 归零。**M3+ 轨同步完成同一接线**,`authorizationReady=true`,仅剩结构性独立的 `m3plus-student-gate-closed`。链式 rebind 后 `readyToStartControlledPilot=true`(受控试点可启动,尚未执行,仍是纯 review-only、不产生任何学生反馈)。若要满足更严格的发布级 fresh-blind(全新录音+全新曲目),仍需另录新曲目重复③的合同——这是当前唯一剩余的实质证据缺口,不再是授权缺口。公开合成扰动的 clean precision/coverage=`97.91%/36.00%` 是研究正结果;因果能量否决因跨域不通用无法冻结,已按 2026-07-18 负责人决定正式排除(不再作为门槛,状态锁定 `excluded-review-only`)。三个学生端运行时开关(`ordinaryUploadAutoFeedbackReady`/`m3plusAutoFeedbackReady`/`m4OmrAutoScoreReady`)均未受本次授权接线影响,仍为 `false`,开放学生端需要另一次独立、显式的负责人授权。

**本地安全清理:** `npm run western:cleanup` 只预览;`npm run western:cleanup:apply` 仅删除旧 model-bakeoff/Oemer/HOMR/Clarity 隔离环境、废弃第三方源码、M4 smoke 调试目录、可再下载的空缓存、`dist/` 和源码树 Python 缓存。本轮被拒绝的 Clarity 候选已按实验裁决单独删除,不会把模型权重写成长期清理规则。正式 benchmark MusicXML/JSON/CSV、适配数据集/训练报告/冻结照片评测以及 `clarity-training-audit`、`clarity-train-source-audit`、`clarity-pretrained` 会保留;脚本拒绝工作区外路径和 `paper/` 目标,不删除正式数据、生产模型、音频、教师复核、private intake 或论文;执行后必须重跑 `npm run build`。

**受阻点记录:MUSC 推理"假死"(2026-07-11,已定位为环境问题,不可复现):**
- 报告症状:44s 录音推理 30–50 分钟无输出,3s 音频单帧前向亦挂,GPU 5–9%/CPU 20%。
- 主环境复验:RTX 5060(sm_120)+ torch 2.11.0+cu128(arch_list 含 sm_120),3s 音频 predict **0.4 秒**完成;真实评测命令成功新增 1 单元(device=cuda)。
- 结论:模型与主环境健康;原卡死最可能为**别的解释器/环境(旧 torch 无 sm_120 二进制 → 首次 CUDA 调用 PTX JIT 假死)**或**权重网络下载被阻断**。复跑请确认 `python -c "import torch;print(torch.cuda.get_arch_list())"` 含 sm_120。
- HF2 direct-core 最终结果(2026-07-11,20/20 完成、0 失败):P@100ms=80.3%、R@100ms=56.8%、F1=66.6%(matched 7729/13601);**V2 闸门判定为不通过**(需 P≥90/R≥85)。结论为**能力边界证据**:小提琴域训练的 MUSC 在哈丹格尔提琴外域(共鸣弦/密集双音/舞曲节奏)显著退化——与二胡线"域外退化"叙事一致,可入论文;不构成小提琴产品线阻塞。运维备注:最长单元需 batch-size≤16(8GB 显存),其余可用 128。

## 附录 C. M4 双轨详细方案(2026-07-19,负责人审定方向)

> 本方案取代"路 A(全量真实照片+完整 MusicXML 标注)/ 路 B(整体换端到端模型)"二选一的旧框架。
> 结论:**近期走 M4a(支持库配准),长期走 M4b(结构专用架构 POC)**;路 A 收缩为 M4b 的定向结构标注,不单独立项。
> 状态标注:方案方向已由负责人审定。2026-07-19 负责人已分别具名签署 M4a/M4b 闸门拆分及 `projectReleaseReady` 改绑 M4a,以及 C.3.3 的 M4b POC 晋升数字冻结;记录分别见 `data/experiments/western-strings-m4a-gate-split-decision.json` 与 `data/experiments/western-strings-m4b-poc-promotion-threshold-decision.json`。两份签署互不授权,M4b 自动采纳闸仍关闭。

### C.0 裁决依据(全部为仓库内已冻结证据)

| 证据 | 数值 | 出处 |
|---|---|---|
| 真实照片域(Audiveris 侧基准,5 张 source-gold) | pitch P/R=84.71%/71.50%,onset-quarter=2.17%,measure=43.83%,严格 0/5 | `western:project-status` m4Omr.independentBenchmark |
| 真实照片域(HOMR,同 5 张,ORT 1.27.0 复验) | pitch P/R=88.33%/95.78%,onset=30.03%,measure=79.04%,严格 0/5 | `docs/evidence/western-strings-homr-sourcegold-20260717.json` |
| **同版干净页图(无透视/弯曲)** | **pitch P/R=98.84%/98.84%,onset/measure=100%/100%**(北京的金山上单页) | project-status 2026-07-17 记录 |
| onset 2.17% 的域校正 | 50 个可比小节中 33 个属"记谱尺度不同但节奏比例一致"的版本混杂伪失败 | project-status 2026-07-16 审计 |
| 两次拍照域监督适配(Bach/DoReMi) | 均在真实照片结构指标上退化,已拒绝 | route-b-clarity-adaptation-report |

**核心推断:失败主要在拍摄几何域(透视/弯曲/光照)与版本混杂,不在内容识别能力。** 同版+平整输入下现有引擎接近满分。因此:消掉几何与版本两个变量的 M4a 立即可行;真正的开放域识别(M4b)是独立的长期研究题。

### C.1 闸门拆分(2026-07-19 已签署)

- 新增两个独立闸门,替代单一 `m4OmrAutoScoreReady`:
  - `M4aSupportedEditionRegistrationReady` —— 支持库内谱页的照片配准反馈;
  - `M4bOpenWorldOmrAutomaticAdoptionReady` —— 任意照片开放域 OMR 自动采纳(维持现有全部门槛,继续关闭)。
- ✅ `projectReleaseReady` 总闸从"绑整个 M4"改绑 M4a:具名决定已按能量否决先例落入 `data/experiments/western-strings-m4a-gate-split-decision.json`。M4a 自身验收未绿前总闸仍 fail-closed;M4b 保持独立关闭且不再作为支持库产品线的必选条件。
- 纪律红线:M4a 的成功**不得**表述为"OMR 已解决"或用于给 M4b 的任何门槛放水;两闸证据互不流通。

### C.2 M4a 详细方案:支持库配准(近期产品线)

#### C.2.1 谱库定义——内置数据库,不是对用户图片做开放检索

谱库是负责人预先登记的**内置**数据库,每个"版本条目"为哈希绑定三元组:

1. 人工确认的 MusicXML(真值);
2. 标准渲染图(由该 MusicXML 经固定渲染器生成,版本锁定);
3. 坐标 sidecar(渲染图上的系统/谱表/小节框/音符框,渲染时自动生成)。

用户上传的照片**从不承担认谱职责**,只作为配准(对齐)目标。"检索"分两代:

- **v1(先做):无检索。** 用户从内置曲目列表手动选择"我拉的是哪首/哪版",系统只做"选定版本 ↔ 照片"的对齐。零检索错误面。
- **v2(可选便利):库内检索。** 以照片的视觉/结构指纹在**内置库范围内**匹配最相近谱页,自动预选、用户确认。永不联网检索,永不从零识谱。

#### C.2.2 v1 处理流程

```text
用户选曲(内置列表) + 上传照片 + 上传录音
  ├─ 1. 页面检测:找到照片中的谱页区域
  ├─ 2. 几何矫正:屏拍(主场景,平面)→ 单应变换;纸拍弯曲页 → 追加网格/TPS 矫正
  ├─ 3. 配准:矫正后照片 ↔ 库内标准渲染图(特征点 + 谱线结构对齐)
  ├─ 4. 配准质量闸(主哨兵):
  │     inlier 比率 + 逐系统小节线位置一致率 + 区域结构残差
  │     不达标 → fail-closed:supported-edition-registration-review-required
  ├─ 5. 版本一致性第二哨兵(独立信号):音频仲裁
  │     录音 ↔ 库内 MusicXML 的对齐一致率(复用已验证的 0.6 agreement 闸)
  │     一致率过低 → 疑似选错曲/错版 → fail-closed,不出反馈
  ├─ 6. 坐标反投影:库内小节框/音符框 → 变换回原照片像素坐标
  └─ 7. 诊断与呈现:判断完全走"库内 MusicXML + 录音"管线
        (即已验证的 score-anchored verdict 算法,零 OMR 参与),
        结果按反投影坐标画回用户自己的照片
```

关键性质:
- **OMR 引擎在 v1 主链路中完全缺席。** HOMR/Audiveris 至多做第三重抽查(配准通过后抽若干小节比对音高序列),不作主哨兵——弱检测器不当哨兵。
- 判断层 = 附录 21b 之后已验证的无-OMR 诊断管线(21 条真实录音验证),M4a 只是给它加"画回照片"的呈现层。
- 三条 fail-closed 出口:曲目不在库(引导走现有 MusicXML 上传流程)/ 配准质量不达标 / 音频仲裁不一致。每条出口落显式 reason,不静默降级。

#### C.2.3 登记合同(`western-m4a-supported-edition-registry-v1`)

- 每条目登记字段:pieceId、editionId、musicxmlSha256、renderSha256、coordinateSidecarSha256、渲染器版本、人工确认人+日期、licenseStatus。
- 三元组任一文件与登记哈希不符 → 该条目整体失效(复用 r3 验收/fresh-blind 的 live-artifact verifier 纪律:status 每次构建重读重算)。
- MusicXML 的"人工确认"是安全关键步骤:登记流程必须记录确认方式(自制谱=构造即真值;誊写谱=对照原版逐音核对),未确认条目不得进入可反馈集合。
- 许可:登记条目须过与现有 manifest 相同的 licenseStatus 审查;仅公版/自制内容可长期存库。

#### C.2.4 工程拆解与验收

| 步骤 | 内容 | 依赖 |
|---|---|---|
| a | 登记合同 + registry 存储 + live verifier | 复用现有 verifier 模式 |
| b | 渲染+坐标 sidecar 生成器(MusicXML→渲染图+框) | 现有 Verovio/MuseScore 渲染链;注意 stroke:currentColor 已知坑 |
| c | 页面检测+单应矫正+配准+质量闸 | OpenCV 级传统 CV,无训练 |
| d | 坐标反投影+照片标注呈现 | 复用 proto 标注绘制 |
| e | 音频仲裁哨兵接线 | 复用 0.6 agreement 闸 |
| f | 三条 fail-closed 出口+测试(含伪造/错版/低质照片拒绝) | 房规:先写拒绝测试 |

2026-07-19 工程状态:C.2a-f 已完成。`config/western-m4a-supported-edition-seeds.json` 冻结首批 3 个自制版本(r2-01/r2-06/r3-01)及 MuseScore Studio 4.7.4/150 dpi;`build:western-m4a-supported-editions` 可重复生成 MusicXML、标准 PNG 与系统/谱表/小节/音符坐标 sidecar 三元组,registry live audit 为 `validEntries=3/3`。`config/western-m4a-registration.json` 冻结 Python 3.11.9、NumPy 1.26.4、OpenCV 4.11.0.86、Pillow 12.2.0 及配准/结构/音频阈值;运行时已固化到 `data/tools/western-photo-score-audio-py311`,preflight 会拒绝包版本、路径、策略、阈值、实现或 OMR 引用漂移。主链已实现页面检测、单应/TPS、系统与小节线一致性质量闸、完整页投影可见性、0.6 音频仲裁、系统/谱表/小节/音符坐标反投影及 review-only 诊断标注;三条 fail-closed 出口均有测试。完整页投影可见性地板冻结为 0.75,用于拒绝虽能在上半页取得高质量匹配、但整页已伸出照片范围的截半页输入。`engineering-acceptance/report.json` 在本次策略/实现变更后重跑,3 个确定性透视正例全部通过,4 个模糊/半页/错渲染器版本/不在库反例全部拦截,且 67/23/59 个诊断事件均与登记音符锚点一一反投影;live verifier 重算实现、策略、registry、输入、审计和标注图 SHA-256。此报告明确为 engineering-only,**不满足**下列真实屏拍冻结验收,不得据此打开 M4a。

2026-07-19 验收执行状态:冻结合同已固化为 `config/western-m4a-real-photo-acceptance.json`,阈值精确绑定 10 张/90%/负责人逐框 100%/错版至少 5 张且 0 漏放/低质 0 漏放。10 张精确登记版本私密屏拍已完成 intake 和 live 评测:`10/10` 配准通过;现有 8 张 2026-07-17 旧渲染器/错曲真实屏拍作为独立负例为 `8/8` 拒绝、0 漏放,无需追加错版照片。每张正片派生 gaussian-blur/half-page 两类低质集后为 `20/20` 拒绝、0 漏放。overlay 曾因 OpenCV hull 形状误解发生异常,现已修复并对畸形 polygon fail-closed。负责人 review JSON 已绑定 evidence digest `5f8562ffda4df524be26b7a0afd4e470fe40823146c63539e351fe6612287f36`,10 个案例共 `189/189` 个小节框全部确认;旧签署或缺任一逐框确认仍会 fail-closed。live verifier 当前 `operationalReady=true`,`acceptanceReady=true`,`M4aSupportedEditionRegistrationReady=true`,M4a 冻结真实屏拍验收完成。

验收(冻结,达标才开 `M4aSupportedEditionRegistrationReady`):
- 屏拍域:登记版本的真实屏拍 ≥10 张,配准通过率 ≥90%,反投影小节框逐一目检正确率 100%(负责人核);
- 错版/错曲照片 ≥5 张全部被两道哨兵之一拦截(0 漏放);
- 低质量(模糊/截半页)照片全部落 fail-closed 出口,不出错误标注;
- 全链路不触碰学生端开关;输出与现有受控提交流程同级(review-only 起步)。

#### C.2.5 初始谱库目录(第一批登记清单)

谱库是**内置数据库**:全部条目由负责人预先登记,用户照片只作对齐目标,任何"检索"都只在本目录范围内进行。按真值来源分四档:

**第一档:自制练习曲(真值=构造即真,许可=自制,立即可登记)——共 17 首,是 v1 主力**

| pieceId | 曲名 | MusicXML 位置 | 备注 |
|---|---|---|---|
| r2-01 | D大调级进练习 | `data/private/western-strings-round2/r2-01.musicxml` | 有 PNG 渲染 |
| r2-02 | G大调旋律 | 同目录 r2-02 | |
| r2-03 | a小调八分音符练习 | 同目录 r2-03 | |
| r2-04 | C大调附点节奏练习 | 同目录 r2-04 | |
| r2-05 | G大调连线级进(滑音) | 同目录 r2-05 | |
| r2-06 | D大调长音与颤音 | 同目录 r2-06 | 标记区经 M3+ 中性化验证 |
| r2-07 | 空弦双音练习 | 同目录 r2-07 | ⚠️ 配准/坐标不受影响,但音频侧双音判断大量沉默(66.7% 一致率),登记可以,别期待反馈质量 |
| r2-08 | F大调小谣曲 | 同目录 r2-08 | |
| r3-01 | e小调练习曲 | `data/private/western-strings-round3/r3-01.musicxml` | |
| r3-02 | A大调练习曲 | 同目录 r3-02 | |
| r3-03 | G大调练习曲 | 同目录 r3-03 | |
| r3-04 | C大调练习曲 | 同目录 r3-04 | **登记"正确版"为真值**;`r3-04-marked`(中文标错版)只可作 display-only 附属渲染,不得作真值 |
| r3-05 | 练习曲 | 同目录 r3-05 | 同上,`r3-05-marked` display-only |
| m3p-01…04 | M3+ 补充练习曲 4 首 | `音频/m3plus-supplemental/m3p-0*.musicxml` | 含技法标记,注意 m3p 系列小节号曾有全"0"导出缺陷,登记前须复核小节编号 |

**第二档:公版乐曲(真值=公版 MusicXML,许可=公有领域,立即可登记)——进阶曲目**

- Bach 无伴奏小提琴 BWV1001–1006 共 32 个乐章,MusicXML 已在库(`data/experiments/western-strings-m4/clarity-adaptation-dataset/sources/` 及 render 基准源)。公版、干净、已被渲染基准反复使用。适合作为进阶学生曲目;登记时逐乐章建条目。

**第三档:教材誊写/照片来源(真值=人工确认,许可=local-only,登记须带许可标记)**

- violin-ex01…ex12(M2f 教材练习曲 12 首):MusicXML 已经人工批准并入 score store,来源为出版教材照片。**只能以 `licenseStatus=local-only` 登记,永不进入任何可分发库**;试点内部使用可以。
- 北京的金山上:负责人同版手工誊写、人工核准(HOMR 干净页图 100%/100% 的那份真值)。誊写质量最高,但**原曲为现代编创作品,许可待审**——登记挂起,过许可审查后再入库。

**第四档:未来新增**

- 发布级 fresh-blind 的 4 首全新曲目(拟由 AI 制谱、负责人审):创作完成即按第一档流程登记,一谱两用(fresh-blind 证据 + 谱库条目)。
- 后续任何新条目一律走 C.2.3 登记合同,未过确认+许可审查不得进入可反馈集合。

**登记优先级建议**:v1 工程验收只需覆盖第一档中的 3–5 首(建议 r2-01/r2-06/r3-01 起步:正常+技法+fresh 各一),全目录可随工程进度渐进登记,不阻塞验收。**但注意:以上仅是"启动集"(手头现成资产),不是产品谱库的全貌——产品级容量按 C.2.6 规模化计划扩充。**

#### C.2.6 谱库规模化扩充计划(公开教材练习曲 + 乐曲)

产品目标是"学生实际在练什么,库里就有什么"。启动集之外,按负责人要求把大量公开资料系统性入库。

**a) 目标曲目版图(全部为公有领域作品,按教学进阶排序)**

| 类别 | 内容 | 规模估算 |
|---|---|---|
| 初级练习曲系统 | 沃尔法特 Op.45(60首)/ Op.74;开塞 Kayser Op.20(36首) | ~130 首 |
| 中级练习曲系统 | 马扎斯 Mazas Op.36(75首);舍夫契克 Ševčík Op.1/2/8/9 选段;施拉迪克 Schradieck 第一册 | ~150 首 |
| 高级练习曲系统 | 克莱采尔 Kreutzer 42首;菲奥里洛 Fiorillo 36首;罗德 Rode 24首;顿特 Dont Op.35/37 | ~130 首 |
| 学生协奏曲/乐曲 | 塞茨 Seitz 学生协奏曲;里丁 Rieding Op.34/35;库赫勒 Küchler Op.11/15;阿科莱 Accolay a小调;维瓦尔第 a小调/G大调;巴赫 a小调/E大调协奏曲;巴赫无伴奏(已有32乐章);传统曲调(小星星变奏等) | ~60 部/乐章 |

以上作曲家均逝世超 70 年(Ševčík 1934、Küchler 1936、Seitz 1940 为最晚),**作品本身全部公版**。总量约 450–500 条目,足以覆盖主流小提琴教学线。

**b) MusicXML 获取渠道(按优先级)**

1. **开放曲谱工程(直接可用)**:OpenScore(CC0 转录)、Mutopia(公版 LilyPond/MusicXML)、KernScores/CCARH(kern 格式,music21 可转 MusicXML)。逐文件核对转录许可后直接入库。
2. **社区转录(逐文件筛)**:MuseScore 社区有大量沃尔法特/开塞/克莱采尔转录,但**逐文件查许可**——只收 CC0/明确公版标注的;默认社区许可不可再分发,不合格的不碰。
3. **OMR 辅助誊写(主力渠道,量最大)**:IMSLP 的公版扫描谱 → 现有 Audiveris/HOMR 出草稿 → 人工用现有复核工具校对 → 入库。**这正是项目已验证的"OMR 作人工誊写辅助"定位**(HOMR 批准范围 controlled-offline-review-only 完全覆盖此用途,不涉学生端网络);Op.45 No.34 同版 gold 的制作流程就是现成模板。经济账:单首练习曲草稿+校对约 10–30 分钟,450 首≈一个可分期摊销的编辑项目,不是研究难题。
4. **自制补漏**:渠道 1–3 覆盖不到的优先曲目,AI 制谱+负责人审(同 fresh-blind 新曲流程)。

**c) 规模化下的真值分级(替代"逐音人工确认"的不可扩展要求)**

每条目登记 `truthConfidence` 档位,反馈权限随档位分级:

| 档位 | 定义 | 反馈权限 |
|---|---|---|
| `construction` | 自制,构造即真 | 全功能 |
| `verified` | 人工逐音核对(OMR 誊写校对后属此档) | 全功能 |
| `curated-source` | 开放工程/合格社区转录 + 机器校验通过 + 抽查 | 允许反馈,但运行时音频仲裁一致率阈值**从 0.6 提高到 0.75**,且首次使用落 review 队列抽检 |
| `unreviewed` | 仅入目录,未过校验 | **不得**进入可反馈集合 |

机器校验(全部复用现有导入器能力):MusicXML 可解析、拍号已知且小节总时值一致、音域在小提琴范围、双音区标记。**规模化的最终安全网是使用时的音频仲裁**——库内谱若与学生录音一致率系统性偏低,该条目自动降档待查,错谱不会静默伤害学生。

**d) 许可红线(明确排除项,不得入可分发库)**

- **铃木教材**:曲目多为公版,但**铃木版本/编订受版权保护**——不得收录其编订版;同曲公版原版可另行转录。
- **现代中国小提琴作品**(梁祝、新疆之春等):仍在版权期,不可入库分发;负责人自有纸本的可比照 violin-ex 系列走 local-only。
- **MuseScore 未明确许可的社区文件**:一律不碰。
- 现代出版社的校订版练习曲(如加了指法弓法的新版):校订层可能受保护,OMR 誊写时以公版原始版本扫描件为底。

**e) 分期入库目标**

| 阶段 | 内容 | 数量目标 | 前置 |
|---|---|---|---|
| L1(随 v1 工程) | 启动集 17 首 + 沃尔法特 Op.45 第一册 | ~50 | 无,立即可做 |
| L2(试点期) | 开塞全册 + 马扎斯选段 + 学生协奏曲 6–8 部;**按试点学生实际在练的曲目优先插队** | ~200 | L1 流程跑顺 |
| L3(扩张期) | 高级练习曲系统 + 其余乐曲,补齐全版图 | ~450–500 | L2 + 编辑人力 |

入库进度不阻塞 M4a 工程验收(验收只依赖启动集 3–5 首);反过来,M4a 配准链路跑通后,每条新入库谱面自动获得渲染图+坐标框,零额外成本。

#### C.2.7 负责人教材曲目总清单(2026-07-19 提供)——逐级映射与许可筛查

负责人给出覆盖启蒙→研究生全程的教学曲目清单,作为 C.2.6 目标版图的**权威扩展**:L2/L3 曲目池以本节为准,总量目标由 ~450–500 上调至 **~600–750 条目/乐章**(新增音乐会保留曲目:协奏曲、奏鸣曲、无伴奏、炫技曲)。逐级筛查结果如下(判定:✅ 公版直接入库 / ⚠️ 按发行地区逐曲核 / ⛔ 许可红线排除 / 📚 非谱面资料,超出谱库范畴):

**启蒙**

- ✅ 霍曼 1–2 册、沃尔法特 Op.45、赫利美利音阶、《小星星变奏曲》(公版原曲自制编配)、戈塞克《加沃特舞曲》、巴赫《小步舞曲》、韦伯《狩猎者合唱》
- ⛔ 铃木 1–3 册、篠崎 1–2 册、张世祥《初学小提琴100天》《新编小提琴基础教程》——教材编订版权(C.2.6d 红线);其中公版曲目可另行以原版转录入库,不得用其编订版

**初级(考级 1–4)**

- ✅ 沃尔法特 Op.45 全、开塞 Op.20、马扎斯 Op.36 一册、顿特 Op.37、施拉迪克一册、舍夫契克 Op.1/2/8、里丁 Op.24/34/35、库赫勒 Op.12/15、赛茨学生协奏曲 2/3/5、德沃夏克《幽默曲》、埃尔加《爱的礼赞》、托赛里《小夜曲》、德里戈《小夜曲》
- ⛔ 《新春乐》《丰收渔歌》——现代中国作品(在版权期;负责人自有纸本可走 local-only 通道,不入分发库)

**中级(考级 5–8)**

- ✅ 克莱采尔 42 首、马扎斯 Op.36 二册、菲奥利罗 36 首、弗莱什《音阶体系》(Flesch 1944 卒,已公版)、舍夫契克 Op.1 二三册/Op.9/Op.2、施拉迪克二三册、阿科莱 a 小调、维瓦尔迪(a 小调/g 小调/双小提琴)、巴赫 BWV1041–1043、海顿 G 大调、维奥蒂 22/23、罗德第 7、克莱采尔第 13、德·贝里奥第 9、亨德尔奏鸣曲 6 首、科雷利《福利亚》、莫扎特 K.301/304/376、巴赫小提琴与羽管键琴奏鸣曲、巴赫无伴奏选段(BWV1002 等)、马斯涅《沉思》、蒙蒂《查尔达什》
- ⚠️ 克莱斯勒小品(《爱的忧伤》《爱的喜悦》《美丽的罗斯玛琳》《维也纳随想曲》)——Kreisler 1962 卒:中国大陆(著作权法五十年)已公版,EU(七十年)2033 年前未过期;按发行范围=中国大陆评估,逐曲记录依据后入库
- ⛔ 《新疆之春》《渔舟唱晚》(黎国荃编曲版)《思乡曲》《牧歌》——现代中国作品/编曲版权

**高级(考级 9–10 以上)**

- ✅ 罗德 24 首随想曲、顿特 Op.35、加维尼耶 24 首、维尼亚夫斯基 Op.10/Op.18 及第二协奏曲、帕格尼尼 24 首随想曲/《钟》/《威尼斯狂欢节》、布鲁赫 Op.26、门德尔松 Op.64、莫扎特 K.216/218/219、拉罗《西班牙交响曲》、圣桑第三及《引子与回旋随想曲》、萨拉萨蒂(《流浪者之歌》《卡门幻想曲》《引子与塔兰泰拉》《安达卢西亚浪漫曲》)、拉威尔《茨冈》(Ravel 1937 卒,已公版)、巴赫无伴奏全套 BWV1001–1006、弗莱什全套双音
- ⛔ 《梁祝》《阳光照耀着塔什库尔干》《苗岭的早晨》《夏夜》——现代中国作品(C.2.6d 红线明确项)
- 📚 加拉米安《当代小提琴演奏技法》——现代教学著作,非公版谱面

**艺考 / 本科 / 研究生(音乐会保留曲目层)**

- ✅ 贝多芬 Op.61 及奏鸣曲 10 首、勃拉姆斯 Op.77 及奏鸣曲三首、柴科夫斯基 Op.35、德沃夏克 Op.53、格拉祖诺夫 Op.82(Glazunov 1936 卒)、弗兰克 A 大调、格里格 Op.45、德彪西 g 小调、拉威尔 G 大调、舒伯特奏鸣曲、理查·施特劳斯 Op.18(R. Strauss 1949 卒,2020 起公版)、恩斯特 6 首复调练习曲、伊萨伊 Op.27(Ysaÿe 1931 卒)、贝尔格《纪念一位天使》(Berg 1935 卒)
- ⚠️ 西贝柳斯 Op.47(1957 卒)、普罗科菲耶夫(1953 卒)第 1/2 协奏曲及 Op.80/94a、巴托克第 2 协奏曲及 Sz.117(1945 卒)、肖斯塔科维奇第 1 Op.77(1975 卒)、欣德米特(1963 卒)、科恩戈尔德 D 大调(1957 卒)、沃恩·威廉斯《云雀高飞》(1958 卒)——中国大陆多已公版,EU/US 期限各异(US 按出版年最长至 2040 年代);一律按发行地区逐曲核,记录依据后方可入库
- ⛔ 巴伯协奏曲(Barber 1981 卒)、施尼特凯、利盖蒂、古拜杜丽娜、潘德列茨基、梅西安《世界末日四重奏》、谭盾/陈其钢/盛宗亮作品——仍在版权期
- 📚 西蒙·费舍尔《Basics》《Practice》《The Violin Lesson》《Scales》、Gingold《管弦乐队小提琴片段集》(编选版权)、全部理论文献(弗莱什《小提琴演奏艺术》、加拉米安、奥尔、利奥波德·莫扎特、Stowell、Gerle、赵惟俭、杨宝智、韩里、王振山、张蓓荔/杨宝智)——著作/编选物或纯文字文献,不属谱库对象;利奥波德·莫扎特原著虽公版,亦非可登记谱面
- 室内乐(弦乐四重奏、钢琴四重奏/五重奏)与乐队片段:作品公版,但多声部总谱超出 v1"单行小提琴谱"登记合同,列为 L3 后置扩展,入库前需扩展登记合同定义

**执行纪律(补充 C.2.6,不改动其规则)**

1. ⚠️ 档条目入库前必须在登记记录里写明许可依据(作曲家卒年 + 发行地区 + 结论),缺依据按 ⛔ 处理;库的发行范围当前按中国大陆评估。
2. 双音/复调条目(弗莱什双音、巴赫赋格/恰空、帕格尼尼、伊萨伊等)**谱面登记不受限**(M4a 配准/显示照常),但音频侧自动诊断受 basic-pitch 单音偏置限制——此类条目的反馈权限固定为 review-only,直至复音证据链另行建立;登记时打 `polyphonic` 标记。
3. 层级映射:启蒙/初级 → L1/L2;中级 → L2/L3;高级/艺考/本科/研究生 → L3 后段,仍按"试点学生实际在练的曲目优先插队"排期,不为清单完整性倒排工期。
4. 理论文献(📚)可另建产品侧参考书目,与谱库数据结构无关,本计划不承载。

### C.3 M4b 详细方案:结构专用架构 POC(长期研究线)

#### C.3.1 四层架构

1. **拍照规范化层**:页面边界/透视/弯曲/阴影/模糊/屏幕黑边;独立前置模块(DocTr 一类证明几何展开可与语义解耦)。屏拍域大多可由 M4a 的传统矫正覆盖,本层主攻纸拍弯曲页。
2. **结构视觉层**:只预测显式结构证据——谱线、谱表/系统、小节线(含双线/终止线/反复线)、拍号区域、小节候选框。分割或线段检测网络皆可,核心是输出可审计的结构而非 token 序列。
3. **结构图与规则解码**:page→system→staff→barline/measure/note-candidates 图;确定性约束(小节线 x 递增、拍号与小节总时值一致、跨谱表连接合法、反复线不拆成空小节);冲突 → `structure-review-required`,永不猜。
4. **内容识别层**:HOMR 高召回音高候选 + Audiveris/Oemer 补充证据;结构层决定音符归属小节;多引擎只做复核交集。SMT 类端到端模型仅作 shadow benchmark challenger,不入生产候选池。

#### C.3.2 数据方案(路 A 的收缩形态)

- **合成为主**:现有 MusicXML/渲染链自动产生全部结构标签,叠加透视/弯曲/阴影/模糊/JPEG/背景/手写干扰。Camera-PrIMuS 的 87,678 个单声部 incipit 也是由 GraphicsMagick 对渲染 PNG 做滤镜序列得到的**合成退化**,不是真机拍摄集,且没有可直接用于本项目的公开预训练权重;这里只借其“大规模多滤镜合成可提升鲁棒性”的方法,不能拿它替代摩尔纹/手机 ISP/纸张非刚性形变等真实照片证据。
- **真实为辅**:第一阶段 100–300 张手机照片,只标结构(页四角/系统/小节线类型/小节框/拍号/是否同版/是否可判)。few-shot 布局分析证据支持 20–39% 标注量即接近全量表现。
- **M4a 作为免费数据引擎(本方案新增)**:每张配准成功的照片,把库内结构框反投影 = 零人工的真实照片结构标签;配准失败照片进主动学习难例池。先跑 M4a 再启 M4b 标注,实际人工量预计远低于 300 张。
- **冻结集**:现有 5 张 source-gold 照片永不入训练;8 张屏拍照片显式分配(默认隔离入测试);另建 ≥30–50 张按曲目版本/设备/拍摄批次隔离的 fresh-blind 集。MUSCIMA++ 只借"记谱图"形式化(手写域数据不可直接用)。

2026-07-19 数据工程状态:合成优先管线已实现并冻结为 `western-m4b-structure-dataset-policy-v1`。当前从 3 个 M4a registry 真值页确定性生成 60 张相机退化页,每张同时带 pageCorners、系统、谱表/五线、小节线及类型、小节框、拍号区域标签,退化覆盖透视、正弦曲率、阴影、模糊、JPEG、背景与手写干扰;拆分固定为 train/calibration/synthetic-test=`36/12/12`。live verifier 重算全部 60 对图片/标签 SHA-256。现有 5 张 source-gold 与 8 张屏拍已逐文件冻结为 test-only 且 `trainingEligible=false`;fresh-blind 也由同一规则禁止训练泄漏。M4a 验收成功照片将进入 auto-labeled 候选,失败照片只进 active-learning review pool;当前两者均为 0,未伪造真实训练数据。真实结构标签目标仍为 `0/100–300`,fresh-blind 仍为 `0/30`、`0/6` 版式、`0/3` 设备。浏览器结构标注器位于 `docs/m4b-structure-labeler/index.html`,fresh intake 会逐文件绑定照片 SHA、标签、曲目/版式、设备和拍摄批次,并拒绝任何与合成/冻结测试照片复用的字节。

2026-07-19 结构 POC 工程状态:四层链路已实现为 `western-m4b-explicit-structure-poc-policy-v1`。归一化层复用 M4a 页面检测/单应并追加三次多项式页边弯曲展平;结构层显式输出五线谱线、谱表/系统、小节线、小节框和拍号区域;解码层对谱表基数、小节线顺序/间距、拍号-时值和跨谱表合法性做确定性检查，冲突一律 `structure-review-required`;内容层仅将带坐标的 HOMR/Audiveris/Oemer 候选归属到结构小节，至少两引擎一致才保留，且固定 `shadowOnly=true`、`productionCandidatePool=false`、`studentFacing=false`。

已按冻结 synthetic-test 拆分独立评测 12 张合成相机退化页:224 个小节框的 P/R/F1 均为 1.000，系统数+逐系统小节数完全正确为 12/12，拍号区域 F1=1.000，12 页拍号-时值冲突注入全部落 `structure-review-required`。`audit:western-m4b-structure-poc` 会重算汇总指标、重读每页 result/overlay/原图哈希，并强制合成报告不得把 `promotionReady` 改绿。**诚实边界:** 证据类固定为 `synthetic-engineering-only`;这 12 页只来自 3 个登记自制版本，拍号区域仍使用 calibration 拆分定出的归一化页面几何先验，因此满分只证明工程链与合成域可用，不证明开放域泛化。当前 `engineeringReady=true`、`promotionOperationalReady=true`、`promotionReady=false`;唯一晋升评测只读下节签署后的 fresh-blind 输入。C.3.2 的 100–300 张真实标注是 POC 过门后扩大投入的数据目标，不是 C.3.3 的循环前置条件。

#### C.3.3 晋升门槛(✅ 2026-07-19 已签署冻结,不得因结果回调)

POC → 扩大投入的前提,在 fresh-blind 集(≥30 张,≥6 曲目/版式,≥3 设备)上**全部**满足:

- 小节框检测 F1 ≥ 0.95(基线:HOMR measure 79.04%/Audiveris 43.83%);
- 逐页结构判定(系统数/小节数完全正确的页比例)≥ 80%;
- 结构冲突页 100% 落 `structure-review-required`(0 静默猜测);
- 拍号区域检出 F1 ≥ 0.95。

未全达标 → 不扩大为数据项目,M4b 维持研究状态,M4a 独立继续服务产品。

当前执行状态:`eval:western-m4b-fresh-blind-promotion` 和其 live audit 已就位，会逐照片重算 SHA-256/标注绑定/保护集泄漏、上述四项指标及冲突注入，且即使通过也只能产生 `expandedInvestmentOnly=true`。fresh-blind intake 尚未存在，计数为 0/30 页、0/6 曲目/版式、0/3 设备，所以当前正确结论是“晋升评测工具完成、评测输入缺失”，不是“门槛已过”。

该输入的可执行交付面也已完成:`docs/m4b-fresh-blind-capture-pack/index.html` 固定 6 个盲测版式槽×6 个拍摄姿态=36 个不可覆盖槽位，用 3 台物理设备交叉拍摄，并提供元数据/任务表下载及结构标注器入口。`npm run western:m4b-fresh-blind-intake -- --from "<capture-dir>"` 会对版式源 SHA-256、实体设备 ID、照片签名、标注完整性、照片-标注-批次绑定和阈值决定哈希做现场复核，只写 `fresh-blind-test-only/trainingEligible=false` 记录。已入库字节如果不同会拒绝，不允许用“重拍替换失败样本”改变冻结测试集。

### C.4 决策清单(等待负责人)

| # | 决定 | 状态 |
|---|---|---|
| 1 | 闸门拆分 M4a/M4b + `projectReleaseReady` 改绑 M4a | ✅ 2026-07-19 已签署并接线 |
| 2 | C.3.3 晋升门槛数字冻结 | ✅ 2026-07-19 已签署并接入现场验签 |
| 3 | M4a v1 工程与冻结真实屏拍验收 | ✅ C.2a-f、10 张正片、8 张错版、20 张低质及 189/189 逐框签署全部完成 |

附录 C 全量 live audit 由 `npm run audit:western-appendix-c` 执行，并由 `test:western-appendix-c` 覆盖两类伪造:把 C.3.2 的 100–300 张扩张数据目标重新塞回 C.3.3 POC 晋升前置，以及在缺 fresh-blind 证据时打开 M4b 自动采纳。当前审计结果为 `engineeringComplete=true`、`appendixAcceptanceComplete=false`:M4a 工程与冻结验收均已完成;剩余 acceptance false 只对应 M4b fresh-blind 拍摄/结构标注外部输入。
