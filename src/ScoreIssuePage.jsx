import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import {
  extractSectionPageNumber,
  formatMeasureIssueLabelText,
  formatMeasureLabel,
  formatNoteLabel,
  formatPitchLabelText,
  formatPracticePathLabel,
  formatRhythmLabelText,
  formatSectionDisplayName,
  getDisplayCombinedScore,
  getDisplayPitchScore,
  getDisplayRhythmScore,
  getSectionMeasureCount,
  replaceXmlIdsInText,
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
    const raw = window.sessionStorage.getItem(`ai-erhu.issue-session.${issueSessionId}`);
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

function buildIssueMeasures(analysis) {
  const measureMap = new Map();

  for (const finding of analysis?.measureFindings || []) {
    const measureIndex = Number(finding?.measureIndex);
    if (!Number.isFinite(measureIndex)) continue;
    const bucket = measureMap.get(measureIndex) || [];
    bucket.push({
      type: "measure",
      label: formatMeasureIssueLabelText(finding),
      detail: finding?.detail || "",
      tip: finding?.coachingTip || "",
    });
    measureMap.set(measureIndex, bucket);
  }

  for (const finding of analysis?.noteFindings || []) {
    const measureIndex = Number(finding?.measureIndex);
    if (!Number.isFinite(measureIndex)) continue;
    const bucket = measureMap.get(measureIndex) || [];
    bucket.push({
      type: "note",
      label: formatNoteLabel(finding?.noteId, finding?.measureIndex),
      detail: `${formatPitchLabelText(finding?.pitchLabel)}，${formatRhythmLabelText(finding)}`,
      tip: finding?.action || "",
    });
    measureMap.set(measureIndex, bucket);
  }

  return [...measureMap.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([measureIndex, issues]) => ({ measureIndex, issues }));
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
          setError("问题乐谱数据已失效，请返回结果页重新打开。");
        }
      }
    }
    void loadScore();
    return () => {
      cancelled = true;
    };
  }, [score?.sourcePdfPath, stored]);

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;

    async function renderPdf() {
      const pdfUrl = score?.sourcePdfPath;
      if (!pdfUrl || !canvasRef.current) return;
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
  }, [currentPage, score?.sourcePdfPath]);

  const pageNumber = extractSectionPageNumber(section || {});
  const measureCount = getSectionMeasureCount(section || {});
  const groupedIssues = useMemo(() => buildIssueMeasures(analysis), [analysis]);
  const issueMeasureIndexes = groupedIssues.map((item) => item.measureIndex);
  const overlayItems = issueMeasureIndexes.map((measureIndex) => {
    const slotWidth = 100 / Math.max(1, measureCount);
    const left = Math.max(0, (measureIndex - 1) * slotWidth);
    return {
      measureIndex,
      left: Math.min(left, 96),
      width: Math.max(5.5, Math.min(slotWidth, 18)),
    };
  });

  if (!analysis || !stored) {
    return (
      <div className="app-shell">
        <section className="panel-card">
          <h2>问题乐谱页不可用</h2>
          <p className="supporting-copy">没有找到当前分析结果。请从学生端结果页重新打开“问题乐谱页”。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell score-issue-shell">
      <header className="panel-card score-issue-header">
        <div>
          <span className="eyebrow">ISSUE SCORE VIEW</span>
          <h1>问题乐谱页</h1>
          <p className="supporting-copy">
            {formatSectionDisplayName(section || {})}。当前页面会把问题小节直接覆盖到乐谱上，并且只保留原音回放。
          </p>
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
              <p>只保留学生真正需要的内容：音高、节奏、综合分、原音和练习路径。</p>
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
            {analysis?.rawAudioPath ? (
              <audio controls className="audio-player" src={analysis.rawAudioPath} />
            ) : (
              <p>当前没有可播放的原音。</p>
            )}
          </div>

          <div className="history-card">
            <h3>问题摘要</h3>
            <p>{replaceXmlIdsInText(analysis?.summaryText || "本轮分析已完成。")}</p>
            <p className="supporting-copy">分析时间：{formatDateTime(analysis?.createdAt || stored?.savedAt)}</p>
          </div>
        </section>

        <section className="panel-card score-page-panel">
          <div className="section-title">
            <span className="section-step">B</span>
            <div>
              <h2>乐谱高亮</h2>
              <p>系统会在当前页把问题小节高亮出来，便于直接对照乐谱复练。</p>
            </div>
          </div>

          <div className="score-page-toolbar">
            <span>{formatSectionDisplayName(section || {})}</span>
            <span>页码：{currentPage}/{pageCount || currentPage}</span>
            <span>问题小节：{issueMeasureIndexes.length || 0}</span>
          </div>

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
            <canvas ref={canvasRef} className="pdf-preview-canvas" />
            {currentPage === pageNumber ? (
              <div className="score-measure-overlay" aria-hidden="true">
                {overlayItems.map((item) => (
                  <div
                    key={`measure-${item.measureIndex}`}
                    className="score-measure-highlight"
                    style={{ left: `${item.left}%`, width: `${item.width}%` }}
                  >
                    <span>{item.measureIndex}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="panel-card">
        <div className="section-title">
          <span className="section-step">C</span>
          <div>
            <h2>问题明细</h2>
            <p>这里统一改成“小节 / 第几音”的表达，不再显示内部 XML ID。</p>
          </div>
        </div>

        <div className="findings-grid">
          {groupedIssues.map((group) => (
            <div className="finding-card" key={`group-${group.measureIndex}`}>
              <h3>{formatMeasureLabel(group.measureIndex)}</h3>
              <ul>
                {group.issues.map((item, index) => (
                  <li key={`${group.measureIndex}-${index}`}>
                    <strong>{item.label}</strong>
                    {item.detail ? <span className="finding-help">{replaceXmlIdsInText(item.detail)}</span> : null}
                    {item.tip ? <span className="finding-help">建议：{replaceXmlIdsInText(item.tip)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {!groupedIssues.length ? <div className="empty-card">当前没有需要高亮的问题小节。</div> : null}

        {(analysis?.practiceTargets || []).length ? (
          <div className="history-card">
            <h3>优先练习顺序</h3>
            <ol className="compact-list practice-list">
              {(analysis.practiceTargets || []).map((target) => (
                <li key={`${target.priority}-${target.targetId || target.measureIndex || target.title}`}>
                  <strong>
                    {target?.targetType === "note"
                      ? formatNoteLabel(target?.targetId, target?.measureIndex)
                      : target?.measureIndex
                        ? `重练第 ${target.measureIndex} 小节`
                        : target?.title}
                  </strong>
                  <span className="finding-help">{replaceXmlIdsInText(target?.why)}</span>
                  <span className="finding-help">建议：{replaceXmlIdsInText(target?.action)}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ScoreBlock({ label, value }) {
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong>{typeof value === "number" ? value : String(value || "")}</strong>
    </div>
  );
}
