export const PATH_OPTIONS = [
  { value: "pitch-first", label: "先修音准" },
  { value: "rhythm-first", label: "先修节奏" },
  { value: "review-first", label: "先复核" },
];

export function parseList(value) {
  if (Array.isArray(value)) return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  return Array.from(new Set(String(value || "").split(/[\s,;|，；]+/).map((item) => item.trim()).filter(Boolean)));
}

export function parseNumberList(value) {
  return parseList(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => Math.round(item));
}

export function parseXmlNoteId(noteId) {
  const match = String(noteId || "").match(/^xml-m(\d+)-n(\d+)$/i);
  if (!match) return null;
  return { measureIndex: Number(match[1]), noteOrdinal: Number(match[2]) };
}

export function notePosition(finding = {}, fallbackOrder = 1) {
  const parsed = parseXmlNoteId(finding.noteId);
  return {
    measureIndex: Number(finding.measureIndex) || parsed?.measureIndex || 1,
    noteOrdinal: Number(finding.noteIndex) || parsed?.noteOrdinal || fallbackOrder,
  };
}

export function noteDisplayLabel(finding = {}, fallbackOrder = 1) {
  const position = notePosition(finding, fallbackOrder);
  return `第 ${position.measureIndex} 小节 · 第 ${position.noteOrdinal} 个音`;
}

export function noteLabelFromLocator(locatorNote, finding = {}, fallbackOrder = 1) {
  return locatorNote?.label || noteDisplayLabel(finding, fallbackOrder);
}

export function measureDisplayLabel(measureIndex) {
  const numeric = Math.max(1, Math.round(Number(measureIndex) || 1));
  return `第 ${numeric} 小节`;
}

export function measureLabelFromLocator(locatorMeasure, measureIndex) {
  return locatorMeasure?.label || measureDisplayLabel(measureIndex);
}

export function formatSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${numeric.toFixed(2)}s`;
}

export function percentStyle(value) {
  const numeric = Math.max(0, Math.min(1, Number(value) || 0));
  return `${numeric * 100}%`;
}

export function joinList(values) {
  return parseList(values).join("|");
}

export function joinNumberList(values) {
  return parseNumberList(values).join("|");
}

export function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${Math.round(numeric * 100)}%`;
}

export function pathLabel(value) {
  return PATH_OPTIONS.find((item) => item.value === value)?.label || "先复核";
}

export function severityLabel(value) {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  if (value === "low") return "低";
  return value || "-";
}

export function findingText(finding = {}) {
  return [
    finding.pitchLabel || finding.rhythmLabel || finding.issueKind || finding.label || finding.severity,
    finding.why,
    finding.action,
  ].filter(Boolean).join(" · ");
}

export function makeDraft(item, raterId) {
  const review = item?.review || {};
  return {
    raterId: review.raterId || raterId || "teacher-1",
    reviewStatus: review.reviewStatus || "pending",
    includeInBaseline: review.includeInBaseline === "no" ? "no" : "yes",
    overallAgreement: review.overallAgreement || 4,
    teacherPrimaryPath: review.teacherPrimaryPath || "",
    teacherIssueNoteIds: review.teacherIssueNoteIds || "",
    teacherIssueMeasureIndexes: review.teacherIssueMeasureIndexes || "",
    comments: review.comments || "",
  };
}
