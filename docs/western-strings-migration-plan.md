# 弓弦乐器练习诊断平台 — 迁移计划书(西洋弦乐线,validation-first)

> **状态:v2 — M0 已通过(GREEN)。项目进入 M1(clean-score ingestion)+ M2(confidence-gated alignment alpha)准备阶段。** 本计划把"AI 二胡专用系统"扩展为"弓弦乐器练习诊断平台",**冻结二胡自动化攻坚线**(保留为 V1.5 人在环成果 + 困难案例/论文证据),新开**西洋弦乐线,小提琴为第一验证对象**。
> **完整执行手册见 [western-strings-project-plan.md](western-strings-project-plan.md)**(10 章:资产盘点 / V2 工程规格 / 许可证治理 / M1-M5 拆解 / 论文产出 / 降级规则)。本文 = 战略纲要 + M0-M5 闸门 + 决策记录。
> 核心纪律(已兑现):不预设"对齐已解决",以本项目 pipeline 的 M0 实测为准——**M0 已用硬数字通过**。

---

## M0 结论与迁移决策(v2 新增)
| 数据集 | 最佳方法 | median onset | hit@300ms | 判定 |
|---|---|---|---|---|
| Bach10 | Parangonar + Basic Pitch | 35.2ms | 95.8% | 🟢 |
| URMP | Parangonar + Basic Pitch | 19.1ms | 93.8% | 🟢 |
| MusicNet | Basic Pitch DTW | 58.4ms | 95.3% | 🟢 |

真实 CREPE-DTW 三套亦全绿。报告 `western-strings-m0-alignment-report.md`;脚本 `scripts/experiments/eval_western_strings_m0_*.py`;产物 `data/experiments/western-strings-m0/`。
→ **对齐在西洋弦乐上可行(对比二胡:秒级/失败)。GO,进 M1/M2。** caveat:M0 为数据集 gold + 干净谱 + 精录工况;**V2 必须在真实学生录音上复验**。

### Decision Record
- 二胡自动线**冻结**(不删):保留为 V1.5 人在环 + 困难案例/论文对比证据。
- 西洋弦乐 **M0 已通过**(上表,commit 660dce5)。
- 第一版**只小提琴 + clean MusicXML/MIDI**;**不做 PDF OMR**(避免坎1 重现)。
- 技巧识别**后置(M4)**,非 V2 必需;**大提琴独立 M0(M5)**,不复用小提琴阈值。

---

## 0. 产品定位(措辞已按审查降级)
- **不叫"废弃二胡"**,叫:**冻结二胡自动线,转向西洋弦乐 V3 验证线**。二胡保留为:
  - V1.5 人在环可靠成果(人工锚点 → 教师结构化标注 → 导出);
  - "为何二胡/弓弦比钢琴难"的能力边界证据(论文 + 产品动机)。
- 新线目标:**在干净谱面(MusicXML/MIDI)+ 现成对齐数据上,先验证本系统能否达到 note-level V2/V3。**
- 三句必须保持的"降级表述":
  - 不写"对齐已解决" → 写"**小提琴有更好的干净谱/数据/模型先验,但能否达 teacher-ready 需 M0 实测**"。
  - 不写"坎1 消失" → 写"**第一版仅支持 MusicXML/MIDI 时坎1 基本消失;一旦重引 PDF OMR,坎1 重现**"。
  - 不写"技巧数据更多" → 写"**对齐数据 ≠ 技巧标签数据;技巧需单独数据源或教师短窗标注**"。

---

## 1. 指导原则
1. **validation-first**:M0 不过,不建产品、不改 UI。
2. **fail-closed**:四态(auto_pass / review_required / reject_unsupported / failed),低置信绝不反馈给学生。
3. **复用现有工程资产**(见 §2),不重写产品。
4. **不过度承诺**:对齐、技巧、大提琴都各自独立验证,不默认成功。
5. **谱面只用干净源**:MusicXML / MIDI / dataset-provided score;**第一版不做 PDF OMR**。

---

