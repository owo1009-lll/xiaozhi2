# 弓弦乐器练习诊断平台 — 完整项目开发手册

> 本文是**可交付开发执行**的完整项目计划(10 章)。战略与 M0–M5 闸门详见 [western-strings-migration-plan.md](western-strings-migration-plan.md);本手册在其上补全:资产盘点、M0 SOP+结果、M1–M5 工程拆解、后台/UI/API/schema 变更、数据集许可证、版本定义、论文产出对应、时间线/人力/停止条件。
> **状态:M1 已完成并通过收口回归;M2 teacher-only preview 已接入;M2e 学生式事件扰动已通过 synthetic gate;M2f 真实学生录音 release gate 已于 2026-07-08 通过;M3 core diagnosis gate 已通过;最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环、gated preview UI、clean-score + audio 受控提交流、离线复核队列、fail-closed 批处理审计执行器已接入。** 当前 V2 只放行 pitch / onset / missing 三类核心诊断;duration 因节奏不稳定暂不可稳定量化,extra-note/多音可判断但本轮复核未出现样本,两者均暂列 review-only,不得给学生硬反馈。当前 UI 可展示已验证样本的核心诊断预览,也可接收 clean-score + audio 进入离线复核队列,支持试听、审核为批处理候选、生成批处理审计记录;普通上传音频的 batch 已可产出 pYIN 线性谱面完整候选特征表 artifact(同时保留 preview),并已从 `western-offline-feature-gate-v0-review-only` 进入 RF confidence runtime scorer 阶段。当前普通上传 RF scorer 只允许 candidate-evidence auto-pass,不对 pitch/onset/missing/duration/extra 诊断直接放行;fresh blind validation、threshold-pool runtime-policy audit 与 precision precheck 均已通过当前受控 pilot 证据。运行时默认仍 fail-closed:无 release flag、验证缺失、precheck 失败或 scorer 失败时全部回退 review_required。它仍不是默认开启的任意上传音频实时诊断器。二胡产品线已从默认产品范围移除;仅保留论文证据和西洋弦乐仍依赖的共享模块/数据。
>
> **范围变更(2026-07-09):** PDF/图片谱面 **OMR 识别**由原"Out(避免坎1)"上调为**主线路线内里程碑 M4**(详见第 3、6 章)。**判断层不变**(音高/节奏诊断仍是音频侧 M2/M3);OMR 只解决"谱面从哪来",且必须先过**note-level 精度闸门**才被信任,不达标的识别谱一律 fail-closed 退人工核对,**绝不直接进判断**——这是从二胡坎1吸取的纪律。
>
> **路线重构(2026-07-09):** 原"技巧识别 M4(技法名称展示)"**已删除**——技法不再作为独立展示功能,而是并入 **M3+ 少退复核延伸**:识别技法只为把该区的**音准**判对(揉弦判中心音高、滑音判起止、颤音判两目标、双音需 multi-f0、泛音需谱面 sounding pitch),**不展示技法名、不降音准标准、拿不准仍退复核**。里程碑重编号:**OMR = M4(提前)、大提琴 = M5(最后)**。目标次序:先 M3+ 判准小提琴音准 → 再 M4 OMR 识谱+落到谱面 → 大提琴最后。
>
> **受控 pilot 决策包(2026-07-10):** `npm run western:release-review` 之后必须运行 `npm run western:controlled-pilot-decision`。当前机器自测结果为 `readyForControlledPilotDecision=true`,`readyToStartControlledPilot=false`,`approvalPresent=false`;下一步不是继续教师/专业人员复核,而是产品负责人是否批准一个单独受控 pilot。可用 `npm run western:controlled-pilot-approval-template` 生成模板;无明确批准文件时默认保持 review-only / fail-closed。若负责人决定暂缓/不启动,运行 `npm run western:controlled-pilot-record-decision -- --decision defer --by <负责人>`;若负责人批准,运行 `npm run western:controlled-pilot-record-decision -- --decision approve --by <负责人> --confirm-separate-monitored-pilot --confirm-default-runtime-fail-closed`。批准后还必须运行 `npm run western:controlled-pilot-start-preflight`,通过前不得启动 pilot。只有机器预检报告 unknown/unsafe auto-pass 时才做定向人工复核。

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
| (M3+ 少退复核) | 技法感知音准:揉弦/滑音/颤音/装饰音换判法,双音 multi-f0,泛音谱面标注 | 更多音准诊断、更少"需复核" | 同上 | 各模式音准 precision≥90%;拿不准仍退复核 |
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
**In(M3+ 少退复核):** 技法感知的音准判断——揉弦/滑音/颤音/装饰音换判法、双音 multi-f0、泛音谱面 sounding pitch;目的是把技法区的音准判对、减少退复核,**不展示技法名、不降音准标准、拿不准仍退复核**。
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
- **API(当前最小学生闭环):** `POST /api/strings/analyze` 读取 M2d/M2f/M3 证据并 fail-closed;只暴露 core passed categories = pitch / onset / missing。该路由也接受 clean-score `scoreId` + audio 的受控提交,默认写入离线复核队列并返回 `studentReady=false`。`GET /api/strings/controlled-submissions`、`GET /api/strings/controlled-submissions/:id/audio`、`POST /api/strings/controlled-submissions/reviews` 提供离线队列读取、试听和审核。`POST /api/strings/controlled-submissions/run-batch` 只处理 `accepted_for_batch` 项并写入 batch run 审计记录,`autoDiagnosisIssued=false`;若提交携带已验证的 `dataset/piece/recordingId`,batch 可回放现有 gated pipeline 生成离线分析摘要,但仍不发学生端诊断。普通 clean-score + audio 上传现在可进入 pYIN 线性谱面特征执行器,输出 `offline_feature_review_ready` 完整候选特征表 artifact、前 5 条 preview 与摘要;早期 `western-offline-feature-gate-v0-review-only` 已被 RF confidence scorer 包装取代,当前冻结 release artifact 为 `models/western-strings/ordinary-upload-confidence-rf-v1/release.json`。该 scorer 已通过 30 条 fresh blind validation(precision=0.90),且 `npm run western:ordinary-monitored-pilot-smoke` 已验证显式 pilot flag 下会调用同一 scorer 并写出 `confidenceProbability`;但运行时仍默认关闭:无 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1` 时所有普通上传候选继续 `review_required`。release audit 现在使用 candidate-evidence runtime policy,threshold-pool runtime-selected precision 已通过;正式进入受控 pilot 前仍必须先跑 `npm run western:ordinary-auto-pass-precision-review-pack`,复用已知标签自检,且只有 unknown auto-pass rows 或 known-wrong rows 才要求教师复核。`npm run western:ordinary-monitored-pilot-plan` 已把该 precheck 作为硬闸门。`npm run western:controlled-batch-candidate-audit` 与 `npm run test:western-project-gate` 必须继续证明无 flag 时 fail-closed。`POST /api/strings/review` 记录教师/学生端复核回流。当前实现是证据门控包装层,不是默认开启的任意上传音频实时分析器。
- **验收:** auto_pass precision≥90%、coverage≥20%、按曲报告、留一曲验证、无真值泄漏。

### M3 — 基础教学诊断(core:音准/起音/漏音)
- **当前 V2 core release 范围:** 音准偏差 / 起音时序 / 漏音 / 音高不稳 / 低置信警告。
- **当前 review-only:** 时值过短/过长、extra-note/多音。两者原因不同:本轮真实学生复核中没有 extra-note 错误,所以多音缺少 release 证据;时值错误受节奏不稳定影响,教师只能给出定性判断,不能稳定量化为学生端硬反馈。
- **多音口径澄清:** 多音/extra-note 本身可以由人工复核判断;本轮只是复核时没有发现多音错误样本,所以当前 release gate 没有覆盖它。后续要开放自动多音反馈,应补采或构造经人工确认的 extra-note 样本,而不是把多音视为不可判定类别。
- **第一版建议阈值(必须由教师样本复验后才能 release):**
  - pitch: `abs(centsError) >= 35c` 进入 pitch issue;20-35c 默认 review hint,不直接给学生硬错。
  - onset: `abs(onsetErrorMs) >= 120ms` 进入 rhythm issue;legato/weak-onset 只给 review reason。
  - missing: 只在 M2 `auto_pass` 或教师确认的对齐范围内判定。
  - extra: 可判断,但本轮没有多音样本;需后续补经人工确认的 extra-note 场景后才能进入 release gate。
  - duration: 本版仅记录为 review-only,需后续补可稳定量化的时值样本后才能进入 release gate。
- **frontend(学生端):** 高置信音诊断 + 谱面定位;低置信"需复核";reject 段明确提示。
- **验收:** note-level 反馈落到谱面位置;低置信不反馈;教师复核可用 + 回流。

### M3+ — 少退复核延伸(技法感知的音准判断)
- **目的:** 让 M3 尽量少退复核——把原本因技法/多声部而退复核的音尽量判出音准来;**但绝不降音准标准**(precision≥90% 不变,拿不准仍退复核)。技法在这里只是**音准评判模式的开关**,不展示技法名(原技法展示里程碑已删)。
- **单声部音高模式(靠 f0 行为识别,红利最大,先做):**
  - 稳态 → 常规 ±35c 判定。
  - 揉弦 vibrato → 判**中心音高**,不看瞬时(f0 调制频率 4–8Hz/幅度识别)。
  - 滑音 glissando → 判**起止目标**或不点判(f0 单调滑移识别)。
  - 颤音 trill → 判**两个交替目标**(f0 双稳态识别,与揉弦区分)。
  - 装饰音 ornament → **主音单独判**,倚音分开/忽略。
- **多声部/特殊(能力组件,按曲目需要再上,未上前保持 review):**
  - 双音 double-stop → 需 **multi-f0(多基频)** 才能同时判两音。
  - 泛音 harmonic → 需**谱面带 sounding pitch + 泛音标记**(f0 干净但期望音高要对);缺标记则 review,注意八度错配。
- **fail-closed 不变:** 模式拿不准 → 退复核,不硬判。
- **验收:** 各模式下 note-level **音准 precision≥90%**(指标是"技法区里音准判得对不对",不是技法分类 AUC);技法区 review 率相对 M3 core 下降;音准误判不上升。
- **当前执行状态(2026-07-09):** 已新增 eval-only 清点命令 `npm run western:m3plus-pitch-modes`。全量跑通 12 条真实/准真实录音、2588 个谱面音符,输出 `data/experiments/western-strings-m3plus/m3plus-pitch-mode-inventory.csv` 与 `m3plus-pitch-mode-summary.json`;其中 1269 个音符被标为需关注的 pitch-behavior 候选(以 `slide-like`、`variable-f0` 为主)。已新增 `npm run western:m3plus-review-pack`,从 inventory 抽样生成本地人工复核包 `data/experiments/western-strings-m3plus/pitch-mode-review-pack/index.html`:共 48 条,`slide-like` / `trill-like` / `double-stop-candidate` / `ornament-candidate` / `stable` / `variable-f0` 各 8 条,并附本地短 WAV 与对应五线谱图片(`score-images/`,按 piece/page/measure/note 定位)。复核页已改为正常中文说明,提供单条"匹配且音准正确/不确定/不匹配"快捷按钮,也提供"未标全部设为匹配且正确/不确定"批量按钮;批量按钮只填未标项,不得替代听辨。第一轮 48 条与第二轮 36 条补强样本已累计导入,`npm run western:m3plus-review-status` 实测 `m3plusModeEvalReady=true`:98 reviewed / 74 scored,每类 reviewed/scored 缺口均为 0。已新增并运行 `npm run western:m3plus-mode-eval`:结果为 `m3plusModeReleaseReady=true`,`releaseReadyModes=[slide-like,trill-like]`,`controlReadyModes=["stable"]`;说明标签足够做评估,但已有 first-measure slide/trill 离线证据,但不能广泛打开。累计复核还显示 74 match / 19 mismatch / 5 uncertain-or-other,谱面-录音定位不准是当前候选质量 blocker。学生端 M3+ 仍全部 `review_required`;若要继续,必须先改定位/候选生成,再生成新的 targeted eval pack 重跑 per-mode precision/unsafe 评估。

### M4 — PDF/图片谱面识别(OMR,带精度闸门)
- **动机:** 让学生/教师直接传 PDF 或拍照谱,不必先有干净电子谱。**这是主线诉求,但也正是二胡翻车的坎1**,因此按 M0 同样的纪律:先在数据集上验准确率,再谈信任。
- **pipeline:** PDF/图片 → Audiveris OMR → MusicXML 草稿 → **note-level 精度评测**(对齐 gold MusicXML,报 pitch 识别正确率 / onset 正确率 / 小节级错误率 / 漏识别率)→ 达标进 score store(`scoreSource=omr`),不达标进人工核对队列(复用 m2f clean-score 流程)。
- **精度闸门(release 前必过):** 在有 gold MusicXML 的曲目上,note pitch 识别准确率 ≥**[待定,建议 ≥98%]**、漏/多音率 ≤**[待定]**;未达标的谱**一律 fail-closed 退人工**,不得直接进音高/节奏判断。阈值必须先在真实曲目上定标,不得凭空写死。
- **schema:** score 记录加 `scoreSource=omr`、`omrEngine`、`omrConfidence`、`omrReviewStatus`(draft/human-approved);低置信小节单独标记,判断时该小节降级 review。
- **与判断层的关系:** OMR 只解决"谱面从哪来";判断仍是音频侧 M2/M3。**谱面错 → 判断全错**,所以 OMR 闸门必须比音频闸门更严,且学生端要明示"此谱由识别得到、是否经人工核对"。
- **验收:** OMR note 准确率达标闸门通过;不达标谱 100% 走人工;`scoreSource=omr` 全链路可追溯;判断层不读取 `omrReviewStatus≠human-approved` 且未过闸门的谱。
- **当前执行状态(2026-07-09):** 已新增只读 readiness 命令 `npm run western:m4-omr-readiness`,用于审计 M2f clean-score intake 是否足以启动 OMR benchmark。当前实测 12/12 条 `currentScorePath` 图片/谱面源文件存在、12/12 条 `requiredCleanScorePath` gold clean score 存在且已 `approved`、12/12 个 `scoreId` 已在 score store 中,输出 `data/experiments/western-strings-m4/omr-readiness.json` 与 `.csv`;`m4OmrBenchmarkDatasetReady=true`。该命令只证明"可开始跑 OMR 引擎并与 gold score 对比",**不证明 OMR 精度达标**,且输出仍固定 `studentGateReady=false` / `runtimeEffect=none`。已新增 `npm run western:m4-omr-benchmark` 做 Audiveris 草稿 vs gold clean score 的只读评测;当前实测 12/12 草稿可解析,但 12/12 gold clean score 与 Audiveris 草稿 SHA-1 完全相同,属于自比,因此 `usableBenchmarkRows=0`,`selfComparisonRows=12`,`m4OmrDraftQualityReady=false`。已新增 `npm run western:m4-independent-gold-todo` 生成 `data/experiments/western-strings-m4/independent-gold-todo.html/.md/.csv`,列出 12 条需要独立人工校正 gold 的行;HTML 是可视化入口,清单同时列出 `sourceScorePath` 原谱图片/PDF、当前 `goldPath`、Audiveris `draftPath`、`scoreId` 与音符数,可直接按行做人工 gold。下一步必须准备**独立人工校正的 gold score**或外部 gold,否则不能声明 OMR 准确率。

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
- **暂不开放硬反馈:** 时值 / extra-note/多音。extra-note 可判断但当前无验证样本;时值需先解决节奏不稳定下的量化口径。两者当前只能作为 review-only 记录,不得进入学生端自动诊断。
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
| M3 diagnosis | pitch/onset/missing core 评测表;duration/extra 可选扩展 | 当前 release 只要求音准、起音、漏音分别 precision≥90% 且 unsafe=0;extra-note 需补人工确认样本;duration 需补可量化时值样本。未通过前二者保持 review-only;低置信不反馈;回流可导出 | 仅显示对齐,不显示诊断 |
| M3+ pitch-behavior modes | 揉弦/滑音/颤音/装饰音/双音/泛音分模式音准评测 | 各模式 note-level 音准 precision≥90%、unsafe=0;技法区 review 率下降但音准误判不上升 | 未达标模式保持 `review_required`,不展示技法名 |
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
| M3+ 少退复核延伸 | pitch-behavior 模式 1-2 周;multi-f0 双音 + 泛音谱面 按需 |
| M4 PDF 谱面 OMR | 2-4 周(Audiveris 接入 + 精度评测闸门 + 人工核对闭环) |
| M5 大提琴 | 1-2 周(+独立 M0) |

**停止条件(kill criteria):**
- M2 在真实输入上 auto_pass precision <90% 且补数据/调特征仍上不去 → 降级 review-only,不给学生自动反馈。
- M3+ 某音高行为模式(揉弦/滑音/颤音/装饰音/双音/泛音)达不到音准 precision≥90% → 该模式保持退复核,不硬判(不拿降音准标准换覆盖率)。
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
| 为少退复核而降音准标准 | 只能靠补能力(M3+ pitch 模式/multi-f0/泛音谱面)减少 review;拿不准仍退复核,音准 precision≥90% 硬门槛不动 |

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
- ✅ M2f 真实学生录音 release gate 已补并通过:`npm run western:m2f-gate` 校验真实录音 manifest/results、样本数、学生数、错误场景、授权、路径与结果安全性。2026-07-08 人工/gold 复核完成:12 条小提琴录音、3 个匿名学生、6 类场景各 2 条;`autoPassCount=431`,`correctWithin300ms=431`,`unsafeTargetAutoPassCount=0`,`precisionWithin300ms=1.0000`,`studentGateReady=true`。通过命令:`npm run western:m2f-status`,`npm run western:m2f-gate`,`npm run test:western-m2f-templates`。
- ✅ PDF/JPG→MusicXML 草稿路径已实测并脚本化:`npm run western:m2f-audiveris-drafts` 使用本地 Audiveris 5.10.2 console,对 M2f 谱图做 2x 预处理并批量 OMR;练习曲 5 换用高清谱图后,12/12 可生成可解析 `.mxl` 草稿。该路径仅作为人工清谱/核谱辅助,不得未经人工确认直接作为 V2 clean score release 证据。本轮 M2f 通过依据是已核实 manifest/results 与人工/gold 复核计数。
- ✅ M2d/M2e 通过/拒绝证据已映射到教师后台:Western strings preview 默认加载 `studentSafe=1`,显示 release gate 状态、source、review reason、相邻音序列 Basic Pitch 支持、method agreement 与 candidate sources,方便教师快速复核。
- ✅ M1 收口已完成: `test:western-string-config` / `test:western-musicxml-import` / `test:western-midi-import` / `test:western-dataset-index` / `test:western-strings-entry` / `test:server-boundaries` / `test:server-p0` / `test:musicxml-import` / `test:analyzer-score-roles` / `test:teacher-validation` / `build` 全部通过。

**M1 已完成。M2f 真实学生录音 gate 已通过;M3 core diagnosis gate 已通过;最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环已接入;Western strings UI 已支持 clean-score + audio 受控提交进入离线复核队列,并可试听/审核队列项、运行 fail-closed batch audit。学生端仍未开放任意上传音频实时自动反馈。**

当前下一阶段步骤:
1. 以 M2f 通过结果作为 V2-alpha 学生端前置证据,保留 `real-student-recording-results.csv` 和 gate 输出作为审计依据。
2. ✅ M3a 诊断复核表与 fail-closed validator 已接入:`npm run western:m3-diagnosis-skeleton` 生成 `data/experiments/western-strings-m3/real-student-diagnosis-results.csv`;`npm run western:m3-status` / `npm run western:m3-gate` 默认评估 V2 core required categories = pitch / onset / missing。duration / extra 仍可记录,但默认 `review_only`,不阻塞当前 core gate。
3. ✅ M3b 本地复核网页已接入:`npm run western:m3-diagnosis-review-pack` 生成 `data/experiments/western-strings-m3/diagnosis-review-pack/index.html`;页面复用 M2f 音频、谱图和 auto-pass 预览,按录音聚合填写五类诊断的系统诊断数/正确数/危险误判数,支持"已填诊断全部正确"、清零、按场景预填草稿、下载 CSV。
4. ✅ M3c 第一轮人工/gold 复核已导入:12 行结果覆盖 431 个 M2f auto-pass note;`npm run western:m3-status` 和 `npm run western:m3-gate` 已通过 core gate。pitch=2/2、onset=2/2、missing=2/2,三类 precision=1.0000 且 unsafe=0;duration 与 extra status=`review_only`。
5. 后续若要开放 extra-note 反馈,必须另采/构造经人工确认的多音样本;若要开放 duration 反馈,必须先定义节奏不稳定下可重复的时值量化口径并采集对应样本。之后用 `--required-categories all` 或显式 required list 重跑 gate;未通过前不得给学生硬反馈。
6. ✅ 最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环已接入,默认仍 fail-closed;当前只允许 core passed categories 进入学生端候选。`test:western-alignment-preview` 覆盖 route ready/fail-closed。
7. ✅ Western strings 页面已接入 gated preview UI:只加载已验证样本,显示 allowed categories = pitch / onset / missing、review-only = duration / extra,并可写回 confirm/review。`test:western-strings-entry` 覆盖 UI hook;`test:western-feature-flags` 确认离线 preview 仍未被学生侧直接调用。
8. ✅ UI 已从“已验证样本预览”升级到真实 clean-score + audio 的受控提交流:上传音频只进入 `controlled-submissions.jsonl` 离线复核队列并返回 `studentReady=false`,不会生成学生端硬诊断。
9. ✅ 离线复核队列已接入:可列出 controlled submissions、试听缓存音频、写入 `controlled-submission-reviews.jsonl`,并把条目标为 `accepted_for_batch` / `review_required` / `reject_unsupported` / `failed`。
10. ✅ fail-closed 批处理审计执行器已接入:`POST /api/strings/controlled-submissions/run-batch` 只处理 `accepted_for_batch` 项,写入 `controlled-submission-batch-runs.jsonl`,并明确 `autoDiagnosisIssued=false`。对携带已验证 `dataset/piece/recordingId` 的受控提交,batch 可回放现有 gated pipeline 并写出 `offline_analysis_ready` 摘要;对普通 clean-score + audio 上传,batch 已接入 review-only pYIN 线性谱面特征执行器,可写出 `offline_feature_review_ready` 完整候选特征表 artifact、前 5 条 preview 与摘要,但所有结果仍为 `review_required`。`western-offline-feature-gate-v0-review-only` 已作为普通上传的 student-safe gate 框架接入,当前版本明确阻断所有候选并写出 `ordinary-upload-student-safe-gate-not-calibrated`;`npm run western:controlled-batch-candidate-audit` 已作为二次审计命令,检查普通上传候选表 artifact 存在、行数匹配、没有 auto-pass、没有 student-facing 输出、没有 student-safe gate 绕过。`npm run western:controlled-candidate-review-export` 默认抽样 30 条最新 batch 候选,生成本地中文复核网页、CSV、JSON 和 `review-guide.md`;`-- --all` 可导出全量候选。`npm run western:controlled-candidate-review-import -- --reviews <completed.csv>` 把人工复核结果合并到累计 labels CSV;`npm run western:controlled-candidate-gate-eval` 默认读取累计 labels CSV 并生成校准报告;`npm run western:controlled-candidate-review-status` 输出当前 reviewed/scored 缺口、bestRule、下一步和 `reviewArtifacts`(复核网页/指南/completed CSV/labels CSV 路径);`uncertain` 只计入复核记录,不计入可评分样本数。当时下一步是积累真实普通上传复核数据(该阶段已被后续 confidence validation、release-review 和 controlled-pilot decision 覆盖;当前不再要求继续复核同一包),在校准报告达到 minReviewedRows/precision 闸门后再讨论替换 `western-offline-feature-gate-v0-review-only`;未完成前不得声称支持任意上传音频实时诊断。
11. ✅ 普通上传候选复核输入预检已接入并打通:`npm run western:controlled-candidate-input-status` 只读检查 M2f manifest、clean-score intake、score store、controlled submissions 和 batch 候选行。当前实测为 12/12 音频存在、12/12 clean score 已批准且文件存在、12/12 已导入 score store 并回填 `scoreId`;12 条 controlled submissions 已审核为 `accepted_for_batch`。最新 batch run `strings-batch-mrb9twcr-ls0kkl` 生成 12 个 `offline_feature_review_ready` 项、2588 行 review-only 候选 artifact,`western:controlled-batch-candidate-audit` 默认审计最新 run 并通过。`western:controlled-candidate-review-export` 默认生成 30 条轮转抽样的本地中文复核网页/CSV/JSON 和按录音分组的 `review-guide.md`,用于第一轮最小校准;需要审全量时加 `-- --all`。当时下一步是人工复核候选行并用 import/status/gate-eval 累积校准证据(该轮复核与后续校准已完成/覆盖;当前不再要求继续复核同一包)。历史上一次缺 `candidateRowsPath` 的旧 batch 保留为数据日志,不作为当前默认审计对象;需要追溯历史时可显式跑 `western:controlled-batch-candidate-audit -- --all-runs`。
12. ⏳ 当前人工复核口径:打开 `data/experiments/western-strings-m3/offline-feature-candidate-review/index.html`,逐条试听并看候选的预测秒/页/小节/MIDI。若候选确实对应该谱面音符且足以作为后续校准正例,标 `usable`;若候选明显错位、音高不对应、或不能作为该音符证据,标 `wrong`;若听不清、谱音位置无法确认、或只能给定性判断,标 `uncertain`。新版页面用“候选 1 / 30”作本页序号,并在卡片中写明“系统说:录音 X 秒附近可能对应第 Y 小节/MIDI Z”;原始行号只是内部编号,不用判断。导出脚本会把涉及的音频复制到复核页旁边的 `audio/` 文件夹,页面提供 `播放/暂停` 与 `跳到候选秒` 中文按钮,不必依赖浏览器原生音频小图标或后台音频接口;也提供 `一键未标=可用`、`一键未标=错误`、`一键未标=不确定` 和 `清空本页标注`。批量按钮只填未标项,不会覆盖已单独修改的候选。`usable` 与 `wrong` 才计入可评分样本;`uncertain` 只保留记录,不计入 precision/coverage 校准。第一轮至少需要 30 条 `usable/wrong` 后才能运行 import/status/gate-eval 得到有效的 student-safe gate 评估。若 gate-eval 返回 `candidate-review-no-rule-meets-precision` 且规则没有选中样本,应运行 `npm run western:controlled-candidate-review-export -- --gate-candidates` 生成第二轮可校准候选复核页。
13. ✅ 2026-07-08 普通上传候选第二轮复核已导入:最新下载的 `controlled-candidate-review.completed.csv` 为 30 条可评分样本(16 usable / 14 wrong),合并后累计 labels 为 60 条(46 usable / 14 wrong)。`npm run western:controlled-candidate-review-status` 仍返回 `candidate-review-no-rule-meets-precision`;最新 30 条单独评估的最佳规则 precision 约 0.533,不达 0.90 学生安全闸门。新增只读诊断命令 `npm run western:controlled-candidate-label-audit` 会扫描累计 labels、候选 JSON、数值阈值和分类字段,输出 `candidate-label-audit.json`;本轮发现累计样本存在小样本/批次偏差,最新 30 条在 `--min-selected 10` 下没有任何规则达到 0.90 precision。因此普通上传音频继续保持 `review_required`,不得开放学生端自动反馈。复核页已改为每条生成约 6 秒本地短音频 `clips/`、候选秒按短音频内部时间跳转,并显示对应谱面图 `score-images/`;若页面内播放器不可用,可点“打开短音频文件”直接播放 WAV。
14. ✅ 下一批复核导出已改为默认排除已标候选:`western:controlled-candidate-review-export` 会读取累计 `controlled-candidate-review-labels.csv`,自动跳过已有 `usable/wrong/uncertain` 的候选,避免重复复核。需要复现旧页面或回溯历史时才加 `--include-reviewed`。本轮 `--gate-candidates` 重导出显示:可校准候选 226 条,已标 60 条,排除后剩 196 条,当前页面抽取 30 条且与 labels 重叠为 0;短音频和谱图均已生成。
15. ✅ 2026-07-09 置信模型 pilot 已接入:`npm run western:controlled-candidate-confidence-pilot` 读取累计 60 条 `usable/wrong` 标签,只做 eval-only 训练/验证,不接 runtime gate。主口径使用 deployable 特征(不使用 recordingId / recordingScenario 等会过拟合的元数据)并按 recordingId 留一验证。严格主口径当前推荐 RF threshold=0.7(selected=32,precision=0.9375,coverage=0.5333)。说明复核数据已经从"继续凑样本"进入"训练置信模型"阶段。但这仍是 pilot positive,不是 release:当时下一步必须用 fresh blind batch 复核来验证同一模型/阈值(该 fresh blind validation 后续已完成并进入 release-review / controlled-pilot-decision),通过前普通上传仍保持 `review_required`。验证批次生成命令:`npm run western:controlled-candidate-confidence-validation-export` 先输出 `candidate-confidence-validation-selection.{json,csv}`,再运行 `npm run western:controlled-candidate-confidence-validation-review-pack` 生成 `data/experiments/western-strings-m3/confidence-validation-review/index.html` 供人工盲标。盲标完成后运行 `npm run western:controlled-candidate-confidence-validation-eval` 独立评估同一冻结模型/阈值;该命令不把 fresh CSV 合并进训练 labels,只写 `confidence-validation-eval.json` 和逐行评估 CSV。
16. ✅ 2026-07-09/10 项目级状态命令已接入并随当前证据更新:`npm run western:project-status` 同时汇总普通上传候选 gate、confidence pilot + fresh validation eval/release audit、M3+ pitch-behavior 复核/模式评估状态与 M4 OMR benchmark 状态,输出 `data/experiments/western-strings-project-status.json`。当前结果应显示普通上传 `ordinaryUploadAutoFeedbackReady=false`、M3+ `m3plusAutoFeedbackReady=false`、M4 `m4OmrAutoScoreReady=false`。普通上传 confidence validation fresh blind batch 已通过,`npm run western:ordinary-monitored-pilot-audit` 已把真实受控队列 precision precheck、临时 release-flag smoke 与 pilot plan 串成一个总控检查。当前结果为 `readyForMonitoredPilot=true`,`teacherReviewNeeded=false`,`selfCheckedAutoPassCandidateCount=3`,`knownUsableAutoPassCandidateCount=3`,`knownWrongAutoPassCandidateCount=0`,`unknownReviewCandidateCount=0`,所以这批不需要教师复核。M3+ 已有 first-measure slide/trill 离线 release-ready 模式,`npm run western:m3plus-monitored-pilot-audit` 也已通过且不需要继续复核当前包。M4 provenance 审计已识别 12 条 `human-approved-unchanged-draft`:这些 clean score 与 Audiveris draft byte-identical,但已有 M2 clean-score review 的 `approved` + `cleanScoreReviewedBy` 证据,因此不再当作未复核 self-comparison,`manualGoldRequiredRows=0`,`usableBenchmarkRows=12`。`npm run western:release-review` 已聚合 ordinary / M3+ / M4 机器检查并输出 `data/experiments/western-strings-release-review.md`;当前 `readyForControlledPilot=true`,`readyForDefaultStudentRelease=false`,`teacherReviewNeeded=false`,`runtimeFailClosed=true`。因此下一步是运行 `npm run western:controlled-pilot-decision` 并等待产品负责人是否批准单独受控 pilot,不是继续复核或默认上线。项目状态命令只读,不得替代 release gate。`npm run western:project-gate` 仍用于默认发布阻断,当前非零退出只代表默认学生端未开启,不是缺复核数据。`npm run test:western-project-gate` 覆盖项目级 fail-closed、confidence validation 状态、显式 release-flag 阻断、M3+ 安全子集、M4 human-approved unchanged gold 口径以及 release-review handoff。
17. ✅ 2026-07-09/10 confidence validation fresh blind batch 已完成并独立评估通过:从下载的 `controlled-candidate-review.completed (2).csv` 复制到 `data/experiments/western-strings-m3/confidence-validation-review/controlled-candidate-review.completed.csv`,运行 `npm run western:controlled-candidate-confidence-validation-eval`。结果为 reviewed/scored=30、usable=27、wrong=3、uncertain=0,冻结模型 RF threshold=0.7 在这批预筛样本上 precision=0.90,满足当前 validation floor。`western:project-status` 现在应显示 `confidencePilot.needsBlindValidation=false`、`validationEval.blindValidationPassed=true`,但 runtime 仍保持 `ordinaryUploadAutoFeedbackReady=false`,阻塞原因包含 `ordinary-auto-gate-disabled-by-default`。runtime gate 已通过 `models/western-strings/ordinary-upload-confidence-rf-v1/release.json`、`scripts/experiments/score_western_controlled_candidate_confidence.py` 与 npm 入口 `western:controlled-candidate-confidence-score` 接线;`npm run western:ordinary-monitored-pilot-audit` 会一次性验证真实受控队列 precheck、临时 flag smoke 和 pilot plan,同时确认默认项目状态仍 fail-closed。`npm run western:controlled-candidate-confidence-release-audit` 现在以 candidate-evidence runtime policy 汇总 fresh validation 与 threshold-pool 证据;`npm run western:ordinary-auto-pass-precision-review-pack` 在进入 pilot plan 前先复用已知标签自检,当前没有未知待复核或已知错误 auto-pass 行。默认不开学生端,只有 `western:ordinary-monitored-pilot-audit` 通过后,才可在单独受控进程里临时设置 release flag。
18. ✅ 2026-07-09 threshold-pool 分层复核包已生成:`npm run western:controlled-candidate-confidence-stratified-export` 在 2528 个未复核候选上重新打分,阈值以上候选 2291 个(coverage=0.90625),并按 high / above-threshold / near-threshold / low 抽样 60 行(15 / 21 / 15 / 9)。`npm run western:controlled-candidate-confidence-stratified-review-pack` 生成 `data/experiments/western-strings-m3/confidence-threshold-pool-review/index.html`、CSV、JSON 和 review guide。人工复核完成后将下载 CSV 保存为 `controlled-candidate-review.completed.csv`,再运行 `npm run western:controlled-candidate-confidence-stratified-eval`。该步骤专门验证完整阈值池 precision,不得用之前 30 条预筛 validation 的 coverage 直接替代。
19. ❌ 2026-07-09 threshold-pool 分层复核已完成但未通过 release floor:`controlled-candidate-review.completed.csv` 共 60 行,usable=23 / wrong=36 / uncertain=1。`npm run western:controlled-candidate-confidence-stratified-eval` 得到 selectedRows=36、selectedUsable=20、selectedWrong=16、precision=0.5556、coverage=0.6102,阻塞原因=`confidence-validation-precision-too-low`。`npm run western:controlled-candidate-confidence-release-audit` 已更新为 `ordinary-confidence-threshold-pool-precision-too-low`。结论:当前 RF confidence gate 不得进入受控 pilot,也不得默认开启;下一步必须重校准模型/特征或收集更强候选证据。
20. ✅ 2026-07-09 threshold-pool 失败诊断已固化:`npm run western:controlled-candidate-confidence-threshold-diagnosis` 输出 `data/experiments/western-strings-m3/confidence-threshold-pool-review/confidence-threshold-pool-diagnosis.json`。诊断显示 selected wrong=16,其中 above-threshold=13、high=3;最佳简单规则 `predictedUsableProbability>=0.95` 只有 selected=14、usable=12、wrong=2、precision=0.857,没有任何 selected≥10 且 precision≥0.90 的简单规则。下一步不是继续调阈值,而是重校准 confidence 特征/模型或收集更强候选证据。
21. ⏳ 2026-07-09 confidence 重校准盲测包已生成:`npm run western:controlled-candidate-confidence-recalibration-labels` 合并旧 60 行与 threshold-pool 60 行复核标签,得到 120 行(119 scored,usable=69,wrong=50,uncertain=1)。`npm run western:controlled-candidate-confidence-recalibration-pilot` 在 deployable + leave-one-recording 口径下得到 RF threshold=0.9 候选(selected=31,precision=0.9355,coverage=0.2605),但这仍是 eval-only。`npm run western:controlled-candidate-confidence-recalibration-validation-export` + `npm run western:controlled-candidate-confidence-recalibration-validation-review-pack` 已生成 10 行盲测包 `data/experiments/western-strings-m3/confidence-recalibration-validation-review/index.html`;通过 `npm run western:controlled-candidate-confidence-recalibration-validation-eval` 前,普通上传自动 gate 继续默认关闭。
22. ✅ 2026-07-09 M3+ 第二轮补强包已导入并评估:`npm run western:m3plus-review-pack-round2` 生成的 36 条非 control 样本已通过带 `--source`/`--reviews` 的 `western:m3plus-review-import` 导入同一个累计 labels CSV。当前累计 98 reviewed / 74 scored,`npm run western:m3plus-mode-eval` 仍返回 `m3plusModeReleaseReady=true`,`releaseReadyModes=[slide-like,trill-like]`,`controlReadyModes=["stable"]`。当前已有 slide-like/trill-like 的 first-measure 离线 release 证据;但历史 19 mismatch + 5 uncertain-or-other 仍证明后续小节定位存在风险。未设计窄范围 pilot 前,M3+ 学生端仍默认关闭。
# 2026-07-09 最新闸门状态补充

- P1 confidence 重校准已补强:30 行 context-validation 已导入,当前验证 precision=0.90 / coverage=1.0。普通上传自动 gate 仍默认 fail-closed,不得直接常开;只能在单独受控 pilot 中设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1` 并监控。
- M3+ second-round plus first-measure candidate-quality review has been imported:98 reviewed / 74 scored. Current per-mode eval has first-measure `slide-like` and `trill-like` offline release evidence; historical localization diagnosis still records 24/98 non-match/uncertain rows, with `stu02-ex05-weak_onset` at 9/9 mismatch. M3+ 当前不需要继续复核同一包;如产品化,只能设计 first-measure + trusted-recording + slide/trill 的窄范围 monitored pilot。
- 以上补充覆盖下文较早的“待复核 P1 / 继续补 M3+”描述;runtime 仍 fail-closed。
# 2026-07-09 P1.1 context validation update

