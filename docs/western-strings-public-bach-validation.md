# 公开 Bach 小提琴语料验证报告

更新时间: 2026-07-10

## 1. 决策

由于当前无法持续获得大量真实学生录音, 项目允许把公开专业小提琴录音作为主要开发集、跨演奏者验证集和原始波形压力测试集。

该决策解决的是开发与研究证据不足, **不等于**公开专业录音可以证明学生域发布安全。系统继续保持四态输出和 fail-closed:

- 已验证的高置信核心结果可以进入公开专业录音 V2-alpha 原型。
- 弱音、额外音和未验证场景进入 `review_required`。
- 默认学生端发布仍关闭。
- 不使用“完美对齐”或“完美识别”描述当前结果。

## 2. 数据与分组

本地公开 Bach 独奏小提琴语料审计结果:

- 65 个可评测乐章。
- 9 名小提琴演奏者。
- 6 部 BWV 作品。
- 58,765 条参考音符记录, 其中 15,513 条为双音音符。
- 约 3.83 小时录音。
- development:31 个 Emil Telmányi 演奏乐章。
- unseen-performer holdout:34 个其他演奏者乐章。

上游数据说明与元数据来源: `https://github.com/salu133445/bach-violin-dataset`。本地录音许可包含 Public Domain、CC BY、CC BY-NC 和 CC BY-NC-ND;当前只作本地研究评测,不把受限音频提交仓库或重新分发。

参考音符时间来自数据集的 CQT-DTW 估计,不是逐音人工 gold。报告、论文和产品文案必须保留这一限定。

## 3. 对齐结果

Parangonar + Basic Pitch 在 unseen-performer holdout 上:

- coverage:95.08%。
- 预测中的 300ms 内 precision:92.81%。
- 全部 gold 音符 hit@300ms:88.25%。
- onset 误差中位数:35.4ms。
- onset 误差 p90:215.5ms。

按 development 选择并冻结双音共享起音规则后, development 与 unseen-performer holdout 均达到 Green。该结果支持“公开专业独奏 + clean score”范围内的高置信对齐,不支持学生域默认发布。

## 4. 独立音符识别结果

Basic Pitch 不经筛选时在 holdout 上:

- precision:75.96%。
- recall:89.79%。
- F1:82.30%。

仅在 development 上选择事件过滤阈值后,冻结到 holdout:

- precision:90.50%。
- recall:77.67%。
- F1:83.60%。

因此存在 V2-alpha 高精度子集,但尚未达到全覆盖或近乎完美识别。

## 5. 原始波形错误压力测试

### 5.1 注入方式

在真实公开专业录音波形中注入四类错误,然后重新运行 Basic Pitch:

- 漏音。
- 弱音:目标音衰减 94%。
- 错音:目标音升高 2 个半音。
- 迟到:目标音延后 800ms。

rawv2 注入窗使用“估计参考音符区间与干净录音中目标 Basic Pitch 事件区间的并集”。该修正避免参考时间偏差留下未删除的实际音头。

严格策略固定为:

- 目标同音高事件必须落在预测起音 10ms 内。
- 目标事件置信度至少 0.40。
- 同音高 score/event 必须一对一,隔离窗 300ms。
- 当前音及前后各 2 个音必须在 300ms 邻域内有音频事件支持。

### 5.2 Development

- 48 个注入目标,45 个满足干净严格策略。
- 干净 precision:98.28%。
- 干净 coverage:35.10%。
- 漏音危险放行:0。
- 错音危险放行:0。
- 迟到危险放行:0。
- 弱音危险放行:5/48。

### 5.3 Unseen-performer holdout

- 48 个注入目标,42 个满足干净严格策略。
- 干净 precision:97.59%。
- 干净 coverage:33.05%。
- 漏音危险放行:0。
- 错音危险放行:0。
- 迟到危险放行:0。
- 弱音危险放行:12/48。

结论:公开专业录音上的漏音、错音和 800ms 迟到原始波形原型闸门通过;弱音自动闸门不通过。

## 6. 弱音模型 bake-off

模型只使用单条录音自身可获得的相对能量、局部上下文、Basic Pitch 事件置信度/时长/起音差;不比较干净原音和变体。

所有模型只在 development 拟合并选择零危险阈值,再冻结到 holdout:

| 模型 | holdout 干净保留 | holdout 弱音危险放行 |
|---|---:|---:|
| Logistic Regression | 36/42 | 4/12 |
| Random Forest | 35/42 | 3/12 |
| Extra Trees | 34/42 | 4/12 |
| HistGradientBoosting | 41/42 | 12/12 |
| RBF-SVM | 35/42 | 3/12 |

没有模型达到零危险放行。弱音必须保持 `review_required`;继续在同一批数据上调参会形成 holdout 泄漏,因此停止。

## 7. 当前闸门

`npm run western:bach-violin-v2-audit` 当前应报告:

- `publicProfessionalV2AlphaReady=true`
- `publicEventV3PrototypeReady=true`
- `publicRawAudioCorePrototypeReady=true`
- `publicWeakNotePrototypeReady=false`
- `rawAudioV3Ready=false`
- `v3Ready=false`
- `nearPerfectReady=false`
- `defaultStudentReleaseEligible=false`

## 8. 可复跑命令

```bash
npm run western:bach-violin-dataset-audit
npm run western:bach-violin-parangonar-full
npm run western:bach-violin-chord-timing
npm run western:bach-violin-basic-pitch-transcription
npm run western:bach-violin-error-perturbations
npm run western:bach-violin-raw-audio-perturbations-development
npm run western:bach-violin-raw-audio-perturbations
npm run western:bach-violin-weak-note-gate
npm run western:bach-violin-v2-audit
```

原始波形命令默认要求 `core` 闸门通过;如需验证四类全部自动放行,追加 `-- --required-gate all`,当前会因弱音未通过而非零退出。`western:bach-violin-weak-note-gate` 当前同样应非零退出,这是已记录的安全阻断,不是脚本故障。

原始公开音频与生成变体位于 gitignored `data/`/本地语料目录,不提交到仓库。

## 9. “完美”的可检验定义

只有同时满足下列条件,才可讨论近乎完美,且仍不应使用绝对“完美”:

- 独立人工逐音 gold,而不是算法估计时间。
- 跨作品、跨演奏者、跨录音设备的最终盲测。
- 对齐 precision 与 coverage 均至少 99%。
- 音符识别 precision 与 recall 均至少 99%。
- 每个自动诊断类别都通过原始波形和真实演奏错误测试。
- 任何未覆盖或低置信样本稳定进入复核,无危险硬反馈。

当前公开语料已经把系统推进到“公开专业录音 V2-alpha + 核心错误原型”,尚未达到上述条件。
