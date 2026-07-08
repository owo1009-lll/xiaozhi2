from __future__ import annotations

import argparse
import csv
import html
import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recordings-manifest.csv"
DEFAULT_RESULTS = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recording-results.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "results-review-pack"
DEFAULT_SUPPORT_THRESHOLD_SECONDS = 0.03
DEFAULT_NEIGHBOR_RADIUS = 2
DEFAULT_MIN_EVENT_CONFIDENCE = 0.35
DEFAULT_INTERVAL_RATIO_MAX = 2.75


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return default
    return numeric if math.isfinite(numeric) else default


def run_json(command: list[str]) -> Any:
    proc = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return json.loads(proc.stdout)


def ffprobe_duration(path: Path) -> float:
    data = run_json([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ])
    return safe_float(data.get("format", {}).get("duration"), 0.0)


def ensure_mp3(audio_path: Path, out_path: Path, *, force: bool = False) -> None:
    if out_path.exists() and not force:
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(audio_path),
            "-vn",
            "-acodec",
            "libmp3lame",
            "-q:a",
            "3",
            str(out_path),
        ],
        check=True,
    )


def load_basic_pitch_events(audio_path: Path, cache_path: Path, *, force: bool = False) -> list[dict[str, Any]]:
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text(encoding="utf-8"))
    try:
        from basic_pitch.inference import predict
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "basic_pitch is not installed in this Python environment. "
            "Run with system Python, or set ERHU_PYTHON_EXE to a Python that has basic_pitch installed."
        ) from exc

    _model_output, _midi_data, note_events = predict(str(audio_path))
    events = []
    for event in note_events:
        start, end, midi, confidence, *rest = event
        pitch_bends = rest[0] if rest else []
        events.append(
            {
                "start": round(float(start), 6),
                "end": round(float(end), 6),
                "midi": int(round(float(midi))),
                "confidence": round(float(confidence), 6),
                "pitchBends": [int(value) for value in pitch_bends],
            }
        )
    events.sort(key=lambda item: (safe_float(item.get("start")), safe_float(item.get("end"))))
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    return events


def parse_score_notes(score_path: Path) -> list[dict[str, Any]]:
    try:
        from music21 import chord, converter, note
    except ModuleNotFoundError as exc:
        raise SystemExit("music21 is required to parse MXL/MusicXML scores for M2f result review.") from exc

    score = converter.parse(str(score_path))
    part = score.parts[0] if getattr(score, "parts", None) else score
    notes: list[dict[str, Any]] = []
    for element in part.flatten().notesAndRests:
        pitches: list[int] = []
        if isinstance(element, note.Note):
            pitches = [int(element.pitch.midi)]
        elif isinstance(element, chord.Chord):
            pitches = [int(pitch.midi) for pitch in element.pitches]
        else:
            continue
        for pitch_index, midi in enumerate(pitches):
            notes.append(
                {
                    "noteIndex": len(notes),
                    "measure": int(element.measureNumber or 0),
                    "scoreBeat": float(element.offset),
                    "durationBeats": float(element.quarterLength),
                    "midi": midi,
                    "chordPitchIndex": pitch_index,
                }
            )
    notes.sort(key=lambda item: (item["scoreBeat"], item["chordPitchIndex"], item["midi"]))
    for index, item in enumerate(notes):
        item["noteIndex"] = index
    return notes


def nearest_event(events: list[dict[str, Any]], expected_seconds: float, midi: int) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    best_distance: float | None = None
    for event in events:
        if int(event.get("midi", -999)) != int(midi):
            continue
        distance = abs(safe_float(event.get("start")) - expected_seconds)
        if best_distance is None or distance < best_distance:
            best_distance = distance
            best = event
    if best is None or best_distance is None:
        return None
    return {
        **best,
        "supportDistanceSeconds": round(best_distance, 6),
    }


def pitch_match_cost(score_midi: int, event_midi: int) -> float:
    diff = abs(int(score_midi) - int(event_midi))
    if diff == 0:
        return 0.0
    if diff == 1:
        return 0.85
    if diff == 2:
        return 1.35
    return min(4.0, 2.2 + (diff * 0.18))


