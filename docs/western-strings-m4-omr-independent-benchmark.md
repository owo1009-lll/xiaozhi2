# M4 OMR 独立基准(render-gold + 退化域 + 真照片)

更新时间: 2026-07-15
脚本: `scripts/experiments/eval_western_strings_m4_omr_render_gold.py`、`scripts/experiments/eval_western_strings_m4_real_jpg_omr.py`(eval-only)
产物: `data/experiments/western-strings-m4/render-gold-omr*`、`real-jpg-omr*`(gitignored)

> **当前裁决(2026-07-15):** `npm run western:m4-independent-benchmark-audit` 证明独立 clean/scan/photo render-gold 达到研究报告下限,但严格逐谱 P≥98% 且 R≥95% 仅 12/32(37.5%)。新增 5 份 Kayser Op.20 真实照片独立源谱 gold 后,Audiveris 总体 pitch P/R=`84.7%/71.5%`,onset-quarter/measure accuracy=`2.2%/43.8%`,完整严格通过 `0/5`;来源仓库 commit、CC-BY-SA-4.0 许可和 gold SHA-256 均已验证。任何只满足 pitch 的 MusicXML 也不得自动采用。当前 `automaticAdoptionReady=false`,`studentGateReady=false`,`humanTask=none`。

运行时置信筛选也已单独证伪:`npm run western:m4-omr-confidence-probe` 仅使用识别谱和 Audiveris 日志中上线可见的 11 个特征,按 BWV 作品留一。LR AUC=0.567,RF AUC=0.800;RF 最佳观察点仅 precision=0.80/coverage=0.156,不存在 precision≥0.90 且 coverage≥0.20 的安全子集。因此不能靠“模型自报高置信”绕过逐谱精度问题。

## 1. 为什么需要这份基准

此前 M4 benchmark 的 gold 与 Audiveris 草稿逐字节相同(自比较),给出的 100% 不可采信。本基准用**独立 gold**:Bach Violin Dataset 的公版 MusicXML(与 Audiveris 无关)经 Verovio 渲染成谱面图,再让 Audiveris **盲识**,music21 逐音比对。指标按 recall / 漏识率 / precision / F1 顺序报告(SequenceMatcher;不含节奏/时值评分),因为真实照片当前的首要失败模式是漏音。

## 2. 结果总览

| 域 | 样本 | mean P | mean R | 说明 |
|---|---|---|---|---|
| 干净数字渲染(上界) | 32 乐章 | **96.9%** | **93.8%** | 中位 P 96.8 / R 95.1;**P≥98% 仅 14/32**;2 首 100% |
| 合成 scan 退化(歪斜+噪声+模糊) | 6 乐章 | 94.4% | 89.2% | 相对干净只掉 ~1–2 点,结构完好 |
| 合成 photo 退化(透视+阴影+噪声) | 6 乐章 | 94.9% | 88.5% | 同上 |
| **真实练习曲照片**(12 张 M2f JPG) | 12 | — | — | **双峰**:8/12 高质量(3 张 100%,余 92–99%);**4/12 结构性崩溃**(幻小节/丢半页/无输出) |
| **真实练习曲照片独立源谱 gold** | 5 | **84.7%** | **71.5%** | Kayser 源谱独立裁切;严格 P≥98% 且 R≥95% 为 **0/5** |

旧 12 张照片 benchmark 中,8 条对照对象是“人工批准未改动的 Audiveris 草稿”,只能量**复识一致性**;其余 4 条为 `independent-edited-gold`。新增 5 张 Kayser source-gold 是另一个来源可审计的照片域独立测试集。三种 provenance 不得混成一个准确率。

## 3. 关键发现

