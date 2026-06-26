# 弓弦乐器练习诊断平台 - v2 执行手册

> 状态: v2 执行版。M0 小提琴/弦乐对齐验证已经通过;M1 基本完成;M2 teacher-only preview 已接入,M2d 序列级 Basic Pitch 支持是当前第一个通过 synthetic release-gate 的候选。
> 本手册替代旧版 M0 前计划。二胡自动化攻坚线冻结为 V1.5 人在环成果和困难案例证据;西洋弦乐线以小提琴优先,大提琴后置独立验证。
> 完整 10 章开发手册见 `docs/western-strings-project-plan.md`;本文是战略纲要、闸门和当前执行清单。

---

## 0. 当前决策

### 已确认
- **二胡线不删除**:保留人工锚点、教师结构化标注、37 段段级技巧数据、自动对齐失败证据,作为 V1.5 和论文能力边界材料。
- **西洋弦乐线继续**:M0 已用本项目 pipeline 在 Bach10、URMP、MusicNet 上跑通,证明 clean-score 条件下 note-level 对齐值得继续工程化。
- **第一版只做 clean score**:输入限定为 MIDI / MusicXML / dataset-provided score。PDF OMR 不进 v2 alpha,避免重现二胡坎1。
- **先做基础诊断,后做技巧**:V2 alpha 只承诺音准、起音、时值、漏音/多音和低置信提示。技巧识别另走 M4,不作为 V2 前置。

### M0 实测结论

| 数据集 | 最强实用方法 | 结果 | 决策 |
|---|---|---:|---|
| Bach10 violin/soprano | Parangonar + Basic Pitch | median 35.2ms, hit@300ms 0.958, coverage 0.998 | Green |
| URMP violin/cello smoke | Parangonar + Basic Pitch | median 19.1ms, hit@300ms 0.938, coverage 0.986 | Green |
| MusicNet string smoke | Basic Pitch DTW | median 58.4ms, hit@300ms 0.953, coverage 1.000 | Green |
| CREPE-DTW baseline | CREPE-DTW | 三套探针均 Green | 可保留为 f0 baseline |

M0 证明的是"可进入下一阶段",不是"产品已经完成"。完整报告见 `docs/western-strings-m0-alignment-report.md`。

---

## 1. 产品边界

### V2 alpha 范围
- 乐器:小提琴优先。
- 谱面:clean MIDI / MusicXML。
- 音频:单声部小提琴练习录音优先;混音/重 rubato 先进入 review 或 reject。
- 反馈:音准、起音、时值、漏音、多音、低置信提示。
- 输出状态: `auto_pass` / `review_required` / `reject_unsupported` / `failed`。

### 明确不做
- 不做 PDF OMR。
- 不承诺技巧自动识别。
- 不把大提琴当作"改音域参数"直接上线。
- 不把低置信结果反馈给学生。

---

## 2. 指导原则

1. **validation-first**:每个阶段先有独立数据和指标,再接产品。
2. **fail-closed**:任何低置信、歧义、范围不匹配都不进入 `auto_pass`。
3. **小步可验证**:每个里程碑必须有命令、产物、通过标准。
4. **复用已有资产**:教师后台、score store、评测 harness、四态框架继续复用。
5. **不做 speculative 架构**:没有指标需要时不引入 Transformer 或大模型。

---

## 3. 数据层

| 数据集 | 当前用途 | 注意事项 |
|---|---|---|
| Bach10 | M0a smoke;后续 regression fixture | 只取 violin/soprano part,不拿 full score 对单轨 |
| URMP | M0b 分轨稳定性;后续 cello smoke | chamber music,先只用 separated track |
| MusicNet | 规模噪声测试 | 标签约有噪声,看总体分布,不逐点苛责 |
| 人工/教师数据 | 后续产品校准与技巧短窗 | 必须记录来源、许可、标注者、置信度 |

### 数据治理
- `data/experiments/` 下结果可 gitignore,但报告必须写明路径和生成脚本。
- 可发布论文表格时只引用指标、统计和公开数据集来源,不打包受限音频。
- 任何外部谱面或音频进入产品前必须记录许可证状态。

---

## 4. 里程碑总览

```
M0  对齐可行性验证              已完成,Green
M1  clean score ingestion       当前立即执行
M2  confidence-gated alignment  当前立即执行
M3  基础教学诊断                M2 稳定后执行
M4  技巧识别 pilot              后置,独立数据
M5  大提琴扩展                  小提琴 V2 通过后独立 M0
```

---

## 5. M1: Clean Score Ingestion

### 目的
把输入从二胡 PDF/OMR 迁移到 clean MIDI/MusicXML,并统一进入现有 score store / note sequence 结构。

### 交付物
1. `instrument config`
   - violin: G3-A7,产品级可按曲目收窄。
   - viola: C3-E7。
   - cello: C2-C6,仅预留,不直接上线。
2. MIDI/MusicXML importer
   - 输出 `midiPitch`, `expectedOnset`, `expectedDuration`, `measureIndex`, `voice/part`, `instrument`。
   - 不依赖 Audiveris。
3. dataset adapter
   - Bach10 / URMP / MusicNet 可复跑到统一 score/audio/gold 三件套。

### 完成标准
- 公开数据集样本可导入统一 note schema。
- 导入后可复跑 M0 指标。
- 不产生旧 OMR cache 污染。

---

## 6. M2: Confidence-Gated Alignment

### 目的
把 M0 eval 脚本工程化为可复用 alignment harness,并建立高置信 `auto_pass` 闸门。

