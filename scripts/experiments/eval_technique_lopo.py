# -*- coding: utf-8 -*-
"""Leave-One-Piece-Out (LOPO) multi-label baseline for segment-level technique ID.

Honest protocol: 3 pieces (packId) -> 3 folds, train on 2 pieces, test on the 3rd.
This prevents same-piece leakage (random splits would inflate). One-vs-rest binary
classifier per technique. Pools out-of-fold predictions across the 3 folds.

CRITICAL honesty: several classes are near-constant (position-shift 36/37,
vibrato 36/37, bowing 34/37) -> plain F1 is trivially high (predict-all-present).
So we report, per class: base rate, the majority-baseline F1 (always-present), the
classifier F1, and ROC-AUC (threshold-free; 0.5 = NO signal). Real signal = AUC
meaningfully > 0.5 and/or F1 lift over the majority baseline. Low-sample classes
(ornament 14, trill 25) are flagged -- their numbers are noisy.

Input:  data/experiments/technique-features/basic-pitch-segment-features-latest.csv
Run:    python-service/.venv/Scripts/python.exe scripts/experiments/eval_technique_lopo.py
"""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import precision_recall_fscore_support, roc_auc_score

REPO = Path(__file__).resolve().parents[2]
CSV = REPO / "data" / "experiments" / "technique-features" / "basic-pitch-segment-features-latest.csv"
LABELS = ["glide", "vibrato", "trill", "ornament", "position-shift", "bowing"]


def load():
    with CSV.open(encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    feat_cols = [c for c in rows[0].keys() if c.startswith(("audio", "basicPitch"))]
    X = np.array([[float(r[c]) if r[c] not in ("", None) else 0.0 for c in feat_cols] for r in rows])
    Y = {lab: np.array([int(r[f"label_{lab}"]) for r in rows]) for lab in LABELS}
    groups = np.array([r["packId"] for r in rows])
    return X, Y, groups, feat_cols


def lopo_predict(X, y, groups, make_model):
    """Pooled out-of-fold probabilities + hard predictions over LOPO folds."""
    proba = np.full(len(y), np.nan)
    for g in sorted(set(groups)):
        tr, te = groups != g, groups == g
        ytr = y[tr]
        if len(set(ytr)) < 2:  # training fold has only one class -> predict that constant
            proba[te] = float(ytr[0])
            continue
        scaler = StandardScaler().fit(X[tr])
        model = make_model().fit(scaler.transform(X[tr]), ytr)
        proba[te] = model.predict_proba(scaler.transform(X[te]))[:, 1]
    pred = (proba >= 0.5).astype(int)
    return proba, pred


def majority_baseline_f1(base_rate):
    """Always-predict-present: precision=base_rate, recall=1."""
    if base_rate == 0:
        return 0.0
    return 2 * base_rate / (base_rate + 1)


def main():
    X, Y, groups, feat_cols = load()
    n = len(groups)
    print(f"segments={n} features={len(feat_cols)} pieces={sorted(set(groups))}")
    models = {
        "logreg": lambda: LogisticRegression(max_iter=4000, class_weight="balanced"),
        "rf": lambda: RandomForestClassifier(n_estimators=400, class_weight="balanced", random_state=0),
    }
    for mname, make in models.items():
        print(f"\n=== {mname} (leave-one-piece-out) ===")
        print(f"{'tech':14} {'pos':>5} {'P':>5} {'R':>5} {'F1':>5} {'AUC':>5} {'baseF1':>6} {'lift':>5}  note")
        for lab in LABELS:
            y = Y[lab]
            pos = int(y.sum())
            base = pos / n
            proba, pred = lopo_predict(X, y, groups, make)
            p, r, f1, _ = precision_recall_fscore_support(y, pred, average="binary", zero_division=0)
            try:
                auc = roc_auc_score(y, proba) if len(set(y)) == 2 else float("nan")
            except Exception:
                auc = float("nan")
            bf1 = majority_baseline_f1(base)
            lift = f1 - bf1
            note = []
            if pos < 20:
                note.append("LOW-N")
            if base >= 0.9:
                note.append("near-constant")
            print(f"{lab:14} {pos:>3}/{n} {p:5.2f} {r:5.2f} {f1:5.2f} {auc:5.2f} {bf1:6.2f} {lift:+5.2f}  {','.join(note)}")
    print("\nRead: AUC>~0.65 or F1 lift>0 on balanced classes = real signal. "
          "near-constant classes' F1 is trivial; trust their AUC. LOW-N classes are noisy.")


if __name__ == "__main__":
    main()
