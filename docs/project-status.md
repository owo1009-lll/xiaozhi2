# 西洋弦乐练习诊断项目状态快照

更新时间: 2026-07-19 03:01 +08:00

本文件是当前主线状态快照。实时判断仍以命令为准:

- `npm run western:project-status`
- `npm run western:release-review`
- `npm run western:project-gate`
- `npm run test:western-project-gate`
- `npm run build`

二胡线已经冻结为论文证据、困难案例和共享模块来源。当前产品主线是西洋弓弦乐, 小提琴优先, 大提琴后续独立验证。

## 2026-07-19 当前分支刷新

- **M4b 结构 POC 现已完成工程闭环:** 四层主链已落地为页面/透视/弯曲归一化、显式五线谱/系统/小节线/小节框/拍号区域证据、确定性结构图冲突解码、以及坐标可归属的多引擎 shadow challenger。冻结 synthetic-test 12/12 页上小节框 F1=1.000、整页结构完全正确率=1.000、拍号区域 F1=1.000、冲突注入转 `structure-review-required`=12/12。live audit 重算指标并验证每页 result/overlay/原图哈希，伪造合成证据晋升、学生端边界和空数据晋升均会 fail-closed。当前 `m4bStructurePocEngineeringReady=true`、`m4bStructurePocPromotionOperationalReady=true`，但这仍只是 `synthetic-engineering-only`；真实 fresh-blind 为 0/30 页、0/6 版式、0/3 设备，所以 `m4bStructurePocPromotionReady=false`、`m4bOpenWorldOmrAutomaticAdoptionReady=false`。C.3.2 的 100–300 张真实结构标注是晋升后扩大数据投入的目标，不得反向写成 POC 晋升前置条件。
- **M4b 外部数据入口已收口:** `docs/m4b-fresh-blind-capture-pack/index.html` 冻结 6 版式×6 姿态的 36 个拍摄槽位和 3 台物理设备分配，并直达结构标注器。`western:m4b-fresh-blind-intake` 会验证版式源指纹、设备去重、图片-标注 SHA-256 绑定、冻结决定和 test-only 确认，且不提供覆盖旧样本的 `--replace` 逃生口。因此当前剩下的 M4b blocker 是真实拍摄+逐页结构标注本身，不再是缺采集/入库/评测工具。

- 当前分支为 `feature/model-bakeoff-omr-align`;本节以 2026-07-18 本地 live 复跑和物理产物审计为准,不使用会因本次提交而自指失效的固定提交号。该分支已包含 HOMR 受控离线治理、M3+ 四区 v2 fail-closed 审计、动态闸学生域预考、round-3 reserve/实现验收材料(非发布 fresh-blind)和 8 张屏拍域基准;这些变化不改变默认学生端闸门。
- 已在该分支依次重新运行 `npm run western:m4-p0-structure-gate`、`npm run western:project-status` 和 `npm run western:project-gate`。P0 冻结 5 谱结果为完整 `1/5`,谱号/调号/拍号=`3/5,2/5,2/5`,`studentGateReady=false`。
- 这里的 P0 `1/5` 只表示同一 5 谱中的谱号/调号/拍号结构闸门;真实照片 pitch+onset+measure 完整自动采纳仍为 `0/5`,12 份历史照片链缓存重放中的 P0-ready 又是 `0/12`。三个数字对应不同门槛或数据集,不得互相替换;`m4P0StructureReady=true` 也只表示至少 1 谱 P0-ready,不表示 M4 自动采纳通过。
- 当前运行时仍为 `ordinaryUploadAutoFeedbackReady=false`,`m3plusAutoFeedbackReady=false`,`m4OmrAutoScoreReady=false`,`policy=fail-closed`。
- 当前项目总闸门要求 ordinary/M3+/M4 三轨同时通过。**2026-07-19 更新(重大):** 负责人已亲口"认"接受 2026-07-18 fresh-blind 证据并"批"过受控试点,`authorizationReady` 已从硬编码 false 改为从负责人常备批准文件(`data/experiments/western-strings-controlled-pilot-approval.json`)派生;ordinary 与 M3+ 两轨现均 `authorizationReady=true`,`m3plus-authorization-closed`/`ordinary-dynamic-shadow-authorization-closed` 均已清除。**`readyToStartControlledPilot=true`,受控试点(review-only,人工复核每一行,不触达学生)现已可启动,但尚未实际执行。** 两轨仍各自保留 `*-student-gate-closed`(学生端闸门,与授权完全独立、结构性永远 false)。M3+ v2 五区证据完整(保护库存 14/14、平拉 gold join `12/12`、揉弦/滑音 join `8/8`,`releaseGateReady=true`)。M4 必选闸门仍未达标,`projectReleaseReady` 仍为 false。`western:project-gate` 因此仍按设计非零退出(M3+ 学生闸+M4)。(旧值 8/14、0/12、0/8 为 2026-07-17 前的历史状态。)
- **2026-07-19 M4 双轨改绑:** 负责人已分别签署 M4a/M4b 闸门拆分和 M4b POC 晋升数字冻结。必选 M4 项现改绑 `M4aSupportedEditionRegistrationReady`,不再要求 M4b 开放域 OMR 自动采纳;M4b 的历史失败事实和 `m4bOpenWorldOmrAutomaticAdoptionReady=false` 均保持不变。M4a C.2a-f 工程链已完成:3 个内置自制版本(r2-01/r2-06/r3-01)的 registry `validEntries=3/3`;固定 Python/OpenCV 运行时 live preflight 通过;无 OMR 的页面检测→单应/TPS→结构质量闸→音频 0.6 仲裁→坐标反投影→review-only 标注链可执行。工程验收用 3 个确定性透视正例与 4 个拒绝例复跑为 `3/3`、`4/4`,并逐项验证 67/23/59 个诊断事件全部落到登记音符锚点。真实验收执行器也已就位并接入 status/project gate:现有 8 张旧渲染器/错曲真实屏拍已全部拦截(`8/8`,0 漏放),10 张精确登记版本的拍摄包、无覆盖 intake、真实照片派生模糊/半页拒绝集及负责人逐小节框哈希签署流程均已生成。该证据明确区分 engineering-only 与 frozen-real-screen-photo;M4a 仍未就绪,当前 external blocker 是 `m4a-real-photo-positive-missing:10`,随后才可执行派生低质集与负责人 100% 逐框确认。
- **2026-07-19 M4b 数据层:** 合成结构数据已生成 60 张并冻结为 train/calibration/synthetic-test=`36/12/12`;标签含页角、系统、谱表/五线、小节线类型、小节框和拍号区域。5 张 source-gold 与 8 张旧屏拍均由 live hash ledger 强制 test-only,M4a 成功/失败照片分别只可流向 auto-label/active-learning。`m4bDataFoundationReady=true`,但真实结构标签仍 `0/100`,fresh-blind 仍 `0/30`、`0/6` 版式、`0/3` 设备;因此 `m4bFreshBlindDatasetReady=false`,M4b 晋升及自动采纳均保持关闭。
- HOMR v3 的具名 AGPL/六模型审查现为 `approved-with-conditions`,唯一批准范围 `controlled-offline-review-only`;稳定运行时已迁至 `data/tools/`,live preflight 的 governance/host/deployment 三项均绿。preflight 现与 review-record SHA-256 绑定,审批或 artifact 漂移会令 `project-status/project-gate` fail-closed。学生端网络使用、自动采纳与再分发仍未获授权;这里的三绿不得写成默认生产发布通过。
- 刷新产物为 `data/experiments/western-strings-m4/p0-structure-gate/report.json`、`data/experiments/western-strings-project-status.json` 与 `data/experiments/western-strings-project-gate.json`;三者位于 `data/` 忽略目录,用于本地可复跑状态,不等同于已提交证据。
- **2026-07-19 更新:** release review、controlled-pilot decision 与 start preflight 已按当前合同重新生成,且均已转绿:`readyForControlledPilotDecision=true`,`readyToStartControlledPilot=true`,`okToStartControlledPilot=true`。它们绑定当前 live evidence(非缓存假象——`liveEvidenceBindingCurrent=true`),approval 文件 scope 与当前合同精确匹配且持久化安全确认齐全。**这只代表受控试点"可启动",试点本身尚未执行**;执行需要另一次显式命令(`npm run western:controlled-pilot-run -- --execute`),且仍是纯 review-only、不产生任何学生反馈。旧描述(scope 过期/缺确认导致红)为 2026-07-18 前状态,已被本次授权接线更新。

## 2026-07-18 ordinary dynamic-shadow foundation

