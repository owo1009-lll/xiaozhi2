# 项目状态(西洋弦乐练习诊断主线)

> 快照,非自动更新。这里记录当前产品主线状态;二胡线已冻结为论文证据/困难案例,不再作为默认产品入口。每次发布判断仍以 `npm run western:project-status`、`npm run western:project-gate` 和对应子 gate 的实时输出为准。

## 一、当前目标

构建一个以小提琴为优先对象的西洋弓弦乐练习诊断系统:输入 clean score + 音频,在高置信片段自动给出音准 / 起音 / 漏音等基础诊断,低置信或未验证类别全部进入复核。PDF/图片谱面 OMR 已纳入路线,但必须先通过 M4 独立 gold 精度闸门,不得直接进入判断层。

核心原则不变:validation-first、fail-closed、人工复核回流、任何未过 gate 的能力不得对学生硬反馈。

## 二、当前可用成果

- **M2/M3 core 诊断链路**:clean score + audio 的受控上传、离线 batch、候选特征生成、人工复核、置信模型 pilot、fresh blind validation 与 runtime scorer 已接入。
- **普通上传置信 gate**:RF threshold=0.7 的 release artifact 已冻结在 `models/western-strings/ordinary-upload-confidence-rf-v1/release.json`;fresh validation 30 条通过当前 floor(precision=0.90, coverage=1.0)。运行时默认仍关闭,保持当前安全态。若后续要验证,先确认普通上传特征提取与冻结 RF scorer 走同一 runtime 路径,并排查 pilot(coverage=0.5333 / precision=0.9375)与 fresh validation(coverage=1.0 / precision=0.90)的操作点漂移;只允许在受控 pilot 进程里显式设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1`。
- **M3+ 音高行为复核包**:已生成 48 条本地复核页,6 类各 8 条,用于判断揉弦/滑音/颤音/装饰音/双音/不稳定音高等区域是否能安全判音准。页面已中文化并带快捷按钮,但尚未完成标签导入。
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
| M2/M3 ordinary upload candidate gate | 模型与 runtime scorer 已接线,默认关闭 | `ordinary-auto-gate-disabled-by-default`;保持默认关闭,先做受控 pilot 前置检查与操作点漂移排查 | `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1` 仅限受控 pilot |
| M3+ pitch behavior modes | 48 条复核包已生成 | 缺人工标签、缺 completed CSV、每类 reviewed/scored 不足 | `data/experiments/western-strings-m3plus/pitch-mode-review-pack/index.html` |
| M4 OMR benchmark | 数据集前置齐备,草稿可解析 | 缺独立 gold;当前 12/12 为 self-comparison | `data/experiments/western-strings-m4/independent-gold-todo.md` |

## 四、已完成且有验证的事项

- M0/M1:小提琴数据接入、clean score/MIDI/MusicXML 入口、基础 dataset adapter。
- M2f/M3 core:真实学生式录音 core gate 已通过;当前硬反馈范围只包括 pitch / onset / missing。duration 与 extra-note/多音仍 review-only。
- 普通上传候选复核:累计 60 条 usable/wrong 标签;初始规则不足以 release,随后训练置信模型并通过 30 条 fresh blind validation。
- runtime scorer:普通上传候选可通过 `western:controlled-candidate-confidence-score` 打分;无 release flag 时仍 review-only。
- M3+ pack:`npm run western:m3plus-review-pack` 可生成 48 条人工复核包;`npm run western:m3plus-review-status` 可报告标签缺口。
- M4 handoff:`npm run western:m4-independent-gold-todo` 生成中文独立 gold 校正清单,列出 `sourceScorePath`、当前 `goldPath`、Audiveris `draftPath`、`scoreId` 与音符数。
- 项目级 gate:`npm run western:project-gate` 仍应非零退出,防止在 ordinary/M3+/M4 任一轨未 ready 时误发布。

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

1. **普通上传受控 pilot 前置**:普通上传 confidence gate 已满足当前 validation floor,但默认继续关闭。若要验证,先确认特征提取与冻结 RF scorer 已接在同一 runtime 路径,并解释 pilot 53% 覆盖/93.75% precision 与 fresh validation 100% 覆盖/90% precision 的操作点差异;然后只在受控 pilot 进程中设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1`,并重新跑项目 gate / build / 相关 route smoke。未完成前继续 fail-closed。
2. **M3+ 人工复核**:打开 `data/experiments/western-strings-m3plus/pitch-mode-review-pack/index.html`,完成 48 条标签,下载 `m3plus-pitch-mode-review.completed.csv`,然后运行 `npm run western:m3plus-review-import -- --reviews <completed.csv>` 和 `npm run western:m3plus-review-status`。
3. **M4 独立 gold**:按 `data/experiments/western-strings-m4/independent-gold-todo.md` 逐条对照原谱生成独立 gold MusicXML/MXL,更新 clean-score intake 后重跑 `npm run western:m4-omr-benchmark`。
4. **后续扩展**:extra-note/多音和 duration 若要开放学生端硬反馈,必须补专门样本并通过独立 gate;大提琴作为 M5 独立验证,不得复用小提琴阈值。

## 七、当前不可声称

- 不可声称任意普通上传音频已经默认实时自动诊断;默认仍 fail-closed。
- 不可声称 M3+ 技法区音准已达标;目前只是复核包准备好。
- 不可声称 OMR 准确率已通过;当前 benchmark 仍是 self-comparison,usable rows 为 0。
- 不可声称支持大提琴;架构预留,但未独立 M0/M5 验证。
