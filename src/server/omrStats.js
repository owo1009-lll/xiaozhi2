import { clamp, getArray, safeBoolean, safeNumber, safeString } from "./baseUtils.js";

const OMR_GATE_THRESHOLDS = {
  omrConfidence: 0.8,
  selectedPartConfidence: 0.85,
  erhuRatio: 0.5,
  erhuPageCoverage: 0.72,
  pageResultCoverage: 0.9,
};

function normalizeProviderCandidates(value = []) {
  return getArray(value).map((item) => ({
    provider: safeString(item?.provider),
    role: safeString(item?.role),
    status: safeString(item?.status),
    input: safeString(item?.input),
    output: safeString(item?.output),
    requiresRenderedPages: safeBoolean(item?.requiresRenderedPages, false),
    windowsPathNote: safeString(item?.windowsPathNote),
  })).filter((item) => item.provider);
}

function normalizeSecondaryRecommendation(value = {}) {
  const thresholds = value?.thresholds && typeof value.thresholds === "object" ? value.thresholds : {};
  return {
    recommended: safeBoolean(value?.recommended, false),
    provider: safeString(value?.provider),
    providerStatus: safeString(value?.providerStatus),
    reasons: getArray(value?.reasons).map((item) => safeString(item)).filter(Boolean),
    thresholds: {
      omrConfidence: safeNumber(thresholds.omrConfidence, OMR_GATE_THRESHOLDS.omrConfidence),
      selectedPartConfidence: safeNumber(thresholds.selectedPartConfidence, OMR_GATE_THRESHOLDS.selectedPartConfidence),
      erhuRatio: safeNumber(thresholds.erhuRatio, OMR_GATE_THRESHOLDS.erhuRatio),
      erhuPageCoverage: safeNumber(thresholds.erhuPageCoverage, OMR_GATE_THRESHOLDS.erhuPageCoverage),
    },
  };
}

export function normalizeOmrQualityGate(gate = {}) {
  const reasons = getArray(gate?.reasons)
    .map((item) => safeString(item))
    .filter(Boolean);
  const blockingReasons = getArray(gate?.blockingReasons)
    .map((item) => safeString(item))
    .filter(Boolean);
  const metrics = gate?.metrics && typeof gate.metrics === "object" ? gate.metrics : {};
  return {
    status: safeString(gate?.status, blockingReasons.length ? "block" : (reasons.length ? "review" : "pass")),
    reasons,
    blockingReasons,
    metrics: {
      pageCount: Math.max(0, Math.round(safeNumber(metrics.pageCount, 0))),
      resultCount: Math.max(0, Math.round(safeNumber(metrics.resultCount, 0))),
      pageResultCoverage: clamp(safeNumber(metrics.pageResultCoverage, 1), 0, 1),
      omrConfidence: clamp(safeNumber(metrics.omrConfidence, 0), 0, 1),
      selectedPartConfidence: clamp(safeNumber(metrics.selectedPartConfidence, 0), 0, 1),
      noteCount: Math.max(0, Math.round(safeNumber(metrics.noteCount, 0))),
      erhuRatio: clamp(safeNumber(metrics.erhuRatio, 0), 0, 1),
      erhuPageCoverage: clamp(safeNumber(metrics.erhuPageCoverage, 0), 0, 1),
      unknownNoteRatio: clamp(safeNumber(metrics.unknownNoteRatio, 0), 0, 1),
    },
    thresholds: {
      ...OMR_GATE_THRESHOLDS,
      ...(gate?.thresholds && typeof gate.thresholds === "object" ? gate.thresholds : {}),
    },
  };
}

