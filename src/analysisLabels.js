export function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

export const ISSUE_SESSION_SCHEMA_VERSION = 7;
export const ISSUE_SESSION_STORAGE_PREFIX = "ai-erhu.issue-session.v7.";
export const LEGACY_ISSUE_SESSION_STORAGE_PREFIX = "ai-erhu.issue-session.";

export function repairMojibakeText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/[\u00c0-\u00ff]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(Array.from(text).map((char) => char.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
    return decoded && !/[\u00c0-\u00ff]/.test(decoded) ? decoded : text;
  } catch {
    return text;
  }
}

export function formatScoreTitle(scoreOrTitle) {
  const rawTitle = typeof scoreOrTitle === "string" ? scoreOrTitle : scoreOrTitle?.title;
  return repairMojibakeText(rawTitle) || "未命名曲目";
}

export function parseXmlNoteId(noteId) {
  const text = String(noteId || "").trim();
  const match = text.match(/^xml-m(\d+)-n(\d+)$/i);
  if (!match) return null;
  return { measureIndex: Number(match[1]), noteIndex: Number(match[2]) };
}

export function getApproximateNotePosition(noteId, fallbackMeasureIndex, fallbackOrder = 0) {
  const parsed = parseXmlNoteId(noteId);
  if (parsed) return parsed;
  return {
    measureIndex: Number(fallbackMeasureIndex) || 1,
    noteIndex: Math.max(1, Number(fallbackOrder) || 1),
  };
}

export function formatMeasureLabel(measureIndex) {
  const numeric = Number(measureIndex);
  if (!Number.isFinite(numeric) || numeric <= 0) return "未定位小节";
  return `第 ${Math.round(numeric)} 小节`;
}

export function formatNoteLabel(noteId, fallbackMeasureIndex) {
  const parsed = parseXmlNoteId(noteId);
  if (parsed) return `第 ${parsed.measureIndex} 小节第 ${parsed.noteIndex} 音`;
  const numericMeasure = Number(fallbackMeasureIndex);
  if (Number.isFinite(numericMeasure)) return `第 ${Math.round(numericMeasure)} 小节`;
  return String(noteId || "未定位音位");
}

export function formatPracticePathLabel(value) {
  if (value === "pitch-first") return "先处理音准";
  if (value === "rhythm-first") return "先处理节奏";
  return "先复核";
}

export function formatPreprocessModeLabel(value) {
  if (value === "erhu-focus" || value === "melody-focus") return "二胡增强 / 钢琴抑制";
  if (value === "off") return "关闭";
  return "自动";
}

export function formatSourceLabel(value) {
  if (value === "torchcrepe") return "torchcrepe";
  if (value === "madmom-rnn-onset" || value === "madmom-rnn-onset-relaxed") return "madmom RNN onset";
  if (value === "madmom-rnn-beat") return "madmom RNN beat";
  if (value === "madmom-onset-beat-grid") return "madmom onset beat grid";
  if (value === "librosa-onset") return "librosa onset";
  if (value === "librosa-pyin") return "librosa pYIN";
  if (value === "score-fallback" || value === "score-beat-fallback") return "score fallback";
  if (value === "synthetic") return "synthetic";
  return String(value || "unknown");
}

export function formatPitchLabelText(value) {
  if (value === "pitch-flat") return "音准偏低";
  if (value === "pitch-sharp") return "音准偏高";
  if (value === "pitch-review") return "音准需要复核";
  if (value === "pitch-ok") return "音准基本正常";
  return "音准问题";
}

export function formatRhythmLabelText(item) {
  const value = item?.rhythmType || item?.rhythmLabel;
  if (item?.rhythmTypeLabel) return item.rhythmTypeLabel;
  if (value === "rhythm-rush") return "节奏抢拍";
  if (value === "rhythm-drag") return "节奏拖拍";
  if (value === "rhythm-duration-short") return "时值偏短";
  if (value === "rhythm-duration-long") return "时值偏长";
  if (value === "rhythm-rush-short") return "抢拍且时值偏短";
  if (value === "rhythm-drag-long") return "拖拍且时值偏长";
  if (value === "rhythm-missing") return "疑似漏音";
  if (value === "rhythm-unstable") return "节奏不稳";
  return "节奏问题";
}