- The old P1 confidence recalibration blind validation failed historically. It remains evidence only and should not be reviewed again.
- P1.1 deployable context/candidate-quality validation has since been imported and passed the current precision floor.
- Student-facing ordinary-upload auto feedback remains fail-closed; any product step must be a separate monitored pilot, not a default runtime enable.

# 2026-07-09 M3+ candidate-quality review update

- M3+ localization diagnosis identified `stu02-ex05-weak_onset` as a recording-level 100% non-match source (9/9 mismatch). Candidate-quality sampling is now stricter: it only draws from recordings whose prior M3+ review rows were all audio-score matches.
- `npm run western:m3plus-review-pack-candidate-quality` now generates `data/experiments/western-strings-m3plus/pitch-mode-review-pack-candidate-quality/index.html`, restricted to first-measure rows from previously all-match recordings, with already-reviewed rows excluded. Later measures are excluded because their linear score-time windows drift.
- The generated pack has 24 rows and is for evidence collection only. M3+ pitch-behavior feedback remains review-only until the refreshed labels pass per-mode precision and localization checks.

# 2026-07-09 M3+ first-measure release-evidence update

- The first-measure candidate-quality pack has been completed and imported. The user confirmed the reviewed rows have no score-audio offset and are all correct.
- Current M3+ label state: 98 reviewed rows, 74 scored rows, no review/scored deficits.
- Current `npm run western:m3plus-mode-eval` result: `m3plusModeReleaseReady=true`, `releaseReadyModes=["slide-like","trill-like"]`, `controlReadyModes=["stable"]`.
- Scope of this result is narrow: it proves slide-like and trill-like pitch-judgement modes have enough **offline first-measure evidence**. It does not prove later-measure localization, broad technique display, or default student-facing auto feedback.
- Runtime remains fail-closed: `m3plusAutoFeedbackReady=false`. Any product use must be a separate monitored pilot scoped to first-measure, trusted-recording, slide/trill rows; default runtime must stay off.
- This supersedes older handbook statements from before the first-measure candidate-quality import. No more M3+ manual review is currently requested.
