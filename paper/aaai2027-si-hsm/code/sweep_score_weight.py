from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from metrics import evaluate
from run_manifest import _path
from sihsm_extract import Config, extract_file


def mean(xs):
    vals = [float(x) for x in xs if x is not None]
    return sum(vals) / len(vals) if vals else None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--subset", default="piano_medium")
    p.add_argument("--weights", default="0,0.1,0.2,0.4,0.6,0.8,1.0")
    args = p.parse_args()
    manifest = Path(args.manifest)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    weights = [float(x) for x in args.weights.split(",") if x.strip()]
    rows = []
    for item in [x for x in data["items"] if x.get("subset") == args.subset]:
        mix, score = _path(manifest.parent, item, "mixturePath"), _path(manifest.parent, item, "scorePath")
        target, accomp = _path(manifest.parent, item, "targetPath"), _path(manifest.parent, item, "accompanimentPath")
        mix_metrics = evaluate(mix, target, accomp, item["instrument"])
        for weight in weights:
            out = Path(args.out_dir) / item["itemId"] / f"score_weight_{weight:g}"
            cfg = Config(trace_stride=64, score_weight=weight)
            est = extract_file(mix, score, out, item["instrument"], "full", item.get("targetPart"), cfg)["outputPath"]
            metrics = evaluate(est, target, accomp, item["instrument"])
            rows.append({"itemId": item["itemId"], "subset": item["subset"], "scoreWeight": weight, "mixtureSI_SDR": mix_metrics["SI_SDR"], **metrics})
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "score-weight-sweep.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, sorted({k for row in rows for k in row}))
        writer.writeheader()
        writer.writerows(rows)
    summary = []
    for weight in weights:
        group = [r for r in rows if r["scoreWeight"] == weight]
        summary.append({"scoreWeight": weight, "n": len(group), "mixtureSI_SDR": mean(r["mixtureSI_SDR"] for r in group), "SI_SDR": mean(r["SI_SDR"] for r in group), "SIR": mean(r["SIR"] for r in group), "SAR": mean(r["SAR"] for r in group), "pitchAccuracy50c": mean(r["pitchAccuracy50c"] for r in group)})
    with (out_dir / "score-weight-summary.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, summary[0].keys())
        writer.writeheader()
        writer.writerows(summary)
    lines = ["| Score weight | SI-SDR | SIR | SAR | Pitch@50c |", "|---:|---:|---:|---:|---:|"]
    for row in summary:
        lines.append(f"| {row['scoreWeight']:g} | {row['SI_SDR']:.3f} | {row['SIR']:.3f} | {row['SAR']:.3f} | {row['pitchAccuracy50c']:.3f} |")
    (out_dir / "score-weight-summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "rows": len(rows), "summary": str(out_dir / "score-weight-summary.csv")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
