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
    ("stable", "稳定音"),
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


def download_filename(out_dir: Path) -> str:
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in out_dir.name).strip("-")
    suffix = f".{slug}" if slug else ""
    return f"m3plus-pitch-mode-review{suffix}.completed.csv"


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
    filename_json = json.dumps(str(pack.get("downloadFilename") or "m3plus-pitch-mode-review.completed.csv"), ensure_ascii=False)
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
            else '<p class="warn">\u6ca1\u6709\u627e\u5230\u97f3\u9891\u7247\u6bb5\u3002\u8bf7\u628a\u672c\u6761\u6807\u4e3a\u4e0d\u786e\u5b9a\uff0c\u5e76\u5728\u5907\u6ce8\u91cc\u8bf4\u660e\u3002</p>'
        )
        score_html = (
            f"""
            <figure class="score-panel">
              <figcaption>\u5bf9\u5e94\u4e94\u7ebf\u8c31\uff1a\u7b2c {h(row.get("pageNumber"))} \u9875 / \u7b2c {h(row.get("measureIndex"))} \u5c0f\u8282 / note {h(row.get("noteId"))}</figcaption>
              <a href="{h(row.get("scoreImage"))}" target="_blank" rel="noreferrer">
                <img src="{h(row.get("scoreImage"))}" alt="\u5bf9\u5e94\u4e94\u7ebf\u8c31 {h(row.get("pieceId"))}" loading="lazy" />
              </a>
            </figure>
            """
            if row.get("scoreImage")
            else '<p class="warn">\u6ca1\u6709\u627e\u5230\u5bf9\u5e94\u4e94\u7ebf\u8c31\u56fe\u7247\u3002\u8bf7\u6309\u5c0f\u8282 / MIDI \u6587\u672c\u8f85\u52a9\u5224\u65ad\uff0c\u5e76\u5728\u5907\u6ce8\u8bf4\u660e\u3002</p>'
        )
        cards.append(f"""
        <section class="card" data-index="{index}">
          <header>
            <div>
              <h2>{h(row["rowId"])} - {h(row["candidateMode"])}</h2>
              <p>\u5f55\u97f3 {h(row["recordingId"])} / \u7b2c {h(row["measureIndex"])} \u5c0f\u8282 / MIDI {h(row["midi"])} / \u9884\u6d4b {h(row["predictedOnsetSeconds"])} \u79d2</p>
            </div>
            <span class="badge">{h(row["scenario"])}</span>
          </header>
          {audio_html}
          {score_html}
          <div class="meta">
            <span>\u97f3\u9891\u7247\u6bb5: {h(row.get("clipStartSeconds"))}s - {h(row.get("clipEndSeconds"))}s</span>
            <span>\u8c31\u9762: {h(row.get("pieceId"))} / \u7b2c {h(row.get("pageNumber"))} \u9875 / \u7b2c {h(row.get("measureIndex"))} \u5c0f\u8282</span>
            <span>\u5019\u9009\u6807\u8bb0: {h(row.get("flags"))}</span>
            {metrics_html}
          </div>
          <div class="form-grid">
            <label>1. \u97f3\u9891\u548c\u8c31\u9762\u662f\u5426\u5339\u914d
              <select class="review-input" data-field="audioScoreMatch">
                <option value="">\u672a\u6807</option>
                <option value="match">\u5339\u914d</option>
                <option value="mismatch">\u4e0d\u5339\u914d</option>
                <option value="uncertain">\u4e0d\u786e\u5b9a</option>
              </select>
            </label>
            <label>2. \u5b9e\u9645\u542c\u5230\u7684\u97f3\u9ad8\u884c\u4e3a
              {render_select("observedPitchBehavior", BEHAVIOR_OPTIONS)}
            </label>
            <label>3. \u5e94\u91c7\u7528\u54ea\u79cd\u97f3\u51c6\u5224\u6cd5
              {render_select("pitchJudgementMode", JUDGEMENT_OPTIONS)}
            </label>
            <label>4. \u8fd9\u4e2a\u7247\u6bb5\u80fd\u5426\u5224\u97f3\u51c6
              <select class="review-input" data-field="pitchJudgeable">
                <option value="">\u672a\u6807</option>
                <option value="yes">\u53ef\u4ee5</option>
                <option value="no">\u4e0d\u53ef\u4ee5</option>
                <option value="uncertain">\u4e0d\u786e\u5b9a</option>
              </select>
            </label>
            <label>5. \u97f3\u51c6\u7ed3\u8bba
              <select class="review-input" data-field="pitchAccuracyLabel">
                <option value="">\u672a\u6807</option>
                <option value="in-tune">\u51c6</option>
                <option value="sharp">\u504f\u9ad8</option>
                <option value="flat">\u504f\u4f4e</option>
                <option value="wrong-note">\u660e\u663e\u9519\u97f3</option>
                <option value="not-judgeable">\u4e0d\u53ef\u5224</option>
                <option value="uncertain">\u4e0d\u786e\u5b9a</option>
              </select>
            </label>
            <label>6. \u7f6e\u4fe1\u5ea6 1-5
              <select class="review-input" data-field="reviewConfidence">
                <option value="">\u672a\u6807</option>
                <option value="5">5 \u5f88\u786e\u5b9a</option>
                <option value="4">4 \u8f83\u786e\u5b9a</option>
                <option value="3">3 \u4e00\u822c</option>
                <option value="2">2 \u8f83\u4e0d\u786e\u5b9a</option>
                <option value="1">1 \u5f88\u4e0d\u786e\u5b9a</option>
              </select>
            </label>
          </div>
          <label>\u5907\u6ce8<textarea class="review-input" data-field="reviewComments" rows="2"></textarea></label>
          <div class="actions">
            <button type="button" class="mark-correct secondary">\u672c\u6761\u5339\u914d\u4e14\u97f3\u51c6\u6b63\u786e</button>
            <button type="button" class="mark-uncertain">\u672c\u6761\u4e0d\u786e\u5b9a</button>
            <button type="button" class="mark-mismatch ghost">\u672c\u6761\u4e0d\u5339\u914d</button>
            <button type="button" class="clear-row ghost">\u6e05\u7a7a\u672c\u6761</button>
          </div>
        </section>
        """)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>\u004d\u0033\u002b \u97f3\u9ad8\u884c\u4e3a\u4eba\u5de5\u590d\u6838\u5305</title>
  <style>
    :root {{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f6f7f9; }}
    body {{ margin: 0; }} main {{ max-width: 1180px; margin: 0 auto; padding: 24px; }} h1 {{ margin: 0 0 8px; font-size: 28px; }}
    .intro, .toolbar, .card {{ background: #fff; border: 1px solid #d8dee8; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }}
    .intro {{ padding: 16px; margin-bottom: 16px; }} .toolbar {{ position: sticky; top: 0; z-index: 5; padding: 12px; margin-bottom: 16px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }}
    button {{ border: 0; border-radius: 6px; padding: 9px 12px; background: #1f6feb; color: #fff; cursor: pointer; font-weight: 650; }} button.ghost {{ background: #eef2f7; color: #1d2733; }} button.secondary {{ background: #0f766e; }}
    button:focus, select:focus, textarea:focus {{ outline: 3px solid rgba(31,111,235,.25); }} .card {{ margin: 16px 0; padding: 16px; }} header {{ display: flex; justify-content: space-between; gap: 16px; align-items: start; }} h2 {{ margin: 0 0 4px; font-size: 20px; }} p {{ margin: 4px 0; }} audio {{ width: 100%; margin: 12px 0; }}
    .score-panel {{ margin: 12px 0; padding: 10px; border: 1px solid #d8dee8; border-radius: 8px; background: #fbfcfe; }} .score-panel figcaption {{ margin-bottom: 8px; font-weight: 700; color: #344054; }} .score-panel img {{ display: block; width: 100%; max-height: 520px; object-fit: contain; background: white; border: 1px solid #e5e7eb; border-radius: 6px; }}
    .badge {{ background: #edf7ed; color: #1f6b2d; padding: 5px 8px; border-radius: 999px; white-space: nowrap; }} .meta {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }} .meta span {{ background: #f0f3f8; border-radius: 999px; padding: 4px 8px; font-size: 13px; }} .form-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }}
    label {{ display: flex; flex-direction: column; gap: 5px; font-weight: 650; margin-top: 8px; }} select, textarea {{ border: 1px solid #b8c2d1; border-radius: 6px; padding: 8px; font: inherit; background: white; }} textarea {{ resize: vertical; }} .actions {{ display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }} .warn {{ color: #9a3412; font-weight: 650; }} .muted {{ color: #667085; }} code {{ background: #f0f3f8; padding: 2px 4px; border-radius: 4px; }}
  </style>
</head>
<body><main>
  <h1>\u004d\u0033\u002b \u97f3\u9ad8\u884c\u4e3a\u4eba\u5de5\u590d\u6838\u5305</h1>
  <section class="intro">
    <p><strong>\u76ee\u6807:</strong> \u8fd9\u4e0d\u662f\u5c55\u793a\u6280\u5de7\u540d\u79f0\uff0c\u4e5f\u4e0d\u662f\u8bc4\u4ef7\u6280\u5de7\u8d28\u91cf\u3002\u8fd9\u91cc\u53ea\u5224\u65ad\u8fd9\u4e9b\u7279\u6b8a\u97f3\u9ad8\u884c\u4e3a\u533a\u57df\u80fd\u5426\u5b89\u5168\u5224\u97f3\u51c6\uff0c\u4ece\u800c\u5c06\u6765\u51cf\u5c11 review_required\u3002</p>
    <p><strong>\u6807\u6ce8\u987a\u5e8f:</strong> \u5148\u542c\u97f3\u9891\u662f\u5426\u5339\u914d\u8c31\u9762\u97f3\u3002\u4e0d\u5339\u914d\u5c31\u9009\u201c\u4e0d\u5339\u914d\u201d\u3002\u5339\u914d\u65f6\u518d\u6807\u97f3\u9ad8\u884c\u4e3a\u3001\u5224\u6cd5\u3001\u662f\u5426\u53ef\u5224\u3001\u97f3\u51c6\u7ed3\u8bba\u548c\u7f6e\u4fe1\u5ea6\u3002</p>
    <p><strong>\u5feb\u6377\u6309\u94ae:</strong> \u201c\u672c\u6761\u5339\u914d\u4e14\u97f3\u51c6\u6b63\u786e\u201d\u548c\u201c\u672a\u6807\u5168\u90e8\u8bbe\u4e3a\u5339\u914d\u4e14\u6b63\u786e\u201d\u53ea\u586b\u5199\u672a\u6807\u9879\u3002\u5982\u679c\u4e0d\u786e\u5b9a\uff0c\u8bf7\u7528\u201c\u4e0d\u786e\u5b9a\u201d\u3002</p>
    <p><strong>\u5b89\u5168\u8fb9\u754c:</strong> \u672c\u5305\u53ea\u4ea7\u751f\u4eba\u5de5\u6807\u7b7e\u3002\u672a\u901a\u8fc7 precision&gt;=90% / unsafe=0 \u95f8\u95e8\u524d\uff0c\u5b66\u751f\u7aef\u4ecd\u5168\u90e8 review-only\u3002</p>
    <p class="muted">\u5019\u9009\u6570: {len(pack["rows"])}; inventory: <code>{h(pack["sourceInventory"])}</code></p>
  </section>
  <section class="toolbar"><button type="button" id="download">\u4e0b\u8f7d\u5df2\u586b CSV</button><button type="button" id="markAllCorrect" class="secondary">\u672a\u6807\u5168\u90e8\u8bbe\u4e3a\u5339\u914d\u4e14\u6b63\u786e</button><button type="button" id="markAllUncertain" class="ghost">\u672a\u6807\u5168\u90e8\u8bbe\u4e3a\u4e0d\u786e\u5b9a</button><span id="progress" class="muted"></span></section>
  {"".join(cards)}
</main><script>
    const pack = {pack_json};
    const columns = {json.dumps(REVIEW_COLUMNS, ensure_ascii=False)};
    const rows = pack.rows.map((row) => ({{ ...row }}));
    function csvEscape(value) {{ const text = value == null ? "" : String(value); return /[",\\n\\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; }}
    function defaultBehavior(mode) {{ return {{ "slide-like": "slide", "trill-like": "trill", "double-stop-candidate": "double-stop", "ornament-candidate": "ornament", "stable": "stable", "variable-f0": "variable-f0" }}[mode] || "uncertain"; }}
    function defaultJudgement(mode) {{ return {{ "slide-like": "slide-start-end", "trill-like": "trill-two-targets", "double-stop-candidate": "multi-f0", "ornament-candidate": "ornament-main-note", "stable": "normal-center", "variable-f0": "normal-center" }}[mode] || "uncertain"; }}
    function isUnmarked(row) {{ return !row.audioScoreMatch && !row.observedPitchBehavior && !row.pitchJudgeable && !row.pitchAccuracyLabel; }}
    function markCorrect(row) {{ row.audioScoreMatch = "match"; row.observedPitchBehavior = defaultBehavior(row.candidateMode); row.pitchJudgementMode = defaultJudgement(row.candidateMode); row.pitchJudgeable = "yes"; row.pitchAccuracyLabel = "in-tune"; row.reviewConfidence = row.reviewConfidence || "4"; }}
    function markUncertain(row) {{ row.audioScoreMatch = "uncertain"; row.observedPitchBehavior = "uncertain"; row.pitchJudgementMode = "uncertain"; row.pitchJudgeable = "uncertain"; row.pitchAccuracyLabel = "uncertain"; row.reviewConfidence = row.reviewConfidence || "1"; }}
    function markMismatch(row) {{ row.audioScoreMatch = "mismatch"; row.pitchJudgeable = "no"; row.pitchAccuracyLabel = "not-judgeable"; row.reviewConfidence = row.reviewConfidence || "4"; }}
    function refreshProgress() {{ const reviewed = rows.filter((row) => row.audioScoreMatch || row.pitchJudgeable || row.observedPitchBehavior).length; document.getElementById("progress").textContent = `\u5df2\u6807 ${{reviewed}} / ${{rows.length}}`; }}
    function applyRowToCard(index, card) {{ card.querySelectorAll(".review-input").forEach((input) => {{ input.value = rows[index][input.dataset.field] || ""; }}); refreshProgress(); }}
    function bindCard(card) {{ const index = Number(card.dataset.index); card.querySelectorAll(".review-input").forEach((input) => {{ const field = input.dataset.field; input.addEventListener("change", () => {{ rows[index][field] = input.value; refreshProgress(); }}); input.addEventListener("input", () => {{ rows[index][field] = input.value; refreshProgress(); }}); }}); card.querySelector(".mark-correct").addEventListener("click", () => {{ markCorrect(rows[index]); applyRowToCard(index, card); }}); card.querySelector(".mark-uncertain").addEventListener("click", () => {{ markUncertain(rows[index]); applyRowToCard(index, card); }}); card.querySelector(".mark-mismatch").addEventListener("click", () => {{ markMismatch(rows[index]); applyRowToCard(index, card); }}); card.querySelector(".clear-row").addEventListener("click", () => {{ for (const field of ["audioScoreMatch","observedPitchBehavior","pitchJudgementMode","pitchJudgeable","pitchAccuracyLabel","reviewConfidence","reviewComments"]) {{ rows[index][field] = ""; }} applyRowToCard(index, card); }}); }}
    document.querySelectorAll(".card").forEach(bindCard);
    document.getElementById("markAllCorrect").addEventListener("click", () => {{ rows.forEach((row) => {{ if (isUnmarked(row)) markCorrect(row); }}); document.querySelectorAll(".card").forEach((card) => applyRowToCard(Number(card.dataset.index), card)); }});
    document.getElementById("markAllUncertain").addEventListener("click", () => {{ rows.forEach((row) => {{ if (isUnmarked(row)) markUncertain(row); }}); document.querySelectorAll(".card").forEach((card) => applyRowToCard(Number(card.dataset.index), card)); }});
    document.getElementById("download").addEventListener("click", () => {{ const lines = [columns.join(",")]; for (const row of rows) {{ lines.push(columns.map((column) => csvEscape(row[column] || "")).join(",")); }} const blob = new Blob(["\\ufeff" + lines.join("\\n")], {{ type: "text/csv;charset=utf-8" }}); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = {filename_json}; link.click(); URL.revokeObjectURL(link.href); }});
    refreshProgress();
  </script></body></html>
"""

def write_guide(path: Path, rows: list[dict[str, Any]], stats: dict[str, Any]) -> None:
    path.write_text(
        "\n".join([
            "# M3+ \u97f3\u9ad8\u884c\u4e3a\u590d\u6838\u6307\u5357",
            "",
            "## \u8fd9\u4e00\u5305\u8981\u5224\u65ad\u4ec0\u4e48",
            "",
            "\u8fd9\u4e0d\u662f\u6280\u5de7\u540d\u79f0\u5c55\u793a\uff0c\u4e5f\u4e0d\u662f\u6280\u5de7\u8d28\u91cf\u8bc4\u4ef7\u3002\u76ee\u6807\u662f\u786e\u8ba4\u67d0\u4e9b\u97f3\u9ad8\u884c\u4e3a\u533a\u57df\u80fd\u5426\u5b89\u5168\u5224\u97f3\u51c6\uff0c\u4ece\u800c\u5728\u5c06\u6765\u51cf\u5c11 review_required\u3002",
            "",
            "\u6807\u6ce8\u987a\u5e8f:",
            "1. \u5148\u542c\u77ed\u97f3\u9891\uff0c\u5bf9\u7167\u9875\u9762\u91cc\u7684\u5bf9\u5e94\u4e94\u7ebf\u8c31\u56fe\u7247\uff0c\u5224\u65ad\u97f3\u9891\u662f\u5426\u5339\u914d\u8fd9\u4e00\u884c\u7684\u8c31\u9762\u97f3\u3002",
            "2. \u4e0d\u5339\u914d\u5c31\u6807 `mismatch`\uff0c\u540e\u9762\u7684\u97f3\u51c6\u5b57\u6bb5\u53ef\u8bbe\u4e3a\u4e0d\u53ef\u5224\u3002",
            "3. \u5339\u914d\u65f6\uff0c\u518d\u6807\u5b9e\u9645\u97f3\u9ad8\u884c\u4e3a\u3001\u5e94\u91c7\u7528\u7684\u97f3\u51c6\u5224\u6cd5\u3001\u662f\u5426\u53ef\u5224\u97f3\u51c6\u3001\u97f3\u51c6\u7ed3\u8bba\u548c\u7f6e\u4fe1\u5ea6\u3002",
            "4. \u62ff\u4e0d\u51c6\u5c31\u6807 `uncertain`\uff1b\u4e0d\u8981\u4e3a\u4e86\u51d1\u6837\u672c\u786c\u5224\u3002",
            "5. \u9875\u9762\u91cc\u7684\u5feb\u6377\u6309\u94ae\u53ea\u586b\u672a\u6807\u9879\u3002\u82e5\u8981\u5168\u5c40\u5feb\u901f\u5904\u7406\uff0c\u5148\u786e\u8ba4\u5927\u90e8\u5206\u6837\u672c\u786e\u5b9e\u7b26\u5408\u8be5\u5224\u65ad\u3002",
            "6. \u4e94\u7ebf\u8c31\u56fe\u7247\u6309 `pieceId/page/measure/note` \u5b9a\u4f4d\uff1b\u82e5\u56fe\u7247\u7f3a\u5931\u6216\u770b\u4e0d\u6e05\uff0c\u5728\u5907\u6ce8\u8bf4\u660e\u5e76\u6807\u4e3a\u4e0d\u786e\u5b9a\u3002",
            "",
            "## \u672c\u5305\u89c4\u6a21",
            "",
            f"- rows: {len(rows)}",
            f"- availableCounts: `{json.dumps(stats.get('availableCounts', {}), ensure_ascii=False)}`",
            f"- selectedCounts: `{json.dumps(stats.get('selectedCounts', {}), ensure_ascii=False)}`",
            "",
            "## \u8f93\u51fa",
            "",
            "- \u6253\u5f00 `index.html` \u590d\u6838\u3002",
            f"- \u6807\u5b8c\u70b9\u51fb\u9875\u9762\u4e0a\u7684 `\u4e0b\u8f7d\u5df2\u586b CSV`\uff0c\u5f97\u5230 `{download_filename(path.parent)}`\u3002",
            "- \u5982\u679c CSV \u4e0b\u8f7d\u5230 Downloads\uff0c\u53ef\u8fd0\u884c `npm run western:ingest-review-downloads -- --target m3plus-candidate-quality --apply` \u5bfc\u5165\u5230\u672c\u5305\u3002",
            "- \u5f53\u524d\u6807\u7b7e\u53ea\u7528\u4e8e M3+ precision \u8bc4\u4f30\uff0c\u4e0d\u76f4\u63a5\u6253\u5f00\u5b66\u751f\u7aef\u3002",
            "",
            "## \u5b89\u5168\u8fb9\u754c",
            "",
            "\u5728\u5177\u4f53\u6a21\u5f0f\u8bc1\u660e note-level \u97f3\u51c6 precision>=90% \u4e14 unsafe=0 \u524d\uff0c\u5b66\u751f\u7aef\u4ecd\u4fdd\u6301 review-only\u3002",
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
        "downloadFilename": download_filename(out_dir),
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