- 旧 RF / first-measure 的 `3/3` 与五批安全 pilot 继续保留为历史实验事实,但其 `readyForMonitoredPilot`、旧 release review、旧负责人 approval 和旧 pilot decision 已全部显式标为 superseded,不再具有当前授权力。
- 普通 clean-score 受控 batch 现在无条件进入 Basic Pitch + gap-penalty DTW 的 dynamic-shadow review-only 路径;携带旧 `dataset/piece/recordingId` 也不能再绕回历史 replay。RF 只保留为 `authorizationIgnored=true` 的 telemetry。
- 冻结候选策略为 `deviation<=0.15`,`eventConfidence>=0.4`,`relativeEventConfidence>=0.8`,`eventDuration>=0.08s`,`same-pitch distance>=0.5 quarter`,`eventDurationRatio>=0.15`;因果能量否决无冻结部署物,状态锁定为 `excluded-review-only`,不能暗中进入决策。2026-07-18 负责人决定(路 B,记录见 `data/experiments/western-ordinary-energy-veto-exclusion-decision.json`):能量否决正式排除,不再作为受控试点/发布的前提门槛。这只修正了 decision/release-review/live-evidence 三处与冻结策略矛盾的门槛(现要求 `causalEnergyStatus==="excluded-review-only"` 而非 `energyVetoIncluded===true`);r3 acceptance 与候选审计层对 `energyVetoIncluded===false && causalEnergyStatus==="excluded-review-only"` 的强校验不变——若能量被悄悄启用,r3 接受性会 fail-closed。本决定当时不打开任何东西;2026-07-19 授权接线完成后 ordinary 轨才因负责人常备批准而 `authorizationReady=true`(见下),两次改动各自独立、职责不重叠。
- 普通音频运行时已迁到独立 `data/tools/western-ordinary-dynamic-shadow-py311/`:禁止 system/user site,完整依赖集与 requirements lock 精确绑定,Basic Pitch SavedModel 三文件 tree SHA-256=`c6595f299ff83c52e89555789f7e3e829a6a0f25b6a88f7e99073af5a2470dc4`。config 语义 SHA、lock SHA 与模型 tree SHA 另由代码常量锚定,不能通过同步改写 manifest 自签名降级;每次分析还把 launcher attestation 写入 cache/candidate artifact。它不与 HOMR 的 NumPy>=2.4 环境共享。venv 本体仍位于 gitignored `data/tools/`,新检出环境须运行 `npm run western:ordinary-dynamic-shadow-runtime-setup`;未配置时 preflight 按设计失败。
- 服务端会独立计算上传音频 SHA-256,并复核 cache realpath、同一字节的 artifact SHA、内部 cache/runtime identity、模型 hash、策略版本及当前 score payload SHA。ordinary 路径强制 `limit=0`;除候选行数必须等于当前 score 的完整音符数外,还逐音核对唯一连续的 `noteIndex=0..N-1` 以及 `noteId/sectionId/measureIndex/midi`,并绑定两侧 identity digest。截断、重复一音或漏一音都不能把局部覆盖率伪装成全曲接受性。candidate artifact 自身再写入 SHA-256;二次审计会重读当前 score store 和全部候选行,不再只相信前 5 条 preview。
- 二次审计还把 artifact 内部 `batchRunId/submissionId`、scoreId、audio SHA 与 batch item 逐项绑定;JSONL 物理尾行损坏、跨提交替换、symlink/路径错位、同批 legacy ordinary status 或任一 item 尝试自动诊断都会失败,不会回退上一条“好记录”。
- r3 接受性合同骨架要求固定 `r3-02/r3-03`、冷 miss/热 hit、完整 score 行数+逐音 identity、内容哈希、候选覆盖、全行 review-only、全 artifact 审计和整体 evidence digest。live artifact verifier 已于 2026-07-18 实现并接入 status(每次构建重读/重算全部引用产物);字段完整且 digest 自洽的伪造报告仍不能开绿,因为逐产物哈希、runtime identity、逐行策略重算与 candidate evidence digest 都会被独立复核。旧 RF session 聚合已移入 `historicalEvidence`,当前计数和 `v2AlphaGate.ready` 固定为 0/false。
- 旧 controlled-pilot runner 已移除默认 RF executor。2026-07-18 更新:`western-ordinary-dynamic-shadow-pilot-executor-v1` 与 `western-m3plus-pitch-safety-pilot-executor-v1` 均已实现并接线(review-only telemetry 语义:模型 auto-pass 结构性为 0,shadow 选中数只作人工复核遥测;M3+ 侧审计最新批的 gold-free 证据与 runtime 描述符)。start preflight 不再因 executor 缺失阻断,但仍因证据/授权位 fail-closed;伪造批准依旧不能启动任何执行。
- 当前 live 状态(2026-07-19 更新):`foundationReady=true`,`liveArtifactVerifierReady=true`,`r3AcceptanceReady=true`,`freshBlindEvidence.ready=true`,`authorizationReady=true`,`studentGateReady=false`,`automaticAdoptionReady=false`。live artifact verifier 已实现并由 `npm run test:western-ordinary-dynamic-shadow-acceptance` 的 11 项伪造/篡改场景验证(含哈希重绑定+digest 重算的复杂伪造,全部 fail-closed);status 每次构建都对验收 JSON 引用的全部磁盘产物重读重算,过期即红。reserve take `r3-02/r3-03` 冷/热验收已实跑通过并视为已消费。`authorizationReady` 现由负责人常备批准文件派生(见下"授权接线"小节),粗粒度绑定 scope-contract 版本,不重复校验逐条证据摘要——证据新鲜度仍由 `r3AcceptanceReady`/`freshBlindEvidence.ready` 独立把关。`studentGateReady`/`automaticAdoptionReady` 与授权状态结构性无关,永远由单独的学生端开关控制,本次改动未触碰。
- 2026-07-18 以已污染、仅供基础设施复核的历史 `r3-01` 提交做了受限冷/热重跑:`strings-batch-mrpytpgd-kxkws5` 为 schema-3 cache miss,`strings-batch-mrpyuerg-wa5yec` 为同一 artifact cache hit。两次均为全谱 `59/59`,dynamic-shadow telemetry 选中 54 行,候选行 SHA-256 同为 `5a89f5f30ed349210b287ad682316bbeb6f8c50f2394076dc4e834c6a5d65c1d`,且 `runtimeAttestationReady=true`,`autoPassCandidateCount=0`,`autoDiagnosisIssued=false`,`studentFacing=false`。补上逐音 identity 防篡改后,又以同一历史素材热跑 `strings-batch-mrpzqs9h-f8fien`:全谱 `59/59`,`scoreNoteIdentityReady=true`,score/candidate identity SHA-256 同为 `ce816a0e0bed67d72498996d8b1e59eb84f7562e08830df717dbb4a294d423ea`,候选 artifact SHA-256=`e7c938cc5be0db025ad8b090c98cd24191651f1e02077a6f427141bc2457255b`。公开 `npm run western:controlled-batch-candidate-audit` 默认要求 ordinary item,对物理最新热跑重读 score store 与全部候选行后 0 failure。上述重跑都不计入 `r3-02/r3-03` 接受性,也不构成 fresh-blind 或发布证据。

## 2026-07-15 第二轮 8 份录音更新

- 第二轮 8/8 组音频、MusicXML 和谱面图片已审计、标准化并完成受控机器分析,总计 444 个谱面音符。
- 旧 MusicXML 导入会把部分多小节谱压缩到第 1 小节;该缺陷已修复并增加结构闸门。7 份受影响 score 已在备份后原位重建,8 份现在的小节数、音符数和唯一 ID 均与源谱一致。
- `r2-08` fresh-blind 精确受控试验已执行:60 个候选、3 个模型原始 auto-pass,但范围内和自检通过的 auto-pass 均为 0。试验正确中止,未发布学生反馈,不需要教师复核空候选。
- 新一轮 M3+ 只完成 review-only 库存清点:444 个音符中 292 个被列为行为候选;这不改变运行时门槛。
- 已找到随录音放置的 `README-怎么用.md`,确认 `r2-02` / `r2-03` / `r2-04` 的错误数量分别为 5 / 5 / 4。README 没有具体小节且 `notes.txt` 仍缺失,因此只能做数量对照和机器位置搜索,不能计算精确 recall/precision。
- README 数量约束下的 Basic Pitch + 序列 DTW 搜索得到:错音阈值候选 5 个;漏音保守候选 3 个,未覆盖 README 目标数量;拖拍阈值候选 5 个,按目标数保留前 4 个。它们均为未人工确认的机器假设,没有进入学生反馈。
- 当前默认学生发布仍关闭。旧 RF 受控证据的 precision=1/coverage=0.04 只解释路线转向,不是实时 blocker。2026-07-18 更新:ordinary dynamic-shadow 为 `foundationReady=true`,live artifact verifier 已实现、r3 接受性已通过,因果能量否决门槛已正式排除,剩余仅独立授权关闭;M3+ gold-free runtime foundation/物理 audit 通过且 v2 离线证据已完整(declared-only 与独立 gold 缺口均已关闭),剩余为独立授权;M4 OMR 自动采纳仍未达标。
- M3 core 的历史人工/gold 闸虽通过,pitch/onset/missing 三类有效错误样本各只有 `2` 个（均 2/2,unsafe=0）;这是低浓度证据,不能把 100% 小样本写成充分扩证。

## 1. 当前目标

构建西洋弓弦乐练习诊断系统:

- 输入: clean MusicXML/MIDI + audio,或 review-only 的 JPG/PNG/WebP 单页谱面照片 + audio。PDF/图片 OMR 属于 M4 谱面侧能力,必须先过 OMR 闸门;当前浏览器照片入口不接收多页 PDF。
- 输出: 高置信音准 / 起音 / 漏音等基础诊断; 低置信或未验证类别进入复核。
- 原则: validation-first, fail-closed, 机器先自测, 只有未知或危险样本才找教师复核。

## 2. 当前运行时安全态

当前 `npm run western:project-status` 报告:

- `ordinaryUploadAutoFeedbackReady=false`
- `m3plusAutoFeedbackReady=false`
- `m4OmrAutoScoreReady=false`
- `policy=fail-closed`

也就是说, 默认学生端仍不会收到未经明确受控试点放行的自动硬反馈。

## 3. 当前机器证据

### 普通上传候选 gate（旧 RF 证据与当前 dynamic-shadow 分层）

历史已完成、但不再具有当前授权力的证据:

