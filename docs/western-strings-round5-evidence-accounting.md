# Round 5 证据重记账

结论：Round 5 已消费；本报告只重分类，不调阈值、不重训、不复考。

| 候选 | 观测 | 位置结论 | 可保留结论 |
|---|---:|---|---|
| `segment-rf-merged_substitution` | TP=1, FP=1, P=50.00%, R=16.67% | `invalidated-by-position-confounding` | Package-specific predictions are reproducible, but neither precision nor recall establishes performance generalization. |
| `segment-rf-missing` | TP=0, FP=0, P=0.00%, R=0.00% | `invalidated-by-position-confounding` | Package-specific predictions are reproducible, but neither precision nor recall establishes performance generalization. |
| `segment-rf-extra` | TP=3, FP=0, P=100.00%, R=50.00% | `invalidated-by-position-confounding` | Package-specific predictions are reproducible, but neither precision nor recall establishes performance generalization. |
| `segment-rf-drag` | TP=3, FP=1, P=75.00%, R=50.00% | `invalidated-by-position-confounding` | Package-specific predictions are reproducible, but neither precision nor recall establishes performance generalization. |
| `gap-refinement-self-check` | TP=1, FP=1, P=50.00%, R=8.33% | `genuine-detection-failure-on-fixed-position-sample` | The frozen rule truly detected only 1/12 targets and produced one full-score false positive; position leakage cannot explain away the 11 misses. |
| `gap-strict-missing` | TP=1, FP=1, P=50.00%, R=16.67% | `genuine-detection-failure-on-fixed-position-sample` | The frozen strict rule truly detected 1/6 missing targets and produced one full-score false positive; its 16.67% recall is not a score-position model artifact. |
| `rhythm-structural-self-check` | TP=4, FP=0, P=100.00%, R=33.33% | `real-sensitivity-observation-safety-not-generalizable` | The frozen performance rule really found 4/12 targets and missed 8/12. |
| `rhythm-strict-extra-drag` | TP=4, FP=0, P=100.00%, R=33.33% | `real-sensitivity-observation-safety-not-generalizable` | The frozen strict performance rule really found 4/12 targets and missed 8/12. |
| `performance-only-calibration-merged_substitution` | TP=3, FP=1, P=75.00%, R=50.00% | `position-controlled-calibration-diagnostic-failed` | After excluding score-only features, the fixed RF still fails the 90/50/0 joint floor on calibration leave-one-recording-out. |
| `performance-only-calibration-missing` | TP=3, FP=1, P=75.00%, R=50.00% | `position-controlled-calibration-diagnostic-failed` | After excluding score-only features, the fixed RF still fails the 90/50/0 joint floor on calibration leave-one-recording-out. |
| `performance-only-calibration-drag` | TP=4, FP=1, P=80.00%, R=66.67% | `position-controlled-calibration-diagnostic-failed` | After excluding score-only features, the fixed RF still fails the 90/50/0 joint floor on calibration leave-one-recording-out. |
| `waveform-energy-absence` | TP=0, FP=0, P=0.00%, R=0.00% | `genuine-cross-domain-detection-failure` | The frozen synthetic threshold emitted no flag on any of 12 real targets. Its 0% real-domain recall is a genuine transfer failure. |
| `waveform-target-pitch-absence` | TP=5, FP=49, P=9.26%, R=41.67% | `genuine-cross-domain-precision-and-recall-failure` | The frozen synthetic threshold found 5/12 targets but flagged 49/660 ordinary positions; the 9.26% precision failure is not caused by score-position leakage. |

## 裁决

- 片段随机森林四个 gate 的原始数字全部失去泛化资格；不是四个都“检测失败”，而是训练或评测位置已混淆。
- gap 自查 `1/12` 与 missing strict `1/6` 是冻结、无位置输入规则的真实漏检；位置混淆不能把它们救回来。
- rhythm soft/strict 的 `4/12` 是可保留的真实灵敏度观测，但 `0/312 FP` 不能作为独立安全结论。
- 固定能量阈值在真实 Round 5 为 `0/12`，判定跨域失败并收线；target-pitch 阈值为 `5/12 @ 49/660 FP`，同样淘汰。
- 排除谱面特征后的 calibration LORO 没有任何候选通过 `90% precision / 50% recall / 0 FP`。
- 严格确诊维持 `2/12`，所有学生开关保持 false。

机器证据源和 SHA-256 见配套 JSON。
