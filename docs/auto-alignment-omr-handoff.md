# 全自动攻坚交接(坎1/2/3)— 工程/数据线 → AAAI 线

> 本文是"工程/数据线"对话对自动识谱+对齐+技巧识别("全自动"梦想)攻坚的固化记录,
> 供 AAAI SI-HSM 论文对话读取。代码/数据/实验结果均在同一仓库,可直接复用。

## 目标与定调
- 目标:让系统"近乎完美全自动跑通"(长录音 → 自动识谱 → 自动对齐 → 自动诊断)。
- 三道坎:**坎1 读谱完整** → **坎2 音频↔谱面对齐** → **坎3 技巧识别**。依赖严格、按序。
- 诚实裁决:**坎1 可解;坎2 粗(页级)可自动、细(秒/音符级)被 rubato 卡住是研究级硬墙;坎3 靠数据。**
- "换模型不是第一步":坎1 是缓存污染(非 OMR 漏识),坎2 的墙是 rubato(非特征/非伴奏)。

## 坎1:读谱(OMR / 导入 / 缓存)
- **根因 = 陈旧缓存复用**,不是 Audiveris 漏识。炫动原始 pagewise MXL 有 10 页/181 小节,
  但 store 里只剩 67(指向已不存在的 `omr-page-result-cache/a28e….musicxml`)。
- **炫动已安全重建**:`score-mofx8cdb-sbrqgx` 从 33 sections/672 notes/67 measures →
  **106 sections/2720 notes/1-181 measures**(erhu 音符 1918,页 1-10)。scoreId 保留;
  原 store 已备份 `data/erhu-score-imports.json.bak-rebuild-*`;`musicxmlPath` 清空(根因指针)。
  重建源:`data/score-imports/scorejob-mofx7j7e-zjhare/pagewise/page-*/*.mxl`(同 PDF SHA-1 a8f2c1de…)。
  复建命令见 `ErhuAnalyzer._build_piece_pack_from_musicxml_sources`(python-service/analyzer_score_import.py)。
- **缓存闸门已修**:commit 327b797「Reject stale score-import cache when source MusicXML is missing」。
- **全库审计(只读)发现污染普遍**:~12 个谱面 `musicxmlPath` 失效(炫动同款信号),
  包括浮生(store maxMeasure 76)、第二号(118)、第四号(222)、维奥莱塔(446)、弦歌吟/雪山魂塑/
  古巷深处/流浪者/桃花等;另有一个"第二二胡狂想曲"是 1 section/16 notes 的损坏残桩。
  **结论:之前浮生/第二号的对齐实验也是在残谱上跑的,成绩不可全信。需逐个深审 + 定向重建。**
- **tempo/rubato 缺失**:原始 MXL 没有 tempo/words/散板/rit. 标记;store 一律默认 `tempo=72`(伪)。
  建议改为 `tempoKnown=false` / `tempoSource=missing|musicxml|ocr|manual`,rubato 允许人工补结构 JSON。

## 坎2:音频↔谱面对齐(带真值的实证)
- **真值** = 37 段人工锚点(浮生8/第二号18/炫动11),(audioStart,audioEnd)↔ 谱面页范围。
  小节编号两套不一致(OMR vs PDF),故**评测用页码**(两边都来自 PDF 页,可靠)。
- **新方法**:整曲一次性**全局单调 DTW**(score 音符序列 ↔ 整段音频),单调路径结构上**不会散布**。
  这推翻了旧"每段独立匹配→散布→不可行"的结论。
- **特征对比**(页码命中率):CREPE 音高 > CENS > chroma ≈ hpss。CREPE 最强。
- **CREPE 全局 DTW 结果(旧残谱上)**:炫动 0.82 / 第二号 0.56 / 浮生 0.63,**三首中位页误差 0**;
  但**中位时间误差 ~1/3–1 页**(13–32s),严格"对页+10s 内"**usable 仅 13–46%** → 达不到 teacher-ready。
- **负结果(关键)**:
  - **音源分离(SI-HSM extract_waveform)无助益**:炫动持平、浮生更差 → 瓶颈不是伴奏。
  - **补全谱面(炫动 67→181)反而更差**(0.82→0.36):flat-tempo 相对时值误差在散板段被放大;
    且暴露粗定位器对谱面细节**不稳健**。
  - **真瓶颈 = 速度/rubato + OMR 不输出 tempo**。失配集中在自由节奏段(开头散板、中段慢板)。
- **"rubato 边界再同步"想法(方向正确,未跑通)**:按锚点切区间、逐区间 DTW。
  我的钉点实现有 bug(钉越多越差,因页→列映射受 OMR 小节错乱影响),**待修**:
  钉点不能信 OMR raw measureIndex,要用 page + section range + 教师锚点映射。
  注意:rubato 边界来源目前只能是人工(OMR 给不出)→ 这是**半自动**。

## 坎3:技巧识别(尚未建模)
- 现有 37 段**段级**技巧标签(滑音/揉弦/颤音/装饰音/换把/弓法 + 置信度 + 不确定)。
- **标签粒度 = 段级存在性**;若要逐音检测需逐音标签或坎2 对齐。**段级分类器不依赖坎2,可并行起步。**
- 段级各类计数:换把36/揉弦36/弓法34/滑音31/颤音25/装饰音14(装饰音/颤音偏低,需补 + 双评)。
- 计划:轻量可解释判定器(LR/树/校准RF)+ 不确定输出;训练特征
  pitchSpreadCents/glideRunMs/vibratoAmplitude/stablePointCount/confidence(需训练专用导出)。

## 对 AAAI(SI-HSM)论文的价值
- SI-HSM 分离主指标(SDR)与 pitch-only 打平 → **最有效救法是下游任务证据**。
- 本线产出的 **37 段教师标签 = 下游诊断评测(Table 4 downstream F1)的真值**;
  对齐能力边界实证 = 动机(为何 score-informed / 人在环)。
- **能否提高 AAAI 命中率:能,但需(a)下游结果正向且有统计效力(37 偏小,需扩标+双评)
  (b)有机整合成一条叙事(分离→下游诊断更准),不能拼贴。**

## 实验脚本(本轮新建,scripts/experiments/)
- `align-global-dtw-experiment.py` — 全局单调 DTW + 特征(chroma/cens/hpss/crepe)+ 页码评测
- `anchor_eval.py` — 共享锚点评测(页命中/页范围重叠/时间误差/usable@N/页宽/闸门 sanity)
- `separate_piece.py` — SI-HSM `extract_waveform` 跑分离轨(供"分离前后"对比)
- `align_anchored_dtw.py` — 锚定/分段 DTW(钉点法,**有 bug 待修**)
- 结果 JSON:`data/experiments/content-alignment/`;分离轨:`data/experiments/stems/`(均 gitignored)

## 路线图(坎1→坎2→坎3)
1. **Phase 1 坎1**:深审全库污染谱 → 定向安全重建(已做炫动);缓存闸门补回归测试;tempo=unknown 字段(审 consumer)。
2. **Phase 2 坎2**(坎1 干净后):**重建坎2 基线**(旧成绩是残谱跑的);固化 CREPE 粗定位器;修钉点 bug;rubato 局部 tempo map(半自动)。
3. **Phase 3 坎3**(可与坎2 并行,段级版本):扩标(每类≥30 + 双评)+ 训练特征导出 + 轻量判定器。