- 60 条候选人工标签:46 usable / 14 wrong。
- confidence pilot、fresh blind validation、threshold-pool runtime-policy audit。
- 5 批独立机器受控 pilot 已安全完成,默认运行时均已恢复关闭。
- 旧 RF runtime scorer 与 first-measure-only 显式 pilot scope 曾接入;`npm run western:ordinary-monitored-pilot-audit` 与 `npm run western:controlled-pilot-evidence-audit` 的旧结果曾通过机器前置检查。
- 上述 release review、负责人 approval、pilot decision 和 `readyForMonitoredPilot` 现均为 `superseded`;不得再用 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1` 恢复旧路径。

历史关键结果（仅解释路线转向）:

- 全曲 operational:275 候选 / 33 个模型原始 auto-pass / 11 个严格 eligible;precision=1.0,但 coverage=4.00%,不达 V2-alpha 20% 下限。
- 联合 threshold sweep 没有找到能同时满足 precision>=0.90 与 coverage>=0.20 的全曲阈值。
- first-measure-only + confidence>=0.95 历史留一录音:12/12 usable,precision=1.0,coverage=25.53%。
- first-measure-only 真实机器 pilot:11/11 usable,0 wrong,0 unknown,precision=1.0,coverage=26.83%,覆盖 5 条独立录音/曲目。
- `machinePreflightPassed=true`,`teacherReviewAllowed=true` 是 `r2-08` 入场前的历史授权,只允许准备一份全新、小型、第一小节范围的专业盲审包;该授权已由后续 `r2-08` fresh-blind 执行消耗,不再表示当前仍缺一份待复核包。

当前结论:

- 旧全曲/first-measure RF 路线仍不达当前 V2-alpha 授权要求。`r2-08` 的 3 个模型原始 auto-pass 经旧 scope/self-check 后可放行为 0,该结果已完成其负证据作用。
- 仍欠一项只读历史尸检:逐条解释 `r2-08` 这 3 个模型原始 auto-pass 分别被 scope 还是 self-check 的哪条规则抑制。该记录只用于改进普通上传可观测性,不得复活 RF/first-measure 授权,优先级低于当前 dynamic-shadow live verifier。
- 当前执行权威是文件顶部的 `western-ordinary-dynamic-shadow-policy-v1`:Basic Pitch + gap-penalty DTW 基础层已就位。live artifact verifier 与篡改拒绝测试已完成(2026-07-18),reserve take `r3-02/r3-03` 冷/热缓存与候选一致性验收已通过。该验收只关闭实现正确性缺口,不产生 pilot 授权。
- 现有 12 条旧录音全部已经进入训练/复核证据;`r3-02/r3-03` 用于实现验收后也不得再伪装成 P4 的 fresh-blind 发布证据。
- **`ordinary-dynamic-shadow-full-score-fresh-blind-v1` 已实现并实跑(2026-07-18)。**`npm run western:ordinary-fresh-blind-eval`(评测器 `scripts/eval-western-ordinary-fresh-blind.mjs`)消费一位从未参与过任何阈值调参的新演奏者对 r2-01…r2-08 全部 8 首的完整录音(**沿用原曲目,不是新曲目**,`data/private/western-strings-round2-fresh-blind/`),按三层证据分级并每次都从磁盘重读重算(`liveArtifactAudit`):`clean-full`(r2fb-01/08 正常演奏,谱面即真值,shadow coverage 0.4925/0.7778,均高于 0.2 冻结地板)、`technique-safety`(r2fb-05/06/07 滑音/揉弦颤音/双音,58 个标记区音符经 M3+ 中性化,0 指控——在全新音色上复验了"标记区永不被冤枉"这条结构性安全)、`error-reference-only`(r2fb-02/03/04 确实按要求故意出错,但未记录具体小节位置,**明确标注 `groundTruthPrecision:false`,只作参考信号,不计入任何精度或零漏放声明**)。7 项伪造/篡改拒绝测试(digest 篡改、重算后仍不符、标记区指控注入、覆盖率跌破地板、录音集缺失等)全部 fail-closed。`status.tracks.controlledCandidate.ordinaryDynamicShadow.freshBlindEvidence.ready` 现为 `true`,已接入 next-action 链。2026-07-19 负责人"认"接受本批证据后,ordinary 轨 `authorizationReady` 也已转真(见"授权接线"小节),blocking 归零(仅剩结构性独立的 `studentGateReady=false`)。**诚实说明:** 这批证据满足"受控试点"门槛,但因沿用旧曲目,不满足更严格的"全新录音+全新曲目"发布级 fresh-blind 要求——后者若要做,仍需另取新曲目重复本合同。**操作纪律:** fresh-blind 的 8 条批处理与 M3+ pilot audit 共用同一条 `controlled-submission-batch-runs.jsonl`;重跑 fresh-blind 评测会把这 8 项推成"最新批",打破 M3+ pilot audit 要求的"最新批恰好 1 个 ordinary 项"假设。任何时候重跑 fresh-blind 评测后,必须紧接着用 `western-strings-round3` 单条 manifest 重跑一次单项物理批,再走 candidate audit → pilot audit → release review → decision → preflight → gate 完整 rebind 链,才能让其余闸门回绿。
- 不得默认开启学生端。
- 不得提交或全局设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1`。

### M3+ 音高行为模式

用途: 不展示技巧名,只判断现有证据是否足以安全指控音准问题。

当前发布口径(2026-07-17 重定):

- 决定文档为 `docs/western-strings-m3plus-rescope-decision.md`;颤音/装饰音音频检测、窗边界继续调参和粗状态分类器已退出发布链,只保留为研究证据。
- 统一离线入口为 `npm run western:m3plus-rescope-gate`,输出 `data/experiments/western-strings-m3plus/rescope-gate/report.json`。
- 无标记平拉 holdout:8 个可判、8 个与谱面意图一致、unsafe=0、4 个证据不足;这是受控离线安全 probe,不是整条发布链已通过。
- 谱面保护区(2026-07-18 更新):round2 声明的 6 个 tr 单元已通过补充评测器逐单元实际执行同一四区策略(r2-06 全谱伪单元定位+holdout,6/6 中性且指控数=0,protectedScoreUnits gold join 6/6),冻结库存达到 `evaluatedProtectedCount=14`,`declaredOnlyProtectedCount=0`。此前"只有 8 个 m3p holdout 单元实际执行、6 个仅声明"为历史状态。泛音中性化仍只由规则与回归测试覆盖。
- 揉弦/滑音中心音高的 `3/8=37.5%` 只表示 8 个谱面意图目标中 3 个得到 `confirmed_center`,即 score-intent center agreement/decision coverage;它不是独立人工 intonation gold precision。2026-07-18 更新:负责人已逐单元标注独立 intonation gold(20 条,含 8 个揉弦/滑音目标),join=`8/8`,techniqueCenter 区按四区闸通过;旧 join=`0/8` 为历史状态。
- round2 的 17 个揉弦单元只有“演奏了揉弦”的人工执行确认,没有与上述 8 个候选逐音连接的稳定中心音高标签,继续列为 unscored;不得拿它们补足独立音准 gold。
- 高离散度用原始诊断独立枚举后,3/3 输出 `insufficient_evidence`,指控数=0。
- 当前 v2(2026-07-18):`releaseGateReady=true`,`offlineEvidenceReady=true`,`readyForMonitoredPilot=true`;发布授权与学生闸门仍关闭。离线 probe、gold-free runtime foundation、物理来源 runtime audit、发布授权和学生闸门必须分层报告;任何一层不得替代下一层。
- gold-free runtime policy 只允许从谱面标记、pYIN 帧/有声率、中心/离散度和窗口边界作决定,不得读取 `expectedBehavior`、评测 split 或人工 gold。即使接线成功,保护区、低有声率、高离散度或缺字段仍须 fail-closed,候选与外层输出仍固定 `review_required`,`studentFacing=false`,`feedbackAuthorized=false`。
- 最新物理 batch `strings-batch-mrq5lf8u-cr2dqk` 已产生 59/59 条合同有效的 M3+ 证据,score identity 完全一致,候选 artifact SHA-256=`3b6390877072d1e09591bc9f13f0e22f64b0f3602617cac1f7dd9ada7d7410b4`;`runtimeFoundationReady=true`,`runtimeAuditReady=true`,其中 46 条 `confirmed_center`、13 条 `insufficient_evidence`,没有自动或学生输出。物理审计固定并重哈希 5 个规范 source bindings(machine report、human gold、M3 core gate、rescope decision、evaluator),再核对物理 JSONL 尾批、完整 candidate artifact、score store/score identity、policy、analyzer(raw + CRLF-normalized SHA-256=`65ea46768bf23e51aac4083c3fd08fecbeb2d81d8af4effc5aaae482bc7a279d`)以及 Python/librosa/numpy/pYIN 参数;任一规范路径替换、同批多 ordinary item、runtime 未 ready 或 standalone candidate audit 缺 M3 runtime 都会 fail-closed。这只证明 gold-free review-only 接线可审计。
- `project-status` 每次构建还会从当前磁盘重读候选 artifact、runtime policy、analyzer 和 rescope report,逐项重算 raw SHA-256;任一路径缺失、越界或内容漂移都会把 `physicalEvidenceCurrent/runtimeFoundationReady` 转红,并经同一 live-evidence 判定阻断 release review、decision 与 preflight。缓存 audit 与缓存 release report 彼此自洽不再足以放行。
- `studentGateReady=false`,`m3plusAutoFeedbackReady=false` 保持不变。2026-07-18 更新:上述离线证据缺口已全部关闭——6 个 declared-only 保护单元完成实际执行(14/14),12 个平拉来源单元与 8 个揉弦/滑音目标的独立逐音 intonation gold 已按 recording/measure/unit 连接(负责人标注)。剩余仅为发布授权,需按批准链单独建立。
- 双音 multi-f0 支线范围不变,不由本次单声部中心音高闸门放行。

#### 历史执行证据(保留,不再决定发布)

- 98 reviewed / 74 scored。
- 历史 first-measure 复核集曾把 `slide-like`、`trill-like` 列为离线 release-ready；该结论现已被独立跨后端 holdout 覆盖，不再构成试点授权。
- CREPE tiny/full + pYIN 的冻结物理阈值复验现按技法语义分别使用揉弦 4-8 Hz 周期能量、颤音上下音切换、装饰音开头短促上方音回归、滑音源到目标净移动。holdout 依次为揉弦 precision=`0.60`/recall=`0.75`、颤音 precision 不可定义/recall=`0.00`、装饰音 precision 不可定义/recall=`0.00`、滑音 precision=`1.00`/recall=`0.75`；四类均未达发布线，装饰音另有可靠正例不足。
- 旧 detector 版 `npm run western:m3plus-monitored-pilot-audit` 曾非零退出并报告 `m3plus-independent-mode-not-ready:slide-like` / `trill-like`;这些原因只记录历史检测器为何退出发布链。当前同名 v2 审计改为核对 rescope 来源哈希、物理 batch 与 gold-free runtime contract,且 `runtimeFoundationReady=true`,`runtimeAuditReady=true`;当前审计 blocker 只来自 6 个 declared-only 保护单元和独立逐音 intonation gold/离线区未就绪,项目发布层另因独立授权关闭而 fail-closed,不再以模式名或 runtime audit 未完成作阻断理由。
- control-ready mode `stable` 只作对照，不等于学生端自动放行。
- `teacherReviewNeeded=false`。

范围限制:

- 2026-07-17 supersession 已撤销历史 first-measure + trusted-recording 的 slide/trill pilot authority;现有 12 条和旧复核包均已污染,不得复用为当前授权。未来发布证据必须登记全新录音+新曲目的 fresh-blind 包,且另过 v2 runtime audit 与显式授权链。
- 旧 `slide-like`、`trill-like`、`variable-f0`、`ornament-candidate` 检测器均为 research-only;双音 `double-stop-candidate` 继续单独 review-only。
- 默认学生端 M3+ 自动反馈仍关闭。

2026-07-15 第二轮真实对齐复验:

