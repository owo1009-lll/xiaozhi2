from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import shutil
import struct
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from audit_western_fresh_blind_intake import collect_history, inspect_musicxml, probe_audio


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = REPO / "音频" / "round2-谱子"
DEFAULT_PRIVATE_ROOT = REPO / "data" / "private" / "western-strings-round2"
DEFAULT_REPORT = REPO / "data" / "experiments" / "western-strings-round2-input-status.json"
DEFAULT_MARKDOWN = REPO / "data" / "experiments" / "western-strings-round2-input-status.md"

ROUND2_ROWS = [
    (1, "r2-d-major-steps", "correct", "D major stepwise etude"),
    (2, "r2-g-major-wrong-pitch", "wrong_pitch", "G major wrong-pitch etude"),
    (3, "r2-a-minor-missing-note", "missing_note", "A minor missing-note etude"),
    (4, "r2-c-major-rhythm-shift", "rhythm_shift", "C major dotted-rhythm etude"),
    (5, "r2-g-major-slide", "slide", "G major slide etude"),
    (6, "r2-d-major-trill-vibrato", "trill_vibrato", "D major trill and vibrato etude"),
    (7, "r2-d-major-double-stop", "double_stop", "D major double-stop etude"),
    (8, "r2-f-major-fresh-blind", "fresh_blind_correct", "F major fresh-blind air"),
]

README_SCENARIO_COUNTS = {
    2: 5,
    3: 5,
    4: 4,
}

MANIFEST_FIELDS = [
    "recordingId",
    "pieceId",
    "scenario",
    "title",
    "audioPath",
    "scorePath",
    "scoreDisplayPath",
    "scoreId",
    "expectedMeasureCount",
    "expectedPitchedNoteCount",
    "expectedIssueCount",
    "consent",
    "licenseStatus",
    "sourceRound",
]
INTAKE_FIELDS = [
    "recordingId",
    "pieceId",
    "currentScorePath",
    "currentScoreType",
    "requiredCleanScorePath",
    "scoreId",
    "cleanScoreReviewStatus",
    "cleanScoreReviewedBy",
    "cleanScoreReviewNotes",
    "status",
]


def rel(repo_root: Path, target: Path) -> str:
    try:
        return target.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return str(target.resolve())


