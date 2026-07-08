from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


REPO = Path(__file__).resolve().parents[1]
GENERATOR = REPO / "scripts" / "experiments" / "create_western_strings_m2f_templates.py"
SKELETON = REPO / "scripts" / "experiments" / "create_western_strings_m2f_results_skeleton.py"
RESULT_REVIEW_PACK = REPO / "scripts" / "experiments" / "create_western_strings_m2f_results_review_pack.py"
INTAKE = REPO / "scripts" / "experiments" / "create_western_strings_m2f_clean_score_intake.py"
APPLY_CLEAN = REPO / "scripts" / "experiments" / "apply_western_strings_m2f_clean_scores.py"
REVIEW_PACK = REPO / "scripts" / "experiments" / "create_western_strings_m2f_score_review_pack.py"
AUDIVERIS_DRAFTS = REPO / "scripts" / "experiments" / "create_western_strings_m2f_audiveris_drafts.py"
STAGE_AUDIVERIS = REPO / "scripts" / "experiments" / "stage_western_strings_m2f_audiveris_drafts.py"
REVIEW_STATUS = REPO / "scripts" / "experiments" / "check_western_strings_m2f_clean_score_review.py"
GATE = REPO / "scripts" / "experiments" / "eval_western_strings_m2f_real_recordings.py"
MANIFEST_CHECK = REPO / "scripts" / "experiments" / "check_western_strings_m2f_manifest.py"
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
        assert_true("data/private/..." in readme_text, "template README must name private storage for repo-local student audio")
        assert_true("human/gold review" in readme_text, "template README must say results counts come from review")
        assert_true("npm run western:m2f-status" in readme_text, "template README must name the non-failing M2f status command")
        assert_true("npm run western:m2f-gate" in readme_text, "template README must name the release-blocking M2f gate command")

        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        scripts = package.get("scripts", {})
        manifest_status = scripts.get("western:m2f-manifest-status", "")
        status_gate = scripts.get("western:m2f-status", "")
        release_gate = scripts.get("western:m2f-gate", "")
        clean_score_intake = scripts.get("western:m2f-clean-score-intake", "")
        result_review_pack = scripts.get("western:m2f-results-review-pack", "")
        apply_clean_scores = scripts.get("western:m2f-apply-clean-scores", "")
        score_review_pack = scripts.get("western:m2f-score-review-pack", "")
        audiveris_drafts = scripts.get("western:m2f-audiveris-drafts", "")
        stage_audiveris_drafts = scripts.get("western:m2f-stage-audiveris-drafts", "")
        clean_score_review_status = scripts.get("western:m2f-clean-score-review-status", "")
        negative_test = scripts.get("test:western-m2f-real-recordings", "")
        assert_true(manifest_status and "check_western_strings_m2f_manifest.py" in manifest_status, "western:m2f-manifest-status must run the manifest-only readiness check")
        assert_true(status_gate and "--fail-on-not-ready" not in status_gate, "western:m2f-status must be non-failing for inspection")
        assert_true(release_gate and "--fail-on-not-ready" in release_gate, "western:m2f-gate must fail when real pilot data is not release-ready")
        assert_true(clean_score_intake and "create_western_strings_m2f_clean_score_intake.py" in clean_score_intake, "western:m2f-clean-score-intake must create the clean-score intake checklist")
        assert_true(result_review_pack and "create_western_strings_m2f_results_review_pack.py" in result_review_pack, "western:m2f-results-review-pack must create the real-student results review pack")
        assert_true(apply_clean_scores and "apply_western_strings_m2f_clean_scores.py" in apply_clean_scores, "western:m2f-apply-clean-scores must apply the clean-score intake checklist")
        assert_true(score_review_pack and "create_western_strings_m2f_score_review_pack.py" in score_review_pack, "western:m2f-score-review-pack must create the clean-score review pack")
        assert_true(audiveris_drafts and "create_western_strings_m2f_audiveris_drafts.py" in audiveris_drafts, "western:m2f-audiveris-drafts must create Audiveris draft MusicXML/MXL files")
        assert_true(stage_audiveris_drafts and "stage_western_strings_m2f_audiveris_drafts.py" in stage_audiveris_drafts, "western:m2f-stage-audiveris-drafts must stage draft MXL files as pending clean-score targets")
        assert_true(clean_score_review_status and "check_western_strings_m2f_clean_score_review.py" in clean_score_review_status, "western:m2f-clean-score-review-status must report pending clean-score review rows")
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

        manifest_check = subprocess.run(
            [
                sys.executable,
                str(MANIFEST_CHECK),
                "--manifest",
                str(filled_manifest),
                "--out",
                str(out_dir / "manifest-ready-summary.json"),
                "--expect-positive",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("manifestReady" in manifest_check.stdout and "true" in manifest_check.stdout.lower(), "valid manifest should pass the manifest-only readiness check")

        image_score_manifest = out_dir / "image-score-manifest.csv"
        image_score = private_dir / "score.jpg"
        Image.new("RGB", (64, 64), "white").save(image_score)
        image_score_rows = [dict(row) for row in valid_manifest_rows]
        image_score_rows[0]["scorePath"] = str(image_score)
        write_rows(image_score_manifest, manifest_columns, image_score_rows)
        image_score_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(image_score_manifest),
                "--results",
                str(out_dir / "missing-results-for-image-score.csv"),
                "--out",
                str(out_dir / "image-score-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("scorePath-not-clean-score" in image_score_gate.stdout, "M2f scorePath must be clean MusicXML/MIDI, not an image score")

        clean_score_intake = out_dir / "clean-score-intake.csv"
        intake_run = subprocess.run(
            [
                sys.executable,
                str(INTAKE),
                "--manifest",
                str(image_score_manifest),
                "--out",
                str(clean_score_intake),
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true('"needsCleanScore": 1' in intake_run.stdout, "clean-score intake must count image score rows as needing clean score")
        intake_columns, intake_rows = read_rows(clean_score_intake)
        assert_true("requiredCleanScorePath" in intake_columns, "clean-score intake must provide the expected clean-score path")
        assert_true("cleanScoreReviewStatus" in intake_columns, "clean-score intake must require an explicit human review status")
        assert_true(intake_rows[0]["currentScoreType"] == "image-or-unsupported", "clean-score intake must classify JPG/PNG scores")
        assert_true(intake_rows[0]["status"] == "needs-clean-score", "clean-score intake must block image scores")
        assert_true(intake_rows[0]["requiredCleanScorePath"].endswith(".musicxml"), "clean-score intake must request a clean MusicXML target path")
        assert_true(intake_rows[0]["cleanScoreReviewStatus"] == "", "clean-score intake must default review status to pending/blank")

        missing_apply = subprocess.run(
            [
                sys.executable,
                str(APPLY_CLEAN),
                "--manifest",
                str(image_score_manifest),
                "--intake",
                str(clean_score_intake),
                "--expect-not-ready",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("clean-score-not-reviewed" in missing_apply.stdout, "apply-clean-scores must fail closed until the clean score is explicitly approved")

        approved_missing_intake = out_dir / "approved-missing-clean-score-intake.csv"
        approved_missing_rows = [dict(row) for row in intake_rows]
        approved_missing_rows[0]["cleanScoreReviewStatus"] = "approved"
        write_rows(approved_missing_intake, intake_columns, approved_missing_rows)
        approved_missing_apply = subprocess.run(
            [
                sys.executable,
                str(APPLY_CLEAN),
                "--manifest",
                str(image_score_manifest),
                "--intake",
                str(approved_missing_intake),
                "--expect-not-ready",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("clean-score-missing" in approved_missing_apply.stdout, "apply-clean-scores must still require the approved clean score file to exist")

        ready_intake = out_dir / "ready-clean-score-intake.csv"
        ready_columns = intake_columns
        ready_rows = [dict(row) for row in intake_rows]
        replacement_score = private_dir / "replacement.musicxml"
        replacement_score.write_text("<score-partwise version=\"4.0\"><part-list/></score-partwise>\n", encoding="utf-8")
        ready_rows[0]["requiredCleanScorePath"] = str(replacement_score)
        ready_rows[0]["cleanScoreReviewStatus"] = "approved"
        ready_rows[0]["cleanScoreReviewedBy"] = "unit-test-reviewer"
        write_rows(ready_intake, ready_columns, ready_rows)
        applied_manifest = out_dir / "applied-manifest.csv"
        ready_apply = subprocess.run(
            [
                sys.executable,
                str(APPLY_CLEAN),
                "--manifest",
                str(image_score_manifest),
                "--intake",
                str(ready_intake),
                "--out",
                str(applied_manifest),
                "--apply",
                "--expect-ready",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true('"applyReady": true' in ready_apply.stdout, "apply-clean-scores must report ready when all clean scores exist")
        _applied_columns, applied_rows = read_rows(applied_manifest)
        assert_true(applied_rows[0]["scorePath"] == str(replacement_score), "apply-clean-scores must replace image scorePath with the clean score")
        assert_true(applied_rows[0]["scoreId"] == "", "apply-clean-scores must clear scoreId when using scorePath")

        review_pack_dir = out_dir / "score-review-pack"
        fake_audiveris_summary = out_dir / "audiveris-summary.json"
        fake_audiveris_summary.write_text(
            json.dumps(
                [
                    {
                        "recordingId": image_score_rows[0]["recordingId"],
                        "pieceId": image_score_rows[0]["pieceId"],
                        "mxl": str(private_dir / "draft.mxl"),
                        "parseOk": True,
                        "measures": 4,
                        "notes": 32,
                    }
                ]
            ),
            encoding="utf-8",
        )
        review_pack = subprocess.run(
            [
                sys.executable,
                str(REVIEW_PACK),
                "--manifest",
                str(image_score_manifest),
                "--intake",
                str(clean_score_intake),
                "--audiveris-summary",
                str(fake_audiveris_summary),
                "--out-dir",
                str(review_pack_dir),
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true('"rows": 6' in review_pack.stdout, "score review pack must report one row per manifest entry")
        assert_true((review_pack_dir / "index.html").exists(), "score review pack must create index.html")
        assert_true((review_pack_dir / "score-review.csv").exists(), "score review pack must create score-review.csv")
        assert_true((review_pack_dir / "README.md").exists(), "score review pack must create README.md")
        review_html = (review_pack_dir / "index.html").read_text(encoding="utf-8")
        assert_true("目标 clean score" in review_html and "score.jpg" in review_html, "score review HTML must show the image score and target clean score")
        assert_true("Audiveris 草稿" in review_html and "draft.mxl" in review_html, "score review HTML must show the Audiveris draft file when present")
        assert_true("小节:</b> 4" in review_html and "音符:</b> 32" in review_html, "score review HTML must show Audiveris draft parse stats")
        assert_true("<audio " in review_html and "controls" in review_html, "score review HTML must include audio playback")
        assert_true("判定类型" in review_html and "downloadCsvButton" in review_html, "score review HTML must include clickable review controls")

        audiveris_stub = out_dir / "fake-audiveris.py"
        audiveris_stub.write_text(
            "\n".join(
                [
                    "from pathlib import Path",
                    "import sys",
                    "args = sys.argv",
                    "out = Path(args[args.index('-output') + 1])",
                    "out.mkdir(parents=True, exist_ok=True)",
                    "(out / 'draft.mxl').write_text('<score-partwise version=\"4.0\"><part-list/></score-partwise>')",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        audiveris_manifest = out_dir / "audiveris-manifest.csv"
        audiveris_rows = [dict(row) for row in image_score_rows[:1]]
        write_rows(audiveris_manifest, manifest_columns, audiveris_rows)
        audiveris_out = out_dir / "audiveris-drafts"
        audiveris_run = subprocess.run(
            [
                sys.executable,
                str(AUDIVERIS_DRAFTS),
                "--manifest",
                str(audiveris_manifest),
                "--audiveris",
                str(audiveris_stub),
                "--out-dir",
                str(audiveris_out),
                "--limit",
                "1",
                "--expect-some",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true('"producedMxl": 1' in audiveris_run.stdout, "Audiveris draft wrapper must report produced MXL drafts")
        assert_true((audiveris_out / "audiveris-draft-musicxml-summary.json").exists(), "Audiveris draft wrapper must write a summary JSON")

        staged_intake = out_dir / "staged-clean-score-intake.csv"
        stage_run = subprocess.run(
            [
                sys.executable,
                str(STAGE_AUDIVERIS),
                "--intake",
                str(clean_score_intake),
                "--audiveris-summary",
                str(audiveris_out / "audiveris-draft-musicxml-summary.json"),
                "--target-dir",
                str(private_dir),
                "--out",
                str(staged_intake),
                "--apply",
                "--expect-staged",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true('"staged": 1' in stage_run.stdout, "stage-audiveris-drafts must stage the parseable MXL draft")
        _staged_columns, staged_rows = read_rows(staged_intake)
        assert_true(staged_rows[0]["requiredCleanScorePath"].endswith(".mxl"), "stage-audiveris-drafts must point requiredCleanScorePath at the staged MXL")
        assert_true(staged_rows[0]["cleanScoreReviewStatus"] == "", "stage-audiveris-drafts must not approve unchecked OMR drafts")
        assert_true(Path(staged_rows[0]["requiredCleanScorePath"]).exists(), "stage-audiveris-drafts must copy the MXL target file")
        staged_pending_status = subprocess.run(
            [
                sys.executable,
                str(REVIEW_STATUS),
                "--intake",
                str(staged_intake),
                "--out",
                str(out_dir / "staged-review-status.json"),
                "--expect-not-ready",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true('"pending": 6' in staged_pending_status.stdout, "clean-score review status must count staged but unapproved rows as pending")
        approved_staged_intake = out_dir / "approved-staged-clean-score-intake.csv"
        approved_staged_rows = [dict(row) for row in staged_rows]
        for row in approved_staged_rows:
            row["cleanScoreReviewStatus"] = "approved"
            row["cleanScoreReviewedBy"] = "unit-test-reviewer"
        write_rows(approved_staged_intake, _staged_columns, approved_staged_rows)
        staged_ready_status = subprocess.run(
            [
                sys.executable,
                str(REVIEW_STATUS),
                "--intake",
                str(approved_staged_intake),
                "--out",
                str(out_dir / "approved-staged-review-status.json"),
                "--expect-ready",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true('"approved": 6' in staged_ready_status.stdout, "clean-score review status must count approved rows")

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

        public_audio_manifest = out_dir / "public-audio-manifest.csv"
        public_audio_rows = [dict(row) for row in valid_manifest_rows]
        public_audio_rows[0]["audioPath"] = "package.json"
        write_rows(public_audio_manifest, manifest_columns, public_audio_rows)
        public_audio_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(public_audio_manifest),
                "--results",
                str(good_results),
                "--out",
                str(out_dir / "public-audio-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("audioPath-not-private" in public_audio_gate.stdout, "repo-local student audio must stay under data/private")

        audio_directory_manifest = out_dir / "audio-directory-manifest.csv"
        audio_directory_rows = [dict(row) for row in valid_manifest_rows]
        audio_directory_rows[0]["audioPath"] = str(private_dir)
        write_rows(audio_directory_manifest, manifest_columns, audio_directory_rows)
        audio_directory_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(audio_directory_manifest),
                "--results",
                str(good_results),
                "--out",
                str(out_dir / "audio-directory-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("audioPath-not-file" in audio_directory_gate.stdout, "audioPath must point to a file, not a directory")

        public_score_manifest = out_dir / "public-score-manifest.csv"
        public_score_rows = [dict(row) for row in valid_manifest_rows]
        public_score_rows[0]["scorePath"] = "package.json"
        public_score_rows[0]["licenseStatus"] = "local-only"
        write_rows(public_score_manifest, manifest_columns, public_score_rows)
        public_score_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(public_score_manifest),
                "--results",
                str(good_results),
                "--out",
                str(out_dir / "public-score-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("scorePath-not-private" in public_score_gate.stdout, "repo-local local-only scorePath must stay under data/private")

        score_directory_manifest = out_dir / "score-directory-manifest.csv"
        score_directory_rows = [dict(row) for row in valid_manifest_rows]
        score_directory_rows[0]["scorePath"] = str(private_dir)
        write_rows(score_directory_manifest, manifest_columns, score_directory_rows)
        score_directory_gate = subprocess.run(
            [
                sys.executable,
                str(GATE),
                "--manifest",
                str(score_directory_manifest),
                "--results",
                str(good_results),
                "--out",
                str(out_dir / "score-directory-summary.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("scorePath-not-file" in score_directory_gate.stdout, "scorePath must point to a file, not a directory")

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

        missing_manifest_check = subprocess.run(
            [
                sys.executable,
                str(MANIFEST_CHECK),
                "--manifest",
                str(out_dir / "missing-manifest.csv"),
                "--out",
                str(out_dir / "missing-manifest-readiness.json"),
                "--expect-negative",
            ],
            cwd=REPO,
            check=True,
            text=True,
            capture_output=True,
        )
        assert_true("manifestReady" in missing_manifest_check.stdout and "false" in missing_manifest_check.stdout.lower(), "missing manifest should fail the manifest-only readiness check")

    print(json.dumps({"ok": True, "checks": ["m2f-template-columns", "m2f-template-scenarios", "m2f-results-skeleton", "m2f-template-fail-closed"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
