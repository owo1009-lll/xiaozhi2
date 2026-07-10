from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Callable
from xml.etree import ElementTree as ET


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO_ROOT / "data/private/western-strings-v2alpha-blind-intake/intake.json"
DEFAULT_OUT = REPO_ROOT / "data/experiments/western-strings-v2alpha-blind-intake-status.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data/experiments/western-strings-v2alpha-blind-intake-status.md"
M2_MANIFEST = REPO_ROOT / "data/experiments/western-strings-m2/real-student-recordings-manifest.csv"
M2_CLEAN_SCORE_INTAKE = REPO_ROOT / "data/experiments/western-strings-m2/clean-score-intake.csv"
M3_ROOT = REPO_ROOT / "data/experiments/western-strings-m3"
PILOT_ROOT = REPO_ROOT / "data/experiments/western-strings-controlled-pilot-sessions"
SCORE_STORE_JSON = REPO_ROOT / "data/erhu-score-imports.json"


def resolve_path(repo_root: Path, value: str) -> Path:
    candidate = Path(str(value or "").strip())
    return candidate if candidate.is_absolute() else repo_root / candidate


def relative_path(repo_root: Path, value: Path) -> str:
    try:
        return value.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return str(value.resolve())


def file_hash(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_xml_hash(xml_bytes: bytes) -> str:
    normalized = b" ".join(xml_bytes.replace(b"\r\n", b"\n").split())
    return hashlib.sha256(normalized).hexdigest()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def read_musicxml_bytes(score_path: Path) -> bytes:
    extension = score_path.suffix.lower()
    if extension in {".musicxml", ".xml"}:
        return score_path.read_bytes()
    if extension != ".mxl":
        raise ValueError("score-extension-unsupported")

    with zipfile.ZipFile(score_path) as archive:
        names = archive.namelist()
        root_name = ""
        if "META-INF/container.xml" in names:
            container = ET.fromstring(archive.read("META-INF/container.xml"))
            rootfile = next(
                (item for item in container.iter() if local_name(item.tag) == "rootfile"),
                None,
            )
            root_name = str(rootfile.attrib.get("full-path", "")).strip() if rootfile is not None else ""
        if not root_name:
            root_name = next(
                (
                    name
                    for name in names
                    if name.lower().endswith((".musicxml", ".xml"))
                    and not name.lower().startswith("meta-inf/")
                ),
                "",
            )
        if not root_name or root_name not in names:
            raise ValueError("mxl-rootfile-missing")
        return archive.read(root_name)


def inspect_musicxml(score_path: Path) -> dict[str, Any]:
    xml_bytes = read_musicxml_bytes(score_path)
    root = ET.fromstring(xml_bytes)
    root_name = local_name(root.tag)
    if root_name != "score-partwise":
        raise ValueError("musicxml-root-invalid")
    part_names: dict[str, str] = {}
    for score_part in (item for item in root.iter() if local_name(item.tag) == "score-part"):
        part_id = str(score_part.attrib.get("id") or "").strip()
        part_name = next(
            (
                str(item.text or "").strip()
                for item in score_part.iter()
                if local_name(item.tag) == "part-name" and str(item.text or "").strip()
            ),
            "",
        )
        if part_id:
            part_names[part_id] = part_name

    unique_part_ids = []
    part_nodes = []
    for part in (item for item in root.iter() if local_name(item.tag) == "part"):
        part_id = str(part.attrib.get("id") or "").strip()
        if part_id and part_id not in unique_part_ids:
            unique_part_ids.append(part_id)
            part_nodes.append(part)
    violin_ids = [
        part_id
        for part_id in unique_part_ids
        if any(token in part_names.get(part_id, "").lower() for token in ("violin", "violino", "vln"))
    ]
    selected_part_id = violin_ids[0] if len(violin_ids) == 1 else unique_part_ids[0] if len(unique_part_ids) == 1 else ""
    selected_part = next(
        (part for part in part_nodes if str(part.attrib.get("id") or "").strip() == selected_part_id),
        None,
    )
    selected_scope = selected_part if selected_part is not None else root
    measures = [item for item in selected_scope.iter() if local_name(item.tag) == "measure"]
    notes = [item for item in root.iter() if local_name(item.tag) == "note"]
    pitched_notes = [
        note
        for note in notes
        if any(local_name(child.tag) == "pitch" for child in note)
    ]
    first_measure_notes = []
    if measures:
        first_measure_notes = [
            note
            for note in measures[0].iter()
            if local_name(note.tag) == "note"
            and any(local_name(child.tag) == "pitch" for child in note)
        ]
    return {
        "root": root_name,
        "partCount": len(unique_part_ids),
        "partNames": [part_names.get(part_id, "") for part_id in unique_part_ids],
        "violinCandidateCount": len(violin_ids),
        "selectedPartId": selected_part_id,
        "selectedPartName": part_names.get(selected_part_id, ""),
        "violinPartResolved": bool(selected_part_id),
        "measureCount": len(measures),
        "pitchedNoteCount": len(pitched_notes),
        "firstMeasurePitchedNoteCount": len(first_measure_notes),
        "normalizedXmlSha256": normalized_xml_hash(xml_bytes),
    }


def probe_audio(audio_path: Path) -> dict[str, Any]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe-not-found")
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration:stream=codec_name,sample_rate,channels",
            "-of",
            "json",
            str(audio_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise RuntimeError("audio-decode-failed")
    payload = json.loads(completed.stdout or "{}")
    streams = payload.get("streams") or []
    if not streams:
        raise RuntimeError("audio-stream-missing")
    duration = float((payload.get("format") or {}).get("duration") or 0.0)
    stream = streams[0]
    return {
        "durationSeconds": round(duration, 3),
        "codec": str(stream.get("codec_name") or ""),
        "sampleRate": int(stream.get("sample_rate") or 0),
        "channels": int(stream.get("channels") or 0),
    }


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def collect_history(repo_root: Path) -> dict[str, set[str]]:
    history = {
        "recordingIds": set(),
        "pieceIds": set(),
        "scoreIds": set(),
        "audioSha1": set(),
        "audioSha256": set(),
        "scoreSha1": set(),
        "scoreSha256": set(),
        "scoreXmlSha256": set(),
    }

    def add_path_hashes(value: str, prefix: str, include_xml: bool = False) -> None:
        if not str(value or "").strip():
            return
        candidate = resolve_path(repo_root, value)
        if not candidate.is_file():
            return
        history[f"{prefix}Sha1"].add(file_hash(candidate, "sha1"))
        history[f"{prefix}Sha256"].add(file_hash(candidate, "sha256"))
        if include_xml:
            try:
                history["scoreXmlSha256"].add(inspect_musicxml(candidate)["normalizedXmlSha256"])
            except (ET.ParseError, OSError, ValueError, zipfile.BadZipFile):
                pass

    for row in read_csv_rows(repo_root / M2_MANIFEST.relative_to(REPO_ROOT)):
        history["recordingIds"].add(str(row.get("recordingId") or "").strip())
        history["pieceIds"].add(str(row.get("pieceId") or "").strip())
        history["scoreIds"].add(str(row.get("scoreId") or "").strip())
        add_path_hashes(str(row.get("audioPath") or ""), "audio")
        add_path_hashes(str(row.get("scorePath") or ""), "score", include_xml=True)

    for row in read_csv_rows(repo_root / M2_CLEAN_SCORE_INTAKE.relative_to(REPO_ROOT)):
        history["recordingIds"].add(str(row.get("recordingId") or "").strip())
        history["pieceIds"].add(str(row.get("pieceId") or "").strip())
        history["scoreIds"].add(str(row.get("scoreId") or "").strip())
        add_path_hashes(str(row.get("requiredCleanScorePath") or ""), "score", include_xml=True)

    m3_root = repo_root / M3_ROOT.relative_to(REPO_ROOT)
    for path in m3_root.rglob("*.csv") if m3_root.exists() else []:
        for row in read_csv_rows(path):
            history["recordingIds"].add(str(row.get("recordingId") or "").strip())
            history["pieceIds"].add(str(row.get("pieceId") or row.get("piece") or "").strip())
            history["scoreIds"].add(str(row.get("scoreId") or "").strip())
            audio_hash = str(row.get("audioHash") or "").strip().lower()
            if len(audio_hash) == 40:
                history["audioSha1"].add(audio_hash)
            elif len(audio_hash) == 64:
                history["audioSha256"].add(audio_hash)

    for row in read_jsonl(m3_root / "controlled-submissions.jsonl"):
        history["recordingIds"].add(str(row.get("recordingId") or "").strip())
        history["pieceIds"].add(str(row.get("piece") or row.get("pieceId") or "").strip())
        history["scoreIds"].add(str(row.get("scoreId") or "").strip())
        audio_hash = str(row.get("audioHash") or "").strip().lower()
        if len(audio_hash) == 40:
            history["audioSha1"].add(audio_hash)
        elif len(audio_hash) == 64:
            history["audioSha256"].add(audio_hash)

    pilot_root = repo_root / PILOT_ROOT.relative_to(REPO_ROOT)
    for session_path in pilot_root.glob("*/session.json") if pilot_root.exists() else []:
        try:
            session = json.loads(session_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for submission in session.get("selectedSubmissions") or []:
            history["recordingIds"].add(str(submission.get("recordingId") or "").strip())
            history["pieceIds"].add(str(submission.get("piece") or submission.get("pieceId") or "").strip())
            history["scoreIds"].add(str(submission.get("scoreId") or "").strip())

    score_store_path = repo_root / SCORE_STORE_JSON.relative_to(REPO_ROOT)
    if score_store_path.exists():
        try:
            store = json.loads(score_store_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            store = {}
        for score in store.get("scores") or []:
            history["scoreIds"].add(str(score.get("scoreId") or "").strip())
            score_hash = str(score.get("musicxmlHash") or "").strip().lower()
            if len(score_hash) == 40:
                history["scoreSha1"].add(score_hash)
            elif len(score_hash) == 64:
                history["scoreSha256"].add(score_hash)

    for values in history.values():
        values.discard("")
    return history


def build_template() -> dict[str, Any]:
    return {
        "auditId": "v2alpha-blind-001",
        "recordingId": "",
        "pieceId": "",
        "audioPath": "",
        "scorePath": "",
        "scoreDisplayPath": "",
        "cleanScoreReviewStatus": "approved",
        "cleanScoreReviewedBy": "",
        "consent": "yes",
        "licenseStatus": "local-only",
        "requireNewPiece": True,
        "notes": "",
    }


def audit_intake(
    manifest_path: Path,
    *,
    repo_root: Path = REPO_ROOT,
    audio_probe: Callable[[Path], dict[str, Any]] = probe_audio,
) -> dict[str, Any]:
    blockers: list[str] = []
    warnings: list[str] = []
    if not manifest_path.exists():
        return {
            "ok": False,
            "readyForMachinePrecheck": False,
            "manifest": relative_path(repo_root, manifest_path),
            "blockingReasons": ["fresh-blind-intake-manifest-missing"],
            "warnings": [],
            "nextAction": "Add one new violin recording, a clean reviewed MusicXML/MXL score, and a score image/PDF to the intake manifest.",
        }

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        manifest = {}
        blockers.append("fresh-blind-intake-manifest-invalid-json")

    recording_id = str(manifest.get("recordingId") or "").strip()
    piece_id = str(manifest.get("pieceId") or "").strip()
    audit_id = str(manifest.get("auditId") or "").strip()
    audio_path_value = str(manifest.get("audioPath") or "").strip()
    score_path_value = str(manifest.get("scorePath") or "").strip()
    score_display_path_value = str(manifest.get("scoreDisplayPath") or "").strip()
    audio_path = resolve_path(repo_root, audio_path_value) if audio_path_value else None
    score_path = resolve_path(repo_root, score_path_value) if score_path_value else None
    score_display_path = resolve_path(repo_root, score_display_path_value) if score_display_path_value else None
    require_new_piece = manifest.get("requireNewPiece") is not False

    for field_name, value in [
        ("audit-id", audit_id),
        ("recording-id", recording_id),
        ("piece-id", piece_id),
        ("audio-path", audio_path_value),
        ("score-path", score_path_value),
        ("score-display-path", score_display_path_value),
        ("clean-score-reviewed-by", str(manifest.get("cleanScoreReviewedBy") or "").strip()),
    ]:
        if not value:
            blockers.append(f"fresh-blind-{field_name}-missing")

    if str(manifest.get("cleanScoreReviewStatus") or "").strip().lower() != "approved":
        blockers.append("fresh-blind-clean-score-not-approved")
    if str(manifest.get("consent") or "").strip().lower() not in {"yes", "true", "1"}:
        blockers.append("fresh-blind-consent-missing")
    if not str(manifest.get("licenseStatus") or "").strip():
        blockers.append("fresh-blind-license-status-missing")
    if audio_path is not None and not audio_path.is_file():
        blockers.append("fresh-blind-audio-file-missing")
    if score_path is not None and not score_path.is_file():
        blockers.append("fresh-blind-score-file-missing")
    if score_display_path is not None and not score_display_path.is_file():
        blockers.append("fresh-blind-score-display-file-missing")

    history = collect_history(repo_root)
    if recording_id and recording_id in history["recordingIds"]:
        blockers.append("fresh-blind-recording-id-already-seen")
    if piece_id and piece_id in history["pieceIds"]:
        if require_new_piece:
            blockers.append("fresh-blind-piece-id-already-seen")
        else:
            warnings.append("fresh-blind-piece-id-already-seen")

    audio = {}
    audio_hashes = {}
    if audio_path is not None and audio_path.is_file():
        audio_hashes = {
            "sha1": file_hash(audio_path, "sha1"),
            "sha256": file_hash(audio_path, "sha256"),
        }
        if (
            audio_hashes["sha1"] in history["audioSha1"]
            or audio_hashes["sha256"] in history["audioSha256"]
        ):
            blockers.append("fresh-blind-audio-content-already-seen")
        try:
            audio = audio_probe(audio_path)
            if float(audio.get("durationSeconds") or 0.0) < 3.0:
                blockers.append("fresh-blind-audio-too-short")
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            blockers.append("fresh-blind-audio-probe-failed")

    score = {}
    score_hashes = {}
    if score_path is not None and score_path.is_file():
        score_hashes = {
            "sha1": file_hash(score_path, "sha1"),
            "sha256": file_hash(score_path, "sha256"),
        }
        try:
            score = inspect_musicxml(score_path)
            score_hashes["normalizedXmlSha256"] = score["normalizedXmlSha256"]
            score_seen = (
                score_hashes["sha1"] in history["scoreSha1"]
                or score_hashes["sha256"] in history["scoreSha256"]
                or score_hashes["normalizedXmlSha256"] in history["scoreXmlSha256"]
            )
            if score_seen:
                if require_new_piece:
                    blockers.append("fresh-blind-score-content-already-seen")
                else:
                    warnings.append("fresh-blind-score-content-already-seen")
            if int(score.get("measureCount") or 0) < 1:
                blockers.append("fresh-blind-score-has-no-measures")
            if score.get("violinPartResolved") is not True:
                blockers.append("fresh-blind-violin-part-not-resolved")
            if int(score.get("firstMeasurePitchedNoteCount") or 0) < 1:
                blockers.append("fresh-blind-first-measure-has-no-pitched-notes")
        except (ET.ParseError, OSError, ValueError, zipfile.BadZipFile):
            blockers.append("fresh-blind-score-parse-failed")

    unique_blockers = list(dict.fromkeys(blockers))
    ready = not unique_blockers
    return {
        "ok": ready,
        "readyForMachinePrecheck": ready,
        "manifest": relative_path(repo_root, manifest_path),
        "scope": {
            "name": "first-measure-only",
            "maxMeasureIndex": 1,
            "minConfidence": 0.95,
            "requireNewPiece": require_new_piece,
        },
        "candidate": {
            "auditId": audit_id,
            "recordingId": recording_id,
            "pieceId": piece_id,
            "audioPath": relative_path(repo_root, audio_path) if audio_path is not None else "",
            "scorePath": relative_path(repo_root, score_path) if score_path is not None else "",
            "scoreDisplayPath": relative_path(repo_root, score_display_path) if score_display_path is not None else "",
            "audio": audio,
            "audioHashes": audio_hashes,
            "score": score,
            "scoreHashes": score_hashes,
        },
        "historyCounts": {key: len(values) for key, values in history.items()},
        "blockingReasons": unique_blockers,
        "warnings": list(dict.fromkeys(warnings)),
        "nextAction": (
            "Stage this candidate into the controlled intake and run the ordinary machine precheck."
            if ready
            else "Resolve every blocking reason before staging or generating a professional-review pack."
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    candidate = report.get("candidate") or {}
    scope = report.get("scope") or {}
    blockers = report.get("blockingReasons") or []
    warnings = report.get("warnings") or []
    return "\n".join(
        [
            "# Western Strings Fresh Blind Intake Status",
            "",
            f"- readyForMachinePrecheck: {str(report.get('readyForMachinePrecheck', False)).lower()}",
            f"- recordingId: {candidate.get('recordingId', '')}",
            f"- pieceId: {candidate.get('pieceId', '')}",
            f"- scope: {scope.get('name', 'first-measure-only')}",
            f"- maxMeasureIndex: {scope.get('maxMeasureIndex', 1)}",
            f"- minConfidence: {scope.get('minConfidence', 0.95)}",
            "",
            "## Blocking Reasons",
            "",
            *([f"- {reason}" for reason in blockers] if blockers else ["- none"]),
            "",
            "## Warnings",
            "",
            *([f"- {reason}" for reason in warnings] if warnings else ["- none"]),
            "",
            "## Next Action",
            "",
            str(report.get("nextAction") or ""),
            "",
            "This command never enables the student runtime and never creates a professional-review pack.",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    parser.add_argument("--init", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    if args.init:
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        if not manifest_path.exists():
            manifest_path.write_text(json.dumps(build_template(), indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"ok": True, "created": str(manifest_path)}, indent=2))
        return 0

    report = audit_intake(manifest_path)
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report.get("readyForMachinePrecheck") else 2


if __name__ == "__main__":
    sys.exit(main())
