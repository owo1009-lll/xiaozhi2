# AI二胡研究原型

这是一个独立于 `ToDesk` 的新项目目录，服务于面向 SSCI 的二胡 AI 教学干预研究原型。

## 已实现内容

- React + Vite 前端，移动端可用
- Express 后端 API
- 结构化曲目包接口
- 非实时录音/上传与分析流程
- 结构化分析结果接口
- 学习记录、体验量表与研究导出接口
- PWA 基础能力：`manifest` + `service worker`

## 当前分析模式

- 默认使用内置 `fallback` 分析器，保证研究流程可以跑通
- 如果配置 `ERHU_ANALYZER_URL`，后端会将音频与曲目包转发给外部深度学习分析服务
- 外部分析服务需提供 `POST /analyze`，返回：

```json
{
  "analysis": {
    "overallPitchScore": 86,
    "overallRhythmScore": 81,
    "measureFindings": [],
    "noteFindings": [],
    "demoSegments": [],
    "confidence": 0.88
  }
}
```

## 本地运行

```powershell
npm install
npm run server
```

另开一个终端运行前端开发服务器：

```powershell
npm run dev
```

前端默认代理 `/api` 到 `http://localhost:3000`。

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
- `POST /api/erhu/study-record`
- `GET /api/erhu/study-records/:participantId`
- `GET /api/erhu/research/overview`
- `GET /api/erhu/research/export?format=json|csv`
