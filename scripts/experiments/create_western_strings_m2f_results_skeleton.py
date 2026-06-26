from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recordings-manifest.csv"
DEFAULT_RESULTS = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recording-results.csv"
RESULT_COLUMNS = ["recordingId", "autoPassCount", "correctWithin300ms", "unsafeTargetAutoPassCount", "notes"]


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if "recordingId" not in (reader.fieldnames or []):
            raise SystemExit("Manifest must include a recordingId column.")
        return list(reader)


def write_results(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=RESULT_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create an M2f results skeleton from a filled real-student recording manifest.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--results", default=str(DEFAULT_RESULTS))
    parser.add_argument("--force", action="store_true", help="overwrite the results file if it already exists")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    results_path = Path(args.results)
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")
    if results_path.exists() and not args.force:
        raise SystemExit(f"Refusing to overwrite existing results file: {results_path}. Pass --force to overwrite.")

    manifest_rows = read_manifest(manifest_path)
    seen: set[str] = set()
    rows: list[dict[str, str]] = []
    duplicate_ids: list[str] = []
    for manifest_row in manifest_rows:
        recording_id = (manifest_row.get("recordingId") or "").strip()
        if not recording_id:
            continue
        if recording_id in seen:
            duplicate_ids.append(recording_id)
            continue
        seen.add(recording_id)
        scenario = (manifest_row.get("scenario") or "").strip()
        rows.append(
            {
                "recordingId": recording_id,
                "autoPassCount": "",
                "correctWithin300ms": "",
                "unsafeTargetAutoPassCount": "",
                "notes": f"Fill after studentSafe analysis; manifest scenario={scenario}",
            }
        )

    if duplicate_ids:
        raise SystemExit("Duplicate recordingId values in manifest: " + "|".join(duplicate_ids[:20]))
    if not rows:
        raise SystemExit("Manifest has no non-empty recordingId values.")

    write_results(results_path, rows)
    print(
        json.dumps(
            {
                "ok": True,
                "manifest": str(manifest_path),
                "results": str(results_path),
                "rows": len(rows),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
