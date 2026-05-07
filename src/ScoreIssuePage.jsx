import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import {
  extractSectionPageNumber,
  ISSUE_SESSION_SCHEMA_VERSION,
  ISSUE_SESSION_STORAGE_PREFIX,
  formatPracticePathLabel,
  formatScoreTitle,
  formatSectionDisplayName,
  getApproximateNotePosition,
  getDisplayCombinedScore,
  getDisplayPitchScore,
  getDisplayRhythmScore,
  getSectionMeasureCount,
} from "./analysisLabels.js";
import { fetchScore } from "./researchApi.js";
import {
  ScoreIssueHeader,
  ScoreIssueSidebar,
  ScorePageNav,
  ScorePageStage,
  ScorePageToolbar,
} from "./scoreIssue/ScoreIssueLayout.jsx";

import {
  attachOriginalAudio,
  buildDisplayMeasureLookup,
  buildImportedPageImagePath,
  buildIssuePlaybackWindow,
  buildMeasureIssues,
  buildMelodyBand,
  buildNoteIssues,
  findErhuNotePosition,
  findMatchingErhuMeasureIndex,
  formatDateTime,
  formatDisplayMeasureLabel,
  formatDisplayNoteLabel,
  formatPlaybackSeconds,
  getAbsoluteIssuePage,
  getDominantStaffIndex,
  getErhuStaffIndex,
  getIssueNoteOrdinal,
  getIssueSessionId,
  getIssueTone,
  getNoteStaffIndex,
  hasErhuMelodyMeasure,
  isAmbiguousImportedPart,
  isErhuMelodyNote,
  isLikelyAccompanimentOnlySection,
  isLikelyNonScoreLeadPage,
  issueMeasureIndex,
  issueToneClass,
  mapNoteToMelodyBand,
  mapOverlayToMelodyBand,
  mergeIssueTones,
  readNotePosition,
  readStoredLineMode,
  readStoredSession,
  resolveIssueSection,
  resolvePreferredSection,
  sectionKey,
  shouldProjectImportedFullScoreSection,
  summarizeOverallFeedback,
  writeStoredLineMode,
} from "./scoreIssue/scoreIssueProjection.js";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

function ScoreBlock({ label, value }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong>{typeof value === "number" ? value : String(value || "")}</strong>
    </div>
  );
}


