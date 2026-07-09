from __future__ import annotations

import argparse
import csv
import html
import json
import math
import shutil
import wave
from collections import defaultdict
from pathlib import Path
from typing import Any

import librosa
import numpy as np


REPO = Path(__file__).resolve().parents[2]
DEFAULT_INVENTORY = REPO / "data" / "experiments" / "western-strings-m3plus" / "m3plus-pitch-mode-inventory.csv"
DEFAULT_SUMMARY = REPO / "data" / "experiments" / "western-strings-m3plus" / "m3plus-pitch-mode-summary.json"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m3plus" / "pitch-mode-review-pack"

DEFAULT_MODES = [
    "slide-like",
    "trill-like",
    "double-stop-candidate",
    "ornament-candidate",
    "stable",
    "variable-f0",
]

REVIEW_COLUMNS = [
    "rowId",
    "recordingId",
    "scenario",
    "noteIndex",
    "noteId",
    "measureIndex",
    "pageNumber",
    "midi",
    "predictedOnsetSeconds",
    "predictedDurationSeconds",
    "candidateMode",
    "flags",
    "audioClip",
    "audioScoreMatch",
    "observedPitchBehavior",
    "pitchJudgementMode",
    "pitchJudgeable",
    "pitchAccuracyLabel",
    "reviewConfidence",
    "reviewComments",
]

BEHAVIOR_OPTIONS = [
    ("", "未标"),
    ("stable", "稳态音"),
    ("vibrato", "揉弦/周期波动"),
    ("slide", "滑音/连续滑动"),
    ("trill", "颤音/两音交替"),
    ("ornament", "装饰音/倚音"),
    ("double-stop", "双音/多音"),
    ("harmonic", "泛音"),
    ("variable-f0", "音高不稳定"),
    ("other", "其他"),
    ("uncertain", "不确定"),
]

JUDGEMENT_OPTIONS = [
    ("", "未标"),
    ("normal-center", "常规中心音高"),
    ("vibrato-center", "揉弦中心音高"),
    ("slide-start-end", "滑音起止目标"),
    ("trill-two-targets", "颤音两个目标"),
    ("ornament-main-note", "装饰音主音"),
    ("multi-f0", "双音 multi-f0"),
    ("sounding-pitch", "泛音 sounding pitch"),
    ("not-judgeable", "不可判"),
    ("uncertain", "不确定"),
]

