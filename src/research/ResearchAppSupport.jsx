export const SESSION_STAGE_OPTIONS = [
  { value: "pretest", label: "前测" },
  { value: "week1", label: "第 1 周" },
  { value: "week2", label: "第 2 周" },
  { value: "week3", label: "第 3 周" },
  { value: "week4", label: "第 4 周" },
  { value: "week5", label: "第 5 周" },
  { value: "week6", label: "第 6 周" },
  { value: "week7", label: "第 7 周" },
  { value: "week8", label: "第 8 周" },
  { value: "posttest", label: "后测" },
];

export const APP_TABS = [
  { id: "workspace", label: "受试工作台" },
  { id: "dashboard", label: "研究总览" },
  { id: "protocol", label: "协议说明" },
];

export const EXPERIENCE_QUESTIONS = [
  { key: "usefulness", label: "AI 反馈对本轮练习有帮助" },
  { key: "easeOfUse", label: "系统易于理解和操作" },
  { key: "feedbackClarity", label: "错音与错拍提示足够清晰" },
  { key: "confidence", label: "使用后更有信心改进演奏" },
  { key: "continuance", label: "愿意在课后继续使用该工具" },
];

export const DEFAULT_EXPERIENCE = Object.fromEntries(EXPERIENCE_QUESTIONS.map((item) => [item.key, 3]));
export const DEFAULT_PROFILE = {
  alias: "",
  institution: "",
  major: "",
  grade: "",
  yearsOfTraining: 0,
  weeklyPracticeMinutes: 0,
  deviceLabel: "",
  consentSigned: false,
  notes: "",
};
export const DEFAULT_EXPERT_RATING = {
  participantId: "",
  stage: "pretest",
  pitchScore: 80,
  rhythmScore: 80,
  raterId: "expert-1",
  comments: "",
};
export const DEFAULT_TASK_PLAN = {
  taskId: "",
  stage: "week1",
  pieceId: "",
  sectionId: "",
  focus: "",
  instructions: "",
  practiceTargetMinutes: 30,
  dueDate: "",
  status: "assigned",
  assignedBy: "researcher-1",
};
export const DEFAULT_INTERVIEW_NOTE = {
  interviewId: "",
  stage: "posttest",
  interviewerId: "researcher-1",
  summary: "",
  barriers: "",
  strategyChanges: "",
  representativeQuote: "",
  nextAction: "",
  followUpNeeded: false,
};
export const DEFAULT_SAMPLING_MARK = {
  selected: false,
  priority: "candidate",
  reason: "",
  markedBy: "researcher-1",
};
export const DEFAULT_VALIDATION_REVIEW = {
  analysisId: "",
  raterId: "expert-1",
  overallAgreement: 4,
  teacherPrimaryPath: "review-first",
  teacherIssueNoteIds: "",
  teacherIssueMeasureIndexes: "",
  comments: "",
};
export const DEFAULT_ADJUDICATION = {
  analysisId: "",
  adjudicatorId: "researcher-1",
  finalPrimaryPath: "review-first",
  finalIssueNoteIds: "",
  finalIssueMeasureIndexes: "",
  triggerReasons: "",
  comments: "",
};

export function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(safeNumber(value))));
}

export function plusNumber(value) {
  if (value == null || value === "") return "—";
  const numeric = safeNumber(value, NaN);
  if (!Number.isFinite(numeric)) return "—";
  return numeric > 0 ? `+${numeric}` : `${numeric}`;
}

export function severityText(value) {
  if (value === "high") return "高优先级";
  if (value === "medium") return "中优先级";
  return "低优先级";
}

export function confidenceText(value) {
  const numeric = safeNumber(value, NaN);
  if (!Number.isFinite(numeric)) return "未报告";
  return `${Math.round(numeric * 100)}%`;
}

export function practicePathLabel(value) {
  if (value === "pitch-first") return "先修音准";
  if (value === "rhythm-first") return "先修节奏";
  return "先复核";
}

export function pitchLabelText(value) {
  if (value === "pitch-flat") return "音高偏低";
  if (value === "pitch-sharp") return "音高偏高";
  if (value === "pitch-review") return "音高需复核";
  if (value === "pitch-ok") return "音高基本正确";
  return value || "音高未标注";
}

