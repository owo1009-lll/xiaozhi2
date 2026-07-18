#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regression pins for the frozen duration/extra quantization contract (v1).

Verifies the contract stays frozen (units/tolerances/unsafe/seed rules), the
report keeps its fail-closed posture, the seed aggregation cannot drift from
its per-seed rows, and the confirmed v2/r3 measurement results stay exact.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REPORT = REPO / "data" / "experiments" / "western-strings-duration-extra-quantization" / "report.json"

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    if not condition:
        failures.append(name)


report = json.loads(REPORT.read_text(encoding="utf-8"))

# fail-closed posture
check("eval-only", report.get("evalOnly") is True)
check("pre-gate-only", report.get("preGateOnly") is True)
check("student-gate-closed", report.get("studentGateReady") is False)
check("review-only-categories", report.get("reviewOnlyCategories") == ["duration", "extra"])

# frozen contract
contract = report.get("contract", {})
check("contract-version", contract.get("contractVersion") == "western-duration-extra-quantization-v1")
tolerances = contract.get("tolerances", {})
check("timing-limit-frozen", tolerances.get("timingDeviationRatioLimit") == 0.15)
check("duration-ratio-frozen", tolerances.get("minEventDurationRatio") == 0.15)
check("extra-window-frozen", tolerances.get("extraSamePitchWindowSeconds") == 3.0)
check("unsafe-definitions-present",
      bool(contract.get("unsafeDefinition", {}).get("drag"))
      and bool(contract.get("unsafeDefinition", {}).get("extra")))
check("shadow-policy-six-guards", len(contract.get("shadowPolicy", {})) == 6)


def pooled_matches_seeds(section: dict, label: str) -> None:
    pooled = section["pooled"]
    per_seed = pooled["perSeed"]
    check(f"{label}-drag-pool", pooled["drag"]["targets"] == sum(r["dragTargets"] for r in per_seed))
    check(f"{label}-drag-unsafe-pool",
          pooled["drag"]["unsafeInvisible"] == sum(r["dragUnsafeInvisible"] for r in per_seed))
    check(f"{label}-extra-pool", pooled["extra"]["targets"] == sum(r["extraTargets"] for r in per_seed))
    check(f"{label}-extra-unsafe-pool",
          pooled["extra"]["unsafeInvisible"] == sum(r["extraUnsafeInvisible"] for r in per_seed))
    check(f"{label}-worst-seed-drag",
          pooled["worstSeedDragUnsafe"] == max((r["dragUnsafeInvisible"] for r in per_seed), default=0))


pooled_matches_seeds(report["injectedV1"], "v1")
pooled_matches_seeds(report["injectedV2"], "v2")
pooled_matches_seeds(report["r3RealErrors"], "r3")

# confirmed current-generation (v2) results: hard 0/60 must hold with the
# six-guard shadow; drag/extra invisibility stays exactly as measured
v2 = report["injectedV2"]["pooled"]
check("v2-six-sets", len(report["injectedV2"]["sets"]) == 6)
check("v2-drag-targets", v2["drag"]["targets"] == 24)
check("v2-extra-targets", v2["extra"]["targets"] == 30)
check("v2-hard-zero-leak", v2["hardSelected"] == 0)
check("v2-extra-zero-unsafe", v2["extra"]["unsafeInvisible"] == 0)
check("v2-drag-unsafe-documented", v2["drag"]["unsafeInvisible"] == 4)
check("v2-drag-visible", v2["drag"]["timingVisible"] == 20)

# owner-confirmed r3 real-error consumption
r3 = report["r3RealErrors"]["pooled"]
check("r3-drag-targets", r3["drag"]["targets"] == 2)
check("r3-drag-zero-unsafe", r3["drag"]["unsafeInvisible"] == 0)
check("r3-extra-targets", r3["extra"]["targets"] == 3)
check("r3-extra-unsafe-documented", r3["extra"]["unsafeInvisible"] == 1)
check("r3-hard-zero-leak", r3["hardSelected"] == 0)

# natural student domain: burden measured on all five clean takes
natural = report.get("naturalStudentDomain") or {}
takes = natural.get("takes") or []
check("natural-five-takes", [t["take"] for t in takes] == ["r2-01", "r2-08", "r3-01", "r3-02", "r3-03"])
check("natural-rows-positive", all(t["rows"] > 0 for t in takes))
check("natural-coverage-floor", all(t["coverage"] >= 0.2 for t in takes))
check("natural-flag-rate-bounded", 0 <= natural.get("meanTimingFlagRate", 1) <= 0.2)
check("natural-extra-burden-bounded", 0 <= natural.get("meanExtraFlagBurdenPerRow", 1) <= 0.1)

if failures:
    print(json.dumps({"ok": False, "failures": failures}, ensure_ascii=False))
    sys.exit(1)
print(json.dumps({"ok": True, "checks": "duration/extra quantization contract frozen and consumed"},
                 ensure_ascii=False))
sys.exit(0)
