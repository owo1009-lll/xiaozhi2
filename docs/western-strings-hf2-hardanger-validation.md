# HF2 Hardanger Fiddle 外部压力验证

更新时间：2026-07-13

## 1. 用途与边界

HF2 用于检验冻结的 MUSC 小提琴转写模型在复音、装饰音和表现性弓弦录音上的域外鲁棒性。它不是古典小提琴发布集，也不是学生错误录音集。

- 数据源：`Bots4M/HF2-Hardanger-fiddle-dataset`
- 固定 revision：`b9f5d564bd8f9e7e6a841905681c301229b5d76a`
- 许可证：CC BY 4.0
- 数据规模：119 对 WAV/MIDI、39 首曲目
- 主要人工验证子集：100 条 HF1 表现变体、20 首曲目、69,176 个 MIDI 音符
- 直接核心：20 条 `original` 演奏
- 表现压力：80 条 `angry/happy/sad/tender` 变体

HF1 的原始演奏由演奏者标注；表现变体的标签经转移后人工核对。其余 19 条 processed/archival 记录只参与文件审计，不进入主要模型结论。

## 2. 数据审计

```bash
npm run western:hf2-hardanger-audit
npm run test:western-hf2-hardanger-audit
```

当前审计结果：

- `readyPairs=119`
- `hf1HumanVerifiedRows=100`
- `hf1HumanVerifiedSongs=20`
- `polyphonicPairCount=119`
- `readyForExternalHumanVerifiedStressPilot=true`
- `readyForClassicalViolinReleaseBenchmark=false`
- `readyForStudentRelease=false`

审计报告位于 `data/experiments/western-strings-hf2-hardanger-audit.json`。原始数据、模型缓存和报告均在 gitignored `data/`，不得提交到 Git。

## 3. 低负载增量协议

当前电脑不允许一次连续推理 20 或 100 条。评测命令使用单进程顺序小批量：每次最多新增 2 条、总音频时长不超过 100 秒、`batch=128`，不并行；已有缓存只复用，不重复计算。未缓存录音按时长从短到长调度，避免长录音反复撞固定时间闸，也避免每条重复支付超过 60 秒的模型初始化成本。

HF2 的整数 MIDI、onset-only 评分已从 `mir_eval` 稠密/私有匹配器改为 SciPy 稀疏 Hopcroft-Karp 最大二分匹配。真实第一条缓存（551 gold / 371 estimated）三档容差总计耗时约 0.004 秒；原路径在同一缓存上超过 10 分钟。该优化只替换等价的最大匹配实现，不修改模型输出、冻结阈值或 gate。

先查看进度，状态命令不会加载 Torch 模型，也不会执行 note matching：

```bash
npm run western:hf2-hardanger-musc-direct-status
```

每次推进一个受资源上限约束的小批量：

```bash
npm run western:hf2-hardanger-musc-direct
```

只有 `20/20` 完成且 `hardangerDirectCoreV2Passed=true`，表现压力入口才会解锁。之后仍使用相同的小批量资源上限：

```bash
npm run western:hf2-hardanger-musc-all
```

禁止在本机把 `--max-new-units` 调成大批量。`--max-new-units 0` 是纯状态模式；未完成时 gate 必须为 `null`，不能把部分样本误报为通过或失败。

## 4. 当前进度

- 直接核心缓存：`20/20`
- 待处理：`0`
- `50 ms`：precision=`0.7492`、recall=`0.5301`、F1=`0.6209`
- `100 ms`：precision=`0.8032`、recall=`0.5683`、F1=`0.6656`
- `300 ms`：precision=`0.8737`、recall=`0.6182`、F1=`0.7241`
- 完整直接核心结论：`hardangerDirectCoreV2Passed=false`，未达到 V2 的 precision≥90% / recall≥85% 闸门
- 表现压力：按停止条件不运行 80 条变体
- 运行时接入：无，仍为 eval-only

20 条 direct-core 已按低负载增量协议全部完成。该负结果是域外能力边界证据：小提琴域冻结模型在 Hardanger 共鸣弦、密集双音和舞曲节奏上明显退化；它不阻塞古典小提琴主线，也不得被解释为学生发布证据。

## 5. 判定纪律

- 直接核心未满 20 条：只报告进度，不做 V2/V3 结论（当前已完成）。
- 直接核心 V2 未通过：停止，不运行 80 条表现变体。
- 直接核心 V2 通过：可以继续域外表现压力，但仍不能称为古典小提琴或学生端发布证据。
- 双音、50 ms V3、学生域和“近乎完美”均保持 false，除非各自独立闸门通过。
