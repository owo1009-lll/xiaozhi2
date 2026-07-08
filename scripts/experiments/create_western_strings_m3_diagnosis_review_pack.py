from __future__ import annotations

import argparse
import csv
import html
import json
import shutil
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_PREVIEWS = REPO / "data" / "experiments" / "western-strings-m2" / "results-review-pack" / "recording-previews.json"
DEFAULT_RESULTS = REPO / "data" / "experiments" / "western-strings-m3" / "real-student-diagnosis-results.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m3" / "diagnosis-review-pack"

DIAGNOSIS_CATEGORIES = [
    ("pitch", "音准", "音高偏高/偏低等音准问题"),
    ("onset", "起音", "起音提前/拖后等节奏起点问题"),
    ("duration", "时值", "音长过短/过长"),
    ("missing", "漏音", "谱上有但演奏缺失"),
    ("extra", "多音", "谱上没有但音频多出的音"),
]
BASE_COLUMNS = ["recordingId", "scenario", "autoPassEvaluatedCount"]
DIAGNOSIS_COLUMNS = [
    f"{category}{suffix}"
    for category, _label, _help in DIAGNOSIS_CATEGORIES
    for suffix in ["AutoIssueCount", "CorrectIssueCount", "UnsafeIssueCount"]
]
COLUMNS = BASE_COLUMNS + DIAGNOSIS_COLUMNS + ["notes"]
SCENARIO_TARGETS = {
    "wrong_pitch": {"pitch": 1},
    "missing_note": {"missing": 1},
    "rhythm_shift": {"onset": 1},
}


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in COLUMNS})


def copy_rel_asset(source_root: Path, rel_path: str, out_dir: Path) -> str:
    rel_path = str(rel_path or "").replace("\\", "/").strip()
    if not rel_path:
        return ""
    source = source_root / rel_path
    if not source.exists():
        return ""
    target = out_dir / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return rel_path


def empty_result(recording_id: str, scenario: str, auto_pass: int) -> dict[str, str]:
    row = {column: "0" for column in COLUMNS}
    row["recordingId"] = recording_id
    row["scenario"] = scenario
    row["autoPassEvaluatedCount"] = str(auto_pass)
    row["notes"] = "M3 diagnosis counts must come from teacher/gold review."
    return row


def normalize_result_row(row: dict[str, str], recording_id: str, scenario: str, auto_pass: int) -> dict[str, str]:
    merged = empty_result(recording_id, scenario, auto_pass)
    for column in COLUMNS:
        value = str(row.get(column, "")).strip()
        if value != "":
            merged[column] = value
    merged["recordingId"] = recording_id
    merged["scenario"] = scenario
    merged["autoPassEvaluatedCount"] = str(auto_pass)
    return merged


def build_pack(previews_path: Path, results_path: Path, out_dir: Path, preview_note_limit: int) -> dict[str, Any]:
    if not previews_path.exists():
        raise SystemExit(f"Missing M2f preview pack JSON: {previews_path}")
    source_root = previews_path.parent
    preview_pack = json.loads(previews_path.read_text(encoding="utf-8"))
    existing_rows = {row.get("recordingId", ""): row for row in read_csv(results_path)}
    recordings: list[dict[str, Any]] = []
    result_rows: list[dict[str, Any]] = []
    for item in preview_pack.get("recordings", []):
        recording_id = str(item.get("recordingId") or "").strip()
        if not recording_id:
            continue
        scenario = str(item.get("scenario") or "").strip()
        auto_pass = int(round(float(item.get("autoPassCount") or 0)))
        result_row = normalize_result_row(existing_rows.get(recording_id, {}), recording_id, scenario, auto_pass)
        result_rows.append(result_row)
        recordings.append({
            "recordingId": recording_id,
            "studentId": item.get("studentId", ""),
            "pieceId": item.get("pieceId", ""),
            "scenario": scenario,
            "audioRel": copy_rel_asset(source_root, item.get("audioRel", ""), out_dir),
            "scoreImageRel": copy_rel_asset(source_root, item.get("scoreImageRel", ""), out_dir),
            "noteCount": item.get("noteCount", 0),
            "autoPassCount": auto_pass,
            "coverage": item.get("coverage", 0),
            "previewRows": list(item.get("previewRows", []))[:preview_note_limit],
            "result": result_row,
            "scenarioTargets": SCENARIO_TARGETS.get(scenario, {}),
        })
    write_csv(out_dir / "real-student-diagnosis-results.preview.csv", result_rows)
    return {
        "ok": True,
        "sourcePreview": str(previews_path.relative_to(REPO) if previews_path.is_relative_to(REPO) else previews_path),
        "sourceResults": str(results_path.relative_to(REPO) if results_path.is_relative_to(REPO) else results_path),
        "recordingCount": len(recordings),
        "categories": [
            {"id": category, "label": label, "help": help_text}
            for category, label, help_text in DIAGNOSIS_CATEGORIES
        ],
        "columns": COLUMNS,
        "recordings": recordings,
    }


