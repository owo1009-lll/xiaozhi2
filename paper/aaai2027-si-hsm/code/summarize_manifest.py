from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", required=True)
    args = p.parse_args()
    items = json.loads(Path(args.manifest).read_text(encoding="utf-8")).get("items", [])
    groups = Counter((x.get("subset"), x.get("instrument")) for x in items)
    lines = ["| Subset | Instrument | Items | Objective refs | Redistributable |", "|---|---:|---:|---:|---:|"]
    for key, count in sorted(groups.items()):
        vals = [x for x in items if (x.get("subset"), x.get("instrument")) == key]
        refs = sum(x.get("gtStatus") in {"clean_stems", "synthetic_mix"} for x in vals)
        rel = sum(x.get("licenseStatus") == "redistributable" for x in vals)
        lines.append(f"| {key[0]} | {key[1]} | {count} | {refs} | {rel} |")
    out = Path(args.out_dir) / "table-dataset-summary.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
