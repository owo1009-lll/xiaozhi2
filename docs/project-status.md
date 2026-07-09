# 项目状态(西洋弦乐练习诊断主线)

> 快照,非自动更新。这里记录当前产品主线状态;二胡线已冻结为论文证据/困难案例,不再作为默认产品入口。每次发布判断仍以 `npm run western:project-status`、`npm run western:project-gate` 和对应子 gate 的实时输出为准。

## 一、当前目标

构建一个以小提琴为优先对象的西洋弓弦乐练习诊断系统:输入 clean score + 音频,在高置信片段自动给出音准 / 起音 / 漏音等基础诊断,低置信或未验证类别全部进入复核。PDF/图片谱面 OMR 已纳入路线,但必须先通过 M4 独立 gold 精度闸门,不得直接进入判断层。

核心原则不变:validation-first、fail-closed、人工复核回流、任何未过 gate 的能力不得对学生硬反馈。

## 二、当前可用成果

- **M2/M3 core 诊断链路**:clean score + audio 的受控上传、离线 batch、候选特征生成、人工复核、置信模型 pilot、fresh blind validation 与 runtime scorer 已接入。
- **普通上传置信 gate**:旧 RF threshold=0.7 release artifact 已接线但不得放行;fresh validation 30 条虽达 precision=0.90,完整阈值池 60 条分层复核失败(selected precision=0.5556,20 usable / 16 wrong),且简单阈值诊断无 selected≥10 且 precision≥0.90 的补救规则。重校准标签集已合并 120 行(119 scored),eval-only RF threshold=0.9 在留一录音评估中形成候选(precision=0.9355,coverage=0.2605),并已导出 10 行 recalibration blind-validation 包。运行时默认仍关闭;下一步是复核这 10 行,通过前不得进入受控 pilot。
- **M3+ 音高行为复核包**:第一轮 48 条 + 第二轮 36 条已累计导入,共 84 reviewed / 60 scored,用于判断揉弦/滑音/颤音/装饰音/双音/不稳定音高等区域是否能安全判音准。离线 per-mode 评估已运行:只有 `stable` control 模式证据通过;非 control 的 pitch-behavior 模式没有任何 release-ready 项。当前 M3+ 复核还暴露了定位质量问题:84 条里 60 match / 19 mismatch / 5 uncertain-or-other,约三成谱面-录音定位不可直接信任,因此**学生端 M3+ 自动反馈仍保持关闭**。
- **M4 OMR benchmark 前置**:12 条图片谱面 + clean score pair 已齐备,Audiveris 草稿均可解析;但当前 clean score 与草稿完全同 SHA-1,属于 self-comparison,所以 OMR 准确率仍不能声明。独立 gold 校正清单已生成。

## 三、当前实时状态(2026-07-09)

实时命令 `npm run western:project-status` 当前应显示:

- `ordinaryUploadAutoFeedbackReady=false`
- `m3plusAutoFeedbackReady=false`
- `m4OmrAutoScoreReady=false`
- `policy=fail-closed`

主要阻塞:

| 轨道 | 当前状态 | 阻塞原因 | 入口 |
|---|---|---|---|
| M2/M3 ordinary upload candidate gate | 旧 release 失败;重校准标签集 120 行已生成,RF threshold=0.9 产生 10 行 recalibration blind-validation 包 | `ordinary-auto-gate-disabled-by-default`,`ordinary-confidence-threshold-pool-precision-too-low`,`ordinary-confidence-recalibration-validation-needed`;先复核 10 行新包 | `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1` 不得用于学生端 |
| M3+ pitch behavior modes | 84 条累计复核已导入并完成 per-mode eval | `m3plus-no-mode-specific-release-ready`;stable 仅为 control,非 control 模式继续 review-only;定位 mismatch/uncertain 较高 | `data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.csv` |
| M4 OMR benchmark | 数据集前置齐备,草稿可解析 | 缺独立 gold;当前 12/12 为 self-comparison | `data/experiments/western-strings-m4/independent-gold-todo.html` |

