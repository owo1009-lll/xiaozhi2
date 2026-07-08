from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
CREATE = REPO / "scripts" / "experiments" / "create_western_strings_m3_diagnosis_results_skeleton.py"
EVAL = REPO / "scripts" / "experiments" / "eval_western_strings_m3_diagnosis.py"
PACK = REPO / "scripts" / "experiments" / "create_western_strings_m3_diagnosis_review_pack.py"
CATEGORIES = ["pitch", "onset", "duration", "missing", "extra"]


def write_rows(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def run_json(args: list[str], *, expect: int = 0) -> dict:
    proc = subprocess.run([sys.executable, *args], cwd=REPO, text=True, capture_output=True)
    if proc.returncode != expect:
        raise AssertionError(f"expected exit {expect}, got {proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return json.loads(proc.stdout)


def manifest_columns() -> list[str]:
    return ["recordingId", "studentId", "instrument", "pieceId", "audioPath", "scorePath", "scoreId", "scenario", "humanChecked", "consent", "licenseStatus", "startSeconds", "endSeconds", "notes"]


def result_columns() -> list[str]:
    columns = ["recordingId", "scenario", "autoPassEvaluatedCount"]
    for category in CATEGORIES:
        columns.extend([f"{category}AutoIssueCount", f"{category}CorrectIssueCount", f"{category}UnsafeIssueCount"])
    columns.append("notes")
    return columns


def valid_result_row(recording_id: str, scenario: str = "correct") -> dict[str, str]:
    row = {column: "0" for column in result_columns()}
    row["recordingId"] = recording_id
    row["scenario"] = scenario
    row["autoPassEvaluatedCount"] = "10"
    row["notes"] = "test row"
    for category in CATEGORIES:
        row[f"{category}AutoIssueCount"] = "1"
        row[f"{category}CorrectIssueCount"] = "1"
        row[f"{category}UnsafeIssueCount"] = "0"
    return row


def core_only_result_row(recording_id: str, scenario: str = "correct") -> dict[str, str]:
    row = {column: "0" for column in result_columns()}
    row["recordingId"] = recording_id
    row["scenario"] = scenario
    row["autoPassEvaluatedCount"] = "10"
    row["notes"] = "core categories only"
    for category in ["pitch", "onset", "missing"]:
        row[f"{category}AutoIssueCount"] = "1"
        row[f"{category}CorrectIssueCount"] = "1"
        row[f"{category}UnsafeIssueCount"] = "0"
    return row


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="western-m3-diagnosis-") as temp:
        root = Path(temp)
        manifest = root / "manifest.csv"
        results = root / "results.csv"
        previews = root / "previews.json"
        skeleton = root / "skeleton.csv"
        summary = root / "summary.json"

        write_rows(manifest, manifest_columns(), [
            {"recordingId": "r1", "studentId": "s1", "instrument": "violin", "pieceId": "p1", "audioPath": "a.wav", "scorePath": "s.mxl", "scoreId": "", "scenario": "correct", "humanChecked": "yes", "consent": "yes", "licenseStatus": "local-only", "startSeconds": "0", "endSeconds": "10", "notes": ""},
            {"recordingId": "r2", "studentId": "s2", "instrument": "violin", "pieceId": "p2", "audioPath": "b.wav", "scorePath": "t.mxl", "scoreId": "", "scenario": "wrong_pitch", "humanChecked": "yes", "consent": "yes", "licenseStatus": "local-only", "startSeconds": "0", "endSeconds": "10", "notes": ""},
        ])
        write_rows(root / "m2f.csv", ["recordingId", "autoPassCount", "correctWithin300ms", "unsafeTargetAutoPassCount", "notes"], [
            {"recordingId": "r1", "autoPassCount": "7", "correctWithin300ms": "7", "unsafeTargetAutoPassCount": "0", "notes": ""},
            {"recordingId": "r2", "autoPassCount": "5", "correctWithin300ms": "5", "unsafeTargetAutoPassCount": "0", "notes": ""},
        ])
        previews.write_text(json.dumps({"recordings": [{"recordingId": "r1", "autoPassCount": 99}]}), encoding="utf-8")

        created = run_json([str(CREATE), "--manifest", str(manifest), "--m2f-results", str(root / "m2f.csv"), "--previews", str(previews), "--out", str(skeleton)])
        assert created["ok"] is True and created["rows"] == 2
        with skeleton.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        assert rows[0]["autoPassEvaluatedCount"] == "7", "skeleton should prefer reviewed M2f counts"

        missing = run_json([str(EVAL), "--manifest", str(manifest), "--results", str(root / "missing.csv"), "--out", str(summary)], expect=0)
        assert missing["diagnosisGateReady"] is False
        assert "results-missing-or-empty" in missing["blockingReasons"]
        failed = subprocess.run([sys.executable, str(EVAL), "--manifest", str(manifest), "--results", str(root / "missing.csv"), "--out", str(summary), "--fail-on-not-ready"], cwd=REPO)
        assert failed.returncode == 1

        write_rows(results, result_columns(), [valid_result_row("r1"), valid_result_row("r2", "wrong_pitch")])
        ready = run_json([str(EVAL), "--manifest", str(manifest), "--results", str(results), "--out", str(summary), "--fail-on-not-ready"])
        assert ready["diagnosisGateReady"] is True
        assert all(item["precision"] == 1.0 for item in ready["categories"].values())

        write_rows(results, result_columns(), [core_only_result_row("r1"), core_only_result_row("r2", "wrong_pitch")])
        core_ready = run_json([str(EVAL), "--manifest", str(manifest), "--results", str(results), "--out", str(summary), "--fail-on-not-ready"])
        assert core_ready["diagnosisGateReady"] is True
        assert core_ready["gate"]["requiredCategories"] == ["pitch", "onset", "missing"]
        assert core_ready["categories"]["duration"]["status"] == "review_only"
        all_required = subprocess.run([sys.executable, str(EVAL), "--manifest", str(manifest), "--results", str(results), "--out", str(summary), "--required-categories", "all", "--fail-on-not-ready"], cwd=REPO, text=True, capture_output=True)
        assert all_required.returncode == 1
        assert "duration-insufficient-auto-issues" in all_required.stdout
        assert "extra-insufficient-auto-issues" in all_required.stdout

        preview_root = root / "m2f-pack"
        (preview_root / "audio").mkdir(parents=True)
        (preview_root / "score-images").mkdir(parents=True)
        (preview_root / "audio" / "r1.mp3").write_bytes(b"fake-audio")
        (preview_root / "score-images" / "r1.jpg").write_bytes(b"fake-image")
        preview_json = preview_root / "recording-previews.json"
        preview_json.write_text(json.dumps({
            "ok": True,
            "recordings": [{
                "recordingId": "r1",
                "studentId": "s1",
                "pieceId": "p1",
                "scenario": "wrong_pitch",
                "audioRel": "audio/r1.mp3",
                "scoreImageRel": "score-images/r1.jpg",
                "noteCount": 2,
                "autoPassCount": 1,
                "coverage": 0.5,
                "previewRows": [{
                    "noteIndex": 0,
                    "measure": 1,
                    "midi": 69,
                    "expectedSeconds": 1.0,
                    "nearestEventStart": 1.01,
                    "supportMs": 10,
                    "pitchDiff": 0,
                    "autoDecision": "auto_pass",
                    "isAutoPass": True,
                }],
            }],
        }), encoding="utf-8")
        review_out = root / "m3-review-pack"
        built = run_json([str(PACK), "--previews", str(preview_json), "--results", str(results), "--out", str(review_out)])
        assert built["ok"] is True and built["recordingCount"] == 1
        html = (review_out / "index.html").read_text(encoding="utf-8")
        assert "M3 基础诊断复核包" in html
        assert "pack-data" in html and "markAllFilledCorrect" in html
        assert (review_out / "audio" / "r1.mp3").exists()
        assert (review_out / "score-images" / "r1.jpg").exists()
        with (review_out / "real-student-diagnosis-results.preview.csv").open("r", encoding="utf-8-sig", newline="") as handle:
            review_rows = list(csv.DictReader(handle))
        assert review_rows[0]["recordingId"] == "r1"
        assert "pitchAutoIssueCount" in review_rows[0]

        bad_row = valid_result_row("r1")
        bad_row["pitchCorrectIssueCount"] = "0"
        write_rows(results, result_columns(), [bad_row, valid_result_row("r2")])
        not_ready = run_json([str(EVAL), "--manifest", str(manifest), "--results", str(results), "--out", str(summary)])
        assert not_ready["diagnosisGateReady"] is False
        assert "pitch-precision-below-threshold" in not_ready["blockingReasons"]

    print(json.dumps({"ok": True, "checks": ["m3-skeleton", "m3-fail-closed", "m3-ready", "m3-core-only", "m3-all-categories-strict", "m3-review-pack", "m3-low-precision"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
