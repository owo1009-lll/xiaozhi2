# 西洋弦乐练习诊断项目状态快照

更新时间: 2026-07-09

本文件是当前主线状态快照。发布判断以实时命令为准:

- `npm run western:project-status`
- `npm run western:project-gate`
- `npm run test:western-project-gate`
- 对应子 gate / eval 命令

二胡产品线已经冻结为论文证据和困难案例材料。当前产品主线是西洋弓弦乐,先做小提琴,大提琴后续独立验证。

## 1. 当前目标

构建西洋弓弦乐练习诊断系统:

- 输入: clean score + audio,后续可接 PDF/图片 OMR,但 OMR 必须先过 M4 独立 gold 闸门。
- 输出: 高置信音准 / 起音 / 漏音等基础诊断;低置信或未验证类别进入复核。
- 原则: validation-first, fail-closed,人工复核回流;未过 gate 的能力不得对学生硬反馈。

## 2. 当前运行时安全态

当前 `npm run western:project-status` 报告:

- `ordinaryUploadAutoFeedbackReady=false`
- `m3plusAutoFeedbackReady=false`
- `m4OmrAutoScoreReady=false`
- `policy=fail-closed`

也就是说,学生端默认仍不会收到未经明确放行的自动硬反馈。

## 3. 已验证成果

### M2/M3 core 诊断链路

已完成:

- clean score + audio 的受控上传;
- 离线 batch;
- 候选特征生成;
- 人工复核;
- 置信模型 pilot;
- fresh blind validation;
- runtime scorer 接入;
- 默认 fail-closed。

普通上传 confidence gate 当前状态:

- 旧 release 不能默认开启。
- fresh validation: precision=0.90,coverage=1.0。
- threshold-pool precision 已通过当前 release audit。
- frozen RF scorer 已可在显式 flag 下调用。
- 运行时仍默认关闭,阻塞原因是 `ordinary-auto-gate-disabled-by-default`。

下一步不是继续复核旧包,而是在单独受控进程里做 monitored pilot。不得提交或默认设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1`。

### M3+ 音高行为模式

用途:不展示技巧名,只为了在特殊音高行为区域把音准判对:

- slide-like:滑音类区域使用起止/轨迹判法;
- trill-like:颤音类区域使用双目标判法;
- stable:对照模式;
- variable-f0 / double-stop / ornament 等仍需要更多证据或保持复核。

当前证据:

- M3+ 复核累计:98 reviewed rows,74 scored rows。
- `npm run western:m3plus-review-status`:无 reviewed/scored deficit。
- `npm run western:m3plus-mode-eval`: `m3plusModeReleaseReady=true`。
- 离线 release-ready modes: `slide-like`, `trill-like`。
- control-ready mode: `stable`。

范围限制:

- 这个结论只覆盖一小节安全子集:第一小节、可信录音、无谱面-音频错位的候选。
- 不能外推到后续小节、线性时间窗漂移区域、未验证录音或所有技巧区域。
- 学生端 M3+ 自动反馈仍关闭: `m3plusAutoFeedbackReady=false`。

下一步如果继续 M3+:

- 不再要求继续复核当前包。
- 只能设计一个单独 monitored pilot,范围限定为 first-measure + trusted-recording + `slide-like`/`trill-like`。
- 默认运行时继续 fail-closed。

### M4 OMR benchmark

当前状态:

- 12 条图片谱面 + clean score pair 已齐备。
- Audiveris 草稿可解析。
- 但当前 benchmark 仍是 self-comparison: clean score 与 draft/gold 同源,不能作为独立 gold。
- `usableBenchmarkRows=0`,不能声明 OMR 准确率。

下一步:

- 打开 `data/experiments/western-strings-m4/independent-gold-todo.html`;
- 生成 independent-gold workspace;
- 人工对照原谱修正 workspace MXL;
- apply 后重跑 `npm run western:m4-omr-benchmark`。

## 4. 当前优先级

### P1: 普通上传 monitored pilot

当前证据已经足够进入受控试点设计,但不能默认开启。

入口:

- evidence: `data/experiments/western-strings-m3/confidence-validation-review/ordinary-confidence-release-audit.json`
- plan: `npm run western:ordinary-monitored-pilot-plan`
- smoke: `npm run western:ordinary-monitored-pilot-smoke`
- status: `npm run western:project-status`
- guard: `npm run test:western-project-gate`

要求:

- 只在单独受控进程里显式设置 `WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1`;
- 不提交开启状态;
- 监控 precision / unsafe false-positive / rejected rows;
- pilot 通过前不进入默认学生端。

### P2: M3+ slide/trill 受控试点

当前离线证据已通过,但范围很窄。

入口:

- `data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.json`
- `data/experiments/western-strings-m3plus/pitch-mode-review-pack/m3plus-pitch-mode-eval.csv`

要求:

- 只允许 `slide-like` 与 `trill-like`;
- 只允许 first-measure + trusted-recording 条件;
- 不允许 broad M3+ runtime;
- 不允许展示技巧名;
- 目标是减少音准误判/少退复核,不是做技巧识别产品。

### P3: M4 独立 gold

当前 OMR 不能声称通过,因为 benchmark 仍是 self-comparison。

入口:

- `data/experiments/western-strings-m4/independent-gold-todo.html`

要求:

- 先做独立 gold;
- 再跑 benchmark;
- note-level OMR 准确率达标前,PDF/图片识谱不得直接进入判断层。

## 5. 当前不可声称

- 不可声称任意普通上传音频已经默认实时自动诊断。
- 不可声称 M3+ 已可广泛对学生端开放。
- 不可声称 M3+ 是技巧名称识别系统。
- 不可声称 OMR 准确率已通过。
- 不可声称支持大提琴;大提琴需要 M5 独立验证。

## 6. 已完成验证命令

最近确认通过:

- `npm run western:m3plus-review-status`
- `npm run western:m3plus-mode-eval`
- `npm run western:project-status`
- `npm run test:western-project-gate`
- `npm run build`

## 7. 二胡线定位

二胡内容不再作为当前产品入口。保留范围:

- 论文证据;
- 能力边界和困难案例;
- manual-anchor 教师标注数据;
- 西洋弦乐主线仍依赖的共享模块、脚本和数据结构。

不要把二胡长曲自动对齐、二胡技巧分类或二胡 teacher pack 当作当前西洋弦乐 release 证据。
