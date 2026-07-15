# M3+ / M4 非人工验证记录（2026-07-15）

本记录审查两组候选方案：M3+ 的帧级 F0 技法验证与小节级反馈，以及 M4 的 OMR/音频双证、时值约束修复。所有新增入口均为离线评估，不改变学生端默认 `fail-closed` 状态。

## 1. M3+ 帧级 F0 判定

现有实现本来就是“对齐圈窗 + pYIN 帧级 F0”，并非依赖 Basic Pitch 的离散音符事件恢复技法。本轮补强：

- F0 质量闸门：有声覆盖率不足、八度跳变过多或有效帧过少时输出 `uncertain`，不误写为“未出现”。
- 去趋势后再分析周期调制，降低滑音趋势被误判为揉弦的风险。
- 揉弦要求 4-8 Hz 周期调制、20-80 cents 幅度、足够持续时间，并在重叠子窗中重复出现。
- 颤音、滑音、装饰音继续使用谱面预期约束；明显颤音或滑音不再重复计为揉弦。
- 每种模式分别计算 precision、recall、decision coverage，并分别决定 release-ready 或 review-only。

补充录音集并非只有正样本：直音控制和无目标技法窗口可作为已知负例。但未标记的旧录音不能自动视为负例，因为演奏者可能自然使用揉弦。

当前仍缺真实 `m3p-01...04` 补充录音，因此尚不能声称 precision/recall 达标，也不应把该批交给教师复核。正确顺序是先完成机器评估，再只送真正需要人工裁决的少量样本。

为防止同一批数据调参后自证通过，评测现已冻结为：第 1-4 组仅用于标定，第 5-8 组作为 holdout，正式模式闸门只读取 holdout。明确要求直音的标定单元会建立会话级中位数/MAD 基线，输出 `straight / active / uncertain` 相对状态；在真实 holdout 证明增益之前，该状态仅作诊断特征，不参与放行。

## 2. 小节级反馈验证

小节级表达更符合教学语义，但不能替代逐音安全闸门。公开 Bach 扰动审计结果：

| 小节确认阈值 | 干净小节覆盖率 | 核心错音/漏音/迟到危险放行 | 弱音危险放行 |
|---|---:|---:|---:|
| 80% | 13.22% | 0 | 3 |
| 90% | 9.12% | 0 | 2 |
| 100% | 8.10% | 0 | 2 |

结论：小节级汇总适合把已经确认的逐音结果压缩成“本小节暂无明确问题”，但没有带来预期的覆盖率跃升；不能因小节内 80% 音符通过就覆盖弱音风险。

随后用运行时可见的 Basic Pitch 事件置信度做 sweep，检验能否拦下弱音而不依赖 perturbation 真值：

- `eventConfidence≥0.60 + 小节确认≥90%` 可把本批弱音危险误判降为 0，但干净小节覆盖仅 0.93%
- `eventConfidence≥0.65 + 小节确认≥80%` 同样为 0 危险误判，但覆盖仅 0.84%
- 所有零危险操作点均低于 20% 覆盖门槛，也低于现有逐音整体 4% 覆盖

因此置信度守门可以换取安全，却不能扩大覆盖；小节聚合仍只能作为展示层摘要，不能作为新的 auto-pass 单位。

相对 IOI 可降低整体速度和 rubato 对绝对毫秒误差的影响，适合作为节奏辅助特征；它不能证明音高正确，也不能单独证明漏音不存在。起音多检测器并联应先做独立增益评估，不能直接把“并集”当真值。

## 3. M4 OMR 与音频双证

12 份 M2 照片谱拥有独立 MusicXML gold，可直接测量“OMR 与录音一致”子集是否真的安全。离散事件双证结果：

- precision = 98.58%（417/423）
- Wilson 95% 下界 = 96.94%
- gold-note coverage = 17.41%
- 最差单份 precision = 80%
- 55 个 OMR 错音中拦下 40 个，仍漏过 9 个

增加 pYIN 连续 F0 后：

- precision = 98.58%（416/422，四舍五入）
- coverage = 17.37%
- 未改善安全性，反而少确认 1 个正确音

漏网原因不是缺少第二个模型，而是证据相关：演奏者可能按错误 OMR 草稿拉出同一个错误音高，OMR 与音频会“一致地错”。因此 OMR 与音频一致只能作为草稿置信证据，不能替代独立 clean score gold，也不能单独解锁学生端反馈。

## 4. M4 小节总时值约束上限测试

在 5 份独立真值照片谱、1565 个音符上，先测试最理想化的整小节时值归一化，而不急于实现复杂最小编辑求解器：

- baseline onset-quarter accuracy = 2.17%
- normalized accuracy = 1.02%
- 0 份改善，1 份退化

随后实现了受限最小编辑搜索，只允许常见标准时值及二倍/减半候选、必须精确满足拍号，并限制每小节修改数量。结果仍未达标：

- minimal-edit onset-quarter accuracy = 2.04%
- 相对 baseline 下降 0.13 个百分点
- 1 份改善、2 份退化

结论：当前节奏错误不只是“小节总时值不等于拍号”，还包含漏音、声部/backup、错误小节边界与结构解析问题。现阶段不应把整小节缩放接入生产。后续若做最小编辑修复，必须单独建立错误类型 gold，并证明逐类增益。

## 5. 音频相对 IOI 候选排序

