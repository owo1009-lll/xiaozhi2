import {
  measureDisplayLabel,
  parseList,
  percentStyle,
} from "./teacherValidationUtils.js";

export default function ScoreLocatorPanel({
  item,
  activeLocator,
  activeMeasureIndex,
  activeNoteId,
  noteIdSet,
  measureIndexSet,
  onActivateMeasure,
  onActivateNote,
  onMarkActiveMeasure,
  onMarkActiveNote,
}) {
  const locator = item?.scoreLocator;
  const notes = locator?.notePositions || [];
  const measures = locator?.measurePositions || [];
  const focusRegions = locator?.focusRegions || [];
  const systemIssueNoteIdSet = new Set(parseList(item?.systemIssueNoteIds || item?.review?.systemIssueNoteIds || ""));
  const visibleNotes = notes.filter((note) => {
    const ids = [note.noteId, note.sourceNoteId].filter(Boolean);
    return ids.some((id) => systemIssueNoteIdSet.has(id) || noteIdSet.has(id) || id === activeNoteId);
  });
  const activeNote = notes.find((note) => note.noteId === activeNoteId || note.sourceNoteId === activeNoteId);
  const activeMeasure = measures.find((measure) =>
    Number(measure.measureIndex) === Number(activeMeasureIndex) ||
    Number(measure.globalMeasureIndex) === Number(activeMeasureIndex) ||
    Number(measure.displayMeasureIndex) === Number(activeMeasureIndex),
  );
  const activeLabel = activeNote?.label || activeMeasure?.label || (activeMeasureIndex ? measureDisplayLabel(activeMeasureIndex) : locator?.pageNumber ? `第 ${locator.pageNumber} 页` : "未定位");

  return (
    <div className="teacher-media-block teacher-score-locator">
      <div className="teacher-score-head">
        <div>
          <h3>谱面定位</h3>
          <p>{activeLabel}</p>
        </div>
        <div className="teacher-score-actions">
          <button type="button" className="secondary-button" onClick={onMarkActiveMeasure} disabled={!activeMeasureIndex}>
            标记当前小节
          </button>
          <button type="button" className="secondary-button" onClick={onMarkActiveNote} disabled={!activeNoteId}>
            标记当前音
          </button>
          <a className="secondary-link" href={item?.pdfUrl} target="_blank" rel="noreferrer">
            打开完整 PDF
          </a>
        </div>
      </div>

      {locator?.pageImagePath ? (
        <div className="teacher-score-page-frame">
          <div className="teacher-score-page">
            <img src={locator.pageImagePath} alt={`${item?.title || "谱面"} ${locator.pageNumber || ""}`} />
            {focusRegions.map((region, index) => (
              <div
                key={`${region.pageNumber || 1}-${region.systemIndex || 0}-${region.staffIndex || 0}-${index}`}
                className="teacher-score-focus-region"
                style={{
                  left: percentStyle(region.xMin),
                  top: percentStyle(region.yMin),
                  width: percentStyle(Math.max(0.02, region.xMax - region.xMin)),
                  height: percentStyle(Math.max(0.025, region.yMax - region.yMin)),
                }}
                title={region.label}
                aria-label={region.label}
              />
            ))}
            {measures.map((measure) => {
              const isSelected =
                measureIndexSet.has(String(measure.measureIndex)) ||
                measureIndexSet.has(String(measure.globalMeasureIndex || measure.displayMeasureIndex || ""));
              const isActive =
                Number(measure.measureIndex) === Number(activeMeasureIndex) ||
                Number(measure.globalMeasureIndex) === Number(activeMeasureIndex) ||
                Number(measure.displayMeasureIndex) === Number(activeMeasureIndex);
              return (
                <button
                  key={measure.measureIndex}
                  type="button"
                  className={`teacher-score-measure${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
                  style={{
                    left: percentStyle(measure.xMin),
                    top: percentStyle(measure.yMin),
                    width: percentStyle(Math.max(0.02, measure.xMax - measure.xMin)),
                    height: percentStyle(Math.max(0.025, measure.yMax - measure.yMin)),
                  }}
                  title={measure.label}
                  aria-label={measure.label}
                  onClick={() => onActivateMeasure(measure.globalMeasureIndex || measure.displayMeasureIndex || measure.measureIndex)}
                />
              );
            })}
            {visibleNotes.map((note) => {
              const isSelected = noteIdSet.has(note.noteId) || noteIdSet.has(note.sourceNoteId);
              const isActive = activeLocator?.type === "note" && (note.noteId === activeNoteId || note.sourceNoteId === activeNoteId);
              return (
                <button
                  key={note.noteId}
                  type="button"
                  className={`teacher-score-note${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
                  style={{ left: percentStyle(note.x), top: percentStyle(note.y) }}
                  title={note.label}
                  aria-label={note.label}
                  onClick={() => onActivateNote(note)}
                />
              );
            })}
          </div>
        </div>
      ) : (
        <p className="empty-card">当前谱面没有可用的小节坐标，只能打开完整 PDF 人工核对。</p>
      )}
    </div>
  );
}
