export function percentText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : "0%";
}

export function scoreImportQualityText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "未开始";
  if (numeric >= 0.85) return "较好";
  if (numeric >= 0.65) return "可用，建议复核";
  return "需复核";
}

export function scoreImportStatusText(job) {
  if (!job) return "未开始";
  if (job.omrStatus === "completed") return "已完成";
  if (job.omrStatus === "failed") return "未通过";
  if (job.stage === "queued") return "排队中";
  if (job.omrStatus === "processing") return "处理中";
  return "未开始";
}

export function hasScoreMusicXmlFallback(job) {
  if (!job) return false;
  const actions = Array.isArray(job.fallbackActions) ? job.fallbackActions : [];
  return Boolean(job.musicxmlFallbackAvailable || actions.includes("import-musicxml"));
}

export function getOmrQualityGate(job, score) {
  return job?.omrQualityGate || job?.omrStats?.qualityGate || score?.omrQualityGate || score?.omrStats?.qualityGate || null;
}

export function omrGateRequiresReview(gate) {
  const status = String(gate?.status || "").toLowerCase();
  if (status === "block" || status === "review") return true;
  const reasons = Array.isArray(gate?.blockingReasons) ? gate.blockingReasons : [];
  return reasons.length > 0;
}

export function friendlyErrorMessage(errorOrMessage, fallback = "操作失败，请稍后重试。") {
  const raw = typeof errorOrMessage === "string" ? errorOrMessage : errorOrMessage?.message;
  const text = String(raw || "").trim();
  if (!text) return fallback;
  const lower = text.toLowerCase();
  if (/failed to fetch|networkerror|econnrefused|connection refused|load failed/.test(lower)) {
    return "暂时无法连接诊断程序，请确认应用已启动后重试。";
  }
  if (/外部识谱服务|audiveris|omr|musicxml/.test(lower)) {
    return "自动识谱暂时不可用，请稍后重试。";
  }
  if (/\b(analysis|score|job|request failed|not found|http|external)\b|外部分析器|analyzer|piece-pass|score import|traceback|exception|stack|enoent|eacces|localhost|127\.0\.0\.1|\/api\/|https?:\/\/|[a-z]:\\|python|uvicorn|json|error:/i.test(text)) {
    return fallback;
  }
  return text.length > 120 ? fallback : text;
}

export function friendlyStatusMessage(message, fallback) {
  const text = String(message || "").trim();
  if (!text) return fallback;
  if (/\b(analysis|score|job|request failed|not found|http|external|omr)\b|外部分析器|analyzer|piece-pass|score import|traceback|exception|stack|enoent|eacces|localhost|127\.0\.0\.1|\/api\/|https?:\/\/|[a-z]:\\|python|uvicorn|json|error:/i.test(text)) {
    return fallback;
  }
  return text.length > 160 ? fallback : text;
}

export function getPartCandidates(job, score) {
  return (Array.isArray(job?.partCandidates) && job.partCandidates.length ? job.partCandidates : score?.partCandidates || [])
    .filter(Boolean);
}

export function getPartCandidateKey(candidate, index = 0) {
  return String(candidate?.selectionKey || candidate?.id || candidate?.qualifiedLabel || candidate?.label || candidate?.name || `part-${index + 1}`);
}

export function getSelectedPartKey(job, score) {
  return String(job?.selectedPartId || job?.selectedPart || score?.selectedPartId || score?.selectedPart || "");
}

export function getSelectedPartConfidence(job, score) {
  if (hasReliableErhuLineSplit(score)) {
    const scoreConfidence = Number(score?.selectedPartConfidence);
    const jobConfidence = Number(job?.selectedPartConfidence);
    const bestKnown = Math.max(
      Number.isFinite(scoreConfidence) ? scoreConfidence : 0,
      Number.isFinite(jobConfidence) ? jobConfidence : 0,
    );
    return Math.max(bestKnown, 0.88);
  }
  const numeric = Number(job?.selectedPartConfidence ?? score?.selectedPartConfidence);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function hasReliableErhuLineSplit(score) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  if (!sections.length) return false;
  let erhuNotes = 0;
  let roleTaggedNotes = 0;
  let sectionsWithErhu = 0;
  for (const section of sections) {
    let sectionErhuNotes = 0;
    for (const note of Array.isArray(section?.notes) ? section.notes : []) {
      const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
      const confidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
      if (role) roleTaggedNotes += 1;
      if (role === "erhu" && confidence >= 0.66) {
        erhuNotes += 1;
        sectionErhuNotes += 1;
      }
    }
    if (sectionErhuNotes > 0) sectionsWithErhu += 1;
  }
  return erhuNotes >= 12 && sectionsWithErhu >= 2 && roleTaggedNotes >= erhuNotes;
}

