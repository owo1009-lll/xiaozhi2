import {
  measureDisplayLabel,
  parseList,
  percentStyle,
} from "./teacherValidationUtils.js";

function toLineRank(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rank = Math.round(numeric);
  return rank > 0 ? rank : null;
}

function isErhuLineRank(entry = {}) {
  const rank = toLineRank(entry.systemIndex);
  return !rank || (rank - 1) % 3 === 0;
}

function shouldFilterThreeStaffLineRanks(locator = {}) {
  if (locator?.lineProjectionGuardApplied) return false;
  if (locator?.lineRankFilterApplied) return true;
  const ranks = new Set();
  for (const entry of [
    ...(locator?.notePositions || []),
    ...(locator?.measurePositions || []),
    ...(locator?.focusRegions || []),
  ]) {
    const rank = toLineRank(entry?.systemIndex);
    if (rank) ranks.add(rank);
  }
  if (ranks.size < 2) return false;
  return [...ranks].some((rank) => !isErhuLineRank({ systemIndex: rank }))
    && [...ranks].some((rank) => isErhuLineRank({ systemIndex: rank }));
}

function verticalRange(entry = {}) {
  const yMin = Number(entry.yMin ?? entry.y);
  const yMax = Number(entry.yMax ?? entry.y);
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
  return { min: Math.min(yMin, yMax), max: Math.max(yMin, yMax) };
}

function overlapsAllowedVerticalRange(entry = {}, allowedRanges = []) {
  const range = verticalRange(entry);
  if (!range || !allowedRanges.length) return true;
  const center = (range.min + range.max) / 2;
  return allowedRanges.some((allowed) => center >= allowed.min - 0.025 && center <= allowed.max + 0.025);
}

function filterThreeStaffLineRanks(locator = {}, entries = [], allowedRanges = []) {
  if (!shouldFilterThreeStaffLineRanks(locator)) return entries;
  return entries.filter((entry) => {
    const rank = toLineRank(entry?.systemIndex);
    if (rank) return isErhuLineRank(entry);
    return overlapsAllowedVerticalRange(entry, allowedRanges);
  });
}

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
  const notes = filterThreeStaffLineRanks(locator, locator?.notePositions || []);
  const focusRegions = filterThreeStaffLineRanks(locator, locator?.focusRegions || []);
  const allowedMeasureRanges = [
    ...focusRegions.map((region) => verticalRange(region)).filter(Boolean),
    ...notes.map((note) => verticalRange(note)).filter(Boolean),
  ];
  const measures = filterThreeStaffLineRanks(locator, locator?.measurePositions || [], allowedMeasureRanges);
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