### 候选方法
- `basic-pitch-dtw`
- `crepe-dtw`
- `parangonar-basic-pitch`
- `pyin-dtw` 作为轻量比较
- `linear-scoretime` 只作 sanity baseline,不能参与 GO

### 置信特征
允许使用:
- 多方法 onset 差异。
- Basic Pitch confidence / pitch bend 信息。
- CREPE pitch confidence / stable frame ratio。
- Parangonar matching cost / unmatched count。
- note duration、邻近音密度、double-stop/legato 标记。

禁止使用:
- gold onset error。
- measureError / 是否正确 等真值派生字段。
- 任何由评测标签反推的泄漏特征。

### V2 alpha 验收
- `auto_pass precision >= 90%` 是硬门槛。
- `coverage >= 20%` 才能命名为 V2-alpha;超过该线后 coverage 是结果指标,不是硬承诺。
- 按曲留一验证,不能随机切分造成同曲泄漏。
- 每条 `review_required` 必须给 reason code。
### 当前 M2 状态
- teacher-only alignment preview 已接入。
- M2b correlated +800ms pilot 证明 median-consensus 不安全。
- M2c 单音 Basic Pitch support 仍有重复同音误通过。
- M2d sequence-level Basic Pitch support 通过 synthetic release-gate:30ms 阈值下基准 precision=1.0000 / coverage=0.2443,+800ms correlated drift autoPass=0。
- M2e student-like event perturbation 进一步通过:漏音、错音、延迟 800ms、弱起音目标均 0 auto-pass;额外杂散音不破坏 clean reference。
- 学生端仍未开放;下一步必须用真实学生录音复验 M2d/M2e。

### reason codes
`double-stop-unsupported`, `legato-onset-ambiguous`, `rubato-section`,
`low-pitch-confidence`, `polyphonic-texture`, `score-audio-range-mismatch`,
`weak-onset`, `dataset-label-uncertain`, `method-disagreement`,
`unsupported-instrument-range`。

---

## 7. M3: 基础教学诊断

### 范围
只在 M2 `auto_pass` 或教师确认后的音符上给教学反馈:
- 音准偏差。
- 起音提前/拖后。
- 时值过短/过长。
- 漏音/多音。
- 音高不稳。

### 不做
- 技巧名称判定。
- 对低置信音符给硬反馈。
- 把 double-stop / legato 边界硬判为错误。

### 完成标准
- 学生端能看到谱面位置和错误类型。
- 教师后台能复核、纠正、回流。
- 低置信音符显示为"需复核/暂不判断"。

---

## 8. M4: 技巧识别 Pilot

### 定位
技巧识别不是 M2/V2 alpha 的必要条件。它是独立研究线,必须单独数据、单独验收。

### 优先顺序
1. vibrato
2. pizzicato
3. staccato / legato
4. spiccato
5. position shift
6. harmonic

### 数据要求
- 不复用对齐数据直接当技巧标签。
- 使用 5-10 秒短窗或音符邻域标注。
- 每类报告正例数、负例数、AUC、PR-AUC、按曲留一结果。
- 合成数据只可预训练,不能作为最终验收。

### 通过标准
- AUC >= 0.70。
- PR-AUC 明显高于正例基率。
- precision >= 90% 才允许 auto_pass;否则只做 review hint。

---

## 9. M5: 大提琴扩展

### 前置条件
- 小提琴 M2/M3 通过。
- 有 cello 数据集验证。
- cello 专属误差分析完成。

### 原则
- 不复用小提琴阈值。
- 独立 cello M0。
- 低音区 pitch tracking、慢起音、legato 边界单独报告。
- 产品表述为"架构预留大提琴",不是"已同时支持大提琴"。

---

## 10. 当前立即执行清单

### Step 1: 固化 M0 结果
- 把 M0 脚本整理成可复跑 eval harness。
- 保留 M0 报告与 artifacts 路径。
- 增加 README 或命令说明,确保能从 clean checkout 复现指标。

通过标准:
- M0a/M0b/M0c 脚本可运行或明确说明数据下载前置。
- 报告数字与 `docs/western-strings-m0-alignment-report.md` 一致。

### Step 2: 建 M1 clean score 基础
- 新增 instrument config。
- 新增或整理 clean MIDI/MusicXML importer 入口。
- 对 Bach10/URMP/MusicNet adapter 做统一输出规范。

通过标准:
- 一个小提琴样本可进入统一 note schema。
- 不触发 OMR/Audiveris 路径。

### Step 3: 建 M2 alpha 置信闸门原型
- 从 M0 per-note CSV 构造 candidate feature table。
- 训练简单可解释模型或阈值门,先不用 Transformer。
- 按曲留一评估 `auto_pass precision` 和 `coverage`。

通过标准:
- precision >= 90% 的高置信子集存在。
- 不满足则保持 review-only,不接学生端。

### Step 4: 产品接入前审查
- 确认 reason codes 到 UI 文案。
- 确认 teacher backend 能复核。
- 确认低置信不会反馈给学生。

---

## 11. 风险与降级

| 风险 | 降级策略 |
|---|---|
| M2 高精度子集覆盖率太低 | 仍可作为安全 alpha,大多数音符 review_required |
| legato/double-stop 误判 | 专门 reason code,不 auto_pass |
| 数据集结果好但真实学生录音差 | 加学生录音 pilot,不直接上线 |
| 技巧识别无可靠数据 | M4 停在 review hint,不进自动反馈 |
| 用户重新要求 PDF OMR | 单独开 OMR 支线,不得污染 clean-score 主线 |

---

## 12. 一句话路线

**小提琴优先,clean score 输入,先把 note-level 对齐和基础诊断做到 fail-closed V2 alpha;技巧和大提琴后置独立验证。**