1. **裸 OMR 达不到 ≥98% 闸门**:干净渲染域也只有 14/32 过线;和弦/复调乐章 91–96%。"识别一步到位 100%"不成立(坎1教训再次量化确认)。
2. **短板是漏音(recall)**:最差 bwv1004_mov2 P=99.1% 但 R=75.6%。漏音会引发下游"多拉音"误判,是最危险错误类型。
3. **光学退化不是主要敌人**:合成 scan/photo 只掉 1–2 点;**真照片失败源于版面结构**(多行谱表、谱号识别失败、裁切),不是噪声。
4. **失败有时可自暴露,但不能反推正确**:无输出、变体间小节数剧烈打架可自动拒绝;结构自检通过或多模型一致不等于识别正确,仍需独立 gold 校准。
5. **预处理无银弹,旧“赛马有效”不能升级为准确率结论**:在 12 张自一致性集里 Otsu/up3 曾改善个别图;但 5 张独立 gold 的完整 sweep 显示 `up2` 最好(P/R=`85.6%/72.2%`),`up3`=`76.9%/63.5%`,Otsu=`61.7%/50.4%`且一份无输出。按曲事后挑最佳变体仍严格 `0/5`,所以生产继续固定 `up2`,其它变体只保留研究证据。
6. **单音 vs 和弦分层清晰**:单音快速乐章 99–100%;与产品"单声部小提琴优先"边界吻合。

## 4. 对 M4 闸门的落地建议(分层)

- **A 层(自动采纳,当前关闭)**:原型条件是单声部 + 结构自检通过,但现有独立逐谱通过率和真照片 gold 不足,不能接生产。
- **B 层(变体赛马 + 音频仲裁)**:结构自检不一致 → 跑 up2/up2-otsu/up3 多变体,用学生录音事件仲裁选择;仲裁后仍不一致 → C 层。
- **C 层(fail-closed 人工)**:无输出/全变体打架/复调密集 → 退 m2f 人工核谱流程(一次核对,长期复用)。
- **诊断联动**:凡 OMR 谱未经人工核对的小节,禁用 pitch/onset/duration/missing/extra 学生硬判;只允许展示“录音与谱面此处不一致,需复核”,防止 OMR 错谱冤枉学生。

## 5. 诚实边界

- 干净渲染是**上界**;合成退化强度温和,真手机照片更糟且失败模式不同(结构层)。
- 旧 12 张真照片行不是独立准确率(gold 即草稿);当前 5 张 Kayser 源谱照片已经补上独立准确率,但样本仍小且集中于单页练习曲。
- 指标只覆盖音高序列;节奏/时值/调号/临时记号未单独评分。
- Audiveris 5.10.2 单引擎;多引擎(oemer/homr)交叉验证未纳入本轮。

## 6. 下一步

1. 保持 `up2` 与人工核谱默认路径;不得因某曲变体更好而自动选择。
2. 若继续攻准确率,优先比较独立 OMR 引擎或训练型模型,并继续使用这 5 份 source-gold 作冻结测试;任何参数选择后还需新增外部照片集复验。
3. 扩充真实照片 gold 只用于外部效度与新模型盲测,不再把“缺 gold”当当前阻塞原因。

## 7. 端到端原型:照片 + 录音 → 问题落回谱面(2026-07-11)

脚本: `scripts/experiments/proto_western_strings_score_anchored_feedback.py`(eval-only,不触碰生产闸门)
产物: `data/experiments/western-strings-m4/score-anchored-proto/`(标注图 + 逐音 verdict JSON)

**链路**:Audiveris `.omr` 的 `<measure><head-chords>` 权威和弦 ID 列表 + `<head-chord><bounds>` 像素框 → 与识别 MusicXML 逐小节一一对应(数量不符的小节整体标"锚定不确定");录音经 basic-pitch 提取音高事件,与谱面音序做半音代价对齐;逐音判定后画回**原始照片**。

**颜色语义(fail-closed)**:绿=音频确认;红=音频矛盾(仅在整篇吻合度≥60% 时才允许出现);黄=无音频证据(检测漏与演奏漏不可分,不指控);灰=录音未覆盖;蓝=锚定不确定小节。

**真实录音验证**:
| 片段 | 场景 | 结果 |
|---|---|---|
| violin-ex02 | 故意错音 | **2 个红框落在确切错音位置**(谱81/实83;谱71/实72),吻合度 97.5%,不确定小节仅 1/14 |
| violin-ex08 | 故意错音 | 11 红,吻合度 90.4% |
| violin-ex01 | 正确演奏 | 88 绿、0 红(快速连奏段 basic-pitch 漏检→黄,中性) |
| violin-ex05 | 弱起音 | 吻合度 44.7%(疑对齐伪影)→ **pieceGate=low-agreement-review,全部红降级为黄**,不冤枉学生 |

