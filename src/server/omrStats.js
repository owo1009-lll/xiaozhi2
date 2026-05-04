import { clamp, getArray, safeBoolean, safeNumber, safeString } from "./baseUtils.js";

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