## 2. 资产复用 vs 新增
| 资产 | 处理 |
|---|---|
| 谱面 store / 音符序列结构 | ✅ 复用(改喂干净 MIDI/MusicXML) |
| 对齐 harness(CREPE-DTW、`anchor_eval`、M1 细真值、ensemble、置信探针) | ✅ 复用,改音高范围参数 |
| 教师后台 + 人工锚点 + 结构化技巧字段 + 导出 + teacher-ready gate | ✅ 复用 |
| 置信闸门框架 + V 级验收方法学 + 四态 | ✅ 复用 |
| OMR / Audiveris / 缓存链路 | ⛔ 第一版**不接入**(避免坎1 重现) |
| 数据集 adapter(Bach10/URMP/MusicNet → score store) | ➕ 新增 |
| instrument config(音高范围等) | ➕ 新增 |
| 弦乐技巧分类器 + 数据 | ➕ 新增(后置,M4) |

---

## 3. 数据集分层(用途不同,不可混为同一种真值)
| 数据集 | 用途 | 关键限制 | 来源 |
|---|---|---|---|
| **Bach10** | **M0a smoke test**(最干净最小验证) | 仅 10 首 Bach chorale;小提琴只是 soprano 声部(另含单簧管/萨克斯/巴松);**不是小提琴练习曲集** | https://labsites.rochester.edu/air/datasets/Bach10%20Dataset_v1.0.pdf |
| **URMP** | **M0b 分轨小/大提琴 + ensemble robustness** | chamber music,非"学生独奏练习";提供 score/分轨/mixture/note&frame 标注 | https://labsites.rochester.edu/air/publications/li2018creating.pdf |
| **MusicNet** | **M0c 规模化/跨曲评估** | 330 录音、>100 万 note label,**含约 4% 标签误差**(对齐生成+音乐人校验)→ **看整体分布,不逐点苛责** | https://zenodo.org/records/5120004 |
| **ASAP** | **方法参考,不作弦乐主验证集**(主要是钢琴 aligned score/performance) | piano 为主 | https://github.com/fosfrancesco/asap-dataset |

**结论:对齐真值以 Bach10(最干净)为基准,URMP 看分轨稳定性,MusicNet 看规模分布(容忍 4% 噪声),ASAP 只借方法。**

---

## 4. 里程碑总览
```
M0  小提琴对齐验证探针(GO/NO-GO 闸门)   ← 现在只做这个
M1  干净谱面接入(MusicXML/MIDI only)
M2  小提琴 V2 对齐 + 置信闸门
M3  基础教学诊断(音准/节奏/漏音,先于技巧)
M4  技巧识别 pilot(单独线,后置)
M5  大提琴扩展(独立 M0 + 重新校准)
```

---

## 5. M0:小提琴对齐验证探针(唯一立即执行项)

**目的**:用本项目 pipeline 实测——小提琴干净数据上能否达到 note-level 对齐基础能力。**这是是否正式迁移的硬闸门。**

**分支**:`feature/western-strings-m0-alignment`(eval-only,不接生产)

### M0 验收指标(比"中位<300ms"更细;尾部错误会害学生)
| 指标 | Green | Yellow | Red |
|---|---:|---:|---:|
| median onset error | **<150ms**(Strong Green <100ms) | 150-300ms | >300ms |
| hit@300ms | ≥85% | 70-85% | <70% |
| coverage | ≥80% | 60-80% | <60% |
| p90 onset error | <500ms | 500ms-1s | >1s |
| double-stop / legato 段 | **单独报告**(不并入总体) | 单独报告 | 单独报告 |

**指标定义(必须固定,否则不同实现算出不同结果):**
- `coverage = 有有效预测的 gold note 数 / gold note 总数`;**无预测、低置信拒绝、polyphonic-unsupported 三类分开统计**,不算"有效预测"。
- `median / p90 onset error`:仅在"有有效预测"的 gold note 上计算。
- GO 阈值用 **median<150ms**;`<100ms` 仅作论文亮点单列,不作 GO 门槛。
- `double-stop` = score 中同一 onset、同声部/乐器上 ≥2 个不同 pitch;`legato` = 相邻音有 slur/tie,或 onset 间隔小且无明显 silence。**数据集无这些字段 → 标 `unknown`,不强行分类。**

### 两级闸门(M0a → 条件触发 M0b)
- **M0a(Bach10)先跑。**
  - M0a 全 Green(median<150ms 且 hit@300ms≥85% 且 coverage≥80%)→ **才跑 M0b**;
  - M0a 任一核心指标 Red(median>300ms / hit@300ms<70%)→ **直接停,不跑 M0b**。
