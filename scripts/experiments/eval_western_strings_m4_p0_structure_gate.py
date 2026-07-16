#!/usr/bin/env python3
"""Audit P0 clef/key/meter fail-closed evidence on the frozen photo set."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from western_m4_omr_structure import evaluate_p0_structure


REPO = Path(__file__).resolve().parents[2]
DEFAULT_BENCHMARK = REPO / "data/experiments/western-strings-m4/independent-source-benchmark/omr-benchmark.json"
DEFAULT_VARIANTS = REPO / "data/experiments/western-strings-m4/independent-real-jpg-variants"
DEFAULT_OUT = REPO / "data/experiments/western-strings-m4/p0-structure-gate"


def evaluate_piece(piece_id: str, variant_root: Path) -> dict:
    omr_dir = variant_root / piece_id / "up2" / "omr"
    omr_files = sorted(omr_dir.glob("*.omr"))
    mxl_files = sorted(omr_dir.glob("*.mxl"))
    if not omr_files:
        gate = {
            "ready": False,
            "clefReady": False,
            "keyReady": False,
            "meterReady": False,
            "reasons": ["omr-archive-missing"],
        }
    else:
        gate = evaluate_p0_structure(omr_files[0], mxl_files)
    return {"pieceId": piece_id, "variant": "up2", "gate": gate}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", default=str(DEFAULT_BENCHMARK))
    parser.add_argument("--variants", default=str(DEFAULT_VARIANTS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    benchmark = json.loads(Path(args.benchmark).read_text(encoding="utf-8"))
    rows = [
        evaluate_piece(row["pieceId"], Path(args.variants))
        for row in benchmark.get("rows", [])
        if row.get("benchmarkUsable")
    ]
    reasons: Counter[str] = Counter()
    for row in rows:
        reasons.update(row["gate"].get("reasons") or [])
    summary = {
        "pieceCount": len(rows),
        "p0ReadyCount": sum(row["gate"].get("ready") is True for row in rows),
        "clefReadyCount": sum(row["gate"].get("clefReady") is True for row in rows),
        "keyReadyCount": sum(row["gate"].get("keyReady") is True for row in rows),
        "meterReadyCount": sum(row["gate"].get("meterReady") is True for row in rows),
        "reasonCounts": dict(reasons),
        "studentGateReady": False,
    }
    report = {
        "schemaVersion": 2,
        "evalOnly": True,
        "summary": summary,
        "rows": rows,
        "interpretation": [
            "A candidate is P0-ready when clef, key and meter each have either explicit symbol evidence or auditable structural corroboration.",
            "No raw key symbol plus exported fifths=0 (or MusicXML's implicit zero default) is valid C-major/A-minor evidence; any detected raw/export conflict still fails closed.",
            "Low clef grade can be corroborated by complete line-start agreement, treble-clef export and violin-range pitches. Meter can be corroborated by exported meter plus >=90% measure-duration consistency.",
            "P0 failure routes the score to score-structure-review-required; it never falls back to student-facing accusations.",
        ],
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# M4 P0 structure gate",
        "",
        "Eval-only audit of clef, key-signature and meter evidence.",
        "",
        f"- P0 ready: {summary['p0ReadyCount']}/{summary['pieceCount']}",
        f"- clef ready: {summary['clefReadyCount']}/{summary['pieceCount']}",
        f"- key ready: {summary['keyReadyCount']}/{summary['pieceCount']}",
        f"- meter ready: {summary['meterReadyCount']}/{summary['pieceCount']}",
        f"- student gate ready: {summary['studentGateReady']}",
        "",
        "| piece | P0 | clef | key | meter | reasons |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        gate = row["gate"]
        lines.append(
            f"| {row['pieceId']} | {gate.get('ready')} | {gate.get('clefReady')} | "
            f"{gate.get('keyReady')} | {gate.get('meterReady')} | "
            f"{', '.join(gate.get('reasons') or [])} |"
        )
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "summary": summary, "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
