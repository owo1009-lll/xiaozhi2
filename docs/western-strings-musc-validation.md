# MUSC 小提琴转写验证

更新时间:2026-07-10

## 1. 目标与边界

使用 MTG 的 Multi-Stream Conformer(MUSC)验证真实独奏小提琴音符识别。MUSC 直接从 44.1kHz 波形输出音符、起止时间和 pitch bend,不依赖谱面参与匹配。

本阶段使用公开专业 Bach 录音和估计 CQT-DTW 参考音符。它能验证专业独奏域的转写能力,不能替代人工 onset gold,也不能证明学生错误录音发布安全。

## 2. 模型来源

- 代码:`https://github.com/MTG/violin-transcription`
- 固定 commit:`17e198cad1f355c566a26a6d58ee0559fd198ffa`
- 代码许可:AGPL-3.0。
- 官方 violin 权重:218,770,231 bytes。
- 权重 SHA-256:`a913356f059be6dc930be41158ac864f7d5511889ef0b2a6b6ba75a4a8732750`。
- 参数量:54,580,722。
- 当前仅在 gitignored `data/external/` 做 eval-only 集成;AGPL 与部署影响未完成审查前不得接生产。

本机 Torch 2.11 的文件解码需要 TorchCodec。适配器使用项目已有 `librosa/soundfile` 读波形后传 NumPy,不修改外部模型代码。

## 3. 默认模型诊断

固定 unseen-performer 六曲 pilot 中,MUSC 默认 `minimumNoteLengthMs=127.7` 在快速乐章严重漏音:

- 单声部核心 3,880 个参考音符,只输出 2,162 个事件。
- F1@50ms=0.5915,F1@100ms=0.6693。
- BWV1002 中速 Double 单曲 F1@50ms=0.9009,说明模型本体有有效信号。
- Presto/Gigue 低 recall 指向默认最短音长不适配快速音符。

因此默认解码不得接入产品。

## 4. Development 校准

仅使用 Emil Telmányi development-reference-performer,每个 BWV 作品一首,共 5,795 个参考音符。固定网格 48 组:

- onset threshold:`0.2/0.3/0.4/0.5`。
- frame threshold:`0.2/0.3/0.4`。
- minimum note length:`30/60/90/127.7ms`。

V2 口径在 100ms 判 precision>=0.90 且 recall>=0.85。50ms 同时达到 precision>=0.90、recall>=0.80 才算 V3。

development 结果:

- 17/48 组达到 V2;0/48 达到 V3。
- 冻结配置:`onset=0.5`,`frame=0.4`,`minimumNoteLengthMs=60`。
- V2 development:precision@100ms=0.9392,recall@100ms=0.9646,F1=0.9517。
- V3 strict:precision@50ms=0.8555,recall@50ms=0.8787,F1=0.8669,未过。

选择完成后不再使用 development 或已看过的六曲 diagnostic pilot 调参。

## 5. Fresh 外部确认

冻结前未参与校准的演奏者:

- Oliver Colbentson:BWV1006 全 6 乐章;其中 Preludio/Gigue 为单声部核心,其余为双音压力。
- Silei Li:BWV1003 两乐章,双音比例 24.5%/47.8%,只作压力测试。

单声部核心 2,301 个参考音符:

| 模型 | Precision@50 | Recall@50 | F1@50 | Precision@100 | Recall@100 | F1@100 |
|---|---:|---:|---:|---:|---:|---:|
| MUSC frozen | 0.8025 | 0.8249 | 0.8135 | 0.9142 | 0.9396 | 0.9267 |
| Basic Pitch | 0.7039 | 0.6467 | 0.6741 | 0.8472 | 0.7784 | 0.8113 |

判定:

- `muscV2CoreGatePassed=true`。
- `freshConfirmationPassed=true`。
- `muscV3CoreGatePassed=false`。
- `doubleStopAutoFeedbackEligible=false`。
- `studentReleaseEligible=false`。

双音压力 5,058 个参考音符中,MUSC F1@100ms=0.6281;该路径必须 review-only。

## 6. 可复跑命令

```bash
python -m pip install gdown Unidecode
npm run test:western-bach-violin-musc-pilot
npm run test:western-bach-violin-musc-calibration
npm run western:bach-violin-musc-calibrate
npm run western:bach-violin-musc-fresh-confirmation
```

权威报告位于:

- `data/experiments/western-strings-bach-violin-musc-pilot/report.json`
- `data/experiments/western-strings-bach-violin-musc-calibration/report.json`
- `data/experiments/western-strings-bach-violin-musc-fresh-confirmation/report.json`

模型代码、权重、音频、缓存和报告均在 gitignored `data/`,不入 Git。

## 7. HF2 域外复音/表现压力

HF2 Hardanger Fiddle 数据已通过文件、许可证和人工标注来源审计。冻结 MUSC 模型仅按一次一条的低负载协议推进；当前直接核心缓存为 1/20，尚不能形成 V2/V3 结论。只有直接核心 20/20 完成且 V2 闸门通过，才允许继续 80 条表现变体。

完整边界、命令和资源纪律见 [western-strings-hf2-hardanger-validation.md](western-strings-hf2-hardanger-validation.md)。HF2 是域外复音/装饰压力集，不得写成古典小提琴、学生端或运行时发布证据。