- **M0b(URMP 分轨)**:violin/cello individual track;Green = median<300ms、hit@300ms≥80%、无大量错位。
- **总 GO** = M0a 全 Green **且** M0b 不大量错位;**NO-GO** = M0a Red,或 M0b 分轨大量错位。

### M0a:Bach10 smoke test(步骤精确到每一步)
1. 建分支 `feature/western-strings-m0-alignment`。
2. 下载 Bach10(直链 PDF 说明见 §3;数据本体按其说明获取)。
3. 写 **dataset adapter**:Bach10 → 本系统三件套。**Bach10 是多声部(violin/soprano + 单簧管/萨克斯/巴松);M0a 只取 violin/soprano part 的 score notes + 对应 stem,绝不用 full score 对 violin stem 评估**(否则其它乐器音符会被当漏检)。
   - audio:**violin/soprano 单声部 stem**(mixture 仅作扩展测试,不作首轮 GO);
   - score:**仅 violin/soprano part** 的 MIDI → 音符序列(midiPitch/onset/dur);
   - gold:该 part 的 ground-truth note onset(秒)作为细真值。
4. 跑现有对齐器:**CREPE-DTW**(主)、**Parangonar**、**Basic Pitch**(各产 per-note onset 预测)。
5. 用 `anchor_eval` / M1 细真值逻辑,对 Bach10 gold 算:
   - median onset error、hit@100ms、hit@300ms、coverage、p90;
   - **double-stop / legato 片段单独切出来报**;
   - 输出 `per-note error CSV` + failure cases。
6. 按上表判 Green/Yellow/Red。
   - **GO(进 M0b)**:median<150ms、hit@300ms≥85%、coverage≥80%。

### M0b:URMP 分轨测试
1. adapter:URMP → 三件套(violin individual track、cello individual track)。
2. 跑同一套对齐器 + 评测。
3. 重点:**violin / cello 各自独奏轨**;ensemble mixture 作扩展,不作第一门槛。
4. GO:URMP violin median<300ms、hit@300ms≥80%、分轨无大量错位。

### M0c:MusicNet scale test
1. adapter:MusicNet violin subset → 三件套(注意 ~4% 标签噪声)。
2. 跑评测,**看误差整体分布**,不把每个失败点都归罪模型(可能是标签噪声)。
3. 产出跨曲分布图/表。

**M0 总产出**:一页 GO/NO-GO 报告(三套数据的指标表 + 失败案例 + 结论)。

---

## 6. M1:干净谱面接入(M0 GO 后)
**目的**:输入从"二胡 PDF/OMR"改为 **MusicXML/MIDI first**。
步骤:
1. 新建 **instrument config**(tracking range,给高把位留余量,**不要把 E7 硬写成小提琴上限**):violin **G3-A7**;viola C3-E7;cello C2-C6。产品级曲库可**按曲目实际最高音逐曲收窄**。
2. score importer 支持 **clean MIDI / MusicXML**。
3. **暂停 PDF OMR / Audiveris**(避免坎1);**不抓取未核授权的 MuseScore/IMSLP 谱面**(许可证风险)。
4. dataset adapter 统一输出到 score store。
**完成标准**:Bach10/URMP/MusicNet 可统一进 score store;不依赖 Audiveris;不产生污染缓存。
**注**:PDF OMR 留作后续 V4 或 optional import,不进第一版。

---

## 7. M2:小提琴 V2 对齐 + 置信闸门
**目的**:高置信 note onset 自动通过,其余 review。
模型:CREPE / Basic Pitch / Parangonar / local DTW / onset detector(置信度模型而非投票,沿用二胡线教训)。
四态 + **新增弦乐 reason codes**:
`double-stop-unsupported` / `legato-onset-ambiguous` / `rubato-section` / `low-pitch-confidence` / `polyphonic-texture` / `score-audio-range-mismatch` / `weak-onset` / `dataset-label-uncertain`。
**验收(V2)**:auto_pass precision ≥90%;coverage ≥30%;**按曲单独报告**;跨曲(留一曲)验证;无真值泄漏。

---

## 8. M3:基础教学诊断(先于技巧)
**先做基础,不先做技巧。**
内容:音准偏差 / 起音时序 / 音长误差 / 漏音·多音 / 音高不稳 / 低置信警告。
**完成标准**:note-level 反馈能落到谱面位置;低置信不反馈;教师后台可复核;修正回流训练集。

