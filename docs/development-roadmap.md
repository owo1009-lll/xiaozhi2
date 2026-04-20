# AI 二胡项目开发执行路线图

这份文档不是论文写作提纲，而是项目开发路线图。目标是让你随时知道当前做到哪一步、下一步做什么、用了哪些方法，以及每一步最终会在系统里呈现什么效果。

## 总目标

做出一个面向二胡教学研究的 AI 原型系统，满足以下闭环：

1. 学生选择曲目与段落
2. 学生录音或上传录音
3. 系统分析音准与节奏
4. 系统定位到小节与音符级别的问题
5. 系统给出示范回放与结构化反馈
6. 研究者收集实验数据、问卷、教师评分与访谈
7. 系统自动导出统计结果与论文素材

## 当前已完成

### 阶段 1：研究原型框架

- 做了什么：
  - React + Vite 前端
  - Express 网关
  - FastAPI Python 分析服务
  - 研究数据录入、导出、问卷、教师评分、访谈、任务计划
- 用到的方法：
  - Web 前后端分离
  - 结构化 JSON 接口
- 当前呈现效果：
  - 已可录音上传、查看分析结果、登记受试者、导出研究数据

### 阶段 2：深度学习音高分析

- 做了什么：
  - 接入 `torchcrepe`
  - 接入 `librosa.pyin` 作为音高回退
  - 接入 `librosa` onset 检测
- 用到的方法：
  - 深度学习音高估计：`torchcrepe`
  - 传统音频分析：`librosa`
- 当前呈现效果：
  - 系统已能从录音中提取音高轨迹和起音候选

### 阶段 3：符号乐谱 + DTW 对齐

- 做了什么：
  - 分析器支持 `piecePack.notes`
  - 支持内联 `MusicXML`
  - 支持内联 `MIDI`（安装 `pretty_midi` 后）
  - 用 `DTW` 取代原来的启发式逐音匹配
- 用到的方法：
  - 符号乐谱解析
  - 动态时间规整 `DTW`
  - 基于序列的音高/时序匹配
- 当前呈现效果：
  - 对齐逻辑更接近真实“乐谱-演奏匹配”，不再只是按时间窗口硬对位

## 接下来要做什么

### 阶段 4：二胡特征适配

- 目标：
  - 减少滑音、揉弦、长音进入阶段带来的误判
- 要做的事：
  - 引入“稳定段”音高评分，而不是整音平均
  - 对疑似滑音段设置容忍区
  - 对低置信度音高帧标记为弱证据
- 用到的方法：
  - 规则诊断
  - 稳定段筛选
  - 置信度加权
- 最终效果：
  - 反馈更像教师判断，不会把大量表现性处理都误判成错音

当前进度：

- 已完成稳定段音高提取
- 已完成滑音样 / 揉弦样音符识别
- 已完成自适应音准容忍阈值
- 已完成低置信度音高的降权与“需复核”标记

### 阶段 5：问题解释层

- 目标：
  - 把底层误差转换成学生能看懂的反馈
- 要做的事：
  - 统一问题类型：音高偏低、音高偏高、节奏偏早、节奏偏晚、节奏不稳
  - 生成“第几小节 / 第几个音”的提示
  - 绑定示范音频与问题小节
- 用到的方法：
  - 规则映射
  - 结构化反馈模板
- 最终效果：
  - 学生打开结果页后能直接看到错在哪里，而不只是一个总分

当前进度：

- 已完成整体判断 `summaryText`
- 已完成老师式点评 `teacherComment`
- 已完成优先练习顺序 `practiceTargets`
- 已完成问题音 / 问题小节的原因说明和练习建议

### 阶段 6：真实实验执行层

- 目标：
  - 支撑正式教育实验
- 要做的事：
  - 批量导入受试者
  - 分组管理
  - 周任务追踪
  - 缺测提醒
  - 教师评分与访谈抽样
- 用到的方法：
  - 研究流程管理
  - 数据质量控制
- 最终效果：
  - 系统不仅能分析演奏，还能真正支持实验全过程

### 阶段 7：统计与论文素材自动化

- 目标：
  - 把研究数据自动转成论文图表与文本素材
- 要做的事：
  - 导出 CSV
  - 自动生成 t 检验、ANCOVA、相关分析结果
  - 自动生成中文结果段落和 Word 草稿
- 用到的方法：
  - `pandas`
  - `scipy`
  - `statsmodels`
  - `python-docx`
- 最终效果：
  - 研究者不用手工整理每一张表和每一段结果描述

## 深度学习在这个项目中的位置

当前真正属于深度学习的核心模块是：

- `torchcrepe`：逐帧音高估计

当前不需要强行用深度学习的模块是：

- 符号乐谱解析
- `DTW` 对齐
- 规则反馈生成
- 研究流程管理
- 统计分析与论文导出

原因很直接：这些部分的核心问题是工程稳定性和教育可解释性，不是模型复杂度。

## 是否要加入注意力机制

当前阶段不建议加入。

### 原因

- 现在的主要瓶颈是：
  - 对齐是否稳定
  - 二胡滑音/揉弦如何减少误判
  - 反馈是否足够清晰
- 这些问题不能靠“先加注意力机制”解决
- 目前你已经有深度学习成分，不需要为了“看起来更 AI”而加入注意力机制

### 什么时候再考虑注意力机制

只有在你进入下面这个阶段时，注意力机制才值得加入：

- 你已经积累了真实标注数据
- 你想训练自己的错误诊断模型
- 你不再满足于 `torchcrepe + DTW + 规则反馈`
- 你要让模型直接学习“音高曲线 + 节奏 + 乐谱上下文 -> 错误类型”

### 那时可考虑的结构

- `BiLSTM + Attention`
- `Transformer Encoder`
- `Score-Audio Cross Attention`

### 注意力机制未来的合理位置

- 用在“错误诊断分类器”
- 用在“乐谱上下文建模”
- 用在“音频片段与符号乐谱的跨模态匹配”

不是现在这个阶段的主线。

## 你接下来最该看的顺序

如果你想知道项目现在应该先做什么，按这个顺序看：

1. 先把 `DTW` 对齐跑稳
2. 再做二胡滑音/揉弦容忍
3. 再做问题解释层优化
4. 再做真实教师标注验证
5. 最后才考虑是否训练带注意力机制的新模型
## Current Checkpoint

- Completed: `teacher validation workflow`
  Backend now stores teacher validation reviews and computes note-level F1, measure-level F1, and practice-path agreement.
- Completed: `practice path refinement`
  The analyzer and UI now distinguish `pitch-first`, `rhythm-first`, and `review-first`.
- Completed: `research analysis integration`
  `research-analysis/analyze_exports.py` now accepts `validation-reviews.csv` and generates validation tables, path-confusion tables, and validation figures.
- Completed: `dual-rater reliability support`
  The backend now stores multiple validation reviews per `analysisId` keyed by `raterId`, the app can switch between teacher reviews, and the analysis script now generates `table_inter_rater_pairs.csv`, `table_inter_rater_summary.csv`, and `figure_inter_rater_metrics.png`.
- Current next step:
  add a stronger teacher-validation protocol, such as fixed double-rating assignment rules, adjudication workflow, or `Cohen's kappa` / `ICC` reporting by week or piece.
