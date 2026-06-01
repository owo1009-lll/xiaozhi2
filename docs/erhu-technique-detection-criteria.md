# 二胡技巧判定规则草案

状态：资料支撑的工程草案，用于分析器和 audit 阈值设计；不是最终教学标准。

更新时间：2026-06-01

## 目标

分析器不能把所有音高变化都当成错音。二胡演奏里会自然出现滑音、揉弦、颤音/打音等表现性音高变化。本规则的目标是区分三类情况：

- 稳定错音：应该明确反馈给学生；
- 表现性技巧：应该容忍或进入复核；
- 噪声造成的短促音高跳动：不应该吞掉真实错音。

## 资料结论

公开资料不能替代教师标注数据，但可以给出音乐上合理的边界：

- 二胡教学资料通常把滑音分成小滑音和大滑音；小滑音常围绕小三度或三度以内，大三度以上或超过三度可视为大滑音。
- 另有教学资料把三度以内的下滑音称为小下滑音，超过三度称为大下滑音。
- 二胡音源说明书把虚拟滑音控制范围写到上下大三度，这支持把“三度”作为普通滑音的重要边界。
- 一般滑音定义会按方向分成上滑、下滑、回转滑，也可按音程大小分类。
- 颤音/打音常描述为本音与上方二度或三度的快速交替。
- 揉弦是围绕某个基准音做周期性波动，和普通跑音不同。

## 程序判定总表

| 技巧 | 教学含义 | 分析器信号 | 建议初始规则 |
|---|---|---|---|
| 稳定音 | 音应该稳定落在目标音附近 | `pitchSpreadCents` 低、稳定帧足够、置信度高 | 稳定音即使短暂出现 `glideLike` 或 `vibratoLike`，也不能轻易吞掉明确错音 |
| 小滑音 | 三度以内或小三度附近的连续滑动 | 音高连续移动、有一定 spread、持续时间足够 | 连续滑动且总跨度约 `80-400 cents` 时，按普通滑音处理 |
| 大滑音 | 超过三度的滑动 | 较大连续音高移动 | 总跨度 `>400 cents` 时，单独作为大滑音或表现性段落处理 |
| 上滑音 | 从低音滑向高音 | 净方向向上 | 要求持续正斜率和入口/出口音高变化 |
| 下滑音 | 从高音滑向低音 | 净方向向下 | 要求持续负斜率和入口/出口音高变化 |
| 回滑音 | 离开本音后回到本音 | 音高曲线先离开再返回 | 要求偏离幅度足够，且最后回到目标附近 |
| 揉弦 | 围绕基准音周期性波动 | 中心线上下反复摆动、幅度受限 | 需要周期性证据，不能只靠一次尖峰判断 |
| 颤音/打音 | 本音和上方二度或三度快速交替 | 两个音高簇反复切换 | 两簇间隔约 `100-400 cents`，且切换次数足够 |
| 噪声假技巧 | 稳定音里短促跳动 | 短高斜率、整体 spread 很低、方向不稳定 | 不应判为滑音/揉弦，不应吞掉 pitch issue |

## 初始数值边界

这些数值只作为 audit 调参起点，不是教师最终标准。

| 概念 | 建议边界 | 理由 |
|---|---:|---|
| 三度边界，严格口径 | `300 cents` | 小三度。适合严格理解“小三度滑音” |
| 三度边界，宽口径 | `400 cents` | 大三度。适合普通工程边界 |
| 小滑音范围 | `80-400 cents` | 低于 `80 cents` 可能只是音准漂移或揉弦；高于 `400 cents` 更像大滑音 |
| 大滑音起点 | `>400 cents` | 超过大三度，不应简单并入普通音准容忍 |
| 稳定音 spread 保护 | `<25 cents` | 这么稳定的音不应被短假滑音或假揉弦吞掉 |
| 揉弦可能范围 | `25-50 cents` | 与当前分析器的 vibrato spread 邻近，但需要教师数据校准 |
| 颤音/打音两簇间距 | `100-400 cents` | 对应二度到三度附近的快速交替 |
| audit 明确错音注入 | `50 cents` | 半个半音，稳定音中应被可靠检出 |

## 当前代码映射

项目现有分析器已经有多数需要的信号：