在同一批 5 份真实照片谱上，分别计算 clean gold 与 OMR draft 相对录音的“小节内相对 IOI”误差。Basic Pitch 单路结果为：

- 2/5 份达到证据覆盖门槛，2/2 都选择 clean gold，0 次选择错误 draft
- precision = 100%，coverage = 40%，因可判样本少于 3 份，eval-only gate 未通过

加入 spectral-flux onset 与 pYIN voicing boundary 后，覆盖反而下降：

- 1/5 可判，1/1 选择 clean gold，coverage = 20%

为排除“整首统计样本太少”的假象，又在 50 个 gold/draft 音高序列完全相同的单声部小节上做了小节级排序，并用按曲留一选择 margin：

- 默认 60% 区间覆盖阈值下，Basic Pitch 有 10/50 小节证据就绪，只自动选择 3 个，其中 2 个正确、1 个错误：precision = 66.67%，coverage = 6%
- 把覆盖阈值放宽到 30% 后，固定 margin 最高仅 precision = 80%、coverage = 10%
- spectral-flux + pYIN 起音并集在默认阈值下选择 2 个，2 个都错误：precision = 0%，coverage = 4%
- Basic Pitch 与起音并集的按曲留一 margin 均找不到满足训练 precision≥90% 的操作点，安全选择数为 0

结论：相对 IOI 对部分整首候选有排序信号，但没有形成可跨曲泛化的小节级安全选择器；起音并集会引入更多错配。它只能保留为复核界面的辅助证据，不能自动改谱或解锁节奏反馈。

## 6. 2026-07-16 非人工优化补测

### 6.1 M4 多引擎自适应共识

新增 `western:m4-engine-consensus`，以 Audiveris 坐标为锚点，只使用运行时可见的引擎输出做选择，独立 gold 只用于评估。固定策略为：有 Oemer 输出时要求 Audiveris、HOMR、Oemer 三者音高一致且局部 onset 差不超过 0.25 quarter；Oemer 不可用时要求 Audiveris 与 HOMR 满足同样条件。

5 份独立真实照片谱上，该自适应子集为 `344/344` 正确，precision=`100%`，gold coverage=`21.98%`，5/5 谱的 precision 子门均通过。它证明 M4 可以通过更强证据减少错误草稿，但还不能接生产：样本只有 5 份，部分单谱 coverage 低于 20%，运行时坐标适配和更大独立照片集尚未验收，因此 `runtimeReady=false`、`studentGateReady=false` 不变。

### 6.2 普通录音的动态音符定位

旧离线执行器按谱面总时长把音符线性摊到整段录音。受控正确样本的首音因此被放到 0 秒，pYIN 中位误差达到 `3300 cents`。新增默认关闭的 `--timing-mode basic-pitch-dtw`：Basic Pitch 只负责提出音频事件，带 gap penalty 的一对一单调匹配负责圈定谱音时间，pYIN 在事件内部稳定区测连续音高；未匹配音符直接拒判，不回退旧线性时间。

同一正确录音前 20 音从 `0/20` 音高支持提升到 `20/20`，中位绝对误差从 `3300 cents` 降到 `5 cents`。随后 `western:offline-dynamic-timing-audit` 复用缓存、串行审计全部 12 条受控录音：2588 个谱音中 1155 个获得一对一时间分配（44.63%），968 个同时获得 ±80 cents 稳定 F0 支持（37.40%），录音中位误差的中位数为 10 cents。

该结果解决的是“旧线性窗根本圈错”的候选生成问题，不是 precision 证明。correct 组的支持率为 35.49%，wrong_pitch 组为 35.97%，仅靠支持率无法区分正确与错音；录音级 scenario 也没有给出逐音错误位置。因此动态模式仍只输出 `review_required`，`coverage=0` 的学生安全语义保持不变。下一步必须对动态候选使用独立逐音真值，不能把旧线性窗口的标签迁移过来。

## 7. 当前裁决

1. M3+ 路线保留：完成真实补充录音后，按模式做正负标定、三态质量闸门和留一曲验证。
2. 小节级结果只做教学摘要，不升级逐音安全结论。
3. M4 坚持双车道：clean score 可进入诊断；OMR 草稿仅用于复核、校对和候选提示。
4. “OMR 与音频一致”不等于真值，学生端仍保持关闭。
5. 小节总时值归一化和受限最小编辑均未改善总体准确率，不进入生产。
6. 相对 IOI 保留为候选排序研究特征；50 小节按曲留一与起音双保险均未过闸，不接生产。

7. M4 多引擎共识与普通录音动态定位均有实质增益，但在独立盲验完成前只作为 review 候选，不自动给学生结论。

## 8. 可复现命令

```bash
npm run western:m3plus-supplemental-eval
npm run western:m4-dual-evidence-audit
npm run western:measure-policy-audit
npm run western:m4-measure-duration-probe
npm run western:m4-audio-rhythm-ranking
npm run western:m4-engine-consensus
npm run western:offline-dynamic-timing-audit

npm run test:western-m3plus-supplemental-eval
npm run test:western-photo-score
npm run test:western-m4-dual-evidence
npm run test:western-measure-policy
npm run test:western-m4-measure-duration-probe
npm run test:western-m4-audio-rhythm-ranking
npm run test:western-m4-engine-consensus
npm run test:western-offline-feature-audio
npm run test:western-offline-dynamic-timing
```

生成报告均位于 `data/experiments/`，默认被 Git 忽略，不作为学生端运行时配置。