**发现的额外数据问题**:violin-ex02 照片含 25 小节,而"人工批准未改动"的草稿仅导出前 14 小节——批准草稿存在不完整风险,佐证独立核对必要性。

**边界**:单声部假设(取和弦最高音)、basic-pitch 对快速连奏欠检出、对齐为纯音高序列(未用节拍/时值);`audioAgreementHeard` 即 M4 B 层变体仲裁指标的雏形。

## 8. 产品化推进(2026-07-11 第二轮)

### 8.1 对齐器升级(proto_western_strings_score_anchored_feedback.py)
- **和弦级对齐**:basic-pitch 事件按起音邻近(60ms)聚合成音频和弦;代价函数对谱面和弦逐音取最近距离,**双音不再只取最高音**。
- **八度容错**:纯八度差按 0.5 计(弱弓常见的检测器亚谐波伪影),不误判为错音。
- **两遍时间锚定**:第一遍纯音高对齐 → 稳健线性拟合(index→秒)→ 第二遍加时间偏离项,抑制音阶乐段"错一位"漂移(ex05 原始吻合度 0.45→0.60)。
- **双邻确认规则**:红(错音)仅在左右邻音都被确认(对齐局部可靠)时保留,否则降级中性;闸门使用**降级前**的原始吻合度,降级不会把被守门的曲目重新放行。

**回归不变量(4 段真实录音)**:正确演奏 ex01 = **0 红**;错音场景 ex02/ex08 保留 1/5 个高置信红;不可靠对齐 ex05 整篇守门 0 指控。宁少报、不冤枉。

### 8.2 B 层仲裁器落地(proto_western_strings_variant_arbiter.py)
每张照片跑 up2/up2-otsu/up3 三变体识别,**学生录音仲裁**(单次 basic-pitch,复用三次):按(音频确认音数, 吻合度)选胜者;胜者需 ≥20 确认音且吻合度 ≥0.6,否则落 C 层人工。**全程不用 gold。**

| 照片 | 仲裁决定 | 判定 |
|---|---|---|
| ex10 | up2-otsu(101 音确认) | ✓ 与 gold 结论一致 |
| ex07 | human-review(全变体无输出) | ✓ 正确落 C 层 |
| ex06 | up2-otsu(46 音确认) | 意外可救——原"gold"(未改动草稿)本身错误,音频证据更可信 |
| ex11 | up2(50 音确认) | 与"gold"倾向不同;但该 gold=up2 自身不完整草稿,不可靠;记为边界 |

**已知边界**:仲裁器优化"音频可确认反馈量",不保证页面结构完整性(ex11);生产集成应叠加结构信号(总小节数/事件数合理性)。

### 8.3 产品化就绪评估
**已证明(真数据)**:照片→坐标级识谱(权威 chord 链)、录音→逐音校验、错音红框落点精确、五色 fail-closed 语义、低吻合整篇守门、变体仲裁自动救图+自动落人工。
**集成规格(接生产时)**:
1. 入口:受控提交流(clean-score+audio 队列)增加 photo+audio 类型;OMR 三变体 + 仲裁器 = M4 A/B 层;human-review = 现有 m2f 人工核谱队列(C 层)。
2. 判断层联动:OMR 谱未人工核对 → 该谱只允许"音频确认/矛盾/中性"三态展示,禁用 missing/extra 硬判;红框文案用"录音与谱面此处不一致",不用"你拉错了"。
3. 运行时闸门:沿用 `runtimeStudentGate` fail-closed 机制;`audioAgreementHeard`、confirmed 计数、uncertainMeasures 全部入审计记录。
4. 残留工作(非阻塞):节奏/时值维度并入对齐代价;独立 OMR 引擎/训练型模型在冻结 source-gold 上比较;新增外部照片作最终盲测;性能(basic-pitch 每分钟音频约 30–60s,可后台批处理)。

