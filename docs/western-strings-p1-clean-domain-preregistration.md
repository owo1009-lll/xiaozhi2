# P1 真实干净域候选预注册

- 合同：`western-p1-clean-domain-preregistration-v1`
- 语义 SHA-256：`efe62f7b1dac036336647918f04c158be9f0d3113a6de8b637106cf42cef62f6`
- 来源聚合 SHA-256：`0194dc5f1a63138ee2643470ed2b5f44e58f92eb783f08af8d93e614c6717e8c`
- 冻结顺序：先提交并推送本协议与 runner，再允许运行真实干净域。
- 盲后纪律：看到结果后不改候选、阈值、输入清单或淘汰门槛。
- 发布边界：本轮只做淘汰，不产生学生端授权。

## 候选与精确门槛

| candidate | family | semantic | key thresholds |
|---|---|---|---|
| `alignment-gap-refined-self-check-v1` | alignment-gap | review_hint | `{"temporalParamsByGate":{"drag":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"extra":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.55,"pitchWeight":0.5,"reattackRatio":0.85},"merged_substitution":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"missing":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.45,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7}}}` |
| `alignment-gap-strict-missing-v1` | alignment-gap | automatic_issue_candidate | `{"maxAssignmentGapCount":5,"maxAssignmentGapRate":0.1,"temporalParamsByGate":{"drag":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"extra":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.55,"pitchWeight":0.5,"reattackRatio":0.85},"merged_substitution":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"missing":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.45,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7}}}` |
| `relative-ioi-duration-review-v1` | relative-ioi-duration | review_hint | `{"eventConfidenceAtLeast":0.75,"eventDurationRatioAtLeast":1.2,"relativeIoiDeviationGreaterThan":0.15,"temporalParamsByGate":{"drag":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"extra":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.55,"pitchWeight":0.5,"reattackRatio":0.85},"merged_substitution":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"missing":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.45,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7}}}` |
| `relative-ioi-duration-strict-v1` | relative-ioi-duration | automatic_issue_candidate | `{"eventConfidenceAtLeast":0.75,"eventDurationRatioAtLeast":1.3,"relativeIoiDeviationGreaterThan":0.15,"temporalParamsByGate":{"drag":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"extra":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.55,"pitchWeight":0.5,"reattackRatio":0.85},"merged_substitution":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"missing":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.45,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7}}}` |
| `pitch-trajectory-center-strict-v1` | pitch-trajectory | automatic_issue_candidate | `{"glissandoTargetTailFraction":0.35,"maxIqrCents":80.0,"maxSpreadCentsP95P05":80.0,"minTotalFrameCount":12,"minVoicedFrameCount":12,"minVoicedFrameRatio":0.7,"pitchToleranceCents":50.0}` |
| `onset-density-extra-strict-v1` | onset-density | automatic_issue_candidate | `{"interiorAttackRatioAtLeast":0.85,"interiorEndMargin":"max(0.06 seconds, 8% event duration)","interiorStartMargin":"max(0.12 seconds, 20% event duration)","temporalParams":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.55,"pitchWeight":0.5,"reattackRatio":0.85}}` |
| `temporal-operation-sequence-union-v1` | sequence-model | review_hint | `{"temporalParamsByGate":{"drag":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"extra":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.55,"pitchWeight":0.5,"reattackRatio":0.85},"merged_substitution":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.3,"insertPenalty":1.1,"mergePenalty":0.2,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7},"missing":{"deletePenalty":0.8,"dragDurationRatio":1.3,"dragIoiRatio":0.15,"durationWeight":0.15,"insertPenalty":0.8,"mergePenalty":0.45,"minConfidence":0.45,"pitchWeight":0.5,"reattackRatio":0.7}}}` |

## 冻结输入

- 本地完整干净录音：17 条。
- Round 5 已消费完整真值负位诊断：12 条，只计算非错误位置，不能充当验收。
- 公开专业 Bach：7 条，6 名演奏者，6 部作品，只上报负担，不把未人工裁决偏差写成 FP。
- 当前 M3+ 音高轨迹物理 artifact：11 条。

## 淘汰纪律

- 自动指控候选：本地完整干净集和 Round 5 已知负位均要求 0 FP；公开专业域另受预注册负担上限约束。
- 复核提示候选：完整干净域 pooled hint rate ≤2%，单条 ≤5%；公开专业域 pooled ≤20/1000、单条 ≤50/1000。
- 任一适用门槛超限即淘汰；结果出现后不得放宽。
- 三个学生开关保持 false，M4 OMR 与能量验漏音保持 stop-line。