def align_score_to_events_dtw(score_notes: list[dict[str, Any]], events: list[dict[str, Any]]) -> list[dict[str, Any] | None]:
    """Monotonic score-note to Basic Pitch event alignment.

    This is deliberately conservative and eval-only. It does not claim timing
    correctness by itself; downstream gates still require exact pitch and local
    sequence support before a note can become an auto-pass candidate.
    """
    n = len(score_notes)
    m = len(events)
    if n == 0:
        return []
    if m == 0:
        return [None for _ in score_notes]

    skip_score_cost = 1.35
    skip_event_cost = 0.75
    dp = [[math.inf] * (m + 1) for _ in range(n + 1)]
    back: list[list[tuple[int, int, str] | None]] = [[None] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + skip_score_cost
        back[i][0] = (i - 1, 0, "skip-score")
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] + skip_event_cost
        back[0][j] = (0, j - 1, "skip-event")

    for i in range(1, n + 1):
        score_midi = int(score_notes[i - 1]["midi"])
        for j in range(1, m + 1):
            event_midi = int(events[j - 1].get("midi", -999))
            match = dp[i - 1][j - 1] + pitch_match_cost(score_midi, event_midi)
            skip_score = dp[i - 1][j] + skip_score_cost
            skip_event = dp[i][j - 1] + skip_event_cost
            best = min(match, skip_score, skip_event)
            dp[i][j] = best
            if best == match:
                back[i][j] = (i - 1, j - 1, "match")
            elif best == skip_score:
                back[i][j] = (i - 1, j, "skip-score")
            else:
                back[i][j] = (i, j - 1, "skip-event")

    matched: list[dict[str, Any] | None] = [None for _ in score_notes]
    i, j = n, m
    while i > 0 or j > 0:
        prev = back[i][j]
        if prev is None:
            break
        pi, pj, action = prev
        if action == "match" and i > 0 and j > 0:
            event = events[j - 1]
            matched[i - 1] = {
                **event,
                "matchedEventIndex": j - 1,
                "pitchDiff": int(event.get("midi", -999)) - int(score_notes[i - 1]["midi"]),
            }
        i, j = pi, pj
    return matched


def local_interval_consistent(
    decisions: list[dict[str, Any]],
    index: int,
    *,
    neighbor_radius: int,
    interval_ratio_max: float,
) -> bool:
    start = max(0, index - neighbor_radius)
    stop = min(len(decisions), index + neighbor_radius + 1)
    window = [
        item
        for item in decisions[start:stop]
        if item.get("matchedEventStart") is not None and item.get("singleSupport")
    ]
    if len(window) < 2:
        return False
    ratios: list[float] = []
    for left, right in zip(window, window[1:]):
        score_delta = safe_float(right.get("scoreBeat")) - safe_float(left.get("scoreBeat"))
        event_delta = safe_float(right.get("matchedEventStart")) - safe_float(left.get("matchedEventStart"))
        if score_delta <= 0 or event_delta <= 0:
            return False
        ratios.append(event_delta / score_delta)
    if not ratios:
        return False
    low = min(ratios)
    high = max(ratios)
    if low <= 0:
        return False
    return (high / low) <= interval_ratio_max


