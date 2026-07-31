# 交接：训练账本端到端验证（P1）

目标：让训练账本**第一次写入真实记录**，确认从"老师复核"到"(特征, 金标) 落盘"整条链在真机上成立。
当前账本代码已上线并通过全部单测，但**从未处理过一条真实提交**，单测用的是合成夹具。

预计耗时 30–60 分钟。不需要新录音。

## 硬约束（违反即作废，逐条都要遵守）

1. **不得翻任何学生开关。** `ordinaryUploadAutoFeedbackReady` / `m3plusAutoFeedbackReady` /
   `m4OmrAutoScoreReady` 必须全程保持 `false`。翻开关需要负责人署名 + 改代码，本任务无权触碰。
2. **不得使用 Round 6 素材。** `data/private/western-strings-round6-counterbalanced/` 下的
   `r6-cal-*` 与 `r6-fresh-*` 是未录制的冻结包，不是测试材料。
3. **不得使用任何 fresh-blind 素材。** fresh 只能消费一次。
4. **不得修改 `package.json`。** 它是 P3 预注册的 13 个冻结绑定之一，改动会立刻撤销
   Stage A 录音授权。新脚本一律 `node scripts/xxx.mjs` 直接调用。
5. **不得修改** `position-truth.json`、`manifest.csv`、`config/western-strings-round6-*`、
   `docs/evidence/western-strings-p3-minimal-recording-preregistration-20260724.json`。
6. 用**已消费过的**历史录音做本次验证（推荐 `round4-r4-06`，7-24 受控试点已用过它）。

## 步骤

### 1. 记录基线

```bash
node scripts/status-western-strings-training-ledger.mjs
```

预期：`recordings: 0`。若非 0，先报告再停下。

### 2. 提交一条录音走受控入口

用复核台（`?mode=strings`）或小程序提交一条已消费的历史录音 + 曲库里已有的谱。

完整顺序（2026-07-28 实跑校正，**`accepted_for_batch` 这一步不能跳**，否则批处理不会选中它）：

```text
提交 → 接受入批 accepted_for_batch → run-batch → 载入全谱打标 → 签署 → 放行
```

提交并接受入批后跑批处理：

```bash
npm run western:controlled-batch-candidate-audit
```

确认该提交产生了 `data/experiments/western-strings-m3/offline-feature-candidates/<batchRunId>/<submissionId>.json`。

### 3. 在复核台完成打标（本次验证的核心）

打开该提交的「训练打标」折叠面板，依次验证：

- **未载入全谱时，签署勾选框必须是禁用的**（这是防止过早签署的闸，务必确认它真的禁用）。
- 点「载入全谱音符」，确认横幅显示总谱音数与工件 SHA 前缀。
- 给 2–3 个音打标：至少一个 `错音`、一个 `正确（否掉机器）`。
- 用「补一个多余演奏事件」加一条 extra 事件（填起始秒即可）。
- 填复核人编号（用 `e2e-reviewer-1`）、演奏者编号（用 `e2e-performer-1`）、勾选知情同意。
- 勾选「完整错误清单」，然后点 `Review` 或 `Release`。
- 界面应回显「训练账本已记录 N 条标签（rev 1）」。

### 4. 验证落盘结果

```bash
node scripts/status-western-strings-training-ledger.mjs
```

必须满足：

- `recordings: 1`，`ok: true`，`dataQuality.invalidRecords: []`
- `counts.implicitCorrect` = 总谱音数 − 你显式打标的数量
- `labels.correct` 包含隐式 correct（不只是你手点的那一个）
- `milestones` 全部 `met: false`（数据量远不够，这是对的）
- `readyToProposeFromScratchTrainingExperiment: false`

再直接看文件（`data/private/western-strings-training-ledger/<recordingId>.jsonl`）：

- 是 **JSONL**，1 行 = 1 次签署
- 该行有 `recordSha256`、`previousRecordSha256`（首条为空串）、`revision: 1`
- `noteLabels` 里的 `measure` / `scoreMidi` / `noteIndex` **来自分析工件**，不是界面传的
- `machineSnapshot.candidateRowsSha256` 与磁盘上工件的实际 SHA 一致

### 5. 验证只追加

用**不同的**复核人编号（`e2e-reviewer-2`）对同一条提交再签一次。

- 文件必须变成 **2 行**，第 1 行内容逐字不变（旧签署人、旧时间、旧标签都在）
- 第 2 行 `previousRecordSha256` == 第 1 行 `recordSha256`
- 状态脚本的 `interRater.doubleReviewedRecordings` 变成 1，并给出 `agreement`

### 6. 补刷绑定链（**不能跳过**）

跑批会让 M3+ 物理最新批审计失配，不补刷会让 release review / pilot decision 全部转红
（2026-07-27 已经因此红过一次）。依次执行：

```bash
npm run western:controlled-batch-candidate-audit
npm run western:m3plus-monitored-pilot-audit
npm run western:release-review
npm run western:controlled-pilot-decision
npm run western:controlled-pilot-start-preflight
npm run western:project-status
npm run test:western-project-gate
```

收工前必须确认：

- `test:western-project-gate` 退出码 **0**
- `releaseReview.readyForControlledPilot: true`
- `controlledPilotDecision.readyToStartControlledPilot: true`
- 学生三开关仍全 `false`
- `round6CounterbalancedCapture.recordingSchedule.stageARecordingAuthorizedNow: true`

### 7. 清理测试数据

本次是验证不是真实教学数据，**验证完请删除**
`data/private/western-strings-training-ledger/<recordingId>.jsonl`，并按 7-24 的做法清掉测试提交，
让账本回到 `recordings: 0`，避免污染真实语料。删除后再跑一次第 6 步的门禁确认仍为绿。

## 需要回报的内容

1. 第 4 步的完整状态 JSON
2. 账本文件两行的原文
3. 第 3 步里「未载入全谱时签署框是否真的禁用」的实际结果
4. 任何一步的报错原文（不要自行改代码绕过；账本的拒绝大多是**设计如此**，
   例如工件 SHA 不符、谱音数对不上、noteId 不在工件内，遇到就照原文回报）
5. 第 6 步收工确认的五项
