# Violin MIDI 弱标签数据审计

更新时间:2026-07-10

## 1. 来源

- DOI:`https://doi.org/10.5281/zenodo.13736820`
- 名称:Violin MIDI Dataset。
- 许可:CC BY-SA 4.0。
- 官方压缩包:51,912,255 bytes。
- MD5:`d2483df547e7acae40d9ced1b8924363`,本地校验一致。
- 内容:Kayser Op.20、Paganini Op.1、Wohlfahrt Op.45,22 位演奏者的 score-aligned MIDI 和 pitch bend。

## 2. 审计结果

- 1,021 个实际 MIDI 文件;`__MACOSX` 中的资源分叉副本不计。
- 3 套练习曲、138 个曲目编号、22 位演奏者。
- 677,557 个音符、24,138,347 个 pitch-bend 事件。
- 文件名链接片段合计 34.408 小时;MIDI 合计 33.846 小时。
- 1,006/1,021(98.53%)可作为弱标签源。
- 15 个文件的 MIDI 时长比文件名链接范围短超过 15%,已隔离,不改 MIDI、不改链接时间。
- 所有文件均可解析;未发现非法音符、非法 pitch bend 或结构错误。

## 3. 能做与不能做

可以:

- 扩展 score-aligned 小提琴弱标签训练数据。
- 分析 pitch bend、揉弦和音高偏移的标签分布。
- 为后续合法取得对应音频后的预训练/再训练提供 MIDI 目标。

不能:

- 数据包不含音频,不能直接评测当前音频识别器。
- MIDI 是模型生成的弱标签,不是人工逐帧 F0 gold。
- 文件名链接到 YouTube;未完成权利与平台条款审查前,不得批量下载或重新分发对应音频。
- 因此 `readyAsIndependentRecognitionBenchmark=false`。

## 4. 可复跑命令

```bash
npm run test:western-violin-midi-dataset-audit
npm run western:violin-midi-dataset-audit
```

报告:

- `data/experiments/western-strings-violin-midi-dataset-audit.json`
- `data/experiments/western-strings-violin-midi-dataset-audit.md`

公开压缩包、解压 MIDI 和机器报告均留在 gitignored `data/`。
