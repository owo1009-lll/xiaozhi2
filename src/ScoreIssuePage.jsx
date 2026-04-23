import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import {
  extractSectionPageNumber,
  formatMeasureLabel,
  formatNoteLabel,
  formatPracticePathLabel,
  getApproximateNotePosition,
  getDisplayCombinedScore,
  getDisplayPitchScore,
  getDisplayRhythmScore,
  getSectionMeasureCount,
} from "./analysisLabels.js";
import { fetchScore } from "./researchApi.js";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

function getIssueSessionId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("issueSession") || "";
}

function readStoredSession(issueSessionId) {
  if (!issueSessionId || typeof window === "undefined") return null;
  try {
    const storageKey = `ai-erhu.issue-session.${issueSessionId}`;
    const raw = window.localStorage.getItem(storageKey) || window.sessionStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}

function getDerivedPageImagePath(score, pageNumber) {
  const pdfUrl = String(score?.sourcePdfPath || "").trim();
  if (!pdfUrl) return "";
  const match = pdfUrl.match(/^(.*)\/source\.pdf$/i);
  if (!match) return "";
  return `${match[1]}/pagewise/page-${String(Math.max(1, Number(pageNumber) || 1)).padStart(3, "0")}.png`;
}

function buildImportedPageImagePath(score, section, pageNumber) {
  const baseSectionPage = extractSectionPageNumber(section || {});
  const derived = getDerivedPageImagePath(score, pageNumber);
  if (derived) return derived;
  const explicit = String(section?.pageImagePath || "").trim();
  if (explicit && (Number(pageNumber) || 1) === baseSectionPage) return explicit;
  return explicit;
}

function readExactNotePosition(section, noteId) {
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  const matched = notes.find((item) => String(item?.noteId || "") === String(noteId || ""));
  const normalizedX = Number(matched?.notePosition?.normalizedX);
  const normalizedY = Number(matched?.notePosition?.normalizedY);
  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) {
    return null;
  }
  return {
    measureIndex: Number(matched?.measureIndex) || 1,
    pageNumber: Number(matched?.notePosition?.pageNumber) || extractSectionPageNumber(section || {}),
    staffIndex: Number(matched?.notePosition?.staffIndex) || 1,
    normalizedX,
    normalizedY,
  };
}

function summarizeOverallFeedback(analysis) {
  const focus =
    analysis?.recommendedPracticePath === "pitch-first"
      ? "音准问题"
      : analysis?.recommendedPracticePath === "rhythm-first"
        ? "节奏问题"
        : getDisplayRhythmScore(analysis) <= getDisplayPitchScore(analysis)
          ? "节奏问题"
          : "音准问题";
  const noteCount = Array.isArray(analysis?.noteFindings) ? analysis.noteFindings.length : 0;
  const measureCount = Array.isArray(analysis?.measureFindings) ? analysis.measureFindings.length : 0;
  const uncertainCount =
    Number(analysis?.diagnostics?.uncertainPitchCount)
    || (Array.isArray(analysis?.noteFindings) ? analysis.noteFindings.filter((item) => item?.isUncertain).length : 0)
    || 0;
  const lines = [
    `本次录音优先需要处理的是${focus}。`,
    `系统共定位到 ${noteCount} 个问题音和 ${measureCount} 个问题小节。`,
  ];
  if (uncertainCount > 0) {
    lines.push(`其中有 ${uncertainCount} 个音的证据偏弱，建议结合示范和教师判断复核。`);
  }
  return lines.join("");
}

function buildMeasureIssues(analysis) {
  return (analysis?.measureFindings || []).map((item) => ({
    measureIndex: Number(item?.measureIndex) || 1,
    label: String(item?.issueType || "").startsWith("pitch") ? "音准问题" : "节奏问题",
  }));
}

function buildNoteIssues(analysis) {
  return (analysis?.noteFindings || []).map((item) => {
    const tags = [];
    if (item?.pitchLabel && item.pitchLabel !== "pitch-ok") tags.push("音准问题");
    if (item?.rhythmType || item?.rhythmLabel) tags.push("节奏问题");
    return {
      noteId: item?.noteId,
      measureIndex: Number(item?.measureIndex) || 1,
      tags: tags.length ? [...new Set(tags)] : ["音准问题"],
    };
  });
}

