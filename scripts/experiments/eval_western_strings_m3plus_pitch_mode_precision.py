from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_PACK_DIR = REPO / "data" / "experiments" / "western-strings-m3plus" / "pitch-mode-review-pack"
DEFAULT_LABELS = DEFAULT_PACK_DIR / "m3plus-pitch-mode-review-labels.csv"
DEFAULT_JSON = DEFAULT_PACK_DIR / "m3plus-pitch-mode-eval.json"
DEFAULT_CSV = DEFAULT_PACK_DIR / "m3plus-pitch-mode-eval.csv"

SCORABLE_LABELS = {"in-tune", "sharp", "flat", "wrong-note"}
MODE_EXPECTED_BEHAVIOR = {
    "stable": "stable",
    "slide-like": "slide",
    "trill-like": "trill",
    "ornament-candidate": "ornament",
    "double-stop-candidate": "double-stop",
    "variable-f0": "variable-f0",
}
CONTROL_MODES = {"stable"}


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fieldnames = [
        "candidateMode",
        "total",
        "match",
        "mismatch",
        "judgeable",
        "scored",
        "unsafeIfAutoPassAll",
        "precisionIfAutoPassAll",
        "expectedBehavior",
        "expectedBehaviorHits",
        "expectedBehaviorHitRate",
        "modeSpecificScored",
        "modeSpecificPrecision",
        "modeSpecificUnsafe",
        "releaseReady",
        "controlReady",
        "status",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def is_match(row: dict[str, str]) -> bool:
    return clean(row.get("audioScoreMatch")) == "match"


def is_judgeable(row: dict[str, str]) -> bool:
    return is_match(row) and clean(row.get("pitchJudgeable")) == "yes"


def is_scorable(row: dict[str, str]) -> bool:
    return is_judgeable(row) and clean(row.get("pitchAccuracyLabel")) in SCORABLE_LABELS


def is_safe_if_auto_pass_all(row: dict[str, str]) -> bool:
    # Conservative: if the candidate row itself is mismatched or not judgeable, then a
    # mode-level auto-pass would have been unsafe. This is stricter than downstream
    # runtime, but correct for release gating.
    return is_scorable(row)


def round_metric(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 6)


def evaluate(labels: list[dict[str, str]], min_precision: float, min_mode_specific_scored: int) -> dict[str, Any]:
    by_mode: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in labels:
        mode = clean(row.get("candidateMode")) or "blank"
        by_mode[mode].append(row)

    per_mode_rows: list[dict[str, Any]] = []
    release_ready_modes: list[str] = []
    control_ready_modes: list[str] = []
    for mode in sorted(by_mode):
        rows = by_mode[mode]
        expected_behavior = MODE_EXPECTED_BEHAVIOR.get(mode, "")
        total = len(rows)
        match_count = sum(1 for row in rows if is_match(row))
        mismatch_count = sum(1 for row in rows if clean(row.get("audioScoreMatch")) == "mismatch")
        judgeable_count = sum(1 for row in rows if is_judgeable(row))
        scored_count = sum(1 for row in rows if is_scorable(row))
        unsafe_all = sum(1 for row in rows if not is_safe_if_auto_pass_all(row))
        precision_all = scored_count / total if total else None
        behavior_hits = (
            sum(1 for row in rows if clean(row.get("observedPitchBehavior")) == expected_behavior)
            if expected_behavior
            else 0
        )
        behavior_hit_rate = behavior_hits / total if total else None
        mode_specific_scored = sum(
            1
            for row in rows
            if is_scorable(row)
            and expected_behavior
            and clean(row.get("observedPitchBehavior")) == expected_behavior
        )
        mode_specific_unsafe = sum(
            1
            for row in rows
            if expected_behavior
            and clean(row.get("observedPitchBehavior")) == expected_behavior
            and not is_scorable(row)
        )
        mode_specific_total = mode_specific_scored + mode_specific_unsafe
        mode_specific_precision = (
            mode_specific_scored / mode_specific_total
            if mode_specific_total
            else None
        )

        evidence_ready = (
            mode_specific_precision is not None
            and mode_specific_precision >= min_precision
            and mode_specific_unsafe == 0
            and mode_specific_scored >= min_mode_specific_scored
        )
        release_ready = evidence_ready and mode not in CONTROL_MODES
        control_ready = evidence_ready and mode in CONTROL_MODES
        if release_ready:
            status = "mode-specific-release-ready"
            release_ready_modes.append(mode)
        elif control_ready:
            status = "control-mode-ready"
            control_ready_modes.append(mode)
        elif mode_specific_scored < min_mode_specific_scored:
            status = "mode-specific-evidence-too-low"
        elif mode_specific_precision is None or mode_specific_precision < min_precision:
            status = "mode-specific-precision-below-threshold"
        elif mode_specific_unsafe:
            status = "mode-specific-unsafe"
        else:
            status = "mode-specific-review-only"

        per_mode_rows.append({
            "candidateMode": mode,
            "total": total,
            "match": match_count,
            "mismatch": mismatch_count,
            "judgeable": judgeable_count,
            "scored": scored_count,
            "unsafeIfAutoPassAll": unsafe_all,
            "precisionIfAutoPassAll": round_metric(precision_all),
            "expectedBehavior": expected_behavior,
            "expectedBehaviorHits": behavior_hits,
            "expectedBehaviorHitRate": round_metric(behavior_hit_rate),
            "modeSpecificScored": mode_specific_scored,
            "modeSpecificPrecision": round_metric(mode_specific_precision),
            "modeSpecificUnsafe": mode_specific_unsafe,
            "releaseReady": release_ready,
            "controlReady": control_ready,
            "status": status,
        })

    all_counts = Counter(clean(row.get("observedPitchBehavior")) or "blank" for row in labels)
    judgement_counts = Counter(clean(row.get("pitchJudgementMode")) or "blank" for row in labels)
    match_counts = Counter(clean(row.get("audioScoreMatch")) or "blank" for row in labels)
    release_ready = bool(release_ready_modes)
    return {
        "ok": True,
        "studentGateReady": False,
        "runtimeEffect": "none",
        "minPrecision": min_precision,
        "minModeSpecificScored": min_mode_specific_scored,
        "counts": {
            "rows": len(labels),
            "match": int(match_counts.get("match", 0)),
            "mismatch": int(match_counts.get("mismatch", 0)),
            "scored": sum(1 for row in labels if is_scorable(row)),
            "specialJudgementRows": sum(
                1
                for row in labels
                if clean(row.get("pitchJudgementMode")) not in {"", "normal-center", "not-judgeable", "uncertain"}
            ),
        },
        "observedPitchBehaviorCounts": dict(sorted(all_counts.items())),
        "pitchJudgementModeCounts": dict(sorted(judgement_counts.items())),
        "releaseReadyModes": release_ready_modes,
        "controlReadyModes": control_ready_modes,
        "m3plusModeReleaseReady": release_ready,
        "blockingReasons": (
            []
            if release_ready
            else ["m3plus-no-mode-specific-release-ready"]
        ),
        "interpretation": (
            "At least one mode has enough mode-specific, safe evidence for offline release review."
            if release_ready
            else "Labels are sufficient for offline evaluation; stable control is reported separately, and no non-control pitch-behavior mode has enough mode-specific evidence to reduce student review yet."
        ),
        "perMode": per_mode_rows,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate M3+ pitch behavior labels by candidate mode.")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--out-json", default=str(DEFAULT_JSON))
    parser.add_argument("--out-csv", default=str(DEFAULT_CSV))
    parser.add_argument("--min-precision", type=float, default=0.9)
    parser.add_argument("--min-mode-specific-scored", type=int, default=3)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    labels_path = repo_path(args.labels)
    labels = read_csv(labels_path)
    report = evaluate(labels, float(args.min_precision), int(args.min_mode_specific_scored))
    out_json = repo_path(args.out_json)
    out_csv = repo_path(args.out_csv)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(out_csv, report["perMode"])
    print(json.dumps({
        "ok": True,
        "m3plusModeReleaseReady": report["m3plusModeReleaseReady"],
        "releaseReadyModes": report["releaseReadyModes"],
        "controlReadyModes": report["controlReadyModes"],
        "blockingReasons": report["blockingReasons"],
        "counts": report["counts"],
        "artifacts": {
            "json": str(out_json.relative_to(REPO) if out_json.is_relative_to(REPO) else out_json),
            "csv": str(out_csv.relative_to(REPO) if out_csv.is_relative_to(REPO) else out_csv),
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
