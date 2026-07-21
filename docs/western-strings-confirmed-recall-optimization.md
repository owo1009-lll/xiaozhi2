# Ordinary 确诊召回优化记录（2026-07-22）

当前严格确诊仍为 **2/12**。Policy C 的两层教师复核候选为 6/12，但其中 4 条是 `self_check_hint`，不能改写成机器确诊。

## 本轮可复跑结果

| 候选 | 开发/合成证据 | 独立或真实证据 | 裁决 |
|---|---|---|---|
| 合并替代音结构规则 | round4 新增命中 1 个 wrong，0/253 非故意位置 | 13 套外部集合 0 个独立正例 | 只作 development pre-gate；严格口径不从 2/12 晋升 |
| relative-IOI + duration 合取 | r2-01 开发 P/R=95.45%/77.78%；r2-08 holdout 同为 95.45%/77.78% | 完整 round4 P/R=50.00%/66.67% | 合成到真实域迁移失败 |
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

Round 5 intake 已接入总项目状态并做实时哈希绑定。当前 `ready=false`、`bindingCurrent=true`：合同本身与已生成报告一致，唯一输入 blocker 是私密 `manifest.csv` 和 `position-truth.json` 尚未到位。文件新增或改动后若未重跑 `npm run western:round5-targeted-intake`，总状态会以 stale reason 关闭，而不会继续沿用旧报告。