### 8.4 机器全自动模式原型(2026-07-11,历史 eval-only,未获采纳批准)
把 C 层"人工核谱"重构为两种**机器可处理**出口,人工核谱降级为可选质量升级通道:
- **C1 重拍引导**:全变体无输出或零音频确认 → 自动提示学生重拍(用户侧重试,非运营人工)。失败自检出:无输出/变体小节数打架都是机器可见信号。
- **C2 降级反馈**:仲裁胜者存在但证据弱(确认音 <20 或吻合度 <0.6)→ 只显示音频确认的绿色音,其余全部中性——覆盖率降低,指控风险为零。

**12 张真照片实测**:11 张全自动出反馈(8 直通 + 3 仲裁救回),1 张(ex07,九行谱表谱号识别失败)→ retake-photo。**专家人工介入:0。**

**代价(诚实)**:难页反馈变少而非变错;复调/密集页覆盖率仍低;人工核谱仍是把"降级页"升级为"全反馈页"的最佳通道,但不再阻塞任何流程。

### 8.5 离线生产候选管线 + 12 条一致性回归(2026-07-11 第三轮,不代表独立准确率)
**生产入口**:`scripts/western_photo_score_pipeline.py`(npm:`western:photo-score`)——单命令完成 照片+录音 → 三变体 OMR(带缓存)→ 录音仲裁 → 标注图 + 审计 JSON;决策枚举 `full-feedback:<variant>` / `degraded-feedback:<variant>`(仅绿)/ `retake-photo`。审计契约:`studentRuntimeTouched=false`、`missingExtraVerdictsEmitted=false`。快速单测 19 项(`test:western-photo-score`,纯逻辑,秒级)。对齐输出新增 `timingDeviationSec`(节奏偏差,信息性,为 M3 onset 维度铺路)。

**12 条真实录音全量回归(经生产入口)**:
| 出口 | 数量 | 明细 |
|---|---|---|
| full-feedback | **10/12** | 仲裁选非 up2 变体 7 次(otsu×4、up3×3),如 ex12: up3=104 确认 vs up2=44 |
| degraded-feedback | 1/12 | ex05(原始吻合 0.597<0.6,仅绿不指控) |
| retake-photo | 1/12 | ex07(全变体无输出,自检出) |
| 专家人工 / 误指控出口 | **0 / 0** | |

> **2026-07-16 P0 安全闸更新:** 上表是 P0 结构闸加入前的历史可用性结果。新版闸门允许显式符号或结构佐证、冲突仍拒绝；对同一 12 份三变体缓存重放后，`0/12` 存在完整 P0-ready 变体，严格策略为 `11 review + 1 retake`。仅保留双证绿色可在 11 份中保留 870 音且不输出指控，但独立 gold 审计最差单曲 precision 仅 80%，故该出口尚未恢复到学生端。重放报告由 `npm run western:m4-p0-feedback-impact` 生成。

**缺陷/边界清单(如实)**:
1. basic-pitch 对快速连奏欠检出 → 黄区偏大、红灵敏度保守(precision-first 取舍);
2. 弱起音/低吻合录音(ex05)只能降级,节奏维度尚未参与判定(数据已输出);
3. ex07 类密集多行谱页三变体全崩 → 只能重拍;oemer(pip 0.1.8)未装,多引擎救回待做;
4. 仲裁器按"音频确认量"选胜者,不含页面结构完整性信号(ex11 类歧义);
5. 性能:单条约 2–6 分钟(OMR×3+basic-pitch),定位为离线批处理,非实时;
6. 服务端路由/UI 接线未做(归 runtime 线,受既有审批闸门);真照片人工 gold 仍缺。

