from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from audit_western_fresh_blind_intake import (  # noqa: E402
    collect_history,
    file_hash,
    inspect_musicxml,
    normalized_xml_hash,
    probe_audio,
    read_musicxml_bytes,
    relative_path,
)


DEFAULT_DATASET_ROOT = REPO_ROOT / "音频" / "Bach独奏小提琴数据集"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.md"
KNOWN_LICENSES = {"PD", "CC BY", "CC BY-NC", "CC BY-NC-ND"}
REFERENCE_DEVELOPMENT_PERFORMER = "Emil Telmányi"


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def resolve_indexed_file(dataset_root: Path, value: str, *, score: bool = False) -> tuple[Path, str]:
    relative = Path(str(value or "").strip())
    direct = dataset_root / relative
    if direct.is_file():
        return direct, "dataset-root"
    if score:
        nested = dataset_root / "bach-violin-dataset" / relative
        if nested.is_file():
            return nested, "bach-violin-dataset-root"
    return direct, "missing"


def license_class(value: str) -> str:
    normalized = str(value or "").strip().upper()
    if normalized == "PD":
        return "public-domain"
    if normalized == "CC BY":
        return "attribution-required"
    if normalized == "CC BY-NC":
        return "noncommercial-attribution-required"
    if normalized == "CC BY-NC-ND":
        return "noncommercial-no-derivatives"
    return "unknown"