## 四、已完成且有验证的事项

- M0/M1:小提琴数据接入、clean score/MIDI/MusicXML 入口、基础 dataset adapter。
- M2f/M3 core:真实学生式录音 core gate 已通过;当前硬反馈范围只包括 pitch / onset / missing。duration 与 extra-note/多音仍 review-only。
- 普通上传候选复核:累计 60 条 usable/wrong 标签;初始规则不足以 release,随后训练置信模型并通过 30 条 fresh blind validation。
- runtime scorer:普通上传候选可通过 `western:controlled-candidate-confidence-score` 打分;runtime batch smoke 已验证显式 flag 下会调用冻结 RF scorer 并写入 `confidenceProbability`;无 release flag 时仍 review-only。
- M3+ pack:`npm run western:m3plus-review-pack` 生成的 48 条和第二轮 36 条已累计导入;`npm run western:m3plus-review-status` 当前报告 `m3plusModeEvalReady=true`,累计 84 reviewed / 60 scored;`npm run western:m3plus-mode-eval` 当前报告 `m3plusModeReleaseReady=false`,`controlReadyModes=["stable"]`,`releaseReadyModes=[]`。第二轮没有放行任何非 control 模式,同时暴露较高谱面-录音定位 mismatch/uncertain,下一步应先改候选/定位质量,不是继续复用同一包。
- M4 handoff:`npm run western:m4-independent-gold-todo` 生成中文独立 gold 校正清单,其中 `independent-gold-todo.html` 是可视化入口,同时保留 `.md/.csv`;清单列出 `sourceScorePath`、当前 `goldPath`、Audiveris `draftPath`、`scoreId` 与音符数。
- 项目级 gate:`npm run western:project-gate` 仍应非零退出,防止在 ordinary/M3+/M4 任一 release 轨未 ready 时误发布;M3+ 标签状态已过,但 per-mode eval 未发现可 release 的非 control 模式。

已复核命令:

- `npm run test:western-project-gate`
- `npm run western:project-status`
- `npm run western:m3plus-review-pack`
- `npm run western:m3plus-review-status`
- `npm run western:m4-independent-gold-todo`

## 五、二胡线当前定位

二胡项目不再作为当前产品入口。保留内容仅限:

- 论文证据和能力边界材料;
- manual-anchor 教师标注数据;
- 西洋弦乐主线仍依赖的共享模块、脚本、数据结构。

不要把二胡长曲自动对齐、二胡技巧分类或二胡 teacher pack 当作当前西洋弦乐 release 证据。

## 六、下一步优先级

1. **普通上传 confidence 重校准盲测**:普通上传旧 confidence gate 的 30 条预筛 validation 通过,但完整阈值池分层复核失败(selected precision=0.5556,coverage=0.6102)。诊断报告 `data/experiments/western-strings-m3/confidence-threshold-pool-review/confidence-threshold-pool-diagnosis.json` 显示最佳简单规则 `predictedUsableProbability>=0.95` 也只有 precision=0.857(selected=14),没有 selected≥10 且 precision≥0.90 的简单规则。已把旧 60 行 + threshold-pool 60 行合并为 `data/experiments/western-strings-m3/confidence-recalibration/combined-controlled-candidate-review-labels.csv`,重校准 pilot 产生 RF threshold=0.9 候选,并导出 `data/experiments/western-strings-m3/confidence-recalibration-validation-review/index.html` 供 10 行盲测。下一步先复核这 10 行并运行 `npm run western:controlled-candidate-confidence-recalibration-validation-eval`;通过前继续 fail-closed。
   - 若 CSV 下载到了 Downloads,可先运行 `npm run western:ingest-review-downloads -- --apply` 自动匹配并复制到正确目标目录;脚本会拒绝旧包或行号不匹配的 CSV。