- `r2-06` 的 6 个颤音和其余长音揉弦已经人工确认实际演奏。
- 谱面实际含 6 个颤音与 17 个其余长音。旧报告的 16 个揉弦分母来自对齐器漏掉第 2 音;现已修正为未匹配音仍计入漏检。
- Basic Pitch 序列 DTW 后的机器检出为:滑音 7/12、颤音 0/6、揉弦 1/17、双音 19/24。
- 新增 `npm run western:round2-m3plus-diagnostic`:23 个音中 1 个未匹配,12/23(`52.2%`)的 DTW 窗口时长不合理。受控时值锚定后的最佳单特征仍只有训练内 precision/recall=`66.7%/66.7%`,未达到 90%;因此不调低阈值、不接学生端。
- 四项均未达 90%;旧 release-ready 结论只适用于 first-measure 安全子集,不得推广。
- 自然泛音音准检测已从 M3+ 当前范围取消,不再要求录音、评测或放行。MusicXML 泛音 pitch-role 解析仅作为通用谱面兼容能力保留,不构成学生端自动音准承诺。
- 第二轮原始报告曾标记“缺真实负例/装饰音样本”，现已被补录证据取代：`m3p-01` 是完整 `8/8` 的真实直音负对照，`m3p-03` 也已提供真实装饰音样本。装饰音仍因 calibration/holdout 各只有 `3` 个可靠正例而处于“已存在但未验证”，`studentGateReady=false` 不变。
- 已生成最小补录包 `音频/m3plus-supplemental/`:4 条均改为“不读谱、固定音符顺序 + 文字要求”,分别覆盖 C 大调上行纯直音负例、独立揉弦/颤音、装饰音/普通音对照、滑音/直音对照。附带的 MusicXML、MIDI、谱图仅供机器校验;`score-intent.json` 仍明确 `performanceConfirmed=false`,不得在录音前计作性能 gold。
- `m3p-01.m4a` 至 `m3p-04.m4a` 已齐全,`npm run western:m3plus-supplemental-status` 实测 `readyRecordingCount=4/4`,`readyForMachineAnalysis=true`。这批实录整体比书面音高一个八度,`score-intent.json` 因此固定 `localizationTransposeSemitones=12`;该偏移只用于定位,不放宽音准或技法判定。
- `npm run western:m3plus-supplemental-eval` 已完成真实 CREPE 评测。约束定位修复了重复同音被压成 `0.01s` 伪窗口的问题；`m3p-01` 达到 `8/8`，`m3p-02/03/04` 的冻结顺序结果为 `10/16`、`14/16`、`13/16`，因此整批仍 fail-closed，`machineAnalysisComplete=false`,`teacherReviewAllowed=false`。但失败是局部的，不再要求整条重录：状态报告保留所有可靠单元并输出 `repairPlans`；`m3p-03` 只缺两轮的首个 D5 装饰音单元，`m3p-04` 的确定失败集中在第二轮末组 F5→G5 滑音和 G5 直音，第 7 小节末直音仅为阈值边界项。失败单元继续 `review_required`，其余单元可继续用于离线评估。
- 新增 `npm run western:m3plus-protocol-order-diagnostic` 后确认:`m3p-02` 并未缺少 16 个单元,而是按同一音高完成两轮后再换音。只读候选顺序 `[1,5,2,6,3,7,4,8]` 可把定位从 `10/16` 提升到 `16/16`,路径成本从约 `0.179` 降至 `0.006`,但这是由音频反推的 post-hoc 协议候选,未自动改写 performance gold。完整定位后,8 个预期颤音里有 7 个存在上方音或音高交替证据；唯一异常是 holdout 第 8 组约 `15.915-16.900s`,没有上方音或交替证据。该单元先标为待确认的演奏偏差,不通过放宽阈值掩盖,也不在未确认前重写正式指标；因此当前颤音 holdout 仍如实报告 precision=`1.00`、recall=`0.75`。揉弦已完成多路线受控对照：CREPE full 与 pYIN 均弱于 CREPE tiny；同录音直音基线、FFT、4-8Hz 自相关、独立谐波 ridge、chroma/onset 及基于上方音的边界重切均未达到 holdout 门槛。固定六物理特征 L2 logistic 在原窗和重切窗均只有 precision=`1.00`、recall=`0.25`,证明问题不是单阈值过简；不得继续在 12 条 calibration 上调分类器。
- `npm run western:m3plus-feature-separability` 对 CREPE full 报告做了独立盲验审计。装饰音在 calibration/holdout 各只有 `3` 个可靠正例,滑音 holdout 只有 `3` 个可靠正例,均低于每类每 split 至少 `4` 个的冻结要求;现有上方音、净移动、单调性和过渡时长特征无一具备可放行证据。因此八度修正、CREPE full 和协议重排均不能替代合规技法执行及足量盲验单元,M3+ 继续 fail-closed。

### M4 双轨状态与 M4b OMR benchmark

2026-07-19 起以附录 C 为现行合同:M4a 是支持库配准产品线,M4b 是开放域结构专用研究线。下列既有 OMR 数字只属于 M4b/历史研究证据,不得再被写成 M4a 的运行时实现或总项目必选条件。M4a 谱库/sidecar 的当前实现状态见文件顶部刷新段。

当前证据已拆成两层,不可混用:

1. **独立研究基准**:公版 clean MusicXML 独立渲染后交给 Audiveris 盲识别。干净数字谱 32 份 mean pitch P/R=`96.85%/93.78%`;合成 scan 6 份=`94.43%/89.23%`;合成 photo 6 份=`94.88%/88.51%`,三域达到研究报告下限。
2. **现有 12 条照片 benchmark**:8 条是有人工 `approved` 证据但未改动 Audiveris 草稿的 `human-approved-unchanged-draft`,4 条是 `independent-edited-gold`。必须按 provenance 分层,8 条未改草稿只能用于复识一致性和失败模式观察。
3. **真实照片独立源谱集**:从公开 Kayser Op.20 LilyPond 源谱按照片曲目与可见小节裁出 5 份 MusicXML gold,并校验源仓库 commit、CC-BY-SA-4.0 许可和逐文件 SHA-256。修正 Audiveris 多 movement 合并后,5 份合计 pitch P/R=`84.71%/71.50%`,严格 P≥98% 且 R≥95% 通过 `0/5`。

当前 `npm run western:m4-preflight` 结果:

- `readyForOmrAccuracyClaim=true`
- `independentCleanRows=32`
- `independentScanRows=6`
- `independentPhotoRows=6`
- `strictPerPiecePassedRows=12/32`(`37.5%`)
- `independentRealPhotoRows=5`
- `realPhotoStrictPassedRows=0/5`
- `realPhotoPitchPrecision=0.847086`
- `realPhotoPitchRecall=0.715016`
- `automaticAdoptionReady=false`
- `studentGateReady=false`
- `teacherReviewNeeded=false`
- `scoreEditorReviewNeeded=false`
- `humanTask=none`
- 运行时可见 OMR 置信探针(32 首、按 6 个 BWV 作品留一):LR AUC=`0.567`,RF AUC=`0.800`;RF 最佳观察点 precision=`0.80`、coverage=`0.156`,没有达到 `0.90/0.20` 的安全子集。
- 真实照片预处理 sweep(5 份×`up2/up3/up2-otsu`):`up2` 最佳,平均 P/R=`85.59%/72.18%`;`up3`=`76.88%/63.52%`;Otsu=`61.72%/50.42%`且一份无输出。按曲事后挑最佳变体仍为严格 `0/5`,因此不把 `up3`/Otsu 接入生产。
- P0 谱号/调号/拍号 fail-closed 证据提取已修复无 `shape` 的 key 与 `time-whole` 节点；冻结 5 张真照片现为完整 `1/5`，分项谱号/调号/拍号=`3/5,2/5,2/5`。剩余冲突仍拒绝，`m4OmrAutoScoreReady=false`。
- 《北京的金山上》人工 MusicXML 已作为新的独立真照片 gold。OMR 报告现以 recall/漏识率为第一指标：现有 `up2` pitch R/Miss/P/F1=`35.47%/64.53%/87.14%/50.41%`；修正对比度参数后的自适应谱线缩放为 `16.28%/83.72%/28.28%/20.66%`。自适应路径在该页输出更多但漏识和误识都更严重，已按独立 gold 停止接入，不用音频吻合率替代 OMR 准确率。
- 更强 OMR 引擎对照已完成:`npm run western:m4-oemer-benchmark` 用 Oemer 0.1.8 在同一 5 份 source-gold 上串行评测。`ex05` 原始截图的播放器黑边曾诱发错误 3-track 结构；现在只对该明确失败执行固定行均值裁边重试，Oemer 由 4/5 提升为 5/5 可输出。全 5 份 P/R=`71.87%/76.23%`、onset-quarter/measure accuracy=`5.43%/18.21%`，严格仍为 `0/5`；同 5 份 Audiveris P/R=`85.47%/72.14%`。fallback 解决的是引擎崩溃和坐标缺失，不足以让 Oemer 替换 Audiveris 或进入生产。
- Oemer 坐标适配已完成但保持 review-only:`run_oemer_with_coordinates.py` 从实际发射 MusicXML 的 `AddNote` 动作保存音头 bbox 和干净 dewarp 画布,不修改第三方包。5 个输出页的坐标数均与 XML 音符数一致，新增裁边页为 `289/289`；正式报告为 `coordinateAdapter.readyRows=5/5`,`studentFacing=false`。坐标可画不改变 OMR 严格 `0/5`。
- Transformer OMR 的 2026-07-15 首跑曾报告 pitch P/R=`89.00%/96.17%`,onset-quarter/measure=`30.73%/79.04%`;这是可追溯的历史四舍五入口径,不是当前权威数字。2026-07-17 用 ONNX Runtime 1.27.0 从零复验后的权威值为 pitch P/R=`88.33%/95.78%`,onset-quarter/measure=`30.03%/79.04%`,完整严格门槛仍为 `0/5`;HOMR 只进入受控离线候选池,未获自动采纳授权。
- 第三方视觉 Transformer 对照已完成:`npm run western:m4-clarity-benchmark` 用 Clarity-OMR 官方 beam-5 管线评测同一 5 份 source-gold。原始截图因播放器黑边/标题栏导致 Stage A 检出 `0` 个谱表;使用冻结的通用行均值裁页后 5/5 均输出,但聚合 pitch P/R=`72.77%/35.53%`,onset-quarter/measure accuracy=`2.81%/10.10%`,完整严格通过 `0/5`。该裁页仅用于公平评测,Clarity 不接生产。
- Clarity 监督适配的非人工前置已跑通:`npm run western:m4-clarity-adaptation-data-probe` 从一页独立 Bach MusicXML 生成 8 个去重谱表图像/标签对,无盲测照片混入;`npm run western:m4-clarity-adaptation-split` 按 BWV 作品拆成 train/validation/synthetic-test=`21/4/7`,5 份真实照片 gold 冻结在训练集之外。
- `npm run western:m4-clarity-training-step` 已在本机 RTX 5060 上完成一次 bf16+DoRA 反向传播:可训练参数 `8,946,222`(`5.1933%`),loss 有限、576 个参数张量获得有限梯度,峰值 reserved 显存约 `1.08 GiB`。官方权重中 48 个缺失键经核验为共享 FFN 别名,另 4 个为官方推理权重未包含的训练辅助 contour head;脚本对除此以外的缺失键 fail-closed。
- 受限多作品适配已完成:32/32 个 Bach movement 生成 592 个原始/296 个去重 staff-token 对,按作品得到 train/validation/synthetic-test=`199/39/58` 条,无作品、图片哈希或真实照片盲测泄漏。64-step DoRA 峰值 reserved 显存约 `1.21 GiB`;teacher-forced 与自回归 held-out 指标均有提升,说明训练确实改变了模型而非空跑。
- 冻结 5 张真实照片给出了决定性否定结果:候选 5/5 可输出,但聚合 pitch P/R=`80.00%/31.44%`,onset-quarter/measure accuracy=`2.04%/6.26%`,严格通过 `0/5`。对比官方 Clarity 基线 `72.77%/35.53%`、`2.81%/10.10%`,候选只提高 precision,其余三项退化;自动适配决策为 `reject-and-delete`,候选权重已排除出产品与后续评估。
- 公开 DoReMi v1 的有界监督适配 pilot 也已完成:只解压 3 部弦乐四重奏,按作品得到 train/validation/synthetic-test=`96/48/48` 个谱表对,32-step DoRA 将 held-out 数字谱 token accuracy 提高约 9-10 个百分点。但冻结 5 份真照片上候选仅得到 pitch P/R=`75.94%/36.10%`,onset-quarter/measure=`5.18%/6.65%`,严格 `0/5`;measure 低于官方 Clarity 的 `10.10%`,再次按完整四指标规则 `reject-and-delete`。这证明仅追加干净公开谱可改善数字谱域,但不能修复真照片的节奏/小节结构。