def build_preview_decisions_linear(
    score_notes: list[dict[str, Any]],
    events: list[dict[str, Any]],
    audio_duration: float,
    *,
    support_threshold_seconds: float,
    neighbor_radius: int,
) -> list[dict[str, Any]]:
    if not score_notes or audio_duration <= 0:
        return []
    score_end = max(float(item["scoreBeat"]) + max(0.0, float(item.get("durationBeats", 0.0))) for item in score_notes)
    decisions = []
    for item in score_notes:
        expected = (float(item["scoreBeat"]) / max(score_end, 1e-6)) * audio_duration
        event = nearest_event(events, expected, int(item["midi"]))
        distance = event.get("supportDistanceSeconds") if event else None
        decisions.append(
            {
                **item,
                "expectedSeconds": round(expected, 6),
                "nearestEventStart": event.get("start") if event else None,
                "nearestEventEnd": event.get("end") if event else None,
                "nearestEventConfidence": event.get("confidence") if event else None,
                "supportDistanceSeconds": distance,
                "singleSupport": bool(distance is not None and float(distance) <= support_threshold_seconds),
                "sequenceSupport": False,
                "autoDecision": "review_required",
                "reviewRequiredReason": "sequence-basic-pitch-support-missing",
            }
        )
    for index, decision in enumerate(decisions):
        start = max(0, index - neighbor_radius)
        stop = min(len(decisions), index + neighbor_radius + 1)
        supported = all(item["singleSupport"] for item in decisions[start:stop])
        decision["sequenceSupport"] = supported
        if supported:
            decision["autoDecision"] = "auto_pass"
            decision["reviewRequiredReason"] = ""
    return decisions


def build_preview_decisions_sequence_dtw(
    score_notes: list[dict[str, Any]],
    events: list[dict[str, Any]],
    *,
    support_threshold_seconds: float,
    neighbor_radius: int,
    min_event_confidence: float,
    interval_ratio_max: float,
) -> list[dict[str, Any]]:
    matched = align_score_to_events_dtw(score_notes, events)
    decisions: list[dict[str, Any]] = []
    for item, event in zip(score_notes, matched):
        exact_pitch = bool(event and int(event.get("pitchDiff", 999)) == 0)
        confidence = safe_float(event.get("confidence"), 0.0) if event else 0.0
        single_support = bool(exact_pitch and confidence >= min_event_confidence)
        decisions.append(
            {
                **item,
                "expectedSeconds": "" if event is None else round(safe_float(event.get("start")), 6),
                "nearestEventStart": "" if event is None else round(safe_float(event.get("start")), 6),
                "nearestEventEnd": "" if event is None else round(safe_float(event.get("end")), 6),
                "nearestEventConfidence": "" if event is None else round(confidence, 6),
                "supportDistanceSeconds": 0.0 if single_support else "",
                "matchedEventStart": None if event is None else round(safe_float(event.get("start")), 6),
                "matchedEventIndex": "" if event is None else event.get("matchedEventIndex", ""),
                "matchedPitchDiff": "" if event is None else event.get("pitchDiff", ""),
                "singleSupport": single_support,
                "sequenceSupport": False,
                "localIntervalConsistent": False,
                "autoDecision": "review_required",
                "reviewRequiredReason": "sequence-basic-pitch-support-missing",
            }
        )
    for index, decision in enumerate(decisions):
        start = max(0, index - neighbor_radius)
        stop = min(len(decisions), index + neighbor_radius + 1)
        supported = all(item["singleSupport"] for item in decisions[start:stop])
        consistent = local_interval_consistent(
            decisions,
            index,
            neighbor_radius=neighbor_radius,
            interval_ratio_max=interval_ratio_max,
        )
        decision["sequenceSupport"] = supported
        decision["localIntervalConsistent"] = consistent
        if supported and consistent:
            decision["autoDecision"] = "auto_pass"
            decision["reviewRequiredReason"] = ""
        elif supported and not consistent:
            decision["reviewRequiredReason"] = "local-interval-inconsistent"
    return decisions


def score_image_for(score_path: Path) -> Path | None:
    candidate = score_path.with_name(f"{score_path.stem}-score.jpg")
    return candidate if candidate.exists() else None


def preview_rows_from_decisions(decisions: list[dict[str, Any]], limit: int = 60) -> list[dict[str, Any]]:
    rows = []
    auto_pass = [item for item in decisions if item.get("autoDecision") == "auto_pass"]
    review = [item for item in decisions if item.get("autoDecision") != "auto_pass"]
    selected = auto_pass + review[: max(0, limit - len(auto_pass))]
    for decision in selected:
        rows.append(
            {
                "noteIndex": decision["noteIndex"],
                "measure": decision["measure"],
                "midi": decision["midi"],
                "expectedSeconds": round(safe_float(decision["expectedSeconds"]), 3),
                "nearestEventStart": "" if decision["nearestEventStart"] is None else round(safe_float(decision["nearestEventStart"]), 3),
                "supportMs": "" if decision["supportDistanceSeconds"] is None else round(safe_float(decision["supportDistanceSeconds"]) * 1000, 1),
                "pitchDiff": decision.get("matchedPitchDiff", ""),
                "localOk": decision.get("localIntervalConsistent", ""),
                "sequenceSupport": decision["sequenceSupport"],
                "autoDecision": decision["autoDecision"],
                "isAutoPass": decision.get("autoDecision") == "auto_pass",
            }
        )
    return rows


