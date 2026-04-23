# Whole-Piece Pass v2

这份文档记录当前《桃花坞》整曲 pass 的最新状态。

## 当前能力

当前整曲 pass 采用两步编排：

1. 先用 `scan-piece-segments.py` 对全部结构化段落做顺序约束扫描。
2. 再用 `run-piece-pass.py` 按选中的时间窗逐段复跑分析，生成整曲摘要、CSV 和 Markdown 报告。

## 当前命令

- 导出当前《桃花坞》结构化曲库：
  - `npm run score:export:taohuawu`
- 跑整曲扫描：
  - `npm run scan:taohuawu-whole`
- 跑整曲 pass：
  - `npm run evaluate:taohuawu-whole`

如果只想定向扫描少量段落，在 Windows shell 下优先用逗号分隔的 `--section-ids`：

```powershell
npm run scan:piece-segments -- --piece-id taohuawu-test-fragment --audio data/test_audio_mix.mp3 --section-ids vivace-accent-grid,pedal-leap-sequence
```

## 当前《桃花坞》结构化覆盖

- 结构化段落数：`33`
- 结构化音符数：`257`
- 当前覆盖时间大约推进到：`338s - 346s`
- 当前仍然是“主要段落覆盖版”，不是完整 `23` 页总谱版

## 2026-04-20 最新整曲结果

最新整曲 pass 输出目录：

- [taohuawu-whole-v2](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v2:1)

核心结果：

- `33 / 33` 个结构化段落全部进入整曲 pass
- 加权音准：`51.98`
- 加权节奏：`59.51`
- 加权综合分：`59.11`
- 主导练习路径：`rhythm-first`

对应文件：

- [taohuawu-test-fragment-whole-piece-pass.md](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v2\taohuawu-test-fragment-whole-piece-pass.md:1)
- [taohuawu-test-fragment-whole-piece-pass.csv](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v2\taohuawu-test-fragment-whole-piece-pass.csv:1)
- [taohuawu-test-fragment-whole-piece-pass.json](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v2\taohuawu-test-fragment-whole-piece-pass.json:1)

## 当前 weakest sections

- `rustic-turn`
- `sharp-mode-climax`
- `lyrical-return-b`
- `tremolo-surge`
- `recap-call`

## 下一步

- 继续录入 `PDF 19-23` 页主段落
- 用教师 review 校准 weakest sections 的段落定位和路径建议
- 再把整曲 pass 的摘要接进研究导出链
