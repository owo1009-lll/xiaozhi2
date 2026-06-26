from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
GENERATOR = REPO / "scripts" / "experiments" / "create_western_strings_m2f_templates.py"
SKELETON = REPO / "scripts" / "experiments" / "create_western_strings_m2f_results_skeleton.py"
GATE = REPO / "scripts" / "experiments" / "eval_western_strings_m2f_real_recordings.py"
PACKAGE_JSON = REPO / "package.json"


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_rows(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="western-m2f-templates-") as tmp:
        out_dir = Path(tmp)
        subprocess.run(
            [sys.executable, str(GENERATOR), "--out-dir", str(out_dir)],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )

        manifest_template = out_dir / "real-student-recordings-manifest.template.csv"
        results_template = out_dir / "real-student-recording-results.template.csv"
        readme = out_dir / "README-m2f-real-student-templates.md"
        default_manifest = out_dir / "real-student-recordings-manifest.csv"
        default_results = out_dir / "real-student-recording-results.csv"

        assert_true(manifest_template.exists(), "manifest template was not created")
        assert_true(results_template.exists(), "results template was not created")
        assert_true(readme.exists(), "template README was not created")
        assert_true(not default_manifest.exists(), "generator must not create the default manifest")
        assert_true(not default_results.exists(), "generator must not create the default results file")
        readme_text = readme.read_text(encoding="utf-8")
        assert_true("western-strings-m2f-recording-checklist.md" in readme_text, "template README must link the recorder checklist")
        assert_true("correct, wrong_pitch, missing_note, rhythm_shift, weak_onset, and noisy" in readme_text, "template README must name all required gate scenarios")
        assert_true("npm run western:m2f-status" in readme_text, "template README must name the non-failing M2f status command")
        assert_true("npm run western:m2f-gate" in readme_text, "template README must name the release-blocking M2f gate command")

        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        scripts = package.get("scripts", {})
        status_gate = scripts.get("western:m2f-status", "")
        release_gate = scripts.get("western:m2f-gate", "")
        negative_test = scripts.get("test:western-m2f-real-recordings", "")
        assert_true(status_gate and "--fail-on-not-ready" not in status_gate, "western:m2f-status must be non-failing for inspection")
        assert_true(release_gate and "--fail-on-not-ready" in release_gate, "western:m2f-gate must fail when real pilot data is not release-ready")
        assert_true("--expect-negative" in negative_test, "test:western-m2f-real-recordings should remain the fail-closed regression command")

        manifest_columns, manifest_rows = read_rows(manifest_template)
        expected_manifest_columns = [
            "recordingId",
            "studentId",
            "instrument",
            "pieceId",
            "audioPath",
            "scorePath",
            "scoreId",
            "scenario",
            "humanChecked",
            "consent",
            "licenseStatus",
            "startSeconds",
            "endSeconds",
            "notes",
        ]
        assert_true(manifest_columns == expected_manifest_columns, "manifest template columns drifted")
        assert_true(len(manifest_rows) == 6, "manifest template must cover six gate scenarios")
        assert_true({row["scenario"] for row in manifest_rows} == {"correct", "wrong_pitch", "missing_note", "rhythm_shift", "weak_onset", "noisy"}, "scenario set drifted")
        assert_true(len({row["studentId"] for row in manifest_rows}) == 3, "template should model the minimum three anonymized students")
        assert_true(all(row["humanChecked"] == "yes" and row["consent"] == "yes" for row in manifest_rows), "template rows should make required consent/human-check columns visible")
        assert_true(all(row["licenseStatus"] == "local-only" for row in manifest_rows), "template should default to local-only licensing")

        result_columns, result_rows = read_rows(results_template)
        assert_true(result_columns == ["recordingId", "autoPassCount", "correctWithin300ms", "unsafeTargetAutoPassCount", "notes"], "results template columns drifted")
        assert_true([row["recordingId"] for row in result_rows] == [row["recordingId"] for row in manifest_rows], "results template recording ids must mirror manifest rows")

        filled_manifest = out_dir / "real-student-recordings-manifest.csv"
        skeleton_results = out_dir / "real-student-recording-results.csv"
        filled_manifest.write_text(manifest_template.read_text(encoding="utf-8"), encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                str(SKELETON),
                "--manifest",
                str(filled_manifest),
                "--results",
                str(skeleton_results),
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        skeleton_columns, skeleton_rows = read_rows(skeleton_results)
        assert_true(skeleton_columns == result_columns, "results skeleton columns drifted")
        assert_true([row["recordingId"] for row in skeleton_rows] == [row["recordingId"] for row in manifest_rows], "results skeleton recording ids must mirror the filled manifest")
        overwrite = subprocess.run(
            [
                sys.executable,
                str(SKELETON),
                "--manifest",
                str(filled_manifest),
                "--results",
                str(skeleton_results),
            ],
            cwd=REPO,
            text=True,
            capture_output=True,
        )
        assert_true(overwrite.returncode != 0 and "Refusing to overwrite" in (overwrite.stderr + overwrite.stdout), "results skeleton must not overwrite without --force")

        private_dir = out_dir / "private"
        private_dir.mkdir()
        audio_path = private_dir / "student.wav"
        score_path = private_dir / "score.musicxml"
        audio_path.write_bytes(b"fake-audio-path-for-gate-test")
        score_path.write_text("<score-partwise version=\"4.0\"></score-partwise>\n", encoding="utf-8")

        valid_manifest_rows = []
        for row in manifest_rows:
            updated = dict(row)
            updated["audioPath"] = str(audio_path)
            updated["scorePath"] = str(score_path)
            updated["scoreId"] = ""
            valid_manifest_rows.append(updated)
        write_rows(filled_manifest, manifest_columns, valid_manifest_rows)

        good_results = out_dir / "good-results.csv"
        good_result_rows = [
            {
                "recordingId": row["recordingId"],
                "autoPassCount": "10",
                "correctWithin300ms": "10",
                "unsafeTargetAutoPassCount": "0",
                "notes": "synthetic gate unit test row",
            }
            for row in valid_manifest_rows
        ]
        write_rows(good_results, result_columns, good_result_rows)
        positive_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(filled_manifest),
                "--results",
                str(good_results),
                "--out",
                str(out_dir / "positive-summary.json"),
                "--expect-positive",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("studentGateReady" in positive_gate.stdout and "true" in positive_gate.stdout.lower(), "valid matched M2f rows should pass the gate")

        unknown_results = out_dir / "unknown-results.csv"
        unknown_rows = [dict(row) for row in good_result_rows]
        unknown_rows[0]["recordingId"] = "not-in-manifest"
        write_rows(unknown_results, result_columns, unknown_rows)
        unknown_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(filled_manifest),
                "--results",
                str(unknown_results),
                "--out",
                str(out_dir / "unknown-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("results-unknown-recording-ids:not-in-manifest" in unknown_gate.stdout, "results with IDs outside the manifest must fail closed")

        duplicate_results = out_dir / "duplicate-results.csv"
        duplicate_rows = [dict(row) for row in good_result_rows]
        duplicate_rows[1]["recordingId"] = duplicate_rows[0]["recordingId"]
        write_rows(duplicate_results, result_columns, duplicate_rows)
        duplicate_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(filled_manifest),
                "--results",
                str(duplicate_results),
                "--out",
                str(out_dir / "duplicate-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("recordingId-duplicate" in duplicate_gate.stdout, "duplicate result recording IDs must fail closed")

        duplicate_manifest = out_dir / "duplicate-manifest.csv"
        duplicate_manifest_rows = [dict(row) for row in valid_manifest_rows]
        duplicate_manifest_rows[1]["recordingId"] = duplicate_manifest_rows[0]["recordingId"]
        write_rows(duplicate_manifest, manifest_columns, duplicate_manifest_rows)
        duplicate_manifest_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(duplicate_manifest),
                "--results",
                str(good_results),
                "--out",
                str(out_dir / "duplicate-manifest-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("recordingId-duplicate" in duplicate_manifest_gate.stdout, "duplicate manifest recording IDs must fail closed")

        missing_score_manifest = out_dir / "missing-score-manifest.csv"
        missing_score_rows = [dict(row) for row in valid_manifest_rows]
        missing_score_rows[0]["scorePath"] = ""
        missing_score_rows[0]["scoreId"] = "score-does-not-exist"
        write_rows(missing_score_manifest, manifest_columns, missing_score_rows)
        missing_score_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(missing_score_manifest),
                "--results",
                str(good_results),
                "--out",
                str(out_dir / "missing-score-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("scoreId-not-found" in missing_score_gate.stdout, "manifest rows with unresolved scoreId must fail closed")

        impossible_results = out_dir / "impossible-results.csv"
        impossible_rows = [dict(row) for row in good_result_rows]
        impossible_rows[0]["correctWithin300ms"] = "11"
        write_rows(impossible_results, result_columns, impossible_rows)
        impossible_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(filled_manifest),
                "--results",
                str(impossible_results),
                "--out",
                str(out_dir / "impossible-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("correctWithin300ms-greater-than-autoPassCount" in impossible_gate.stdout, "impossible correct/auto-pass counts must fail closed")

        invalid_count_results = out_dir / "invalid-count-results.csv"
        invalid_count_rows = [dict(row) for row in good_result_rows]
        invalid_count_rows[0]["autoPassCount"] = "10.5"
        invalid_count_rows[1]["unsafeTargetAutoPassCount"] = "-1"
        write_rows(invalid_count_results, result_columns, invalid_count_rows)
        invalid_count_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(filled_manifest),
                "--results",
                str(invalid_count_results),
                "--out",
                str(out_dir / "invalid-count-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("result-count-invalid" in invalid_count_gate.stdout, "non-integer or negative result counts must fail closed")

        gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(out_dir / "missing-manifest.csv"),
                "--results",
                str(out_dir / "missing-results.csv"),
                "--out",
                str(out_dir / "summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("studentGateReady" in gate.stdout and "false" in gate.stdout.lower(), "templates should not make the M2f gate ready")

    print(json.dumps({"ok": True, "checks": ["m2f-template-columns", "m2f-template-scenarios", "m2f-results-skeleton", "m2f-template-fail-closed"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
