# P1 真实干净域“不冤枉”评测

- 预注册语义 SHA：`efe62f7b1dac036336647918f04c158be9f0d3113a6de8b637106cf42cef62f6`
- 预注册 Git commit：`8de5b9e23972c2a2256ace9c5c13640080cb5749`
- 本轮未调参、未改阈值、未改变输入清单；只按冻结门槛淘汰。
- 公开专业演奏没有逐音错误 gold，因此只报告标注负担，不冒充 FP。

| candidate | local clean | Round 5 known negatives | public burden | decision |
|---|---:|---:|---:|---|
| `alignment-gap-refined-self-check-v1` | 5/743 (6.73/1000) | 3/624 (4.81/1000) | 1008/6652 (151.53/1000) | 淘汰：public-professional-pooled-burden,public-professional-recording-burden |
| `alignment-gap-strict-missing-v1` | 1/743 (1.35/1000) | 2/624 (3.21/1000) | 0/6652 (0.00/1000) | 淘汰：authoritative-local-clean-false-positive,consumed-round5-known-negative-false-positive |
| `relative-ioi-duration-review-v1` | 7/743 (9.42/1000) | 0/624 (0.00/1000) | 37/6652 (5.56/1000) | 淘汰：authoritative-local-clean-recording-hint-rate |
| `relative-ioi-duration-strict-v1` | 2/743 (2.69/1000) | 0/624 (0.00/1000) | 37/6652 (5.56/1000) | 淘汰：authoritative-local-clean-false-positive,public-professional-pooled-burden,public-professional-recording-burden |
| `pitch-trajectory-center-strict-v1` | 10/506 (19.76/1000) | N/A | N/A | 淘汰：authoritative-local-clean-false-positive |
| `onset-density-extra-strict-v1` | 232/743 (312.25/1000) | 64/624 (102.56/1000) | 124/6652 (18.64/1000) | 淘汰：authoritative-local-clean-false-positive,consumed-round5-known-negative-false-positive,public-professional-pooled-burden,public-professional-recording-burden |
| `temporal-operation-sequence-union-v1` | 289/743 (388.96/1000) | 116/624 (185.90/1000) | 3371/6652 (506.76/1000) | 淘汰：authoritative-local-clean-pooled-hint-rate,authoritative-local-clean-recording-hint-rate,consumed-round5-pooled-hint-rate,consumed-round5-recording-hint-rate,public-professional-pooled-burden,public-professional-recording-burden |

## 结论

- 淘汰：alignment-gap-refined-self-check-v1, alignment-gap-strict-missing-v1, relative-ioi-duration-review-v1, relative-ioi-duration-strict-v1, pitch-trajectory-center-strict-v1, onset-density-extra-strict-v1, temporal-operation-sequence-union-v1。
- 仅保留到召回审计：无。
- “保留”不等于晋升；没有真实错误召回证据仍不得进入学生自动指控。
- Round 4/5 仍是已消费材料，三开关继续 false；M4 OMR 与能量验漏音维持 stop-line。
