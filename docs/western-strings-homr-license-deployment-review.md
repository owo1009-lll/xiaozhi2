# HOMR 0.7.0 许可证与部署审查记录

## 1. 当前决定

机器权威记录为 `config/third-party/homr-0.7.0-review.json`。当前 `decision.status=approved-with-conditions`，具名审查人为 `guanxingzhi (project owner; evidence review delegated to Claude agent, 2026-07-17)`；唯一批准范围是 `controlled-offline-review-only`。学生端网络使用、自动采纳与再分发仍未获批准。

这份记录是工程治理依据，不是法律意见。AGPL 的最终适用范围取决于实际部署、分发、修改和网络交互方式。

## 2. 已核实事实

- HOMR 0.7.0 的上游仓库和本地 wheel METADATA 均声明 `AGPL-3.0`。
- 稳定运行时 `data/tools/homr-0.7.0-ort1.27.0` 中 49 个带 RECORD 哈希的文件全部匹配，包含当前 `Scripts/homr.exe` launcher，未发现已安装 HOMR 文件被修改。保留的 `homr-0.7.0-py3-none-any.whl` 另有固定字节数和 SHA-256；由于未找到上游独立发布的 wheel checksum，当前具名审查已明确按保留 wheel、portable RECORD 与本地安装分发的精确哈希作为受控离线采用依据。
- Windows pip launcher 会嵌入解释器绝对路径，所以旧实验 venv 与稳定 runtime 的 `homr.exe` 字节哈希不同。跨路径审批不绑定这个 host-specific 哈希，而绑定排除 launcher 行、统一 LF 后的 portable RECORD 摘要，以及 `homr=homr.main:main` console-entry-point 契约；live preflight 仍逐项验证本机 RECORD，包含 launcher 在内必须 49/49、零 mismatch。
- 正式 analyzer 主线只把 HOMR 暴露为不可执行的 secondary candidate。
- 离线 v3 候选池以独立 CLI 子进程调用 HOMR，输入为本地图片文件，输出为 MusicXML 和日志；项目进程不 `import homr`。
- 受控 batch 只选取最新复核操作为 `accepted_for_batch` 的提交，并强制 `studentFacing=false` 与 `autoDiagnosisIssued=false`。
- 受控生产 wrapper 必须传入 `--require-complete-engine-pool`；Audiveris/HOMR 任一 executable 缺失时在音频解码或 OMR 前以 `required-engine-pool-incomplete` 失败。只有未带该 flag 的直接研究运行允许 Audiveris-only，并必须在 audit 中标记 degraded pool。
- HOMR 在模型缺失时会从上游 GitHub release 下载 ONNX checkpoint。当前运行时所需的三个 HOMR checkpoint 和三个 RapidOCR ONNX 文件已作为完整六文件集合写入权威 JSON；具名审查已逐文件绑定哈希并记录 HOMR AGPL-3.0、RapidOCR/PaddleOCR Apache-2.0 的采用依据。由于各权重没有独立许可证文本，再分发仍明确禁止。

## 3. 范围边界

当前已显式审批的唯一范围是 `controlled-offline-review-only`：

- 本地受控 batch；
- 人工 `accepted_for_batch` 前置；
- 必须经由带 `--require-complete-engine-pool` 的受控生产 wrapper；
- 产物只进入教师/内部复核；
- 不开启正式 analyzer 主线 HOMR 执行；
- 不面向学生发布或自动采纳；
- 不再分发 HOMR wheel、源码、venv 或模型 checkpoint。

下列任一变化均使旧批准失效：HOMR 版本、保留 wheel、portable RECORD、METADATA、LICENSE、console entry point、完整六模型集合或部署目标变化；转为进程内导入/链接；修改 HOMR 源码；integration contract 版本变化；学生端网络使用或再分发模式变化。批准范围必须精确等于唯一的 `controlled-offline-review-only`，不能混入额外 scope。

## 4. 具名决定命令

显式暂缓/否决：

```powershell
node scripts/record-western-homr-license-review.mjs --decision defer --by "reviewer-name"
```

仅批准受控离线复核范围：

```powershell
node scripts/record-western-homr-license-review.mjs `
  --decision approve `
  --by "reviewer-name" `
  --model-license-basis "reviewed evidence or legal basis" `
  --confirm-controlled-offline-only `
  --confirm-model-license-basis `
  --confirm-no-model-redistribution
```

`approve` 必须同时具备：非空审查人、可解释且覆盖完整六模型集合的许可依据、受控离线范围确认、模型许可依据已复核确认，以及不再分发确认。命令不提供任何学生端、网络生产或再分发批准开关；生成的 binding 会锁定 stable runtime 的 executable 契约、保留 wheel、portable RECORD、METADATA、LICENSE、部署目标和完整模型集合。

## 5. 部署状态

许可证范围批准不等于部署就绪。工程侧已完成下列固化：

- 音频解释器位于 `data/tools/western-photo-score-audio-py311`，实测 Basic Pitch 0.4.0、TensorFlow 2.15.0、NumPy 1.26.4；
- HOMR 独立环境位于 `data/tools/homr-0.7.0-ort1.27.0`，由 27 项精确锁和本地 wheelhouse 离线重建，实测 HOMR 0.7.0、ONNX Runtime 1.27.0、NumPy 2.4.6、CPU Provider；
- HOMR wheel 的全部 49 个 RECORD 哈希项、portable RECORD 摘要、保留 wheel 以及六个 HOMR/RapidOCR ONNX 文件均由 preflight 校验；任一缺失或漂移直接失败，不允许生产启动触发临时下载；
- Audiveris 5.10.2、音频环境、HOMR 环境、METADATA、LICENSE、`pip check` 和完整引擎池由 `npm run western:photo-score-deployment-preflight` 统一验证；
- batch、服务端和 CLI 均走精确 wrapper；通用 `run-python.ps1` 的回退行为不再进入照片谱生产路径。

2026-07-18 本机 live preflight 为 `governanceReady=true`,`hostReady=true`,`deploymentReady=true`，三个组件 audio/Audiveris/HOMR 全部 ready，HOMR RECORD 为 49/49 且零 mismatch，六个模型、保留 wheel 与 approval binding 均逐项匹配。运行时、wheelhouse 与模型包位于 Git 忽略的 `data/tools/`，每台部署机和每次启动仍必须携带获准的本地包后运行：

```powershell
npm run western:photo-score-runtime-setup
npm run western:photo-score-deployment-preflight
```

因此当前静态治理状态是 `deployment.status=controlled-offline-approved-preflight-required`；本机 live preflight 对该受控离线范围三绿。它不等于学生端/网络生产许可，也不授权自动采纳或再分发。preflight 产物同时绑定当前 review record、deployment manifest 和 runtime lock 的 SHA-256；三者任一发生变化，旧绿报告都会自动失效并要求重跑。

## 6. 复核命令

```powershell
node scripts/test-western-homr-license-review.mjs
node scripts/audit-homr-boundary.mjs
```

边界审计会在 pending/deferred 时保持机器检查可运行，但明确输出 `licenseReviewReady=false`。它只有在批准记录同时满足具名、三项显式确认与 contract/artifact binding 时才输出 `licenseReviewReady=true`。