2. **M3+ 定位/候选质量修复**:第二轮补强复核已经导入并评估,但 slide/trill/ornament/double-stop/variable-f0 等非 control 模式仍没有 release-ready 证据。当前不是继续标同一包,而是先查看 `data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.csv`,把谱面-录音定位不准作为候选质量问题处理;改候选/定位后再生成新的 targeted eval pack。
3. **M4 独立 gold**:打开 `data/experiments/western-strings-m4/independent-gold-todo.html`,逐条对照原谱生成独立 gold MusicXML/MXL,更新 clean-score intake 后重跑 `npm run western:m4-omr-benchmark`。
4. **后续扩展**:extra-note/多音和 duration 若要开放学生端硬反馈,必须补专门样本并通过独立 gate;大提琴作为 M5 独立验证,不得复用小提琴阈值。

## 七、当前不可声称

- 不可声称任意普通上传音频已经默认实时自动诊断;默认仍 fail-closed。
- 不可声称 M3+ 技法区音准已达标;当前 per-mode eval 只证明 stable control 可作为对照,没有任何非 control pitch-behavior 模式可开放。
- 不可声称 OMR 准确率已通过;当前 benchmark 仍是 self-comparison,usable rows 为 0。
- 不可声称支持大提琴;架构预留,但未独立 M0/M5 验证。
# 2026-07-09 最新执行结论(覆盖下文旧状态)

- **P1 普通上传 confidence 重校准盲测已补强并通过精度闸,但运行时仍默认关闭**: 最新 30 行 context-validation 已导入,`western:project-status` 报 validation precision=0.90 / coverage=1.0。普通上传自动 gate 仍按安全策略 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE` 默认关闭;下一步只能做受控 pilot,不能默认给学生端放行。
- **M3+ 第二轮已完成,但定位/候选质量是 blocker**:累计 84 reviewed / 60 scored;per-mode eval 仍无任何非 control release-ready 模式。新增 `npm run western:m3plus-localization-diagnosis`,当前诊断为 60 match / 19 mismatch / 5 uncertain,即 24/84 non-match(28.57%)。最高风险组是 `stu02-ex05-weak_onset`(9/9 mismatch)。下一步先看 `data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-localization-diagnosis-groups.csv` 和 rows CSV,修谱面-录音定位/候选生成,不要继续复用同一复核包。
- **当前优先级**:1) P1 失败行分析与 confidence 特征/模型重校准;2) M3+ 定位/候选质量修复;3) M4 独立 gold。学生端仍全部 fail-closed。
# 2026-07-09 P1.1 context validation update

- **P1 普通上传 confidence 重校准盲测已补强并通过精度闸,但运行时仍默认关闭**: 最新 30 行 context-validation 已导入,`western:project-status` 报 validation precision=0.90 / coverage=1.0。普通上传自动 gate 仍按安全策略 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE` 默认关闭;下一步只能做受控 pilot,不能默认给学生端放行。
- The failure is preserved as evidence at `data/experiments/western-strings-m3/confidence-recalibration-validation-review/confidence-recalibration-failure-diagnosis.json`.
- P1.1 context-feature validation has been imported and passed the precision floor; no more P1.1 review is currently requested.
- Do not review the old 10-row P1 pack again; ordinary-upload auto feedback remains disabled by default until a separate monitored pilot is explicitly started.

# 2026-07-09 M3+ candidate-quality review update

- M3+ localization diagnosis shows `stu02-ex05-weak_onset` is a recording-level bad source for M3+ review: 9/9 rows are mismatch.
- The candidate-quality review pack at `data/experiments/western-strings-m3plus/pitch-mode-review-pack-candidate-quality/index.html` is now restricted to recordings whose prior M3+ review rows were all audio-score matches, and excludes already-reviewed rows. This is stricter than only excluding the single 100% non-match recording.
- The pack has 24 rows: variable-f0 6, slide-like 6, trill-like 6, double-stop-candidate 6, ornament-candidate 0 because no unreviewed ornament candidates remain after exclusions. It is evidence collection only; M3+ remains review-only.
