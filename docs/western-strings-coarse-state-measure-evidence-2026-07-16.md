# M3+ 粗状态与小节三态证据（2026-07-16）

本轮验证“像教师一样先问粗问题”的两个候选方向：音高窗口先分为直/活、单向/交替，以及把逐音证据汇总为小节级教学提示。所有结果均为离线评估，不改变学生端 `fail-closed` 状态。

## 1. M3+ 教师式粗状态

新增命令：

```bash
npm run western:m3plus-coarse-state-eval
```

三份历史复核包共 `98` 条帧级窗口特征，与累计 `98` 条教师标签按 `recordingId + noteId + onset + candidateMode` 完整一一连接：重复键 `0`、缺失键 `0`。排除谱面录音不匹配和未知行为后，得到 `74` 条可评估行、`11` 份录音：

| 教师观察行为 | 行数 | 独立录音数 |
|---|---:|---:|
| stable | 43 | 10 |
| variable-f0 | 21 | 10 |
| slide | 5 | 2 |
| trill | 5 | 3 |

按录音留一结果：

- `straight` 与 `active` 均没有找到同时满足 `precision>=0.90`、`recall>=0.80` 的操作点。
- `straight/active` 的 Logistic Regression ROC-AUC 为 `0.717`，但达到 100% precision 时 recall 仅约 `2.3%/6.5%`。
- `directional` 只有 5 个正例、2 份正例录音；`alternating` 只有 5 个正例、3 份正例录音，均低于最小独立录音门槛。
- `alternating` 的探索性 AUC 较高，但最佳可见点为 precision `0.80`、recall `0.80`，仍未达到安全线且样本过少。

结论：教师式层级问题是合理的判定结构，但历史 `spread/net motion/switch count` 聚合特征不足以支持运行时。当前不接生产；真实补充录音应继续使用新 pYIN 帧级、去趋势、重叠子窗和录音内直音控制，再做冻结 holdout 验证。

## 2. 小节三态反馈

新增保守汇总契约：

- 任一高置信问题存在：`issue_detected`；
- 无问题且至少 80% 音符为 `confirmed_correct`：`confirmed_clean`；
- 其余情况：`insufficient_evidence`。

`uncertain/unsupported` 不得被改写成正确。小节级表述只改变反馈单位，不会凭空增加底层证据。

公开波形扰动审计结果：

| 确认阈值 | clean 小节覆盖率 | 核心扰动危险放行 | 全扰动危险放行 |
|---:|---:|---:|---:|
| 0.80 | 13.22% | 0 | 3 |
| 0.90 | 9.12% | 0 | 2 |
| 1.00 | 8.10% | 0 | 2 |

结论：小节摘要符合教学语义，但当前不能用来扩大自动放行。必须先提高逐音证据覆盖并消除扩展扰动中的危险 clean 判定。

## 3. 当前阻塞

`音频/m3plus-supplemental/m3p-01.m4a` 至 `m3p-04.m4a` 当前仍不存在。真实四模式 holdout 无法运行，不能用合成测试或历史标签替代。录音到位后，现有命令会自动执行定位、F0 质量闸门、模式 P/R/coverage 和前半标定/后半 holdout；任何模式不过仍保持 `review_required`。
