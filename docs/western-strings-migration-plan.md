# 弓弦乐器练习诊断平台 - v2 执行手册

> 状态: v2 执行版。M0/M1/M2/M3 core 的既有闸门与最小 `/api/strings/analyze` / `/api/strings/review` 闭环已接入。离线/gated preview 已验证的核心类别只有 pitch/onset/missing,但当前三项学生运行时开关全为 false,不向学生端输出;duration/extra-note 仍为 review-only。6 套 drag/extra 注入集及逐音期望标签已就位,但尚未被正式评测消费且缺真实学生逐音真值;双音 `19/24` 是独立 double-stop recall,不是 extra-note。普通 clean-score batch 当前无条件进入 Basic Pitch + gap-penalty DTW dynamic-shadow,全量候选与审计产物仍固定 `review_required`。旧 pYIN 线性 replay、RF scorer、first-measure release/approval/pilot 只作历史 telemetry,不再具有授权力;旧 enable flag 不得再使用。它仍不是默认开启的任意上传音频实时学生诊断器。
> 本手册替代旧版 M0 前计划。当前产品范围已切换为西洋弦乐线(小提琴优先,大提琴后置独立验证);二胡相关内容仅作为论文证据、困难案例或西洋弦乐仍依赖的共享模块/数据保留。
> 完整 10 章开发手册见 `docs/western-strings-project-plan.md`;本文是战略纲要、闸门和当前执行清单。
> **当前分支刷新(2026-07-18):** `feature/model-bakeoff-omr-align` 已重新生成 P0、ordinary dynamic live preflight、项目状态与总 gate。P0 冻结 5 谱完整 `1/5`,谱号/调号/拍号=`3/5,2/5,2/5`;M3+ 音高安全 rescope 离线通过但学生运行时仍关。ordinary 当前为 `foundationReady=true`,`r3AcceptanceReady=false`,`authorizationReady=false`,`energyVetoIncluded=false`;M4 OMR 自动采纳也未达标。HOMR v3 具名审查只批准 `controlled-offline-review-only`,稳定双运行时和启动 preflight 已固化;学生端网络使用、自动采纳和再分发仍关闭。下文按日期保留的旧 RF/first-measure “当前/下一步”记录一律视为历史执行状态。
> **ordinary pilot 边界:** 旧 session 只进入 `historicalEvidence`,不能再让当前 `v2AlphaGate.ready` 变真;旧 runner 的 RF executor 默认入口已删除。新 dynamic pilot executor 未实现前,start preflight 固定失败。

---

## 0. 当前决策

### 已确认
- **二胡产品线不作为当前入口**:保留人工锚点、教师结构化标注、37 段段级技巧数据、自动对齐失败证据,仅作为论文能力边界材料或共享依赖;默认应用入口转为西洋弦乐。
- **西洋弦乐线继续**:M0 已用本项目 pipeline 在 Bach10、URMP、MusicNet 上跑通,证明 clean-score 条件下 note-level 对齐值得继续工程化。
- **第一版只做 clean score**:输入限定为 MIDI / MusicXML / dataset-provided score。PDF OMR 不进 v2 alpha,避免重现二胡坎1。
- **先做基础诊断,再做音高指控安全延伸**:V2 alpha 当前只承诺音准、起音、漏音和低置信提示。时值与 extra-note/多音暂列 review-only,需后续专门样本通过 gate 后才能开放;其中 extra-note 是缺样本,不是不可判断。原独立技巧识别/技法名称展示已删除;M3+ 只验证“何时可以安全指控音准问题”,不再以技法音频分类作为发布前置。

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
- 当前反馈:音准、起音、漏音、低置信提示。
- 暂不硬反馈:时值、extra-note/多音。extra-note 可判断但当前无验证样本;时值需先解决节奏不稳定下的量化口径。两者可以在教师后台保留为 review-only 记录,但未通过独立 gate 前不得给学生端硬反馈。
- 输出状态: `auto_pass` / `review_required` / `reject_unsupported` / `failed`。

### 明确不做
- PDF OMR **不进 v2 alpha/release**(避免坎1);但 **2026-07-09 起列为路线内里程碑 M4**,单独开支线、带 note-level 精度闸门,未过闸门/未人工核对的谱不得进判断,不污染 clean-score 主线。详见 project-plan 第 3、6 章。
- **不做技法名称展示或自动技法分类发布**:谱面标记的 tr/装饰音/泛音区直接中性化;人工 gold 揉弦/滑音区只用稳定中心音高证据。旧音频技法检测器降级为研究件,不给学生展示技法名,也不降低音准标准。双音 multi-f0 支线保留,自然泛音音准检测取消。
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
| 人工/教师数据 | 后续产品校准与 M3+ 音高模式复核 | 必须记录来源、许可、标注者、置信度 |

### 数据治理
- `data/experiments/` 下结果可 gitignore,但报告必须写明路径和生成脚本。
- 可发布论文表格时只引用指标、统计和公开数据集来源,不打包受限音频。
- 任何外部谱面或音频进入产品前必须记录许可证状态。

---

## 4. 里程碑总览

