# M4 OMR 独立基准(render-gold + 退化域 + 真照片)

更新时间: 2026-07-15
脚本: `scripts/experiments/eval_western_strings_m4_omr_render_gold.py`、`scripts/experiments/eval_western_strings_m4_real_jpg_omr.py`(eval-only)
产物: `data/experiments/western-strings-m4/render-gold-omr*`、`real-jpg-omr*`(gitignored)

> **当前裁决(2026-07-15):** `npm run western:m4-independent-benchmark-audit` 证明独立 clean/scan/photo render-gold 达到研究报告下限,但严格逐谱 P≥98% 且 R≥95% 仅 12/32(37.5%)。新增 5 份 Kayser Op.20 真实照片独立源谱 gold 后,Audiveris 总体 pitch P/R=`84.7%/71.5%`,onset-quarter/measure accuracy=`2.2%/43.8%`,完整严格通过 `0/5`;来源仓库 commit、CC-BY-SA-4.0 许可和 gold SHA-256 均已验证。任何只满足 pitch 的 MusicXML 也不得自动采用。当前 `automaticAdoptionReady=false`,`studentGateReady=false`,`humanTask=none`。

运行时置信筛选也已单独证伪:`npm run western:m4-omr-confidence-probe` 仅使用识别谱和 Audiveris 日志中上线可见的 11 个特征,按 BWV 作品留一。LR AUC=0.567,RF AUC=0.800;RF 最佳观察点仅 precision=0.80/coverage=0.156,不存在 precision≥0.90 且 coverage≥0.20 的安全子集。因此不能靠“模型自报高置信”绕过逐谱精度问题。

## 1. 为什么需要这份基准

此前 M4 benchmark 的 gold 与 Audiveris 草稿逐字节相同(自比较),给出的 100% 不可采信。本基准用**独立 gold**:Bach Violin Dataset 的公版 MusicXML(与 Audiveris 无关)经 Verovio 渲染成谱面图,再让 Audiveris **盲识**,music21 逐音比对。指标为音高序列 precision / recall / F1(SequenceMatcher;不含节奏/时值评分)。

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
- **诊断联动**:凡 OMR 谱未经人工核对的小节,**禁用 extra-note/missing 硬判**(防漏音引发冤枉学生),只留音准/节奏。

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
