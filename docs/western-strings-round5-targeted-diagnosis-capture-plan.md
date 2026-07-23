# Round 5 定向诊断数据计划

目标不是再增加普通正确演奏，而是补齐目前确诊召回的四个混淆缺口。公开专业录音只可充当 clean/自然揉弦/换弓负例；没有逐音错误真值时，不计入错误正例。

## 最小证据矩阵

| 子闸 | 新真实正例 | 必备混淆负例 | 要解决的问题 |
|---|---:|---:|---|
| merged substitution | 12 | 24 个相邻半音/全音正常连奏 | 验证 round4 的第 3 条 wrong 是否可独立复现 |
| missing / assignment gap | 12 | 各 6 个错音、邻音延长、滑音、普通对齐缺口 | 区分真实漏音与“窗口里有别的声音” |
| extra / re-articulation | 12 | 各 8 个正常换弓、揉弦峰、重复同音但谱面确有两音 | 学习第二次攻击，而不是数通用 onset 峰 |
| drag / boundary | 12 | 各 8 个自然 rubato、延音记号、正常长弓 | 区分节奏错误与可接受速度变化 |

每条必须记录 `recordingId / measure / beat / scoreMidi / kind / asPerformed`，并保留未压缩母音频或无损 WAV 派生文件。建议覆盖至少 2 名演奏者、3 台手机麦、2 个房间；同一演奏者/设备/曲目组合不得同时进入 calibration 和 fresh-blind。

现有可执行采集包位于 `docs/round5-targeted-diagnosis-capture-pack/index.html`。它冻结了 12 条录音槽位：calibration/fresh-blind 各 6 条；每条恰好包含四类各 1 个正例和各 2 个互不重复混淆负例。因此总计每类 12 个正例/24 个负例，fresh-blind 每类 6/12，正好达到合同下限。槽位使用 2 名演奏者×3 台设备，并以两个房间隔离 split 上下文；`replace-*` 曲目 ID 仍必须由采集者换成两个 split 间不重叠的新曲目。

## 冻结与验收

1. 先登记曲目、错误位置、设备和 split，再开始任何阈值或模型选择。
2. calibration 只用于训练分段 edit-path；fresh-blind 至少保留每类 6 个正例及对应混淆负例。
3. 每个子闸独立要求 precision>=90%、recall>=50%；确诊层还要求非故意位置严格误指控为 0。
4. 未通过的子闸仍可保留为教师 `self_check_hint`，不得并入 `confirmed_issue`。
5. 四类全部通过也不自动打开学生开关；仍需跨设备能量鲁棒性审计和具名发布授权。

采集前可直接打开 `docs/round5-targeted-diagnosis-capture-pack/index.html` 下载两个模板，或先运行 `npm run western:round5-capture-pack` 重建后再复制：

- `docs/round5-targeted-diagnosis-capture-pack/manifest.template.csv` → `data/private/western-strings-round5/manifest.csv`
- `docs/round5-targeted-diagnosis-capture-pack/truth.template.json` → `data/private/western-strings-round5/position-truth.json`

随后运行 `npm run western:round5-targeted-intake`。缺私密输入时应明确返回 `round5-manifest-missing` 与 `round5-position-truth-missing`；文件到位后它会检查分母、文件存在性、隐私路径、consent/license、曲目与演奏者-设备-房间 split 泄漏、逐事件字段以及 contract/manifest/truth SHA-256。`npm run western:project-status` 会把结果显示在 `tracks.controlledCandidate.ordinaryDynamicShadow.round5TargetedIntake`，并在合同、清单或真值后续变化但报告未重跑时标记对应 `*-binding-stale`。2026-07-23 当前实际 intake 为 `ready=true`、`bindingCurrent=true`：12 条录音与 144 个完整事件全部通过；该状态仍不授予学生端权限。

模板默认把全部 `completeErrorInventory` 保持为 `false`，位置字段为空，因此不能误过 intake。逐条人工复核后才允许签署为 `true`。intake 还会拒绝非法 measure/beat/MIDI，以及同一录音内重复使用同一个 `measure/beat/scoreMidi` 位置来凑多个分母。

## 机器侧下一实现

输入为连续 3–5 个谱音片段及对应音频，不再逐音独立分类。候选输出固定为 `match / insert / delete / substitute / timing-boundary-uncertain`，并把置信不足统一回退到 segment-level 自查提示。现有 round4 和注入集只用于开发诊断与回归，禁止计入新的 fresh-blind 晋升分母。

机器基线入口已实现为 `npm run western:round5-segment-edit-path`。它只在 intake 的全部分母、隐私、split 与哈希检查通过后训练；calibration 用固定参数的四个 gate-specific segment classifier，fresh-blind 只评测且固定决策点为 0.5，不在盲测集调参。输入特征覆盖目标音前后各两音的 assignment gap、音高替代、relative-IOI、时值比以及局部未分配事件。

2026-07-23 首跑结果按第 3 条“每个子闸独立验收”判定：

| 子闸 | fresh-blind TP/FP/FN | Precision / Recall | 判定 |
|---|---:|---:|---|
| merged substitution | 1 / 1 / 5 | 50% / 16.67% | 失败 |
| missing | 0 / 0 / 6 | 0% / 0% | 失败 |
| extra | 3 / 0 / 3 | 100% / 50% | 数值过线，但证据有效性失败 |
| drag | 3 / 1 / 3 | 75% / 50% | 失败 |

录音后谱面位置审计发现 calibration 的 merged/missing/drag 和 fresh 的 merged/extra 标签可被纯谱面前后音程完全分开；extra 模型又包含这些静态特征。因此当前只记录 `numericallyPromotedGates=["extra"]`，有效 `promotedGates=[]`、`reviewAssistPromotionReady=false`。当前 calibration 与 fresh 都已消费且位置混杂，不能继续用于选模或晋升。

下一包必须先填完计划位置、但在录音前运行：

```powershell
npm run western:round5-position-balance -- --manifest <new-manifest.csv> --truth <new-position-truth.json> --require-ready
```

该预检不读取音频。v2 除逐 gate 正例/混淆负例外，还把 extra+drag 节奏正例与每条录音的全部其余谱音比较；检查维度包括相邻音程、书面时值及相邻时值比、拍位/拍强、重复音、归一化位置和段落边界，并同时运行留一录音单特征规则与静态随机森林。任何纯谱面模型达到预注册复核地板即非零退出，必须先让同一结构跨录音轮换为正例与正常角色再录。演奏识别模型也禁止把这些静态上下文当作独立阳性证据。只有位置预检通过、calibration performance-only 留一录音过门后，才允许生成新的 untouched fresh 包。

为排除采集目录误标，`npm run western:round5-audio-score-identity` 只用音频提取的音高事件与 12 份冻结 MusicXML 做全交叉匹配，不读取 `position-truth.json` 或 gate 结果。当前 12/12 均匹配同名谱，全局一对一分配也是原位，结论为 `current-mapping-confirmed`，cal/fresh 没有反置。
