import { useRef } from "react";
import { formatSeconds } from "./teacherValidationUtils.js";

export default function SegmentAudioPlayer({ item, onMismatch }) {
  const audioRef = useRef(null);
  const segment = item?.audioSegment || {};
  const alignment = item?.scoreLocator?.audioAlignment;
  const start = Number(segment.startSeconds);
  const end = Number(segment.endSeconds);
  const hasSegment = Number.isFinite(start) && Number.isFinite(end) && end > start;

  function seekTo(offsetSeconds = 0, autoplay = true) {
    const audio = audioRef.current;
    if (!audio || !hasSegment) return;
    audio.currentTime = Math.max(0, start + offsetSeconds);
    if (autoplay) {
      const playPromise = audio.play();
      if (playPromise?.catch) playPromise.catch(() => {});
    }
  }

  function handlePlay() {
    const audio = audioRef.current;
    if (!audio || !hasSegment) return;
    if (audio.currentTime < start - 0.25 || audio.currentTime >= end) {
      audio.currentTime = start;
    }
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!audio || !hasSegment) return;
    if (audio.currentTime >= end) {
      audio.pause();
      audio.currentTime = start;
    }
  }

  return (
    <div className="teacher-segment-audio">
      <audio
        ref={audioRef}
        className="audio-player"
        controls
        src={item?.audioUrl || ""}
        onLoadedMetadata={() => seekTo(0, false)}
        onPlay={handlePlay}
        onTimeUpdate={handleTimeUpdate}
      />
      {hasSegment ? (
        <>
          <div className="section-meta">
            <span>音频片段 {formatSeconds(start)} - {formatSeconds(end)}</span>
            <span>时长 {formatSeconds(end - start)}</span>
          </div>
          <div className="action-row teacher-audio-actions">
            <button type="button" className="secondary-button" onClick={() => seekTo(0)}>
              播放问题片段
            </button>
            <button type="button" className="secondary-button" onClick={() => seekTo(-5)}>
              提前 5 秒听
            </button>
            <button type="button" className="secondary-button" onClick={() => seekTo(0, false)}>
              回到片段起点
            </button>
            <button type="button" className="secondary-button danger-button" onClick={onMismatch}>
              音频不匹配，排除样本
            </button>
          </div>
          {alignment?.measureRangeLabel ? (
            <div className="teacher-audio-alignment">
              <strong>这段音频对应</strong>
              <span>{alignment.measureRangeLabel}</span>
            </div>
          ) : null}
        </>
      ) : (
        <p className="teacher-muted">这条记录没有音频起止时间，只能播放完整音频。</p>
      )}
    </div>
  );
}
