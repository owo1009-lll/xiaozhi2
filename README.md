# AI 二胡研究原型

这是一个独立于 `ToDesk` 的项目目录，用于面向 SSCI 的二胡 AI 教学干预研究原型。

## 已实现内容

- React + Vite 前端，支持移动端使用
- Express 后端 API
- 结构化曲目包接口
- 非实时录音上传与分析流程
- 研究数据录入、周任务计划、访谈记录、访谈抽样标记、问卷、教师评分和导出接口
- Python 深度学习分析服务，已接入 `torchcrepe + librosa + 稳定段音高评分 + DTW`
- 结果解释层已支持整体判断、老师式点评和优先练习顺序
- PWA 基础能力：`manifest` + `service worker`
- 统计分析脚本，可把导出的 CSV 转成论文表格和图表
- 统计分析脚本已支持前后测长表、ANCOVA 摘要、空数据占位输出，以及 Word 友好的论文草稿生成

## 当前分析模式

- 默认由 Node 网关转发到 Python 分析服务
- Python 服务使用 `ffmpeg -> librosa -> torchcrepe -> 稳定段筛选 / 滑音揉弦容忍 -> DTW` 的处理链
- 若 `ERHU_ANALYZER_URL` 未配置或不可达，Node 会回退到本地 mock 分析
- 详细开发执行路线见 `docs/development-roadmap.md`

## 本地运行

### 1. 启动 Node 网关

```powershell
npm install
npm run server
```

### 2. 启动前端开发模式

```powershell
npm run dev
```

### 3. 启动 Python 分析服务

```powershell
cd python-service
.venv\Scripts\activate
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

## 生产构建

```powershell
npm install
npm run build
npm start
```

## 研究数据接口

- `GET /api/erhu/pieces`
- `POST /api/erhu/analyze`
- `GET /api/erhu/analysis/:analysisId`
- `POST /api/erhu/participant-profile`
- `POST /api/erhu/research/batch-participants`
- `POST /api/erhu/task-plan`
- `POST /api/erhu/interview-note`
- `POST /api/erhu/interview-sampling`
- `POST /api/erhu/study-record`
- `POST /api/erhu/expert-rating`
- `POST /api/erhu/validation-review`
- `GET /api/erhu/study-records/:participantId`
- `GET /api/erhu/research/overview`
- `GET /api/erhu/research/data-quality`
- `GET /api/erhu/research/participants`
- `GET /api/erhu/research/templates`
- `GET /api/erhu/research/templates/:templateId`
- `GET /api/erhu/research/tasks`
- `GET /api/erhu/research/interviews`
- `GET /api/erhu/research/questionnaires`
- `GET /api/erhu/research/expert-ratings`
- `GET /api/erhu/research/validation-reviews`
- `GET /api/erhu/research/validation-summary`
- `GET /api/erhu/research/pending-ratings`
- `GET /api/erhu/research/export?dataset=participants|sampling|tasks|interviews|questionnaires|expert-ratings|analyses|validation-reviews&format=json|csv`

## 统计分析脚本

导出四个 CSV 后运行：

```powershell
python-service\.venv\Scripts\python.exe research-analysis\analyze_exports.py ^
  --participants exports\participants.csv ^
  --questionnaires exports\questionnaires.csv ^
  --ratings exports\expert-ratings.csv ^
  --analyses exports\analyses.csv ^
  --output-dir research-analysis\output
```

会生成：

- 分组汇总表
- 组间 t 检验表
- 前后测长表与分组汇总表
- ANCOVA 摘要表
- 问卷汇总表
- 系统评分与教师评分相关表
- 分析使用情况表
- 多张论文可直接使用的图表 PNG
- 中文论文草稿：`paper_draft_zh.md`、`paper_draft_zh.txt`、`paper_draft_zh.docx`
- 可直接粘贴进论文“结果”章节的 `results_section_zh.txt`
