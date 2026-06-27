from __future__ import annotations

import argparse
import json
from pathlib import Path

from eval_western_strings_m2f_real_recordings import DEFAULT_MANIFEST
from eval_western_strings_m2f_real_recordings import DEFAULT_REQUIRED_SCENARIOS
from eval_western_strings_m2f_real_recordings import REPO
from eval_western_strings_m2f_real_recordings import validate_manifest


DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "m2f-manifest-readiness-summary.json"


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


def build_summary(
    *,
    manifest_path: Path,
    min_recordings: int,
    min_students: int,
    required_scenarios: list[str],
) -> dict:
    manifest = validate_manifest(
        manifest_path,
        min_recordings=min_recordings,
        min_students=min_students,
        required_scenarios=required_scenarios,
    )
    return {
        "ok": True,
        "manifestReady": bool(manifest.get("manifestReady")),
        "gate": {
            "name": "western-strings-m2f-manifest-readiness",
            "minRecordings": min_recordings,
            "minStudents": min_students,
            "requiredScenarios": required_scenarios,
        },
        "manifestPath": display_path(manifest_path),
        "blockingReasons": manifest.get("blockingReasons", []),
        "manifest": manifest,
        "warning": "Manifest readiness only checks recording metadata, consent, paths, students, and scenario coverage. It does not validate result counts or release readiness.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate western strings M2f real-student recording manifest readiness before result counting.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-recordings", type=int, default=6)
    parser.add_argument("--min-students", type=int, default=3)
    parser.add_argument("--required-scenarios", default=",".join(DEFAULT_REQUIRED_SCENARIOS))
    parser.add_argument("--expect-positive", action="store_true")
    parser.add_argument("--expect-negative", action="store_true")
    parser.add_argument("--fail-on-not-ready", action="store_true", help="exit non-zero when manifestReady is false")
    args = parser.parse_args()

    required_scenarios = [item.strip() for item in str(args.required_scenarios).split(",") if item.strip()]
    summary = build_summary(
        manifest_path=Path(args.manifest),
        min_recordings=int(args.min_recordings),
        min_students=int(args.min_students),
        required_scenarios=required_scenarios,
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    if args.expect_positive and not summary["manifestReady"]:
        raise SystemExit("Expected M2f manifest readiness to pass, but it failed.")
    if args.expect_negative and summary["manifestReady"]:
        raise SystemExit("Expected M2f manifest readiness to fail closed, but it passed.")
    if args.fail_on_not_ready and not summary["manifestReady"]:
        raise SystemExit("M2f manifest is not ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