def csv_escape(value: Any) -> str:
    text = str(value if value is not None else "")
    if any(char in text for char in [",", '"', "\n", "\r"]):
        return '"' + text.replace('"', '""') + '"'
    return text


def render_html(pack: dict[str, Any]) -> str:
    data = json.dumps(pack, ensure_ascii=False).replace("</script>", "<\/script>")
    rows_html: list[str] = []
    for item in pack["recordings"]:
        score_img = (
            f'<img src="{html.escape(item["scoreImageRel"])}" alt="谱面图" />'
            if item.get("scoreImageRel")
            else '<p class="muted">未找到谱面 JPG。</p>'
        )
        preview_rows: list[str] = []
        for row in item["previewRows"]:
            local_ok = "是" if row["localOk"] is True else "否" if row["localOk"] is False else ""
            seq_ok = "是" if row["sequenceSupport"] else "否"
            if row["isAutoPass"]:
                review_cells = (
                    f'<td><button type="button" class="seek" data-time="{row["nearestEventStart"]}">跳转</button></td>'
                    '<td><select class="candidate-review">'
                    '<option value="">未判</option>'
                    '<option value="correct">正确</option>'
                    '<option value="unsafe">危险误放行</option>'
                    '<option value="uncertain">不确定</option>'
                    '</select></td>'
                )
            else:
                review_cells = '<td></td><td></td>'
            preview_rows.append(
                '<tr class="candidate-row" data-auto-pass="' + ('1' if row['isAutoPass'] else '0') + '">' +
                f'<td>{row["noteIndex"]}</td>' +
                f'<td>{row["measure"]}</td>' +
                f'<td>{row["midi"]}</td>' +
                f'<td>{row["expectedSeconds"]}</td>' +
                f'<td>{row["nearestEventStart"]}</td>' +
                f'<td>{row["supportMs"]}</td>' +
                f'<td>{row["pitchDiff"]}</td>' +
                f'<td>{local_ok}</td>' +
                f'<td>{seq_ok}</td>' +
                f'<td>{row["autoDecision"]}</td>' +
                review_cells +
                '</tr>'
            )
        preview_table_rows = "\n".join(preview_rows)
        rows_html.append(
            f"""
            <section class="card" data-recording-id="{html.escape(item['recordingId'])}">
              <header>
                <div>
                  <h2>{html.escape(item['recordingId'])}</h2>
                  <p>{html.escape(item['scenario'])} / {html.escape(item['studentId'])} / {html.escape(item['pieceId'])}</p>
                </div>
                <span class="badge">{item['autoPassCount']} auto-pass / {item['noteCount']} notes</span>
              </header>
              <audio controls preload="metadata" src="{html.escape(item['audioRel'])}"></audio>
              <div class="grid">
                <div class="score">{score_img}</div>
                <div>
                  <label>autoPassCount<input class="auto-pass" type="number" min="0" value="{item['autoPassCount']}"></label>
                  <label>correctWithin300ms<input class="correct" type="number" min="0" placeholder="人工复核后填写"></label>
                  <label>unsafeTargetAutoPassCount<input class="unsafe" type="number" min="0" value="0"></label>
                  <label>备注<textarea class="notes" rows="4">{html.escape(item['defaultNotes'])}</textarea></label>
                  <button type="button" class="mark-section-correct">本条 auto-pass 全部标正确</button>
                  <p class="hint">逐个复核 auto-pass 候选。点“跳转”会跳到候选事件附近。选择“正确 / 危险误放行 / 不确定”后，本卡片会自动汇总结果。</p>
                  <p class="hint review-progress">已复核 0 / {item['autoPassCount']} 个 auto-pass 候选。</p>
                </div>
              </div>
              <details>
                <summary>查看 auto-pass 候选和部分拒绝样本</summary>
                <table>
                  <thead><tr><th>#</th><th>小节</th><th>MIDI</th><th>预测秒</th><th>事件秒</th><th>距离ms</th><th>音高差</th><th>局部间隔</th><th>序列支持</th><th>决策</th><th>播放</th><th>人工复核</th></tr></thead>
                  <tbody>{preview_table_rows}</tbody>
                </table>
              </details>
            </section>
            """
        )
    page = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>M2f 真实录音结果复核包</title>
  <style>
    body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f6f7fb; color: #111827; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    .top { position: sticky; top: 0; z-index: 2; background: rgba(246,247,251,.96); border-bottom: 1px solid #d8dee9; padding: 16px 24px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    h2 { margin: 0; font-size: 18px; }
    p { margin: 6px 0; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
    button { border: 0; background: #1d4ed8; color: white; padding: 10px 14px; border-radius: 6px; cursor: pointer; font-weight: 700; }
    button.secondary { background: #374151; }
    button.danger { background: #b45309; }
    button.seek { padding: 5px 8px; border-radius: 5px; font-size: 12px; background: #0f766e; }
    .card { background: white; border: 1px solid #d8dee9; border-radius: 8px; padding: 16px; margin: 18px 0; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
    .badge { background: #e0f2fe; color: #075985; padding: 6px 10px; border-radius: 999px; font-weight: 700; white-space: nowrap; }
    audio { width: 100%; margin: 12px 0; }
    .grid { display: grid; grid-template-columns: minmax(260px, 1.2fr) minmax(260px, .8fr); gap: 16px; }
    .score { max-height: 520px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 6px; background: #fafafa; }
    .score img { width: 100%; display: block; }
    label { display: block; font-weight: 700; margin: 10px 0; }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; font: inherit; margin-top: 4px; }
    .hint, .muted { color: #64748b; font-size: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 10px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
    th { background: #f1f5f9; }
    tr[data-auto-pass="1"] { background: #fff7ed; }
    select { border: 1px solid #cbd5e1; border-radius: 6px; padding: 5px; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } header { display: block; } }
  </style>
</head>
<body>
  <div class="top">
    <h1>M2f 真实录音结果复核包</h1>
    <p>用途：根据自动 preview 统计 release gate 需要的三列。系统只预填 auto-pass 候选数；正确数和危险误放行必须人工复核。</p>
    <div class="actions">
      <button id="download">下载 results.reviewed.csv</button>
      <button class="secondary" id="copy">复制 CSV 到剪贴板</button>
      <button class="danger" id="markAllCorrect">全包 auto-pass 全部标正确</button>
      <span id="status" class="hint"></span>
    </div>
  </div>
  <main>
    __ROWS__
  </main>
  <script id="pack-data" type="application/json">__PACK_JSON__</script>
  <script>
    const pack = JSON.parse(document.getElementById('pack-data').textContent);
    const status = document.getElementById('status');
    function collectCsv() {
      const header = ['recordingId','autoPassCount','correctWithin300ms','unsafeTargetAutoPassCount','notes'];
      const lines = [header.join(',')];
      for (const item of pack.recordings) {
        const section = document.querySelector(`[data-recording-id="${CSS.escape(item.recordingId)}"]`);
        const row = [
          item.recordingId,
          section.querySelector('.auto-pass').value.trim(),
          section.querySelector('.correct').value.trim(),
          section.querySelector('.unsafe').value.trim(),
          section.querySelector('.notes').value.trim(),
        ];
        lines.push(row.map((value) => {
          const text = String(value ?? '');
          return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
        }).join(','));
      }
      return lines.join('\r\n') + '\r\n';
    }
    function updateSection(section) {
      const reviews = [...section.querySelectorAll('.candidate-review')];
      const correct = reviews.filter((item) => item.value === 'correct').length;
      const unsafe = reviews.filter((item) => item.value === 'unsafe').length;
      const reviewed = reviews.filter((item) => item.value).length;
      section.querySelector('.correct').value = String(correct);
      section.querySelector('.unsafe').value = String(unsafe);
      const progress = section.querySelector('.review-progress');
      if (progress) progress.textContent = `已复核 ${reviewed} / ${reviews.length} 个 auto-pass 候选。`;
    }
    function markSectionCorrect(section) {
      section.querySelectorAll('.candidate-review').forEach((select) => {
        select.value = 'correct';
      });
      section.querySelector('.unsafe').value = '0';
      updateSection(section);
    }
    document.querySelectorAll('.candidate-review').forEach((select) => {
      select.addEventListener('change', () => updateSection(select.closest('.card')));
    });
    document.querySelectorAll('.mark-section-correct').forEach((button) => {
      button.addEventListener('click', () => {
        const section = button.closest('.card');
        if (confirm('确认把本条录音所有 auto-pass 候选都标为“正确”？这会直接影响 release gate。')) {
          markSectionCorrect(section);
        }
      });
    });
    document.getElementById('markAllCorrect').addEventListener('click', () => {
      if (confirm('确认把全包所有 auto-pass 候选都标为“正确”？只有在你接受这批自动候选全部安全时才使用。')) {
        document.querySelectorAll('.card').forEach(markSectionCorrect);
        status.textContent = '已将全包 auto-pass 候选标为正确。';
      }
    });
    document.querySelectorAll('.seek').forEach((button) => {
      button.addEventListener('click', () => {
        const section = button.closest('.card');
        const audio = section.querySelector('audio');
        const time = Number(button.dataset.time);
        if (Number.isFinite(time)) {
          audio.currentTime = Math.max(0, time - 0.4);
          audio.play();
        }
      });
    });
    document.getElementById('download').addEventListener('click', () => {
      const blob = new Blob([collectCsv()], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'real-student-recording-results.reviewed.csv';
      link.click();
      URL.revokeObjectURL(link.href);
      status.textContent = '已生成下载文件。';
    });
    document.getElementById('copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(collectCsv());
      status.textContent = 'CSV 已复制。';
    });
  </script>
</body>
</html>
"""
    return page.replace("__ROWS__", "".join(rows_html)).replace("__PACK_JSON__", data)

def build_pack(args: argparse.Namespace) -> dict[str, Any]:
    manifest_rows = read_csv(repo_path(args.manifest))
    out_dir = repo_path(args.out)
    audio_dir = out_dir / "audio"
    score_dir = out_dir / "score-images"
    cache_dir = out_dir / "cache" / "basic-pitch"
    out_dir.mkdir(parents=True, exist_ok=True)

    recordings = []
    for row in manifest_rows:
        recording_id = row.get("recordingId", "").strip()
        if not recording_id:
            continue
        audio_path = repo_path(row.get("audioPath", ""))
        score_path = repo_path(row.get("scorePath", ""))
        if not audio_path.exists():
            raise SystemExit(f"Missing audio for {recording_id}: {audio_path}")
        if not score_path.exists():
            raise SystemExit(f"Missing clean score for {recording_id}: {score_path}")

        audio_mp3 = audio_dir / f"{recording_id}.mp3"
        ensure_mp3(audio_path, audio_mp3, force=args.force)
        audio_duration = ffprobe_duration(audio_path)
        score_notes = parse_score_notes(score_path)
        events = load_basic_pitch_events(audio_path, cache_dir / f"{recording_id}.basic-pitch.json", force=args.force_basic_pitch)
        if args.alignment_method == "linear":
            decisions = build_preview_decisions_linear(
                score_notes,
                events,
                audio_duration,
                support_threshold_seconds=args.support_threshold_seconds,
                neighbor_radius=args.neighbor_radius,
            )
        else:
            decisions = build_preview_decisions_sequence_dtw(
                score_notes,
                events,
                support_threshold_seconds=args.support_threshold_seconds,
                neighbor_radius=args.neighbor_radius,
                min_event_confidence=args.min_event_confidence,
                interval_ratio_max=args.interval_ratio_max,
            )
        auto_pass_count = sum(1 for item in decisions if item["autoDecision"] == "auto_pass")

        score_image_rel = ""
        score_image = score_image_for(score_path)
        if score_image:
            copied = score_dir / score_image.name
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(score_image, copied)
            score_image_rel = copied.relative_to(out_dir).as_posix()

        recordings.append(
            {
                "recordingId": recording_id,
                "studentId": row.get("studentId", ""),
                "pieceId": row.get("pieceId", ""),
                "scenario": row.get("scenario", ""),
                "audioPath": str(audio_path.relative_to(REPO)).replace("\\", "/") if audio_path.is_relative_to(REPO) else str(audio_path),
                "scorePath": str(score_path.relative_to(REPO)).replace("\\", "/") if score_path.is_relative_to(REPO) else str(score_path),
                "audioRel": audio_mp3.relative_to(out_dir).as_posix(),
                "scoreImageRel": score_image_rel,
                "audioDurationSeconds": round(audio_duration, 3),
                "noteCount": len(score_notes),
                "basicPitchEventCount": len(events),
                "autoPassCount": auto_pass_count,
                "coverage": round(auto_pass_count / len(score_notes), 4) if score_notes else 0.0,
                "defaultNotes": f"scenario={row.get('scenario','')}; autoPass is preview-only; fill after human/gold review.",
                "previewRows": preview_rows_from_decisions(decisions, args.preview_note_limit),
            }
        )

    pack = {
        "ok": True,
        "sourceManifest": str(repo_path(args.manifest).relative_to(REPO)).replace("\\", "/"),
        "supportFeature": {
            "source": "basic-pitch-event-start-sequence",
            "alignmentMethod": args.alignment_method,
            "thresholdSeconds": args.support_threshold_seconds,
            "neighborRadius": args.neighbor_radius,
            "minEventConfidence": args.min_event_confidence,
            "intervalRatioMax": args.interval_ratio_max,
            "scoreTimeModel": "linear-scale-score-beats-to-audio-duration",
        },
        "recordingCount": len(recordings),
        "recordings": recordings,
    }
    (out_dir / "recording-previews.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
    result_rows = [
        {
            "recordingId": item["recordingId"],
            "autoPassCount": item["autoPassCount"],
            "correctWithin300ms": "",
            "unsafeTargetAutoPassCount": "0",
            "notes": item["defaultNotes"],
        }
        for item in recordings
    ]
    write_csv(
        out_dir / "real-student-recording-results.preview.csv",
        result_rows,
        ["recordingId", "autoPassCount", "correctWithin300ms", "unsafeTargetAutoPassCount", "notes"],
    )
    (out_dir / "index.html").write_text(render_html(pack), encoding="utf-8")
    return pack


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a human review pack for M2f real-student result counts.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--results", default=str(DEFAULT_RESULTS), help="Reserved for future merge; current pack writes a reviewed CSV.")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--support-threshold-seconds", type=float, default=DEFAULT_SUPPORT_THRESHOLD_SECONDS)
    parser.add_argument("--neighbor-radius", type=int, default=DEFAULT_NEIGHBOR_RADIUS)
    parser.add_argument("--alignment-method", choices=["sequence-dtw", "linear"], default="sequence-dtw")
    parser.add_argument("--min-event-confidence", type=float, default=DEFAULT_MIN_EVENT_CONFIDENCE)
    parser.add_argument("--interval-ratio-max", type=float, default=DEFAULT_INTERVAL_RATIO_MAX)
    parser.add_argument("--preview-note-limit", type=int, default=80)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--force-basic-pitch", action="store_true")
    args = parser.parse_args()
    pack = build_pack(args)
    print(json.dumps({
        "ok": True,
        "out": str(repo_path(args.out).relative_to(REPO)).replace("\\", "/"),
        "recordingCount": pack["recordingCount"],
        "autoPassTotal": sum(item["autoPassCount"] for item in pack["recordings"]),
        "open": str((repo_path(args.out) / "index.html").resolve()),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