def audit_dataset(
    dataset_root: Path,
    *,
    repo_root: Path = REPO_ROOT,
    audio_probe: Callable[[Path], dict[str, Any]] = probe_audio,
) -> dict[str, Any]:
    index_path = dataset_root / "bach-violin-index.csv"
    gold_path = dataset_root / "bach-violin-gold-notes.csv"
    blockers: list[str] = []
    if not index_path.is_file():
        blockers.append("bach-violin-index-missing")
    if not gold_path.is_file():
        blockers.append("bach-violin-reference-notes-missing")
    if blockers:
        return {
            "ok": False,
            "readyForEvalBenchmark": False,
            "datasetRoot": relative_path(repo_root, dataset_root),
            "blockingReasons": blockers,
            "rows": [],
        }

    index_rows = read_csv_rows(index_path)
    gold_rows = read_csv_rows(gold_path)
    gold_counts: Counter[str] = Counter()
    double_stop_counts: Counter[str] = Counter()
    for row in gold_rows:
        piece_id = str(row.get("pieceId") or "").strip()
        gold_counts[piece_id] += 1
        if str(row.get("doubleStop") or "").strip().lower() == "true":
            double_stop_counts[piece_id] += 1

    history = collect_history(repo_root)
    score_cache: dict[Path, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    issue_counts: Counter[str] = Counter()
    license_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    seen_units: set[str] = set()

    for source in index_rows:
        unit = str(source.get("unit") or "").strip()
        piece_id = f"bach-violin:{unit}" if unit else ""
        audio_path, audio_resolution = resolve_indexed_file(dataset_root, source.get("audioClip", ""))
        score_path, score_resolution = resolve_indexed_file(dataset_root, source.get("score", ""), score=True)
        issues: list[str] = []
        if not unit:
            issues.append("unit-missing")
        elif unit in seen_units:
            issues.append("unit-duplicate")
        seen_units.add(unit)
        if not audio_path.is_file():
            issues.append("audio-file-missing")
        if not score_path.is_file():
            issues.append("score-file-missing")

        license_value = str(source.get("license") or "").strip()
        source_value = str(source.get("source") or "").strip()
        license_counts[license_value or "missing"] += 1
        source_counts[source_value or "missing"] += 1
        if license_value not in KNOWN_LICENSES:
            issues.append("license-unknown")

        audio_info: dict[str, Any] = {}
        audio_hashes: dict[str, str] = {}
        if audio_path.is_file():
            audio_hashes = {
                "sha1": file_hash(audio_path, "sha1"),
                "sha256": file_hash(audio_path, "sha256"),
            }
            if audio_hashes["sha1"] in history["audioSha1"] or audio_hashes["sha256"] in history["audioSha256"]:
                issues.append("audio-content-already-in-project-history")
            try:
                audio_info = audio_probe(audio_path)
                if float(audio_info.get("durationSeconds") or 0.0) < 3.0:
                    issues.append("audio-too-short")
            except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
                issues.append("audio-probe-failed")

        score_info: dict[str, Any] = {}
        score_hashes: dict[str, str] = {}
        if score_path.is_file():
            if score_path not in score_cache:
                try:
                    xml_bytes = read_musicxml_bytes(score_path)
                    score_cache[score_path] = {
                        "ok": True,
                        "info": inspect_musicxml(score_path),
                        "hashes": {
                            "sha1": file_hash(score_path, "sha1"),
                            "sha256": file_hash(score_path, "sha256"),
                            "normalizedXmlSha256": normalized_xml_hash(xml_bytes),
                        },
                    }
                except Exception as exc:  # The row records the exact parse failure below.
                    score_cache[score_path] = {"ok": False, "error": f"{type(exc).__name__}:{exc}"}
            cached = score_cache[score_path]
            if cached.get("ok"):
                score_info = dict(cached["info"])
                score_hashes = dict(cached["hashes"])
                if score_info.get("violinPartResolved") is not True:
                    issues.append("violin-part-not-resolved")
                if int(score_info.get("firstMeasurePitchedNoteCount") or 0) < 1:
                    issues.append("first-measure-has-no-pitched-notes")
                if (
                    score_hashes["sha1"] in history["scoreSha1"]
                    or score_hashes["sha256"] in history["scoreSha256"]
                    or score_hashes["normalizedXmlSha256"] in history["scoreXmlSha256"]
                ):
                    issues.append("score-content-already-in-project-history")
            else:
                issues.append("score-parse-failed")

        reference_note_count = gold_counts.get(piece_id, 0)
        if reference_note_count < 1:
            issues.append("reference-alignment-missing")
        unique_issues = list(dict.fromkeys(issues))
        issue_counts.update(unique_issues)
        eval_ready = not any(
            issue in unique_issues
            for issue in (
                "unit-missing",
                "unit-duplicate",
                "audio-file-missing",
                "score-file-missing",
                "audio-too-short",
                "audio-probe-failed",
                "score-parse-failed",
                "violin-part-not-resolved",
                "first-measure-has-no-pitched-notes",
                "reference-alignment-missing",
            )
        )
        rows.append(
            {
                "unit": unit,
                "pieceId": piece_id,
                "violinist": str(source.get("violinist") or "").strip(),
                "benchmarkSplit": (
                    "development-reference-performer"
                    if str(source.get("violinist") or "").strip() == REFERENCE_DEVELOPMENT_PERFORMER
                    else "holdout-unseen-performer"
                ),
                "performerFold": str(source.get("violinist") or "").strip(),
                "work": str(source.get("work") or "").strip(),
                "workFold": str(source.get("work") or "").strip(),
                "movement": str(source.get("movement") or "").strip(),
                "source": source_value,
                "license": license_value,
                "licenseClass": license_class(license_value),
                "sourceUrl": str(source.get("url") or "").strip(),
                "audioPath": relative_path(repo_root, audio_path),
                "audioPathResolution": audio_resolution,
                "scorePath": relative_path(repo_root, score_path),
                "scorePathResolution": score_resolution,
                "audio": audio_info,
                "audioHashes": audio_hashes,
                "score": score_info,
                "scoreHashes": score_hashes,
                "referenceNoteCount": reference_note_count,
                "referenceDoubleStopNoteCount": double_stop_counts.get(piece_id, 0),
                "referenceAlignmentType": "estimated-cqt-dtw-not-human-gold",
                "readyForEvalBenchmark": eval_ready,
                "freshStudentBlindEligible": False,
                "freshStudentBlindReason": "professional-public-recording-and-estimated-alignment",
                "issues": unique_issues,
            }
        )

    ready_rows = [row for row in rows if row["readyForEvalBenchmark"]]
    public_domain_rows = [row for row in ready_rows if row["license"] == "PD"]
    development_rows = [row for row in ready_rows if row["benchmarkSplit"] == "development-reference-performer"]
    holdout_rows = [row for row in ready_rows if row["benchmarkSplit"] == "holdout-unseen-performer"]
    report = {
        "ok": len(ready_rows) > 0,
        "readyForEvalBenchmark": len(ready_rows) > 0,
        "freshStudentBlindEligible": False,
        "datasetRoot": relative_path(repo_root, dataset_root),
        "provenance": {
            "dataset": "Bach Violin Dataset",
            "recordingDomain": "professional-public-performance",
            "referenceAlignmentType": "estimated-cqt-dtw-not-human-gold",
            "policy": "external development and stress-test corpus; never relabel estimated alignments as human gold",
        },
        "datasetRoles": {
            "externalDevelopmentBenchmark": True,
            "crossPerformerCalibration": True,
            "crossWorkCalibration": True,
            "studentErrorReleaseEvidence": False,
            "humanNoteOnsetGold": False,
        },
        "evaluationProtocols": [
            {
                "name": "leave-one-performer-out",
                "groupField": "violinist",
                "purpose": "measure transfer to unseen performers without random note leakage",
            },
            {
                "name": "leave-one-work-out",
                "groupField": "work",
                "purpose": "measure transfer to unseen Bach works without score leakage",
            },
        ],
        "counts": {
            "indexRows": len(index_rows),
            "uniqueUnits": len(seen_units),
            "violinists": len({row["violinist"] for row in rows if row["violinist"]}),
            "works": len({row["work"] for row in rows if row["work"]}),
            "referenceNotes": len(gold_rows),
            "referencePieces": len(gold_counts),
            "referenceDoubleStopNotes": sum(double_stop_counts.values()),
            "readyForEvalBenchmarkRows": len(ready_rows),
            "publicDomainEvalRows": len(public_domain_rows),
            "freshStudentBlindRows": 0,
            "developmentReferencePerformerRows": len(development_rows),
            "holdoutUnseenPerformerRows": len(holdout_rows),
        },
        "licenseCounts": dict(sorted(license_counts.items())),
        "sourceCounts": dict(sorted(source_counts.items())),
        "issueCounts": dict(sorted(issue_counts.items())),
        "blockingReasons": [] if ready_rows else ["bach-violin-no-eval-ready-rows"],
        "nextAction": (
            "Run all 65 eval-ready movements as the formal external development/stress-test corpus. "
            "Report leave-one-performer-out and leave-one-work-out results separately. "
            "Do not use estimated CQT-DTW timestamps as human gold or claim student-error robustness from this corpus."
        ),
        "rows": rows,
    }
    return report


def render_markdown(report: dict[str, Any]) -> str:
    counts = report.get("counts") or {}
    issue_counts = report.get("issueCounts") or {}
    return "\n".join(
        [
            "# Western Strings Bach Violin Dataset Audit",
            "",
            f"- readyForEvalBenchmark: {str(report.get('readyForEvalBenchmark', False)).lower()}",
            f"- freshStudentBlindEligible: {str(report.get('freshStudentBlindEligible', False)).lower()}",
            f"- indexed units: {counts.get('indexRows', 0)}",
            f"- eval-ready units: {counts.get('readyForEvalBenchmarkRows', 0)}",
            f"- public-domain eval units: {counts.get('publicDomainEvalRows', 0)}",
            f"- violinists: {counts.get('violinists', 0)}",
            f"- works: {counts.get('works', 0)}",
            f"- reference notes: {counts.get('referenceNotes', 0)}",
            f"- development reference-performer rows: {counts.get('developmentReferencePerformerRows', 0)}",
            f"- holdout unseen-performer rows: {counts.get('holdoutUnseenPerformerRows', 0)}",
            "",
            "## Evidence Boundary",
            "",
            "These are professional public performances. Their note times are estimated CQT-DTW alignments, not human note-level gold.",
            "Use all eval-ready movements for external development and stress testing, with performer/work group isolation.",
            "They do not provide human note-onset gold and cannot establish student-error robustness by themselves.",
            "",
            "## Issues",
            "",
            *([f"- {key}: {value}" for key, value in issue_counts.items()] if issue_counts else ["- none"]),
            "",
            "## Next Action",
            "",
            str(report.get("nextAction") or ""),
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit the local Bach Violin Dataset before evaluation.")
    parser.add_argument("--dataset-root", default=str(DEFAULT_DATASET_ROOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = audit_dataset(Path(args.dataset_root).resolve())
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in ("ok", "readyForEvalBenchmark", "freshStudentBlindEligible", "counts", "licenseCounts", "issueCounts", "blockingReasons", "nextAction")}, ensure_ascii=False, indent=2))
    return 0 if report.get("readyForEvalBenchmark") else 2


if __name__ == "__main__":
    raise SystemExit(main())
