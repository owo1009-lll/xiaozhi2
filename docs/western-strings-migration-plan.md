# 弓弦乐器练习诊断平台 - v2 执行手册

> 状态: v2 执行版。M0 小提琴/弦乐对齐验证已经通过;M1 已完成并通过收口回归;M2 teacher-only preview 已接入,M2e 学生式事件扰动已通过 synthetic gate;M2f 真实学生录音 release gate 已于 2026-07-08 通过;M3 core diagnosis gate 已通过;最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环、gated preview UI、clean-score + audio 受控提交流、离线复核队列、fail-closed 批处理审计执行器已接入。当前只放行 pitch / onset / missing 三类核心诊断;duration 因节奏不稳定暂不可稳定量化,extra-note/多音可判断但本轮复核未出现样本,两者均暂列 review-only。当前 UI 可展示已验证样本的核心诊断预览,也可接收 clean-score + audio 进入离线复核队列,支持试听、审核为批处理候选、生成批处理审计记录。batch 对带有已验证 `dataset/piece/recordingId` 的提交可做离线 gated replay 摘要;普通上传音频也可进入 review-only pYIN 线性谱面特征执行器并产生完整离线候选特征表 artifact、前 5 条 preview 与复核摘要,且已接入 `western-offline-feature-gate-v0-review-only`、fail-closed 候选表二次审计命令和离线校准评估命令,但仍不自动诊断。它仍不是任意上传音频实时诊断器。
> 本手册替代旧版 M0 前计划。当前产品范围已切换为西洋弦乐线(小提琴优先,大提琴后置独立验证);二胡相关内容仅作为论文证据、困难案例或西洋弦乐仍依赖的共享模块/数据保留。
> 完整 10 章开发手册见 `docs/western-strings-project-plan.md`;本文是战略纲要、闸门和当前执行清单。

---

## 0. 当前决策

### 已确认
- **二胡产品线不作为当前入口**:保留人工锚点、教师结构化标注、37 段段级技巧数据、自动对齐失败证据,仅作为论文能力边界材料或共享依赖;默认应用入口转为西洋弦乐。
- **西洋弦乐线继续**:M0 已用本项目 pipeline 在 Bach10、URMP、MusicNet 上跑通,证明 clean-score 条件下 note-level 对齐值得继续工程化。
- **第一版只做 clean score**:输入限定为 MIDI / MusicXML / dataset-provided score。PDF OMR 不进 v2 alpha,避免重现二胡坎1。
- **先做基础诊断,再做少退复核延伸**:V2 alpha 当前只承诺音准、起音、漏音和低置信提示。时值与 extra-note/多音暂列 review-only,需后续专门样本通过 gate 后才能开放;其中 extra-note 是缺样本,不是不可判断。原独立技巧识别/技法名称展示已删除,只保留 M3+ 的技法感知音准模式,目标是少退复核而不是展示技巧标签。

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
- **不做技法名称展示**:原技法识别 M4 已删,技法仅作为 M3+ 少退复核延伸里的**音准评判模式开关**(揉弦/滑音/颤音/装饰音换判法、双音 multi-f0、泛音谱面标注),不给学生展示技法名、不降音准标准。
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
M3+ 少退复核延伸                技法感知音准(揉弦/滑音/颤音/装饰音 + 双音 multi-f0 + 泛音谱面);不降音准标准
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
- M2f real-student recording gate 已定义为 release 硬闸门,并已在 2026-07-08 通过:12 条真实/准真实小提琴录音、3 个匿名学生、6 类场景各 2 条;`autoPassCount=431`,`correctWithin300ms=431`,`unsafeTargetAutoPassCount=0`,`precisionWithin300ms=1.0000`,`studentGateReady=true`。
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
- 第一轮人工/gold 复核已导入:12 行结果覆盖 431 个已复核 auto-pass note;core M3 gate 已通过。pitch=2/2、onset=2/2、missing=2/2,三类 precision=1.0000 且 unsafe=0;duration 与 extra-note status=`review_only`。
- 最小 `/api/strings/analyze` / `/api/strings/review` 服务端闭环已接入。`/analyze` 同时检查 M2d sequence support、M2f real-student gate 和 M3 core diagnosis gate;缺任一证据即 `studentReady=false`。Western strings 页面已接入 gated preview UI,仅展示已验证样本和 core categories;clean-score + audio 受控提交只登记离线复核队列,并已支持列表、试听、审核动作和 fail-closed batch audit,不是任意上传音频实时诊断器。

---

## 8. M3+: 少退复核延伸

### 定位
M3+ 不做技法名称展示,也不做技法质量评价。它只解决一个产品问题:在揉弦、滑音、颤音、装饰音、双音、泛音等区域,尽量把**音准**判准,减少不必要的 `review_required`。