结论:

- M4b 已完成可复跑的独立**研究级** OMR 准确率基准,可以报告限定范围内的数字谱/合成退化结果。
- M4b 尚未达到开放域自动采纳:逐谱严格门槛仅 12/32,真实照片独立源谱按 pitch+onset+measure 完整门槛严格通过 `0/5`,运行时置信特征也筛不出安全子集。OMR 不会进入学生端运行时自动诊断;这不否定也不放行独立的 M4a 支持库配准产品线。
- Clarity 监督适配已完成 Bach 和 DoReMi 两次从数据生成、无泄漏划分、低负载训练到冻结真照片的完整闭环,但真照片完整指标都有退化,候选均已拒绝并清理。该路线不再继续堆干净数字谱、训练步数或调参;除非以后新增拍照域退化、符杠/符尾/休止/附点与小节结构级监督,否则 Clarity 只保留为负基线,`studentGateReady=false` 不变。
- 维持“当前不可自动采纳”的裁决不需要教师或制谱人员继续操作。新增真实照片 gold 的基础证据缺口已经关闭,Audiveris 预处理/置信筛选、Oemer、HOMR 与 Clarity-OMR 均未达到完整门槛;继续扩大照片只增强外部效度,不能掩盖当前 `0/5`。若主动推进第 2 份同版 gold,仍可完成 Op.45 候选的四项人工复核,但该可选任务不是当前 fail-closed 裁决的阻塞项。
- 报告论文/表格时必须将独立 render-gold 与 `human-approved-unchanged-draft` 分开,后者不得伪称独立照片准确率。

照片谱离线生产链现已接通:

- 浏览器 multipart 上传、JPG/PNG/WebP 文件签名校验、照片/录音独立哈希缓存与队列预览已完成。
- 人工标记为 batch 后,一般受控批处理会分派到照片谱分析器;每次最多处理 5 条以限制本机负载。
- 结果固定为 `photo_score_review_ready`,写入 `photo-score-batch-runs.jsonl`;`autoDiagnosisIssued=false`,`studentFacing=false`。
- multipart、伪造 MIME、缓存越界路径、批处理分派、审计落盘和桌面/移动浏览器交互均有回归验证。
- 真实照片独立源谱 gold 已有 5 份,但严格通过率为 0/5;多引擎、预处理或音频仲裁原型都不能替代精度门槛。因此 `m4OmrAutoScoreReady=false` 不变。

## 4. 当前下一步（第二轮旧结论已 supersede）

`r2-08` 已完成旧 RF/first-measure 路线的全新素材入场和精确受控机器试验;结果不是发布通过,而是没有候选通过旧窄范围自检。该结果保留为历史负证据,不再决定当前 ordinary 执行顺序。

下一步分两条,不得混为一项:

1. **ordinary dynamic-shadow verifier → 接受性(2026-07-18 已完成):** live artifact verifier 已实现(`scripts/audit-western-ordinary-dynamic-shadow-acceptance.mjs`):重读并重算验收 JSON 引用的每个磁盘产物(cache/candidate artifact SHA、音频与 score store 绑定、runtime identity 预考、逐行 review-only、按冻结策略重算每行 selected、candidate evidence digest 与整体 digest),伪造拒绝测试覆盖 11 种篡改(含重算 digest 的复杂伪造)均 fail-closed;`buildOrdinaryDynamicShadowStatus` 每次都跑 live 复核,报告过期即红。随后 reserve take `r3-02/r3-03` 冷/热双跑验收实跑通过(45/45 行 coverage 0.7778、51/51 行 coverage 0.9412,冷 miss/热 hit,冷热 evidence 稳定,`autoPassCount=0` 全行 review-only),`r3AcceptanceReady=true`。材料自此视为已消费,不得复用为发布盲测;能量否决门槛已按 2026-07-18 负责人决定正式排除,fresh-blind 证据已按 2026-07-18 负责人决定正式接受(见下"授权接线"小节),ordinary 轨 `authorizationReady` 现为 `true`,blocking 归零(仅剩结构性独立的 `studentGateReady=false`)。
2. **M3 duration/extra 定量补证(2026-07-18 已完成):** 量化合同已冻结为 `western-duration-extra-quantization-v1`(单位: 相对 IOI 偏差比/时值比/±3s 同音高未匹配事件;容差全部复用已冻结数值 0.15/0.15/3.0,零新调参;unsafe=目标与后继均被 6-guard shadow 选中即"完全不可见";分种子聚合含显式最差种子)。消费结果:v2 六套注入集 drag 4/24 不可见(20/24 timing 可见)、extra 0/30 不可见、wrong/missing 硬漏放 0/60 复现;r3-04/05 负责人确认真值 drag 0/2 不可见、extra 1/3 不可见(真实重复音被合并吸收的诚实案例);自然学生域 5 条干净录音 mean coverage 0.8656、timing flag 负担 7.67%、extra 负担 2.33%。duration/extra 仍为 review-only,该证据 preGateOnly。命令: `npm run western:duration-extra-quantization` / `npm run test:western-duration-extra-quantization`。
3. **fresh-blind 证据(2026-07-18 已完成,带诚实星号):** `ordinary-dynamic-shadow-full-score-fresh-blind-v1` 已实现并实跑,消费一位从未参与调参的新演奏者对原 8 首曲目的完整录音,三层分级(clean-full 覆盖率过冻结地板、technique-safety 58 标记区 0 指控、error-reference-only 明确标注非精度证据),7 项伪造/篡改测试全过,详见上方"2026-07-15 第二轮更新"小节。**星号:** 沿用旧曲目而非全新曲目,只满足受控试点门槛,不满足更严格的"全新录音+全新曲目"发布级要求——真要做后者仍需另录新曲目重复本合同。
4. **授权接线(2026-07-19 已完成):** 负责人在对话中口头"认"接受第③项证据并再次确认"批"过受控试点。`authorizationReady`(ordinary 与 M3+ 两轨)原为代码里硬编码的 `false`(无任何产物驱动),现改为从负责人常备批准文件(`data/experiments/western-strings-controlled-pilot-approval.json`)派生:文件须 `pilotApproved===true`、`approvedTracks` 含该轨、`scopeContract` 精确匹配当前 `western-ordinary-dynamic-shadow-release-v1+m3plus-rescope-four-zone-v2`、两项安全确认为真、`approvedBy`/`approvedAt` 非空——五类缺陷分别独立报出各自 blocking reason(见 `scripts/test-western-status-track-authorization.mjs` 10 个场景)。**设计上刻意粗粒度**:只绑定 scope-contract 版本号,不绑定逐条证据摘要——证据新鲜度已由 `r3AcceptanceReady`/`freshBlindEvidence.ready`/M3+ 五区闸门独立、逐次重算把关,两者外部相与(AND),任何一侧过期都会让 `readyForControlledPilot`/`readyToStartControlledPilot` 重新转红。授权接线后链式 rebind(release review → decision packet → start preflight → project gate)全部确认:`readyForControlledPilot=true`,`readyToStartControlledPilot=true`,`okToStartControlledPilot=true`。**这只代表受控试点现在"可以启动",并未执行**;`studentGateReady`/`automaticAdoptionReady` 两轨均保持结构性硬编码 `false`,与授权状态完全无关,学生端三个运行时开关未受任何影响。
5. **后排 M4 坐标补强:** v3 池当前无 Oemer;HOMR 在 12 份历史缓存中赢 8 份,但输出仍是无 bbox 的音符列表。可复用 Oemer sidecar 的设计经验为 HOMR 增加坐标适配器,同时先建立一小批人工坐标 gold/误差标尺;当前 `coordinateGoldReady=false`,不得仅凭“框数等于音符数”把列表反馈升级成像素框选。
6. **低成本照片域扩证(负责人约 15 分钟,非当前 fail-closed blocker):** `r2-camera-photo-benchmark` 现有 8 张其实是与生成器字节相同的 clean render;另有 8 张真实屏拍须继续按 `screen-photo-of-pdf` 单独分域。若把 8 页打印后逐页手机拍摄,构造 gold 可直接沿用,可将纸拍 source-gold 从 5 行扩到 13 行,但必须先过输入域分类再计 `CameraPhotoRows`。可顺手提交 Op.45 四项复核 JSON 将同版 gold 页数从 1 增至 2;因候选起点来自 HOMR,该页仍不能计作 HOMR 自身独立自动采纳证据。

### 录音需求封顶承诺(2026-07-19,负责人质询后确立)

负责人质询"每次说够了又让补录"后,此处白纸黑字封顶:**从今天起到上线,负责人需要提供的采集工作总账如下,录完即封死,不再新增。**

| 项目 | 数量 | 用途 | 状态 |
| --- | --- | --- | --- |
| 新曲目录音(round4) | **6 首**(2 正常 + 2 技法[揉弦/颤音一首、滑音一首] + 2 故意出错且**记录小节位置**) | 发布级 fresh-blind:全新曲目+已知真值,补齐 r2fb 八条"未记错误位置"的最大缺口 | 谱面由我制作交付,待录 |
| M4a 验收拍照 | 约 **15 分钟**(屏拍 ≥10 张 + 错版/错曲混入 ≥5 张) | M4a 支持库配准验收(附录 C),不是录音 | 待拍 |
| 试点期间录音 | **0** | 试点消费的是学生自然产生的录音,负责人无需补录 | — |