def csv_escape(value: Any) -> str:
    text = str(value if value is not None else "")
    if any(char in text for char in [",", '"', "\n", "\r"]):
        return '"' + text.replace('"', '""') + '"'
    return text


def h(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def render_html(pack: dict[str, Any]) -> str:
    pack_json = json.dumps(pack, ensure_ascii=False).replace("</script>", "<\\/script>")
    cards: list[str] = []
    for index, item in enumerate(pack["recordings"]):
        result = item["result"]
        score_img = (
            f'<img src="{html.escape(item["scoreImageRel"])}" alt="score image" />'
            if item.get("scoreImageRel")
            else '<p class="muted">没有谱面图片。可只听音频并参考 recordingId/scenario。</p>'
        )
        category_rows: list[str] = []
        for category in pack["categories"]:
            category_id = category["id"]
            category_rows.append(
                f"""
                <tr data-category="{html.escape(category_id)}">
                  <td><strong>{html.escape(category['label'])}</strong><br><span class="muted">{html.escape(category['help'])}</span></td>
                  <td><input class="diag auto" type="number" min="0" value="{html.escape(result.get(category_id + 'AutoIssueCount', '0'))}"></td>
                  <td><input class="diag correct" type="number" min="0" value="{html.escape(result.get(category_id + 'CorrectIssueCount', '0'))}"></td>
                  <td><input class="diag unsafe" type="number" min="0" value="{html.escape(result.get(category_id + 'UnsafeIssueCount', '0'))}"></td>
                  <td>
                    <button type="button" class="small mark-cat-correct">本类全对</button>
                    <button type="button" class="small ghost clear-cat">清零</button>
                  </td>
                </tr>
                """
            )
        preview_rows: list[str] = []
        for row in item.get("previewRows", []):
            is_auto = bool(row.get("isAutoPass"))
            seek_time = row.get("nearestEventStart", row.get("expectedSeconds", ""))
            preview_rows.append(
                '<tr data-auto-pass="' + ("1" if is_auto else "0") + '">' +
                f'<td>{h(row.get("noteIndex", ""))}</td>' +
                f'<td>{h(row.get("measure", ""))}</td>' +
                f'<td>{h(row.get("midi", ""))}</td>' +
                f'<td>{h(row.get("expectedSeconds", ""))}</td>' +
                f'<td>{h(row.get("nearestEventStart", ""))}</td>' +
                f'<td>{h(row.get("supportMs", ""))}</td>' +
                f'<td>{h(row.get("pitchDiff", ""))}</td>' +
                f'<td>{h(row.get("autoDecision", ""))}</td>' +
                f'<td><button type="button" class="small seek" data-time="{h(seek_time)}">跳转</button></td>' +
                '</tr>'
            )
        scenario_target = item.get("scenarioTargets", {})
        scenario_hint = "无自动预填目标"
        if scenario_target:
            scenario_hint = " / ".join(f"{key}={value}" for key, value in scenario_target.items())
        cards.append(
            f"""
            <section class="card" data-index="{index}">
              <header>
                <div>
                  <h2>{h(item['recordingId'])}</h2>
                  <p>{h(item['scenario'])} / {h(item.get('studentId', ''))} / {h(item.get('pieceId', ''))}</p>
                </div>
                <span class="badge">{item['autoPassCount']} auto-pass / {item['noteCount']} notes</span>
              </header>
              <audio controls preload="metadata" src="{h(item.get('audioRel', ''))}"></audio>
              <div class="grid">
                <div class="score">{score_img}</div>
                <div>
                  <label>本条已复核 auto-pass 数<input class="auto-pass-evaluated" type="number" min="0" value="{h(result.get('autoPassEvaluatedCount', str(item['autoPassCount'])))}"></label>
                  <table class="diagnosis-table">
                    <thead><tr><th>诊断类</th><th>系统诊断数</th><th>正确数</th><th>危险误判数</th><th>操作</th></tr></thead>
                    <tbody>{"".join(category_rows)}</tbody>
                  </table>
                  <label>备注<textarea class="notes" rows="3">{h(result.get('notes', ''))}</textarea></label>
                  <div class="inline-actions">
                    <button type="button" class="mark-filled-correct">已填诊断全部正确</button>
                    <button type="button" class="clear-section ghost">本条清零</button>
                    <button type="button" class="prefill-scenario secondary">按场景预填草稿</button>
                  </div>
                  <p class="hint">按场景预填仅生成复核草稿({h(scenario_hint)}),不能替代人工判断。若系统没有输出某类诊断,该类保持 0。</p>
                </div>
              </div>
              <details>
                <summary>查看 auto-pass 音符预览(用于抽查与定位)</summary>
                <table>
                  <thead><tr><th>#</th><th>小节</th><th>MIDI</th><th>预测秒</th><th>事件秒</th><th>距离ms</th><th>音高差</th><th>决策</th><th>播放</th></tr></thead>
                  <tbody>{"".join(preview_rows)}</tbody>
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
  <title>M3 基础诊断复核包</title>
  <style>
    body { margin: 0; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f6f7fb; color: #111827; }
    main { max-width: 1220px; margin: 0 auto; padding: 24px; }
    .top { position: sticky; top: 0; z-index: 3; background: rgba(246,247,251,.97); border-bottom: 1px solid #d8dee9; padding: 16px 24px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    h2 { margin: 0; font-size: 18px; }
    p { margin: 6px 0; }
    .actions, .inline-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
    button { border: 0; background: #1d4ed8; color: white; padding: 10px 14px; border-radius: 6px; cursor: pointer; font-weight: 700; }
    button.secondary { background: #475569; }
    button.ghost { background: #64748b; }
    button.danger { background: #b45309; }
    button.small { padding: 5px 8px; border-radius: 5px; font-size: 12px; }
    .card { background: white; border: 1px solid #d8dee9; border-radius: 8px; padding: 16px; margin: 18px 0; box-shadow: 0 1px 3px rgba(15,23,42,.08); }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
    .badge { background: #e0f2fe; color: #075985; padding: 6px 10px; border-radius: 999px; font-weight: 700; white-space: nowrap; }
    audio { width: 100%; margin: 12px 0; }
    .grid { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(420px, 1fr); gap: 16px; }
    .score { max-height: 560px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 6px; background: #fafafa; }
    .score img { width: 100%; display: block; }
    label { display: block; font-weight: 700; margin: 10px 0; }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; font: inherit; margin-top: 4px; }
    .hint, .muted { color: #64748b; font-size: 13px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 10px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; }
    tr[data-auto-pass="1"] { background: #fff7ed; }
    .diag { min-width: 72px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } header { display: block; } }
  </style>
</head>
<body>
  <div class="top">
    <h1>M3 基础诊断复核包</h1>
    <p>用途：填写每条录音中 pitch / onset / duration / missing / extra 五类诊断的系统诊断数、正确数和危险误判数。导出的 CSV 可直接用于 <code>npm run western:m3-status</code>。</p>
    <div class="actions">
      <button id="download">下载 M3 诊断结果 CSV</button>
      <button class="secondary" id="copy">复制 CSV 到剪贴板</button>
      <button class="danger" id="markAllFilledCorrect">全包已填诊断全部正确</button>
      <button class="ghost" id="clearAll">全包清零</button>
      <span id="status" class="hint"></span>
    </div>
  </div>
  <main>
    __CARDS__
  </main>
  <script id="pack-data" type="application/json">__PACK_JSON__</script>
  <script>
    const pack = JSON.parse(document.getElementById('pack-data').textContent);
    const status = document.getElementById('status');
    const categoryIds = pack.categories.map((item) => item.id);
    function num(value) {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
    }
    function csvEscape(value) {
      const text = String(value ?? '');
      return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    }
    function setCategory(row, auto, correct, unsafe) {
      row.querySelector('.auto').value = String(Math.max(0, num(auto)));
      row.querySelector('.correct').value = String(Math.max(0, num(correct)));
      row.querySelector('.unsafe').value = String(Math.max(0, num(unsafe)));
    }
    function clearSection(section) {
      section.querySelectorAll('tr[data-category]').forEach((row) => setCategory(row, 0, 0, 0));
    }
    function markFilledCorrect(section) {
      section.querySelectorAll('tr[data-category]').forEach((row) => {
        const auto = num(row.querySelector('.auto').value);
        row.querySelector('.correct').value = String(auto);
        row.querySelector('.unsafe').value = '0';
      });
    }
    function prefillScenario(section, item) {
      clearSection(section);
      for (const [category, count] of Object.entries(item.scenarioTargets || {})) {
        const row = section.querySelector(`tr[data-category="${category}"]`);
        if (row) setCategory(row, count, count, 0);
      }
      const notes = section.querySelector('.notes');
      if (notes && item.scenarioTargets && Object.keys(item.scenarioTargets).length) {
        notes.value = `${notes.value || ''}`.trim() || `Scenario draft from ${item.scenario}; verify before gate.`;
      }
    }
    function collectCsv() {
      const lines = [pack.columns.join(',')];
      for (let index = 0; index < pack.recordings.length; index += 1) {
        const item = pack.recordings[index];
        const section = document.querySelector(`[data-index="${index}"]`);
        const values = {
          recordingId: item.recordingId,
          scenario: item.scenario,
          autoPassEvaluatedCount: section.querySelector('.auto-pass-evaluated').value.trim(),
          notes: section.querySelector('.notes').value.trim(),
        };
        for (const category of categoryIds) {
          const row = section.querySelector(`tr[data-category="${category}"]`);
          values[`${category}AutoIssueCount`] = row.querySelector('.auto').value.trim();
          values[`${category}CorrectIssueCount`] = row.querySelector('.correct').value.trim();
          values[`${category}UnsafeIssueCount`] = row.querySelector('.unsafe').value.trim();
        }
        lines.push(pack.columns.map((column) => csvEscape(values[column] ?? '')).join(','));
      }
      return lines.join('\r\n') + '\r\n';
    }
    document.querySelectorAll('.mark-cat-correct').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest('tr');
        const auto = num(row.querySelector('.auto').value);
        setCategory(row, auto, auto, 0);
      });
    });
    document.querySelectorAll('.clear-cat').forEach((button) => {
      button.addEventListener('click', () => setCategory(button.closest('tr'), 0, 0, 0));
    });
    document.querySelectorAll('.mark-filled-correct').forEach((button) => {
      button.addEventListener('click', () => markFilledCorrect(button.closest('.card')));
    });
    document.querySelectorAll('.clear-section').forEach((button) => {
      button.addEventListener('click', () => clearSection(button.closest('.card')));
    });
    document.querySelectorAll('.prefill-scenario').forEach((button) => {
      button.addEventListener('click', () => {
        const section = button.closest('.card');
        const item = pack.recordings[Number(section.dataset.index)];
        prefillScenario(section, item);
      });
    });
    document.querySelectorAll('.seek').forEach((button) => {
      button.addEventListener('click', () => {
        const audio = button.closest('.card').querySelector('audio');
        const time = Number(button.dataset.time);
        if (Number.isFinite(time) && audio) {
          audio.currentTime = Math.max(0, time - 0.4);
          audio.play();
        }
      });
    });
    document.getElementById('markAllFilledCorrect').addEventListener('click', () => {
      if (confirm('确认把全包所有“已填的系统诊断数”都标为正确且 unsafe=0？')) {
        document.querySelectorAll('.card').forEach(markFilledCorrect);
        status.textContent = '已将全包已填诊断标为正确。';
      }
    });
    document.getElementById('clearAll').addEventListener('click', () => {
      if (confirm('确认清零全包所有诊断计数？')) {
        document.querySelectorAll('.card').forEach(clearSection);
        status.textContent = '已清零。';
      }
    });
    document.getElementById('download').addEventListener('click', () => {
      const blob = new Blob([collectCsv()], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'real-student-diagnosis-results.reviewed.csv';
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
    return page.replace("__CARDS__", "".join(cards)).replace("__PACK_JSON__", pack_json)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a local M3 diagnosis review pack.")
    parser.add_argument("--previews", type=Path, default=DEFAULT_PREVIEWS)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--preview-note-limit", type=int, default=80)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = repo_path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    pack = build_pack(repo_path(args.previews), repo_path(args.results), out_dir, max(0, args.preview_note_limit))
    (out_dir / "pack.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "index.html").write_text(render_html(pack), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "out": str(out_dir.relative_to(REPO) if out_dir.is_relative_to(REPO) else out_dir),
        "recordingCount": pack["recordingCount"],
        "csv": str((out_dir / "real-student-diagnosis-results.preview.csv").relative_to(REPO) if (out_dir / "real-student-diagnosis-results.preview.csv").is_relative_to(REPO) else out_dir / "real-student-diagnosis-results.preview.csv"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
