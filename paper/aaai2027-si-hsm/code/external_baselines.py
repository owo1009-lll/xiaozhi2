from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

BASELINES = {
    "htdemucs": "demucs",
    "spleeter": "spleeter",
    "open_unmix": "umx",
    "bs_roformer_proxy": "bs_roformer",
}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", required=True)
    args = p.parse_args()
    data = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    rows = []
    for item in data.get("items", []):
        for name, exe in BASELINES.items():
            rows.append({
                "itemId": item.get("itemId"),
                "baseline": name,
                "status": "ready" if shutil.which(exe) else "skipped",
                "reason": "" if shutil.which(exe) else f"{exe} not installed",
                "policy": "pretrained only; BS/Mel-RoFormer uses vocal or monophonic proxy stem, no erhu fine-tuning",
            })
    out = Path(args.out_dir) / "external_baseline_status.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "statusPath": str(out), "rows": len(rows)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