def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise SystemExit(f"Missing CSV: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in columns})


def h(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def row_key(row: dict[str, str]) -> str:
    return f"{row.get('recordingId', '')}::{row.get('noteIndex', '')}::{row.get('noteId', '')}"


def load_excluded_keys(paths: list[str]) -> set[str]:
    excluded: set[str] = set()
    for value in paths:
        path = repo_path(value)
        if not path.exists():
            continue
        for row in read_csv(path):
            key = row_key(row)
            if key.replace(":", ""):
                excluded.add(key)
    return excluded


def mode_matches(row: dict[str, str], mode: str) -> bool:
    if row.get("primaryMode") == mode:
        return True
    flags = {item.strip() for item in str(row.get("flags", "")).split("|") if item.strip()}
    return mode in flags


def mode_strength(row: dict[str, str], mode: str) -> float:
    if mode == "slide-like":
        return abs(safe_float(row.get("netMotionCents"))) * max(0.0, safe_float(row.get("monotonicity")))
    if mode == "trill-like":
        return safe_float(row.get("trillSwitchCountApprox")) * max(1.0, abs(safe_float(row.get("trillGapCentsApprox"))))
    if mode == "double-stop-candidate":
        return abs(safe_float(row.get("absMedianCents"))) + safe_float(row.get("spreadCentsP95P05"))
    if mode == "ornament-candidate":
        return 1.0 / max(0.05, safe_float(row.get("predictedDurationSeconds"), 0.1))
    if mode == "stable":
        return -safe_float(row.get("spreadCentsP95P05"))
    if mode == "variable-f0":
        return safe_float(row.get("spreadCentsP95P05")) + abs(safe_float(row.get("netMotionCents")))
    return 0.0


def load_diagnosis_excluded_recordings(
    paths: list[str],
    min_recording_total: int,
    min_nonmatch_rate: float,
) -> set[str]:
    excluded: set[str] = set()
    for value in paths:
        path = repo_path(value)
        if not path.exists():
            continue
        report = json.loads(path.read_text(encoding="utf-8"))
        for group in report.get("highRiskGroups") or []:
            if group.get("group") != "recording":
                continue
            recording_id = str(group.get("recordingId") or "").strip()
            total = safe_int(group.get("total"), 0)
            nonmatch_rate = safe_float(group.get("nonMatchRate"), 0.0)
            if recording_id and total >= min_recording_total and nonmatch_rate >= min_nonmatch_rate:
                excluded.add(recording_id)
    return excluded


def select_rows(
    rows: list[dict[str, str]],
    modes: list[str],
    per_mode: int,
    excluded_keys: set[str] | None = None,
    excluded_recording_ids: set[str] | None = None,
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    selected: list[dict[str, str]] = []
    selected_keys: set[str] = set(excluded_keys or set())
    excluded_recordings: set[str] = set(excluded_recording_ids or set())
    mode_counts: dict[str, int] = {}
    available_counts: dict[str, int] = {}
    eligible_counts: dict[str, int] = {}
    for mode in modes:
        candidates = [row for row in rows if mode_matches(row, mode)]
        available_counts[mode] = len(candidates)
        candidates = [row for row in candidates if str(row.get("recordingId", "")).strip() not in excluded_recordings]
        candidates = [row for row in candidates if row_key(row) not in selected_keys]
        eligible_counts[mode] = len(candidates)
        candidates.sort(key=lambda item: (mode_strength(item, mode), -safe_int(item.get("noteIndex"))), reverse=True)

        per_recording: dict[str, list[dict[str, str]]] = defaultdict(list)
        for row in candidates:
            key = row_key(row)
            if key in selected_keys:
                continue
            per_recording[row.get("recordingId", "")].append(row)

        picked: list[dict[str, str]] = []
        while len(picked) < per_mode and per_recording:
            progressed = False
            for recording_id in sorted(list(per_recording.keys())):
                bucket = per_recording.get(recording_id, [])
                while bucket and row_key(bucket[0]) in selected_keys:
                    bucket.pop(0)
                if not bucket:
                    per_recording.pop(recording_id, None)
                    continue
                row = bucket.pop(0)
                picked.append(row)
                selected_keys.add(row_key(row))
                progressed = True
                if len(picked) >= per_mode:
                    break
            if not progressed:
                break
        for row in picked:
            copy = dict(row)
            copy["reviewCandidateMode"] = mode
            selected.append(copy)
        mode_counts[mode] = len(picked)
    selected.sort(key=lambda item: (str(item.get("recordingId", "")), safe_float(item.get("predictedOnsetSeconds"))))
    return selected, {
        "availableCounts": available_counts,
        "eligibleCounts": eligible_counts,
        "excludedKeyCount": len(excluded_keys or set()),
        "excludedRecordingIds": sorted(excluded_recordings),
        "excludedRecordingCount": len(excluded_recordings),
        "selectedCounts": mode_counts,
    }


def load_summary_audio_paths(summary_path: Path) -> dict[str, Path]:
    if not summary_path.exists():
        return {}
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    paths: dict[str, Path] = {}
    for item in summary.get("recordings", []):
        recording_id = str(item.get("recordingId") or "").strip()
        audio_path = str(item.get("audioPath") or "").strip()
        if recording_id and audio_path:
            paths[recording_id] = repo_path(audio_path)
    return paths


def load_audio(audio_path: Path, cache: dict[Path, tuple[np.ndarray, int]]) -> tuple[np.ndarray, int]:
    if audio_path not in cache:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        cache[audio_path] = (np.asarray(y, dtype=np.float32), int(sr))
    return cache[audio_path]


def write_wav_clip(path: Path, audio: np.ndarray, sr: int, start: float, end: float) -> None:
    start_index = max(0, int(round(start * sr)))
    end_index = min(len(audio), int(round(end * sr)))
    clip = audio[start_index:end_index]
    if clip.size == 0:
        clip = np.zeros(max(1, int(0.25 * sr)), dtype=np.float32)
    peak = float(np.max(np.abs(clip))) if clip.size else 0.0
    if peak > 1.0:
        clip = clip / peak
    pcm = np.clip(clip, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sr)
        handle.writeframes(pcm16.tobytes())


def attach_score_image(source: dict[str, str], out_dir: Path, warnings: list[str]) -> str:
    piece_id = str(source.get("pieceId", "")).strip()
    if not piece_id:
        warnings.append("missing-piece-id")
        return ""
    source_path = REPO / "data" / "private" / "western-strings-m2" / f"{piece_id}-score.jpg"
    if not source_path.exists():
        warnings.append(f"missing-score-image:{piece_id}")
        return ""
    target_rel = f"score-images/{piece_id}-score.jpg"
    target_path = out_dir / target_rel
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if not target_path.exists():
        shutil.copyfile(source_path, target_path)
    return target_rel


def build_review_rows(
    selected: list[dict[str, str]],
    audio_paths: dict[str, Path],
    out_dir: Path,
    clip_before: float,
    clip_after: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    clips_dir = out_dir / "clips"
    audio_cache: dict[Path, tuple[np.ndarray, int]] = {}
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, source in enumerate(selected, start=1):
        row_id = f"m3plus-{index:03d}"
        recording_id = str(source.get("recordingId", "")).strip()
        onset = safe_float(source.get("predictedOnsetSeconds"))
        duration = max(0.08, safe_float(source.get("predictedDurationSeconds"), 0.2))
        clip_start = max(0.0, onset - clip_before)
        clip_end = onset + max(duration, 0.2) + clip_after
        clip_rel = f"clips/{row_id}-{recording_id}.wav"
        audio_path = audio_paths.get(recording_id)
        if not audio_path or not audio_path.exists():
            warnings.append(f"missing-audio:{recording_id}")
            clip_rel = ""
        else:
            y, sr = load_audio(audio_path, audio_cache)
            write_wav_clip(out_dir / clip_rel, y, sr, clip_start, clip_end)
        score_image_rel = attach_score_image(source, out_dir, warnings)
        rows.append({
            "rowId": row_id,
            "recordingId": recording_id,
            "scenario": source.get("scenario", ""),
            "scoreId": source.get("scoreId", ""),
            "pieceId": source.get("pieceId", ""),
            "noteIndex": source.get("noteIndex", ""),
            "noteId": source.get("noteId", ""),
            "measureIndex": source.get("measureIndex", ""),
            "pageNumber": source.get("pageNumber", ""),
            "midi": source.get("midi", ""),
            "predictedOnsetSeconds": source.get("predictedOnsetSeconds", ""),
            "predictedDurationSeconds": source.get("predictedDurationSeconds", ""),
            "candidateMode": source.get("reviewCandidateMode") or source.get("primaryMode", ""),
            "flags": source.get("flags", ""),
            "audioClip": clip_rel,
            "audioScoreMatch": "",
            "observedPitchBehavior": "",
            "pitchJudgementMode": "",
            "pitchJudgeable": "",
            "pitchAccuracyLabel": "",
            "reviewConfidence": "",
            "reviewComments": "",
            "metrics": {
                "voicedFrameCount": source.get("voicedFrameCount", ""),
                "medianCents": source.get("medianCents", ""),
                "spreadCentsP95P05": source.get("spreadCentsP95P05", ""),
                "netMotionCents": source.get("netMotionCents", ""),
                "monotonicity": source.get("monotonicity", ""),
                "trillSwitchCountApprox": source.get("trillSwitchCountApprox", ""),
            },
            "clipStartSeconds": round(clip_start, 3),
            "clipEndSeconds": round(clip_end, 3),
            "scoreImage": score_image_rel,
        })
    return rows, sorted(set(warnings))


def csv_escape(value: Any) -> str:
    text = str(value if value is not None else "")
    if any(char in text for char in [",", '"', "\n", "\r"]):
        return '"' + text.replace('"', '""') + '"'
    return text


def render_select(name: str, options: list[tuple[str, str]]) -> str:
    rendered = [f'<select class="review-input" data-field="{h(name)}">']
    for value, label in options:
        rendered.append(f'<option value="{h(value)}">{h(label)}</option>')
    rendered.append("</select>")
    return "".join(rendered)


def render_html(pack: dict[str, Any]) -> str:
    pack_json = json.dumps(pack, ensure_ascii=False).replace("</script>", "<\\/script>")
    cards: list[str] = []
    for index, row in enumerate(pack["rows"]):
        metrics = row.get("metrics", {})
        metrics_html = "".join(
            f"<span><b>{h(key)}</b>: {h(value)}</span>"
            for key, value in metrics.items()
            if str(value).strip() != ""
        )
        audio_html = (
            f'<audio controls preload="metadata" src="{h(row.get("audioClip"))}"></audio>'
            if row.get("audioClip")
            else '<p class="warn">没有找到音频片段。请把本条标为不确定，并在备注里说明。</p>'
        )
        score_html = (
            f"""
            <figure class="score-panel">
              <figcaption>对应五线谱: 第 {h(row.get("pageNumber"))} 页 / 第 {h(row.get("measureIndex"))} 小节 / note {h(row.get("noteId"))}</figcaption>
              <a href="{h(row.get("scoreImage"))}" target="_blank" rel="noreferrer">
                <img src="{h(row.get("scoreImage"))}" alt="对应五线谱: {h(row.get("pieceId"))}" loading="lazy" />
              </a>
            </figure>
            """
            if row.get("scoreImage")
            else '<p class="warn">没有找到对应五线谱图片。请按小节/MIDI 文本辅助判断,并在备注说明。</p>'
        )
        cards.append(f"""
        <section class="card" data-index="{index}">
          <header>
            <div>
              <h2>{h(row["rowId"])} · {h(row["candidateMode"])}</h2>
              <p>录音 {h(row["recordingId"])} / 第 {h(row["measureIndex"])} 小节 / MIDI {h(row["midi"])} / 预测 {h(row["predictedOnsetSeconds"])} 秒</p>
            </div>
            <span class="badge">{h(row["scenario"])}</span>
          </header>
          {audio_html}
          {score_html}
          <div class="meta">
            <span>音频片段: {h(row.get("clipStartSeconds"))}s - {h(row.get("clipEndSeconds"))}s</span>
            <span>谱面: {h(row.get("pieceId"))} / 第 {h(row.get("pageNumber"))} 页 / 第 {h(row.get("measureIndex"))} 小节</span>
            <span>候选标记: {h(row.get("flags"))}</span>
            {metrics_html}
          </div>
          <div class="form-grid">
            <label>1. 音频和谱面是否匹配
              <select class="review-input" data-field="audioScoreMatch">
                <option value="">未标</option>
                <option value="match">匹配</option>
                <option value="mismatch">不匹配</option>
                <option value="uncertain">不确定</option>
              </select>
            </label>
            <label>2. 实际听到的音高行为
              {render_select("observedPitchBehavior", BEHAVIOR_OPTIONS)}
            </label>
            <label>3. 应采用哪种音准判法
              {render_select("pitchJudgementMode", JUDGEMENT_OPTIONS)}
            </label>
            <label>4. 这个片段能否判音准
              <select class="review-input" data-field="pitchJudgeable">
                <option value="">未标</option>
                <option value="yes">可以</option>
                <option value="no">不可以</option>
                <option value="uncertain">不确定</option>
              </select>
            </label>
            <label>5. 音准结论
              <select class="review-input" data-field="pitchAccuracyLabel">
                <option value="">未标</option>
                <option value="in-tune">准</option>
                <option value="sharp">偏高</option>
                <option value="flat">偏低</option>
                <option value="wrong-note">明显错音</option>
                <option value="not-judgeable">不可判</option>
                <option value="uncertain">不确定</option>
              </select>
            </label>
            <label>6. 置信度 1-5
              <select class="review-input" data-field="reviewConfidence">
                <option value="">未标</option>
                <option value="5">5 很确定</option>
                <option value="4">4 较确定</option>
                <option value="3">3 一般</option>
                <option value="2">2 较不确定</option>
                <option value="1">1 很不确定</option>
              </select>
            </label>
          </div>
          <label>备注<textarea class="review-input" data-field="reviewComments" rows="2"></textarea></label>
          <div class="actions">
            <button type="button" class="mark-correct secondary">本条匹配且音准正确</button>
            <button type="button" class="mark-uncertain">本条不确定</button>
            <button type="button" class="mark-mismatch ghost">本条不匹配</button>
            <button type="button" class="clear-row ghost">清空本条</button>
          </div>
        </section>
        """)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>M3+ 音高行为复核包</title>
  <style>
    :root {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f6f7f9; }}
    body {{ margin: 0; }}
    main {{ max-width: 1180px; margin: 0 auto; padding: 24px; }}
    h1 {{ margin: 0 0 8px; font-size: 28px; }}
    .intro, .toolbar, .card {{ background: #fff; border: 1px solid #d8dee8; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }}
    .intro {{ padding: 16px; margin-bottom: 16px; }}
    .toolbar {{ position: sticky; top: 0; z-index: 5; padding: 12px; margin-bottom: 16px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }}
    button {{ border: 0; border-radius: 6px; padding: 9px 12px; background: #1f6feb; color: #fff; cursor: pointer; font-weight: 650; }}
    button.ghost {{ background: #eef2f7; color: #1d2733; }}
    button.secondary {{ background: #0f766e; }}
    button:focus, select:focus, textarea:focus {{ outline: 3px solid rgba(31,111,235,.25); }}
    .card {{ margin: 16px 0; padding: 16px; }}
    header {{ display: flex; justify-content: space-between; gap: 16px; align-items: start; }}
    h2 {{ margin: 0 0 4px; font-size: 20px; }}
    p {{ margin: 4px 0; }}
    audio {{ width: 100%; margin: 12px 0; }}
    .score-panel {{ margin: 12px 0; padding: 10px; border: 1px solid #d8dee8; border-radius: 8px; background: #fbfcfe; }}
    .score-panel figcaption {{ margin-bottom: 8px; font-weight: 700; color: #344054; }}
    .score-panel img {{ display: block; width: 100%; max-height: 520px; object-fit: contain; background: white; border: 1px solid #e5e7eb; border-radius: 6px; }}
    .badge {{ background: #edf7ed; color: #1f6b2d; padding: 5px 8px; border-radius: 999px; white-space: nowrap; }}
    .meta {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }}
    .meta span {{ background: #f0f3f8; border-radius: 999px; padding: 4px 8px; font-size: 13px; }}
    .form-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }}
    label {{ display: flex; flex-direction: column; gap: 5px; font-weight: 650; margin-top: 8px; }}
    select, textarea {{ border: 1px solid #b8c2d1; border-radius: 6px; padding: 8px; font: inherit; background: white; }}
    textarea {{ resize: vertical; }}
    .actions {{ display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }}
    .warn {{ color: #9a3412; font-weight: 650; }}
    .muted {{ color: #667085; }}
    code {{ background: #f0f3f8; padding: 2px 4px; border-radius: 4px; }}
  </style>
</head>
<body>
  <main>
    <h1>M3+ 音高行为人工复核包</h1>
    <section class="intro">
      <p><strong>目标:</strong> 不是展示技巧名称,也不是评价技巧质量。这里只判断这些特殊音高行为区域能否安全判音准,从而将来减少 review_required。</p>
      <p><strong>标注顺序:</strong> 先听音频是否匹配谱面音;不匹配就选“不匹配”。匹配时再标音高行为、判法、是否可判、音准结论和置信度。</p>
      <p><strong>快捷按钮:</strong> “本条匹配且音准正确”和“未标全部设为匹配且正确”只填写未标项;如果不确定,请用“不确定”,不要为了凑样本硬判。</p>
      <p><strong>安全边界:</strong> 本包只产生人工标签。未通过 precision≥90% / unsafe=0 闸门前,学生端仍全部 review-only。</p>
      <p class="muted">候选数: {len(pack["rows"])}; inventory: <code>{h(pack["sourceInventory"])}</code></p>
    </section>
    <section class="toolbar">
      <button type="button" id="download">下载已填 CSV</button>
      <button type="button" id="markAllCorrect" class="secondary">未标全部设为匹配且正确</button>
      <button type="button" id="markAllUncertain" class="ghost">未标全部设为不确定</button>
      <span id="progress" class="muted"></span>
    </section>
    {"".join(cards)}
  </main>
  <script>
    const pack = {pack_json};
    const columns = {json.dumps(REVIEW_COLUMNS, ensure_ascii=False)};
    const rows = pack.rows.map((row) => ({{ ...row }}));
    function csvEscape(value) {{
      const text = value == null ? "" : String(value);
      return /[",\\n\\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    }}
    function defaultBehavior(mode) {{
      return {{
        "slide-like": "slide",
        "trill-like": "trill",
        "double-stop-candidate": "double-stop",
        "ornament-candidate": "ornament",
        "stable": "stable",
        "variable-f0": "variable-f0",
      }}[mode] || "uncertain";
    }}
    function defaultJudgement(mode) {{
      return {{
        "slide-like": "slide-start-end",
        "trill-like": "trill-two-targets",
        "double-stop-candidate": "multi-f0",
        "ornament-candidate": "ornament-main-note",
        "stable": "normal-center",
        "variable-f0": "normal-center",
      }}[mode] || "uncertain";
    }}
    function isUnmarked(row) {{
      return !row.audioScoreMatch && !row.observedPitchBehavior && !row.pitchJudgeable && !row.pitchAccuracyLabel;
    }}
    function markCorrect(row) {{
      row.audioScoreMatch = "match";
      row.observedPitchBehavior = defaultBehavior(row.candidateMode);
      row.pitchJudgementMode = defaultJudgement(row.candidateMode);
      row.pitchJudgeable = "yes";
      row.pitchAccuracyLabel = "in-tune";
      row.reviewConfidence = row.reviewConfidence || "4";
    }}
    function markUncertain(row) {{
      row.audioScoreMatch = "uncertain";
      row.observedPitchBehavior = "uncertain";
      row.pitchJudgementMode = "uncertain";
      row.pitchJudgeable = "uncertain";
      row.pitchAccuracyLabel = "uncertain";
      row.reviewConfidence = row.reviewConfidence || "1";
    }}
    function markMismatch(row) {{
      row.audioScoreMatch = "mismatch";
      row.pitchJudgeable = "no";
      row.pitchAccuracyLabel = "not-judgeable";
      row.reviewConfidence = row.reviewConfidence || "4";
    }}
    function refreshProgress() {{
      const reviewed = rows.filter((row) => row.audioScoreMatch || row.pitchJudgeable || row.observedPitchBehavior).length;
      document.getElementById("progress").textContent = `已标 ${{reviewed}} / ${{rows.length}}`;
    }}
    function applyRowToCard(index, card) {{
      card.querySelectorAll(".review-input").forEach((input) => {{
        input.value = rows[index][input.dataset.field] || "";
      }});
      refreshProgress();
    }}
    function bindCard(card) {{
      const index = Number(card.dataset.index);
      card.querySelectorAll(".review-input").forEach((input) => {{
        const field = input.dataset.field;
        input.addEventListener("change", () => {{
          rows[index][field] = input.value;
          refreshProgress();
        }});
        input.addEventListener("input", () => {{
          rows[index][field] = input.value;
          refreshProgress();
        }});
      }});
      card.querySelector(".mark-correct").addEventListener("click", () => {{
        markCorrect(rows[index]);
        applyRowToCard(index, card);
      }});
      card.querySelector(".mark-uncertain").addEventListener("click", () => {{
        markUncertain(rows[index]);
        applyRowToCard(index, card);
      }});
      card.querySelector(".mark-mismatch").addEventListener("click", () => {{
        markMismatch(rows[index]);
        applyRowToCard(index, card);
      }});
      card.querySelector(".clear-row").addEventListener("click", () => {{
        for (const field of ["audioScoreMatch","observedPitchBehavior","pitchJudgementMode","pitchJudgeable","pitchAccuracyLabel","reviewConfidence","reviewComments"]) {{
          rows[index][field] = "";
        }}
        applyRowToCard(index, card);
      }});
    }}
    document.querySelectorAll(".card").forEach(bindCard);
    document.getElementById("markAllCorrect").addEventListener("click", () => {{
      rows.forEach((row) => {{
        if (isUnmarked(row)) markCorrect(row);
      }});
      document.querySelectorAll(".card").forEach((card) => applyRowToCard(Number(card.dataset.index), card));
    }});
    document.getElementById("markAllUncertain").addEventListener("click", () => {{
      rows.forEach((row) => {{
        if (isUnmarked(row)) markUncertain(row);
      }});
      document.querySelectorAll(".card").forEach((card) => applyRowToCard(Number(card.dataset.index), card));
    }});
    document.getElementById("download").addEventListener("click", () => {{
      const lines = [columns.join(",")];
      for (const row of rows) {{
        lines.push(columns.map((column) => csvEscape(row[column] || "")).join(","));
      }}
      const blob = new Blob(["\\ufeff" + lines.join("\\n")], {{ type: "text/csv;charset=utf-8" }});
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "m3plus-pitch-mode-review.completed.csv";
      link.click();
      URL.revokeObjectURL(link.href);
    }});
    refreshProgress();
  </script>
</body>
</html>
"""


def write_guide(path: Path, rows: list[dict[str, Any]], stats: dict[str, Any]) -> None:
    path.write_text(
        "\n".join([
            "# M3+ 音高行为复核指南",
            "",
            "## 这一步要判断什么",
            "",
            "这不是技巧名称展示,也不是技巧质量评价。目标是确认某些音高行为区域能否安全判音准,从而在将来减少 review_required。",
            "",
            "标注顺序:",
            "1. 先听短音频,对照页面里的对应五线谱图片,判断音频是否匹配这一行的谱面音。",
            "2. 不匹配就标 `mismatch`,后面的音准字段可设为不可判。",
            "3. 匹配时,再标实际音高行为、应采用的音准判法、是否可判音准、音准结论和置信度。",
            "4. 拿不准就标 `uncertain`;不要为了凑样本硬判。",
            "5. 页面里的快捷按钮只填未标项。若要全局快速处理,先确认大部分样本确实符合该判断。",
            "6. 五线谱图片按 `pieceId/page/measure/note` 定位;若图片缺失或看不清,在备注说明并标为不确定。",
            "",
            "## 本包规模",
            "",
            f"- rows: {len(rows)}",
            f"- availableCounts: `{json.dumps(stats.get('availableCounts', {}), ensure_ascii=False)}`",
            f"- selectedCounts: `{json.dumps(stats.get('selectedCounts', {}), ensure_ascii=False)}`",
            "",
            "## 输出",
            "",
            "- 打开 `index.html` 复核。",
            "- 标完点击页面上的 `下载已填 CSV`,得到 `m3plus-pitch-mode-review.completed.csv`。",
            "- 下载后运行 `npm run western:m3plus-review-import -- --reviews <completed.csv>` 导入标签。",
            "- 当前标签只用于 M3+ precision 评估,不直接打开学生端。",
            "",
            "## 安全边界",
            "",
            "在具体模式证明 note-level 音准 precision>=90% 且 unsafe=0 前,学生端仍保持 review-only。",
            "",
        ]),
        encoding="utf-8",
    )


def build_pack(args: argparse.Namespace) -> dict[str, Any]:
    inventory_path = repo_path(args.inventory)
    summary_path = repo_path(args.summary)
    out_dir = repo_path(args.out)
    rows = read_csv(inventory_path)
    modes = [item.strip() for item in str(args.modes).split(",") if item.strip()]
    excluded_keys = load_excluded_keys(list(args.exclude_reviewed or []))
    excluded_recordings = set(str(item).strip() for item in (args.exclude_recording_id or []) if str(item).strip())
    excluded_recordings.update(load_diagnosis_excluded_recordings(
        list(args.exclude_localization_diagnosis or []),
        int(args.exclude_diagnosis_min_recording_total),
        float(args.exclude_diagnosis_min_nonmatch_rate),
    ))
    selected, stats = select_rows(rows, modes, int(args.per_mode), excluded_keys, excluded_recordings)
    audio_paths = load_summary_audio_paths(summary_path)
    review_rows, warnings = build_review_rows(
        selected,
        audio_paths,
        out_dir,
        clip_before=float(args.clip_before),
        clip_after=float(args.clip_after),
    )
    for row in review_rows:
        row.pop("metrics", None)
        row.pop("clipStartSeconds", None)
        row.pop("clipEndSeconds", None)
    write_csv(out_dir / "m3plus-pitch-mode-review.csv", review_rows, REVIEW_COLUMNS)

    # Rebuild rows with display-only metadata for HTML/JSON after CSV has been kept schema-stable.
    display_rows, display_warnings = build_review_rows(
        selected,
        audio_paths,
        out_dir,
        clip_before=float(args.clip_before),
        clip_after=float(args.clip_after),
    )
    warnings = sorted(set(warnings + display_warnings))
    pack = {
        "ok": True,
        "sourceInventory": str(inventory_path.relative_to(REPO) if inventory_path.is_relative_to(REPO) else inventory_path),
        "sourceSummary": str(summary_path.relative_to(REPO) if summary_path.is_relative_to(REPO) else summary_path),
        "outDir": str(out_dir.relative_to(REPO) if out_dir.is_relative_to(REPO) else out_dir),
        "rows": display_rows,
        "reviewColumns": REVIEW_COLUMNS,
        "stats": stats,
        "warnings": warnings,
        "gate": {
            "name": "western-strings-m3plus-pitch-mode-review-pack",
            "studentGateReady": False,
            "reason": "human-label-collection-only",
            "runtimeEffect": "none",
        },
    }
    (out_dir / "m3plus-pitch-mode-review.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "index.html").write_text(render_html(pack), encoding="utf-8")
    write_guide(out_dir / "review-guide.md", display_rows, stats)
    return pack


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a local M3+ pitch behavior review pack.")
    parser.add_argument("--inventory", default=str(DEFAULT_INVENTORY))
    parser.add_argument("--summary", default=str(DEFAULT_SUMMARY))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--modes", default=",".join(DEFAULT_MODES), help="Comma-separated candidate modes to sample.")
    parser.add_argument("--per-mode", type=int, default=8)
    parser.add_argument("--clip-before", type=float, default=1.5)
    parser.add_argument("--clip-after", type=float, default=2.5)
    parser.add_argument("--exclude-reviewed", action="append", default=[], help="CSV with already reviewed rows to exclude by recordingId/noteIndex/noteId. Can be repeated.")
    parser.add_argument("--exclude-recording-id", action="append", default=[], help="RecordingId to exclude from this review pack. Can be repeated.")
    parser.add_argument("--exclude-localization-diagnosis", action="append", default=[], help="Localization diagnosis JSON whose high-risk recording groups should be excluded. Can be repeated.")
    parser.add_argument("--exclude-diagnosis-min-recording-total", type=int, default=3)
    parser.add_argument("--exclude-diagnosis-min-nonmatch-rate", type=float, default=1.0)
    return parser.parse_args()


def main() -> None:
    pack = build_pack(parse_args())
    print(json.dumps({
        "ok": pack["ok"],
        "rowCount": len(pack["rows"]),
        "outDir": pack["outDir"],
        "stats": pack["stats"],
        "warnings": pack["warnings"],
        "gate": pack["gate"],
        "artifacts": {
            "html": str(Path(pack["outDir"]) / "index.html"),
            "csv": str(Path(pack["outDir"]) / "m3plus-pitch-mode-review.csv"),
            "json": str(Path(pack["outDir"]) / "m3plus-pitch-mode-review.json"),
            "guide": str(Path(pack["outDir"]) / "review-guide.md"),
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
