# 项目状态(AI 二胡教学分析原型)

> 快照,非自动更新。文中"测试通过/全绿"指**该次入库实验或回归当时**的结果,除非汇报时重新运行,否则不代表此刻重跑必然全绿。

## 一、目标
提升二胡演奏的识谱(OMR)+ 音频识别,做可靠教学诊断,并让教师标注闭环转起来产出研究数据。

## 二、最终成品(当前可用)
一条已验证的 **"人工锚点 → 教师结构化技巧标注 → 段级训练集导出"** 流水线(Plan C),配一套多层 teacher-ready 防御闸门,保证错配样本进不了教师后台/数据集。

```
slice-review-clips(切试听片段) → 填清单(支持页范围)
  → build-manual-anchor-pack(生成 teacher-ready 包)
  → 教师后台结构化标注(是否匹配 / 技巧多选 / 置信度;跨页段多页谱面)
  → export-manual-anchor-labels(段级训练集,自动排除 mismatch / 未纳入)
```
首批实证:浮生(为二胡与钢琴而作)8 段全部标完——全 match、技巧标签齐全(滑音/揉弦/颤音/装饰音/换把/弓法)、置信度 4-5,导出 8 行 0 排除。随后第二号狂想曲与炫动也完成教师标注,当前三包合计导出 37 段、0 跳过 / 0 mismatch / 0 排除。

论文侧当前能直接取用的是教师结构化标注数据、实验日志、对齐/闸门失败证据和导出数据集;最终论文表格与统计口径在论文整理环节另行定稿。

## 三、已完成
- **分析核心**:Tier1(crepe fmax / banded DTW / gap penalty)、Phase0 测量基准、OMR 缓存置信度修复、休止符 rest-cap 分段。
- **teacher-ready 闸门**(server + pack 时 .mjs + embedded 重判,三处同步,测试覆盖):scanMode 白名单、span/duration 双向比、窗口重叠、单调性(violationRate / greedyFallback)、覆盖率 / 最大间隙、manual-anchor 需显式 `manualAnchorConfirmed`,缺字段一律 fail-closed。
- **内容对齐实验**(金标 harness B1-B3 + span 惩罚 + 失败暴露诊断):含诚实负结果(见下)。
- **Plan C 全链路**:manual-anchor 模式、清单规范、生成器、切片工具、后台集成(含 manual-anchor readiness 豁免)、结构化字段(2a)、后台表单(2b)、导出(2c)、多页谱面、重建保留评审。
- **首批数据**:浮生 8 段、第二号狂想曲 18 段、炫动 11 段均已标注并导出,合计 37 段。最新导出在 `data/teacher-validation/technique-labeling-export/2026-06-24T10-55-04-081Z/`。
- **坎1 读谱清理**:store-vs-MXL 审计当前 0 个 `POLLUTED`;炫动、第二号、雪山魂塑、流浪者、古巷深处已按完整 MXL 重建,第二号残桩已从 store 删除(磁盘目录保留)。`guxiang_exac` 是 `mxl-empty` 后续清理项,不计作污染。
- **完整谱对齐基线**:CREPE/fmax=1400 已在完整谱上重跑。炫动是干净基线(10 页谱面与锚点页码 1-10 对齐):`pageHitRate=0.364, medianAbsTimeErr=32.8s`。第二号重建后 store 为 28 页,而当前 rhapsody-2 锚点只覆盖 1-16 页,属于谱面/录音范围不匹配的 confound(`pageHitRate=0.0, medianAbsTimeErr=234.1s`不作为干净负结果)。这说明旧残谱时代的对齐数字不再作为基准,坎2 需要在谱面范围匹配的数据上评估。

Plan C 主线代码已合并到 `main` 并 push;当前 bake-off / 坎1-2 后续实验在 `feature/model-bakeoff-omr-align` 上继续。

## 四、未完成 / 搁置(附原因)
| 项 | 状态 | 原因 |
|---|---|---|
| 长录音**自动**细段对齐 | 搁置(已知局限) | 读谱污染已清,但炫动完整谱 CREPE 干净基线仍不达 teacher-ready;第二号当前评测受谱面/录音范围不匹配影响,不能作为干净负结果;纯 chroma-DTW 散布,span 惩罚仅合成有效,onset / erhu-focus / 粗粒度在真实狂想曲上不稳定 → 证伪后转人工锚点 |
| rush/tempo_ratio、n6 滑音吞音 | 文档化局限 | 投入产出比低 |
| 扩样本 | 已达成首轮门槛:三曲 37 段已标注并导出,无空置信度 | 论文使用前需说明这些是段级技巧存在性标注 |
| 双评 / 仲裁 | 未做(约定缓做) | 提升标签可信度,排在样本量之后 |
| 轻量技巧判定器 | 未做 | 37 段已足够启动段级原型;音符级判定仍依赖更可靠的细段/逐音对齐 |

## 五、最关键的诚实结论
长录音"自动"对齐的结论已经从"完全不可行"修正为:**读谱污染可以清理,粗定位/外部基线可继续评测;但在谱面范围匹配的完整谱数据上,细段 teacher-ready 自动对齐仍未达标**。当前干净证据来自炫动;第二号的 0.0 结果受 28 页完整谱 vs 1-16 页锚点覆盖范围不一致影响,只作为方法警示,不作为对齐失败证据。项目据此保留自动对齐实验脚本作证据,**不接生产**;当前真正能产出可靠教师样本的路径仍是 **Plan C 人工锚点**。

## 六、当前数据状态
- **教师后台当前保留 `manual-anchor-fusheng`、`manual-anchor-rhapsody-2`、`manual-anchor-xuandong` 三个包;旧污染包已清理并有备份**(`data/erhu-study-records.json.bak-*`)。study store 曾清理旧 corpus 占位数据;当前教师数据以 manual-anchor pack/review JSON 为准。
- 浮生音频已入仓库 `data/real-tests/originals/fusheng-full.mp3`(gitignored)。
- 第二号狂想曲包 `manual-anchor-rhapsody-2`:18 段已标注。该批为整曲顺序覆盖、相邻约 5 秒重叠、部分跨 2-3 页/几十小节,适合做"该段出现哪些技巧"的存在性标注,不适合逐音级精标。
- 炫动包 `manual-anchor-xuandong`:11 段已标注,支持跨页多页谱面定位。
- 最新段级技巧标签导出: `data/teacher-validation/technique-labeling-export/2026-06-24T10-55-04-081Z/manual-anchor-labels.csv` 与 `.json`。导出统计:浮生 8、第二号 18、炫动 11;技巧标签计数为换把 37、揉弦 37、弓法 35、滑音 32、颤音 25、装饰音 14;置信度 5 分 18 段、4 分 14 段、3 分 4 段、1 分 1 段、空 0 段。

## 七、待决 / 下一步(优先级)
1. Basic Pitch 段级特征 / 轻量分类器 bake-off(段级标签可直接用 37 段,不依赖细段自动对齐)。
2. 双评 / 仲裁。
3. 轻量技巧判定器原型接入后台前的离线评估。
4. 继续扩曲目:古巷深处 / 雪山魂塑 / 弦歌吟等需补齐音频路径或人工锚点后再做。第四号样本已删除,不作为当前下一批。

待确认:浮生第 7 段(快板 m38-82)本轮从"排除"改为 `match` 并纳入——若为教师再判则保留,若为测试误改则训练前需再抽查。
