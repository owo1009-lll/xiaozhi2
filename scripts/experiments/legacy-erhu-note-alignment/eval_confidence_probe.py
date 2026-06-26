# -*- coding: utf-8 -*-
"""Phase 0.5 feasibility probe: does a high-precision auto_pass subset EXIST?

Before investing in a 500-point note-gold dataset + a trained confidence model, this
asks the cheap question on the EXISTING 24 gold points:

  Is there ANY truth-free gate (predictor + selection rule) that yields a subset that is
  >=90% correct (predictor within ±1 measure of truth) AND covers >=20-30% of points?

This is an OPTIMISTIC ORACLE upper bound: the threshold is picked on the same 24 points,
so a real cross-validated gate would be WORSE. Therefore:
  - if even this upper bound can't reach 90% precision at useful coverage -> the confidence
    gate is capped; don't build the big dataset/model.
  - if it reaches 90% at >=20-30% coverage -> there is signal; worth the investment.

Truth-free gate features (usable in production): inter-model spread, agreement count,
distance of a model's prediction to the consensus. (measureError vs truth is NOT a
feature -- it is only used to label correctness.)
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
EXP = REPO / "data" / "experiments"
MODELS = {
    "crepe": EXP / "note-alignment" / "note-position-eval-score-mofx8cdb-sbrqgx-crepe.json",
    "basicpitch": EXP / "model-bakeoff" / "basic-pitch-note-align-score-mofx8cdb-sbrqgx-pitch-class.json",
    "parangonar": EXP / "model-bakeoff" / "parangonar-automatic-basic-pitch-score-mofx8cdb-sbrqgx.json",
    "synctoolbox": EXP / "model-bakeoff" / "synctoolbox-mrmsdtw-score-mofx8cdb-sbrqgx.json",
}
GOLD = EXP / "note-alignment" / "xuandong-m1-note-position-gold.csv"
ACC_TOL = 1.0  # correct if predictor within ±1 measure of truth


def load_gold():
    truth = {}
    with GOLD.open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            truth[round(float(r["timeSeconds"]))] = int(r["measure"])
    return truth


def load_model(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    block = None
    for r in (d.get("results") or []):
        if r.get("rows"):
            block = r
    out = {}
    if block:
        for row in block["rows"]:
            t, pm = row.get("timeSeconds"), row.get("predMeasure")
            if t is not None and pm is not None:
                out[round(float(t))] = int(pm)
    return out


def main():
    truth = load_gold()
    models = {n: load_model(p) for n, p in MODELS.items() if Path(p).exists()}
    names = list(models)
    pts = sorted(truth)

    rows = []
    for t in pts:
        preds = {n: models[n][t] for n in names if t in models[n]}
        if len(preds) < 2:
            continue
        vals = list(preds.values())
        med = float(np.median(vals))
        spread = float(max(vals) - min(vals))          # truth-free
        agree = sum(1 for v in vals if abs(v - med) <= 1)   # truth-free
        par = preds.get("parangonar")
        rows.append({
            "t": t, "true": truth[t], "preds": preds, "median": med, "spread": spread,
            "agree": agree, "parangonar": par,
            "medCorrect": abs(med - truth[t]) <= ACC_TOL,
            "parCorrect": (par is not None and abs(par - truth[t]) <= ACC_TOL),
        })
    n = len(rows)
    print(f"[Phase 0.5 probe | {n} points | predictor within ±{ACC_TOL} measure = correct]")

    def gate(predictor_correct_key, select):
        sel = [r for r in rows if select(r)]
        if not sel:
            return (0.0, None, 0)
        correct = sum(1 for r in sel if r[predictor_correct_key])
        return (round(len(sel) / n, 3), round(correct / len(sel), 3), len(sel))

    print("\n  -- predictor = median consensus --")
    print(f"  {'gate':30} {'coverage':>9} {'precision':>10} {'n':>4}")
    for K in range(2, len(names) + 1):
        cov, prec, k = gate("medCorrect", lambda r, K=K: r["agree"] >= K)
        print(f"  agree>= {K}/{len(names):<22} {cov:>9} {str(prec):>10} {k:>4}")
    for s in [0, 1, 2, 3, 5]:
        cov, prec, k = gate("medCorrect", lambda r, s=s: r["spread"] <= s)
        print(f"  spread<= {s} meas{'':<17} {cov:>9} {str(prec):>10} {k:>4}")

    print("\n  -- predictor = Parangonar (best single model), gated by agreement with others --")
    for K in range(1, len(names)):
        # auto-pass Parangonar when >=K OTHER models are within ±1 of it
        def sel(r, K=K):
            if r["parangonar"] is None:
                return False
            others = [v for nm, v in r["preds"].items() if nm != "parangonar"]
            return sum(1 for v in others if abs(v - r["parangonar"]) <= 1) >= K
        cov, prec, k = gate("parCorrect", sel)
        print(f"  parangonar + >={K} others agree{'':<6} {cov:>9} {str(prec):>10} {k:>4}")
    # parangonar unconditional (baseline)
    cov, prec, k = gate("parCorrect", lambda r: r["parangonar"] is not None)
    print(f"  parangonar unconditional{'':<11} {cov:>9} {str(prec):>10} {k:>4}")

    # best gate reaching >=90% precision
    best = None
    cands = []
    for K in range(2, len(names) + 1):
        cands.append((f"agree>={K}", [r for r in rows if r["agree"] >= K], "medCorrect"))
    for s in [0, 1, 2, 3, 5]:
        cands.append((f"spread<={s}", [r for r in rows if r["spread"] <= s], "medCorrect"))
    for K in range(1, len(names)):
        sel = [r for r in rows if r["parangonar"] is not None and
               sum(1 for nm, v in r["preds"].items() if nm != "parangonar" and abs(v - r["parangonar"]) <= 1) >= K]
        cands.append((f"par+>={K}others", sel, "parCorrect"))
    for label, sel, key in cands:
        if not sel:
            continue
        prec = sum(1 for r in sel if r[key]) / len(sel)
        cov = len(sel) / n
        if prec >= 0.9 and (best is None or cov > best[2]):
            best = (label, round(prec, 3), round(cov, 3))
    print("\n  BEST gate reaching >=90% precision (oracle upper bound):")
    print(f"    {best}" if best else "    NONE reaches 90% at any coverage")
    print("\n  Read: this is an OPTIMISTIC upper bound (threshold picked on same 24 pts).")
    print("  If even this can't hit 90% at >=20% coverage, the confidence gate is capped.")


if __name__ == "__main__":
    main()
