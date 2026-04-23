# Whole-Piece Pass

这份文档说明如何对当前的结构化曲库运行“整曲 pass”。

## 目标

整曲 pass 不是直接对整首音频做一次黑盒评分，而是分两步：

1. 先根据结构化段落做顺序约束扫描，找出每个段落最可能对应的时间窗。
2. 再按选中的时间窗逐段复跑分析，生成整曲级摘要、逐段表格和 Markdown 报告。

这比只看单个切片更接近“整首可评测”的工作流，也比把整首音频硬对齐到一个短片段更可靠。

## 当前命令

- 导出当前《桃花坞》结构化曲库：
  - `npm run score:export:taohuawu`
- 运行顺序约束扫描：
  - `npm run scan:taohuawu-whole`
- 运行整曲 pass：
  - `npm run evaluate:taohuawu-whole`

如果只想扫描少数几个段落，在 Windows shell 下优先使用逗号分隔的 `--section-ids`：

```powershell
npm run scan:piece-segments -- --piece-id taohuawu-test-fragment --audio data/test_audio_mix.mp3 --section-ids entry-phrase,answer-phrase
```

## 输出文件

整曲 pass 会在 `data/piece-pass/<piece-id>/` 下写出：

- `<piece-id>-whole-piece-pass.json`
- `<piece-id>-whole-piece-pass.csv`
- `<piece-id>-whole-piece-pass.md`
- `scan/<piece-id>-segment-scan.json`
- `scan/<piece-id>-segment-scan.md`

## 当前《桃花坞》状态

- 结构化曲库：`25` 个有顺序的段落
- 结构化音符总数：`180`
- 已支持导出：
  - `notes.json`
  - `MusicXML`
  - `MIDI`
  - `structure.json`

## 2026-04-20 验证结果

通过 `npm run evaluate:taohuawu-whole` 实际跑通后，当前输出显示：

- `25 / 25` 个结构化段落都进入了整曲 pass
- 加权音准：`51.71`
- 加权节奏：`63.46`
- 主导练习路径：`rhythm-first`

当前报告路径：

- [taohuawu-test-fragment-whole-piece-pass.md](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole\taohuawu-test-fragment-whole-piece-pass.md)
- [taohuawu-test-fragment-whole-piece-pass.csv](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole\taohuawu-test-fragment-whole-piece-pass.csv)
- [taohuawu-test-fragment-whole-piece-pass.json](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole\taohuawu-test-fragment-whole-piece-pass.json)

## 当前限制

- 当前仍是“主要段落覆盖版”，不是完整 `23` 页总谱全部转写完成版。
- 整曲 pass 的有效性依赖结构化段落覆盖率；未录入的段落仍然不在评分域内。
- 当前最需要继续做的是：
  - 继续录入剩余 PDF 页面的主段落
  - 用教师 review 校准整曲 pass 的弱段落和路径建议
