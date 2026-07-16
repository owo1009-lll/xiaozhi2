# 西洋弦乐练习诊断项目状态快照

更新时间: 2026-07-15

本文件是当前主线状态快照。实时判断仍以命令为准:

- `npm run western:project-status`
- `npm run western:release-review`
- `npm run western:project-gate`
- `npm run test:western-project-gate`
- `npm run build`

二胡线已经冻结为论文证据、困难案例和共享模块来源。当前产品主线是西洋弓弦乐, 小提琴优先, 大提琴后续独立验证。

## 2026-07-15 第二轮 8 份录音更新

- 第二轮 8/8 组音频、MusicXML 和谱面图片已审计、标准化并完成受控机器分析,总计 444 个谱面音符。
- 旧 MusicXML 导入会把部分多小节谱压缩到第 1 小节;该缺陷已修复并增加结构闸门。7 份受影响 score 已在备份后原位重建,8 份现在的小节数、音符数和唯一 ID 均与源谱一致。
- `r2-08` fresh-blind 精确受控试验已执行:60 个候选、3 个模型原始 auto-pass,但范围内和自检通过的 auto-pass 均为 0。试验正确中止,未发布学生反馈,不需要教师复核空候选。
- 新一轮 M3+ 只完成 review-only 库存清点:444 个音符中 292 个被列为行为候选;这不改变运行时门槛。
- 已找到随录音放置的 `README-怎么用.md`,确认 `r2-02` / `r2-03` / `r2-04` 的错误数量分别为 5 / 5 / 4。README 没有具体小节且 `notes.txt` 仍缺失,因此只能做数量对照和机器位置搜索,不能计算精确 recall/precision。
- README 数量约束下的 Basic Pitch + 序列 DTW 搜索得到:错音阈值候选 5 个;漏音保守候选 3 个,未覆盖 README 目标数量;拖拍阈值候选 5 个,按目标数保留前 4 个。它们均为未人工确认的机器假设,没有进入学生反馈。
- 当前默认学生发布仍关闭。项目闸门失败项仍为 `ordinary-auto-gate-disabled-by-default`;受控证据总体 precision=1,但 coverage=0.04,低于 0.20 下限。

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

### 普通上传候选 gate

已完成:

- 60 条候选人工标签:46 usable / 14 wrong。
- confidence pilot、fresh blind validation、threshold-pool runtime-policy audit。
- 5 批独立机器受控 pilot 已安全完成,默认运行时均已恢复关闭。
- runtime scorer 与 first-measure-only 显式 pilot scope 已接入,但默认关闭。
- `npm run western:ordinary-monitored-pilot-audit` 与 `npm run western:controlled-pilot-evidence-audit` 已通过机器前置检查。

当前关键结果:

- 全曲 operational:275 候选 / 33 个模型原始 auto-pass / 11 个严格 eligible;precision=1.0,但 coverage=4.00%,不达 V2-alpha 20% 下限。
- 联合 threshold sweep 没有找到能同时满足 precision>=0.90 与 coverage>=0.20 的全曲阈值。
- first-measure-only + confidence>=0.95 历史留一录音:12/12 usable,precision=1.0,coverage=25.53%。
- first-measure-only 真实机器 pilot:11/11 usable,0 wrong,0 unknown,precision=1.0,coverage=26.83%,覆盖 5 条独立录音/曲目。
- `machinePreflightPassed=true`,`teacherReviewAllowed=true`,但只授权准备一份全新、小型、第一小节范围的专业盲审包。

结论:

