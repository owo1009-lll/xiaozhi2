# -*- coding: utf-8 -*-
"""Note-level multi-model ENSEMBLE: does model AGREEMENT predict accuracy?

The decisive test for note-level auto-alignment. Each per-model eval (run separately in
its own env) already saved per-point predictions (predMeasure at each gold time) under
data/experiments. This script only INGESTS those and asks:

  if we auto-judge ONLY points where >=K independent models agree (predMeasure within
  `tol` measures of the median), what is the PRECISION (agreed answer is correct) and the
  COVERAGE (fraction of points auto-judged)?  -> answers whether a high-confidence
  agreement gate can hit V3's precision>=90% at usable coverage.

Caveat baked in: the four model FAMILIES (CREPE / Basic-Pitch / Parangonar / Synctoolbox)
are all pitch/onset based and can fail TOGETHER. So we explicitly list every
HIGH-AGREEMENT-BUT-WRONG point -- correlated agreement that is confidently wrong is the
failure mode that would make the gate unsafe. (Variants of one family are excluded by
default so a family cannot vote twice.)

Eval-only. Default = 炫动 11 gold points; extend the gold CSV to ~50 for a real verdict.
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
EXP = REPO / "data" / "experiments"

# one representative per INDEPENDENT family (variants like bp-pitch-class / parangonar-glue
# are excluded by default so a family can't double-vote)
DEFAULT_MODELS = {
    "crepe": EXP / "note-alignment" / "note-position-eval-score-mofx8cdb-sbrqgx-crepe.json",
    "basicpitch": EXP / "model-bakeoff" / "basic-pitch-note-align-score-mofx8cdb-sbrqgx-pitch-class.json",
    "parangonar": EXP / "model-bakeoff" / "parangonar-automatic-basic-pitch-score-mofx8cdb-sbrqgx.json",
    "synctoolbox": EXP / "model-bakeoff" / "synctoolbox-mrmsdtw-score-mofx8cdb-sbrqgx.json",
}
GOLD = EXP / "note-alignment" / "xuandong-m1-note-position-gold.csv"


def load_gold(path):
    truth = {}
    with Path(path).open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            truth[round(float(row["timeSeconds"]))] = int(row["measure"])
    return truth


def load_model_predmeasure(path):
    """time(s, rounded) -> predMeasure, from the result block that has rows (prefer the
    largest window; predMeasure itself is window-independent)."""
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    results = d.get("results") or []
    block = None
    for r in results:
        if r.get("rows"):
            block = r  # keep last non-empty (largest window)
    if block is None:
        return {}
    out = {}
    for row in block["rows"]:
        t = row.get("timeSeconds")
        pm = row.get("predMeasure")
        if t is not None and pm is not None:
            out[round(float(t))] = int(pm)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", default=str(GOLD))
    ap.add_argument("--tol", type=float, default=1.0, help="agreement tolerance in measures")
    ap.add_argument("--acc-tol", type=float, default=1.0, help="correct if |median-true| <= this (measures)")
    ap.add_argument("--out", default=str(EXP / "note-alignment" / "ensemble-agreement.json"))
    args = ap.parse_args()

    truth = load_gold(args.gold)
    models = {name: load_model_predmeasure(p) for name, p in DEFAULT_MODELS.items() if Path(p).exists()}
    names = list(models)
    n_models = len(names)
    points = sorted(truth)

    per = []
    for t in points:
        true_m = truth[t]
        preds = {nm: models[nm][t] for nm in names if t in models[nm]}
        if len(preds) < 2:
            per.append({"t": t, "true": true_m, "preds": preds, "median": None, "agree": 0, "correct": None})
            continue
        vals = list(preds.values())
        med = float(np.median(vals))
        agree = sum(1 for v in vals if abs(v - med) <= args.tol)
        correct = abs(med - true_m) <= args.acc_tol
        per.append({"t": t, "true": true_m, "preds": preds, "median": med, "agree": agree, "correct": bool(correct)})

    # precision / coverage as the agreement threshold K rises
    print(f"[ensemble | models={names} | {len(points)} gold points | tol=±{args.tol}meas acc=±{args.acc_tol}meas]")
    print(f"  {'K (>=models agree)':22} {'coverage':>9} {'precision':>10} {'auto/correct/wrong':>20}")
    curve = []
    for K in range(2, n_models + 1):
        auto = [p for p in per if p["median"] is not None and p["agree"] >= K]
        correct = [p for p in auto if p["correct"]]
        wrong = [p for p in auto if not p["correct"]]
        cov = round(len(auto) / len(points), 3)
        prec = round(len(correct) / len(auto), 3) if auto else None
        curve.append({"K": K, "coverage": cov, "precision": prec, "auto": len(auto), "correct": len(correct), "wrong": len(wrong)})
        print(f"  >={K} of {n_models:<16} {cov:>9} {str(prec):>10}   {len(auto)}/{len(correct)}/{len(wrong)}")

    print("\n  per-point (true vs each model's predMeasure):")
    for p in per:
        ps = " ".join(f"{nm}={p['preds'].get(nm,'-')}" for nm in names)
        flag = "" if p["median"] is None else ("OK" if p["correct"] else "WRONG")
        print(f"    {p['t']:>4}s true=m{p['true']:<3} med={p['median']} agree={p['agree']}/{n_models} {flag}  [{ps}]")

    # caveat A: high-agreement-but-wrong points (correlated confident errors)
    hi_wrong = [p for p in per if p["median"] is not None and p["agree"] >= max(2, n_models - 1) and not p["correct"]]
    print(f"\n  [!] HIGH-AGREEMENT-BUT-WRONG (>= {max(2, n_models-1)} agree yet wrong): {len(hi_wrong)}")
    for p in hi_wrong:
        print(f"    {p['t']}s true=m{p['true']} median=m{p['median']} preds={p['preds']}")

    out = {"models": names, "tol": args.tol, "accTol": args.acc_tol, "nPoints": len(points),
           "precisionCoverageCurve": curve, "perPoint": per,
           "highAgreementWrong": [{"t": p["t"], "true": p["true"], "median": p["median"], "preds": p["preds"]} for p in hi_wrong]}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  wrote {args.out}")


if __name__ == "__main__":
    main()