function ScoreBlock({ label, value }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong>{typeof value === "number" ? value : String(value || "")}</strong>
    </div>
  );
}

function getDominantStaffIndex(section, analysis) {
  const sectionNotes = Array.isArray(section?.notes) ? section.notes : [];
  // Issue notes come from the student's erhu performance — their staffIndex is the erhu staff.
  const issueNoteIds = new Set(
    (analysis?.noteFindings || []).map((item) => String(item?.noteId || "")).filter(Boolean),
  );
  if (issueNoteIds.size > 0) {
    const staffCounts = new Map();
    for (const note of sectionNotes) {
      if (!issueNoteIds.has(String(note?.noteId || ""))) continue;
      const staffIndex = Number(note?.notePosition?.staffIndex);
      if (Number.isFinite(staffIndex) && staffIndex >= 1) {
        staffCounts.set(staffIndex, (staffCounts.get(staffIndex) || 0) + 1);
      }
    }
    if (staffCounts.size > 0) {
      return [...staffCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  }
  // Fallback: erhu is the solo instrument and appears first (top staff = smallest index).
  let minStaff = Infinity;
  for (const note of sectionNotes) {
    const staffIndex = Number(note?.notePosition?.staffIndex);
    if (Number.isFinite(staffIndex) && staffIndex >= 1 && staffIndex < minStaff) {
      minStaff = staffIndex;
    }
  }
  return Number.isFinite(minStaff) ? minStaff : 1;
}

export default function ScoreIssuePage() {
  const issueSessionId = getIssueSessionId();
  const stored = readStoredSession(issueSessionId);
  const [score, setScore] = useState(stored?.score || null);
  const [analysis] = useState(stored?.analysis || null);
  const [section, setSection] = useState(stored?.section || null);
  const [error, setError] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(extractSectionPageNumber(stored?.section || {}));
  const [selectedMeasureIndex, setSelectedMeasureIndex] = useState(null);
  const [selectedNoteKey, setSelectedNoteKey] = useState("");
  const [pageImageFailed, setPageImageFailed] = useState(false);
  const [zoom, setZoom] = useState(1.5);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);
  const issueListRefs = useRef(new Map());

  useEffect(() => {
    let cancelled = false;
    async function loadScore() {
      if (!stored?.score?.scoreId || score?.sourcePdfPath) return;
      try {
        const json = await fetchScore(stored.score.scoreId);
        if (cancelled) return;
        const nextScore = json?.score || null;
        setScore(nextScore);
        if (stored?.section?.sectionId && nextScore?.sections?.length) {
          const nextSection = nextScore.sections.find((item) => item.sectionId === stored.section.sectionId) || stored.section;
          setSection(nextSection);
          setCurrentPage(extractSectionPageNumber(nextSection));
        }
      } catch {
        if (!cancelled) {
          setError("问题谱面数据已失效，请返回结果页重新打开。");
        }
      }
    }
    void loadScore();
    return () => {
      cancelled = true;
    };
  }, [score?.sourcePdfPath, stored]);

  useEffect(() => {
    setPageImageFailed(false);
  }, [score?.sourcePdfPath, section?.pageImagePath, currentPage]);

  const baseSectionPage = extractSectionPageNumber(section || {});
  const pageImagePath = buildImportedPageImagePath(score, section, currentPage);
  const usePageImage = Boolean(pageImagePath && !pageImageFailed);
  const dominantStaffIndex = useMemo(() => getDominantStaffIndex(section, analysis), [analysis, section]);

  useEffect(() => {
    if (!usePageImage) return;
    const previewCount = Array.isArray(score?.previewPages) ? score.previewPages.length : 0;
    const omrPageCount = Number(score?.omrStats?.pageCount);
    const effectivePageCount = Number.isFinite(omrPageCount) && omrPageCount > 0 ? omrPageCount : previewCount;
    setPageCount(effectivePageCount || 0);
  }, [currentPage, score?.omrStats?.pageCount, score?.previewPages, usePageImage]);

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;

    async function renderPdf() {
      const pdfUrl = score?.sourcePdfPath;
      if (!pdfUrl || !canvasRef.current || usePageImage) return;
      try {
        const document = await getDocument(pdfUrl).promise;
        if (cancelled) return;
        setPageCount(document.numPages || 0);
        const safePage = Math.min(Math.max(1, currentPage || 1), document.numPages || 1);
        const page = await document.getPage(safePage);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1.45 });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        setStageSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch {
        if (!cancelled) {
          setError("无法加载乐谱页面，请返回上一页重新打开。");
        }
      }
    }

    void renderPdf();
    return () => {
      cancelled = true;
      if (renderTask?.cancel) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, [currentPage, score?.sourcePdfPath, usePageImage]);

  const measureCount = getSectionMeasureCount(section || {});
  const measureIssues = useMemo(() => buildMeasureIssues(analysis), [analysis]);
  const noteIssues = useMemo(() => buildNoteIssues(analysis), [analysis]);
  const issueMeasureIndexes = [...new Set(measureIssues.map((item) => item.measureIndex).concat(noteIssues.map((item) => item.measureIndex)))].sort(
    (left, right) => left - right,
  );
  const activeMeasureIndex = selectedMeasureIndex || issueMeasureIndexes[0] || null;

  const measurePageMap = useMemo(() => {
    const pageMap = new Map();
    for (const note of Array.isArray(section?.notes) ? section.notes : []) {
      const measureIndex = Number(note?.measureIndex);
      const pageNumber = Number(note?.notePosition?.pageNumber);
      const staffIndex = Number(note?.notePosition?.staffIndex) || 1;
      if (!Number.isFinite(measureIndex) || !Number.isFinite(pageNumber)) continue;
      if (staffIndex !== dominantStaffIndex) continue;
      if (!pageMap.has(measureIndex)) {
        pageMap.set(measureIndex, pageNumber);
      }
    }
    return pageMap;
  }, [dominantStaffIndex, section]);

  const noteOverlayItems = useMemo(
    () =>
      noteIssues
        .map((item, index) => {
          const exact = readExactNotePosition(section, item?.noteId);
          if (exact && exact.staffIndex === dominantStaffIndex) {
            return {
              key: `${item?.noteId || index}-${exact.measureIndex}`,
              noteId: item?.noteId || "",
              measureIndex: exact.measureIndex,
              left: Math.min(Math.max(exact.normalizedX * 100, 0), 100),
              top: Math.min(Math.max(exact.normalizedY * 100, 0), 100),
              exact: true,
              pageNumber: exact.pageNumber,
              tags: item?.tags || [],
            };
          }
          const { measureIndex, noteIndex } = getApproximateNotePosition(item?.noteId, item?.measureIndex, index + 1);
          const slotWidth = 100 / Math.max(1, measureCount);
          const measureLeft = Math.max(0, (measureIndex - 1) * slotWidth);
          const relativeStep = Math.min(0.85, 0.18 + ((noteIndex - 1) % 6) * 0.12);
          const bandIndex = (noteIndex - 1) % 3;
          return {
            key: `${item?.noteId || index}-${measureIndex}-${noteIndex}`,
            noteId: item?.noteId || "",
            measureIndex,
            left: Math.min(measureLeft + slotWidth * relativeStep, 98),
            top: 18 + bandIndex * 18,
            exact: false,
            pageNumber: measurePageMap.get(measureIndex) || baseSectionPage,
            tags: item?.tags || [],
          };
        })
        .filter(Boolean),
    [baseSectionPage, dominantStaffIndex, measureCount, measurePageMap, noteIssues, section],
  );

  const measureIssueEntries = useMemo(
    () =>
      measureIssues.map((item, index) => ({
        ...item,
        issueKey: `measure-${item.measureIndex}`,
        issueNumber: index + 1,
      })),
    [measureIssues],
  );

  const noteIssueEntries = useMemo(
    () =>
      noteIssues.map((item, index) => {
        const overlayItem =
          noteOverlayItems.find((overlay) => String(overlay.noteId || "") === String(item.noteId || "") && overlay.measureIndex === item.measureIndex)
          || null;
        const overlayKey = overlayItem?.key || `note-${item.noteId || index}-${item.measureIndex}`;
        return {
          ...item,
          overlayItem,
          overlayKey,
          issueKey: `note-${overlayKey}`,
          issueNumber: measureIssueEntries.length + index + 1,
        };
      }),
    [measureIssueEntries.length, noteIssues, noteOverlayItems],
  );

  const measureIssueNumberMap = useMemo(
    () => new Map(measureIssueEntries.map((item) => [item.measureIndex, item.issueNumber])),
    [measureIssueEntries],
  );

  const noteIssueNumberMap = useMemo(
    () => new Map(noteIssueEntries.map((item) => [item.overlayKey, item.issueNumber])),
    [noteIssueEntries],
  );

  const hasExactNoteOverlay = noteOverlayItems.some((item) => item.exact);

  const overlayItems = useMemo(() => {
    if (hasExactNoteOverlay) {
      return issueMeasureIndexes
        .map((measureIndex) => {
          const measureNotes = (Array.isArray(section?.notes) ? section.notes : [])
            .filter(
              (item) =>
                Number(item?.measureIndex) === measureIndex
                && (Number(item?.notePosition?.staffIndex) || 1) === dominantStaffIndex,
            )
            .map((item) => ({
              pageNumber: Number(item?.notePosition?.pageNumber) || baseSectionPage,
              x: Number(item?.notePosition?.normalizedX),
              y: Number(item?.notePosition?.normalizedY),
            }))
            .filter((item) => item.pageNumber === currentPage && Number.isFinite(item.x) && Number.isFinite(item.y));
          if (!measureNotes.length) return null;
          const minX = Math.min(...measureNotes.map((item) => item.x * 100));
          const maxX = Math.max(...measureNotes.map((item) => item.x * 100));
          const minY = Math.min(...measureNotes.map((item) => item.y * 100));
          const maxY = Math.max(...measureNotes.map((item) => item.y * 100));
          return {
            measureIndex,
            left: Math.max(0, minX - 2.2),
            top: Math.max(0, minY - 5.5),
            width: Math.max(4.5, (maxX - minX) + 4.4),
            height: Math.max(10, (maxY - minY) + 11),
          };
        })
        .filter(Boolean);
    }
    return issueMeasureIndexes
      .filter((measureIndex) => (measurePageMap.get(measureIndex) || baseSectionPage) === currentPage)
      .map((measureIndex) => {
        const slotWidth = 100 / Math.max(1, measureCount);
        const left = Math.max(0, (measureIndex - 1) * slotWidth);
        return {
          measureIndex,
          left: Math.min(left, 96),
          top: 8,
          width: Math.max(5.5, Math.min(slotWidth, 18)),
          height: 84,
        };
      });
  }, [baseSectionPage, currentPage, dominantStaffIndex, hasExactNoteOverlay, issueMeasureIndexes, measureCount, measurePageMap, section]);

  const effectiveWidth = stageSize.width > 0 ? stageSize.width * zoom : 0;
  const effectiveHeight = stageSize.height > 0 ? stageSize.height * zoom : 0;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !effectiveWidth || !effectiveHeight) return;
    const focusNote =
      noteOverlayItems.find((item) => item.key === selectedNoteKey && item.pageNumber === currentPage)
      || noteOverlayItems.find((item) => item.pageNumber === currentPage && item.measureIndex === activeMeasureIndex && item.exact)
      || noteOverlayItems.find((item) => item.pageNumber === currentPage && item.measureIndex === activeMeasureIndex)
      || null;
    const focusMeasure = overlayItems.find((item) => item.measureIndex === activeMeasureIndex) || null;
    const focusLeftPercent = focusNote ? focusNote.left : focusMeasure ? focusMeasure.left + focusMeasure.width / 2 : null;
    const focusTopPercent = focusNote ? focusNote.top : focusMeasure ? focusMeasure.top + focusMeasure.height / 2 : null;
    if (focusLeftPercent == null || focusTopPercent == null) return;
    const targetLeft = (focusLeftPercent / 100) * effectiveWidth - viewport.clientWidth / 2;
    const targetTop = (focusTopPercent / 100) * effectiveHeight - viewport.clientHeight / 2;
    viewport.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [activeMeasureIndex, currentPage, effectiveHeight, effectiveWidth, noteOverlayItems, overlayItems, selectedNoteKey, zoom]);

  useEffect(() => {
    const targetKey = selectedNoteKey || (activeMeasureIndex != null ? `measure-${activeMeasureIndex}` : "");
    if (!targetKey) return;
    const target = issueListRefs.current.get(targetKey);
    if (!target?.scrollIntoView) return;
    target.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeMeasureIndex, selectedNoteKey]);

  function handleMeasureJump(measureIndex) {
    setCurrentPage(measurePageMap.get(measureIndex) || baseSectionPage);
    setSelectedMeasureIndex(measureIndex);
    setSelectedNoteKey("");
  }

  function handleNoteJump(noteItem, overlayItem) {
    if (!noteItem) return;
    const resolvedOverlay =
      overlayItem
      || noteOverlayItems.find((item) => String(item.noteId || "") === String(noteItem.noteId || "") && item.measureIndex === noteItem.measureIndex)
      || null;
    setCurrentPage(resolvedOverlay?.pageNumber || measurePageMap.get(noteItem.measureIndex) || baseSectionPage);
    setSelectedMeasureIndex(noteItem.measureIndex || null);
    setSelectedNoteKey(resolvedOverlay?.key || "");
  }

  function handleImageLoad(event) {
    const image = event.currentTarget;
    setStageSize({
      width: image.naturalWidth || image.width || 0,
      height: image.naturalHeight || image.height || 0,
    });
  }

  function setIssueListRef(key, element) {
    if (!key) return;
    if (element) {
      issueListRefs.current.set(key, element);
      return;
    }
    issueListRefs.current.delete(key);
  }

  if (!analysis || !stored) {
    return (
      <div className="app-shell">
        <section className="panel-card">
          <h2>问题谱面页不可用</h2>
          <p className="supporting-copy">没有找到当前分析结果。请从学生端结果页重新打开“问题谱面页”。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell score-issue-shell">
      <header className="panel-card score-issue-header">
        <div className="score-issue-title">
          <h1>{section?.title || "问题谱面"}</h1>
          <div className="score-inline-scores">
            <span className="score-inline-chip">音准 <strong>{getDisplayPitchScore(analysis)}</strong></span>
            <span className="score-inline-chip">节奏 <strong>{getDisplayRhythmScore(analysis)}</strong></span>
            <span className="score-inline-chip">综合 <strong>{getDisplayCombinedScore(analysis)}</strong></span>
            <span className="score-inline-chip is-muted">{formatPracticePathLabel(analysis?.recommendedPracticePath)}</span>
          </div>
        </div>
        <div className="score-issue-actions">
          <button type="button" className="secondary-button" onClick={() => window.close()}>关闭</button>
          {score?.sourcePdfPath ? (
            <a className="secondary-link" href={score.sourcePdfPath} target="_blank" rel="noreferrer">打开 PDF</a>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="score-issue-layout">
        <aside className="panel-card score-sidebar">
          {analysis?.rawAudioPath ? (
            <div className="sidebar-block">
              <p className="sidebar-label">原音</p>
              <audio controls className="audio-player" src={analysis.rawAudioPath} />
            </div>
          ) : null}

          <div className="sidebar-block">
            <p className="sidebar-label">总体反馈</p>
            <p className="sidebar-text">{summarizeOverallFeedback(analysis)}</p>
            <p className="sidebar-meta">{formatDateTime(analysis?.createdAt || stored?.savedAt)}</p>
          </div>

          <div className="sidebar-block sidebar-issues">
            <p className="sidebar-label">问题列表</p>
            <div className="issue-list-block">
              {measureIssueEntries.map((item) => (
                <button
                  type="button"
                  key={item.issueKey}
                  ref={(element) => setIssueListRef(item.issueKey, element)}
                  className={`issue-list-button${activeMeasureIndex === item.measureIndex && !selectedNoteKey ? " is-active" : ""}`}
                  onClick={() => handleMeasureJump(item.measureIndex)}
                >
                  <strong>
                    <span className="issue-number-chip">{item.issueNumber}</span>
                    {formatMeasureLabel(item.measureIndex)}
                  </strong>
                  <span>{item.label}</span>
                </button>
              ))}
              {noteIssueEntries.map((item, index) => {
                const overlayItem = item.overlayItem || null;
                const overlayKey = item.overlayKey || "";
                return (
                  <button
                    type="button"
                    key={`note-${item.noteId || index}-${item.measureIndex}`}
                    ref={(element) => setIssueListRef(overlayKey, element)}
                    className={`issue-list-button${selectedNoteKey && selectedNoteKey === overlayKey ? " is-active" : ""}`}
                    onClick={() => handleNoteJump(item, overlayItem)}
                  >
                    <strong>
                      <span className="issue-number-chip">{item.issueNumber}</span>
                      {formatNoteLabel(item.noteId, item.measureIndex)}
                    </strong>
                    <span>{item.tags.join("、")}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="panel-card score-page-panel">
          <div className="score-page-toolbar">
            <span>{section?.title || "当前段落"}</span>
            <span>第 {currentPage} 页{pageCount > 0 ? ` / ${pageCount}` : ""}</span>
            <span>{issueMeasureIndexes.length} 个问题小节</span>
          </div>

          <div className="score-page-nav">
            <button type="button" className="secondary-button" onClick={() => setCurrentPage((value) => Math.max(1, value - 1))} disabled={currentPage <= 1}>
              上一页
            </button>
            <button type="button" className="secondary-button" onClick={() => setCurrentPage(baseSectionPage)}>
              回到问题页
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setCurrentPage((value) => value + 1)}
              disabled={pageCount > 0 && currentPage >= pageCount}
            >
              下一页
            </button>
            <div className="score-zoom-group">
              <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.15).toFixed(2))))}>
                缩小
              </button>
              <span className="score-zoom-label">{Math.round(zoom * 100)}%</span>
              <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.min(3.5, Number((value + 0.15).toFixed(2))))}>
                放大
              </button>
              <button type="button" className="secondary-button" onClick={() => setZoom(1.5)}>
                重置
              </button>
            </div>
          </div>

          <div ref={viewportRef} className="score-page-viewport">
            <div
              className="score-page-stage"
              style={{
                width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                height: effectiveHeight ? `${effectiveHeight}px` : undefined,
              }}
            >
              {usePageImage ? (
                <img
                  className="score-page-image"
                  src={pageImagePath}
                  alt={`score-page-${currentPage}`}
                  onError={() => setPageImageFailed(true)}
                  onLoad={handleImageLoad}
                  style={{
                    width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                    height: effectiveHeight ? `${effectiveHeight}px` : undefined,
                  }}
                />
              ) : (
                <canvas
                  ref={canvasRef}
                  className="pdf-preview-canvas"
                  style={{
                    width: effectiveWidth ? `${effectiveWidth}px` : undefined,
                    height: effectiveHeight ? `${effectiveHeight}px` : undefined,
                  }}
                />
              )}
              <div className="score-measure-overlay" aria-hidden="true">
                {overlayItems.map((item) => (
                  <button
                    type="button"
                    key={`measure-${item.measureIndex}`}
                    className={`score-measure-highlight${activeMeasureIndex === item.measureIndex ? " is-active" : ""}`}
                    onClick={() => handleMeasureJump(item.measureIndex)}
                    style={{
                      left: `${item.left}%`,
                      top: `${item.top}%`,
                      width: `${item.width}%`,
                      height: `${item.height}%`,
                    }}
                  >
                    <span>{measureIssueNumberMap.get(item.measureIndex) || item.measureIndex}</span>
                  </button>
                ))}
                {noteOverlayItems
                  .filter((item) => item.pageNumber === currentPage && (activeMeasureIndex == null || item.measureIndex === activeMeasureIndex))
                  .map((item) => {
                    const relatedIssue =
                      noteIssueEntries.find((noteIssue) => String(noteIssue.noteId || "") === String(item.noteId || "") && noteIssue.measureIndex === item.measureIndex)
                      || { noteId: item.noteId, measureIndex: item.measureIndex };
                    return (
                      <button
                        type="button"
                        key={item.key}
                        className={`score-note-highlight${item.exact ? " is-exact" : ""}${selectedNoteKey === item.key ? " is-selected" : ""}`}
                        style={{ left: `${item.left}%`, top: `${item.top}%` }}
                        onClick={() => handleNoteJump(relatedIssue, item)}
                        aria-label={formatNoteLabel(item.noteId, item.measureIndex)}
                      >
                        <span className="score-note-index">{noteIssueNumberMap.get(item.key) || "•"}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
