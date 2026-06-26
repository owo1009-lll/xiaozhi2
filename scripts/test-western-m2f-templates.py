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
        assert_true("npm run western:m2f-gate" in readme_text, "template README must use the neutral M2f gate command for real data")

        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        scripts = package.get("scripts", {})
        neutral_gate = scripts.get("western:m2f-gate", "")
        negative_test = scripts.get("test:western-m2f-real-recordings", "")
        assert_true(neutral_gate and "--expect-negative" not in neutral_gate, "western:m2f-gate must be neutral for real pilot data")
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
