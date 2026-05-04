export function ScoreIssueHeader({
  sectionDisplayName,
  pitchScore,
  rhythmScore,
  combinedScore,
  practicePathLabel,
  sourcePdfPath,
}) {
  return (
    <header className="panel-card score-issue-header">
      <div className="score-issue-title">
        <h1>{sectionDisplayName || "问题谱面"}</h1>
        <div className="score-inline-scores">
          <span className="score-inline-chip">音准 <strong>{pitchScore}</strong></span>
          <span className="score-inline-chip">节奏 <strong>{rhythmScore}</strong></span>
          <span className="score-inline-chip">综合 <strong>{combinedScore}</strong></span>
          <span className="score-inline-chip is-muted">{practicePathLabel}</span>
        </div>
      </div>
      <div className="score-issue-actions">
        <button type="button" className="secondary-button" onClick={() => window.close()}>关闭</button>
        {sourcePdfPath ? (
          <a className="secondary-link" href={sourcePdfPath} target="_blank" rel="noreferrer">打开 PDF</a>
        ) : null}
      </div>
    </header>
  );
}

export function ScoreIssueSidebar({
  originalAudioSource,
  audioRef,
  playbackHint,
  summaryText,
  ambiguousImportedScore,
  createdAtText,
  issueEntries,
  activeMeasureKey,
  selectedNoteKey,
  setIssueListRef,
  onMeasureJump,
  onNoteJump,
  issueToneClass,
  formatDisplayMeasureLabel,
  formatDisplayNoteLabel,
}) {
  return (
    <aside className="panel-card score-sidebar">
      {originalAudioSource ? (
        <div className="sidebar-block">
          <p className="sidebar-label">原音</p>
          <audio ref={audioRef} controls preload="metadata" className="audio-player" src={originalAudioSource} />
          {playbackHint ? <p className="sidebar-meta">{playbackHint}</p> : null}
        </div>
      ) : null}

      <div className="sidebar-block">
        <p className="sidebar-label">总体反馈</p>
        <p className="sidebar-text">{summaryText}</p>
        {ambiguousImportedScore ? (
          <p className="sidebar-meta">
            当前谱面只高亮二胡旋律单行。无法确认属于二胡旋律的疑似问题会保留在列表中，并标记为需复核，不会显示到伴奏行上。
          </p>
        ) : null}
        <p className="sidebar-meta">{createdAtText}</p>
      </div>

      <div className="sidebar-block sidebar-issues">
        <p className="sidebar-label">问题列表</p>
        <div className="issue-list-block">
          {issueEntries.map((item, index) => {
            if (item.issueKind === "measure") {
              return (
                <button
                  type="button"
                  key={item.issueKey}
                  ref={(element) => setIssueListRef(item.issueKey, element)}
                  className={`issue-list-button${issueToneClass(item.issueTone)}${activeMeasureKey === item.measureKey && !selectedNoteKey ? " is-active" : ""}`}
                  onClick={() => onMeasureJump(item.measureIndex, item)}
                >
                  <strong>
                    <span className="issue-number-chip">{item.issueNumber}</span>
                    {formatDisplayMeasureLabel(item.measureIndex, item.displayMeasureIndex)}
                  </strong>
                  <span>
                    {item.label}
                    {item.needsReview ? `，${item.reviewReason || "需复核"}` : ""}
                  </span>
                </button>
              );
            }
            const overlayItem = item.overlayItem || null;
            const overlayKey = item.overlayKey || item.listKey || "";
            return (
              <button
                type="button"
                key={`note-${item.noteId || index}-${item.measureIndex}`}
                ref={(element) => setIssueListRef(overlayKey, element)}
                className={`issue-list-button${issueToneClass(item.issueTone)}${selectedNoteKey && selectedNoteKey === overlayKey ? " is-active" : ""}`}
                onClick={() => onNoteJump(item, overlayItem)}
              >
                <strong>
                  <span className="issue-number-chip">{item.issueNumber}</span>
                  {formatDisplayNoteLabel(item.noteId, item.measureIndex, item.displayMeasureIndex, item.noteOrdinal)}
                </strong>
                <span>
                  {item.tags.join("、")}
                  {item.needsReview ? `，${item.reviewReason || "需复核"}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

export function ScorePageToolbar({
  sectionDisplayName,
  currentPage,
  pageCount,
  currentPageHighlightCount,
  totalIssueCount,
  hasImportedScoreSections,
  ambiguousImportedScore,
}) {
  return (
    <div className="score-page-toolbar">
      <span>{sectionDisplayName || "当前段落"}</span>
      <span>第 {currentPage} 页{pageCount > 0 ? ` / ${pageCount}` : ""}</span>
      <span>本页 {currentPageHighlightCount} 个高亮 / 全曲 {totalIssueCount} 个问题</span>
      <span className="issue-color-legend">
        <i className="legend-dot issue-tone-pitch" />音准
        <i className="legend-dot issue-tone-rhythm" />节奏
        <i className="legend-dot issue-tone-both" />二者
      </span>
      {hasImportedScoreSections ? (
        <span className={`issue-line-mode${ambiguousImportedScore ? " is-ambiguous" : ""}`}>
          二胡旋律单行视图
        </span>
      ) : null}
    </div>
  );
}

export function ScorePageNav({
  currentPage,
  pageCount,
  firstIssuePage,
  zoom,
  setZoom,
  stageSize,
  viewportRef,
  onPageNavigation,
}) {
  return (
    <div className="score-page-nav">
      <button type="button" className="secondary-button" onClick={() => onPageNavigation(currentPage - 1)} disabled={currentPage <= 1}>
        上一页
      </button>
      <button type="button" className="secondary-button" onClick={() => onPageNavigation(firstIssuePage)}>
        回到问题页
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => onPageNavigation(currentPage + 1)}
        disabled={pageCount > 0 && currentPage >= pageCount}
      >
        下一页
      </button>
      <div className="score-zoom-group">
        <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.max(0.75, Number((value - 0.15).toFixed(2))))}>
          缩小
        </button>
        <span className="score-zoom-label">{Math.round(zoom * 100)}%</span>
        <button type="button" className="secondary-button" onClick={() => setZoom((value) => Math.min(4, Number((value + 0.15).toFixed(2))))}>
          放大
        </button>
        <button type="button" className="secondary-button" onClick={() => {
          const w = stageSize.width;
          const cw = viewportRef.current?.clientWidth;
          if (w && cw) {
            setZoom(Math.max(0.75, Math.min(4, parseFloat(((cw - 8) / w).toFixed(2)))));
          } else {
            setZoom(1.0);
          }
        }}>
          适应宽度
        </button>
      </div>
    </div>
  );
}

export function ScorePageStage({
  canvasRef,
  usePageImage,
  pageImagePath,
  currentPage,
  onImageError,
  onImageLoad,
  effectiveWidth,
  effectiveHeight,
  displayHeight,
  melodyBand,
  sourceOffsetTop,
  displayOverlayItems,
  displayNoteOverlayItems,
  activeMeasureKey,
  selectedNoteKey,
  onMeasureJump,
  onNoteJump,
  issueToneClass,
  measureIssueNumberMap,
  noteIssueNumberMap,
  noteIssueEntries,
  formatDisplayNoteLabel,
}) {
  return (
    <div
      className={`score-page-stage${melodyBand ? " is-melody-band" : ""}`}
      style={{
        width: effectiveWidth ? `${effectiveWidth}px` : undefined,
        height: displayHeight ? `${displayHeight}px` : undefined,
      }}
    >
      {usePageImage ? (
        <img
          className={`score-page-image${melodyBand ? " score-page-source-cropped" : ""}`}
          src={pageImagePath}
          alt={`score-page-${currentPage}`}
          onError={onImageError}
          onLoad={onImageLoad}
          style={{
            width: effectiveWidth ? `${effectiveWidth}px` : undefined,
            height: effectiveHeight ? `${effectiveHeight}px` : undefined,
            top: melodyBand ? `${sourceOffsetTop}px` : undefined,
          }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          className={`pdf-preview-canvas${melodyBand ? " score-page-source-cropped" : ""}`}
          style={{
            width: effectiveWidth ? `${effectiveWidth}px` : undefined,
            height: effectiveHeight ? `${effectiveHeight}px` : undefined,
            top: melodyBand ? `${sourceOffsetTop}px` : undefined,
          }}
        />
      )}
      <div className="score-measure-overlay" aria-hidden="true">
        {displayOverlayItems.map((item) => (
          <button
            type="button"
            key={`measure-${item.measureKey}`}
            className={`score-measure-highlight${issueToneClass(item.issueTone)}${activeMeasureKey === item.measureKey ? " is-active" : ""}`}
            onClick={() => onMeasureJump(item.measureIndex, item)}
            style={{
              left: `${item.left}%`,
              top: `${item.top}%`,
              width: `${item.width}%`,
              height: `${item.height}%`,
            }}
          >
            <span>{measureIssueNumberMap.get(item.measureKey) || item.measureIndex}</span>
          </button>
        ))}
        {displayNoteOverlayItems.map((item) => {
          const relatedIssue =
            noteIssueEntries.find((noteIssue) => String(noteIssue.noteId || "") === String(item.noteId || "") && noteIssue.measureIndex === item.measureIndex && noteIssue.sectionId === item.sectionId)
            || { noteId: item.noteId, measureIndex: item.measureIndex };
          return (
            <button
              type="button"
              key={item.key}
              className={`score-note-highlight${issueToneClass(item.issueTone)}${item.exact ? " is-exact" : ""}${selectedNoteKey === item.key ? " is-selected" : ""}`}
              style={{ left: `${item.left}%`, top: `${item.top}%` }}
              onClick={() => onNoteJump(relatedIssue, item)}
              aria-label={formatDisplayNoteLabel(
                item.noteId,
                item.measureIndex,
                relatedIssue.displayMeasureIndex || item.displayMeasureIndex,
                relatedIssue.noteOrdinal || item.noteOrdinal,
              )}
            >
              <span className="score-note-index">{noteIssueNumberMap.get(item.key) || "•"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
