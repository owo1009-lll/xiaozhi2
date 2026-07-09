# 西洋弦乐练习诊断项目状态快照

更新时间: 2026-07-10

本文件是当前主线状态快照。实时判断仍以命令为准:

- `npm run western:project-status`
- `npm run western:release-review`
- `npm run western:project-gate`
- `npm run test:western-project-gate`
- `npm run build`

二胡线已经冻结为论文证据、困难案例和共享模块来源。当前产品主线是西洋弓弦乐, 小提琴优先, 大提琴后续独立验证。

## 1. 当前目标

构建西洋弓弦乐练习诊断系统:

- 输入: clean score + audio; PDF/图片 OMR 是 M4 谱面侧能力, 必须先过 OMR 闸门。
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
- runtime scorer 已接入, 但默认关闭。
- `npm run western:ordinary-monitored-pilot-audit` 已通过。

当前关键结果:

- fresh validation precision=0.90。
- monitored pilot audit: `readyForMonitoredPilot=true`。
- `teacherReviewNeeded=false`。
- precision precheck 中 self-checked auto-pass 3 条均为 known usable,0 条 known wrong,0 条 unknown。

结论:

- 可以进入单独受控 pilot 的发布审查。
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

## 4. 当前唯一下一步

### P1: 受控 pilot 批准

发布前汇总审查和 pilot 决策包都已经可以由机器完成:

```bash
npm run western:release-review
npm run western:controlled-pilot-decision
npm run western:controlled-pilot-approval-template
npm run western:controlled-pilot-start-preflight
```

`western:release-review` 会串联:

- `western:ordinary-monitored-pilot-audit`
- `western:m3plus-monitored-pilot-audit`
- `western:m4-preflight`
- `western:project-status`

`western:controlled-pilot-decision` 会把机器证据转成明确决策包:

- 不再默认要求教师/专业人员复核。
- 只有机器预检发现 unknown auto-pass 或 unsafe auto-pass 时,才进入定向人工复核。
- 没有负责人显式批准时,系统保持 review-only / fail-closed。

`western:controlled-pilot-approval-template` 只生成不批准的模板文件,不会解锁 pilot。只有负责人明确批准后,才可把模板复制/填写为 `data/experiments/western-strings-controlled-pilot-approval.json`。

如果负责人明确决定暂缓/不启动 pilot,也可以把模板复制为同一路径,保持 `pilotApproved=false` 并填写 `approvedBy/approvedAt`;系统会记录为 explicit no-go,继续安全停在 review-only。

`western:controlled-pilot-start-preflight` 是批准后的最后机器预检。当前没有 approval 文件时它必须失败;通过前不得启动 pilot。

产物:

- `data/experiments/western-strings-release-review.json`
- `data/experiments/western-strings-release-review.md`
- `data/experiments/western-strings-controlled-pilot-decision.json`
- `data/experiments/western-strings-controlled-pilot-decision.md`
- `data/experiments/western-strings-controlled-pilot-approval.template.json`
- `data/experiments/western-strings-controlled-pilot-start-preflight.json`
- `data/experiments/western-strings-controlled-pilot-start-preflight.md`

当前实测:

- `readyForControlledPilot=true`
- `readyForDefaultStudentRelease=false`
- `teacherReviewNeeded=false`
- `runtimeFailClosed=true`
- `readyForControlledPilotDecision=true`
- `readyToStartControlledPilot=false`
- `approvalPresent=false`

这表示:机器自测已经完成, 目前不需要继续找教师复核。下一步只剩产品负责人是否批准一个单独受控 pilot;默认学生端仍保持关闭。如果不批准 pilot, 项目应停在安全 review-only 默认态。

## 5. 当前不可声称

- 不可声称任意普通上传音频已经默认实时自动诊断。
- 不可声称 M3+ 已可广泛对学生端开放。
- 不可声称 M3+ 是技巧名称识别产品。
- 不可声称 OMR 已进入运行时判断层。
- 不可声称支持大提琴; 大提琴需要 M5 独立验证。

## 6. 最近确认通过的命令

- `npm run western:m4-preflight`
- `npm run western:project-status`
- `npm run western:next-actions`
- `npm run test:western-project-gate`
- `npm run build`

`npm run western:project-gate` 当前仍以非零退出阻断默认发布, 但失败只剩:

- `ordinary-auto-gate-disabled-by-default`

这是安全态, 不是缺复核数据。