export function buildOmrQualityGate({
  omrStatus = "",
  omrConfidence = 0,
  omrStats = {},
  selectedPartConfidence = 0,
  scoreLineStats = {},
  partCandidates = [],
  sectionCount = 0,
  selectedPartConfirmed = false,
} = {}) {
  const stats = normalizeOmrStats(omrStats);
  const mode = safeString(stats.mode);
  const isFallback = mode === "fallback-piece" || mode === "reused-score";
  const pageCount = Math.max(0, Math.round(safeNumber(stats.pageCount, 0)));
  const resultCount = Math.max(0, Math.round(safeNumber(stats.resultCount, mode === "whole-pdf" ? pageCount : 0)));
  const pageResultCoverage = pageCount > 0 ? clamp(resultCount / pageCount, 0, 1) : 1;
  const noteCount = Math.max(0, Math.round(safeNumber(scoreLineStats?.noteCount, 0)));
  const erhuRatio = clamp(safeNumber(scoreLineStats?.erhuRatio, 0), 0, 1);
  const erhuPageCoverage = clamp(safeNumber(scoreLineStats?.erhuPageCoverage, 0), 0, 1);
  const unknownNoteRatio = noteCount > 0 ? clamp(safeNumber(scoreLineStats?.unknownNoteCount, 0) / noteCount, 0, 1) : 0;
  const topCandidate = getArray(partCandidates)[0] || {};
  const reliableLineEvidence =
    noteCount >= 12 &&
    erhuPageCoverage >= OMR_GATE_THRESHOLDS.erhuPageCoverage &&
    unknownNoteRatio <= 0.25 &&
    clamp(safeNumber(selectedPartConfidence, 0), 0, 1) >= 0.88;
  const reasons = [];
  const blockingReasons = [];
  const add = (reason, blocking = false) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    if (blocking && !blockingReasons.includes(reason)) blockingReasons.push(reason);
  };

  if (safeString(omrStatus) !== "completed") add("primary-import-failed", true);
  if (!isFallback && mode === "pagewise" && pageCount > 0 && resultCount === 0) add("no-page-results", true);
  if (!isFallback && mode === "pagewise" && pageCount > 0 && resultCount > 0 && pageResultCoverage < OMR_GATE_THRESHOLDS.pageResultCoverage) {
    add("page-result-coverage-low", true);
  }
  if (!isFallback && clamp(safeNumber(omrConfidence, 0), 0, 1) < OMR_GATE_THRESHOLDS.omrConfidence) {
    add("low-omr-confidence", safeNumber(omrConfidence, 0) < 0.65);
  }
  if (!isFallback && Math.max(0, Math.round(safeNumber(sectionCount, 0))) <= 0) add("no-score-sections", true);
  if (!isFallback && noteCount <= 0) add("no-usable-notes", true);
  if (!isFallback && !reliableLineEvidence && !selectedPartConfirmed && clamp(safeNumber(selectedPartConfidence, 0), 0, 1) < OMR_GATE_THRESHOLDS.selectedPartConfidence) {
    add("low-selected-part-confidence", true);
  }
  if (!isFallback && !reliableLineEvidence && safeBoolean(topCandidate?.selectionAmbiguous, false)) add("ambiguous-selected-part", true);
  if (!isFallback && !reliableLineEvidence && (safeBoolean(topCandidate?.isLikelyPiano, false) || safeNumber(topCandidate?.chordRatio, 0) >= 0.18 || safeNumber(topCandidate?.staffCount, 1) > 1)) {
    add("unsafe-selected-part", true);
  }
  if (!isFallback && noteCount > 0 && erhuRatio < OMR_GATE_THRESHOLDS.erhuRatio && erhuPageCoverage < OMR_GATE_THRESHOLDS.erhuPageCoverage) {
    add("low-erhu-line-coverage", true);
  }
  if (!isFallback && noteCount > 0 && unknownNoteRatio > 0.25) add("missing-score-line-roles", true);

  return normalizeOmrQualityGate({
    status: blockingReasons.length ? "block" : (reasons.length ? "review" : "pass"),
    reasons,
    blockingReasons,
    metrics: {
      pageCount,
      resultCount,
      pageResultCoverage,
      omrConfidence,
      selectedPartConfidence,
      noteCount,
      erhuRatio,
      erhuPageCoverage,
      unknownNoteRatio,
    },
    thresholds: OMR_GATE_THRESHOLDS,
  });
}

export function normalizeOmrStats(stats = {}) {
  const pageCount = Math.max(0, Math.round(safeNumber(stats.pageCount, 0)));
  const pageResultCacheHits = Math.max(0, Math.round(safeNumber(stats.pageResultCacheHits, 0)));
  const pageResultCacheMisses = Math.max(0, Math.round(safeNumber(stats.pageResultCacheMisses, 0)));
  const renderCacheHits = Math.max(0, Math.round(safeNumber(stats.renderCacheHits, 0)));
  const renderCacheMisses = Math.max(0, Math.round(safeNumber(stats.renderCacheMisses, 0)));
  const tileRenderCacheHits = Math.max(0, Math.round(safeNumber(stats.tileRenderCacheHits, 0)));
  const tileRenderCacheMisses = Math.max(0, Math.round(safeNumber(stats.tileRenderCacheMisses, 0)));
  const pageOmrRuns = Math.max(0, Math.round(safeNumber(stats.pageOmrRuns, 0)));
  const tileOmrRuns = Math.max(0, Math.round(safeNumber(stats.tileOmrRuns, 0)));
  const dedupedPageTasks = Math.max(0, Math.round(safeNumber(stats.dedupedPageTasks, 0)));
  const uniquePageOmrTasks = Math.max(0, Math.round(safeNumber(stats.uniquePageOmrTasks, pageOmrRuns)));
  const reusedPageResults = Math.max(0, Math.round(safeNumber(stats.reusedPageResults, pageResultCacheHits + dedupedPageTasks)));
  const providerCandidates = normalizeProviderCandidates(stats.providerCandidates);
  const secondaryProviderRecommendation = normalizeSecondaryRecommendation(stats.secondaryProviderRecommendation);
  return {
    mode: safeString(stats.mode, "none"),
    pageCount,
    resultCount: Math.max(0, Math.round(safeNumber(stats.resultCount, 0))),
    workers: Math.max(0, Math.round(safeNumber(stats.workers, 0))),
    wholePdfAttempted: safeBoolean(stats.wholePdfAttempted, false),
    wholePdfSkippedReason: safeString(stats.wholePdfSkippedReason),
    wholePdfMaxFileMb: safeNumber(stats.wholePdfMaxFileMb, 0),
    pdfFileSizeBytes: Math.max(0, Math.round(safeNumber(stats.pdfFileSizeBytes, 0))),
    pageResultCacheHits,
    pageResultCacheMisses,
    pageResultCacheHitRate: clamp(safeNumber(stats.pageResultCacheHitRate, pageCount ? pageResultCacheHits / Math.max(1, pageCount) : 0), 0, 1),
    renderCacheHits,
    renderCacheMisses,
    renderCacheHitRate: clamp(safeNumber(stats.renderCacheHitRate, (renderCacheHits + renderCacheMisses) ? renderCacheHits / Math.max(1, renderCacheHits + renderCacheMisses) : 0), 0, 1),
    tileRenderCacheHits,
    tileRenderCacheMisses,
    tileRenderCacheHitRate: clamp(safeNumber(stats.tileRenderCacheHitRate, (tileRenderCacheHits + tileRenderCacheMisses) ? tileRenderCacheHits / Math.max(1, tileRenderCacheHits + tileRenderCacheMisses) : 0), 0, 1),
    pageOmrRuns,
    tileOmrRuns,
    dedupedPageTasks,
    uniquePageOmrTasks,
    reusedPageResults,
    pageTaskReductionRate: clamp(safeNumber(stats.pageTaskReductionRate, pageCount ? reusedPageResults / Math.max(1, pageCount) : 0), 0, 1),
    providerCandidates,
    secondaryProviderRecommended: safeBoolean(stats.secondaryProviderRecommended, secondaryProviderRecommendation.recommended),
    secondaryProviderRecommendation,
    qualityGate: normalizeOmrQualityGate(stats.qualityGate),
  };
}

