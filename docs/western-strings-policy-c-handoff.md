# Policy C 复核辅助真闸（2026-07-21 已完成）

状态：已接入 round4 fresh-blind runner、live-artifact re-audit 和
`western:project-status` 的 `preGateOnly` 证据层。没有修改学生运行时开关。

## 冻结语义

Policy C 采用两层输出，不能把两层合并成“自动判错”：

1. `confirmed_issue`：仅当既有
   `m3plusPitchSafetyEvidence.decision === "issue_detected"` 时成立；这是唯一可称为确诊的机器结果。
2. `self_check_hint`：未确诊，且
   `m3plusTimingAssignmentAvailable !== true`；它只表示 Basic Pitch/DTW 没有给该谱面音分配到事件，只能提示自查，不能指控演奏错误。

这不是 `voicedFrameRatio < 0.2` 的波形能量规则。本轮没有直接测量或冻结波形能量阈值，报告必须保持：

- `waveformEnergyMeasured: false`
- `energyRobustnessReady: false`
- `autoAccusationReady: false`

## round4 冻结结果

同一批 12 个故意错误和 253 个非故意错误位置：

| 输出层 | 故意错误命中 | 非故意位置输出 |
|---|---:|---:|
| 严格确诊 | 2/12 | 0/253 |
| 自查提示增量 | 4/12 | 3/253 |
| 两层合计 | **6/12** | **3/253** |

分项结果：wrong 3/3、missing 3/3、drag 0/3、extra 0/3。由此只能得出“错音/漏音复核候选的召回提高”，不能声称节奏错误已解决。

冻结门槛：

- 故意错误位置至少 12 个；
- 非故意错误位置至少 250 个；
- 两层合计召回至少 50%；
- 自查提示率不高于 2%；
- 严格确诊误指控必须为 0。

当前结果为召回 50%、自查提示率 1.1858%、严格误指控 0，故
`reviewAssistGateReady=true`。把自查提示也按指控计算时，precision proxy 只有
66.67%，低于 90% 自动指控地板，所以自动指控继续关闭。

## 实现与审计

- 评测器：`scripts/eval-western-ordinary-fresh-blind.mjs`
- 回归测试：`scripts/test-western-ordinary-fresh-blind.mjs`
- 项目状态：`scripts/status-western-strings-project.mjs`
- 位置真值：`data/private/western-strings-round4/error-positions.json`
- 冻结报告：`data/experiments/western-strings-round4/ordinary-fresh-blind/report.json`

报告绑定 manifest、机器分析、位置真值和 `evidenceDigestSha256`；项目状态每次从磁盘重算并验证内容。当前项目状态节点为
`tracks.controlledCandidate.ordinaryDynamicShadow.policyCReviewAssistEvidence`。

## 仍未完成

- 节奏通道：字段并非空置，round4 有 246/265 行 relative-IOI 证据；但冻结阈值 0.15 虽抓到 5/6 个 drag/extra，却产生 37 个误报。穷举全部 227 个可能阈值后，召回至少 50% 时最好 precision 仅 16.67%，因此当前局部残差不能用于复核提示或指控。下一候选应改做分段 onset 数量与插入/删除结构匹配。
- 能量鲁棒性：若未来加入波形能量验漏音，必须在手机麦、不同房间和不同演奏者的全新录音上单独建立 fresh-blind 闸，不能用本轮“事件未分配”结果代替。
- 学生端：三个 `WESTERN_STUDENT_RUNTIME_GATE` 开关继续为 `false`；本证据不授予自动反馈权限。
- 样本边界：12/253 足够冻结本轮复核辅助候选，不足以证明跨设备自动指控可靠。
