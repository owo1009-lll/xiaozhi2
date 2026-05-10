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
    p.add_argument("--alphas", default="0,0.5,1,2,4")
    p.add_argument("--score-weight", default="0.4")
    args = p.parse_args()
    out = Path(args.out_dir)
    rows = []
    for alpha in [x.strip() for x in args.alphas.split(",") if x.strip()]:
        run_dir = out / f"alpha_{alpha.replace('.', '_')}"
        cmd = [
            sys.executable,
            str(Path(__file__).with_name("run_score_quality_contrast.py")),
            "--manifest", args.manifest,
            "--out-dir", str(run_dir),
            "--contains", "良宵",
            "--subset", "piano_medium",
            "--score-weight", args.score_weight,
            "--reliability-gating",
            "--reliability-alpha", alpha,
        ]
        subprocess.check_call(cmd)
        for row in csv.DictReader(open(run_dir / "score-quality-contrast.csv", encoding="utf-8")):
            row["alpha"] = alpha
            rows.append(row)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "reliability-alpha-sweep.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, sorted({k for row in rows for k in row}))
        writer.writeheader()
        writer.writerows(rows)
    lines = ["| Alpha | Score | SI-SDR | SIR | SAR | Pitch@50c |", "|---:|---|---:|---:|---:|---:|"]
    for row in rows:
        lines.append(f"| {row['alpha']} | {row['score']} | {float(row['SI_SDR']):.3f} | {float(row['SIR']):.3f} | {float(row['SAR']):.3f} | {float(row['pitchAccuracy50c']):.3f} |")
    (out / "reliability-alpha-sweep.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "rows": len(rows), "summary": str(out / "reliability-alpha-sweep.csv")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
