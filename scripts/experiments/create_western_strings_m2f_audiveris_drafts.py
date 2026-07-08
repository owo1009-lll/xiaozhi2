from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from PIL import Image

from eval_western_strings_m2f_real_recordings import DEFAULT_MANIFEST
from eval_western_strings_m2f_real_recordings import REPO
from eval_western_strings_m2f_real_recordings import read_csv
from eval_western_strings_m2f_real_recordings import repo_path


DEFAULT_AUDIVERIS = REPO / "data" / "tools" / "audiveris" / "extracted" / "Audiveris" / "Audiveris.exe"
DEFAULT_OUT_DIR = REPO / "data" / "experiments" / "western-strings-m2" / "audiveris-draft"
SUMMARY_NAME = "audiveris-draft-musicxml-summary.json"


def preprocess_image(src: Path, out: Path, scale: int) -> dict[str, Any]:
    out.parent.mkdir(parents=True, exist_ok=True)
    img = Image.open(src).convert("RGB")
    resized = img.resize((img.width * scale, img.height * scale), Image.Resampling.LANCZOS)
    resized.save(out, dpi=(300, 300))
    return {
        "sourceSize": [img.width, img.height],
        "preparedSize": [resized.width, resized.height],
        "preparedPixels": resized.width * resized.height,
    }


def parse_mxl_stats(mxl: Path) -> dict[str, Any]:
    try:
        if zipfile.is_zipfile(mxl):
            with zipfile.ZipFile(mxl) as archive:
                xml_members = [
                    name
                    for name in archive.namelist()
                    if name.lower().endswith((".xml", ".musicxml")) and not name.startswith("META-INF/")
                ]
                if not xml_members:
                    return {"parseOk": False, "measures": 0, "notes": 0, "parseError": "no-musicxml-member"}
                payload = archive.read(sorted(xml_members)[0])
        else:
            payload = mxl.read_bytes()

        root = ET.fromstring(payload)

        def local_name(tag: str) -> str:
            return tag.rsplit("}", 1)[-1]

        measures = 0
        notes = 0
        for element in root.iter():
            name = local_name(str(element.tag))
            if name == "measure":
                measures += 1
            elif name == "note":
                notes += 1
        return {"parseOk": True, "measures": measures, "notes": notes, "parseError": ""}
    except Exception as exc:  # pragma: no cover - keeps batch summaries robust
        return {"parseOk": False, "measures": 0, "notes": 0, "parseError": f"{type(exc).__name__}: {str(exc)[:160]}"}


def run_audiveris(audiveris: Path, prepared_image: Path, out_dir: Path) -> tuple[int, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    executable = [sys.executable, str(audiveris)] if audiveris.suffix.lower() == ".py" else [str(audiveris)]
    completed = subprocess.run(
        executable
        + [
            "-batch",
            "-transcribe",
            "-export",
            "-output",
            str(out_dir),
            str(prepared_image),
        ],
        cwd=REPO,
        text=True,
        capture_output=True,
    )
    log_text = (completed.stdout or "") + (completed.stderr or "")
    (out_dir / "audiveris.log").write_text(log_text, encoding="utf-8", errors="replace")
    return completed.returncode, log_text


def build_rows(manifest_path: Path) -> list[dict[str, str]]:
    rows, _columns = read_csv(manifest_path)
    return rows


def first_mxl(out_dir: Path) -> Path | None:
    mxls = sorted(out_dir.rglob("*.mxl"))
    return mxls[0] if mxls else None


def main() -> int:
    parser = argparse.ArgumentParser(description="Create Audiveris MusicXML/MXL drafts for M2f score images.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--audiveris", default=str(DEFAULT_AUDIVERIS))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--scale", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0, help="optional max rows to process")
    parser.add_argument("--force", action="store_true", help="rerun rows even when an MXL draft already exists")
    parser.add_argument("--expect-some", action="store_true", help="fail if no draft MXL files are produced")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    audiveris = Path(args.audiveris)
    out_dir = Path(args.out_dir)
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")
    if not audiveris.exists():
        raise SystemExit(f"Audiveris executable not found: {audiveris}")

    manifest_rows = build_rows(manifest_path)
    if args.limit > 0:
        manifest_rows = manifest_rows[: args.limit]

    summaries: list[dict[str, Any]] = []
    for row in manifest_rows:
        recording_id = row.get("recordingId", "").strip()
        piece_id = row.get("pieceId", "").strip() or recording_id
        score_path = row.get("scorePath", "").strip() or row.get("scoreSourcePath", "").strip()
        source_image = repo_path(score_path)
        row_dir = out_dir / piece_id
        audiveris_dir = out_dir / f"{piece_id}-audiveris"
        prepared_image = row_dir / f"{piece_id}-score-up{args.scale}x.png"
        summary: dict[str, Any] = {
            "recordingId": recording_id,
            "pieceId": piece_id,
            "sourceScorePath": score_path,
            "preparedImage": str(prepared_image),
            "audiverisOutputDir": str(audiveris_dir),
            "returnCode": None,
            "mxl": "",
            "parseOk": False,
            "measures": 0,
            "notes": 0,
            "error": "",
        }
        if not source_image.exists() or not source_image.is_file():
            summary["error"] = "source-score-image-missing"
            summaries.append(summary)
            continue
        existing_mxl = first_mxl(audiveris_dir)
        if existing_mxl and not args.force:
            stats = parse_mxl_stats(existing_mxl)
            summary.update({"returnCode": 0, "mxl": str(existing_mxl), **stats})
            summaries.append(summary)
            continue
        try:
            image_stats = preprocess_image(source_image, prepared_image, int(args.scale))
            summary.update(image_stats)
            return_code, log_text = run_audiveris(audiveris, prepared_image, audiveris_dir)
            mxl = first_mxl(audiveris_dir)
            summary["returnCode"] = return_code
            summary["hasRhythmWarning"] = any(marker in log_text for marker in ["no correct rhythm", "No timeOffset"])
            if mxl:
                stats = parse_mxl_stats(mxl)
                summary.update({"mxl": str(mxl), **stats})
            else:
                summary["error"] = "no-mxl"
        except Exception as exc:  # pragma: no cover - batch report should continue
            summary["error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
        summaries.append(summary)

    out_dir.mkdir(parents=True, exist_ok=True)
    summary_path = out_dir / SUMMARY_NAME
    summary_path.write_text(json.dumps(summaries, indent=2, ensure_ascii=False), encoding="utf-8")
    produced = sum(1 for item in summaries if item.get("mxl"))
    result = {
        "ok": True,
        "summary": str(summary_path),
        "rows": len(summaries),
        "producedMxl": produced,
        "parseOk": sum(1 for item in summaries if item.get("parseOk")),
        "failed": [item["pieceId"] for item in summaries if not item.get("mxl")],
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if args.expect_some and produced == 0:
        raise SystemExit("Expected at least one Audiveris draft MXL, but none were produced.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