---

## 9. M4:技巧识别 pilot(单独线,后置,降承诺)
**目的**:验证"能不能做技巧",不是一开始承诺。
**前提认知**:对齐数据集**不直接给**揉弦/弓法/换把/顿弓/跳弓/泛音/拨弦标签 → 需单独数据或教师短窗标注。
优先顺序:vibrato → pizzicato → staccato/legato → spiccato → position shift → harmonic。
候选数据源(均需先核许可证/可下载性):
- Good-sounds(含 cello 等单音音质标注,参考音质/单音任务,非完整对齐):https://www.upf.edu/web/mtg/good-sounds
- bowstroke / gesture 数据(对弓法有帮助,但常含传感器,未必适合纯音频产品);
- violin technique-aware transcription / 合成小提琴技巧数据(研究参考,**合成仅作预训练,不作最终验收**)。
**验收**(技巧标签常类别不平衡,只看 AUC 会误导):每类必须报 **AUC + PR-AUC + 每类正/负样本数**,**按曲留一(leave-one-piece-out)**。每类 **AUC≥0.70 且 PR-AUC 明显高于正例基率**才继续;precision≥90% 才允许 auto_pass;否则只做 review hint。
**采用与二胡线一致的短窗(5-10s/音符邻域)标注,避免段级退化。**

---

## 10. M5:大提琴扩展(不早承诺)
**前置**:小提琴 M2/M3 通过 + pipeline 稳定 + 有 cello 数据集验证。
风险(写入计划):低音区 pitch tracking 更难;起音更慢;legato 边界更模糊;**cello/换指 onset 人工与算法标注都更难**。
步骤:cello pitch range + onset/pitch 参数 + **cello 专属误差分析** + **重新校准阈值(不复用小提琴阈值)** + 独立 cello M0。
表述:架构"**配置层预留**大提琴",而非"同时支持"。

---

## 11. 风险与缓解
| 风险 | 缓解 |
|---|---|
| 过早相信"弦乐对齐已解决" | **M0 实测闸门**,不过不迁移 |
| 选到 rubato 重的曲目重蹈二胡覆辙 | 起步只选**节拍清晰**(巴赫/练习曲) |
| 重引 PDF OMR → 坎1 重现 | 第一版**只 MusicXML/MIDI** |
| 数据集标签噪声(MusicNet ~4%) | 看分布,不逐点苛责;Bach10 作干净基准 |
| 技巧被高估 | 技巧后置 M4,单独数据/教师标注,降承诺 |
| 大提琴被当"改个参数" | 独立 M0 + 重新校准 |
| 许可证(MuseScore/IMSLP/合成数据) | 用前核授权;合成仅预训练 |

---

## 12. 当前立即执行:M1/M2 alpha(M0 已完成)
**M0 已通过(见顶部决策记录)。下一步进入 M1 + M2 alpha(工程细节见 [western-strings-project-plan.md](western-strings-project-plan.md) §6):**
1. 把 M0 脚本整理成**可复跑 eval harness**(一键重出 M0 指标);
2. 建 **clean MIDI/MusicXML importer** + **violin instrument config(G3-A7)**;
3. Bach10/URMP/MusicNet **adapter 统一进 score store**;**停用 PDF OMR 导入**;
4. 做 **M2 V2 confidence gate**(置信模型而非投票;auto_pass precision≥90%,coverage 作结果报告;四态 + reason codes;**泄漏黑名单见手册**);
5. **只做基础诊断(音准/节奏/漏多音),不碰技巧**(技巧 M4 后置)。

- **M2 在真实输入达标** → V2 alpha;**达不到** → 降级 review-only(见手册降级规则)。
- (历史)M0 NO-GO 时的退路:重选目标(钢琴 / 仅人在环)——**现已不触发,M0 通过。**

---

## 13. 一句话产品策略
**先小提琴 → 先 MusicXML/MIDI → 先用 Bach10/URMP/MusicNet 实测对齐 → 先做音准/节奏/漏音 → 后做技巧 → 最后扩大提琴。**
最大优点:复用现有工程资产;最大风险:过早相信"弦乐对齐已解决"。**所以 M0 先跑,硬数字说话。**