export function rhythmLabelText(item) {
  const value = item?.rhythmType || item?.rhythmLabel;
  if (item?.rhythmTypeLabel) return item.rhythmTypeLabel;
  if (value === "rhythm-rush") return "节奏抢拍";
  if (value === "rhythm-drag") return "节奏拖拍";
  if (value === "rhythm-duration-short") return "时值偏短";
  if (value === "rhythm-duration-long") return "时值偏长";
  if (value === "rhythm-rush-short") return "抢拍且时值偏短";
  if (value === "rhythm-drag-long") return "拖拍且时值偏长";
  if (value === "rhythm-missing") return "疑似漏音或起拍未捕获";
  if (value === "rhythm-unstable") return "节奏不稳";
  if (value === "rhythm-ok") return "节奏基本正确";
  return value || "节奏未标注";
}

export function measureIssueLabelText(item) {
  const value = item?.issueType || item?.issueLabel;
  if (value === "rhythm-measure-rush") return "小节整体偏快";
  if (value === "rhythm-measure-drag") return "小节整体偏慢";
  if (value === "rhythm-measure-short") return "小节时值普遍偏短";
  if (value === "rhythm-measure-long") return "小节时值普遍偏长";
  if (value === "rhythm-unstable") return "节奏不稳";
  if (value === "pitch-unstable") return "音准不稳";
  return item?.issueLabel || "问题类型未标注";
}

export function preprocessModeLabel(value) {
  if (value === "melody-focus") return "伴奏抑制 / 旋律增强";
  return "关闭";
}

export function formatDateTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function getAudioMimeType() {
  if (typeof window === "undefined" || !window.MediaRecorder?.isTypeSupported) {
    return "";
  }
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((item) => window.MediaRecorder.isTypeSupported(item)) || "";
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取音频失败"));
    reader.readAsDataURL(file);
  });
}

export function getAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const objectUrl = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.src = objectUrl;
    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      audio.removeAttribute("src");
      audio.load();
    };
    audio.onloadedmetadata = () => {
      const duration = Number(audio.duration);
      cleanup();
      resolve(Number.isFinite(duration) ? duration : null);
    };
    audio.onerror = () => {
      cleanup();
      resolve(null);
    };
  });
}

export function parseBatchParticipantText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t|,/).map((item) => item.trim()))
    .filter((parts) => parts[0] && parts[0].toLowerCase() !== "participantid")
    .map((parts) => ({
      participantId: parts[0],
      groupId: parts[1] || "experimental",
      profile: {
        alias: parts[2] || "",
        institution: parts[3] || "",
        grade: parts[4] || "",
      },
    }));
}

export function SectionTitle({ step, title, description }) {
  return (
    <div className="section-title">
      <span className="section-step">{step}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

export function ScoreBadge({ label, value, accent, suffix = "" }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong style={{ color: accent }}>
        {clampScore(value)}
        {suffix}
      </strong>
    </div>
  );
}

export function RangeQuestion({ label, value, onChange }) {
  return (
    <label className="range-question">
      <span>{label}</span>
      <div className="range-row">
        <input type="range" min="1" max="5" step="1" value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <strong>{value}</strong>
      </div>
    </label>
  );
}

export function TabButton({ active, onClick, children }) {
  return (
    <button type="button" className={`tab-button${active ? " is-active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function GroupOverviewCard({ group }) {
  return (
    <div className="summary-card">
      <h4>{group.groupId === "experimental" ? "实验组" : "对照组"}</h4>
      <p>参与者：{group.participantCount}</p>
      <p>完成前后测配对：{group.completedPairCount}</p>
      <p>平均音准增益：{group.averagePitchGain}</p>
      <p>平均节奏增益：{group.averageRhythmGain}</p>
      <p>平均有用性：{group.averageUsefulness}</p>
      <p>平均持续使用：{group.averageContinuance}</p>
    </div>
  );
}

export function ExportLink({ dataset, format, children }) {
  return (
    <a className="secondary-link" href={`/api/erhu/research/export?dataset=${dataset}&format=${format}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function TemplateDownloadLink({ templateId, children }) {
  return (
    <a className="secondary-link" href={`/api/erhu/research/templates/${templateId}?format=md`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