export function isAccompanimentCandidate(candidate) {
  const label = String(candidate?.label || candidate?.name || candidate?.role || "").toLowerCase();
  return /piano|pno|pn\.|伴奏|钢琴|accompaniment/.test(label);
}

export function needsPartReview(job, score) {
  if ((job?.omrStatus || score?.omrStatus) !== "completed") return false;
  if (omrGateRequiresReview(getOmrQualityGate(job, score))) return true;
  if (job?.selectedPartConfirmed || score?.selectedPartConfirmed) return false;
  if (hasReliableErhuLineSplit(score)) return false;
  const candidates = getPartCandidates(job, score);
  if (candidates.length <= 1) return false;
  return getSelectedPartConfidence(job, score) > 0 && getSelectedPartConfidence(job, score) < 0.7;
}

export function formatPartCandidateLabel(candidate, index = 0) {
  const noteCount = Number(candidate?.noteCount);
  const measureCount = Number(candidate?.measureCount);
  const isAccompaniment = isAccompanimentCandidate(candidate);
  const details = [];
  if (Number.isFinite(noteCount)) details.push(`${noteCount} 个音`);
  if (Number.isFinite(measureCount)) details.push(`${measureCount} 小节`);
  const prefix = isAccompaniment ? `伴奏行 ${index + 1}（通常不要选）` : `旋律行 ${index + 1}`;
  return `${prefix}${details.length ? `：${details.join("，")}` : ""}`;
}

export function importProgressHeadline(job) {
  if (job?.cacheHit) return "曲谱已准备好";
  if (job?.omrStatus === "failed") return "识谱失败";
  if (job?.omrStatus === "completed") return "识谱完成";
  if (job?.stage === "queued") return "正在排队识谱";
  if (job?.stage === "omr-running") return "正在识谱";
  if (job?.stage === "building-piecepack") return "正在整理段落";
  return "正在等待识谱";
}

export function buildImportStatusMessage(job) {
  if (!job) return "先导入 PDF 曲谱，再选择段落并上传音频。";
  if (job.cacheHit) return "这份 PDF 的曲谱已准备好，可以直接选择段落。";
  if (job.omrStatus === "completed") return "识谱完成，可以开始选择段落。";
  if (job.omrStatus === "failed") return friendlyErrorMessage(job.error, "自动识谱失败，请更换 PDF 或稍后重试。");
  if (job.stage === "queued") return friendlyStatusMessage(job.message, `识谱排队中：${percentText(job.progress)}`);
  return friendlyStatusMessage(job.message, `识谱进行中：${percentText(job.progress)}`);
}

export function analysisProgressHeadline(job) {
  if (job?.status === "failed") return "分析失败";
  if (job?.status === "completed") return "分析完成";
  if (job?.stage === "queued") return "正在排队诊断";
  if (job?.stage === "loading-score") return "正在读取曲谱";
  if (job?.stage === "detecting-section") return "正在定位段落";
  if (job?.stage === "analyzing") return "正在分析音频";
  if (job?.stage === "saving") return "正在保存结果";
  return "正在等待诊断";
}

export function buildAnalysisStatusMessage(job) {
  if (!job) return "";
  if (job?.status === "failed") return friendlyErrorMessage(job.error, "分析失败，请稍后重试。");
  if (job?.status === "completed") return "诊断完成，可以打开问题谱面页。";
  if (job?.stage === "queued") return friendlyStatusMessage(job?.message, `分析排队中：${percentText(job?.progress)}`);
  return friendlyStatusMessage(job?.message, `分析进行中：${percentText(job?.progress)}`);
}

