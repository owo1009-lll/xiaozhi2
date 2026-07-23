# Round 6 反向配平自动诊断采集计划

状态：**12 槽技术设计通过；当前只授权 Stage A 的 6 条 calibration，fresh 6 条未授权。**

## 当前调度冻结

- 权威分阶段协议：`docs/evidence/western-strings-p3-minimal-recording-preregistration-20260724.json`
- 协议语义 SHA-256：`d08bff4b76a114feaf93f4d2d00fb2e37df54660d67b0edc7d6fc1f313777a3f`
- 现在录：`r6-cal-a-01/02/03`、`r6-cal-b-01/02/03`，共 6 条；
- 现在不要录：全部 `r6-fresh-*`；Stage A 执行时这些音频必须不存在；
- `readyForRecording=true` 仅表示 12 槽技术包与材料可用，调度权威是 `recordingSchedule`；
- 当前现场状态：`stageARecordingAuthorizedNow=true`、`stageBFreshRecordingAuthorizedNow=false`、`recordAllTwelveNow=false`；
- Stage A 失败、崩溃或来源失配即收线，省掉 fresh 6 条，strict 保持 `2/12`；
- 只有 Stage A 使用冻结参数训练出的候选通过既有真实干净域安全闸，才允许补 6 条 untouched fresh。

## 为什么不用固定目标槽

Round 5 的音频与 cal/fresh 映射无误，但标签位置混杂：

- gate-specific extra 数值虽为 `3/6 @ 0/12 FP`，fresh 的 6 正/12 负可由前一音程直接分开；
- 节奏 soft/strict 虽为 `4/12 @ 0/312 FP`，静态谱面上下文随机森林在 calibration 和 fresh 各自留一录音中都能识别 `12/12` extra+drag 目标位置且为 `0/324 FP`。

因此不能再让同一种错误永久绑定同一小节。新包采用 crossover：每份谱录三次，同一位置依次轮换为正例、混淆负例 A、混淆负例 B。

## 冻结设计

- 合同：`config/western-strings-round6-counterbalanced-contract.json`
- 4 份全新谱：calibration 2 份、fresh-blind 2 份；
- 每份谱 3 次录音，最大条件总包共 12 条；当前 Stage A 只执行其中 calibration 两谱×三次，共 6 条；
- calibration/fresh 演奏者占位符完全分离，共 6 人、3 设备、4 房间；
- 每类 gate 共 12 正例、24 混淆负例；fresh 为 6 正例、12 混淆负例；
- 每个 gate 的每个目标位置在同谱三次录音中恰好出现 1 次正例和 2 次负例；
- 自动指控数字仍用原门槛 `P>=0.90 / R>=0.50 / strict FP=0`，没有用 Round 5 结果降门槛；
- `strict FP=0` 的分母不是 12 个预设混淆槽位：对每个 gate，fresh 中**每一个谱面位置**只要不是该 gate 的签署正例，就必须计为严格负例；普通未列位置、其他 gate 正例和其他 gate 对照均不得漏算；
- fresh-blind 只允许一次，不得用 Round 4/5 音频替代。
- 评测协议已在音频到位前重新冻结为 `config/western-strings-round6-evaluation-protocol.json`：逐 gate 随机森林 v2 使用完整谱面位置分母，只保留对齐/演奏证据；明确排除前后音程、片段边界等 7 个谱面上下文特征，以及在既有烟测中使真实域召回退化的固定 RMS/pYIN/onset 堆叠。协议同时强制保留 assignment-gap、relative-IOI、时值比和目标窗事件数等 8 个时序字段，并与 gap refinement/strict、rhythm structural/strict 一同冻结；固定参数、0.5 决策点和门槛均不得在 fresh 后修改。该变更用于消除泄漏和锁定证据通道，不构成召回提升声明。
- `western:round6-frozen-eval` 在读取 fresh 前先写一次性 consumed ledger；运行崩溃也视为 fresh 已消费，后续新候选必须换全新未触碰采集包。候选返回后，runner 还会把两 split、四 gate 的全谱位置数、签署正例、混淆负例、其他 gate 事件、普通未列位置和总数据行数与 intake 逐项复算；缺字段或任一分母不一致都记为评测失败，不得形成晋升证据。

## 生成与录前验证

```powershell
npm run western:round6-counterbalanced-capture-pack
npm run western:round6-position-balance
npm run test:western-round6-counterbalanced-capture-pack
npm run test:western-round6-project-status
npm run test:western-round5-truth-signoff-pack
npm run test:western-round6-truth-signoff-apply
npm run test:western-round6-stage-a-signoff
npm run test:western-round6-stage-a-safety
npm run test:western-round6-frozen-eval
npm run test:western-round6-full-score-candidate
npm run western:project-status
```