### 处理原则
- 技法只是音准评判模式开关,不向学生展示"这是滑音/揉弦/颤音"。
- 音准 precision≥90% 的硬门槛不变。
- 模式拿不准、谱面缺标记、multi-f0 不可靠时,一律保持 `review_required`。
- 不用降低音准标准换覆盖率。

### 优先顺序
1. 稳态/揉弦/滑音/颤音/装饰音的单声部 f0 行为模式。
2. 双音 double-stop 的 multi-f0 支持。
3. 泛音 harmonic 的谱面 sounding pitch 与标记支持。

### 通过标准
- 每个模式单独报告 note-level 音准 precision。
- precision≥90% 且 unsafe=0 才允许减少复核。
- 未达标模式永久 review-only,不得向学生硬判。

### 当前执行状态(2026-07-09)
- 已接入 eval-only 命令 `npm run western:m3plus-pitch-modes`,用于从现有 12 条真实/准真实录音中清点稳态、滑音式连续运动、颤音式交替、装饰音候选、双音候选等 pitch-behavior 样本。
- 全量输出:2588 个谱面音符、1269 个 pitch-behavior 候选,产物在 `data/experiments/western-strings-m3plus/m3plus-pitch-mode-inventory.csv` 和 `m3plus-pitch-mode-summary.json`。
- 已接入 `npm run western:m3plus-review-pack`,生成 `data/experiments/western-strings-m3plus/pitch-mode-review-pack/index.html`、待填 CSV/JSON/guide 和 48 个本地短 WAV。当前抽样为 6 类各 8 条:`slide-like`、`trill-like`、`double-stop-candidate`、`ornament-candidate`、`stable`、`variable-f0`。
- 已接入 `npm run western:m3plus-review-import` 与 `npm run western:m3plus-review-status`:标完网页下载 `m3plus-pitch-mode-review.completed.csv` 后导入,状态命令会报告每类 reviewed/scored 缺口。未导入标签时状态必须 fail-closed,不能进入模式 precision 评估。
- 当前 gate 仍为 `studentGateReady=false`,原因=`inventory-only-no-human-mode-labels` / `human-label-collection-only`。这些候选只用于抽样复核和 M3+ 标注规划,不证明 precision,不改变学生端反馈。
- 项目级状态统一入口:`npm run western:project-status` 会同时汇总普通上传候选 gate 与 M3+ 复核标签状态,输出 `data/experiments/western-strings-project-status.json`。该命令只读,用于判断下一批优先级;任何子 gate 未 ready 时 runtime 仍保持 fail-closed。

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

