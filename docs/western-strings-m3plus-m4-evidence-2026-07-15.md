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

结论：相对 IOI 对排序有真实信号，可保留为 OMR 修谱候选特征；但起音并集会引入错配，不应接入生产。当前证据只能支持 review/reranking，不能自动改谱。

## 6. 当前裁决

1. M3+ 路线保留：完成真实补充录音后，按模式做正负标定、三态质量闸门和留一曲验证。
2. 小节级结果只做教学摘要，不升级逐音安全结论。
3. M4 坚持双车道：clean score 可进入诊断；OMR 草稿仅用于复核、校对和候选提示。
4. “OMR 与音频一致”不等于真值，学生端仍保持关闭。
5. 小节总时值归一化和受限最小编辑均未改善总体准确率，不进入生产。
6. 相对 IOI 保留为候选排序研究特征；起音双保险已证伪，不接生产。

## 7. 可复现命令

```bash
npm run western:m3plus-supplemental-eval
npm run western:m4-dual-evidence-audit
npm run western:measure-policy-audit
npm run western:m4-measure-duration-probe
npm run western:m4-audio-rhythm-ranking

npm run test:western-m3plus-supplemental-eval
npm run test:western-photo-score
npm run test:western-m4-dual-evidence
npm run test:western-measure-policy
npm run test:western-m4-measure-duration-probe
npm run test:western-m4-audio-rhythm-ranking
```

生成报告均位于 `data/experiments/`，默认被 Git 忽略，不作为学生端运行时配置。
