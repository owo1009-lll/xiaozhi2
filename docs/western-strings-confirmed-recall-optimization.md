# Ordinary 确诊召回优化记录（2026-07-22）

当前严格确诊仍为 **2/12**。Policy C 的两层教师复核候选为 6/12，但其中 4 条是 `self_check_hint`，不能改写成机器确诊。

## 本轮可复跑结果

| 候选 | 开发/合成证据 | 独立或真实证据 | 裁决 |
|---|---|---|---|
| 合并替代音结构规则 | round4 新增命中 1 个 wrong，0/253 非故意位置 | 13 套外部集合 0 个独立正例 | 只作 development pre-gate；严格口径不从 2/12 晋升 |
| relative-IOI + duration 合取 | r2-01 开发 P/R=95.45%/77.78%；r2-08 holdout 同为 95.45%/77.78% | 完整 round4 P/R=50.00%/66.67% | 合成到真实域迁移失败 |
| IOI + 时值 + 置信度 + operation-path 结构合取 | 注入 calibration P/R=94.74%/66.67%；曲目 holdout P/R=100%/55.56% | 已查看 round4 P/R=100%/66.67%（drag 3/3、extra 1/3）；自然正确录音 5/285 提示，负担 1.75% | 仅冻结为 Round 5 `self_check_hint` 候选；形成于查看旧证据后，不占晋升分母 |
| 高置信节奏结构合取（时值比提高到已有冻结值 1.30） | calibration 18/27、holdout 14/27，均 0 FP | 已查看 round4 4/6、0 FP；自然正确录音 0/285；专业长曲 13/2301 未裁决候选 | 冻结为 `issue_detected_candidate` 预闸；正式确诊仍为 2/12，必须由全新 fresh-blind 晋升 |
| gap 精炼 + recording 对齐健康守卫 | missing calibration/holdout 均 10/15、0 strict FP | round4 3/3 missing + 1 个真实 wrong、0/253；自然正确 0/285；两段专业长曲均因全局对齐不健康而回退 | 冻结为 missing-targeted `issue_detected_candidate`；595 个长曲原始提示不会升级为指控 |
| 通用波形 onset 峰计数 | 150 组参数均未过 P>=90%/R>=50%；开发最优 42.11%/53.33% | 合成 holdout 22.73%/33.33% | 止损，不再继续扫通用峰值参数 |

复跑命令：

```powershell
npm run western:merged-substitution-candidate
npm run test:western-merged-substitution-candidate
npm run western:segment-onset-candidate
npm run test:western-segment-onset-candidate
```

生成报告位于 gitignored 实验区：

- `data/experiments/western-strings-round4/merged-substitution-candidate/report.json`
- `data/experiments/western-strings-round4/segment-onset-candidate/report.json`

## 下一条可行路线

下一候选不再使用“任意波形起音峰”，而改为音高条件化的重复起弓/插入删除 edit-path：只在同一目标音高持续成立时寻找第二次攻击，并把相邻谱音、事件持续时长、assignment gap 和单声部约束放进同一个结构评分。验收仍按两级执行：

1. 现有集合只做开发和负例压力测试；
2. 至少取得独立正例，并在全新 position-labelled fresh-blind 包上达到冻结的 precision>=90%、recall>=50%，才允许进入教师复核候选；学生自动指控仍需另行发布授权。

## 进一步归因结果

在通用 onset 失败后，又按同一 r2-01 development / r2-08 holdout 纪律检查了三种轻量 extra-note 候选：

| 候选 | development P/R | holdout P/R | 结论 |
|---|---:|---:|---|
| onset 峰 + 同音高事件覆盖 | 50.00% / 53.33% | 21.05% / 26.67% | 无联合过门点 |
| 未分配同音高事件 edit-path | 14.29% / 6.67% | 40.00% / 26.67% | 插入事件多被一对一对齐吸收，未留在 unassigned 集合 |
| 窗内内部攻击比 | 24.00% / 80.00% | 36.67% / 73.33% | 召回高但普通弓段内部峰导致大量误报 |

Policy C 的 assignment gap 也补做了直接波形归因：

