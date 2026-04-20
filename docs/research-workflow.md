# AI 二胡研究工作流

## 项目结构

- `src/ResearchApp.jsx`：研究原型前端，覆盖受试编号、录音上传、分析反馈、周任务、访谈、访谈抽样、问卷与教师评分流程
- `server.js`：Node 网关，负责曲目数据、研究记录、导出接口，以及转发 Python 分析服务
- `python-service/`：FastAPI 分析服务，当前已接入 `ffmpeg -> librosa -> torchcrepe -> 稳定段筛选 -> DTW`
- `research-analysis/`：把导出的 CSV 转成论文可用表格、图表和摘要报告
- `data/`：本地研究记录文件，仅用于开发或实验阶段存储

## 本地启动

### 1. 安装前端与 Node 依赖

```powershell
npm install
```

### 2. 启动 Python 分析服务

```powershell
cd python-service
.venv\Scripts\activate
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

也可以直接在项目根目录执行：

```powershell
npm run analyzer:start
```

### 3. 启动 Node 网关

```powershell
npm run server
```

### 4. 启动前端开发模式

```powershell
npm run dev
```

## 环境变量

项目根目录 `.env`：

```bash
PORT=3000
ERHU_ANALYZER_URL=http://127.0.0.1:8000
```

`python-service/.env`：

```bash
ERHU_ENABLE_TORCHCREPE=true
ERHU_ENABLE_LIBROSA_DECODE=true
ERHU_TARGET_SAMPLE_RATE=16000
ERHU_ONSET_HOP_LENGTH=160
ERHU_UNCERTAIN_CONFIDENCE=0.63
ERHU_BASE_PITCH_TOLERANCE_CENTS=15
ERHU_VIBRATO_SPREAD_THRESHOLD_CENTS=26
ERHU_GLIDE_ENTRY_THRESHOLD_CENTS=24
ERHU_FFMPEG_PATH=
```

说明：

- `ERHU_ENABLE_TORCHCREPE=true` 时，音高提取优先使用 `torchcrepe`
- `ERHU_ENABLE_LIBROSA_DECODE=true` 时，服务会在需要时调用 `ffmpeg/librosa` 解码输入音频
- `ERHU_FFMPEG_PATH` 可显式指定 ffmpeg 可执行文件；留空时会尝试使用系统或 `imageio-ffmpeg` 提供的二进制

## 当前分析链

当前 Python 分析服务按以下顺序工作：

1. 解码录音音频
2. 通过 `torchcrepe` 或 `librosa.pyin` 提取逐帧音高
3. 通过 `librosa` 提取起音候选
4. 从 `piecePack.notes`、`MusicXML` 或 `MIDI` 构建符号乐谱
5. 对每个音构建稳定段证据，并识别滑音样、揉弦样音符
6. 通过 `DTW` 对齐演奏序列与符号乐谱
7. 以自适应音准容忍阈值输出逐音偏差、节奏偏差和小节级问题

说明：

- `MusicXML` 目前通过内置 XML 解析器读取单旋律音符事件
- `MIDI` 需要安装 `pretty_midi`
- 如果未传入 `scoreSource`，服务仍会退回到内置 `notes` 序列
- 音准误差不再只看固定阈值，而是会结合稳定段、滑音和揉弦特征动态调整容忍范围

## 研究接口

- `POST /api/erhu/participant-profile`
- `POST /api/erhu/research/batch-participants`
- `POST /api/erhu/analyze`
- `POST /api/erhu/task-plan`
- `POST /api/erhu/interview-note`
- `POST /api/erhu/interview-sampling`
- `POST /api/erhu/study-record`
- `POST /api/erhu/expert-rating`
- `GET /api/erhu/analysis/:analysisId`
- `GET /api/erhu/research/overview`
- `GET /api/erhu/research/data-quality`
- `GET /api/erhu/research/participants`
- `GET /api/erhu/research/templates`
- `GET /api/erhu/research/templates/:templateId`
- `GET /api/erhu/research/tasks`
- `GET /api/erhu/research/interviews`
- `GET /api/erhu/research/questionnaires`
- `GET /api/erhu/research/expert-ratings`
- `GET /api/erhu/research/pending-ratings`
- `GET /api/erhu/analyzer-status`
- `GET /api/erhu/research/export?dataset=participants|sampling|tasks|interviews|questionnaires|expert-ratings|analyses&format=json|csv`

## 研究数据导出与统计分析

### 方案 A：分步运行

先导出：

```powershell
npm run research:export
```

再生成论文表格和图：

```powershell
npm run research:paper
```

### 方案 B：一键运行

```powershell
npm run research:export-and-paper
```

## 统计分析输出

`research-analysis/output/` 默认会生成：

- `table_participant_overview.csv`
- `table_group_summary.csv`
- `table_group_ttests.csv`
- `table_questionnaire_summary.csv`
- `table_system_expert_correlations.csv`
- `table_analysis_usage.csv`
- `table_usage_correlations.csv`
- `table_prepost_long.csv`
- `table_prepost_summary.csv`
- `table_ancova_summary.csv`
- `table_expert_ratings_raw.csv`
- `figure_gain_by_group.png`
- `figure_questionnaire_by_group.png`
- `figure_system_vs_expert.png`
- `figure_usage_vs_pitch_gain.png`
- `figure_prepost_trends.png`
- `report.md`
- `summary.json`

## 当前实现边界

- 反馈默认为非实时录音分析
- 诊断维度当前聚焦音准、节奏、问题音定位和示范回放
- 正式实验工作台已支持批量导入受试者、周任务计划和访谈记录
- 正式实验总览已支持缺测提醒、周任务完成率看板和访谈抽样队列
- 运弓、音色、揉弦质量与开放式问答不在本阶段范围内
- Python 服务已可用，但仍建议后续接入真实教师标注数据做一致性与稳健性验证
- 统计脚本已支持空白研究库启动状态，清空测试数据后仍可正常导出空表与占位图