```
M0  对齐可行性验证              已完成,Green
M1  clean score ingestion       已完成
M2  confidence-gated alignment  teacher-only preview + studentSafe gate;M2f real-student gate passed
M3  基础教学诊断 core           pitch/onset/missing 已过 core gate
M3+ 音高指控安全延伸            平拉区稳定中心音高;谱面标记区零指控;人工 gold 揉弦/滑音中心音高;双音 multi-f0 独立支线
M4  PDF/图片谱面 OMR            带 note-level 精度闸门,不达标退人工
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
- M2f real-student recording gate 已定义为 release 硬闸门,并已在 2026-07-08 通过:12 条真实/准真实小提琴录音、3 个匿名学生、6 类场景各 2 条;`autoPassCount=431`,`correctWithin300ms=431`,`unsafeTargetAutoPassCount=0`,`precisionWithin300ms=1.0000`,`studentGateReady=true`。该值仅是 M2f 局部历史字段,不是当前 ordinary/project runtime 开关;当前三项学生运行时仍全关。
- 教师后台 Western strings preview 现在默认加载 `studentSafe=1`,并显示 release gate、review reason 和 sequence Basic Pitch 支持证据,用于复核而非学生反馈。
- 真实录音采集与 manifest 协议见 `docs/western-strings-real-student-pilot.md`;给录制者/教师的执行清单见 `docs/western-strings-m2f-recording-checklist.md`。
- M2f 最小门槛:不少于 6 条真实/准真实录音、3 名学生或准学生,覆盖 correct / wrong_pitch / missing_note / rhythm_shift / weak_onset / noisy 六类场景;`npm run western:m2f-templates` 可生成填表模板;真实验收用 `npm run western:m2f-gate`;precision<90% 或 unsafe target auto-pass>0 时不得开放学生端。

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
- 漏音。
- 音高不稳。
- 时值过短/过长和 extra-note/多音暂列 review-only,不进入当前 V2 core release。extra-note 是缺少本轮样本,不是不可判断;duration 是当前量化口径不足。
- 多音/extra-note 口径:教师可以判断,本轮只是没有发现多音错误样本。后续补采人工确认的多音样本并通过独立 gate 后,可单独开放该类自动反馈。

### 不做
- 技巧名称判定。
- 对低置信音符给硬反馈。
- 把 double-stop / legato 边界硬判为错误。

### 完成标准
- 学生端能看到谱面位置和错误类型。
- 教师后台能复核、纠正、回流。
- 低置信音符显示为"需复核/暂不判断"。

### 当前实现状态(2026-07-08)
- `npm run western:m3-diagnosis-skeleton` 已能生成
  `data/experiments/western-strings-m3/real-student-diagnosis-results.csv`。
- `npm run western:m3-status` / `npm run western:m3-gate` 已能按 pitch / onset / duration / missing / extra 五类诊断分别计算 precision。默认 required categories 为 pitch / onset / missing;duration / extra 为 review-only,不阻塞当前 core gate。若要强制五类全过,使用 `--required-categories all`。
- `npm run western:m3-diagnosis-review-pack` 已能生成本地复核网页 `data/experiments/western-strings-m3/diagnosis-review-pack/index.html`;页面复用 M2f 音频、谱图和 auto-pass 预览,按录音填写五类诊断计数并导出 M3 CSV。
- 第一轮人工/gold 复核已导入:12 行结果覆盖 431 个已复核 auto-pass note;core M3 gate 已通过。pitch=2/2、onset=2/2、missing=2/2,三类 precision=1.0000 且 unsafe=0,但每类只有 2 个有效错误样本,证据浓度薄;duration 与 extra-note status=`review_only`。
- 最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环已接入。`/analyze` 同时检查 M2d sequence support、M2f real-student gate 和 M3 core diagnosis gate;缺任一证据即 `studentReady=false`。Western strings 页面已接入 gated preview UI,仅展示已验证样本和 core categories;clean-score + audio 受控提交只登记离线复核队列,并已支持列表、试听、审核动作和 fail-closed batch audit,不是任意上传音频实时诊断器。

---

## 8. M3+: 音高指控安全延伸

### 定位
M3+ 不做技法名称展示,也不做技法质量评价。2026-07-17 起,它只解决一个产品问题:在证据充分时安全判断中心音高,证据不足时零指控并退复核。颤音/装饰音音频检测与粗状态分类不再是发布前置。

### 处理原则
- 无标记平拉区只在对齐、f0 质量和离散度都合格时用稳定中位数判断中心音高。
- 谱面标记的 `tr`、装饰音和泛音区一律中性化,音准指控数必须为 0。
- 人工 gold 揉弦/滑音区只判断稳定中心或目标尾段;证据不足输出 `insufficient_evidence`。
- 不向学生展示技法名,也不用降低音准标准换覆盖率。

### 优先顺序
1. 平拉区和人工 gold 揉弦/滑音区的中心音高安全闸门。
2. 谱面标记区零指控与高离散度 `insufficient_evidence` 兜底。
3. 双音 double-stop 的 multi-f0 支持。
4. 自然泛音 harmonic 固定保持 `review_required`;MusicXML 泛音标记解析仅作为谱面兼容能力保留。

### 通过标准
- 无标记平拉区 precision≥90% 且 unsafe=0。
- 谱面标记的 tr/装饰音/泛音区指控数=0。
- 人工 gold 揉弦/滑音区中心音高 precision≥90%。
- 不稳定样本 100% 输出 `insufficient_evidence`,指控数=0。
- `npm run western:m3plus-rescope-gate` 只决定离线证据是否成立;学生端仍需独立运行时接线与审计。

### 当前执行状态(2026-07-09)
- **2026-07-17 新发布权威:** `npm run western:m3plus-rescope-gate` 在冻结 holdout 上通过四区安全闸门:平拉 8/8 可判正确且 unsafe=0;14 个谱面标记单元零指控;人工 gold 揉弦/滑音中心音高只覆盖 `3/8=37.5%`,可判 3 个全部正确且 unsafe=0,另 5 个证据不足;3/3 高离散样本落 `insufficient_evidence`。`m3plusPitchSafetyReady=true` 只代表离线证据通过,`studentGateReady=false`,运行时仍未接线。17 个 round2 揉弦单元因旧报告缺稳定中心 f0 数值列为 unscored。
- 已接入 eval-only 命令 `npm run western:m3plus-pitch-modes`,用于从现有 12 条真实/准真实录音中清点稳态、滑音式连续运动、颤音式交替、装饰音候选、双音候选等 pitch-behavior 样本。
- 全量输出:2588 个谱面音符、1269 个 pitch-behavior 候选,产物在 `data/experiments/western-strings-m3plus/m3plus-pitch-mode-inventory.csv` 和 `m3plus-pitch-mode-summary.json`。
- 已接入 `npm run western:m3plus-review-pack`,生成 `data/experiments/western-strings-m3plus/pitch-mode-review-pack/index.html`、待填 CSV/JSON/guide、48 个本地短 WAV 和对应五线谱图片(`score-images/`,按 piece/page/measure/note 定位)。当前抽样为 6 类各 8 条:`slide-like`、`trill-like`、`double-stop-candidate`、`ornament-candidate`、`stable`、`variable-f0`。复核页已改为正常中文说明,并加入单条/批量快捷按钮;批量按钮只填未标项,不得替代听辨。
- 已接入 `npm run western:m3plus-review-import` 与 `npm run western:m3plus-review-status`:标完网页下载 `m3plus-pitch-mode-review.completed.csv` 后导入,状态命令会报告每类 reviewed/scored 缺口。第一轮、第二轮与 first-measure candidate-quality 复核已累计导入,实测 `m3plusModeEvalReady=true`:98 reviewed / 74 scored,每类 reviewed/scored 缺口均为 0。
- `npm run western:m3plus-mode-eval` 的历史 first-measure 复核集曾返回 `releaseReadyModes=["slide-like","trill-like"]`；该结果只保留为历史离线证据，不再是当前 release 结论。
- 2026-07-17 的 CREPE tiny/full + pYIN 独立跨后端 holdout 已覆盖旧技法检测器结论：按技法语义计算后，揉弦 holdout precision/recall=`0.60/0.75`、颤音=`null/0.00`、装饰音=`null/0.00` 且样本门未过、滑音=`1.00/0.75`。该结果解释了检测器为何退出发布链,但不再覆盖上面的新音高安全口径;所有旧检测器保持 research-only。
- 2026-07-15 第二轮复验新增 `npm run western:round2-m3plus-eval`,以 Basic Pitch 序列 DTW 对齐谱面音符和真实录音。`r2-06` 的 6 个颤音与其余 17 个长音揉弦已由项目负责人确认实际执行;机器实测滑音 7/12、颤音 0/6、揉弦 1/17、双音 19/24,全部低于 90%。旧报告中的 16 个揉弦分母来自对齐器漏音;现按谱面全集计数,未匹配音不再从分母消失。窗口诊断进一步显示 12/23 音符窗口不合理,受控时值锚定后的最佳单特征训练内 precision/recall 也只有 66.7%/66.7%,因此没有可接生产的阈值改进。这证明 first-measure 的窄范围结果不能外推,而不是证明演奏者没有执行。该旧 detector 路线当时缺负例和独立装饰音样本;后续补录只保留为 detector 负证据,不再是 2026-07-17 音高安全 rescope 的发布前置。自然泛音音准检测已取消;符号层保留 MusicXML 泛音 pitch-role 仅作通用兼容。
- 为关闭上述数据缺口,`音频/m3plus-supplemental/` 四条任务已统一改为“不读谱、固定音符顺序 + 文字要求”:C 大调上行纯直音、独立揉弦/颤音、装饰音/普通音对照、滑音/直音对照。生成的 MusicXML 已真实写入 `vibrato` 文字、`trill-mark`、`mordent`、`glissando` 以及 straight/plain 对照;M3+ 采用“谱面声明预期技法,音频核验是否按谱执行”,不再对所有音符盲猜技法。4/4 录音已经到位并完成可复现实验；冻结定位仍有失败单元，独立 holdout 也未过 release gate。定位允许 `±100 cents` 仅用于找窗,不放宽音准结论；不得因实验已完成就交教师或开放学生端。
- 项目级状态统一入口:`npm run western:project-status` 会汇总 ordinary dynamic-shadow live runtime/r3 acceptance/authorization、历史 RF supersession、M3+ 与 M4,输出 `data/experiments/western-strings-project-status.json`。该命令覆盖本地状态 JSON,不重跑上游 benchmark;任何子 gate 未 ready 时 runtime 均保持 fail-closed。`npm run western:project-gate` 当前按设计非零退出:ordinary 缺 live artifact verifier、r3 接受性和独立授权且因果能量否决未冻结,M4 automatic adoption 未过;M3+ rescope 离线通过但学生运行时仍关闭。`npm run test:western-project-gate` 必须防止旧 RF/first-measure authority 复活、M4 自比样本冒充独立 gold,以及 eval-only 证据直接进入学生 runtime。

---

## 9. M4: PDF/图片谱面 OMR

### 定位
OMR 只解决"谱面从哪来",不改变音频诊断逻辑。未过 note-level 精度闸门、或未人工核对的识谱结果,不得进入判断层。

### 执行原则
- PDF/图片 → OMR → MusicXML 草稿 → gold MusicXML 对齐评测。
- 只在 note pitch / onset / 小节定位 / 漏识别率达标时写入可信 score store。
- 未达标谱只作为草稿给人工核谱,不进入 `/api/strings/analyze` 的自动判断。

### 通过标准
- OMR note-level 准确率达到 project-plan 中 M4 闸门。
- 100% 可追溯 `scoreSource=omr`、`omrReviewStatus`、识别版本与人工核对状态。
- 判断层拒绝未达标或未核对 OMR 谱。

### 当前执行状态(2026-07-15)
- 已接入只读 readiness 命令 `npm run western:m4-omr-readiness`。该命令检查 M2f clean-score intake 中每条图片/PDF 谱面源、gold clean MusicXML/MXL/MIDI、人工 `approved` 状态和 score-store `scoreId` 是否齐备。
- 当前实测:12 条 intake 全部 ready,`pairReadyRows=12`,`blockedRows=0`,`m4OmrBenchmarkDatasetReady=true`;产物为 `data/experiments/western-strings-m4/omr-readiness.json` 和 `omr-readiness.csv`。
- 该结果只是 OMR benchmark 的数据前置条件,不是 OMR 准确率通过。学生端仍固定 `studentGateReady=false`,OMR 识别结果在 note-level 精度闸门通过前不得进入 `/api/strings/analyze` 判断层。
- 已接入 `npm run western:m4-omr-benchmark`,对 Audiveris 草稿和 gold clean score 做只读序列评测。当前 12 条均可评测,其中 8 条是带 M2 `approved` + `cleanScoreReviewedBy` 证据的 `human-approved-unchanged-draft`,4 条是 `independent-edited-gold`;`usableBenchmarkRows=12`,`humanApprovedUnchangedRows=8`,`selfComparisonRows=0`,`manualGoldRequiredRows=0`。混合口径下 pitch P/R=`84.9%/100%`,因 precision 未达门槛而 `m4OmrDraftQualityReady=false`。M4 仍是 eval-only benchmark,不会打开学生端运行时 OMR 自动诊断;论文/表格必须按 provenance 分层报告。
- 已接入 `npm run western:m4-independent-benchmark-audit`:独立 clean/scan/photo render-gold 分别为 N=32/6/6,平均 P/R 均达到研究下限,所以限定的独立 OMR 准确率报告可用;但严格逐谱 P≥98% 且 R≥95% 仅 12/32。另用公开 Kayser Op.20 LilyPond 源谱建立并校验 5 份真实照片独立 gold,总体 pitch P/R=`84.7%/71.5%`,严格通过 `0/5`,因此 `automaticAdoptionReady=false`,`studentGateReady=false`。既有 12 份未改 Audiveris 草稿仍只作复识一致性,不得混入独立准确率。
- 已接入 `npm run western:m4-omr-confidence-probe`:仅用运行时可见的识别规模、页数与 Audiveris 日志特征,按 BWV 作品留一。当前 LR/RF AUC=0.567/0.800,RF 最佳观察点 precision=0.80、coverage=0.156,无法达到 0.90/0.20,所以不能用置信模型绕过逐谱门槛。真实照片 gold 的来源缺口已经关闭,但准确率本身未过门槛;5×3 预处理 sweep 也确认 `up2` 最佳、`up3`/Otsu 退化,当前不再要求人工制谱或重复复核。
- 已接入 `npm run western:m4-oemer-benchmark`:Oemer 0.1.8 在同一 5 份真实照片 source-gold 上原为 4/5 输出；对明确的播放器黑边/3-track builder 失败增加固定裁边重试后达到 5/5 输出。全 5 份 P/R=`71.9%/76.2%`、onset/measure=`5.4%/18.2%`,严格通过 `0/5`;同 5 份 Audiveris P/R=`85.5%/72.1%`。Oemer 只能在个别页提高 recall,整体 precision 与节奏结构更差,因此不替换 Audiveris、不接 runtime。
- 已接入 `npm run western:m4-homr-benchmark`:2026-07-15 首跑的四舍五入历史值为 pitch P/R=`89.0%/96.2%`,onset-quarter/measure=`30.7%/79.0%`;2026-07-17 以 ONNX Runtime 1.27.0 从零复验后的当前权威值为 `88.33%/95.78%/30.03%/79.04%`。2 份 pitch-only 假通过仍存在,完整严格门槛为 `0/5`;HOMR 只获 `controlled-offline-review-only` 候选池批准。
- 多引擎候选继续保持 eval-only:统一 tolerance sweep 无一同时通过逐页 precision≥98% 与 coverage≥20%。随后在 5 张 Kayser 页上发现的“相邻重复 MIDI 转 review”规则虽得到 99.71%/43.71%，但冻结后在第一首独立 Bach 合成照片只得到 90.72%/33.08%，已由 `npm run western:m4-repeated-pitch-confirmation` 判为跨域失败并停止；剩余独立样本未用于追阈值，学生端保持关闭。
- 已接入 `npm run western:m4-clarity-benchmark`:Clarity-OMR 原样截图 Stage A 无谱表输出;通用自动裁页后 5/5 输出,但 pitch P/R=`72.8%/35.5%`,onset-quarter/measure accuracy=`2.8%/10.1%`,完整通过 `0/5`。它只保留为第三方视觉 Transformer 基线,不接 runtime。
- Clarity 监督适配已完成非人工闭环:32/32 个 Bach movement 生成 296 个去重 staff/token 对,按作品得到 train/validation/synthetic-test=`199/39/58` 条,无真实照片盲测泄漏;64-step bf16+DoRA 的 held-out 指标确有提高,峰值 reserved 显存约 `1.21 GiB`。但冻结 5 张真实照片上候选仅得到 pitch P/R=`80.00%/31.44%`,onset-quarter/measure accuracy=`2.04%/6.26%`,严格 `0/5`;除 precision 外均低于官方 Clarity 基线。候选按完整四指标规则判定 `reject-and-delete`,不接生产、不再通过追加训练步数追数;Clarity 继续只作 eval-only 负基线。
- DoReMi v1 公开配对谱的有界适配也已完成:按作品隔离 `96/48/48` 个谱表对,held-out 数字谱 token accuracy 提高约 9-10 个百分点;但冻结真照片上 pitch P/R=`75.94%/36.10%`,onset/measure=`5.18%/6.65%`,严格 `0/5`,measure 比官方 Clarity 的 `10.10%` 更差,候选再次 `reject-and-delete`。因此不再单独堆干净公开谱;后续数据必须同时包含拍照域退化和节奏/小节结构监督。P0-P3 识别与安全闸门见 `docs/western-strings-m4-omr-recognition-spec.md`。
- 2026-07-17 当前分支重新生成 P0 结构闸门:冻结 5 谱完整 `1/5`,谱号/调号/拍号=`3/5,2/5,2/5`,`studentGateReady=false`。这里的 `1/5` 只表示结构 P0;同 5 张真实照片的 pitch+onset+measure 完整自动采纳仍为 `0/5`,12 份历史照片链缓存重放中的 P0-ready 为 `0/12`,三者不可互换。状态字段 `m4P0StructureReady=true` 只表示至少一谱通过 P0,不代表 `m4OmrAutomaticAdoptionReady=true`。
- HOMR v3 已接入照片谱生产候选池并继续走既有 P0、曲级和邻音 fail-closed 纪律;12 份缓存重放中机器可用由纯 Audiveris 的 3 份提升为 9 份,其中 HOMR 赢 8 份,但该结果不改变严格自动采纳闸门。v3 池不含 Oemer;Oemer 仅保留为 eval 和坐标 sidecar 先例。HOMR 当前仍是无 bbox 列表,后排须补坐标适配器与独立人工坐标 gold,在 `coordinateGoldReady=false` 时不得升级为像素框选反馈。北京同版干净页图只贡献 1 份严格阳性,Op.45 仍是候选;其四项人工复核仅是可选的第 2 份同版 gold 扩证,不是维持当前“不自动采纳”裁决的 `humanTask`。即使提升,因候选起点来自 HOMR,也不得计入 HOMR 自身的独立自动采纳页数。
- 浏览器现可在 clean MusicXML/MIDI 与单页谱面照片之间二选一。照片入口只接受经过文件签名验证的 JPG/PNG/WebP,独立缓存照片与录音,在受控队列中显示预览,人工批准后才进入最多 5 条一批的离线照片谱分析。一般批处理与专用 CLI 都调用同一受管 Python 环境;结果固定为 `photo_score_review_ready`,`autoDiagnosisIssued=false`,`studentFacing=false`,并写入独立审计日志。
- 照片域最低成本扩证路径已明确:`r2-camera-photo-benchmark` 现有 8 张是 clean render,真实 8 张屏拍须保持 `screen-photo-of-pdf` 独立分域;负责人把 r2 八页打印后逐页手机拍摄约 15 分钟,即可沿用构造 gold,输入域分类通过后让纸拍 source-gold 从 5 行增至 13 行。Op.45 复核 JSON 可同时把同版 gold 从 1 页增至 2 页,但因其候选由 HOMR 起草,不得计入 HOMR 独立自动采纳页数。
- 当前单页照片入口不接受 PDF。多页 PDF 仍只属于 M4 benchmark/草稿流程;在实现逐页转换、页序和定位审计前,不得把 PDF 伪装成单页照片输入。

---

## 10. M5: 大提琴扩展

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

## 10. 当前状态与执行清单

### Step 1: 固化 M0 结果(已完成)
- 把 M0 脚本整理成可复跑 eval harness。
- 保留 M0 报告与 artifacts 路径。
- 增加 README 或命令说明,确保能从 clean checkout 复现指标。

通过标准:
- M0a/M0b/M0c 脚本可运行或明确说明数据下载前置。
- 报告数字与 `docs/western-strings-m0-alignment-report.md` 一致。

### Step 2: M1 clean score 基础(已完成)
- 新增 instrument config。
- 新增或整理 clean MIDI/MusicXML importer 入口。
- 对 Bach10/URMP/MusicNet adapter 做统一输出规范。

通过标准:
- 一个小提琴样本可进入统一 note schema。
- 不触发 OMR/Audiveris 路径。
- 收口回归已通过: `test:western-string-config` / `test:western-musicxml-import` / `test:western-midi-import` / `test:western-dataset-index` / `test:western-strings-entry` / `test:server-boundaries` / `test:server-p0` / `test:musicxml-import` / `test:analyzer-score-roles` / `test:teacher-validation` / `build`。

### Step 3: M2 alpha 置信闸门原型(teacher-only + M2f release gate 已完成)
- 从 M0 per-note CSV 构造 candidate feature table。
- 训练简单可解释模型或阈值门,先不用 Transformer。
- 按曲留一评估 `auto_pass precision` 和 `coverage`。

通过标准:
- 公开数据集/gold 条件下 precision >= 90% 的高置信子集已存在,但这不等于真实学生录音 student-safe。
- M2f 真实录音 gate 已通过;学生端 release 的下一前置是 M3 基础诊断 precision 闸门和最小 API 闭环审查。

### Step 4: 产品接入前审查(进入 M3 后执行;gated preview UI 已接入)
- 确认 reason codes 到 UI 文案。
- 确认 teacher backend 能复核。
- 确认低置信不会反馈给学生。
- M2f 与 M3 core 已通过,服务端 `/api/strings/analyze` 和 `/api/strings/review` 已接入 fail-closed 闭环。Western strings 的离线/gated preview 只展示既有 pitch/onset/missing 安全范围;当前不向学生运行时输出,低置信、duration、extra-note 均暂不判断或交复核。受控 clean-score + audio 队列的 ordinary batch 当前无条件运行 Basic Pitch + gap-penalty DTW dynamic-shadow;历史 `dataset/piece/recordingId` 不能绕回 legacy replay,旧 RF 只写 `authorizationIgnored` telemetry。独立 Python venv 禁止 system/user site,config/依赖锁/Basic Pitch tree hash 由代码常量锚定并写入 runtime attestation;新环境用 `npm run western:ordinary-dynamic-shadow-runtime-setup` 建立。服务端强制全谱 `limit=0`,逐音验证唯一连续 `noteIndex=0..N-1` 及 `noteId/sectionId/measureIndex/midi`,并绑定音频 SHA-256、cache realpath/identity、模型/策略、当前 score payload、候选 artifact SHA 与全部行。正常输出也固定 `autoDiagnosisIssued=false`,`studentFacing=false`,`review_required`;因果能量否决尚为 `excluded-review-only`。`npm run western:controlled-batch-candidate-audit` 默认要求 latest run 存在 ordinary feature-review item并重读 score store;空审计、provenance 漂移和旧授权均须 fail-closed。
- `npm run western:controlled-candidate-input-status` 曾打通 M2f 普通上传候选复核前置。2026-07-08 历史快照中的 12 条 M2f、run `strings-batch-mrb9twcr-ls0kkl`、2588 行候选和后续人工校准只解释旧 RF 路线,不再是当前最新批次或授权证据。2026-07-18 用历史 `r3-01` 做了现行 schema-3 冷/热基础设施重跑:`strings-batch-mrpytpgd-kxkws5` miss、`strings-batch-mrpyuerg-wa5yec` hit;两次均全谱 59/59、54 行 shadow telemetry selected、0 auto-pass、runtime attestation 通过,候选行哈希一致。逐音 identity 加固后又热跑 `strings-batch-mrpzqs9h-f8fien`,59/59 行的 score/candidate identity digest 同为 `ce816a0e0bed67d72498996d8b1e59eb84f7562e08830df717dbb4a294d423ea`;公开 `western:controlled-batch-candidate-audit` 默认要求 ordinary item并重读 score store,物理最新全 artifact 复核为 0 failure。该重跑不计入 `r3-02/r3-03` 接受性,也不构成 fresh-blind/发布证据;历史 run 用脚本 `--all-runs` 模式追溯时出现旧 schema 失败属于预期。
- **历史人工复核口径(已完成,不得重新派发同一包):** `usable` 表示候选可作为该谱面音符的正确证据;`wrong` 表示候选明显错位/音高不对应/不可作为该音符证据;`uncertain` 表示听不清或无法确认。新版复核页用“候选 1 / 30”作本页序号,并在卡片中写明“系统说:录音 X 秒附近可能对应第 Y 小节/MIDI Z”;原始行号只是内部编号,不用判断。导出脚本会把涉及的音频复制到复核页旁边的 `audio/` 文件夹,页面提供 `播放/暂停` 与 `跳到候选秒` 中文按钮,不必依赖浏览器原生音频小图标或后台音频接口;也提供 `一键未标=可用`、`一键未标=错误`、`一键未标=不确定` 和 `清空本页标注`。批量按钮只填未标项,不会覆盖已单独修改的候选。只有 `usable` 和 `wrong` 计入可评分样本,`uncertain` 不计入校准 precision。该口径只用于复现历史校准;现有复核、导入和 confidence validation 已完成,当前不再要求先做 30 条或重跑同一 gate-candidates 包。
- 2026-07-08 更新:第二轮 `--gate-candidates` 复核 CSV 已导入。最新 30 条为 16 usable / 14 wrong;累计 labels 为 60 条,46 usable / 14 wrong。`western:controlled-candidate-review-status` 仍未通过,原因=`candidate-review-no-rule-meets-precision`;最新 30 条单独评估最高 precision 约 0.533,`npm run western:controlled-candidate-label-audit -- --labels <completed.csv> --min-selected 10` 也未找到 0.90 precision 规则。新增 `western:controlled-candidate-label-audit` 为只读诊断命令,用于检查是否存在稳定可用的候选子集;该命令不得替代 release gate。当前结论是普通上传候选仍保持 review-only。新版复核页已改为每条生成约 6 秒短音频和对应谱面图,并提供“打开短音频文件”兜底。
- 下一批复核导出默认排除已标候选:`western:controlled-candidate-review-export` 会读取累计 labels CSV 并跳过已有 `usable/wrong/uncertain` 的候选;需要复现旧页面时加 `--include-reviewed`。当前 `--gate-candidates` 重导出后,226 条可校准候选中已标 60 条被排除,剩余 196 条,页面抽取新的 30 条且与 labels 重叠为 0。
- **以下 2026-07-09/10 RF 记录均为历史,无当前授权力:** RF pilot 用累计 60 条标签按录音留一曾得到 threshold=0.7、precision=0.9375、coverage=0.5333;随后 30 行预筛 fresh validation 为 usable=27 / wrong=3、precision=0.90。旧 `release-review`、负责人 approval、`readyForControlledPilot=true` 与 enable flag 现已全部 superseded;不得据此开启任何 pilot。当前只认 dynamic-shadow r3 acceptance 与新版本 authorization contract。
- 2026-07-09 更新:完整阈值池分层复核包已生成。`npm run western:controlled-candidate-confidence-stratified-export` 在 2528 个候选上重算冻结 RF 概率,阈值以上 2291 个(coverage=0.90625),并抽样 60 行 high / above-threshold / near-threshold / low(15 / 21 / 15 / 9)。`npm run western:controlled-candidate-confidence-stratified-review-pack` 生成 `data/experiments/western-strings-m3/confidence-threshold-pool-review/index.html`。当时下一步是人工复核这 60 行(该轮已完成且后续 evidence 已进入 release-review / controlled-pilot-decision;当前不再要求继续复核这批 60 行),保存 `controlled-candidate-review.completed.csv`,再运行 `npm run western:controlled-candidate-confidence-stratified-eval`;通过前普通上传自动 gate 继续默认关闭。
- 2026-07-09 历史负结果(已被 P1.1 取代):旧 threshold-pool 60 行复核为 usable=23 / wrong=36 / uncertain=1,旧 confidence-only 规则 selected precision=0.5556;简单调阈值最高也只有 0.8571。该结果证明旧 RF 不可用,继续保留为负证据,但不再代表当前 release candidate。
- 2026-07-09/10 历史 P1.1:context-feature 重校准曾得到 pilot precision=0.942857、validation precision=1、runtime-selected threshold-pool precision=1(12/53)。冻结 RF artifact 仅供复现,`ordinary-monitored-pilot-audit` 当前必须报告 `superseded-historical-rf-only`;旧负责人批准不能复用。
- 2026-07-18 当前 ordinary 基础层:isolated live runtime、代码锚定 config/lock/model identity、全谱行数+逐音 identity 约束、版本化 dynamic policy 和音频/cache/model/score/candidate 全链 SHA-256 审计已就位。r3 live artifact verifier 当前故意未实现并硬阻断;首个待办是先完成真实 artifact 重读/重算,再消费 `r3-02/r3-03`。通过后仍须独立发布证据和新授权,默认学生端不变。
- 2026-07-09 M3+ first-measure candidate-quality 历史证据:累计 98 reviewed / 74 scored;旧 `western:m3plus-mode-eval` 曾返回 `releaseReadyModes=["slide-like","trill-like"]` 与 stable control ready。该结果仅保留为旧 detector 的 first-measure 研究证据;2026-07-17 rescope 已取消其发布 authority,不得再据此设计 slide/trill monitored pilot。

---

## 11. 风险与降级

| 风险 | 降级策略 |
|---|---|
| M2 高精度子集覆盖率太低 | 仍可作为安全 alpha,大多数音符 review_required |
| legato/double-stop 误判 | 专门 reason code,不 auto_pass |
| 数据集结果好但真实学生录音差 | 加学生录音 pilot,不直接上线 |
| M3+ 某音高模式无可靠证据 | 该模式保持 review-only,不为减少复核而降低音准标准 |
| OMR 被绕过闸门直接接入判断层 | M4 必须保留独立精度闸门;未过闸门或未人工核谱的识别结果不得进入判断 |

---

## 12. 一句话路线

**小提琴优先,clean score 输入,先把 note-level 对齐和基础诊断做到 fail-closed V2 alpha;再做 M3+ 音高指控安全延伸和 M4 OMR,大提琴最后独立验证。**

## 13. 2026-07-10 旧 RF 受控 pilot 决策包（superseded）

- 旧 release review、负责人 approval、decision、start preflight 与五批一次性离线 pilot 均保留为历史审计事实。历史统计为 275 候选 / 33 个模型原始 auto-pass / 11 个 first-measure eligible,0 known wrong/unknown;它们不满足当前 dynamic-shadow authorization contract。
- `r2-08` 的 3 个模型原始 auto-pass 虽已被旧 scope/self-check 全部抑制,仍应做一份逐条只读尸检,记录具体抑制规则。该可观测性补档不产生任何当前授权,也不得排在 dynamic-shadow live verifier 之前。
- 当前状态必须为旧 `readyForControlledPilotDecision=false`,`readyToStartControlledPilot=false`,`approvalPresent=false`,`authorizationSuperseded=true`;历史批准存在不等于当前批准。
- 新 `western:release-review` 必须生成 `schemaVersion=2` 和 `western-ordinary-dynamic-shadow-release-v1`;r3 接受性与独立 `authorizationReady=true` 缺任一项时,approval/decision/start 均须 fail-closed。
- 当前先实现并测试 live artifact verifier,确认会重读/重算物理来源且拒绝自洽伪造报告;在此之前不得消费 `r3-02/r3-03`。核验器通过后才用两条 reserve take 完成实现接受性。若后续建立发布证据,必须另取全新录音+新曲目,不能复用旧 12 条、`r2-08` 或 r3 接受性材料;然后重走 release review → 新 scope approval → decision → start preflight。
- 默认学生 runtime 全程保持关闭;旧 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE` 不得再使用。