| 字段或配置 | 当前作用 | 规则含义 |
|---|---|---|
| `pitchSpreadCents` | 一个观测音内的总音高波动 | 应作为表现性 uncertain 的关键闸门 |
| `glideLike` | 滑音样行为 | 不能单独决定吞掉 pitch issue，需要结合 spread |
| `glideRunMs` | 高斜率滑动持续时间 | 可判断“有移动”，但不能单独判断真滑音 |
| `entryCents`, `exitCents` | 音头、音尾偏离 | 可判断上滑、下滑、回滑 |
| `vibratoLike` | 揉弦样行为 | 应同时要求 spread 和周期性 |
| `vibratoAmplitudeCents` | 揉弦幅度估计 | 可区分真实揉弦和噪声 |
| `trillLike`, `trillSwitchCount` | 双音高簇快速切换 | 适合颤音/打音判定 |
| `stablePointCount` | 稳定帧数量 | 稳定帧足够时，应保护真实 pitch finding |
| `estimatedConfidence` | 音高跟踪置信度 | 低置信可复核，高置信不应被弱技巧标记吞掉 |

## 推荐分析器策略

### 1. 稳定错音优先于弱技巧标记

如果一个音置信度高、稳定帧足够、spread 很低，那么短暂的 `glideLike` 或 `vibratoLike` 不应直接把它变成 uncertain。

建议保护条件：

```text
low_spread_stable_note =
  pitchSpreadCents < 25
  and stablePointCount >= stable_note_min_frames
  and estimatedConfidence >= pitch_confidence_threshold
```

这类音如果偏差达到 `50 cents` 左右，应保留 pitch finding。

### 2. 滑音要同时看“移动”和“范围”

不要只看导数或短游程。滑音至少应同时满足：

- 滑动持续时间足够；
- 总 spread 足够；
- 入口/出口或方向支持滑动。

建议普通滑音候选：

```text
glide_candidate =
  glideRunMs >= glide_min_duration_ms
  and pitchSpreadCents >= 25
  and entryCents / exitCents 支持移动方向
```

大滑音可单独标记：

```text
large_glide = pitchSpreadCents > 400
```

### 3. 揉弦要看周期性，不能只看 spread

揉弦 review 至少应有：

- 中心线上下的重复过零；
- 合理幅度；
- 不是两个固定音高簇的颤音/打音。

低 spread 稳定音不应因为一次局部波动被吞成揉弦复核。

### 4. 颤音/打音要看两个音高中心

颤音/打音不是普通揉弦，应表现为两个音高中心之间快速切换：

```text
trill_candidate =
  cluster_gap_cents between 100 and 400
  and switch_count >= trill_min_switch_count
  and 两个簇各自足够紧
```

### 5. audit 必须保持通道纯净

audit 中：

- pitch 注入只允许 pitch finding 算命中；
- rhythm 注入只允许 rhythm finding 算命中；
- review-only 单独报告，不当作硬命中。

## 对当前 n6 问题的含义

当前 n6 是一个稳定错音：

```text
centsError ~= -55
estimatedConfidence ~= 0.91
stablePointCount = 20
pitchSpreadCents ~= 12
```

按本规则，n6 不应该被滑音或揉弦吞掉。`12 cents` spread 的稳定音中出现短促 `glideLike` 或 `vibratoLike`，更像音高跟踪噪声，而不是真技巧。

## 资料链接

- 小滑音/大滑音、小三度说法：https://www.52erhu.com/laxianyueqi/erhujiaocheng/1413/
- 三度以内/超过三度下滑音说法：https://www.52erhu.com/laxianyueqi/erhujiaocheng/erhuzhifa/681/
- 滑音方向和音程分类：https://zh.wikipedia.org/wiki/%E6%BB%91%E9%9F%B3
- 二胡演奏风格含 glissando、trill、vibrato：https://support.apple.com/guide/garageband-iphone/play-the-erhu-chsc3cf9a9aa/ios
- 二胡虚拟滑音范围至上下大三度：https://www.amplesound.net/cn/Main_Panel_Manual-ACEH-CN.pdf
- 颤指/颤音为本音与上方二度或三度快速交替：https://m.yueqixuexi.com/erhu/20130528100416.html
- 揉弦为围绕音位的周期性变化：https://www.fx361.com/page/2018/0125/15674266.shtml

## 仍需验证

- `12-25 cents` 的轻微表现性滑动是否应 review，还是应作为稳定音处理。
- `25-80 cents` 的真实轻滑音样本是否存在，教师如何标注。
- 不同学生水平下的真实揉弦幅度分布。
- 二度、三度颤音/打音的真实 pitch cluster 分布。
- 学生端是否要把低 spread 的 expressive uncertainty 显示为“复核”，还是用更柔和语言报告为音准偏差。