当前结果：

- 12/12 标注 PDF 已生成；
- 12/12 独立演奏说明已生成；
- v2 全谱位置预检 `readyForRecording=true`；
- `confoundedSplitGates=[]`；
- `rhythmConfoundedSplits=[]`；
- 预检 `audioRead=false`，不使用任何录音或表现标签。
- 项目状态节点 `tracks.controlledCandidate.ordinaryDynamicShadow.round6CounterbalancedCapture` 从磁盘重算分母和材料，并把 position preflight、intake 分别绑定到当前 contract/manifest/truth 哈希；
- 同一节点还现场重哈希评测协议绑定的执行守卫、全谱候选 runner、历史特征提取器、temporal-operation 规则、intake validator、音频特征分析器和 Round 6 合同；v2 协议 SHA-256 为 `7546020e1e0f326910b160c7bca0f12602c40bce9477efd764c4f23e2f4e3d75`，当前 `evaluationProtocol.runnerReady=true`、`freshBlindConsumed=false`、`evaluationPerformed=false`；
- 当前该节点为 `readyForRecording=true`、`intakeReady=false`，同时 `recordingSchedule.valid=true`、当前精确外部输入为 6 条 calibration 音频、6 条同意、6 条许可、72 个 `asPerformed` 和 6 个完整错误清单。篡改 truth、manifest、合同、分阶段协议或其 12 个来源后，旧绿灯不会继续有效。

私密材料位于 `data/private/western-strings-round6-counterbalanced/`。该目录不入 Git。

## Stage A：当前六条录音与签署

1. 只按对应 PDF 和 `*-演奏说明.md` 完整录制六条 `r6-cal-*`；同谱三条 rotation 必须全部完成，任何 `r6-fresh-*` 音频都不要放入目录。
2. 运行：

   ```powershell
   npm run western:round6-stage-a-truth-signoff-pack
   ```

   打开私密目录下的 `stage-a-truth-signoff/index.html`。页面无机器预测，只包含六条 calibration，并绑定六条音频 SHA。
3. 逐条试听并完成 72 个 `asPerformed`、6 个 `completeErrorInventory`，必要时补计划外错误；同时核对每条实际演奏者匿名 ID、设备、房间、同意和仅本地许可，然后下载完成 JSON。
4. 先 dry-run，不写源文件：

   ```powershell
   npm run western:round6-stage-a-truth-signoff-apply -- --completed "下载文件的绝对路径"
   ```

   只有输出 `readyToApply=true` 才继续。预检会核对分阶段协议语义 SHA、原始合同/manifest/truth、六条音频 SHA、六条 calibration ID、72 个事件以及至少 3 演奏者/3 设备/2 房间；fresh 六行和 truth 必须保持未签署、未暴露。
5. 显式应用：

   ```powershell
   npm run western:round6-stage-a-truth-signoff-apply -- --completed "下载文件的绝对路径" --apply
   ```

   工具只更新六条 calibration，保留 fresh 六行和 72 个未签署事件，并留下旧哈希备份及 `western-round6-stage-a-signoff-lineage-v1` ledger。
6. 重跑位置平衡并做只读安全预检：

   ```powershell
   npm run western:round6-position-balance
   npm run western:round6-stage-a-safety-preflight
   ```

   预检要求 fresh 音频不存在，六条 calibration 的音频/签署/授权/来源全部 current，并再次确认位置混淆为空。
7. 预检通过后只执行一次：

   ```powershell
   npm run western:round6-stage-a-safety-eval
   ```

   它只用 calibration 拟合冻结的逐 gate RF，并在读取既有 clean 安全结果前写 consumed ledger。随后检查：本地权威 clean `FP=0`、Round 5 已消费普通位置 `FP=0`、公开专业合并负担 `≤5/1000`、任一公开录音 `≤10/1000`。任一超限、崩溃或绑定失配均 fail-closed，不得重跑，也不得录 fresh。

## Stage B：仅在安全闸通过后

只有 `western:project-status` 明确给出 `recordingSchedule.stageBFreshRecordingAuthorizedNow=true` 时，才录 `r6-fresh-a-01/02/03` 与 `r6-fresh-b-01/02/03`。冻结模型、特征、0.5 决策点和安全门槛不得再改；fresh 只允许读取一次。完整包随后仍按全谱严格分母执行 `P>=0.90 / R>=0.50 / strict FP=0`，任何数值通过只形成性能证据，不等于发布授权，`automaticAccusationReady` 与学生端三个开关继续保持 false。

当前状态是正确的 fail-closed：Stage A 待补 6 条音频、6 条同意、6 条许可、72 个 `asPerformed` 和 6 个完整错误清单；Stage B fresh 未授权且未消费。
