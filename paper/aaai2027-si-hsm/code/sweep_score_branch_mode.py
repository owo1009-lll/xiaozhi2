from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--modes", default="always,conditional,none")
    args = p.parse_args()
    out = Path(args.out_dir)
    rows = []
    for mode in [x.strip() for x in args.modes.split(",") if x.strip()]:
        run_dir = out / mode
        subprocess.check_call([
            sys.executable, str(Path(__file__).with_name("run_score_quality_contrast.py")),
            "--manifest", args.manifest,
            "--out-dir", str(run_dir),
            "--contains", "良宵",
            "--subset", "piano_medium",
            "--score-weight", "0.4",
            "--reliability-gating",
            "--reliability-alpha", "4",
            "--score-branch-mode", mode,
        ])
        for row in csv.DictReader(open(run_dir / "score-quality-contrast.csv", encoding="utf-8")):
            row["scoreBranchMode"] = mode
            rows.append(row)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "score-branch-mode-sweep.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, sorted({k for row in rows for k in row}))
        writer.writeheader()
        writer.writerows(rows)
    lines = ["| Mode | Score | SI-SDR | SIR | SAR | Pitch@50c |", "|---|---|---:|---:|---:|---:|"]
    for row in rows:
        lines.append(f"| {row['scoreBranchMode']} | {row['score']} | {float(row['SI_SDR']):.3f} | {float(row['SIR']):.3f} | {float(row['SAR']):.3f} | {float(row['pitchAccuracy50c']):.3f} |")
    (out / "score-branch-mode-sweep.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "rows": len(rows), "summary": str(out / "score-branch-mode-sweep.csv")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
