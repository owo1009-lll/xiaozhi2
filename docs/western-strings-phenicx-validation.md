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

尚未通过:

- 派生小提琴声部混音尚未生成和审计。
- Parangonar/Basic Pitch 尚未在 PHENICX 人工 gold 上评测。
- PHENICX alignment gate 尚未判定。

因此当前只允许进入适配器阶段,不得把 `readyForAlignmentBenchmark=true` 写成“人工 gold 对齐已通过”。

## 6. 可复跑命令

```bash
npm run test:western-phenicx-dataset-audit
npm run western:phenicx-dataset-audit
```

权威机器报告:

- `data/experiments/western-strings-phenicx-dataset-audit.json`
- `data/experiments/western-strings-phenicx-dataset-audit.md`

## 7. 下一环节进入条件

只有混音适配器满足以下条件才进入模型评测:

- 4/4 派生混音可解码、时长与源分轨一致。
- 混音无 NaN/Inf,峰值不削波。
- 源文件及注释保持只读不变。
- score 时间归一化是确定性的,音符行数/音高/映射不变。
- 单元测试和真实数据适配审计全部通过。
