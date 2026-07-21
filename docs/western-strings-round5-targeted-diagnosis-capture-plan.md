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

## 冻结与验收

1. 先登记曲目、错误位置、设备和 split，再开始任何阈值或模型选择。
2. calibration 只用于训练分段 edit-path；fresh-blind 至少保留每类 6 个正例及对应混淆负例。
3. 每个子闸独立要求 precision>=90%、recall>=50%；确诊层还要求非故意位置严格误指控为 0。
4. 未通过的子闸仍可保留为教师 `self_check_hint`，不得并入 `confirmed_issue`。
5. 四类全部通过也不自动打开学生开关；仍需跨设备能量鲁棒性审计和具名发布授权。

采集前先复制模板：

- `docs/round5-targeted-diagnosis-capture-pack/manifest.template.csv` → `data/private/western-strings-round5/manifest.csv`
- `docs/round5-targeted-diagnosis-capture-pack/truth.template.json` → `data/private/western-strings-round5/position-truth.json`

随后运行 `npm run western:round5-targeted-intake`。当前无私密输入时应明确返回 `round5-manifest-missing` 与 `round5-position-truth-missing`；文件到位后它会检查分母、文件存在性、隐私路径、consent/license、曲目与演奏者-设备-房间 split 泄漏、逐事件字段以及 manifest/truth SHA-256。只有 `ready=true` 才允许训练或 fresh-blind 评测，且该状态仍不授予学生端权限。

## 机器侧下一实现

输入为连续 3–5 个谱音片段及对应音频，不再逐音独立分类。候选输出固定为 `match / insert / delete / substitute / timing-boundary-uncertain`，并把置信不足统一回退到 segment-level 自查提示。现有 round4 和注入集只用于开发诊断与回归，禁止计入新的 fresh-blind 晋升分母。
