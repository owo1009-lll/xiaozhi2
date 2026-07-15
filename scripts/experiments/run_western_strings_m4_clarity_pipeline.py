#!/usr/bin/env python3
"""Run Clarity's PDF pipeline with an explicit Stage-A inference device.

Clarity's Stage-A wrapper does not expose Ultralytics' ``device`` argument.
This compatibility runner keeps the isolated third-party checkout unchanged:
YOLO can run on CPU while Stage-B transcription still uses CUDA.
"""
from __future__ import annotations

import argparse
import runpy
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--clarity-repo", required=True)
    parser.add_argument("--stage-a-device", default="cpu")
    args, forwarded = parser.parse_known_args(argv)

    clarity_repo = Path(args.clarity_repo).resolve()
    pipeline = clarity_repo / "src" / "pdf_to_musicxml.py"
    if not pipeline.is_file():
        raise SystemExit(f"Clarity pipeline not found: {pipeline}")

    if args.stage_a_device:
        from ultralytics import YOLO

        original_predict = YOLO.predict

        def predict_on_selected_device(self, *predict_args, **predict_kwargs):
            predict_kwargs.setdefault("device", args.stage_a_device)
            return original_predict(self, *predict_args, **predict_kwargs)

        YOLO.predict = predict_on_selected_device

    sys.path.insert(0, str(clarity_repo))
    sys.argv = [str(pipeline), *forwarded]
    runpy.run_path(str(pipeline), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
