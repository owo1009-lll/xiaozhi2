from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO / "data" / "experiments" / "western-strings-m2"

MANIFEST_COLUMNS = [
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

RESULT_COLUMNS = [
    "recordingId",
    "autoPassCount",
    "correctWithin300ms",
    "unsafeTargetAutoPassCount",
    "notes",
]

SCENARIOS = ["correct", "wrong_pitch", "missing_note", "rhythm_shift", "weak_onset", "noisy"]


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def build_manifest_rows() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for index, scenario in enumerate(SCENARIOS, start=1):
        rows.append(
            {
                "recordingId": f"stu{index:02d}-{scenario}",
                "studentId": f"stu{((index - 1) % 3) + 1:02d}",
                "instrument": "violin",
                "pieceId": "piece-or-score-id",
                "audioPath": f"data/private/western-strings-m2/stu{index:02d}-{scenario}.wav",
                "scorePath": "data/private/western-strings-m2/score.musicxml",
                "scoreId": "",
                "scenario": scenario,
                "humanChecked": "yes",
                "consent": "yes",
                "licenseStatus": "local-only",
                "startSeconds": "0",
                "endSeconds": "45",
                "notes": "Replace paths and timing before copying to the default manifest.",
            }
        )
    return rows


def build_result_rows() -> list[dict[str, str]]:
    return [
        {
            "recordingId": row["recordingId"],
            "autoPassCount": "",
            "correctWithin300ms": "",
            "unsafeTargetAutoPassCount": "",
            "notes": "Fill after running the studentSafe alignment gate on the real recording.",
        }
        for row in build_manifest_rows()
    ]


def write_readme(out_dir: Path, manifest_path: Path, results_path: Path) -> None:
    readme = out_dir / "README-m2f-real-student-templates.md"
    readme.write_text(
        "\n".join(
            [
                "# Western Strings M2f Real-Student Recording Templates",
                "",
                "These files are templates only. They are intentionally named `*.template.csv`",
                "so `npm run test:western-m2f-real-recordings` will continue to fail closed",
                "until real manifest/results files are copied to the default paths.",
                "",
                "Before filling the CSV files, read the recorder checklist:",
                "`docs/western-strings-m2f-recording-checklist.md`.",
                "",
                "1. Copy the manifest template to `real-student-recordings-manifest.csv`.",
                "2. Record or select at least six real/student-like violin recordings covering",
                "   correct, wrong_pitch, missing_note, rhythm_shift, weak_onset, and noisy.",
                "3. Replace every placeholder path with a real local audio/score path.",
                "4. Keep `consent=yes`, `humanChecked=yes`, and a valid `licenseStatus` only",
                "   when the recording is actually cleared for local research use.",
                "5. Run the studentSafe gate, then fill `real-student-recording-results.csv`.",
                "6. Run `npm run test:western-m2f-real-recordings`.",
                "",
                f"Manifest template: `{manifest_path.name}`",
                f"Results template: `{results_path.name}`",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Create western-strings M2f real-student recording CSV templates.")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--force", action="store_true", help="overwrite existing template files")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    manifest_path = out_dir / "real-student-recordings-manifest.template.csv"
    results_path = out_dir / "real-student-recording-results.template.csv"
    for path in [manifest_path, results_path]:
        if path.exists() and not args.force:
            raise SystemExit(f"Refusing to overwrite existing template: {path}. Pass --force to overwrite.")

    write_csv(manifest_path, MANIFEST_COLUMNS, build_manifest_rows())
    write_csv(results_path, RESULT_COLUMNS, build_result_rows())
    write_readme(out_dir, manifest_path, results_path)
    print(
        json.dumps(
            {
                "ok": True,
                "manifestTemplate": str(manifest_path),
                "resultsTemplate": str(results_path),
                "scenarios": SCENARIOS,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
