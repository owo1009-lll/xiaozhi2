# 微信小程序学生复核回路契约核对

核对日期：2026-07-24

## P1：小程序与后端契约

| 学生接口 | 小程序请求/消费 | 后端契约 | 结论 |
| --- | --- | --- | --- |
| `POST /api/strings/analyze` | `multipart/form-data`；文件字段 `audio`；表单字段 `payload` 为 JSON。`utils/api.js` 在上传前写入 `clientPlatform="wechat-mini-program"` 和一次性 `wechatLoginCode`。业务字段包括 `studentRef`、`piece`、`pieceId`、`instrument`、`audioSubmission`；有谱图时附 `scorePhotoDataUrl`、`scorePhotoSubmission`。 | `parseIncomingPayload` 解析 `payload`；`parseStudentSubmission` 读取同名字段、持久化音频/谱图；微信来源调用内容安全。同步成功返回 `{ok, analysis}`，其中 `analysis.submissionAccepted=true`；异步图片审核返回 HTTP 202 与 `{moderationPending, moderationTicket}`。 | 一致。 |
| `GET /api/strings/student-submissions?studentRef=&limit=` | 上传页和记录页读取 `submissions`，使用 `submissionId`、`submittedAt`、`piece`、`pieceId`、`instrument`、`status`、`teacherFeedback`。 | `buildStudentSubmissionView` 返回上述字段，并额外返回 `kind`、`teacherFeedbackAt`。状态限定为 `queued`、`under_review`、`feedback_released`、`unsupported`。 | 一致；小程序不消费复核内部字段。 |
| `GET /api/strings/score-editions` | 按 `pieceId` 选择 `editionId`、`title`、`meta`、`pageCount`。三首登记诊断谱面随包内置，其他曲目仍按接口字段读取。 | `listSupportedEditions` 返回 `{ok, editions[]}`，条目包含对应字段。 | 一致。 |
| `GET /api/strings/score-diagnosis` | 发送 `pieceId`、`editionId`，合成测试附 `demo=1`；读取 `hasData`、`isDemo`、`measureIssues[].bbox/labels/measure`、`noteIssues[].bbox/label/verdict/measure`。 | `buildScoreDiagnosis` 返回相同形状；无数据时返回空数组并 `hasData=false`。 | 一致。 |

内容安全状态轮询、只读谱面图片/坐标属于上述学生流程的配套公开资源。小程序源码不调用 `controlled-submissions`、`run-batch`、复核接口、ops 接口或 `/data`。

本次删掉了上传页不必要的 `student-gate` 请求，页面直接使用受控试点文案；没有改动后端契约，也没有启用自动反馈。

## P2：公网守卫与内容安全

- `STUDENT_PUBLIC_ALLOWLIST` 只放行健康检查、学生提交/查询、只读谱面资源，以及微信内容安全状态、回调和临时媒体下载。
- 公网实测：`student-submissions`、`score-editions`、`score-diagnosis`、内容安全状态均可达；`controlled-submissions`、`run-batch` 和 `/data` 均返回 403。
- `WECHAT_MINIPROGRAM_APPID` 与 `project.config.json` 的 AppID 一致；AppSecret、回调 Token、EncodingAESKey 仅存在于根目录未提交的 `.env`。
- AppID/AppSecret 换取微信 access token 成功；当前 Token 生成的签名经公网回调 URL 验证成功；EncodingAESKey 形状检查通过。
- `ordinaryUploadAutoFeedbackReady`、`m3plusAutoFeedbackReady`、`m4OmrAutoScoreReady` 均为 `false`，策略保持 `fail-closed`。

## P3：真机状态

- 微信开发者工具可以编译体验版；提交代码使用 `project.config.json` 中的 `urlCheck=true`。
- 代码侧与公网链路已就绪。真机闭环仍需负责人在手机上完成一次新录音，并在本机复核台执行 `run-batch`、老师复核和 `releaseToStudent=true` 放行。
- 微信控制台的 request/upload/download 合法域名无法从仓库反查。体验版真机若能上传，即证明该项已生效；若提示域名非法，请按 `docs/wechat-content-safety-setup.md` 将 `https://api.stringinstrumentdiagnosis.icu` 同时加入三类合法域名。

真机验收顺序：

1. 扫体验版二维码，录音并提交。
2. 本机复核台运行批处理，老师填写学生反馈并放行。
3. 小程序“记录”下拉刷新，状态应从“排队中/老师复核中”变为“已反馈”。
4. 打开反馈页，再进入问题谱面，检查音准、节奏、漏音/错音使用不同颜色定位。

## 可重复检查

在仓库根目录运行：

```powershell
node 小程序/minicode-1/minitest/contract-audit.mjs
npm run test:western-public-access-guard
npm run test:wechat-content-safety
npm run test:western-student-gate
```
