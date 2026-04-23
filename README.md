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

### 一键本地预览

```powershell
npm run preview:local
```

启动后直接在本机打开：

- `http://127.0.0.1:3000`
- `http://127.0.0.1:3000/api/health`
- `http://127.0.0.1:8000/docs`

停止本地预览：

```powershell
npm run preview:stop
```

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
- `POST /api/erhu/adjudication`
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
- `GET /api/erhu/research/adjudications`
- `GET /api/erhu/research/adjudication-summary`
- `GET /api/erhu/research/pending-ratings`
- `GET /api/erhu/research/export?dataset=participants|sampling|tasks|interviews|questionnaires|expert-ratings|analyses|validation-reviews|adjudications&format=json|csv`

## 统计分析脚本

导出四个 CSV 后运行：

```powershell
python-service\.venv\Scripts\python.exe research-analysis\analyze_exports.py ^
  --participants exports\participants.csv ^
  --questionnaires exports\questionnaires.csv ^
  --ratings exports\expert-ratings.csv ^
  --analyses exports\analyses.csv ^
  --validations exports\validation-reviews.csv ^
  --adjudications exports\adjudications.csv ^
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

## 2026-04-21 Whole-Piece Update

`桃花坞` now ships with a reusable whole-piece scaffold inside `src/erhuStudyPieces.js`.

- Structured sections: `41`
- Structured notes: `328`
- Latest whole-piece pass output:
  - [taohuawu-whole-v3](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v3:1)
- Current weighted scores:
  - pitch `48.04`
  - rhythm `54.47`
  - combined `55.06`
  - dominant path `rhythm-first`

The research export chain now also pulls the newest whole-piece pass into:

- `exports/piece-pass-summary.json`
- `exports/piece-pass-sections.csv`

And the research-analysis step now produces:

- `research-analysis/output/table_piece_pass_summary.csv`
- `research-analysis/output/table_piece_pass_sections.csv`
- `research-analysis/output/figure_piece_pass_section_scores.png`

This means the whole-piece pass is now part of the same paper-facing export pipeline as the participant, questionnaire, validation, and adjudication data.

## Pilot Pack

You can now generate a pilot-ready packet directly from the newest whole-piece pass:

```powershell
npm run pilot:pack:taohuawu
```

This writes reusable pilot materials to:

- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-pilot-overview.md`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-participant-run-sheet.md`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-weak-sections.csv`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-teacher-validation-sheet.csv`
- `data/pilot-pack/taohuawu-v1/taohuawu-test-fragment-pilot-manifest.json`

## Research Focus Adjustment

The current recommended study framing is:

- primary: `AI-supported self-practice`, learner improvement, and learner experience
- secondary optional layer: teacher-side validation and adjudication

See [self-practice-research-mode.md](C:\Users\Administrator\Downloads\ai二胡\docs\self-practice-research-mode.md:1) for the clean version of this research positioning.

## Mainline Priority

The highest-priority task is now the student-facing app line:

- `PDF score -> recording/upload -> pitch/rhythm diagnosis -> note/measure localization -> feedback to student`

And both diagnosis domains should be treated as deep-learning targets:

- pitch: already on a DL path
- rhythm: current rule-based pipeline is only temporary and should not be treated as the final target

See [mainline-app-priority.md](C:\Users\Administrator\Downloads\ai二胡\docs\mainline-app-priority.md:1).
## 2026-04-21 Student Mainline

The default root app is now the student-facing flow instead of the research workspace:

1. upload a PDF score
2. let the system import / match it into a structured score
3. choose a section
4. upload or record audio
5. run automatic `erhu-focus` separation plus pitch / rhythm diagnosis
6. view note-level and measure-level feedback

The research workspace is still available as a secondary mode:

- student mainline: `http://127.0.0.1:3000`
- research workspace: `http://127.0.0.1:3000/?mode=research`

### New mainline APIs

- `POST /api/erhu/scores/import-pdf`
- `GET /api/erhu/scores/import-pdf/:jobId`
- `GET /api/erhu/scores/:scoreId`
- `POST /api/erhu/analyze` with `scoreId` and `separationMode=auto|off|erhu-focus`

### Current OMR behavior

- preferred real OMR backend: `Audiveris`
- current local fallback when Audiveris is not installed: match known PDF titles such as `桃花坞` to the built-in structured score pack so the student flow still runs end to end
- if a PDF is unknown and local OMR is unavailable, the import job fails clearly instead of silently falling back to manual note entry
