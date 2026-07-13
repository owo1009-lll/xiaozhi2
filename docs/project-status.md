# 西洋弦乐练习诊断项目状态快照

更新时间: 2026-07-13

本文件是当前主线状态快照。实时判断仍以命令为准:

- `npm run western:project-status`
- `npm run western:release-review`
- `npm run western:project-gate`
- `npm run test:western-project-gate`
- `npm run build`

二胡线已经冻结为论文证据、困难案例和共享模块来源。当前产品主线是西洋弓弦乐, 小提琴优先, 大提琴后续独立验证。

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

### M4 OMR benchmark

当前已修正的关键点:

- 12 条 M4 pair 已 ready。
- Audiveris 草稿和 clean score byte-identical。
- 但这 12 条在 M2 clean-score review 中已经有人工审核证据:
  - `cleanScoreReviewStatus=approved`
  - `cleanScoreReviewedBy` 非空
- 因此它们现在被报告为 `human-approved-unchanged-draft`, 不是未复核 self-comparison。

当前 `npm run western:m4-preflight` 结果:

- `readyForOmrAccuracyClaim=true`
- `usableBenchmarkRows=12`
- `humanApprovedUnchangedRows=12`
- `selfComparisonRows=0`
- `manualGoldRequiredRows=0`
- `teacherReviewNeeded=false`
- `humanTask=none`

结论:

- 当前 M4 不需要继续找教师或清谱人员复核。
- M4 仍是 eval-only OMR benchmark, 不会打开学生端运行时 OMR 自动诊断。
- 报告论文/表格时必须把这批写成 `human-approved-unchanged-draft`, 不得伪称为 independent edited gold。

照片谱离线生产链现已接通:

- 浏览器 multipart 上传、JPG/PNG/WebP 文件签名校验、照片/录音独立哈希缓存与队列预览已完成。
- 人工标记为 batch 后,一般受控批处理会分派到照片谱分析器;每次最多处理 5 条以限制本机负载。
- 结果固定为 `photo_score_review_ready`,写入 `photo-score-batch-runs.jsonl`;`autoDiagnosisIssued=false`,`studentFacing=false`。
- multipart、伪造 MIME、缓存越界路径、批处理分派、审计落盘和桌面/移动浏览器交互均有回归验证。
- 仍缺真照片独立编辑 gold、多引擎交叉验证和默认运行时放行;因此 `m4OmrAutoScoreReady=false` 不变。

## 4. 当前唯一下一步

### V2-alpha 第一小节安全子集:全新盲审素材入场

现有机器证据已经达到“允许准备盲审”的门槛,但现有 12 条录音全部参与过训练或复核,不能再作 fresh blind evidence。当前不需要教师继续调试旧包。

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

当前实测 `readyForMachinePrecheck=false`,原因只是模板尚未填入新的外部素材。只有该命令返回 `readyForMachinePrecheck=true`,才进入下一环节:把候选安全写入受控 intake,运行普通上传机器预检。机器预检成功后才生成专业盲审包;生成后还要先由机器验证音频播放、第一小节谱面定位、按钮和 scope membership。任何一步失败都不得交给教师。

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
- `npm run western:fresh-blind-intake-status`(当前按设计因缺全新素材返回阻断)
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

先预览,确认目标仅为可再生环境、调试目录、构建产物和 Python 缓存:

```bash
npm run western:cleanup
```

确认后执行:

```bash
npm run western:cleanup:apply
```

清理脚本拒绝工作区外路径和 `paper/` 下任何目标;不会删除正式数据、模型、音频、教师复核、private intake 或论文。`dist/` 会被清理,发布/验收前必须重新运行 `npm run build`。