def hash_file(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_csv_by_id(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return {
            str(row.get("recordingId") or "").strip(): row
            for row in csv.DictReader(handle)
            if str(row.get("recordingId") or "").strip()
        }


def write_csv(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def find_audio(source_root: Path, index: int) -> Path | None:
    stems = [f"r2-{index:02d}", str(index)]
    extensions = [".m4a", ".wav", ".flac", ".mp3", ".aac", ".ogg"]
    for stem in stems:
        for extension in extensions:
            candidate = source_root / f"{stem}{extension}"
            if candidate.is_file():
                return candidate
    return None


def inspect_png(path: Path) -> dict[str, Any]:
    header = path.read_bytes()[:24]
    signature_ok = header.startswith(b"\x89PNG\r\n\x1a\n")
    width = height = 0
    if signature_ok and len(header) >= 24:
        width, height = struct.unpack(">II", header[16:24])
    return {
        "signatureOk": signature_ok,
        "width": width,
        "height": height,
    }


def copy_atomic(source: Path, target: Path, *, replace: bool) -> str:
    source_hash = hash_file(source)
    if target.exists():
        if hash_file(target) == source_hash:
            return "unchanged"
        if not replace:
            raise FileExistsError(f"target-content-conflict:{target}")
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        shutil.copy2(target, target.with_name(f"{target.name}.bak-{stamp}"))
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    shutil.copy2(source, temporary)
    temporary.replace(target)
    return "copied"


def parse_readme_scenario_counts(path: Path) -> dict[int, int]:
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8-sig")
    counts: dict[int, int] = {}
    for line in text.splitlines():
        match = re.search(r"\|\s*r2-(0[234])\s*\|", line, flags=re.IGNORECASE)
        if not match:
            continue
        count_match = re.search(r"(?:故意\s*)?(\d+)\s*(?:个音|处)", line)
        if count_match:
            counts[int(match.group(1))] = int(count_match.group(1))
    return counts


def empty_history() -> dict[str, set[str]]:
    return {
        "recordingIds": set(),
        "pieceIds": set(),
        "scoreIds": set(),
        "audioSha1": set(),
        "audioSha256": set(),
        "scoreSha1": set(),
        "scoreSha256": set(),
        "scoreXmlSha256": set(),
    }


def prepare_round2(
    *,
    repo_root: Path,
    source_root: Path,
    private_root: Path,
    apply: bool = False,
    replace: bool = False,
    audio_probe: Callable[[Path], dict[str, Any]] = probe_audio,
    history: dict[str, set[str]] | None = None,
) -> dict[str, Any]:
    blockers: list[str] = []
    warnings: list[str] = []
    items: list[dict[str, Any]] = []
    if not source_root.is_dir():
        blockers.append("round2-source-directory-missing")

    history = history if history is not None else collect_history(repo_root)
    seen_audio_hashes: set[str] = set()
    seen_score_hashes: set[str] = set()
    existing_manifest = read_csv_by_id(private_root / "manifest.csv")
    existing_intake = read_csv_by_id(private_root / "clean-score-intake.csv")

    for index, piece_id, scenario, title in ROUND2_ROWS:
        recording_id = f"round2-r2-{index:02d}-20260715"
        source_audio = find_audio(source_root, index) if source_root.is_dir() else None
        source_score = source_root / f"r2-{index:02d}.musicxml"
        source_display = source_root / f"r2-{index:02d}.png"
        target_audio = private_root / f"r2-{index:02d}{source_audio.suffix.lower() if source_audio else '.m4a'}"
        target_score = private_root / f"r2-{index:02d}.musicxml"
        target_display = private_root / f"r2-{index:02d}.png"
        item_blockers: list[str] = []
        if source_audio is None:
            item_blockers.append("audio-missing")
        if not source_score.is_file():
            item_blockers.append("score-missing")
        if not source_display.is_file():
            item_blockers.append("score-display-missing")

        audio = {}
        score = {}
        display = {}
        hashes: dict[str, str] = {}
        if source_audio is not None:
            try:
                audio = audio_probe(source_audio)
                hashes["audioSha1"] = hash_file(source_audio, "sha1")
                hashes["audioSha256"] = hash_file(source_audio, "sha256")
                if float(audio.get("durationSeconds") or 0) < 3.0:
                    item_blockers.append("audio-too-short")
                if float(audio.get("durationSeconds") or 0) > 120.0:
                    warnings.append(f"round2-audio-long:{recording_id}")
                if hashes["audioSha256"] in seen_audio_hashes:
                    item_blockers.append("audio-duplicate-within-round")
                seen_audio_hashes.add(hashes["audioSha256"])
                if hashes["audioSha1"] in history["audioSha1"] or hashes["audioSha256"] in history["audioSha256"]:
                    item_blockers.append("audio-content-already-seen")
            except Exception as error:  # noqa: BLE001 - surfaced as a stable intake reason
                item_blockers.append("audio-probe-failed")
                audio = {"error": f"{type(error).__name__}:{error}"}

        if source_score.is_file():
            try:
                score = inspect_musicxml(source_score)
                hashes["scoreSha1"] = hash_file(source_score, "sha1")
                hashes["scoreSha256"] = hash_file(source_score, "sha256")
                hashes["scoreXmlSha256"] = str(score.get("normalizedXmlSha256") or "")
                if not score.get("violinPartResolved"):
                    item_blockers.append("violin-part-not-resolved")
                if int(score.get("measureCount") or 0) < 1:
                    item_blockers.append("score-has-no-measures")
                if int(score.get("firstMeasurePitchedNoteCount") or 0) < 1:
                    item_blockers.append("first-measure-has-no-pitched-notes")
                if hashes["scoreXmlSha256"] in seen_score_hashes:
                    item_blockers.append("score-duplicate-within-round")
                seen_score_hashes.add(hashes["scoreXmlSha256"])
                if (
                    hashes["scoreSha1"] in history["scoreSha1"]
                    or hashes["scoreSha256"] in history["scoreSha256"]
                    or hashes["scoreXmlSha256"] in history["scoreXmlSha256"]
                ):
                    item_blockers.append("score-content-already-seen")
            except Exception as error:  # noqa: BLE001 - surfaced as a stable intake reason
                item_blockers.append("score-parse-failed")
                score = {"error": f"{type(error).__name__}:{error}"}

        if source_display.is_file():
            try:
                display = inspect_png(source_display)
                hashes["displaySha256"] = hash_file(source_display)
                if not display["signatureOk"]:
                    item_blockers.append("score-display-signature-invalid")
                if int(display["width"]) < 1000 or int(display["height"]) < 1000:
                    item_blockers.append("score-display-resolution-too-low")
            except OSError as error:
                item_blockers.append("score-display-read-failed")
                display = {"error": f"{type(error).__name__}:{error}"}

        if recording_id in history["recordingIds"]:
            item_blockers.append("recording-id-already-seen")
        if piece_id in history["pieceIds"]:
            item_blockers.append("piece-id-already-seen")

        existing_row = existing_manifest.get(recording_id, {})
        idempotent_existing_pair = bool(
            existing_row
            and source_audio is not None
            and target_audio.is_file()
            and target_score.is_file()
            and target_display.is_file()
            and hash_file(target_audio) == hashes.get("audioSha256")
            and hash_file(target_score) == hashes.get("scoreSha256")
            and hash_file(target_display) == hashes.get("displaySha256")
            and str(existing_row.get("pieceId") or "").strip() == piece_id
        )
        if idempotent_existing_pair:
            item_blockers = [
                reason
                for reason in item_blockers
                if reason not in {
                    "audio-content-already-seen",
                    "score-content-already-seen",
                    "recording-id-already-seen",
                    "piece-id-already-seen",
                }
            ]
        item = {
            "index": index,
            "recordingId": recording_id,
            "pieceId": piece_id,
            "scenario": scenario,
            "title": title,
            "source": {
                "audio": rel(repo_root, source_audio) if source_audio else "",
                "score": rel(repo_root, source_score),
                "scoreDisplay": rel(repo_root, source_display),
            },
            "target": {
                "audio": rel(repo_root, target_audio),
                "score": rel(repo_root, target_score),
                "scoreDisplay": rel(repo_root, target_display),
            },
            "audio": audio,
            "score": score,
            "scoreDisplay": display,
            "hashes": hashes,
            "blockingReasons": list(dict.fromkeys(item_blockers)),
        }
        items.append(item)
        blockers.extend(f"{recording_id}:{reason}" for reason in item["blockingReasons"])

    readme_source = source_root / "README-怎么用.md"
    readme_counts = parse_readme_scenario_counts(readme_source)
    readme_counts_valid = all(readme_counts.get(index) == expected for index, expected in README_SCENARIO_COUNTS.items())
    if not readme_source.is_file():
        warnings.append("round2-scenario-count-ground-truth-readme-missing")
    elif not readme_counts_valid:
        warnings.append("round2-scenario-count-ground-truth-incomplete:r2-02|r2-03|r2-04")

    notes_source = source_root / "notes.txt"
    if not notes_source.is_file():
        warnings.append("round2-error-location-ground-truth-missing:r2-02|r2-03|r2-04")

    ready_for_machine = not blockers and len(items) == len(ROUND2_ROWS)
    applied = False
    copy_results: list[dict[str, str]] = []
    if apply and ready_for_machine:
        for item in items:
            for key in ["audio", "score", "scoreDisplay"]:
                source_path = repo_root / item["source"][key]
                target_path = repo_root / item["target"][key]
                copy_results.append({
                    "recordingId": item["recordingId"],
                    "kind": key,
                    "result": copy_atomic(source_path, target_path, replace=replace),
                })
        if notes_source.is_file():
            copy_results.append({
                "recordingId": "round2",
                "kind": "notes",
                "result": copy_atomic(notes_source, private_root / "notes.txt", replace=replace),
            })
        if readme_source.is_file():
            copy_results.append({
                "recordingId": "round2",
                "kind": "scenario-count-readme",
                "result": copy_atomic(readme_source, private_root / "README-source.md", replace=replace),
            })

        manifest_rows = []
        intake_rows = []
        for item in items:
            recording_id = item["recordingId"]
            old_score_id = str(
                existing_manifest.get(recording_id, {}).get("scoreId")
                or existing_intake.get(recording_id, {}).get("scoreId")
                or ""
            ).strip()
            manifest_rows.append({
                "recordingId": recording_id,
                "pieceId": item["pieceId"],
                "scenario": item["scenario"],
                "title": item["title"],
                "audioPath": item["target"]["audio"],
                "scorePath": item["target"]["score"],
                "scoreDisplayPath": item["target"]["scoreDisplay"],
                "scoreId": old_score_id,
                "expectedMeasureCount": int((item.get("score") or {}).get("measureCount") or 0),
                "expectedPitchedNoteCount": int((item.get("score") or {}).get("pitchedNoteCount") or 0),
                "expectedIssueCount": int(readme_counts.get(int(item["index"]), 0)),
                "consent": "yes",
                "licenseStatus": "local-only",
                "sourceRound": "round2",
            })
            intake_rows.append({
                "recordingId": recording_id,
                "pieceId": item["pieceId"],
                "currentScorePath": item["target"]["score"],
                "currentScoreType": "musicxml-generated-gold",
                "requiredCleanScorePath": item["target"]["score"],
                "scoreId": old_score_id,
                "cleanScoreReviewStatus": "approved",
                "cleanScoreReviewedBy": "deterministic-round2-generator",
                "cleanScoreReviewNotes": (
                    "MusicXML and PNG were generated together from the deterministic "
                    "round-2 etude source; this is generated gold, not OMR output."
                ),
                "status": "ready",
            })
        write_csv(private_root / "manifest.csv", MANIFEST_FIELDS, manifest_rows)
        write_csv(private_root / "clean-score-intake.csv", INTAKE_FIELDS, intake_rows)
        applied = True

    ready_for_scenario_count_evaluation = ready_for_machine and readme_counts_valid
    ready_for_labeled_m3 = ready_for_machine and notes_source.is_file()
    return {
        "ok": ready_for_machine,
        "generatedAt": datetime.now().astimezone().isoformat(),
        "sourceRoot": rel(repo_root, source_root),
        "privateRoot": rel(repo_root, private_root),
        "applyRequested": apply,
        "applied": applied,
        "summary": {
            "expectedPairCount": len(ROUND2_ROWS),
            "validatedPairCount": sum(1 for item in items if not item["blockingReasons"]),
            "readyForMachineAnalysis": ready_for_machine,
            "readyForScenarioCountEvaluation": ready_for_scenario_count_evaluation,
            "readyForLabeledM3Evaluation": ready_for_labeled_m3,
            "scenarioCountGroundTruthPresent": readme_counts_valid,
            "scenarioExpectedIssueCounts": {f"r2-{index:02d}": count for index, count in sorted(readme_counts.items())},
            "notesGroundTruthPresent": notes_source.is_file(),
        },
        "blockingReasons": list(dict.fromkeys(blockers)),
        "warnings": list(dict.fromkeys(warnings)),
        "items": items,
        "copyResults": copy_results,
        "artifacts": {
            "manifest": rel(repo_root, private_root / "manifest.csv") if applied else "",
            "cleanScoreIntake": rel(repo_root, private_root / "clean-score-intake.csv") if applied else "",
        },
    }


def render_markdown(report: dict[str, Any]) -> str:
    summary = report.get("summary") or {}
    lines = [
        "# Western Strings Round 2 Input Status",
        "",
        f"- validated pairs: {summary.get('validatedPairCount', 0)}/{summary.get('expectedPairCount', 8)}",
        f"- readyForMachineAnalysis: {str(summary.get('readyForMachineAnalysis', False)).lower()}",
        f"- readyForScenarioCountEvaluation: {str(summary.get('readyForScenarioCountEvaluation', False)).lower()}",
        f"- readyForLabeledM3Evaluation: {str(summary.get('readyForLabeledM3Evaluation', False)).lower()}",
        f"- scenarioCountGroundTruthPresent: {str(summary.get('scenarioCountGroundTruthPresent', False)).lower()}",
        f"- notesGroundTruthPresent: {str(summary.get('notesGroundTruthPresent', False)).lower()}",
        f"- applied: {str(report.get('applied', False)).lower()}",
        "",
        "## Inputs",
        "",
        "| recording | scenario | duration | measures | notes | status |",
        "|---|---|---:|---:|---:|---|",
    ]
    for item in report.get("items") or []:
        lines.append(
            "| {recording} | {scenario} | {duration} | {measures} | {notes} | {status} |".format(
                recording=item.get("recordingId", ""),
                scenario=item.get("scenario", ""),
                duration=(item.get("audio") or {}).get("durationSeconds", ""),
                measures=(item.get("score") or {}).get("measureCount", ""),
                notes=(item.get("score") or {}).get("pitchedNoteCount", ""),
                status="ok" if not item.get("blockingReasons") else ", ".join(item["blockingReasons"]),
            )
        )
    lines.extend(["", "## Blocking Reasons", ""])
    blockers = report.get("blockingReasons") or []
    lines.extend([f"- {reason}" for reason in blockers] if blockers else ["- none"])
    lines.extend(["", "## Warnings", ""])
    warnings = report.get("warnings") or []
    lines.extend([f"- {reason}" for reason in warnings] if warnings else ["- none"])
    lines.extend([
        "",
        "README scenario counts support count-level evaluation (r2-02=5, r2-03=5, r2-04=4). Exact M3 recall/precision must remain pending until notes.txt supplies the deliberately changed measure locations.",
        "",
    ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit and stage the eight Western Strings round-2 recording pairs.")
    parser.add_argument("--repo-root", type=Path, default=REPO)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--private-root", type=Path, default=DEFAULT_PRIVATE_ROOT)
    parser.add_argument("--out", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--markdown", type=Path, default=DEFAULT_MARKDOWN)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    source_root = args.source if args.source.is_absolute() else repo_root / args.source
    private_root = args.private_root if args.private_root.is_absolute() else repo_root / args.private_root
    report = prepare_round2(
        repo_root=repo_root,
        source_root=source_root.resolve(),
        private_root=private_root.resolve(),
        apply=args.apply,
        replace=args.replace,
    )
    out_path = args.out if args.out.is_absolute() else repo_root / args.out
    markdown_path = args.markdown if args.markdown.is_absolute() else repo_root / args.markdown
    out_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({
        "ok": report["ok"],
        "applied": report["applied"],
        "summary": report["summary"],
        "blockingReasons": report["blockingReasons"],
        "warnings": report["warnings"],
        "artifacts": report["artifacts"],
        "report": rel(repo_root, out_path),
        "markdown": rel(repo_root, markdown_path),
    }, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
