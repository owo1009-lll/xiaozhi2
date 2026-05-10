from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path


def mean(xs):
    vals = [float(x) for x in xs if x not in ("", None)]
    return sum(vals) / len(vals) if vals else None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--results", required=True)
    p.add_argument("--out-dir", required=True)
    args = p.parse_args()
    rows = list(csv.DictReader(open(args.results, encoding="utf-8")))
    groups = defaultdict(list)
    for row in rows:
        groups[(row.get("subset", ""), row.get("method", ""))].append(row)
    lines = ["| Subset | Method | SI-SDR | SDR | SIR | SAR | Pitch@50c |", "|---|---:|---:|---:|---:|---:|---:|"]
    for (subset, method), vals in sorted(groups.items()):
        cells = [mean([v.get(k) for v in vals]) for k in ("SI_SDR", "SDR", "SIR", "SAR", "pitchAccuracy50c")]
        lines.append("| " + " | ".join([subset, method] + ["" if v is None else f"{v:.3f}" for v in cells]) + " |")
    out = Path(args.out_dir) / "table-main-results.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
