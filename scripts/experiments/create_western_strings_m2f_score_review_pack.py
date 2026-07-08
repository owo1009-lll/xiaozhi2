from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from eval_western_strings_m2f_real_recordings import DEFAULT_MANIFEST
from eval_western_strings_m2f_real_recordings import REPO
from eval_western_strings_m2f_real_recordings import read_csv
from eval_western_strings_m2f_real_recordings import repo_path


DEFAULT_INTAKE = REPO / "data" / "experiments" / "western-strings-m2" / "clean-score-intake.csv"
DEFAULT_OUT_DIR = REPO / "data" / "experiments" / "western-strings-m2" / "score-review-pack"
DEFAULT_AUDIVERIS_SUMMARY = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m2"
    / "audiveris-draft"
    / "audiveris-draft-musicxml-summary.json"
)

SCENARIO_LABELS = {
    "correct": "正确演奏",
    "wrong_pitch": "错音",
    "missing_note": "漏音",
    "rhythm_shift": "节奏偏移",
    "weak_onset": "起音弱/不清晰",
    "noisy": "噪声/干扰",
}

REVIEW_STATUS_LABELS = {
    "pending": "待复核",
    "approved": "通过",
    "needs-fix": "需修改",
    "rejected": "不通过",
}


def display_path(path: str, *, base: Path) -> str:
    if not path.strip():
        return ""
    resolved = repo_path(path)
    # Browser media elements handle repo-relative paths reliably. Absolute
    # Windows paths are brittle here, especially under non-ASCII workspace names.
    try:
        return os.path.relpath(resolved.resolve(strict=False), base.resolve(strict=False)).replace("\\", "/")
    except ValueError:
        return str(resolved.resolve(strict=False))


