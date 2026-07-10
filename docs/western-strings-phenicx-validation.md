# PHENICX 人工音符起止金标验证

更新时间: 2026-07-10

## 1. 目的

PHENICX-Anechoic 用于补上 Bach Violin Dataset 的主要证据缺口:Bach 参考时间是算法估计,PHENICX 的小提琴音符起止由研究者逐乐器人工校准。

本数据只用于本地非商业研究、对齐评测和模型比较,不进入产品数据包,不提交 Git,不重新分发。

## 2. 来源与许可

- DOI:`https://doi.org/10.5281/zenodo.1289821`
- 官方说明:`https://www.upf.edu/web/mtg/phenicx-anechoic`
- Zenodo 版本:1.0。
- 压缩包:736,199,301 字节。
- 官方/本地 MD5:`9ba83a1beef6cb44ec7c7b96853263a9`。
- 注释:CC BY-NC-SA,仅限非商业用途,不得重新分发或修改。
- 音频:知识产权和分发政策仍归 Aalto University 及相关权利人。

因此仓库只提交适配器、审计器、测试和汇总指标;音频、注释、缓存和派生混音全部留在 gitignored `data/`。

## 3. 数据结构审计结果

`npm run western:phenicx-dataset-audit` 当前结果:

- `readyForAlignmentBenchmark=true`
- 4/4 作品 ready: Mozart、Beethoven、Mahler、Bruckner。
- 22 条同步小提琴分轨。
- 2,969 个人工对齐 gold 音符。
- 2,563 个唯一起音。
- 最大声部复音数:4。
- 小提琴 MIDI 范围:55-96。

| 作品 | 分轨 | gold 音符 | 唯一起音 | 最大复音 | 时长 |
|---|---:|---:|---:|---:|---:|
| Mozart | 2 | 974 | 829 | 2 | 227.091s |
| Beethoven | 4 | 537 | 414 | 4 | 191.054s |
| Mahler | 4 | 784 | 776 | 2 | 132.075s |
| Bruckner | 12 | 674 | 544 | 3 | 87.028s |

每部作品的 `violin_o.txt` 与人工对齐 `violin.txt` 音符数相等,音高序列按文件行顺序逐项完全一致。因此可以用行号建立 score note 与 gold note 的无歧义映射。

## 4. 已确认的源数据边界

- `violin.txt`:人工对齐的 `Onset,Offset,Note name`,时间严格单调且有效。
- `violin_o.txt`:未对齐 score 时间,音高/行顺序有效,但存在零时值装饰音。
- Beethoven 另有 1 个 score onset 按行顺序回退 150ms 的零时值装饰音。
- 适配器不得对源行排序,否则会破坏 score/gold 一一对应。
- 适配器必须保留行顺序,仅在内存中生成单调 score 时间副本供模型使用,并报告修正数量。
- `violin.txt` 是整个小提琴声部的复音 gold;不能把单条 `violin1.wav` 直接对整声部 gold。
- 正确音频输入是每部作品全部同步 `violin*.wav` 的本地等权混合,并在混合后防削波归一化。

## 5. 当前闸门

已通过:

- 许可证据存在。
- 官方压缩包字节数和 MD5 一致。
- 音频/注释文件齐全。
- 所有分轨格式、长度一致。
- gold 末端不超过音频时长。
- score/gold 音高序列一一对应。

适配器已通过:

- `adapterReady=true`。
- 4/4 小提琴声部混音可解码、有限值、0 削波,输出峰值约 0.95。
- 2,969 行 score/gold 映射和音高顺序保持不变。
- 54 个零时值/回退 score 音符只在派生时间线上修复;源注释未修改。
- development 固定为 Mozart/Beethoven,holdout 固定为 Mahler/Bruckner。
- 连续两次生成的 4 个混音 SHA-256 和 4 个 notes SHA-256 全部一致。

人工 gold 对齐工程闸门已通过:

- 固定候选:`linear-duration`、`basic-pitch-dtw`、`parangonar-basic-pitch`、`parangonar-with-basic-fallback`。
- development 选择 `parangonar-with-basic-fallback`:Parangonar 有结果时保持不变,只对缺失预测使用 Basic Pitch-DTW 补位,不调误差阈值。
- holdout(Mahler/Bruckner)覆盖率 1.000、中位误差 32.9ms、p90 352.6ms、`hit@300ms=0.8834`。
- Mahler 与 Bruckner 逐曲均通过预设四项闸门;重复运行 `report.json` SHA-256 一致。
- 复音子组未通过同一强闸门:holdout `hit@300ms=0.836`,p90 536.3ms。因此复音结果仍是 review-only,不得写成完美识别。

协议边界:

- 第一轮只含前三种方法时,development 选择 Parangonar,但 holdout `hit@300ms=0.8114`、coverage 0.8992,未通过。
- missing-only fallback 由 development 的缺失预测问题提出并在 development 上选中,但提出前已查看第一轮 holdout。当前结果属于顺序工程验证,不是一次性未触碰 holdout。
- 必须在新的外部数据上冻结确认后,才能把该组合写成泛化完成;公开专业声部数据也不能替代学生域发布证据。

因此当前可以进入下一公开数据环节,但 `studentReleaseEligible=false`,不得写成“学生录音自动诊断完成”或“完美对齐”。

## 6. 可复跑命令

```bash
npm run test:western-phenicx-dataset-audit
npm run western:phenicx-dataset-audit
npm run test:western-phenicx-alignment-adapter
npm run western:phenicx-prepare-alignment
npm run test:western-phenicx-alignment-eval
npm run western:phenicx-eval-alignment
```

权威机器报告:

- `data/experiments/western-strings-phenicx-dataset-audit.json`
- `data/experiments/western-strings-phenicx-dataset-audit.md`
- `data/experiments/western-strings-phenicx-adapter/manifest.json`
- `data/experiments/western-strings-phenicx-adapter/manifest.md`
- `data/experiments/western-strings-phenicx-alignment/report.json`
- `data/experiments/western-strings-phenicx-alignment/report.md`
- `data/experiments/western-strings-phenicx-alignment/per-note.csv`

## 7. 下一环节进入条件

混音适配器和 PHENICX 工程闸门已经满足以下条件:

- development 只能选择规则/阈值,holdout 不调参。
- holdout median onset error <150ms。
- holdout p90 onset error <500ms。
- holdout hit@300ms >=85%。
- holdout coverage >=80%。
- 复音音符和每部作品必须单独报告,不得用总体均值掩盖失败作品。

下一环节只允许使用冻结的 `parangonar-with-basic-fallback` 规则做外部确认和识别评测。不得再利用 PHENICX holdout 调规则;不得因总体通过而放开复音自动反馈。
