# 西洋弦乐练习诊断项目状态快照

更新时间: 2026-07-17

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
- 当前默认学生发布仍关闭。实时项目闸门失败项为普通上传默认开关关闭,以及 M4 OMR 自动采纳未达标;M3+ 新口径离线通过但学生运行时仍未接线。普通上传受控证据总体 precision=1,但 coverage=0.04,低于 0.20 下限。

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

用途: 不展示技巧名,只判断现有证据是否足以安全指控音准问题。

当前发布口径(2026-07-17 重定):

- 决定文档为 `docs/western-strings-m3plus-rescope-decision.md`;颤音/装饰音音频检测、窗边界继续调参和粗状态分类器已退出发布链,只保留为研究证据。
- 统一离线入口为 `npm run western:m3plus-rescope-gate`,输出 `data/experiments/western-strings-m3plus/rescope-gate/report.json`。
- 无标记平拉 holdout:8 个可判、8 个正确、unsafe=0、4 个证据不足,precision=1.0。
- 谱面标记的 tr/装饰音/泛音区:14 个保护单元全部中性化,指控数=0。
- 人工 gold 揉弦/滑音中心音高:3 个可判、3 个正确、unsafe=0、5 个证据不足,precision=1.0。
- 高离散度兜底:3/3 输出 `insufficient_evidence`,指控数=0。
- 当前 `m3plusPitchSafetyReady=true`,`m3plusModeReleaseReady=true` 仅表示**新口径离线闸门通过**;`studentGateReady=false`,`m3plusAutoFeedbackReady=false`,运行时仍未接线且默认关闭。
- 17 个 round2 揉弦人工 gold 单元因旧报告没有稳定中心 f0 数值而未计入本次定量通过数;报告明确列为 unscored,没有伪造通过。
- 双音 multi-f0 支线范围不变,不由本次单声部中心音高闸门放行。

#### 历史执行证据(保留,不再决定发布)

- 98 reviewed / 74 scored。
- 历史 first-measure 复核集曾把 `slide-like`、`trill-like` 列为离线 release-ready；该结论现已被独立跨后端 holdout 覆盖，不再构成试点授权。
- CREPE tiny/full + pYIN 的冻结物理阈值复验现按技法语义分别使用揉弦 4-8 Hz 周期能量、颤音上下音切换、装饰音开头短促上方音回归、滑音源到目标净移动。holdout 依次为揉弦 precision=`0.60`/recall=`0.75`、颤音 precision 不可定义/recall=`0.00`、装饰音 precision 不可定义/recall=`0.00`、滑音 precision=`1.00`/recall=`0.75`；四类均未达发布线，装饰音另有可靠正例不足。
- 旧 `npm run western:m3plus-monitored-pilot-audit` 非零退出并报告 `m3plus-independent-mode-not-ready:slide-like` / `trill-like`;这些原因现在只记录历史检测器为何退出发布链,不再是新口径顶层 blocker。
- control-ready mode `stable` 只作对照，不等于学生端自动放行。
- `teacherReviewNeeded=false`。

范围限制:

- 只覆盖 first-measure + trusted-recording 的安全子集。
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
- P0 谱号/调号/拍号 fail-closed 证据提取已修复无 `shape` 的 key 与 `time-whole` 节点；冻结 5 张真照片现为完整 `1/5`，分项谱号/调号/拍号=`3/5,2/5,2/5`。剩余冲突仍拒绝，`m4OmrAutoScoreReady=false`。
- 《北京的金山上》人工 MusicXML 已作为新的独立真照片 gold。OMR 报告现以 recall/漏识率为第一指标：现有 `up2` pitch R/Miss/P/F1=`35.47%/64.53%/87.14%/50.41%`；修正对比度参数后的自适应谱线缩放为 `16.28%/83.72%/28.28%/20.66%`。自适应路径在该页输出更多但漏识和误识都更严重，已按独立 gold 停止接入，不用音频吻合率替代 OMR 准确率。
- 更强 OMR 引擎对照已完成:`npm run western:m4-oemer-benchmark` 用 Oemer 0.1.8 在同一 5 份 source-gold 上串行评测。`ex05` 原始截图的播放器黑边曾诱发错误 3-track 结构；现在只对该明确失败执行固定行均值裁边重试，Oemer 由 4/5 提升为 5/5 可输出。全 5 份 P/R=`71.87%/76.23%`、onset-quarter/measure accuracy=`5.43%/18.21%`，严格仍为 `0/5`；同 5 份 Audiveris P/R=`85.47%/72.14%`。fallback 解决的是引擎崩溃和坐标缺失，不足以让 Oemer 替换 Audiveris 或进入生产。
- Oemer 坐标适配已完成但保持 review-only:`run_oemer_with_coordinates.py` 从实际发射 MusicXML 的 `AddNote` 动作保存音头 bbox 和干净 dewarp 画布,不修改第三方包。5 个输出页的坐标数均与 XML 音符数一致，新增裁边页为 `289/289`；正式报告为 `coordinateAdapter.readyRows=5/5`,`studentFacing=false`。坐标可画不改变 OMR 严格 `0/5`。
- Transformer OMR 对照已完成:`npm run western:m4-homr-benchmark` 用 HOMR 0.7.0 对同一 5 份原始 source 照片串行评测。5/5 均输出,聚合 pitch P/R=`89.00%/96.17%`,onset-quarter/measure accuracy=`30.73%/79.04%`。`ex05/ex12` 若只看音高会成为 `2/5` 假通过,但完整 pitch+onset+measure 严格门槛为 `0/5`;HOMR 因节奏重建错误仍不接生产。
- 第三方视觉 Transformer 对照已完成:`npm run western:m4-clarity-benchmark` 用 Clarity-OMR 官方 beam-5 管线评测同一 5 份 source-gold。原始截图因播放器黑边/标题栏导致 Stage A 检出 `0` 个谱表;使用冻结的通用行均值裁页后 5/5 均输出,但聚合 pitch P/R=`72.77%/35.53%`,onset-quarter/measure accuracy=`2.81%/10.10%`,完整严格通过 `0/5`。该裁页仅用于公平评测,Clarity 不接生产。
- Clarity 监督适配的非人工前置已跑通:`npm run western:m4-clarity-adaptation-data-probe` 从一页独立 Bach MusicXML 生成 8 个去重谱表图像/标签对,无盲测照片混入;`npm run western:m4-clarity-adaptation-split` 按 BWV 作品拆成 train/validation/synthetic-test=`21/4/7`,5 份真实照片 gold 冻结在训练集之外。
- `npm run western:m4-clarity-training-step` 已在本机 RTX 5060 上完成一次 bf16+DoRA 反向传播:可训练参数 `8,946,222`(`5.1933%`),loss 有限、576 个参数张量获得有限梯度,峰值 reserved 显存约 `1.08 GiB`。官方权重中 48 个缺失键经核验为共享 FFN 别名,另 4 个为官方推理权重未包含的训练辅助 contour head;脚本对除此以外的缺失键 fail-closed。
- 受限多作品适配已完成:32/32 个 Bach movement 生成 592 个原始/296 个去重 staff-token 对,按作品得到 train/validation/synthetic-test=`199/39/58` 条,无作品、图片哈希或真实照片盲测泄漏。64-step DoRA 峰值 reserved 显存约 `1.21 GiB`;teacher-forced 与自回归 held-out 指标均有提升,说明训练确实改变了模型而非空跑。
- 冻结 5 张真实照片给出了决定性否定结果:候选 5/5 可输出,但聚合 pitch P/R=`80.00%/31.44%`,onset-quarter/measure accuracy=`2.04%/6.26%`,严格通过 `0/5`。对比官方 Clarity 基线 `72.77%/35.53%`、`2.81%/10.10%`,候选只提高 precision,其余三项退化;自动适配决策为 `reject-and-delete`,候选权重已排除出产品与后续评估。
- 公开 DoReMi v1 的有界监督适配 pilot 也已完成:只解压 3 部弦乐四重奏,按作品得到 train/validation/synthetic-test=`96/48/48` 个谱表对,32-step DoRA 将 held-out 数字谱 token accuracy 提高约 9-10 个百分点。但冻结 5 份真照片上候选仅得到 pitch P/R=`75.94%/36.10%`,onset-quarter/measure=`5.18%/6.65%`,严格 `0/5`;measure 低于官方 Clarity 的 `10.10%`,再次按完整四指标规则 `reject-and-delete`。这证明仅追加干净公开谱可改善数字谱域,但不能修复真照片的节奏/小节结构。

结论:

- M4 已完成可复跑的独立**研究级** OMR 准确率基准,可以报告限定范围内的数字谱/合成退化结果。
- M4 尚未达到自动采纳:逐谱严格门槛仅 12/32,真实照片独立源谱按 pitch+onset+measure 完整门槛严格通过 `0/5`,运行时置信特征也筛不出安全子集。OMR 不会进入学生端运行时自动诊断。
- Clarity 监督适配已完成 Bach 和 DoReMi 两次从数据生成、无泄漏划分、低负载训练到冻结真照片的完整闭环,但真照片完整指标都有退化,候选均已拒绝并清理。该路线不再继续堆干净数字谱、训练步数或调参;除非以后新增拍照域退化、符杠/符尾/休止/附点与小节结构级监督,否则 Clarity 只保留为负基线,`studentGateReady=false` 不变。
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
- 修正后冻结 5 谱 P0 完整通过仍为 `0/5`，但分项从谱号/调号/拍号=`1/0/2` 提升为 `3/1/2`。剩余失败来自非零调号缺证据或冲突、行首谱号覆盖缺失、节奏结构一致率不足，不再把 C 大调缺少显式符号算作失败；M4 继续 `studentGateReady=false`。
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
