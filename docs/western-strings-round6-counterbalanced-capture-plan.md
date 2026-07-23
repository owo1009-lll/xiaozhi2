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
- fresh-blind 只允许一次，不得用 Round 4/5 音频替代。

## 生成与录前验证

```powershell
npm run western:round6-counterbalanced-capture-pack
npm run western:round6-position-balance
npm run test:western-round6-counterbalanced-capture-pack
npm run test:western-round6-project-status
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
- 当前该节点为 `readyForRecording=true`、`intakeReady=false`。篡改 truth、manifest 或合同后，旧报告不会继续显示绿灯。

私密材料位于 `data/private/western-strings-round6-counterbalanced/`。该目录不入 Git。

## 录音后的签署

每条录音必须：

1. 按对应 PDF 和 `*-演奏说明.md` 从头到尾完整演奏；
2. 不得只录某一个 rotation；同谱三条必须全部完成；
3. 在 `position-truth.json` 逐事件填写 `asPerformed`；
4. 把该条 `completeErrorInventory` 改为 true；
5. manifest 的 `consent` 改为 `yes`、`licenseStatus` 改为 `local-only`；
6. 音频按 manifest 的 `recordingId.m4a` 放入同一私密目录；
7. 运行 `npm run western:round6-targeted-intake`。

当前 intake 只证明设计分母完整：12 条、144 事件、四类各 `12/24`，fresh 各 `6/12`。它保持 `ready=false`；项目状态现场重算的待补量为 12 条音频、12 条同意、12 条许可、144 个 `asPerformed` 和 12 个完整错误清单。这是正确的 fail-closed 状态。