### 8.6 服务端接线完成(2026-07-11 第四轮)
- **入口**:`POST /api/strings/analyze` 受控提交现接受 `scorePhotoPath`+audio → 登记为 `kind=photo-score` 队列项(`photo-score-requires-offline-pipeline`,`studentReady=false`,零 decisions)。
- **执行**:`npm run western:photo-score-batch` 只处理教师审核 `accepted_for_batch` 的照片提交,调用 python 管线,追加审计(`autoDiagnosisIssued=false`、`studentFacing=false`),幂等(已跑过的跳过)。
- **E2E 实证**:入口→审核→批处理→审计 一条真数据(violin-ex12 照片+录音)走通,decision=`full-feedback:up3`。
- **测试**:`test:western-photo-score-intake`(入口 fail-closed 4 项)通过;`test:western-feature-flags`、`test:western-alignment-preview` 回归无破坏。学生端运行时闸门全程未动。

### 8.7 多引擎救回 ex07 + 第二轮收口(2026-07-11 第五轮)
- **oemer 0.1.8 已装并实测**:对 ex07(Audiveris 三变体全无输出的九行谱照片)识别出 176 事件/23 小节,**录音交叉验证吻合度 92.0%**(87 对齐中 80 确认)。多引擎变体池成立:**12/12 真实照片全部机器可用**(11 Audiveris + 1 oemer)。
- **边界(已更新)**:Oemer CLI 默认只输出 MusicXML,但内部 `NoteHead` 实际保留像素 bbox。2026-07-16 已完成非侵入式坐标 sidecar 适配,见 8.9;识谱准确率仍未过闸,故 ex07 只允许可定位复核,不允许学生端自动判定。Oemer CPU 推理约数分钟/页。
- **⚠️ 依赖坑(运维必读)**:`pip install oemer` 会把 numpy 拉到 2.x,**直接弄坏 basic-pitch/tensorflow/numba**;装后必须 `pip install "numpy<2"` 回 1.26.x,两引擎可共存。
- **仲裁器结构信号结论**:纯 events 计数排序实测更糟(幻觉小节推高计数,ex10/ex06 反被误选)→ 维持(确认数,吻合度)排序;events 差异作为 `structureSpreadNote` 教师提示保留;ex11 为已度量接受边界。
- **状态可见性**:`western:project-status` 新增 `photoScoreOfflineChain`;gold 溯源审计排除同引擎复识/评测产物(independentCandidateRows 恢复 0,`test:western-project-gate` 复绿)。

### 8.8 Oemer 独立 source-gold 对照(2026-07-15)
- 8.7 的 `92.0%` 是与录音的交叉吻合,不能替代独立 MusicXML gold 准确率。现用 `npm run western:m4-oemer-benchmark` 在冻结的 5 份真实照片 source-gold 上补齐公平对照,输入预处理固定为与 Audiveris 相同的 `up2`。
- Oemer 0.1.8 原先成功输出 4/5；`ex05` 的播放器黑边诱发错误 3-track 结构和 builder 断言。新增仅对该明确失败生效的固定行均值裁边重试后，5/5 均可输出。全 5 份聚合 pitch P/R=`71.87%/76.23%`、onset-quarter/measure accuracy=`5.43%/18.21%`；严格 P≥98%、R≥95%、节奏两项≥95% 仍通过 `0/5`。
- 同一 5 份 Audiveris up2 聚合 P/R=`85.47%/72.14%`。Oemer 在 `ex12` 明显提高 recall,但 `ex09` precision 大幅下降；裁边只修复输入域崩溃，不解决识别准确率，不存在可直接采用的固定替换策略。按 gold 事后逐页挑引擎属于 oracle,不得冒充生产选择器。
- Oemer 的 SVC 产物来自 `scikit-learn 1.2.0`。已用精确 1.2.0 兼容环境复跑,并与 1.2.2/1.8.0 输出逐字节比较;同页 MusicXML SHA-256 完全一致,故低准确率不是 sklearn 版本警告造成。
- 裁决:`automaticAdoptionReady=false`,`studentGateReady=false`;保留 Oemer 为 eval-only 外部引擎证据,不替换 Audiveris,不进入学生端。

