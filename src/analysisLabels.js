export function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

export function parseXmlNoteId(noteId) {
  const text = String(noteId || "").trim();
  const match = text.match(/^xml-m(\d+)-n(\d+)$/i);
  if (!match) return null;
  return {
    measureIndex: Number(match[1]),
    noteIndex: Number(match[2]),
  };
}

export function formatMeasureLabel(measureIndex) {
  const numeric = Number(measureIndex);
  if (!Number.isFinite(numeric) || numeric <= 0) return "未定位小节";
  return `第 ${Math.round(numeric)} 小节`;
}

export function formatNoteLabel(noteId, fallbackMeasureIndex) {
  const parsed = parseXmlNoteId(noteId);
  if (parsed) {
    return `第 ${parsed.measureIndex} 小节 第 ${parsed.noteIndex} 音`;
  }
  const numericMeasure = Number(fallbackMeasureIndex);
  if (Number.isFinite(numericMeasure)) {
    return `第 ${Math.round(numericMeasure)} 小节`;
  }
  return String(noteId || "未定位音符");
}

export function formatPracticePathLabel(value) {
  if (value === "pitch-first") return "先修音准";
  if (value === "rhythm-first") return "先修节奏";
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
  if (value === "pitch-flat") return "音高偏低";
  if (value === "pitch-sharp") return "音高偏高";
  if (value === "pitch-review") return "音高需复核";
  if (value === "pitch-ok") return "音高基本正确";
  return "音高未标注";
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
  return "节奏未标注";
}

export function formatMeasureIssueLabelText(item) {
  const value = item?.issueType || item?.issueLabel;
  if (value === "rhythm-measure-rush") return "小节整体偏快";
  if (value === "rhythm-measure-drag") return "小节整体偏慢";
  if (value === "rhythm-measure-short") return "小节时值普遍偏短";
  if (value === "rhythm-measure-long") return "小节时值普遍偏长";
  if (value === "rhythm-unstable") return "节奏不稳";
  if (value === "pitch-unstable") return "音准不稳";
  return item?.issueLabel || "未标注问题类型";
}

export function formatSectionDisplayName(section) {
  const sectionId = String(section?.sectionId || section?.sourceSectionId || "");
  const pageChunkMatch = sectionId.match(/^page-(\d+)-s(\d+)$/i);
  if (pageChunkMatch) {
    return `自动识谱第 ${Number(pageChunkMatch[1])} 页 片段 ${Number(pageChunkMatch[2])}`;
  }
  const pageMatch = sectionId.match(/^page-(\d+)$/i);
  if (pageMatch) {
    return `自动识谱第 ${Number(pageMatch[1])} 页`;
  }
  return String(section?.title || sectionId || "未命名段落");
}

export function extractSectionPageNumber(section) {
  const candidates = [
    section?.sourceSectionId,
    section?.sectionId,
    section?.title,
  ].map((item) => String(item || ""));
  for (const candidate of candidates) {
    const match = candidate.match(/page[-\s]?0*(\d+)/i);
    if (match) return Number(match[1]);
  }
  return 1;
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
  if (!rawTitle) {
    return target?.measureIndex ? `重练第 ${target.measureIndex} 小节` : "优先处理本轮问题";
  }
  const targetId = String(target?.targetId || "");
  const readable = formatNoteLabel(targetId, target?.measureIndex);
  return rawTitle.replace(targetId, readable);
}

export function replaceXmlIdsInText(text) {
  return String(text || "").replace(/xml-m(\d+)-n(\d+)/gi, (_, measureIndex, noteIndex) => `第 ${Number(measureIndex)} 小节 第 ${Number(noteIndex)} 音`);
}

export function buildIssueSessionPayload({ analysis, score, section }) {
  return {
    analysis,
    score,
    section,
    savedAt: new Date().toISOString(),
  };
}