### 当前执行状态(2026-07-09)
- 已接入只读 readiness 命令 `npm run western:m4-omr-readiness`。该命令检查 M2f clean-score intake 中每条图片/PDF 谱面源、gold clean MusicXML/MXL/MIDI、人工 `approved` 状态和 score-store `scoreId` 是否齐备。
- 当前实测:12 条 intake 全部 ready,`pairReadyRows=12`,`blockedRows=0`,`m4OmrBenchmarkDatasetReady=true`;产物为 `data/experiments/western-strings-m4/omr-readiness.json` 和 `omr-readiness.csv`。
- 该结果只是 OMR benchmark 的数据前置条件,不是 OMR 准确率通过。学生端仍固定 `studentGateReady=false`,OMR 识别结果在 note-level 精度闸门通过前不得进入 `/api/strings/analyze` 判断层。

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
- M2f 与 M3 core 已通过,服务端 `/api/strings/analyze` 和 `/api/strings/review` 已接入 fail-closed 闭环。Western strings 页面已接入最小 gated preview:只展示 pitch / onset / missing,低置信、duration、extra-note 均显示为暂不判断或交复核。受控真实 clean-score + audio 提交流、离线复核队列和 fail-closed batch audit 已接入;batch audit 只写审计记录且 `autoDiagnosisIssued=false`。带已验证 `dataset/piece/recordingId` 的提交可回放现有 gated pipeline 生成离线摘要;普通上传也可运行 review-only pYIN 线性谱面特征执行器生成完整离线候选特征表 artifact、前 5 条 preview 与复核摘要。`western-offline-feature-gate-v0-review-only` 当前强制所有普通上传候选保持 review_required,原因=`ordinary-upload-student-safe-gate-not-calibrated`;`npm run western:controlled-batch-candidate-audit` 已接入二次审计,确保这些候选 artifact 存在且行数匹配、无 auto-pass、非 student-facing、未绕过 student-safe gate。`npm run western:controlled-candidate-review-export` 默认从最新 batch 轮转抽样 30 条,生成本地中文复核网页、CSV、JSON 和 `review-guide.md`;需要全量时加 `-- --all`。`npm run western:controlled-candidate-review-import -- --reviews <completed.csv>` 把人工复核结果合并到累计 labels CSV;`npm run western:controlled-candidate-gate-eval` 默认读取累计 labels CSV 并生成校准报告;`npm run western:controlled-candidate-review-status` 输出当前 reviewed/scored 缺口、bestRule、下一步和 `reviewArtifacts` 路径;`uncertain` 只计入复核记录,不计入可评分样本数。未完成任意上传音频的校准 gate 前不得声称支持实时诊断。
- `npm run western:controlled-candidate-input-status` 已补为普通上传候选复核的前置预检且当前通过。12 条 M2f clean-score/audio 样本的音频、已批准 MXL 文件、score-store `scoreId`、controlled submissions、accepted reviews 和最新 batch candidate rows 均已就绪。最新 batch run `strings-batch-mrb9twcr-ls0kkl` 生成 12 个 `offline_feature_review_ready` 项、2588 行 review-only 候选 artifact;`western:controlled-batch-candidate-audit` 默认只审最新 run 并通过,历史 run 可用 `--all-runs` 追溯。`western:controlled-candidate-review-export` 已生成 30 条抽样中文网页/CSV/JSON 和 `review-guide.md`;下一步是人工复核候选行并通过 import/status/gate-eval 累积 student-safe gate 校准证据。
- 当前人工复核口径:`usable` 表示候选可作为该谱面音符的正确证据;`wrong` 表示候选明显错位/音高不对应/不可作为该音符证据;`uncertain` 表示听不清或无法确认。新版复核页用“候选 1 / 30”作本页序号,并在卡片中写明“系统说:录音 X 秒附近可能对应第 Y 小节/MIDI Z”;原始行号只是内部编号,不用判断。导出脚本会把涉及的音频复制到复核页旁边的 `audio/` 文件夹,页面提供 `播放/暂停` 与 `跳到候选秒` 中文按钮,不必依赖浏览器原生音频小图标或后台音频接口;也提供 `一键未标=可用`、`一键未标=错误`、`一键未标=不确定` 和 `清空本页标注`。批量按钮只填未标项,不会覆盖已单独修改的候选。只有 `usable` 和 `wrong` 计入可评分样本,`uncertain` 不计入校准 precision。第一轮至少需要 30 条可评分复核后再运行 import/status/gate-eval。若 gate-eval 返回 `candidate-review-no-rule-meets-precision` 且规则没有选中样本,应运行 `npm run western:controlled-candidate-review-export -- --gate-candidates` 生成第二轮可校准候选复核页。
- 2026-07-08 更新:第二轮 `--gate-candidates` 复核 CSV 已导入。最新 30 条为 16 usable / 14 wrong;累计 labels 为 60 条,46 usable / 14 wrong。`western:controlled-candidate-review-status` 仍未通过,原因=`candidate-review-no-rule-meets-precision`;最新 30 条单独评估最高 precision 约 0.533,`npm run western:controlled-candidate-label-audit -- --labels <completed.csv> --min-selected 10` 也未找到 0.90 precision 规则。新增 `western:controlled-candidate-label-audit` 为只读诊断命令,用于检查是否存在稳定可用的候选子集;该命令不得替代 release gate。当前结论是普通上传候选仍保持 review-only。新版复核页已改为每条生成约 6 秒短音频和对应谱面图,并提供“打开短音频文件”兜底。
- 下一批复核导出默认排除已标候选:`western:controlled-candidate-review-export` 会读取累计 labels CSV 并跳过已有 `usable/wrong/uncertain` 的候选;需要复现旧页面时加 `--include-reviewed`。当前 `--gate-candidates` 重导出后,226 条可校准候选中已标 60 条被排除,剩余 196 条,页面抽取新的 30 条且与 labels 重叠为 0。
- 2026-07-09 更新:置信模型 pilot 已接入 `npm run western:controlled-candidate-confidence-pilot`。它用累计 60 条 `usable/wrong` 标签做 eval-only 训练/验证,主口径为 deployable 特征 + leave-one-recording-out,不使用 `recordingId` / `recordingScenario` 这类上线不可用或易过拟合字段。结果显示模型信号已出现:LogReg 阈值 0.8/0.9 选中 30/27 条且 0 wrong,RF 阈值 0.8/0.9 选中 30/29 条且 0 wrong;LogReg 阈值 0.5 为 precision=0.9189、coverage=0.6167。结论是"可以进入置信模型 blind validation",不是"已可上线":在下一批默认排除已标候选的新 30 条盲复核通过前,普通上传仍全部 `review_required`。

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

**小提琴优先,clean score 输入,先把 note-level 对齐和基础诊断做到 fail-closed V2 alpha;再做 M3+ 少退复核延伸和 M4 OMR,大提琴最后独立验证。**