### 8.9 Oemer 坐标 sidecar(2026-07-16)
- 新增 `scripts/experiments/run_oemer_with_coordinates.py`,不修改 site-packages。runner 在 Oemer 真正发射 MusicXML `<note>` 的 `AddNote.perform()` 之后记录同一音头的 bbox,同时保存干净 dewarp 画布。无效音头和超出 A0-C8 的内部动作不会进入 sidecar。
- 坐标使用独立 JSON schema:XML pitched-note 序号、Oemer note id、measure、track、voice、chord continuation、像素 bbox 和归一化 bbox。读取时要求索引连续、画布存在、尺寸有效、bbox 全部有限且位于 `[0,1]`;任一条件不满足则整页 fail-closed。
- 真实 `ex08` smoke 得到 `361 XML notes = 361 coordinate notes`;新旧 MusicXML SHA-256 完全一致。正式 5 页基准中 5 个 Oemer 输出页全部实现 MusicXML 与 sidecar 一一匹配；新增裁边页为 `ex05 289/289`，其余 4 页保持原计数。
- 坐标补齐未改变 Oemer 的严格结论。报告为 `coordinateAdapter.readyRows=5/5`,`studentFacing=false`;它只解决复核界面的“标在哪里”,不解决 OMR “识别是否正确”,不得用于自动采纳。

### 8.10 HOMR 0.7.0 transformer 对照与完整谱闸门(2026-07-15)
- HOMR 是独立的两阶段 OMR:结构分割后使用 transformer 做符号序列识别。隔离 Python 3.11/NumPy 2.4/CPU-only ONNX Runtime、4 线程串行运行,未污染现有 Basic Pitch 环境。
- 5/5 原始 source 照片均成功输出,聚合 pitch P/R=`89.00%/96.17%`,onset-quarter/measure accuracy=`30.73%/79.04%`。它的 recall 明显优于 Audiveris/Oemer,但节奏结构仍远低于 95% 门槛。
- `ex05` 与 `ex12` 的 pitch P/R 均为 `1.00`,若沿用旧 pitch-only 判据会出现 `2/5` 假通过;其 onset-quarter accuracy 仅 `0.69%/8.02%`。实查 MusicXML 证实 HOMR 把正确音高序列赋成错误时值,不是评测脚本误差。
- 因此外部引擎统一采用四项完整闸门:pitch precision≥0.98、pitch recall≥0.95、onset-quarter accuracy≥0.95、measure accuracy≥0.95。HOMR pitch-only 通过 `2/5`,完整通过 `0/5`;`automaticAdoptionReady=false`,`studentGateReady=false`。

