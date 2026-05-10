from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from metrics import evaluate
from run_manifest import _path
from sihsm_extract import Config, extract_file


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--contains", default="")
    p.add_argument("--subset", default="piano_medium")
    p.add_argument("--bandwidths", default="24,32,38,48")
    p.add_argument("--residuals", default="0.01,0.03,0.05")
    p.add_argument("--score-branch-mode", default="conditional", choices=["always", "conditional", "none"])
    p.add_argument("--detector-policy", default="raw", choices=["posterior", "raw"])
    args = p.parse_args()
    manifest = Path(args.manifest)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    item = next(x for x in data["items"] if (not args.contains or args.contains in x["itemId"]) and x["subset"] == args.subset)
    mix, score = _path(manifest.parent, item, "mixturePath"), _path(manifest.parent, item, "scorePath")
    target, accomp = _path(manifest.parent, item, "targetPath"), _path(manifest.parent, item, "accompanimentPath")
    rows = []
    for bw in [float(x) for x in args.bandwidths.split(",") if x.strip()]:
        for residual in [float(x) for x in args.residuals.split(",") if x.strip()]:
            label = f"bw_{bw:g}_res_{residual:g}"
            cfg = Config(bandwidth_cents=bw, residual=residual, trace_stride=128, score_weight=0.4, reliability_gating=True, reliability_alpha=4.0, score_branch_mode=args.score_branch_mode, detector_policy=args.detector_policy)
            est = extract_file(mix, score, Path(args.out_dir) / label, item["instrument"], "full", item.get("targetPart"), cfg)["outputPath"]
            rows.append({"bandwidth": bw, "residual": residual, "scoreBranchMode": args.score_branch_mode, "detectorPolicy": args.detector_policy, **evaluate(est, target, accomp, item["instrument"])})
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "mask-param-sweep.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    lines = ["| Bandwidth | Residual | SI-SDR | SIR | SAR | Pitch@50c |", "|---:|---:|---:|---:|---:|---:|"]
    for r in sorted(rows, key=lambda x: x["SI_SDR"], reverse=True):
        lines.append(f"| {r['bandwidth']:g} | {r['residual']:g} | {r['SI_SDR']:.3f} | {r['SIR']:.3f} | {r['SAR']:.3f} | {r['pitchAccuracy50c']:.3f} |")
    (out / "mask-param-sweep.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "rows": len(rows), "summary": str(out / "mask-param-sweep.csv")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
