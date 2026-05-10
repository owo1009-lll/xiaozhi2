from __future__ import annotations

import argparse
import json
from pathlib import Path

REQUIRED = {"itemId", "title", "instrument", "subset", "mixturePath", "scorePath", "licenseStatus", "gtStatus"}
OBJECTIVE = {"clean_stems", "synthetic_mix"}


def validate(path: Path, strict_paths: bool = False) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    errors: list[str] = []
    if data.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    for i, item in enumerate(data.get("items", [])):
        label = item.get("itemId", f"items[{i}]")
        missing = sorted(REQUIRED - set(item))
        if missing:
            errors.append(f"{label}: missing {', '.join(missing)}")
        if item.get("gtStatus") in OBJECTIVE:
            for key in ("targetPath", "accompanimentPath"):
                if not item.get(key):
                    errors.append(f"{label}: {item.get('gtStatus')} requires {key}")
        if item.get("gtStatus") == "target_only" and not item.get("targetPath"):
            errors.append(f"{label}: target_only requires targetPath")
        if item.get("gtStatus") == "no_reference" and item.get("evaluationUse") == "objective_separation":
            errors.append(f"{label}: no_reference cannot be objective_separation")
        if strict_paths:
            for key in ("mixturePath", "scorePath", "targetPath", "accompanimentPath", "teacherLabelsPath"):
                if item.get(key) and not (path.parent / item[key]).exists() and not Path(item[key]).exists():
                    errors.append(f"{label}: missing path {key}={item[key]}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("--strict-paths", action="store_true")
    args = parser.parse_args()
    errors = validate(Path(args.manifest), args.strict_paths)
    print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