### 8.11 Clarity-OMR 视觉 Transformer 对照(2026-07-15)
- 按[官方 Clarity-OMR 仓库](https://github.com/clquwu/Clarity-OMR)与[官方模型页](https://huggingface.co/clquwu/Clarity-OMR)运行 YOLO 谱表检测 + Transformer 解码管线,使用官方 beam width 5。模型仅作隔离 eval-only 对照,不进入生产依赖。
- 冻结照片来自播放器截图,原图含黑边和标题栏;原样包装成 PDF 时 Stage A 在 `ex05` 检出 `0` 个谱表。为避免把截图边框误当作模型识谱能力,正式对照统一使用不看 gold 的行均值裁页规则,并把该预处理写入每页证据。
- 裁页后 5/5 均输出 MusicXML,聚合 pitch P/R=`72.77%/35.53%`,onset-quarter/measure accuracy=`2.81%/10.10%`;pitch-only 与完整严格通过均为 `0/5`。因此模型架构更强不等于当前拍照域可直接采用,Clarity 保持 `automaticAdoptionReady=false`,`studentGateReady=false`。

### 8.12 DoReMi 公开谱面监督适配 pilot(2026-07-16)
- 数据来自[DoReMi v1](https://github.com/steinbergmedia/DoReMi/releases/tag/v1.0)的页图、页级 OMR XML 和 MusicXML。只解压 3 部弦乐四重奏的有界子集,按作品划分 train/validation/synthetic-test=`96/48/48` 个谱表对;作品、图像 hash 均无交叉,5 份冻结照片 gold 不在训练路径中。由于存档未附可机读的数据集许可文件,当前仅限本地 eval-only,不再分发。
- 32-step bf16+DoRA 在按作品隔离的数字谱上提高了 teacher-forced token accuracy:validation `56.89% -> 66.02%`,synthetic-test `62.65% -> 72.96%`。这仅证明适配器学会了 DoReMi 数字谱域,不是真实 OMR 验收。
- 在冻结 5 份真照片上,适配候选 pitch P/R=`75.94%/36.10%`,onset-quarter/measure accuracy=`5.18%/6.65%`,严格通过 `0/5`。相比官方 Clarity 基线,音高 P/R 和 onset 略升,但 measure accuracy 从 `10.10%` 退化到 `6.65%`。
- 预声明的适配闸门要求 pitch precision/recall、onset 和 measure 四项都不退化,且至少一项改善;该候选因此被 `reject-and-delete`。公开干净谱可以提高数字谱域指标,但不能单独修复真照片的休止、符杠/符尾、附点和小节结构。后续仅在有拍照域退化+结构级标注时再开启监督训练。
- 识别对象、安全闸门和 P0-P3 优先级见 [M4 OMR 识别需求与验收规范](western-strings-m4-omr-recognition-spec.md)。
## 2026-07-16/17 同输入图同版本人工 gold 补充

《北京的金山上》已完成负责人人工 MusicXML 誊写，gold 与 OMR 输入来自同一谱页、同一版本，不再受公开源谱版本差异影响。`npm run western:m4-same-edition-benchmark` 只读取已有输出并验证三引擎引用同一 gold SHA-256。这里的“同输入图”不等于“手机照片”：当前北京输入是已拉直的干净页图，其域标签已在 2026-07-17 复验中修正。

| 引擎 | Pitch precision | Pitch recall | Onset-quarter | Measure | 严格通过 |
|---|---:|---:|---:|---:|---:|
| Audiveris up2 | 80.56% | 33.72% | 0% | 0% | 0/1 |
| Oemer 0.1.8 | 85.07% | 33.14% | 0% | 0% | 0/1 |
| HOMR 0.7.0 | 98.84% | 98.84% | 100% | 100% | 1/1 |

HOMR 仅在第 7、35 小节各有一个 `C#5 -> B4` 替换，其余 170/172 音和全部节奏、小节结构与人工 gold 一致。2026-07-17 已在全新输出目录从同一输入重新运行 HOMR；新旧 MusicXML 的 SHA-256 完全一致，事件级复算仍为上述两个替换，证明该单页结果可重复。

但输入审计同时修正了证据域：`beijing-jinshan-score.png` 是已拉直、无透视和手写干扰的干净谱页图，并非负责人展示的弯曲手机照片。因此 `98.84%` 只能作为“干净页图/扫描域单页阳性”，不能表述成真实手机照片域准确率。当前 ONNX Runtime 1.27.0 对冻结 5 张独立 source-gold 照片的 fresh 汇总为 pitch P/R=`88.33%/95.78%`、onset-quarter=`30.03%`、measure=`79.04%`、严格通过 `0/5`；照片域仍未通过。统一自动采纳函数继续保持 `automaticAdoptionReady=false`，学生端 fail-closed。fresh 报告位于 `data/experiments/western-strings-m4/beijing-homr-fresh-revalidation-20260717/` 和 `data/experiments/western-strings-m4/homr-fresh-sourcegold-revalidation-20260717/`。

### 8.13 Op.45 No.34 独立公开演奏 MIDI 音高顺序佐证(2026-07-16)

- 对 `练习曲 Op.45 No.34` 真实照片运行 HOMR 0.7.0，初始得到 `198` 个音、`32` 小节。人工同版复核确认第 2/3 小节之间漏线，按 6/8 时值边界局部拆分后为 `198` 个音、`33` 小节；音高与记号未改。独立参考来自 [MTG violin-transcription](https://github.com/MTG/violin-transcription/) 的公开 performance-aligned MPE MIDI，共 `331` 个 note-on。
- 合并 MPE 多轨并做仅音高的局部序列对齐后，HOMR 草稿第 `49-198` 音与参考前 `150` 音连续完全一致：`150` exact matches、`0` substitutions、`0` draft gaps、`0` reference gaps。照片版本前 `48` 音是公开演奏版本没有的 8 小节准备段，因此未强行参与匹配。
- 这是独立来源对 HOMR 主体音高顺序的强佐证，但不是该照片的同版本人工 MusicXML gold。performance MIDI 的拍号/时值由演奏对齐表示，不能作为印刷节奏或小节结构真值；本实验明确 `rhythmEvaluated=false`,`sameEditionHumanGold=false`,`automaticAdoptionReady=false`。
- 复跑命令：`npm run western:m4-op45-public-reference`；回归测试：`npm run test:western-m4-op45-public-reference`；报告：`data/experiments/western-strings-m4/op45-34-public-reference/op45-34-public-reference-comparison.json`。该证据不改变同版严格闸门的 `1/5` 计数。

### 8.14 Op.45 同版人工复核与安全导入(2026-07-16)

- 并排复核页：`data/experiments/western-strings-m4/op45-34-same-edition-gold-candidate/index.html`。页面要求四类记谱元素全部通过，并强制填写复核人姓名。
- 下载 JSON 固定携带原始照片和候选 MusicXML 的 SHA-256。安全导入命令为 `npm run western:m4-op45-promote-gold -- --review <下载的json>`；姓名缺失、任一检查未通过或任一文件哈希变化都会 fail-closed，且不会覆盖已有的不同 gold。
- 推荐直接使用 `npm run western:m4-op45-finalize-benchmark -- --review <下载的json>`：该命令包含上述安全提升，并复用已冻结的 Audiveris/Oemer/HOMR 输出生成两页三引擎报告，不会重新跑重模型。由 HOMR 候选经人工逐项校对得到的 Op.45 页会保留为 human-reviewed evidence，但标记 `candidateEngineBiasRisk=true`，不计入 HOMR 自动采纳所需的独立页数。
- 同版三引擎汇总器已支持多页：每个引擎必须引用完全相同、无重复的 gold SHA 集合，`observedIndependentRows` 才按不同页数增长。缺页、错页或混入不同 gold 会拒绝整个汇总。
- 这些改动只保证金标导入和计数不被污染。当前尚无 Op.45 人工复核 JSON，也尚未基于该 gold 完成三引擎盲测，所以严格门槛仍是 `1/5`，不能提前记为第 2 页。

### 8.15 自适应谱线缩放根因复核(2026-07-17)

- Op.45 的谱线估计没有失效：原图 interline=`5px`、请求/实际倍率=`4×`、最终 interline=`20px`，未触发 1800 万像素上限。旧自适应路径只识别 17 事件的根因是 `autocontrast cutoff=0`，而手动 4× 使用 `cutoff=1%`。
- 修正后自适应生成图与手动 4× 图 SHA-256 完全一致，Audiveris 同样恢复 `101` 个事件和 4 行谱；P0 通过谱号与调号，只因拍号结构证据不足保持 review-only。
- 同一参数在《北京的金山上》独立 gold 上并不泛化：pitch R/Miss/P/F1=`16.28%/83.72%/28.28%/20.66%`，低于 up2 的 `35.47%/64.53%/87.14%/50.41%`。因此只修复实验实现，不把 `cutoff=1%` 或自适应路径接入生产。正式报告：`data/experiments/western-strings-m4/adaptive-interline-probe/report.json`。

### 8.16 反复路线取证(2026-07-17)

- 《北京的金山上》同版人工 gold 不含反复记号，不能用于测试反复展开。
- 带反复线且有公开逐音对齐真值的 Bach `BWV1005 mov4` 中，未展开谱与演奏真值均为 `1196` 个事件；盲目展开为 `2392`，绝对计数误差增加 `1196`。
- 反复记号只说明印刷路线存在，不证明某次演奏实际执行反复。生产策略继续 fail-closed：检测到非平凡路线后输出 `repeat-route-review-required`，只有后续音频路线证据支持时才允许选择展开版本。报告：`data/experiments/western-strings-m4/repeat-route-probe/report.json`。
- Op.45 的 `52.56%` 音频吻合率也不能归因于反复：修正后的同版候选与独立公开参考各有 `198` 个音，二者的 MusicXML 都没有反复方向标记。当前证据只支持“反复假设不成立/不可用”，不支持为提高吻合率而展开谱面。