def safe_file_stem(value: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    return stem.strip(".-") or "audio"


def prepare_audio_preview(audio_path: str, *, out_dir: Path, recording_id: str) -> str:
    source = repo_path(audio_path)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not source.exists():
        return display_path(audio_path, base=out_dir)
    preview_dir = out_dir / "audio"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview = preview_dir / f"{safe_file_stem(recording_id)}.mp3"
    if not preview.exists() or preview.stat().st_mtime < source.stat().st_mtime:
        try:
            subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "fatal",
                    "-i",
                    str(source),
                    "-vn",
                    "-codec:a",
                    "libmp3lame",
                    "-b:a",
                    "160k",
                    str(preview),
                ],
                check=True,
            )
        except subprocess.CalledProcessError:
            preview.unlink(missing_ok=True)
            return display_path(audio_path, base=out_dir)
    return display_path(str(preview), base=out_dir)


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    columns = [
        "recordingId",
        "pieceId",
        "scenario",
        "audioPath",
        "scoreImagePath",
        "targetCleanScorePath",
        "audiverisDraftMxlPath",
        "audiverisDraftParseOk",
        "audiverisDraftMeasures",
        "audiverisDraftNotes",
        "audiverisDraftError",
        "scoreId",
        "cleanScoreReviewStatus",
        "cleanScoreReviewedBy",
        "cleanScoreReviewNotes",
        "status",
        "notes",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_readme(path: Path) -> None:
    path.write_text(
        "\n".join(
            [
                "# Western Strings M2f Score Review Pack",
                "",
                "This pack is for manually producing clean score files for the M2f release gate.",
                "",
                "Workflow:",
                "1. Open `index.html` and inspect each score image.",
                "2. Transcribe or export the matching clean MusicXML/MXL/MIDI score.",
                "3. If an Audiveris draft is listed, use it only as a starting point and check it against the original score image.",
                "4. Save the checked file to the `targetCleanScorePath` shown for that row, or fill an existing clean `scoreId` in the intake CSV.",
                "5. Set `cleanScoreReviewStatus` to `approved` in the intake CSV only after the score has been checked.",
                "6. Run `npm run western:m2f-apply-clean-scores -- --apply`.",
                "7. Run `npm run western:m2f-manifest-status`.",
                "",
                "If Audiveris drafts have not yet been copied into the target paths, run `npm run western:m2f-stage-audiveris-drafts -- --apply` first. This copies drafts only; it does not approve them.",
                "",
                "Do not use Basic Pitch or audio-derived MIDI as the clean score. That would encode student performance errors into the score.",
                "Do not use unchecked Audiveris drafts as the clean score. They must be manually verified first.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def load_audiveris_summary(summary_path: Path) -> dict[str, dict[str, str]]:
    if not summary_path.exists():
        return {}
    try:
        items = json.loads(summary_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    by_key: dict[str, dict[str, str]] = {}
    if not isinstance(items, list):
        return by_key
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized = {
            "audiverisDraftMxlPath": str(item.get("mxl") or ""),
            "audiverisDraftParseOk": "yes" if item.get("parseOk") else "",
            "audiverisDraftMeasures": str(item.get("measures") or ""),
            "audiverisDraftNotes": str(item.get("notes") or ""),
            "audiverisDraftError": str(item.get("error") or item.get("parseError") or ""),
        }
        for key_name in ("recordingId", "pieceId"):
            key = str(item.get(key_name) or "").strip()
            if key:
                by_key[key] = normalized
    return by_key


def build_rows(manifest_path: Path, intake_path: Path, audiveris_summary_path: Path) -> list[dict[str, str]]:
    manifest_rows, _manifest_columns = read_csv(manifest_path)
    intake_rows, _intake_columns = read_csv(intake_path)
    manifest_by_id = {row.get("recordingId", "").strip(): row for row in manifest_rows}
    audiveris_by_key = load_audiveris_summary(audiveris_summary_path)
    rows: list[dict[str, str]] = []
    for intake in intake_rows:
        recording_id = intake.get("recordingId", "").strip()
        piece_id = intake.get("pieceId", "").strip()
        manifest = manifest_by_id.get(recording_id, {})
        audiveris = audiveris_by_key.get(recording_id) or audiveris_by_key.get(piece_id) or {}
        rows.append(
            {
                "recordingId": recording_id,
                "pieceId": piece_id,
                "scenario": manifest.get("scenario", "").strip(),
                "audioPath": intake.get("audioPath", "").strip(),
                "currentScorePath": intake.get("currentScorePath", "").strip(),
                "currentScoreType": intake.get("currentScoreType", "").strip(),
                "scoreImagePath": intake.get("currentScorePath", "").strip(),
                "targetCleanScorePath": intake.get("requiredCleanScorePath", "").strip(),
                "requiredCleanScorePath": intake.get("requiredCleanScorePath", "").strip(),
                "audiverisDraftMxlPath": audiveris.get("audiverisDraftMxlPath", ""),
                "audiverisDraftParseOk": audiveris.get("audiverisDraftParseOk", ""),
                "audiverisDraftMeasures": audiveris.get("audiverisDraftMeasures", ""),
                "audiverisDraftNotes": audiveris.get("audiverisDraftNotes", ""),
                "audiverisDraftError": audiveris.get("audiverisDraftError", ""),
                "scoreId": intake.get("scoreId", "").strip(),
                "cleanScoreReviewStatus": intake.get("cleanScoreReviewStatus", "").strip(),
                "cleanScoreReviewedBy": intake.get("cleanScoreReviewedBy", "").strip(),
                "cleanScoreReviewNotes": intake.get("cleanScoreReviewNotes", "").strip(),
                "action": intake.get("action", "").strip(),
                "status": intake.get("status", "").strip(),
                "notes": intake.get("notes", "").strip(),
            }
        )
    return rows


def write_html(path: Path, rows: list[dict[str, str]]) -> None:
    base = path.parent
    row_html: list[str] = []
    for index, row in enumerate(rows, start=1):
        image_rel = display_path(row["scoreImagePath"], base=base)
        audio_rel = prepare_audio_preview(row["audioPath"], out_dir=base, recording_id=row["recordingId"])
        audio_id = f"audio-{index}"
        target_rel = display_path(row["targetCleanScorePath"], base=base)
        draft_label = Path(row["audiverisDraftMxlPath"]).name if row["audiverisDraftMxlPath"] else "none"
        scenario_label = SCENARIO_LABELS.get(row["scenario"], row["scenario"] or "未标注")
        initial_status = row["cleanScoreReviewStatus"] if row["cleanScoreReviewStatus"] in REVIEW_STATUS_LABELS else "pending"
        status_buttons = []
        for value, label in REVIEW_STATUS_LABELS.items():
            active_class = " active" if value == initial_status else ""
            status_buttons.append(
                f"<button type=\"button\" class=\"status-button{active_class}\" data-recording-id=\"{html.escape(row['recordingId'])}\" data-status=\"{value}\">{html.escape(label)}</button>"
            )
        row_html.append(
            "\n".join(
                [
                    "<section class=\"card\">",
                    f"<h2>#{index} {html.escape(row['recordingId'])}</h2>",
                    f"<p><b>演奏类型:</b> {html.escape(scenario_label)} <code>{html.escape(row['scenario'])}</code> &nbsp; <b>曲目ID:</b> {html.escape(row['pieceId'])}</p>",
                    f"<p><b>音频:</b> <code>{html.escape(row['audioPath'])}</code></p>",
                    f"<audio id=\"{audio_id}\" controls preload=\"metadata\" src=\"{html.escape(audio_rel)}\"></audio>",
                    f"<div class=\"button-group\"><button type=\"button\" class=\"play-button\" data-audio-id=\"{audio_id}\">播放/暂停</button><a class=\"open-audio\" href=\"{html.escape(audio_rel)}\" target=\"_blank\" rel=\"noreferrer\">单独打开音频</a></div>",
                    f"<p><b>目标 clean score:</b> <a href=\"{html.escape(target_rel)}\"><code>{html.escape(row['targetCleanScorePath'])}</code></a></p>",
                    f"<p><b>Audiveris 草稿:</b> <code>{html.escape(draft_label)}</code></p>",
                    f"<p><b>草稿解析:</b> {html.escape(row['audiverisDraftParseOk'] or 'no')} &nbsp; <b>小节:</b> {html.escape(row['audiverisDraftMeasures'])} &nbsp; <b>音符:</b> {html.escape(row['audiverisDraftNotes'])}</p>",
                    f"<p><b>草稿问题:</b> {html.escape(row['audiverisDraftError'] or '无')}</p>",
                    "<div class=\"review-panel\">",
                    "<div class=\"review-row\"><b>判定类型:</b><div class=\"button-group\">",
                    *status_buttons,
                    "</div></div>",
                    f"<label>审核人 <input class=\"reviewer-input\" data-recording-id=\"{html.escape(row['recordingId'])}\" value=\"{html.escape(row['cleanScoreReviewedBy'])}\" placeholder=\"填写姓名或ID\" /></label>",
                    f"<label>备注 <textarea class=\"notes-input\" data-recording-id=\"{html.escape(row['recordingId'])}\" rows=\"2\" placeholder=\"需要修谱的位置、问题说明等\">{html.escape(row['cleanScoreReviewNotes'])}</textarea></label>",
                    f"<p class=\"status-line\">当前判定: <span class=\"status-label\" data-recording-id=\"{html.escape(row['recordingId'])}\">{html.escape(REVIEW_STATUS_LABELS[initial_status])}</span></p>",
                    "</div>",
                    f"<p><b>流程状态:</b> {html.escape(row['status'])}</p>",
                    f"<img src=\"{html.escape(image_rel)}\" alt=\"score image for {html.escape(row['recordingId'])}\" />",
                    "</section>",
                ]
            )
        )
    rows_json = json.dumps(rows, ensure_ascii=False).replace("</", "<\\/")
    status_json = json.dumps(REVIEW_STATUS_LABELS, ensure_ascii=False).replace("</", "<\\/")
    path.write_text(
        "\n".join(
            [
                "<!doctype html>",
                "<html lang=\"zh-CN\">",
                "<head>",
                "<meta charset=\"utf-8\" />",
                "<title>M2f clean score 人工复核</title>",
                "<style>",
                "body{font-family:'Microsoft YaHei','Segoe UI',Arial,sans-serif;margin:24px;line-height:1.45;background:#f7f7f5;color:#1f2933}",
                ".toolbar,.card{background:white;border:1px solid #d8d8d2;border-radius:8px;padding:16px;margin:0 0 24px}",
                "img{max-width:100%;display:block;margin-top:12px;border:1px solid #ddd}",
                "audio{width:100%;margin:8px 0}",
                "code{background:#f1f1ee;padding:2px 4px;border-radius:4px}",
                "button{cursor:pointer;border:1px solid #b9b9b2;background:#fafafa;border-radius:6px;padding:7px 10px;font:inherit}",
                "button:hover{background:#eef6ff}",
                ".primary{background:#075985;color:white;border-color:#075985}",
                ".primary:hover{background:#0c4a6e}",
                ".button-group{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}",
                ".open-audio{display:inline-block;border:1px solid #b9b9b2;background:#fafafa;border-radius:6px;padding:7px 10px;color:#075985;text-decoration:none}",
                ".open-audio:hover{background:#eef6ff}",
                ".status-button.active{background:#166534;color:white;border-color:#166534}",
                ".status-button[data-status='needs-fix'].active{background:#92400e;border-color:#92400e}",
                ".status-button[data-status='rejected'].active{background:#991b1b;border-color:#991b1b}",
                ".review-panel{border:1px solid #e2e2dc;background:#fbfbf8;border-radius:8px;padding:12px;margin:12px 0}",
                ".review-row{margin-bottom:10px}",
                "label{display:block;margin:10px 0}",
                "input,textarea{box-sizing:border-box;width:100%;border:1px solid #c8c8c2;border-radius:6px;padding:8px;font:inherit;margin-top:4px}",
                ".hint{color:#5f665f}",
                ".status-label{font-weight:700}",
                ".csv-output{width:100%;height:180px;font-family:Consolas,monospace;font-size:12px}",
                ".summary{font-weight:700}",
                "</style>",
                "</head>",
                "<body>",
                "<h1>M2f clean score 人工复核</h1>",
                "<div class=\"toolbar\">",
                "<p class=\"summary\" id=\"summaryLine\"></p>",
                "<p>用途: 检查每条录音的原谱图与目标 MXL 是否一致。Audiveris 草稿只能作为起点, 不能未经人工确认就放行。</p>",
                "<p class=\"hint\">只有“通过”会导出为 <code>cleanScoreReviewStatus=approved</code>；“需修改/不通过/待复核”都会继续阻塞 release gate。</p>",
                "<label>统一审核人 <input id=\"globalReviewer\" placeholder=\"例如 teacher-a 或你的姓名\" /></label>",
                "<div class=\"button-group\">",
                "<button type=\"button\" id=\"fillReviewerButton\">填入所有空审核人</button>",
                "<button type=\"button\" class=\"primary\" id=\"downloadCsvButton\">下载更新后的 clean-score-intake.csv</button>",
                "<button type=\"button\" id=\"copyCsvButton\">复制 CSV 内容</button>",
                "</div>",
                "<label>CSV 预览 <textarea id=\"csvPreview\" class=\"csv-output\" readonly></textarea></label>",
                "</div>",
                *row_html,
                "<script>",
                f"const INTAKE_ROWS = {rows_json};",
                f"const STATUS_LABELS = {status_json};",
                "const STORAGE_KEY = 'western-m2f-score-review-v2';",
                "const COLUMNS = ['recordingId','pieceId','audioPath','currentScorePath','currentScoreType','requiredCleanScorePath','scoreId','cleanScoreReviewStatus','cleanScoreReviewedBy','cleanScoreReviewNotes','action','status','notes'];",
                "const state = {};",
                "function loadState(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}catch{return {}}}",
                "function saveState(){localStorage.setItem(STORAGE_KEY, JSON.stringify(state));}",
                "function csvEscape(value){const text=String(value??'');return /[\",\\n\\r]/.test(text)?'\"'+text.replaceAll('\"','\"\"')+'\"':text;}",
                "function rowStatus(id){return state[id]?.status || 'pending';}",
                "function updateButtons(id){document.querySelectorAll(`.status-button[data-recording-id=\"${CSS.escape(id)}\"]`).forEach(btn=>btn.classList.toggle('active',btn.dataset.status===rowStatus(id)));const label=document.querySelector(`.status-label[data-recording-id=\"${CSS.escape(id)}\"]`);if(label) label.textContent=STATUS_LABELS[rowStatus(id)]||rowStatus(id);}",
                "function updateSummary(){let approved=0,fix=0,rejected=0,pending=0;INTAKE_ROWS.forEach(row=>{const status=rowStatus(row.recordingId);if(status==='approved') approved++; else if(status==='needs-fix') fix++; else if(status==='rejected') rejected++; else pending++;});document.getElementById('summaryLine').textContent=`总数 ${INTAKE_ROWS.length} | 通过 ${approved} | 需修改 ${fix} | 不通过 ${rejected} | 待复核 ${pending}`;}",
                "function buildCsv(){const out=[COLUMNS.join(',')];INTAKE_ROWS.forEach(row=>{const saved=state[row.recordingId]||{};const status=saved.status==='approved'?'approved':'';const notePrefix=saved.status&&saved.status!=='approved'&&saved.status!=='pending'?`[${STATUS_LABELS[saved.status]||saved.status}] `:'';const merged={recordingId:row.recordingId,pieceId:row.pieceId,audioPath:row.audioPath,currentScorePath:row.currentScorePath,currentScoreType:row.currentScoreType,requiredCleanScorePath:row.requiredCleanScorePath,scoreId:row.scoreId,cleanScoreReviewStatus:status,cleanScoreReviewedBy:saved.reviewer??row.cleanScoreReviewedBy,cleanScoreReviewNotes:notePrefix+(saved.notes??row.cleanScoreReviewNotes),action:row.action,status:row.status,notes:row.notes};out.push(COLUMNS.map(col=>csvEscape(merged[col])).join(','));});return '\\ufeff'+out.join('\\n')+'\\n';}",
                "function refreshCsv(){document.getElementById('csvPreview').value=buildCsv();updateSummary();}",
                "Object.assign(state, loadState());",
                "INTAKE_ROWS.forEach(row=>{state[row.recordingId] ||= {status: row.cleanScoreReviewStatus || 'pending', reviewer: row.cleanScoreReviewedBy || '', notes: row.cleanScoreReviewNotes || ''};updateButtons(row.recordingId);});",
                "document.querySelectorAll('.status-button').forEach(btn=>btn.addEventListener('click',()=>{const id=btn.dataset.recordingId;state[id] ||= {};state[id].status=btn.dataset.status;updateButtons(id);saveState();refreshCsv();}));",
                "document.querySelectorAll('.reviewer-input').forEach(input=>input.addEventListener('input',()=>{const id=input.dataset.recordingId;state[id] ||= {};state[id].reviewer=input.value;saveState();refreshCsv();}));",
                "document.querySelectorAll('.notes-input').forEach(input=>input.addEventListener('input',()=>{const id=input.dataset.recordingId;state[id] ||= {};state[id].notes=input.value;saveState();refreshCsv();}));",
                "document.querySelectorAll('.play-button').forEach(btn=>btn.addEventListener('click',async()=>{const audio=document.getElementById(btn.dataset.audioId);if(!audio)return;try{if(audio.paused){await audio.play();btn.textContent='暂停';}else{audio.pause();btn.textContent='播放/暂停';}}catch(err){alert('浏览器无法播放该音频, 请点击“单独打开音频”。错误: '+err.message);}}));",
                "document.querySelectorAll('audio').forEach(audio=>audio.addEventListener('pause',()=>{const btn=document.querySelector(`.play-button[data-audio-id=\"${CSS.escape(audio.id)}\"]`);if(btn)btn.textContent='播放/暂停';}));",
                "document.getElementById('fillReviewerButton').addEventListener('click',()=>{const reviewer=document.getElementById('globalReviewer').value.trim();if(!reviewer){alert('请先填写统一审核人');return;}document.querySelectorAll('.reviewer-input').forEach(input=>{if(!input.value.trim()){input.value=reviewer;input.dispatchEvent(new Event('input'));}});});",
                "document.getElementById('downloadCsvButton').addEventListener('click',()=>{const blob=new Blob([buildCsv()],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='clean-score-intake.reviewed.csv';a.click();URL.revokeObjectURL(a.href);});",
                "document.getElementById('copyCsvButton').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(buildCsv());alert('CSV 已复制');}catch{document.getElementById('csvPreview').select();document.execCommand('copy');alert('CSV 已复制');}});",
                "refreshCsv();",
                "</script>",
                "</body>",
                "</html>",
            ]
        ),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a local review pack for M2f clean-score transcription.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--intake", default=str(DEFAULT_INTAKE))
    parser.add_argument("--audiveris-summary", default=str(DEFAULT_AUDIVERIS_SUMMARY))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    intake_path = Path(args.intake)
    out_dir = Path(args.out_dir)
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")
    if not intake_path.exists():
        raise SystemExit(f"Clean-score intake not found: {intake_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    rows = build_rows(manifest_path, intake_path, Path(args.audiveris_summary))
    write_csv(out_dir / "score-review.csv", rows)
    write_readme(out_dir / "README.md")
    write_html(out_dir / "index.html", rows)
    print(
        json.dumps(
            {
                "ok": True,
                "outDir": str(out_dir),
                "rows": len(rows),
                "index": str(out_dir / "index.html"),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
