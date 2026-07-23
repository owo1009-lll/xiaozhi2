# Round 6 反向配平自动诊断采集计划

状态：**录前设计通过，录音未到位，不能评测或晋升。**

## 为什么不用固定目标槽

Round 5 的音频与 cal/fresh 映射无误，但标签位置混杂：

- gate-specific extra 数值虽为 `3/6 @ 0/12 FP`，fresh 的 6 正/12 负可由前一音程直接分开；
- 节奏 soft/strict 虽为 `4/12 @ 0/312 FP`，静态谱面上下文随机森林在 calibration 和 fresh 各自留一录音中都能识别 `12/12` extra+drag 目标位置且为 `0/324 FP`。

因此不能再让同一种错误永久绑定同一小节。新包采用 crossover：每份谱录三次，同一位置依次轮换为正例、混淆负例 A、混淆负例 B。

## 冻结设计

- 合同：`config/western-strings-round6-counterbalanced-contract.json`
- 4 份全新谱：calibration 2 份、fresh-blind 2 份；
- 每份谱 3 次录音，共 12 条；
- calibration/fresh 演奏者占位符完全分离，共 6 人、3 设备、4 房间；
- 每类 gate 共 12 正例、24 混淆负例；fresh 为 6 正例、12 混淆负例；
- 每个 gate 的每个目标位置在同谱三次录音中恰好出现 1 次正例和 2 次负例；
- 自动指控数字仍用原门槛 `P>=0.90 / R>=0.50 / strict FP=0`，没有用 Round 5 结果降门槛；
- `strict FP=0` 的分母不是 12 个预设混淆槽位：对每个 gate，fresh 中**每一个谱面位置**只要不是该 gate 的签署正例，就必须计为严格负例；普通未列位置、其他 gate 正例和其他 gate 对照均不得漏算；
- fresh-blind 只允许一次，不得用 Round 4/5 音频替代。
- 评测协议已在音频到位前冻结为 `config/western-strings-round6-evaluation-protocol.json`：逐 gate 固定随机森林现在使用完整谱面位置分母，并与 gap refinement/strict、rhythm structural/strict 一同冻结；固定参数、0.5 决策点和门槛均不得在 fresh 后修改。
- `western:round6-frozen-eval` 在读取 fresh 前先写一次性 consumed ledger；运行崩溃也视为 fresh 已消费，后续新候选必须换全新未触碰采集包。

## 生成与录前验证

```powershell
npm run western:round6-counterbalanced-capture-pack
npm run western:round6-position-balance
npm run test:western-round6-counterbalanced-capture-pack
npm run test:western-round6-project-status
npm run test:western-round5-truth-signoff-pack
npm run test:western-round6-truth-signoff-apply
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
- 同一节点还现场重哈希评测协议绑定的执行守卫、全谱候选 runner、历史特征提取器、temporal-operation 规则、intake validator、音频特征分析器和 Round 6 合同；当前 `evaluationProtocol.runnerReady=true`、`freshBlindConsumed=false`、`evaluationPerformed=false`；
- 当前该节点为 `readyForRecording=true`、`intakeReady=false`。篡改 truth、manifest 或合同后，旧报告不会继续显示绿灯。

私密材料位于 `data/private/western-strings-round6-counterbalanced/`。该目录不入 Git。

## 录音后的签署

每条录音必须：

1. 按对应 PDF 和 `*-演奏说明.md` 从头到尾完整演奏；
2. 不得只录某一个 rotation；同谱三条必须全部完成；
3. 12 条音频全部按 manifest 命名放好后，运行 `npm run western:round6-truth-signoff-pack`，打开私密目录下的 `truth-signoff/index.html`；
4. 页面不显示任何机器预测；逐条试听后填写全部 `asPerformed`，必要时追加计划外错误，并签署每条 `completeErrorInventory`。同时核对每条实际演奏者匿名 ID、设备、房间、同意和仅本地许可；全部检查通过后下载 `western-round6-truth-signoff.completed.json`；
5. 先只读预检，不写任何源文件：

   ```powershell
   npm run western:round6-truth-signoff-apply -- --completed "下载文件的绝对路径"
   ```

   预检会重新核对合同、manifest、原始 truth、12 条音频 SHA、录音 ID 集、逐事件位置、6/3/4 覆盖和 cal/fresh 演奏者隔离。只有输出 `readyToApply=true` 才继续；
6. 显式应用并自动留下按旧哈希命名的两份 `.bak`：

   ```powershell
   npm run western:round6-truth-signoff-apply -- --completed "下载文件的绝对路径" --apply
   ```

   此命令只更新私密 `position-truth.json` 的人工真值，以及 manifest 的演奏者、设备、房间、同意和许可五类字段；其余列保持原样；
7. 因 manifest/truth 哈希已改变，依次重跑 `npm run western:round6-position-balance` 和 `npm run western:round6-targeted-intake`，不得沿用签署前报告。
8. 只有 intake 输出 `ready=true` 后，运行一次且仅一次：

   ```powershell
   npm run western:round6-frozen-eval
   ```

   runner 只用 calibration 训练/检查候选，fresh 不参与选型；fresh 开始读取前即写 consumed ledger。评测器会把 fresh 的全部谱面位置逐 gate 展开，除该 gate 签署正例外全部计入严格假阳分母，不能只在预设混淆槽位上报 `0 FP`。任何数值过门只形成晋升证据，不等于发布授权，`automaticAccusationReady` 和学生端开关仍保持 false，必须另走显式发布决定。

当前 intake 只证明设计分母完整：12 条、144 事件、四类各 `12/24`，fresh 各 `6/12`。它保持 `ready=false`；项目状态现场重算的待补量为 12 条音频、12 条同意、12 条许可、144 个 `asPerformed` 和 12 个完整错误清单。签署页和 frozen eval 当前都会因输入未到位而非零退出；后者保持 `freshBlindConsumed=false`，不会提前读取或消耗 fresh。这是正确的 fail-closed 状态。
