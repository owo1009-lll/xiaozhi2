# P3 最小录音分阶段协议

结论：现在非录不可的是 **6 条 calibration**，不是 0，也不是一次录满 12。只有这 6 条训练出的冻结候选先通过既有真实干净域安全闸，才追加 6 条 untouched fresh。

- 当前不可避免：`6` 条。
- 条件追加：`6` 条。
- 最坏总量：`12` 条。
- Stage A 失败可避免：`6` 条 fresh。
- 协议语义 SHA-256：`e249bfdc21d9e722d83a0788647fed1eefc14b45064460be0a88a2afe159195f`。

## 为什么必须先录 6 条

P1 的 7 个可直接运行候选全部因真实干净域过度标注而淘汰；唯一尚未执行的 `performance-only-RF-v2` 明确需要新的反平衡 calibration 才能拟合。P2 检查的 5,326 个公开参考音符事件没有任何经裁定错误正例，也没有同声部正确/错误演奏对，不能代替 calibration。

## Stage A：只录 calibration 6 条

录音 ID：`r6-cal-a-01`, `r6-cal-a-02`, `r6-cal-a-03`, `r6-cal-b-01`, `r6-cal-b-02`, `r6-cal-b-03`。

两份 calibration 新谱各录三次；同一位置在三次中轮换为 1 次正例、2 次混淆负例。每个 gate 合计 6 个正例和 12 个混淆负例。

冻结候选：

- 模型：`full-score-performance-only-random-forest-binary-per-gate`；决策点 `0.5`。
- RF：`{"class_weight": "balanced_subsample", "max_depth": 4, "min_samples_leaf": 2, "n_estimators": 256, "n_jobs": 1, "random_state": 20260722}`。
- 禁止谱面位置特征：`n_0OutOfRange, n_m1OutOfRange, n_m2OutOfRange, n_p1OutOfRange, n_p2OutOfRange, scoreNextInterval, scorePreviousInterval`。
- 禁止固定声学堆叠：`acousticAvailable, targetInteriorAttackRatio, targetMeanVoicedProbability, targetNearPitchOccupancy, targetOnsetMax, targetOnsetMean, targetOnsetPeakCount, targetPeakDb, targetPitchOccupancy, targetRmsDb, targetVoicedFrameRatio`。
- 必须时序特征：`n_0AssignmentGap, n_0DurationMissing, n_0DurationRatio, n_0IoiDeviation, n_0IoiMissing, segmentMaxIoiDeviation, segmentMeanIoiDeviation, targetWindowEventCount`。

训练后先跑既有 P1 干净域，自动指控候选必须同时满足：

- 本地权威 clean：FP `≤0`。
- Round 5 已消费普通位置：FP `≤0`，只作诊断。
- 公开专业演奏：合并负担 `≤5.0/1000`，任一录音 `≤10.0/1000`。

任一超限立即淘汰并收线，不录 fresh。

## Stage B：仅在 Stage A 通过后补 fresh 6 条

录音 ID：`r6-fresh-a-01`, `r6-fresh-a-02`, `r6-fresh-a-03`, `r6-fresh-b-01`, `r6-fresh-b-02`, `r6-fresh-b-03`。

模型、特征、决策点和门槛全部保持冻结；fresh 只读一次。每个 gate 的门槛仍为 P≥90%、R≥50%、strict FP=0，任一数值通过也不自动取得学生端发布授权。

## 不变的红线

- Round 4/5 不复用作验收。
- Stage A 不读取 fresh；Stage B 看过结果后不回调、不重测。
- 合成召回不代表真实召回。
- M4 OMR 与能量验漏音继续收线。
- 学生三个开关保持 false，系统 fail-closed。

机器可核验来源与 SHA-256 见配套 JSON。
