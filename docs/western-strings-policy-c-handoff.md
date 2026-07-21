# 交接:Policy C(能量验漏音)正式化 + 真闸

> 面向协作者。目标是把一个已在 round4 上实测有效的召回优化,**按项目既有纪律**做成可验证的候选,而不是停在草稿数字。**不改任何学生运行时开关**。

## 一句话任务
把 **Policy C**(`issue_detected` 或 近乎无声 `voicedFrameRatio < 0.2`)实现进 fresh-blind 评测链,作为一个**显式、可打分的候选判定策略**,在 round4(及后续新录音)上产出**召回 / 冤枉率**证据,并接进 `western:project-status` 的 preGateOnly 证据层。**保持 fail-closed,不授权学生端。**

## 背景:为什么要做这个
round4 实测,把"今天就开自动打分学生会看到什么"跑成硬数字(253 个拉对的音 + 12 个故意错):

| 策略 | 定义 | 抓到的错 | **冤枉拉对的音** |
|---|---|---|---|
| A 保守 | 仅 `issue_detected` | 2/12 | **0/253** |
| B 激进 | `decision != confirmed_center` | 6/12 | **28/253** |
| **C(本任务)** | `issue_detected` **或** `voicedFrameRatio < 0.2` | **6/12** | **3/253** |

结论:`insufficient_evidence` 一个筐混装了"真漏音(无声)/噪声大的错音/干净但难测"。**用能量(voicedFrameRatio)能把真漏音和干净音分开** → 拿到 B 的召回,冤枉从 28 降到 3。分项:错音 3/3、漏音 3/3、多拉/拖拍 0/3。

## Policy C 判定(精确定义)
对每个候选行(逐音),student-facing flag =
```
decision == "issue_detected"  OR  voicedFrameRatio < 0.2
```
- `decision` = `m3plusPitchSafetyEvidence.decision`
- `voicedFrameRatio` = 候选行顶层字段
- 阈值 0.2 是初值,应在实现里做成常量并在验收时扫一遍稳健性(0.1–0.35)。

## 要做什么
1. 在 `scripts/eval-western-ordinary-fresh-blind.mjs`(或其姊妹评测)里,把 Policy A/B/C 作为**命名策略**逐音打分,输出每个策略的:planted-error 召回(按 kind 分)、clean-note 冤枉数/率。位置真值已有:`data/private/western-strings-round4/error-positions.json`(私有,含 12 个故意错的 measure/beat/kind)。定位锚定用 `measureIndex == measure && beatStart == beat-1`(已验证成立)。
2. 把结果写成 digest 绑定的报告(沿用现有 `evidenceDigestSha256` + live-artifact re-audit 纪律,让手改/陈旧报告 fail-closed)。
3. 接进 `scripts/status-western-strings-project.mjs` 的 **preGateOnly 证据层**(与 round4 fresh-blind 同级),**不接任何 studentGate**。

## 关键护栏(必须遵守)
- **不翻开关**:`WESTERN_STUDENT_RUNTIME_GATE`(`src/server/westernStudentGateService.js:13`)三项保持 `false`。本任务是证据,不是授权。
- **能量信号当年是被"故意排除"的**(`energyVetoIncluded:false` / `causalEnergyStatus:excluded-review-only`)。Policy C 等于把它请回来 → **必须验证鲁棒性**:round4 那 3 个冤枉全是"干净音也读成 vfr=0"(滑音断点 r4-04 m2b2、真漏音旁边对齐糊掉 r4-06 m10b1)。**在手机麦 / 不同房间的真实录音上验证 vfr 稳不稳,是它进生产的前提**,别拿几首干净棚录音就当结论。
- **节奏错(多拉/拖拍)Policy C 碰不到**(0/3),别把它宣传成通用错误检出;它只解决"错音+漏音"。
- **小样本**:12 个错、253 个 clean 来自 2+4 首。3/253 方向对但不是验收级,需更多新录音复算。
- **fresh-blind 纪律**:任何用于"发布盲审"的录音必须是全新演奏者/新曲目、逐音人工 gold,且一旦用于验收即视为已消费,不得复用。

## 验收标准(建议)
- Policy A/B/C 三策略在 round4 上的召回/冤枉数**可复现**、digest 绑定、live re-audit 通过。
- 阈值扫描(0.1–0.35)报告出来,给出选点理由。
- **明确写清 scope = preGateOnly**,报告自身 `authorizationReady:false`;不改任何 studentGate/运行时开关。
- (可选,若要往生产推)追加一批**手机麦/多房间**真实录音上的 vfr 稳健性证据。

## 不要做
- 不要翻学生运行时开关、不要动 release-review 授权位。
- 不要把 Policy C 说成"解决了自动打分"——它是**召回阶梯的第 1 级**;节奏通道 + 输出语义两层化(确诊=判错 / 低置信=自查提示)还没做。
- 不要用能量信号覆盖现有 review-only 逻辑的默认行为;只在新评测里并列打分。

## 相关文件
- 评测器:`scripts/eval-western-ordinary-fresh-blind.mjs`(已支持 `--position-truth`)
- 位置真值:`data/private/western-strings-round4/error-positions.json`
- round4 机器分析:`data/experiments/western-strings-round4/machine-analysis.json`
- 现有 fresh-blind 报告:`data/experiments/western-strings-round4/ordinary-fresh-blind/report.json`
- 开关定义:`src/server/westernStudentGateService.js:13`
- 状态机:`scripts/status-western-strings-project.mjs`