- RMS 缺失在合成 development/holdout 为 P/R=100%/73.33%、100%/60.00%，但选择阈值约 `-134.83dB`，说明只识别了数字静音；真实 round4 漏音召回 0/3。
- pYIN 目标音高占用率在合成为 P/R=100%/73.33%、100%/80.00%，round4 为 42.86%/100%：3 个真实漏音和另外 4 个 authoritative assignment gaps 都没有目标音高帧，不能区分漏音、错音、滑音或对齐失败。

因此当前不再追加单阈值或单一手工特征。下一轮数据必须直接覆盖真实混淆对，模型单位改为连续片段上的插入/删除/替代 edit-path。

Round 5 intake 已接入总项目状态并做实时哈希绑定。2026-07-23 当前 `ready=true`、`bindingCurrent=true`：12 条录音、144 个完整签署事件、2 人/3 设备/2 房间及四类分母均通过。另以 `npm run western:round5-audio-score-identity` 做了不读取真值标签和 gate 结果的音频—乐谱身份审计；12/12 均匹配当前同名冻结谱，全局一对一分配也是 12/12 原位，因此 cal/fresh 没有反置。

片段模型入口也已落地：`western:round5-segment-edit-path` 只消费通过 intake 的 calibration/fresh-blind 分割，按 merged-substitution/missing/extra/drag 四个子闸分别训练固定随机森林，并以连续五音的局部 edit-path 证据评测。2026-07-23 首跑的原始数字只有 `extra` 达到 `3/6 @ 0/12 confusion FP`、P/R=`100%/50%`；但后续谱面位置平衡审计证明 fresh-extra 的 6 正/12 负可由前一音程单特征完全分开，而模型含该静态特征，所以这个数值通过不具晋升效力。状态现区分 `numericallyPromotedGates=["extra"]` 与有效 `promotedGates=[]`；`reviewAssistPromotionReady=false`，学生端、自动指控与生产采纳仍全部为 false。

同一审计的 v2 又把节奏目标与每条录音的全部谱音负例比较。虽然冻结 soft/strict 节奏合取原始结果为 `4/12 @ 0/312 FP`，静态谱面上下文随机森林却能在 calibration 和 fresh 各自的留一录音中达到 `12/12 @ 0/324 FP`。这说明固定 extra/drag 槽位本身可被书面时值、拍位、相邻音程和归一化位置识别；原始数字可保留为诊断，却不能证明演奏识别 precision 泛化。下一轮必须让相同谱面结构在不同录音中轮换为 extra、drag 和正常角色，且在录音前通过全谱位置预检。

该下一轮现已落成 `western-round6-counterbalanced-diagnosis-v1` 候选包。每份谱录三次，同一位置在三次中恰好轮换为 1 次正例和 2 次混淆负例；calibration 与 fresh 各使用两份独立新谱及不重叠演奏者占位。12 槽、144 事件和四类分母已生成，v2 录前预检为全绿；这只说明**最大条件总包**的设计和材料可用，不是现在一次录满 12 条的授权，也不构成新的模型证据或召回提升。

P0–P2 零录音工作随后已全部榨完：7 个可直接运行候选全部因真实干净域过度标注被淘汰；Bach10、URMP、MusicNet 共 5,326 个公开参考音符中没有独立裁定错误正例，也没有同声部正确/错误演奏对。唯一剩余的预注册候选 `performance-only-RF-v2` 必须用真实反平衡 calibration 拟合。因此 P3 语义 SHA-256=`fe5302fe816d7a436a72e8e40fe8194c28ae05bb694924a7c29102c7f2a07ccb` 已把录制拆为两段：现在只授权 6 条 calibration；先按冻结参数训练并在既有真实 clean 域过安全闸，任一超限即收线并省掉 fresh；只有全部通过才条件追加 6 条 untouched fresh。`readyForRecording=true` 只表示技术包就绪，当前调度权威字段是 `recordingSchedule.stageARecordingAuthorizedNow=true`、`stageBFreshRecordingAuthorizedNow=false`。Round 6 无作用域的一次性 12 条签署已关闭；条件 Stage B 必须先验证 Stage A 报告、consumed ledger 和模型 SHA，再只签署 fresh 六条。最终 runner 在消费 fresh 后只加载 Stage A 冻结模型，禁止重新拟合，并以 `trainingPerformed=false / frozenModelLoaded=true` 作为证据有效性硬条件。