之前多轮"补录"的诚实复盘:每一轮消耗都符合证据纪律(调参用过的录音不能再当盲测),但错在从未一次性给出总账,导致需求看起来无限追加。本条款即总账。

**仅有的两个重开例外**(除此以外任何人以任何理由要求负责人再录音,均视为违反本条款,状态工具与手册不得为其背书):

1. **考试不及格重修:** 6 首录音跑发布级 fresh-blind 后若未通过冻结门槛(如故意错音漏检/标记区误指控),需要针对失败项重录或补录——这是系统没考过,不是需求追加。
2. **负责人主动扩范围:** 负责人自己决定扩大曲目域/乐器域/演奏者数(如大规模覆盖阶段),属于新目标新账,不算本承诺违约。

第二轮命令:

```bash
npm run western:round2-intake-status
npm run western:round2-machine-analysis
npm run western:round2-scenario-search
npm run western:project-status
npm run western:project-gate
```

以下内容只保留为旧 RF/first-measure 入场链的历史审计说明,不得作为当前 dynamic-shadow 后续批次操作规范。将来可复用其中“新录音/新曲目/哈希去重/授权完整”的输入纪律,但必须另建版本化 dynamic release 合同和命令链:

### 历史 V2-alpha 第一小节安全子集入场（superseded）

仅作历史复现的具名入口为:

```bash
npm run western:historical-fresh-blind-intake-init
npm run western:historical-fresh-blind-intake-status
```

历史复现也不得手改 `intake.json`。当时三个文件就位后使用的原子化登记命令现为:

```bash
npm run western:historical-fresh-blind-intake-stage -- --recording-id <new-recording-id> --piece-id <new-piece-id> --audio "<audio-path>" --score "<musicxml-or-mxl-path>" --score-display "<pdf-or-image-path>" --reviewed-by "<reviewer>"
```

该命令先审计临时清单；任何重复、解码失败、谱面解析失败或审核信息缺失都会保持正式 `intake.json` 不变。

旧入场闸门通过后，当时的 RF 机器预检会精确指定全新录音；下列命令不再授权当前 dynamic-shadow:

```bash
npm run western:ordinary-auto-pass-precision-review-pack -- --recording-id <fresh-recording-id>
```

若该录音没有候选、出现不安全候选或被历史证据排除，立即停止，不生成教师复核包。

模板位置:

- `data/private/western-strings-v2alpha-blind-intake/intake.json`

需要放入并填写:

- 一条未参与任何训练、复核或 pilot 的新小提琴录音。
- 一份已人工核对的 clean MusicXML/MXL,且第一小节有可分析音符。
- 对应 JPG/PNG/PDF 谱面显示文件,用于后续页面定位质检。
- 新的 `recordingId` / `pieceId`、审核人、授权和许可状态。

入场闸门会自动检查:

- 录音 ID、音频内容哈希是否曾出现。
- 曲目 ID、谱面内容是否曾出现(默认要求新曲目)。
- 音频能否由 ffprobe 解码、时长是否有效。
- MusicXML/MXL 能否解析、单声部或唯一小提琴声部能否确定、第一小节是否有音符。
- 谱面是否已批准、显示谱页是否真实存在、授权字段是否齐全。

第二轮 `r2-08` 已实测 `readyForMachinePrecheck=true` 并完成旧 first-measure 机器试验。该 intake/审批链只保留为历史审计工具,不能授权当前 dynamic-shadow 路径。未来若启动发布证据批次,必须使用全新录音和新曲目,以当前版本合同重新生成 release review、approval 与 decision;现有 12 条和 `r3-02/r3-03` 实现验收材料都不能复用为该 fresh-blind 证据。

当前 dynamic-shadow 不限于 first measure,但所有候选一律 `review_required`;在 r3 接受性报告和独立授权合同同时成立前,不得生成学生 auto-pass 或沿用旧专业盲审 scope。

## 5. 当前不可声称

- 不可声称任意普通上传音频已经默认实时自动诊断。
- 不可声称 M3+ 已可广泛对学生端开放。
- 不可声称 M3+ 是技巧名称识别产品。
- 不可声称 OMR 已进入运行时判断层。
- 不可声称支持大提琴; 大提琴需要 M5 独立验证。

## 6. 当前回归命令与历史审计边界

- `npm run western:m4-preflight`
- `npm run western:controlled-batch-candidate-audit`(只审物理最新 dynamic-shadow run)
- `npm run western:project-status`
- `npm run western:next-actions`
- `npm run western:ordinary-dynamic-shadow-runtime-preflight`
- `npm run test:western-ordinary-audio-runtime`
- `npm run test:western-dynamic-shadow-policy`
- `npm run test:western-offline-feature-audio`
- `npm run test:western-alignment-preview`
- `npm run test:western-project-gate`
- `npm run build`

以下命令仍可复跑历史证据,但不属于当前授权链:`npm run western:controlled-pilot-evidence-audit`、`npm run test:western-fresh-blind-intake`、`npm run western:historical-fresh-blind-intake-status`。旧 `western:fresh-blind-intake-init/stage/status` 现在会在任何读写前非零退出,只有显式 `--historical-replay` 的具名别名可访问旧流程。其中 `r2-08` 入场审计历史上曾通过且该授权已经消费;不得把其结果写成当前 dynamic-shadow pilot 或 release 批准。

`npm run western:project-gate` 当前仍以非零退出阻断默认发布(`projectReleaseReady=false`),失败为(2026-07-19 更新:两轨 `*-authorization-closed` 均已因负责人授权接线清除,M4 必选项已按具名签署改绑 M4a):

- `m3plus-student-gate-closed`(结构性硬编码,与授权无关,学生端仍需单独批准)
- `M4a supported-edition registration`(谱库、配准运行时、C.2a-f 工程验收和错版真实屏拍 8/8 拒绝均已现场验真;尚缺拍摄包所列 10 张精确登记版本屏拍,之后由机器生成低质拒绝集并交负责人逐框确认)

注意:ordinary 轨此前的 `blockingReasons` 现为空数组,但因为 M3+ 学生闸与 M4a 仍未达标,`ordinaryUploadAutoFeedbackReady`/`m3plusAutoFeedbackReady`/`m4OmrAutoScoreReady` 三个学生端运行时开关**均未受本次改动影响,仍然是 `false`**;M4b 自动采纳也继续独立关闭。当前打开的只是受控试点的"可启动"状态(`readyToStartControlledPilot=true`),不是学生发布。

这是安全态,不是命令故障;维持该裁决不依赖补交复核数据。

## 7. 公开 Bach 语料主开发决策(2026-07-10)

由于无法持续获得大量真实学生录音,当前主开发和压力测试改用 65 个公开专业小提琴乐章。详细数据、指标和限制见 [western-strings-public-bach-validation.md](western-strings-public-bach-validation.md)。

当前新增机器证据:

- unseen-performer 对齐:precision@300ms=92.81%,coverage=95.08%,median=35.4ms,p90=215.5ms。
- 独立 Basic Pitch 高精度子集:precision=90.50%,recall=77.67%。
- rawv2 原始波形测试:漏音/错音/迟到在 development 与 holdout 均为 0 危险放行;holdout 干净 precision=97.59%,coverage=33.05%。
- 弱音模型 bake-off 全部失败:最佳模型仍漏放 3/12 个 holdout 弱音,因此 weak-note 固定为 review-only。

统一状态:

- `publicProfessionalV2AlphaReady=true`
- `publicRawAudioCorePrototypeReady=true`
- `publicWeakNotePrototypeReady=false`
- `v3Ready=false`
- `nearPerfectReady=false`
- `defaultStudentReleaseEligible=false`

本节替代“当前必须继续采集大量学生录音才能开展开发”的说法。公开专业录音足以继续研发、比较模型和形成论文实验,但没有真实学生域证据时,不得声称默认学生发布安全或完美识别。

## 8. PHENICX 人工 gold 前置审计(2026-07-10)

下一环节 PHENICX 数据许可、下载和结构审计已通过:`readyForAlignmentBenchmark=true`,4/4 作品、22 条同步小提琴分轨、2,969 个逐乐器人工对齐音符。完整边界和进入条件见 [western-strings-phenicx-validation.md](western-strings-phenicx-validation.md)。

PHENICX 适配器与人工 gold 工程闸门现已通过。development 选出的 `parangonar-with-basic-fallback` 在 Mahler/Bruckner holdout 上达到 coverage 1.000、median 32.9ms、p90 352.6ms、`hit@300ms=0.8834`,两首逐曲均过闸。复音子组仍未过(`hit@300ms=0.836`,p90 536.3ms),且 fallback 加入前已查看过第一轮 holdout,因此必须另用新外部数据冻结确认;`studentReleaseEligible=false`,不得表述为完美对齐或学生域完成。

## 9. MUSC 识别与开放弱标签扩展(2026-07-10)

MTG MUSC 预训练模型已完成 eval-only 接入。默认 127.7ms 最短音长在快速乐章漏音,因此仅用 Emil development 六曲做 48 组后处理校准,冻结为 `onset=0.5/frame=0.4/min=60ms`。未参与校准的 Oliver Colbentson 单声部核心 2,301 音符达到 precision@100ms=0.9142、recall@100ms=0.9396,`freshConfirmationPassed=true`;50ms precision=0.8025,所以 V3 严格门未过。双音压力仍 review-only,学生发布仍为 false。详见 [western-strings-musc-validation.md](western-strings-musc-validation.md)。

受限 Violin Etudes 原始音频/F0 包未取得。开放 Violin MIDI Dataset 已审计:1,006/1,021 个 MIDI 可作弱标签源,677,557 音符、24,138,347 pitch bends、约 34 小时;15 个时长异常文件隔离。数据不含音频且标签非人工 gold,`readyAsIndependentRecognitionBenchmark=false`。详见 [western-strings-violin-midi-validation.md](western-strings-violin-midi-validation.md)。

## 10. 公开模型统一总审计(2026-07-10)

`npm run western:project-status` 已统一读取 PHENICX 人工对齐、MUSC development 校准、MUSC fresh confirmation 和 Violin MIDI 审计报告。`npm run western:public-model-gate` 是公开专业单声部 V2 证据的独立快捷闸门,不参与默认学生端发布。

当前统一裁决:

- `publicProfessionalMonophonicV2CandidateReady=true`。
- `publicProfessionalMonophonicV3Ready=false`。
- `doubleStopAutoFeedbackReady=false`。
- `studentReleaseEligible=false`。
- `nearPerfectReady=false`。