# 2026-07-09 历史闸门状态补充(已被 2026-07-18 状态覆盖)

- P1 confidence 重校准旧 10-row blind validation 曾失败,但后续 P1.1 context-feature validation 已补强并通过当时精度闸。普通上传自动 gate 仍默认 fail-closed;该阶段提出的 monitored pilot 后来已完成五批并进入 `r2-08`,不再是当前待办。
- M3+ first-measure candidate-quality 复核已完成并导入:98 reviewed / 74 scored。旧 per-mode eval 的 `slide-like` / `trill-like` 结果只保留为 first-measure detector 研究证据;2026-07-17 rescope 已取消技法 detector 的发布 authority,不得再据此设计 slide/trill 学生端 pilot。
- 本补充仅用于解释历史流转;当前状态以文件顶部 2026-07-18 分支刷新和项目总 gate 为准。

# 2026-07-10 公开专业录音执行补充

- 当前无法继续获得大量真实学生录音,允许使用 65 个公开 Bach 小提琴乐章推进开发、跨演奏者评测和原始波形压力测试。证据口径见 `docs/western-strings-public-bach-validation.md`。
- 对齐和独立音符识别已经形成 `publicProfessionalV2AlphaReady=true`;这不改变默认学生端 fail-closed。
- 原始波形 rawv2 严格闸门已在 development 与 unseen-performer holdout 上验证漏音、错音、迟到均 0 危险放行,记为 `publicRawAudioCorePrototypeReady=true`。
- 弱音 shallow-model bake-off 未通过 holdout,固定为 `review_required`;extra-note 继续 review-only。
- 公开专业录音不能证明学生错误声学分布。没有学生域证据时可以继续研究版和公开专业录音版,但不得命名为学生端 V3 release 或“完美识别”。