export function piecePassProgressHeadline(job) {
  if (job?.status === "failed") return "整曲分析失败";
  if (job?.status === "completed") return "整曲分析完成";
  if (job?.stage === "queued") return "正在排队整曲分析";
  if (job?.stage === "scanning-sections") return "正在扫描整曲段落";
  if (job?.stage === "analyzing-sections") return "正在分析整曲段落";
  if (job?.stage === "writing-results") return "正在整理整曲结果";
  if (job?.stage === "checking-services") return "正在准备整曲分析";
  return "正在等待整曲分析";
}

export function getPiecePassCompletionState(summary = {}) {
  const attempted = Math.max(0, Math.round(Number(summary?.attemptedSectionCount) || 0));
  const matched = Math.max(0, Math.round(Number(summary?.matchedSectionCount) || 0));
  const failed = Math.max(0, Math.round(Number(summary?.failedSectionCount) || 0));
  const timedOut = Math.max(0, Math.round(Number(summary?.timedOutSectionCount) || 0));
  const complete = matched > 0 && failed === 0 && timedOut === 0 && (!attempted || matched >= attempted);
  return { attempted, matched, failed, timedOut, complete };
}

export function buildIncompletePiecePassMessage(summary = {}) {
  const state = getPiecePassCompletionState(summary);
  const total = state.attempted || Number(summary?.structuredSectionCount) || 0;
  const failed = Math.max(state.failed, state.timedOut);
  return `整曲分析未完成：已完成 ${state.matched}/${total || "?"} 段，失败或超时 ${failed} 段。当前问题谱会漏报，已阻止作为正式结果打开。`;
}

export function buildPiecePassStatusMessage(job) {
  if (!job) return "";
  if (job?.status === "failed") return friendlyErrorMessage(job.error, "整曲分析失败，请稍后重试。");
  if (job?.status === "completed") {
    const summary = job?.summary || {};
    if (summary?.analysisReliable === false || !getPiecePassCompletionState(summary).complete) {
      return buildIncompletePiecePassMessage(summary);
    }
    return "整曲分析完成，已更新整曲概览。";
  }
  if (job?.stage === "checking-services") return "正在准备整曲分析。";
  if (job?.stage === "queued") return "整曲分析排队中。";
  if (job?.stage === "scanning-sections") return "正在扫描整曲段落。";
  if (job?.stage === "analyzing-sections") return "正在分析整曲段落。";
  if (job?.stage === "writing-results") return "正在整理整曲分析结果。";
  return "整曲分析进行中。";
}

export function buildPiecePassProgressDetailText(job) {
  const detail = job?.progressDetail;
  const total = Math.max(0, Math.round(Number(detail?.totalSections) || 0));
  if (!total) return "";
  const completed = Math.max(
    0,
    Math.round(Number(detail?.completedSections || detail?.currentSection) || 0),
  );
  const failed = Math.max(0, Math.round(Number(detail?.failedSections) || 0));
  const cacheHits = Math.max(0, Math.round(Number(detail?.cacheHits) || 0));
  const remaining = Math.max(0, total - completed);
  const parts = [`已完成 ${Math.min(completed, total)} / ${total} 个段落`];
  if (detail?.currentSectionTitle) parts.push(`当前段落：${detail.currentSectionTitle}`);
  if (job?.status === "processing" && remaining > 0) parts.push(`剩余 ${remaining} 段`);
  if (cacheHits > 0) parts.push(`已直接完成 ${cacheHits} 段`);
  if (failed > 0) parts.push(`失败 ${failed} 段`);
  return parts.join("，");
}

export function formatDurationMs(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  if (!ms) return "";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}

export function buildPiecePassTimingText(job) {
  const timing = job?.timing || {};
  const parts = [];
  const elapsed = formatDurationMs(timing.elapsedMs);
  const remaining = formatDurationMs(timing.estimatedRemainingMs);
  if (elapsed) parts.push(`已用时：${elapsed}`);
  if (job?.status === "processing" && remaining) parts.push(`预计剩余：${remaining}`);
  if (timing.slowNoProgress) parts.push("当前阶段用时较长，系统仍在处理，请保持页面打开。");
  return parts.join("，");
}