因此公开专业单声部录音可以继续作为 V2 研究候选和开发基线;双音、50ms V3、真实学生错误域和“完美识别”仍未达到。弱标签只能用于后续训练扩展,不能替代新外部人工 gold。

## 11. HF2 域外复音压力进度(2026-07-13)

HF2 Hardanger Fiddle 的 119 对 WAV/MIDI 已完成只读审计，其中 100 条 HF1 表现变体有可用的人工验证来源。该数据只用于复音、装饰音和表现性弓弦录音的域外压力测试，不属于古典小提琴或学生发布证据。

冻结 MUSC 直接核心已按低负载增量协议完成 `20/20`,待处理 `0`。最终 `100 ms` precision=`80.3%`、recall=`56.8%`、F1=`66.6%`,未达到 V2 闸门;因此按停止条件不运行 80 条表现变体。该结果只作为 Hardanger 域外能力边界证据,不构成古典小提琴产品线阻塞。详见 [western-strings-hf2-hardanger-validation.md](western-strings-hf2-hardanger-validation.md)。

## 12. 本地维护与安全清理

2026-07-15 的 M3+ 帧级 F0、小节级反馈、M4 OMR/音频双证与时值归一化实测见 [western-strings-m3plus-m4-evidence-2026-07-15.md](western-strings-m3plus-m4-evidence-2026-07-15.md)。这些结果均为离线证据，不改变学生端默认 `fail-closed` 状态。

2026-07-16 补充：M3+ 评测已改为前半标定/后半 holdout，并加入明确直音控制的会话相对基线；补录评测现优先使用未平滑 CREPE tiny 帧级 F0，缺依赖才回退 pYIN。四条真实录音已到位且确认整体高八度；定位层使用 `+12` 半音，不放宽判定。`m3p-01` 完整定位 `8/8` 并清除“负对照缺失”旧阻塞；`m3p-02/03/04` 冻结结果为 `10/16`、`14/16`、`13/16`，仍 fail-closed，但可靠单元保留、只对局部失败组补证，不再整条重录。小节聚合的事件置信度 sweep 虽可把弱音危险误判清零，但安全操作点覆盖只有 0.84–0.93%，低于现有逐音 4%，不能扩大放行。M4 受限最小编辑时值修复仍未改善总体准确率；相对 IOI 整首排序 Basic Pitch 仅 40% 可判，增加 spectral-flux+pYIN 后降至 20%。进一步在 50 个音高相同小节上评估时，默认门槛仅 precision=66.67%/coverage=6%，放宽覆盖后也只有 80%/10%，按曲留一安全选择为 0；不得自动改谱。

同日进一步审计发现，真实照片与独立公开源谱存在记谱版本混杂：50 个音高序列完全可比的小节中，绝对四分音符起点仅 16/50 完全一致，但相对 IOI 形状有 34/50 一致，其中 33 小节属于“拍号/记谱尺度不同但节奏比例一致”。因此旧 `onset-quarter=2.2%` 不能单独解释为 OMR 节奏全错。新增 `western:m4-rhythm-candidate-oracle` 能在 common-meter 候选中覆盖 50/50 gold 节奏，但 gold 仅用于 oracle，运行时选择器尚未通过，`runtimeReady=false`。生产导入器已停止把缺失拍号静默写成 `4/4`：显式拍号写入 `meterKnown=true`，缺拍号写入 `meterKnown=false` 并强制节奏复核；同时可从 MusicXML 小节时值众数恢复仅供内部布局的 `measureQuarterSpan`。`6/8` 现在按 3 个四分音符单位计算，不再误算为 6。该修复改善时间轴语义，但不放行任何未知拍号的学生节奏判断。

同日非人工优化补测表明，M4 并非只能停在单引擎 84.7% 音高 precision。早期 `western:m4-engine-consensus` 在 Oemer 缺失 `ex05` 时采用两/三引擎自适应口径，得到 `344/344`；补齐 Oemer 后改为 5 页统一三引擎+局部 onset 口径，最终为 `213/213`、precision=`100%`、gold coverage=`13.61%`。候选数降低是证据要求收紧，不是回归；样本量和单谱覆盖仍不足，继续保持 eval-only。普通上传的主要覆盖瓶颈也定位到旧执行器的整曲线性时间映射；默认关闭的 Basic Pitch 事件 + 一对一 gap-penalty DTW + 事件内部 pYIN 稳定窗，在一条正确受控录音前 20 音上把支持从 `0/20` 提升到 `20/20`、中位误差从 `3300c` 降到 `5c`。完整 12 录音机器审计覆盖 2588 个谱音，时间分配率 44.63%、稳定音高支持率 37.40%；但 correct 与 wrong_pitch 组支持率分别为 35.49%/35.97%，支持率本身没有类别判别力，且当前只有录音级 scenario、没有逐音错误位置。因此该模式仍全部 `review_required`，不得解读为学生端 coverage 已达标。

同日继续实现局部相对 IOI 和小节级零矛盾聚合。12 条受控录音的 296 小节中，音高证据就绪 14.86%、节奏证据就绪 2.70%、两者同时就绪 1.69%，没有产生预期的覆盖跃升。随后使用开发演奏者调阈值、未见演奏者锁定评测的公开波形扰动真值：动态一对一音高分配 + 相对 IOI 在 clean 折达到 `2572/2604`、precision=`98.77%`、coverage=`25.89%`，并对 48 漏音、48 错音、48 晚起音做到 0 危险放行；但弱音仍漏放 12/48，参考时间为估计对齐且错误为合成波形扰动。因此这只证明研究级核心错误候选有明显增益，`studentGateReady=false` 不变，真实学生逐音盲验仍是上线前置。Numba 等价 DP 与 SHA-1 f0 缓存把 12 录音复跑从约 109 秒降到约 1.85 秒。

同日继续对弱音缺口做 `2016` 个联合操作点 sweep（相对 IOI、事件置信度、相对邻音置信度、事件时长）。开发集不存在“全部错误零漏放且 coverage>=20%”的点；最佳零漏放点 coverage=`16.57%`，冻结到未见演奏者后 precision=`97.88%`、coverage=`15.95%`，仍漏放弱音 `2/48`。结论是这些运行时阈值可以把弱音漏放从 `12/48` 压到 `2/48`，但不能在产品覆盖地板之上清零；不再靠继续调同一组阈值假装解决。

随后将弱音特征改为起音后的因果窗（30–80ms、30–150ms），避免上一音/连奏能量污染，并只作为此前已冻结动态点的否决器。5 个浅层能量模型全部同意时，未见演奏者的 48 弱音、48 漏音、48 错音和 48 晚起音均为 0 危险放行；clean precision=`98.05%`、coverage=`15.79%`，弱音扰动后的 coverage=`15.57%`。这证明安全回退子集可以清零合成错误漏放，但 clean coverage 仍低于 20% 发布地板，且参考时间/错误均非真实学生真值；因此 `releaseCoverageReady=false`、`studentGateReady=false`。

在上述历史冻结点之后，新增三阶段联合确认：能量模型只用 development 演奏者拟合，动态阈值只用 development + 已消耗的 rank-0 holdout 选择，最终 rank-1 排除 2 个重叠演奏者后只评估 4 个新演奏者一次。统一策略为 deviation=`0.15`、event confidence=`0.4`、relative confidence=`0.8`、duration=`0.08s`，并新增“相邻同音高谱音距离至少 `0.5` 四分音符”的运行时隔离闸，避免重复音归属歧义。最终 clean precision=`97.91%`、coverage=`36.00%`，弱音 precision=`97.88%`、coverage=`35.35%`；每类 32 个弱音/漏音/错音/晚起音目标均为 0 危险放行。因此公开合成扰动的**研究覆盖闸门**已过（`releaseCoverageReady=true`），但参考时间仍为估计值、错误仍为合成波形且没有真实学生逐音真值，故 `studentGateReady=false`，不得直接接学生端。

同一冻结逐音策略进一步做了小节级“音高确认比例 + 相对 IOI 一致比例 + 因果能量支持比例”联合 oracle sweep，共评估 `192` 个运行时可见策略。跨 development/rank-0/fresh rank-1 全部零危险的小节策略最低 clean coverage 仅 `2.61%`；达到 20% 覆盖地板的最佳点最低 coverage=`24.39%`，却累计危险放行 `24` 个目标小节（漏音 `13`、晚起 `10`、错音 `1`，弱音 `0`）。因此 `measureJointEvidenceReleaseReady=false`：能量证据解决了本批弱音，却不能证明漏音和晚起不存在；小节级展示不能反向扩大 auto-pass。

M4 共识候选也已接入 Oemer 音头坐标 sidecar。`ex05` 的受控黑边裁切 fallback 补齐坐标后，5 页统一三引擎+局部 onset 子集为 `213/213` 正确、gold coverage=`13.61%`，且 `213/213` 均携带可验证的 dewarp bbox，`reviewLocatorCoverage=100%`。坐标链已完整，但只有 1/5 页达到完整单页通过条件，故总 `runtimeReady=false`、学生端仍关闭。

M4 又对两种统一引擎策略（Audiveris+HOMR、Audiveris+HOMR+Oemer）和 9 个局部 onset 容差（0–0.25 四分音符）做了 18 组 eval-only sweep。双引擎最好总 precision=`98.62%`、gold coverage=`45.69%`，但 `violin-ex08` 单页 precision 仅 `94.33%`；三引擎全部保持 `100%` 总 precision，但最高 gold coverage 仅 `13.61%`，每页覆盖门槛未过。没有任何统一配置同时满足逐页 precision≥98% 与 coverage≥20%，因此 `expansionCandidateFound=false`；禁止按已知页面做特判，M4 仍只提供复核候选。

先预览,确认目标仅为可再生环境、调试目录、构建产物和 Python 缓存:

```bash
npm run western:cleanup
```

确认后执行:

```bash
npm run western:cleanup:apply
```

清理脚本拒绝工作区外路径和 `paper/` 下任何目标;不会删除正式数据、模型、音频、教师复核、private intake 或论文。当前 M4 监督适配使用的 `clarity-training-audit`、`clarity-train-source-audit`、`clarity-pretrained` 和 `clarity-adaptation-*` 明确保留;只清空可再下载的临时下载缓存。`dist/` 会被清理,发布/验收前必须重新运行 `npm run build`。

## 2026-07-16 M4 P0/P1 安全收口