export function formatMeasureIssueLabelText(item) {
  const value = item?.issueType || item?.issueLabel;
  if (value === "rhythm-measure-rush") return "本小节整体偏快";
  if (value === "rhythm-measure-drag") return "本小节整体偏慢";
  if (value === "rhythm-measure-short") return "本小节时值普遍偏短";
  if (value === "rhythm-measure-long") return "本小节时值普遍偏长";
  if (value === "rhythm-unstable") return "本小节节奏不稳";
  if (value === "pitch-unstable") return "本小节音准不稳";
  return item?.issueLabel || "问题小节";
}

export function formatSectionDisplayName(section) {
  const title = repairMojibakeText(section?.displayTitle || section?.title);
  const isInternalTitle =
    /^page-\d+/i.test(title) ||
    /^xml-/i.test(title) ||
    /^自动识谱第\s*\d+\s*页/i.test(title);
  if (title && !isInternalTitle) return title;
  const sectionId = String(section?.sectionId || section?.sourceSectionId || "");
  const explicitOrder = Number(section?.displayIndex);
  const sequenceIndex = Number(section?.sequenceIndex);
  const sectionOrder = Number(section?.order ?? section?.index);
  const readableOrder =
    (Number.isFinite(explicitOrder) && explicitOrder > 0 && explicitOrder) ||
    (Number.isFinite(sectionOrder) && sectionOrder > 0 && sectionOrder) ||
    (Number.isFinite(sequenceIndex) && sequenceIndex > 0 && sequenceIndex < 100 && sequenceIndex) ||
    null;
  if (readableOrder) return `第 ${Math.round(readableOrder)} 段`;
  const pageChunkMatch = sectionId.match(/^page-(\d+)-s(\d+)$/i);
  if (pageChunkMatch) return `第 ${Number(pageChunkMatch[1])}-${Number(pageChunkMatch[2])} 段`;
  const pageMatch = sectionId.match(/^page-(\d+)$/i);
  if (pageMatch) return `第 ${Number(pageMatch[1])} 段`;
  return title && !isInternalTitle ? title : "未命名段落";
}

export function extractSectionPageNumber(section) {
  const candidates = [section?.sourceSectionId, section?.sectionId, section?.title].map((item) => String(item || ""));
  for (const candidate of candidates) {
    const match = candidate.match(/page[-\s]?0*(\d+)/i);
    if (match) return Number(match[1]);
  }
  return Number(section?.pageNumber) || 1;
}

export function getSectionMeasureCount(section) {
  const explicit = Number(section?.measureCount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  const inferred = Math.max(0, ...notes.map((item) => Number(item?.measureIndex) || 0));
  return inferred || 1;
}

export function getDisplayPitchScore(item) {
  return Math.round(Number(item?.studentPitchScore ?? item?.overallPitchScore ?? 0));
}

export function getDisplayRhythmScore(item) {
  return Math.round(Number(item?.studentRhythmScore ?? item?.overallRhythmScore ?? 0));
}

export function getDisplayCombinedScore(item) {
  if (item?.studentCombinedScore != null) return Math.round(Number(item.studentCombinedScore || 0));
  if (item?.weightedStudentCombinedScore != null) return Math.round(Number(item.weightedStudentCombinedScore || 0));
  if (item?.weightedCombinedScore != null) return Math.round(Number(item.weightedCombinedScore || 0));
  return Math.round((getDisplayPitchScore(item) + getDisplayRhythmScore(item)) / 2);
}

export function formatPracticeTargetTitle(target) {
  const rawTitle = String(target?.title || "").trim();
  if (!rawTitle) return target?.measureIndex ? `重练第 ${target.measureIndex} 小节` : "优先处理本轮问题";
  const targetId = String(target?.targetId || "");
  return rawTitle.replace(targetId, formatNoteLabel(targetId, target?.measureIndex));
}

export function replaceXmlIdsInText(text) {
  return String(text || "").replace(/xml-m(\d+)-n(\d+)/gi, (_, measureIndex, noteIndex) => `第 ${Number(measureIndex)} 小节第 ${Number(noteIndex)} 音`);
}

export function buildIssueSessionPayload({ analysis, score, section, mode = "section", originalAudio = null, issueItems = [] }) {
  return {
    schemaVersion: ISSUE_SESSION_SCHEMA_VERSION,
    scoreIssueSchemaVersion: ISSUE_SESSION_SCHEMA_VERSION,
    mode,
    analysis,
    score,
    section: mode === "whole-piece" ? null : section,
    originalAudio,
    issueItems,
    savedAt: new Date().toISOString(),
  };
}