# 2026-07-10 PHENICX 人工起止金标补充

- PHENICX 数据前置审计已通过:`readyForAlignmentBenchmark=true`,4/4 作品、22 violin tracks、2,969 个逐乐器人工 gold 音符。
- 许可为本地非商业研究且禁止重新分发;音频/注释/混音均不得入 Git。
- 下一步严格限定为适配器:每部作品混合全部同步 violin 分轨、保留 score/gold 行映射、内存单调化异常 score 时间。
- 只有 4/4 混音和映射审计通过后才允许运行 Parangonar/Basic Pitch 人工 gold 对齐评测。详见 `docs/western-strings-phenicx-validation.md`。
- 适配器和 PHENICX 人工 gold 工程闸门现已通过。冻结组合 `parangonar-with-basic-fallback` 的 holdout coverage=1.000、median=32.9ms、p90=352.6ms、`hit@300ms=0.8834`,两首逐曲过闸。
- 复音子组未过,且当前是顺序工程验证而非未触碰 holdout。下一步仅允许在新外部数据冻结确认和评测识别;学生域与“完美”结论仍不成立。

# 2026-07-10 MUSC/弱标签执行结果

- MUSC 默认后处理在快速音上漏检;development-only 校准后,冻结配置在未参与校准的 Oliver 单声部核心上达到 precision@100ms=0.9142、recall@100ms=0.9396,V2 识别候选通过。
- 50ms precision=0.8025,V3 严格目标未过;Silei 和高双音乐章只作压力测试,自动多音反馈继续关闭。
- Violin Etudes 原始包受限;开放 Violin MIDI Dataset 仅提供约 34 小时 score-aligned 弱标签 MIDI,可用于后续训练扩展,不能作独立音频识别金标。
- 统一总审计已接入 `western:project-status` 和独立命令 `western:public-model-gate`。当前只把专业单声部识别标为 V2 candidate;`studentReleaseEligible=false`,`V3=false`,`doubleStopAutoFeedbackReady=false`,`nearPerfect=false`。
- 下一研究闸门是新外部人工 gold 冻结确认、双音路径和 50ms 精度提升;任何一项缺失都不得升级为学生发布或“完美识别”。