在不占用晋升分母的架构烟测中，r2-01 注入训练、r2-08 曲目留出，再投已查看 Round 4：结构特征基线为 `5/12` 命中、`6/253` 非故意位置误指控，P/R=`45.45%/41.67%`；加入固定 RMS/pYIN/onset 后降为 `1/12 @ 2/253`、P/R=`33.33%/8.33%`，且四个正确 gate 的 TP 合计为 0。两种均 `architectureCandidateRetained=false`，不接复核台；固定随机森林只保留为将来真实数据上的基线，下一模型族必须显式学习连续时序操作路径，而不是继续叠声学手工特征。

Round 6 录音到位前又完成一次候选输入审计：旧全谱 runner 实际没有传入固定声学窗口，这与上述负向烟测一致，不能误修成“补上声学特征”。真正的泄漏风险是它仍继承了前后音程和片段边界等谱面上下文。现已重新冻结 `western-round6-full-score-candidate-v2`：随机森林剔除 7 个静态谱面特征和 11 个固定声学堆叠字段，强制保留 assignment-gap、relative-IOI、时值比及目标窗事件数等 8 个时序字段；一次性执行守卫会同时核对协议、模块常量和实际模型 `featureNames`，出现被禁字段或缺少时序字段即在已消费后 fail-closed。该修订只保证候选不能靠谱面位置取巧，不把历史数据重写成性能提升；有效 recall/precision 仍只能由未触碰 Round 6 决定。

## 显式 temporal operation-path 结果

已实现并实测动态规划路径：对谱音与 Basic Pitch 事件显式允许 `match / insert / delete / merge / split`，512 组成本只在 r2-01 三个注入种子上选择，随后冻结投向 r2-08 曲目留出和已查看 Round 4。原始路径在 Round 4 能覆盖 `11/12`，但产生 `55/253` 非故意位置，precision 仅 `16.67%`；其中 extra 分支单独产生 53 个 FP。故原始架构明确 `architectureCandidateRetained=false`，不能以高召回掩盖误伤。

路径仍提供了一个高价值但范围很窄的二级用途：只精炼 Policy C 已有的 assignment-gap 自查提示，而不自行扩大候选面。冻结规则为“assignment gap 且路径在同一位置判为 merged substitution，或路径在连续 gap run 内只选择一个 missing”。在注入 calibration/曲目留出上分别把 gap 命中从 11→10、12→10，均保持 0 FP；在已查看 Round 4 上把 4 TP/3 FP 精炼为 **4 TP/0 FP**。与原有 2 个严格确诊合并后的回顾性两层上限为 **6/12、0/253**。再投 r2-01、r2-08、r3-01、r3-02、r3-03 五条自然正确录音，精炼提示同样为 **0 FP**；这补的是短篇学生域负例压力，不替代 fresh-blind 正例。

公开专业长曲压力给出了相反边界：Oliver Colbentson 两段 BWV1006 在正确展开反复记号后共有 2,301 个谱音，产生 936 个 assignment gap、595 个精炼提示，即 258.58 个提示/千音。由于没有逐音演奏错误人工 gold，这 595 个提示不能记作 FP；它们是实际可见的复核负担。故 `generalPurposeCandidateRetained=false`，该规则不得推广到任意专业长曲。它只保留为 Round 5 短篇学生混淆对的冻结候选，能否把正式确诊从 2/12 提高，仍只能由新的逐音人工真值 fresh-blind 决定。

候选已经接入 Round 5 targeted runner，而不是只留在回顾性脚本：gap 的 `self_check_hint` 仍保留，同时新增 missing-targeted 严格层；只有整条 assignment gap `<=5` 且 gap rate `<=10%` 才可输出 `issue_detected_candidate`，否则回退证据不足。节奏结构合取只评 `extra`/`drag`，relative-IOI `>0.15`、事件置信度 `>=0.75` 且 operation-path 必须同位置有候选；时值比 `>=1.20` 为软层，复用已有冻结值 `>=1.30` 为严格层。Round 5 首跑已经否定这些回顾性上限的晋升资格：gap 自查为 `1/12 @ 1 FP`，missing 严格层为 `1/6 @ 1 FP`；节奏 soft/strict 均为 `4/12 @ 0 FP`、recall=`33.33%`，且固定节奏目标位置可被纯谱面上下文完全识别。它们既未过原冻结 recall 地板，也没有有效的位置配平证据；正式严格确诊继续为 **2/12**。