- 全曲普通上传仍不达 V2-alpha;只有第一小节安全子集可以进入最终小型盲审。
- 现有 12 条录音全部已经进入训练/复核证据,不得重复使用。
- 不得默认开启学生端。
- 不得提交或全局设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1`。

### M3+ 音高行为模式

用途: 不展示技巧名, 只为了在特殊音高行为区域把音准判对。

当前证据:

- 98 reviewed / 74 scored。
- release-ready offline modes: `slide-like`, `trill-like`。
- control-ready mode: `stable`。
- `npm run western:m3plus-monitored-pilot-audit` 已通过。
- `teacherReviewNeeded=false`。

范围限制:

- 只覆盖 first-measure + trusted-recording 的安全子集。
- `variable-f0`、`double-stop-candidate`、`ornament-candidate` 仍 blocked/review-only。
- 默认学生端 M3+ 自动反馈仍关闭。

2026-07-15 第二轮真实对齐复验:

- `r2-06` 的 6 个颤音和其余长音揉弦已经人工确认实际演奏。
- 谱面实际含 6 个颤音与 17 个其余长音。旧报告的 16 个揉弦分母来自对齐器漏掉第 2 音;现已修正为未匹配音仍计入漏检。
- Basic Pitch 序列 DTW 后的机器检出为:滑音 7/12、颤音 0/6、揉弦 1/17、双音 19/24。
- 新增 `npm run western:round2-m3plus-diagnostic`:23 个音中 1 个未匹配,12/23(`52.2%`)的 DTW 窗口时长不合理。受控时值锚定后的最佳单特征仍只有训练内 precision/recall=`66.7%/66.7%`,未达到 90%;因此不调低阈值、不接学生端。
- 四项均未达 90%;旧 release-ready 结论只适用于 first-measure 安全子集,不得推广。
- 自然泛音音准检测已从 M3+ 当前范围取消,不再要求录音、评测或放行。MusicXML 泛音 pitch-role 解析仅作为通用谱面兼容能力保留,不构成学生端自动音准承诺。
- 第二轮尚缺真实负例和独立装饰音样本,因此 `studentGateReady=false` 不变。
- 已生成最小补录包 `音频/m3plus-supplemental/`:4 条均改为“不读谱、固定音符顺序 + 文字要求”,分别覆盖 C 大调上行纯直音负例、独立揉弦/颤音、装饰音/普通音对照、滑音/直音对照。附带的 MusicXML、MIDI、谱图仅供机器校验;`score-intent.json` 仍明确 `performanceConfirmed=false`,不得在录音前计作性能 gold。
- `npm run western:m3plus-supplemental-status` 当前为 `readyRecordingCount=0/4`,`readyForMachineAnalysis=false`,`humanTask=record-m3plus-supplemental-takes`;只缺 `m3p-01.m4a` 至 `m3p-04.m4a` 四条真实录音。录齐后先由机器验证解码、定位和模式指标,不直接生成教师复核包。
- 补录机器评测入口已经完成:`npm run western:m3plus-supplemental-eval` 先从 MusicXML 的 `vibrato` 文字、`trill-mark`、`mordent`、`glissando` 与明确的 straight/plain 对照读取谱面技法意图,再用固定音符顺序的单调动态规划定位逐单元帧级 F0,核验录音是否按谱执行;谱面标记本身不算演奏正确。评测默认优先使用未做中值/Viterbi 平滑的 CREPE tiny,以保留颤音快速交替与滑音连续轨迹;环境缺少 `torchcrepe` 时才回退 pYIN,并在状态报告中显式记录 `f0Backend`。定位阶段允许 `±100 cents` 偏差以避免实录小偏差造成错窗,但音准判定仍使用原始 cents。后端替换不放宽任何 precision/recall/coverage 闸门。合成受控回归四类与谱面标记一致性均通过;缺真实音频时报告 4 条 `audio-missing` 且 `studentGateReady=false`,`teacherReviewAllowed=false`。真实录音到位后先跑该命令;机器定位或模式阈值不过时先修特征,不交教师重复复核。

### M4 OMR benchmark

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
- 更强 OMR 引擎对照已完成:`npm run western:m4-oemer-benchmark` 用 Oemer 0.1.8 在同一 5 份 source-gold 上串行评测。`ex05` 原始截图的播放器黑边曾诱发错误 3-track 结构；现在只对该明确失败执行固定行均值裁边重试，Oemer 由 4/5 提升为 5/5 可输出。全 5 份 P/R=`71.87%/76.23%`、onset-quarter/measure accuracy=`5.43%/18.21%`，严格仍为 `0/5`；同 5 份 Audiveris P/R=`85.47%/72.14%`。fallback 解决的是引擎崩溃和坐标缺失，不足以让 Oemer 替换 Audiveris 或进入生产。
- Oemer 坐标适配已完成但保持 review-only:`run_oemer_with_coordinates.py` 从实际发射 MusicXML 的 `AddNote` 动作保存音头 bbox 和干净 dewarp 画布,不修改第三方包。5 个输出页的坐标数均与 XML 音符数一致，新增裁边页为 `289/289`；正式报告为 `coordinateAdapter.readyRows=5/5`,`studentFacing=false`。坐标可画不改变 OMR 严格 `0/5`。
- Transformer OMR 对照已完成:`npm run western:m4-homr-benchmark` 用 HOMR 0.7.0 对同一 5 份原始 source 照片串行评测。5/5 均输出,聚合 pitch P/R=`89.00%/96.17%`,onset-quarter/measure accuracy=`30.73%/79.04%`。`ex05/ex12` 若只看音高会成为 `2/5` 假通过,但完整 pitch+onset+measure 严格门槛为 `0/5`;HOMR 因节奏重建错误仍不接生产。
- 第三方视觉 Transformer 对照已完成:`npm run western:m4-clarity-benchmark` 用 Clarity-OMR 官方 beam-5 管线评测同一 5 份 source-gold。原始截图因播放器黑边/标题栏导致 Stage A 检出 `0` 个谱表;使用冻结的通用行均值裁页后 5/5 均输出,但聚合 pitch P/R=`72.77%/35.53%`,onset-quarter/measure accuracy=`2.81%/10.10%`,完整严格通过 `0/5`。该裁页仅用于公平评测,Clarity 不接生产。
- Clarity 监督适配的非人工前置已跑通:`npm run western:m4-clarity-adaptation-data-probe` 从一页独立 Bach MusicXML 生成 8 个去重谱表图像/标签对,无盲测照片混入;`npm run western:m4-clarity-adaptation-split` 按 BWV 作品拆成 train/validation/synthetic-test=`21/4/7`,5 份真实照片 gold 冻结在训练集之外。
- `npm run western:m4-clarity-training-step` 已在本机 RTX 5060 上完成一次 bf16+DoRA 反向传播:可训练参数 `8,946,222`(`5.1933%`),loss 有限、576 个参数张量获得有限梯度,峰值 reserved 显存约 `1.08 GiB`。官方权重中 48 个缺失键经核验为共享 FFN 别名,另 4 个为官方推理权重未包含的训练辅助 contour head;脚本对除此以外的缺失键 fail-closed。
- 受限多作品适配已完成:32/32 个 Bach movement 生成 592 个原始/296 个去重 staff-token 对,按作品得到 train/validation/synthetic-test=`199/39/58` 条,无作品、图片哈希或真实照片盲测泄漏。64-step DoRA 峰值 reserved 显存约 `1.21 GiB`;teacher-forced 与自回归 held-out 指标均有提升,说明训练确实改变了模型而非空跑。
- 冻结 5 张真实照片给出了决定性否定结果:候选 5/5 可输出,但聚合 pitch P/R=`80.00%/31.44%`,onset-quarter/measure accuracy=`2.04%/6.26%`,严格通过 `0/5`。对比官方 Clarity 基线 `72.77%/35.53%`、`2.81%/10.10%`,候选只提高 precision,其余三项退化;自动适配决策为 `reject-and-delete`,候选权重已排除出产品与后续评估。

结论:

- M4 已完成可复跑的独立**研究级** OMR 准确率基准,可以报告限定范围内的数字谱/合成退化结果。
- M4 尚未达到自动采纳:逐谱严格门槛仅 12/32,真实照片独立源谱按 pitch+onset+measure 完整门槛严格通过 `0/5`,运行时置信特征也筛不出安全子集。OMR 不会进入学生端运行时自动诊断。
- Clarity 监督适配已完成一次从数据生成、无泄漏划分、低负载训练到冻结真实照片的完整闭环,但真实照片完整指标不升反降,候选已拒绝并清理。该路线不再继续堆训练步数或调参;除非以后新增独立且更大规模的人工编辑 OMR 训练集,否则 Clarity 只保留为负基线,`studentGateReady=false` 不变。
- 当前不需要教师或制谱人员继续操作。新增真实照片 gold 的证据缺口已经关闭,Audiveris 预处理/置信筛选、Oemer、HOMR 与 Clarity-OMR 均未达到完整门槛;继续扩大照片只增强外部效度,不能掩盖当前 `0/5`。
- 报告论文/表格时必须将独立 render-gold 与 `human-approved-unchanged-draft` 分开,后者不得伪称独立照片准确率。

照片谱离线生产链现已接通:

- 浏览器 multipart 上传、JPG/PNG/WebP 文件签名校验、照片/录音独立哈希缓存与队列预览已完成。
- 人工标记为 batch 后,一般受控批处理会分派到照片谱分析器;每次最多处理 5 条以限制本机负载。
- 结果固定为 `photo_score_review_ready`,写入 `photo-score-batch-runs.jsonl`;`autoDiagnosisIssued=false`,`studentFacing=false`。
- multipart、伪造 MIME、缓存越界路径、批处理分派、审计落盘和桌面/移动浏览器交互均有回归验证。
- 真实照片独立源谱 gold 已有 5 份,但严格通过率为 0/5;多引擎、预处理或音频仲裁原型都不能替代精度门槛。因此 `m4OmrAutoScoreReady=false` 不变。

## 4. 第二轮执行后的下一步

`r2-08` 已完成全新素材入场和精确受控机器 pilot,因此“继续寻找一条 fresh blind 素材”不再是当前动作。结果不是发布通过,而是新录音没有任何候选通过现有窄范围自检。

下一步分两条,不得混为一项:

1. **M3 定量补证:** README 的 5/5/4 数量真值已用于机器候选搜索。当前漏音保守阈值只找到 3 个候选;拖拍有 5 个阈值候选,比目标多 1 个。下一步先改进漏音候选与候选校准;只有补齐精确错误小节真值后,才可区分真命中、漏检和超额假阳性并重算 recall/precision。没有精确标签时不得把候选位置填成 gold。
2. **P1/普通上传:** 保持默认关闭。先分析本次 3 个原始 auto-pass 为何全部被 scope/self-check 抑制;只有新策略在独立盲验中同时达到 precision>=0.90 和 coverage>=0.20,才讨论扩大范围。当前不需要教师复核 `r2-08`,因为可复核 auto-pass 为 0。

第二轮命令:

```bash
npm run western:round2-intake-status
npm run western:round2-machine-analysis
npm run western:round2-scenario-search
npm run western:project-status
npm run western:project-gate
```

以下 fresh-blind 入场说明保留为后续批次操作规范:

### V2-alpha 第一小节安全子集:全新盲审素材入场

已新增独立入场闸门:

```bash
npm run western:fresh-blind-intake-init
npm run western:fresh-blind-intake-status
```

不再手改 `intake.json`。三个文件就位后由项目维护者运行原子化登记命令:

```bash
npm run western:fresh-blind-intake-stage -- --recording-id <new-recording-id> --piece-id <new-piece-id> --audio "<audio-path>" --score "<musicxml-or-mxl-path>" --score-display "<pdf-or-image-path>" --reviewed-by "<reviewer>"
```

该命令先审计临时清单；任何重复、解码失败、谱面解析失败或审核信息缺失都会保持正式 `intake.json` 不变。

入场闸门通过后，机器预检必须精确指定本次全新录音，不能按队列顺序取样:

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

第二轮 `r2-08` 已实测 `readyForMachinePrecheck=true` 并完成后续精确机器 pilot。未来新批次仍必须从空模板重新走同一闸门;只有状态返回 `true`,才可写入受控 intake。机器预检成功后也只能在出现可复核候选时生成专业盲审包;生成前还要由机器验证音频播放、谱面定位、按钮和 scope membership。任何一步失败都不得交给教师。

专业盲审仍只审 `first-measure-only + confidence>=0.95` 候选;所有后续小节继续 `review_required`,默认学生端继续 fail-closed。

## 5. 当前不可声称

- 不可声称任意普通上传音频已经默认实时自动诊断。
- 不可声称 M3+ 已可广泛对学生端开放。
- 不可声称 M3+ 是技巧名称识别产品。
- 不可声称 OMR 已进入运行时判断层。
- 不可声称支持大提琴; 大提琴需要 M5 独立验证。

## 6. 最近确认通过的命令

- `npm run western:m4-preflight`
- `npm run western:controlled-pilot-evidence-audit`
- `npm run test:western-fresh-blind-intake`
- `npm run western:fresh-blind-intake-status`(`r2-08` 当前已通过入场审计)
- `npm run western:project-status`
- `npm run western:next-actions`
- `npm run test:western-project-gate`
- `npm run build`

`npm run western:project-gate` 当前仍以非零退出阻断默认发布, 但失败只剩:

- `ordinary-auto-gate-disabled-by-default`

这是安全态, 不是缺复核数据。

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

2026-07-16 补充：M3+ 评测已改为前半标定/后半 holdout，并加入明确直音控制的会话相对基线；补录评测现优先使用未平滑 CREPE tiny 帧级 F0，缺依赖才回退 pYIN，但四条真实录音仍缺失。小节聚合的事件置信度 sweep 虽可把弱音危险误判清零，但安全操作点覆盖只有 0.84–0.93%，低于现有逐音 4%，不能扩大放行。M4 受限最小编辑时值修复仍未改善总体准确率；相对 IOI 整首排序 Basic Pitch 仅 40% 可判，增加 spectral-flux+pYIN 后降至 20%。进一步在 50 个音高相同小节上评估时，默认门槛仅 precision=66.67%/coverage=6%，放宽覆盖后也只有 80%/10%，按曲留一安全选择为 0；不得自动改谱。

同日进一步审计发现，真实照片与独立公开源谱存在记谱版本混杂：50 个音高序列完全可比的小节中，绝对四分音符起点仅 16/50 完全一致，但相对 IOI 形状有 34/50 一致，其中 33 小节属于“拍号/记谱尺度不同但节奏比例一致”。因此旧 `onset-quarter=2.2%` 不能单独解释为 OMR 节奏全错。新增 `western:m4-rhythm-candidate-oracle` 能在 common-meter 候选中覆盖 50/50 gold 节奏，但 gold 仅用于 oracle，运行时选择器尚未通过，`runtimeReady=false`。生产导入器已停止把缺失拍号静默写成 `4/4`：显式拍号写入 `meterKnown=true`，缺拍号写入 `meterKnown=false` 并强制节奏复核；同时可从 MusicXML 小节时值众数恢复仅供内部布局的 `measureQuarterSpan`。`6/8` 现在按 3 个四分音符单位计算，不再误算为 6。该修复改善时间轴语义，但不放行任何未知拍号的学生节奏判断。

同日非人工优化补测表明，M4 并非只能停在单引擎 84.7% 音高 precision。早期 `western:m4-engine-consensus` 在 Oemer 缺失 `ex05` 时采用两/三引擎自适应口径，得到 `344/344`；补齐 Oemer 后改为 5 页统一三引擎+局部 onset 口径，最终为 `213/213`、precision=`100%`、gold coverage=`13.61%`。候选数降低是证据要求收紧，不是回归；样本量和单谱覆盖仍不足，继续保持 eval-only。普通上传的主要覆盖瓶颈也定位到旧执行器的整曲线性时间映射；默认关闭的 Basic Pitch 事件 + 一对一 gap-penalty DTW + 事件内部 pYIN 稳定窗，在一条正确受控录音前 20 音上把支持从 `0/20` 提升到 `20/20`、中位误差从 `3300c` 降到 `5c`。完整 12 录音机器审计覆盖 2588 个谱音，时间分配率 44.63%、稳定音高支持率 37.40%；但 correct 与 wrong_pitch 组支持率分别为 35.49%/35.97%，支持率本身没有类别判别力，且当前只有录音级 scenario、没有逐音错误位置。因此该模式仍全部 `review_required`，不得解读为学生端 coverage 已达标。

同日继续实现局部相对 IOI 和小节级零矛盾聚合。12 条受控录音的 296 小节中，音高证据就绪 14.86%、节奏证据就绪 2.70%、两者同时就绪 1.69%，没有产生预期的覆盖跃升。随后使用开发演奏者调阈值、未见演奏者锁定评测的公开波形扰动真值：动态一对一音高分配 + 相对 IOI 在 clean 折达到 `2572/2604`、precision=`98.77%`、coverage=`25.89%`，并对 48 漏音、48 错音、48 晚起音做到 0 危险放行；但弱音仍漏放 12/48，参考时间为估计对齐且错误为合成波形扰动。因此这只证明研究级核心错误候选有明显增益，`studentGateReady=false` 不变，真实学生逐音盲验仍是上线前置。Numba 等价 DP 与 SHA-1 f0 缓存把 12 录音复跑从约 109 秒降到约 1.85 秒。

同日继续对弱音缺口做 `2016` 个联合操作点 sweep（相对 IOI、事件置信度、相对邻音置信度、事件时长）。开发集不存在“全部错误零漏放且 coverage>=20%”的点；最佳零漏放点 coverage=`16.57%`，冻结到未见演奏者后 precision=`97.88%`、coverage=`15.95%`，仍漏放弱音 `2/48`。结论是这些运行时阈值可以把弱音漏放从 `12/48` 压到 `2/48`，但不能在产品覆盖地板之上清零；不再靠继续调同一组阈值假装解决。

随后将弱音特征改为起音后的因果窗（30–80ms、30–150ms），避免上一音/连奏能量污染，并只作为此前已冻结动态点的否决器。5 个浅层能量模型全部同意时，未见演奏者的 48 弱音、48 漏音、48 错音和 48 晚起音均为 0 危险放行；clean precision=`98.05%`、coverage=`15.79%`，弱音扰动后的 coverage=`15.57%`。这证明安全回退子集可以清零合成错误漏放，但 clean coverage 仍低于 20% 发布地板，且参考时间/错误均非真实学生真值；因此 `releaseCoverageReady=false`、`studentGateReady=false`。

在上述历史冻结点之后，新增三阶段联合确认：能量模型只用 development 演奏者拟合，动态阈值只用 development + 已消耗的 rank-0 holdout 选择，最终 rank-1 排除 2 个重叠演奏者后只评估 4 个新演奏者一次。统一策略为 deviation=`0.15`、event confidence=`0.4`、relative confidence=`0.8`、duration=`0.08s`，并新增“相邻同音高谱音距离至少 `0.5` 四分音符”的运行时隔离闸，避免重复音归属歧义。最终 clean precision=`97.91%`、coverage=`36.00%`，弱音 precision=`97.88%`、coverage=`35.35%`；每类 32 个弱音/漏音/错音/晚起音目标均为 0 危险放行。因此公开合成扰动的**研究覆盖闸门**已过（`releaseCoverageReady=true`），但参考时间仍为估计值、错误仍为合成波形且没有真实学生逐音真值，故 `studentGateReady=false`，不得直接接学生端。

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
