# 实现规格 + 交接:复核台 → 训练数据账本(data engine)

> 面向协作者。目标:把老师日常复核升级成**逐音打标**,让每一次复核自动落成一条 (特征, 金标) 训练样本,被动攒出训真泛化模型所需的语料。**不翻任何学生开关、不接任何闸、不改现有冻结候选。**

## 0. 一句话
复核台加一层逐音打标控件 → 复核提交时把「逐音金标 + 机器特征快照 + 匿名 performer 元数据」写进一个**只追加、私有、gitignore** 的训练账本。结构 = Round 5 `position-truth.json` 那套(`completeErrorInventory` + 逐音标签),数据来源从"专门录"变成"复核白捡"。

## 1. 训练样本 schema(一次复核 = 一条记录)
以 JSONL 只追加方式写入 `data/private/western-strings-training-ledger/<recordingId>.jsonl`:
```json
{
  "ledgerContract": "western-strings-training-ledger-v1",
  "recordingId": "...", "submissionId": "...",
  "scoreId": "...", "scorePayloadSha256": "...",
  "audioPath": "data/private/...", "audioSha256": "...",
  "performerId": "anon-...", "deviceHint": "", "levelHint": "",
  "reviewedBy": "guanxingzhi", "reviewedAt": "2026-07-...Z",
  "completeErrorInventory": true,
  "noteLabels": [
    {"noteId": "xml-m5-n1", "noteIndex": 0, "measure": 5,
     "scoreMidi": 66, "label": "wrong_pitch"}
  ],
  "extraEvents": [
    {"kind": "extra", "afterNoteId": "xml-m5-n1", "performedMidi": 68,
     "startSeconds": 12.4, "endSeconds": 12.7, "note": ""}
  ],
  "machineSnapshot": {
    "candidateRowsPath": "data/experiments/.../offline-feature-candidates/<batch>/<submission>.json",
    "candidateRowsSha256": "...", "modelVersion": "...", "gateVersion": "..."
  },
  "consent": "yes", "licenseStatus": "local-only"
}
```
- `label ∈ {correct, wrong_pitch, missing, drag, uncertain}`(与 Round5 gate 命名一致:merged_substitution 归 `wrong_pitch`)；`extra` 没有对应谱音，必须进入独立的 `extraEvents`，不得伪挂到某个 noteId。
- `noteLabels` 可只写显式判断；未显式标的谱音在 `completeErrorInventory=true` 背书下计为隐式 `correct`。
- `machineSnapshot` 只存**指针 + SHA + 版本**,不复制特征本体(账本轻、可追溯)。`x`(逐音特征)在 candidateRows 里,`y`(标签)在 noteLabels 里,按 noteId 对齐。

## 2. UI 扩展(复核台逐音打标)
复核台已把两层 Policy C 输出(`confirmed_issue` / `self_check_hint`)画在谱面上。地基已有逐音复核原语 `action ∈ {confirm, correct, review_required}`(`src/server/westernStringsAlignmentService.js:2788`)——在其上加错误类型即可。每个谱音四种一键操作:
- **确认机器的标** → label = 机器判定的错误类型(确诊候选转正)。
- **否掉机器的标** → label = `correct`(← 宝贵的假阳负例)。
- **补机器漏掉的谱音错误** → 点谱上任一音,选 `wrong_pitch/missing/drag`(← 更宝贵的假阴正例)。
- **补多拉事件** → 在时间轴登记 `extraEvents`，可附相邻谱音锚点，但不把 `extra` 写成谱音标签。
- **拿不准** → `uncertain`(不进正/负,只标记)。
- 复核结束勾 **`completeErrorInventory`**(= 老师签"这条每个错误都标了"),未勾不入账本。

老师本来就要逐音听才能写反馈——这只把判断结构化,不加实质负担。

## 3. 落盘接入点
在现有复核写入流(`/api/strings/controlled-submissions/reviews`、`writeControlledSubmissionReview` 附近,`westernStringsAlignmentService.js:~1954-1973`)**之后**追加一步:若该复核带完整逐音标签且 `completeErrorInventory=true`,组装 §1 记录写训练账本。
- 训练账本与复核反馈流(`controlledSubmissionReviewsPath`)**分开存**:反馈给学生,账本攒数据,互不干扰。
- performer/device/level 元数据从提交 metadata 取；`performerId` 为防止未来按人切分泄漏而必填，device/level 可为空。

## 4. 统计脚本(盯里程碑)
冻结 `package.json` 期间直接运行 `node scripts/status-western-strings-training-ledger.mjs` 实时报:
- 总条数、**不同 performer 数**、各 `label` 计数、类别均衡度、最稀有类(拖拍)正例数。
- 里程碑判定:`≥300 条 / ≥30 人 / 拖拍正例 ≥200`。到点才提示"可做预注册从零训练实验"。

## 5. 不可破的纪律(必须在代码/测试里硬断言)
1. **账本只攒、不当闸**:它永不翻 `WESTERN_STUDENT_RUNTIME_GATE`、不授权、不自动采纳、不进 `project-status` 任何 ready/gate。加一条测试断言账本模块不 import 任何开关/闸。
2. **绝不拿账本调现有冻结候选**(Policy C / Round5/6 候选)——那是滚动数据调参。账本**专供将来"从零训练"**。
3. **按人切分**:训练前必须 `performerId` 维度切 train/val/test(不是按录音),并冻一份盲测、预注册门槛。故账本**现在就记 performerId**,否则将来切不动、泄漏。
4. **consent/隐私**同现有流程:有同意才入账;音频只在本机 `data/private`;`performerId` 匿名;账本 gitignore。
5. **标签质量**:对一小部分(如 10%)启用**双人复核**记 inter-rater,别默认单人金标绝对。

## 6. 要建的东西(清单)
1. 复核台 UI:逐音四态打标控件 + `completeErrorInventory` 签署(建在现有 `confirm/correct/review_required` 原语上)。
2. 复核写入流追加训练账本落盘(§1 schema,§3 接入点)。
3. `scripts/status-western-strings-training-ledger.mjs` 统计脚本(§4)。
4. 纪律测试:账本模块零开关/零闸依赖断言(§5.1);schema 校验;performerId 必填断言。

## 7. 明确不做
- 不用账本训练任何东西(现在只攒;训练是到量后另一个预注册实验)。
- 不改学生三开关、不动 Policy C / Round6 冻结候选、不进 fail-closed 闸链。
- 不把逐音标签暴露到学生端(学生只看老师放行的反馈,和现在一样)。

## 8. 相关现有锚点
- 复核写入:`src/server/westernStringsAlignmentService.js`(`controlledSubmissionReviewsPath`:389、`writeControlledSubmissionReview`:~1954、逐音原语:2788);路由 `src/server/westernStringsRoutes.js:353/378`。
- 逐音特征:`data/experiments/western-strings-m3/offline-feature-candidates/<batchRunId>/<submissionId>.json`(`buildCandidateNoteIdentityRows`:524)。
- 金标结构参照:`data/private/western-strings-round5/position-truth.json`。
- 开关(禁止接触):`src/server/westernStudentGateService.js:13`。