- 照片谱入口的 P0 闸门已升级为“显式符号证据 **或** 可审计结构佐证”；C 大调/无调号不再因 `rawKeyFifths=[]` 永久失败，低分谱号可由全行首一致+小提琴音域佐证，拍号可由导出拍号+小节总时值一致率佐证。原始符号与导出结果冲突时仍 fail-closed。
- 当前分支重新生成后,冻结 5 谱 P0 完整通过为 `1/5`,分项谱号/调号/拍号=`3/5,2/5,2/5`。剩余失败来自非零调号缺证据或冲突、行首谱号覆盖缺失、节奏结构一致率不足,不再把 C 大调缺少显式符号算作失败;M4 继续 `studentGateReady=false`。
- 12 份历史三变体缓存重放量化了 P0 对反馈率的影响：旧路径为 `10 full + 1 degraded + 1 retake`；严格 P0 后为 `11 score-structure-review-required + 1 retake`。只保留音频确认绿色的模拟可保留 `11/12`、共 `870` 个绿色音并输出 `0` 个指控。绿色安全主尺已改为 sequence gold 映射，structural/consensus 只作诊断：总体 sequence precision=`98.46%`，最差单曲仅 `90%`、`evalOnlyGatePassed=false`，因此本轮不恢复学生端绿色降级，生产策略保持不变。
- P1 增加符杠相邻类和反复连音组证据后，有界视觉 gold-meter oracle 从 `44/50=88%` 提高到 `49/50=98%`；真实候选保留需要到 `top-k=512` 才有 `48/50=96%`。选择器已实测：Basic Pitch 只有 `14/50` 小节具备足够间隔证据，连续 pYIN F0 形状只有 `11/50`；两者的固定 margin 和按曲留一均选择 `0/50`。`33/50` 小节是未知拍号下音频无法辨别的整体记谱尺度缩放，拍号必须由 P0 独立确定。候选生成门槛已过，但选择门槛未过，`runtimeReady=false`。
- 专项 gold 已生成：临时记号 `226`、加线音 `453`、换行谱号 `46`（现正确 `43`）；坐标人工 gold 仍缺，`1937` 条 bbox 任务仅是复核清单，不是 gold。
- 反复路线完成“检测并拒绝自动展开”：反复线、房子、D.C./D.S./Coda/Fine 一律标记 `repeat-route-review-required`。P2 保持现状，不投入模型预算。
- 绿色安全尸检已改用 sequence gold 作为主尺并完整重算：10 首存在可评估绿色，其中 7 首 sequence precision=`100%`、3 首不完美；共 9 个假绿，而非先前按百分比误换算的 11 个。机制为 ex08 的 5 个系统性“OMR 错音与实际演奏错音恰好一致”、ex09 的 1 个缺音后重复音塌缩与 2 个结构漂移巧合、ex11 的 1 个双音缺头/结构漂移巧合。仅调时间残差无法同时拦住这些机制。
- 12 个运行时特征的按曲安全探针中，`anchor-uncertain` 事件率单特征 LOPO 得到 precision=`100%`、安全曲 coverage=`57.14%`，可作为新独立曲目的候选信号；但把“特征选择”也纳入外层留一后，训练折会选择变体 agreement range 并误放 ex08，precision 仅 `85.71%`。因此 `freshValidationCandidateFound=true`、`releaseGateCandidateFound=false`，不建立后验白名单、不恢复学生端绿色反馈。

## 2026-07-16 M4 新增外部曲目测试

- 新增 `练习曲 Op.45 No.34` 与 `北京的金山上` 两组真实谱面+录音，作为外部端到端可用性测试。初次测试时两组都没有独立 MusicXML gold；后续《北京的金山上》已补成与 OMR 输入同版、同一干净谱页图的人工 gold，Op.45 目前仍只有独立公开演奏 MIDI 的音高顺序佐证。
- 低清练习曲在默认 `up2/up2-otsu/up3` 下均无 OMR 输出；eval-only 的 4 倍放大重试可识别 101 个谱面事件，但 heard agreement 仅 `52.56%`，且调号、拍号 P0 证据不足，维持 `review-only`。该重试不接生产。
- `北京的金山上` 的 `up2` 音频层 heard agreement 为 `77.08%`、严格一致 37 音，但原谱可见的 2 升号与 2/4 拍未被可靠保留：导出调号出现 `[2,1]`，拍号为空。P0 正确输出 `score-structure-review-required`，没有因音频局部一致绕过结构错误。
- 两首均未产生学生端反馈。完整生成证据见 `data/experiments/western-strings-m4/new-test-intake/report.md`。
- 新增 eval-only 的谱线间距自适应探针：报告完整记录原图尺寸、估计 interline、请求倍率、像素上限倍率、实际倍率、最终 interline、对比度裁剪和图像 SHA-256。Op.45 实际一直正确估出 `5px→4×→20px`；旧路径只得 17 事件的根因不是倍率，而是使用了 `autocontrast cutoff=0`。改为与手动 4× 一致的 `cutoff=1%` 后，生成图 SHA-256 完全一致并恢复 `101` 事件、4 行谱，谱号/调号 P0 通过，仅拍号证据不足；但北京曲独立 gold 的 recall 从旧自适应的 `25.00%` 进一步降到 `16.28%`，所以该参数仍只属 eval-only，不能全局接生产。报告见 `data/experiments/western-strings-m4/adaptive-interline-probe/report.json`。
- 反复路线已补 eval-only 取证。《北京的金山上》同版人工 gold 没有反复线/房子/D.C.，因此不适合作为展开试验。改用带真实反复记号及逐音对齐真值的 Bach `BWV1005 mov4`：印刷顺序与演奏真值均为 `1196` 个事件，盲目展开会变成 `2392`，多出 `1196`。结论是反复符号不能证明实际演奏执行了反复，继续保留 `repeat-route-review-required`，只允许后续由音频路线证据选择。报告见 `data/experiments/western-strings-m4/repeat-route-probe/report.json`。
- Op.45 的低音频吻合率已单独复核反复假设：同版候选与公开参考均为 `198` 个音，且两份 MusicXML 都没有反复方向标记。因此 `52.56%` 不能据现有证据解释为“漏展开反复”，禁止通过盲目复制段落提高吻合率。
- `北京的金山上` 已由负责人按同版谱页人工誊写并核准 MusicXML。2026-07-17 对 HOMR 0.7.0 做了全新目录、非复用输出的复验：输入 SHA-256 仍为 `E230...B87D`，新旧 HOMR MusicXML SHA-256 均为 `B446...F1E`，pitch P/R=`98.84%/98.84%`、onset-quarter/measure=`100%/100%`，事件级复算确认仅第 7、35 小节各有一个 `C#5 -> B4` 替换。该单页结果真实且可重复，但复核输入图后发现它是已拉直、无透视和手写干扰的干净谱页图，不是负责人展示的弯曲手机照片；因此证据域修正为“干净页图/扫描域”，不得称为真实手机照片域成绩。另在冻结 5 张独立 source-gold 照片上以当前 ONNX Runtime 1.27.0 从零复跑，HOMR 汇总 pitch P/R=`88.33%/95.78%`、onset-quarter=`30.03%`、measure=`79.04%`、严格通过 `0/5`。故 `automaticAdoptionReady=false`,`studentGateReady=false` 不变；北京单页只保留为干净页图阳性，不能证明照片域 M4 已解决。原三引擎报告见 `data/experiments/western-strings-m4/beijing-same-edition-benchmark/same-edition-engine-comparison.json`，fresh 报告见 `data/experiments/western-strings-m4/beijing-homr-fresh-revalidation-20260717/` 与 `data/experiments/western-strings-m4/homr-fresh-sourcegold-revalidation-20260717/`。
- Oemer 同版重跑同时验证了相对 `--out` 目录错误：旧实现切换到图片目录后会把输出路径重复拼接，导致模型成功却被报告为“无输出”。输出根现在在调用 Oemer 前解析为绝对路径，并有回归测试；修复只恢复正确取件，不改变 Oemer 低召回结论。
- Op.45 No.34 另用 MTG `violin-transcription` 项目的独立公开演奏 MIDI 做了 pitch-order-only 交叉核验。HOMR 草稿的第 `49-198` 个音与公开 MIDI 的前 `150` 个音连续完全一致：`150` 次精确匹配、`0` 替换、`0` 缺口；草稿前 `48` 音来自照片版本额外的 8 小节准备段。该结果强力佐证 HOMR 对照片主体的音高顺序识别，但公开 MIDI 是演奏对齐数据，不是该照片的同版人工记谱 gold，也不评估时值、小节或版面结构。因此它只增加外部效度，不计入 `1/5` 同版自动采纳闸门。报告见 `data/experiments/western-strings-m4/op45-34-public-reference/op45-34-public-reference-comparison.json`。
- 为降低第 2 份同版 gold 的人工成本，已把 HOMR MusicXML 经 MuseScore 渲染，并生成 `data/experiments/western-strings-m4/op45-34-same-edition-gold-candidate/index.html` 并排复核包。人工复核发现候选漏掉第 2/3 小节之间的小节线；该局部错误已按 6/8 小节时值边界拆分，候选由 32 小节修为 33 小节，198 个音及其记号保持不变，并重新生成 PDF、PNG、候选哈希和独立浏览器状态键。修复后仍须重新确认小节结构；未取得四项全通过的人工结果前，该文件始终只是候选，不计入同版页数，也不改变 `automaticAdoptionReady=false`。
- Op.45 复核链已补成 fail-closed：页面要求真实复核人姓名，下载结果固定携带原照片与候选 MusicXML SHA-256；`npm run western:m4-op45-promote-gold -- --review <json>` 只有在姓名、四项检查和两份哈希全部匹配时才原子写入 gold 与 provenance。旧文件、漏勾或哈希漂移均拒绝。多引擎同版汇总也已从单页特例改为按 gold SHA 集合核对多页，测试覆盖两页计数和引擎页集合不一致拒绝；当前未收到复核 JSON，实际计数仍为 `1/5`。
- Op.45 复核后收尾已压缩为一个命令：`npm run western:m4-op45-finalize-benchmark -- --review <下载的json>`。它不会重跑 OMR，而是验证复核、原子提升 gold、复用三引擎冻结输出并生成多页报告。候选引擎偏倚单独计数：Op.45 即使人工逐项确认，也因 gold 起点来自 HOMR 而不计入 HOMR 的独立自动采纳页数；项目状态优先读取多页报告，未生成时安全回退北京单页报告。
- 修正总项目 gate 的口径错误：`m4` 必选轨原先只检查 `m4OmrAccuracyClaimReady`，会把“可报告研究基准”误当成“可自动识谱上线”。现改为检查 `m4OmrAutomaticAdoptionReady`；实时总闸门会明确列出 `M4 OMR automatic adoption` 失败及同版页数不足，不再漏报 M4。
