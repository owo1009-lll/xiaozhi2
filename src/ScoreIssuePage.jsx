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

function buildImportedPageImagePath(score, section, pageNumber) {
  const explicit = String(section?.pageImagePath || "").trim();
  if (explicit) return explicit;
  const pdfUrl = String(score?.sourcePdfPath || "").trim();
  if (!pdfUrl) return "";
  const match = pdfUrl.match(/^(.*)\/source\.pdf$/i);
  if (!match) return "";
  return `${match[1]}/pagewise/page-${String(Math.max(1, Number(pageNumber) || 1)).padStart(3, "0")}.png`;
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
    if (item?.pitchLabel && item.pitchLabel !== "pitch-ok") {
      tags.push("音准问题");
    }
    if (item?.rhythmType || item?.rhythmLabel) {
      tags.push("节奏问题");
    }
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
  const [pageImageFailed, setPageImageFailed] = useState(false);
  const canvasRef = useRef(null);

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

  const pageNumber = extractSectionPageNumber(section || {});
  const pageImagePath = buildImportedPageImagePath(score, section, currentPage);
  const usePageImage = Boolean(pageImagePath && !pageImageFailed);

  useEffect(() => {
    if (!usePageImage) return;
    const previewCount = Array.isArray(score?.previewPages) ? score.previewPages.length : 0;
    const omrPageCount = Number(score?.omrStats?.pageCount);
    const effectivePageCount = Number.isFinite(omrPageCount) && omrPageCount > 0 ? omrPageCount : previewCount;
    setPageCount(Math.max(currentPage || 1, effectivePageCount || 0));
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

  const noteOverlayItems = useMemo(
    () =>
      noteIssues.map((item, index) => {
        const exact = readExactNotePosition(section, item?.noteId);
        if (exact) {
          return {
            key: `${item?.noteId || index}-${exact.measureIndex}`,
            measureIndex: exact.measureIndex,
            left: Math.min(Math.max(exact.normalizedX * 100, 0), 100),
            top: Math.min(Math.max(exact.normalizedY * 100, 0), 100),
            exact: true,
            pageNumber: exact.pageNumber,
          };
        }
        const { measureIndex, noteIndex } = getApproximateNotePosition(item?.noteId, item?.measureIndex, index + 1);
        const slotWidth = 100 / Math.max(1, measureCount);
        const measureLeft = Math.max(0, (measureIndex - 1) * slotWidth);
        const relativeStep = Math.min(0.85, 0.18 + ((noteIndex - 1) % 6) * 0.12);
        const bandIndex = (noteIndex - 1) % 3;
        return {
          key: `${item?.noteId || index}-${measureIndex}-${noteIndex}`,
          measureIndex,
          left: Math.min(measureLeft + slotWidth * relativeStep, 98),
          top: 18 + bandIndex * 18,
          exact: false,
          pageNumber,
        };
      }),
    [noteIssues, measureCount, pageNumber, section],
  );

  const hasExactNoteOverlay = noteOverlayItems.some((item) => item.exact);

  const overlayItems = useMemo(() => {
    if (hasExactNoteOverlay) {
      return issueMeasureIndexes
        .map((measureIndex) => {
          const measureNotes = (Array.isArray(section?.notes) ? section.notes : [])
            .filter((item) => Number(item?.measureIndex) === measureIndex)
            .map((item) => ({
              pageNumber: Number(item?.notePosition?.pageNumber) || pageNumber,
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
            left: Math.max(0, minX - 2.6),
            top: Math.max(0, minY - 7.5),
            width: Math.max(5.5, (maxX - minX) + 5.2),
            height: Math.max(14, (maxY - minY) + 15),
          };
        })
        .filter(Boolean);
    }
    return issueMeasureIndexes.map((measureIndex) => {
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
  }, [currentPage, hasExactNoteOverlay, issueMeasureIndexes, measureCount, pageNumber, section]);

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
        <div>
          <span className="eyebrow">ISSUE SCORE VIEW</span>
          <h1>问题谱面页</h1>
          <p className="supporting-copy">这里仅保留原音回放、谱面高亮，以及音准问题和节奏问题两类结果。</p>
        </div>
        <div className="score-issue-actions">
          <button type="button" className="secondary-button" onClick={() => window.close()}>
            关闭页面
          </button>
          {score?.sourcePdfPath ? (
            <a className="secondary-link" href={score.sourcePdfPath} target="_blank" rel="noreferrer">
              打开 PDF
            </a>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="score-issue-layout">
        <section className="panel-card">
          <div className="section-title">
            <span className="section-step">A</span>
            <div>
              <h2>本轮结果</h2>
              <p>仅保留总分、原音和总体反馈。</p>
            </div>
          </div>

          <div className="result-grid">
            <ScoreBlock label="音高" value={getDisplayPitchScore(analysis)} />
            <ScoreBlock label="节奏" value={getDisplayRhythmScore(analysis)} />
            <ScoreBlock label="综合" value={getDisplayCombinedScore(analysis)} />
            <ScoreBlock label="路径" value={formatPracticePathLabel(analysis?.recommendedPracticePath)} />
          </div>

          <div className="history-card">
            <h3>原音</h3>
            {analysis?.rawAudioPath ? <audio controls className="audio-player" src={analysis.rawAudioPath} /> : <p>当前没有可播放的原音。</p>}
          </div>

          <div className="history-card">
            <h3>总体反馈</h3>
            <p>{summarizeOverallFeedback(analysis)}</p>
            <p className="supporting-copy">分析时间：{formatDateTime(analysis?.createdAt || stored?.savedAt)}</p>
          </div>

          <div className="history-card">
            <h3>问题列表</h3>
            <ul className="compact-list">
              {measureIssues.map((item) => (
                <li key={`measure-${item.measureIndex}`}>
                  {formatMeasureLabel(item.measureIndex)}：{item.label}
                </li>
              ))}
              {noteIssues.map((item, index) => (
                <li key={`note-${item.noteId || index}-${item.measureIndex}`}>
                  {formatNoteLabel(item.noteId, item.measureIndex)}：{item.tags.join("、")}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="panel-card score-page-panel">
          <div className="section-title">
            <span className="section-step">B</span>
            <div>
              <h2>问题谱面高亮</h2>
              <p>所有问题都放在这里高亮显示，主结果页不再重复展示详细解释。</p>
            </div>
          </div>

          <div className="score-page-toolbar">
            <span>{section?.title || "当前段落"}</span>
            <span>页码：{currentPage}/{pageCount || currentPage}</span>
            <span>问题小节：{issueMeasureIndexes.length || 0}</span>
          </div>

          {issueMeasureIndexes.length ? (
            <div className="issue-chip-row">
              {issueMeasureIndexes.map((measureIndex) => (
                <button
                  type="button"
                  key={`measure-chip-${measureIndex}`}
                  className={`issue-chip${activeMeasureIndex === measureIndex ? " is-active" : ""}`}
                  onClick={() => {
                    setCurrentPage(pageNumber);
                    setSelectedMeasureIndex(measureIndex);
                  }}
                >
                  {formatMeasureLabel(measureIndex)}
                </button>
              ))}
            </div>
          ) : null}

          <div className="score-page-nav">
            <button type="button" className="secondary-button" onClick={() => setCurrentPage((value) => Math.max(1, value - 1))} disabled={currentPage <= 1}>
              上一页
            </button>
            <button type="button" className="secondary-button" onClick={() => setCurrentPage(pageNumber)}>
              回到问题页
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setCurrentPage((value) => Math.min(Math.max(pageCount, 1), value + 1))}
              disabled={pageCount > 0 && currentPage >= pageCount}
            >
              下一页
            </button>
          </div>

          <div className="score-page-canvas-wrap">
            {usePageImage ? (
              <img className="score-page-image" src={pageImagePath} alt={`score-page-${currentPage}`} onError={() => setPageImageFailed(true)} />
            ) : (
              <canvas ref={canvasRef} className="pdf-preview-canvas" />
            )}
            {currentPage === pageNumber ? (
              <div className="score-measure-overlay" aria-hidden="true">
                {overlayItems.map((item) => (
                  <div
                    key={`measure-${item.measureIndex}`}
                    className={`score-measure-highlight${activeMeasureIndex === item.measureIndex ? " is-active" : ""}`}
                    style={{
                      left: `${item.left}%`,
                      top: `${item.top}%`,
                      width: `${item.width}%`,
                      height: `${item.height}%`,
                    }}
                  >
                    <span>{item.measureIndex}</span>
                  </div>
                ))}
                {noteOverlayItems
                  .filter((item) => item.pageNumber === currentPage && (activeMeasureIndex == null || item.measureIndex === activeMeasureIndex))
                  .map((item) => (
                    <div
                      key={item.key}
                      className={`score-note-highlight${item.exact ? " is-exact" : ""}`}
                      style={{ left: `${item.left}%`, top: `${item.top}%` }}
                    />
                  ))}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