export function calibrateOmrConfidence(rawConfidence = 0, normalizedStats = {}, options = {}) {
  const base = clamp(safeNumber(rawConfidence, 0), 0, 1);
  const mode = safeString(normalizedStats.mode);
  const omrStatus = safeString(options.omrStatus);
  const sectionCount = Math.max(0, Math.round(safeNumber(options.sectionCount, 0)));
  if (mode === "none" && omrStatus === "completed" && sectionCount > 0 && base >= 0.58 && base <= 0.66) {
    return 0.72;
  }
  if (mode !== "pagewise") {
    return base;
  }
  const pageCount = Math.max(1, Math.round(safeNumber(normalizedStats.pageCount, 1)));
  const resultCount = Math.max(0, Math.round(safeNumber(normalizedStats.resultCount, 0)));
  const coverage = clamp(resultCount / pageCount, 0, 1);
  const pageResultCacheHitRate = clamp(safeNumber(normalizedStats.pageResultCacheHitRate, 0), 0, 1);
  const renderCacheHitRate = clamp(safeNumber(normalizedStats.renderCacheHitRate, 0), 0, 1);
  const tilePressure = clamp(safeNumber(normalizedStats.tileOmrRuns, 0) / pageCount, 0, 1);
  const workers = Math.max(1, Math.round(safeNumber(normalizedStats.workers, 1)));
  let calibrated = 0.56 + (coverage * 0.28) + (pageResultCacheHitRate * 0.08) + (renderCacheHitRate * 0.04) - (tilePressure * 0.06);
  if (workers > 1 && coverage >= 0.9) {
    calibrated += 0.02;
  }
  calibrated = clamp(Number(calibrated.toFixed(3)), 0.44, 0.9);
  return Math.max(base, calibrated);
}

export function buildCachedImportPreviewPages(score = {}, fallbackPreviewPages = [], sourcePdfPath = "") {
  const existingPreviewPages = getArray(score.previewPages)
    .map((page) => ({
      ...page,
      pageNumber: Math.max(1, Math.round(safeNumber(page?.pageNumber, 1))),
      type: safeString(page?.type, "pdf"),
      url: sourcePdfPath || safeString(page?.url),
    }))
    .filter((page) => Number.isFinite(page.pageNumber));
  if (existingPreviewPages.length) {
    return existingPreviewPages;
  }
  return getArray(fallbackPreviewPages).length ? fallbackPreviewPages : [{ pageNumber: 1, type: "pdf", url: sourcePdfPath }];
}

export function buildReusedOmrStats(stats = {}, previewPages = []) {
  const normalized = normalizeOmrStats(stats);
  const previewCount = Math.max(1, getArray(previewPages).length);
  if (
    normalized.mode !== "none"
    || normalized.pageCount > 0
    || normalized.resultCount > 0
    || normalized.pageResultCacheHits > 0
    || normalized.pageResultCacheMisses > 0
    || normalized.renderCacheHits > 0
    || normalized.renderCacheMisses > 0
    || normalized.pageOmrRuns > 0
    || normalized.tileOmrRuns > 0
  ) {
    return {
      ...normalized,
      pageCount: normalized.pageCount || previewCount,
    };
  }
  return {
    ...normalized,
    mode: "reused-score",
    pageCount: previewCount,
    resultCount: previewCount,
    pageResultCacheHits: previewCount,
    pageResultCacheMisses: 0,
    pageResultCacheHitRate: 1,
  };
}
