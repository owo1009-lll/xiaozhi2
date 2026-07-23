# Policy C 复核辅助真闸（2026-07-21 已完成）

状态：已接入 round4 fresh-blind runner、live-artifact re-audit、教师本机复核台和
`western:project-status`。没有修改学生运行时开关。

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

教师复核运行时使用 `western-round4-policy-c-review-assist-v1` 契约：每个物理批次候选都持久化
`confirmed_issue` / `self_check_hint` / `no_issue_output`，复核台只展示前两类；页面刷新后从最新批次工件恢复。
候选工件审计会重算每行语义、汇总数量和预览，任一不一致即失败。该运行时状态见
`tracks.controlledCandidate.ordinaryDynamicShadow.policyCReviewAssistRuntime`。公网守卫继续禁止访问受控批次和复核接口，
学生提交响应也不含 `reviewAssist` 字段。

## 仍未完成

- 确诊结构候选：round4-r4-06 暴露了一个“错音与后继同音高事件被 Basic Pitch 合并”的窄模式。规则在已查看的 round4 上把诊断上限从 2/12 提到 3/12，非故意位置 0/253；但因为它是看过 round4 后提出，13 套外部集合又没有独立正例复现，所以只登记为 development pre-gate，不进入教师复核或学生端。
- 节奏通道：字段并非空置，round4 有 246/265 行 relative-IOI 证据；冻结单阈值 0.15 虽抓到 5/6 个 drag/extra，却产生 37 个误报。后续多信号结构合取在旧证据上的回顾性上限较高，但 2026-07-23 原样投向 complete-inventory Round 5 后，soft 与 strict 层均只有 `4/12 @ 0 FP`、P/R=`100%/33.33%`，extra、drag 各 `2/6`，低于 50% recall 地板。该候选已被 fresh-blind 判为不晋升，正式确诊仍为 2/12。
- gap 严格候选：原始 gap 精炼在公开专业长曲有 595 个提示，因此只保留为自查；recording-level 对齐健康守卫（gap `<=5` 且 rate `<=10%`）在旧证据上的回顾数字不能替代新验收。Round 5 gap 自查实际为 `1/12 @ 1 FP`，missing-targeted 严格层为 `1/6 @ 1 FP`，同时违反 precision、recall 与 `FP=0`，故失败，正式确诊仍为 2/12。
- 片段模型：同一 Round 5 首跑中，固定 gate-specific segment baseline 按独立子闸判定，仅 `extra` 达到 `3/6 @ 0/12 confusion FP`、P/R=`100%/50%`，可冻结为教师复核候选证据；merged substitution、missing、drag 均失败。fresh split 已消费，禁止在其上调参重考；改模只能用 calibration 开发，并须换新 untouched fresh 包验收。学生自动指控仍关闭。
- 能量/目标音高归因：现已对 authoritative assignment gaps 重建邻接时间窗。直接 RMS 在合成开发/holdout 可达 P=100%、R=73.33%/60.00%，但阈值约为 `-134.83dB`，本质只学到了注入器制造的数字静音；round4 真实漏音召回为 0/3。pYIN 目标音高占用率在合成 P=100%、R=73.33%/80.00%，到 round4 则为 P/R=42.86%/100%，因为 3 个真实漏音和其余 4 个 assignment gaps 的目标音高占用率都为 0。两条都证明合成到真实域失效，不能进入复核提示或指控。下一轮必须在手机麦、不同房间/演奏者的全新录音中同时收漏音正例与滑音、错音、邻音延长、普通对齐缺口混淆负例，再建立独立 fresh-blind 闸。
- 学生端：三个 `WESTERN_STUDENT_RUNTIME_GATE` 开关继续为 `false`；本证据不授予自动反馈权限。
- 样本边界：12/253 足够冻结本轮复核辅助候选，不足以证明跨设备自动指控可靠。
