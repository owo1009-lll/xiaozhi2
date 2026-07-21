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

随后运行 `npm run western:round5-targeted-intake`。当前无私密输入时应明确返回 `round5-manifest-missing` 与 `round5-position-truth-missing`；文件到位后它会检查分母、文件存在性、隐私路径、consent/license、曲目与演奏者-设备-房间 split 泄漏、逐事件字段以及 contract/manifest/truth SHA-256。`npm run western:project-status` 会把该结果显示在 `tracks.controlledCandidate.ordinaryDynamicShadow.round5TargetedIntake`，并在合同、清单或真值后续变化但报告未重跑时标记对应 `*-binding-stale`。只有 `ready=true` 且 `bindingCurrent=true` 才允许训练或 fresh-blind 评测，且该状态仍不授予学生端权限。

模板默认把全部 `completeErrorInventory` 保持为 `false`，位置字段为空，因此不能误过 intake。逐条人工复核后才允许签署为 `true`。intake 还会拒绝非法 measure/beat/MIDI，以及同一录音内重复使用同一个 `measure/beat/scoreMidi` 位置来凑多个分母。

## 机器侧下一实现

输入为连续 3–5 个谱音片段及对应音频，不再逐音独立分类。候选输出固定为 `match / insert / delete / substitute / timing-boundary-uncertain`，并把置信不足统一回退到 segment-level 自查提示。现有 round4 和注入集只用于开发诊断与回归，禁止计入新的 fresh-blind 晋升分母。

机器基线入口已实现为 `npm run western:round5-segment-edit-path`。它只在 intake 的全部分母、隐私、split 与哈希检查通过后训练；calibration 用固定参数的四个 gate-specific segment classifier，fresh-blind 只评测且固定决策点为 0.5，不在盲测集调参。输入特征覆盖目标音前后各两音的 assignment gap、音高替代、relative-IOI、时值比以及局部未分配事件。该固定随机森林现只保留为基线：两曲目注入→Round 4 烟测没有通过，不能预设为最终架构。真实 calibration 到位后应与显式 temporal operation-path 模型比较，模型选择仍不得查看 fresh-blind。当前私密输入未到位时应输出 `trainingPerformed=false`，不得生成模型或晋升任何权限。