export default function ScoreIssuePage() {
  const issueSessionId = getIssueSessionId();
  const stored = readStoredSession(issueSessionId);
  const [score, setScore] = useState(stored?.score || null);
  const [analysis, setAnalysis] = useState(() => attachOriginalAudio(stored?.analysis, stored?.originalAudio));
  const [section, setSection] = useState(() => resolvePreferredSection(stored?.score, stored?.section, stored?.analysis));
  const [error, setError] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(() => extractSectionPageNumber(resolvePreferredSection(stored?.score, stored?.section, stored?.analysis) || {}));
  const [selectedMeasureIndex, setSelectedMeasureIndex] = useState(null);
  const [selectedNoteKey, setSelectedNoteKey] = useState("");
  const [pageImageFailed, setPageImageFailed] = useState(false);
  const [zoom, setZoom] = useState(1.0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [lineMode, setLineMode] = useState(() => readStoredLineMode(stored?.score?.scoreId));
  const [playbackHint, setPlaybackHint] = useState("");
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const playbackStopTimerRef = useRef(null);
  const viewportRef = useRef(null);
  const hasAutoFittedRef = useRef(false);
  const hasAutoSelectedInitialIssuePageRef = useRef(false);
  const issueListRefs = useRef(new Map());
  const isWholePieceMode = stored?.mode === "whole-piece" || analysis?.analysisMode === "whole-piece";
  const projectionScore = useMemo(
    () => (score ? { ...score, scoreIssueLineMode: lineMode } : score),
    [lineMode, score],
  );

  useEffect(() => {
    const scoreId = score?.scoreId;
    if (!scoreId) return;
    setLineMode(readStoredLineMode(scoreId));
  }, [score?.scoreId]);

  useEffect(() => {
    if (!score?.scoreId) return;
    writeStoredLineMode(score.scoreId, lineMode);
  }, [lineMode, score?.scoreId]);

  useEffect(() => {
    let cancelled = false;
    async function loadScore() {
      const scoreId = String(stored?.score?.scoreId || "").trim();
      if (!scoreId) return;
      try {
        const json = await fetchScore(scoreId);
        if (cancelled) return;
        const nextScore = json?.score || null;
        if (!nextScore) return;
        setScore(nextScore);
        const nextSection = resolvePreferredSection(nextScore, stored?.section, stored?.analysis);
        setSection(nextSection);
        if (!isWholePieceMode) {
          setCurrentPage(extractSectionPageNumber(nextSection || {}));
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
  }, [isWholePieceMode, issueSessionId, stored?.score?.scoreId]);

  useEffect(() => {
    const scoreId = String(score?.scoreId || "").trim();
    const analysisScoreId = String(analysis?.scoreId || "").trim();
    if (!scoreId || !analysisScoreId) return;
    if (scoreId === analysisScoreId) return;
    setAnalysis(null);
    setError("当前问题谱会话与分析结果不一致，请返回学生端结果页重新打开。");
  }, [analysis, score]);

  // Re-read analysis when the main app writes a new result to the same storage key.
  useEffect(() => {
    if (!issueSessionId) return undefined;
    const storageKey = `${ISSUE_SESSION_STORAGE_PREFIX}${issueSessionId}`;
    function onStorage(event) {
      if (event.key !== storageKey) return;
      const fresh = readStoredSession(issueSessionId);
      if (!fresh?.analysis) return;
      setAnalysis(attachOriginalAudio(fresh.analysis, fresh.originalAudio));
      const nextSection = resolvePreferredSection(score || fresh.score, fresh.section, fresh.analysis);
      if (nextSection) {
        setSection(nextSection);
        setCurrentPage(extractSectionPageNumber(nextSection));
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [issueSessionId, score]);

  useEffect(() => {
    if (isWholePieceMode) return;
    const nextSection = resolvePreferredSection(score, section, analysis);
    if (!nextSection) return;
    const currentSectionId = String(section?.sectionId || "");
    const nextSectionId = String(nextSection?.sectionId || "");
    if (currentSectionId === nextSectionId) return;
    setSection(nextSection);
    setCurrentPage(extractSectionPageNumber(nextSection));
  }, [analysis, isWholePieceMode, score, section]);

  useEffect(() => {
    setPageImageFailed(false);
    hasAutoFittedRef.current = false;
  }, [score?.sourcePdfPath, section?.pageImagePath, currentPage]);

  const effectiveSections = useMemo(
    () => {
      const sections = isWholePieceMode ? (Array.isArray(score?.sections) ? score.sections : []) : (section ? [section] : []);
      return sections.filter((item) => !isWholePieceMode || (!isLikelyNonScoreLeadPage(item, score) && !isLikelyAccompanimentOnlySection(item, projectionScore)));
    },
    [isWholePieceMode, projectionScore, score, section],
  );
  const firstEffectivePage = useMemo(
    () => {
      const pages = effectiveSections
        .map((item) => getAbsoluteIssuePage(item))
        .filter((value) => Number.isFinite(value) && value > 0);
      return pages.length ? Math.min(...pages) : 1;
    },
    [effectiveSections],
  );
  const baseSectionPage = isWholePieceMode ? firstEffectivePage : extractSectionPageNumber(section || {});
  const pageImagePath = buildImportedPageImagePath(score, section, currentPage);
  const usePageImage = Boolean(pageImagePath && !pageImageFailed);
  const dominantStaffIndex = useMemo(() => getDominantStaffIndex(section || effectiveSections[0]), [effectiveSections, section]);
  const hasImportedScoreSections = useMemo(
    () => effectiveSections.some((item) => shouldProjectImportedFullScoreSection(item)),
    [effectiveSections],
  );
  const ambiguousImportedScore = hasImportedScoreSections && isAmbiguousImportedPart(score);
  const displayMeasureSections = useMemo(
    () => (isWholePieceMode ? effectiveSections : (Array.isArray(score?.sections) ? score.sections : effectiveSections)),
    [effectiveSections, isWholePieceMode, score?.sections],
  );
  const displayMeasureLookup = useMemo(
    () => buildDisplayMeasureLookup(score, displayMeasureSections, projectionScore),
    [displayMeasureSections, projectionScore, score],
  );

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
        const containerWidth = viewportRef.current ? viewportRef.current.clientWidth - 8 : 0;
        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = containerWidth > 0 ? containerWidth / baseViewport.width : 1.8;
        const renderScale = Math.max(fitScale, 1.8);
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        setStageSize({ width: viewport.width, height: viewport.height });
        if (!hasAutoFittedRef.current) {
          setZoom(1.0);
          hasAutoFittedRef.current = true;
        }
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (err) {
        if (!cancelled && !(String(err?.message || err).includes("cancel") || String(err?.name || "").includes("cancel"))) {
          setError("无法加载乐谱页面，请尝试点击上方【打开 PDF】按钮在新窗口查看。");
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

  const measureCount = isWholePieceMode
    ? Math.max(1, ...effectiveSections.map((item) => getSectionMeasureCount(item)))
    : getSectionMeasureCount(section || {});
  const measureIssues = useMemo(
    () => buildMeasureIssues(analysis),
    [analysis],
  );
  const noteIssues = useMemo(
    () => buildNoteIssues(analysis),
    [analysis],
  );
  const visibleAnalysisForSummary = useMemo(
    () => ({
      ...analysis,
      measureFindings: measureIssues,
      noteFindings: noteIssues,
    }),
    [analysis, measureIssues, noteIssues],
  );
  const firstIssuePage = useMemo(() => {
    const pages = measureIssues
      .map((item) => extractSectionPageNumber(resolveIssueSection(score, section, item)))
      .concat(noteIssues.map((item) => extractSectionPageNumber(resolveIssueSection(score, section, item))))
      .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      .map((value) => Number(value));
    return pages.length ? Math.min(...pages) : baseSectionPage;
  }, [baseSectionPage, measureIssues, noteIssues, score, section]);

  useEffect(() => {
    if (!isWholePieceMode) return;
    if (hasAutoSelectedInitialIssuePageRef.current) return;
    hasAutoSelectedInitialIssuePageRef.current = true;
    if (currentPage === firstIssuePage) return;
    setCurrentPage(firstIssuePage);
  }, [currentPage, firstIssuePage, isWholePieceMode, score]);
  const issueMeasureKeys = [
    ...new Set(
      measureIssues
        .map((item) => {
          const resolved = resolveIssueSection(score, section, item);
          return sectionKey(item.sectionId || resolved?.sectionId, findMatchingErhuMeasureIndex(resolved, item, projectionScore) || item.measureIndex);
        })
        .concat(noteIssues.map((item) => {
          const resolved = resolveIssueSection(score, section, item);
          return sectionKey(item.sectionId || resolved?.sectionId, findMatchingErhuMeasureIndex(resolved, item, projectionScore) || item.measureIndex);
        })),
    ),
  ];
  const activeMeasureKey = selectedMeasureIndex || issueMeasureKeys[0] || "";
  const activeMeasureIndex = activeMeasureKey ? Number(String(activeMeasureKey).split("::").pop()) || null : null;

  const measurePageMap = useMemo(() => {
    const pageMap = new Map();
    for (const currentSection of effectiveSections) {
      const currentSectionId = String(currentSection?.sectionId || "");
      const sectionStaffIndex = getErhuStaffIndex(currentSection, dominantStaffIndex);
      const absolutePage = getAbsoluteIssuePage(currentSection);
      for (const note of Array.isArray(currentSection?.notes) ? currentSection.notes : []) {
        const measureIndex = Number(note?.measureIndex);
        const pageNumber = absolutePage;
        const staffIndex = getNoteStaffIndex(note);
        if (!Number.isFinite(measureIndex) || !Number.isFinite(pageNumber)) continue;
        if (staffIndex !== sectionStaffIndex) continue;
        if (!isErhuMelodyNote(note, currentSection, projectionScore)) continue;
        const key = sectionKey(currentSectionId, measureIndex);
        if (!pageMap.has(key)) {
          pageMap.set(key, pageNumber);
        }
        const localMeasureIndex = Number(note?.notePosition?.localMeasureIndex);
        if (Number.isFinite(localMeasureIndex) && localMeasureIndex > 0) {
          const localKey = sectionKey(currentSectionId, localMeasureIndex);
          if (!pageMap.has(localKey)) pageMap.set(localKey, pageNumber);
        }
      }
    }
    return pageMap;
  }, [dominantStaffIndex, effectiveSections, projectionScore]);

  const noteOverlayItems = useMemo(
    () =>
      noteIssues
        .map((item, index) => {
          const issueSection = resolveIssueSection(score, section, item);
          const issueSectionId = String(issueSection?.sectionId || item?.sectionId || "");
          const sectionStaffIndex = getErhuStaffIndex(issueSection, dominantStaffIndex);
          const exact = findErhuNotePosition(issueSection, item, sectionStaffIndex, projectionScore);
          if (exact) {
            const measureKey = sectionKey(issueSectionId, exact.measureIndex);
            return {
              key: `${issueSectionId}-${item?.noteId || index}-${exact.measureIndex}`,
              sectionId: issueSectionId,
              sectionTitle: formatSectionDisplayName(issueSection),
              noteId: item?.noteId || "",
              issueMeasureIndex: item.measureIndex,
              issueNoteId: item?.noteId || "",
              measureIndex: exact.measureIndex,
              displayMeasureIndex: displayMeasureLookup.get(measureKey) || exact.measureIndex,
              noteOrdinal: getIssueNoteOrdinal(item?.noteId, index + 1),
              left: Math.min(Math.max(exact.normalizedX * 100, 0), 100),
              top: Math.min(Math.max(exact.normalizedY * 100, 0), 100),
              systemIndex: exact.systemIndex,
              scoreLineRole: exact.scoreLineRole,
              scoreLineConfidence: exact.scoreLineConfidence,
              exact: true,
              pageNumber: exact.pageNumber,
              tags: item?.tags || [],
              issueTone: item?.issueTone || getIssueTone(item?.tags || []),
            };
          }
          if (shouldProjectImportedFullScoreSection(issueSection)) {
            return null;
          }
          const { measureIndex, noteIndex } = getApproximateNotePosition(item?.noteId, item?.measureIndex, index + 1);
          const measureKey = sectionKey(issueSectionId, measureIndex);
          const slotWidth = 100 / Math.max(1, measureCount);
          const measureLeft = Math.max(0, (measureIndex - 1) * slotWidth);
          const relativeStep = Math.min(0.85, 0.18 + ((noteIndex - 1) % 6) * 0.12);
          const bandIndex = (noteIndex - 1) % 3;
          return {
            key: `${issueSectionId}-${item?.noteId || index}-${measureIndex}-${noteIndex}`,
            sectionId: issueSectionId,
            sectionTitle: formatSectionDisplayName(issueSection),
            noteId: item?.noteId || "",
            measureIndex,
            displayMeasureIndex: displayMeasureLookup.get(measureKey) || measureIndex,
            noteOrdinal: noteIndex,
            left: Math.min(measureLeft + slotWidth * relativeStep, 98),
            top: 18 + bandIndex * 18,
            exact: false,
            pageNumber: measurePageMap.get(sectionKey(issueSectionId, measureIndex)) || extractSectionPageNumber(issueSection) || baseSectionPage,
            tags: item?.tags || [],
            issueTone: item?.issueTone || getIssueTone(item?.tags || []),
          };
        })
        .filter(Boolean),
    [baseSectionPage, displayMeasureLookup, dominantStaffIndex, measureCount, measurePageMap, noteIssues, projectionScore, score, section],
  );

  const measureIssueEntries = useMemo(
    () =>
      measureIssues.map((item, index) => {
        const issueSection = resolveIssueSection(score, section, item);
        const issueSectionId = String(issueSection?.sectionId || item.sectionId || "");
        const matchedMeasureIndex = findMatchingErhuMeasureIndex(issueSection, item, projectionScore) || item.measureIndex;
        const measureKey = sectionKey(issueSectionId, matchedMeasureIndex);
        const leadPage = isWholePieceMode && isLikelyNonScoreLeadPage(issueSection, score);
        const accompanimentOnly = isWholePieceMode && isLikelyAccompanimentOnlySection(issueSection, projectionScore);
        const hasMelodyMeasure = Boolean(issueSection && hasErhuMelodyMeasure(issueSection, item.measureIndex, projectionScore, item));
        const locationReliable = Boolean(issueSection && !leadPage && !accompanimentOnly && hasMelodyMeasure);
        return {
          ...item,
          sectionId: issueSectionId,
          sectionTitle: item.sectionTitle || formatSectionDisplayName(issueSection),
          pageNumber: locationReliable
            ? (measurePageMap.get(measureKey) || measurePageMap.get(sectionKey(issueSectionId, item.measureIndex)) || extractSectionPageNumber(issueSection))
            : (Number(item.sourcePageNumber || item.pageNumber) || extractSectionPageNumber(issueSection)),
          measureIndex: matchedMeasureIndex,
          sourceMeasureIndex: item.measureIndex,
          displayMeasureIndex: displayMeasureLookup.get(measureKey) || item.measureIndex,
          measureKey,
          issueKey: `measure-${measureKey}`,
          issueNumber: index + 1,
          issueTone: item.issueTone || getIssueTone([item.label]),
          locationReliable,
          needsReview: !locationReliable,
          reviewReason: locationReliable ? "" : "未定位到可靠二胡小节坐标，已保留为复核项",
        };
      }),
    [displayMeasureLookup, isWholePieceMode, measureIssues, measurePageMap, projectionScore, score, section],
  );

  const noteIssueEntries = useMemo(
    () =>
      noteIssues.map((item, index) => {
        const issueSection = resolveIssueSection(score, section, item);
        const issueSectionId = String(issueSection?.sectionId || item.sectionId || "");
        const overlayItem =
          noteOverlayItems.find((overlay) => (
            overlay.sectionId === issueSectionId &&
            Number(overlay.issueMeasureIndex || overlay.measureIndex) === Number(item.measureIndex) &&
            String(overlay.issueNoteId || overlay.noteId || "") === String(item.noteId || "")
          ))
          || null;
        const overlayKey = overlayItem?.key || `note-${item.noteId || index}-${item.measureIndex}`;
        const importedSection = shouldProjectImportedFullScoreSection(issueSection);
        const locationReliable = Boolean(overlayItem && (!importedSection || overlayItem.exact));
        const tags = locationReliable ? item.tags : [...new Set([...(item.tags || []), "需复核"])];
        return {
          ...item,
          tags,
          sectionId: issueSectionId,
          sectionTitle: item.sectionTitle || formatSectionDisplayName(issueSection),
          pageNumber: locationReliable
            ? (overlayItem?.pageNumber || extractSectionPageNumber(issueSection))
            : (Number(item.sourcePageNumber || item.pageNumber) || extractSectionPageNumber(issueSection)),
          measureIndex: overlayItem?.measureIndex || item.measureIndex,
          sourceMeasureIndex: item.measureIndex,
          displayMeasureIndex: overlayItem?.displayMeasureIndex || displayMeasureLookup.get(sectionKey(issueSectionId, item.measureIndex)) || item.measureIndex,
          noteOrdinal: getIssueNoteOrdinal(item.noteId, index + 1),
          overlayItem,
          overlayKey,
          issueKey: `note-${overlayKey}`,
          issueNumber: measureIssueEntries.length + index + 1,
          issueTone: item.issueTone || overlayItem?.issueTone || getIssueTone(tags || []),
          locationReliable,
          needsReview: !locationReliable,
          reviewReason: locationReliable ? "" : "未定位到可靠二胡音符坐标，已保留为复核项",
        };
      }),
    [displayMeasureLookup, measureIssueEntries.length, noteIssues, noteOverlayItems, score, section],
  );

  const issueNumberLookup = useMemo(() => {
    const combined = [
      ...measureIssueEntries.map((item) => ({ ...item, issueKind: "measure" })),
      ...noteIssueEntries.map((item) => ({ ...item, issueKind: "note" })),
    ].sort((left, right) => {
      const pageDelta = (Number(left.pageNumber) || 1) - (Number(right.pageNumber) || 1);
      if (pageDelta) return pageDelta;
      const sectionDelta = String(left.sectionId || "").localeCompare(String(right.sectionId || ""));
      if (sectionDelta) return sectionDelta;
      const measureDelta = (Number(left.measureIndex) || 1) - (Number(right.measureIndex) || 1);
      if (measureDelta) return measureDelta;
      const kindDelta = (left.issueKind === "measure" ? 0 : 1) - (right.issueKind === "measure" ? 0 : 1);
      if (kindDelta) return kindDelta;
      return String(left.noteId || left.issueKey || "").localeCompare(String(right.noteId || right.issueKey || ""));
    });
    return new Map(combined.map((item, index) => [item.issueKey, index + 1]));
  }, [measureIssueEntries, noteIssueEntries]);

  const measureOverlayKeys = useMemo(
    () => [...new Set(measureIssueEntries.filter((item) => item.locationReliable).map((item) => item.measureKey))],
    [measureIssueEntries],
  );

  const issueEntries = useMemo(
    () => [
      ...measureIssueEntries.map((item) => ({
        ...item,
        issueKind: "measure",
        listKey: item.issueKey,
        issueNumber: issueNumberLookup.get(item.issueKey) || item.issueNumber,
      })),
      ...noteIssueEntries.map((item) => ({
        ...item,
        issueKind: "note",
        listKey: item.overlayKey,
        issueNumber: issueNumberLookup.get(item.issueKey) || item.issueNumber,
      })),
    ].sort((left, right) => (left.issueNumber || 0) - (right.issueNumber || 0)),
    [issueNumberLookup, measureIssueEntries, noteIssueEntries],
  );

  const measureIssueNumberMap = useMemo(
    () => new Map(issueEntries.filter((item) => item.issueKind === "measure").map((item) => [item.measureKey, item.issueNumber])),
    [issueEntries],
  );

  const noteIssueNumberMap = useMemo(
    () => new Map(issueEntries.filter((item) => item.issueKind === "note").map((item) => [item.overlayKey, item.issueNumber])),
    [issueEntries],
  );

  const measureIssueToneMap = useMemo(() => {
    const toneMap = new Map();
    for (const item of issueEntries) {
      const key = item.measureKey || sectionKey(item.sectionId, item.measureIndex);
      if (!key) continue;
      toneMap.set(key, mergeIssueTones([toneMap.get(key), item.issueTone]));
    }
    return toneMap;
  }, [issueEntries]);

  const overlayItems = useMemo(() => {
    const exactMeasureOverlays = measureOverlayKeys
      .map((measureKey) => {
        const [measureSectionId, measureText] = String(measureKey).split("::");
        const measureIndex = Number(measureText) || 1;
        const measureSection = effectiveSections.find((item) => String(item?.sectionId || "") === measureSectionId) || section;
        const sectionStaffIndex = getErhuStaffIndex(measureSection, dominantStaffIndex);
        const absolutePage = getAbsoluteIssuePage(measureSection);
        const measureNotes = (Array.isArray(measureSection?.notes) ? measureSection.notes : [])
          .filter((item) => Number(item?.measureIndex) === measureIndex && getNoteStaffIndex(item) === sectionStaffIndex && isErhuMelodyNote(item, measureSection, projectionScore))
          .map((item) => {
            const position = readNotePosition(item, measureSection, absolutePage);
            return {
              pageNumber: position?.pageNumber || absolutePage,
              x: Number(position?.normalizedX),
              y: Number(position?.normalizedY),
            };
          })
          .filter((item) => item.pageNumber === currentPage && Number.isFinite(item.x) && Number.isFinite(item.y));
        if (!measureNotes.length) return null;
        const minX = Math.min(...measureNotes.map((item) => item.x * 100));
        const maxX = Math.max(...measureNotes.map((item) => item.x * 100));
        const minY = Math.min(...measureNotes.map((item) => item.y * 100));
        const maxY = Math.max(...measureNotes.map((item) => item.y * 100));
        return {
          measureKey,
          sectionId: measureSectionId,
          measureIndex,
          pageNumber: currentPage,
          issueTone: measureIssueToneMap.get(measureKey) || "review",
          left: Math.max(0, minX - 2.2),
          top: Math.max(0, minY - 3.2),
          width: Math.max(4.5, (maxX - minX) + 4.4),
          height: Math.max(6.2, (maxY - minY) + 6.4),
        };
      })
      .filter(Boolean);
    if (exactMeasureOverlays.length) {
      return exactMeasureOverlays;
    }
    return measureOverlayKeys
      .filter((measureKey) => (measurePageMap.get(measureKey) || baseSectionPage) === currentPage)
      .map((measureKey) => {
        const [measureSectionId, measureText] = String(measureKey).split("::");
        const measureSection = effectiveSections.find((item) => String(item?.sectionId || "") === measureSectionId) || section;
        if (shouldProjectImportedFullScoreSection(measureSection)) return null;
        const measureIndex = Number(measureText) || 1;
        const slotWidth = 100 / Math.max(1, measureCount);
        const left = Math.max(0, (measureIndex - 1) * slotWidth);
        return {
          measureKey,
          sectionId: measureSectionId,
          measureIndex,
          pageNumber: measurePageMap.get(measureKey) || baseSectionPage,
          issueTone: measureIssueToneMap.get(measureKey) || "review",
          left: Math.min(left, 96),
          top: 10,
          width: Math.max(5.5, Math.min(slotWidth, 18)),
          height: 18,
        };
      })
      .filter(Boolean);
  }, [baseSectionPage, currentPage, dominantStaffIndex, effectiveSections, measureCount, measureIssueToneMap, measureOverlayKeys, measurePageMap, projectionScore, section]);

  const effectiveWidth = stageSize.width > 0 ? stageSize.width * zoom : 0;
  const effectiveHeight = stageSize.height > 0 ? stageSize.height * zoom : 0;
  const melodyBand = useMemo(
    () => {
      if (!hasImportedScoreSections) return null;
      return buildMelodyBand({
        currentPage,
        effectiveSections,
        noteOverlayItems,
        overlayItems,
        selectedNoteKey,
        activeMeasureKey,
        score: projectionScore,
      });
    },
    [activeMeasureKey, currentPage, effectiveSections, hasImportedScoreSections, noteOverlayItems, overlayItems, projectionScore, selectedNoteKey],
  );
  const displayOverlayItems = useMemo(
    () => overlayItems
      .filter((item) => Number(item.pageNumber || currentPage) === currentPage)
      .map((item) => mapOverlayToMelodyBand(item, melodyBand))
      .filter(Boolean),
    [currentPage, melodyBand, overlayItems],
  );
  const displayNoteOverlayItems = useMemo(
    () => noteOverlayItems
      .filter((item) => item.pageNumber === currentPage)
      .map((item) => mapNoteToMelodyBand(item, melodyBand))
      .filter(Boolean),
    [currentPage, melodyBand, noteOverlayItems],
  );
  const currentPageHighlightCount = displayOverlayItems.length + displayNoteOverlayItems.length;
  const displayHeight = melodyBand && effectiveHeight
    ? effectiveHeight * (melodyBand.height / 100)
    : effectiveHeight;
  const sourceOffsetTop = melodyBand && effectiveHeight ? -(effectiveHeight * (melodyBand.top / 100)) : 0;
  const sectionDisplayName = isWholePieceMode ? `${formatScoreTitle(score)} · 整曲问题谱面` : formatSectionDisplayName(section);
  const originalAudioSource =
    analysis?.originalAudio?.url ||
    analysis?.originalAudioUrl ||
    analysis?.audioUrl ||
    analysis?.rawAudioPath ||
    analysis?.diagnostics?.rawAudioPath ||
    "";

  useEffect(() => {
    clearPlaybackStopTimer();
    setPlaybackHint("");
    if (!originalAudioSource || !audioRef.current) return;
    audioRef.current.load();
  }, [originalAudioSource]);

  useEffect(() => () => {
    clearPlaybackStopTimer();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !effectiveWidth || !displayHeight) return;
    const focusNote =
      displayNoteOverlayItems.find((item) => item.key === selectedNoteKey && item.pageNumber === currentPage)
      || displayNoteOverlayItems.find((item) => item.pageNumber === currentPage && sectionKey(item.sectionId, item.measureIndex) === activeMeasureKey && item.exact)
      || displayNoteOverlayItems.find((item) => item.pageNumber === currentPage && sectionKey(item.sectionId, item.measureIndex) === activeMeasureKey)
      || null;
    const focusMeasure = displayOverlayItems.find((item) => item.measureKey === activeMeasureKey) || null;
    const focusLeftPercent = focusNote ? focusNote.left : focusMeasure ? focusMeasure.left + focusMeasure.width / 2 : null;
    const focusTopPercent = focusNote ? focusNote.top : focusMeasure ? focusMeasure.top + focusMeasure.height / 2 : null;
    if (focusLeftPercent == null || focusTopPercent == null) return;
    const targetLeft = (focusLeftPercent / 100) * effectiveWidth - viewport.clientWidth / 2;
    const targetTop = (focusTopPercent / 100) * displayHeight - viewport.clientHeight / 2;
    viewport.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [activeMeasureKey, currentPage, displayHeight, displayNoteOverlayItems, displayOverlayItems, effectiveWidth, selectedNoteKey, zoom]);

  useEffect(() => {
    const targetKey = selectedNoteKey || (activeMeasureKey ? `measure-${activeMeasureKey}` : "");
    if (!targetKey) return;
    const target = issueListRefs.current.get(targetKey);
    if (!target?.scrollIntoView) return;
    target.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeMeasureKey, selectedNoteKey]);

  function clearPlaybackStopTimer() {
    if (playbackStopTimerRef.current && typeof window !== "undefined") {
      window.clearInterval(playbackStopTimerRef.current);
    }
    playbackStopTimerRef.current = null;
  }

  function playIssueAudio(issue, kind) {
    if (!issue || !originalAudioSource || !audioRef.current) return;
    const issueSection = resolveIssueSection(score, section, issue) || section || {};
    const playbackWindow = buildIssuePlaybackWindow(issue, issueSection, kind, analysis, audioRef.current);
    if (!playbackWindow) return;
    clearPlaybackStopTimer();
    const audio = audioRef.current;
    try {
      audio.currentTime = playbackWindow.start;
    } catch {
      setPlaybackHint("原音已加载，但浏览器暂时不能定位到该时间点。");
      return;
    }
    const label = kind === "measure" ? "小节" : "音符";
    const hint = `已定位${label}原音 ${formatPlaybackSeconds(playbackWindow.start)}-${formatPlaybackSeconds(playbackWindow.end)}`;
    setPlaybackHint(hint);
    const playPromise = audio.play();
    if (playPromise?.catch) {
      playPromise.catch(() => {
        setPlaybackHint(`${hint}，可手动点击播放。`);
      });
    }
    if (typeof window !== "undefined") {
      playbackStopTimerRef.current = window.setInterval(() => {
        const currentAudio = audioRef.current;
        if (!currentAudio || currentAudio.paused || currentAudio.ended) {
          clearPlaybackStopTimer();
          return;
        }
        if (currentAudio.currentTime >= playbackWindow.end - 0.05) {
          currentAudio.pause();
          clearPlaybackStopTimer();
        }
      }, 120);
    }
  }

  function handleMeasureJump(measureIndex, item = null) {
    const key = item?.measureKey || sectionKey(item?.sectionId || resolveIssueSection(score, section, item)?.sectionId, measureIndex);
    const playbackIssue = measureIssueEntries.find((entry) => entry.measureKey === key) || item;
    setCurrentPage(item?.pageNumber || measurePageMap.get(key) || baseSectionPage);
    setSelectedMeasureIndex(key);
    setSelectedNoteKey("");
    playIssueAudio(playbackIssue, "measure");
  }

  function handlePageNavigation(nextPage) {
    setSelectedMeasureIndex(null);
    setSelectedNoteKey("");
    setCurrentPage(Math.max(1, Math.min(pageCount || nextPage, nextPage)));
  }

  function handleNoteJump(noteItem, overlayItem) {
    if (!noteItem) return;
    const resolvedOverlay =
      overlayItem
      || noteOverlayItems.find((item) => (
        String(item.noteId || "") === String(noteItem.noteId || "")
        && item.measureIndex === noteItem.measureIndex
        && (!noteItem.sectionId || item.sectionId === noteItem.sectionId)
      ))
      || null;
    const key = sectionKey(resolvedOverlay?.sectionId || noteItem.sectionId || resolveIssueSection(score, section, noteItem)?.sectionId, noteItem.measureIndex);
    setCurrentPage(resolvedOverlay?.pageNumber || noteItem.pageNumber || measurePageMap.get(key) || baseSectionPage);
    setSelectedMeasureIndex(key);
    setSelectedNoteKey(resolvedOverlay?.key || "");
    playIssueAudio(noteItem, "note");
  }

  function handleImageLoad(event) {
    const image = event.currentTarget;
    const naturalW = image.naturalWidth || image.width || 0;
    const naturalH = image.naturalHeight || image.height || 0;
    setStageSize({ width: naturalW, height: naturalH });
    if (!hasAutoFittedRef.current && viewportRef.current && naturalW > 0) {
      const available = viewportRef.current.clientWidth - 8;
      setZoom(Math.max(0.75, Math.min(4, parseFloat((available / naturalW).toFixed(2)))));
      hasAutoFittedRef.current = true;
    }
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
      <ScoreIssueHeader
        sectionDisplayName={sectionDisplayName}
        pitchScore={getDisplayPitchScore(analysis)}
        rhythmScore={getDisplayRhythmScore(analysis)}
        combinedScore={getDisplayCombinedScore(analysis)}
        practicePathLabel={formatPracticePathLabel(analysis?.recommendedPracticePath)}
        sourcePdfPath={score?.sourcePdfPath}
      />

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="score-issue-layout">
        <ScoreIssueSidebar
          originalAudioSource={originalAudioSource}
          audioRef={audioRef}
          playbackHint={playbackHint}
          summaryText={summarizeOverallFeedback(visibleAnalysisForSummary)}
          ambiguousImportedScore={ambiguousImportedScore}
          createdAtText={formatDateTime(analysis?.createdAt || stored?.savedAt)}
          issueEntries={issueEntries}
          activeMeasureKey={activeMeasureKey}
          selectedNoteKey={selectedNoteKey}
          setIssueListRef={setIssueListRef}
          onMeasureJump={handleMeasureJump}
          onNoteJump={handleNoteJump}
          issueToneClass={issueToneClass}
          formatDisplayMeasureLabel={formatDisplayMeasureLabel}
          formatDisplayNoteLabel={formatDisplayNoteLabel}
        />

        <section className="panel-card score-page-panel">
          <ScorePageToolbar
            sectionDisplayName={sectionDisplayName}
            currentPage={currentPage}
            pageCount={pageCount}
            currentPageHighlightCount={currentPageHighlightCount}
            totalIssueCount={issueEntries.length}
            hasImportedScoreSections={hasImportedScoreSections}
            ambiguousImportedScore={ambiguousImportedScore}
          />

          <ScorePageNav
            currentPage={currentPage}
            pageCount={pageCount}
            firstIssuePage={firstIssuePage}
            zoom={zoom}
            setZoom={setZoom}
            stageSize={stageSize}
            viewportRef={viewportRef}
            onPageNavigation={handlePageNavigation}
          />

          <div ref={viewportRef} className="score-page-viewport">
            <ScorePageStage
              canvasRef={canvasRef}
              usePageImage={usePageImage}
              pageImagePath={pageImagePath}
              currentPage={currentPage}
              onImageError={() => setPageImageFailed(true)}
              onImageLoad={handleImageLoad}
              effectiveWidth={effectiveWidth}
              effectiveHeight={effectiveHeight}
              displayHeight={displayHeight}
              melodyBand={melodyBand}
              sourceOffsetTop={sourceOffsetTop}
              displayOverlayItems={displayOverlayItems}
              displayNoteOverlayItems={displayNoteOverlayItems}
              activeMeasureKey={activeMeasureKey}
              selectedNoteKey={selectedNoteKey}
              onMeasureJump={handleMeasureJump}
              onNoteJump={handleNoteJump}
              issueToneClass={issueToneClass}
              measureIssueNumberMap={measureIssueNumberMap}
              noteIssueNumberMap={noteIssueNumberMap}
              noteIssueEntries={noteIssueEntries}
              formatDisplayNoteLabel={formatDisplayNoteLabel}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