本轮采集、签署、身份核对和首跑均已完成，当前 12 条证据视为已消费。calibration-only 留一录音审计进一步发现 merged、missing、drag 的标签都被纯谱面音程上下文完美分开；排除前后音程和片段边界等静态特征后，没有稳定候选过门。因此不能在旧 calibration 上继续调模；新技术设计必须同时保证 calibration 与 untouched fresh 都反平衡，但录制顺序按 P3 分阶段执行，先 6 条 calibration，安全闸通过后才录 fresh 6 条。

边界必须同时保留：gap 健康守卫、软节奏与高置信节奏合取都未通过 Round 5，片段模型的 extra 也因 fresh 位置混杂不能晋升；`strictConfirmedRecallUnchanged=true`，所以严格确诊仍是 `2/12`，`reviewAssistPromotionReady=false`、`automaticAccusationEvidenceReady=false`、`automaticAccusationReady=false`。健康守卫把长曲降级为证据不足，不等于证明长曲正确；节奏严格层的 13 个专业长曲候选也没有逐音人工真值。可复跑：

```powershell
npm run western:round5-temporal-operation-path
npm run test:western-round5-temporal-operation-path
```

权威预闸证据为 `docs/evidence/western-strings-round5-temporal-operation-path-20260722.json`，总项目状态会现场复核其中全部源文件哈希。

## 教师复核标签回流（calibration only）

`policyCReviewAssistRuntime.ready=true` 只表示最新物理批次的 Policy C 契约和安全边界可审计，不表示该批次一定有候选。状态现已拆为 `mechanismReady`、`candidateAvailable`、`readyForReview`；当前最新批次 `outputCount=0`，所以机制就绪但没有当前候选。冻结 Round 4 的候选工件生成早于 Policy C 持久化接线，不能伪称已有物理决策字段。

为回收这批已知但尚未结构化的教师判断，新增本机复核包：它先验证冻结报告、manifest、position truth 与六份候选工件的 SHA-256，再用当前冻结 Policy C 函数逐行重算。当前导出 **9 个可播放候选 / 4 条录音**，覆盖 2 个 `confirmed_issue` 与 7 个 `self_check_hint`；已知评测构成为 6 个故意错误位置加 3 个非故意混淆位置，但页面不会把评测真值预填给复核人。下载结果只能生成 calibration 草稿，硬编码 `freshBlindEligible=false`，不能补 fresh-blind 分母。项目状态中的 `ordinaryDynamicShadow.policyCReviewAssistCalibrationPack` 还会逐行重哈希冻结报告、候选工件、源/复制音频、源谱和页面内 ledger 绑定；当前 `sourceCurrent=true`、`readyForReview=true`、`completedReviewPresent=false`。该包不写 canonical batch，不会改变 M3+ 的最新物理批身份。

```powershell
npm run western:round5-review-assist-calibration-pack
npm run test:western-review-assist-project-status
# 在 data/experiments/western-strings-round5-review-assist-calibration-pack/index.html 完成人工复核并下载 JSON
npm run western:round5-review-assist-calibration-stage -- --completed data/experiments/western-strings-round5-review-assist-calibration-pack/round5-review-assist-calibration.completed.json
```

stage 工具要求每条正/负标签都有 gate、实际演奏描述和复核人，混淆负例还必须填写 `confusionKind`；每条录音必须补 performer/device/room、consent=`yes`、licenseStatus=`local-only`。它验证 ledger 与音频/乐谱源哈希后，只写 `data/private/western-strings-round5-review-assist-calibration-draft/`，不会自动合并正式 Round 5，也不会改变严格确诊 `2/12`。它的价值是形成真实的 6 正/3 混淆负例种子，指导下一次定向采集和时序 operation-path 模型，而不是制造新的晋升数字。
