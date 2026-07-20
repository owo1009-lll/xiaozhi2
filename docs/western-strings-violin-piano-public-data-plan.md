# 小提琴＋钢琴伴奏：公开数据与双域验收计划

更新：2026-07-20

## 当前结论

必须把“谱面里有钢琴声部”和“录音里有钢琴伴奏”当成两个独立域，不得用单声部结果互相外推。

- **结构化 MusicXML/MXL：可处理。** 新增 Violin + Piano 回归已以 `selectedPartHint=violin` 选中 Violin，置信度 0.96，仅保留 3/3 个目标小提琴音，钢琴和弦未混入。
- **未登记的小提琴＋钢琴拍照谱：不可声称能稳定处理。** M4a 只能处理已登记版本；M4b 开放域 OMR 仍未晋升。新增 OLiMPiC/Zeus camera challenger 在 5 张冻结小提琴真照片上仅得 pitch P/R=`8.05%/9.14%`、onset-quarter=`0.13%`、measure=`5.43%`、严格整页=`0/5`，已淘汰且未接运行时。多谱表页仍需先做系统/谱表/大谱表括号检测，再裁出小提琴谱表识别；钢琴谱表只作小节线和系统结构旁证。
- **小提琴＋钢琴混音：识别显著改善，但当前仍不可用于自动反馈。** MusicNet 公开“Accompanied Violin”上，原 Basic Pitch 未见演奏者 holdout 的 100ms P/R=`34.47%/49.81%`、双音 recall=`7.37%`。新增 YourMT3+ instrument-aware challenger 在各 60 秒诊断片段上达到 50ms P/R=`86.42%/70.35%`、100ms P/R=`96.30%/78.39%`；100ms precision 已过线，但 50ms 两项和 100ms recall 仍未过冻结门槛。开发录音上选出的 `+60ms` 偏移在 holdout 反向恶化，已拒绝，不用调参泄漏包装合格。

可复跑命令：

```powershell
npm run test:musicxml-import
npm run western:musicnet-accompanied-violin
npm run test:western-musicnet-accompanied-violin
npm run western:musicnet-yourmt3
npm run test:western-musicnet-yourmt3
npm run western:m4-zeus-challenger
npm run test:western-m4-zeus-challenger
```

本地报告：`data/experiments/western-strings-musicnet-accompanied-violin/report.json`、`data/experiments/western-strings-musicnet-yourmt3/report.json` 和 `data/experiments/western-strings-m4/zeus-challenger/report.json`。原始录音、模型、缓存和报告位于 gitignored `data/`，只提交去原始数据的冻结证据摘要。

## 公开数据的正确用法

### 谱面 / M4b

1. **OpenScore Lieder（CC0）**：绝大多数是上方单声部＋下方钢琴大谱表，非常适合训练“三谱表系统分组、括号识别、目标顶部谱表裁切”。它的上声部是声乐，只能做结构预训练，不能代替小提琴音符内容验收。
2. **OpenScore String Quartets（CC0）**：用于小提琴谱表内容、多声部标签和作品级拆分，不与同作品渲染变体跨 train/holdout。
3. **OLiMPiC / GrandStaff-LMX（OLiMPiC 为 CC BY-SA）**：用于钢琴大谱表、真实扫描和线性化 MusicXML 结构预训练。不将其钢琴内容指标写成小提琴识别指标。
4. **实际小提琴＋钢琴版本**：只从有清晰逐项权利的公版/CC 来源纳入，每件保留 URL、license、edition、下载日期和 SHA-256。不从“网上可下载”推导“可训练/可分发”。

DoReMi 干净数字谱适配已证明可提高数字谱 token accuracy，却使冻结真照片的 measure 从官方 Clarity 10.10% 降到 6.65%。因此不再重复“只加干净公开谱”；新训练必须对准多谱表结构与拍摄域。

### 音频 / 伴奏混音

1. **MusicNet（Zenodo 记录 CC BY 4.0）**：330 条古典录音、11 类乐器和超过 100 万个音符标签；先作为带乐器 ID 的多乐器训练/基准。官方说明标签仍约有 4% 误差，不得写成纯人工无噪声 gold。
2. **URMP**：官方同时给混音、独立乐器分轨、MIDI 和音符标注，适合做“混音→目标小提琴”的分离/转写对照。先做全量曲目与许可清单审计，未核清的条目只作评测，不进训练。
3. **架构结果与边界**：已用 YourMT3+ 多乐器 checkpoint 输出带 instrument token 的音符，并冻结为 all-strings 投影后进入评测。该 checkpoint 把 100ms precision 提到 96.30%，但 recall 仅 78.39%。其上游 GitHub 为 GPL-3.0，Hugging Face Space 与 checkpoint 未声明独立许可，且训练/评测来源包含 MusicNet；因此它只作架构诊断，不能作为独立发布证据或生产依赖。官方 MT3 仍可作研究对照，但旧 T5X/JAX 栈和 checkpoint/部署审计成本不改变学生域验收要求。

## 冻结验收门槛

### 多谱表拍照谱

- 目标小提琴谱表 recall `>=99%`，钢琴谱表误纳入 `=0`。
- 小节框 F1 `>=95%`，系统数＋逐系统小节数整页全对率 `>=90%`。
- 小提琴内容继续使用 M4 原严格门槛：pitch P `>=98%`、R `>=95%`、onset-quarter `>=95%`、measure `>=95%`，逐页通过率 `>=90%`。
- train/calibration/holdout 按作品和版本拆分；同一源谱的渲染、透视、模糊变体不得跨拆分。

### 伴奏混音

- 独立音频转写，不借谱面候选；50ms P/R `>=90%/80%`，100ms P/R `>=90%/85%`。
- 另报双音/重叠音、钢琴同音高、延音踏板和弱音子组；不得用总体指标遮蔽子组失败。
- 新架构必须在 MusicNet 未见作品/演奏者 holdout 上过门，且单小提琴冻结集不回归。
- 公开专业录音过门仍只能产生 research candidate。学生端开放前必须另有真实学生伴奏录音、人工逐音 gold 和显式授权。

## 下一步

1. 音频线下一位候选应采用许可清楚、与 release holdout 无训练重叠的目标条件转写或“分离小提琴→单声部 V2”架构；先用 URMP 独立分轨审计建立可定位的钢琴串扰/漏检子组，不继续扫单录音偏移或 Basic Pitch 后处理阈值。
2. 谱面线先用 OpenScore Lieder 训练系统/谱表/括号结构前置，再在作品和版本隔离的真实拍摄域做迁移；Zeus 负结果证明不能直接把钢琴大谱表 camera checkpoint 当作小提琴内容模型。
3. M4b 晋升仍须执行现成 capture pack 的至少 30 张/6 版式/3 设备真照片与逐页结构标注；V2 学生端仍须全新真实学生录音、逐音人工 gold、fresh-blind 验收和显式发布授权。两者都不能由公开专业数据代替。
