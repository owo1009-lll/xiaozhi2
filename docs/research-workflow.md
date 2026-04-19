# AI 二胡研究工作流

## 目录结构

- `src/ResearchApp.jsx`: 研究原型前端
- `server.js`: Node 网关与研究数据接口
- `python-service/`: Python 深度学习分析服务骨架

## 本地运行

### 1. 启动 Node 网关

```powershell
npm install
npm run build
npm run server
```

### 2. 启动前端开发模式

```powershell
npm run dev
```

### 3. 启动 Python 分析服务

```powershell
cd python-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

如果需要 `torchcrepe/librosa`：

```powershell
pip install -r requirements-optional.txt
```

## 环境变量

根目录 `.env`:

```bash
PORT=3000
ERHU_ANALYZER_URL=http://127.0.0.1:8000
```

Python 服务 `.env`:

```bash
ERHU_ENABLE_TORCHCREPE=false
ERHU_ENABLE_LIBROSA_DECODE=false
```

## 研究数据接口

- `POST /api/erhu/participant-profile`
- `POST /api/erhu/analyze`
- `POST /api/erhu/study-record`
- `POST /api/erhu/expert-rating`
- `GET /api/erhu/research/overview`
- `GET /api/erhu/research/participants`
- `GET /api/erhu/research/questionnaires`
- `GET /api/erhu/research/expert-ratings`
- `GET /api/erhu/research/pending-ratings`
- `GET /api/erhu/research/export?dataset=participants|questionnaires|expert-ratings|analyses&format=json|csv`

## 建议的后续研究工作

1. 接入真实 `torchcrepe` 推理与 `librosa` onset 检测。
2. 增加 score-informed DTW，对问题音定位做教师一致性验证。
3. 用教师评分与系统评分建立相关性分析脚本。
4. 增加实验日志与问卷的统计分析 Notebook。
