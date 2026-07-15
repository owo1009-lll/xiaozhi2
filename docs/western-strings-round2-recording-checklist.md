# 第二轮真实录音清单(一次采集,喂饱三个闸门)

更新: 2026-07-15。目的:同时补 ①M3 core 错误样本(现每类仅 2 个)②M3+ 技法模式证据 ③P1 全新盲测录音。

## 2026-07-15 执行结果

- 8/8 组音频、MusicXML 和谱面图片已通过文件、解码与结构审计,并已按 `r2-01` 至 `r2-08` 标准名写入本地 private intake。
- 导入时发现 7 份 MusicXML 被旧逻辑压缩到第 1 小节。现已修复解析与导入逻辑,备份 score store 后原位重建;8 份谱面最终均保持原 `scoreId`,共 444 个音符,小节数和音符 ID 唯一性全部与源 MusicXML 一致。
- 8/8 已完成受控机器分析,结果均为 `offline_feature_review_ready`;本轮没有发布学生诊断。
- `r2-08` 已按精确 `recordingId` 完成 fresh-blind 受控 pilot:60 个候选中模型原始 auto-pass 3 个,但范围内 auto-pass=0、自检通过 auto-pass=0,因此 pilot 按规则中止,学生端保持 fail-closed,也没有生成无意义的教师复核任务。
- M3+ 已完成库存清点:444 个音符中 292 个进入 review-only 行为候选。该数字只表示候选库存,不表示模式已获准自动反馈。
- 原始目录未提供 `notes.txt`,因此 `r2-02` 错音、`r2-03` 漏音、`r2-04` 节奏偏移的精确小节真值仍缺失。不得据此伪造 M3 分类 recall/precision;只有补齐小节标签后才可计算。

主要机器产物:

- `data/experiments/western-strings-round2/machine-analysis.json`
- `data/experiments/western-strings-round2/score-structure-repair.json`
- `data/experiments/western-strings-round2/m3plus/`
- `data/experiments/western-strings-controlled-pilot-sessions/round2-r2-08-20260715-exact-v4/session.json`
**你只需按下表录 8 条,其余(登记/评测/闸门)由自动化完成。**

## 录音要求(通用)
- 设备:手机即可,安静房间,距琴 0.5–1 米。
- 每条 30–60 秒,单声部小提琴;**从曲子开头录**。
- 曲目:任选你手头有谱的练习曲/小曲;**其中第 8 条必须是此前 12 条里没用过的新曲目**(盲测用)。
- 谱面:每条对应谱拍一张清晰照片(正对、无阴影、整页入框)。
- 文件命名:`r2-01.m4a` + `r2-01-score.jpg` … 依次到 `r2-08`。
- 存放:`data/private/western-strings-round2/`(不入 git)。

## 逐条内容(关键在"怎么错")
| 编号 | 内容 | 服务的闸门 |
|---|---|---|
| r2-01 | **正常演奏**,尽量拉准 | 基线 + P1 |
| r2-02 | **故意错音 3 处**:各错 1–2 个半音,错完继续往下拉,**记下错在第几小节** | M3 pitch(现仅2样本) |
| r2-03 | **故意漏音 3 处**:跳过整个音不拉,记小节号 | M3 missing(现仅2样本) |
| r2-04 | **故意节奏偏移 2 处**:某音明显拖后半拍以上,记小节号 | M3 onset(现仅2样本) |
| r2-05 | **含滑音的乐段**(谱上有或自加 2–3 处明显滑音) | M3+ slide 模式 |
| r2-06 | **含颤音/揉弦的乐段**(长音上加明显揉弦或谱面颤音) | M3+ trill/vibrato 模式 |
| r2-07 | **含双音的乐段**(谱上有双音最好;没有则任选带双音的练习曲) | M3+ 双音 multi-f0 |
| r2-08 | **全新曲目、正常演奏**(此前 12 条从未用过的曲子,不要告诉自动化哪里有问题) | **P1 fresh blind** |

## 附一张手写便签(拍照或文本)
每条写:曲名 / 错误位置(小节号)/ 错误类型。r2-08 **不写**(盲测)。
存为 `data/private/western-strings-round2/notes.txt` 或照片。

## 你录完之后(自动化接手,无需你动)
1. 登记 manifest(round2 目录 → 受控提交流,consent/licenseStatus=local-only)。
2. r2-01…07:跑 photo-score 生产管线 + M3/M3+ 评测,按你的小节标注核对每类命中。
3. r2-08:走 P1 fresh-blind 流程(`fresh-blind` intake → 盲审包)。
4. 闸门重算并汇报:M3 每类样本数、M3+ 模式放行状态、P1 scope 是否可扩。
